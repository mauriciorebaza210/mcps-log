// ══════════════════════════════════════════════════════════════════════════════
// ADMIN ACTIONS from the portal's Lifecycle Email page.
//
// Path: page → api/email.js op=admin (session + capability checked there) →
// signed relay (Main.js → EE_relay_, action ee_admin) → here. The actor is the
// portal username that Vercel validated; it is never taken from the browser.
// Every action is written to the ChangeLog tab, refused or not.
//
//   run_now            queue a run (a time-based trigger, so the page never waits on it)
//   set_enabled        engine on/off (Config engine_enabled; the core gate reads it at every authorization)
//   set_bucket_paused  pause / resume one sequence (Config paused_buckets)
//   mark_sent | abandon | resend   resolve an unconfirmed send (EngineCore's own rules,
//                       including the quiescence lock on Resend)
//   import_contacts    save imported contacts into Needs review (api/email.js → op=import checks them first;
//                       the engine re-checks emails). Do-not-contact rows go to the opt-out list.
//   create_batch       start N contacts from Needs review on a date ("pick now": the exact people; "at start":
//                       chosen on the date). A batch dated today starts immediately; later ones start in that
//                       morning's run (EE_startDueBatches_, called from Main.js).
//   cancel_batch       before it starts
//   list_templates | open_template | import_template | approve_draft | discard_draft   Template Library (Templates.js)
//   open_editor | save_draft   the portal's email editor (Templates.js)
//   move_batch         a planned batch to another start date (today or later)
//   send_override      one planned send: skip | move (inside its window) | next_run | clear (Overrides tab)
//   set_send_time      a campaign's default send time (Config send_time_<bucket>), then re-plan today's runs
//                       (create_batch also takes send_time: the batch's people keep it; Schedule.js)
//   list_attachments | add_attachment | approve_attachment | discard_attachment | rollback_attachment | retire_attachment
//                       the Attachment Library (Attachments.js)
//   trigger_test       { do: 'start' | 'result' } the trigger-precision spike (Schedule.js)
//   create_single | update_single | cancel_single   single emails: one email, one day, a chosen list (Singles.js)
//   publish_rules      an email's Setup edits (timing, stops, on/off) as a new immutable ruleset revision;
//                       scope 'all' moves running enrollments onto it, 'new' leaves them on theirs (EE_publishRules_)
//   save_import_mapping remember a spreadsheet's column mapping for the next file of the same shape
//   maintenance        run one allow-listed setup task as Tony (eeSetup, eeSetupMarketingKit,
//                       eeDiagnostics), so nobody has to click Run in the Apps Script editor.
//                       Only works for tasks whose Google permissions Tony has already granted.
// ══════════════════════════════════════════════════════════════════════════════

var EE_MAINTENANCE_TASKS = { setup: 'eeSetup', setup_marketing_kit: 'eeSetupMarketingKit', diagnostics: 'eeDiagnostics', backup: 'eeBackupNow', catch_up: 'eeCatchUp' };
var EE_TEMPLATE_ACTIONS = { list_templates: 1, open_template: 1, open_draft: 1, open_editor: 1, save_draft: 1, import_template: 1, approve_draft: 1, discard_draft: 1 };
var EE_ADMIN_ACTIONS = { alerts_forwarded: 1, trigger_test: 1, list_attachments: 1, add_attachment: 1, approve_attachment: 1, discard_attachment: 1, rollback_attachment: 1, retire_attachment: 1, create_single: 1, update_single: 1, cancel_single: 1, open_editor: 1, save_draft: 1, publish_rules: 1, update_contacts: 1, resolve_duplicates: 1, apply_incoming: 1, sync_startups: 1, set_crm_rule: 1, list_templates: 1, open_template: 1, open_draft: 1, import_template: 1, approve_draft: 1, discard_draft: 1, move_batch: 1, send_override: 1, set_send_time: 1, create_batch: 1, cancel_batch: 1, import_contacts: 1, save_import_mapping: 1, maintenance: 1, ping: 1, run_now: 1, set_enabled: 1, set_bucket_paused: 1, mark_sent: 1, abandon: 1, resend: 1 };

