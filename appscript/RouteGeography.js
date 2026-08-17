// ── Route geography analysis (READ-ONLY) ─────────────────────────────────────
//
// Answers one question before Service Areas are built: are the days we already
// run geographically coherent enough to derive zones from, or is each day
// scattered across the city?
//
// This decides whether zone proposals can be trusted or whether the map has to
// be drawn by hand. It is worth knowing BEFORE a customer is shown a derived
// service day, because a zone map built on incoherent data produces confident,
// wrong promises.
//
// ⚠️ WRITES NOTHING. Every function here reads. Run it as often as you like.
//
// Routes has no zip_code column, so ZIPs come from joining pool_id to
// Signed_Customers — the same sheet calculateRoutes() reads.

var RG_ROUTES_SS_ID = (typeof ROUTES_SPREADSHEET_ID !== 'undefined')
  ? ROUTES_SPREADSHEET_ID : '1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM';
var RG_CRM_SS_ID = (typeof CRM_SPREADSHEET_ID !== 'undefined')
  ? CRM_SPREADSHEET_ID : '1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E';

// How far apart two ZIP centroids can be and still count as the same pocket.
// Single-linkage, so a chain of nearby ZIPs stays one group.
var RG_GROUP_LINK_MILES = 6;

// Mean miles from a day's centroid, above which the day is not one area.
var RG_TIGHT_MILES = 4;
var RG_LOOSE_MILES = 8;

function rgHeaderMap_(headerRow) {
  var out = {};
  (headerRow || []).forEach(function (h, i) {
    out[String(h || '').trim().toLowerCase().replace(/ /g, '_')] = i;
  });
  return out;
}

function rgMiles_(aLat, aLng, bLat, bLng) {
  if (typeof getHaversineDistance_ === 'function') {
    var d = getHaversineDistance_(aLat, aLng, bLat, bLng);
    return (typeof d === 'number' && !isNaN(d)) ? d : null;
  }
  var R = 3958.8;
  var dLat = (bLat - aLat) * Math.PI / 180, dLng = (bLng - aLng) * Math.PI / 180;
  var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) *
          Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function rgCentroid_(points) {
  if (!points.length) return null;
  var lat = 0, lng = 0;
  points.forEach(function (p) { lat += p.lat; lng += p.lng; });
  return { lat: lat / points.length, lng: lng / points.length };
}

// Single-linkage grouping of ZIP centroids. Answers "is this day one pocket or
// several?" — the thing a mean distance alone hides, because two tight clusters
// on opposite sides of town produce a middling mean and a centroid in a field
// where nobody lives.
function rgGroupZips_(zipCentroids) {
  var zips = Object.keys(zipCentroids);
  var groups = zips.map(function (z) { return [z]; });

  var merged = true;
  while (merged) {
    merged = false;
    outer:
    for (var i = 0; i < groups.length; i++) {
      for (var j = i + 1; j < groups.length; j++) {
        for (var a = 0; a < groups[i].length; a++) {
          for (var b = 0; b < groups[j].length; b++) {
            var p = zipCentroids[groups[i][a]], q = zipCentroids[groups[j][b]];
            var d = rgMiles_(p.lat, p.lng, q.lat, q.lng);
            if (d !== null && d <= RG_GROUP_LINK_MILES) {
              groups[i] = groups[i].concat(groups[j]);
              groups.splice(j, 1);
              merged = true;
              break outer;
            }
          }
        }
      }
    }
  }
  return groups;
}

// pool_id -> { zip, city, name } from Signed_Customers.
function rgPoolZipIndex_() {
  var index = {};
  var ss = SpreadsheetApp.openById(RG_CRM_SS_ID);
  var sheet = ss.getSheetByName(
    typeof CRM_SIGNED_SHEET !== 'undefined' ? CRM_SIGNED_SHEET : 'Signed_Customers');
  if (!sheet || sheet.getLastRow() < 2) return index;

  var data = sheet.getDataRange().getValues();
  var h = rgHeaderMap_(data[0]);
  if (h.pool_id === undefined) return index;

  for (var i = 1; i < data.length; i++) {
    var poolId = String(data[i][h.pool_id] || '').trim();
    if (!poolId) continue;
    index[poolId] = {
      zip: h.zip_code !== undefined ? String(data[i][h.zip_code] || '').trim() : '',
      city: h.city !== undefined ? String(data[i][h.city] || '').trim() : '',
      name: [
        h.first_name !== undefined ? data[i][h.first_name] : '',
        h.last_name !== undefined ? data[i][h.last_name] : ''
      ].join(' ').trim()
    };
  }
  return index;
}

