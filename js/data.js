/* data.js — loads config, the connected xlsx workbook, and KMZ/KML/GeoJSON layers.
   Everything the platform shows is derived from these uploads; nothing external. */

const IDMT = window.IDMT = {
  config: null,
  properties: [],       // normalized rows: raw columns + _id,_name,_lat,_lng,_type,_submarket,_size,_occ,_rent
  rawRows: [],          // untouched workbook rows (edit overlay applies on top)
  columns: [],          // original header order from the workbook
  submarketSets: { default: null, byType: {} }, // per-asset-type boundary sets
  submarkets: null,     // the currently ACTIVE FeatureCollection (depends on visible types)
  parcels: null,        // GeoJSON FeatureCollection
  typeColors: {},       // property type -> hex
  listeners: {},
};

IDMT.on = function (event, fn) {
  (IDMT.listeners[event] = IDMT.listeners[event] || []).push(fn);
};
IDMT.emit = function (event, payload) {
  (IDMT.listeners[event] || []).forEach((fn) => fn(payload));
};

/* Dark-mode categorical palette (validated reference palette, fixed slot order). */
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9', '#008300', '#e66767'];

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,%\s]/g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
IDMT.num = num;

IDMT.fmt = {
  int: (n) => (n === null ? '—' : Math.round(n).toLocaleString('en-US')),
  sf: (n) => (n === null ? '—' : Math.round(n).toLocaleString('en-US') + ' SF'),
  pct: (n) => (n === null ? '—' : (Math.round(n * 10) / 10).toLocaleString('en-US') + '%'),
  usd: (n) => (n === null ? '—' : '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })),
  usd0: (n) => (n === null ? '—' : '$' + Math.round(n).toLocaleString('en-US')),
  num: (n) => (n === null ? '—' : (Math.round(n * 10) / 10).toLocaleString('en-US')),
  year: (n) => (n === null ? '—' : String(Math.round(n))),
  count: (n) => (n === null ? '—' : String(Math.round(n))),
};

/* ---------------- config + workbook ---------------- */

IDMT.loadConfig = async function () {
  const res = await fetch('config.json?v=' + Date.now());
  if (!res.ok) throw new Error('config.json not found');
  IDMT.config = await res.json();
  return IDMT.config;
};

IDMT.loadWorkbook = async function () {
  const url = IDMT.config.data.workbook + '?v=' + Date.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error('Workbook not found: ' + IDMT.config.data.workbook);
  const buf = await res.arrayBuffer();
  IDMT.ingestWorkbook(buf);
};

/* Accepts an ArrayBuffer of an .xlsx — used both for the repo workbook and drag-dropped files. */
IDMT.ingestWorkbook = function (arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName = IDMT.config.data.sheet && wb.Sheets[IDMT.config.data.sheet]
    ? IDMT.config.data.sheet
    : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  if (!rows.length) throw new Error('Sheet "' + sheetName + '" has no rows');
  IDMT.columns = XLSX.utils.sheet_to_json(ws, { header: 1 })[0].map(String);
  IDMT.rawRows = rows;
  IDMT.rebuildProperties();
};

/* Rebuild normalized properties from rawRows + the local edit overlay. */
IDMT.rebuildProperties = function () {
  const overlay = IDMT.edits.all();
  const f = IDMT.config.fields;
  IDMT.properties = IDMT.rawRows.map((raw, i) => {
    const id = String(raw[f.id] || 'P-' + (i + 1));
    const merged = overlay[id] ? Object.assign({}, raw, overlay[id]) : raw;
    return IDMT.normalizeRow(merged, i);
  }).filter((p) => p._lat !== null && p._lng !== null);
  IDMT.assignTypeColors();
  IDMT.refreshActiveSubmarkets();
  IDMT.assignSubmarkets();
};

/* ---------------- local edit overlay (browser-side; export to commit) ---------------- */

IDMT.edits = (function () {
  const KEY = 'idmt-edits';
  let cache = null;
  function all() {
    if (cache === null) {
      try { cache = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { cache = {}; }
    }
    return cache;
  }
  function save(id, changes) {
    const o = all();
    o[id] = Object.assign(o[id] || {}, changes);
    localStorage.setItem(KEY, JSON.stringify(o));
  }
  function clear() { cache = {}; localStorage.removeItem(KEY); }
  function count() { return Object.keys(all()).length; }
  return { all, save, clear, count };
})();

IDMT.saveEdits = function (id, changes) {
  IDMT.edits.save(id, changes);
  IDMT.rebuildProperties();
  IDMT.emit('data');
};

/* Export the current data (workbook + local edits) back to .xlsx for committing. */
IDMT.exportWorkbook = function () {
  const overlay = IDMT.edits.all();
  const f = IDMT.config.fields;
  const rows = IDMT.rawRows.map((raw, i) => {
    const id = String(raw[f.id] || 'P-' + (i + 1));
    return overlay[id] ? Object.assign({}, raw, overlay[id]) : raw;
  });
  const ws = XLSX.utils.json_to_sheet(rows, { header: IDMT.columns });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, IDMT.config.data.sheet || 'Properties');
  XLSX.writeFile(wb, 'properties.xlsx');
};

IDMT.normalizeRow = function (row, i) {
  const f = IDMT.config.fields;
  const p = Object.assign({}, row);
  p._id = String(row[f.id] || 'P-' + (i + 1));
  p._name = String(row[f.name] || row[f.address] || 'Property ' + (i + 1));
  p._address = String(row[f.address] || '');
  p._city = String(row[f.city] || '');
  p._lat = num(row[f.lat]);
  p._lng = num(row[f.lng]);
  p._type = String(row[f.type] || 'Other').trim() || 'Other';
  p._class = String(row[f.class] || '').trim();
  p._state = String(row[f.state] || '').trim();
  p._county = String(row[f.county] || '').trim();
  p._submarket = String(row[f.submarket] || '').trim();
  p._size = num(row[f.size]);
  p._occ = num(row[f.occupancy]);
  p._rent = num(row[f.rent]);
  p._image = String(row[f.image] || '').trim();
  return p;
};

IDMT.assignTypeColors = function () {
  const order = IDMT.config.typeOrder || [];
  const seen = [...new Set([...order.filter((t) => IDMT.properties.some((p) => p._type === t)),
    ...IDMT.properties.map((p) => p._type)])];
  IDMT.typeColors = {};
  seen.forEach((t, i) => { IDMT.typeColors[t] = SERIES[i % SERIES.length]; });
};

/* ---------------- KMZ / KML / GeoJSON ---------------- */

IDMT.parseKml = function (xmlText) {
  const dom = new DOMParser().parseFromString(xmlText, 'text/xml');
  return toGeoJSON.kml(dom);
};

IDMT.parseBoundaryBuffer = async function (buf, filename) {
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.geojson') || lower.endsWith('.json')) {
    return JSON.parse(new TextDecoder().decode(buf));
  }
  if (lower.endsWith('.kml')) {
    return IDMT.parseKml(new TextDecoder().decode(buf));
  }
  // Zip container: could be a KMZ (holds .kml) or a zipped shapefile (holds .shp/.dbf/.prj)
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files);
  const kmlName = names.find((n) => n.toLowerCase().endsWith('.kml'));
  if (kmlName) {
    const text = await zip.files[kmlName].async('text');
    return IDMT.parseKml(text);
  }
  if (names.some((n) => n.toLowerCase().endsWith('.shp'))) {
    const gj = await shp(buf); // shpjs: zipped shapefile -> GeoJSON (or array per layer)
    if (Array.isArray(gj)) {
      return { type: 'FeatureCollection', features: gj.flatMap((fc) => fc.features || []) };
    }
    return gj;
  }
  throw new Error('No .kml or .shp inside ' + filename);
};

