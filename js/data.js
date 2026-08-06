/* data.js — loads config, the connected xlsx workbook, and KMZ/KML/GeoJSON layers.
   Everything the platform shows is derived from these uploads; nothing external. */

const IDMT = window.IDMT = {
  config: null,
  properties: [],       // normalized rows: raw columns + _id,_name,_lat,_lng,_type,_submarket,_size,_occ,_rent
  columns: [],          // original header order from the workbook
  submarkets: null,     // GeoJSON FeatureCollection (polygons, name property)
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
  IDMT.properties = rows.map((row, i) => IDMT.normalizeRow(row, i)).filter((p) => p._lat !== null && p._lng !== null);
  IDMT.assignTypeColors();
  if (IDMT.submarkets) IDMT.assignSubmarkets();
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
  // KMZ: a zip containing one or more .kml files
  const zip = await JSZip.loadAsync(buf);
  const kmlName = Object.keys(zip.files).find((n) => n.toLowerCase().endsWith('.kml'));
  if (!kmlName) throw new Error('No .kml inside ' + filename);
  const text = await zip.files[kmlName].async('text');
  return IDMT.parseKml(text);
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
  IDMT.submarkets = await IDMT.loadBoundaryList(IDMT.config.layers.submarkets);
  IDMT.parcels = await IDMT.loadBoundaryList(IDMT.config.layers.parcels);
  IDMT.assignSubmarkets();
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

/* A workbook Submarket column always wins; polygons fill in the blanks. */
IDMT.assignSubmarkets = function () {
  if (!IDMT.submarkets || !IDMT.properties.length) return;
  for (const p of IDMT.properties) {
    if (p._submarket) continue;
    const hit = IDMT.submarkets.features.find((f) => pointInFeature([p._lng, p._lat], f));
    p._submarket = hit ? IDMT.featureName(hit) : 'Unassigned';
  }
};

/* ---------------- derived: GeoJSON of properties ---------------- */

IDMT.propertiesGeoJSON = function () {
  return {
    type: 'FeatureCollection',
    features: IDMT.properties.map((p) => ({
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

IDMT.aggregate = function (typeFilter) {
  const props = IDMT.properties.filter((p) => !typeFilter || p._type === typeFilter);
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
