/* Crate · Value: what the collection is worth on Discogs, like a portfolio in an investment app.
   Reads site/value.json (written by sync/value.py + build.py): one snapshot per day plus today's
   price per record. Discogs keeps no price history, so the graph starts at Crate's first snapshot. */
(function () {
  'use strict';
  const A = window.CrateApp;
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = A.esc;
  const store = {
    get(k, d) { try { const v = localStorage.getItem('crate.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('crate.' + k, JSON.stringify(v)); } catch { /* blocked */ } },
  };
  const st = Object.assign({ range: '3M', dim: 'genre', pick: '', sort: 'value', series: '', measure: 'med', show: 'value' }, store.get('valueView', {}));
  const save = () => store.set('valueView', { range: st.range, dim: st.dim, sort: st.sort, series: st.series, lbBy: st.lbBy, measure: st.measure, show: st.show });
  const MEASURES = [['min', 'Min', 'Minimum'], ['med', 'Median', 'Median'], ['max', 'Max', 'Maximum']];
  const lbShow = {}; // how far each leaderboard is opened: 5, 10, 25 or all

  let V = null, loading = null;
  function load() {
    if (!loading) {
      loading = fetch('value.json', { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((v) => { V = v || { points: [], records: {} }; return V; });
    }
    return loading;
  }

  // ---------- numbers ----------
  const DAY = 864e5;
  const RANGES = [['1M', 'Month', 30], ['3M', 'Quarter', 91], ['1Y', 'Year', 365], ['All', 'All time', 0]];
  const fmts = {};
  function money(v, whole) {
    if (v == null || isNaN(v)) return '–';
    const cur = (V && V.currency) || 'EUR';
    const k = cur + (whole ? 'w' : 'c');
    try {
      fmts[k] = fmts[k] || new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
      return fmts[k].format(v);
    } catch { return (whole ? Math.round(v) : v.toFixed(2)) + ' ' + cur; }
  }
  const big = (v) => money(v, Math.abs(v) >= 1000);
  const pct = (a, b) => (b ? ((a - b) / b) * 100 : 0);
  const dateOf = (d) => new Date(d + 'T12:00:00Z');
  const fmtDate = (d, year = true) => dateOf(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(year || d.slice(0, 4) !== String(new Date().getFullYear()) ? { year: 'numeric' } : {}) });
  function changeHtml(now, then, label) {
    if (now == null || then == null) return '';
    const d = now - then, p = pct(now, then);
    const cls = Math.abs(d) < 0.005 ? 'flat' : d > 0 ? 'up' : 'down';
    const arrow = cls === 'up' ? '▲' : cls === 'down' ? '▼' : '';
    return `<span class="vchg ${cls}">${arrow ? arrow + ' ' : ''}${money(Math.abs(d), Math.abs(d) >= 1000)} (${d >= 0 ? '+' : '−'}${Math.abs(p).toFixed(1)}%)</span>${label ? ` <span class="vchg-l">${esc(label)}</span>` : ''}`;
  }

  // Profit / loss reads as a signed amount; its % is against what the records cost.
  const signed = (v) => (Math.abs(v) < 0.005 ? money(0, true) : (v > 0 ? '+' : '−') + big(Math.abs(v)));
  function plHtml(now, then, label) {
    if (now == null || then == null) return '';
    const d = now.v - then.v, basis = now.x - now.v;
    const cls = Math.abs(d) < 0.005 ? 'flat' : d > 0 ? 'up' : 'down';
    const arrow = cls === 'up' ? '▲' : cls === 'down' ? '▼' : '';
    return `<span class="vchg ${cls}">${arrow ? arrow + ' ' : ''}${money(Math.abs(d), Math.abs(d) >= 1000)}${basis > 0 ? ` (${d >= 0 ? '+' : '−'}${Math.abs((d / basis) * 100).toFixed(1)}%)` : ''}</span>${label ? ` <span class="vchg-l">${esc(label)}</span>` : ''}`;
  }

  // Which line to draw: Discogs' own median (with its min–max band) when there is one, else the sum of
  // each record's typical price. A genre picked in the breakdown draws that genre's share instead.
  function seriesKinds() {
    const pts = V.points || [];
    return { discogs: pts.some((p) => p.dmed != null), est: pts.some((p) => p.mid != null) };
  }
  // Minimum / median / maximum picks which of the three numbers the line and the big number follow.
  // A genre's line only has the typical price, so it stays on the median.
  function series() {
    const k = seriesKinds();
    let kind = st.series && k[st.series] ? st.series : k.discogs ? 'discogs' : 'est';
    if (st.dim === 'genre' && st.pick) kind = 'genre';
    const m = kind === 'genre' ? 'med' : st.measure;
    const dk = { min: 'dmin', med: 'dmed', max: 'dmax' }[m], ek = { min: 'lo', med: 'mid', max: 'hi' }[m];
    let pts = (V.points || []).map((p) => {
      if (kind === 'discogs') return p[dk] != null && { d: p.d, v: p[dk], e: p.mid };
      if (kind === 'genre') return p.g && { d: p.d, v: p.g[st.pick] || 0, e: p.g[st.pick] || 0 };
      return p[ek] != null && { d: p.d, v: p[ek], e: p.mid };
    }).filter(Boolean);
    let pl = null;
    if (st.show === 'pl') ({ pts, pl } = profit(pts, kind, m));
    return { kind, pts, m, pl };
  }

  // Profit / loss: the value's change since tracking began, without the jump a newly added record
  // makes. Each record's cost is what it was worth the day Crate first priced it, or what you paid
  // when that's written on Discogs (a collection field such as "Price paid", or "paid 12" in Notes).
  // Day by day: P/L += today's value − the day before's − what the records that came in are worth.
  // Discogs' own totals count a record from the day it's added and don't say what one record adds,
  // so there a newcomer counts at its own price scaled to Discogs' totals (they run above Crate's).
  // Crate's own totals ("By record", a genre) count a record from the day it first got a price.
  function profit(pts, kind, m) {
    if (!pts.length) return { pts, pl: null };
    const ratio = (p) => (!p.v || !p.v[1] ? 1 : m === 'min' ? p.v[0] / p.v[1] : m === 'max' ? p.v[2] / p.v[1] : 1);
    const dates = pts.map((p) => p.d);
    const at = (d) => dates.findIndex((x) => x >= d);
    // the nightly sync runs around 3–5 AM UTC: a record added later in the day shows up the next day
    const syncOf = (iso) => { const t = new Date(iso); if (isNaN(t)) return null; const d = t.toISOString().slice(0, 10); return t.getUTCHours() < 3 ? d : new Date(t.getTime() + DAY).toISOString().slice(0, 10); };
    const enter = pts.map(() => []); // records that came in on that day
    let start = 0, withCost = 0;
    const take = (p, day) => {
      const i = at(day);
      if (i < 0) return;
      const rec = { val: p.f[1] * ratio(p), cost: p.c };
      if (p.c != null) withCost++;
      if (i === 0) { if (p.c != null) start += rec.val - p.c; } // there from the start: only a known cost counts
      else enter[i].push(rec);
    };
    if (kind === 'discogs') {
      for (const r of A.releases()) { const p = V.records[String(r.id)]; if (p && p.f && p.v) take(p, (r.added && syncOf(r.added)) || p.f[0]); }
    } else {
      const rels = new Map(A.releases().map((r) => [String(r.id), r]));
      for (const [rid, p] of Object.entries(V.records || {})) {
        if (!p.f || !p.v) continue;
        const r = rels.get(rid);
        if (kind === 'genre' && (!r || (r.genres[0] || 'Other') !== st.pick)) continue;
        take(p, p.f[0]);
      }
    }
    const scale = (p) => (kind === 'discogs' && p.e ? p.v / p.e : 1);
    start *= scale(pts[0]);
    const out = [{ d: pts[0].d, v: start, x: pts[0].v }];
    let acc = start, added = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], k = scale(b);
      // what came in counts at its value, or at what you paid for it when that's known
      const inVal = enter[i].reduce((s, r) => s + (r.cost != null ? r.cost : r.val * k), 0);
      added += enter[i].length;
      acc += b.v - a.v - inVal;
      out.push({ d: b.d, v: acc, x: b.v });
    }
    return { pts: out, pl: { added, withCost } };
  }
  function inRange(pts) {
    const days = (RANGES.find((r) => r[0] === st.range) || RANGES[3])[2];
    if (!days || !pts.length) return pts;
    const end = dateOf(pts[pts.length - 1].d).getTime();
    const from = end - days * DAY;
    const out = pts.filter((p) => dateOf(p.d).getTime() >= from);
    return out.length ? out : pts.slice(-1);
  }

  // ---------- per record ----------
  function recs() {
    return A.releases().map((r) => ({ r, p: V.records[String(r.id)] || null }));
  }
  const mid = (x) => (x.p && x.p.v ? x.p.v[1] : null);
  function valueAt(p, date) { // a record's typical price on a date, from its own value line
    if (!p || !p.v) return null;
    const h = p.h || [];
    if (!h.length) return p.v[1];
    let v = null;
    for (const [d, x] of h) { if (d <= date) v = x; else break; }
    return v ?? h[0][1];
  }
  const DIMS = {
    genre: ['Genre', (r) => r.genres[0] || 'Other'],
    style: ['Style', (r) => r.styles[0] || 'No style'],
    label: ['Label', (r) => (r.labels[0] && r.labels[0].name) || 'No label'],
    decade: ['Decade', (r) => (r.year ? Math.floor(r.year / 10) * 10 + 's' : 'Unknown')],
  };

  // ---------- chart ----------
  function chartSvg(pts, kind, w, pl) {
    const h = 190, padT = 10, padB = 24, padR = 4;
    if (!pts.length) return '';
    const vals = pts.map((p) => p.v);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (pl) { // profit / loss: keep 0 on the scale, and a scale that fits the gains, not the collection
      min = Math.min(min, 0); max = Math.max(max, 0);
      if (max - min < 1) { min -= 5; max += 5; }
    } else if (max - min < max * 0.02) { const m = (max + min) / 2 || 1; min = m * 0.98; max = m * 1.02; }
    const span = max - min; min -= span * 0.08; max += span * 0.08;
    const t0 = dateOf(pts[0].d).getTime(), t1 = dateOf(pts[pts.length - 1].d).getTime();
    const X = (p) => (t1 === t0 ? w / 2 : ((dateOf(p.d).getTime() - t0) / (t1 - t0)) * (w - padR));
    const Y = (v) => padT + (1 - (v - min) / (max - min)) * (h - padT - padB);
    const last = pts[pts.length - 1];
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
    // a soft fill under the line, like a stock chart
    const base = pl ? Y(0) : h - padB;
    const area = pts.length > 1 ? `${line}L${X(last).toFixed(1)},${base.toFixed(1)}L${X(pts[0]).toFixed(1)},${base.toFixed(1)}Z` : '';
    const ticks = pl ? niceTicks(min, max) : [0.2, 0.5, 0.8].map((f) => min + (max - min) * f);
    const grid = ticks.map((v) => `<line class="vg${pl && v === 0 ? ' v0' : ''}" x1="0" x2="${w}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="vt" x="${w - 2}" y="${(Y(v) - 4).toFixed(1)}" text-anchor="end">${esc(pl ? (Math.abs(v) < 0.005 ? money(0, true) : (v > 0 ? '+' : '−') + money(Math.abs(v), true)) : money(v, true))}</text>`).join('');
    const xl = pts.length > 1
      ? `<text class="vt" x="0" y="${h - 6}">${esc(fmtDate(pts[0].d))}</text><text class="vt" x="${w - 2}" y="${h - 6}" text-anchor="end">${esc(fmtDate(pts[pts.length - 1].d))}</text>`
      : `<text class="vt" x="${w / 2}" y="${h - 6}" text-anchor="middle">${esc(fmtDate(pts[0].d))}</text>`;
    return `<svg class="vchart" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(pl ? 'Profit or loss' : kind === 'discogs' ? 'Discogs collection value' : 'Collection value')} over time">
      ${grid}${!area ? '' : pl ? `<defs><clipPath id="vpos"><rect x="0" y="0" width="${w}" height="${base.toFixed(1)}"/></clipPath><clipPath id="vneg"><rect x="0" y="${base.toFixed(1)}" width="${w}" height="${(h - base).toFixed(1)}"/></clipPath></defs><path class="vband" clip-path="url(#vpos)" d="${area}"/><path class="vband neg" clip-path="url(#vneg)" d="${area}"/>` : `<path class="vband" d="${area}"/>`}
      ${pts.length > 1 ? `<path class="vline" d="${line}"/>` : ''}
      <circle class="vdot" cx="${X(last).toFixed(1)}" cy="${Y(last.v).toFixed(1)}" r="4"/>
      ${xl}
      <g class="vcross" hidden><line x1="0" x2="0" y1="${padT}" y2="${h - padB}"/><circle r="4.5"/></g>
      <rect class="vhit" x="0" y="0" width="${w}" height="${h}"/>
    </svg>`;
  }
  function niceTicks(min, max) { // round steps that include 0, for the profit / loss scale
    const raw = (max - min) / 4, mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((x) => x >= raw) || raw;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(Math.abs(v) < step / 1e6 ? 0 : v);
    return out;
  }
  function wireChart(box, pts, onScrub) {
    const svg = $('svg', box);
    if (!svg || pts.length < 2) return;
    const w = +svg.getAttribute('width'), h = +svg.getAttribute('height');
    const t0 = dateOf(pts[0].d).getTime(), t1 = dateOf(pts[pts.length - 1].d).getTime();
    const cross = $('.vcross', svg), cl = $('line', cross), cc = $('circle', cross);
    const line = $('.vline', svg);
    const move = (e) => {
      const rect = svg.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * w;
      const t = t0 + (x / (w - 4)) * (t1 - t0);
      let best = pts[0];
      for (const p of pts) if (Math.abs(dateOf(p.d).getTime() - t) < Math.abs(dateOf(best.d).getTime() - t)) best = p;
      const bx = t1 === t0 ? w / 2 : ((dateOf(best.d).getTime() - t0) / (t1 - t0)) * (w - 4);
      // the line's own y at that x, read back from the drawn path
      const len = line.getTotalLength();
      let lo = 0, hi = len;
      for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (line.getPointAtLength(m).x < bx) lo = m; else hi = m; }
      const y = line.getPointAtLength(hi).y;
      cross.hidden = false;
      cl.setAttribute('x1', bx); cl.setAttribute('x2', bx);
      cc.setAttribute('cx', bx); cc.setAttribute('cy', Math.min(h, y));
      onScrub(best);
    };
    const end = () => { cross.hidden = true; onScrub(null); };
    const hit = $('.vhit', svg);
    hit.addEventListener('pointerdown', (e) => { move(e); });
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerleave', end);
    hit.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') end(); });
    hit.addEventListener('pointercancel', end);
  }

  // ---------- the view ----------
  const SEG = (name, items, cur) => `<div class="seg vseg" role="radiogroup" data-seg="${name}">${items.map(([v, label, title]) => `<button type="button" role="radio" aria-checked="${v === cur}" data-v="${esc(v)}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</button>`).join('')}</div>`;

  async function render() {
    const root = $('#value');
    if (!V) { root.innerHTML = '<p class="empty">Loading prices…</p>'; await load(); }
    if (A.view() !== 'value') return;
    const all = recs();
    const priced = all.filter((x) => mid(x) != null);
    const k = seriesKinds();
    if (!priced.length && !(V.points || []).length) {
      root.innerHTML = `<section class="card-s vempty"><h2>No prices yet</h2>
        <p>Crate checks what each record sells for on Discogs during its regular sync and saves the collection's value once a day. The first prices appear after the next sync or two.</p>
        <p>For Discogs' own minimum, median and maximum and for prices by condition, add a Discogs token as the repository secret <code>DISCOGS_TOKEN</code> and fill in your seller settings on Discogs once (you don't have to sell anything). Without a token Crate can only see the cheapest copy for sale.</p></section>`;
      return;
    }
    const { kind, pts: allPts, m, pl } = series();
    const isPL = !!pl;
    const mName = (MEASURES.find((x) => x[0] === m) || MEASURES[1])[2].toLowerCase();
    const pts = inRange(allPts);
    const last = allPts[allPts.length - 1] || null;
    const first = pts[0] || null;
    const latest = (V.points || [])[V.points.length - 1] || {};
    const rangeLabel = (RANGES.find((r) => r[0] === st.range) || RANGES[3])[1].toLowerCase();
    const short = allPts.length && first && st.range !== 'All' && first.d === allPts[0].d;
    const changeLabel = !first || first === last ? '' : short ? `since ${fmtDate(first.d, false)}` : st.range === 'All' ? 'all time' : `past ${rangeLabel}`;
    const what = kind === 'genre' ? `${st.pick} records` : isPL ? 'Profit / loss' : 'Collection value';
    const src = kind === 'discogs' ? `Discogs ${mName}` : kind === 'genre' || m === 'med' ? 'typical price' : `${mName} price`;
    const headLabel = `${what}${kind === 'genre' && isPL ? ' · profit / loss' : ''} · ${src}${isPL && V.since ? ` · since ${fmtDate(V.since, false)}` : ''}`;
    const numTxt = (p) => (p ? (isPL ? signed(p.v) : big(p.v)) : '–');
    const chgTxt = (a, b, label) => (isPL ? plHtml(a, b, label) : changeHtml(a.v, b.v, label));
    const numCls = (p) => (isPL && p ? (p.v > 0.005 ? ' up' : p.v < -0.005 ? ' down' : '') : '');

    // tiles: Discogs' three numbers when there are any, else Crate's own low / typical / high
    const n = latest.n || all.length;
    const tri = latest.dmed != null ? [latest.dmin, latest.dmed, latest.dmax, 'Discogs'] : latest.mid != null ? [latest.lo, latest.mid, latest.hi, 'Crate estimate'] : null;
    const sumMid = priced.reduce((s, x) => s + mid(x), 0);
    const tiles = `<div class="vtiles${tri ? '' : ' one'}">
      ${tri ? MEASURES.map(([mv, , label], i) => `<button type="button" class="vtile${kind !== 'genre' && m === mv ? ' on' : ''}" data-m="${mv}" aria-pressed="${kind !== 'genre' && m === mv}"><small>${label}</small><b>${big(tri[i])}</b></button>`).join('') : ''}
      <div class="vtile"><small>Average per record</small><b>${money((tri ? tri[1] : sumMid) / (n || 1))}</b></div>
    </div>`;

    // breakdown by genre / style / label / decade, from today's typical price per record
    const [, dimFn] = DIMS[st.dim] || DIMS.genre;
    const groups = new Map();
    for (const x of priced) { const g = dimFn(x.r); const o = groups.get(g) || { v: 0, n: 0 }; o.v += mid(x); o.n++; groups.set(g, o); }
    let rows = [...groups.entries()].sort((a, b) => b[1].v - a[1].v);
    if (rows.length > 10 && !rows.slice(10).some(([g]) => g === st.pick)) {
      const rest = rows.slice(9).reduce((o, [, x]) => ({ v: o.v + x.v, n: o.n + x.n }), { v: 0, n: 0 });
      rows = [...rows.slice(0, 9), ['__other', rest]];
    }
    const top = rows.length ? rows[0][1].v : 1;
    const breakdown = rows.map(([g, x]) => {
      const name = g === '__other' ? `${groups.size - 9} more` : g;
      return `<button type="button" class="vbar${st.pick === g ? ' on' : ''}" data-g="${esc(g)}"${g === '__other' ? ' disabled' : ''}>
        <span class="vb-name">${esc(name)}<small>${x.n} record${x.n === 1 ? '' : 's'}</small></span>
        <span class="vb-track"><i style="width:${Math.max(1.5, (x.v / top) * 100).toFixed(1)}%"></i></span>
        <span class="vb-val">${big(x.v)}<small>${((x.v / (sumMid || 1)) * 100).toFixed(0)}%</small></span></button>`;
    }).join('');

    // records: worth the most, moved the most, or most copies for sale
    const startDate = first ? first.d : null;
    let list = all.filter((x) => !st.pick || dimFn(x.r) === st.pick);
    const chg = (x) => { if (mid(x) == null || !startDate) return null; const a = valueAt(x.p, startDate); return a == null ? null : mid(x) - a; };
    const sorters = {
      value: (a, b) => (mid(b) ?? -1) - (mid(a) ?? -1),
      up: (a, b) => (chg(b) ?? -1e9) - (chg(a) ?? -1e9),
      down: (a, b) => (chg(a) ?? 1e9) - (chg(b) ?? 1e9),
      cheap: (a, b) => (mid(a) ?? 1e9) - (mid(b) ?? 1e9),
      rare: (a, b) => ((a.p && a.p.n) ?? 1e9) - ((b.p && b.p.n) ?? 1e9),
    };
    list.sort(sorters[st.sort] || sorters.value);
    const recRow = (x, rank) => {
      const c = chg(x), p = x.p || {};
      const cover = A.cover(x.r);
      const sub = p.v ? (p.v[0] !== p.v[2] ? `${money(p.v[0], true)}–${money(p.v[2], true)}` : 'cheapest for sale') : p.t ? 'no sales or copies on Discogs' : 'not priced yet';
      return `<button type="button" class="vrec" data-id="${x.r.iid || x.r.id}">
        ${rank ? `<span class="vr-rank">${rank}</span>` : ''}
        ${cover ? `<img loading="lazy" src="${esc(cover)}" alt="">` : '<span class="nocover"></span>'}
        <span class="vr-t"><b>${esc(x.r.title)}</b><small>${esc(x.r.artist)}</small></span>
        <span class="vr-v"><b>${p.v ? money(p.v[1]) : '–'}</b><small>${c != null && Math.abs(c) >= 0.005 ? changeHtml(p.v[1], p.v[1] - c) : esc(sub)}</small></span></button>`;
    };
    const listHtml = list.slice(0, st.more ? undefined : 60).map((x) => recRow(x)).join('');

    // leaderboards: what went up, what went down, what's worth the most. Top 5, tap for more.
    const pctChg = (x) => { const c = chg(x); return c == null ? null : (c / Math.max(0.01, mid(x) - c)) * 100; };
    const by = st.lbBy === 'pct' ? pctChg : chg;
    const pool = list.filter((x) => mid(x) != null);
    const boards = [
      ['up', 'Biggest gainers', pool.filter((x) => (chg(x) ?? 0) >= 0.005).sort((a, b) => by(b) - by(a)), `No record has gone up ${changeLabel || 'yet'}.`],
      ['down', 'Biggest losers', pool.filter((x) => (chg(x) ?? 0) <= -0.005).sort((a, b) => by(a) - by(b)), `No record has gone down ${changeLabel || 'yet'}.`],
      ['value', 'Most valuable', pool.slice().sort((a, b) => mid(b) - mid(a)), 'No prices yet.'],
    ];
    const STEPS = [5, 10, 25, Infinity];
    const lbHtml = boards.map(([id, title, rows, none]) => {
      const n = lbShow[id] || 5;
      const next = STEPS.find((x) => x > n);
      const more = rows.length > n
        ? `<button type="button" class="linkish vlb-more" data-lb="${id}" data-n="${next >= rows.length ? 'all' : next}">${next >= rows.length ? `Show all ${rows.length}` : `Show top ${next}`}</button>`
        : n > 5 && rows.length > 5 ? `<button type="button" class="linkish vlb-more" data-lb="${id}" data-n="5">Show top 5</button>` : '';
      return `<div class="vlb"><div class="vlb-h"><h3>${esc(title)}</h3><small>${id === 'value' ? 'today' : esc(changeLabel || 'since the first snapshot')}</small></div>
        ${rows.length ? `<div class="vrecs">${rows.slice(0, n).map((x, i) => recRow(x, i + 1)).join('')}</div>` : `<p class="vlb-none">${esc(none)}</p>`}
        ${more}</div>`;
    }).join('');

    const seriesSeg = k.discogs && k.est && kind !== 'genre'
      ? SEG('series', [['discogs', 'Discogs', 'Discogs\' own collection value'], ['est', 'By record', 'The sum of each record\'s own price']], kind) : '';
    const showSeg = SEG('show', [['value', 'Value', 'What the collection is worth'], ['pl', 'Profit / loss', 'Gains or losses since tracking began, without the jump from records you add']], isPL ? 'pl' : 'value');
    const measureSeg = kind !== 'genre' ? SEG('measure', MEASURES.map(([v, l, t]) => [v, l, t]), m) : '';
    const plNote = isPL ? `<p class="vnote">Profit / loss leaves out what new records add: each one counts from what it was worth the day Crate first priced it${pl.withCost ? `, or from what you paid for the ${pl.withCost} record${pl.withCost === 1 ? '' : 's'} with a price paid on Discogs` : ''}. ${pl.added ? `${pl.added} record${pl.added === 1 ? '' : 's'} came in since tracking began. ` : ''}${pl.withCost ? '' : 'To count what you paid instead, add a collection field called “Price paid” on Discogs, or write “paid 12” in a record\'s Notes. '}${kind === 'discogs' ? 'Discogs doesn\'t say what one record adds to its totals, so a new record counts at its own price, scaled to Discogs\' totals.' : ''}</p>` : '';

    root.innerHTML = `
      <section class="vhero">
        <div class="vh-l"><small id="vh-label">${esc(headLabel)}</small>
          <div class="vh-num${numCls(last)}" id="vh-num">${numTxt(last)}</div>
          <div class="vh-chg" id="vh-chg">${last && first && first !== last ? chgTxt(last, first, changeLabel) : '<span class="vchg-l">Change shows from the second daily snapshot</span>'}</div></div>
        ${SEG('range', RANGES.map(([v]) => [v, v === 'All' ? 'All' : v]), st.range)}
      </section>
      <div class="vchart-box" id="vchart"></div>
      <p class="vnote">${V.since ? `Tracking since ${esc(fmtDate(V.since))}. ` : ''}Discogs keeps no price history, so the line starts from Crate's first daily snapshot. ${st.pick ? `<button type="button" class="linkish" id="vclear">Show the whole collection</button>` : ''}</p>
      <div class="vseries">${showSeg}${measureSeg}${seriesSeg}</div>
      ${plNote}
      ${tiles}
      <section class="vsec"><div class="vsec-h"><h2>Leaderboards${st.pick ? ` <small>${esc(st.pick)}</small>` : ''}</h2>${SEG('lbBy', [['eur', 'By amount'], ['pct', 'By %']], st.lbBy === 'pct' ? 'pct' : 'eur')}</div>
        <div class="vlbs">${lbHtml}</div></section>
      <section class="vsec"><div class="vsec-h"><h2>Breakdown</h2>${SEG('dim', Object.entries(DIMS).map(([v, [l]]) => [v, l]), st.dim)}</div>
        <div class="vbars">${breakdown || '<p class="empty">No prices yet.</p>'}</div>
        ${st.dim === 'genre' ? '<p class="vnote">Each record counts once, under its first genre on Discogs. Tap a genre to see its own line and records.</p>' : '<p class="vnote">Each record counts once, under its first ' + esc(DIMS[st.dim][0].toLowerCase()) + '. Tap one to list its records.</p>'}</section>
      <section class="vsec"><div class="vsec-h"><h2>${st.pick ? esc(st.pick) : 'All records'} <small>${list.length}</small></h2>
        <div class="filters vsort"><label class="f keep"><span>Sort</span><select id="vsort">${[['value', 'Worth the most'], ['up', `Gained most (${st.range})`], ['down', `Lost most (${st.range})`], ['cheap', 'Worth the least'], ['rare', 'Fewest for sale']].map(([v, l]) => `<option value="${v}"${st.sort === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label></div></div>
        <div class="vrecs">${listHtml}</div>
        ${list.length > 60 && !st.more ? `<button class="more" id="vmore">Show all ${list.length}</button>` : ''}</section>
      <p class="vnote vsrc">Prices from the Discogs marketplace${latest.dmed == null ? '. Add a Discogs token (see Settings) for Discogs\' own minimum, median and maximum and prices by condition' : ''}. Typical = suggested price for a Very Good Plus copy; range = Very Good to Near Mint. Data provided by Discogs.</p>`;

    const box = $('#vchart');
    const draw = () => {
      box.innerHTML = chartSvg(pts, kind, Math.max(240, Math.round(box.clientWidth)), isPL);
      const num = $('#vh-num');
      const show = (p) => { num.textContent = numTxt(p); num.className = 'vh-num' + numCls(p); };
      wireChart(box, pts, (p) => {
        if (!p) { show(last); $('#vh-chg').innerHTML = last && first && first !== last ? chgTxt(last, first, changeLabel) : ''; return; }
        show(p);
        $('#vh-chg').innerHTML = `${p !== first ? chgTxt(p, first) + ' ' : ''}<span class="vchg-l">${esc(fmtDate(p.d))}</span>`;
      });
    };
    draw();
    render._ro && render._ro.disconnect();
    let lastW = box.clientWidth;
    render._ro = new ResizeObserver(() => { if (Math.abs(box.clientWidth - lastW) > 4) { lastW = box.clientWidth; draw(); } });
    render._ro.observe(box);

    $$('[data-seg]', root).forEach((seg) => $$('button', seg).forEach((b) => (b.onclick = () => {
      const name = seg.dataset.seg;
      if (name === 'dim' && st.dim !== b.dataset.v) st.pick = '';
      st[name] = b.dataset.v;
      save(); render();
    })));
    $$('.vtile[data-m]', root).forEach((b) => (b.onclick = () => { st.measure = b.dataset.m; save(); render(); }));
    $$('.vbar', root).forEach((b) => (b.onclick = () => { st.pick = st.pick === b.dataset.g ? '' : b.dataset.g; st.more = false; render(); }));
    if ($('#vclear')) $('#vclear').onclick = () => { st.pick = ''; render(); };
    $('#vsort').onchange = (e) => { st.sort = e.target.value; save(); render(); };
    $$('.vlb-more', root).forEach((b) => (b.onclick = () => { lbShow[b.dataset.lb] = b.dataset.n === 'all' ? Infinity : +b.dataset.n; render(); }));
    if ($('#vmore')) $('#vmore').onclick = () => { st.more = true; render(); };
    $$('.vrec', root).forEach((b) => (b.onclick = () => A.openRecord(A.releases().find((r) => String(r.iid || r.id) === b.dataset.id))));
  }

  // ---------- the record page: what this copy is worth ----------
  const GRADES = ['M', 'NM', 'VG+', 'VG', 'G+', 'G', 'F', 'P'];
  function sparkSvg(h) {
    if (!h || h.length < 2) return '';
    const w = 120, ht = 30;
    const vs = h.map((x) => x[1]), mn = Math.min(...vs), mx = Math.max(...vs) || 1;
    const t0 = dateOf(h[0][0]).getTime(), t1 = dateOf(h[h.length - 1][0]).getTime() || t0 + 1;
    const d = h.map(([dt, v], i) => `${i ? 'L' : 'M'}${(((dateOf(dt).getTime() - t0) / (t1 - t0 || 1)) * w).toFixed(1)},${(3 + (1 - (v - mn) / (mx - mn || 1)) * (ht - 6)).toFixed(1)}`).join('');
    return `<svg class="vspark" viewBox="0 0 ${w} ${ht}" width="${w}" height="${ht}" aria-hidden="true"><path d="${d}"/></svg>`;
  }
  function recordHtml(r) {
    if (!V) { load().then(() => { const slot = document.getElementById('rec-value'); if (slot && slot.dataset.id === String(r.id)) slot.outerHTML = recordHtml(r); }); return `<div id="rec-value" data-id="${r.id}"></div>`; }
    const p = V.records[String(r.id)];
    if (!p) return `<div id="rec-value" data-id="${r.id}"></div>`;
    const sell = `https://www.discogs.com/sell/release/${r.id}`;
    const h = p.h || [];
    const since = h.length > 1 ? changeHtml(p.v[1], h[0][1], `since ${fmtDate(h[0][0], false)}`) : '';
    const grades = p.s ? GRADES.filter((g) => p.s[g]).map((g) => `<span><small>${g}</small>${money(p.s[g])}</span>`).join('') : '';
    return `<section id="rec-value" class="rec-value" data-id="${r.id}"><h3>Value <small>Discogs marketplace, checked ${esc(fmtDate(p.t))}</small></h3>
      <div class="rv-row">${p.v ? `<div><small>Typical</small><b>${money(p.v[1])}</b></div>${p.v[0] !== p.v[2] ? `<div><small>Range</small><b>${money(p.v[0], true)}–${money(p.v[2], true)}</b></div>` : ''}` : '<div><small>Value</small><b>No sales yet</b></div>'}
        <div><small>For sale</small><b><a href="${esc(sell)}" target="_blank" rel="noopener">${p.n ? `${p.n} from ${money(p.low)}` : 'None'}</a></b></div>
        ${h.length > 1 ? `<div class="rv-spark">${sparkSvg(h)}<small>${since}</small></div>` : ''}</div>
      ${grades ? `<div class="rv-grades">${grades}</div>` : ''}</section>`;
  }

  window.CrateValue = { render, recordHtml, load };
  load(); // small file; record pages show their value straight away
})();
