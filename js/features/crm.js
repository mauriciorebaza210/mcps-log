// ══════════════════════════════════════════════════════════════════════════════
// SALES HUB (CRM) — lead pipeline, import leads, weekly goal speedometer
// Depends on: constants.js (SEC), api.js (api, apiGet), auth.js (isAdmin)
// Uses globals: _s, _crmCache, _crmFiltered, _crmPage, _activeLeadId
// ══════════════════════════════════════════════════════════════════════════════
// SALES HUB (CRM)
// ══════════════════════════════════════════════════════════════════════════════
let _crmCache = [];
let _crmFiltered = [];
let _crmPage = 1;
const CRM_PAGE_SIZE = 10;

function _applyPendingCrmFilter_() {
  if (!window._pendingCrmFilter) return;
  const f = window._pendingCrmFilter;
  window._pendingCrmFilter = null;
  const statusEl = document.getElementById('crm-filter-status');
  const contractEl = document.getElementById('crm-filter-contract');
  if (statusEl && f.status) statusEl.value = f.status;
  if (contractEl && f.contractStatus) contractEl.value = f.contractStatus;
  filterCRM();
}

async function loadCRM() {
  const loading = document.getElementById('crm-loading');
  const tbody = document.getElementById('crm-tbody');
  const quoteBtn = document.getElementById('crm-new-quote-btn');
  const importBtn = document.getElementById('crm-import-btn');

  if (quoteBtn) quoteBtn.style.display = isAdmin() ? 'block' : 'none';
  if (importBtn) importBtn.style.display = isAdmin() ? 'block' : 'none';

  loadWeeklyGoal();

  const cachedCrm = _appCacheGet('crm_data', 15 * 60 * 1000);
  if (cachedCrm) {
    _crmCache = cachedCrm;
    renderCRM(_crmCache, true);
    renderCRMStats();
    populateYearFilter();
    _applyPendingCrmFilter_();
    if (window._pendingAlertQuoteId) {
      const pending = window._pendingAlertQuoteId;
      window._pendingAlertQuoteId = null;
      viewCRMDetail(pending);
    }
  } else {
    if (loading) loading.style.display = 'block';
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--muted)">Loading pipeline data...</td></tr>';
  }

  try {
    const res = await apiGet({ action: 'get_crm_data', token: _s.token });
    if (res.ok) {
      if (!cachedCrm || JSON.stringify(cachedCrm) !== JSON.stringify(res.data)) {
        _crmCache = res.data || [];
        _appCacheSet('crm_data', _crmCache);
        renderCRM(_crmCache, true);
        renderCRMStats();
        populateYearFilter();
        if (!cachedCrm) _applyPendingCrmFilter_();
        if (!cachedCrm && window._pendingAlertQuoteId) {
          const pending = window._pendingAlertQuoteId;
          window._pendingAlertQuoteId = null;
          viewCRMDetail(pending);
        }
      }
    } else if (!cachedCrm) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--error)">Error: ${res.error || 'Failed to load data.'}</td></tr>`;
    }
  } catch (e) {
    if (!cachedCrm && tbody) tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--error)">Network error. Please try again.</td></tr>`;
  } finally {
    if (loading) loading.style.display = 'none';
  }
}

function renderCRM(data, resetPage = true) {
  if (resetPage) _crmPage = 1;
  _crmFiltered = data;

  const tbody = document.getElementById('crm-tbody');
  if (!tbody) return;

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--muted)">No records match this filter.</td></tr>';
    renderCRMPagination();
    return;
  }

  const start = (_crmPage - 1) * CRM_PAGE_SIZE;
  const page = data.slice(start, start + CRM_PAGE_SIZE);

  tbody.innerHTML = page.map(item => {
    const ts = item.timestamp ? new Date(item.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' }) : '—';
    const status = (item.status || 'UNSENT').toUpperCase();
    const client = `${item.first_name || ''} ${item.last_name || ''}`.trim() || (item.client_name || '—');
    const total = typeof item.total_with_tax === 'number' ? `$${item.total_with_tax.toFixed(2)}` : (item.total_with_tax || '—');
    const area = item.area ? `<span class="crm-area-badge">${item.area.toUpperCase()}</span>` : '';

    let statusClass = 'sc-unsent';
    if (status === 'SIGNED' || status === 'COMPLETED') statusClass = 'sc-signed';
    if (status === 'ACTIVE_CUSTOMER') statusClass = 'sc-active';
    if (status === 'LOST') statusClass = 'sc-lost';
    if (status === 'LEAD') statusClass = 'sc-lead';
    if (status === 'SENT') statusClass = 'sc-sent';

    return `
      <tr onclick="viewCRMDetail('${item.quote_id}')" style="cursor:pointer">
        <td><div style="font-size:.85rem;color:var(--muted)">${ts}</div></td>
        <td><span class="sc-badge ${statusClass}">${status}</span></td>
        <td><div style="font-weight:600">${client}</div><div style="font-size:.72rem;color:var(--muted)">${item.email || ''}</div></td>
        <td><div style="font-size:.85rem">${item.city || '—'}</div></td>
        <td>${area}</td>
        <td><div style="font-size:.85rem">${item.service || '—'}</div></td>
        <td><div style="font-weight:600">${total}</div></td>
        <td style="text-align:right;color:var(--muted);font-size:.85rem">›</td>
      </tr>
    `;
  }).join('');

  renderCRMPagination();
}

