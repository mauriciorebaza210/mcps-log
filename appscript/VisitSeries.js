// ─── Visit series: list, cancel, extend ──────────────────────────────────────
//
// A "temporary weekly series" is what scheduleTemporaryWeeklyVisits writes: N
// Scheduled_Visits rows, one per consecutive week, on the same weekday with the
// same technician. Creating one has always worked. Seeing what a pool already
// has, and shortening or lengthening it, did not — the only lever was to re-run
// the creator with replace_existing, which cancels every temporary row on that
// pool regardless of which series it belonged to.
//
// Rather than add a Visit_Series ledger sheet and migrate existing rows, this
// derives series identity from what those rows already carry:
//
//   notes       "temporary_weekly:<startWeek>:<count> <reason>"   ← series identity
//   visit_type  "temporary_week_3" | "first_month_week_2"         ← position in series
//
// Grouping on those is enough to list, cancel and extend without a migration.
// Rows written before the notes token existed still group by pool + family, so
// nothing is invisible.
//
// Invariants:
//   - History is never rewritten. Only rows that are still `scheduled` AND dated
//     today or later can be cancelled; completed, skipped and past visits stay.
//   - Extend is idempotent. A date that already has a live row for the pool is
//     never doubled up.
//   - 26 weeks is the ceiling for a series, matching the creator's clamp.

var VS_ROUTES_SS_ID = '1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM';
var VS_TZ           = 'America/Chicago';
var VS_MAX_WEEKS    = 26;
var VS_DAYS         = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function vsHeader_(h) {
  return String(h == null ? '' : h).trim().toLowerCase().replace(/ /g, '_');
}

function vsSheet_() {
  if (typeof ensureScheduledVisitsSheet_ === 'function') return ensureScheduledVisitsSheet_();
  return SpreadsheetApp.openById(VS_ROUTES_SS_ID).getSheetByName('Scheduled_Visits');
}

function vsRows_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  var data = sheet.getDataRange().getValues();
  var h = data[0].map(vsHeader_);
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = { _row: i + 1 };
    for (var c = 0; c < h.length; c++) if (h[c]) o[h[c]] = data[i][c];
    if (String(o.pool_id || '').trim()) out.push(o);
  }
  return out;
}

function vsToday_() {
  return Utilities.formatDate(new Date(), VS_TZ, 'yyyy-MM-dd');
}

// Sheets may hand back a Date or a string; normalise both to yyyy-MM-dd.
function vsYmd_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, VS_TZ, 'yyyy-MM-dd');
  }
  var s = String(value == null ? '' : value).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function vsAddDays_(ymd, days) {
  if (typeof addDaysToDate_ === 'function') return addDaysToDate_(ymd, days);
  var d = new Date(ymd + 'T12:00:00');
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, VS_TZ, 'yyyy-MM-dd');
}

function vsWeekStart_(ymd) {
  if (typeof getWeekStartForDate_ === 'function') return getWeekStartForDate_(ymd);
  var d = new Date(ymd + 'T12:00:00');
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() - (d.getDay() === 0 ? 6 : d.getDay() - 1));
  return Utilities.formatDate(d, VS_TZ, 'yyyy-MM-dd');
}

function vsWeekdayName_(ymd) {
  var d = new Date(ymd + 'T12:00:00');
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, VS_TZ, 'EEEE');
}

// Which series family a visit_type belongs to. Only these two are managed here —
// startups and one-offs are not weekly series and must not be swept up.
function vsFamily_(visitType) {
  var t = String(visitType || '').trim().toLowerCase();
  if (t.indexOf('temporary_week_') === 0) return 'temporary';
  if (t.indexOf('first_month_week_') === 0) return 'first_month';
  return '';
}

function vsPositionOf_(visitType) {
  var m = String(visitType || '').match(/_(\d+)$/);
  return m ? Number(m[1]) : 0;
}

// The notes token the creator writes, e.g. "temporary_weekly:2026-09-07:6".
function vsNoteToken_(notes) {
  var m = String(notes || '').match(/temporary_weekly:(\d{4}-\d{2}-\d{2}):(\d+)/);
  return m ? m[0] : '';
}

