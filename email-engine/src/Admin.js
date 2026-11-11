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
//   maintenance        run one allow-listed setup task as Tony (eeSetup, eeSetupMarketingKit,
//                       eeDiagnostics), so nobody has to click Run in the Apps Script editor.
//                       Only works for tasks whose Google permissions Tony has already granted.
// ══════════════════════════════════════════════════════════════════════════════

var EE_MAINTENANCE_TASKS = { setup: 'eeSetup', setup_marketing_kit: 'eeSetupMarketingKit', diagnostics: 'eeDiagnostics' };
var EE_ADMIN_ACTIONS = { maintenance: 1, ping: 1, run_now: 1, set_enabled: 1, set_bucket_paused: 1, mark_sent: 1, abandon: 1, resend: 1 };

// deps: { scheduleRun() -> 'queued' | 'already_queued' }  (Apps Script: a trigger; tests: a fake)
function EE_adminRun_(env, core, req, deps) {
  var action = String(req.action || ''), p = req.params || {}, actor = String(req.actor || '').slice(0, 60);
  var out;
  // The full write path (auth, permissions, relay, engine) with no effect: the speed check (CP6c).
  if (action === 'ping') return { ok: true, at: new Date(env.now()).toISOString() };
  if (!EE_ADMIN_ACTIONS[action]) out = { ok: false, error: 'unknown action' };
  else if (!actor) out = { ok: false, error: 'no actor' };
  else if (action === 'run_now') out = { ok: true, status: deps.scheduleRun() };
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

// Apps Script entry for the relay.
function EE_admin_(req) {
  var x = EE_core_();
  return EE_adminRun_(x.env, x.core, req, { scheduleRun: EE_scheduleRunNow_,
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
