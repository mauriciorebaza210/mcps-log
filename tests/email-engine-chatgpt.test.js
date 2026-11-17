// ChatGPT access (Plan changes 2026-11-16): the dictionary covers every tab and column in
// code, stays in sync with the deployed copy, is published to Drive (nobody is emailed)
// once per version; and ChatGPT_Requests rows go through the portal's own actions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fakeWorld } = require('./helpers/ee-fake-env.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'email-engine', 'src');
const BC = JSON.parse(fs.readFileSync(path.join(ROOT, 'email-engine', 'seed', 'ruleset-bc.json'), 'utf8'));
const plain = x => JSON.parse(JSON.stringify(x));
const DICT = path.join(ROOT, 'email-engine', 'docs', 'chatgpt', 'DICTIONARY.md');

function load(files, extra) {
  const ctx = Object.assign({ JSON, Math, Date, Object, Array, String, Number, Error, RegExp, Intl, isFinite }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(files.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n'), ctx);
  return ctx;
}

// ── The dictionary ──
test('Dictionary: every tab and column in code has its own row, and the requests contract is documented', async () => {
  const md = fs.readFileSync(DICT, 'utf8');
  const ctx = load(['email-engine/src/Env.js', 'email-engine/src/Requests.js']);
  const section = name => {
    const m = md.split(/^### /m).find(s => s.split('\n')[0].trim() === name);
    assert.ok(m, 'no "### ' + name + '" section');
    return m;
  };
  const tabs = Object.assign({}, plain(ctx.EE_TABLES), { Events_YYYY_MM: plain(ctx.EE_EVENT_HEADERS), Journal: plain(ctx.EE_JOURNAL_HEADERS),
    [ctx.EE_REQUESTS_TAB]: plain(ctx.EE_REQUESTS_HEADERS) });
  const missing = [];
  for (const [tab, cols] of Object.entries(tabs)) {
    const s = section(tab);
    cols.forEach(c => { if (!s.includes('| `' + c + '` |')) missing.push(tab + '.' + c); });
  }
  assert.deepEqual(missing, [], 'columns without a dictionary row (add them to ' + path.relative(ROOT, DICT) + ' and bump its Version)');
  const req = section(ctx.EE_REQUESTS_TAB);
  Object.keys(ctx.EE_REQUEST_ACTIONS).forEach(a => assert.ok(req.includes('`' + a + '`'), 'request action ' + a + ' not documented'));
  Object.keys(ctx.EE_REQUEST_FIELDS).forEach(f => assert.ok(req.includes('`' + f + '`'), 'update_contact field ' + f + ' not documented'));
  const { parseDictionary } = await import(path.join(ROOT, 'scripts', 'ee-dictionary.mjs'));
  assert.deepEqual(parseDictionary(md).errors, []);
});

test('Dictionary: the deployed copy (Dictionary.js) is the current text', async () => {
  const { dictionaryJs } = await import(path.join(ROOT, 'scripts', 'ee-dictionary.mjs'));
  assert.equal(fs.readFileSync(path.join(SRC, 'Dictionary.js'), 'utf8'), dictionaryJs(fs.readFileSync(DICT, 'utf8')), 'run node scripts/ee-sync.mjs');
});

test('Dictionary parser: version line, newest-first changes, bullets required', async () => {
  const { parseDictionary } = await import(path.join(ROOT, 'scripts', 'ee-dictionary.mjs'));
  const good = '# D\nVersion: 2 (2026-11-20)\n\n## What changed\n### Version 2 — 2026-11-20\n- New column.\n### Version 1 — 2026-11-16\n- First version.\n';
  const d = parseDictionary(good);
  assert.deepEqual([d.errors, d.version, d.changes.map(c => c.version), d.changes[0].items], [[], 2, [2, 1], ['New column.']]);
  assert.ok(parseDictionary(good.replace('Version: 2', 'Version: 3')).errors.length, 'a version without its What changed entry');
  assert.ok(parseDictionary(good.replace('- New column.\n', '')).errors.length, 'an entry without bullets');
  assert.ok(parseDictionary('# D\n## What changed\n').errors.length);
});

// ── Publishing to Drive (no email to anyone) ──
function publisher() {
  const ctx = load(['email-engine/src/Docs.js']);
  const s = { props: {}, files: [] };
  const deps = { props: { get: k => s.props[k] || null, set: (k, v) => { s.props[k] = v; } },
    writeFile: (n, t) => { s.files.push([n, t]); return 'https://drive/file1'; } };
  s.publish = dict => plain(ctx.EE_publishDictionaryWith_(dict, deps));
  s.src = fs.readFileSync(path.join(__dirname, '..', 'email-engine', 'src', 'Docs.js'), 'utf8');
  return s;
}
const dict = (version, hash) => ({ version, hash, text: 'text ' + hash, changes: [] });

test('Publish: new text rewrites the Drive file once; same text writes nothing', () => {
  const s = publisher();
  assert.deepEqual(s.publish(dict(1, 'h1')), { wrote: true });
  assert.equal(s.files[0][0], 'Email Engine Dictionary - ChatGPT.txt');
  assert.deepEqual(s.publish(dict(1, 'h1')), { wrote: false });
  assert.deepEqual(s.publish(dict(2, 'h2')), { wrote: true });
  assert.equal(s.files.length, 2);
});

test('Publish: nobody is emailed about dictionary changes (Mau, 2026-11-16)', () => {
  const s = publisher();
  assert.doesNotMatch(s.src, /GmailApp|MailApp|sendMail|sendEmail/);
});

// ── ChatGPT_Requests ──
function engine(today) {
  const w = fakeWorld();
  w.now = Date.parse(today + 'T15:00:00Z');
  const ctx = load(['js/lib/lifecycle-rules.js', 'js/lib/batches.js'].concat(['email-engine/src/Admin.js', 'email-engine/src/Requests.js']));
  vm.runInContext('var EE_TZ = "America/Chicago";', ctx);
  w.env.journal.opIds = () => { const s = {}; w.journal.forEach(r => { s[r.op_id] = true; }); return s; };
  w.env.journal.appendMany = recs => recs.forEach(r => w.journal.push(JSON.parse(JSON.stringify(r))));
  w.env.store.upsertMany = (name, rows) => rows.forEach(r => w.env.store.upsert(name, r));
  w.tables.Rulesets.push({ rule_rev: 'bc-1', json: plain(BC), published_at: '', published_by: 'seed' });
  w.tables.Config.push({ key: 'rule_rev', value: 'bc-1' });
  const deps = { scheduleRun: () => 'queued', planRuns: () => ({ times: [] }) };
  w.admin = (action, params) => plain(ctx.EE_adminRun_(w.env, w.core, { action, params, actor: 'mau' }, deps));
  w.byEmail = e => plain(w.tables.Contacts.find(c => c.email_norm === e));
  w.sheet = [];
  w.request = rows => {
    rows.forEach(r => w.sheet.push(Object.assign({ row: w.sheet.length + 2 }, r)));
    const sheet = { rows: () => w.sheet.map(r => Object.assign({}, r)), write: (row, vals) => Object.assign(w.sheet.find(r => r.row === row), vals) };
    return plain(ctx.EE_processRequests_(w.env, w.core, sheet, deps));
  };
  w.last = () => w.sheet[w.sheet.length - 1];
  return w;
}
const person = (email, extra) => Object.assign({ email_norm: email, first_name: 'Ann', last_name: 'Lee' }, extra || {});

test('Requests: contact edits and tags go through update_contacts (journaled, logged as chatgpt)', () => {
  const w = engine('2026-11-16');
  w.admin('import_contacts', { group: 'B', contacts: [person('a@x.com', { tags: 'vip' })] });
  const r = w.request([{ action: 'update_contact', contact: 'A@x.com', field: 'phone', value: '210-555-0100' },
    { action: 'add_tags', contact: 'a@x.com', value: 'Spa, vip' },
    { action: 'remove_tags', contact: 'a@x.com', value: 'vip' },
    { action: 'update_contact', contact: 'a@x.com', field: 'pool_id', value: 'X' },
    { action: 'update_contact', contact: 'nobody@x.com', field: 'phone', value: '1' }]);
  assert.deepEqual(r, { done: 3, refused: 2, error: 0, left: 0 });
  const a = w.byEmail('a@x.com');
  assert.deepEqual([a.phone, a.tags], ['210-555-0100', 'spa']);
  assert.deepEqual(w.sheet.map(x => x.status), ['done', 'done', 'done', 'refused', 'refused']);
  assert.match(w.sheet[3].result, /field must be one of/);
  assert.ok(w.sheet.every(x => /^\d{4}-\d{2}-\d{2}T/.test(x.done_at)));
  assert.ok(w.journal.some(j => j.type === 'contact' && j.data.phone === '210-555-0100'), 'journaled, not typed into the sheet');
  assert.ok(w.tables.ChangeLog.some(c => c.actor === 'chatgpt' && c.action === 'update_contacts'));
  // Processed rows are never run twice.
  assert.deepEqual(w.request([]), { done: 0, refused: 0, error: 0, left: 0 });
});

test('Requests: an email change refuses an address that belongs to someone else', () => {
  const w = engine('2026-11-16');
  w.admin('import_contacts', { group: 'B', contacts: [person('a@x.com'), person('b@x.com')] });
  w.request([{ action: 'update_contact', contact: 'a@x.com', field: 'email', value: 'b@x.com' }]);
  assert.equal(w.last().status, 'refused');
  w.request([{ action: 'update_contact', contact: 'a@x.com', field: 'email', value: 'new@x.com' }]);
  assert.equal(w.last().status, 'done');
  assert.equal(w.byEmail('new@x.com').alt_emails, 'a@x.com');
});

test('Requests: opt_out records a real opt-out (Comms_Optouts), also for an address not in the engine', () => {
  const w = engine('2026-11-16');
  w.admin('import_contacts', { group: 'B', contacts: [person('a@x.com')] });
  w.request([{ action: 'opt_out', contact: 'a@x.com' }, { action: 'opt_out', contact: 'stranger@y.com', value: 'marketing' },
    { action: 'opt_out', contact: 'not an email' }]);
  assert.deepEqual(w.sheet.map(x => x.status), ['done', 'done', 'refused']);
  assert.ok(w.tables.Inbox.some(i => i.type === 'unsubscribe' && i.email_norm === 'a@x.com' && i.scope === 'all'));
  assert.ok(w.tables.Inbox.some(i => i.email_norm === 'stranger@y.com' && i.scope === 'marketing'));
  assert.ok(w.optouts.some(o => o.email === 'a@x.com'), 'on the shared opt-out list');
});

test('Requests: flag takes a waiting person out of their batch; unflag puts them back; batches move by date', () => {
  const w = engine('2026-11-16');
  w.admin('import_contacts', { group: 'B', contacts: [person('a@x.com', { planned_start: '2026-11-23' }), person('b@x.com', { planned_start: '2026-11-23' })] });
  w.admin('plan_import_batches', { group: 'B' });
  const batch = () => plain(w.tables.Batches.find(b => b.start_on === '2026-11-23'));
  w.request([{ action: 'flag', contact: 'a@x.com', value: 'Commercial property' }]);
  assert.equal(w.last().status, 'done', w.last().result);
  assert.deepEqual([w.byEmail('a@x.com').review_status, w.byEmail('a@x.com').flag_reason], ['flagged', 'Commercial property']);
  assert.deepEqual(batch().contact_ids, [w.byEmail('b@x.com').contact_id]);
  w.request([{ action: 'flag', contact: 'b@x.com' }]);
  assert.match(w.last().result, /reason/);
  w.request([{ action: 'move_to_batch', contact: 'a@x.com', value: '2026-11-30' }]);
  assert.equal(w.last().status, 'refused', 'flagged people stay out of batches');
  w.request([{ action: 'unflag', contact: 'a@x.com' }]);
  assert.equal(w.byEmail('a@x.com').review_status, 'needs_review');
  w.request([{ action: 'move_to_batch', contact: 'a@x.com', value: '2026-11-30' }]);
  assert.equal(w.last().status, 'done', w.last().result);
  assert.equal(w.byEmail('a@x.com').planned_start, '2026-11-30');
  w.request([{ action: 'remove_from_batch', contact: 'b@x.com' }, { action: 'move_to_batch', contact: 'a@x.com', value: 'next week' }]);
  assert.deepEqual(w.sheet.slice(-2).map(x => x.status), ['done', 'refused']);
  assert.equal(w.byEmail('b@x.com').planned_start, '');
});

test('Requests: stop_emails stops a running sequence; unknown actions and the per-pass limit', () => {
  const w = engine('2026-11-16');
  w.admin('import_contacts', { group: 'B', contacts: [person('a@x.com')] });
  const id = w.byEmail('a@x.com').contact_id;
  w.request([{ action: 'stop_emails', contact: 'a@x.com' }]);
  assert.equal(w.last().status, 'refused', 'nothing running yet');
  w.tables.Enrollments.push({ enrollment_id: 'e1', contact_id: id, sequence_id: 'B', status: 'active', last_seq: 0 });
  w.request([{ action: 'stop_emails', contact: id }]);
  assert.equal(w.last().status, 'done', w.last().result);
  assert.deepEqual([w.tables.Enrollments[0].status, w.tables.Enrollments[0].stop_reason], ['stopped', 'stopped_by_request']);
  w.request([{ action: 'approve', contact: 'a@x.com' }]);
  assert.match(w.last().result, /unknown action/);
  const many = Array.from({ length: 45 }, () => ({ action: 'add_tags', contact: 'a@x.com', value: 'x' }));
  assert.equal(w.request(many).left, 5);
});
