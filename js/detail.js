/* detail.js — per-property drawer: image, headline stats, and every column from the workbook. */

IDMT.detail = (function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function open(p) {
    const f = IDMT.config.fields;
    const drawer = document.getElementById('detail-drawer');
    const el = document.getElementById('drawer-content');
    const color = IDMT.typeColors[p._type] || '#898781';

    const hero = p._image
      ? `<img class="detail-hero" src="${esc(p._image)}" alt="" onerror="this.outerHTML='<div class=\\'detail-hero-fallback\\'>▦</div>'" />`
      : `<div class="detail-hero-fallback">▦</div>`;

    // Every workbook column, minus the ones already shown as headline stats.
    // Asset-type-specific columns (from config schema) get their own section.
    const shownCols = new Set([f.name, f.address, f.type, f.size, f.occupancy, f.rent, f.image, f.lat, f.lng]);
    const typeCols = ((IDMT.config.schema && IDMT.config.schema.byType[p._type]) || []).map((d) => d.col);
    const typeColSet = new Set(typeCols);
    const rowHtml = (c) => `<tr><td>${esc(c)}</td><td>${esc(p[c])}</td></tr>`;
    const typeRows = typeCols.filter((c) => String(p[c] ?? '') !== '').map(rowHtml).join('');
    const rest = IDMT.columns
      .filter((c) => !shownCols.has(c) && !typeColSet.has(c) && String(p[c] ?? '') !== '')
      .map(rowHtml)
      .join('');
    const typeSection = typeRows
      ? `<div class="detail-section-title" style="color:${color}">${esc(p._type)} details</div>
         <table class="detail-fields"><tbody>${typeRows}</tbody></table>
         <div class="detail-section-title">Property record</div>`
      : '';

    el.innerHTML = `
      ${hero}
      <div class="detail-body">
        <div class="detail-name">${esc(p._name)}</div>
        <div class="detail-addr">${esc([p._address, p._city].filter(Boolean).join(', '))}</div>
        <span class="type-badge" style="border-color:${color}66;background:${color}22">
          <span style="color:${color}">●</span> ${esc(p._type)}${p._submarket ? ' · ' + esc(p._submarket) : ''}
        </span>
        <div class="stat-grid">
          <div class="stat-tile"><div class="k">Building size</div><div class="v">${IDMT.fmt.sf(p._size)}</div></div>
          <div class="stat-tile"><div class="k">Occupancy</div><div class="v">${IDMT.fmt.pct(p._occ)}</div></div>
          <div class="stat-tile"><div class="k">Asking rent</div><div class="v">${p._rent === null ? '—' : IDMT.fmt.usd(p._rent) + '/SF'}</div></div>
          <div class="stat-tile"><div class="k">Submarket</div><div class="v" style="font-size:13px">${esc(p._submarket || '—')}</div></div>
        </div>
        ${typeSection}
        <table class="detail-fields"><tbody>${rest}</tbody></table>
        <div class="detail-actions">
          <button class="btn-primary" id="detail-zoom">Zoom to property</button>
        </div>
      </div>`;
    drawer.classList.add('open');
    document.getElementById('detail-zoom').addEventListener('click', () => IDMT.map.focusProperty(p._id));
  }

  function close() {
    document.getElementById('detail-drawer').classList.remove('open');
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('drawer-close').addEventListener('click', close);
  });

  return { open, close };
})();
