// People search — broad search, conservative automatic identity linking.
//
//   node tests/people-search.test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = path.join(__dirname, '..', 'appscript/PeopleSearch.js');

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };

const CLIENT_HEADERS = [
  'client_id', 'first_name', 'last_name', 'display_name', 'email', 'phone',
  'billing_address', 'billing_city', 'billing_state', 'billing_zip', 'status',
  'created_at', 'updated_at', 'legacy_quote_ids', 'notes'
];
const LOCATION_HEADERS = [
  'location_id', 'client_id', 'pool_id', 'service_address', 'city', 'state',
  'zip_code', 'area', 'pool_type', 'pool_size', 'material', 'spa', 'finish',
  'debris_level', 'sun_exposure', 'pets_on_property', 'robot_on_site',
  'year_built', 'active', 'created_at', 'updated_at', 'notes'
];

function norm(h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); }

function build(opts) {
  const o = opts || {};
  const sheets = {
    Clients: { headers: CLIENT_HEADERS, rows: o.clients || [] },
    Client_Locations: { headers: LOCATION_HEADERS, rows: o.locations || [] }
  };
  const ctx = {
    console, Date, String, Number, Math, JSON, Array, Object, isNaN, Infinity, RegExp,
    Logger: { log: () => {} },
    MCPS_CLIENT_HEADERS: CLIENT_HEADERS,
    MCPS_LOCATION_HEADERS: LOCATION_HEADERS,
    value_: (obj, f, fallback) => (obj && obj[f] != null && obj[f] !== '' ? obj[f] : (fallback || '')),
    normalizeEmail_: v => String(v || '').trim().toLowerCase(),
    normalizePhone_: v => String(v || '').replace(/\D/g, ''),
    normalizeAddress_: v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
    ensureSheet_: name => ({ _name: name }),
    sheetToObjects_: sheet => ({
      headers: (sheets[sheet._name] || { headers: [] }).headers.map(norm),
      rows: (sheets[sheet._name] || { rows: [] }).rows.map((r, i) => Object.assign({ _rowNum: i + 2 }, r))
    })
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'PeopleSearch.js' });
  return ctx;
}

const CLIENTS = [
  { client_id: 'CLI-001', first_name: 'Tony', last_name: 'Siller', display_name: 'Tony Siller', email: 'tony@example.com', phone: '(210) 555-1000', status: 'active' },
  { client_id: 'CLI-002', first_name: 'Ana', last_name: 'Garcia', display_name: 'Ana Garcia', email: 'shared@example.com', phone: '(210) 555-2000', status: 'active' },
  { client_id: 'CLI-003', first_name: 'Luis', last_name: 'Garcia', display_name: 'Luis Garcia', email: 'shared@example.com', phone: '(210) 555-3000', status: 'active' }
];
const LOCS = [
  { location_id: 'LOC-001', client_id: 'CLI-001', pool_id: 'P-001', service_address: '123 Pool Lane', city: 'San Antonio', state: 'TX', zip_code: '78258', area: 'North', active: 'TRUE' },
  { location_id: 'LOC-002', client_id: 'CLI-002', pool_id: 'P-002', service_address: '500 Oak Bend', city: 'San Antonio', state: 'TX', zip_code: '78232', area: 'North', active: 'TRUE' },
  { location_id: 'LOC-003', client_id: 'CLI-003', pool_id: 'P-003', service_address: '700 South Trail', city: 'San Antonio', state: 'TX', zip_code: '78221', area: 'South', active: 'TRUE' }
];

console.log('\nPeople search finds by client and location fields');
{
  const ctx = build({ clients: CLIENTS, locations: LOCS });
  const byName = ctx.handleSearchPeople_({ q: 'Tony' });
  t('name search returns Tony', byName.ok && byName.people[0].client_id === 'CLI-001');
  t('locations ride with the person', byName.people[0].locations.length === 1);

  const byAddress = ctx.handleSearchPeople_({ q: 'Oak Bend' });
  t('address search returns the owning client', byAddress.people[0].client_id === 'CLI-002');
  t('the matched location is available to the UI', byAddress.people[0].locations[0].location_id === 'LOC-002');

  const byZip = ctx.handleSearchPeople_({ q: '78221' });
  t('ZIP search reaches location rows', byZip.people[0].client_id === 'CLI-003');
}

console.log('\nAutomatic identity linking needs a second signal');
{
  const ctx = build({ clients: CLIENTS, locations: LOCS });
  const emailOnly = ctx.findConfidentClientForQuote_({ email: 'tony@example.com' });
  t('email-only is NOT enough to auto-link', emailOnly === null);

  const phoneOnly = ctx.findConfidentClientForQuote_({ phone: '(210) 555-1000' });
  t('phone-only is NOT enough to auto-link', phoneOnly === null);

  const emailAndName = ctx.findConfidentClientForQuote_({ first_name: 'Tony', last_name: 'Siller', email: 'tony@example.com' });
  t('email + name is confident', emailAndName && emailAndName.client_id === 'CLI-001');

  const nameAndAddress = ctx.findConfidentClientForQuote_({
    first_name: 'Tony', last_name: 'Siller', address: '123 Pool Lane', zip_code: '78258'
  });
  t('name + address is confident', nameAndAddress && nameAndAddress.client_id === 'CLI-001');

  const phoneAndAddress = ctx.findConfidentClientForQuote_({
    phone: '(210) 555-1000', address: '123 Pool Lane', zip_code: '78258'
  });
  t('phone + address is confident', phoneAndAddress && phoneAndAddress.client_id === 'CLI-001');
}

console.log('Ambiguous shared contact data is surfaced for search but not auto-linked');
{
  const ctx = build({ clients: CLIENTS, locations: LOCS });
  const search = ctx.handleSearchPeople_({ q: 'shared@example.com' });
  const ids = (search.people || []).map(p => p.client_id);
  t('both shared-email people are search candidates',
    ids.indexOf('CLI-002') !== -1 && ids.indexOf('CLI-003') !== -1,
    '(got ' + ids.join(',') + ')');
  const linked = ctx.findConfidentClientForQuote_({ email: 'shared@example.com' });
  t('shared email alone still links nobody', linked === null);
}

if (fail) {
  console.log(`\n${fail} failing assertion(s), ${pass} passing`);
  process.exit(1);
}
console.log(`\nAll ${pass} assertions passed`);
