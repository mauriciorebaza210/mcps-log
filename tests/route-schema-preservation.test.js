// A0 — Routes schema preservation.
//
//   node tests/route-schema-preservation.test.js        (exits non-zero on failure)
//
// WHY THIS EXISTS
//
// calculateRoutes() clears the Routes sheet across its full width and then
// rebuilds it. It used to write back only the ten core columns, so everything
// past column J was wiped on every recalculation. `Pinned` survived only
// because it is explicitly re-stamped afterwards.
//
// That is not hypothetical: AutoAssign.js stores schedule-notified markers on
// the Quotes sheet specifically to dodge this, with a comment saying a Routes
// column "would be silently erased on the next bulk recalc."
//
// Every Routes column this project is about to add — zone_id, pin_reason,
// pinned_at — depends on the fix these tests guard. The rebuild also REORDERS
// rows (pinned pools are emitted first), so restoring extras by row position
// would attach one pool's metadata to a different pool. Keying by pool_id is
// the entire point, and the reorder cases below are the ones that would catch a
// regression back to positional restore.
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = path.join(__dirname, '..', 'appscript/RoutePlanner.js');

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };

// RoutePlanner.js is a GAS file with top-level constants; load it in a context
// with the handful of globals it touches at parse time.
const ctx = {
  console, Date, String, Number, Math, JSON, Array, Object, isNaN, Set, Map,
  Logger: { log: () => {} }
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'RoutePlanner.js' });

const { captureRouteExtras_, mergeRouteExtras_ } = ctx;
// `function` declarations attach to the vm context; top-level `const` does not,
// so the constant is read out of the script scope explicitly.
const ROUTES_CORE_WIDTH = vm.runInContext('ROUTES_CORE_WIDTH', ctx);

// Core block: day, operator, pool_id, name, address, city, service, maps, lat, lng
const HEADERS = ['Day of Week','Operator','Pool ID','Customer Name','Address','City',
                 'Service','Maps Link','Lat','Lng','Pinned','Zone ID','Pin Reason'];
const core = (day, op, poolId, name) =>
  [day, op, poolId, name, '123 St', 'San Antonio', 'Weekly', 'http://m', 29.5, -98.4];

console.log('\nSanity: the core width the rebuild writes');
t('ROUTES_CORE_WIDTH is 10 (columns A-J)', ROUTES_CORE_WIDTH === 10);

// ── The regression that motivated all of this ───────────────────────────────
console.log('\n⚠️  Extras follow their POOL across a reorder, not their row number');
{
  // Before: Ana's pool on row 1, Luis's on row 2.
  const before = [HEADERS,
    [...core('Tuesday','Ana','P-001','Rivera'),   'FALSE', 'Z-NORTH', 'new_pool'],
    [...core('Thursday','Luis','P-002','Guzman'), 'TRUE',  'Z-SOUTH', 'promised_at_signing'],
  ];
  const cap = captureRouteExtras_(before, ROUTES_CORE_WIDTH);

  // After: the rebuild emits pinned first, so P-002 is now row 1 and P-001 row 2.
  const rebuilt = [
    core('Thursday','Luis','P-002','Guzman'),
    core('Tuesday','Ana','P-001','Rivera'),
  ];
  const out = mergeRouteExtras_(rebuilt, cap.extrasByPoolId, cap.width, ROUTES_CORE_WIDTH);

  t('P-002 keeps its OWN zone after moving to row 1', out[0][11] === 'Z-SOUTH',
    '(got ' + out[0][11] + ')');
  t('P-002 keeps its own pin_reason', out[0][12] === 'promised_at_signing',
    '(got ' + out[0][12] + ')');
  t('P-001 keeps its OWN zone after moving to row 2', out[1][11] === 'Z-NORTH',
    '(got ' + out[1][11] + ')');
  t('P-001 keeps its own pin_reason', out[1][12] === 'new_pool',
    '(got ' + out[1][12] + ')');
  // The positional-restore bug would have swapped these two.
  t('the two pools did NOT swap metadata', out[0][11] !== 'Z-NORTH' && out[1][11] !== 'Z-SOUTH');
}

console.log('\nApplies to UNPINNED rows too, not just pinned ones');
{
  // Both unpinned — the old code path preserved nothing for these at all.
  const before = [HEADERS,
    [...core('Monday','Ana','P-010','A'),  'FALSE', 'Z-A', 'new_pool'],
    [...core('Friday','Luis','P-011','B'), 'FALSE', 'Z-B', 'new_pool'],
  ];
  const cap = captureRouteExtras_(before, ROUTES_CORE_WIDTH);
  const out = mergeRouteExtras_(
    [core('Friday','Luis','P-011','B'), core('Monday','Ana','P-010','A')],
    cap.extrasByPoolId, cap.width, ROUTES_CORE_WIDTH);
  t('unpinned P-011 keeps its zone', out[0][11] === 'Z-B', '(got ' + out[0][11] + ')');
  t('unpinned P-010 keeps its zone', out[1][11] === 'Z-A', '(got ' + out[1][11] + ')');
}

