// UsageSnapshot.gs
// Creates an immutable priced "snapshot" for each form submission.
// Keeps Chemical_Usage_Log raw, and writes computed totals into Usage_Priced.

const RAW_SHEET = "Chemical_Usage_Log";
const PRICED_SHEET = "Usage_Priced";
const COSTS_SHEET = "Chem_Costs";

// Chem_Costs columns (A:E): Name | Unit | ... | ... | Cost per Unit
const COST_NAME_COL = 1; // A
const COST_PER_UNIT_COL = 5; // E

function AUDIT_poolIdReconciliation() {
  const CRM_SS_ID = "1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E"; // CRM workbook
  const CHEM_SS_ID = SpreadsheetApp.getActiveSpreadsheet().getId();       // Chem workbook

  const CRM_SIGNED_SHEET = "Signed_Customers";
  const USAGE_PRICED_SHEET = "Usage_Priced";
  const CHEM_COST_PER_POOL_SHEET = "Chem_Cost_per_Pool";
  const CHEM_DETAIL_SHEET = "Chemical_Cost_Detail";

  const crmSs = SpreadsheetApp.openById(CRM_SS_ID);
  const chemSs = SpreadsheetApp.openById(CHEM_SS_ID);

  const signed = crmSs.getSheetByName(CRM_SIGNED_SHEET);
  const priced = chemSs.getSheetByName(USAGE_PRICED_SHEET);
  const roll = chemSs.getSheetByName(CHEM_COST_PER_POOL_SHEET);
  const detail = chemSs.getSheetByName(CHEM_DETAIL_SHEET);

  if (!signed) throw new Error("Missing Signed_Customers");
  if (!priced) throw new Error("Missing Usage_Priced");
  if (!roll) throw new Error("Missing Chem_Cost_per_Pool");
  if (!detail) throw new Error("Missing Chemical_Cost_Detail");

  const getRows = (sheet) => sheet.getDataRange().getValues();
  const getMap = (headers) => {
    const m = {};
    headers.forEach((h, i) => m[String(h || "").trim()] = i);
    return m;
  };
  const norm = (v) => String(v || "").trim();
  const normText = (v) => String(v || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");

  // Signed_Customers lookup
  const signedData = getRows(signed);
  const sh = signedData[0].map(h => String(h || "").trim());
  const sm = getMap(sh);

  const signedByPool = {};
  for (let i = 1; i < signedData.length; i++) {
    const row = signedData[i];
    const pid = norm(row[sm["pool_id"]]);
    if (!pid) continue;

    signedByPool[pid] = {
      rowNum: i + 1,
      pool_id: pid,
      first_name: norm(row[sm["first_name"]]),
      last_name: norm(row[sm["last_name"]]),
      address: norm(row[sm["address"]]),
      service: norm(row[sm["service"]]),
      city: norm(row[sm["city"]]),
      email: norm(row[sm["email"]])
    };
  }

  // Usage_Priced audit
  const pricedData = getRows(priced);
  const ph = pricedData[0].map(h => String(h || "").trim());
  const pm = getMap(ph);

  Logger.log("=== USAGE_PRICED POOL IDs NOT IN SIGNED_CUSTOMERS ===");
  for (let i = 1; i < pricedData.length; i++) {
    const row = pricedData[i];
    const pid = norm(row[pm["pool_id"]]);
    if (!pid) continue;
    if (!signedByPool[pid]) {
      Logger.log(JSON.stringify({
        row: i + 1,
        pool_id: pid,
        timestamp: pm["Timestamp"] != null ? row[pm["Timestamp"]] : "",
        raw_pool_field: pm["pool_id"] != null ? row[pm["pool_id"]] : ""
      }));
    }
  }

  // Chem_Cost_per_Pool audit
  const rollData = getRows(roll);
  const rh = rollData[0].map(h => String(h || "").trim());
  const rm = getMap(rh);

  Logger.log("=== CHEM_COST_PER_POOL MISMATCHES VS SIGNED_CUSTOMERS ===");
  for (let i = 1; i < rollData.length; i++) {
    const row = rollData[i];
    const pid = norm(row[rm["pool_id"]]);
    if (!pid) continue;

    const signedMeta = signedByPool[pid];
    if (!signedMeta) {
      Logger.log(JSON.stringify({
        row: i + 1,
        issue: "pool_id not in Signed_Customers",
        pool_id: pid,
        client_name: rm["Client Name"] != null ? row[rm["Client Name"]] : "",
        address: rm["Address"] != null ? row[rm["Address"]] : "",
        service_type: rm["Service Type"] != null ? row[rm["Service Type"]] : ""
      }));
      continue;
    }

    const rollClient = norm(row[rm["Client Name"]]);
    const rollAddress = norm(row[rm["Address"]]);
    const rollService = norm(row[rm["Service Type"]]);

    const signedClient = `${signedMeta.first_name} ${signedMeta.last_name}`.trim();
    const clientOk =
      !rollClient ||
      normText(rollClient).includes(normText(signedMeta.last_name)) ||
      normText(rollClient) === normText(signedClient);

    const addressOk = !rollAddress || normText(rollAddress) === normText(signedMeta.address);
    const serviceOk = !rollService || normText(rollService) === normText(signedMeta.service);

    if (!clientOk || !addressOk || !serviceOk) {
      Logger.log(JSON.stringify({
        row: i + 1,
        pool_id: pid,
        roll_client: rollClient,
        signed_client: signedClient,
        roll_address: rollAddress,
        signed_address: signedMeta.address,
        roll_service: rollService,
        signed_service: signedMeta.service
      }));
    }
  }

  // Chemical_Cost_Detail audit
  const detailData = getRows(detail);
  const dh = detailData[0].map(h => String(h || "").trim());
  const dm = getMap(dh);

  Logger.log("=== CHEMICAL_COST_DETAIL MISMATCHES VS SIGNED_CUSTOMERS ===");
  for (let i = 1; i < detailData.length; i++) {
    const row = detailData[i];
    const pid = norm(row[dm["pool_id"]]);
    if (!pid) continue;

    const signedMeta = signedByPool[pid];
    if (!signedMeta) {
      Logger.log(JSON.stringify({
        row: i + 1,
        issue: "pool_id not in Signed_Customers",
        pool_id: pid,
        client_name: dm["Client Name"] != null ? row[dm["Client Name"]] : "",
        address: dm["Address"] != null ? row[dm["Address"]] : "",
        service_type: dm["Service Type"] != null ? row[dm["Service Type"]] : ""
      }));
      continue;
    }

    const detailClient = norm(row[dm["Client Name"]]);
    const detailAddress = norm(row[dm["Address"]]);
    const detailService = norm(row[dm["Service Type"]]);

    const signedClient = `${signedMeta.first_name} ${signedMeta.last_name}`.trim();
    const clientOk =
      !detailClient ||
      normText(detailClient).includes(normText(signedMeta.last_name)) ||
      normText(detailClient) === normText(signedClient);

    const addressOk = !detailAddress || normText(detailAddress) === normText(signedMeta.address);
    const serviceOk = !detailService || normText(detailService) === normText(signedMeta.service);

    if (!clientOk || !addressOk || !serviceOk) {
      Logger.log(JSON.stringify({
        row: i + 1,
        pool_id: pid,
        detail_client: detailClient,
        signed_client: signedClient,
        detail_address: detailAddress,
        signed_address: signedMeta.address,
        detail_service: detailService,
        signed_service: signedMeta.service,
        chemical: dm["Chemical"] != null ? row[dm["Chemical"]] : "",
        timestamp: dm["Timestamp"] != null ? row[dm["Timestamp"]] : ""
      }));
    }
  }

  Logger.log("=== TARGETED CHECK: MCPS-0018 ===");
  const target = "MCPS-0018";

  Logger.log("Signed_Customers:");
  Logger.log(JSON.stringify(signedByPool[target] || { missing: true }));

  Logger.log("Chem_Cost_per_Pool rows:");
  for (let i = 1; i < rollData.length; i++) {
    const row = rollData[i];
    const pid = norm(row[rm["pool_id"]]);
    if (pid === target) {
      Logger.log(JSON.stringify({
        row: i + 1,
        pool_id: pid,
        client_name: rm["Client Name"] != null ? row[rm["Client Name"]] : "",
        address: rm["Address"] != null ? row[rm["Address"]] : "",
        service_type: rm["Service Type"] != null ? row[rm["Service Type"]] : ""
      }));
    }
  }

  Logger.log("Usage_Priced rows:");
  for (let i = 1; i < pricedData.length; i++) {
    const row = pricedData[i];
    const pid = norm(row[pm["pool_id"]]);
    if (pid === target) {
      Logger.log(JSON.stringify({
        row: i + 1,
        timestamp: pm["Timestamp"] != null ? row[pm["Timestamp"]] : "",
        total_cost: pm["Total Visit Chem Cost (Snapshot)"] != null ? row[pm["Total Visit Chem Cost (Snapshot)"]] : "",
        week_key: pm["WeekKey"] != null ? row[pm["WeekKey"]] : ""
      }));
    }
  }

  Logger.log("Chemical_Cost_Detail rows:");
  for (let i = 1; i < detailData.length; i++) {
    const row = detailData[i];
    const pid = norm(row[dm["pool_id"]]);
    if (pid === target) {
      Logger.log(JSON.stringify({
        row: i + 1,
        timestamp: dm["Timestamp"] != null ? row[dm["Timestamp"]] : "",
        client_name: dm["Client Name"] != null ? row[dm["Client Name"]] : "",
        address: dm["Address"] != null ? row[dm["Address"]] : "",
        service_type: dm["Service Type"] != null ? row[dm["Service Type"]] : "",
        chemical: dm["Chemical"] != null ? row[dm["Chemical"]] : "",
        extended_cost: dm["Extended Cost"] != null ? row[dm["Extended Cost"]] : ""
      }));
    }
  }
}

function getWeekStart_(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);

  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = -day; // move back to Sunday

  d.setDate(d.getDate() + diff);
  return d;
}

