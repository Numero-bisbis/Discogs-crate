#!/usr/bin/env node
// Measures how well the match score predicts transitions that actually work, from your ratings.
//
//   node eval/evaluate.js                  ratings from user/state.json (synced from the app)
//   node eval/evaluate.js backup.json      ratings from a "Download backup" file
//   node eval/evaluate.js --weights        also print the weights learned from all ratings
//
// It compares three scorers on the same labelled pairs:
//   old      the weighted average the app used before (eval/legacy.js, with release year)
//   default  the match model with its starting weights (site/match.js)
//   learned  the match model refitted on your ratings, scored by 5-fold cross-validation so no
//            rating is predicted by a model that saw it
// and prints, for each: how often pairs it called 80%+ actually worked, a calibration table
// ("said 70-80%, worked 74%"), AUC (does it rank good above bad), Brier and log loss (lower is better).
// With no ratings yet it prints how the old and new scores spread over pairs the generator would consider.
const M = require('../site/match.js');
const legacy = require('./legacy.js');
const { loadCollection, loadUser, trackIndex } = require('./data.js');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const showWeights = args.includes('--weights');

const data = loadCollection();
const { user, file: userFile } = loadUser(file);
const byKey = trackIndex(data, user);
const range = (user.settings && user.settings.pitchRange) || 8;
if (user.model) M.setModel(null); // always start from the defaults; "learned" is refitted here

const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const num = (x, d = 3) => (x == null ? '–' : x.toFixed(d));
const out = [];
const say = (s = '') => out.push(s);

const labelled = M.labels(user).map((l) => ({ ...l, A: byKey.get(l.a), B: byKey.get(l.b) })).filter((l) => l.A && l.B);
say(`# Match model evaluation`);
say();
say(`Collection: ${data.releases.length} records. Labels: ${userFile ? require('path').basename(userFile) : 'none found'}, ${labelled.length} rated pairs` +
  (labelled.length ? ` (${labelled.filter((l) => l.from === 'rating').length} ratings, ${labelled.filter((l) => l.from === 'thumb').length} thumbs; ${labelled.filter((l) => l.y >= 0.75).length} worked, ${labelled.filter((l) => l.y === 0.5).length} just about, ${labelled.filter((l) => l.y <= 0.25).length} didn't).` : '.'));
say();

if (labelled.length >= 8) {
  const ex = labelled.map((l) => ({ x: M.vector(M.features(l.A, l.B, { pitchRange: range })), y: l.y }));
  const runs = [
    ['old', labelled.map((l) => ({ p: legacy.score(l.A, l.B, { pitchRange: range }), y: l.y }))],
    ['default', ex.map((e) => ({ p: M.predict(e.x, M.DEFAULT), y: e.y }))],
    ['learned (cross-validated)', M.crossValidate(ex, Math.min(5, labelled.length))],
  ];
  const app = labelled.filter((l) => l.p != null);
  if (app.length >= 8) runs.push(['what the app showed when you rated', app.map((l) => ({ p: l.p, y: l.y }))]);
  say('| scorer | said 80%+ → worked | AUC ↑ | Brier ↓ | log loss ↓ | calibration gap ↓ |');
  say('|---|---|---|---|---|---|');
  const ms = runs.map(([name, preds]) => [name, M.metrics(preds)]);
  for (const [name, m] of ms) say(`| ${name} | ${m.high.n ? `${pct(m.high.worked)} of ${m.high.n}` : 'none'} | ${num(m.auc, 2)} | ${num(m.brier)} | ${num(m.logloss)} | ${pct(m.ece)} |`);
  say();
  say('Calibration, by what each scorer said (pairs · share that worked):');
  say();
  say(`| said | ${ms.map(([n]) => n).join(' | ')} |`);
  say(`|---|${ms.map(() => '---').join('|')}|`);
  M.BANDS.forEach(([lo, hi], i) => say(`| ${Math.round(lo * 100)}–${Math.round(hi * 100)}% | ${ms.map(([, m]) => (m.bands[i].n ? `${m.bands[i].n} · ${pct(m.bands[i].worked)}` : '–')).join(' | ')} |`));
  say();
  if (showWeights) {
    const w = M.fit(ex);
    say('Weights learned from all ratings (default in brackets):');
    say();
    say(M.NAMES.map((k) => `- ${k}: ${w[k].toFixed(2)} (${M.DEFAULT[k]})`).join('\n'));
    say();
  }
} else {
  say(`Not enough ratings to measure calibration yet (${labelled.length}; 8 is the minimum, 40+ gives a useful read). Rate transitions in the app under Settings › Match score.`);
  say();
}

// Always: what happened to the pairs the old score called 80%+, i.e. the "says 80% but doesn't work"
// cases. For a sample of tracks, take the 10 best next tracks by the old score (what "What could come
// next" listed), and see how the current model rates them and which parts it finds weak.
const pool = [...byKey.values()].filter((t) => t.bpm && t.cam);
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const top = [];
for (let i = 0; i < 200 && pool.length > 20; i++) {
  const a = pool[Math.floor(rnd() * pool.length)];
  const c = [];
  for (const b of pool) {
    if (b.r === a.r) continue;
    const f = M.features(a, b, { pitchRange: range });
    if (!f.pitch || Math.abs(f.pitch.pct) > range) continue;
    c.push({ old: legacy.score(a, b, { pitchRange: range }), a, b, f });
  }
  top.push(...c.sort((x, y) => y.old - x.old).slice(0, 10));
}
const hi = top.filter((x) => x.old >= 0.8).map((x) => ({ ...x, now: M.score(x.a, x.b, { pitchRange: range }).p }));
if (hi.length) {
  const share = (f) => pct(hi.filter(f).length / hi.length);
  const med = (xs) => { const v = xs.slice().sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  say(`Pairs the old score put at 80%+ among the top 10 suggestions for 200 random tracks (${hi.length} pairs):`);
  say();
  say(`- current model: median ${pct(med(hi.map((x) => x.now)))}, ${share((x) => x.now >= 0.8)} still 80%+, ${share((x) => x.now < 0.5)} under 50%`);
  say(`- left over a third of a semitone out of tune by the pitch move: ${share((x) => x.f.key && x.f.key.off > 1 / 3)}`);
  say(`- key clash once pitched: ${share((x) => x.f.key && x.f.key.rel === 'clash')}`);
  say(`- pitch move over 4%: ${share((x) => Math.abs(x.f.pitch.pct) > 4)}; half/double time: ${share((x) => x.f.half)}`);
  say(`- sound fit under 0.4 (a random pair is about 0.33): ${share((x) => x.f.sound < 0.4)}`);
  say(`- BPM or key estimated from a 30 s preview: ${share((x) => x.f.unsure > 0)}`);
  say();
}
console.log(out.join('\n'));
