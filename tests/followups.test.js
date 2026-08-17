// Stage 5a — follow-up engine regression suite.
//
//   node tests/followups.test.js        (exits non-zero on failure)
//
// Runs the REAL appscript/Followups.js against in-memory sheets; only the Apps
// Script services and sheet-access helpers are stubbed. This exists because the
// sweep emails real customers on a timer with no human in the loop — the failure
// modes it covers (double sends, burnt touches, stale mail after a customer has
// already signed) are invisible until a customer complains.
const fs = require('fs'), vm = require('vm');
const path = require('path');
const SRC = path.join(__dirname, '..', 'appscript', 'Followups.js');

const DAY = 86400000;
const iso = d => new Date(d).toISOString();

function Sheet(headers, rows) {
  return {
    rows: [headers.slice(), ...rows.map(r => r.slice())],
    getLastRow() { return this.rows.length; },
    getDataRange() { return { getValues: () => this.rows }; }
  };
}

function build(opts) {
  const o = opts || {};
  const NOW = o.now || Date.now();

  const approvals = Sheet(
    ['approval_id','proposal_id','quote_id','token','status','customer_note',
     'sent_at','responded_at','expires_at','created_at','updated_at',
     'followup_enabled','followup_schedule','final_notice_lead_days'],
    o.approvals || []);
  const quotes = Sheet(
    ['quote_id','first_name','last_name','email','service'],
    o.quotes || [['Q1','Jordan','Rivera','jordan@example.com','Weekly Full Service']]);

  let logRows = (o.log || []).slice();
  const sent = [];
  const props = Object.assign({ FOLLOWUPS_ENABLED: 'true' }, o.props || {});
  let lockHeld = false;

  const ctx = {
    console, String, Number, Math, JSON, Array, Object, isNaN, RegExp,
    // ⚠️ Freeze BOTH Date.now() and bare `new Date()`. followupSweep_ uses
    // `new Date()`, which ignores a Date.now override — without this the whole
    // schedule runs against the real wall clock and boundary cases flip randomly.
    Date: class FrozenDate extends Date {
      constructor(...args) { if (args.length === 0) super(NOW); else super(...args); }
      static now() { return NOW; }
      static parse(s) { return Date.parse(s); }
    },
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null }) },
    Utilities: { getUuid: () => 'run-' + Math.random().toString(36).slice(2, 10) },
    LockService: { getScriptLock: () => ({
      tryLock() { if (lockHeld) return false; lockHeld = true; return true; },
      releaseLock() { lockHeld = false; }
    })},
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyHours: () => ({ create: () => {} }) }) }) },
    COMMS_EMAIL_RE: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    MCPS_PROPOSAL_APPROVAL_HEADERS: approvals.rows[0].slice(),
    MCPS_EMAIL_FH_: 'Montserrat,sans-serif', MCPS_EMAIL_FB_: 'Open Sans,sans-serif',
    htmlEscape_: s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),
    mcpsEmailCompany_: () => ({ phone: '(210) 559-2073', website: 'missioncustompools.com' }),
    mcpsEmailShell_: (rows, pre) => '<html>' + rows + '</html>',
    mcpsEmailHero_: opt => '<hero>' + opt.headline + '|' + opt.lede + '</hero>',
    mcpsEmailFooter_: () => '<footer/>',
    mcpsEmailIconUrl_: () => 'https://x/icon.png',
    proposalApprovalUrl_: (t) => 'https://mcps-log.vercel.app/agreement.html?token=' + t,
    nowIso_: () => iso(NOW),

    ensureSheet_: () => approvals,
    ensureColumn_(sheet, name) {
      if (sheet.rows[0].indexOf(name) !== -1) return;
      sheet.rows[0].push(name);
      for (let r = 1; r < sheet.rows.length; r++) sheet.rows[r].push('');
    },
    findRowByValue_(sheet, field, val) {
      const h = sheet.rows[0], i = h.indexOf(field);
      if (i === -1) return null;
      for (let r = 1; r < sheet.rows.length; r++) {
        if (String(sheet.rows[r][i]) === String(val)) {
          const obj = {}; h.forEach((k, c) => obj[k] = sheet.rows[r][c]);
          obj._rowNum = r + 1; return obj;
        }
      }
      return null;
    },
    softSetCell_(sheet, rowNum, field, val) {
      let i = sheet.rows[0].indexOf(field);
      if (i === -1) { sheet.rows[0].push(field); for (let r=1;r<sheet.rows.length;r++) sheet.rows[r].push(''); i = sheet.rows[0].length-1; }
      sheet.rows[rowNum - 1][i] = val;
    },
    value_: (obj, f) => (obj && obj[f] != null ? obj[f] : ''),
    sheetToObjects_(sheet) {
      const h = sheet.rows[0];
      return { rows: sheet.rows.slice(1).map((r, idx) => {
        const o2 = {}; h.forEach((k, c) => o2[k] = r[c]); o2._rowNum = idx + 2; return o2;
      })};
    },
    getQuoteById_(id) {
      const h = quotes.rows[0], i = h.indexOf('quote_id');
      for (let r = 1; r < quotes.rows.length; r++) {
        if (String(quotes.rows[r][i]) === String(id)) {
          const obj = {}; h.forEach((k, c) => obj[k] = quotes.rows[r][c]);
          return { object: obj };
        }
      }
      return null;
    },
    commsOptOutSet_: () => (o.optOut || {}),
    commsSheetRows_: () => logRows,
    commsAppendRow_: (key, obj) => { logRows.push(Object.assign({}, obj)); return logRows.length; },
    commsUpdateRowById_: (key, idField, id, patch) => {
      const row = logRows.find(r => String(r[idField]) === String(id));
      if (row) Object.assign(row, patch);
      return !!row;
    },
    commsSendViaGmail_: (msg) => {
      if (o.sendThrows) throw new Error('Gmail quota exceeded');
      sent.push(msg);
      if (o.onSend) o.onSend(ctx, { approvals, logRows });
      return { ok: true };
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'Followups.js' });
  return { ctx, approvals, quotes, sent, get log() { return logRows; }, NOW, props };
}

