// Identity matcher guard.
//
//   node tests/service-request-identity.test.mjs
//
// This is the test that protects Mau's hard requirement: a request from someone
// already in the CRM must attach to them, and a request from a stranger must
// never be glued onto a real customer.
//
// The two failure modes are opposite and both bad:
//   FALSE NEGATIVE — a returning customer is treated as new → duplicate person
//   FALSE POSITIVE — a stranger is matched to a customer → their request lands
//                    on someone else's pool, and the wrong person gets scheduled
// The false positive is the worse one, which is why the matcher refuses ties.

import {
  findMatch, scoreIdentity, buildInput,
  normEmail, normPhone, normAddress, normName
} from '../api/_lib/identity.js';

let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail ? '  ' + detail : '')); }
};
const section = name => console.log('\n' + name);

// ── Fixtures ────────────────────────────────────────────────────────────────
const CLIENTS = [
  { client_id: 'CLI-000001', first_name: 'Robert', last_name: 'Pompa',
    display_name: 'Robert Pompa', email: 'rpompa@example.com',
    phone: '(210) 555-0142', status: 'ACTIVE_CUSTOMER' },
  { client_id: 'CLI-000002', first_name: 'Maria', last_name: 'Gonzalez',
    display_name: 'Maria Gonzalez', email: 'maria.g@example.com',
    phone: '210-555-0199', status: 'LEAD' },
  // Same surname, different person, different everything else.
  { client_id: 'CLI-000003', first_name: 'Luis', last_name: 'Pompa',
    display_name: 'Luis Pompa', email: 'luis@example.com',
    phone: '2105550177', status: 'LEAD' }
];

const LOCATIONS = [
  { location_id: 'LOC-000001', client_id: 'CLI-000001', pool_id: 'MCPS-0042',
    service_address: '18538 Shadow Canyon Dr', city: 'San Antonio', zip_code: '78259' },
  { location_id: 'LOC-000002', client_id: 'CLI-000002', pool_id: '',
    service_address: '4640 S Flores Rd', city: 'Elmendorf', zip_code: '78112' }
];

const QUOTES = [
  // The Clients-row twin of Robert. A real returning customer looks like this.
  { quote_id: 'Q-aaaa1111', client_id: 'CLI-000001', location_id: 'LOC-000001',
    pool_id: 'MCPS-0042', first_name: 'Robert', last_name: 'Pompa',
    email: 'rpompa@example.com', phone: '(210) 555-0142',
    address: '18538 Shadow Canyon Dr', zip_code: '78259', status: 'ACTIVE_CUSTOMER' },
  // An MCP past client: a LEAD row on Quotes with NO Clients row at all.
  { quote_id: 'Q-bbbb2222', client_id: '', location_id: '', pool_id: '',
    first_name: 'Dana', last_name: 'Whitfield', email: 'dana.w@example.com',
    phone: '210-555-0123', address: '77 Cypress Cove', zip_code: '78015',
    status: 'LEAD' }
];

const find = submitted => findMatch(submitted, CLIENTS, LOCATIONS, QUOTES);

// ── Normalisers ─────────────────────────────────────────────────────────────
section('Normalisers');
t('email lowercased and trimmed', normEmail('  RPompa@Example.COM ') === 'rpompa@example.com');
t('phone strips formatting', normPhone('(210) 555-0142') === '2105550142');
t('phone drops US country code', normPhone('+1 210 555 0142') === '2105550142');
t('phone forms agree', normPhone('210.555.0142') === normPhone('2105550142'));
t('address folds Dr/Drive', normAddress('18538 Shadow Canyon Dr') === normAddress('18538 Shadow Canyon Drive'));
t('address folds Ln/Lane and trailing punctuation', normAddress('123 Pool Ln') === normAddress('123 pool lane.'));
t('address folds St/Street', normAddress('9 Main St') === normAddress('9 Main Street'));
t('address folds direction words', normAddress('4640 S Flores Rd') === normAddress('4640 South Flores Road'));
t('different addresses stay different', normAddress('18538 Shadow Canyon Dr') !== normAddress('18539 Shadow Canyon Dr'));
t('name collapses whitespace/case', normName('  Robert   POMPA ') === 'robert pompa');

// ── Scoring ─────────────────────────────────────────────────────────────────
section('Scoring — two signals required');
const addrs = [{ address: '18538 Shadow Canyon Dr', zip: '78259' }];
t('email alone is not confident',
  scoreIdentity(buildInput({ email: 'rpompa@example.com' }), CLIENTS[0], []).confident === false);
t('phone alone is not confident',
  scoreIdentity(buildInput({ phone: '2105550142' }), CLIENTS[0], []).confident === false);
t('name alone is not confident',
  scoreIdentity(buildInput({ first_name: 'Robert', last_name: 'Pompa' }), CLIENTS[0], []).confident === false);
t('address alone is not confident',
  scoreIdentity(buildInput({ address: '18538 Shadow Canyon Dr' }), CLIENTS[0], addrs).confident === false);
t('email + phone is confident',
  scoreIdentity(buildInput({ email: 'rpompa@example.com', phone: '2105550142' }), CLIENTS[0], []).confident === true);
