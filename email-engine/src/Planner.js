// ══════════════════════════════════════════════════════════════════════════════
// PLANNER: today's work, from a snapshot of the engine's sheets.
//
// Pure (no Apps Script services): Main.js reads the snapshot and applies the
// result through EngineCore (journaled), so this file is tested in Node with
// the real rules (tests/email-engine-planner.test.js).
//
// 1. Enroll newly confirmed contacts into their bucket's sequence, honouring
//    each sequence's re-entry policy (B: never twice; returning → Needs review).
// 2. Run MCPS_LIFECYCLE.decide() over every enrollment.
// 3. Return what changed: enrollment writes, hold counters, and the due
//    deliveries in send order. Steps without an approved revision never go out.
// ══════════════════════════════════════════════════════════════════════════════

// snap = { today, engineMode: 'test'|'production', ruleRev, rulesets: {rev: ruleset},
//          contacts, enrollments, deliveries, holds: [{key, held_days, last_held_on}],
//          inbox, suppressions: [{email_norm, scope, mode}], commsSentToday: [email],
//          paused: {all, buckets}, publishedRevision: {step_id: revision_id} }
function EE_planDay(snap) {
  'use strict';
  var L = (typeof MCPS_LIFECYCLE !== 'undefined') ? MCPS_LIFECYCLE : require('../../js/lib/lifecycle-rules.js');
  var ruleset = snap.rulesets[snap.ruleRev];
  if (!ruleset) throw new Error('planner: current rule revision ' + snap.ruleRev + ' not found');
  var mode = snap.engineMode === 'production' ? 'production' : 'test';
  var isTest = function (c) { return String(c.is_test || '').toUpperCase() === 'Y'; };
  var inMode = function (c) { return mode === 'test' ? isTest(c) : !isTest(c); };

  var enrollments = (snap.enrollments || []).slice();
  var enrollmentWrites = [], contactFlags = [];

  // 1. New enrollments
  (snap.contacts || []).forEach(function (c) {
    if (!inMode(c)) return;
    var seq = (ruleset.sequences || []).filter(function (s) { return s.bucket === c.bucket; })[0];
    if (!seq) return;
    var verdict = L.decideEnrollment(c, seq, enrollments, snap.today);
    if (verdict.action === 'needs_review') {
      if (c.review_status !== 'needs_review') contactFlags.push({ contact_id: c.contact_id, reason: verdict.reason });
      return;
    }
    if (verdict.action !== 'enroll') return;
    var n = enrollments.filter(function (e) { return e.contact_id === c.contact_id && e.sequence_id === seq.sequence_id; }).length + 1;
    var en = { enrollment_id: 'en_' + c.contact_id + '_' + seq.sequence_id + '_' + n, contact_id: c.contact_id,
      sequence_id: seq.sequence_id, rule_rev: snap.ruleRev, mode: mode, status: 'active', enrolled_on: snap.today,
      anchor_snapshot: { startup_date: c.startup_date || '' }, stopped_branches: [], stopped_steps: [], flags: [] };
    enrollments.push(en);
    enrollmentWrites.push({ op_id: 'enrollment:' + en.enrollment_id + ':create', data: en });
  });

  // 2. Decide
  var holds = {};
  (snap.holds || []).forEach(function (h) { holds[h.key] = Number(h.held_days || 0); });
  var signals = (snap.inbox || []).filter(function (r) { return r.type === 'signal' && r.enrollment_id; })
    .map(function (r) { return { enrollment_id: r.enrollment_id, step_id: r.step_id, signal: r.signal, confidence: r.confidence || 'high' }; });
  var r = L.decide({ today: snap.today, rulesets: snap.rulesets, contacts: snap.contacts,
    enrollments: enrollments.filter(function (e) { return e.mode === mode; }),
    deliveries: snap.deliveries, holds: holds, signals: signals, suppressions: snap.suppressions,
    commsSentToday: snap.commsSentToday, paused: snap.paused });

  // 3a. Enrollment changes (status, stops, branches, flags), journaled by the caller.
  var before = {};
  enrollments.forEach(function (e) { before[e.enrollment_id] = e; });
  r.enrollments.forEach(function (e) {
    var b = before[e.enrollment_id] || {};
    var sig = [e.status, e.stop_reason || '', (e.stopped_branches || []).join(','), (e.stopped_steps || []).join(','), (e.flags || []).join(',')].join('|');
    var was = [b.status, b.stop_reason || '', (b.stopped_branches || []).join(','), (b.stopped_steps || []).join(','), (b.flags || []).join(',')].join('|');
    if (sig === was) return;
    var data = { enrollment_id: e.enrollment_id, status: e.status, stop_reason: e.stop_reason || '',
      stopped_branches: e.stopped_branches || [], stopped_steps: e.stopped_steps || [], flags: e.flags || [] };
    if (e.status === 'stopped' && b.status !== 'stopped') data.stopped_on = snap.today;
    if (e.status === 'completed' && b.status !== 'completed') data.completed_on = snap.today;
    var existingCreate = enrollmentWrites.filter(function (w) { return w.data.enrollment_id === e.enrollment_id; })[0];
    if (existingCreate) { for (var k in data) existingCreate.data[k] = data[k]; return; }
    enrollmentWrites.push({ op_id: 'enrollment:' + e.enrollment_id + ':' + snap.today + ':' + sig, data: data });
  });

  // 3a'. Sub-bucket moves after a send (e.g. B1 → B2 once the Intro is out).
  // Only from the step's own audience stage, so a manual move (e.g. to B3) is never overwritten.
  var stepsById = {};
  (ruleset.steps || []).forEach(function (s) { stepsById[s.step_id] = s; });
  var contactsById0 = {};
  (snap.contacts || []).forEach(function (c) { contactsById0[c.contact_id] = c; });
  var contactWrites = [];
  r.deliveries.forEach(function (d) {
    var st = stepsById[d.step_id], c = contactsById0[d.contact_id];
    if (d.outcome !== 'sent' || !st || !st.on_send_sub_bucket || !c || c.sub_bucket === st.on_send_sub_bucket) return;
    var from = (st.audience_filter && st.audience_filter.sub_buckets) || [];
    if (from.length && from.indexOf(c.sub_bucket) === -1) return;
    if (contactWrites.some(function (w) { return w.data.contact_id === c.contact_id; })) return;
    contactWrites.push({ op_id: 'contact:' + c.contact_id + ':sub:' + st.on_send_sub_bucket + ':' + d.key,
      data: { contact_id: c.contact_id, sub_bucket: st.on_send_sub_bucket } });
  });

  // 3b. Hold counters: one per delivery per day.
  var holdWrites = [];
  r.deliveries.filter(function (d) { return d.outcome === 'held'; }).forEach(function (d) {
    var prev = (snap.holds || []).filter(function (h) { return h.key === d.key; })[0];
    if (prev && prev.last_held_on === snap.today) return;
    holdWrites.push({ key: d.key, held_days: (prev ? Number(prev.held_days || 0) : 0) + 1, last_held_on: snap.today, reason: d.reason });
  });

  // 3c. Due deliveries that have an approved revision, in send order.
  var contactsById = {};
  (snap.contacts || []).forEach(function (c) { contactsById[c.contact_id] = c; });
  var due = [], notApproved = [];
  r.due.forEach(function (d) {
    var rev = (snap.publishedRevision || {})[d.step_id];
    if (!rev) { notApproved.push(d.key); return; }
    var c = contactsById[d.contact_id] || {};
    due.push({ key: d.key, enrollment_id: d.enrollment_id, contact_id: d.contact_id, step_id: d.step_id,
      occurrence: d.occurrence, mode: d.mode, email_norm: c.email_norm, bucket: c.bucket, category: d.category,
      revision_id: rev });
  });

  var counts = {};
  r.deliveries.forEach(function (d) { counts[d.outcome] = (counts[d.outcome] || 0) + 1; });
  return { today: snap.today, due: due, enrollmentWrites: enrollmentWrites, contactWrites: contactWrites, holdWrites: holdWrites,
    contactFlags: contactFlags, notApproved: notApproved, outcomeCounts: counts, deliveries: r.deliveries };
}