IDMT.loadBoundaryList = async function (urls) {
  const features = [];
  for (const url of urls || []) {
    try {
      const res = await fetch(url + '?v=' + Date.now());
      if (!res.ok) { console.warn('Boundary file missing:', url); continue; }
      const gj = await IDMT.parseBoundaryBuffer(await res.arrayBuffer(), url);
      features.push(...(gj.features || []));
    } catch (e) {
      console.warn('Failed to parse boundary file', url, e);
    }
  }
  return { type: 'FeatureCollection', features };
};

IDMT.loadBoundaries = async function () {
  const cfg = IDMT.config.layers.submarkets;
  if (Array.isArray(cfg)) {
    // legacy shape: one flat list = the default set
    IDMT.submarketSets = { default: await IDMT.loadBoundaryList(cfg), byType: {} };
  } else {
    IDMT.submarketSets = { default: await IDMT.loadBoundaryList(cfg.default || []), byType: {} };
    for (const [type, urls] of Object.entries(cfg.byType || {})) {
      if (urls && urls.length) {
        const fc = await IDMT.loadBoundaryList(urls);
        if (fc.features.length) IDMT.submarketSets.byType[type] = fc;
      }
    }
  }
  IDMT.parcels = await IDMT.loadBoundaryList(IDMT.config.layers.parcels);
  IDMT.refreshActiveSubmarkets();
  IDMT.assignSubmarkets();
};

