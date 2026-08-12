/* detail.js — per-property drawer: image, headline stats, asset-type section, every
   workbook column, a notes pad, and an edit mode (image upload + manual field changes).
   Edits live in browser localStorage; "Download workbook" exports an .xlsx with the
   edits applied so you can commit it to data/properties.xlsx and make them permanent. */

IDMT.detail = (function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let editing = false;
  let currentId = null;

  function open(p, opts = {}) {
    currentId = p._id;
    editing = !!opts.edit;
    const f = IDMT.config.fields;
    const drawer = document.getElementById('detail-drawer');
    const el = document.getElementById('drawer-content');
    const color = IDMT.typeColors[p._type] || '#898781';

    const hero = p._image
      ? `<img class="detail-hero" src="${esc(p._image)}" alt="" onerror="this.outerHTML='<div class=\\'detail-hero-fallback\\'>▦</div>'" />`
      : `<div class="detail-hero-fallback">▦</div>`;

    const shownCols = new Set([f.name, f.address, f.type, f.size, f.occupancy, f.rent, f.image, f.lat, f.lng, 'Notes']);
    const typeCols = ((IDMT.config.schema && IDMT.config.schema.byType[p._type]) || []).map((d) => d.col);
    const typeColSet = new Set(typeCols);

    const rowHtml = (c) => editing
      ? `<tr><td>${esc(c)}</td><td><input class="edit-field" data-col="${esc(c)}" value="${esc(p[c] ?? '')}" /></td></tr>`
      : `<tr><td>${esc(c)}</td><td>${esc(p[c])}</td></tr>`;

    const keep = (c) => editing || String(p[c] ?? '') !== '';
    const typeRows = typeCols.filter(keep).map(rowHtml).join('');
    const rest = IDMT.columns
      .filter((c) => !shownCols.has(c) && !typeColSet.has(c) && keep(c))
      .map(rowHtml)
      .join('');

    el.innerHTML = `
      ${hero}
      <div class="detail-body">
        <div class="detail-name">${esc(p._name)}</div>
        <div class="detail-addr">${esc([p._address, p._city].filter(Boolean).join(', '))}</div>
        <span class="type-badge" style="border-color:${color}66;background:${color}22">
          <span style="color:${color}">●</span> ${esc(p._type)}${p._submarket ? ' · ' + esc(p._submarket) : ''}
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

        ${typeRows ? `<div class="detail-section-title" style="color:${color}">${esc(p._type)} details</div>
        <table class="detail-fields"><tbody>${typeRows}</tbody></table>` : ''}
        <div class="detail-section-title">Property record</div>
        <table class="detail-fields"><tbody>${rest}</tbody></table>
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
      const fileInput = document.getElementById('edit-image-file');
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

      document.getElementById('detail-save').addEventListener('click', () => {
        const changes = { 'Notes': document.getElementById('detail-notes').value };
        el.querySelectorAll('.edit-field').forEach((inp) => { changes[inp.dataset.col] = inp.value; });
        IDMT.saveEdits(p._id, changes);
        open(IDMT.getProperty(p._id), { edit: false });
      });
    }
  }

  function close() {
    document.getElementById('detail-drawer').classList.remove('open');
    editing = false;
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('drawer-close').addEventListener('click', close);
  });

  return { open, close };
})();
