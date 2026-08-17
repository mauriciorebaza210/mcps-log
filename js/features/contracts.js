// ══════════════════════════════════════════════════════════════════════════════
// CONTRACTS — executed service agreements
//
// Depends on: api.js (api), auth.js (_s), constants.js (escHtml)
//
// Every signed agreement writes a full ESIGN/UETA audit trail to Service_Agreements
// — signature name and method, consent and its timestamp, signer IP, user agent,
// and the signed PDF. Until this page nothing in the portal read any of it: the
// trail existed only in a spreadsheet tab and a Drive folder. An audit trail you
// cannot produce on demand is not much of an audit trail.
//
// This is an operational records surface, so it scans like records: fixed-height
// rows, real statuses in plain English, and a skeleton state that reserves the
// exact final layout. Read-only — executed documents are never edited here.
// ══════════════════════════════════════════════════════════════════════════════

let _contracts = [];
let _ctFunnel = null;
let _ctFunnelError = false;
let _ctFilter = 'all';
let _ctSearch = '';
let _ctLoading = false;
const CT_CACHE_VERSION = 'stage5b-current-month';
const CT_SHEETS_TIMEOUT_MS = 10000;
const CT_BROWSER_CACHE_KEY = 'mcps_contracts_stage5b_v2';
const CT_BROWSER_CACHE_TTL = 30 * 1000;
const CT_DEFAULT_FOLLOWUP_SCHEDULE = '3,7,14';
const CT_DEFAULT_FINAL_NOTICE_LEAD = '3';

// ⚠️ Real values from the sheet, not invented ones. NOT_REQUIRED is genuine —
// SalesHub.js sets it as contract_status when signature_required is FALSE.
const CT_STATUS_LABELS = {
  SIGNED:       'Signed',
  APPROVED:     'Signed',
  SENT:         'Awaiting signature',
  DECLINED:     'Declined',
  EXPIRED:      'Expired',
  DRAFT:        'Draft',
  NOT_REQUIRED: 'No signature required',
  VOID:         'Void'
};

function ctStatusLabel(raw) {
  const s = String(raw || '').toUpperCase();
  return CT_STATUS_LABELS[s] || (s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ') : '—');
}

function ctToken_() {
  return (typeof _s !== 'undefined' && _s && _s.token) ? _s.token : '';
}

function ctSortAgreements_(agreements) {
  return (agreements || []).slice().sort((a, b) =>
    String(b.signed_at || b.sent_at || b.created_at || '')
      .localeCompare(String(a.signed_at || a.sent_at || a.created_at || '')));
}

function ctApplyAgreements_(agreements) {
  _contracts = ctSortAgreements_(agreements);
  renderContracts();
}

function ctApplyFunnel_(funnel) {
  _ctFunnel = (funnel && funnel.ok) ? funnel : null;
  _ctFunnelError = !!(funnel && !funnel.ok);
  renderContractStats();
}

function ctReadBrowserCache_() {
  try {
    const raw = localStorage.getItem(CT_BROWSER_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached || Date.now() - Number(cached.ts || 0) > CT_BROWSER_CACHE_TTL) {
      localStorage.removeItem(CT_BROWSER_CACHE_KEY);
      return null;
    }
    if (!Array.isArray(cached.agreements)) return null;
    return cached;
  } catch (_) {
    return null;
  }
}

function ctWriteBrowserCache_(agreements, funnel) {
  try {
    localStorage.setItem(CT_BROWSER_CACHE_KEY, JSON.stringify({
      ts: Date.now(),
      agreements: agreements || [],
      funnel: (funnel && funnel.ok) ? funnel : null
    }));
  } catch (_) {}
}

function ctApplyContractsPayload_(res, cacheIt) {
  const agreements = res && Array.isArray(res.agreements) ? res.agreements : [];
  const funnel = res && res.funnel;
  _contracts = ctSortAgreements_(agreements);
  _ctFunnel = (funnel && funnel.ok) ? funnel : null;
  _ctFunnelError = !!(funnel && !funnel.ok);
  if (cacheIt) ctWriteBrowserCache_(_contracts, _ctFunnel);
  renderContracts();
}

function ctLoadContractsViaSheets_(force) {
  if (typeof apiLocalGet !== 'function') return Promise.resolve(null);
  const token = ctToken_();
  if (!token) return Promise.resolve(null);
  const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), CT_SHEETS_TIMEOUT_MS) : null;
  return apiLocalGet('/api/contracts', {
    token: token,
    months: 6,
    cache_version: CT_CACHE_VERSION,
    refresh: force ? '1' : undefined
  }, ctl ? { signal: ctl.signal } : {})
    .then(res => (res && res.ok) ? res : null)
    .catch(() => null)
    .finally(() => { if (timer) clearTimeout(timer); });
}

