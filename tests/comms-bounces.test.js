// Bounce handling — parsing, suppression, and the rules that must not bend.
//
//   node tests/comms-bounces.test.js
//
// On Gmail nothing tells the portal an address is dead, so this is the only thing
// standing between a cold list and mailing the same dead addresses every campaign
// — with the failures landing on the same Workspace domain that sends agreements.
//
// Three rules are load-bearing:
//   1. A soft failure must NOT suppress on first sight. A full mailbox on a
//      Tuesday should not cost you a customer's address permanently.
//   2. An out-of-office reply is not a bounce.
//   3. A hard bounce cannot be un-suppressed from the UI. The address is gone;
//      "Remove" could only achieve mailing it again forever.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const COMMS_SRC = path.join(ROOT, 'appscript', 'Comms.js');
const BOUNCE_SRC = path.join(ROOT, 'appscript', 'CommsBounces.js');

let pass = 0, fail = 0;
function t(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail ? '  ' + detail : '')); }
}

// ─── Real-world bounce bodies ────────────────────────────────────────────────
const DSN_HARD = `Delivery to the following recipient failed permanently:

     gone@example.com

----- Original message -----
Reporting-MTA: dns; mail.mcpoolsolutions.org
Final-Recipient: rfc822; gone@example.com
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.`;

const DSN_SOFT = `Final-Recipient: rfc822; full@example.com
Action: delayed
Status: 4.2.2
Diagnostic-Code: smtp; 452 4.2.2 The email account that you tried to reach is over quota.`;

const GMAIL_PROSE = `Address not found

Your message wasn't delivered to typo@exmaple.com because the address couldn't be
found, or is unable to receive mail.

The response was:
550 5.1.1 The email account that you tried to reach does not exist.`;

const OOO = `Subject: Automatic reply: Your pool service
I am out of the office until Monday and will reply on my return.`;

const BLOCKED = `Final-Recipient: rfc822; blocked@example.com
Action: failed
Status: 5.7.1
Diagnostic-Code: smtp; 550 5.7.1 Message rejected due to policy.`;

function build(props = {}, sheetRows = {}) {
  const appended = [];
  const optouts = [];
  const patched = [];
  const ctx = {
    console, JSON, Math, String, Number, Array, Object, RegExp, Date, isNaN, encodeURIComponent,
    Logger: { log: () => {} },
    Utilities: { getUuid: (() => { let n = 0; return () => 'b' + (++n); })(),
                 formatDate: (d, tz, f) => new Date(d).toISOString(),
                 computeHmacSha256Signature: () => [1, 2, 3] },
    SpreadsheetApp: { getActiveSpreadsheet: () => null, openById: () => null },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyHours: () => ({ create: () => {} }), after: () => ({ create: () => {} }) }) }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'portal@mcpoolsolutions.org' }),
               getActiveUser: () => ({ getEmail: () => '' }) },
    MailApp: { getRemainingDailyQuota: () => 1500 },
    GmailApp: { getAliases: () => [], sendEmail: () => {},
                getUserLabelByName: () => ({ getThreads: () => [] }), createLabel: () => ({}),
                search: () => [] },
    UrlFetchApp: { fetch: () => { throw new Error('no network'); } },
    huHeader_: h => String(h == null ? '' : h).trim().toLowerCase().replace(/ /g, '_'),
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (props[k] === undefined ? null : props[k]),
      setProperty: () => {}, deleteProperty: () => {} }) }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(COMMS_SRC, 'utf8'), ctx, { filename: 'Comms.js' });
  vm.runInContext(fs.readFileSync(BOUNCE_SRC, 'utf8'), ctx, { filename: 'CommsBounces.js' });

  ctx.commsEnsureSheets_ = () => {};
  ctx.commsSheetRows_ = k => (sheetRows[k] || []);
  ctx.commsAppendRows_ = (k, rows) => { appended.push({ k, rows }); return rows.length; };
  ctx.commsAppendRow_ = (k, row) => { appended.push({ k, rows: [row] }); return 2; };
  ctx.commsSheet_ = () => ({ getLastRow: () => 1, getDataRange: () => ({ getValues: () => [[]] }) });
  ctx.commsActualHeaders_ = () => [];
  ctx.commsPatchRow_ = (sheet, headers, row, patch) => { patched.push({ row, patch }); };
  ctx.commsUpsertOptOut_ = (email, scope, source) => { optouts.push({ email, scope, source }); };
  return { ctx, appended, optouts, patched };
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nParsing real bounce formats');
{
  const { ctx } = build();
  const p = (b, s) => ctx.cbParseBounce_(b, s);

  const hard = p(DSN_HARD);
  t('a DSN hard bounce yields the address', hard.email === 'gone@example.com', hard.email);
  t('and is classified permanent', hard.kind === 'hard');
  t('and keeps the enhanced status code', hard.code === '5.1.1', hard.code);
  t('and records the diagnostic for the audit trail',
    /does not exist/.test(hard.reason), hard.reason);

  const soft = p(DSN_SOFT);
  t('an over-quota bounce is soft', soft.kind === 'soft' && soft.code === '4.2.2');
  t('and still yields the address', soft.email === 'full@example.com');

  // The prose form has no DSN fields at all.
  const prose = p(GMAIL_PROSE);
  t("Gmail's prose form still yields the address", prose.email === 'typo@exmaple.com', prose.email);
  t('and is read as permanent from the SMTP reply', prose.kind === 'hard', prose.kind + '/' + prose.code);

  const pol = p(BLOCKED);
  t('a policy rejection is permanent', pol.kind === 'hard' && pol.code === '5.7.1');

  // Garbage must degrade, not throw or invent an address.
  t('an unparseable body yields no address', p('some unrelated text').email === '');
  t('and is marked unknown rather than guessed', p('some unrelated text').kind === 'unknown');
  t('an empty body is safe', p('').email === '' && p(null).kind === 'unknown');
  t('a malformed address is rejected',
    p('Final-Recipient: rfc822; not-an-address').email === '');
}

