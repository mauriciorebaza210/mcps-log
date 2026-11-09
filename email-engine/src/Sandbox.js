// ══════════════════════════════════════════════════════════════════════════════
// SANDBOX SUITE (CP4f): the SB rows of PLAN.md → Failure acceptance matrix,
// run against REAL Gmail from Tony's account, in throwaway sandbox sheets.
//
//   eeSandboxSuite()     start a fresh suite (Tony clicks Run once)
//   eeSandboxStatus()    log where it is
//   EE_sbContinue        time-based trigger the suite schedules for itself
//
// Isolation: its own spreadsheet + Journal, its own Comms_Optouts tab, and the
// "SB_" prefix on every lease / pause / cache key (EE_env opts). Recipients are
// plus-addresses of Mau's (mauricio+sb<tag><n>@), unique per suite, so the Sent
// counts below can only come from this suite.
//
// Faults are injected by wrapping a real env (EE_SB_wrapEnv_): one-shot kills
// and errors around Gmail and the Deliveries writes, and hooks that run at the
// next lock entry, i.e. at a real boundary between the core's critical sections.
// The scenarios only use the harness `h`, so tests/email-engine-sandbox.test.js
// runs this same file against the fake env with time travel.
// ══════════════════════════════════════════════════════════════════════════════

var EE_SB_PREFIX = 'SB_';
var EE_SB_BUDGET_MS = 150000;                 // start no new step after this; Apps Script stops us at 6 min
var EE_SB_G = 3 * 60 * 1000;                  // past grace G (2 min)
var EE_SB_G2 = 16 * 60 * 1000;                // past grace G2 (15 min)

function EE_SB_kill_() { return { killed: true, message: 'simulated: execution killed' }; }

// spec (all one-shot): { target: delivery_id,
//   killAfterWrite: state      throw "killed" right after the target row is written in that state
//   onWrite: {state: fn}       run fn at the next lock entry after that write
//   killAfterCreateDraft       draft exists in Gmail, its id never recorded
//   send: 'throwBefore' | 'throwAfterAccept' | 'killAfterAccept'
//   beforeSend: fn, afterSend: fn }
function EE_SB_wrapEnv_(base, spec) {
  spec = spec || {};
  var pending = [];
  var env = {}, k;
  for (k in base) env[k] = base[k];
  env._base = base;
  env.withLock = function (fn) {
    while (pending.length) pending.shift()();        // hooks run between critical sections, never inside one
    return base.withLock(fn);
  };
  env.store = {
    rows: base.store.rows, get: base.store.get,
    upsert: function (table, row) {
      base.store.upsert(table, row);
      if (table !== 'Deliveries' || row.delivery_id !== spec.target) return;
      var hook = spec.onWrite && spec.onWrite[row.state];
      if (hook) { delete spec.onWrite[row.state]; pending.push(hook); }
      if (spec.killAfterWrite && spec.killAfterWrite === row.state) { spec.killAfterWrite = null; throw EE_SB_kill_(); }
    }
  };
  env.gmail = {};
  for (k in base.gmail) env.gmail[k] = base.gmail[k];
  env.gmail.createDraft = function (msg) {
    var id = base.gmail.createDraft(msg);
    if (spec.killAfterCreateDraft) { spec.killAfterCreateDraft = false; throw EE_SB_kill_(); }
    return id;
  };
  env.gmail.sendDraft = function (id) {
    var once = function (name) { var f = spec[name]; spec[name] = null; return f; };
    var before = once('beforeSend'); if (before) before();
    var mode = once('send');
    if (mode === 'throwBefore') throw new Error('simulated: Gmail timed out (nothing sent)');
    var res = base.gmail.sendDraft(id);
    var after = once('afterSend'); if (after) after();
    if (mode === 'killAfterAccept') throw EE_SB_kill_();
    if (mode === 'throwAfterAccept') throw new Error('simulated: Gmail timed out after accepting');
    return res;
  };
  return env;
}

