// RouteData.gs
// ─────────────────────────────────────────────────────────────────────────────
// Serves structured weekly route data to the MCPS portal.
// Called from doGet with action=route_data&token=XXX
//
// Returns:
//   { ok, week_start, today, locked_days[], days: [ { day, date, locked, pools[], maps_url } ] }
//
// Lock rule: a day is locked if:
//   - It is today AND current time (America/Chicago) is at or past 6:00 AM
//   - OR it is a past day this week
//   calculateRoutes() checks this before writing — never overwrites a locked day.
// ─────────────────────────────────────────────────────────────────────────────

const RD_ROUTES_SS_ID  = "1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM";
const RD_CRM_SS_ID     = "1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E";
const RD_TZ            = "America/Chicago";
const ROUTE_LOCK_SHEET = "Route_Lock";
const LOCK_HOUR        = 6; // 6 AM locks the day

// ─── Main entry point ─────────────────────────────────────────────────────────
/**
 * Serves structured weekly route data.
 * Modified to pull operators dynamically from the Users table.
 */
function getRouteData(token, operatorFilter) {
  const auth = validateToken(token);
  if (!auth.ok) return { ok: false, error: auth.error };

  // 1. DYNAMIC OPERATOR LIST FROM USERS TABLE
  const authSs    = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const userSheet = authSs.getSheetByName(USERS_SHEET);
  const userData  = userSheet.getDataRange().getValues();
  const userH     = userData[0].map(h => String(h).trim().toLowerCase());
  
  const nameIdx = userH.indexOf("name");
  const roleIdx = userH.indexOf("roles");
  const actIdx  = userH.indexOf("active");

  // Get all active technicians
  const all_operators = userData.slice(1)
    .filter(row => {
      const roles  = String(row[roleIdx] || "").toLowerCase();
      const active = String(row[actIdx]  || "").toUpperCase() === "TRUE";
      return active && roles.indexOf("technician") !== -1;
    })
    .map(row => String(row[nameIdx] || "").trim())
    .filter(name => name !== "");

  if (all_operators.length === 0) all_operators.push("UNASSIGNED");

  // 2. FETCH ROUTES
  const ss      = SpreadsheetApp.openById(RD_ROUTES_SS_ID);
  const sheet   = ss.getSheetByName("Routes");
  const rdData  = sheet.getDataRange().getValues();
  if (rdData.length < 2) return { ok: true, days: [], all_operators };

  const headers = rdData[0].map(h => String(h).trim().toLowerCase().replace(/ /g,"_"));
  const col     = (name) => headers.indexOf(name);
  const weekStart = getWeekStart_();
  const WEEKDAYS  = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

  const results = {
    ok: true,
    week_start: weekStart,
    today: Utilities.formatDate(new Date(), RD_TZ, "yyyy-MM-dd"),
    all_operators,
    days: []
  };

  const dayPools = {};
  WEEKDAYS.forEach(d => dayPools[d] = []);

  for (let i = 1; i < rdData.length; i++) {
    const row = rdData[i];
    const day = String(row[col("day_of_week")] || "").trim();
    if (!dayPools[day]) continue;

    // FIX: Filtering logic
    const opRowVal = String(row[col("operator")] || "").trim();
    const matchesFilter = !operatorFilter || operatorFilter === 'all' || opRowVal.toLowerCase() === operatorFilter.toLowerCase();
    
    if (!matchesFilter) continue;

    dayPools[day].push({
      pool_id:       row[col("pool_id")],
      customer_name: row[col("customer_name")],
      address:       row[col("address")],
      city:          row[col("city")],
      service:       row[col("service")],
      maps_url:      row[col("maps_link")],
      lat:           row[col("lat")],
      lng:           row[col("lng")],
      operator:      opRowVal,
      pinned:        String(row[col("pinned")] || "").toUpperCase() === "TRUE"
    });
  }

  WEEKDAYS.forEach(dayName => {
    const pools = dayPools[dayName];
    results.days.push({
      day: dayName,
      date: getDayDate_(dayName, weekStart),
      pools,
      maps_url: buildMapsUrl_(pools)
    });
  });

  return results;
}



// ─── Lock helpers ──────────────────────────────────────────────────────────────
function getLockedDays_(routesSs) {
  const now      = new Date();
  const nowCT    = new Date(now.toLocaleString("en-US", { timeZone: RD_TZ }));
  const todayKey = getTodayKey_();
  const WEEKDAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const todayIdx = WEEKDAYS.indexOf(todayKey);

  // All past days this week are always locked
  const autoLocked = WEEKDAYS.slice(0, Math.max(0, todayIdx));

  // Today is locked if past 6 AM Central
  const isAfter6am = nowCT.getHours() >= LOCK_HOUR;
  if (isAfter6am && todayIdx !== -1) autoLocked.push(todayKey);

  // Also check Route_Lock sheet for manually locked days
  let sheet = routesSs.getSheetByName(ROUTE_LOCK_SHEET);
  if (!sheet) {
    sheet = routesSs.insertSheet(ROUTE_LOCK_SHEET);
    sheet.appendRow(["week_start", "day", "locked_at", "locked_by"]);
    sheet.setFrozenRows(1);
  }

  const weekStart = getWeekStart_();
  const manualLocked = new Set();
  if (sheet.getLastRow() > 1) {
    const data = sheet.getDataRange().getValues();
    data.slice(1).forEach(row => {
      if (String(row[0]) === weekStart) manualLocked.add(String(row[1]));
    });
  }

  return [...new Set([...autoLocked, ...manualLocked])];
}

