// ══════════════════════════════════════════════════════════════════════════════
// SINGLE EMAILS (PLAN.md → Plan changes 2026-11-10 "Single email" sequence type).
// One email, one day, to a list picked when it's scheduled. Everything else is
// the same engine: approval, suppression and unsubscribes, one lifecycle email a
// day per person, the Comms same-day hold, tracking and the never-twice guarantee.
//
//   create_single   { name, date, send_time, contact_ids[] }
//                   → a new ruleset revision with sequence S<6 hex> (kind 'single')
//                     and its one step s_<6 hex> (anchor 'date'), and one enrollment
//                     per person (en_<contact>_<seq>_1, so a retry can't add anyone twice)
//   update_single   { sequence_id, name?, date?, send_time? }  before anything is sent
//   cancel_single   { sequence_id }  the step is turned off and everyone still waiting is stopped
//
// Its window is stretched by the audience size, so the daily cap (Tony's account)
// can spread a large list over several days instead of expiring the rest.
// ══════════════════════════════════════════════════════════════════════════════

var EE_SINGLE_MAX = 2000;

function EE_singleWindow_(env, n) {
  var cap = Number(EE_config_(env.store).daily_cap || 0) || 80;
  return Math.max(3, Math.min(21, Math.ceil(n / cap) + 2));
}
function EE_singleFind_(rs, seqId) {
  var seq = (rs.json.sequences || []).filter(function (s) { return s.sequence_id === seqId && s.kind === 'single'; })[0];
  var step = seq && rs.json.steps.filter(function (s) { return s.sequence_id === seqId; })[0];
  return seq && step ? { seq: seq, step: step } : null;
}
function EE_singleSent_(env, stepId) {
  return env.store.rows('Deliveries').filter(function (d) { return d.step_id === stepId && d.state !== 'cancelled' && d.state !== 'abandoned'; }).length;
}