// deps: { scheduleRun() -> 'queued' | 'already_queued', planRuns() }  (Apps Script: triggers; tests: fakes)
function EE_adminRun_(env, core, req, deps) {
  var action = String(req.action || ''), p = req.params || {}, actor = String(req.actor || '').slice(0, 60);
  var out;
  // The full write path (auth, permissions, relay, engine) with no effect: the speed check (CP6c).
  if (action === 'ping') return { ok: true, at: new Date(env.now()).toISOString() };
  // Looking at templates changes nothing, so it isn't logged (Templates.js).
  if ((action === 'list_templates' || action === 'open_template' || action === 'open_draft' || action === 'open_editor') && actor) return EE_templateAction_(env, core, action, p, actor, deps);
  if (action === 'list_attachments' && actor) return EE_attachmentAction_(env, core, action, p, actor, deps);
  // The portal emailed every alert up to `upto` (an Alerts.at value). Bookkeeping only, so not in the ChangeLog.
  if (action === 'alerts_forwarded') {
    var upto = String(p.upto || '').slice(0, 40), was = String((env.store.get('Config', 'alert_forwarded_at') || {}).value || '');
    if (!/^\d{4}-\d{2}-\d{2}T/.test(upto)) return { ok: false, error: 'upto required' };
    if (upto > was) env.store.upsert('Config', { key: 'alert_forwarded_at', value: upto });
    return { ok: true, alert_forwarded_at: upto > was ? upto : was };
  }
  if (!EE_ADMIN_ACTIONS[action]) out = { ok: false, error: 'unknown action' };
  else if (!actor) out = { ok: false, error: 'no actor' };
  else if (action === 'run_now') out = { ok: true, status: deps.scheduleRun() };
  else if (action === 'import_contacts') out = EE_importContacts_(env, core, p, actor);
  else if (action === 'create_batch') {
    out = EE_createBatch_(env, core, p, actor);
    // Today's runs may need this batch's time; one already past runs right away (row 61).
    if (out.ok && out.started && deps.scheduleRun && (!out.send_time || out.send_time <= MCPS_LIFECYCLE.localTime(new Date(env.now()), EE_TZ))) deps.scheduleRun();
    if (out.ok && deps.planRuns) { try { deps.planRuns(); } catch (e) { /* the scheduler retries tonight */ } }
  }
  else if (action === 'move_batch') {
    var mb = env.store.get('Batches', String(p.batch_id || '')), to = String(p.start_on || '');
    if (!mb) out = { ok: false, error: 'batch not found' };
    else if (mb.status !== 'planned') out = { ok: false, error: 'already ' + mb.status };
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(to) || to < EE_today_(env)) out = { ok: false, error: 'pick today or a later day' };
    else {
      env.store.upsert('Batches', EE_merge_(mb, { start_on: to }));
      out = { ok: true, start_on: to };
      if (to <= EE_today_(env)) out.started = EE_startBatch_(env, core, EE_merge_(mb, { start_on: to }), actor);
      if (deps.planRuns) { try { deps.planRuns(); } catch (e) { /* the scheduler retries tonight */ } }
    }
  }
  else if (action === 'send_override') out = EE_sendOverride_(env, p, actor);
  else if (action === 'trigger_test') out = EE_triggerTestPure_(env, p.do === 'result' ? 'result' : 'start', deps.triggerTest || (typeof EE_triggerTestDeps_ === 'function' ? EE_triggerTestDeps_() : null));
  else if (typeof EE_ATTACH_ACTIONS !== 'undefined' && EE_ATTACH_ACTIONS[action]) out = EE_attachmentAction_(env, core, action, p, actor, deps);
  else if (action === 'create_single' || action === 'update_single' || action === 'cancel_single') {
    out = EE_singleAction_(env, core, action, p, actor);
    if (out.ok && deps.planRuns) { try { deps.planRuns(); } catch (e) { /* the scheduler retries tonight */ } }
  }
  else if (action === 'publish_rules') {
    out = EE_publishRules_(env, core, p, actor);
    if (out.ok && deps.planRuns) { try { deps.planRuns(); } catch (e) { /* the scheduler retries tonight */ } }
  }
  else if (action === 'sync_startups') {
    out = EE_syncStartups_(env, core, p, actor);
    // A newly approved startup gets its at-approval Welcome within minutes (quiet hours apply).
    if (out.ok && out.added && deps.scheduleRun) { try { out.run = deps.scheduleRun(); } catch (e) { /* the next planned run sends it */ } }
  }
  else if (action === 'update_contacts') out = EE_updateContacts_(env, core, p, actor);
  else if (action === 'resolve_duplicates') out = EE_resolveDuplicates_(env, core, p, actor);
  else if (action === 'apply_incoming') out = EE_applyIncoming_(env, core, p, actor);
  else if (action === 'set_crm_rule') {
    var rule = p.rule && typeof p.rule === 'object' ? p.rule : null;
    if (!rule) out = { ok: false, error: 'rule required' };
    else {
      env.store.upsert('Config', { key: 'crm_lead_rule', value: JSON.stringify({ statuses: rule.statuses || ['LEAD'], lead_sources: rule.lead_sources || [],
        year_built: rule.year_built || 'any', areas: rule.areas || [], group: rule.group || 'B' }) });
      env.store.upsert('Config', { key: 'crm_lead_auto', value: p.auto ? 'true' : 'false' });
      out = { ok: true, auto: !!p.auto };
    }
  }
  else if (EE_TEMPLATE_ACTIONS[action]) out = EE_templateAction_(env, core, action, p, actor, deps);
  else if (action === 'set_send_time') {
    var sb = String(p.bucket || ''), st = EE_validSendTime_(p.time);
    if (!/^[A-F]$/.test(sb) || !st) out = { ok: false, error: 'bucket A–F and a time between 6:00 AM and 8:00 PM on a quarter hour required' };
    else {
      env.store.upsert('Config', { key: 'send_time_' + sb, value: st });
      out = { ok: true, bucket: sb, time: st };
      if (deps.planRuns) { try { out.runs = deps.planRuns().times; } catch (e) { /* the scheduler retries tonight */ } }
    }
  }
  else if (action === 'cancel_batch') {
    var bt = env.store.get('Batches', String(p.batch_id || ''));
    if (!bt) out = { ok: false, error: 'batch not found' };
    else if (bt.status !== 'planned') out = { ok: false, error: 'already ' + bt.status };
    else { env.store.upsert('Batches', EE_merge_(bt, { status: 'cancelled', cancelled_by: actor, cancelled_at: new Date(env.now()).toISOString() })); out = { ok: true }; }
  }
  else if (action === 'save_import_mapping') {
    var key = String(p.key || '').slice(0, 300);
    if (!key || typeof p.mapping !== 'object') out = { ok: false, error: 'key and mapping required' };
    else {
      env.store.upsert('Config', { key: 'import_mapping:' + key, value: JSON.stringify({ mapping: p.mapping, source: String(p.source || '').slice(0, 80),
        saved_by: actor, at: new Date(env.now()).toISOString() }) });
      out = { ok: true };
    }
  }
  else if (action === 'maintenance') {
    var fn = EE_MAINTENANCE_TASKS[String(p.task || '')];
    if (!fn || !deps.runTask) out = { ok: false, error: 'unknown task' };
    else { try { out = { ok: true, task: p.task, result: deps.runTask(fn) }; } catch (e) { out = { ok: false, error: String(e && e.message || e).slice(0, 300) }; } }
  }
  else if (action === 'set_enabled') {
    if (typeof p.enabled !== 'boolean') out = { ok: false, error: 'enabled must be true or false' };
    else { env.store.upsert('Config', { key: 'engine_enabled', value: p.enabled ? 'true' : 'false' }); out = { ok: true, enabled: p.enabled }; }
  } else if (action === 'set_bucket_paused') {
    var b = String(p.bucket || '');
    if (!/^(?:[A-F]|S[0-9A-F]{6})$/.test(b) || typeof p.paused !== 'boolean') out = { ok: false, error: 'a sequence (A–F or a single email) and paused true/false required' };
    else {
      var cur = env.config.pausedBuckets().filter(function (x) { return x !== b; });
      if (p.paused) cur.push(b);
      env.store.upsert('Config', { key: 'paused_buckets', value: cur.sort().join(',') });
      out = { ok: true, paused_buckets: cur.sort() };
    }
  } else {
    var id = String(p.delivery_id || '');
    if (!id) out = { ok: false, error: 'delivery_id required' };
    else if (action === 'mark_sent') out = core.markSent(id, actor);
    else if (action === 'abandon') {
      var row = env.store.get('Deliveries', id);
      out = core.abandon(id, actor);
      // Its draft (if Gmail still has one) must never be sent by hand later.
      if (out.ok && row && row.draft_id) { try { env.gmail.deleteDraft(row.draft_id); } catch (e) { /* already gone */ } }
    } else out = core.resend(id, actor);                 // { ok } | { ok:false, reason:'quiescence', unlock_at }
  }
  try {
    env.withLock(function () {
      env.store.upsert('ChangeLog', { id: 'chg_' + env.uuid(), at: new Date(env.now()).toISOString(), actor: actor, action: action,
        detail: JSON.stringify(p).slice(0, 300), result: out.ok ? 'ok' : String(out.error || out.reason || 'refused').slice(0, 120) });
    });
  } catch (e) { /* the action itself is already done or refused; the log is best effort */ }
  return out;
}

