// Start-date availability — the signing page's calendar.
//
//   node tests/start-availability.test.js        (exits non-zero on failure)
//
// THE RULE THIS SUITE EXISTS TO ENFORCE:
//
//   A customer-facing service day may come ONLY from a real Service Area or an
//   explicit per-location override. Never from a proximity guess.
//
// A cluster guess is good enough to pick a technician. It is not good enough to
// tell a customer "we service your area on Tuesdays", because the page looks
// exactly as confident either way. Bad zone coverage has to fail loudly.
//
// Also guarded here:
//   * preferred-week mode names NO weekday, anywhere in the response
//   * a pool with both a Routes row and its own weekly_service visit counts ONCE
//   * quote_id without a valid staff session is refused, never downgraded
//   * the response never leaks capacity numbers, technician names or distances
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = path.join(__dirname, '..', 'appscript/StartAvailability.js');

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };

// Frozen "today" = Sunday 2026-08-16, so week arithmetic is checkable by hand.
// Monday of the following week is 2026-08-24.
const TODAY = new Date(2026, 7, 16);

function build(o) {
  o = o || {};
  const quote = Object.assign({
    quote_id: 'Q-1', service: 'Weekly Full Service', zip_code: '78258', location_id: 'L-1'
  }, o.quote || {});

  class FrozenDate extends Date {
    constructor(...a) { if (!a.length) { super(TODAY.getTime()); } else { super(...a); } }
    static now() { return TODAY.getTime(); }
  }

  const recorded = [], claims = [];
  const ctx = {
    console, String, Number, Math, JSON, Array, Object, isNaN, Infinity, RegExp,
    Date: FrozenDate,
    Logger: { log: () => {} },
    Session: { getScriptTimeZone: () => 'America/Chicago' },
    Utilities: {
      formatDate: (d, tz, fmt) => {
        const p = n => String(n).padStart(2, '0');
        const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        return fmt === 'yyyy-MM-dd HH:mm' ? `${base} ${p(d.getHours())}:${p(d.getMinutes())}` : base;
      }
    },
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: (n) => {
          if (n === 'Schedule_Blackouts') {
            const rows = o.blackouts || [];
            if (!rows.length) return null;
            return {
              getLastRow: () => rows.length + 1,
              getDataRange: () => ({ getValues: () => [
                ['blackout_id','start_date','end_date','reason','active','created_at','updated_at'],
                ...rows.map((b, i) => ['B-' + i, b[0], b[1], b[2] || 'Holiday',
                                       b[3] === undefined ? 'TRUE' : b[3], '', ''])
              ]})
            };
          }
          // The source reads Scheduled_Visits directly rather than through
          // getScheduledVisitsForWeek() — that wrapper wants a session token and
          // joins addresses from two more spreadsheets. Stubbing the wrapper
          // instead of the sheet is what hid the wrong-argument bug: the real
          // call returned an error OBJECT, .forEach threw, and dated load was
          // silently always zero.
          if (n === 'Scheduled_Visits') {
            const rows = o.visits || [];
            if (!rows.length) return null;
            return {
              getLastRow: () => rows.length + 1,
              getDataRange: () => ({ getValues: () => [
                ['scheduled_visit_id','pool_id','visit_type','scheduled_date',
                 'assigned_technician','status'],
                ...rows.map((v, i) => ['SV-' + i, v.pool_id || '', v.visit_type || '',
                                       v.scheduled_date || '', v.technician || '',
                                       v.status || 'scheduled'])
              ]})
            };
          }
          return null;
        }
      })
    },
    ROUTES_SPREADSHEET_ID: 'x',
    aaNumericProperty_: (k, d) => (o.props && o.props[k] != null ? o.props[k] : d),
    ensureSheet_: () => ({}),
    MCPS_PROPOSAL_APPROVAL_HEADERS: [],
    findRowByValue_: () => (o.approvalMissing ? null : { token: 'tok', quote_id: 'Q-1' }),
    getQuoteById_: (id) => (o.quoteMissing ? null : { object: quote }),
    value_: (obj, f) => (obj && obj[f] != null && obj[f] !== '' ? obj[f] : ''),
    nowIso_: () => '2026-08-16T00:00:00Z',
    validateToken: (tok) => ({ ok: !!(o.staffTokens || []).includes(tok) }),
    WEEKLY_MATCH: (s) => /weekly/i.test(String(s || '')),
    DEFAULT_MAX_POOLS_PER_DAY: 10,
    resolveZoneForAddress_: () => o.zone || { zone_id: '', zone_name: '', service_day: '', source: 'none' },
    listServiceAreas_: () => o.zones || [],
    saSchedulableDays_: () => o.schedulable ||
      ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'],
    // Zone-aware: North and South can have different people, which is the whole
    // point of counting capacity per person.
    techsForZone_: (zoneId) => (o.techsByZone ? (o.techsByZone[zoneId] || []) : (o.techs || [])),
    rgLoadPools_: () => ({ ok: true, pools: o.routePools || [] }),
    // Startups and G2C pools sit in Routes as UNSCHEDULED, so rgLoadPools_ skips
    // them and their ZIP has to come from the customer record instead.
    rgPoolZipIndex_: () => {
      const idx = Object.assign({}, o.poolZips || {});
      (o.visits || []).forEach(v => { if (v.pool_id && v.zip) idx[v.pool_id] = { zip: v.zip }; });
      Object.keys(idx).forEach(k => { if (typeof idx[k] === 'string') idx[k] = { zip: idx[k] }; });
      return idx;
    },
    recordAssignmentException_: (d) => { recorded.push(d); return { ok: true }; },
    claimDedupAction_: (a, k) => { claims.push(k); return true; }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'StartAvailability.js' });
  ctx._recorded = recorded; ctx._claims = claims;
  return ctx;
}

