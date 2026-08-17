// Followups.gs
// ══════════════════════════════════════════════════════════════════════════════
// UNSIGNED-AGREEMENT FOLLOW-UPS
//
// An agreement used to be sent and then nothing happened. If the customer went
// quiet the link simply lapsed at 30 days — no nudge, no record that they went
// quiet. This chases them on a schedule and stops the moment they act.
//
// Rides the existing Comms engine rather than duplicating it:
//   commsSendViaGmail_   Comms.js:30   the sender the agreement-link email uses
//   commsOptOutSet_      Comms.js:226  marketing vs transactional opt-out scoping
//   COMMS_EMAIL_RE       Comms.js:153  address validation
//   Comms_Log            Comms.js:163  per-send ledger (also our idempotency key)
//   mcpsEmail*_          SalesHub.js   branded email chrome
//
// ⚠️ SHIPS DARK. FOLLOWUPS_ENABLED defaults off. This is the first thing in the
// portal that emails real customers on a timer with no human in the loop, so it
// must be provable before it is armed.
// ══════════════════════════════════════════════════════════════════════════════

var FOLLOWUP_SCHEDULE_DEFAULT_    = [3, 7, 14];   // days after sent_at
var FOLLOWUP_FINAL_LEAD_DEFAULT_  = 3;            // days BEFORE expires_at
var FOLLOWUP_CLAIM_TTL_MS_        = 10 * 60 * 1000;
var FOLLOWUP_UNCONFIRMED_MS_      = 15 * 60 * 1000;
var FOLLOWUP_MAX_PER_RUN_         = 25;
var FOLLOWUP_MAX_RUN_MS_          = 4 * 60 * 1000;
var FOLLOWUP_LOCK_MS_             = 15000;

var FOLLOWUP_COLUMNS_ = [
  'followup_next_index', 'followup_cycle', 'last_followup_at', 'last_followup_error',
  'followup_claimed_until', 'followup_claim_id', 'followup_stopped_reason',
  'followup_enabled', 'followup_schedule', 'final_notice_lead_days', 'followup_updated_at'
];

// ── Config ───────────────────────────────────────────────────────────────────
function fuProp_(key)      { try { return String(PropertiesService.getScriptProperties().getProperty(key) || '').trim(); } catch (e) { return ''; } }
function fuEnabled_()      { return fuProp_('FOLLOWUPS_ENABLED').toLowerCase() === 'true'; }
function fuDryRun_()       { return fuProp_('FOLLOWUPS_DRY_RUN').toLowerCase() === 'true'; }

function fuSchedule_() {
  var raw = fuProp_('FOLLOWUP_SCHEDULE');
  return fuParseSchedule_(raw);
}

function fuParseSchedule_(raw) {
  if (!raw) return FOLLOWUP_SCHEDULE_DEFAULT_.slice();
  var days = String(raw).split(',').map(function (d) { return Number(String(d).trim()); })
                .filter(function (n) { return !isNaN(n) && n >= 0; });
  return days.length ? days : FOLLOWUP_SCHEDULE_DEFAULT_.slice();
}

function fuScheduleForRow_(row) {
  return fuParseSchedule_(value_(row, 'followup_schedule'));
}

// ⚠️ Test the raw string BEFORE converting. Number('') is 0, not NaN, so an
// isNaN-only guard silently yields a 0-day lead when the property is unset —
// which would schedule the final notice for the exact moment of expiry, after the
// `expired` stop reason has already fired. The most valuable message in the
// sequence would never send.
function fuFinalLeadDays_() {
  var raw = fuProp_('FINAL_NOTICE_LEAD_DAYS');
  return fuParseFinalLeadDays_(raw);
}

function fuParseFinalLeadDays_(raw) {
  if (raw === '') return FOLLOWUP_FINAL_LEAD_DEFAULT_;
  var n = Number(raw);
  return (!isNaN(n) && n > 0) ? n : FOLLOWUP_FINAL_LEAD_DEFAULT_;
}

function fuFinalLeadDaysForRow_(row) {
  var raw = String(value_(row, 'final_notice_lead_days') || '').trim();
  return raw === '' ? fuFinalLeadDays_() : fuParseFinalLeadDays_(raw);
}

function fuFollowupsEnabledForRow_(row) {
  var raw = String(value_(row, 'followup_enabled') || '').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no' && raw !== 'off' && raw !== 'paused';
}

// Approvals sent before this are never chased — see the catch-up policy below.
function fuStartAt_() {
  var d = fuParseDate_(fuProp_('FOLLOWUPS_START_AT'));
  return d ? d.getTime() : null;
}

function fuParseDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var s = String(v).trim();
  if (!s) return null;
  var d = new Date(s.length === 10 ? s + 'T00:00:00' : s);
  return isNaN(d.getTime()) ? null : d;
}

function fuDaysBetween_(a, b) { return (b.getTime() - a.getTime()) / 86400000; }

// ── Milestones ───────────────────────────────────────────────────────────────
// The schedule is [3, 7, 14] days after sent_at, PLUS a final notice derived from
// the real expires_at.
//
// ⚠️ The final notice is NOT a fixed "day 27". Resending preserves the original
// expires_at while resetting sent_at (verified in handleSendProposalForApproval_:
// it writes `expires_at: value_(approval,'expires_at') || …`, so the || only fills
// a blank). A fixed offset would put the "expires in 3 days" message weeks after
// the link actually died, and the copy would be a lie. Deriving from expires_at is
// correct in every case, including rows that predate the resend fix.
function fuMilestones_(sentAt, expiresAt, row) {
  var out = fuScheduleForRow_(row || {}).map(function (d, i) {
    return { index: i, kind: 'nudge', day: d, dueAt: new Date(sentAt.getTime() + d * 86400000) };
  });
  if (expiresAt) {
    var finalDue = new Date(expiresAt.getTime() - fuFinalLeadDaysForRow_(row || {}) * 86400000);
    out.push({ index: out.length, kind: 'final', day: null, dueAt: finalDue });
  }
  return out;
}

// ── Sheet access ─────────────────────────────────────────────────────────────
// migrate=false reads the sheet as-is and adds nothing. Dry run passes false so
// its "changes nothing" guarantee is literal, including schema. Reads are safe
// either way — value_ yields '' for a column that does not exist yet.
function fuApprovalsSheet_(migrate) {
  var sheet = ensureSheet_('Proposal_Approvals', MCPS_PROPOSAL_APPROVAL_HEADERS);
  if (migrate) {
    FOLLOWUP_COLUMNS_.forEach(function (c) { ensureColumn_(sheet, c); });
    ensureColumn_(sheet, 'update_requested_at');   // written by ActionQueue.js
    ensureColumn_(sheet, 'target_agreement_id');   // set on amendment approvals (5c)
  }
  return sheet;
}

function fuRow_(sheet, approvalId) {
  return findRowByValue_(sheet, 'approval_id', approvalId);
}

function fuNum_(v, dflt) {
  var n = Number(String(v == null ? '' : v).trim());
  return isNaN(n) ? (dflt || 0) : n;
}

// ── Ledger — Comms_Log doubles as the idempotency record ─────────────────────
// ⚠️ IDs carry the resend cycle. Without it, cycle 2's day-3 row collides with
// cycle 1's already-'sent' row and the recovery rule below would treat a fresh
// send as already delivered.
function fuLedgerId_(approvalId, cycle, milestone) {
  var tag = milestone.kind === 'final' ? 'final' : ('day' + milestone.day);
  return 'followup:' + approvalId + ':c' + cycle + ':' + tag;
}

function fuFindLedger_(recipientId) {
  var rows = commsSheetRows_('log');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].recipient_id) === recipientId) return rows[i];
  }
  return null;
}

// ── Stop reasons ─────────────────────────────────────────────────────────────
// A silent stop is indistinguishable from a broken sweep, so every terminal state
// records WHY. Values match what the app actually writes — note APPROVED, which is
// what signing sets on the approval row (NOT 'SIGNED').
// ⚠️ Split deliberately into TWO checks.
//
// They used to be one function, which produced a real defect: the approval row
// has no `email` column of its own (it lives on the quote), so calling it on a
// raw row ALWAYS returned 'no_email'. The eligibility guard read that as "has a
// stop reason, therefore worth processing", and after the recipient was enriched
// the reason vanished — letting a row whose status was NOT 'SENT' fall through
// into the send path. Terminal status is now decided on its own, before anything
// else, and eligibility is strictly `status === 'SENT'`.

// Customer acted, or the record is closed. Decidable from the approval row alone.
function fuTerminalReason_(row) {
  var status = String(value_(row, 'status') || '').toUpperCase();
  if (status === 'APPROVED')           return 'approved';   // what signing writes
  if (status === 'DECLINED')           return 'declined';
  if (status === 'CHANGES_REQUESTED')  return 'changes_requested';
  if (String(value_(row, 'responded_at') || '').trim()) return 'approved';
  if (String(value_(row, 'update_requested_at') || '').trim()) return 'update_requested';
  return '';
}