// Imported contacts land in Needs review: nobody is emailed by an import, and in
// test mode the planner ignores real contacts anyway. Ids come from the email,
// so a retried chunk never creates a second contact.
var EE_IMPORT_MAX = 100;
function EE_importContacts_(env, core, p, actor) {
  var group = String(p.group || ''), list = p.contacts || [];
  if (!/^[A-F]$/.test(group)) return { ok: false, error: 'group A-F required' };
  if (!Array.isArray(list) || list.length > EE_IMPORT_MAX) return { ok: false, error: 'send at most ' + EE_IMPORT_MAX + ' contacts per call' };
  var existing = {};
  env.store.rows('Contacts').forEach(function (c) {
    [c.email_norm].concat(String(c.alt_emails || '').split(',')).forEach(function (e) { e = String(e || '').trim().toLowerCase(); if (e) existing[e] = c.contact_id; });
  });
  var added = [], skipped = [], now = new Date(env.now()).toISOString();
  list.forEach(function (c) {
    var email = String(c.email_norm || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { skipped.push({ email_norm: email, reason: 'bad_email' }); return; }
    if (existing[email]) { skipped.push({ email_norm: email, reason: 'existing', contact_id: existing[email] }); return; }
    var id = 'ct_' + env.sha256(email).slice(0, 16), rec = {};
    ['first_name', 'last_name', 'phone', 'address', 'city', 'state', 'zip', 'area', 'pool_build_year', 'notes', 'tags', 'source', 'quote_id', 'name_original', 'name_kind', 'duplicate_of']
      .forEach(function (k) { rec[k] = String(c[k] == null ? '' : c[k]); });
    if (!rec.source) rec.source = String(p.source || '').slice(0, 80);       // the import's source, when rows don't carry one
    rec.contact_id = id; rec.email_norm = email; rec.bucket = group; rec.sub_bucket = group === 'B' ? 'B1' : '';
    // A possible duplicate (automatic MCP lead sync can't ask) waits for a person; batches never pick it.
    rec.review_status = rec.duplicate_of ? 'possible_duplicate' : 'needs_review'; rec.review_reason = rec.duplicate_of ? 'possible duplicate' : 'imported'; rec.is_test = 'N';
    rec.created_at = now; rec.imported_by = actor;
    core.commitEntity('contact', rec, 'contact:' + id + ':import');
    existing[email] = id; added.push(id);
  });
  // "Do not contact" in the file is a real person's wish: it goes to the real opt-out list.
  var dnc = (p.do_not_contact || []).map(function (e) { return String(e || '').trim().toLowerCase(); }).filter(Boolean);
  dnc.forEach(function (e) { core.ingest({ event_id: 'dnc_' + env.sha256(e).slice(0, 16), type: 'unsubscribe', mode: 'production', email_norm: e, scope: 'all' }); });
  return { ok: true, added: added.length, skipped: skipped, do_not_contact_recorded: dnc.length };
}

function EE_merge_(a, b) { var o = {}, k; for (k in a || {}) o[k] = a[k]; for (k in b || {}) o[k] = b[k]; return o; }

// ── Batches ──
var EE_BATCH_MAX = 500;
function EE_today_(env) { return MCPS_LIFECYCLE.localDate(new Date(env.now()), EE_TZ); }
function EE_createBatch_(env, core, p, actor) {
  var group = String(p.group || ''), count = Math.floor(Number(p.count) || 0), startOn = String(p.start_on || '');
  var pickNow = p.pick !== 'at_start', today = EE_today_(env);
  if (!/^[A-F]$/.test(group)) return { ok: false, error: 'group A-F required' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startOn)) startOn = today;
  if (startOn < today) return { ok: false, error: 'the start date is in the past' };
  var ids = [];
  if (pickNow) {
    ids = (p.contact_ids || []).map(String).filter(Boolean);
    if (!ids.length || ids.length > EE_BATCH_MAX) return { ok: false, error: 'pick 1 to ' + EE_BATCH_MAX + ' people' };
    count = ids.length;
  } else if (count < 1 || count > EE_BATCH_MAX) return { ok: false, error: 'count 1 to ' + EE_BATCH_MAX };
  var filters = p.filters && typeof p.filters === 'object' ? p.filters : {};
  var sendTime = '';
  // People who already had the campaign, restarted on purpose (people chosen now only).
  var restartIds = pickNow ? (p.restart_ids || []).map(String).filter(function (x) { return ids.indexOf(x) !== -1; }) : [];
  if (p.send_time) { sendTime = EE_validSendTime_(p.send_time); if (!sendTime) return { ok: false, error: 'send time must be 6:00 AM–8:00 PM on a quarter hour' }; }
  var id = 'bat_' + env.uuid().replace(/-/g, '').slice(-12);
  if (env.store.get('Batches', id)) return { ok: false, error: 'id collision, try again' };
  var batch = { batch_id: id, name: String(p.name || '').slice(0, 80), group: group, filters_json: filters, count: count,
    order: p.order === 'oldest' ? 'oldest' : 'random', pick: pickNow ? 'now' : 'at_start', start_on: startOn,
    contact_ids: ids, send_time: sendTime, restart_ids: restartIds, status: 'planned', created_by: actor, created_at: new Date(env.now()).toISOString() };
  env.store.upsert('Batches', batch);
  if (startOn <= today) return { ok: true, batch_id: id, send_time: sendTime, started: EE_startBatch_(env, core, batch, actor) };
  return { ok: true, batch_id: id, start_on: startOn, send_time: sendTime };
}
// Confirms the batch's people, so the next run starts their sequence. Someone who
// is no longer waiting in Needs review (enrolled, edited, removed) is skipped.
function EE_startBatch_(env, core, b, actor) {
  var enrolled = {}, going = {};
  env.store.rows('Enrollments').forEach(function (e) {
    enrolled[e.contact_id] = true;
    if (/^(active|waiting_anchor|paused)$/.test(e.status)) going[e.contact_id] = true;
  });
  var restart = {};
  (b.restart_ids || []).forEach(function (id) { restart[id] = true; });
  var contacts = env.store.rows('Contacts').map(function (c) { if (enrolled[c.contact_id]) c.enrolled = true; return c; }), byId = {};
  contacts.forEach(function (c) { byId[c.contact_id] = c; });
  var filters = typeof b.filters_json === 'object' && b.filters_json ? b.filters_json : {};
  var ids = b.pick === 'now' ? (b.contact_ids || [])
    : MCPS_BATCHES.pick(contacts, { group: b.group, filters: filters, count: b.count, order: b.order }, Math.random).map(function (c) { return c.contact_id; });
  var started = 0, skipped = [];
  ids.forEach(function (cid) {
    var c = byId[cid];
    // Restarts (row 64): only someone whose earlier sequence has ended.
    if (restart[cid] && c && c.bucket === b.group) {
      if (going[cid]) { skipped.push({ contact_id: cid, reason: 'still_in_sequence' }); return; }
      core.commitEntity('contact', { contact_id: cid, review_status: 'confirmed', review_reason: 'restart: batch ' + b.batch_id,
        restart_ok: b.batch_id, send_time: MCPS_LIFECYCLE.normTime(b.send_time),
        // From the first email again: MCP Legacy's Intro is for B1 (it moves them to B2).
        sub_bucket: b.group === 'B' ? 'B1' : (c.sub_bucket || '') }, 'contact:' + cid + ':restart:' + b.batch_id);
      started++;
      return;
    }
    if (!c || c.review_status !== 'needs_review' || c.bucket !== b.group) { skipped.push({ contact_id: cid, reason: c ? 'no longer waiting' : 'not found' }); return; }
    if (c.enrolled) { skipped.push({ contact_id: cid, reason: 'already had a sequence' }); return; }
    core.commitEntity('contact', { contact_id: cid, review_status: 'confirmed', review_reason: 'batch ' + b.batch_id, send_time: MCPS_LIFECYCLE.normTime(b.send_time) },
      'contact:' + cid + ':batch:' + b.batch_id);
    started++;
  });
  // A sheet write replaces the whole row: always merge into the stored batch.
  env.store.upsert('Batches', EE_merge_(env.store.get('Batches', b.batch_id) || b, { status: 'started', started_at: new Date(env.now()).toISOString(),
    started_count: started, skipped_json: skipped, contact_ids: b.pick === 'now' ? b.contact_ids : ids }));
  return { started: started, skipped: skipped.length };
}
// Called at the start of every run: batches whose day has come.
function EE_startDueBatches_(env, core) {
  var today = EE_today_(env), out = [];
  env.store.rows('Batches').filter(function (b) { return b.status === 'planned' && String(b.start_on) <= today; })
    .forEach(function (b) { out.push({ batch_id: b.batch_id, result: EE_startBatch_(env, core, b, 'schedule') }); });
  return out;
}