const ZONE_TUE = { zone_id: 'Z-N', zone_name: 'Stone Oak', service_day: 'TUESDAY', source: 'zone' };
const FULL_TUE = { zone_id: 'Z-N', zone_name: 'Stone Oak', service_day: 'TUESDAY',
                   zips: ['78258'], max_per_day: Infinity };

// ── The rule ────────────────────────────────────────────────────────────────
console.log('\n⚠️  A day is promised ONLY from a zone or an explicit override');
{
  const ctx = build({ zone: ZONE_TUE, zones: [FULL_TUE] });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('mode is route_locked', res.mode === 'route_locked', '(got ' + res.mode + ')');
  t('the service day is named', res.service_day === 'TUESDAY');
  t('the zone is named', res.zone_name === 'Stone Oak');
  t('every offered date IS that weekday', res.dates.every(d => new Date(d + 'T12:00:00').getDay() === 2),
    '(got ' + res.dates.slice(0, 3).join(',') + ')');
  t('dates[] is still the contract the calendar reads', Array.isArray(res.dates) && res.dates.length > 0);
}

console.log('An explicit location override also promises a day');
{
  const ctx = build({
    zone: { zone_id: 'Z-N', zone_name: 'Stone Oak', service_day: 'THURSDAY', source: 'override' },
    zones: [Object.assign({}, FULL_TUE, { service_day: 'THURSDAY' })] });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('override yields route_locked', res.mode === 'route_locked');
  t('and its day', res.service_day === 'THURSDAY');
}

console.log('\n⚠️  A CLUSTER guess never reaches the customer as a day');
{
  // The resolver happily returns a nearest-cluster day for assignment. The
  // signing page must discard it — this is the silent-failure case.
  const ctx = build({
    zone: { zone_id: '', zone_name: '', service_day: 'TUESDAY', source: 'cluster' },
    zones: [] });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('mode falls back to preferred_week', res.mode === 'preferred_week', '(got ' + res.mode + ')');
  t('NO service_day is returned', res.service_day === undefined,
    '(got ' + res.service_day + ')');
  t('NO zone_name is returned', res.zone_name === undefined);
  t('NO dates are returned', res.dates === undefined);
  t('day_source says unresolved', res.day_source === 'unresolved');
  t('the reason is stated', res.reason === 'no_zone');
}

