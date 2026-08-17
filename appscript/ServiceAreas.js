// ── Service Areas ────────────────────────────────────────────────────────────
//
// The producer half of a loop the codebase has had open for a long time:
// chooseAssignment_() already ranks technicians by preferred_zones and
// RoutePlanner.js already reads that column — but zoneId was hardcoded '' in
// AutoAssign.js because nothing ever produced a zone. This is that producer.
//
// A zone is a named group of ZIP codes served on one weekday. Many zones may
// share a weekday (North-Tuesday and South-Tuesday with different technicians);
// a zone has exactly one day. That asymmetry is deliberate — it is what lets a
// customer choose a WEEK without choosing a DAY.
//
// ZIP codes rather than drawn polygons: zip_code already exists on every quote,
// location and signed customer, so resolution needs no geocoding and survives a
// Maps outage. Oversized ZIPs are handled by a per-location override
// (Client_Locations.zone_id), not by geometry.
//
// ⚠️ Only 'override' and 'zone' sources may produce a customer-facing day
// promise. 'cluster' and 'fallback' exist for technician assignment only — see
// resolveZoneForAddress_.

var SA_ROUTES_SS_ID = (typeof ROUTES_SPREADSHEET_ID !== 'undefined')
  ? ROUTES_SPREADSHEET_ID : '1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM';

var SERVICE_AREA_HEADERS = [
  'zone_id', 'zone_name', 'service_day', 'zips', 'primary_technician',
  'max_per_day', 'active', 'color', 'notes', 'created_at', 'updated_at'
];

var SA_BLACKOUT_HEADERS = [
  'blackout_id', 'start_date', 'end_date', 'reason', 'active', 'created_at', 'updated_at'
];

// Parsing accepts any weekday so an existing row with a now-unschedulable day
// still reads back and can be seen and corrected. SAVING is stricter — see
// saSchedulableDays_.
var SA_VALID_DAYS = ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY'];

// The days the scheduler can actually honour. WEEKDAYS is Mon–Sat (Sunday is
// never serviceable) and the SCHEDULABLE_DAYS script property can narrow it
// further, so this must never be hardcoded: a zone saved on a day outside this
// set resolves to a weekday no technician can ever be assigned to, and the
// customer gets promised a service day that cannot happen.
function saSchedulableDays_() {
  try {
    if (typeof schedulableDays_ === 'function') {
      var d = schedulableDays_();
      if (d && d.length) return d;
    }
  } catch (e) {
    Logger.log('saSchedulableDays_ fell back to Mon-Sat (non-blocking): ' + e);
  }
  return ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];
}

// Seed list of San Antonio / Bexar County ZIPs for the coverage panel. This is
// a starting point for "what still needs a zone", NOT a source of truth — the
// coverage report unions this with every ZIP that actually appears in customer
// data, so a ZIP we serve but forgot to list here still shows up.
var SA_SEED_ZIPS = [
  '78201','78202','78203','78204','78205','78207','78208','78209','78210','78211',
  '78212','78213','78214','78215','78216','78217','78218','78219','78220','78221',
  '78222','78223','78224','78225','78226','78227','78228','78229','78230','78231',
  '78232','78233','78234','78235','78236','78237','78238','78239','78240','78242',
  '78243','78244','78245','78247','78248','78249','78250','78251','78252','78253',
  '78254','78255','78256','78257','78258','78259','78260','78261','78263','78264',
  '78266','78015','78023','78073','78108','78109','78112','78148','78154','78163'
];

