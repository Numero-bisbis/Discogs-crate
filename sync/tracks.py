"""Turn a Discogs release into a flat list of playable tracks."""
from common import join_artists


def parse_duration(s):
    try:
        parts = [int(p) for p in (s or "").split(":")]
    except ValueError:
        return None
    if not parts or len(parts) > 3:
        return None
    secs = 0
    for p in parts:
        secs = secs * 60 + p
    return secs or None


def side_of(position):
    """'A2' -> 'A', 'B' -> 'B', '1-3' (CD 1) -> '1', '7' -> None."""
    pos = (position or "").strip()
    if not pos:
        return None
    if "-" in pos:
        return pos.split("-")[0]
    letters = ""
    for ch in pos:
        if ch.isalpha():
            letters += ch
        else:
            break
    return letters.upper() or None


def iter_tracks(release):
    release_artist = join_artists(release.get("artists"))
    n = 0
    for t in release.get("tracklist") or []:
        kind = t.get("type_", "track")
        if kind == "heading":
            continue
        entries = t.get("sub_tracks") if kind == "index" and t.get("sub_tracks") else [t]
        for st in entries:
            n += 1
            pos = st.get("position") or t.get("position") or str(n)
            yield {
                "key": f"{release['id']}:{pos}",
                "position": pos,
                "side": side_of(pos),
                "title": st.get("title") or t.get("title") or "",
                "artist": join_artists(st.get("artists") or t.get("artists")) or release_artist,
                "duration": parse_duration(st.get("duration") or t.get("duration")),
            }