// Apps Script entry for the relay.
function EE_admin_(req) {
  var x = EE_core_();
  return EE_adminRun_(x.env, x.core, req, { scheduleRun: EE_scheduleRunNow_, drive: EE_driveDeps_(), files: EE_attachFilesDeps_(), planRuns: function () { return EE_planRuns_(x.env, EE_triggerDeps_()); },
    runTask: function (name) { return typeof globalThis[name] === 'function' ? globalThis[name]() : { error: 'missing ' + name }; } });
}
// One pending run at a time; the trigger removes itself when it fires.
function EE_scheduleRunNow_() {
  var pending = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'EE_runNowTrigger'; });
  if (pending.length) return 'already_queued';
  ScriptApp.newTrigger('EE_runNowTrigger').timeBased().after(1000).create();
  return 'queued';
}
function EE_runNowTrigger() {
  ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'EE_runNowTrigger'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  return EE_run_('portal');
}

// ── Per-send overrides (PLAN.md → Per-send overrides; rows 62–63) ─────────────
// Checked against the email's own plan (decide() without overrides), so a move
// stays inside its window and "next run" waits for its prerequisite.
var EE_OPEN_OUTCOMES = { due: 1, upcoming: 1, held: 1, paused: 1 };
function EE_overrideMap_(rows) {
  var m = {};
  (rows || []).forEach(function (r) { if (r.kind && r.kind !== 'clear') m[r.key] = { kind: r.kind, date: r.date || '' }; });
  return m;
}
function EE_planOne_(env, en) {
  var rulesets = {};
  env.store.rows('Rulesets').forEach(function (r) { rulesets[r.rule_rev] = r.json; });
  var holds = {};
  env.store.rows('Holds').forEach(function (h) { holds[h.key] = Number(h.held_days || 0); });
  var cfg = EE_config_(env.store), byBucket = EE_sendTimes_(cfg), sendTimes = {};
  ((rulesets[en.rule_rev] || {}).sequences || []).forEach(function (s) { sendTimes[s.sequence_id] = byBucket[s.bucket]; });
  return MCPS_LIFECYCLE.decide({ today: EE_today_(env), rulesets: rulesets, contacts: [env.store.get('Contacts', en.contact_id) || {}],
    enrollments: [en], deliveries: env.store.rows('Deliveries').filter(function (d) { return d.enrollment_id === en.enrollment_id; }),
    holds: holds, signals: [], suppressions: [], paused: {}, sendTimes: sendTimes });
}
function EE_sendOverride_(env, p, actor) {
  var key = String(p.key || ''), kind = String(p.kind || ''), parts = key.split(':');
  if (parts.length !== 3) return { ok: false, error: 'key required' };
  if (!/^(skip|move|next_run|clear)$/.test(kind)) return { ok: false, error: 'kind must be skip, move, next_run or clear' };
  var en = env.store.get('Enrollments', parts[0]);
  if (!en || !/^(active|waiting_anchor|paused)$/.test(en.status)) return { ok: false, error: 'this person is no longer in the sequence' };
  var d = EE_planOne_(env, en).deliveries.filter(function (x) { return x.key === key; })[0];
  if (!d) return { ok: false, error: 'not a planned email' };
  if (kind !== 'clear' && !EE_OPEN_OUTCOMES[d.outcome]) return { ok: false, error: d.outcome === 'sent' ? 'already sent' : 'not planned (' + d.outcome + ')' };
  var date = '';
  if (kind === 'move') {
    date = String(p.date || '');
    var today = EE_today_(env);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || !d.due || date < d.due || date > d.last_send_day) {
      return { ok: false, error: 'pick a day from ' + (d.due < today ? today : d.due) + ' to ' + d.last_send_day };
    }
  }
  if (kind === 'next_run' && /prerequisite/.test(d.reason || '')) return { ok: false, error: 'the email before it hasn’t gone out yet' };
  env.withLock(function () {
    env.store.upsert('Overrides', { key: key, kind: kind, date: date, enrollment_id: en.enrollment_id, step_id: d.step_id, by: actor, at: new Date(env.now()).toISOString() });
  });
  return { ok: true, key: key, kind: kind, date: date };
}

