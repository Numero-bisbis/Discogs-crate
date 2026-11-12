/* Crate · Shelves: where each record lives on the real shelf.
   Every compartment has a code (rows A, B, C… and columns 1, 2, 3…, so "B3" is row B, third from the left).
   Each genre group owns some compartments and has a sticker colour; inside a compartment records go A–Z by artist.
   A record's spot is either confirmed (you put it there) or suggested (worked out from its genre and the artist's
   place in the alphabet). Everything is kept in user.shelf, so it travels with the rest of your edits. */
(function () {
  'use strict';
  const A = window.CrateApp;
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = A.esc, norm = A.norm;

  // Colours that come in ordinary multi-colour sticker-dot packs.
  const COLORS = [
    ['red', 'Red', '#e5484d'], ['orange', 'Orange', '#f76b15'], ['yellow', 'Yellow', '#f5c400'], ['green', 'Green', '#30a46c'],
    ['blue', 'Blue', '#0090ff'], ['purple', 'Purple', '#8e4ec6'], ['pink', 'Pink', '#e93d82'], ['brown', 'Brown', '#a07553'],
    ['white', 'White', '#f2f2f2'], ['black', 'Black', '#1a1a1a'],
  ];
  const HEX = Object.fromEntries(COLORS.map(([k, , h]) => [k, h]));
  const CNAME = Object.fromEntries(COLORS.map(([k, n]) => [k, n]));
  const uid = () => Math.random().toString(36).slice(2, 8);
  const rid = (r) => String(r.iid || r.id);
  const ROWS = 'ABCDEFGHIJKL';

  // A first plan from the collection itself: Electronic is split by style, the rest by Discogs genre, and the
  // labels collected as a set (Ed Banger, Deewee) get a compartment of their own in release order.
  // [name, colour, genres/styles, labels, order]; earlier groups win ties, so Hip Hop comes before Funk & Soul.
  const DEFAULT_GROUPS = [
    ['House', 'blue', ['House', 'Deep House', 'Tech House', 'French House', 'Garage House', 'Acid House', 'Chicago House', 'Progressive House', 'Electronic']],
    ['Ed Banger & Deewee', 'black', [], ['Ed Banger Records', 'Deewee'], 'date'],
    ['Techno & Electro', 'purple', ['Techno', 'Electro', 'Acid', 'Minimal', 'Trance', 'Breakbeat', 'Detroit Techno', 'Dub Techno', 'IDM']],
    ['Disco', 'pink', ['Disco', 'Nu-Disco', 'Italo-Disco', 'Boogie', 'Hi NRG']],
    ['Hip Hop', 'red', ['Hip Hop']],
    ['Funk & Soul', 'orange', ['Funk / Soul', 'Funk', 'Soul', 'Contemporary R&B', 'Rhythm & Blues', 'Afrobeat', 'Blues']],
    ['Jazz', 'yellow', ['Jazz']],
    ['Latin & World', 'green', ['Latin', 'Folk, World, & Country', 'Reggae']],
    ['Rock & Pop', 'brown', ['Rock', 'Pop', 'Stage & Screen']],
    ['Other', 'white', []],
  ];
  // Fly's IKEA Kallax 2×4: House over two compartments, the labels in the middle, small genres sharing.
  const KALLAX_2x4 = { A1: ['House'], A2: ['House'], A3: ['Ed Banger & Deewee'], A4: ['Techno & Electro'], B1: ['Disco', 'Jazz'], B2: ['Funk & Soul'], B3: ['Hip Hop'], B4: ['Latin & World', 'Rock & Pop'] };

  // A compartment can hold more than one group (Disco then Jazz): cells map code -> [group id, …].
  // Older saves kept a single id per compartment.
  const S = () => {
    const s = A.user().shelf || null;
    if (s) {
      Object.keys(s.cells).forEach((c) => { if (!Array.isArray(s.cells[c])) s.cells[c] = [s.cells[c]]; });
      s.groups.forEach((g) => { g.labels = g.labels || []; g.order = g.order || 'artist'; });
    }
    return s;
  };
  function save() { cache = null; A.saveUser(); }

  // ---------- which group a record belongs to ----------
  // A style match beats a genre match ("Disco" on a Funk / Soul record puts it with Disco); ties go to the
  // group listed first. A group with no tags catches whatever nothing else claims.
  // A label match beats both: a label group holds everything on those labels, whatever the genre.
  function matchGroup(s, r) {
    let best = null, score = 0;
    for (const g of s.groups) {
      const tags = new Set(g.tags.map(norm)), labels = new Set(g.labels.map(norm));
      const sc = (r.labels.some((l) => labels.has(norm(l.name))) ? 100 : 0) + r.styles.reduce((n, x) => n + (tags.has(norm(x)) ? 3 : 0), 0) + r.genres.reduce((n, x) => n + (tags.has(norm(x)) ? 1 : 0), 0);
      if (sc > score) { best = g; score = sc; }
    }
    return best || s.groups.find((g) => !g.tags.length && !g.labels.length) || null;
  }
  // Alphabetical like a record shop: "The Beatles" under B, "Various" with the Vs, Discogs' "(2)" suffixes dropped.
  const artistKey = (r) => norm(r.artist).replace(/\s*\(\d+\)/g, '').replace(/\*/g, '').replace(/^(the|los|las|le|la|les|die)\s+/, '').trim();
  const sortKey = (r) => artistKey(r) + '\u0000' + String(r.year || 0).padStart(4, '0') + norm(r.title);
  // A label group runs oldest first, then by catalogue number.
  const dateKey = (g) => (r) => String(r.year || 9999) + '\u0000' + norm((r.labels.find((l) => g.labels.some((x) => norm(x) === norm(l.name))) || r.labels[0] || {}).catno).replace(/\d+/g, (d) => d.padStart(6, '0'));
  const keyFor = (g) => (g && g.order === 'date' ? dateKey(g) : sortKey);
  const firstLetter = (r) => { const m = /[a-z0-9]/.exec(artistKey(r)); return m ? (/[0-9]/.test(m[0]) ? '#' : m[0].toUpperCase()) : '#'; };

  function cellsOf(s, g) { return codes(s).filter((c) => (s.cells[c] || []).includes(g.id)); }
  function codes(s) {
    const out = [];
    for (let y = 0; y < s.rows; y++) for (let x = 0; x < s.cols; x++) out.push(ROWS[y] + (x + 1));
    return out;
  }
  const groupsOfCell = (s, code) => (s.cells[code] || []).map((id) => s.groups.find((g) => g.id === id)).filter(Boolean);
  const groupOfCell = (s, code) => groupsOfCell(s, code)[0] || null;
  const cellName = (s, code) => groupsOfCell(s, code).map((g) => g.name).join(' + ');

  // ---------- where everything goes ----------
  // Confirmed records stay put. A record without a spot goes next to its alphabetical neighbour that has one,
  // or, while a group has nothing confirmed yet, the group's records are spread evenly over its compartments.
  let cache = null;
  function plan() {
    const s = S();
    if (!s) return null;
    const rels = A.releases();
    if (cache && cache.rels === rels && cache.n === rels.length) return cache;
    const at = new Map(); // rid -> {code, group, sug, prev, next}
    const members = new Map(s.groups.map((g) => [g.id, []]));
    for (const r of rels) {
      const code = s.loc[rid(r)];
      const m = matchGroup(s, r), inCell = code ? groupsOfCell(s, code) : [];
      const g = code && inCell.length && !inCell.includes(m) ? inCell[0] : m;
      if (g) members.get(g.id).push(r);
      else at.set(rid(r), { code: null, group: null, sug: true });
    }
    for (const g of s.groups) {
      const cells = cellsOf(s, g);
      const key = keyFor(g);
      const list = members.get(g.id).sort((a, b) => key(a).localeCompare(key(b)));
      // Spread over the group's compartments in equal parts, moving each break to the nearest change of
      // letter so a compartment can be labelled "A–K".
      const breaks = [];
      for (let k = 1; k < cells.length; k++) {
        let b = Math.round((k * list.length) / cells.length);
        if (g.order !== 'date') {
          let lo = b, hi = b;
          while (lo > 0 && firstLetter(list[lo - 1]) === firstLetter(list[lo] || list[lo - 1])) lo--;
          while (hi < list.length && hi > 0 && firstLetter(list[hi - 1]) === firstLetter(list[hi])) hi++;
          b = b - lo <= hi - b ? lo : hi;
        }
        breaks.push(Math.max(breaks[breaks.length - 1] || 0, b));
      }
      const anyFixed = list.some((r) => s.loc[rid(r)]);
      list.forEach((r, i) => {
        let code = s.loc[rid(r)] || null;
        const sug = !code;
        if (!code && cells.length) {
          if (anyFixed) {
            let j = i - 1;
            while (j >= 0 && !s.loc[rid(list[j])]) j--;
            if (j >= 0) code = s.loc[rid(list[j])];
            else { j = i + 1; while (j < list.length && !s.loc[rid(list[j])]) j++; code = j < list.length ? s.loc[rid(list[j])] : cells[0]; }
          } else code = cells[breaks.filter((b) => i >= b).length];
        }
        at.set(rid(r), { code, group: g, sug });
      });
      // Neighbours on the shelf, for "between X and Y".
      const byCode = {};
      list.forEach((r) => { const a = at.get(rid(r)); if (a.code) (byCode[a.code] = byCode[a.code] || []).push(r); });
      Object.values(byCode).forEach((rs) => rs.forEach((r, i) => Object.assign(at.get(rid(r)), { prev: rs[i - 1] || null, next: rs[i + 1] || null })));
    }
    const count = {}, letters = {};
    rels.forEach((r) => {
      const a = at.get(rid(r));
      if (!a || !a.code) return;
      count[a.code] = (count[a.code] || 0) + 1;
      if (a.group && a.group.order !== 'date' && cellsOf(s, a.group).length > 1) {
        const L = (letters[a.code] = letters[a.code] || [firstLetter(r), firstLetter(r)]), f = firstLetter(r);
        if (f < L[0]) L[0] = f; if (f > L[1]) L[1] = f;
      }
    });
    // "House A–K": the letters a compartment covers, where a group spans several.
    // The first of a group's compartments starts at A and the last runs to Z, so the shelf labels cover every letter.
    const range = (c) => {
      const L = letters[c];
      if (!L) return '';
      const g = (at.get(rid(rels.find((r) => (at.get(rid(r)) || {}).code === c))) || {}).group;
      const cs = g ? cellsOf(s, g).filter((x) => letters[x]) : [];
      const lo = cs[0] === c ? 'A' : L[0], hi = cs[cs.length - 1] === c ? 'Z' : L[1];
      return lo === hi ? lo : lo + '–' + hi;
    };
    cache = { rels, n: rels.length, at, count, members, range };
    return cache;
  }
  const where = (r) => { const p = plan(); return p ? p.at.get(rid(r)) || null : null; };

  // ---------- chips ----------
  function chip(r, extra = '') {
    const a = where(r);
    if (!a || !a.code) return '';
    const col = a.group ? HEX[a.group.color] : 'transparent';
    const why = a.sug ? `Suggested spot: ${a.code}${a.group ? ' with ' + a.group.name : ''}. Open the record to put it there.` : `On the shelf in ${a.code}${a.group ? ' · ' + a.group.name + ' · ' + CNAME[a.group.color] + ' dot' : ''}`;
    return `<span class="loc${a.sug ? ' sug' : ''}${extra ? ' ' + extra : ''}" style="--dot:${col}" title="${esc(why)}"><i></i>${esc(a.code)}</span>`;
  }
  const between = (a) => {
    if (!a) return '';
    const n = (r) => esc(r.artist.replace(/\s*\(\d+\)$/, ''));
    if (a.prev && a.next) return `between ${n(a.prev)} and ${n(a.next)}`;
    if (a.prev) return `after ${n(a.prev)}`;
    if (a.next) return `before ${n(a.next)}`;
    return '';
  };
  // "A2 · House G–M", "B1 · Disco + Jazz"
  function cellLabel(s, c) {
    const name = cellName(s, c), r = plan().range(c);
    return `${c}${name ? ' · ' + name : ''}${r ? ' ' + r : ''}`;
  }
  // The colour stripe on top of a compartment: one band per group in it.
  function stripe(s, c) {
    const gs = groupsOfCell(s, c);
    if (!gs.length) return 'transparent';
    return `linear-gradient(90deg, ${gs.map((g, i) => `${HEX[g.color]} ${(i * 100) / gs.length}% ${((i + 1) * 100) / gs.length}%`).join(', ')})`;
  }
  function cellOptions(s, selected) {
    return codes(s).map((c) => `<option value="${c}"${c === selected ? ' selected' : ''}>${esc(cellLabel(s, c))}</option>`).join('');
  }

  // ---------- the record page ----------
  function recordHtml(r) {
    const s = S();
    if (!s) return '';
    const a = where(r) || {};
    const g = a.group;
    const line = a.code
      ? `${chip(r, 'big')}<span class="sh-t"><span><b>${a.sug ? 'Goes in' : 'In'} ${esc(a.code)}</b>${g ? ` · ${esc(g.name)} · ${CNAME[g.color]} dot` : ''}</span><small>${between(a)}</small></span>`
      : `<span class="sh-t"><b>No compartment yet</b><small>${g ? `${esc(g.name)} has no compartment: give it one in Settings › Shelves.` : 'No group fits this record: add one in Settings › Shelves.'}</small></span>`;
    return `<div class="shelf-rec" data-rid="${esc(rid(r))}">${line}<span class="sh-act">${a.sug && a.code ? '<button class="small primary" data-sh="ok">Put it there</button>' : ''}<label class="button small sh-move">${a.sug ? 'Elsewhere' : 'Move'}<select data-sh="move" aria-label="Move to compartment"><option value="">Choose…</option>${cellOptions(s, '')}${a.sug ? '' : '<option value="-">Take off the shelf</option>'}</select></label></span></div>`;
  }
  function setLoc(id, code) {
    const s = S();
    if (code) s.loc[id] = code; else delete s.loc[id];
    save();
  }
  // One handler for every shelf control, wherever it is drawn.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sh=ok]');
    if (!b) return;
    const box = b.closest('[data-rid]');
    const r = A.releases().find((x) => rid(x) === box.dataset.rid);
    const a = r && where(r);
    if (!a || !a.code) return;
    setLoc(box.dataset.rid, a.code);
    A.toast(`${a.code} it is${a.group ? ' · ' + CNAME[a.group.color].toLowerCase() + ' dot' : ''}`);
    refresh(box, r);
  });
  document.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-sh=move]');
    if (!sel || !sel.value) return;
    const box = sel.closest('[data-rid]');
    const r = A.releases().find((x) => rid(x) === box.dataset.rid);
    setLoc(box.dataset.rid, sel.value === '-' ? null : sel.value);
    A.toast(sel.value === '-' ? 'Taken off the shelf' : `Moved to ${sel.value}`);
    refresh(box, r);
  });
  function refresh(box, r) {
    A.rerender();
    if (box.closest('.to-shelve')) toShelve();
    else box.outerHTML = recordHtml(r);
  }

  // ---------- new records waiting for a spot ----------
  const unplaced = () => { const s = S(); return s && Object.keys(s.loc).length ? A.releases().filter((r) => !s.loc[rid(r)]) : []; };
  function banner() {
    const n = unplaced().length;
    return n ? `<button class="shelve-banner" data-shelve>${chipDot()}<span><b>${n} new record${n > 1 ? 's' : ''} to shelve</b><small>See where ${n > 1 ? 'they go' : 'it goes'}</small></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>` : '';
  }
  const chipDot = () => '<svg class="sb-ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="17" height="16" rx="1.5"/><path d="M3.5 12h17M12 4v16"/></svg>';
  document.addEventListener('click', (e) => { if (e.target.closest('[data-shelve]')) toShelve(); });
  function toShelve() {
    const list = unplaced().sort((a, b) => String(b.added).localeCompare(String(a.added)));
    const body = $('#drawer-body');
    body.innerHTML = `<div class="to-shelve"><h2>To shelve</h2>
      <p class="sub">${list.length ? 'Records that have no spot yet, newest first. Each one goes A–Z by artist inside its compartment.' : 'Everything has a spot on the shelf.'}</p>
      ${list.length > 1 ? `<button class="small" data-sh="all">Put all ${list.length} where suggested</button>` : ''}
      <ul class="ts-list">${list.map((r) => `<li>${r.thumb ? `<img src="${esc(r.thumb)}" alt="" loading="lazy">` : '<span class="noimg"></span>'}<div><b>${esc(r.artist)} – ${esc(r.title)}</b>${recordHtml(r)}</div></li>`).join('')}</ul></div>`;
    const all = $('[data-sh=all]', body);
    if (all) all.onclick = () => { list.forEach((r) => { const a = where(r); if (a && a.code) S().loc[rid(r)] = a.code; }); save(); A.toast('All shelved'); toShelve(); A.rerender(); };
    if (!$('#drawer').classList.contains('open')) A.openDrawer('To shelve');
  }

  // ---------- Settings › Shelves ----------
  let paint = null; // group id being painted onto compartments, '' = empty
  function setup() {
    const rels = A.releases();
    const s = {
      rows: 2, cols: 4, cap: 75, cells: {}, loc: {},
      groups: DEFAULT_GROUPS.map(([name, color, tags, labels = [], order = 'artist']) => ({ id: uid(), name, color, tags, labels, order })),
    };
    // Drop default groups the collection has nothing for.
    const counts = new Map(s.groups.map((g) => [g, 0]));
    rels.forEach((r) => { const g = matchGroup(s, r); if (g) counts.set(g, counts.get(g) + 1); });
    s.groups = s.groups.filter((g) => counts.get(g) > 0);
    const byName = Object.fromEntries(s.groups.map((g) => [g.name, g.id]));
    Object.entries(KALLAX_2x4).forEach(([c, names]) => { const ids = names.map((n) => byName[n]).filter(Boolean); if (ids.length) s.cells[c] = ids; });
    // Anything the Kallax plan doesn't place shares the emptiest compartment.
    s.groups.filter((g) => !Object.values(s.cells).some((ids) => ids.includes(g.id))).forEach((g) => {
      const free = codes(s).find((c) => !s.cells[c]) || codes(s)[codes(s).length - 1];
      s.cells[free] = [...(s.cells[free] || []), g.id];
    });
    A.user().shelf = s;
    save();
  }
  function settingsHtml() {
    const s = S();
    if (!s) {
      return `<h2>Shelves</h2>
        <p>Give every compartment of your shelf a code like <b>B3</b>, let each genre own a few compartments with its own sticker colour, and file A–Z by artist inside. Crate then shows where every record lives, sorts a mix's pull list by shelf, and tells you where a new record goes.</p>
        <div class="row"><button class="primary" id="sh-setup">Set up shelves</button></div>`;
    }
    const p = plan();
    const all = codes(s);
    const gCount = (g) => p.members.get(g.id).length;
    const placed = Object.keys(s.loc).length, total = A.releases().length;
    const tags = [...new Set(A.releases().flatMap((r) => [...r.genres, ...r.styles]))].sort();
    return `<h2>Shelves <small>${placed ? `${placed} of ${total} records shelved` : 'not shelved yet'}</small></h2>
      <p>Rows are letters from the top, compartments are numbered from the left: <b>B3</b> is the second row, third from the left. Inside a compartment, records go A–Z by artist (label groups by release date). A compartment can hold two genres, one after the other.</p>
      <div class="sh-dims">
        <label class="f"><span>Rows</span><select id="sh-rows">${[1, 2, 3, 4, 5, 6, 8].map((v) => `<option${s.rows === v ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="f"><span>Compartments per row</span><select id="sh-cols">${[1, 2, 3, 4, 5, 6, 8].map((v) => `<option${s.cols === v ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="f"><span>Records per compartment</span><select id="sh-cap">${[30, 40, 50, 60, 65, 70, 75, 80, 90, 100].map((v) => `<option${s.cap === v ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      </div>
      <p class="sh-paint-h">Tap a genre, then tap compartments to add it to them (tap again to take it off).</p>
      <div class="sh-paint">${s.groups.map((g) => `<button type="button" data-paint="${g.id}" class="${paint === g.id ? 'on' : ''}" style="--dot:${HEX[g.color]}"><i></i>${esc(g.name)}</button>`).join('')}<button type="button" data-paint="" class="${paint === '' ? 'on' : ''}" style="--dot:transparent"><i></i>Empty</button></div>
      <div class="sh-grid" style="--cols:${s.cols}">${all.map((c) => {
        const name = cellName(s, c), n = p.count[c] || 0, r = p.range(c);
        return `<button type="button" class="sh-cell${name ? '' : ' empty'}${n > s.cap ? ' full' : ''}" data-cell="${c}" style="--stripe:${stripe(s, c)}"><b>${c}</b><span>${name ? esc(name) + (r ? ' ' + r : '') : 'Empty'}</span><small>${n}/${s.cap}</small><em style="width:${Math.min(100, (n / s.cap) * 100)}%"></em></button>`;
      }).join('')}</div>
      ${all.some((c) => (p.count[c] || 0) > s.cap) ? '<p class="sh-warn">Some compartments are over capacity: give that genre another compartment.</p>' : ''}
      <h3>Genres and sticker colours</h3>
      <datalist id="sh-labels">${[...new Set(A.releases().flatMap((r) => r.labels.map((l) => l.name)))].sort().map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
      <datalist id="sh-tags">${tags.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
      <ul class="sh-groups">${s.groups.map((g) => `<li data-g="${g.id}">
        <label class="sh-col" style="--dot:${HEX[g.color]}"><i></i><select data-k="color" data-dd="native" aria-label="Sticker colour">${COLORS.map(([k, n]) => `<option value="${k}"${g.color === k ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        <div class="sh-gm"><input data-k="name" value="${esc(g.name)}" aria-label="Group name">
          <input data-k="tags" list="sh-tags" value="${esc(g.tags.join(', '))}" placeholder="${g.labels.length ? 'Genres or styles (optional)' : 'Catches everything else'}" aria-label="Discogs genres and styles, separated by commas">
          <input data-k="labels" list="sh-labels" value="${esc(g.labels.join(', '))}" placeholder="Labels (optional), e.g. Ed Banger Records" aria-label="Record labels, separated by commas">
          <label class="sh-ord"><span>Order</span><select data-k="order"><option value="artist"${g.order !== 'date' ? ' selected' : ''}>A–Z by artist</option><option value="date"${g.order === 'date' ? ' selected' : ''}>Release date</option></select></label>
          <small>${gCount(g)} records · ${cellsOf(s, g).join(', ') || 'no compartment yet'}</small></div>
        <button class="small danger" data-del="${g.id}" aria-label="Remove group">×</button></li>`).join('')}</ul>
      <p class="hint">A record on one of a group's labels always goes there. Otherwise it joins the group whose Discogs styles or genres match best (a style beats a genre; on a tie, the group higher in this list). A group with no genres or labels takes whatever is left.</p>
      <div class="row"><button class="small" id="sh-add">+ Add genre group</button></div>
      <h3>Put it on the shelf</h3>
      <p>Crate suggests a spot for every record. Once your shelf matches, confirm it: from then on records stay where they are and new ones show up under <b>To shelve</b> in Records.</p>
      <div class="row">${total - placed ? `<button class="primary" id="sh-confirm">Confirm all ${total - placed} suggested spots</button>` : ''}<button class="small" id="sh-list">Shelf list by compartment</button>${placed ? '<button class="small danger" id="sh-reset">Forget all spots</button>' : ''}</div>`;
  }
  function wireSettings(box) {
    const s = S();
    const again = () => { cache = null; box.innerHTML = settingsHtml(); wireSettings(box); };
    const on = (sel, ev, fn) => { const el = $(sel, box); if (el) el[ev] = fn; };
    on('#sh-setup', 'onclick', () => { setup(); again(); A.toast('A first plan from your collection: change anything'); });
    if (!s) return;
    on('#sh-rows', 'onchange', (e) => { s.rows = +e.target.value; save(); again(); });
    on('#sh-cols', 'onchange', (e) => { s.cols = +e.target.value; save(); again(); });
    on('#sh-cap', 'onchange', (e) => { s.cap = +e.target.value; save(); again(); });
    $$('[data-paint]', box).forEach((b) => (b.onclick = () => { paint = paint === b.dataset.paint ? null : b.dataset.paint; again(); }));
    $$('[data-cell]', box).forEach((b) => (b.onclick = () => {
      const c = b.dataset.cell;
      if (paint == null) { A.toast('Tap a genre above first, then the compartments for it'); return; }
      const ids = s.cells[c] || [];
      if (!paint) delete s.cells[c];
      else if (ids.includes(paint)) { s.cells[c] = ids.filter((x) => x !== paint); if (!s.cells[c].length) delete s.cells[c]; }
      else s.cells[c] = [...ids, paint];
      save(); again();
    }));
    $$('.sh-groups li', box).forEach((li) => {
      const g = s.groups.find((x) => x.id === li.dataset.g);
      $$('[data-k]', li).forEach((inp) => (inp.onchange = () => {
        if (inp.dataset.k === 'tags' || inp.dataset.k === 'labels') g[inp.dataset.k] = inp.value.split(',').map((t) => t.trim()).filter(Boolean);
        else if (inp.dataset.k === 'order') g.order = inp.value;
        else g[inp.dataset.k] = inp.value.trim() || g[inp.dataset.k];
        save(); again();
      }));
    });
    $$('[data-del]', box).forEach((b) => (b.onclick = () => {
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Remove?'; return; }
      s.groups = s.groups.filter((g) => g.id !== b.dataset.del);
      Object.keys(s.cells).forEach((c) => { s.cells[c] = s.cells[c].filter((x) => x !== b.dataset.del); if (!s.cells[c].length) delete s.cells[c]; });
      save(); again();
    }));
    on('#sh-add', 'onclick', () => {
      const used = new Set(s.groups.map((g) => g.color));
      s.groups.push({ id: uid(), name: 'New group', color: (COLORS.find(([k]) => !used.has(k)) || COLORS[0])[0], tags: [], labels: [], order: 'artist' });
      save(); again();
    });
    on('#sh-confirm', 'onclick', () => {
      A.releases().forEach((r) => { const a = where(r); if (!s.loc[rid(r)] && a && a.code) s.loc[rid(r)] = a.code; });
      save(); again(); A.toast('Shelf confirmed');
    });
    on('#sh-reset', 'onclick', (e) => {
      const b = e.currentTarget;
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Tap again to forget all spots'; return; }
      s.loc = {}; save(); again();
    });
    on('#sh-list', 'onclick', shelfList);
  }
  // Everything in shelf order, one compartment after another: handy while re-filing.
  function shelfList() {
    const s = S(), p = plan();
    const by = {};
    A.releases().forEach((r) => { const a = where(r); if (a && a.code) (by[a.code] = by[a.code] || []).push(r); });
    $('#drawer-body').innerHTML = `<div class="to-shelve"><h2>Shelf list</h2><p class="sub">Every compartment in order, A–Z inside. Dashed codes are suggestions you haven't confirmed yet.</p>
      ${codes(s).filter((c) => by[c]).map((c) => { const g = groupOfCell(s, c); return `<h3><span class="loc big" style="--dot:${g ? HEX[g.color] : 'transparent'}"><i></i>${c}</span> ${esc(cellLabel(s, c).replace(/^\S+( · )?/, ''))} <small>${p.count[c]} records</small></h3>
        <ol class="sh-ol">${by[c].sort(order).map((r) => { const a = where(r); return `<li class="${S().loc[rid(r)] ? '' : 'sug'}"><span class="loc" style="--dot:${a.group ? HEX[a.group.color] : 'transparent'}"><i></i></span>${a.group && a.group.order === 'date' && r.year ? r.year + ' · ' : ''}<b>${esc(r.artist)}</b> – ${esc(r.title)}</li>`; }).join('')}</ol>`; }).join('')}</div>`;
    A.openDrawer('Shelf list');
  }

  // Physical order: compartment, then the groups in it one after the other, then A–Z (or by date).
  // Records without a compartment go last.
  function order(a, b) {
    const s = S(), all = s ? codes(s) : [];
    const wa = where(a) || {}, wb = where(b) || {};
    const x = all.indexOf(wa.code), y = all.indexOf(wb.code);
    if (x !== y) return (x < 0 ? 1e6 : x) - (y < 0 ? 1e6 : y);
    const ids = (s && s.cells[wa.code]) || [];
    const gx = ids.indexOf(wa.group && wa.group.id), gy = ids.indexOf(wb.group && wb.group.id);
    if (gx !== gy) return gx - gy;
    const k = keyFor(wa.group);
    return k(a).localeCompare(k(b));
  }

  // ---------- what app.js asks for ----------
  window.CrateShelf = {
    on: () => !!S(),
    where, chip, recordHtml, banner,
    code: (r) => { const a = where(r); return a && a.code; },
    // Physical order: compartment, then A–Z. Records without a compartment go last.
    order,
    cells: () => { const s = S(); return s ? codes(s).map((c) => [c, plan().count[c] || 0, cellLabel(s, c)]) : []; },
    settings(box) { box.innerHTML = settingsHtml(); wireSettings(box); },
    reset: () => { cache = null; },
  };
})();
