// ══════════════════════════════════════════════════════════════════════════════
// SCOPE OF WORK LIBRARY — admin management
//
// Depends on: api.js (api), auth.js (_s), constants.js (escHtml, SCOPE_LIBRARY_FALLBACK)
//
// The quote tool reads this library (qLoadScopeLibrary in quotes.js) and the
// resolved per-quote scope is snapshotted onto the agreement at signature. This
// screen is the only place the library itself can be edited — before it existed
// the save_scope_library_item action had no caller at all, so items could be read
// but never created, retired or reordered.
//
// Archived items are shown on request rather than hidden forever: deactivating an
// item without a way back would make it unrecoverable from the UI.
// ══════════════════════════════════════════════════════════════════════════════

const SL_SERVICE_TYPES = [
  { key: 'weekly',  label: 'Weekly' },
  { key: 'startup', label: 'Pool Startup' },
  { key: 'g2c',     label: 'Green-to-Clean' },
  { key: 'repair',  label: 'Repair' }
];

let _slItems = [];
let _slShowArchived = false;
let _slEditing = null;   // scope_item_id being edited, '' for a new item, null for none

function loadScopeLibrary(force) {
  const list = document.getElementById('sl-list');
  if (!list) return;
  if (!_slItems.length) {
    list.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1.5rem;font-size:.85rem">Loading scope library…</div>';
  }
  api({ action: 'get_scope_library', token: _s ? _s.token : '', include_inactive: true })
    .then(res => {
      if (!res || !res.ok) {
        list.innerHTML = `<div class="im err" style="display:block">${escHtml((res && res.error) || 'Could not load the scope library.')}</div>`;
        return;
      }
      _slItems = res.items || [];
      renderScopeLibrary();
    })
    .catch(() => {
      list.innerHTML = '<div class="im err" style="display:block">Network error loading the scope library.</div>';
    });
}

function slToggleArchived() {
  _slShowArchived = !_slShowArchived;
  const btn = document.getElementById('sl-archived-btn');
  if (btn) btn.textContent = _slShowArchived ? 'Hide Archived' : 'Show Archived';
  renderScopeLibrary();
}

function slTypeLabel(key) {
  const m = SL_SERVICE_TYPES.find(t => t.key === key);
  return m ? m.label : key;
}

function renderScopeLibrary() {
  const list = document.getElementById('sl-list');
  if (!list) return;

  const shown = _slItems.filter(i => _slShowArchived || i.active !== false);
  if (!shown.length) {
    list.innerHTML = `<div style="color:var(--muted);text-align:center;padding:1.5rem;font-size:.85rem">
      ${_slItems.length ? 'No items match this view.' :
        'No library items yet — the quote tool is using the built-in defaults. Add one to override them.'}
    </div>`;
    return;
  }

  // Grouped by service type so the list reads the way the quote tool presents it.
  let html = '';
  SL_SERVICE_TYPES.forEach(t => {
    const inType = shown.filter(i => (i.service_types || []).includes(t.key))
                        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    if (!inType.length) return;
    html += `<div class="sl-group"><div class="sl-group-h">${escHtml(t.label)}</div>`;
    html += inType.map(i => slRow(i)).join('');
    html += '</div>';
  });

  // Items with no service type would otherwise never appear anywhere.
  const orphans = shown.filter(i => !(i.service_types || []).length);
  if (orphans.length) {
    html += `<div class="sl-group"><div class="sl-group-h" style="color:var(--error)">No service type — not offered anywhere</div>`;
    html += orphans.map(i => slRow(i)).join('');
    html += '</div>';
  }

  list.innerHTML = html;
}

function slRow(i) {
  const archived = i.active === false;
  const id = String(i.scope_item_id || '');   // raw — jsArg() escapes at the call site
  return `<div class="sl-row${archived ? ' sl-archived' : ''}">
    <div class="sl-main">
      <div class="sl-label">${escHtml(i.label)}${archived ? ' <span class="sl-tag">Archived</span>' : ''}</div>
      <div class="sl-meta">
        ${i.default_on ? '<span class="sl-tag sl-on">Default</span>' : '<span class="sl-tag">Opt-in</span>'}
        <span class="sl-ord">Order ${Number(i.sort_order || 0)}</span>
        <span class="sl-types">${(i.service_types || []).map(t => escHtml(slTypeLabel(t))).join(' · ') || '—'}</span>
      </div>
    </div>
    <div class="sl-actions">
      <button class="sl-btn" onclick="slEditItem(${jsArg(id)})">Edit</button>
      <button class="sl-btn" onclick="slSetActive(${jsArg(id)}, ${archived ? 'true' : 'false'})">
        ${archived ? 'Restore' : 'Archive'}
      </button>
    </div>
  </div>`;
}

// ── Editor ───────────────────────────────────────────────────────────────────
function slNewItem() { slOpenEditor(null); }

