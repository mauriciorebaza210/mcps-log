// ChemAdmin.gs

// ─── Constants ───────────────────────────────────────────────────────────────
const ADMIN_CHEM_COSTS_SHEET     = "Chem_Costs";
const ADMIN_ARCHIVE_SHEET        = "Chem_Archive";
const ADMIN_ALIASES_SHEET        = "Chem_Aliases";
const ADMIN_INVENTORY_SS_ID      = "1xPv2oEkJ1KCI3l1LexA4cGH73MM-sWXunQ4fr0wyBSI";
const ADMIN_INVENTORY_SHEET      = "Inventory_Master";
const ADMIN_INVENTORY_DISP_HDR   = "display_name";
const ADMIN_FORM_ID              = "1DsNlu5Yc_PoAgy0ZYCtlTwNB3c4c5VURZPJ_X3MV3kQ";

function RESTORE_poolIdsMissingManual() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CORR_USAGE_LOG);

  // Build the same label map the form uses:
  // last_name - service - address - pool_id
  // Read from Signed_Customers in the CRM spreadsheet
  const crmSs     = SpreadsheetApp.openById("1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E");
  const signedSheet = crmSs.getSheetByName("Completed_One_Time");
  if (!signedSheet) throw new Error("Signed_Customers not found");

  const crmHeaders = signedSheet.getRange(1, 1, 1, signedSheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim().toLowerCase());

  const pidCol  = crmHeaders.indexOf("pool_id");
  const lastCol = crmHeaders.indexOf("last_name");
  const svcCol  = crmHeaders.indexOf("service");
  const adrCol  = crmHeaders.indexOf("address");

  if (pidCol === -1) throw new Error('Signed_Customers missing "pool_id"');

  const crmData = signedSheet.getRange(2, 1, signedSheet.getLastRow() - 1,
    signedSheet.getLastColumn()).getValues();

  // Build MCPS-XXXX -> full label map
  const poolMap = {};
  crmData.forEach(row => {
    const pid     = String(row[pidCol]  || "").trim();
    const last    = String(row[lastCol] || "").trim();
    const service = String(row[svcCol]  || "").trim();
    const address = String(row[adrCol]  || "").trim();
    if (pid) poolMap[pid.toUpperCase()] = `${last} - ${service} - ${address} - ${pid}`;
  });

  Logger.log("Pool map from Signed_Customers: " + JSON.stringify(poolMap));

  // Apply to Chemical_Usage_Log
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const poolCol = headers.indexOf("pool_id");
  if (poolCol === -1) throw new Error('No pool_id column found');

  const range  = sheet.getRange(2, poolCol + 1, sheet.getLastRow() - 1, 1);
  const values = range.getValues();
  let changed  = 0;

  values.forEach((row, i) => {
    const raw = String(row[0] || "").trim().toUpperCase();
    // Only fix rows that are still MCPS-only (backfill damage)
    if (/^MCPS-\d{4,}$/.test(raw) && poolMap[raw]) {
      values[i][0] = poolMap[raw];
      changed++;
    }
  });

  if (changed > 0) {
    range.setValues(values);
    Logger.log("Restored " + changed + " pool_id(s) from Signed_Customers");
  } else {
    Logger.log("Nothing left to restore");
  }

  ss.toast("✅ Restored " + changed + " pool_id(s) from Signed_Customers", "MCPS");
}

// Local version of extractPoolId so Corrections.gs has no dependency on UsageSnapshot.gs
function extractPoolIdForCorrections_(value) {
  const s = String(value || "").trim();
  const m = s.match(/(MCPS-\d{4,})\s*$/i);
  return m ? m[1].toUpperCase() : s;
}

function showChemAdmin() {
  const html = HtmlService.createHtmlOutputFromFile("ChemAdminUI")
    .setTitle("Chem Admin")
    .setWidth(520);
  SpreadsheetApp.getUi().showSidebar(html);
}

// ─── Read ─────────────────────────────────────────────────────────────────────
function getChemicals() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ADMIN_CHEM_COSTS_SHEET);
  const last  = sheet.getLastRow();
  if (last < 2) return [];

  return sheet.getRange(2, 1, last - 1, 5).getValues()
    .filter(r => String(r[0] || "").trim())
    .map(r => ({
      name         : String(r[0]).trim(),
      unitsBought  : r[1],
      unitType     : String(r[2] || "").trim(),
      purchasePrice: r[3],
      costPerUnit  : r[4]
    }));
}

