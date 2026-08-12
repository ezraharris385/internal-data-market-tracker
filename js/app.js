/* app.js — boot sequence, tab switching, drag-and-drop local preview. */

IDMT.app = (function () {
  function status(msg, isError) {
    const el = document.getElementById('data-status');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }

  function switchView(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    if (name === 'map') IDMT.map.resize();
    if (name === 'database') IDMT.database.render();
    if (name === 'properties') IDMT.propertiesView.render();
  }

  function refreshAll() {
    IDMT.map.refreshData();
    IDMT.search.build();
    IDMT.propertiesView.refreshTypeOptions();
    IDMT.database.render();
    IDMT.propertiesView.render();
    renderFilterPanels();
    status(`${IDMT.properties.length} properties · ${IDMT.submarkets ? new Set(IDMT.submarkets.features.map(IDMT.featureName)).size : 0} submarkets`);
  }

  function renderFilterPanels() {
    IDMT.filterEngine.renderPanel(document.getElementById('map-filters-panel'));
    IDMT.filterEngine.renderPanel(document.getElementById('props-filters-panel'));
    const n = IDMT.filterEngine.activeCount();
    ['map-filters-btn', 'props-filters-btn'].forEach((id, i) => {
      const btn = document.getElementById(id);
      btn.innerHTML = (i === 0 ? 'Filters' : 'Advanced filters') + (n ? ` <span class="count">${n}</span>` : '');
      btn.classList.toggle('active', n > 0);
    });
  }

  /* everything that shows data reacts to a filter change */
  function onFiltersChanged() {
    IDMT.map.refreshPins();
    IDMT.propertiesView.refreshTypeOptions();
    IDMT.propertiesView.render();
    IDMT.database.render();
    renderFilterPanels();
    const shown = IDMT.filteredProperties().length;
    status(`${shown} of ${IDMT.properties.length} properties shown · ${IDMT.filterEngine.activeCount()} filters`);
  }

  function wireFilterPanels() {
    IDMT.on('filters', onFiltersChanged);
    [['map-filters-btn', 'map-filters-panel'], ['props-filters-btn', 'props-filters-panel']].forEach(([btnId, panelId]) => {
      document.getElementById(btnId).addEventListener('click', () => {
        document.getElementById(panelId).classList.toggle('open');
      });
    });
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
          IDMT.submarkets = { type: 'FeatureCollection', features: [...(IDMT.submarkets?.features || []), ...gj.features] };
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
      wireFilterPanels();
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
  return { switchView };
})();
