"""Find BPM and musical key for every track in the collection.

Sources, in order:
  1. AcousticBrainz (via a MusicBrainz recording match). Free, but its database stopped
     growing in 2022, so recent or obscure records are often missing.
  2. Deezer's free 30-second preview, analysed locally with Essentia
     (RhythmExtractor2013 for tempo, KeyExtractor with the EDM profile for key).

Results are cached in data/audio.json so each track is only looked up once. Tracks with
no match are retried after RETRY_DAYS. The run stops after ENRICH_MINUTES so the
scheduled job stays short; the next run carries on where this one stopped.
"""
import difflib
import os
import re
import tempfile
import time
import unicodedata
from datetime import datetime, timedelta, timezone

from common import DATA, http_get, key_label, load_json, save_json, to_camelot
from tracks import iter_tracks

BUDGET = float(os.environ.get("ENRICH_MINUTES", "40")) * 60
RETRY_DAYS = 30
NOW = datetime.now(timezone.utc)


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\((original|album|vinyl).*?\)", "", s)
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def similar(a, b):
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0
    if a in b or b in a:
        return 1
    return difflib.SequenceMatcher(None, a, b).ratio()


def lucene(s):
    return re.sub(r'([+\-&|!(){}\[\]^"~*?:\\/])', r"\\\1", s)


# --- AcousticBrainz ---------------------------------------------------------

def musicbrainz_ids(artist, title):
    q = f'recording:"{lucene(title)}" AND artist:"{lucene(artist)}"'
    r = http_get("https://musicbrainz.org/ws/2/recording", params={"query": q, "fmt": "json", "limit": 5},
                 min_interval=1.1)
    if r.status_code != 200:
        return []
    return [rec["id"] for rec in r.json().get("recordings", []) if rec.get("score", 0) >= 85][:5]


def acousticbrainz(artist, title):
    ids = musicbrainz_ids(artist, title)
    if not ids:
        return None
    r = http_get("https://acousticbrainz.org/api/v1/low-level",
                 params={"recording_ids": ";".join(ids)}, min_interval=1.0)
    if r.status_code != 200:
        return None
    data = r.json()
    for mbid in ids:
        doc = (data.get(mbid) or {}).get("0")
        if not doc:
            continue
        rhythm, tonal = doc.get("rhythm", {}), doc.get("tonal", {})
        bpm = rhythm.get("bpm")
        note = tonal.get("key_edma", {}).get("key") or tonal.get("key_key")
        scale = tonal.get("key_edma", {}).get("scale") or tonal.get("key_scale")
        strength = tonal.get("key_edma", {}).get("strength") or tonal.get("key_strength")
        if bpm:
            return {"bpm": round(bpm, 1), "note": note, "scale": scale, "key_strength": strength,
                    "source": "acousticbrainz", "mbid": mbid}
    return None


# --- Deezer preview + Essentia ----------------------------------------------

def deezer_match(artist, title, duration):
    r = http_get("https://api.deezer.com/search", params={"q": f'artist:"{artist}" track:"{title}"', "limit": 10},
                 min_interval=0.15)
    hits = (r.json().get("data") if r.status_code == 200 else None) or []
    if not hits:
        r = http_get("https://api.deezer.com/search", params={"q": f"{artist} {title}", "limit": 10},
                     min_interval=0.15)
        hits = (r.json().get("data") if r.status_code == 200 else None) or []
    best, best_score = None, 0
    for h in hits:
        if not h.get("preview"):
            continue
        score = similar(title, h.get("title")) * 0.6 + similar(artist, (h.get("artist") or {}).get("name")) * 0.4
        if duration and h.get("duration"):
            if abs(h["duration"] - duration) / duration > 0.25:
                score -= 0.15  # likely a different edit than the one on the record
        if score > best_score:
            best, best_score = h, score
    return (best, best_score) if best_score >= 0.7 else (None, best_score)


def analyse(path):
    import essentia.standard as es
    audio = es.MonoLoader(filename=path, sampleRate=44100)()
    bpm, _, beat_conf, _, _ = es.RhythmExtractor2013(method="multifeature")(audio)
    note, scale, strength = es.KeyExtractor(profileType="edma")(audio)
    return float(bpm), float(beat_conf), note, scale, float(strength)


def deezer_preview(artist, title, duration):
    hit, score = deezer_match(artist, title, duration)
    if not hit:
        return None
    detail = http_get(f"https://api.deezer.com/track/{hit['id']}", min_interval=0.15)
    deezer_bpm = (detail.json().get("bpm") if detail.status_code == 200 else 0) or 0
    audio = http_get(hit["preview"], min_interval=0.15, host_key="deezer-cdn")
    if audio.status_code != 200 or not audio.content:
        return None
    with tempfile.NamedTemporaryFile(suffix=".mp3") as f:
        f.write(audio.content)
        f.flush()
        bpm, beat_conf, note, scale, strength = analyse(f.name)
    # Deezer's own BPM (when set) comes from the full track; prefer it if it agrees roughly.
    if deezer_bpm and abs(deezer_bpm - bpm) / bpm < 0.04:
        bpm = deezer_bpm
    return {"bpm": round(bpm, 1), "note": note, "scale": scale, "key_strength": round(strength, 2),
            "beat_confidence": round(beat_conf, 2), "source": "deezer-preview",
            "deezer_id": hit["id"], "match": round(score, 2)}


# --- driver -----------------------------------------------------------------

def due(entry):
    if not entry:
        return True
    if entry.get("source") == "none":
        checked = datetime.fromisoformat(entry["checked"])
        return NOW - checked > timedelta(days=RETRY_DAYS)
    return False


def main():
    collection = load_json(DATA / "collection.json", {"items": []})
    cache = load_json(DATA / "audio.json", {})
    started = time.monotonic()

    # Newest additions first so fresh records get BPM/key soonest.
    order = []
    for it in collection["items"]:
        rid = it["basic_information"]["id"]
        rel = load_json(DATA / "releases" / f"{rid}.json", None)
        if rel:
            order += list(iter_tracks(rel))

    todo = [t for t in dict((t["key"], t) for t in order).values() if due(cache.get(t["key"]))]
    print(f"{len(todo)} tracks need BPM/key")
    done = 0
    for t in todo:
        if time.monotonic() - started > BUDGET:
            print("time budget used up, continuing next run")
            break
        if not t["title"] or not t["artist"] or norm(t["artist"]) == "various":
            cache[t["key"]] = {"source": "none", "checked": NOW.isoformat()}
            continue
        result = None
        try:
            result = acousticbrainz(t["artist"], t["title"])
            if not result:
                result = deezer_preview(t["artist"], t["title"], t["duration"])
        except Exception as e:  # one bad track should never stop the run; retry it next time
            print(f"  error on {t['key']}: {e!r}")
            continue
        if result:
            result["camelot"] = to_camelot(result.get("note"), result.get("scale"))
            result["key"] = key_label(result.get("note"), result.get("scale"))
            result["checked"] = NOW.isoformat()
            cache[t["key"]] = result
            print(f"  {t['artist']} - {t['title']}: {result['bpm']} BPM {result['key']} ({result['source']})")
        else:
            cache[t["key"]] = {"source": "none", "checked": NOW.isoformat()}
            print(f"  {t['artist']} - {t['title']}: no match")
        done += 1
        if done % 25 == 0:
            save_json(DATA / "audio.json", cache)
    save_json(DATA / "audio.json", cache)


if __name__ == "__main__":
    main()
