// Recipient checklist + hand-built list suite.
//
//   node tests/comms-recipient-list.test.js
//
// The compose screen lets you curate exactly who gets a campaign: untick rows in
// the preview, and accumulate people across SEVERAL different filters into one
// list. Both paths decide who receives customer email, so the logic is executed
// here rather than regex-matched.
//
// The invariants that matter:
//   - an invalid address or an opt-out is never selectable and never reaches the
//     list, no matter which filter surfaced it
//   - the same person appearing under two filters is added once
//   - an UNCURATED send still sends the FILTER, so a campaign scheduled for next
//     week picks up whoever matches by then; curating freezes an explicit list
//   - sending never silently re-resolves and discards what you picked
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const UI_SRC = path.join(ROOT, 'js/features/comms.js');
const COMMS_SRC = path.join(ROOT, 'appscript/Comms.js');

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

// ─── Front end ───────────────────────────────────────────────────────────────
// Top-level `let` in a vm script is lexical, not a property of the context, so
// the accessors are appended to the SAME script to close over the real bindings.
const EXPORTS = `
;globalThis.__t = {
  basket: () => _commsBasket,
  unchecked: () => _commsUnchecked,
  compose: () => _commsCompose,
  setPreview: v => { _commsPreview = v; _commsUnchecked.clear(); },
  setSender: v => { _commsSender = v; },
  selected: () => _commsSelectedRecipients(),
  toggle: (i, on) => commsTogglePreviewRow(i, on),
  selectAll: on => commsPreviewSelectAll(on),
  addSelected: () => commsAddSelectedToList(),
  removeAt: i => commsRemoveFromList(i),
  clear: () => commsClearList(),
  isCurated: () => _commsIsCurated(),
  sendAudience: () => _commsSendAudience(),
  buildAudience: () => _commsBuildAudience()
};`;

function buildUI() {
  const els = {};
  const el = () => ({ innerHTML: '', className: '', textContent: '', getAttribute: () => '[]' });
  const ctx = {
    console, JSON, Math, String, Number, Array, Object, Set, Map, RegExp, Date, isNaN,
    escHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    api: async () => ({ ok: true }),
    confirm: () => true,
    alert: () => {},
    setTimeout: () => {},
    _weekStartForOffset_: () => '2026-08-17',
    _VISIT_TYPE_LABELS: {},
    isAdmin: () => true,
    hasRole: () => true,
    // comms.js reads the shared lifecycle vocabulary at load time, so the VM
    // context needs it the same way index.html's <script> order provides it.
    MCPS_STATUS: require(path.join(ROOT, 'js/lib/status.js')),
    navigateTo: () => {},
    document: {
      getElementById: id => (els[id] || (els[id] = el())),
      createElement: () => ({ ...el(), style: {} }),
      head: { appendChild: () => {} }
    },
    window: {}
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(UI_SRC, 'utf8') + EXPORTS, ctx, { filename: 'comms.js' });
  return { ctx, api: ctx.__t, els };
}

const R = (email, name, over = {}) => Object.assign({
  email, name, first_name: name.split(' ')[0], last_name: name.split(' ')[1] || '',
  area: 'North', quote_id: 'Q-' + email, pool_id: '', properties: [{ quote_id: 'Q-' + email, day: 'Tuesday' }],
  pools: 1, invalid: false, opted_out: false
}, over);

const PREVIEW = (recipients) => ({
  ok: true, total: recipients.length,
  sendable_count: recipients.filter(r => !r.invalid && !r.opted_out).length,
  invalid_count: recipients.filter(r => r.invalid).length,
  opted_out_count: recipients.filter(r => r.opted_out).length,
  truncated: false, recipients
});

console.log('\nPreview checklist');
{
  const { api } = buildUI();
  api.setPreview(PREVIEW([
    R('a@x.com', 'Pedro Pompa'),
    R('b@x.com', 'Dave Libby'),
    R('c@x.com', 'Bad Address', { invalid: true }),
    R('d@x.com', 'Opted Out', { opted_out: true })
  ]));
  t('everyone sendable starts ticked', api.selected().length === 2);
  t('an invalid address is not selectable',
    !api.selected().some(r => r.email === 'c@x.com'));
  t('an opted-out customer is not selectable',
    !api.selected().some(r => r.email === 'd@x.com'));

  api.toggle(0, false);
  t('unticking a row drops it from the selection',
    api.selected().length === 1 && api.selected()[0].email === 'b@x.com');
  api.toggle(0, true);
  t('re-ticking restores it', api.selected().length === 2);
}

