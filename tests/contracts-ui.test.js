// Stage 5b/5c — Contracts UI and amendment creation wiring.
//
//   node tests/contracts-ui.test.js        (exits non-zero on failure)
//
// This is a DOM-light harness for the portal code. It intentionally loads the
// real browser files into a vm context and stubs only the minimum document/api
// surface needed by js/features/contracts.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

const els = {};
function mk(id) {
  if (!els[id]) {
    els[id] = {
      id,
      style: {},
      dataset: {},
      innerHTML: '',
      textContent: '',
      value: '',
      checked: false,
      disabled: false,
      className: '',
      focus() {},
      select() {},
      querySelectorAll() { return []; },
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
        toggle(c, force) {
          const on = force === undefined ? !this._s.has(c) : !!force;
          on ? this._s.add(c) : this._s.delete(c);
        }
      }
    };
  }
  return els[id];
}

function makeContext() {
  const ctx = {
    console,
    String,
    Number,
    Boolean,
    Math,
    JSON,
    Array,
    Object,
    RegExp,
    Date,
    isNaN,
    parseFloat,
    parseInt,
    setTimeout,
    clearTimeout,
    navigator: {
      clipboard: { writeText: () => Promise.resolve() },
      userAgent: 'node'
    },
    location: { hash: '' },
    window: {},
    document: {
      getElementById: id => mk(id),
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: () => ({ innerHTML: '', querySelectorAll: () => [] }),
      body: { style: {}, classList: { add() {}, remove() {} } },
      addEventListener() {}
    },
    localStorage: {
      _d: {},
      getItem(k) { return this._d[k] || null; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; }
    },
    alert: () => {},
    confirm: () => true,
    _appCacheGet: () => null,
    _appCacheSet: () => {},
    navigateTo: page => { ctx.__navigated = page; },
    __calls: [],
    __localGets: [],
    __localReply: () => null,
    __reply: () => ({ ok: true, agreements: [] }),
    apiLocalGet(path, params) {
      ctx.__localGets.push({ path, params });
      const reply = ctx.__localReply(path, params);
      return reply && typeof reply.then === 'function' ? reply : Promise.resolve(reply);
    },
    api(payload) {
      ctx.__calls.push(payload);
      return Promise.resolve(ctx.__reply(payload));
    }
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  ['js/lib/constants.js', 'js/features/contracts.js'].forEach(file => {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
  });
  return ctx;
}

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

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

(async function run() {
  const ctx = makeContext();
  const ev = code => vm.runInContext(code, ctx);

  console.log('\nContracts UI escaping');
  const tricky = ev(`jsArg("O'Brien <AGR>")`);
  t('jsArg supplies a quoted JS literal for inline handlers',
    tricky.startsWith('&quot;') && tricky.endsWith('&quot;'));
  t('jsArg escapes HTML-sensitive characters inside the attribute',
    tricky.includes('O\\\'Brien') === false && tricky.includes('&lt;AGR&gt;'));

  const ownedFiles = [
    'js/features/contracts.js',
    'js/features/action-queue.js',
    'js/features/scope-library.js'
  ];
  const leftovers = ownedFiles.flatMap(file => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const hits = src.match(/onclick="[^"]*'\$\{/g) || [];
    return hits.map(hit => file + ': ' + hit);
  });
  t('owned inline handlers no longer wrap template values in raw single quotes',
    leftovers.length === 0, leftovers.join(', '));

  console.log('\nAmendment UI eligibility');
  const row = extra => Object.assign({
    agreement_id: 'AGR-1',
    agreement_number: 'AGR-0048',
    customer_name: 'Blasa Rodriguez',
    service_name: 'Weekly Full Service',
    total: '216.50'
  }, extra || {});
  [
    ['signed original', row({ status: 'SIGNED', signed_at: '2026-06-02T00:00:00Z' }), true],
    ['approved original', row({ status: 'APPROVED', signed_at: '2026-06-02T00:00:00Z' }), true],
    ['legacy blank type', row({ status: 'SIGNED', signed_at: '2026-06-02T00:00:00Z', agreement_type: '' }), true],
    ['amendment row', row({ status: 'SIGNED', signed_at: '2026-06-02T00:00:00Z', agreement_type: 'amendment' }), false],
    ['unsigned sent row', row({ status: 'SENT' }), false],
    ['declined row', row({ status: 'DECLINED', signed_at: '2026-06-02T00:00:00Z' }), false],
    ['expired row', row({ status: 'EXPIRED', signed_at: '2026-06-02T00:00:00Z' }), false],
    ['no-signature row', row({ status: 'NOT_REQUIRED', signed_at: '2026-06-02T00:00:00Z' }), false],
    ['new unknown executed status', row({ status: 'CLOSED', signed_at: '2026-06-02T00:00:00Z' }), false]
  ].forEach(([label, data, expected]) => {
    t((expected ? 'can amend ' : 'cannot amend ') + label, ctx.ctCanAmend(data) === expected);
  });

  console.log('\nContracts load performance');
  {
    const sheetsCtx = makeContext();
    sheetsCtx._s = { token: 'tok-sheets', name: 'Sheets Tester' };
    sheetsCtx.__localReply = () => ({
      ok: true,
      agreements: [{
        agreement_id: 'AGR-sheets',
        agreement_number: 'AGR-SHEETS',
        status: 'SIGNED',
        signed_at: '2026-08-01T10:00:00Z',
        customer_name: 'Sheets API Customer',
        service_name: 'Weekly Full Service',
        total: '225.00'
      }],
      funnel: {
        ok: true,
        current: { month: '2026-08', sent: 1, viewed: 1, signed: 1, close_rate: 100, median_days_to_close: 1 },
        months: [],
        latest_cohort: null,
        expiring_soon: 0,
        amendments_signed: 0,
        viewed_tracking_since: '2026-08-01'
      }
    });
    sheetsCtx.loadContracts(false);
    await tick();
    t('tries the same-origin Contracts Sheets API endpoint first',
      sheetsCtx.__localGets.length === 1 && sheetsCtx.__localGets[0].path === '/api/contracts');
    t('uses the short server cache on normal loads',
      sheetsCtx.__localGets[0].params.refresh === undefined);
    t('renders contracts from the Sheets API endpoint',
      els['ct-list'].innerHTML.includes('Sheets API Customer'));
    t('renders funnel stats from the same endpoint',
      els['ct-stats'].innerHTML.includes('Sent in August 2026') &&
      els['ct-stats'].innerHTML.includes('100'));
    t('does not call GAS when the fast endpoint succeeds',
      sheetsCtx.__calls.length === 0);
    const storedContracts = JSON.parse(sheetsCtx.localStorage.getItem('mcps_contracts_stage5b_v2') || 'null');
    t('stores a short browser cache from real Contracts data',
      storedContracts && Array.isArray(storedContracts.agreements) &&
      storedContracts.agreements[0].customer_name === 'Sheets API Customer');
  }

  {
    const refreshCtx = makeContext();
    refreshCtx._s = { token: 'tok-refresh', name: 'Refresh Tester' };
    refreshCtx.__localReply = () => ({
      ok: true,
      agreements: [],
      funnel: {
        ok: true,
        current: { month: '2026-08', sent: 0, viewed: 0, signed: 0, close_rate: 0, median_days_to_close: null },
        months: [],
        latest_cohort: null,
        expiring_soon: 0,
        amendments_signed: 0,
        viewed_tracking_since: ''
      }
    });
    refreshCtx.loadContracts(true);
    await tick();
    t('manual refresh bypasses the short Contracts endpoint cache',
      refreshCtx.__localGets[0].params.refresh === '1');
  }

  {
    const fastCtx = makeContext();
    fastCtx._s = { token: 'tok-fast', name: 'Fast Tester' };
    fastCtx.__reply = payload => {
      if (payload.action === 'get_sales_funnel') return new Promise(() => {});
      return {
        ok: true,
        agreements: [{
          agreement_id: 'AGR-fast',
          agreement_number: 'AGR-FAST',
          status: 'SIGNED',
          signed_at: '2026-08-01T10:00:00Z',
          customer_name: 'Fast Paint Customer',
          service_name: 'Weekly Full Service',
          total: '200.00'
        }]
      };
    };
    fastCtx.loadContracts(true);
    await tick();
    t('renders rows before funnel stats finish',
      els['ct-list'].innerHTML.includes('Fast Paint Customer') &&
      !els['ct-list'].innerHTML.includes('ct-skel'));
    const funnelCall = fastCtx.__calls.find(c => c.action === 'get_sales_funnel');
    t('asks the backend for fresh funnel stats, not cached stats',
      funnelCall && funnelCall.refresh === true);
  }

  console.log('\nAmendment UI rendering');
  ev(`_contracts = [
    { agreement_id:'AGR-1', agreement_number:'AGR-0048', status:'SIGNED',
      signed_at:'2026-06-02T00:00:00Z', customer_name:'Blasa Rodriguez',
      service_name:'Weekly Full Service', total:'216.50', source_quote_id:"Q'O" },
    { agreement_id:'AGR-2', agreement_number:'AMD-0001', status:'SIGNED',
      signed_at:'2026-07-02T00:00:00Z', agreement_type:'amendment',
      parent_agreement_id:'AGR-1', amendment_reason:'Adding spa service',
      customer_name:'Blasa Rodriguez', service_name:'Weekly + Spa', total:'236.50' },
    { agreement_id:'AGR-3', agreement_number:'AGR-0049', status:'SENT',
      customer_name:'Sam Vega', service_name:'Pool Startup', total:'500',
      followup_approval_id:'APR-3', approval_status:'SENT',
      followup_enabled:'TRUE', followup_schedule:'3,7,14', final_notice_lead_days:'3' }
  ];`);
  ctx.renderContracts();
  const listHtml = els['ct-list'].innerHTML;
  t('list still leads with customer identity, not agreement number',
    listHtml.indexOf('>Blasa Rodriguez<') !== -1 &&
    listHtml.indexOf('>Blasa Rodriguez<') < listHtml.indexOf('AGR-0048'));
  t('amendment row is marked as a plan change',
    listHtml.includes('Plan change') && listHtml.includes('ct-amd'));
  t('details handler uses jsArg output',
    /onclick="ctViewDetail\(&quot;AGR-1&quot;\)"/.test(listHtml));

  ctx.ctViewDetail('AGR-1');
  t('signed original shows Create plan change',
    els['ct-drawer-body'].innerHTML.includes('Create plan change'));
  t('quote link with apostrophe remains safely encoded',
    els['ct-drawer-body'].innerHTML.includes('ctOpenQuote(&quot;Q\'O&quot;)'));

  ctx.ctViewDetail('AGR-2');
  t('amendment detail does not show Create plan change',
    !els['ct-drawer-body'].innerHTML.includes('Create plan change'));
  t('amendment detail links back to the parent agreement',
    els['ct-drawer-body'].innerHTML.includes('AGR-1') &&
    els['ct-drawer-body'].innerHTML.includes('Adding spa service'));

  ctx.ctViewDetail('AGR-3');
  t('unsigned detail does not show Create plan change',
    !els['ct-drawer-body'].innerHTML.includes('Create plan change'));
  t('unsigned detail exposes editable follow-up cadence',
    els['ct-drawer-body'].innerHTML.includes('Follow-up cadence') &&
    els['ct-drawer-body'].innerHTML.includes('Save cadence'));

  console.log('\nContract follow-up cadence UI');
  mk('ct-fu-enabled').checked = true;
  mk('ct-fu-schedule').value = '10, 3, 3';
  mk('ct-fu-final').value = '5';
  mk('ct-fu-reset').checked = true;
  ctx.__calls = [];
  ctx.__localReply = () => ev(`({ ok:true, agreements:_contracts, funnel:null })`);
  ctx.__reply = payload => payload.action === 'update_contract_followups'
    ? {
        ok: true,
        agreement_id: payload.agreement_id,
        approval_id: 'APR-3',
        followup_enabled: payload.followup_enabled ? 'TRUE' : 'FALSE',
        followup_schedule: payload.followup_schedule,
        final_notice_lead_days: payload.final_notice_lead_days,
        followup_next_index: payload.reset_followups ? '0' : '2'
      }
    : { ok: true, agreements: [] };
  ev(`_s = { token:'tok-staff', name:'Mauricio Rebaza', roles:['admin'], pages:['contracts'] };`);
  ctx.ctSaveFollowups('AGR-3');
  await tick();
  const cadenceCall = ctx.__calls.find(c => c.action === 'update_contract_followups');
  t('saves cadence through the portal action', !!cadenceCall);
  t('normalizes and de-dupes follow-up days before saving',
    cadenceCall && cadenceCall.followup_schedule === '3,10');
  t('sends enabled, final notice lead and reset choice',
    cadenceCall && cadenceCall.followup_enabled === true &&
    cadenceCall.final_notice_lead_days === '5' &&
    cadenceCall.reset_followups === true);
  t('applies saved cadence to the local contract row',
    ev(`_contracts.find(c => c.agreement_id === 'AGR-3').followup_schedule`) === '3,10');

  console.log('\nAmendment UI creation payload');
  ctx.openAmendModal('AGR-1');
  t('modal opens', els['amd-modal-backdrop'].classList.contains('open'));
  t('modal names the contract being changed',
    els['amd-modal-body'].innerHTML.includes('Blasa Rodriguez'));
  t('modal offers the five change types',
    ['Upgrade', 'Downgrade', 'Pause', 'Resume', 'Other']
      .every(label => els['amd-modal-body'].innerHTML.includes(label)));

  ctx.__calls = [];
  mk('amd-reason').value = '';
  ctx.amdSubmit();
  t('refuses creation without a reason', ctx.__calls.length === 0);

  mk('amd-reason').value = 'Adding spa service';
  mk('amd-service').value = 'Weekly Full Service + Spa';
  mk('amd-rate').value = '200.00';
  mk('amd-tax').value = '16.50';
  mk('amd-total').value = '216.50';
  t('defaults to upgrade', ctx.amdSelectedType() === 'upgrade');
  ctx.amdPickType('pause');
  t('type selection is state-backed', ctx.amdSelectedType() === 'pause');
  ctx.amdPickType('nonsense');
  t('unknown type falls back to other', ctx.amdSelectedType() === 'other');
  ctx.amdPickType('upgrade');

  ctx.__calls = [];
  ctx.__reply = payload => payload.action === 'create_amendment'
    ? {
        ok: true,
        amendment_id: 'AGR-9',
        amendment_number: 'AMD-0002',
        sign_url: 'https://mcps-log.vercel.app/agreement.html?token=tok-xyz'
      }
    : { ok: true, agreements: [] };
  ev(`_s = { token:'tok-staff', name:'Mauricio Rebaza', roles:['admin'], pages:['contracts'] };`);
  ctx.amdSubmit();
  await tick();

  const call = ctx.__calls.find(c => c.action === 'create_amendment');
  t('calls create_amendment', !!call);
  t('sends the parent agreement id', call && call.parent_agreement_id === 'AGR-1');
  t('does not send a browser-selected signing target',
    call && call.target_agreement_id === undefined && call.agreement_id === undefined);
  t('sends type and customer-visible reason',
    call && call.amendment_type === 'upgrade' && call.amendment_reason === 'Adding spa service');
  t('sends agreement rate and proposal subtotal together',
    call && call.monthly_rate === '200.00' && call.subtotal === '200.00');
  t('sends tax and total',
    call && call.sales_tax === '16.50' && call.total === '216.50');
  t('result shows the new amendment number',
    els['amd-modal-body'].innerHTML.includes('AMD-0002'));
  t('result exposes the signing link',
    els['amd-modal-body'].innerHTML.includes('token=tok-xyz'));
  t('result states that no email was sent',
    /No email has been sent/i.test(els['amd-modal-body'].innerHTML));
  t('footer gives copy/open/done actions',
    ['Copy link', 'Open signing page', 'Done']
      .every(label => els['amd-modal-foot'].innerHTML.includes(label)));

  console.log('\nServer-side audit stamping');
  const webhook = fs.readFileSync(path.join(ROOT, 'appscript/WebhookReceiver.js'), 'utf8');
  t('create_amendment route overrides client created_by with the authenticated user',
    /created_by:\s*String\(amAuth\.name\s*\|\|\s*amAuth\.username\s*\|\|\s*''\)\.trim\(\)/.test(webhook) &&
    /handleCreateAmendment_\(amPayload\)/.test(webhook));

  console.log('\nContracts Sheets API endpoint');
  const sheetsHelper = fs.readFileSync(path.join(ROOT, 'api/_sheets.js'), 'utf8');
  const contractsEndpoint = fs.readFileSync(path.join(ROOT, 'api/contracts.js'), 'utf8');
  t('Sheets helper exposes a batch read path',
    /values:batchGet/.test(sheetsHelper) && /readSheetRanges/.test(sheetsHelper));
  t('Contracts endpoint requires admin or manager access',
    /validatePortalSession/.test(contractsEndpoint) && /hasAdminAccess/.test(contractsEndpoint));
  t('Contracts endpoint uses a short cache',
    /CONTRACTS_CACHE_MS\s*=\s*20\s*\*\s*1000/.test(contractsEndpoint));
  t('Contracts endpoint builds agreements and funnel from one batched Sheets read',
    /readSheetRanges\(CONTRACT_RANGES\)/.test(contractsEndpoint) &&
    /agreements:\s*data\.agreements/.test(contractsEndpoint) &&
    /funnel:\s*data\.funnel/.test(contractsEndpoint));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
