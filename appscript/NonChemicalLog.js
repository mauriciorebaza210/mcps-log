// NonChemicalLog.gs
// Manages Non_Chemical_Log sheet in Inventory Master.

const NON_CHEM_LOG_SHEET = "Non_Chemical_Log";

const NON_CHEM_HEADERS = [
  "date", "invoice_id", "sku", "description",
  "category", "sub_category", "display_name",
  "qty", "uom", "unit_price", "extended_amount", "vendor"
];

// ─── Ensure sheet exists ──────────────────────────────────────────────────────
function ensureNonChemicalLog() {
  const ss    = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);
  let sheet   = ss.getSheetByName(NON_CHEM_LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(NON_CHEM_LOG_SHEET);
    sheet.getRange(1, 1, 1, NON_CHEM_HEADERS.length)
      .setValues([NON_CHEM_HEADERS])
      .setFontWeight("bold");
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, NON_CHEM_HEADERS.length);
  }
  return sheet;
}

// ─── Write rows to Non_Chemical_Log ──────────────────────────────────────────
function writeToNonChemicalLog_(items) {
  const sheet = ensureNonChemicalLog();

  const rows = items.map(function(item) {
    return NON_CHEM_HEADERS.map(function(h) {
      return item[h] !== undefined ? item[h] : "";
    });
  });

  if (!rows.length) return { written: 0 };

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, NON_CHEM_HEADERS.length)
    .setValues(rows);

  Logger.log("Non_Chemical_Log: wrote " + rows.length + " row(s)");
  return { written: rows.length };
}

// ─── Read recent non-chemical purchases for Admin panel ───────────────────────
function getNonChemicalLog(limitRows) {
  const ss    = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);
  const sheet = ss.getSheetByName(NON_CHEM_LOG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const last  = sheet.getLastRow();
  const limit = limitRows || 50;
  const start = Math.max(2, last - limit + 1);

  return sheet.getRange(start, 1, last - start + 1, NON_CHEM_HEADERS.length)
    .getValues()
    .reverse()
    .map(function(r) {
      const obj = {};
      NON_CHEM_HEADERS.forEach(function(h, i) { obj[h] = r[i]; });
      obj.date = obj.date ? String(obj.date).split(" ")[0] : "";
      return obj;
    });
}