// ── Start-date availability for the signing page ─────────────────────────────
//
// What day can this customer start, and which weeks are open?
//
// THE HARD RULE, and the reason this file is shaped the way it is:
//
//   A customer-facing service day may ONLY come from a real Service Area or an
//   explicit per-location override. Never from a proximity guess.
//
// A cluster guess is fine for deciding which technician takes a pool — a good
// guess beats none. It is NOT fine for telling a customer "we service your
// area on Tuesdays", because the page looks equally confident either way. Bad
// zone coverage must fail loudly, not silently.
//
// So there are three modes, and only the first ever names a weekday:
//
//   route_locked   zone/override resolved AND dates available
//                  → calendar showing only that weekday's dates
//   preferred_week no zone, no dates, or no capacity
//                  → same calendar, week selection, NO day named
//   (client-side)  availability call failed entirely
//                  → plain date input, handled in agreement.html
//
// ⚠️ This response reaches a PUBLIC, UNAUTHENTICATED page. It must never carry
// capacity numbers, technician names, distances, addresses, or pricing.

var SAV_LEAD_DAYS_DEFAULT = 3;
var SAV_WINDOW_DAYS_DEFAULT = 60;
var SAV_TZ_FALLBACK = 'America/Chicago';

function savTz_() {
  try { return Session.getScriptTimeZone() || SAV_TZ_FALLBACK; } catch (e) { return SAV_TZ_FALLBACK; }
}

function savIso_(d) {
  return Utilities.formatDate(d, savTz_(), 'yyyy-MM-dd');
}

// Parsed as a LOCAL date. new Date('2026-08-18') reads as UTC midnight, which in
// US time zones lands on the previous calendar day and would shift the weekday.
function savParseYmd_(ymd) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
  if (!m) return null;
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

var SAV_DAY_NAMES = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];

// Monday-keyed week start, matching how weeks are keyed elsewhere in the portal.
function savWeekStart_(d) {
  var day = d.getDay();                       // 0 = Sunday
  var delta = (day === 0) ? -6 : (1 - day);   // Sunday belongs to the week that began Monday
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta);
}

// ── Blackouts (optional) ─────────────────────────────────────────────────────
// Entirely opt-in. With no sheet and no rows the feature is dormant and
// availability behaves exactly as if it did not exist.
var SCHEDULE_BLACKOUT_HEADERS = ['blackout_id', 'start_date', 'end_date', 'reason', 'created_at'];

function savBlackoutRanges_() {
  try {
    var ss = SpreadsheetApp.openById(
      typeof ROUTES_SPREADSHEET_ID !== 'undefined'
        ? ROUTES_SPREADSHEET_ID : '1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM');
    var sheet = ss.getSheetByName('Schedule_Blackouts');
    if (!sheet || sheet.getLastRow() < 2) return [];
    var data = sheet.getDataRange().getValues();
    var h = {};
    data[0].forEach(function (x, i) { h[String(x || '').trim().toLowerCase().replace(/ /g, '_')] = i; });
    if (h.start_date === undefined) return [];
    var out = [];
    for (var i = 1; i < data.length; i++) {
      var s = savCellToYmd_(data[i][h.start_date]);
      var e = h.end_date !== undefined ? savCellToYmd_(data[i][h.end_date]) : '';
      if (!s) continue;
      out.push({ start: s, end: e || s });
    }
    return out;
  } catch (e) {
    // A blackout sheet problem must never close the calendar.
    Logger.log('savBlackoutRanges_ failed, treating as no blackouts (non-blocking): ' + e);
    return [];
  }
}

