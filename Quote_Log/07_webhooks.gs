// 07_webhooks.gs

function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const debugSheet = getOrCreateSheet_(ss, CFG.SHEETS.DEBUG);

  try {
    const incomingKey = (e && e.parameter && e.parameter.key) ? e.parameter.key : "";
    if (incomingKey !== CFG.API.EXPECTED_KEY) throw new Error("Invalid API Key");

    const action = (e && e.parameter && e.parameter.action)
      ? String(e.parameter.action).toLowerCase()
      : "";

    if (action === "map_data") {
      const ROUTES_SPREADSHEET_ID = "1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM";
      const routesSs = SpreadsheetApp.openById(ROUTES_SPREADSHEET_ID);
      const sheet = routesSs.getSheetByName("Routes");
      if (!sheet) throw new Error("Routes sheet not found");

      const data = sheet.getDataRange().getValues();
      if (data.length < 2) {
        return ContentService.createTextOutput(JSON.stringify({ ok: true, data: [] }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      
      const headers = data[0].map(h => String(h).trim().toLowerCase().replace(/ /g, "_"));
      const results = [];
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        let obj = {};
        for (let j = 0; j < headers.length; j++) {
          obj[headers[j]] = row[j];
        }
        results.push(obj);
      }
      return ContentService.createTextOutput(JSON.stringify({ ok: true, data: results }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (action !== "distance") throw new Error("Unknown action: " + action);

    const dest = (e && e.parameter && e.parameter.dest)
      ? String(e.parameter.dest).trim()
      : "";
    if (!dest) throw new Error("Missing dest");

    const travel = computeTravelWithCache_(dest);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, travel }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    debugSheet.appendRow([new Date(), "ERROR", "doGet", String(err)]);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}


function doPost(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const debugSheet = getOrCreateSheet_(ss, CFG.SHEETS.DEBUG);

  try {
    const incomingKey = (e && e.parameter && e.parameter.key) ? e.parameter.key : "";
    if (incomingKey !== CFG.API.EXPECTED_KEY) throw new Error("Invalid API Key");

    const data = JSON.parse(
      (e.postData && e.postData.contents) ? e.postData.contents : "{}"
    );

    if (data.action === "refresh_dropdown") {
      try {
        updateVisitLogDropdownFromSignedCustomers_();
        logDebug_("INFO", "refresh_dropdown: pool_id dropdown refreshed via remote call", {});
      } catch (dropdownErr) {
        logDebug_("ERROR", "refresh_dropdown: failed", { err: String(dropdownErr) });
      }
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true, action: "refresh_dropdown" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── NEW: save quote to clean Quotes sheet ──────────────────────────────
    if (data.action === "save_quote") {
      return handleSaveQuote_(data);
    }

    // ── Standard path: create quote in Quotes_Log + CRM ────────────────────
    const crmSheet = ss.getSheetByName(CFG.SHEETS.CRM);
    // ... rest unchanged

    if (!crmSheet) throw new Error(`Sheet not found: "${CFG.SHEETS.CRM}"`);

    const logSheet = ss.getSheetByName(CFG.SHEETS.LOG);
    if (!logSheet) throw new Error(`Sheet not found: "${CFG.SHEETS.LOG}"`);

    const crmHM = getHeaderMap_(crmSheet);
    const logHM = getHeaderMap_(logSheet);

    // nextQuoteId_ is now locked internally — safe against concurrent POSTs
    const quoteId = nextQuoteId_(ss);
    const now = new Date();

    const logRow = buildRowFromPayload_(data, logHM.headers, {
      timestamp: now,
      quote_id:  quoteId,
    });
    logSheet.appendRow(logRow);

    const crmRow = buildRowFromPayload_(data, crmHM.headers, {
      timestamp:         now,
      quote_id:          quoteId,
      generate_contract: false,
      send_contract:     false,
      contract_status:   "UNSENT",
    });
    crmSheet.appendRow(crmRow);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, quote_id: quoteId }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    debugSheet.appendRow([new Date(), "ERROR", "doPost", String(err)]);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function sendContractWebhook(sheet, hm, row) {
  const webhookUrl =
    PropertiesService.getScriptProperties().getProperty("ZAPIER_SEND_CONTRACT_WEBHOOK") || "";

  if (!webhookUrl) {
    throw new Error("Missing script property: ZAPIER_SEND_CONTRACT_WEBHOOK");
  }

  const rowData = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];

  const payload = {
    row_number: row,
    quote_id: getByHeader_(rowData, hm.headers, "quote_id"),
    first_name: getByHeader_(rowData, hm.headers, "first_name"),
    last_name: getByHeader_(rowData, hm.headers, "last_name"),
    email: getByHeader_(rowData, hm.headers, "email"),
    contract_file_id: getByHeader_(rowData, hm.headers, "contract_file_id"),
    contract_url: getByHeader_(rowData, hm.headers, "contract_url"),
    send_contract: getByHeader_(rowData, hm.headers, "send_contract"),
    send_contract_at: getByHeader_(rowData, hm.headers, "send_contract_at"),
    sent_at: getByHeader_(rowData, hm.headers, "sent_at"),
    status: getByHeader_(rowData, hm.headers, "status")
  };

  const res = UrlFetchApp.fetch(webhookUrl, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  logDebug_("INFO", "Sent contract webhook", {
    row,
    quote_id: payload.quote_id,
    response_code: res.getResponseCode(),
    response_text: res.getContentText()
  });
}
