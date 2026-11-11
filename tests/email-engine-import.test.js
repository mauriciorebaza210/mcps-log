// Contact import (js/lib/contact-import.js) against spreadsheets in different
// shapes, since there is no sample of the real MCP Legacy list yet.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const I = require('../js/lib/contact-import.js');

function run(text, opts) {
  const rows = typeof text === 'string' ? I.parseDelimited(text) : text;
  const h = I.findHeaderRow(rows);
  const map = I.suggestMapping(rows[h], rows.slice(h + 1, h + 11));
  return { rows, h, map, named: Object.fromEntries(Object.entries(map).map(([i, f]) => [rows[h][i], f])), out: I.toContacts(rows, h, map, opts) };
}

test('A: a clean CSV maps itself and normalizes', () => {
  const r = run('First Name,Last Name,Email,Phone,Address,City,State,Zip\n' +
    'maria,LOPEZ,Maria.Lopez@Example.com ,210.555.0101,118 Canyon Oak,boerne,tx,78006\n' +
    'James,Park,james@example.com,(830) 555-0102,9 Elm St,Castroville,TX,78009\n');
  assert.deepEqual(r.named, { 'First Name': 'first_name', 'Last Name': 'last_name', Email: 'email', Phone: 'phone', Address: 'address', City: 'city', State: 'state', Zip: 'zip' });
  const m = r.out.contacts[0];
  assert.deepEqual([m.first_name, m.last_name, m.email_norm, m.phone, m.city, m.state], ['Maria', 'Lopez', 'maria.lopez@example.com', '(210) 555-0101', 'Boerne', 'TX']);
  assert.equal(m.area, 'Boerne', 'area falls back to the city');
  assert.equal(r.out.contacts.length, 2);
});

test('B: an Excel-style export with title rows, full names, a full address, Excel dates and a DNC column', () => {
  const rows = [
    ['MCP Customers 2019–2024', '', '', ''], ['Exported Nov 2026', '', '', ''], [],
    ['Customer Name', 'E-mail Address', 'Mobile', 'Property Address', 'Build Date', 'Notes', 'DNC'],
    ['Mr. and Mrs. John Smith', 'jsmith@example.com', '2105550199', '45 Ranch Rd, Helotes, TX 78023', 44197, 'Spa + waterfall', ''],
    ['Garza, Linda', 'linda.garza@example.com', '+1 210 555 0142', '7 Oak Hollow, Boerne, TX', '2019-05-02', '', 'Yes']
  ];
  const r = run(rows);
  assert.equal(r.h, 3, 'header found under the title rows');
  assert.deepEqual(r.named, { 'Customer Name': 'full_name', 'E-mail Address': 'email', Mobile: 'phone', 'Property Address': 'address', 'Build Date': 'pool_build_year', Notes: 'notes', DNC: 'do_not_contact' });
  const [smith, garza] = r.out.contacts;
  assert.deepEqual([smith.first_name, smith.last_name, smith.pool_build_year, smith.phone], ['John', 'Smith', '2021', '(210) 555-0199']);
  assert.deepEqual([garza.first_name, garza.last_name, garza.pool_build_year, garza.do_not_contact], ['Linda', 'Garza', '2019', true]);
  assert.equal(garza.address, '7 Oak Hollow, Boerne, TX');
});

test('C: a tab-separated paste from Google Sheets with lowercase headers and tags', () => {
  const r = run('Name\temail\tphone #\tstreet\tcity\tzip\ttags\n' +
    'Elena Flores\telena@example.com\t210-555-0111\t12 Vista Ln\tHelotes\t78023\tVIP; spa\n');
  assert.deepEqual(r.named, { Name: 'full_name', email: 'email', 'phone #': 'phone', street: 'street', city: 'city', zip: 'zip', tags: 'tags' });
  const c = r.out.contacts[0];
  assert.equal(c.address, '12 Vista Ln, Helotes, 78023');
  assert.deepEqual(c.tags, ['vip', 'spa']);
});

test('D: messy rows: two emails in a cell, missing and bad emails, duplicates in the file, quoted commas, CRLF', () => {
  const r = run('Full Name,Email,Address\r\n' +
    '"Reyes, Carlos","CARLOS@Example.com; carlos.work@example.com","1 Main St, Apt 2, San Antonio"\r\n' +
    'Ana Castillo,,3 Pine Rd\r\n' +
    'Bob Stone,bob at example dot com,4 Elm\r\n' +
    'Carlos Reyes Jr,carlos@example.com,9 Other St\r\n' +
    '\r\n' +
    'Rosa Silva, rosa@example.com ,"5 Cedar, Boerne"\r\n');
  assert.deepEqual(r.out.contacts.map(c => [c.row, c.first_name, c.last_name, c.email_norm]),
    [[2, 'Carlos', 'Reyes', 'carlos@example.com'], [7, 'Rosa', 'Silva', 'rosa@example.com']]);
  assert.equal(r.out.contacts[0].address, '1 Main St, Apt 2, San Antonio', 'quoted commas kept');
  assert.deepEqual(r.out.skipped.map(s => [s.row, s.reason]), [[3, 'no_email'], [4, 'bad_email']]);
  assert.deepEqual(r.out.duplicates, [{ row: 5, email: 'carlos@example.com', first_row: 2 }], 'first row wins');
});

test('E: unhelpful headers: columns recognized from their values', () => {
  const r = run('Col A,Col B,Col C,Col D\nMaria Lopez,maria@example.com,2105550101,78006\nJames Park,james@example.com,8305550102,78009\nLinda Garza,linda@example.com,2105550103,78023\n');
  assert.equal(r.map[1], 'email');
  assert.equal(r.map[2], 'phone');
  assert.equal(r.map[3], 'zip');
  assert.equal(r.map[0], undefined, 'a name column with no header hint is left for the person to map');
});

test('A saved mapping is found again for a file with the same headers in another order', () => {
  assert.equal(I.mappingKey(['Email', 'First Name', 'Last Name']), I.mappingKey(['last name', 'FIRST NAME', 'E-mail'].map(x => x === 'E-mail' ? 'Email' : x)));
  assert.notEqual(I.mappingKey(['Email', 'Name']), I.mappingKey(['Email', 'Phone']));
});

test('Names: comma order, titles, single words, Spanish compound surnames', () => {
  assert.deepEqual(I.splitName('Lopez, Maria'), { first: 'Maria', last: 'Lopez' });
  assert.deepEqual(I.splitName('Dr. Ana de la Cruz'), { first: 'Ana', last: 'de la Cruz' }, 'mixed case is kept as written');
  assert.deepEqual(I.splitName('ANA DE LA CRUZ'), { first: 'Ana', last: 'De La Cruz' }, 'all caps is fixed');
  assert.deepEqual(I.splitName('MADONNA'), { first: 'Madonna', last: '' });
});