function getArchivedChemicals() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ADMIN_ARCHIVE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues()
    .filter(r => String(r[0] || "").trim())
    .map(r => ({
      name         : String(r[0]).trim(),
      unitsBought  : r[1],
      unitType     : String(r[2] || "").trim(),
      purchasePrice: r[3],
      costPerUnit  : r[4],
      archivedAt   : r[5] ? String(r[5]) : "",
      archiveRow   : r[6]   // original Chem_Costs row index (not used for restore, just FYI)
    }));
}

// ─── Debug / Diff ─────────────────────────────────────────────────────────────
function getDebugReport() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Chem_Costs names
  const costsSheet = ss.getSheetByName(ADMIN_CHEM_COSTS_SHEET);
  const costsNames = costsSheet.getLastRow() >= 2
    ? costsSheet.getRange(2, 1, costsSheet.getLastRow() - 1, 1).getValues()
        .flat().map(v => String(v || "").trim()).filter(Boolean)
    : [];

  // 2. Portal_Schema field titles (TEXT items only — chemicals)
  const formNames  = getPortalSchema_()  // defined in PortalSchema.gs
    .filter(i => String(i.type || '').trim() === 'TEXT')
    .map(i => String(i.title || '').trim());

  // 3. Inventory_Master display_names
  const invSs    = SpreadsheetApp.openById(ADMIN_INVENTORY_SS_ID);
  const invSheet = invSs.getSheetByName(ADMIN_INVENTORY_SHEET);
  let invNames   = [];
  if (invSheet && invSheet.getLastRow() >= 2) {
    const invHeaders = invSheet.getRange(1, 1, 1, invSheet.getLastColumn())
      .getValues()[0].map(h => String(h || "").trim());
    const dispCol = invHeaders.indexOf(ADMIN_INVENTORY_DISP_HDR);
    if (dispCol !== -1) {
      invNames = invSheet.getRange(2, dispCol + 1, invSheet.getLastRow() - 1, 1)
        .getValues().flat().map(v => String(v || "").trim()).filter(Boolean);
    }
  }

  // 4. Aliases sheet
  const aliasSheet = ss.getSheetByName(ADMIN_ALIASES_SHEET);
  const aliases    = [];
  if (aliasSheet && aliasSheet.getLastRow() >= 2) {
    aliasSheet.getRange(2, 1, aliasSheet.getLastRow() - 1, 2).getValues()
      .forEach(r => {
        const oldName = String(r[0] || "").trim();
        const newName = String(r[1] || "").trim();
        if (oldName && newName) aliases.push({ oldName, newName });
      });
  }

  const costsSet = new Set(costsNames);
  const formSet  = new Set(formNames);
  const invSet   = new Set(invNames);

  // Build unified list of all names seen anywhere
  const allNames = new Set([...costsNames, ...formNames, ...invNames]);

  const rows = [...allNames].map(name => ({
    name,
    inCosts    : costsSet.has(name),
    inForm     : formSet.has(name),
    inInventory: invSet.has(name),
    ok         : costsSet.has(name) && formSet.has(name) && invSet.has(name)
  }));

  // Sort: mismatches first, then alpha
  rows.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  return { rows, aliases };
}

// ─── Update cost ──────────────────────────────────────────────────────────────
function updateCostPerUnit(name, newCost) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ADMIN_CHEM_COSTS_SHEET);
  const data  = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();

  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0] || "").trim() === name) {
      sheet.getRange(i + 2, 5).setValue(Number(newCost));
      return { ok: true };
    }
  }
  return { ok: false, error: "Chemical not found" };
}