// ── Scenario helpers ──
function EE_SB_contact_(h, core, n, mode) {
  var id = 'sb_' + h.data.tag + '_' + n, email = h.addr(n), en = 'en_' + id;
  core.commitEntity('contact', { contact_id: id, email_norm: email, first_name: 'Sandbox', last_name: String(n), bucket: 'B',
    sub_bucket: 'B1', review_status: 'confirmed', is_test: 'Y', source: 'sandbox_suite', created_at: new Date(h.now()).toISOString() },
    'contact:' + id + ':create');
  core.commitEntity('enrollment', { enrollment_id: en, contact_id: id, sequence_id: 'B', rule_rev: 'bc-1', mode: mode,
    status: 'active', enrolled_on: '', stopped_branches: [] }, 'enrollment:' + en + ':create');
  h.data.expect[email] = h.data.expect[email] || 0;
  return { key: en + ':b_intro:1', enrollment_id: en, contact_id: id, step_id: 'b_intro', occurrence: 1, mode: mode,
    email_norm: email, bucket: 'B', category: 'marketing', revision_id: h.revisionId('b_intro') };
}
function EE_SB_occ_(item, n) {
  var o = {}, k; for (k in item) o[k] = item[k];
  o.occurrence = n; o.key = item.enrollment_id + ':b_intro:' + n; return o;
}
function EE_SB_run_(core, items, trigger) {
  try { return core.run({ trigger: trigger || 'sandbox', plan: function () { return items || []; } }); }
  catch (e) { if (e && e.killed) return { killed: true }; throw e; }
}
function EE_SB_row_(env, key) { return env._base.store.get('Deliveries', key); }
function EE_SB_unsub_(h, env, email, mode) {
  return EE_createCore(EE_SB_wrapEnv_(env._base, {})).ingest({ event_id: 'sb_unsub_' + h.data.tag + '_' + (++h.data.n),
    type: 'unsubscribe', mode: mode, email_norm: email, scope: 'all' });
}
// "B takes over": A's lease is made to look expired, then a full second run goes.
function EE_SB_takeOver_(env) {
  var base = env._base, raw = base.props.get('EE_LEASE');
  if (raw) { var l = JSON.parse(raw); l.expires = 0; base.props.set('EE_LEASE', JSON.stringify(l)); }
  return EE_SB_run_(EE_createCore(EE_SB_wrapEnv_(base, {})), [], 'sandbox_B');
}

