// 06_customers.gs


function normalizePoolIdentity_(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
}

function findExistingPoolIdByIdentity_(signedSheet, signedHM, rowData, crmHM) {
  const addressIdx  = crmHM.headers.indexOf("address");
  const lastNameIdx = crmHM.headers.indexOf("last_name");

  if (addressIdx === -1) return "";

  const targetAddress = normalizePoolIdentity_(rowData[addressIdx]);
  const targetLast    = lastNameIdx !== -1 ? normalizePoolIdentity_(rowData[lastNameIdx]) : "";

  if (!targetAddress) return "";

  const lastRow = signedSheet.getLastRow();
  if (lastRow < 2) return "";

  const data = signedSheet.getRange(2, 1, lastRow - 1, signedHM.headers.length).getValues();

  const poolCol    = signedHM.headers.indexOf("pool_id");
  const addressCol = signedHM.headers.indexOf("address");
  const lastCol    = signedHM.headers.indexOf("last_name");

  for (const row of data) {
    const existingPoolId = String(row[poolCol] || "").trim();
    const existingAddr   = normalizePoolIdentity_(row[addressCol]);
    const existingLast   = lastCol !== -1 ? normalizePoolIdentity_(row[lastCol]) : "";

    if (!existingPoolId) continue;
    if (existingAddr !== targetAddress) continue;

    // Prefer address match; strengthen with last name when available
    if (!targetLast || !existingLast || existingLast === targetLast) {
      return existingPoolId;
    }
  }

  return "";
}

function auditSignedCustomerPoolIds() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Signed_Customers");
  if (!sheet) throw new Error("Signed_Customers not found");

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return;

  const headers = data[0].map(h => String(h || "").trim());
  const col = name => headers.indexOf(name);

  const poolCol = col("pool_id");
  const addrCol = col("address");
  const lastCol = col("last_name");
  const quoteCol = col("quote_id");

  const seenPoolIds = {};
  const seenIdentity = {};

  for (let i = 1; i < data.length; i++) {
    const rowNum = i + 1;
    const poolId = String(data[i][poolCol] || "").trim();
    const addr   = normalizePoolIdentity_(data[i][addrCol]);
    const last   = normalizePoolIdentity_(data[i][lastCol]);
    const quote  = String(data[i][quoteCol] || "").trim();

    if (poolId) {
      if (!seenPoolIds[poolId]) seenPoolIds[poolId] = [];
      seenPoolIds[poolId].push({ rowNum, quote, addr, last });
    }

    const identityKey = `${addr}||${last}`;
    if (addr) {
      if (!seenIdentity[identityKey]) seenIdentity[identityKey] = [];
      seenIdentity[identityKey].push({ rowNum, poolId, quote });
    }
  }

  Logger.log("=== DUPLICATE POOL IDs ===");
  Object.keys(seenPoolIds).forEach(id => {
    if (seenPoolIds[id].length > 1) {
      Logger.log(id + " => " + JSON.stringify(seenPoolIds[id]));
    }
  });

  Logger.log("=== SAME IDENTITY WITH MULTIPLE POOL IDs ===");
  Object.keys(seenIdentity).forEach(key => {
    const poolIds = [...new Set(seenIdentity[key].map(x => x.poolId).filter(Boolean))];
    if (poolIds.length > 1) {
      Logger.log(key + " => " + JSON.stringify(seenIdentity[key]));
    }
  });
}


