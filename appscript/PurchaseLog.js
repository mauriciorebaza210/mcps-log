// PurchaseLog.gs
// Lives in: Chem Log spreadsheet (Apps Script)
// Manages Purchase_Log and SKU_Map in Inventory Master spreadsheet.

const PL_INVENTORY_SS_ID = "1xPv2oEkJ1KCI3l1LexA4cGH73MM-sWXunQ4fr0wyBSI";
const PL_PURCHASE_LOG    = "Purchase_Log";
const PL_SKU_MAP         = "SKU_Map";
const PL_INVENTORY_SHEET = "Inventory_Master";

const PL_LOG_HEADERS = [
  "invoice_id", "invoice_date", "sku", "description",
  "uom", "qty_ordered", "qty_shipped", "price_per_uom",
  "extended_amount", "display_name", "applied", "applied_at"
];

const PL_INV_DISPLAY_HDR = "display_name";
const PL_INV_QTY_HDR     = "qty_on_hand";

// ─── Sheet setup ──────────────────────────────────────────────────────────────
function ensurePurchaseLogSheets() {
  const ss = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);

  // Purchase_Log
  let plSheet = ss.getSheetByName(PL_PURCHASE_LOG);
  if (!plSheet) {
    plSheet = ss.insertSheet(PL_PURCHASE_LOG);
    plSheet.getRange(1, 1, 1, PL_LOG_HEADERS.length)
      .setValues([PL_LOG_HEADERS])
      .setFontWeight("bold");
    plSheet.setFrozenRows(1);
    plSheet.autoResizeColumns(1, PL_LOG_HEADERS.length);
  }

  // SKU_Map
  let skuSheet = ss.getSheetByName(PL_SKU_MAP);
  if (!skuSheet) {
    skuSheet = ss.insertSheet(PL_SKU_MAP);
    skuSheet.getRange(1, 1, 1, 3)
      .setValues([["sku", "display_name", "notes"]])
      .setFontWeight("bold");
    skuSheet.setFrozenRows(1);

    // Seed with known SKUs — notes must use structured tags for case conversion to work:
    // cat:chemical|sub:pool-chemical|upu:<units-per-container>|unit:<inventory-unit>
    const knownSkus = [
      ["HAS15041",   "Muriatic Acid",             "cat:chemical|sub:pool-chemical|upu:1|unit:gallons"],
      ["MCGEC70064", "Startup-Tec",               "cat:chemical|sub:pool-chemical|upu:8|unit:each"],
      ["MCGEC20064", "ScaleTec (Calcium Remover)","cat:chemical|sub:pool-chemical|upu:8|unit:each"],
      ["MCGEC10064", "Algaecide",                 "cat:chemical|sub:pool-chemical|upu:8|unit:each"],
      ["PBZ88674",   "Calcium Hardness Increaser","cat:chemical|sub:pool-chemical|upu:8|unit:lbs"],
      ["PBZ88673",   "Alkalinity Increaser",      "cat:chemical|sub:pool-chemical|upu:10|unit:lbs"],
      ["HAS01841CS", "Liquid Chlorine",           "cat:chemical|sub:pool-chemical|upu:4|unit:gallons"],
    ];
    skuSheet.getRange(2, 1, knownSkus.length, 3).setValues(knownSkus);
    skuSheet.autoResizeColumns(1, 3);
  }

  return { plSheet, skuSheet };
}

// ─── SKU map lookup ───────────────────────────────────────────────────────────
function buildSkuMap_() {
  const ss    = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);
  const sheet = ss.getSheetByName(PL_SKU_MAP);
  if (!sheet || sheet.getLastRow() < 2) return {};

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  const map  = {};
  data.forEach(r => {
    const sku  = String(r[0] || "").trim().toUpperCase();
    const name = String(r[1] || "").trim();
    if (sku && name) map[sku] = name;
  });
  return map;
}

