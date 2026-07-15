// ChemUpdate.gs

const FORM_ID           = "1DsNlu5Yc_PoAgy0ZYCtlTwNB3c4c5VURZPJ_X3MV3kQ"; // kept for reference; no longer used for writes
const CHEM_SHEET_NAME   = "Chem_Costs";
const CHEM_RANGE_A1     = "A2:A";
const ACTIVE_SECTION_TITLE = "Used";

const INVENTORY_SPREADSHEET_ID = "1xPv2oEkJ1KCI3l1LexA4cGH73MM-sWXunQ4fr0wyBSI";
const INVENTORY_SHEET_NAME     = "Inventory_Master";
const DISPLAY_NAME_HEADER      = "display_name";
const USAGE_UNIT_HEADER        = "usage_unit";

// ── syncChemicalsToForm ───────────────────────────────────────────────────────
// Previously wrote chemical questions to the Google Form.
// Now delegates to PortalSchema.gs which updates the Portal_Schema sheet.
// All ChemAdmin CRUD functions still call this name — no changes needed there.

function syncChemicalsToForm() {
  syncChemicalsToPortalSchema(); // defined in PortalSchema.gs
}

// ── Helpers used by PortalSchema.syncChemicalsToPortalSchema ─────────────────

function getUsageUnitMap_() {
  const invSs  = SpreadsheetApp.openById(INVENTORY_SPREADSHEET_ID);
  const sheet  = invSs.getSheetByName(INVENTORY_SHEET_NAME);
  if (!sheet) throw new Error('Sheet not found: ' + INVENTORY_SHEET_NAME);

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return {};

  const headers    = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(h => String(h || '').trim());
  const displayIdx = headers.indexOf(DISPLAY_NAME_HEADER);
  const unitIdx    = headers.indexOf(USAGE_UNIT_HEADER);

  if (displayIdx === -1) throw new Error('Missing header "' + DISPLAY_NAME_HEADER + '" in ' + INVENTORY_SHEET_NAME);
  if (unitIdx    === -1) throw new Error('Missing header "' + USAGE_UNIT_HEADER    + '" in ' + INVENTORY_SHEET_NAME);

  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const map  = {};
  data.forEach(row => {
    const displayName = String(row[displayIdx] || '').trim();
    const usageUnit   = String(row[unitIdx]    || '').trim();
    if (displayName) map[displayName] = usageUnit;
  });
  return map;
}

function buildHelpText_(unit) {
  const u = String(unit || '').trim();
  if (!u) return 'Enter quantity used (leave blank if none).';
  return 'Enter ' + u + ' used (leave blank if none).';
}

// ── DRY RUN helper (unchanged) ────────────────────────────────────────────────

function DRY_RUN_deductLastRow() {
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet  = ss.getSheetByName('Chemical_Usage_Log');
  const rowNumber = rawSheet.getLastRow();

  if (rowNumber < 2) { Logger.log('No data rows in Chemical_Usage_Log'); return; }

  const headerRow = rawSheet.getRange(1, 1, 1, rawSheet.getLastColumn())
    .getValues()[0].map(h => String(h || '').trim());
  const rowData   = rawSheet.getRange(rowNumber, 1, 1, rawSheet.getLastColumn())
    .getValues()[0];

  Logger.log('=== DRY RUN — Row ' + rowNumber + ' ===');
  Logger.log('Timestamp : ' + rowData[headerRow.indexOf('Timestamp')]);
  Logger.log('Pool ID   : ' + rowData[headerRow.indexOf('pool_id')]);

  const invSs    = SpreadsheetApp.openById(INVENTORY_SPREADSHEET_ID);
  const invSheet = invSs.getSheetByName(INVENTORY_SHEET_NAME);
  const invHeaders = invSheet.getRange(1, 1, 1, invSheet.getLastColumn())
    .getValues()[0].map(h => String(h || '').trim());

  const displayCol = invHeaders.indexOf('display_name');
  const qtyCol     = invHeaders.indexOf('qty_on_hand');
  const invData    = invSheet.getRange(2, 1, invSheet.getLastRow() - 1, invSheet.getLastColumn())
    .getValues();

  const invMap = {};
  invData.forEach(r => {
    const name = String(r[displayCol] || '').trim();
    if (name) invMap[name] = Number(r[qtyCol] || 0);
  });

  const nonChem = new Set([
    'Timestamp','pool_id','Technician','Notes','Client Name','Address',
    'Service Type','Month','Visit # in Month','Week Start','WeekKey',
    'MonthKey','Visit # in Week','Total Visit Chem Cost (Snapshot)',
    'Free Chlorine (FC)','pH','Total Alkalinity (TA)','Calcium Hardness (CH)'
  ]);

  let anyDeduction = false;
  headerRow.forEach((name, i) => {
    if (!name || nonChem.has(name)) return;
    if (name.endsWith(' Unit Cost (Snapshot)')) return;
    const qty = Number(rowData[i]);
    if (!isFinite(qty) || qty === 0) return;
    anyDeduction = true;
    if (invMap.hasOwnProperty(name)) {
      Logger.log('✅ ' + name + ': ' + invMap[name] + ' → ' + (invMap[name] - qty) + ' (deduct ' + qty + ')');
    } else {
      Logger.log('⚠️  ' + name + ': qty=' + qty + ' but NOT FOUND in Inventory_Master');
    }
  });

  if (!anyDeduction) Logger.log('No chemical quantities found — nothing would be deducted');
  Logger.log('=== END DRY RUN (nothing was written) ===');
}

// ── addOtherOptionToPoolDropdown ──────────────────────────────────────────────
// Updates the "Other / Pool not listed" option in the Portal_Schema pool_id field.
// Previously edited the Google Form list item directly.

function addOtherOptionToPoolDropdown() {
  const OTHER_OPTION = 'Other / Pool not listed';
  const items        = getPortalSchema_(); // defined in PortalSchema.gs
  const poolItem     = items.find(i =>
    String(i.type  || '') === 'LIST' &&
    String(i.title || '').trim().toLowerCase() === 'pool_id'
  );
  if (!poolItem) throw new Error('pool_id field not found in Portal_Schema');

  let choices = [];
  try { choices = JSON.parse(poolItem.choices || '[]'); } catch(e) { choices = []; }

  if (!choices.includes(OTHER_OPTION)) {
    choices.push(OTHER_OPTION);
    poolItem.choices = JSON.stringify(choices);
    savePortalSchema_(items); // defined in PortalSchema.gs
    Logger.log('Added "' + OTHER_OPTION + '" to pool_id choices in Portal_Schema');
  } else {
    Logger.log('Option already exists in Portal_Schema');
  }

  SpreadsheetApp.getActiveSpreadsheet().toast('✅ Other option confirmed in Portal_Schema', 'MCPS');
}