function moveToSignedSheet_(crmSheet, rowIdx) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const crmHM = getHeaderMap_(crmSheet);

  const signedHeaders = SCHEMA.SIGNED;

  let signedSheet = ss.getSheetByName(CFG.SHEETS.SIGNED);
  if (!signedSheet) {
    signedSheet = ss.insertSheet(CFG.SHEETS.SIGNED);
    signedSheet.getRange(1, 1, 1, signedHeaders.length).setValues([signedHeaders]);
    styleHeader_(signedSheet);
  } else {
    // Use append-only migration — never reorders Signed_Customers columns
    // so Zapier's positional column mapping stays intact
    appendMissingColumns_(signedSheet, signedHeaders);
    styleHeader_(signedSheet);
    applySignedControlsToAllRows_();
  }


  const signedHM = getHeaderMap_(signedSheet);

  const numCols = Math.max(crmSheet.getLastColumn(), crmHM.headers.length);
  if (numCols < 1) throw new Error("CRM sheet has no columns");
  const rowData = crmSheet.getRange(rowIdx, 1, 1, numCols).getValues()[0];

  const serviceStatusIdx  = crmHM.headers.indexOf("service_status");
  const contractStatusIdx = crmHM.headers.indexOf("contract_status");
  const signedAtIdx       = crmHM.headers.indexOf("signed_at");
  const legacyStatusIdx   = crmHM.headers.indexOf("status"); // Zapier watches this

  if (serviceStatusIdx  !== -1) rowData[serviceStatusIdx]  = "ACTIVE_RECURRING";
  if (contractStatusIdx !== -1) rowData[contractStatusIdx] = "SIGNED";
  if (signedAtIdx !== -1 && !rowData[signedAtIdx]) rowData[signedAtIdx] = new Date();
  // Keep legacy status = SIGNED so Zapier fires correctly on this CRM row.
  // It is NOT in SCHEMA.SIGNED so it won't be written to Signed_Customers.
  if (legacyStatusIdx !== -1) rowData[legacyStatusIdx] = "SIGNED";


  const quoteIdIdx = crmHM.headers.indexOf("quote_id");
  if (quoteIdIdx === -1) throw new Error('CRM missing "quote_id" header');

  const quoteId = String(rowData[quoteIdIdx] || "").trim();
  if (!quoteId) throw new Error("CRM row has empty quote_id");

  const signedQuoteCol = signedHM.map["quote_id"];
  if (!signedQuoteCol) throw new Error('Signed_Customers missing "quote_id" header');

  if (signedHasQuoteId_(signedSheet, signedQuoteCol, quoteId)) {
    crmSheet.deleteRow(rowIdx);
    ss.toast("Already in Signed_Customers (duplicate prevented) ✅", "Skipped");
    return;
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    let poolId = findExistingPoolIdByIdentity_(signedSheet, signedHM, rowData, crmHM);
    if (!poolId) {
      poolId = generateNextPoolId_(signedSheet, signedHM);
    }
    const newRow = new Array(signedHeaders.length).fill("");
    signedHeaders.forEach((h, i) => {
      if (h === "pool_id") {
        newRow[i] = poolId;
        return;
      }
      const crmIdx = crmHM.headers.indexOf(h);
      if (crmIdx !== -1) newRow[i] = rowData[crmIdx];
    });

    signedSheet.appendRow(newRow);

    logDebug_("INFO", "Moved row to Signed_Customers", {
      quote_id: quoteId,
      pool_id: poolId
    });

    addPoolToCostTracker(newRow, signedHeaders);

    crmSheet.deleteRow(rowIdx);

    try {
      updateVisitLogDropdownFromSignedCustomers_();
    } catch (e) {
      logDebug_("ERROR", "Failed to update visit log dropdown during migration", { err: String(e) });
    }

    ss.toast(`Customer moved to Signed_Customers ✅ (${poolId})`, "Success");
  } finally {
    lock.releaseLock();
  }
}

function signedHasQuoteId_(signedSheet, quoteIdCol, quoteId) {
  const lastRow = signedSheet.getLastRow();
  if (lastRow < 2) return false;
  const values = signedSheet.getRange(2, quoteIdCol, lastRow - 1, 1).getValues().flat();
  return values.some(v => String(v || "").trim() === quoteId);
}

function generateNextPoolId_(signedSheet, signedHM) {
  const poolCol = signedHM.map["pool_id"];
  if (!poolCol) throw new Error('Signed_Customers missing "pool_id" header');

  const lastRow = signedSheet.getLastRow();
  if (lastRow < 2) return "MCPS-" + String(1).padStart(4, "0");

  const ids = signedSheet.getRange(2, poolCol, lastRow - 1, 1).getValues().flat();
  let maxNum = 0;
  ids.forEach(id => {
    const m = String(id || "").trim().match(/(\d+)\s*$/);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
  });

  return "MCPS-" + String(maxNum + 1).padStart(4, "0");
}

