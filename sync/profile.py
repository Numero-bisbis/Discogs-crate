"""Give every track a sound profile, so the mix generator can tell which tracks belong together.

For each track we fetch a 30-second preview (Deezer, else Apple Music) and run Essentia's
Discogs-EffNet model on it: a network trained on Discogs styles whose embedding works as a
"sounds like" fingerprint (close vectors sound alike). Small classifier heads on the same
embedding add danceability, aggressive, relaxed, party and voice probabilities.

Profiles are cached per release in data/profiles/<release id>.json so a run only adds new
files. The embedding is shrunk from 1280 to 64 numbers with a fixed random projection, which
keeps cosine similarity close to the original. The run stops after PROFILE_MINUTES.
"""
import json
import os
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from common import DATA, ROOT, http_get, load_json, save_json
from enrich import deezer_match, similar
from tracks import iter_tracks

BUDGET = float(os.environ.get("PROFILE_MINUTES", "20")) * 60
RETRY_DAYS = 30
NOW = datetime.now(timezone.utc)
MODELS = Path(os.environ.get("MODEL_DIR", ROOT / ".models"))
BASE = "https://essentia.upf.edu/models"
EMBEDDER = "feature-extractors/discogs-effnet/discogs-effnet-bs64-1"
HEADS = {  # name in the profile -> (model path, class whose probability we keep)
    "dance": ("classification-heads/danceability/danceability-discogs-effnet-1", "danceable"),
    "aggr": ("classification-heads/mood_aggressive/mood_aggressive-discogs-effnet-1", "aggressive"),
    "relax": ("classification-heads/mood_relaxed/mood_relaxed-discogs-effnet-1", "relaxed"),
    "party": ("classification-heads/mood_party/mood_party-discogs-effnet-1", "party"),
    "voice": ("classification-heads/voice_instrumental/voice_instrumental-discogs-effnet-1", "voice"),
}
DIMS = 64
PROJECTION = np.random.default_rng(7).standard_normal((1280, DIMS)) / np.sqrt(DIMS)


def fetch_model(path):
    """Download a model graph and its metadata once (CI caches the folder)."""
    MODELS.mkdir(parents=True, exist_ok=True)
    out = {}
    for ext in (".pb", ".json"):
        f = MODELS / (Path(path).name + ext)
        if not f.exists():
            r = http_get(f"{BASE}/{path}{ext}", min_interval=0.2, host_key="essentia")
            r.raise_for_status()
            f.write_bytes(r.content)
        out[ext] = f
    return out[".pb"], json.loads(out[".json"].read_text())


def output_name(meta, purpose):
    for o in meta.get("schema", {}).get("outputs", []):
        if o.get("output_purpose") == purpose:
            return o["name"]
    if purpose == "embeddings":
        return "PartitionedCall:1"  # what the Essentia docs use for Discogs-EffNet
    raise KeyError(purpose)


class Profiler:
    def __init__(self):
        import essentia.standard as es
        self.es = es
        pb, meta = fetch_model(EMBEDDER)
        self.embedder = es.TensorflowPredictEffnetDiscogs(graphFilename=str(pb), output=output_name(meta, "embeddings"))
        self.heads = {}
        for name, (path, wanted) in HEADS.items():
            try:
                pb, meta = fetch_model(path)
                model = es.TensorflowPredict2D(graphFilename=str(pb), input=meta["schema"]["inputs"][0]["name"],
                                               output=output_name(meta, "predictions"))
                self.heads[name] = (model, meta["classes"].index(wanted))
            except Exception as e:  # a missing head only loses that one score
                print(f"  skipping {name} model: {e!r}")

    def __call__(self, path):
        audio = self.es.MonoLoader(filename=path, sampleRate=16000, resampleQuality=4)()
        if len(audio) < 16000 * 5:
            return None
        frames = self.embedder(audio)
        vec = np.asarray(frames).mean(axis=0) @ PROJECTION
        vec /= np.linalg.norm(vec) or 1
        prof = {"v": [round(float(x), 4) for x in vec]}
        for name, (model, idx) in self.heads.items():
            prof[name] = round(float(np.asarray(model(frames))[:, idx].mean()), 3)
        return prof


def find_preview(t, audio_entry):
    """URL of a 30 s preview for this track and where it came from, or (None, None)."""
    dz = (audio_entry or {}).get("deezer_id")
    if dz:
        r = http_get(f"https://api.deezer.com/track/{dz}", min_interval=0.15)
        if r.status_code == 200 and r.json().get("preview"):
            return r.json()["preview"], "deezer"
    hit, _ = deezer_match(t["artist"], t["title"], t["duration"])
    if hit and hit.get("preview"):
        return hit["preview"], "deezer"
    r = http_get("https://itunes.apple.com/search", params={"term": f"{t['artist']} {t['title']}", "entity": "song", "limit": 10},
                 min_interval=3.1, host_key="itunes")  # Apple allows about 20 searches a minute
    best, best_score = None, 0
    for h in (r.json().get("results") if r.status_code == 200 else None) or []:
        score = similar(t["title"], h.get("trackName")) * 0.6 + similar(t["artist"], h.get("artistName")) * 0.4
        if h.get("previewUrl") and score > best_score:
            best, best_score = h, score
    return (best["previewUrl"], "apple") if best and best_score >= 0.75 else (None, None)


def due(entry):
    if not entry:
        return True
    if entry.get("none"):
        return NOW - datetime.fromisoformat(entry["checked"]) > timedelta(days=RETRY_DAYS)
    return False


def main():
    collection = load_json(DATA / "collection.json", {"items": []})
    audio = load_json(DATA / "audio.json", {})
    out_dir = DATA / "profiles"
    out_dir.mkdir(exist_ok=True)
    started = time.monotonic()
    profiler = None
    done = 0
    for it in collection["items"]:  # newest additions first
        rid = it["basic_information"]["id"]
        rel = load_json(DATA / "releases" / f"{rid}.json", None)
        if not rel:
            continue
        path = out_dir / f"{rid}.json"
        cache = load_json(path, {})
        todo = [t for t in iter_tracks(rel) if due(cache.get(t["key"])) and t["title"]]
        if not todo:
            continue
        if profiler is None:
            try:
                profiler = Profiler()
            except Exception as e:  # without the model nothing can be profiled, so stop rather than mark tracks
                print(f"could not load the sound model: {e!r}")
                raise SystemExit(0)
        changed = False
        for t in todo:
            if time.monotonic() - started > BUDGET:
                break
            try:
                url, src = find_preview(t, audio.get(t["key"]))
                prof = None
                if url:
                    clip = http_get(url, min_interval=0.15, host_key="preview-cdn")
                    if clip.status_code == 200 and clip.content:
                        with tempfile.NamedTemporaryFile(suffix=".m4a" if src == "apple" else ".mp3") as f:
                            f.write(clip.content)
                            f.flush()
                            prof = profiler(f.name)
            except Exception as e:  # retried next run
                print(f"  error on {t['key']}: {e!r}")
                continue
            cache[t["key"]] = {**prof, "src": src} if prof else {"none": True, "checked": NOW.isoformat()}
            changed = True
            done += 1
            print(f"  {t['artist']} - {t['title']}: {'profiled from ' + src if prof else 'no preview'}")
        if changed:
            save_json(path, cache, compact=True)
        if time.monotonic() - started > BUDGET:
            print("time budget used up, continuing next run")
            break
    print(f"profiled {done} tracks")


if __name__ == "__main__":
    main()
