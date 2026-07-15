// InvoiceEmailParser.gs
// Checks Gmail every 15 min for emails labeled "heritage-invoice"
// Extracts PDF attachments, parses Heritage invoice data,
// writes to Purchase_Log, applies to Inventory_Master.

const GMAIL_LABEL          = "heritage-invoice";
const GMAIL_PROCESSED_LABEL = "heritage-invoice-done";
const PARSER_LOCK_KEY      = "invoiceParser_running";

// ─── Install trigger (run once from editor) ───────────────────────────────────
function installInvoiceParserTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  const exists   = triggers.some(t => t.getHandlerFunction() === "checkInvoiceEmails");
  if (exists) { Logger.log("Trigger already installed"); return; }

  ScriptApp.newTrigger("checkInvoiceEmails")
    .timeBased()
    .everyMinutes(15)
    .create();

  Logger.log("Invoice parser trigger installed — runs every 15 minutes");
}

// ─── Main entry point (trigger calls this) ────────────────────────────────────
function checkInvoiceEmails() {
  // Prevent overlapping runs
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log("checkInvoiceEmails: another instance is running, skipping");
    return;
  }

  try {
    ensureProcessedLabel_();

    const label     = GmailApp.getUserLabelByName(GMAIL_LABEL);
    if (!label) {
      Logger.log("Gmail label not found: " + GMAIL_LABEL + " — create it in Gmail first");
      return;
    }

    const threads = label.getThreads(0, 20); // process up to 20 threads at a time
    let processed = 0;

    threads.forEach(function(thread) {
      const messages = thread.getMessages();
      let allSucceeded = true;

      messages.forEach(function(msg) {
        const result = processInvoiceMessage_(msg);
        if (result) {
          processed++;
        } else {
          allSucceeded = false;
          Logger.log("Message failed to parse — thread will stay in " +
            GMAIL_LABEL + " for retry: " + msg.getSubject());
        }
      });

      // Only move to done if every message in the thread parsed successfully.
      // Leaving it in the queue lets the next 15-min run retry failed messages.
      if (allSucceeded) {
        try {
          const doneLabel = GmailApp.getUserLabelByName(GMAIL_PROCESSED_LABEL);
          thread.addLabel(doneLabel);
          thread.removeLabel(label);
        } catch(e) {
          Logger.log("Label move warning: " + e);
        }
      }
    });

    Logger.log("checkInvoiceEmails: processed " + processed + " invoice(s)");

    if (processed > 0) {
      SpreadsheetApp.getActiveSpreadsheet()
        .toast("✅ " + processed + " Heritage invoice(s) parsed and applied", "Invoice Parser");
    }

  } finally {
    lock.releaseLock();
  }
}

// ─── Detect if email is a pickup notification ─────────────────────────────────
function isPickupNotification_(msg) {
  const subject = (msg.getSubject() || "").toLowerCase();
  const body = (msg.getPlainBody() || msg.getBody() || "").toLowerCase();

  return subject.includes("ready for pickup") ||
         subject.includes("order ready") ||
         subject.includes("is ready for pickup") ||
         body.includes("ready for pickup");
}

