/* comps.js — comp set UI: the tray, the side-by-side comparison sheet, and CSV export.
   This is the workflow an analyst actually lives in: assemble comparables, compare
   them, hand the set to a memo or tour book. */

IDMT.comps = (function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* rows shown in the comparison sheet — the fields a comp discussion turns on */
  const ROWS = [
    ['Submarket', (p) => p._submarket || '—'],
    ['Type / Class', (p) => [p._type, p._class].filter(Boolean).join(' · ') || '—'],
    ['Building SF', (p) => IDMT.fmt.int(p._size)],
    ['Year built', (p) => p['Year Built'] || '—'],
    ['Occupancy', (p) => IDMT.fmt.pct(p._occ)],
    ['Asking rent ($/SF)', (p) => (p._rent === null ? '—' : IDMT.fmt.usd(p._rent))],
    ['In-place rent ($/SF)', (p) => money(p['In-Place Rent ($/SF)'], true)],
    ['Available SF', (p) => IDMT.fmt.int(IDMT.num(p['Available SF']))],
    ['WALT (yrs)', (p) => p['WALT (yrs)'] || '—'],
    ['NOI', (p) => money(p['NOI ($)'])],
    ['Last sale', (p) => (p['Last Sale Price'] ? money(p['Last Sale Price']) + (p['Last Sale Date'] ? ' · ' + String(p['Last Sale Date']).slice(0, 10) : '') : '—')],
    ['Price / SF', (p) => money(p['Price/SF'], true)],
    ['Cap rate', (p) => (p['Cap Rate (%)'] ? p['Cap Rate (%)'] + '%' : '—')],
    ['Lender / debt', (p) => (p['Lender'] ? esc(p['Lender']) + ' · ' + money(p['Loan Amount ($)']) : '—')],
    ['Owner', (p) => p['Owner'] || '—'],
  ];

  function money(v, decimals) {
    const n = IDMT.num(v);
    if (n === null) return '—';
    return decimals ? IDMT.fmt.usd(n) : '$' + Math.round(n).toLocaleString('en-US');
  }

  function renderTray() {
    const tray = document.getElementById('comp-tray');
    if (!tray) return;
    const n = IDMT.compSet.count();
    tray.classList.toggle('show', n > 0);
    const label = document.getElementById('ct-label');
    if (label) label.textContent = `Comp set · ${n} propert${n === 1 ? 'y' : 'ies'}`;
  }

  function openCompare() {
    const props = IDMT.compSet.properties();
    if (!props.length) return;
    const body = document.getElementById('compare-body');
    body.innerHTML = `
      <table class="compare-table">
        <thead><tr><th class="cmp-field"></th>${props.map((p) => `
          <th><div class="cmp-name">${esc(p._name)}</div>
              <div class="cmp-sub">${esc([p._address, p._city].filter(Boolean).join(', ')) || '—'}</div></th>`).join('')}</tr></thead>
        <tbody>${ROWS.map(([label, get]) => `
          <tr><td class="cmp-field">${esc(label)}</td>${props.map((p) => `<td>${get(p)}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>`;
    document.getElementById('compare-overlay').classList.add('show');
  }

  function exportCSV() {
    const props = IDMT.compSet.properties();
    if (!props.length) return;
    const head = ['Field', ...props.map((p) => p._name)];
    const lines = [head, ...ROWS.map(([label, get]) => [label, ...props.map((p) => String(get(p)).replace(/<[^>]*>/g, ''))])];
    const csv = lines.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'comp-set.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  function attach() {
    document.getElementById('ct-compare').addEventListener('click', openCompare);
    document.getElementById('ct-export').addEventListener('click', exportCSV);
    document.getElementById('ct-clear').addEventListener('click', () => IDMT.compSet.clear());
    document.getElementById('compare-close').addEventListener('click', () =>
      document.getElementById('compare-overlay').classList.remove('show'));
    document.getElementById('compare-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'compare-overlay') e.currentTarget.classList.remove('show');
    });
    IDMT.on('compset', () => {
      renderTray();
      if (document.getElementById('compare-overlay').classList.contains('show')) openCompare();
      IDMT.map.refreshFiltered();
    });
    renderTray();
  }

  return { attach, renderTray, openCompare };
})();
