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
function getRouteData(token, operatorFilter, weekStartParam) {
  const auth = validateToken(token);
  if (!auth.ok) return { ok: false, error: auth.error };

  const weekStart = weekStartParam || getWeekStart_();

  // Cache full week (all operators) under one key — filter in memory on hit
  const cache    = CacheService.getScriptCache();
  const cacheKey = 'rd:' + weekStart;
  let full;
  const cachedStr = cache.get(cacheKey);
  if (cachedStr) {
    try { full = JSON.parse(cachedStr); } catch(e) {}
  }

  if (!full) {
    full = computeRouteData_(weekStart);
    try { cache.put(cacheKey, JSON.stringify(full), 300); } catch(e) {
      Logger.log('route cache put failed (payload too large?): ' + e);
    }
  }

  // Apply operator filter in memory — no extra sheet reads
  if (!operatorFilter || operatorFilter === 'all') return full;
  const f = operatorFilter.toLowerCase();
  return {
    ok:            full.ok,
    week_start:    full.week_start,
    today:         full.today,
    all_operators: full.all_operators,
    days: full.days.map(d => ({
      day:      d.day,
      date:     d.date,
      pools:    d.pools.filter(p => (p.operator || '').toLowerCase() === f),
      maps_url: buildMapsUrl_(d.pools.filter(p => (p.operator || '').toLowerCase() === f))
    }))
  };
}

function computeRouteData_(weekStart) {
  const WEEKDAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

  // 1. DYNAMIC OPERATOR LIST FROM USERS TABLE
  const authSs    = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const userSheet = authSs.getSheetByName(USERS_SHEET);
  const userData  = userSheet.getDataRange().getValues();
  const userH     = userData[0].map(h => String(h).trim().toLowerCase());

  const nameIdx = userH.indexOf("name");
  const roleIdx = userH.indexOf("roles");
  const actIdx  = userH.indexOf("active");

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
  const ss     = SpreadsheetApp.openById(RD_ROUTES_SS_ID);
  const sheet  = ss.getSheetByName("Routes");
  const rdData = sheet.getDataRange().getValues();
  if (rdData.length < 2) return { ok: true, week_start: weekStart, today: Utilities.formatDate(new Date(), RD_TZ, "yyyy-MM-dd"), all_operators, days: [] };

  const headers = rdData[0].map(h => String(h).trim().toLowerCase().replace(/ /g,"_"));
  const col     = (name) => headers.indexOf(name);

  const dayPools = {};
  WEEKDAYS.forEach(d => dayPools[d] = []);

  const weeklyOverrides = getWeeklyOverrides_(weekStart);

  for (let i = 1; i < rdData.length; i++) {
    const row = rdData[i];
    const day = String(row[col("day_of_week")] || "").trim();
    if (!dayPools[day]) continue;
    if (!isPoolVisibleForWeek_(row, col, weekStart)) continue;

    const opRowVal    = String(row[col("operator")] || "").trim();
    const poolId      = String(row[col("pool_id")]   || "").trim();
    const weekOverride = weeklyOverrides[poolId] || {};
    const effectiveDay = (weekOverride.day && dayPools[weekOverride.day]) ? weekOverride.day : day;
    const effectiveOperator = weekOverride.operator || opRowVal;

    // Monthly Full Service pools recur on a single weekday-of-the-month
    // (1st/2nd/3rd/4th/last <weekday>). Skip weeks that don't match the pattern.
    const svcVal = String(row[col("service")] || "");
    if (svcVal.toLowerCase().includes("monthly")) {
      const mwIdx = col("monthly_week");
      const monthlyWeek = mwIdx !== -1 ? row[mwIdx] : "";
      if (!monthlyMatchesWeek_(effectiveDay, monthlyWeek, weekStart)) continue;
    }

    const sdRaw = col("startup_start_date") !== -1 ? row[col("startup_start_date")] : "";
    dayPools[effectiveDay].push({
      pool_id:            poolId,
      customer_name:      row[col("customer_name")],
      address:            row[col("address")],
      city:               row[col("city")],
      service:            row[col("service")],
      maps_url:           row[col("maps_link")],
      lat:                row[col("lat")],
      lng:                row[col("lng")],
      operator:           effectiveOperator,
      pinned:             String(row[col("pinned")] || "").toUpperCase() === "TRUE",
      monthly_week:       col("monthly_week") !== -1 ? String(row[col("monthly_week")] || "").trim() : "",
      week_override:      effectiveDay !== day,
      gate_code:          col("gate_code") !== -1 ? String(row[col("gate_code")] || "").trim() : "",
      startup_start_date: sdRaw instanceof Date
        ? Utilities.formatDate(sdRaw, RD_TZ, "yyyy-MM-dd")
        : String(sdRaw || "").trim()
    });
  }

  const days = WEEKDAYS.map(dayName => {
    const pools = dayPools[dayName];
    return { day: dayName, date: getDayDate_(dayName, weekStart), pools, maps_url: buildMapsUrl_(pools) };
  });

  return { ok: true, week_start: weekStart, today: Utilities.formatDate(new Date(), RD_TZ, "yyyy-MM-dd"), all_operators, days };
}

// ─── Startup & status filtering ───────────────────────────────────────────────

// Returns the Monday (yyyy-MM-dd) for any given date value
function getWeekStartForDate_(dateVal) {
  try {
    const d = dateVal instanceof Date ? dateVal : new Date(String(dateVal));
    if (isNaN(d.getTime())) return "";
    const ct = new Date(d.toLocaleString("en-US", { timeZone: RD_TZ }));
    const day = ct.getDay();
    const mon = new Date(ct.getFullYear(), ct.getMonth(), ct.getDate() - (day === 0 ? 6 : day - 1));
    return Utilities.formatDate(mon, RD_TZ, "yyyy-MM-dd");
  } catch(e) { return ""; }
}

