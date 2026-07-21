// VisitReportEmail.gs — FULL REPLACEMENT
// Assembles and sends visit report email via Zapier webhook.
// Now supports up to 4 inline photos passed as Drive thumbnail URLs.

// Zapier webhook URL is read from Script Properties (set VISIT_REPORT_ZAPIER_WEBHOOK)
// so the secret never lives in source. Read lazily inside senders — never at global
// scope — to avoid a Properties API call on every portal request.
function visitReportZapierWebhook_() {
  return PropertiesService.getScriptProperties().getProperty("VISIT_REPORT_ZAPIER_WEBHOOK") || "";
}
const VISIT_REPORT_BCC            = "mauricio@mcpoolsolutions.org,antonio@mcpoolsolutions.org";
const VISIT_REPORT_MCP_RECIPIENT  = "rosy@missioncustompools.com";
const VISIT_REPORT_FROM           = "antonio@mcpoolsolutions.org";
const VISIT_REPORT_FROM_NAME      = "Mission Custom Pool Solutions";
const VISIT_REPORT_LOGO_URL       = "https://mcps-log.vercel.app/logo.png";
const VISIT_REPORT_PHONE          = "(210) 559-2073";
const VISIT_REPORT_WEBSITE        = "missioncustompools.com";

const CRM_SS_ID_VR = "1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E";

// Water chemistry target ranges.
// `optional: true` readings are only shown in the email when the tech entered a value.
const WATER_RANGES = {
  "Free Chlorine (FC)":    { min: 3,   max: 5 },
  "pH":                    { min: 7.2, max: 7.6 },
  "Total Alkalinity (TA)": { min: 90,  max: Infinity },
  "Calcium Hardness (CH)": { min: 200, max: Infinity },
  "Cyanuric Acid (CYA)":   { min: 30,  max: 80,   unit: "ppm", optional: true },
  "Salt Level":            { min: 2700, max: 4500, unit: "ppm", optional: true }
};

// Non-chemical headers to skip when building chemicals-used list.
// Water-test readings live here so they are never counted as a "chemical used".
const VR_NON_CHEM = new Set([
  "Timestamp","pool_id","Technician","Notes","Client Name","Address",
  "Service Type","Month","Visit # in Month","Week Start","WeekKey",
  "MonthKey","Visit # in Week","Total Visit Chem Cost (Snapshot)",
  "Free Chlorine (FC)","pH","Total Alkalinity (TA)","Calcium Hardness (CH)",
  "Cyanuric Acid (CYA)","Salt Level",
  "Pool description (if Other selected)","_photo_urls","Tablet Level",
  "Technician Actions","Chlorinator Adjustment","_chemical_fields"
]);

// Unit fallbacks for chemicals not present in the Chem_Costs unit map.
// Ensures the customer email always shows a sensible unit.
const VR_UNIT_FALLBACK = {
  "Soda Ash"                  : "lbs",
  "Diatomaceous Earth (DE)"   : "lbs",
  "Salt"                      : "lbs",
  "Cal Hypo"                  : "lbs",
  "Cyanuric Acid (Stabilizer)": "lbs",
  'Chlorine Tablets (3")'     : "tablets"
};

function getSubmittedChemicalFieldSet_(rawRow, rawHeaders) {
  const idx = rawHeaders.indexOf("_chemical_fields");
  if (idx === -1) return null;

  const raw = rawRow[idx];
  let fields = [];
  if (Array.isArray(raw)) {
    fields = raw;
  } else if (raw !== undefined && raw !== null && String(raw).trim()) {
    const str = String(raw).trim();
    try {
      const parsed = JSON.parse(str);
      fields = Array.isArray(parsed) ? parsed : [];
    } catch(e) {
      fields = str.split(",");
    }
  }

  const set = new Set(
    fields.map(v => String(v || "").trim()).filter(Boolean)
  );
  return set.size ? set : null;
}

