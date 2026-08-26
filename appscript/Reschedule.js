// Reschedule.gs
// Bulk route rescheduling: preflight, apply, revert, history, and Comms audience.
//
// Design rules:
// - Never call movePool(); that path sends per-pool customer email.
// - Apply revalidates under ScriptLock before writing.
// - Week/range rollback captures the prior override for every pool/week.
// - Batch-owned Scheduled_Visits weekly_override rows are cancelled on revert.

var RS_ROUTES_SS_ID = '1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM';
var RS_CRM_SS_ID    = '1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E';
var RS_TZ           = 'America/Chicago';
var RS_MAX_ITEMS    = 300;
var RS_MAX_WEEKS    = 26;

var RS_BATCH_HEADERS = [
  'batch_id','status','scope','effective_week','end_week','reason_code',
  'message_subject','message_body','created_by','created_at','applied_at',
  'reverted_at','item_count','applied_count','failed_count','notify_enabled',
  'campaign_id','notified_count','cursor','error','request_hash'
];

var RS_ITEM_HEADERS = [
  'batch_id','item_id','pool_id','week_start','customer_name',
  'prev_day','prev_operator','prev_pinned',
  'prev_override_day','prev_override_operator','prev_had_override',
  'prev_override_batch_id','prev_override_created_at','prev_visit_json',
  'new_day','new_operator','status','skip_reason','notify_status',
  'notified_at','error'
];

var RS_WARMUP_HEADERS = [
  'week_start','source_batch_id','status','created_at','processed_at','error'
];

var RS_SV_HEADERS = [
  'scheduled_visit_id','pool_id','customer_name','service_type','visit_type',
  'scheduled_date','assigned_technician','status','completed_at','completed_by',
  'chem_log_ref','notes','created_at','created_by'
];

function rsHeader_(h) {
  return String(h || '').trim().toLowerCase().replace(/ /g, '_');
}

function rsNowIso_() {
  return new Date().toISOString();
}

function rsBatchSheet_() {
  return rsEnsureSheet_(SpreadsheetApp.getActiveSpreadsheet(), 'Reschedule_Batches', RS_BATCH_HEADERS);
}

function rsItemSheet_() {
  return rsEnsureSheet_(SpreadsheetApp.getActiveSpreadsheet(), 'Reschedule_Items', RS_ITEM_HEADERS);
}

function rsWarmupSheet_() {
  return rsEnsureSheet_(SpreadsheetApp.getActiveSpreadsheet(), 'Reschedule_Distance_Warmups', RS_WARMUP_HEADERS);
}

function rsEnsureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  var lastCol = Math.max(1, sheet.getLastColumn());
  var existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(rsHeader_);
  var missing = [];
  headers.forEach(function (h) {
    if (existing.indexOf(h) === -1) {
      missing.push(h);
      existing.push(h);
    }
  });
  if (missing.length) sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
  return sheet;
}

function rsHeaders_(sheet) {
  if (!sheet || sheet.getLastColumn() < 1) return [];
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(rsHeader_);
}

function rsRows_(sheet) {
  var headers = rsHeaders_(sheet);
  if (!headers.length || sheet.getLastRow() < 2) return [];
  var vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  return vals.map(function (row, i) {
    var o = { _row: i + 2 };
    headers.forEach(function (h, c) { o[h] = row[c]; });
    return o;
  });
}