console.log('\nWhat must never be treated as a bounce');
{
  const { ctx } = build();
  t('an out-of-office reply is not a bounce', ctx.cbLooksLikeAutoReply_('Automatic reply: hi', OOO) === true);
  t('a real DSN is never mistaken for an auto-reply',
    ctx.cbLooksLikeAutoReply_('Delivery Status Notification (Failure)', DSN_HARD) === false);
  // A vacation responder that happens to quote the words must still not win over
  // actual DSN fields.
  t('DSN fields beat auto-reply wording',
    ctx.cbLooksLikeAutoReply_('Automatic reply', DSN_HARD + '\nout of office') === false);

  t('our own sending address is never suppressed',
    ctx.cbIsOwnAddress_('portal@mcpoolsolutions.org') === true);
  t('mailer-daemon is never suppressed', ctx.cbIsOwnAddress_('mailer-daemon@googlemail.com') === true);
  t('a no-reply address is never suppressed', ctx.cbIsOwnAddress_('no-reply@example.com') === true);
  t('a blank address is never suppressed', ctx.cbIsOwnAddress_('') === true);
  t('a customer address is fair game', ctx.cbIsOwnAddress_('gone@example.com') === false);

  const { ctx: c2 } = build({ COMMS_RESEND_FROM: 'MCPS <hello@mcpoolsolutions.org>' });
  t('the configured From address is protected too',
    c2.cbIsOwnAddress_('hello@mcpoolsolutions.org') === true);
}

console.log('\nSuppression: hard immediately, soft only when it repeats');
{
  const hardRow = { email: 'gone@example.com', kind: 'hard' };
  const softRow = { email: 'full@example.com', kind: 'soft' };
  const now = new Date().toISOString();

  const a = build({}, { bounces: [] });
  t('a hard bounce suppresses at once',
    a.ctx.cbApplySuppressions_([hardRow]) === 1 && a.optouts[0].email === 'gone@example.com');
  t('and is recorded as a bounce, not a preference', a.optouts[0].source === 'bounce_hard');
  t('with scope all — a dead address is dead for every category', a.optouts[0].scope === 'all');

  // One soft failure is normal operations, not a decision.
  const b = build({}, { bounces: [{ email: 'full@example.com', kind: 'soft', detected_at: now }] });
  t('a single soft bounce does NOT suppress', b.ctx.cbApplySuppressions_([softRow]) === 0);
  t('and writes no opt-out at all', b.optouts.length === 0);

  const c = build({}, { bounces: [
    { email: 'full@example.com', kind: 'soft', detected_at: now },
    { email: 'full@example.com', kind: 'soft', detected_at: now },
    { email: 'full@example.com', kind: 'soft', detected_at: now }
  ] });
  t('three soft bounces do suppress', c.ctx.cbApplySuppressions_([softRow]) === 1);
  t('recorded distinguishably from a hard failure',
    c.optouts[0].source === 'bounce_soft_repeated');

  // Old soft failures must age out, or an address accrues a life sentence.
  const old = new Date(Date.now() - 400 * 86400000).toISOString();
  const d = build({}, { bounces: [
    { email: 'full@example.com', kind: 'soft', detected_at: old },
    { email: 'full@example.com', kind: 'soft', detected_at: old },
    { email: 'full@example.com', kind: 'soft', detected_at: old }
  ] });
  t('soft bounces older than the window do not count', d.ctx.cbApplySuppressions_([softRow]) === 0);

  const e = build({}, { bounces: [] });
  t('an unparsed bounce suppresses nobody',
    e.ctx.cbApplySuppressions_([{ email: '', kind: 'unknown' }]) === 0);
  t('the same address twice in one run suppresses once',
    build({}, { bounces: [] }).ctx.cbApplySuppressions_([hardRow, hardRow]) === 1);
}

