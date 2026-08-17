// Service Areas — the zone map behind route-locked start dates.
//
//   node tests/service-areas.test.js        (exits non-zero on failure)
//
// Four properties carry real consequence:
//
//   1. ONE ZIP, ONE ZONE. If two zones claim a ZIP, the same address resolves
//      to different days depending on row order — and a customer gets promised
//      a weekday by a coin flip.
//
//   2. BLANK max_per_day MEANS INFINITY, NOT ZERO. Number('') is 0. If blank
//      coerced to 0, every zone without an explicit cap would read as full and
//      the signing calendar would offer nobody any date. This exact trap
//      already shipped once in Followups (fuFinalLeadDays_).
//
//   3. CLUSTER AND FALLBACK NEVER PROMISE A DAY. They exist for technician
//      assignment. If resolution returned source:'zone' for a guess, bad map
//      coverage would fail silently behind a confident-looking page.
//
//   4. TWO ZONES CAN SHARE A DAY. North-Tuesday and South-Tuesday with
//      different technicians is the intended scaling path.
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = path.join(__dirname, '..', 'appscript/ServiceAreas.js');

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };

// zoneRows: [zone_id, zone_name, service_day, zips, primary_tech, max_per_day, active, color, notes]
function build(opts) {
  const o = opts || {};
  const zoneRows = (o.zones || []).map(z => [
    z.zone_id, z.zone_name, z.service_day, z.zips,
    z.primary_technician || '', z.max_per_day === undefined ? '' : z.max_per_day,
    z.active === undefined ? 'TRUE' : z.active, z.color || '', z.notes || '',
    '2026-01-01', '2026-01-01'
  ]);
  const HEADERS = ['zone_id','zone_name','service_day','zips','primary_technician',
                   'max_per_day','active','color','notes','created_at','updated_at'];

  const writes = [];
  const appended = [];
  const zoneSheet = {
    _name: 'Service_Areas',
    getLastRow: () => zoneRows.length + 1,
    getDataRange: () => ({ getValues: () => [HEADERS, ...zoneRows] })
  };

  const locations = o.locations || [];

  const ctx = {
    console, Date, String, Number, Math, JSON, Array, Object, isNaN, Infinity, RegExp,
    Logger: { log: () => {} },
    SpreadsheetApp: { openById: () => ({ getSheetByName: n => (n === 'Service_Areas' ? zoneSheet : null) }) },
    CacheService: { getScriptCache: () => ({ remove: () => {} }) },
    // Normalized-sheet helpers, matching SalesHub.js semantics.
    sheetToObjects_: (sheet) => {
      const src = sheet === zoneSheet ? zoneRows : locations.map(l => Object.values(l));
      if (sheet !== zoneSheet) return { rows: locations };
      return { rows: src.map((r, i) => {
        const obj = { _rowNum: i + 2 };
        HEADERS.forEach((h, j) => { obj[h] = r[j]; });
        return obj;
      }) };
    },
    ensureSheet_: (name) => ({ _name: name }),
    MCPS_LOCATION_HEADERS: [],
    findRowByValue_: (sheet, field, val) => {
      if (sheet === zoneSheet || sheet._name === 'Service_Areas') {
        const i = zoneRows.findIndex(r => String(r[HEADERS.indexOf(field)]) === String(val));
        if (i === -1) return null;
        const obj = { _rowNum: i + 2 };
        HEADERS.forEach((h, j) => { obj[h] = zoneRows[i][j]; });
        return obj;
      }
      const hit = locations.find(l => String(l[field]) === String(val));
      return hit || null;
    },
    value_: (obj, f) => (obj && obj[f] != null && obj[f] !== '' ? obj[f] : ''),
    nowIso_: () => '2026-08-16T00:00:00Z',
    nextSequence_: () => 'ZONE-0099',
    appendObject_: (s, obj) => appended.push(obj),
    updateObjectRow_: (s, rowNum, obj) => writes.push({ rowNum, obj }),
    softSetCell_: (s, rowNum, field, val) => writes.push({ rowNum, field, val }),
    getTechnicianOperators_: () => o.operators || [],
    // The REAL contract: WEEKDAYS is Mon–Sat (never Sunday), further narrowable
    // by the SCHEDULABLE_DAYS script property.
    schedulableDays_: () => o.schedulable ||
      ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'],
    aaRouteSnapshot_: () => o.snapshot || { hasCoords: false, stopsByDay: {} },
    aaClusterScore_: (coords, stops) => (stops && stops.length ? stops[0].score : Infinity)
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'ServiceAreas.js' });
  ctx._writes = writes; ctx._appended = appended;
  return ctx;
}