function ctLoadContractsViaGas_() {
  const list = document.getElementById('ct-list');
  const agreementsReq = api({ action: 'get_service_agreements', token: ctToken_() })
    .then(res => {
      if (!res || !res.ok) {
        if (list) list.innerHTML = `<div class="ct-empty">Couldn't load contracts. ${escHtml((res && res.error) || '')}</div>`;
        return;
      }
      ctApplyAgreements_(res.agreements || []);
    }).catch(() => {
      if (!_contracts.length && list) list.innerHTML = '<div class="ct-empty">Network error. Try again.</div>';
    });

  const funnelReq = api({
    action: 'get_sales_funnel',
    token: ctToken_(),
    cache_version: CT_CACHE_VERSION,
    refresh: true
  }).then(funnel => {
    _ctFunnel = (funnel && funnel.ok) ? funnel : null;
    _ctFunnelError = !(funnel && funnel.ok);
    renderContractStats();
  }).catch(() => {
    _ctFunnel = null;
    _ctFunnelError = true;
    renderContractStats();
  });

  return Promise.allSettled([agreementsReq, funnelReq]);
}

function loadContracts(force) {
  const list = document.getElementById('ct-list');
  if (!list) return;

  if (_ctLoading) return;
  _ctLoading = true;
  _ctFunnel = null;
  _ctFunnelError = false;
  renderContractStats();

  // Prefer the same-origin Sheets API endpoint: it does one batched read and is
  // short-cached server-side. Apps Script remains the fallback for local/offline
  // setups or deployments missing the endpoint.
  if (!force) {
    const cached = ctReadBrowserCache_();
    if (cached) {
      ctApplyContractsPayload_(cached, false);
    }
  }
  if (!_contracts.length) renderContractSkeletonRows();

  ctLoadContractsViaSheets_(force)
    .then(res => {
      if (res) {
        ctApplyContractsPayload_(res, true);
        return null;
      }
      return ctLoadContractsViaGas_();
    })
    .finally(() => {
      _ctLoading = false;
    });
}

// ── Skeleton ─────────────────────────────────────────────────────────────────
// Same shape and height as a real card, so nothing shifts when data arrives.
function renderContractSkeletonRows(n) {
  const list = document.getElementById('ct-list');
  if (!list) return;
  const rows = [];
  for (let i = 0; i < (n || 5); i++) {
    rows.push(`<div class="ct-row ct-skel" aria-hidden="true">
      <div class="ct-main">
        <span class="sk sk-lg"></span>
        <span class="sk sk-sm"></span>
      </div>
      <div class="ct-actions">
        <span class="sk sk-pill"></span><span class="sk sk-btn"></span><span class="sk sk-btn"></span>
      </div>
    </div>`);
  }
  list.innerHTML = rows.join('');
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function ctStatus(a) {
  const s = String(a.status || '').toUpperCase();
  if (s) return s;
  if (a.signed_at) return 'SIGNED';
  if (a.declined_at) return 'DECLINED';
  if (a.sent_at) return 'SENT';
  return 'DRAFT';
}

function ctDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

function ctMoney(v) {
  const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) || !n ? '' : '$' + n.toFixed(2);
}

function ctFollowupEnabled(a) {
  const raw = String(a.followup_enabled || '').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no' && raw !== 'off' && raw !== 'paused';
}

function ctFollowupSchedule(a) {
  return String(a.followup_schedule || '').trim() || CT_DEFAULT_FOLLOWUP_SCHEDULE;
}

function ctFinalNoticeLead(a) {
  return String(a.final_notice_lead_days || '').trim() || CT_DEFAULT_FINAL_NOTICE_LEAD;
}

function ctCanEditFollowups(a) {
  if (!a || !String(a.followup_approval_id || '').trim()) return false;
  return String(a.approval_status || ctStatus(a)).toUpperCase() === 'SENT';
}

function ctNormalizeFollowupScheduleInput(raw) {
  const seen = new Set();
  const days = String(raw || '').split(/[,\s]+/)
    .map(part => Number(part.trim()))
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 90)
    .filter(n => {
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    })
    .sort((a, b) => a - b);
  if (!days.length) return { ok: false, error: 'Enter at least one follow-up day.' };
  if (days.length > 8) return { ok: false, error: 'Use 8 follow-up touches or fewer.' };
  return { ok: true, value: days.join(',') };
}