t('name + address is confident',
  scoreIdentity(buildInput({ first_name: 'Robert', last_name: 'Pompa', address: '18538 Shadow Canyon Dr' }),
    CLIENTS[0], addrs).confident === true);
t('a disagreeing ZIP vetoes the address signal',
  scoreIdentity(buildInput({ first_name: 'Robert', last_name: 'Pompa',
    address: '18538 Shadow Canyon Dr', zip_code: '78201' }), CLIENTS[0], addrs).confident === false);

// ── The returning customer (the case that must work) ────────────────────────
section('Returning customer');
{
  const r = find({ email: 'RPompa@example.com', phone: '(210) 555-0142',
                   first_name: 'Robert', last_name: 'Pompa',
                   address: '18538 shadow canyon drive', zip_code: '78259' });
  t('matches confidently', r.status === 'confident', `got ${r.status}`);
  t('resolves the client_id', r.match && r.match.client_id === 'CLI-000001');
  t('carries pool_id through from the Quotes row', r.match && r.match.pool_id === 'MCPS-0042');
  t('carries the quote_id', r.match && r.match.quote_id === 'Q-aaaa1111');
  t('flags ACTIVE_CUSTOMER', r.match && r.match.status === 'ACTIVE_CUSTOMER');
  t('Clients row + Quotes row is NOT read as a tie',
    r.status === 'confident', 'the twin-row collapse is the whole point');
}
{
  // Same person, sloppier: no email, phone formatted differently, address abbreviated.
  const r = find({ phone: '210.555.0142', first_name: 'Robert', last_name: 'Pompa',
                   address: '18538 Shadow Canyon Dr' });
  t('matches on phone + name with no email', r.status === 'confident', `got ${r.status}`);
  t('still resolves pool_id', r.match && r.match.pool_id === 'MCPS-0042');
}

// ── The MCP lead with no Clients row ────────────────────────────────────────
section('MCP past client (LEAD row on Quotes, no Clients row)');
{
  const r = find({ email: 'dana.w@example.com', first_name: 'Dana', last_name: 'Whitfield' });
  t('matches the Quotes row', r.status === 'confident', `got ${r.status}`);
  t('returns the quote_id', r.match && r.match.quote_id === 'Q-bbbb2222');
  t('has no client_id yet', r.match && r.match.client_id === '');
  t('has no pool_id — so scheduling stays blocked', r.match && !r.match.pool_id);
}

// ── False positives must not happen ─────────────────────────────────────────
section('Strangers');
{
  const r = find({ first_name: 'Sandra', last_name: 'Pompa', address: '900 Nowhere Rd', zip_code: '78000' });
  t('shared surname alone does not match', r.status !== 'confident', `got ${r.status}`);
  t('no match object is returned', r.match === null);
}
{
  const r = find({ email: 'someone.new@example.com', phone: '2105550000',
                   first_name: 'Chris', last_name: 'Nolan', address: '5 Elsewhere Ave' });
  t('a total stranger returns none', r.status === 'none', `got ${r.status}`);
  t('candidate list is empty', r.candidates.length === 0);
}
{
  const r = find({});
  t('an empty submission never matches', r.status === 'none');
}
{
  const r = find({ email: '', phone: '', first_name: '', last_name: '', address: '' });
  t('all-blank fields never match', r.status === 'none', 'blank must not agree with blank');
}

// ── Ties refuse ─────────────────────────────────────────────────────────────
section('Tie refusal');
{
  // Two genuinely different people who share a phone and a surname — e.g. a
  // household landline. Equal scores, different identities.
  const clients = [
    { client_id: 'CLI-A', first_name: 'Ana', last_name: 'Reyes', display_name: 'Ana Reyes',
      email: 'ana@example.com', phone: '2105551000', status: 'LEAD' },
    { client_id: 'CLI-B', first_name: 'Ben', last_name: 'Reyes', display_name: 'Ben Reyes',
      email: 'ben@example.com', phone: '2105551000', status: 'LEAD' }
  ];
  const locs = [
    { location_id: 'L-A', client_id: 'CLI-A', service_address: '12 Shared St', zip_code: '78200' },
    { location_id: 'L-B', client_id: 'CLI-B', service_address: '12 Shared St', zip_code: '78200' }
  ];
  const r = findMatch({ phone: '210-555-1000', address: '12 Shared Street', zip_code: '78200' }, clients, locs, []);
  t('two different people at one score refuse to match', r.status === 'ambiguous', `got ${r.status}`);
  t('no match is chosen at random', r.match === null);
  t('but both are surfaced as candidates', r.candidates.length === 2);
  t('candidates carry their reasons', r.candidates[0].reasons.includes('phone'));
}

// ── Weak evidence is surfaced, not hidden ───────────────────────────────────
section('Ambiguous evidence');
{
  const r = find({ email: 'rpompa@example.com' });
  t('email-only is ambiguous, not confident', r.status === 'ambiguous', `got ${r.status}`);
  t('no automatic match', r.match === null);
  t('the near-miss is still shown to the admin', r.candidates.length > 0);
  t('with the reason recorded', r.candidates[0].reasons.includes('email'));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