{
  const { api } = buildUI();
  api.setPreview(PREVIEW([R('a@x.com', 'A'), R('b@x.com', 'B'), R('c@x.com', 'C', { opted_out: true })]));
  api.selectAll(false);
  t('select none clears the sendable rows', api.selected().length === 0);
  t('and counts as curation', api.isCurated() === true);
  api.selectAll(true);
  t('select all restores every sendable row', api.selected().length === 2);
  t('and is back to uncurated', api.isCurated() === false);
}

console.log('\nBuilding a list across different filters');
{
  const { api } = buildUI();
  // Filter 1: two people, one unticked.
  api.setPreview(PREVIEW([R('a@x.com', 'A'), R('b@x.com', 'B')]));
  api.toggle(1, false);
  api.addSelected();
  t('only ticked rows are added', api.basket().length === 1 && api.basket()[0].email === 'a@x.com');

  // Filter 2: a fresh preview, one overlapping person.
  api.setPreview(PREVIEW([R('a@x.com', 'A'), R('c@x.com', 'C')]));
  api.addSelected();
  t('a second filter accumulates onto the same list', api.basket().length === 2);
  t('someone matching two filters is added once',
    api.basket().filter(r => r.email === 'a@x.com').length === 1);
  t('and the new person came along',
    api.basket().some(r => r.email === 'c@x.com'));
}

{
  const { api } = buildUI();
  api.setPreview(PREVIEW([R('A@X.com', 'A')]));
  api.addSelected();
  api.setPreview(PREVIEW([R('a@x.com', 'A again')]));
  api.addSelected();
  t('deduping is case-insensitive on the address', api.basket().length === 1);
}

{
  const { api } = buildUI();
  api.setPreview(PREVIEW([
    R('a@x.com', 'A'), R('bad@x.com', 'Bad', { invalid: true }), R('out@x.com', 'Out', { opted_out: true })
  ]));
  api.addSelected();
  t('blocked recipients never reach the list',
    api.basket().length === 1 && api.basket()[0].email === 'a@x.com');
}

{
  const { api } = buildUI();
  api.setPreview(PREVIEW([R('a@x.com', 'A'), R('b@x.com', 'B'), R('c@x.com', 'C')]));
  api.addSelected();
  t('three added', api.basket().length === 3);
  api.removeAt(1);
  t('removing by position drops exactly one',
    api.basket().length === 2 && !api.basket().some(r => r.email === 'b@x.com'));
  api.clear();
  t('clear empties the list', api.basket().length === 0);
}

console.log('\nWhat actually gets sent');
{
  const { api } = buildUI();
  api.compose().audienceType = 'area';
  api.compose().areas = ['North'];
  api.setPreview(PREVIEW([R('a@x.com', 'A'), R('b@x.com', 'B')]));

  const aud = api.sendAudience();
  t('an untouched preview still sends the FILTER, not a frozen list',
    aud.type === 'area' && aud.areas[0] === 'North',
    '→ ' + JSON.stringify(aud));

  api.toggle(0, false);
  const curated = api.sendAudience();
  t('unticking switches to an explicit list', curated.type === 'selected');
  t('containing only what stayed ticked',
    curated.recipients.length === 1 && curated.recipients[0].email === 'b@x.com');
}

{
  const { api } = buildUI();
  api.compose().audienceType = 'all_active';
  api.setPreview(PREVIEW([R('a@x.com', 'A')]));
  api.addSelected();
  api.setPreview(PREVIEW([R('z@x.com', 'Z')])); // a later, unrelated filter
  const aud = api.sendAudience();
  t('a built list wins over whatever filter is showing', aud.type === 'selected');
  t('and sends the list, not the current preview',
    aud.recipients.length === 1 && aud.recipients[0].email === 'a@x.com');
}

{
  const { api } = buildUI();
  api.setPreview(PREVIEW([R('a@x.com', 'A')]));
  api.addSelected();
  const sent = api.sendAudience().recipients[0];
  t('recipients keep the fields placeholders render from',
    sent.first_name === 'A' && Array.isArray(sent.properties) && sent.properties[0].day === 'Tuesday');
}