// One engine day: plan under the run lease, journal the enrollment changes,
// record holds, then let EngineCore send the due deliveries.
// readSnapshot() is called inside the run, so the plan sees the latest state.
function EE_runDay(core, env, readSnapshot, opts) {
  'use strict';
  opts = opts || {};
  var lastPlan = null;
  var summary = core.run({ trigger: opts.trigger || 'daily', dailyCap: opts.dailyCap, budgetMs: opts.budgetMs,
    sentToday: opts.sentToday, plan: function (lease) {
      var p = EE_planDay(readSnapshot());
      p.enrollmentWrites.forEach(function (w) { core.commitEntity('enrollment', w.data, w.op_id, lease); });
      p.contactWrites.forEach(function (w) { core.commitEntity('contact', w.data, w.op_id, lease); });
      p.contactFlags.forEach(function (f) {
        core.commitEntity('contact', { contact_id: f.contact_id, review_status: 'needs_review', review_reason: f.reason },
          'contact:' + f.contact_id + ':needs_review:' + f.reason, lease);
      });
      if (p.holdWrites.length) env.withLock(function () { p.holdWrites.forEach(function (h) { env.store.upsert('Holds', h); }); });
      lastPlan = p;
      return p.due;
    } });
  if (lastPlan) summary.plan = { today: lastPlan.today, outcomes: lastPlan.outcomeCounts, not_approved: lastPlan.notApproved.length };
  return summary;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { EE_planDay: EE_planDay, EE_runDay: EE_runDay };