// ── Scenarios. c(cond, what) records an expectation; the returned text is the evidence. ──
var EE_SB_SCENARIOS = [
  { id: 'row1', title: 'Gmail accepts, process dies before "sent" is written',
    run: function (h, c) {
      var env = h.env(), it = EE_SB_contact_(h, h.core(env), 1, 'production');
      var w = h.env({ target: it.key, send: 'killAfterAccept' });
      c(EE_SB_run_(h.core(w), [it]).killed, 'the run was killed after Gmail accepted');
      var again = EE_SB_run_(h.core(h.env()), [it]);
      c(again.sent === 0, 'an immediate rerun sent nothing (sent=' + again.sent + ')');
      c(EE_SB_row_(env, it.key).state === 'sending', 'left in sending, not eligible (' + EE_SB_row_(env, it.key).state + ')');
      h.data.expect[it.email_norm] = 1; h.data.row1 = it.key;
      return 'killed after accept; rerun sent 0';
    },
    checks: [{ id: 'row1_after_G', after: EE_SB_G, run: function (h, c) {
      var env = h.env(); EE_SB_run_(h.core(env), []);
      var r = EE_SB_row_(env, h.data.row1);
      c(r.state === 'sent' && r.resolved_by === 'sent_search', 'reconcile found the token in Sent (' + r.state + ', ' + r.resolved_by + ')');
      return r.state + ' via ' + r.resolved_by;
    } }] },

  { id: 'row2', title: 'Dies after "drafted", before send()',
    run: function (h, c) {
      var env = h.env(), it = EE_SB_contact_(h, h.core(env), 2, 'production');
      c(EE_SB_run_(h.core(h.env({ target: it.key, killAfterWrite: 'drafted' })), [it]).killed, 'killed right after the drafted write');
      var again = EE_SB_run_(h.core(h.env()), [it]);
      var r = EE_SB_row_(env, it.key);
      c(again.adopted === 1 && again.sent === 1, 'the next run adopted the draft and sent it once (adopted=' + again.adopted + ', sent=' + again.sent + ')');
      c(r.state === 'sent' && r.attempt === 1 && Number(r.adopted_from_gen) > 0, 'same attempt, adopted (' + r.state + ', attempt ' + r.attempt + ')');
      h.data.expect[it.email_norm] = 1;
      return 'adopted from gen ' + r.adopted_from_gen + ', sent';
    } },

  { id: 'row3', title: 'Dies after createDraft, before draft_id is saved',
    run: function (h, c) {
      var env = h.env(), it = EE_SB_contact_(h, h.core(env), 3, 'production');
      c(EE_SB_run_(h.core(h.env({ target: it.key, killAfterCreateDraft: true })), [it]).killed, 'killed after createDraft');
      var first = EE_SB_row_(env, it.key);
      c((env.gmail.findDraftsByToken(first.token) || []).length === 1, 'an orphan draft exists, findable by token');
      var again = EE_SB_run_(h.core(h.env()), [it]);
      var r = EE_SB_row_(env, it.key);
      c(again.sent === 1 && r.state === 'sent' && r.attempt === 2 && r.token !== first.token, 'released, then sent once as attempt 2 (' + r.state + ', attempt ' + r.attempt + ')');
      c((env.gmail.findDraftsByToken(first.token) || []).length === 0, 'the orphan draft was deleted');
      h.data.expect[it.email_norm] = 1;
      return 'orphan removed; attempt 2 sent';
    } },

  { id: 'row4', title: 'send() throws, nothing sent (also row 41)',
    run: function (h, c) {
      var env = h.env(), it = EE_SB_contact_(h, h.core(env), 4, 'production');
      var s = EE_SB_run_(h.core(h.env({ target: it.key, send: 'throwBefore' })), [it]);
      c(s.reconcile === 1, 'went to reconcile (reconcile=' + s.reconcile + ')');
      var again = EE_SB_run_(h.core(h.env()), [it]);
      c(again.sent === 0, 'an immediate rerun sent nothing');
      h.data.expect[it.email_norm] = 0; h.data.row4 = it.key; h.data.row4item = it;
      return 'reconcile; rerun sent 0';
    },
    checks: [
      { id: 'row4_after_G', after: EE_SB_G, run: function (h, c) {
        var env = h.env(), s = EE_SB_run_(h.core(env), [h.data.row4item]);   // offered again: must not send
        var r = EE_SB_row_(env, h.data.row4);
        c(r.state === 'reconcile' && s.sent === 0, 'still reconcile between G and G2, never resent (' + r.state + ', sent ' + s.sent + ')');
        return r.state;
      } },
      { id: 'row4_after_G2', after: EE_SB_G2, run: function (h, c) {
        var env = h.env(), core = h.core(env); EE_SB_run_(core, []);
        var r = EE_SB_row_(env, h.data.row4);
        c(r.state === 'unknown', 'unknown after G2 with no copy in Sent (' + r.state + ')');
        var rs = core.resend(h.data.row4, 'sandbox');
        c(!rs.ok && rs.reason === 'quiescence', 'Resend refused before quiescence (' + rs.reason + ', unlocks ' + rs.unlock_at + ')');
        // Tidy up: an operator would abandon it; remove its draft so nothing is left in Drafts.
        core.abandon(h.data.row4, 'sandbox');
        if (r.draft_id) env.gmail.deleteDraft(r.draft_id);
        return 'unknown; Resend locked until ' + rs.unlock_at + '; abandoned';
      } }] },

  { id: 'row5', title: 'Delayed send: Gmail accepted, then the call errored',
    run: function (h, c) {
      var env = h.env(), it = EE_SB_contact_(h, h.core(env), 5, 'production');
      var s = EE_SB_run_(h.core(h.env({ target: it.key, send: 'throwAfterAccept' })), [it]);
      c(s.reconcile === 1, 'went to reconcile');
      c(EE_SB_run_(h.core(h.env()), [it]).sent === 0, 'an immediate rerun sent nothing');
      h.data.expect[it.email_norm] = 1; h.data.row5 = it.key;
      return 'reconcile; rerun sent 0';
    },
    checks: [{ id: 'row5_after_G', after: EE_SB_G, run: function (h, c) {
      var env = h.env(); EE_SB_run_(h.core(env), []);
      var r = EE_SB_row_(env, h.data.row5);
      c(r.state === 'sent' && r.resolved_by === 'sent_search', 'reconcile found it in Sent, no duplicate (' + r.state + ')');
      return r.state + ' via ' + r.resolved_by;
    } }] },

  { id: 'row9', title: 'Unsubscribe for a later recipient during a multi-contact run',
    run: function (h, c) {
      var env = h.env(), core = h.core(env);
      var a = EE_SB_contact_(h, core, 91, 'production'), b = EE_SB_contact_(h, core, 92, 'production'), d = EE_SB_contact_(h, core, 93, 'production');
      var hooks = {}; hooks.sent = function () { c(EE_SB_unsub_(h, env, b.email_norm, 'production').ok, 'unsubscribe recorded mid-run'); };
      var s = EE_SB_run_(h.core(h.env({ target: a.key, onWrite: hooks })), [a, b, d]);
      c(s.sent === 2 && s.skipped === 1, 'sent the 1st and 3rd, skipped the unsubscribed 2nd (sent=' + s.sent + ', skipped=' + s.skipped + ')');
      c(!EE_SB_row_(env, b.key), 'no delivery was even claimed for the 2nd');
      c(h.sandboxOptoutsHas(b.email_norm), 'the opt-out reached the (sandbox) Comms_Optouts');
      c(!h.realOptoutsHas(b.email_norm), 'the real Comms_Optouts is untouched');
      h.data.expect[a.email_norm] = 1; h.data.expect[b.email_norm] = 0; h.data.expect[d.email_norm] = 1;
      return 'sent ' + s.sent + ', skipped ' + s.skipped;
    } },

  { id: 'row35a', title: 'Stale worker before authorization',
    run: function (h, c) {
      var env = h.env(), it = EE_SB_contact_(h, h.core(env), 351, 'production'), b = null;
      var hooks = { drafted: function () { b = EE_SB_takeOver_(env); } };
      var a = EE_SB_run_(h.core(h.env({ target: it.key, onWrite: hooks })), [it]);
      c(b && b.sent === 1 && b.adopted === 1, 'worker B adopted the draft and sent it');
      c(a.sent === 0 && a.stopped_reason === 'lease_lost', 'worker A stopped at authorization (' + a.stopped_reason + ', sent ' + a.sent + ')');
      c(EE_SB_row_(env, it.key).state === 'sent', 'one sent delivery');
      h.data.expect[it.email_norm] = 1;
      return 'A: ' + a.stopped_reason + '; B sent it';
    } },

  { id: 'row35b', title: 'Stale worker after authorization, before Gmail',
    run: function (h, c) {
      var env = h.env(), it = EE_SB_contact_(h, h.core(env), 352, 'production'), b = null;
      var a = EE_SB_run_(h.core(h.env({ target: it.key, beforeSend: function () { b = EE_SB_takeOver_(env); } })), [it]);
      c(b && b.sent === 0, 'worker B found it in sending and did not send');
      var mid = EE_SB_row_(env, it.key);
      c(mid.state === 'sending', "A's send went through but its \"sent\" write was rejected (" + mid.state + ')');
      var cRun = EE_SB_run_(h.core(h.env()), [it]);
      var r = EE_SB_row_(env, it.key);
      c(cRun.sent === 0 && r.state === 'sent', 'the next run finished the bookkeeping without sending (' + r.state + ', ' + r.resolved_by + ')');
      h.data.expect[it.email_norm] = 1;
      return 'A sent once; recorded via ' + r.resolved_by;
    } },

  { id: 'row36', title: 'Unsubscribe recorded before authorization',
    run: function (h, c) {
      var env = h.env(), it = EE_SB_contact_(h, h.core(env), 36, 'production');
      var hooks = { drafted: function () { EE_SB_unsub_(h, env, it.email_norm, 'production'); } };
      var s = EE_SB_run_(h.core(h.env({ target: it.key, onWrite: hooks })), [it]);
      var r = EE_SB_row_(env, it.key);
      c(s.sent === 0 && r.state === 'cancelled' && r.error === 'suppressed', 'cancelled at authorization (' + r.state + ', ' + r.error + ')');
      c(!env.gmail.draftExists(r.draft_id), 'its draft was deleted');
      h.data.expect[it.email_norm] = 0;
      return r.state + ': ' + r.error;
    } },

  { id: 'row37', title: 'Unsubscribe recorded just after authorization',
    run: function (h, c) {
      var env = h.env(), it = EE_SB_contact_(h, h.core(env), 37, 'production'), later = EE_SB_occ_(it, 2);
      var s = EE_SB_run_(h.core(h.env({ target: it.key, beforeSend: function () { EE_SB_unsub_(h, env, it.email_norm, 'production'); } })), [it, later]);
      c(EE_SB_row_(env, it.key).state === 'sent', 'the authorized delivery completed');
      c(s.sent === 1 && !EE_SB_row_(env, later.key), 'the later one for the same person was blocked (sent=' + s.sent + ')');
      h.data.expect[it.email_norm] = 1;
      return 'authorized one sent; later blocked';
    } },

  { id: 'row38', title: 'Unsubscribe during the Gmail call',
    run: function (h, c) {
      var env = h.env(), it = EE_SB_contact_(h, h.core(env), 38, 'production'), later = EE_SB_occ_(it, 2);
      var s = EE_SB_run_(h.core(h.env({ target: it.key, afterSend: function () { EE_SB_unsub_(h, env, it.email_norm, 'production'); } })), [it, later]);
      c(EE_SB_row_(env, it.key).state === 'sent', 'the in-flight delivery completed');
      c(s.sent === 1 && !EE_SB_row_(env, later.key), 'the later one was blocked (sent=' + s.sent + ')');
      h.data.expect[it.email_norm] = 1;
      return 'in-flight one sent; later blocked';
    } },

  { id: 'row39', title: 'Restore after post-backup activity',
    run: function (h, c) {
      var env = h.env(), core = h.core(env);
      core.catchUp();
      h.backup();
      var it = EE_SB_contact_(h, core, 39, 'production');
      c(EE_SB_run_(h.core(h.env()), [it]).sent === 1, 'sent after the backup');
      core.ingest({ event_id: 'sb_form_' + h.data.tag, type: 'form', mode: 'production', email_norm: it.email_norm, contact_id: it.contact_id });
      core.commitEntity('enrollment', { enrollment_id: it.enrollment_id, status: 'stopped', stop_reason: 'form_submit' }, 'enrollment:' + it.enrollment_id + ':stop');
      h.restore();
      var env2 = h.env();
      c(!env2.store.get('Contacts', it.contact_id), 'the restored sheet really was missing the new contact');
      h.core(env2).catchUp();
      var en = env2.store.get('Enrollments', it.enrollment_id), r = EE_SB_row_(env2, it.key);
      c(!!env2.store.get('Contacts', it.contact_id), 'replay restored the contact');
      c(en && en.status === 'stopped', 'replay restored the enrollment and its stop');
      c(r && r.state === 'sent', 'replay restored the sent delivery');
      c(!!env2.store.get('Inbox', 'sb_form_' + h.data.tag), 'replay restored the form submit');
      var s = EE_SB_run_(h.core(h.env()), [it, EE_SB_occ_(it, 2)]);
      c(s.sent === 0, 'nothing resent after the restore (sent=' + s.sent + ')');
      h.data.expect[it.email_norm] = 1;
      return 'restore + replay rebuilt contact, enrollment, delivery, stop';
    } },

  { id: 'row40', title: 'Test isolation (unsubscribe; bounce/click/reply come with CP5 tracking)',
    run: function (h, c) {
      var env = h.env(), core = h.core(env);
      var t = EE_SB_contact_(h, core, 40, 'test');
      // A production contact at the same address.
      var pid = 'sb_' + h.data.tag + '_40p', pen = 'en_' + pid;
      core.commitEntity('contact', { contact_id: pid, email_norm: t.email_norm, first_name: 'Sandbox', last_name: '40p', bucket: 'B',
        review_status: 'confirmed', source: 'sandbox_suite' }, 'contact:' + pid + ':create');
      core.commitEntity('enrollment', { enrollment_id: pen, contact_id: pid, sequence_id: 'B', mode: 'production', status: 'active',
        stopped_branches: [] }, 'enrollment:' + pen + ':create');
      var p = { key: pen + ':b_intro:1', enrollment_id: pen, contact_id: pid, step_id: 'b_intro', occurrence: 1, mode: 'production',
        email_norm: t.email_norm, bucket: 'B', category: 'marketing', revision_id: h.revisionId('b_intro') };
      c(EE_SB_run_(h.core(h.env()), [t]).sent === 1, 'test delivery sent');
      EE_SB_unsub_(h, env, t.email_norm, 'test');
      c(!!env.store.get('Suppressions_Test', t.email_norm), 'the test unsubscribe went to Suppressions_Test');
      c(!h.sandboxOptoutsHas(t.email_norm) && !h.realOptoutsHas(t.email_norm), 'no Comms_Optouts row (sandbox or real)');
      c(!env.cache.get('sup:production:' + t.email_norm), 'no production suppression cache entry');
      var s = EE_SB_run_(h.core(h.env()), [p, EE_SB_occ_(t, 2)]);
      c(EE_SB_row_(env, p.key).state === 'sent', 'the production contact at the same address still got its email');
      c(!EE_SB_row_(env, EE_SB_occ_(t, 2).key), 'the next test email was blocked (sent=' + s.sent + ')');
      c(env.store.get('Enrollments', pen).status === 'active', 'the production enrollment is unchanged');
      h.data.expect[t.email_norm] = 2;
      return 'test opt-out stayed in test; production unaffected';
    } }
];

