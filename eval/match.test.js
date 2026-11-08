// Unit checks for the match model: run with `node --test eval/`.
// These pin down behaviour a DJ would expect, so a future weight change can't quietly break it.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../site/match.js');

const rec = (o = {}) => ({ styles: ['Deep House'], genres: ['Electronic'], labels: [{ name: 'Strictly Rhythm' }], year: 1994, ...o });
const R1 = rec(), R2 = rec({ labels: [{ name: 'Nervous' }] });
const v = (seed) => Array.from({ length: 12 }, (_, i) => Math.round(Math.sin(seed * 7 + i * 3) * 100));
const track = (bpm, cam, o = {}) => ({ bpm, cam, src: 'acousticbrainz', snd: { v: v(1), e: 60 }, r: R1, ...o });
const p = (a, b, o) => M.score(a, b, { pitchRange: 8, ...o }).p;

test('same tempo, same key, same sound and style scores high', () => {
  assert.ok(p(track(124, '8A'), track(124, '8A', { r: R2 })) >= 0.88);
});

test('a key clash sinks an otherwise perfect pair', () => {
  const s = p(track(124, '8A'), track(124, '2B', { r: R2 }));
  assert.ok(s < 0.25, `clash scored ${s}`);
});

test('pitching half a semitone out of tune costs more than a clean adjacent key', () => {
  const a = track(124, '8A');
  const detuned = p(a, track(120.4, '8A', { r: R2 })); // +3% ≈ half a semitone: 8A becomes a quarter-tone off
  const adjacent = p(a, track(124, '9A', { r: R2 }));
  assert.ok(detuned < adjacent, `detuned ${detuned} vs adjacent ${adjacent}`);
});

test('a whole-semitone pitch lands cleanly on the shifted key', () => {
  const k = M.keyFit('8A', '1A', 5.95); // +1 semitone moves 1A round to 8A
  assert.equal(k.rel, 'same');
  assert.ok(k.off < 0.05);
});

test('release year has no effect', () => {
  const a = track(124, '8A'), b = track(125, '9A', { r: R2 });
  const old = track(125, '9A', { r: { ...R2, year: 1971 } });
  assert.equal(p(a, b), p(a, old));
});

test('bigger pitch moves never score higher', () => {
  const a = track(124, '8A');
  let prev = 1;
  for (const bpm of [124, 122, 120, 118, 116, 114]) {
    const s = M.tempoFit(M.features(a, track(bpm, '8A'), { pitchRange: 8 }).pitch.pct, 8);
    assert.ok(s <= prev, `${bpm}: ${s} > ${prev}`);
    prev = s;
  }
  assert.ok(M.tempoFit(12, 8) < 0.05, 'beyond the pitch range is unplayable');
});

test('missing or estimated data never looks better than known data', () => {
  const a = track(124, '8A');
  assert.ok(p(a, track(124, null, { r: R2 })) < p(a, track(124, '8A', { r: R2 })));
  assert.ok(p(a, track(124, '8A', { r: R2, src: 'deezer-preview' })) < p(a, track(124, '8A', { r: R2 })));
  assert.ok(p(a, track(124, '8A', { r: R2, snd: null })) < p(a, track(124, '8A', { r: R2 })));
});

test('half/double time is a step down from straight tempo', () => {
  const a = track(124, '8A');
  assert.ok(p(a, track(62, '8A', { r: R2 })) < p(a, track(124, '8A', { r: R2 })));
});

test('Ignore keys drops key and tuning', () => {
  const a = track(124, '8A'), b = track(124, '2B', { r: R2 });
  assert.ok(p(a, b, { nokeys: true }) > 0.8);
});

test('metrics: AUC, Brier and calibration bands', () => {
  const m = M.metrics([{ p: 0.9, y: 1 }, { p: 0.85, y: 1 }, { p: 0.2, y: 0 }, { p: 0.1, y: 0 }]);
  assert.equal(m.auc, 1);
  assert.ok(Math.abs(m.brier - (0.01 + 0.0225 + 0.04 + 0.01) / 4) < 1e-9);
  assert.equal(m.high.n, 2);
  assert.equal(m.high.worked, 1);
});

test('learning from ratings fixes a miscalibrated model', () => {
  // Pretend the truth is: key matters far more and sound far less than the defaults assume, and
  // everything works less often. Sample ratings from that truth and check the refit gets closer.
  const truth = { ...M.DEFAULT, bias: 1.5, key: 4, sound: 0.3 };
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const ex = [];
  for (let i = 0; i < 400; i++) {
    const f = { tempo: 0.3 + 0.7 * rnd(), keyv: [1, 0.85, 0.55, 0.08][Math.floor(rnd() * 4)], tuning: 0.4 + 0.6 * rnd(), sound: rnd(), style: 0.15 + 0.85 * rnd(), energy: rnd(), half: rnd() < 0.1 ? 1 : 0, unsure: rnd() < 0.3 ? 0.5 : 0 };
    const x = M.vector(f);
    ex.push({ x, y: rnd() < M.predict(x, truth) ? 1 : 0 });
  }
  const before = M.metrics(ex.map((e) => ({ p: M.predict(e.x, M.DEFAULT), y: e.y })));
  const after = M.metrics(M.crossValidate(ex));
  assert.ok(after.logloss < before.logloss, `log loss ${after.logloss} vs ${before.logloss}`);
  assert.ok(after.ece < before.ece, `calibration gap ${after.ece} vs ${before.ece}`);
  const w = M.fit(ex);
  assert.ok(w.key > M.DEFAULT.key && w.sound < M.DEFAULT.sound, JSON.stringify(w));
});

test('labels: a rating beats a thumb on the same pair, latest rating wins', () => {
  const L = M.labels({
    pairs: { 'a|b': 1, 'c|d': -1 },
    ratings: [{ a: 'b', b: 'a', v: 0, t: 1 }, { a: 'b', b: 'a', v: 0.5, t: 2 }],
  });
  assert.equal(L.length, 2);
  assert.equal(L.find((l) => l.a === 'b').y, 0.5);
  assert.equal(L.find((l) => l.a === 'c').y, 0);
});
