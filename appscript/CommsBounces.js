// CommsBounces.js — turn delivery failures into suppression.
//
// On Gmail there is no provider webhook: nothing tells the portal that an address
// is dead. Without this, every campaign re-mails the same dead addresses, and the
// failures accumulate against the Workspace domain that also sends agreements and
// invoices. That is the single biggest deliverability risk of staying on Gmail,
// and it is entirely fixable by reading the mailbox the bounces land in.
//
// Reads mailer-daemon reports, extracts the failed recipient and the SMTP status,
// and routes a permanent failure into Comms_Optouts — the same table the
// unsubscribe flow writes to, which commsDedupeAndFlag_ already applies to EVERY
// audience type. So suppression takes effect everywhere at once, including on a
// client-supplied 'selected' list, with no new plumbing.
//
// Follows the shape of InvoiceEmailParser.js: script lock, a Gmail label as the
// processed-marker, bounded batch per run.

var CB_LABEL          = 'MCPS/Bounces-Processed';
var CB_MAX_THREADS    = 25;    // per run — the 6-minute ceiling is the real limit
var CB_SEARCH_WINDOW  = '14d';
// A single soft failure is normal (full mailbox, greylisting). A repeated one is
// an address that is not coming back.
var CB_SOFT_LIMIT     = 3;
var CB_SOFT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Parsing ─────────────────────────────────────────────────────────────────
// Pure and side-effect free so it can be tested against real bounce bodies.
// Returns { email, kind: 'hard'|'soft'|'unknown', code, reason }.
//
// Precedence is deliberate: the RFC 3464 machine-readable fields come first
// because they are unambiguous, and the human prose is only a fallback. Reading
// the prose first would misclassify every provider that words things differently.
var CB_EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;

function cbParseBounce_(body, subject) {
  var text = String(body == null ? '' : body);
  var out = { email: '', kind: 'unknown', code: '', reason: '' };

  // 1. Recipient — the DSN field, then its older sibling.
  var m = text.match(/Final-Recipient:\s*(?:rfc822|RFC822)?\s*;?\s*([^\s<>,;]+@[^\s<>,;]+)/i)
       || text.match(/Original-Recipient:\s*(?:rfc822|RFC822)?\s*;?\s*([^\s<>,;]+@[^\s<>,;]+)/i);
  if (m) {
    out.email = String(m[1]).replace(/[<>]/g, '').trim().toLowerCase();
  } else {
    // Gmail's prose form: "Your message wasn't delivered to someone@example.com".
    var pm = text.match(/(?:wasn't delivered to|was not delivered to|could not be delivered to|Delivery to the following recipient failed[^\n]*\n\s*)\s*([^\s<>,;]+@[^\s<>,;]+)/i);
    if (pm) out.email = String(pm[1]).replace(/[<>.]+$/, '').trim().toLowerCase();
  }

  // 2. Status — RFC 3464 enhanced code decides permanence outright.
  var st = text.match(/Status:\s*([245])\.(\d+)\.(\d+)/i);
  if (st) {
    out.code = st[1] + '.' + st[2] + '.' + st[3];
    out.kind = st[1] === '5' ? 'hard' : (st[1] === '4' ? 'soft' : 'unknown');
  } else {
    // Fall back to the raw SMTP reply inside Diagnostic-Code or the prose.
    var sm = text.match(/\b(5\d\d)[\s-]/) ;
    var tm = text.match(/\b(4\d\d)[\s-]/);
    if (sm)      { out.code = sm[1]; out.kind = 'hard'; }
    else if (tm) { out.code = tm[1]; out.kind = 'soft'; }
  }

  // 3. Action is a tiebreaker only — 'delayed' is never permanent, whatever else
  //    the message says, because the server is still trying.
  if (/Action:\s*delayed/i.test(text) && out.kind === 'hard' && !st) out.kind = 'soft';

  // 4. Reason, for the audit trail. The diagnostic line is the useful one.
  var dm = text.match(/Diagnostic-Code:\s*(?:smtp;)?\s*([^\n\r]+)/i);
  if (dm) out.reason = String(dm[1]).trim().slice(0, 300);
  else if (subject) out.reason = String(subject).trim().slice(0, 300);

  if (out.email && !CB_EMAIL_RE.test(out.email)) out.email = '';
  return out;
}

// An out-of-office reply is not a bounce, and suppressing someone for going on
// holiday would be a quiet, permanent loss.
function cbLooksLikeAutoReply_(subject, body) {
  var s = String(subject || '') + ' ' + String(body || '').slice(0, 400);
  return /out of (the )?office|automatic reply|auto[- ]?reply|on vacation|annual leave/i.test(s)
      && !/Final-Recipient|Diagnostic-Code|Status:\s*[45]\./i.test(String(body || ''));
}

// Never suppress ourselves — a loop where the portal silences its own sending
// address would stop all campaign mail with no obvious cause.
function cbIsOwnAddress_(email) {
  var e = String(email || '').toLowerCase();
  if (!e) return true;
  var mine = [];
  try { mine.push(String(Session.getEffectiveUser().getEmail() || '').toLowerCase()); } catch (err) {}
  try {
    var from = String(commsProps_().getProperty('COMMS_RESEND_FROM') || '');
    var fm = from.match(CB_EMAIL_RE);
    if (fm) mine.push(fm[0].toLowerCase());
  } catch (err2) {}
  return mine.indexOf(e) !== -1 || /^(mailer-daemon|postmaster|no-?reply)@/i.test(e);
}

// ─── Sweep ───────────────────────────────────────────────────────────────────
function commsBounceSweep_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log('commsBounceSweep_: already running'); return { ok: true, skipped: true }; }
  try {
    commsEnsureSheets_();
    var label = GmailApp.getUserLabelByName(CB_LABEL) || GmailApp.createLabel(CB_LABEL);
    var query = 'from:(mailer-daemon OR postmaster) -label:"' + CB_LABEL + '" newer_than:' + CB_SEARCH_WINDOW;

    var threads = GmailApp.search(query, 0, CB_MAX_THREADS);
    var seen = 0, hard = 0, soft = 0, unknown = 0, suppressed = 0;
    var rows = [];
    var now = new Date().toISOString();

    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (msg) {
        var subject = '', body = '';
        try { subject = msg.getSubject() || ''; } catch (e) {}
        try { body = msg.getPlainBody() || ''; } catch (e) {}
        if (cbLooksLikeAutoReply_(subject, body)) return;

        var parsed = cbParseBounce_(body, subject);
        seen++;
        if (!parsed.email || cbIsOwnAddress_(parsed.email)) {
          // Recorded rather than dropped: an unparsed format is a gap in this
          // parser, and it should be visible instead of silently discarded.
          unknown++;
          rows.push({ bounce_id: Utilities.getUuid(), email: parsed.email || '', kind: 'unknown',
                      code: parsed.code || '', reason: (parsed.reason || subject || '').slice(0, 300),
                      detected_at: now, suppressed: '' });
          return;
        }
        if (parsed.kind === 'hard') hard++; else if (parsed.kind === 'soft') soft++; else unknown++;
        rows.push({ bounce_id: Utilities.getUuid(), email: parsed.email, kind: parsed.kind,
                    code: parsed.code, reason: parsed.reason, detected_at: now, suppressed: '' });
      });
      try { thread.addLabel(label); } catch (e) { Logger.log('bounce label failed: ' + e); }
    });

    if (rows.length) commsAppendRows_('bounces', rows);
    suppressed = cbApplySuppressions_(rows);

    Logger.log('Bounce sweep: ' + seen + ' message(s), ' + hard + ' hard, ' + soft + ' soft, ' +
               unknown + ' unparsed, ' + suppressed + ' address(es) suppressed.');
    return { ok: true, seen: seen, hard: hard, soft: soft, unknown: unknown, suppressed: suppressed };
  } finally {
    lock.releaseLock();
  }
}

