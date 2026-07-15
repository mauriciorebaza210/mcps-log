// RouteOrdering.gs
// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: orders each technician's daily stops by REAL driving distance/time so
// the route starts at the farthest pool and loops back toward the office.
//
//   Office:    OFFICE_ADDR (defined in RouteData.js — reused here, do NOT redeclare)
//   Distances: built-in Apps Script Maps service (Maps.newDirectionFinder) — no API
//              key, no billing. Every pair is cached forever in Route_Distance_Cache
//              (roads don't change), so steady-state cost is ~0 API calls.
//
// Entry point used by computeRouteData_():
//   orderDayPoolsByOperator_(pools, ctx)  — groups by operator, NN-orders each group.
//
// Cold-cache note: the first time a new set of stops is seen, this hits the Maps
// service (~120ms/pair). If you ever exceed the daily built-in-Maps quota, switch
// drivingMinutes_ to a paid Google Maps Platform key:
//   Maps.setAuthentication(clientOrApiKey, signature)  // see Apps Script Maps docs
// stored in Script Properties — no other code changes needed.
// ─────────────────────────────────────────────────────────────────────────────

const RD_DISTANCE_CACHE_SHEET = "Route_Distance_Cache";
const METERS_PER_MILE         = 1609.34;

// Build a full street address string for a pool/stop, matching buildMapsUrl_'s format.
function stopFullAddress_(p) {
  const addr = String((p && p.address) || "").trim();
  const city = String((p && p.city) || "").trim();
  if (!addr) return "";
  return city ? (addr + ", " + city + ", TX") : (addr + ", TX");
}