console.log('\nFull width is restored, not truncated to the core block');
{
  const before = [HEADERS, [...core('Tuesday','Ana','P-001','R'), 'TRUE', 'Z-N', 'admin']];
  const cap = captureRouteExtras_(before, ROUTES_CORE_WIDTH);
  const out = mergeRouteExtras_([core('Tuesday','Ana','P-001','R')],
    cap.extrasByPoolId, cap.width, ROUTES_CORE_WIDTH);
  t('captured width matches the sheet', cap.width === 13, '(got ' + cap.width + ')');
  t('written row is full width', out[0].length === 13, '(got ' + out[0].length + ')');
  t('core columns are untouched', out[0][0] === 'Tuesday' && out[0][2] === 'P-001');
}

// ── A new pool must never inherit someone else's metadata ───────────────────
console.log('\n⚠️  A pool with no previous row gets BLANKS, never inherited values');
{
  const before = [HEADERS, [...core('Tuesday','Ana','P-001','R'), 'TRUE', 'Z-NORTH', 'admin']];
  const cap = captureRouteExtras_(before, ROUTES_CORE_WIDTH);
  // P-999 is brand new — it was not in the previous sheet at all.
  const out = mergeRouteExtras_([core('Monday','Luis','P-999','New')],
    cap.extrasByPoolId, cap.width, ROUTES_CORE_WIDTH);
  t('new pool is still full width', out[0].length === 13);
  t('new pool zone is blank', out[0][11] === '', '(got "' + out[0][11] + '")');
  t('new pool did NOT inherit Z-NORTH', out[0][11] !== 'Z-NORTH');
  t('new pool pin_reason is blank', out[0][12] === '');
}

console.log('\nMessy input degrades safely');
{
  t('no extra columns at all → rows pass through unchanged', (() => {
    const before = [HEADERS.slice(0, 10), core('Tuesday','Ana','P-001','R')];
    const cap = captureRouteExtras_(before, ROUTES_CORE_WIDTH);
    const rows = [core('Tuesday','Ana','P-001','R')];
    const out = mergeRouteExtras_(rows, cap.extrasByPoolId, cap.width, ROUTES_CORE_WIDTH);
    return cap.width === 10 && out[0].length === 10;
  })());

  t('empty sheet yields no extras', (() => {
    const cap = captureRouteExtras_([], ROUTES_CORE_WIDTH);
    return Object.keys(cap.extrasByPoolId).length === 0 && cap.width === 10;
  })());

  t('headers only, no data rows', (() => {
    const cap = captureRouteExtras_([HEADERS], ROUTES_CORE_WIDTH);
    return Object.keys(cap.extrasByPoolId).length === 0 && cap.width === 13;
  })());

  t('no rows to write returns empty', mergeRouteExtras_([], {}, 13, ROUTES_CORE_WIDTH).length === 0);

  t('missing pool_id header captures nothing rather than guessing', (() => {
    const noPid = ['Day','Operator','Something','Name','Addr','City','Svc','Maps','Lat','Lng','Pinned'];
    const cap = captureRouteExtras_([noPid, [...core('Tue','Ana','P-1','R'), 'TRUE']], ROUTES_CORE_WIDTH);
    return Object.keys(cap.extrasByPoolId).length === 0;
  })());

  t('blank pool_id rows are skipped, not keyed under ""', (() => {
    const cap = captureRouteExtras_(
      [HEADERS, [...core('Tue','Ana','','Ghost'), 'TRUE', 'Z-GHOST', 'admin']], ROUTES_CORE_WIDTH);
    return Object.keys(cap.extrasByPoolId).length === 0;
  })());
}

console.log('\nDuplicate pool_id: first row wins, no cross-contamination');
{
  const cap = captureRouteExtras_([HEADERS,
    [...core('Tuesday','Ana','P-001','R'),  'TRUE',  'Z-FIRST',  'admin'],
    [...core('Friday','Luis','P-001','Dup'),'FALSE', 'Z-SECOND', 'new_pool'],
  ], ROUTES_CORE_WIDTH);
  const out = mergeRouteExtras_([core('Tuesday','Ana','P-001','R')],
    cap.extrasByPoolId, cap.width, ROUTES_CORE_WIDTH);
  t('keeps the first row\'s extras', out[0][11] === 'Z-FIRST', '(got ' + out[0][11] + ')');
  t('does not silently take the later row', out[0][11] !== 'Z-SECOND');
}

console.log('\nShort/ragged prior rows pad rather than throw');
{
  // A row saved before a column existed is shorter than the header.
  const cap = captureRouteExtras_([HEADERS,
    [...core('Tuesday','Ana','P-001','R'), 'TRUE'],   // zone_id / pin_reason absent
  ], ROUTES_CORE_WIDTH);
  const out = mergeRouteExtras_([core('Tuesday','Ana','P-001','R')],
    cap.extrasByPoolId, cap.width, ROUTES_CORE_WIDTH);
  t('row is padded to full width', out[0].length === 13, '(got ' + out[0].length + ')');
  t('present value kept', out[0][10] === 'TRUE');
  t('absent values become blank, not undefined', out[0][11] === '' && out[0][12] === '');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