function writeToPurchaseLog(items) {
  const ss    = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);
  const sheet = ss.getSheetByName(PL_PURCHASE_LOG);
  if (!sheet) return { written: 0, updated: 0, skipped: 0 };

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(String);

  const invIdCol   = headers.indexOf("invoice_id");
  const skuCol     = headers.indexOf("sku");
  const priceCol   = headers.indexOf("price_per_uom");
  const extCol     = headers.indexOf("extended_amount");
  const appliedCol = headers.indexOf("applied");
  const appliedAtCol = headers.indexOf("applied_at");
  const qtyCol     = headers.indexOf("qty_shipped");

  // Build existing key map: "invoice_id|sku" → row index
  const existingMap = {};
  if (sheet.getLastRow() >= 2) {
    const existingData = sheet.getRange(2, 1, sheet.getLastRow() - 1,
      sheet.getLastColumn()).getValues();
    existingData.forEach(function(row, i) {
      const key = String(row[invIdCol]).trim() + "|" +
                  String(row[skuCol]).trim().toUpperCase();
      existingMap[key] = { rowIndex: i + 2, row };
    });
  }

  let written = 0;
  let updated = 0;
  let skipped = 0;

  items.forEach(function(item) {
    const key = String(item.invoice_id || "").trim() + "|" +
                String(item.sku || "").trim().toUpperCase();
    const existing = existingMap[key];

    if (existing) {
      // Row exists — check if we should update price and/or qty independently.
      // These are separate checks (not if/else) so both can fire when a row
      // arrives with price=0 AND qty=0 and the new item has both.
      const existingPrice = Number(existing.row[priceCol] || 0);
      const newPrice      = Number(item.price_per_uom     || 0);
      const existingQty   = Number(existing.row[qtyCol]   || 0);
      const newQty        = Number(item.qty_shipped        || 0);

      let didUpdate = false;

      if (existingPrice === 0 && newPrice > 0) {
        // Use the invoice's own extended_amount — existingQty is already in
        // inventory units (e.g. gallons) while newPrice is per-container, so
        // multiplying them would produce a wildly wrong extended amount.
        sheet.getRange(existing.rowIndex, priceCol + 1).setValue(newPrice);
        const correctExt = Number(item.extended_amount) > 0
          ? Number(item.extended_amount)
          : newPrice * (Number(item.qty_ordered) || existingQty || newQty);
        sheet.getRange(existing.rowIndex, extCol + 1).setValue(correctExt);
        Logger.log("Updated price for " + key + ": $" + newPrice +
                   " | ext: $" + correctExt);
        didUpdate = true;

        // Re-apply to inventory if not yet applied
        if (String(existing.row[appliedCol] || "").toLowerCase() !== "yes") {
          applyPendingPurchases();
        }
      }

      if (existingQty === 0 && newQty > 0) {
        sheet.getRange(existing.rowIndex, qtyCol + 1).setValue(newQty);
        Logger.log("Updated qty for " + key + ": " + newQty);
        didUpdate = true;
      }

      if (didUpdate) {
        updated++;
      } else {
        Logger.log("Skipping duplicate: " + key);
        skipped++;
      }
      return;
    }

    // New row
    const newRow = headers.map(function(h) {
      const map = {
        invoice_id     : item.invoice_id     || "",
        invoice_date   : item.invoice_date   || "",
        sku            : item.sku            || "",
        description    : item.description    || "",
        uom            : item.uom            || "EA",
        qty_ordered    : item.qty_ordered    || 0,
        qty_shipped    : item.qty_shipped    || 0,
        price_per_uom  : item.price_per_uom  || 0,
        extended_amount: item.extended_amount || 0,
        display_name   : item.display_name   || "",
        applied        : "",
        applied_at     : ""
      };
      return map[h] !== undefined ? map[h] : "";
    });

    sheet.appendRow(newRow);
    existingMap[key] = { rowIndex: sheet.getLastRow(), row: newRow };
    written++;
  });

  // Apply any newly written chemical rows
  if (written > 0) {
    applyPendingPurchases();
  }

  // If a PDF arrived and updated prices on a pickup-email order, sync those new prices to Chem_Costs immediately!
  if (updated > 0) {
    try {
      syncChemCosts();
    } catch(e) {
      Logger.log("Error syncing Chem_Costs on PDF update: " + e);
    }
  }

  Logger.log("writeToPurchaseLog: written=" + written +
             " updated=" + updated + " skipped=" + skipped);
  return { written, updated, skipped };
}
function getReferenceParts_(referenceId) {
  const ref = String(referenceId || "").trim();
  const m = ref.match(/^(.+)-(\d{3})$/);
  if (!m) {
    return {
      raw: ref,
      base: ref,
      version: 0,
      hasVersion: false
    };
  }

  return {
    raw: ref,
    base: m[1],
    version: Number(m[2]),
    hasVersion: true
  };
}

