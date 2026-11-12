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

  // A first plan from the collection itself: Electronic is split by style, the rest by Discogs genre.
  const DEFAULT_GROUPS = [
    ['House', 'blue', ['House', 'Deep House', 'Tech House', 'French House', 'Garage House', 'Acid House', 'Chicago House', 'Progressive House', 'Electronic']],
    ['Techno & Electro', 'purple', ['Techno', 'Electro', 'Acid', 'Minimal', 'Trance', 'Breakbeat', 'Detroit Techno', 'Dub Techno', 'IDM']],
    ['Disco', 'pink', ['Disco', 'Nu-Disco', 'Italo-Disco', 'Boogie', 'Hi NRG']],
    ['Funk & Soul', 'orange', ['Funk / Soul', 'Funk', 'Soul', 'Contemporary R&B', 'Rhythm & Blues', 'Afrobeat', 'Blues']],
    ['Hip Hop', 'red', ['Hip Hop']],
    ['Jazz', 'yellow', ['Jazz']],
    ['Latin & World', 'green', ['Latin', 'Folk, World, & Country', 'Reggae']],
    ['Rock & Pop', 'brown', ['Rock', 'Pop', 'Stage & Screen']],
    ['Other', 'white', []],
  ];

  const S = () => A.user().shelf || null;
  function save() { cache = null; A.saveUser(); }

  // ---------- which group a record belongs to ----------
  // A style match beats a genre match ("Disco" on a Funk / Soul record puts it with Disco); ties go to the
  // group listed first. A group with no tags catches whatever nothing else claims.
  function matchGroup(s, r) {
    let best = null, score = 0;
    for (const g of s.groups) {
      const tags = new Set(g.tags.map(norm));
      const sc = r.styles.reduce((n, x) => n + (tags.has(norm(x)) ? 3 : 0), 0) + r.genres.reduce((n, x) => n + (tags.has(norm(x)) ? 1 : 0), 0);
      if (sc > score) { best = g; score = sc; }
    }
    return best || s.groups.find((g) => !g.tags.length) || null;
  }
  // Alphabetical like a record shop: "The Beatles" under B, "Various" with the Vs, Discogs' "(2)" suffixes dropped.
  const artistKey = (r) => norm(r.artist).replace(/\s*\(\d+\)/g, '').replace(/\*/g, '').replace(/^(the|los|las|le|la|les|die)\s+/, '').trim();
  const sortKey = (r) => artistKey(r) + '\u0000' + String(r.year || 0).padStart(4, '0') + norm(r.title);

  function cellsOf(s, g) { return codes(s).filter((c) => s.cells[c] === g.id); }
  function codes(s) {
    const out = [];
    for (let y = 0; y < s.rows; y++) for (let x = 0; x < s.cols; x++) out.push(ROWS[y] + (x + 1));
    return out;
  }
  const groupOfCell = (s, code) => s.groups.find((g) => g.id === s.cells[code]) || null;

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
      const g = code ? (groupOfCell(s, code) || matchGroup(s, r)) : matchGroup(s, r);
      if (g) members.get(g.id).push(r);
      else at.set(rid(r), { code: null, group: null, sug: true });
    }
    for (const g of s.groups) {
      const list = members.get(g.id).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
      const cells = cellsOf(s, g);
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
          } else code = cells[Math.min(cells.length - 1, Math.floor((i * cells.length) / list.length))];
        }
        at.set(rid(r), { code, group: g, sug });
      });
      // Neighbours on the shelf, for "between X and Y".
      const byCode = {};
      list.forEach((r) => { const a = at.get(rid(r)); if (a.code) (byCode[a.code] = byCode[a.code] || []).push(r); });
      Object.values(byCode).forEach((rs) => rs.forEach((r, i) => Object.assign(at.get(rid(r)), { prev: rs[i - 1] || null, next: rs[i + 1] || null })));
    }
    const count = {};
    at.forEach((a) => { if (a.code) count[a.code] = (count[a.code] || 0) + 1; });
    cache = { rels, n: rels.length, at, count, members };
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
  function cellOptions(s, selected) {
    return codes(s).map((c) => { const g = groupOfCell(s, c); return `<option value="${c}"${c === selected ? ' selected' : ''}>${c}${g ? ' · ' + esc(g.name) : ''}</option>`; }).join('');
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
    const s = { rows: 4, cols: 4, cap: 65, groups: DEFAULT_GROUPS.map(([name, color, tags]) => ({ id: uid(), name, color, tags })), cells: {}, loc: {} };
    // Drop default groups the collection has nothing for.
    const counts = new Map(s.groups.map((g) => [g, 0]));
    rels.forEach((r) => { const g = matchGroup(s, r); if (g) counts.set(g, counts.get(g) + 1); });
    s.groups = s.groups.filter((g) => counts.get(g) > 0);
    // Compartments in proportion to each group's size, at least one each, filled along the rows.
    const all = codes(s), total = rels.length || 1;
    const want = s.groups.map((g) => Math.max(1, (counts.get(g) / total) * all.length));
    const n = want.map(Math.floor);
    while (n.reduce((a, b) => a + b, 0) > all.length) n[n.indexOf(Math.max(...n))]--;
    while (n.reduce((a, b) => a + b, 0) < all.length) { const i = want.map((w, k) => w - n[k]).reduce((bi, d, k, arr) => (d > arr[bi] ? k : bi), 0); n[i]++; want[i] = -1; }
    let c = 0;
    s.groups.forEach((g, i) => { for (let k = 0; k < n[i] && c < all.length; k++) s.cells[all[c++]] = g.id; });
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
      <p>Rows are letters from the top, compartments are numbered from the left: <b>B3</b> is the second row, third from the left. Inside a compartment, records go A–Z by artist.</p>
      <div class="sh-dims">
        <label class="f"><span>Rows</span><select id="sh-rows">${[1, 2, 3, 4, 5, 6, 8].map((v) => `<option${s.rows === v ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="f"><span>Compartments per row</span><select id="sh-cols">${[1, 2, 3, 4, 5, 6, 8].map((v) => `<option${s.cols === v ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="f"><span>Records per compartment</span><select id="sh-cap">${[30, 40, 50, 60, 65, 70, 80, 90, 100].map((v) => `<option${s.cap === v ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      </div>
      <p class="sh-paint-h">Tap a genre, then tap compartments to give them to it.</p>
      <div class="sh-paint">${s.groups.map((g) => `<button type="button" data-paint="${g.id}" class="${paint === g.id ? 'on' : ''}" style="--dot:${HEX[g.color]}"><i></i>${esc(g.name)}</button>`).join('')}<button type="button" data-paint="" class="${paint === '' ? 'on' : ''}" style="--dot:transparent"><i></i>Empty</button></div>
      <div class="sh-grid" style="--cols:${s.cols}">${all.map((c) => {
        const g = groupOfCell(s, c), n = p.count[c] || 0;
        return `<button type="button" class="sh-cell${g ? '' : ' empty'}${n > s.cap ? ' full' : ''}" data-cell="${c}" style="--dot:${g ? HEX[g.color] : 'transparent'}"><b>${c}</b><span>${g ? esc(g.name) : 'Empty'}</span><small>${n}/${s.cap}</small><em style="width:${Math.min(100, (n / s.cap) * 100)}%"></em></button>`;
      }).join('')}</div>
      ${all.some((c) => (p.count[c] || 0) > s.cap) ? '<p class="sh-warn">Some compartments are over capacity: give that genre another compartment.</p>' : ''}
      <h3>Genres and sticker colours</h3>
      <datalist id="sh-tags">${tags.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
      <ul class="sh-groups">${s.groups.map((g) => `<li data-g="${g.id}">
        <label class="sh-col" style="--dot:${HEX[g.color]}"><i></i><select data-k="color" data-dd="native" aria-label="Sticker colour">${COLORS.map(([k, n]) => `<option value="${k}"${g.color === k ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        <div class="sh-gm"><input data-k="name" value="${esc(g.name)}" aria-label="Group name">
          <input data-k="tags" list="sh-tags" value="${esc(g.tags.join(', '))}" placeholder="Catches everything else" aria-label="Discogs genres and styles, separated by commas">
          <small>${gCount(g)} records · ${cellsOf(s, g).join(', ') || 'no compartment yet'}</small></div>
        <button class="small danger" data-del="${g.id}" aria-label="Remove group">×</button></li>`).join('')}</ul>
      <p class="hint">Records join the group whose Discogs styles or genres match best (a style beats a genre). A group with no tags takes whatever is left.</p>
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
      if (paint) s.cells[c] = paint; else delete s.cells[c];
      save(); again();
    }));
    $$('.sh-groups li', box).forEach((li) => {
      const g = s.groups.find((x) => x.id === li.dataset.g);
      $$('[data-k]', li).forEach((inp) => (inp.onchange = () => {
        if (inp.dataset.k === 'tags') g.tags = inp.value.split(',').map((t) => t.trim()).filter(Boolean);
        else g[inp.dataset.k] = inp.value.trim() || g[inp.dataset.k];
        save(); again();
      }));
    });
    $$('[data-del]', box).forEach((b) => (b.onclick = () => {
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Remove?'; return; }
      s.groups = s.groups.filter((g) => g.id !== b.dataset.del);
      Object.keys(s.cells).forEach((c) => { if (s.cells[c] === b.dataset.del) delete s.cells[c]; });
      save(); again();
    }));
    on('#sh-add', 'onclick', () => {
      const used = new Set(s.groups.map((g) => g.color));
      s.groups.push({ id: uid(), name: 'New group', color: (COLORS.find(([k]) => !used.has(k)) || COLORS[0])[0], tags: [] });
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
      ${codes(s).filter((c) => by[c]).map((c) => { const g = groupOfCell(s, c); return `<h3><span class="loc big" style="--dot:${g ? HEX[g.color] : 'transparent'}"><i></i>${c}</span> ${g ? esc(g.name) : ''} <small>${p.count[c]} records</small></h3>
        <ol class="sh-ol">${by[c].sort((a, b) => sortKey(a).localeCompare(sortKey(b))).map((r) => `<li class="${S().loc[rid(r)] ? '' : 'sug'}"><b>${esc(r.artist)}</b> – ${esc(r.title)}</li>`).join('')}</ol>`; }).join('')}</div>`;
    A.openDrawer('Shelf list');
  }

  // ---------- what app.js asks for ----------
  window.CrateShelf = {
    on: () => !!S(),
    where, chip, recordHtml, banner,
    code: (r) => { const a = where(r); return a && a.code; },
    // Physical order: compartment, then A–Z. Records without a compartment go last.
    order: (a, b) => {
      const s = S(), all = s ? codes(s) : [];
      const x = all.indexOf((where(a) || {}).code), y = all.indexOf((where(b) || {}).code);
      return (x < 0 ? 1e6 : x) - (y < 0 ? 1e6 : y) || sortKey(a).localeCompare(sortKey(b));
    },
    cells: () => { const s = S(); return s ? codes(s).map((c) => { const g = groupOfCell(s, c); return [c, plan().count[c] || 0, `${c}${g ? ' · ' + g.name : ''}`]; }) : []; },
    settings(box) { box.innerHTML = settingsHtml(); wireSettings(box); },
    reset: () => { cache = null; },
  };
})();