function vsReasonOf_(notes, token) {
  var s = String(notes || '');
  if (token) s = s.split(token).join('');
  return s.trim();
}

function vsStatusOf_(row) {
  var s = String(row.status == null ? '' : row.status).trim().toLowerCase();
  return s || 'scheduled';   // blank has always meant scheduled
}

// ─── List ────────────────────────────────────────────────────────────────────
// payload: { pool_id? , include_finished? }
// Without pool_id every pool's series is returned, so the planner can show the
// whole book at once.
function vsListSeries_(payload) {
  var poolFilter = String((payload && payload.pool_id) || '').trim().toUpperCase();
  var includeFinished = !!(payload && payload.include_finished);
  var today = vsToday_();
  var rows = vsRows_(vsSheet_());
  var groups = {};
  var order = [];

  rows.forEach(function (r) {
    var family = vsFamily_(r.visit_type);
    if (!family) return;
    var poolId = String(r.pool_id || '').trim();
    if (poolFilter && poolId.toUpperCase() !== poolFilter) return;

    var token = vsNoteToken_(r.notes);
    // Fall back to the family so pre-token rows still form one series per pool.
    var key = poolId.toUpperCase() + '||' + (token || family);
    if (!groups[key]) {
      groups[key] = {
        series_key: key,
        pool_id: poolId,
        customer_name: String(r.customer_name || '').trim(),
        service_type: String(r.service_type || '').trim(),
        series_type: family,
        reason: vsReasonOf_(r.notes, token),
        derived_from_notes: !!token,
        rows: []
      };
      order.push(key);
    }
    var g = groups[key];
    if (!g.customer_name && r.customer_name) g.customer_name = String(r.customer_name).trim();
    g.rows.push({
      _row: r._row,
      date: vsYmd_(r.scheduled_date),
      status: vsStatusOf_(r),
      technician: String(r.assigned_technician || '').trim(),
      position: vsPositionOf_(r.visit_type),
      visit_type: String(r.visit_type || '').trim()
    });
  });

  var out = order.map(function (key) {
    var g = groups[key];
    g.rows.sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });

    var live = g.rows.filter(function (r) { return r.status === 'scheduled'; });
    var future = live.filter(function (r) { return r.date && r.date >= today; });
    var counts = { scheduled: 0, completed: 0, skipped: 0, cancelled: 0 };
    g.rows.forEach(function (r) { if (counts[r.status] !== undefined) counts[r.status]++; });

    var dated = g.rows.filter(function (r) { return !!r.date; });
    var activeDated = g.rows.filter(function (r) { return !!r.date && r.status !== 'cancelled'; });
    var last = activeDated.length ? activeDated[activeDated.length - 1] : null;
    var first = activeDated.length ? activeDated[0] : null;

    // Day and technician come from the next future visit when there is one, else
    // the last real visit — that is what an extension would continue.
    var anchor = future.length ? future[0] : last;

    return {
      series_key: g.series_key,
      pool_id: g.pool_id,
      customer_name: g.customer_name,
      service_type: g.service_type,
      series_type: g.series_type,
      reason: g.reason,
      derived_from_notes: g.derived_from_notes,
      day_of_week: anchor ? vsWeekdayName_(anchor.date) : '',
      technician: anchor ? anchor.technician : '',
      start_date: first ? first.date : '',
      end_date: last ? last.date : '',
      start_week: first ? vsWeekStart_(first.date) : '',
      end_week: last ? vsWeekStart_(last.date) : '',
      total: g.rows.length,
      counts: counts,
      remaining: future.length,
      next_date: future.length ? future[0].date : '',
      max_position: g.rows.reduce(function (m, r) { return Math.max(m, r.position); }, 0),
      can_cancel: future.length > 0,
      can_extend: future.length > 0 || (!!last && last.date >= today),
      active: future.length > 0,
      dated_count: dated.length
    };
  }).filter(function (s) {
    return includeFinished ? true : s.remaining > 0;
  }).sort(function (a, b) {
    return String(a.next_date || a.end_date).localeCompare(String(b.next_date || b.end_date));
  });

  return { ok: true, series: out, today: today };
}

