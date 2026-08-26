// Sweep-guard ownership arbitration suite.
//
//   node tests/comms-guard-ownership.test.js
//
// The hourly commsSweepGuard_ trigger decides which Gmail account drains the
// campaign queue, and therefore which account customer email is sent from.
//
// The bug this suite locks down: ScriptApp.getProjectTriggers() returns ONLY the
// effective user's own triggers, so the old "is a guard installed?" check
// answered "no" whenever a different account asked, and installed a second guard.
// Both then fired hourly as their own owners, making the From address a function
// of trigger firing order. Neither account can see or delete the other's, so the
// state was also invisible and unfixable from inside the script.
//
// Ownership now lives in script properties, which ARE shared across accounts. The
// tests that matter most:
//   - a second account must NOT install a duplicate while the owner is alive
//   - a genuinely dead owner MUST be takeable, or the queue stalls forever
//   - an unreadable trigger list must install nothing, rather than guess
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const COMMS_SRC = path.join(__dirname, '..', 'appscript', 'Comms.js');
const NOW = Date.parse('2026-08-17T15:00:00Z');
const HOUR = 3600000;

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

class FrozenDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(NOW);
    else super(...args);
  }
  static now() { return NOW; }
  static parse(s) { return Date.parse(s); }
}

function trigger(handler) {
  return {
    getHandlerFunction: () => handler,
    getUniqueId: () => handler + '-uid',
    getEventType: () => 'CLOCK'
  };
}

// opts: { me, props, triggers, triggersThrow }
function build(opts = {}) {
  const props = Object.assign({}, opts.props || {});
  const installed = [];
  const deleted = [];

  const ctx = {
    console,
    String, Number, Math, JSON, Array, Object, RegExp, Set, Date: FrozenDate,
    isNaN, encodeURIComponent,
    Logger: { log: () => {} },
    Utilities: { getUuid: () => 'uuid-1', formatDate: d => new Date(d).toISOString() },
    SpreadsheetApp: { getActiveSpreadsheet: () => null, openById: () => null },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    CacheService: { getScriptCache: () => ({ remove: () => {}, removeAll: () => {} }) },
    UrlFetchApp: { fetch: () => { throw new Error('no network in this suite'); } },
    MailApp: { getRemainingDailyQuota: () => 1500, sendEmail: () => { throw new Error('must not send'); } },
    GmailApp: { getAliases: () => [], sendEmail: () => { throw new Error('must not send'); } },
    huHeader_: h => String(h == null ? '' : h).trim().toLowerCase().replace(/ /g, '_'),

    Session: {
      getEffectiveUser: () => ({ getEmail: () => (opts.me === undefined ? 'mau@mcpoolsolutions.org' : opts.me) }),
      getActiveUser: () => ({ getEmail: () => '' }),
      getScriptTimeZone: () => 'America/Chicago'
    },
    ScriptApp: {
      getProjectTriggers: () => {
        if (opts.triggersThrow) throw new Error('trigger read failed');
        return (opts.triggers || []).map(trigger);
      },
      newTrigger: handler => ({
        timeBased: () => ({
          everyHours: n => ({ create: () => { installed.push({ handler, everyHours: n }); } }),
          after: () => ({ create: () => { installed.push({ handler, after: true }); } }),
          at: () => ({ create: () => { installed.push({ handler, at: true }); } })
        })
      }),
      deleteTrigger: tr => { deleted.push(tr.getHandlerFunction()); }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (props[k] === undefined ? null : props[k]),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: k => { delete props[k]; }
      })
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(COMMS_SRC, 'utf8'), ctx, { filename: 'Comms.js' });
  return { ctx, props, installed, deleted };
}

const OWNER = 'COMMS_GUARD_OWNER';
const BEAT = 'COMMS_GUARD_LAST_BEAT';
const CONFLICT = 'COMMS_GUARD_CONFLICT';
const iso = ms => new Date(ms).toISOString();

console.log('\nFirst install on a fresh project');
{
  const { ctx, props, installed } = build({ me: 'mau@mcpoolsolutions.org', triggers: [] });
  ctx.commsEnsureGuardTrigger_();
  t('installs exactly one hourly guard',
    installed.length === 1 && installed[0].handler === 'commsSweepGuard_' && installed[0].everyHours === 1,
    '→ ' + JSON.stringify(installed));
  t('records the installing account as owner', props[OWNER] === 'mau@mcpoolsolutions.org');
  t('stamps a beat on claim, so a new guard is not read as abandoned',
    props[BEAT] === iso(NOW));
}

