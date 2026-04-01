// RoutePlanner.gs
// Drop-in replacement. Changes from previous version:
//   - Startup pools anchored to startup_start_date (exact calendar dates, not floating weekdays)
//   - Each remaining startup day gets its own one-off calendar event
//   - Monthly Full Service scheduled on a monthly recurring basis from monthly_start_date
//   - One-time services (Green-to-Clean, Repair, etc.) scheduled as a single calendar event
//   - syncRoutesToCalendar_ handles weekly recurring, startup one-offs, monthly recurring, and one-time events
//   - Duplicate series fix: 60-day wipe window + deletedSeriesIds Set

const CRM_SPREADSHEET_ID   = "1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E";
const ROUTES_SPREADSHEET_ID = "1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM";

const OFFICE_ADDRESS = "4640 S Flores Rd, Elmendorf, TX 78112";
const CALENDAR_NAME  = "MCPS Operator Routes";
const AUTH_SPREADSHEET_ID = "1e2XmGuosFSzeDQYMf3TYG3ZFfENYTyne5pqOi3L5m1g";
const AUTH_USERS_SHEET    = "Users";

// Sheet Names
const CRM_SIGNED_SHEET    = "Signed_Customers";
const GEOCODE_CACHE_SHEET = "Geocode_Cache";
const OPERATORS_SHEET     = "Operators";
const ROUTES_SHEET        = "Routes";

// Service-type matchers
const WEEKLY_MATCH  = s => s.toLowerCase().includes("weekly full service");
const MONTHLY_MATCH = s => s.toLowerCase().includes("monthly full service");
const ONETIME_MATCH = s =>
  s.toLowerCase().includes("green-to-clean") ||
  s.toLowerCase().includes("green to clean")  ||
  s.toLowerCase().includes("repair")           ||
  s.toLowerCase().includes("one-time")         ||
  s.toLowerCase().includes("one time");

// ─────────────────────────────────────────────────────────────────────────────


function getTechnicianOperators_() {
  const ss = SpreadsheetApp.openById(AUTH_SPREADSHEET_ID);
  const sh = ss.getSheetByName(AUTH_USERS_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];

  const data = sh.getDataRange().getValues();
  const h = data[0].map(x => String(x).trim().toLowerCase().replace(/ /g, '_'));

  const nameCol   = h.indexOf('name');
  const rolesCol  = h.indexOf('roles');
  const activeCol = h.indexOf('active');
  const daysCol   = h.indexOf('available_days');

  const out = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];

    const activeVal = activeCol !== -1 ? String(row[activeCol] ?? '').trim().toUpperCase() : 'TRUE';
    if (activeVal === 'FALSE') continue;

    const rolesRaw = rolesCol !== -1 ? String(row[rolesCol] || '') : '';
    const roles = rolesRaw.split(',').map(r => r.trim().toLowerCase()).filter(Boolean);
    if (!roles.includes('technician')) continue;

    const name = nameCol !== -1 ? String(row[nameCol] || '').trim() : '';
    if (!name) continue;

    const days = (daysCol !== -1 ? String(row[daysCol] || '') : '')
      .split(',')
      .map(d => d.trim().toUpperCase())
      .filter(Boolean);

    out.push({
      name: name,
      maxPerDay: 4,
      days: days.length ? days : ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'],
      currentDayLoad: 0
    });
  }

  return out;
}

function setupRoutingSystem() {
  const crmSs    = SpreadsheetApp.openById(CRM_SPREADSHEET_ID);
  const routesSs = SpreadsheetApp.openById(ROUTES_SPREADSHEET_ID);

  let opsSheet = routesSs.getSheetByName(OPERATORS_SHEET);
  if (!opsSheet) {
    opsSheet = routesSs.insertSheet(OPERATORS_SHEET);
    opsSheet.getRange(1, 1, 1, 4).setValues([[
      "Operator Name", "Max Pools Per Day",
      "Available Days (Comma Separated)", "Email Address"
    ]]).setFontWeight("bold");
    opsSheet.getRange(2, 1, 1, 4).setValues([[
      "John Doe", "5",
      "Monday, Tuesday, Wednesday, Thursday, Friday",
      "john@example.com"
    ]]);
    opsSheet.setFrozenRows(1);
    opsSheet.autoResizeColumns(1, 4);
    Logger.log("Created Operators sheet");
  }

  let routesSheet = routesSs.getSheetByName(ROUTES_SHEET);
  if (!routesSheet) routesSheet = routesSs.insertSheet(ROUTES_SHEET);
  routesSheet.getRange(1, 1, 1, 10).setValues([[
    "Day of Week","Operator","Pool ID","Customer Name",
    "Address","City","Service","Maps Link","Lat","Lng"
  ]]).setFontWeight("bold");
  routesSheet.setFrozenRows(1);
  Logger.log("Created/Updated Routes sheet");
/*
  const triggers = ScriptApp.getProjectTriggers();
  if (!triggers.some(t => t.getHandlerFunction() === "autoRecalculateRoutes" && t.getTriggerSourceId() === crmSs.getId())) {
    ScriptApp.newTrigger("autoRecalculateRoutes").forSpreadsheet(crmSs).onChange().create();
    Logger.log("Created trigger on CRM");
  }
  if (!triggers.some(t => t.getHandlerFunction() === "autoRecalculateRoutes" && t.getTriggerSourceId() === routesSs.getId())) {
    ScriptApp.newTrigger("autoRecalculateRoutes").forSpreadsheet(routesSs).onChange().create();
    Logger.log("Created trigger on Routes");
  }
  */
  try { SpreadsheetApp.getActiveSpreadsheet().toast("Routing System Initialized!", "MCPS"); } catch(e) {}
}