console.log('\nWiring the markup cannot execute');
{
  const src = fs.readFileSync(UI_SRC, 'utf8');
  t('the preview renders checkboxes bound to the toggle',
    /type="checkbox"[^>]*onchange="commsTogglePreviewRow\(\$\{i\},this\.checked\)"/.test(src));
  t('blocked rows render disabled', /\$\{blocked\?'disabled':''\}/.test(src));
  t('the compose screen has a from-line and a list container',
    /id="cm-from"/.test(src) && /id="cm-basket"/.test(src));
  t('send uses the curated audience, not the raw filter',
    /audience:_commsSendAudience\(\)/.test(src) && !/audience:_commsBuildAudience\(\)\s*\}/.test(src));
  t('a curated send does not re-preview and wipe the selection',
    /if \(!curated\) await commsPreviewAudience\(\)/.test(src));
  t('the confirm names the sending address', /From: \$\{_commsSender\.from_email\}/.test(src));
}

// ─── Back end: the `selected` audience type ──────────────────────────────────
console.log('\nServer keeps the rules for a hand-built list');
function buildBackend(optedOut = []) {
  const ctx = {
    console, JSON, Math, String, Number, Array, Object, RegExp, Date, isNaN, encodeURIComponent,
    Logger: { log: () => {} },
    Utilities: { getUuid: () => 'u', formatDate: d => new Date(d).toISOString() },
    SpreadsheetApp: { getActiveSpreadsheet: () => null, openById: () => null },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => '' }) },
    ScriptApp: { getProjectTriggers: () => [] },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'p@x.com' }), getActiveUser: () => ({ getEmail: () => '' }) },
    MailApp: { getRemainingDailyQuota: () => 1500 },
    GmailApp: { getAliases: () => [] },
    UrlFetchApp: { fetch: () => { throw new Error('no network'); } },
    huHeader_: h => String(h == null ? '' : h).trim().toLowerCase().replace(/ /g, '_')
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(COMMS_SRC, 'utf8'), ctx, { filename: 'Comms.js' });
  ctx.commsOptOutSet_ = () => optedOut.reduce((a, e) => (a[e.toLowerCase()] = true, a), {});
  ctx.commsEnsureSheets_ = () => {};
  return ctx;
}

{
  const ctx = buildBackend();
  const res = ctx.resolveCommsAudience_({
    type: 'selected',
    recipients: [
      { email: 'a@x.com', name: 'A', first_name: 'A', area: 'North',
        properties: [{ quote_id: 'Q1', day: 'Tuesday', operator: 'Tony' }] }
    ]
  }, 'marketing');
  t('a hand-built list resolves', res.ok === true && res.recipients.length === 1);
  t('and keeps the per-property data placeholders need',
    res.recipients[0].properties[0].day === 'Tuesday'
    && res.recipients[0].properties[0].operator === 'Tony');
}

{
  // The client picks WHO. It does not get to decide whether the rules apply.
  const ctx = buildBackend(['out@x.com']);
  const res = ctx.resolveCommsAudience_({
    type: 'selected',
    recipients: [
      { email: 'a@x.com', name: 'A', properties: [{}] },
      { email: 'out@x.com', name: 'Opted Out', properties: [{}] },
      { email: 'not-an-email', name: 'Broken', properties: [{}] }
    ]
  }, 'marketing');
  const sendable = res.recipients.filter(r => !r.invalid && !r.opted_out);
  t('an opt-out is re-applied server-side even if the client sent them',
    res.recipients.some(r => r.email === 'out@x.com' && r.opted_out === true));
  t('an invalid address is still flagged invalid',
    res.recipients.some(r => r.invalid === true));
  t('so only the genuinely sendable survive',
    sendable.length === 1 && sendable[0].email === 'a@x.com');
}

{
  const ctx = buildBackend();
  const res = ctx.resolveCommsAudience_({
    type: 'selected',
    recipients: [
      { email: 'dup@x.com', name: 'Dup', properties: [{ quote_id: 'Q1' }] },
      { email: 'DUP@x.com', name: 'Dup Again', properties: [{ quote_id: 'Q2' }] }
    ]
  }, 'announcement');
  t('the same address twice collapses to one recipient', res.recipients.length === 1);
  t('keeping both properties', res.recipients[0].properties.length === 2);
}

{
  const ctx = buildBackend();
  const res = ctx.resolveCommsAudience_({ type: 'selected', recipients: [] }, 'marketing');
  t('an empty list resolves to nobody rather than throwing',
    res.ok === true && res.recipients.length === 0);
}

{
  const ctx = buildBackend();
  const res = ctx.resolveCommsAudience_({
    type: 'selected', recipients: [{ email: 'a@x.com', name: 'A' }]
  }, 'marketing');
  t('a recipient with no properties array still resolves', res.recipients.length === 1);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
