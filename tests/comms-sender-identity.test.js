// Sender identity diagnostic regression suite.
//
//   node tests/comms-sender-identity.test.js
//
// commsSenderIdentity_() exists to answer one question before a customer
// campaign goes out: WHICH Gmail account actually sends? Two properties make it
// trustworthy, and both are asserted here:
//
//   1. It sends nothing. A diagnostic that mails while reporting is useless for
//      auditing a live sender, so every stub that could send is a tripwire.
//   2. It never throws. Each probe sits behind its own try/catch, because the
//      interesting cases ARE the failures — GmailApp.getAliases() throwing on a
//      missing Gmail scope is the signal that the send-as-alias route needs a
//      re-authorization, not a reason to lose the rest of the report.
//
// The load-bearing inference under test: ScriptApp.getProjectTriggers() only
// returns triggers owned by the EFFECTIVE user, so an invisible sweep guard
// means another account owns the sweeper and sends the queued remainder of every
// campaign from its own mailbox and quota.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const COMMS_SRC = path.join(__dirname, '..', 'appscript', 'Comms.js');

let pass = 0;
let fail = 0;
function t(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log('  ok - ' + name);
  } else {
    fail += 1;
    console.log('  FAIL - ' + name + (detail ? ' ' + detail : ''));
  }
}

function trigger(handler, uid) {
  return {
    getHandlerFunction: () => handler,
    getUniqueId: () => uid,
    getEventType: () => 'CLOCK'
  };
}

// opts: { effectiveUser, activeUser, triggers, aliases, quota, props }
function build(opts = {}) {
  const sent = [];
  const throwIfSent = name => (...args) => { sent.push({ via: name, args }); };

  const ctx = {
    console,
    String, Number, Math, JSON, Array, Object, RegExp, Set, Date,
    isNaN, encodeURIComponent,
    Logger: { log: () => {} },
    Utilities: { getUuid: () => 'uuid-1', formatDate: d => new Date(d).toISOString() },
    SpreadsheetApp: { getActiveSpreadsheet: () => null, openById: () => null },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    CacheService: { getScriptCache: () => ({ remove: () => {}, removeAll: () => {} }) },
    UrlFetchApp: { fetch: throwIfSent('UrlFetchApp') },
    huHeader_: h => String(h == null ? '' : h).trim().toLowerCase().replace(/ /g, '_'),

    Session: {
      getEffectiveUser: () => {
        if (opts.effectiveUserThrows) throw new Error('no effective user');
        return { getEmail: () => opts.effectiveUser || 'deployer@mcpoolsolutions.org' };
      },
      getActiveUser: () => {
        if (opts.activeUserThrows) throw new Error('anonymous access');
        return { getEmail: () => (opts.activeUser === undefined ? '' : opts.activeUser) };
      },
      getScriptTimeZone: () => 'America/Chicago'
    },
    MailApp: {
      getRemainingDailyQuota: () => {
        if (opts.quotaThrows) throw new Error('quota unavailable');
        return opts.quota === undefined ? 1487 : opts.quota;
      },
      sendEmail: throwIfSent('MailApp.sendEmail')
    },
    GmailApp: {
      getAliases: () => {
        if (opts.aliasesThrow) throw new Error('missing gmail.settings.basic scope');
        return opts.aliases || [];
      },
      sendEmail: throwIfSent('GmailApp.sendEmail')
    },
    ScriptApp: {
      getProjectTriggers: () => {
        if (opts.triggersThrow) throw new Error('trigger read failed');
        return opts.triggers || [];
      },
      newTrigger: () => { throw new Error('diagnostic must not install triggers'); },
      deleteTrigger: () => { throw new Error('diagnostic must not delete triggers'); }
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: k => (opts.props || {})[k] || '' })
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(COMMS_SRC, 'utf8'), ctx, { filename: 'Comms.js' });
  return { ctx, sent };
}

console.log('\nSender identity — the reported account');
{
  const { ctx, sent } = build({ effectiveUser: 'portal@mcpoolsolutions.org' });
  const info = ctx.commsSenderIdentity_();
  t('reports the effective user as the sending account',
    info.effective_user === 'portal@mcpoolsolutions.org', '→ ' + info.effective_user);
  t('sends nothing at all', sent.length === 0, '→ ' + JSON.stringify(sent));
  t('send_mode defaults to gmail when the property is unset',
    info.send_mode === 'gmail', '→ ' + info.send_mode);
  t('surfaces the per-account remaining quota',
    info.gmail_remaining_quota === 1487, '→ ' + info.gmail_remaining_quota);
}

{
  const { ctx } = build({ props: { COMMS_SEND_MODE: 'resend' } });
  t('reports a non-default send mode verbatim',
    ctx.commsSenderIdentity_().send_mode === 'resend');
}

console.log('\nAnonymous web-app access');
{
  // executeAs=USER_DEPLOYING + access=ANYONE_ANONYMOUS: the caller's Google
  // identity never reaches the send path, so active_user is expected to be blank
  // while effective_user still names the real sender.
  const { ctx } = build({ activeUser: '', effectiveUser: 'deployer@mcpoolsolutions.org' });
  const info = ctx.commsSenderIdentity_();
  t('blank active user does not blank the effective user',
    info.active_user === '' && info.effective_user === 'deployer@mcpoolsolutions.org');
}