function saSheet_() {
  var ss = SpreadsheetApp.openById(SA_ROUTES_SS_ID);
  var sheet = ss.getSheetByName('Service_Areas');
  if (!sheet) {
    sheet = ss.insertSheet('Service_Areas');
    sheet.getRange(1, 1, 1, SERVICE_AREA_HEADERS.length)
      .setValues([SERVICE_AREA_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function saEnsureHeaders_(sheet, headers) {
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return sheet;
  }
  var existing = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
  var norm = existing.map(function (h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); });
  headers.forEach(function (h) {
    var key = String(h || '').trim().toLowerCase().replace(/ /g, '_');
    if (norm.indexOf(key) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(h);
      norm.push(key);
    }
  });
  sheet.setFrozenRows(1);
  return sheet;
}

function saBlackoutSheet_() {
  var ss = SpreadsheetApp.openById(SA_ROUTES_SS_ID);
  var sheet = ss.getSheetByName('Schedule_Blackouts');
  if (!sheet) sheet = ss.insertSheet('Schedule_Blackouts');
  return saEnsureHeaders_(sheet, SA_BLACKOUT_HEADERS);
}

function saNormalizeZip_(value) {
  var s = String(value == null ? '' : value).trim();
  var m = /(\d{5})/.exec(s);          // tolerates "78258-1234" and stray text
  return m ? m[1] : '';
}

// 'TUESDAY' from any casing/spacing. Returns '' when it isn't a weekday.
function saNormalizeDay_(value) {
  var s = String(value == null ? '' : value).trim().toUpperCase();
  return SA_VALID_DAYS.indexOf(s) !== -1 ? s : '';
}

function saParseZips_(value) {
  if (value == null) return [];
  var raw = Array.isArray(value) ? value : String(value).split(/[,\s;]+/);
  var out = [], seen = {};
  raw.forEach(function (z) {
    var zip = saNormalizeZip_(z);
    if (zip && !seen[zip]) { seen[zip] = true; out.push(zip); }
  });
  return out;
}

// ⚠️ Blank means "no zone ceiling" — Infinity, NOT zero.
//
// Number('') is 0, not NaN. If this returned 0 for an unset value, every zone
// without an explicit cap would read as permanently full and the calendar would
// silently offer nobody any date. The same trap already bit fuFinalLeadDays_ in
// Followups.js; test the raw string BEFORE coercing.
function saMaxPerDay_(value) {
  var raw = String(value == null ? '' : value).trim();
  if (raw === '') return Infinity;
  var n = Number(raw);
  if (isNaN(n) || n <= 0) return Infinity;    // garbage must not close the zone either
  return Math.floor(n);
}

function saIsActive_(value) {
  var s = String(value == null ? '' : value).trim().toUpperCase();
  return s !== 'FALSE' && s !== 'NO' && s !== '0' && s !== 'ARCHIVED';
}

function saYmd_(value) {
  var s = String(value == null ? '' : value).trim();
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return '';
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) return '';
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
    return '';
  }
  return s;
}

function saRowToZone_(row) {
  return {
    zone_id: String(row.zone_id || '').trim(),
    zone_name: String(row.zone_name || '').trim(),
    service_day: saNormalizeDay_(row.service_day),
    zips: saParseZips_(row.zips),
    primary_technician: String(row.primary_technician || '').trim(),
    max_per_day: saMaxPerDay_(row.max_per_day),
    max_per_day_raw: String(row.max_per_day == null ? '' : row.max_per_day).trim(),
    active: saIsActive_(row.active),
    color: String(row.color || '').trim(),
    notes: String(row.notes || '').trim()
  };
}

function listServiceAreas_(includeArchived) {
  var rows = sheetToObjects_(saSheet_()).rows || [];
  var zones = rows.map(saRowToZone_).filter(function (z) { return z.zone_id; });
  return includeArchived ? zones : zones.filter(function (z) { return z.active; });
}

// zip -> zone, built from ACTIVE zones only. An archived zone releases its ZIPs.
function saZipIndex_(zones) {
  var index = {};
  (zones || []).forEach(function (z) {
    if (!z.active) return;
    z.zips.forEach(function (zip) { if (!index[zip]) index[zip] = z; });
  });
  return index;
}