function renderCRMPagination() {
  const el = document.getElementById('crm-pagination');
  if (!el) return;
  const total = _crmFiltered.length;
  const totalPages = Math.ceil(total / CRM_PAGE_SIZE);
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  const start = (_crmPage - 1) * CRM_PAGE_SIZE + 1;
  const end = Math.min(_crmPage * CRM_PAGE_SIZE, total);

  let btns = '';
  for (let i = 1; i <= totalPages; i++) {
    if (totalPages <= 7 || i === 1 || i === totalPages || Math.abs(i - _crmPage) <= 1) {
      btns += `<button class="crm-pager-btn${i === _crmPage ? ' active' : ''}" onclick="crmGoToPage(${i})">${i}</button>`;
    } else if (Math.abs(i - _crmPage) === 2) {
      btns += `<span style="color:var(--muted);padding:0 .2rem">…</span>`;
    }
  }

  el.innerHTML = `
    <span class="crm-pager-info">Showing ${start}–${end} of ${total}</span>
    <div class="crm-pager">
      <button class="crm-pager-btn" onclick="crmGoToPage(${_crmPage - 1})" ${_crmPage === 1 ? 'disabled' : ''}>‹</button>
      ${btns}
      <button class="crm-pager-btn" onclick="crmGoToPage(${_crmPage + 1})" ${_crmPage === totalPages ? 'disabled' : ''}>›</button>
    </div>`;
}

function crmGoToPage(n) {
  const totalPages = Math.ceil(_crmFiltered.length / CRM_PAGE_SIZE);
  if (n < 1 || n > totalPages) return;
  _crmPage = n;
  renderCRM(_crmFiltered, false);
}

function renderCRMStats() {
  const bar = document.getElementById('crm-stats-bar');
  if (!bar) return;
  const counts = { all: _crmCache.length, LEAD: 0, UNSENT: 0, SENT: 0, SIGNED: 0, ACTIVE_CUSTOMER: 0, LOST: 0 };
  _crmCache.forEach(i => {
    const s = (i.status || 'UNSENT').toUpperCase();
    if (counts[s] !== undefined) counts[s]++;
  });
  const pills = [
    { label: 'All', key: 'all', color: '#0f172a', bg: '#f1f5f9' },
    { label: 'Leads', key: 'LEAD', color: '#475569', bg: '#e2e8f0' },
    { label: 'Quoted', key: 'SENT', color: '#075985', bg: '#e0f2fe' },
    { label: 'Signed', key: 'SIGNED', color: '#065f46', bg: '#d1fae5' },
    { label: 'Active', key: 'ACTIVE_CUSTOMER', color: '#14532d', bg: '#bbf7d0' },
    { label: 'Lost', key: 'LOST', color: '#991b1b', bg: '#fee2e2' },
  ];
  bar.innerHTML = pills.map(p =>
    `<button class="crm-stat-pill" onclick="crmStatFilter('${p.key}')"
       style="background:${p.bg};color:${p.color}">
       ${p.label} <strong>${counts[p.key] ?? 0}</strong>
     </button>`
  ).join('');
}

function populateYearFilter() {
  const select = document.getElementById('crm-filter-year');
  if (!select) return;
  const currentVal = select.value;
  const years = [...new Set(_crmCache.map(i => i.year_built).filter(Boolean).map(y => String(y).trim()))].sort((a,b) => b-a);
  
  let html = '<option value="all">Year (All)</option>';
  years.forEach(y => {
    html += `<option value="${y}">${y}</option>`;
  });
  select.innerHTML = html;
  if (years.includes(currentVal)) select.value = currentVal;
  else select.value = 'all';
}

function crmStatFilter(key) {
  const statusEl = document.getElementById('crm-filter-status');
  if (key === 'all') statusEl.value = 'all';
  else if (key === 'SENT') statusEl.value = 'SENT';
  else statusEl.value = key;
  filterCRM();
}

function filterCRM() {
  const q = (document.getElementById('crm-search').value || '').toLowerCase();
  const status = document.getElementById('crm-filter-status').value;
  const areaEl = document.getElementById('crm-filter-area');
  const area = areaEl ? areaEl.value : 'all';
  const yearEl = document.getElementById('crm-filter-year');
  const yearMatchVal = yearEl ? yearEl.value.trim() : '';
  const contractEl = document.getElementById('crm-filter-contract');
  const contractFilter = contractEl ? contractEl.value : 'all';

  const filtered = _crmCache.filter(item => {
    const name = item.client_name || `${item.first_name || ''} ${item.last_name || ''}`;
    const clientMatch = `${name} ${item.email || ''} ${item.city || ''}`.toLowerCase().includes(q);
    const statusMatch = status === 'all' || (item.status || 'UNSENT').toUpperCase() === status.toUpperCase();
    const areaMatch = area === 'all' || (item.area || '').toUpperCase() === area.toUpperCase();
    const yearMatch = yearMatchVal === 'all' || String(item.year_built || '').trim() === yearMatchVal;
    const contractMatch = contractFilter === 'all' || (item.contract_status || '').toUpperCase() === contractFilter.toUpperCase();
    return clientMatch && statusMatch && areaMatch && yearMatch && contractMatch;
  });

  renderCRM(filtered, true);
}

function _crmFilterActiveClients() {
  window._pendingCrmFilter = { status: 'ACTIVE_CUSTOMER', contractStatus: 'SIGNED' };
  navigateTo('crm');
}

let _activeLeadId = null;

function viewCRMDetail(quoteId) {
  const item = _crmCache.find(i => i.quote_id === quoteId);
  if (!item) return;
  _activeLeadId = quoteId;

  const name = (item.client_name || `${item.first_name || ''} ${item.last_name || ''}`).trim() || 'Lead Detail';
  const status = (item.status || 'UNSENT').toUpperCase();
  document.getElementById('lead-drawer-title').textContent = name;
  document.getElementById('lead-drawer-sub').textContent = status + (item.area ? '  ·  Area ' + item.area.toUpperCase() : '');
  document.getElementById('lead-drawer-body').innerHTML = buildLeadDrawerHTML(item);

  document.getElementById('lead-backdrop').classList.add('open');
  document.getElementById('lead-drawer').classList.add('open');
}

function closeLeadDrawer() {
  document.getElementById('lead-backdrop').classList.remove('open');
  document.getElementById('lead-drawer').classList.remove('open');
  _activeLeadId = null;
}

// Legacy alias — keep in case other code calls it
function closeCRMDetail() { closeLeadDrawer(); }