const col = (sheet, field, rowNum = 2) => {
  const i = sheet.rows[0].indexOf(field);
  return i === -1 ? undefined : sheet.rows[rowNum - 1][i];
};

// Standard approval: sent N days ago, expires 30 days after sending.
const APPROVAL = (sentDaysAgo, now, over) => {
  const sentAt = now - sentDaysAgo * DAY;
  return Object.assign({
    id: 'A1', quote: 'Q1', token: 'tok1', status: 'SENT',
    sent_at: iso(sentAt), expires_at: iso(sentAt + 30 * DAY)
  }, over || {});
};
const rowOf = a => [a.id, 'P1', a.quote, a.token, a.status, '', a.sent_at, a.responded_at || '',
                    a.expires_at, '', '', a.followup_enabled || '', a.followup_schedule || '',
                    a.final_notice_lead_days || ''];

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };

// ── Schedule ────────────────────────────────────────────────────────────────
console.log('\nSchedule & milestones');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  [[2,0],[3,1],[7,1],[14,1],[20,1],[27,1]].forEach(([age, expectSend]) => {
    const s = build({ now: NOW, approvals: [rowOf(APPROVAL(age, NOW))] });
    const r = s.ctx.followupSweep_();
    t(`day ${age}: ${expectSend ? 'sends (latest due milestone)' : 'silent'}`, s.sent.length === expectSend,
      `(sent ${s.sent.length})`);
  });
}

console.log('\nFinal notice derives from real expiry, not a fixed day');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  // Resent on day 20 of the ORIGINAL window: sent_at reset, expiry 30d from resend.
  // A fixed "day 27" would fire 27 days after the RESEND — long past nothing.
  // Derived-from-expiry must fire 3 days before the real expires_at.
  const sentAt = NOW - 27 * DAY;
  const s = build({ now: NOW, approvals: [rowOf(APPROVAL(0, NOW, {
    sent_at: iso(sentAt), expires_at: iso(NOW + 3 * DAY)   // expires in exactly 3 days
  }))] });
  const r = s.ctx.followupSweep_();
  t('fires exactly at expiry − 3 days', s.sent.length === 1);
  t('copy names the deadline', s.sent.length && /expires/i.test(s.sent[0].subject),
    '(' + (s.sent[0] && s.sent[0].subject) + ')');

  const far = build({ now: NOW, approvals: [rowOf(APPROVAL(20, NOW, { expires_at: iso(NOW + 40 * DAY) }))] });
  far.ctx.followupSweep_();
  t('does NOT fire when expiry is far off', far.sent.filter(m => /expires/i.test(m.subject)).length === 0);
}

