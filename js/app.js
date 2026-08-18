/* app.js — boot sequence, function-view navigation, dock wiring, drag-and-drop preview.
   Views: Properties + Markets share the map (Markets shows boundary visuals);
   Leasing / Investment Activity / Development are module dashboards;
   Data holds the Properties grid + Market Data sub-tabs. */

IDMT.app = (function () {
  let activeView = 'properties';
  let dataSubtab = 'Properties';
  let investmentModule = 'Sales';
  const MAP_VIEWS = ['properties', 'markets'];

  function status(msg, isError) {
    const el = document.getElementById('data-status');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }

  /* ---------- view switching ---------- */

  function switchView(name) {
    activeView = name;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
    const isMap = MAP_VIEWS.includes(name);
    document.querySelectorAll('.view').forEach((v) => {
      v.classList.toggle('active', isMap ? v.id === 'view-map' : v.id === 'view-' + name);
    });
    if (isMap) {
      document.body.classList.toggle('mode-markets', name === 'markets');
      document.body.classList.toggle('mode-properties', name === 'properties');
      IDMT.map.setMode(name);
      IDMT.map.resize();
    }
    renderActive();
  }

  /* re-render whatever the user is looking at */
  function renderActive() {
    if (MAP_VIEWS.includes(activeView)) return; // map renders reactively on its own
    if (!IDMT.database.prep()) return;
    if (activeView === 'leasing') {
      IDMT.database.renderTypeChips(document.getElementById('leasing-chips'));
      IDMT.database.renderModule(document.getElementById('leasing-body'), 'Leasing');
    } else if (activeView === 'development') {
      IDMT.database.renderTypeChips(document.getElementById('development-chips'));
      IDMT.database.renderModule(document.getElementById('development-body'), 'Development');
    } else if (activeView === 'investment') {
      IDMT.database.renderTypeChips(document.getElementById('investment-chips'));
      renderInvestmentChips();
      IDMT.database.renderModule(document.getElementById('investment-body'), investmentModule);
    } else if (activeView === 'data') {
      IDMT.database.renderTypeChips(document.getElementById('db-type-filter'));
      renderDataSubtabs();
      const props = dataSubtab === 'Properties';
      document.getElementById('data-properties').style.display = props ? '' : 'none';
      document.getElementById('data-market').style.display = props ? 'none' : '';
      if (props) IDMT.propertiesView.render();
      else IDMT.database.renderOverview(document.getElementById('db-module-body'));
    }
  }

  function chipRow(el, names, active, onPick) {
    el.innerHTML = names.map((n) => `<button class="chip module ${active === n ? 'active' : ''}" data-m="${n}">${n}</button>`).join('');
    el.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => onPick(c.dataset.m)));
  }

  function renderDataSubtabs() {
    chipRow(document.getElementById('data-subtabs'), ['Properties', 'Market Data'], dataSubtab, (m) => { dataSubtab = m; renderActive(); });
  }

  function renderInvestmentChips() {
    chipRow(document.getElementById('investment-modchips'), ['Sales', 'Financing', 'Capital Investment'], investmentModule, (m) => { investmentModule = m; renderActive(); });
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
    ['leasing-filters-btn', 'leasing-filters-panel', 'Advanced filters'],
    ['investment-filters-btn', 'investment-filters-panel', 'Advanced filters'],
    ['development-filters-btn', 'development-filters-panel', 'Advanced filters'],
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
    status(`${shown} of ${IDMT.properties.length} properties shown · ${IDMT.filterEngine.activeCount()} filters`);
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
    ['btn-add-property', 'btn-add-property-2'].forEach((id) => {
      const b = document.getElementById(id);
      if (b) b.addEventListener('click', () => {
        if (!MAP_VIEWS.includes(activeView)) switchView('properties');
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
  return { switchView, renderActive };
})();