const NORTH = { zone_id: 'Z-N', zone_name: 'Stone Oak', service_day: 'TUESDAY', zips: '78258,78259,78260' };
const SOUTH = { zone_id: 'Z-S', zone_name: 'Southside', service_day: 'TUESDAY', zips: '78221,78223' };
const WEST  = { zone_id: 'Z-W', zone_name: 'Alamo Ranch', service_day: 'THURSDAY', zips: '78253,78254' };

// ── One ZIP, one zone ───────────────────────────────────────────────────────
console.log('\n⚠️  One ZIP belongs to exactly one zone');
{
  const ctx = build({ zones: [NORTH] });
  const res = ctx.handleSaveServiceArea_({
    zone: { zone_name: 'Overlap', service_day: 'FRIDAY', zips: '78259,78299' } });
  t('save is REJECTED', res.ok === false);
  t('the conflicting ZIP is named', /78259/.test(res.error), '(got ' + res.error + ')');
  t('the other zone is named, so it is actionable', /Stone Oak/.test(res.error));
  t('structured conflicts are returned', Array.isArray(res.conflicts) && res.conflicts[0].zone_id === 'Z-N');
  t('nothing was written', ctx._appended.length === 0 && ctx._writes.length === 0);
}

console.log('A zone may keep its own ZIPs when edited');
{
  const ctx = build({ zones: [NORTH] });
  const res = ctx.handleSaveServiceArea_({
    zone: { zone_id: 'Z-N', zone_name: 'Stone Oak', service_day: 'TUESDAY', zips: '78258,78259' } });
  t('editing itself is not a conflict', res.ok === true, '(got ' + res.error + ')');
  t('it updated rather than appended', ctx._writes.length === 1 && ctx._appended.length === 0);
}

console.log('An ARCHIVED zone releases its ZIPs');
{
  const ctx = build({ zones: [Object.assign({}, NORTH, { active: 'FALSE' })] });
  const res = ctx.handleSaveServiceArea_({
    zone: { zone_name: 'New North', service_day: 'MONDAY', zips: '78258' } });
  t('the freed ZIP can be reclaimed', res.ok === true, '(got ' + res.error + ')');
}

// ── Two zones, one day ──────────────────────────────────────────────────────
console.log('\nTwo zones can share a weekday with different technicians');
{
  const ctx = build({ zones: [
    Object.assign({}, NORTH, { primary_technician: 'Ana' }),
    Object.assign({}, SOUTH, { primary_technician: 'Luis' }) ] });
  const zones = ctx.listServiceAreas_(false);
  const tue = zones.filter(z => z.service_day === 'TUESDAY');
  t('both Tuesday zones exist', tue.length === 2);
  t('they have different technicians',
    tue[0].primary_technician !== tue[1].primary_technician);
  t('a north ZIP resolves to the north zone',
    ctx.resolveZoneForAddress_({ zip: '78258' }).zone_id === 'Z-N');
  t('a south ZIP resolves to the south zone',
    ctx.resolveZoneForAddress_({ zip: '78221' }).zone_id === 'Z-S');
  t('both promise the same day', ctx.resolveZoneForAddress_({ zip: '78258' }).service_day === 'TUESDAY' &&
    ctx.resolveZoneForAddress_({ zip: '78221' }).service_day === 'TUESDAY');
}

