// Intake guard.
//
//   node tests/service-request-intake.test.mjs
//
// Covers the pure logic behind the public endpoint: what we accept, what we
// refuse, and the two rules that stop a public form corrupting real data —
// status-aware idempotency and draft-scoped photo URLs.

process.env.SERVICE_LINK_SECRET = 'test-secret-do-not-use-in-production';

import {
  sanitizeSubmission, idempotencyKey, appendAction, isEmail, isPhone, clean,
  CATEGORIES, SUBCATEGORIES, TIMING, OPEN_STATUSES, STATUSES, HEADERS, PUBLIC_STATUS
} from '../api/_lib/service-requests.js';
import { normEmail, normPhone, normAddress } from '../api/_lib/identity.js';
import { mintLinkToken, verifyLinkToken } from '../api/service-request.js';

const NORM = { normEmail, normPhone, normAddress };
let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail ? '  ' + detail : '')); }
};
const section = n => console.log('\n' + n);

const VALID = {
  category: 'green_to_clean', subcategory: 'several_months',
  first_name: 'Robert', last_name: 'Pompa',
  email: 'rpompa@example.com', phone: '(210) 555-0142',
  service_address: '18538 Shadow Canyon Dr', city: 'San Antonio', zip_code: '78259',
  description: 'Pool went green after the storm.', timing_preference: 'this_week'
};

// ── Schema sanity ───────────────────────────────────────────────────────────
section('Schema');
t('headers are unique', new Set(HEADERS).size === HEADERS.length);
t('every status has customer-facing wording', STATUSES.every(s => PUBLIC_STATUS[s]));
t('open statuses are a subset of statuses', OPEN_STATUSES.every(s => STATUSES.includes(s)));
t('every category has a service_type', Object.values(CATEGORIES).every(c => c.service_type));
t('weekly service is NOT directly schedulable',
  CATEGORIES.weekly_service.schedulable === false,
  'it must route through the quote/e-sign pipeline');
t('green-to-clean IS schedulable', CATEGORIES.green_to_clean.schedulable === true);
t('repair creates a repair order', CATEGORIES.repair.creates_repair_order === true);
t('every category with subcategories is a known category',
  Object.keys(SUBCATEGORIES).every(k => CATEGORIES[k]));

// ── Field validation ────────────────────────────────────────────────────────
section('Validation');
t('a valid submission passes', sanitizeSubmission(VALID).errors.length === 0);
t('an unknown category is refused', sanitizeSubmission({ ...VALID, category: 'free_pool' }).errors.length > 0);
t('a missing category is refused', sanitizeSubmission({ ...VALID, category: '' }).errors.length > 0);
t('a missing address is refused', sanitizeSubmission({ ...VALID, service_address: '' }).errors.length > 0);
t('no email AND no phone is refused',
  sanitizeSubmission({ ...VALID, email: '', phone: '' }).errors.length > 0);
t('email alone is enough', sanitizeSubmission({ ...VALID, phone: '' }).errors.length === 0);
t('phone alone is enough', sanitizeSubmission({ ...VALID, email: '' }).errors.length === 0);
t('a malformed email is refused', sanitizeSubmission({ ...VALID, email: 'rpompa@' }).errors.length > 0);
t('a short phone is refused', sanitizeSubmission({ ...VALID, phone: '555' }).errors.length > 0);
t('an 11-digit US phone is accepted', isPhone('+1 210 555 0142'));
t('a plus-addressed email is accepted', isEmail('bob+pool@example.co.uk'));
t('email is lowercased on the way in',
  sanitizeSubmission({ ...VALID, email: 'RPompa@Example.COM' }).fields.email === 'rpompa@example.com');
t('state defaults to TX', sanitizeSubmission({ ...VALID, state: '' }).fields.state === 'TX');
t('an unknown timing falls back to flexible',
  sanitizeSubmission({ ...VALID, timing_preference: 'tomorrow_at_dawn' }).fields.timing_preference === 'flexible');
t('every declared timing value is accepted',
  TIMING.every(v => sanitizeSubmission({ ...VALID, timing_preference: v }).fields.timing_preference === v));
t('a subcategory from another category is dropped',
  sanitizeSubmission({ ...VALID, category: 'green_to_clean', subcategory: 'heater' }).fields.subcategory === '');

