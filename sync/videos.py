"""Match the YouTube videos attached to a Discogs release to its tracks by title."""
import re
import unicodedata

NOISE = {"official", "video", "audio", "music", "hq", "hd", "4k", "remastered", "remaster", "lyrics", "lyric",
         "vinyl", "rip", "feat", "ft", "featuring", "the", "a", "an", "and", "of", "to", "in", "on", "with", "y",
         "el", "la", "le", "de", "original", "version", "mix", "records", "visualizer", "clip", "oficial", "lp", "ep"}


def youtube_id(uri):
    m = re.search(r"(?:v=|youtu\.be/|/embed/|/shorts/)([\w-]{11})", uri or "")
    return m.group(1) if m else None


def words(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.findall(r"[a-z0-9]+", s)


def title_words(s):
    w = [x for x in words(s) if x not in NOISE]
    return w or words(s)


def match(tracks, videos):
    """tracks: dicts with key, title, artist, duration. Returns ({track key: video id}, [unmatched (id, title)])."""
    vids = []
    for v in videos or []:
        vid = youtube_id(v.get("uri"))
        if vid and vid not in {x[0] for x in vids}:
            vids.append((vid, v.get("title") or "", v.get("duration") or 0))
    best = {}  # track key -> (score, video id)
    for vid, vtitle, vdur in vids:
        # Full-album uploads cover every track; they go to "More videos" instead.
        if re.search(r"full\s*(album|lp|ep)|complete\s*album|\bfull\s*side", vtitle, re.I):
            continue
        vw = set(words(vtitle))
        cands = []
        for t in tracks:
            tw = title_words(t["title"])
            if not tw:
                continue
            score = sum(1 for w in tw if w in vw) / len(tw)
            if score < 0.75:
                continue
            # A video much longer than the track is a full side or album, not this track.
            if t["duration"] and vdur and vdur > t["duration"] * 1.6 + 45:
                continue
            if not t["duration"] and vdur > 900:
                continue
            closeness = -abs((vdur or 0) - (t["duration"] or vdur or 0))
            cands.append((score, len(tw), closeness, t["key"]))
        if not cands:
            continue
        # Ties go to the longer title, so "Moonlight (Dub)" lands on "Moonlight Dub", not "Moonlight".
        score, _, _, key = max(cands)
        if score > best.get(key, (0, None))[0]:
            best[key] = (score, vid)
    # A single on one track with one video: take it whatever the video is called.
    if len(tracks) == 1 and len(vids) == 1 and not best and vids[0][2] < 1200:
        best[tracks[0]["key"]] = (1, vids[0][0])
    out = {k: v for k, (_, v) in best.items()}
    used = set(out.values())
    return out, [(vid, title) for vid, title, _ in vids if vid not in used]
