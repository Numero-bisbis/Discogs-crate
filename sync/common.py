"""Shared helpers: HTTP with polite rate limiting, JSON cache files, music theory."""
import json
import os
import re
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
USER_AGENT = "DiscogsCrate/1.0 +https://github.com/Numero-bisbis/discogs-crate"

_session = requests.Session()
_session.headers["User-Agent"] = USER_AGENT
_last_call = {}


def http_get(url, *, params=None, headers=None, min_interval=1.0, host_key=None, retries=5, stream=False):
    """GET with a per-host minimum interval and backoff on 429/5xx."""
    key = host_key or url.split("/")[2]
    for attempt in range(retries):
        wait = _last_call.get(key, 0) + min_interval - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last_call[key] = time.monotonic()
        try:
            r = _session.get(url, params=params, headers=headers, timeout=30, stream=stream)
        except requests.RequestException as e:
            print(f"  network error {e!r}, retrying")
            time.sleep(2 ** attempt)
            continue
        if r.status_code == 429 or r.status_code >= 500:
            delay = int(r.headers.get("Retry-After", 0) or 0) or 2 ** (attempt + 1)
            print(f"  {r.status_code} from {key}, waiting {delay}s")
            time.sleep(delay)
            continue
        return r
    raise RuntimeError(f"giving up on {url}")


def load_json(path, default):
    path = Path(path)
    if path.exists():
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return default


def save_json(path, obj, compact=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=1, sort_keys=True)
    os.replace(tmp, path)


def clean_artist(name):
    """Discogs disambiguates artists as 'Name (2)'; drop that suffix."""
    return re.sub(r"\s*\(\d+\)$", "", name or "").strip()


def join_artists(artists):
    out = ""
    for a in artists or []:
        out += clean_artist(a.get("anv") or a.get("name"))
        join = (a.get("join") or "").strip()
        if join:
            out += f" {join} " if join != "," else ", "
    return re.sub(r"\s+", " ", out).strip(" ,&")


# --- keys ---------------------------------------------------------------

NOTE_INDEX = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6,
              "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}
# Camelot number for major keys indexed by pitch class; minor = relative major's number.
MAJOR_CAMELOT = {0: 8, 7: 9, 2: 10, 9: 11, 4: 12, 11: 1, 6: 2, 1: 3, 8: 4, 3: 5, 10: 6, 5: 7}
NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
MINOR_NAMES = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"]


def to_camelot(note, scale):
    """('A', 'minor') -> '8A'. Returns None if unknown."""
    if note not in NOTE_INDEX or scale not in ("major", "minor"):
        return None
    pc = NOTE_INDEX[note]
    if scale == "major":
        return f"{MAJOR_CAMELOT[pc]}B"
    return f"{MAJOR_CAMELOT[(pc + 3) % 12]}A"


def key_label(note, scale):
    if note not in NOTE_INDEX:
        return None
    return (MINOR_NAMES if scale == "minor" else NAMES)[NOTE_INDEX[note]]
