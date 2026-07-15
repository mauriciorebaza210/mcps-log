// VoidSubmissions.gs
// Safely voids a usage submission: moves raw row to Voided_Log,
// marks Usage_Priced row, reverses inventory, and rebuilds analytics.

const VOID_LOG_SHEET       = "Voided_Log";
const VOID_USAGE_LOG       = "Chemical_Usage_Log";
const VOID_USAGE_PRICED    = "Usage_Priced";
const VOID_INVENTORY_SS_ID = "1xPv2oEkJ1KCI3l1LexA4cGH73MM-sWXunQ4fr0wyBSI";
const VOID_INVENTORY_SHEET = "Inventory_Master";

const VOID_NON_CHEM_HEADERS = new Set([
  "Timestamp","pool_id","Technician","Notes","Client Name","Address",
  "Service Type","Month","Visit # in Month","Week Start","WeekKey",
  "MonthKey","Visit # in Week","Total Visit Chem Cost (Snapshot)",
  "Free Chlorine (FC)","pH","Total Alkalinity (TA)","Calcium Hardness (CH)",
  "Voided","Voided_At","Voided_By","Void_Reason"
]);

// ─── Get pools that have submissions (for void dropdown) ──────────────────────
function getPoolsForVoid() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(VOID_USAGE_LOG);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const poolCol  = headers.indexOf("pool_id");
  const voidedCol = headers.indexOf("Voided");
  if (poolCol === -1) return [];

  const data = sheet.getRange(2, poolCol + 1, sheet.getLastRow() - 1, 1)
    .getValues().flat();

  const seen = new Set();
  data.forEach((v, i) => {
    const pid = String(v || "").trim();
    if (!pid) return;
    // Skip already-voided rows if voided col exists
    seen.add(pid);
  });

  return [...seen].sort();
}

// ─── Get submissions for a pool (with void status) ───────────────────────────
function getSubmissionsForVoid(poolId) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(VOID_USAGE_LOG);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const headers   = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const poolCol   = headers.indexOf("pool_id");
  const tsCol     = headers.indexOf("Timestamp");
  const techCol   = headers.indexOf("Technician");
  const voidedCol = headers.indexOf("Voided");

  if (poolCol === -1 || tsCol === -1) return [];

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn())
    .getValues();

  const results = [];
  data.forEach((row, i) => {
    const pid = String(row[poolCol] || "").trim();
    if (pid !== poolId.trim()) return;

    const isVoided = voidedCol !== -1 && String(row[voidedCol] || "").trim().toLowerCase() === "yes";

    // Get chemical quantities for display
    const chems = [];
    headers.forEach((name, j) => {
      if (!name || VOID_NON_CHEM_HEADERS.has(name)) return;
      if (name.endsWith(" Unit Cost (Snapshot)")) return;
      const qty = Number(row[j] || 0);
      if (qty > 0) chems.push(`${name}: ${qty}`);
    });

    const techName = techCol !== -1 ? String(row[techCol] || "").trim() : "";

    results.push({
      rowIndex  : i + 2,
      timestamp : row[tsCol] ? String(row[tsCol]) : "",
      poolId    : pid,
      technician: techName,
      chemicals : chems.join(", ") || "No chemicals logged",
      isVoided
    });
  });

  return results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

