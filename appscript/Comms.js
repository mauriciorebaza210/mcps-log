// Comms.js — Mass email communications for the MCPS Portal.
// Dependencies (shared GAS global scope): validateToken/hasRole (UserAuth.js),
// jsonResponse_ (WebhookReceiver.js).
//
// PHASE 1: pluggable send engine + diagnostic.
//   - sendCommsEmail_(msg)          single choke point for all comms email
//   - commsTestSendDiagnostic()     editor-runnable self-test
//   - handleCommsTestSend_(auth)    doPost action (admin/manager)
// Later phases add audience resolution, campaigns, the sweeper, and unsubscribe.

// ─── Config helpers ──────────────────────────────────────────────────────────
function commsProps_()    { return PropertiesService.getScriptProperties(); }
function commsSendMode_()  { return commsProps_().getProperty('COMMS_SEND_MODE') || 'gmail'; }
var COMMS_FROM_NAME = 'Mission Custom Pool Solutions';

// ─── Lanes: transport is chosen by CATEGORY, not by one global mode ──────────
// Marketing and announcements are bulk mail. They must not leave from an
// individual's mailbox: a cold list's bounces and complaints would land on the
// reputation of the person whose 1:1 sales mail needs to arrive, and GmailApp
// cannot set the List-Unsubscribe header bulk senders are expected to provide.
// Service updates stay 'personal' — a reschedule notice should read as coming
// from the human who owns that route.
function commsLaneForCategory_(category) {
  var c = String(category || '').toLowerCase();
  return (c === 'marketing' || c === 'announcement') ? 'bulk' : 'personal';
}

// The bulk lane may use a different transport than the rest of the system, so a
// cold-list send can move to a dedicated sending domain without touching how
// service updates go out. Falls back to COMMS_SEND_MODE when unset.
function commsTransportForLane_(lane) {
  if (lane === 'bulk') {
    return commsProps_().getProperty('COMMS_SEND_MODE_BULK') || commsSendMode_();
  }
  return commsSendMode_();
}

// ─── Send abstraction: the ONLY place comms email leaves the system ──────────
// msg: { to, subject, htmlBody, plainBody, recipientId }
// returns { ok, provider, providerMessageId, error }
function sendCommsEmail_(msg) {
  // Transport is pinned by the caller where one exists: campaigns resolve it once
  // at creation and pass it back in, so flipping COMMS_SEND_MODE while a campaign
  // is draining cannot split it across two transports mid-flight.
  var mode = (msg && msg.transport) || commsSendMode_();
  try {
    // A campaign locked to a per-person sender always goes through that person's
    // sender script, whatever the mode — the mode picks the shared transport, and
    // this message has already been assigned a specific mailbox.
    if (msg && msg.senderScriptUrl) return commsSendViaSenderScript_(msg);
    if (mode === 'resend') return commsSendViaResend_(msg);
    if (mode === 'zapier') return commsSendViaZapier_(msg);
    return commsSendViaGmail_(msg);
  } catch (err) {
    return { ok: false, provider: mode, providerMessageId: '', error: String((err && err.message) || err) };
  }
}

function commsSendViaGmail_(msg) {
  var opts = { name: COMMS_FROM_NAME };
  if (msg.htmlBody) opts.htmlBody = msg.htmlBody;
  GmailApp.sendEmail(msg.to, msg.subject, msg.plainBody || ' ', opts);
  return { ok: true, provider: 'gmail', providerMessageId: '' };
}

function commsSendViaResend_(msg) {
  var key = commsProps_().getProperty('RESEND_API_KEY');
  if (!key) return { ok: false, provider: 'resend', providerMessageId: '', error: 'RESEND_API_KEY not set' };
  var from = commsProps_().getProperty('COMMS_RESEND_FROM')
    || (COMMS_FROM_NAME + ' <noreply@mcpoolsolutions.org>');
  var headers = { 'Authorization': 'Bearer ' + key };
  // Idempotency-Key prevents provider-side double-delivery on retries (24h window).
  if (msg.recipientId) headers['Idempotency-Key'] = String(msg.recipientId);
  var res = UrlFetchApp.fetch('https://api.resend.com/emails', {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify({
      from: from, to: [msg.to], subject: msg.subject,
      html: msg.htmlBody || '', text: msg.plainBody || ''
    }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) {}
  if (code >= 200 && code < 300) {
    return { ok: true, provider: 'resend', providerMessageId: body.id || '' };
  }
  return { ok: false, provider: 'resend', providerMessageId: '',
           error: 'Resend HTTP ' + code + ': ' + res.getContentText().slice(0, 300) };
}

function commsSendViaZapier_(msg) {
  var hook = commsProps_().getProperty('COMMS_ZAPIER_WEBHOOK');
  if (!hook) return { ok: false, provider: 'zapier', providerMessageId: '', error: 'COMMS_ZAPIER_WEBHOOK not set' };
  var res = UrlFetchApp.fetch(hook, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      to: msg.to, subject: msg.subject,
      html_body: msg.htmlBody || '', text_body: msg.plainBody || ''
    }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code >= 200 && code < 300) return { ok: true, provider: 'zapier', providerMessageId: '' };
  return { ok: false, provider: 'zapier', providerMessageId: '', error: 'Zapier HTTP ' + code };
}

// ─── Config status (presence only — never returns secret values) ─────────────
function commsConfigStatus_() {
  var p = commsProps_();
  var mode = commsSendMode_();
  var missing = [];
  if (mode === 'resend' && !p.getProperty('RESEND_API_KEY'))     missing.push('RESEND_API_KEY');
  if (mode === 'zapier' && !p.getProperty('COMMS_ZAPIER_WEBHOOK')) missing.push('COMMS_ZAPIER_WEBHOOK');
  // Renders in every campaign footer. Unset used to mean customers saw a debug
  // string; now it means the line is missing, which is still worth fixing.
  if (!p.getProperty('COMMS_BUSINESS_ADDRESS')) missing.push('COMMS_BUSINESS_ADDRESS');
  var quota = -1;
  try { quota = MailApp.getRemainingDailyQuota(); } catch (e) {}
  return {
    mode: mode,
    missing_properties: missing,
    gmail_remaining_quota: quota,
    resend_webhook_ingestion_configured: !!p.getProperty('COMMS_RESEND_WEBHOOK_SECRET'),
    // Phase 0 safety check: confirm the migrated visit-report webhook is readable.
    visit_report_webhook_set: !!p.getProperty('VISIT_REPORT_ZAPIER_WEBHOOK')
  };
}

// ─── Sender identity diagnostic (read-only — sends nothing) ──────────────────
// Answers "whose Gmail account actually sends?" without a test send.
//
// Two facts do the work:
//   1. Session.getEffectiveUser() is the account GmailApp sends as. Under the
//      manifest's executeAs=USER_DEPLOYING this is the deploying account for
//      every web-app call, regardless of which portal user is logged in.
//   2. ScriptApp.getProjectTriggers() only ever returns triggers owned by the
//      EFFECTIVE user. Triggers installed by a different account are invisible
//      here. So "guard trigger not visible while campaigns still finish" is
//      proof that some other account owns the sweeper — and therefore sends the
//      queued remainder of every campaign from its own mailbox and quota.
//
// Run it both ways and compare: commsWhoSends() in the editor reports the
// EDITOR user; the comms_sender_identity action reports the DEPLOYING user.
function commsSenderIdentity_() {
  var out = {
    send_mode: commsSendMode_(),
    effective_user: '',
    active_user: '',
    gmail_remaining_quota: -1,
    gmail_aliases: [],
    gmail_aliases_error: '',
    sweep_triggers_visible: [],
    guard_trigger_visible: false,
    guard_owner: '',
    guard_beat_age_ms: null,
    guard_conflict: '',
    triggers_error: '',
    interpretation: ''
  };
  // Recorded in script properties (shared across accounts) precisely because
  // triggers are not — this is the only cross-account view of who sweeps.
  try {
    out.guard_owner = commsGuardOwner_();
    out.guard_beat_age_ms = commsGuardBeatAge_();
    out.guard_conflict = String(commsProps_().getProperty(COMMS_GUARD_CONFLICT_PROP) || '');
  } catch (e) {}
  // The identity Gmail sends as. This is the answer to the sender question.
  try { out.effective_user = String(Session.getEffectiveUser().getEmail() || ''); }
  catch (e) { out.effective_user = 'unavailable: ' + String((e && e.message) || e); }
  // Blank under ANYONE_ANONYMOUS access — expected, and itself confirms that the
  // caller's Google identity never reaches the send path.
  try { out.active_user = String(Session.getActiveUser().getEmail() || ''); } catch (e) {}
  // Per-account daily cap: differing numbers across runs prove differing senders.
  try { out.gmail_remaining_quota = MailApp.getRemainingDailyQuota(); } catch (e) {}
  // Available send-as aliases price the "visible staff sender" option: GmailApp
  // accepts a `from` only for addresses listed here. An error means the alias
  // route needs an extra Gmail scope (and so a re-authorization by every user).
  try { out.gmail_aliases = GmailApp.getAliases() || []; }
  catch (e) { out.gmail_aliases_error = String((e && e.message) || e); }

  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      var handler = t.getHandlerFunction();
      if (handler !== 'commsSweep_' && handler !== 'commsSweepGuard_') return;
      if (handler === 'commsSweepGuard_') out.guard_trigger_visible = true;
      out.sweep_triggers_visible.push({
        handler: handler,
        unique_id: t.getUniqueId(),
        event_type: String(t.getEventType())
      });
    });
  } catch (e) {
    out.triggers_error = String((e && e.message) || e);
  }

  if (out.guard_conflict) {
    out.interpretation = 'CONFLICT: hourly sweep guards are held by two accounts (' + out.guard_conflict
      + '). Whichever fires first sends queued campaign mail, so the From address is not deterministic. '
      + 'Delete the surplus guard from the account that should not be sending.';
  } else if (out.guard_trigger_visible) {
    out.interpretation = 'This account (' + out.effective_user
      + ') owns the hourly sweep guard, so it sends queued campaign mail.';
  } else if (out.guard_owner) {
    out.interpretation = 'The hourly sweep guard is owned by ' + out.guard_owner
      + ', not by ' + out.effective_user + ', so that account sends queued campaign mail '
      + 'from its own mailbox and quota.';
  } else {
    out.interpretation = 'No sweep guard visible to ' + out.effective_user + ' and none recorded. '
      + 'If campaigns still complete after their first pass, another account owns the sweeper '
      + 'and sends the remainder from its own mailbox and quota.';
  }
  return out;
}

// Editor-runnable: reports the identity of whoever clicks Run.
function commsWhoSends() {
  var info = commsSenderIdentity_();
  Logger.log(JSON.stringify(info, null, 2));
  return info;
}

// doPost action: reports the deploying identity (executeAs=USER_DEPLOYING).
function handleCommsSenderIdentity_(auth) {
  var info = commsSenderIdentity_();
  info.ok = true;
  info.requested_by = (auth && (auth.username || auth.email)) ? String(auth.username || auth.email) : '';
  info.requested_by_email = (auth && auth.email) ? String(auth.email) : '';
  return info;
}

// ─── Diagnostic: send one email to a fixed recipient, report result + config ──
function commsTestSendDiagnostic_(toEmail) {
  var status = commsConfigStatus_();
  if (!toEmail) return { ok: false, error: 'No recipient email available', config: status };
  var send = sendCommsEmail_({
    to: toEmail,
    subject: 'MCPS Communications — test send',
    plainBody: 'Test send from the MCPS Communications engine (mode: ' + status.mode + '). '
             + 'If you received this, sending works.',
    htmlBody: '<p>Test send from the <strong>MCPS Communications</strong> engine '
            + '(mode: ' + status.mode + ').</p><p>If you received this, sending works.</p>'
  });
  return {
    ok: send.ok,
    error: send.error || '',
    provider: send.provider,
    sent_to: toEmail,
    config: status
  };
}

// Editor-runnable: sends to the COMMS_TEST_RECIPIENT script property, which may
// be a single email or a COMMA-SEPARATED list (test several addresses in one run).
// Falls back to an external Gmail so delivery is verified OUTSIDE the Workspace
// domain. Use this to answer the "stuck in outbox" question from the editor.
function commsTestSendDiagnostic() {
  var raw = commsProps_().getProperty('COMMS_TEST_RECIPIENT') || 'mauriciorebazaf@gmail.com';
  var recipients = raw.split(',').map(function (s) { return s.trim(); }).filter(String);
  var results = recipients.map(function (to) { return commsTestSendDiagnostic_(to); });
  Logger.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
}

