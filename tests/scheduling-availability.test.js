// Nearest-cluster availability. Runs the real AutoAssign.js against in-memory
// Routes data; only the Apps Script services are stubbed.
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = path.join(__dirname, '..', 'appscript/AutoAssign.js');

// Real San Antonio-ish coordinates so distances are meaningful, not synthetic.
const STONE_OAK   = { lat: 29.6180, lng: -98.4850 };   // north
const ALAMO_HTS   = { lat: 29.4840, lng: -98.4670 };   // central, ~9mi south
const SOUTHSIDE   = { lat: 29.3200, lng: -98.4900 };   // ~21mi south of Stone Oak
const NEAR_STONE  = { lat: 29.6210, lng: -98.4790 };   // ~0.4mi from STONE_OAK

function build(opts) {
  const o = opts || {};
  // Routes: [day, operator, pool_id, name, address, city, service, maps, lat, lng, route_status]
  const routeRows = o.routes || [];
  const routesSheet = {
    getLastRow: () => routeRows.length + 1,
    getDataRange: () => ({ getValues: () => [
      ['Day of Week','Operator','Pool ID','Customer Name','Address','City','Service','Maps Link','Lat','Lng','Route Status'],
      ...routeRows
    ]})
  };

  const props = Object.assign({}, o.props || {});
  const ctx = {
    console, Date, String, Number, Math, JSON, Array, Object, isNaN,
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null }) },
    SpreadsheetApp: { openById: () => ({ getSheetByName: n => (n === 'Routes' ? routesSheet : null) }) },
    Session: { getScriptTimeZone: () => 'America/Chicago' },
    Utilities: {
      formatDate: (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    WEEKDAYS: ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'],
    DEFAULT_MAX_POOLS_PER_DAY: 10,
    // The REAL four-scalar signature from RoutePlanner.js — this is the whole
    // point of the aaDistance_ fix.
    getHaversineDistance_(lat1, lon1, lat2, lon2) {
      const R = 3958.8;
      const dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
      const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    },
    getTechnicianOperators_: () => o.operators || [],
    // Address resolution stubs
    ensureSheet_: () => ({}),
    MCPS_PROPOSAL_APPROVAL_HEADERS: [],
    findRowByValue_: () => (o.address ? { quote_id: 'Q1' } : null),
    getQuoteById_: () => (o.address ? { object: { address: o.address, city: 'San Antonio', zip_code: '78258' } } : null),
    value_: (obj, f) => (obj && obj[f] != null ? obj[f] : ''),
    geocodeCalls: 0
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'AutoAssign.js' });
  // Override the geocoder after load so we don't hit Maps.
  vm.runInContext(`aaGeocodeAddress_ = function(){ geocodeCalls++; return ${JSON.stringify(o.coords || null)}; };`, ctx);
  return ctx;
}

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const R = (day, op, lat, lng) => [day, op, 'P', 'N', 'A', 'C', 'Weekly Full Service', '', lat, lng, 'active'];
const OPS = [{ name: 'Tech A', username: 'a', days: ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY'],
               maxPerDay: 10, autoAssignEligible: true, preferredZones: [] }];

// ── The distance bug ────────────────────────────────────────────────────────
console.log('\naaDistance_ — the four-scalar bug');
{
  const ctx = build({});
  const d = ctx.aaDistance_(STONE_OAK, ALAMO_HTS);
  t('returns a real number, not NaN', typeof d === 'number' && !isNaN(d), '(got ' + d + ')');
  t('~9.3 miles Stone Oak → Alamo Heights', near(d, 9.3, 1.0), '(got ' + d.toFixed(2) + ')');
  t('zero distance to self', near(ctx.aaDistance_(STONE_OAK, STONE_OAK), 0, 0.01));
  t('null-safe', ctx.aaDistance_(null, STONE_OAK) === Infinity);
}

// ── Cluster scoring ─────────────────────────────────────────────────────────
console.log('\naaClusterScore_');
{
  const ctx = build({});
  t('no stops => Infinity (an open day, not a far one)',
    ctx.aaClusterScore_(STONE_OAK, []) === Infinity);
  t('null stops => Infinity', ctx.aaClusterScore_(STONE_OAK, null) === Infinity);

  const tight = [NEAR_STONE, { lat: 29.6150, lng: -98.4900 }, { lat: 29.6250, lng: -98.4810 }];
  t('nearby cluster scores low', ctx.aaClusterScore_(STONE_OAK, tight) < 1.5);

  // One stray stop next door must NOT make a far day look close.
  const strayNear = [NEAR_STONE, SOUTHSIDE, SOUTHSIDE, SOUTHSIDE, SOUTHSIDE];
  const single = ctx.aaDistance_(STONE_OAK, NEAR_STONE);
  const scored = ctx.aaClusterScore_(STONE_OAK, strayNear);
  t('outlier-resistant: k-nearest mean >> single nearest', scored > single * 5,
    '(single ' + single.toFixed(2) + ' vs cluster ' + scored.toFixed(2) + ')');

  // Fewer stops than K still works.
  t('handles fewer stops than K', ctx.aaClusterScore_(STONE_OAK, [NEAR_STONE]) < 1);
}

