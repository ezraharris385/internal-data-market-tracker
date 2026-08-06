/* properties.js — full sortable/filterable table of every row in the workbook. */

IDMT.propertiesView = (function () {
  let sortKey = '_name';
  let sortDir = 1;
  let textFilter = '';
  let typeSel = '';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const COLS = [
    { key: '_name', label: 'Property' },
    { key: '_address', label: 'Address' },
    { key: '_type', label: 'Type' },
    { key: '_submarket', label: 'Submarket' },
    { key: '_size', label: 'Building SF', num: true },
    { key: '_occ', label: 'Occupancy', num: true },
    { key: '_rent', label: 'Rent ($/SF)', num: true },
  ];

  function filtered() {
    const q = textFilter.toLowerCase();
    return IDMT.properties
      .filter((p) => (!typeSel || p._type === typeSel))
      .filter((p) => !q || (p._name + ' ' + p._address + ' ' + p._city + ' ' + p._submarket + ' ' + p._type).toLowerCase().includes(q))
      .sort((a, b) => {
        const av = a[sortKey], bv = b[sortKey];
        if (av === null || av === undefined || av === '') return 1;
        if (bv === null || bv === undefined || bv === '') return -1;
        return (typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))) * sortDir;
      });
  }

  function render() {
    const rows = filtered();
    document.getElementById('props-count').textContent =
      `${rows.length} of ${IDMT.properties.length} properties — every row from your workbook.`;

    const table = document.getElementById('properties-table');
    table.innerHTML = `
      <thead><tr>${COLS.map((c) => `<th data-key="${c.key}">${c.label}${sortKey === c.key ? `<span class="sort-arrow">${sortDir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((p) => `
        <tr data-id="${esc(p._id)}">
          <td><span style="color:${IDMT.typeColors[p._type] || '#898781'}">●</span> ${esc(p._name)}</td>
          <td>${esc([p._address, p._city].filter(Boolean).join(', '))}</td>
          <td>${esc(p._type)}</td>
          <td>${esc(p._submarket || '—')}</td>
          <td>${IDMT.fmt.int(p._size)}</td>
          <td>${IDMT.fmt.pct(p._occ)}</td>
          <td>${p._rent === null ? '—' : IDMT.fmt.usd(p._rent)}</td>
        </tr>`).join('')}</tbody>`;

    table.querySelectorAll('th').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.key;
        if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = 1; }
        render();
      });
    });
    table.querySelectorAll('tbody tr').forEach((tr) => {
      tr.addEventListener('click', () => {
        IDMT.app.switchView('map');
        IDMT.map.focusProperty(tr.dataset.id);
      });
    });
  }

  function attach() {
    document.getElementById('props-filter').addEventListener('input', (e) => { textFilter = e.target.value; render(); });
    const sel = document.getElementById('props-type-select');
    sel.addEventListener('change', () => { typeSel = sel.value; render(); });
  }

  function refreshTypeOptions() {
    const sel = document.getElementById('props-type-select');
    const current = sel.value;
    sel.innerHTML = '<option value="">All types</option>' +
      Object.keys(IDMT.typeColors).map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    sel.value = current;
  }

  return { render, attach, refreshTypeOptions };
})();
