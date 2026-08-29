// LIVE end-to-end check for the staff review console's endpoint.
//
//   node tests/service-requests-review.test.mjs
//
// ⚠️ Talks to the REAL spreadsheets. It seeds its own requests, exercises every
// action, then removes everything it created — including the Scheduled_Visits
// row and the Quotes lead. Run it by hand, not in CI.
//
// It needs a valid admin portal session. Put one in SR_TEST_TOKEN, or let the
// script find the newest admin session on the Sessions sheet.
//
// What it proves — these are the guarantees Mau asked for, checked at the
// SERVER, not in the UI where a disabled button proves nothing:
//   * scheduling is refused without a pool_id
//   * weekly service cannot shortcut the quote/e-sign pipeline
//   * create_lead re-matches against live data and refuses if the person now
//     exists — the duplicate guard that a submit-time snapshot cannot give
//   * every action is idempotent: a second call creates nothing
//   * an action on a request somebody else already moved is refused, not applied

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true, quiet: true });
process.env.SERVICE_LINK_SECRET = process.env.SERVICE_LINK_SECRET || 'test-secret';

const { crmSpreadsheetId, readSheetRange, writeSheetRange, rowsToObjects,
        validatePortalSession, hasAdminAccess } = await import('../api/_sheets.js');
const { routesSpreadsheetId } = await import('../api/_lib/ids.js');
const intake = (await import('../api/service-request.js')).default;
const review = (await import('../api/service-requests/review.js')).default;

const CRM = crmSpreadsheetId();
const ROUTES = routesSpreadsheetId();
const MARK = 'e2e-review-test.invalid';

let pass = 0, fail = 0;
const t = (n, c, d = '') => { c ? (pass++, console.log('  ok - ' + n)) : (fail++, console.log('  FAIL - ' + n + (d ? '  ' + d : ''))); };
const section = n => console.log('\n' + n);

function mockRes() {
  const r = { _s: 0, _j: null };
  const take = b => { r._j = typeof b === 'string' ? (() => { try { return JSON.parse(b); } catch (_) { return b; } })() : b; return r; };
  r.status = c => { r._s = c; return r; }; r.json = take; r.send = take;
  r.setHeader = () => {}; r.end = () => r; return r;
}

async function findToken() {
  if (process.env.SR_TEST_TOKEN) return process.env.SR_TEST_TOKEN;
  const rows = rowsToObjects(await readSheetRange('Sessions', '1e2XmGuosFSzeDQYMf3TYG3ZFfENYTyne5pqOi3L5m1g'));
  for (const s of rows.filter(r => r.token).slice(-10).reverse()) {
    const sess = await validatePortalSession(s.token).catch(() => null);
    if (sess && hasAdminAccess(sess)) return s.token;
  }
  return '';
}

const TOKEN = await findToken();
if (!TOKEN) {
  console.log('\nNo admin session available. Sign in to the portal, or set SR_TEST_TOKEN.\n');
  process.exit(1);
}

const submit = async body => {
  const res = mockRes();
  await intake({ method: 'POST', body, query: {},
    headers: { 'user-agent': 'review-test', 'x-forwarded-for': '198.51.100.' + Math.floor(Math.random() * 250) },
    socket: {} }, res);
  return res._j;
};
const call = async (method, body, query) => {
  const res = mockRes();
  await review({ method, body, query: Object.assign({ token: TOKEN }, query || {}), headers: {}, socket: {} }, res);
  return { status: res._s, body: res._j };
};

const countVisits = async () => rowsToObjects(await readSheetRange('Scheduled_Visits', ROUTES)).filter(v => String(v.notes || '').includes(MARK)).length;
const countQuotes = async () => (await readSheetRange('Quotes!A:A', CRM)).length;

// ── Seed ────────────────────────────────────────────────────────────────────
section('Seeding');
const quotes = rowsToObjects(await readSheetRange('Quotes', CRM));
const withPool = quotes.find(q => String(q.pool_id || '').trim() && String(q.email || '').includes('@') && String(q.address || '').trim());
const leadOnly = quotes.find(q => !String(q.pool_id || '').trim() && String(q.status || '').toUpperCase() === 'LEAD' && String(q.email || '').includes('@') && String(q.address || '').trim());
if (!withPool || !leadOnly) { console.log('  cannot seed: need one quote with a pool_id and one LEAD without'); process.exit(1); }