function buildLeadDrawerHTML(item) {
  const status = (item.status || 'UNSENT').toUpperCase();
  const contactLog = Array.isArray(item.contact_log) ? item.contact_log : [];
  const STATUSES = ['LEAD','UNSENT','SENT','SIGNED','ACTIVE_CUSTOMER','LOST'];

  const logHTML = contactLog.length
    ? contactLog.slice().reverse().map(e => `
        <div class="lead-log-entry">
          <div class="lle-meta">${e.date || ''} · <strong>${e.method || ''}</strong> · ${e.outcome || ''}</div>
          ${e.notes ? `<div class="lle-notes">${e.notes}</div>` : ''}
        </div>`).join('')
    : '<div style="color:var(--muted);font-size:.82rem;padding:.25rem 0">No contact attempts logged yet.</div>';

  const hasQuoteData = item.total_with_tax || item.service;

  return `
    <div style="padding:1rem">

      <!-- Client Info -->
      <div class="lead-section">
        <div class="lead-sec-label">Client Information</div>
        <div class="lead-info-grid">
          ${item.email ? `<div><b>Email</b>${item.email}</div>` : ''}
          ${item.phone ? `<div><b>Phone</b>${item.phone}</div>` : ''}
          ${(item.address || item.city) ? `<div><b>Address</b>${[item.address, item.city, item.zip_code].filter(Boolean).join(', ')}</div>` : ''}
          ${item.area ? `<div><b>Area</b>${item.area.toUpperCase()}</div>` : ''}
          ${item.pool_info ? `<div><b>Pool Info</b>${item.pool_info}</div>` : ''}
          ${item.year_built ? `<div><b>Year Built</b>${item.year_built}</div>` : ''}
          ${item.quote_id ? `<div style="grid-column:1/-1"><b>ID</b><code style="font-size:.78rem">${item.quote_id}</code></div>` : ''}
        </div>
      </div>

      ${hasQuoteData ? `
      <!-- Service & Financials -->
      <div class="lead-section">
        <div class="lead-sec-label">Quote Details</div>
        <div class="lead-info-grid">
          ${item.service ? `<div><b>Service</b>${item.service}</div>` : ''}
          ${item.pool_type ? `<div><b>Pool Type</b>${item.pool_type}</div>` : ''}
          ${typeof item.total_with_tax === 'number' ? `<div><b>Total</b>$${item.total_with_tax.toFixed(2)}</div>` : ''}
          ${typeof item.net_profit_est === 'number' ? `<div><b>Est. Profit</b><span style="color:var(--success)">$${item.net_profit_est.toFixed(2)}</span></div>` : ''}
        </div>
      </div>` : ''}

      ${item.contract_url ? `
      <!-- Contract -->
      <div class="lead-section">
        <div class="lead-sec-label">Contract</div>
        <div style="display:flex;flex-direction:column;gap:.45rem">
          <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
            <a href="${escHtml(item.contract_url)}" target="_blank" rel="noopener"
               style="padding:.45rem .9rem;border:1px solid var(--border);border-radius:8px;font-size:.82rem;color:var(--teal);text-decoration:none;font-weight:600">
              View PDF
            </a>
            <button id="drawer-send-btn" onclick="sendContract('${item.quote_id}')"
              style="padding:.45rem .9rem;background:var(--teal);color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:600;cursor:pointer">
              ${item.sent_at ? 'Resend Contract' : 'Send Contract ✉'}
            </button>
          </div>
          ${item.sent_at ? `<div style="font-size:.75rem;color:var(--muted)">Last sent: ${new Date(item.sent_at).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div>` : ''}
          <div id="send-contract-msg" style="display:none;font-size:.8rem;padding:.3rem .5rem;border-radius:6px"></div>
        </div>
      </div>` : ''}

      ${status === 'SIGNED' ? `
      <!-- Activate Customer CTA -->
      <div class="lead-section">
        <div class="lead-sec-label">Ready to Service?</div>
        <div id="activate-cta-area">
          <button onclick="activateCustomerFlow('${item.quote_id}')"
            style="width:100%;padding:.75rem 1rem;background:var(--teal);color:#fff;border:none;border-radius:10px;font-family:Oswald;font-size:.95rem;font-weight:600;cursor:pointer;letter-spacing:.03em">
            Activate Customer →
          </button>
        </div>
      </div>` : ''}

      ${status === 'ACTIVE_CUSTOMER' ? `
      <!-- Active Customer Info -->
      <div class="lead-section">
        <div class="lead-sec-label">Active Customer</div>
        <div class="lead-info-grid">
          ${item.pool_id ? `<div><b>Pool ID</b><code style="font-size:.82rem">${item.pool_id}</code></div>` : '<div style="color:var(--muted);font-size:.82rem;grid-column:1/-1">No pool ID assigned yet. Update status to reassign.</div>'}
          <div><b>Origin</b>${item.sponsored_by_mcp ? '<span style="color:#7c3aed;font-weight:600">Startup Transfer</span>' : 'Standard Contract'}</div>
        </div>
      </div>

      <!-- Billing Tracker -->
      <div class="lead-section">
        <div class="lead-sec-label">Billing</div>
        <div id="billing-section-body">${_buildBillingSectionHTML_(item)}</div>
      </div>` : ''}

      <!-- Status -->
      <div class="lead-section">
        <div class="lead-sec-label">Update Status</div>
        <div class="lead-status-row">
          ${STATUSES.map(s => `<button class="lead-status-btn${s === status ? ' active' : ''}" data-status="${s}" onclick="selectLeadStatus('${s}')">${s}</button>`).join('')}
        </div>
      </div>

      <!-- Service End Date (shown when LOST or already has a value) -->
      <div class="lead-section" id="lead-svc-end-section" style="display:${status === 'LOST' || item.service_end ? '' : 'none'}">
        <div class="lead-sec-label">Service End Date</div>
        <input class="si" type="date" id="lead-service-end" value="${item.service_end ? String(item.service_end).split('T')[0] : (status === 'LOST' ? new Date().toISOString().split('T')[0] : '')}" style="width:100%">
        <div style="font-size:.72rem;color:var(--muted);margin-top:.3rem">Auto-filled when marked LOST. Edit to backdate if needed.</div>
      </div>

      <!-- Notes -->
      <div class="lead-section">
        <div class="lead-sec-label">Internal Notes</div>
        <textarea class="si" id="lead-notes-input" rows="3" placeholder="Notes visible only to your team...">${item.notes || ''}</textarea>
      </div>

      <!-- Log Contact -->
      <div class="lead-section">
        <div class="lead-sec-label">Log Contact Attempt</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-bottom:.5rem">
          <select class="si" id="log-method">
            <option value="Call">Call</option>
            <option value="Text">Text</option>
            <option value="Email">Email</option>
            <option value="In Person">In Person</option>
          </select>
          <select class="si" id="log-outcome">
            <option value="Interested">Interested</option>
            <option value="Follow Up">Follow Up</option>
            <option value="No Answer">No Answer</option>
            <option value="Not Interested">Not Interested</option>
            <option value="Left Voicemail">Left Voicemail</option>
          </select>
        </div>
        <input class="si" type="date" id="log-date" value="${new Date().toISOString().split('T')[0]}" style="margin-bottom:.5rem;width:100%">
        <textarea class="si" id="log-notes" rows="2" placeholder="What was discussed? (optional)"></textarea>
      </div>

      <!-- Contact History -->
      <div class="lead-section">
        <div class="lead-sec-label">Contact History (${contactLog.length})</div>
        <div id="lead-log-history">${logHTML}</div>
      </div>

      <div class="im" id="lead-drawer-msg" style="display:none"></div>
    </div>`;
}

