// A2 — deriving draft zones from the pools we already run.
//
//   node tests/zone-proposals.test.js        (exits non-zero on failure)
//
// End-to-end: real Routes rows → RouteGeography.js → ServiceAreas.js proposals.
// Both files are loaded into one context, so a drift between the geography
// report and the proposer would fail here rather than in production.
//
// The property that matters most: A ZIP SERVED ON TWO DAYS IS NEVER
// AUTO-ASSIGNED. Whichever day the proposer picked, the customers on the other
// day would be silently moved onto a weekday nobody chose for them. It goes to
// `decisions` for a human instead.
//
// Second: PROPOSALS WRITE NOTHING. Accepting one means calling
// save_service_area, which re-runs every validation including ZIP conflicts.
const fs = require('fs'), vm = require('vm'), path = require('path');
const GEO = path.join(__dirname, '..', 'appscript/RouteGeography.js');
const SA  = path.join(__dirname, '..', 'appscript/ServiceAreas.js');

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };

const STONE_OAK  = [29.6180, -98.4850];
const NEAR_STONE = [29.6210, -98.4790];
const SOUTHSIDE  = [29.3200, -98.4900];

const ROUTES_H = ['Day of Week','Operator','Pool ID','Customer Name','Address','City',
                  'Service','Maps Link','Lat','Lng','Route Status'];
const SIGNED_H = ['pool_id','first_name','last_name','address','city','zip_code','status'];
const ZONE_H   = ['zone_id','zone_name','service_day','zips','primary_technician',
                  'max_per_day','active','color','notes','created_at','updated_at'];

// routes: [day, operator, pool_id, [lat,lng]]   signed: { pool_id: zip }
function build(routes, signedZips, zones, locations) {
  const routeRows = routes.map(r => [
    r[0], r[1], r[2], 'Cust ' + r[2], '1 St', 'San Antonio', 'Weekly', '',
    r[3] ? r[3][0] : 0, r[3] ? r[3][1] : 0, 'active'
  ]);
  const signedRows = Object.keys(signedZips || {}).map(pid =>
    [pid, 'Cust', pid, '1 St', 'San Antonio', signedZips[pid], 'ACTIVE_CUSTOMER']);
  const zoneRows = (zones || []).map(z => [
    z.zone_id, z.zone_name, z.service_day, z.zips, z.primary_technician || '',
    z.max_per_day === undefined ? '' : z.max_per_day,
    z.active === undefined ? 'TRUE' : z.active, '', '', '2026-01-01', '2026-01-01'
  ]);

  const mk = (headers, rows) => ({
    getLastRow: () => rows.length + 1,
    getDataRange: () => ({ getValues: () => [headers, ...rows] })
  });
  const zoneSheet = mk(ZONE_H, zoneRows);
  zoneSheet._name = 'Service_Areas';

  const writes = [], appended = [];
  const locs = locations || [];

  const ctx = {
    console, Date, String, Number, Math, JSON, Array, Object, isNaN, Infinity, RegExp,
    Logger: { log: () => {} },
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: (n) => {
          if (n === 'Routes') return mk(ROUTES_H, routeRows);
          if (n === 'Signed_Customers') return mk(SIGNED_H, signedRows);
          if (n === 'Service_Areas') return zoneSheet;
          return null;
        }
      })
    },
    CacheService: { getScriptCache: () => ({ remove: () => {} }) },
    sheetToObjects_: (sheet) => {
      if (sheet === zoneSheet || sheet._name === 'Service_Areas') {
        return { rows: zoneRows.map((r, i) => {
          const o = { _rowNum: i + 2 };
          ZONE_H.forEach((h, j) => { o[h] = r[j]; });
          return o;
        }) };
      }
      return { rows: locs };
    },
    ensureSheet_: (name) => ({ _name: name }),
    MCPS_LOCATION_HEADERS: [],
    findRowByValue_: (sheet, field, val) => {
      if (sheet === zoneSheet || sheet._name === 'Service_Areas') {
        const i = zoneRows.findIndex(r => String(r[ZONE_H.indexOf(field)]) === String(val));
        if (i === -1) return null;
        const o = { _rowNum: i + 2 };
        ZONE_H.forEach((h, j) => { o[h] = zoneRows[i][j]; });
        return o;
      }
      return locs.find(l => String(l[field]) === String(val)) || null;
    },
    value_: (o, f) => (o && o[f] != null && o[f] !== '' ? o[f] : ''),
    nowIso_: () => '2026-08-16T00:00:00Z',
    nextSequence_: () => 'ZONE-0099',
    appendObject_: (s, o) => appended.push(o),
    updateObjectRow_: (s, n, o) => writes.push({ n, o }),
    softSetCell_: (s, n, f, v) => writes.push({ n, f, v }),
    getTechnicianOperators_: () => [],
    schedulableDays_: () => ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY'],
    getHaversineDistance_(lat1, lon1, lat2, lon2) {
      const R = 3958.8;
      const dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
      const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(GEO, 'utf8'), ctx, { filename: 'RouteGeography.js' });
  vm.runInContext(fs.readFileSync(SA, 'utf8'), ctx, { filename: 'ServiceAreas.js' });
  ctx._writes = writes; ctx._appended = appended;
  return ctx;
}

