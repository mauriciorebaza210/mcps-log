// ══════════════════════════════════════════════════════════════════════════════
// REPLIES AND BOUNCES: read Tony's mailbox for answers to the engine's emails.
//
// Contract: email-engine/docs/PLAN.md → Tracking → Replies (precedence is
// explicit). For each new message in a thread the engine sent, in order:
//   1. from Tony or one of his aliases      → ignored
//   2. mailer-daemon / postmaster / a DSN   → bounce (hard → suppress everywhere)
//   3. auto-reply headers or wording         → auto_reply (never stops anything)
//   4. from the contact's address            → reply (B: stops the sequence)
//   5. anyone else                            → reply_other (stops marketing, flagged)
// One event per Gmail message, ever (event id = msg_<id>). A message is credited
// to the latest delivery in its thread sent before it arrived, and only to that
// delivery's enrollment, so a shared thread never multiplies a stop.
//
// Bounces that land outside the thread are found by searching mailer-daemon
// mail for the delivery's token (every email carries "Ref dlv_…").
// The bounce rules mirror the portal's appscript/CommsBounces.js (separate
// project, so copied rather than shared).
//
// env.gmail adds: threadMessages(threadId) -> [msg], bounceMessages(days) -> [msg], aliases() -> [email]
//   msg = { id, from, date (ms), subject, body, headers: {auto_submitted, x_autoreply, x_autorespond, precedence, content_type} }
// ══════════════════════════════════════════════════════════════════════════════

var EE_SCAN_DAYS = 45;              // threads of deliveries sent in this window
var EE_SCAN_MAX_THREADS = 150;
var EE_SCAN_BUDGET_MS = 90 * 1000;
var EE_TOKEN_RE = /dlv_[0-9a-f]{32}/g;

function EE_emailOf_(from) {
  var m = String(from || '').match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
  return m ? m[0].toLowerCase() : '';
}

function EE_parseBounce_(body, subject) {
  var text = String(body == null ? '' : body), out = { kind: 'unknown', code: '' };
  var st = text.match(/Status:\s*([245])\.(\d+)\.(\d+)/i);
  if (st) { out.code = st[1] + '.' + st[2] + '.' + st[3]; out.kind = st[1] === '5' ? 'hard' : (st[1] === '4' ? 'soft' : 'unknown'); }
  else {
    var sm = text.match(/\b(5\d\d)[\s-]/), tm = text.match(/\b(4\d\d)[\s-]/);
    if (sm) { out.code = sm[1]; out.kind = 'hard'; } else if (tm) { out.code = tm[1]; out.kind = 'soft'; }
  }
  if (/Action:\s*delayed/i.test(text) && out.kind === 'hard' && !st) out.kind = 'soft';
  return out;
}

function EE_looksAutomated_(m) {
  var h = m.headers || {};
  var auto = String(h.auto_submitted || '').trim().toLowerCase();
  if (auto && auto !== 'no') return true;
  if (h.x_autoreply || h.x_autorespond) return true;
  if (/^(auto_reply|bulk|junk|list)$/i.test(String(h.precedence || '').trim())) return true;
  var s = String(m.subject || '') + ' ' + String(m.body || '').slice(0, 400);
  return /out of (the )?office|automatic reply|auto[- ]?reply|autorespuesta|respuesta autom|on vacation|annual leave|fuera de la oficina/i.test(s);
}