/* The submarket set for a given asset type (falls back to default). */
IDMT.submarketSetFor = function (type) {
  return IDMT.submarketSets.byType[type] || IDMT.submarketSets.default;
};

/* IDMT.submarkets = what the MAP shows: a type-specific set when exactly one asset
   class is toggled on (and has its own boundaries), otherwise the default set. */
IDMT.refreshActiveSubmarkets = function () {
  let active = IDMT.submarketSets.default;
  if (IDMT.filterEngine) {
    const visible = IDMT.filterEngine.visibleTypes();
    if (visible.length === 1 && IDMT.submarketSets.byType[visible[0]]) {
      active = IDMT.submarketSets.byType[visible[0]];
    }
  }
  IDMT.submarkets = active;
};

/* Every submarket name across every set (search + filter options). */
IDMT.allSubmarketNames = function () {
  const names = new Set();
  const add = (fc) => fc && fc.features.forEach((f) => names.add(IDMT.featureName(f)));
  add(IDMT.submarketSets.default);
  Object.values(IDMT.submarketSets.byType).forEach(add);
  return [...names].sort();
};

/* ---------------- submarket assignment (point in polygon) ---------------- */

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInFeature(pt, feature) {
  const g = feature.geometry;
  if (!g) return false;
  if (g.type === 'Polygon') {
    return pointInRing(pt, g.coordinates[0]) && g.coordinates.slice(1).every((hole) => !pointInRing(pt, hole));
  }
  if (g.type === 'MultiPolygon') {
    return g.coordinates.some((poly) => pointInRing(pt, poly[0]) && poly.slice(1).every((hole) => !pointInRing(pt, hole)));
  }
  return false;
}

IDMT.featureName = function (f) {
  return (f.properties && (f.properties.name || f.properties.Name || f.properties.NAME)) || 'Unnamed';
};

/* A workbook Submarket column always wins; polygons fill in the blanks.
   Each property is assigned from ITS asset type's boundary set (fallback: default),
   so industrial submarkets and office submarkets can differ. */
IDMT.assignSubmarkets = function () {
  if (!IDMT.properties.length) return;
  for (const p of IDMT.properties) {
    if (p._submarket) continue;
    const set = IDMT.submarketSetFor(p._type);
    if (!set || !set.features.length) continue;
    const hit = set.features.find((f) => pointInFeature([p._lng, p._lat], f));
    p._submarket = hit ? IDMT.featureName(hit) : 'Unassigned';
  }
};

/* ---------------- module aggregation (database sub-tabs) ---------------- */

function passesWhere(p, where) {
  if (!where) return true;
  if (where.nonEmpty) return String(p[where.col] ?? '') !== '';
  if (where.in) return where.in.includes(String(p[where.col] ?? '').trim());
  return true;
}

