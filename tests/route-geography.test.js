// Stage 0a — route geography analysis.
//
//   node tests/route-geography.test.js        (exits non-zero on failure)
//
// This report decides whether Service Areas can be auto-derived from the days
// we already run, or whether the map has to be drawn by hand. Two properties
// matter more than the numbers:
//
//   1. AMBIGUITY IS SURFACED, NEVER RESOLVED. A ZIP served on two days cannot
//      become one zone. If this report quietly picked a winner, a customer
//      would be promised a day chosen by a heuristic nobody reviewed.
//
//   2. NOTHING IS SILENTLY DROPPED. A pool with no ZIP or no coordinates is
//      invisible to clustering. If it vanished from the report instead of being
//      listed, the coverage map would look complete while missing customers.
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = path.join(__dirname, '..', 'appscript/RouteGeography.js');

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };

// Real San Antonio coordinates, so "scattered" and "tight" mean something.
const STONE_OAK  = [29.6180, -98.4850];   // far north
const NEAR_STONE = [29.6210, -98.4790];   // ~0.4mi away
const ALAMO_HTS  = [29.4840, -98.4670];   // ~9mi south of Stone Oak
const SOUTHSIDE  = [29.3200, -98.4900];   // ~21mi south of Stone Oak

const ROUTES_HEADERS = ['Day of Week','Operator','Pool ID','Customer Name','Address',
                        'City','Service','Maps Link','Lat','Lng','Route Status'];
const SIGNED_HEADERS = ['pool_id','first_name','last_name','address','city','zip_code','status'];

// routes: [day, pool_id, [lat,lng] | null, status?]
// signed: { pool_id: zip }
function build(routes, signedZips) {
  const routeRows = routes.map(r => [
    r[0], 'Ana', r[1], 'Cust ' + r[1], '1 St', 'San Antonio', 'Weekly', '',
    r[2] ? r[2][0] : 0, r[2] ? r[2][1] : 0, r[3] || 'active'
  ]);
  const signedRows = Object.keys(signedZips || {}).map(pid =>
    [pid, 'Cust', pid, '1 St', 'San Antonio', signedZips[pid], 'ACTIVE_CUSTOMER']);

  const mk = (headers, rows) => ({
    getLastRow: () => rows.length + 1,
    getDataRange: () => ({ getValues: () => [headers, ...rows] })
  });

  const ctx = {
    console, Date, String, Number, Math, JSON, Array, Object, isNaN,
    Logger: { log: () => {} },
    SpreadsheetApp: {
      openById: (id) => ({
        getSheetByName: (n) => {
          if (n === 'Routes') return mk(ROUTES_HEADERS, routeRows);
          if (n === 'Signed_Customers') return mk(SIGNED_HEADERS, signedRows);
          return null;
        }
      })
    },
    getHaversineDistance_(lat1, lon1, lat2, lon2) {
      const R = 3958.8;
      const dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
      const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'RouteGeography.js' });
  return ctx;
}

const dayOf = (res, name) => res.days.find(d => d.day === name);

// ── Ambiguity ───────────────────────────────────────────────────────────────
console.log('\n⚠️  A ZIP served on two days is REPORTED, never auto-resolved');
{
  const ctx = build([
    ['TUESDAY',  'P-1', STONE_OAK], ['TUESDAY', 'P-2', NEAR_STONE],
    ['THURSDAY', 'P-3', STONE_OAK],
  ], { 'P-1': '78258', 'P-2': '78258', 'P-3': '78258' });
  const res = ctx.analyzeRouteGeography_();

  t('the split ZIP is listed', res.ambiguous_zips.length === 1 &&
    res.ambiguous_zips[0].zip === '78258');
  t('both days are named', res.ambiguous_zips[0].days.length === 2);
  t('pool counts per day are given', (() => {
    const d = res.ambiguous_zips[0].days;
    return d.find(x => x.day === 'TUESDAY').pools === 2 &&
           d.find(x => x.day === 'THURSDAY').pools === 1;
  })());
  t('a suggestion is offered (most pools wins)',
    res.ambiguous_zips[0].suggested_day === 'TUESDAY');
  t('but BOTH days survive in the output — nothing was collapsed',
    res.ambiguous_zips[0].days.some(d => d.day === 'THURSDAY'));
  t('the verdict refuses to call it derivable',
    /review needed/.test(res.verdict), '(got ' + res.verdict + ')');
}

console.log('\nA clean split across ZIPs is NOT flagged ambiguous');
{
  const ctx = build([
    ['TUESDAY',  'P-1', STONE_OAK], ['TUESDAY', 'P-2', NEAR_STONE],
    ['THURSDAY', 'P-3', ALAMO_HTS],
  ], { 'P-1': '78258', 'P-2': '78258', 'P-3': '78209' });
  const res = ctx.analyzeRouteGeography_();
  t('no ambiguous ZIPs', res.ambiguous_zips.length === 0);
  t('verdict is derivable', /derivable/.test(res.verdict), '(got ' + res.verdict + ')');
}