console.log('\nSame account, repeat calls');
{
  const { ctx, installed } = build({
    me: 'mau@mcpoolsolutions.org',
    triggers: ['commsSweepGuard_'],
    props: { [OWNER]: 'mau@mcpoolsolutions.org', [BEAT]: iso(NOW - HOUR) }
  });
  ctx.commsEnsureGuardTrigger_();
  ctx.commsEnsureGuardTrigger_();
  t('never installs a second guard for the owner', installed.length === 0);
}

{
  // A guard installed before ownership was tracked: adopt it, do not duplicate.
  const { ctx, props, installed } = build({
    me: 'mau@mcpoolsolutions.org', triggers: ['commsSweepGuard_'], props: {}
  });
  ctx.commsEnsureGuardTrigger_();
  t('adopts an untracked existing guard without installing another',
    installed.length === 0 && props[OWNER] === 'mau@mcpoolsolutions.org');
}

{
  const { ctx, installed } = build({
    me: 'mau@mcpoolsolutions.org', triggers: [],
    props: { [OWNER]: 'mau@mcpoolsolutions.org', [BEAT]: iso(NOW - HOUR) }
  });
  ctx.commsEnsureGuardTrigger_();
  t('reinstalls when the owner\'s own guard went missing', installed.length === 1);
}

console.log('\nA second account arrives — THE REGRESSION');
{
  // Tony's execution cannot see Mau's guard. The old code installed a duplicate
  // here, and from then on the sender depended on which trigger fired first.
  const { ctx, props, installed } = build({
    me: 'tony@mcpoolsolutions.org',
    triggers: [], // invisible: owned by mau
    props: { [OWNER]: 'mau@mcpoolsolutions.org', [BEAT]: iso(NOW - 30 * 60000) }
  });
  ctx.commsEnsureGuardTrigger_();
  t('does NOT install a duplicate guard while the owner is beating',
    installed.length === 0, '→ ' + JSON.stringify(installed));
  t('leaves ownership with the live owner', props[OWNER] === 'mau@mcpoolsolutions.org');
  t('does not steal the heartbeat', props[BEAT] === iso(NOW - 30 * 60000));
}

{
  // Right at the edge: an hourly guard that beat 2h ago is late but not dead.
  const { ctx, installed } = build({
    me: 'tony@mcpoolsolutions.org', triggers: [],
    props: { [OWNER]: 'mau@mcpoolsolutions.org', [BEAT]: iso(NOW - 2 * HOUR) }
  });
  ctx.commsEnsureGuardTrigger_();
  t('a merely-late owner is still not displaced', installed.length === 0);
}

console.log('\nAbandoned owner must be takeable');
{
  // Owner suspended or departed. Standing down forever would stall every queued
  // campaign, which is worse than a dormant duplicate we cannot delete.
  const { ctx, props, installed } = build({
    me: 'tony@mcpoolsolutions.org', triggers: [],
    props: { [OWNER]: 'gone@mcpoolsolutions.org', [BEAT]: iso(NOW - 4 * HOUR) }
  });
  ctx.commsEnsureGuardTrigger_();
  t('takes over after 3h of silence', installed.length === 1);
  t('and becomes the recorded owner', props[OWNER] === 'tony@mcpoolsolutions.org');
  t('and starts its own heartbeat', props[BEAT] === iso(NOW));
}

{
  const { ctx, installed, props } = build({
    me: 'tony@mcpoolsolutions.org', triggers: [],
    props: { [OWNER]: 'gone@mcpoolsolutions.org' } // claimed, never beat
  });
  ctx.commsEnsureGuardTrigger_();
  t('takes over an owner that never recorded a beat',
    installed.length === 1 && props[OWNER] === 'tony@mcpoolsolutions.org');
}

console.log('\nPre-existing duplicate is reported, not hidden');
{
  // Both accounts already hold guards from the old buggy check. Silently
  // reassigning the record would erase the only evidence.
  const { ctx, props, installed } = build({
    me: 'tony@mcpoolsolutions.org',
    triggers: ['commsSweepGuard_'],
    props: { [OWNER]: 'mau@mcpoolsolutions.org', [BEAT]: iso(NOW - 10 * 60000) }
  });
  ctx.commsEnsureGuardTrigger_();
  t('installs nothing further', installed.length === 0);
  t('records the conflict with both accounts named',
    props[CONFLICT] === 'mau@mcpoolsolutions.org + tony@mcpoolsolutions.org',
    '→ ' + props[CONFLICT]);
  t('does not reassign ownership over the top of it',
    props[OWNER] === 'mau@mcpoolsolutions.org');

  const info = ctx.commsSenderIdentity_();
  t('the diagnostic leads with the conflict',
    info.interpretation.indexOf('CONFLICT') === 0
    && info.interpretation.indexOf('not deterministic') !== -1,
    '→ ' + info.interpretation);
}