// ─── Persistent driving-distance cache ────────────────────────────────────────
// ctx = { sheet, cache: { "origin||dest": {miles, minutes} }, newRows: [] }
function buildDistanceContext_() {
  const ss = SpreadsheetApp.openById(RD_ROUTES_SS_ID);
  let sheet = ss.getSheetByName(RD_DISTANCE_CACHE_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(RD_DISTANCE_CACHE_SHEET);
    sheet.getRange(1, 1, 1, 4).setValues([["Origin", "Destination", "Miles", "Minutes"]]).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  const cache = {};
  const last = sheet.getLastRow();
  if (last > 1) {
    sheet.getRange(2, 1, last - 1, 4).getValues().forEach(r => {
      const key = String(r[0]).trim().toLowerCase() + "||" + String(r[1]).trim().toLowerCase();
      const miles = parseFloat(r[2]), minutes = parseFloat(r[3]);
      if (key !== "||" && !isNaN(minutes)) cache[key] = { miles: miles, minutes: minutes };
    });
  }
  return { sheet: sheet, cache: cache, newRows: [] };
}

function flushDistanceContext_(ctx) {
  if (ctx && ctx.newRows && ctx.newRows.length) {
    ctx.sheet.getRange(ctx.sheet.getLastRow() + 1, 1, ctx.newRows.length, 4).setValues(ctx.newRows);
    ctx.newRows = [];
  }
}

// Returns driving minutes between two addresses, or null if unresolvable.
// Cache-first; only calls the Maps service on a miss, then caches the result.
function drivingMinutes_(origin, dest, ctx) {
  if (!origin || !dest) return null;
  const o = String(origin).trim(), d = String(dest).trim();
  if (!o || !d) return null;
  if (o.toLowerCase() === d.toLowerCase()) return 0;

  const key = o.toLowerCase() + "||" + d.toLowerCase();
  if (ctx.cache[key]) return ctx.cache[key].minutes;

  try {
    const res = Maps.newDirectionFinder()
      .setOrigin(o)
      .setDestination(d)
      .setMode(Maps.DirectionFinder.Mode.DRIVING)
      .getDirections();
    if (res && res.routes && res.routes.length && res.routes[0].legs && res.routes[0].legs.length) {
      const leg = res.routes[0].legs[0];
      const miles = leg.distance.value / METERS_PER_MILE;
      const minutes = leg.duration.value / 60;
      ctx.cache[key] = { miles: miles, minutes: minutes };
      ctx.newRows.push([o, d, miles, minutes]);
      Utilities.sleep(120); // be gentle on the built-in Maps quota
      return minutes;
    }
  } catch (e) {
    Logger.log("drivingMinutes_ error: " + o + " -> " + d + " : " + e);
  }
  return null;
}

// ─── Nearest-neighbor ordering (route ends at the office) ─────────────────────
// Build a nearest-neighbor chain STARTING FROM THE OFFICE (office → closest →
// next closest → …), then REVERSE it. This guarantees the route starts at the
// far end and ends at the stop closest to the office — i.e. "drive out, work back
// toward home." Stops whose address can't be resolved sink to the end.
function orderStopsNearestNeighbor_(stops, ctx) {
  if (!stops || stops.length <= 1) return stops || [];

  const resolved = [], unresolved = [];
  stops.forEach(p => {
    const addr = stopFullAddress_(p);
    if (addr) resolved.push({ p: p, addr: addr });
    else unresolved.push({ p: p });
  });
  if (resolved.length <= 1) return stops;

  // Nearest-neighbor outward from the office.
  const remaining = resolved.slice();
  const chain = [];
  let curAddr = OFFICE_ADDR;
  while (remaining.length) {
    let bestIdx = 0, bestMin = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      let m = drivingMinutes_(curAddr, remaining[i].addr, ctx);
      if (m == null) m = Infinity;
      if (m < bestMin) { bestMin = m; bestIdx = i; }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    chain.push(next);
    curAddr = next.addr;
  }

  // chain[0] = closest to office, chain[last] = far end.
  // Reverse so the route starts far and ends at the closest-to-office stop.
  chain.reverse();

  const ordered = chain.map(n => n.p);
  unresolved.forEach(n => ordered.push(n.p));
  return ordered;
}

// Groups a day's pools by operator (each tech drives their own loop), orders each
// group, and flattens back out (operators in first-seen order). Filtering by
// operator downstream preserves each tech's chain.
function orderDayPoolsByOperator_(pools, ctx) {
  if (!pools || pools.length <= 1) return pools || [];

  const groups = {};
  const order = [];
  pools.forEach(p => {
    const op = String((p && p.operator) || "").trim() || "UNASSIGNED";
    if (!groups[op]) { groups[op] = []; order.push(op); }
    groups[op].push(p);
  });

  const out = [];
  order.forEach(op => {
    orderStopsNearestNeighbor_(groups[op], ctx).forEach(p => out.push(p));
  });
  return out;
}

// ─── Editor diagnostic: run this directly from the Apps Script editor ──────────
// Select `routeOrderingSelfTest` in the editor, click Run, then read the
// Execution log. Confirms the Maps driving-distance service works AND clears the
// server route cache so the next portal load recomputes the order.
function routeOrderingSelfTest() {
  const out = { mapsWorks: false, sampleMinutes: null, error: null };

  // 1. Does the built-in Maps DirectionFinder return a real driving time?
  try {
    const res = Maps.newDirectionFinder()
      .setOrigin(OFFICE_ADDR)
      .setDestination("24102 Shelton Spring, San Antonio, TX")
      .setMode(Maps.DirectionFinder.Mode.DRIVING)
      .getDirections();
    if (res && res.routes && res.routes.length && res.routes[0].legs && res.routes[0].legs.length) {
      out.mapsWorks = true;
      out.sampleMinutes = res.routes[0].legs[0].duration.value / 60;
    } else {
      out.error = "DirectionFinder returned no routes";
    }
  } catch (e) {
    out.error = String(e);
  }
  Logger.log("Maps DirectionFinder works: " + out.mapsWorks +
             " | sample office->Shelton Spring minutes: " + out.sampleMinutes +
             (out.error ? " | ERROR: " + out.error : ""));

  // 2. Clear the server route cache window so ordering recomputes on next load.
  try {
    const sc = CacheService.getScriptCache();
    const ws = getWeekStart_();
    const [wy, wm, wd] = ws.split("-").map(Number);
    const keys = [];
    for (let k = -1; k <= 6; k++) {
      const dt = new Date(wy, wm - 1, wd + k * 7);
      keys.push("rd:" + Utilities.formatDate(dt, RD_TZ, "yyyy-MM-dd"));
    }
    sc.removeAll(keys);
    Logger.log("Cleared " + keys.length + " rd: cache keys.");
  } catch (e) {
    Logger.log("Cache clear error: " + e);
  }

  return out;
}

// ─── Editor diagnostic: why is a given pool showing / not showing this week? ───
// Select `debugLopez` (or call debugPoolVisibility("name")) in the editor, Run,
// read the Execution log.
function debugLopez() { return debugPoolVisibility("lopez"); }

function debugPoolVisibility(search) {
  const q = String(search || "").trim().toLowerCase();
  const ws = getWeekStart_();
  const ss = SpreadsheetApp.openById(RD_ROUTES_SS_ID);
  const sheet = ss.getSheetByName("Routes");
  const data = sheet.getDataRange().getValues();
  const h = data[0].map(x => String(x).trim().toLowerCase().replace(/ /g, "_"));
  const col = n => h.indexOf(n);

  Logger.log("Week start (Monday): " + ws);
  let found = 0;
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const name = String(row[col("customer_name")] || "");
    if (q && name.toLowerCase().indexOf(q) === -1) continue;
    found++;

    const day = String(row[col("day_of_week")] || "").trim();
    const svc = String(row[col("service")] || "");
    const status = col("route_status") !== -1 ? String(row[col("route_status")] || "") : "(no col)";
    const mw = col("monthly_week") !== -1 ? String(row[col("monthly_week")] || "") : "(no col)";

    const visible = isPoolVisibleForWeek_(row, col, ws);
    let monthlyMatch = "n/a (not monthly)";
    if (svc.toLowerCase().includes("monthly")) {
      monthlyMatch = monthlyMatchesWeek_(day, mw, ws) + " (monthly_week='" + mw + "')";
    }

    Logger.log(
      "MATCH #" + found + ": " + name +
      "\n  day_of_week=" + day +
      "\n  service=" + svc +
      "\n  route_status=" + status +
      "\n  monthly_week=" + mw +
      "\n  isPoolVisibleForWeek_=" + visible +
      "\n  monthlyMatchesWeek_=" + monthlyMatch
    );
  }
  if (!found) Logger.log("No Routes rows matched '" + search + "'");
  return { week_start: ws, matches: found };
}

