// Smoke test: Action Queue nav wiring, no browser.
// NOTE: top-level const/let are lexical, not properties of the vm context —
// they must be read and written through ev(), not ctx.<name>.
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..') + '/';

const els = {};
const mkEl = id => (els[id] = els[id] || { id, style:{}, classList:{ _s:new Set(),
  add(c){this._s.add(c)}, remove(c){this._s.delete(c)}, contains(c){return this._s.has(c)},
  toggle(c,f){ f===undefined ? (this._s.has(c)?this._s.delete(c):this._s.add(c)) : (f?this._s.add(c):this._s.delete(c)); } },
  innerHTML:'', textContent:'', querySelectorAll:()=>[] });

const ctx = {
  console, document: {
    getElementById: id => mkEl(id),
    querySelectorAll: () => [], querySelector: () => null,
    createElement: () => ({ innerHTML:'', querySelectorAll:()=>[] }),
    body:{style:{}, classList:{add(){},remove(){},toggle(){},contains(){return false}}}, addEventListener(){},
  },
  window:{ addEventListener(){}, matchMedia:()=>({matches:false,addEventListener(){}}) },
  localStorage:{ _d:{}, getItem(k){return this._d[k]??null}, setItem(k,v){this._d[k]=v}, removeItem(k){delete this._d[k]} },
  location:{ hash:'' }, navigator:{ userAgent:'node' },
  fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok:true, items:[] }) }),
  setTimeout, clearTimeout, setInterval, clearInterval, requestIdleCallback: cb => cb(),
};
ctx.globalThis = ctx; ctx.window.location = ctx.location;
vm.createContext(ctx);

const load = f => { try { vm.runInContext(fs.readFileSync(R+f,'utf8'), ctx, {filename:f}); }
                    catch(e){ console.log('  (load note '+f+': '+e.message+')'); } };
const ev = code => vm.runInContext(code, ctx);

['js/lib/constants.js','js/lib/api.js','js/lib/auth.js','js/lib/router.js',
 'js/features/action-queue.js','app.js'].forEach(load);

let pass = 0, fail = 0;
const t = (name, cond, extra='') => { cond ? (pass++, console.log('  ✓ '+name))
                                           : (fail++, console.log('  ✗ '+name+' '+extra)); };
// pages must come from unionPages_, exactly as doLogin builds it — using
// ROLE_PAGES directly bypasses its whitelist and hides real bugs.
const setSession = role => ev(`_s = { token:'t', name:'X', roles:['${role}'], pages: unionPages_(['${role}']) };`);

console.log('\nROLE_PAGES');
t('admin has action_queue',   ev(`unionPages_(['admin']).includes('action_queue')`));
t('manager has action_queue', ev(`unionPages_(['manager']).includes('action_queue')`));
['office','technician','lead','trainee','new_hire'].forEach(r =>
  t(r+' does NOT', ev(`!unionPages_(['${r}']).includes('action_queue')`)));

console.log('\nunionPages_ whitelist parity (the bug that hid this)');
{
  const granted = ev(`(function(){var s=new Set();Object.keys(ROLE_PAGES).forEach(function(r){ROLE_PAGES[r].forEach(function(p){s.add(p);});});return Array.from(s);})()`);
  const dropped = granted.filter(p => !ev(`unionPages_(Object.keys(ROLE_PAGES)).includes('${p}')`));
  t('no ROLE_PAGES entry is silently dropped by unionPages_', dropped.length === 0, '(dropped: ' + dropped.join(', ') + ')');
}

console.log('\nSidebar render');
setSession('admin'); ctx.buildNav();
const nav = els['sb-nav'].innerHTML;
t('button present',      nav.includes(`id="ni-action_queue"`));
t('lives inside the Sales Hub group',
  nav.indexOf('sbg-sales') !== -1 &&
  nav.indexOf('ni-action_queue') > nav.indexOf('sbg-sales'), '(expected it under Sales Hub)');
t('badge present',       nav.includes(`id="aq-badge"`));
t('badge starts hidden', /id="aq-badge" style="display:none"/.test(nav));
t('navigates correctly', nav.includes(`navigateTo('action_queue')`));
t('icon + label',        nav.includes('<svg') && nav.includes('Action Queue'));
t('first item in Sales Hub',
  nav.indexOf('ni-action_queue') < nav.indexOf('ni-crm'), '(should sit above Leads CRM)');