{
  const { ctx } = build({ activeUserThrows: true });
  let threw = false;
  let info = null;
  try { info = ctx.commsSenderIdentity_(); } catch (e) { threw = true; }
  t('an active-user permission error is swallowed, not thrown', !threw);
  t('and the effective user still reports',
    !!info && info.effective_user === 'deployer@mcpoolsolutions.org');
}

console.log('\nTrigger ownership — the split-sender inference');
{
  const { ctx } = build({
    effectiveUser: 'deployer@mcpoolsolutions.org',
    triggers: [trigger('commsSweepGuard_', 'g1'), trigger('commsSweep_', 's1')]
  });
  const info = ctx.commsSenderIdentity_();
  t('sees the guard trigger when this account owns it', info.guard_trigger_visible === true);
  t('lists both comms triggers', info.sweep_triggers_visible.length === 2);
  t('interpretation names this account as the campaign sender',
    info.interpretation.indexOf('deployer@mcpoolsolutions.org') !== -1
    && info.interpretation.indexOf('owns the hourly sweep guard') !== -1,
    '→ ' + info.interpretation);
}

{
  // The dangerous state: no guard visible to this account. Either it was never
  // installed, or — the case worth catching — another account owns it.
  const { ctx } = build({ effectiveUser: 'deployer@mcpoolsolutions.org', triggers: [] });
  const info = ctx.commsSenderIdentity_();
  t('no guard visible → guard_trigger_visible is false', info.guard_trigger_visible === false);
  t('and the interpretation warns another account may own the sweeper',
    info.interpretation.indexOf('another account owns the sweeper') !== -1,
    '→ ' + info.interpretation);
}

{
  // A lone commsSweep_ trigger is not a guard: reporting it as one would hide
  // exactly the case this diagnostic exists to find.
  const { ctx } = build({ triggers: [trigger('commsSweep_', 's1')] });
  const info = ctx.commsSenderIdentity_();
  t('a commsSweep_ trigger alone does not count as the guard',
    info.guard_trigger_visible === false && info.sweep_triggers_visible.length === 1);
}

{
  const { ctx } = build({
    triggers: [trigger('followupsSweep_', 'f1'), trigger('onOpen', 'o1'), trigger('commsSweepGuard_', 'g1')]
  });
  const info = ctx.commsSenderIdentity_();
  t('ignores triggers belonging to other subsystems',
    info.sweep_triggers_visible.length === 1
    && info.sweep_triggers_visible[0].handler === 'commsSweepGuard_');
}

{
  const { ctx } = build({ triggersThrow: true });
  let threw = false;
  let info = null;
  try { info = ctx.commsSenderIdentity_(); } catch (e) { threw = true; }
  t('a trigger-read failure is captured, not thrown', !threw);
  t('and is reported rather than silently read as "no triggers"',
    !!info && info.triggers_error.indexOf('trigger read failed') !== -1);
}

console.log('\nSend-as aliases — pricing the visible-staff-sender option');
{
  const { ctx } = build({ aliases: ['tony@mcpoolsolutions.org', 'service@mcpoolsolutions.org'] });
  const info = ctx.commsSenderIdentity_();
  t('reports the aliases GmailApp would accept as a `from`',
    info.gmail_aliases.length === 2 && info.gmail_aliases[0] === 'tony@mcpoolsolutions.org');
  t('no alias error when the scope is present', info.gmail_aliases_error === '');
}

{
  // The manifest currently carries gmail.send but not gmail.settings.basic, so
  // this is the likely real-world outcome — and it must not cost us the report.
  const { ctx } = build({ aliasesThrow: true, triggers: [trigger('commsSweepGuard_', 'g1')] });
  let threw = false;
  let info = null;
  try { info = ctx.commsSenderIdentity_(); } catch (e) { threw = true; }
  t('a missing Gmail scope does not throw', !threw);
  t('the scope error is reported', !!info && info.gmail_aliases_error.indexOf('scope') !== -1);
  t('and the rest of the report survives it',
    !!info && info.guard_trigger_visible === true && !!info.effective_user);
}

console.log('\nQuota probe');
{
  const { ctx } = build({ quotaThrows: true });
  const info = ctx.commsSenderIdentity_();
  t('an unavailable quota reports -1 instead of throwing', info.gmail_remaining_quota === -1);
}

console.log('\ndoPost action wrapper');
{
  const { ctx, sent } = build({ effectiveUser: 'deployer@mcpoolsolutions.org' });
  const info = ctx.handleCommsSenderIdentity_({ username: 'tony', email: 'tony@mcpoolsolutions.org' });
  t('marks the response ok', info.ok === true);
  t('records who asked, separately from who sends',
    info.requested_by === 'tony'
    && info.requested_by_email === 'tony@mcpoolsolutions.org'
    && info.effective_user === 'deployer@mcpoolsolutions.org');
  t('the action sends nothing either', sent.length === 0);
}

{
  const { ctx } = build();
  const info = ctx.handleCommsSenderIdentity_(null);
  t('a missing auth object does not throw', info.ok === true && info.requested_by === '');
}

console.log('\nRouter wiring');
{
  const src = fs.readFileSync(COMMS_SRC, 'utf8');
  t('comms_sender_identity is routed in handleCommsAction_',
    /case 'comms_sender_identity':\s*return handleCommsSenderIdentity_\(auth\);/.test(src));
  t('the action keeps the comms_ prefix that carries the admin gate',
    src.indexOf("'comms_sender_identity'") !== -1);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
