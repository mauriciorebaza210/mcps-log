// HeadsUp.gs
// Notifies the owner via email (sent by Zapier) when a technician taps "On My Way".
// The email contains a pre-filled sms: link — owner taps it to send the text to the customer.

var HU_CRM_SS_ID = "1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E";
var HEADS_UP_TO_EMAIL = "mauriciorebazaf@gmail.com";
var HU_ROUTES_SS_ID = "1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM";
var HU_TZ = "America/Chicago";

function huHeader_(h) {
  return String(h || "").trim().toLowerCase().replace(/ /g, "_");
}

function huDateStr_(v) {
  if (!v) return "";
  if (v instanceof Date) return Utilities.formatDate(v, HU_TZ, "yyyy-MM-dd");
  var s = String(v).trim();
  var m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  var d = new Date(s);
  return isNaN(d.getTime()) ? s : Utilities.formatDate(d, HU_TZ, "yyyy-MM-dd");
}

function huWeekStart_(date) {
  if (typeof getWeekStart_ === "function") return getWeekStart_();
  var d = new Date(date || new Date());
  var ct = new Date(d.toLocaleString("en-US", { timeZone: HU_TZ }));
  var dow = ct.getDay();
  var mon = new Date(ct.getFullYear(), ct.getMonth(), ct.getDate() - (dow === 0 ? 6 : dow - 1));
  return Utilities.formatDate(mon, HU_TZ, "yyyy-MM-dd");
}

function huMatchesOperator_(value, operatorFilter) {
  if (!operatorFilter || String(operatorFilter).toLowerCase() === "all") return true;
  return String(value || "").trim().toLowerCase() === String(operatorFilter).trim().toLowerCase();
}

function huBuildEmailLookup_() {
  var ss = SpreadsheetApp.openById(HU_CRM_SS_ID);
  var sheet = ss.getSheetByName("Quotes");
  if (!sheet || sheet.getLastRow() < 2) return {};

  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(huHeader_);
  var col = function(name) { return headers.indexOf(name); };
  var pidCol = col("pool_id");
  var emailCol = col("email");
  if (pidCol === -1 || emailCol === -1) return {};

  var lookup = {};
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var poolId = String(row[pidCol] || "").trim();
    if (!poolId) continue;
    var first = col("first_name") !== -1 ? String(row[col("first_name")] || "").trim() : "";
    var last = col("last_name") !== -1 ? String(row[col("last_name")] || "").trim() : "";
    var customer = col("customer_name") !== -1 ? String(row[col("customer_name")] || "").trim() : "";
    lookup[poolId.toUpperCase()] = {
      email: String(row[emailCol] || "").trim(),
      customer_name: customer || (first + " " + last).trim(),
      first_name: first,
      last_name: last
    };
  }
  return lookup;
}

