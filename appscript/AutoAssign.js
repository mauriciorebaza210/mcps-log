// AutoAssign.gs
// ══════════════════════════════════════════════════════════════════════════════
// Automatic day + technician assignment for new Weekly signups.
//
// WHY THIS EXISTS
// Until now addWeeklyPoolToRoutes_ (SalesHub.js) hard-coded every new Routes row
// to day_of_week=UNSCHEDULED / operator=UNASSIGNED, so the welcome email could
// never state a real service day. This assigns one at signing time.
//
// SCOPE — Weekly signups only. Startups reach the weekly schedule later via
// convertStartupToWeekly, and G2C pools never join it; both keep the "we'll be in
// touch" fallback in the welcome email.
//
// SAFETY
//   * Off by default. Script Property AUTO_ASSIGN_ENABLED must equal 'true'.
//     Flipping it off is an instant kill switch — no redeploy.
//   * Every failure path degrades to today's behaviour (UNSCHEDULED/UNASSIGNED).
//     Signing must NEVER fail because assignment was unavailable.
//   * Reuses RoutePlanner's operator model and geocoding rather than adding a
//     second, competing engine.
// ══════════════════════════════════════════════════════════════════════════════

var AA_ROUTES_SS_ID = '1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM';
var AA_LOCK_TIMEOUT_MS = 15000;

function autoAssignEnabled_() {
  try {
    return String(PropertiesService.getScriptProperties().getProperty('AUTO_ASSIGN_ENABLED') || '')
      .trim().toLowerCase() === 'true';
  } catch (e) {
    return false;
  }
}

// Days the engine may schedule on. Defaults to the existing WEEKDAYS constant
// (Mon–Sat) and is narrowed by the SCHEDULABLE_DAYS Script Property, so Saturday
// is an operational toggle rather than a hard-coded policy.
function schedulableDays_() {
  var all = (typeof WEEKDAYS !== 'undefined' && WEEKDAYS.length)
    ? WEEKDAYS.slice()
    : ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];
  var raw = '';
  try { raw = String(PropertiesService.getScriptProperties().getProperty('SCHEDULABLE_DAYS') || '').trim(); } catch (e) {}
  if (!raw) return all;
  var allowed = raw.split(',').map(function (d) { return d.trim().toUpperCase(); }).filter(Boolean);
  var filtered = all.filter(function (d) { return allowed.indexOf(d) !== -1; });
  return filtered.length ? filtered : all;
}

// Current load per (operator × day), counted from the durable base day_of_week —
// NOT per-week Weekly_Overrides, which are temporary and would make capacity
// wobble week to week.
// ── One read of Routes, bucketed every way we need it ────────────────────────
// Previously loads and stops were read separately, and stops were re-read once
// PER OPERATOR PER DAY — an O(operators × days) sweep of the whole sheet on a
// path that runs while a customer waits. This reads it once.
//
// Memoised per execution. chooseAssignment_ passes force=true because it runs
// inside the assignment lock, where re-reading is the entire point: two
// simultaneous signings must not both claim the same last slot.
var _aaSnapshot = null;

function aaRouteSnapshot_(force) {
  if (_aaSnapshot && !force) return _aaSnapshot;

  var snap = { loads: {}, stopsByDay: {}, stopsByOpDay: {}, hasCoords: false };
  var sheet = SpreadsheetApp.openById(AA_ROUTES_SS_ID).getSheetByName('Routes');
  if (!sheet || sheet.getLastRow() < 2) { _aaSnapshot = snap; return snap; }

  var data = sheet.getDataRange().getValues();
  var h = data[0].map(function (x) { return String(x).trim().toLowerCase().replace(/ /g, '_'); });
  var dayCol = h.indexOf('day_of_week');
  var opCol = h.indexOf('operator');
  var statusCol = h.indexOf('route_status');
  var latCol = h.indexOf('lat'), lngCol = h.indexOf('lng');
  if (dayCol === -1 || opCol === -1) { _aaSnapshot = snap; return snap; }

  for (var i = 1; i < data.length; i++) {
    var status = statusCol !== -1 ? String(data[i][statusCol] || '').trim().toLowerCase() : '';
    if (status === 'inactive' || status === 'startup_complete') continue;
    var day = String(data[i][dayCol] || '').trim().toUpperCase();
    var op = String(data[i][opCol] || '').trim();
    if (!day || day === 'UNSCHEDULED') continue;

    var assigned = op && op.toUpperCase() !== 'UNASSIGNED';
    if (assigned) snap.loads[op + '|' + day] = (snap.loads[op + '|' + day] || 0) + 1;

    if (latCol === -1 || lngCol === -1) continue;
    var lat = Number(data[i][latCol]), lng = Number(data[i][lngCol]);
    if (isNaN(lat) || isNaN(lng) || !lat || !lng) continue;   // 0,0 means "not geocoded"
    var stop = { lat: lat, lng: lng };
    snap.hasCoords = true;
    // Clusters are about where we actually drive that weekday, so they include
    // every active stop — not just the eligible operators'. Capacity is the part
    // that depends on eligibility.
    (snap.stopsByDay[day] = snap.stopsByDay[day] || []).push(stop);
    if (assigned) {
      var k = op + '|' + day;
      (snap.stopsByOpDay[k] = snap.stopsByOpDay[k] || []).push(stop);
    }
  }
  _aaSnapshot = snap;
  return snap;
}