function rsAppendRows_(sheet, objs) {
  if (!objs || !objs.length) return 0;
  var headers = rsHeaders_(sheet);
  var matrix = objs.map(function (obj) {
    return headers.map(function (h) {
      return obj[h] !== undefined && obj[h] !== null ? obj[h] : '';
    });
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, matrix.length, headers.length).setValues(matrix);
  return matrix.length;
}

function rsPatchRow_(sheet, rowNum, patch) {
  var headers = rsHeaders_(sheet);
  var range = sheet.getRange(rowNum, 1, 1, headers.length);
  var row = range.getValues()[0];
  headers.forEach(function (h, i) {
    if (patch[h] !== undefined) row[i] = patch[h];
  });
  range.setValues([row]);
}

function rsFindBatch_(batchId) {
  var id = String(batchId || '').trim();
  if (!id) return null;
  var found = null;
  rsRows_(rsBatchSheet_()).forEach(function (b) {
    if (String(b.batch_id) === id) found = b;
  });
  return found;
}

function rsBatchItems_(batchId) {
  return rsRows_(rsItemSheet_()).filter(function (r) {
    return String(r.batch_id) === String(batchId);
  });
}

function rsNormalizeDay_(day) {
  var raw = String(day || '').trim().toLowerCase();
  var days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  for (var i = 0; i < days.length; i++) {
    if (days[i].toLowerCase() === raw) return days[i];
  }
  return '';
}

function rsParseYmd_(value) {
  var s = String(value || '').trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function rsYmd_(date) {
  return Utilities.formatDate(date, RS_TZ, 'yyyy-MM-dd');
}

function rsWeekStartForDate_(value) {
  if (typeof getWeekStartForDate_ === 'function') return getWeekStartForDate_(value);
  var d = value instanceof Date ? new Date(value.getTime()) : rsParseYmd_(value);
  if (!d || isNaN(d.getTime())) return '';
  var day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return rsYmd_(d);
}

function rsCurrentWeekStart_() {
  return typeof getWeekStart_ === 'function' ? getWeekStart_() : rsWeekStartForDate_(new Date());
}

function rsDayDate_(dayName, weekStart) {
  return typeof getDayDate_ === 'function' ? getDayDate_(dayName, weekStart) : (function () {
    var days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var idx = days.indexOf(dayName);
    var base = rsParseYmd_(weekStart);
    if (idx === -1 || !base) return '';
    base.setDate(base.getDate() + idx);
    return rsYmd_(base);
  })();
}

function rsExpandWeeks_(startWeek, endWeek) {
  var start = rsParseYmd_(startWeek);
  var end = rsParseYmd_(endWeek || startWeek);
  if (!start || !end || end < start) return [];
  var out = [];
  var cur = new Date(start.getTime());
  while (cur <= end && out.length <= RS_MAX_WEEKS) {
    out.push(rsYmd_(cur));
    cur.setDate(cur.getDate() + 7);
  }
  return out;
}

function rsAddWeeks_(weekStart, count) {
  var d = rsParseYmd_(weekStart);
  if (!d) return '';
  d.setDate(d.getDate() + (Number(count) || 0) * 7);
  return rsYmd_(d);
}

function rsIsFutureWeek_(weekStart) {
  return String(weekStart || '') > rsCurrentWeekStart_();
}

// Why a target day cannot be written, or '' if it can.
//
// There is exactly one reason: the day is already gone. A date in the past cannot
// be scheduled into because the work either happened or didn't.
//
// Explicitly NOT reasons:
//   - Route_Lock rows. That sheet exists to stop calculateRoutes() clobbering a
//     hand-edited day, but autoRecalculateRoutes() is an intentional no-op and
//     nothing in the codebase ever writes a lock row — it guards against something
//     that cannot happen, using a table nobody can fill.
//   - Today, at any hour. Adding a stop to today's route mid-morning is normal
//     work, not a mistake to be prevented. The technician's app picks it up on the
//     next refresh.
function rsTargetClosedReason_(dayName, weekStart) {
  var targetDate = rsDayDate_(dayName, weekStart);
  if (!targetDate) return 'is not a valid date';
  var today = Utilities.formatDate(new Date(), RS_TZ, 'yyyy-MM-dd');
  return targetDate < today ? 'has already passed' : '';
}

function rsTargetLocked_(dayName, weekStart) {
  return !!rsTargetClosedReason_(dayName, weekStart);
}

function rsNormalizeInput_(payload) {
  payload = payload || {};
  var scope = String(payload.scope || 'week').trim().toLowerCase();
  if (scope === 'this_week' || scope === 'one_time' || scope === 'one-time') scope = 'week';
  if (scope === 'weeks' || scope === 'multi_week' || scope === 'multi-week' || scope === 'temporary') scope = 'range';
  if (['week','range','permanent'].indexOf(scope) === -1) {
    return { ok: false, error: 'Invalid scope.' };
  }
  var effectiveWeek = String(payload.effective_week || payload.week_start || rsCurrentWeekStart_()).trim();
  effectiveWeek = rsWeekStartForDate_(effectiveWeek);
  if (!effectiveWeek) return { ok: false, error: 'effective_week is required.' };
  var requestedWeeks = Number(payload.duration_weeks || payload.week_count || payload.weeks_count || 0);
  var endWeek = scope === 'range'
    ? (payload.end_week
        ? rsWeekStartForDate_(payload.end_week)
        : (requestedWeeks > 0 ? rsAddWeeks_(effectiveWeek, requestedWeeks - 1) : ''))
    : effectiveWeek;
  if (!endWeek) return { ok: false, error: 'end_week is required for range moves.' };
  var weeks = scope === 'permanent' ? [effectiveWeek] : rsExpandWeeks_(effectiveWeek, endWeek);
  if (!weeks.length) return { ok: false, error: 'Invalid week range.' };
  if (weeks.length > RS_MAX_WEEKS) return { ok: false, error: 'Range cannot exceed ' + RS_MAX_WEEKS + ' weeks.' };

  var rawItems = payload.items || payload.moves || [];
  if (!Array.isArray(rawItems) || !rawItems.length) return { ok: false, error: 'At least one item is required.' };
  if (rawItems.length > RS_MAX_ITEMS) return { ok: false, error: 'Batch cannot exceed ' + RS_MAX_ITEMS + ' items.' };

  var seen = {};
  var items = rawItems.map(function (it) {
    var poolId = String(it.pool_id || it.poolId || '').trim();
    var day = rsNormalizeDay_(it.new_day || it.day || it.target_day);
    var op = String(it.new_operator || it.operator || it.target_operator || '').trim();
    return { pool_id: poolId, new_day: day, new_operator: op };
  });
  for (var i = 0; i < items.length; i++) {
    if (!items[i].pool_id) return { ok: false, error: 'Every item needs pool_id.' };
    if (!items[i].new_day) return { ok: false, error: 'Every item needs a valid new_day.' };
    var key = items[i].pool_id.toUpperCase();
    if (seen[key]) return { ok: false, error: 'Duplicate pool_id in batch: ' + items[i].pool_id };
    seen[key] = true;
  }

  return {
    ok: true,
    scope: scope,
    effective_week: effectiveWeek,
    end_week: endWeek,
    weeks: weeks,
    duration_weeks: weeks.length,
    items: items,
    batch_id: String(payload.batch_id || '').trim(),
    reason_code: String(payload.reason_code || '').trim(),
    message_subject: String(payload.message_subject || payload.subject || '').trim(),
    message_body: String(payload.message_body || payload.body_markup || '').trim(),
    notify_enabled: payload.notify_enabled === true || payload.notify_enabled === 'true',
    pin_permanent: payload.pin_permanent !== false,
    acknowledge_warnings: payload.acknowledge_warnings === true || payload.acknowledge_warnings === 'true'
  };
}

function rsRoutesContext_() {
  var ss = SpreadsheetApp.openById(RS_ROUTES_SS_ID);
  var sheet = ss.getSheetByName('Routes');
  if (!sheet || sheet.getLastRow() < 1) throw new Error('Routes sheet not found.');
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(rsHeader_);
  var byPool = {};
  var pidCol = headers.indexOf('pool_id');
  for (var i = 1; i < data.length; i++) {
    var pid = String(pidCol !== -1 ? data[i][pidCol] : '').trim();
    if (pid && !byPool[pid.toUpperCase()]) byPool[pid.toUpperCase()] = { rowIndex: i, row: data[i] };
  }
  return {
    ss: ss,
    sheet: sheet,
    data: data,
    headers: headers,
    col: function (name) { return headers.indexOf(name); },
    byPool: byPool
  };
}

function rsEnsureRoutesCol_(ctx, name) {
  var idx = ctx.headers.indexOf(name);
  if (idx !== -1) return idx;
  idx = ctx.headers.length;
  ctx.headers.push(name);
  ctx.data[0].push(name);
  ctx.sheet.getRange(1, idx + 1).setValue(name);
  for (var r = 1; r < ctx.data.length; r++) ctx.data[r][idx] = '';
  return idx;
}

function rsOperatorMap_() {
  var out = {};
  var ops = typeof getTechnicianOperators_ === 'function' ? getTechnicianOperators_() : [];
  ops.forEach(function (op) {
    var name = String(op.name || '').trim();
    if (!name) return;
    out[name.toLowerCase()] = {
      name: name,
      max: Number(op.maxPerDay) || 10,
      days: Array.isArray(op.days) ? op.days.map(function (d) { return String(d).toUpperCase(); }) : []
    };
  });
  return out;
}

function rsRouteRowInfo_(ctx, row) {
  var c = ctx.col;
  var val = function (name) {
    var idx = c(name);
    return idx === -1 ? '' : String(row[idx] || '').trim();
  };
  return {
    pool_id: val('pool_id'),
    customer_name: val('customer_name'),
    day: val('day_of_week'),
    operator: val('operator'),
    pinned: String(val('pinned')).toUpperCase() === 'TRUE',
    route_status: val('route_status').toLowerCase(),
    service: val('service'),
    monthly_week: val('monthly_week'),
    address: val('address'),
    city: val('city')
  };
}

function rsReadWeeklyOverrideRows_() {
  var ss = SpreadsheetApp.openById(RS_ROUTES_SS_ID);
  var sheet = typeof ensureWeeklyOverridesSheet_ === 'function'
    ? ensureWeeklyOverridesSheet_(ss)
    : rsEnsureSheet_(ss, 'Weekly_Overrides',
      ['week_start','pool_id','override_day','override_operator','created_at','batch_id']);
  rsEnsureSheet_(ss, 'Weekly_Overrides',
    ['week_start','pool_id','override_day','override_operator','created_at','batch_id']);
  var headers = rsHeaders_(sheet);
  var rows = rsRows_(sheet);
  return { sheet: sheet, headers: headers, rows: rows };
}

function rsOverrideKey_(poolId, weekStart) {
  return String(poolId || '').trim().toUpperCase() + '||' + String(weekStart || '').trim();
}

function rsEffectiveOverridesByWeek_(weekStart) {
  var rows = rsReadWeeklyOverrideRows_().rows;
  var out = {};
  rows.forEach(function (r) {
    var ws = rsWeekStartForDate_(r.week_start);
    if (ws !== weekStart) return;
    var pid = String(r.pool_id || '').trim();
    if (!pid) return;
    out[pid.toUpperCase()] = {
      day: String(r.override_day || '').trim(),
      operator: String(r.override_operator || '').trim(),
      batch_id: String(r.batch_id || '').trim(),
      created_at: String(r.created_at || '').trim()
    };
  });
  return out;
}

function rsCrmLookup_() {
  var out = {};
  try {
    var ss = SpreadsheetApp.openById(RS_CRM_SS_ID);
    var sheet = ss.getSheetByName('Quotes') || ss.getSheetByName('Signed_Customers');
    if (!sheet || sheet.getLastRow() < 2) return out;
    var data = sheet.getDataRange().getValues();
    var h = data[0].map(rsHeader_);
    var col = function (n) { return h.indexOf(n); };
    for (var i = 1; i < data.length; i++) {
      var pid = String(col('pool_id') !== -1 ? data[i][col('pool_id')] : '').trim();
      if (!pid) continue;
      out[pid.toUpperCase()] = {
        email: col('email') !== -1 ? String(data[i][col('email')] || '').trim() : '',
        first_name: col('first_name') !== -1 ? String(data[i][col('first_name')] || '').trim() : '',
        last_name: col('last_name') !== -1 ? String(data[i][col('last_name')] || '').trim() : '',
        customer_name: col('customer_name') !== -1 ? String(data[i][col('customer_name')] || '').trim() : '',
        quote_id: col('quote_id') !== -1 ? String(data[i][col('quote_id')] || '').trim() : '',
        area: col('area') !== -1 ? String(data[i][col('area')] || '').trim() : '',
        address: col('address') !== -1 ? String(data[i][col('address')] || '').trim() : '',
        city: col('city') !== -1 ? String(data[i][col('city')] || '').trim() : '',
        schedule_notified_at: col('schedule_notified_at') !== -1 ? String(data[i][col('schedule_notified_at')] || '').trim() : ''
      };
    }
  } catch (e) {}
  return out;
}

function rsOptOutSet_() {
  if (typeof commsOptOutSet_ === 'function') return commsOptOutSet_('service_update');
  return {};
}

function rsStartupVisitSet_() {
  var out = {};
  try {
    var ss = SpreadsheetApp.openById(RS_ROUTES_SS_ID);
    var sheet = ss.getSheetByName('Scheduled_Visits');
    if (!sheet || sheet.getLastRow() < 2) return out;
    var data = sheet.getDataRange().getValues();
    var h = data[0].map(rsHeader_);
    var pidCol = h.indexOf('pool_id'), vtCol = h.indexOf('visit_type'), stCol = h.indexOf('status');
    for (var i = 1; i < data.length; i++) {
      var status = stCol !== -1 ? String(data[i][stCol] || '').trim().toLowerCase() : '';
      if (status && status !== 'scheduled') continue;
      var vt = vtCol !== -1 ? String(data[i][vtCol] || '').trim().toLowerCase() : '';
      if (vt.indexOf('startup_') !== 0 && vt.indexOf('first_month_') !== 0) continue;
      var pid = pidCol !== -1 ? String(data[i][pidCol] || '').trim().toUpperCase() : '';
      if (pid) out[pid] = true;
    }
  } catch (e) {}
  return out;
}

function rsBuildStopsForWeek_(ctx, weekStart) {
  var overrides = rsEffectiveOverridesByWeek_(weekStart);
  var stops = [];
  for (var i = 1; i < ctx.data.length; i++) {
    var row = ctx.data[i];
    var info = rsRouteRowInfo_(ctx, row);
    if (!info.pool_id) continue;
    if (typeof isPoolVisibleForWeek_ === 'function' && !isPoolVisibleForWeek_(row, ctx.col, weekStart)) continue;
    if (info.route_status === 'inactive' || info.route_status === 'startup_complete') continue;
    var ov = overrides[info.pool_id.toUpperCase()] || {};
    var day = ov.day || info.day;
    var op = ov.operator || info.operator;
    if (String(info.service || '').toLowerCase().indexOf('monthly') !== -1) {
      if (!info.monthly_week) continue;
      if (typeof monthlyMatchesWeek_ === 'function' &&
          !monthlyMatchesWeek_(day, info.monthly_week, weekStart)) continue;
    }
    stops.push({
      pool_id: info.pool_id,
      day: day,
      operator: op,
      base_day: info.day,
      base_operator: info.operator
    });
  }
  return stops;
}

function rsPreflight_(payload) {
  var input = rsNormalizeInput_(payload);
  if (!input.ok) return input;

  var ctx = rsRoutesContext_();
  var ops = rsOperatorMap_();
  var crm = input.notify_enabled ? rsCrmLookup_() : {};
  var optouts = input.notify_enabled ? rsOptOutSet_() : {};
  var startupVisits = rsStartupVisitSet_();
  var verdicts = [];
  var capacity = {};
  var stopsByWeek = {};
  var targetByPool = {};

  input.weeks.forEach(function (week) {
    var stops = rsBuildStopsForWeek_(ctx, week);
    stopsByWeek[week] = stops;
    stops.forEach(function (s) {
      var key = week + '||' + (s.operator || 'UNASSIGNED') + '||' + s.day;
      if (!capacity[key]) capacity[key] = { week_start: week, operator: s.operator || 'UNASSIGNED', day: s.day, current: 0, projected: 0, max: 0, delta: 0 };
      capacity[key].current++;
      capacity[key].projected++;
    });
  });

  input.items.forEach(function (item) {
    var blockers = [];
    var warnings = [];
    var hit = ctx.byPool[item.pool_id.toUpperCase()];
    var info = hit ? rsRouteRowInfo_(ctx, hit.row) : null;

    if (!hit || !info) {
      blockers.push('Pool is not in Routes.');
    } else {
      if (info.route_status === 'inactive' || info.route_status === 'startup_complete') {
        blockers.push('Pool route_status is ' + info.route_status + '.');
      }
      if (info.pinned) warnings.push('Pool is pinned.');
      if (startupVisits[item.pool_id.toUpperCase()]) {
        warnings.push('Pool has in-flight startup/first-month visits.');
      }
    }

    var targetOp = item.new_operator || (info ? info.operator : '');
    targetByPool[item.pool_id.toUpperCase()] = {
      day: item.new_day,
      operator: targetOp || 'UNASSIGNED'
    };
    if (targetOp && targetOp.toUpperCase() !== 'UNASSIGNED') {
      var op = ops[targetOp.toLowerCase()];
      if (!op) blockers.push('Target operator is not an active technician.');
      else if (op.days.length && op.days.indexOf(item.new_day.toUpperCase()) === -1) {
        blockers.push('Target day is outside operator available_days.');
      }
    }

    input.weeks.forEach(function (week) {
      var closed = rsTargetClosedReason_(item.new_day, week);
      if (closed) blockers.push(item.new_day + ' of ' + week + ' ' + closed + '.');
      if (info && String(info.service || '').toLowerCase().indexOf('monthly') !== -1 &&
          typeof monthlyMatchesWeek_ === 'function' &&
          !monthlyMatchesWeek_(item.new_day, info.monthly_week, week)) {
        warnings.push('Monthly pool will not appear during week ' + week + ' on ' + item.new_day + '.');
      }
    });

    if (input.notify_enabled && info) {
      var c = crm[item.pool_id.toUpperCase()] || {};
      if (!c.email) warnings.push('No email on file; notification will skip.');
      else if (optouts[String(c.email).toLowerCase()]) warnings.push('Customer has an all-scope opt-out.');
      if (c.schedule_notified_at) {
        var t = Date.parse(c.schedule_notified_at);
        if (!isNaN(t) && Date.now() - t < 14 * 86400000) {
          warnings.push('Customer was told a schedule day within the last 14 days.');
        }
      }
    }

    verdicts.push({
      pool_id: item.pool_id,
      customer_name: info ? info.customer_name : '',
      current_day: info ? info.day : '',
      current_operator: info ? info.operator : '',
      new_day: item.new_day,
      new_operator: targetOp,
      blockers: blockers,
      warnings: warnings,
      status: blockers.length ? 'blocked' : (warnings.length ? 'warning' : 'ok')
    });

    if (info) {
      input.weeks.forEach(function (week) {
        var stops = stopsByWeek[week] || [];
        var current = null;
        stops.forEach(function (s) {
          if (s.pool_id.toUpperCase() === item.pool_id.toUpperCase()) current = s;
        });
        if (current) {
          var oldKey = week + '||' + (current.operator || 'UNASSIGNED') + '||' + current.day;
          if (!capacity[oldKey]) capacity[oldKey] = { week_start: week, operator: current.operator || 'UNASSIGNED', day: current.day, current: 0, projected: 0, max: 0, delta: 0 };
          capacity[oldKey].projected--;
          capacity[oldKey].delta--;
        }
        var newKey = week + '||' + (targetOp || 'UNASSIGNED') + '||' + item.new_day;
        if (!capacity[newKey]) capacity[newKey] = { week_start: week, operator: targetOp || 'UNASSIGNED', day: item.new_day, current: 0, projected: 0, max: 0, delta: 0 };
        capacity[newKey].projected++;
        capacity[newKey].delta++;
      });
    }
  });

  Object.keys(capacity).forEach(function (k) {
    var row = capacity[k];
    var op = ops[String(row.operator || '').toLowerCase()];
    row.max = op ? op.max : 0;
    row.over_capacity = !!(row.max && row.projected > row.max);
  });

  var capacityRows = Object.keys(capacity).map(function (k) { return capacity[k]; })
    .sort(function (a, b) {
      return String(a.week_start + a.day + a.operator).localeCompare(String(b.week_start + b.day + b.operator));
    });
  capacityRows.forEach(function (row) {
    if (row.over_capacity) {
      input.items.forEach(function (it) {
        var target = targetByPool[it.pool_id.toUpperCase()];
        if (target && target.operator === row.operator && target.day === row.day) {
          var v = verdicts.filter(function (x) { return x.pool_id === it.pool_id; })[0];
          if (v) {
            v.warnings.push('Target slot would exceed max_per_day (' + row.projected + '/' + row.max + ').');
            if (v.status === 'ok') v.status = 'warning';
          }
        }
      });
    }
  });

  return {
    ok: true,
    scope: input.scope,
    effective_week: input.effective_week,
    end_week: input.end_week,
    week_count: input.weeks.length,
    item_count: input.items.length,
    expanded_item_count: input.scope === 'permanent' ? input.items.length : input.items.length * input.weeks.length,
    blockers: verdicts.reduce(function (n, v) { return n + v.blockers.length; }, 0),
    warnings: verdicts.reduce(function (n, v) { return n + v.warnings.length; }, 0),
    verdicts: verdicts,
    capacity: capacityRows
  };
}

function rsEnsureScheduledVisitsSheet_() {
  if (typeof ensureScheduledVisitsSheet_ === 'function') return ensureScheduledVisitsSheet_();
  var ss = SpreadsheetApp.openById(RS_ROUTES_SS_ID);
  return rsEnsureSheet_(ss, 'Scheduled_Visits', RS_SV_HEADERS);
}

function rsScheduledVisitObjectFromRow_(headers, row) {
  var obj = {};
  headers.forEach(function (h, i) { obj[h] = row[i]; });
  return obj;
}

function rsScheduledVisitRow_(headers, obj) {
  return headers.map(function (h) {
    if (h === 'scheduled_visit_id' && !obj[h]) return Utilities.getUuid();
    if (h === 'created_at' && !obj[h]) return rsNowIso_();
    return obj[h] !== undefined && obj[h] !== null ? obj[h] : '';
  });
}

function rsSyncWeeklyOverrideVisits_(targets, routeInfoByPool, auth, batchId) {
  var sheet = rsEnsureScheduledVisitsSheet_();
  var headers = rsHeaders_(sheet);
  var data = sheet.getLastRow() >= 1
    ? sheet.getRange(1, 1, sheet.getLastRow(), headers.length).getValues()
    : [headers];
  var col = function (name) { return headers.indexOf(name); };
  var pidCol = col('pool_id'), vtCol = col('visit_type'), stCol = col('status'), notesCol = col('notes');
  var prevByKey = {};
  var newRows = [];
  var changed = false;

  targets.forEach(function (t) {
    var key = rsOverrideKey_(t.pool_id, t.week_start);
    var noteKey = 'weekly_override:' + t.week_start;
    var prev = [];
    for (var i = 1; i < data.length; i++) {
      var pid = pidCol !== -1 ? String(data[i][pidCol] || '').trim() : '';
      var vt = vtCol !== -1 ? String(data[i][vtCol] || '').trim() : '';
      var st = stCol !== -1 ? String(data[i][stCol] || '').trim().toLowerCase() : '';
      var notes = notesCol !== -1 ? String(data[i][notesCol] || '').trim() : '';
      if (pid === String(t.pool_id).trim() && vt === 'weekly_override' &&
          notes.indexOf(noteKey) !== -1 && st !== 'cancelled') {
        prev.push(rsScheduledVisitObjectFromRow_(headers, data[i]));
        if (stCol !== -1) data[i][stCol] = 'cancelled';
        changed = true;
      }
    }
    prevByKey[key] = prev;

    var info = routeInfoByPool[t.pool_id.toUpperCase()] || {};
    var targetDate = rsDayDate_(t.new_day, t.week_start);
    if (!targetDate) return;
    newRows.push(rsScheduledVisitRow_(headers, {
      pool_id: t.pool_id,
      customer_name: info.customer_name || '',
      service_type: info.service || 'Weekly Full Service',
      visit_type: 'weekly_override',
      scheduled_date: targetDate,
      assigned_technician: t.new_operator || info.operator || '',
      status: 'scheduled',
      notes: noteKey + ' moved_to:' + t.new_day + ' reschedule_batch:' + batchId,
      created_by: auth && auth.user && auth.user.username ? auth.user.username : (auth && auth.username) || ''
    }));
  });

  if (changed && data.length > 1) {
    sheet.getRange(2, 1, data.length - 1, headers.length).setValues(data.slice(1));
  }
  if (newRows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, headers.length).setValues(newRows);
  }
  return prevByKey;
}

function rsRestoreWeeklyOverrideVisits_(batchId, items) {
  var sheet = rsEnsureScheduledVisitsSheet_();
  var headers = rsHeaders_(sheet);
  var data = sheet.getLastRow() >= 1
    ? sheet.getRange(1, 1, sheet.getLastRow(), headers.length).getValues()
    : [headers];
  var col = function (name) { return headers.indexOf(name); };
  var stCol = col('status'), notesCol = col('notes'), idCol = col('scheduled_visit_id');
  var changed = false;

  for (var i = 1; i < data.length; i++) {
    var notes = notesCol !== -1 ? String(data[i][notesCol] || '') : '';
    var st = stCol !== -1 ? String(data[i][stCol] || '').toLowerCase() : '';
    if (notes.indexOf('reschedule_batch:' + batchId) !== -1 && st !== 'cancelled') {
      if (stCol !== -1) data[i][stCol] = 'cancelled';
      changed = true;
    }
  }

  var append = [];
  items.forEach(function (item) {
    var prev = [];
    try { prev = JSON.parse(String(item.prev_visit_json || '[]')); } catch (e) { prev = []; }
    prev.forEach(function (obj) {
      var id = String(obj.scheduled_visit_id || '').trim();
      var found = -1;
      if (id && idCol !== -1) {
        for (var r = 1; r < data.length; r++) {
          if (String(data[r][idCol] || '').trim() === id) { found = r; break; }
        }
      }
      if (found !== -1) {
        headers.forEach(function (h, c) {
          if (obj[h] !== undefined) data[found][c] = obj[h];
        });
        changed = true;
      } else {
        append.push(rsScheduledVisitRow_(headers, obj));
      }
    });
  });

  if (changed && data.length > 1) {
    sheet.getRange(2, 1, data.length - 1, headers.length).setValues(data.slice(1));
  }
  if (append.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, append.length, headers.length).setValues(append);
  }
}

