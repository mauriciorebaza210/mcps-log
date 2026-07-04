// ══════════════════════════════════════════════════════════════════════════════
// STARTUP REQUESTS — admin queue for external pool-builder startup requests
// (submitted via /startup-request?t=<company token>; backend in StartupRequests.js)
// ══════════════════════════════════════════════════════════════════════════════

let _srPending = [];
let _srHistory = null;
let _srCompanies = [];
let _srExpanded = null;

const SR_FIELD_GROUPS = [
  ['Customer', [
    ['first_name', 'First name'], ['last_name', 'Last name'],
    ['phone', 'Phone'], ['email', 'Email'],
    ['address', 'Address'], ['city', 'City'], ['zip_code', 'ZIP']
  ]],
  ['Pool', [
    ['pool_dimensions', 'Dimensions'], ['pool_depth', 'Depth'],
    ['spa', 'Spa'], ['water_features', 'Water features'],
    ['plaster_type', 'Plaster'], ['plaster_date', 'Plaster date']
  ]],
  ['Equipment', [
    ['equip_filter', 'Filter'], ['equip_pump', 'Pump'],
    ['equip_heater', 'Heater'], ['equip_chlorinator', 'Chlorinator'],
    ['equip_salt_system', 'Salt system'], ['equip_booster', 'Booster']
  ]]
];
const SR_ALL_FIELDS = SR_FIELD_GROUPS.flatMap(g => g[1].map(f => f[0])).concat(['requested_start_date', 'notes']);

function loadStartupRequests() {
  const container = document.getElementById('startup-requests-list');
  if (!container) return;
  container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1.5rem;font-size:.85rem">Loading startup requests…</div>';
  _srExpanded = null;

  apiGet({ action: 'startup_requests_list', scope: 'pending', token: _s.token }).then(res => {
    if (!res.ok) {
      container.innerHTML = `<div style="color:var(--muted);text-align:center;padding:1.5rem;font-size:.85rem">${escHtml(res.error || 'Failed to load requests.')}</div>`;
      return;
    }
    _srPending = res.requests || [];
    const title = document.getElementById('sr-card-title');
    if (title) title.textContent = 'Pool Startup Requests' + (_srPending.length ? ` (${_srPending.length})` : '');
    srRenderList_();
  }).catch(() => {
    container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1.5rem;font-size:.85rem">Network error — could not load startup requests.</div>';
  });

  if (!_srCompanies.length) srLoadCompanies_();
}

function srLoadCompanies_() {
  apiGet({ action: 'get_startup_companies', token: _s.token }).then(res => {
    if (!res.ok || !Array.isArray(res.companies)) return;
    _srCompanies = res.companies;
    const row = document.getElementById('sr-link-row');
    if (!row) return;
    row.innerHTML = `
      <span style="font-size:.78rem;font-weight:700;color:var(--muted)">Builder links:</span>
      <select id="sr-company-select" style="padding:.35rem .5rem;border:1px solid var(--border);border-radius:6px;font-size:.8rem;background:var(--surface);color:var(--text)">
        ${_srCompanies.map(c => `<option value="${escHtml(c.pool_company_id)}">${escHtml(c.company_name)}</option>`).join('')}
      </select>
      <button class="adm-new-btn" style="background:#0891b2" onclick="srCopyLink(false)">Copy request link</button>
      <button class="adm-new-btn" style="background:#475569" onclick="srCopyLink(true)" title="Generates a new link and disables the old one">Rotate link</button>
      <span id="sr-link-msg" style="font-size:.78rem;color:var(--success)"></span>
    `;
  }).catch(() => {});
}

function srCopyLink(rotate) {
  const sel = document.getElementById('sr-company-select');
  const msg = document.getElementById('sr-link-msg');
  if (!sel || !sel.value) return;
  if (rotate && !confirm('Generate a new link for this builder? The old link will stop working.')) return;
  if (msg) msg.textContent = 'Generating…';
  api({ action: 'get_startup_request_link', token: _s.token, pool_company_id: sel.value, rotate: !!rotate }).then(res => {
    if (!res.ok) { if (msg) msg.textContent = ''; alert(res.error || 'Could not generate the link.'); return; }
    const link = location.origin + '/startup-request?t=' + res.request_token;
    navigator.clipboard.writeText(link).then(() => {
      if (msg) { msg.textContent = (rotate ? 'New link copied' : 'Link copied') + ' for ' + (res.company_name || 'builder'); setTimeout(() => { msg.textContent = ''; }, 4000); }
    }).catch(() => {
      if (msg) msg.textContent = '';
      prompt('Copy the request link:', link);
    });
  }).catch(() => { if (msg) msg.textContent = ''; alert('Network error.'); });
}