// Pulls customer emails for everyone on today's route.
// Optional operatorFilter: pass "all" or leave blank for everyone, or pass a tech/operator name.
// Returns { ok, date, day, emails, people, missing_email }.
function getTodaysRouteEmails(operatorFilter) {
  var now = new Date();
  var today = Utilities.formatDate(now, HU_TZ, "yyyy-MM-dd");
  var todayName = Utilities.formatDate(now, HU_TZ, "EEEE");
  var weekStart = huWeekStart_(now);
  var emailsByPool = huBuildEmailLookup_();
  var seen = {};
  var people = [];
  var missing = [];

  function addStop_(stop) {
    var poolId = String(stop.pool_id || "").trim();
    if (!poolId) return;
    var key = poolId.toUpperCase();
    if (seen[key]) return;
    seen[key] = true;

    var crm = emailsByPool[key] || {};
    var email = String(crm.email || "").trim();
    var person = {
      pool_id: poolId,
      customer_name: String(stop.customer_name || crm.customer_name || "").trim(),
      email: email,
      address: String(stop.address || "").trim(),
      city: String(stop.city || "").trim(),
      service: String(stop.service || stop.service_type || stop.visit_type || "").trim(),
      operator: String(stop.operator || stop.assigned_technician || "").trim(),
      source: String(stop.source || "Routes").trim()
    };

    if (email) {
      people.push(person);
    } else {
      missing.push(person);
    }
  }

  var ss = SpreadsheetApp.openById(HU_ROUTES_SS_ID);
  var routesSheet = ss.getSheetByName("Routes");
  if (routesSheet && routesSheet.getLastRow() > 1) {
    var data = routesSheet.getDataRange().getValues();
    var headers = data[0].map(huHeader_);
    var col = function(name) { return headers.indexOf(name); };
    var weeklyOverrides = typeof getWeeklyOverrides_ === "function" ? getWeeklyOverrides_(weekStart) : {};

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var poolId = col("pool_id") !== -1 ? String(row[col("pool_id")] || "").trim() : "";
      if (!poolId) continue;

      if (typeof isPoolVisibleForWeek_ === "function" && !isPoolVisibleForWeek_(row, col, weekStart)) continue;

      var baseDay = col("day_of_week") !== -1 ? String(row[col("day_of_week")] || "").trim() : "";
      var baseOperator = col("operator") !== -1 ? String(row[col("operator")] || "").trim() : "";
      var override = weeklyOverrides[poolId] || {};
      var day = override.day || baseDay;
      var operator = override.operator || baseOperator;
      if (day !== todayName) continue;
      if (!huMatchesOperator_(operator, operatorFilter)) continue;

      var service = col("service") !== -1 ? String(row[col("service")] || "").trim() : "";
      if (service.toLowerCase().indexOf("monthly") !== -1 && typeof monthlyMatchesWeek_ === "function") {
        var monthlyWeek = col("monthly_week") !== -1 ? String(row[col("monthly_week")] || "").trim() : "";
        if (!monthlyWeek || !monthlyMatchesWeek_(day, monthlyWeek, weekStart)) continue;
      }

      addStop_({
        pool_id: poolId,
        customer_name: col("customer_name") !== -1 ? row[col("customer_name")] : "",
        address: col("address") !== -1 ? row[col("address")] : "",
        city: col("city") !== -1 ? row[col("city")] : "",
        service: service,
        operator: operator,
        source: "Routes"
      });
    }
  }

  if (typeof computeScheduledVisitsForWeek_ === "function") {
    var visitsRes = computeScheduledVisitsForWeek_(weekStart, operatorFilter || null);
    var visits = visitsRes && visitsRes.ok && visitsRes.visits ? visitsRes.visits : [];
    visits.forEach(function(v) {
      if (huDateStr_(v.scheduled_date) !== today) return;
      addStop_({
        pool_id: v.pool_id,
        customer_name: v.customer_name,
        address: v.address,
        city: v.city,
        service: v.service_type,
        visit_type: v.visit_type,
        operator: v.assigned_technician,
        source: "Scheduled_Visits"
      });
    });
  }

  return {
    ok: true,
    date: today,
    day: todayName,
    emails: people.reduce(function(list, p) {
      var email = String(p.email || "").trim();
      if (email && list.indexOf(email) === -1) list.push(email);
      return list;
    }, []),
    people: people,
    missing_email: missing,
    count: people.length,
    missing_count: missing.length
  };
}

function TEST_getTodaysRouteEmails() {
  Logger.log(JSON.stringify(getTodaysRouteEmails("all"), null, 2));
}

