"""What the collection is worth on Discogs, and how that changes over time.

Discogs has no price history in its API, so Crate keeps its own: every run prices the records that
haven't been priced in the last day, and writes one snapshot of the whole collection per day to
data/value/history.json. The graph in the Value tab starts from the first snapshot.

Per record (data/value/prices.json):
- the lowest price it's listed for right now and how many copies are for sale (marketplace stats,
  works without a token);
- Discogs' price suggestions per condition, based on past sales (needs DISCOGS_TOKEN, and the
  seller settings on Discogs filled in once, even if you never sell).
For the whole collection, with a token: Discogs' own minimum / median / maximum collection value,
the same three numbers the Discogs website shows.

Run by sync.yml after the collection sync; build.py then writes site/value.json for the app.
"""
import os
import re
import time
from datetime import datetime, timedelta, timezone

from common import DATA, ROOT, http_get, load_json, save_json

API = "https://api.discogs.com"
USERNAME = os.environ.get("DISCOGS_USERNAME", "Philippemccc")
TOKEN = os.environ.get("DISCOGS_TOKEN", "").strip()
CURRENCY = (os.environ.get("DISCOGS_CURRENCY") or "EUR").strip().upper()
INTERVAL = 1.1 if TOKEN else 2.5
MINUTES = float(os.environ.get("VALUE_MINUTES", "8"))
MAX_AGE = timedelta(hours=float(os.environ.get("VALUE_MAX_AGE_HOURS", "20")))
RETRY_NO_SUGGESTIONS = timedelta(hours=3)
VDIR = DATA / "value"

# Discogs' condition names -> the short grades collectors use
GRADES = {"Mint (M)": "M", "Near Mint (NM or M-)": "NM", "Very Good Plus (VG+)": "VG+", "Very Good (VG)": "VG",
          "Good Plus (G+)": "G+", "Good (G)": "G", "Fair (F)": "F", "Poor (P)": "P"}


def api(path, **params):
    headers = {"Authorization": f"Discogs token={TOKEN}"} if TOKEN else None
    r = http_get(API + path, params=params, headers=headers, min_interval=INTERVAL, host_key="discogs")
    if r.status_code in (401, 403, 404, 422):
        return None
    r.raise_for_status()
    remaining = r.headers.get("X-Discogs-Ratelimit-Remaining")
    if remaining is not None and int(remaining) < 3:
        time.sleep(10)
    return r.json()


def parse_money(s):
    """Discogs formats collection value as text, e.g. '€1,234.56', '$12.00' or '1.234,56 €'."""
    if isinstance(s, (int, float)):
        return float(s)
    digits = re.sub(r"[^\d.,]", "", s or "")
    if not digits:
        return None
    if re.search(r",\d{2}$", digits):  # 1.234,56
        digits = digits.replace(".", "").replace(",", ".")
    else:
        digits = digits.replace(",", "")
    try:
        return float(digits)
    except ValueError:
        return None


def money_currency(s):
    for sym, cur in (("€", "EUR"), ("£", "GBP"), ("¥", "JPY"), ("CA$", "CAD"), ("A$", "AUD"), ("CHF", "CHF"), ("$", "USD")):
        if sym in (s or ""):
            return cur
    return None


def estimate(p):
    """Low / typical / high for one record. With price suggestions: Very Good, Very Good Plus and
    Near Mint, the grades most used copies sell at. Without: the lowest price it's listed at."""
    s = p.get("s") or {}
    mid = s.get("VG+") or s.get("NM") or s.get("VG")
    if mid:
        lo = min(x for x in (s.get("VG"), s.get("G+"), mid, p.get("low")) if x)
        hi = max(x for x in (s.get("NM"), s.get("M"), mid) if x)
        return round(lo, 2), round(mid, 2), round(hi, 2)
    if p.get("low"):
        return p["low"], p["low"], p["low"]
    return None


def price_record(rid, old):
    out = {"t": datetime.now(timezone.utc).isoformat(timespec="seconds"), "h": old.get("h", [])}
    cur = CURRENCY
    if TOKEN:
        sug = api(f"/marketplace/price_suggestions/{rid}")
        if sug:
            out["s"] = {GRADES.get(k, k): round(float(v["value"]), 2) for k, v in sug.items()
                        if isinstance(v, dict) and v.get("value")}
            curs = {v.get("currency") for v in sug.values() if isinstance(v, dict) and v.get("currency")}
            if len(curs) == 1:
                out["sc"] = cur = curs.pop()  # listed prices in the same currency as the suggestions
        elif old.get("s"):
            out["s"] = old["s"]  # keep the last suggestions if Discogs didn't answer this time
            if old.get("sc"):
                out["sc"] = cur = old["sc"]
    stats = api(f"/marketplace/stats/{rid}", curr_abbr=cur)
    if stats:
        lp = stats.get("lowest_price") or {}
        out["low"] = round(float(lp["value"]), 2) if lp.get("value") is not None else None
        out["n"] = stats.get("num_for_sale") or 0
        if stats.get("blocked_from_sale"):
            out["blocked"] = True
    elif old.get("low") is not None:
        out["low"], out["n"] = old["low"], old.get("n", 0)
    return out


