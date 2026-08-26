// js/lib/status.js — the single quote lifecycle vocabulary.
//
//   node tests/quote-status.test.js
//
// ⚠️ WHAT WAS BROKEN. Three overlapping vocabularies and no source of truth:
// DECLINED and EXPIRED belonged to no filter pill at all, the Completed filter's
// <option> value (COMPLETED) did not match the stored value (COMPLETED_JOB), and
// home.js counted a status ('QUOTED') that nothing has ever written — so pipeline
// value and two of the three funnel stages read structurally zero.
const fs = require('fs'), path = require('path');
const S = require('../js/lib/status.js');

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };

console.log('\nThe dead values now resolve instead of matching nothing');
{
  t("'COMPLETED' (the filter option) maps to the stored COMPLETED_JOB",
    S.normalize('COMPLETED') === 'COMPLETED_JOB');
  t("'QUOTED' (counted by home.js, never written) maps to SENT",
    S.normalize('QUOTED') === 'SENT');
  t("'DECLINED' (written by the backend, shown by nothing) resolves",
    S.normalize('DECLINED') === 'CHANGES_DECLINED');
  t("'NOT_REQUIRED' resolves", S.normalize('NOT_REQUIRED') === 'ACTIVE_CUSTOMER');
  t('case and spacing are tolerated', S.normalize('  active customer ') === 'ACTIVE_CUSTOMER');
  t('hyphens are tolerated', S.normalize('completed-job') === 'COMPLETED_JOB');
  t('an unknown value returns empty rather than a wrong guess', S.normalize('flurb') === '');
  t('empty stays empty', S.normalize('') === '' && S.normalize(null) === '');
}

console.log('\nEvery state belongs to exactly one pill');
{
  const orphans = S.ORDER.filter(k => S.pillFor(k) === 'all');
  t('no state is orphaned', orphans.length === 0, '(' + orphans.join(',') + ')');
  t('DECLINED has a pill — it previously had none', S.pillFor('CHANGES_DECLINED') === 'lost');
  t('EXPIRED has a pill — it previously had none', S.pillFor('EXPIRED') === 'lost');
  t('UNSENT has a pill — it had a count but no button', S.pillFor('UNSENT') === 'UNSENT');
  t('a state is never in two exclusive pills',
    S.ORDER.every(k => S.PILLS.filter(p => p.key !== 'all' && p.key !== 'open' && p.key !== 'action'
      && p.states.includes(k)).length === 1));
  t('every pill has a label', S.PILLS.every(p => !!p.label));
}

console.log('\nDerivation — one answer, shared by every screen');
{
  t('signed and on the route reads Active',
    S.derive({ status: 'ACTIVE_CUSTOMER', contract_status: 'SIGNED', pool_id: 'MCPS-0001' }) === 'ACTIVE_CUSTOMER');
  t('signed but not yet placed reads Signed',
    S.derive({ status: 'ACTIVE_CUSTOMER', contract_status: 'SIGNED' }) === 'SIGNED');
  t('a signed_at timestamp alone is enough',
    S.derive({ status: 'SENT', signed_at: '2026-08-01' }) === 'SIGNED');
  t('a declined proposal outranks a stale SENT status',
    S.derive({ status: 'SENT', proposal_declined_at: '2026-08-01' }) === 'CHANGES_DECLINED');
  t('a change request surfaces',
    S.derive({ status: 'SENT', proposal_change_requested_at: '2026-08-01' }) === 'CHANGES_REQUESTED');
  t('but not once they have signed anyway',
    S.derive({ status: 'SENT', proposal_change_requested_at: '2026-08-01', contract_status: 'SIGNED' }) === 'SIGNED');
  t('a lapsed link reads Expired',
    S.derive({ status: 'SENT', expired_at: '2026-08-01' }) === 'EXPIRED');
  t('an opened link reads Viewed',
    S.derive({ status: 'SENT', viewed_at: '2026-08-01' }) === 'VIEWED');
  t('a blank row defaults to a draft, not to nothing', S.derive({}) === 'UNSENT');
  t('a row with only a proposal sent_at reads SENT',
    S.derive({ proposal_sent_at: '2026-08-01' }) === 'SENT');
  t('a legacy COMPLETED row derives correctly',
    S.derive({ status: 'COMPLETED' }) === 'COMPLETED_JOB');
}