// ── Coherence ───────────────────────────────────────────────────────────────
console.log('\nCoherence: a tight day reads tight, a scattered day does not');
{
  const ctx = build([
    ['TUESDAY', 'P-1', STONE_OAK], ['TUESDAY', 'P-2', NEAR_STONE],
    ['FRIDAY',  'P-3', STONE_OAK], ['FRIDAY',  'P-4', SOUTHSIDE],
  ], { 'P-1': '78258', 'P-2': '78258', 'P-3': '78258', 'P-4': '78221' });
  const res = ctx.analyzeRouteGeography_();

  t('tight day is tight', dayOf(res, 'TUESDAY').coherence === 'tight',
    '(got ' + dayOf(res, 'TUESDAY').coherence + ')');
  t('tight day mean distance is small', dayOf(res, 'TUESDAY').mean_miles_from_centroid < 1);
  t('a day spanning two pockets is NOT called tight',
    dayOf(res, 'FRIDAY').coherence !== 'tight',
    '(got ' + dayOf(res, 'FRIDAY').coherence + ')');
  t('the two pockets are counted', dayOf(res, 'FRIDAY').zip_groups === 2,
    '(got ' + dayOf(res, 'FRIDAY').zip_groups + ')');
  t('split beats a middling mean — centroid alone would have hidden it',
    dayOf(res, 'FRIDAY').coherence === 'split');
  t('verdict flags review', /review needed/.test(res.verdict));
}

console.log('ZIP group detail names the actual ZIPs in each pocket');
{
  const ctx = build([
    ['FRIDAY', 'P-1', STONE_OAK], ['FRIDAY', 'P-2', SOUTHSIDE],
  ], { 'P-1': '78258', 'P-2': '78221' });
  const res = ctx.analyzeRouteGeography_();
  const groups = dayOf(res, 'FRIDAY').zip_group_detail;
  t('two groups listed', groups.length === 2);
  t('each names its ZIP', groups.some(g => g.includes('78258')) && groups.some(g => g.includes('78221')));
}

// ── Nothing silently dropped ────────────────────────────────────────────────
console.log('\n⚠️  Unclassifiable pools are REPORTED, never dropped');
{
  const ctx = build([
    ['TUESDAY', 'P-1', STONE_OAK],
    ['TUESDAY', 'P-2', null],        // never geocoded (0,0)
    ['TUESDAY', 'P-3', ALAMO_HTS],   // no Signed_Customers row → no ZIP
  ], { 'P-1': '78258', 'P-2': '78258' });
  const res = ctx.analyzeRouteGeography_();

  t('ungeocoded pool is listed', res.unclassifiable.not_geocoded.some(p => p.pool_id === 'P-2'));
  t('ungeocoded count is right', res.unclassifiable.not_geocoded_count === 1);
  t('pool with no ZIP is listed', res.unclassifiable.no_zip.some(p => p.pool_id === 'P-3'));
  t('no-ZIP count is right', res.unclassifiable.no_zip_count === 1);
  t('they still count toward the day total', dayOf(res, 'TUESDAY').pools === 3);
  t('but only geocoded ones drive coherence', dayOf(res, 'TUESDAY').geocoded === 2);
  t('the listing says WHICH day, so it is actionable',
    res.unclassifiable.not_geocoded[0].day === 'TUESDAY');
}

console.log('\nUNSCHEDULED and inactive pools are counted separately, not analysed');
{
  const ctx = build([
    ['TUESDAY',     'P-1', STONE_OAK],
    ['UNSCHEDULED', 'P-2', STONE_OAK],                 // startup / G2C
    ['TUESDAY',     'P-3', STONE_OAK, 'inactive'],
    ['TUESDAY',     'P-4', STONE_OAK, 'startup_complete'],
  ], { 'P-1': '78258', 'P-2': '78258', 'P-3': '78258', 'P-4': '78258' });
  const res = ctx.analyzeRouteGeography_();

  t('only the scheduled pool is analysed', dayOf(res, 'TUESDAY').pools === 1);
  t('UNSCHEDULED counted separately', res.totals.unscheduled_pools === 1);
  t('inactive + startup_complete skipped', res.totals.inactive_skipped === 2);
  t('totals reconcile', res.totals.scheduled_pools === 1);
}

console.log('\nEmpty and malformed input degrade safely');
{
  t('empty Routes returns a note, not a crash', (() => {
    const res = build([], {}).analyzeRouteGeography_();
    return res.ok === true && res.days.length === 0;
  })());
  t('no scheduled pools yields the right verdict', (() => {
    const res = build([['UNSCHEDULED', 'P-1', STONE_OAK]], { 'P-1': '78258' }).analyzeRouteGeography_();
    return /no scheduled pools/.test(res.verdict);
  })());
  t('handler wrapper never throws', (() => {
    const ctx = build([['TUESDAY', 'P-1', STONE_OAK]], { 'P-1': '78258' });
    return ctx.handleAnalyzeRouteGeography_({}).ok === true;
  })());
}

console.log('\nThe report writes nothing');
{
  // Any write would need a setValue/setValues on a sheet; the stub exposes
  // neither, so a write attempt throws and fails the run.
  const ctx = build([['TUESDAY', 'P-1', STONE_OAK]], { 'P-1': '78258' });
  let threw = false;
  try { ctx.analyzeRouteGeography_(); } catch (e) { threw = true; }
  t('completes against a read-only sheet stub', !threw);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
