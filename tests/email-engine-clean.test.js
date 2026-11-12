// Contact cleanup and duplicates (PLAN.md → "Contact cleanup and duplicates"):
// js/lib/contact-clean.js rules, api/_lib/email-clean.js (imports, scan), the AI name
// check with a fake model (api/_lib/name-ai.js), and the engine's edit/merge actions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const C = require('../js/lib/contact-clean.js');
const { fakeWorld } = require('./helpers/ee-fake-env.js');
const ROOT = path.join(__dirname, '..');

const nm = (f, l) => { const r = C.name(f, l); return [r.first_name, r.last_name, r.kind]; };

test('Names: capitals fixed only when typed all upper or all lower; Mc, O\', particles, suffixes, initials', () => {
  assert.deepEqual(nm('JOSE', 'RODRIGUEZ'), ['Jose', 'Rodriguez', 'person']);
  assert.deepEqual(nm('sean', "o'brien"), ['Sean', "O'Brien", 'person']);
  assert.deepEqual(nm('PATRICK', 'MCDONALD'), ['Patrick', 'McDonald', 'person']);
  assert.deepEqual(nm('maria', 'de la cruz'), ['Maria', 'De la Cruz', 'person']);
  assert.deepEqual(nm('robert', 'smith jr'), ['Robert', 'Smith Jr.', 'person']);
  assert.deepEqual(nm('DeShawn', 'Williams'), ['DeShawn', 'Williams', 'person'], 'mixed case is left alone');
  assert.deepEqual(nm('mary-kate', 'olsen'), ['Mary-Kate', 'Olsen', 'person']);
});

test('One field, flipped, titles and placeholders', () => {
  assert.deepEqual(nm('JOSE RODRIGUEZ', ''), ['Jose', 'Rodriguez', 'person']);
  assert.deepEqual(nm('MCDONALD, PATRICK', ''), ['Patrick', 'McDonald', 'person']);
  assert.deepEqual(nm('Mrs. Ana Diaz', ''), ['Ana', 'Diaz', 'person']);
  for (const p of ['N/A', 'unknown', 'Homeowner', '---']) assert.deepEqual(nm(p, ''), ['', '', 'person'], p);
  assert.equal(C.name('Mary Ann Smith', '').needs_ai, true, '3 words in one field: the AI decides');
});

test('Couples, families, businesses', () => {
  assert.deepEqual(nm('john & mary smith', ''), ['John and Mary', 'Smith', 'couple']);
  assert.deepEqual(nm('John and Mary', 'Smith'), ['John and Mary', 'Smith', 'couple']);
  assert.deepEqual(nm('Juan y Rosa', 'Garza'), ['Juan and Rosa', 'Garza', 'couple']);
  assert.deepEqual(nm('Mr. & Mrs. John Smith', ''), ['Mr. and Mrs. Smith', 'Smith', 'couple']);
  const two = C.name('John Smith / Mary Jones', '');
  assert.equal(two.kind, 'couple'); assert.equal(two.needs_ai, true, 'two surnames: the AI decides');
  assert.deepEqual(nm('Smith Family', ''), ['Smith family', 'Smith', 'family']);
  assert.deepEqual(nm('The Smiths', ''), ['Smith family', 'Smith', 'family']);
  assert.deepEqual(nm('Familia GARZA', ''), ['Familia Garza', 'Garza', 'family']);
  assert.deepEqual(nm('ABC POOLS LLC', ''), ['', 'ABC POOLS LLC', 'business']);
});

test('Phones, places, email warnings (suggested, never changed)', () => {
  assert.equal(C.phone('210.555.1234'), '(210) 555-1234');
  assert.equal(C.phone('+1 210 555 1234'), '(210) 555-1234');
  assert.equal(C.phone('ext 12'), 'ext 12');
  assert.equal(C.place('123 OAK HOLLOW DR NW'), '123 Oak Hollow Dr NW');
  assert.equal(C.place('San Antonio'), 'San Antonio');
  assert.deepEqual(C.emailIssues('info@gmial.com'), [{ kind: 'role' }, { kind: 'typo', suggestion: 'info@gmail.com' }]);
  assert.deepEqual(C.emailIssues('jo@yahooo.com'), [{ kind: 'typo', suggestion: 'jo@yahoo.com' }]);
  assert.deepEqual(C.emailIssues('ana@gmail.com'), []);
});