function makePurchaseVersionKey_(invoiceId, sku, displayName) {
  const ref = getReferenceParts_(invoiceId);
  const skuKey = String(sku || "").trim().toUpperCase();
  const nameKey = String(displayName || "").trim().toUpperCase();
  return ref.base + "|" + skuKey + "|" + nameKey;
}

// ─── Apply pending rows to Inventory_Master ───────────────────────────────────
function applyPendingPurchases() {
  const ss       = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);
  const plSheet  = ss.getSheetByName(PL_PURCHASE_LOG);
  const invSheet = ss.getSheetByName(PL_INVENTORY_SHEET);

  if (!plSheet || !invSheet) {
    throw new Error("Missing Purchase_Log or Inventory_Master");
  }

  const plLast = plSheet.getLastRow();
  if (plLast < 2) return { applied: 0, reversed: 0, unmapped: [] };

  const plHeaders = plSheet.getRange(1, 1, 1, plSheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());

  const invHeaders = invSheet.getRange(1, 1, 1, invSheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());

  const plInvoiceCol   = plHeaders.indexOf("invoice_id");
  const plSkuCol       = plHeaders.indexOf("sku");
  const plDisplayCol   = plHeaders.indexOf("display_name");
  const plQtyCol       = plHeaders.indexOf("qty_shipped");
  const plAppliedCol   = plHeaders.indexOf("applied");
  const plAppliedAtCol = plHeaders.indexOf("applied_at");

  const invDisplayCol   = invHeaders.indexOf(PL_INV_DISPLAY_HDR);
  const invQtyCol       = invHeaders.indexOf(PL_INV_QTY_HDR);
  const invUsageUnitCol = invHeaders.indexOf("usage_unit");

  if (plInvoiceCol === -1)   throw new Error('Purchase_Log missing "invoice_id"');
  if (plSkuCol === -1)       throw new Error('Purchase_Log missing "sku"');
  if (plDisplayCol === -1)   throw new Error('Purchase_Log missing "display_name"');
  if (plQtyCol === -1)       throw new Error('Purchase_Log missing "qty_shipped"');
  if (plAppliedCol === -1)   throw new Error('Purchase_Log missing "applied"');
  if (plAppliedAtCol === -1) throw new Error('Purchase_Log missing "applied_at"');

  if (invDisplayCol === -1) throw new Error('Inventory_Master missing "display_name"');
  if (invQtyCol === -1)     throw new Error('Inventory_Master missing "qty_on_hand"');

  const plData = plSheet.getRange(2, 1, plLast - 1, plSheet.getLastColumn()).getValues();

  const invLast = invSheet.getLastRow();
  const invData = invLast >= 2
    ? invSheet.getRange(2, 1, invLast - 1, invSheet.getLastColumn()).getValues()
    : [];

  const invMap = {};
  invData.forEach((row, i) => {
    const name = String(row[invDisplayCol] || "").trim();
    if (!name) return;

    invMap[name] = {
      sheetRow: i + 2,
      qty: Number(row[invQtyCol] || 0),
      usageUnit: invUsageUnitCol !== -1 ? String(row[invUsageUnitCol] || "").trim() : ""
    };
  });

  // Find latest row per baseRef + sku + display_name
  const latestByKey = {};
  plData.forEach((row, i) => {
    const invoiceId   = String(row[plInvoiceCol] || "").trim();
    const sku         = String(row[plSkuCol] || "").trim().toUpperCase();
    const displayName = String(row[plDisplayCol] || "").trim();
    const key         = makePurchaseVersionKey_(invoiceId, sku, displayName);
    const refParts    = getReferenceParts_(invoiceId);

    const current = latestByKey[key];
    if (!current || refParts.version > current.version) {
      latestByKey[key] = {
        rowIndex: i + 2,
        version: refParts.version,
        invoiceId: invoiceId
      };
    }
  });

  let appliedCount = 0;
  let reversedCount = 0;
  const unmapped = [];
  const now = new Date();

  plData.forEach((row, i) => {
    const rowIndex     = i + 2;
    const invoiceId    = String(row[plInvoiceCol] || "").trim();
    const sku          = String(row[plSkuCol] || "").trim().toUpperCase();
    const displayName  = String(row[plDisplayCol] || "").trim();
    const qtyShipped   = Number(row[plQtyCol] || 0);
    const appliedState = String(row[plAppliedCol] || "").trim().toLowerCase();

    if (!displayName || !isFinite(qtyShipped) || qtyShipped === 0) return;

    const key = makePurchaseVersionKey_(invoiceId, sku, displayName);
    const latest = latestByKey[key];
    const isLatest = latest && latest.rowIndex === rowIndex;

    const invItem = invMap[displayName];
    if (!invItem) {
      unmapped.push(displayName);
      return;
    }

    // CASE 1: older version was already applied -> reverse it once
    if (!isLatest && appliedState === "yes") {
      const oldQty = invItem.qty;
      const newQty = oldQty - qtyShipped;

      invSheet.getRange(invItem.sheetRow, invQtyCol + 1).setValue(newQty);
      invMap[displayName].qty = newQty;

      plSheet.getRange(rowIndex, plAppliedCol + 1).setValue("superseded");
      plSheet.getRange(rowIndex, plAppliedAtCol + 1).setValue(now);

      logInventoryMovement_({
        timestamp: now,
        chemical: displayName,
        direction: "OUT",
        qty_change: -qtyShipped,
        qty_before: oldQty,
        qty_after: newQty,
        usage_unit: invItem.usageUnit,
        reason_type: "purchase_superseded_reverse",
        source_sheet: PL_PURCHASE_LOG,
        source_row: rowIndex,
        reference_id: invoiceId,
        notes: "Older purchase version reversed because a higher version exists",
        performed_by: "system"
      });

      reversedCount++;
      return;
    }

    // CASE 2: older version never applied -> mark and skip
    if (!isLatest && (appliedState === "" || appliedState === "no")) {
      plSheet.getRange(rowIndex, plAppliedCol + 1).setValue("superseded");
      plSheet.getRange(rowIndex, plAppliedAtCol + 1).setValue(now);
      return;
    }

    // CASE 3: latest version already applied -> leave it alone
    if (isLatest && appliedState === "yes") {
      return;
    }

    // CASE 4: latest version not yet applied -> apply it
    if (isLatest && (appliedState === "" || appliedState === "no")) {
      const oldQty = invItem.qty;
      const newQty = oldQty + qtyShipped;

      invSheet.getRange(invItem.sheetRow, invQtyCol + 1).setValue(newQty);
      invMap[displayName].qty = newQty;

      plSheet.getRange(rowIndex, plAppliedCol + 1).setValue("yes");
      plSheet.getRange(rowIndex, plAppliedAtCol + 1).setValue(now);

      logInventoryMovement_({
        timestamp: now,
        chemical: displayName,
        direction: "IN",
        qty_change: qtyShipped,
        qty_before: oldQty,
        qty_after: newQty,
        usage_unit: invItem.usageUnit,
        reason_type: "purchase_apply",
        source_sheet: PL_PURCHASE_LOG,
        source_row: rowIndex,
        reference_id: invoiceId,
        notes: "Latest Purchase_Log version applied to Inventory_Master",
        performed_by: "system"
      });

      appliedCount++;
    }
  });

  Logger.log("applyPendingPurchases: applied=" + appliedCount +
             " reversed=" + reversedCount +
             " unmapped=" + [...new Set(unmapped)].join(", "));

  if (appliedCount > 0 || reversedCount > 0) {
    try {
      syncChemCosts();
    } catch (e) {
      Logger.log("Error syncing Chem_Costs: " + e.message);
    }
  }

  return {
    applied: appliedCount,
    reversed: reversedCount,
    unmapped: [...new Set(unmapped)]
  };
}