// ─── doPost action: comms_test_send (admin/manager) ──────────────────────────
// Recipient is the caller's own account email (server-derived from the validated
// session) — never a client-supplied address — so this can't be abused to send
// to arbitrary recipients.
function handleCommsTestSend_(auth) {
  var to = (auth && auth.email) ? String(auth.email).trim() : '';
  if (!to) {
    return { ok: false, error: 'Your user account has no email address; add one in Admin to receive the test.',
             config: commsConfigStatus_() };
  }
  return commsTestSendDiagnostic_(to);
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2 — Data layer + audience resolution
// ═══════════════════════════════════════════════════════════════════════════

var COMMS_CRM_SS_ID    = "1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E";
var COMMS_ROUTES_SS_ID = "1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM";
var COMMS_TZ           = "America/Chicago";
var COMMS_EMAIL_RE     = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Sheet definitions (created on the bound spreadsheet if missing).
var COMMS_SHEETS = {
  templates: { name: 'Comms_Templates', headers:
    ['template_id','name','subject','body_markup','category','created_by','created_at','updated_at'] },
  // A segment stores a FILTER (definition_json), never a member list. That is what
  // keeps the compose screen's late-binding contract intact: an uncurated segment
  // send re-resolves at send time, so a campaign scheduled for next Tuesday reaches
  // whoever has gone cold by then. last_count is a cached display value only —
  // never the thing that gets mailed. See appscript/LeadSegments.js.
  segments: { name: 'Comms_Segments', headers:
    ['segment_id','name','definition_json','created_by','created_at','updated_at',
     'last_count','last_counted_at'] },
  // sender_* on campaigns is the LOCKED sender: resolved once at creation and
  // never recomputed, so a registry edit mid-flight cannot change who the
  // remaining recipients hear from.
  campaigns: { name: 'Comms_Campaigns', headers:
    ['campaign_id','name','category','subject','body_markup','audience_json','status','send_at','provider','lane',
     'created_by','created_at','started_at','finished_at',
     'total_recipients','sendable_count','sent_count','failed_count','skipped_count','daily_cap',
     'sender_key','sender_email','sender_script_url'] },
  // sender_email on the log is what ACTUALLY sent that row, as reported back by
  // the sender script — deliberately separate from the campaign's intent.
  log: { name: 'Comms_Log', headers:
    ['recipient_id','unsubscribe_token','campaign_id','email','name','quote_id','pool_id','recipient_json',
     'status','error','attempt_started_at','attempt_count','next_attempt_at','provider','provider_message_id','sent_at',
     'bounce_reason','complaint_at','opened_at','clicked_at','sender_email'] },
  senders: { name: 'Comms_Senders', headers:
    ['username','sender_email','sender_name','sender_script_url','active','added_at','notes'] },
  optouts: { name: 'Comms_Optouts', headers:
    ['email','scope','opted_out_at','source','recipient_id'] }
};

// Returns the sheet, creating it (frozen header row) if missing. Also appends
// any headers that were added to the definition after the sheet was first
// created (schema evolution) — new columns go at the end, and all row helpers
// read the ACTUAL header row by name, so column order never matters.
function commsSheet_(key) {
  var def = COMMS_SHEETS[key];
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(def.name);
  if (!sheet) {
    sheet = ss.insertSheet(def.name);
    sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  var lastCol = sheet.getLastColumn();
  var existing = lastCol >= 1
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return huHeader_(h); })
    : [];
  var missing = def.headers.filter(function (h) { return existing.indexOf(h) === -1; });
  if (missing.length) sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
  return sheet;
}

// Actual header names (normalized) in the order they appear in the sheet.
function commsActualHeaders_(sheet) {
  var lc = sheet.getLastColumn();
  if (lc < 1) return [];
  return sheet.getRange(1, 1, 1, lc).getValues()[0].map(function (h) { return huHeader_(h); });
}

// Ensures every comms sheet exists. Safe to call repeatedly, and additive:
// adding a key to COMMS_SHEETS is all a new sheet needs.
function commsEnsureSheets_() {
  Object.keys(COMMS_SHEETS).forEach(function (k) { commsSheet_(k); });
}

// Header → index map for a sheet's first row (normalized like the rest of the app).
function commsHeaderIndex_(sheet) {
  var last = sheet.getLastColumn();
  if (last < 1) return {};
  var headers = sheet.getRange(1, 1, 1, last).getValues()[0];
  var map = {};
  headers.forEach(function (h, i) { map[huHeader_(h)] = i; });
  return map;
}

function commsNorm_(v) { return String(v == null ? '' : v).trim(); }

// ─── Opt-out set for a campaign category (email → blocked) ───────────────────
function commsScopeBlocks_(scope, category) {
  scope = String(scope || 'all').toLowerCase();
  if (scope === 'all') return true;
  if (scope === 'marketing_announcements') return (category === 'marketing' || category === 'announcement');
  return false;
}

function commsOptOutSet_(category) {
  var sheet = commsSheet_('optouts');
  var set = {};
  if (sheet.getLastRow() < 2) return set;
  var data = sheet.getDataRange().getValues();
  var h = {}; data[0].forEach(function (x, i) { h[huHeader_(x)] = i; });
  if (h.email == null) return set;
  for (var i = 1; i < data.length; i++) {
    var email = commsNorm_(data[i][h.email]).toLowerCase();
    if (!email) continue;
    var scope = h.scope != null ? data[i][h.scope] : 'all';
    if (commsScopeBlocks_(scope, category)) set[email] = true;
  }
  return set;
}

// ─── Pool_id → CRM info lookup (email, name, quote_id, area) ──────────────────
function commsPoolCrmLookup_() {
  var ss = SpreadsheetApp.openById(COMMS_CRM_SS_ID);
  var sheet = ss.getSheetByName('Quotes');
  if (!sheet || sheet.getLastRow() < 2) return {};
  var data = sheet.getDataRange().getValues();
  var h = {}; data[0].forEach(function (x, i) { h[huHeader_(x)] = i; });
  if (h.pool_id == null) return {};
  var lookup = {};
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var pid = commsNorm_(row[h.pool_id]);
    if (!pid) continue;
    var first = h.first_name != null ? commsNorm_(row[h.first_name]) : '';
    var last  = h.last_name  != null ? commsNorm_(row[h.last_name])  : '';
    lookup[pid.toUpperCase()] = {
      email: h.email != null ? commsNorm_(row[h.email]) : '',
      first_name: first,
      last_name: last,
      customer_name: h.customer_name != null ? commsNorm_(row[h.customer_name]) : (first + ' ' + last).trim(),
      quote_id: h.quote_id != null ? commsNorm_(row[h.quote_id]) : '',
      area: h.area != null ? commsNorm_(row[h.area]) : ''
    };
  }
  return lookup;
}

// ─── route_day recipients: everyone scheduled on <day> (generalized from
//     getTodaysRouteEmails). day = weekday name ("Tuesday"); weekStart optional
//     (defaults to current week); operator optional ("all"/blank = everyone). ──
function commsRouteDayRecipients_(day, weekStart, operator) {
  day = commsNorm_(day);
  if (!day) return [];
  weekStart = commsNorm_(weekStart) || huWeekStart_(new Date());
  var crm = commsPoolCrmLookup_();
  var seen = {};
  var out = [];

  function addStop_(stop) {
    var pid = commsNorm_(stop.pool_id);
    if (!pid) return;
    var key = pid.toUpperCase();
    if (seen[key]) return;
    seen[key] = true;
    var c = crm[key] || {};
    out.push({
      email: commsNorm_(c.email),
      first_name: c.first_name || '',
      last_name: c.last_name || '',
      customer_name: commsNorm_(stop.customer_name) || c.customer_name || '',
      area: c.area || '',
      quote_id: c.quote_id || '',
      pool_id: pid,
      address: commsNorm_(stop.address),
      city: commsNorm_(stop.city),
      day: day,
      operator: commsNorm_(stop.operator)
    });
  }

  var ss = SpreadsheetApp.openById(COMMS_ROUTES_SS_ID);
  var routesSheet = ss.getSheetByName('Routes');
  if (routesSheet && routesSheet.getLastRow() > 1) {
    var data = routesSheet.getDataRange().getValues();
    var headers = data[0].map(huHeader_);
    var col = function (n) { return headers.indexOf(n); };
    var overrides = typeof getWeeklyOverrides_ === 'function' ? getWeeklyOverrides_(weekStart) : {};
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var pid = col('pool_id') !== -1 ? commsNorm_(row[col('pool_id')]) : '';
      if (!pid) continue;
      if (typeof isPoolVisibleForWeek_ === 'function' && !isPoolVisibleForWeek_(row, col, weekStart)) continue;
      var baseDay = col('day_of_week') !== -1 ? commsNorm_(row[col('day_of_week')]) : '';
      var baseOp  = col('operator')    !== -1 ? commsNorm_(row[col('operator')])    : '';
      var ov = overrides[pid] || {};
      var d  = ov.day || baseDay;
      var op = ov.operator || baseOp;
      if (d !== day) continue;
      if (!huMatchesOperator_(op, operator)) continue;
      var service = col('service') !== -1 ? commsNorm_(row[col('service')]) : '';
      if (service.toLowerCase().indexOf('monthly') !== -1 && typeof monthlyMatchesWeek_ === 'function') {
        var mw = col('monthly_week') !== -1 ? commsNorm_(row[col('monthly_week')]) : '';
        if (!mw || !monthlyMatchesWeek_(d, mw, weekStart)) continue;
      }
      addStop_({
        pool_id: pid,
        customer_name: col('customer_name') !== -1 ? row[col('customer_name')] : '',
        address: col('address') !== -1 ? row[col('address')] : '',
        city: col('city') !== -1 ? row[col('city')] : '',
        operator: op
      });
    }
  }

  // One-time / scheduled visits falling on that weekday this week.
  if (typeof computeScheduledVisitsForWeek_ === 'function') {
    var res = computeScheduledVisitsForWeek_(weekStart, operator || null);
    var visits = (res && res.ok && res.visits) ? res.visits : [];
    visits.forEach(function (v) {
      var vd = '';
      try { vd = Utilities.formatDate(new Date(v.scheduled_date), COMMS_TZ, 'EEEE'); } catch (e) {}
      if (vd !== day) return;
      addStop_({
        pool_id: v.pool_id,
        customer_name: v.customer_name,
        address: v.address,
        city: v.city,
        operator: v.assigned_technician
      });
    });
  }
  return out;
}

// ─── Match a Quotes row against a non-route audience filter ───────────────────
function commsRowMatchesAudience_(r, type, audience) {
  var status = commsNorm_(r.status).toUpperCase();
  if (type === 'all_active') return status === 'ACTIVE_CUSTOMER';
  if (type === 'status') {
    var wanted = (audience.statuses || []).map(function (s) { return commsNorm_(s).toUpperCase(); });
    return wanted.indexOf(status) !== -1;
  }
  if (type === 'area') {
    var areas = (audience.areas || []).map(function (a) { return commsNorm_(a).toLowerCase(); });
    var okArea = areas.length === 0 || areas.indexOf(commsNorm_(r.area).toLowerCase()) !== -1;
    if (!okArea) return false;
    if (audience.statuses && audience.statuses.length) {
      var st = audience.statuses.map(function (s) { return commsNorm_(s).toUpperCase(); });
      return st.indexOf(status) !== -1;
    }
    return true;
  }
  if (type === 'manual') {
    var ids = (audience.quote_ids || []).map(function (q) { return commsNorm_(q); });
    return ids.indexOf(commsNorm_(r.quote_id)) !== -1;
  }
  if (type === 'segment') {
    // Evaluated against the definition carried ON THE AUDIENCE, not re-read from
    // the segments sheet. Editing a saved segment must not silently redefine what
    // an already-scheduled campaign means — the population is late-bound, the
    // definition is snapshotted at send. See LeadSegments.js.
    if (typeof leadSegmentMatches_ !== 'function') return false;
    return leadSegmentMatches_(r, audience.definition || {});
  }
  return false;
}

// ─── Dedupe by lowercase email, merge properties, flag invalid + opted-out ────
function commsDedupeAndFlag_(raw, category) {
  var optOut = commsOptOutSet_(category);
  var byEmail = {};
  var order = [];
  var invalids = [];

  raw.forEach(function (rec) {
    var email = commsNorm_(rec.email);
    var prop = {
      quote_id: rec.quote_id || '', pool_id: rec.pool_id || '',
      address: rec.address || '', city: rec.city || '',
      day: rec.day || '', operator: rec.operator || '',
      old_day: rec.old_day || '', new_day: rec.new_day || '',
      effective_date: rec.effective_date || '',
      effective_label: rec.effective_label || ''
    };
    var name = [commsNorm_(rec.first_name), commsNorm_(rec.last_name)].filter(String).join(' ')
             || commsNorm_(rec.customer_name);

    if (!email || !COMMS_EMAIL_RE.test(email)) {
      invalids.push({
        email: email, first_name: commsNorm_(rec.first_name), last_name: commsNorm_(rec.last_name),
        name: name, area: commsNorm_(rec.area), quote_id: rec.quote_id || '', pool_id: rec.pool_id || '',
        properties: [prop], invalid: true, opted_out: false
      });
      return;
    }
    var key = email.toLowerCase();
    if (!byEmail[key]) {
      byEmail[key] = {
        email: email, first_name: commsNorm_(rec.first_name), last_name: commsNorm_(rec.last_name),
        name: name, area: commsNorm_(rec.area), quote_id: rec.quote_id || '', pool_id: rec.pool_id || '',
        properties: [prop], invalid: false, opted_out: !!optOut[key]
      };
      order.push(key);
    } else {
      byEmail[key].properties.push(prop);
    }
  });

  var recipients = order.map(function (k) { return byEmail[k]; });
  return { ok: true, recipients: recipients.concat(invalids) };
}

