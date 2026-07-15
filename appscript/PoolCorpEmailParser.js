// PoolCorpEmailParser.gs
// Checks Gmail every 15 min for emails labeled "poolcorp-invoice"
// from ecom191@scppool.com.
//
// Two email types, both arrive with a PDF:
//   ORDER ACKNOWLEDGEMENT <id> (<category>)  — has qty, price = 0
//   INVOICE <id> (<category>)                — has qty + price
//
// Dedup strategy: both use ORDER # from the PDF as invoice_id so the
// price-update path in writeToPurchaseLog fires when the invoice arrives
// after the acknowledgement.
//
// PDF is extracted via the /api/parse-pdf Vercel endpoint (pdfplumber).
// Set PARSE_PDF_URL and PARSE_PDF_SECRET in Script Properties.

const PC_GMAIL_LABEL           = "poolcorp-invoice";
const PC_GMAIL_PROCESSED_LABEL = "poolcorp-invoice-done";
const PC_SENDER                = "ecom191@scppool.com";

// Column indices in pdfplumber extract_tables() output for line-item rows.
// Confirmed from MarkItDown output of CP292418.pdf:
//   [LN#+SKU, ref/model, _, _, _, UOM, OPEN, PCK-QTY, "SHP-QTY B/O", _, PRICE, _, EXTENSION]
const PC_COL_LN_SKU  = 0;
const PC_COL_UOM     = 5;
const PC_COL_SHP_BO  = 8;   // "1 0" — qty is first token, backorder is second
const PC_COL_PRICE   = 10;
const PC_COL_EXT     = 12;
const PC_DESC_COL    = 1;   // description is col 1 on the *second* row of each item

// ─── Install trigger (run once from editor) ───────────────────────────────────
function installPoolCorpParserTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  const exists   = triggers.some(t => t.getHandlerFunction() === "checkPoolCorpEmails");
  if (exists) { Logger.log("PoolCorp trigger already installed"); return; }
  ScriptApp.newTrigger("checkPoolCorpEmails").timeBased().everyMinutes(15).create();
  Logger.log("PoolCorp invoice parser trigger installed — runs every 15 minutes");
}

// ─── Main entry point ─────────────────────────────────────────────────────────
function checkPoolCorpEmails() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log("checkPoolCorpEmails: already running, skipping"); return; }

  try {
    ensurePoolCorpLabels_();
    const label = GmailApp.getUserLabelByName(PC_GMAIL_LABEL);
    if (!label) {
      Logger.log("Gmail label not found: " + PC_GMAIL_LABEL + " — create it in Gmail first");
      return;
    }

    const threads = label.getThreads(0, 20);
    let processed = 0;

    threads.forEach(function(thread) {
      const messages = thread.getMessages();
      let allSucceeded = true;

      messages.forEach(function(msg) {
        const from = msg.getFrom() || "";
        if (!from.toLowerCase().includes(PC_SENDER)) {
          Logger.log("Skipping non-PoolCorp message: " + from);
          return;
        }
        const result = processPoolCorpMessage_(msg);
        if (result) {
          processed++;
        } else {
          allSucceeded = false;
          Logger.log("PoolCorp parse failed — thread stays in queue: " + msg.getSubject());
        }
      });

      if (allSucceeded) {
        try {
          const doneLabel = GmailApp.getUserLabelByName(PC_GMAIL_PROCESSED_LABEL);
          thread.addLabel(doneLabel);
          thread.removeLabel(label);
        } catch(e) {
          Logger.log("Label move warning: " + e);
        }
      }
    });

    Logger.log("checkPoolCorpEmails: processed " + processed + " email(s)");
    if (processed > 0) {
      SpreadsheetApp.getActiveSpreadsheet()
        .toast("✅ " + processed + " PoolCorp email(s) parsed", "Invoice Parser");
    }
  } finally {
    lock.releaseLock();
  }
}

// ─── Detect email type from subject ──────────────────────────────────────────
function getPoolCorpEmailType_(msg) {
  const sub = (msg.getSubject() || "").toUpperCase();
  if (sub.includes("ORDER ACKNOWLEDGEMENT") || sub.includes("ORDER ACK")) return "acknowledgement";
  if (sub.includes("INVOICE")) return "invoice";
  return null;
}

// ─── Extract order/invoice ID from subject ────────────────────────────────────
// "ORDER ACKNOWLEDGEMENT CP367991 (PARTS)" → "CP367991"
// "INVOICE CP292418 (PARTS)"               → "CP292418"
function extractPoolCorpSubjectId_(subject) {
  const m = subject.match(/(?:ORDER\s+ACKNOWLEDGEMENT|INVOICE)\s+([A-Z0-9]+)/i);
  return m ? m[1].trim() : "";
}

