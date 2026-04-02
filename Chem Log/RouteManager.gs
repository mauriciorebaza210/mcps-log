// RouteManager.gs
// Portal-driven route management: move pools, pin/unpin, auto-place new pools.
// All actions require admin or manager role.

const RM_ROUTES_SS_ID = "1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM";
const RM_CRM_SS_ID    = "1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E";

// ─── Move a pool to a different day/operator ─────────────────────────────────
function movePool(token, poolId, newDay, newOperator, pinned) {
  const auth = validateToken(token);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!hasRole(auth, "admin") && !hasRole(auth, "manager"))
    return { ok: false, error: "Not authorized" };

  // Validate target operator
  if (newOperator && String(newOperator).trim() !== "" && String(newOperator).trim().toUpperCase() !== "UNASSIGNED") {
    const allowedOperators = getAllowedRouteOperatorNames_();
    const normalizedTarget = String(newOperator).trim();

    if (allowedOperators.indexOf(normalizedTarget) === -1) {
      return { ok: false, error: 'Selected operator is not an active technician.' };
    }
  }
  
  const ss = SpreadsheetApp.openById(RM_ROUTES_SS_ID);
  const sheet = ss.getSheetByName("Routes");
  if (!sheet || sheet.getLastRow() < 2)
    return { ok: false, error: "Routes sheet is empty." };

  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim().toLowerCase().replace(/ /g, "_"));

  const dayCol  = headers.indexOf("day_of_week");
  const opCol   = headers.indexOf("operator");
  const pidCol  = headers.indexOf("pool_id");
  const pinnedColIdx = headers.indexOf("pinned");

  // Ensure Pinned column exists
  let pinnedCol = pinnedColIdx;
  if (pinnedCol === -1) {
    pinnedCol = headers.length;
    sheet.getRange(1, pinnedCol + 1).setValue("Pinned").setFontWeight("bold");
  }

  // Find the pool row
  let found = false;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][pidCol] || "").trim() === String(poolId).trim()) {
      // Update day, operator, and pinned status
      if (newDay) sheet.getRange(i + 1, dayCol + 1).setValue(newDay);
      if (newOperator) sheet.getRange(i + 1, opCol + 1).setValue(newOperator);
      sheet.getRange(i + 1, pinnedCol + 1).setValue(pinned === true || pinned === "true" ? "TRUE" : "FALSE");
      found = true;
      break;
    }
  }

  if (!found) {
    // Pool not in Routes sheet yet — add it (for place-new-pool scenario)
    const crm = SpreadsheetApp.openById(RM_CRM_SS_ID);
    const signed = crm.getSheetByName("Signed_Customers");
    if (!signed) return { ok: false, error: "Signed_Customers not found." };

    const crmData = signed.getDataRange().getValues();
    const cH = crmData[0].map(h => String(h).trim().toLowerCase());
    const crmRow = crmData.find((r, i) => i > 0 && String(r[cH.indexOf("pool_id")] || "").trim() === String(poolId).trim());
    if (!crmRow) return { ok: false, error: "Pool " + poolId + " not found in CRM." };

    const firstName = String(crmRow[cH.indexOf("first_name")] || "");
    const lastName  = String(crmRow[cH.indexOf("last_name")]  || "");
    const address   = String(crmRow[cH.indexOf("address")]    || "");
    const city      = String(crmRow[cH.indexOf("city")]       || "");
    const service   = String(crmRow[cH.indexOf("service")]    || "");

    const mapsUrl = "https://www.google.com/maps/search/?api=1&query=" +
      encodeURIComponent(address + ", " + city + ", TX");

    const newRow = [];
    newRow[dayCol]    = newDay || "Monday";
    newRow[opCol]     = newOperator || "UNASSIGNED";
    newRow[pidCol]    = poolId;
    newRow[headers.indexOf("customer_name")] = (firstName + " " + lastName).trim();
    newRow[headers.indexOf("address")]       = address;
    newRow[headers.indexOf("city")]          = city;
    newRow[headers.indexOf("service")]       = service;
    newRow[headers.indexOf("maps_link")]     = mapsUrl;
    newRow[headers.indexOf("lat")]           = 0;
    newRow[headers.indexOf("lng")]           = 0;
    newRow[pinnedCol] = "TRUE";

    // Pad to correct length
    while (newRow.length <= pinnedCol) newRow.push("");

    sheet.appendRow(newRow);
  }

  return { ok: true };
}

