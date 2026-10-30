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
  const srcTag = (e) => { const [tag, why] = SRC[e.src] || SRC.pending; return `<span role="button" tabindex="0" data-why="${esc(tag + ': ' + why)}" class="src src-${tag === '…' ? 'pending' : tag === 'est.' ? 'est' : tag}" title="${esc(why)}">${tag}</span>`; };

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
  const ADD_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>';
  const SP_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M7.5 9.6c3-.9 6.4-.6 9.1.9M8 12.6c2.5-.7 5.1-.4 7.3.8M8.6 15.4c1.9-.5 3.8-.3 5.4.6"/></svg>';
  const SP_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
  const SP_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>';
  const SP_NEXT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6v12l8-6zM12 6v12l8-6z" fill="currentColor"/><rect x="19" y="6" width="2" height="12" rx=".8" fill="currentColor"/></svg>';
  const SP_PREV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v12l-8-6zM12 6v12l-8-6z" fill="currentColor"/><rect x="3" y="6" width="2" height="12" rx=".8" fill="currentColor"/></svg>';
  const ytSearch = (t) => `https://www.youtube.com/results?search_query=${encodeURIComponent(`${t.artist} ${t.title}`)}`;
  function playBtn(t) {
    const on = playing === 'p:' + t.k;
    const quick = `<button class="play${on ? ' on' : ''}" data-play="${esc(t.k)}" title="Quick listen (30 s preview)" aria-label="Preview ${esc(t.title)}">${on ? PAUSE_SVG : PLAY_SVG}</button>`;
    const video = t.yt
      ? `<button class="ytb${playing === 'v:' + t.k ? ' on' : ''}" data-yt="${esc(t.k)}" title="Watch the YouTube video linked on Discogs" aria-label="YouTube video of ${esc(t.title)}">${YT_SVG}</button>`
      : `<a class="ytb none" href="${ytSearch(t)}" target="_blank" rel="noopener" title="No video linked on Discogs: search YouTube" aria-label="Search YouTube for ${esc(t.title)}">${YT_SVG}</a>`;
    const full = spOn() ? `<button class="spb${playing === 's:' + t.k ? ' on' : ''}" data-sp="${esc(t.k)}" title="Play the full track with Spotify" aria-label="Play ${esc(t.title)} on Spotify">${SP_SVG}</button>` : '';
    return `<span class="snips">${quick}${video}${full}</span>`;
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
    $$('[data-play], [data-yt], [data-video], [data-sp]').forEach((b) => {
      const key = b.dataset.play ? 'p:' + b.dataset.play : b.dataset.sp ? 's:' + b.dataset.sp : 'v:' + (b.dataset.yt || b.dataset.video);
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
    p.classList.toggle('sp', key.startsWith('s:'));
    document.body.classList.add('has-player');
    requestAnimationFrame(() => p.classList.add('show'));
    playing = key;
    markPlaying();
  }
  function closePlayer() {
    const p = $('#player');
    audio.pause();
    if (playing && playing.startsWith('s:')) spStop();
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
    if (playing && playing.startsWith('s:')) spStop();
    showPlayer(key, title, sub + ' · YouTube', { href: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, label: 'Open in YouTube ↗' });
    $('#player .pl-media').innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&playsinline=1&rel=0&modestbranding=1" title="YouTube video" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
  }
  async function previewTrack(k) {
    const t = byKey.get(k);
    if (!t) return;
    const key = 'p:' + k;
    if (playing === key) { closePlayer(); return; }
    if (playing && playing.startsWith('s:')) spStop();
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

  // ---------- Spotify: full tracks through your own Premium account ----------
  // Login is OAuth with PKCE, so only a public client ID lives here and the token stays in this browser.
  // Computers play inside the page (Web Playback SDK); phones can't, so there Crate drives the Spotify app (Spotify Connect).
  const SP = { token: store.get('sp', null), ready: null, uris: [], keys: [], poll: 0, sdk: null };
  // Matches made before Crate asked for your country's catalogue can point at releases you can't play, so they're redone once.
  const spMatches = store.get('spMatchV') === 2 ? store.get('spMatch', {}) : {};
  store.set('spMatchV', 2);
  const SP_SCOPES = 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state';
  const spRedirect = () => location.origin + location.pathname;
  function spOn() { return !!(settings.spClient && SP.token); }
  const canSdk = !/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) && !(navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  async function spLogin() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    store.set('spVerifier', verifier);
    location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
      client_id: settings.spClient, response_type: 'code', redirect_uri: spRedirect(),
      code_challenge_method: 'S256', code_challenge: challenge, scope: SP_SCOPES,
    });
  }
  function spLogout() { SP.token = null; store.set('sp', null); spStop(); }
  async function spTokenRequest(params) {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: settings.spClient, ...params }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.error || r.status);
    SP.token = { access: j.access_token, refresh: j.refresh_token || (SP.token && SP.token.refresh), exp: Date.now() + (j.expires_in - 60) * 1000 };
    store.set('sp', SP.token);
  }
  async function spCallback() {
    const q = new URLSearchParams(location.search);
    if (!q.get('code') && !q.get('error')) return;
    history.replaceState(null, '', spRedirect() + '#settings');
    if (q.get('error')) { toast('Spotify login cancelled'); return; }
    try {
      await spTokenRequest({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: spRedirect(), code_verifier: store.get('spVerifier', '') });
      toast('Spotify connected: tracks now have a Spotify button');
    } catch (e) { toast('Spotify login failed: ' + e.message); }
  }
  async function spAccess() {
    if (!SP.token) throw new Error('connect Spotify in Settings first');
    if (Date.now() > SP.token.exp) {
      try { await spTokenRequest({ grant_type: 'refresh_token', refresh_token: SP.token.refresh }); }
      catch (e) { spLogout(); throw new Error('Spotify login expired, connect again in Settings'); }
    }
    return SP.token.access;
  }
  async function sp(path, opts = {}) {
    const r = await fetch('https://api.spotify.com/v1' + path, { ...opts, headers: { Authorization: 'Bearer ' + (await spAccess()), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (r.status === 204 || r.status === 202) return null;
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const e = new Error((j && j.error && j.error.message) || 'error ' + r.status);
      e.status = r.status; e.reason = j && j.error && j.error.reason;
      throw e;
    }
    return j;
  }
  // Same matching rules as the previews; the answer is remembered so each track is searched once.
  async function spFind(t) {
    if (t.k in spMatches) return spMatches[t.k];
    const title = t.title.replace(/\s*[([].*?[)\]]/g, '').trim();
    const artist = /^various/i.test(t.artist) ? '' : t.artist.replace(/\s*\(\d+\)$/, '');
    let hit = null;
    for (const q of [`track:${title}${artist ? ` artist:${artist}` : ''}`, `${artist} ${title}`]) {
      const j = await sp('/search?type=track&market=from_token&limit=10&q=' + encodeURIComponent(q));
      hit = pickHit(t, j.tracks && j.tracks.items.filter((x) => x.is_playable !== false), (x) => x.name, (x) => x.artists.map((a) => a.name).join(' '));
      if (hit) break;
    }
    spMatches[t.k] = hit ? hit.uri : '';
    store.set('spMatch', spMatches);
    return spMatches[t.k];
  }
  function spSdk() {
    if (SP.ready) return SP.ready;
    SP.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the Spotify player did not start')), 15000);
      window.onSpotifyWebPlaybackSDKReady = () => {
        const pl = new window.Spotify.Player({ name: 'Crate', getOAuthToken: (cb) => spAccess().then(cb, () => {}), volume: 0.8 });
        pl.addListener('ready', ({ device_id }) => { clearTimeout(timer); resolve(device_id); });
        pl.addListener('initialization_error', (e) => reject(new Error(e.message)));
        pl.addListener('authentication_error', (e) => reject(new Error(e.message)));
        pl.addListener('account_error', () => reject(new Error('Spotify Premium is needed for full tracks')));
        pl.addListener('player_state_changed', (st) => { if (!st) return; const c = st.track_window.current_track; spShow(c && c.uri, st.paused, st.position, st.duration, c && c.name); });
        pl.connect();
        SP.sdk = pl;
      };
      const sc = document.createElement('script');
      sc.src = 'https://sdk.scdn.co/spotify-player.js';
      sc.onerror = () => reject(new Error('could not load the Spotify player'));
      document.head.appendChild(sc);
    });
    SP.ready.catch(() => { SP.ready = null; });
    return SP.ready;
  }
  async function spDevice() {
    if (canSdk) return spSdk();
    const j = await sp('/me/player/devices');
    const d = j.devices.find((x) => x.is_active) || j.devices.find((x) => /smartphone/i.test(x.type)) || j.devices[0];
    return d ? d.id : null;
  }
  function spMsg(html) {
    $('#player .pl-media').innerHTML = `<p class="sub">${html}</p>`;
  }
  // Plays one track, or a whole mix in order from `start`.
  // The record as an album on Spotify, with its track list, found once and remembered.
  async function spAlbum(r) {
    const ck = 'album:' + r.id;
    if (ck in spMatches) return spMatches[ck];
    const title = r.title.replace(/\s*[([].*?[)\]]/g, '').trim();
    const artist = /^various/i.test(r.artist) ? '' : r.artist.replace(/\s*\(\d+\)$/, '');
    // Several editions can share a name and some aren't playable where you are, so the first edition with playable tracks wins.
    let found = '';
    const tried = new Set();
    for (const q of [`album:${title}${artist ? ` artist:${artist}` : ''}`, `${artist} ${title}`]) {
      const j = await sp('/search?type=album&market=from_token&limit=10&q=' + encodeURIComponent(q));
      let items = (j.albums && j.albums.items || []).filter((x) => !tried.has(x.id));
      for (let n = 0; n < 3 && !found; n++) {
        const hit = pickHit({ title, artist: r.artist }, items, (x) => x.name, (x) => x.artists.map((a) => a.name).join(' '));
        if (!hit) break;
        tried.add(hit.id);
        items = items.filter((x) => x !== hit);
        const tj = await sp(`/albums/${hit.id}/tracks?market=from_token&limit=50`);
        const tracks = (tj.items || []).filter((x) => x.is_playable !== false).map((x) => ({ uri: x.uri, name: x.name }));
        if (tracks.length) found = { uri: hit.uri, id: hit.id, tracks };
      }
      if (found) break;
    }
    spMatches[ck] = found;
    store.set('spMatch', spMatches);
    return found;
  }
  // Pairs the record's tracks with the album's: by title, else by running order.
  function spAlbumMap(r, album) {
    const map = new Map(), used = new Set();
    r.tracks.forEach((t, i) => {
      const hit = pickHit(t, album.tracks.filter((x) => !used.has(x.uri)), (x) => x.name, () => t.artist);
      const x = hit || (album.tracks.length === r.tracks.length ? album.tracks[i] : null);
      if (x && !used.has(x.uri)) { used.add(x.uri); map.set(t.k, x.uri); }
    });
    return map;
  }

  // A record plays as its album on Spotify, so Spotify itself handles next, previous and carrying on to the
  // next track, even with Crate in the background. A mix (or a record that isn't there as an album) plays as a list.
  async function spPlay(keys, start = 0, record = null) {
    const first = byKey.get(keys[start]);
    if (!first) return;
    const key = 's:' + first.k;
    if (playing === key) { closePlayer(); return; }
    audio.pause();
    SP.retry = null;
    showPlayer(key, first.title, `${first.artist} · finding it on Spotify…`, null);
    spMsg('');
    try {
      let body = null;
      SP.uris = []; SP.keys = []; SP.mode = 'list'; SP.fellBack = false; SP.ended = false; SP.seen = false; SP.skipping = null; clearTimeout(SP.endT);
      if (record) {
        const album = await spAlbum(record).catch(() => '');
        if (playing !== key) return;
        if (album) {
          const map = spAlbumMap(record, album);
          if (map.has(first.k)) {
            SP.mode = 'album'; SP.album = album;
            SP.uris = album.tracks.map((x) => x.uri);
            SP.keys = SP.uris.map((u) => [...map].find(([, v]) => v === u)?.[0] || null);
            body = { context_uri: album.uri, offset: { uri: map.get(first.k) } };
          }
        }
      }
      if (!body) {
        const firstUri = await spFind(first);
        if (playing !== key) return;
        if (!firstUri) {
          $('#player .pl-info small').textContent = `${first.artist} · ${first.r.title} · ${first.pos}`;
          spMsg('Not on Spotify, as far as Crate can tell. Try ▶ or YouTube.');
          return;
        }
        for (let i = 0; i < keys.length; i++) {
          const t = byKey.get(keys[i]);
          if (!t) continue;
          if (keys.length > 1 && !(t.k in spMatches)) $('#player .pl-info small').textContent = `Lining up the ${keys.length} tracks on Spotify… ${i + 1}`;
          const u = await spFind(t);
          if (playing !== key) return;
          if (u) { SP.uris.push(u); SP.keys.push(t.k); }
        }
        body = { uris: SP.uris, offset: { position: SP.keys.indexOf(first.k) } };
      }
      $('#player .pl-media').innerHTML = `<div class="sp-ctl">
        <div class="sp-bar"><i></i></div><div class="sp-times"><span class="sp-pos">0:00</span><span class="sp-where"></span><span class="sp-dur"></span></div>
        <div class="sp-btns"><button data-spc="previous" aria-label="Previous track">${SP_PREV}</button><button data-spc="toggle" class="sp-main" aria-label="Pause">${SP_PAUSE}</button><button data-spc="next" aria-label="Next track">${SP_NEXT}</button></div>
        <a class="sp-open" href="${spOpenUrl(body)}" target="_blank" rel="noopener">Open in Spotify ↗</a></div>`;
      $$('#player [data-spc]').forEach((b) => (b.onclick = () => spControl(b.dataset.spc)));
      spSeekBar($('#player .sp-bar'));
      SP.body = body;
      await spStart(body, key);
      clearInterval(SP.poll);
      SP.poll = setInterval(spPoll, 1000);
    } catch (e) {
      if (playing !== key) return;
      $('#player .pl-info small').textContent = `${first.artist} · ${first.r.title} · ${first.pos}`;
      spMsg(e.status === 403 ? 'Spotify refused to play: full tracks need Premium, and the app has to list your account under Users in the Spotify dashboard.' : 'Spotify: ' + esc(e.message));
    }
  }
  const spOpenUrl = (body) => body.context_uri ? `https://open.spotify.com/album/${body.context_uri.split(':').pop()}` : `https://open.spotify.com/track/${body.uris[body.offset.position].split(':').pop()}`;
  // Starts playback on this computer or on the phone's Spotify app. If the app isn't awake, says so plainly and
  // tries again by itself as soon as you come back to Crate from Spotify.
  async function spStart(body, key) {
    const wake = () => {
      SP.retry = () => spStart(body, key);
      const m = $('#player .sp-where');
      if (m) m.textContent = '';
      $('#player .pl-info small').textContent = 'Spotify needs to be open: tap Open Spotify, then come back';
      const o = $('#player .sp-open');
      if (o) { o.textContent = 'Open Spotify ↗'; o.classList.add('wake'); o.href = spOpenUrl(body); }
    };
    let dev;
    try { dev = await spDevice(); } catch (e) { if (e.status === 404) dev = null; else throw e; }
    if (playing !== key) return;
    if (!dev) { wake(); return; }
    try {
      await sp(`/me/player/play?device_id=${encodeURIComponent(dev)}`, { method: 'PUT', body: JSON.stringify(body) });
    } catch (e) {
      if (e.status === 404 || e.reason === 'NO_ACTIVE_DEVICE') { wake(); return; }
      throw e;
    }
    SP.dev = dev; SP.retry = null;
    const o = $('#player .sp-open');
    if (o) { o.textContent = 'Open in Spotify ↗'; o.classList.remove('wake'); }
    SP.at = { pos: 0, dur: 0, t: performance.now(), paused: false };
    const u = body.context_uri ? body.offset.uri : body.uris[body.offset.position];
    spShow(u, false);
    if (!canSdk) setTimeout(spPoll, 1200);
    // If the album edition Spotify picked won't actually play that track, play the track on its own instead.
    if (!canSdk && body.context_uri && !SP.fellBack) setTimeout(async () => {
      if (playing !== key || SP.fellBack) return;
      const st = await sp('/me/player').catch(() => null);
      if (playing !== key || (st && st.is_playing && st.item)) return;
      const t = byKey.get(key.slice(2));
      const solo = t && await spFind(t).catch(() => '');
      if (!solo || playing !== key) return;
      SP.fellBack = true; SP.mode = 'list'; SP.uris = [solo]; SP.keys = [t.k];
      spStart({ uris: [solo], offset: { position: 0 } }, key);
    }, 4000);
  }
  const fmtMs = (ms) => { const sec = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
  // Shows the track Spotify is on, with where it sits in your crate.
  // Crate only plays what's on your shelf: when the record or mix runs out, it stops instead of letting Spotify
  // carry on with its own suggestions, and album tracks your pressing doesn't have are skipped.
  function spEnd() {
    clearTimeout(SP.endT);
    if (SP.ended) return;
    SP.ended = true;
    if (canSdk && SP.sdk) SP.sdk.pause().catch(() => {});
    else sp(`/me/player/pause${SP.dev ? '?device_id=' + encodeURIComponent(SP.dev) : ''}`, { method: 'PUT' }).catch(() => {});
    if (SP.at) SP.at = { ...SP.at, pos: SP.at.dur, paused: true };
    $('#player .pl-info small').textContent = `End of the ${SP.mode === 'album' ? 'record' : 'list'} · ▶ plays it again`;
    const tg = $('#player [data-spc="toggle"]');
    if (tg) { tg.innerHTML = SP_PLAY; tg.setAttribute('aria-label', 'Play again'); tg.dataset.paused = '1'; }
    spTick();
  }
  function spWatchEnd(i, paused, pos, dur) {
    clearTimeout(SP.endT);
    if (SP.ended || paused || pos == null || !dur) return;
    const ownedAfter = SP.keys.some((k, j) => j > i && k);
    if (!ownedAfter) SP.endT = setTimeout(spEnd, Math.max(0, dur - pos - 250));
  }
  function spShow(uri, paused, pos, dur, name) {
    if (!playing || !playing.startsWith('s:')) return;
    if (SP.ended) return;
    const i = SP.uris.indexOf(uri);
    if (uri && pos != null) {
      if (i >= 0) SP.seen = true;
      else if (SP.seen && !paused) { spEnd(); return; } // Spotify has moved on to something that isn't yours
      if (i >= 0 && !SP.keys[i] && !paused && SP.mode === 'album') {
        const nxt = SP.keys.findIndex((k, j) => j > i && k);
        if (nxt < 0) { spEnd(); return; }
        if (SP.skipping !== nxt) {
          SP.skipping = nxt;
          sp(`/me/player/play${SP.dev ? '?device_id=' + encodeURIComponent(SP.dev) : ''}`, { method: 'PUT', body: JSON.stringify({ context_uri: SP.album.uri, offset: { uri: SP.uris[nxt] } }) }).catch(() => {});
        }
      }
    }
    spWatchEnd(i, paused, pos, dur);
    const t = i >= 0 && SP.keys[i] ? byKey.get(SP.keys[i]) : null;
    if (i >= 0) SP.cur = i;
    if (t) {
      $('#player .pl-info b').textContent = t.title;
      $('#player .pl-info small').textContent = `${SP.uris.length > 1 ? `${i + 1}/${SP.uris.length} · ` : ''}${t.artist} · ${t.r.title} · ${t.pos}`;
      if (playing !== 's:' + t.k) { playing = 's:' + t.k; markPlaying(); }
    } else if (name) {
      $('#player .pl-info b').textContent = name;
      $('#player .pl-info small').textContent = i >= 0 ? 'On the album, not on your record' : 'Spotify';
    }
    const w = $('#player .sp-where');
    if (w && i >= 0) w.textContent = SP.uris.length > 1 ? `${i + 1} of ${SP.uris.length}` : '';
    if (pos != null) SP.at = { pos, dur, t: performance.now(), paused };
    else if (SP.at) SP.at.paused = paused;
    const tg = $('#player [data-spc="toggle"]');
    if (tg) { tg.innerHTML = paused ? SP_PLAY : SP_PAUSE; tg.setAttribute('aria-label', paused ? 'Play' : 'Pause'); tg.dataset.paused = paused ? '1' : ''; }
    $('#player .sp-btns [data-spc="next"]')?.toggleAttribute('disabled', SP.cur >= SP.uris.length - 1);
    spTick();
  }
  function spTick() {
    const a = SP.at, bar = $('#player .sp-bar i');
    if (!a || !bar || SP.drag != null) return;
    const pos = Math.min(a.dur || Infinity, a.pos + (a.paused ? 0 : performance.now() - a.t));
    bar.style.width = a.dur ? `${(pos / a.dur) * 100}%` : '0';
    $('#player .sp-pos').textContent = fmtMs(pos);
    $('#player .sp-dur').textContent = a.dur ? fmtMs(a.dur) : '';
  }
  async function spPoll(now) {
    if (!playing || !playing.startsWith('s:')) { clearInterval(SP.poll); return; }
    if (SP.retry) return;
    if (canSdk && SP.sdk) {
      const st = await SP.sdk.getCurrentState().catch(() => null);
      if (st) { const c = st.track_window.current_track; spShow(c && c.uri, st.paused, st.position, st.duration, c && c.name); }
      return;
    }
    spTick();
    if (now !== true && (SP.polls = (SP.polls || 0) + 1) % 3) return;
    try { const st = await sp('/me/player'); if (st && st.item) spShow(st.item.uri, !st.is_playing, st.progress_ms, st.item.duration_ms, st.item.name); } catch { /* try again next tick */ }
  }
  // The progress line doubles as a scrubber: touch or drag along it, let go, and Spotify jumps there.
  function spSeekBar(bar) {
    const frac = (ev) => { const r = bar.getBoundingClientRect(); return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)); };
    bar.onpointerdown = (e) => {
      if (!SP.at || !SP.at.dur || SP.retry) return;
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('seeking');
      const small = $('#player .pl-info small'), was = small.textContent;
      const show = (ev) => {
        SP.drag = frac(ev);
        bar.firstElementChild.style.width = `${SP.drag * 100}%`;
        small.textContent = `${fmtMs(SP.drag * SP.at.dur)} / ${fmtMs(SP.at.dur)}`;
      };
      show(e);
      bar.onpointermove = show;
      bar.onpointerup = bar.onpointercancel = (ev) => {
        bar.onpointermove = bar.onpointerup = bar.onpointercancel = null;
        bar.classList.remove('seeking');
        small.textContent = was;
        const f = SP.drag;
        SP.drag = null;
        if (ev.type === 'pointerup' && f != null) spSeek(Math.round(f * SP.at.dur));
        else spTick();
      };
    };
  }
  async function spSeek(ms) {
    SP.at = { ...SP.at, pos: ms, t: performance.now() };
    spTick();
    spWatchEnd(SP.cur, SP.at.paused, ms, SP.at.dur);
    try {
      if (canSdk && SP.sdk) await SP.sdk.seek(ms);
      else await sp(`/me/player/seek?position_ms=${ms}${SP.dev ? `&device_id=${encodeURIComponent(SP.dev)}` : ''}`, { method: 'PUT' });
    } catch (e) { toast('Spotify: ' + e.message); }
    if (!canSdk) setTimeout(() => spPoll(true), 800);
  }
  async function spControl(what) {
    if (SP.retry) { SP.retry(); return; }
    const dev = SP.dev ? `?device_id=${encodeURIComponent(SP.dev)}` : '';
    try {
      if (what === 'toggle' && SP.ended) {
        SP.ended = false; SP.seen = false; SP.skipping = null;
        const first = SP.keys.find(Boolean);
        const body = SP.mode === 'album' ? { context_uri: SP.album.uri, offset: { uri: SP.uris[SP.keys.indexOf(first)] } } : { uris: SP.uris, offset: { position: 0 } };
        await spStart(body, playing);
        return;
      }
      if (what === 'toggle') {
        const paused = $('#player [data-spc="toggle"]').dataset.paused;
        if (canSdk && SP.sdk) await SP.sdk.togglePlay();
        else await sp(`/me/player/${paused ? 'play' : 'pause'}${dev}`, { method: 'PUT' });
        spShow(SP.uris[SP.cur], !paused);
      } else if (canSdk && SP.sdk) {
        await (what === 'next' ? SP.sdk.nextTrack() : SP.sdk.previousTrack());
      } else {
        await sp(`/me/player/${what}${dev}`, { method: 'POST' }); // Spotify moves within the album or list it is playing
        if (what === 'next' && SP.cur < SP.uris.length - 1) spShow(SP.uris[SP.cur + 1], false, 0, 0);
      }
      if (!canSdk) setTimeout(() => spPoll(true), 800);
    } catch (e) {
      if (e.status === 404 || e.reason === 'NO_ACTIVE_DEVICE') { SP.retry = () => spStart(SP.body, playing); toast('Spotify went to sleep: tap Open Spotify, then come back'); return; }
      toast('Spotify: ' + e.message);
    }
  }
  // Coming back from the Spotify app: start what was waiting, or catch up with what's playing now.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !playing || !playing.startsWith('s:')) return;
    if (SP.retry) setTimeout(() => SP.retry && SP.retry(), 700);
    else spPoll(true);
  });
  function spStop() {
    clearInterval(SP.poll);
    if (canSdk && SP.sdk) SP.sdk.pause().catch(() => {});
    else if (SP.token && SP.uris.length) sp(`/me/player/pause${SP.dev ? '?device_id=' + encodeURIComponent(SP.dev) : ''}`, { method: 'PUT' }).catch(() => {});
    SP.uris = []; SP.keys = []; SP.at = null; SP.retry = null;
    clearTimeout(SP.endT);
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
      `<span class="count">${list.length} of ${all.length} records</span>` +
      `<button type="button" class="crate-btn" title="Flick through covers. Turning the phone sideways opens it too."><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="5" width="6" height="14" rx="1"/><path d="M6.5 6.5 3 8v8l3.5 1.5M17.5 6.5 21 8v8l-3.5 1.5"/></svg>Crate</button>`;
    recordList = list;
    $('#record-filters .crate-btn').onclick = () => { store.set('crateSideways', true); openCrate(); };
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

  // ---------- Crate mode: flick through the covers of the records shown in Records ----------
  // Our own physics instead of native scrolling: a small pool of covers is moved with transforms only,
  // a flick carries on with momentum and settles on the nearest record.
  let recordList = [];
  const CF = { pos: 0, target: 0, raf: 0, last: 0, drag: null, slots: [], shown: -1, W: 0 };
  const SLOTS = 19, HALF = 9;
  const coverUrl = (r) => (r.cover && !/spacer\.gif/.test(r.cover) ? r.cover : '');
  function openCrate() {
    if (!recordList.length) return;
    const el = $('#crate');
    el.hidden = false;
    document.body.classList.add('crate-on');
    const stage = $('.cf', el);
    if (!CF.slots.length) {
      stage.innerHTML = Array.from({ length: SLOTS }, () => '<div class="cf-cover"><img alt="" decoding="async" draggable="false"></div>').join('');
      CF.slots = [...stage.children];
    }
    CF.slots.forEach((c) => { c.dataset.i = ''; c.firstChild.removeAttribute('src'); });
    CF.pos = CF.target = Math.min(Math.round(CF.pos), recordList.length - 1);
    CF.shown = -1;
    CF.W = CF.slots[0].offsetWidth;
    crateRender();
  }
  function closeCrate() {
    if (FL.open) flipClose(true);
    $('#crate').hidden = true;
    document.body.classList.remove('crate-on');
    cancelAnimationFrame(CF.raf); CF.raf = 0;
  }
  function crateGo(i) {
    CF.target = Math.max(0, Math.min(recordList.length - 1, i));
    crateKick();
  }
  function crateKick() {
    if (!CF.raf) { CF.last = performance.now(); CF.raf = requestAnimationFrame(crateTick); }
  }
  function crateTick(now) {
    const dt = Math.min(64, now - CF.last); CF.last = now;
    if (!CF.drag) {
      const d = CF.target - CF.pos;
      CF.pos = Math.abs(d) < 0.002 ? CF.target : CF.pos + d * (1 - Math.exp(-dt / (reduceMotion() ? 1 : 105)));
    }
    crateRender();
    CF.raf = CF.drag || CF.pos !== CF.target ? requestAnimationFrame(crateTick) : 0;
  }
  function crateRender() {
    const W = CF.W || 1, n = recordList.length, base = Math.round(CF.pos);
    const gap = W * 0.62, step = W * 0.16;
    CF.slots.forEach((c, j) => {
      const i = base + j - HALF;
      if (i < 0 || i >= n) { c.style.visibility = 'hidden'; return; }
      c.style.visibility = '';
      if (c.dataset.i !== String(i)) {
        c.dataset.i = i;
        const url = coverUrl(recordList[i]);
        if (url) c.firstChild.src = url; else c.firstChild.removeAttribute('src');
      }
      const d = i - CF.pos, a = Math.abs(d), sg = Math.sign(d), k = Math.min(a, 1);
      const x = sg * (k * gap + Math.max(0, a - 1) * step);
      // iPod look: the record in front faces you, the rest stand in two tight rows turned 70° away
      c.style.transform = `translate3d(${x.toFixed(1)}px,0,0) perspective(700px) translateZ(${((1 - k) * 90).toFixed(1)}px) rotateY(${(-sg * 70 * k).toFixed(2)}deg)`;
      c.style.zIndex = 100 - Math.round(a * 10);
      c.style.opacity = a > HALF - 1 ? Math.max(0, HALF - a) : 1;
    });
    const i = Math.max(0, Math.min(n - 1, Math.round(CF.pos)));
    if (i !== CF.shown) {
      CF.shown = i;
      const r = recordList[i];
      $('#crate .cf-info').innerHTML = `<b>${esc(r.title)}</b><span>${esc(r.artist)}</span><small>${esc([r.labels[0]?.name, r.labels[0]?.catno, r.year].filter(Boolean).join(' · '))}</small>`;
      $('#crate .cf-count').textContent = `${i + 1} of ${n}`;
    }
  }
  // Tap the record in front (or the wheel's centre) and it turns round like a sleeve in your hands: the back shows its tracks.
  const FL = { open: false, i: -1, slot: null, from: '' };
  function flipBack(r) {
    const url = coverUrl(r);
    return `<div class="fl-head">${url ? `<img src="${esc(url)}" alt="">` : ''}<div><b>${esc(r.title)}</b><span>${esc(r.artist)}</span><small>${esc([r.labels[0]?.name, r.labels[0]?.catno, r.year].filter(Boolean).join(' · '))}</small></div><button class="fl-open">Open record</button></div>
      <ol class="fl-list">${r.tracks.map((t) => { const e = eff(t); return `<li><span class="fl-pos">${esc(t.pos)}</span><div class="fl-t"><b>${esc(t.title)}</b>${t.artist !== r.artist ? `<small>${esc(t.artist)}</small>` : ''}</div><span class="fl-meta">${[e.bpm, e.cam].filter(Boolean).map(esc).join(' · ')}</span>${playBtn(t)}</li>`; }).join('') || '<li class="sub">No tracklist yet.</li>'}</ol>`;
  }
  function flipOpen(i) {
    const r = recordList[i], slot = CF.slots.find((c) => c.dataset.i === String(i));
    if (!r || !slot || FL.open) return;
    const box = $('#crate .cf-flip'), card = $('.fl-card', box);
    const url = coverUrl(r);
    if (url) $('.fl-front img', box).src = url; else $('.fl-front img', box).removeAttribute('src');
    $('.fl-back', box).innerHTML = flipBack(r);
    $('.fl-back .fl-open', box).onclick = () => openRecord(r);
    box.hidden = false;
    card.style.transition = 'none';
    card.style.transform = '';
    const to = card.getBoundingClientRect(), from = slot.getBoundingClientRect();
    FL.from = `translate(${(from.left + from.width / 2 - to.left - to.width / 2).toFixed(1)}px,${(from.top + from.height / 2 - to.top - to.height / 2).toFixed(1)}px) scale(${(from.width / to.width).toFixed(4)},${(from.height / to.height).toFixed(4)}) rotateY(0deg)`;
    card.style.transform = FL.from;
    void card.offsetWidth;
    card.style.transition = '';
    Object.assign(FL, { open: true, i, slot });
    slot.classList.add('away');
    box.classList.add('on');
    card.style.transform = 'translate(0px,0px) scale(1,1) rotateY(180deg)';
    $('.fl-back', box).scrollTop = 0;
  }
  function flipClose(now) {
    if (!FL.open) return;
    const box = $('#crate .cf-flip'), card = $('.fl-card', box), slot = FL.slot;
    FL.open = false;
    box.classList.remove('on');
    const done = () => { box.hidden = true; slot.classList.remove('away'); };
    if (now || reduceMotion()) { done(); return; }
    card.style.transform = FL.from;
    setTimeout(done, 560);
  }
  // A click wheel, like the iPod's: run a finger round the ring to move one record per notch (faster turns skip more),
  // press the centre to turn the record over, MENU goes back, ⏯ plays the record in front.
  function wireWheel(w) {
    let g = null;
    const geo = (e) => {
      const r = w.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      return { a: Math.atan2(dy, dx) * 180 / Math.PI, rad: Math.hypot(dx, dy) / (r.width / 2) };
    };
    const step = (k) => {
      if (FL.open) { $('#crate .fl-back').scrollBy({ top: k * 44 }); return; }
      crateGo(Math.round(CF.target) + k);
    };
    w.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      w.setPointerCapture(e.pointerId);
      const p = geo(e);
      g = { ...p, acc: 0, turned: 0, t0: performance.now(), lt: performance.now() };
      w.classList.add('held');
    });
    w.addEventListener('pointermove', (e) => {
      if (!g || g.rad < 0.4) return;
      const p = geo(e), now = performance.now();
      let d = p.a - g.a;
      if (d > 180) d -= 360; else if (d < -180) d += 360;
      g.a = p.a;
      g.turned += Math.abs(d);
      const speed = Math.abs(d) / Math.max(8, now - g.lt) * 1000; // degrees per second
      g.lt = now;
      g.acc += d * (speed > 700 ? 2.5 : speed > 350 ? 1.6 : 1);
      const NOTCH = 20;
      while (g.acc >= NOTCH) { g.acc -= NOTCH; step(1); }
      while (g.acc <= -NOTCH) { g.acc += NOTCH; step(-1); }
    });
    const end = (e) => {
      if (!g) return;
      w.classList.remove('held');
      const tap = g.turned < 10 && performance.now() - g.t0 < 600, p = g;
      g = null;
      if (!tap || e.type !== 'pointerup') return;
      const r = recordList[Math.round(CF.pos)];
      if (p.rad < 0.4) { FL.open ? flipClose() : flipOpen(Math.round(CF.pos)); return; }
      const a = p.a;
      if (a >= -135 && a < -45) FL.open ? flipClose() : closeCrate();
      else if (a >= -45 && a < 45) step(1);
      else if (a >= 135 || a < -135) step(-1);
      else if (r && r.tracks.length) {
        if (spOn()) spPlay(r.tracks.map((t) => t.k), 0, r);
        else previewTrack(r.tracks[0].k);
      }
    };
    w.addEventListener('pointerup', end);
    w.addEventListener('pointercancel', end);
  }
  function wireCrate() {
    const el = $('#crate');
    const stage = $('.cf', el);
    const per = () => (CF.W || 1) * 0.36; // finger travel for one record
    stage.addEventListener('pointerdown', (e) => {
      stage.setPointerCapture(e.pointerId);
      CF.drag = { x: e.clientX, pos: CF.pos, moved: 0, t0: performance.now(), samples: [[performance.now(), e.clientX]] };
      crateKick();
    });
    stage.addEventListener('pointermove', (e) => {
      const g = CF.drag; if (!g) return;
      const dx = e.clientX - g.x;
      g.moved = Math.max(g.moved, Math.abs(dx));
      let p = g.pos - dx / per();
      const n = recordList.length - 1;
      if (p < 0) p /= 3; else if (p > n) p = n + (p - n) / 3; // rubber band at the ends
      CF.pos = p;
      const now = performance.now();
      g.samples.push([now, e.clientX]);
      while (g.samples.length > 2 && now - g.samples[0][0] > 100) g.samples.shift();
    });
    const end = (e) => {
      const g = CF.drag; if (!g) return;
      CF.drag = null;
      if (g.moved < 8 && performance.now() - g.t0 < 400) {
        const hit = document.elementFromPoint(e.clientX, e.clientY), c = hit && hit.closest('.cf-cover');
        const i = c && c.dataset.i !== '' ? +c.dataset.i : null;
        CF.pos = g.pos;
        if (i === Math.round(CF.pos)) flipOpen(i); else if (i != null) crateGo(i); else crateGo(Math.round(CF.pos));
        return;
      }
      const [t0, x0] = g.samples[0], [t1, x1] = g.samples[g.samples.length - 1];
      const v = t1 > t0 ? -(x1 - x0) / (t1 - t0) / per() : 0; // records per ms
      crateGo(Math.round(CF.pos + v * 240)); // a flick carries on, then settles on a record
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    let wheelT = 0;
    stage.addEventListener('wheel', (e) => {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      e.preventDefault();
      CF.pos = Math.max(0, Math.min(recordList.length - 1, CF.pos + d / per() / 2));
      CF.target = CF.pos;
      crateRender();
      clearTimeout(wheelT);
      wheelT = setTimeout(() => crateGo(Math.round(CF.pos)), 120);
    }, { passive: false });
    wireWheel($('.cf-wheel', el));
    $('.cf-flip', el).addEventListener('click', (e) => { if (e.target === e.currentTarget) flipClose(); });
    $('.cf-close', el).onclick = () => (FL.open ? flipClose() : closeCrate());
    $('.cf-grid', el).onclick = () => { store.set('crateSideways', false); closeCrate(); toast('Grid view. Tap Crate to flick through again.'); };
    $('.cf-open', el).onclick = () => openRecord(recordList[Math.round(CF.pos)]);
    document.addEventListener('keydown', (e) => {
      if (el.hidden || $('#drawer').classList.contains('open')) return;
      if (FL.open && e.key !== 'Escape' && e.key !== 'Enter') return;
      if (e.key === 'ArrowRight') crateGo(Math.round(CF.target) + 1);
      if (e.key === 'ArrowLeft') crateGo(Math.round(CF.target) - 1);
      if (e.key === 'Enter') FL.open ? flipClose() : flipOpen(Math.round(CF.pos));
      if (e.key === 'Escape') FL.open ? flipClose() : closeCrate();
    });
    window.addEventListener('resize', () => { if (!el.hidden) { CF.W = CF.slots[0].offsetWidth; crateRender(); } });
    // Like the iPod: turn the phone sideways on Records and the crate opens, unless you chose the grid.
    const sideways = matchMedia('(orientation: landscape) and (max-height: 500px)');
    const auto = () => {
      if (sideways.matches && view === 'records' && store.get('crateSideways', true) && !$('#drawer').classList.contains('open')) openCrate();
      else if (!sideways.matches && !el.hidden) closeCrate();
    };
    sideways.addEventListener('change', auto);
    setTimeout(auto, 300);
  }

  function openRecord(r) {
    const mix = currentMix();
    const rows = r.tracks.map((t) => {
      const e = eff(t);
      return `<tr data-k="${esc(t.k)}"><td class="pos">${esc(t.pos)}</td><td><div class="tt">${playBtn(t)}<div><b>${esc(t.title)}</b>${t.artist !== r.artist ? `<br><small>${esc(t.artist)}</small>` : ''}<small class="s-only">${esc(t.pos)}${t.dur ? ' · ' + fmtDur(t.dur) : ''} ${srcTag(e)}</small></div></div></td>
        <td class="num">${fmtDur(t.dur)}</td>
        <td class="num"><input class="bpm-in" value="${e.bpm ?? ''}" placeholder="BPM" inputmode="numeric"></td>
        <td><input class="key-in" value="${e.cam ?? ''}" placeholder="Key" title="${esc(e.key || 'Type 8A, Am, F#m…')}"></td><td>${srcTag(e)}</td>
        <td><button class="small add" title="Add to ${esc(mix ? mix.name : 'a new mix')}" aria-label="Add to mix">${ADD_SVG}<span class="al">Mix</span></button></td></tr>`;
    }).join('');
    $('#drawer-body').innerHTML = `
      ${r.cover ? `<div class="rec-bg" style="background-image:url('${esc(r.cover)}')"></div>` : ''}
      <div class="rec-head">${r.cover ? `<img src="${esc(r.cover)}" alt="">` : '<div class="nocover rec-nocover"></div>'}<div>
        <h2>${esc(r.title)}</h2><p class="artist">${esc(r.artist)}</p>
        <p>${esc(r.labels.map((l) => `${l.name} – ${l.catno}`).join(', '))}</p>
        <p>${esc([r.format, r.country, r.year].filter(Boolean).join(' · '))}</p>
        <p class="tags">${[...r.genres, ...r.styles].map((g) => `<span>${esc(g)}</span>`).join('')}</p>
        <p><a class="ext" href="${esc(r.url)}" target="_blank" rel="noopener">Open on Discogs ↗</a></p></div></div>
      <div class="table-wrap"><table class="tl"><thead><tr><th>Pos</th><th>Track</th><th>Time</th><th>BPM</th><th>Key</th><th title="Where the BPM and key came from. Tap a tag to see what it means.">Source</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7">No tracklist yet.</td></tr>'}</tbody></table></div>
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

    const head = [['pos', 'Pos'], ['title', 'Track'], ['artist', 'Artist'], ['record', 'Record'], ['bpm', 'BPM'], ['key', 'Key'], ['src', 'Source'], ['dur', 'Time'], ['year', 'Year'], ['label', 'Label']];
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
          <td><button class="small add" title="Add to ${esc(mix ? mix.name : 'a new mix')}" aria-label="Add to mix">${ADD_SVG}</button></td></tr>`;
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

  // Bridge: a path from one track to another through your own records. Each step moves a fraction of the way
  // from A to B in tempo, sound and energy, and the last one has to hand over cleanly to B. A small beam search
  // keeps a few candidate paths alive so one greedy early choice can't strand the mix.
  function generateBridge(o) {
    const A = trackObj(o.a), B = trackObj(o.b);
    if (!A || !B) return { error: 'Pick a start and an end track first' };
    if (A.k === B.k) return { error: 'Pick two different tracks' };
    const keys = !o.nokeys, range = settings.pitchRange;
    const k = Math.max(1, Math.min(+o.n || 6, 20));
    const pool = TRACKS.map((t) => trackObj(t.k)).filter((t) => t.bpm && (t.cam || !keys) && t.k !== A.k && t.k !== B.k &&
      (!o.genre || t.r.genres.includes(o.genre)) && (!o.style || t.r.styles.includes(o.style)));
    if (pool.length < k) return { error: `Not enough tracks with BPM${keys ? ' and key' : ''} to build that bridge.` };
    const near = (bpm, tgt) => Math.min(...[1, 2, 0.5].map((m) => Math.abs(bpm * m - tgt) / tgt));
    const f = (i) => i / (k + 1);
    const bpmT = (i) => (A.bpm && B.bpm ? A.bpm + (B.bpm - A.bpm) * f(i) : null);
    const vA = A.snd && A.snd.v, vB = B.snd && B.snd.v;
    const vT = (i) => (vA && vB ? vA.map((x, j) => x + (vB[j] - x) * f(i)) : null);
    const eA = A.snd && A.snd.e, eB = B.snd && B.snd.e;
    const eT = (i) => (eA != null && eB != null ? eA + (eB - eA) * f(i) : null);
    const step = (prev, c, i) => {
      if (c.r === prev.r) return null;
      const tr = C.transition(prev, c, { pitchRange: range });
      if (!tr.bpmScore || (keys && tr.pitched.score === 0)) return null;
      const fb = feedback(prev.k, c.k);
      if (fb < 0) return null;
      const st = keys ? tr.score : tr.bpmScore;
      let sc = st * 0.35 + affinity(prev, c) * 0.15 + fb * 0.5;
      const tb = bpmT(i);
      sc += 0.2 * (tb ? Math.max(0, 1 - near(c.bpm, tb) / 0.06) : st);
      const tv = vT(i);
      sc += 0.2 * (tv && c.snd ? Math.max(0, Math.min(1, (soundSim(c.snd, { v: tv }) + 0.45) / 1.25)) : 0.4);
      const te = eT(i);
      sc += 0.1 * (te != null && c.snd && c.snd.e != null ? Math.max(0, 1 - Math.abs(c.snd.e - te) / 25) : 0.5);
      if (i === k) { // hands over to B
        if (c.r === B.r) return null;
        const tr2 = C.transition(c, B, { pitchRange: range });
        if (!tr2.bpmScore || (keys && tr2.pitched.score === 0)) return null;
        sc += (keys ? tr2.score : tr2.bpmScore) * 0.5 + affinity(c, B) * 0.2;
      }
      return sc;
    };
    const W = 6;
    let beams = [{ path: [A], recs: new Set([A.r, B.r]), s: 0 }];
    for (let i = 1; i <= k; i++) {
      const next = [];
      for (const bm of beams) {
        const last = bm.path[bm.path.length - 1], inPath = new Set(bm.path.map((t) => t.k));
        const local = [];
        for (const c of pool) {
          if (inPath.has(c.k)) continue;
          let sc = step(last, c, i);
          if (sc == null) continue;
          sc += (bm.recs.has(c.r) ? -0.4 : 0) + Math.random() * 0.06;
          local.push({ c, sc });
        }
        local.sort((x, y) => y.sc - x.sc).slice(0, W).forEach(({ c, sc }) => next.push({ path: [...bm.path, c], recs: new Set([...bm.recs, c.r]), s: bm.s + sc }));
      }
      if (!next.length) break;
      beams = next.sort((x, y) => y.s - x.s).slice(0, W);
    }
    const best = beams[0];
    const tracks = [...best.path.map((t) => t.k), B.k];
    return { tracks, short: best.path.length - 1 < k };
  }

  // The Generate tab: settings, then a draft you can tweak, regenerate, or save into My mixes.
  const VIBES = [['', 'Smooth'], ['build', 'Build energy'], ['down', 'Wind down'], ['eclectic', 'Eclectic']];
  function trackLine(t) {
    const e = eff(t);
    return `<b>${esc(t.title)}</b><small>${esc(t.artist)} · ${esc(t.r.title)}${e.bpm ? ' · ' + e.bpm + ' BPM' : ''}${e.cam ? ' · ' + esc(e.cam) : ''}</small>`;
  }
  function pickerHtml(slot, label) {
    const t = gen[slot] && byKey.get(gen[slot]);
    return `<div class="gr pick"><span class="gl">${label}</span><div class="picker" data-slot="${slot}">${t
      ? `<div class="pick-chip">${playBtn(t)}<div>${trackLine(t)}</div><button class="pick-x" data-clear="${slot}" aria-label="Change ${label.toLowerCase()} track">×</button></div>`
      : `<input type="search" class="pick-in" data-pick="${slot}" placeholder="Search your tracks" autocomplete="off" spellcheck="false" enterkeyhint="search"><div class="pick-list" hidden></div>`}</div></div>`;
  }
  function renderGenerate() {
    const bridge = gen.mode === 'bridge';
    const styles = facet(DATA.releases.filter((r) => !gen.genre || r.genres.includes(gen.genre)), (r) => r.styles);
    const pool = () => TRACKS.filter((t) => { const e = eff(t); return e.bpm && (e.cam || gen.nokeys) && (!gen.genre || t.r.genres.includes(gen.genre)) && (!gen.style || t.r.styles.includes(gen.style)); }).length;
    const k = pool();
    // Typed style names snap to the real one, whatever the case; anything else means Any.
    const pickStyle = (v) => { v = v.trim().toLowerCase(); if (!v) return ''; const hit = styles.find(([s]) => s.toLowerCase() === v); if (hit) return hit[0]; const near = styles.filter(([s]) => s.toLowerCase().includes(v)); return near.length === 1 ? near[0][0] : ''; };
    const d = user.draft;
    const opt = (list, cur, any) => `<option value="">${any}</option>` + list.map(([v, n]) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(v)}${n != null ? ` (${n})` : ''}</option>`).join('');
    const nMax = bridge ? 20 : 40, nMin = bridge ? 1 : 2, n = Math.max(nMin, Math.min(nMax, +gen.n || (bridge ? 6 : 10)));
    let html = `<section class="gen-card"><h2>Generate a mix</h2>
      <div class="seg" role="tablist" aria-label="Kind of mix"><button role="tab" data-mode="" aria-selected="${!bridge}">Tempo plan</button><button role="tab" data-mode="bridge" aria-selected="${bridge}">Bridge two tracks</button></div>
      <p class="sub gen-what">${bridge
        ? 'Pick where the mix starts and where it should land. Crate fills the gap with your records, moving a little closer to the end track in tempo, sound and energy with every step.'
        : 'Picks tracks you own that match, orders them so each step needs little pitch change and the keys sit well together, and never puts two tracks from the same record back to back.'}</p>
      ${bridge ? `<div class="group">${pickerHtml('a', 'From')}${pickerHtml('b', 'To')}</div>` : ''}
      <div class="group gen">
        <label class="gr"><span class="gl">Genre</span><select data-f="genre">${opt(facet(DATA.releases, (r) => r.genres), gen.genre, 'Any')}</select></label>
        <label class="gr"><span class="gl">Style</span><input type="search" data-f="style" list="style-list" value="${esc(gen.style)}" placeholder="Any, type to search" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done"></label>
        <datalist id="style-list">${styles.map(([v, c]) => `<option value="${esc(v)}">${c} records</option>`).join('')}</datalist>
        ${bridge ? '' : `<label class="gr"><span class="gl">Start BPM</span><input data-f="from" value="${esc(gen.from)}" inputmode="numeric"></label>
        <label class="gr"><span class="gl">End BPM</span><input data-f="to" value="${esc(gen.to ?? '')}" placeholder="Any" inputmode="numeric"></label>
        ${gen.nokeys ? '' : `<label class="gr"><span class="gl">Start key</span><select data-f="cam">${opt(camOptions(), gen.cam, 'Any')}</select></label>`}`}
        <div class="gr"><span class="gl">${bridge ? 'Tracks in between' : 'Tracks'}</span><div class="stepper"><button type="button" data-step="-1" aria-label="Fewer"${n <= nMin ? ' disabled' : ''}>−</button><b>${n}</b><button type="button" data-step="1" aria-label="More"${n >= nMax ? ' disabled' : ''}>+</button></div></div>
        <label class="gr"><span class="gl">Ignore keys <small>tempo only</small></span><span class="switch"><input type="checkbox" data-f="nokeys"${gen.nokeys ? ' checked' : ''}><span></span></span></label>
      </div>
      ${bridge ? '' : `<div class="group-h">Vibe</div><div class="chips" role="radiogroup" aria-label="Vibe">${VIBES.map(([v, l]) => `<button type="button" role="radio" data-vibe="${v}" aria-checked="${(gen.vibe || '') === v}">${l}</button>`).join('')}</div>`}
      <div class="gen-go"><button id="gen-go" class="primary">${d ? 'Generate again' : 'Generate'}</button><span class="sub">${k} tracks to choose from</span></div></section>`;
    if (d) {
      const g = d.generated || {};
      const A = g.mode === 'bridge' && byKey.get(g.a), B = g.mode === 'bridge' && byKey.get(g.b);
      html += `<section class="draft"><div class="draft-bar"><div><b>Draft</b> · ${A && B ? `bridge from ${esc(A.title)} to ${esc(B.title)}` : `${esc(g.style || g.genre || 'Any genre')}, ${esc(g.from)}${g.to ? '→' + esc(g.to) : '+'} BPM`}${g.nokeys ? ', keys ignored' : ''}. Reorder or remove tracks here, then save it.</div>
        <div class="save-row"><input id="draft-name" value="${esc(d.name)}" aria-label="Mix name" placeholder="Name this mix">
        <button class="primary" data-a="save">Save to My mixes</button><button data-a="regen">Regenerate</button><button data-a="discard">Clear</button></div></div>
        ${mixBodyHtml(d)}</section>`;
    } else {
      html += `<p class="empty">${bridge ? 'Pick a From and a To track and tap Generate.' : 'Pick your settings and tap Generate.'} The draft shows up here, and nothing goes into My mixes until you save it.</p>`;
    }
    const root = $('#generate');
    root.innerHTML = html;
    const val = (el) => (el.type === 'checkbox' ? el.checked : el.dataset.f === 'style' ? pickStyle(el.value) : el.value);
    $$('.gen-card [data-f]', root).forEach((el) => (el.onchange = () => {
      gen[el.dataset.f] = val(el);
      if (el.dataset.f === 'genre') gen.style = '';
      store.set('gen', gen);
      if (el.dataset.f === 'style') {
        el.value = gen.style;
        $('.gen-go .sub', root).textContent = `${pool()} tracks to choose from`;
        return;
      }
      // Typed numbers don't redraw, so tapping Generate straight after typing still lands.
      if (el.type !== 'text') renderGenerate();
    }));
    $$('.seg [data-mode]', root).forEach((b) => (b.onclick = () => { gen.mode = b.dataset.mode; gen.n = gen.mode === 'bridge' ? 6 : 10; store.set('gen', gen); renderGenerate(); }));
    $$('[data-vibe]', root).forEach((b) => (b.onclick = () => { gen.vibe = b.dataset.vibe; store.set('gen', gen); $$('[data-vibe]', root).forEach((x) => x.setAttribute('aria-checked', x === b)); }));
    $$('[data-step]', root).forEach((b) => (b.onclick = () => { gen.n = Math.max(nMin, Math.min(nMax, n + +b.dataset.step)); store.set('gen', gen); renderGenerate(); }));
    $$('[data-clear]', root).forEach((b) => (b.onclick = () => { gen[b.dataset.clear] = ''; store.set('gen', gen); renderGenerate(); setTimeout(() => $(`[data-pick="${b.dataset.clear}"]`)?.focus(), 0); }));
    $$('[data-pick]', root).forEach((inp) => {
      const list = inp.nextElementSibling;
      inp.oninput = () => {
        const ws = norm(inp.value).split(/\s+/).filter(Boolean);
        if (!ws.length) { list.hidden = true; return; }
        const hits = [];
        for (const t of TRACKS) {
          const hay = norm(`${t.title} ${t.artist} ${t.r.title}`);
          if (ws.every((w) => hay.includes(w))) { hits.push(t); if (hits.length >= 40) break; }
        }
        hits.sort((x, y) => !!eff(y).bpm - !!eff(x).bpm);
        list.innerHTML = hits.slice(0, 8).map((t) => `<button type="button" data-choose="${esc(t.k)}">${trackLine(t)}</button>`).join('') || '<p class="sub">No track matches</p>';
        list.hidden = false;
        $$('[data-choose]', list).forEach((b) => (b.onclick = () => { gen[inp.dataset.pick] = b.dataset.choose; store.set('gen', gen); renderGenerate(); }));
      };
    });
    $('#gen-go').onclick = () => {
      $$('.gen-card [data-f]', root).forEach((el) => (gen[el.dataset.f] = val(el)));
      gen.n = n;
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
    const bridge = gen.mode === 'bridge';
    const res = bridge ? generateBridge(gen) : generateMix(gen);
    if (res.error) { toast(res.error); return; }
    const keepName = user.draft && user.draft.renamed ? user.draft.name : null;
    const name = bridge ? `${byKey.get(gen.a).title} → ${byKey.get(gen.b).title}` : `${gen.style || gen.genre || 'Mix'} ${gen.from}${gen.to ? '→' + gen.to : ''}`;
    user.draft = { name: keepName || name, tracks: res.tracks, generated: { ...gen } };
    saveUser();
    renderGenerate();
    toast(res.short ? (bridge ? 'The bridge came out shorter: not enough tracks link those two smoothly' : `Only found ${res.tracks.length} tracks that chain well`) : 'New draft ready');
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
    let html = `<p class="sub">${items.length} tracks from ${recs.size} records${total ? ` · about ${Math.round(total / 60)} min if played in full` : ''}${items.length > 1 ? ' · drag ⋮⋮ to reorder' : ''}</p>${spOn() && items.some(Boolean) ? `<button class="sp-mix" data-spmix>${SP_SVG}Play the mix on Spotify</button>` : ''}<ol class="mix">`;
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
        <td><button class="small add" aria-label="Add to mix">${ADD_SVG}</button></td></tr>`).join('')}</tbody></table>`
        : '<p class="sub">No good matches yet. Suggestions need BPM and key on the last track, so add them by hand if they are missing.</p>';
    }
    if (recs.size) {
      html += `<h3>Records to pull</h3><ul class="pull">${[...recs.values()].map((r) => {
        const sides = [...new Set(items.filter((t) => t && t.r === r).map((t) => t.pos))].join(', ');
        return `<li><b>${esc(r.artist)} – ${esc(r.title)}</b> <small>${esc(r.labels[0]?.catno || '')} · ${esc(sides)}</small></li>`;
      }).join('')}</ul>`;
    }
    return html;
  }

  function wireMixBody(root, m, rerender, add) {
    const spm = $('[data-spmix]', root);
    if (spm) spm.onclick = () => spPlay(m.tracks.filter((k) => byKey.has(k)));
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
      <section class="card-s" id="sp-card"><h2>Full tracks with Spotify <small>(optional, Premium)</small></h2>
        ${SP.token ? `<p>Connected. Each track has a Spotify button (the round wave icon) that plays the whole song, and mixes have <b>Play the mix on Spotify</b>. ${canSdk ? 'On this computer it plays right here in Crate.' : 'On a phone it plays through your Spotify app, controlled from Crate: open the Spotify app once first.'}</p>
        <div class="row"><button id="sp-out">Disconnect</button><button id="sp-forget">Search again for tracks not found</button></div>`
        : `<p>Plays whole songs from your own Spotify account, next to the snippets and YouTube. One-time setup, about 3 minutes:</p>
        <ol class="steps"><li>Open <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a>, log in with your Spotify account and tap <b>Create app</b>.</li>
        <li>Any name and description. Under <b>Redirect URIs</b> add exactly <code>${esc(spRedirect())}</code>. Tick <b>Web API</b> and <b>Web Playback SDK</b>, accept and save.</li>
        <li>Open the app's <b>Settings</b>, copy the <b>Client ID</b> and paste it below. No secret is needed.</li></ol>
        <label class="f"><span>Spotify Client ID</span><input id="sp-client" value="${esc(settings.spClient || '')}" placeholder="32 letters and numbers" autocomplete="off" spellcheck="false"></label>
        <div class="row"><button id="sp-in" class="primary">Connect Spotify</button></div>`}</section>
      <section class="card-s"><h2>Your edits and mixes</h2>
        <p>${n} edited tracks and ${user.mixes.length} mixes are saved in this browser.</p>
        <div class="row"><button id="export">Download backup</button><label class="button">Restore backup<input type="file" id="import" accept="application/json" hidden></label></div></section>
      <section class="card-s"><h2>Sync edits across devices <small>(optional)</small></h2>
        <p>Paste a GitHub fine-grained token that can only write to this repository's contents. Your edits and mixes are then saved to <code>user/state.json</code> in the repo and load on any device. The token stays in this browser.</p>
        <label class="f"><span>Repository</span><input id="gh-repo" value="${esc(settings.ghRepo || guessRepo())}" placeholder="owner/repo"></label>
        <label class="f"><span>Token</span><input id="gh-token" type="password" value="${esc(settings.ghToken)}" placeholder="github_pat_…"></label>
        <div class="row"><button id="gh-save">Save and sync now</button><span id="gh-status" class="sub"></span></div></section>`;
    $('#pitch').onchange = (e) => { settings.pitchRange = +e.target.value; store.set('settings', settings); };
    if ($('#sp-in')) $('#sp-in').onclick = () => {
      settings.spClient = $('#sp-client').value.trim();
      if (!/^[0-9a-f]{32}$/i.test(settings.spClient)) { toast('That doesn\'t look like a Client ID: it is 32 letters and numbers'); return; }
      store.set('settings', settings);
      spLogin();
    };
    if ($('#sp-out')) $('#sp-out').onclick = () => { spLogout(); toast('Spotify disconnected'); renderSettings(); };
    if ($('#sp-forget')) $('#sp-forget').onclick = () => { Object.keys(spMatches).forEach((k) => { if (!spMatches[k]) delete spMatches[k]; }); store.set('spMatch', spMatches); toast('Tracks not found will be searched again'); };
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
      const b = e.target.closest('[data-play], [data-yt], [data-video], [data-sp]');
      if (!b) return;
      e.preventDefault();
      if (b.dataset.sp) {
        // In a mix, play on through the mix; anywhere else, along the record the track is on.
        const list = b.closest('ol.mix');
        const keys = list ? [...new Set($$('[data-sp]', list).map((x) => x.dataset.sp))] : (byKey.get(b.dataset.sp)?.r.tracks || []).map((t) => t.k);
        spPlay(keys, Math.max(0, keys.indexOf(b.dataset.sp)), list ? null : byKey.get(b.dataset.sp)?.r);
      }
      else if (b.dataset.play) previewTrack(b.dataset.play);
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
    wireCrate();
    // Content below makes room for exactly as much player as is showing (a video is much taller than a preview).
    new ResizeObserver(([e]) => document.documentElement.style.setProperty('--player-h', `${Math.ceil(e.target.offsetHeight)}px`)).observe($('#player'), { box: 'border-box' });
    // Phones can't hover, so tapping a BPM/key source tag explains it.
    document.addEventListener('click', (e) => { const t = e.target.closest('[data-why]'); if (t) toast(t.dataset.why); });
    // On phones the tab bar lives outside the sticky header: iOS Safari lets a fixed bar inside a sticky one drift with the page.
    const phone = matchMedia('(max-width: 720px)');
    const nav = $('.tabs');
    const placeNav = () => (phone.matches ? document.body.appendChild(nav) : $('.top').insertBefore(nav, $('.search-wrap')));
    phone.addEventListener('change', placeNav);
    placeNav();
    // Back button / swipe-back closes an open record instead of leaving the app.
    window.addEventListener('popstate', () => { if ($('#drawer').classList.contains('open')) hideDrawer(); });
  }

  async function boot() {
    wire();
    spCallback();
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