setSession('office'); ctx.buildNav();
t('office sees no button', !els['sb-nav'].innerHTML.includes('ni-action_queue'));

console.log('\nRouter');
setSession('admin');
ev(`loadActionQueue = function(){ globalThis.__called = true; };`);
ctx.__called = false;
ctx.navigateTo('action_queue');
t('loadActionQueue called', ctx.__called === true);
t('page frame activated',   els['page-action_queue'].classList.contains('active'));
t('sidebar item active',    els['ni-action_queue'].classList.contains('active'));
// The stub stores the raw assignment; a real browser prepends '#'. Compare
// against an existing page so the assertion tests our wiring, not the stub.
const aqHash = ctx.location.hash;
ev(`loadCRM = function(){};`);
ctx.navigateTo('crm'); const crmHash = ctx.location.hash;
setSession('admin'); ctx.navigateTo('action_queue');
t('hash set, same shape as other pages',
  aqHash === 'action_queue' && crmHash === 'crm',
  '(aq='+aqHash+' crm='+crmHash+')');

console.log('\nRouter guard — role without the page');
setSession('office');
ctx.__called = false; els['page-action_queue'].classList.remove('active');
ctx.navigateTo('action_queue');
t('blocked for office', !ctx.__called && !els['page-action_queue'].classList.contains('active'));

console.log('\nBadge');
setSession('admin'); ctx.buildNav();
ev(`_aqItems = [{type:'start'},{type:'change'},{type:'expiring'}];`); ctx.updateActionQueueBadge();
t('shows count', els['aq-badge'].textContent === '3', '(got '+els['aq-badge'].textContent+')');
t('visible',     els['aq-badge'].style.display === '');
ev(`_aqItems = [];`); ctx.updateActionQueueBadge();
t('hides at zero', els['aq-badge'].style.display === 'none');
ev(`_aqItems = new Array(140).fill({type:'start'});`); ctx.updateActionQueueBadge();
t('caps at 99+', els['aq-badge'].textContent === '99+', '(got '+els['aq-badge'].textContent+')');

console.log('\nAssignment exception cards');
{
  const src = fs.readFileSync(R+'js/features/action-queue.js', 'utf8');
  t('fetches assignment exceptions', src.includes("action: 'get_assignment_exceptions'"));
  t('can resolve assignment exceptions', src.includes("action: 'resolve_assignment_exception'"));

  ev(`_aqItems = [aqExceptionToItem_({
    exception_id:'AEX-1',
    type:'missing_first_visit',
    quote_id:"Q'1",
    pool_id:'P-1',
    detail:'Weekly first visit was not created',
    created_at:'2026-08-16T12:00:00Z'
  })]; _aqFilter = 'all';`);
  ctx.renderActionQueue();
  const html = els['aq-list'].innerHTML;
  const filters = els['aq-filters'].innerHTML;
  t('exception filter appears', filters.includes('Exceptions'));
  t('exception count appears', filters.includes('<span class="aq-n">1</span>'));
  t('exception card class', html.includes('aq-t-exception'));
  t('exception label', html.includes('Missing First Visit'));
  t('exception detail visible', html.includes('Weekly first visit was not created'));
  t('resolve button visible', html.includes('aqResolveException'));
  t('quote action still escapes apostrophes through jsArg',
    html.includes("aqOpenQuote(&quot;Q'1&quot;)"),
    '(html: '+html.slice(0, 300)+')');

  ev(`_aqFilter = 'exception';`);
  ctx.renderActionQueue();
  t('exception filter shows the card', els['aq-list'].innerHTML.includes('AEX-1') || els['aq-list'].innerHTML.includes('Missing First Visit'));

  ev(`_aqFilter = 'start';`);
  ctx.renderActionQueue();
  t('other filters hide exception cards', !els['aq-list'].innerHTML.includes('Missing First Visit'));
}

console.log('\nBoot priming');
t('primeActionQueueBadge defined', typeof ctx.primeActionQueueBadge === 'function');
ev(`loadActionQueue = function(){ globalThis.__primed = true; };`);
setSession('office'); ctx.__primed = false; ctx.primeActionQueueBadge();
t('no fetch for ineligible role', ctx.__primed === false);
setSession('admin'); ctx.primeActionQueueBadge();
t('fetches for admin', ctx.__primed === true);

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail ? 1 : 0);