// ─── Date formatter — handles Google Sheets Date objects and plain strings ────
function formatSheetDate_(val) {
  if (!val) return "";
  if (val instanceof Date) {
    return Utilities.formatDate(val, "America/Chicago", "MM/dd/yy");
  }
  // Plain string: take everything before the first space (drops time component if any)
  return String(val).split(" ")[0];
}

// ─── Read Purchase_Log for Admin panel ────────────────────────────────────────
function getPurchaseLog(limitRows) {
  const ss    = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);
  const sheet = ss.getSheetByName(PL_PURCHASE_LOG);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const last    = sheet.getLastRow();
  const limit   = limitRows || 100;
  const start   = Math.max(2, last - limit + 1);
  const numRows = last - start + 1;

  return sheet.getRange(start, 1, numRows, PL_LOG_HEADERS.length)
    .getValues()
    .reverse()
    .map(r => {
      const obj = {};
      PL_LOG_HEADERS.forEach((h, i) => { obj[h] = r[i]; });
      obj.invoice_date = formatSheetDate_(obj.invoice_date);
      obj.applied_at   = formatSheetDate_(obj.applied_at);
      return obj;
    });
}

// ─── Unmapped SKUs ────────────────────────────────────────────────────────────
function getUnmappedSkus() {
  const ss    = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);
  const sheet = ss.getSheetByName(PL_PURCHASE_LOG);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const headers    = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const skuCol     = headers.indexOf("sku");
  const nameCol    = headers.indexOf("display_name");
  const descCol    = headers.indexOf("description");
  const appliedCol = headers.indexOf("applied");
  const skuMap     = buildSkuMap_();

  const data     = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const unmapped = {};

  data.forEach(r => {
    if (String(r[appliedCol] || "").trim().toLowerCase() === "yes") return;
    const sku  = String(r[skuCol]  || "").trim().toUpperCase();
    const name = String(r[nameCol] || "").trim();
    const desc = String(r[descCol] || "").trim();
    if (sku && !name && !skuMap[sku]) unmapped[sku] = desc;
  });

  return Object.keys(unmapped).map(sku => ({ sku, description: unmapped[sku] }));
}

