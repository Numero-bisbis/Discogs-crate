// Loads the built collection (site/data.json) and a Crate user state (backup file or user/state.json)
// and turns them into the track objects the app scores, with your BPM/key edits applied.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadCollection(file = path.join(ROOT, 'site', 'data.json')) {
  if (!fs.existsSync(file)) throw new Error(`${path.relative(ROOT, file)} is missing: run "python sync/build.py" first`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadUser(file) {
  const candidates = file ? [file] : [path.join(ROOT, 'user', 'state.json')];
  for (const f of candidates) if (fs.existsSync(f)) return { user: JSON.parse(fs.readFileSync(f, 'utf8')), file: f };
  return { user: { overrides: {}, mixes: [], pairs: {}, ratings: [] }, file: null };
}

// Same shape as trackObj() in app.js.
function trackIndex(data, user) {
  const byKey = new Map();
  const ov = (user && user.overrides) || {};
  for (const r of data.releases) {
    for (const t of r.tracks) {
      const o = ov[t.k] || {};
      byKey.set(t.k, { ...t, r, bpm: o.bpm ?? t.bpm ?? null, cam: o.cam ?? t.cam ?? null, key: o.key ?? t.key ?? null, src: o.bpm || o.cam ? 'manual' : t.src });
    }
  }
  return byKey;
}

module.exports = { ROOT, loadCollection, loadUser, trackIndex };