// ── The Number('') trap ─────────────────────────────────────────────────────
console.log('\n⚠️  Blank max_per_day is INFINITY, never 0 — Number("") is 0');
{
  const ctx = build({ zones: [
    Object.assign({}, NORTH, { max_per_day: '' }),
    Object.assign({}, SOUTH, { max_per_day: '22' }),
    Object.assign({}, WEST,  { max_per_day: 'abc' }) ] });
  const z = ctx.listServiceAreas_(false);
  const by = id => z.find(x => x.zone_id === id);
  t('blank → Infinity', by('Z-N').max_per_day === Infinity, '(got ' + by('Z-N').max_per_day + ')');
  t('blank is NOT 0', by('Z-N').max_per_day !== 0);
  t('a real number is kept', by('Z-S').max_per_day === 22);
  t('garbage → Infinity, not NaN, not 0', by('Z-W').max_per_day === Infinity);
  t('zero is treated as unset, not as a closed zone',
    ctx.saMaxPerDay_('0') === Infinity);
  t('negative is treated as unset', ctx.saMaxPerDay_('-5') === Infinity);
}

console.log('Infinity is sent as null, not a number the UI would show as a cap');
{
  const ctx = build({ zones: [Object.assign({}, NORTH, { max_per_day: '' })] });
  const out = ctx.handleGetServiceAreas_({});
  t('max_per_day is null on the wire', out.zones[0].max_per_day === null);
  t('JSON round-trips without becoming a number',
    JSON.parse(JSON.stringify(out)).zones[0].max_per_day === null);
}

// ── Resolution sources ──────────────────────────────────────────────────────
console.log('\n⚠️  Only override and zone may promise a day');
{
  const ctx = build({
    zones: [NORTH],
    locations: [{ location_id: 'L-1', zone_id: 'Z-N', zip_code: '78221' }]
  });
  const byZip = ctx.resolveZoneForAddress_({ zip: '78258' });
  t('ZIP match reports source "zone"', byZip.source === 'zone');
  t('and carries the day', byZip.service_day === 'TUESDAY');

  // The override must beat the ZIP — that is the oversized-ZIP escape hatch.
  const byOverride = ctx.resolveZoneForAddress_({ zip: '78221', locationId: 'L-1' });
  t('location override wins over ZIP', byOverride.source === 'override' && byOverride.zone_id === 'Z-N');
}

console.log('An unresolved address yields NO day promise');
{
  const ctx = build({ zones: [NORTH] });
  const res = ctx.resolveZoneForAddress_({ zip: '79999' });
  t('source is "none"', res.source === 'none', '(got ' + res.source + ')');
  t('no service_day', res.service_day === '');
  t('no zone_id', res.zone_id === '');
  t('no zone_name — nothing to render a false promise from', res.zone_name === '');
}

console.log('Cluster resolution assigns a day but NEVER a zone identity');
{
  const ctx = build({
    zones: [],
    schedulable: ['TUESDAY','THURSDAY'],
    snapshot: { hasCoords: true, stopsByDay: { TUESDAY: [{ score: 1 }], THURSDAY: [{ score: 9 }] } }
  });
  const res = ctx.resolveZoneForAddress_({ zip: '79999', coords: { lat: 29.6, lng: -98.4 } });
  t('source is "cluster", not "zone"', res.source === 'cluster', '(got ' + res.source + ')');
  t('nearest day is chosen', res.service_day === 'TUESDAY');
  t('zone_id stays EMPTY so no zone can be rendered', res.zone_id === '');
  t('zone_name stays EMPTY', res.zone_name === '');
}

