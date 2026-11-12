// ══════════════════════════════════════════════════════════════════════════════
// SEND TIMES AND THE DAY'S RUNS (PLAN.md → Scheduling semantics → Send times,
// Runs at send times; failure rows 58–61).
//
// Each campaign has a default send time (Config send_time_<bucket>, 09:00 when
// unset) and a batch can set its own; the enrollments it starts keep that time.
// Just after midnight the scheduler works out which times the engine must run
// today and installs one one-off trigger per time (at most 12). The plan is
// written to Config run_plan so the page can show today's runs.
//
//   EE_sendTimes_(cfg)            { bucket: 'HH:MM' } campaign defaults
//   EE_validSendTime_(t)          'HH:MM' on a 15-minute step between 06:00 and 20:00, or ''
//   EE_runTimesToday_(env, now)   { times, dropped } still ahead today
//   EE_planRuns_(env, deps)       install today's runs; deps.replaceTimedRuns([{time, at}])
//   EE_slotFor_(plan, nowTime)    the gate time and planned slot of a scheduled run
// ══════════════════════════════════════════════════════════════════════════════

var EE_MAX_RUNS_PER_DAY = 12;
var EE_EARLY_FIRE_MIN = 20;
var EE_SEND_BUCKETS = ['B', 'C'];

function EE_minutes_(t) { var p = String(t).split(':'); return Number(p[0]) * 60 + Number(p[1]); }
function EE_validSendTime_(t) {
  var n = MCPS_LIFECYCLE.normTime(t);
  if (!n) return '';
  var m = EE_minutes_(n);
  return m % 15 === 0 && m >= 6 * 60 && m <= 20 * 60 ? n : '';
}
function EE_sendTimes_(cfg) {
  var out = {};
  EE_SEND_BUCKETS.forEach(function (b) { out[b] = MCPS_LIFECYCLE.normTime(cfg['send_time_' + b]) || MCPS_LIFECYCLE.DEFAULT_SEND_TIME; });
  return out;
}

// A local date + 'HH:MM' in the business timezone → epoch ms (DST-safe).
function EE_localToMs_(date, time) {
  var d = String(date).split('-').map(Number), t = String(time).split(':').map(Number);
  var want = Date.UTC(d[0], d[1] - 1, d[2], t[0], t[1]);
  var ms = want;
  for (var i = 0; i < 2; i++) {
    var shown = MCPS_LIFECYCLE.localDate(new Date(ms), EE_TZ).split('-').map(Number);
    var clock = MCPS_LIFECYCLE.localTime(new Date(ms), EE_TZ).split(':').map(Number);
    ms += want - Date.UTC(shown[0], shown[1] - 1, shown[2], clock[0], clock[1]);
  }
  return ms;
}

// Times the engine must run today that are still ahead of nowTime: each campaign's
// default, the times of enrollments still going, and batches starting today.
function EE_runTimesToday_(env, nowTime) {
  var cfg = EE_config_(env.store), today = EE_today_(env), set = {};
  var defaults = EE_sendTimes_(cfg);
  Object.keys(defaults).forEach(function (b) { set[defaults[b]] = true; });
  env.store.rows('Enrollments').forEach(function (e) {
    var t = MCPS_LIFECYCLE.normTime(e.send_time);
    if (t && (e.status === 'active' || e.status === 'waiting_anchor')) set[t] = true;
  });
  env.store.rows('Batches').forEach(function (b) {
    var t = MCPS_LIFECYCLE.normTime(b.send_time);
    if (t && b.status === 'planned' && String(b.start_on) <= today) set[t] = true;
  });
  var ahead = Object.keys(set).filter(function (t) { return t > nowTime; }).sort();
  return { times: ahead.slice(0, EE_MAX_RUNS_PER_DAY), dropped: ahead.slice(EE_MAX_RUNS_PER_DAY) };
}

// deps.replaceTimedRuns(list): remove today's pending one-off run triggers and
// install one per { time, at } (Apps Script: ScriptApp; tests: a fake).
function EE_planRuns_(env, deps) {
  var today = EE_today_(env), nowTime = MCPS_LIFECYCLE.localTime(new Date(env.now()), EE_TZ);
  var r = EE_runTimesToday_(env, nowTime);
  var list = r.times.map(function (t) { return { time: t, at: EE_localToMs_(today, t) }; });
  if (deps && deps.replaceTimedRuns) deps.replaceTimedRuns(list);
  env.store.upsert('Config', { key: 'run_plan', value: JSON.stringify({ date: today, times: r.times, dropped: r.dropped,
    made_at: new Date(env.now()).toISOString() }) });
  if (r.dropped.length) { try { env.alert('too_many_send_times', r.dropped.join(', ') + ' wait for the next run'); } catch (e) { /* best effort */ } }
  return { date: today, times: r.times, dropped: r.dropped };
}