test('Duplicates: same email, same Gmail inbox, same person, similar name, same household', () => {
  const engine = [
    { contact_id: 'e1', email_norm: 'ana.diaz@gmail.com', first_name: 'Ana', last_name: 'Diaz', address: '12 Oak Street', city: 'Boerne' },
    { contact_id: 'e2', email_norm: 'bo@example.com', first_name: 'Bo', last_name: 'Kim', address: '9 Elm Dr, Helotes' }
  ];
  const r = (row, o) => ({ row, ...o });
  const pairs = C.duplicates([
    r(1, { email_norm: 'ana.diaz@gmail.com', first_name: 'Ana' }),
    r(2, { email_norm: 'anadiaz+pool@gmail.com', first_name: 'A' }),
    r(3, { email_norm: 'other@x.com', first_name: 'Ana', last_name: 'Diaz', address: '12 Oak St', city: 'Boerne' }),
    r(4, { email_norm: 'b2@x.com', first_name: 'Bo', last_name: 'Kimm', address: '9 Elm Drive', city: 'Helotes' }),
    r(5, { email_norm: 'wife@x.com', first_name: 'Sue', last_name: 'Diaz', address: '12 oak st', city: 'boerne' }),
    r(6, { email_norm: 'new@x.com', first_name: 'New', address: '1 Far Rd', city: 'Boerne' })
  ], engine);
  assert.deepEqual(pairs.map(p => [p.a.row, p.b.contact_id, p.reason]),
    [[1, 'e1', 'same_email'], [2, 'e1', 'same_inbox'], [3, 'e1', 'same_person'], [4, 'e2', 'similar_name'], [5, 'e1', 'same_household']]);
});

test('Import pipeline: names tidied (original kept), possible duplicates flagged with the match', async () => {
  const { cleanIncoming, flagDuplicates, scanEngine } = await import(path.join(ROOT, 'api', '_lib', 'email-clean.js'));
  const { checkImport } = await import(path.join(ROOT, 'api', '_lib', 'email-import.js'));
  const engine = [{ contact_id: 'e1', email_norm: 'ana@x.com', first_name: 'Ana', last_name: 'Diaz', address: '12 Oak St', city: 'Boerne', review_status: 'needs_review' }];
  const rows = cleanIncoming([{ row: 1, email_norm: 'sue@x.com', first_name: 'SUE DIAZ', last_name: '', address: '12 OAK ST', city: 'BOERNE' },
    { row: 2, email_norm: 'mo@x.com', first_name: 'mo & li chen', address: '5 Pine Rd', city: 'Boerne' }]);
  assert.deepEqual([rows[0].first_name, rows[0].last_name, rows[0].name_original], ['Sue', 'Diaz', 'SUE DIAZ']);
  assert.equal(rows[1].name_kind, 'couple');
  const v = flagDuplicates(checkImport(rows, { engineContacts: engine }).rows, rows, engine);
  assert.equal(v[0].status, 'possible_duplicate');
  assert.deepEqual([v[0].match.contact_id, v[0].match.reason], ['e1', 'same_household']);
  assert.equal(v[1].status, 'new');
  const scan = scanEngine([...engine, { contact_id: 'e2', email_norm: 'x@gmial.com', first_name: 'JOHN', last_name: 'SMITH' },
    { contact_id: 'e3', email_norm: 'sue@x.com', first_name: 'Sue', last_name: 'Diaz', address: '12 Oak Street', city: 'Boerne', not_duplicate_of: 'e1' }]);
  assert.deepEqual(scan.names.map(n => [n.contact_id, n.after.first_name, n.issues.length]), [['e2', 'John', 1]]);
  assert.deepEqual(scan.pairs, [], 'e1/e3 marked "not duplicates" earlier');
});

test('AI names: answers must use only words from the original; unclear and invented answers are dropped; no key → off', async () => {
  const ai = await import(path.join(ROOT, 'api', '_lib', 'name-ai.js'));
  assert.equal(ai.NAME_MODEL, 'claude-haiku-5-5');
  let sent = null;
  const client = { messages: { parse: async req => { sent = req; return { stop_reason: 'end_turn', parsed_output: { names: [
    { i: 0, first_name: 'Mary Ann', last_name: 'Smith', kind: 'person', greeting: 'Mary Ann' },
    { i: 1, first_name: 'Jose', last_name: 'Rodriguez Garza', kind: 'person', greeting: 'Jose' },
    { i: 2, first_name: 'Robert', last_name: 'Lee', kind: 'person', greeting: 'Bob' },                // "Bob" invented
    { i: 3, first_name: 'X', last_name: 'Y', kind: 'unclear', greeting: '' }] } }; } } };
  const out = await ai.askNames([{ i: 0, name: 'Mary Ann Smith' }, { i: 1, name: 'JOSE RODRIGUEZ GARZA' }, { i: 2, name: 'Robert Lee' }, { i: 3, name: 'X Y' }], { client });
  assert.deepEqual(out.map(o => o.i), [0, 1]);
  assert.equal(sent.model, 'claude-haiku-5-5');
  assert.equal(sent.output_config.effort, 'low');
  assert.ok(!/@|\d{3}/.test(sent.messages[0].content), 'only names are sent');
  assert.deepEqual(await ai.askNames([{ i: 0, name: 'a b c' }], { apiKey: '' }), { error: 'ai_off' });
});