// ── Scheduler: runs due steps in order until the time budget, then says when to come back. ──
function EE_SB_steps_() {
  var steps = [];
  EE_SB_SCENARIOS.forEach(function (s) {
    steps.push({ id: s.id, title: s.title, run: s.run, parent: null });
    (s.checks || []).forEach(function (ck) { steps.push({ id: ck.id, title: s.title + ' (later check)', run: ck.run, parent: s.id, after: ck.after }); });
  });
  steps.push({ id: 'final', title: 'Sent counts, leftover drafts, Journal integrity', run: EE_SB_final_, parent: '*', after: 60 * 1000 });
  return steps;
}
function EE_SB_final_(h, c) {
  var counts = [];
  Object.keys(h.data.expect).forEach(function (addr) {
    var n = h.countSent(addr), want = h.data.expect[addr];
    c(n === want, addr + ': ' + n + ' in Sent, expected ' + want);
    counts.push(n);
  });
  var env = h.env();
  var left = env.store.rows('Deliveries').filter(function (r) { return r.draft_id && r.state !== 'sent' && env.gmail.draftExists(r.draft_id); });
  c(left.length === 0, 'no drafts left behind (' + left.map(function (r) { return r.delivery_id; }).join(', ') + ')');
  try { h.core(env).catchUp(); c(true, 'journal ok'); } catch (e) { c(false, 'sandbox Journal check failed: ' + e.message); }
  c(!env.props.get('EE_SAFETY_PAUSE'), 'sandbox never paused itself');
  c(!h.prodSafetyPause(), 'the real engine was never paused');
  var total = counts.reduce(function (a, b) { return a + b; }, 0);
  return total + ' emails in Sent across ' + counts.length + ' addresses';
}
// h.data persists between executions; returns { done, nextAt }.
function EE_SB_tick_(h, budgetMs) {
  var st = h.data, start = h.now(), steps = EE_SB_steps_();
  steps.forEach(function (s) {
    var r = st.results[s.id];
    if (r && r.status === 'running') { r.status = 'fail'; r.failures = ['the execution ended mid-step (time limit?)']; }
  });
  function dueAt(s) {
    if (!s.parent) return 0;
    if (s.parent === '*') {
      var latest = 0;
      for (var i = 0; i < steps.length; i++) {
        if (steps[i].id === 'final') continue;
        var r = st.results[steps[i].id];
        if (!r || r.status === 'running') return Infinity;
        latest = Math.max(latest, r.at);
      }
      return latest + s.after;
    }
    var p = st.results[s.parent];
    return p && p.status !== 'running' ? p.at + s.after : Infinity;
  }
  while (true) {
    var pending = steps.filter(function (s) { return !st.results[s.id]; });
    if (!pending.length) return { done: true };
    var ready = pending.filter(function (s) { return dueAt(s) <= h.now(); });
    if (!ready.length) return { done: false, nextAt: Math.min.apply(null, pending.map(dueAt)) };
    if (h.now() - start > budgetMs) return { done: false, nextAt: h.now() };
    var s = ready[0], failures = [], detail;
    st.results[s.id] = { status: 'running', at: h.now() };
    h.save();
    try { detail = s.run(h, function (ok, what) { if (!ok) failures.push(String(what).slice(0, 240)); }); }
    catch (e) { failures.push('threw: ' + String(e && e.message || e).slice(0, 240)); }
    st.results[s.id] = { status: failures.length ? 'fail' : 'pass', at: h.now(), detail: detail || '', failures: failures };
    h.save();
  }
}
function EE_SB_report_(data) {
  var steps = EE_SB_steps_(), pass = 0, lines = [];
  steps.forEach(function (s) {
    var r = data.results[s.id] || { status: 'not run' };
    if (r.status === 'pass') pass++;
    lines.push((r.status === 'pass' ? 'PASS ' : r.status === 'fail' ? 'FAIL ' : 'WAIT ') + s.id + ' · ' + s.title + (r.detail ? ' · ' + r.detail : '') +
      (r.failures && r.failures.length ? '\n      ✖ ' + r.failures.join('\n      ✖ ') : ''));
  });
  return { pass: pass, total: steps.length, text: lines.join('\n') };
}