// Called from calculateRoutes() before writing to check if a day is locked
function isDayLocked(day) {
  const routesSs = SpreadsheetApp.openById(RD_ROUTES_SS_ID);
  return getLockedDays_(routesSs).includes(day);
}

// ─── CRM notes loader ─────────────────────────────────────────────────────────
function loadCRMNotes_() {
  const map = {};
  try {
    const ss    = SpreadsheetApp.openById(RD_CRM_SS_ID);
    const sheet = ss.getSheetByName("Signed_Customers");
    if (!sheet || sheet.getLastRow() < 2) return map;

    const data    = sheet.getDataRange().getValues();
    const headers = data[0].map(h => String(h).trim().toLowerCase());
    const pidCol  = headers.indexOf("pool_id");
    const noteCol = headers.indexOf("notes");
    if (pidCol === -1) return map;

    data.slice(1).forEach(row => {
      const pid  = String(row[pidCol]  || "").trim();
      const note = noteCol !== -1 ? String(row[noteCol] || "").trim() : "";
      if (pid && note) map[pid] = note;
    });
  } catch(e) {
    Logger.log("loadCRMNotes_ error: " + e);
  }
  return map;
}

// ─── Maps URL builder ─────────────────────────────────────────────────────────
// Builds Google Maps optimized route: Office → stop1 → stop2 → ... → Office
// Falls back to individual pool maps_link if only one pool
const OFFICE_ADDR = "4640 S Flores Rd, Elmendorf, TX 78112";

function buildMapsUrl_(pools) {
  if (!pools.length) return "";
  if (pools.length === 1) {
    return "https://www.google.com/maps/dir/" +
      encodeURIComponent(OFFICE_ADDR) + "/" +
      encodeURIComponent(pools[0].address + ", " + pools[0].city + ", TX") + "/" +
      encodeURIComponent(OFFICE_ADDR);
  }

  // Multi-stop optimized route
  const waypoints = pools.map(p => encodeURIComponent(p.address + ", " + p.city + ", TX")).join("/");
  return "https://www.google.com/maps/dir/" +
    encodeURIComponent(OFFICE_ADDR) + "/" +
    waypoints + "/" +
    encodeURIComponent(OFFICE_ADDR);
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function getTodayKey_() {
  const now   = new Date();
  const nowCT = new Date(now.toLocaleString("en-US", { timeZone: RD_TZ }));
  const days  = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  return days[nowCT.getDay()];
}

function getWeekStart_() {
  const now   = new Date();
  const nowCT = new Date(now.toLocaleString("en-US", { timeZone: RD_TZ }));
  const day   = nowCT.getDay(); // 0=Sun
  const diff  = day === 0 ? -6 : 1 - day; // Monday
  const mon   = new Date(nowCT);
  mon.setDate(nowCT.getDate() + diff);
  return Utilities.formatDate(mon, RD_TZ, "yyyy-MM-dd");
}


function getDayDate_(dayName, weekStart) {
  const WEEKDAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const idx = WEEKDAYS.indexOf(dayName);
  if (idx === -1) return "";
  const ws = String(weekStart || "");
  if (!ws || ws.indexOf("-") === -1) return "";
  const [y, m, d] = ws.split("-").map(Number);
  const base = new Date(y, m - 1, d + idx);
  return Utilities.formatDate(base, RD_TZ, "yyyy-MM-dd");
}


// ─── Wire into doGet ──────────────────────────────────────────────────────────
// Add to WebhookReceiver.gs doGet():
//
//   if (e && e.parameter && e.parameter.action === 'route_data') {
//     const data = getRouteData(e.parameter.token || "", e.parameter.operator || "");
//     return ContentService.createTextOutput(JSON.stringify(data))
//       .setMimeType(ContentService.MimeType.JSON);
//   }

function TEST_routeData() {
  // Replace with a real token from your Sessions sheet to test
  const TEST_TOKEN = "PASTE_A_VALID_TOKEN_HERE";
  const result = getRouteData(TEST_TOKEN, "");
  Logger.log(JSON.stringify(result).slice(0, 4000));
  try { SpreadsheetApp.getActiveSpreadsheet().toast(result.ok ? "OK — " + result.days.length + " days" : "ERROR: " + result.error, "RouteData Test"); } catch(e) {}
}
