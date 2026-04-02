//02_schema.gs
function styleHeader_(sheet) {
  if (sheet.getLastColumn() < 1) return;
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight("bold");
  sheet.setFrozenRows(1);
}

function ensureColumns_(sheet, requiredHeaders) {
  const lastCol = sheet.getLastColumn();

  // If empty sheet: write required headers and stop
  if (lastCol === 0) {
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    sheet.setFrozenRows(1);
    return;
  }

  const data = sheet.getDataRange().getValues();
  const existingRawHeaders = (data[0] || []).map(h => String(h || "").trim());

  // Build a normalized lookup for existing headers -> index
  const existingNormToIndex = {};
  existingRawHeaders.forEach((h, i) => {
    const nh = norm_(h);
    if (nh && existingNormToIndex[nh] == null) existingNormToIndex[nh] = i;
  });

  // Start with required headers in order (authoritative)
  const finalHeaders = [...requiredHeaders];

  // Append any "extra" existing columns not in required schema
  existingRawHeaders.forEach(h => {
    const nh = norm_(h);
    const inRequired = requiredHeaders.some(rh => norm_(rh) === nh);
    if (nh && !inRequired) finalHeaders.push(h); // preserve original label for extras
  });

  // If schema already matches (normalized), do nothing
  const existingNorm = existingRawHeaders.map(h => norm_(h)).filter(Boolean);
  const finalNorm = finalHeaders.map(h => norm_(h)).filter(Boolean);

  if (JSON.stringify(existingNorm) === JSON.stringify(finalNorm)) return;

  // Rebuild all rows aligned to finalHeaders
  const newData = [finalHeaders];

  for (let r = 1; r < data.length; r++) {
    const oldRow = data[r];
    const newRow = finalHeaders.map(h => {
      const nh = norm_(h);

      // Prefer exact normalized match to an existing column
      const idx = existingNormToIndex[nh];

      // If we can't find it, it's a brand new column -> blank
      return (idx == null) ? "" : (oldRow[idx] ?? "");
    });
    newData.push(newRow);
  }

  sheet.clear();
  sheet.getRange(1, 1, newData.length, finalHeaders.length).setValues(newData);
  sheet.setFrozenRows(1);
}

/**
 * Safe append-only column migration.
 * ONLY adds columns that are missing, to the RIGHT of whatever already exists.
 * Never reorders, never clears, never shifts existing columns.
 * Use this for sheets that Zapier reads by column position.
 */
function appendMissingColumns_(sheet, requiredHeaders) {
  if (sheet.getLastColumn() === 0) {
    // Empty sheet — just write all headers directly
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    sheet.setFrozenRows(1);
    return;
  }

  const existingHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());

  const existingNorm = new Set(existingHeaders.map(h => norm_(h)).filter(Boolean));

  const toAdd = requiredHeaders.filter(h => !existingNorm.has(norm_(h)));

  if (toAdd.length === 0) return; // nothing new — done

  const nextCol = sheet.getLastColumn() + 1;
  sheet.getRange(1, nextCol, 1, toAdd.length).setValues([toAdd]);
  sheet.setFrozenRows(1);

  Logger.log(`appendMissingColumns_: added ${toAdd.length} column(s) to "${sheet.getName()}": ${toAdd.join(", ")}`);
}


function coerceBooleanColumn_(sheet, col) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const rng = sheet.getRange(2, col, lastRow - 1, 1);
  const vals = rng.getValues();

  for (let i = 0; i < vals.length; i++) {
    const v = vals[i][0];
    if (v === true || v === false || v === "") continue;
    const s = String(v).trim().toUpperCase();
    if (s === "TRUE") vals[i][0] = true;
    else if (s === "FALSE") vals[i][0] = false;
  }
  rng.setValues(vals);
}