// ─── Resolve an audience spec to deduped, flagged recipient records ───────────
// audience: { type, statuses?, areas?, day?, week_start?, operator?, quote_ids? }
// category: service_update | announcement | marketing  (drives opt-out filtering)
function resolveCommsAudience_(audience, category) {
  audience = audience || {};
  category = commsNorm_(category) || 'service_update';
  var type = audience.type || 'all_active';
  var raw = [];

  // Refused rather than silently resolved: an empty segment definition is valid
  // set logic that means "every lead with an email address", so one unselected
  // dropdown would otherwise send a cold campaign to the entire CRM.
  if (type === 'segment') {
    if (typeof leadSegmentHasPredicate_ !== 'function') {
      return { ok: false, error: 'Segment support is unavailable (LeadSegments.js is not deployed).' };
    }
    if (!leadSegmentHasPredicate_(audience.definition)) {
      return { ok: false, error: 'Choose a segment first — an empty one would match every lead with an email address.' };
    }
  }

  if (type === 'test') {
    // Explicit test addresses — flows through the whole pipeline without touching
    // the CRM. Admin-only (the whole comms surface is admin/manager gated).
    raw = (audience.emails || []).map(commsNorm_).filter(String).map(function (e, i) {
      return { email: e, first_name: 'Test', last_name: String(i + 1), customer_name: 'Test ' + (i + 1),
               area: '', quote_id: '', pool_id: '', address: '123 Test St', city: 'San Antonio',
               day: 'Tuesday', operator: 'Tony' };
    });
  } else if (type === 'selected') {
    // A hand-built list accumulated in the UI across several different filters.
    // The client sends back the recipient records it collected; they are expanded
    // to one raw row per property and run through commsDedupeAndFlag_ like any
    // other source, so dedupe, opt-out and invalid-address checks stay server-side
    // and authoritative — the client can choose WHO, never whether the rules apply.
    (audience.recipients || []).forEach(function (r) {
      if (!r) return;
      var props = (r.properties && r.properties.length) ? r.properties : [{}];
      props.forEach(function (p) {
        p = p || {};
        raw.push({
          email: r.email, first_name: r.first_name, last_name: r.last_name,
          customer_name: r.name, area: r.area,
          quote_id: p.quote_id || r.quote_id || '', pool_id: p.pool_id || r.pool_id || '',
          address: p.address || '', city: p.city || '',
          day: p.day || '', operator: p.operator || '',
          old_day: p.old_day || '', new_day: p.new_day || '',
          effective_date: p.effective_date || '', effective_label: p.effective_label || ''
        });
      });
    });
  } else if (type === 'route_day') {
    raw = commsRouteDayRecipients_(audience.day, audience.week_start, audience.operator);
  } else if (type === 'reschedule_batch') {
    raw = (typeof rsResolveCommsAudience_ === 'function')
      ? rsResolveCommsAudience_(audience)
      : [];
  } else {
    var crm = handleGetCRMData();
    var rows = (crm && crm.ok && crm.data) ? crm.data : [];
    rows.forEach(function (r) {
      if (!commsRowMatchesAudience_(r, type, audience)) return;
      raw.push({
        email: r.email, first_name: r.first_name, last_name: r.last_name,
        customer_name: r.customer_name, area: r.area, quote_id: r.quote_id,
        pool_id: r.pool_id, address: r.address, city: r.city, day: '', operator: ''
      });
    });
  }
  return commsDedupeAndFlag_(raw, category);
}

// ─── doPost action: comms_preview_audience (admin/manager) ────────────────────
function handleCommsPreviewAudience_(payload) {
  commsEnsureSheets_();
  var audience = payload.audience || {};
  var category = payload.category || 'service_update';
  var res = resolveCommsAudience_(audience, category);
  if (!res.ok) return res;
  var recips = res.recipients;
  var sendable = recips.filter(function (r) { return !r.invalid && !r.opted_out; });
  var PREVIEW_CAP = 500;
  // The full record goes back, not just display fields: the compose UI lets you
  // accumulate recipients across several different filters into one list, and it
  // can only send that list back intact if it received it intact. `pools` stays
  // for the existing display code.
  var list = recips.slice(0, PREVIEW_CAP).map(function (r) {
    return {
      email: r.email, name: r.name, area: r.area,
      first_name: r.first_name, last_name: r.last_name,
      quote_id: r.quote_id, pool_id: r.pool_id,
      properties: r.properties,
      pools: r.properties.length,
      invalid: r.invalid, opted_out: r.opted_out
    };
  });
  return {
    ok: true,
    total: recips.length,
    sendable_count: sendable.length,
    invalid_count: recips.filter(function (r) { return r.invalid; }).length,
    opted_out_count: recips.filter(function (r) { return r.opted_out; }).length,
    truncated: recips.length > PREVIEW_CAP,
    recipients: list
  };
}

// Editor-runnable Phase 2 check: logs counts for a few audiences so you can
// verify against the Quotes sheet and the route schedule.
function commsTestPreviewAudience() {
  var out = {
    all_active: (function () { var r = handleCommsPreviewAudience_({ audience: { type: 'all_active' }, category: 'announcement' });
                               return { total: r.total, sendable: r.sendable_count, invalid: r.invalid_count, opted_out: r.opted_out_count }; })(),
    route_tuesday: (function () { var r = handleCommsPreviewAudience_({ audience: { type: 'route_day', day: 'Tuesday' }, category: 'service_update' });
                                  return { total: r.total, sendable: r.sendable_count, invalid: r.invalid_count }; })()
  };
  Logger.log(JSON.stringify(out, null, 2));
}