function extractPoolId_(value) {
  const s = String(value || "").trim();
  const m = s.match(/(MCPS-\d{4,})\s*$/i);
  return m ? m[1].toUpperCase() : s; // ← if no MCPS-XXXX found, returns the whole raw string
}

function getHeaderMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || "").trim());
  const map = {};
  headers.forEach((h, i) => { if (h) map[h] = i + 1; });
  return { headers, map };
}

function buildPriceMap_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(COSTS_SHEET);
  if (!sheet) throw new Error(`Missing sheet: ${COSTS_SHEET}`);

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};

  const data = sheet.getRange(2, 1, lastRow - 1, COST_PER_UNIT_COL).getValues();
  const priceByName = {};

  data.forEach(r => {
    const name = String(r[COST_NAME_COL - 1] || "").trim();
    const cost = Number(r[COST_PER_UNIT_COL - 1]);
    if (name && isFinite(cost)) priceByName[name] = cost;
  });

  return priceByName;
}

function ensureHeaders_(sheet, headers) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return getHeaderMap_(sheet);
  }

  const hm = getHeaderMap_(sheet);
  const existing = new Set(hm.headers);
  const toAdd = headers.filter(h => !existing.has(h));

  if (toAdd.length) {
    sheet.getRange(1, hm.headers.length + 1, 1, toAdd.length).setValues([toAdd]);
  }

  return getHeaderMap_(sheet);
}