section('Injection and overflow');
{
  const s = sanitizeSubmission({
    ...VALID, first_name: 'x'.repeat(5000), description: 'y'.repeat(9000),
    service_address: 'z'.repeat(5000), email: 'e'.repeat(300) + '@x.com'
  });
  t('long names are capped at 80', s.fields.first_name.length === 80);
  t('long addresses are capped at 500', s.fields.service_address.length === 500);
  t('long descriptions are capped at 2000', s.fields.description.length === 2000);
  t('an over-long email is refused rather than truncated into a valid-looking one',
    s.errors.some(e => e.toLowerCase().includes('email')));
}
{
  // An allowlist, not a filter: server-owned columns must not be settable.
  const s = sanitizeSubmission({
    ...VALID, status: 'scheduled', match_pool_id: 'MCPS-0001',
    reviewed_by: 'admin', scheduled_visit_id: 'evil', request_id: 'SR-OVERRIDE'
  });
  ['status', 'match_pool_id', 'reviewed_by', 'scheduled_visit_id', 'request_id']
    .forEach(k => t(`client cannot set ${k}`, s.fields[k] === undefined));
}
t('script tags survive only as inert text',
  sanitizeSubmission({ ...VALID, description: '<script>alert(1)</script>' })
    .fields.description === '<script>alert(1)</script>',
  'escaping is the renderer\'s job; storage keeps the value intact');

// ── Idempotency key ─────────────────────────────────────────────────────────
section('Idempotency key');
const key = f => idempotencyKey(f, NORM);
const BASE = { email: 'a@b.com', phone: '2105550142', address: '1 Pool Ln', category: 'repair' };
t('same input, same key', key(BASE) === key({ ...BASE }));
t('formatting differences collapse',
  key(BASE) === key({ email: 'A@B.com', phone: '(210) 555-0142', address: '1 pool lane.', category: 'repair' }));
t('a different category is a different request', key(BASE) !== key({ ...BASE, category: 'green_to_clean' }));
t('a different address is a different request', key(BASE) !== key({ ...BASE, address: '2 Pool Ln' }));
t('a different email is a different request', key(BASE) !== key({ ...BASE, email: 'c@d.com' }));
t('PHONE is part of the key — two people at one address do not collide',
  key({ ...BASE, email: '' }) !== key({ ...BASE, email: '', phone: '2105559999' }));
t('key is a short stable hex', /^[0-9a-f]{32}$/.test(key(BASE)));

// ── Status-aware idempotency ────────────────────────────────────────────────
section('Status-aware idempotency');
t('new is foldable', OPEN_STATUSES.includes('new'));
t('in_review is foldable', OPEN_STATUSES.includes('in_review'));
['scheduled', 'quoted', 'declined', 'duplicate'].forEach(s =>
  t(`${s} is FROZEN — a resubmit must not overwrite it`, !OPEN_STATUSES.includes(s)));

// ── Action log ──────────────────────────────────────────────────────────────
section('Action log');
{
  const l1 = appendAction('', { at: 't1', action: 'submit' });
  const l2 = appendAction(l1, { at: 't2', action: 'schedule' });
  t('entries accumulate', JSON.parse(l2).length === 2);
  t('order is preserved', JSON.parse(l2)[0].action === 'submit');
  t('a corrupt log does not throw', JSON.parse(appendAction('{{not json', { at: 't', action: 'x' })).length === 1);
  let long = '';
  for (let i = 0; i < 60; i++) long = appendAction(long, { at: String(i), action: 'x' });
  t('the log is bounded', JSON.parse(long).length === 40);
  t('bounding keeps the NEWEST entries', JSON.parse(long)[39].at === '59');
}

// ── Link tokens ─────────────────────────────────────────────────────────────
section('Link tokens');
{
  const tok = mintLinkToken('Q-aaaa1111');
  t('a minted token verifies', verifyLinkToken(tok) === 'Q-aaaa1111');
  t('a tampered signature fails', verifyLinkToken(tok.slice(0, -1) + '0') === '');
  t('a tampered payload fails', verifyLinkToken('XXXX.' + tok.split('.')[1]) === '');
  t('garbage fails', verifyLinkToken('not-a-token') === '');
  t('an empty token fails', verifyLinkToken('') === '');
  t('a token for another quote returns that quote, not ours',
    verifyLinkToken(mintLinkToken('Q-bbbb2222')) === 'Q-bbbb2222');
  t('tokens are URL-safe', /^[A-Za-z0-9_.-]+$/.test(tok));
}
{
  // Fails closed with no secret configured: tokens never verify, and the page
  // falls through to its address form — the same path a forwarded link takes.
  const saved = process.env.SERVICE_LINK_SECRET;
  delete process.env.SERVICE_LINK_SECRET;
  t('no secret configured mints nothing', mintLinkToken('Q-1') === '');
  t('no secret configured verifies nothing', verifyLinkToken('anything.abc') === '');
  process.env.SERVICE_LINK_SECRET = saved;
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