function ctFollowupStatusText(a) {
  if (!String(a.followup_approval_id || '').trim()) return 'No signing approval is linked to this contract.';
  const approvalStatus = String(a.approval_status || ctStatus(a)).toUpperCase();
  if (approvalStatus !== 'SENT') return 'This contract is closed, so automated follow-ups are inactive.';
  if (!ctFollowupEnabled(a)) return 'Paused for this contract.';
  const stopped = String(a.followup_stopped_reason || '').trim();
  if (stopped) return 'Stopped: ' + ctStatusLabel(stopped);
  const last = a.last_followup_at ? ' Last sent ' + ctDate(a.last_followup_at) + '.' : '';
  return 'Active. Next sweep uses this contract cadence.' + last;
}

function ctRenderFollowupSection(a) {
  const editable = ctCanEditFollowups(a);
  const disabled = editable ? '' : ' disabled';
  return `
    <div class="ct-sec">
      <div class="ct-sec-h">Follow-up cadence</div>
      <div class="ct-follow-card">
        <label class="ct-toggle">
          <input id="ct-fu-enabled" type="checkbox"${ctFollowupEnabled(a) ? ' checked' : ''}${disabled}>
          <span>Send automated follow-ups</span>
        </label>
        <div class="ct-follow-grid">
          <label>
            <span>Days after sent</span>
            <input id="ct-fu-schedule" class="amd-in" type="text" value="${escHtml(ctFollowupSchedule(a))}"${disabled}>
          </label>
          <label>
            <span>Final notice</span>
            <input id="ct-fu-final" class="amd-in" type="number" min="1" max="30" step="1"
              value="${escHtml(ctFinalNoticeLead(a))}"${disabled}>
          </label>
        </div>
        <label class="ct-check">
          <input id="ct-fu-reset" type="checkbox"${disabled}>
          <span>Restart progress from this contract's sent date</span>
        </label>
        <div class="ct-note">${escHtml(ctFollowupStatusText(a))}</div>
        ${editable ? `<button class="ct-btn primary" id="ct-fu-save" onclick="ctSaveFollowups(${jsArg(a.agreement_id)})">Save cadence</button>` : ''}
        <div class="amd-msg" id="ct-fu-msg"></div>
      </div>
    </div>`;
}

// ⚠️ Who this contract is FOR. Staff identify a contract by the person or the
// property — never by AGR-0048, which is a reference, not an identity.
//
// Order matters: the joined customer is authoritative, the signer is who actually
// put their name to it, and the service address identifies the job even when both
// names are missing. The agreement number is the last resort, and when it is all
// we have that is a data problem, not a layout — so it renders as an error state
// rather than looking like a normal row.
function ctIdentity(a) {
  const name = String(a.customer_name || '').trim();
  if (name) return { label: name, unresolved: false };

  const signer = String(a.signature_name || '').trim();
  if (signer) return { label: signer, unresolved: false };

  const where = String(a.location_label || '').trim();
  if (where) return { label: where, unresolved: false };

  return {
    label: String(a.agreement_number || a.agreement_id || 'Unidentified agreement').trim(),
    unresolved: true
  };
}

// ⚠️ Who may be amended. An amendment changes an EXECUTED agreement, so anything
// that was never executed is a quote edit, not an addendum.
//
// Blank agreement_type counts as original — every row written before amendments
// existed carries no type, and all of those are originals.
function ctIsAmendment(a) {
  return String(a.agreement_type || '').trim().toLowerCase() === 'amendment';
}

function ctCanAmend(a) {
  if (!a) return false;
  if (ctIsAmendment(a)) return false;                     // never amend an amendment
  if (!String(a.signed_at || '').trim()) return false;    // must actually be executed
  // ⚠️ Require an explicitly executed status rather than "not one of the bad
  // ones". An allow-list cannot be widened by a new status appearing in the
  // sheet; a deny-list silently would. NOT_REQUIRED is excluded by construction —
  // there was never a signature to amend.
  return ['SIGNED', 'APPROVED'].indexOf(ctStatus(a)) !== -1;
}

function ctSetFilter(f) { _ctFilter = f; renderContracts(); }
function ctSetSearch(v) { _ctSearch = String(v || '').trim().toLowerCase(); renderContracts(); }