// ─── Save SKU mapping ─────────────────────────────────────────────────────────
function saveSkuMapping(sku, displayName) {
  sku         = String(sku         || "").trim().toUpperCase();
  displayName = String(displayName || "").trim();
  if (!sku || !displayName) return { ok: false, error: "SKU and display name required" };

  ensurePurchaseLogSheets();
  const ss    = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);
  const sheet = ss.getSheetByName(PL_SKU_MAP);

  if (sheet.getLastRow() >= 2) {
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][0] || "").trim().toUpperCase() === sku) {
        sheet.getRange(i + 2, 2).setValue(displayName);
        applyPendingPurchases();
        return { ok: true };
      }
    }
  }

  sheet.appendRow([sku, displayName, ""]);
  applyPendingPurchases();
  return JSON.stringify({ ok: true });
}

// ─── Sync Purchase Costs to Chem_Costs ────────────────────────────────────────
function syncChemCosts() {
  const invSs   = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);
  const plSheet = invSs.getSheetByName(PL_PURCHASE_LOG);
  if (!plSheet || plSheet.getLastRow() < 2) return;

  const plData  = plSheet.getDataRange().getValues();
  const headers = plData[0].map(h => String(h || "").trim());
  const nameCol = headers.indexOf("display_name");
  const uomCol  = headers.indexOf("uom");
  const priceCol= headers.indexOf("price_per_uom");
  const qtyCol  = headers.indexOf("qty_shipped");
  const extCol  = headers.indexOf("extended_amount");

  const latestCosts = {};
  for (let i = 1; i < plData.length; i++) {
    const row  = plData[i];
    const name = String(row[nameCol] || "").trim();
    if (!name) continue;

    const uom = String(row[uomCol] || "").toUpperCase().trim();
    const price = Number(row[priceCol] || 0);
    const ext = Number(row[extCol] || 0);
    const qty = Number(row[qtyCol] || 0);

    let unitCost = 0;
    // Billed as individual loose units — price per UOM is the raw cost.
    if (price > 0 && ["EA", "GAL", "LB", "LBS", "EACH", "BOTTLES", "TABLETS"].includes(uom)) {
      unitCost = price;
    } 
    // Billed as cases/bags — safely calculate ratio mapping.
    else if (qty > 0 && ext > 0) {
      unitCost = ext / qty; 
    }

    if (unitCost > 0) {
      latestCosts[name] = unitCost; 
    }
  }

  const ss         = SpreadsheetApp.getActiveSpreadsheet();
  const costsSheet = ss.getSheetByName("Chem_Costs");
  if (!costsSheet || costsSheet.getLastRow() < 2) return;

  const costData    = costsSheet.getDataRange().getValues();
  const costHeaders = costData[0].map(h => String(h || "").trim());
  const chemIdx     = costHeaders.indexOf("Chemical");
  const cpuIdx      = costHeaders.indexOf("Cost per Unit");

  if (chemIdx === -1 || cpuIdx === -1) {
    Logger.log("Missing Chemical or Cost per Unit column in Chem_Costs");
    return;
  }

  let updated = 0;
  for (let i = 1; i < costData.length; i++) {
    const chem = String(costData[i][chemIdx] || "").trim();
    if (latestCosts[chem] !== undefined) {
      const newCpu = latestCosts[chem];
      const oldCpu = Number(costData[i][cpuIdx] || 0);

      // Only write if price changes by a fraction of a cent
      if (Math.abs(newCpu - oldCpu) > 0.005) {
        costsSheet.getRange(i + 1, cpuIdx + 1).setValue(newCpu);
        updated++;
      }
    }
  }
  Logger.log("syncChemCosts: Updated " + updated + " chemical costs");
}