function moveToLostSheet_(signedSheet, rowIndex) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    if (!signedSheet || typeof signedSheet.getParent !== "function") {
      throw new Error(
        `moveToLostSheet_: invalid signedSheet argument: ${signedSheet}`
      );
    }

    if (!rowIndex || rowIndex < 2) {
      throw new Error(
        `moveToLostSheet_: invalid rowIndex argument: ${rowIndex}`
      );
    }

    const ss = signedSheet.getParent();
    const lostName = "Lost_Customers";
    const lostSheet = getOrCreateSheet_(ss, lostName);
    const hm = getHeaderMap_(signedSheet);
    const lastCol = signedSheet.getLastColumn();

    // Ensure Lost_Customers has matching headers
    if (lostSheet.getLastRow() === 0) {
      const headers = signedSheet.getRange(1, 1, 1, lastCol).getValues();
      lostSheet.getRange(1, 1, 1, lastCol).setValues(headers);
    }

    // Stamp lost_at before moving
    const lostAtCol = hm.map["lost_at"];
    if (lostAtCol) {
      signedSheet.getRange(rowIndex, lostAtCol).setValue(new Date());
      SpreadsheetApp.flush();
    }

    // Re-read row after stamping lost_at
    const rowData = signedSheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
    lostSheet.appendRow(rowData);

    // Remove from Signed_Customers after append succeeds
    signedSheet.deleteRow(rowIndex);

    try {
      updateVisitLogDropdownFromSignedCustomers_();
    } catch (e) {
      logDebug_("ERROR", "Failed to update visit log dropdown during lost migration", {
        err: String(e),
        rowIndex: rowIndex
      });
    }

    logDebug_("INFO", "Moved signed customer to Lost_Customers", {
      rowIndex: rowIndex,
      quote_id: hm.map["quote_id"] ? rowData[hm.map["quote_id"] - 1] : "",
      pool_id: hm.map["pool_id"] ? rowData[hm.map["pool_id"] - 1] : ""
    });

  } catch (err) {
    logDebug_("ERROR", "moveToLostSheet_ failed", {
      err: String(err),
      rowIndex: rowIndex
    });
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function addPoolToCostTracker(signedRowData, signedHeaders) {
  try {
    const ss = SpreadsheetApp.openById(CFG.COST_TRACKER.SPREADSHEET_ID);

    const sheet = ss.getSheets().find(
      sh => norm_(sh.getName()) === norm_(CFG.COST_TRACKER.SHEET_NAME)
    );
    if (!sheet) throw new Error(`Cost tracker sheet not found: "${CFG.COST_TRACKER.SHEET_NAME}"`);

    const ctHM = getHeaderMap_(sheet);
    const get  = (key) => getByHeader_(signedRowData, signedHeaders, key);

    const poolId = String(get("pool_id") || "").trim();
    if (!poolId) throw new Error("Signed row missing pool_id");

    const poolIdCol = ctHM.map["pool_id"];
    if (!poolIdCol) throw new Error('Cost tracker missing "pool_id" header');

    const allPoolIds = sheet.getLastRow() >= 2
      ? sheet.getRange(2, poolIdCol, sheet.getLastRow() - 1, 1).getValues().flat()
      : [];

    let targetRow = 0;
    for (let i = 0; i < allPoolIds.length; i++) {
      if (String(allPoolIds[i] || "").trim() === poolId) {
        targetRow = i + 2; // actual sheet row
        break;
      }
    }

    const out = new Array(ctHM.headers.length).fill("");

    const put = (key, val) => {
      if (ctHM.map[key]) out[ctHM.map[key] - 1] = val;
    };

    const firstName = String(get("first_name") || "").trim();
    const lastName  = String(get("last_name") || "").trim();
    const clientName = `${firstName} ${lastName}`.trim() || lastName || firstName;

    put("pool_id", poolId);
    put("Client Name", clientName);
    put("client_name", clientName);

    put("Address", String(get("address") || "").trim());
    put("address", String(get("address") || "").trim());

    put("Service Type", String(get("service") || "").trim());
    put("service_type", String(get("service") || "").trim());

    put("Size", String(get("size") || "").trim());
    put("size", String(get("size") || "").trim());

    put("Spa", String(get("spa") || "").trim());
    put("spa", String(get("spa") || "").trim());

    put("Finish", String(get("finish") || "").trim());
    put("finish", String(get("finish") || "").trim());

    put("Debris", String(get("debris") || "").trim());
    put("debris", String(get("debris") || "").trim());

    put("Travel Fee", get("travel_fee"));
    put("travel_fee", get("travel_fee"));

    const subtotal =
      get("discounted_service_subtotal") !== "" && get("discounted_service_subtotal") != null
        ? get("discounted_service_subtotal")
        : get("service_subtotal");

    put("Subtotal", subtotal);
    put("subtotal", subtotal);

    put("Notes", "");
    put("notes", "");

    if (targetRow) {
      // update existing row metadata only; keep week columns intact
      const existingRow = sheet.getRange(targetRow, 1, 1, ctHM.headers.length).getValues()[0];

      ctHM.headers.forEach((header, idx) => {
        const hasNewValue = out[idx] !== "" && out[idx] != null;
        const isWeekColumn = /^\d{1,2}\/\d{1,2}-\d{1,2}\/\d{1,2}$/.test(String(header || "").trim());

        if (!isWeekColumn && hasNewValue) {
          existingRow[idx] = out[idx];
        }
      });

      sheet.getRange(targetRow, 1, 1, ctHM.headers.length).setValues([existingRow]);
      logDebug_("INFO", "Cost tracker pool updated", { pool_id: poolId, row: targetRow });
    } else {
      sheet.appendRow(out);
      logDebug_("INFO", "Pool added to cost tracker", { pool_id: poolId });
    }

    try {
      updateVisitLogDropdownFromSignedCustomers_();
      logDebug_("INFO", "Updated Visit Log dropdown from Signed_Customers", {});
    } catch (e) {
      logDebug_("ERROR", "Failed to update pool_id dropdown", { err: String(e) });
    }

  } catch (err) {
    logDebug_("ERROR", "Failed to upsert pool to cost tracker", { err: String(err) });
  }
}

function costTrackerHasPoolId_(sheet, poolIdCol, poolId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const values = sheet.getRange(2, poolIdCol, lastRow - 1, 1).getValues().flat();
  return values.some(v => String(v || "").trim() === String(poolId || "").trim());
}

function updateVisitLogDropdownFromSignedCustomers_() {
  const FORM_ID = '1DsNlu5Yc_PoAgy0ZYCtlTwNB3c4c5VURZPJ_X3MV3kQ';
  const QUESTION_TITLE = 'pool_id';

  const form = FormApp.openById(FORM_ID);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CFG.SHEETS.SIGNED);
  if (!sheet) throw new Error(`Sheet not found: ${CFG.SHEETS.SIGNED}`);

  const items = form.getItems(FormApp.ItemType.LIST);
  const item = items.find(i => {
    const t = String(i.getTitle() || "").trim().toLowerCase();
    return t === QUESTION_TITLE.toLowerCase();
  });

  if (!item) throw new Error(`Form item not found with title: ${QUESTION_TITLE}`);

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    item.asListItem().setChoiceValues([]);
    return;
  }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => String(h || "").trim().toLowerCase());

  const col = (name) => headers.indexOf(name);

  const poolIdCol   = col("pool_id");
  const lastNameCol = col("last_name");
  const serviceCol  = col("service");
  const addressCol  = col("address");

  if (poolIdCol === -1) throw new Error('Signed_Customers missing "pool_id"');
  if (lastNameCol === -1) throw new Error('Signed_Customers missing "last_name"');
  if (serviceCol === -1) throw new Error('Signed_Customers missing "service"');
  if (addressCol === -1) throw new Error('Signed_Customers missing "address"');

  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  const options = data
    .filter(row => String(row[poolIdCol] || "").trim() !== "")
    .map(row => {
      const poolId = String(row[poolIdCol] || "").trim();
      const lastName = String(row[lastNameCol] || "").trim();
      const service = String(row[serviceCol] || "").trim();
      const address = String(row[addressCol] || "").trim();

      return `${lastName} - ${service} - ${address} - ${poolId}`;
    });

  const uniqueOptions = [...new Set(options)].sort((a, b) => a.localeCompare(b));

  // Always include "Other" option so it's not deleted by this sync
  const OTHER_OPTION = "Other / Pool not listed";
  if (!uniqueOptions.includes(OTHER_OPTION)) {
    uniqueOptions.push(OTHER_OPTION);
  }

  item.asListItem().setChoiceValues(uniqueOptions);
}
function moveToLostSheet(signedSheet, rowIndex) {
  return moveToLostSheet_(signedSheet, rowIndex);
}
function moveToCompletedOneTimeSheet_(signedSheet, rowIndex) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const ss = signedSheet.getParent();
    const signedHM = getHeaderMap_(signedSheet);

    let completedSheet = ss.getSheetByName(CFG.SHEETS.COMPLETED_ONE_TIME);
    if (!completedSheet) {
      completedSheet = ss.insertSheet(CFG.SHEETS.COMPLETED_ONE_TIME);
      completedSheet
        .getRange(1, 1, 1, SCHEMA.COMPLETED_ONE_TIME.length)
        .setValues([SCHEMA.COMPLETED_ONE_TIME]);
      styleHeader_(completedSheet);
    } else {
      ensureColumns_(completedSheet, SCHEMA.COMPLETED_ONE_TIME);
      styleHeader_(completedSheet);
    }

    const completedHM = getHeaderMap_(completedSheet);

    const lastCol = signedSheet.getLastColumn();
    const rowData = signedSheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];

    const quoteId = String(getByHeader_(rowData, signedHM.headers, "quote_id") || "").trim();
    if (!quoteId) throw new Error("Signed row has empty quote_id");

    const completedQuoteCol = completedHM.map["quote_id"];
    if (!completedQuoteCol) throw new Error('Completed_One_Time missing "quote_id" header');

    const alreadyExists =
      completedSheet.getLastRow() >= 2 &&
      completedSheet
        .getRange(2, completedQuoteCol, completedSheet.getLastRow() - 1, 1)
        .getValues()
        .flat()
        .some(v => String(v || "").trim() === quoteId);

    if (alreadyExists) {
      signedSheet.deleteRow(rowIndex);
      ss.toast("Already in Completed_One_Time (duplicate prevented) ✅", "Skipped");
      return;
    }

    const out = new Array(SCHEMA.COMPLETED_ONE_TIME.length).fill("");

    SCHEMA.COMPLETED_ONE_TIME.forEach((header, i) => {
      if (header === "completed_at") {
        out[i] = new Date();
        return;
      }

      if (header === "service_status") {
        out[i] = "COMPLETED_ONE_TIME";
        return;
      }

      if (header === "contract_status") {
        const signedIdx = signedHM.headers.indexOf("contract_status");
        if (signedIdx !== -1) out[i] = rowData[signedIdx];
        return;
      }

      const signedIdx = signedHM.headers.indexOf(norm_(header));
      if (signedIdx !== -1) out[i] = rowData[signedIdx];
    });

    completedSheet.appendRow(out);
    signedSheet.deleteRow(rowIndex);
    try {
      updateVisitLogDropdownFromSignedCustomers_();
    } catch (e) {
      logDebug_("ERROR", "Failed to update visit log dropdown during one-time completion", { err: String(e) });
    }

    ss.toast("Customer moved to Completed_One_Time ✅", "Success");
  } finally {
    lock.releaseLock();
  }
}