// ── Save, with the one-ZIP-one-zone rule enforced ────────────────────────────
// A ZIP claimed by two zones makes resolution non-deterministic: the same
// address would get different days depending on row order. Rejecting the save
// and naming the conflict is the only honest option — silently letting the
// newer zone win would move real customers without anyone deciding to.
function handleSaveServiceArea_(payload) {
  try {
    var data = payload.zone || payload;
    var sheet = saSheet_();
    var zoneId = String(data.zone_id || '').trim();

    var name = String(data.zone_name || '').trim();
    if (!name) return { ok: false, error: 'Zone name is required.' };

    var day = saNormalizeDay_(data.service_day);
    if (!day) {
      return { ok: false, error: 'A valid service day is required (e.g. TUESDAY).' };
    }
    // Reject days the scheduler can never honour, naming the allowed set rather
    // than just refusing — otherwise the zone looks saved and silently promises
    // a day no technician works.
    var allowed = saSchedulableDays_();
    if (allowed.indexOf(day) === -1) {
      return {
        ok: false,
        error: 'We do not service on ' + day.charAt(0) + day.slice(1).toLowerCase() +
               '. Choose one of: ' + allowed.map(function (d) {
                 return d.charAt(0) + d.slice(1).toLowerCase();
               }).join(', ') + '.',
        schedulable_days: allowed
      };
    }

    var zips = saParseZips_(data.zips);
    var existing = listServiceAreas_(true);

    // Conflict check against every OTHER active zone.
    var conflicts = [];
    existing.forEach(function (z) {
      if (!z.active) return;
      if (zoneId && z.zone_id === zoneId) return;         // editing itself
      z.zips.forEach(function (zip) {
        if (zips.indexOf(zip) !== -1) {
          conflicts.push({ zip: zip, zone_id: z.zone_id, zone_name: z.zone_name });
        }
      });
    });
    if (conflicts.length) {
      var detail = conflicts.map(function (c) { return c.zip + ' → ' + c.zone_name; }).join(', ');
      return {
        ok: false,
        error: 'ZIP already assigned to another zone: ' + detail,
        conflicts: conflicts
      };
    }

    var now = nowIso_();
    var obj = {
      zone_name: name,
      service_day: day,
      zips: zips.join(','),
      primary_technician: String(data.primary_technician || '').trim(),
      // Stored as typed. saMaxPerDay_ handles blank on read.
      max_per_day: data.max_per_day == null ? '' : String(data.max_per_day).trim(),
      active: data.active === false ? 'FALSE' : 'TRUE',
      color: String(data.color || '').trim(),
      notes: String(data.notes || '').trim(),
      updated_at: now
    };

    if (zoneId) {
      var row = findRowByValue_(sheet, 'zone_id', zoneId);
      if (!row) return { ok: false, error: 'Zone not found: ' + zoneId };
      updateObjectRow_(sheet, row._rowNum, obj);
      saBustCaches_();
      return { ok: true, zone_id: zoneId, created: false };
    }

    obj.zone_id = nextSequence_(sheet, 'zone_id', 'ZONE', 4);
    obj.created_at = now;
    appendObject_(sheet, obj, SERVICE_AREA_HEADERS);
    saBustCaches_();
    return { ok: true, zone_id: obj.zone_id, created: true };
  } catch (e) {
    return { ok: false, error: 'handleSaveServiceArea_ Error: ' + e };
  }
}

// Archive, never delete — a zone_id may be referenced by Client_Locations
// overrides and by historical Routes rows.
function handleArchiveServiceArea_(payload) {
  try {
    var zoneId = String(payload.zone_id || '').trim();
    if (!zoneId) return { ok: false, error: 'zone_id is required.' };
    var sheet = saSheet_();
    var row = findRowByValue_(sheet, 'zone_id', zoneId);
    if (!row) return { ok: false, error: 'Zone not found: ' + zoneId };
    var restore = payload.restore === true;
    softSetCell_(sheet, row._rowNum, 'active', restore ? 'TRUE' : 'FALSE');
    softSetCell_(sheet, row._rowNum, 'updated_at', nowIso_());
    saBustCaches_();
    return { ok: true, zone_id: zoneId, active: restore };
  } catch (e) {
    return { ok: false, error: 'handleArchiveServiceArea_ Error: ' + e };
  }
}

function handleGetServiceAreas_(payload) {
  try {
    var zones = listServiceAreas_(payload && payload.include_archived === true);
    return {
      ok: true,
      // The UI builds its day picker from this rather than a hardcoded list, so
      // narrowing SCHEDULABLE_DAYS immediately narrows what an admin can pick.
      schedulable_days: saSchedulableDays_(),
      zones: zones.map(function (z) {
        return {
          zone_id: z.zone_id, zone_name: z.zone_name, service_day: z.service_day,
          zips: z.zips, primary_technician: z.primary_technician,
          // Infinity does not survive JSON — send null and let the UI render
          // "no limit" rather than a number that would read as a real cap.
          max_per_day: z.max_per_day === Infinity ? null : z.max_per_day,
          active: z.active, color: z.color, notes: z.notes,
          zip_count: z.zips.length
        };
      })
    };
  } catch (e) {
    return { ok: false, error: 'handleGetServiceAreas_ Error: ' + e };
  }
}