// ── Signed_Customers lookup (used to validate pool_id before analytics) ───────
function getSignedCustomerLookup_() {
  const CRM_SS_ID = "1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E";
  const map = {};
  try {
    const ss = SpreadsheetApp.openById(CRM_SS_ID);

    // Source 1: Signed_Customers (existing signed contracts)
    const signedSheet = ss.getSheetByName("Signed_Customers");
    if (signedSheet && signedSheet.getLastRow() >= 2) {
      const data    = signedSheet.getRange(1, 1, signedSheet.getLastRow(), signedSheet.getLastColumn()).getValues();
      const headers = data[0].map(h => String(h || "").trim());
      const pidCol  = headers.indexOf("pool_id");
      if (pidCol !== -1) {
        for (let i = 1; i < data.length; i++) {
          const pid = String(data[i][pidCol] || "").trim();
          if (pid) map[pid] = true;
        }
      }
    }

    // Source 2: Quotes sheet — ACTIVE_CUSTOMER status (covers startup transfers
    // and any customer activated directly from the CRM without a Signed_Customers row)
    const quotesSheet = ss.getSheetByName("Quotes");
    if (quotesSheet && quotesSheet.getLastRow() >= 2) {
      const data    = quotesSheet.getRange(1, 1, quotesSheet.getLastRow(), quotesSheet.getLastColumn()).getValues();
      const headers = data[0].map(h => String(h || "").trim().toLowerCase());
      const pidCol    = headers.indexOf("pool_id");
      const statusCol = headers.indexOf("status");
      if (pidCol !== -1 && statusCol !== -1) {
        for (let i = 1; i < data.length; i++) {
          const status = String(data[i][statusCol] || "").trim().toUpperCase();
          const pid    = String(data[i][pidCol]    || "").trim();
          if (pid && status === "ACTIVE_CUSTOMER") map[pid] = true;
        }
      }
    }
  } catch(e) {
    Logger.log("getSignedCustomerLookup_ error: " + e);
  }
  return map;
}