// Returns false if a Routes row should be excluded for the requested week
function isPoolVisibleForWeek_(row, col, weekStart) {
  // route_status: "inactive" or "startup_complete" → always hidden
  const statusIdx = col("route_status");
  if (statusIdx !== -1) {
    const st = String(row[statusIdx] || "").trim().toLowerCase();
    if (st === "inactive" || st === "startup_complete") return false;
  }
  // Startup pools: only visible during their own week
  const svcIdx = col("service");
  if (svcIdx !== -1 && String(row[svcIdx] || "").toLowerCase().includes("startup")) {
    const sdIdx = col("startup_start_date");
    if (sdIdx !== -1 && row[sdIdx]) {
      const startupWeek = getWeekStartForDate_(row[sdIdx]);
      if (startupWeek && startupWeek !== weekStart) return false;
    }
  }
  // Weekly pools converted from startup: only show from service_start_date week onward
  const ssdIdx = col("service_start_date");
  if (ssdIdx !== -1 && row[ssdIdx]) {
    const serviceStartWeek = getWeekStartForDate_(row[ssdIdx]);
    if (serviceStartWeek && weekStart < serviceStartWeek) return false;
  }
  return true;
}

// ─── Weekly Overrides (move-this-week-only) ───────────────────────────────────

function ensureWeeklyOverridesSheet_(ss) {
  let sheet = ss.getSheetByName("Weekly_Overrides");
  if (!sheet) {
    sheet = ss.insertSheet("Weekly_Overrides");
    sheet.appendRow(["week_start", "pool_id", "override_day", "override_operator", "created_at"]);
    sheet.setFrozenRows(1);
  }
  const wanted = ["week_start", "pool_id", "override_day", "override_operator", "created_at"];
  const headers = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0]
    .map(h => String(h || "").trim().toLowerCase().replace(/ /g, "_"));
  wanted.forEach(name => {
    if (headers.indexOf(name) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(name);
      headers.push(name);
    }
  });
  return sheet;
}

function getWeeklyOverrides_(weekStart) {
  try {
    const ss = SpreadsheetApp.openById(RD_ROUTES_SS_ID);
    const sheet = ensureWeeklyOverridesSheet_(ss);
    if (sheet.getLastRow() < 2) return {};
    const data = sheet.getDataRange().getValues();
    const h = data[0].map(x => String(x || "").trim().toLowerCase().replace(/ /g, "_"));
    const wsCol = h.indexOf("week_start");
    const pidCol = h.indexOf("pool_id");
    const dayCol = h.indexOf("override_day");
    const opCol = h.indexOf("override_operator");
    const overrides = {};
    data.slice(1).forEach(row => {
      const wsRaw = wsCol !== -1 ? row[wsCol] : row[0];
      const ws = wsRaw instanceof Date
        ? Utilities.formatDate(wsRaw, RD_TZ, "yyyy-MM-dd")
        : String(wsRaw || "").trim();
      if (ws === weekStart) {
        const pid = String(pidCol !== -1 ? row[pidCol] : row[1] || "").trim();
        if (pid) {
          overrides[pid] = {
            day: String(dayCol !== -1 ? row[dayCol] : row[2] || "").trim(),
            operator: String(opCol !== -1 ? row[opCol] : "").trim()
          };
        }
      }
    });
    return overrides;
  } catch(e) { Logger.log("getWeeklyOverrides_ error: " + e); return {}; }
}

function movePoolThisWeek(token, poolId, newDay, weekStart, newOperator) {
  const auth = validateToken(token);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return { ok: false, error: 'Not authorized' };
  if (!weekStart) return { ok: false, error: 'week_start required' };

  const ss = SpreadsheetApp.openById(RD_ROUTES_SS_ID);
  const sheet = ensureWeeklyOverridesSheet_(ss);

  // Upsert: remove existing override for this pool+week, then insert
  if (sheet.getLastRow() > 1) {
    const data = sheet.getDataRange().getValues();
    const h = data[0].map(x => String(x || "").trim().toLowerCase().replace(/ /g, "_"));
    const wsCol = h.indexOf("week_start");
    const pidCol = h.indexOf("pool_id");
    for (let i = data.length - 1; i >= 1; i--) {
      const wsRaw = wsCol !== -1 ? data[i][wsCol] : data[i][0];
      const ws = wsRaw instanceof Date
        ? Utilities.formatDate(wsRaw, RD_TZ, "yyyy-MM-dd")
        : String(wsRaw || "").trim();
      const pid = String(pidCol !== -1 ? data[i][pidCol] : data[i][1] || "").trim();
      if (ws === weekStart && pid === poolId) {
        sheet.deleteRow(i + 1);
      }
    }
  }
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(x => String(x || "").trim().toLowerCase().replace(/ /g, "_"));
  const row = new Array(headers.length).fill("");
  const set = (name, value) => { const idx = headers.indexOf(name); if (idx !== -1) row[idx] = value; };
  set("week_start", weekStart);
  set("pool_id", poolId);
  set("override_day", newDay);
  set("override_operator", newOperator || "");
  set("created_at", new Date().toISOString());
  sheet.appendRow(row);

  // Also write a dated Scheduled_Visits row as an audit/dispatch record for the
  // temporary change. The weekly override above remains the display source.
  try {
    upsertWeeklyOverrideScheduledVisit_(ss, poolId, newDay, weekStart, newOperator, auth);
  } catch (svErr) {
    Logger.log("movePoolThisWeek scheduled visit sync failed: " + svErr);
  }

  // Bust the route data cache for this week so the next fetch sees the move
  try { CacheService.getScriptCache().remove('rd:' + weekStart); } catch(e) {}
  return { ok: true };
}