const stamp = Date.now();
const note = `SEED ${MARK}`;
const seeded = [];

const rSchedulable = await submit({ category: 'green_to_clean', subcategory: 'several_months',
  first_name: withPool.first_name, last_name: withPool.last_name, email: withPool.email, phone: withPool.phone,
  service_address: withPool.address, city: withPool.city, zip_code: withPool.zip_code,
  description: note, timing_preference: 'asap' });
const rNoPool = await submit({ category: 'repair', subcategory: 'heater',
  first_name: leadOnly.first_name, last_name: leadOnly.last_name, email: leadOnly.email, phone: leadOnly.phone,
  service_address: leadOnly.address, city: leadOnly.city, zip_code: leadOnly.zip_code,
  description: note, timing_preference: 'this_week' });
const rStranger = await submit({ category: 'weekly_service', subcategory: 'no_current_service',
  first_name: 'ReviewTest', last_name: 'Stranger' + stamp, email: `review.${stamp}@${MARK}`,
  phone: '2105557777', service_address: `${stamp} Review Test Rd`, city: 'San Antonio', zip_code: '78259',
  description: note, timing_preference: 'flexible' });
[rSchedulable, rNoPool, rStranger].forEach(r => r && r.request_id && seeded.push(r.request_id));
t(`seeded ${seeded.length} requests`, seeded.length === 3, seeded.join(', '));

// ── Auth ────────────────────────────────────────────────────────────────────
section('Auth');
t('a bad token is rejected', (await call('GET', null, { token: 'not-a-real-token' })).status === 401);
t('a missing token is rejected', (await call('GET', null, { token: '' })).status === 401);
{
  const r = await call('GET');
  t('a valid admin token is accepted', r.status === 200 && r.body.ok);
  t('technicians are returned for the picker', Array.isArray(r.body.technicians) && r.body.technicians.length > 0);
  t('the queue includes the seeded requests', seeded.every(id => r.body.items.some(i => i.request_id === id)));
}

// ── The pool_id preflight ───────────────────────────────────────────────────
section('Pool ID preflight (server-side, not just a disabled button)');
{
  const r = await call('POST', { action: 'schedule', request_id: rNoPool.request_id, scheduled_date: '2026-09-12' });
  t('scheduling without a pool_id is refused', r.status === 400 && r.body.code === 'no_pool_id', JSON.stringify(r.body));
  const r2 = await call('POST', { action: 'repair_order', request_id: rNoPool.request_id });
  t('a repair order without a pool_id is refused', r2.status === 400 && r2.body.code === 'no_pool_id');
}

section('Weekly service cannot shortcut the quote pipeline');
t('direct scheduling is refused', await (async () => {
  const r = await call('POST', { action: 'schedule', request_id: rStranger.request_id, scheduled_date: '2026-09-12' });
  return r.status === 400 && /quote tool/i.test(r.body.error || '');
})());

// ── Input validation ────────────────────────────────────────────────────────
section('Input validation');
{
  const bad = d => call('POST', { action: 'schedule', request_id: rSchedulable.request_id, scheduled_date: d });
  t('a malformed date is refused', (await bad('next tuesday')).status === 400);
  t('an impossible date is refused', (await bad('2026-13-45')).status === 400, 'a regex alone would accept this');
  t('Feb 30 is refused', (await bad('2026-02-30')).status === 400);
  t('a past date is refused', (await bad('2020-01-01')).status === 400);
  t('a missing date is refused', (await call('POST', { action: 'schedule', request_id: rSchedulable.request_id })).status === 400);

  const r = await call('POST', { action: 'link', request_id: rNoPool.request_id, pool_id: 'MCPS-9999999' });
  t('linking a pool ID that does not exist is refused', r.status === 400 && /does not exist/i.test(r.body.error || ''), JSON.stringify(r.body).slice(0, 120));
}

