// HeadsUp.gs
// Emails the customer directly when a technician confirms "On My Way" in the portal.

var HU_CRM_SS_ID = "1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E";
var HU_ROUTES_SS_ID = "1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM";
var HU_TZ = "America/Chicago";
var HU_LOGO_URL = "https://mcps-log.vercel.app/assets/mission-icon-transparent.png";
var HU_PIN_URL  = "https://mcps-log.vercel.app/assets/mcps-pin-badge.png";

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

// Sends the customer-facing "on our way" email. Called by the send_heads_up
// action once the technician confirms in the portal.
// Return shape is consumed by WebhookReceiver doPost — keep { ok, customer } / { ok, error }.
function sendHeadsUp(pool_id, customer_name, tech_name) {
  var client = lookupClientByPoolId_(pool_id);
  if (!client || !client.email) {
    return { ok: false, error: "No email on file for this customer" };
  }

  var firstName = client.firstName || String(customer_name || "").split(" ")[0] || "there";
  var techName  = tech_name || "Your technician";
  var address   = client.address || "";

  var send = commsSendViaGmail_({
    to: client.email,
    subject: "We're on our way, " + firstName,
    htmlBody: buildOnMyWayHtml_({ firstName: firstName, address: address, techName: techName }),
    plainBody: buildOnMyWayText_({ firstName: firstName, address: address, techName: techName })
  });

  if (!send.ok) return { ok: false, error: send.error || "Email failed to send" };
  return { ok: true, customer: firstName };
}