// ─── Process a single PoolCorp email ─────────────────────────────────────────
function processPoolCorpMessage_(msg) {
  const subject   = msg.getSubject() || "";
  const emailType = getPoolCorpEmailType_(msg);
  if (!emailType) { Logger.log("PoolCorp: unrecognized subject — " + subject); return false; }

  const subjectId = extractPoolCorpSubjectId_(subject);
  if (!subjectId) { Logger.log("PoolCorp: no ID in subject — " + subject); return false; }

  const invoiceDate = Utilities.formatDate(msg.getDate(), "America/Chicago", "MM/dd/yy");

  const pdfs = msg.getAttachments().filter(function(a) {
    return a.getContentType() === "application/pdf" ||
           a.getName().toLowerCase().endsWith(".pdf");
  });
  if (!pdfs.length) { Logger.log("PoolCorp: no PDF in: " + subject); return false; }

  let totalWritten = 0;
  pdfs.forEach(function(pdf) {
    Logger.log("PoolCorp: parsing " + pdf.getName() + " (" + emailType + ")");
    try {
      const pdfResult = callParsePdfEndpoint_(pdf);
      const items     = parsePoolCorpPdf_(pdfResult, subjectId, invoiceDate, emailType);

      if (!items.length) {
        Logger.log("PoolCorp: 0 items parsed from " + pdf.getName());
        logRawPdfData_(pdfResult);
        return;
      }

      Logger.log("PoolCorp: " + items.length + " item(s) parsed from " + pdf.getName());
      routeInvoiceItems_(items);
      totalWritten += items.length;
    } catch(e) {
      Logger.log("PoolCorp: error on " + pdf.getName() + ": " + e);
    }
  });

  return totalWritten > 0;
}

// ─── Call the Vercel /api/parse-pdf endpoint ──────────────────────────────────
function callParsePdfEndpoint_(attachment) {
  const url    = PropertiesService.getScriptProperties().getProperty("PARSE_PDF_URL");
  const secret = PropertiesService.getScriptProperties().getProperty("PARSE_PDF_SECRET");
  if (!url) throw new Error("PARSE_PDF_URL not set in Script Properties");

  const b64  = Utilities.base64Encode(attachment.copyBlob().getBytes());
  const resp = UrlFetchApp.fetch(url, {
    method          : "post",
    contentType     : "application/json",
    payload         : JSON.stringify({ pdf_base64: b64, secret: secret }),
    muteHttpExceptions: true
  });

  if (resp.getResponseCode() !== 200) {
    throw new Error("parse-pdf endpoint " + resp.getResponseCode() + ": " + resp.getContentText().substring(0, 200));
  }

  const result = JSON.parse(resp.getContentText());
  if (!result.ok) throw new Error("parse-pdf error: " + result.error);
  return result;  // { ok, text, pages: [{ text, tables }] }
}