// ── Billing Tracker Helpers ────────────────────────────────────────────────────

function _getMonthRange_(startYYYYMM) {
  const months = [];
  const now = new Date();
  const [sy, sm] = startYYYYMM.split('-').map(Number);
  let y = sy, m = sm;
  const curY = now.getFullYear(), curM = now.getMonth() + 1;
  while (y < curY || (y === curY && m <= curM)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
    if (months.length > 60) break;
  }
  return months;
}

function _ordSuffix_(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return 'th';
  return ['th','st','nd','rd'][n % 10] || 'th';
}

function _buildBillingSectionHTML_(item) {
  if (!item) return '';
  const iDay   = item.invoice_day   ? Number(item.invoice_day)   : null;
  const bStart = item.billing_start ? String(item.billing_start) : null;

  if (!iDay || !bStart) {
    return `<div id="billing-setup-area">
      <button onclick="openBillingSetup('${item.quote_id}')"
        style="padding:.45rem .9rem;background:transparent;border:1px solid var(--border);border-radius:8px;font-size:.82rem;color:var(--teal);cursor:pointer;font-weight:600">
        + Set Up Billing Tracker
      </button>
    </div>`;
  }

  let payLog = [];
  try { const r = item.payment_log; payLog = Array.isArray(r) ? r : (r ? JSON.parse(r) : []); } catch(e) {}
  const logMap = {};
  payLog.forEach(e => { if (e.month) logMap[e.month] = e.status; });

  const months = _getMonthRange_(bStart);
  const monthsHTML = months.map(mo => {
    const st = logMap[mo] || 'pending';
    const [yr, mn] = mo.split('-');
    const lbl = new Date(Number(yr), Number(mn) - 1, 1).toLocaleString([], { month: 'short' }) + ' \'' + yr.slice(2);
    const icon = st === 'paid' ? '✓' : st === 'invoiced' ? '✉' : '○';
    return `<div class="bill-month bm-${st}" onclick="cyclePaymentStatus('${item.quote_id}','${mo}')" title="${mo}">
      <div class="bm-label">${lbl}</div><div class="bm-icon">${icon}</div>
    </div>`;
  }).join('');

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.6rem">
      <span style="font-size:.83rem">Invoice on the <strong>${iDay}${_ordSuffix_(iDay)}</strong> of each month</span>
      <button onclick="openBillingSetup('${item.quote_id}')"
        style="font-size:.73rem;color:var(--teal);background:none;border:none;cursor:pointer;text-decoration:underline;padding:0">Edit</button>
    </div>
    <div class="billing-calendar">${monthsHTML}</div>
    <div style="display:flex;gap:.75rem;margin-top:.45rem;font-size:.72rem;color:var(--muted)">
      <span>○ Not sent</span><span>✉ Invoiced</span><span>✓ Paid</span>
    </div>`;
}

function openBillingSetup(quoteId) {
  const item = _crmCache.find(i => i.quote_id === quoteId);
  if (!item) return;
  const today = new Date();
  const defStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const curDay   = item.invoice_day   ? Number(item.invoice_day)   : 1;
  const curStart = item.billing_start ? String(item.billing_start) : defStart;

  document.getElementById('billing-section-body').innerHTML = `
    <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:.85rem">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-bottom:.6rem">
        <div>
          <label style="font-size:.73rem;color:var(--muted);display:block;margin-bottom:.2rem">Invoice Day (1–28)</label>
          <input class="si" type="number" id="billing-day-inp" min="1" max="28" value="${curDay}" style="width:100%">
        </div>
        <div>
          <label style="font-size:.73rem;color:var(--muted);display:block;margin-bottom:.2rem">Billing Start</label>
          <input class="si" type="month" id="billing-start-inp" value="${curStart}" style="width:100%">
        </div>
      </div>
      <div style="display:flex;gap:.5rem">
        <button onclick="saveBillingSetup('${quoteId}')"
          style="padding:.4rem .85rem;background:var(--teal);color:#fff;border:none;border-radius:7px;font-size:.82rem;font-weight:600;cursor:pointer">
          Save
        </button>
        <button onclick="cancelBillingSetup('${quoteId}')"
          style="padding:.4rem .85rem;background:transparent;border:1px solid var(--border);border-radius:7px;font-size:.82rem;cursor:pointer">
          Cancel
        </button>
      </div>
      <div id="billing-setup-msg" style="display:none;font-size:.8rem;margin-top:.4rem;padding:.3rem .5rem;border-radius:6px"></div>
    </div>`;
}

function cancelBillingSetup(quoteId) {
  const item = _crmCache.find(i => i.quote_id === quoteId);
  const el = document.getElementById('billing-section-body');
  if (el && item) el.innerHTML = _buildBillingSectionHTML_(item);
}

async function saveBillingSetup(quoteId) {
  const dayEl   = document.getElementById('billing-day-inp');
  const startEl = document.getElementById('billing-start-inp');
  const msg     = document.getElementById('billing-setup-msg');
  const day     = parseInt(dayEl?.value);
  const start   = startEl?.value;

  if (!day || day < 1 || day > 28 || !start) {
    if (msg) { msg.style.display = 'block'; msg.className = 'im err'; msg.textContent = 'Enter a valid day (1–28) and start month.'; }
    return;
  }

  const item = _crmCache.find(i => i.quote_id === quoteId) || {};
  const res = await api({ action: 'update_lead', token: _s.token, quote_id: quoteId,
    status: item.status || 'ACTIVE_CUSTOMER', notes: item.notes || '',
    invoice_day: day, billing_start: start });

  if (res.ok) {
    const idx = _crmCache.findIndex(i => i.quote_id === quoteId);
    if (idx > -1) { _crmCache[idx].invoice_day = day; _crmCache[idx].billing_start = start; }
    const el = document.getElementById('billing-section-body');
    if (el) el.innerHTML = _buildBillingSectionHTML_(_crmCache[idx] || item);
  } else {
    if (msg) { msg.style.display = 'block'; msg.className = 'im err'; msg.textContent = res.error || 'Save failed.'; }
  }
}

async function cyclePaymentStatus(quoteId, month) {
  const cacheIdx = _crmCache.findIndex(i => i.quote_id === quoteId);
  if (cacheIdx === -1) return;
  const item = _crmCache[cacheIdx];

  let payLog = [];
  try { const r = item.payment_log; payLog = Array.isArray(r) ? r : (r ? JSON.parse(r) : []); } catch(e) {}
  payLog = payLog.slice(); // shallow copy

  const entryIdx = payLog.findIndex(e => e.month === month);
  const cur  = entryIdx > -1 ? payLog[entryIdx].status : 'pending';
  const next = cur === 'pending' ? 'invoiced' : cur === 'invoiced' ? 'paid' : 'pending';

  if (next === 'pending') { if (entryIdx > -1) payLog.splice(entryIdx, 1); }
  else if (entryIdx > -1) payLog[entryIdx].status = next;
  else payLog.push({ month, status: next });

  // Optimistic update
  const prevLog = item.payment_log;
  _crmCache[cacheIdx].payment_log = payLog;
  const el = document.getElementById('billing-section-body');
  if (el) el.innerHTML = _buildBillingSectionHTML_(_crmCache[cacheIdx]);

  const res = await api({ action: 'update_lead', token: _s.token, quote_id: quoteId,
    status: item.status, notes: item.notes || '', payment_log: payLog });

  if (!res.ok) {
    _crmCache[cacheIdx].payment_log = prevLog;
    if (el) el.innerHTML = _buildBillingSectionHTML_(item);
  }
}

// ────────────────────────────────────────────────────────────────────────────────

function selectLeadStatus(status) {
  document.querySelectorAll('.lead-status-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.status === status);
  });
  // Show/hide service_end section and auto-fill today when switching to LOST
  const svcEndSection = document.getElementById('lead-svc-end-section');
  const svcEndInput = document.getElementById('lead-service-end');
  if (svcEndSection && svcEndInput) {
    if (status === 'LOST') {
      svcEndSection.style.display = '';
      if (!svcEndInput.value) {
        svcEndInput.value = new Date().toISOString().split('T')[0];
      }
    } else {
      svcEndSection.style.display = 'none';
      svcEndInput.value = ''; // clear so it doesn't accidentally get saved
    }
  }
}

async function saveLeadChanges() {
  if (!_activeLeadId) return;
  const btn = document.getElementById('lead-save-btn');
  const msg = document.getElementById('lead-drawer-msg');
  btn.disabled = true; btn.textContent = 'Saving...';

  const activeStatusBtn = document.querySelector('.lead-status-btn.active');
  const newStatus = activeStatusBtn ? activeStatusBtn.dataset.status : null;
  const notes = (document.getElementById('lead-notes-input') || {}).value || '';
  const logNotes = (document.getElementById('log-notes') || {}).value || '';
  const logDate = (document.getElementById('log-date') || {}).value || new Date().toISOString().split('T')[0];
  const logMethod = (document.getElementById('log-method') || {}).value || '';
  const logOutcome = (document.getElementById('log-outcome') || {}).value || '';

  const serviceEnd = (document.getElementById('lead-service-end') || {}).value || null;

  const contactEntry = logNotes.trim()
    ? { date: logDate, method: logMethod, outcome: logOutcome, notes: logNotes }
    : null;

  try {
    const res = await api({
      action: 'update_lead',
      token: _s.token,
      quote_id: _activeLeadId,
      status: newStatus,
      notes,
      service_end: serviceEnd || null,
      contact_entry: contactEntry
    });

    if (res.ok) {
      const idx = _crmCache.findIndex(i => i.quote_id === _activeLeadId);
      if (idx > -1) {
        if (newStatus) _crmCache[idx].status = newStatus;
        _crmCache[idx].notes = notes;
        if (serviceEnd !== null) _crmCache[idx].service_end = serviceEnd;
        if (contactEntry) {
          _crmCache[idx].contact_log = _crmCache[idx].contact_log || [];
          _crmCache[idx].contact_log.push(contactEntry);
        }
      }
      msg.className = 'im ok'; msg.textContent = 'Saved successfully.'; msg.style.display = 'block';
      renderCRM(_crmFiltered, false);
      renderCRMStats();
      // Re-render drawer with updated data
      const updated = _crmCache.find(i => i.quote_id === _activeLeadId);
      if (updated) document.getElementById('lead-drawer-body').innerHTML = buildLeadDrawerHTML(updated);
      setTimeout(() => { msg.style.display = 'none'; }, 2500);
    } else {
      msg.className = 'im err'; msg.textContent = res.error || 'Failed to save.'; msg.style.display = 'block';
    }
  } catch (e) {
    msg.className = 'im err'; msg.textContent = 'Network error. Please try again.'; msg.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Save Changes';
  }
}

function _nextMcpsPoolId_() {
  let max = 0;
  _crmCache.forEach(i => {
    const m = String(i.pool_id || '').match(/^MCPS-(\d+)$/i);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return 'MCPS-' + String(max + 1).padStart(4, '0');
}

function activateCustomerFlow(quoteId) {
  const item = _crmCache.find(i => i.quote_id === quoteId);
  if (!item) return;
  const area = document.getElementById('activate-cta-area');
  if (!area) return;

  const existingPoolId = item.pool_id || _nextMcpsPoolId_();
  const isStartup = item.sponsored_by_mcp ? 'true' : 'false';

  area.innerHTML = `
    <div style="background:var(--surface-2,#f8fafc);border:1px solid var(--border);border-radius:10px;padding:.85rem;display:flex;flex-direction:column;gap:.6rem">
      <div>
        <label style="font-size:.78rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;display:block;margin-bottom:.3rem">Pool ID</label>
        <input class="si" id="activate-pool-id" type="text" placeholder="MCPS-XXXX" value="${escHtml(existingPoolId)}" style="width:100%">
      </div>
      <div>
        <label style="font-size:.78rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;display:block;margin-bottom:.3rem">Customer Origin</label>
        <select class="si" id="activate-origin" style="width:100%">
          <option value="false" ${isStartup === 'false' ? 'selected' : ''}>Standard Contract</option>
          <option value="true" ${isStartup === 'true' ? 'selected' : ''}>Startup Transfer</option>
        </select>
      </div>
      <div style="display:flex;gap:.5rem">
        <button id="activate-confirm-btn" onclick="confirmActivateCustomer('${quoteId}')"
          style="flex:1;padding:.6rem 1rem;background:var(--teal);color:#fff;border:none;border-radius:8px;font-family:Oswald;font-size:.88rem;font-weight:600;cursor:pointer">
          Confirm Activation
        </button>
        <button onclick="viewCRMDetail('${quoteId}')"
          style="padding:.6rem 1rem;background:none;border:1px solid var(--border);border-radius:8px;font-size:.82rem;cursor:pointer;color:var(--muted)">
          Cancel
        </button>
      </div>
      <div id="activate-msg" style="display:none;font-size:.82rem;padding:.4rem .6rem;border-radius:6px"></div>
    </div>`;
}

async function confirmActivateCustomer(quoteId) {
  const btn = document.getElementById('activate-confirm-btn');
  const msg = document.getElementById('activate-msg');
  const poolId = (document.getElementById('activate-pool-id').value || '').trim();
  const sponsoredByMcp = document.getElementById('activate-origin').value === 'true';

  if (!poolId) {
    msg.className = 'im err'; msg.textContent = 'Pool ID is required.'; msg.style.display = 'block';
    return;
  }

  btn.disabled = true; btn.textContent = 'Activating...';

  try {
    const res = await api({
      action: 'update_lead',
      token: _s.token,
      quote_id: quoteId,
      status: 'ACTIVE_CUSTOMER',
      pool_id: poolId,
      sponsored_by_mcp: sponsoredByMcp,
      notes: (_crmCache.find(i => i.quote_id === quoteId) || {}).notes || ''
    });

    if (res.ok) {
      const idx = _crmCache.findIndex(i => i.quote_id === quoteId);
      if (idx > -1) {
        _crmCache[idx].status = 'ACTIVE_CUSTOMER';
        _crmCache[idx].pool_id = poolId;
        _crmCache[idx].sponsored_by_mcp = sponsoredByMcp;
      }
      renderCRM(_crmFiltered, false);
      renderCRMStats();
      const updated = _crmCache.find(i => i.quote_id === quoteId);
      if (updated) {
        document.getElementById('lead-drawer-title').textContent =
          (updated.client_name || `${updated.first_name || ''} ${updated.last_name || ''}`).trim();
        document.getElementById('lead-drawer-sub').textContent =
          'ACTIVE_CUSTOMER' + (updated.area ? '  ·  Area ' + updated.area.toUpperCase() : '');
        document.getElementById('lead-drawer-body').innerHTML = buildLeadDrawerHTML(updated);
      }
    } else {
      msg.className = 'im err'; msg.textContent = res.error || 'Failed to activate.'; msg.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Confirm Activation';
    }
  } catch (e) {
    msg.className = 'im err'; msg.textContent = 'Network error. Please try again.'; msg.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Confirm Activation';
  }
}

async function sendContract(quoteId) {
  const btn = document.getElementById('drawer-send-btn');
  const msg = document.getElementById('send-contract-msg');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  try {
    const res = await api({ action: 'send_contract', token: _s.token, quote_id: quoteId });
    if (res.ok) {
      const sentAt = res.sent_at || new Date().toISOString();
      const idx = _crmCache.findIndex(i => i.quote_id === quoteId);
      if (idx > -1) {
        _crmCache[idx].status = 'SENT';
        _crmCache[idx].sent_at = sentAt;
      }
      renderCRM(_crmFiltered, false);
      renderCRMStats();
      const updated = _crmCache.find(i => i.quote_id === quoteId);
      if (updated) {
        document.getElementById('lead-drawer-sub').textContent =
          'SENT' + (updated.area ? '  ·  Area ' + updated.area.toUpperCase() : '');
        document.getElementById('lead-drawer-body').innerHTML = buildLeadDrawerHTML(updated);
      }
    } else {
      if (msg) { msg.className = 'im err'; msg.textContent = res.error || 'Failed to send.'; msg.style.display = 'block'; }
      if (btn) { btn.disabled = false; btn.textContent = 'Send Contract ✉'; }
    }
  } catch(e) {
    if (msg) { msg.className = 'im err'; msg.textContent = 'Network error. Please try again.'; msg.style.display = 'block'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Send Contract ✉'; }
  }
}

async function confirmImportLeads() {
  const btn = document.getElementById('import-leads-confirm-btn');
  const msg = document.getElementById('import-leads-msg');
  const valid = _importLeadsParsed.filter(r => r.client_name.trim());
  if (!valid.length) return;

  btn.disabled = true;
  btn.textContent = `Importing ${valid.length} leads...`;

  try {
    // Each lead in 'valid' already has first_name/last_name from _parseLeadsText
    const res = await api({ action: 'import_leads', token: _s.token, leads: valid });
    if (res.ok) {
      msg.className = 'im'; msg.style.background = '#dcfce7'; msg.style.color = '#166534';
      msg.textContent = `Successfully imported ${res.count} leads.`;
      msg.style.display = 'block';
      setTimeout(() => { closeImportLeads(); loadCRM(); }, 1500);
    } else {
      throw new Error(res.error || 'Unknown error');
    }
  } catch (err) {
    console.error('Import error:', err);
    msg.className = 'im'; msg.style.background = '#fef2f2'; msg.style.color = '#991b1b';
    msg.textContent = `Import failed: ${err.message}`;
    msg.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Confirm Import';
  }
}

function exportCRM() {
  if (!_crmCache.length) return alert('No data to export.');
  
  const headers = Object.keys(_crmCache[0]);
  const rows = _crmCache.map(item => headers.map(h => {
    let val = item[h] === null || item[h] === undefined ? '' : item[h];
    if (typeof val === 'string' && (val.includes(',') || val.includes('\n'))) {
      val = `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  }).join(','));

  const csvContent = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `MCPS_CRM_Export_${new Date().toISOString().split('T')[0]}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}


// ══════════════════════════════════════════════════════════════════════════════
// SALES HUB — IMPORT LEADS
// ══════════════════════════════════════════════════════════════════════════════
let _importLeadsParsed = [];
const IMPORT_COLS = ['client_name','address','city','email','phone','pool_info','year_built','area'];

function openImportLeads() {
  document.getElementById('import-leads-input-view').style.display = 'block';
  document.getElementById('import-leads-preview-view').style.display = 'none';
  document.getElementById('import-leads-back-btn').style.display = 'none';
  document.getElementById('import-leads-confirm-btn').style.display = 'none';
  document.getElementById('import-leads-paste').value = '';
  document.getElementById('import-leads-file').value = '';
  document.getElementById('import-leads-backdrop').style.display = 'flex';
}

function closeImportLeads(event) {
  if (event && event.target !== document.getElementById('import-leads-backdrop')) return;
  document.getElementById('import-leads-backdrop').style.display = 'none';
}

function importLeadsFromFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => { document.getElementById('import-leads-paste').value = e.target.result; };
  reader.readAsText(file);
}

function _parseLeadsText(raw) {
  const lines = raw.trim().split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const delim = lines[0].includes('\t') ? '\t' : ',';
  
  // Improved Parser: Handles quoted fields with commas and escaped quotes
  const parseLine = (line, d) => {
    if (d === '\t') return line.split('\t').map(c => c.trim().replace(/^"|"$/g,''));
    const cols = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i], next = line[i+1];
      if (char === '"') {
        if (inQuotes && next === '"') { cur += '"'; i++; } 
        else { inQuotes = !inQuotes; }
      } else if (char === d && !inQuotes) {
        cols.push(cur.trim()); cur = '';
      } else {
        cur += char;
      }
    }
    cols.push(cur.trim());
    return cols;
  };

  const firstLineCols = parseLine(lines[0], delim);
  const firstCell = (firstLineCols[0] || '').toLowerCase().replace(/[^a-z]/g,'');
  const start = ['clientname','name','client','cliente'].includes(firstCell) ? 1 : 0;

  return lines.slice(start).map(line => {
    const cols = parseLine(line, delim);
    const obj = {};
    IMPORT_COLS.forEach((k, i) => { obj[k] = cols[i] || ''; });
    
    // Auto-split name for backend compatibility
    const fullName = (obj.client_name || '').trim();
    if (fullName) {
      const parts = fullName.split(' ');
      obj.first_name = parts[0];
      obj.last_name = parts.slice(1).join(' ');
    } else {
      obj.first_name = ''; obj.last_name = '';
    }
    return obj;
  });
}

function previewImportLeads() {
  const raw = document.getElementById('import-leads-paste').value;
  if (!raw.trim()) return alert('Paste or upload data first.');
  _importLeadsParsed = _parseLeadsText(raw);
  if (!_importLeadsParsed.length) return alert('No valid rows found. Check your data format.');

  const VALID_AREAS = ['NW','NE','SW','SE'];
  let tableHTML = `<table class="ut" style="font-size:.78rem">
    <thead><tr><th>#</th><th>Name</th><th>City</th><th>Email</th><th>Phone</th><th>Area</th><th></th></tr></thead><tbody>`;

  _importLeadsParsed.forEach((row, i) => {
    const areaOk = VALID_AREAS.includes((row.area || '').toUpperCase().trim());
    const hasName = !!row.client_name.trim();
    const ok = hasName;
    const rowStyle = ok ? '' : 'background:#fef2f2';
    tableHTML += `<tr style="${rowStyle}">
      <td>${i+1}</td>
      <td>${hasName ? row.client_name : '<span style="color:#dc2626">MISSING</span>'}</td>
      <td>${row.city}</td><td>${row.email}</td><td>${row.phone}</td>
      <td>${areaOk ? `<span class="crm-area-badge">${row.area.toUpperCase()}</span>` : `<span style="color:#d97706">${row.area||'—'}</span>`}</td>
      <td>${ok ? '<span style="color:#16a34a">✓</span>' : '<span style="color:#dc2626">✗</span>'}</td>
    </tr>`;
  });
  tableHTML += '</tbody></table>';

  document.getElementById('import-leads-preview-table').innerHTML = tableHTML;
  document.getElementById('import-leads-input-view').style.display = 'none';
  document.getElementById('import-leads-preview-view').style.display = 'block';
  document.getElementById('import-leads-back-btn').style.display = 'inline-block';
  document.getElementById('import-leads-confirm-btn').style.display = 'inline-block';
  const invalidCount = _importLeadsParsed.filter(r => !r.client_name.trim()).length;
  if (invalidCount) {
    const msg = document.getElementById('import-leads-msg');
    msg.className = 'im'; msg.style.background = '#fef3c7'; msg.style.color = '#92400e';
    msg.textContent = `${invalidCount} row(s) are missing a client name and will be skipped.`;
    msg.style.display = 'block';
  }
}