console.log('A fallback guess is discarded the same way');
{
  const ctx = build({
    zone: { zone_id: '', zone_name: '', service_day: 'MONDAY', source: 'fallback' }, zones: [] });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('preferred_week', res.mode === 'preferred_week');
  t('no day named', res.service_day === undefined);
}

console.log('An unresolved zone is flagged for ops, durably');
{
  const ctx = build({ zone: { source: 'none', service_day: '' }, zones: [] });
  ctx.handleGetStartAvailability_({ token: 'tok' });
  t('an exception row is recorded', ctx._recorded.length === 1);
  t('typed unresolved_zone', ctx._recorded[0].type === 'unresolved_zone');
  t('it names the quote', ctx._recorded[0].quote_id === 'Q-1');
  t('the detail names the ZIP', /78258/.test(ctx._recorded[0].detail));
  t('a dedup claim is also made', ctx._claims.length === 1);
  t('⚠️ the claim key ends in a minute stamp so it is collectable',
    /\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(ctx._claims[0]),
    '(got "' + ctx._claims[0] + '")');
}

// ── Preferred-week mode ─────────────────────────────────────────────────────
console.log('\nPreferred-week mode: weeks are Mondays, starting NEXT week');
{
  const ctx = build({ zone: { source: 'none' }, zones: [] });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('week_starts is returned', Array.isArray(res.week_starts) && res.week_starts.length > 0);
  t('every week starts on a Monday',
    res.week_starts.every(w => new Date(w + 'T12:00:00').getDay() === 1),
    '(got ' + res.week_starts.slice(0, 3).join(',') + ')');
  // Today is Sunday 2026-08-16, which belongs to the week beginning Monday
  // 2026-08-10. So the current PARTIAL week is 08-10 and the following week is
  // 08-17. The 3-day lead lands on Wed 08-19 — inside that week — so 08-17 is
  // legitimately offerable: this mode promises a week, not a day, and MCPS
  // picks a day at or after the lead date.
  t('the current partial week is never offered', res.week_starts.indexOf('2026-08-10') === -1);
  t('the following week is the earliest', res.week_starts[0] === '2026-08-17',
    '(got ' + res.week_starts[0] + ')');
  t('the earliest week still contains a lead-time-satisfying day', (() => {
    const wk = new Date(res.week_starts[0] + 'T12:00:00');
    const lastServiceable = new Date(wk.getFullYear(), wk.getMonth(), wk.getDate() + 5); // Saturday
    return lastServiceable >= new Date(2026, 7, 19);
  })());
}

console.log('A longer lead time pushes past the following week entirely');
{
  // 9-day lead from Sun 08-16 → earliest 08-25, which is in the week of 08-24.
  // The week of 08-17 can no longer be honoured and must not be offered.
  const ctx = build({ zone: { source: 'none' }, zones: [], props: { START_DATE_LEAD_DAYS: 9 } });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('the un-honourable week is dropped', res.week_starts.indexOf('2026-08-17') === -1,
    '(got ' + res.week_starts.slice(0, 3).join(',') + ')');
  t('the first offerable week is the one containing the lead date',
    res.week_starts[0] === '2026-08-24', '(got ' + res.week_starts[0] + ')');
  t('weeks are a week apart', (() => {
    const a = new Date(res.week_starts[0] + 'T12:00:00'), b = new Date(res.week_starts[1] + 'T12:00:00');
    return Math.round((b - a) / 86400000) === 7;
  })());
}