// ── Apps Script harness ──
function EE_SB_state_() { var raw = EE_props_().getProperty('SB_STATE'); return raw ? JSON.parse(raw) : null; }
function EE_SB_gasHarness_(data) {
  var props = EE_props_();
  var opts = { mainId: data.main_id, journalId: data.journal_id, settingsId: data.main_id, prefix: EE_SB_PREFIX };
  var h = {
    data: data,
    now: function () { return Date.now(); },
    save: function () { props.setProperty('SB_STATE', JSON.stringify(data)); },
    env: function (spec) { return EE_SB_wrapEnv_(EE_env(opts), spec); },
    core: function (env) { return EE_createCore(env); },
    addr: function (n) { return 'mauricio+sb' + data.tag + n + '@mcpoolsolutions.org'; },
    revisionId: function (step) { return data.revisions[step]; },
    countSent: function (addr) {
      var n = 0;
      GmailApp.search('in:sent to:' + addr, 0, 20).forEach(function (t) {
        t.getMessages().forEach(function (m) { if (String(m.getTo()).toLowerCase().indexOf(addr) !== -1) n++; });
      });
      return n;
    },
    sandboxOptoutsHas: function (email) { return !!EE_optouts_(SpreadsheetApp.openById(data.main_id)).scope(email); },
    realOptoutsHas: function (email) { return !!EE_optouts_(SpreadsheetApp.openById(props.getProperty('EE_SETTINGS_SS_ID'))).scope(email); },
    prodSafetyPause: function () { return props.getProperty('EE_SAFETY_PAUSE'); },
    backup: function () {
      data.backup_id = DriveApp.getFileById(data.main_id).makeCopy('MCPS Email Engine Sandbox backup (' + data.tag + ')',
        DriveApp.getFolderById(props.getProperty('EE_FOLDER_ROOT'))).getId();
      h.save();
    },
    restore: function () {
      // Restore the main sheet only: the Journal (and the opt-outs, which live in
      // the Settings sheet in production) are separate files and stay as they are.
      var src = SpreadsheetApp.openById(data.backup_id), dst = SpreadsheetApp.openById(data.main_id);
      Object.keys(EE_TABLES).forEach(function (name) {
        var from = src.getSheetByName(name), to = dst.getSheetByName(name);
        to.clearContents();
        var v = from.getDataRange().getValues();
        to.getRange(1, 1, v.length, v[0].length).setValues(v);
      });
      SpreadsheetApp.flush();
    }
  };
  return h;
}
function EE_SB_schedule_(atMs) {
  ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'EE_sbContinue'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  if (atMs) ScriptApp.newTrigger('EE_sbContinue').timeBased().after(Math.max(60 * 1000, atMs - Date.now())).create();
}