// ── Startups from the portal (PLAN.md → "Connected to the portal's own data") ───
// api/email.js reads Quotes + the schedule and sends the startups it found; here
// they become confirmed MCP Startup contacts (only changed fields are written),
// and cancelled ones are removed with their sequence stopped.
var EE_STARTUP_FIELDS = ['quote_id', 'pool_id', 'first_name', 'last_name', 'phone', 'address', 'city', 'zip', 'area', 'startup_date', 'startup_source', 'pool_school'];
function EE_syncStartups_(env, core, p, actor) {
  var list = Array.isArray(p.contacts) ? p.contacts : [], removed = Array.isArray(p.removed) ? p.removed : [];
  if (list.length > 400) return { ok: false, error: 'send at most 400 startups per call' };
  var byQuote = {}, byEmail = {}, today = EE_today_(env), now = new Date(env.now()).toISOString();
  env.store.rows('Contacts').forEach(function (c) {
    if (c.quote_id) byQuote[c.quote_id] = c;
    byEmail[String(c.email_norm || '').toLowerCase()] = c;
  });
  var added = 0, updated = 0, skipped = [], gone = 0;
  list.forEach(function (s) {
    var email = String(s.email_norm || '').trim().toLowerCase(), qid = String(s.quote_id || '');
    if (!qid || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !/^\d{4}-\d{2}-\d{2}$/.test(String(s.startup_date || ''))) { skipped.push({ quote_id: qid, reason: 'incomplete' }); return; }
    var cur = byQuote[qid] || byEmail[email];
    if (cur && cur.bucket !== 'C') { skipped.push({ quote_id: qid, reason: 'in_' + cur.bucket + '_campaign', contact_id: cur.contact_id }); return; }
    var data = {};
    EE_STARTUP_FIELDS.forEach(function (k) { var v = String(s[k] == null ? '' : s[k]).slice(0, 200); if (!cur || String(cur[k] || '') !== v) data[k] = v; });
    if (cur && cur.review_status === 'removed') { data.review_status = 'confirmed'; data.review_reason = 'startup back on the schedule'; }
    if (cur && !Object.keys(data).length) return;
    if (!cur) {
      var id = 'ct_' + env.sha256(email).slice(0, 16);
      data.contact_id = id; data.email_norm = email; data.bucket = 'C'; data.sub_bucket = ''; data.is_test = 'N';
      data.review_status = 'confirmed'; data.review_reason = 'startup from the portal'; data.source = 'portal_startup';
      data.created_at = now; data.imported_by = actor;
      core.commitEntity('contact', data, 'contact:' + id + ':startup:' + qid);
      byQuote[qid] = data; byEmail[email] = data; added++;
    } else {
      data.contact_id = cur.contact_id; data.updated_at = now;
      core.commitEntity('contact', data, 'contact:' + cur.contact_id + ':sync:' + env.sha256(JSON.stringify(data)).slice(0, 12));
      updated++;
    }
  });
  var running = {};
  env.store.rows('Enrollments').forEach(function (e) { if (/^(active|waiting_anchor|paused)$/.test(e.status)) (running[e.contact_id] = running[e.contact_id] || []).push(e); });
  removed.forEach(function (r) {
    var c = byQuote[String(r.quote_id || '')];
    if (!c || c.review_status === 'removed') return;
    core.commitEntity('contact', { contact_id: c.contact_id, review_status: 'removed', review_reason: String(r.reason || 'startup_cancelled').slice(0, 60) },
      'contact:' + c.contact_id + ':removed:' + today);
    (running[c.contact_id] || []).forEach(function (e) {
      core.commitEntity('enrollment', { enrollment_id: e.enrollment_id, status: 'stopped', stop_reason: 'startup_cancelled', stopped_on: today },
        'enrollment:' + e.enrollment_id + ':startup_cancelled');
    });
    gone++;
  });
  var result = { added: added, updated: updated, removed: gone, skipped: skipped.length };
  env.store.upsert('Config', { key: 'crm_sync_at', value: now });
  env.store.upsert('Config', { key: 'crm_sync_result', value: JSON.stringify(result) });
  return { ok: true, added: added, updated: updated, removed: gone, skipped: skipped };
}

