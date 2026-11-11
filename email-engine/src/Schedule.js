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
function EE_runPlan_(cfg) { try { return JSON.parse(cfg.run_plan || 'null'); } catch (e) { return null; } }

// ── Apps Script triggers ──────────────────────────────────────────────────────
function EE_triggerDeps_() {
  return { replaceTimedRuns: function (list) {
    ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'EE_timedRun'; })
      .forEach(function (t) { ScriptApp.deleteTrigger(t); });
    list.forEach(function (x) { ScriptApp.newTrigger('EE_timedRun').timeBased().at(new Date(x.at)).create(); });
  } };
}
function EE_scheduleTrigger() { return EE_planRuns_(EE_env(), EE_triggerDeps_()); }
function EE_timedRun() { return EE_run_('scheduled'); }
