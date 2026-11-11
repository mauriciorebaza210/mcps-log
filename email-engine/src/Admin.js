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
//   move_batch         a planned batch to another start date (today or later)
//   send_override      one planned send: skip | move (inside its window) | next_run | clear (Overrides tab)
//   set_send_time      a campaign's default send time (Config send_time_<bucket>), then re-plan today's runs
//                       (create_batch also takes send_time: the batch's people keep it; Schedule.js)
//   save_import_mapping remember a spreadsheet's column mapping for the next file of the same shape
//   maintenance        run one allow-listed setup task as Tony (eeSetup, eeSetupMarketingKit,
//                       eeDiagnostics), so nobody has to click Run in the Apps Script editor.
//                       Only works for tasks whose Google permissions Tony has already granted.
// ══════════════════════════════════════════════════════════════════════════════

var EE_MAINTENANCE_TASKS = { setup: 'eeSetup', setup_marketing_kit: 'eeSetupMarketingKit', diagnostics: 'eeDiagnostics' };
var EE_ADMIN_ACTIONS = { move_batch: 1, send_override: 1, set_send_time: 1, create_batch: 1, cancel_batch: 1, import_contacts: 1, save_import_mapping: 1, maintenance: 1, ping: 1, run_now: 1, set_enabled: 1, set_bucket_paused: 1, mark_sent: 1, abandon: 1, resend: 1 };

// deps: { scheduleRun() -> 'queued' | 'already_queued', planRuns() }  (Apps Script: triggers; tests: fakes)
function EE_adminRun_(env, core, req, deps) {
  var action = String(req.action || ''), p = req.params || {}, actor = String(req.actor || '').slice(0, 60);
  var out;
  // The full write path (auth, permissions, relay, engine) with no effect: the speed check (CP6c).
  if (action === 'ping') return { ok: true, at: new Date(env.now()).toISOString() };
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
    if (!/^[A-F]$/.test(b) || typeof p.paused !== 'boolean') out = { ok: false, error: 'bucket A–F and paused true/false required' };
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
    ['first_name', 'last_name', 'phone', 'address', 'city', 'state', 'zip', 'area', 'pool_build_year', 'notes', 'tags', 'source']
      .forEach(function (k) { rec[k] = String(c[k] == null ? '' : c[k]); });
    if (!rec.source) rec.source = String(p.source || '').slice(0, 80);       // the import's source, when rows don't carry one
    rec.contact_id = id; rec.email_norm = email; rec.bucket = group; rec.sub_bucket = group === 'B' ? 'B1' : '';
    rec.review_status = 'needs_review'; rec.review_reason = 'imported'; rec.is_test = 'N';
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
  return EE_adminRun_(x.env, x.core, req, { scheduleRun: EE_scheduleRunNow_, planRuns: function () { return EE_planRuns_(x.env, EE_triggerDeps_()); },
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