// ctx: { own: [emails], contact: [emails] } → 'own' | 'bounce' | 'auto_reply' | 'reply' | 'reply_other'
function EE_classifyInbound_(m, ctx) {
  var from = EE_emailOf_(m.from);
  if (!from || (ctx.own || []).indexOf(from) !== -1) return 'own';
  var ct = String((m.headers || {}).content_type || '');
  if (/^(mailer-daemon|postmaster)@/i.test(from) || /report-type="?delivery-status/i.test(ct)) return 'bounce';
  if (EE_looksAutomated_(m)) return 'auto_reply';
  if ((ctx.contact || []).indexOf(from) !== -1) return 'reply';
  return 'reply_other';
}

function EE_createReplyScanner(env, core, opts) {
  opts = opts || {};
  var tracker = EE_createTracker(env, core);
  var budget = opts.budgetMs || EE_SCAN_BUDGET_MS;

  function scan() {
    var started = env.now(), stats = { threads: 0, messages: 0, replies: 0, other: 0, auto: 0, bounces: 0, skipped_threads: 0, stopped: '' };
    var own = [String(env.config.ownerEmail() || '').toLowerCase()];
    try { (env.gmail.aliases() || []).forEach(function (a) { own.push(String(a).toLowerCase()); }); } catch (e) { /* owner only */ }
    var contacts = {};
    env.store.rows('Contacts').forEach(function (c) { contacts[c.contact_id] = c; });
    var since = started - EE_SCAN_DAYS * 86400000;
    var byThread = {}, byToken = {};
    env.store.rows('Deliveries').forEach(function (d) {
      if (d.token) byToken[d.token] = d;
      if (d.state !== 'sent' || !d.thread_id || Date.parse(d.sent_at) < since) return;
      (byThread[d.thread_id] = byThread[d.thread_id] || []).push(d);
    });
    var cursors = {};
    env.store.rows('Threads').forEach(function (t) { cursors[t.thread_id] = t; });

    // Most recently sent first, so a long backlog never starves this week's replies.
    var threads = Object.keys(byThread).sort(function (a, b) { return latest(byThread[b]) - latest(byThread[a]); }).slice(0, EE_SCAN_MAX_THREADS);
    for (var i = 0; i < threads.length; i++) {
      if (env.now() - started > budget) { stats.stopped = 'time_budget'; break; }
      var tid = threads[i], cur = cursors[tid] || { thread_id: tid, seen_json: [] };
      var msgs = env.gmail.threadMessages(tid) || [];
      stats.threads++;
      if (Number(cur.message_count || 0) === msgs.length && cur.seen_json && cur.seen_json.length) { stats.skipped_threads++; continue; }
      var seen = cur.seen_json || [], events = [];
      msgs.forEach(function (m) {
        if (seen.indexOf(m.id) !== -1) return;
        var d = creditedDelivery(byThread[tid], m.date);
        if (!d) { seen.push(m.id); return; }                 // older than anything we sent here
        var c = contacts[d.contact_id] || {};
        var kind = EE_classifyInbound_(m, { own: own, contact: [d.email_norm].concat(String(c.alt_emails || '').split(',').map(EE_emailOf_).filter(String)) });
        stats.messages++;
        if (kind !== 'own') events.push(eventFor(kind, m, d));
        seen.push(m.id);
      });
      var res = events.length ? tracker.ingest(events) : [];
      // Advance the cursor only past messages whose event landed (or that needed none),
      // so a failure is retried next run and never double-counted (event ids dedupe).
      var failed = {};
      res.forEach(function (r, k) { if (r.status === 'error') failed[events[k].gmail_message_id] = 1; });
      count(stats, events, res);
      env.withLock(function () {
        env.store.upsert('Threads', { thread_id: tid, message_count: Object.keys(failed).length ? 0 : msgs.length,
          seen_json: seen.filter(function (id) { return !failed[id]; }), last_scanned_at: new Date(env.now()).toISOString() });
      });
    }

    // Bounces that came back outside the thread: matched by the token in the DSN.
    if (env.now() - started <= budget) {
      var bounceEvents = [];
      (env.gmail.bounceMessages(7) || []).forEach(function (m) {
        var tokens = String(m.body || '').match(EE_TOKEN_RE) || [];
        var d = null;
        for (var t = 0; t < tokens.length && !d; t++) d = byToken[tokens[t]] || null;
        if (d && d.state === 'sent') bounceEvents.push(eventFor('bounce', m, d));
      });
      if (bounceEvents.length) count(stats, bounceEvents, tracker.ingest(bounceEvents));
    }
    stats.ms = env.now() - started;
    return stats;
  }

  function latest(list) { return list.reduce(function (mx, d) { return Math.max(mx, Date.parse(d.sent_at) || 0); }, 0); }
  function creditedDelivery(list, at) {
    var best = null;
    (list || []).forEach(function (d) {
      var t = Date.parse(d.sent_at);
      if (t <= at && (!best || t > Date.parse(best.sent_at))) best = d;
    });
    return best;
  }
  function eventFor(kind, m, d) {
    var ev = { event_id: 'msg_' + m.id, gmail_message_id: m.id, type: kind, token: d.token, mode: d.mode,
      received_at: m.date, source: 'gmail', snippet: kind === 'bounce' ? '' : String(m.body || '').replace(/\s+/g, ' ').trim().slice(0, 200) };
    if (kind === 'bounce') { var b = EE_parseBounce_(m.body, m.subject); ev.bounce_kind = b.kind; ev.bounce_code = b.code; }
    return ev;
  }
  function count(stats, events, res) {
    res.forEach(function (r, k) {
      if (r.status !== 'recorded') return;
      var t = events[k].type;
      if (t === 'reply') stats.replies++; else if (t === 'reply_other') stats.other++;
      else if (t === 'auto_reply') stats.auto++; else if (t === 'bounce') stats.bounces++;
    });
  }

  return { scan: scan };
}
