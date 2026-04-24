// ══════════════════════════════════════════════════════════════════════════════
// VISIT HISTORY TAB — reads Scheduled_Visits via get_visit_history_v2
// Depends on: constants.js, api.js (apiGet), auth.js (_s, isAdmin, hasRole)
// Entry point: loadVisitHistoryTab()  — called by financial.js switchFinTab
// ══════════════════════════════════════════════════════════════════════════════

let _vhData       = [];   // raw visits from GAS, newest-first
let _vhFiltered   = [];   // after client-side filter/search
let _vhPage       = 1;
const VH_PAGE_SIZE = 25;

// Filter state — synced to the filter bar UI
let _vhDays       = '30';   // '7' | '30' | '90' | 'all'
let _vhTech       = '';
let _vhSvcType    = '';
let _vhSearch     = '';     // free-text (pool_id or customer name)

// ── Entry point ───────────────────────────────────────────────────────────────

async function loadVisitHistoryTab() {
  const tbody   = document.getElementById('vh-tbody');
  const thead   = document.getElementById('vh-thead');
  const loading = document.getElementById('fin-loading');

  if (loading) loading.style.display = 'block';
  if (tbody)   tbody.innerHTML = '';

  try {
    const params = { action: 'get_visit_history_v2', token: _s.token };
    if (_vhDays !== 'all') params.date_range = `last_${_vhDays}`;

    const res = await apiGet(params);
    if (!res.ok) throw new Error(res.error || 'Failed to load visit history');

    _vhData = res.visits || [];
    _vhPage = 1;
    _vhRenderFilters();
    _vhApplyAndRender();
  } catch (err) {
    console.error('loadVisitHistoryTab error:', err);
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--error)">Failed to load visit history: ${err.message}</td></tr>`;
  } finally {
    if (loading) loading.style.display = 'none';
  }
}

// ── Filters ───────────────────────────────────────────────────────────────────

function _vhRenderFilters() {
  const el = document.getElementById('vh-filters');
  if (!el) return;

  // Build unique technician list from data
  const techs = [...new Set(_vhData.map(v => v.technician).filter(Boolean))].sort();
  const svcs  = [...new Set(_vhData.map(v => v.service_type).filter(Boolean))].sort();

  el.innerHTML = `
    <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:flex-end;padding:.5rem 0 .75rem">
      <div style="display:flex;flex-direction:column;gap:.3rem">
        <label style="font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)">Date Range</label>
        <select class="si" style="min-width:130px" onchange="_vhDays=this.value;loadVisitHistoryTab()">
          <option value="7"  ${_vhDays==='7'  ?'selected':''}>Last 7 days</option>
          <option value="30" ${_vhDays==='30' ?'selected':''}>Last 30 days</option>
          <option value="90" ${_vhDays==='90' ?'selected':''}>Last 90 days</option>
          <option value="all"${_vhDays==='all'?'selected':''}>All time</option>
        </select>
      </div>
      ${techs.length > 1 ? `
      <div style="display:flex;flex-direction:column;gap:.3rem">
        <label style="font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)">Technician</label>
        <select class="si" style="min-width:160px" onchange="_vhTech=this.value;_vhPage=1;_vhApplyAndRender()">
          <option value="">All Techs</option>
          ${techs.map(t => `<option value="${t}" ${_vhTech===t?'selected':''}>${t}</option>`).join('')}
        </select>
      </div>` : ''}
      ${svcs.length > 1 ? `
      <div style="display:flex;flex-direction:column;gap:.3rem">
        <label style="font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)">Service Type</label>
        <select class="si" style="min-width:180px" onchange="_vhSvcType=this.value;_vhPage=1;_vhApplyAndRender()">
          <option value="">All Services</option>
          ${svcs.map(s => `<option value="${s}" ${_vhSvcType===s?'selected':''}>${s}</option>`).join('')}
        </select>
      </div>` : ''}
      <div style="display:flex;flex-direction:column;gap:.3rem">
        <label style="font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)">Search</label>
        <input class="si" type="text" placeholder="Pool ID or customer…" style="min-width:180px"
          value="${_vhSearch.replace(/"/g,'&quot;')}"
          oninput="_vhSearch=this.value;_vhPage=1;_vhApplyAndRender()">
      </div>
      <div style="margin-left:auto;align-self:flex-end">
        <button class="mvt-btn" onclick="_vhSearch='';_vhTech='';_vhSvcType='';_vhPage=1;loadVisitHistoryTab()">↻ Refresh</button>
      </div>
    </div>`;
}

// ── Apply filters + render ────────────────────────────────────────────────────

