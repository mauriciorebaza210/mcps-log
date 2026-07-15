// SkuCategorizer.gs
// Uses Claude API to categorize unknown SKUs from Heritage invoices.
// Queues results for review in Orders tab before applying.

const SKU_PENDING_SHEET = "SKU_Pending_Review";

// ─── Main categorizer ─────────────────────────────────────────────────────────
function categorizeSku(sku, description) {
  sku         = String(sku         || "").trim().toUpperCase();
  description = String(description || "").trim();

  const apiKey = PropertiesService.getScriptProperties()
    .getProperty("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set in Script Properties");

  const prompt = [
    "You are a pool supply inventory classifier for a pool service company.",
    "Given a Heritage Pool Supply SKU and product description, classify it.",
    "",
    "SKU: " + sku,
    // Replace with:
    "Description: " + description,
    "",
    "IMPORTANT: If the description mentions a weight (e.g. '50 LB', '8 LB', '10 LB'),",
    "set units_per_sku to that weight value and usage_unit to 'lbs'.",
    "If it mentions gallons (e.g. '1 GALLON', '4 GALLONS/CASE'), set units_per_sku",
    "to the total gallons and usage_unit to 'gallons'.",
    "The qty in the invoice is always the number of containers purchased,",
    "not the usage quantity.",
    "",
    "Respond with ONLY a JSON object, no other text:",
    "{",
    '  "category": "chemical" or "non-chemical",',
    '  "sub_category": one of: "pool-chemical", "equipment", "parts", "consumable",',
    '  "display_name": "clean short product name (max 40 chars)",',
    '  "units_per_sku": number (how many usage units per purchased unit, default 1),',
    '  "usage_unit": "the unit used when tracking (e.g. gallons, lbs, tablets, each)",',
    '  "confidence": "high", "medium", or "low",',
    '  "reason": "one sentence explanation"',
    "}"
  ].join("\n");

  const response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method     : "POST",
    headers    : {
      "x-api-key"        : apiKey,
      "anthropic-version": "2023-06-01",
      "content-type"     : "application/json"
    },
    payload: JSON.stringify({
      model     : "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages  : [{ role: "user", content: prompt }]
    }),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code !== 200) {
    throw new Error("Claude API error " + code + ": " + body.substring(0, 200));
  }

  const data    = JSON.parse(body);
  const text    = data.content[0].text.trim();

  // Strip markdown fences if present
  const clean   = text.replace(/```json|```/g, "").trim();
  const result  = JSON.parse(clean);

  Logger.log("Categorized " + sku + ": " + JSON.stringify(result));
  return result;
}

// ─── Queue a SKU for review ───────────────────────────────────────────────────
function queueSkuForReview(sku, description, invoiceId, invoiceDate,
                            qty, uom, pricePerUom, extendedAmount, aiResult) {
  const ss    = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);
  let sheet   = ss.getSheetByName(SKU_PENDING_SHEET);

  if (!sheet) {
    sheet = ss.insertSheet(SKU_PENDING_SHEET);
    sheet.getRange(1, 1, 1, 17).setValues([[
      "queued_at", "sku", "description", "invoice_id", "invoice_date",
      "qty_shipped", "uom", "price_per_uom", "extended_amount",
      "ai_category", "ai_sub_category", "ai_display_name",
      "ai_units_per_sku", "ai_usage_unit", "ai_confidence", "ai_reason", "status"
    ]]).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }

  // Don't re-queue the exact same sku+invoice combination — but allow the same
  // SKU from a different invoice so its qty/price aren't silently dropped.
  // Columns (0-indexed from col 2): sku=0, description=1, invoice_id=2 ... status=15
  if (sheet.getLastRow() >= 2) {
    const existingData = sheet.getRange(2, 2, sheet.getLastRow() - 1, 16).getValues();
    const alreadyQueued = existingData.some(function(r) {
      return String(r[0]  || "").trim().toUpperCase() === sku &&
             String(r[2]  || "").trim() === String(invoiceId || "").trim() &&
             String(r[15] || "").trim() === "pending";
    });
    if (alreadyQueued) {
      Logger.log("SKU already pending for this invoice — skipping: " + sku + " / " + invoiceId);
      return;
    }
  }

  sheet.appendRow([
    new Date(),           // queued_at
    sku,                  // sku
    description,          // description
    invoiceId,            // invoice_id
    invoiceDate,          // invoice_date
    qty,                  // qty_shipped
    uom,                  // uom
    pricePerUom,          // price_per_uom
    extendedAmount,       // extended_amount
    aiResult.category      || "",  // ai_category
    aiResult.sub_category  || "",  // ai_sub_category
    aiResult.display_name  || "",  // ai_display_name
    aiResult.units_per_sku || 1,   // ai_units_per_sku
    aiResult.usage_unit    || "each", // ai_usage_unit
    aiResult.confidence    || "low",  // ai_confidence
    aiResult.reason        || "",     // ai_reason
    "pending"             // status
  ]);

  Logger.log("Queued for review: " + sku);
}

// ─── Get pending SKUs for Admin panel ─────────────────────────────────────────
function getPendingSkus() {
  const ss    = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);
  const sheet = ss.getSheetByName(SKU_PENDING_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const data    = sheet.getRange(2, 1, sheet.getLastRow() - 1,
    sheet.getLastColumn()).getValues();

  return data
    .map(function(r, i) {
      const obj = { rowIndex: i + 2 };
      headers.forEach(function(h, j) { obj[h] = r[j]; });
      obj.queued_at    = obj.queued_at    ? String(obj.queued_at).split(" ")[0]    : "";
      obj.invoice_date = obj.invoice_date ? String(obj.invoice_date).split(" ")[0] : "";
      return obj;
    })
    .filter(function(r) { return r.status === "pending"; });
}

