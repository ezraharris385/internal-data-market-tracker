/* database.js — CoStar-style market & submarket analytics, computed only from the uploaded workbook. */

IDMT.database = (function () {
  let charts = {};
  let typeFilter = '';
  const INK = { primary: '#ffffff', secondary: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', surface: '#1a1a19' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function chartDefaults() {
    Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
    Chart.defaults.font.size = 11;
    Chart.defaults.color = INK.muted;
    Chart.defaults.borderColor = INK.grid;
  }

  function destroy(id) {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  }

  function barChart(id, labels, values, color, fmt) {
    destroy(id);
    charts[id] = new Chart(document.getElementById(id), {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: color,
          borderRadius: { topLeft: 4, topRight: 4 },
          borderSkipped: 'bottom',
          maxBarThickness: 26,
          categoryPercentage: 0.7,
          barPercentage: 0.9,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }, // single series: the card title names it
          tooltip: {
            backgroundColor: '#232322', titleColor: INK.primary, bodyColor: INK.secondary,
            borderColor: 'rgba(255,255,255,0.10)', borderWidth: 1, cornerRadius: 8, padding: 10,
            callbacks: { label: (ctx) => ' ' + fmt(ctx.parsed.y) },
          },
        },
        scales: {
          x: { grid: { display: false }, border: { color: '#383835' }, ticks: { color: INK.muted, maxRotation: 40 } },
          y: { grid: { color: INK.grid }, border: { display: false }, ticks: { color: INK.muted, callback: (v) => fmt(v) } },
        },
      },
    });
  }

  function doughnut(id, labels, values, colors) {
    destroy(id);
    charts[id] = new Chart(document.getElementById(id), {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderColor: INK.surface, // 2px surface gap between segments
          borderWidth: 2,
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { position: 'right', labels: { color: INK.secondary, usePointStyle: true, pointStyle: 'circle', boxWidth: 8, padding: 12 } },
          tooltip: {
            backgroundColor: '#232322', titleColor: INK.primary, bodyColor: INK.secondary,
            borderColor: 'rgba(255,255,255,0.10)', borderWidth: 1, cornerRadius: 8, padding: 10,
            callbacks: { label: (ctx) => ` ${ctx.parsed} properties (${Math.round((ctx.parsed / values.reduce((a, b) => a + b, 0)) * 100)}%)` },
          },
        },
      },
    });
  }

  function renderCards(totals) {
    document.getElementById('db-cards').innerHTML = `
      <div class="card"><div class="k">Properties</div><div class="v">${IDMT.fmt.int(totals.count)}</div><div class="s">${typeFilter || 'all types'}</div></div>
      <div class="card"><div class="k">Total building SF</div><div class="v">${IDMT.fmt.int(totals.sf)}</div><div class="s">square feet tracked</div></div>
      <div class="card"><div class="k">Avg occupancy</div><div class="v">${IDMT.fmt.pct(totals.avgOcc)}</div><div class="s">weighted by property</div></div>
      <div class="card"><div class="k">Avg asking rent</div><div class="v">${totals.avgRent === null ? '—' : IDMT.fmt.usd(totals.avgRent)}</div><div class="s">per SF</div></div>
      <div class="card"><div class="k">Submarkets</div><div class="v">${IDMT.fmt.int(totals.submarkets)}</div><div class="s">with mapped properties</div></div>`;
  }

  function renderTypeFilter() {
    const el = document.getElementById('db-type-filter');
    const types = Object.keys(IDMT.typeColors);
    el.innerHTML = `<button class="chip ${!typeFilter ? 'active' : ''}" data-type="">All types</button>` +
      types.map((t) => `<button class="chip ${typeFilter === t ? 'active' : ''}" data-type="${esc(t)}">
        <span class="swatch" style="background:${IDMT.typeColors[t]}"></span>${esc(t)}</button>`).join('');
    el.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => { typeFilter = chip.dataset.type; render(); });
    });
  }

  function renderTable(rows) {
    const table = document.getElementById('submarket-table');
    table.innerHTML = `
      <thead><tr><th>Submarket</th><th>Properties</th><th>Building SF</th><th>Avg year built</th><th>Avg occupancy</th><th>Avg rent ($/SF)</th></tr></thead>
      <tbody>${rows.map((r) => `
        <tr data-sub="${esc(r.name)}">
          <td>${esc(r.name)}</td>
          <td>${IDMT.fmt.int(r.count)}</td>
          <td>${IDMT.fmt.int(r.sf)}</td>
          <td>${r.avgYear ?? '—'}</td>
          <td>${IDMT.fmt.pct(r.avgOcc)}</td>
          <td>${r.avgRent === null ? '—' : IDMT.fmt.usd(r.avgRent)}</td>
        </tr>`).join('')}</tbody>`;
    table.querySelectorAll('tbody tr').forEach((tr) => {
      tr.addEventListener('click', () => {
        IDMT.app.switchView('map');
        IDMT.map.focusSubmarket(tr.dataset.sub);
      });
    });
  }

  function render() {
    if (!IDMT.properties.length) return;
    chartDefaults();
    const { rows, totals, typeMix } = IDMT.aggregate(typeFilter);
    document.getElementById('db-title').textContent = IDMT.config.market.name + ' — Market Database';
    renderTypeFilter();
    renderCards(totals);
    const named = rows.filter((r) => r.name !== 'Unassigned');
    barChart('chart-sf', named.map((r) => r.name), named.map((r) => r.sf), '#3987e5', (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.round(v / 1000) + 'K'));
    barChart('chart-rent', named.map((r) => r.name), named.map((r) => r.avgRent ?? 0), '#199e70', (v) => '$' + Number(v).toFixed(2));
    barChart('chart-occ', named.map((r) => r.name), named.map((r) => r.avgOcc ?? 0), '#d95926', (v) => Math.round(v) + '%');
    const mixTypes = Object.keys(typeMix);
    doughnut('chart-mix', mixTypes, mixTypes.map((t) => typeMix[t]), mixTypes.map((t) => IDMT.typeColors[t] || '#898781'));
    renderTable(rows);
  }

  return { render };
})();
