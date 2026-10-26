"""Combine the collection, release details and BPM/key cache into site/data.json."""
from datetime import datetime, timezone

from common import DATA, ROOT, join_artists, load_json, save_json
from tracks import iter_tracks


def format_label(formats):
    out = []
    for f in formats or []:
        qty = f.get("qty")
        name = f.get("name") or ""
        if qty and qty not in ("1", 1):
            name = f"{qty}×{name}"
        out.append(", ".join([name] + (f.get("descriptions") or [])))
    return "; ".join(out)


def main():
    collection = load_json(DATA / "collection.json", {"items": [], "folders": {}})
    audio = load_json(DATA / "audio.json", {})
    releases = []
    for it in collection["items"]:
        bi = it["basic_information"]
        rel = load_json(DATA / "releases" / f"{bi['id']}.json", None) or {}
        tracks = []
        for t in iter_tracks(rel) if rel else []:
            a = audio.get(t["key"]) or {}
            tracks.append({
                "k": t["key"], "pos": t["position"], "side": t["side"], "title": t["title"],
                "artist": t["artist"], "dur": t["duration"],
                "bpm": a.get("bpm"), "key": a.get("key"), "cam": a.get("camelot"),
                "src": a.get("source") if a.get("source") != "none" else None,
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
        })
    out = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "username": collection.get("username"),
        "releases": releases,
    }
    save_json(ROOT / "site" / "data.json", out, compact=True)
    n_tracks = sum(len(r["tracks"]) for r in releases)
    n_bpm = sum(1 for r in releases for t in r["tracks"] if t["bpm"])
    print(f"built site/data.json: {len(releases)} records, {n_tracks} tracks, {n_bpm} with BPM")


if __name__ == "__main__":
    main()