IDMT.moduleAggregate = function (mod) {
  const base = IDMT.filteredProperties();
  const rows = mod.rowFilter ? base.filter((p) => passesWhere(p, mod.rowFilter)) : base;

  const metrics = (mod.metrics || []).map((m) => {
    const pool = m.where ? rows.filter((p) => passesWhere(p, m.where)) : rows;
    let value = null;
    if (m.agg === 'count') {
      value = pool.filter((p) => String(p[m.col] ?? '') !== '').length;
    } else if (m.agg === 'countValue') {
      value = pool.filter((p) => String(p[m.col] ?? '').trim() === m.value).length;
    } else {
      const nums = pool.map((p) => num(p[m.col])).filter((n) => n !== null);
      if (nums.length) {
        if (m.agg === 'sum') value = nums.reduce((a, b) => a + b, 0);
        else if (m.agg === 'avg') value = nums.reduce((a, b) => a + b, 0) / nums.length;
        else if (m.agg === 'max') value = Math.max(...nums);
      }
    }
    const fmt = IDMT.fmt[m.fmt] || IDMT.fmt.int;
    return { label: m.label, display: m.agg === 'count' || m.agg === 'countValue' ? IDMT.fmt.count(value ?? 0) : fmt(value) };
  });

  let chart = null;
  if (mod.chart) {
    const pool = mod.chart.where ? rows.filter((p) => passesWhere(p, mod.chart.where)) : rows;
    const bySub = {};
    for (const p of pool) {
      const n = num(p[mod.chart.col]);
      if (n === null) continue;
      const key = p._submarket || 'Unassigned';
      bySub[key] = bySub[key] || { sum: 0, n: 0 };
      bySub[key].sum += n; bySub[key].n += 1;
    }
    const entries = Object.entries(bySub)
      .map(([k, v]) => [k, mod.chart.agg === 'avg' ? v.sum / v.n : v.sum])
      .sort((a, b) => b[1] - a[1]);
    chart = { label: mod.chart.label, labels: entries.map((e) => e[0]), values: entries.map((e) => e[1]) };
  }

  // table rows: only properties with something to show in this module
  const tableRows = rows.filter((p) => (mod.cols || []).some((c) => String(p[c] ?? '') !== ''));
  return { metrics, chart, rows: tableRows, cols: mod.cols || [] };
};

/* ---------------- derived: GeoJSON of properties ---------------- */

IDMT.propertiesGeoJSON = function () {
  const list = IDMT.filteredProperties ? IDMT.filteredProperties() : IDMT.properties;
  return {
    type: 'FeatureCollection',
    features: list.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p._lng, p._lat] },
      properties: {
        id: p._id, name: p._name, address: p._address, type: p._type,
        submarket: p._submarket, color: IDMT.typeColors[p._type] || '#898781',
      },
    })),
  };
};

IDMT.getProperty = (id) => IDMT.properties.find((p) => p._id === id);

/* ---------------- aggregates for the market database ---------------- */

/* Aggregates always run over the globally filtered set, so the Market Database
   reflects every active filter (types, class, size, asset-specific criteria…). */
IDMT.aggregate = function () {
  const props = IDMT.filteredProperties ? IDMT.filteredProperties() : IDMT.properties;
  const bySub = {};
  for (const p of props) {
    const key = p._submarket || 'Unassigned';
    const s = (bySub[key] = bySub[key] || { name: key, count: 0, sf: 0, occSum: 0, occN: 0, rentSum: 0, rentN: 0, yearSum: 0, yearN: 0 });
    s.count += 1;
    if (p._size !== null) s.sf += p._size;
    if (p._occ !== null) { s.occSum += p._occ; s.occN += 1; }
    if (p._rent !== null) { s.rentSum += p._rent; s.rentN += 1; }
    const y = num(p[IDMT.config.fields.yearBuilt]);
    if (y !== null) { s.yearSum += y; s.yearN += 1; }
  }
  const rows = Object.values(bySub).map((s) => ({
    name: s.name, count: s.count, sf: s.sf,
    avgOcc: s.occN ? s.occSum / s.occN : null,
    avgRent: s.rentN ? s.rentSum / s.rentN : null,
    avgYear: s.yearN ? Math.round(s.yearSum / s.yearN) : null,
  })).sort((a, b) => b.sf - a.sf);

  const totals = {
    count: props.length,
    sf: rows.reduce((a, r) => a + r.sf, 0),
    avgOcc: (() => { const v = props.filter((p) => p._occ !== null); return v.length ? v.reduce((a, p) => a + p._occ, 0) / v.length : null; })(),
    avgRent: (() => { const v = props.filter((p) => p._rent !== null); return v.length ? v.reduce((a, p) => a + p._rent, 0) / v.length : null; })(),
    submarkets: rows.filter((r) => r.name !== 'Unassigned').length,
  };
  const typeMix = {};
  for (const p of props) typeMix[p._type] = (typeMix[p._type] || 0) + 1;
  return { rows, totals, typeMix };
};
