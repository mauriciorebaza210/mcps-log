// PortalSchema.gs
// Source of truth for the Service Log form structure.
// Replaces Google Forms as the schema/submission provider.
// The Portal_Schema sheet stores all field definitions; submissions write
// directly to Chemical_Usage_Log with a real timestamp.

const PS_SHEET = 'Portal_Schema';
const PS_COLS  = ['order', 'section', 'title', 'type', 'helpText', 'required', 'choices'];

// ── Internal helpers ──────────────────────────────────────────────────────────

function getPortalSchema_() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(PS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const ncols   = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, ncols).getValues()[0]
    .map(h => String(h || '').trim());
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, ncols).getValues();

  return data.map(row => {
    const item = {};
    headers.forEach((h, i) => { if (h) item[h] = row[i]; });
    return item;
  }).filter(item =>
    String(item.title || '').trim() ||
    String(item.type  || '').trim() === 'PAGE_BREAK'
  );
}

function savePortalSchema_(items) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(PS_SHEET);
  if (!sheet) sheet = ss.insertSheet(PS_SHEET);

  sheet.clearContents();
  sheet.getRange(1, 1, 1, PS_COLS.length).setValues([PS_COLS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  if (!items.length) return;

  const rows = items.map(item => PS_COLS.map(col => {
    const v = item[col];
    if (col === 'choices')  return Array.isArray(v) ? JSON.stringify(v) : String(v || '');
    if (col === 'required') return v === true || v === 'TRUE';
    if (col === 'order')    return Number(v) || 0;
    return v !== undefined && v !== null ? v : '';
  }));

  sheet.getRange(2, 1, rows.length, PS_COLS.length).setValues(rows);
}

// ── getFormMetadata ───────────────────────────────────────────────────────────
// Called by WebhookReceiver get_metadata action.
// Returns the same structure the portal frontend expects.

function getFormMetadata() {
  return getPortalSchema_().map(item => {
    const type = String(item.type || 'TEXT').trim();
    const out  = {
      id      : item.order,
      title   : String(item.title   || '').trim(),
      helpText: String(item.helpText || ''),
      type    : type
    };
    if (type === 'PAGE_BREAK') {
      out.isSectionBreak = true;
    } else {
      out.isRequired = item.required === true || item.required === 'TRUE';
      if (item.choices) {
        try { out.choices = JSON.parse(item.choices); } catch(e) { out.choices = []; }
      }
    }
    return out;
  });
}

// ── submitCustomForm ──────────────────────────────────────────────────────────
// Called by WebhookReceiver submit_form action.
// Writes directly to Chemical_Usage_Log — no Google Form involved.

function submitCustomForm(payload) {
  try {
    const ss       = SpreadsheetApp.getActiveSpreadsheet();
    const logSheet = ss.getSheetByName('Chemical_Usage_Log');
    if (!logSheet) throw new Error('Chemical_Usage_Log sheet not found');

    const lastCol = logSheet.getLastColumn();
    const headers = lastCol > 0
      ? logSheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || '').trim())
      : [];

    // Auto-add a column for any payload key not yet in the sheet
    Object.keys(payload).forEach(k => {
      if (k && !headers.includes(k)) {
        headers.push(k);
        logSheet.getRange(1, headers.length).setValue(k);
      }
    });

    // Build the row in header order; Timestamp is always written fresh
    const row = headers.map(h => {
      if (h === 'Timestamp') return new Date();
      const v = payload[h];
      if (v === undefined || v === null) return '';
      return Array.isArray(v) ? v.join(', ') : v;
    });

    logSheet.appendRow(row);
    return { success: true };
  } catch(e) {
    Logger.log('submitCustomForm ERROR: ' + e);
    return { success: false, error: String(e) };
  }
}

// ── syncChemicalsToPortalSchema ───────────────────────────────────────────────
// Rebuilds chemical rows (type TEXT, section "Used") in Portal_Schema
// from Chem_Costs sheet + Inventory_Master usage units.
// Called by ChemAdmin CRUD operations (via syncChemicalsToForm wrapper).

