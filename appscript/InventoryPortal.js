// ─── Manual qty correction from portal ───────────────────────────────────────
function setInventoryQty_(chemicalName, newQty, performedBy) {
  chemicalName = String(chemicalName || "").trim();
  newQty       = Number(newQty);
  if (!chemicalName) return { ok: false, error: "Chemical name required" };
  if (isNaN(newQty) || newQty < 0) return { ok: false, error: "Invalid quantity" };

  const ss    = SpreadsheetApp.openById("1xPv2oEkJ1KCI3l1LexA4cGH73MM-sWXunQ4fr0wyBSI");
  const sheet = ss.getSheetByName("Inventory_Master");
  if (!sheet) return { ok: false, error: "Inventory_Master not found" };

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const nameCol    = headers.indexOf("display_name");
  const qtyCol     = headers.indexOf("qty_on_hand");
  const unitCol    = headers.indexOf("usage_unit");
  if (nameCol === -1 || qtyCol === -1) return { ok: false, error: "Inventory_Master schema error" };

  if (sheet.getLastRow() < 2) return { ok: false, error: "Chemical not found: " + chemicalName };

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const rowIdx = data.findIndex(r => String(r[nameCol] || "").trim() === chemicalName);
  if (rowIdx === -1) return { ok: false, error: "Chemical not found: " + chemicalName };

  const sheetRow = rowIdx + 2;
  const oldQty   = Number(data[rowIdx][qtyCol] || 0);
  const unit     = unitCol !== -1 ? String(data[rowIdx][unitCol] || "").trim() : "";

  sheet.getRange(sheetRow, qtyCol + 1).setValue(newQty);

  logInventoryMovement_({
    timestamp   : new Date(),
    chemical    : chemicalName,
    direction   : newQty >= oldQty ? "IN" : "OUT",
    qty_change  : newQty - oldQty,
    qty_before  : oldQty,
    qty_after   : newQty,
    usage_unit  : unit,
    reason_type : "correction",
    source_sheet: "Portal_Manual_Edit",
    source_row  : sheetRow,
    reference_id: "",
    notes       : "Manual qty correction via portal",
    performed_by: (typeof performedBy === "object"
      ? (performedBy.name || performedBy.username || "admin")
      : String(performedBy || "admin"))
  });

  return { ok: true, old_qty: oldQty, new_qty: newQty };
}

function getInventoryForPortal_() {
  try {
    const ss    = SpreadsheetApp.openById("1xPv2oEkJ1KCI3l1LexA4cGH73MM-sWXunQ4fr0wyBSI");
    const sheet = ss.getSheetByName("Inventory_Master");
    if (!sheet || sheet.getLastRow() < 2) return { ok: true, data: [] };

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0].map(h => String(h || "").trim());
    const data    = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();

    const nameCol   = headers.indexOf("display_name");
    const unitCol   = headers.indexOf("usage_unit");
    const qtyCol    = headers.indexOf("qty_on_hand");
    const reorderCol= headers.indexOf("reorder_level");
    const targetCol = headers.indexOf("target_level");

    const items = data.map(r => {
      const name = String(r[nameCol] || "").trim();
      if (!name) return null;
      const qty    = Number(r[qtyCol]    || 0);
      const reorder= reorderCol !== -1 ? Number(r[reorderCol] || 0) : 0;
      const target = targetCol  !== -1 ? Number(r[targetCol]  || 0) : 0;
      let status = qty <= 0 ? "OUT" : (reorder > 0 && qty <= reorder) ? "LOW" : "OK";
      return { name, unit: unitCol !== -1 ? String(r[unitCol] || "").trim() : "",
               qty, reorder_level: reorder, target_level: target, status };
    }).filter(Boolean).sort((a, b) => {
      const rank = s => s === "OUT" ? 0 : s === "LOW" ? 1 : 2;
      const sc = rank(a.status) - rank(b.status);
      return sc !== 0 ? sc : a.name.localeCompare(b.name);
    });

    return { ok: true, data: items };
  } catch(e) {
    return { ok: false, error: String(e) };
  }
}
