/* map.js — 3D MapLibre map: basemap, building extrusions, submarket/parcel boundaries,
   property pins, layer toggles, focus/fly-to. Market-agnostic: everything comes from config.json. */

IDMT.map = (function () {
  let map = null;
  let hoverPopup = null;
  let styleReady = false;
  let is3D = true;
  let hiddenTypes = new Set();

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
      center: m.center,
      zoom: m.zoom,
      pitch: m.pitch || 50,
      bearing: m.bearing || 0,
      maxBounds: m.maxBounds || undefined,
      antialias: true,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
    hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });

    // 'style.load' rather than 'load': custom layers go on as soon as the style is
    // ready, instead of waiting for every basemap tile (which can stall on slow networks).
    map.on('style.load', () => {
      styleReady = true;
      addSatellite();
      addBuildings();
      addBoundaryLayers();
      addPropertyLayers();
      wireInteractions();
      refreshData();
    });
    IDMT._map = map;
    new ResizeObserver(() => map.resize()).observe(document.getElementById('map'));
    wireControls();
    return map;
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

  function addBuildings() {
    const src = vectorSourceKey();
    if (!src) return;
    map.addLayer(
      {
        id: 'idmt-3d-buildings',
        type: 'fill-extrusion',
        source: src,
        'source-layer': 'building',
        minzoom: 12.5,
        paint: {
          'fill-extrusion-color': '#343432',
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 10],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.85,
        },
      },
      firstSymbolLayerId()
    );
  }

  /* ---------- boundaries ---------- */

  function addBoundaryLayers() {
    map.addSource('idmt-submarkets', { type: 'geojson', data: IDMT.submarkets || emptyFC() });
    map.addSource('idmt-parcels', { type: 'geojson', data: IDMT.parcels || emptyFC() });
    map.addSource('idmt-submarket-labels', { type: 'geojson', data: emptyFC() });

    map.addLayer({
      id: 'idmt-submarkets-fill', type: 'fill', source: 'idmt-submarkets',
      paint: { 'fill-color': '#9085e9', 'fill-opacity': 0.07 },
    });
    map.addLayer({
      id: 'idmt-submarkets-line', type: 'line', source: 'idmt-submarkets',
      paint: { 'line-color': '#9085e9', 'line-width': 1.6, 'line-dasharray': [3, 2] },
    });
    map.addLayer({
      id: 'idmt-submarkets-highlight', type: 'line', source: 'idmt-submarkets',
      filter: ['==', ['coalesce', ['get', 'name'], ['get', 'Name'], ''], '__none__'],
      paint: { 'line-color': '#3987e5', 'line-width': 3.5 },
    });
    map.addLayer({
      id: 'idmt-submarket-labels', type: 'symbol', source: 'idmt-submarket-labels',
      layout: {
        'text-field': ['get', 'name'],
        'text-font': styleFont(),
        'text-size': 12.5,
        'text-letter-spacing': 0.08,
        'text-transform': 'uppercase',
      },
      paint: { 'text-color': '#c3c2b7', 'text-halo-color': '#0d0d0d', 'text-halo-width': 1.4 },
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

  function applyTypeFilter() {
    if (!styleReady) return;
    const filter = hiddenTypes.size
      ? ['!', ['in', ['get', 'type'], ['literal', [...hiddenTypes]]]]
      : null;
    ['idmt-properties-pt', 'idmt-properties-halo'].forEach((id) => map.setFilter(id, filter));
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

  /* ---------- controls ---------- */

  function toggle(id, layers) {
    document.getElementById(id).addEventListener('change', (e) => {
      if (!styleReady) return;
      const vis = e.target.checked ? 'visible' : 'none';
      layers.forEach((l) => map.getLayer(l) && map.setLayoutProperty(l, 'visibility', vis));
    });
  }

  function wireControls() {
    toggle('lyr-3d', ['idmt-3d-buildings']);
    toggle('lyr-submarkets', ['idmt-submarkets-fill', 'idmt-submarkets-line', 'idmt-submarkets-highlight']);
    toggle('lyr-submarket-labels', ['idmt-submarket-labels']);
    toggle('lyr-parcels', ['idmt-parcels-fill', 'idmt-parcels-line']);
    toggle('lyr-properties', ['idmt-properties-pt', 'idmt-properties-halo', 'idmt-selected']);
    toggle('lyr-satellite', ['idmt-satellite']);

    document.getElementById('btn-pitch').addEventListener('click', () => {
      is3D = !is3D;
      map.easeTo({ pitch: is3D ? (IDMT.config.market.pitch || 50) : 0, duration: 600 });
      document.getElementById('btn-pitch').textContent = 'Tilt: ' + (is3D ? '3D' : '2D');
    });
    document.getElementById('btn-reset-view').addEventListener('click', () => {
      const m = IDMT.config.market;
      map.flyTo({ center: m.center, zoom: m.zoom, pitch: is3D ? (m.pitch || 50) : 0, bearing: m.bearing || 0 });
    });
  }

  function renderTypeToggles() {
    const el = document.getElementById('type-toggles');
    el.innerHTML = '';
    Object.entries(IDMT.typeColors).forEach(([type, color]) => {
      const row = document.createElement('label');
      row.className = 'layer-row';
      row.innerHTML = `<input type="checkbox" ${hiddenTypes.has(type) ? '' : 'checked'} /><span class="swatch" style="background:${color}"></span>${esc(type)}`;
      row.querySelector('input').addEventListener('change', (e) => {
        e.target.checked ? hiddenTypes.delete(type) : hiddenTypes.add(type);
        applyTypeFilter();
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
    applyTypeFilter();
  }

  /* ---------- focus helpers ---------- */

  function focusProperty(id, opts = {}) {
    const p = IDMT.getProperty(id);
    if (!p) return;
    if (opts.fly !== false) {
      map.flyTo({ center: [p._lng, p._lat], zoom: Math.max(map.getZoom(), 15.5), pitch: is3D ? (IDMT.config.market.pitch || 50) : 0 });
    }
    if (styleReady) map.setFilter('idmt-selected', ['==', ['get', 'id'], id]);
    IDMT.detail.open(p);
  }

  function focusSubmarket(name) {
    if (!IDMT.submarkets) return;
    const feats = IDMT.submarkets.features.filter((f) => IDMT.featureName(f) === name);
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

  return { init, refreshData, focusProperty, focusSubmarket, resize };
})();