function syncChemicalsToPortalSchema() {
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const chemSheet = ss.getSheetByName('Chem_Costs');
  if (!chemSheet) throw new Error('Chem_Costs sheet not found');

  const chems = chemSheet.getRange('A2:A').getValues()
    .flat().map(v => String(v || '').trim()).filter(Boolean);
  if (!chems.length) throw new Error('No chemicals found in Chem_Costs');

  const unitMap = getUsageUnitMap_(); // defined in ChemUpdate.gs

  const items   = getPortalSchema_();
  const nonChem = items.filter(i =>
    !(String(i.type || '') === 'TEXT' &&
      String(i.section || '').trim().toLowerCase() === 'used')
  );

  const usedBreak = nonChem.find(i =>
    String(i.type  || '') === 'PAGE_BREAK' &&
    String(i.title || '').trim().toLowerCase() === 'used'
  );
  const baseOrder = usedBreak ? Number(usedBreak.order || 0) : 100;

  const chemItems = chems.map((name, i) => ({
    order   : baseOrder + i + 1,
    section : 'Used',
    title   : name,
    type    : 'TEXT',
    helpText: buildHelpText_(unitMap[name]),
    required: false,
    choices : ''
  }));

  const merged = [...nonChem, ...chemItems]
    .sort((a, b) => Number(a.order) - Number(b.order));

  savePortalSchema_(merged);
}

// ── updatePoolDropdownInSchema ────────────────────────────────────────────────
// Updates the choices array for the pool_id LIST field in Portal_Schema.
// Called by updateVisitLogDropdownFromSignedCustomers_ in Quote_Log/06_customers.gs.

function updatePoolDropdownInSchema(choices) {
  const items    = getPortalSchema_();
  const poolItem = items.find(i =>
    String(i.type  || '') === 'LIST' &&
    String(i.title || '').trim().toLowerCase() === 'pool_id'
  );
  if (!poolItem) {
    Logger.log('updatePoolDropdownInSchema: pool_id field not found in Portal_Schema');
    return;
  }
  poolItem.choices = JSON.stringify(choices);
  savePortalSchema_(items);
}

// ── renameFieldInSchema ───────────────────────────────────────────────────────
// Updates a field title in Portal_Schema. Called by renameChemical in ChemAdmin.gs.

function renameFieldInSchema(oldName, newName) {
  const items = getPortalSchema_();
  const field = items.find(i => String(i.title || '').trim() === oldName);
  if (field) {
    field.title = newName;
    savePortalSchema_(items);
  }
}

// getPoolContext_ is defined in WebhookReceiver.js (the authoritative version).

// ── One-time migration ────────────────────────────────────────────────────────
// Run initPortalSchemaFromForm() ONCE from the Apps Script editor to copy
// the existing Google Form structure into the Portal_Schema sheet.
// After that the portal no longer reads from or submits to the Google Form.

function initPortalSchemaFromForm() {
  const form  = FormApp.openById(CUSTOM_FORM_ID); // constant in FormBackend.gs
  const items = form.getItems();
  const schema = [];
  let order          = 0;
  let currentSection = '';

  items.forEach(item => {
    order++;
    const type  = item.getType().toString();
    const title = String(item.getTitle() || '').trim();

    if (!title && type !== 'PAGE_BREAK') return;

    const row = {
      order,
      section : currentSection,
      title,
      type,
      helpText: item.getHelpText() || '',
      required: false,
      choices : ''
    };

    if (type === 'PAGE_BREAK') {
      currentSection = title;
      row.section    = '';
    } else if (type === 'LIST' || type === 'MULTIPLE_CHOICE' || type === 'CHECKBOX') {
      let ci;
      if (type === 'LIST')            ci = item.asListItem();
      if (type === 'MULTIPLE_CHOICE') ci = item.asMultipleChoiceItem();
      if (type === 'CHECKBOX')        ci = item.asCheckboxItem();
      row.choices  = JSON.stringify(ci.getChoices().map(c => c.getValue()));
      row.required = ci.isRequired();
    } else if (type === 'TEXT') {
      row.required = item.asTextItem().isRequired();
    } else if (type === 'PARAGRAPH_TEXT') {
      row.required = item.asParagraphTextItem().isRequired();
    }

    schema.push(row);
  });

  savePortalSchema_(schema);
  Logger.log('Portal_Schema initialized with ' + schema.length + ' items from Google Form.');
  SpreadsheetApp.getActiveSpreadsheet().toast(
    '✅ Portal_Schema initialized with ' + schema.length + ' fields.',
    'MCPS Form Migration'
  );
}
