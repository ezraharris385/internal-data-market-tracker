/* search.js — Google-style autocomplete over the uploaded data (properties, addresses, submarkets). */

IDMT.search = (function () {
  let index = [];
  let hovered = -1;
  let results = [];

  function build() {
    index = [];
    for (const p of IDMT.properties) {
      index.push({
        kind: 'Property', label: p._name,
        sub: [p._address, p._city].filter(Boolean).join(', '),
        text: (p._name + ' ' + p._address + ' ' + p._city + ' ' + p._id).toLowerCase(),
        color: IDMT.typeColors[p._type] || '#898781',
        action: () => { IDMT.map.focusProperty(p._id); },
      });
    }
    if (IDMT.submarkets) {
      const names = [...new Set(IDMT.submarkets.features.map(IDMT.featureName))];
      for (const name of names) {
        index.push({
          kind: 'Submarket', label: name, sub: 'Submarket boundary',
          text: name.toLowerCase(), color: '#9085e9', square: true,
          action: () => { IDMT.map.focusSubmarket(name); },
        });
      }
    }
  }

  function query(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const starts = [], contains = [];
    for (const item of index) {
      const pos = item.text.indexOf(q);
      if (pos === -1) continue;
      (item.label.toLowerCase().startsWith(q) || pos === 0 ? starts : contains).push(item);
      if (starts.length + contains.length > 60) break;
    }
    return [...starts, ...contains].slice(0, 8);
  }

  function highlight(label, q) {
    const i = label.toLowerCase().indexOf(q.toLowerCase());
    if (i === -1) return escapeHtml(label);
    return escapeHtml(label.slice(0, i)) + '<b>' + escapeHtml(label.slice(i, i + q.length)) + '</b>' + escapeHtml(label.slice(i + q.length));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function render(q) {
    const box = document.getElementById('search-suggestions');
    results = query(q);
    hovered = -1;
    if (!results.length) { box.classList.remove('open'); box.innerHTML = ''; return; }
    box.innerHTML = results.map((r, i) => `
      <div class="suggestion" data-i="${i}">
        <span class="s-icon ${r.square ? 'submarket' : ''}" style="background:${r.color}"></span>
        <span class="s-label">${highlight(r.label, q)}${r.sub ? ' <span style="color:var(--text-muted)">· ' + escapeHtml(r.sub) + '</span>' : ''}</span>
        <span class="s-kind">${r.kind}</span>
      </div>`).join('');
    box.classList.add('open');
    box.querySelectorAll('.suggestion').forEach((el) => {
      el.addEventListener('mousedown', (e) => { e.preventDefault(); pick(parseInt(el.dataset.i, 10)); });
    });
  }

  function pick(i) {
    const r = results[i];
    if (!r) return;
    const input = document.getElementById('search-input');
    input.value = r.label;
    close();
    r.action();
  }

  function close() {
    const box = document.getElementById('search-suggestions');
    box.classList.remove('open');
    box.innerHTML = '';
    results = [];
    hovered = -1;
  }

  function setHovered(i) {
    const box = document.getElementById('search-suggestions');
    hovered = i;
    box.querySelectorAll('.suggestion').forEach((el, j) => el.classList.toggle('hovered', j === i));
  }

  function attach() {
    const input = document.getElementById('search-input');
    const boxWrap = document.querySelector('.search-box');
    const clear = document.getElementById('search-clear');

    input.addEventListener('input', () => {
      boxWrap.classList.toggle('has-text', !!input.value);
      render(input.value);
    });
    input.addEventListener('focus', () => { if (input.value) render(input.value); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHovered(Math.min(hovered + 1, results.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setHovered(Math.max(hovered - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(hovered >= 0 ? hovered : 0); }
      else if (e.key === 'Escape') { close(); input.blur(); }
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    clear.addEventListener('click', () => {
      input.value = '';
      boxWrap.classList.remove('has-text');
      close();
      input.focus();
    });
  }

  return { build, attach };
})();