function upsertWeeklyOverrideScheduledVisit_(ss, poolId, newDay, weekStart, newOperator, auth) {
  const targetDate = getDayDate_(newDay, weekStart);
  if (!targetDate) return;

  const routeInfo = getRouteInfoByPoolId_(ss, poolId);
  const serviceType = routeInfo.service || "Weekly Full Service";
  const assignedTech = String(newOperator || routeInfo.operator || "").trim();
  const noteKey = "weekly_override:" + weekStart;
  const now = new Date().toISOString();
  const sheet = ensureScheduledVisitsSheet_();
  const data = sheet.getDataRange().getValues();
  const h = data[0].map(x => String(x || "").trim().toLowerCase().replace(/ /g, "_"));
  const col = name => h.indexOf(name);

  for (let i = 1; i < data.length; i++) {
    const pid = String(col("pool_id") !== -1 ? data[i][col("pool_id")] : "").trim();
    const vt = String(col("visit_type") !== -1 ? data[i][col("visit_type")] : "").trim();
    const notes = String(col("notes") !== -1 ? data[i][col("notes")] : "").trim();
    const st = String(col("status") !== -1 ? data[i][col("status")] : "").trim().toLowerCase();
    if (pid === String(poolId).trim() && vt === "weekly_override" && notes.indexOf(noteKey) !== -1 && st !== "cancelled") {
      if (col("scheduled_date") !== -1) sheet.getRange(i + 1, col("scheduled_date") + 1).setValue(targetDate);
      if (col("assigned_technician") !== -1) sheet.getRange(i + 1, col("assigned_technician") + 1).setValue(assignedTech);
      if (col("service_type") !== -1) sheet.getRange(i + 1, col("service_type") + 1).setValue(serviceType);
      if (col("customer_name") !== -1) sheet.getRange(i + 1, col("customer_name") + 1).setValue(routeInfo.customer_name || "");
      if (col("notes") !== -1) sheet.getRange(i + 1, col("notes") + 1).setValue(noteKey + " moved_to:" + newDay + " updated_at:" + now);
      return;
    }
  }

  createScheduledVisit_({
    pool_id: poolId,
    customer_name: routeInfo.customer_name || "",
    service_type: serviceType,
    visit_type: "weekly_override",
    scheduled_date: targetDate,
    assigned_technician: assignedTech,
    status: "scheduled",
    notes: noteKey + " moved_to:" + newDay,
    created_by: auth && auth.user && auth.user.username ? auth.user.username : ""
  });
}

function getRouteInfoByPoolId_(ss, poolId) {
  const routeSheet = ss.getSheetByName("Routes");
  if (!routeSheet || routeSheet.getLastRow() < 2) return {};
  const data = routeSheet.getDataRange().getValues();
  const h = data[0].map(x => String(x || "").trim().toLowerCase().replace(/ /g, "_"));
  const col = name => h.indexOf(name);
  for (let i = 1; i < data.length; i++) {
    if (String(col("pool_id") !== -1 ? data[i][col("pool_id")] : "").trim() === String(poolId).trim()) {
      return {
        customer_name: String(col("customer_name") !== -1 ? data[i][col("customer_name")] : ""),
        address: String(col("address") !== -1 ? data[i][col("address")] : ""),
        city: String(col("city") !== -1 ? data[i][col("city")] : ""),
        service: String(col("service") !== -1 ? data[i][col("service")] : ""),
        operator: String(col("operator") !== -1 ? data[i][col("operator")] : "")
      };
    }
  }
  return {};
}

// ─── Routes sheet column helpers ─────────────────────────────────────────────

// Ensures a column exists in the Routes sheet; returns its 0-based index
function ensureRoutesCol_(sheet, colName) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => String(h || "").trim().toLowerCase().replace(/ /g, "_"));
  let idx = headers.indexOf(colName);
  if (idx === -1) {
    idx = sheet.getLastColumn(); // will be appended at next position
    sheet.getRange(1, idx + 1).setValue(colName);
  }
  return idx;
}

function setStartupDate_(poolId, startupStartDate) {
  try {
    const ss = SpreadsheetApp.openById(RD_ROUTES_SS_ID);
    const sheet = ss.getSheetByName("Routes");
    if (!sheet || sheet.getLastRow() < 2) return false;
    const sdCol  = ensureRoutesCol_(sheet, "startup_start_date") + 1; // 1-indexed
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(h => String(h || "").trim().toLowerCase().replace(/ /g, "_"));
    const pidCol = headers.indexOf("pool_id") + 1;
    if (pidCol === 0) return false;
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][pidCol - 1] || "").trim() === String(poolId).trim()) {
        sheet.getRange(i + 1, sdCol).setValue(startupStartDate || "");
        return true;
      }
    }
    return false;
  } catch(e) { Logger.log("setStartupDate_ error: " + e); return false; }
}

function saveGateCode_(poolId, gateCode) {
  try {
    const ss = SpreadsheetApp.openById(RD_ROUTES_SS_ID);
    const sheet = ss.getSheetByName("Routes");
    if (!sheet || sheet.getLastRow() < 2) return false;
    const gcCol  = ensureRoutesCol_(sheet, "gate_code") + 1;
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(h => String(h || "").trim().toLowerCase().replace(/ /g, "_"));
    const pidCol = headers.indexOf("pool_id") + 1;
    if (pidCol === 0) return false;
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][pidCol - 1] || "").trim() === String(poolId).trim()) {
        sheet.getRange(i + 1, gcCol).setValue(gateCode || "");
        return true;
      }
    }
    return false;
  } catch(e) { Logger.log("saveGateCode_ error: " + e); return false; }
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function addDaysToDate_(dateStr, days) {
  const parts = String(dateStr || "").split("-").map(Number);
  if (parts.length !== 3 || isNaN(parts[0])) return "";
  const result = new Date(parts[0], parts[1] - 1, parts[2] + days);
  return Utilities.formatDate(result, RD_TZ, "yyyy-MM-dd");
}