// Geocodes ONE address, reusing the same Geocode_Cache sheet the bulk planner
// fills, so a repeat address costs nothing and the two stay in sync.
// Returns {lat,lng} or null — never throws.
//
// ⚠️ Call this BEFORE taking the assignment lock: it can hit the Maps service,
// sleep, and append a cache row.
function aaGeocodeAddress_(address) {
  try {
    var addr = String(address || '').trim();
    if (!addr) return null;

    var crmSs = SpreadsheetApp.openById(
      typeof CRM_SPREADSHEET_ID !== 'undefined'
        ? CRM_SPREADSHEET_ID
        : '1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E');
    var sheetName = (typeof GEOCODE_CACHE_SHEET !== 'undefined') ? GEOCODE_CACHE_SHEET : 'Geocode_Cache';
    var cacheSheet = crmSs.getSheetByName(sheetName);
    if (!cacheSheet) {
      cacheSheet = crmSs.insertSheet(sheetName);
      cacheSheet.appendRow(['address', 'lat', 'lng']);
    }

    var key = addr.toLowerCase();
    if (cacheSheet.getLastRow() > 1) {
      var rows = cacheSheet.getDataRange().getValues();
      for (var i = 1; i < rows.length; i++) {
        if (String(rows[i][0] || '').trim().toLowerCase() === key) {
          var lat = Number(rows[i][1]), lng = Number(rows[i][2]);
          if (!isNaN(lat) && !isNaN(lng) && lat && lng) return { lat: lat, lng: lng };
          break;
        }
      }
    }

    var res = Maps.newGeocoder().geocode(addr);
    if (res && res.status === 'OK' && res.results && res.results.length) {
      var loc = res.results[0].geometry.location;
      cacheSheet.appendRow([addr, loc.lat, loc.lng]);
      return { lat: loc.lat, lng: loc.lng };
    }
  } catch (e) {
    Logger.log('aaGeocodeAddress_ failed (non-blocking): ' + e);
  }
  return null;
}