function rsBuildBatchRow_(auth, input, batchId, status) {
  return {
    batch_id: batchId,
    status: status,
    scope: input.scope,
    effective_week: input.effective_week,
    end_week: input.end_week,
    reason_code: input.reason_code,
    message_subject: input.message_subject,
    message_body: input.message_body,
    created_by: (auth && (auth.name || auth.username)) || '',
    created_at: rsNowIso_(),
    item_count: input.items.length,
    applied_count: 0,
    failed_count: 0,
    notify_enabled: input.notify_enabled ? 'TRUE' : 'FALSE',
    request_hash: ''
  };
}

function rsApply_(auth, payload) {
  var input = rsNormalizeInput_(payload);
  if (!input.ok) return input;
  var batchId = input.batch_id || Utilities.getUuid();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'Another reschedule is already running.' };

  try {
    var existing = rsFindBatch_(batchId);
    if (existing) {
      return { ok: true, idempotent: true, batch_id: batchId, detail: rsDetail_({ batch_id: batchId }) };
    }

    var preflight = rsPreflight_(payload);
    if (!preflight.ok) return preflight;
    if (preflight.blockers > 0) {
      return { ok: false, error: 'Batch has blockers.', preflight: preflight };
    }
    if (preflight.warnings > 0 && !input.acknowledge_warnings) {
      return { ok: false, error: 'Warnings require acknowledgement.', preflight: preflight };
    }

    var status = input.scope === 'permanent' && rsIsFutureWeek_(input.effective_week) ? 'pending' : 'applying';
    rsAppendRows_(rsBatchSheet_(), [rsBuildBatchRow_(auth, input, batchId, status)]);
    if (status === 'pending') {
      rsCreatePendingItems_(auth, input, batchId);
      rsEnsurePromoteTrigger_();
      return { ok: true, batch_id: batchId, status: 'pending', detail: rsDetail_({ batch_id: batchId }) };
    }

    var result = input.scope === 'permanent'
      ? rsApplyPermanentNow_(auth, input, batchId)
      : rsApplyOverridesNow_(auth, input, batchId);

    rsPatchRow_(rsBatchSheet_(), rsFindBatch_(batchId)._row, {
      status: result.failed_count ? 'partially_applied' : 'applied',
      applied_at: rsNowIso_(),
      applied_count: result.applied_count,
      failed_count: result.failed_count,
      error: result.error || ''
    });
    rsBustCaches_(result.affected_weeks || input.weeks);
    rsEnqueueDistanceWarmups_(result.affected_weeks || input.weeks, batchId);
    return { ok: result.failed_count === 0, batch_id: batchId, status: result.failed_count ? 'partially_applied' : 'applied', detail: rsDetail_({ batch_id: batchId }) };
  } finally {
    lock.releaseLock();
  }
}