function _vhApplyAndRender() {
  const q = _vhSearch.trim().toLowerCase();

  _vhFiltered = _vhData.filter(v => {
    if (_vhTech    && v.technician  !== _vhTech)    return false;
    if (_vhSvcType && v.service_type !== _vhSvcType) return false;
    if (q) {
      const haystack = `${v.pool_id} ${v.customer_name}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  _vhRenderStats();
  _vhRenderTable();
  _vhRenderPagination();
}

// ── Stats bar ─────────────────────────────────────────────────────────────────

function _vhRenderStats() {
  const el = document.getElementById('vh-stats');
  if (!el) return;
  const total = _vhFiltered.length;
  const completed = _vhFiltered.filter(v => v.status === 'completed').length;
  el.innerHTML = `
    <div style="display:flex;gap:1.5rem;flex-wrap:wrap;padding:.25rem 0 .5rem;font-size:.82rem;color:var(--muted)">
      <span><strong style="color:var(--text)">${total}</strong> visits</span>
      <span><strong style="color:var(--text)">${completed}</strong> completed</span>
    </div>`;
}

// ── Table ─────────────────────────────────────────────────────────────────────

function _vhRenderTable() {
  const thead = document.getElementById('vh-thead');
  const tbody = document.getElementById('vh-tbody');
  if (!thead || !tbody) return;

  thead.innerHTML = `
    <tr>
      <th>Date</th>
      <th>Pool ID</th>
      <th>Customer</th>
      <th>Technician</th>
      <th>Service Type</th>
      <th>Status</th>
      <th></th>
    </tr>`;

  const start = (_vhPage - 1) * VH_PAGE_SIZE;
  const page  = _vhFiltered.slice(start, start + VH_PAGE_SIZE);

  if (!page.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--muted)">No visits found.</td></tr>`;
    return;
  }

  tbody.innerHTML = page.map(v => {
    const dateStr = v.date ? _vhFmtDate(v.date) : '—';
    const statusBadge = _vhStatusBadge(v.status);
    const viewBtn = v.chem_log_ref
      ? `<button class="mvt-btn" style="font-size:.75rem;padding:.25rem .6rem"
           onclick="_vhOpenLog('${_vhEsc(v.pool_id)}')">View Log</button>`
      : `<span style="color:var(--muted);font-size:.75rem">—</span>`;

    return `<tr>
      <td style="white-space:nowrap">${dateStr}</td>
      <td style="font-family:monospace;font-size:.82rem">${_vhEsc(v.pool_id)}</td>
      <td>${_vhEsc(v.customer_name) || '<span style="color:var(--muted)">—</span>'}</td>
      <td>${_vhEsc(v.technician) || '<span style="color:var(--muted)">—</span>'}</td>
      <td>${_vhEsc(v.service_type)}</td>
      <td>${statusBadge}</td>
      <td style="text-align:right">${viewBtn}</td>
    </tr>`;
  }).join('');
}

// ── Pagination ────────────────────────────────────────────────────────────────

function _vhRenderPagination() {
  const el = document.getElementById('vh-pagination');
  if (!el) return;
  const total = _vhFiltered.length;
  const pages = Math.ceil(total / VH_PAGE_SIZE);
  if (pages <= 1) { el.innerHTML = ''; return; }

  const btns = [];
  for (let p = 1; p <= pages; p++) {
    btns.push(`<button class="mvt-btn${p === _vhPage ? ' active' : ''}"
      style="min-width:2rem;padding:.25rem .5rem"
      onclick="_vhPage=${p};_vhRenderTable();_vhRenderPagination()">${p}</button>`);
  }
  el.innerHTML = `<div style="display:flex;gap:.4rem;flex-wrap:wrap">${btns.join('')}</div>`;
}

// ── Actions ───────────────────────────────────────────────────────────────────

function _vhOpenLog(poolId) {
  if (!poolId) return;
  window._pendingSvcPoolId = poolId;
  navigateTo('service_log');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _vhFmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
    + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function _vhStatusBadge(status) {
  const s = (status || '').toLowerCase();
  const color = s === 'completed' ? '#2d7a4f' : s === 'pending' ? '#b07d00' : '#555';
  const bg    = s === 'completed' ? '#e6f4ec'  : s === 'pending' ? '#fff8e0'  : '#f0f0f0';
  return `<span style="display:inline-block;padding:.15rem .5rem;border-radius:999px;font-size:.72rem;font-weight:600;background:${bg};color:${color}">${_vhEsc(status || '—')}</span>`;
}

function _vhEsc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