console.log('\nCounting no longer hides or double-labels anyone');
{
  const rows = [
    { status: 'LEAD' },
    { status: 'UNSENT' },
    { status: 'SENT' },
    { status: 'SENT', proposal_declined_at: 'x' },          // was invisible
    { status: 'SENT', expired_at: 'x' },                     // was invisible
    { status: 'ACTIVE_CUSTOMER', contract_status: 'SIGNED', pool_id: 'MCPS-1' },
    { status: 'COMPLETED_JOB' },
    { status: 'LOST' }
  ];
  const c = S.counts(rows);
  t('All counts every row', c.all === 8);
  t('the declined + expired + lost roll into one Lost pill', c.lost === 3);
  t('drafts are visible', c.UNSENT === 1);
  t('active is 1', c.ACTIVE_CUSTOMER === 1);
  t('completed is 1 — the filter that always said "no records"', c.COMPLETED_JOB === 1);
  t('Needs You surfaces the two that require a decision', c.action === 2);
  t('Open counts only live deals', c.open === 3, '(lead + draft + sent)');
  t('no row is missing from every non-All pill',
    rows.every(r => S.pillFor(S.derive(r)) !== 'all'));
}

console.log('\nThe filter and the pills agree');
{
  const row = { status: 'SENT', proposal_declined_at: 'x' };
  t('a declined row matches the Lost pill', S.matchesPill('lost', S.derive(row)) === true);
  t('and not the Sent pill', S.matchesPill('SENT', S.derive(row)) === false);
  t('All matches everything', S.matchesPill('all', S.derive(row)) === true);
  t('an empty filter matches everything', S.matchesPill('', 'LOST') === true);
  t('Sent covers Viewed too, so opening the email does not hide the deal',
    S.matchesPill('SENT', 'VIEWED') === true);
  t('Active covers Paused', S.matchesPill('ACTIVE_CUSTOMER', 'PAUSED') === true);
}

console.log('\nTransitions are constrained');
{
  t('a draft can be sent', S.canTransition('UNSENT', 'SENT'));
  t('a sent quote can be signed', S.canTransition('SENT', 'SIGNED'));
  t('an active customer can be paused', S.canTransition('ACTIVE_CUSTOMER', 'PAUSED'));
  t('a lost deal can be revived as a lead', S.canTransition('LOST', 'LEAD'));
  t('a lost deal cannot jump straight to active', !S.canTransition('LOST', 'ACTIVE_CUSTOMER'));
  t('a draft cannot skip to signed', !S.canTransition('UNSENT', 'SIGNED'));
  t('an unknown target is refused', !S.canTransition('SENT', 'FLURB'));
  t('same-to-same is allowed so a re-save is not an error', S.canTransition('SENT', 'SENT'));
  t('from nothing, any valid state is allowed', S.canTransition('', 'ACTIVE_CUSTOMER'));
}

console.log('\nOnly sensible statuses are offered as buttons');
{
  const fromSent = S.allowedNext('SENT');
  t('SIGNED is never offered as a button — a human must not claim a signature',
    !fromSent.includes('SIGNED'));
  t('nor is DECLINED, which the signing flow records',
    !fromSent.includes('CHANGES_DECLINED'));
  t('LOST is offered', fromSent.includes('LOST'));
  t('every offered option is a legal transition',
    fromSent.every(x => S.canTransition('SENT', x)));
  t('from LOST only revival options appear',
    S.allowedNext('LOST').sort().join(',') === 'LEAD,UNSENT');
  t('an active customer is not offered LEAD',
    !S.allowedNext('ACTIVE_CUSTOMER').includes('LEAD'));
  t('the manual list never contains a derived-only state',
    !S.MANUAL.includes('SIGNED') && !S.MANUAL.includes('VIEWED') && !S.MANUAL.includes('EXPIRED'));
}

console.log('\nThe pipeline that used to read zero');
{
  const rows = [
    { status: 'LEAD', total_with_tax: 100 },
    { status: 'UNSENT', total_with_tax: 300 },
    { status: 'SENT', total_with_tax: 500 },
    { status: 'SENT', viewed_at: 'x', total_with_tax: 700 },
    { status: 'ACTIVE_CUSTOMER', contract_status: 'SIGNED', pool_id: 'p', total_with_tax: 260 },
    { status: 'LOST', total_with_tax: 999 }
  ];
  const pl = S.pipeline(rows);
  t('quoted is no longer permanently 0', pl.quoted === 3, '(' + pl.quoted + ')');
  t('leads counted', pl.leads === 1);
  t('active counted', pl.active === 1);
  t('lost counted', pl.lost === 1);
  t('open pipeline VALUE includes priced-but-unsigned quotes',
    pl.open_value === 1600, '(' + pl.open_value + ')');
  t('a lost deal is excluded from open value', pl.open_value < 999 + 1600);
  t('won value counts only won deals', pl.won_value === 260);
  t('money strings with $ and commas are parsed',
    S.pipeline([{ status: 'SENT', total_with_tax: '$1,234.50' }]).open_value === 1234.5);
}

