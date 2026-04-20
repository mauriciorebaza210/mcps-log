/**
 * SALES HUB ENGINE (Cross-Spreadsheet Version)
 */

// 2. The Settings Spreadsheet (where the script is attached / where 'Settings' tab lives)
const SETTINGS_SS = SpreadsheetApp.getActiveSpreadsheet();
function getCrmSheet_() {
  // We use the ID directly here so it never conflicts with other files
  const id = "1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E"; 
  try {
    return SpreadsheetApp.openById(id).getSheetByName("Quotes");
  } catch (e) {
    throw new Error("Could not find CRM Spreadsheet. Check permissions!");
  }
}
function handleGetWeeklyGoal_() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const settings = ss.getSheetByName("Settings");
    const goal = settings ? Number(settings.getRange("A2").getValue()) : 5;

    const quotesSheet = getCrmSheet_();
    const data = quotesSheet.getDataRange().getValues();
    const headers = data.shift();
    
    // Find 'status' and 'signed_at'
    const statusIdx = headers.map(h => String(h).toLowerCase().trim()).indexOf('status');
    const signedAtIdx = headers.map(h => String(h).toLowerCase().trim()).indexOf('signed_at');

    const now = new Date();
    const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));
    startOfWeek.setHours(0, 0, 0, 0);

    const signedCount = data.filter(r => {
      const isSigned = String(r[statusIdx]).toUpperCase() === "SIGNED";
      const signedDate = r[signedAtIdx] ? new Date(r[signedAtIdx]) : null;
      return isSigned && signedDate && signedDate >= startOfWeek;
    }).length;

    return { ok: true, goal: goal, signed_this_week: signedCount };
  } catch (e) {
    return { ok: false, error: e.toString() };
  }
}

// Make sure handleSalesHubFetch also uses the CRM sheet
function handleSalesHubFetch_() {
  try {
    const crmSS = SpreadsheetApp.openById(CRM_SS_ID);
    const sheet = crmSS.getSheetByName("Quotes");
    
    const data = sheet.getDataRange().getValues();
    const headers = data.shift();

    // Helper to find column index
    const getIdx = (name) => headers.map(h => String(h).toLowerCase().trim()).indexOf(name.toLowerCase());

    const results = data.map((row, i) => ({
      id: row[getIdx('quote_id')],
      name: row[getIdx('first_name')] + " " + row[getIdx('last_name')],
      status: row[getIdx('status')],
      area: row[getIdx('area')],
      email: row[getIdx('email')],
      phone: row[getIdx('phone')],
      address: row[getIdx('address')]
    }));

    return { ok: true, data: results };
  } catch (e) {
    return { ok: false, error: "Fetch Error: " + e.toString() };
  }
}
// Helper to find column index by name (case-insensitive)
function getColIdx_(headers, name) {
  const idx = headers.map(h => String(h).toLowerCase().trim()).indexOf(name.toLowerCase().trim());
  if (idx === -1) throw new Error("Missing column: " + name);
  return idx;
}


/**
 * REPLACEMENT FOR handleImportLeads_
 * Targets the correct CRM sheet and maps all provided lead info.
 */
function handleImportLeads_(leads) {
  const sheet = getCrmSheet_(); 
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  
  const newRows = leads.map(l => {
    let row = new Array(headers.length).fill("");
    row[getColIdx_(headers, 'quote_id')] = "Q-" + Utilities.getUuid().substring(0,8);
    row[getColIdx_(headers, 'first_name')] = l.first_name || "";
    row[getColIdx_(headers, 'last_name')] = l.last_name || "";
    row[getColIdx_(headers, 'email')] = l.email || "";
    row[getColIdx_(headers, 'phone')] = l.phone || "";
    row[getColIdx_(headers, 'address')] = l.address || "";
    row[getColIdx_(headers, 'city')] = l.city || "";
    row[getColIdx_(headers, 'area')] = l.area || "";
    row[getColIdx_(headers, 'status')] = "LEAD";
    row[getColIdx_(headers, 'specs_summary')] = l.pool_info || "";
    row[getColIdx_(headers, 'year_built')] = l.year_built || "";
    row[getColIdx_(headers, 'contact_log')] = "[]";
    return row;
  });

  sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, headers.length).setValues(newRows);
  return { ok: true, count: newRows.length };
}