console.log('\nConfig defaults (empty-string coercion regression guard)');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const unset = build({ now: NOW, approvals: [] });
  t('FINAL_NOTICE_LEAD_DAYS defaults to 3 when unset',
    unset.ctx.fuFinalLeadDays_() === 3, '(got ' + unset.ctx.fuFinalLeadDays_() + ')');
  const set = build({ now: NOW, approvals: [], props: { FINAL_NOTICE_LEAD_DAYS: '5' } });
  t('and honours an explicit value', set.ctx.fuFinalLeadDays_() === 5);
  const junk = build({ now: NOW, approvals: [], props: { FINAL_NOTICE_LEAD_DAYS: 'abc' } });
  t('falls back on junk rather than 0', junk.ctx.fuFinalLeadDays_() === 3);
  const zero = build({ now: NOW, approvals: [], props: { FINAL_NOTICE_LEAD_DAYS: '0' } });
  t('refuses 0 (would fire at the moment of expiry, after the expired stop)',
    zero.ctx.fuFinalLeadDays_() === 3);
  const sched = build({ now: NOW, approvals: [] });
  t('FOLLOWUP_SCHEDULE defaults to 3/7/14',
    JSON.stringify(sched.ctx.fuSchedule_()) === '[3,7,14]');
}

console.log('\nSchedule length is not hard-coded');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW, props: { FOLLOWUP_SCHEDULE: '5' },
                    approvals: [rowOf(APPROVAL(6, NOW))] });
  s.ctx.followupSweep_();
  t('honours a 1-entry custom schedule', s.sent.length === 1);
  t('index advanced to 1', Number(col(s.approvals, 'followup_next_index')) === 1);
  const again = s.ctx.followupSweep_();
  t('exhausts after the custom schedule + final', s.sent.length === 1, `(sent ${s.sent.length})`);
}

console.log('\nPer-contract cadence overrides');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const disabled = build({ now: NOW, approvals: [rowOf(APPROVAL(20, NOW, {
    followup_enabled: 'FALSE'
  }))] });
  disabled.ctx.followupSweep_();
  t('disabled contract is skipped without sending', disabled.sent.length === 0);

  const custom = build({ now: NOW, approvals: [rowOf(APPROVAL(5, NOW, {
    followup_schedule: '5'
  }))] });
  custom.ctx.followupSweep_();
  t('row-level schedule can send on day 5', custom.sent.length === 1);

  const lead = build({ now: NOW, approvals: [rowOf(APPROVAL(0, NOW, {
    sent_at: iso(NOW - 20 * DAY),
    expires_at: iso(NOW + 5 * DAY),
    final_notice_lead_days: '5'
  }))] });
  lead.ctx.followupSweep_();
  t('row-level final notice lead is honoured', lead.sent.length === 1 && /expires/i.test(lead.sent[0].subject));
}

// ── Catch-up ────────────────────────────────────────────────────────────────
console.log('\nCatch-up: latest milestone only');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW, approvals: [rowOf(APPROVAL(26, NOW))] });
  s.ctx.followupSweep_();
  t('26-day-old approval gets ONE message, not a burst', s.sent.length === 1);
  t('and it is the day-14 one, not day-3',
    /still holding/i.test(s.sent[0].subject), '(' + s.sent[0].subject + ')');
  t('index jumped past the skipped milestones', Number(col(s.approvals, 'followup_next_index')) === 3);
  t('flagged as skipped_to_latest', col(s.approvals, 'last_followup_error') === 'skipped_to_latest');
  s.sent.length = 0;
  s.ctx.followupSweep_();
  t('day-7 is never re-sent afterwards', s.sent.length === 0);
}