// ─── Parse Heritage pickup notification email ─────────────────────────────────
function parseHeritagePickupEmail_(msg) {
  const subject = msg.getSubject() || "";
  const html = msg.getBody() || "";
  const invoiceDate = Utilities.formatDate(msg.getDate(), "America/Chicago", "MM/dd/yy");

  const orderMatch =
    subject.match(/Order#?\s*([A-Z0-9-]+)/i) ||
    html.match(/Order#?\s*([A-Z0-9-]+)/i);

  const rawOrderId = orderMatch ? orderMatch[1].trim() : "";
  const orderId = rawOrderId.replace(/^0+/, "") || rawOrderId;
  
  if (!orderId) {
    Logger.log("Pickup: could not extract order number from subject/body");
    return [];
  }

  const skuMap = buildSkuMap_();

  // Normalize HTML into line/tab friendly text
  const clean = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/td>/gi, "\t")
    .replace(/<\/th>/gi, "\t")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, "");

  const lines = clean
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);

  Logger.log("Pickup parse starting for order: " + orderId);
  Logger.log("=== PICKUP CLEAN LINES ===");
  lines.slice(0, 80).forEach(function(line, i) {
    Logger.log("Line " + i + ": " + JSON.stringify(line));
  });

  const items = [];
  const skuPattern = /^[A-Z0-9]{5,20}$/i;

  const headerNoise = [
    "ITEM", "QTY", "ORDERED", "UOM", "READY FOR PICKUP",
    "PREVIOUSLY PICKED UP", "ALLOCATED QTY", "B/O"
  ];

  function isNoiseLine_(line) {
    const upper = String(line || "").toUpperCase().replace(/\s+/g, " ").trim();
    return headerNoise.some(h => upper.includes(h));
  }

  for (let i = 0; i < lines.length - 1; i++) {
    const skuLine = lines[i].replace(/\s+/g, " ").trim();
    const nextLine = lines[i + 1].trim();

    if (!skuPattern.test(skuLine)) continue;
    if (isNoiseLine_(skuLine)) continue;
    if (!nextLine.includes("\t")) continue;

    const cells = nextLine.split("\t").map(s => s.trim()).filter(Boolean);

    // Expected:
    // [description, qtyOrdered, uom, readyForPickup, prevPicked, allocated, bo]
    if (cells.length < 3) continue;

    const description = cells[0] || "";
    const qtyOrdered = Number(cells[1] || 0);
    const uom = (cells[2] || "EA").toUpperCase();
    const qtyReady = Number(cells[3] || qtyOrdered || 0);

    if (!description) continue;
    if (!qtyOrdered && !qtyReady) continue;

    const item = {
      invoice_id      : orderId,
      invoice_date    : invoiceDate,
      sku             : skuLine.toUpperCase(),
      description     : description,
      uom             : uom,
      qty_ordered     : qtyOrdered || qtyReady,
      qty_shipped     : qtyReady || qtyOrdered,
      price_per_uom   : 0,
      extended_amount : 0,
      display_name    : skuMap[skuLine.toUpperCase()] || "",
      applied         : "",
      applied_at      : ""
    };

    items.push(item);
    Logger.log("Pickup item parsed: " + JSON.stringify(item));

    i++; // skip the detail line we just consumed
  }

  Logger.log("Pickup total parsed: " + items.length + " items from order " + orderId);
  return items;
}

function TEST_parsePickupEmail() {
  const label = GmailApp.getUserLabelByName("heritage-invoice");
  if (!label) throw new Error("Label heritage-invoice not found");

  const threads = label.getThreads(0, 10);

  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      if (isPickupNotification_(msg)) {
        Logger.log("=== TESTING MESSAGE ===");
        Logger.log("Subject: " + msg.getSubject());

        const items = parseHeritagePickupEmail_(msg);

        Logger.log("=== PARSED ITEMS COUNT: " + items.length + " ===");
        items.forEach(function(item, i) {
          Logger.log("Item " + (i + 1) + ": " + JSON.stringify(item));
        });

        return;
      }
    }
  }

  Logger.log("No pickup notification found in tested threads.");
}

