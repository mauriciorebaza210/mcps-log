// UnmatchedSubmissions.gs
// Handles form submissions where operator selected "Other / Pool not listed"

const UNMATCHED_SHEET       = "Unmatched_Submissions";
const OTHER_POOL_VALUE      = "Other / Pool not listed";
const POOL_DESC_COLUMN      = "Pool description (if Other selected)";
const ALERT_EMAIL           = "mauricio@mcpoolsolutions.org";
const CRM_SS_ID             = "1fw2qMdWnNbYlb3F6wM3A69CMDlymYVd2uhOF_iPoB6E";

function safeIso_(v) {
  if (!v) return "";
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toISOString();
}

// ─── Called from snapshotUsageToPriced when pool_id = Other ──────────────────
function flagUnmatchedSubmission(rawRow, rawHeaders, logRowIndex, pricedRowIndex) {
  ensureUnmatchedSheet();
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(UNMATCHED_SHEET);

  const get = function(header) {
    const idx = rawHeaders.indexOf(header);
    if (idx === -1) return "";
    const val = rawRow[idx];
    return String(val !== undefined && val !== null && val !== "" ? val : "").trim();
  };

  const ts          = get("Timestamp");
  const poolDesc    = get(POOL_DESC_COLUMN);
  const technician  = get("Technician");
  const notes       = get("Notes");

  // Collect chemicals used
  const nonChem = new Set([
    "Timestamp","pool_id","Technician","Notes","Client Name","Address",
    "Service Type","Month","Visit # in Month","Week Start","WeekKey",
    "MonthKey","Visit # in Week","Total Visit Chem Cost (Snapshot)",
    "Free Chlorine (FC)","pH","Total Alkalinity (TA)","Calcium Hardness (CH)",
    POOL_DESC_COLUMN
  ]);

  const chemsUsed = [];
  rawHeaders.forEach(function(h, i) {
    if (!h || nonChem.has(h)) return;
    if (h.endsWith(" Unit Cost (Snapshot)")) return;
    const qty = Number(rawRow[i]);
    if (isFinite(qty) && qty > 0) chemsUsed.push(h + ": " + qty);
  });

  sheet.appendRow([
    new Date(),
    ts,
    technician,
    notes,
    poolDesc,
    chemsUsed.join(", "),
    logRowIndex,
    pricedRowIndex,
    "pending"
  ]);

  // Email alert
  try {
    const subject = "⚠️ MCPS — Unmatched pool submission from " + technician;
    const body = [
      "An operator submitted a visit log with 'Other / Pool not listed'.",
      "",
      "Technician: " + technician,
      "Time: " + ts,
      "Notes: " + notes,
      "Pool description: " + (poolDesc || "(none entered)"),
      "Chemicals used: " + (chemsUsed.join(", ") || "none"),
      "",
      "Log in to Chem Log and open Chem Admin → Unmatched tab to assign this to the correct pool.",
    ].join("\n");

    GmailApp.sendEmail(ALERT_EMAIL, subject, body);
    Logger.log("Alert email sent for unmatched submission");
  } catch(e) {
    Logger.log("Email send failed: " + e);
  }
}

// ─── Get all pending unmatched submissions ────────────────────────────────────
function getUnmatchedSubmissions() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(UNMATCHED_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const data    = sheet.getRange(2, 1, sheet.getLastRow() - 1,
    sheet.getLastColumn()).getValues();

  return data
    .map(function(r, i) {
      const obj = { rowIndex: i + 2 };
      headers.forEach(function(h, j) { obj[h] = r[j]; });
      obj.flagged_at = safeIso_(obj.flagged_at);
      obj.timestamp  = safeIso_(obj.timestamp);
      return obj;
    })
    .filter(function(r) { return r.status === "pending"; });
}