// ─── Approve a pending SKU ────────────────────────────────────────────────────
function approvePendingSku(rowIndex, overrides) {
  const ss    = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);
  const sheet = ss.getSheetByName(SKU_PENDING_SHEET);
  if (!sheet) return { ok: false, error: "No pending sheet" };

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const row     = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn())
    .getValues()[0];

  const col = function(name) { return headers.indexOf(name); };

  const sku         = String(row[col("sku")]              || "").trim().toUpperCase();
  const displayName = String(overrides.display_name       ||
                             row[col("ai_display_name")]  || "").trim();
  const category    = String(overrides.category           ||
                             row[col("ai_category")]      || "").trim();
  const subCat      = String(overrides.sub_category       ||
                             row[col("ai_sub_category")]  || "").trim();
  const unitsPerSku = Number(overrides.units_per_sku      ||
                             row[col("ai_units_per_sku")] || 1);
  const usageUnit   = String(overrides.usage_unit         ||
                             row[col("ai_usage_unit")]    || "each").trim();

  const invoiceId   = String(row[col("invoice_id")]   || "").trim();
  const invoiceDate = String(row[col("invoice_date")] || "").trim();
  const qty         = Number(row[col("qty_shipped")]  || 0);
  const uom         = String(row[col("uom")]          || "").trim();
  const price       = Number(row[col("price_per_uom")]    || 0);
  const extended    = Number(row[col("extended_amount")]  || 0);

  if (!sku || !displayName || !category) {
    return { ok: false, error: "SKU, display name and category are required" };
  }

  // 1. Add to SKU_Map
  ensurePurchaseLogSheets();
  const skuSheet = SpreadsheetApp.openById(PL_INVENTORY_SS_ID)
    .getSheetByName(PL_SKU_MAP);

  // Check not already there
  const existing = skuSheet.getLastRow() >= 2
    ? skuSheet.getRange(2, 1, skuSheet.getLastRow() - 1, 1)
        .getValues().flat().map(v => String(v || "").trim().toUpperCase())
    : [];

  if (!existing.includes(sku)) {
    skuSheet.appendRow([sku, displayName,
      "cat:" + category + "|sub:" + subCat + "|upu:" + unitsPerSku +
      "|unit:" + usageUnit]);
  }

  // 2. Route to correct log
  const adjustedQty = qty * unitsPerSku;

  if (category === "chemical") {
    // Add to Inventory_Master if display_name not there yet
    ensureInventoryMasterEntry_(displayName, usageUnit);

    const result = writeToPurchaseLog([{
      invoice_id     : invoiceId,
      invoice_date   : invoiceDate,
      sku            : sku,
      description    : String(row[col("description")] || ""),
      uom            : uom,
      qty_ordered    : adjustedQty,
      qty_shipped    : adjustedQty,
      price_per_uom  : price,
      extended_amount: extended,
      display_name   : displayName,
      applied        : "",
      applied_at     : ""
    }]);
    Logger.log("Routed to Purchase_Log: " + JSON.stringify(result));

  } else {
    // Route to Non_Chemical_Log
    writeToNonChemicalLog_([{
      invoice_id     : invoiceId,
      invoice_date   : invoiceDate,
      sku            : sku,
      description    : String(row[col("description")] || ""),
      category       : category,
      sub_category   : subCat,
      display_name   : displayName,
      qty            : qty,
      uom            : uom,
      unit_price     : price,
      extended_amount: extended,
      vendor         : "Heritage Pool Supply"
    }]);
  }

  // 3. Mark as approved
  const statusCol = col("status") + 1;
  sheet.getRange(rowIndex, statusCol).setValue("approved");

  return { ok: true, category, displayName };
}

// ─── Reject a pending SKU ─────────────────────────────────────────────────────
function rejectPendingSku(rowIndex) {
  const ss    = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);
  const sheet = ss.getSheetByName(SKU_PENDING_SHEET);
  if (!sheet) return { ok: false, error: "No pending sheet" };

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const statusCol = headers.indexOf("status") + 1;
  sheet.getRange(rowIndex, statusCol).setValue("rejected");
  return { ok: true };
}

// ─── Ensure display_name exists in Inventory_Master ───────────────────────────
function ensureInventoryMasterEntry_(displayName, usageUnit) {
  const ss    = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);
  const sheet = ss.getSheetByName(PL_INVENTORY_SHEET);
  if (!sheet) return;

  const headers  = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const dispCol  = headers.indexOf("display_name");
  if (dispCol === -1) return;

  if (sheet.getLastRow() >= 2) {
    const existing = sheet.getRange(2, dispCol + 1, sheet.getLastRow() - 1, 1)
      .getValues().flat().map(v => String(v || "").trim());
    if (existing.includes(displayName)) return;
  }

  // Add new row with 0 qty
  const newRow = new Array(headers.length).fill("");
  newRow[headers.indexOf("display_name")] = displayName;
  newRow[headers.indexOf("usage_unit")]   = usageUnit || "each";
  newRow[headers.indexOf("qty_on_hand")]  = 0;
  sheet.appendRow(newRow);
  Logger.log("Added new Inventory_Master entry: " + displayName);
}