// ─── Generic sheet-row helpers (key off ACTUAL header row, any column order) ──
function commsSheetRows_(key) {
  var sheet = commsSheet_(key);
  var last = sheet.getLastRow();
  var headers = commsActualHeaders_(sheet);
  if (last < 2 || !headers.length) return [];
  var vals = sheet.getRange(2, 1, last - 1, headers.length).getValues();
  return vals.map(function (row, i) {
    var o = { _row: i + 2 };
    headers.forEach(function (h, idx) { o[h] = row[idx]; });
    return o;
  });
}
function commsAppendRow_(key, obj) {
  var sheet = commsSheet_(key);
  var headers = commsActualHeaders_(sheet);
  sheet.appendRow(headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; }));
  return sheet.getLastRow();
}
// Bulk append (one setValues call) — far faster than N appendRow calls.
function commsAppendRows_(key, objs) {
  if (!objs || !objs.length) return 0;
  var sheet = commsSheet_(key);
  var headers = commsActualHeaders_(sheet);
  var matrix = objs.map(function (obj) {
    return headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, matrix.length, headers.length).setValues(matrix);
  return matrix.length;
}
function commsUpdateRowById_(key, idField, id, patch) {
  var sheet = commsSheet_(key);
  var headers = commsActualHeaders_(sheet);
  var idIdx = headers.indexOf(idField);
  var last = sheet.getLastRow();
  if (idIdx === -1 || last < 2) return false;
  var vals = sheet.getRange(2, 1, last - 1, headers.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][idIdx]) === String(id)) {
      headers.forEach(function (h, idx) { if (patch[h] !== undefined) vals[i][idx] = patch[h]; });
      sheet.getRange(i + 2, 1, 1, headers.length).setValues([vals[i]]);
      return true;
    }
  }
  return false;
}
function commsDeleteRowById_(key, idField, id) {
  var sheet = commsSheet_(key);
  var headers = commsActualHeaders_(sheet);
  var idIdx = headers.indexOf(idField);
  var last = sheet.getLastRow();
  if (idIdx === -1) return false;
  for (var i = last; i >= 2; i--) {
    if (String(sheet.getRange(i, idIdx + 1).getValue()) === String(id)) { sheet.deleteRow(i); return true; }
  }
  return false;
}
// Patch specific columns of one row (by 1-based row number) via header names.
function commsPatchRow_(sheet, headers, rowNum, patch) {
  var range = sheet.getRange(rowNum, 1, 1, headers.length);
  var vals = range.getValues()[0];
  headers.forEach(function (h, idx) { if (patch[h] !== undefined) vals[idx] = patch[h]; });
  range.setValues([vals]);
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 3 — Rendering (limited markup → HTML), branded wrapper, test draft,
//           template CRUD
// ═══════════════════════════════════════════════════════════════════════════

function commsEscapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Placeholder values for a recipient. properties_list is handled separately.
function commsPlaceholderMap_(recipient) {
  var r = recipient || {};
  var props = (r.properties && r.properties.length) ? r.properties : [{}];
  var p0 = props[0] || {};
  return {
    first_name: commsNorm_(r.first_name),
    last_name: commsNorm_(r.last_name),
    name: commsNorm_(r.name) || [commsNorm_(r.first_name), commsNorm_(r.last_name)].filter(String).join(' ') || 'there',
    address: commsNorm_(p0.address),
    city: commsNorm_(p0.city),
    area: commsNorm_(r.area),
    day: commsNorm_(p0.day),
    old_day: commsNorm_(p0.old_day),
    new_day: commsNorm_(p0.new_day || p0.day),
    effective_date: commsNorm_(p0.effective_label || p0.effective_date),
    technician: commsNorm_(p0.operator)
  };
}

// {{properties_list}} → safe HTML <ul> of the recipient's properties.
function commsPropertiesListHtml_(recipient) {
  var props = (recipient && recipient.properties) || [];
  if (!props.length) return '';
  var items = props.map(function (p) {
    var line = [p.address, p.city].filter(String).map(commsEscapeHtml_).join(', ');
    if (p.day) line += ' &mdash; ' + commsEscapeHtml_(p.day);
    return '<li style="margin:0 0 4px;">' + line + '</li>';
  }).join('');
  return '<ul style="margin:0 0 16px;padding-left:20px;color:#222222;">' + items + '</ul>';
}

// Limited markup on an ALREADY-ESCAPED string: **bold**, [text](url) with a
// strict protocol allowlist, blank-line paragraphs, single-newline <br>.
function commsMarkupToHtml_(escaped) {
  var s = String(escaped || '');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, text, url) {
    var low = url.toLowerCase();
    if (low.indexOf('https:') === 0 || low.indexOf('http:') === 0 ||
        low.indexOf('mailto:') === 0 || low.indexOf('tel:') === 0) {
      return '<a href="' + url + '" style="color:#1FA7A8;text-decoration:underline;">' + text + '</a>';
    }
    return text; // disallowed protocol → drop the link, keep the visible text
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return s.split(/\n\s*\n/).map(function (p) {
    return '<p style="margin:0 0 16px;color:#222222;">' + p.replace(/\n/g, '<br>') + '</p>';
  }).join('');
}

// Full body render: substitute placeholders (raw) → escape (inert) → markup →
// inject properties_list. Script injection is structurally impossible.
function commsRenderBody_(markup, recipient) {
  var map = commsPlaceholderMap_(recipient);
  var text = String(markup || '');
  Object.keys(map).forEach(function (k) { text = text.split('{{' + k + '}}').join(map[k]); });
  var html = commsMarkupToHtml_(commsEscapeHtml_(text));
  return html.split('{{properties_list}}').join(commsPropertiesListHtml_(recipient));
}

// Subject: placeholder substitution only, plain text (no markup/HTML).
function commsRenderSubject_(subject, recipient) {
  var map = commsPlaceholderMap_(recipient);
  var text = String(subject || '');
  Object.keys(map).forEach(function (k) { text = text.split('{{' + k + '}}').join(map[k]); });
  return text.split('{{properties_list}}').join('');
}

// Plain-text body for the multipart alt part.
function commsRenderPlain_(markup, recipient) {
  var map = commsPlaceholderMap_(recipient);
  var text = String(markup || '');
  Object.keys(map).forEach(function (k) { text = text.split('{{' + k + '}}').join(map[k]); });
  var propsPlain = ((recipient && recipient.properties) || []).map(function (p) {
    return '- ' + [p.address, p.city].filter(String).join(', ') + (p.day ? ' — ' + p.day : '');
  }).join('\n');
  text = text.split('{{properties_list}}').join(propsPlain);
  return text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
}

// Why this is a property and not a constant: how a lead ended up on the list is
// a business fact that varies by how the list was built, and getting it wrong is
// a compliance problem. Staff can correct the wording without a deploy.
function commsPermissionLine_(category, businessName) {
  var c = String(category || '').toLowerCase();
  if (c === 'marketing' || c === 'announcement') {
    return commsProps_().getProperty('COMMS_MARKETING_PERMISSION_TEXT')
      || 'You are receiving this because you asked us about pool service or joined our San Antonio mailing list.';
  }
  return 'You are receiving this because you are a ' + businessName + ' customer.';
}

// ─── Branded email wrapper (MCPS brand: Primary Teal / Aqua, logo, footer) ───
function commsBrandCfg_() {
  var p = commsProps_();
  return {
    name:    p.getProperty('COMMS_BUSINESS_NAME')    || 'Mission Custom Pool Solutions',
    address: p.getProperty('COMMS_BUSINESS_ADDRESS') || '',
    phone:   p.getProperty('COMMS_BUSINESS_PHONE')   || '(210) 559-2073',
    logo:    p.getProperty('COMMS_LOGO_URL')         || 'https://mcps-log.vercel.app/logo.png',
    website: p.getProperty('COMMS_WEBSITE')          || 'missioncustompools.com'
  };
}

function buildCommsEmailHtml_(innerHtml, opts) {
  opts = opts || {};
  var b = commsBrandCfg_();
  var unsub = opts.unsubscribeUrl || '#';
  // An unset address must NEVER leak a debug string into a customer's inbox.
  // Omitting the line leaves a footer that reads normally; staff are told instead
  // by commsConfigStatus_ / comms_my_sender, i.e. before a send rather than after.
  // Note this leaves commercial email without the postal address CAN-SPAM wants,
  // so the property still needs setting — it is just no longer the customer's problem.
  var addressLine = b.address ? (commsEscapeHtml_(b.address) + '<br>') : '';
  var preheader = opts.preheader ? commsEscapeHtml_(opts.preheader) : '';
  var name = commsEscapeHtml_(b.name);
  // The permission reminder has to be TRUE for whoever receives it. Service
  // updates go to active customers; marketing and announcements go to leads who
  // never bought anything, so telling them they are customers is both false and
  // the fastest way to earn a spam complaint.
  var permission = commsPermissionLine_(opts.category, b.name);
  return '' +
'<!DOCTYPE html><html><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'<meta name="color-scheme" content="light only">' +
'</head>' +
'<body style="margin:0;padding:0;background:#F3F5F6;">' +
(preheader ? '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + preheader + '</div>' : '') +
'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F5F6;">' +
'<tr><td align="center" style="padding:24px 12px;">' +
'<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#FFFFFF;border-radius:8px;overflow:hidden;border:1px solid #E4E8EA;">' +
// Header (logo, full color on white)
'<tr><td align="center" style="padding:28px 24px 16px;background:#FFFFFF;">' +
'<img src="' + b.logo + '" alt="' + name + '" width="200" style="display:block;max-height:56px;width:auto;border:0;">' +
'</td></tr>' +
'<tr><td style="padding:0 24px;"><div style="height:3px;background:#1FA7A8;border-radius:2px;"></div></td></tr>' +
// Body
'<tr><td style="padding:24px;font-family:\'Open Sans\',Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#222222;">' +
innerHtml +
'</td></tr>' +
// Footer (Primary Teal band)
'<tr><td style="padding:20px 24px;background:#0D3D3E;font-family:\'Open Sans\',Arial,Helvetica,sans-serif;">' +
'<div style="font-size:15px;font-weight:bold;color:#FFFFFF;margin-bottom:4px;">' + name + '</div>' +
'<div style="font-size:12px;color:#B9CDCD;line-height:1.5;">' +
'Pool service in San Antonio, TX<br>' +
addressLine +
commsEscapeHtml_(b.phone) + ' &nbsp;&bull;&nbsp; ' + commsEscapeHtml_(b.website) +
'</div>' +
'<div style="font-size:12px;color:#B9CDCD;margin-top:12px;">' +
commsEscapeHtml_(permission) + ' ' +
'<a href="' + unsub + '" style="color:#5ED6D3;text-decoration:underline;">Unsubscribe</a>.' +
'</div>' +
'</td></tr>' +
'</table></td></tr></table></body></html>';
}

// ─── Sample recipient for test-draft/preview rendering ───────────────────────
function commsSampleRecipient_(auth) {
  var first = (auth && auth.first_name) ? auth.first_name : 'Alex';
  var last  = (auth && auth.last_name)  ? auth.last_name  : 'Rivera';
  return {
    email: (auth && auth.email) || 'sample@example.com',
    first_name: first, last_name: last, name: (first + ' ' + last).trim(), area: 'NW',
    properties: [{ quote_id: 'SAMPLE', pool_id: 'SAMPLE', address: '123 Poolside Dr',
                   city: 'San Antonio', day: 'Tuesday', operator: 'Tony' }]
  };
}

// ─── comms_send_test_draft (admin/manager) ───────────────────────────────────
// Renders the real branded email with a sample recipient and sends it ONLY to
// the caller's own account email. Logged as a TEST_DRAFT row (auditable, never
// touches Comms_Campaigns). Returns the rendered HTML so the UI can preview it.
function handleCommsSendTestDraft_(auth, payload) {
  commsEnsureSheets_();
  // Primary: the caller's own account email (server-derived, not client-supplied).
  // Fallback (when the account has no email on file): the server-side
  // COMMS_TEST_RECIPIENT property — still not client-supplied, so the endpoint
  // still can't be pointed at an arbitrary address by a request.
  var to = (auth && auth.email) ? String(auth.email).trim() : '';
  if (!to) {
    to = String(commsProps_().getProperty('COMMS_TEST_RECIPIENT') || '').split(',')[0].trim();
  }
  if (!to) {
    return { ok: false, error: 'No test recipient: your account has no email on file and COMMS_TEST_RECIPIENT is not set.' };
  }
  var sample = payload.sample || commsSampleRecipient_(auth);
  var subject = commsRenderSubject_(payload.subject || '(no subject)', sample);
  var innerHtml = commsRenderBody_(payload.body_markup || '', sample);
  // Category matters here: the footer's permission line differs between a service
  // update and marketing, and a test that shows the wrong one is not a test.
  var testCategory = commsNorm_(payload.category) || 'service_update';
  var html = buildCommsEmailHtml_(innerHtml,
    { unsubscribeUrl: '#unsubscribe-preview', preheader: subject, category: testCategory });
  var plain = commsRenderPlain_(payload.body_markup || '', sample);
  var send = sendCommsEmail_({ to: to, subject: '[TEST] ' + subject, htmlBody: html, plainBody: plain,
                               recipientId: Utilities.getUuid(),
                               transport: commsTransportForLane_(commsLaneForCategory_(testCategory)) });
  var now = new Date().toISOString();
  commsAppendRow_('log', {
    recipient_id: Utilities.getUuid(), unsubscribe_token: '', campaign_id: 'TEST_DRAFT',
    email: to, name: (auth && auth.name) || '', status: send.ok ? 'sent' : 'failed',
    error: send.error || '', attempt_started_at: now, attempt_count: 1,
    provider: send.provider, provider_message_id: send.providerMessageId || '', sent_at: send.ok ? now : ''
  });
  return { ok: send.ok, error: send.error || '', sent_to: to, subject: subject, html: html };
}

// Render-only preview (no send) — used by the UI's live preview pane.
function handleCommsPreviewRender_(payload) {
  var sample = payload.sample || commsSampleRecipient_(null);
  var innerHtml = commsRenderBody_(payload.body_markup || '', sample);
  return {
    ok: true,
    subject: commsRenderSubject_(payload.subject || '', sample),
    html: buildCommsEmailHtml_(innerHtml,
      { unsubscribeUrl: '#unsubscribe-preview', category: commsNorm_(payload.category) || 'service_update' })
  };
}

// ─── Template CRUD ───────────────────────────────────────────────────────────
function handleCommsSaveTemplate_(auth, payload) {
  commsEnsureSheets_();
  var t = payload.template || {};
  var now = new Date().toISOString();
  var by = (auth && (auth.name || auth.username)) || '';
  if (t.template_id) {
    var ok = commsUpdateRowById_('templates', 'template_id', t.template_id, {
      name: t.name || '', subject: t.subject || '', body_markup: t.body_markup || '',
      category: t.category || 'service_update', updated_at: now
    });
    if (!ok) return { ok: false, error: 'Template not found' };
    return { ok: true, template_id: t.template_id };
  }
  var id = Utilities.getUuid();
  commsAppendRow_('templates', {
    template_id: id, name: t.name || '', subject: t.subject || '', body_markup: t.body_markup || '',
    category: t.category || 'service_update', created_by: by, created_at: now, updated_at: now
  });
  return { ok: true, template_id: id };
}

function handleCommsDeleteTemplate_(payload) {
  commsEnsureSheets_();
  var id = payload.template_id || (payload.template && payload.template.template_id);
  if (!id) return { ok: false, error: 'template_id required' };
  return { ok: commsDeleteRowById_('templates', 'template_id', id) ? true : false,
           error: '' };
}

function handleCommsListTemplates_() {
  commsEnsureSheets_();
  var rows = commsSheetRows_('templates').map(function (r) {
    return { template_id: r.template_id, name: r.name, subject: r.subject,
             body_markup: r.body_markup, category: r.category, updated_at: r.updated_at };
  });
  return { ok: true, templates: rows };
}

// ─── Central comms action router (called from WebhookReceiver doPost) ────────
// All actions here are already token-validated and admin/manager-gated.
function handleCommsAction_(action, auth, payload) {
  switch (action) {
    case 'comms_test_send':        return handleCommsTestSend_(auth);
    case 'comms_sender_identity':  return handleCommsSenderIdentity_(auth);
    case 'comms_sender_probe':     return handleCommsSenderProbe_(auth, payload);
    case 'comms_list_senders':     return handleCommsListSenders_();
    case 'comms_my_sender':        return handleCommsMySender_(auth);
    case 'comms_preview_audience': return handleCommsPreviewAudience_(payload);
    case 'comms_preview_render':   return handleCommsPreviewRender_(payload);
    case 'comms_send_test_draft':  return handleCommsSendTestDraft_(auth, payload);
    case 'comms_save_template':    return handleCommsSaveTemplate_(auth, payload);
    case 'comms_delete_template':  return handleCommsDeleteTemplate_(payload);
    case 'comms_list_templates':   return handleCommsListTemplates_();
    case 'comms_send_campaign':    return handleCommsSendCampaign_(auth, payload);
    case 'comms_cancel_campaign':  return handleCommsCancelCampaign_(payload);
    case 'comms_list_campaigns':   return handleCommsListCampaigns_();
    case 'comms_campaign_detail':  return handleCommsCampaignDetail_(payload);
    case 'comms_add_optout':       return handleCommsAddOptout_(payload);
    case 'comms_remove_optout':    return handleCommsRemoveOptout_(payload);
    case 'comms_list_optouts':     return handleCommsListOptouts_();
    // Cold-list segmentation (appscript/LeadSegments.js). The comms_ prefix means
    // these inherit the existing admin/manager gate with no routing changes.
    case 'comms_cold_audit':       return handleLeadColdAudit_(payload);
    case 'comms_list_segments':    return handleLeadListSegments_();
    case 'comms_save_segment':     return handleLeadSaveSegment_(auth, payload);
    case 'comms_delete_segment':   return handleLeadDeleteSegment_(payload);
    case 'comms_count_segment':    return handleLeadCountSegment_(payload);
    case 'comms_selftest_crash':   return handleCommsSelftestCrash_(payload);
    case 'comms_selftest_schedule': return handleCommsSelftestSchedule_(payload);
    case 'comms_selftest_unsub':   return handleCommsSelftestUnsub_(payload);
    default: return { ok: false, error: 'Unknown comms action: ' + action };
  }
}

// Editor-runnable Phase 3 check: renders a sample and logs the HTML length +
// key markers so you can eyeball rendering without a token.
function commsTestRender() {
  var r = handleCommsPreviewRender_({
    subject: 'Route update for {{first_name}}',
    body_markup: 'Hi {{first_name}},\n\nYour service day is **{{day}}**. Visit [our site](https://missioncustompools.com).\n\nPools:\n{{properties_list}}\n\nBad link test: [x](javascript:alert(1)) and <script>alert(2)</script>.'
  });
  Logger.log('subject: ' + r.subject);
  Logger.log('has <strong>: ' + (r.html.indexOf('<strong>') !== -1));
  Logger.log('js link stripped: ' + (r.html.indexOf('javascript:') === -1));
  Logger.log('script escaped: ' + (r.html.indexOf('<script>') === -1));
  Logger.log(r.html);
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 4 — Campaign queue + crash-safe batched sweeper
// ═══════════════════════════════════════════════════════════════════════════

var COMMS_SWEEP_MAX_PER_RUN = 50;      // sends per sweep run (all engines)
var COMMS_SWEEP_MAX_MS      = 270000;  // ~4.5 min (GAS hard limit is 6 min)
var COMMS_SWEEP_STALE_MS    = 600000;  // 10 min: a 'sending' row older than this crashed
var COMMS_SWEEP_INTERVAL_MS = 45000;   // gap between sweep runs while work remains
// The Gmail send quota was previously folklore: commsConfigStatus_ reported the
// remaining figure and nothing ever acted on it, so a large campaign could quietly
// consume the allowance a signature request or visit report needed later the same
// day — and the only symptom would be transactional mail failing hours afterwards.
var COMMS_GMAIL_DAILY_QUOTA = 1500;    // Workspace; a consumer account is 500
var COMMS_QUOTA_RESERVE     = 200;     // kept back for agreements/visit reports/follow-ups
var COMMS_QUOTA_RETRY_MS    = 1800000; // 30 min: how often to re-check once blocked
// Retry applies ONLY to a row the provider explicitly rejected — see the due-row
// logic in commsSweep_ for why a crashed lease is deliberately excluded.
var COMMS_MAX_ATTEMPTS      = 3;
var COMMS_RETRY_BACKOFF_MS  = [300000, 1800000, 7200000];  // 5 min, 30 min, 2 h
// Bulk pacing. Spreading a cold send over days is not throughput management: it
// is the only way to still have a domain reputation on day three, and it is what
// makes "stop, the bounce rate is 20%" a decision you can still take.
var COMMS_BULK_DAILY_CAP_DEFAULT = 100;
var COMMS_BULK_HOUR_START   = 9;
var COMMS_BULK_HOUR_END     = 17;

function commsExecUrl_() {
  // The portal's pinned web-app /exec (same URL across redeploys). Overridable
  // via the COMMS_EXEC_URL property if the deployment ever changes.
  return commsProps_().getProperty('COMMS_EXEC_URL')
    || 'https://script.google.com/macros/s/AKfycbxFrdZRbkXuGuazfqf7q-rKp-T-3DinM8t_3Pp5i6Efr7tciDU59Go6L7s3kxCQl9I/exec';
}
function commsUnsubscribeUrl_(token) {
  var base = commsExecUrl_();
  if (!base || !token) return '#';
  return base + (base.indexOf('?') === -1 ? '?' : '&') + 'action=comms_unsubscribe&t=' + encodeURIComponent(token);
}

function commsDeleteOwnTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'commsSweep_') { try { ScriptApp.deleteTrigger(t); } catch (e) {} }
  });
}
function commsScheduleSweep_(ms) {
  commsDeleteOwnTriggers_();
  ScriptApp.newTrigger('commsSweep_').timeBased().after(Math.max(1000, ms || 1000)).create();
}