function importLeadsBack() {
  document.getElementById('import-leads-input-view').style.display = 'block';
  document.getElementById('import-leads-preview-view').style.display = 'none';
  document.getElementById('import-leads-back-btn').style.display = 'none';
  document.getElementById('import-leads-confirm-btn').style.display = 'none';
}

async function confirmImportLeads() {
  const btn = document.getElementById('import-leads-confirm-btn');
  const msg = document.getElementById('import-leads-msg');
  const valid = _importLeadsParsed.filter(r => r.client_name.trim());
  if (!valid.length) return;
  btn.disabled = true; btn.textContent = `Importing ${valid.length} leads...`;
  try {
    const res = await api({ action: 'import_leads', token: _s.token, leads: valid });
    if (res.ok) {
      document.getElementById('import-leads-backdrop').style.display = 'none';
      loadCRM();
    } else {
      msg.className = 'im err'; msg.textContent = res.error || 'Import failed.'; msg.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Import Leads';
    }
  } catch (e) {
    msg.className = 'im err'; msg.textContent = 'Network error. Please try again.'; msg.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Import Leads';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SALES HUB — WEEKLY GOAL SPEEDOMETER
// ══════════════════════════════════════════════════════════════════════════════
let _weeklyGoal = 5;
let _weeklySignedCount = 0;

async function loadWeeklyGoal() {
  const cachedGoal = _appCacheGet('crm_goal', 5 * 60 * 1000);
  if (cachedGoal) {
    _weeklyGoal = cachedGoal.goal || 5;
    _weeklySignedCount = cachedGoal.signed_this_week || 0;
    renderSpeedometer();
    const editBtn = document.getElementById('crm-goal-edit-btn');
    if (editBtn) editBtn.style.display = isAdmin() ? 'inline-flex' : 'none';
  }

  try {
    const res = await apiGet({ action: 'get_weekly_goal', token: _s.token });
    if (res.ok) {
      const freshGoal = { goal: res.goal || 5, signed_this_week: res.signed_this_week || 0 };
      if (!cachedGoal || JSON.stringify(cachedGoal) !== JSON.stringify(freshGoal)) {
        _weeklyGoal = freshGoal.goal;
        _weeklySignedCount = freshGoal.signed_this_week;
        _appCacheSet('crm_goal', freshGoal);
        renderSpeedometer();
        const editBtn = document.getElementById('crm-goal-edit-btn');
        if (editBtn) editBtn.style.display = isAdmin() ? 'inline-flex' : 'none';
      }
    }
  } catch(e) {}
}

function renderSpeedometer() {
  const container = document.getElementById('crm-speedometer');
  if (!container) return;
  const pct = Math.min(_weeklySignedCount / Math.max(_weeklyGoal, 1), 1);
  const filled = Math.round(pct * 100);
  const R = 70, CX = 90, CY = 90;
  const arcLen = Math.PI * R;
  const fillLen = arcLen * pct;
  const gapLen = arcLen - fillLen + 0.001;
  const color = pct >= 1 ? '#16a34a' : pct >= 0.5 ? '#d97706' : '#ef4444';
  const angle = Math.PI - Math.PI * pct;
  const nx = CX + R * 0.72 * Math.cos(angle);
  const ny = CY - R * 0.72 * Math.sin(Math.PI * pct);

  container.innerHTML = `
    <svg viewBox="0 0 180 100" width="180" height="100">
      <path d="M ${CX-R},${CY} A ${R},${R} 0 0 1 ${CX+R},${CY}"
        fill="none" stroke="#e2e8f0" stroke-width="14" stroke-linecap="round"/>
      <path d="M ${CX-R},${CY} A ${R},${R} 0 0 1 ${CX+R},${CY}"
        fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"
        stroke-dasharray="${fillLen} ${gapLen}"/>
      <line x1="${CX}" y1="${CY}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}"
        stroke="#0f172a" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="${CX}" cy="${CY}" r="5" fill="#0f172a"/>
      <text x="${CX}" y="${CY - 14}" text-anchor="middle"
        font-family="Oswald,sans-serif" font-size="15" font-weight="700" fill="${color}">${filled}%</text>
    </svg>`;

  const countEl = document.getElementById('crm-signed-count');
  const goalEl = document.getElementById('crm-goal-display');
  if (countEl) countEl.textContent = _weeklySignedCount;
  if (goalEl) goalEl.textContent = _weeklyGoal;
}

function openGoalEditor() {
  const ed = document.getElementById('crm-goal-editor');
  if (!ed) return;
  document.getElementById('crm-goal-input').value = _weeklyGoal;
  ed.style.display = 'block';
}

function closeGoalEditor() {
  const ed = document.getElementById('crm-goal-editor');
  if (ed) ed.style.display = 'none';
}

async function saveWeeklyGoal() {
  const val = parseInt((document.getElementById('crm-goal-input') || {}).value, 10);
  const msg = document.getElementById('crm-goal-msg');
  if (!val || val < 1) return;
  try {
    const res = await api({ action: 'set_weekly_goal', token: _s.token, goal: val });
    if (res.ok) {
      _weeklyGoal = val;
      renderSpeedometer();
      closeGoalEditor();
    } else {
      msg.className = 'im err'; msg.textContent = res.error || 'Failed.'; msg.style.display = 'block';
    }
  } catch(e) {
    msg.className = 'im err'; msg.textContent = 'Network error.'; msg.style.display = 'block';
  }
}