// Hard failures suppress immediately. Soft ones only once they repeat, counted
// across the whole recorded history rather than this run — one full mailbox on a
// Tuesday should not cost you the address.
function cbApplySuppressions_(newRows) {
  if (!newRows || !newRows.length) return 0;
  var all = commsSheetRows_('bounces');
  var cutoff = Date.now() - CB_SOFT_WINDOW_MS;
  var softCounts = {};
  all.forEach(function (r) {
    if (String(r.kind) !== 'soft') return;
    var t = Date.parse(r.detected_at || '') || 0;
    if (t && t < cutoff) return;
    var e = String(r.email || '').trim().toLowerCase();
    if (e) softCounts[e] = (softCounts[e] || 0) + 1;
  });

  var done = {}, n = 0;
  newRows.forEach(function (r) {
    var email = String(r.email || '').trim().toLowerCase();
    if (!email || done[email]) return;
    var isHard = r.kind === 'hard';
    var repeatedSoft = r.kind === 'soft' && (softCounts[email] || 0) >= CB_SOFT_LIMIT;
    if (!isHard && !repeatedSoft) return;
    commsUpsertOptOut_(email, 'all', isHard ? 'bounce_hard' : 'bounce_soft_repeated', '');
    cbMarkSuppressed_(email);
    done[email] = true;
    n++;
  });
  return n;
}

function cbMarkSuppressed_(email) {
  var sheet = commsSheet_('bounces');
  var headers = commsActualHeaders_(sheet);
  var target = String(email || '').trim().toLowerCase();
  commsSheetRows_('bounces').forEach(function (r) {
    if (String(r.email || '').trim().toLowerCase() !== target) return;
    if (String(r.suppressed || '')) return;
    commsPatchRow_(sheet, headers, r._row, { suppressed: 'TRUE' });
  });
}

// ─── Trigger + admin surface ─────────────────────────────────────────────────
function installCommsBounceSweep() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'commsBounceSweep_';
  });
  if (exists) { Logger.log('Bounce sweep trigger already installed'); return; }
  ScriptApp.newTrigger('commsBounceSweep_').timeBased().everyHours(1).create();
  Logger.log('Bounce sweep installed — hourly');
}

function handleCommsListBounces_(payload) {
  commsEnsureSheets_();
  var limit = Math.min(Math.max(Number(payload && payload.limit) || 100, 1), 500);
  var rows = commsSheetRows_('bounces').map(function (r) {
    return { email: r.email, kind: r.kind, code: r.code, reason: r.reason,
             detected_at: r.detected_at, suppressed: !!String(r.suppressed || '') };
  });
  rows.sort(function (a, b) { return String(b.detected_at).localeCompare(String(a.detected_at)); });
  var hard = rows.filter(function (r) { return r.kind === 'hard'; }).length;
  var unparsed = rows.filter(function (r) { return r.kind === 'unknown'; }).length;
  return { ok: true, bounces: rows.slice(0, limit), total: rows.length,
           hard: hard, unparsed: unparsed, truncated: rows.length > limit };
}

// Editor-runnable: run the sweep by hand and see what it found.
function commsBounceSweepNow() {
  var res = commsBounceSweep_();
  Logger.log(JSON.stringify(res, null, 2));
  return res;
}