// Shared read: every scheduled Routes pool joined to its ZIP and operator.
// Both the geography report and the zone proposer run off this, so they can
// never disagree about which pools exist or where they are.
//
// Returns { ok, pools:[{pool_id, day, operator, zip, geo}], noZip, notGeocoded,
//           unscheduled, skipped } — or { ok:false, error } / { ok:true, empty }.
function rgLoadPools_() {
  var ss = SpreadsheetApp.openById(RG_ROUTES_SS_ID);
  var sheet = ss.getSheetByName('Routes');
  if (!sheet || sheet.getLastRow() < 2) {
    return { ok: true, empty: true, pools: [], noZip: [], notGeocoded: [], unscheduled: 0, skipped: 0 };
  }

  var data = sheet.getDataRange().getValues();
  var h = rgHeaderMap_(data[0]);
  if (h.day_of_week === undefined || h.pool_id === undefined) {
    return { ok: false, error: 'Routes is missing day_of_week or pool_id.' };
  }

  var zipIndex = rgPoolZipIndex_();
  var pools = [], noZip = [], notGeocoded = [], unscheduled = 0, skipped = 0;

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var status = h.route_status !== undefined
      ? String(row[h.route_status] || '').trim().toLowerCase() : '';
    if (status === 'inactive' || status === 'startup_complete') { skipped++; continue; }

    var day = String(row[h.day_of_week] || '').trim().toUpperCase();
    var poolId = String(row[h.pool_id] || '').trim();
    if (!poolId) continue;
    // UNSCHEDULED pools (startups, G2C) have no route day by design — they are
    // counted, not analysed for coherence.
    if (!day || day === 'UNSCHEDULED' || day.indexOf('UNASSIGNED') === 0) { unscheduled++; continue; }

    var meta = zipIndex[poolId] || { zip: '', city: '', name: '' };
    var lat = h.lat !== undefined ? Number(row[h.lat]) : NaN;
    var lng = h.lng !== undefined ? Number(row[h.lng]) : NaN;
    var geo = (!isNaN(lat) && !isNaN(lng) && lat && lng) ? { lat: lat, lng: lng } : null;
    var operator = h.operator !== undefined ? String(row[h.operator] || '').trim() : '';

    var label = poolId + (meta.name ? ' (' + meta.name + ')' : '');
    if (!meta.zip) noZip.push({ pool_id: poolId, label: label, day: day });
    if (!geo) notGeocoded.push({ pool_id: poolId, label: label, day: day });

    pools.push({
      pool_id: poolId, day: day, operator: operator,
      zip: meta.zip, city: meta.city, geo: geo
    });
  }

  return { ok: true, pools: pools, noZip: noZip, notGeocoded: notGeocoded,
           unscheduled: unscheduled, skipped: skipped };
}