// ── Schedule blackouts ──────────────────────────────────────────────────────
// Date ranges where signing must not offer starts. The availability reader is
// deliberately tolerant: if this sheet is missing it treats blackouts as empty.
// The admin path below is the durable producer for that optional sheet.
function saRowToBlackout_(row) {
  return {
    blackout_id: String(row.blackout_id || '').trim(),
    start_date: saYmd_(row.start_date),
    end_date: saYmd_(row.end_date) || saYmd_(row.start_date),
    reason: String(row.reason || '').trim(),
    active: saIsActive_(row.active),
    created_at: String(row.created_at || '').trim(),
    updated_at: String(row.updated_at || '').trim()
  };
}

function listScheduleBlackouts_(includeArchived) {
  var rows = sheetToObjects_(saBlackoutSheet_()).rows || [];
  var out = rows.map(saRowToBlackout_).filter(function (b) {
    return b.blackout_id && b.start_date;
  });
  return includeArchived ? out : out.filter(function (b) { return b.active; });
}

function saAppendBlackout_(sheet, obj) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); });
  sheet.appendRow(headers.map(function (h) {
    return obj[h] !== undefined && obj[h] !== null ? obj[h] : '';
  }));
}

function handleListScheduleBlackouts_(payload) {
  try {
    return {
      ok: true,
      blackouts: listScheduleBlackouts_(payload && payload.include_archived === true)
    };
  } catch (e) {
    return { ok: false, error: 'handleListScheduleBlackouts_ Error: ' + e };
  }
}

function handleSaveScheduleBlackout_(payload) {
  try {
    var data = payload.blackout || payload;
    var sheet = saBlackoutSheet_();
    var id = String(data.blackout_id || '').trim();
    var start = saYmd_(data.start_date);
    var end = saYmd_(data.end_date) || start;
    var reason = String(data.reason || '').trim();
    if (!start) return { ok: false, error: 'Start date is required.' };
    if (!end) return { ok: false, error: 'End date is required.' };
    if (end < start) return { ok: false, error: 'End date must be on or after the start date.' };

    var now = nowIso_();
    var obj = {
      start_date: start,
      end_date: end,
      reason: reason,
      active: data.active === false ? 'FALSE' : 'TRUE',
      updated_at: now
    };

    if (id) {
      var row = findRowByValue_(sheet, 'blackout_id', id);
      if (!row) return { ok: false, error: 'Blackout not found: ' + id };
      updateObjectRow_(sheet, row._rowNum, obj);
      saBustCaches_();
      return { ok: true, blackout_id: id, created: false };
    }

    obj.blackout_id = nextSequence_(sheet, 'blackout_id', 'BLACKOUT', 4);
    obj.created_at = now;
    saAppendBlackout_(sheet, obj);
    saBustCaches_();
    return { ok: true, blackout_id: obj.blackout_id, created: true };
  } catch (e) {
    return { ok: false, error: 'handleSaveScheduleBlackout_ Error: ' + e };
  }
}

function handleArchiveScheduleBlackout_(payload) {
  try {
    var id = String(payload.blackout_id || '').trim();
    if (!id) return { ok: false, error: 'blackout_id is required.' };
    var sheet = saBlackoutSheet_();
    var row = findRowByValue_(sheet, 'blackout_id', id);
    if (!row) return { ok: false, error: 'Blackout not found: ' + id };
    var restore = payload.restore === true;
    softSetCell_(sheet, row._rowNum, 'active', restore ? 'TRUE' : 'FALSE');
    softSetCell_(sheet, row._rowNum, 'updated_at', nowIso_());
    saBustCaches_();
    return { ok: true, blackout_id: id, active: restore };
  } catch (e) {
    return { ok: false, error: 'handleArchiveScheduleBlackout_ Error: ' + e };
  }
}