console.log('Nothing in preferred-week mode can render a weekday');
{
  const ctx = build({ zone: { source: 'cluster', service_day: 'FRIDAY' }, zones: [] });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  const blob = JSON.stringify(res);
  t('no weekday name appears anywhere in the payload',
    !/MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY/i.test(blob),
    '(payload: ' + blob.slice(0, 120) + ')');
}

// ── Weekly-only gating ──────────────────────────────────────────────────────
console.log('\nOnly weekly recurring service is route-day bound');
{
  ['Pool Startup', 'Green-to-Clean', 'Repair Job'].forEach(svc => {
    const ctx = build({ quote: { service: svc }, zone: ZONE_TUE, zones: [FULL_TUE] });
    const res = ctx.handleGetStartAvailability_({ token: 'tok' });
    t(`${svc} is NOT route-locked`, res.mode === 'preferred_week', '(got ' + res.mode + ')');
  });
  const ctx = build({ quote: { service: 'Weekly Full Service' }, zone: ZONE_TUE, zones: [FULL_TUE] });
  t('weekly IS route-locked', ctx.handleGetStartAvailability_({ token: 'tok' }).mode === 'route_locked');
}

// ── A promised day must still be a day we can staff ─────────────────────────
console.log('\n⚠️  A zone whose day is no longer schedulable cannot promise it');
{
  // Saving a Sunday zone is rejected — but a zone saved BEFORE the schedulable
  // list was narrowed reads straight back out with its old day, and nothing
  // revalidates it. The day is re-checked at the moment it becomes a promise.
  const ctx = build({
    zone: { zone_id: 'Z-N', zone_name: 'Stone Oak', service_day: 'SUNDAY', source: 'zone' },
    zones: [Object.assign({}, FULL_TUE, { service_day: 'SUNDAY' })] });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('it degrades to preferred_week', res.mode === 'preferred_week', '(got ' + res.mode + ')');
  t('the reason is day_not_schedulable', res.reason === 'day_not_schedulable',
    '(got ' + res.reason + ')');
  t('no Sunday is ever offered', res.dates === undefined);
  t('and no weekday is named anywhere',
    !/MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY/i.test(JSON.stringify(res)));
  t('ops are told which zone is broken', ctx._recorded.length === 1 &&
    ctx._recorded[0].type === 'unschedulable_zone_day', '(got ' + JSON.stringify(ctx._recorded) + ')');
  t('the detail names the zone', /Stone Oak/.test((ctx._recorded[0] || {}).detail || ''));
}

console.log('Narrowing SCHEDULABLE_DAYS retires the zones that used those days');
{
  const ctx = build({ zone: ZONE_TUE, zones: [FULL_TUE],
                      schedulable: ['MONDAY', 'WEDNESDAY', 'FRIDAY'] });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('the Tuesday zone stops promising Tuesdays', res.mode === 'preferred_week',
    '(got ' + res.mode + ')');
  t('flagged, not silently dropped', ctx._recorded.length === 1);
}

// ── Capacity: the PERSON has room, not the map ──────────────────────────────
//
// The zone answers "what weekday can we promise?". The person answers "is there
// room on that exact date?". Counting per-area answers the second question with
// the first one's data, and gets it wrong whenever two people share a weekday.
console.log('\n⚠️  A pool with a Routes row AND its own weekly_service visit counts ONCE');
{
  // Ana's capacity is 2. One weekly pool already on her Tuesday route, and that
  // same pool's promised first visit in Scheduled_Visits. Counting both reads as
  // 2/2 = full and closes her day — every newly signed customer would consume
  // two of their own technician's slots.
  const routePools = [{ pool_id: 'P-1', day: 'TUESDAY', operator: 'Ana', zip: '78258' }];
  const visits = [{ pool_id: 'P-1', scheduled_date: '2026-08-25',
                    visit_type: 'weekly_service', technician: 'Ana', zip: '78258' }];

  const ctx = build({ zone: ZONE_TUE, zones: [FULL_TUE], routePools, visits,
                      techs: [{ name: 'Ana', maxPerDay: 2, days: ['TUESDAY'] }] });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('dates are still offered', res.mode === 'route_locked' && res.dates.length > 0,
    '(mode ' + res.mode + ')');
  t('the doubly-listed pool did not consume two of Ana\'s slots',
    res.dates.indexOf('2026-08-25') !== -1, '(got ' + (res.dates || []).join(',') + ')');
}