function isUsageChemicalHeader_(header, chemicalFieldSet) {
  const h = String(header || "").trim();
  if (!h || h.endsWith(" Unit Cost (Snapshot)")) return false;
  if (chemicalFieldSet) return chemicalFieldSet.has(h);
  return !VR_NON_CHEM.has(h);
}



// ─── Test helpers ──────────────────────────────────────────────────────────────
function TEST_crmAccess() {
  try {
    const ss = SpreadsheetApp.openById(CRM_SS_ID_VR);
    Logger.log("✅ CRM accessible: " + ss.getName());
  } catch(e) {
    Logger.log("❌ Error: " + e);
  }
}

function TEST_visitReportToMe() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Chemical_Usage_Log");
  if (!sheet || sheet.getLastRow() < 2) { Logger.log("No data rows found"); return; }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();

  const poolCol = headers.indexOf("pool_id");
  let targetRow = null, targetSheetRow = null;

  for (let i = data.length - 1; i >= 0; i--) {
    const row = data[i];
    const chemicalFieldSet = getSubmittedChemicalFieldSet_(row, headers);
    const hasChemicals = headers.some((h, colIndex) => {
      if (!isUsageChemicalHeader_(h, chemicalFieldSet)) return false;
      const qty = parseFloat(row[colIndex]);
      return isFinite(qty) && qty > 0;
    });
    if (hasChemicals) { targetRow = row; targetSheetRow = i + 2; break; }
  }

  if (!targetRow) { Logger.log("No row with chemicals found"); return; }
  const poolId = poolCol !== -1 ? String(targetRow[poolCol] || "").trim() : "";
  if (!poolId) { Logger.log("Target row has no pool_id"); return; }

  const payload = buildVisitReportPayload_(targetRow, headers, poolId, []);
  if (!payload) { Logger.log("Could not build payload"); return; }

  payload.to  = "mauriciorebazaf@gmail.com";
  payload.bcc = "";

  const response = UrlFetchApp.fetch(visitReportZapierWebhook_(), {
    method: "POST", contentType: "application/json",
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  Logger.log("Used sheet row: " + targetSheetRow + " | Pool: " + poolId);
  Logger.log("Zapier response: " + response.getResponseCode() + " — " + response.getContentText());
  SpreadsheetApp.getActiveSpreadsheet().toast("Test email fired", "Visit Report");
}

function TEST_visitReportPayloadDryRun(poolIdOverride) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Chemical_Usage_Log");
  if (!sheet || sheet.getLastRow() < 2) { Logger.log("No data rows found"); return; }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();

  const poolCol = headers.indexOf("pool_id");
  let targetRow = null, targetSheetRow = null, poolId = String(poolIdOverride || "").trim();

  for (let i = data.length - 1; i >= 0; i--) {
    const rowPoolId = poolCol !== -1 ? String(data[i][poolCol] || "").trim() : "";
    if (poolId && rowPoolId !== poolId) continue;
    if (!poolId) poolId = rowPoolId;
    if (poolId) {
      targetRow = data[i];
      targetSheetRow = i + 2;
      break;
    }
  }

  if (!targetRow || !poolId) {
    Logger.log("No visit row found" + (poolIdOverride ? " for " + poolIdOverride : ""));
    return;
  }

  const payload = buildVisitReportPayload_(targetRow, headers, poolId, []);
  if (!payload) { Logger.log("Could not build payload"); return; }

  Logger.log("DRY RUN ONLY — no Zapier webhook called.");
  Logger.log("Used sheet row: " + targetSheetRow + " | Pool: " + poolId);
  Logger.log("To: " + payload.to);
  Logger.log("Bcc: " + payload.bcc);
  Logger.log("Subject: " + payload.subject);
  Logger.log("Client: " + payload.clientName);
}