// ── Stats band ───────────────────────────────────────────────────────────────
function renderContractStats() {
  const el = document.getElementById('ct-stats');
  if (!el) return;

  // ⚠️ Never disappear silently. A band that renders nothing is indistinguishable
  // from a band that was never built, which is exactly how this looked when
  // get_sales_funnel existed in the code but had not been deployed yet.
  if (_ctFunnelError) {
    el.innerHTML = `<div class="ct-stats-note">Funnel stats are unavailable right now.</div>`;
    return;
  }
  if (!_ctFunnel) { el.innerHTML = ''; return; }          // still loading
  if (!_ctFunnel.current) {
    el.innerHTML = `<div class="ct-stats-note">No agreements sent yet — stats appear once you send one.</div>`;
    return;
  }

  // ⚠️ Always the CURRENT calendar month, even when it is empty. Showing the most
  // recent month that had activity and labelling it "Sent in June" while it is
  // August reads as a stale page, not a quiet month.
  const c = _ctFunnel.current;
  const since = _ctFunnel.viewed_tracking_since;
  const fmtMonth = (key) => {
    const [y, m] = String(key || '').split('-');
    if (!y || !m) return '';
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
  };
  const monthLabel = fmtMonth(c.month);

  const stat = (label, value, note) => `<div class="ct-stat">
    <div class="ct-stat-v">${escHtml(String(value))}</div>
    <div class="ct-stat-l">${escHtml(label)}</div>
    ${note ? `<div class="ct-stat-n">${escHtml(note)}</div>` : ''}
  </div>`;

  // A quiet month is a fact worth stating plainly, with the previous active month
  // named as history rather than passed off as current.
  const lc = _ctFunnel.latest_cohort;
  const emptyNote = !c.sent
    ? `<div class="ct-stats-note">No agreements sent this month yet.${
        lc ? ` Latest sent cohort: ${escHtml(fmtMonth(lc.month))} — ${lc.sent} sent, ${lc.signed} signed.` : ''}</div>`
    : '';

  el.innerHTML = `
    <div class="ct-stats-h">Sent in ${escHtml(monthLabel)}<span class="ct-stats-sub">agreements are counted in the month they were sent, wherever they close</span></div>
    ${emptyNote}
    <div class="ct-stats-row">
      ${stat('Sent', c.sent)}
      ${stat('Viewed', c.viewed, since ? 'tracked since ' + since : '')}
      ${stat('Signed', c.signed)}
      ${stat('Close rate', c.sent ? c.close_rate + '%' : '—')}
      ${stat('Median to close', c.median_days_to_close === null ? '—' : c.median_days_to_close + 'd')}
      ${stat('Expiring soon', _ctFunnel.expiring_soon, 'next 7 days')}
      ${_ctFunnel.amendments_signed ? stat('Plan changes', _ctFunnel.amendments_signed, 'signed, all time') : ''}
    </div>`;
}

// ── List ─────────────────────────────────────────────────────────────────────
function renderContracts() {
  const list = document.getElementById('ct-list');
  const filters = document.getElementById('ct-filters');
  if (!list) return;

  renderContractStats();

  const counts = { all: _contracts.length };
  _contracts.forEach(a => { const s = ctStatus(a); counts[s] = (counts[s] || 0) + 1; });

  if (filters) {
    const keys = ['all'].concat(Object.keys(counts).filter(k => k !== 'all').sort());
    filters.innerHTML = keys.map(k => `
      <button class="ct-filt${_ctFilter === k ? ' active' : ''}" onclick="ctSetFilter(${jsArg(k)})">
        ${k === 'all' ? 'All' : escHtml(ctStatusLabel(k))}<span class="ct-n">${counts[k] || 0}</span>
      </button>`).join('');
  }

  let shown = _contracts.filter(a => _ctFilter === 'all' || ctStatus(a) === _ctFilter);
  if (_ctSearch) {
    shown = shown.filter(a => [
      a.customer_name, a.location_label, a.agreement_number, a.signature_name,
      a.service_name, a.service_type, a.source_quote_id
    ].filter(Boolean).join(' ').toLowerCase().includes(_ctSearch));
  }

  if (!shown.length) {
    list.innerHTML = `<div class="ct-empty">
      <h3>${_contracts.length ? 'Nothing matches' : 'No contracts yet'}</h3>
      <p>${_contracts.length
        ? 'Try a different status or search.'
        : 'Signed service agreements appear here, with their signature audit trail and PDF.'}</p>
    </div>`;
    return;
  }

  list.innerHTML = shown.map(a => {
    const st = ctStatus(a);
    const pdf = a.signed_pdf_url || a.agreement_pdf_url || a.contract_url || '';
    const id = String(a.agreement_id || '');   // raw — jsArg() escapes at the call site
    const num = String(a.agreement_number || a.agreement_id || '').trim();
    const svc = String(a.service_name || a.service_type || '').trim();
    const who = ctIdentity(a);

    // Subline carries the reference number — useful, but never the headline.
    const secondary = [num, svc, ctMoney(a.total),
      a.signed_at ? 'Signed ' + ctDate(a.signed_at)
                  : (a.sent_at ? 'Sent ' + ctDate(a.sent_at) : '')
    ].filter(Boolean).join(' · ');

    return `<div class="ct-row">
      <div class="ct-main">
        <h3${who.unresolved ? ' class="ct-noid"' : ''}>${escHtml(who.label)}</h3>
        ${secondary ? `<div class="ct-sub">${escHtml(secondary)}</div>` : ''}
      </div>
      <div class="ct-actions">
        ${ctIsAmendment(a) ? `<span class="ct-badge ct-amd" title="Addendum to an earlier agreement">Plan change</span>` : ''}
        <span class="ct-badge ct-${escHtml(st.toLowerCase())}">${escHtml(ctStatusLabel(st))}</span>
        ${pdf ? `<a class="ct-btn primary" href="${escHtml(pdf)}" target="_blank" rel="noopener">PDF</a>`
              : `<span class="ct-nopdf" title="No PDF stored on this agreement">No PDF</span>`}
        <button class="ct-btn" onclick="ctViewDetail(${jsArg(id)})">Details</button>
      </div>
    </div>`;
  }).join('');
}

