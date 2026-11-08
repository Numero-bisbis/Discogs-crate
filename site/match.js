// How likely track b plays well straight after track a, on turntables. Shared by the app and the
// evaluation harness in eval/, so what is tested is exactly what the app shows.
//
// The model is a small logistic regression: each part (tempo, key, sound, style, energy) is a 0..1
// fit, and the chance the transition works is sigmoid(bias + Σ w·log(fit) + flags). Working in
// log space means one bad part (a key clash, a big pitch jump) pulls the whole score down instead
// of being averaged away by the good ones, which is why the old weighted average said 80% for
// pairs that didn't work. The weights start from sensible defaults and are refitted from your own
// ratings (fit()), so the percentage moves toward "how often a transition like this worked for you".
// Release year is deliberately not a feature.
(function (global) {
  const C = global.Camelot || (typeof require !== 'undefined' ? require('./camelot.js') : null);

  const PARTS = ['tempo', 'key', 'tuning', 'sound', 'style', 'energy'];
  const FLAGS = ['half', 'unsure'];
  const NAMES = ['bias', ...PARTS, ...FLAGS];
  // Defaults, set by hand on the collection before any ratings: every part perfect ≈ 95%, a key clash
  // with everything else perfect ≈ 11%, keys a quarter-tone apart ≈ 50%, a pitch move of 6% ≈ 60%.
  const DEFAULT = { bias: 3.0, tempo: 2.3, key: 2.0, tuning: 1.2, sound: 1.6, style: 0.5, energy: 0.6, half: -0.7, unsure: -0.5 };
  const FLOOR = 0.05; // log(0) would make a single part infinitely bad
  const VERSION = 2;

  let model = { ...DEFAULT };

  const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
  const sigmoid = (z) => 1 / (1 + Math.exp(-z));

  // ---------- the parts ----------
  // Tempo: how far the pitch fader has to move. Smooth, not stepped: 2% ≈ 0.91, 4% ≈ 0.68, 6% ≈ 0.43,
  // 8% ≈ 0.22; beyond the turntable's range it can't be beatmatched at all.
  function tempoFit(pct, range) {
    const a = Math.abs(pct);
    if (a > range + 0.25) return 0.02;
    return Math.exp(-((a / 6.5) ** 2));
  }

  // Key relation once both tracks are in their pitched key. Clash isn't 0: drum tracks survive it.
  const REL = { same: 1, adjacent: 0.85, relative: 0.85, diagonal: 0.55, boost: 0.45, clash: 0.08 };
  function relation(a, b) {
    const x = C.parseCam(a), y = C.parseCam(b);
    if (!x || !y) return null;
    const d = (((y.n - x.n) % 12) + 12) % 12, step = d > 6 ? d - 12 : d;
    if (x.l === y.l) return step === 0 ? 'same' : Math.abs(step) === 1 ? 'adjacent' : Math.abs(step) === 2 ? 'boost' : 'clash';
    if (step === 0) return 'relative';
    if ((x.l === 'A' && step === 1) || (x.l === 'B' && step === -1)) return 'diagonal';
    return 'clash';
  }
  // Vinyl has no key lock, so pitching b by pct moves its key by a fraction of a semitone. The old
  // score rounded that to whole semitones; in reality 3% is half a semitone, a quarter-tone off both
  // neighbouring keys, which sounds out of tune whatever the Camelot wheel says. So: try the whole
  // semitone below and above the real shift, keep the better one, and score the distance left over
  // separately as "tuning" (its own weight, so your ratings decide how much it matters).
  const detune = (cents) => clamp(1 - 0.85 * (cents / 0.5) ** 2, 0.15, 1);
  function keyFit(camA, camB, pct) {
    const s = 12 * Math.log2(1 + (pct || 0) / 100);
    let best = { v: 0, rel: 'clash', cam: camB, off: 0 };
    for (const k of new Set([Math.floor(s), Math.ceil(s)])) {
      const cam = C.shiftCam(camB, k), rel = relation(camA, cam);
      const v = REL[rel] * detune(Math.abs(s - k));
      if (v > best.v) best = { v, rel, cam, off: Math.abs(s - k), rv: REL[rel], tune: detune(Math.abs(s - k)) };
    }
    return best;
  }

  function soundSim(x, y) {
    let dot = 0, nx = 0, ny = 0;
    for (let i = 0; i < x.v.length; i++) { dot += x.v[i] * y.v[i]; nx += x.v[i] ** 2; ny += y.v[i] ** 2; }
    return nx && ny ? dot / Math.sqrt(nx * ny) : 0;
  }
  // Cosine rescaled from the collection's spread: a random pair ≈ 0.33, two tracks off one record ≈ 0.8.
  const soundFit = (x, y) => clamp((soundSim(x, y) + 0.45) / 1.25);

  // Shared Discogs styles (falls back to genres), plus a little for the same label.
  function styleFit(ra, rb) {
    let s;
    if (ra.styles.length && rb.styles.length) {
      const shared = ra.styles.filter((x) => rb.styles.includes(x)).length;
      s = shared / new Set([...ra.styles, ...rb.styles]).size;
    } else if (ra.genres.length && rb.genres.length) s = ra.genres.some((g) => rb.genres.includes(g)) ? 0.5 : 0.1;
    else s = 0.35;
    const sameLabel = ra.labels[0] && rb.labels[0] && ra.labels[0].name && ra.labels[0].name === rb.labels[0].name;
    // Different Discogs styles still mix often (tags are coarse), so no shared style isn't a dealbreaker.
    return clamp(0.15 + 0.85 * s + (sameLabel ? 0.15 : 0));
  }

  // Energy (0-100 from the sound profile): a big jump either way is hard to blend.
  const energyFit = (ea, eb) => clamp(1 - Math.abs(eb - ea) / 50);

  // ---------- one transition ----------
  // a, b: {bpm, cam, src, snd: {v, e}, r: {styles, genres, labels}}. Unknown parts get a cautious
  // prior instead of being left out, so a pair with missing data can't look better than a known one.
  function features(a, b, o = {}) {
    const range = o.pitchRange || 8;
    const p = a.bpm && b.bpm ? C.pitchNeeded(a.bpm, b.bpm) : null;
    const f = { pitch: p, key: null };
    f.tempo = p ? tempoFit(p.pct, range) : 0.4;
    f.half = p && p.mult !== 1 ? 1 : 0;
    if (o.nokeys) { f.keyv = 1; f.tuning = 1; } else if (a.cam && b.cam) {
      f.key = keyFit(a.cam, b.cam, p ? p.pct : 0);
      f.keyv = f.key.rv;
      f.tuning = f.key.tune;
    } else { f.keyv = 0.4; f.tuning = 0.7; }
    f.sound = a.snd && b.snd ? soundFit(a.snd, b.snd) : 0.4;
    f.style = styleFit(a.r, b.r);
    f.energy = a.snd && b.snd && a.snd.e != null && b.snd.e != null ? energyFit(a.snd.e, b.snd.e) : 0.75;
    // BPM and key estimated from a 30 s preview (or missing) are wrong more often.
    const est = (t) => (!t.bpm || t.src === 'deezer-preview' ? 1 : 0);
    f.unsure = (est(a) + est(b)) / 2;
    return f;
  }

  function vector(f, ignore) {
    const x = [1];
    for (const k of PARTS) x.push(ignore && ignore.includes(k) ? 0 : Math.log(Math.max(FLOOR, k === 'key' ? f.keyv : f[k])));
    for (const k of FLAGS) x.push(f[k]);
    return x;
  }
  const theta = (m) => NAMES.map((k) => m[k]);
  const dot = (w, x) => w.reduce((s, wi, i) => s + wi * x[i], 0);

  // → {p: 0..1 chance it works, f: features, parts: [[name, fit]]}
  function score(a, b, o = {}) {
    const f = features(a, b, o);
    const p = sigmoid(dot(theta(o.model || model), vector(f, o.ignore)));
    const parts = [['tempo', f.tempo], ...(o.nokeys ? [] : [['key', f.keyv], ['tuning', f.tuning]]), ['sound', f.sound], ['style', f.style], ['energy', f.energy]];
    return { p, f, parts };
  }

  // ---------- learning from ratings ----------
  // examples: [{x: vector, y: 0..1}]. Gradient descent on log loss with a pull back toward the
  // defaults, so a handful of ratings nudges the model rather than overturning it. Part weights stay
  // ≥ 0: a better tempo match should never lower the score.
  function fit(examples, o = {}) {
    const prior = theta(o.prior || DEFAULT), w = prior.slice();
    const lambda = o.lambda ?? 1.5, iters = o.iters ?? 800, lr = o.lr ?? 0.05;
    const n = examples.length;
    if (!n) return { ...DEFAULT };
    for (let it = 0; it < iters; it++) {
      const g = w.map((wi, i) => (lambda * (wi - prior[i])) / n);
      for (const { x, y } of examples) {
        const e = sigmoid(dot(w, x)) - y;
        for (let i = 0; i < w.length; i++) g[i] += (e * x[i]) / n;
      }
      for (let i = 0; i < w.length; i++) {
        w[i] -= lr * 4 * g[i];
        if (i >= 1 && i <= PARTS.length) w[i] = Math.max(0, w[i]);
      }
    }
    return Object.fromEntries(NAMES.map((k, i) => [k, +w[i].toFixed(4)]));
  }

  // ---------- how good the model is ----------
  // preds: [{p, y}]. y may be 0.5 ("just about"); it counts as half a hit.
  function metrics(preds) {
    const n = preds.length;
    if (!n) return null;
    const eps = 1e-6;
    let brier = 0, ll = 0;
    for (const { p, y } of preds) {
      brier += (p - y) ** 2;
      const q = clamp(p, eps, 1 - eps);
      ll -= y * Math.log(q) + (1 - y) * Math.log(1 - q);
    }
    // AUC over clear-cut labels: chance a pair that worked scores above one that didn't.
    const pos = preds.filter((d) => d.y >= 0.75), neg = preds.filter((d) => d.y <= 0.25);
    let auc = null;
    if (pos.length && neg.length) {
      let w = 0;
      for (const a of pos) for (const b of neg) w += a.p > b.p ? 1 : a.p === b.p ? 0.5 : 0;
      auc = w / (pos.length * neg.length);
    }
    const bands = BANDS.map(([lo, hi]) => {
      const inb = preds.filter((d) => d.p >= lo && (d.p < hi || (hi === 1 && d.p <= 1)));
      return { lo, hi, n: inb.length, said: inb.length ? avg(inb.map((d) => d.p)) : null, worked: inb.length ? avg(inb.map((d) => d.y)) : null };
    });
    // Expected calibration error: average gap between what it said and what happened, by band.
    const ece = bands.reduce((s, b) => s + (b.n ? (b.n / n) * Math.abs(b.said - b.worked) : 0), 0);
    const high = preds.filter((d) => d.p >= 0.8);
    return { n, brier: brier / n, logloss: ll / n, auc, ece, bands, high: { n: high.length, worked: high.length ? avg(high.map((d) => d.y)) : null } };
  }
  const BANDS = [[0, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1]];
  const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

  // k-fold cross-validation of fit(): every rating is predicted by a model that never saw it.
  function crossValidate(examples, k = 5, o = {}) {
    const order = examples.map((e, i) => [hash(i + ':' + examples.length), e]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const preds = [];
    for (let f = 0; f < k; f++) {
      const train = order.filter((_, i) => i % k !== f), test = order.filter((_, i) => i % k === f);
      const m = fit(train, o);
      for (const e of test) preds.push({ p: sigmoid(dot(theta(m), e.x)), y: e.y });
    }
    return preds;
  }
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

  // Ratings in the app's user state → labelled pairs. Ratings: [{a, b, v: 1 | 0.5 | 0, p, t}];
  // thumbs from the mix view (user.pairs, 'k1|k2' → ±1) count too unless that pair was rated.
  function labels(user) {
    const out = [], seen = new Set();
    const pk = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    for (const r of user.ratings || []) { const k = pk(r.a, r.b); seen.add(k); out.push({ a: r.a, b: r.b, y: r.v, p: r.p, from: 'rating' }); }
    for (const [k, v] of Object.entries(user.pairs || {})) {
      if (seen.has(k) || !v) continue;
      const [a, b] = k.split('|');
      out.push({ a, b, y: v > 0 ? 1 : 0, from: 'thumb' });
    }
    // The same pair rated twice: keep the latest only.
    const last = new Map();
    out.forEach((l) => last.set(pk(l.a, l.b) + l.from, l));
    return [...last.values()];
  }

  const api = {
    VERSION, PARTS, NAMES, DEFAULT, BANDS,
    features, vector, score, fit, metrics, crossValidate, labels,
    soundSim, soundFit, styleFit, keyFit, tempoFit, energyFit, relation,
    predict: (x, m) => sigmoid(dot(theta(m || model), x)),
    setModel: (m) => { model = m ? { ...DEFAULT, ...m } : { ...DEFAULT }; },
    getModel: () => ({ ...model }),
  };
  global.CrateMatch = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