// ── Coverage: which ZIPs still have no zone ──────────────────────────────────
// The seed list is unioned with every ZIP that actually appears in customer
// data, so a ZIP we genuinely serve but never listed still surfaces. ZIPs with
// real customers and no zone sort first — those are the ones that will fall
// through to cluster/fallback and produce no day promise.
function handleGetZoneCoverage_(payload) {
  try {
    var zones = listServiceAreas_(false);
    var index = saZipIndex_(zones);

    var counts = {};
    try {
      var locs = sheetToObjects_(ensureSheet_('Client_Locations', MCPS_LOCATION_HEADERS)).rows || [];
      locs.forEach(function (l) {
        var zip = saNormalizeZip_(l.zip_code);
        if (zip) counts[zip] = (counts[zip] || 0) + 1;
      });
    } catch (e) {
      Logger.log('zone coverage: Client_Locations unreadable (non-blocking): ' + e);
    }

    var all = {};
    SA_SEED_ZIPS.forEach(function (z) { all[z] = true; });
    Object.keys(counts).forEach(function (z) { all[z] = true; });

    var rows = Object.keys(all).sort().map(function (zip) {
      var zone = index[zip];
      return {
        zip: zip,
        zone_id: zone ? zone.zone_id : '',
        zone_name: zone ? zone.zone_name : '',
        service_day: zone ? zone.service_day : '',
        color: zone ? zone.color : '',
        customers: counts[zip] || 0,
        assigned: !!zone
      };
    });

    var unassigned = rows.filter(function (r) { return !r.assigned; });
    return {
      ok: true,
      zips: rows,
      totals: {
        total_zips: rows.length,
        assigned: rows.length - unassigned.length,
        unassigned: unassigned.length,
        // The number that actually matters: customers we serve in no zone.
        unassigned_with_customers: unassigned.filter(function (r) { return r.customers > 0; }).length,
        customers_without_zone: unassigned.reduce(function (s, r) { return s + r.customers; }, 0)
      },
      // Sorted by customer count so the costly gaps are first.
      priority_gaps: unassigned.filter(function (r) { return r.customers > 0; })
        .sort(function (a, b) { return b.customers - a.customers; })
    };
  } catch (e) {
    return { ok: false, error: 'handleGetZoneCoverage_ Error: ' + e };
  }
}

// ── Resolution ───────────────────────────────────────────────────────────────
//
// Returns { zone_id, zone_name, service_day, source }.
//
//   source: 'override'  explicit zone_id on the location  → may promise a day
//           'zone'      ZIP matched a zone                 → may promise a day
//           'cluster'   nearest existing route             → assignment ONLY
//           'fallback'  emptiest schedulable day           → assignment ONLY
//           'none'      nothing resolved
//
// ⚠️ Callers that show a service day to a customer MUST check the source.
// Promising a day derived from 'cluster' is how bad zone coverage fails
// silently: the page looks confident and the day is a guess.
function resolveZoneForAddress_(opts) {
  var o = opts || {};
  var result = { zone_id: '', zone_name: '', service_day: '', source: 'none' };

  var zones;
  try {
    zones = listServiceAreas_(false);
  } catch (e) {
    Logger.log('resolveZoneForAddress_: zones unreadable (non-blocking): ' + e);
    zones = [];
  }

  // 1. Explicit per-location override — the escape hatch for oversized ZIPs.
  var locationId = String(o.locationId || o.location_id || '').trim();
  if (locationId) {
    try {
      var loc = findRowByValue_(
        ensureSheet_('Client_Locations', MCPS_LOCATION_HEADERS), 'location_id', locationId);
      var overrideId = loc ? String(value_(loc, 'zone_id') || '').trim() : '';
      if (overrideId) {
        for (var i = 0; i < zones.length; i++) {
          if (zones[i].zone_id === overrideId) {
            return {
              zone_id: zones[i].zone_id, zone_name: zones[i].zone_name,
              service_day: zones[i].service_day, source: 'override'
            };
          }
        }
        // Override points at an archived or deleted zone: fall through rather
        // than promise a day from a zone that is no longer served.
        Logger.log('resolveZoneForAddress_: location ' + locationId +
                   ' overrides to unknown/archived zone ' + overrideId + '; falling through.');
      }
    } catch (e) {
      Logger.log('resolveZoneForAddress_: override lookup failed (non-blocking): ' + e);
    }
  }

  // 2. ZIP → zone.
  var zip = saNormalizeZip_(o.zip);
  if (zip) {
    var hit = saZipIndex_(zones)[zip];
    if (hit) {
      return {
        zone_id: hit.zone_id, zone_name: hit.zone_name,
        service_day: hit.service_day, source: 'zone'
      };
    }
  }

  // 3/4. Operational safety nets. These NEVER carry a customer-facing promise —
  // note that zone_id and zone_name stay empty, so a caller cannot accidentally
  // render "we service <zone> on <day>" from them.
  try {
    if (o.coords && typeof aaClusterScore_ === 'function' && typeof aaRouteSnapshot_ === 'function') {
      var snap = aaRouteSnapshot_();
      if (snap && snap.hasCoords) {
        var days = (typeof schedulableDays_ === 'function') ? schedulableDays_() : [];
        var best = null, bestScore = Infinity;
        days.forEach(function (day) {
          var s = aaClusterScore_(o.coords, snap.stopsByDay[day]);
          if (s < bestScore) { bestScore = s; best = day; }
        });
        if (best && bestScore !== Infinity) {
          result.service_day = best;
          result.source = 'cluster';
          return result;
        }
      }
    }
  } catch (e) {
    Logger.log('resolveZoneForAddress_: cluster fallback failed (non-blocking): ' + e);
  }

  return result;
}