function eeSandboxSuite() {
  var props = EE_props_(), me = Session.getEffectiveUser().getEmail();
  if (me.toLowerCase() !== String(props.getProperty('EE_OWNER_EMAIL')).toLowerCase()) throw new Error('Run the sandbox suite as the engine owner, not ' + me + '.');
  var old = EE_SB_state_();
  if (old && !old.finished_at && Date.now() - old.started_at < 60 * 60 * 1000) throw new Error('A sandbox suite is already running (started ' + new Date(old.started_at) + '). See eeSandboxStatus().');
  props.getKeys().filter(function (k) { return k.indexOf(EE_SB_PREFIX + 'EE_') === 0; }).forEach(function (k) { props.deleteProperty(k); });

  var tag = Utilities.getUuid().replace(/-/g, '').slice(0, 4);
  var stamp = Utilities.formatDate(new Date(), EE_TZ, 'yyyy-MM-dd HH:mm');
  var main = SpreadsheetApp.create('MCPS Email Engine Sandbox ' + stamp + ' (' + tag + ')');
  var journal = SpreadsheetApp.create('MCPS Email Engine Sandbox Journal ' + stamp + ' (' + tag + ')');
  var root = DriveApp.getFolderById(props.getProperty('EE_FOLDER_ROOT'));
  [main, journal].forEach(function (ss) { DriveApp.getFileById(ss.getId()).moveTo(root); });
  EE_ensureTab_(journal, 'Journal', EE_JOURNAL_HEADERS);
  Object.keys(EE_TABLES).forEach(function (name) { EE_ensureTab_(main, name, EE_TABLES[name]); });
  EE_ensureTab_(main, 'Comms_Optouts', ['email', 'scope', 'opted_out_at', 'source', 'removed_at']);
  [main, journal].forEach(function (ss) { var s1 = ss.getSheetByName('Sheet1'); if (s1) ss.deleteSheet(s1); });

  // Settings, rules and approved content copied from the real engine; alerts stay in the sheet.
  var real = EE_env(), sb = EE_env({ mainId: main.getId(), journalId: journal.getId(), settingsId: main.getId(), prefix: EE_SB_PREFIX });
  var data = { tag: tag, main_id: main.getId(), journal_id: journal.getId(), started_at: Date.now(), results: {}, expect: {}, n: 0, revisions: {} };
  var h = EE_SB_gasHarness_(data);
  var recipients = [];
  [1, 2, 3, 4, 5, 91, 92, 93, 351, 352, 36, 37, 38, 39, 40].forEach(function (n) { recipients.push(h.addr(n)); });
  real.store.rows('Config').forEach(function (r) { sb.store.upsert('Config', r); });
  sb.store.upsert('Config', { key: 'alert_email', value: '' });
  sb.store.upsert('Config', { key: 'test_recipients', value: recipients.join(',') });
  sb.store.upsert('Config', { key: 'engine_enabled', value: 'true' });
  sb.store.upsert('Config', { key: 'paused_buckets', value: '' });
  real.store.rows('Rulesets').forEach(function (r) { sb.store.upsert('Rulesets', r); });
  real.store.rows('Fields').forEach(function (r) { sb.store.upsert('Fields', r); });
  real.store.rows('Revisions').forEach(function (r) {
    sb.store.upsert('Revisions', r);
    if (r.status === 'published') data.revisions[r.step_id] = r.revision_id;
  });
  if (!data.revisions.b_intro) throw new Error('No published b_intro revision to send; run eeApproveBIntro first.');
  sb.meta.set('applied_seq', '0');
  h.save();
  EE_SB_schedule_(Date.now() + 60 * 1000);           // the scenarios start in a fresh execution
  Logger.log('Sandbox suite ' + tag + ' set up: ' + main.getUrl() + '\nThe scenarios start within a minute and take about 25 minutes; the report is emailed to you.');
}