function backfillAddressesToCostTracker() {

  const CRM_SS = SpreadsheetApp.getActiveSpreadsheet();
  const signedSheet = CRM_SS.getSheetByName("Signed_Customers");

  const COST_SS = SpreadsheetApp.openById("1WdmY9qUqlvA7Xswmf8K8n0FYP02FKEBxM7Zd_V5Er_U");
  const costSheet = COST_SS.getSheetByName("Chem_Cost_per_Pool");

  if (!signedSheet) throw new Error("Signed_Customers sheet not found");
  if (!costSheet) throw new Error("Chem_Cost_per_Pool sheet not found");

  const signedData = signedSheet.getDataRange().getValues();
  const costData = costSheet.getDataRange().getValues();

  const signedHeaders = signedData[0];
  const costHeaders = costData[0];

  const poolIdCol = signedHeaders.indexOf("pool_id");
  const addressCol = signedHeaders.indexOf("address");

  const costPoolIdCol = costHeaders.findIndex(h => String(h).trim().toLowerCase() === "pool_id");
  const costAddressCol = costHeaders.findIndex(h => String(h).trim().toLowerCase() === "address");

  if (costAddressCol === -1) {
    throw new Error("Cost tracker missing 'address' column");
  }

  const addressMap = {};

  for (let i = 1; i < signedData.length; i++) {
    const poolId = signedData[i][poolIdCol];
    const address = signedData[i][addressCol];

    if (poolId && address) {
      addressMap[poolId] = address;
    }
  }

  for (let i = 1; i < costData.length; i++) {

    const poolId = costData[i][costPoolIdCol];

    if (addressMap[poolId]) {

      costSheet
        .getRange(i + 1, costAddressCol + 1)
        .setValue(addressMap[poolId]);

    }

  }

}