function rsCreatePendingItems_(auth, input, batchId) {
  var ctx = rsRoutesContext_();
  var rows = [];
  input.items.forEach(function (item) {
    var hit = ctx.byPool[item.pool_id.toUpperCase()];
    var info = hit ? rsRouteRowInfo_(ctx, hit.row) : {};
    rows.push({
      batch_id: batchId,
      item_id: Utilities.getUuid(),
      pool_id: item.pool_id,
      week_start: input.effective_week,
      customer_name: info.customer_name || '',
      new_day: item.new_day,
      new_operator: item.new_operator || info.operator || '',
      status: 'pending',
      notify_status: 'not_queued'
    });
  });
  rsAppendRows_(rsItemSheet_(), rows);
}

function rsApplyPermanentNow_(auth, input, batchId, existingRows) {
  var ctx = rsRoutesContext_();
  var dayCol = ctx.col('day_of_week');
  var opCol = ctx.col('operator');
  var pinnedCol = rsEnsureRoutesCol_(ctx, 'pinned');
  var items = [];
  var existingByPool = {};
  (existingRows || []).forEach(function (row) {
    existingByPool[String(row.pool_id || '').toUpperCase()] = row;
  });
  var failed = 0;

  input.items.forEach(function (item) {
    var hit = ctx.byPool[item.pool_id.toUpperCase()];
    if (!hit) {
      failed++;
      var failObj = { batch_id: batchId, item_id: Utilities.getUuid(), pool_id: item.pool_id, week_start: input.effective_week, new_day: item.new_day, new_operator: item.new_operator, status: 'failed', error: 'Pool not found.' };
      if (existingByPool[item.pool_id.toUpperCase()]) rsPatchRow_(rsItemSheet_(), existingByPool[item.pool_id.toUpperCase()]._row, failObj);
      else items.push(failObj);
      return;
    }
    var info = rsRouteRowInfo_(ctx, hit.row);
    var newOp = item.new_operator || info.operator || '';
    var itemObj = {
      batch_id: batchId,
      item_id: Utilities.getUuid(),
      pool_id: item.pool_id,
      week_start: input.effective_week,
      customer_name: info.customer_name,
      prev_day: info.day,
      prev_operator: info.operator,
      prev_pinned: info.pinned ? 'TRUE' : 'FALSE',
      new_day: item.new_day,
      new_operator: newOp,
      status: 'applied',
      notify_status: 'not_queued'
    };
    if (existingByPool[item.pool_id.toUpperCase()]) rsPatchRow_(rsItemSheet_(), existingByPool[item.pool_id.toUpperCase()]._row, itemObj);
    else items.push(itemObj);
    if (dayCol !== -1) ctx.data[hit.rowIndex][dayCol] = item.new_day;
    if (opCol !== -1) ctx.data[hit.rowIndex][opCol] = newOp;
    ctx.data[hit.rowIndex][pinnedCol] = input.pin_permanent ? 'TRUE' : (info.pinned ? 'TRUE' : 'FALSE');
  });

  if (ctx.data.length > 1) {
    var width = ctx.headers.length;
    var body = ctx.data.slice(1).map(function (row) {
      while (row.length < width) row.push('');
      return row.slice(0, width);
    });
    ctx.sheet.getRange(2, 1, body.length, width).setValues(body);
  }
  rsAppendRows_(rsItemSheet_(), items);
  return { applied_count: input.items.length - failed, failed_count: failed, affected_weeks: [input.effective_week] };
}