// ─── One-shot: set Lopez's monthly week to the 4th <weekday> ───────────────────
// Run once from the Apps Script editor.
function fixLopezMonthlyWeek() {
  const ss = SpreadsheetApp.openById(RD_ROUTES_SS_ID);
  const sheet = ss.getSheetByName("Routes");
  const data = sheet.getDataRange().getValues();
  const h = data[0].map(x => String(x).trim().toLowerCase().replace(/ /g, "_"));
  let mwCol = h.indexOf("monthly_week");
  if (mwCol === -1) {
    mwCol = h.length;
    sheet.getRange(1, mwCol + 1).setValue("monthly_week").setFontWeight("bold");
  }
  const nameCol = h.indexOf("customer_name");
  let done = 0;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][nameCol] || "").toLowerCase().indexOf("lopez") !== -1) {
      sheet.getRange(i + 1, mwCol + 1).setValue("4");
      done++;
    }
  }
  // Clear route cache so he reappears immediately.
  try {
    const sc = CacheService.getScriptCache();
    const ws = getWeekStart_();
    const [wy, wm, wd] = ws.split("-").map(Number);
    const keys = [];
    for (let k = -1; k <= 6; k++) {
      const dt = new Date(wy, wm - 1, wd + k * 7);
      keys.push("rd:" + Utilities.formatDate(dt, RD_TZ, "yyyy-MM-dd"));
    }
    sc.removeAll(keys);
    sc.remove("unassigned_pools");
  } catch (e) {}
  Logger.log("Set monthly_week='4' on " + done + " Lopez row(s). Reload the schedule.");
  return { updated: done };
}