// ─── Rename (with cascade) ────────────────────────────────────────────────────
function renameChemical(oldName, newName) {
  newName = String(newName || "").trim();
  oldName = String(oldName || "").trim();
  if (!newName || newName === oldName) return { ok: false, error: "Invalid name" };

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Update Chem_Costs column A
  const costsSheet = ss.getSheetByName(ADMIN_CHEM_COSTS_SHEET);
  const costsData  = costsSheet.getRange(2, 1, costsSheet.getLastRow() - 1, 1).getValues();
  let   found      = false;
  for (let i = 0; i < costsData.length; i++) {
    if (String(costsData[i][0] || "").trim() === oldName) {
      costsSheet.getRange(i + 2, 1).setValue(newName);
      found = true;
      break;
    }
  }
  if (!found) return { ok: false, error: "Chemical not found in Chem_Costs" };

  // 2. Update Portal_Schema field title
  try {
    renameFieldInSchema(oldName, newName); // defined in PortalSchema.gs
  } catch(e) {
    Logger.log("Portal_Schema rename warning: " + e);
  }

  // 3. Update Inventory_Master display_name
  try {
    const invSs    = SpreadsheetApp.openById(ADMIN_INVENTORY_SS_ID);
    const invSheet = invSs.getSheetByName(ADMIN_INVENTORY_SHEET);
    if (invSheet) {
      const invHeaders = invSheet.getRange(1, 1, 1, invSheet.getLastColumn())
        .getValues()[0].map(h => String(h || "").trim());
      const dispCol = invHeaders.indexOf(ADMIN_INVENTORY_DISP_HDR);
      if (dispCol !== -1 && invSheet.getLastRow() >= 2) {
        const invData = invSheet.getRange(2, dispCol + 1, invSheet.getLastRow() - 1, 1).getValues();
        for (let i = 0; i < invData.length; i++) {
          if (String(invData[i][0] || "").trim() === oldName) {
            invSheet.getRange(i + 2, dispCol + 1).setValue(newName);
          }
        }
      }
    }
  } catch(e) {
    Logger.log("Inventory rename warning: " + e);
  }

  // 4. Add legacy alias so ChemicalAnalytics resolves old column data
  ensureAliasSheet_();
  const aliasSheet = ss.getSheetByName(ADMIN_ALIASES_SHEET);
  aliasSheet.appendRow([oldName, newName, new Date()]);

  // 5. Rebuild analytics so the alias takes effect immediately
  try { refreshChemicalAnalytics(); } catch(e) { Logger.log("Analytics refresh warning: " + e); }

  return { ok: true };
}

// ─── Reorder ──────────────────────────────────────────────────────────────────
// `orderedNames` is the full array of chemical display_names in the new order
function reorderChemicals(orderedNames) {
  const ss         = SpreadsheetApp.getActiveSpreadsheet();
  const sheet      = ss.getSheetByName(ADMIN_CHEM_COSTS_SHEET);
  const last       = sheet.getLastRow();
  if (last < 2) return { ok: false, error: "No chemicals" };

  const allData = sheet.getRange(2, 1, last - 1, 5).getValues();

  // Build map: name -> full row data
  const rowMap = {};
  allData.forEach(r => {
    const n = String(r[0] || "").trim();
    if (n) rowMap[n] = r;
  });

  // Rebuild in new order (names not in orderedNames get appended at end)
  const reordered  = orderedNames.map(n => rowMap[n]).filter(Boolean);
  const remaining  = allData.filter(r => !orderedNames.includes(String(r[0] || "").trim()));
  const finalRows  = [...reordered, ...remaining];

  sheet.getRange(2, 1, finalRows.length, 5).setValues(finalRows);

  // Clear any leftover rows if list shrank (shouldn't happen but safety)
  if (last - 1 > finalRows.length) {
    sheet.getRange(finalRows.length + 2, 1, last - finalRows.length - 1, 5).clearContent();
  }

  // Sync form order to match
  syncChemicalsToForm();
  return { ok: true };
}

// ─── Add ──────────────────────────────────────────────────────────────────────
function addChemical(name, unitsBought, unitType, purchasePrice, costPerUnit) {
  name = String(name || "").trim();
  if (!name) return { ok: false, error: "Name required" };

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ADMIN_CHEM_COSTS_SHEET);
  sheet.appendRow([name, unitsBought, unitType, purchasePrice, costPerUnit]);
  syncChemicalsToForm();
  return { ok: true };
}

// ─── Delete (archive first) ───────────────────────────────────────────────────
function removeChemical(name) {
  name = String(name || "").trim();
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ADMIN_CHEM_COSTS_SHEET);
  const last  = sheet.getLastRow();
  if (last < 2) return { ok: false, error: "No chemicals" };

  const data = sheet.getRange(2, 1, last - 1, 5).getValues();
  let   targetRow = -1;
  let   targetData;

  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0] || "").trim() === name) {
      targetRow  = i + 2;
      targetData = data[i];
      break;
    }
  }

  if (targetRow === -1) return { ok: false, error: "Chemical not found" };

  // Archive before deleting
  ensureArchiveSheet_();
  const archiveSheet = ss.getSheetByName(ADMIN_ARCHIVE_SHEET);
  archiveSheet.appendRow([...targetData, new Date(), targetRow]);

  sheet.deleteRow(targetRow);
  syncChemicalsToForm();
  return { ok: true };
}