function rsApplyOverridesNow_(auth, input, batchId) {
  var ctx = rsRoutesContext_();
  var routeInfoByPool = {};
  Object.keys(ctx.byPool).forEach(function (key) {
    routeInfoByPool[key] = rsRouteRowInfo_(ctx, ctx.byPool[key].row);
  });

  var ov = rsReadWeeklyOverrideRows_();
  var targetSet = {};
  var targets = [];
  input.items.forEach(function (item) {
    input.weeks.forEach(function (week) {
      var key = rsOverrideKey_(item.pool_id, week);
      targetSet[key] = { pool_id: item.pool_id, week_start: week, new_day: item.new_day, new_operator: item.new_operator };
      targets.push(targetSet[key]);
    });
  });

  var prevByKey = {};
  ov.rows.forEach(function (r) {
    var week = rsWeekStartForDate_(r.week_start);
    var key = rsOverrideKey_(r.pool_id, week);
    if (targetSet[key]) {
      prevByKey[key] = {
        day: String(r.override_day || '').trim(),
        operator: String(r.override_operator || '').trim(),
        batch_id: String(r.batch_id || '').trim(),
        created_at: String(r.created_at || '').trim()
      };
    }
  });

  var visitPrevByKey = rsSyncWeeklyOverrideVisits_(targets, routeInfoByPool, auth, batchId);
  var keep = ov.rows.filter(function (r) {
    return !targetSet[rsOverrideKey_(r.pool_id, rsWeekStartForDate_(r.week_start))];
  });
  var now = rsNowIso_();
  var newOverrides = [];
  var itemRows = [];

  targets.forEach(function (t) {
    var key = rsOverrideKey_(t.pool_id, t.week_start);
    var routeInfo = routeInfoByPool[t.pool_id.toUpperCase()] || {};
    var prev = prevByKey[key] || null;
    var effectiveBefore = prev || { day: routeInfo.day || '', operator: routeInfo.operator || '' };
    var newOp = t.new_operator || routeInfo.operator || '';
    newOverrides.push({
      week_start: t.week_start,
      pool_id: t.pool_id,
      override_day: t.new_day,
      override_operator: newOp,
      created_at: now,
      batch_id: batchId
    });
    itemRows.push({
      batch_id: batchId,
      item_id: Utilities.getUuid(),
      pool_id: t.pool_id,
      week_start: t.week_start,
      customer_name: routeInfo.customer_name || '',
      prev_day: effectiveBefore.day || '',
      prev_operator: effectiveBefore.operator || '',
      prev_pinned: routeInfo.pinned ? 'TRUE' : 'FALSE',
      prev_override_day: prev ? prev.day : '',
      prev_override_operator: prev ? prev.operator : '',
      prev_had_override: prev ? 'TRUE' : 'FALSE',
      prev_override_batch_id: prev ? prev.batch_id : '',
      prev_override_created_at: prev ? prev.created_at : '',
      prev_visit_json: JSON.stringify(visitPrevByKey[key] || []),
      new_day: t.new_day,
      new_operator: newOp,
      status: 'applied',
      notify_status: 'not_queued'
    });
  });

  var all = keep.concat(newOverrides);
  if (ov.sheet.getLastRow() > 1) ov.sheet.getRange(2, 1, ov.sheet.getLastRow() - 1, ov.headers.length).clearContent();
  if (all.length) {
    var matrix = all.map(function (r) {
      return ov.headers.map(function (h) { return r[h] !== undefined && r[h] !== null ? r[h] : ''; });
    });
    ov.sheet.getRange(2, 1, matrix.length, ov.headers.length).setValues(matrix);
  }
  rsAppendRows_(rsItemSheet_(), itemRows);
  return { applied_count: itemRows.length, failed_count: 0, affected_weeks: input.weeks };
}

function rsRevert_(auth, payload) {
  var batchId = String((payload && payload.batch_id) || '').trim();
  if (!batchId) return { ok: false, error: 'batch_id required.' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'Another reschedule is already running.' };
  try {
    var batch = rsFindBatch_(batchId);
    if (!batch) return { ok: false, error: 'Batch not found.' };
    if (String(batch.status) === 'reverted') return { ok: true, batch_id: batchId, status: 'reverted', detail: rsDetail_({ batch_id: batchId }) };
    var items = rsBatchItems_(batchId);
    var result = String(batch.scope) === 'permanent'
      ? rsRevertPermanent_(batch, items)
      : rsRevertOverrides_(batch, items);
    rsPatchRow_(rsBatchSheet_(), batch._row, {
      status: result.failed_count ? 'partially_reverted' : 'reverted',
      reverted_at: rsNowIso_(),
      failed_count: result.failed_count,
      error: result.error || ''
    });
    rsBustCaches_(result.affected_weeks || []);
    rsEnqueueDistanceWarmups_(result.affected_weeks || [], batchId);
    return { ok: result.failed_count === 0, batch_id: batchId, status: result.failed_count ? 'partially_reverted' : 'reverted', detail: rsDetail_({ batch_id: batchId }) };
  } finally {
    lock.releaseLock();
  }
}

function rsRevertPermanent_(batch, items) {
  var ctx = rsRoutesContext_();
  var dayCol = ctx.col('day_of_week');
  var opCol = ctx.col('operator');
  var pinnedCol = rsEnsureRoutesCol_(ctx, 'pinned');
  var failed = 0;
  var itemSheet = rsItemSheet_();

  items.forEach(function (item) {
    if (String(item.status) === 'pending') {
      rsPatchRow_(itemSheet, item._row, { status: 'reverted', skip_reason: 'pending batch cancelled' });
      return;
    }
    var hit = ctx.byPool[String(item.pool_id || '').toUpperCase()];
    if (!hit) {
      failed++;
      rsPatchRow_(itemSheet, item._row, { status: 'failed', error: 'Pool no longer exists.' });
      return;
    }
    var info = rsRouteRowInfo_(ctx, hit.row);
    if (info.day !== String(item.new_day || '') ||
        (String(item.new_operator || '') && info.operator !== String(item.new_operator || ''))) {
      failed++;
      rsPatchRow_(itemSheet, item._row, { status: 'failed', error: 'Current route changed after batch; revert skipped.' });
      return;
    }
    if (dayCol !== -1) ctx.data[hit.rowIndex][dayCol] = item.prev_day || '';
    if (opCol !== -1) ctx.data[hit.rowIndex][opCol] = item.prev_operator || '';
    ctx.data[hit.rowIndex][pinnedCol] = String(item.prev_pinned || '').toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE';
    rsPatchRow_(itemSheet, item._row, { status: 'reverted', error: '' });
  });

  if (ctx.data.length > 1) {
    var width = ctx.headers.length;
    var body = ctx.data.slice(1).map(function (row) {
      while (row.length < width) row.push('');
      return row.slice(0, width);
    });
    ctx.sheet.getRange(2, 1, body.length, width).setValues(body);
  }
  return { failed_count: failed, affected_weeks: [String(batch.effective_week || rsCurrentWeekStart_())] };
}