function applyCrmControlsToAllRows_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const crm = ss.getSheetByName(CFG.SHEETS.CRM);
  if (!crm) throw new Error("CRM sheet not found");

  const hm = getHeaderMap_(crm);
  const gcCol              = hm.map["generate_contract"];
  const scCol              = hm.map["send_contract"];
  const statusCol          = hm.map["status"];          // legacy — kept for Zapier
  const contractStatusCol  = hm.map["contract_status"]; // new decoupled column
  const serviceStatusCol   = hm.map["service_status"];  // new decoupled column

  const fromRow   = 2;
  const numRows   = crm.getMaxRows() - 1;
  const totalCols = crm.getLastColumn();

  crm.getRange(fromRow, 1, numRows, totalCols).clearDataValidations();

  // Checkboxes
  if (gcCol) {
    coerceBooleanColumn_(crm, gcCol);
    crm.getRange(fromRow, gcCol, numRows, 1).insertCheckboxes();
  }
  if (scCol) {
    coerceBooleanColumn_(crm, scCol);
    crm.getRange(fromRow, scCol, numRows, 1).insertCheckboxes();
  }

  // Legacy status dropdown — kept for Zapier (watches this column for SIGNED trigger)
  // Values: NEW → CONTRACT_GENERATED → SENT → SIGNED → LOST
  if (statusCol) {
    const statusRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(CFG.STATUS, true)
      .setAllowInvalid(true)
      .build();
    crm.getRange(fromRow, statusCol, numRows, 1).setDataValidation(statusRule);
  }

  // New: contract_status dropdown (mirrors status values — same Zapier-compatible options)
  if (contractStatusCol) {
    const contractStatuses = CFG.STATUS;
    const cRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(contractStatuses, true)
      .setAllowInvalid(true)
      .build();
    crm.getRange(fromRow, contractStatusCol, numRows, 1).setDataValidation(cRule);
  }

  // New: service_status dropdown
  if (serviceStatusCol) {
    const serviceStatuses = [
      "ACTIVE_RECURRING", "ACTIVE_SPONSORED", "ACTIVE_TRIAL",
      "ON_HOLD", "LOST", "COMPLETED_ONE_TIME"
    ];
    const sRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(serviceStatuses, true)
      .setAllowInvalid(true)
      .build();
    crm.getRange(fromRow, serviceStatusCol, numRows, 1).setDataValidation(sRule);
  }
}


function applySignedControlsToAllRows_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CFG.SHEETS.SIGNED);
  if (!sh) throw new Error("Signed_Customers sheet not found");

  const hm = getHeaderMap_(sh);
  const gcCol              = hm.map["generate_contract"];
  const sendContractCol    = hm.map["send_contract"];
  // Decoupled status columns (service_status + contract_status replaced old "status")
  const serviceStatusCol   = hm.map["service_status"];
  const contractStatusCol  = hm.map["contract_status"];

  const fromRow   = 2;
  const numRows   = sh.getMaxRows() - 1;
  const totalCols = sh.getLastColumn();

  // Wipe old validations so they don't stay stuck in old locations
  sh.getRange(fromRow, 1, numRows, totalCols).clearDataValidations();

  // Checkbox: generate_contract
  if (gcCol) {
    coerceBooleanColumn_(sh, gcCol);
    sh.getRange(fromRow, gcCol, numRows, 1).insertCheckboxes();
  }

  // Checkbox: send_contract
  if (sendContractCol) {
    coerceBooleanColumn_(sh, sendContractCol);
    sh.getRange(fromRow, sendContractCol, numRows, 1).insertCheckboxes();
  }

  // Dropdown: service_status
  if (serviceStatusCol) {
    const serviceStatuses = [
      "ACTIVE_RECURRING", "ACTIVE_SPONSORED", "ACTIVE_TRIAL",
      "ON_HOLD", "LOST", "COMPLETED_ONE_TIME"
    ];
    const sRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(serviceStatuses, true)
      .setAllowInvalid(true)
      .build();
    sh.getRange(fromRow, serviceStatusCol, numRows, 1).setDataValidation(sRule);
  }

  // Dropdown: contract_status
  if (contractStatusCol) {
    const contractStatuses = CFG.STATUS;
    const cRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(contractStatuses, true)
      .setAllowInvalid(true)
      .build();
    sh.getRange(fromRow, contractStatusCol, numRows, 1).setDataValidation(cRule);
  }
}

function setupCrmUi_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const crm            = getOrCreateSheet_(ss, CFG.SHEETS.CRM);
  const log            = getOrCreateSheet_(ss, CFG.SHEETS.LOG);
  const signed         = getOrCreateSheet_(ss, CFG.SHEETS.SIGNED);
  const completedOneTime = getOrCreateSheet_(ss, CFG.SHEETS.COMPLETED_ONE_TIME);

  ensureColumns_(log,             SCHEMA.LOG);
  ensureColumns_(crm,             SCHEMA.CRM);
  ensureColumns_(completedOneTime, SCHEMA.COMPLETED_ONE_TIME);

  // Signed_Customers uses append-only migration so Zapier's column positions
  // are never shifted. New columns always land to the right of existing ones.
  appendMissingColumns_(signed, SCHEMA.SIGNED);

  styleHeader_(log);
  styleHeader_(crm);
  styleHeader_(signed);
  styleHeader_(completedOneTime);

  applyCrmControlsToAllRows_();
  applySignedControlsToAllRows_();

  ss.toast("✅ CRM/Quotes_Log/Signed/Completed_One_Time schemas set + controls applied", "MCPS");
}
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("MCPS")
    .addItem("Refresh Pool Visit Log Dropdown", "updateVisitLogDropdownFromSignedCustomers_")
    .addSeparator()
    .addItem("Setup CRM UI (schemas + controls)", "setupCrmUi_")
    .addToUi();
}

function testNextQuoteId() {
  const id = nextQuoteId_(SpreadsheetApp.getActiveSpreadsheet());
  Logger.log(id);
}