// ─── Process a single email message ──────────────────────────────────────────
function processInvoiceMessage_(msg) {
  // ── Pickup notification ───────────────────────────────────────────────────
  if (isPickupNotification_(msg)) {
    Logger.log("Detected pickup notification: " + msg.getSubject());
    try {
      const items = parseHeritagePickupEmail_(msg);
      if (!items.length) {
        Logger.log("No items parsed from pickup notification");
        return false;
      }
      Logger.log("Parsed " + items.length + " items from pickup notification");
      routeInvoiceItems_(items);
      return true;
    } catch(e) {
      Logger.log("Error processing pickup notification: " + e);
      return false;
    }
  }

  // ── Invoice PDF ───────────────────────────────────────────────────────────
  const attachments = msg.getAttachments();
  const pdfs = attachments.filter(function(a) {
    return a.getContentType() === "application/pdf" ||
           a.getName().toLowerCase().endsWith(".pdf");
  });

  if (!pdfs.length) {
    Logger.log("No PDF attachments in message: " + msg.getSubject());
    return false;
  }

  let totalWritten = 0;
  pdfs.forEach(function(pdf) {
    Logger.log("Processing PDF: " + pdf.getName());
    try {
      const text  = extractTextFromPdf_(pdf);
      const items = parseHeritagePdfText_(text);
      if (!items.length) {
        Logger.log("No line items parsed from: " + pdf.getName());
        return;
      }
      Logger.log("Parsed " + items.length + " items from " + pdf.getName());
      routeInvoiceItems_(items);
      totalWritten += items.length;
    } catch(e) {
      Logger.log("Error processing PDF " + pdf.getName() + ": " + e);
    }
  });

  return totalWritten > 0;
}

function routeInvoiceItems_(items) {
  const skuFullMap  = buildSkuFullMap_(); // category-aware map (includes upu, unit, cat)

  const chemicals    = [];
  const nonChemicals = [];
  const unknowns     = [];

  items.forEach(function(item) {
    const sku  = String(item.sku || "").trim().toUpperCase();
    const info = skuFullMap[sku];

    if (!info) {
      // Unknown SKU — send to AI categorizer
      unknowns.push(item);
      return;
    }

    if (info.category === "chemical") {
      let finalQty = item.qty_shipped;
      const uom = String(item.uom || "").toUpperCase();
      
      // If UOM is case/box/bag/pallet, break it down. Otherwise if EA/GAL/LB, accept exact quantity.
      if (!["EA", "GAL", "LB", "LBS", "EACH", "BOTTLES", "TABLETS", ""].includes(uom)) {
         finalQty = item.qty_shipped * (info.unitsPerSku || 1);
      }

      chemicals.push(Object.assign({}, item, {
        display_name: info.displayName,
        qty_shipped : finalQty
      }));
    } else {
      nonChemicals.push(Object.assign({}, item, {
        display_name : info.displayName,
        category     : info.category,
        sub_category : info.subCategory
      }));
    }
  });

  // Route chemicals to Purchase_Log
  if (chemicals.length) {
    const result = writeToPurchaseLog(chemicals);
    Logger.log("Routed " + result.written + " chemical(s) to Purchase_Log");

    // Refresh dashboard after inventory push
    refreshInventoryDashboardFromChemLog();
  }

  // Route non-chemicals to Non_Chemical_Log
  if (nonChemicals.length) {
    const rows = nonChemicals.map(function(item) {
      return {
        date           : item.invoice_date,
        invoice_id     : item.invoice_id,
        invoice_date   : item.invoice_date,
        sku            : item.sku,
        description    : item.description,
        category       : item.category || "non-chemical",
        sub_category   : item.sub_category || "",
        display_name   : item.display_name || "",
        qty            : item.qty_shipped,
        uom            : item.uom,
        unit_price     : item.price_per_uom,
        extended_amount: item.extended_amount,
        vendor         : "Heritage Pool Supply"
      };
    });

    writeToNonChemicalLog_(rows);
    Logger.log("Routed " + nonChemicals.length + " non-chemical(s) to Non_Chemical_Log");
  }

  // Send unknowns to AI categorizer
  unknowns.forEach(function(item) {
    try {
      const aiResult = categorizeSku(item.sku, item.description);
      queueSkuForReview(
        item.sku, item.description,
        item.invoice_id, item.invoice_date,
        item.qty_shipped, item.uom,
        item.price_per_uom, item.extended_amount,
        aiResult
      );
    } catch(e) {
      Logger.log("AI categorizer error for " + item.sku + ": " + e);
      // Queue with empty AI result so it still shows for manual review
      queueSkuForReview(
        item.sku, item.description,
        item.invoice_id, item.invoice_date,
        item.qty_shipped, item.uom,
        item.price_per_uom, item.extended_amount,
        { category: "", sub_category: "", display_name: "",
          units_per_sku: 1, usage_unit: "each",
          confidence: "low", reason: "AI categorizer failed" }
      );
    }
  });

  if (unknowns.length) {
    Logger.log(unknowns.length + " unknown SKU(s) queued for review");
  }
}

