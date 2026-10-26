// Key and tempo maths for mixing on turntables.
// Camelot wheel: number 1-12, A = minor, B = major. Moving +1 on the wheel is +7 semitones.
(function (global) {
  const NOTES = { C: 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, F: 5, 'F#': 6, GB: 6, G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10, BB: 10, B: 11 };
  const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const MINOR = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];
  const MAJOR_CAM = { 0: 8, 7: 9, 2: 10, 9: 11, 4: 12, 11: 1, 6: 2, 1: 3, 8: 4, 3: 5, 10: 6, 5: 7 };
  const CAM_TO_MAJOR_PC = Object.fromEntries(Object.entries(MAJOR_CAM).map(([pc, n]) => [n, +pc]));

  function parseCam(c) {
    const m = /^(\d{1,2})([AB])$/i.exec((c || '').trim());
    if (!m) return null;
    const n = +m[1];
    if (n < 1 || n > 12) return null;
    return { n, l: m[2].toUpperCase() };
  }

  function camToKey(c) {
    const p = parseCam(c);
    if (!p) return null;
    const majorPc = CAM_TO_MAJOR_PC[p.n];
    return p.l === 'B' ? NAMES[majorPc] : MINOR[(majorPc + 9) % 12];
  }

  // Accepts "8A", "Am", "A minor", "F#m", "Gb maj", "a" ... returns {key, cam} or null.
  function parseKey(input) {
    const s = (input || '').trim();
    if (!s) return null;
    if (parseCam(s)) { const p = parseCam(s); const cam = p.n + p.l; return { key: camToKey(cam), cam }; }
    const m = /^([A-Ga-g])\s*([#b♯♭]?)\s*(m|min|minor|maj|major|M)?$/.exec(s);
    if (!m) return null;
    const acc = m[2] === '♯' ? '#' : m[2] === '♭' ? 'b' : m[2];
    const pc = NOTES[(m[1] + acc).toUpperCase()];
    if (pc === undefined) return null;
    const minor = m[3] && /^m(in(or)?)?$/.test(m[3]) && m[3] !== 'M';
    const cam = minor ? MAJOR_CAM[(pc + 3) % 12] + 'A' : MAJOR_CAM[pc] + 'B';
    return { key: minor ? MINOR[pc] : NAMES[pc], cam };
  }

  // Shift a Camelot key by a number of semitones (what happens when you pitch a record).
  function shiftCam(c, semis) {
    const p = parseCam(c);
    if (!p || !semis) return c;
    const n = (((p.n - 1 + 7 * semis) % 12) + 12) % 12 + 1;
    return n + p.l;
  }

  // How well two keys mix. Returns {score 0..1, label}.
  function camRelation(a, b) {
    const x = parseCam(a), y = parseCam(b);
    if (!x || !y) return { score: null, label: 'unknown key' };
    const d = (((y.n - x.n) % 12) + 12) % 12; // steps clockwise
    const step = d > 6 ? d - 12 : d;
    if (x.l === y.l) {
      if (step === 0) return { score: 1, label: 'same key' };
      if (Math.abs(step) === 1) return { score: 0.9, label: step > 0 ? '+1 (lift)' : '−1 (calmer)' };
      if (Math.abs(step) === 2) return { score: 0.5, label: step > 0 ? '+2 energy boost' : '−2' };
      return { score: 0, label: 'key clash' };
    }
    if (step === 0) return { score: 0.9, label: x.l === 'A' ? 'relative major' : 'relative minor' };
    if (x.l === 'A' && step === 1) return { score: 0.6, label: 'diagonal (minor → major +1)' };
    if (x.l === 'B' && step === -1) return { score: 0.6, label: 'diagonal (major → minor −1)' };
    return { score: 0, label: 'key clash' };
  }

  // Pitch change (%) needed to bring track `to` to the tempo of `from`, allowing half/double time.
  function pitchNeeded(fromBpm, toBpm) {
    if (!fromBpm || !toBpm) return null;
    let best = null;
    for (const mult of [1, 2, 0.5]) {
      const pct = (fromBpm / (toBpm * mult) - 1) * 100;
      if (best === null || Math.abs(pct) < Math.abs(best.pct)) best = { pct, mult };
    }
    return best;
  }

  // Semitones a record moves when pitched by pct% (vinyl has no key lock).
  function semitonesForPitch(pct) {
    return 12 * Math.log2(1 + pct / 100);
  }

  // Full transition assessment from track a into track b, for vinyl.
  function transition(a, b, opts) {
    const range = (opts && opts.pitchRange) || 8;
    const p = pitchNeeded(a.bpm, b.bpm);
    let bpmScore = null, keyAfterPitch = b.cam, semis = 0;
    if (p) {
      const abs = Math.abs(p.pct);
      bpmScore = abs <= 2 ? 1 : abs <= 4 ? 0.85 : abs <= 6 ? 0.6 : abs <= range ? 0.35 : 0;
      semis = Math.round(semitonesForPitch(p.pct));
      if (b.cam && semis) keyAfterPitch = shiftCam(b.cam, semis);
    }
    const asIs = camRelation(a.cam, b.cam);
    const pitched = camRelation(a.cam, keyAfterPitch);
    const keyScore = pitched.score;
    let score = null;
    if (bpmScore !== null && keyScore !== null) score = bpmScore * 0.55 + keyScore * 0.45;
    else if (bpmScore !== null) score = bpmScore * 0.7;
    else if (keyScore !== null) score = keyScore * 0.5;
    return { pitch: p, bpmScore, semis, keyAfterPitch, asIs, pitched, score };
  }

  global.Camelot = { parseCam, parseKey, camToKey, shiftCam, camRelation, pitchNeeded, semitonesForPitch, transition };
})(typeof window !== 'undefined' ? window : globalThis);
if (typeof module !== 'undefined') module.exports = globalThis.Camelot;