function srPhotoUrls_(r) {
  try {
    const arr = JSON.parse(r.photo_urls || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function srIllegible_(r) {
  try {
    const raw = JSON.parse(r.raw_extraction || '{}');
    return Array.isArray(raw.illegible_fields) ? raw.illegible_fields : [];
  } catch (e) { return []; }
}

function srRenderList_() {
  const container = document.getElementById('startup-requests-list');
  if (!container) return;
  if (!_srPending.length) {
    container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1.5rem;font-size:.85rem">No pending startup requests.</div>';
    return;
  }
  container.innerHTML = _srPending.map(r => {
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || '—';
    const reviewed = String(r.reviewed_by_builder).toUpperCase() === 'TRUE';
    const illegible = srIllegible_(r);
    const expanded = _srExpanded === r.request_id;
    return `
      <div class="pend-card" id="sr-card-${escHtml(r.request_id)}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem">
          <div class="pend-sku">${escHtml(r.request_id)}</div>
          <span style="font-size:.65rem;background:var(--teal,#0d4d44);color:#fff;padding:.1rem .4rem;border-radius:4px;font-weight:700">${escHtml(r.company_name || '—')}</span>
        </div>
        <div class="pend-desc">${escHtml(name)}</div>
        <div style="font-size:.78rem;color:var(--muted);margin-bottom:.5rem">
          ${escHtml(r.address || 'No address')}${r.city ? ', ' + escHtml(r.city) : ''}
          · Submitted ${r.submitted_at ? new Date(r.submitted_at).toLocaleDateString() : '—'}
        </div>
        <div class="pend-ai" style="margin-bottom:.65rem">
          <span class="pend-ai-pill ${reviewed ? 'conf-high' : 'conf-low'}">${reviewed ? '✓ Reviewed by builder' : 'Sent as-is'}</span>
          ${illegible.length ? `<span class="pend-ai-pill conf-low">⚠ ${illegible.length} unclear field${illegible.length > 1 ? 's' : ''}</span>` : ''}
        </div>
        <div class="pend-btns">
          <button class="pend-approve" onclick="srToggleDetail('${escHtml(r.request_id)}')">${expanded ? 'Close' : 'Review'}</button>
        </div>
        ${expanded ? srDetailHtml_(r) : ''}
      </div>`;
  }).join('');
  if (_srExpanded) srRecalc(_srExpanded);
}

function srToggleDetail(requestId) {
  _srExpanded = _srExpanded === requestId ? null : requestId;
  srRenderList_();
}

function srDetailHtml_(r) {
  const photos = srPhotoUrls_(r);
  const illegible = srIllegible_(r);
  const id = escHtml(r.request_id);
  const input = (key, label) => {
    const warn = illegible.includes(key);
    return `<div class="dfg" style="margin:0">
      <label>${label}${warn ? ' ⚠' : ''}</label>
      <input class="si" id="sr-f-${key}-${id}" value="${escHtml(r[key] || '')}" ${warn ? 'style="border-color:#d97706;background:#fffbeb"' : ''}>
    </div>`;
  };
  const groups = SR_FIELD_GROUPS.map(([title, fields]) => `
    <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:.75rem 0 .4rem">${title}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:.5rem">
      ${fields.map(([key, label]) => input(key, label)).join('')}
    </div>`).join('');

  const startVal = /^\d{4}-\d{2}-\d{2}$/.test(r.requested_start_date || '') ? r.requested_start_date : '';
  return `
    <div style="border-top:1px solid var(--border);margin-top:.75rem;padding-top:.75rem" onclick="event.stopPropagation()">
      ${photos.length ? `
        <div style="margin-bottom:.75rem">
          ${photos.map(p => `<a href="${escHtml(p.file || p.thumb)}" target="_blank" rel="noopener">
            <img src="${escHtml(p.thumb || p.file)}" alt="Construction sheet"
              style="max-width:100%;max-height:260px;border-radius:8px;border:1px solid var(--border)"
              onerror="this.outerHTML='<span style=\\'font-size:.8rem\\'>📄 Open sheet photo</span>'">
          </a>`).join('')}
        </div>` : '<div style="font-size:.8rem;color:var(--muted);margin-bottom:.75rem">No sheet photo attached.</div>'}
      ${groups}
      ${r.notes ? `<div style="font-size:.8rem;color:var(--muted);margin-top:.6rem"><b>Builder notes:</b> ${escHtml(r.notes)}</div>` : ''}

      <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:1rem 0 .4rem">Startup &amp; Pricing</div>
      <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:center">
        <div class="dfg" style="margin:0">
          <label>Startup start date *</label>
          <input class="si" type="date" id="sr-date-${id}" value="${escHtml(startVal)}" onchange="srRecalc('${id}')">
        </div>
        <label style="font-size:.8rem;display:flex;gap:.3rem;align-items:center"><input type="checkbox" id="sr-chem-${id}" checked onchange="srRecalc('${id}')"> Chemical work</label>
        <label style="font-size:.8rem;display:flex;gap:.3rem;align-items:center"><input type="checkbox" id="sr-prog-${id}" checked onchange="srRecalc('${id}')"> Programming</label>
        <label style="font-size:.8rem;display:flex;gap:.3rem;align-items:center"><input type="checkbox" id="sr-school-${id}" onchange="srRecalc('${id}')"> Pool school</label>
        <label style="font-size:.8rem;display:flex;gap:.3rem;align-items:center"><input type="checkbox" id="sr-mcp-${id}" onchange="srRecalc('${id}')"> Sponsored by MCP</label>
      </div>
      <div id="sr-totals-${id}" style="font-size:.85rem;margin:.6rem 0;font-weight:600"></div>

      <div class="pend-btns" style="margin-top:.5rem">
        <button class="pend-approve" id="sr-approve-${id}" onclick="srApprove('${id}')">Approve &amp; create pool</button>
        <button class="pend-reject" onclick="srReject('${id}')">Reject</button>
      </div>
      <div id="sr-msg-${id}" style="font-size:.8rem;margin-top:.4rem"></div>
    </div>`;
}

// Pricing mirrors the Quote Tool exactly — qCalcEngine and Q_TAX are the same
// globals quotes.js uses, so the numbers can never drift between the two flows.
function srPricing_(requestId) {
  const chk = k => { const el = document.getElementById(`sr-${k}-${requestId}`); return !!(el && el.checked); };
  const eng = qCalcEngine({
    service: 'pool_startup',
    startup_chemical: chk('chem'), startup_programming: chk('prog'), startup_pool_school: chk('school'),
    startup_company: '', size: 'startup', pool_type: 'inground', material: 'plaster',
    spa: false, finish: 'light', debris: 'light', has_robot: false,
    high_sun_exposure: false, has_pets: false,
    repair_type: '', repair_company: '', repair_address: '', repair_desc: '',
    repair_amount: 0, repair_sku: '', first_name: '', last_name: ''
  });
  const sub = eng.subtotal;
  const tax = Math.round(sub * Q_TAX * 100) / 100;
  const total = Math.round((sub + tax) * 100) / 100;
  const net = Math.round((sub - eng.chem_cost) * 100) / 100;
  const margin = sub > 0 ? Math.round(net / sub * 1000) / 10 : 0;
  return { eng, sub, tax, total, net, margin, sponsored: chk('mcp') };
}

function srRecalc(requestId) {
  const totals = document.getElementById(`sr-totals-${requestId}`);
  const approveBtn = document.getElementById(`sr-approve-${requestId}`);
  const dateEl = document.getElementById(`sr-date-${requestId}`);
  if (!totals) return;
  const p = srPricing_(requestId);
  totals.innerHTML = `Service: $${p.sub.toFixed(2)} · Tax (8.25%): $${p.tax.toFixed(2)} · <b>Total: $${p.total.toFixed(2)}</b>`;
  if (approveBtn) approveBtn.disabled = !(dateEl && dateEl.value);
}

function srCollectFields_(requestId) {
  const fields = {};
  SR_ALL_FIELDS.forEach(k => {
    if (k === 'requested_start_date' || k === 'notes') return; // not editable in the admin card
    const el = document.getElementById(`sr-f-${k}-${requestId}`);
    if (el) fields[k] = el.value.trim();
  });
  return fields;
}

function srApprove(requestId) {
  const dateEl = document.getElementById(`sr-date-${requestId}`);
  const msg = document.getElementById(`sr-msg-${requestId}`);
  if (!dateEl || !dateEl.value) { if (msg) { msg.style.color = 'var(--error)'; msg.textContent = 'Set the startup start date first.'; } return; }
  const p = srPricing_(requestId);
  const btn = document.getElementById(`sr-approve-${requestId}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Creating pool…'; }
  if (msg) { msg.style.color = 'var(--muted)'; msg.textContent = 'Creating the startup pool and scheduling visits…'; }

  api({
    action: 'startup_request_approve',
    token: _s.token,
    request_id: requestId,
    startup_start_date: dateEl.value,
    fields: srCollectFields_(requestId),
    startup_chemical_work: !!document.getElementById(`sr-chem-${requestId}`)?.checked,
    startup_programming: !!document.getElementById(`sr-prog-${requestId}`)?.checked,
    startup_pool_school: !!document.getElementById(`sr-school-${requestId}`)?.checked,
    sponsored_by_mcp: p.sponsored,
    service_subtotal: p.eng.subtotal,
    quote_subtotal: p.sub,
    sales_tax: p.tax,
    total_with_tax: p.total,
    chem_cost_est: p.eng.chem_cost,
    net_profit_est: p.net,
    margin_percent: p.margin,
    quickbooks_skus: p.eng.qb_skus.join(', '),
    quickbooks_item_names: p.eng.qb_names.join(', ')
  }).then(res => {
    if (!res.ok) {
      if (msg) { msg.style.color = 'var(--error)'; msg.textContent = res.error || 'Approval failed.'; }
      if (btn) { btn.disabled = false; btn.textContent = 'Approve & create pool'; }
      if (/already/i.test(res.error || '')) loadStartupRequests();
      return;
    }
    // Same client caches a manual quote save leaves stale
    localStorage.removeItem('mcps_crm_data');
    localStorage.removeItem('mcps_unassigned');
    localStorage.removeItem('mcps_weekly_goal');
    if (typeof _clearRouteCache === 'function') _clearRouteCache();

    const card = document.getElementById('sr-card-' + requestId);
    if (card) {
      card.innerHTML = `<div style="padding:.5rem 0;color:var(--success);font-weight:600">
        ✓ Approved — pool ${escHtml(res.pool_id || '')} created, startup visits scheduled.
        ${res.warning ? `<div style="color:#b45309;font-weight:400;font-size:.8rem;margin-top:.3rem">⚠ ${escHtml(res.warning)}</div>` : ''}
      </div>`;
    }
    _srPending = _srPending.filter(r => r.request_id !== requestId);
    _srExpanded = null;
    const title = document.getElementById('sr-card-title');
    if (title) title.textContent = 'Pool Startup Requests' + (_srPending.length ? ` (${_srPending.length})` : '');
  }).catch(() => {
    if (msg) { msg.style.color = 'var(--error)'; msg.textContent = 'Network error — the request was not approved.'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Approve & create pool'; }
  });
}

function srReject(requestId) {
  const note = prompt('Reason for rejecting this request (sent to no one, stored for records):');
  if (note === null) return;
  api({ action: 'startup_request_reject', token: _s.token, request_id: requestId, note }).then(res => {
    if (!res.ok) { alert(res.error || 'Reject failed.'); return; }
    const card = document.getElementById('sr-card-' + requestId);
    if (card) card.innerHTML = '<div style="padding:.5rem 0;color:var(--muted);font-weight:600">Request rejected.</div>';
    _srPending = _srPending.filter(r => r.request_id !== requestId);
    _srExpanded = null;
  }).catch(() => alert('Network error.'));
}

function srToggleHistory() {
  const wrap = document.getElementById('startup-requests-history');
  if (!wrap) return;
  if (wrap.style.display !== 'none') { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  wrap.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1rem;font-size:.85rem">Loading history…</div>';
  apiGet({ action: 'startup_requests_list', scope: 'all', token: _s.token }).then(res => {
    if (!res.ok) { wrap.innerHTML = `<div style="color:var(--muted);text-align:center;padding:1rem;font-size:.85rem">${escHtml(res.error || 'Failed to load.')}</div>`; return; }
    const rows = (res.requests || []).filter(r => r.status !== 'pending_review');
    if (!rows.length) { wrap.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1rem;font-size:.85rem">No processed requests yet.</div>'; return; }
    wrap.innerHTML = `
      <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:1rem 0 .4rem">History (last ${rows.length})</div>
      ${rows.map(r => `
        <div style="display:flex;justify-content:space-between;gap:.5rem;padding:.45rem 0;border-bottom:1px solid var(--border);font-size:.82rem">
          <span>${escHtml(r.request_id)} · ${escHtml([r.first_name, r.last_name].filter(Boolean).join(' ') || r.address || '—')} <span style="color:var(--muted)">(${escHtml(r.company_name || '')})</span></span>
          <span style="font-weight:700;color:${r.status === 'approved' ? 'var(--success)' : 'var(--error)'}">
            ${r.status === 'approved' ? '✓ ' + escHtml(r.pool_id || 'approved') : '✕ rejected'}
          </span>
        </div>`).join('')}
    `;
  }).catch(() => { wrap.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1rem;font-size:.85rem">Network error.</div>'; });
}