console.log('A DIFFERENT pool on the same person\'s day does consume a slot');
{
  const routePools = [{ pool_id: 'P-1', day: 'TUESDAY', operator: 'Ana', zip: '78258' }];
  const visits = [{ pool_id: 'P-9', scheduled_date: '2026-08-25',
                    visit_type: 'startup_day_1', technician: 'Ana', zip: '78258' }];
  const ctx = build({ zone: ZONE_TUE, zones: [FULL_TUE], routePools, visits,
                      techs: [{ name: 'Ana', maxPerDay: 2, days: ['TUESDAY'] }] });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('that date is full and excluded', (res.dates || []).indexOf('2026-08-25') === -1,
    '(got ' + (res.dates || []).join(',') + ')');
  t('later dates are still open', (res.dates || []).length > 0);
}

console.log('A second person on the same day keeps the date open');
{
  // Ana is full on 08-25; Luis serves the same zone on the same weekday and is
  // empty. One free person is enough to offer the date.
  const routePools = [{ pool_id: 'P-1', day: 'TUESDAY', operator: 'Ana', zip: '78258' }];
  const visits = [{ pool_id: 'P-9', scheduled_date: '2026-08-25',
                    visit_type: 'startup_day_1', technician: 'Ana', zip: '78258' }];
  const ctx = build({ zone: ZONE_TUE, zones: [FULL_TUE], routePools, visits,
                      techs: [{ name: 'Ana', maxPerDay: 2, days: ['TUESDAY'] },
                              { name: 'Luis', maxPerDay: 2, days: ['TUESDAY'] }] });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('Luis\'s free Tuesday keeps 08-25 offerable',
    (res.dates || []).indexOf('2026-08-25') !== -1, '(got ' + (res.dates || []).join(',') + ')');
}

// ── Mau's nuance, both halves ───────────────────────────────────────────────
//
// Two zones, one weekday. Whether a South job closes a North date depends on
// exactly one thing: whether it lands on the SAME PERSON.
const ZONE_N = { zone_id: 'Z-N', zone_name: 'Stone Oak', service_day: 'TUESDAY', source: 'zone' };
const AREAS_NS = [
  { zone_id: 'Z-N', zone_name: 'Stone Oak', service_day: 'TUESDAY', zips: ['78258'], max_per_day: Infinity },
  { zone_id: 'Z-S', zone_name: 'Southside', service_day: 'TUESDAY', zips: ['78221'], max_per_day: Infinity }
];

console.log('\n⚠️  A South startup on LUIS does not close Ana\'s North Tuesday');
{
  const ctx = build({
    zone: ZONE_N, zones: AREAS_NS,
    techsByZone: { 'Z-N': [{ name: 'Ana', maxPerDay: 1, days: ['TUESDAY'] }],
                   'Z-S': [{ name: 'Luis', maxPerDay: 1, days: ['TUESDAY'] }] },
    visits: [{ pool_id: 'P-S9', scheduled_date: '2026-08-25',
               visit_type: 'startup_day_1', technician: 'Luis', zip: '78221' }]
  });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('North stays route-locked', res.mode === 'route_locked', '(got ' + res.mode + ')');
  t('08-25 is still offered — different person, different day\'s work',
    (res.dates || []).indexOf('2026-08-25') !== -1, '(got ' + (res.dates || []).join(',') + ')');
}

