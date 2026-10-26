"""Combine the collection, release details and BPM/key cache into site/data.json."""
from datetime import datetime, timezone

import numpy as np

from common import DATA, ROOT, join_artists, load_json, save_json
from tracks import iter_tracks
from videos import match as match_videos


def format_label(formats):
    out = []
    for f in formats or []:
        qty = f.get("qty")
        name = f.get("name") or ""
        if qty and qty not in ("1", 1):
            name = f"{qty}×{name}"
        out.append(", ".join([name] + (f.get("descriptions") or [])))
    return "; ".join(out)


def sound_profiles(releases):
    """Shrink each track's 64-number fingerprint to 12 with PCA over the whole collection, so
    data.json stays small, and turn the mood scores into one 0-100 energy figure."""
    keys, vecs, extra = [], [], {}
    for r in releases:
        prof = load_json(DATA / "profiles" / f"{r['id']}.json", {})
        for t in r["tracks"]:
            p = prof.get(t["k"])
            if p and p.get("v"):
                keys.append(t["k"])
                vecs.append(p["v"])
                moods = [p[m] for m in ("aggr", "party") if m in p] + ([1 - p["relax"]] if "relax" in p else [])
                extra[t["k"]] = {"e": round(100 * sum(moods) / len(moods)) if moods else None,
                                 "d": round(100 * p["dance"]) if "dance" in p else None,
                                 "vo": round(100 * p["voice"]) if "voice" in p else None}
    if len(vecs) < 20:
        return {}
    x = np.asarray(vecs)
    x = x - x.mean(axis=0)
    _, _, vt = np.linalg.svd(x, full_matrices=False)
    y = x @ vt[:12].T
    y /= np.linalg.norm(y, axis=1, keepdims=True) + 1e-9
    return {k: {"v": [round(float(a) * 100) for a in row], **extra[k]} for k, row in zip(keys, y)}


def main():
    collection = load_json(DATA / "collection.json", {"items": [], "folders": {}})
    audio = load_json(DATA / "audio.json", {})
    releases = []
    for it in collection["items"]:
        bi = it["basic_information"]
        rel = load_json(DATA / "releases" / f"{bi['id']}.json", None) or {}
        tracks = []
        raw = list(iter_tracks(rel)) if rel else []
        yt, other_videos = match_videos(raw, rel.get("videos"))
        for t in raw:
            a = audio.get(t["key"]) or {}
            tracks.append({
                "k": t["key"], "pos": t["position"], "side": t["side"], "title": t["title"],
                "artist": t["artist"], "dur": t["duration"],
                "bpm": round(a["bpm"]) if a.get("bpm") else None, "key": a.get("key"), "cam": a.get("camelot"),
                # acousticbrainz | deezer-preview | none (looked, nothing found) | null (not looked up yet)
                "src": a.get("source"),
                # snippet: YouTube video from Discogs, else the Deezer track whose preview was analysed
                **({"yt": yt[t["key"]]} if t["key"] in yt else {}),
                **({"dz": a["deezer_id"]} if a.get("deezer_id") else {}),
            })
        releases.append({
            "id": bi["id"], "iid": it.get("instance_id"),
            "title": bi.get("title"), "artist": join_artists(bi.get("artists")),
            "year": rel.get("year") or bi.get("year") or None,
            "labels": [{"name": l.get("name"), "catno": l.get("catno")} for l in bi.get("labels") or []],
            "format": format_label(bi.get("formats")),
            "genres": bi.get("genres") or [], "styles": bi.get("styles") or [],
            "country": rel.get("country"),
            "cover": bi.get("cover_image"), "thumb": bi.get("thumb"),
            "added": it.get("date_added"), "rating": it.get("rating") or 0,
            "folder": collection["folders"].get(str(it.get("folder_id"))) or collection["folders"].get(it.get("folder_id")),
            "url": rel.get("uri") or f"https://www.discogs.com/release/{bi['id']}",
            "tracks": tracks,
            "vids": [[vid, title] for vid, title in other_videos],
        })
    snd = sound_profiles(releases)
    for r in releases:
        for t in r["tracks"]:
            if t["k"] in snd:
                t["snd"] = snd[t["k"]]
    out = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "username": collection.get("username"),
        "releases": releases,
    }
    save_json(ROOT / "site" / "data.json", out, compact=True)
    n_tracks = sum(len(r["tracks"]) for r in releases)
    n_bpm = sum(1 for r in releases for t in r["tracks"] if t["bpm"])
    n_yt = sum(1 for r in releases for t in r["tracks"] if t.get("yt"))
    n_dz = sum(1 for r in releases for t in r["tracks"] if t.get("dz") and not t.get("yt"))
    print(f"built site/data.json: {len(releases)} records, {n_tracks} tracks, {n_bpm} with BPM, "
          f"{n_yt} with a YouTube video, {n_dz} more with a Deezer preview, {len(snd)} with a sound profile")


if __name__ == "__main__":
    main()