function slEditItem(id) {
  const item = _slItems.find(i => i.scope_item_id === id);
  if (item) slOpenEditor(item);
}

function slOpenEditor(item) {
  const box = document.getElementById('sl-editor');
  if (!box) return;
  _slEditing = item ? item.scope_item_id : '';
  const types = item ? (item.service_types || []) : [];

  box.style.display = 'block';
  box.innerHTML = `
    <div class="sl-edit">
      <div class="sl-edit-h">${item ? 'Edit item' : 'New scope item'}</div>
      <label class="sl-fld" for="sl-label">Label — exactly as the customer will read it</label>
      <input class="sl-input" id="sl-label" type="text" maxlength="120"
             value="${item ? escHtml(item.label) : ''}" placeholder="e.g. Filter cleaning and inspection">
      <label class="sl-fld">Offered on</label>
      <div class="sl-types-pick">
        ${SL_SERVICE_TYPES.map(t => `
          <label class="sl-chk">
            <input type="checkbox" class="sl-type" value="${t.key}" ${types.includes(t.key) ? 'checked' : ''}>
            <span>${escHtml(t.label)}</span>
          </label>`).join('')}
      </div>
      <div class="sl-edit-row">
        <div>
          <label class="sl-fld" for="sl-order">Order</label>
          <input class="sl-input" id="sl-order" type="number" min="0" step="10"
                 value="${item ? Number(item.sort_order || 0) : 100}">
        </div>
        <label class="sl-chk sl-chk-block">
          <input type="checkbox" id="sl-default" ${!item || item.default_on ? 'checked' : ''}>
          <span>Ticked by default on new quotes</span>
        </label>
      </div>
      <div class="sl-edit-msg" id="sl-msg"></div>
      <div class="sl-edit-actions">
        <button class="adm-new-btn" onclick="slSaveItem()" id="sl-save-btn">${item ? 'Save changes' : 'Add item'}</button>
        <button class="sl-btn" onclick="slCloseEditor()">Cancel</button>
      </div>
    </div>`;
  const input = document.getElementById('sl-label');
  if (input) input.focus();
}

function slCloseEditor() {
  const box = document.getElementById('sl-editor');
  _slEditing = null;
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
}

function slMsg(text, isErr) {
  const el = document.getElementById('sl-msg');
  if (!el) return;
  el.textContent = text;
  el.className = 'sl-edit-msg' + (isErr ? ' err' : '');
  el.style.display = 'block';
}

function slSaveItem() {
  const label = (document.getElementById('sl-label').value || '').trim();
  if (!label) { slMsg('Give the item a label.', true); return; }

  const types = Array.from(document.querySelectorAll('.sl-type:checked')).map(c => c.value);
  if (!types.length) {
    // Saving with none would create an item that appears on no quote at all.
    slMsg('Pick at least one service type, or this item will never be offered.', true);
    return;
  }

  const btn = document.getElementById('sl-save-btn');
  if (btn) btn.disabled = true;
  slMsg('Saving…', false);

  const payload = {
    action: 'save_scope_library_item',
    token: _s ? _s.token : '',
    label: label,
    service_types: types,
    default_on: document.getElementById('sl-default').checked,
    sort_order: Number(document.getElementById('sl-order').value || 100)
  };
  if (_slEditing) payload.scope_item_id = _slEditing;

  api(payload)
    .then(res => {
      if (btn) btn.disabled = false;
      if (!res || !res.ok) { slMsg((res && res.error) || 'Could not save.', true); return; }
      slCloseEditor();
      _slInvalidateQuoteToolCache();
      loadScopeLibrary(true);
    })
    .catch(() => { if (btn) btn.disabled = false; slMsg('Network error saving the item.', true); });
}

function slSetActive(id, makeActive) {
  const item = _slItems.find(i => i.scope_item_id === id);
  if (!item) return;
  if (!makeActive && !confirm(`Archive "${item.label}"?\n\nIt stops being offered on new quotes. Agreements already signed are unaffected.`)) return;

  api({ action: 'save_scope_library_item', token: _s ? _s.token : '',
        scope_item_id: id, active: !!makeActive })
    .then(res => {
      if (!res || !res.ok) { alert('Could not update: ' + ((res && res.error) || 'unknown error')); return; }
      _slInvalidateQuoteToolCache();
      loadScopeLibrary(true);
    })
    .catch(() => alert('Network error updating the item.'));
}

// The quote tool caches the library in localStorage for 24h (qLoadScopeLibrary).
// Without this, an admin edit would not reach the quote builder until tomorrow.
function _slInvalidateQuoteToolCache() {
  try { localStorage.removeItem('mcps_q_scope_library'); } catch (e) {}
  if (typeof _qScopeLibrary !== 'undefined') {
    try { _qScopeLibrary = _slItems.filter(i => i.active !== false); } catch (e) {}
  }
}