console.log('⚠️  The SAME startup on ANA does close her North Tuesday');
{
  // Identical fixture, one field changed: the technician. Ana serves North and
  // South on Tuesday, so her South startup is her Tuesday work — and North must
  // see it. Zone membership never enters this; the shared person does.
  const ctx = build({
    zone: ZONE_N, zones: AREAS_NS,
    techsByZone: { 'Z-N': [{ name: 'Ana', maxPerDay: 1, days: ['TUESDAY'] }],
                   'Z-S': [{ name: 'Ana', maxPerDay: 1, days: ['TUESDAY'] }] },
    visits: [{ pool_id: 'P-S9', scheduled_date: '2026-08-25',
               visit_type: 'startup_day_1', technician: 'Ana', zip: '78221' }]
  });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('08-25 is withdrawn', (res.dates || []).indexOf('2026-08-25') === -1,
    '(got ' + (res.dates || []).join(',') + ')');
  t('only that date — the following Tuesday is untouched',
    (res.dates || []).indexOf('2026-09-01') !== -1, '(got ' + (res.dates || []).join(',') + ')');
}

// ── The area ceiling, layered on top ────────────────────────────────────────
console.log('\nzone.max_per_day is an EXTRA ceiling, not the capacity bucket');
{
  // Ana has room for 10, but the area absorbs at most 1 a day and a startup has
  // already taken it. The ceiling closes a date the person alone would keep.
  const zones = [Object.assign({}, FULL_TUE, { max_per_day: 1 })];
  const visits = [{ pool_id: 'P-9', scheduled_date: '2026-08-25',
                    visit_type: 'startup_day_1', technician: 'Luis', zip: '78258' }];
  const ctx = build({ zone: ZONE_TUE, zones, visits,
                      techs: [{ name: 'Ana', maxPerDay: 10, days: ['TUESDAY'] }] });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('the area ceiling closed that date', (res.dates || []).indexOf('2026-08-25') === -1,
    '(got ' + (res.dates || []).join(',') + ')');
  t('other Tuesdays are unaffected', (res.dates || []).length > 0);
}

console.log('⚠️  A blank max_per_day means NO ceiling, never zero');
{
  // Number('') is 0. If a blank ceiling ever coerced, every zone without an
  // explicit cap would be closed to every customer, permanently.
  const zones = [Object.assign({}, FULL_TUE, { max_per_day: Infinity })];
  const ctx = build({ zone: ZONE_TUE, zones,
                      techs: [{ name: 'Ana', maxPerDay: 10, days: ['TUESDAY'] }] });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('dates are offered', res.mode === 'route_locked' && res.dates.length > 0,
    '(mode ' + res.mode + ')');
}

console.log('Two zones on one day fill independently by area too');
{
  // Same weekday, different people, and the South ceiling is exhausted. North
  // must not inherit it.
  const zones = [
    Object.assign({}, FULL_TUE, { max_per_day: 5, zips: ['78258'] }),
    { zone_id: 'Z-S', zone_name: 'Southside', service_day: 'TUESDAY', zips: ['78221'], max_per_day: 1 }
  ];
  const routePools = [
    { pool_id: 'P-S1', day: 'TUESDAY', operator: 'Luis', zip: '78221' },
    { pool_id: 'P-S2', day: 'TUESDAY', operator: 'Luis', zip: '78221' }
  ];
  const ctx = build({ zone: ZONE_TUE, zones, routePools,
                      techsByZone: { 'Z-N': [{ name: 'Ana', maxPerDay: 5, days: ['TUESDAY'] }] } });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('the north zone is unaffected by the full south zone',
    res.mode === 'route_locked' && res.dates.length > 0, '(mode ' + res.mode + ')');
}

