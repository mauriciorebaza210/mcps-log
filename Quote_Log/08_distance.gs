//08_distance.gs

function getMapsCfg_() {
  const props = PropertiesService.getScriptProperties();
  return {
    apiKey: props.getProperty("GOOGLE_MAPS_API_KEY"),
    hq: props.getProperty("HQ_ADDRESS") || "6991 Raintree Grove, Elmendorf, TX 78112",
    rate: parseFloat(props.getProperty("RATE_PER_MILE") || "0.40"),
    roundTo: parseInt(props.getProperty("ROUND_TO_MILES") || "5", 10),
    cacheDays: parseInt(props.getProperty("CACHE_MAX_AGE_DAYS") || "60", 10),
  };
}

function normalizeDestKey_(dest) {
  return String(dest || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

function getDistanceCacheSheet_(ss) {
  const name = "Distance_Cache";
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(["dest_key","destination","one_way_miles","updated_at","source","status"]);
  }
  return sh;
}

function cacheLookup_(ss, destKey, maxAgeDays) {
  const sh = getDistanceCacheSheet_(ss);
  const values = sh.getDataRange().getValues();
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  for (let i = values.length - 1; i >= 1; i--) {
    const row = values[i];
    if (row[0] === destKey && row[5] === "OK") {
      const updated = row[3] instanceof Date ? row[3].getTime() : new Date(row[3]).getTime();
      if (!isNaN(updated) && (now - updated) <= maxAgeMs) {
        return { oneWayMiles: parseFloat(row[2]), destination: row[1] };
      }
    }
  }
  return null;
}

function cacheWrite_(ss, destKey, destination, oneWayMiles, source, status) {
  const sh = getDistanceCacheSheet_(ss);
  sh.appendRow([destKey, destination, oneWayMiles || "", new Date(), source || "", status || "OK"]);
}

function getDrivingMiles_(origin, destination, apiKey) {
  const url = "https://maps.googleapis.com/maps/api/distancematrix/json"
    + "?origins=" + encodeURIComponent(origin)
    + "&destinations=" + encodeURIComponent(destination)
    + "&mode=driving&units=imperial"
    + "&key=" + encodeURIComponent(apiKey);

  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const data = JSON.parse(resp.getContentText());

  if (data.status !== "OK") throw new Error("DistanceMatrix status: " + data.status);

  const el = data.rows && data.rows[0] && data.rows[0].elements && data.rows[0].elements[0] ? data.rows[0].elements[0] : null;
  if (!el || el.status !== "OK") throw new Error("Route status: " + (el ? el.status : "NO_ELEMENT"));

  return el.distance.value / 1609.344; // meters -> miles
}

function computeTravelWithCache_(destination) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = getMapsCfg_();
  if (!cfg.apiKey) throw new Error("Missing GOOGLE_MAPS_API_KEY in Script Properties");

  const destKey = normalizeDestKey_(destination);

  const hit = cacheLookup_(ss, destKey, cfg.cacheDays);
  let oneWay, source;

  if (hit) {
    oneWay = hit.oneWayMiles;
    source = "cache";
  } else {
    oneWay = getDrivingMiles_(cfg.hq, destination, cfg.apiKey);
    source = "google_distance_matrix";
    cacheWrite_(ss, destKey, destination, oneWay, source, "OK");
  }

  const roundTrip = oneWay * 2;
  const billable = Math.ceil(roundTrip / cfg.roundTo) * cfg.roundTo;
  const fee = billable * cfg.rate;

  return {
    origin: cfg.hq,
    destination: destination,
    dest_key: destKey,
    one_way_miles: Math.round(oneWay * 10) / 10,
    round_trip_miles: Math.round(roundTrip * 10) / 10,
    billable_round_trip_miles: billable,
    travel_rate_per_mile: cfg.rate,
    travel_fee: Math.round(fee * 100) / 100,
    distance_source: source,
  };
}

function authorizeUrlFetch() {
  UrlFetchApp.fetch("https://www.google.com");
  return "ok";
}