console.log('An override pointing at an archived zone falls through, never promises');
{
  const ctx = build({
    zones: [Object.assign({}, NORTH, { active: 'FALSE' })],
    locations: [{ location_id: 'L-1', zone_id: 'Z-N', zip_code: '79999' }]
  });
  const res = ctx.resolveZoneForAddress_({ zip: '79999', locationId: 'L-1' });
  t('does not resolve to the archived zone', res.zone_id !== 'Z-N');
  t('source is not "override"', res.source !== 'override', '(got ' + res.source + ')');
}

// ── Validation and parsing ──────────────────────────────────────────────────
// ── The day must be one the scheduler can actually honour ───────────────────
console.log('\n⚠️  A zone can only be saved on a day we actually service');
{
  // WEEKDAYS is Mon–Sat: Sunday is never serviceable. A Sunday zone would
  // resolve to a weekday no technician can ever be assigned to, so the customer
  // would be promised a service day that cannot happen.
  const ctx = build({ zones: [] });
  const res = ctx.handleSaveServiceArea_({ zone: { zone_name: 'X', service_day: 'SUNDAY' } });
  t('Sunday is REFUSED', res.ok === false, '(got ok=' + res.ok + ')');
  t('the error says we do not service that day', /do not service/i.test(res.error));
  t('and lists the days that ARE allowed', /Monday/.test(res.error) && /Saturday/.test(res.error));
  t('the allowed set is returned for the UI', Array.isArray(res.schedulable_days) &&
    res.schedulable_days.indexOf('SUNDAY') === -1);
  t('nothing was written', ctx._appended.length === 0);
}

console.log('SCHEDULABLE_DAYS narrowing is respected, not hardcoded Mon-Sat');
{
  // The property can narrow the set further. A zone on a day removed by it must
  // be refused too, or the picker and the scheduler disagree.
  const ctx = build({ zones: [], schedulable: ['MONDAY','TUESDAY','WEDNESDAY'] });
  t('a day inside the narrowed set saves',
    ctx.handleSaveServiceArea_({ zone: { zone_name: 'X', service_day: 'TUESDAY' } }).ok === true);
  const res = ctx.handleSaveServiceArea_({ zone: { zone_name: 'Y', service_day: 'FRIDAY' } });
  t('a day outside it is refused even though it is a normal weekday', res.ok === false);
  t('the error lists only the narrowed days',
    /Monday/.test(res.error) && !/Friday/.test(res.error.replace(/^.*Choose one of: /, '')));
}

console.log('The allowed set is published so the UI cannot drift from it');
{
  const ctx = build({ zones: [NORTH], schedulable: ['MONDAY','TUESDAY'] });
  const out = ctx.handleGetServiceAreas_({});
  t('get_service_areas returns schedulable_days',
    JSON.stringify(out.schedulable_days) === '["MONDAY","TUESDAY"]',
    '(got ' + JSON.stringify(out.schedulable_days) + ')');
  t('Sunday is never in it', (out.schedulable_days || []).indexOf('SUNDAY') === -1);
}

console.log('\nValidation');
{
  const ctx = build({ zones: [] });
  t('name is required', ctx.handleSaveServiceArea_({ zone: { service_day: 'TUESDAY' } }).ok === false);
  t('a valid day is required',
    ctx.handleSaveServiceArea_({ zone: { zone_name: 'X', service_day: 'Someday' } }).ok === false);
  t('day casing is normalized',
    ctx.handleSaveServiceArea_({ zone: { zone_name: 'X', service_day: ' tuesday ' } }).ok === true);
  t('ZIP+4 is normalized to 5 digits', ctx.saNormalizeZip_('78258-1234') === '78258');
  t('non-ZIP text yields empty', ctx.saNormalizeZip_('none') === '');
  t('ZIP list dedupes and ignores junk',
    JSON.stringify(ctx.saParseZips_('78258, 78258 ,  , 78259; junk')) === '["78258","78259"]');
  t('an array of ZIPs is accepted',
    JSON.stringify(ctx.saParseZips_(['78258', '78259'])) === '["78258","78259"]');
}

