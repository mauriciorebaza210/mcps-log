// ══════════════════════════════════════════════════════════════════════════════
// MAIN: entry points for the Lifecycle Email Engine (runs as Tony).
//
//   eeSetup()            one-time (and safe to re-run): tabs, Journal, folders, seeds   (Setup.js)
//   eeAddTestContacts()  two test contacts at Mau's address (B and C)                   (Setup.js)
//   eeApprove(stepId)    publish an immutable revision of a step's draft                 (Revisions.js)
//   eeRunNow()           run the engine once, now
//   eeInstall()          install the daily trigger (run as Tony)
//   doGet / doPost       whoami + health (JSON), and the interim unsubscribe page
// ══════════════════════════════════════════════════════════════════════════════

var EE_VERSION = 'cp6-5';

function EE_core_() { var env = EE_env(); return { env: env, core: EE_createCore(env) }; }

// Today's snapshot for the planner (Planner.js → EE_planDay).
function EE_readSnapshot_(env) {
  var cfg = EE_config_(env.store);
  var rulesets = {};
  env.store.rows('Rulesets').forEach(function (r) { rulesets[r.rule_rev] = r.json; });
  var published = {};
  env.store.rows('Revisions').forEach(function (r) {
    if (r.status === 'published' && (!published[r.step_id] || published[r.step_id].rev_no < r.rev_no)) published[r.step_id] = r;
  });
  var publishedRevision = {};
  Object.keys(published).forEach(function (k) { publishedRevision[k] = published[k].revision_id; });
  var today = MCPS_LIFECYCLE.localDate(new Date(), EE_TZ);

  var settings = SpreadsheetApp.openById(EE_props_().getProperty('EE_SETTINGS_SS_ID'));
  var suppressions = [];
  var opt = settings.getSheetByName('Comms_Optouts');
  if (opt && opt.getLastRow() > 1) {
    var oh = opt.getRange(1, 1, 1, opt.getLastColumn()).getValues()[0];
    opt.getRange(2, 1, opt.getLastRow() - 1, oh.length).getValues().forEach(function (v) {
      if (v[oh.indexOf('removed_at')]) return;
      suppressions.push({ email_norm: String(v[oh.indexOf('email')]).toLowerCase(), mode: 'production',
        scope: String(v[oh.indexOf('scope')]) === 'all' ? 'all' : 'marketing' });
    });
  }
  env.store.rows('Suppressions_Test').forEach(function (s) { suppressions.push({ email_norm: s.email_norm, scope: s.scope, mode: 'test' }); });
  var commsSentToday = [];
  var log = settings.getSheetByName('Comms_Log');
  if (log && log.getLastRow() > 1) {
    var lh = log.getRange(1, 1, 1, log.getLastColumn()).getValues()[0];
    log.getRange(2, 1, log.getLastRow() - 1, lh.length).getValues().forEach(function (v) {
      var sent = v[lh.indexOf('sent_at')];
      if (String(v[lh.indexOf('status')]) === 'sent' && sent && MCPS_LIFECYCLE.localDay(sent instanceof Date ? sent.toISOString() : String(sent), EE_TZ) === today) {
        commsSentToday.push(String(v[lh.indexOf('email')]).toLowerCase());
      }
    });
  }
  return { today: today, engineMode: cfg.engine_mode === 'production' ? 'production' : 'test', ruleRev: cfg.rule_rev,
    rulesets: rulesets, contacts: env.store.rows('Contacts'), enrollments: env.store.rows('Enrollments'),
    deliveries: env.store.rows('Deliveries'), holds: env.store.rows('Holds'), inbox: env.store.rows('Inbox'),
    suppressions: suppressions, commsSentToday: commsSentToday,
    paused: { all: String(cfg.engine_enabled) === 'false', buckets: env.config.pausedBuckets() },
    publishedRevision: publishedRevision };
}

function EE_sentToday_(env) {
  var today = MCPS_LIFECYCLE.localDate(new Date(), EE_TZ);
  return env.store.rows('Deliveries').filter(function (d) {
    return d.state === 'sent' && MCPS_LIFECYCLE.localDay(d.sent_at, EE_TZ) === today;
  }).length;
}