// ── Detail: the audit trail ──────────────────────────────────────────────────
function ctViewDetail(agreementId) {
  const a = _contracts.find(x => String(x.agreement_id) === String(agreementId));
  if (!a) return;
  const body = document.getElementById('ct-drawer-body');
  const drawer = document.getElementById('ct-drawer');
  if (!body || !drawer) return;

  const row = (k, v) => v ? `<div class="ct-kv"><span>${escHtml(k)}</span><b>${escHtml(String(v))}</b></div>` : '';
  const pdf = a.signed_pdf_url || a.agreement_pdf_url || a.contract_url || '';
  const consent = String(a.consent_accepted || '').toUpperCase();

  document.getElementById('ct-drawer-title').textContent =
    String(a.customer_name || '').trim() || a.agreement_number || 'Contract';
  document.getElementById('ct-drawer-sub').textContent =
    ctStatusLabel(ctStatus(a)) + (a.agreement_number ? '  ·  ' + a.agreement_number : '');

  body.innerHTML = `
    <div class="ct-sec">
      <div class="ct-sec-h">Agreement</div>
      ${row('Property', a.location_label)}
      ${row('Service', a.service_name || a.service_type)}
      ${row('Monthly rate', ctMoney(a.monthly_rate))}
      ${row('Startup fee', ctMoney(a.startup_fee))}
      ${row('Travel fee', ctMoney(a.travel_fee))}
      ${row('Sales tax', ctMoney(a.sales_tax))}
      ${row('Total', ctMoney(a.total))}
      ${row('Service start', ctDate(a.service_start))}
      ${row('Billing start', ctDate(a.billing_start))}
      ${row('Quote', a.source_quote_id)}
    </div>

    <div class="ct-sec">
      <div class="ct-sec-h">Signature &amp; audit trail</div>
      ${row('Signed by', a.signature_name)}
      ${row('Method', a.signature_method)}
      ${row('Signed at', a.signed_at ? new Date(a.signed_at).toLocaleString() : '')}
      ${row('Consent accepted', consent === 'TRUE' ? 'Yes' : (consent ? consent : ''))}
      ${row('Consent at', a.consent_at ? new Date(a.consent_at).toLocaleString() : '')}
      ${row('Signer IP', a.signer_ip)}
      ${row('Device', a.signer_user_agent)}
      ${row('Document version', a.agreement_version)}
      ${row('Activation', a.activation_method)}
      ${a.signature_image_url
        ? `<div class="ct-sig"><img src="${escHtml(a.signature_image_url)}" alt="Signature">
             <div class="ct-sig-c">Signature as captured</div></div>`
        : ''}
      ${!a.signed_at ? `<div class="ct-note">This agreement has not been signed yet.</div>` : ''}
    </div>

    <div class="ct-sec">
      <div class="ct-sec-h">Documents</div>
      ${pdf
        ? `<a class="ct-btn primary" href="${escHtml(pdf)}" target="_blank" rel="noopener">Open signed PDF</a>`
        : `<div class="ct-note">No PDF is stored on this agreement.</div>`}
      ${a.source_quote_id
        ? `<button class="ct-btn" onclick="ctOpenQuote(${jsArg(a.source_quote_id)})">Open quote in Sales Hub</button>`
        : ''}
    </div>

    ${ctRenderFollowupSection(a)}

    ${ctIsAmendment(a) ? `
      <div class="ct-sec">
        <div class="ct-sec-h">Plan change</div>
        <div class="ct-note">
          This is an addendum to
          ${a.parent_agreement_id
            ? `<button class="ct-linkbtn" onclick="ctViewDetail(${jsArg(a.parent_agreement_id)})">${escHtml(a.parent_agreement_id)}</button>`
            : 'an earlier agreement'}.
          ${a.amendment_reason ? escHtml(a.amendment_reason) : ''}
        </div>
      </div>` : ''}

    ${ctCanAmend(a) ? `
      <div class="ct-sec">
        <div class="ct-sec-h">Change this service</div>
        <div class="ct-note" style="margin-bottom:.6rem">
          Upgrades, downgrades and pauses are signed as a separate addendum. The original agreement is
          never altered.
        </div>
        <button class="ct-btn primary" onclick="openAmendModal(${jsArg(a.agreement_id)})">
          Create plan change
        </button>
      </div>` : ''}

    ${a.notes ? `<div class="ct-sec"><div class="ct-sec-h">Notes</div><div class="ct-note">${escHtml(a.notes)}</div></div>` : ''}`;

  document.getElementById('ct-backdrop').classList.add('open');
  drawer.classList.add('open');
}