// ─── Toggle pin for a single pool ────────────────────────────────────────────
function togglePin(token, poolId, pinned) {
  const auth = validateToken(token);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!hasRole(auth, "admin") && !hasRole(auth, "manager"))
    return { ok: false, error: "Not authorized" };

  const ss = SpreadsheetApp.openById(RM_ROUTES_SS_ID);
  const sheet = ss.getSheetByName("Routes");
  if (!sheet) return { ok: false, error: "No Routes sheet." };

  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim().toLowerCase().replace(/ /g, "_"));
  const pidCol = headers.indexOf("pool_id");
  let pinnedCol = headers.indexOf("pinned");

  if (pinnedCol === -1) {
    pinnedCol = headers.length;
    sheet.getRange(1, pinnedCol + 1).setValue("Pinned").setFontWeight("bold");
  }

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][pidCol] || "").trim() === String(poolId).trim()) {
      sheet.getRange(i + 1, pinnedCol + 1).setValue(pinned ? "TRUE" : "FALSE");
      return { ok: true };
    }
  }
  return { ok: false, error: "Pool not found." };
}

// ─── Pin/unpin all pools on a day ────────────────────────────────────────────
function pinDay(token, day, pinned) {
  const auth = validateToken(token);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!hasRole(auth, "admin") && !hasRole(auth, "manager"))
    return { ok: false, error: "Not authorized" };

  const ss = SpreadsheetApp.openById(RM_ROUTES_SS_ID);
  const sheet = ss.getSheetByName("Routes");
  if (!sheet) return { ok: false, error: "No Routes sheet." };

  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim().toLowerCase().replace(/ /g, "_"));
  const dayCol = headers.indexOf("day_of_week");
  let pinnedCol = headers.indexOf("pinned");

  if (pinnedCol === -1) {
    pinnedCol = headers.length;
    sheet.getRange(1, pinnedCol + 1).setValue("Pinned").setFontWeight("bold");
  }

  const pinnedVal = pinned ? "TRUE" : "FALSE";
  let count = 0;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][dayCol] || "").trim().toLowerCase() === String(day).toLowerCase()) {
      sheet.getRange(i + 1, pinnedCol + 1).setValue(pinnedVal);
      count++;
    }
  }

  return { ok: true, updated: count };
}

// ─── Get unassigned pools (in CRM but not in Routes) ─────────────────────────
function getUnassignedPools(token) {
  const auth = validateToken(token);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!hasRole(auth, "admin") && !hasRole(auth, "manager"))
    return { ok: true, pools: [] };

  // Get all pool_ids from Routes
  const routesSs = SpreadsheetApp.openById(RM_ROUTES_SS_ID);
  const routesSheet = routesSs.getSheetByName("Routes");
  const assignedIds = new Set();
  if (routesSheet && routesSheet.getLastRow() > 1) {
    const rData = routesSheet.getDataRange().getValues();
    const rH = rData[0].map(h => String(h).trim().toLowerCase().replace(/ /g, "_"));
    const rPidCol = rH.indexOf("pool_id");
    for (let i = 1; i < rData.length; i++) {
      const pid = String(rData[i][rPidCol] || "").trim();
      if (pid) assignedIds.add(pid);
    }
  }

  // Get all active pools from CRM
  const crmSs = SpreadsheetApp.openById(RM_CRM_SS_ID);
  const signedSheet = crmSs.getSheetByName("Signed_Customers");
  if (!signedSheet || signedSheet.getLastRow() < 2)
    return { ok: true, pools: [] };

  const cData = signedSheet.getDataRange().getValues();
  const cH = cData[0].map(h => String(h).trim().toLowerCase());
  const pools = [];

  for (let i = 1; i < cData.length; i++) {
    const row = cData[i];
    const poolId = String(row[cH.indexOf("pool_id")] || "").trim();
    const status = String(row[cH.indexOf("status")] || "").trim().toUpperCase();
    const svcStatus = String(row[cH.indexOf("service_status")] || "").trim().toUpperCase();

    if (!poolId || status === "LOST" || svcStatus === "LOST") continue;
    if (assignedIds.has(poolId)) continue;

    // Check if it's a weekly/applicable service
    const service = String(row[cH.indexOf("service")] || "").trim();

    pools.push({
      pool_id: poolId,
      customer_name: (String(row[cH.indexOf("first_name")] || "") + " " + String(row[cH.indexOf("last_name")] || "")).trim(),
      address: String(row[cH.indexOf("address")] || ""),
      city: String(row[cH.indexOf("city")] || ""),
      service: service,
    });
  }

  return { ok: true, pools: pools };
}