function autoRecalculateRoutes(e) {
  // Intentionally no auto-recalc to enforce confirmation workflow.
  // Keep this as a safe no-op if old triggers still exist.
  Logger.log("autoRecalculateRoutes blocked: use confirmAndCalculateRoutes() instead.");
}

// ── One-time nuke for cleaning up stacked duplicate calendar events ───────────
function nukeRoutesCalendar() {
  const cals = CalendarApp.getCalendarsByName(CALENDAR_NAME);
  if (cals.length === 0) { Logger.log("Calendar not found"); return; }
  const cal = cals[0];
  const now = new Date(); now.setHours(0,0,0,0);
  const far = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  const events = cal.getEvents(now, far);
  const deletedSeriesIds = new Set();
  for (const e of events) {
    try {
      if (e.isRecurringEvent()) {
        const s = e.getEventSeries();
        if (!deletedSeriesIds.has(s.getId())) { s.deleteEventSeries(); deletedSeriesIds.add(s.getId()); }
      } else { e.deleteEvent(); }
    } catch(err) { Logger.log("Nuke error: " + err); }
  }
  Logger.log("Nuke done. Deleted " + deletedSeriesIds.size + " series.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Haversine distance (miles)
// ─────────────────────────────────────────────────────────────────────────────
function getHaversineDistance_(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ─────────────────────────────────────────────────────────────────────────────
// Geocode cache
// ─────────────────────────────────────────────────────────────────────────────
function getGeocodeCache_(crmSs) {
  let cacheSheet = crmSs.getSheetByName(GEOCODE_CACHE_SHEET);
  if (!cacheSheet) {
    cacheSheet = crmSs.insertSheet(GEOCODE_CACHE_SHEET);
    cacheSheet.getRange(1,1,1,3).setValues([["Full Address","Lat","Lng"]]).setFontWeight("bold");
    cacheSheet.setFrozenRows(1);
  }
  const lastRow = cacheSheet.getLastRow();
  const cache = {};
  if (lastRow > 1) {
    cacheSheet.getRange(2,1,lastRow-1,3).getValues().forEach(row => {
      const addr = String(row[0]).trim().toLowerCase();
      const lat = parseFloat(row[1]), lng = parseFloat(row[2]);
      if (addr && !isNaN(lat) && !isNaN(lng)) cache[addr] = {lat, lng};
    });
  }
  return {cacheSheet, cache};
}

// ─────────────────────────────────────────────────────────────────────────────
// K-Means++ spatial clustering
// ─────────────────────────────────────────────────────────────────────────────
function getKMeansClusters_(pools, K) {
  if (pools.length === 0) return [];
  if (pools.length <= K) return pools.map(p => [p]);
  let centroids = [{lat: pools[0].lat, lng: pools[0].lng}];
  while (centroids.length < K) {
    let maxDist = -1, farthest = pools[0];
    for (const p of pools) {
      const d = Math.min(...centroids.map(c => getHaversineDistance_(p.lat,p.lng,c.lat,c.lng)));
      if (d > maxDist) { maxDist = d; farthest = p; }
    }
    centroids.push({lat: farthest.lat, lng: farthest.lng});
  }
  let clusters = [];
  for (let iter = 0; iter < 15; iter++) {
    clusters = Array.from({length: K}, () => []);
    for (const p of pools) {
      let minD = Infinity, idx = 0;
      centroids.forEach((c,i) => { const d = getHaversineDistance_(p.lat,p.lng,c.lat,c.lng); if(d<minD){minD=d;idx=i;} });
      clusters[idx].push(p);
    }
    for (let i = 0; i < K; i++) {
      if (!clusters[i].length) continue;
      centroids[i].lat = clusters[i].reduce((s,p)=>s+p.lat,0)/clusters[i].length;
      centroids[i].lng = clusters[i].reduce((s,p)=>s+p.lng,0)/clusters[i].length;
    }
  }
  return clusters;
}

function clusterCentroid_(cluster) {
  if (!cluster || !cluster.length) return {lat:0,lng:0};
  return {
    lat: cluster.reduce((s,p)=>s+p.lat,0)/cluster.length,
    lng: cluster.reduce((s,p)=>s+p.lng,0)/cluster.length
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekday helpers
// ─────────────────────────────────────────────────────────────────────────────
function addWeekdays_(date, n) {
  const d = new Date(date.getTime());
  let added = 0;
  while (added < n) { d.setDate(d.getDate()+1); if(d.getDay()!==0) added++; } // only skip Sunday
  return d;
}

function dateToWeekdayKey_(date) {
  return ["SUNDAY","MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY"][date.getDay()];
}

// ─────────────────────────────────────────────────────────────────────────────
// Geocode a list of pool objects in-place using cache
// ─────────────────────────────────────────────────────────────────────────────
function geocodePools_(pools, cache, cacheSheet, newCacheRows) {
  let geocoder = null;
  for (const p of pools) {
    const key = p.fullAddress.toLowerCase();
    if (cache[key]) {
      p.lat = cache[key].lat; p.lng = cache[key].lng;
    } else {
      if (!geocoder) geocoder = Maps.newGeocoder();
      try {
        Utilities.sleep(150);
        const res = geocoder.geocode(p.fullAddress);
        if (res.status === 'OK' && res.results.length > 0) {
          const loc = res.results[0].geometry.location;
          p.lat = loc.lat; p.lng = loc.lng;
          cache[key] = {lat: p.lat, lng: p.lng};
          newCacheRows.push([p.fullAddress, p.lat, p.lng]);
        }
      } catch(e) { Logger.log("Geocode error: " + p.fullAddress + " — " + e); }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
function calculateRoutes() {
  const crmSs    = SpreadsheetApp.openById(CRM_SPREADSHEET_ID);
  const routesSs = SpreadsheetApp.openById(ROUTES_SPREADSHEET_ID);

  const signedSheet = crmSs.getSheetByName(CRM_SIGNED_SHEET);
  const opsSheet    = routesSs.getSheetByName(OPERATORS_SHEET);
  const routesSheet = routesSs.getSheetByName(ROUTES_SHEET);

  if (!signedSheet || !opsSheet || !routesSheet) {
    throw new Error("Missing required sheet (Signed_Customers / Operators / Routes).");
  }

  // ── 1. Read operators from Users sheet (technician role only) ─────────────
  const operators = getTechnicianOperators_();
  if (!operators.length) {
    throw new Error("No active technician users found in Users sheet.");
  }

  // ── 2. Read existing Routes sheet — extract pinned assignments ────────────
  // Pinned pools are completely untouched. We preserve their day, operator,
  // maps link, lat, lng, and all other columns as-is.
  const pinnedRows = [];      // raw row arrays to re-write verbatim
  const pinnedPoolIds = new Set(); // pool_ids that are pinned — skip in clustering

  if (routesSheet.getLastRow() > 1) {
    const existingData    = routesSheet.getDataRange().getValues();
    const existingHeaders = existingData[0].map(h => String(h || '').trim().toLowerCase().replace(/ /g, '_'));
    const ePidCol    = existingHeaders.indexOf('pool_id');
    const ePinnedCol = existingHeaders.indexOf('pinned');

    for (let i = 1; i < existingData.length; i++) {
      const row     = existingData[i];
      const poolId  = String(row[ePidCol]    || '').trim();
      const pinned  = String(row[ePinnedCol] || '').toUpperCase() === 'TRUE';
      if (poolId && pinned) {
        pinnedRows.push(row);
        pinnedPoolIds.add(poolId);
      }
    }
    Logger.log(`RoutePlanner: ${pinnedRows.length} pinned pools preserved.`);
  }

  // ── 3. Read signed customers ──────────────────────────────────────────────
  const customersData = signedSheet.getDataRange().getValues();
  if (customersData.length < 2) return;
  const cH = customersData[0].map(h => String(h).trim().toLowerCase());

  const col = name => cH.indexOf(name);
  const poolIdCol        = col('pool_id');
  const firstCol         = col('first_name');
  const lastCol          = col('last_name');
  const addrCol          = col('address');
  const cityCol          = col('city');
  const zipCol           = col('zip_code');
  const servCol          = col('service');
  const statusCol        = col('status');
  const svcStatusCol     = col('service_status');
  const totalDaysCol     = col('startup_total_days');
  const startupStartCol  = col('startup_start_date');
  const completeCol      = col('startup_complete');
  const visitsLoggedCol  = col('startup_visits_logged');
  const monthlyStartCol  = col('monthly_start_date');
  const scheduledDateCol = col('scheduled_date');

  const poolsWeekly  = [];
  const poolsStartup = [];
  const poolsMonthly = [];
  const poolsOneTime = [];

  for (let i = 1; i < customersData.length; i++) {
    const row       = customersData[i];
    const service   = String(row[servCol]      || '').trim();
    const rawStatus = String(row[statusCol]    || '').trim().toUpperCase();
    const svcStatus = String(row[svcStatusCol] || '').trim().toUpperCase();
    if (rawStatus === 'LOST' || svcStatus === 'LOST') continue;

    const address  = String(row[addrCol] || '').trim();
    const city     = String(row[cityCol] || '').trim();
    const zip      = String(row[zipCol]  || '').trim();
    const fullAddr = `${address}, ${city}, TX ${zip}`.trim();
    const poolId   = String(row[poolIdCol] || '');

    const base = {
      pool_id:      poolId,
      customerName: `${String(row[firstCol] || '')} ${String(row[lastCol] || '')}`.trim(),
      address, city, service, fullAddress: fullAddr,
      lat: 0, lng: 0, isOffice: false
    };

    // ── Startup ──────────────────────────────────────────────────────────────
    const totalDays  = totalDaysCol  !== -1 ? (Number(row[totalDaysCol]) || 0) : 0;
    const isComplete = completeCol   !== -1 ? (String(row[completeCol] || '').toUpperCase() === 'TRUE') : true;
    const visLogged  = visitsLoggedCol !== -1 ? (Number(row[visitsLoggedCol]) || 0) : 0;

    if (totalDays > 0 && !isComplete) {
      poolsStartup.push({
        ...base,
        isStartup:        true,
        startupStartDate: startupStartCol !== -1 ? row[startupStartCol] : null,
        startupDaysDone:  visLogged,
        startupDaysLeft:  Math.max(1, totalDays - visLogged),
        startupTotal:     totalDays,
        service:          `Pool Startup (Day ${visLogged + 1}/${totalDays})`
      });
      continue;
    }

    // ── Monthly ──────────────────────────────────────────────────────────────
    if (MONTHLY_MATCH(service)) {
      poolsMonthly.push({
        ...base,
        monthlyStartDate: monthlyStartCol !== -1 ? row[monthlyStartCol] : null
      });
      continue;
    }

    // ── One-time ─────────────────────────────────────────────────────────────
    if (ONETIME_MATCH(service)) {
      poolsOneTime.push({
        ...base,
        scheduledDate: scheduledDateCol !== -1 ? row[scheduledDateCol] : null
      });
      continue;
    }

    // ── Weekly — skip if already pinned ──────────────────────────────────────
    if (WEEKLY_MATCH(service)) {
      if (pinnedPoolIds.has(poolId)) {
        Logger.log(`RoutePlanner: Skipping pinned pool ${poolId} (${base.customerName})`);
        continue;
      }
      poolsWeekly.push({ ...base });
    }
  }

  // ── 4. Geocode + cache ────────────────────────────────────────────────────
  const officeNode = { fullAddress: OFFICE_ADDRESS, isOffice: true, lat: 0, lng: 0 };
  const { cacheSheet, cache } = getGeocodeCache_(crmSs);
  const newCacheRows = [];

  geocodePools_(
    [...poolsWeekly, ...poolsStartup, ...poolsMonthly, ...poolsOneTime, officeNode],
    cache, cacheSheet, newCacheRows
  );

  if (newCacheRows.length > 0) {
    cacheSheet.getRange(cacheSheet.getLastRow() + 1, 1, newCacheRows.length, 3).setValues(newCacheRows);
  }
  if (officeNode.lat === 0 && officeNode.lng === 0) {
    officeNode.lat = 29.2619; officeNode.lng = -98.3245;
  }

  // ── Shared setup ──────────────────────────────────────────────────────────
  const WEEKDAYS = ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];

  const routeGroupsForCalendar = {
    _startupDates: {},
    _monthlyDates: {},
    _oneTimeDates: {}
  };
  for (const d of WEEKDAYS) routeGroupsForCalendar[d] = {};

  const allRouteRows = [];

  // ── 5. Re-insert pinned rows verbatim ─────────────────────────────────────
  // These are written directly to allRouteRows as-is — no changes at all.
  pinnedRows.forEach(row => {
    allRouteRows.push(row.slice(0, 10)); // columns A-J (day,op,pool_id,...,lat,lng)

    // Also rebuild calendar group so calendar stays in sync
    const dayRaw = String(row[0] || '').trim().toUpperCase();
    const opName = String(row[1] || '').trim();
    const mapsLk = String(row[7] || '').trim();
    if (WEEKDAYS.includes(dayRaw)) {
      if (!routeGroupsForCalendar[dayRaw][opName]) {
        routeGroupsForCalendar[dayRaw][opName] = { pools: [], mapsUrl: mapsLk };
      }
      routeGroupsForCalendar[dayRaw][opName].pools.push({
        customerName: String(row[3] || ''),
        address:      String(row[4] || ''),
        city:         String(row[5] || ''),
        service:      String(row[6] || ''),
        pool_id:      String(row[2] || '')
      });
    }
  });

  // ── 6a. Startup pools ─────────────────────────────────────────────────────
  const startupDayLoad = {};

  for (const sp of poolsStartup) {
    const TOTAL = 3;
    let startDate = null;
    if (sp.startupStartDate) {
      startDate = sp.startupStartDate instanceof Date
        ? new Date(sp.startupStartDate.getTime())
        : new Date(sp.startupStartDate);
    }
    if (!startDate || isNaN(startDate.getTime())) {
      Logger.log(`Startup ${sp.pool_id}: no valid startup_start_date, skipping.`);
      continue;
    }
    startDate.setHours(0, 0, 0, 0);

    const allDates       = [startDate, addWeekdays_(startDate, 1), addWeekdays_(startDate, 2)];
    const remainingDates = allDates.slice(sp.startupDaysDone);
    if (!remainingDates.length) continue;

    for (let di = 0; di < remainingDates.length; di++) {
      const targetDate   = remainingDates[di];
      const weekdayKey   = dateToWeekdayKey_(targetDate);
      const visitNumber  = sp.startupDaysDone + di + 1;
      const serviceLabel = `Pool Startup — Day ${visitNumber}/${TOTAL}`;
      const prettyDay    = weekdayKey.charAt(0) + weekdayKey.slice(1).toLowerCase();

      let assignedOp = null;
      for (const op of operators) {
        if (!op.days.includes(weekdayKey)) continue;
        const loadKey = `${op.name}||${weekdayKey}`;
        if ((startupDayLoad[loadKey] || 0) >= op.maxPerDay) continue;
        assignedOp = op;
        startupDayLoad[loadKey] = (startupDayLoad[loadKey] || 0) + 1;
        break;
      }
      const opName  = assignedOp ? assignedOp.name : 'UNASSIGNED';
      const mapsUrl = `https://www.google.com/maps/dir/${encodeURIComponent(OFFICE_ADDRESS)}/${encodeURIComponent(sp.fullAddress)}/${encodeURIComponent(OFFICE_ADDRESS)}`;

      allRouteRows.push([prettyDay, opName, sp.pool_id, sp.customerName, sp.address, sp.city, serviceLabel, mapsUrl, sp.lat, sp.lng]);

      const dateKey = targetDate.toISOString().split('T')[0];
      if (!routeGroupsForCalendar._startupDates[dateKey]) routeGroupsForCalendar._startupDates[dateKey] = {};
      if (!routeGroupsForCalendar._startupDates[dateKey][opName])
        routeGroupsForCalendar._startupDates[dateKey][opName] = { pools: [], mapsUrl, date: targetDate };
      routeGroupsForCalendar._startupDates[dateKey][opName].pools.push({ ...sp, service: serviceLabel });
      routeGroupsForCalendar._startupDates[dateKey][opName].mapsUrl = mapsUrl;
    }
  }

  // ── 6b. Monthly pools ─────────────────────────────────────────────────────
  for (const mp of poolsMonthly) {
    let startDate = null;
    if (mp.monthlyStartDate) {
      startDate = mp.monthlyStartDate instanceof Date
        ? new Date(mp.monthlyStartDate.getTime())
        : new Date(mp.monthlyStartDate);
    }
    if (!startDate || isNaN(startDate.getTime())) {
      Logger.log(`Monthly ${mp.pool_id}: no valid monthly_start_date, skipping.`);
    }
    const weekdayKey = startDate ? dateToWeekdayKey_(startDate) : null;
    let assignedOp = null;
    if (weekdayKey) {
      for (const op of operators) {
        if (op.days.includes(weekdayKey)) { assignedOp = op; break; }
      }
    }
    const opName    = assignedOp ? assignedOp.name : 'UNASSIGNED';
    const prettyDay = weekdayKey ? weekdayKey.charAt(0) + weekdayKey.slice(1).toLowerCase() : 'UNSCHEDULED';
    const mapsUrl   = `https://www.google.com/maps/dir/${encodeURIComponent(OFFICE_ADDRESS)}/${encodeURIComponent(mp.fullAddress)}/${encodeURIComponent(OFFICE_ADDRESS)}`;

    allRouteRows.push([prettyDay, opName, mp.pool_id, mp.customerName, mp.address, mp.city, mp.service, mapsUrl, mp.lat, mp.lng]);

    if (startDate) {
      startDate.setHours(0, 0, 0, 0);
      const dateKey = startDate.toISOString().split('T')[0];
      if (!routeGroupsForCalendar._monthlyDates[dateKey]) routeGroupsForCalendar._monthlyDates[dateKey] = {};
      if (!routeGroupsForCalendar._monthlyDates[dateKey][opName])
        routeGroupsForCalendar._monthlyDates[dateKey][opName] = { pools: [], mapsUrl, date: startDate };
      routeGroupsForCalendar._monthlyDates[dateKey][opName].pools.push(mp);
      routeGroupsForCalendar._monthlyDates[dateKey][opName].mapsUrl = mapsUrl;
    }
  }

  // ── 6c. One-time pools ────────────────────────────────────────────────────
  for (const ot of poolsOneTime) {
    let schedDate = null;
    if (ot.scheduledDate) {
      schedDate = ot.scheduledDate instanceof Date
        ? new Date(ot.scheduledDate.getTime())
        : new Date(ot.scheduledDate);
    }
    if (!schedDate || isNaN(schedDate.getTime())) {
      Logger.log(`One-time ${ot.pool_id}: no valid scheduled_date, skipping.`);
    }
    const weekdayKey = schedDate ? dateToWeekdayKey_(schedDate) : null;
    let assignedOp = null;
    if (weekdayKey) {
      for (const op of operators) {
        if (op.days.includes(weekdayKey)) { assignedOp = op; break; }
      }
    }
    const opName    = assignedOp ? assignedOp.name : 'UNASSIGNED';
    const prettyDay = weekdayKey ? weekdayKey.charAt(0) + weekdayKey.slice(1).toLowerCase() : 'UNSCHEDULED';
    const mapsUrl   = `https://www.google.com/maps/dir/${encodeURIComponent(OFFICE_ADDRESS)}/${encodeURIComponent(ot.fullAddress)}/${encodeURIComponent(OFFICE_ADDRESS)}`;

    allRouteRows.push([prettyDay, opName, ot.pool_id, ot.customerName, ot.address, ot.city, ot.service, mapsUrl, ot.lat, ot.lng]);

    if (schedDate) {
      schedDate.setHours(0, 0, 0, 0);
      const dateKey = schedDate.toISOString().split('T')[0];
      if (!routeGroupsForCalendar._oneTimeDates[dateKey]) routeGroupsForCalendar._oneTimeDates[dateKey] = {};
      if (!routeGroupsForCalendar._oneTimeDates[dateKey][opName])
        routeGroupsForCalendar._oneTimeDates[dateKey][opName] = { pools: [], mapsUrl, date: schedDate };
      routeGroupsForCalendar._oneTimeDates[dateKey][opName].pools.push(ot);
      routeGroupsForCalendar._oneTimeDates[dateKey][opName].mapsUrl = mapsUrl;
    }
  }

  // ── 6d. Weekly pools — balanced clustering ────────────────────────────────
  if (poolsWeekly.length && operators.length) {

    // Derive per-operator max per day:
    // If operator has max_per_day set in Users sheet → use it.
    // Otherwise → derive from total pools / operators / their working days,
    // capped at a reasonable ceiling so no one gets buried.
    const totalUnpinned  = poolsWeekly.length;
    const totalOpDays    = operators.reduce((sum, op) => sum + op.days.length, 0);
    // Natural load = how many pools per op-day if spread perfectly evenly
    const naturalPerDay  = totalOpDays > 0 ? Math.ceil(totalUnpinned / totalOpDays) : 3;

    operators.forEach(op => {
      op.maxPerDay = Math.max(1, naturalPerDay);
    });

    Logger.log(`RoutePlanner: ${totalUnpinned} un-pinned weekly pools, naturalPerDay=${naturalPerDay}`);
    operators.forEach(op => Logger.log(`  ${op.name}: maxPerDay=${op.maxPerDay}, days=${op.days.join(',')}`));

    // Build one slot per (operator × day) they work
    const operatorSlots = [];
    for (const day of WEEKDAYS) {
      for (const op of operators) {
        if (op.days.includes(day)) {
          operatorSlots.push({ day, opName: op.name, max: op.maxPerDay });
        }
      }
    }

    // K = number of clusters = ceil(pools / naturalPerDay),
    // capped at available slots and pool count
    const K = Math.min(
      Math.ceil(totalUnpinned / Math.max(1, naturalPerDay)),
      operatorSlots.length,
      totalUnpinned
    );

    Logger.log(`RoutePlanner: K=${K} clusters`);

    let spatialClusters = getKMeansClusters_(poolsWeekly, K);

    // Adaptive merge — only merge geographically close clusters that
    // would still fit within the receiving slot's max
    let merged = true;
    while (merged && spatialClusters.length > 1) {
      merged = false;
      let bestDist = Infinity, bestI = -1, bestJ = -1;
      for (let i = 0; i < spatialClusters.length; i++) {
        for (let j = i + 1; j < spatialClusters.length; j++) {
          // Combined size must not exceed naturalPerDay
          if (spatialClusters[i].length + spatialClusters[j].length > naturalPerDay) continue;
          const centI = clusterCentroid_(spatialClusters[i]);
          const centJ = clusterCentroid_(spatialClusters[j]);
          const dist  = getHaversineDistance_(centI.lat, centI.lng, centJ.lat, centJ.lng);
          // Only merge if centroids are close (3 miles) — keeps zones tight
          if (dist > 3) continue;
          if (dist < bestDist) { bestDist = dist; bestI = i; bestJ = j; }
        }
      }
      if (bestI !== -1) {
        spatialClusters[bestI] = spatialClusters[bestI].concat(spatialClusters[bestJ]);
        spatialClusters.splice(bestJ, 1);
        merged = true;
        Logger.log(`RoutePlanner: merged clusters (${bestDist.toFixed(1)} mi) → ${spatialClusters.length} clusters`);
      }
    }

    Logger.log(`RoutePlanner: final cluster count = ${spatialClusters.length}`);
    spatialClusters.sort((a, b) => b.length - a.length); // largest clusters first

    // ── Balanced round-robin slot assignment ──────────────────────────────
    // Always give the next cluster to the operator with the fewest pools so far.
    // Within that operator, pick the earliest available day.
    const opTotalLoad   = {};
    operators.forEach(op => { opTotalLoad[op.name] = 0; });
    const usedSlotKeys  = new Set(); // "OpName||DAY" — one cluster per op+day
    const assignedSlots = [];

    for (let i = 0; i < spatialClusters.length; i++) {
      const clusterSize = spatialClusters[i].length;

      // Sort operators by current total load (ascending)
      const sortedOps = operators.slice().sort((a, b) =>
        opTotalLoad[a.name] - opTotalLoad[b.name]
      );

      let picked = null;
      outer:
      for (const op of sortedOps) {
        for (const day of WEEKDAYS) {
          if (!op.days.includes(day)) continue;
          const slotKey = `${op.name}||${day}`;
          if (usedSlotKeys.has(slotKey)) continue;
          const slot = operatorSlots.find(s => s.day === day && s.opName === op.name);
          if (!slot) continue;
          picked = slot;
          break outer;
        }
      }

      // Fallback: any unused slot
      if (!picked) {
        for (const slot of operatorSlots) {
          const slotKey = `${slot.opName}||${slot.day}`;
          if (!usedSlotKeys.has(slotKey)) { picked = slot; break; }
        }
      }

      assignedSlots.push(picked || null);
      if (picked) {
        usedSlotKeys.add(`${picked.opName}||${picked.day}`);
        opTotalLoad[picked.opName] = (opTotalLoad[picked.opName] || 0) + clusterSize;
      }
    }

    // ── Place clusters into routes ────────────────────────────────────────
    const overflow = [];

    for (let i = 0; i < spatialClusters.length; i++) {
      const slot = assignedSlots[i];
      if (!slot) { overflow.push(...spatialClusters[i]); continue; }

      let cluster = spatialClusters[i].slice();
      if (cluster.length > slot.max) {
        overflow.push(...cluster.slice(slot.max));
        cluster = cluster.slice(0, slot.max);
      }

      // Order within cluster: farthest from office first, then nearest-neighbor back
      cluster.sort((a, b) =>
        getHaversineDistance_(officeNode.lat, officeNode.lng, b.lat, b.lng) -
        getHaversineDistance_(officeNode.lat, officeNode.lng, a.lat, a.lng)
      );

      const dailyPools = [cluster.shift()];
      let cur = { lat: dailyPools[0].lat, lng: dailyPools[0].lng };

      while (cluster.length) {
        let bestD = Infinity, bestIdx = 0;
        cluster.forEach((p, j) => {
          if (p.lat === 0 && p.lng === 0) return;
          const d = getHaversineDistance_(cur.lat, cur.lng, p.lat, p.lng);
          if (d < bestD) { bestD = d; bestIdx = j; }
        });
        const next = cluster.splice(bestIdx, 1)[0];
        dailyPools.push(next);
        cur = { lat: next.lat, lng: next.lng };
      }

      if (dailyPools.length) {
        let url = 'https://www.google.com/maps/dir/' + encodeURIComponent(OFFICE_ADDRESS);
        dailyPools.forEach(p => { url += '/' + encodeURIComponent(p.fullAddress); });
        url += '/' + encodeURIComponent(OFFICE_ADDRESS);

        routeGroupsForCalendar[slot.day][slot.opName] = { pools: dailyPools, mapsUrl: url };
        const prettyDay = slot.day.charAt(0) + slot.day.slice(1).toLowerCase();
        dailyPools.forEach(p => allRouteRows.push([
          prettyDay, slot.opName, p.pool_id, p.customerName,
          p.address, p.city, p.service, url, p.lat, p.lng
        ]));

        Logger.log(`RoutePlanner: ${slot.day} → ${slot.opName}: ${dailyPools.map(p => p.customerName).join(', ')}`);
      }
    }

    overflow.forEach(p => allRouteRows.push([
      'UNASSIGNED (Over Capacity)', 'UNASSIGNED',
      p.pool_id, p.customerName, p.address, p.city, p.service, '', p.lat, p.lng
    ]));

    Logger.log(`RoutePlanner: load summary — ${Object.entries(opTotalLoad).map(([k,v])=>`${k}: ${v}`).join(', ')}`);
  }

  // ── 7. Write Routes sheet ─────────────────────────────────────────────────
  const lastRow = routesSheet.getLastRow();
  if (lastRow > 1) routesSheet.getRange(2, 1, lastRow - 1, routesSheet.getLastColumn()).clearContent();
  if (allRouteRows.length) {
    routesSheet.getRange(2, 1, allRouteRows.length, 10).setValues(allRouteRows);
  }

  // Re-write Pinned = TRUE for pinned rows so the column survives the rewrite
  if (pinnedRows.length) {
    const headers = routesSheet.getRange(1, 1, 1, routesSheet.getLastColumn())
      .getValues()[0].map(h => String(h || '').trim().toLowerCase());
    let pinnedColIdx = headers.indexOf('pinned');
    if (pinnedColIdx === -1) {
      pinnedColIdx = headers.length;
      routesSheet.getRange(1, pinnedColIdx + 1).setValue('Pinned').setFontWeight('bold');
    }
    // Mark the first N rows (pinned rows were written first in allRouteRows)
    for (let i = 0; i < pinnedRows.length; i++) {
      routesSheet.getRange(i + 2, pinnedColIdx + 1).setValue('TRUE');
    }
  }

  routesSheet.autoResizeColumns(1, routesSheet.getLastColumn());

  // ── 8. Sync calendar ──────────────────────────────────────────────────────
  syncRoutesToCalendar_(routeGroupsForCalendar);

  Logger.log('RoutePlanner: done.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Calendar sync — weekly recurring + startup/monthly/one-time individual events
// ─────────────────────────────────────────────────────────────────────────────
function syncRoutesToCalendar_(routeGroups) {
  let cals = CalendarApp.getCalendarsByName(CALENDAR_NAME);
  let cal;
  if (cals.length > 0) {
    cal = cals[0];
  } else {
    cal = CalendarApp.createCalendar(CALENDAR_NAME, {
      summary: "Weekly Pool Service Routes for MCPS Operators",
      timeZone: "America/Chicago"
    });
    Logger.log("Created Calendar: " + CALENDAR_NAME);
  }

  // Wipe 60-day window
  const now = new Date(); now.setHours(0,0,0,0);
  const far = new Date(now.getTime() + 60*24*60*60*1000);
  const deletedSeriesIds = new Set();
  for (const e of cal.getEvents(now, far)) {
    try {
      if (e.isRecurringEvent()) {
        const s = e.getEventSeries();
        if (!deletedSeriesIds.has(s.getId())) { s.deleteEventSeries(); deletedSeriesIds.add(s.getId()); }
      } else { e.deleteEvent(); }
    } catch(err) { Logger.log("Wipe error: " + err); }
  }
  Utilities.sleep(1000);

  const dayMap = {
    MONDAY: CalendarApp.Weekday.MONDAY,
    TUESDAY: CalendarApp.Weekday.TUESDAY,
    WEDNESDAY: CalendarApp.Weekday.WEDNESDAY,
    THURSDAY: CalendarApp.Weekday.THURSDAY,
    FRIDAY: CalendarApp.Weekday.FRIDAY,
    SATURDAY: CalendarApp.Weekday.SATURDAY
  };

  const dayOrder = ["SUNDAY","MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY"];
  const curDayIdx = now.getDay();

  // ── A. Weekly recurring routes ────────────────────────────────────────────
  for (const day in routeGroups) {
    if (day.startsWith("_")) continue;
    const targetIdx = dayOrder.indexOf(day);
    if (targetIdx === -1) continue;
    let diff = targetIdx - curDayIdx; if (diff < 0) diff += 7;
    const eventDate  = new Date(now.getFullYear(), now.getMonth(), now.getDate()+diff);
    const recurrence = CalendarApp.newRecurrence().addWeeklyRule().onlyOnWeekday(dayMap[day]);

    for (const op in routeGroups[day]) {
      const rd = routeGroups[day][op];
      let desc = "🚐 *** MCPS WEEKLY ROUTE *** 🚐\n\nTap to Navigate:\n" + rd.mapsUrl + "\n\nStops:\n";
      rd.pools.forEach((p,i) => { desc += `${i+1}. ${p.customerName}\n   📍 ${p.address}, ${p.city}\n`; });
      try { cal.createAllDayEventSeries(`Route: ${op}`, eventDate, recurrence, {description: desc}); }
      catch(e) { Logger.log("Weekly event error: " + e); }
    }
  }

  // ── B. Helper: create one-off all-day events from a date-keyed group ──────
  function createOneOffEvents_(dateGroup, emoji, label) {
    for (const dateKey in dateGroup) {
      const dateObj = new Date(dateKey + "T12:00:00");
      const dayLabel = dateObj.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});
      for (const op in dateGroup[dateKey]) {
        const rd = dateGroup[dateKey][op];
        const pools = rd.pools;
        const title = `${label}: ${op} — ${dayLabel}${pools.length>1?` (${pools.length} pools)`:""}`;
        let desc = `${emoji} *** MCPS ${label.toUpperCase()} *** ${emoji}\n\nTap to Navigate:\n${rd.mapsUrl}\n\nPools:\n`;
        pools.forEach((p,i) => { desc += `${i+1}. ${p.customerName} — ${p.service}\n   📍 ${p.address}, ${p.city}\n`; });
        try { cal.createAllDayEvent(title, dateObj, {description: desc}); Logger.log(`Created: ${title}`); }
        catch(e) { Logger.log(`${label} event error for ${op} on ${dateKey}: ` + e); }
      }
    }
  }

  // ── C. Startup one-off events ─────────────────────────────────────────────
  createOneOffEvents_(routeGroups._startupDates || {}, "🏊", "Startup");

  // ── D. Monthly recurring events (first occurrence + monthly recurrence) ───
  for (const dateKey in (routeGroups._monthlyDates||{})) {
    const dateObj    = new Date(dateKey + "T12:00:00");
    const dayLabel   = dateObj.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});
    const recurrence = CalendarApp.newRecurrence().addMonthlyRule();
    for (const op in routeGroups._monthlyDates[dateKey]) {
      const rd    = routeGroups._monthlyDates[dateKey][op];
      const pools = rd.pools;
      const title = `Monthly: ${op} — ${pools[0].customerName}${pools.length>1?` +${pools.length-1} more`:""}`;
      let desc = `📅 *** MCPS MONTHLY SERVICE *** 📅\n\nTap to Navigate:\n${rd.mapsUrl}\n\nPools:\n`;
      pools.forEach((p,i) => { desc += `${i+1}. ${p.customerName}\n   📍 ${p.address}, ${p.city}\n`; });
      try { cal.createAllDayEventSeries(title, dateObj, recurrence, {description: desc}); Logger.log(`Created monthly: ${title}`); }
      catch(e) { Logger.log(`Monthly event error for ${op}: ` + e); }
    }
  }

  // ── E. One-time service events ────────────────────────────────────────────
  createOneOffEvents_(routeGroups._oneTimeDates || {}, "🔧", "One-Time Service");
}