console.log('\nMetadata is complete enough to render with');
{
  t('every state has a label, short label, hint and colours',
    S.ORDER.every(k => {
      const m = S.META[k];
      return m.label && m.short && m.hint && /^#/.test(m.color) && /^#/.test(m.bg);
    }));
  t('order is strictly increasing',
    S.ORDER.every((k, i) => i === 0 || S.META[S.ORDER[i - 1]].order < S.META[k].order));
  t('a label is human, not a constant name', S.label('ACTIVE_CUSTOMER') === 'Active Customer');
  t('an unknown key falls back to a draft rather than crashing',
    S.meta('flurb').label === 'Draft Quote');
  t('closed states are marked', S.meta('LOST').closed === true && S.meta('EXPIRED').closed === true);
  t('won states are marked', S.meta('SIGNED').won === true && S.meta('ACTIVE_CUSTOMER').won === true);
}

console.log('\nThe browser and the server enums have not drifted');
{
  // Two copies exist because Apps Script cannot import js/lib/status.js. Drift
  // means the UI offers a transition the server rejects, so it is asserted.
  const gas = fs.readFileSync(path.join(__dirname, '..', 'appscript', 'SalesHub.js'), 'utf8');
  // Plain slicing rather than a regex: the array literals are multi-line and a
  // character-class regex over them is more fragile than the thing it checks.
  const grab = (name) => {
    const at = gas.indexOf('var ' + name + ' = [');
    if (at === -1) return null;
    const open = gas.indexOf('[', at);
    const close = gas.indexOf(']', open);
    if (open === -1 || close === -1) return null;
    return gas.slice(open + 1, close)
      .split(',')
      .map(x => x.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
  };
  const gasStates = grab('MCPS_STATUS_STATES');
  const gasManual = grab('MCPS_STATUS_MANUAL');
  t('the server declares its state list', !!gasStates);
  t('the state lists match exactly',
    gasStates && gasStates.slice().sort().join(',') === S.ORDER.slice().sort().join(','),
    '(server: ' + (gasStates || []).join(',') + ')');
  t('the manual lists match exactly',
    gasManual && gasManual.slice().sort().join(',') === S.MANUAL.slice().sort().join(','));

  const gasAliases = /var MCPS_STATUS_ALIASES = \{([\s\S]*?)\};/.exec(gas);
  t('the server declares aliases', !!gasAliases);
  const keys = gasAliases ? (gasAliases[1].match(/(\w+):/g) || []).map(k => k.replace(':', '')) : [];
  t('the dead values are aliased on the server too',
    ['COMPLETED', 'QUOTED', 'DECLINED'].every(k => keys.includes(k)),
    '(' + keys.join(',') + ')');
  t('every server alias target is a real state',
    gasAliases && (gasAliases[1].match(/'([A-Z_]+)'/g) || [])
      .map(v => v.replace(/'/g, '')).every(v => S.ORDER.includes(v)));
}

console.log('\nNo screen still carries its own hardcoded vocabulary');
{
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const crm = read('js/features/crm.js'), comms = read('js/features/comms.js'), home = read('js/features/home.js');
  t('crm.js no longer hardcodes a status array',
    !/const STATUSES = \['LEAD'/.test(crm));
  t('crm.js reads the module', /MCPS_STATUS\./.test(crm));
  t('comms.js reads the module', /MCPS_STATUS\.ORDER/.test(comms));
  t("home.js no longer filters on 'QUOTED'", !/'QUOTED'/.test(home));
  t('home.js reads the module', /MCPS_STATUS\./.test(home));
  t('status.js is in the page load order',
    /js\/lib\/status\.js/.test(read('index.html')));
  t('and loads before the features that use it',
    read('index.html').indexOf('js/lib/status.js') < read('index.html').indexOf('js/features/crm.js'));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