function EE_run_(trigger) {
  var x = EE_core_();
  var cfg = EE_config_(x.env.store);
  var started = new Date().toISOString(), summary, scan = null;
  // Replies and bounces first, so today's plan already sees their stops (Replies.js).
  try { scan = EE_createReplyScanner(x.env, x.core).scan(); }
  catch (e) { scan = { error: String(e && e.message || e).slice(0, 200) }; try { x.env.alert('reply_scan_failed', scan.error); } catch (e2) { /* the run goes on */ } }
  try {
    summary = EE_runDay(x.core, x.env, function () { return EE_readSnapshot_(x.env); }, {
      trigger: trigger, dailyCap: Number(cfg.daily_cap || 50), budgetMs: 270000, sentToday: EE_sentToday_(x.env) });
  } catch (e) {
    // Unexpected failure: still log the run and alert, then surface the error.
    var why = String(e && e.message || e).slice(0, 300);
    try { x.env.store.upsert('Runs', { run_id: 'crash_' + Utilities.getUuid(), trigger: trigger, owner: x.env.user(),
      started_at: started, finished_at: new Date().toISOString(), stopped_reason: 'crashed: ' + why }); } catch (e2) { /* best effort */ }
    try { x.env.alert('run_crashed', why); } catch (e3) { /* best effort */ }
    throw e;
  }
  try {
    x.env.store.upsert('Runs', { run_id: summary.run_id, trigger: trigger, owner: x.env.user(), started_at: summary.started_at,
      finished_at: summary.finished_at, sent: summary.sent, skipped: summary.skipped, cancelled: summary.cancelled,
      reconcile: summary.reconcile, adopted: summary.adopted, failed: summary.failed || 0,
      stopped_reason: summary.stopped_reason, plan_json: summary.plan || {}, scan_json: scan || {} });
  } catch (e) { /* the run itself is already recorded in the Journal */ }
  summary.scan = scan;
  Logger.log(JSON.stringify(summary));
  return summary;
}
function eeRunNow() { return EE_run_('manual'); }

// What the engine sees right now: identity, Gmail quota, settings, row counts.
function eeDiagnostics() {
  var env = EE_env(), cfg = EE_config_(env.store);
  var d = { effective_user: env.user(), owner: env.config.ownerEmail(), mail_quota_remaining: MailApp.getRemainingDailyQuota(),
    quota_reserve: env.config.quotaReserve(), engine_mode: cfg.engine_mode, engine_enabled: cfg.engine_enabled,
    applied_seq: Number(env.meta.get('applied_seq') || 0), journal_head: (env.journal.last() || { seq: 0 }).seq,
    safety_pause: env.props.get('EE_SAFETY_PAUSE') || '',
    rows: { contacts: env.store.rows('Contacts').length, enrollments: env.store.rows('Enrollments').length,
      deliveries: env.store.rows('Deliveries').length, revisions: env.store.rows('Revisions').length } };
  Logger.log(JSON.stringify(d, null, 2));
  return d;
}
function EE_dailyTrigger() { return EE_run_('daily'); }

function eeInstall() {
  var me = Session.getEffectiveUser().getEmail();
  var owner = EE_props_().getProperty('EE_OWNER_EMAIL');
  if (owner && owner.toLowerCase() !== me.toLowerCase()) throw new Error('Install as the engine owner (' + owner + '), not ' + me + '.');
  ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'EE_dailyTrigger'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  var hour = Number(EE_config_(EE_env().store).run_hour || 9);
  ScriptApp.newTrigger('EE_dailyTrigger').timeBased().everyDays(1).atHour(hour).inTimezone(EE_TZ).create();
  EE_props_().setProperty('EE_TRIGGER_OWNER', me);
  Logger.log('Daily run installed at ' + hour + ':00 ' + EE_TZ + ' as ' + me + '.');
}