function EE_singleAction_(env, core, action, p, actor) {
  var rs = EE_currentRuleset_(env);
  if (!rs) return { ok: false, error: 'current rules not found' };
  var today = EE_today_(env), cfg = EE_config_(env.store);
  var mode = cfg.engine_mode === 'production' ? 'production' : 'test';
  var name = p.name !== undefined ? String(p.name || '').replace(/\s+/g, ' ').trim().slice(0, 80) : undefined;
  if (name !== undefined && !name) return { ok: false, error: 'give it a name' };
  if (p.date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.date)) || p.date < today)) return { ok: false, error: 'pick today or a later day' };
  var time = p.send_time !== undefined ? EE_validSendTime_(p.send_time) : undefined;
  if (p.send_time !== undefined && !time) return { ok: false, error: 'a send time between 6:00 AM and 8:00 PM on a quarter hour' };

  if (action === 'create_single') {
    if (!name || !p.date || !time) return { ok: false, error: 'name, date and send time are required' };
    var ids = Array.isArray(p.contact_ids) ? p.contact_ids.map(String) : [];
    if (!ids.length) return { ok: false, error: 'pick at least one person' };
    if (ids.length > EE_SINGLE_MAX) return { ok: false, error: 'at most ' + EE_SINGLE_MAX + ' people per single email' };
    var people = [], skipped = [], seen = {};
    ids.forEach(function (id) {
      if (seen[id]) return; seen[id] = true;
      var c = env.store.get('Contacts', id);
      var isTest = String((c && c.is_test) || '').toUpperCase() === 'Y';
      if (!c) skipped.push({ contact_id: id, reason: 'not_found' });
      else if (c.review_status !== 'confirmed') skipped.push({ contact_id: id, reason: 'not_confirmed' });
      else if (mode === 'test' ? !isTest : isTest) skipped.push({ contact_id: id, reason: mode === 'test' ? 'test_mode_real_contact' : 'test_contact' });
      else people.push(c);
    });
    if (!people.length) return { ok: false, error: mode === 'test' ? 'nobody to send to: in test mode only test contacts get emails' : 'nobody to send to', skipped: skipped };
    var hex = env.uuid().replace(/-/g, '').slice(0, 6).toUpperCase();
    var seqId = 'S' + hex, stepId = 's_' + hex.toLowerCase();
    var json = JSON.parse(JSON.stringify(rs.json));
    json.sequences = (json.sequences || []).concat([{ sequence_id: seqId, kind: 'single', name: name, reentry: 'never', created_by: actor, created_at: new Date(env.now()).toISOString() }]);
    json.steps = json.steps.concat([{ step_id: stepId, sequence_id: seqId, order: 1, name: name, category: 'marketing', status: 'active',
      anchor: 'date', date: p.date, offset: 0, unit: 'calendar', window_days: EE_singleWindow_(env, people.length), max_hold_days: 2,
      // A single email has nothing after it to stop; unsubscribes and bounces still stop everything.
      stop_rules: [] }]);
    var rev = EE_publishRuleset_(env, rs.rev, json, actor);
    people.forEach(function (c) {
      var enId = 'en_' + c.contact_id + '_' + seqId + '_1';
      core.commitEntity('enrollment', { enrollment_id: enId, contact_id: c.contact_id, sequence_id: seqId, rule_rev: rev, mode: mode, status: 'active',
        enrolled_on: today, send_time: time, anchor_snapshot: {}, stopped_branches: [], stopped_steps: [], flags: [] }, 'enrollment:' + enId + ':create');
    });
    return { ok: true, sequence_id: seqId, step_id: stepId, rule_rev: rev, count: people.length, skipped: skipped,
      window_days: EE_singleWindow_(env, people.length) };
  }

  var found = EE_singleFind_(rs, String(p.sequence_id || ''));
  if (!found) return { ok: false, error: 'single email not found' };
  var running = env.store.rows('Enrollments').filter(function (e) { return e.sequence_id === found.seq.sequence_id && /^(active|paused)$/.test(e.status); });

  if (action === 'cancel_single') {
    if (found.step.status === 'off') return { ok: true, already: true };
    var cj = JSON.parse(JSON.stringify(rs.json));
    cj.steps.forEach(function (s) { if (s.step_id === found.step.step_id) s.status = 'off'; });
    var crev = EE_publishRuleset_(env, rs.rev, cj, actor);
    running.forEach(function (e) {
      core.commitEntity('enrollment', { enrollment_id: e.enrollment_id, rule_rev: crev, status: 'stopped', stop_reason: 'cancelled', stopped_on: today },
        'enrollment:' + e.enrollment_id + ':cancelled');
    });
    return { ok: true, stopped: running.length, sent: EE_singleSent_(env, found.step.step_id) };
  }

  // update_single
  if (found.step.status === 'off') return { ok: false, error: 'this single email was cancelled' };
  if (p.date !== undefined && p.date !== found.step.date && EE_singleSent_(env, found.step.step_id)) {
    return { ok: false, error: 'it has already started sending; the day can’t change now' };
  }
  var out = { ok: true };
  if ((name !== undefined && name !== found.seq.name) || (p.date !== undefined && p.date !== found.step.date)) {
    var uj = JSON.parse(JSON.stringify(rs.json));
    uj.sequences.forEach(function (s) { if (s.sequence_id === found.seq.sequence_id && name !== undefined) s.name = name; });
    uj.steps.forEach(function (s) { if (s.step_id === found.step.step_id) { if (name !== undefined) s.name = name; if (p.date !== undefined) s.date = p.date; } });
    var urev = EE_publishRuleset_(env, rs.rev, uj, actor);
    running.forEach(function (e) {
      core.commitEntity('enrollment', { enrollment_id: e.enrollment_id, rule_rev: urev }, 'enrollment:' + e.enrollment_id + ':rules:' + urev);
    });
    out.rule_rev = urev;
  }
  if (time !== undefined) {
    running.forEach(function (e) {
      if (e.send_time === time) return;
      core.commitEntity('enrollment', { enrollment_id: e.enrollment_id, send_time: time }, 'enrollment:' + e.enrollment_id + ':time:' + time + ':' + env.now());
    });
    out.send_time = time;
  }
  return out;
}