function getEligibleRouteOperatorsForDay_(dayName) {
  const operators = getTechnicianOperators_(); // existing helper used by calculateRoutes()
  const dayKey = String(dayName || '').trim().toUpperCase();

  return operators.filter(op => {
    const name = String(op.name || '').trim();
    const days = Array.isArray(op.days) ? op.days : [];
    return name && days.indexOf(dayKey) !== -1;
  });
}

function getAllowedRouteOperatorNames_() {
  return getTechnicianOperators_()
    .map(op => String(op.name || '').trim())
    .filter(Boolean);
}
// ─── Recalculate — only place new (unassigned) pools ─────────────────────────
function recalculateNew(token) {
  const auth = validateToken(token);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!hasRole(auth, "admin") && !hasRole(auth, "manager")) {
    return { ok: false, error: "Not authorized" };
  }

  // Get unassigned pools
  const unassigned = getUnassignedPools(token);
  if (!unassigned.ok) return unassigned;
  if (!unassigned.pools.length) return { ok: true, placed: 0 };

  // Get current route loads by day and by day+operator
  const routesSs = SpreadsheetApp.openById(RM_ROUTES_SS_ID);
  const routesSheet = routesSs.getSheetByName("Routes");
  const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  const dayLoad = {};
  const opDayLoad = {};
  WEEKDAYS.forEach(d => { dayLoad[d] = 0; });

  if (routesSheet && routesSheet.getLastRow() > 1) {
    const rData = routesSheet.getDataRange().getValues();
    const rH = rData[0].map(h => String(h).trim().toLowerCase().replace(/ /g, "_"));
    const dayColIdx = rH.indexOf("day_of_week");
    const opColIdx  = rH.indexOf("operator");

    for (let i = 1; i < rData.length; i++) {
      const d  = String(rData[i][dayColIdx] || "").trim();
      const op = String(rData[i][opColIdx]  || "").trim();

      if (dayLoad[d] !== undefined) dayLoad[d]++;

      if (d && op) {
        const key = d + "||" + op;
        opDayLoad[key] = (opDayLoad[key] || 0) + 1;
      }
    }
  }

  let placed = 0;

  for (const pool of unassigned.pools) {
    // Find least-loaded day overall
    let minDay = WEEKDAYS[0];
    let minLoad = dayLoad[minDay];

    for (const d of WEEKDAYS) {
      if (dayLoad[d] < minLoad) {
        minDay = d;
        minLoad = dayLoad[d];
      }
    }

    // Find eligible technicians for that day
    const eligibleOps = getEligibleRouteOperatorsForDay_(minDay);

    // Choose least-loaded eligible operator for that day
    let chosenOp = "UNASSIGNED";
    if (eligibleOps.length) {
      eligibleOps.sort((a, b) => {
        const aName = String(a.name || "").trim();
        const bName = String(b.name || "").trim();
        const aLoad = opDayLoad[minDay + "||" + aName] || 0;
        const bLoad = opDayLoad[minDay + "||" + bName] || 0;
        return aLoad - bLoad;
      });

      chosenOp = String(eligibleOps[0].name || "UNASSIGNED").trim() || "UNASSIGNED";
    }

    // Place it
    const result = movePool(token, pool.pool_id, minDay, chosenOp, true);
    if (result.ok) {
      dayLoad[minDay]++;
      if (chosenOp && chosenOp !== "UNASSIGNED") {
        const key = minDay + "||" + chosenOp;
        opDayLoad[key] = (opDayLoad[key] || 0) + 1;
      }
      placed++;
    }
  }

  return { ok: true, placed: placed };
}