// ⚠️ getHaversineDistance_ (RoutePlanner.js) takes FOUR SCALARS, not two points.
// This used to forward two objects to it. The typeof guard passed — the function
// does exist — so it returned NaN, and `d < proximity` is false against NaN, so
// every candidate kept proximity:Infinity and the proximity tiebreaker never
// discriminated at all. Pass scalars.
function aaDistance_(a, b) {
  if (!a || !b) return Infinity;
  if (typeof getHaversineDistance_ === 'function') {
    var d = getHaversineDistance_(a.lat, a.lng, b.lat, b.lng);
    return (typeof d === 'number' && !isNaN(d)) ? d : Infinity;
  }
  var R = 3959, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// ── "Is that day's cluster near this address?" ───────────────────────────────
// Mean distance to the K nearest stops on that day, rather than to the single
// nearest or to a centroid:
//   * single nearest — one stray pool 15 miles out would make a whole day look
//     close when there is no cluster there at all
//   * centroid — a day that legitimately covers two separate areas has its
//     centroid in the empty space between them, near neither
// Returns Infinity when the day has no geocoded stops, which callers read as
// "empty day", not "far away".
var AA_CLUSTER_K = 3;

function aaClusterScore_(coords, stops) {
  if (!coords || !stops || !stops.length) return Infinity;
  var ds = stops.map(function (s) { return aaDistance_(coords, s); })
                .filter(function (d) { return d !== Infinity && !isNaN(d); });
  if (!ds.length) return Infinity;
  ds.sort(function (a, b) { return a - b; });
  var k = Math.min(AA_CLUSTER_K, ds.length);
  var sum = 0;
  for (var i = 0; i < k; i++) sum += ds[i];
  return sum / k;
}

// ── The decision ─────────────────────────────────────────────────────────────
// Ranking, in order:
//   1. operator explicitly prefers this address's zone   (soft — orders, never excludes)
//   2. most remaining capacity                            (load balance)
//   3. shortest distance to that operator's existing stops that day
//
// Returns { day, operator, exceptions:[], ... } or null when no eligible operator
// exists at all, in which case the caller keeps UNSCHEDULED/UNASSIGNED.
function chooseAssignment_(opts) {
  var operators = (typeof getTechnicianOperators_ === 'function' ? getTechnicianOperators_() : [])
    .filter(function (op) { return op.autoAssignEligible; });
  if (!operators.length) return null;

  var days = schedulableDays_();
  // force=true: this runs inside the assignment lock, where re-reading is the
  // whole point — two simultaneous signings must not both claim the last slot.
  var snap = aaRouteSnapshot_(true);
  var loads = snap.loads;
  var coords = opts && opts.coords;
  var zoneId = opts && opts.zoneId;
  // The weekday the customer was offered and chose. Honouring it is what keeps
  // the calendar honest: a date we offered must be the date we actually assign.
  var preferredDay = opts && opts.preferredDay
    ? String(opts.preferredDay).trim().toUpperCase() : '';

  var candidates = [];
  operators.forEach(function (op) {
    days.forEach(function (day) {
      if (op.days.indexOf(day) === -1) return;   // hard filter: never a day they don't work
      var load = loads[op.name + '|' + day] || 0;
      var cap = op.maxPerDay || (typeof DEFAULT_MAX_POOLS_PER_DAY !== 'undefined' ? DEFAULT_MAX_POOLS_PER_DAY : 10);
      // Blank preferred_zones is NEUTRAL, not "prefers everywhere" — otherwise an
      // unconfigured tech would tie with, or beat, one deliberately assigned here.
      var zoneRank = 1;                                   // neutral
      if (zoneId && op.preferredZones && op.preferredZones.length) {
        zoneRank = op.preferredZones.indexOf(zoneId) !== -1 ? 0 : 2;
      }
      candidates.push({
        operator: op.name, username: op.username, day: day,
        load: load, capacity: cap, remaining: cap - load,
        dayRank: (preferredDay && day === preferredDay) ? 0 : 1,
        zoneRank: zoneRank,
        proximity: aaClusterScore_(coords, snap.stopsByOpDay[op.name + '|' + day])
      });
    });
  });
  if (!candidates.length) return null;

  candidates.sort(function (a, b) {
    // The customer's chosen day outranks everything else we could optimise for.
    if (a.dayRank !== b.dayRank) return a.dayRank - b.dayRank;
    if (a.zoneRank !== b.zoneRank) return a.zoneRank - b.zoneRank;
    if (a.remaining !== b.remaining) return b.remaining - a.remaining;   // most room first
    if (a.proximity !== b.proximity) return a.proximity - b.proximity;
    return a.operator.localeCompare(b.operator);
  });

  var withRoom = candidates.filter(function (c) { return c.remaining > 0; });
  var chosen = withRoom.length ? withRoom[0] : candidates[0];   // overflow: still assign
  var exceptions = [];

  if (!withRoom.length) {
    exceptions.push({
      type: 'over_capacity',
      detail: chosen.operator + ' on ' + chosen.day + ' is at ' + chosen.load + ' of ' + chosen.capacity +
              '. No eligible slot had remaining capacity.'
    });
  }
  // The customer picked a day off the calendar we showed them and we couldn't
  // honour it. Worth a human look — that's a promise we visibly missed.
  if (preferredDay && chosen.day !== preferredDay) {
    exceptions.push({
      type: 'preferred_day_unavailable',
      detail: 'Customer chose ' + preferredDay + ', assigned ' + chosen.day +
              ' — no technician working ' + preferredDay + ' had capacity.'
    });
  }
  // Only an exception when an EXPLICIT in-zone preference was bypassed. Landing on
  // a neutral (unconfigured) tech is normal operation — alerting on it would train
  // ops to ignore these emails.
  if (zoneId && chosen.zoneRank === 2) {
    var inZoneExists = candidates.some(function (c) { return c.zoneRank === 0; });
    if (inZoneExists) {
      exceptions.push({
        type: 'outside_preferred_zone',
        detail: 'Assigned to ' + chosen.operator + ', who does not cover zone ' + zoneId +
                '. Technicians who do had no capacity.'
      });
    }
  }

  chosen.exceptions = exceptions;
  return chosen;
}

// ── Entry point, called from addWeeklyPoolToRoutes_ ───────────────────────────
// Returns { day, operator, exceptions } or null. NEVER throws — any failure
// returns null and the caller writes UNSCHEDULED/UNASSIGNED exactly as before.
function autoAssignWeeklyPool_(ctx) {
  try {
    if (!autoAssignEnabled_()) return null;

    // Geocode BEFORE taking the lock: it can hit the Maps service, sleep between
    // calls and write cache rows. Holding a lock through that would serialise
    // every concurrent signing behind a slow network round-trip.
    // Geography is an optimisation, never a dependency. If the address can't be
    // geocoded the ranking simply falls back to pure capacity balancing.
    //
    var coords = null, zoneId = '';
    try {
      if (ctx && ctx.address) coords = aaGeocodeAddress_(ctx.address);
    } catch (geoErr) {
      Logger.log('autoAssign: geocode failed, continuing on capacity only: ' + geoErr);
    }

    // Service Areas (ServiceAreas.js) resolve the zone. This is the producer
    // half that chooseAssignment_'s zoneRank has always been waiting for.
    //
    // Assignment uses EVERY source — including cluster and fallback — because
    // "which technician should take this" is an operational question and a good
    // guess beats none. That is the opposite of the customer-facing rule, where
    // only 'zone' and 'override' may promise a day. Same resolver, different
    // tolerance for uncertainty.
    try {
      if (typeof resolveZoneForAddress_ === 'function') {
        var zone = resolveZoneForAddress_({
          zip: ctx && ctx.zip,
          locationId: ctx && ctx.locationId,
          coords: coords
        });
        zoneId = (zone && zone.zone_id) ? zone.zone_id : '';
      }
    } catch (zoneErr) {
      Logger.log('autoAssign: zone lookup failed, ranking on capacity/proximity only: ' + zoneErr);
    }

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(AA_LOCK_TIMEOUT_MS)) {
      Logger.log('autoAssign: could not acquire lock, leaving pool unscheduled');
      return null;
    }
    try {
      // Re-read loads INSIDE the lock — anything gathered before it may be stale
      // by the time we get it, and two simultaneous signings must not both claim
      // the same last slot.
      var chosen = chooseAssignment_({
        coords: coords,
        zoneId: zoneId,
        preferredDay: ctx && ctx.preferredDay
      });
      // Hand the coordinates back so the caller can store them on the Routes row.
      // Without this a newly signed pool sits at 0,0 until the next full recalc
      // and is invisible to every later clustering decision.
      if (chosen && coords) { chosen.lat = coords.lat; chosen.lng = coords.lng; }
      return chosen;
    } finally {
      lock.releaseLock();   // always, even on throw
    }
  } catch (e) {
    Logger.log('autoAssignWeeklyPool_ failed (non-blocking): ' + e);
    return null;
  }
}