function analyzeRouteGeography_() {
  var loaded = rgLoadPools_();
  if (!loaded.ok) return { ok: false, error: loaded.error };
  if (loaded.empty) {
    return { ok: true, days: [], ambiguous_zips: [], note: 'Routes sheet is empty.' };
  }

  var byDay = {};                 // DAY -> { pools:[], zips:{zip:count} }
  var zipDays = {};               // zip -> { DAY -> count }
  var noZip = loaded.noZip, notGeocoded = loaded.notGeocoded;
  var unscheduled = loaded.unscheduled, skipped = loaded.skipped;

  loaded.pools.forEach(function (p) {
    if (!byDay[p.day]) byDay[p.day] = { pools: [], zips: {} };
    byDay[p.day].pools.push(p);
    if (p.zip) {
      byDay[p.day].zips[p.zip] = (byDay[p.day].zips[p.zip] || 0) + 1;
      if (!zipDays[p.zip]) zipDays[p.zip] = {};
      zipDays[p.zip][p.day] = (zipDays[p.zip][p.day] || 0) + 1;
    }
  });

  // ── Per-day coherence ──────────────────────────────────────────────────────
  var days = Object.keys(byDay).map(function (day) {
    var entry = byDay[day];
    var geoPools = entry.pools.filter(function (p) { return p.geo; });
    var centroid = rgCentroid_(geoPools.map(function (p) { return p.geo; }));

    var meanMiles = null, maxMiles = null;
    if (centroid && geoPools.length) {
      var sum = 0, max = 0;
      geoPools.forEach(function (p) {
        var d = rgMiles_(centroid.lat, centroid.lng, p.geo.lat, p.geo.lng) || 0;
        sum += d;
        if (d > max) max = d;
      });
      meanMiles = Math.round((sum / geoPools.length) * 10) / 10;
      maxMiles = Math.round(max * 10) / 10;
    }

    // ZIP centroids, then how many separate pockets they form.
    var zipPoints = {};
    geoPools.forEach(function (p) {
      if (!p.zip) return;
      (zipPoints[p.zip] = zipPoints[p.zip] || []).push(p.geo);
    });
    var zipCentroids = {};
    Object.keys(zipPoints).forEach(function (z) { zipCentroids[z] = rgCentroid_(zipPoints[z]); });
    var groups = rgGroupZips_(zipCentroids);

    var coherence = 'unknown';
    if (meanMiles !== null) {
      if (groups.length > 1) coherence = 'split';               // separate pockets
      else if (meanMiles <= RG_TIGHT_MILES) coherence = 'tight';
      else if (meanMiles <= RG_LOOSE_MILES) coherence = 'loose';
      else coherence = 'scattered';
    }

    return {
      day: day,
      pools: entry.pools.length,
      geocoded: geoPools.length,
      zips: Object.keys(entry.zips).sort().map(function (z) {
        return { zip: z, pools: entry.zips[z] };
      }),
      centroid: centroid,
      mean_miles_from_centroid: meanMiles,
      max_miles_from_centroid: maxMiles,
      zip_groups: groups.length,
      zip_group_detail: groups.map(function (g) { return g.sort(); }),
      coherence: coherence
    };
  }).sort(function (a, b) { return b.pools - a.pools; });

  // ── ZIPs served on more than one day ───────────────────────────────────────
  // These are the decisions a human has to make: a ZIP cannot belong to two
  // zones, so auto-derivation must surface these rather than pick one.
  var ambiguous = Object.keys(zipDays).filter(function (z) {
    return Object.keys(zipDays[z]).length > 1;
  }).map(function (z) {
    var dayList = Object.keys(zipDays[z]).map(function (d) {
      return { day: d, pools: zipDays[z][d] };
    }).sort(function (a, b) { return b.pools - a.pools; });
    return {
      zip: z,
      days: dayList,
      total_pools: dayList.reduce(function (s, d) { return s + d.pools; }, 0),
      // The day with the most pools is the obvious default, but it is a
      // suggestion for a human — never applied automatically.
      suggested_day: dayList[0].day
    };
  }).sort(function (a, b) { return b.total_pools - a.total_pools; });

  var derivable = days.length > 0 &&
    days.every(function (d) { return d.coherence === 'tight' || d.coherence === 'loose'; });

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    days: days,
    ambiguous_zips: ambiguous,
    unclassifiable: {
      no_zip: noZip,
      not_geocoded: notGeocoded,
      no_zip_count: noZip.length,
      not_geocoded_count: notGeocoded.length
    },
    totals: {
      scheduled_pools: days.reduce(function (s, d) { return s + d.pools; }, 0),
      unscheduled_pools: unscheduled,
      inactive_skipped: skipped,
      days_with_pools: days.length,
      ambiguous_zip_count: ambiguous.length
    },
    // A recommendation, not a decision. Read the day detail before trusting it.
    verdict: derivable && !ambiguous.length
      ? 'derivable — days are coherent and no ZIP is split across days'
      : (days.length
          ? 'review needed — see ambiguous_zips and any day marked split/scattered'
          : 'no scheduled pools to analyse')
  };
}

function handleAnalyzeRouteGeography_(payload) {
  try {
    return analyzeRouteGeography_();
  } catch (e) {
    return { ok: false, error: 'analyzeRouteGeography_ Error: ' + e };
  }
}