console.log('A person with no room anywhere in the window degrades to weeks');
{
  const routePools = [{ pool_id: 'P-1', day: 'TUESDAY', operator: 'Ana', zip: '78258' }];
  const ctx = build({ zone: ZONE_TUE, zones: [FULL_TUE], routePools,
                      techs: [{ name: 'Ana', maxPerDay: 1, days: ['TUESDAY'] }] });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('mode is preferred_week', res.mode === 'preferred_week', '(got ' + res.mode + ')');
  t('reason is no_capacity', res.reason === 'no_capacity');
  t('and STILL no day is named', res.service_day === undefined);
}

console.log('An unconfigured Users sheet does not close every calendar');
{
  // No technicians resolve for the zone. There is no person ceiling to apply, so
  // the area ceiling decides alone — a portal-wide outage is not the right
  // response to an empty column.
  const ctx = build({ zone: ZONE_TUE, zones: [FULL_TUE], techs: [] });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('dates are still offered', res.mode === 'route_locked' && res.dates.length > 0,
    '(mode ' + res.mode + ')');
}

console.log('A technician who does not work that weekday is not counted as room');
{
  const ctx = build({ zone: ZONE_TUE, zones: [FULL_TUE],
                      routePools: [{ pool_id: 'P-1', day: 'TUESDAY', operator: 'Ana', zip: '78258' }],
                      techs: [{ name: 'Ana', maxPerDay: 1, days: ['TUESDAY'] },
                              { name: 'Sam', maxPerDay: 5, days: ['THURSDAY'] }] });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('Sam\'s Thursday capacity does not open Ana\'s full Tuesday',
    res.mode === 'preferred_week', '(got ' + res.mode + ')');
}

console.log('A cancelled or skipped visit gives the slot back');
{
  const ctx = build({ zone: ZONE_TUE, zones: [FULL_TUE],
                      visits: [{ pool_id: 'P-9', scheduled_date: '2026-08-25',
                                 visit_type: 'startup_day_1', technician: 'Ana',
                                 zip: '78258', status: 'cancelled' }],
                      techs: [{ name: 'Ana', maxPerDay: 1, days: ['TUESDAY'] }] });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('the cancelled visit does not consume Ana\'s day',
    (res.dates || []).indexOf('2026-08-25') !== -1, '(got ' + (res.dates || []).join(',') + ')');
}

// ── Blackouts ───────────────────────────────────────────────────────────────
console.log('\nBlackouts are optional and dormant with no rows');
{
  const a = build({ zone: ZONE_TUE, zones: [FULL_TUE] }).handleGetStartAvailability_({ token: 'tok' });
  const b = build({ zone: ZONE_TUE, zones: [FULL_TUE], blackouts: [] }).handleGetStartAvailability_({ token: 'tok' });
  t('no blackout sheet behaves identically to an empty one',
    JSON.stringify(a.dates) === JSON.stringify(b.dates));
}

console.log('A blackout removes the dates inside it');
{
  const ctx = build({ zone: ZONE_TUE, zones: [FULL_TUE],
                      blackouts: [['2026-08-24', '2026-08-30']] });
  const res = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('the blacked-out Tuesday is gone', res.dates.indexOf('2026-08-25') === -1,
    '(got ' + res.dates.slice(0, 4).join(',') + ')');
  t('Tuesdays outside it remain', res.dates.length > 0);
  t('a single-day blackout works too', (() => {
    const r = build({ zone: ZONE_TUE, zones: [FULL_TUE], blackouts: [['2026-09-01', '']] })
      .handleGetStartAvailability_({ token: 'tok' });
    return r.dates.indexOf('2026-09-01') === -1;
  })());
  t('an archived blackout is ignored', (() => {
    const r = build({ zone: ZONE_TUE, zones: [FULL_TUE],
                      blackouts: [['2026-08-24', '2026-08-30', 'Old hold', 'FALSE']] })
      .handleGetStartAvailability_({ token: 'tok' });
    return r.dates.indexOf('2026-08-25') !== -1;
  })());
}

