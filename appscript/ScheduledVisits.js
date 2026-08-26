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
//   first_month_week_1..26
//   temporary_week_1..26 | weekly_service | monthly_service | one_time
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
// ── The promised first visit, created exactly once ───────────────────────────
//
// createScheduledVisit_ has no dedupe guard, and signing is retried on network
// failure — so calling it raw would give a customer two "first visits".
//
// TWO LAYERS, IN THIS ORDER, and the order is the point:
//
//   1. THE SHEET IS THE DURABLE RECORD. Scan for an existing
//      { pool_id, weekly_service, scheduled_date } first. If it is there, return
//      it and create nothing.
//
//   2. claimDedupAction_ IS ONLY A RACE GUARD. Script properties expire and cap
//      at 50 entries, so a claim can never be the permanent record — a retry
//      after collection would sail past it and create a duplicate. It exists to
//      close the gap between the scan and the write, nothing more.
//
// ⚠️ The dedup key MUST end in 'yyyy-MM-dd HH:mm'. claimDedupAction_'s cleanup
// only deletes keys matching that trailing pattern, and a key that never gets
// collected will eventually exhaust the 50-property store and break EVERY caller
// of claimDedupAction_, including chemical-usage dedup. This is why the key is
// minute-stamped rather than keyed forever on pool+date.
//
// AND THE WRITE IS GATED ON BOTH. A row is appended only when the sheet has no
// row AND this execution owns the claim. Appending after a lost claim — even
// "just once, after re-checking" — is precisely the double-write the guard
// exists to stop: two executions that both read an empty sheet and both append
// produce two first visits, and the losing side re-reading a few milliseconds
// too early sees exactly the same empty sheet. Losing the claim yields
// pending:true instead, plus an exception row so the gap is visible.
var SV_CLAIM_RECHECK_MS = 500;
var SV_CLAIM_RECHECK_TRIES = 2;

function ensureWeeklyServiceVisit_(poolId, dateIso, extra) {
  try {
    var pid = String(poolId || '').trim();
    var date = String(dateIso || '').trim();
    if (!pid || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, error: 'pool_id and a yyyy-MM-dd scheduled_date are required.' };
    }

    // 1. Durable check — the sheet is the record.
    var existing = findWeeklyServiceVisit_(pid, date);
    if (existing) return { ok: true, created: false, scheduled_visit_id: existing };

    // 2. Race guard — short-lived and collectable.
    if (typeof claimDedupAction_ === 'function') {
      var minute = Utilities.formatDate(
        new Date(), Session.getScriptTimeZone() || 'America/Chicago', 'yyyy-MM-dd HH:mm');
      var claimed = claimDedupAction_('weekly_service', pid + '|' + date + ' | ' + minute);
      if (!claimed) {
        // Another execution holds the claim and is mid-write. Give its append a
        // beat to land, then read the sheet again — the claim itself says
        // nothing about whether the row exists.
        for (var i = 0; i < SV_CLAIM_RECHECK_TRIES; i++) {
          try { Utilities.sleep(SV_CLAIM_RECHECK_MS); } catch (sleepErr) { /* test envs */ }
          var again = findWeeklyServiceVisit_(pid, date);
          if (again) return { ok: true, created: false, scheduled_visit_id: again };
        }
        // Still nothing, and we do not own the claim. Do NOT append: the other
        // execution is the one authorised to, and racing it is how a customer
        // ends up with two first visits. Record the gap and let ops close it.
        if (typeof recordAssignmentException_ === 'function') {
          recordAssignmentException_({
            pool_id: pid,
            type: 'missing_first_visit',
            detail: 'A weekly_service visit for ' + date + ' was claimed by a concurrent ' +
                    'execution but had not appeared after ' +
                    (SV_CLAIM_RECHECK_TRIES * SV_CLAIM_RECHECK_MS) + 'ms. Confirm the ' +
                    'customer has a first visit on the route board.'
          });
        }
        Logger.log('ensureWeeklyServiceVisit_: claim lost for ' + pid + ' on ' + date +
                   '; not appending. Flagged for review.');
        return { ok: true, created: false, pending: true, pool_id: pid, scheduled_date: date };
      }
    }

    var res = createScheduledVisit_(Object.assign({
      pool_id: pid,
      scheduled_date: date,
      visit_type: 'weekly_service',
      status: 'scheduled'
    }, extra || {}));
    return res.ok ? { ok: true, created: true, row: res.row } : res;
  } catch (e) {
    // A missing first visit is recoverable; a failed signature is not.
    Logger.log('ensureWeeklyServiceVisit_ failed (non-blocking): ' + e);
    return { ok: false, error: String(e) };
  }
}

// Returns the scheduled_visit_id of a live weekly_service visit for this pool on
// this date, or '' if there is none. Cancelled rows do not block a new one.
function findWeeklyServiceVisit_(poolId, dateIso) {
  try {
    var sheet = ensureScheduledVisitsSheet_();
    if (sheet.getLastRow() < 2) return '';
    var data = sheet.getDataRange().getValues();
    var h = {};
    data[0].forEach(function (x, i) { h[String(x || '').trim().toLowerCase().replace(/ /g, '_')] = i; });
    if (h.pool_id === undefined || h.scheduled_date === undefined || h.visit_type === undefined) return '';

    for (var i = 1; i < data.length; i++) {
      if (String(data[i][h.pool_id] || '').trim() !== String(poolId).trim()) continue;
      if (String(data[i][h.visit_type] || '').trim() !== 'weekly_service') continue;
      var d = data[i][h.scheduled_date];
      var iso = (d instanceof Date && !isNaN(d.getTime()))
        ? Utilities.formatDate(d, Session.getScriptTimeZone() || 'America/Chicago', 'yyyy-MM-dd')
        : String(d || '').trim();
      if (iso !== String(dateIso).trim()) continue;
      var status = h.status !== undefined ? String(data[i][h.status] || '').trim().toLowerCase() : '';
      if (status === 'cancelled') continue;
      return String(data[i][h.scheduled_visit_id !== undefined ? h.scheduled_visit_id : 0] || 'existing');
    }
    return '';
  } catch (e) {
    Logger.log('findWeeklyServiceVisit_ failed (non-blocking): ' + e);
    return '';
  }
}

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
