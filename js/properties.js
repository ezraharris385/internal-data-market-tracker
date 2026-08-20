/* properties.js — full sortable/filterable grid of the workbook. Respects the global
   filter engine; when a single asset type is active, that type's specific columns
   (clear height, units, traffic counts…) are appended to the table automatically. */

IDMT.propertiesView = (function () {
  let sortKey = '_name';
  let sortDir = 1;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CORE = [
    { key: '_name', label: 'Property' },
    { key: '_address', label: 'Address' },
    { key: '_type', label: 'Type' },
    { key: '_class', label: 'Class' },
    { key: '_submarket', label: 'Submarket' },
    { key: '_size', label: 'Building SF', fmt: (p) => IDMT.fmt.int(p._size) },
    { key: 'Year Built', label: 'Year Built', raw: true },
    { key: '_occ', label: 'Occupancy', fmt: (p) => IDMT.fmt.pct(p._occ) },
    { key: '_rent', label: 'Rent ($/SF)', fmt: (p) => (p._rent === null ? '—' : IDMT.fmt.usd(p._rent)) },
  ];

  function columns() {
    const cols = [...CORE];
    const visible = IDMT.filterEngine.visibleTypes();
    if (visible.length === 1) {
      const defs = (IDMT.config.schema.byType || {})[visible[0]] || [];
      for (const d of defs.slice(0, 8)) {
        cols.push({ key: d.col, label: d.col, raw: true });
      }
    }
    return cols;
  }

  function cellValue(p, col) {
    if (col.fmt) return col.fmt(p);
    const v = col.raw ? p[col.key] : p[col.key];
    if (v === null || v === undefined || String(v) === '') return '—';
    // comma-format big numbers, but not year-like values (1980 should not read 1,980)
    const n = typeof v === 'number' ? v : null;
    return esc(n !== null && Math.abs(n) >= 10000 ? n.toLocaleString('en-US') : v);
  }

  function sortValue(p, key) {
    const v = p[key];
    if (v === null || v === undefined || v === '') return null;
    const n = IDMT.num(v);
    return n !== null ? n : String(v);
  }

  function filtered() {
    return IDMT.filteredProperties().sort((a, b) => {
      const av = sortValue(a, sortKey), bv = sortValue(b, sortKey);
      if (av === null) return 1;
      if (bv === null) return -1;
      return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))) * sortDir;
    });
  }

  function render() {
    const rows = filtered();
    const cols = columns();
    document.getElementById('props-count').textContent =
      `${rows.length} of ${IDMT.properties.length} properties — every row from your workbook. Click a column to sort.`;

    const table = document.getElementById('properties-table');
    table.innerHTML = `
      <thead><tr><th class="cmp-col" title="Add to comp set">✓</th>${cols.map((c) => `<th data-key="${esc(c.key)}">${esc(c.label)}${sortKey === c.key ? `<span class="sort-arrow">${sortDir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((p) => `
        <tr data-id="${esc(p._id)}">
          <td class="cmp-col"><input type="checkbox" class="cmp-check" data-id="${esc(p._id)}" ${IDMT.compSet.has(p._id) ? 'checked' : ''} /></td>
          <td><span style="color:${IDMT.typeColors[p._type] || '#898781'}">●</span> ${esc(p._name)}<span class="fresh-dot ${IDMT.freshness(p).tier}" title="${esc(IDMT.freshness(p).label)}"></span></td>
          <td>${esc([p._address, p._city].filter(Boolean).join(', '))}</td>
          ${cols.slice(2).map((c) => `<td>${cellValue(p, c)}</td>`).join('')}
        </tr>`).join('')}</tbody>`;

    table.querySelectorAll('th').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.key;
        if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = 1; }
        render();
      });
    });
    table.querySelectorAll('.cmp-check').forEach((cb) => {
      cb.addEventListener('click', (e) => { e.stopPropagation(); IDMT.compSet.toggle(cb.dataset.id); });
    });
    table.querySelectorAll('tbody tr').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('.cmp-col')) return;
        IDMT.app.switchView('properties');
        IDMT.map.focusProperty(tr.dataset.id);
      });
    });
  }

  function attach() {
    document.getElementById('props-filter').addEventListener('input', (e) => {
      IDMT.filters.text = e.target.value;
      IDMT.emit('filters');
    });
    const sel = document.getElementById('props-type-select');
    sel.addEventListener('change', () => {
      IDMT.filterEngine.soloType(sel.value || null);
    });
  }

  function refreshTypeOptions() {
    const sel = document.getElementById('props-type-select');
    const visible = IDMT.filterEngine.visibleTypes();
    const solo = visible.length === 1 ? visible[0] : '';
    sel.innerHTML = '<option value="">All types</option>' +
      Object.keys(IDMT.typeColors).map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    sel.value = solo;
  }

  return { render, attach, refreshTypeOptions };
})();