console.log('\nCatch-up: FOLLOWUPS_START_AT');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW, props: { FOLLOWUPS_START_AT: '2026-08-01' },
                    approvals: [rowOf(APPROVAL(26, NOW))] });   // sent 2026-07-16
  s.ctx.followupSweep_();
  t('pre-rollout approval is not chased', s.sent.length === 0);
  t('marked pre_rollout', col(s.approvals, 'followup_stopped_reason') === 'pre_rollout');
}

// ── Stop reasons ────────────────────────────────────────────────────────────
console.log('\nStop reasons');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const cases = [
    ['approved',          { status: 'APPROVED' }],
    ['declined',          { status: 'DECLINED' }],
    ['changes_requested', { status: 'CHANGES_REQUESTED' }],
    ['expired',           { expires_at: iso(NOW - DAY) }]
  ];
  cases.forEach(([expected, over]) => {
    const s = build({ now: NOW, approvals: [rowOf(APPROVAL(5, NOW, over))] });
    s.ctx.followupSweep_();
    t(`${expected}`, col(s.approvals, 'followup_stopped_reason') === expected,
      `(got ${col(s.approvals, 'followup_stopped_reason')})`);
    t(`  └ and sends nothing`, s.sent.length === 0);
  });

  // update_requested is a dynamically added column (ActionQueue.js)
  let s = build({ now: NOW, approvals: [rowOf(APPROVAL(5, NOW))] });
  s.ctx.ensureColumn_(s.approvals, 'update_requested_at');
  s.ctx.softSetCell_(s.approvals, 2, 'update_requested_at', iso(NOW));
  s.ctx.followupSweep_();
  t('update_requested', col(s.approvals, 'followup_stopped_reason') === 'update_requested');

  s = build({ now: NOW, approvals: [rowOf(APPROVAL(5, NOW))],
              quotes: [['Q1','Jordan','Rivera','','Weekly']] });
  s.ctx.followupSweep_();
  t('no_email', col(s.approvals, 'followup_stopped_reason') === 'no_email');

  s = build({ now: NOW, approvals: [rowOf(APPROVAL(5, NOW))],
              quotes: [['Q1','Jordan','Rivera','not-an-email','Weekly']] });
  s.ctx.followupSweep_();
  t('invalid_email', col(s.approvals, 'followup_stopped_reason') === 'invalid_email');
  t('  └ malformed rows stop instead of churning forever', s.sent.length === 0);

  s = build({ now: NOW, approvals: [rowOf(APPROVAL(5, NOW))],
              optOut: { 'jordan@example.com': true } });
  s.ctx.followupSweep_();
  t('all_opt_out', col(s.approvals, 'followup_stopped_reason') === 'all_opt_out');

  // Marketing-only opt-out must NOT suppress: commsOptOutSet_('transactional')
  // returns {} because commsScopeBlocks_ filters marketing scopes out.
  s = build({ now: NOW, approvals: [rowOf(APPROVAL(5, NOW))], optOut: {} });
  s.ctx.followupSweep_();
  t('marketing-only opt-out still sends', s.sent.length === 1);

  // Exhaustion
  s = build({ now: NOW, approvals: [rowOf(APPROVAL(29, NOW))] });
  s.ctx.followupSweep_(); s.ctx.followupSweep_(); s.ctx.followupSweep_();
  s.ctx.followupSweep_(); s.ctx.followupSweep_();
  t('schedule_exhausted eventually', col(s.approvals, 'followup_stopped_reason') === 'schedule_exhausted',
    `(got ${col(s.approvals, 'followup_stopped_reason')})`);
}

