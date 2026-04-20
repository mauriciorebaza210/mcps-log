// Corrections.gs
// Handles chemical usage corrections with full audit trail and inventory reversal.

const CORR_LOG_SHEET        = "Corrections_Log";
const CORR_USAGE_LOG        = "Chemical_Usage_Log";
const CORR_USAGE_PRICED     = "Usage_Priced";
const CORR_INVENTORY_SS_ID  = "1xPv2oEkJ1KCI3l1LexA4cGH73MM-sWXunQ4fr0wyBSI";
const CORR_INVENTORY_SHEET  = "Inventory_Master";

const CORR_NON_CHEM_HEADERS = new Set([
  "Timestamp","pool_id","Technician","Notes","Client Name","Address",
  "Service Type","Month","Visit # in Month","Week Start","WeekKey",
  "MonthKey","Visit # in Week","Total Visit Chem Cost (Snapshot)",
  "Chlorine (Cl)","pH","Total Alkalinity (TA)","Calcium Hardness (CH)"
]);

// onOpen menu — paste this into Corrections.gs, replacing the existing onOpen function

// onOpen menu — paste this into Corrections.gs, replacing the existing onOpen function

// onOpen menu — paste this into Corrections.gs, replacing the existing onOpen function

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("⚗️ Chem Admin")
    .addItem("Manage Chemicals",          "showChemAdmin")
    .addItem("Correct Submission",        "showCorrections")
    .addSeparator()
    .addItem("📊 Refresh KPI Dashboard",     "refreshKpiDashboard")
    .addItem("🛠 Setup KPI Dashboard",       "setupKpiDashboard")
    .addItem("🔧 Repair Voided Flags",       "repairVoidedFlags")
    .addSeparator()
    .addItem("📽 Generate Weekly Deck",      "generateWeeklyDeckLatest")
    .addItem("🗓 Pick Weekly Deck Week",     "generateWeeklyDeckPickWeek")
    .addItem("⏰ Install Monday Auto-Deck",  "installWeeklyDeckTrigger")
    .addSeparator()
    .addItem("📧 Check Invoice Emails",   "checkInvoiceEmails")
    .addItem("📊 Refresh Analytics",      "refreshChemicalAnalytics")
    .addToUi();
}
function showCorrections() {
  const html = HtmlService.createHtmlOutputFromFile("CorrectionsUI")
    .setTitle("Correct Submission")
    .setWidth(540);
  SpreadsheetApp.getUi().showSidebar(html);
}

// ─── Get pool list for dropdown ───────────────────────────────────────────────
function getPoolList() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CORR_USAGE_LOG);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const headers  = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const poolCol  = headers.indexOf("pool_id");
  if (poolCol === -1) return [];

  const data = sheet.getRange(2, poolCol + 1, sheet.getLastRow() - 1, 1)
    .getValues().flat()
    .map(v => String(v || "").trim())
    .filter(Boolean);

  // Unique, sorted
  return [...new Set(data)].sort();
}

// ─── Get submissions for a pool ───────────────────────────────────────────────
function getSubmissionsForPool(poolId) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CORR_USAGE_LOG);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());

  const poolCol = headers.indexOf("pool_id");
  const tsCol   = headers.indexOf("Timestamp");
  if (poolCol === -1 || tsCol === -1) return [];

  const data    = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn())
    .getValues();

  const results = [];
  data.forEach((row, i) => {
    const pid = String(row[poolCol] || "").trim();
    if (pid !== poolId.trim()) return;

    const ts = row[tsCol];
    results.push({
      rowIndex  : i + 2, // 1-indexed sheet row
      timestamp : ts ? String(ts) : "",
      poolId    : pid
    });
  });

  // Newest first
  return results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