// ─── Parse pdfplumber output into Purchase_Log items ─────────────────────────
//
// Column layout confirmed from MarkItDown output of CP292418.pdf:
//   Row type A (item):  [LN#+SKU, model/ref, _, _, _, UOM, OPEN, PCK-QTY, "SHP-QTY B/O", _, PRICE, _, EXT]
//   Row type B (desc):  ["",      description, _, _, _, loc-code, ...]
//
// Dedup key: ORDER # from the PDF header is used as invoice_id for BOTH
// acknowledgements and invoices so that when the invoice arrives it matches
// the acknowledgement row and updates the price (same as Heritage pickup flow).
function parsePoolCorpPdf_(pdfResult, subjectId, invoiceDate, emailType) {
  const skuMap = buildSkuMap_();
  const items  = [];

  // Extract ORDER # from raw text — present on both ACK and INVOICE
  const allText    = pdfResult.text || "";
  const orderMatch = allText.match(/ORDER\s*#\s*([A-Z0-9]+)/i);
  const orderId    = orderMatch ? orderMatch[1].trim() : subjectId;

  // For INVOICE: also extract INVOICE # for logging
  const invMatch = allText.match(/INVOICE\s*#\s*([A-Z0-9]+)/i);
  const invoiceNum = invMatch ? invMatch[1].trim() : "";
  if (invoiceNum) Logger.log("PoolCorp: invoice# " + invoiceNum + " → order# " + orderId);

  // Combine tables from all pages
  const allTables = [];
  (pdfResult.pages || []).forEach(function(page) {
    (page.tables || []).forEach(function(tbl) { allTables.push(tbl); });
  });

  // Line-item rows start with "<digit> <SKU>" in col 0
  const itemRowPattern = /^(\d+)\s+([A-Z0-9-]+)\s*$/i;

  allTables.forEach(function(table) {
    for (var i = 0; i < table.length; i++) {
      const row  = table[i];
      const col0 = String(row[PC_COL_LN_SKU] || "").trim();
      const m    = col0.match(itemRowPattern);
      if (!m) continue;

      const sku = m[2].trim().toUpperCase();

      // Row B: next row where col0 is empty — contains the real product description
      let description = "";
      if (i + 1 < table.length) {
        const nextRow  = table[i + 1];
        const nextCol0 = String(nextRow[PC_COL_LN_SKU] || "").trim();
        if (!nextCol0) {
          const candidate = String(nextRow[PC_DESC_COL] || "").trim();
          // Skip warehouse location codes like "03-F-06"
          if (candidate && !/^\d{2}-[A-Z]-\d{2}$/.test(candidate)) {
            description = candidate;
          }
        }
      }

      // UOM
      const uom = String(row[PC_COL_UOM] || "").trim().toUpperCase() || "EA";

      // SHP-QTY: "1 0" → take first token
      const shpRaw = String(row[PC_COL_SHP_BO] || "0").trim();
      const qtyShipped = Number(shpRaw.split(/\s+/)[0]) || 0;

      // Price and extension (0 for ORDER ACKNOWLEDGEMENTS — they arrive before invoicing)
      const price = emailType === "invoice"
        ? Number(String(row[PC_COL_PRICE] || "0").replace(/,/g, "")) || 0
        : 0;
      const ext = emailType === "invoice"
        ? Number(String(row[PC_COL_EXT] || "0").replace(/,/g, "")) || 0
        : 0;

      if (!sku || qtyShipped <= 0) continue;

      items.push({
        invoice_id     : orderId,
        invoice_date   : invoiceDate,
        sku            : sku,
        description    : description,
        uom            : uom,
        qty_ordered    : qtyShipped,
        qty_shipped    : qtyShipped,
        price_per_uom  : price,
        extended_amount: ext,
        display_name   : skuMap[sku] || "",
        applied        : "",
        applied_at     : ""
      });

      Logger.log("PoolCorp item: " + sku + " | " + description + " | qty=" + qtyShipped +
                 " | uom=" + uom + " | price=" + price);
    }
  });

  return items;
}

// ─── Debug helper: log raw pdfplumber output ──────────────────────────────────
function logRawPdfData_(pdfResult) {
  Logger.log("=== RAW TEXT ===");
  (pdfResult.text || "").split("\n").slice(0, 60).forEach(function(l, i) {
    Logger.log(i + ": " + l);
  });
  Logger.log("=== TABLES (" + (pdfResult.pages||[]).length + " pages) ===");
  (pdfResult.pages || []).forEach(function(page, pi) {
    (page.tables || []).forEach(function(tbl, ti) {
      Logger.log("Page " + pi + " Table " + ti + " (" + tbl.length + " rows):");
      tbl.slice(0, 20).forEach(function(row, ri) {
        Logger.log("  Row " + ri + ": " + JSON.stringify(row));
      });
    });
  });
}

// ─── Ensure Gmail labels exist ────────────────────────────────────────────────
function ensurePoolCorpLabels_() {
  [PC_GMAIL_LABEL, PC_GMAIL_PROCESSED_LABEL].forEach(function(name) {
    if (!GmailApp.getUserLabelByName(name)) {
      GmailApp.createLabel(name);
      Logger.log("Created Gmail label: " + name);
    }
  });
}

// ─── Manual trigger ───────────────────────────────────────────────────────────
function manualCheckPoolCorpEmails() {
  checkPoolCorpEmails();
  return { ok: true };
}

// ─── Test: dump raw pdfplumber output for a labeled email ─────────────────────
// 1. Label a PoolCorp email "poolcorp-invoice" in Gmail
// 2. Run this function from the Apps Script editor
// 3. Copy the log — share it if the parser produces 0 items
function TEST_dumpPoolCorpPdfData() {
  const label = GmailApp.getUserLabelByName(PC_GMAIL_LABEL);
  if (!label) { Logger.log("Label not found: " + PC_GMAIL_LABEL); return; }

  for (const thread of label.getThreads(0, 5)) {
    for (const msg of thread.getMessages()) {
      if (!(msg.getFrom() || "").toLowerCase().includes(PC_SENDER)) continue;
      Logger.log("Subject: " + msg.getSubject());

      const pdfs = msg.getAttachments().filter(a =>
        a.getContentType() === "application/pdf" || a.getName().toLowerCase().endsWith(".pdf")
      );
      for (const pdf of pdfs) {
        Logger.log("PDF: " + pdf.getName());
        const result = callParsePdfEndpoint_(pdf);
        logRawPdfData_(result);
      }
      return;
    }
  }
  Logger.log("No PoolCorp emails found in " + PC_GMAIL_LABEL);
}