// ── Concurrency & crash safety ──────────────────────────────────────────────
console.log('\nEligibility is strictly status === SENT');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  // The regression: fuStopReason_ used to return 'no_email' on a raw approval row
  // (approvals carry no email column), which the guard read as "worth processing".
  // Enrichment then cleared it and a non-SENT row reached the send path.
  ['DRAFT', '', 'PENDING', 'VOID'].forEach(st => {
    const s = build({ now: NOW, approvals: [rowOf(APPROVAL(5, NOW, { status: st }))] });
    s.ctx.followupSweep_();
    t(`status "${st || '(blank)'}" is never emailed`, s.sent.length === 0, `(sent ${s.sent.length})`);
  });
  const ok = build({ now: NOW, approvals: [rowOf(APPROVAL(5, NOW, { status: 'SENT' }))] });
  ok.ctx.followupSweep_();
  t('SENT still sends', ok.sent.length === 1);

  // responded_at set but status somehow still SENT -> treated as acted upon
  const resp = build({ now: NOW, approvals: [rowOf(APPROVAL(5, NOW, { responded_at: iso(NOW - DAY) }))] });
  resp.ctx.followupSweep_();
  t('responded_at alone stops it', resp.sent.length === 0 &&
    !!col(resp.approvals, 'followup_stopped_reason'));
}

console.log('\nRe-validation under the lock (state moved after the snapshot)');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  // Customer signs between the snapshot and the claim.
  const signs = build({ now: NOW, approvals: [rowOf(APPROVAL(3, NOW))] });
  const origFind = signs.ctx.findRowByValue_;
  let flipped = false;
  signs.ctx.findRowByValue_ = function (sheet, f, v) {
    const r = origFind(sheet, f, v);
    if (!flipped && f === 'approval_id') {         // first locked re-read
      flipped = true;
      signs.ctx.softSetCell_(sheet, 2, 'status', 'APPROVED');
      return origFind(sheet, f, v);
    }
    return r;
  };
  signs.ctx.followupSweep_();
  t('does not mail a customer who signed mid-sweep', signs.sent.length === 0);
  t('records the terminal reason instead',
    col(signs.approvals, 'followup_stopped_reason') === 'approved');

  // Agreement resent between snapshot and claim -> cycle no longer matches.
  const resent = build({ now: NOW, approvals: [rowOf(APPROVAL(3, NOW))] });
  const of2 = resent.ctx.findRowByValue_;
  let bumped = false;
  resent.ctx.findRowByValue_ = function (sheet, f, v) {
    if (!bumped && f === 'approval_id') {
      bumped = true;
      resent.ctx.ensureColumn_(sheet, 'followup_cycle');
      resent.ctx.softSetCell_(sheet, 2, 'followup_cycle', 9);
    }
    return of2(sheet, f, v);
  };
  resent.ctx.followupSweep_();
  t('aborts when the cycle changed under it', resent.sent.length === 0);
  t('and does not write an index from the stale cycle',
    Number(col(resent.approvals, 'followup_next_index') || 0) === 0);
}

console.log('\nRecipient + opt-out are re-resolved INSIDE the lock');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');

  // Helper: run something the first time the locked re-read happens.
  const onLockedRead = (s, fn) => {
    const orig = s.ctx.findRowByValue_;
    let fired = false;
    s.ctx.findRowByValue_ = function (sheet, f, v) {
      if (!fired && f === 'approval_id') { fired = true; fn(); }
      return orig(sheet, f, v);
    };
  };

  // 1. Customer opts out between the snapshot and the claim.
  const optOut = build({ now: NOW, approvals: [rowOf(APPROVAL(3, NOW))] });
  onLockedRead(optOut, () => {
    optOut.ctx.commsOptOutSet_ = () => ({ 'jordan@example.com': true });
  });
  optOut.ctx.followupSweep_();
  t('opt-out mid-sweep is honoured, not the stale snapshot', optOut.sent.length === 0,
    `(sent ${optOut.sent.length})`);
  t('recorded as all_opt_out', col(optOut.approvals, 'followup_stopped_reason') === 'all_opt_out');
  t('no ledger row written for a suppressed send', optOut.log.length === 0);

  // 2. Quote email is blanked between the snapshot and the claim.
  const blanked = build({ now: NOW, approvals: [rowOf(APPROVAL(3, NOW))] });
  onLockedRead(blanked, () => {
    blanked.ctx.softSetCell_(blanked.quotes, 2, 'email', '');
  });
  blanked.ctx.followupSweep_();
  t('blanked email mid-sweep does not send', blanked.sent.length === 0);
  t('recorded as no_email', col(blanked.approvals, 'followup_stopped_reason') === 'no_email');

  // 3. Quote email becomes malformed mid-sweep.
  const bad = build({ now: NOW, approvals: [rowOf(APPROVAL(3, NOW))] });
  onLockedRead(bad, () => {
    bad.ctx.softSetCell_(bad.quotes, 2, 'email', 'jordan@@broken');
  });
  bad.ctx.followupSweep_();
  t('malformed email mid-sweep does not send', bad.sent.length === 0);
  t('recorded as invalid_email', col(bad.approvals, 'followup_stopped_reason') === 'invalid_email');

  // 4. Email is CORRECTED mid-sweep — the fresh address must be used, not the old.
  const fixed = build({ now: NOW, approvals: [rowOf(APPROVAL(3, NOW))],
    quotes: [['Q1','Jordan','Rivera','old@example.com','Weekly Full Service']] });
  onLockedRead(fixed, () => {
    fixed.ctx.softSetCell_(fixed.quotes, 2, 'email', 'new@example.com');
  });
  fixed.ctx.followupSweep_();
  t('sends to the corrected address, not the snapshot one',
    fixed.sent.length === 1 && fixed.sent[0].to === 'new@example.com',
    `(to ${fixed.sent[0] && fixed.sent[0].to})`);
  t('ledger records the corrected address', fixed.log[0].email === 'new@example.com');
}