function rsRevertOverrides_(batch, items) {
  var ov = rsReadWeeklyOverrideRows_();
  var batchId = String(batch.batch_id);
  var itemByKey = {};
  items.forEach(function (item) { itemByKey[rsOverrideKey_(item.pool_id, item.week_start)] = item; });
  var conflicts = {};
  var currentLast = {};
  ov.rows.forEach(function (r) {
    var key = rsOverrideKey_(r.pool_id, rsWeekStartForDate_(r.week_start));
    if (itemByKey[key]) currentLast[key] = r;
  });
  Object.keys(itemByKey).forEach(function (key) {
    var cur = currentLast[key];
    if (cur && String(cur.batch_id || '') !== batchId) conflicts[key] = true;
  });

  var keep = ov.rows.filter(function (r) {
    var key = rsOverrideKey_(r.pool_id, rsWeekStartForDate_(r.week_start));
    return !(itemByKey[key] && String(r.batch_id || '') === batchId);
  });
  var restore = [];
  var failed = 0;
  var itemSheet = rsItemSheet_();

  items.forEach(function (item) {
    var key = rsOverrideKey_(item.pool_id, item.week_start);
    if (conflicts[key]) {
      failed++;
      rsPatchRow_(itemSheet, item._row, { status: 'failed', error: 'Current override changed after batch; revert skipped.' });
      return;
    }
    if (String(item.prev_had_override || '').toUpperCase() === 'TRUE') {
      restore.push({
        week_start: item.week_start,
        pool_id: item.pool_id,
        override_day: item.prev_override_day,
        override_operator: item.prev_override_operator,
        created_at: item.prev_override_created_at || rsNowIso_(),
        batch_id: item.prev_override_batch_id || ''
      });
    }
    rsPatchRow_(itemSheet, item._row, { status: 'reverted', error: '' });
  });

  var all = keep.concat(restore);
  if (ov.sheet.getLastRow() > 1) ov.sheet.getRange(2, 1, ov.sheet.getLastRow() - 1, ov.headers.length).clearContent();
  if (all.length) {
    var matrix = all.map(function (r) {
      return ov.headers.map(function (h) { return r[h] !== undefined && r[h] !== null ? r[h] : ''; });
    });
    ov.sheet.getRange(2, 1, matrix.length, ov.headers.length).setValues(matrix);
  }
  rsRestoreWeeklyOverrideVisits_(batchId, items.filter(function (it) { return !conflicts[rsOverrideKey_(it.pool_id, it.week_start)]; }));
  return {
    failed_count: failed,
    affected_weeks: items.map(function (it) { return String(it.week_start || ''); }).filter(String)
  };
}

function rsBustCaches_(weeks) {
  var keys = {};
  (weeks || []).forEach(function (w) { if (w) keys['rd:' + w] = true; });
  keys.unassigned_pools = true;
  var arr = Object.keys(keys);
  try {
    var cache = CacheService.getScriptCache();
    for (var i = 0; i < arr.length; i += 100) cache.removeAll(arr.slice(i, i + 100));
  } catch (e) {}
}

function rsEnqueueDistanceWarmups_(weeks, batchId) {
  var clean = {};
  (weeks || []).forEach(function (w) {
    var week = rsWeekStartForDate_(w);
    if (week) clean[week] = true;
  });
  var weekList = Object.keys(clean);
  if (!weekList.length) return { ok: true, queued: 0 };

  var sheet = rsWarmupSheet_();
  var existing = rsRows_(sheet);
  var active = {};
  existing.forEach(function (r) {
    var st = String(r.status || '').trim().toLowerCase();
    var wk = rsWeekStartForDate_(r.week_start);
    if (wk && (st === 'pending' || st === 'processing')) active[wk] = true;
  });

  var now = rsNowIso_();
  var rows = [];
  weekList.forEach(function (week) {
    if (active[week]) return;
    rows.push({
      week_start: week,
      source_batch_id: batchId || '',
      status: 'pending',
      created_at: now
    });
  });
  rsAppendRows_(sheet, rows);
  if (rows.length) rsEnsureDistanceWarmupTrigger_();
  return { ok: true, queued: rows.length };
}

function rsEnsureDistanceWarmupTrigger_() {
  try {
    var exists = ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction && t.getHandlerFunction() === 'rsProcessDistanceWarmups_';
    });
    if (!exists) ScriptApp.newTrigger('rsProcessDistanceWarmups_').timeBased().everyHours(1).create();
  } catch (e) {}
}

function rsProcessDistanceWarmups_(limit) {
  if (typeof computeRouteData_ !== 'function') {
    return { ok: false, error: 'computeRouteData_ is not available.' };
  }
  var max = Math.max(1, Math.min(6, Number(limit) || 3));
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { ok: false, error: 'Another route job is already running.' };
  try {
    var sheet = rsWarmupSheet_();
    var rows = rsRows_(sheet).filter(function (r) {
      return String(r.status || '').trim().toLowerCase() === 'pending';
    }).slice(0, max);
    var done = 0;
    var failed = 0;
    rows.forEach(function (r) {
      var week = rsWeekStartForDate_(r.week_start);
      if (!week) {
        failed++;
        rsPatchRow_(sheet, r._row, { status: 'failed', processed_at: rsNowIso_(), error: 'Invalid week_start.' });
        return;
      }
      rsPatchRow_(sheet, r._row, { status: 'processing', error: '' });
      try {
        try { CacheService.getScriptCache().remove('rd:' + week); } catch (cacheErr) {}
        computeRouteData_(week);
        done++;
        rsPatchRow_(sheet, r._row, { status: 'done', processed_at: rsNowIso_(), error: '' });
      } catch (err) {
        failed++;
        rsPatchRow_(sheet, r._row, { status: 'failed', processed_at: rsNowIso_(), error: String(err) });
      }
    });
    return { ok: failed === 0, processed: done, failed: failed };
  } finally {
    lock.releaseLock();
  }
}

// Read-only snapshot of the warmup queue. The UI uses this to tell a manager
// whether route ordering may still be stale after a big move.
function rsWarmupStatus_() {
  var rows = rsRows_(rsWarmupSheet_());
  var counts = { pending: 0, processing: 0, done: 0, failed: 0 };
  var pendingWeeks = {};
  var lastProcessed = '';
  var failures = [];

  rows.forEach(function (r) {
    var st = String(r.status || '').trim().toLowerCase();
    if (counts[st] === undefined) return;
    counts[st]++;
    var week = rsWeekStartForDate_(r.week_start);
    if (st === 'pending' || st === 'processing') {
      if (week) pendingWeeks[week] = true;
    }
    var processed = String(r.processed_at || '');
    if (processed && processed > lastProcessed) lastProcessed = processed;
    if (st === 'failed') {
      failures.push({
        week_start: week || String(r.week_start || ''),
        error: String(r.error || ''),
        processed_at: processed
      });
    }
  });

  failures.sort(function (a, b) { return String(b.processed_at).localeCompare(String(a.processed_at)); });

  return {
    ok: true,
    pending: counts.pending,
    processing: counts.processing,
    done: counts.done,
    failed: counts.failed,
    last_processed_at: lastProcessed,
    pending_weeks: Object.keys(pendingWeeks).sort(),
    recent_failures: failures.slice(0, 5)
  };
}

