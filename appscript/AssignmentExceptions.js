// ── Assignment exceptions ────────────────────────────────────────────────────
//
// Durable storage for the things the scheduler could not do cleanly.
//
// Before this existed, chooseAssignment_ built an `exceptions` array, attached
// it to the chosen assignment, and sendAssignmentExceptionAlert_ emailed it.
// Then it was gone. Nothing was written anywhere, so an Action Queue card would
// have read an empty set no matter what had happened.
//
// Order of operations is fixed: PERSIST FIRST, THEN EMAIL. An email that fails
// to send must not also lose the record, and a record that exists is what makes
// the work visible after everyone has archived the alert.
//
// ⚠️ Script properties are NOT a durable ledger — claimDedupAction_ keys expire
// and the store caps at 50 entries. This sheet is the source of truth; dedup
// primitives only guard races.

var ASSIGNMENT_EXCEPTION_HEADERS = [
  'exception_id', 'pool_id', 'quote_id', 'type', 'detail',
  'created_at', 'status', 'resolved_at', 'resolved_by'
];

var AE_STATUS_OPEN = 'open';
var AE_STATUS_RESOLVED = 'resolved';

function aeSheet_() {
  var ss = SpreadsheetApp.openById(
    typeof ROUTES_SPREADSHEET_ID !== 'undefined'
      ? ROUTES_SPREADSHEET_ID : '1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM');
  var sheet = ss.getSheetByName('Assignment_Exceptions');
  if (!sheet) {
    sheet = ss.insertSheet('Assignment_Exceptions');
    sheet.getRange(1, 1, 1, ASSIGNMENT_EXCEPTION_HEADERS.length)
      .setValues([ASSIGNMENT_EXCEPTION_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function aeRows_() {
  try {
    return sheetToObjects_(aeSheet_()).rows || [];
  } catch (e) {
    Logger.log('aeRows_ failed (non-blocking): ' + e);
    return [];
  }
}

function aeIsOpen_(row) {
  var s = String(row.status || '').trim().toLowerCase();
  return s !== AE_STATUS_RESOLVED && s !== 'dismissed';
}

// Writes one exception. Idempotent on the SHEET: an identical open exception for
// the same pool/quote is refreshed rather than duplicated, so a customer
// reopening a signing link cannot fill the sheet with copies.
function recordAssignmentException_(data) {
  try {
    var d = data || {};
    var type = String(d.type || '').trim();
    if (!type) return { ok: false, error: 'type is required' };

    var poolId = String(d.pool_id || '').trim();
    var quoteId = String(d.quote_id || '').trim();
    if (!poolId && !quoteId) return { ok: false, error: 'pool_id or quote_id is required' };

    var sheet = aeSheet_();
    var existing = aeRows_().filter(function (r) {
      return aeIsOpen_(r) &&
        String(r.type || '').trim() === type &&
        String(r.pool_id || '').trim() === poolId &&
        String(r.quote_id || '').trim() === quoteId;
    })[0];

    var now = nowIso_();
    if (existing) {
      // Same unresolved problem — keep one row and refresh its detail.
      softSetCell_(sheet, existing._rowNum, 'detail', String(d.detail || existing.detail || ''));
      return { ok: true, exception_id: String(existing.exception_id || ''), created: false };
    }

    var id = nextSequence_(sheet, 'exception_id', 'AEX', 5);
    appendObject_(sheet, {
      exception_id: id,
      pool_id: poolId,
      quote_id: quoteId,
      type: type,
      detail: String(d.detail || ''),
      created_at: now,
      status: AE_STATUS_OPEN,
      resolved_at: '',
      resolved_by: ''
    }, ASSIGNMENT_EXCEPTION_HEADERS);
    return { ok: true, exception_id: id, created: true };
  } catch (e) {
    // Never block signing or assignment because an exception could not be filed.
    Logger.log('recordAssignmentException_ failed (non-blocking): ' + e);
    return { ok: false, error: String(e) };
  }
}

// Persist every exception chooseAssignment_ produced. Called at assignment time,
// BEFORE the alert email.
function recordAssignmentExceptions_(poolId, quoteId, exceptions) {
  var out = [];
  (exceptions || []).forEach(function (ex) {
    var res = recordAssignmentException_({
      pool_id: poolId, quote_id: quoteId,
      type: String(ex.type || 'assignment'), detail: String(ex.detail || '')
    });
    if (res.ok) out.push(res.exception_id);
  });
  return out;
}

function handleGetAssignmentExceptions_(payload) {
  try {
    var includeResolved = payload && payload.include_resolved === true;
    var rows = aeRows_().filter(function (r) {
      return String(r.exception_id || '').trim() && (includeResolved || aeIsOpen_(r));
    });
    return {
      ok: true,
      exceptions: rows.map(function (r) {
        return {
          exception_id: String(r.exception_id || ''),
          pool_id: String(r.pool_id || ''),
          quote_id: String(r.quote_id || ''),
          type: String(r.type || ''),
          detail: String(r.detail || ''),
          created_at: String(r.created_at || ''),
          status: aeIsOpen_(r) ? AE_STATUS_OPEN : AE_STATUS_RESOLVED,
          resolved_at: String(r.resolved_at || ''),
          resolved_by: String(r.resolved_by || '')
        };
      }).sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); })
    };
  } catch (e) {
    return { ok: false, error: 'handleGetAssignmentExceptions_ Error: ' + e };
  }
}

function handleResolveAssignmentException_(payload) {
  try {
    var id = String((payload && payload.exception_id) || '').trim();
    if (!id) return { ok: false, error: 'exception_id is required.' };
    var sheet = aeSheet_();
    var row = findRowByValue_(sheet, 'exception_id', id);
    if (!row) return { ok: false, error: 'Exception not found: ' + id };
    softSetCell_(sheet, row._rowNum, 'status', AE_STATUS_RESOLVED);
    softSetCell_(sheet, row._rowNum, 'resolved_at', nowIso_());
    softSetCell_(sheet, row._rowNum, 'resolved_by', String((payload && payload.resolved_by) || ''));
    return { ok: true, exception_id: id };
  } catch (e) {
    return { ok: false, error: 'handleResolveAssignmentException_ Error: ' + e };
  }
}