// A scheduled run's trigger can fire a little early: then it gates at its slot,
// so the slot's sends still go out. Otherwise it gates at the real time.
function EE_slotFor_(plan, nowTime) {
  var times = (plan && plan.times) || [], now = EE_minutes_(nowTime), ahead = null, behind = '';
  times.forEach(function (t) {
    var m = EE_minutes_(t);
    if (m > now && m - now <= EE_EARLY_FIRE_MIN && ahead === null) ahead = t;
    if (m <= now) behind = t;
  });
  return ahead ? { gate: ahead, planned_for: ahead } : { gate: nowTime, planned_for: behind };
}
// Sheet values that look like JSON come back already parsed (Env.js → EE_decode_); the tests' fake
// store keeps strings. Accept both.
function EE_jsonOf_(v) { if (v == null || v === '') return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (e) { return null; } }
function EE_runPlan_(cfg) { return EE_jsonOf_(cfg.run_plan); }

// ── Apps Script triggers ──────────────────────────────────────────────────────
function EE_triggerDeps_() {
  return { replaceTimedRuns: function (list) {
    ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'EE_timedRun'; })
      .forEach(function (t) { ScriptApp.deleteTrigger(t); });
    list.forEach(function (x) { ScriptApp.newTrigger('EE_timedRun').timeBased().at(new Date(x.at)).create(); });
  } };
}
function EE_scheduleTrigger() {
  // The nightly backup rides on this trigger (Backup.js); it never blocks planning the day.
  try { EE_backup_(); } catch (e) { try { EE_env().alert('backup_failed', String(e && e.message || e).slice(0, 300)); } catch (e2) { /* best effort */ } }
  return EE_planRuns_(EE_env(), EE_triggerDeps_());
}
function EE_timedRun() { return EE_run_('scheduled'); }

// ── Trigger-precision spike (PLAN.md → CP7: measure one-off .at() triggers before
// installing the scheduler; failure row 58 assumes they fire within ~20 min of the slot).
// The portal's "Test trigger timing" (admin action trigger_test) plans 4 one-off triggers
// a few minutes apart; each records how early or late it fired, then deletes itself.
// Nothing is sent. Results: Config trigger_test (JSON), shown on the Activity tab.
var EE_TRIGGER_TEST_OFFSETS_MIN = [2, 4, 6, 8];
function EE_triggerTestEndMs_(t) { return Math.max.apply(null, (t.slots || []).map(function (s) { return Date.parse(s.planned) || 0; }).concat([Date.parse(t.started_at) || 0])); }
function EE_triggerTestPure_(env, action, deps) {
  var raw = (env.store.get('Config', 'trigger_test') || {}).value, cur = null;
  cur = EE_jsonOf_(raw);
  if (action === 'result') return { ok: true, test: cur };
  // Still running only until 10 min after its last timer; after that a timer that never reported won't (e.g. it fired under older code).
  if (cur && cur.status === 'running' && env.now() < EE_triggerTestEndMs_(cur) + 10 * 60000) return { ok: false, error: 'a timing test is already running' };
  var now = env.now(), slots = EE_TRIGGER_TEST_OFFSETS_MIN.map(function (m) { return now + m * 60000; });
  var uids = deps.create(slots);
  var test = { status: 'running', started_at: new Date(now).toISOString(), slots: slots.map(function (at, i) { return { uid: uids[i], planned: new Date(at).toISOString(), fired: '', delta_s: null }; }) };
  env.store.upsert('Config', { key: 'trigger_test', value: JSON.stringify(test) });
  return { ok: true, test: test };
}
// Records one firing (by trigger uid). Runs inside the trigger's own execution.
function EE_triggerTestFired_(env, uid, firedMs) {
  return env.withLock(function () {
    var t = EE_jsonOf_((env.store.get('Config', 'trigger_test') || {}).value);
    if (!t) return null;
    t.slots.forEach(function (s) { if (s.uid === uid && !s.fired) { s.fired = new Date(firedMs).toISOString(); s.delta_s = Math.round((firedMs - Date.parse(s.planned)) / 1000); } });
    if (t.slots.every(function (s) { return s.fired; })) {
      var d = t.slots.map(function (s) { return s.delta_s; });
      t.status = 'done'; t.finished_at = new Date(firedMs).toISOString();
      t.summary = { earliest_s: Math.min.apply(null, d), latest_s: Math.max.apply(null, d), within_20_min: d.every(function (x) { return Math.abs(x) <= 1200; }) };
    }
    env.store.upsert('Config', { key: 'trigger_test', value: JSON.stringify(t) });
    return t;
  });
}
function EE_triggerTestDeps_() {
  return { create: function (slots) {
    return slots.map(function (at) { return ScriptApp.newTrigger('EE_triggerTestFire').timeBased().at(new Date(at)).create().getUniqueId(); });
  } };
}
function EE_triggerTestFire(e) {
  var firedMs = Date.now(), uid = e && e.triggerUid;
  ScriptApp.getProjectTriggers().filter(function (t) { return t.getUniqueId() === uid; }).forEach(function (t) { ScriptApp.deleteTrigger(t); });
  var t = EE_triggerTestFired_(EE_env(), uid, firedMs);
  if (t && t.status === 'done') {
    try { EE_env().alert('trigger_test_done', 'Trigger timing: earliest ' + t.summary.earliest_s + ' s, latest ' + t.summary.latest_s + ' s from the planned minute (' +
      (t.summary.within_20_min ? 'all within 20 min' : 'NOT all within 20 min') + ').'); } catch (err) { /* the result is in Config */ }
  }
}
