/* app.js — boot sequence, navigation, dock wiring, drag-and-drop preview.
   Views: Properties + Markets share the map (Markets adds boundary visuals and the
   cumulative submarket roll-up panel); activity categories (Leasing / Investment
   Activity / Development) are FILTERS on the map; the datasets live under Data. */

IDMT.app = (function () {
  let activeView = 'properties';
  let dataSubtab = 'Properties';
  let investmentModule = 'Sales';
  let marketsPresentation = 'Dataset'; // Markets leads with data; 'Map view' is the option
  const DATA_SUBTABS = ['Properties', 'Market Data', 'Leasing', 'Investment Activity', 'Development'];

  function isMapView(name) {
    return name === 'properties' || name === 'parcels' || (name === 'markets' && marketsPresentation === 'Map view');
  }

  function status(msg, isError) {
    const el = document.getElementById('data-status');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }

  /* ---------- view switching ---------- */

  function switchView(name) {
    activeView = name;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
    const isMap = isMapView(name);
    document.querySelectorAll('.view').forEach((v) => {
      v.classList.toggle('active', isMap ? v.id === 'view-map' : v.id === 'view-' + name);
    });
    if (isMap) {
      ['properties', 'parcels', 'markets'].forEach((m) =>
        document.body.classList.toggle('mode-' + m, name === m));
      IDMT.map.setMode(name);
      IDMT.map.resize();
    }
    renderActive();
  }

  /* from the Markets dataset: jump to the map presentation zoomed on a submarket */
  function showSubmarketOnMap(name) {
    marketsPresentation = 'Map view';
    switchView('markets');
    IDMT.map.focusSubmarket(name);
  }

  /* re-render whatever the user is looking at */
  function renderActive() {
    renderCategoryChips();
    if (activeView === 'markets') {
      renderMarketsPresentation();
      if (marketsPresentation === 'Map view') {
        renderMarketsPanel();
      } else if (IDMT.database.prep()) {
        IDMT.database.renderTypeChips(document.getElementById('markets-type-chips'));
        IDMT.database.renderMarketsDataset(document.getElementById('markets-body'));
      }
      return;
    }
    if (isMapView(activeView)) return;
    if (activeView !== 'data' || !IDMT.database.prep()) return;
    IDMT.database.renderTypeChips(document.getElementById('db-type-filter'));
    renderDataSubtabs();
    const staleBar = document.getElementById('invest-modchips');
    if (staleBar) staleBar.style.display = dataSubtab === 'Investment Activity' ? '' : 'none';
    const props = dataSubtab === 'Properties';
    document.getElementById('data-properties').style.display = props ? '' : 'none';
    document.getElementById('data-market').style.display = props ? 'none' : '';
    if (props) {
      IDMT.propertiesView.render();
    } else if (dataSubtab === 'Market Data') {
      IDMT.database.renderOverview(document.getElementById('db-module-body'));
    } else if (dataSubtab === 'Leasing') {
      IDMT.database.renderModule(document.getElementById('db-module-body'), 'Leasing');
    } else if (dataSubtab === 'Development') {
      IDMT.database.renderModule(document.getElementById('db-module-body'), 'Development');
    } else if (dataSubtab === 'Investment Activity') {
      renderInvestmentChips();
      IDMT.database.renderModule(document.getElementById('db-module-body'), investmentModule, { keepChips: true });
    }
  }

  function chipRow(el, names, active, onPick) {
    el.innerHTML = names.map((n) => `<button class="chip module ${active === n ? 'active' : ''}" data-m="${n}">${n}</button>`).join('');
    el.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => onPick(c.dataset.m)));
  }

  function renderDataSubtabs() {
    chipRow(document.getElementById('data-subtabs'), DATA_SUBTABS, dataSubtab, (m) => { dataSubtab = m; renderActive(); });
  }

  function renderMarketsPresentation() {
    const el = document.getElementById('markets-presentation');
    if (el) chipRow(el, ['Dataset', 'Map view'], marketsPresentation, (m) => { marketsPresentation = m; switchView('markets'); });
  }

  function renderInvestmentChips() {
    const body = document.getElementById('db-module-body');
    let bar = document.getElementById('invest-modchips');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'invest-modchips';
      bar.className = 'filter-row module-tabs';
      body.parentNode.insertBefore(bar, body);
    }
    bar.style.display = dataSubtab === 'Investment Activity' ? '' : 'none';
    chipRow(bar, ['Sales', 'Financing', 'Capital Investment'], investmentModule, (m) => { investmentModule = m; renderActive(); });
  }

  /* activity-category lens on the map: see only what shows up for that category */
  function renderCategoryChips() {
    const el = document.getElementById('category-chips');
    if (!el) return;
    const cats = IDMT.filterEngine.categoryNames();
    const active = IDMT.filters.category;
    el.innerHTML = `<button class="chip cat ${!active ? 'active' : ''}" data-c="">All activity</button>` +
      cats.map((c) => `<button class="chip cat ${active === c ? 'active' : ''}" data-c="${c}">${c}</button>`).join('');
    el.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => IDMT.filterEngine.setCategory(chip.dataset.c));
    });
  }

  /* Markets: cumulative data for every submarket (tracked inventory roll-up) */
  function renderMarketsPanel() {
    const el = document.getElementById('markets-panel');
    if (!el) return;
    const { rows, totals } = IDMT.aggregate();
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    el.innerHTML = `
      <div class="mp-head">
        <div class="mp-title">Submarkets — tracked inventory</div>
        <div class="mp-totals">${IDMT.fmt.int(totals.count)} properties · ${IDMT.fmt.int(totals.sf)} SF</div>
        <button class="btn-ghost sm" id="mp-back" style="margin-top:7px;width:auto">◀ Back to dataset</button>
      </div>
      ${rows.map((r) => `
        <div class="mp-row" data-sub="${esc(r.name)}">
          <div class="mp-name">${esc(r.name)}</div>
          <div class="mp-stats">
            <span>${r.count} prop${r.count === 1 ? '' : 's'}</span>
            <span>${IDMT.fmt.int(r.sf)} SF</span>
            <span>${r.count < 3 ? '·' : IDMT.fmt.pct(r.avgOcc) + ' occ'}</span>
            <span>${r.count < 3 ? '·' : (r.avgRent === null ? '—' : IDMT.fmt.usd(r.avgRent))}</span>
          </div>
        </div>`).join('')}
      <div class="mp-foot">Averages need n ≥ 3 · click a submarket to zoom</div>`;
    el.querySelectorAll('.mp-row').forEach((row) => {
      row.addEventListener('click', () => IDMT.map.focusSubmarket(row.dataset.sub));
    });
    const back = document.getElementById('mp-back');
    if (back) back.addEventListener('click', () => { marketsPresentation = 'Dataset'; switchView('markets'); });
  }

  /* ---------- shared refresh ---------- */

  function refreshAll() {
    IDMT.map.refreshData();
    IDMT.search.build();
    IDMT.propertiesView.refreshTypeOptions();
    renderFilterPanels();
    renderActive();
    status(`${IDMT.properties.length} properties · ${IDMT.submarkets ? new Set(IDMT.submarkets.features.map(IDMT.featureName)).size : 0} submarkets`);
  }

  const PANELS = [
    ['map-filters-btn', 'map-filters-panel', 'Filters'],
    ['db-filters-btn', 'db-filters-panel', 'Advanced filters'],
    ['markets-filters-btn', 'markets-filters-panel', 'Advanced filters'],
  ];

  function renderFilterPanels() {
    const n = IDMT.filterEngine.activeCount();
    for (const [btnId, panelId, label] of PANELS) {
      const btn = document.getElementById(btnId), panel = document.getElementById(panelId);
      if (!btn || !panel) continue;
      IDMT.filterEngine.renderPanel(panel);
      btn.innerHTML = label + (n ? ` <span class="count">${n}</span>` : '');
      btn.classList.toggle('active', n > 0);
    }
  }

  function onFiltersChanged() {
    IDMT.refreshActiveSubmarkets();   // per-asset-type submarket sets follow the type toggles
    IDMT.map.refreshFiltered();
    IDMT.propertiesView.refreshTypeOptions();
    renderFilterPanels();
    renderActive();
    const shown = IDMT.filteredProperties().length;
    const cat = IDMT.filters.category ? ` · ${IDMT.filters.category} lens` : '';
    status(`${shown} of ${IDMT.properties.length} properties shown${cat} · ${IDMT.filterEngine.activeCount()} filters`);
  }

  /* fired after local edits / adds rebuild the dataset */
  function onDataChanged() {
    IDMT.search.build();
    onFiltersChanged();
    const n = IDMT.edits.count(), a = IDMT.addedRows.count();
    const bits = [];
    if (a) bits.push(`${a} added propert${a === 1 ? 'y' : 'ies'}`);
    if (n) bits.push(`${n} with local edits`);
    if (bits.length) status(`${IDMT.filteredProperties().length} of ${IDMT.properties.length} shown · ${bits.join(' · ')} — export the workbook to keep them`);
  }

  /* ---------- wiring ---------- */

  function wirePanels() {
    IDMT.on('filters', onFiltersChanged);
    IDMT.on('data', onDataChanged);
    for (const [btnId, panelId] of PANELS) {
      const btn = document.getElementById(btnId);
      if (btn) btn.addEventListener('click', () => document.getElementById(panelId).classList.toggle('open'));
    }
    const exportBtn = document.getElementById('props-export');
    if (exportBtn) exportBtn.addEventListener('click', () => IDMT.exportWorkbook());
    // explicit workbook upload (same preview-locally contract as drag-drop)
    const upBtn = document.getElementById('btn-upload-workbook');
    const upFile = document.getElementById('workbook-file');
    if (upBtn && upFile) {
      upBtn.addEventListener('click', () => upFile.click());
      upFile.addEventListener('change', async () => {
        const file = upFile.files && upFile.files[0];
        if (!file) return;
        try {
          IDMT.ingestWorkbook(await file.arrayBuffer());
          refreshAll();
          status(`previewing ${file.name} (local only — commit it as data/properties.xlsx to publish)`);
        } catch (err) {
          status('Could not read ' + file.name + ': ' + err.message, true);
        }
        upFile.value = '';
      });
    }
    ['btn-add-property', 'btn-add-property-2'].forEach((id) => {
      const b = document.getElementById(id);
      if (b) b.addEventListener('click', () => {
        if (!isMapView(activeView)) switchView('properties');
        IDMT.detail.openNew();
      });
    });
  }

  function wireDock() {
    const pops = { 'dock-layers-btn': 'dock-layers-pop', 'dock-types-btn': 'dock-types-pop' };
    for (const [btnId, popId] of Object.entries(pops)) {
      document.getElementById(btnId).addEventListener('click', () => {
        const pop = document.getElementById(popId);
        const wasOpen = pop.classList.contains('open');
        document.querySelectorAll('.dock-pop').forEach((p) => p.classList.remove('open'));
        document.querySelectorAll('.dock-btn').forEach((b) => pops[b.id] && b.classList.remove('active'));
        if (!wasOpen) {
          pop.classList.add('open');
          document.getElementById(btnId).classList.add('active');
        }
      });
    }
  }

  /* Drag-and-drop: preview a new workbook or boundary file locally without committing it. */
  function wireDragDrop() {
    const overlay = document.getElementById('drop-overlay');
    let depth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; overlay.classList.add('visible'); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--depth <= 0) { depth = 0; overlay.classList.remove('visible'); } });
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      overlay.classList.remove('visible');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      const buf = await file.arrayBuffer();
      const name = file.name.toLowerCase();
      try {
        if (name.endsWith('.xlsx') || name.endsWith('.xlsm') || name.endsWith('.xls')) {
          IDMT.ingestWorkbook(buf);
          status(`previewing ${file.name} (local only — commit it to data/ to publish)`);
        } else if (name.endsWith('.kmz') || name.endsWith('.kml') || name.endsWith('.geojson') || name.endsWith('.json') || name.endsWith('.zip')) {
          const gj = await IDMT.parseBoundaryBuffer(buf, file.name);
          const def = IDMT.submarketSets.default || { type: 'FeatureCollection', features: [] };
          IDMT.submarketSets.default = { type: 'FeatureCollection', features: [...def.features, ...gj.features] };
          IDMT.refreshActiveSubmarkets();
          IDMT.properties.forEach((p) => { if (p._submarket === 'Unassigned') p._submarket = ''; });
          IDMT.assignSubmarkets();
          status(`previewing boundaries from ${file.name} (local only)`);
        } else {
          status('Unsupported file: ' + file.name, true);
          return;
        }
        refreshAll();
      } catch (err) {
        console.error(err);
        status('Could not read ' + file.name + ': ' + err.message, true);
      }
    });
  }

  async function boot() {
    try {
      await IDMT.loadConfig();
      document.getElementById('brand-name').textContent = IDMT.config.branding.appName;
      document.getElementById('brand-market').textContent = IDMT.config.market.name;
      document.title = IDMT.config.branding.appName + ' — ' + IDMT.config.market.name;

      IDMT.map.init();
      IDMT.search.attach();
      IDMT.propertiesView.attach();
      wirePanels();
      wireDock();
      wireDragDrop();

      document.querySelectorAll('.tab').forEach((t) =>
        t.addEventListener('click', () => switchView(t.dataset.view)));

      status('loading workbook…');
      await IDMT.loadWorkbook();
      await IDMT.loadBoundaries();
      refreshAll();
    } catch (err) {
      console.error(err);
      status(err.message, true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
  return { switchView, renderActive, showSubmarketOnMap };
})();