function savCellToYmd_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return savIso_(v);
  var s = String(v == null ? '' : v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function savIsBlackedOut_(ymd, ranges) {
  for (var i = 0; i < ranges.length; i++) {
    if (ymd >= ranges[i].start && ymd <= ranges[i].end) return true;   // ISO strings sort correctly
  }
  return false;
}

// ── Capacity: person and date first, area second ─────────────────────────────
//
// TWO DIFFERENT QUESTIONS, and conflating them is the bug this shape exists to
// prevent:
//
//   The ZONE answers   "what weekday can we promise this customer?"
//   The PERSON answers "is there room on that exact date?"
//
// Counting per-area gets the second one wrong. If Ana runs North on Tuesday and
// Luis runs South on Tuesday, a startup of Luis's in South would close Ana's
// North Tuesday — two people, one shared weekday, one of them wrongly booked
// solid.
//
// Counting per-person gets both cases right, including the one that looks like
// a contradiction: if Ana runs BOTH North and South on Tuesday, her South
// startup DOES eat into her North availability, because it is the same person's
// day. Zone membership was never what made that true — the shared person was.
//
// zone.max_per_day is an EXTRA ceiling layered on top ("this area absorbs at
// most N a day, whoever is free"), never the main bucket. Blank means no
// ceiling, and then people alone decide.

function savTechKey_(name) {
  return String(name == null ? '' : name).trim().toLowerCase();
}

// A synthesized primary_technician (someone named on a zone but absent from
// Users) arrives with maxPerDay null, which must read as "unconfigured", not
// "zero capacity" — the Number('') trap in a different costume.
function savTechCapacity_(tech) {
  var n = tech ? tech.maxPerDay : null;
  if (typeof n === 'number' && isFinite(n) && n > 0) return Math.floor(n);
  return (typeof DEFAULT_MAX_POOLS_PER_DAY !== 'undefined' ? DEFAULT_MAX_POOLS_PER_DAY : 10);
}

// Who could take this job on this weekday. A technician whose available_days
// excludes the day contributes nothing; an EMPTY days list means "not
// configured yet" and must not silently remove them from the pool.
function savEligibleTechs_(zone) {
  var techs = [];
  try {
    techs = (typeof techsForZone_ === 'function') ? (techsForZone_(zone.zone_id, zone) || []) : [];
  } catch (e) {
    Logger.log('savEligibleTechs_: technicians unreadable (non-blocking): ' + e);
  }
  return techs.filter(function (tech) {
    if (!tech || !savTechKey_(tech.name)) return false;
    if (tech.days && tech.days.length && tech.days.indexOf(zone.service_day) === -1) return false;
    return true;
  });
}

// One read of Scheduled_Visits for the WHOLE window.
//
// Deliberately not getScheduledVisitsForWeek(): that wrapper takes a session
// token as its first argument and enriches every row with addresses from two
// further spreadsheets. Availability needs four columns, no session, and one
// read — not nine authed, address-joined ones.
function savVisitsInRange_(startIso, endIso) {
  var out = [];
  try {
    var ss = SpreadsheetApp.openById(
      typeof ROUTES_SPREADSHEET_ID !== 'undefined'
        ? ROUTES_SPREADSHEET_ID : '1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM');
    var sheet = ss.getSheetByName('Scheduled_Visits');
    if (!sheet || sheet.getLastRow() < 2) return out;
    var data = sheet.getDataRange().getValues();
    var h = {};
    data[0].forEach(function (x, i) { h[String(x || '').trim().toLowerCase().replace(/ /g, '_')] = i; });
    if (h.scheduled_date === undefined) return out;

    for (var i = 1; i < data.length; i++) {
      var date = savCellToYmd_(data[i][h.scheduled_date]);
      if (!date || date < startIso || date > endIso) continue;
      var status = h.status !== undefined
        ? String(data[i][h.status] || '').trim().toLowerCase() : '';
      // Cancelled and skipped visits give the slot back.
      if (status === 'cancelled' || status === 'skipped') continue;
      out.push({
        pool_id: h.pool_id !== undefined ? String(data[i][h.pool_id] || '').trim() : '',
        date: date,
        technician: h.assigned_technician !== undefined
          ? String(data[i][h.assigned_technician] || '').trim() : '',
        visit_type: h.visit_type !== undefined
          ? String(data[i][h.visit_type] || '').trim() : ''
      });
    }
  } catch (e) {
    // An unreadable visits sheet must not close the calendar; it under-counts,
    // which the person ceiling and the zone ceiling both still bound.
    Logger.log('savVisitsInRange_ failed, treating as no dated visits (non-blocking): ' + e);
  }
  return out;
}

// Everything the date loop needs, read ONCE. Called per request, not per date —
// a 60-day window on one weekday is ~9 dates, and re-reading Routes and
// Signed_Customers nine times per signing page load is not a rounding error.
function savLoadSnapshot_(zone, startIso, endIso) {
  var routePools = [];
  try {
    var rg = (typeof rgLoadPools_ === 'function') ? rgLoadPools_() : null;
    if (rg && rg.ok && rg.pools) routePools = rg.pools;
  } catch (e) {
    Logger.log('savLoadSnapshot_: Routes unreadable (non-blocking): ' + e);
  }

  var zipOf = {};
  routePools.forEach(function (p) {
    if (p.pool_id && p.zip) zipOf[p.pool_id] = savZip_(p.zip);
  });
  // Startups and G2C pools sit in Routes as UNSCHEDULED and rgLoadPools_ skips
  // them by design, so their ZIP has to come from the customer record. Without
  // this a startup would never count against its own area's ceiling.
  try {
    if (typeof rgPoolZipIndex_ === 'function') {
      var idx = rgPoolZipIndex_() || {};
      Object.keys(idx).forEach(function (pid) {
        if (!zipOf[pid] && idx[pid] && idx[pid].zip) zipOf[pid] = savZip_(idx[pid].zip);
      });
    }
  } catch (e) {
    Logger.log('savLoadSnapshot_: pool ZIP index unreadable (non-blocking): ' + e);
  }

  return {
    techs: savEligibleTechs_(zone),
    routePools: routePools,
    visits: savVisitsInRange_(startIso, endIso),
    zipOf: zipOf
  };
}

function savZip_(value) {
  if (typeof saNormalizeZip_ === 'function') return saNormalizeZip_(value);
  var m = /(\d{5})/.exec(String(value == null ? '' : value));
  return m ? m[1] : '';
}

// Per-person workload on one exact date: the weekly route they run every week
// on that weekday, plus anything dated onto that day.
//
// ⚠️ EVERY POOL COUNTS ONCE PER PERSON. A weekly pool has a Routes row AND,
// once B7 runs, its own weekly_service visit. Counting both would make every
// newly signed customer consume two of their own technician's slots.
function savPersonLoads_(techs, serviceDay, dateIso, routePools, visits) {
  var loads = {}, counted = {};
  (techs || []).forEach(function (tech) {
    loads[savTechKey_(tech.name)] = { steady: 0, dated: 0, total: 0 };
  });

  (routePools || []).forEach(function (p) {
    if (p.day !== serviceDay) return;
    var key = savTechKey_(p.operator);
    if (!key || !loads[key]) return;          // not one of this zone's people
    if (p.pool_id) counted[key + '|' + p.pool_id] = true;
    loads[key].steady++;
  });

  (visits || []).forEach(function (v) {
    if (v.date !== dateIso) return;
    var key = savTechKey_(v.technician);
    // An unassigned visit belongs to nobody's day yet. It still counts against
    // the area ceiling below — attributing it to an arbitrary person would
    // close a calendar on a guess.
    if (!key || !loads[key]) return;
    if (v.pool_id && counted[key + '|' + v.pool_id]) return;
    if (v.pool_id) counted[key + '|' + v.pool_id] = true;
    loads[key].dated++;
  });

  Object.keys(loads).forEach(function (k) {
    loads[k].total = loads[k].steady + loads[k].dated;
  });
  return loads;
}

// The optional extra ceiling: how loaded this AREA is on this date, whoever is
// doing the work. Only consulted when the zone carries an explicit max_per_day.
function savZoneCeilingLoad_(zone, dateIso, routePools, visits, zipOf) {
  var zipSet = {}, counted = {}, total = 0;
  (zone.zips || []).forEach(function (z) {
    var zip = savZip_(z);
    if (zip) zipSet[zip] = true;
  });

  (routePools || []).forEach(function (p) {
    if (p.day !== zone.service_day) return;
    var zip = savZip_(p.zip);
    if (!zip || !zipSet[zip]) return;
    if (p.pool_id) counted[p.pool_id] = true;
    total++;
  });

  (visits || []).forEach(function (v) {
    if (v.date !== dateIso) return;
    if (v.pool_id && counted[v.pool_id]) return;      // same pool, already counted
    var zip = (v.pool_id && zipOf) ? zipOf[v.pool_id] : '';
    if (!zip || !zipSet[zip]) return;                 // a visit outside this area
    if (v.pool_id) counted[v.pool_id] = true;
    total++;
  });

  return total;
}

// Is this date offerable? People first, area ceiling second.
function savDateHasRoom_(zone, dateIso, snap) {
  if (snap.techs.length) {
    var loads = savPersonLoads_(snap.techs, zone.service_day, dateIso, snap.routePools, snap.visits);
    var someoneFree = false;
    for (var i = 0; i < snap.techs.length; i++) {
      var load = loads[savTechKey_(snap.techs[i].name)];
      if (!load || load.total < savTechCapacity_(snap.techs[i])) { someoneFree = true; break; }
    }
    if (!someoneFree) return false;
  }
  // No known people for this zone → no person ceiling to apply. Degrading to
  // the area ceiling alone keeps an unconfigured Users sheet from closing every
  // calendar in the portal.

  var ceiling = zone.max_per_day;
  if (typeof ceiling === 'number' && isFinite(ceiling) && ceiling > 0) {
    if (savZoneCeilingLoad_(zone, dateIso, snap.routePools, snap.visits, snap.zipOf) >= ceiling) {
      return false;
    }
  }
  return true;
}

// ── Quote resolution, with the two auth paths kept strictly apart ────────────
//
// PUBLIC  : approval token only. Never accepts quote_id.
// STAFF   : quote_id + a valid portal session.
//
// ⚠️ These must not blur. A quote_id arriving without a valid staff session is
// REFUSED, never quietly downgraded — otherwise the endpoint becomes a way to
// enumerate quotes from an unauthenticated page.
function savResolveQuote_(payload) {
  var token = String((payload && payload.token) || '').trim();
  var quoteId = String((payload && payload.quote_id) || '').trim();

  if (quoteId) {
    var staffToken = String((payload && payload.staff_token) || token || '').trim();
    var auth = null;
    try {
      auth = (typeof validateToken === 'function') ? validateToken(staffToken) : null;
    } catch (e) {
      auth = null;
    }
    if (!auth || !auth.ok) {
      return { error: 'A staff session is required to preview availability for a quote.' };
    }
    var staffHit = (typeof getQuoteById_ === 'function') ? getQuoteById_(quoteId) : null;
    if (!staffHit) return { error: 'Quote not found.' };
    return { quote: staffHit.object, staff: true };
  }

  if (!token) return { error: 'Missing token.' };
  try {
    var approvals = ensureSheet_('Proposal_Approvals', MCPS_PROPOSAL_APPROVAL_HEADERS);
    var approval = findRowByValue_(approvals, 'token', token);
    if (!approval) return { error: 'This link is no longer valid.' };
    var hit = getQuoteById_(value_(approval, 'quote_id'));
    if (!hit) return { error: 'This link is no longer valid.' };
    return { quote: hit.object, staff: false };
  } catch (e) {
    return { error: 'Could not resolve this link.' };
  }
}

// Only weekly recurring service is route-day bound. Startups, G2C, repairs and
// one-times get their date from the job, not the route.
function savIsWeeklyService_(quote) {
  var service = String(value_(quote, 'service') || '');
  if (typeof WEEKLY_MATCH === 'function') {
    try { return !!WEEKLY_MATCH(service); } catch (e) { /* fall through */ }
  }
  return service.toLowerCase().indexOf('weekly') !== -1;
}

// ── The handler ──────────────────────────────────────────────────────────────
function handleGetStartAvailability_(payload) {
  try {
    var leadDays = aaNumericProperty_('START_DATE_LEAD_DAYS', SAV_LEAD_DAYS_DEFAULT);
    var windowDays = aaNumericProperty_('START_DATE_WINDOW_DAYS', SAV_WINDOW_DAYS_DEFAULT);
    var tz = savTz_();
    var today = new Date();

    var resolved = savResolveQuote_(payload);
    if (resolved.error) return { ok: false, error: resolved.error };
    var quote = resolved.quote;

    var base = {
      ok: true,
      lead_days: leadDays,
      window_days: windowDays,
      generated_at: savIso_(today)
    };

    // Non-weekly services keep a free date choice — there is no route day to lock to.
    if (!savIsWeeklyService_(quote)) {
      return savPreferredWeek_(base, today, leadDays, windowDays, 'not_weekly');
    }

    var zone = null, source = 'none';
    try {
      if (typeof resolveZoneForAddress_ === 'function') {
        var r = resolveZoneForAddress_({
          zip: value_(quote, 'zip_code'),
          locationId: value_(quote, 'location_id')
        });
        source = r ? r.source : 'none';
        // ⚠️ THE RULE. Only an authoritative zone may name a day to a customer.
        // 'cluster' and 'fallback' are assignment aids and are discarded here.
        if (r && (r.source === 'zone' || r.source === 'override') && r.service_day) {
          zone = r;
        }
      }
    } catch (e) {
      Logger.log('availability: zone lookup failed (non-blocking): ' + e);
    }

    if (!zone) {
      // No authoritative zone. Flag it for ops once, then offer weeks.
      savFlagUnresolvedZone_(quote, source);
      return savPreferredWeek_(base, today, leadDays, windowDays, 'no_zone');
    }

    // ⚠️ A zone's day is validated when it is SAVED — but a row saved before
    // SCHEDULABLE_DAYS was narrowed still reads back with its old day, and
    // nothing revalidates it. Promising a weekday no technician can be assigned
    // to is the exact failure this file exists to prevent, so the day is
    // re-checked here, at the moment it would become a promise.
    var schedulable = (typeof saSchedulableDays_ === 'function')
      ? saSchedulableDays_()
      : ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];
    if (schedulable.indexOf(zone.service_day) === -1) {
      savFlagUnresolvedZone_(quote, source, {
        type: 'unschedulable_zone_day',
        detail: 'Zone "' + (zone.zone_name || zone.zone_id) + '" is set to ' +
                zone.service_day + ', which is not a schedulable day. The customer was ' +
                'offered a preferred week instead of a service day. Fix the zone\'s day ' +
                'or widen SCHEDULABLE_DAYS.'
      });
      return savPreferredWeek_(base, today, leadDays, windowDays, 'day_not_schedulable');
    }

    // Full zone record for capacity (the resolver returns identity only).
    var full = null;
    try {
      var all = (typeof listServiceAreas_ === 'function') ? listServiceAreas_(false) : [];
      for (var i = 0; i < all.length; i++) {
        if (all[i].zone_id === zone.zone_id) { full = all[i]; break; }
      }
    } catch (e) { /* capacity degrades to unlimited below */ }
    var zoneForCap = full || {
      zone_id: zone.zone_id, zone_name: zone.zone_name,
      service_day: zone.service_day, zips: [], max_per_day: Infinity
    };

    var blackouts = savBlackoutRanges_();
    var windowStart = savIso_(new Date(today.getFullYear(), today.getMonth(), today.getDate() + leadDays));
    var windowEnd = savIso_(new Date(today.getFullYear(), today.getMonth(), today.getDate() + windowDays));
    var snap = savLoadSnapshot_(zoneForCap, windowStart, windowEnd);

    var dates = [];
    for (var d = leadDays; d <= windowDays; d++) {
      var day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + d);
      if (SAV_DAY_NAMES[day.getDay()] !== zone.service_day) continue;
      var iso = savIso_(day);
      if (savIsBlackedOut_(iso, blackouts)) continue;
      if (!savDateHasRoom_(zoneForCap, iso, snap)) continue;
      dates.push(iso);
    }

    // Zone resolved but nothing offerable — full or blacked out for the whole
    // window. Offering weeks is honest; offering a date we cannot serve is not.
    if (!dates.length) {
      return savPreferredWeek_(base, today, leadDays, windowDays, 'no_capacity');
    }

    base.mode = 'route_locked';
    base.dates = dates;
    base.service_day = zone.service_day;
    base.zone_name = zone.zone_name || '';
    base.day_source = source;      // 'zone' or 'override' only — see the guard above
    return base;
  } catch (e) {
    // Availability must never break signing. ok:false makes the page fall back
    // to a plain preferred-date input.
    return { ok: false, error: 'handleGetStartAvailability_ Error: ' + e };
  }
}