// ─── Preview void — shows what will be reversed ──────────────────────────────
function previewVoid(rowIndex) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(VOID_USAGE_LOG);

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const row     = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];

  const tsCol   = headers.indexOf("Timestamp");
  const poolCol = headers.indexOf("pool_id");
  const techCol = headers.indexOf("Technician");

  // Load inventory for context
  const invSs    = SpreadsheetApp.openById(VOID_INVENTORY_SS_ID);
  const invSheet = invSs.getSheetByName(VOID_INVENTORY_SHEET);
  const invHeaders = invSheet.getRange(1, 1, 1, invSheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const dispCol  = invHeaders.indexOf("display_name");
  const qtyCol   = invHeaders.indexOf("qty_on_hand");

  const invMap = {};
  if (invSheet.getLastRow() >= 2) {
    invSheet.getRange(2, 1, invSheet.getLastRow() - 1, invSheet.getLastColumn())
      .getValues().forEach(r => {
        const name = String(r[dispCol] || "").trim();
        if (name) invMap[name] = Number(r[qtyCol] || 0);
      });
  }

  // Build alias map for chemical name resolution
  const aliasMap = buildLegacyAliasMap_();

  const chemicals = [];
  headers.forEach((name, i) => {
    if (!name || VOID_NON_CHEM_HEADERS.has(name)) return;
    if (name.endsWith(" Unit Cost (Snapshot)")) return;

    const qty = Number(row[i] || 0);
    if (!isFinite(qty) || qty === 0) return;

    const cleanName  = aliasMap[name] || name;
    const currentInv = invMap.hasOwnProperty(cleanName) ? invMap[cleanName] : null;

    chemicals.push({
      rawName    : name,
      cleanName,
      qty,
      currentInv,
      projectedInv: currentInv !== null ? currentInv + qty : null,  // voiding adds back to inventory
      inInventory: currentInv !== null
    });
  });

  return {
    rowIndex,
    timestamp  : row[tsCol]   ? String(row[tsCol])   : "",
    poolId     : row[poolCol] ? String(row[poolCol])  : "",
    technician : techCol !== -1 ? String(row[techCol] || "") : "",
    chemicals,
    hasChemicals: chemicals.length > 0
  };
}

