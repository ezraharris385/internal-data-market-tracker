/* map.js — 3D MapLibre map: basemap, animated building extrusions, submarket/parcel
   boundaries, property pins, layer toggles, cinematic camera moves, orbit + presentation
   modes. Market-agnostic: everything comes from config.json. */

IDMT.map = (function () {
  let map = null;
  let hoverPopup = null;
  let styleReady = false;
  let is3D = true;
  let orbiting = false;
  let buildingsGrown = false;
  let selectedId = null;
  let pulseRAF = null;

  function firstSymbolLayerId() {
    const layers = map.getStyle().layers || [];
    const sym = layers.find((l) => l.type === 'symbol');
    return sym ? sym.id : undefined;
  }

  function styleFont() {
    const layers = map.getStyle().layers || [];
    for (const l of layers) {
      const f = l.layout && l.layout['text-font'];
      if (f && f.length) return f;
    }
    return ['Noto Sans Regular'];
  }

  function vectorSourceKey() {
    const sources = map.getStyle().sources || {};
    return Object.keys(sources).find((k) => sources[k].type === 'vector');
  }

  function init() {
    const m = IDMT.config.market;
    map = new maplibregl.Map({
      container: 'map',
      style: IDMT.config.basemap.style,
      // cinematic intro: start flat + pulled back, then fly to the configured 3D view
      center: m.center,
      zoom: Math.max(m.zoom - 1.6, 3),
      pitch: 0,
      bearing: 0,
      maxBounds: m.maxBounds || undefined,
      minZoom: m.minZoom || 0,
      antialias: true,
      attributionControl: { compact: true },
    });
    IDMT._map = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
    hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });

    // 'style.load' rather than 'load': custom layers go on as soon as the style is
    // ready, instead of waiting for every basemap tile (which can stall on slow networks).
    map.on('style.load', () => {
      styleReady = true;
      addSatellite();
      addBuildings();
      addParcelTiles();
      addBoundaryLayers();
      addPropertyLayers();
      map.moveLayer('idmt-submarket-labels'); // labels above pins — they must always read
      wireInteractions();
      refreshData();
      flyIntro();
    });
    // buildings "grow out of the ground" the first time the camera gets close
    map.on('zoomend', () => {
      if (!buildingsGrown && map.getZoom() >= 13) growBuildings();
    });
    map.on('mousedown', stopOrbit);
    new ResizeObserver(() => map.resize()).observe(document.getElementById('map'));
    wireControls();
    return map;
  }

  function flyIntro() {
    const m = IDMT.config.market;
    setTimeout(() => {
      map.flyTo({
        center: m.center, zoom: m.zoom, pitch: m.pitch || 50, bearing: m.bearing || 0,
        duration: 4000, essential: true,
      });
    }, 600);
  }

  /* ---------- base layers ---------- */

  function addSatellite() {
    map.addSource('idmt-satellite', {
      type: 'raster',
      tiles: [IDMT.config.basemap.satelliteTiles],
      tileSize: 256,
      attribution: IDMT.config.basemap.satelliteAttribution || '',
    });
    map.addLayer(
      { id: 'idmt-satellite', type: 'raster', source: 'idmt-satellite', layout: { visibility: 'none' } },
      firstSymbolLayerId()
    );
  }

  function buildingHeightExpr(mult) {
    return ['*', mult, ['coalesce', ['get', 'render_height'], ['get', 'height'], 12]];
  }

  function addBuildings() {
    // Derive the building source + source-layer from the basemap's own style so this
    // works across providers (CARTO, OpenFreeMap, MapTiler…) without hardcoding.
    const styleLayers = map.getStyle().layers || [];
    const bLayer = styleLayers.find((l) => l['source-layer'] === 'building')
      || styleLayers.find((l) => /building/i.test(l.id) && l['source-layer']);
    const src = bLayer ? bLayer.source : vectorSourceKey();
    const srcLayer = bLayer ? bLayer['source-layer'] : 'building';
    if (!src) return;
    // If the basemap ships its own extrusion layer, hide it — ours is the one
    // wired to the toggle and the grow animation.
    for (const l of styleLayers) {
      if (l.type === 'fill-extrusion' && !l.id.startsWith('idmt')) {
        map.setLayoutProperty(l.id, 'visibility', 'none');
      }
    }
    map.addLayer(
      {
        id: 'idmt-3d-buildings',
        type: 'fill-extrusion',
        source: src,
        'source-layer': srcLayer,
        minzoom: 12,
        paint: {
          // dark-theme ramp: taller buildings read lighter so the skyline pops
          'fill-extrusion-color': [
            'interpolate', ['linear'], ['coalesce', ['get', 'render_height'], ['get', 'height'], 12],
            0, '#2e3138', 40, '#3d414b', 100, '#4d525e', 200, '#5d6370',
          ],
          'fill-extrusion-height': buildingHeightExpr(1),
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
          'fill-extrusion-opacity': 0.95,
        },
      },
      firstSymbolLayerId()
    );
  }

  /* Animated rebuild: extrusion heights ease from 0 → full over ~2.2s. */
  function growBuildings() {
    if (!styleReady || !map.getLayer('idmt-3d-buildings')) return;
    buildingsGrown = true;
    const start = performance.now(), dur = 2200;
    function frame(now) {
      const t = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
      if (map.getLayer('idmt-3d-buildings')) {
        map.setPaintProperty('idmt-3d-buildings', 'fill-extrusion-height', buildingHeightExpr(Math.max(e, 0.001)));
      }
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /* ---------- metro-wide parcel fabric (PMTiles vector tiles, streamed by viewport) ---------- */

  function addParcelTiles() {
    const cfg = IDMT.config.layers.parcelTiles;
    if (!cfg || typeof pmtiles === 'undefined') return;
    const files = cfg.files || (cfg.url ? [cfg.url] : []);
    if (!files.length) return;
    if (!IDMT._pmtilesProtocol) {
      IDMT._pmtilesProtocol = new pmtiles.Protocol();
      maplibregl.addProtocol('pmtiles', IDMT._pmtilesProtocol.tile);
    }
    const srcLayer = cfg.sourceLayer || 'parcels';
    const minzoom = cfg.minzoom || 13;
    IDMT._parcelTileLayerIds = [];
    files.forEach((url, i) => {
      const abs = url.startsWith('http') ? url : new URL(url, window.location.href).href;
      const srcId = 'idmt-parcel-tiles-' + i;
      map.addSource(srcId, {
        type: 'vector',
        url: 'pmtiles://' + abs,
        attribution: i === 0 ? (cfg.attribution || '') : '',
      });
      map.addLayer({
        id: srcId + '-fill', type: 'fill', source: srcId, 'source-layer': srcLayer,
        minzoom,
        paint: { 'fill-color': '#c98500', 'fill-opacity': 0.04 },
      }, firstSymbolLayerId());
      map.addLayer({
        id: srcId + '-line', type: 'line', source: srcId, 'source-layer': srcLayer,
        minzoom,
        paint: {
          'line-color': '#a08c5a',
          'line-opacity': ['interpolate', ['linear'], ['zoom'], minzoom, 0.35, 16, 0.8],
          'line-width': ['interpolate', ['linear'], ['zoom'], minzoom, 0.4, 17, 1.4],
        },
      }, firstSymbolLayerId());
      IDMT._parcelTileLayerIds.push(srcId + '-fill', srcId + '-line');
      map.on('click', srcId + '-fill', onParcelClick);
      map.on('mouseenter', srcId + '-fill', () => { if (map.getZoom() >= minzoom) map.getCanvas().style.cursor = 'crosshair'; });
      map.on('mouseleave', srcId + '-fill', () => { map.getCanvas().style.cursor = ''; });
    });
    map.on('error', (e) => {
      if (String(e.sourceId || '').startsWith('idmt-parcel-tiles') && !IDMT._parcelTileErrorShown) {
        IDMT._parcelTileErrorShown = true;
        console.warn('Metro parcel tiles unavailable:', e.error && e.error.message);
      }
    });

    function onParcelClick(e) {
      // a click on one of OUR properties wins over the parcel underneath it
      if (map.queryRenderedFeatures(e.point, { layers: ['idmt-properties-pt'] }).length) return;
      const p = e.features[0].properties;
      const money = (v) => (v === undefined || v === null || v === '' || isNaN(+v) ? null : '$' + Math.round(+v).toLocaleString('en-US'));
      const rows = [
        ['Owner', p.OWNER_NAME], ['PIN', p.PIN], ['City', p.CTU_NAME], ['County', p.CO_NAME],
        ['Use', p.USECLASS1], ['EMV', money(p.EMV_TOTAL)], ['Acres', p.ACRES_POLY],
        ['Year built', p.YEAR_BUILT || null],
        ['Last sale', p.SALE_VALUE ? `${money(p.SALE_VALUE)}${p.SALE_YR ? ' (' + p.SALE_YR + ')' : ''}` : null],
      ].filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '');
      hoverPopup.remove();
      new maplibregl.Popup({ offset: 8, maxWidth: '300px' })
        .setLngLat(e.lngLat)
        .setHTML(`<div class="popup-name">Parcel record</div>` +
          rows.map(([k, v]) => `<div class="popup-sub"><b>${k}:</b> ${esc(v)}</div>`).join(''))
        .addTo(map);
    }
  }

  /* ---------- boundaries ---------- */

  function addBoundaryLayers() {
    map.addSource('idmt-submarkets', { type: 'geojson', data: IDMT.submarkets || emptyFC() });
    map.addSource('idmt-parcels', { type: 'geojson', data: IDMT.parcels || emptyFC() });
    map.addSource('idmt-submarket-labels', { type: 'geojson', data: emptyFC() });

    map.addLayer({
      id: 'idmt-submarkets-fill', type: 'fill', source: 'idmt-submarkets',
      paint: { 'fill-color': '#9085e9', 'fill-opacity': 0.06 },
    });
    // soft glow underlay + crisp solid line: boundaries read clearly at every zoom
    map.addLayer({
      id: 'idmt-submarkets-glow', type: 'line', source: 'idmt-submarkets',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#9085e9', 'line-width': 7, 'line-opacity': 0.18, 'line-blur': 3 },
    });
    map.addLayer({
      id: 'idmt-submarkets-line', type: 'line', source: 'idmt-submarkets',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#a89ef0',
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.6, 13, 2.6],
        'line-opacity': 0.95,
      },
    });
    map.addLayer({
      id: 'idmt-submarkets-highlight', type: 'line', source: 'idmt-submarkets',
      filter: ['==', ['coalesce', ['get', 'name'], ['get', 'Name'], ''], '__none__'],
      paint: { 'line-color': '#3987e5', 'line-width': 4 },
    });
    map.addLayer({
      id: 'idmt-submarket-labels', type: 'symbol', source: 'idmt-submarket-labels',
      layout: {
        'text-field': ['get', 'name'],
        'text-font': styleFont(),
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 11.5, 13, 14],
        'text-letter-spacing': 0.08,
        'text-transform': 'uppercase',
        // always place our labels — basemap labels must never knock submarket names off the map
        'text-allow-overlap': true,
        'text-ignore-placement': false,
      },
      paint: { 'text-color': '#d6d2f5', 'text-halo-color': '#0d0d0d', 'text-halo-width': 2 },
    });
    map.addLayer({
      id: 'idmt-parcels-fill', type: 'fill', source: 'idmt-parcels',
      paint: { 'fill-color': '#c98500', 'fill-opacity': 0.14 },
    });
    map.addLayer({
      id: 'idmt-parcels-line', type: 'line', source: 'idmt-parcels',
      paint: { 'line-color': '#c98500', 'line-width': 2 },
    });
  }

  /* ---------- properties ---------- */

  function addPropertyLayers() {
    map.addSource('idmt-properties', { type: 'geojson', data: IDMT.propertiesGeoJSON() });
    map.addLayer({
      id: 'idmt-properties-halo', type: 'circle', source: 'idmt-properties',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 5, 14, 10],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.25,
        'circle-blur': 0.4,
      },
    });
    map.addLayer({
      id: 'idmt-properties-pt', type: 'circle', source: 'idmt-properties',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3.2, 14, 6.5],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#0d0d0d',
        'circle-stroke-width': 1.2,
      },
    });
    map.addLayer({
      id: 'idmt-selected', type: 'circle', source: 'idmt-properties',
      filter: ['==', ['get', 'id'], '__none__'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 8, 14, 13],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2.2,
      },
    });
  }

  /* Pulsing ring on the selected pin — runs only while something is selected. */
  function pulseLoop(t0) {
    if (!selectedId || !styleReady || !map.getLayer('idmt-selected')) { pulseRAF = null; return; }
    const s = (performance.now() % 1600) / 1600;
    const wave = 0.5 + 0.5 * Math.sin(s * Math.PI * 2);
    map.setPaintProperty('idmt-selected', 'circle-stroke-width', 1.8 + wave * 2.2);
    map.setPaintProperty('idmt-selected', 'circle-stroke-opacity', 0.55 + wave * 0.45);
    pulseRAF = requestAnimationFrame(pulseLoop);
  }

  function setSelected(id) {
    selectedId = id;
    if (styleReady) map.setFilter('idmt-selected', ['==', ['get', 'id'], id ?? '__none__']);
    if (id && !pulseRAF) pulseRAF = requestAnimationFrame(pulseLoop);
  }

  /* ---------- interactions ---------- */

  function wireInteractions() {
    map.on('mouseenter', 'idmt-properties-pt', (e) => {
      map.getCanvas().style.cursor = 'pointer';
      const f = e.features[0];
      hoverPopup
        .setLngLat(f.geometry.coordinates)
        .setHTML(`<div class="popup-name">${esc(f.properties.name)}</div><div class="popup-sub">${esc(f.properties.type)} · ${esc(f.properties.submarket || '')}</div>`)
        .addTo(map);
    });
    map.on('mouseleave', 'idmt-properties-pt', () => {
      map.getCanvas().style.cursor = '';
      hoverPopup.remove();
    });
    map.on('click', 'idmt-properties-pt', (e) => {
      focusProperty(e.features[0].properties.id, { fly: false });
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------- orbit + presentation ---------- */

  function startOrbit() {
    if (orbiting) return;
    orbiting = true;
    document.getElementById('btn-orbit').textContent = 'Orbit: on';
    let last = performance.now();
    function spin(now) {
      if (!orbiting) return;
      const dt = now - last; last = now;
      map.setBearing(map.getBearing() + dt * 0.004); // ~14°/s
      requestAnimationFrame(spin);
    }
    requestAnimationFrame(spin);
  }

  function stopOrbit() {
    orbiting = false;
    const btn = document.getElementById('btn-orbit');
    if (btn) btn.textContent = 'Orbit: off';
  }

  function toggleOrbit() { orbiting ? stopOrbit() : startOrbit(); }

  function togglePresentation() {
    document.body.classList.toggle('presentation');
  }

  /* ---------- controls ---------- */

  function toggle(id, layers) {
    document.getElementById(id).addEventListener('change', (e) => {
      if (!styleReady) return;
      const vis = e.target.checked ? 'visible' : 'none';
      const list = typeof layers === 'function' ? layers() : layers;
      list.forEach((l) => map.getLayer(l) && map.setLayoutProperty(l, 'visibility', vis));
    });
  }

  function wireControls() {
    toggle('lyr-3d', ['idmt-3d-buildings']);
    toggle('lyr-submarkets', ['idmt-submarkets-fill', 'idmt-submarkets-glow', 'idmt-submarkets-line', 'idmt-submarkets-highlight']);
    toggle('lyr-submarket-labels', ['idmt-submarket-labels']);
    toggle('lyr-parcels', ['idmt-parcels-fill', 'idmt-parcels-line']);
    toggle('lyr-parcel-tiles', () => IDMT._parcelTileLayerIds || []);
    toggle('lyr-properties', ['idmt-properties-pt', 'idmt-properties-halo', 'idmt-selected']);
    toggle('lyr-satellite', ['idmt-satellite']);

    document.getElementById('btn-pitch').addEventListener('click', () => {
      is3D = !is3D;
      map.easeTo({ pitch: is3D ? (IDMT.config.market.pitch || 50) : 0, duration: 600 });
      document.getElementById('btn-pitch').textContent = 'Tilt: ' + (is3D ? '3D' : '2D');
    });
    document.getElementById('btn-reset-view').addEventListener('click', () => {
      stopOrbit();
      const m = IDMT.config.market;
      map.flyTo({ center: m.center, zoom: m.zoom, pitch: is3D ? (m.pitch || 50) : 0, bearing: m.bearing || 0 });
    });
    document.getElementById('btn-orbit').addEventListener('click', toggleOrbit);
    document.getElementById('btn-grow').addEventListener('click', () => { buildingsGrown = true; growBuildings(); });
    document.getElementById('btn-present').addEventListener('click', togglePresentation);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'h' && !e.target.matches('input, textarea, select')) togglePresentation();
      if (e.key === 'o' && !e.target.matches('input, textarea, select')) toggleOrbit();
    });
  }

  function renderTypeToggles() {
    const el = document.getElementById('type-toggles');
    el.innerHTML = '';
    Object.entries(IDMT.typeColors).forEach(([type, color]) => {
      const row = document.createElement('label');
      row.className = 'layer-row';
      row.innerHTML = `<input type="checkbox" ${IDMT.filters.hiddenTypes.has(type) ? '' : 'checked'} /><span class="swatch" style="background:${color}"></span>${esc(type)}`;
      row.querySelector('input').addEventListener('change', (e) => {
        IDMT.filterEngine.setTypeHidden(type, !e.target.checked);
      });
      el.appendChild(row);
    });
  }

  /* ---------- data refresh ---------- */

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

  function polygonCentroid(feature) {
    const ring = feature.geometry.type === 'Polygon'
      ? feature.geometry.coordinates[0]
      : (feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates[0][0] : null);
    if (!ring) return null;
    let x = 0, y = 0;
    ring.forEach((c) => { x += c[0]; y += c[1]; });
    return [x / ring.length, y / ring.length];
  }

  function submarketLabelPoints() {
    if (!IDMT.submarkets) return emptyFC();
    return {
      type: 'FeatureCollection',
      features: IDMT.submarkets.features
        .map((f) => {
          const c = polygonCentroid(f);
          return c && { type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { name: IDMT.featureName(f) } };
        })
        .filter(Boolean),
    };
  }

  function refreshData() {
    if (!styleReady) return;
    map.getSource('idmt-properties').setData(IDMT.propertiesGeoJSON());
    map.getSource('idmt-submarkets').setData(IDMT.submarkets || emptyFC());
    map.getSource('idmt-parcels').setData(IDMT.parcels || emptyFC());
    map.getSource('idmt-submarket-labels').setData(submarketLabelPoints());
    renderTypeToggles();
  }

  /* Filter-change refresh: pins + the active submarket set (which can swap when
     a single asset class is toggled on and has its own boundaries). */
  function refreshFiltered() {
    if (!styleReady) return;
    map.getSource('idmt-properties').setData(IDMT.propertiesGeoJSON());
    map.getSource('idmt-submarkets').setData(IDMT.submarkets || emptyFC());
    map.getSource('idmt-submarket-labels').setData(submarketLabelPoints());
    renderTypeToggles();
  }

  /* ---------- focus helpers ---------- */

  function focusProperty(id, opts = {}) {
    const p = IDMT.getProperty(id);
    if (!p) return;
    stopOrbit();
    if (opts.fly !== false) {
      map.flyTo({
        center: [p._lng, p._lat],
        zoom: Math.max(map.getZoom(), 16),
        pitch: is3D ? 58 : 0,
        bearing: (map.getBearing() + 45) % 360, // sweep in for a more cinematic arrival
        duration: 2600,
        essential: true,
      });
    }
    setSelected(id);
    IDMT.detail.open(p);
  }

  function focusSubmarket(name) {
    stopOrbit();
    // look in the active set first, then across every per-type set
    let feats = (IDMT.submarkets ? IDMT.submarkets.features : []).filter((f) => IDMT.featureName(f) === name);
    if (!feats.length) {
      const sets = [IDMT.submarketSets.default, ...Object.values(IDMT.submarketSets.byType)].filter(Boolean);
      for (const set of sets) {
        feats = set.features.filter((f) => IDMT.featureName(f) === name);
        if (feats.length) break;
      }
    }
    if (!feats.length) return;
    let minX = 180, minY = 90, maxX = -180, maxY = -90;
    feats.forEach((f) => {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      polys.forEach((poly) => poly[0].forEach(([x, y]) => {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }));
    });
    map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 70, pitch: is3D ? (IDMT.config.market.pitch || 50) : 0 });
    if (styleReady) map.setFilter('idmt-submarkets-highlight', ['==', ['coalesce', ['get', 'name'], ['get', 'Name'], ''], name]);
    IDMT.detail.close();
  }

  function resize() { if (map) map.resize(); }

  return { init, refreshData, refreshFiltered, focusProperty, focusSubmarket, resize, growBuildings, toggleOrbit };
})();