// ── The rule that protects real customers ───────────────────────────────────
console.log('\n⚠️  A ZIP served on two days is NEVER auto-assigned to a zone');
{
  const ctx = build([
    ['TUESDAY',  'Ana',  'P-1', STONE_OAK],
    ['TUESDAY',  'Ana',  'P-2', NEAR_STONE],
    ['THURSDAY', 'Luis', 'P-3', STONE_OAK],
  ], { 'P-1': '78258', 'P-2': '78258', 'P-3': '78258' });
  const res = ctx.proposeServiceAreas_();

  const proposedZips = res.proposals.reduce((a, p) => a.concat(p.zips), []);
  t('the split ZIP appears in NO proposal', proposedZips.indexOf('78258') === -1,
    '(proposed: ' + proposedZips.join(',') + ')');
  t('it is raised as a decision instead', res.decisions.some(d => d.zip === '78258'));
  t('the decision names both days', res.decisions[0].days.length === 2);
  t('the decision explains why', /only one zone/.test(res.decisions[0].reason));
  t('a suggestion is offered but not applied', res.decisions[0].suggested_day === 'TUESDAY');
  t('decisions_required is counted', res.totals.decisions_required === 1);
}

// ── Normal derivation ───────────────────────────────────────────────────────
console.log('\nA clean day becomes one high-confidence proposal');
{
  const ctx = build([
    ['TUESDAY', 'Ana', 'P-1', STONE_OAK],
    ['TUESDAY', 'Ana', 'P-2', NEAR_STONE],
    ['TUESDAY', 'Ana', 'P-3', STONE_OAK],
  ], { 'P-1': '78258', 'P-2': '78259', 'P-3': '78258' });
  const res = ctx.proposeServiceAreas_();

  t('one proposal', res.proposals.length === 1, '(got ' + res.proposals.length + ')');
  t('it carries the day', res.proposals[0].service_day === 'TUESDAY');
  t('it carries both ZIPs', res.proposals[0].zips.join(',') === '78258,78259');
  t('pool count is reported', res.proposals[0].pools === 3);
  t('confidence is high for a tight single pocket', res.proposals[0].confidence === 'high',
    '(got ' + res.proposals[0].confidence + ')');
  t('the basis is stated in words', /already served on TUESDAY/.test(res.proposals[0].basis));
}

console.log('The technician already running the area is suggested, with a share');
{
  const ctx = build([
    ['TUESDAY', 'Ana',  'P-1', STONE_OAK],
    ['TUESDAY', 'Ana',  'P-2', NEAR_STONE],
    ['TUESDAY', 'Ana',  'P-3', STONE_OAK],
    ['TUESDAY', 'Luis', 'P-4', NEAR_STONE],
  ], { 'P-1': '78258', 'P-2': '78258', 'P-3': '78258', 'P-4': '78258' });
  const res = ctx.proposeServiceAreas_();
  t('dominant operator suggested', res.proposals[0].primary_technician === 'Ana');
  t('share is reported so a thin majority is visible',
    res.proposals[0].technician_share === 75, '(got ' + res.proposals[0].technician_share + ')');
}

console.log('Two pockets on one day become two proposals, not one bad zone');
{
  const ctx = build([
    ['FRIDAY', 'Ana',  'P-1', STONE_OAK],
    ['FRIDAY', 'Ana',  'P-2', NEAR_STONE],
    ['FRIDAY', 'Luis', 'P-3', SOUTHSIDE],
  ], { 'P-1': '78258', 'P-2': '78259', 'P-3': '78221' });
  const res = ctx.proposeServiceAreas_();
  t('two proposals for the one day', res.proposals.length === 2,
    '(got ' + res.proposals.length + ')');
  t('both are FRIDAY', res.proposals.every(p => p.service_day === 'FRIDAY'));
  t('the ZIPs are split between them', (() => {
    const a = res.proposals.find(p => p.zips.includes('78221'));
    return a && !a.zips.includes('78258');
  })());
  t('names are distinguished so they are not identical',
    res.proposals[0].zone_name !== res.proposals[1].zone_name);
  t('confidence is not "high" for a split day',
    res.proposals.every(p => p.confidence !== 'high'));
}

