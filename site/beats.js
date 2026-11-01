// Beat grid of a short clip (a 30-second preview), for lining up two tracks in the blend player.
// Given mono samples and a rough BPM, finds the beat period and where the first beat falls by scoring an
// onset curve (rises in bass and full-band loudness) against evenly spaced combs.
(function (global) {
  const HOP = 256;

  // Onset strength per frame: positive jumps in log energy, bass weighted so kicks count most.
  function onsets(x, sr) {
    const n = Math.floor(x.length / HOP);
    const lowA = Math.exp((-2 * Math.PI * 150) / sr); // one-pole low-pass around 150 Hz
    let low = 0, prevL = 0, prevF = 0;
    const env = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      let eL = 0, eF = 0;
      for (let i = f * HOP, end = i + HOP; i < end; i++) {
        const s = x[i];
        low = low * lowA + s * (1 - lowA);
        eL += low * low;
        eF += s * s;
      }
      const l = Math.log(1e-9 + eL), fu = Math.log(1e-9 + eF);
      env[f] = (f ? 1.5 * Math.max(0, l - prevL) + Math.max(0, fu - prevF) : 0);
      prevL = l; prevF = fu;
    }
    // Light smoothing, then remove the slow-moving average so only peaks remain.
    const sm = new Float32Array(n);
    for (let f = 0; f < n; f++) sm[f] = 0.25 * (env[f - 1] || 0) + 0.5 * env[f] + 0.25 * (env[f + 1] || 0);
    const out = new Float32Array(n), W = 40;
    let acc = 0;
    for (let f = 0; f < n; f++) {
      acc += sm[f] - (f >= W ? sm[f - W] : 0);
      out[f] = Math.max(0, sm[f] - acc / Math.min(W, f + 1));
    }
    return out;
  }

  // Mean onset strength at phase + k * period (in frames), with linear interpolation.
  function comb(env, period, phase) {
    let s = 0, c = 0;
    for (let p = phase; p < env.length - 1; p += period) {
      const i = Math.floor(p), fr = p - i;
      s += env[i] * (1 - fr) + env[i + 1] * fr;
      c++;
    }
    return c ? s / c : 0;
  }

  function bestPhase(env, period) {
    let best = 0, bestS = -1;
    for (let ph = 0; ph < period; ph += 0.5) {
      const s = comb(env, period, ph);
      if (s > bestS) { bestS = s; best = ph; }
    }
    return { phase: best, score: bestS };
  }

  // Returns { bpm, period (s), phase (s, first beat), conf } or null for silence.
  function detect(x, sr, bpmHint) {
    const env = onsets(x, sr);
    let mean = 0;
    for (let i = 0; i < env.length; i++) mean += env[i];
    mean /= env.length || 1;
    if (!(mean > 0)) return null;
    const fps = sr / HOP;
    const cands = [];
    if (bpmHint > 0) {
      let h = bpmHint;
      while (h < 80) h *= 2;
      while (h > 180) h /= 2;
      for (let b = h * 0.96; b <= h * 1.04; b += 0.05) cands.push(b);
    } else for (let b = 85; b <= 175; b += 0.1) cands.push(b);
    let best = null;
    for (const b of cands) {
      const period = (60 / b) * fps;
      const r = bestPhase(env, period);
      if (!best || r.score > best.score) best = { bpm: b, period, ...r };
    }
    // Fine pass around the winner.
    for (let b = best.bpm - 0.06; b <= best.bpm + 0.06; b += 0.01) {
      const period = (60 / b) * fps, r = bestPhase(env, period);
      if (r.score > best.score) best = { bpm: b, period, ...r };
    }
    return { bpm: Math.round(best.bpm * 100) / 100, period: best.period / fps, phase: best.phase / fps, conf: best.score / mean };
  }

  global.CrateBeats = { detect, onsets };
})(typeof window !== 'undefined' ? window : globalThis);
if (typeof module !== 'undefined') module.exports = globalThis.CrateBeats;