// ─── Restore from archive ─────────────────────────────────────────────────────
function restoreChemical(name) {
  name = String(name || "").trim();
  const ss           = SpreadsheetApp.getActiveSpreadsheet();
  const archiveSheet = ss.getSheetByName(ADMIN_ARCHIVE_SHEET);
  if (!archiveSheet || archiveSheet.getLastRow() < 2)
    return { ok: false, error: "Archive is empty" };

  const data = archiveSheet.getRange(2, 1, archiveSheet.getLastRow() - 1, 7).getValues();
  let   targetRow = -1;
  let   targetData;

  // Find the most recent archived entry for this name
  for (let i = data.length - 1; i >= 0; i--) {
    if (String(data[i][0] || "").trim() === name) {
      targetRow  = i + 2;
      targetData = data[i].slice(0, 5); // original 5 Chem_Costs columns
      break;
    }
  }

  if (targetRow === -1) return { ok: false, error: "Not found in archive" };

  // Re-add to Chem_Costs
  const costsSheet = ss.getSheetByName(ADMIN_CHEM_COSTS_SHEET);
  costsSheet.appendRow(targetData);

  // Remove from archive
  archiveSheet.deleteRow(targetRow);

  syncChemicalsToForm();
  return { ok: true };
}

// ─── Sheet setup helpers ──────────────────────────────────────────────────────
function ensureArchiveSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ADMIN_ARCHIVE_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(ADMIN_ARCHIVE_SHEET);
    sheet.getRange(1, 1, 1, 7).setValues([[
      "Chemical", "Units_Bought", "Unit_Type",
      "Purchase_Price", "Cost_per_Unit", "Archived_At", "Original_Row"
    ]]).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function ensureAliasSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ADMIN_ALIASES_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(ADMIN_ALIASES_SHEET);
    sheet.getRange(1, 1, 1, 3).setValues([["old_name", "new_name", "created_at"]])
      .setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ─── Import from Inventory_Master ─────────────────────────────────────────────
function getInventoryOnlyChemicals() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Names already in Chem_Costs
  const costsSheet = ss.getSheetByName(ADMIN_CHEM_COSTS_SHEET);
  const costsNames = new Set(
    costsSheet.getLastRow() >= 2
      ? costsSheet.getRange(2, 1, costsSheet.getLastRow() - 1, 1)
          .getValues().flat()
          .map(v => String(v || "").trim())
          .filter(Boolean)
      : []
  );

  // All names in Inventory_Master
  const invSs    = SpreadsheetApp.openById(ADMIN_INVENTORY_SS_ID);
  const invSheet = invSs.getSheetByName(ADMIN_INVENTORY_SHEET);
  if (!invSheet || invSheet.getLastRow() < 2) return [];

  const invHeaders = invSheet.getRange(1, 1, 1, invSheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());

  const dispCol    = invHeaders.indexOf(ADMIN_INVENTORY_DISP_HDR);
  const unitCol    = invHeaders.indexOf("usage_unit");
  const qtyCol     = invHeaders.indexOf("qty_on_hand");
  const reorderCol = invHeaders.indexOf("reorder_level");

  if (dispCol === -1) return [];

  return invSheet
    .getRange(2, 1, invSheet.getLastRow() - 1, invSheet.getLastColumn())
    .getValues()
    .map(r => ({
      name        : String(r[dispCol]                              || "").trim(),
      unitType    : unitCol    !== -1 ? String(r[unitCol]         || "").trim() : "",
      qtyOnHand   : qtyCol     !== -1 ? Number(r[qtyCol]          || 0)        : 0,
      reorderLevel: reorderCol !== -1 ? Number(r[reorderCol]      || 0)        : 0
    }))
    .filter(r => r.name && !costsNames.has(r.name));
}

function importFromInventory(name, unitType, costPerUnit) {
  name        = String(name        || "").trim();
  unitType    = String(unitType    || "").trim();
  costPerUnit = Number(costPerUnit || 0);

  if (!name) return { ok: false, error: "Name required" };

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ADMIN_CHEM_COSTS_SHEET);

  if (sheet.getLastRow() >= 2) {
    const existing = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
      .getValues().flat().map(v => String(v || "").trim());
    if (existing.includes(name)) return { ok: false, error: "Already in Chem_Costs" };
  }

  sheet.appendRow([name, "", unitType, "", costPerUnit]);
  syncChemicalsToForm();
  return { ok: true };
}