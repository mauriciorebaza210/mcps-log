// ══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE RULES: the one function that decides who gets which email, when.
//
// Loads three ways, deliberately, so there is exactly ONE implementation:
//   browser       <script src="js/lib/lifecycle-rules.js"> -> globalThis.MCPS_LIFECYCLE
//   node / vercel require / static import                  -> module.exports
//   apps script   copied into email-engine/ by the deploy script (hash-checked)
//                 -> globalThis.MCPS_LIFECYCLE
//
// The wizard's audience panel, the Emails overview counts, the Activity queue and
// the engine's send loop all call decide(). That is what keeps "what the page
// says will happen" and "what the engine does" from ever disagreeing.
//
// Pure: no I/O, no clocks. `today` (a local YYYY-MM-DD date) and every record are
// arguments. Contract: email-engine/docs/PLAN.md → Stop model, Scheduling
// semantics, Email matrix. Worked examples there are the tests in
// tests/email-engine-rules.test.js.
//
// Not in this release (deferred until B/C are live): business-day timing and the
// `event` / `monthly` anchors. Steps that use them are reported as `excluded`
// with reason `unsupported_in_this_release`, never guessed.
// ══════════════════════════════════════════════════════════════════════════════

(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MCPS_LIFECYCLE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CONFIDENCE = { low: 1, medium: 2, high: 3 };
  var SIGNAL_REASON = { reply: 'replied', click: 'clicked', form: 'form_submitted' };
  // Deliveries already handed to the send path. They are never re-planned:
  // see PLAN.md → State machines (nothing in `sending` returns to eligibility).
  var IN_FLIGHT = { claimed: 1, drafted: 1, sending: 1, reconcile: 1, unknown: 1 };
  // Outcomes that still count as "this enrollment has work left".
  var OPEN = { due: 1, held: 1, upcoming: 1, paused: 1, in_flight: 1, waiting_anchor: 1, failed: 1 };
  // Attempt ended without a send (lease recovery, or the pre-send gate said no):
  // the step is simply planned again. `abandoned` (an operator chose "Don't
  // send") and `failed` (needs a person) are never re-planned automatically.
  var REOPENED = { released: 1, cancelled: 1 };

  // ── Dates: local calendar dates as YYYY-MM-DD strings ───────────────────────
  // Days are counted on UTC midnights of the local date, so DST never moves one.
  function toMs(d) { var p = String(d).slice(0, 10).split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function fromMs(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function addDays(d, n) { return fromMs(toMs(d) + n * 86400000); }
  function daysBetween(a, b) { return Math.round((toMs(b) - toMs(a)) / 86400000); }
  function earlier(a, b) { return !a ? b : !b ? a : (a < b ? a : b); }
  // The engine's "today": the calendar date in the business timezone.
  function localDate(now, tz) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Chicago',
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }

  // A sent_at timestamp is UTC; its calendar day is the local one. A plain
  // YYYY-MM-DD value is already a local date.
  function localDay(value, tz) {
    var v = String(value || '');
    if (!v) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    var ms = Date.parse(v);
    return isNaN(ms) ? v.slice(0, 10) : localDate(new Date(ms), tz);
  }
  // A local clock time as 'HH:MM' (24 h), or '' when it isn't one.
  function normTime(v) {
    var m = String(v == null ? '' : v).trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m || +m[1] > 23 || +m[2] > 59) return '';
    return (m[1].length === 1 ? '0' : '') + m[1] + ':' + m[2];
  }
  // The local clock time ('HH:MM') of an instant in the business timezone.
  function localTime(now, tz) {
    var t = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    return normTime(t);
  }
  var DEFAULT_SEND_TIME = '09:00';
  function norm(email) { return String(email || '').trim().toLowerCase(); }
  function deliveryKey(enrollmentId, stepId, occurrence) { return enrollmentId + ':' + stepId + ':' + occurrence; }
  function indexBy(list, field) { var m = {}; (list || []).forEach(function (x) { m[x[field]] = x; }); return m; }
  function flag(state, name) { if (state.flags.indexOf(name) === -1) state.flags.push(name); }

  // ── Re-entry: should this contact get a new enrollment in this sequence? ──
  // `never` (B, per Mau) sends returning contacts to Needs review instead.
  function decideEnrollment(contact, sequence, priorEnrollments, today) {
    if (!contact || contact.review_status !== 'confirmed') return { action: 'none', reason: 'not_confirmed' };
    var mine = (priorEnrollments || []).filter(function (e) {
      return e.contact_id === contact.contact_id && e.sequence_id === sequence.sequence_id;
    });
    if (mine.some(function (e) { return e.status === 'active' || e.status === 'waiting_anchor' || e.status === 'paused'; })) {
      return { action: 'none', reason: 'already_enrolled' };
    }
    if (!mine.length) return { action: 'enroll', reason: 'first_enrollment' };
    var policy = String(sequence.reentry || 'never');
    if (policy === 'always') return { action: 'enroll', reason: 'reentry_always' };
    var m = policy.match(/^after_days:(\d+)$/);
    if (m) {
      var lastEnded = mine.map(function (e) { return e.stopped_on || e.completed_on || e.enrolled_on; }).sort().pop();
      return daysBetween(lastEnded, today) >= +m[1]
        ? { action: 'enroll', reason: 'reentry_after_days' }
        : { action: 'needs_review', reason: 'reentry_too_soon' };
    }
    return { action: 'needs_review', reason: 'already_completed_sequence' };
  }

  // ── Stops from signals (replies, clicks, form submits) ──
  // Applies each step's stop_rules. A signal below the rule's min_confidence, or
  // a type no rule names (e.g. auto_reply), stops nothing.
  function applySignals(state, stepsById, signals) {
    (signals || []).forEach(function (sig) {
      var step = stepsById[sig.step_id];
      if (!step) return;
      (step.stop_rules || []).forEach(function (rule) {
        if (rule.signal !== sig.signal) return;
        if ((CONFIDENCE[sig.confidence || 'high'] || 0) < (CONFIDENCE[rule.min_confidence || 'low'] || 0)) return;
        if (rule.stops === 'enrollment') {
          if (state.status !== 'stopped') { state.status = 'stopped'; state.stop_reason = SIGNAL_REASON[sig.signal] || sig.signal; }
        } else if (rule.stops === 'marketing_branch') {
          if (state.stopped_branches.indexOf('marketing') === -1) state.stopped_branches.push('marketing');
        } else if (Array.isArray(rule.stops)) {
          rule.stops.forEach(function (id) { if (state.stopped_steps.indexOf(id) === -1) state.stopped_steps.push(id); });
        }
      });
    });
  }

  function hardDeadline(step, base, nextDue) {
    var h = step.hard_deadline;
    if (!h || !base) return null;
    if (h.from === 'anchor') return addDays(base, h.offset);
    if (h.from === 'next_occurrence') return nextDue ? addDays(nextDue, h.offset) : null;
    return null;
  }

  // ── One enrollment: every step occurrence and what happens to it today ──
  function planEnrollment(en, ctx) {
    var contact = ctx.contacts[en.contact_id] || {};
    var ruleset = ctx.rulesets[en.rule_rev];
    var state = { enrollment_id: en.enrollment_id, contact_id: en.contact_id, mode: en.mode || 'production',
      status: en.status || 'active', stop_reason: en.stop_reason || '',
      stopped_branches: (en.stopped_branches || []).slice(), stopped_steps: (en.stopped_steps || []).slice(),
      // Flags are sticky: a "needs_review" raised once stays until a person clears it.
      flags: (en.flags || []).slice() };
    var out = [];
    if (!ruleset) { flag(state, 'unknown_rule_rev'); return { enrollment: state, deliveries: out }; }

    var steps = ruleset.steps.filter(function (s) { return s.sequence_id === en.sequence_id && s.status !== 'draft'; })
      .sort(function (a, b) { return a.order - b.order; });
    var stepsById = indexBy(steps, 'step_id');
    applySignals(state, stepsById, ctx.signalsByEnrollment[en.enrollment_id]);

    var scope = ctx.suppression(state.mode, contact.email_norm);
    if (scope === 'all' && state.status !== 'stopped') { state.status = 'stopped'; state.stop_reason = 'suppressed_all'; }

    var needsStartup = steps.some(function (s) { return s.anchor === 'startup'; });
    if (needsStartup && !contact.startup_date && state.status !== 'stopped') state.status = 'waiting_anchor';
    else if (state.status === 'waiting_anchor') state.status = 'active';

    var sub = contact.sub_bucket || '';
    // Send time: the enrollment's own (from its batch), else the campaign default.
    var sendTime = normTime(en.send_time) || normTime((ctx.sendTimes || {})[en.sequence_id]) || DEFAULT_SEND_TIME;
    var stepResult = {};        // step_id -> { sent, due, outcome } for occurrence 1
    var startupSent = false;

    steps.forEach(function (step) {
      var count = Math.max(1, step.repeat_count || 1);
      var base = null, projected = false, prereqExpired = false;
      if (step.anchor === 'enrollment') base = en.enrolled_on;
      else if (step.anchor === 'startup') base = contact.startup_date || null;
      else if (step.anchor === 'previous') {
        var req = stepResult[step.requires];
        if (!req) prereqExpired = false;
        else if (req.sent) base = req.sent;
        else if (req.outcome === 'expired' || req.outcome === 'expired_prerequisite') prereqExpired = true;
        else if (req.due) { base = req.due; projected = true; }
      }
      var unsupported = (step.unit && step.unit !== 'calendar') || ['enrollment', 'startup', 'previous'].indexOf(step.anchor) === -1;

      for (var k = 0; k < count; k++) {
        var occ = k + 1, key = deliveryKey(en.enrollment_id, step.step_id, occ);
        var rec = ctx.deliveries[key];
        if (rec && REOPENED[rec.state]) rec = null;
        var d = { key: key, enrollment_id: en.enrollment_id, contact_id: en.contact_id, mode: state.mode,
          step_id: step.step_id, occurrence: occ, order: step.order, category: step.category,
          due: null, send_time: sendTime, last_send_day: null, outcome: '', reason: '', held_days: ctx.holds[key] || 0 };
        if (base && !unsupported) {
          d.due = addDays(base, step.offset + k * (step.repeat_every || 0));
          var nextDue = k + 1 < count ? addDays(base, step.offset + (k + 1) * (step.repeat_every || 0)) : null;
          var deadline = hardDeadline(step, base, nextDue);
          var byWindow = addDays(d.due, (step.window_days || 0) + Math.min(d.held_days, step.max_hold_days || 0));
          d.last_send_day = earlier(byWindow, deadline);
          d.deadline_binding = !!deadline && deadline <= byWindow;
        }

        if (rec && rec.state === 'sent') {
          d.outcome = 'sent'; d.sent_on = localDay(rec.sent_at, ctx.tz);
          if (step.anchor === 'startup') startupSent = true;
        } else if (rec && IN_FLIGHT[rec.state]) {
          d.outcome = 'in_flight'; d.reason = rec.state;
        } else if (rec && rec.state === 'abandoned') {
          d.outcome = 'excluded'; d.reason = 'abandoned_by_operator';
        } else if (rec && rec.state === 'failed') {
          d.outcome = 'failed'; d.reason = rec.error || 'failed';
        } else if (unsupported) {
          d.outcome = 'excluded'; d.reason = 'unsupported_in_this_release';
        } else if (step.status === 'retired') {
          d.outcome = 'excluded'; d.reason = 'retired';
        } else if (state.status === 'stopped') {
          d.outcome = 'stopped'; d.reason = state.stop_reason;
        } else if (state.status === 'paused') {
          d.outcome = 'paused'; d.reason = 'enrollment_paused';
        } else if (state.stopped_steps.indexOf(step.step_id) !== -1) {
          d.outcome = 'stopped'; d.reason = 'step_stopped';
        } else if (step.category === 'marketing' && state.stopped_branches.indexOf('marketing') !== -1) {
          d.outcome = 'stopped'; d.reason = 'marketing_branch_stopped';
        } else if (step.category === 'marketing' && scope === 'marketing') {
          d.outcome = 'suppressed'; d.reason = 'marketing_opt_out';
        } else if (prereqExpired) {
          d.outcome = 'expired'; d.reason = 'prerequisite_expired';
        } else if (state.status === 'waiting_anchor' || (!base && step.anchor === 'startup')) {
          d.outcome = 'waiting_anchor'; d.reason = 'no_startup_date';
        } else if (!base) {
          d.outcome = 'upcoming'; d.reason = 'waiting_for_prerequisite';
        } else if (step.audience_filter && step.audience_filter.sub_buckets && step.audience_filter.sub_buckets.length &&
                   step.audience_filter.sub_buckets.indexOf(sub) === -1) {
          d.outcome = 'excluded'; d.reason = 'sub_bucket_' + (sub || 'none');
        } else if (ctx.today > d.last_send_day) {
          d.outcome = 'expired';
          d.reason = d.deadline_binding ? 'deadline_passed'
            : (d.held_days > 0 && d.held_days >= (step.max_hold_days || 0) ? 'hold_cap_reached' : 'window_passed');
        } else if (projected || ctx.today < d.due) {
          d.outcome = 'upcoming'; if (projected) d.reason = 'projected_from_prerequisite';
        } else if (ctx.time && sendTime > ctx.time) {
          // Its day has come but not its time: a later run today sends it.
          d.outcome = 'upcoming'; d.reason = 'later_today';
        } else if (ctx.paused.all || (ctx.paused.buckets || []).indexOf(contact.bucket) !== -1) {
          d.outcome = 'paused';
        } else if (contact.review_status !== 'confirmed') {
          d.outcome = 'excluded'; d.reason = 'needs_review';
        } else {
          d.outcome = 'due';
        }
        if (d.outcome === 'expired') flag(state, 'expired_steps');
        if (k === 0) stepResult[step.step_id] = { sent: d.sent_on || null, due: d.due, outcome: d.outcome };
        out.push(d);
      }
      // Later steps see the sub-bucket this step moves the contact into.
      var first = stepResult[step.step_id];
      if (step.on_send_sub_bucket && first && (first.sent || first.outcome === 'due' || first.outcome === 'upcoming')) sub = step.on_send_sub_bucket;
    });

    if (startupSent && en.anchor_snapshot && en.anchor_snapshot.startup_date &&
        contact.startup_date && en.anchor_snapshot.startup_date !== contact.startup_date) {
      flag(state, 'anchor_moved_after_send');
    }
    if (state.status === 'active') {
      var open = out.some(function (d) { return OPEN[d.outcome]; });
      if (!open) {
        var byPrereq = out.some(function (d) { return d.outcome === 'expired' && d.reason === 'prerequisite_expired'; });
        if (byPrereq) { state.status = 'stopped'; state.stop_reason = 'prerequisite_expired'; flag(state, 'needs_review'); }
        else state.status = 'completed';
      }
    }
    return { enrollment: state, deliveries: out };
  }

  // ── One email per contact per local day (per mode) ──
  // The winner: a delivery already held before, then the earliest original due
  // date, then the lower step order. Everything else due that day is held.
  function applyDailyLimit(deliveries, ctx) {
    var groups = {};
    deliveries.forEach(function (d) {
      if (d.outcome !== 'due') return;
      var g = d.mode + '|' + d.contact_id;
      (groups[g] = groups[g] || []).push(d);
    });
    Object.keys(groups).forEach(function (g) {
      var list = groups[g], first = list[0];
      var contact = ctx.contacts[first.contact_id] || {};
      var blocked = ctx.sentToday[g] ? 'already_emailed_today'
        : (first.mode === 'production' && ctx.commsToday[norm(contact.email_norm)] ? 'comms_same_day' : '');
      list.sort(function (a, b) {
        return (b.held_days > 0) - (a.held_days > 0) || (a.due < b.due ? -1 : a.due > b.due ? 1 : 0) || a.order - b.order;
      });
      list.forEach(function (d, i) {
        if (blocked) { d.outcome = 'held'; d.reason = blocked; }
        else if (i > 0) { d.outcome = 'held'; d.reason = 'one_per_day'; }
      });
    });
  }

  // ── decide(): the whole schedule for today ──
  // input: { today | now+tz, rulesets: {rev: {steps: [...]}}, contacts, enrollments,
  //          deliveries (claimed onward), holds: {key: days}, signals,
  //          suppressions: [{email_norm, scope: 'all'|'marketing', mode}],
  //          commsSentToday: [email_norm], paused: {all, buckets},
  //          time: 'HH:MM' local (optional; gates today's sends by send time),
  //          sendTimes: {sequence_id: 'HH:MM'} campaign defaults }
  // output: { today, deliveries: [...], enrollments: [...], due: [...in send order] }
  function decide(input) {
    var tz = input.tz || 'America/Chicago';
    var today = input.today || localDate(input.now || new Date(), tz);
    var supp = {};
    (input.suppressions || []).forEach(function (s) {
      var k = (s.mode || 'production') + '|' + norm(s.email_norm);
      if (supp[k] !== 'all') supp[k] = s.scope === 'all' ? 'all' : 'marketing';
    });
    var sentToday = {};
    (input.deliveries || []).forEach(function (r) {
      if (r.state === 'sent' && localDay(r.sent_at, tz) === today) sentToday[(r.mode || 'production') + '|' + r.contact_id] = true;
    });
    var commsToday = {}; (input.commsSentToday || []).forEach(function (e) { commsToday[norm(e)] = true; });
    var signalsByEnrollment = {};
    (input.signals || []).forEach(function (s) { (signalsByEnrollment[s.enrollment_id] = signalsByEnrollment[s.enrollment_id] || []).push(s); });
    var ctx = { today: today, tz: tz, rulesets: input.rulesets || {}, contacts: indexBy(input.contacts, 'contact_id'),
      deliveries: indexBy(input.deliveries, 'key'), holds: input.holds || {}, signalsByEnrollment: signalsByEnrollment,
      paused: input.paused || {}, sentToday: sentToday, commsToday: commsToday,
      time: normTime(input.time), sendTimes: input.sendTimes || {},
      suppression: function (mode, email) { return supp[(mode || 'production') + '|' + norm(email)] || ''; } };

    var deliveries = [], enrollments = [];
    (input.enrollments || []).forEach(function (en) {
      if (en.status === 'completed') return;
      var r = planEnrollment(en, ctx);
      enrollments.push(r.enrollment);
      deliveries.push.apply(deliveries, r.deliveries);
    });
    applyDailyLimit(deliveries, ctx);
    var due = deliveries.filter(function (d) { return d.outcome === 'due'; })
      .sort(function (a, b) { return (a.due < b.due ? -1 : a.due > b.due ? 1 : 0) || a.order - b.order; });
    return { today: today, deliveries: deliveries, enrollments: enrollments, due: due };
  }

  return {
    decide: decide,
    decideEnrollment: decideEnrollment,
    deliveryKey: deliveryKey,
    localDate: localDate,
    localTime: localTime,
    normTime: normTime,
    DEFAULT_SEND_TIME: DEFAULT_SEND_TIME,
    localDay: localDay,
    addDays: addDays,
    daysBetween: daysBetween
  };
});