// ─── Display names for SKU mapping dropdown ───────────────────────────────────
function getInventoryDisplayNames() {
  const ss    = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);
  const sheet = ss.getSheetByName(PL_INVENTORY_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const dispCol = headers.indexOf(PL_INV_DISPLAY_HDR);
  if (dispCol === -1) return [];

  return sheet.getRange(2, dispCol + 1, sheet.getLastRow() - 1, 1)
    .getValues().flat()
    .map(v => String(v || "").trim())
    .filter(Boolean)
    .sort();
}

// ─── Manual apply (called from Admin panel) ───────────────────────────────────
function manualApplyPurchases() {
  ensurePurchaseLogSheets();
  return applyPendingPurchases();
}

// ─── One-time repair: write correct structured tags into existing SKU_Map rows ──
// Run once from the Apps Script editor after deploying this change.
// Safe to re-run — only overwrites rows whose notes don't already have the right tags.
function REPAIR_skuMapNotes() {
  const corrections = {
    "HAS15041"  : "cat:chemical|sub:pool-chemical|upu:1|unit:gallons",
    "MCGEC70064": "cat:chemical|sub:pool-chemical|upu:8|unit:each",
    "MCGEC20064": "cat:chemical|sub:pool-chemical|upu:8|unit:each",
    "MCGEC10064": "cat:chemical|sub:pool-chemical|upu:8|unit:each",
    "PBZ88674"  : "cat:chemical|sub:pool-chemical|upu:8|unit:lbs",
    "PBZ88673"  : "cat:chemical|sub:pool-chemical|upu:10|unit:lbs",
    "HAS01841CS": "cat:chemical|sub:pool-chemical|upu:4|unit:gallons",
  };

  const ss    = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);
  const sheet = ss.getSheetByName(PL_SKU_MAP);
  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log("REPAIR_skuMapNotes: no rows to repair");
    return;
  }

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  let updated = 0;

  data.forEach(function(row, i) {
    const sku = String(row[0] || "").trim().toUpperCase();
    if (!sku || !corrections[sku]) return;

    const correct = corrections[sku];
    if (String(row[2] || "").trim() !== correct) {
      sheet.getRange(i + 2, 3).setValue(correct);
      Logger.log("REPAIR_skuMapNotes: fixed " + sku);
      updated++;
    }
  });

  Logger.log("REPAIR_skuMapNotes: " + updated + " SKU(s) updated");
  SpreadsheetApp.getActiveSpreadsheet()
    .toast("✅ SKU_Map repaired — " + updated + " SKU(s) updated", "MCPS");
}

function REPAIR_purchaseVersions() {
  const ss = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);
  const sheet = ss.getSheetByName(PL_PURCHASE_LOG);
  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log("No Purchase_Log rows to repair");
    return;
  }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());

  const appliedCol = headers.indexOf("applied");
  if (appliedCol === -1) throw new Error('Purchase_Log missing "applied"');

  // Turn "superseded" rows back to "yes" only if you want a full re-evaluation of already applied rows.
  // Here we leave existing yes rows as-is and let applyPendingPurchases reverse outdated ones.
  const result = applyPendingPurchases();
  Logger.log("REPAIR_purchaseVersions result: " + JSON.stringify(result));
}