// ─── Get chemical quantities for a specific row ───────────────────────────────
function getSubmissionDetail(rowIndex) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CORR_USAGE_LOG);

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const rowData = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn())
    .getValues()[0];

  const chemicals = [];
  headers.forEach((name, i) => {
    if (!name || CORR_NON_CHEM_HEADERS.has(name)) return;
    if (name.endsWith(" Unit Cost (Snapshot)")) return;

    const qty = rowData[i];
    const num = Number(qty);
    chemicals.push({
      name     : name,
      colIndex : i, // 0-indexed
      qty      : isFinite(num) ? num : 0
    });
  });

  const tsCol   = headers.indexOf("Timestamp");
  const poolCol = headers.indexOf("pool_id");

  return {
    rowIndex  : rowIndex,
    timestamp : tsCol   !== -1 ? String(rowData[tsCol])   : "",
    poolId    : poolCol !== -1 ? String(rowData[poolCol])  : "",
    chemicals
  };
}

// ─── Preview correction — returns before/after diff ───────────────────────────
// corrections = [{ name, colIndex, oldQty, newQty }]
function previewCorrection(rowIndex, corrections) {
  // Load current inventory levels for context
  const invSs    = SpreadsheetApp.openById(CORR_INVENTORY_SS_ID);
  const invSheet = invSs.getSheetByName(CORR_INVENTORY_SHEET);

  const invHeaders = invSheet.getRange(1, 1, 1, invSheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const dispCol    = invHeaders.indexOf("display_name");
  const qtyCol     = invHeaders.indexOf("qty_on_hand");

  const invMap = {};
  if (invSheet.getLastRow() >= 2) {
    invSheet.getRange(2, 1, invSheet.getLastRow() - 1, invSheet.getLastColumn())
      .getValues().forEach(r => {
        const name = String(r[dispCol] || "").trim();
        if (name) invMap[name] = Number(r[qtyCol] || 0);
      });
  }

  // Build diff rows — only include chemicals that actually changed
  const diff = corrections
    .filter(c => Number(c.oldQty) !== Number(c.newQty))
    .map(c => {
      const oldQty      = Number(c.oldQty);
      const newQty      = Number(c.newQty);
      const delta       = newQty - oldQty;       // positive = used more, negative = used less
      const invDelta    = -(delta);              // inventory moves opposite to usage
      const currentInv  = invMap.hasOwnProperty(c.name) ? invMap[c.name] : null;
      const projectedInv= currentInv !== null ? currentInv + invDelta : null;

      return {
        name          : c.name,
        oldQty,
        newQty,
        delta,
        invDelta,
        currentInv,
        projectedInv,
        inInventory   : invMap.hasOwnProperty(c.name)
      };
    });

  return { diff, hasChanges: diff.length > 0 };
}

function applyCorrection(rowIndex, corrections, correctedBy) {
  correctedBy = String(correctedBy || "unknown").trim();

  const ss          = SpreadsheetApp.getActiveSpreadsheet();
  const usageSheet  = ss.getSheetByName(CORR_USAGE_LOG);
  const pricedSheet = ss.getSheetByName(CORR_USAGE_PRICED);

  const usageHeaders = usageSheet.getRange(1, 1, 1, usageSheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());

  const usageRow = usageSheet.getRange(rowIndex, 1, 1, usageSheet.getLastColumn())
    .getValues()[0];

  const tsCol   = usageHeaders.indexOf("Timestamp");
  const poolCol = usageHeaders.indexOf("pool_id");
  const ts      = usageRow[tsCol];
  const poolId  = String(usageRow[poolCol] || "").trim();

  const changes = corrections.filter(c => Number(c.oldQty) !== Number(c.newQty));
  if (!changes.length) return { ok: false, error: "No changes detected" };

  // Extract MCPS-XXXX from either short or long pool_id format
  const extractId_ = v => {
    const m = String(v || "").match(/MCPS-\d+/i);
    return m ? m[0].toUpperCase() : String(v || "").trim();
  };

  const toMinute_ = v => {
    if (!v) return null;
    const d = (v instanceof Date) ? v : new Date(v);
    return isNaN(d) ? null : Math.round(d.getTime() / 60000);
  };

  // ── 1. Update Chemical_Usage_Log ──────────────────────────────────────────
  changes.forEach(c => {
    usageSheet.getRange(rowIndex, c.colIndex + 1).setValue(Number(c.newQty));
  });

  // ── 2. Update Usage_Priced ────────────────────────────────────────────────
  if (pricedSheet && pricedSheet.getLastRow() >= 2) {
    const pricedHeaders = pricedSheet.getRange(1, 1, 1, pricedSheet.getLastColumn())
      .getValues()[0].map(h => String(h || "").trim());

    const pTsCol   = pricedHeaders.indexOf("Timestamp");
    const pPoolCol = pricedHeaders.indexOf("pool_id");

    const targetPool   = extractId_(poolId);
    const targetMinute = toMinute_(ts);

    const pricedData = pricedSheet.getRange(
      2, 1, pricedSheet.getLastRow() - 1, pricedSheet.getLastColumn()
    ).getValues();

    let matchedPricedRow = -1;

    // Pass 1: minute-rounded timestamp + extracted pool_id
    for (let i = 0; i < pricedData.length; i++) {
      const rowMinute = toMinute_(pricedData[i][pTsCol]);
      const rowPool   = extractId_(pricedData[i][pPoolCol]);
      if (rowMinute !== null && rowMinute === targetMinute && rowPool === targetPool) {
        matchedPricedRow = i + 2;
        Logger.log("applyCorrection: matched Usage_Priced at row " + matchedPricedRow + " (timestamp+pool)");
        break;
      }
    }

    // Pass 2: row parity fallback — same row number, same extracted pool_id
    if (matchedPricedRow === -1 && rowIndex <= pricedSheet.getLastRow()) {
      const checkPool = extractId_(
        pricedSheet.getRange(rowIndex, pPoolCol + 1).getValue()
      );
      if (checkPool === targetPool) {
        matchedPricedRow = rowIndex;
        Logger.log("applyCorrection: matched Usage_Priced at row " + matchedPricedRow + " (row parity)");
      }
    }

    if (matchedPricedRow === -1) {
      Logger.log("applyCorrection WARNING: no Usage_Priced match for pool " + targetPool + " ts " + ts);
    } else {
      changes.forEach(c => {
        const pCol = pricedHeaders.indexOf(c.name);
        if (pCol !== -1) {
          pricedSheet.getRange(matchedPricedRow, pCol + 1).setValue(Number(c.newQty));
          Logger.log("applyCorrection: set " + c.name + " = " + c.newQty + " in Usage_Priced row " + matchedPricedRow);
        } else {
          Logger.log("applyCorrection WARNING: chemical \"" + c.name + "\" not found in Usage_Priced headers");
        }
      });
    }
  }

  // ── 3. Apply inventory delta + write to Inventory_Movements ───────────────
  const invSs    = SpreadsheetApp.openById(CORR_INVENTORY_SS_ID);
  const invSheet = invSs.getSheetByName(CORR_INVENTORY_SHEET);
  const movSheet = invSs.getSheetByName("Inventory_Movements");

  const invHeaders = invSheet.getRange(1, 1, 1, invSheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const dispCol = invHeaders.indexOf("display_name");
  const qtyCol  = invHeaders.indexOf("qty_on_hand");
  const unitCol = invHeaders.indexOf("usage_unit");

  const invData = invSheet.getLastRow() >= 2
    ? invSheet.getRange(2, 1, invSheet.getLastRow() - 1, invSheet.getLastColumn()).getValues()
    : [];

  const invMap = {};
  invData.forEach((row, i) => {
    const name = String(row[dispCol] || "").trim();
    if (name) invMap[name] = {
      sheetRow  : i + 2,
      qty       : Number(row[qtyCol] || 0),
      usageUnit : unitCol !== -1 ? String(row[unitCol] || "").trim() : ""
    };
  });

  let movHeaders = [];
  if (movSheet && movSheet.getLastRow() >= 1) {
    movHeaders = movSheet.getRange(1, 1, 1, movSheet.getLastColumn())
      .getValues()[0].map(h => String(h || "").trim());
  }

  const invResults = [];
  const now = new Date();

  changes.forEach(c => {
    const usageDelta = Number(c.newQty) - Number(c.oldQty);
    const invDelta   = -(usageDelta);

    const invItem = invMap[c.name];
    if (!invItem) {
      invResults.push({ name: c.name, applied: false, reason: "Not in Inventory_Master" });
      return;
    }

    const qtyBefore = invItem.qty;
    const qtyAfter  = qtyBefore + invDelta;

    invSheet.getRange(invItem.sheetRow, qtyCol + 1).setValue(qtyAfter);
    invResults.push({ name: c.name, applied: true, before: qtyBefore, after: qtyAfter });

    if (movSheet) {
      const movRowData = movHeaders.length > 0
        ? movHeaders.map(h => {
            switch (h) {
              case "timestamp":    return now;
              case "chemical":     return c.name;
              case "direction":    return "CORRECTION";
              case "qty_change":   return invDelta;
              case "qty_before":   return qtyBefore;
              case "qty_after":    return qtyAfter;
              case "usage_unit":   return invItem.usageUnit;
              case "reason_type":  return "correction";
              case "source_sheet": return CORR_USAGE_LOG;
              case "source_row":   return rowIndex;
              case "reference_id": return "";
              case "notes":        return `Correction by ${correctedBy}: ${c.name} usage ${c.oldQty} → ${c.newQty}`;
              default:             return "";
            }
          })
        : [
            now, c.name, "CORRECTION", invDelta, qtyBefore, qtyAfter,
            invItem.usageUnit, "correction", CORR_USAGE_LOG, rowIndex, "",
            `Correction by ${correctedBy}: ${c.name} usage ${c.oldQty} → ${c.newQty}`
          ];

      movSheet.appendRow(movRowData);
    }
  });

  // ── 4. Write to Corrections_Log ───────────────────────────────────────────
  ensureCorrectionsLog_();
  const logSheet = ss.getSheetByName(CORR_LOG_SHEET);

  changes.forEach(c => {
    const invResult = invResults.find(r => r.name === c.name) || {};
    logSheet.appendRow([
      now, correctedBy, poolId, ts, rowIndex,
      c.name,
      Number(c.oldQty),
      Number(c.newQty),
      Number(c.newQty) - Number(c.oldQty),
      invResult.applied ? "yes" : "no",
      invResult.applied ? invResult.before + " → " + invResult.after : "not found"
    ]);
  });

  // ── 5. Analytics rebuild ──────────────────────────────────────────────────
  try {
    refreshChemicalAnalytics();
  } catch(e) {
    Logger.log("Analytics rebuild warning: " + e);
  }

  return { ok: true, changes: changes.length, invResults };
}

// ─── Corrections_Log sheet setup ─────────────────────────────────────────────
function ensureCorrectionsLog_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CORR_LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CORR_LOG_SHEET);
    sheet.getRange(1, 1, 1, 11).setValues([[
      "corrected_at", "corrected_by", "pool_id", "original_timestamp",
      "log_row_index", "chemical", "old_qty", "new_qty", "delta",
      "inventory_applied", "inventory_change"
    ]]).setFontWeight("bold");
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, 11);
  }
  return sheet;
}

// ─── Get recent corrections for a pool (for history view) ────────────────────
function getCorrectionsHistory(poolId) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CORR_LOG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const data    = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn())
    .getValues();

  const poolCol = headers.indexOf("pool_id");

  return data
    .filter(r => !poolId || String(r[poolCol] || "").trim() === poolId.trim())
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = r[i]; });
      obj.corrected_at        = obj.corrected_at        ? String(obj.corrected_at)        : "";
      obj.original_timestamp  = obj.original_timestamp  ? String(obj.original_timestamp)  : "";
      return obj;
    })
    .reverse() // newest first
    .slice(0, 50);
}