// ─── Reschedule startup days ──────────────────────────────────────────────────
//
// Updates the scheduled_date of any status=scheduled startup_day_1/2/3
// Scheduled_Visits rows for the pool, and syncs startup_start_date in Routes.
function rescheduleStartupVisits(token, poolId, day1Date) {
  const auth = validateToken(token);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return { ok: false, error: 'Not authorized' };
  if (!poolId)   return { ok: false, error: 'pool_id required' };
  if (!day1Date) return { ok: false, error: 'day_1_date required' };
  try {
    const day1 = String(day1Date).trim();
    const day2 = addDaysToDate_(day1, 1);
    const day3 = addDaysToDate_(day1, 2);
    const newDates = { startup_day_1: day1, startup_day_2: day2, startup_day_3: day3 };

    const ss = SpreadsheetApp.openById(RD_ROUTES_SS_ID);

    // Update scheduled_date on startup_day_1/2/3 Scheduled_Visits rows
    const svSheet = ss.getSheetByName('Scheduled_Visits');
    if (svSheet && svSheet.getLastRow() >= 2) {
      const data = svSheet.getDataRange().getValues();
      const h = data[0].map(col => String(col || '').trim().toLowerCase().replace(/ /g, '_'));
      const pidCol  = h.indexOf('pool_id');
      const vtCol   = h.indexOf('visit_type');
      const sdCol   = h.indexOf('scheduled_date');
      const statCol = h.indexOf('status');
      if (pidCol !== -1 && vtCol !== -1 && sdCol !== -1) {
        for (let i = 1; i < data.length; i++) {
          const pid  = String(data[i][pidCol]  || '').trim();
          const vt   = String(data[i][vtCol]   || '').trim();
          const stat = statCol !== -1 ? String(data[i][statCol] || '').trim().toLowerCase() : 'scheduled';
          if (pid === String(poolId).trim() && newDates[vt] && stat === 'scheduled') {
            svSheet.getRange(i + 1, sdCol + 1).setValue(newDates[vt]);
          }
        }
      }
    }

    // Sync startup_start_date in Routes
    setStartupDate_(poolId, day1);

    // Sync day_of_week in Routes to match the day of week of day1
    const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const d1 = new Date(day1 + 'T12:00:00');
    const dayName = DAY_NAMES[d1.getDay()];
    if (dayName && dayName !== 'Sunday') {
      const routeSheet = ss.getSheetByName('Routes');
      if (routeSheet && routeSheet.getLastRow() > 1) {
        const rData = routeSheet.getDataRange().getValues();
        const rH = rData[0].map(col => String(col || '').trim().toLowerCase().replace(/ /g, '_'));
        const rPid = rH.indexOf('pool_id'), rDay = rH.indexOf('day_of_week');
        for (let i = 1; i < rData.length; i++) {
          if (rPid !== -1 && String(rData[i][rPid] || '').trim() === String(poolId).trim()) {
            if (rDay !== -1) routeSheet.getRange(i + 1, rDay + 1).setValue(dayName);
            break;
          }
        }
      }
    }

    // Bust route cache for the new week
    try { CacheService.getScriptCache().remove('rd:' + getWeekStartForDate_(day1)); } catch(e) {}

    Logger.log('rescheduleStartupVisits: ' + poolId + ' → ' + day1 + '/' + day2 + '/' + day3);
    return { ok: true, day_1: day1, day_2: day2, day_3: day3 };
  } catch(e) {
    Logger.log('rescheduleStartupVisits error: ' + e);
    return { ok: false, error: String(e) };
  }
}

// ─── Mark Startup as Pending (unscheduled, waiting to be placed) ─────────────
//
// Sets day_of_week=UNSCHEDULED and clears startup_start_date in Routes.
// Cancels any status=scheduled startup_day_* visits in Scheduled_Visits
// so the pool surfaces in the unassigned banner.
function markStartupPending(token, poolId) {
  const auth = validateToken(token);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return { ok: false, error: 'Not authorized' };
  if (!poolId) return { ok: false, error: 'pool_id required' };
  try {
    const ss = SpreadsheetApp.openById(RD_ROUTES_SS_ID);

    // Cancel scheduled startup_day_* visits
    const svSheet = ss.getSheetByName('Scheduled_Visits');
    if (svSheet && svSheet.getLastRow() >= 2) {
      const data = svSheet.getDataRange().getValues();
      const h = data[0].map(c => String(c || '').trim().toLowerCase().replace(/ /g, '_'));
      const pidCol  = h.indexOf('pool_id');
      const vtCol   = h.indexOf('visit_type');
      const statCol = h.indexOf('status');
      if (pidCol !== -1 && vtCol !== -1 && statCol !== -1) {
        for (let i = 1; i < data.length; i++) {
          const pid  = String(data[i][pidCol]  || '').trim();
          const vt   = String(data[i][vtCol]   || '').trim();
          const stat = String(data[i][statCol] || '').trim().toLowerCase();
          if (pid === String(poolId).trim() && vt.startsWith('startup_day_') && stat === 'scheduled') {
            svSheet.getRange(i + 1, statCol + 1).setValue('cancelled');
          }
        }
      }
    }

    // Set day_of_week=UNSCHEDULED and clear startup_start_date in Routes
    const routeSheet = ss.getSheetByName('Routes');
    if (routeSheet && routeSheet.getLastRow() > 1) {
      const rData = routeSheet.getDataRange().getValues();
      const rH = rData[0].map(c => String(c || '').trim().toLowerCase().replace(/ /g, '_'));
      const rPid = rH.indexOf('pool_id');
      const rDay = rH.indexOf('day_of_week');
      const rSd  = rH.indexOf('startup_start_date');
      for (let i = 1; i < rData.length; i++) {
        if (rPid !== -1 && String(rData[i][rPid] || '').trim() === String(poolId).trim()) {
          if (rDay !== -1) routeSheet.getRange(i + 1, rDay + 1).setValue('UNSCHEDULED');
          if (rSd  !== -1) routeSheet.getRange(i + 1, rSd  + 1).setValue('');
          break;
        }
      }
    }

    // Bust caches
    const cache = CacheService.getScriptCache();
    cache.remove('unassigned_pools');
    // Bust this week and surrounding weeks' route caches
    const today = new Date();
    for (let w = -1; w <= 1; w++) {
      try {
        const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + w * 7);
        cache.remove('rd:' + Utilities.formatDate(d, RD_TZ, 'yyyy-MM-dd'));
      } catch(e) {}
    }

    Logger.log('markStartupPending: ' + poolId + ' → UNSCHEDULED, visits cancelled');
    return { ok: true };
  } catch(e) {
    Logger.log('markStartupPending error: ' + e);
    return { ok: false, error: String(e) };
  }
}

