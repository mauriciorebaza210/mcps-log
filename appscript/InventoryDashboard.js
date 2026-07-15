// InventoryDashboard.gs
// Lives in the INVENTORY spreadsheet project.

const INV_DASH_SHEET_NAME = "Inventory_Dashboard";
const INV_MASTER_SHEET_NAME = "Inventory_Master";
const INV_MOVEMENT_SHEET_NAME = "Inventory_Movements";
const INV_SUMMARY_EMAIL = "mauricio@mcpoolsolutions.org";

function ensureInventoryDashboardSheet_() {
  const ss = SpreadsheetApp.openById("1xPv2oEkJ1KCI3l1LexA4cGH73MM-sWXunQ4fr0wyBSI");
  let sheet = ss.getSheetByName(INV_DASH_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(INV_DASH_SHEET_NAME);
  }

  return sheet;
}

function refreshInventoryDashboardFromChemLog() {
  const ss = SpreadsheetApp.openById("1xPv2oEkJ1KCI3l1LexA4cGH73MM-sWXunQ4fr0wyBSI");
  const invSheet = ss.getSheetByName(INV_MASTER_SHEET_NAME);
  if (!invSheet) throw new Error(`Missing sheet: ${INV_MASTER_SHEET_NAME}`);

  const dash = ensureInventoryDashboardSheet_();
  const movSheet = ss.getSheetByName(INV_MOVEMENT_SHEET_NAME);

  const invData = invSheet.getDataRange().getValues();
  if (invData.length < 2) throw new Error("Inventory_Master has no data rows");

  const headers = invData[0].map(h => String(h || "").trim());
  const rows = invData.slice(1);

  const col = name => headers.indexOf(name);

  const nameCol   = col("display_name");
  const unitCol   = col("usage_unit");
  const qtyCol    = col("qty_on_hand");
  const reorderCol= col("reorder_level");
  const targetCol = col("target_level");

  if (nameCol === -1) throw new Error('Inventory_Master missing "display_name"');
  if (qtyCol === -1) throw new Error('Inventory_Master missing "qty_on_hand"');
  if (unitCol === -1) throw new Error('Inventory_Master missing "usage_unit"');

  // Read movements if available
  let movementMap = {};
  let usedThisWeekMap = {};
  let purchasedThisWeekMap = {};
  let netThisWeekMap = {};

  if (movSheet && movSheet.getLastRow() >= 2) {
    const movData = movSheet.getDataRange().getValues();
    const mh = movData[0].map(h => String(h || "").trim());
    const mrows = movData.slice(1);

    const mCol = name => mh.indexOf(name);

    const tsCol       = mCol("timestamp");
    const chemCol     = mCol("chemical");
    const dirCol      = mCol("direction");
    const qtyChangeCol= mCol("qty_change");
    const afterCol    = mCol("qty_after");
    const reasonCol   = mCol("reason_type");

    const now = new Date();
    const weekStart = getWeekStartForDashboard_(now);

    mrows.forEach(r => {
      const chem = String(r[chemCol] || "").trim();
      if (!chem) return;

      const ts = tsCol !== -1 ? new Date(r[tsCol]) : null;
      const dir = dirCol !== -1 ? String(r[dirCol] || "").trim() : "";
      const qtyChange = qtyChangeCol !== -1 ? Number(r[qtyChangeCol] || 0) : 0;
      const qtyAfter = afterCol !== -1 ? r[afterCol] : "";
      const reason = reasonCol !== -1 ? String(r[reasonCol] || "").trim() : "";

      // last movement
      if (!movementMap[chem]) {
        movementMap[chem] = {
          timestamp: ts,
          direction: dir,
          qtyChange: qtyChange,
          qtyAfter: qtyAfter,
          reason: reason
        };
      } else if (ts && movementMap[chem].timestamp && ts > movementMap[chem].timestamp) {
        movementMap[chem] = {
          timestamp: ts,
          direction: dir,
          qtyChange: qtyChange,
          qtyAfter: qtyAfter,
          reason: reason
        };
      }

      if (ts && ts >= weekStart) {
        netThisWeekMap[chem] = (netThisWeekMap[chem] || 0) + qtyChange;

        if (dir === "OUT") {
          usedThisWeekMap[chem] = (usedThisWeekMap[chem] || 0) + Math.abs(qtyChange);
        } else if (dir === "IN") {
          purchasedThisWeekMap[chem] = (purchasedThisWeekMap[chem] || 0) + qtyChange;
        }
      }
    });
  }

  const outHeaders = [
    "Chemical",
    "Current Stock",
    "Usage Unit",
    "Reorder Level",
    "Target Level",
    "Status",
    "Gap to Target",
    "Used This Week",
    "Purchased This Week",
    "Net This Week",
    "Last Movement",
    "Last Direction",
    "Last Qty Change",
    "Last Reason"
  ];

  const out = [outHeaders];

  rows.forEach(r => {
    const chemical = String(r[nameCol] || "").trim();
    if (!chemical) return;

    const currentStock = Number(r[qtyCol] || 0);
    const usageUnit = String(r[unitCol] || "").trim();
    const reorderLevel = reorderCol !== -1 ? Number(r[reorderCol] || 0) : "";
    const targetLevel = targetCol !== -1 ? Number(r[targetCol] || 0) : "";

    let status = "OK";
    if (currentStock <= 0) {
      status = "OUT";
    } else if (reorderCol !== -1 && currentStock <= reorderLevel) {
      status = "LOW";
    }

    const gapToTarget = targetCol !== -1 ? (targetLevel - currentStock) : "";

    const lastMove = movementMap[chemical] || {};
    const usedThisWeek = usedThisWeekMap[chemical] || 0;
    const purchasedThisWeek = purchasedThisWeekMap[chemical] || 0;
    const netThisWeek = netThisWeekMap[chemical] || 0;

    out.push([
      chemical,
      currentStock,
      usageUnit,
      reorderLevel,
      targetLevel,
      status,
      gapToTarget,
      usedThisWeek,
      purchasedThisWeek,
      netThisWeek,
      lastMove.timestamp || "",
      lastMove.direction || "",
      lastMove.qtyChange || "",
      lastMove.reason || ""
    ]);
  });

  // Sort by status priority, then chemical
  const body = out.slice(1).sort((a, b) => {
    const rank = s => s === "OUT" ? 0 : s === "LOW" ? 1 : 2;
    const statusCompare = rank(a[5]) - rank(b[5]);
    if (statusCompare !== 0) return statusCompare;
    return String(a[0]).localeCompare(String(b[0]));
  });

  dash.clear();
  dash.getRange(1, 1, 1, outHeaders.length).setValues([outHeaders]);
  if (body.length) {
    dash.getRange(2, 1, body.length, outHeaders.length).setValues(body);
  }

  dash.setFrozenRows(1);
  dash.getRange(1, 1, 1, outHeaders.length).setFontWeight("bold");

  // Number formats
  const lastRow = dash.getLastRow();
  if (lastRow >= 2) {
    dash.getRange(2, 2, lastRow - 1, 1).setNumberFormat("0.00");
    dash.getRange(2, 4, lastRow - 1, 2).setNumberFormat("0.00");
    dash.getRange(2, 7, lastRow - 1, 4).setNumberFormat("0.00");
    dash.getRange(2, 11, lastRow - 1, 1).setNumberFormat("m/d/yyyy h:mm am/pm");
  }

  // Conditional styling
  if (lastRow >= 2) {
    const statusRange = dash.getRange(2, 6, lastRow - 1, 1);
    const statuses = statusRange.getValues();

    for (let i = 0; i < statuses.length; i++) {
      const row = i + 2;
      const status = String(statuses[i][0] || "").trim();

      if (status === "OUT") {
        dash.getRange(row, 1, 1, outHeaders.length).setBackground("#fce8e6");
      } else if (status === "LOW") {
        dash.getRange(row, 1, 1, outHeaders.length).setBackground("#fef7e0");
      } else {
        dash.getRange(row, 1, 1, outHeaders.length).setBackground("#e6f4ea");
      }
    }
  }

  dash.autoResizeColumns(1, outHeaders.length);

  SpreadsheetApp.getActiveSpreadsheet().toast(
    "Inventory dashboard refreshed",
    "MCPS"
  );
}

function getWeekStartForDashboard_(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 Sun
  const diff = -day; // Sunday start
  d.setDate(d.getDate() + diff);
  return d;
}