// ── Cleanup and duplicates (PLAN.md → "Contact cleanup and duplicates") ────────
var EE_EDITABLE = ['first_name', 'last_name', 'phone', 'address', 'city', 'zip', 'area', 'name_kind', 'email_norm', 'tags'];
var EE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// changes: [{ contact_id, fields }]. The first name change keeps the original in name_original.
function EE_updateContacts_(env, core, p, actor) {
  var list = Array.isArray(p.changes) ? p.changes : [];
  if (!list.length || list.length > 300) return { ok: false, error: 'send 1 to 300 changes' };
  var emails = {};
  env.store.rows('Contacts').forEach(function (c) { emails[String(c.email_norm || '').toLowerCase()] = c.contact_id; });
  var done = 0, skipped = [];
  list.forEach(function (ch) {
    var c = env.store.get('Contacts', String(ch.contact_id || ''));
    if (!c) { skipped.push({ contact_id: ch.contact_id, reason: 'not_found' }); return; }
    var data = { contact_id: c.contact_id };
    EE_EDITABLE.forEach(function (k) {
      if (!ch.fields || ch.fields[k] === undefined) return;
      var v = String(ch.fields[k] == null ? '' : ch.fields[k]).replace(/\s+/g, ' ').trim().slice(0, 200);
      if (k === 'email_norm') {
        v = v.toLowerCase();
        if (!EE_EMAIL_RE.test(v) || (emails[v] && emails[v] !== c.contact_id)) return;    // invalid or someone else's
        if (v !== c.email_norm) data.alt_emails = EE_addEmail_(c.alt_emails, c.email_norm);
      }
      if (String(c[k] || '') !== v) data[k] = v;
    });
    if ((data.first_name !== undefined || data.last_name !== undefined) && !c.name_original) data.name_original = [c.first_name, c.last_name].filter(Boolean).join(' ');
    if (Object.keys(data).length === 1) return;
    data.updated_at = new Date(env.now()).toISOString();
    core.commitEntity('contact', data, 'contact:' + c.contact_id + ':edit:' + env.sha256(JSON.stringify(data)).slice(0, 12));
    done++;
  });
  return { ok: true, updated: done, skipped: skipped };
}
function EE_addEmail_(list, email) {
  var have = String(list || '').split(',').map(function (e) { return e.trim().toLowerCase(); }).filter(Boolean);
  email = String(email || '').trim().toLowerCase();
  if (email && have.indexOf(email) === -1) have.push(email);
  return have.join(',');
}
function EE_stopRunning_(env, core, contactId, reason) {
  env.store.rows('Enrollments').filter(function (e) { return e.contact_id === contactId && /^(active|waiting_anchor|paused)$/.test(e.status); }).forEach(function (e) {
    core.commitEntity('enrollment', { enrollment_id: e.enrollment_id, status: 'stopped', stop_reason: reason, stopped_on: EE_today_(env) }, 'enrollment:' + e.enrollment_id + ':' + reason);
  });
}
// Keep one contact, fold the other in: its emails become alternates, blank fields are filled,
// it is marked merged (pointer kept) and its running sequence stops. Opt-outs are by email and still apply.
function EE_mergeInto_(env, core, keep, gone) {
  var data = { contact_id: keep.contact_id, alt_emails: EE_addEmail_(EE_addEmail_(keep.alt_emails, gone.email_norm), '') };
  String(gone.alt_emails || '').split(',').forEach(function (e) { data.alt_emails = EE_addEmail_(data.alt_emails, e); });
  data.alt_emails = data.alt_emails.split(',').filter(function (e) { return e && e !== String(keep.email_norm).toLowerCase(); }).join(',');
  ['first_name', 'last_name', 'phone', 'address', 'city', 'zip', 'area', 'pool_build_year', 'quote_id', 'tags'].forEach(function (k) {
    if (!String(keep[k] || '').trim() && String(gone[k] || '').trim()) data[k] = gone[k];
  });
  core.commitEntity('contact', data, 'contact:' + keep.contact_id + ':absorb:' + gone.contact_id);
  core.commitEntity('contact', { contact_id: gone.contact_id, review_status: 'merged', review_reason: 'merged into ' + keep.contact_id, merged_into: keep.contact_id },
    'contact:' + gone.contact_id + ':merged');
  EE_stopRunning_(env, core, gone.contact_id, 'merged');
}
// pairs: [{ a, b, action: keep_both | keep_a | keep_b | merge_into_a | merge_into_b }]
function EE_resolveDuplicates_(env, core, p, actor) {
  var pairs = Array.isArray(p.pairs) ? p.pairs : [];
  if (!pairs.length || pairs.length > 200) return { ok: false, error: 'send 1 to 200 pairs' };
  var done = 0, skipped = [];
  pairs.forEach(function (pr) {
    var a = env.store.get('Contacts', String(pr.a || '')), b = env.store.get('Contacts', String(pr.b || ''));
    if (!a || !b || a.contact_id === b.contact_id) { skipped.push({ a: pr.a, b: pr.b, reason: 'not_found' }); return; }
    var act = String(pr.action || '');
    if (act === 'keep_both') {
      [[a, b], [b, a]].forEach(function (x) {
        var d = { contact_id: x[0].contact_id, not_duplicate_of: EE_addEmail_(x[0].not_duplicate_of, x[1].contact_id) };
        if (x[0].review_status === 'possible_duplicate') { d.review_status = 'needs_review'; d.review_reason = 'not a duplicate'; d.duplicate_of = ''; }
        core.commitEntity('contact', d, 'contact:' + x[0].contact_id + ':notdup:' + x[1].contact_id);
      });
    } else if (act === 'keep_a' || act === 'keep_b') {
      var gone = act === 'keep_a' ? b : a;
      core.commitEntity('contact', { contact_id: gone.contact_id, review_status: 'removed', review_reason: 'duplicate of ' + (act === 'keep_a' ? a : b).contact_id },
        'contact:' + gone.contact_id + ':removed_dup');
      EE_stopRunning_(env, core, gone.contact_id, 'duplicate_removed');
    } else if (act === 'merge_into_a') EE_mergeInto_(env, core, a, b);
    else if (act === 'merge_into_b') EE_mergeInto_(env, core, b, a);
    else { skipped.push({ a: pr.a, b: pr.b, reason: 'unknown action' }); return; }
    done++;
  });
  return { ok: true, resolved: done, skipped: skipped };
}
// An incoming row (file import) that matches an engine contact: merge (fill blanks, its email
// becomes an alternate) or replace (its values win; the old email becomes an alternate).
function EE_applyIncoming_(env, core, p, actor) {
  var c = env.store.get('Contacts', String(p.contact_id || '')), inc = p.data || {}, mode = String(p.mode || '');
  if (!c) return { ok: false, error: 'contact not found' };
  if (mode !== 'merge' && mode !== 'replace') return { ok: false, error: 'mode must be merge or replace' };
  var data = { contact_id: c.contact_id }, email = String(inc.email_norm || '').trim().toLowerCase();
  ['first_name', 'last_name', 'phone', 'address', 'city', 'zip', 'area', 'pool_build_year', 'quote_id'].forEach(function (k) {
    var v = String(inc[k] == null ? '' : inc[k]).trim();
    if (v && (mode === 'replace' ? v !== String(c[k] || '') : !String(c[k] || '').trim())) data[k] = v.slice(0, 200);
  });
  if (EE_EMAIL_RE.test(email) && email !== c.email_norm) {
    if (mode === 'replace') { data.email_norm = email; data.alt_emails = EE_addEmail_(c.alt_emails, c.email_norm); }
    else data.alt_emails = EE_addEmail_(c.alt_emails, email);
  }
  if (Object.keys(data).length === 1) return { ok: true, changed: false };
  core.commitEntity('contact', data, 'contact:' + c.contact_id + ':' + mode + ':' + env.sha256(JSON.stringify(data)).slice(0, 12));
  return { ok: true, changed: true };
}