// ── Existing zones are respected ────────────────────────────────────────────
console.log('\nZIPs already owned by an active zone are skipped, not re-proposed');
{
  const ctx = build([
    ['TUESDAY', 'Ana', 'P-1', STONE_OAK],
    ['TUESDAY', 'Ana', 'P-2', NEAR_STONE],
  ], { 'P-1': '78258', 'P-2': '78259' },
     [{ zone_id: 'Z-N', zone_name: 'Stone Oak', service_day: 'TUESDAY', zips: '78258' }]);
  const res = ctx.proposeServiceAreas_();
  const proposedZips = res.proposals.reduce((a, p) => a.concat(p.zips), []);
  t('the owned ZIP is not re-proposed', proposedZips.indexOf('78258') === -1);
  t('the free ZIP still is', proposedZips.indexOf('78259') !== -1);
  t('the skip is reported, not silent', res.already_zoned.some(z => z.zip === '78258'));
  t('and it names the owning zone', res.already_zoned[0].zone_name === 'Stone Oak');
}

console.log('An ARCHIVED zone does not block a proposal');
{
  const ctx = build([['TUESDAY', 'Ana', 'P-1', STONE_OAK]], { 'P-1': '78258' },
    [{ zone_id: 'Z-N', zone_name: 'Old', service_day: 'TUESDAY', zips: '78258', active: 'FALSE' }]);
  const res = ctx.proposeServiceAreas_();
  t('the freed ZIP is proposed again',
    res.proposals.reduce((a, p) => a.concat(p.zips), []).indexOf('78258') !== -1);
}

// ── Naming ──────────────────────────────────────────────────────────────────
console.log('\nNaming prefers the label people already use');
{
  const ctx = build([['TUESDAY', 'Ana', 'P-1', STONE_OAK]], { 'P-1': '78258' }, [],
    [{ location_id: 'L-1', zip_code: '78258', area: 'Stone Oak' }]);
  const res = ctx.proposeServiceAreas_();
  t('the area label becomes the zone name', res.proposals[0].zone_name === 'Stone Oak',
    '(got ' + res.proposals[0].zone_name + ')');
}

console.log('With no area label it still produces a usable name');
{
  const ctx = build([['TUESDAY', 'Ana', 'P-1', STONE_OAK]], { 'P-1': '78258' });
  const res = ctx.proposeServiceAreas_();
  t('name is non-empty', !!res.proposals[0].zone_name);
  t('name is not "undefined"', !/undefined/.test(res.proposals[0].zone_name));
}

// ── Nothing is written ──────────────────────────────────────────────────────
console.log('\n⚠️  Proposing writes NOTHING');
{
  const ctx = build([
    ['TUESDAY', 'Ana', 'P-1', STONE_OAK],
    ['TUESDAY', 'Ana', 'P-2', NEAR_STONE],
  ], { 'P-1': '78258', 'P-2': '78259' });
  const res = ctx.proposeServiceAreas_();
  t('proposals were produced', res.proposals.length > 0);
  t('no row was appended', ctx._appended.length === 0);
  t('no cell was written', ctx._writes.length === 0);
  t('the response says so plainly', /nothing has been saved/i.test(res.note));
}

console.log('A proposal feeds save_service_area cleanly (accepting a draft)');
{
  const ctx = build([['TUESDAY', 'Ana', 'P-1', STONE_OAK]], { 'P-1': '78258' });
  const p = ctx.proposeServiceAreas_().proposals[0];
  const saved = ctx.handleSaveServiceArea_({ zone: p });
  t('the draft saves without edits', saved.ok === true, '(got ' + saved.error + ')');
  t('now it writes', ctx._appended.length === 1);
  t('the saved zone keeps the day', ctx._appended[0].service_day === 'TUESDAY');
  t('and the ZIPs', ctx._appended[0].zips === '78258');
}

console.log('\nEmpty and degenerate input');
{
  t('no routes → no proposals, no crash', (() => {
    const res = build([], {}).proposeServiceAreas_();
    return res.ok === true && res.proposals.length === 0;
  })());
  t('pools with no ZIP produce no phantom zone', (() => {
    const res = build([['TUESDAY', 'Ana', 'P-1', STONE_OAK]], {}).proposeServiceAreas_();
    return res.proposals.length === 0;
  })());
  t('handler wrapper never throws', (() => {
    const ctx = build([['TUESDAY', 'Ana', 'P-1', STONE_OAK]], { 'P-1': '78258' });
    return ctx.handleProposeServiceAreas_({}).ok === true;
  })());
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
