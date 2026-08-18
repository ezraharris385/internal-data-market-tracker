/* database.js — analytics renderers shared by the function views.
   Leasing / Investment Activity / Development are top-level views built from the
   config-driven modules; Data → Market Data renders the tracked-inventory overview.
   Reporting rules (Market_Analytics_Schema): every stat carries its n; thin summary
   stats (n < 3) are suppressed with honest copy; tracked-set language throughout. */

IDMT.database = (function () {
  let charts = {};
  const INK = { primary: '#ffffff', secondary: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', surface: '#1a1a19' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function chartDefaults() {
    Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
    Chart.defaults.font.size = 11;
    Chart.defaults.color = INK.muted;
    Chart.defaults.borderColor = INK.grid;
  }

  function destroyAll() {
    Object.values(charts).forEach((c) => c.destroy());
    charts = {};
  }

  function barChart(id, labels, values, color, fmt) {
    const el = document.getElementById(id);
    if (!el) return;
    charts[id] = new Chart(el, {
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
    const el = document.getElementById(id);
    if (!el) return;
    charts[id] = new Chart(el, {
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

  function shortMoney(v) {
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
    return '$' + Math.round(v);
  }

  function shortNum(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return Math.round(v / 1e3) + 'K';
    return String(Math.round(v));
  }

  /* ---------- shared pieces ---------- */

  /* Asset-class chips, rendered into any container (soloType drives global filters). */
  function renderTypeChips(el) {
    if (!el) return;
    const types = Object.keys(IDMT.typeColors);
    const visible = IDMT.filterEngine.visibleTypes();
    const allOn = visible.length === types.length;
    const solo = visible.length === 1 ? visible[0] : null;
    el.innerHTML = `<button class="chip ${allOn ? 'active' : ''}" data-type="">All types</button>` +
      types.map((t) => `<button class="chip ${solo === t ? 'active' : ''}" data-type="${esc(t)}">
        <span class="swatch" style="background:${IDMT.typeColors[t]}"></span>${esc(t)}</button>`).join('');
    el.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        IDMT.filterEngine.soloType(chip.dataset.type || null);
      });
    });
  }

  function metricCard(m) {
    if (m.suppressed) {
      return `<div class="card"><div class="k">${esc(m.label)}</div>
        <div class="v suppressed">Not enough data for a summary (n = ${m.n})</div></div>`;
    }
    return `<div class="card"><div class="k">${esc(m.label)}</div>
      <div class="v">${m.display}<span class="n">n=${m.n}</span></div></div>`;
  }

  /* ---------- tracked-inventory overview (Data → Market Data) ---------- */

  function renderOverview(body) {
    if (!body) return;
    const { rows, totals, typeMix } = IDMT.aggregate();
    const nf = IDMT.filterEngine.activeCount();
    body.innerHTML = `
      <div class="cards">
        <div class="card"><div class="k">Tracked properties</div><div class="v">${IDMT.fmt.int(totals.count)}</div><div class="s">${nf ? nf + ' filter' + (nf === 1 ? '' : 's') + ' applied' : 'the denominator for every stat below'}</div></div>
        <div class="card"><div class="k">Tracked building SF</div><div class="v">${IDMT.fmt.int(totals.sf)}</div><div class="s">square feet in the tracked set</div></div>
        <div class="card"><div class="k">Avg occupancy — tracked</div><div class="v">${IDMT.fmt.pct(totals.avgOcc)}</div><div class="s">across tracked properties</div></div>
        <div class="card"><div class="k">Avg asking rent — tracked</div><div class="v">${totals.avgRent === null ? '—' : IDMT.fmt.usd(totals.avgRent)}</div><div class="s">per SF, tracked set</div></div>
        <div class="card"><div class="k">Submarkets</div><div class="v">${IDMT.fmt.int(totals.submarkets)}</div><div class="s">with tracked properties</div></div>
      </div>
      <div class="charts-grid">
        <div class="chart-card"><h3>Tracked SF by submarket</h3><div class="chart-wrap"><canvas id="chart-sf"></canvas></div></div>
        <div class="chart-card"><h3>Property type mix — tracked</h3><div class="chart-wrap"><canvas id="chart-mix"></canvas></div></div>
        <div class="chart-card"><h3>Avg asking rent by submarket ($/SF)</h3><div class="chart-wrap"><canvas id="chart-rent"></canvas></div></div>
        <div class="chart-card"><h3>Avg occupancy by submarket (%)</h3><div class="chart-wrap"><canvas id="chart-occ"></canvas></div></div>
      </div>
      <div class="table-card">
        <h3>Submarket summary — tracked inventory</h3>
        <div class="table-scroll"><table id="submarket-table"></table></div>
      </div>`;

    const named = rows.filter((r) => r.name !== 'Unassigned');
    barChart('chart-sf', named.map((r) => r.name), named.map((r) => r.sf), '#3987e5', shortNum);
    barChart('chart-rent', named.map((r) => r.name), named.map((r) => r.avgRent ?? 0), '#199e70', (v) => '$' + Number(v).toFixed(2));
    barChart('chart-occ', named.map((r) => r.name), named.map((r) => r.avgOcc ?? 0), '#d95926', (v) => Math.round(v) + '%');
    const mixTypes = Object.keys(typeMix);
    doughnut('chart-mix', mixTypes, mixTypes.map((t) => typeMix[t]), mixTypes.map((t) => IDMT.typeColors[t] || '#898781'));

    const table = document.getElementById('submarket-table');
    table.innerHTML = `
      <thead><tr><th>Submarket</th><th>Properties (n)</th><th>Building SF</th><th>Avg year built</th><th>Avg occupancy</th><th>Avg rent ($/SF)</th></tr></thead>
      <tbody>${rows.map((r) => `
        <tr data-sub="${esc(r.name)}">
          <td>${esc(r.name)}</td>
          <td>${IDMT.fmt.int(r.count)}</td>
          <td>${IDMT.fmt.int(r.sf)}</td>
          <td>${r.avgYear ?? '—'}</td>
          <td>${r.count < 3 ? '<span title="n < 3 — not enough data">·</span>' : IDMT.fmt.pct(r.avgOcc)}</td>
          <td>${r.count < 3 ? '<span title="n < 3 — not enough data">·</span>' : (r.avgRent === null ? '—' : IDMT.fmt.usd(r.avgRent))}</td>
        </tr>`).join('')}</tbody>`;
    table.querySelectorAll('tbody tr').forEach((tr) => {
      tr.addEventListener('click', () => {
        IDMT.app.switchView('markets');
        IDMT.map.focusSubmarket(tr.dataset.sub);
      });
    });
  }

  /* ---------- generic module page (Leasing, Sales, Financing, Development…) ---------- */

  function cellDisplay(p, col) {
    const v = p[col];
    if (v === null || v === undefined || String(v) === '') return '—';
    const n = typeof v === 'number' ? v : null;
    if (n !== null && /\$|Price|Amount|Budget|Spent/.test(col)) return shortMoney(n);
    if (n !== null && Math.abs(n) >= 10000) return n.toLocaleString('en-US');
    return esc(v);
  }

  function renderModule(body, name) {
    const mod = (IDMT.config.modules || {})[name];
    if (!mod || !body) return;
    const { metrics, chart, rows, cols } = IDMT.moduleAggregate(mod);

    body.innerHTML = `
      <div class="cards">${metrics.map(metricCard).join('')}</div>
      ${chart ? `<div class="charts-grid"><div class="chart-card wide"><h3>${esc(chart.label)} — tracked set</h3><div class="chart-wrap"><canvas id="chart-module"></canvas></div></div></div>` : ''}
      <div class="table-card">
        <h3>${esc(name)} — property records (n = ${rows.length})</h3>
        <div class="table-scroll"><table id="module-table"></table></div>
      </div>`;

    if (chart && chart.labels.length) {
      const money = /\$|Price|Amount|Budget/.test(mod.chart.col);
      barChart('chart-module', chart.labels, chart.values, '#3987e5', money ? shortMoney : shortNum);
    }

    const table = document.getElementById('module-table');
    table.innerHTML = `
      <thead><tr><th>Property</th><th>Submarket</th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((p) => `
        <tr data-id="${esc(p._id)}">
          <td><span style="color:${IDMT.typeColors[p._type] || '#898781'}">●</span> ${esc(p._name)}</td>
          <td>${esc(p._submarket || '—')}</td>
          ${cols.map((c) => `<td>${cellDisplay(p, c)}</td>`).join('')}
        </tr>`).join('')}</tbody>`;
    table.querySelectorAll('tbody tr').forEach((tr) => {
      tr.addEventListener('click', () => {
        IDMT.app.switchView('properties');
        IDMT.map.focusProperty(tr.dataset.id);
      });
    });
  }

  function prep() {
    if (!IDMT.properties.length) return false;
    chartDefaults();
    destroyAll();
    return true;
  }

  return { renderTypeChips, renderOverview, renderModule, prep };
})();