// ─── Schedule First Month Visits (4 weekly one-time Scheduled_Visits) ────────
//
// Creates first_month_week_1 through _4 rows in Scheduled_Visits starting on
// week1Monday (the Monday of the first service week after startup ends).
// dayOfWeek specifies which day within each week the visit falls.
function scheduleFirstMonthVisits(token, poolId, week1Monday, dayOfWeek, assignedTechnician) {
  const auth = validateToken(token);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!hasRole(auth, "admin") && !hasRole(auth, "manager")) return { ok: false, error: "Not authorized" };
  if (!poolId)      return { ok: false, error: "pool_id required" };
  if (!week1Monday) return { ok: false, error: "week_1_monday required" };
  if (!dayOfWeek)   return { ok: false, error: "day_of_week required" };

  try {
    // Get customer name from Routes sheet
    const ss = SpreadsheetApp.openById(RD_ROUTES_SS_ID);
    const routeSheet = ss.getSheetByName("Routes");
    let customerName = "";
    if (routeSheet && routeSheet.getLastRow() > 1) {
      const rData = routeSheet.getDataRange().getValues();
      const rH = rData[0].map(h => String(h || "").trim().toLowerCase().replace(/ /g, "_"));
      const rPid = rH.indexOf("pool_id"), rName = rH.indexOf("customer_name");
      for (let i = 1; i < rData.length; i++) {
        if (rPid !== -1 && String(rData[i][rPid] || "").trim() === String(poolId).trim()) {
          customerName = rName !== -1 ? String(rData[i][rName] || "").trim() : "";
          break;
        }
      }
    }

    // Compute one date per week for 4 weeks
    const visits = [1, 2, 3, 4].map(function(n) {
      const weekMonday = addDaysToDate_(week1Monday, (n - 1) * 7);
      return { visit_type: "first_month_week_" + n, scheduled_date: getDayDate_(dayOfWeek, weekMonday) };
    });

    const tech    = String(assignedTechnician || "").trim();
    const creator = auth.user && auth.user.username ? auth.user.username : "unknown";

    for (const v of visits) {
      if (!v.scheduled_date) {
        Logger.log("scheduleFirstMonthVisits: could not compute date for " + v.visit_type);
        continue;
      }
      createScheduledVisit_({
        pool_id:             poolId,
        customer_name:       customerName,
        service_type:        "Weekly Full Service",
        visit_type:          v.visit_type,
        scheduled_date:      v.scheduled_date,
        assigned_technician: tech,
        status:              "scheduled",
        notes:               "First month sponsored visit",
        created_by:          creator
      });
    }

    Logger.log("scheduleFirstMonthVisits: " + poolId + " → 4 visits from " + (visits[0].scheduled_date || "?"));
    return { ok: true, visits: visits };
  } catch(e) {
    Logger.log("scheduleFirstMonthVisits error: " + e);
    return { ok: false, error: String(e) };
  }
}

// ─── Convert startup → Weekly Full Service (recurring route) ─────────────────
//
// newDay:          the ongoing weekly service day (e.g. "Thursday")
// serviceStartDate: yyyy-MM-dd when recurring appears on the route.
//                   Pass a future date (week 5) when first month visits are
//                   being scheduled separately; omit/empty to start immediately.
function convertStartupToWeekly(token, poolId, newDay, serviceStartDate) {
  const auth = validateToken(token);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return { ok: false, error: 'Not authorized' };
  try {
    const ss = SpreadsheetApp.openById(RD_ROUTES_SS_ID);
    const sheet = ss.getSheetByName("Routes");
    if (!sheet || sheet.getLastRow() < 2) return { ok: false, error: 'Routes sheet not found' };

    const svcCol    = ensureRoutesCol_(sheet, "service") + 1;
    const sdCol     = ensureRoutesCol_(sheet, "startup_start_date") + 1;
    const ssdCol    = ensureRoutesCol_(sheet, "service_start_date") + 1;
    const statusCol = ensureRoutesCol_(sheet, "route_status") + 1;
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(h => String(h || "").trim().toLowerCase().replace(/ /g, "_"));
    const pidCol = headers.indexOf("pool_id") + 1;
    const dayCol = headers.indexOf("day_of_week") + 1;
    if (pidCol === 0) return { ok: false, error: 'pool_id column not found' };

    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][pidCol - 1] || "").trim() === String(poolId).trim()) {
        const startupDate = data[i][sdCol - 1];
        // Use caller-supplied serviceStartDate if provided, else fall back to
        // the startup_start_date (so the pool appears from that week onward).
        const resolvedStart = serviceStartDate && String(serviceStartDate).trim()
          ? String(serviceStartDate).trim()
          : (startupDate
              ? (startupDate instanceof Date
                  ? Utilities.formatDate(startupDate, RD_TZ, "yyyy-MM-dd")
                  : String(startupDate).trim())
              : Utilities.formatDate(new Date(), RD_TZ, "yyyy-MM-dd"));

        sheet.getRange(i + 1, svcCol).setValue("Weekly Full Service");
        sheet.getRange(i + 1, sdCol).setValue("");
        sheet.getRange(i + 1, ssdCol).setValue(resolvedStart);
        sheet.getRange(i + 1, statusCol).setValue("active");
        if (newDay && dayCol > 0) sheet.getRange(i + 1, dayCol).setValue(newDay);

        Logger.log("convertStartupToWeekly: " + poolId + " → WFS, day=" + (newDay || "unchanged") + ", start=" + resolvedStart);

        try {
          const histSheet = ss.getSheetByName("Service_History") || ss.insertSheet("Service_History");
          if (histSheet.getLastRow() === 0) {
            histSheet.appendRow(["pool_id","from_service","to_service","transition_type","transitioned_at","startup_start_date","service_start_date","day_of_week","transitioned_by"]);
          }
          histSheet.appendRow([
            poolId, "Startup", "Weekly Full Service", "startup_to_recurring", new Date(),
            startupDate || "", resolvedStart, newDay || data[i][dayCol - 1],
            auth.user && auth.user.username ? auth.user.username : "unknown"
          ]);
        } catch(histErr) { Logger.log("Service_History append failed: " + histErr); }

        return { ok: true, new_day: newDay || data[i][dayCol - 1], service_start: resolvedStart };
      }
    }
    // Pool not in Routes — create the row from Quotes data and convert in one step.
    // This handles startup pools saved before the Routes-row creation was wired up.
    try {
      const crmSs     = SpreadsheetApp.openById(RD_CRM_SS_ID);
      const crmSheet  = crmSs.getSheetByName("Quotes");
      if (!crmSheet) return { ok: false, error: 'Pool ' + poolId + ' not found in Routes and Quotes sheet unavailable' };
      const crmData    = crmSheet.getDataRange().getValues();
      const crmHeaders = crmData[0].map(h => String(h || '').trim().toLowerCase().replace(/ /g, '_'));
      const crmPidCol  = crmHeaders.indexOf('pool_id');
      let quoteRow = null;
      for (let j = 1; j < crmData.length; j++) {
        if (crmPidCol !== -1 && String(crmData[j][crmPidCol] || '').trim() === String(poolId).trim()) {
          quoteRow = crmData[j];
          break;
        }
      }
      if (!quoteRow) return { ok: false, error: 'Pool ' + poolId + ' not found in Routes or Quotes' };

      const crmGet = (col) => {
        const i = crmHeaders.indexOf(col);
        return i !== -1 ? String(quoteRow[i] || '').trim() : '';
      };
      const firstName = crmGet('first_name');
      const lastName  = crmGet('last_name');
      const address   = crmGet('address');
      const city      = crmGet('city');
      const customerName = [firstName, lastName].filter(Boolean).join(' ').trim();
      const mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' +
        encodeURIComponent(address + (city ? ', ' + city : '') + ', TX');

      // Build a new Routes row matching existing header positions
      const newRow = new Array(headers.length).fill('');
      const setCol = (colName, val) => {
        const i = headers.indexOf(colName);
        if (i !== -1) newRow[i] = val;
      };
      const startupDate = crmGet('startup_start_date');
      const serviceStart = startupDate || Utilities.formatDate(new Date(), RD_TZ, 'yyyy-MM-dd');
      setCol('pool_id',           poolId);
      setCol('customer_name',     customerName);
      setCol('address',           address);
      setCol('city',              city);
      setCol('service',           'Weekly Full Service');
      setCol('route_status',      'active');
      setCol('day_of_week',       newDay || 'UNSCHEDULED');
      setCol('operator',          'UNASSIGNED');
      setCol('maps_link',         mapsUrl);
      const resolvedStart = serviceStartDate && String(serviceStartDate).trim()
        ? String(serviceStartDate).trim() : serviceStart;
      if (ssdCol > 0) newRow[ssdCol - 1] = resolvedStart;
      sheet.appendRow(newRow);

      try {
        const histSheet = ss.getSheetByName('Service_History') || ss.insertSheet('Service_History');
        if (histSheet.getLastRow() === 0) {
          histSheet.appendRow(['pool_id','from_service','to_service','transition_type','transitioned_at','startup_start_date','service_start_date','day_of_week','transitioned_by']);
        }
        histSheet.appendRow([
          poolId, 'Startup', 'Weekly Full Service', 'startup_to_recurring_self_heal', new Date(),
          startupDate || '', resolvedStart, newDay || 'UNSCHEDULED',
          auth.user && auth.user.username ? auth.user.username : 'unknown'
        ]);
      } catch(histErr) { Logger.log('convertStartupToWeekly self-heal history failed: ' + histErr); }

      Logger.log('convertStartupToWeekly: self-healed missing Routes row for ' + poolId + ', day=' + (newDay || 'UNSCHEDULED'));
      return { ok: true, new_day: newDay || 'UNSCHEDULED', service_start: resolvedStart };
    } catch(healErr) {
      return { ok: false, error: 'Pool ' + poolId + ' not found in Routes (self-heal failed: ' + healErr + ')' };
    }
  } catch(e) { Logger.log("convertStartupToWeekly error: " + e); return { ok: false, error: String(e) }; }
}