// ── Weekday parsing ─────────────────────────────────────────────────────────
console.log('\naaWeekdayFromDate_ — no UTC drift');
{
  const ctx = build({});
  t('2026-08-12 is a WEDNESDAY', ctx.aaWeekdayFromDate_('2026-08-12') === 'WEDNESDAY',
    '(got ' + ctx.aaWeekdayFromDate_('2026-08-12') + ')');
  t('2026-08-10 is a MONDAY', ctx.aaWeekdayFromDate_('2026-08-10') === 'MONDAY');
  t('2026-08-15 is a SATURDAY', ctx.aaWeekdayFromDate_('2026-08-15') === 'SATURDAY');
  t('rejects junk', ctx.aaWeekdayFromDate_('nope') === '');
  t('rejects empty', ctx.aaWeekdayFromDate_('') === '');
  // A bare-string Date() parse would land on the previous day in US time zones.
  t('does not drift a day (UTC-parse trap)',
    ctx.aaWeekdayFromDate_('2026-08-12') !== 'TUESDAY');
}

// ── Availability ────────────────────────────────────────────────────────────
// handleGetStartAvailability_ moved to StartAvailability.js and was rewritten:
// it no longer offers a slack-window SET of weekdays. A customer-facing day now
// comes only from a Service Area or an explicit override, and a proximity guess
// is never shown to a customer. Its coverage lives in start-availability.test.js.
//
// The cluster helpers below are still live — resolveZoneForAddress_ falls back to
// aaClusterScore_ for TECHNICIAN assignment — so their tests stay here.

console.log('\nchooseAssignment_ — preferred day');
{
  const routes = [R('WEDNESDAY','Tech A', STONE_OAK.lat, STONE_OAK.lng)];
  let ctx = build({ routes, operators: OPS });
  let c = ctx.chooseAssignment_({ coords: STONE_OAK, preferredDay: 'FRIDAY' });
  t('assigns the day the customer chose', c.day === 'FRIDAY', '(got ' + c.day + ')');
  t('no exception when honoured', c.exceptions.length === 0);

  // Preferred day completely full -> falls back AND flags it.
  const fullFri = [];
  for (let i = 0; i < 10; i++) fullFri.push(R('FRIDAY','Tech A', STONE_OAK.lat, STONE_OAK.lng));
  ctx = build({ routes: fullFri, operators: OPS });
  c = ctx.chooseAssignment_({ coords: STONE_OAK, preferredDay: 'FRIDAY' });
  t('falls back when the chosen day is full', c.day !== 'FRIDAY');
  t('raises preferred_day_unavailable',
    c.exceptions.some(e => e.type === 'preferred_day_unavailable'));

  // Without a preference the old ranking still applies.
  ctx = build({ routes, operators: OPS });
  c = ctx.chooseAssignment_({ coords: STONE_OAK });
  t('no preference => still assigns something', c && c.day && c.operator === 'Tech A');
  t('no spurious exception', c.exceptions.length === 0);

  // A day the operator does not work is never chosen, even if requested.
  ctx = build({ routes: [], operators: [{ ...OPS[0], days: ['MONDAY','TUESDAY'] }] });
  c = ctx.chooseAssignment_({ coords: STONE_OAK, preferredDay: 'FRIDAY' });
  t('never assigns a day the tech does not work', ['MONDAY','TUESDAY'].includes(c.day),
    '(got ' + c.day + ')');

  // Proximity now actually discriminates (it could not while aaDistance_ was NaN).
  const twoOps = [
    { name: 'North Tech', username: 'n', days: ['MONDAY'], maxPerDay: 10, autoAssignEligible: true, preferredZones: [] },
    { name: 'South Tech', username: 's', days: ['MONDAY'], maxPerDay: 10, autoAssignEligible: true, preferredZones: [] }
  ];
  const split = [
    R('MONDAY','North Tech', STONE_OAK.lat, STONE_OAK.lng),
    R('MONDAY','South Tech', SOUTHSIDE.lat, SOUTHSIDE.lng)
  ];
  ctx = build({ routes: split, operators: twoOps });
  c = ctx.chooseAssignment_({ coords: NEAR_STONE });
  t('picks the nearer technician on a capacity tie', c.operator === 'North Tech',
    '(got ' + c.operator + ')');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