// ─── comms_send_campaign (admin/manager) ─────────────────────────────────────
function handleCommsSendCampaign_(auth, payload) {
  commsEnsureSheets_();
  var name = commsNorm_(payload.name) || 'Untitled campaign';
  var category = commsNorm_(payload.category) || 'service_update';
  var subject = String(payload.subject || '');
  var body = String(payload.body_markup || '');
  var audience = payload.audience || {};
  if (!subject) return { ok: false, error: 'Subject is required.' };
  if (!body)    return { ok: false, error: 'Message body is required.' };
  // CAN-SPAM requires a postal address on commercial email and penalties accrue
  // PER MESSAGE, so a 500-recipient send with no address is 500 violations rather
  // than one. Refusing to create the campaign is the correct failure mode.
  if (commsLaneForCategory_(category) === 'bulk' && !commsBrandCfg_().address) {
    return { ok: false, error: 'Set the COMMS_BUSINESS_ADDRESS script property before sending ' +
      'marketing or announcement email — commercial mail legally requires a postal address in the footer.' };
  }

  var res = resolveCommsAudience_(audience, category);
  if (!res.ok) return res;
  var recipients = res.recipients;
  if (!recipients.length) return { ok: false, error: 'No recipients matched this audience.' };

  var sendable = recipients.filter(function (r) { return !r.invalid && !r.opted_out; });
  if (!sendable.length) return { ok: false, error: 'No sendable recipients (all invalid or opted out).' };
  var skipped = recipients.length - sendable.length;

  // Scheduling: a future send_at (>30s out) parks the campaign as 'scheduled'
  // until the sweeper promotes it. Otherwise it starts sending immediately.
  var sendAt = commsNorm_(payload.send_at);
  var scheduled = false, whenMs = 0;
  if (sendAt) {
    whenMs = Date.parse(sendAt);
    if (isNaN(whenMs)) return { ok: false, error: 'Invalid send_at datetime.' };
    if (whenMs > Date.now() + 30000) scheduled = true;
  }

  var campaignId = Utilities.getUuid();
  var now = new Date().toISOString();
  var by = (auth && (auth.name || auth.username)) || '';
  var lane = commsLaneForCategory_(category);
  var provider = commsTransportForLane_(lane);

  // Sender is resolved ONCE, here, and written onto the campaign row. The sweeper
  // reads it back rather than re-resolving, so a registry edit (or a staff member
  // deactivated) part-way through a send cannot switch who the remaining
  // recipients hear from. No mapping means no campaign: falling back to the
  // shared mailbox would put customer mail out under the wrong name silently.
  //
  // Only in gmail mode — under resend/zapier the provider is the sender, and a
  // per-person Gmail script has nothing to do with it.
  //
  // Gated on the PERSONAL lane, not merely on gmail mode: bulk marketing has no
  // business borrowing a staff member's mailbox, so it must never be blocked by
  // (or contribute to) the per-person registry.
  var sender = null;
  if (lane === 'personal' && provider === 'gmail') {
    // An explicit refusal beats a ReferenceError. commsResolveSender_ lives in
    // CommsSenders.js, which is a separate file that can lag a deploy.
    if (typeof commsResolveSender_ !== 'function') {
      return { ok: false, error: 'Per-person sender registry is unavailable (CommsSenders.js is not deployed). ' +
        'Deploy it, or send this as a marketing/announcement category to use the bulk lane.' };
    }
    var resolved = commsResolveSender_(auth);
    if (!resolved.ok) return resolved;
    sender = resolved.sender;
  }

  commsAppendRow_('campaigns', {
    campaign_id: campaignId, name: name, category: category, subject: subject,
    body_markup: body, audience_json: JSON.stringify(audience),
    status: scheduled ? 'scheduled' : 'sending',
    send_at: scheduled ? sendAt : '', provider: provider, lane: lane, created_by: by, created_at: now,
    started_at: scheduled ? '' : now, finished_at: '',
    total_recipients: recipients.length, sendable_count: sendable.length,
    sent_count: 0, failed_count: 0, skipped_count: skipped,
    // Bulk sends are paced by default. Operational mail is not: a reschedule
    // notice that arrives in four days' time is worse than useless.
    daily_cap: lane === 'bulk'
      ? (Number(commsProps_().getProperty('COMMS_BULK_DAILY_CAP')) || COMMS_BULK_DAILY_CAP_DEFAULT)
      : 0,
    sender_key: sender ? sender.username : '',
    sender_email: sender ? sender.sender_email : '',
    sender_script_url: sender ? sender.sender_script_url : ''
  });

  var logObjs = recipients.map(function (r) {
    var p0 = (r.properties && r.properties[0]) || {};
    var status = r.invalid ? 'skipped_invalid' : (r.opted_out ? 'skipped_optout' : 'queued');
    return {
      recipient_id: Utilities.getUuid(), unsubscribe_token: Utilities.getUuid(),
      campaign_id: campaignId, email: r.email || '', name: r.name || '',
      quote_id: p0.quote_id || '', pool_id: p0.pool_id || '', recipient_json: JSON.stringify(r),
      status: status, error: r.invalid ? 'blank or invalid email' : (r.opted_out ? 'opted out' : ''),
      attempt_started_at: '', attempt_count: 0, next_attempt_at: '',
      provider: '', provider_message_id: '', sent_at: '',
      bounce_reason: '', complaint_at: '', opened_at: '', clicked_at: '', sender_email: ''
    };
  });
  commsAppendRows_('log', logObjs);
  commsEnsureGuardTrigger_(); // hourly safety net, installed once

  var result = { ok: true, campaign_id: campaignId, total: recipients.length,
                 sendable: sendable.length, skipped: skipped,
                 status: scheduled ? 'scheduled' : 'sending', send_at: scheduled ? sendAt : '' };

  if (payload.run_inline && !scheduled) {
    // Synchronous first pass (tests / small sends). commsSweep_ handles its own
    // lock, finalization, and wake recomputation for any remainder.
    commsSweep_();
    var camp = null;
    commsSheetRows_('campaigns').forEach(function (c) { if (String(c.campaign_id) === campaignId) camp = c; });
    if (camp) {
      result.status = camp.status;
      result.sent_count = Number(camp.sent_count) || 0;
      result.failed_count = Number(camp.failed_count) || 0;
      result.skipped_count = Number(camp.skipped_count) || 0;
    }
  } else if (scheduled) {
    commsRecomputeWake_(); // sets a trigger at the earliest scheduled send_at
  } else {
    commsScheduleSweep_(5000); // quick first send-now pass
  }
  return result;
}

// ─── The sweeper: drains queued rows for 'sending' campaigns, crash-safe ──────
function commsSweep_() {
  commsDeleteOwnTriggers_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return; // another sweep already running
  try {
    commsEnsureSheets_();
    // Promote scheduled campaigns whose send_at has arrived.
    var nowMs = Date.now();
    commsSheetRows_('campaigns').forEach(function (c) {
      if (String(c.status) !== 'scheduled') return;
      var t = Date.parse(c.send_at || '');
      if (!isNaN(t) && t <= nowMs) {
        commsUpdateRowById_('campaigns', 'campaign_id', c.campaign_id,
          { status: 'sending', started_at: new Date().toISOString() });
      }
    });
    var sending = {};
    commsSheetRows_('campaigns').forEach(function (c) {
      if (String(c.status) === 'sending') sending[c.campaign_id] = c;
    });
    if (!Object.keys(sending).length) { commsRecomputeWake_(); return; }

    var logSheet = commsSheet_('log');
    var headers = commsActualHeaders_(logSheet);
    var rows = commsSheetRows_('log');
    var start = Date.now();
    var sentThisRun = 0;
    // Checked once per run, not per row: it is an API call, and the figure cannot
    // move mid-run in any way that changes the decision.
    var remaining = commsRemainingQuota_();
    var quotaBlocked = (remaining >= 0 && remaining <= COMMS_QUOTA_RESERVE);
    var quotaSkipped = 0;
    var windowOk = commsBulkWindowOk_();
    var dayCounter = commsReadDayCounter_();
    var heldByWindow = 0, heldByCap = 0;
    // Collected here and written once after the loop — see leadRecordEmailed_.
    var emailedQuoteIds = [];

    for (var i = 0; i < rows.length; i++) {
      if (sentThisRun >= COMMS_SWEEP_MAX_PER_RUN) break;
      if (Date.now() - start > COMMS_SWEEP_MAX_MS) break;
      var r = rows[i];
      var camp = sending[r.campaign_id];
      if (!camp) continue;
      // Leave the row queued rather than failing it: the allowance returns on a
      // rolling 24h basis, so this is a pause, not an error, and marking it failed
      // would drop the recipient permanently.
      if (quotaBlocked && commsUsesGmailQuota_(camp)) { quotaSkipped++; continue; }

      // Both gates leave the row QUEUED. This is a pause, not a failure — marking
      // it failed would drop the recipient permanently for a timing reason.
      var isBulk = String(camp.lane || '') === 'bulk';
      if (isBulk && !windowOk) { heldByWindow++; continue; }
      var cap = Number(camp.daily_cap) || 0;
      if (cap > 0 && (dayCounter.campaigns[r.campaign_id] || 0) >= cap) { heldByCap++; continue; }

      var status = String(r.status);
      var due = false;
      if (status === 'queued') {
        due = true;
      } else if (status === 'sending') {
        var started = Date.parse(r.attempt_started_at || '') || 0;
        if (Date.now() - started > COMMS_SWEEP_STALE_MS) {
          if ((Number(r.attempt_count) || 0) >= 2) {
            commsPatchRow_(logSheet, headers, r._row,
              { status: 'failed', error: 'attempt crashed; possible duplicate — not retried' });
            continue;
          }
          due = true; // crashed lease, retry once
        }
      } else if (status === 'failed') {
        // Retried ONLY when something deliberately scheduled a retry. The crashed-
        // lease branch above never sets next_attempt_at, so an at-most-once row can
        // never be resurrected here — which is the whole point: we do not know
        // whether that message went out, and a duplicate cold email is a complaint.
        var nextAt = Date.parse(r.next_attempt_at || '') || 0;
        if (nextAt && Date.now() >= nextAt &&
            (Number(r.attempt_count) || 0) < COMMS_MAX_ATTEMPTS) due = true;
      }
      if (!due) continue;

      // Lease the row BEFORE sending (crash safety): if we die after the send but
      // before writing the result, this row is 'sending' and gets recovered.
      var leaseIso = new Date().toISOString();
      commsPatchRow_(logSheet, headers, r._row,
        { status: 'sending', attempt_started_at: leaseIso, attempt_count: (Number(r.attempt_count) || 0) + 1 });

      var recipient = {};
      try { recipient = JSON.parse(r.recipient_json || '{}'); } catch (e) {}
      var subject = commsRenderSubject_(camp.subject, recipient);
      var innerHtml = commsRenderBody_(camp.body_markup, recipient);
      var html = buildCommsEmailHtml_(innerHtml,
        { unsubscribeUrl: commsUnsubscribeUrl_(r.unsubscribe_token), preheader: subject,
          category: camp.category });
      var plain = commsRenderPlain_(camp.body_markup, recipient);
      // Sender comes off the CAMPAIGN row, locked at creation — never re-resolved
      // here, so a mid-flight registry change cannot split one campaign across
      // two mailboxes.
      var send = sendCommsEmail_({ to: r.email, subject: subject, htmlBody: html, plainBody: plain,
                                   recipientId: r.recipient_id,
                                   transport: camp.provider || '',
                                   senderEmail: camp.sender_email || '',
                                   senderScriptUrl: camp.sender_script_url || '' });
      var doneIso = new Date().toISOString();
      if (send.ok) {
        commsPatchRow_(logSheet, headers, r._row, { status: 'sent', sent_at: doneIso,
          provider: send.provider, provider_message_id: send.providerMessageId || '', error: '',
          // What actually sent, as reported by the sender script — not what we
          // asked for. The two differing is exactly what an audit needs to catch.
          sender_email: send.senderEmail || camp.sender_email || '' });
        try {
          if (typeof rsAfterCommsRecipientSent_ === 'function') {
            rsAfterCommsRecipientSent_(camp, r, recipient, doneIso);
          }
        } catch (hookErr) {
          Logger.log('Comms post-send hook failed: ' + hookErr);
        }
        sentThisRun++;
        dayCounter.campaigns[r.campaign_id] = (dayCounter.campaigns[r.campaign_id] || 0) + 1;
        if (r.quote_id) emailedQuoteIds.push(r.quote_id);
      } else {
        // The provider told us it did not send, so a retry cannot duplicate. Only
        // transient causes earn one — a malformed address just fails again on a
        // timer, filling the log and delaying the campaign's completion.
        var attempts = Number(r.attempt_count) || 1;
        var retryable = commsIsTransientError_(send.error) && attempts < COMMS_MAX_ATTEMPTS;
        commsPatchRow_(logSheet, headers, r._row, {
          status: 'failed', error: send.error || 'send failed', provider: send.provider,
          next_attempt_at: retryable
            ? new Date(Date.now() + commsRetryDelayMs_(attempts)).toISOString() : ''
        });
      }
    }

    commsWriteDayCounter_(dayCounter);
    // Stamps last_emailed_at / email_count on the CRM rows. Without it the cold
    // buckets never learn a campaign happened and the next send hits the same
    // list again. Isolated so a CRM permission problem cannot fail the sweep —
    // the mail has already gone out by this point.
    if (emailedQuoteIds.length && typeof leadRecordEmailed_ === 'function') {
      try {
        leadRecordEmailed_(emailedQuoteIds, new Date().toISOString());
      } catch (wbErr) {
        Logger.log('Comms: post-send write-back failed: ' + wbErr);
      }
    }
    if (quotaSkipped || heldByWindow || heldByCap) {
      Logger.log('Comms sweep held: ' + quotaSkipped + ' on quota (' + remaining + ' left), ' +
                 heldByWindow + ' outside the send window, ' + heldByCap + ' at the daily cap. ' +
                 'Sent ' + sentThisRun + ' this run.');
    }
    commsFinalizeCampaigns_(Object.keys(sending));

    // Nothing was sendable, so sleep until the reason expires instead of rescanning
    // the whole log every 45 seconds — possibly all night. A cap resets tomorrow;
    // the window reopens on its own schedule; quota returns on a rolling basis.
    var backoff = 0;
    if (!sentThisRun) {
      if (heldByCap)         backoff = commsMsUntilCapReset_();
      else if (heldByWindow) backoff = commsMsUntilBulkWindow_();
      else if (quotaSkipped) backoff = COMMS_QUOTA_RETRY_MS;
    }
    commsRecomputeWake_(backoff);
  } finally {
    lock.releaseLock();
  }
}