// ─── Email builders ───────────────────────────────────────────────────────────
// Table-based with fully inline styles: <style> support is inconsistent and flexbox
// unreliable across clients, so nothing structural depends on either. Mirrors
// buildCommsEmailHtml_ in Comms.js.
function buildOnMyWayHtml_(d) {
  // Font stacks fall back device-by-device toward the mockup rather than to Arial:
  //   Montserrat is geometric  -> Avenir Next / Avenir (every Mac + iPhone), then Segoe UI / Roboto.
  //   Open Sans is humanist    -> Segoe UI (Windows), Roboto (Android), Helvetica Neue (Apple).
  // Apple Mail, Outlook for Mac and Thunderbird also honour the webfont <link> below and
  // render true Montserrat/Open Sans; Gmail ignores it and lands on the stack.
  var fh = "'Montserrat','Avenir Next','Avenir','Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
  var fb = "'Open Sans','Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";
  var teal = "#0D3D3E", aqua = "#1FA7A8";
  var esc = function (s) { return huEscapeHtml_(s); };

  var heroLede = esc(d.techName) + " is heading to "
    + (d.address ? esc(d.address) : "your property") + " and will be arriving soon.";

  return '' +
'<!DOCTYPE html><html><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<meta name="color-scheme" content="light only">' +
// Real Montserrat/Open Sans in clients that load webfonts (Apple Mail, iOS Mail,
// Outlook for Mac, Thunderbird). Ignored elsewhere — the inline stacks take over.
'<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800&family=Open+Sans:wght@400;600&display=swap" rel="stylesheet">' +
'<style>@import url(https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800&family=Open+Sans:wght@400;600&display=swap);</style>' +
'</head>' +
'<body style="margin:0;padding:0;background:#F3F5F6;">' +
'<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Our technician will be arriving soon.</div>' +
'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F5F6;">' +
'<tr><td align="center" style="padding:24px 12px;">' +
'<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#FFFFFF;border-radius:12px;overflow:hidden;">' +

// Hero — teal with the aqua glow at the top. bgcolor is the universal fallback;
// the radial-gradient renders in Gmail/Apple Mail and degrades to flat teal in Outlook.
'<tr><td align="center" bgcolor="' + teal + '" style="background-color:' + teal + ';' +
'background-image:radial-gradient(ellipse at 50% -20%, rgba(94,214,211,0.24), rgba(13,61,62,0) 60%);' +
'padding:42px 32px 38px;">' +
'<img src="' + HU_LOGO_URL + '" alt="Mission Custom Pool Solutions" width="84" style="display:block;width:84px;max-width:84px;height:auto;border:0;margin:0 auto 7px;">' +
// Pin badge shipped as a PNG so the circle, pin and halo render identically everywhere.
// The 88px canvas holds a 58px circle plus 15px of transparent halo margin, so the
// surrounding margins are reduced by that 15px to keep the mockup's spacing.
'<img src="' + HU_PIN_URL + '" alt="" width="88" height="88" style="display:block;width:88px;height:88px;border:0;margin:0 auto 7px;">' +
'<div style="font-family:' + fh + ';font-weight:800;font-size:32px;line-height:1.06;letter-spacing:-.3px;color:#FFFFFF;margin:0 0 10px;">We&rsquo;re on our way.</div>' +
'<div style="font-family:' + fb + ';font-size:14px;line-height:1.6;color:#BFD4D4;max-width:380px;margin:0 auto;">' + heroLede + '</div>' +
'</td></tr>' +

// Aqua status strip
'<tr><td align="center" bgcolor="' + aqua + '" style="background:' + aqua + ';padding:16px 32px;font-family:' + fh + ';font-weight:700;font-size:14.5px;letter-spacing:.1px;color:#FFFFFF;">' +
'Our technician will be arriving soon' +
'</td></tr>' +

// Body — technician identity + closing line
'<tr><td align="center" style="padding:32px 32px 34px;">' +
'<div style="font-family:' + fb + ';font-size:13px;color:#6B7777;margin:0 0 3px;">Your technician</div>' +
'<div style="font-family:' + fh + ';font-weight:700;font-size:15px;letter-spacing:-.1px;color:#222222;margin:0 0 26px;">' + esc(d.techName) + '</div>' +
'<div style="font-family:' + fb + ';font-size:14px;line-height:1.6;color:#3A4645;max-width:400px;margin:0 auto;">' +
'Please let us know if you need anything before they arrive &mdash; otherwise, we&rsquo;ll take it from here.' +
'</div>' +
'</td></tr>' +

// Footer
'<tr><td align="center" style="padding:24px 32px 30px;border-top:1px solid #E4EAEA;">' +
'<div style="font-family:' + fh + ';font-weight:bold;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:' + aqua + ';margin-bottom:8px;">Every pool matters.</div>' +
'<div style="font-family:' + fb + ';font-size:12px;line-height:1.6;color:#8A9494;">' +
'Mission Custom Pool Solutions LLC &middot; San Antonio, TX<br>' +
'<a href="https://missioncustompools.com" style="color:' + teal + ';text-decoration:none;">missioncustompools.com</a>' +
'</div>' +
'</td></tr>' +

'</table></td></tr></table></body></html>';
}

function buildOnMyWayText_(d) {
  return [
    "WE'RE ON OUR WAY.",
    "",
    d.techName + " is heading to " + (d.address || "your property") + " and will be arriving soon.",
    "",
    "Your technician: " + d.techName,
    "",
    "Please let us know if you need anything before they arrive — otherwise, we'll take it from here.",
    "",
    "Every pool matters.",
    "Mission Custom Pool Solutions LLC · San Antonio, TX",
    "missioncustompools.com"
  ].join("\n");
}

function huEscapeHtml_(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── Test function — run this directly from the GAS script editor ──────────────
function TEST_sendOnMyWayEmail() {
  var send = commsSendViaGmail_({
    to: "mauriciorebazaf@gmail.com",
    subject: "We're on our way, Jordan",
    htmlBody: buildOnMyWayHtml_({ firstName: "Jordan", address: "123 Mission Creek Dr", techName: "Carlos M." }),
    plainBody: buildOnMyWayText_({ firstName: "Jordan", address: "123 Mission Creek Dr", techName: "Carlos M." })
  });
  Logger.log(JSON.stringify(send, null, 2));
}
