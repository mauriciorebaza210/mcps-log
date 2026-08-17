// Schedule fast-path guard.
//
//   node tests/schedule-fast-path.test.js
//
// This stays intentionally lightweight: the schedule page has a large DOM surface,
// so this test locks the important wiring and fallback behavior in place.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function t(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log('  ok - ' + name);
  } else {
    fail += 1;
    console.log('  FAIL - ' + name + (detail ? ' ' + detail : ''));
  }
}

console.log('\nSchedule fast path');

const sheets = read('api/_sheets.js');
const endpoint = read('api/schedule.js');
const routes = read('js/features/routes.js');
const app = read('app.js');

t('Sheets helper exposes the Routes spreadsheet id',
  /DEFAULT_ROUTES_SS_ID/.test(sheets) && /routesSpreadsheetId/.test(sheets));

t('Schedule endpoint validates portal sessions before reading',
  /validatePortalSessionFromSheets/.test(endpoint) && /validatePortalSession/.test(endpoint));

t('Schedule endpoint uses a short server cache',
  /SCHEDULE_CACHE_MS\s*=\s*20\s*\*\s*1000/.test(endpoint) && /getCached\(cacheKey,\s*SCHEDULE_CACHE_MS/.test(endpoint));

t('Schedule endpoint reads route-specific Sheets tabs',
  /readExistingSheetRanges/.test(endpoint) &&
  /'Routes'/.test(endpoint) &&
  /Weekly_Overrides/.test(endpoint) &&
  /Scheduled_Visits/.test(endpoint) &&
  /Route_Distance_Cache/.test(endpoint) &&
  /Job_Completions/.test(endpoint));

t('Schedule endpoint returns route data with scheduled visits already merged',
  /scheduled_visits_merged:\s*true/.test(endpoint) &&
  /mergeScheduledVisits\(dayPools,\s*visits,\s*weekStart\)/.test(endpoint) &&
  /completions_by_date/.test(endpoint));

t('Schedule frontend calls the same-origin Schedule endpoint first',
  /apiLocalGet\('\/api\/schedule'/.test(routes) && /function _fetchRouteDataViaSheets_/.test(routes));

t('Schedule frontend retains GAS fallback',
  /function _fetchRouteDataViaGas_/.test(routes) &&
  /apiGet\(params\)/.test(routes) &&
  /scheduled_visits/.test(routes) &&
  /_fetchRouteDataViaSheets_\(op,\s*opts\)\.catch\(\(\)\s*=>\s*_fetchRouteDataViaGas_\(op\)\)/.test(routes));

t('Route cache clearing forces the next server read fresh',
  /window\._routeNextRefresh\s*=\s*true/.test(app) && /_routeShouldRefreshServer_/.test(routes));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