console.log('\nA bounced address cannot be clicked back into the audience');
{
  const { ctx } = build();
  t('a bounce source is a suppression', ctx.commsIsSuppression_('bounce_hard') === true);
  t('a repeated soft bounce is too', ctx.commsIsSuppression_('bounce_soft_repeated') === true);
  t('a link unsubscribe is NOT a suppression', ctx.commsIsSuppression_('link') === false);
  t('a manual opt-out is NOT a suppression', ctx.commsIsSuppression_('manual') === false);

  // Removing a hard bounce must be refused, with a reason.
  const sup = build({}, { optouts: [{ _row: 2, email: 'gone@example.com', source: 'bounce_hard' }] });
  const blocked = sup.ctx.handleCommsRemoveOptout_({ email: 'gone@example.com' });
  t('removing a bounced address is refused', blocked.ok === false);
  t('and says why', /bounced/i.test(blocked.error), blocked.error);
  t('and nothing is written', sup.patched.length === 0);

  // A human's own opt-out can still be lifted — tombstoned, never deleted.
  const man = build({}, { optouts: [{ _row: 2, email: 'person@example.com', source: 'manual' }] });
  const ok = man.ctx.handleCommsRemoveOptout_({ email: 'person@example.com', removed_by: 'Mau' });
  t('a manual opt-out can be removed', ok.ok === true);
  t('by tombstoning rather than deleting', man.patched.length === 1 && !!man.patched[0].patch.removed_at);
  t('recording who lifted it', man.patched[0].patch.removed_by === 'Mau');

  // An already-tombstoned row is not found again.
  const gone = build({}, { optouts: [{ _row: 2, email: 'x@example.com', source: 'manual', removed_at: '2026-01-01' }] });
  t('an already-removed opt-out reports not found',
    gone.ctx.handleCommsRemoveOptout_({ email: 'x@example.com' }).ok === false);
}


console.log('\nA lifted opt-out actually stops blocking');
{
  // commsOptOutSet_ reads the sheet directly rather than through commsSheetRows_,
  // so it gets its own fixture. This is the case that matters: tombstoning without
  // teaching the resolver about it would leave "Remove" agreeing with the user
  // while the system quietly kept suppressing.
  function withOptoutSheet(rows) {
    const H = ['email', 'scope', 'opted_out_at', 'source', 'recipient_id', 'removed_at', 'removed_by'];
    const { ctx } = build();
    ctx.commsSheet_ = () => ({
      getLastRow: () => rows.length + 1,
      getDataRange: () => ({ getValues: () => [H].concat(rows) })
    });
    return ctx;
  }

  const live = withOptoutSheet([['blocked@x.com', 'all', '', 'manual', '', '', '']]);
  t('a live opt-out blocks', live.commsOptOutSet_('marketing')['blocked@x.com'] === true);

  const lifted = withOptoutSheet([['blocked@x.com', 'all', '', 'manual', '', '2026-08-26T00:00:00Z', 'Mau']]);
  t('a tombstoned opt-out no longer blocks',
    lifted.commsOptOutSet_('marketing')['blocked@x.com'] === undefined);

  // Scope semantics must survive the change.
  const scoped = withOptoutSheet([['m@x.com', 'marketing_announcements', '', 'link', '', '', '']]);
  t('a marketing-scoped opt-out still blocks marketing',
    scoped.commsOptOutSet_('marketing')['m@x.com'] === true);
  t('but never blocks a service update',
    scoped.commsOptOutSet_('service_update')['m@x.com'] === undefined);

  // And a bounce keeps blocking everything, including operational mail — the
  // address does not exist, so there is nothing to deliver either way.
  const bounced = withOptoutSheet([['gone@x.com', 'all', '', 'bounce_hard', '', '', '']]);
  t('a bounce blocks service updates too',
    bounced.commsOptOutSet_('service_update')['gone@x.com'] === true);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
