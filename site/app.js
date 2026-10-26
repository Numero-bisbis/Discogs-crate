/* Crate: browse a Discogs collection and plan vinyl mixes. No build step, no framework. */
(function () {
  'use strict';
  const C = window.Camelot;
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '');
  const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // Pitch fader move in whole percent; under half a percent you just nudge the platter.
  const fmtPitch = (pct) => { const r = Math.round(pct); return r === 0 ? 'no pitch change' : `pitch ${r > 0 ? '+' : '−'}${Math.abs(r)}%`; };
  const uid = () => Math.random().toString(36).slice(2, 10);

  // ---------- persistent state (this browser, optionally mirrored to GitHub) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('crate.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('crate.' + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  };
  const user = store.get('user', { overrides: {}, mixes: [], updated: 0 });
  const settings = store.get('settings', { pitchRange: 8, ghToken: '', ghRepo: '' });
  let currentMixId = store.get('currentMix', null);
  // Older versions kept generated drafts inside the mixes list; treat those as saved mixes now.
  user.mixes.forEach((m) => delete m.draft);
  user.pairs = user.pairs || {}; // your 👍/👎 on transitions: 'trackA|trackB' -> 1 or -1

  function saveUser() {
    user.updated = Date.now();
    store.set('user', user);
    scheduleRemoteSave();
  }

  // ---------- data ----------
  let DATA = { releases: [] };
  let TRACKS = []; // flattened with release reference
  const byKey = new Map();

  function eff(t) {
    const o = user.overrides[t.k] || {};
    return {
      bpm: o.bpm ?? t.bpm ?? null,
      key: o.key ?? t.key ?? null,
      cam: o.cam ?? t.cam ?? null,
      edited: !!(o.bpm || o.cam),
      src: o.bpm || o.cam ? 'manual' : t.src || 'pending',
    };
  }

  // Where a BPM/key value came from, as [short tag, explanation].
  const SRC = {
    acousticbrainz: ['DB', 'From the AcousticBrainz music database (full-track analysis)'],
    'deezer-preview': ['est.', 'Estimated from a 30-second preview; check by ear'],
    manual: ['you', 'Your own edit'],
    none: ['none', 'Looked up, nothing found: add it by hand'],
    pending: ['…', 'Not looked up yet; it will be within a day'],
  };
  const srcTag = (e) => { const [tag, why] = SRC[e.src] || SRC.pending; return `<span class="src src-${tag === '…' ? 'pending' : tag === 'est.' ? 'est' : tag}" title="${esc(why)}">${tag}</span>`; };

  function index() {
    TRACKS = [];
    byKey.clear();
    for (const r of DATA.releases) {
      r._search = norm([r.artist, r.title, r.year, r.format, ...r.labels.map((l) => l.name + ' ' + l.catno), ...r.genres, ...r.styles].join(' '));
      for (const t of r.tracks) {
        t.r = r;
        t._search = norm([t.artist, t.title, r.artist, r.title, ...r.labels.map((l) => l.name + ' ' + l.catno), ...r.styles].join(' '));
        TRACKS.push(t);
        byKey.set(t.k, t);
      }
    }
  }

  function facet(list, fn) {
    const m = new Map();
    for (const x of list) for (const v of fn(x)) if (v) m.set(v, (m.get(v) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(b[0]));
  }

  const CAMS = [];
  for (let n = 1; n <= 12; n++) for (const l of 'AB') CAMS.push(n + l);

  const camOptions = () => CAMS.map((c) => [c, null, `${c} · ${C.camToKey(c)}`]);

  // ---------- UI helpers ----------
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    requestAnimationFrame(() => t.classList.add('show'));
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.classList.remove('show'); toast._t = setTimeout(() => (t.hidden = true), 250); }, 2200);
  }

  // On phones the filters fold away behind a button; this is its open/closed state per list.
  const filtersOpen = new Set();
  function filterHead(id, f, keys) {
    const n = keys.filter((k) => f[k]).length;
    return `<div class="fhead"><button type="button" class="ftoggle${n ? ' on' : ''}" aria-expanded="${filtersOpen.has(id)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/></svg>Filters${n ? ` <span class="badge">${n}</span>` : ''}</button>${n ? '<button type="button" class="fclear">Clear</button>' : ''}</div>`;
  }
  function wireFilterHead(id, f, keys, rerender) {
    const box = document.getElementById(id);
    box.classList.toggle('open', filtersOpen.has(id));
    $('.ftoggle', box).onclick = () => { filtersOpen.has(id) ? filtersOpen.delete(id) : filtersOpen.add(id); box.classList.toggle('open'); $('.ftoggle', box).setAttribute('aria-expanded', filtersOpen.has(id)); };
    const clear = $('.fclear', box);
    if (clear) clear.onclick = () => { keys.forEach((k) => delete f[k]); rerender(); };
  }

  function select(name, label, options, value, allLabel = 'All') {
    return `<label class="f"><span>${label}</span><select data-f="${name}"><option value="">${allLabel}</option>${options
      .map(([v, n, label]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(label || v)}${n != null ? ` (${n})` : ''}</option>`)
      .join('')}</select></label>`;
  }

  function camBadge(cam, key) {
    if (!cam) return '<span class="cam none">–</span>';
    const p = C.parseCam(cam);
    return `<span class="cam" style="--h:${((p.n - 1) * 30 + 200) % 360}" title="${esc(key || C.camToKey(cam))}">${esc(cam)}</span>`;
  }

  // ---------- snippets ----------
  // ▶ is a quick 30-second preview for recognising a track: Deezer (the match found during sync,
  // else a live search), then Apple Music. The YouTube button plays the full video linked on
  // Discogs, or searches YouTube when there isn't one.
  const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
  const PAUSE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13M16 5.5v13" stroke-width="3.2"/></svg>';
  const YT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="5.5" width="19" height="13" rx="3.5"/><path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor" stroke="none"/></svg>';
  const SEARCH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>';
  const ytSearch = (t) => `https://www.youtube.com/results?search_query=${encodeURIComponent(`${t.artist} ${t.title}`)}`;
  function playBtn(t) {
    const on = playing === 'p:' + t.k;
    const quick = `<button class="play${on ? ' on' : ''}" data-play="${esc(t.k)}" title="Quick listen (30 s preview)" aria-label="Preview ${esc(t.title)}">${on ? PAUSE_SVG : PLAY_SVG}</button>`;
    const video = t.yt
      ? `<button class="ytb${playing === 'v:' + t.k ? ' on' : ''}" data-yt="${esc(t.k)}" title="Watch the YouTube video linked on Discogs" aria-label="YouTube video of ${esc(t.title)}">${YT_SVG}</button>`
      : `<a class="ytb none" href="${ytSearch(t)}" target="_blank" rel="noopener" title="Search YouTube" aria-label="Search YouTube for ${esc(t.title)}">${SEARCH_SVG}</a>`;
    return `<span class="snips">${quick}${video}</span>`;
  }

  // Deezer's and Apple's search APIs have no CORS headers, but both answer JSONP.
  function jsonp(url) {
    return new Promise((resolve, reject) => {
      const cb = 'crateCb' + uid(), s = document.createElement('script');
      const done = () => { delete window[cb]; s.remove(); clearTimeout(timer); };
      const timer = setTimeout(() => { done(); reject(new Error('timeout')); }, 7000);
      window[cb] = (j) => { done(); resolve(j); };
      s.onerror = () => { done(); reject(new Error('blocked')); };
      s.src = `${url}${url.includes('?') ? '&' : '?'}callback=${cb}`;
      document.head.appendChild(s);
    });
  }
  const words = (x) => norm(x).replace(/[([].*?[)\]]/g, ' ').match(/[a-z0-9]+/g) || [];
  // Best search hit whose title (and artist, unless it's a compilation) looks like this track.
  function pickHit(t, hits, title, artist) {
    const tw = words(t.title), aw = words(t.artist).filter((w) => w.length > 2);
    const various = /^various/i.test(t.artist);
    let best = null, bestScore = 0;
    for (const h of hits || []) {
      const hw = new Set(words(title(h))), ha = norm(artist(h));
      const score = tw.length ? tw.filter((w) => hw.has(w)).length / tw.length : 0;
      if (score < 0.6 || (!various && aw.length && !aw.some((w) => ha.includes(w)))) continue;
      if (score > bestScore) { best = h; bestScore = score; }
    }
    return best;
  }
  const previews = new Map(); // track key -> {url, from} | null, for this visit
  async function findPreview(t) {
    if (previews.has(t.k)) return previews.get(t.k);
    const q = `${t.artist.replace(/^various.*/i, '')} ${t.title.replace(/\s*[([].*?[)\]]/g, '')}`.trim();
    let found = null;
    if (t.dz) {
      try { const j = await jsonp(`https://api.deezer.com/track/${encodeURIComponent(t.dz)}?output=jsonp`); if (j.preview) found = { url: j.preview, from: 'Deezer' }; } catch { /* try search */ }
    }
    if (!found) {
      try {
        const j = await jsonp(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=15&output=jsonp`);
        const h = pickHit(t, j.data, (x) => x.title, (x) => x.artist && x.artist.name);
        if (h && h.preview) found = { url: h.preview, from: 'Deezer' };
      } catch { /* try Apple */ }
    }
    if (!found) {
      try {
        const j = await jsonp(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=15`);
        const h = pickHit(t, j.results, (x) => x.trackName, (x) => x.artistName);
        if (h && h.previewUrl) found = { url: h.previewUrl, from: 'Apple Music' };
      } catch { /* nothing found */ }
    }
    previews.set(t.k, found);
    return found;
  }

  let playing = null; // 'p:<track>' preview, 'v:<track>' track video, 'v:<video id>' other video
  // One audio element for the whole visit: once a tap has started it, iOS lets it play again later.
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.setAttribute('playsinline', '');
  const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
  function markPlaying() {
    $$('[data-play], [data-yt], [data-video]').forEach((b) => {
      const key = b.dataset.play ? 'p:' + b.dataset.play : 'v:' + (b.dataset.yt || b.dataset.video);
      b.classList.toggle('on', key === playing);
      if (b.dataset.play) b.innerHTML = key === playing ? PAUSE_SVG : PLAY_SVG;
    });
  }
  function showPlayer(key, title, sub, more) {
    const p = $('#player');
    $('.pl-info b', p).textContent = title;
    $('.pl-info small', p).textContent = sub;
    const m = $('.pl-more', p);
    m.hidden = !more;
    if (more) { m.href = more.href; m.textContent = more.label; }
    p.hidden = false;
    document.body.classList.add('has-player');
    requestAnimationFrame(() => p.classList.add('show'));
    playing = key;
    markPlaying();
  }
  function closePlayer() {
    const p = $('#player');
    audio.pause();
    p.classList.remove('show');
    $('.pl-media', p).innerHTML = '';
    p.hidden = true;
    document.body.classList.remove('has-player');
    playing = null;
    markPlaying();
  }
  function playVideo(key, id, title, sub) {
    if (playing === key) { closePlayer(); return; }
    audio.pause();
    showPlayer(key, title, sub + ' · YouTube', { href: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, label: 'Open in YouTube ↗' });
    $('#player .pl-media').innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&playsinline=1&rel=0&modestbranding=1" title="YouTube video" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
  }
  async function previewTrack(k) {
    const t = byKey.get(k);
    if (!t) return;
    const key = 'p:' + k;
    if (playing === key) { closePlayer(); return; }
    const sub = `${t.artist} · ${t.r.title} · ${t.pos}`;
    const more = t.yt ? { href: `https://www.youtube.com/watch?v=${t.yt}`, label: 'Video ↗' } : { href: ytSearch(t), label: 'YouTube ↗' };
    showPlayer(key, t.title, sub + ' · finding a preview…', more);
    const media = $('#player .pl-media');
    media.innerHTML = '';
    media.appendChild(audio);
    // Start playback inside the tap (silently) so iOS allows the real preview once it's found.
    audio.src = SILENT;
    audio.play().catch(() => {});
    const found = await findPreview(t);
    if (playing !== key) return;
    if (found) {
      $('#player .pl-info small').textContent = `${sub} · ${found.from} preview`;
      audio.src = found.url;
      audio.play().catch(() => {});
    } else {
      audio.pause();
      $('#player .pl-info small').textContent = sub;
      media.innerHTML = `<p class="sub">No preview found for this one.${t.yt ? ' Tap the YouTube button to watch the video.' : ` <a href="${ytSearch(t)}" target="_blank" rel="noopener">Search YouTube ↗</a>`}</p>`;
    }
  }

  function relClass(score) {
    if (score === null || score === undefined) return 'unk';
    return score >= 0.85 ? 'good' : score >= 0.5 ? 'ok' : 'bad';
  }

  // ---------- views ----------
  let view = 'records';
  function setView(v) {
    view = v;
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    $$('.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + v));
    $('.search-wrap').hidden = !['records', 'tracks'].includes(v);
    document.body.dataset.view = v;
    $('#ltitle').textContent = { records: 'Records', tracks: 'Tracks', generate: 'Generate', mixes: 'My mixes', settings: 'Settings' }[v];
    render();
    window.scrollTo(0, 0);
    try { history.replaceState(null, '', '#' + v); } catch { /* sandboxed */ }
  }

  function render() {
    if (view === 'records') renderRecords();
    else if (view === 'tracks') renderTracks();
    else if (view === 'mixes') renderMixes();
    else if (view === 'generate') renderGenerate();
    else renderSettings();
  }

  // ----- Records -----
  const rf = store.get('rf', { sort: 'added' });
  function renderRecords() {
    const q = norm($('#search').value);
    let list = DATA.releases.filter((r) =>
      (!q || q.split(/\s+/).every((w) => r._search.includes(w))) &&
      (!rf.genre || r.genres.includes(rf.genre)) &&
      (!rf.style || r.styles.includes(rf.style)) &&
      (!rf.label || r.labels.some((l) => l.name === rf.label)) &&
      (!rf.folder || r.folder === rf.folder) &&
      (!rf.decade || (r.year && String(Math.floor(r.year / 10) * 10) === rf.decade)) &&
      (!(rf.bpmMin || rf.bpmMax || rf.cam) || r.tracks.some((t) => {
        const e = eff(t);
        return (!rf.bpmMin || e.bpm >= +rf.bpmMin) && (!rf.bpmMax || e.bpm <= +rf.bpmMax) && (!rf.cam || e.cam === rf.cam);
      })));
    const sorters = {
      added: (a, b) => String(b.added).localeCompare(String(a.added)),
      artist: (a, b) => a.artist.localeCompare(b.artist) || (a.year || 0) - (b.year || 0),
      title: (a, b) => a.title.localeCompare(b.title),
      year: (a, b) => (b.year || 0) - (a.year || 0),
      yearAsc: (a, b) => (a.year || 9999) - (b.year || 9999),
      label: (a, b) => (a.labels[0]?.name || '').localeCompare(b.labels[0]?.name || '') || (a.labels[0]?.catno || '').localeCompare(b.labels[0]?.catno || '', undefined, { numeric: true }),
      rating: (a, b) => b.rating - a.rating,
    };
    list.sort(sorters[rf.sort] || sorters.added);

    const all = DATA.releases;
    const folders = facet(all, (r) => [r.folder]).filter(([f]) => f && f !== 'Uncategorized');
    const RK = ['genre', 'style', 'label', 'decade', 'folder', 'bpmMin', 'bpmMax', 'cam'];
    $('#record-filters').innerHTML = filterHead('record-filters', rf, RK) +
      select('genre', 'Genre', facet(all, (r) => r.genres), rf.genre) +
      select('style', 'Style', facet(all, (r) => r.styles), rf.style) +
      select('label', 'Label', facet(all, (r) => r.labels.map((l) => l.name)), rf.label) +
      select('decade', 'Decade', facet(all, (r) => [r.year ? String(Math.floor(r.year / 10) * 10) : null]).sort((a, b) => b[0] - a[0]), rf.decade) +
      (folders.length ? select('folder', 'Folder', folders, rf.folder) : '') +
      `<label class="f"><span>BPM</span><span class="range"><input data-f="bpmMin" value="${esc(rf.bpmMin || '')}" placeholder="min" inputmode="numeric">–<input data-f="bpmMax" value="${esc(rf.bpmMax || '')}" placeholder="max" inputmode="numeric"></span></label>` +
      select('cam', 'Key', camOptions(), rf.cam, 'Any') +
      `<label class="f keep"><span>Sort</span><select data-f="sort">${[['added', 'Recently added'], ['artist', 'Artist'], ['title', 'Title'], ['year', 'Year (new → old)'], ['yearAsc', 'Year (old → new)'], ['label', 'Label / cat no.'], ['rating', 'My rating']]
        .map(([v, n]) => `<option value="${v}"${rf.sort === v ? ' selected' : ''}>${n}</option>`).join('')}</select></label>` +
      `<span class="count">${list.length} of ${all.length} records</span>`;
    $$('#record-filters select, #record-filters input').forEach((s) => (s.onchange = () => { rf[s.dataset.f] = s.value; store.set('rf', rf); renderRecords(); }));
    wireFilterHead('record-filters', rf, RK, () => { store.set('rf', rf); renderRecords(); });

    $('#record-grid').innerHTML = list.length
      ? list.map((r) => `<button class="card" data-id="${r.iid || r.id}">
          <div class="cover">${r.cover && !/spacer\.gif/.test(r.cover) ? `<img loading="lazy" src="${esc(r.cover)}" alt="">` : '<div class="nocover"></div>'}</div>
          <div class="meta"><b>${esc(r.title)}</b><span>${esc(r.artist)}</span><small>${esc([r.labels[0]?.name, r.labels[0]?.catno, r.year].filter(Boolean).join(' · '))}</small></div>
        </button>`).join('')
      : `<p class="empty">${DATA.releases.length ? 'No records match these filters.' : 'No records yet. The first sync fills this in.'}</p>`;
    $$('#record-grid .card').forEach((c) => (c.onclick = () => openRecord(DATA.releases.find((r) => String(r.iid || r.id) === c.dataset.id))));
  }

  function openRecord(r) {
    const mix = currentMix();
    const rows = r.tracks.map((t) => {
      const e = eff(t);
      return `<tr data-k="${esc(t.k)}"><td class="pos">${esc(t.pos)}</td><td><div class="tt">${playBtn(t)}<div><b>${esc(t.title)}</b>${t.artist !== r.artist ? `<br><small>${esc(t.artist)}</small>` : ''}</div></div></td>
        <td class="num">${fmtDur(t.dur)}</td>
        <td class="num"><input class="bpm-in" value="${e.bpm ?? ''}" placeholder="BPM" inputmode="numeric"></td>
        <td><input class="key-in" value="${e.cam ?? ''}" placeholder="Key" title="${esc(e.key || 'Type 8A, Am, F#m…')}"></td><td>${srcTag(e)}</td>
        <td><button class="small add" title="Add to ${esc(mix ? mix.name : 'a new mix')}">+ Mix</button></td></tr>`;
    }).join('');
    $('#drawer-body').innerHTML = `
      ${r.cover ? `<div class="rec-bg" style="background-image:url('${esc(r.cover)}')"></div>` : ''}
      <div class="rec-head">${r.cover ? `<img src="${esc(r.cover)}" alt="">` : '<div class="nocover rec-nocover"></div>'}<div>
        <h2>${esc(r.title)}</h2><p class="artist">${esc(r.artist)}</p>
        <p>${esc(r.labels.map((l) => `${l.name} – ${l.catno}`).join(', '))}</p>
        <p>${esc([r.format, r.country, r.year].filter(Boolean).join(' · '))}</p>
        <p class="tags">${[...r.genres, ...r.styles].map((g) => `<span>${esc(g)}</span>`).join('')}</p>
        <p><a class="ext" href="${esc(r.url)}" target="_blank" rel="noopener">Open on Discogs ↗</a></p></div></div>
      <div class="table-wrap"><table class="tl"><thead><tr><th>Pos</th><th>Track</th><th>Time</th><th>BPM</th><th>Key</th><th>From</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7">No tracklist yet.</td></tr>'}</tbody></table></div>
      <p class="hint">From: <b>DB</b> = AcousticBrainz database, <b>est.</b> = estimated from a 30-second preview, <b>you</b> = your edit, <b>none</b> = nothing found, <b>…</b> = not looked up yet. Type over any value to fix it.</p>
      ${r.vids && r.vids.length ? `<h3>More videos <small>from this record's Discogs page</small></h3><div class="vids">${r.vids.map(([id, title]) => `<button class="vid" data-video="${esc(id)}" data-title="${esc(title)}" data-sub="${esc(r.artist + ' · ' + r.title)}">${PLAY_SVG}<span>${esc(title)}</span></button>`).join('')}</div>` : ''}`;
    wireEdits($('#drawer-body'));
    openDrawer(r.title);
  }

  function wireEdits(root) {
    $$('tr[data-k]', root).forEach((tr) => {
      const k = tr.dataset.k;
      const bpm = $('.bpm-in', tr), key = $('.key-in', tr), add = $('.add', tr);
      if (bpm) bpm.onchange = () => setOverride(k, { bpm: bpm.value }) || (bpm.value = eff(byKey.get(k)).bpm ?? '');
      if (key) key.onchange = () => {
        if (!setOverride(k, { key: key.value })) toast('Use a key like 8A, Am or F#m');
        key.value = eff(byKey.get(k)).cam ?? '';
      };
      if (add) add.onclick = () => addToMix(k);
    });
  }

  function setOverride(k, { bpm, key }) {
    const o = { ...(user.overrides[k] || {}) };
    if (bpm !== undefined) {
      const v = parseFloat(String(bpm).replace(',', '.'));
      if (String(bpm).trim() === '') delete o.bpm;
      else if (v > 30 && v < 300) o.bpm = Math.round(v);
      else return false;
    }
    if (key !== undefined) {
      if (String(key).trim() === '') { delete o.cam; delete o.key; }
      else { const p = C.parseKey(key); if (!p) return false; o.cam = p.cam; o.key = p.key; }
    }
    if (Object.keys(o).length) user.overrides[k] = o; else delete user.overrides[k];
    saveUser();
    toast('Saved');
    return true;
  }

  // ----- Tracks -----
  const tf = store.get('tf', { sort: 'artist', dir: 1 });
  let trackLimit = 300;
  function trackMatches(t, q) {
    const e = eff(t), r = t.r;
    if (q && !q.split(/\s+/).every((w) => t._search.includes(w))) return false;
    if (tf.genre && !r.genres.includes(tf.genre)) return false;
    if (tf.style && !r.styles.includes(tf.style)) return false;
    if (tf.bpmMin && !(e.bpm >= +tf.bpmMin)) return false;
    if (tf.bpmMax && !(e.bpm <= +tf.bpmMax)) return false;
    if (tf.cam && e.cam !== tf.cam) return false;
    if (tf.compat) { const rel = C.camRelation(tf.compat, e.cam); if (!(rel.score >= 0.85)) return false; }
    if (tf.has === 'bpm' && !e.bpm) return false;
    if (tf.has === 'missing' && e.bpm && e.cam) return false;
    if (tf.has === 'edited' && !e.edited) return false;
    if (tf.has === 'notfound' && e.src !== 'none') return false;
    if (tf.has === 'pending' && e.src !== 'pending') return false;
    if (tf.has === 'est' && e.src !== 'deezer-preview') return false;
    return true;
  }

  function renderTracks() {
    const q = norm($('#search').value);
    const list = TRACKS.filter((t) => trackMatches(t, q));
    const col = {
      artist: (t) => norm(t.artist), title: (t) => norm(t.title), record: (t) => norm(t.r.title),
      pos: (t) => t.pos, bpm: (t) => eff(t).bpm ?? (tf.dir > 0 ? 1e9 : -1),
      key: (t) => { const p = C.parseCam(eff(t).cam); return p ? p.n * 2 + (p.l === 'B') : (tf.dir > 0 ? 1e9 : -1); },
      src: (t) => eff(t).src, year: (t) => t.r.year || 0, label: (t) => norm(t.r.labels[0]?.name), dur: (t) => t.dur || 0,
    }[tf.sort] || ((t) => norm(t.artist));
    list.sort((a, b) => { const x = col(a), y = col(b); return (x < y ? -1 : x > y ? 1 : 0) * tf.dir || a.k.localeCompare(b.k); });

    const allCams = camOptions();
    const TK = ['genre', 'style', 'bpmMin', 'bpmMax', 'cam', 'compat', 'has'];
    $('#track-filters').innerHTML = filterHead('track-filters', tf, TK) +
      select('genre', 'Genre', facet(DATA.releases, (r) => r.genres), tf.genre) +
      select('style', 'Style', facet(DATA.releases, (r) => r.styles), tf.style) +
      `<label class="f"><span>BPM</span><span class="range"><input data-f="bpmMin" value="${esc(tf.bpmMin || '')}" placeholder="min" inputmode="numeric">–<input data-f="bpmMax" value="${esc(tf.bpmMax || '')}" placeholder="max" inputmode="numeric"></span></label>` +
      select('cam', 'Key', allCams.map(([c]) => [c, null]), tf.cam, 'Any') +
      select('compat', 'Mixes with', allCams.map(([c]) => [c, null]), tf.compat, 'Any') +
      `<label class="f"><span>Show</span><select data-f="has">${[['', 'All tracks'], ['bpm', 'With BPM'], ['missing', 'Missing BPM/key'], ['notfound', 'Not found'], ['pending', 'Not looked up yet'], ['est', 'Estimated (check by ear)'], ['edited', 'My edits']]
        .map(([v, n]) => `<option value="${v}"${(tf.has || '') === v ? ' selected' : ''}>${n}</option>`).join('')}</select></label>` +
      `<span class="count">${list.length} tracks</span>`;
    $$('#track-filters select, #track-filters input').forEach((s) => (s.onchange = () => { tf[s.dataset.f] = s.value; store.set('tf', tf); trackLimit = 300; renderTracks(); }));
    wireFilterHead('track-filters', tf, TK, () => { store.set('tf', tf); trackLimit = 300; renderTracks(); });

    const head = [['pos', 'Pos'], ['title', 'Track'], ['artist', 'Artist'], ['record', 'Record'], ['bpm', 'BPM'], ['key', 'Key'], ['src', 'From'], ['dur', 'Time'], ['year', 'Year'], ['label', 'Label']];
    const mix = currentMix();
    $('#track-table').innerHTML = `<thead><tr>${head.map(([k, n]) => `<th data-s="${k}" class="${tf.sort === k ? (tf.dir > 0 ? 'asc' : 'desc') : ''}">${n}</th>`).join('')}<th></th></tr></thead><tbody>${list
      .slice(0, trackLimit)
      .map((t) => {
        const e = eff(t);
        return `<tr data-k="${esc(t.k)}"><td class="pos">${esc(t.pos)}</td><td><div class="tt">${playBtn(t)}<div><b>${esc(t.title)}</b><small class="m-only">${esc(t.artist)}</small><small class="s-only"><a href="#" class="rec">${esc(t.r.title)}</a> · ${esc(t.pos)} ${srcTag(e)}</small></div></div></td><td>${esc(t.artist)}</td>
          <td><a href="#" class="rec">${esc(t.r.title)}</a></td>
          <td class="num"><input class="bpm-in${e.edited ? ' edited' : ''}" value="${e.bpm ?? ''}" inputmode="numeric"></td>
          <td><input class="key-in${e.edited ? ' edited' : ''}" value="${e.cam ?? ''}" title="${esc(e.key || 'Type 8A, Am, F#m…')}"></td><td>${srcTag(e)}</td>
          <td class="num">${fmtDur(t.dur)}</td><td class="num">${t.r.year || ''}</td><td>${esc(t.r.labels[0]?.name || '')}</td>
          <td><button class="small add" title="Add to ${esc(mix ? mix.name : 'a new mix')}">+</button></td></tr>`;
      }).join('')}</tbody>`;
    $$('#track-table th[data-s]').forEach((th) => (th.onclick = () => { tf.dir = tf.sort === th.dataset.s ? -tf.dir : 1; tf.sort = th.dataset.s; store.set('tf', tf); renderTracks(); }));
    $$('#track-table a.rec').forEach((a) => (a.onclick = (ev) => { ev.preventDefault(); openRecord(byKey.get(a.closest('tr').dataset.k).r); }));
    wireEdits($('#track-table'));
    const more = $('#track-more');
    more.hidden = list.length <= trackLimit;
    more.textContent = `Show more (${list.length - trackLimit} hidden)`;
    more.onclick = () => { trackLimit += 500; renderTracks(); };
  }

  // ----- Mixes -----
  function currentMix() { return user.mixes.find((m) => m.id === currentMixId) || null; }
  function newMix(name) {
    const m = { id: uid(), name: name || `Mix ${user.mixes.length + 1}`, tracks: [], created: Date.now() };
    user.mixes.unshift(m);
    currentMixId = m.id;
    store.set('currentMix', currentMixId);
    saveUser();
    return m;
  }
  function addToMix(k) {
    const m = currentMix() || newMix();
    if (m.tracks.includes(k)) { toast(`Already in ${m.name}`); return; }
    m.tracks.push(k);
    saveUser();
    toast(`Added to ${m.name}`);
    if (view === 'mixes') renderMixes();
  }

  function trackObj(k) {
    const t = byKey.get(k);
    if (!t) return null;
    const e = eff(t);
    return { ...t, bpm: e.bpm, cam: e.cam, key: e.key };
  }

  // ---------- how well two tracks belong together, beyond tempo and key ----------
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const feedback = (a, b) => user.pairs[pairKey(a, b)] || 0;
  // Sound profiles come from the sync: a short "sounds like" vector, so close vectors sound alike.
  function soundSim(x, y) {
    let dot = 0, nx = 0, ny = 0;
    for (let i = 0; i < x.v.length; i++) { dot += x.v[i] * y.v[i]; nx += x.v[i] ** 2; ny += y.v[i] ** 2; }
    return nx && ny ? dot / Math.sqrt(nx * ny) : 0;
  }
  // Cosine rescaled to 0..1 from the collection's spread: a random pair lands near 0.33, two tracks off the same record near 0.8.
  const soundFit = (x, y) => Math.max(0, Math.min(1, (soundSim(x, y) + 0.45) / 1.25));
  // 0..1: shared styles, similar era, same label and, where known, how alike they sound.
  function affinity(a, b) {
    const ra = a.r, rb = b.r;
    let s = 0, w = 0;
    if (ra.styles.length && rb.styles.length) {
      const shared = ra.styles.filter((x) => rb.styles.includes(x)).length;
      s += 0.35 * (shared / new Set([...ra.styles, ...rb.styles]).size); w += 0.35;
    } else if (ra.genres.length && rb.genres.length) {
      s += 0.2 * (ra.genres.some((g) => rb.genres.includes(g)) ? 1 : 0); w += 0.2;
    }
    if (ra.year && rb.year) { s += 0.15 * Math.max(0, 1 - Math.abs(ra.year - rb.year) / 15); w += 0.15; }
    if (a.snd && b.snd) { s += 0.5 * soundFit(a.snd, b.snd); w += 0.5; }
    const sameLabel = ra.labels[0] && rb.labels[0] && ra.labels[0].name === rb.labels[0].name;
    return w ? Math.min(1, s / w + (sameLabel ? 0.05 : 0)) : 0.5;
  }

  function suggestions(fromKey, exclude) {
    const a = trackObj(fromKey);
    if (!a) return [];
    const out = [];
    for (const t of TRACKS) {
      if (exclude.has(t.k)) continue;
      const b = trackObj(t.k);
      const tr = C.transition(a, b, { pitchRange: settings.pitchRange });
      const fb = feedback(a.k, b.k);
      if (fb < 0) continue;
      if (tr.score !== null && tr.score >= 0.6 && tr.bpmScore !== 0) out.push({ t: b, tr, rank: tr.score * 0.6 + affinity(a, b) * 0.4 + fb * 0.3 });
    }
    return out.sort((x, y) => y.rank - x.rank).slice(0, 20);
  }

  // Greedy ordering: keep the first track, then always pick the best transition next.
  function autoOrder(m) {
    if (m.tracks.length < 3) return;
    const left = new Set(m.tracks.slice(1));
    const order = [m.tracks[0]];
    while (left.size) {
      const a = trackObj(order[order.length - 1]);
      let best = null, bestScore = -1;
      for (const k of left) {
        const b = trackObj(k), s = (C.transition(a, b, { pitchRange: settings.pitchRange }).score ?? -0.5) * 0.6 + affinity(a, b) * 0.4 + feedback(a.k, k) * 0.3;
        if (s > bestScore) { best = k; bestScore = s; }
      }
      order.push(best);
      left.delete(best);
    }
    m.tracks = order;
    saveUser();
  }

  // ---------- mix generator ----------
  // Builds a playable vinyl set: never two tracks from the same record back to back (you can't
  // cue the record that's playing), each record used once where possible, tempo following a
  // start → end curve, and each step chosen for the smoothest pitch and key move.
  const gen = store.get('gen', { genre: '', style: '', from: 120, to: 126, cam: '', n: 10 });

  function generateMix(o) {
    const keys = !o.nokeys;
    const pool = TRACKS.map((t) => trackObj(t.k)).filter((t) => t.bpm && (t.cam || !keys) &&
      (!o.genre || t.r.genres.includes(o.genre)) && (!o.style || t.r.styles.includes(o.style)));
    if (pool.length < 2) return { error: `Not enough tracks with BPM${keys ? ' and key' : ''} match those choices yet.` };
    const n = Math.max(2, Math.min(+o.n || 10, 40));
    // No end BPM: no tempo plan, each step just takes the smoothest pitch move from the last track.
    const from = +o.from || 120, to = +o.to || null;
    const target = (i) => (to ? from + ((to - from) * i) / Math.max(1, n - 1) : null);
    const near = (bpm, tgt) => Math.min(...[1, 2, 0.5].map((m) => Math.abs(bpm * m - tgt) / tgt));
    const range = settings.pitchRange;

    // Opening track: close to the start tempo (and start key if chosen), with a little randomness.
    const openers = pool
      .map((t) => ({ t, s: near(t.bpm, from) * 10 + (keys && o.cam ? 1 - (C.camRelation(o.cam, t.cam).score ?? 0) : 0) + Math.random() * 0.3 }))
      .sort((a, b) => a.s - b.s).slice(0, 6);
    const first = openers[Math.floor(Math.random() * openers.length)].t;
    const set = [first], usedRec = new Set([first.r]), used = new Set([first.k]);
    while (set.length < n) {
      const prev = set[set.length - 1], tgt = target(set.length);
      let best = null, bestScore = -Infinity;
      for (const c of pool) {
        if (used.has(c.k) || c.r === prev.r) continue;
        const tr = C.transition(prev, c, { pitchRange: range });
        if (!tr.bpmScore || (keys && tr.pitched.score === 0)) continue;
        const fb = feedback(prev.k, c.k);
        if (fb < 0) continue;
        const step = keys ? tr.score : tr.bpmScore;
        const fit = tgt ? Math.max(0, 1 - near(c.bpm, tgt) / 0.06) : step;
        const aff = affinity(prev, c);
        const score = step * 0.4 + fit * 0.2 + (o.vibe === 'eclectic' ? 1 - aff : aff) * 0.25 + vibeFit(o.vibe, prev, c) * 0.15 +
          fb * 0.5 - (usedRec.has(c.r) ? 0.4 : 0) + Math.random() * 0.08;
        if (score > bestScore) { best = c; bestScore = score; }
      }
      if (!best) break;
      set.push(best); used.add(best.k); usedRec.add(best.r);
    }
    return { tracks: set.map((t) => t.k), short: set.length < n };
  }

  // How well the energy move from a to b suits the chosen vibe (0..1), using the sound profiles.
  function vibeFit(vibe, a, b) {
    const ea = a.snd && a.snd.e, eb = b.snd && b.snd.e;
    if (ea == null || eb == null) return 0.5;
    const d = eb - ea;
    if (vibe === 'build') return d >= 0 ? Math.max(0, 1 - Math.abs(d - 6) / 20) : Math.max(0, 0.4 + d / 40);
    if (vibe === 'down') return d <= 0 ? Math.max(0, 1 - Math.abs(d + 6) / 20) : Math.max(0, 0.4 - d / 40);
    return Math.max(0, 1 - Math.abs(d) / 25); // smooth, steady and eclectic keep the energy level
  }

  // The Generate tab: settings, then a draft you can tweak, regenerate, or save into My mixes.
  function renderGenerate() {
    const styles = facet(DATA.releases.filter((r) => !gen.genre || r.genres.includes(gen.genre)), (r) => r.styles);
    const pool = () => TRACKS.filter((t) => { const e = eff(t); return e.bpm && (e.cam || gen.nokeys) && (!gen.genre || t.r.genres.includes(gen.genre)) && (!gen.style || t.r.styles.includes(gen.style)); }).length;
    const k = pool();
    // Typed style names snap to the real one, whatever the case; anything else means Any.
    const pickStyle = (v) => { v = v.trim().toLowerCase(); if (!v) return ''; const hit = styles.find(([s]) => s.toLowerCase() === v); if (hit) return hit[0]; const near = styles.filter(([s]) => s.toLowerCase().includes(v)); return near.length === 1 ? near[0][0] : ''; };
    const d = user.draft;
    let html = `<section class="card-s gen-card"><h2>Generate a mix</h2>
      <p class="sub">Picks tracks you own that match, orders them so each step needs little pitch change and the keys sit well together, and never puts two tracks from the same record back to back. Only tracks with a BPM are used${gen.nokeys ? '' : ', and they need a key too unless you ignore keys'}. Leave End BPM empty to let the tempo drift naturally.</p>
      <div class="gen">
        ${select('genre', 'Genre', facet(DATA.releases, (r) => r.genres), gen.genre, 'Any')}
        <label class="f"><span>Style <small>(type to search)</small></span><input type="search" data-f="style" list="style-list" value="${esc(gen.style)}" placeholder="Any" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done"></label>
        <datalist id="style-list">${styles.map(([v, n]) => `<option value="${esc(v)}">${n} records</option>`).join('')}</datalist>
        <label class="f"><span>Start BPM</span><input data-f="from" value="${esc(gen.from)}" inputmode="numeric"></label>
        <label class="f"><span>End BPM <small>(optional)</small></span><input data-f="to" value="${esc(gen.to ?? '')}" placeholder="Any" inputmode="numeric"></label>
        ${gen.nokeys ? '' : select('cam', 'Start key', camOptions(), gen.cam, 'Any')}
        <label class="f"><span>Vibe</span><select data-f="vibe">${[['', 'Smooth: tracks that sound alike'], ['build', 'Build energy'], ['down', 'Wind down'], ['eclectic', 'Eclectic: contrast, still mixable']]
          .map(([v, n]) => `<option value="${v}"${(gen.vibe || '') === v ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="f"><span>Tracks</span><input data-f="n" value="${esc(gen.n)}" inputmode="numeric"></label>
      </div>
      <label class="switch"><input type="checkbox" data-f="nokeys"${gen.nokeys ? ' checked' : ''}><span></span>Ignore keys <small>(match on tempo only)</small></label>
      <div class="row"><button id="gen-go" class="primary">${d ? 'Generate again' : 'Generate'}</button><span class="sub">${k} tracks to choose from</span></div></section>`;
    if (d) {
      html += `<section class="draft"><div class="draft-bar"><div><b>Draft</b> · ${esc(d.generated.style || d.generated.genre || 'Any genre')}, ${esc(d.generated.from)}${d.generated.to ? '→' + esc(d.generated.to) : '+'} BPM${d.generated.nokeys ? ', keys ignored' : ''}. Reorder or remove tracks here, then save it.</div>
        <div class="save-row"><input id="draft-name" value="${esc(d.name)}" aria-label="Mix name" placeholder="Name this mix">
        <button class="primary" data-a="save">Save to My mixes</button><button data-a="regen">Regenerate</button><button data-a="discard">Clear</button></div></div>
        ${mixBodyHtml(d)}</section>`;
    } else {
      html += '<p class="empty">Pick your settings and tap Generate. The draft shows up here, and nothing goes into My mixes until you save it.</p>';
    }
    const root = $('#generate');
    root.innerHTML = html;
    const val = (el) => (el.type === 'checkbox' ? el.checked : el.dataset.f === 'style' ? pickStyle(el.value) : el.value);
    $$('.gen select, .gen input, .switch input', root).forEach((el) => (el.onchange = () => {
      gen[el.dataset.f] = val(el);
      if (el.dataset.f === 'genre') gen.style = '';
      store.set('gen', gen);
      if (el.dataset.f === 'style') {
        el.value = gen.style;
        $('.row .sub', root).textContent = `${pool()} tracks to choose from`;
        return;
      }
      // Typed numbers don't redraw, so tapping Generate straight after typing still lands.
      if (el.type !== 'text') renderGenerate();
    }));
    $('#gen-go').onclick = () => {
      $$('.gen select, .gen input, .switch input', root).forEach((el) => (gen[el.dataset.f] = val(el)));
      store.set('gen', gen);
      makeDraft();
    };
    if (!d) return;
    $('#draft-name').onchange = (e) => { d.name = e.target.value.trim() || d.name; saveUser(); };
    $$('[data-a]', root).forEach((b) => (b.onclick = () => {
      if (b.dataset.a === 'regen') { gen.genre = d.generated.genre; Object.assign(gen, d.generated); makeDraft(); }
      if (b.dataset.a === 'discard') { user.draft = null; saveUser(); renderGenerate(); }
      if (b.dataset.a === 'save') {
        const name = $('#draft-name').value.trim() || d.name;
        const m = { id: uid(), name, tracks: [...d.tracks], generated: d.generated, created: Date.now() };
        user.mixes.unshift(m);
        user.draft = null;
        currentMixId = m.id;
        store.set('currentMix', currentMixId);
        saveUser();
        setView('mixes');
        toast(`Saved to My mixes`);
      }
    }));
    wireMixBody(root, d, renderGenerate, (k) => { if (!d.tracks.includes(k)) { d.tracks.push(k); saveUser(); renderGenerate(); } });
  }

  function makeDraft() {
    const res = generateMix(gen);
    if (res.error) { toast(res.error); return; }
    const keepName = user.draft && user.draft.renamed ? user.draft.name : null;
    user.draft = { name: keepName || `${gen.style || gen.genre || 'Mix'} ${gen.from}${gen.to ? '→' + gen.to : ''}`, tracks: res.tracks, generated: { ...gen } };
    saveUser();
    renderGenerate();
    toast(res.short ? `Only found ${res.tracks.length} tracks that chain well` : 'New draft ready');
  }

  const THUMB_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11v9H4v-9zM7 11l4-7c1.4 0 2.3 1.1 2 2.5L12.5 10H18a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 16.8 20H7"/></svg>';
  // 0..100: how well b follows a, from tempo, key, sound, style/era/label, energy and your thumbs.
  function compat(a, b, tr) {
    const parts = [];
    if (tr.bpmScore != null) parts.push(['tempo', tr.bpmScore, 0.3]);
    if (tr.pitched && tr.pitched.score != null) parts.push(['key', tr.pitched.score, 0.25]);
    parts.push([a.snd && b.snd ? 'sound and style' : 'style', affinity(a, b), 0.3]);
    if (a.snd && b.snd && a.snd.e != null && b.snd.e != null) parts.push(['energy', vibeFit('', a, b), 0.15]);
    const w = parts.reduce((x, p) => x + p[2], 0);
    let s = parts.reduce((x, p) => x + p[1] * p[2], 0) / w;
    const fb = feedback(a.k, b.k);
    if (fb > 0) s = Math.max(s, 0.9);
    if (fb < 0) s = Math.min(s, 0.2);
    const weak = parts.filter((p) => p[1] < 0.5).sort((x, y) => x[1] - y[1]).map((p) => p[0]);
    const why = fb > 0 ? 'you liked this one' : fb < 0 ? 'you marked this as not working' : weak.length ? 'weak on ' + weak.slice(0, 2).join(' and ') : parts.every((p) => p[1] >= 0.75) ? 'strong on every count' : s >= 0.75 ? 'good match' : 'decent all round';
    const detail = parts.map((p) => `${p[0]} ${Math.round(p[1] * 100)}`).join(' · ');
    return { n: Math.round(Math.max(0, Math.min(1, s)) * 100), why, detail };
  }

  function sugScore(a, b, tr) {
    const cs = compat(a, b, tr);
    return `<b class="cscore ${cs.n >= 75 ? 'good' : cs.n >= 50 ? 'ok' : 'bad'}" title="${esc(cs.why + ': ' + cs.detail)}">${cs.n}</b> `;
  }

  function transitionHtml(a, b) {
    const tr = C.transition(a, b, { pitchRange: settings.pitchRange });
    const cs = compat(a, b, tr);
    const cls = cs.n >= 75 ? 'good' : cs.n >= 50 ? 'ok' : 'bad';
    const bits = [`<span class="score ${cls}" title="${esc(cs.detail)}"><b>${cs.n}</b> ${esc(cs.why)}</span>`];
    if (tr.pitch) {
      const pct = tr.pitch.pct;
      bits.push(`<span class="${relClass(tr.bpmScore)}">${a.bpm} → ${b.bpm} BPM${tr.pitch.mult !== 1 ? (tr.pitch.mult === 2 ? ' (double-time)' : ' (half-time)') : ''} · ${fmtPitch(pct)}${Math.abs(pct) > settings.pitchRange ? ' (beyond ±' + settings.pitchRange + '%)' : ''}</span>`);
    } else bits.push('<span class="unk">BPM unknown</span>');
    if (a.cam && b.cam) {
      bits.push(`<span class="${relClass(tr.pitched.score)}">${esc(a.cam)} → ${esc(tr.keyAfterPitch)}: ${esc(tr.pitched.label)}</span>`);
      if (tr.semis) bits.push(`<span class="unk" title="Vinyl has no key lock: pitching moves the key">${esc(b.cam)} plays as ${esc(tr.keyAfterPitch)} once pitched (${tr.semis > 0 ? '+' : ''}${tr.semis} semitone)</span>`);
    } else bits.push('<span class="unk">key unknown</span>');
    const shared = a.r.styles.filter((x) => b.r.styles.includes(x));
    bits.push(a.r === b.r ? '' : shared.length ? `<span class="unk">both ${esc(shared.slice(0, 2).join(', '))}</span>` : '<span class="unk">different styles</span>');
    if (a.snd && b.snd && a.snd.e != null && b.snd.e != null) bits.push(`<span class="unk">energy ${a.snd.e} → ${b.snd.e}</span>`);
    if (a.snd && b.snd) { const sim = soundSim(a.snd, b.snd); bits.push(`<span class="${sim > 0.55 ? 'good' : sim > 0.2 ? 'ok' : 'bad'}">sound ${sim > 0.55 ? 'very close' : sim > 0.2 ? 'related' : 'contrasting'}</span>`); }
    const fb = feedback(a.k, b.k);
    const fbBtns = `<span class="fb"><button class="${fb > 0 ? 'on' : ''}" data-fa="${esc(a.k)}" data-fbk="${esc(b.k)}" data-v="1" aria-label="This transition works" title="Works well: the generator will reuse it">${THUMB_SVG}</button><button class="down${fb < 0 ? ' on' : ''}" data-fa="${esc(a.k)}" data-fbk="${esc(b.k)}" data-v="-1" aria-label="This transition doesn't work" title="Doesn't work: the generator will avoid it">${THUMB_SVG}</button></span>`;
    return `<li class="trans ${cls}">${bits.join('')}${fbBtns}</li>`;
  }

  // Track list, transitions, records to pull and next-track ideas for a mix or the draft.
  function mixBodyHtml(m) {
    const items = m.tracks.map(trackObj);
    const recs = new Map();
    items.forEach((t) => t && recs.set(t.r.iid || t.r.id, t.r));
    const total = items.reduce((s, t) => s + ((t && t.dur) || 0), 0);
    let html = `<p class="sub">${items.length} tracks from ${recs.size} records${total ? ` · about ${Math.round(total / 60)} min if played in full` : ''}${items.length > 1 ? ' · drag ⋮⋮ to reorder' : ''}</p><ol class="mix">`;
    items.forEach((t, i) => {
      if (!t) { html += `<li class="item missing" data-i="${i}">A track that's no longer in your collection <button class="small" data-rm="${i}">Remove</button></li>`; return; }
      if (i > 0 && items[i - 1]) html += transitionHtml(items[i - 1], t);
      html += `<li class="item" data-i="${i}"><span class="grip" title="Drag to reorder" aria-label="Drag to reorder">⋮⋮</span>
        ${t.r.thumb ? `<img src="${esc(t.r.thumb)}" alt="" loading="lazy">` : '<span class="noimg"></span>'}
        <div class="ti"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span><small>${esc(t.r.title)} · ${esc(t.r.labels[0]?.catno || '')} · side ${esc(t.side || '?')}, <b>${esc(t.pos)}</b></small></div>
        <div class="tk">${playBtn(t)}<span class="bpm">${t.bpm ? t.bpm : '–'}</span>${camBadge(t.cam, t.key)}</div>
        <div class="mv"><button class="small" data-up="${i}" aria-label="Move up">↑</button><button class="small" data-down="${i}" aria-label="Move down">↓</button><button class="small" data-rm="${i}" aria-label="Remove">×</button></div></li>`;
    });
    html += '</ol>';
    if (!items.length) html += '<p class="sub">Add tracks with the <b>+</b> button in Records or Tracks.</p>';
    if (recs.size) {
      html += `<h3>Records to pull</h3><ul class="pull">${[...recs.values()].map((r) => {
        const sides = [...new Set(items.filter((t) => t && t.r === r).map((t) => t.pos))].join(', ');
        return `<li><b>${esc(r.artist)} – ${esc(r.title)}</b> <small>${esc(r.labels[0]?.catno || '')} · ${esc(sides)}</small></li>`;
      }).join('')}</ul>`;
    }
    const last = [...m.tracks].reverse().find((k) => byKey.has(k));
    if (last) {
      const g = m.generated || {};
      const sug = suggestions(last, new Set(m.tracks)).filter(({ t }) => (!g.genre || t.r.genres.includes(g.genre)) && (!g.style || t.r.styles.includes(g.style)));
      const lt = trackObj(last);
      html += `<h3>What could come next <small>after ${esc(lt.title)}${lt.bpm ? ' · ' + lt.bpm + ' BPM' : ''}${lt.cam ? ' · ' + lt.cam : ''}</small></h3>`;
      html += sug.length ? `<table class="sug"><tbody>${sug.map(({ t, tr }) => `<tr data-k="${esc(t.k)}"><td>${camBadge(t.cam, t.key)}</td><td class="num">${t.bpm ?? '–'}</td>
        <td><b>${esc(t.title)}</b><br><small>${esc(t.artist)} · ${esc(t.r.title)} ${esc(t.pos)}</small>
          <br><small class="${relClass(tr.score)}">${sugScore(lt, t, tr)}${tr.pitch ? fmtPitch(tr.pitch.pct) + ' · ' : ''}${esc(tr.pitched.label)}</small></td>
        <td>${playBtn(t)}</td>
        <td><button class="small add">+</button></td></tr>`).join('')}</tbody></table>`
        : '<p class="sub">No good matches yet. Suggestions need BPM and key on the last track, so add them by hand if they are missing.</p>';
    }
    return html;
  }

  function wireMixBody(root, m, rerender, add) {
    const move = (i, j) => { if (j < 0 || j >= m.tracks.length) return; const [x] = m.tracks.splice(i, 1); m.tracks.splice(j, 0, x); saveUser(); rerender(); };
    $$('[data-up]', root).forEach((b) => (b.onclick = () => move(+b.dataset.up, +b.dataset.up - 1)));
    $$('[data-down]', root).forEach((b) => (b.onclick = () => move(+b.dataset.down, +b.dataset.down + 1)));
    $$('[data-rm]', root).forEach((b) => (b.onclick = () => { m.tracks.splice(+b.dataset.rm, 1); saveUser(); rerender(); }));
    wireDrag(root, move);
    $$('table.sug .add', root).forEach((b) => (b.onclick = () => add(b.closest('tr').dataset.k)));
    $$('.fb button', root).forEach((b) => (b.onclick = () => {
      const key = pairKey(b.dataset.fa, b.dataset.fbk), v = +b.dataset.v;
      if (user.pairs[key] === v) delete user.pairs[key]; else user.pairs[key] = v;
      saveUser();
      rerender();
      toast(user.pairs[key] ? (v > 0 ? 'Noted: the generator will favour this pair' : 'Noted: the generator will avoid this pair') : 'Cleared');
    }));
  }

  // My mixes: only saved mixes. Rename, reorder, add, remove, duplicate, delete.
  let renaming = false;
  function renderMixes() {
    $('#mixes').innerHTML = user.mixes.map((m) => `<li><button data-id="${m.id}" class="${m.id === currentMixId ? 'active' : ''}"><span>${esc(m.name)}</span> <small>${m.tracks.length}</small></button></li>`).join('') || '<li class="empty">No saved mixes yet.</li>';
    $$('#mixes button').forEach((b) => (b.onclick = () => { currentMixId = b.dataset.id; renaming = false; store.set('currentMix', currentMixId); renderMixes(); }));
    const m = currentMix();
    const main = $('#mix-main');
    if (!m) {
      main.innerHTML = `<div class="empty"><p>Your saved mixes live here. Build one in the <b>Generate</b> tab and save it, or tap <b>+ New</b> and add tracks from Records or Tracks with the <b>+</b> button.</p></div>`;
      return;
    }
    let html = renaming
      ? `<div class="row mix-head"><input class="mix-name editing" id="rename-input" value="${esc(m.name)}" aria-label="Mix name"><div class="actions"><button class="primary small" data-a="rename-ok">Save name</button><button class="small" data-a="rename-cancel">Cancel</button></div></div>`
      : `<div class="row mix-head"><h2 class="mix-title">${esc(m.name)}</h2><button class="small" data-a="rename">✎ Rename</button></div>`;
    html += `<div class="actions mix-actions"><button class="small" data-a="auto" title="Reorder for smoothest BPM and key steps">Auto-order</button>
      <button class="small" data-a="dup" title="Make a copy to try a variation">Duplicate</button>
      <button class="small" data-a="copy">Copy as text</button><button class="small danger" data-a="del">Delete</button></div>`;
    html += mixBodyHtml(m);
    main.innerHTML = html;

    if (renaming) {
      const inp = $('#rename-input');
      inp.focus(); inp.select();
      const ok = () => { m.name = inp.value.trim() || m.name; renaming = false; saveUser(); renderMixes(); toast('Renamed'); };
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') { renaming = false; renderMixes(); } };
      $('[data-a=rename-ok]', main).onclick = ok;
      $('[data-a=rename-cancel]', main).onclick = () => { renaming = false; renderMixes(); };
    }
    $$('[data-a]', main).forEach((b) => {
      if (b.dataset.a.startsWith('rename-')) return;
      b.onclick = () => {
        if (b.dataset.a === 'rename') { renaming = true; renderMixes(); }
        if (b.dataset.a === 'auto') { autoOrder(m); renderMixes(); toast('Reordered'); }
        if (b.dataset.a === 'copy') copyMix(m);
        if (b.dataset.a === 'dup') {
          const c = { ...m, id: uid(), name: m.name + ' (copy)', tracks: [...m.tracks], created: Date.now() };
          user.mixes.splice(user.mixes.indexOf(m), 0, c);
          currentMixId = c.id; store.set('currentMix', currentMixId); saveUser(); renderMixes(); toast('Copy made');
        }
        if (b.dataset.a === 'del') {
          if (b.dataset.armed) { user.mixes = user.mixes.filter((x) => x !== m); currentMixId = user.mixes[0]?.id || null; store.set('currentMix', currentMixId); saveUser(); renderMixes(); }
          else { b.dataset.armed = '1'; b.textContent = 'Tap again to delete'; }
        }
      };
    });
    wireMixBody(main, m, renderMixes, addToMix);
  }

  // Drag by the grip to reorder. Pointer events, so it works with a finger on iPhone as well as a mouse.
  function wireDrag(main, move) {
    $$('.grip', main).forEach((grip) => {
      grip.onpointerdown = (e) => {
        e.preventDefault();
        const li = grip.closest('li.item');
        const from = +li.dataset.i;
        const items = $$('li.item', main);
        const rects = items.map((x) => x.getBoundingClientRect());
        const r0 = li.getBoundingClientRect();
        const startY = e.clientY, startScroll = window.scrollY;
        let to = from;
        li.classList.add('dragging');
        grip.setPointerCapture(e.pointerId);
        const mark = () => items.forEach((x, k) => { x.classList.toggle('drop-before', k === to && to < from); x.classList.toggle('drop-after', k === to && to > from); });
        grip.onpointermove = (ev) => {
          if (ev.clientY < 150) window.scrollBy(0, -12);
          else if (ev.clientY > window.innerHeight - 70) window.scrollBy(0, 12);
          const dy = ev.clientY - startY + (window.scrollY - startScroll);
          li.style.transform = `translateY(${dy}px)`;
          const center = r0.top + r0.height / 2 + dy;
          to = from;
          rects.forEach((rc, k) => {
            const mid = rc.top + rc.height / 2;
            if (k < from && center < mid) to = Math.min(to, k);
            if (k > from && center > mid) to = Math.max(to, k);
          });
          mark();
        };
        const end = () => {
          grip.onpointermove = grip.onpointerup = grip.onpointercancel = null;
          li.style.transform = '';
          li.classList.remove('dragging');
          items.forEach((x) => x.classList.remove('drop-before', 'drop-after'));
          if (to !== from) move(from, to);
        };
        grip.onpointerup = end;
        grip.onpointercancel = end;
      };
    });
  }

  function copyMix(m) {
    const lines = [m.name, ''];
    m.tracks.map(trackObj).forEach((t, i) => {
      if (!t) return;
      lines.push(`${i + 1}. ${t.artist} – ${t.title}  [${t.r.title} · ${t.r.labels[0]?.catno || ''} · ${t.pos}]  ${t.bpm || '?'} BPM  ${t.cam || '?'}`);
    });
    navigator.clipboard?.writeText(lines.join('\n')).then(() => toast('Copied'), () => toast('Copy failed'));
  }

  // ----- Settings -----
  function renderSettings() {
    const n = Object.keys(user.overrides).length;
    const withBpm = TRACKS.filter((t) => eff(t).bpm).length, withKey = TRACKS.filter((t) => eff(t).cam).length;
    const src = facet(TRACKS, (t) => [eff(t).src || 'not found yet']);
    $('#settings').innerHTML = `
      <section class="card-s"><h2>Collection</h2>
        <p>${DATA.releases.length} records, ${TRACKS.length} tracks from <a href="https://www.discogs.com/user/${esc(DATA.username)}/collection" target="_blank" rel="noopener">${esc(DATA.username || 'Discogs')}</a>. Last synced ${DATA.generated ? new Date(DATA.generated).toLocaleString() : 'never'}; it re-syncs automatically every few hours.</p>
        <p>${withBpm} tracks have a BPM and ${withKey} have a key. ${src.map(([s, c]) => `${esc(s)}: ${c}`).join(' · ')}</p></section>
      <section class="card-s"><h2>Mixing</h2>
        <label class="f"><span>Turntable pitch range</span><select id="pitch">${[8, 16, 50].map((v) => `<option${settings.pitchRange === v ? ' selected' : ''} value="${v}">±${v}%</option>`).join('')}</select></label></section>
      <section class="card-s"><h2>Your edits and mixes</h2>
        <p>${n} edited tracks and ${user.mixes.length} mixes are saved in this browser.</p>
        <div class="row"><button id="export">Download backup</button><label class="button">Restore backup<input type="file" id="import" accept="application/json" hidden></label></div></section>
      <section class="card-s"><h2>Sync edits across devices <small>(optional)</small></h2>
        <p>Paste a GitHub fine-grained token that can only write to this repository's contents. Your edits and mixes are then saved to <code>user/state.json</code> in the repo and load on any device. The token stays in this browser.</p>
        <label class="f"><span>Repository</span><input id="gh-repo" value="${esc(settings.ghRepo || guessRepo())}" placeholder="owner/repo"></label>
        <label class="f"><span>Token</span><input id="gh-token" type="password" value="${esc(settings.ghToken)}" placeholder="github_pat_…"></label>
        <div class="row"><button id="gh-save">Save and sync now</button><span id="gh-status" class="sub"></span></div></section>`;
    $('#pitch').onchange = (e) => { settings.pitchRange = +e.target.value; store.set('settings', settings); };
    $('#export').onclick = () => {
      const blob = new Blob([JSON.stringify(user, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `crate-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
    };
    $('#import').onchange = async (e) => {
      try {
        const obj = JSON.parse(await e.target.files[0].text());
        if (!obj.overrides || !Array.isArray(obj.mixes)) throw new Error('not a Crate backup');
        Object.assign(user, obj);
        saveUser();
        toast('Backup restored');
        renderSettings();
      } catch (err) { toast('Could not read that file: ' + err.message); }
    };
    $('#gh-save').onclick = async () => {
      settings.ghRepo = $('#gh-repo').value.trim();
      settings.ghToken = $('#gh-token').value.trim();
      store.set('settings', settings);
      $('#gh-status').textContent = 'Syncing…';
      try { await remoteLoad(true); await remoteSave(); $('#gh-status').textContent = 'Synced ✓'; }
      catch (err) { $('#gh-status').textContent = 'Failed: ' + err.message; }
    };
  }

  // ---------- optional GitHub mirror of user state ----------
  function guessRepo() {
    const m = /^([^.]+)\.github\.io$/.exec(location.hostname);
    const seg = location.pathname.split('/').filter(Boolean)[0];
    return m && seg ? `${m[1]}/${seg}` : '';
  }
  let remoteSha = null, saveTimer = null;
  const ghHeaders = () => ({ Accept: 'application/vnd.github+json', ...(settings.ghToken ? { Authorization: `Bearer ${settings.ghToken}` } : {}) });
  const ghUrl = () => `https://api.github.com/repos/${settings.ghRepo}/contents/user/state.json`;
  const b64 = (s) => {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

  async function remoteLoad(force) {
    if (!settings.ghRepo || !settings.ghToken) return;
    const r = await fetch(ghUrl() + `?t=${Date.now()}`, { headers: ghHeaders(), cache: 'no-store' });
    if (r.status === 404) { remoteSha = null; return; }
    if (!r.ok) throw new Error(`GitHub said ${r.status}`);
    const j = await r.json();
    remoteSha = j.sha;
    const remote = JSON.parse(unb64(j.content));
    if (force || (remote.updated || 0) > (user.updated || 0)) {
      if ((remote.updated || 0) > (user.updated || 0)) {
        Object.assign(user, remote);
        store.set('user', user);
        render();
      }
    }
  }
  async function remoteSave() {
    if (!settings.ghRepo || !settings.ghToken) return;
    const body = { message: 'Update Crate edits and mixes', content: b64(JSON.stringify(user, null, 1)), ...(remoteSha ? { sha: remoteSha } : {}) };
    let r = await fetch(ghUrl(), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
    if (r.status === 409 || r.status === 422) { // someone else saved first: refresh sha and retry once
      await remoteLoad(false);
      body.sha = remoteSha;
      body.content = b64(JSON.stringify(user, null, 1));
      r = await fetch(ghUrl(), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
    }
    if (!r.ok) throw new Error(`GitHub said ${r.status}`);
    remoteSha = (await r.json()).content.sha;
  }
  function scheduleRemoteSave() {
    if (!settings.ghToken) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => remoteSave().catch((e) => toast('Sync to GitHub failed: ' + e.message)), 2500);
  }

  // ---------- record drawer ----------
  let drawerScroll = 0, drawerPushed = false;
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function openDrawer(title) {
    $('#drawer-title').textContent = title || '';
    $('.drawer .close').lastChild.textContent = $('#ltitle').textContent; // iOS names the screen you go back to
    if (!$('#drawer').classList.contains('open')) {
      drawerScroll = window.scrollY;
      document.body.classList.add('locked');
      document.body.style.top = `-${drawerScroll}px`;
      try { history.pushState({ drawer: 1 }, ''); drawerPushed = true; } catch { drawerPushed = false; }
    }
    clearTimeout(hideDrawer._t);
    $('#drawer').hidden = false;
    $('.drawer-panel').scrollTop = 0;
    requestAnimationFrame(() => requestAnimationFrame(() => $('#drawer').classList.add('open')));
  }
  function hideDrawer() {
    const d = $('#drawer');
    d.classList.remove('open');
    clearTimeout(hideDrawer._t);
    hideDrawer._t = setTimeout(() => { if (!d.classList.contains('open')) d.hidden = true; }, reduceMotion() ? 0 : 260);
    document.body.classList.remove('locked');
    document.body.style.top = '';
    window.scrollTo(0, drawerScroll);
    drawerPushed = false;
    if (view === 'tracks') renderTracks();
    if (view === 'mixes') renderMixes();
  }
  function closeDrawer() {
    if (drawerPushed) history.back(); // popstate then hides it
    else hideDrawer();
  }

  // ---------- boot ----------
  function wire() {
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-play], [data-yt], [data-video]');
      if (!b) return;
      e.preventDefault();
      if (b.dataset.play) previewTrack(b.dataset.play);
      else if (b.dataset.yt) { const t = byKey.get(b.dataset.yt); playVideo('v:' + t.k, t.yt, t.title, `${t.artist} · ${t.r.title} · ${t.pos}`); }
      else playVideo('v:' + b.dataset.video, b.dataset.video, b.dataset.title, b.dataset.sub);
    });
    $('#player .pl-close').onclick = closePlayer;
    $$('.tabs button').forEach((b) => (b.onclick = () => setView(b.dataset.view)));
    let t;
    $('#search').oninput = () => { clearTimeout(t); t = setTimeout(() => { trackLimit = 300; render(); }, 120); };
    $('#new-mix').onclick = () => { newMix(); renderMixes(); };
    $('.drawer-back').onclick = closeDrawer;
    $('.drawer .close').onclick = closeDrawer;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#drawer').classList.contains('open')) closeDrawer(); });
    // Back button / swipe-back closes an open record instead of leaving the app.
    window.addEventListener('popstate', () => { if ($('#drawer').classList.contains('open')) hideDrawer(); });
  }

  async function boot() {
    wire();
    try {
      const r = await fetch('data.json', { cache: 'no-cache' });
      DATA = await r.json();
    } catch {
      $('#status').textContent = 'Could not load the collection data.';
    }
    index();
    const s = $('#status');
    if (DATA.generated) s.textContent = `${DATA.releases.length} records · ${TRACKS.length} tracks · synced ${new Date(DATA.generated).toLocaleString()}`;
    const v = location.hash.slice(1);
    setView(['records', 'tracks', 'generate', 'mixes', 'settings'].includes(v) ? v : 'records');
    remoteLoad(false).catch(() => {});
  }
  boot();
})();