// The current ruleset (parsed) and its revision id.
function EE_currentRuleset_(env) {
  var row = env.store.get('Config', 'rule_rev'), rev = row && row.value, rs = rev && env.store.get('Rulesets', rev);
  if (!rs) return null;
  return { rev: rev, json: typeof rs.json === 'string' ? JSON.parse(rs.json) : rs.json };
}
// Publishes json as the next revision after curRev (bc-1 → bc-2) and points Config at it.
// Revisions are never changed in place.
function EE_publishRuleset_(env, curRev, json, actor) {
  var prefix = String(curRev).replace(/-\d+$/, ''), max = 0;
  env.store.rows('Rulesets').forEach(function (x) {
    var m = String(x.rule_rev).match(/^(.*)-(\d+)$/);
    if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
  });
  var rev = prefix + '-' + (max + 1);
  json.rule_rev = rev;
  env.store.upsert('Rulesets', { rule_rev: rev, json: json, published_at: new Date(env.now()).toISOString(), published_by: actor });
  env.store.upsert('Config', { key: 'rule_rev', value: rev });
  return rev;
}

// ── Email Setup edits (PLAN.md → Scheduling: per-enrollment rule_rev, publish scope) ──
// p = { edits: [{ step_id, offset?, anchor?, status?: 'active'|'off', stops?: {reply, click, form} }], scope: 'all'|'new' }
// The current ruleset is never changed: the edits become a new revision (bc-2, bc-3, …)
// and Config rule_rev points at it. Runs pick it up at their next snapshot.
var EE_STOP_SIGNALS = ['reply', 'click', 'form'];
function EE_applyRuleEdits_(ruleset, edits) {
  var rs = JSON.parse(JSON.stringify(ruleset)), byId = {};
  rs.steps.forEach(function (s) { byId[s.step_id] = s; });
  var startupSeq = {};
  rs.steps.forEach(function (s) { if (s.anchor === 'startup') startupSeq[s.sequence_id] = true; });
  for (var i = 0; i < edits.length; i++) {
    var e = edits[i] || {}, st = byId[String(e.step_id || '')];
    if (!st) return { error: 'unknown email ' + e.step_id };
    if (st.repeat_every && (e.anchor !== undefined || e.offset !== undefined)) return { error: st.name + ' repeats weekly; its timing can’t be changed here' };
    if (e.anchor !== undefined && e.anchor !== st.anchor) {
      // Only between "when they join" and "around the startup", and only where there is a startup date.
      var ok = { enrollment: 1, startup: 1 };
      if (!ok[e.anchor] || !ok[st.anchor] || !startupSeq[st.sequence_id]) return { error: st.name + ': that timing isn’t available' };
      // A deadline counted from the old anchor stays tied to the startup.
      if (st.hard_deadline && st.hard_deadline.from === 'anchor' && st.anchor === 'startup') st.hard_deadline = { from: 'startup', offset: st.hard_deadline.offset };
      if (st.hard_deadline && st.hard_deadline.from === 'startup' && e.anchor === 'startup') st.hard_deadline = { from: 'anchor', offset: st.hard_deadline.offset };
      st.anchor = e.anchor;
    }
    if (e.offset !== undefined) {
      var n = Number(e.offset);
      if (!isFinite(n) || Math.floor(n) !== n) return { error: st.name + ': days must be a whole number' };
      var lim = st.anchor === 'previous' ? [1, 60] : st.anchor === 'enrollment' ? [0, 60] : [-30, 60];
      if (n < lim[0] || n > lim[1]) return { error: st.name + ': days must be between ' + lim[0] + ' and ' + lim[1] };
      st.offset = n;
    }
    if (st.hard_deadline && st.anchor === 'startup' && st.hard_deadline.from === 'anchor' && st.offset > st.hard_deadline.offset) {
      return { error: st.name + ' must send at least ' + Math.abs(st.hard_deadline.offset) + ' day(s) before the startup' };
    }
    if (e.status !== undefined) {
      if (e.status !== 'active' && e.status !== 'off') return { error: 'status must be on or off' };
      st.status = e.status;
    }
    if (e.stops !== undefined) {
      if (st.category !== 'marketing') return { error: st.name + ' is a service email; nothing stops it' };
      var prev = {}, scope = st.sequence_id === 'B' ? 'enrollment' : 'marketing_branch';
      (st.stop_rules || []).forEach(function (r) { prev[r.signal] = r; scope = r.stops || scope; });
      st.stop_rules = EE_STOP_SIGNALS.filter(function (sig) { return !!e.stops[sig]; }).map(function (sig) {
        return prev[sig] || (sig === 'click' ? { signal: 'click', min_confidence: 'high', stops: scope } : { signal: sig, stops: scope });
      });
    }
  }
  return { ruleset: rs };
}
function EE_publishRules_(env, core, p, actor) {
  var edits = Array.isArray(p.edits) ? p.edits : [];
  if (!edits.length || edits.length > 20) return { ok: false, error: 'edits required' };
  if (p.scope !== 'all' && p.scope !== 'new') return { ok: false, error: 'scope must be all or new' };
  var cfgRow = env.store.get('Config', 'rule_rev'), curRev = cfgRow && cfgRow.value;
  var cur = curRev && env.store.get('Rulesets', curRev);
  if (!cur) return { ok: false, error: 'current rules not found' };
  if (p.base_rev && p.base_rev !== curRev) return { ok: false, conflict: true, error: 'Someone changed these settings a moment ago. Reload and try again.' };
  var curJson = typeof cur.json === 'string' ? JSON.parse(cur.json) : cur.json;
  var r = EE_applyRuleEdits_(curJson, edits);
  if (r.error) return { ok: false, error: r.error };
  if (JSON.stringify(r.ruleset.steps) === JSON.stringify(curJson.steps)) return { ok: true, rule_rev: curRev, unchanged: true };
  var rev = EE_publishRuleset_(env, curRev, r.ruleset, actor);
  var moved = 0;
  if (p.scope === 'all') {
    var seqs = {};
    edits.forEach(function (e) { r.ruleset.steps.forEach(function (s) { if (s.step_id === e.step_id) seqs[s.sequence_id] = true; }); });
    env.store.rows('Enrollments').forEach(function (en) {
      if (!seqs[en.sequence_id] || en.rule_rev === rev || !/^(active|waiting_anchor|paused)$/.test(en.status)) return;
      core.commitEntity('enrollment', { enrollment_id: en.enrollment_id, rule_rev: rev }, 'enrollment:' + en.enrollment_id + ':rules:' + rev);
      moved++;
    });
  }
  return { ok: true, rule_rev: rev, previous: curRev, moved: moved };
}