// ── Preferred-week mode ──────────────────────────────────────────────────────
// The customer picks a WEEK. No weekday is named, anywhere — not in the
// response, not in the copy, not in what gets submitted back.
function savPreferredWeek_(base, today, leadDays, windowDays, reason) {
  var blackouts = savBlackoutRanges_();

  // Earliest selectable week is the FOLLOWING week, never the current partial
  // one: a customer picking "this week" on a Thursday has effectively picked
  // one or two remaining days, which is not what "week of" means to them.
  var thisWeek = savWeekStart_(today);
  var first = new Date(thisWeek.getFullYear(), thisWeek.getMonth(), thisWeek.getDate() + 7);

  // Respect lead time — if it pushes past next Monday, start later.
  var earliest = new Date(today.getFullYear(), today.getMonth(), today.getDate() + leadDays);
  while (first.getTime() < savWeekStart_(earliest).getTime()) {
    first = new Date(first.getFullYear(), first.getMonth(), first.getDate() + 7);
  }

  var weeks = [];
  var cursor = first;
  var limit = new Date(today.getFullYear(), today.getMonth(), today.getDate() + windowDays);
  while (cursor.getTime() <= limit.getTime()) {
    var iso = savIso_(cursor);
    // A week is only dropped when EVERY serviceable day in it is blacked out.
    var allOut = true;
    for (var i = 0; i < 6; i++) {                 // Mon–Sat; Sunday is never serviced
      var day = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + i);
      if (!savIsBlackedOut_(savIso_(day), blackouts)) { allOut = false; break; }
    }
    if (!allOut) weeks.push(iso);
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 7);
  }

  base.mode = 'preferred_week';
  base.week_starts = weeks;
  base.day_source = 'unresolved';
  // Deliberately absent: service_day, zone_name, dates. Nothing here may let a
  // caller render a weekday.
  base.reason = reason;
  return base;
}