// ─── Planner context ────────────────────────────────────────────────────────
// One read that lets the planner warn BEFORE a move is staged instead of after
// preflight rejects it: who works which day and how many stops they can take,
// which days have already gone, which days are blacked out, and what has no home.
// Everything here is derived from sheets other features already own — this only
// brings it together in one round trip.
function rsPlannerContext_(payload) {
  var weekStart = rsWeekStartForDate_((payload && payload.week_start) || '') || rsCurrentWeekStart_();
  var days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  var ops = rsOperatorMap_();
  var technicians = Object.keys(ops).map(function (k) {
    return { name: ops[k].name, max_per_day: ops[k].max, days: ops[k].days };
  }).sort(function (a, b) { return a.name.localeCompare(b.name); });

  // Days that cannot be scheduled into, with the reason, so the board can label
  // them ("has already passed") instead of the meaningless "locked".
  var closedDays = days.map(function (d) {
    return { day: d, date: rsDayDate_(d, weekStart), reason: rsTargetClosedReason_(d, weekStart) };
  }).filter(function (x) { return !!x.reason; });

  // Blackouts are owned by ServiceAreas/StartAvailability. Reuse their reader so
  // there is one definition of "we are closed", and degrade to none if absent.
  var blackoutDays = [];
  try {
    if (typeof savBlackoutRanges_ === 'function' && typeof savIsBlackedOut_ === 'function') {
      var ranges = savBlackoutRanges_();
      if (ranges && ranges.length) {
        days.forEach(function (d) {
          var date = rsDayDate_(d, weekStart);
          if (date && savIsBlackedOut_(date, ranges)) blackoutDays.push({ day: d, date: date });
        });
      }
    }
  } catch (e) {
    Logger.log('rsPlannerContext_ blackout read failed (non-blocking): ' + e);
  }

  // Current load per operator per day, from the same visibility rules the board
  // uses, so the capacity a manager sees matches what preflight will compute.
  var load = {};
  try {
    rsBuildStopsForWeek_(rsRoutesContext_(), weekStart).forEach(function (s) {
      var key = (s.operator || 'UNASSIGNED') + '||' + s.day;
      load[key] = (load[key] || 0) + 1;
    });
  } catch (e) {
    Logger.log('rsPlannerContext_ load read failed (non-blocking): ' + e);
  }

  var unrouted = { count: 0, pools: [] };
  try {
    // getUnassignedPools re-validates the token itself and owns its own 300s cache.
    if (typeof getUnassignedPools === 'function') {
      var un = getUnassignedPools((payload && payload.token) || '');
      var pools = (un && un.ok && un.pools) || [];
      unrouted.count = pools.length;
      unrouted.pools = pools.slice(0, 50).map(function (p) {
        return {
          pool_id: p.pool_id || '',
          customer_name: p.customer_name || '',
          address: p.address || '',
          city: p.city || '',
          service: p.service || '',
          needs_monthly_week: !!p.needs_monthly_week,
          day_of_week: p.day_of_week || '',
          operator: p.operator || ''
        };
      });
      unrouted.truncated = pools.length > unrouted.pools.length;
    }
  } catch (e) {
    Logger.log('rsPlannerContext_ unrouted read failed (non-blocking): ' + e);
  }

  return {
    ok: true,
    week_start: weekStart,
    technicians: technicians,
    closed_days: closedDays,
    blackout_days: blackoutDays,
    load: load,
    unrouted: unrouted
  };
}

function rsDetail_(payload) {
  var batchId = String((payload && payload.batch_id) || '').trim();
  if (!batchId) return { ok: false, error: 'batch_id required.' };
  var batch = rsFindBatch_(batchId);
  if (!batch) return { ok: false, error: 'Batch not found.' };
  return { ok: true, batch: batch, items: rsBatchItems_(batchId) };
}

function rsList_() {
  var batches = rsRows_(rsBatchSheet_()).sort(function (a, b) {
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });
  return { ok: true, batches: batches };
}

function rsNotify_(auth, payload) {
  var batchId = String((payload && payload.batch_id) || '').trim();
  if (!batchId) return { ok: false, error: 'batch_id required.' };
  var detail = rsDetail_({ batch_id: batchId });
  if (!detail.ok) return detail;
  var batch = detail.batch;
  if (['applied','partially_applied'].indexOf(String(batch.status)) === -1) {
    return { ok: false, error: 'Only applied batches can be notified.' };
  }
  if (typeof handleCommsSendCampaign_ !== 'function') return { ok: false, error: 'Comms engine is not available.' };
  var msg = rsNotifyMessage_(batch, payload);
  var sendAt = payload.send_at || rsQuietHoursSendAt_();
  var res = handleCommsSendCampaign_(auth, {
    name: 'Route reschedule ' + batchId,
    category: 'service_update',
    subject: msg.subject,
    body_markup: msg.body,
    audience: { type: 'reschedule_batch', batch_id: batchId },
    send_at: sendAt
  });
  if (res && res.ok) {
    rsPatchRow_(rsBatchSheet_(), batch._row, { campaign_id: res.campaign_id, notify_enabled: 'TRUE' });
    detail.items.forEach(function (it) {
      rsPatchRow_(rsItemSheet_(), it._row, { notify_status: 'queued' });
    });
  }
  return res;
}

function rsQuietHoursSendAt_() {
  var now = new Date();
  var ct = new Date(now.toLocaleString('en-US', { timeZone: RS_TZ }));
  if (ct.getHours() >= 8 && ct.getHours() < 18) return '';
  if (ct.getHours() >= 18) ct.setDate(ct.getDate() + 1);
  ct.setHours(8, 0, 0, 0);
  return ct.toISOString();
}

// Subject/body resolution shared by notify, preview, and test send so all three
// render the exact same message.
function rsNotifyMessage_(batch, payload) {
  var subject = String((payload && payload.subject) || (batch && batch.message_subject) ||
                       'Your pool service schedule is changing');
  var body = String((payload && payload.body_markup) || (batch && batch.message_body) || '');
  if (!body) {
    body = 'Hi {{first_name}},\n\nYour pool service is moving from {{old_day}} to {{new_day}} ' +
           'effective {{effective_date}}.\n\nQuestions? Just reply to this email.';
  }
  return { subject: subject, body: body };
}

// Read-only. Resolves the audience through the exact same pipeline a real send
// uses, so the preview count and the send count cannot drift. Writes nothing.
function rsNotifyPreview_(payload) {
  var batchId = String((payload && payload.batch_id) || '').trim();
  if (!batchId) return { ok: false, error: 'batch_id required.' };
  var batch = rsFindBatch_(batchId);
  if (!batch) return { ok: false, error: 'Batch not found.' };
  if (typeof commsDedupeAndFlag_ !== 'function') return { ok: false, error: 'Comms engine is not available.' };

  var msg = rsNotifyMessage_(batch, payload);
  var flagged = commsDedupeAndFlag_(rsResolveCommsAudience_({ batch_id: batchId }), 'service_update');
  var recipients = (flagged && flagged.recipients) || [];

  var crm = rsCrmLookup_();
  var recentCutoff = new Date(Date.now() - 14 * 86400000).toISOString();
  var totals = { total: recipients.length, sendable: 0, missing_email: 0, opted_out: 0,
                 notified_recently: 0, pools: 0 };
  var poolSeen = {};

  var out = recipients.map(function (r) {
    var props = (r.properties && r.properties.length) ? r.properties : [{}];
    var p0 = props[0] || {};
    var poolIds = [];
    var notifiedRecently = false;
    props.forEach(function (p) {
      var pid = String(p.pool_id || '');
      if (!pid) return;
      if (poolIds.indexOf(pid) === -1) poolIds.push(pid);
      poolSeen[pid.toUpperCase()] = true;
      var c = crm[pid.toUpperCase()] || {};
      if (c.schedule_notified_at && String(c.schedule_notified_at) >= recentCutoff) notifiedRecently = true;
    });
    var sendable = !r.invalid && !r.opted_out;
    if (sendable) totals.sendable++;
    if (r.invalid) totals.missing_email++;
    else if (r.opted_out) totals.opted_out++;
    if (notifiedRecently) totals.notified_recently++;
    return {
      email: r.email || '',
      name: r.name || '',
      first_name: r.first_name || '',
      pool_ids: poolIds,
      week_count: props.length,
      old_day: p0.old_day || '',
      new_day: p0.new_day || p0.day || '',
      effective_date: p0.effective_label || p0.effective_date || '',
      sendable: sendable,
      skip_reason: r.invalid ? 'missing or invalid email' : (r.opted_out ? 'opted out' : ''),
      notified_recently: notifiedRecently
    };
  });
  totals.pools = Object.keys(poolSeen).length;

  // Render the sample against a real recipient so placeholders show real days.
  var sampleFor = null;
  for (var i = 0; i < recipients.length; i++) {
    if (!recipients[i].invalid && !recipients[i].opted_out) { sampleFor = recipients[i]; break; }
  }
  if (!sampleFor) sampleFor = recipients[0] || null;
  var sample = null;
  if (sampleFor && typeof commsRenderSubject_ === 'function' && typeof commsRenderBody_ === 'function') {
    sample = {
      subject: commsRenderSubject_(msg.subject, sampleFor),
      body_html: commsRenderBody_(msg.body, sampleFor)
    };
  }

  return { ok: true, batch_id: batchId, status: batch.status, totals: totals,
           recipients: out, sample: sample };
}

