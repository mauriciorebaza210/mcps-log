// CommsReport.js — did the campaign make any money?
//
// ⚠️ THE JOIN KEY IS EMAIL, NOT quote_id.
// Comms_Log stores the quote_id a recipient was resolved from, which looks like
// the obvious join. It is wrong. handleSaveQuote_ mints a FRESH quote_id and
// appends a new row rather than updating the lead, so the moment a lead converts
// it exists twice — and the row carrying signed_at is not the row the campaign
// was sent to. Joining on quote_id therefore under-reports exactly the conversions
// the report exists to find. Email is the key commsDedupeAndFlag_ already treats
// as identity, so it is the one that holds across that split.
//
// Model: LAST-TOUCH, within a window, restricted to bulk (marketing/announcement)
// campaigns. Stated in the response so the UI can print it next to the number —
// an unlabelled revenue figure gets quoted in a meeting and defended forever.

var CR_DEFAULT_WINDOW_DAYS = 30;
var CR_CACHE_KEY = 'comms_report';
var CR_CACHE_TTL = 300;

function crWindowDays_() {
  var raw = commsProps_().getProperty('COMMS_ATTRIBUTION_DAYS');
  var n = Number(raw);
  return (raw && !isNaN(n) && n > 0) ? n : CR_DEFAULT_WINDOW_DAYS;
}

function crNorm_(v) { return String(v == null ? '' : v).trim(); }
function crEmail_(v) { return crNorm_(v).toLowerCase(); }
function crDate_(v) {
  if (!v) return 0;
  if (v instanceof Date) { var t = v.getTime(); return isNaN(t) ? 0 : t; }
  var p = Date.parse(String(v));
  return isNaN(p) ? 0 : p;
}
function crMoney_(v) {
  var n = Number(String(v == null ? '' : v).replace(/[$,]/g, ''));
  return isNaN(n) ? 0 : n;
}

// Only commercial mail earns credit. A reschedule notice that happens to precede
// a signing did not sell anything, and counting it would flatter the number.
function crIsAttributable_(category) {
  var c = crNorm_(category).toLowerCase();
  return c === 'marketing' || c === 'announcement';
}

function handleCommsCampaignReport_(payload) {
  commsEnsureSheets_();
  payload = payload || {};

  var cache = CacheService.getScriptCache();
  if (!payload.refresh) {
    try {
      var hit = cache.get(CR_CACHE_KEY);
      if (hit) return JSON.parse(hit);
    } catch (e) {}
  }

  var windowDays = crWindowDays_();
  var windowMs = windowDays * 86400000;

  var campaigns = {};
  commsSheetRows_('campaigns').forEach(function (c) {
    campaigns[c.campaign_id] = {
      campaign_id: c.campaign_id, name: c.name, category: c.category,
      lane: c.lane || '', status: c.status,
      sent_at: c.started_at || c.created_at || '',
      attributable: crIsAttributable_(c.category),
      sent: 0, failed: 0, skipped: 0, bounced: 0, clicked: 0,
      quotes_after: 0, signings: 0, revenue: 0
    };
  });

  // One pass over the log: delivery counters, plus the per-address send history
  // that attribution walks backwards from.
  var sendsByEmail = {};
  commsSheetRows_('log').forEach(function (r) {
    var c = campaigns[r.campaign_id];
    if (!c) return;                               // TEST_DRAFT and orphans
    var st = crNorm_(r.status);
    if (st === 'sent') c.sent++;
    else if (st === 'failed') c.failed++;
    else if (st.indexOf('skipped') === 0) c.skipped++;
    if (crNorm_(r.bounce_reason)) c.bounced++;
    if (crDate_(r.clicked_at)) c.clicked++;

    if (st !== 'sent' || !c.attributable) return;
    var email = crEmail_(r.email);
    if (!email) return;
    var when = crDate_(r.sent_at) || crDate_(c.sent_at);
    if (!when) return;
    (sendsByEmail[email] = sendsByEmail[email] || []).push({ campaign_id: r.campaign_id, at: when });
  });

  Object.keys(sendsByEmail).forEach(function (e) {
    sendsByEmail[e].sort(function (a, b) { return a.at - b.at; });
  });

  var crm = handleGetCRMData();
  var rows = (crm && crm.ok && crm.data) ? crm.data : [];
  var totalRevenue = 0, totalSignings = 0, outsideWindow = 0;

  rows.forEach(function (r) {
    var email = crEmail_(r.email);
    if (!email) return;
    var sends = sendsByEmail[email];
    if (!sends || !sends.length) return;

    var created = crDate_(r.timestamp);
    var signed = crDate_(r.signed_at);

    // A quote raised after we mailed them is a real signal even before it closes,
    // and at low volume it is often the only signal there is yet.
    if (created) {
      for (var i = sends.length - 1; i >= 0; i--) {
        if (created > sends[i].at && created - sends[i].at <= windowMs) {
          campaigns[sends[i].campaign_id].quotes_after++;
          break;
        }
      }
    }

    if (!signed) return;
    // Last touch: the most recent send BEFORE the signing, inside the window.
    var hit = null;
    for (var j = sends.length - 1; j >= 0; j--) {
      if (signed > sends[j].at && signed - sends[j].at <= windowMs) { hit = sends[j]; break; }
    }
    // Counted only for people we DID mail commercially. Someone who signed
    // without ever receiving a campaign is organic business, not an attribution
    // miss, and folding them in here would make the number meaningless.
    if (!hit) { outsideWindow++; return; }
    var c = campaigns[hit.campaign_id];
    c.signings++;
    var value = crMoney_(r.total_with_tax);
    c.revenue += value;
    totalRevenue += value;
    totalSignings++;
  });

  var list = Object.keys(campaigns).map(function (k) {
    var c = campaigns[k];
    c.click_rate = c.sent ? Math.round(1000 * c.clicked / c.sent) / 10 : 0;
    c.bounce_rate = c.sent ? Math.round(1000 * c.bounced / c.sent) / 10 : 0;
    return c;
  }).sort(function (a, b) { return String(b.sent_at).localeCompare(String(a.sent_at)); });

  var out = {
    ok: true,
    campaigns: list,
    totals: { revenue: totalRevenue, signings: totalSignings,
              // Mailed commercially, then signed — but not inside the window
              // after a send. An attribution-quality signal, not lost business.
              signings_outside_window: outsideWindow },
    model: {
      basis: 'last-touch',
      window_days: windowDays,
      join: 'email',
      scope: 'marketing and announcement campaigns only',
      // Said plainly, because the difference decides whether this number belongs
      // in a budget conversation.
      caveat: 'Influenced, not incremental — there is no holdout group, so this ' +
              'shows revenue that followed a campaign, not revenue it caused.'
    },
    generated_at: new Date().toISOString()
  };

  try { cache.put(CR_CACHE_KEY, JSON.stringify(out), CR_CACHE_TTL); } catch (e2) {}
  return out;
}

function crInvalidateReportCache_() {
  try { CacheService.getScriptCache().remove(CR_CACHE_KEY); } catch (e) {}
}