// ── Availability for the customer's "Starts" calendar ────────────────────────
// Derived from the SAME operator/capacity model as chooseAssignment_, so a date
// offered to a customer is one the engine could actually honour. A parallel
// implementation here would drift and start promising dates that can't be filled.
//
// A date is offerable when, on that weekday, at least one eligible technician who
// works it still has remaining capacity.
//
// ⚠️ This is advisory. The customer is choosing a PREFERRED date; an admin
// confirms it. Nothing here reserves a slot.
var AA_LEAD_DAYS_DEFAULT = 3;
var AA_WINDOW_DAYS_DEFAULT = 60;

function aaNumericProperty_(key, fallback) {
  try {
    var raw = String(PropertiesService.getScriptProperties().getProperty(key) || '').trim();
    var n = Number(raw);
    return raw !== '' && !isNaN(n) && n >= 0 ? Math.floor(n) : fallback;
  } catch (e) {
    return fallback;
  }
}

// Resolves the signer's service address from their link token. Returns '' on any
// failure — geography is an optimisation here, never a dependency.
function aaAddressForToken_(token) {
  try {
    if (!token) return '';
    var approvals = ensureSheet_('Proposal_Approvals', MCPS_PROPOSAL_APPROVAL_HEADERS);
    var approval = findRowByValue_(approvals, 'token', String(token).trim());
    if (!approval) return '';
    var hit = getQuoteById_(value_(approval, 'quote_id'));
    if (!hit) return '';
    var q = hit.object;
    return [value_(q, 'address'), value_(q, 'city'), value_(q, 'zip_code')]
      .filter(Boolean).join(', ');
  } catch (e) {
    Logger.log('aaAddressForToken_ failed (non-blocking): ' + e);
    return '';
  }
}

