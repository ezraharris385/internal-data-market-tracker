/* filters.js — schema-driven global filter engine.
   Filter definitions come from config.json → schema (universal + per-asset-type).
   One state object drives the map pins, the market database, and the properties grid.
   Options and min/max bounds are enumerated from the uploaded workbook itself. */

IDMT.filterEngine = (function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* state */
  const state = {
    hiddenTypes: new Set(),   // asset types toggled OFF
    multi: {},                // col -> Set(selected values); absent col = no constraint
    range: {},                // col -> [min|null, max|null]
    text: '',
  };
  IDMT.filters = state;

  function fieldDefs() {
    const s = IDMT.config.schema || {};
    return { universal: s.universal || [], byType: s.byType || {} };
  }

  function visibleTypes() {
    return Object.keys(IDMT.typeColors).filter((t) => !state.hiddenTypes.has(t));
  }

  /* all filter defs that currently apply: universal + defs for every visible type */
  function activeDefs() {
    const { universal, byType } = fieldDefs();
    const defs = [...universal];
    for (const t of visibleTypes()) {
      for (const d of byType[t] || []) defs.push(Object.assign({ type: t }, d));
    }
    return defs;
  }

  function distinctValues(col) {
    const vals = new Set();
    for (const p of IDMT.properties) {
      const v = String(p[col] ?? '').trim();
      if (v !== '') vals.add(v);
    }
    return [...vals].sort();
  }

  function bounds(col) {
    let min = Infinity, max = -Infinity;
    for (const p of IDMT.properties) {
      const n = IDMT.num(p[col]);
      if (n !== null) { min = Math.min(min, n); max = Math.max(max, n); }
    }
    return min === Infinity ? null : [min, max];
  }

  /* ---------- predicate ---------- */

  function matches(p) {
    if (state.hiddenTypes.has(p._type)) return false;
    if (state.text) {
      const q = state.text.toLowerCase();
      const hay = (p._name + ' ' + p._address + ' ' + p._city + ' ' + p._submarket + ' ' + p._type + ' ' + p._id).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    const { byType } = fieldDefs();
    const typeCols = new Set((byType[p._type] || []).map((d) => d.col));
    const universalCols = new Set(fieldDefs().universal.map((d) => d.col));

    for (const [col, sel] of Object.entries(state.multi)) {
      if (!sel || !sel.size) continue;
      // type-specific filters only constrain rows of that type
      if (!universalCols.has(col) && !typeCols.has(col)) continue;
      if (!sel.has(String(p[col] ?? '').trim())) return false;
    }
    for (const [col, [lo, hi]] of Object.entries(state.range)) {
      if (lo === null && hi === null) continue;
      if (!universalCols.has(col) && !typeCols.has(col)) continue;
      const n = IDMT.num(p[col]);
      if (n === null) return false;
      if (lo !== null && n < lo) return false;
      if (hi !== null && n > hi) return false;
    }
    return true;
  }

  IDMT.filteredProperties = function () {
    return IDMT.properties.filter(matches);
  };

  function activeCount() {
    let n = state.hiddenTypes.size ? 1 : 0;
    for (const sel of Object.values(state.multi)) if (sel && sel.size) n++;
    for (const [lo, hi] of Object.values(state.range)) if (lo !== null || hi !== null) n++;
    return n;
  }

  function clearAll() {
    state.hiddenTypes = new Set();
    state.multi = {};
    state.range = {};
    state.text = '';
    notify();
  }

  function setTypeHidden(type, hidden) {
    hidden ? state.hiddenTypes.add(type) : state.hiddenTypes.delete(type);
    notify();
  }

  function soloType(type) {
    // null = show all
    state.hiddenTypes = new Set(type === null ? [] : Object.keys(IDMT.typeColors).filter((t) => t !== type));
    notify();
  }

  function notify() {
    IDMT.emit('filters');
  }

  /* ---------- UI ---------- */

  function rangeRow(def) {
    const b = bounds(def.col);
    const cur = state.range[def.col] || [null, null];
    const wrap = document.createElement('div');
    wrap.className = 'f-row';
    wrap.innerHTML = `
      <div class="f-label">${esc(def.col)}</div>
      <div class="f-range">
        <input type="number" class="f-min" placeholder="${b ? IDMT.fmt.int(b[0]) : 'min'}" value="${cur[0] ?? ''}" />
        <span class="f-dash">–</span>
        <input type="number" class="f-max" placeholder="${b ? IDMT.fmt.int(b[1]) : 'max'}" value="${cur[1] ?? ''}" />
      </div>`;
    const read = () => {
      const lo = wrap.querySelector('.f-min').value, hi = wrap.querySelector('.f-max').value;
      const pair = [lo === '' ? null : parseFloat(lo), hi === '' ? null : parseFloat(hi)];
      if (pair[0] === null && pair[1] === null) delete state.range[def.col];
      else state.range[def.col] = pair;
      notify();
    };
    wrap.querySelectorAll('input').forEach((i) => i.addEventListener('change', read));
    return wrap;
  }

  function multiRow(def) {
    const values = distinctValues(def.col);
    if (!values.length) return null;
    const sel = state.multi[def.col] || new Set();
    const wrap = document.createElement('div');
    wrap.className = 'f-row';
    wrap.innerHTML = `<div class="f-label">${esc(def.col)}</div><div class="f-chips"></div>`;
    const chips = wrap.querySelector('.f-chips');
    values.slice(0, 14).forEach((v) => {
      const chip = document.createElement('button');
      chip.className = 'f-chip' + (sel.has(v) ? ' active' : '');
      chip.textContent = v;
      chip.addEventListener('click', () => {
        const s = state.multi[def.col] || (state.multi[def.col] = new Set());
        s.has(v) ? s.delete(v) : s.add(v);
        if (!s.size) delete state.multi[def.col];
        chip.classList.toggle('active');
        notify();
      });
      chips.appendChild(chip);
    });
    if (values.length > 14) {
      const more = document.createElement('span');
      more.className = 'f-more';
      more.textContent = `+${values.length - 14} more in data`;
      chips.appendChild(more);
    }
    return wrap;
  }

  function section(title, defs, container, color) {
    if (!defs.length) return;
    const sec = document.createElement('div');
    sec.className = 'f-section';
    sec.innerHTML = `<div class="f-section-title">${color ? `<span class="swatch" style="background:${color}"></span>` : ''}${esc(title)}</div>`;
    let any = false;
    for (const def of defs) {
      const row = def.kind === 'range' ? rangeRow(def) : multiRow(def);
      if (row) { sec.appendChild(row); any = true; }
    }
    if (any) container.appendChild(sec);
  }

  /* Renders the full filter panel into a container. Re-renders on data change. */
  function renderPanel(container) {
    const { universal, byType } = fieldDefs();
    const scroll = container.scrollTop;
    container.innerHTML = `
      <div class="f-head">
        <span>${activeCount()} active filter${activeCount() === 1 ? '' : 's'} · ${IDMT.filteredProperties().length} of ${IDMT.properties.length} properties</span>
        <button class="f-clear">Clear all</button>
      </div>`;
    container.querySelector('.f-clear').addEventListener('click', () => { clearAll(); renderPanel(container); });

    section('Universal', universal, container);
    for (const t of visibleTypes()) {
      section(t + ' criteria', byType[t] || [], container, IDMT.typeColors[t]);
    }
    container.scrollTop = scroll;
  }

  return { matches, activeCount, clearAll, setTypeHidden, soloType, renderPanel, visibleTypes };
})();