// ─── Main entry point ──────────────────────────────────────────────────────────
// UPDATED SIGNATURE: now accepts optional photoUrls array
function sendVisitReportEmail(rawRow, rawHeaders, poolId, photoUrls) {
  try {
    if (!poolId || poolId === "Other / Pool not listed") {
      Logger.log("sendVisitReportEmail: skipping — no valid pool_id");
      return;
    }

    const vrWebhook = visitReportZapierWebhook_();
    if (!vrWebhook || vrWebhook === "YOUR_ZAPIER_WEBHOOK_URL_HERE") {
      Logger.log("sendVisitReportEmail: webhook not configured yet (set VISIT_REPORT_ZAPIER_WEBHOOK script property)");
      return;
    }

    const photos = Array.isArray(photoUrls) ? photoUrls : [];
    const payload = buildVisitReportPayload_(rawRow, rawHeaders, poolId, photos);
    if (!payload) {
      Logger.log("sendVisitReportEmail: could not build payload (no client email?)");
      return;
    }

    const dedupKey = buildUsageDedupKey_(rawRow, rawHeaders, poolId);
    if (!claimDedupAction_("visit_report_email", dedupKey)) {
      Logger.log("Duplicate visit report prevented for " + dedupKey);
      return;
    }

    UrlFetchApp.fetch(vrWebhook, {
      method: "POST",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    Logger.log("Visit report sent for " + poolId + " with " + photos.length + " photo(s)");
  } catch(e) {
    Logger.log("sendVisitReportEmail error: " + e);
  }
}

// ─── Also callable after unmatched submission is resolved ───────────────────────
function sendVisitReportForUnmatched(logRowIndex, poolId, photoUrls) {
  try {
    const ss         = SpreadsheetApp.getActiveSpreadsheet();
    const usageSheet = ss.getSheetByName("Chemical_Usage_Log");
    if (!usageSheet) return;
    const headers = usageSheet.getRange(1, 1, 1, usageSheet.getLastColumn())
      .getValues()[0].map(h => String(h || "").trim());
    const rowData = usageSheet.getRange(logRowIndex, 1, 1, usageSheet.getLastColumn()).getValues()[0];
    sendVisitReportEmail(rowData, headers, poolId, photoUrls || []);
  } catch(e) {
    Logger.log("sendVisitReportForUnmatched error: " + e);
  }
}

// ─── Build the full payload ─────────────────────────────────────────────────────
function buildVisitReportPayload_(rawRow, rawHeaders, poolId, photoUrls) {
  const get = h => {
    const i = rawHeaders.indexOf(h);
    if (i === -1) return "";
    const val = rawRow[i];
    return String(val !== undefined && val !== null && val !== "" ? val : "").trim();
  };

  const client = lookupClientByPoolId_(poolId);
  if (!client || !client.email) {
    Logger.log("No client email found for " + poolId);
    return null;
  }

  const timestamp  = get("Timestamp");
  const technician = get("Technician");
  const rawNotes = get("Notes");
  const notes = String(rawNotes || "")
    .replace(/\s*\[condition:[^\]]*\]\s*/ig, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  const date       = timestamp ? new Date(timestamp) : new Date();
  const dateStr    = Utilities.formatDate(date, "America/Chicago", "MMMM d, yyyy");
  const timeStr    = Utilities.formatDate(date, "America/Chicago", "h:mm a");
  const fullName   = [client.firstName, client.lastName].filter(Boolean).join(" ");
  const rawTabletLevel = get("Tablet Level") || "";
  const tabletLevel = rawTabletLevel ? rawTabletLevel.charAt(0).toUpperCase() + rawTabletLevel.slice(1) : "";

  // Water readings
  const readings = Object.keys(WATER_RANGES).map(label => {
    const raw   = get(label);
    const val   = parseFloat(raw);
    const range = WATER_RANGES[label];
    // Optional readings (CYA, Salt) only appear when the tech actually tested them.
    if (range.optional && !isFinite(val)) return null;
    const inRange = isFinite(val) && val >= range.min && val <= range.max;
    const status  = !isFinite(val) ? "" : (inRange ? "In range" : "Being monitored");
    return {
      label  : label.replace(" (FC)", "").replace(" (Cl)", "").replace(" (TA)", "").replace(" (CH)", "").replace(" (CYA)", ""),
      value  : isFinite(val) ? val.toString() : "—",
      unit   : range.unit,
      status : status,
      ok     : inRange
    };
  }).filter(Boolean);

  // Chemicals used
  const unitMap   = getChemicalUnitMap_();
  const chemicals = [];
  const chemicalFieldSet = getSubmittedChemicalFieldSet_(rawRow, rawHeaders);
  rawHeaders.forEach((h, i) => {
    if (!isUsageChemicalHeader_(h, chemicalFieldSet)) return;
    const qty = parseFloat(rawRow[i]);
    if (isFinite(qty) && qty > 0) {
      chemicals.push({ name: h, qty: qty, unit: unitMap[h] || VR_UNIT_FALLBACK[h] || "" });
    }
  });

  // Actions performed this visit (comma-joined checklist + chlorinator adjustment)
  const actions        = get("Technician Actions") || "";
  const chlorinatorAdj = get("Chlorinator Adjustment") || "";

  // Safely parse photo URLs (may come from sheet as JSON string or array)
  let photos = [];
  if (Array.isArray(photoUrls) && photoUrls.length > 0) {
    photos = photoUrls;
  } else {
    // Try reading from row if stored as JSON in a _photo_urls column
    const photoColIdx = rawHeaders.indexOf("_photo_urls");
    if (photoColIdx !== -1) {
      try { photos = JSON.parse(rawRow[photoColIdx] || "[]"); } catch(e) { photos = []; }
    }
  }

  const html = buildEmailHtml_({ clientName: fullName, poolAddress: client.address,
    dateStr, timeStr, technician, notes, readings, chemicals,
    service: client.service, photos, tabletLevel, actions, chlorinatorAdj });
  const text = buildEmailText_({ clientName: fullName, poolAddress: client.address,
    dateStr, technician, notes, readings, chemicals, service: client.service,
    tabletLevel, actions, chlorinatorAdj });

  let bcc = VISIT_REPORT_BCC;
  if (client.sponsoredByMcp) bcc = appendUniqueEmail_(bcc, VISIT_REPORT_MCP_RECIPIENT);
  if (client.startupCompanyEmail) bcc = appendUniqueEmail_(bcc, client.startupCompanyEmail);

  return {
    to: client.email, bcc: bcc,
    from: VISIT_REPORT_FROM, from_name: VISIT_REPORT_FROM_NAME,
    subject: "Your Pool Service Visit — " + dateStr,
    html_body: html, text_body: text,
    clientName: fullName, pool_id: poolId
  };
}

// ─── CRM lookup ─────────────────────────────────────────────────────────────────
function lookupClientByPoolId_(poolId) {
  poolId = String(poolId || "").trim().toUpperCase();
  const match = String(poolId || "").match(/MCPS-\d+/i);
  poolId = match ? match[0].toUpperCase() : String(poolId || "").trim().toUpperCase();

  const crmSs = SpreadsheetApp.openById(CRM_SS_ID_VR);
  const sheet = crmSs.getSheetByName("Quotes");
  if (!sheet || sheet.getLastRow() < 2) return null;
  const hdrs = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim().toLowerCase());
  const pidCol   = hdrs.indexOf("pool_id");
  const emailCol = hdrs.indexOf("email");
  const firstCol = hdrs.indexOf("first_name");
  const lastCol  = hdrs.indexOf("last_name");
  const adrCol   = hdrs.indexOf("address");
  const svcCol   = hdrs.indexOf("service");
  const mcpCol   = hdrs.indexOf("sponsored_by_mcp");
  const startupCompanyCol = hdrs.indexOf("startup_company");
  const startupCompanyEmailCol = hdrs.indexOf("startup_company_email");
  if (pidCol === -1 || emailCol === -1) return null;
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  for (const row of data) {
    const pid = String(row[pidCol] || "").trim().toUpperCase();
    if (pid === poolId) {
      const startupCompany = startupCompanyCol !== -1 ? String(row[startupCompanyCol] || "").trim() : "";
      const savedCompanyEmail = startupCompanyEmailCol !== -1 ? String(row[startupCompanyEmailCol] || "").trim() : "";
      return {
        email    : String(row[emailCol] || "").trim(),
        firstName: firstCol !== -1 ? String(row[firstCol] || "").trim() : "",
        lastName : lastCol  !== -1 ? String(row[lastCol]  || "").trim() : "",
        address  : adrCol   !== -1 ? String(row[adrCol]   || "").trim() : "",
        service  : svcCol   !== -1 ? String(row[svcCol]   || "").trim() : "",
        sponsoredByMcp: mcpCol !== -1 ? isTruthyCell_(row[mcpCol]) : false,
        startupCompany: startupCompany,
        startupCompanyEmail: savedCompanyEmail || lookupPoolCompanyReportEmail_(startupCompany)
      };
    }
  }
  return null;
}

function lookupPoolCompanyReportEmail_(companyName) {
  const target = String(companyName || "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!target) return "";
  try {
    const crmSs = SpreadsheetApp.openById(CRM_SS_ID_VR);
    const sheet = crmSs.getSheetByName("Pool_Companies");
    if (!sheet || sheet.getLastRow() < 2) return "";
    const hdrs = sheet.getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0].map(h => String(h || "").trim().toLowerCase().replace(/ /g, "_"));
    const nameCol = hdrs.indexOf("company_name");
    const emailCol = hdrs.indexOf("report_bcc_email");
    const activeCol = hdrs.indexOf("active");
    if (nameCol === -1 || emailCol === -1) return "";
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
    for (const row of data) {
      const name = String(row[nameCol] || "").trim().replace(/\s+/g, " ").toLowerCase();
      const active = activeCol === -1 ? "TRUE" : String(row[activeCol] || "TRUE").trim().toUpperCase();
      if (name === target && active !== "FALSE") return String(row[emailCol] || "").trim();
    }
  } catch(e) {
    Logger.log("lookupPoolCompanyReportEmail_ error: " + e);
  }
  return "";
}

function isTruthyCell_(value) {
  if (value === true) return true;
  const s = String(value || "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "y" || s === "1";
}

function appendUniqueEmail_(base, email) {
  const parts = String(base || "")
    .split(",")
    .map(e => e.trim())
    .filter(Boolean);
  const wanted = String(email || "").trim();
  if (wanted && !parts.some(e => e.toLowerCase() === wanted.toLowerCase())) {
    parts.push(wanted);
  }
  return parts.join(",");
}

// ─── HTML email builder ─────────────────────────────────────────────────────────
function buildEmailHtml_(d) {
  const hasReadings  = d.readings.some(r => r.value !== "—");
  const hasChemicals = d.chemicals.length > 0;
  const hasPhotos    = Array.isArray(d.photos) && d.photos.length > 0;

  const readingRows = d.readings.map(r => {
    const color = r.value === "—" ? "#9aa0a6" : r.ok ? "#137333" : "#b06000";
    const badge = r.status
      ? '<span style="background:' + (r.ok ? "#e6f4ea" : "#fef7e0") +
        ';color:' + color + ';padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">' +
        r.status + '</span>'
      : "";
      
    let rowHTML = '<tr>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #f1f3f4;color:#5f6368;font-size:13px">' + r.label + '</td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #f1f3f4;font-weight:600;font-size:14px">' +
        r.value + (r.unit ? ' <span style="font-size:11px;color:#9aa0a6">' + r.unit + '</span>' : "") +
      '</td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #f1f3f4;text-align:right">' + badge + '</td>' +
      '</tr>';
      
    if (r.label === 'Calcium Hardness' && d.tabletLevel) {
       rowHTML += '<tr>' +
         '<td style="padding:8px 12px;border-bottom:1px solid #f1f3f4;color:#5f6368;font-size:13px">Chlorinator Tablet Level</td>' +
         '<td style="padding:8px 12px;border-bottom:1px solid #f1f3f4;font-weight:600;font-size:14px;color:#202124">' + d.tabletLevel + '</td>' +
         '<td style="padding:8px 12px;border-bottom:1px solid #f1f3f4;text-align:right"></td>' +
         '</tr>';
    }
    return rowHTML;
  }).join("");

  const chemRows = d.chemicals.map(c =>
    '<tr>' +
    '<td style="padding:7px 12px;border-bottom:1px solid #f1f3f4;font-size:13px">' + c.name + '</td>' +
    '<td style="padding:7px 12px;border-bottom:1px solid #f1f3f4;font-weight:600;font-size:13px;text-align:right">' +
      c.qty + (c.unit ? ' <span style="font-size:11px;color:#9aa0a6">' + c.unit + '</span>' : '') +
    '</td></tr>'
  ).join("");

  // ── Photo grid ────────────────────────────────────────────────────────────
  // Uses a simple 2-column table for maximum email client compatibility
  let photoSection = "";
  if (hasPhotos) {
    const photoItems = d.photos.map(url =>
      '<td style="padding:4px;width:50%">' +
      '<a href="' + url + '" target="_blank" style="display:block">' +
      '<img src="' + url + '" alt="Pool photo" ' +
      'style="width:100%;max-width:260px;height:180px;object-fit:cover;border-radius:8px;display:block;border:1px solid #e8eaed" />' +
      '</a></td>'
    );

    // Pair photos into rows of 2
    let photoRows = "";
    for (let i = 0; i < photoItems.length; i += 2) {
      const second = photoItems[i + 1] || '<td style="padding:4px;width:50%"></td>';
      photoRows += '<tr>' + photoItems[i] + second + '</tr>';
    }

    photoSection = [
      '<div style="font-size:13px;font-weight:700;color:#202124;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px">📸 Visit Photos</div>',
      '<table style="width:100%;border-collapse:collapse;margin-bottom:24px">',
      '<tbody>' + photoRows + '</tbody>',
      '</table>'
    ].join("");
  }

  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '</head>',
    '<body style="margin:0;padding:0;background:#f8f9fa;font-family:\'Google Sans\',Arial,sans-serif">',

    '<div style="max-width:600px;margin:0 auto;padding:24px 16px">',

    // Header
    '<div style="background:#0d47a1;border-radius:12px 12px 0 0;padding:28px 32px;text-align:center">',
    VISIT_REPORT_LOGO_URL && VISIT_REPORT_LOGO_URL !== "YOUR_LOGO_URL_HERE"
      ? '<img src="' + VISIT_REPORT_LOGO_URL + '" alt="MCPS" style="height:50px;margin-bottom:12px;display:block;margin-left:auto;margin-right:auto" />'
      : '<div style="width:56px;height:56px;background:#fff;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px"><span style="color:#0d47a1;font-size:18px;font-weight:800">MC</span></div>',
    '<div style="color:#fff;font-size:20px;font-weight:700">Mission Custom Pool Solutions</div>',
    '<div style="color:#90caf9;font-size:13px;margin-top:4px">Pool Service Visit Report</div>',
    '</div>',

    // Card
    '<div style="background:#fff;border-radius:0 0 12px 12px;padding:28px 32px;box-shadow:0 2px 8px rgba(0,0,0,.08)">',

    // Greeting
    '<p style="font-size:16px;color:#202124;margin:0 0 6px">Dear ' + (d.clientName || "there") + ',</p>',
    '<p style="font-size:13px;color:#5f6368;margin:0 0 20px">',
    (d.service === "Green-to-Clean Cleaning Service"
      ? 'We were there for your <strong>Green-to-Clean Cleaning Service</strong> on <strong>' + d.dateStr + '</strong> at <strong>' + (d.poolAddress || "your property") + '</strong>.'
      : 'We completed your pool service visit on <strong>' + d.dateStr + '</strong> at <strong>' + (d.poolAddress || "your property") + '</strong>.'),
    ' Here\'s a summary of what was done.',
    '</p>',

    // Visit details row
    '<table style="width:100%;background:#f8f9fa;border-radius:8px;margin-bottom:24px;border-collapse:separate;border-spacing:0"><tr>',
    '<td style="padding:14px 16px;width:50%;vertical-align:top;border-right:1px solid #e8eaed">',
    '<div style="font-size:11px;color:#9aa0a6;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Technician</div>',
    '<div style="font-size:13px;font-weight:600;color:#202124;margin-top:4px">' + (d.technician || "—") + '</div>',
    '</td>',
    '<td style="padding:14px 16px;width:50%;vertical-align:top">',
    '<div style="font-size:11px;color:#9aa0a6;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Date</div>',
    '<div style="font-size:13px;font-weight:600;color:#202124;margin-top:4px">' + d.dateStr + '</div>',
    '</td></tr>',
    '</table>',

    // Water readings
    hasReadings ? [
      '<div style="font-size:13px;font-weight:700;color:#202124;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px">💧 Water Test Results</div>',
      '<table style="width:100%;border-collapse:collapse;margin-bottom:24px">',
      '<thead><tr>',
      '<th style="padding:8px 12px;text-align:left;font-size:11px;color:#9aa0a6;font-weight:600;text-transform:uppercase;border-bottom:2px solid #e8eaed">Parameter</th>',
      '<th style="padding:8px 12px;text-align:left;font-size:11px;color:#9aa0a6;font-weight:600;text-transform:uppercase;border-bottom:2px solid #e8eaed">Reading</th>',
      '<th style="padding:8px 12px;text-align:right;font-size:11px;color:#9aa0a6;font-weight:600;text-transform:uppercase;border-bottom:2px solid #e8eaed">Status</th>',
      '</tr></thead>',
      '<tbody>' + readingRows + '</tbody>',
      '</table>'
    ].join("") : "",

    // Chemicals
    hasChemicals ? [
      '<div style="font-size:13px;font-weight:700;color:#202124;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px">⚗️ Chemicals Applied</div>',
      '<table style="width:100%;border-collapse:collapse;margin-bottom:24px">',
      '<thead><tr>',
      '<th style="padding:8px 12px;text-align:left;font-size:11px;color:#9aa0a6;font-weight:600;text-transform:uppercase;border-bottom:2px solid #e8eaed">Chemical</th>',
      '<th style="padding:8px 12px;text-align:right;font-size:11px;color:#9aa0a6;font-weight:600;text-transform:uppercase;border-bottom:2px solid #e8eaed">Amount</th>',
      '</tr></thead>',
      '<tbody>' + chemRows + '</tbody>',
      '</table>'
    ].join("") : "",

    // Service performed (technician actions + chlorinator adjustment)
    (d.actions || d.chlorinatorAdj) ? [
      '<div style="font-size:13px;font-weight:700;color:#202124;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px">🧰 Service Performed</div>',
      '<table style="width:100%;border-collapse:collapse;margin-bottom:24px"><tbody>',
      (d.actions ? String(d.actions).split(',').map(a => a.trim()).filter(Boolean).map(a =>
        '<tr><td style="padding:7px 12px;border-bottom:1px solid #f1f3f4;font-size:13px;color:#202124">✓ ' + a + '</td></tr>'
      ).join('') : ''),
      (d.chlorinatorAdj ?
        '<tr><td style="padding:7px 12px;border-bottom:1px solid #f1f3f4;font-size:13px;color:#202124">✓ ' +
        d.chlorinatorAdj + ' chlorinator power</td></tr>' : ''),
      '</tbody></table>'
    ].join("") : "",

    // Photos — rendered AFTER chemicals, before notes
    photoSection,

    // Notes
    d.notes ? [
      '<div style="background:#e8f0fe;border-left:4px solid #1a73e8;border-radius:0 8px 8px 0;padding:12px 16px;margin-bottom:24px">',
      '<div style="font-size:11px;font-weight:700;color:#1a73e8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Tech Notes</div>',
      '<div style="font-size:13px;color:#202124">' + d.notes + '</div>',
      '</div>'
    ].join("") : "",

    // Footer message
    '<p style="font-size:13px;color:#5f6368;margin:0 0 24px">',
    'Thank you for trusting Mission Custom Pool Solutions with your pool care. ',
    'If you have any questions about this visit, please don\'t hesitate to reach out.',
    '</p>',

    // Contact
    '<div style="border-top:1px solid #e8eaed;padding-top:20px;text-align:center">',
    '<div style="font-size:13px;font-weight:600;color:#0d47a1">Mission Custom Pool Solutions</div>',
    '<div style="font-size:12px;color:#9aa0a6;margin-top:4px">',
    '📞 ' + VISIT_REPORT_PHONE + ' &nbsp;·&nbsp; 🌐 ' + VISIT_REPORT_WEBSITE,
    '</div></div>',

    '</div></div></body></html>'
  ].join("");
}

// ─── Plain text fallback ────────────────────────────────────────────────────────
function buildEmailText_(d) {
  const lines = [
    "MISSION CUSTOM POOL SOLUTIONS",
    "Pool Service Visit Report",
    "================================", "",
    "Dear " + (d.clientName || "there") + ",", "",
    (d.service === "Green-to-Clean Cleaning Service"
      ? "We were there for your Green-to-Clean Cleaning Service on " + d.dateStr + " at " + (d.poolAddress || "your property") + "."
      : "We completed your pool service on " + d.dateStr + " at " + (d.poolAddress || "your property") + "."),
    "Technician: " + (d.technician || "—"), ""
  ].filter(Boolean);

  if (d.readings.some(r => r.value !== "—")) {
    lines.push("WATER TEST RESULTS", "------------------");
    d.readings.forEach(r => {
      lines.push(r.label + ": " + r.value + (r.unit ? " " + r.unit : "") + (r.status ? " (" + r.status + ")" : ""));
      if (r.label === 'Calcium Hardness' && d.tabletLevel) {
        lines.push("Chlorinator Tablet Level: " + d.tabletLevel);
      }
    });
    lines.push("");
  }

  if (d.chemicals.length) {
    lines.push("CHEMICALS APPLIED", "-----------------");
    d.chemicals.forEach(c => lines.push(c.name + ": " + c.qty + (c.unit ? " " + c.unit : "")));
    lines.push("");
  }

  if (d.actions || d.chlorinatorAdj) {
    lines.push("SERVICE PERFORMED", "-----------------");
    if (d.actions) String(d.actions).split(',').map(a => a.trim()).filter(Boolean)
      .forEach(a => lines.push("- " + a));
    if (d.chlorinatorAdj) lines.push("- " + d.chlorinatorAdj + " chlorinator power");
    lines.push("");
  }

  if (d.notes) {
    lines.push("TECH NOTES", "----------", d.notes, "");
  }

  lines.push(
    "Thank you for trusting us with your pool care.", "",
    "Mission Custom Pool Solutions",
    VISIT_REPORT_PHONE + " | " + VISIT_REPORT_WEBSITE
  );

  return lines.join("\n");
}

// ─── Chemical unit map ──────────────────────────────────────────────────────────
function getChemicalUnitMap_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Chem_Costs");
  if (!sheet) return {};
  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim().toLowerCase());
  const nameCol = headers.indexOf("chemical");
  const unitCol = headers.indexOf("unit_type");
  if (nameCol === -1 || unitCol === -1) return {};
  const map = {};
  for (let i = 1; i < data.length; i++) {
    const name = String(data[i][nameCol] || "").trim();
    const unit = String(data[i][unitCol] || "").trim();
    if (name) map[name] = unit;
  }
  return map;
}
