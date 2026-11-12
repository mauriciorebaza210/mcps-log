// ══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE EMAIL ← the portal's own data (PLAN.md → Plan changes 2026-11-11
// "Connected to the portal's own data").
//   Contacts → Sales Hub leads: pick which Sales Hub leads are "MCP leads" from the
//     live breakdown, check them like an import, add them to Needs review, and
//     optionally keep adding new matching leads every morning.
//   Campaigns → MCP Startup: startups come from the portal (Quotes + the schedule);
//     shows the last sync, with Sync now. Opening the page syncs at most every 15 min.
// API: /api/email?op=crm (GET summary; POST check | add | sync_startups).
// Shares helpers with js/features/lifecycle.js.
// ══════════════════════════════════════════════════════════════════════════════

const CRM = { data: null, loading: false, layer: null, rule: null, keep: false, check: null, busy: false, autoSynced: false };
const CRM_SYNC_EVERY_MS = 15 * 60 * 1000;

async function crmApi_(method, body) {
  const res = await fetch('/api/email?op=crm', { method, headers: Object.assign({ Authorization: 'Bearer ' + currentSessionToken_() },
    body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const out = await res.json().catch(() => ({}));
  if (!res.ok && !out.error) out.error = 'HTTP ' + res.status;
  return out;
}
// The summary (lead breakdown, startup sync status). Opening Campaigns also syncs startups when stale.
async function crmLoad_(after) {
  if (CRM.loading) return;
  CRM.loading = true;
  const r = await crmApi_('GET').catch(() => ({ ok: false }));
  CRM.loading = false;
  if (r.ok) CRM.data = r;
  if (after) after(r);
  if (LC.tab === 'campaigns') lcRenderBody_();
  if (r.ok && !CRM.autoSynced && lcCan_('edit_contacts')) {
    const last = Date.parse((r.startups && r.startups.last_sync) || '') || 0;
    if (r.reset_pending || Date.now() - last > CRM_SYNC_EVERY_MS) { CRM.autoSynced = true; crmSyncStartups_(true); }
  }
}
async function crmSyncStartups_(quiet) {
  if (CRM.busy) return;
  CRM.busy = true; if (LC.tab === 'campaigns') lcRenderBody_();
  // Startups, and MCP leads when automatic adding is on (api/email.js → stage 'sync').
  const r = await crmApi_('POST', { stage: 'sync' }).catch(() => ({ ok: false, error: 'Network error' }));
  CRM.busy = false;
  const s = r.startups || {}, l = r.leads || {};
  if (!r.ok || s.ok === false) { if (!quiet) lcToast_(r.error || s.error || 'The sync didn’t work', true); }
  else {
    const changed = (s.added || 0) + (s.updated || 0) + (s.removed || 0) + (l.added || 0);
    const parts = [s.added && s.added + ' new startup' + (s.added === 1 ? '' : 's'), s.updated && s.updated + ' startup' + (s.updated === 1 ? '' : 's') + ' updated',
      s.removed && s.removed + ' removed', l.added && l.added + ' MCP lead' + (l.added === 1 ? '' : 's') + ' added'].filter(Boolean);
    if (!quiet || changed) lcToast_(changed ? 'From the portal: ' + parts.join(', ') : 'Up to date with the portal');
    if (l.failed && !quiet) lcToast_('Some MCP leads couldn’t be added: ' + l.failed, true);
    if (changed) lcRefresh_(true);
  }
  crmLoad_();
}

// The line on MCP Startup's card (short) and page.
function crmStartupLine_(short) {
  const s = CRM.data && CRM.data.startups;
  if (!s) return '<span class="lc-dim">Startups come from the portal</span>';
  if (short) {
    const t = Date.parse(s.last_sync || ''), today = t && lcLocalDay_(t) === lcTodayCT_();
    return '<span><b>' + s.found + '</b> from the portal</span><span class="lc-dim"> · ' + (CRM.busy ? 'syncing…' : !t ? 'not synced yet' : 'synced ' + lcEsc_(today ? lcClockAt_(t) : lcDay_(s.last_sync))) + '</span>';
  }
  return '<span>From the portal: <b>' + s.found + '</b> startup' + (s.found === 1 ? '' : 's') + '</span><span class="lc-dim"> · ' +
    (CRM.busy ? 'syncing…' : s.last_sync ? 'synced ' + lcEsc_(lcStamp_(s.last_sync)) : 'not synced yet') + '</span>';
}
function crmStartupStrip_() {
  const s = CRM.data && CRM.data.startups;
  const notes = s ? [s.cancelled ? s.cancelled + ' cancelled (removed)' : '', s.not_synced ? s.not_synced + ' missing an email or date' : ''].filter(Boolean).join(' · ') : '';
  return '<div class="lc-crm-strip">' + CMP_ICON_CLOCK + '<div class="main">' + crmStartupLine_() + (notes ? '<small>' + lcEsc_(notes) + '</small>' : '') +
    '<small>Startup dates follow the portal’s schedule, so reschedules move the emails too.</small></div>' +
    (lcCan_('edit_contacts') ? '<button class="lc-btn sm" data-act="crm-sync"' + (CRM.busy ? ' disabled' : '') + '>' + LC_ICON.refresh + 'Sync now</button>' : '') + '</div>';
}

// ── Contacts → Sales Hub leads ────────────────────────────────────────────────
function crmOpenLeads_() {
  const layer = document.createElement('div');
  layer.className = 'lc-layer';
  layer.innerHTML = '<div class="lc-scrim lc-sheet-scrim" data-crm="close"></div><section class="lc-imp" role="dialog" aria-modal="true" aria-label="Sales Hub leads"></section>';
  document.body.appendChild(layer);
  CRM.layer = layer; CRM.check = null;
  layer.addEventListener('click', crmOnClick_);
  layer.addEventListener('change', async e => {
    if (!e.target.matches('[data-crm-keep]')) return;
    CRM.keep = e.target.checked; crmRenderLeads_();
    const r = await crmApi_('POST', { stage: 'set_auto', auto: CRM.keep }).catch(() => ({ ok: false }));
    lcToast_(r.ok ? (CRM.keep ? 'MCP leads are added automatically' : 'Automatic adding is off') : 'Couldn’t save that', !r.ok);
  });
  document.addEventListener('keydown', crmKey_);
  crmRenderLeads_();
  crmLoad_(r => {
    const saved = r.ok && r.rule;
    CRM.rule = saved ? { lead_sources: saved.lead_sources || [], year_built: saved.year_built || 'any', areas: saved.areas || [], group: saved.group || 'B' }
      : { lead_sources: [], year_built: 'any', areas: [], group: 'B' };
    CRM.keep = !!(r.ok && r.auto);
    crmRenderLeads_();
  });
}
function crmKey_(e) { if (e.key === 'Escape') crmClose_(); }
function crmClose_(changed) {
  if (!CRM.layer || CRM.busy) return;
  CRM.layer.remove(); CRM.layer = null;
  document.removeEventListener('keydown', crmKey_);
  if (changed) { LC.contacts = null; lcRefresh_(true); }
}

function crmRenderLeads_() {
  if (!CRM.layer) return;
  const el = CRM.layer.querySelector('.lc-imp'), d = CRM.data, R = CRM.rule;
  const head = '<header class="lc-imp-h"><div><h2>MCP leads</h2><small class="lc-sub">Every lead imported into the Sales Hub is an MCP lead. They go to Needs review; nobody is emailed until a batch starts them.</small></div>' +
    '<button class="lc-icon-btn" data-crm="close" aria-label="Close">' + LC_ICON.x + '</button></header>';
  if (!d || !R) { el.innerHTML = head + '<div class="lc-imp-body"><div class="lc-sk" style="height:90px"></div><div class="lc-sk" style="height:220px"></div></div>'; return; }
  const b = d.breakdown;
  const chips = (key, counts, label, fmt) => {
    const items = Object.entries(counts).sort((x, y) => y[1] - x[1]);
    if (!items.length) return '';
    return '<div class="lc-fld"><span>' + label + '</span><div class="lc-chips">' + items.map(([v, n]) => '<button class="lc-chip' + (R[key].includes(v) ? ' on' : '') +
      '" data-crm="chip" data-key="' + key + '" data-val="' + lcEsc_(v) + '">' + lcEsc_(fmt ? fmt(v) : v) + ' <small>' + n + '</small></button>').join('') + '</div></div>';
  };
  const SRC = { mcp: 'MCP lists', import: 'Imported lists', unknown: 'Imported before Aug 25', other_list: 'Other lists', service_request: 'Service requests', one_time_job: 'One-time jobs' };
  const M = d.mcp_leads || {};
  const seg = '<div class="lc-seg">' + [['any', 'Any', b.leads], ['with', 'Has year built', b.year_built.with], ['without', 'No year built', b.year_built.without]].map(([v, l, n]) =>
    '<button data-crm="year" data-val="' + v + '" class="' + (R.year_built === v ? 'on' : '') + '">' + l + ' <small>' + n + '</small></button>').join('') + '</div>';
  const C = CRM.check;
  const tile = (n, l) => '<div><b>' + (n || 0) + '</b><span>' + l + '</span></div>';
  const result = !C ? '<p class="lc-note">Check who would be added before adding them, or let automatic adding take care of it.</p>'
    : C.error ? '<div class="lc-wiz-warn">' + LC_ICON.alert + '<div><b>Couldn’t check</b><small>' + lcEsc_(C.error) + '</small></div></div>'
    : '<div class="lc-imp-sum">' + tile(C.summary.new, 'New: will be added') + tile(C.summary.existing, 'Already here') + tile(C.summary.customer, 'Customers: skipped') +
      tile(C.summary.opted_out, 'Opted out: skipped') + tile((C.summary.possible_duplicate || 0) + (C.summary.same_person || 0), 'Possible duplicates: added for review') + '</div>' +
      (C.rows.filter(r => r.status === 'new').length ? '<div class="lc-card"><table class="lc-table"><tbody>' + C.rows.filter(r => r.status === 'new').slice(0, 60).map(r =>
        '<tr><td class="lc-fit"><div class="lc-person"><span class="lc-avatar">' + lcEsc_(lcInitials_(r.first_name, r.last_name)) + '</span><div><b>' + lcEsc_([r.first_name, r.last_name].filter(Boolean).join(' ') || r.email_norm) +
        '</b><small>' + lcEsc_(r.email_norm) + '</small></div></div></td></tr>').join('') + '</tbody></table></div>' +
        (C.summary.new > 60 ? '<p class="lc-note">and ' + (C.summary.new - 60) + ' more</p>' : '') : '');
  const n = C && !C.error ? (C.summary.new || 0) : (M.new || 0);
  el.innerHTML = head + '<div class="lc-imp-body">' +
    '<div class="lc-crm-auto"><div class="main"><b>' + (M.new || 0) + ' MCP lead' + (M.new === 1 ? '' : 's') + ' not added yet</b><small>' + b.leads + ' leads in the Sales Hub · ' + (M.existing || 0) +
      ' already here · ' + ((M.customer || 0) + (M.opted_out || 0) + (M.same_person || 0)) + ' skipped (customers, opted out, duplicates)</small></div>' +
      '<label class="lc-check"><input type="checkbox" data-crm-keep' + (CRM.keep ? ' checked' : '') + '> Add new MCP leads automatically</label></div>' +
    '<details class="lc-crm-more"' + (d.rule && JSON.stringify(d.rule.lead_sources) !== JSON.stringify(['mcp', 'import', 'unknown']) ? ' open' : '') + '><summary>Which leads count as MCP leads</summary>' +
    '<div class="lc-imp-row"><div class="lc-fld"><span>Campaign</span><div class="lc-seg"><button class="on">MCP Legacy</button></div></div><div class="lc-fld"><span>Year built</span>' + seg + '</div></div>' +
    chips('lead_sources', b.by_source, 'Where they came from', v => SRC[v] || v) + chips('areas', b.by_area, 'Area') +
    '</details>' +
    '<div><button class="lc-btn" data-crm="check"' + (CRM.busy ? ' disabled' : '') + '>' + (CRM.busy && !C ? 'Checking…' : 'See who would be added') + '</button></div>' + result +
    '<div class="lc-imp-f"><span class="lc-dim">' + (CRM.keep ? 'New MCP leads are added every morning and when this page opens.' : 'Automatic adding is off.') + '</span>' +
    '<button class="lc-btn primary" data-crm="add"' + (n && !CRM.busy ? '' : ' disabled') + '>' + (CRM.busy && n ? 'Adding…' : 'Add ' + n + ' to Needs review') + '</button></div></div>';
}

async function crmOnClick_(e) {
  const t = e.target.closest('[data-crm]'); if (!t) return;
  const a = t.dataset.crm, R = CRM.rule;
  if (a === 'close') return crmClose_(CRM.added);
  if (!R) return;
  if (a === 'chip') { const l = R[t.dataset.key], v = t.dataset.val, i = l.indexOf(v); if (i === -1) l.push(v); else l.splice(i, 1); CRM.check = null; return crmRenderLeads_(); }
  if (a === 'year') { R.year_built = t.dataset.val; CRM.check = null; return crmRenderLeads_(); }
  if (a === 'check') {
    CRM.busy = true; crmRenderLeads_();
    const r = await crmApi_('POST', { stage: 'check', rule: R }).catch(() => ({ ok: false, error: 'Network error' }));
    CRM.busy = false; CRM.check = r.ok ? r : { error: r.error || 'That didn’t work' };
    return crmRenderLeads_();
  }
  if (a === 'add') {
    const n = CRM.check && CRM.check.summary ? CRM.check.summary.new : ((CRM.data && CRM.data.mcp_leads) || {}).new || 0;
    if (!await lcConfirm_({ title: 'Add ' + n + ' leads to Needs review?', ok: 'Add',
      body: 'They wait in Needs review for MCP Legacy. Nobody is emailed until you start a batch.' + (CRM.keep ? ' New matching leads are added every morning.' : '') })) return;
    CRM.busy = true; crmRenderLeads_();
    const r = await crmApi_('POST', { stage: 'add', rule: R, keep_in_sync: CRM.keep }).catch(() => ({ ok: false, error: 'Network error' }));
    CRM.busy = false;
    if (!r.ok) { lcToast_(r.error || 'That didn’t work', true); return crmRenderLeads_(); }
    CRM.added = true;
    lcToast_(r.added + ' added to Needs review' + (CRM.keep ? ' · keeping in sync' : ''));
    crmClose_(true);
  }
}
