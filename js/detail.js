/* detail.js — the property page. Categories mirror Property_Data_Schema.xlsx:
   every category renders on every property — fields without a value show "No data"
   (they're part of the preset, ready for the live workbook). Edit mode covers every
   field; ＋ Add creates a new property (map-pick location). Edits/adds live in the
   browser until the workbook is exported and committed. */

IDMT.detail = (function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let editing = false;
  let creating = false;
  let currentId = null;

  const MONEY = /\$|Price|Amount|Budget|Spent|Basis|Value|Taxes/;

  function fmtVal(col, v) {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const n = typeof v === 'number' ? v : null;
    if (n !== null && MONEY.test(col)) return '$' + Math.round(n).toLocaleString('en-US');
    if (n !== null && Math.abs(n) >= 10000) return n.toLocaleString('en-US');
    return String(v);
  }

  /* category -> fields, from config + an asset-specific add-on per property type */
  function categories(p) {
    const tmpl = IDMT.config.propertyTemplate || {};
    const cats = Object.entries(tmpl).map(([name, cols]) => ({ name, cols: [...cols] }));
    const covered = new Set(cats.flatMap((c) => c.cols));
    const typeCols = ((IDMT.config.schema && IDMT.config.schema.byType[p._type]) || [])
      .map((d) => d.col).filter((c) => !covered.has(c));
    if (typeCols.length) cats.push({ name: p._type + ' — Specific', cols: typeCols });
    typeCols.forEach((c) => covered.add(c));
    // anything else in the workbook that the template doesn't cover —
    // but not OTHER asset types' specific fields (a multifamily page shouldn't list dock doors)
    const f = IDMT.config.fields;
    const otherTypeCols = Object.entries(IDMT.config.schema.byType || {})
      .filter(([t]) => t !== p._type)
      .flatMap(([, defs]) => defs.map((d) => d.col));
    const hidden = new Set([f.id, f.name, f.lat, f.lng, f.image, 'Notes', ...covered, ...otherTypeCols]);
    const rest = IDMT.columns.filter((c) => !hidden.has(c));
    if (rest.length) cats.push({ name: 'Other Fields', cols: rest });
    return cats;
  }

  function fieldRow(p, col) {
    if (editing) {
      return `<tr><td>${esc(col)}</td><td><input class="edit-field" data-col="${esc(col)}" value="${esc(p[col] ?? '')}" /></td></tr>`;
    }
    const val = fmtVal(col, p[col]);
    return `<tr><td>${esc(col)}</td><td class="${val === null ? 'nodata' : ''}">${val === null ? 'No data' : esc(val)}</td></tr>`;
  }

  function catSection(p, cat, openByDefault) {
    const filled = cat.cols.filter((c) => String(p[c] ?? '').trim() !== '').length;
    return `<details class="detail-cat" ${openByDefault || editing ? 'open' : ''}>
      <summary>${esc(cat.name)}<span class="cat-n">${filled}/${cat.cols.length}</span></summary>
      <table class="detail-fields"><tbody>${cat.cols.map((c) => fieldRow(p, c)).join('')}</tbody></table>
    </details>`;
  }

  function open(p, opts = {}) {
    creating = false;
    currentId = p._id;
    editing = !!opts.edit;
    const f = IDMT.config.fields;
    const drawer = document.getElementById('detail-drawer');
    const el = document.getElementById('drawer-content');
    const color = IDMT.typeColors[p._type] || '#898781';

    const hero = p._image
      ? `<img class="detail-hero" src="${esc(p._image)}" alt="" onerror="this.outerHTML='<div class=\\'detail-hero-fallback\\'>▦</div>'" />`
      : `<div class="detail-hero-fallback">▦</div>`;

    const cats = categories(p);
    el.innerHTML = `
      ${hero}
      <div class="detail-body">
        <div class="detail-name">${esc(p._name)}</div>
        <div class="detail-addr">${esc([p._address, p._city].filter(Boolean).join(', '))}</div>
        <span class="type-badge" style="border-color:${color}66;background:${color}22">
          <span style="color:${color}">●</span> ${esc(p._type)}${p._submarket ? ' · ' + esc(p._submarket) + ' Submarket' : ''}
        </span>
        <div class="detail-actions top">
          <button class="btn-ghost sm" id="detail-edit">${editing ? 'Cancel' : '✎ Edit'}</button>
          ${editing ? '<button class="btn-primary sm" id="detail-save">Save changes</button>' : ''}
          <button class="btn-ghost sm" id="detail-export" title="Download an .xlsx with all local edits applied — commit it to data/properties.xlsx">⬇ Workbook</button>
        </div>
        ${editing ? `
        <div class="edit-hint">Changes save to <b>this browser</b>. To make them permanent, click <b>⬇ Workbook</b> and commit the file to <code>data/properties.xlsx</code>.</div>
        <div class="edit-image-row">
          <label class="btn-ghost sm upload-label">📷 Upload image<input type="file" id="edit-image-file" accept="image/*" hidden /></label>
          <input class="edit-field" id="edit-image-url" data-col="${esc(f.image)}" placeholder="…or paste an image URL" value="${esc(p[f.image] ?? '')}" />
        </div>` : ''}
        <div class="stat-grid">
          <div class="stat-tile"><div class="k">Building size</div><div class="v">${IDMT.fmt.sf(p._size)}</div></div>
          <div class="stat-tile"><div class="k">Occupancy</div><div class="v">${IDMT.fmt.pct(p._occ)}</div></div>
          <div class="stat-tile"><div class="k">Asking rent</div><div class="v">${p._rent === null ? '—' : IDMT.fmt.usd(p._rent) + '/SF'}</div></div>
          <div class="stat-tile"><div class="k">Submarket</div><div class="v" style="font-size:13px">${esc(p._submarket || '—')}</div></div>
        </div>

        <div class="detail-section-title">Notes</div>
        <textarea class="notes-pad" id="detail-notes" placeholder="Property notes… (saved locally; export the workbook to keep them)">${esc(p['Notes'] ?? '')}</textarea>
        <button class="btn-ghost sm" id="notes-save">Save note</button>
        <span class="notes-status" id="notes-status"></span>

        <div class="detail-section-title">Property record</div>
        ${cats.map((c, i) => catSection(p, c, i < 2)).join('')}
        <div class="detail-actions">
          <button class="btn-primary" id="detail-zoom">Zoom to property</button>
        </div>
      </div>`;
    drawer.classList.add('open');

    document.getElementById('detail-zoom').addEventListener('click', () => IDMT.map.focusProperty(p._id));
    document.getElementById('detail-export').addEventListener('click', () => IDMT.exportWorkbook());
    document.getElementById('detail-edit').addEventListener('click', () => {
      open(IDMT.getProperty(currentId) || p, { edit: !editing });
    });

    document.getElementById('notes-save').addEventListener('click', () => {
      IDMT.saveEdits(p._id, { 'Notes': document.getElementById('detail-notes').value });
      document.getElementById('notes-status').textContent = 'saved locally ✓';
      setTimeout(() => { const s = document.getElementById('notes-status'); if (s) s.textContent = ''; }, 2500);
    });

    if (editing) {
      wireImageUpload(el);
      document.getElementById('detail-save').addEventListener('click', () => {
        const changes = { 'Notes': document.getElementById('detail-notes').value };
        el.querySelectorAll('.edit-field').forEach((inp) => { if (inp.dataset.col) changes[inp.dataset.col] = inp.value; });
        IDMT.saveEdits(p._id, changes);
        open(IDMT.getProperty(p._id), { edit: false });
      });
    }
  }

  /* ---------- new property ---------- */

  function openNew() {
    creating = true;
    editing = true;
    const f = IDMT.config.fields;
    const drawer = document.getElementById('detail-drawer');
    const el = document.getElementById('drawer-content');
    const blank = {};
    const cats = categories(Object.assign({ _type: 'Office' }, blank));

    el.innerHTML = `
      <div class="detail-hero-fallback">＋</div>
      <div class="detail-body">
        <div class="detail-name">New property</div>
        <div class="detail-addr">Fill in what you know — everything can be edited later. Saved to this browser until you export the workbook.</div>
        <div class="detail-section-title">Identity</div>
        <table class="detail-fields"><tbody>
          <tr><td>Property Name *</td><td><input class="edit-field" id="new-name" data-col="${esc(f.name)}" /></td></tr>
          <tr><td>Property Type *</td><td><select class="edit-field" id="new-type" data-col="${esc(f.type)}">
            ${(IDMT.config.typeOrder || []).map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
          </select></td></tr>
          <tr><td>Latitude *</td><td><input class="edit-field" id="new-lat" data-col="${esc(f.lat)}" placeholder="44.97…" /></td></tr>
          <tr><td>Longitude *</td><td><input class="edit-field" id="new-lng" data-col="${esc(f.lng)}" placeholder="-93.27…" /></td></tr>
        </tbody></table>
        <button class="btn-ghost sm" id="new-pick">📍 Pick location on the map</button>
        <span class="notes-status" id="pick-status"></span>
        <div class="detail-section-title">Property record</div>
        ${cats.filter((c) => c.name !== 'Other Fields').map((c) => catSection(blank, c, false)).join('')}
        <div class="detail-actions">
          <button class="btn-primary" id="new-save">Create property</button>
        </div>
      </div>`;
    drawer.classList.add('open');

    document.getElementById('new-pick').addEventListener('click', () => {
      document.getElementById('pick-status').textContent = 'click the map…';
      IDMT.map.pickLocation((lngLat) => {
        const latEl = document.getElementById('new-lat'), lngEl = document.getElementById('new-lng');
        if (latEl) latEl.value = lngLat.lat.toFixed(6);
        if (lngEl) lngEl.value = lngLat.lng.toFixed(6);
        const s = document.getElementById('pick-status');
        if (s) s.textContent = 'location set ✓';
      });
    });

    document.getElementById('new-save').addEventListener('click', () => {
      const name = document.getElementById('new-name').value.trim();
      const lat = parseFloat(document.getElementById('new-lat').value);
      const lng = parseFloat(document.getElementById('new-lng').value);
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        alert('A property needs at least a name and a location (use 📍 Pick location).');
        return;
      }
      const changes = {};
      el.querySelectorAll('.edit-field').forEach((inp) => {
        if (inp.dataset.col && String(inp.value).trim() !== '') changes[inp.dataset.col] = inp.value;
      });
      const id = IDMT.createProperty(changes);
      creating = false;
      editing = false;
      IDMT.map.focusProperty(id);
    });
  }

  function wireImageUpload(el) {
    const fileInput = document.getElementById('edit-image-file');
    if (!fileInput) return;
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (file.size > 900 * 1024) {
        alert('Image is over ~900KB — browser storage is limited. Please resize it, or commit the image to the repo assets/ folder and paste its path instead.');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => { document.getElementById('edit-image-url').value = reader.result; };
      reader.readAsDataURL(file);
    });
  }

  function close() {
    document.getElementById('detail-drawer').classList.remove('open');
    editing = false;
    creating = false;
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('drawer-close').addEventListener('click', close);
  });

  return { open, openNew, close };
})();