// 'YYYY-MM-DD' → 'WEDNESDAY'. Parsed as a LOCAL date, never via new Date(str):
// that reads a bare date as UTC midnight, which in US time zones lands on the
// previous calendar day and would silently shift every customer's chosen weekday.
function aaWeekdayFromDate_(ymd) {
  var s = String(ymd || '').trim();
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return '';
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) return '';
  return ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'][d.getDay()];
}

function aaFloatProperty_(key, fallback) {
  try {
    var raw = String(PropertiesService.getScriptProperties().getProperty(key) || '').trim();
    var n = Number(raw);
    return raw !== '' && !isNaN(n) && n >= 0 ? n : fallback;
  } catch (e) {
    return fallback;
  }
}

// Start-date availability moved to StartAvailability.js — it now resolves a
// single service day from Service Areas and applies per-zone weekly capacity,
// which outgrew this file. The helpers above (aaAddressForToken_,
// aaWeekdayFromDate_, aaNumericProperty_) are still used by it.

// ── Reading back an assignment (for the welcome email) ───────────────────────
// Looks up the pool's CURRENT Routes row and joins to Users for the technician's
// photo/bio, honouring that technician's customer-visibility toggles.
//
// Always returns a fully-formed object; empty strings mean "not scheduled yet",
// which is the correct, permanent state for startups and green-to-cleans.
function lookupAssignedScheduleForPool_(poolId) {
  var blank = { serviceDay: '', techName: '', techPhotoUrl: '', techBio: '', showPhoto: true, showBio: true };
  try {
    if (!poolId) return blank;
    var sheet = SpreadsheetApp.openById(AA_ROUTES_SS_ID).getSheetByName('Routes');
    if (!sheet || sheet.getLastRow() < 2) return blank;

    var data = sheet.getDataRange().getValues();
    var h = data[0].map(function (x) { return String(x).trim().toLowerCase().replace(/ /g, '_'); });
    var pidCol = h.indexOf('pool_id'), dayCol = h.indexOf('day_of_week'), opCol = h.indexOf('operator');
    if (pidCol === -1 || dayCol === -1 || opCol === -1) return blank;

    var day = '', operator = '';
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][pidCol] || '').trim().toUpperCase() !== String(poolId).trim().toUpperCase()) continue;
      day = String(data[i][dayCol] || '').trim();
      operator = String(data[i][opCol] || '').trim();
      break;
    }
    if (!day || day.toUpperCase() === 'UNSCHEDULED') return blank;
    if (!operator || operator.toUpperCase() === 'UNASSIGNED') {
      // Day known but nobody assigned yet — still worth telling the customer.
      return Object.assign({}, blank, { serviceDay: aaFriendlyDay_(day), rawDay: day });
    }

    var tech = null;
    try {
      (typeof getTechnicianOperators_ === 'function' ? getTechnicianOperators_() : []).forEach(function (op) {
        if (op.name === operator) tech = op;
      });
    } catch (e) {}

    var visibility = aaTechVisibility_(operator);
    return {
      serviceDay: aaFriendlyDay_(day),
      rawDay: day,
      techName: operator,
      techPhotoUrl: (tech && visibility.showPhoto) ? (tech.avatarUrl || '') : '',
      techBio: (tech && visibility.showBio) ? (tech.staffBio || '') : '',
      showPhoto: visibility.showPhoto,
      showBio: visibility.showBio
    };
  } catch (e) {
    Logger.log('lookupAssignedScheduleForPool_ failed (non-blocking): ' + e);
    return blank;
  }
}

// "WEDNESDAY" -> "Wednesdays" — recurring service reads better pluralised.
function aaFriendlyDay_(day) {
  var d = String(day || '').trim();
  if (!d) return '';
  var pretty = d.charAt(0).toUpperCase() + d.slice(1).toLowerCase();
  return /s$/i.test(pretty) ? pretty : pretty + 's';
}

// Per-technician customer-visibility toggles. Both default TRUE so a technician
// who has never been configured still gets a normal introduction.
function aaTechVisibility_(operatorName) {
  var out = { showPhoto: true, showBio: true };
  try {
    var ss = SpreadsheetApp.openById(AUTH_SPREADSHEET_ID);
    var sh = ss.getSheetByName(AUTH_USERS_SHEET);
    if (!sh || sh.getLastRow() < 2) return out;
    var data = sh.getDataRange().getValues();
    var h = data[0].map(function (x) { return String(x).trim().toLowerCase().replace(/ /g, '_'); });
    var nameCol = h.indexOf('name');
    var photoCol = h.indexOf('show_photo_to_customers');
    var bioCol = h.indexOf('show_bio_to_customers');
    if (nameCol === -1) return out;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][nameCol] || '').trim() !== operatorName) continue;
      if (photoCol !== -1) {
        var pv = String(data[i][photoCol] ?? '').trim().toUpperCase();
        if (pv === 'FALSE') out.showPhoto = false;
      }
      if (bioCol !== -1) {
        var bv = String(data[i][bioCol] ?? '').trim().toUpperCase();
        if (bv === 'FALSE') out.showBio = false;
      }
      break;
    }
  } catch (e) {}
  return out;
}