function engine() {
  const w = fakeWorld();
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error, RegExp, Intl, isFinite };
  vm.createContext(ctx);
  vm.runInContext(['js/lib/lifecycle-rules.js', 'js/lib/batches.js'].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n') +
    '\nvar EE_TZ = "America/Chicago";\n' + fs.readFileSync(path.join(ROOT, 'email-engine', 'src', 'Admin.js'), 'utf8'), ctx);
  w.admin = (action, params) => ctx.EE_adminRun_(w.env, w.core, { action, params, actor: 'mau' }, {});
  w.c = id => w.tables.Contacts.find(c => c.contact_id === id);
  w.tables.Contacts.push(
    { contact_id: 'a', email_norm: 'ana@x.com', first_name: 'ANA', last_name: 'DIAZ', bucket: 'B', review_status: 'needs_review', phone: '' },
    { contact_id: 'b', email_norm: 'ana.d@y.com', first_name: 'Ana', last_name: 'Diaz', bucket: 'B', review_status: 'possible_duplicate', duplicate_of: 'a', phone: '(210) 555-1234' },
    { contact_id: 'c', email_norm: 'cy@x.com', first_name: 'Cy', bucket: 'B', review_status: 'needs_review' });
  return w;
}

test('Engine: update_contacts keeps the original name; refuses someone else\'s email; old email kept as alternate', () => {
  const w = engine();
  assert.equal(w.admin('update_contacts', { changes: [{ contact_id: 'a', fields: { first_name: 'Ana', last_name: 'Diaz', name_kind: 'person' } }] }).updated, 1);
  assert.deepEqual([w.c('a').first_name, w.c('a').name_original], ['Ana', 'ANA DIAZ']);
  w.admin('update_contacts', { changes: [{ contact_id: 'c', fields: { email_norm: 'ana@x.com' } }] });
  assert.equal(w.c('c').email_norm, 'cy@x.com', 'another contact\'s email is refused');
  w.admin('update_contacts', { changes: [{ contact_id: 'c', fields: { email_norm: 'cy@gmail.com' } }] });
  assert.deepEqual([w.c('c').email_norm, w.c('c').alt_emails], ['cy@gmail.com', 'cy@x.com']);
});

test('Engine: resolve duplicates — merge (email becomes alternate, blanks filled, sequence stopped), keep both (never flagged again), keep one', () => {
  const w = engine();
  w.tables.Enrollments.push({ enrollment_id: 'eb', contact_id: 'b', status: 'active' });
  assert.equal(w.admin('resolve_duplicates', { pairs: [{ a: 'a', b: 'b', action: 'merge_into_a' }] }).resolved, 1);
  assert.deepEqual([w.c('a').alt_emails, w.c('a').phone], ['ana.d@y.com', '(210) 555-1234']);
  assert.deepEqual([w.c('b').review_status, w.c('b').merged_into, w.tables.Enrollments[0].stop_reason], ['merged', 'a', 'merged']);
  const w2 = engine();
  w2.admin('resolve_duplicates', { pairs: [{ a: 'a', b: 'b', action: 'keep_both' }] });
  assert.deepEqual([w2.c('b').review_status, w2.c('b').not_duplicate_of, w2.c('a').not_duplicate_of], ['needs_review', 'a', 'b']);
  const w3 = engine();
  w3.admin('resolve_duplicates', { pairs: [{ a: 'a', b: 'b', action: 'keep_a' }] });
  assert.equal(w3.c('b').review_status, 'removed');
});

test('Engine: apply_incoming merge fills blanks only; replace makes the new email primary and keeps the old one', () => {
  const w = engine();
  w.admin('apply_incoming', { contact_id: 'a', mode: 'merge', data: { email_norm: 'new@z.com', phone: '(210) 000-0000', first_name: 'Other' } });
  assert.deepEqual([w.c('a').phone, w.c('a').first_name, w.c('a').alt_emails], ['(210) 000-0000', 'ANA', 'new@z.com']);
  w.admin('apply_incoming', { contact_id: 'c', mode: 'replace', data: { email_norm: 'cy2@z.com', first_name: 'Cyrus' } });
  assert.deepEqual([w.c('c').email_norm, w.c('c').first_name, w.c('c').alt_emails], ['cy2@z.com', 'Cyrus', 'cy@x.com']);
  assert.equal(w.admin('import_contacts', { group: 'B', contacts: [{ email_norm: 'dup@z.com', first_name: 'D', duplicate_of: 'a' }] }).added, 1);
  assert.equal(w.tables.Contacts.find(c => c.email_norm === 'dup@z.com').review_status, 'possible_duplicate', 'flagged imports wait for review');
});