function pushToInventory_(items) {
  const url = PropertiesService.getScriptProperties()
    .getProperty("INVENTORY_WEBHOOK_URL");

  if (!url) {
    Logger.log("No INVENTORY_WEBHOOK_URL set");
    return;
  }

  const payload = items.map(function(item, idx) {
    return {
      chemical: item.display_name || item.description,
      qty: item.qty_shipped,
      unit: item.uom,
      reference_id: item.invoice_id + "|" + item.sku + "|" + idx,
      source: "invoice_parser"
    };
  });

  try {
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ items: payload }),
      muteHttpExceptions: true
    });

    Logger.log("Inventory push response: " + res.getContentText());
  } catch (e) {
    Logger.log("Error pushing to inventory: " + e);
  }
}
function MIGRATE_skuMapAddCategoryTags() {
  const ss    = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);
  const sheet = ss.getSheetByName(PL_SKU_MAP);
  if (!sheet || sheet.getLastRow() < 2) return;

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  let changed = 0;

  data.forEach(function(row, i) {
    const notes = String(row[2] || "").trim();
    // Only update rows that don't already have category tags
    if (!notes.includes("cat:")) {
      const newNotes = (notes ? notes + " | " : "") +
        "cat:chemical|sub:pool-chemical|upu:1";
      sheet.getRange(i + 2, 3).setValue(newNotes);
      changed++;
    }
  });

  Logger.log("MIGRATE_skuMapAddCategoryTags: updated " + changed + " rows");
  SpreadsheetApp.getActiveSpreadsheet()
    .toast("✅ SKU_Map migrated — " + changed + " rows tagged", "MCPS");
}
// ─── Build full SKU map with category info ────────────────────────────────────
// SKU_Map notes column format: "cat:chemical|sub:pool-chemical|upu:1|unit:gallons"
function buildSkuFullMap_() {
  const ss    = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);
  const sheet = ss.getSheetByName(PL_SKU_MAP);
  if (!sheet || sheet.getLastRow() < 2) return {};

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  const map  = {};

  data.forEach(function(r) {
    const sku         = String(r[0] || "").trim().toUpperCase();
    const displayName = String(r[1] || "").trim();
    const notes       = String(r[2] || "").trim();

    if (!sku) return;

    // Parse structured notes
    const catMatch  = notes.match(/cat:([^|]+)/);
    const subMatch  = notes.match(/sub:([^|]+)/);
    const upuMatch  = notes.match(/upu:([^|]+)/);
    const unitMatch = notes.match(/unit:([^|]+)/);

    // Default: if no cat tag, treat as chemical (backward compatible)
    const category    = catMatch  ? catMatch[1].trim()        : "chemical";
    const subCategory = subMatch  ? subMatch[1].trim()        : "pool-chemical";
    const unitsPerSku = upuMatch  ? Number(upuMatch[1])       : 1;
    const usageUnit   = unitMatch ? unitMatch[1].trim()       : "";

    map[sku] = { displayName, category, subCategory, unitsPerSku, usageUnit };
  });

  return map;
}

// ─── Extract text from PDF using Drive OCR ────────────────────────────────────
function extractTextFromPdf_(attachment) {
  // Save PDF to Drive temporarily, convert to Google Doc for text extraction
  const blob     = attachment.copyBlob();
  const tempFile = DriveApp.createFile(blob);

  try {
    // Convert to Google Doc via Drive API to extract text
    const resource = {
      title    : tempFile.getName(),
      mimeType : MimeType.GOOGLE_DOCS
    };

    const docFile = Drive.Files.copy(resource, tempFile.getId(), { ocr: true });
    const doc     = DocumentApp.openById(docFile.id);
    const text    = doc.getBody().getText();

    // Clean up temp files
    DriveApp.getFileById(docFile.id).setTrashed(true);
    tempFile.setTrashed(true);

    return text;

  } catch(e) {
    tempFile.setTrashed(true);
    throw new Error("PDF text extraction failed: " + e);
  }
}

