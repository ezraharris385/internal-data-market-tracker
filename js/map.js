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
  let msaFitted = false;
  let mode = 'properties'; // 'properties' | 'markets' — markets shows boundary visuals
  let pickCallback = null; // one-shot map click for the Add-property form

  const BOUNDARY_LAYERS = {
    'lyr-submarkets': ['idmt-submarkets-fill', 'idmt-submarkets-glow', 'idmt-submarkets-line', 'idmt-submarkets-highlight'],
    'lyr-submarket-labels': ['idmt-submarket-labels'],
    'lyr-counties': ['idmt-counties-line', 'idmt-county-labels'],
    'lyr-cities': ['idmt-cities-line', 'idmt-city-labels'],
  };
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
      // MSAA on a full-screen Retina canvas with extrusions roughly halves the frame
      // rate — crispness comes from devicePixelRatio, which we keep at native.
      antialias: false,
      fadeDuration: 150,
      attributionControl: { compact: true },
    });
    IDMT._map = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right');
    hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });

    // 'style.load' rather than 'load': custom layers go on as soon as the style is
    // ready, instead of waiting for every basemap tile (which can stall on slow networks).
    map.on('style.load', () => {
      styleReady = true;
      // directional light: strong face shading so extrusions read as 3D volumes
      map.setLight({ anchor: 'viewport', color: '#ffffff', intensity: 0.45, position: [1.4, 105, 55] });
      addSatellite();
      addBuildings();
      addParcelTiles();
      addAdminLayers();
      addBoundaryLayers();
      addPropertyLayers();
      map.moveLayer('idmt-submarket-labels'); // labels above pins — they must always read
      wireInteractions();
      refreshData();
      applyMode();
      flyIntro();
    });
    // buildings "grow out of the ground" the first time the camera gets close
    map.on('zoomend', () => {
      if (!buildingsGrown && map.getZoom() >= 15) growBuildings();
    });
    map.on('mousedown', stopOrbit);
    map.on('zoom', () => updateParcelsHint());
    new ResizeObserver(() => map.resize()).observe(document.getElementById('map'));
    wireControls();
    return map;
  }

  /* The MSA boundary defines the world: camera fits it, bounds lock to it. */
  function msaBounds() {
    return IDMT.admin && IDMT.admin.msa ? IDMT.fcBounds(IDMT.admin.msa) : null;
  }

  function fitMSA(opts = {}) {
    const b = msaBounds();
    const m = IDMT.config.market;
    if (b) {
      map.fitBounds(b, Object.assign({ padding: 30, pitch: m.pitch || 50, bearing: m.bearing || 0, duration: 3500, essential: true }, opts));
    } else {
      map.flyTo(Object.assign({ center: m.center, zoom: m.zoom, pitch: m.pitch || 50, bearing: m.bearing || 0, duration: 3500, essential: true }, opts));
    }
  }

  function applyMSABounds() {
    const b = msaBounds();
    if (!b) return;
    const pad = 0.35; // degrees of slack so fitBounds + tilt never fight the lock
    map.setMaxBounds([[b[0][0] - pad, b[0][1] - pad], [b[1][0] + pad, b[1][1] + pad]]);
  }

  /* ONE camera move at boot: refreshAdminData fits the MSA as soon as its geometry
     arrives; this is only a fallback if the boundary file never loads. Two competing
     fly animations was the load-time glitch. */
  function flyIntro() {
    setTimeout(() => {
      if (!msaFitted) { msaFitted = true; fitMSA(); }
    }, 3000);
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
    // Hide the basemap's own building layers: its extrusions would fight ours, and its
    // 2D footprints z-fight under our extrusions during zoom (visible flicker).
    for (const l of styleLayers) {
      if (l.id.startsWith('idmt')) continue;
      if (l.type === 'fill-extrusion' || (l['source-layer'] === srcLayer && (l.type === 'fill' || l.type === 'line'))) {
        map.setLayoutProperty(l.id, 'visibility', 'none');
      }
    }
    map.addLayer(
      {
        id: 'idmt-3d-buildings',
        type: 'fill-extrusion',
        source: src,
        'source-layer': srcLayer,
        minzoom: 14.3,
        paint: {
          // dark-theme ramp: taller buildings read lighter so the skyline pops.
          // Kept bright enough to separate clearly from the near-black basemap.
          'fill-extrusion-color': [
            'interpolate', ['linear'], ['coalesce', ['get', 'render_height'], ['get', 'height'], 12],
            0, '#454b59', 40, '#59617a', 100, '#737e9e', 200, '#97a3c4',
          ],
          'fill-extrusion-height': buildingHeightExpr(1),
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
          'fill-extrusion-vertical-gradient': true,
          // fade the skyline in over half a zoom level instead of popping
          'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 14.4, 0, 15.1, 1],
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
      // parcels carry their county data: color by use class (legend in Parcels mode)
      const use = ['downcase', ['coalesce', ['get', 'USECLASS1'], '']];
      const has = (s) => ['>', ['index-of', s, use], -1];
      map.addLayer({
        id: srcId + '-fill', type: 'fill', source: srcId, 'source-layer': srcLayer,
        minzoom,
        paint: {
          'fill-color': ['case',
            has('res'), '#4e79c4',
            has('apart'), '#4e79c4',
            has('comm'), '#d19a45',
            has('ind'), '#c26a50',
            has('agr'), '#5f9e63',
            has('church'), '#8d8d97', has('school'), '#8d8d97', has('exempt'), '#8d8d97',
            has('public'), '#8d8d97', has('gov'), '#8d8d97',
            '#6e7480'],
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], minzoom, 0, minzoom + 0.8, 0.16],
        },
      }, firstSymbolLayerId());
      map.addLayer({
        id: srcId + '-line', type: 'line', source: srcId, 'source-layer': srcLayer,
        minzoom,
        paint: {
          // restrained at low zoom: dense old plats otherwise read as solid blocks
          'line-color': '#8f8878',
          'line-opacity': ['interpolate', ['linear'], ['zoom'], minzoom, 0, 15, 0.22, 17, 0.6],
          'line-width': ['interpolate', ['linear'], ['zoom'], minzoom, 0.2, 18, 1.1],
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
          rows.map(([k, v]) => `<div class="popup-sub"><b>${k}:</b> ${esc(v)}</div>`).join('') +
          `<div class="popup-sub" style="margin-top:5px;color:var(--text-muted)">Source: MetroGIS county records (real, open data)</div>`)
        .addTo(map);
    }
  }

  /* ---------- administrative boundaries: MSA / counties / cities ---------- */

  function adminLabelPoints(fc) {
    if (!fc) return emptyFC();
    return {
      type: 'FeatureCollection',
      features: fc.features.map((f) => {
        const c = polygonCentroid(f);
        return c && { type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { name: IDMT.featureName(f) } };
      }).filter(Boolean),
    };
  }

  function addAdminLayers() {
    map.addSource('idmt-msa', { type: 'geojson', data: emptyFC() });
    map.addSource('idmt-counties', { type: 'geojson', data: emptyFC() });
    map.addSource('idmt-county-labels', { type: 'geojson', data: emptyFC() });
    map.addSource('idmt-cities', { type: 'geojson', data: emptyFC() });
    map.addSource('idmt-city-labels', { type: 'geojson', data: emptyFC() });

    // MSA: the market's edge — always on, strong signature line
    map.addLayer({
      id: 'idmt-msa-glow', type: 'line', source: 'idmt-msa',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#3987e5', 'line-width': 9, 'line-opacity': 0.16, 'line-blur': 4 },
    });
    map.addLayer({
      id: 'idmt-msa-line', type: 'line', source: 'idmt-msa',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#5c9bea',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2, 12, 3.2],
        'line-opacity': 0.9,
      },
    });

    // Counties: neutral steel lines + small-caps labels (toggle, default off)
    map.addLayer({
      id: 'idmt-counties-line', type: 'line', source: 'idmt-counties',
      layout: { visibility: 'none', 'line-join': 'round' },
      paint: {
        'line-color': '#8fa3b8',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.2, 12, 2],
        'line-opacity': 0.75,
        'line-dasharray': [4, 2],
      },
    });
    map.addLayer({
      id: 'idmt-county-labels', type: 'symbol', source: 'idmt-county-labels',
      layout: {
        visibility: 'none',
        'text-field': ['get', 'name'],
        'text-font': styleFont(),
        'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 12, 15],
        'text-letter-spacing': 0.15,
        'text-transform': 'uppercase',
        'text-allow-overlap': true,
      },
      paint: { 'text-color': '#aebfd2', 'text-halo-color': '#0d0d0d', 'text-halo-width': 2 },
    });

    // Cities: finer teal lines + labels that auto-declutter (toggle, default off)
    map.addLayer({
      id: 'idmt-cities-line', type: 'line', source: 'idmt-cities',
      layout: { visibility: 'none', 'line-join': 'round' },
      paint: {
        'line-color': '#4fae9d',
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 13, 1.6],
        'line-opacity': 0.7,
      },
    });
    map.addLayer({
      id: 'idmt-city-labels', type: 'symbol', source: 'idmt-city-labels',
      minzoom: 9,
      layout: {
        visibility: 'none',
        'text-field': ['get', 'name'],
        'text-font': styleFont(),
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 13, 12.5],
        'text-transform': 'none',
      },
      paint: { 'text-color': '#8fd4c8', 'text-halo-color': '#0d0d0d', 'text-halo-width': 1.6 },
    });
  }

  function refreshAdminData() {
    if (!styleReady || !IDMT.admin) return;
    const set = (src, data) => map.getSource(src) && map.getSource(src).setData(data || emptyFC());
    set('idmt-msa', IDMT.admin.msa);
    set('idmt-counties', IDMT.admin.counties);
    set('idmt-county-labels', adminLabelPoints(IDMT.admin.counties));
    set('idmt-cities', IDMT.admin.cities);
    set('idmt-city-labels', adminLabelPoints(IDMT.admin.cities));
    applyMSABounds();
    if (!msaFitted && msaBounds()) { msaFitted = true; fitMSA(); }
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
      minzoom: 10.3, // neighborhood-scale submarkets: labels only once the core fills the view
      layout: {
        'text-field': ['get', 'name'],
        'text-font': styleFont(),
        'text-size': ['interpolate', ['linear'], ['zoom'], 10.3, 11, 13, 14],
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

  /* Pulsing ring on the selected pin — runs only while something is selected,
     and yields while the camera is animating so it never competes with a zoom. */
  function pulseLoop(t0) {
    if (!selectedId || !styleReady || !map.getLayer('idmt-selected')) { pulseRAF = null; return; }
    if (map.isMoving()) { pulseRAF = requestAnimationFrame(pulseLoop); return; }
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
      if (pickCallback) return; // picking a location — don't open drawers
      focusProperty(e.features[0].properties.id, { fly: false });
    });

    // one-shot location pick for the Add-property form (registered before other clicks)
    map.on('click', (e) => {
      if (!pickCallback) return;
      const cb = pickCallback;
      pickCallback = null;
      map.getCanvas().style.cursor = '';
      cb(e.lngLat);
    });

    // Markets mode: click a submarket → tracked-inventory quick stats
    map.on('click', 'idmt-submarkets-fill', (e) => {
      if (mode !== 'markets' || pickCallback) return;
      if (map.queryRenderedFeatures(e.point, { layers: ['idmt-properties-pt'] }).length) return;
      const name = IDMT.featureName(e.features[0]);
      const inSub = IDMT.properties.filter((p) => p._submarket === name);
      const sf = inSub.reduce((a, p) => a + (p._size || 0), 0);
      const occ = inSub.filter((p) => p._occ !== null);
      const avgOcc = occ.length ? occ.reduce((a, p) => a + p._occ, 0) / occ.length : null;
      hoverPopup.remove();
      new maplibregl.Popup({ offset: 8, maxWidth: '280px' })
        .setLngLat(e.lngLat)
        .setHTML(`<div class="popup-name">${esc(name)}</div>
          <div class="popup-sub"><b>Tracked properties:</b> ${inSub.length}</div>
          <div class="popup-sub"><b>Tracked SF:</b> ${IDMT.fmt.int(sf)}</div>
          <div class="popup-sub"><b>Avg occupancy:</b> ${inSub.length >= 3 ? IDMT.fmt.pct(avgOcc) : 'n < 3'}</div>`)
        .addTo(map);
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------- view modes: Properties (no boundary visuals) vs Markets ---------- */

  function applyMode() {
    if (!styleReady) return;
    // boundary visuals: Markets tab only
    for (const [checkboxId, layers] of Object.entries(BOUNDARY_LAYERS)) {
      const cb = document.getElementById(checkboxId);
      const vis = mode === 'markets' && cb && cb.checked ? 'visible' : 'none';
      layers.forEach((l) => map.getLayer(l) && map.setLayoutProperty(l, 'visibility', vis));
    }
    // metro parcel fabric: Parcels tab only
    const ptCb = document.getElementById('lyr-parcel-tiles');
    const ptVis = mode === 'parcels' && ptCb && ptCb.checked ? 'visible' : 'none';
    (IDMT._parcelTileLayerIds || []).forEach((l) => map.getLayer(l) && map.setLayoutProperty(l, 'visibility', ptVis));
  }

  function setMode(m, opts = {}) {
    const changed = m !== mode;
    mode = m;
    applyMode();
    updateParcelsHint();
    if (!changed || !styleReady) return;
    // Each section resets to its canonical camera — UNLESS the caller is about to
    // aim the camera itself (e.g. "show this submarket on the map"). Two competing
    // camera animations was the black-screen bug.
    msaFitted = true;
    stopOrbit();
    if (opts.keepCamera) return;
    if (m === 'parcels') {
      const mk = IDMT.config.market;
      map.flyTo({ center: mk.center, zoom: 15.2, pitch: is3D ? 55 : 0, bearing: mk.bearing || 0, duration: 2200, essential: true });
    } else {
      fitMSA({ duration: 2200 });
    }
  }

  /* Aerial (satellite) imagery — a first-class view control, not a buried layer */
  function toggleAerial(on) {
    if (!styleReady || !map.getLayer('idmt-satellite')) return;
    const cb = document.getElementById('lyr-satellite');
    const next = on === undefined ? map.getLayoutProperty('idmt-satellite', 'visibility') !== 'visible' : !!on;
    map.setLayoutProperty('idmt-satellite', 'visibility', next ? 'visible' : 'none');
    if (cb) cb.checked = next;
    const btn = document.getElementById('btn-aerial');
    if (btn) btn.classList.toggle('active', next);
    // over imagery, our own dark building extrusions read as blobs — hide them
    if (map.getLayer('idmt-3d-buildings')) {
      const b3 = document.getElementById('lyr-3d');
      map.setLayoutProperty('idmt-3d-buildings', 'visibility', next ? 'none' : (b3 && b3.checked ? 'visible' : 'none'));
    }
    return next;
  }

  /* "zoom in" hint while the Parcels tab sits below the fabric's minzoom */
  function updateParcelsHint() {
    const el = document.getElementById('parcels-hint');
    if (!el) return;
    el.style.display = mode === 'parcels' && map.getZoom() < 13.9 ? 'block' : 'none';
  }

  /* One-shot location picker for the Add-property form. */
  function pickLocation(cb) {
    pickCallback = cb;
    map.getCanvas().style.cursor = 'crosshair';
  }

  /* ---------- orbit + presentation ---------- */

  function startOrbit() {
    if (orbiting) return;
    orbiting = true;
    document.getElementById('btn-orbit').classList.add('active');
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
    if (btn) btn.classList.remove('active');
  }

  function toggleOrbit() { orbiting ? stopOrbit() : startOrbit(); }

  function togglePresentation() {
    const on = document.body.classList.toggle('presentation');
    // always leave a visible way out — a hidden-only-hotkey trap is not acceptable
    let exit = document.getElementById('present-exit');
    if (on && !exit) {
      exit = document.createElement('button');
      exit.id = 'present-exit';
      exit.textContent = '✕ Exit presentation';
      exit.addEventListener('click', togglePresentation);
      document.body.appendChild(exit);
    }
    if (exit) exit.style.display = on ? 'block' : 'none';
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
    toggle('lyr-msa', ['idmt-msa-glow', 'idmt-msa-line']);
    // boundary toggles route through the mode gate: visible only on the Markets tab
    Object.keys(BOUNDARY_LAYERS).forEach((id) => {
      const cb = document.getElementById(id);
      if (cb) cb.addEventListener('change', applyMode);
    });
    toggle('lyr-parcels', ['idmt-parcels-fill', 'idmt-parcels-line']);
    const ptCb = document.getElementById('lyr-parcel-tiles');
    if (ptCb) ptCb.addEventListener('change', applyMode); // fabric respects the Parcels-mode gate
    toggle('lyr-properties', ['idmt-properties-pt', 'idmt-properties-halo', 'idmt-selected']);

    document.getElementById('btn-pitch').addEventListener('click', () => {
      is3D = !is3D;
      map.easeTo({ pitch: is3D ? (IDMT.config.market.pitch || 50) : 0, duration: 600 });
      document.getElementById('btn-pitch').textContent = is3D ? '3D' : '2D';
    });
    document.getElementById('btn-reset-view').addEventListener('click', () => {
      stopOrbit();
      fitMSA({ pitch: is3D ? (IDMT.config.market.pitch || 50) : 0 });
    });
    document.getElementById('btn-orbit').addEventListener('click', toggleOrbit);
    const aerialBtn = document.getElementById('btn-aerial');
    if (aerialBtn) aerialBtn.addEventListener('click', () => toggleAerial());
    const satCb = document.getElementById('lyr-satellite');
    if (satCb) satCb.addEventListener('change', (e) => toggleAerial(e.target.checked));
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
    refreshAdminData();
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
    if (!feats.length) {
      IDMT.emit('toast', `No boundary drawn for "${name}" — showing the whole market instead.`);
      fitMSA({ duration: 1600 });
      return;
    }
    let minX = 180, minY = 90, maxX = -180, maxY = -90;
    feats.forEach((f) => {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      polys.forEach((poly) => poly[0].forEach(([x, y]) => {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }));
    });
    map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 70, pitch: is3D ? (IDMT.config.market.pitch || 50) : 0, duration: 1800, essential: true });
    if (styleReady) map.setFilter('idmt-submarkets-highlight', ['==', ['coalesce', ['get', 'name'], ['get', 'Name'], ''], name]);
    IDMT.detail.close();
  }

  function resize() { if (map) map.resize(); }

  return { init, refreshData, refreshFiltered, focusProperty, focusSubmarket, resize, growBuildings, toggleOrbit, setMode, pickLocation, toggleAerial, togglePresentation };
})();