console.log('\nPer-run cap counts attempts, not successes');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const many = [];
  for (let i = 0; i < 40; i++) {
    many.push(['A' + i, 'P1', 'Q1', 'tok' + i, 'SENT', '',
               iso(NOW - 5 * DAY), '', iso(NOW + 25 * DAY), '', '']);
  }
  const s = build({ now: NOW, approvals: many, sendThrows: true });
  const r = s.ctx.followupSweep_();
  t('a Gmail outage cannot hammer every due row', r.attempted <= 25,
    `(attempted ${r.attempted} of 40 due)`);
  t('and the run reports attempts separately from sends', r.sent === 0 && r.attempted > 0);
}

console.log('\nGmail failure settles the ledger even if the lock is contended');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW, approvals: [rowOf(APPROVAL(3, NOW))], sendThrows: true });
  s.ctx.followupSweep_();
  t('ledger says failed, never left at sending', s.log[0].status === 'failed',
    `(got ${s.log[0].status})`);
  // A row left at 'sending' would later be read as unconfirmed and burn the touch.
  s.sent.length = 0;
  const s2 = build({ now: NOW, approvals: [rowOf(APPROVAL(3, NOW))],
    log: [{ recipient_id: 'followup:A1:c0:day3', status: 'failed',
            attempt_started_at: iso(NOW - 30 * 60000), attempt_count: 1 }] });
  s2.ctx.followupSweep_();
  t('a failed ledger row is retried, not skipped as unconfirmed', s2.sent.length === 1);
}

console.log('\nConcurrency: two sweeps must not both send');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  // Re-enter the sweep from inside the send — models sweep B starting while A is
  // mid-send, after A released the lock.
  const s = build({ now: NOW, approvals: [rowOf(APPROVAL(3, NOW))],
                    onSend: (ctx) => { if (!ctx.__reentered) { ctx.__reentered = true; ctx.followupSweep_(); } } });
  s.ctx.followupSweep_();
  t('exactly one send despite an overlapping sweep', s.sent.length === 1, `(sent ${s.sent.length})`);
  t('index advanced once', Number(col(s.approvals, 'followup_next_index')) === 1);
}

console.log('\nLate finalize must abort if the claim was lost');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW, approvals: [rowOf(APPROVAL(3, NOW))],
    onSend: (ctx, refs) => {
      // Simulate: our claim expired, another sweep re-claimed the row.
      ctx.softSetCell_(refs.approvals, 2, 'followup_claim_id', 'someone-else');
      ctx.softSetCell_(refs.approvals, 2, 'followup_claimed_until', iso(NOW + 5 * 60000));
    }});
  s.ctx.followupSweep_();
  t('does not clear the other sweep\'s claim', col(s.approvals, 'followup_claim_id') === 'someone-else');
  t('does not advance the index it no longer owns',
    Number(col(s.approvals, 'followup_next_index') || 0) === 0);
}