// ─── Apply void ───────────────────────────────────────────────────────────────
function applyVoid(rowIndex, voidedBy, voidReason) {
  voidedBy   = String(voidedBy   || "unknown").trim();
  voidReason = String(voidReason || "").trim();

  const ss          = SpreadsheetApp.getActiveSpreadsheet();
  const usageSheet  = ss.getSheetByName(VOID_USAGE_LOG);
  const pricedSheet = ss.getSheetByName(VOID_USAGE_PRICED);

  // ── Read usage row ────────────────────────────────────────────────────────
  let usageHeaders = usageSheet.getRange(1, 1, 1, usageSheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const usageRow = usageSheet.getRange(rowIndex, 1, 1, usageSheet.getLastColumn())
    .getValues()[0];

  const tsCol   = usageHeaders.indexOf("Timestamp");
  const poolCol = usageHeaders.indexOf("pool_id");
  const ts      = usageRow[tsCol];  // raw Date object or string from sheet
  const poolId  = String(usageRow[poolCol] || "").trim();

  // Check not already voided
  const existingVoidCol = usageHeaders.indexOf("Voided");
  if (existingVoidCol !== -1 &&
      String(usageRow[existingVoidCol] || "").trim().toLowerCase() === "yes") {
    return { ok: false, error: "This submission is already voided" };
  }

  // ── 1. Archive full row to Voided_Log ────────────────────────────────────
  ensureVoidedLog_();
  voidSheet_archive:
  {
    const archiveRow = [...usageRow, new Date(), voidedBy, voidReason, rowIndex];
    ss.getSheetByName(VOID_LOG_SHEET).appendRow(archiveRow);
  }

  // ── 2. Ensure Voided columns exist in Chemical_Usage_Log, then write ──────
  // Always re-read column count AFTER any potential insertions
  if (usageHeaders.indexOf("Voided") === -1) {
    const nextCol = usageSheet.getLastColumn() + 1;
    usageSheet.getRange(1, nextCol,     1, 1).setValue("Voided");
    usageSheet.getRange(1, nextCol + 1, 1, 1).setValue("Voided_At");
    usageSheet.getRange(1, nextCol + 2, 1, 1).setValue("Voided_By");
    usageSheet.getRange(1, nextCol + 3, 1, 1).setValue("Void_Reason");
    // Re-read headers so indexOf picks up the new columns
    usageHeaders = usageSheet.getRange(1, 1, 1, usageSheet.getLastColumn())
      .getValues()[0].map(h => String(h || "").trim());
  }

  // Now write — guaranteed to find columns
  usageSheet.getRange(rowIndex, usageHeaders.indexOf("Voided")      + 1).setValue("yes");
  usageSheet.getRange(rowIndex, usageHeaders.indexOf("Voided_At")   + 1).setValue(new Date());
  usageSheet.getRange(rowIndex, usageHeaders.indexOf("Voided_By")   + 1).setValue(voidedBy);
  usageSheet.getRange(rowIndex, usageHeaders.indexOf("Void_Reason") + 1).setValue(voidReason);

  // ── 3. Mark matching row in Usage_Priced ─────────────────────────────────
  if (pricedSheet && pricedSheet.getLastRow() >= 2) {
    let pricedHeaders = pricedSheet.getRange(1, 1, 1, pricedSheet.getLastColumn())
      .getValues()[0].map(h => String(h || "").trim());

    // Ensure Voided column exists in priced sheet
    if (pricedHeaders.indexOf("Voided") === -1) {
      const nc = pricedSheet.getLastColumn() + 1;
      pricedSheet.getRange(1, nc, 1, 1).setValue("Voided");
      pricedHeaders = pricedSheet.getRange(1, 1, 1, pricedSheet.getLastColumn())
        .getValues()[0].map(h => String(h || "").trim());
    }

    const pTsCol    = pricedHeaders.indexOf("Timestamp");
    const pPoolCol  = pricedHeaders.indexOf("pool_id");
    const pVoidCol  = pricedHeaders.indexOf("Voided");  // now guaranteed to exist

    // Normalize the source timestamp to a comparable string
    // Sheets dates come back as Date objects — compare using getTime() when both are Dates,
    // fall back to string comparison otherwise.
    const tsTime = (ts instanceof Date) ? ts.getTime() : String(ts);

    const pricedData = pricedSheet.getRange(2, 1, pricedSheet.getLastRow() - 1,
      pricedSheet.getLastColumn()).getValues();

    pricedData.forEach((row, i) => {
      const rowTs   = row[pTsCol];
      const rowPool = String(row[pPoolCol] || "").trim();

      const tsMatch = (rowTs instanceof Date && ts instanceof Date)
        ? rowTs.getTime() === ts.getTime()
        : String(rowTs) === String(ts);

      if (tsMatch && rowPool === poolId) {
        pricedSheet.getRange(i + 2, pVoidCol + 1).setValue("yes");
      }
    });
  }

  // ── 4. Reverse inventory ──────────────────────────────────────────────────
  const aliasMap   = buildLegacyAliasMap_();
  const invSs      = SpreadsheetApp.openById(VOID_INVENTORY_SS_ID);
  const invSheet   = invSs.getSheetByName(VOID_INVENTORY_SHEET);
  const invHeaders = invSheet.getRange(1, 1, 1, invSheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const dispCol    = invHeaders.indexOf("display_name");
  const qtyColInv  = invHeaders.indexOf("qty_on_hand");

  const invData = invSheet.getLastRow() >= 2
    ? invSheet.getRange(2, 1, invSheet.getLastRow() - 1, invSheet.getLastColumn()).getValues()
    : [];

  const invMap = {};
  invData.forEach((row, i) => {
    const name = String(row[dispCol] || "").trim();
    if (name) invMap[name] = { sheetRow: i + 2, qty: Number(row[qtyColInv] || 0) };
  });

  const invResults = [];
  usageHeaders.forEach((name, i) => {
    if (!name || VOID_NON_CHEM_HEADERS.has(name)) return;
    if (name.endsWith(" Unit Cost (Snapshot)")) return;

    const qty = Number(usageRow[i] || 0);
    if (!isFinite(qty) || qty === 0) return;

    const cleanName = aliasMap[name] || name;
    const invItem   = invMap[cleanName];
    if (!invItem) {
      invResults.push({ name: cleanName, applied: false, reason: "Not in inventory" });
      return;
    }

    const newQty = invItem.qty + qty; // void → add back
    invSheet.getRange(invItem.sheetRow, qtyColInv + 1).setValue(newQty);
    invResults.push({
      name: cleanName, applied: true,
      before: invItem.qty, after: newQty, delta: qty
    });
  });

  // ── 5. Rebuild analytics ──────────────────────────────────────────────────
  try { refreshChemicalAnalytics(); }
  catch(e) { Logger.log("Analytics rebuild warning: " + e); }

  return { ok: true, poolId, invResults };
}

// ─── Get voided submissions log ───────────────────────────────────────────────
function getVoidedLog(limit) {
  limit = limit || 50;
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(VOID_LOG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const data    = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn())
    .getValues();

  const tsCol       = headers.indexOf("Timestamp");
  const poolCol     = headers.indexOf("pool_id");
  const techCol     = headers.indexOf("Technician");
  const voidAtCol   = headers.indexOf("Voided_At");
  const voidByCol   = headers.indexOf("Voided_By");
  const voidReasonCol = headers.indexOf("Void_Reason");
  const origRowCol  = headers.indexOf("Original_Row");

  return data.slice(-limit).reverse().map(row => ({
    timestamp    : row[tsCol]       ? String(row[tsCol])       : "",
    poolId       : row[poolCol]     ? String(row[poolCol])     : "",
    technician   : techCol !== -1   ? String(row[techCol] || "") : "",
    voidedAt     : voidAtCol !== -1 ? String(row[voidAtCol] || "") : "",
    voidedBy     : voidByCol !== -1 ? String(row[voidByCol] || "") : "",
    voidReason   : voidReasonCol !== -1 ? String(row[voidReasonCol] || "") : "",
    originalRow  : origRowCol !== -1 ? row[origRowCol] : ""
  }));
}

// ─── Ensure Voided_Log sheet exists ──────────────────────────────────────────
function ensureVoidedLog_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(VOID_LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(VOID_LOG_SHEET);
    // Mirror Chemical_Usage_Log headers + void metadata columns
    const usageSheet = ss.getSheetByName(VOID_USAGE_LOG);
    const usageHeaders = usageSheet
      ? usageSheet.getRange(1, 1, 1, usageSheet.getLastColumn())
          .getValues()[0].map(h => String(h || "").trim())
      : [];
    const allHeaders = [
      ...usageHeaders,
      "Voided_At", "Voided_By", "Void_Reason", "Original_Row"
    ];
    sheet.getRange(1, 1, 1, allHeaders.length).setValues([allHeaders]).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ─── One-time repair: re-apply Voided=yes to any rows already in Voided_Log ──
// Run this once via the menu after deploying the fix, to catch the already-voided entry.
function repairVoidedFlags() {
  const ss          = SpreadsheetApp.getActiveSpreadsheet();
  const voidSheet   = ss.getSheetByName(VOID_LOG_SHEET);
  const usageSheet  = ss.getSheetByName(VOID_USAGE_LOG);
  const pricedSheet = ss.getSheetByName(VOID_USAGE_PRICED);

  if (!voidSheet || voidSheet.getLastRow() < 2) {
    ss.toast("Voided_Log is empty — nothing to repair", "MCPS");
    return;
  }

  const voidData    = voidSheet.getDataRange().getValues();
  const voidHeaders = voidData[0].map(h => String(h || "").trim());

  // Voided_Log mirrors Chemical_Usage_Log columns, with Voided_At/By/Reason/OrigRow appended
  const origRowCol  = voidHeaders.indexOf("Original_Row");
  const vTsCol      = voidHeaders.indexOf("Timestamp");
  const vPoolCol    = voidHeaders.indexOf("pool_id");
  const vAtCol      = voidHeaders.indexOf("Voided_At");
  const vByCol      = voidHeaders.indexOf("Voided_By");
  const vReasonCol  = voidHeaders.indexOf("Void_Reason");

  // ── Ensure void columns in Chemical_Usage_Log ──
  let usageHeaders = usageSheet.getRange(1, 1, 1, usageSheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());

  if (usageHeaders.indexOf("Voided") === -1) {
    const nc = usageSheet.getLastColumn() + 1;
    usageSheet.getRange(1, nc,     1, 1).setValue("Voided");
    usageSheet.getRange(1, nc + 1, 1, 1).setValue("Voided_At");
    usageSheet.getRange(1, nc + 2, 1, 1).setValue("Voided_By");
    usageSheet.getRange(1, nc + 3, 1, 1).setValue("Void_Reason");
    usageHeaders = usageSheet.getRange(1, 1, 1, usageSheet.getLastColumn())
      .getValues()[0].map(h => String(h || "").trim());
  }

  const uVoidCol   = usageHeaders.indexOf("Voided");
  const uVoidAtCol = usageHeaders.indexOf("Voided_At");
  const uVoidByCol = usageHeaders.indexOf("Voided_By");
  const uVoidRsCol = usageHeaders.indexOf("Void_Reason");

  // ── Ensure Voided column in Usage_Priced ──
  let pricedHeaders = pricedSheet.getRange(1, 1, 1, pricedSheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());

  if (pricedHeaders.indexOf("Voided") === -1) {
    const nc = pricedSheet.getLastColumn() + 1;
    pricedSheet.getRange(1, nc, 1, 1).setValue("Voided");
    pricedHeaders = pricedSheet.getRange(1, 1, 1, pricedSheet.getLastColumn())
      .getValues()[0].map(h => String(h || "").trim());
  }

  const pVoidCol  = pricedHeaders.indexOf("Voided");
  const pTsCol    = pricedHeaders.indexOf("Timestamp");
  const pPoolCol  = pricedHeaders.indexOf("pool_id");

  const pricedData = pricedSheet.getLastRow() >= 2
    ? pricedSheet.getRange(2, 1, pricedSheet.getLastRow() - 1, pricedSheet.getLastColumn()).getValues()
    : [];

  let fixed = 0;

  // Process each voided row
  voidData.slice(1).forEach(vRow => {
    const originalRow = origRowCol !== -1 ? Number(vRow[origRowCol]) : 0;
    const voidedAt    = vAtCol    !== -1 ? vRow[vAtCol]    : new Date();
    const voidedBy    = vByCol    !== -1 ? String(vRow[vByCol] || "").trim()    : "";
    const voidReason  = vReasonCol !== -1 ? String(vRow[vReasonCol] || "").trim() : "";
    const ts          = vRow[vTsCol];
    const poolId      = String(vRow[vPoolCol] || "").trim();

    // Mark in Chemical_Usage_Log by original row index
    if (originalRow >= 2) {
      const currentVoided = usageSheet.getRange(originalRow, uVoidCol + 1).getValue();
      if (String(currentVoided || "").toLowerCase() !== "yes") {
        usageSheet.getRange(originalRow, uVoidCol   + 1).setValue("yes");
        usageSheet.getRange(originalRow, uVoidAtCol + 1).setValue(voidedAt);
        usageSheet.getRange(originalRow, uVoidByCol + 1).setValue(voidedBy);
        usageSheet.getRange(originalRow, uVoidRsCol + 1).setValue(voidReason);
        fixed++;
      }
    }

    // Mark matching row in Usage_Priced by timestamp + pool_id
    pricedData.forEach((pRow, i) => {
      const pTs    = pRow[pTsCol];
      const pPool  = String(pRow[pPoolCol] || "").trim();
      const tsMatch = (pTs instanceof Date && ts instanceof Date)
        ? pTs.getTime() === ts.getTime()
        : String(pTs) === String(ts);

      if (tsMatch && pPool === poolId &&
          String(pRow[pVoidCol] || "").toLowerCase() !== "yes") {
        pricedSheet.getRange(i + 2, pVoidCol + 1).setValue("yes");
      }
    });
  });

  // Rebuild analytics so voided rows are excluded
  refreshChemicalAnalytics();

  ss.toast(`✅ Repaired ${fixed} row(s) — analytics rebuilt`, "MCPS");
}