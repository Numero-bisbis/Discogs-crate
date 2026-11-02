/* Decks: two turntables and a mixer for the 30-second previews, like a two-deck DJ setup.
   Turn the phone sideways on Tracks, Generate or My mixes (or tap Decks). Each deck has a platter (drag it to nudge
   a playing record or move a stopped one), cue, play, a pitch fader and Sync; the mixer has two channel faders and
   a crossfader. Audio runs on the Blend engine's audio context and preview loader in app.js. */
(function () {
  'use strict';
  const APP = window.CrateApp;
  if (!APP) return;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const { esc, norm } = APP;
  const REV = 1.8; // seconds of music per platter turn at 33⅓ rpm
  const NAMES = ['A', 'B'];
  const VIEWS = ['tracks', 'generate', 'mixes'];

  let root = null, ctx = null, master = null, raf = 0, wake = null, sheetFor = -1, sheetTab = 'mix';
  const X = { fade: 0.5 }; // crossfader: 0 = all A, 1 = all B
  const decks = [0, 1].map((i) => ({ i, k: null, t: null, clip: null, loading: 0, pitch: 0, bend: 0, rate: 1, playing: false,
    pos: 0, p0: 0, t0: 0, node: null, el: null, cue: 0, vol: 0.8, ch: null, sync: false, peaks: null, jog: null }));
  const other = (d) => decks[1 - d.i];

  // ---------- audio ----------
  function audio() { // only ever called from a tap, so iOS lets the context run
    ctx = APP.ctx();
    if (!master) {
      master = ctx.createDynamicsCompressor(); // two loud records together shouldn't clip
      master.threshold.value = -10; master.ratio.value = 4; master.attack.value = 0.005; master.release.value = 0.2;
      master.connect(ctx.destination);
      decks.forEach((d) => { d.ch = ctx.createGain(); d.ch.connect(master); });
      gains(true);
    }
    return ctx;
  }
  const dur = (d) => (d.clip ? (d.clip.buf ? d.clip.buf.duration : (d.el && isFinite(d.el.duration) && d.el.duration) || d.clip.dur) : 0);
  function pos(d) {
    if (d.el) return d.el.currentTime || d.pos;
    if (!d.playing || !ctx) return d.pos;
    return Math.min(dur(d), d.p0 + (ctx.currentTime - d.t0) * d.rate);
  }
  // Pitch fader times nudge; re-anchors the clock so the position stays continuous.
  function setRate(d) {
    const r = Math.max(0.25, (1 + d.pitch) * (1 + d.bend));
    if (d.playing && ctx && !d.el) { d.p0 = pos(d); d.t0 = ctx.currentTime; }
    d.rate = r;
    if (d.node) d.node.playbackRate.setValueAtTime(r, ctx.currentTime);
    if (d.el) d.el.playbackRate = Math.round(r * 1000) / 1000;
  }
  function start(d) {
    if (!d.clip || d.playing) return;
    audio();
    if (pos(d) >= dur(d) - 0.05) d.pos = d.cue;
    if (d.sync && other(d).playing) d.pos = phaseMatch(d, d.pos);
    if (d.clip.buf) {
      const n = ctx.createBufferSource();
      n.buffer = d.clip.buf; n.playbackRate.value = d.rate; n.connect(d.ch);
      n.onended = () => { if (d.node === n) { d.node = null; d.playing = false; d.pos = dur(d); paint(d); } };
      d.node = n; d.p0 = d.pos; d.t0 = ctx.currentTime;
      n.start(0, Math.max(0, d.pos));
    } else if (d.el) {
      try { d.el.currentTime = d.pos; } catch { /* not seekable yet */ }
      d.el.playbackRate = d.rate;
      d.el.play().catch(() => {});
    }
    d.playing = true;
    paint(d);
  }
  function stop(d) {
    if (!d.playing) return;
    d.pos = pos(d);
    d.playing = false;
    if (d.node) { const n = d.node; d.node = null; try { n.stop(); n.disconnect(); } catch { /* done */ } }
    if (d.el) d.el.pause();
    paint(d);
  }
  function seek(d, p) {
    p = Math.max(0, Math.min(dur(d) - 0.02, p));
    if (d.playing && !d.el) { stop(d); d.pos = p; start(d); return; }
    d.pos = p;
    if (d.el) try { d.el.currentTime = p; } catch { /* not seekable yet */ }
  }
  // Channel fader (squared, so the top half does most of the work) times the crossfader (both full in the middle).
  function gains(now) {
    decks.forEach((d) => {
      const x = d.i ? X.fade : 1 - X.fade, cf = Math.min(1, Math.SQRT2 * Math.sin((x * Math.PI) / 2));
      const g = d.vol * d.vol * cf;
      if (d.ch) now ? d.ch.gain.setValueAtTime(g, ctx.currentTime) : d.ch.gain.setTargetAtTime(g, ctx.currentTime, 0.012);
      if (d.el) d.el.volume = Math.max(0, Math.min(1, g)); // ignored on iPhones
    });
  }

  // ---------- tempo and beats ----------
  const bpmOf = (d) => (d.clip && d.clip.beat ? 60 / d.clip.beat.period : d.t && d.t.bpm) || null;
  function syncTempo(d, quiet) {
    const o = other(d), a = bpmOf(d), b = bpmOf(o);
    if (!a || !b) { if (!quiet) APP.toast(`Sync needs a BPM on both decks`); return false; }
    const target = b * (1 + o.pitch), range = APP.pitchRange() / 100;
    // Half or double time counts too (a 70 BPM hip-hop track under a 140 one).
    const p = [1, 2, 0.5].map((m) => (target * m) / a - 1).sort((x, y) => Math.abs(x) - Math.abs(y))[0];
    if (Math.abs(p) > range + 1e-6) { if (!quiet) APP.toast(`Too far apart: needs ${p > 0 ? '+' : '−'}${Math.abs(p * 100).toFixed(1)}%, the pitch fader goes to ±${APP.pitchRange()}%`); return false; }
    d.pitch = p;
    setRate(d);
    paintPitch(d);
    return true;
  }
  // Where deck d should be so its beats land with the other deck's, nearest to position p.
  function phaseMatch(d, p) {
    const o = other(d), bd = d.clip && d.clip.beat, bo = o.clip && o.clip.beat;
    if (!bd || !bo) return p;
    const frac = (x) => x - Math.floor(x);
    const fo = frac((pos(o) - bo.phase) / bo.period), fd = frac((p - bd.phase) / bd.period);
    let dlt = fo - fd;
    if (dlt > 0.5) dlt -= 1; else if (dlt < -0.5) dlt += 1;
    return Math.max(0, p + dlt * bd.period);
  }
  function toggleSync(d) {
    if (d.sync) { d.sync = false; paint(d); return; }
    if (!other(d).clip || !d.clip) { APP.toast('Load a track on both decks first'); return; }
    if (!syncTempo(d)) return;
    d.sync = true; other(d).sync = false; // the other deck leads
    if (d.playing && other(d).playing && !d.el) seek(d, phaseMatch(d, pos(d)));
    paint(d); paint(other(d));
  }

  // ---------- loading ----------
  async function load(d, k) {
    audio();
    stop(d);
    if (d.el) { d.el.pause(); d.el.removeAttribute('src'); d.el = null; }
    const t = APP.track(k);
    if (!t) return;
    Object.assign(d, { k, t, clip: null, peaks: null, pos: 0, cue: 0, sync: false, bend: 0 });
    const ticket = ++d.loading;
    paint(d);
    const clip = await APP.load(k).catch(() => null);
    if (ticket !== d.loading) return;
    d.loading = 0;
    if (!clip) { d.clip = null; paint(d); APP.toast(`No preview found for ${t.title}`); return; }
    d.clip = clip;
    if (clip.buf) {
      d.peaks = peaks(clip.buf, 240);
      d.cue = d.pos = clip.beat ? clip.beat.phase : 0; // cued on the first beat
    } else {
      // The preview server wouldn't let the page read the audio: it still plays, but without beat sync (and on iPhones without faders).
      const el = new Audio();
      el.setAttribute('playsinline', '');
      el.preservesPitch = el.webkitPreservesPitch = el.mozPreservesPitch = false;
      el.src = clip.url;
      el.onended = () => { d.playing = false; paint(d); };
      d.el = el;
      APP.toast('This preview plays without beat sync');
    }
    d.pitch = 0; setRate(d);
    if (other(d).clip && bpmOf(d) && bpmOf(other(d))) { d.sync = syncTempo(d, true); if (d.sync) other(d).sync = false; }
    gains(true);
    paint(d); paint(other(d)); paintPitch(d);
  }
  function peaks(buf, n) {
    const ch = buf.getChannelData(0), step = Math.floor(ch.length / n), out = new Float32Array(n);
    for (let i = 0; i < n; i++) { let m = 0; for (let j = i * step, e = j + step; j < e; j += 4) { const v = Math.abs(ch[j]); if (v > m) m = v; } out[i] = m; }
    const top = Math.max(...out) || 1;
    return out.map((v) => v / top);
  }

  // ---------- view ----------
  const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
  const PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>';
  const deckHtml = (i) => `<section class="deck" data-d="${i}">
      <div class="dk-head"><button class="dk-load" aria-label="Load a track on deck ${NAMES[i]}">${NAMES[i]}</button>
        <div class="dk-name"><b>Load a track</b><small>Tap ${NAMES[i]} to pick one</small></div>
        <div class="dk-bpm"><b>–</b><small>BPM</small></div></div>
      <div class="dk-wave"><canvas></canvas><i></i></div>
      <div class="dk-body">
        <label class="dk-pitch"><input type="range" min="-100" max="100" step="1" value="0" aria-label="Pitch, deck ${NAMES[i]}"><small>0.0%</small></label>
        <div class="dk-plat"><div class="dk-disc"><div class="dk-label"><img alt="" draggable="false" onerror="this.removeAttribute('src')"></div><span class="dk-mark"></span></div></div>
        <div class="dk-btns"><button class="dk-sync">Sync</button><button class="dk-cue">Cue</button><button class="dk-play" aria-label="Play deck ${NAMES[i]}">${PLAY}</button></div>
      </div></section>`;
  function build() {
    root = document.createElement('div');
    root.id = 'decks'; root.className = 'decks'; root.hidden = true;
    root.innerHTML = `<div class="dk-main">${deckHtml(0)}
      <section class="mixer">
        <button class="dk-close" aria-label="Close decks"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        <div class="mx-chs"><label class="mx-ch"><input type="range" min="0" max="100" value="80" data-ch="0" aria-label="Volume A"><small>A</small></label>
          <label class="mx-ch"><input type="range" min="0" max="100" value="80" data-ch="1" aria-label="Volume B"><small>B</small></label></div>
        <label class="mx-x"><input type="range" min="0" max="100" value="50" aria-label="Crossfader"><small>A · B</small></label>
      </section>${deckHtml(1)}</div>
      <div class="dk-rotate"><p>Turn your phone sideways to keep mixing.</p><button class="dk-stop">Stop and close</button></div>
      <div class="dk-sheet" hidden><div class="sh-head"><b></b><input type="search" placeholder="Search tracks" autocomplete="off" enterkeyhint="search"><button class="sh-close">Done</button></div>
        <div class="sh-tabs"></div><ul class="sh-list"></ul></div>`;
    document.body.appendChild(root);
    decks.forEach(wireDeck);
    $$('.mx-ch input', root).forEach((s) => (s.oninput = () => { decks[s.dataset.ch].vol = s.value / 100; gains(); }));
    const xf = $('.mx-x input', root);
    xf.oninput = () => { X.fade = xf.value / 100; gains(); };
    xf.ondblclick = () => { xf.value = 50; xf.oninput(); };
    $('.dk-close', root).onclick = close;
    $('.dk-stop', root).onclick = close;
    $('.sh-close', root).onclick = closeSheet;
    $('.dk-sheet input', root).oninput = () => sheetList();
    document.addEventListener('keydown', (e) => {
      if (root.hidden || e.target.matches('input[type=search]')) return;
      if (e.key === 'Escape') sheetFor >= 0 ? closeSheet() : close();
      if (e.key === 'z' || e.key === 'm') { const d = decks[e.key === 'z' ? 0 : 1]; d.playing ? stop(d) : start(d); }
    });
    window.addEventListener('resize', () => { if (!root.hidden) decks.forEach(drawWave); });
  }
  function wireDeck(d) {
    const el = $(`.deck[data-d="${d.i}"]`, root);
    d.ui = el;
    $('.dk-load', el).onclick = () => openSheet(d.i);
    $('.dk-name', el).onclick = () => openSheet(d.i);
    $('.dk-play', el).onclick = () => { if (!d.clip) { openSheet(d.i); return; } d.playing ? stop(d) : start(d); };
    // Cue like a CDJ: while playing it jumps back to the cue point and stops; stopped, it sets the cue where you are.
    $('.dk-cue', el).onclick = () => { if (!d.clip) return; if (d.playing) { stop(d); seek(d, d.cue); } else { d.cue = pos(d); APP.toast(`Cue set on ${NAMES[d.i]}`); } paint(d); };
    $('.dk-sync', el).onclick = () => toggleSync(d);
    const p = $('.dk-pitch input', el);
    p.oninput = () => {
      d.pitch = (p.value / 100) * (APP.pitchRange() / 100);
      if (d.sync) { d.sync = false; paint(d); }
      setRate(d); paintPitch(d, true);
      const o = other(d);
      if (o.sync) syncTempo(o, true);
    };
    p.ondblclick = () => { p.value = 0; p.oninput(); };
    // The waveform strip: tap or drag to move through the clip.
    const w = $('.dk-wave', el);
    const wseek = (e) => { if (!d.clip) return; const r = w.getBoundingClientRect(); seek(d, ((e.clientX - r.left) / r.width) * dur(d)); };
    w.addEventListener('pointerdown', (e) => { w.setPointerCapture(e.pointerId); wseek(e); w.onpointermove = wseek; });
    w.addEventListener('pointerup', () => (w.onpointermove = null));
    w.addEventListener('pointercancel', () => (w.onpointermove = null));
    // The platter: drag round it to speed up or hold back a playing record, or to wind a stopped one.
    const plat = $('.dk-plat', el);
    const ang = (e) => { const r = plat.getBoundingClientRect(); return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)); };
    plat.addEventListener('pointerdown', (e) => { if (!d.clip) return; plat.setPointerCapture(e.pointerId); d.jog = { a: ang(e), t: performance.now(), last: performance.now() }; });
    plat.addEventListener('pointermove', (e) => {
      if (!d.jog) return;
      const a = ang(e), now = performance.now();
      let da = a - d.jog.a;
      if (da > Math.PI) da -= 2 * Math.PI; else if (da < -Math.PI) da += 2 * Math.PI;
      const dt = Math.max(8, now - d.jog.t) / 1000;
      d.jog.a = a; d.jog.t = now; d.jog.last = now;
      if (d.playing) {
        const spd = da / dt / ((2 * Math.PI) / REV); // platter speed relative to normal
        d.bend = Math.max(-0.35, Math.min(0.35, spd * 0.12));
        setRate(d);
      } else {
        d.pos = Math.max(0, Math.min(dur(d), d.pos + (da / (2 * Math.PI)) * REV));
        if (d.el) try { d.el.currentTime = d.pos; } catch { /* not seekable yet */ }
      }
    });
    const up = () => { if (!d.jog) return; d.jog = null; if (d.bend) { d.bend = 0; setRate(d); } };
    plat.addEventListener('pointerup', up);
    plat.addEventListener('pointercancel', up);
  }
  function paint(d) {
    if (!d.ui) return;
    const el = d.ui, t = d.t;
    $('.dk-name b', el).textContent = t ? t.title : 'Load a track';
    $('.dk-name small', el).textContent = !t ? `Tap ${NAMES[d.i]} to pick one` : d.loading ? 'Finding the preview…' : !d.clip ? 'No preview found' : `${t.artist}${t.cam ? ' · ' + t.cam : ''}`;
    $('.dk-play', el).innerHTML = d.playing ? PAUSE : PLAY;
    $('.dk-play', el).classList.toggle('on', d.playing);
    $('.dk-sync', el).classList.toggle('on', d.sync);
    $('.dk-sync', el).disabled = !d.clip;
    $('.dk-cue', el).disabled = !d.clip;
    el.classList.toggle('empty', !d.clip);
    el.classList.toggle('loading', !!d.loading);
    const img = $('.dk-label img', el), src = t && APP.cover(t.r);
    if (src) { if (img.getAttribute('src') !== src) img.src = src; } else img.removeAttribute('src');
    drawWave(d);
    paintPitch(d);
  }
  function paintPitch(d, fromFader) {
    if (!d.ui) return;
    const range = APP.pitchRange() / 100, input = $('.dk-pitch input', d.ui);
    if (!fromFader) input.value = Math.round((d.pitch / range) * 100);
    $('.dk-pitch small', d.ui).textContent = `${d.pitch >= 0 ? '+' : '−'}${Math.abs(d.pitch * 100).toFixed(1)}%`;
    const b = bpmOf(d);
    $('.dk-bpm b', d.ui).textContent = b ? (b * (1 + d.pitch)).toFixed(1) : '–';
  }
  function drawWave(d) {
    const cv = d.ui && $('.dk-wave canvas', d.ui);
    if (!cv) return;
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(r.width * dpr)); cv.height = Math.max(1, Math.round(r.height * dpr));
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    if (!d.peaks) return;
    const n = d.peaks.length, bw = cv.width / n, mid = cv.height / 2;
    g.fillStyle = 'rgb(255 255 255 / .55)';
    for (let i = 0; i < n; i++) { const h = Math.max(1, d.peaks[i] * mid * 0.95); g.fillRect(i * bw, mid - h, Math.max(1, bw - dpr * 0.5), h * 2); }
    const b = d.clip && d.clip.beat, D = dur(d);
    if (b && D) { // beat ticks, every bar a little taller
      g.fillStyle = 'rgb(138 141 255 / .9)';
      for (let k = 0, x = b.phase; x < D; k++, x += b.period) g.fillRect((x / D) * cv.width, 0, dpr, k % 4 ? cv.height * 0.18 : cv.height * 0.34);
    }
    const c = (d.cue / (D || 1)) * cv.width;
    g.fillStyle = '#ffd60a'; g.fillRect(c - dpr, 0, 2 * dpr, cv.height);
  }
  function frame() {
    raf = requestAnimationFrame(frame);
    for (const d of decks) {
      if (!d.ui) continue;
      if (d.jog && d.playing && d.bend && performance.now() - d.jog.last > 70) { d.bend *= 0.6; if (Math.abs(d.bend) < 0.005) d.bend = 0; setRate(d); } // finger still: let go of the nudge
      const p = pos(d), D = dur(d);
      $('.dk-disc', d.ui).style.transform = `rotate(${((p / REV) * 360) % 360}deg)`;
      $('.dk-wave i', d.ui).style.left = `${D ? Math.min(100, (p / D) * 100) : 0}%`;
      if (d.el && d.playing && d.el.ended) { d.playing = false; paint(d); }
    }
  }

  // ---------- picking a track ----------
  function openSheet(i) {
    sheetFor = i;
    const sh = $('.dk-sheet', root);
    $('.sh-head b', sh).textContent = `Deck ${NAMES[i]}`;
    const m = APP.mix();
    if (sheetTab === 'mix' && !(m && m.tracks.length)) sheetTab = 'match';
    sh.hidden = false;
    sheetList();
  }
  function closeSheet() { $('.dk-sheet', root).hidden = true; sheetFor = -1; }
  function sheetList() {
    const sh = $('.dk-sheet', root), q = norm($('input', sh).value), m = APP.mix(), o = decks[1 - sheetFor];
    const ref = o.t && o.t.bpm ? { bpm: o.t.bpm * (1 + o.pitch), cam: o.t.cam } : null;
    const tabs = [m && m.tracks.length ? ['mix', m.name] : null, ['match', ref ? `Fits deck ${NAMES[o.i]}` : 'All tracks']].filter(Boolean);
    $('.sh-tabs', sh).innerHTML = tabs.map(([k, n]) => `<button data-tab="${k}" class="${sheetTab === k ? 'on' : ''}">${esc(n)}</button>`).join('');
    $$('.sh-tabs button', sh).forEach((b) => (b.onclick = () => { sheetTab = b.dataset.tab; sheetList(); }));
    let list;
    if (sheetTab === 'mix' && m) list = m.tracks.map((k) => APP.track(k)).filter(Boolean);
    else {
      list = APP.tracks().map((t) => APP.track(t.k));
      if (ref) {
        const range = APP.pitchRange() / 100;
        const fit = (t) => {
          if (!t.bpm) return 9;
          const p = Math.min(...[1, 2, 0.5].map((x) => Math.abs((ref.bpm * x) / t.bpm - 1)));
          const key = APP.relation(ref.cam, t.cam).score;
          return (p <= range ? p / range : 2 + p) - (key ?? 0.3) * 0.6;
        };
        list.forEach((t) => (t._fit = fit(t)));
        list.sort((a, b) => a._fit - b._fit);
      } else list.sort((a, b) => (a.bpm || 999) - (b.bpm || 999));
    }
    if (q) list = list.filter((t) => t._search && t._search.includes(q));
    const loaded = new Set(decks.map((d) => d.k));
    $('.sh-list', sh).innerHTML = list.slice(0, 150).map((t) => {
      const c = APP.cover(t.r);
      return `<li><button data-k="${esc(t.k)}"${loaded.has(t.k) ? ' class="on"' : ''}>${c ? `<img src="${esc(c)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '<span class="noimg"></span>'}
        <span class="sh-t"><b>${esc(t.title)}</b><small>${esc(t.artist)} · ${esc(t.r.title)}</small></span>
        <span class="sh-m">${t.bpm ? Math.round(t.bpm) : '–'}<small>${esc(t.cam || '')}</small></span></button></li>`;
    }).join('') || '<li class="sh-empty">No tracks match.</li>';
    $$('.sh-list button', sh).forEach((b) => (b.onclick = () => { const d = decks[sheetFor]; closeSheet(); load(d, b.dataset.k); }));
  }

  // ---------- open / close ----------
  function open() {
    if (!root) build();
    if (!root.hidden) return;
    APP.stopPlayer();
    root.hidden = false;
    document.body.classList.add('decks-on');
    decks.forEach(paint);
    cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);
    keepAwake();
  }
  function close() {
    if (!root || root.hidden) return;
    decks.forEach(stop);
    closeSheet();
    root.hidden = true;
    document.body.classList.remove('decks-on');
    cancelAnimationFrame(raf); raf = 0;
    if (wake) { wake.release().catch(() => {}); wake = null; }
  }
  // Turn the phone sideways on the track lists and the decks come up; upright again closes them unless music is playing.
  const sideways = matchMedia('(orientation: landscape) and (max-height: 500px)');
  sideways.addEventListener('change', () => {
    if (sideways.matches) { if (VIEWS.includes(APP.view()) && !APP.busy()) open(); }
    else if (root && !root.hidden && !decks.some((d) => d.playing)) close();
  });
  // The screen stays on while the decks are up (iOS drops the lock when the app goes to the background).
  function keepAwake() {
    if (wake || !navigator.wakeLock) return;
    navigator.wakeLock.request('screen').then((w) => { wake = w; w.addEventListener('release', () => { if (wake === w) wake = null; }); }, () => {});
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && root && !root.hidden) keepAwake(); });
  setTimeout(() => { if (sideways.matches && VIEWS.includes(APP.view()) && !APP.busy()) open(); }, 400);

  window.CrateDecks = { open, close };
})();