// Recompute counters from the log and close campaigns that have no work left.
function commsFinalizeCampaigns_(campaignIds) {
  if (!campaignIds.length) return;
  var stats = {};
  campaignIds.forEach(function (id) { stats[id] = { sent: 0, failed: 0, skipped: 0, queued: 0, sending: 0 }; });
  commsSheetRows_('log').forEach(function (r) {
    var s = stats[r.campaign_id];
    if (!s) return;
    var st = String(r.status);
    if (st === 'sent') s.sent++;
    else if (st === 'failed') s.failed++;
    else if (st === 'skipped_invalid' || st === 'skipped_optout' || st === 'cancelled') s.skipped++;
    else if (st === 'queued') s.queued++;
    else if (st === 'sending') s.sending++;
  });
  var now = new Date().toISOString();
  campaignIds.forEach(function (id) {
    var s = stats[id];
    var patch = { sent_count: s.sent, failed_count: s.failed, skipped_count: s.skipped };
    if (s.queued === 0 && s.sending === 0) {
      patch.status = (s.failed > 0) ? 'done_with_errors' : 'done';
      patch.finished_at = now;
    }
    commsUpdateRowById_('campaigns', 'campaign_id', id, patch);
  });
}

// The single wake authority: recompute exactly one next sweep trigger from
// current sheet state. If a 'sending' campaign has work left → soon; else if a
// 'scheduled' campaign is pending → at its send_at; else no trigger.
// minDelayMs lets a caller ask for a longer nap without becoming a second source
// of triggers — this stays the single wake authority, which is what the guard
// ownership machinery below depends on.
function commsRecomputeWake_(minDelayMs) {
  commsDeleteOwnTriggers_();
  var sendingIds = {}, earliest = null;
  commsSheetRows_('campaigns').forEach(function (c) {
    var st = String(c.status);
    if (st === 'sending') sendingIds[c.campaign_id] = true;
    else if (st === 'scheduled') {
      var t = Date.parse(c.send_at || '');
      if (!isNaN(t) && (earliest === null || t < earliest)) earliest = t;
    }
  });
  var hasWork = false;
  if (Object.keys(sendingIds).length) {
    hasWork = commsSheetRows_('log').some(function (r) {
      return sendingIds[r.campaign_id] && (String(r.status) === 'queued' || String(r.status) === 'sending');
    });
  }
  if (hasWork) {
    ScriptApp.newTrigger('commsSweep_').timeBased()
      .after(Math.max(COMMS_SWEEP_INTERVAL_MS, Number(minDelayMs) || 0)).create();
  } else if (earliest !== null) {
    if (earliest <= Date.now() + 60000) {
      ScriptApp.newTrigger('commsSweep_').timeBased().after(5000).create();
    } else {
      ScriptApp.newTrigger('commsSweep_').timeBased().at(new Date(earliest)).create();
    }
  }
}

// Does this campaign draw on THIS script's Gmail allowance? A campaign routed to
// a per-person sender script spends that staff member's quota under their own
// account, and an external provider spends none of it — so neither is constrained
// by the reserve, and treating them as if they were would stall sends for nothing.
function commsUsesGmailQuota_(camp) {
  if (!camp) return false;
  if (commsNorm_(camp.sender_script_url)) return false;
  var provider = commsNorm_(camp.provider) || commsSendMode_();
  return provider === 'gmail';
}

function commsRemainingQuota_() {
  try { return MailApp.getRemainingDailyQuota(); } catch (e) { return -1; }
}

// A provider that told us HTTP 503 is safe to retry: we know nothing was sent.
// A malformed address is not — retrying it just fails again on a schedule.
var COMMS_TRANSIENT_RE = /(\b5\d\d\b|\b429\b|timeout|timed out|rate.?limit|too many|temporarily|unavailable|network|socket|ECONN|deadline)/i;
function commsIsTransientError_(err) {
  return COMMS_TRANSIENT_RE.test(String(err == null ? '' : err));
}

// Attempt N has already happened when this is called, so index from it directly;
// the last backoff repeats if the array is shorter than the attempt cap.
function commsRetryDelayMs_(attemptCount) {
  var i = Math.max(0, (Number(attemptCount) || 1) - 1);
  return COMMS_RETRY_BACKOFF_MS[Math.min(i, COMMS_RETRY_BACKOFF_MS.length - 1)];
}

// Unset and blank are "not configured", NOT zero.
function commsNumProp_(key, fallback) {
  var raw = commsProps_().getProperty(key);
  if (raw === null || raw === undefined || String(raw).trim() === '') return fallback;
  var n = Number(raw);
  return isNaN(n) ? fallback : n;
}

function commsDayKey_() {
  return Utilities.formatDate(new Date(), COMMS_TZ, 'yyyy-MM-dd');
}

// Spend is tracked in ONE script property rather than by scanning the log, which
// would be a second full read per sweep. Losing a write to a crash undercounts by
// at most one run — i.e. errs toward sending slightly more, never toward stalling.
function commsReadDayCounter_() {
  var today = commsDayKey_();
  var c = null;
  try { c = JSON.parse(commsProps_().getProperty('COMMS_DAY_COUNTER') || '{}'); } catch (e) {}
  if (!c || c.day !== today) c = { day: today, campaigns: {} };
  if (!c.campaigns) c.campaigns = {};
  return c;
}
function commsWriteDayCounter_(c) {
  try { commsProps_().setProperty('COMMS_DAY_COUNTER', JSON.stringify(c)); } catch (e) {}
}

// Bulk mail waits for civilised hours; operational mail never does. A reschedule
// notice at 7am is useful, a promotion at 3am is a complaint.
function commsBulkWindowOk_(now) {
  // ⚠️ Number(null) is 0, so reading an unset property straight into Number() and
  // range-checking it yields a VALID hour of midnight — i.e. an unconfigured
  // install would quietly open the window at 00:00 and send marketing at 3am,
  // which is the exact thing this function exists to prevent.
  var start = commsNumProp_('COMMS_BULK_HOUR_START', COMMS_BULK_HOUR_START);
  var end   = commsNumProp_('COMMS_BULK_HOUR_END', COMMS_BULK_HOUR_END);
  if (!(start >= 0 && start < 24)) start = COMMS_BULK_HOUR_START;
  if (!(end > 0 && end <= 24))     end   = COMMS_BULK_HOUR_END;
  var ct;
  try {
    ct = new Date((now || new Date()).toLocaleString('en-US', { timeZone: COMMS_TZ }));
  } catch (e) { return true; }   // never let a clock problem stop the queue
  if (ct.getDay() === 0) return false;                 // no Sunday marketing
  return ct.getHours() >= start && ct.getHours() < end;
}

// Milliseconds until the window reopens, so a held campaign sleeps rather than
// rescanning the log every 45 seconds all night.
function commsMsUntilBulkWindow_(now) {
  var base = now || new Date();
  for (var m = 15; m <= 60 * 24 * 2; m += 15) {
    if (commsBulkWindowOk_(new Date(base.getTime() + m * 60000))) return m * 60000;
  }
  return COMMS_QUOTA_RETRY_MS;
}

// A daily cap resets when the DATE rolls over in COMMS_TZ, which is not the same
// moment the window reopens — while the window is still open today, the next open
// slot is fifteen minutes away and the cap would still be spent. So step past
// midnight first, then find the next open slot.
function commsMsUntilCapReset_(now) {
  var base = now || new Date();
  var today = Utilities.formatDate(base, COMMS_TZ, 'yyyy-MM-dd');
  for (var m = 15; m <= 60 * 24 * 2; m += 15) {
    var t = new Date(base.getTime() + m * 60000);
    if (Utilities.formatDate(t, COMMS_TZ, 'yyyy-MM-dd') !== today && commsBulkWindowOk_(t)) {
      return m * 60000;
    }
  }
  return COMMS_QUOTA_RETRY_MS;
}

// Hourly safety net: if a normally-scheduled sweep trigger is ever lost, this
// recovers within the hour.
//
// ⚠️ Triggers are owned by the account that created them, and
// ScriptApp.getProjectTriggers() only ever returns the EFFECTIVE user's own. So a
// bare "is one installed?" check answers "no" whenever a *different* account
// asks, and installs a second guard — neither account able to see or delete the
// other's. Both then fire hourly, each sweeping as its own owner, and because the
// sweeping account is the Gmail sender (and its sweep creates the follow-on
// commsSweep_ triggers, inheriting the same identity), the From on customer mail
// ends up decided by trigger firing order rather than by configuration.
//
// Script properties ARE shared across accounts, so ownership is recorded there.
// The owning guard stamps a heartbeat every run; one that goes quiet for
// COMMS_GUARD_STALE_MS is treated as abandoned (owner suspended or departed) and
// may be taken over, so a dead owner can't stall the queue forever.
var COMMS_GUARD_OWNER_PROP    = 'COMMS_GUARD_OWNER';
var COMMS_GUARD_BEAT_PROP     = 'COMMS_GUARD_LAST_BEAT';
var COMMS_GUARD_CONFLICT_PROP = 'COMMS_GUARD_CONFLICT';
var COMMS_GUARD_STALE_MS      = 10800000; // 3h — an hourly guard missed 3 beats