def add_history_point(p, today):
    """Each record's own value line: a point when it moves 2% or more, or at least monthly."""
    e = estimate(p)
    if not e:
        return
    h = p.setdefault("h", [])
    mid = e[1]
    if h and h[-1][0] == today:
        h[-1][1] = mid
    elif not h or abs(mid - h[-1][1]) >= 0.02 * max(h[-1][1], 1) or \
            (datetime.fromisoformat(today) - datetime.fromisoformat(h[-1][0])).days >= 30:
        h.append([today, mid])


def main():
    collection = load_json(DATA / "collection.json", {"items": []})
    items = collection["items"]
    ids = list(dict.fromkeys(it["basic_information"]["id"] for it in items))
    prices = load_json(VDIR / "prices.json", {})
    history = load_json(VDIR / "history.json", {"points": []})
    now = datetime.now(timezone.utc)
    today = now.date().isoformat()

    # Never priced first, then the oldest prices.
    def age(rid):
        t = (prices.get(str(rid)) or {}).get("t")
        return datetime.fromisoformat(t) if t else datetime.min.replace(tzinfo=timezone.utc)
    # With a token, records that came back without price suggestions (seller settings not filled in yet,
    # a Discogs hiccup, or simply no sales) are asked again after a few hours instead of a day.
    def due_now(rid):
        p = prices.get(str(rid)) or {}
        wait = MAX_AGE if (p.get("s") or not TOKEN) else RETRY_NO_SUGGESTIONS
        return now - age(rid) >= wait
    due = sorted((rid for rid in ids if due_now(rid)), key=age)
    print(f"{len(ids)} records, {len(due)} due for a price check ({'with' if TOKEN else 'without'} a Discogs token)")
    stop = time.monotonic() + MINUTES * 60
    done = 0
    for rid in due:
        if time.monotonic() > stop:
            break
        p = price_record(rid, prices.get(str(rid)) or {})
        add_history_point(p, today)
        prices[str(rid)] = p
        done += 1
    print(f"priced {done} records")

    # Records sold or removed drop out.
    wanted = {str(r) for r in ids}
    prices = {k: v for k, v in prices.items() if k in wanted}
    save_json(VDIR / "prices.json", prices)

    point = {"d": today, "n": len(ids)}
    if TOKEN:
        cv = api(f"/users/{USERNAME}/collection/value")
        if cv:
            for k, short in (("minimum", "dmin"), ("median", "dmed"), ("maximum", "dmax")):
                v = parse_money(cv.get(k))
                if v is not None:
                    point[short] = round(v, 2)
            point["dcur"] = money_currency(cv.get("median"))

    # The collection's total from the per-record prices, once nearly every record has one.
    est = {rid: estimate(prices[str(rid)]) for rid in ids if str(rid) in prices}
    est = {rid: e for rid, e in est.items() if e}
    checked = sum(1 for rid in ids if str(rid) in prices)
    point["priced"] = len(est)
    if ids and checked >= 0.95 * len(ids):
        point["lo"] = round(sum(e[0] for e in est.values()), 2)
        point["mid"] = round(sum(e[1] for e in est.values()), 2)
        point["hi"] = round(sum(e[2] for e in est.values()), 2)
        genres = {}
        for it in items:
            bi = it["basic_information"]
            e = est.get(bi["id"])
            if e:
                g = (bi.get("genres") or ["Other"])[0]
                genres[g] = round(genres.get(g, 0) + e[1], 2)
        point["g"] = genres
    else:
        print(f"only {checked} of {len(ids)} records priced so far; the collection total waits until 95% are")

    if any(k in point for k in ("mid", "dmed")):
        pts = [p for p in history["points"] if p["d"] != today]
        pts.append(point)
        history["points"] = sorted(pts, key=lambda p: p["d"])
    history["currency"] = point.get("dcur") or next((p.get("sc") for p in prices.values() if p.get("sc")), None) or CURRENCY
    history["since"] = history["points"][0]["d"] if history["points"] else None
    save_json(VDIR / "history.json", history)
    print(f"snapshot {today}: " + ", ".join(f"{k} {v}" for k, v in point.items() if k not in ("g", "d")))


def write_site(releases_by_id=None):
    """site/value.json: today's price per record plus the daily history, loaded by the Value tab."""
    prices = load_json(VDIR / "prices.json", {})
    history = load_json(VDIR / "history.json", {"points": []})
    recs = {}
    for rid, p in prices.items():
        e = estimate(p)
        r = {"t": p.get("t", "")[:10]}
        if e:
            r["v"] = list(e)
        if p.get("low") is not None:
            r["low"] = p["low"]
        if p.get("n") is not None:
            r["n"] = p["n"]
        if p.get("s"):
            r["s"] = p["s"]
        if len(p.get("h") or []) > 1:
            r["h"] = p["h"]
        recs[rid] = r
    out = {"currency": history.get("currency") or CURRENCY, "since": history.get("since"),
           "points": history.get("points", []), "records": recs}
    save_json(ROOT / "site" / "value.json", out, compact=True)
    n = sum(1 for r in recs.values() if r.get("v"))
    print(f"built site/value.json: {n} records with a price, {len(out['points'])} daily snapshots")


if __name__ == "__main__":
    main()