console.log('\nCrash after send: unconfirmed ledger row is not re-sent');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW, approvals: [rowOf(APPROVAL(3, NOW))],
    log: [{ recipient_id: 'followup:A1:c0:day3', status: 'sending',
            attempt_started_at: iso(NOW - 20 * 60000), attempt_count: 1 }] });
  s.ctx.followupSweep_();
  t('does NOT resend a possibly-delivered message', s.sent.length === 0);
  t('ledger marked unknown', s.log[0].status === 'unknown');
  t('index advanced past it', Number(col(s.approvals, 'followup_next_index')) === 1);
  t('reason recorded', col(s.approvals, 'last_followup_error') === 'unconfirmed_send');
}

console.log('\nIn-flight ledger row is left alone');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW, approvals: [rowOf(APPROVAL(3, NOW))],
    log: [{ recipient_id: 'followup:A1:c0:day3', status: 'sending',
            attempt_started_at: iso(NOW - 60000), attempt_count: 1 }] });
  s.ctx.followupSweep_();
  t('recent in-flight send is not duplicated', s.sent.length === 0);
  t('and not prematurely marked unknown', s.log[0].status === 'sending');
}

console.log('\nGmail failure');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW, approvals: [rowOf(APPROVAL(3, NOW))], sendThrows: true });
  s.ctx.followupSweep_();
  t('index NOT advanced (touch not burned)', Number(col(s.approvals, 'followup_next_index') || 0) === 0);
  t('error recorded', /Gmail quota/.test(String(col(s.approvals, 'last_followup_error'))));
  t('claim released', String(col(s.approvals, 'followup_claim_id') || '') === '');
  t('ledger marked failed', s.log[0].status === 'failed');
}

// ── Resend ──────────────────────────────────────────────────────────────────
console.log('\nResend resets the lifecycle');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW, approvals: [rowOf(APPROVAL(15, NOW))] });
  s.ctx.followupSweep_();
  const beforeIdx = Number(col(s.approvals, 'followup_next_index'));
  t('some follow-ups already sent', beforeIdx > 0 && s.sent.length === 1);

  // Simulate handleSendProposalForApproval_'s resend branch.
  s.ctx.fuResetLifecycleOnResend_(s.approvals, 2, col(s.approvals, 'followup_cycle'));
  s.ctx.softSetCell_(s.approvals, 2, 'sent_at', iso(NOW));
  s.ctx.softSetCell_(s.approvals, 2, 'expires_at', iso(NOW + 30 * DAY));

  t('cycle incremented', Number(col(s.approvals, 'followup_cycle')) === 1);
  t('index reset', Number(col(s.approvals, 'followup_next_index')) === 0);
  t('lifecycle fields cleared',
    !col(s.approvals, 'last_followup_at') && !col(s.approvals, 'last_followup_error') &&
    !col(s.approvals, 'followup_claim_id') && !col(s.approvals, 'followup_stopped_reason'));

  s.sent.length = 0;
  s.ctx.followupSweep_();
  t('schedule restarts (nothing due at day 0)', s.sent.length === 0);

  const s2 = build({ now: NOW + 3 * DAY, approvals: [rowOf(APPROVAL(0, NOW))],
                     log: [{ recipient_id: 'followup:A1:c0:day3', status: 'sent' }] });
  s2.ctx.ensureColumn_(s2.approvals, 'followup_cycle');
  s2.ctx.softSetCell_(s2.approvals, 2, 'followup_cycle', 1);
  s2.ctx.followupSweep_();
  t('cycle-1 ledger id does NOT collide with cycle-0 sent row', s2.sent.length === 1,
    '(a collision would suppress the resent chase)');
  t('new ledger row carries c1', s2.log.some(r => String(r.recipient_id).includes(':c1:')));
}