// ── Unresolved-zone alerting ─────────────────────────────────────────────────
//
// Two layers, matching the weekly_service rule: the SHEET is the durable
// "already alerted" record, and claimDedupAction_ only suppresses rapid repeats
// while a customer opens and reopens the same calendar.
//
// ⚠️ The dedup key MUST end in a minute timestamp. claimDedupAction_'s cleanup
// only deletes keys matching /(\d{4}-\d{2}-\d{2} \d{2}:\d{2})$/, and script
// properties cap at 50 — an uncollectable key would eventually break every
// caller of claimDedupAction_, including chemical-usage dedup.
function savFlagUnresolvedZone_(quote, source, problem) {
  try {
    var quoteId = String(value_(quote, 'quote_id') || '').trim();
    var zip = String(value_(quote, 'zip_code') || '').trim();
    if (!quoteId && !zip) return;

    var type = (problem && problem.type) || 'unresolved_zone';
    var detail = (problem && problem.detail) ||
      ('ZIP ' + (zip || 'unknown') + ' is in no service area' +
       (source && source !== 'none' ? ' (resolver fell back to ' + source + ')' : '') +
       '. The customer was offered a preferred week instead of a service day.');

    // 1. Durable: is there already an open row for this quote?
    if (typeof recordAssignmentException_ === 'function') {
      // recordAssignmentException_ dedupes on (pool/quote, type) among OPEN rows.
      recordAssignmentException_({ quote_id: quoteId, type: type, detail: detail });
    }

    // 2. Race guard only — short-lived, minute-stamped, collectable.
    if (typeof claimDedupAction_ === 'function') {
      var minute = Utilities.formatDate(new Date(), savTz_(), 'yyyy-MM-dd HH:mm');
      claimDedupAction_(type, (quoteId || zip) + ' | ' + minute);
    }
  } catch (e) {
    Logger.log('savFlagUnresolvedZone_ failed (non-blocking): ' + e);
  }
}