// ── "We told the customer X" markers ─────────────────────────────────────────
// Recorded when the welcome email successfully states a service day. This is what
// makes a later change *detectable*, and it prevents emailing customers who were
// never told a day in the first place (startups, G2C, anyone assigned before this
// feature existed).
//
// ⚠️ Stored on QUOTES, never on Routes. calculateRoutes() clearContent()s every
// Routes column, rewrites only the first ten, and hand-restores Pinned alone — a
// marker column on Routes would be silently erased on the next bulk recalc, even
// for pinned rows, turning notified customers back into "never told" and
// suppressing exactly the emails this exists to send.
function recordScheduleNotified_(poolId, day, operator) {
  try {
    if (!poolId || !day) return;
    var sheet = (typeof getCrmSheet_ === 'function') ? getCrmSheet_() : null;
    if (!sheet || sheet.getLastRow() < 2) return;

    if (typeof ensureColumn_ === 'function') {
      ensureColumn_(sheet, 'schedule_notified_day');
      ensureColumn_(sheet, 'schedule_notified_operator');
      ensureColumn_(sheet, 'schedule_notified_at');
    }
    var data = sheet.getDataRange().getValues();
    var h = data[0].map(function (x) { return String(x || '').trim().toLowerCase().replace(/ /g, '_'); });
    var pidCol = h.indexOf('pool_id');
    var dayCol = h.indexOf('schedule_notified_day');
    var opCol = h.indexOf('schedule_notified_operator');
    var atCol = h.indexOf('schedule_notified_at');
    if (pidCol === -1 || dayCol === -1 || opCol === -1) return;

    for (var i = 1; i < data.length; i++) {
      if (String(data[i][pidCol] || '').trim().toUpperCase() !== String(poolId).trim().toUpperCase()) continue;
      sheet.getRange(i + 1, dayCol + 1).setValue(day);
      sheet.getRange(i + 1, opCol + 1).setValue(operator || '');
      if (atCol !== -1) sheet.getRange(i + 1, atCol + 1).setValue(new Date().toISOString());
      return;
    }
  } catch (e) {
    Logger.log('recordScheduleNotified_ failed (non-blocking): ' + e);
  }
}

// What the customer was last told, or null if they were never told anything.
function getScheduleNotified_(poolId) {
  try {
    if (!poolId) return null;
    var sheet = (typeof getCrmSheet_ === 'function') ? getCrmSheet_() : null;
    if (!sheet || sheet.getLastRow() < 2) return null;
    var data = sheet.getDataRange().getValues();
    var h = data[0].map(function (x) { return String(x || '').trim().toLowerCase().replace(/ /g, '_'); });
    var pidCol = h.indexOf('pool_id');
    var dayCol = h.indexOf('schedule_notified_day');
    var opCol = h.indexOf('schedule_notified_operator');
    var atCol = h.indexOf('schedule_notified_at');
    if (pidCol === -1 || dayCol === -1) return null;

    for (var i = 1; i < data.length; i++) {
      if (String(data[i][pidCol] || '').trim().toUpperCase() !== String(poolId).trim().toUpperCase()) continue;
      var day = String(data[i][dayCol] || '').trim();
      if (!day) return null;                       // never told -> nothing to correct
      return {
        day: day,
        operator: opCol !== -1 ? String(data[i][opCol] || '').trim() : '',
        notified_at: atCol !== -1 ? String(data[i][atCol] || '').trim() : '',
        rowNum: i + 1,
        email: aaFieldFromRow_(data, h, i, 'email'),
        firstName: aaFieldFromRow_(data, h, i, 'first_name'),
        serviceName: aaFieldFromRow_(data, h, i, 'service')
      };
    }
  } catch (e) {
    Logger.log('getScheduleNotified_ failed (non-blocking): ' + e);
  }
  return null;
}

function aaFieldFromRow_(data, h, rowIdx, field) {
  var c = h.indexOf(field);
  return c === -1 ? '' : String(data[rowIdx][c] || '').trim();
}