// ── Technicians serving a zone ───────────────────────────────────────────────
// Resolves the singular/plural mismatch between primary_technician and the
// capacity model: preferred_zones (already read by RoutePlanner into
// preferredZones) is the primary definition, with primary_technician always
// included so a zone is never left with nobody.
function techsForZone_(zoneId, zone) {
  var out = [], seen = {};
  var id = String(zoneId || '').trim();

  var operators = [];
  try {
    operators = (typeof getTechnicianOperators_ === 'function') ? getTechnicianOperators_() : [];
  } catch (e) {
    Logger.log('techsForZone_: operators unreadable (non-blocking): ' + e);
  }

  operators.forEach(function (op) {
    var zonesFor = op.preferredZones;
    if (typeof zonesFor === 'string') zonesFor = zonesFor.split(/[,\s;]+/);
    if (!zonesFor || !zonesFor.length) return;
    for (var i = 0; i < zonesFor.length; i++) {
      if (String(zonesFor[i] || '').trim() === id && id) {
        if (!seen[op.name]) { seen[op.name] = true; out.push(op); }
        return;
      }
    }
  });

  var primary = zone && zone.primary_technician ? String(zone.primary_technician).trim() : '';
  if (primary && !seen[primary]) {
    var match = null;
    operators.forEach(function (op) { if (op.name === primary) match = op; });
    out.push(match || { name: primary, maxPerDay: null, days: [], preferredZones: [] });
  }
  return out;
}