function vsFindSeries_(seriesKey, poolId) {
  var all = vsListSeries_({ pool_id: poolId || '', include_finished: true });
  if (!all.ok) return null;
  var key = String(seriesKey || '');
  for (var i = 0; i < all.series.length; i++) {
    if (all.series[i].series_key === key) return all.series[i];
  }
  return null;
}

// Re-reads the raw rows for a series so we hold live _row numbers at write time.
function vsSeriesRows_(seriesKey) {
  var rows = vsRows_(vsSheet_());
  var out = [];
  rows.forEach(function (r) {
    var family = vsFamily_(r.visit_type);
    if (!family) return;
    var token = vsNoteToken_(r.notes);
    var key = String(r.pool_id || '').trim().toUpperCase() + '||' + (token || family);
    if (key !== String(seriesKey || '')) return;
    out.push({
      _row: r._row,
      date: vsYmd_(r.scheduled_date),
      status: vsStatusOf_(r),
      technician: String(r.assigned_technician || '').trim(),
      visit_type: String(r.visit_type || '').trim(),
      position: vsPositionOf_(r.visit_type)
    });
  });
  return out;
}

// ─── Cancel ──────────────────────────────────────────────────────────────────
// Cancels only visits still ahead of us. Completed, skipped and already-past
// visits are history and stay exactly as they are.
// payload: { series_key, pool_id? , keep_through? (yyyy-MM-dd) }
function vsCancelSeries_(auth, payload) {
  var seriesKey = String((payload && payload.series_key) || '').trim();
  if (!seriesKey) return { ok: false, error: 'series_key required.' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'Another visit change is already running.' };
  try {
    var sheet = vsSheet_();
    if (!sheet) return { ok: false, error: 'Scheduled_Visits sheet is unavailable.' };
    var headers = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0].map(vsHeader_);
    var statusCol = headers.indexOf('status');
    if (statusCol === -1) return { ok: false, error: 'Scheduled_Visits has no status column.' };
    var notesCol = headers.indexOf('notes');

    var today = vsToday_();
    // keep_through shortens instead of cancelling outright: everything after the
    // given date goes, everything up to and including it stays.
    var cutoff = vsYmd_(payload && payload.keep_through);
    var floor = cutoff && cutoff > today ? cutoff : today;

    var rows = vsSeriesRows_(seriesKey);
    if (!rows.length) return { ok: false, error: 'Series not found.' };

    var cancelled = 0;
    var kept = 0;
    rows.forEach(function (r) {
      var future = r.date && (cutoff ? r.date > floor : r.date >= floor);
      if (r.status !== 'scheduled' || !future) { kept++; return; }
      sheet.getRange(r._row, statusCol + 1).setValue('cancelled');
      if (notesCol !== -1) {
        var existing = String(sheet.getRange(r._row, notesCol + 1).getValue() || '');
        var stamp = (cutoff ? 'shortened' : 'cancelled') + ' by ' +
                    ((auth && (auth.name || auth.username)) || 'admin') + ' ' + today;
        sheet.getRange(r._row, notesCol + 1).setValue((existing + ' | ' + stamp).trim());
      }
      if (typeof bustScheduledVisitRouteCache_ === 'function') bustScheduledVisitRouteCache_(r.date);
      cancelled++;
    });

    return { ok: true, series_key: seriesKey, cancelled_count: cancelled, kept_count: kept,
             mode: cutoff ? 'shortened' : 'cancelled', keep_through: cutoff || '' };
  } catch (e) {
    Logger.log('vsCancelSeries_ failed: ' + e);
    return { ok: false, error: String(e) };
  } finally {
    lock.releaseLock();
  }
}

