/* search.js — Google-style autocomplete over the uploaded data.
   One shared index (properties, submarkets, cities, counties, states, the market itself)
   attachable to any input: the map bar, the Properties tab, and the Market Database tab.
   Remembers recent picks (localStorage) and shows them when the box is focused empty. */

IDMT.search = (function () {
  const RECENT_KEY = 'idmt-recent-searches';
  const MAX_RECENT = 8;
  let index = [];

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- index ---------- */

  function addGeoEntities(kind, values, col, color) {
    for (const v of values) {
      if (!v) continue;
      index.push({
        kind, label: v, sub: 'Filter to this ' + kind.toLowerCase(),
        text: v.toLowerCase(), color, square: true,
        action: () => {
          IDMT.filters.multi[col] = new Set([v]);
          IDMT.emit('filters');
        },
      });
    }
  }

  function build() {
    index = [];
    for (const p of IDMT.properties) {
      index.push({
        kind: 'Property', label: p._name,
        sub: [p._address, p._city].filter(Boolean).join(', '),
        text: (p._name + ' ' + p._address + ' ' + p._city + ' ' + p._id).toLowerCase(),
        color: IDMT.typeColors[p._type] || '#898781',
        action: () => { IDMT.app.switchView('map'); IDMT.map.focusProperty(p._id); },
      });
    }
    // submarkets across every boundary set: fly on the map
    for (const name of IDMT.allSubmarketNames ? IDMT.allSubmarketNames() : []) {
      index.push({
        kind: 'Submarket', label: name, sub: 'Submarket boundary',
        text: name.toLowerCase(), color: '#9085e9', square: true,
        action: () => { IDMT.app.switchView('map'); IDMT.map.focusSubmarket(name); },
      });
    }
    const distinct = (get) => [...new Set(IDMT.properties.map(get).filter(Boolean))].sort();
    addGeoEntities('City', distinct((p) => p._city), IDMT.config.fields.city, '#199e70');
    addGeoEntities('County', distinct((p) => p._county), IDMT.config.fields.county, '#c98500');
    addGeoEntities('State', distinct((p) => p._state), IDMT.config.fields.state, '#d55181');
    // the market itself: picking it clears every geographic filter
    index.push({
      kind: 'Market', label: IDMT.config.market.name, sub: 'Entire market — clears geographic filters',
      text: (IDMT.config.market.name + ' ' + (IDMT.config.market.shortName || '')).toLowerCase(),
      color: '#3987e5', square: true,
      action: () => {
        const f = IDMT.config.fields;
        [f.submarket, f.city, f.county, f.state, 'Submarket', 'City', 'County', 'State'].forEach((c) => delete IDMT.filters.multi[c]);
        IDMT.emit('filters');
      },
    });
  }

  /* ---------- recents (the memory system) ---------- */

  function recents() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (e) { return []; }
  }

  function remember(item) {
    const list = recents().filter((r) => !(r.label === item.label && r.kind === item.kind));
    list.unshift({ label: item.label, kind: item.kind });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  }

  function recentItems() {
    return recents()
      .map((r) => index.find((it) => it.label === r.label && it.kind === r.kind))
      .filter(Boolean);
  }

  /* ---------- query ---------- */

  function query(q) {
    q = q.trim().toLowerCase();
    if (!q) return recentItems();
    const starts = [], contains = [];
    for (const item of index) {
      const pos = item.text.indexOf(q);
      if (pos === -1) continue;
      (item.label.toLowerCase().startsWith(q) || pos === 0 ? starts : contains).push(item);
      if (starts.length + contains.length > 80) break;
    }
    return [...starts, ...contains].slice(0, 8);
  }

  function highlight(label, q) {
    if (!q) return esc(label);
    const i = label.toLowerCase().indexOf(q.toLowerCase());
    if (i === -1) return esc(label);
    return esc(label.slice(0, i)) + '<b>' + esc(label.slice(i, i + q.length)) + '</b>' + esc(label.slice(i + q.length));
  }

  /* ---------- attach to any input ---------- */

  function attachTo(inputId, boxId) {
    const input = document.getElementById(inputId);
    const box = document.getElementById(boxId);
    if (!input || !box) return;
    let results = [];
    let hovered = -1;

    function render(q) {
      const isRecent = !q.trim();
      results = query(q);
      hovered = -1;
      if (!results.length) { close(); return; }
      box.innerHTML = (isRecent ? '<div class="s-recent-head">Recent searches</div>' : '') +
        results.map((r, i) => `
        <div class="suggestion" data-i="${i}">
          <span class="s-icon ${r.square ? 'submarket' : ''}" style="background:${r.color}"></span>
          <span class="s-label">${highlight(r.label, q.trim())}${r.sub ? ' <span style="color:var(--text-muted)">· ' + esc(r.sub) + '</span>' : ''}</span>
          <span class="s-kind">${r.kind}</span>
        </div>`).join('');
      box.classList.add('open');
      box.querySelectorAll('.suggestion').forEach((el) => {
        el.addEventListener('mousedown', (e) => { e.preventDefault(); pick(parseInt(el.dataset.i, 10)); });
      });
    }

    function pick(i) {
      const r = results[i];
      if (!r) return;
      input.value = r.kind === 'Property' ? r.label : '';
      remember(r);
      close();
      r.action();
    }

    function close() {
      box.classList.remove('open');
      box.innerHTML = '';
      results = [];
      hovered = -1;
    }

    function setHovered(i) {
      hovered = i;
      box.querySelectorAll('.suggestion').forEach((el, j) => el.classList.toggle('hovered', j === i));
    }

    input.addEventListener('input', () => {
      input.closest('.search-box')?.classList.toggle('has-text', !!input.value);
      render(input.value);
    });
    input.addEventListener('focus', () => render(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHovered(Math.min(hovered + 1, results.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setHovered(Math.max(hovered - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(hovered >= 0 ? hovered : 0); }
      else if (e.key === 'Escape') { close(); input.blur(); }
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
  }

  function attach() {
    attachTo('search-input', 'search-suggestions');
    attachTo('props-search-input', 'props-search-suggestions');
    attachTo('db-search-input', 'db-search-suggestions');
    const clear = document.getElementById('search-clear');
    if (clear) {
      clear.addEventListener('click', () => {
        const input = document.getElementById('search-input');
        input.value = '';
        input.closest('.search-box')?.classList.remove('has-text');
        input.focus();
      });
    }
  }

  return { build, attach, indexSize: () => index.length };
})();