// ─── Get all pools for matching dropdown ──────────────────────────────────────
function getAllPoolsForMatching() {
  const crmSs = SpreadsheetApp.openById(CRM_SS_ID);
  const pools = [];

  ["Signed_Customers", "Completed_One_Time"].forEach(function(sheetName) {
    const sheet = crmSs.getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() < 2) return;

    const hdrs = sheet.getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0].map(h => String(h || "").trim().toLowerCase());

    const pidCol  = hdrs.indexOf("pool_id");
    const lastCol = hdrs.indexOf("last_name");
    const svcCol  = hdrs.indexOf("service");
    const adrCol  = hdrs.indexOf("address");

    if (pidCol === -1) return;

    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn())
      .getValues().forEach(function(row) {
        const pid   = String(row[pidCol]  || "").trim();
        const last  = String(row[lastCol] || "").trim();
        const svc   = String(row[svcCol]  || "").trim();
        const adr   = String(row[adrCol]  || "").trim();
        if (pid) pools.push({
          poolId : pid,
          label  : last + " - " + svc + " - " + adr + " - " + pid,
          source : sheetName
        });
      });
  });

  return pools.sort(function(a, b) { return a.label.localeCompare(b.label); });
}

// ─── Resolve an unmatched submission ─────────────────────────────────────────
function resolveUnmatchedSubmission(rowIndex, matchedPoolId, resolvedBy) {
  matchedPoolId = String(matchedPoolId || "").trim();
  resolvedBy    = String(resolvedBy    || "unknown").trim();
  if (!matchedPoolId) return { ok: false, error: "Select a pool to match" };

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(UNMATCHED_SHEET);

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const row     = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn())
    .getValues()[0];
  const col     = name => headers.indexOf(name);

  const logRowIdx    = Number(row[col("log_row_index")]    || 0);
  const pricedRowIdx = Number(row[col("priced_row_index")] || 0);

  if (!logRowIdx) return { ok: false, error: "No log row index found" };

  // 1. Update Chemical_Usage_Log pool_id
  const usageSheet = ss.getSheetByName("Chemical_Usage_Log");
  if (usageSheet) {
    const usageHdrs = usageSheet.getRange(1, 1, 1, usageSheet.getLastColumn())
      .getValues()[0].map(h => String(h || "").trim());
    const poolCol   = usageHdrs.indexOf("pool_id");
    if (poolCol !== -1) {
      usageSheet.getRange(logRowIdx, poolCol + 1).setValue(matchedPoolId);
    }
  }

  // 2. Update Usage_Priced pool_id
  const pricedSheet = ss.getSheetByName("Usage_Priced");
  if (pricedSheet && pricedRowIdx > 0) {
    const pricedHdrs = pricedSheet.getRange(1, 1, 1, pricedSheet.getLastColumn())
      .getValues()[0].map(h => String(h || "").trim());
    const pPoolCol   = pricedHdrs.indexOf("pool_id");
    if (pPoolCol !== -1) {
      pricedSheet.getRange(pricedRowIdx, pPoolCol + 1).setValue(matchedPoolId);
    }
  }

  // 3. Rebuild analytics
  try { refreshChemicalAnalytics(); } catch(e) {
    Logger.log("Analytics refresh warning: " + e);
  }

  // 4. Mark resolved
  const statusCol   = col("status") + 1;
  const resolvedCol = col("resolved_by") + 1;
  const resolvedAt  = col("resolved_at") + 1;
  sheet.getRange(rowIndex, statusCol).setValue("resolved");
  if (resolvedCol > 0) sheet.getRange(rowIndex, resolvedCol).setValue(resolvedBy);
  if (resolvedAt  > 0) sheet.getRange(rowIndex, resolvedAt).setValue(new Date());
  // Send the visit report now that we have the pool_id
  try {
    sendVisitReportForUnmatched(logRowIdx, matchedPoolId);
  } catch(e) {
    Logger.log("Visit report after resolve error: " + e);
  }

  return { ok: true };
}

// ─── Ensure Unmatched_Submissions sheet exists ────────────────────────────────
function ensureUnmatchedSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(UNMATCHED_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(UNMATCHED_SHEET);
    sheet.getRange(1, 1, 1, 9).setValues([[
      "flagged_at", "timestamp", "technician", "notes",
      "pool_description", "chemicals_used",
      "log_row_index", "priced_row_index", "status"
    ]]).setFontWeight("bold");
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, 9);
  }
  return sheet;
}