// ══════════════════════════════════════════════════════════════════════════════
// ScheduledVisits.gs
// Schema management and row creation for the Scheduled_Visits sheet
// in the Routes SS (1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM).
//
// Public API (not called here — invoked by callers):
//   ensureScheduledVisitsSheet_()  → Sheet
//   createScheduledVisit_(data)    → { ok, row }
//
// visit_type enum:
//   startup_day_1 | startup_day_2 | startup_day_3
//   first_month_week_2 | first_month_week_3 | first_month_week_4
//   weekly_service | monthly_service | one_time
//
// status enum:
//   scheduled | completed | skipped | cancelled
// ══════════════════════════════════════════════════════════════════════════════

const SV_ROUTES_SS_ID = '1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM';

const SV_HEADERS = [
  'scheduled_visit_id',   // UUID — generated on insert
  'pool_id',
  'customer_name',
  'service_type',
  'visit_type',           // see enum above
  'scheduled_date',       // yyyy-MM-dd
  'assigned_technician',
  'status',               // scheduled | completed | skipped | cancelled
  'completed_at',         // ISO timestamp — empty until resolved
  'completed_by',
  'chem_log_ref',         // row index in Chemical_Usage_Log — empty until completed
  'notes',
  'created_at',           // ISO timestamp — set on insert
  'created_by'            // username of creator
];

// ─── Sheet bootstrap ──────────────────────────────────────────────────────────
/**
 * Opens the Routes SS and returns the Scheduled_Visits sheet,
 * creating it with headers if it doesn't exist.
 * Safe to call on every write — idempotent.
 *
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function ensureScheduledVisitsSheet_() {
  const ss = SpreadsheetApp.openById(SV_ROUTES_SS_ID);
  let sheet = ss.getSheetByName('Scheduled_Visits');
  if (!sheet) {
    sheet = ss.insertSheet('Scheduled_Visits');
    sheet.appendRow(SV_HEADERS);
    sheet.setFrozenRows(1);
    // Widen the ID column so UUIDs don't truncate visually in the sheet UI
    sheet.setColumnWidth(1, 280);
  }
  return sheet;
}

function bustScheduledVisitRouteCache_(scheduledDate) {
  try {
    const dateStr = String(scheduledDate || '').trim();
    if (!dateStr) return;
    const weekStart = (typeof getWeekStartForDate_ === 'function')
      ? getWeekStartForDate_(dateStr)
      : '';
    if (weekStart) CacheService.getScriptCache().remove('rd:' + weekStart);
  } catch (err) {
    Logger.log('bustScheduledVisitRouteCache_ error: ' + err);
  }
}

// ─── Row creation ─────────────────────────────────────────────────────────────
/**
 * Appends a new row to Scheduled_Visits in the Routes SS.
 * Generates a UUID for scheduled_visit_id and stamps created_at automatically.
 *
 * @param {Object} data
 * @param {string}  data.pool_id              — required
 * @param {string}  data.scheduled_date       — required, yyyy-MM-dd
 * @param {string}  data.visit_type           — required, see enum
 * @param {string}  [data.customer_name]
 * @param {string}  [data.service_type]
 * @param {string}  [data.assigned_technician]
 * @param {string}  [data.status]             — defaults to 'scheduled'
 * @param {string}  [data.completed_at]
 * @param {string}  [data.completed_by]
 * @param {number}  [data.chem_log_ref]
 * @param {string}  [data.notes]
 * @param {string}  [data.created_by]
 *
 * @returns {{ ok: boolean, row?: number, error?: string }}
 */
function createScheduledVisit_(data) {
  try {
    if (!data.pool_id)        throw new Error('pool_id is required');
    if (!data.scheduled_date) throw new Error('scheduled_date is required');
    if (!data.visit_type)     throw new Error('visit_type is required');

    const now   = new Date().toISOString();
    const sheet = ensureScheduledVisitsSheet_();

    const row = [
      Utilities.getUuid(),
      String(data.pool_id               || ''),
      String(data.customer_name         || ''),
      String(data.service_type          || ''),
      String(data.visit_type            || ''),
      String(data.scheduled_date        || ''),
      String(data.assigned_technician   || ''),
      String(data.status                || 'scheduled'),
      String(data.completed_at          || ''),
      String(data.completed_by          || ''),
      (data.chem_log_ref !== undefined && data.chem_log_ref !== null)
        ? Number(data.chem_log_ref) : '',
      String(data.notes                 || ''),
      now,
      String(data.created_by            || '')
    ];

    sheet.appendRow(row);
    bustScheduledVisitRouteCache_(data.scheduled_date);
    return { ok: true, row: sheet.getLastRow() };
  } catch (err) {
    Logger.log('createScheduledVisit_ error: ' + err);
    return { ok: false, error: String(err) };
  }
}