console.log('Archive is reversible and never deletes');
{
  const ctx = build({ zones: [NORTH] });
  const res = ctx.handleArchiveServiceArea_({ zone_id: 'Z-N' });
  t('archive succeeds', res.ok === true && res.active === false);
  t('it set active=FALSE rather than removing the row',
    ctx._writes.some(w => w.field === 'active' && w.val === 'FALSE'));
  const restored = build({ zones: [Object.assign({}, NORTH, { active: 'FALSE' })] });
  t('restore flips it back',
    restored.handleArchiveServiceArea_({ zone_id: 'Z-N', restore: true }).active === true);
  t('unknown zone is refused', ctx.handleArchiveServiceArea_({ zone_id: 'NOPE' }).ok === false);
}

// ── Coverage ────────────────────────────────────────────────────────────────
console.log('\nCoverage surfaces gaps, prioritized by real customers');
{
  const ctx = build({
    zones: [NORTH],
    locations: [
      { location_id: 'L-1', zip_code: '78258' },   // covered
      { location_id: 'L-2', zip_code: '78221' },   // NOT covered
      { location_id: 'L-3', zip_code: '78221' },
      { location_id: 'L-4', zip_code: '79999' }    // not in the seed list at all
    ]
  });
  const cov = ctx.handleGetZoneCoverage_({});
  const zipOf = z => cov.zips.find(r => r.zip === z);

  t('an assigned ZIP shows its zone', zipOf('78258').zone_name === 'Stone Oak');
  t('an unassigned ZIP is marked unassigned', zipOf('78221').assigned === false);
  t('a ZIP outside the seed list still appears because customers live there',
    !!zipOf('79999'), 'seed list is a starting point, not a source of truth');
  t('customers per ZIP are counted', zipOf('78221').customers === 2);
  t('priority gaps are the ones with customers',
    cov.priority_gaps.length > 0 && cov.priority_gaps[0].zip === '78221');
  t('gaps are sorted by customer count', cov.priority_gaps[0].customers === 2);
  t('the headline number is customers without a zone',
    cov.totals.customers_without_zone === 3, '(got ' + cov.totals.customers_without_zone + ')');
}

// ── techsForZone_ ───────────────────────────────────────────────────────────
console.log('\ntechsForZone_ resolves the singular/plural mismatch');
{
  const ctx = build({
    zones: [Object.assign({}, NORTH, { primary_technician: 'Ana' })],
    operators: [
      { name: 'Ana',  preferredZones: ['Z-N'] },
      { name: 'Luis', preferredZones: ['Z-N', 'Z-S'] },
      { name: 'Rey',  preferredZones: ['Z-S'] },
      { name: 'Sam',  preferredZones: [] }
    ]
  });
  const zone = ctx.listServiceAreas_(false)[0];
  const techs = ctx.techsForZone_('Z-N', zone).map(t => t.name).sort();
  t('everyone with the zone in preferred_zones is included',
    techs.includes('Ana') && techs.includes('Luis'), '(got ' + techs.join(',') + ')');
  t('technicians preferring other zones are excluded', !techs.includes('Rey'));
  t('a technician with NO preferred zones is not silently included', !techs.includes('Sam'));
  t('no duplicates when the primary also prefers the zone', techs.filter(n => n === 'Ana').length === 1);
}

console.log('A zone is never left with nobody');
{
  const ctx = build({
    zones: [Object.assign({}, NORTH, { primary_technician: 'Ana' })],
    operators: [{ name: 'Rey', preferredZones: ['Z-S'] }]
  });
  const zone = ctx.listServiceAreas_(false)[0];
  const techs = ctx.techsForZone_('Z-N', zone);
  t('the primary technician is included even with no preferred_zones match',
    techs.length === 1 && techs[0].name === 'Ana');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