// ── "Your service day changed" notification ──────────────────────────────────
// Called after a route move succeeds. Only fires when the customer was actually
// told something AND it genuinely changed — never on a no-op save, never for a
// customer who was never given a day.
function notifyScheduleChangeIfNeeded_(poolId, newDay, newOperator, opts) {
  try {
    if (opts && opts.notifyCustomer === false) return { ok: true, skipped: 'suppressed by operator' };

    var told = getScheduleNotified_(poolId);
    if (!told) return { ok: true, skipped: 'customer was never told a day' };

    var nextDay = aaFriendlyDay_(newDay || told.day);
    var nextOp = String(newOperator || told.operator || '').trim();
    var dayChanged = nextDay && nextDay !== aaFriendlyDay_(told.day);
    var opChanged = nextOp && nextOp !== told.operator;
    if (!dayChanged && !opChanged) return { ok: true, skipped: 'no actual change' };
    if (!told.email) return { ok: true, skipped: 'no customer email on file' };

    var visibility = aaTechVisibility_(nextOp);
    var tech = null;
    try {
      (typeof getTechnicianOperators_ === 'function' ? getTechnicianOperators_() : []).forEach(function (op) {
        if (op.name === nextOp) tech = op;
      });
    } catch (e) {}

    var html = buildScheduleChangedEmailHtml_({
      firstName: told.firstName || 'there',
      wasDay: aaFriendlyDay_(told.day), nowDay: nextDay,
      wasTech: told.operator, nowTech: nextOp,
      dayChanged: dayChanged, opChanged: opChanged,
      techPhotoUrl: (tech && visibility.showPhoto) ? (tech.avatarUrl || '') : ''
    });

    var subject = dayChanged && opChanged
      ? 'Your pool service is moving to ' + nextDay + ' with ' + nextOp
      : dayChanged ? 'Your pool service day is changing to ' + nextDay
                   : 'Meet ' + nextOp + ' — your new pool technician';

    if (typeof commsSendViaGmail_ === 'function') {
      commsSendViaGmail_({ to: told.email, subject: subject, htmlBody: html, plainBody: subject });
    } else {
      GmailApp.sendEmail(told.email, subject, subject, { htmlBody: html, name: 'Mission Custom Pool Solutions' });
    }
    // Keep the marker current so a later move compares against what they now know.
    recordScheduleNotified_(poolId, newDay || told.day, nextOp);
    return { ok: true, notified: told.email };
  } catch (e) {
    Logger.log('notifyScheduleChangeIfNeeded_ failed (non-blocking): ' + e);
    return { ok: false, error: String(e) };
  }
}

function buildScheduleChangedEmailHtml_(d) {
  var fh = (typeof MCPS_EMAIL_FH_ !== 'undefined') ? MCPS_EMAIL_FH_ : "Arial,sans-serif";
  var fb = (typeof MCPS_EMAIL_FB_ !== 'undefined') ? MCPS_EMAIL_FB_ : "Arial,sans-serif";
  var esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); };

  var rowFor = function (label, was, now) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
      'style="border:1px solid #E4EAEA;border-radius:10px;margin-bottom:10px;"><tr>' +
      '<td width="45%" align="center" style="padding:16px 12px;background:#F3F5F6;border-radius:10px 0 0 10px;">' +
        '<div style="font-family:' + fh + ';font-weight:bold;font-size:9px;letter-spacing:.12em;' +
        'text-transform:uppercase;color:#6B7777;margin-bottom:5px;">Was</div>' +
        '<div style="font-family:' + fh + ';font-weight:bold;font-size:17px;color:#6B7777;' +
        'text-decoration:line-through;">' + esc(was) + '</div></td>' +
      '<td width="10%" align="center" style="background:#F3F5F6;color:#6B7777;font-size:18px;">&rarr;</td>' +
      '<td width="45%" align="center" style="padding:16px 12px;background:#EAF8F7;border-radius:0 10px 10px 0;">' +
        '<div style="font-family:' + fh + ';font-weight:bold;font-size:9px;letter-spacing:.12em;' +
        'text-transform:uppercase;color:#1FA7A8;margin-bottom:5px;">Now</div>' +
        '<div style="font-family:' + fh + ';font-weight:bold;font-size:17px;color:#0D3D3E;">' + esc(now) + '</div></td>' +
      '</tr></table>';
  };

  var headline = d.dayChanged && d.opChanged ? 'Two small changes<br>to your service.'
    : d.dayChanged ? 'Your service day<br>is changing.'
    : 'You have a new<br>technician.';
  var lede = d.dayChanged && d.opChanged
    ? 'Your day and technician are both changing, ' + esc(d.firstName) + '. Everything else stays put.'
    : d.dayChanged
      ? 'Nothing else about your service changes, ' + esc(d.firstName) + ' — same plan, same rate.'
      : 'Your service day isn’t changing, ' + esc(d.firstName) + ' — just the person you’ll see.';

  var body =
    '<tr><td style="padding:28px 32px 6px;">' +
      (d.dayChanged ? rowFor('Day', d.wasDay, d.nowDay) : '') +
      (d.opChanged ? rowFor('Technician', d.wasTech || 'Unassigned', d.nowTech) : '') +
      '<div style="font-family:' + fb + ';font-size:15px;line-height:1.65;color:#3A4645;margin:18px 0 0;">' +
        'We’ve adjusted routes in your area to keep visits consistent and cut down drive time between ' +
        'pools. Your rate and service plan are unchanged, and we’ll still text you when we’re on the way.' +
      '</div>' +
    '</td></tr>' +
    '<tr><td align="center" style="padding:22px 32px 32px;">' +
      '<div style="font-family:' + fb + ';font-size:13px;color:#6B7777;">' +
        'Questions? Just reply to this email.' +
      '</div>' +
    '</td></tr>';

  if (typeof mcpsEmailShell_ === 'function' && typeof mcpsEmailHero_ === 'function') {
    return mcpsEmailShell_(
      mcpsEmailHero_({ headline: headline, lede: lede }) + body + mcpsEmailFooter_(),
      'An update to your pool service schedule.'
    );
  }
  return '<html><body>' + headline.replace(/<br>/g, ' ') + '<br>' + lede + body + '</body></html>';
}

