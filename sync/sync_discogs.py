"""Pull the Discogs collection and the full release details (tracklists) for new records.

Incremental: release details are cached in data/releases/<id>.json and only fetched
for records not seen before. The collection list itself is re-read every run so that
additions, removals, folder moves and ratings stay current.
"""
import os
import sys
import time

from common import DATA, http_get, load_json, save_json

API = "https://api.discogs.com"
USERNAME = os.environ.get("DISCOGS_USERNAME", "Philippemccc")
TOKEN = os.environ.get("DISCOGS_TOKEN", "").strip()
# Discogs allows 60 req/min with a token and 25 without.
INTERVAL = 1.1 if TOKEN else 2.5
MAX_NEW_RELEASES = int(os.environ.get("MAX_NEW_RELEASES", "1000"))
# Releases cached before video links were kept get re-fetched a batch per run, so a run stays short.
MAX_BACKFILL = int(os.environ.get("MAX_BACKFILL", "200"))


def api(path, **params):
    headers = {"Authorization": f"Discogs token={TOKEN}"} if TOKEN else None
    r = http_get(API + path, params=params, headers=headers, min_interval=INTERVAL, host_key="discogs")
    if r.status_code in (401, 403):
        sys.exit(
            f"Discogs refused {path} ({r.status_code}). The collection is probably private: either tick "
            "'Allow others to browse my collection' in Discogs Settings > Privacy, or add a personal "
            "access token as the DISCOGS_TOKEN repository secret."
        )
    if r.status_code == 404:
        return None
    r.raise_for_status()
    remaining = r.headers.get("X-Discogs-Ratelimit-Remaining")
    if remaining is not None and int(remaining) < 3:
        time.sleep(10)
    return r.json()


def fetch_collection():
    items, page = [], 1
    while True:
        res = api(f"/users/{USERNAME}/collection/folders/0/releases",
                  per_page=100, page=page, sort="added", sort_order="desc")
        if res is None:
            sys.exit(f"Discogs user {USERNAME} not found")
        items += res["releases"]
        pages = res["pagination"]["pages"]
        print(f"collection page {page}/{pages}: {len(items)} items")
        if page >= pages:
            return items
        page += 1


def fetch_folders():
    res = api(f"/users/{USERNAME}/collection/folders") or {}
    return {f["id"]: f["name"] for f in res.get("folders", [])}


def main():
    items = fetch_collection()
    folders = fetch_folders()
    save_json(DATA / "collection.json", {"username": USERNAME, "folders": folders, "items": items})

    rel_dir = DATA / "releases"
    rel_dir.mkdir(parents=True, exist_ok=True)
    wanted = {it["basic_information"]["id"] for it in items}
    have = {int(p.stem) for p in rel_dir.glob("*.json")}

    new = [rid for rid in dict.fromkeys(it["basic_information"]["id"] for it in items) if rid not in have]
    stale = [rid for rid in sorted(have & wanted) if "videos" not in load_json(rel_dir / f"{rid}.json", {})]
    print(f"{len(wanted)} releases in collection, {len(new)} need details, {len(stale)} need video links")
    todo = new[:MAX_NEW_RELEASES] + stale[:MAX_BACKFILL]
    for i, rid in enumerate(todo, 1):
        rel = api(f"/releases/{rid}")
        if rel is None:
            print(f"  release {rid} missing on Discogs, skipping")
            continue
        keep = {k: rel.get(k) for k in ("id", "title", "artists", "year", "released", "country", "genres",
                                        "styles", "labels", "formats", "tracklist", "uri", "notes")}
        keep["images"] = (rel.get("images") or [])[:1]
        # YouTube links people attached on Discogs; build.py matches them to tracks for snippets.
        keep["videos"] = [{k: v.get(k) for k in ("uri", "title", "duration")} for v in rel.get("videos") or []]
        save_json(rel_dir / f"{rid}.json", keep)
        print(f"  [{i}/{len(todo)}] {rid} {rel.get('title')}")

    # Records sold or removed from the collection drop out of the cache.
    for rid in have - wanted:
        (rel_dir / f"{rid}.json").unlink()
        print(f"  removed {rid}")


if __name__ == "__main__":
    main()
