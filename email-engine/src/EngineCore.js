// ══════════════════════════════════════════════════════════════════════════════
// ENGINE CORE: the safety machinery between "this email is due" and Gmail.
//
// Contract: email-engine/docs/PLAN.md → Guarantees, Lock boundaries, Journal,
// State machines. In one line: nothing that has reached `sending` is ever sent
// again automatically, and every state change is journaled before it happens.
//
// All platform access goes through `env` (see EE_ENV_SHAPE below). In Apps
// Script, Env.js wraps LockService / PropertiesService / SpreadsheetApp /
// GmailApp. In tests/email-engine-core.test.js a fake Gmail and in-memory
// sheets with fault injection run this exact file.
//
// Lock rules (PLAN.md → Lock boundaries): env.withLock() sections only touch
// spreadsheets, properties and cache. Gmail is only ever called outside them.
// ══════════════════════════════════════════════════════════════════════════════

var EE_CONST = {
  LEASE_TTL_MS: 7 * 60 * 1000,            // longer than the 6-minute execution limit
  GRACE_G_MS: 2 * 60 * 1000,              // spike 2b: sent mail searchable within 8.5 s
  GRACE_G2_MS: 15 * 60 * 1000,
  QUIESCENCE_MS: (6 + 30) * 60 * 1000,    // execution lifetime + safety margin
  QUOTA_RESERVE: 20,                      // default; Config quota_reserve overrides. Apps Script's daily quota counts
                                          // only script-sent mail (not Tony's own Gmail), so this just keeps room for alerts
  SUPPRESSION_CACHE_S: 21600,
  GENESIS: 'genesis'
};

// env = {
//   now(): ms                 uuid(): string            sha256(text): hex
//   user(): email             withLock(fn): result      flush()
//   props: {get, set, del}    cache: {get, put}         alert(kind, detail)
//   journal: {last(), get(seq), from(seq), findByOpId(opId), append(rec)}
//   store:   {rows(table), get(table, id), upsert(table, row)}   (main spreadsheet)
//   meta:    {get(key), set(key, value)}
//   optouts: {append(row), hasSource(source), scope(email)}       (shared Comms_Optouts)
//   gmail:   {createDraft(msg), draftExists(id), deleteDraft(id), sendDraft(id),
//             searchSent(token), findDraftsByToken(token)}
//   config:  {ownerEmail(), engineEnabled(), pausedBuckets()}
//   stepStatus(stepId)        revisionStatus(revisionId)   render(row): {to, subject, html, text}
//   quota(): remaining Gmail sends today
// }

