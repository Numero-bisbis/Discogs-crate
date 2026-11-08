// The compatibility score as the app computed it before the match model (until Nov 2026), kept so
// the harness can always compare the current model against it. Weighted average of tempo, key,
// style/era/label/sound and energy; release year counted inside "style".
const C = require('../site/camelot.js');

function soundSim(x, y) {
  let dot = 0, nx = 0, ny = 0;
  for (let i = 0; i < x.v.length; i++) { dot += x.v[i] * y.v[i]; nx += x.v[i] ** 2; ny += y.v[i] ** 2; }
  return nx && ny ? dot / Math.sqrt(nx * ny) : 0;
}
const soundFit = (x, y) => Math.max(0, Math.min(1, (soundSim(x, y) + 0.45) / 1.25));
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
function energy(a, b) {
  const d = b.snd.e - a.snd.e;
  return Math.max(0, 1 - Math.abs(d) / 25);
}
// 0..1, without the 👍/👎 override (that is a label, not a prediction).
function score(a, b, o = {}) {
  const tr = C.transition(a, b, { pitchRange: o.pitchRange || 8 });
  const parts = [];
  if (tr.bpmScore != null) parts.push([tr.bpmScore, 0.3]);
  if (tr.pitched && tr.pitched.score != null) parts.push([tr.pitched.score, 0.25]);
  parts.push([affinity(a, b), 0.3]);
  if (a.snd && b.snd && a.snd.e != null && b.snd.e != null) parts.push([energy(a, b), 0.15]);
  const w = parts.reduce((x, p) => x + p[1], 0);
  return Math.max(0, Math.min(1, parts.reduce((x, p) => x + p[0] * p[1], 0) / w));
}
module.exports = { score, affinity };
