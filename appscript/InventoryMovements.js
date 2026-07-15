// InventoryMovements.gs
// Ledger of every inventory increase/decrease in Inventory_Master.

const INV_MOVEMENT_SS_ID   = "1xPv2oEkJ1KCI3l1LexA4cGH73MM-sWXunQ4fr0wyBSI";
const INV_MOVEMENT_SHEET   = "Inventory_Movements";

const INV_MOVEMENT_HEADERS = [
  "timestamp",
  "chemical",
  "direction",
  "qty_change",
  "qty_before",
  "qty_after",
  "usage_unit",
  "reason_type",
  "source_sheet",
  "source_row",
  "reference_id",
  "notes",
  "performed_by"
];

function ensureInventoryMovementsSheet_() {
  const ss = SpreadsheetApp.openById(INV_MOVEMENT_SS_ID);
  let sheet = ss.getSheetByName(INV_MOVEMENT_SHEET);

  if (!sheet) {
    sheet = ss.insertSheet(INV_MOVEMENT_SHEET);
    sheet.getRange(1, 1, 1, INV_MOVEMENT_HEADERS.length)
      .setValues([INV_MOVEMENT_HEADERS])
      .setFontWeight("bold");
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, INV_MOVEMENT_HEADERS.length);
  }

  return sheet;
}

function logInventoryMovement_(entry) {
  const sheet = ensureInventoryMovementsSheet_();

  const qtyChange = Number(entry.qty_change || 0);
  const qtyBefore = Number(entry.qty_before || 0);
  const qtyAfter  = Number(entry.qty_after || 0);

  sheet.appendRow([
    entry.timestamp || new Date(),
    String(entry.chemical || "").trim(),
    String(entry.direction || "").trim(),      // IN / OUT
    qtyChange,
    qtyBefore,
    qtyAfter,
    String(entry.usage_unit || "").trim(),
    String(entry.reason_type || "").trim(),    // usage_submit / purchase_apply / correction / void / manual_adjustment
    String(entry.source_sheet || "").trim(),
    entry.source_row || "",
    String(entry.reference_id || "").trim(),
    String(entry.notes || "").trim(),
    String(entry.performed_by || "system").trim()
  ]);
}