// Everything else that blocks a send. `row` MUST already carry a resolved `email`.
function fuBlockingReason_(row, now, optedOut, startAtMs) {
  var expires = fuParseDate_(value_(row, 'expires_at'));
  if (expires && now.getTime() >= expires.getTime()) return 'expired';

  var sentAt = fuParseDate_(value_(row, 'sent_at'));
  if (startAtMs && sentAt && sentAt.getTime() < startAtMs) return 'pre_rollout';

  var email = String(value_(row, 'email') || '').trim();
  if (!email) return 'no_email';
  if (!COMMS_EMAIL_RE.test(email)) return 'invalid_email';

  if (optedOut && optedOut[email.toLowerCase()]) return 'all_opt_out';
  return '';
}

// The approval row has no email of its own — it lives on the quote.
function fuRecipient_(row) {
  try {
    var hit = getQuoteById_(value_(row, 'quote_id'));
    if (!hit) return { email: '', name: '' };
    var q = hit.object;
    return {
      email: String(value_(q, 'email') || '').trim(),
      name: [value_(q, 'first_name'), value_(q, 'last_name')].filter(Boolean).join(' ').trim() || 'there',
      service: value_(q, 'service') || 'pool service'
    };
  } catch (e) {
    return { email: '', name: '' };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// THE SWEEP
// ══════════════════════════════════════════════════════════════════════════════
function followupSweep_() {
  if (!fuEnabled_()) return { ok: true, skipped: 'FOLLOWUPS_ENABLED is off' };

  var started = Date.now();
  var now = new Date();
  var dryRun = fuDryRun_();
  var runId = Utilities.getUuid();
  var startAtMs = fuStartAt_();
  // ⚠️ Dry run does NOT migrate schema. Column creation is a real sheet write, so
  // it belongs to setupFollowups() (or a live run), not to an inspection mode that
  // promises to change nothing. Reads tolerate missing columns — value_ returns ''.
  var sheet = fuApprovalsSheet_(!dryRun);
  var optedOut = {};
  try { optedOut = commsOptOutSet_('transactional'); } catch (e) {}

  var report = { ok: true, dry_run: dryRun, run_id: runId,
                 considered: 0, attempted: 0, sent: 0, stopped: 0, skipped: 0, planned: [] };
  var snapshot = sheetToObjects_(sheet).rows;

  for (var i = 0; i < snapshot.length; i++) {
    // ⚠️ Cap on ATTEMPTS, not successes. Counting only successes means a Gmail
    // outage lets one run hammer every due row in the book.
    if (report.attempted >= FOLLOWUP_MAX_PER_RUN_) break;
    if (Date.now() - started > FOLLOWUP_MAX_RUN_MS_) break;

    var base = snapshot[i];
    var approvalId = String(value_(base, 'approval_id') || '').trim();
    if (!approvalId) continue;
    if (String(value_(base, 'followup_stopped_reason') || '').trim()) continue;   // already terminal

    // 1. Customer acted → record why, never send.
    var terminal = fuTerminalReason_(base);
    if (terminal) {
      if (!dryRun) fuMarkStopped_(sheet, approvalId, terminal);
      report.stopped++;
      continue;
    }

    // 2. ⚠️ Strictly SENT. DRAFT, blank or any unknown status is not chaseable,
    //    and must not be able to reach the send path by any route.
    if (String(value_(base, 'status') || '').toUpperCase() !== 'SENT') {
      report.skipped++;
      continue;
    }
    if (!fuFollowupsEnabledForRow_(base)) {
      report.skipped++;
      continue;
    }

    report.considered++;

    // 3. Resolve the recipient (it lives on the quote), then the blocking checks.
    var who = fuRecipient_(base);
    var enriched = Object.assign({}, base, { email: who.email });

    var stop = fuBlockingReason_(enriched, now, optedOut, startAtMs);
    if (stop) {
      if (!dryRun) fuMarkStopped_(sheet, approvalId, stop);
      report.stopped++;
      continue;
    }

    var sentAt = fuParseDate_(value_(base, 'sent_at'));
    if (!sentAt) { report.skipped++; continue; }
    var expiresAt = fuParseDate_(value_(base, 'expires_at'));
    var milestones = fuMilestones_(sentAt, expiresAt, base);
    var nextIndex = fuNum_(value_(base, 'followup_next_index'), 0);

    if (nextIndex >= milestones.length) {
      if (!dryRun) fuMarkStopped_(sheet, approvalId, 'schedule_exhausted');
      report.stopped++;
      continue;
    }

    // ── Catch-up: LATEST due milestone only ──────────────────────────────────
    // followup_next_index starts at 0 for every pre-existing approval. Without
    // this a 26-day-old agreement would receive day-3, day-7 and day-14 in quick
    // succession. Send the newest due one and advance past the rest.
    var due = null;
    for (var m = nextIndex; m < milestones.length; m++) {
      if (milestones[m].dueAt.getTime() <= now.getTime()) due = milestones[m];
    }
    if (!due) { report.skipped++; continue; }
    var skippedAhead = due.index > nextIndex;

    var cycle = fuNum_(value_(base, 'followup_cycle'), 0);
    var recipientId = fuLedgerId_(approvalId, cycle, due);

    if (dryRun) {
      // ⚠️ DRY RUN MUST NOT MUTATE. No ledger write, no index advance, no claim.
      // Log the intent only — anything else would corrupt the state it is meant
      // to let you inspect safely.
      report.planned.push({
        approval_id: approvalId, to: who.email, milestone: due.kind === 'final' ? 'final' : ('day' + due.day),
        cycle: cycle, recipient_id: recipientId, skipped_ahead: skippedAhead
      });
      report.sent++;
      continue;
    }

    report.attempted++;
    // The state this decision was based on. The locked re-read below rejects the
    // send if any of it moved — a customer can sign, or the agreement be resent,
    // between the snapshot and the claim.
    var fingerprint = {
      cycle: cycle,
      sentAt: String(value_(base, 'sent_at') || ''),
      expiresAt: String(value_(base, 'expires_at') || ''),
      nextIndex: nextIndex,
      enabled: String(value_(base, 'followup_enabled') || ''),
      schedule: String(value_(base, 'followup_schedule') || ''),
      finalLead: String(value_(base, 'final_notice_lead_days') || '')
    };

    var outcome = fuClaimAndSend_(sheet, approvalId, runId, due, cycle, recipientId,
                                  who, base, skippedAhead, fingerprint, now, optedOut, startAtMs);
    if (outcome === 'sent') report.sent++;
    else report.skipped++;
  }

  return report;
}

// ── Claim → send → finalize ──────────────────────────────────────────────────
// Two distinct failure modes, handled separately:
//   concurrency  two sweeps must not both send        → owned claim
//   crash        Apps Script dies between Gmail accepting and the finalize write
//                → Comms_Log pre-send ledger + recovery rule
function fuClaimAndSend_(sheet, approvalId, runId, milestone, cycle, recipientId, who, baseRow,
                         skippedAhead, fingerprint, now, optedOut, startAtMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(FOLLOWUP_LOCK_MS_)) return 'busy';

  var claimed = false;
  try {
    var row = fuRow_(sheet, approvalId);
    if (!row) return 'gone';

    // Someone else owns it.
    var claimedUntil = fuParseDate_(value_(row, 'followup_claimed_until'));
    if (claimedUntil && claimedUntil.getTime() > Date.now()) return 'claimed_elsewhere';

    // Another sweep already advanced past this milestone.
    if (fuNum_(value_(row, 'followup_next_index'), 0) > milestone.index) return 'already_done';

    // ── ⚠️ Re-validate against the FRESH row ────────────────────────────────
    // The snapshot may be minutes old. In that window the customer can sign,
    // decline, ask for changes or request an update, and staff can resend the
    // agreement (which resets sent_at/expires_at and bumps the cycle). Sending
    // on stale state would mail someone who already acted, and writing an index
    // computed from the old schedule would corrupt the new cycle.
    var terminalNow = fuTerminalReason_(row);
    if (terminalNow) {
      softSetCell_(sheet, row._rowNum, 'followup_stopped_reason', terminalNow);
      return 'became_terminal';
    }
    if (String(value_(row, 'status') || '').toUpperCase() !== 'SENT') return 'not_sent';
    if (!fuFollowupsEnabledForRow_(row)) return 'disabled';

    // A resend happened after the snapshot — this milestone belongs to the old
    // cycle. Abort; the next sweep recomputes against the new one.
    if (fuNum_(value_(row, 'followup_cycle'), 0) !== fingerprint.cycle) return 'cycle_changed';
    if (String(value_(row, 'sent_at') || '') !== fingerprint.sentAt) return 'resent';
    if (String(value_(row, 'expires_at') || '') !== fingerprint.expiresAt) return 'window_changed';
    if (String(value_(row, 'followup_enabled') || '') !== fingerprint.enabled) return 'cadence_changed';
    if (String(value_(row, 'followup_schedule') || '') !== fingerprint.schedule) return 'cadence_changed';
    if (String(value_(row, 'final_notice_lead_days') || '') !== fingerprint.finalLead) return 'cadence_changed';

    // ⚠️ Re-resolve the RECIPIENT and the OPT-OUT SET from source, not from the
    // pre-lock snapshot. Revalidating fresh row state against a stale address is
    // only half a check: between the snapshot and here, the quote's email can be
    // corrected, blanked or made invalid, and the customer can opt out entirely.
    // Either way the snapshot would send to the wrong person, or to someone who
    // has just asked us to stop.
    //
    // These are sheet READS, which is fine inside the lock — the rule is never to
    // SEND while holding it. Opt-outs fall back to the snapshot if the read fails,
    // so a transient Sheets error degrades to the old behaviour rather than
    // blocking every send.
    var whoNow = fuRecipient_(row);
    var optedOutNow = optedOut;
    try { optedOutNow = commsOptOutSet_('transactional'); } catch (e) {}

    var blockNow = fuBlockingReason_(
      Object.assign({}, row, { email: whoNow.email }), now, optedOutNow, startAtMs);
    if (blockNow) {
      softSetCell_(sheet, row._rowNum, 'followup_stopped_reason', blockNow);
      return 'became_blocked';
    }

    // Everything downstream — the ledger row written below and the send after the
    // lock — must use the freshly resolved recipient, never the stale one.
    who = whoNow;

    // ── Recovery: possibly sent, never confirmed ─────────────────────────────
    // A ledger row stuck at 'sending' means Gmail may have accepted it before we
    // died. Do NOT resend. At-most-once beats at-least-once here: a customer
    // missing one nudge costs little, the same chase twice looks broken.
    var existing = fuFindLedger_(recipientId);
    if (existing) {
      var st = String(existing.status || '').toLowerCase();
      if (st === 'sent') {
        fuAdvance_(sheet, approvalId, milestone.index, '');
        return 'already_sent';
      }
      if (st === 'sending') {
        var startedAt = fuParseDate_(existing.attempt_started_at);
        if (startedAt && Date.now() - startedAt.getTime() > FOLLOWUP_UNCONFIRMED_MS_) {
          commsUpdateRowById_('log', 'recipient_id', recipientId, { status: 'unknown' });
          fuAdvance_(sheet, approvalId, milestone.index, 'unconfirmed_send');
          return 'unconfirmed';
        }
        return 'in_flight';
      }
    }

    softSetCell_(sheet, row._rowNum, 'followup_claimed_until', new Date(Date.now() + FOLLOWUP_CLAIM_TTL_MS_).toISOString());
    softSetCell_(sheet, row._rowNum, 'followup_claim_id', runId);
    claimed = true;

    // Pre-send ledger entry — written BEFORE the send so a crash is detectable.
    if (existing) {
      commsUpdateRowById_('log', 'recipient_id', recipientId,
        { status: 'sending', attempt_started_at: nowIso_(), attempt_count: fuNum_(existing.attempt_count, 0) + 1 });
    } else {
      commsAppendRow_('log', {
        recipient_id: recipientId,
        unsubscribe_token: Utilities.getUuid(),
        campaign_id: 'followup:' + approvalId,
        email: who.email,
        name: who.name,
        quote_id: value_(baseRow, 'quote_id'),
        status: 'sending',
        attempt_started_at: nowIso_(),
        attempt_count: 1,
        provider: 'gmail'
      });
    }
  } catch (e) {
    Logger.log('followup claim failed: ' + e);
    return 'error';
  } finally {
    lock.releaseLock();   // ⚠️ never send while holding it
  }

  if (!claimed) return 'skipped';

  // ── Send, outside the lock ───────────────────────────────────────────────
  var sendErr = '';
  try {
    // `row` is var-scoped from the locked block above, so this renders from the
    // freshly re-read row rather than the sweep snapshot.
    var msg = buildFollowupEmail_(milestone, who, row || baseRow);
    commsSendViaGmail_({ to: who.email, subject: msg.subject, htmlBody: msg.html, plainBody: msg.text });
  } catch (e) {
    sendErr = String(e);
  }

  // ⚠️ Settle the LEDGER before contending for the lock.
  //
  // The ledger is what the recovery rule reads, and it distinguishes two very
  // different states: 'sending' means "Gmail may have accepted it, do not resend",
  // while 'failed' means "definitely not delivered, retry". If a Gmail failure
  // left the row at 'sending' because the finalize lock was unavailable, recovery
  // would later mark it unconfirmed and advance the index — burning a touch that
  // provably never went out. Comms_Log is a separate sheet, so this needs no lock.
  if (sendErr) {
    try { commsUpdateRowById_('log', 'recipient_id', recipientId, { status: 'failed', error: sendErr }); }
    catch (e) { Logger.log('followup: ledger failure write failed: ' + e); }
  }

  // ── Finalize ─────────────────────────────────────────────────────────────
  if (!lock.tryLock(FOLLOWUP_LOCK_MS_)) return sendErr ? 'failed' : 'sent';
  try {
    var fresh = fuRow_(sheet, approvalId);
    if (!fresh) return 'gone';

    // ⚠️ Ownership check. If our claim expired and a later sweep re-claimed the
    // row, clearing it here would let a THIRD sweep send the same milestone.
    // Abort instead — the ledger already records what happened.
    if (String(value_(fresh, 'followup_claim_id') || '') !== runId) {
      Logger.log('followup: claim lost for ' + approvalId + ', aborting finalize');
      return 'claim_lost';
    }

    if (sendErr) {
      // Ledger already marked 'failed' above, before the lock.
      softSetCell_(sheet, fresh._rowNum, 'last_followup_error', sendErr.slice(0, 400));
      softSetCell_(sheet, fresh._rowNum, 'followup_claimed_until', '');
      softSetCell_(sheet, fresh._rowNum, 'followup_claim_id', '');
      // followup_next_index deliberately UNCHANGED — retried next sweep.
      return 'failed';
    }

    commsUpdateRowById_('log', 'recipient_id', recipientId, { status: 'sent', sent_at: nowIso_() });
    softSetCell_(sheet, fresh._rowNum, 'followup_next_index', milestone.index + 1);
    softSetCell_(sheet, fresh._rowNum, 'last_followup_at', nowIso_());
    softSetCell_(sheet, fresh._rowNum, 'last_followup_error', skippedAhead ? 'skipped_to_latest' : '');
    softSetCell_(sheet, fresh._rowNum, 'followup_claimed_until', '');
    softSetCell_(sheet, fresh._rowNum, 'followup_claim_id', '');
    return 'sent';
  } finally {
    lock.releaseLock();
  }
}

// Advance without sending (already-sent / unconfirmed recovery paths).
function fuAdvance_(sheet, approvalId, milestoneIndex, note) {
  var row = fuRow_(sheet, approvalId);
  if (!row) return;
  softSetCell_(sheet, row._rowNum, 'followup_next_index', milestoneIndex + 1);
  if (note) softSetCell_(sheet, row._rowNum, 'last_followup_error', note);
  softSetCell_(sheet, row._rowNum, 'followup_claimed_until', '');
  softSetCell_(sheet, row._rowNum, 'followup_claim_id', '');
}

function fuMarkStopped_(sheet, approvalId, reason) {
  var row = fuRow_(sheet, approvalId);
  if (!row) return;
  softSetCell_(sheet, row._rowNum, 'followup_stopped_reason', reason);
  softSetCell_(sheet, row._rowNum, 'followup_claimed_until', '');
  softSetCell_(sheet, row._rowNum, 'followup_claim_id', '');
}

// ── Resend resets the lifecycle ──────────────────────────────────────────────
// handleSendProposalForApproval_ REUSES the active approval row rather than
// creating a new one. Without this reset a resend inherits the previous cycle's
// state and an exhausted approval would never be chased again.
function fuResetLifecycleOnResend_(sheet, rowNum, currentCycle) {
  FOLLOWUP_COLUMNS_.forEach(function (c) { ensureColumn_(sheet, c); });
  softSetCell_(sheet, rowNum, 'followup_cycle', fuNum_(currentCycle, 0) + 1);
  softSetCell_(sheet, rowNum, 'followup_next_index', 0);
  softSetCell_(sheet, rowNum, 'last_followup_at', '');
  softSetCell_(sheet, rowNum, 'last_followup_error', '');
  softSetCell_(sheet, rowNum, 'followup_claimed_until', '');
  softSetCell_(sheet, rowNum, 'followup_claim_id', '');
  softSetCell_(sheet, rowNum, 'followup_stopped_reason', '');
}

// ══════════════════════════════════════════════════════════════════════════════
// EMAIL COPY
//
// Reuses the same chrome as the agreement-link and welcome emails
// (mcpsEmailShell_/Hero_/Footer_ in SalesHub.js) so a follow-up looks like it came
// from the same company. Inline styles + <table> only — Gmail and Outlook drop
// <style> blocks and flexbox.
//
// ⚠️ Never restates pricing. The agreement already carries it, and repeating a
// number in a chase invites renegotiation.
// ══════════════════════════════════════════════════════════════════════════════
function buildFollowupEmail_(milestone, who, approvalRow) {
  var token = String(value_(approvalRow, 'token') || '');
  var url = proposalApprovalUrl_(token, '');
  var isAmendment = !!String(value_(approvalRow, 'target_agreement_id') || '').trim();
  var expires = fuParseDate_(value_(approvalRow, 'expires_at'));
  var name = who.name || 'there';

  var copy = isAmendment
    ? fuAmendmentCopy_(milestone, name, expires)
    : fuNewAgreementCopy_(milestone, name, who.service, expires);

  var body =
    '<tr><td style="padding:32px;">' +
      '<div style="font-family:' + MCPS_EMAIL_FB_ + ';font-size:15px;line-height:1.65;color:#3A4645;">' +
        copy.body +
      '</div>' +
      '<div style="text-align:center;padding:28px 0 6px;">' +
        '<a href="' + htmlEscape_(url) + '" ' +
          'style="display:inline-block;background:#1FA7A8;color:#FFFFFF;text-decoration:none;' +
          'font-family:' + MCPS_EMAIL_FH_ + ';font-weight:bold;font-size:15px;letter-spacing:.03em;' +
          'padding:15px 34px;border-radius:12px;">' + htmlEscape_(copy.cta) + '</a>' +
      '</div>' +
      '<div style="font-family:' + MCPS_EMAIL_FB_ + ';font-size:12.5px;line-height:1.6;color:#8A9494;' +
        'text-align:center;padding-top:10px;">' +
        'Questions? Just reply to this email or call ' + htmlEscape_(mcpsEmailCompany_().phone) + '.' +
      '</div>' +
    '</td></tr>';

  var html = mcpsEmailShell_(
    mcpsEmailHero_({ headline: copy.headline, lede: copy.lede }) + body + mcpsEmailFooter_(),
    copy.preheader
  );

  return { subject: copy.subject, html: html, text: copy.text + '\n\n' + url };
}

function fuExpiryPhrase_(expires) {
  if (!expires) return '';
  var days = Math.max(0, Math.ceil(fuDaysBetween_(new Date(), expires)));
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return 'in ' + days + ' days';
}

function fuNewAgreementCopy_(milestone, name, service, expires) {
  var svc = String(service || 'pool service').toLowerCase();
  if (milestone.kind === 'final') {
    var when = fuExpiryPhrase_(expires);
    return {
      subject: 'Your service agreement expires ' + when,
      preheader: 'The pricing we quoted is held until then.',
      headline: 'Your agreement expires ' + when,
      lede: 'After that the quote closes out and we would need to put together a new one.',
      cta: 'Review & Sign',
      body: '<p style="margin:0 0 14px;">Hi ' + htmlEscape_(name) + ',</p>' +
            '<p style="margin:0 0 14px;">Your service agreement is still open, but it expires ' +
            htmlEscape_(when) + '. The pricing we quoted is held until then.</p>' +
            '<p style="margin:0;">If now is not the right time, just reply and tell us — we would rather ' +
            'know than keep chasing you.</p>',
      text: 'Hi ' + name + ' — your service agreement expires ' + when + '. ' +
            'The pricing we quoted is held until then. Review and sign here:'
    };
  }
  if (milestone.day <= 3) {
    return {
      subject: 'Did your service agreement come through?',
      preheader: 'Everything is ready whenever you are.',
      headline: 'Just making sure you got this',
      lede: 'Your ' + htmlEscape_(svc) + ' agreement is ready to review and sign.',
      cta: 'Review & Sign',
      body: '<p style="margin:0 0 14px;">Hi ' + htmlEscape_(name) + ',</p>' +
            '<p style="margin:0 0 14px;">We sent over your ' + htmlEscape_(svc) + ' agreement a few days ' +
            'ago and wanted to make sure it reached you — sometimes these land in a spam folder.</p>' +
            '<p style="margin:0;">It takes about a minute to review and sign.</p>',
      text: 'Hi ' + name + ' — just making sure your ' + svc + ' agreement reached you. ' +
            'It takes about a minute to review and sign:'
    };
  }
  if (milestone.day <= 7) {
    return {
      subject: 'Any questions about your pool service agreement?',
      preheader: 'Happy to walk through anything before you sign.',
      headline: 'Any questions we can answer?',
      lede: 'We are happy to walk through the scope or the schedule before you sign anything.',
      cta: 'Review & Sign',
      body: '<p style="margin:0 0 14px;">Hi ' + htmlEscape_(name) + ',</p>' +
            '<p style="margin:0 0 14px;">Your agreement is still open. If anything in it needs adjusting — ' +
            'the scope, the start date, the schedule — reply and tell us and we will sort it out.</p>' +
            '<p style="margin:0;">There is also a "Request changes" option on the agreement itself.</p>',
      text: 'Hi ' + name + ' — any questions about your agreement? Reply and tell us what needs ' +
            'adjusting, or review it here:'
    };
  }
  return {
    subject: 'Still holding your pool service pricing',
    preheader: 'Your agreement is open if you would still like to go ahead.',
    headline: 'Still holding your spot',
    lede: 'Your agreement is open if you would still like to go ahead.',
    cta: 'Review & Sign',
    body: '<p style="margin:0 0 14px;">Hi ' + htmlEscape_(name) + ',</p>' +
          '<p style="margin:0 0 14px;">We are still holding the pricing on your ' + htmlEscape_(svc) +
          ' agreement. Nothing has changed on our end.</p>' +
          '<p style="margin:0;">If you have decided against it, a one-line reply is genuinely helpful — ' +
          'we will stop following up.</p>',
    text: 'Hi ' + name + ' — still holding the pricing on your ' + svc + ' agreement:'
  };
}

// Amendment approvals are chased too (an unsigned upgrade is lost revenue), but
// must never use new-customer wording — these people are already customers.
function fuAmendmentCopy_(milestone, name, expires) {
  if (milestone.kind === 'final') {
    var when = fuExpiryPhrase_(expires);
    return {
      subject: 'Your plan change expires ' + when,
      preheader: 'Sign to confirm the change to your service.',
      headline: 'Your plan change expires ' + when,
      lede: 'Until it is signed, your service continues exactly as it is today.',
      cta: 'Review & Sign',
      body: '<p style="margin:0 0 14px;">Hi ' + htmlEscape_(name) + ',</p>' +
            '<p style="margin:0 0 14px;">The change to your service is still waiting on a signature, and ' +
            'it expires ' + htmlEscape_(when) + '.</p>' +
            '<p style="margin:0;">Nothing changes until you sign — your service continues as it is today.</p>',
      text: 'Hi ' + name + ' — your plan change expires ' + when + '. Nothing changes until you sign:'
    };
  }
  return {
    subject: 'Your plan change is waiting for a signature',
    preheader: 'Your service continues as normal until it is signed.',
    headline: 'Your plan change is waiting',
    lede: 'Your service continues exactly as it is today until this is signed.',
    cta: 'Review & Sign',
    body: '<p style="margin:0 0 14px;">Hi ' + htmlEscape_(name) + ',</p>' +
          '<p style="margin:0 0 14px;">The change to your pool service is ready, but we still need your ' +
          'signature to put it into effect.</p>' +
          '<p style="margin:0;">Until then nothing changes — your service continues exactly as it is today.</p>',
    text: 'Hi ' + name + ' — your plan change is waiting for a signature. Nothing changes until you sign:'
  };
}

// ── Triggers ─────────────────────────────────────────────────────────────────
function followupSweepGuard_() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'followupSweep_';
  });
  if (!exists) ScriptApp.newTrigger('followupSweep_').timeBased().everyHours(1).create();
}

function setupFollowups() {
  fuApprovalsSheet_(true);   // explicit schema migration lives here, not in the sweep
  var triggers = ScriptApp.getProjectTriggers();
  var hasSweep = triggers.some(function (t) { return t.getHandlerFunction() === 'followupSweep_'; });
  var hasGuard = triggers.some(function (t) { return t.getHandlerFunction() === 'followupSweepGuard_'; });
  if (!hasSweep) ScriptApp.newTrigger('followupSweep_').timeBased().everyHours(1).create();
  if (!hasGuard) ScriptApp.newTrigger('followupSweepGuard_').timeBased().everyHours(6).create();
  return { ok: true, sweep: true, guard: true };
}

// Run by hand to inspect what WOULD go out. Safe: fuEnabled_ still gates it, and
// dry-run mutates nothing.
function TEST_followupDryRun() {
  var r = followupSweep_();
  Logger.log(JSON.stringify(r, null, 2));
  return r;
}