// ─── Dismiss first-month alert (clears first_month_start for the pool) ────────
function dismissFirstMonth(token, poolId) {
  const auth = validateToken(token);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return { ok: false, error: 'Not authorized' };
  try {
    const ss = SpreadsheetApp.openById(RD_ROUTES_SS_ID);
    const sheet = ss.getSheetByName("Routes");
    if (!sheet || sheet.getLastRow() < 2) return { ok: false, error: 'Routes sheet not found' };
    const fmCol = ensureRoutesCol_(sheet, "first_month_start") + 1;
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(h => String(h || "").trim().toLowerCase().replace(/ /g, "_"));
    const pidCol = headers.indexOf("pool_id") + 1;
    if (pidCol === 0) return { ok: false, error: 'pool_id column not found' };
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][pidCol - 1] || "").trim() === String(poolId).trim()) {
        sheet.getRange(i + 1, fmCol).setValue("");
        return { ok: true };
      }
    }
    return { ok: false, error: 'Pool not found' };
  } catch(e) { return { ok: false, error: String(e) }; }
}

// ─── Mark startup complete (remove from schedule without converting) ──────────

function markStartupComplete(token, poolId) {
  const auth = validateToken(token);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return { ok: false, error: 'Not authorized' };
  try {
    const ss = SpreadsheetApp.openById(RD_ROUTES_SS_ID);
    const sheet = ss.getSheetByName("Routes");
    if (!sheet || sheet.getLastRow() < 2) return { ok: false, error: 'Routes sheet not found' };

    const statusCol = ensureRoutesCol_(sheet, "route_status") + 1;
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(h => String(h || "").trim().toLowerCase().replace(/ /g, "_"));
    const pidCol = headers.indexOf("pool_id") + 1;
    if (pidCol === 0) return { ok: false, error: 'pool_id column not found' };

    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][pidCol - 1] || "").trim() === String(poolId).trim()) {
        sheet.getRange(i + 1, statusCol).setValue("startup_complete");
        return { ok: true };
      }
    }
    return { ok: false, error: 'Pool not found in Routes' };
  } catch(e) { return { ok: false, error: String(e) }; }
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

// ─── Monthly recurrence (nth weekday of month) ────────────────────────────────
// Returns true if the given weekday, in the requested week, is the configured
// occurrence of that weekday within its month.
//   monthlyWeek: "1" | "2" | "3" | "4" | "last"  (blank → "1", first occurrence)
function monthlyMatchesWeek_(dayOfWeek, monthlyWeek, weekStart) {
  const iso = getDayDate_(dayOfWeek, weekStart);
  if (!iso) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);

  // Which occurrence of this weekday within the month (1-5)
  const occurrence = Math.ceil(date.getDate() / 7);
  // Is this the last such weekday? (next week's same weekday falls in a new month)
  const next = new Date(y, m - 1, d + 7);
  const isLast = next.getMonth() !== date.getMonth();

  const want = String(monthlyWeek || "").trim().toLowerCase();
  if (want === "last" || want === "5" || want === "l") return isLast;
  if (want === "1" || want === "2" || want === "3" || want === "4") {
    return occurrence === Number(want);
  }
  // Blank / unrecognized → default to first occurrence
  return occurrence === 1;
}