// ─── Editor diagnostic: dump Monday's ordered route + test the visit addresses ──
function debugMondayRoute() {
  const ws = getWeekStart_();
  Logger.log("Week start: " + ws);

  // 1. Do the two first-month visit addresses resolve to a driving time?
  const ctx = buildDistanceContext_();
  ["27218 Bent Trail, Boerne, TX", "414 Persimmon Trail, San Antonio, TX"].forEach(a => {
    const m = drivingMinutes_(OFFICE_ADDR, a, ctx);
    Logger.log("office -> " + a + " = " + (m == null ? "NULL (did not resolve!)" : m.toFixed(1) + " min"));
  });
  flushDistanceContext_(ctx);

  // 2. What does the real read path produce for Monday (incl. scheduled visits)?
  const rd = computeRouteData_(ws);
  const mon = (rd.days || []).find(d => d.day === "Monday");
  if (!mon) { Logger.log("No Monday in computeRouteData_ output"); return; }
  Logger.log("Monday has " + mon.pools.length + " stops (in order):");
  mon.pools.forEach((p, i) => {
    Logger.log("  " + (i + 1) + ". " + p.customer_name +
      " | service=" + p.service +
      " | op=" + p.operator +
      " | scheduled_visit=" + (p._is_scheduled_visit ? p._visit_type : "no"));
  });
  return { stops: mon.pools.length };
}

// ─── Editor diagnostic: per-day office distances + final order ─────────────────
function debugWedRoute()  { return debugDayRoute("Wednesday"); }
function debugMonRoute()  { return debugDayRoute("Monday"); }

function debugDayRoute(dayName) {
  const ws = getWeekStart_();
  const rd = computeRouteData_(ws);
  const day = (rd.days || []).find(d => d.day === dayName);
  if (!day) { Logger.log("No " + dayName + " in output"); return; }

  const ctx = buildDistanceContext_();
  Logger.log(dayName + " — office driving time to each stop (resolved address):");
  day.pools.forEach((p, i) => {
    const addr = stopFullAddress_(p);
    const m = drivingMinutes_(OFFICE_ADDR, addr, ctx);
    Logger.log("  #" + (i + 1) + " " + p.customer_name +
      " | addr='" + addr + "'" +
      " | office=" + (m == null ? "NULL" : m.toFixed(1) + "min"));
  });
  flushDistanceContext_(ctx);
  return { day: dayName, stops: day.pools.length };
}

// ─── Admin: warm the distance cache for everything currently on the schedule ───
// Wired to action 'backfill_route_distances' in WebhookReceiver.doPost.
function backfillRouteDistances(token) {
  const auth = validateToken(token);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!hasRole(auth, "admin") && !hasRole(auth, "manager")) {
    return { ok: false, error: "Not authorized" };
  }

  const before = Object.keys(buildDistanceContext_().cache).length;

  // Warm the distance cache by running the real read computation for a window of
  // weeks. computeRouteData_ merges scheduled visits + orders by driving distance,
  // populating Route_Distance_Cache as a side effect — so the warm set always
  // matches exactly what the schedule needs.
  const ws = getWeekStart_();
  const [wy, wm, wd] = ws.split("-").map(Number);
  const rdKeys = [];
  for (let k = -1; k <= 6; k++) {
    const dt = new Date(wy, wm - 1, wd + k * 7);
    const wkStart = Utilities.formatDate(dt, RD_TZ, "yyyy-MM-dd");
    rdKeys.push("rd:" + wkStart);
    try { computeRouteData_(wkStart); } catch (e) { Logger.log("warm " + wkStart + " failed: " + e); }
  }

  const after = Object.keys(buildDistanceContext_().cache).length;

  // Clear the cached output window so reads recompute against the warm cache.
  try { CacheService.getScriptCache().removeAll(rdKeys); } catch (e) {}

  Logger.log("backfillRouteDistances: warmed " + (after - before) + " new address pairs.");
  return { ok: true, pairs_computed: after - before };
}