// ─── Parse Heritage invoice text ─────────────────────────────────────────────
function parseHeritagePdfText_(rawText) {
  const lines = rawText
    .split("\n")
    .map(function(s) { return s.trim(); })
    .filter(Boolean);

  const skuMap = buildSkuMap_();

  const rawInvoiceId = extractField_(lines, /Invoice\s*#\s*[:\-]?\s*(\S+)/i);
  const invoiceId = rawInvoiceId.replace(/^0+/, "") || rawInvoiceId;
  const invoiceDate = extractField_(lines, /Invoice\s*Date\s*[:\-]?\s*(\S+)/i);

  Logger.log("Invoice ID: " + invoiceId + " | Date: " + invoiceDate);
  Logger.log("=== RAW PDF LINES ===");
  lines.slice(0, 120).forEach(function(line, i) {
    Logger.log("Line " + i + ": " + JSON.stringify(line));
  });
  Logger.log("=== END RAW LINES ===");

  const skuPattern   = /^[A-Z0-9]{4,20}$/;
  const slashPattern = /^(\d+(?:\.\d+)?)\s*\/\s*(EA|BAG|CS|LB|GAL|EACH)$/i;
  const moneyPattern = /^\d+\.\d{2}$/;

  // ---------------------------------------------------------------------------
  // Fallback compact parser (for TEST_parseWithRealPdf sample text)
  // ---------------------------------------------------------------------------
  const hasItemSection = lines.some(function(line) {
    return /ITEM\s*\/\s*DESCRIPTION/i.test(line);
  });
  const hasPricingSection = lines.some(function(line) {
    return /CONVERTED/i.test(line);
  });

  if (!hasItemSection && !hasPricingSection) {
    const items = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (!skuPattern.test(line)) {
        i++;
        continue;
      }

      const sku = line;
      const block = [];
      let j = i + 1;

      while (j < lines.length && !skuPattern.test(lines[j])) {
        block.push(lines[j]);
        j++;
      }

      const descParts = [];
      const slashLines = [];
      const moneyLines = [];

      block.forEach(function(part) {
        const m = part.match(slashPattern);
        if (m) {
          slashLines.push({
            val: Number(m[1]),
            uom: m[2].toUpperCase()
          });
          return;
        }
        if (moneyPattern.test(part)) {
          moneyLines.push(Number(part));
          return;
        }
        descParts.push(part);
      });

      let qty = 0;
      let uom = "";
      let price = 0;
      let ext = 0;

      if (moneyLines.length) ext = moneyLines[moneyLines.length - 1];
      if (slashLines.length >= 2) {
        const lastTwo = slashLines.slice(-2);
        qty = lastTwo[0].val;
        uom = lastTwo[0].uom;
        price = lastTwo[1].val;
      } else if (slashLines.length === 1) {
        qty = slashLines[0].val;
        uom = slashLines[0].uom;
      }

      items.push({
        invoice_id      : invoiceId,
        invoice_date    : invoiceDate,
        sku             : sku,
        description     : descParts.join(" ").trim(),
        uom             : uom || "EA",
        qty_ordered     : qty,
        qty_shipped     : qty,
        price_per_uom   : price,
        extended_amount : ext || (qty * price),
        display_name    : skuMap[sku] || "",
        applied         : "",
        applied_at      : ""
      });

      i = j;
    }

    Logger.log("Parsed items count: " + items.length);
    items.forEach(function(it, n) {
      Logger.log("Item " + (n + 1) + ": " + JSON.stringify(it));
    });
    return items;
  }

  // ---------------------------------------------------------------------------
  // Real Heritage OCR parser
  // ---------------------------------------------------------------------------

  const itemStart = lines.findIndex(function(line) {
    return /ITEM\s*\/\s*DESCRIPTION/i.test(line);
  });
  const subtotalIdx = lines.findIndex(function(line) {
    // Match any common Heritage formatting: ***SUB-TOTAL***, ***SUBTOTAL***,
    // --- SUBTOTAL ---, or just a bare SUBTOTAL / SUB-TOTAL line.
    return /\*{2,}\s*SUB-?TOTAL\s*\*{2,}|[-=]{2,}\s*SUB-?TOTAL\s*[-=]{2,}|^\s*SUB-?TOTAL\s*$/i.test(line);
  });
  const pricingStart = lines.findIndex(function(line) {
    return /CONVERTED\s*QTY/i.test(line);
  });

  if (itemStart === -1 || pricingStart === -1) {
    Logger.log("Could not find ITEM / DESCRIPTION or CONVERTED QTY section.");
    return [];
  }

  // 1) Parse all item blocks from ITEM/DESCRIPTION until SUBTOTAL
  const items = [];
  let i = itemStart + 1;

  while (i < (subtotalIdx === -1 ? pricingStart : subtotalIdx)) {
    const line = lines[i];

    if (!skuPattern.test(line)) {
      i++;
      continue;
    }

    const sku = line;
    const descParts = [];
    i++;

    while (i < (subtotalIdx === -1 ? pricingStart : subtotalIdx)) {
      const next = lines[i];
      if (skuPattern.test(next)) break;
      descParts.push(next);
      i++;
    }

    items.push({
      invoice_id      : invoiceId,
      invoice_date    : invoiceDate,
      sku             : sku,
      description     : descParts.join(" ").trim(),
      uom             : "",
      qty_ordered     : 0,
      qty_shipped     : 0,
      price_per_uom   : 0,
      extended_amount : 0,
      display_name    : skuMap[sku] || "",
      applied         : "",
      applied_at      : ""
    });
  }

  // 2) Parse qty rows
  const qtyRows = [];
  let k = pricingStart + 1;
  while (k < lines.length) {
    const line = lines[k];

    if (/PRICE\s*\/\s*UOM/i.test(line)) break;
    if (/^\d+\.\d+%$/.test(line)) {
      k++;
      continue;
    }

    const m = line.match(slashPattern);
    if (m) {
      qtyRows.push({
        qty: Number(m[1]),
        uom: m[2].toUpperCase()
      });
    }
    k++;
  }

  // 3) Parse price rows
  const priceRows = [];
  while (k < lines.length) {
    const line = lines[k];

    if (/EXTENDED/i.test(line) || /^AMOUNT$/i.test(line)) break;
    if (/^\d+\.\d+%$/.test(line)) {
      k++;
      continue;
    }

    // case: "PRICE / UOM 18.94 /CS"
    let inline = line.match(/PRICE\s*\/\s*UOM\s+(\d+(?:\.\d+)?)\s*\/\s*(EA|BAG|CS|LB|GAL|EACH)/i);
    if (inline) {
      priceRows.push({
        price: Number(inline[1]),
        uom: inline[2].toUpperCase()
      });
      k++;
      continue;
    }

    // case: "12.47 /BAG"
    let plain = line.match(slashPattern);
    if (plain) {
      priceRows.push({
        price: Number(plain[1]),
        uom: plain[2].toUpperCase()
      });
    }

    k++;
  }

  // 4) Parse extended rows
  const extRows = [];
  while (k < lines.length) {
    const line = lines[k];

    if (/Claims must/i.test(line)) break;
    if (/TERMS:/i.test(line)) break;
    if (/BALANCE/i.test(line)) break;
    if (/TO VIEW AND PAY ONLINE/i.test(line)) break;
    if (/^\d+\.\d+%$/.test(line)) {
      k++;
      continue;
    }

    if (moneyPattern.test(line)) {
      extRows.push(Number(line));
    }

    k++;
  }

  // Keep only first N rows where N = item count
  const n = items.length;
  const qtyTrim = qtyRows.slice(0, n);
  const priceTrim = priceRows.slice(0, n);
  const extTrim = extRows.slice(0, n);

  for (let idx = 0; idx < n; idx++) {
    const q = qtyTrim[idx];
    const p = priceTrim[idx];
    const e = extTrim[idx];

    if (q) {
      items[idx].qty_ordered = q.qty;
      items[idx].qty_shipped = q.qty;
      items[idx].uom = q.uom;
    }

    if (p) {
      items[idx].price_per_uom = p.price;
      if (!items[idx].uom) items[idx].uom = p.uom;
    }

    if (e != null) {
      items[idx].extended_amount = e;
    }
  }

  Logger.log("Parsed items count: " + items.length);
  items.forEach(function(it, n) {
    Logger.log("Item " + (n + 1) + ": " + JSON.stringify(it));
  });

  return items;
}