function commsEffectiveUser_() {
  try { return String(Session.getEffectiveUser().getEmail() || ''); } catch (e) { return ''; }
}
function commsGuardOwner_() {
  return String(commsProps_().getProperty(COMMS_GUARD_OWNER_PROP) || '');
}
// ms since the owning guard last fired, or null if it has never reported in.
function commsGuardBeatAge_() {
  var t = Date.parse(commsProps_().getProperty(COMMS_GUARD_BEAT_PROP) || '');
  return isNaN(t) ? null : Date.now() - t;
}
// Claiming ownership counts as a beat, so a freshly installed guard is never
// mistaken for an abandoned one during its first hour.
function commsClaimGuard_(me) {
  var p = commsProps_();
  p.setProperty(COMMS_GUARD_OWNER_PROP, me);
  p.setProperty(COMMS_GUARD_BEAT_PROP, new Date().toISOString());
}

// Editor-runnable: clear a recorded conflict AFTER the surplus guard has actually
// been deleted. Deliberately manual — only the surplus guard's own account can
// delete it (cross-account deletes are impossible), so no code path can confirm
// the fix, and auto-clearing would erase the warning while the duplicate lived on.
function commsClearGuardConflict() {
  var was = String(commsProps_().getProperty(COMMS_GUARD_CONFLICT_PROP) || '');
  commsProps_().deleteProperty(COMMS_GUARD_CONFLICT_PROP);
  Logger.log(was ? 'Cleared guard conflict: ' + was : 'No guard conflict was recorded.');
  return { ok: true, cleared: was };
}

function commsEnsureGuardTrigger_() {
  var me = commsEffectiveUser_();
  var visible;
  try {
    visible = ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === 'commsSweepGuard_';
    });
  } catch (e) {
    return; // Can't read triggers — never guess, or we install the duplicate.
  }

  var owner = commsGuardOwner_();

  if (visible) {
    if (!me || owner === me) return;
    if (!owner) { commsClaimGuard_(me); return; }
    // Guards held by TWO accounts — the state this fix prevents, and the one
    // already possible in any project that ran the old check. Record it for the
    // diagnostic rather than quietly reassigning ownership and hiding it.
    commsProps_().setProperty(COMMS_GUARD_CONFLICT_PROP, owner + ' + ' + me);
    Logger.log('Comms guard conflict: hourly guards owned by BOTH ' + owner + ' and ' + me);
    return;
  }

  if (owner && me && owner !== me) {
    var age = commsGuardBeatAge_();
    if (age !== null && age <= COMMS_GUARD_STALE_MS) return; // alive elsewhere; stand down
    // Taking over cannot remove the old owner's trigger (cross-account deletes
    // are impossible), but 3h of silence means it is not running anyway, and a
    // stalled queue is worse than a dormant duplicate.
    Logger.log('Comms guard: taking over from ' + owner + ' after '
               + (age === null ? 'no recorded beat' : age + 'ms of silence'));
  }

  ScriptApp.newTrigger('commsSweepGuard_').timeBased().everyHours(1).create();
  if (me) commsClaimGuard_(me);
}

function commsSweepGuard_() {
  // Heartbeat first: proof of life must survive an early return below.
  try { commsProps_().setProperty(COMMS_GUARD_BEAT_PROP, new Date().toISOString()); } catch (e) {}
  var nowMs = Date.now();
  var active = commsSheetRows_('campaigns').some(function (c) {
    var st = String(c.status);
    if (st === 'sending') return true;
    if (st === 'scheduled') { var t = Date.parse(c.send_at || ''); return !isNaN(t) && t <= nowMs + 3600000; }
    return false;
  });
  if (active) commsSweep_();
}

// ─── comms_cancel_campaign: stop a scheduled or in-flight campaign ───────────
function handleCommsCancelCampaign_(payload) {
  commsEnsureSheets_();
  var id = commsNorm_(payload.campaign_id);
  if (!id) return { ok: false, error: 'campaign_id required' };
  var camp = null;
  commsSheetRows_('campaigns').forEach(function (c) { if (String(c.campaign_id) === id) camp = c; });
  if (!camp) return { ok: false, error: 'Campaign not found' };
  var st = String(camp.status);
  if (st === 'done' || st === 'done_with_errors' || st === 'cancelled') {
    return { ok: false, error: 'Campaign already finished (' + st + ').' };
  }

  // Cancel every remaining queued row so detail views show no stale 'queued'.
  var logSheet = commsSheet_('log');
  var headers = commsActualHeaders_(logSheet);
  var cancelled = 0;
  var counts = { sent: 0, failed: 0, skipped: 0 };
  commsSheetRows_('log').forEach(function (r) {
    if (String(r.campaign_id) !== id) return;
    var s = String(r.status);
    if (s === 'queued') {
      commsPatchRow_(logSheet, headers, r._row, { status: 'cancelled', error: 'campaign cancelled' });
      cancelled++; counts.skipped++;
    } else if (s === 'sent') counts.sent++;
    else if (s === 'failed') counts.failed++;
    else counts.skipped++; // skipped_*, cancelled, sending (already left the queue)
  });

  commsUpdateRowById_('campaigns', 'campaign_id', id, {
    status: 'cancelled', finished_at: new Date().toISOString(),
    sent_count: counts.sent, failed_count: counts.failed, skipped_count: counts.skipped
  });
  commsRecomputeWake_(); // in case this was the only pending campaign
  return { ok: true, campaign_id: id, status: 'cancelled', cancelled_rows: cancelled };
}

// ─── Reads: campaign list + per-recipient detail ─────────────────────────────
function handleCommsListCampaigns_() {
  commsEnsureSheets_();
  var counter = commsReadDayCounter_();
  var rows = commsSheetRows_('campaigns').map(function (c) {
    return {
      campaign_id: c.campaign_id, name: c.name, category: c.category, subject: c.subject,
      status: c.status, send_at: c.send_at, provider: c.provider, created_by: c.created_by,
      created_at: c.created_at, started_at: c.started_at, finished_at: c.finished_at,
      total_recipients: Number(c.total_recipients) || 0, sendable_count: Number(c.sendable_count) || 0,
      sent_count: Number(c.sent_count) || 0, failed_count: Number(c.failed_count) || 0,
      skipped_count: Number(c.skipped_count) || 0,
      // Pacing state travels with the row. A paced campaign legitimately sits at
      // 'sending' for days, and a progress bar that stalls with no explanation
      // reads as a broken send — which is how someone ends up cancelling a
      // campaign that was working exactly as intended.
      lane: c.lane || '', daily_cap: Number(c.daily_cap) || 0,
      sent_today: Number(counter.campaigns[c.campaign_id]) || 0
    };
  });
  rows.sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
  return { ok: true, campaigns: rows,
           // So the UI can say WHEN it will resume, not merely that it paused.
           window_open: commsBulkWindowOk_(), today: commsDayKey_() };
}

function handleCommsCampaignDetail_(payload) {
  commsEnsureSheets_();
  var id = commsNorm_(payload.campaign_id);
  if (!id) return { ok: false, error: 'campaign_id required' };
  var camp = null;
  commsSheetRows_('campaigns').forEach(function (c) { if (String(c.campaign_id) === id) camp = c; });
  if (!camp) return { ok: false, error: 'Campaign not found' };
  var CAP = 1000;
  var recips = [];
  commsSheetRows_('log').forEach(function (r) {
    if (String(r.campaign_id) !== id || recips.length >= CAP) return;
    recips.push({ email: r.email, name: r.name, status: r.status, error: r.error,
                  sent_at: r.sent_at, provider: r.provider, bounce_reason: r.bounce_reason });
  });
  return {
    ok: true,
    campaign: {
      campaign_id: camp.campaign_id, name: camp.name, category: camp.category, subject: camp.subject,
      status: camp.status, total_recipients: Number(camp.total_recipients) || 0,
      sendable_count: Number(camp.sendable_count) || 0, sent_count: Number(camp.sent_count) || 0,
      failed_count: Number(camp.failed_count) || 0, skipped_count: Number(camp.skipped_count) || 0,
      created_at: camp.created_at, finished_at: camp.finished_at
    },
    recipients: recips,
    truncated: recips.length >= CAP
  };
}

// Admin self-test for the sweeper's crash-recovery rules. Seeds two stale
// 'sending' rows (15 min old) on a throwaway campaign, runs one sweep, and
// reports what happened. Cleans up after itself unless payload.keep is set.
// Sends one real email (the attempt-1 row is legitimately retried).
function handleCommsSelftestCrash_(payload) {
  commsEnsureSheets_();
  var to = String(commsProps_().getProperty('COMMS_TEST_RECIPIENT') || '').split(',')[0].trim()
        || 'mauriciorebazaf@gmail.com';
  var cid = 'CRASHTEST-' + Utilities.getUuid();
  var nowIso = new Date().toISOString();
  commsAppendRow_('campaigns', {
    campaign_id: cid, name: 'Crash recovery self-test', category: 'announcement',
    subject: 'Crash recovery self-test', body_markup: 'Hi {{first_name}}, crash recovery self-test.',
    audience_json: '{}', status: 'sending', provider: commsSendMode_(), created_by: 'selftest',
    created_at: nowIso, started_at: nowIso, total_recipients: 2, sendable_count: 2,
    sent_count: 0, failed_count: 0, skipped_count: 0
  });
  var stale = new Date(Date.now() - 15 * 60000).toISOString(); // 15 min ago → stale lease
  var recJson = JSON.stringify({ email: to, first_name: 'CrashTest', last_name: '', name: 'CrashTest', properties: [{}] });
  var ridA = Utilities.getUuid(), ridB = Utilities.getUuid();
  commsAppendRows_('log', [
    { recipient_id: ridA, unsubscribe_token: Utilities.getUuid(), campaign_id: cid, email: to, name: 'A',
      recipient_json: recJson, status: 'sending', attempt_started_at: stale, attempt_count: 1 },
    { recipient_id: ridB, unsubscribe_token: Utilities.getUuid(), campaign_id: cid, email: to, name: 'B',
      recipient_json: recJson, status: 'sending', attempt_started_at: stale, attempt_count: 2 }
  ]);

  commsSweep_();

  var a = '?', b = '?', bErr = '', cstatus = '?';
  commsSheetRows_('log').forEach(function (r) {
    if (r.campaign_id !== cid) return;
    if (r.recipient_id === ridA) a = String(r.status);
    if (r.recipient_id === ridB) { b = String(r.status); bErr = String(r.error || ''); }
  });
  commsSheetRows_('campaigns').forEach(function (c) { if (c.campaign_id === cid) cstatus = String(c.status); });

  if (!payload.keep) {
    commsDeleteRowById_('campaigns', 'campaign_id', cid);
    var sheet = commsSheet_('log'), headers = commsActualHeaders_(sheet), last = sheet.getLastRow();
    var cidIdx = headers.indexOf('campaign_id');
    for (var i = last; i >= 2; i--) {
      if (String(sheet.getRange(i, cidIdx + 1).getValue()) === cid) sheet.deleteRow(i);
    }
  }

  return {
    ok: true,
    rowA_attempt1_stale: a, rowA_expect: 'sent (retried once)',
    rowB_attempt2_stale: b, rowB_error: bErr, rowB_expect: 'failed (no retry)',
    campaign_status: cstatus, campaign_expect: 'done_with_errors',
    pass: (a === 'sent' && b === 'failed' && cstatus === 'done_with_errors')
  };
}

// Editor-runnable wrapper for the crash-recovery self-test (runs against HEAD,
// so it works without a new deployment).
function commsRunCrashSelftest() {
  Logger.log(JSON.stringify(handleCommsSelftestCrash_({}), null, 2));
}