console.log('\nClearing a resolved conflict');
{
  const { ctx, props } = build({
    me: 'mau@mcpoolsolutions.org',
    triggers: ['commsSweepGuard_'],
    props: { [OWNER]: 'mau@mcpoolsolutions.org', [BEAT]: iso(NOW), [CONFLICT]: 'mau@x + tony@x' }
  });
  // The owner runs this on every campaign creation. It must NOT quietly wipe the
  // warning — only the surplus guard's own account can delete it, so nothing here
  // can verify the duplicate is gone.
  ctx.commsEnsureGuardTrigger_();
  t('a routine owner pass leaves the conflict standing',
    props[CONFLICT] === 'mau@x + tony@x');
  t('and the diagnostic keeps reporting it',
    ctx.commsSenderIdentity_().interpretation.indexOf('CONFLICT') === 0);

  const res = ctx.commsClearGuardConflict();
  t('the explicit acknowledgement clears it', props[CONFLICT] === undefined);
  t('and reports what it cleared', res.ok === true && res.cleared === 'mau@x + tony@x');
  t('the diagnostic goes quiet afterwards',
    ctx.commsSenderIdentity_().interpretation.indexOf('CONFLICT') === -1);
}

{
  const { ctx } = build({ me: 'mau@mcpoolsolutions.org', triggers: ['commsSweepGuard_'] });
  const res = ctx.commsClearGuardConflict();
  t('clearing when nothing is recorded is harmless',
    res.ok === true && res.cleared === '');
}

console.log('\nUnreadable trigger list');
{
  const { ctx, installed, props } = build({ me: 'mau@mcpoolsolutions.org', triggersThrow: true });
  let threw = false;
  try { ctx.commsEnsureGuardTrigger_(); } catch (e) { threw = true; }
  t('does not throw', !threw);
  t('installs nothing rather than guessing', installed.length === 0);
  t('and claims nothing', props[OWNER] === undefined);
}

console.log('\nHeartbeat');
{
  const { ctx, props } = build({ me: 'mau@mcpoolsolutions.org', triggers: ['commsSweepGuard_'] });
  ctx.commsSheetRows_ = () => []; // no campaigns at all
  let swept = 0;
  ctx.commsSweep_ = () => { swept += 1; };
  ctx.commsSweepGuard_();
  t('beats even when there is no work to do', props[BEAT] === iso(NOW));
  t('and does not sweep when no campaign is active', swept === 0);
}

{
  const { ctx, props } = build({ me: 'mau@mcpoolsolutions.org' });
  ctx.commsSheetRows_ = () => [{ campaign_id: 'C1', status: 'sending', send_at: '' }];
  let swept = 0;
  ctx.commsSweep_ = () => { swept += 1; };
  ctx.commsSweepGuard_();
  t('sweeps when a campaign is mid-send', swept === 1);
  t('and still beats', props[BEAT] === iso(NOW));
}

{
  // Ordering guarantee: proof of life is stamped before anything that can throw,
  // so a broken sheet read cannot make a live guard look abandoned and invite a
  // takeover on the next pass.
  const { ctx, props } = build({ me: 'mau@mcpoolsolutions.org' });
  ctx.commsSheetRows_ = () => { throw new Error('sheet unavailable'); };
  try { ctx.commsSweepGuard_(); } catch (e) {}
  t('beats before the campaign scan that can fail', props[BEAT] === iso(NOW));
}

console.log('\nDiagnostic reporting');
{
  const { ctx } = build({
    me: 'tony@mcpoolsolutions.org', triggers: [],
    props: { [OWNER]: 'mau@mcpoolsolutions.org', [BEAT]: iso(NOW - 45 * 60000) }
  });
  const info = ctx.commsSenderIdentity_();
  t('names the owner even though its trigger is invisible here',
    info.guard_owner === 'mau@mcpoolsolutions.org' && info.guard_trigger_visible === false);
  t('reports the heartbeat age', info.guard_beat_age_ms === 45 * 60000,
    '→ ' + info.guard_beat_age_ms);
  t('interpretation points at the real sender',
    info.interpretation.indexOf('owned by mau@mcpoolsolutions.org') !== -1
    && info.interpretation.indexOf('own mailbox and quota') !== -1,
    '→ ' + info.interpretation);
}

{
  const { ctx } = build({ me: 'mau@mcpoolsolutions.org', triggers: [], props: {} });
  const info = ctx.commsSenderIdentity_();
  t('an unrecorded, invisible guard reports a null beat age', info.guard_beat_age_ms === null);
  t('and no conflict', info.guard_conflict === '');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