// ─── Field extractor helper ───────────────────────────────────────────────────
// Tries each line, then tries joining the line with the next line in case OCR
// split the label and its value across two lines (e.g. "Invoice Date :" / "03/10/26").
function extractField_(lines, regex) {
  for (var i = 0; i < lines.length; i++) {
    const m = lines[i].match(regex);
    if (m) return m[1];

    if (i + 1 < lines.length) {
      const combined = lines[i] + " " + lines[i + 1];
      const m2 = combined.match(regex);
      if (m2) return m2[1];
    }
  }
  return "";
}

// ─── Ensure processed label exists ───────────────────────────────────────────
function ensureProcessedLabel_() {
  if (!GmailApp.getUserLabelByName(GMAIL_PROCESSED_LABEL)) {
    GmailApp.createLabel(GMAIL_PROCESSED_LABEL);
  }
}

// ─── Manual trigger from Admin panel ─────────────────────────────────────────
function manualCheckInvoiceEmails() {
  checkInvoiceEmails();
  return { ok: true };
}

// ─── Test with the actual PDF you uploaded ────────────────────────────────────
function TEST_parseWithRealPdf() {
  const sampleText = [
    "Invoice # : 0025471985-001",
    "Invoice Date : 03/10/26",
    "HAS15041",
    "HASA MURIATIC ACID W/ DEPOSIT",
    "4 EA/ CS (RETURNABLE)",
    "HAZMAT 1 GALLON",
    "2.00 /EA",
    "4.99 /EA",
    "9.98",
    "MCGEC70064",
    "MCGRAYEL STARTUP TEC NEW POOL TREATMENT",
    "8/CS",
    "64 OZ",
    "5.00 /EA",
    "41.05 /EA",
    "205.25",
    "MCGEC20064",
    "MCGRAYEL SCALETEC PLUS CALCIUM POOL",
    "DESCALER 64 OZ 8/CS",
    "1.00 /EA",
    "45.67 /EA",
    "45.67",
    "MCGEC10064",
    "MCGRAYEL ALGATEC SUPER ALGAECIDE",
    "8 X 64 OZ BOTTLE/CASE",
    "1.00 /EA",
    "35.09 /EA",
    "35.09",
    "PBZ88674",
    "POOL BREEZE CALCIUM HARDNESS INCREASER",
    "4 BAG/CASE 8 LB",
    "5.00 /BAG",
    "12.47 /BAG",
    "62.35",
    "PBZ88673",
    "POOL BREEZE TOTAL ALKALINITY INCREASER",
    "4 BAG/CASE 10 LB",
    "5.00 /BAG",
    "15.72 /BAG",
    "78.60",
    "HAS01841CS",
    "HASA LIQUID CHLORINE (12.5%)",
    "4 GALLONS/ CASE DISPOSABLE",
    "5.00 /CS",
    "18.94 /CS",
    "94.70"
  ].join("\n");

  const items = parseHeritagePdfText_(sampleText);
  Logger.log("Parsed " + items.length + " items:");
  items.forEach(function(item) {
    Logger.log(JSON.stringify(item));
  });
}