function EE_createCore(env) {
  'use strict';
  var C = EE_CONST;
  // Journaled entity types and the main-sheet table each one materializes into.
  var TYPE_TABLE = { delivery: 'Deliveries', enrollment: 'Enrollments', contact: 'Contacts', revision: 'Revisions' };
  var ID_FIELD = { Deliveries: 'delivery_id', Enrollments: 'enrollment_id', Contacts: 'contact_id', Revisions: 'revision_id', Inbox: 'inbox_id',
    Secondaries: 'op_ref', Suppressions_Test: 'email_norm' };
  var REOPENABLE = { released: 1, cancelled: 1 };
  var AWAITING_OUTCOME = { sending: 1, reconcile: 1 };
  // Inbox types that suppress the person: an unsubscribe, or a hard bounce (scope all).
  var SUPPRESSING = { unsubscribe: 1, bounce: 1 };

  function StaleLease() { this.name = 'StaleLease'; this.message = 'lease superseded'; }
  function IntegrityError(reason) { this.name = 'IntegrityError'; this.reason = reason; this.message = 'journal integrity: ' + reason; }
  function norm(e) { return String(e || '').trim().toLowerCase(); }
  function iso(ms) { return new Date(ms).toISOString(); }
  function merge(a, b) { var o = {}, k; for (k in a || {}) o[k] = a[k]; for (k in b || {}) o[k] = b[k]; return o; }
  // Key order never changes a hash: objects are serialised with sorted keys.
  function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
  }
  function hashOf(rec) {
    return env.sha256(rec.prev_hash + '|' + stable({ seq: rec.seq, op_id: rec.op_id, type: rec.type,
      entity_id: rec.entity_id, data: rec.data, at: rec.at }));
  }

  // ── Journal: append → apply → checkpoint (PLAN.md → Journal) ───────────────
  function integrityFail(reason) {
    try { env.props.set('EE_SAFETY_PAUSE', reason); } catch (e) { /* the throw below still stops this caller */ }
    try { env.alert('journal_integrity', reason); } catch (e) { /* alerting must not mask the failure */ }
    throw new IntegrityError(reason);
  }
  function lastRecord() {
    try { return env.journal.last(); } catch (e) { return integrityFail('journal_unavailable'); }
  }
  // Every worker calls this before it claims, authorizes or records anything.
  function ensureCaughtUp() {
    var applied = Number(env.meta.get('applied_seq') || 0);
    var last = lastRecord();
    var head = last ? last.seq : 0;
    if (head === applied) return;
    if (head < applied) integrityFail('journal_behind_checkpoint');
    var prev = applied ? env.journal.get(applied) : null;
    var prevHash = prev ? prev.hash : C.GENESIS;
    var recs = env.journal.from(applied + 1);
    recs.forEach(function (r, i) {
      if (r.seq !== applied + 1 + i) integrityFail('seq_gap');
      if (r.prev_hash !== prevHash) integrityFail('chain_broken');
      if (r.hash !== hashOf(r)) integrityFail('hash_mismatch');
      applyRecord(r);
      env.meta.set('applied_seq', r.seq);
      prevHash = r.hash;
    });
    env.flush();
  }
  function appendJournal(op) {
    var existing = env.journal.findByOpId(op.op_id);
    if (existing) return existing;                      // retried op: never appended twice
    var last = lastRecord();
    var rec = { seq: last ? last.seq + 1 : 1, op_id: op.op_id, type: op.type, entity_id: op.entity_id,
      data: op.data, prev_hash: last ? last.hash : C.GENESIS, at: iso(env.now()) };
    rec.hash = hashOf(rec);
    try {
      env.journal.append(rec);
      env.flush();
    } catch (e) {
      var landed = env.journal.findByOpId(op.op_id);    // append succeeded, acknowledgement lost
      if (landed) return landed;
      throw e;
    }
    return rec;
  }
  function applyRecord(rec) {
    var d = rec.data || {};
    if (TYPE_TABLE[rec.type]) return upsertVersioned(TYPE_TABLE[rec.type], d, rec.seq);
    if (rec.type === 'inbox') {
      if (env.store.get('Inbox', d.inbox_id)) return;
      env.store.upsert('Inbox', merge(d, { last_seq: rec.seq }));
      if (d.secondary) env.store.upsert('Secondaries', { op_ref: rec.op_id, kind: d.secondary, email_norm: d.email_norm,
        scope: d.scope, status: 'pending', last_seq: rec.seq });
      return;
    }
    if (rec.type === 'secondary_applied') {
      var s = env.store.get('Secondaries', d.op_ref);
      if (s && s.status !== 'done') env.store.upsert('Secondaries', merge(s, { status: 'done', last_seq: rec.seq }));
      return;
    }
    integrityFail('unknown_record_type:' + rec.type);
  }
  function upsertVersioned(table, data, seq) {
    var current = env.store.get(table, data[ID_FIELD[table]]);
    if (current && Number(current.last_seq || 0) >= seq) return;   // replay is idempotent
    env.store.upsert(table, merge(merge(current, data), { last_seq: seq }));
  }
  // Must be called inside env.withLock. If apply throws, the checkpoint does not
  // advance and the caller must not take the external action it was guarding.
  function commitLocked(op) {
    ensureCaughtUp();
    var rec = appendJournal(op);
    applyRecord(rec);
    // A retried op returns its older record; the checkpoint only moves forward.
    env.meta.set('applied_seq', Math.max(Number(env.meta.get('applied_seq') || 0), rec.seq));
    env.flush();
    return rec;
  }
  function commitDelivery(row, patch, label) {
    var next = merge(row, patch);
    return commitLocked({ op_id: row.delivery_id + ':' + (label || patch.state) + ':' + next.attempt + ':' + (next.gen || 0),
      type: 'delivery', entity_id: row.delivery_id, data: next }).data;
  }

  // ── Fenced run lease (PLAN.md → Lock boundaries) ──
  function readLease() { var raw = env.props.get('EE_LEASE'); return raw ? JSON.parse(raw) : null; }
  function acquireLease(runId) {
    return env.withLock(function () {
      var cur = readLease(), now = env.now();
      if (cur && cur.expires > now && cur.run_id !== runId) return null;
      var gen = Math.max(Number(env.props.get('EE_LEASE_GEN') || 0), cur ? cur.gen : 0) + 1;
      var lease = { run_id: runId, owner: env.user(), gen: gen, expires: now + C.LEASE_TTL_MS };
      env.props.set('EE_LEASE_GEN', String(gen));
      env.props.set('EE_LEASE', JSON.stringify(lease));
      return lease;
    });
  }
  function leaseIsCurrent(lease) {
    var cur = readLease();
    return !!cur && cur.gen === lease.gen && cur.run_id === lease.run_id;
  }
  function renewLease(lease) {
    return env.withLock(function () {
      if (!leaseIsCurrent(lease)) return false;
      lease.expires = env.now() + C.LEASE_TTL_MS;
      env.props.set('EE_LEASE', JSON.stringify(lease));
      return true;
    });
  }
  function releaseLease(lease) {
    env.withLock(function () { if (leaseIsCurrent(lease)) env.props.del('EE_LEASE'); });
  }
  // A critical section on behalf of a run: refuses if the lease was superseded.
  function fenced(lease, fn) {
    return env.withLock(function () {
      if (!leaseIsCurrent(lease)) throw new StaleLease();
      ensureCaughtUp();
      return fn();
    });
  }

  // ── Pre-send gate (runs inside the lock: sheets, properties, cache only) ──
  function suppressionScope(email, mode) {
    var e = norm(email), scope = '';
    var cached = env.cache.get('sup:' + mode + ':' + e);
    if (cached) scope = cached;
    env.store.rows('Inbox').forEach(function (r) {
      if (SUPPRESSING[r.type] && r.mode === mode && r.email_norm === e) scope = scope === 'all' ? 'all' : (r.scope || 'all');
    });
    if (mode === 'production') {
      var shared = env.optouts.scope(e);                // throws if the shared tab is unreadable
      if (shared) scope = scope === 'all' ? 'all' : shared;
    } else {
      var t = env.store.get('Suppressions_Test', e);
      if (t) scope = scope === 'all' ? 'all' : t.scope;
    }
    return scope;
  }
  function gate(row) {
    if (env.props.get('EE_SAFETY_PAUSE')) return { ok: false, reason: 'safety_pause', fatal: true };
    if (env.config.engineEnabled() === false) return { ok: false, reason: 'kill_switch', fatal: true };
    if (norm(env.user()) !== norm(env.config.ownerEmail())) return { ok: false, reason: 'owner_guard', fatal: true };
    if ((env.config.pausedBuckets() || []).indexOf(row.bucket) !== -1) return { ok: false, reason: 'bucket_paused' };
    var scope;
    try { scope = suppressionScope(row.email_norm, row.mode); }
    catch (e) { return { ok: false, reason: 'suppression_unavailable', fatal: true }; }
    if (scope === 'all' || (scope === 'marketing' && row.category === 'marketing')) return { ok: false, reason: 'suppressed' };
    var en = env.store.get('Enrollments', row.enrollment_id);
    if (!en || en.status !== 'active') return { ok: false, reason: 'enrollment_' + (en ? en.status : 'missing') };
    if (row.category === 'marketing' && (en.stopped_branches || []).indexOf('marketing') !== -1) return { ok: false, reason: 'marketing_branch_stopped' };
    if (env.stepStatus(row.step_id) !== 'active') return { ok: false, reason: 'step_' + env.stepStatus(row.step_id) };
    if (row.revision_id && env.revisionStatus(row.revision_id) === 'revoked') return { ok: false, reason: 'revision_revoked' };
    return { ok: true };
  }

  // ── Delivery stages (PLAN.md → State machines) ──
  // Stage A: claim. Token persisted before any draft exists.
  function claim(lease, plan) {
    return fenced(lease, function () {
      var existing = env.store.get('Deliveries', plan.key);
      if (existing && !REOPENABLE[existing.state]) return { skipped: 'already_' + existing.state };
      var row = merge({ delivery_id: plan.key, key: plan.key, enrollment_id: plan.enrollment_id, contact_id: plan.contact_id,
        step_id: plan.step_id, occurrence: plan.occurrence, mode: plan.mode || 'production', email_norm: norm(plan.email_norm),
        bucket: plan.bucket, category: plan.category, revision_id: plan.revision_id || '' },
        { attempt: existing ? Number(existing.attempt || 1) + 1 : 1 });
      var g = gate(row);
      if (!g.ok) return { skipped: g.reason, fatal: g.fatal };
      return { row: commitDelivery(row, { state: 'claimed', token: 'dlv_' + env.uuid().replace(/-/g, ''),
        run_id: lease.run_id, gen: lease.gen, claimed_at: iso(env.now()), draft_id: '', send_invoked_at: '',
        message_id: '', thread_id: '', error: '' }) };
    });
  }
  // Stage A: render + draft (outside the lock), then record the draft id.
  function prepare(lease, row) {
    var msg;
    try { msg = env.render(row); }
    catch (e) {
      // A template that fails its checks (missing value, integrity, unsafe HTML)
      // fails this delivery for a person to fix; it is never retried daily.
      var why = String(e && e.message || e).slice(0, 500);
      fenced(lease, function () { commitDelivery(row, { state: 'failed', error: why }); });
      try { env.alert('delivery_failed', row.delivery_id + ': ' + why); } catch (e2) { /* the state is recorded */ }
      return null;
    }
    var draftId;
    try {
      draftId = env.gmail.createDraft({ to: msg.to, subject: msg.subject, html: msg.html, text: msg.text, token: row.token, attachments: msg.attachments || [],
        from: msg.from || '', from_name: msg.from_name || '', reply_to: msg.reply_to || '' });
    } catch (e) {
      if (e && e.killed) throw e;
      // Gmail refused (permissions, quota, outage). The delivery stays `claimed`:
      // the next run's recovery searches drafts by token and starts it fresh.
      var err = new Error('gmail_error: ' + String(e && e.message || e).slice(0, 300));
      err.gmailError = true;
      throw err;
    }
    var drafted = { state: 'drafted', draft_id: draftId };
    if (msg.attachment_versions && msg.attachment_versions.length) drafted.attachment_versions = msg.attachment_versions;
    return fenced(lease, function () { return commitDelivery(row, drafted); });
  }
  // The authorization cutoff: drafted → sending, the last check before Gmail.
  function authorize(lease, row) {
    var result = fenced(lease, function () {
      var cur = env.store.get('Deliveries', row.delivery_id);
      if (!cur || cur.state !== 'drafted' || cur.attempt !== row.attempt) return { ok: false, reason: 'state_changed' };
      var g = gate(cur);
      if (!g.ok) return { ok: false, reason: g.reason, fatal: g.fatal,
        row: commitDelivery(cur, { state: 'cancelled', error: g.reason }) };
      return { ok: true, row: commitDelivery(cur, { state: 'sending', send_invoked_at: iso(env.now()) }) };
    });
    if (!result.ok && result.row && row.draft_id) { try { env.gmail.deleteDraft(row.draft_id); } catch (e) { /* the gate already blocked the send */ } }
    return result;
  }
  // Stage B → C. A stale worker may still complete a send it was authorized for
  // (Gmail can't see our lease); it just can't commit anything afterwards.
  function sendAuthorized(lease, row) {
    var res;
    try {
      res = env.gmail.sendDraft(row.draft_id);
    } catch (e) {
      if (e && e.killed) throw e;                       // simulated platform termination: nothing runs after it
      try { fenced(lease, function () { commitDelivery(env.store.get('Deliveries', row.delivery_id), { state: 'reconcile', error: String(e && e.message || e) }); }); }
      catch (e2) { /* left in `sending`; the current worker's reconcile resolves it */ }
      return { state: 'reconcile' };
    }
    // Stage C: keep the ids durable before bookkeeping, so a failed write is
    // recovered as bookkeeping, never as a resend.
    env.props.set('EE_SENT_' + row.delivery_id, JSON.stringify({ message_id: res.message_id, thread_id: res.thread_id, at: env.now() }));
    try {
      fenced(lease, function () {
        commitDelivery(env.store.get('Deliveries', row.delivery_id),
          { state: 'sent', message_id: res.message_id, thread_id: res.thread_id, sent_at: iso(env.now()) });
      });
      env.props.del('EE_SENT_' + row.delivery_id);
    } catch (e) { /* bookkeeping only: reconcile finishes it from EE_SENT_<id> */ }
    return { state: 'sent' };
  }

  // ── Reconcile and recovery (current worker only) ──
  function reconcileAll(lease) {
    var rows = fenced(lease, function () {
      return env.store.rows('Deliveries').filter(function (r) {
        return AWAITING_OUTCOME[r.state] || ((r.state === 'claimed' || r.state === 'drafted') && Number(r.gen) < lease.gen);
      });
    });
    var adopted = [];
    rows.forEach(function (r) {
      var out = reconcileOne(lease, r);
      if (out === 'adopt') adopted.push(env.withLock(function () { return env.store.get('Deliveries', r.delivery_id); }));
    });
    return adopted;
  }
  function reconcileOne(lease, row) {
    var now = env.now();
    if (AWAITING_OUTCOME[row.state]) {
      var pending = env.props.get('EE_SENT_' + row.delivery_id);
      if (pending) {
        var p = JSON.parse(pending);
        fenced(lease, function () { commitDelivery(env.store.get('Deliveries', row.delivery_id),
          { state: 'sent', message_id: p.message_id, thread_id: p.thread_id, sent_at: iso(p.at), resolved_by: 'bookkeeping' }); });
        env.props.del('EE_SENT_' + row.delivery_id);
        return 'sent';
      }
      var age = now - Date.parse(row.send_invoked_at);
      if (age < C.GRACE_G_MS) return 'wait';
      var found = env.gmail.searchSent(row.token);      // outside the lock
      return fenced(lease, function () {
        var cur = env.store.get('Deliveries', row.delivery_id);
        if (!AWAITING_OUTCOME[cur.state]) return cur.state;
        if (found) { commitDelivery(cur, { state: 'sent', message_id: found.message_id, thread_id: found.thread_id,
          sent_at: iso(now), resolved_by: 'sent_search' }); return 'sent'; }
        if (age >= C.GRACE_G2_MS) {
          commitDelivery(cur, { state: 'unknown', error: 'no copy in Sent after ' + Math.round(age / 60000) + ' min' });
          try { env.alert('delivery_unknown', cur.delivery_id); } catch (e) { /* the state is already recorded */ }
          return 'unknown';
        }
        if (cur.state === 'sending') commitDelivery(cur, { state: 'reconcile' });
        return 'reconcile';
      });
    }
    if (row.state === 'claimed') {
      // Abandoned before its draft id was saved: remove any orphan draft by token.
      var orphans = env.gmail.findDraftsByToken(row.token) || [];
      orphans.forEach(function (id) { try { env.gmail.deleteDraft(id); } catch (e) { /* already gone */ } });
      fenced(lease, function () {
        var cur = env.store.get('Deliveries', row.delivery_id);
        if (cur.state === 'claimed' && Number(cur.gen) < lease.gen) commitDelivery(cur, { state: 'released', error: 'abandoned_claim' });
      });
      return 'released';
    }
    if (row.state === 'drafted') {
      // Never authorized, so never sent: adopt it; it re-passes the full gate.
      var adopted = fenced(lease, function () {
        var cur = env.store.get('Deliveries', row.delivery_id);
        if (cur.state !== 'drafted' || Number(cur.gen) >= lease.gen) return false;
        commitDelivery(cur, { run_id: lease.run_id, gen: lease.gen, adopted_from_gen: cur.gen }, 'adopted');
        return true;
      });
      return adopted ? 'adopt' : 'skip';
    }
    return 'skip';
  }

  // ── One delivery through every stage ──
  function processOne(lease, item) {
    var row = item.state === 'drafted' ? item : null;   // an adopted draft skips claim + prepare
    if (!row) {
      var c = claim(lease, item);
      if (!c.row) return { result: 'skipped', reason: c.skipped, fatal: c.fatal };
      row = prepare(lease, c.row);
      if (!row) return { result: 'failed' };
    }
    var a = authorize(lease, row);
    if (!a.ok) return { result: 'cancelled', reason: a.reason, fatal: a.fatal };
    var s = sendAuthorized(lease, a.row);
    return { result: s.state };
  }

  // ── Security audit (row 33; PLAN.md → Security boundary & rollback) ──
  // Each run hashes the security properties; a change since the last run is
  // logged to SecurityAudit (names only, never values) and alerts. The first run
  // records the baseline quietly.
  var SECURITY_PROPS = ['EE_OWNER_EMAIL', 'EE_LINK_SECRET', 'EE_RELAY_SECRET', 'EE_REQUIRE_SECOND_APPROVER', 'EE_MAIN_SS_ID',
    'EE_JOURNAL_SS_ID', 'EE_SETTINGS_SS_ID', 'EE_WEBAPP_URL', 'EE_TRIGGER_OWNER'];
  function securityAudit() {
    var now = {}, changed = [];
    SECURITY_PROPS.forEach(function (k) { var v = env.props.get(k); now[k] = v == null || v === '' ? '' : env.sha256('ee-sec|' + k + '|' + v); });
    env.withLock(function () {
      var raw = env.meta.get('security_hashes'), before = null;
      try { before = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; } catch (e) { before = null; }
      if (before) SECURITY_PROPS.forEach(function (k) { if ((before[k] || '') !== now[k]) changed.push(k); });
      if (!before || changed.length) env.meta.set('security_hashes', JSON.stringify(now));
      if (changed.length) env.store.upsert('SecurityAudit', { id: 'sec_' + env.uuid(), at: iso(env.now()), changed: changed.join(','), effective_user: env.user() });
    });
    if (changed.length) { try { env.alert('security_property_changed', changed.join(', ')); } catch (e) { /* recorded above */ } }
    return changed;
  }
  // ── Schema compatibility (row 32): the data's schema must be one this code reads ──
  function schemaCheck() {
    if (!env.schema) return '';
    var ds = Number(env.meta.get('data_schema') || 0);
    if (ds && (ds > env.schema.read_max || ds < env.schema.read_min)) {
      try { env.alert('schema_incompatible', 'data schema ' + ds + ', this code reads ' + env.schema.read_min + '..' + env.schema.read_max); } catch (e) { /* stop anyway */ }
      return 'schema_incompatible';
    }
    if (ds < env.schema.writes) env.withLock(function () { env.meta.set('data_schema', env.schema.writes); });
    return '';
  }

  // ── The run ──
  // opts: { trigger, plan: function (lease) -> [due items in send order], dailyCap, budgetMs, sentToday }
  function run(opts) {
    opts = opts || {};
    var started = env.now();
    var summary = { run_id: 'run_' + env.uuid(), trigger: opts.trigger || 'daily', started_at: iso(started),
      sent: 0, skipped: 0, cancelled: 0, reconcile: 0, adopted: 0, stopped_reason: 'done' };
    function stop(reason) { summary.stopped_reason = reason; summary.finished_at = iso(env.now()); return summary; }
    // Before anything else, so a changed property is noticed even while sending is off.
    try { securityAudit(); } catch (e) { /* never blocks a run; the next run retries */ }
    if (env.props.get('EE_SAFETY_PAUSE')) return stop('safety_pause');
    var schemaStop = schemaCheck();
    if (schemaStop) return stop(schemaStop);
    if (env.config.engineEnabled() === false) return stop('kill_switch');
    if (norm(env.user()) !== norm(env.config.ownerEmail())) return stop('owner_guard');
    var lease = acquireLease(summary.run_id);
    if (!lease) return stop('already_running');
    try {
      try {
        env.withLock(function () { ensureCaughtUp(); processSecondariesLocked(); });
        var adopted = reconcileAll(lease);
        summary.adopted = adopted.length;
        var queue = adopted.concat(opts.plan ? opts.plan(lease) : []);   // planned under this run's lease
        var sentToday = Number(opts.sentToday || 0);
        for (var i = 0; i < queue.length; i++) {
          if (opts.budgetMs && env.now() - started > opts.budgetMs) return stop('time_budget');
          if (opts.dailyCap && sentToday + summary.sent >= opts.dailyCap) return stop('daily_cap');
          var reserve = env.config.quotaReserve ? Number(env.config.quotaReserve()) : C.QUOTA_RESERVE;
          var remaining = env.quota();
          if (remaining <= reserve) { summary.quota_remaining = remaining; summary.quota_reserve = reserve; return stop('quota_reserve'); }
          if (!renewLease(lease)) return stop('lease_lost');
          var r;
          try { r = processOne(lease, queue[i]); }
          catch (e) {
            if (!(e && e.gmailError)) throw e;
            r = { result: 'error', reason: e.message, fatal: true };   // stop cleanly: one Gmail failure likely affects the rest
          }
          if (r.result === 'sent') summary.sent++;
          else if (r.result === 'reconcile') summary.reconcile++;
          else if (r.result === 'cancelled') summary.cancelled++;
          else if (r.result === 'failed') summary.failed = (summary.failed || 0) + 1;
          else summary.skipped++;
          if (r.fatal) { try { env.alert('run_stopped', r.reason); } catch (e) { /* the run still stops */ } return stop(r.reason); }
        }
        return stop('done');
      } catch (e) {
        if (e instanceof StaleLease) return stop('lease_lost');
        if (e instanceof IntegrityError) return stop('safety_pause');
        throw e;
      }
    } finally { releaseLease(lease); }
  }

  // ── Ingest: unsubscribes, replies, clicks, form submits (no run lease) ──
  // Ordered against authorizations by the same script lock.
  function ingest(evt) {
    var mode = evt.mode === 'test' ? 'test' : 'production';
    var email = norm(evt.email_norm);
    var data = { inbox_id: evt.event_id, type: evt.type, mode: mode, email_norm: email, scope: evt.scope || '',
      contact_id: evt.contact_id || '', enrollment_id: evt.enrollment_id || '', step_id: evt.step_id || '',
      signal: evt.signal || '', confidence: evt.confidence || '', received_at: iso(env.now()),
      secondary: SUPPRESSING[evt.type] && mode === 'production' ? 'comms_optouts' : '' };
    try {
      env.withLock(function () {
        commitLocked({ op_id: 'inbox:' + evt.event_id, type: 'inbox', entity_id: evt.event_id, data: data });
        if (SUPPRESSING[evt.type]) {
          env.cache.put('sup:' + mode + ':' + email, data.scope || 'all', C.SUPPRESSION_CACHE_S);
          if (mode === 'test') env.store.upsert('Suppressions_Test', { email_norm: email, scope: data.scope || 'all' });
        }
      });
      try { env.withLock(processSecondariesLocked); } catch (e) { /* retried by the next run's catch-up */ }
      return { ok: true, journaled: true };
    } catch (e) {
      if (!SUPPRESSING[evt.type]) throw e;
      // Journal down: the opt-out must still never be lost. Sending stays closed
      // (EE_SAFETY_PAUSE) until the Journal is healthy and this is journaled.
      var stored = false;
      try {
        if (mode === 'production') env.optouts.append({ email: email, scope: data.scope || 'all', source: 'fallback:inbox:' + evt.event_id });
        else env.store.upsert('Suppressions_Test', { email_norm: email, scope: data.scope || 'all' });
        stored = true;
      } catch (e2) { /* try the remaining stores */ }
      try { env.cache.put('sup:' + mode + ':' + email, data.scope || 'all', C.SUPPRESSION_CACHE_S); } catch (e3) { /* best effort */ }
      try {
        var fb = JSON.parse(env.props.get('EE_INGEST_FALLBACK') || '[]');
        fb.push(evt); env.props.set('EE_INGEST_FALLBACK', JSON.stringify(fb)); stored = true;
      } catch (e4) { /* nothing else to try */ }
      if (!env.props.get('EE_SAFETY_PAUSE')) { try { env.props.set('EE_SAFETY_PAUSE', 'journal_unavailable'); } catch (e5) { /* recorded above if possible */ } }
      return { ok: stored, journaled: false };
    }
  }
  function processSecondariesLocked() {
    env.store.rows('Secondaries').filter(function (s) { return s.status === 'pending'; }).forEach(function (s) {
      if (!env.optouts.hasSource(s.op_ref)) env.optouts.append({ email: s.email_norm, scope: s.scope || 'all', source: s.op_ref });
      commitLocked({ op_id: 'secondary_applied:' + s.op_ref, type: 'secondary_applied', entity_id: s.op_ref, data: { op_ref: s.op_ref } });
    });
  }

  // ── Operator actions on unclear sends ──
  function markSent(deliveryId, actor) {
    return env.withLock(function () {
      ensureCaughtUp();
      var cur = env.store.get('Deliveries', deliveryId);
      if (!cur || cur.state !== 'unknown') return { ok: false, reason: 'not_unknown' };
      commitDelivery(cur, { state: 'sent', resolved_by: 'operator:' + actor, sent_at: cur.send_invoked_at });
      return { ok: true };
    });
  }
  function abandon(deliveryId, actor) {
    return env.withLock(function () {
      ensureCaughtUp();
      var cur = env.store.get('Deliveries', deliveryId);
      if (!cur || cur.state !== 'unknown') return { ok: false, reason: 'not_unknown' };
      commitDelivery(cur, { state: 'abandoned', resolved_by: 'operator:' + actor });
      return { ok: true };
    });
  }
  // Resend: only after any earlier authorized attempt has certainly finished,
  // and only when Sent still shows no copy. The new attempt then goes through
  // planning and the full gate like any other delivery.
  function resend(deliveryId, actor) {
    var cur = env.withLock(function () { ensureCaughtUp(); return env.store.get('Deliveries', deliveryId); });
    if (!cur || cur.state !== 'unknown') return { ok: false, reason: 'not_unknown' };
    var unlockAt = Date.parse(cur.send_invoked_at) + C.QUIESCENCE_MS;
    if (env.now() < unlockAt) return { ok: false, reason: 'quiescence', unlock_at: iso(unlockAt) };
    var found = env.gmail.searchSent(cur.token);
    return env.withLock(function () {
      ensureCaughtUp();
      var again = env.store.get('Deliveries', deliveryId);
      if (again.state !== 'unknown' || again.attempt !== cur.attempt) return { ok: false, reason: 'state_changed' };
      if (found) {
        commitDelivery(again, { state: 'sent', message_id: found.message_id, thread_id: found.thread_id, resolved_by: 'sent_search' });
        return { ok: false, reason: 'found_in_sent' };
      }
      commitDelivery(again, { state: 'released', resend_requested_by: actor, error: 'resend_requested' });
      return { ok: true };
    });
  }

  // Contact, enrollment and revision changes are journaled like deliveries, so a restore
  // can rebuild them (PLAN.md → Journal coverage). During a run pass the lease;
  // admin edits outside a run take the plain lock.
  function commitEntity(type, data, opId, lease) {
    var table = TYPE_TABLE[type];
    if (!table || type === 'delivery') throw new Error('commitEntity: unsupported type ' + type);
    var body = function () {
      var current = env.store.get(table, data[ID_FIELD[table]]);
      return commitLocked({ op_id: opId, type: type, entity_id: data[ID_FIELD[table]], data: merge(current, data) }).data;
    };
    return lease ? fenced(lease, body) : env.withLock(function () { ensureCaughtUp(); return body(); });
  }

  return {
    run: run, ingest: ingest, resend: resend, markSent: markSent, abandon: abandon, commitEntity: commitEntity,
    // Replay the Journal into the main sheet now, even with sending off (RUNBOOK.md → Restore).
    catchUp: function () { return env.withLock(function () { ensureCaughtUp(); return { applied_seq: Number(env.meta.get('applied_seq') || 0) }; }); },
    // Exposed for tests and for the stage-by-stage concurrency checks.
    acquireLease: acquireLease, renewLease: renewLease, releaseLease: releaseLease,
    claim: claim, prepare: prepare, authorize: authorize, sendAuthorized: sendAuthorized,
    reconcileAll: reconcileAll,
    StaleLease: StaleLease, IntegrityError: IntegrityError
  };
}