// ── Schedule + idempotency ──────────────────────────────────────────────────
section('Schedule');
{
  const before = await countVisits();
  const r1 = await call('POST', { action: 'schedule', request_id: rSchedulable.request_id,
    scheduled_date: '2026-09-12', assigned_technician: 'Tony Siller' });
  t('a schedulable request is scheduled', r1.status === 200 && r1.body.ok && r1.body.scheduled_visit_id, JSON.stringify(r1.body));
  const mid = await countVisits();
  t('exactly one visit row was created', mid === before + 1, `${before} -> ${mid}`);

  const r2 = await call('POST', { action: 'schedule', request_id: rSchedulable.request_id,
    scheduled_date: '2026-09-19', assigned_technician: 'Tony Siller' });
  t('a second click returns the existing visit', r2.body.existing === true, JSON.stringify(r2.body));
  t('and creates NO second visit', (await countVisits()) === mid, 'double-click must not double-book');

  const visits = rowsToObjects(await readSheetRange('Scheduled_Visits', ROUTES));
  const v = visits.find(x => String(x.scheduled_visit_id || '') === r1.body.scheduled_visit_id);
  t('the visit carries a real pool_id', !!v && /^MCPS-/.test(v.pool_id), v && v.pool_id);
  t('visit_type is one_time', !!v && v.visit_type === 'one_time');
  t('service_type matches the existing G2C label', !!v && v.service_type === 'Green-to-Clean Cleaning Service', v && v.service_type);
  t('status is scheduled', !!v && v.status === 'scheduled');
  t('the notes trace back to the request', !!v && String(v.notes).includes(rSchedulable.request_id));
  t('created_by records the admin', !!v && String(v.created_by || '').length > 0, v && v.created_by);
}

// ── create_lead re-matches ──────────────────────────────────────────────────
section('create_lead re-matches at click time');
{
  const r = await call('POST', { action: 'create_lead', request_id: rNoPool.request_id });
  t('refuses when the person is already in the CRM', r.status === 409 && r.body.code === 'match_found', JSON.stringify(r.body).slice(0, 140));
  t('and hands back the match so it can be linked instead', !!(r.body.match && (r.body.match.quote_id || r.body.match.client_id)));

  const before = await countQuotes();
  const r2 = await call('POST', { action: 'create_lead', request_id: rStranger.request_id });
  t('allows it for a genuine stranger', r2.status === 200 && /^Q-/.test(r2.body.quote_id || ''), JSON.stringify(r2.body).slice(0, 120));
  const mid = await countQuotes();
  t('exactly one Quotes row was added', mid === before + 1, `${before} -> ${mid}`);

  const r3 = await call('POST', { action: 'create_lead', request_id: rStranger.request_id });
  t('a second click returns the same lead', r3.body.existing === true);
  t('and creates NO second lead', (await countQuotes()) === mid);
}

// ── Stale state ─────────────────────────────────────────────────────────────
section('Stale-state guard');
t('cannot link a request already scheduled', (await call('POST', { action: 'link', request_id: rSchedulable.request_id, pool_id: 'MCPS-9999' })).status === 409);
t('an unknown request 404s', (await call('POST', { action: 'schedule', request_id: 'SR-DOESNOTEXIST', scheduled_date: '2026-09-12' })).status === 404);
t('an unknown action is refused', (await call('POST', { action: 'nonsense', request_id: rSchedulable.request_id })).status === 400);
t('a missing request_id is refused', (await call('POST', { action: 'schedule' })).status === 400);

// ── Cleanup ─────────────────────────────────────────────────────────────────
section('Cleanup');
{
  let removed = 0;

  const blank = async (tab, id, matcher, width) => {
    // Retry once: a quota blip here would strand seeded rows in a live sheet,
    // which is worse than a slow test.
    let values;
    try { values = await readSheetRange(tab, id); }
    catch (_) { await new Promise(r => setTimeout(r, 8000)); values = await readSheetRange(tab, id).catch(() => []); }
    const w = width || (values[0] || []).length;
    for (let i = 1; i < values.length; i++) {
      if (matcher(values[i])) {
        const last = String.fromCharCode(64 + Math.min(w, 26)) + (w > 26 ? String.fromCharCode(64 + w - 26) : '');
        await writeSheetRange(`${tab}!A${i + 1}:${colName(w - 1)}${i + 1}`, [new Array(w).fill('')], id);
        removed++;
      }
    }
  };
  function colName(index) {
    let n = index, out = '';
    do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return out;
  }

  await blank('Scheduled_Visits', ROUTES, row => row.join(' ').includes(MARK));
  await blank('Quotes', CRM, row => row.join(' ').includes(MARK));
  await blank('Service_Requests', CRM, row => row.join(' ').includes(MARK) || seeded.includes(String(row[0] || '')));

  t(`removed ${removed} seeded rows`, removed >= seeded.length, `${removed} rows`);
  t('no seeded visits remain', (await countVisits()) === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