// ── Exception alert ──────────────────────────────────────────────────────────
// Internal ops email. Sent AFTER the lock is released — never while holding it.
function sendAssignmentExceptionAlert_(info) {
  try {
    if (!info || !info.exceptions || !info.exceptions.length) return;
    var props = PropertiesService.getScriptProperties();
    var to = props.getProperty('ASSIGNMENT_EXCEPTION_ALERT_EMAIL') ||
             props.getProperty('MCPS_COMPANY_EMAIL') || 'mauricio@mcpoolsolutions.org';
    var portal = (props.getProperty('PORTAL_BASE_URL') || 'https://mcps-log.vercel.app').replace(/\/$/, '');

    var rows = info.exceptions.map(function (ex) {
      var label = ex.type === 'over_capacity' ? 'Over capacity' : 'Outside preferred area';
      return '<tr><td style="padding:8px 12px;border-top:1px solid #E4EAEA;font-weight:600;color:#B3261E;">' +
        label + '</td><td style="padding:8px 12px;border-top:1px solid #E4EAEA;color:#222;">' +
        (ex.detail || '') + '</td></tr>';
    }).join('');

    var html =
      '<div style="font-family:Arial,sans-serif;color:#222;max-width:640px;">' +
      '<h2 style="color:#0D3D3E;margin:0 0 4px;">Assignment needs review</h2>' +
      '<p style="color:#6B7777;margin:0 0 16px;">A customer was auto-assigned, but not cleanly. ' +
      'They <strong>are</strong> scheduled — this is a quality flag, not a failure.</p>' +
      '<table style="border-collapse:collapse;width:100%;background:#F3F5F6;border-radius:8px;">' +
      '<tr><td style="padding:8px 12px;font-weight:600;">Customer</td><td style="padding:8px 12px;">' + (info.customerName || '') + '</td></tr>' +
      '<tr><td style="padding:8px 12px;font-weight:600;border-top:1px solid #E4EAEA;">Pool</td><td style="padding:8px 12px;border-top:1px solid #E4EAEA;">' + (info.poolId || '') + '</td></tr>' +
      '<tr><td style="padding:8px 12px;font-weight:600;border-top:1px solid #E4EAEA;">Assigned</td><td style="padding:8px 12px;border-top:1px solid #E4EAEA;">' + (info.operator || '') + ' &middot; ' + (info.day || '') + '</td></tr>' +
      rows +
      '</table>' +
      '<p style="margin:18px 0 0;"><a href="' + portal + '/#live_map" ' +
      'style="background:#1FA7A8;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;' +
      'font-weight:700;display:inline-block;">Open the route board</a></p>' +
      '</div>';

    var subject = 'Assignment needs review — ' + (info.customerName || info.poolId || 'new customer');
    if (typeof commsSendViaGmail_ === 'function') {
      commsSendViaGmail_({ to: to, subject: subject, htmlBody: html, plainBody: subject });
    } else {
      GmailApp.sendEmail(to, subject, subject, { htmlBody: html, name: 'MCPS Portal' });
    }
  } catch (e) {
    Logger.log('sendAssignmentExceptionAlert_ failed (non-blocking): ' + e);
  }
}