// ── Web app ──
function EE_json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'unsubscribe') return EE_unsubscribePage_(p.t, false);
  // whoami / health: who the engine runs as, and its state. No input is accepted here.
  var props = EE_props_(), out = { ok: true, version: EE_VERSION, effective_user: Session.getEffectiveUser().getEmail(),
    owner: props.getProperty('EE_OWNER_EMAIL') || '', safety_pause: props.getProperty('EE_SAFETY_PAUSE') || '' };
  try { var env = EE_env(); out.applied_seq = Number(env.meta.get('applied_seq') || 0); out.journal_head = (env.journal.last() || { seq: 0 }).seq; }
  catch (err) { out.ok = false; out.error = String(err.message || err).slice(0, 200); }
  return EE_json_(out);
}
function doPost(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'unsubscribe') return EE_unsubscribePage_(p.t, true);
  if (p.sig && e.postData && e.postData.contents) return EE_json_(EE_relay_(e));
  return EE_json_({ ok: false, error: 'unsupported' });
}
// Signed relay from api/email.js (api/_lib/email-relay.js): HMAC-SHA256 over the
// exact body (sig in the query string, since doPost can't read headers), a
// 5-minute timestamp window and a nonce, like ServiceRequestNotify.js.
function EE_relay_(e) {
  var secret = EE_props_().getProperty('EE_RELAY_SECRET');
  if (!secret) return { ok: false, error: 'relay not configured' };
  var raw = e.postData.contents;
  var want = EE_hmacHex_(secret, raw), got = String(e.parameter.sig || '');
  var diff = want.length === got.length ? 0 : 1;
  for (var i = 0; i < want.length && i < got.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  if (diff) return { ok: false, error: 'bad signature' };
  var msg; try { msg = JSON.parse(raw); } catch (err) { return { ok: false, error: 'bad body' }; }
  if (Math.abs(Date.now() - Number(msg.ts || 0)) > 5 * 60 * 1000) return { ok: false, error: 'stale' };
  var cache = CacheService.getScriptCache();
  if (!msg.nonce || cache.get('ee_nonce:' + msg.nonce)) return { ok: false, error: 'replayed' };
  cache.put('ee_nonce:' + msg.nonce, '1', 21600);
  if (msg.action === 'ee_admin') return EE_admin_(msg.admin || {});
  if (msg.action !== 'ee_track') return { ok: false, error: 'unknown action' };
  var x = EE_core_();
  return { ok: true, results: EE_createTracker(x.env, x.core).ingest(msg.events) };
}
// Interim unsubscribe (CP4 sandbox). GET shows a confirmation; only the POST
// records it, so link scanners can't unsubscribe anyone. CP5 moves this to the
// signed Vercel endpoint.
function EE_unsubscribePage_(token, confirm) {
  var page = function (title, body) {
    return HtmlService.createHtmlOutput('<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color:#2E3A3A;">' +
      '<h2 style="color:#0D3D3E;">' + title + '</h2>' + body + '</div>').setTitle('Mission Custom Pool Solutions');
  };
  var env = EE_env();
  var row = token ? env.store.rows('Deliveries').filter(function (d) { return d.token === String(token); })[0] : null;
  if (!row) return page('This link has expired', '<p>We couldn&rsquo;t find that email. To stop receiving emails, reply with “unsubscribe” and we&rsquo;ll take care of it.</p>');
  if (!confirm) {
    return page('Unsubscribe', '<p>Stop emails from Mission Custom Pool Solutions to <strong>' + row.email_norm.replace(/[<>&"]/g, '') + '</strong>?</p>' +
      '<form method="post" action="' + EE_props_().getProperty('EE_WEBAPP_URL') + '"><input type="hidden" name="action" value="unsubscribe" />' +
      '<input type="hidden" name="t" value="' + String(token).replace(/[^A-Za-z0-9_]/g, '') + '" />' +
      '<button style="background:#0D3D3E;color:#fff;border:0;border-radius:6px;padding:12px 22px;font-size:15px;cursor:pointer;">Unsubscribe</button></form>');
  }
  var core = EE_createCore(env);
  var r = core.ingest({ event_id: 'unsub_' + row.token, type: 'unsubscribe', mode: row.mode, email_norm: row.email_norm, scope: 'all' });
  return page(r.ok ? 'You&rsquo;re unsubscribed' : 'Something went wrong',
    r.ok ? '<p>You won&rsquo;t receive these emails anymore. If this was a mistake, just reply to any of our emails.</p>'
         : '<p>Please reply to our email with “unsubscribe” and we&rsquo;ll remove you right away.</p>');
}