function ctCloseDetail() {
  document.getElementById('ct-backdrop')?.classList.remove('open');
  document.getElementById('ct-drawer')?.classList.remove('open');
}

function ctOpenQuote(quoteId) {
  ctCloseDetail();
  window._pendingCrmQuoteId = quoteId;
  if (typeof navigateTo === 'function') navigateTo('crm');
}

function ctFollowupMsg(text, isErr) {
  const el = document.getElementById('ct-fu-msg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'amd-msg' + (isErr ? ' err' : '');
  el.style.display = text ? 'block' : 'none';
}

function ctApplyFollowupResult(agreementId, res) {
  const a = _contracts.find(x => String(x.agreement_id) === String(agreementId));
  if (!a || !res) return;
  [
    'followup_enabled', 'followup_schedule', 'final_notice_lead_days',
    'followup_next_index', 'followup_cycle', 'last_followup_at',
    'last_followup_error', 'followup_stopped_reason', 'followup_updated_at'
  ].forEach(k => {
    if (res[k] !== undefined) a[k] = res[k];
  });
}

function ctSaveFollowups(agreementId) {
  const a = _contracts.find(x => String(x.agreement_id) === String(agreementId));
  if (!a || !ctCanEditFollowups(a)) return;

  const enabled = !!document.getElementById('ct-fu-enabled')?.checked;
  const schedule = ctNormalizeFollowupScheduleInput(document.getElementById('ct-fu-schedule')?.value || '');
  if (!schedule.ok) { ctFollowupMsg(schedule.error, true); return; }

  const finalLead = Number(document.getElementById('ct-fu-final')?.value || 0);
  if (!Number.isInteger(finalLead) || finalLead < 1 || finalLead > 30) {
    ctFollowupMsg('Final notice must be 1-30 days before expiry.', true);
    return;
  }

  const btn = document.getElementById('ct-fu-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  ctFollowupMsg('Saving cadence...', false);

  api({
    action: 'update_contract_followups',
    token: ctToken_(),
    agreement_id: agreementId,
    followup_enabled: enabled,
    followup_schedule: schedule.value,
    final_notice_lead_days: String(finalLead),
    reset_followups: !!document.getElementById('ct-fu-reset')?.checked
  }).then(res => {
    if (btn) { btn.disabled = false; btn.textContent = 'Save cadence'; }
    if (!res || !res.ok) {
      ctFollowupMsg((res && res.error) || 'Could not save cadence.', true);
      return;
    }
    ctApplyFollowupResult(agreementId, res);
    ctFollowupMsg('Cadence saved.', false);
    loadContracts(true);
  }).catch(() => {
    if (btn) { btn.disabled = false; btn.textContent = 'Save cadence'; }
    ctFollowupMsg('Network error saving cadence.', true);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// CREATE PLAN CHANGE (amendment)
//
// Staff raise an addendum against a signed original. This UI sends ONLY the
// parent id — the backend mints the amendment's own agreement row, proposal,
// approval and token.
//
// ⚠️ The browser never supplies a target amendment id. `sign_amendment` resolves
// its target server-side from the token's target_agreement_id precisely so a
// client cannot aim a signature at an executed contract.
//
// ⚠️ No email is sent from here. There is no amendment-email route yet, and a
// button that claims to send something it cannot would be worse than none — so
// this produces a signing link to copy or open.
// ══════════════════════════════════════════════════════════════════════════════
const AMD_TYPES = [
  ['upgrade',   'Upgrade'],
  ['downgrade', 'Downgrade'],
  ['pause',     'Pause'],
  ['resume',    'Resume'],
  ['other',     'Other']
];

let _amdParentId = null;
let _amdBusy = false;
// ⚠️ Selection lives in state, not in a CSS class. Reading it back out of the DOM
// made the choice depend on rendering having happened, and meant the value could
// not be verified without a full DOM.
let _amdType = 'upgrade';

function openAmendModal(agreementId) {
  const parent = _contracts.find(x => String(x.agreement_id) === String(agreementId));
  if (!parent || !ctCanAmend(parent)) return;
  _amdParentId = agreementId;
  _amdBusy = false;
  _amdType = 'upgrade';   // matches the chip rendered active below

  const who = ctIdentity(parent);
  const body = document.getElementById('amd-modal-body');
  const foot = document.getElementById('amd-modal-foot');
  if (!body || !foot) return;

  body.innerHTML = `
    <div class="amd-parent">
      <div class="amd-parent-l">Changing</div>
      <div class="amd-parent-v${who.unresolved ? ' ct-noid' : ''}">${escHtml(who.label)}</div>
      <div class="amd-parent-s">${escHtml([
        parent.agreement_number || parent.agreement_id,
        parent.service_name || parent.service_type
      ].filter(Boolean).join(' · '))}</div>
    </div>

    <label class="amd-l" for="amd-type">Type of change</label>
    <div class="amd-types" id="amd-type">
      ${AMD_TYPES.map(([k, label], i) => `
        <button type="button" class="amd-chip${i === 0 ? ' active' : ''}" data-amd-type="${k}"
          onclick="amdPickType(${jsArg(k)})">${escHtml(label)}</button>`).join('')}
    </div>

    <label class="amd-l" for="amd-reason">What is changing?</label>
    <input class="amd-in" id="amd-reason" type="text" maxlength="160"
           placeholder="e.g. Adding spa service">
    <div class="amd-hint">The customer sees this on the addendum.</div>

    <label class="amd-l" for="amd-service">Service name</label>
    <input class="amd-in" id="amd-service" type="text" maxlength="120"
           value="${escHtml(parent.service_name || parent.service_type || '')}">

    <div class="amd-row">
      <div>
        <label class="amd-l" for="amd-rate">Monthly rate</label>
        <input class="amd-in" id="amd-rate" type="number" step="0.01" min="0" placeholder="0.00"
               oninput="amdRecalc()">
      </div>
      <div>
        <label class="amd-l" for="amd-tax">Sales tax</label>
        <input class="amd-in" id="amd-tax" type="number" step="0.01" min="0" placeholder="0.00"
               oninput="amdRecalc()">
      </div>
      <div>
        <label class="amd-l" for="amd-total">Total</label>
        <input class="amd-in" id="amd-total" type="number" step="0.01" min="0" placeholder="0.00"
               oninput="this.dataset.touched='1'">
      </div>
    </div>
    <div class="amd-hint">Total fills from rate + tax; override it if the change is one-off.</div>
    <div class="amd-msg" id="amd-msg"></div>`;

  foot.innerHTML = `
    <button class="conf-cancel-btn" onclick="closeAmendModal()">Cancel</button>
    <button class="conf-submit-btn" id="amd-submit" onclick="amdSubmit()">Create signing link</button>`;

  document.getElementById('amd-modal-backdrop').classList.add('open');
  setTimeout(() => document.getElementById('amd-reason')?.focus(), 30);
}

function closeAmendModal(e) {
  if (e && e.target && e.target.id !== 'amd-modal-backdrop') return;
  if (_amdBusy) return;   // never close mid-request — the link would be lost
  document.getElementById('amd-modal-backdrop')?.classList.remove('open');
  _amdParentId = null;
}

function amdPickType(key) {
  _amdType = AMD_TYPES.some(([k]) => k === key) ? key : 'other';
  const wrap = document.getElementById('amd-type');
  if (!wrap) return;
  Array.prototype.forEach.call(wrap.querySelectorAll('[data-amd-type]'), b => {
    b.classList.toggle('active', b.getAttribute('data-amd-type') === _amdType);
  });
}

function amdSelectedType() { return _amdType; }

// Convenience only — total stays editable, because a pause or a one-off charge
// is not always rate + tax.
function amdRecalc() {
  const rate = Number(document.getElementById('amd-rate')?.value || 0);
  const tax = Number(document.getElementById('amd-tax')?.value || 0);
  const total = document.getElementById('amd-total');
  if (!total || total.dataset.touched === '1') return;
  total.value = (rate + tax) ? (rate + tax).toFixed(2) : '';
}

function amdMsg(text, isErr) {
  const el = document.getElementById('amd-msg');
  if (!el) return;
  el.textContent = text;
  el.className = 'amd-msg' + (isErr ? ' err' : '');
  el.style.display = text ? 'block' : 'none';
}

function amdSubmit() {
  if (_amdBusy || !_amdParentId) return;
  const reason = String(document.getElementById('amd-reason')?.value || '').trim();
  if (!reason) { amdMsg('Say what is changing — the customer sees this on the addendum.', true); return; }

  const btn = document.getElementById('amd-submit');
  _amdBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
  amdMsg('Creating the addendum…', false);

  const num = id => {
    const v = String(document.getElementById(id)?.value || '').trim();
    return v === '' ? '' : v;
  };

  api({
    action: 'create_amendment',
    token: _s ? _s.token : '',
    // ⚠️ Parent id ONLY. The amendment's own agreement/proposal/approval/token
    // are created server-side; the browser never names a signing target.
    parent_agreement_id: _amdParentId,
    amendment_type: amdSelectedType(),
    amendment_reason: reason,
    service_name: String(document.getElementById('amd-service')?.value || '').trim(),
    monthly_rate: num('amd-rate'),
    // The proposal row stores `subtotal`; the agreement row stores `monthly_rate`.
    // Sending only the latter left the amendment's pricing SNAPSHOT incomplete,
    // and the addendum renders from the proposal.
    subtotal: num('amd-rate'),
    sales_tax: num('amd-tax'),
    total: num('amd-total'),
    created_by: (_s && _s.name) || ''
  }).then(res => {
    _amdBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Create signing link'; }
    if (!res || !res.ok) { amdMsg((res && res.error) || 'Could not create the plan change.', true); return; }
    amdRenderResult(res);
    loadContracts(true);   // the new addendum should appear straight away
  }).catch(() => {
    _amdBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Create signing link'; }
    amdMsg('Network error creating the plan change.', true);
  });
}

function amdRenderResult(res) {
  const body = document.getElementById('amd-modal-body');
  const foot = document.getElementById('amd-modal-foot');
  if (!body || !foot) return;
  const url = res.sign_url || '';

  body.innerHTML = `
    <div class="amd-done">
      <div class="amd-done-ic">✓</div>
      <h3>Plan change created</h3>
      <p>${escHtml(res.amendment_number || res.amendment_id || '')} is ready for the customer to sign.
         Nothing about the original agreement has changed.</p>
    </div>
    <label class="amd-l" for="amd-link">Signing link</label>
    <input class="amd-in" id="amd-link" type="text" readonly value="${escHtml(url)}"
           onclick="this.select()">
    <div class="amd-hint">No email has been sent — send this link however you normally reach them.</div>
    <div class="amd-msg" id="amd-msg"></div>`;

  foot.innerHTML = `
    <button class="conf-cancel-btn" onclick="amdCopyLink()">Copy link</button>
    <a class="conf-cancel-btn" href="${escHtml(url)}" target="_blank" rel="noopener"
       style="text-decoration:none">Open signing page</a>
    <button class="conf-submit-btn" onclick="closeAmendModal()">Done</button>`;
}

function amdCopyLink() {
  const el = document.getElementById('amd-link');
  if (!el) return;
  el.select();
  const done = () => amdMsg('Link copied.', false);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(el.value).then(done).catch(() => {
      // execCommand is deprecated but still the reliable fallback on http:// and
      // older Safari, where the async clipboard API is unavailable.
      try { document.execCommand('copy'); done(); } catch (e) { amdMsg('Press ⌘C to copy.', true); }
    });
  } else {
    try { document.execCommand('copy'); done(); } catch (e) { amdMsg('Press ⌘C to copy.', true); }
  }
}