// Sends one message to the requesting admin. Deliberately does NOT touch the
// batch row or any item's notify_status — see the test_email guard in
// rsAfterCommsRecipientSent_ for the other half of that promise.
function rsNotifyTest_(auth, payload) {
  var batchId = String((payload && payload.batch_id) || '').trim();
  if (!batchId) return { ok: false, error: 'batch_id required.' };
  var batch = rsFindBatch_(batchId);
  if (!batch) return { ok: false, error: 'Batch not found.' };
  if (['applied','partially_applied'].indexOf(String(batch.status)) === -1) {
    return { ok: false, error: 'Only applied batches can be notified.' };
  }
  if (typeof handleCommsSendCampaign_ !== 'function') return { ok: false, error: 'Comms engine is not available.' };

  var to = String((payload && payload.test_email) || (auth && auth.email) || '').trim();
  if (!to) return { ok: false, error: 'No test address on file. Add an email to your profile or pass test_email.' };

  var msg = rsNotifyMessage_(batch, payload);
  var res = handleCommsSendCampaign_(auth, {
    name: 'TEST Route reschedule ' + batchId,
    category: 'service_update',
    subject: msg.subject,
    body_markup: msg.body,
    audience: { type: 'reschedule_batch', batch_id: batchId, test_email: to },
    run_inline: true
  });
  if (res && res.ok) res.test_email = to;
  return res;
}

function rsResolveCommsAudience_(audience) {
  var batchId = String((audience && audience.batch_id) || '').trim();
  if (!batchId) return [];
  var testEmail = String((audience && audience.test_email) || '').trim();
  var crm = rsCrmLookup_();
  var batch = rsFindBatch_(batchId) || {};
  var records = rsBatchItems_(batchId).filter(function (it) {
    return String(it.status) === 'applied';
  }).map(function (it) {
    var c = crm[String(it.pool_id || '').toUpperCase()] || {};
    return {
      email: c.email || '',
      first_name: c.first_name || '',
      last_name: c.last_name || '',
      customer_name: c.customer_name || it.customer_name || '',
      quote_id: c.quote_id || '',
      pool_id: it.pool_id || '',
      area: c.area || '',
      address: c.address || '',
      city: c.city || '',
      day: it.new_day || '',
      operator: it.new_operator || '',
      old_day: it.prev_day || '',
      new_day: it.new_day || '',
      effective_date: batch.effective_week || it.week_start || '',
      effective_label: batch.scope === 'permanent'
        ? 'starting the week of ' + (batch.effective_week || it.week_start || '')
        : 'the week of ' + (it.week_start || batch.effective_week || '')
    };
  });

  // A test send swaps only the destination address. The record still carries the
  // first real moved pool's days, so every placeholder renders as customers see it.
  if (testEmail) {
    if (!records.length) return [];
    records[0].email = testEmail;
    return [records[0]];
  }
  return records;
}

function rsAfterCommsRecipientSent_(campaign, logRow, recipient, sentAt) {
  try {
    var audience = {};
    try { audience = JSON.parse(String(campaign.audience_json || '{}')); } catch (e) {}
    if (audience.type !== 'reschedule_batch' || !audience.batch_id) return;
    // Test sends go to the admin, never to a customer — nothing may be marked notified.
    if (audience.test_email) return;
    var props = (recipient && recipient.properties) || [];
    var itemSheet = rsItemSheet_();
    var rows = rsBatchItems_(audience.batch_id);
    var sentIso = sentAt || rsNowIso_();
    props.forEach(function (p) {
      if (typeof recordScheduleNotified_ === 'function') {
        recordScheduleNotified_(p.pool_id || '', p.new_day || p.day || '', p.operator || '');
      }
      rows.forEach(function (it) {
        if (String(it.pool_id) === String(p.pool_id) &&
            String(it.new_day) === String(p.new_day || p.day || '')) {
          rsPatchRow_(itemSheet, it._row, { notify_status: 'sent', notified_at: sentIso });
        }
      });
    });
    var batch = rsFindBatch_(audience.batch_id);
    if (batch) {
      var sentCount = rsBatchItems_(audience.batch_id).filter(function (it) {
        return String(it.notify_status) === 'sent';
      }).length;
      rsPatchRow_(rsBatchSheet_(), batch._row, { notified_count: sentCount });
    }
  } catch (err) {
    Logger.log('rsAfterCommsRecipientSent_ failed: ' + err);
  }
}

function rsEnsurePromoteTrigger_() {
  try {
    var exists = ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction && t.getHandlerFunction() === 'rsPromotePendingBatches_';
    });
    if (!exists) ScriptApp.newTrigger('rsPromotePendingBatches_').timeBased().everyDays(1).atHour(5).create();
  } catch (e) {}
}

function rsPromotePendingBatches_() {
  var rows = rsRows_(rsBatchSheet_()).filter(function (b) {
    return String(b.status) === 'pending' && String(b.scope) === 'permanent' &&
      String(b.effective_week || '') <= rsCurrentWeekStart_();
  });
  rows.forEach(function (batch) {
    var existingItems = rsBatchItems_(batch.batch_id);
    var items = existingItems.map(function (it) {
      return { pool_id: it.pool_id, new_day: it.new_day, new_operator: it.new_operator };
    });
    var auth = { ok: true, username: 'system', name: 'System', roles: ['admin'], user: { username: 'system' } };
    rsPatchRow_(rsBatchSheet_(), batch._row, { status: 'applying' });
    var result = rsApplyPermanentNow_(auth, {
      scope: 'permanent',
      effective_week: batch.effective_week,
      end_week: batch.end_week,
      weeks: [batch.effective_week],
      items: items,
      pin_permanent: true
    }, batch.batch_id, existingItems);
    rsPatchRow_(rsBatchSheet_(), batch._row, {
      status: result.failed_count ? 'partially_applied' : 'applied',
      applied_at: rsNowIso_(),
      applied_count: result.applied_count,
      failed_count: result.failed_count
    });
    rsBustCaches_([batch.effective_week]);
    rsEnqueueDistanceWarmups_([batch.effective_week], batch.batch_id);
  });
}

function rsPruneExpiredOverrides_() {
  var cutoff = rsParseYmd_(rsCurrentWeekStart_());
  cutoff.setDate(cutoff.getDate() - 8 * 7);
  var cutoffKey = rsYmd_(cutoff);
  var ov = rsReadWeeklyOverrideRows_();
  var keep = ov.rows.filter(function (r) {
    var ws = rsWeekStartForDate_(r.week_start);
    return !ws || ws >= cutoffKey;
  });
  if (keep.length === ov.rows.length) return { ok: true, pruned: 0 };
  if (ov.sheet.getLastRow() > 1) ov.sheet.getRange(2, 1, ov.sheet.getLastRow() - 1, ov.headers.length).clearContent();
  if (keep.length) {
    var matrix = keep.map(function (r) {
      return ov.headers.map(function (h) { return r[h] !== undefined && r[h] !== null ? r[h] : ''; });
    });
    ov.sheet.getRange(2, 1, matrix.length, ov.headers.length).setValues(matrix);
  }
  return { ok: true, pruned: ov.rows.length - keep.length };
}

function handleRescheduleAction_(action, auth, payload) {
  if (!auth || !auth.ok) return { ok: false, error: 'Unauthorized' };
  if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return { ok: false, error: 'Admin access required.' };
  switch (action) {
    case 'reschedule_preflight': return rsPreflight_(payload);
    case 'reschedule_apply':     return rsApply_(auth, payload);
    case 'reschedule_revert':    return rsRevert_(auth, payload);
    case 'reschedule_list':      return rsList_();
    case 'reschedule_detail':    return rsDetail_(payload);
    case 'reschedule_notify':    return rsNotify_(auth, payload);
    case 'reschedule_notify_preview': return rsNotifyPreview_(payload);
    case 'reschedule_notify_test':    return rsNotifyTest_(auth, payload);
    case 'reschedule_prune':     return rsPruneExpiredOverrides_();
    case 'reschedule_warmup_status':  return rsWarmupStatus_();
    case 'reschedule_planner_context': return rsPlannerContext_(payload);
    case 'reschedule_warm_distances':
      return rsProcessDistanceWarmups_(payload && payload.limit);
    default: return { ok: false, error: 'Unknown reschedule action: ' + action };
  }
}