// Trigger entrypoint (installable trigger should point to THIS)
function snapshotUsageToPriced(e) {
  return snapshotUsageToPriced_(e);
}
function snapshotUsageToPriced_(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const signedLookup = getSignedCustomerLookup_();
  const raw = ss.getSheetByName(RAW_SHEET);
  if (!raw) throw new Error(`Missing sheet: ${RAW_SHEET}`);

  const priced = ss.getSheetByName(PRICED_SHEET) || ss.insertSheet(PRICED_SHEET);

  // Which row was submitted?
  const row = (e && e.range) ? e.range.getRow() : raw.getLastRow();
  if (row < 2) return;

  const rawHm = getHeaderMap_(raw);
  const rawRow = raw.getRange(row, 1, 1, rawHm.headers.length).getValues()[0];

  const priceMap = buildPriceMap_();

  // Base headers: all raw headers as-is (so you keep all quantities)
  const baseHeaders = rawHm.headers.slice();

  // Optional unit cost snapshot columns for chemicals that exist in Chem_Costs
  const unitCostHeaders = [];
  rawHm.headers.forEach(h => {
    if (priceMap.hasOwnProperty(h)) unitCostHeaders.push(`${h} Unit Cost (Snapshot)`);
  });

  // Extra computed fields
  const extraHeaders = ["Week Start", "WeekKey", "Visit # in Week", "Total Visit Chem Cost (Snapshot)"];

  const finalHeaders = baseHeaders.concat(unitCostHeaders, extraHeaders);
  const pricedHm = ensureHeaders_(priced, finalHeaders);

  // Prepare output row aligned to priced sheet headers
  const out = new Array(pricedHm.headers.length).fill("");

  // Copy raw values into the priced row
  rawHm.headers.forEach((h, i) => {
    const col = pricedHm.map[h];
    if (col) out[col - 1] = rawRow[i];
  });

  // Timestamp + week bucket
  const ts = new Date(out[pricedHm.map["Timestamp"] - 1]);

  // ─── Detect Other / Pool not listed ──────────────────────────────────────────
  const rawPoolId = String(out[pricedHm.map["pool_id"] - 1] || "").trim();
  if (rawPoolId === "Other / Pool not listed") {
    // Still write the priced row so chemicals are logged
    priced.appendRow(out);

    // Flag for manual matching
    try {
      flagUnmatchedSubmission(
        rawRow,
        rawHm.headers,
        row,
        priced.getLastRow()
      );
    } catch(e) {
      Logger.log("flagUnmatchedSubmission error: " + e);
    }

    // Skip rollup and analytics — pool_id is unknown
    return;
  }
  // ─── End unmatched detection ──────────────────────────────────────────────────

  const weekStart = getWeekStart_(ts);
  out[pricedHm.map["Week Start"] - 1] = weekStart;

  const tz = ss.getSpreadsheetTimeZone();

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);

  const startStr = Utilities.formatDate(weekStart, tz, "M/d");
  const endStr = Utilities.formatDate(weekEnd, tz, "M/d");

  const weekKey = `${startStr}-${endStr}`;

  out[pricedHm.map["WeekKey"] - 1] = weekKey;

  // Compute total chemical cost snapshot
  let total = 0;

  rawHm.headers.forEach((h, i) => {
    if (!priceMap.hasOwnProperty(h)) return;

    const qty = Number(rawRow[i]);
    if (!isFinite(qty) || qty === 0) return;

    const unit = priceMap[h];
    total += qty * unit;

    // Write unit cost snapshot
    const ucHeader = `${h} Unit Cost (Snapshot)`;
    const ucCol = pricedHm.map[ucHeader];
    if (ucCol) out[ucCol - 1] = unit;
  });

  out[pricedHm.map["Total Visit Chem Cost (Snapshot)"] - 1] = total;
  Logger.log("Computed total chem cost = " + total);

  // Visit # in Week (count previous visits for same pool_id within same week)
  const poolIdCol = pricedHm.map["pool_id"];
  const tsCol = pricedHm.map["Timestamp"];

  let poolId = poolIdCol ? out[poolIdCol - 1] : "";

  // Extract MCPS ID from dropdown value
  poolId = extractPoolId_(poolId);

  // Save normalized ID back
  if (poolIdCol) out[poolIdCol - 1] = poolId;

  let visitNum = 1;
  if (poolId && priced.getLastRow() >= 2) {
    const lastRow = priced.getLastRow();
    const values = priced.getRange(2, 1, lastRow - 1, pricedHm.headers.length).getValues();

    let count = 0;
    values.forEach(r => {
      const pid = r[poolIdCol - 1];
      const t = new Date(r[tsCol - 1]);
      const existingWeekStart = getWeekStart_(t);

      if (
        pid === poolId &&
        existingWeekStart.getTime() === weekStart.getTime()
      ) {
        count++;
      }
    });

    visitNum = count + 1;
  }

  out[pricedHm.map["Visit # in Week"] - 1] = visitNum;

  const dedupKey = buildUsageDedupKey_(rawRow, rawHm.headers, poolId);
  if (!claimDedupAction_("usage_snapshot", dedupKey)) {
    Logger.log("Duplicate snapshot prevented for " + dedupKey);
    return;
  }

  // Append snapshot row (immutable history)
  priced.appendRow(out);

  if (!signedLookup[poolId]) {
    Logger.log("Invalid pool_id, skipping analytics: " + poolId);
    return;
  }

  refreshChemicalAnalytics();


  // ── Startup / Sponsored lifecycle (non-blocking) ──────────────────────────
  // Counts real Usage_Priced submissions to auto-track startup progress.
  // Flips service to "Weekly Full Service" on completion.
  // Fires admin notification after 4th monthly visit for sponsored clients.
  try {
    if (poolId && poolId !== "OTHER / POOL NOT LISTED") {
      checkStartupLifecycle(poolId, ts);
    }
  } catch(e) {
    Logger.log("StartupLifecycle hook error: " + e);
  }
}

function TEST_snapshot_createSheet() {
  snapshotUsageToPriced_(); // no event object; it will use lastRow
}

function TEST_rollup_latest() {
  rollupLatestSnapshotToPoolWeek_();
}

/**
 * Run this ONE TIME to rewrite all past submissions to align with Sunday-Saturday Quickbooks weeks.
 */
function RUN_ONE_TIME_SUNDAY_BACKFILL() {
  Logger.log("1. Backfilling Usage_Priced sheet...");
  backfillWeeklyFieldsInUsagePriced(); // in Rollup.gs

  Logger.log("2. Rebuilding Chem_Cost_per_Pool from scratch...");
  rebuildWeeklyRollupFromUsagePriced(); // in Rollup.gs

  Logger.log("3. Rebuilding Analytics Dashboard...");
  refreshChemicalAnalytics(); // in ChemicalAnalytics.gs

  Logger.log("Done! Week keys are now correctly Sunday-Saturday.");
}