// ─── Scheduled Visits for Week ────────────────────────────────────────────────
function getScheduledVisitsForWeek(token, weekStartParam, operatorFilter) {
  const auth = validateToken(token);
  if (!auth.ok) return { ok: false, error: auth.error };

  const weekStart = weekStartParam || getWeekStart_();

  // Compute Saturday (weekStart + 5 days)
  const [wy, wm, wd] = weekStart.split('-').map(Number);
  const weekEnd = Utilities.formatDate(
    new Date(wy, wm - 1, wd + 5), RD_TZ, 'yyyy-MM-dd'
  );

  try {
    const ss = SpreadsheetApp.openById(RD_ROUTES_SS_ID);
    const svSheet = ss.getSheetByName('Scheduled_Visits');
    if (!svSheet || svSheet.getLastRow() < 2) return { ok: true, visits: [] };

    // Build address lookup from Routes sheet
    const addrMap = {};
    const routeSheet = ss.getSheetByName('Routes');
    if (routeSheet && routeSheet.getLastRow() > 1) {
      const rData = routeSheet.getDataRange().getValues();
      const rH = rData[0].map(h => String(h).trim().toLowerCase().replace(/ /g, '_'));
      const rPid = rH.indexOf('pool_id'), rAddr = rH.indexOf('address'), rCity = rH.indexOf('city'), rGc = rH.indexOf('gate_code'), rCn = rH.indexOf('customer_name');
      for (let i = 1; i < rData.length; i++) {
        const pid = String(rData[i][rPid] || '').trim();
        if (pid) addrMap[pid] = {
          address:       rAddr !== -1 ? String(rData[i][rAddr] || '') : '',
          city:          rCity !== -1 ? String(rData[i][rCity] || '') : '',
          gate_code:     rGc   !== -1 ? String(rData[i][rGc]   || '') : '',
          customer_name: rCn   !== -1 ? String(rData[i][rCn]   || '') : ''
        };
      }
    }
    // Startup visits do not need a recurring Routes row, so fill missing address
    // context from Quotes by pool_id.
    try {
      const crmSs = SpreadsheetApp.openById(RD_CRM_SS_ID);
      const quotes = crmSs.getSheetByName('Quotes');
      if (quotes && quotes.getLastRow() > 1) {
        const qData = quotes.getDataRange().getValues();
        const qH = qData[0].map(h => String(h).trim().toLowerCase().replace(/ /g, '_'));
        const qPid = qH.indexOf('pool_id'), qAddr = qH.indexOf('address'), qCity = qH.indexOf('city'), qCn = qH.indexOf('customer_name');
        for (let i = 1; i < qData.length; i++) {
          const pid = String(qPid !== -1 ? qData[i][qPid] : '').trim();
          if (pid && !addrMap[pid]) {
            addrMap[pid] = {
              address:       qAddr !== -1 ? String(qData[i][qAddr] || '') : '',
              city:          qCity !== -1 ? String(qData[i][qCity] || '') : '',
              customer_name: qCn   !== -1 ? String(qData[i][qCn]   || '') : ''
            };
          }
        }
      }
    } catch (addrErr) {
      Logger.log('getScheduledVisitsForWeek Quotes address lookup failed: ' + addrErr);
    }

    const svData = svSheet.getDataRange().getValues();
    const svH = svData[0].map(h => String(h).trim().toLowerCase().replace(/ /g, '_'));
    const col = name => svH.indexOf(name);

    const visits = [];
    for (let i = 1; i < svData.length; i++) {
      const row = svData[i];
      const status = String(row[col('status')] || '').trim().toLowerCase();
      if (status !== 'scheduled') continue;

      let schedDate = row[col('scheduled_date')];
      if (schedDate instanceof Date) {
        schedDate = Utilities.formatDate(schedDate, RD_TZ, 'yyyy-MM-dd');
      } else {
        schedDate = String(schedDate || '').trim();
      }
      if (!schedDate || schedDate < weekStart || schedDate > weekEnd) continue;

      const assignedTech = String(row[col('assigned_technician')] || '').trim();
      if (operatorFilter && operatorFilter !== 'all') {
        if (assignedTech.toLowerCase() !== operatorFilter.toLowerCase()) continue;
      }

      const poolId = String(row[col('pool_id')] || '').trim();
      const addr = addrMap[poolId] || { address: '', city: '' };
      const svCustName = String(row[col('customer_name')] || '').trim();

      visits.push({
        scheduled_visit_id: String(row[col('scheduled_visit_id')] || ''),
        pool_id:             poolId,
        customer_name:       svCustName || addr.customer_name || '',
        service_type:        String(row[col('service_type')]        || ''),
        visit_type:          String(row[col('visit_type')]          || ''),
        scheduled_date:      schedDate,
        assigned_technician: assignedTech,
        status:              status,
        notes:               String(row[col('notes')]               || ''),
        address:             addr.address,
        city:                addr.city,
        gate_code:           addr.gate_code || ''
      });
    }

    return { ok: true, visits: visits };
  } catch (err) {
    Logger.log('getScheduledVisitsForWeek error: ' + err);
    return { ok: false, error: String(err) };
  }
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

// ─── CALENDAR BACKEND (MONTH VIEW) ────────────────────────────────────────────
function getCalendarData(token, month, year, operatorFilter) {
  const auth = validateToken(token);
  if (!auth.ok) return { ok: false, error: auth.error };

  const authSs    = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const userSheet = authSs.getSheetByName(USERS_SHEET);
  const userData  = userSheet.getDataRange().getValues();
  const userH     = userData[0].map(h => String(h).trim().toLowerCase());
  
  const nameIdx = userH.indexOf("name");
  const roleIdx = userH.indexOf("roles");
  const actIdx  = userH.indexOf("active");

  let isAdmin = false;
  let callerRoles = "";
  if(auth.role) {
     callerRoles = auth.role;
     if(callerRoles.includes("admin") || callerRoles.includes("manager")) isAdmin = true;
  }

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

  // Fetch Recurring Routes
  const ss      = SpreadsheetApp.openById(RD_ROUTES_SS_ID);
  const sheet   = ss.getSheetByName("Routes");
  const rdData  = sheet.getDataRange().getValues();
  let weekliesTemplate = { 'Monday':[], 'Tuesday':[], 'Wednesday':[], 'Thursday':[], 'Friday':[], 'Saturday':[], 'Sunday':[] };

  if (rdData.length > 1) {
    const headers = rdData[0].map(h => String(h).trim().toLowerCase().replace(/ /g,"_"));
    const col     = (name) => headers.indexOf(name);
    
    for (let i = 1; i < rdData.length; i++) {
        const row = rdData[i];
        const day = String(row[col("day_of_week")] || "").trim();
        if (!weekliesTemplate[day]) continue;

        const opRowVal = String(row[col("operator")] || "").trim();
        const matchesFilter = !operatorFilter || operatorFilter === 'all' || opRowVal.toLowerCase() === operatorFilter.toLowerCase();
        if (!matchesFilter) continue;

        weekliesTemplate[day].push({
        pool_id:       row[col("pool_id")],
        customer_name: row[col("customer_name")],
        address:       row[col("address")],
        city:          row[col("city")],
        service:       row[col("service")],
        maps_url:      row[col("maps_link")],
        lat:           row[col("lat")],
        lng:           row[col("lng")],
        operator:      opRowVal,
        pinned:        String(row[col("pinned")] || "").toUpperCase() === "TRUE",
        type:          "Weekly"
        });
    }
  }

  // Fetch AdHoc Services (Admins only)
  let adHocEvents = [];
  if (isAdmin) {
    let adhocSheet = ss.getSheetByName("AdHoc_Services");
    if (!adhocSheet) {
      adhocSheet = ss.insertSheet("AdHoc_Services");
      adhocSheet.appendRow(["Event_ID", "Date_Scheduled", "Type", "Customer_Name", "Location_Address", "Assigned_Operator", "Notes", "Status"]);
      adhocSheet.setFrozenRows(1);
    } else {
      const adhocData = adhocSheet.getDataRange().getValues();
      if (adhocData.length > 1) {
        const headers = adhocData[0].map(h => String(h).trim().toLowerCase().replace(/ /g,"_"));
        const idCol = headers.indexOf("event_id");
        const dateCol = headers.indexOf("date_scheduled");
        const typeCol = headers.indexOf("type");
        const cnameCol = headers.indexOf("customer_name");
        const addrCol = headers.indexOf("location_address");
        const opCol = headers.indexOf("assigned_operator");
        const noteCol = headers.indexOf("notes");
        const statusCol = headers.indexOf("status");
        
        for (let i = 1; i < adhocData.length; i++) {
          const row = adhocData[i];
          const dObj = new Date(row[dateCol]);
          if (isNaN(dObj.getTime())) continue; // bad date
          
          const evMonth = dObj.getMonth() + 1;
          const evYear = dObj.getFullYear();
          if (evMonth != month || evYear != year) continue; // NOT IN THIS MONTH
          
          const opRowVal = String(opCol >=0 ? row[opCol] : "").trim();
          const matchesFilter = !operatorFilter || operatorFilter === 'all' || opRowVal.toLowerCase() === operatorFilter.toLowerCase();
          if (!matchesFilter) continue;
          
          adHocEvents.push({
            event_id: idCol >=0 ? row[idCol] : "",
            dateStr: Utilities.formatDate(dObj, RD_TZ, "yyyy-MM-dd"),
            type: typeCol >=0 ? row[typeCol] : "Event",
            customer_name: cnameCol >=0 ? row[cnameCol] : "",
            address: addrCol >=0 ? row[addrCol] : "",
            operator: opRowVal,
            notes: noteCol >=0 ? row[noteCol] : "",
            status: statusCol >=0 ? row[statusCol] : ""
          });
        }
      }
    }
  }

  // Build Calendar Array
  // get weeks spanning this month.
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  
  // shift first day to sunday (0) to match the HTML header columns
  const startDay = firstDay.getDay(); // 0 is Sunday
  const calStart = new Date(year, month - 1, 1 - startDay);
  
  const endDay = lastDay.getDay();
  // Fill the last row until Saturday (6)
  const calEnd = new Date(year, month - 1, lastDay.getDate() + (6 - endDay));
  
  const daysArray = [];
  let current = new Date(calStart);
  
  const weekdayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

  while(current <= calEnd) {
      const dStr = Utilities.formatDate(current, RD_TZ, "yyyy-MM-dd");
      const dMonth = current.getMonth() + 1;
      const wDay = weekdayNames[current.getDay()];
      
      const dayWeeklies = weekliesTemplate[wDay] || [];
      const dayAdHocs = adHocEvents.filter(e => e.dateStr === dStr);
      
      daysArray.push({
         date: dStr,
         dayNum: current.getDate(),
         isCurrentMonth: (dMonth === month),
         weeklies: dayWeeklies,
         adhocs: dayAdHocs
      });
      
      current.setDate(current.getDate() + 1);
  }

  return {
    ok: true,
    all_operators,
    month,
    year,
    days: daysArray
  };
}

function addAdHocEvent(token, evt) {
  const auth = validateToken(token);
  if (!auth.ok) return { ok: false, error: auth.error };

  // Must be admin to add (or manager)
  let isAdmin = false;
  if(auth.role && (auth.role.includes("admin") || auth.role.includes("manager"))) isAdmin = true;
  
  if(!isAdmin) return { ok:false, error: "Only admins/managers can create one-time events." };

  const ss = SpreadsheetApp.openById(RD_ROUTES_SS_ID);
  let adhocSheet = ss.getSheetByName("AdHoc_Services");
  if (!adhocSheet) {
      adhocSheet = ss.insertSheet("AdHoc_Services");
      adhocSheet.appendRow(["Event_ID", "Date_Scheduled", "Type", "Customer_Name", "Location_Address", "Assigned_Operator", "Notes", "Status"]);
      adhocSheet.setFrozenRows(1);
  }

  const id = Utilities.getUuid();
  const dateStr = evt.date || "";
  const typeStr = evt.type || "Event";
  const custName = evt.customer_name || "";
  const addr = evt.address || "";
  const op = evt.operator || "";
  const notes = evt.notes || "";
  const status = "Scheduled";

  adhocSheet.appendRow([id, dateStr, typeStr, custName, addr, op, notes, status]);

  return { ok: true, message: "Event added" };
}