/**
 * REPLACEMENT FOR handleUpdateLead_
 * Targets the correct CRM sheet for updates.
 */
function handleUpdateLead_(payload) {
  const sheet = getCrmSheet_(); // Updated to use the CRM sheet helper
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const data = sheet.getDataRange().getValues();
  
  const idCol = getColIdx_(headers, 'quote_id');
  let rowIdx = -1;

  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] == payload.quote_id) { rowIdx = i + 1; break; }
  }

  if (rowIdx === -1) return { ok: false, error: "Quote ID not found" };

  sheet.getRange(rowIdx, getColIdx_(headers, 'status') + 1).setValue(payload.status);
  sheet.getRange(rowIdx, getColIdx_(headers, 'notes') + 1).setValue(payload.notes);

  // Write pool_id when provided (used during ACTIVE_CUSTOMER activation)
  if (payload.pool_id !== undefined && payload.pool_id !== null) {
    try {
      sheet.getRange(rowIdx, getColIdx_(headers, 'pool_id') + 1).setValue(payload.pool_id);
    } catch(_) {}
  }

  // Write sponsored_by_mcp when explicitly provided
  if (payload.sponsored_by_mcp !== undefined) {
    try {
      sheet.getRange(rowIdx, getColIdx_(headers, 'sponsored_by_mcp') + 1).setValue(payload.sponsored_by_mcp);
    } catch(_) {}
  }

  if (payload.contact_entry) {
    const logColIdx = getColIdx_(headers, 'contact_log') + 1;
    const currentLogStr = sheet.getRange(rowIdx, logColIdx).getValue();
    let logArr = currentLogStr ? JSON.parse(currentLogStr) : [];
    logArr.push(payload.contact_entry);
    sheet.getRange(rowIdx, logColIdx).setValue(JSON.stringify(logArr));
  }

  // Billing fields — write value, creating the column header if it doesn't exist yet
  const softSet = (colName, val) => {
    let idx = headers.map(h => String(h).toLowerCase().trim()).indexOf(colName.toLowerCase().trim());
    if (idx === -1) {
      // Column missing — add it to the end of the header row
      idx = headers.length;
      sheet.getRange(1, idx + 1).setValue(colName);
      headers.push(colName); // keep local headers in sync for subsequent softSet calls
    }
    sheet.getRange(rowIdx, idx + 1).setValue(val !== undefined && val !== null ? val : '');
  };
  if (payload.invoice_day !== undefined && payload.invoice_day !== null && payload.invoice_day !== '') {
    softSet('invoice_day', Number(payload.invoice_day));
  }
  if (payload.billing_start !== undefined && payload.billing_start !== null && payload.billing_start !== '') {
    softSet('billing_start', String(payload.billing_start));
  }
  if (payload.payment_log !== undefined && payload.payment_log !== null) {
    softSet('payment_log', JSON.stringify(payload.payment_log));
  }

  return { ok: true };
}




function handleSetWeeklyGoal_(newGoal) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const settings = ss.getSheetByName("Settings");
  settings.getRange("A2").setValue(newGoal);
  return { ok: true };
}

