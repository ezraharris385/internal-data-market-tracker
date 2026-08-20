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

/* Fast path: a precomputed derived.json (tools/build_data.py) skips both the xlsx
   parse and the in-browser geo resolution. Falls back to the workbook when absent. */
IDMT.loadWorkbook = async function () {
  // Confidential mode: the workbook is NOT in the repo. The user loads it from
  // their own machine each session (or we restore the last one from this browser),
  // so private data never touches a public host.
  if (IDMT.config.data.confidential) {
    const cached = await IDMT.localWorkbook.restore();
    if (cached) { IDMT.ingestWorkbook(cached); IDMT.buildInfo = { precomputed: false, local: true }; return; }
    IDMT.columns = []; IDMT.rawRows = []; IDMT.properties = [];
    IDMT.buildInfo = { precomputed: false, awaitingLocal: true };
    IDMT.emit('needsWorkbook');
    return;
  }
  const derived = IDMT.config.data.derived || 'data/derived.json';
  try {
    const res = await fetch(derived + '?v=' + Date.now());
    if (res.ok) {
      const payload = await res.json();
      if (payload && Array.isArray(payload.rows) && payload.rows.length) {
        IDMT.columns = payload.columns || Object.keys(payload.rows[0]);
        IDMT.rawRows = payload.rows;
        IDMT.buildInfo = { builtAt: payload.builtAt, source: payload.source, precomputed: true };
        IDMT.rebuildProperties();
        return;
      }
    }
  } catch (e) { /* fall through to the workbook */ }

  const url = IDMT.config.data.workbook + '?v=' + Date.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error('Workbook not found: ' + IDMT.config.data.workbook);
  IDMT.buildInfo = { precomputed: false };
  IDMT.ingestWorkbook(await res.arrayBuffer());
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

/* Rebuild normalized properties from rawRows + user-added rows + the local edit overlay. */
IDMT.rebuildProperties = function () {
  const teamEdits = (IDMT.team && IDMT.team.edits) || {};
  const overlay = IDMT.edits.all();
  const f = IDMT.config.fields;
  const allRows = [...IDMT.rawRows, ...IDMT.addedRows.all()];
  IDMT.properties = allRows.map((raw, i) => {
    const id = String(raw[f.id] || 'P-' + (i + 1));
    // committed team layer first, then this browser's unsaved work
    const merged = (teamEdits[id] || overlay[id])
      ? Object.assign({}, raw, teamEdits[id] || {}, overlay[id] || {})
      : raw;
    return IDMT.normalizeRow(merged, i);
  }).filter((p) => p._lat !== null && p._lng !== null);
  IDMT.assignTypeColors();
  IDMT.refreshActiveSubmarkets();
  IDMT.assignSubmarkets();
  IDMT.assignAdminGeo();
};

/* ---------------- user-added properties (browser-side; export to commit) ---------------- */

IDMT.addedRows = (function () {
  const KEY = 'idmt-added';
  let cache = null;
  function all() {
    if (cache === null) {
      try { cache = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { cache = []; }
    }
    return cache;
  }
  function push(row) {
    all().push(row);
    localStorage.setItem(KEY, JSON.stringify(cache));
  }
  function count() { return all().length; }
  return { all, push, count };
})();

/* Create a brand-new property from the Add form. Lives in this browser until the
   workbook is exported and committed — same contract as edits. */
IDMT.createProperty = function (changes) {
  const f = IDMT.config.fields;
  const row = {};
  IDMT.columns.forEach((c) => { row[c] = ''; });
  Object.assign(row, changes);
  if (!row[f.id]) {
    const n = IDMT.rawRows.length + IDMT.addedRows.count() + 1;
    row[f.id] = 'NEW-' + String(n).padStart(3, '0');
  }
  IDMT.addedRows.push(row);
  IDMT.rebuildProperties();
  IDMT.emit('data');
  return String(row[f.id]);
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

/* Export the current data (workbook + local edits + added properties) back to .xlsx. */
IDMT.exportWorkbook = function () {
  const overlay = IDMT.edits.all();
  const f = IDMT.config.fields;
  const teamEdits = (IDMT.team && IDMT.team.edits) || {};
  const rows = [...IDMT.rawRows, ...IDMT.addedRows.all()].map((raw, i) => {
    const id = String(raw[f.id] || 'P-' + (i + 1));
    return Object.assign({}, raw, teamEdits[id] || {}, overlay[id] || {});
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
  // administrative boundaries: MSA outline, counties, cities
  IDMT.admin = {};
  for (const [key, cfg] of Object.entries(IDMT.config.layers.admin || {})) {
    IDMT.admin[key] = await IDMT.loadBoundaryList(cfg.files || []);
  }
  IDMT.refreshActiveSubmarkets();
  IDMT.assignSubmarkets();
  IDMT.assignAdminGeo();
};

/* bbox of a FeatureCollection: [[minX, minY], [maxX, maxY]] or null */
IDMT.fcBounds = function (fc) {
  if (!fc || !fc.features.length) return null;
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  const eat = (coords) => {
    if (typeof coords[0] === 'number') {
      minX = Math.min(minX, coords[0]); maxX = Math.max(maxX, coords[0]);
      minY = Math.min(minY, coords[1]); maxY = Math.max(maxY, coords[1]);
    } else coords.forEach(eat);
  };
  fc.features.forEach((f) => f.geometry && eat(f.geometry.coordinates));
  return minX > maxX ? null : [[minX, minY], [maxX, maxY]];
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

/* Derive City / County / State / Market from the boundary files when the workbook
   leaves them blank — location is DATA (searchable, filterable, shown on the
   property record), not just a visual layer. Workbook values always win. */
IDMT.assignAdminGeo = function () {
  if (!IDMT.admin || !IDMT.properties.length) return;
  const cities = IDMT.admin.cities, counties = IDMT.admin.counties;
  for (const p of IDMT.properties) {
    const pt = [p._lng, p._lat];
    if (!p._city && cities) {
      const hit = cities.features.find((f) => pointInFeature(pt, f));
      if (hit) { p._city = IDMT.featureName(hit); p[IDMT.config.fields.city] = p._city; }
    }
    if (!p._county && counties) {
      const hit = counties.features.find((f) => pointInFeature(pt, f));
      if (hit) {
        p._county = IDMT.featureName(hit).replace(/\s+County$/i, '');
        p[IDMT.config.fields.county] = p._county;
      }
    }
    if (!p._state && p._county) {
      p._state = /\(WI\)/i.test(p._county) ? 'WI' : 'MN';
      p[IDMT.config.fields.state] = p._state;
    }
    if (!p['Market']) p['Market'] = IDMT.config.market.name;
  }
};

/* ---------------- local workbook store (confidential mode) ----------------
   Keeps the user's private workbook in this browser only (IndexedDB), so it is
   available across sessions without ever being committed or uploaded. */

IDMT.localWorkbook = (function () {
  const DB = 'idmt-local', STORE = 'wb', KEY = 'workbook';
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function put(buf, name) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ buf, name, at: Date.now() }, KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }
  async function restore() {
    try {
      const db = await idb();
      return await new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readonly');
        const r = tx.objectStore(STORE).get(KEY);
        r.onsuccess = () => resolve(r.result ? r.result.buf : null);
        r.onerror = () => resolve(null);
      });
    } catch (e) { return null; }
  }
  async function clear() {
    const db = await idb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(KEY);
  }
  return { put, restore, clear };
})();

/* ---------------- provenance & freshness (Property_Data_Schema §9) ----------------
   Private data goes stale silently. Every record carries where it came from, how
   confident we are, and when it was last true — and the UI shows it. */

IDMT.PROV = { source: 'Source', detail: 'Source Detail', confidence: 'Confidence', asOf: 'As-of Date', verified: 'Last Verified' };

IDMT.monthsSince = function (v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const d = new Date(s.length <= 7 ? s + '-01' : s);
  if (isNaN(d)) return null;
  return Math.max(0, Math.round((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44)));
};

/* fresh (<6mo) | aging (6-12) | stale (>12) | unknown */
IDMT.freshness = function (p) {
  const m = IDMT.monthsSince(p[IDMT.PROV.verified]) ?? IDMT.monthsSince(p[IDMT.PROV.asOf]);
  if (m === null) return { tier: 'unknown', months: null, label: 'No as-of date' };
  if (m <= 6) return { tier: 'fresh', months: m, label: `Verified ${m} mo ago` };
  if (m <= 12) return { tier: 'aging', months: m, label: `${m} mo old` };
  return { tier: 'stale', months: m, label: `Stale — ${m} mo old` };
};

IDMT.confidenceOf = (p) => String(p[IDMT.PROV.confidence] ?? '').trim() || 'Unverified';

/* Data-quality roll-up for the tracked set: what to trust, what to chase. */
IDMT.dataQuality = function (props) {
  const list = props || IDMT.filteredProperties();
  const n = list.length || 1;
  const conf = {}, src = {}, fresh = { fresh: 0, aging: 0, stale: 0, unknown: 0 };
  let monthsSum = 0, monthsN = 0;
  for (const p of list) {
    conf[IDMT.confidenceOf(p)] = (conf[IDMT.confidenceOf(p)] || 0) + 1;
    const s = String(p[IDMT.PROV.source] ?? '').trim() || 'Unrecorded';
    src[s] = (src[s] || 0) + 1;
    const f = IDMT.freshness(p);
    fresh[f.tier] += 1;
    if (f.months !== null) { monthsSum += f.months; monthsN += 1; }
  }
  const filled = (col) => list.filter((p) => String(p[col] ?? '').trim() !== '').length;
  return {
    n: list.length,
    confidence: conf,
    sources: src,
    freshness: fresh,
    medianAgeMonths: monthsN ? Math.round(monthsSum / monthsN) : null,
    completeness: {
      'Lease data': Math.round((filled('Available SF') / n) * 100),
      'Sale history': Math.round((filled('Last Sale Price') / n) * 100),
      'Debt terms': Math.round((filled('Loan Amount ($)') / n) * 100),
      'Operations (NOI)': Math.round((filled('NOI ($)') / n) * 100),
      'Provenance': Math.round((filled(IDMT.PROV.source) / n) * 100),
    },
  };
};

/* ---------------- saved lists & searches ---------------- */

IDMT.lists = (function () {
  const KEY = 'idmt-lists';
  let cache = null;
  function all() {
    if (cache === null) {
      try { cache = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { cache = []; }
    }
    return cache;
  }
  function persist() { localStorage.setItem(KEY, JSON.stringify(cache)); IDMT.emit('lists'); }
  /* kind: 'list' (explicit property ids) | 'search' (filter state) */
  function saveList(name, ids) {
    all().push({ kind: 'list', name, ids: [...ids], savedAt: new Date().toISOString().slice(0, 10) });
    persist();
  }
  function saveSearch(name) {
    const f = IDMT.filters;
    all().push({
      kind: 'search', name, savedAt: new Date().toISOString().slice(0, 10),
      state: {
        hiddenTypes: [...f.hiddenTypes],
        multi: Object.fromEntries(Object.entries(f.multi).map(([k, v]) => [k, [...v]])),
        range: JSON.parse(JSON.stringify(f.range)),
        category: f.category, text: f.text,
      },
    });
    persist();
  }
  function apply(entry) {
    if (entry.kind === 'list') {
      IDMT.filters.multi[IDMT.config.fields.id] = new Set(entry.ids);
    } else {
      const s = entry.state, f = IDMT.filters;
      f.hiddenTypes = new Set(s.hiddenTypes || []);
      f.multi = Object.fromEntries(Object.entries(s.multi || {}).map(([k, v]) => [k, new Set(v)]));
      f.range = JSON.parse(JSON.stringify(s.range || {}));
      f.category = s.category || '';
      f.text = s.text || '';
    }
    IDMT.emit('filters');
  }
  function remove(i) { all().splice(i, 1); persist(); }
  function replaceAll(entries) { cache = entries; persist(); }
  return { all, saveList, saveSearch, apply, remove, replaceAll };
})();

/* ---------------- team file: multi-user via the repo ----------------
   data/team.json carries shared notes, field edits, and saved lists. It loads at
   boot as the team baseline; this browser's own unsaved work layers on top. Export
   the file, commit it, and the whole team sees the same thing. */

IDMT.team = { edits: {}, lists: [], updatedAt: null };

IDMT.loadTeamFile = async function () {
  try {
    const res = await fetch((IDMT.config.data.team || 'data/team.json') + '?v=' + Date.now());
    if (!res.ok) return;
    const t = await res.json();
    IDMT.team = { edits: t.edits || {}, lists: t.lists || [], updatedAt: t.updatedAt || null };
    if (IDMT.team.lists.length && !IDMT.lists.all().length) IDMT.lists.replaceAll(IDMT.team.lists);
  } catch (e) { /* no team file yet — fine */ }
};

IDMT.exportTeamFile = function () {
  const payload = {
    updatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
    note: 'Shared team layer for the Internal Data Market Tracker. Commit to data/team.json.',
    edits: Object.assign({}, IDMT.team.edits, IDMT.edits.all()),
    lists: IDMT.lists.all(),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'team.json'; a.click();
  URL.revokeObjectURL(url);
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
    let value = null, n = 0;
    if (m.agg === 'count') {
      value = n = pool.filter((p) => String(p[m.col] ?? '') !== '').length;
    } else if (m.agg === 'countValue') {
      value = n = pool.filter((p) => String(p[m.col] ?? '').trim() === m.value).length;
    } else {
      const nums = pool.map((p) => num(p[m.col])).filter((x) => x !== null);
      n = nums.length;
      if (nums.length) {
        if (m.agg === 'sum') value = nums.reduce((a, b) => a + b, 0);
        else if (m.agg === 'avg') value = nums.reduce((a, b) => a + b, 0) / nums.length;
        else if (m.agg === 'max') value = Math.max(...nums);
      }
    }
    // Market Analytics reporting rules: summary stats need n ≥ 3; every stat carries its n
    const suppressed = m.agg === 'avg' && n > 0 && n < 3;
    const fmt = IDMT.fmt[m.fmt] || IDMT.fmt.int;
    return {
      label: m.label, n,
      suppressed,
      display: m.agg === 'count' || m.agg === 'countValue' ? IDMT.fmt.count(value ?? 0) : fmt(value),
    };
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