// ── Exhausted approval is chased again after a resend ───────────────────────
console.log('\nExhausted → resend → chased again');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW, approvals: [rowOf(APPROVAL(29, NOW))] });
  for (let i = 0; i < 6; i++) s.ctx.followupSweep_();
  t('reaches a terminal state', !!col(s.approvals, 'followup_stopped_reason'));
  s.ctx.fuResetLifecycleOnResend_(s.approvals, 2, col(s.approvals, 'followup_cycle'));
  s.ctx.softSetCell_(s.approvals, 2, 'sent_at', iso(NOW - 3 * DAY));
  s.ctx.softSetCell_(s.approvals, 2, 'expires_at', iso(NOW + 27 * DAY));
  s.sent.length = 0;
  s.ctx.followupSweep_();
  t('chased again after resend', s.sent.length === 1);
}

// ── Dry run must not mutate ─────────────────────────────────────────────────
console.log('\nDRY RUN mutates nothing');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW, props: { FOLLOWUPS_DRY_RUN: 'true' },
                    approvals: [rowOf(APPROVAL(3, NOW))] });
  const lifecycle = sh => ['followup_next_index','followup_cycle','last_followup_at',
    'last_followup_error','followup_claimed_until','followup_claim_id','followup_stopped_reason']
    .map(f => String(col(sh, f) ?? '')).join('|');
  const before = lifecycle(s.approvals);
  const colsBefore = s.approvals.rows[0].slice();
  const r = s.ctx.followupSweep_();
  t('reports what it would send', r.dry_run === true && r.planned.length === 1);
  t('names the recipient and milestone',
    r.planned[0].to === 'jordan@example.com' && r.planned[0].milestone === 'day3');
  t('sends nothing', s.sent.length === 0);
  t('writes NO Comms_Log row', s.log.length === 0);
  t('no index, no claim, no stop reason written', lifecycle(s.approvals) === before,
    '(' + lifecycle(s.approvals) + ')');
  t('does not migrate schema either (columns unchanged)',
    JSON.stringify(s.approvals.rows[0]) === JSON.stringify(colsBefore));

  // A stop condition must also not be written in dry run.
  const s2 = build({ now: NOW, props: { FOLLOWUPS_DRY_RUN: 'true' },
                     approvals: [rowOf(APPROVAL(5, NOW, { status: 'APPROVED' }))] });
  const b2 = lifecycle(s2.approvals);
  s2.ctx.followupSweep_();
  t('does not write stop reasons either', lifecycle(s2.approvals) === b2,
    '(' + lifecycle(s2.approvals) + ')');
}

console.log('\nMaster switch');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW, props: { FOLLOWUPS_ENABLED: 'false' },
                    approvals: [rowOf(APPROVAL(3, NOW))] });
  const before = JSON.stringify(s.approvals.rows);
  const r = s.ctx.followupSweep_();
  t('FOLLOWUPS_ENABLED off = complete no-op', s.sent.length === 0 && !!r.skipped);
  t('and touches nothing at all (not even schema)', JSON.stringify(s.approvals.rows) === before);
}

// ── Copy ────────────────────────────────────────────────────────────────────
console.log('\nEmail copy');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW, approvals: [rowOf(APPROVAL(3, NOW))] });
  s.ctx.followupSweep_();
  const m = s.sent[0];
  t('has subject, html and plain text', !!m.subject && !!m.htmlBody && !!m.plainBody);
  t('links to the signing page with the token', m.htmlBody.includes('token=tok1'));
  t('addresses them by name', m.htmlBody.includes('Jordan'));
  t('never restates pricing', !/\$\d/.test(m.htmlBody));

  // Amendment approvals get different wording.
  const a = build({ now: NOW, approvals: [rowOf(APPROVAL(3, NOW))] });
  a.ctx.ensureColumn_(a.approvals, 'target_agreement_id');
  a.ctx.softSetCell_(a.approvals, 2, 'target_agreement_id', 'AG-9');
  a.ctx.followupSweep_();
  t('amendment uses plan-change wording', /plan change/i.test(a.sent[0].subject),
    '(' + a.sent[0].subject + ')');
  t('and never new-customer wording', !/agreement came through/i.test(a.sent[0].subject));
  t('reassures nothing changes until signed', /nothing changes until you sign/i.test(a.sent[0].plainBody));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