// ── A2: propose zones from the pools we already run ──────────────────────────
//
// Turns the Stage 0a geography report into DRAFT zones. Nothing here writes —
// accepting a proposal means the admin calls save_service_area with it, which
// re-runs every validation including the ZIP conflict check.
//
// Two rules make the output trustworthy rather than merely convenient:
//
//   * A ZIP served on more than one day is NEVER auto-assigned. It goes to
//     `decisions` for a human. Picking the busier day would silently move
//     whichever customers were in the minority.
//
//   * A ZIP already owned by an active zone is skipped, not re-proposed.
//
// Confidence reflects the pocket's coherence, so an admin can accept the tight
// ones in bulk and look hard at the rest.
function proposeServiceAreas_() {
  var geo = analyzeRouteGeography_();
  if (!geo.ok) return { ok: false, error: geo.error };

  var loaded = rgLoadPools_();
  if (!loaded.ok) return { ok: false, error: loaded.error };

  var taken = saZipIndex_(listServiceAreas_(false));

  var ambiguous = {};
  (geo.ambiguous_zips || []).forEach(function (a) { ambiguous[a.zip] = a; });

  // zip -> most common `area` label from Client_Locations, for naming.
  var areaByZip = {};
  try {
    var locs = sheetToObjects_(ensureSheet_('Client_Locations', MCPS_LOCATION_HEADERS)).rows || [];
    var tally = {};
    locs.forEach(function (l) {
      var zip = saNormalizeZip_(l.zip_code);
      var area = String(l.area || '').trim();
      if (!zip || !area) return;
      if (!tally[zip]) tally[zip] = {};
      tally[zip][area] = (tally[zip][area] || 0) + 1;
    });
    Object.keys(tally).forEach(function (zip) {
      var best = '', bestN = 0;
      Object.keys(tally[zip]).forEach(function (a) {
        if (tally[zip][a] > bestN) { bestN = tally[zip][a]; best = a; }
      });
      areaByZip[zip] = best;
    });
  } catch (e) {
    Logger.log('proposeServiceAreas_: area labels unreadable (non-blocking): ' + e);
  }

  var proposals = [];
  var skippedAlreadyZoned = {};

  (geo.days || []).forEach(function (day) {
    var groups = day.zip_group_detail && day.zip_group_detail.length
      ? day.zip_group_detail
      : [day.zips.map(function (z) { return z.zip; })];

    groups.forEach(function (group, groupIdx) {
      var zips = [];
      group.forEach(function (zip) {
        if (ambiguous[zip]) return;                       // human decides
        if (taken[zip]) { skippedAlreadyZoned[zip] = taken[zip].zone_name; return; }
        zips.push(zip);
      });
      if (!zips.length) return;

      // Pools and dominant operator for exactly this (day, zip-set).
      var inGroup = loaded.pools.filter(function (p) {
        return p.day === day.day && zips.indexOf(p.zip) !== -1;
      });
      var opTally = {};
      inGroup.forEach(function (p) {
        if (p.operator) opTally[p.operator] = (opTally[p.operator] || 0) + 1;
      });
      var topOp = '', topN = 0;
      Object.keys(opTally).forEach(function (op) {
        if (opTally[op] > topN) { topN = opTally[op]; topOp = op; }
      });

      // Name: the area label people already use, else the city, else the day.
      var label = '';
      for (var i = 0; i < zips.length && !label; i++) label = areaByZip[zips[i]] || '';
      if (!label) {
        var city = (inGroup[0] && inGroup[0].city) ? inGroup[0].city : '';
        label = city || (day.day.charAt(0) + day.day.slice(1).toLowerCase());
      }
      if (groups.length > 1) label = label + ' ' + (groupIdx + 1);

      var confidence = 'medium';
      if (day.coherence === 'tight' && groups.length === 1) confidence = 'high';
      else if (day.coherence === 'scattered') confidence = 'low';

      proposals.push({
        zone_name: label,
        service_day: day.day,
        zips: zips.sort(),
        primary_technician: topOp,
        pools: inGroup.length,
        // Share of this pocket's pools that the suggested technician already
        // runs — an admin should look twice at a 51% "dominant" operator.
        technician_share: inGroup.length ? Math.round((topN / inGroup.length) * 100) : 0,
        confidence: confidence,
        basis: inGroup.length + ' pool(s) already served on ' + day.day +
               ' across ' + zips.length + ' ZIP(s); day coherence: ' + day.coherence
      });
    });
  });

  var decisions = (geo.ambiguous_zips || []).map(function (a) {
    return {
      zip: a.zip, days: a.days, total_pools: a.total_pools,
      suggested_day: a.suggested_day,
      reason: 'Served on ' + a.days.length + ' different days. A ZIP can belong ' +
              'to only one zone, so this needs a decision.'
    };
  });

  return {
    ok: true,
    generated_at: nowIso_(),
    proposals: proposals.sort(function (a, b) { return b.pools - a.pools; }),
    decisions: decisions,
    already_zoned: Object.keys(skippedAlreadyZoned).sort().map(function (z) {
      return { zip: z, zone_name: skippedAlreadyZoned[z] };
    }),
    totals: {
      proposed_zones: proposals.length,
      proposed_zips: proposals.reduce(function (s, p) { return s + p.zips.length; }, 0),
      decisions_required: decisions.length,
      high_confidence: proposals.filter(function (p) { return p.confidence === 'high'; }).length
    },
    // Proposals are drafts. Accepting one means calling save_service_area,
    // which revalidates everything. This function writes nothing.
    note: 'Drafts only — nothing has been saved. Accepting a proposal calls save_service_area.'
  };
}

function handleProposeServiceAreas_(payload) {
  try {
    return proposeServiceAreas_();
  } catch (e) {
    return { ok: false, error: 'proposeServiceAreas_ Error: ' + e };
  }
}

function saBustCaches_() {
  try {
    var cache = CacheService.getScriptCache();
    cache.remove('service_areas');
    cache.remove('crm_data');
    cache.remove('unassigned_pools');
  } catch (e) {
    Logger.log('saBustCaches_ failed (non-blocking): ' + e);
  }
}