// ── Auth separation ─────────────────────────────────────────────────────────
console.log('\n⚠️  Staff and public paths must not blur');
{
  const ctx = build({ zone: ZONE_TUE, zones: [FULL_TUE], staffTokens: ['STAFF'] });

  const refused = ctx.handleGetStartAvailability_({ quote_id: 'Q-1' });
  t('quote_id with NO session is refused', refused.ok === false, '(got ok=' + refused.ok + ')');
  t('and is not downgraded to the public path', refused.dates === undefined);
  t('the error says a staff session is needed', /staff session/i.test(refused.error));

  const badTok = ctx.handleGetStartAvailability_({ quote_id: 'Q-1', staff_token: 'GARBAGE' });
  t('quote_id with an INVALID session is refused', badTok.ok === false);

  const asStaff = ctx.handleGetStartAvailability_({ quote_id: 'Q-1', staff_token: 'STAFF' });
  t('quote_id WITH a valid staff session works', asStaff.ok === true && asStaff.mode === 'route_locked');

  const pub = ctx.handleGetStartAvailability_({ token: 'tok' });
  t('the public path still works from an approval token alone', pub.ok === true);
}

console.log('A customer approval token cannot be used as a staff token');
{
  // 'tok' is a valid approval token but NOT a staff session. Passing quote_id
  // with it must fail, or the public page could enumerate quotes.
  const ctx = build({ zone: ZONE_TUE, zones: [FULL_TUE], staffTokens: [] });
  const res = ctx.handleGetStartAvailability_({ quote_id: 'Q-99', token: 'tok' });
  t('refused', res.ok === false, '(got ok=' + res.ok + ')');
}

// ── Leakage ─────────────────────────────────────────────────────────────────
console.log('\n⚠️  The public response leaks nothing operational');
{
  const ctx = build({
    zone: ZONE_TUE,
    zones: [Object.assign({}, FULL_TUE, { max_per_day: 7, primary_technician: 'Ana Guzman' })],
    routePools: [{ pool_id: 'P-1', day: 'TUESDAY', zip: '78258' }],
    techs: [{ name: 'Ana Guzman', maxPerDay: 7, days: ['TUESDAY'] }]
  });
  const blob = JSON.stringify(ctx.handleGetStartAvailability_({ token: 'tok' }));
  t('no technician name', !/Ana Guzman/.test(blob));
  t('no capacity number', !/max_per_day|capacity|"7"|:7[,}]/.test(blob));
  t('no pool ids', !/P-1/.test(blob));
  t('no distances', !/miles|distance|proximity/i.test(blob));
  t('no zone_id (internal identifier)', !/Z-N/.test(blob));
  t('zone NAME is allowed — it is what makes the page feel local', /Stone Oak/.test(blob));
}

// ── Failure handling ────────────────────────────────────────────────────────
console.log('\nFailures never break signing');
{
  t('a missing token is refused cleanly',
    build({}).handleGetStartAvailability_({}).ok === false);
  t('an unknown approval link is refused cleanly',
    build({ approvalMissing: true }).handleGetStartAvailability_({ token: 'x' }).ok === false);
  t('a missing quote is refused cleanly',
    build({ quoteMissing: true }).handleGetStartAvailability_({ token: 'tok' }).ok === false);
  t('a thrown resolver degrades to weeks rather than failing', (() => {
    const ctx = build({ zones: [] });
    ctx.resolveZoneForAddress_ = () => { throw new Error('boom'); };
    const res = ctx.handleGetStartAvailability_({ token: 'tok' });
    return res.ok === true && res.mode === 'preferred_week';
  })());
  t('an unreadable blackout sheet does not close the calendar', (() => {
    const ctx = build({ zone: ZONE_TUE, zones: [FULL_TUE] });
    ctx.SpreadsheetApp.openById = () => { throw new Error('boom'); };
    const res = ctx.handleGetStartAvailability_({ token: 'tok' });
    return res.ok === true && res.dates.length > 0;
  })());
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