function EE_sbContinue() {
  var data = EE_SB_state_();
  if (!data || data.finished_at) { EE_SB_schedule_(null); return; }
  var h = EE_SB_gasHarness_(data);
  var t = EE_SB_tick_(h, EE_SB_BUDGET_MS);
  if (!t.done) { EE_SB_schedule_(t.nextAt); Logger.log('Sandbox suite: continuing at ' + new Date(Math.max(t.nextAt, Date.now() + 60000))); return; }
  EE_SB_schedule_(null);
  data.finished_at = Date.now(); h.save();
  var rep = EE_SB_report_(data), url = SpreadsheetApp.openById(data.main_id).getUrl();
  var to = EE_config_(EE_env().store).alert_email || 'mauricio@mcpoolsolutions.org';
  MailApp.sendEmail(to, '[Email engine] Sandbox suite ' + data.tag + ': ' + rep.pass + '/' + rep.total + ' passed',
    rep.text + '\n\nSandbox sheet: ' + url + '\nRuntime: ' + Math.round((data.finished_at - data.started_at) / 60000) + ' min');
  Logger.log(rep.text);
}

function eeSandboxStatus() {
  var data = EE_SB_state_();
  if (!data) { Logger.log('No sandbox suite has run.'); return; }
  var rep = EE_SB_report_(data);
  Logger.log((data.finished_at ? 'Finished' : 'Running') + ' (' + data.tag + '): ' + rep.pass + '/' + rep.total + ' passed so far\n' + rep.text);
}