// ─── Extend ──────────────────────────────────────────────────────────────────
// Appends N more weekly visits after the series' last dated visit, on the same
// weekday with the same technician. Idempotent: a date that already has a live
// row for this pool is skipped rather than duplicated.
// payload: { series_key, weeks, technician? , day_of_week? }
function vsExtendSeries_(auth, payload) {
  var seriesKey = String((payload && payload.series_key) || '').trim();
  if (!seriesKey) return { ok: false, error: 'series_key required.' };
  var weeks = Math.floor(Number(payload && payload.weeks) || 0);
  if (!(weeks >= 1)) return { ok: false, error: 'weeks must be 1 or more.' };
  if (weeks > VS_MAX_WEEKS) return { ok: false, error: 'weeks cannot exceed ' + VS_MAX_WEEKS + '.' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'Another visit change is already running.' };
  try {
    var series = vsFindSeries_(seriesKey);
    if (!series) return { ok: false, error: 'Series not found.' };
    if (series.total + weeks > VS_MAX_WEEKS) {
      return { ok: false, error: 'A series cannot exceed ' + VS_MAX_WEEKS + ' visits (this one has ' + series.total + ').' };
    }

    var rows = vsSeriesRows_(seriesKey);
    var live = rows.filter(function (r) { return r.status !== 'cancelled' && r.date; })
                   .sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
    var anchorDate = live.length ? live[live.length - 1].date : '';
    if (!anchorDate) return { ok: false, error: 'Series has no dated visit to extend from.' };

    var day = String((payload && payload.day_of_week) || series.day_of_week || vsWeekdayName_(anchorDate)).trim();
    if (VS_DAYS.indexOf(day) === -1) return { ok: false, error: 'day_of_week must be Monday-Saturday.' };
    var tech = String((payload && payload.technician) || series.technician || '').trim();

    // Every live date for the pool, so an extension never lands on an existing visit.
    var taken = {};
    vsRows_(vsSheet_()).forEach(function (r) {
      if (String(r.pool_id || '').trim().toUpperCase() !== String(series.pool_id).toUpperCase()) return;
      if (vsStatusOf_(r) === 'cancelled') return;
      var d = vsYmd_(r.scheduled_date);
      if (d) taken[d] = true;
    });

    var prefix = series.series_type === 'first_month' ? 'first_month_week_' : 'temporary_week_';
    var position = series.max_position;
    var created = [];
    var skipped = [];
    var cursor = anchorDate;

    for (var i = 0; i < weeks; i++) {
      cursor = vsAddDays_(cursor, 7);
      if (!cursor) break;
      // Guard against a weekday drift if the anchor was off-pattern.
      if (vsWeekdayName_(cursor) !== day) {
        var wk = vsWeekStart_(cursor);
        var corrected = typeof getDayDate_ === 'function' ? getDayDate_(day, wk) : '';
        if (corrected) cursor = corrected;
      }
      if (taken[cursor]) { skipped.push(cursor); continue; }
      position++;
      var res = createScheduledVisit_({
        pool_id:             series.pool_id,
        customer_name:       series.customer_name,
        service_type:        series.service_type || 'Weekly Full Service',
        visit_type:          prefix + position,
        scheduled_date:      cursor,
        assigned_technician: tech,
        status:              'scheduled',
        // Carry the series token so the new rows group with the existing ones.
        notes:               (series.derived_from_notes ? seriesKey.split('||')[1] + ' ' : '') +
                             (series.reason || 'temporary_weekly') +
                             ' | extended by ' + ((auth && (auth.name || auth.username)) || 'admin'),
        created_by:          (auth && (auth.username || auth.name)) || 'admin'
      });
      if (res && res.ok === false) { skipped.push(cursor); position--; continue; }
      taken[cursor] = true;
      created.push({ date: cursor, visit_type: prefix + position });
      if (typeof bustScheduledVisitRouteCache_ === 'function') bustScheduledVisitRouteCache_(cursor);
    }

    return { ok: true, series_key: seriesKey, created_count: created.length,
             created: created, skipped_dates: skipped, day_of_week: day, technician: tech };
  } catch (e) {
    Logger.log('vsExtendSeries_ failed: ' + e);
    return { ok: false, error: String(e) };
  } finally {
    lock.releaseLock();
  }
}

function handleVisitSeriesAction_(action, auth, payload) {
  if (!auth || !auth.ok) return { ok: false, error: 'Unauthorized' };
  if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return { ok: false, error: 'Admin access required.' };
  switch (action) {
    case 'visit_series_list':   return vsListSeries_(payload);
    case 'visit_series_cancel': return vsCancelSeries_(auth, payload);
    case 'visit_series_extend': return vsExtendSeries_(auth, payload);
    default: return { ok: false, error: 'Unknown visit series action: ' + action };
  }
}