// Admin self-test for scheduling + cancellation. Seeds a past-due scheduled
// campaign (should promote & send), a future scheduled campaign (should stay
// scheduled, then be cancelled), runs one sweep, and reports. Sends one real
// email (the past-due campaign). Cleans up unless payload.keep is set.
function handleCommsSelftestSchedule_(payload) {
  commsEnsureSheets_();
  var to = String(commsProps_().getProperty('COMMS_TEST_RECIPIENT') || '').split(',')[0].trim()
        || 'mauriciorebazaf@gmail.com';
  var recJson = JSON.stringify({ email: to, first_name: 'Sched', last_name: 'Test', name: 'Sched Test', properties: [{}] });
  var mkCampaign = function (cid, sendAtIso) {
    commsAppendRow_('campaigns', {
      campaign_id: cid, name: 'Sched self-test', category: 'announcement', subject: 'Scheduled self-test',
      body_markup: 'Hi {{first_name}}, scheduled send self-test.', audience_json: '{}', status: 'scheduled',
      send_at: sendAtIso, provider: commsSendMode_(), created_by: 'selftest', created_at: new Date().toISOString(),
      total_recipients: 1, sendable_count: 1, sent_count: 0, failed_count: 0, skipped_count: 0
    });
    commsAppendRow_('log', { recipient_id: Utilities.getUuid(), unsubscribe_token: Utilities.getUuid(),
      campaign_id: cid, email: to, name: 'Sched', recipient_json: recJson, status: 'queued', attempt_count: 0 });
  };

  var pastId = 'SCHEDTEST-past-' + Utilities.getUuid();
  var futId  = 'SCHEDTEST-fut-'  + Utilities.getUuid();
  mkCampaign(pastId, new Date(Date.now() - 60000).toISOString());    // due → should promote+send
  mkCampaign(futId,  new Date(Date.now() + 3600000).toISOString());  // 1h out → should stay scheduled

  commsSweep_();

  var pastStatus = '?', futStatus = '?';
  commsSheetRows_('campaigns').forEach(function (c) {
    if (c.campaign_id === pastId) pastStatus = String(c.status);
    if (c.campaign_id === futId)  futStatus  = String(c.status);
  });

  handleCommsCancelCampaign_({ campaign_id: futId });
  var futAfter = '?', futRow = '?';
  commsSheetRows_('campaigns').forEach(function (c) { if (c.campaign_id === futId) futAfter = String(c.status); });
  commsSheetRows_('log').forEach(function (r) { if (r.campaign_id === futId) futRow = String(r.status); });

  commsEnsureGuardTrigger_();
  var guard = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'commsSweepGuard_'; });

  if (!payload.keep) {
    [pastId, futId].forEach(function (cid) {
      commsDeleteRowById_('campaigns', 'campaign_id', cid);
      var sheet = commsSheet_('log'), headers = commsActualHeaders_(sheet), last = sheet.getLastRow();
      var idx = headers.indexOf('campaign_id');
      for (var i = last; i >= 2; i--) { if (String(sheet.getRange(i, idx + 1).getValue()) === cid) sheet.deleteRow(i); }
    });
    commsRecomputeWake_();
  }

  return {
    ok: true,
    past_due_status: pastStatus, past_due_expect: 'done',
    future_status_after_sweep: futStatus, future_expect: 'scheduled',
    future_after_cancel: futAfter, future_cancel_expect: 'cancelled',
    future_row_after_cancel: futRow, future_row_expect: 'cancelled',
    guard_trigger_installed: guard,
    pass: (pastStatus === 'done' && futStatus === 'scheduled' && futAfter === 'cancelled'
           && futRow === 'cancelled' && guard === true)
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 6 — Opt-outs + public unsubscribe flow
// ═══════════════════════════════════════════════════════════════════════════

function commsMaskEmail_(email) {
  email = String(email || '');
  var at = email.indexOf('@');
  if (at <= 0) return email;
  return email.charAt(0) + '•••' + email.slice(at);
}

// Resolve a public unsubscribe token → { email, category } (or null).
function commsLookupUnsubToken_(token) {
  token = String(token || '');
  if (!token) return null;
  var found = null;
  commsSheetRows_('log').forEach(function (r) {
    if (String(r.unsubscribe_token) === token) found = r;
  });
  if (!found) return null;
  var category = 'service_update';
  commsSheetRows_('campaigns').forEach(function (c) {
    if (String(c.campaign_id) === String(found.campaign_id)) category = String(c.category) || 'service_update';
  });
  return { email: String(found.email || ''), category: category };
}

// Insert or broaden an opt-out (scope 'all' always wins over a narrower one).
function commsUpsertOptOut_(email, scope, source, token) {
  email = String(email || '').trim().toLowerCase();
  if (!email) return;
  if (scope !== 'all' && scope !== 'marketing_announcements') scope = 'all';
  var sheet = commsSheet_('optouts');
  var headers = commsActualHeaders_(sheet);
  var existing = null;
  commsSheetRows_('optouts').forEach(function (r) {
    if (String(r.email || '').trim().toLowerCase() === email) existing = r;
  });
  var now = new Date().toISOString();
  if (existing) {
    var merged = (String(existing.scope) === 'all' || scope === 'all') ? 'all' : scope;
    commsPatchRow_(sheet, headers, existing._row,
      { scope: merged, opted_out_at: now, source: source, recipient_id: token || existing.recipient_id || '' });
  } else {
    commsAppendRow_('optouts', { email: email, scope: scope, opted_out_at: now, source: source, recipient_id: token || '' });
  }
}

// Branded standalone HTML page for the unsubscribe flow (HtmlService).
function commsUnsubPage_(heading, message, formHtml) {
  var b = commsBrandCfg_();
  var html =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>body{margin:0;background:#F3F5F6;font-family:\'Open Sans\',Arial,sans-serif;color:#222}' +
    '.card{max-width:480px;margin:48px auto;background:#fff;border:1px solid #E4E8EA;border-radius:10px;overflow:hidden}' +
    '.hd{background:#0D3D3E;padding:20px 24px;color:#fff;font-weight:bold;font-size:18px}' +
    '.bd{padding:24px}.bd p{line-height:1.6}' +
    'button{background:#1FA7A8;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:15px;cursor:pointer}' +
    'select{padding:8px;border:1px solid #ccc;border-radius:6px;font-size:15px;margin:8px 0}' +
    '.ft{padding:14px 24px;color:#8aa;font-size:12px;border-top:1px solid #eef}</style></head><body>' +
    '<div class="card"><div class="hd">' + commsEscapeHtml_(b.name) + '</div>' +
    '<div class="bd"><h2 style="margin-top:0;color:#0D3D3E;">' + commsEscapeHtml_(heading) + '</h2>' +
    '<p>' + message + '</p>' + (formHtml || '') + '</div>' +
    '<div class="ft">' + commsEscapeHtml_(b.name) + ' &bull; ' + commsEscapeHtml_(b.phone) + '</div></div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('Unsubscribe — ' + b.name)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// GET ?action=comms_unsubscribe&t=<token> — read-only confirmation page.
// (No state change on GET, so link scanners / mailbox previews can't opt anyone out.)
function handleCommsUnsubscribePage_(e) {
  var token = (e && e.parameter && e.parameter.t) || '';
  var info = commsLookupUnsubToken_(token);
  if (!info) return commsUnsubPage_('Link not recognized', 'This unsubscribe link is invalid or expired.', '');
  var masked = commsEscapeHtml_(commsMaskEmail_(info.email));
  var exec = commsExecUrl_();
  var actionUrl = exec + (exec.indexOf('?') === -1 ? '?' : '&') + 'action=comms_unsubscribe_confirm';
  var scopePicker = '';
  if (info.category === 'service_update') {
    scopePicker = '<input type="hidden" name="scope" value="all">';
  } else {
    scopePicker =
      '<label>Unsubscribe from:</label><br>' +
      '<select name="scope">' +
      '<option value="marketing_announcements">Marketing &amp; announcements</option>' +
      '<option value="all">All emails</option>' +
      '</select><br>';
  }
  var form =
    '<form method="post" action="' + commsEscapeHtml_(actionUrl) + '">' +
    '<input type="hidden" name="t" value="' + commsEscapeHtml_(token) + '">' +
    scopePicker +
    '<button type="submit">Unsubscribe</button></form>';
  return commsUnsubPage_('Unsubscribe ' + masked + '?',
    'Confirm to stop receiving emails at this address.', form);
}

// POST (param-branch) ?action=comms_unsubscribe_confirm — finalize the opt-out.
function handleCommsUnsubConfirm_(e) {
  var token = (e && e.parameter && e.parameter.t) || '';
  var scope = (e && e.parameter && e.parameter.scope) || 'all';
  var info = commsLookupUnsubToken_(token);
  if (!info) return commsUnsubPage_('Link not recognized', 'This unsubscribe link is invalid or expired.', '');
  if (scope !== 'all' && scope !== 'marketing_announcements') scope = 'all';
  commsUpsertOptOut_(info.email, scope, 'link', token);
  var masked = commsEscapeHtml_(commsMaskEmail_(info.email));
  var what = (scope === 'all') ? 'emails' : 'marketing &amp; announcement emails';
  return commsUnsubPage_('You\'re unsubscribed',
    masked + ' will no longer receive ' + what + ' from us. It may take a moment to take effect.', '');
}

// ─── Admin opt-out management ────────────────────────────────────────────────
function handleCommsAddOptout_(payload) {
  commsEnsureSheets_();
  var email = commsNorm_(payload.email).toLowerCase();
  if (!email || !COMMS_EMAIL_RE.test(email)) return { ok: false, error: 'A valid email is required.' };
  var scope = commsNorm_(payload.scope) || 'all';
  commsUpsertOptOut_(email, scope, 'manual', '');
  return { ok: true };
}
function handleCommsRemoveOptout_(payload) {
  commsEnsureSheets_();
  var email = commsNorm_(payload.email).toLowerCase();
  if (!email) return { ok: false, error: 'email required' };
  var sheet = commsSheet_('optouts');
  var headers = commsActualHeaders_(sheet);
  var idx = headers.indexOf('email');
  var last = sheet.getLastRow();
  var removed = false;
  for (var i = last; i >= 2; i--) {
    if (String(sheet.getRange(i, idx + 1).getValue()).trim().toLowerCase() === email) { sheet.deleteRow(i); removed = true; }
  }
  return { ok: removed, error: removed ? '' : 'Not found' };
}
function handleCommsListOptouts_() {
  commsEnsureSheets_();
  var rows = commsSheetRows_('optouts').map(function (r) {
    return { email: r.email, scope: r.scope, opted_out_at: r.opted_out_at, source: r.source };
  });
  return { ok: true, optouts: rows };
}

// Admin self-test for the unsubscribe flow + opt-out scope semantics. Seeds
// throwaway log rows (no real emails sent), exercises the GET page (must be
// read-only), the POST confirm, and scope filtering, then cleans up.
function handleCommsSelftestUnsub_(payload) {
  commsEnsureSheets_();
  function mk(email, category) {
    var token = Utilities.getUuid();
    var cid = 'UNSUBTEST-' + Utilities.getUuid();
    commsAppendRow_('campaigns', { campaign_id: cid, name: 'unsub selftest', category: category, subject: 'x',
      body_markup: 'x', audience_json: '{}', status: 'done', provider: commsSendMode_(), created_by: 'selftest',
      created_at: new Date().toISOString(), total_recipients: 1, sendable_count: 1, sent_count: 1, failed_count: 0, skipped_count: 0 });
    commsAppendRow_('log', { recipient_id: Utilities.getUuid(), unsubscribe_token: token, campaign_id: cid,
      email: email, name: 'x', recipient_json: '{}', status: 'sent', attempt_count: 1 });
    return { token: token, cid: cid };
  }
  function blocked(email, category) { return !!commsOptOutSet_(category)[String(email).toLowerCase()]; }

  var e1 = 'optout-all-selftest@example.com';
  var e2 = 'optout-mktg-selftest@example.com';
  var r1 = mk(e1, 'marketing');
  var r2 = mk(e2, 'marketing');

  // GET must be read-only — rendering the page creates no opt-out.
  var page1 = handleCommsUnsubscribePage_({ parameter: { t: r1.token } });
  var pageHtml = (page1 && page1.getContent) ? page1.getContent() : '';
  var getCreatedOptout = blocked(e1, 'marketing');

  // POST scope=all → blocks every category.
  handleCommsUnsubConfirm_({ parameter: { t: r1.token, scope: 'all' } });
  var e1Mktg = blocked(e1, 'marketing');
  var e1Svc  = blocked(e1, 'service_update');

  // POST scope=marketing_announcements → blocks marketing, allows service_update.
  handleCommsUnsubConfirm_({ parameter: { t: r2.token, scope: 'marketing_announcements' } });
  var e2Mktg = blocked(e2, 'marketing');
  var e2Svc  = blocked(e2, 'service_update');

  var badPage = handleCommsUnsubscribePage_({ parameter: { t: 'nonexistent-token' } });
  var badHtml = (badPage && badPage.getContent) ? badPage.getContent() : '';

  var out = {
    ok: true,
    get_page_renders_form: (pageHtml.indexOf('Unsubscribe') !== -1 && pageHtml.indexOf('<form') !== -1),
    get_is_readonly_no_optout: (getCreatedOptout === false),
    scope_all_blocks_marketing: e1Mktg,
    scope_all_blocks_service: e1Svc,
    scope_mktg_blocks_marketing: e2Mktg,
    scope_mktg_allows_service: (e2Svc === false),
    invalid_token_handled: (badHtml.indexOf('not recognized') !== -1)
  };
  out.pass = out.get_page_renders_form && out.get_is_readonly_no_optout && out.scope_all_blocks_marketing
    && out.scope_all_blocks_service && out.scope_mktg_blocks_marketing && out.scope_mktg_allows_service
    && out.invalid_token_handled;

  if (!payload.keep) {
    [e1, e2].forEach(function (em) { handleCommsRemoveOptout_({ email: em }); });
    [r1.cid, r2.cid].forEach(function (cid) {
      commsDeleteRowById_('campaigns', 'campaign_id', cid);
      var sheet = commsSheet_('log'), headers = commsActualHeaders_(sheet), last = sheet.getLastRow();
      var idx = headers.indexOf('campaign_id');
      for (var i = last; i >= 2; i--) { if (String(sheet.getRange(i, idx + 1).getValue()) === cid) sheet.deleteRow(i); }
    });
  }
  return out;
}