function handleSaveQuote_(payload) {
  try {
    const sheet = getCrmSheet_();
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    const quoteId = "Q-" + Utilities.getUuid().substring(0, 8).toUpperCase();
    const row = new Array(headers.length).fill("");

    const set = (col, val) => {
      const idx = headers.map(h => String(h).toLowerCase().trim()).indexOf(col.toLowerCase().trim());
      if (idx !== -1) row[idx] = val !== undefined && val !== null ? val : "";
    };

    set('quote_id',                    quoteId);
    set('first_name',                  payload.first_name);
    set('last_name',                   payload.last_name);
    set('email',                       payload.email);
    set('phone',                       payload.phone);
    set('address',                     payload.address);
    set('city',                        payload.city);
    set('zip_code',                    payload.zip_code);
    set('service',                     payload.service);
    set('pool_type',                   payload.pool_type);
    set('size',                        payload.size);
    set('material',                    payload.material);
    set('spa',                         payload.spa);
    set('finish',                      payload.finish);
    set('debris',                      payload.debris);
    set('has_robot',                   payload.has_robot);
    set('high_sun_exposure',           payload.high_sun_exposure);
    set('has_pets',                    payload.has_pets);
    set('startup_chemical_work',       payload.startup_chemical_work);
    set('startup_programming',         payload.startup_programming);
    set('startup_pool_school',         payload.startup_pool_school);
    set('startup_company',             payload.startup_company);
    set('sponsored_by_mcp',            payload.sponsored_by_mcp);
    set('startup_start_date',          payload.startup_start_date);
    set('startup_total_days',          payload.startup_total_days);
    set('repair_job_type',             payload.repair_job_type);
    set('repair_company_name',         payload.repair_company_name);
    set('repair_company_address',      payload.repair_company_address);
    set('repair_job_description',      payload.repair_job_description);
    set('repair_invoice_amount',       payload.repair_invoice_amount);
    set('repair_sku',                  payload.repair_sku);
    set('travel_fee',                  payload.travel_fee);
    set('travel_one_way_miles',        payload.travel_one_way_miles);
    set('travel_round_trip_miles',     payload.travel_round_trip_miles);
    set('travel_billable_round_trip_miles', payload.travel_billable_round_trip_miles);
    set('distance_source',             payload.distance_source);
    set('service_subtotal',            payload.service_subtotal);
    set('discount_type',               payload.discount_type);
    set('discount_value',              payload.discount_value);
    set('discount_amount',             payload.discount_amount);
    set('discounted_service_subtotal', payload.discounted_service_subtotal);
    set('quote_subtotal',              payload.quote_subtotal);
    set('sales_tax',                   payload.sales_tax);
    set('total_with_tax',              payload.total_with_tax);
    set('chem_cost_est',               payload.chem_cost_est);
    set('net_profit_est',              payload.net_profit_est);
    set('margin_percent',              payload.margin_percent);
    set('specs_summary',               payload.specs_summary);
    set('quickbooks_skus',             payload.quickbooks_skus);
    set('quickbooks_item_names',       payload.quickbooks_item_names);
    set('created_by',                  payload.created_by);
    set('quote_source',                payload.quote_source);
    set('quote_version',               payload.quote_version);
    set('status',                      payload.status || 'UNSENT');
    set('contact_log',                 '[]');
    set('timestamp',                   new Date().toISOString());
    set('source_sheet',                'Quotes');
    set('area',                        payload.area || '');

    sheet.appendRow(row);
    return jsonResponse_({ ok: true, quote_id: quoteId });
  } catch (e) {
    return jsonResponse_({ ok: false, error: "handleSaveQuote_ Error: " + e.toString() });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// QUOTE INFO UPDATE
// ──────────────────────────────────────────────────────────────────────────────

function handleUpdateQuoteInfo_(payload) {
  try {
    const sheet = getCrmSheet_();
    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    const idCol = getColIdx_(headers, 'quote_id');
    let rowNum = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idCol]).trim() === String(payload.quote_id).trim()) {
        rowNum = i + 1;
        break;
      }
    }
    if (rowNum === -1) return { ok: false, error: 'Quote not found: ' + payload.quote_id };

    ['first_name','last_name','email','phone','address','city','zip_code'].forEach(col => {
      if (payload[col] !== undefined) {
        const idx = headers.map(h => String(h).toLowerCase().trim()).indexOf(col);
        if (idx !== -1) sheet.getRange(rowNum, idx + 1).setValue(payload[col]);
      }
    });

    return { ok: true };
  } catch(e) {
    return { ok: false, error: 'handleUpdateQuoteInfo_ Error: ' + e.toString() };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// CONTRACT GENERATION
// ──────────────────────────────────────────────────────────────────────────────

function handleGenerateContract_(quoteId) {
  try {
    const sheet = getCrmSheet_();
    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    const idCol = headers.map(h => String(h).toLowerCase().trim()).indexOf('quote_id');
    let rowNum = -1;
    let rowData = null;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idCol]).trim() === String(quoteId).trim()) {
        rowNum = i + 1;
        rowData = data[i];
        break;
      }
    }
    if (rowNum === -1 || !rowData) return { ok: false, error: 'Quote not found: ' + quoteId };

    const get = (col) => {
      const idx = headers.map(h => String(h).toLowerCase().trim()).indexOf(col.toLowerCase().trim());
      return idx !== -1 ? rowData[idx] : '';
    };
    const setCell = (col, val) => {
      const idx = headers.map(h => String(h).toLowerCase().trim()).indexOf(col.toLowerCase().trim());
      if (idx !== -1) sheet.getRange(rowNum, idx + 1).setValue(val);
    };

    const props = PropertiesService.getScriptProperties();
    const templateId = props.getProperty('CONTRACT_TEMPLATE_ID');
    const folderId   = props.getProperty('CONTRACT_FOLDER_ID');
    if (!templateId) return { ok: false, error: 'CONTRACT_TEMPLATE_ID not set in Script Properties.' };
    if (!folderId)   return { ok: false, error: 'CONTRACT_FOLDER_ID not set in Script Properties.' };

    const fullName = [get('first_name'), get('last_name')].filter(Boolean).join(' ').trim() || 'Customer';
    const fileName = 'Pool Service Agreement - ' + fullName + ' - #' + quoteId;

    const templateFile = DriveApp.getFileById(templateId);
    const folder       = DriveApp.getFolderById(folderId);
    const tempDoc      = templateFile.makeCopy('TEMP_DOC_' + fileName, folder);
    const doc          = DocumentApp.openById(tempDoc.getId());
    const body         = doc.getBody();

    body.replaceText('{{DATE}}',      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMMM d, yyyy'));
    body.replaceText('{{CLIENT_NAME}}', fullName);
    body.replaceText('{{EMAIL}}',     String(get('email')  || ''));
    body.replaceText('{{PHONE}}',     String(get('phone')  || ''));
    body.replaceText('{{ADDRESS}}',   String(get('address') || ''));
    body.replaceText('{{SERVICE_TYPE}}', String(get('service') || ''));
    body.replaceText('{{TOTAL}}',     '$' + Number(get('total_with_tax')  || 0).toFixed(2));
    body.replaceText('{{POOL_SPECS}}', String(get('specs_summary') || ''));
    body.replaceText('{{MONTHLY_RATE}}', '$' + Number(get('quote_subtotal')  || 0).toFixed(2));
    body.replaceText('{{SALES_TAX}}', '$' + Number(get('sales_tax')  || 0).toFixed(2));
    body.replaceText('{{QUOTE_ID}}',  quoteId || 'N/A');

    const zip      = String(get('zip_code') || '');
    const city     = String(get('city')     || '');
    const location = [city, zip].filter(Boolean).join(', ');
    body.replaceText('{{ZIP_CODE}}',  zip      || 'N/A');
    body.replaceText('{{CITY}}',      city     || 'N/A');
    body.replaceText('{{LOCATION}}',  location || 'N/A');
    body.replaceText('{{TRAVEL_FEE}}', '$' + Number(get('travel_fee') || 0).toFixed(2));

    const startDateRaw = get('contract_start_date');
    let startDateFormatted = 'TBD';
    if (startDateRaw) {
      try {
        startDateFormatted = Utilities.formatDate(new Date(startDateRaw), Session.getScriptTimeZone(), 'MMMM d, yyyy');
      } catch(_) {
        startDateFormatted = String(startDateRaw);
      }
    }
    body.replaceText('{{CONTRACT_START_DATE}}', startDateFormatted);

    doc.saveAndClose();

    const pdfBlob    = tempDoc.getAs(MimeType.PDF).setName(fileName + '.pdf');
    const pdfFile    = folder.createFile(pdfBlob);
    tempDoc.setTrashed(true);

    const fileId            = pdfFile.getId();
    const driveUrl          = pdfFile.getUrl();
    const directDownloadUrl = 'https://drive.google.com/uc?export=download&id=' + fileId;

    setCell('contract_generated',    'Yes');
    setCell('contract_file_id',      fileId);
    setCell('contract_url',          driveUrl);
    setCell('contract_download_url', directDownloadUrl);
    setCell('contract_status',       'CONTRACT_GENERATED');

    return { ok: true, contract_url: driveUrl, contract_download_url: directDownloadUrl, file_id: fileId };
  } catch(e) {
    return { ok: false, error: 'handleGenerateContract_ Error: ' + e.toString() };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// CONTRACT SENDING (fires Zapier webhook → Drive → SignRequest → Sheet update)
// ──────────────────────────────────────────────────────────────────────────────

function handleSendContract_(quoteId) {
  try {
    const sheet = getCrmSheet_();
    const data  = sheet.getDataRange().getValues();
    const headers = data[0];

    const idCol = headers.map(h => String(h).toLowerCase().trim()).indexOf('quote_id');
    let rowNum = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idCol]).trim() === String(quoteId).trim()) { rowNum = i + 1; break; }
    }
    if (rowNum === -1) return { ok: false, error: 'Quote not found: ' + quoteId };

    const get = col => {
      const idx = headers.map(h => String(h).toLowerCase().trim()).indexOf(col.toLowerCase().trim());
      return idx !== -1 ? data[rowNum - 1][idx] : '';
    };
    const setCell = (col, val) => {
      const idx = headers.map(h => String(h).toLowerCase().trim()).indexOf(col.toLowerCase().trim());
      if (idx !== -1) sheet.getRange(rowNum, idx + 1).setValue(val);
    };

    const webhookUrl = PropertiesService.getScriptProperties().getProperty('ZAPIER_CONTRACT_WEBHOOK');
    if (!webhookUrl) return { ok: false, error: 'ZAPIER_CONTRACT_WEBHOOK not set in Script Properties.' };

    const sentAt = new Date().toISOString();

    // Extract file ID from Drive URL (contract_file_id column may not exist in sheet)
    const contractUrl = get('contract_url');
    const fileIdMatch = contractUrl.match(/\/d\/([a-zA-Z0-9_\-]+)/);
    const contractFileId = fileIdMatch ? fileIdMatch[1] : get('contract_file_id');

    const zapPayload = {
      row_number:       rowNum,
      quote_id:         get('quote_id'),
      first_name:       get('first_name'),
      last_name:        get('last_name'),
      email:            get('email'),
      contract_file_id: contractFileId,
      url:              contractUrl,
      send_contract:    'true',    // string — Zapier filter uses text match
      send_contract_at: sentAt,
      // sent_at intentionally omitted — Zapier filter checks "Does not exist"
      status:           get('status')
    };

    UrlFetchApp.fetch(webhookUrl, {
      method:           'post',
      contentType:      'application/json',
      payload:          JSON.stringify(zapPayload),
      muteHttpExceptions: true
    });

    // Update Quotes sheet columns
    setCell('send_contract',    true);
    setCell('send_contract_at', sentAt);
    setCell('status',           'SENT');

    return { ok: true, sent_at: sentAt };
  } catch(e) {
    return { ok: false, error: 'handleSendContract_ Error: ' + e.toString() };
  }
}