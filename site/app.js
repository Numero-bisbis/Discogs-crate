/* Crate: browse a Discogs collection and plan vinyl mixes. No build step, no framework. */
(function () {
  'use strict';
  const C = window.Camelot;
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '');
  const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const uid = () => Math.random().toString(36).slice(2, 10);

  // ---------- persistent state (this browser, optionally mirrored to GitHub) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('crate.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('crate.' + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  };
  const user = store.get('user', { overrides: {}, mixes: [], updated: 0 });
  const settings = store.get('settings', { pitchRange: 8, ghToken: '', ghRepo: '' });
  let currentMixId = store.get('currentMix', null);

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
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 2200);
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
    $('#search').hidden = v === 'settings' || v === 'mixes';
    render();
    try { history.replaceState(null, '', '#' + v); } catch { /* sandboxed */ }
  }

  function render() {
    if (view === 'records') renderRecords();
    else if (view === 'tracks') renderTracks();
    else if (view === 'mixes') renderMixes();
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
    $('#record-filters').innerHTML =
      select('genre', 'Genre', facet(all, (r) => r.genres), rf.genre) +
      select('style', 'Style', facet(all, (r) => r.styles), rf.style) +
      select('label', 'Label', facet(all, (r) => r.labels.map((l) => l.name)), rf.label) +
      select('decade', 'Decade', facet(all, (r) => [r.year ? String(Math.floor(r.year / 10) * 10) : null]).sort((a, b) => b[0] - a[0]), rf.decade) +
      (folders.length ? select('folder', 'Folder', folders, rf.folder) : '') +
      `<label class="f"><span>BPM</span><span class="range"><input data-f="bpmMin" value="${esc(rf.bpmMin || '')}" placeholder="min" inputmode="numeric">–<input data-f="bpmMax" value="${esc(rf.bpmMax || '')}" placeholder="max" inputmode="numeric"></span></label>` +
      select('cam', 'Key', camOptions(), rf.cam, 'Any') +
      `<label class="f"><span>Sort</span><select data-f="sort">${[['added', 'Recently added'], ['artist', 'Artist'], ['title', 'Title'], ['year', 'Year (new → old)'], ['yearAsc', 'Year (old → new)'], ['label', 'Label / cat no.'], ['rating', 'My rating']]
        .map(([v, n]) => `<option value="${v}"${rf.sort === v ? ' selected' : ''}>${n}</option>`).join('')}</select></label>` +
      `<span class="count">${list.length} of ${all.length} records</span>`;
    $$('#record-filters select, #record-filters input').forEach((s) => (s.onchange = () => { rf[s.dataset.f] = s.value; store.set('rf', rf); renderRecords(); }));

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
      return `<tr data-k="${esc(t.k)}"><td class="pos">${esc(t.pos)}</td><td><b>${esc(t.title)}</b>${t.artist !== r.artist ? `<br><small>${esc(t.artist)}</small>` : ''}</td>
        <td class="num">${fmtDur(t.dur)}</td>
        <td class="num"><input class="bpm-in" value="${e.bpm ?? ''}" placeholder="BPM" inputmode="numeric"></td>
        <td><input class="key-in" value="${e.cam ?? ''}" placeholder="Key" title="${esc(e.key || 'Type 8A, Am, F#m…')}"></td><td>${srcTag(e)}</td>
        <td><button class="small add" title="Add to ${esc(mix ? mix.name : 'a new mix')}">+ Mix</button></td></tr>`;
    }).join('');
    $('#drawer-body').innerHTML = `
      <div class="rec-head">${r.cover ? `<img src="${esc(r.cover)}" alt="">` : ''}<div>
        <h2>${esc(r.title)}</h2><p class="artist">${esc(r.artist)}</p>
        <p>${esc(r.labels.map((l) => `${l.name} – ${l.catno}`).join(', '))}</p>
        <p>${esc([r.format, r.country, r.year].filter(Boolean).join(' · '))}</p>
        <p class="tags">${[...r.genres, ...r.styles].map((g) => `<span>${esc(g)}</span>`).join('')}</p>
        <p><a href="${esc(r.url)}" target="_blank" rel="noopener">Open on Discogs ↗</a></p></div></div>
      <table class="tl"><thead><tr><th>Pos</th><th>Track</th><th>Time</th><th>BPM</th><th>Key</th><th>From</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7">No tracklist yet.</td></tr>'}</tbody></table>
      <p class="hint">From: <b>DB</b> = AcousticBrainz database, <b>est.</b> = estimated from a 30-second preview, <b>you</b> = your edit, <b>none</b> = nothing found, <b>…</b> = not looked up yet. Type over any value to fix it.</p>`;
    wireEdits($('#drawer-body'));
    $('#drawer').hidden = false;
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
    $('#track-filters').innerHTML =
      select('genre', 'Genre', facet(DATA.releases, (r) => r.genres), tf.genre) +
      select('style', 'Style', facet(DATA.releases, (r) => r.styles), tf.style) +
      `<label class="f"><span>BPM</span><span class="range"><input data-f="bpmMin" value="${esc(tf.bpmMin || '')}" placeholder="min" inputmode="numeric">–<input data-f="bpmMax" value="${esc(tf.bpmMax || '')}" placeholder="max" inputmode="numeric"></span></label>` +
      select('cam', 'Key', allCams.map(([c]) => [c, null]), tf.cam, 'Any') +
      select('compat', 'Mixes with', allCams.map(([c]) => [c, null]), tf.compat, 'Any') +
      `<label class="f"><span>Show</span><select data-f="has">${[['', 'All tracks'], ['bpm', 'With BPM'], ['missing', 'Missing BPM/key'], ['notfound', 'Not found'], ['pending', 'Not looked up yet'], ['est', 'Estimated (check by ear)'], ['edited', 'My edits']]
        .map(([v, n]) => `<option value="${v}"${(tf.has || '') === v ? ' selected' : ''}>${n}</option>`).join('')}</select></label>` +
      `<span class="count">${list.length} tracks</span>`;
    $$('#track-filters select, #track-filters input').forEach((s) => (s.onchange = () => { tf[s.dataset.f] = s.value; store.set('tf', tf); trackLimit = 300; renderTracks(); }));

    const head = [['pos', 'Pos'], ['title', 'Track'], ['artist', 'Artist'], ['record', 'Record'], ['bpm', 'BPM'], ['key', 'Key'], ['src', 'From'], ['dur', 'Time'], ['year', 'Year'], ['label', 'Label']];
    const mix = currentMix();
    $('#track-table').innerHTML = `<thead><tr>${head.map(([k, n]) => `<th data-s="${k}" class="${tf.sort === k ? (tf.dir > 0 ? 'asc' : 'desc') : ''}">${n}</th>`).join('')}<th></th></tr></thead><tbody>${list
      .slice(0, trackLimit)
      .map((t) => {
        const e = eff(t);
        return `<tr data-k="${esc(t.k)}"><td class="pos">${esc(t.pos)}</td><td><b>${esc(t.title)}</b></td><td>${esc(t.artist)}</td>
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

  function suggestions(fromKey, exclude) {
    const a = trackObj(fromKey);
    if (!a) return [];
    const out = [];
    for (const t of TRACKS) {
      if (exclude.has(t.k)) continue;
      const b = trackObj(t.k);
      const tr = C.transition(a, b, { pitchRange: settings.pitchRange });
      if (tr.score !== null && tr.score >= 0.6 && tr.bpmScore !== 0) out.push({ t: b, tr });
    }
    return out.sort((x, y) => y.tr.score - x.tr.score).slice(0, 20);
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
        const s = C.transition(a, trackObj(k), { pitchRange: settings.pitchRange }).score ?? -0.5;
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
    const pool = TRACKS.map((t) => trackObj(t.k)).filter((t) => t.bpm && t.cam &&
      (!o.genre || t.r.genres.includes(o.genre)) && (!o.style || t.r.styles.includes(o.style)));
    if (pool.length < 2) return { error: 'Not enough tracks with BPM and key match those choices yet.' };
    const n = Math.max(2, Math.min(+o.n || 10, 40));
    const from = +o.from || 120, to = +o.to || from;
    const target = (i) => from + ((to - from) * i) / Math.max(1, n - 1);
    const near = (bpm, tgt) => Math.min(...[1, 2, 0.5].map((m) => Math.abs(bpm * m - tgt) / tgt));
    const range = settings.pitchRange;

    // Opening track: close to the start tempo (and start key if chosen), with a little randomness.
    const openers = pool
      .map((t) => ({ t, s: near(t.bpm, from) * 10 + (o.cam ? 1 - (C.camRelation(o.cam, t.cam).score ?? 0) : 0) + Math.random() * 0.3 }))
      .sort((a, b) => a.s - b.s).slice(0, 6);
    const first = openers[Math.floor(Math.random() * openers.length)].t;
    const set = [first], usedRec = new Set([first.r]), used = new Set([first.k]);
    while (set.length < n) {
      const prev = set[set.length - 1], tgt = target(set.length);
      let best = null, bestScore = -Infinity;
      for (const c of pool) {
        if (used.has(c.k) || c.r === prev.r) continue;
        const tr = C.transition(prev, c, { pitchRange: range });
        if (!tr.bpmScore || tr.pitched.score === 0) continue;
        const fit = Math.max(0, 1 - near(c.bpm, tgt) / 0.06);
        const score = tr.score * 0.6 + fit * 0.4 - (usedRec.has(c.r) ? 0.4 : 0) + Math.random() * 0.1;
        if (score > bestScore) { best = c; bestScore = score; }
      }
      if (!best) break;
      set.push(best); used.add(best.k); usedRec.add(best.r);
    }
    return { tracks: set.map((t) => t.k), short: set.length < n };
  }

  function openGenerator() {
    const styles = facet(DATA.releases.filter((r) => !gen.genre || r.genres.includes(gen.genre)), (r) => r.styles);
    $('#drawer-body').innerHTML = `<h2>Generate a mix</h2>
      <p class="sub">Picks tracks you own that match, orders them so each step needs little pitch change and the keys sit well together, and never puts two tracks from the same record back to back. Only tracks with both BPM and key are used.</p>
      <div class="gen">
        ${select('genre', 'Genre', facet(DATA.releases, (r) => r.genres), gen.genre, 'Any')}
        ${select('style', 'Style', styles, gen.style, 'Any')}
        <label class="f"><span>Start BPM</span><input data-f="from" value="${esc(gen.from)}" inputmode="numeric"></label>
        <label class="f"><span>End BPM</span><input data-f="to" value="${esc(gen.to)}" inputmode="numeric"></label>
        ${select('cam', 'Start key', camOptions(), gen.cam, 'Any')}
        <label class="f"><span>Tracks</span><input data-f="n" value="${esc(gen.n)}" inputmode="numeric"></label>
      </div>
      <p class="sub" id="gen-count"></p>
      <div class="row"><button id="gen-go" class="primary">Generate</button></div>`;
    const count = () => {
      const k = TRACKS.filter((t) => { const e = eff(t); return e.bpm && e.cam && (!gen.genre || t.r.genres.includes(gen.genre)) && (!gen.style || t.r.styles.includes(gen.style)); }).length;
      $('#gen-count').textContent = `${k} tracks to choose from.`;
    };
    $$('.gen select, .gen input', $('#drawer-body')).forEach((el) => (el.onchange = () => {
      gen[el.dataset.f] = el.value;
      if (el.dataset.f === 'genre') { gen.style = ''; store.set('gen', gen); openGenerator(); return; }
      store.set('gen', gen); count();
    }));
    count();
    $('#gen-go').onclick = () => {
      $$('.gen select, .gen input', $('#drawer-body')).forEach((el) => (gen[el.dataset.f] = el.value));
      store.set('gen', gen);
      const res = generateMix(gen);
      if (res.error) { toast(res.error); return; }
      const name = `${gen.style || gen.genre || 'Mix'} ${gen.from}→${gen.to}`;
      const m = newMix(name);
      m.tracks = res.tracks;
      m.generated = { ...gen };
      saveUser();
      $('#drawer').hidden = true;
      setView('mixes');
      toast(res.short ? `Only found ${res.tracks.length} tracks that chain well` : 'Mix generated');
    };
    $('#drawer').hidden = false;
  }

  function transitionHtml(a, b) {
    const tr = C.transition(a, b, { pitchRange: settings.pitchRange });
    const bits = [];
    if (tr.pitch) {
      const pct = tr.pitch.pct;
      bits.push(`<span class="${relClass(tr.bpmScore)}">${tr.pitch.mult !== 1 ? (tr.pitch.mult === 2 ? 'double-time, ' : 'half-time, ') : ''}pitch ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%${Math.abs(pct) > settings.pitchRange ? ' (beyond ±' + settings.pitchRange + '%)' : ''}</span>`);
    } else bits.push('<span class="unk">BPM unknown</span>');
    if (a.cam && b.cam) {
      bits.push(`<span class="${relClass(tr.pitched.score)}">${esc(a.cam)} → ${esc(tr.keyAfterPitch)}: ${esc(tr.pitched.label)}</span>`);
      if (tr.semis) bits.push(`<span class="unk" title="Vinyl has no key lock: pitching moves the key">${esc(b.cam)} plays as ${esc(tr.keyAfterPitch)} once pitched (${tr.semis > 0 ? '+' : ''}${tr.semis} semitone)</span>`);
    } else bits.push('<span class="unk">key unknown</span>');
    return `<li class="trans ${relClass(tr.score)}">${bits.join('')}</li>`;
  }

  function renderMixes() {
    $('#mixes').innerHTML = user.mixes.map((m) => `<li><button data-id="${m.id}" class="${m.id === currentMixId ? 'active' : ''}">${esc(m.name)} <small>${m.tracks.length}</small></button></li>`).join('') || '<li class="empty">No mixes yet.</li>';
    $$('#mixes button').forEach((b) => (b.onclick = () => { currentMixId = b.dataset.id; store.set('currentMix', currentMixId); renderMixes(); }));
    const m = currentMix();
    const main = $('#mix-main');
    if (!m) {
      main.innerHTML = `<div class="empty"><p>Tap <b>Generate a mix</b> to have one built from a genre and BPM range, or create an empty mix and add tracks from Records or Tracks with the <b>+</b> button.</p><p>Each step shows how much to pitch the next record and whether the keys sit well together on the Camelot wheel.</p></div>`;
      return;
    }
    const items = m.tracks.map(trackObj);
    let html = `<div class="row mix-head"><input class="mix-name" value="${esc(m.name)}" aria-label="Mix name">
      <div class="actions">${m.generated ? '<button class="small" data-a="regen" title="Same settings, different picks">Regenerate</button>' : ''}<button class="small" data-a="auto" title="Reorder for smoothest BPM and key steps">Auto-order</button>
      <button class="small" data-a="copy">Copy as text</button><button class="small danger" data-a="del">Delete</button></div></div>`;
    const recs = new Map();
    items.forEach((t) => t && recs.set(t.r.iid || t.r.id, t.r));
    const total = items.reduce((s, t) => s + ((t && t.dur) || 0), 0);
    html += `<p class="sub">${items.length} tracks from ${recs.size} records${total ? ` · about ${Math.round(total / 60)} min if played in full` : ''}</p><ol class="mix">`;
    items.forEach((t, i) => {
      if (!t) { html += `<li class="item missing" data-i="${i}">A track that's no longer in your collection <button class="small" data-rm="${i}">Remove</button></li>`; return; }
      if (i > 0 && items[i - 1]) html += transitionHtml(items[i - 1], t);
      html += `<li class="item" draggable="true" data-i="${i}"><span class="grip" aria-hidden="true">⋮⋮</span>
        ${t.r.thumb ? `<img src="${esc(t.r.thumb)}" alt="" loading="lazy">` : '<span class="noimg"></span>'}
        <div class="ti"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span><small>${esc(t.r.title)} · ${esc(t.r.labels[0]?.catno || '')} · side ${esc(t.side || '?')}, <b>${esc(t.pos)}</b></small></div>
        <div class="tk"><span class="bpm">${t.bpm ? t.bpm : '–'}</span>${camBadge(t.cam, t.key)}</div>
        <div class="mv"><button class="small" data-up="${i}" aria-label="Move up">↑</button><button class="small" data-down="${i}" aria-label="Move down">↓</button><button class="small" data-rm="${i}" aria-label="Remove">×</button></div></li>`;
    });
    html += '</ol>';
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
        <td><b>${esc(t.title)}</b><br><small>${esc(t.artist)} · ${esc(t.r.title)} ${esc(t.pos)}</small></td>
        <td><small class="${relClass(tr.score)}">${tr.pitch ? `pitch ${tr.pitch.pct >= 0 ? '+' : ''}${tr.pitch.pct.toFixed(1)}%` : ''} · ${esc(tr.pitched.label)}</small></td>
        <td><button class="small add">+</button></td></tr>`).join('')}</tbody></table>`
        : '<p class="sub">No good matches yet. Suggestions need BPM and key on the last track, so add them by hand if they are missing.</p>';
    }
    main.innerHTML = html;

    $('.mix-name', main).onchange = (e) => { m.name = e.target.value.trim() || m.name; saveUser(); renderMixes(); };
    $$('[data-a]', main).forEach((b) => (b.onclick = () => {
      if (b.dataset.a === 'auto') { autoOrder(m); renderMixes(); toast('Reordered'); }
      if (b.dataset.a === 'regen') { const res = generateMix(m.generated); if (!res.error) { m.tracks = res.tracks; saveUser(); renderMixes(); toast('New version'); } }
      if (b.dataset.a === 'copy') copyMix(m);
      if (b.dataset.a === 'del') {
        if (b.dataset.armed) { user.mixes = user.mixes.filter((x) => x !== m); currentMixId = user.mixes[0]?.id || null; store.set('currentMix', currentMixId); saveUser(); renderMixes(); }
        else { b.dataset.armed = '1'; b.textContent = 'Click again to delete'; }
      }
    }));
    const move = (i, j) => { if (j < 0 || j >= m.tracks.length) return; const [x] = m.tracks.splice(i, 1); m.tracks.splice(j, 0, x); saveUser(); renderMixes(); };
    $$('[data-up]', main).forEach((b) => (b.onclick = () => move(+b.dataset.up, +b.dataset.up - 1)));
    $$('[data-down]', main).forEach((b) => (b.onclick = () => move(+b.dataset.down, +b.dataset.down + 1)));
    $$('[data-rm]', main).forEach((b) => (b.onclick = () => { m.tracks.splice(+b.dataset.rm, 1); saveUser(); renderMixes(); }));
    let dragFrom = null;
    $$('li.item[draggable]', main).forEach((li) => {
      li.ondragstart = (e) => { dragFrom = +li.dataset.i; e.dataTransfer.effectAllowed = 'move'; li.classList.add('dragging'); };
      li.ondragend = () => li.classList.remove('dragging');
      li.ondragover = (e) => { e.preventDefault(); li.classList.add('over'); };
      li.ondragleave = () => li.classList.remove('over');
      li.ondrop = (e) => { e.preventDefault(); if (dragFrom !== null) move(dragFrom, +li.dataset.i); dragFrom = null; };
    });
    $$('table.sug .add', main).forEach((b) => (b.onclick = () => addToMix(b.closest('tr').dataset.k)));
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

  // ---------- boot ----------
  function wire() {
    $$('.tabs button').forEach((b) => (b.onclick = () => setView(b.dataset.view)));
    let t;
    $('#search').oninput = () => { clearTimeout(t); t = setTimeout(() => { trackLimit = 300; render(); }, 120); };
    $('#new-mix').onclick = () => { newMix(); renderMixes(); };
    $('#gen-mix').onclick = openGenerator;
    const close = () => { $('#drawer').hidden = true; if (view === 'tracks') renderTracks(); if (view === 'mixes') renderMixes(); };
    $('.drawer-back').onclick = close;
    $('.drawer .close').onclick = close;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#drawer').hidden) close(); });
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
    setView(['records', 'tracks', 'mixes', 'settings'].includes(v) ? v : 'records');
    remoteLoad(false).catch(() => {});
  }
  boot();
})();