// Looks up phone + firstName for a pool_id from the Quotes sheet.
// Returns { ok, phone, firstName } or { ok: false, error }.
function getPoolPhone_(pool_id, customer_name) {
  var cacheKey = 'pool_phone:' + pool_id;
  var cache    = CacheService.getScriptCache();
  var cached   = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var ss = SpreadsheetApp.openById(HU_CRM_SS_ID);
  var sheet = ss.getSheetByName("Quotes");
  if (!sheet) return { ok: false, error: "Quotes sheet not found" };

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return { ok: false, error: "No customer data found" };

  var headers = data[0].map(function(h) { return String(h).trim().toLowerCase(); });
  var poolIdCol    = headers.indexOf("pool_id");
  var phoneCol     = headers.indexOf("phone");
  var firstNameCol = headers.indexOf("first_name");

  if (poolIdCol === -1 || phoneCol === -1) {
    return { ok: false, error: "Required columns not found in Quotes" };
  }

  var phone = null, firstName = null;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][poolIdCol]).trim() === String(pool_id).trim()) {
      phone = String(data[i][phoneCol] || "").trim();
      firstName = firstNameCol !== -1 ? String(data[i][firstNameCol] || "").trim() : "";
      break;
    }
  }

  if (!phone) return { ok: false, error: "Phone number not found for this pool" };

  if (!firstName && customer_name) firstName = String(customer_name).split(" ")[0];
  if (!firstName) firstName = "there";

  var result = { ok: true, phone: phone, firstName: firstName };
  cache.put(cacheKey, JSON.stringify(result), 21600); // 6 hours
  return result;
}

function sendHeadsUp(pool_id, customer_name, tech_name) {
  var result = getPoolPhone_(pool_id, customer_name);
  if (!result.ok) return result;

  var hour = new Date().getHours();
  var greeting = hour < 12 ? 'Good morning' : 'Good afternoon';
  var from = tech_name || 'your technician';
  var message = greeting + '. This is ' + from + ' with Mission Custom Pool Solutions. '
    + 'We just wanted to let you know we are on the way to your property and will be servicing your pool shortly.';

  var zapierUrl = PropertiesService.getScriptProperties().getProperty("ZAPIER_HEADS_UP_WEBHOOK");
  if (!zapierUrl) return { ok: false, error: "Zapier webhook not configured (add ZAPIER_HEADS_UP_WEBHOOK script property)" };

  var digits  = result.phone.replace(/[^0-9]/g, '');
  // Gmail blocks sms: links — use an HTTPS redirect page instead so the button is clickable.
  var smsLink = 'https://mcps-log.vercel.app/sms?ph=' + digits + '&b=' + encodeURIComponent(message);

  try {
    UrlFetchApp.fetch(zapierUrl, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        email_type: "heads_up",
        to_email: HEADS_UP_TO_EMAIL,
        first_name: result.firstName,
        tech_name:  from,
        message:    message,
        sms_link:   smsLink
      }),
      muteHttpExceptions: true
    });
  } catch (err) {
    return { ok: false, error: "Failed to reach Zapier: " + String(err) };
  }

  return { ok: true, customer: result.firstName };
}

// ── Test function — run this directly from the GAS script editor ──────────────
function TEST_sendHeadsUp() {
  var zapierUrl = PropertiesService.getScriptProperties().getProperty("ZAPIER_HEADS_UP_WEBHOOK");
  if (!zapierUrl) {
    Logger.log("ERROR: ZAPIER_HEADS_UP_WEBHOOK script property not set");
    return;
  }
  var testPhone   = "2105592073";
  var message     = "Good morning. This is Carlos with Mission Custom Pool Solutions. We just wanted to let you know we are on the way to your property and will be servicing your pool shortly.";
  var smsLink     = "https://mcps-log.vercel.app/sms?ph=" + testPhone + "&b=" + encodeURIComponent(message);
  var response = UrlFetchApp.fetch(zapierUrl, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      email_type: "heads_up",
      to_email: HEADS_UP_TO_EMAIL,
      first_name: "Mauricio",
      tech_name:  "Carlos",
      message:    message,
      sms_link:   smsLink
    }),
    muteHttpExceptions: true
  });
  Logger.log("Status: " + response.getResponseCode());
  Logger.log("Response: " + response.getContentText());
}
