// 01_utils.gs

function norm_(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function getHeaderMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return { headers: [], map: {} };

  const raw = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const headers = raw.map(h => norm_(h));
  const map = {};
  headers.forEach((h, i) => { if (h) map[h] = i + 1; });
  return { headers, map };
}

function setByHeader_(sheet, headerMap, row, key, value) {
  const col = headerMap.map[norm_(key)];
  if (!col) {
    // Column missing from sheet — likely a schema drift issue (see SCHEMA in 00_config.gs)
    logDebug_("WARN", "setByHeader_: column not found", { key, row });
    return;
  }
  sheet.getRange(row, col).setValue(value);
}

function getByHeader_(rowData, headers, key) {
  const idx = headers.indexOf(norm_(key));
  if (idx === -1) return "";
  return rowData[idx] ?? "";
}

function logDebug_(level, msg, meta) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = getOrCreateSheet_(ss, CFG.SHEETS.DEBUG);
    sh.appendRow([new Date(), level, msg, meta ? JSON.stringify(meta) : ""]);
  } catch (e) {
    // Last-resort fallback so a logging failure never swallows a real error
    console.error("logDebug_ failed:", e);
  }
}

function buildRowFromPayload_(payload, headers, overrides) {
  const row = new Array(headers.length).fill("");

  const normalizeValue_ = (v) => {
    if (v === null || v === undefined) return "";
    if (Array.isArray(v)) return v.join(", ");
    if (typeof v === "object") return JSON.stringify(v);
    return v;
  };

  const put = (k, v) => {
    const idx = headers.indexOf(norm_(k));
    if (idx !== -1) row[idx] = normalizeValue_(v);
  };

  Object.keys(payload || {}).forEach(k => {
    const nk = norm_(k);
    if (nk === "quote_id" || nk === "timestamp") return;
    put(k, payload[k]);
  });

  Object.keys(overrides || {}).forEach(k => put(k, overrides[k]));
  return row;
}

function nextQuoteId_(ss) {
  // Lock prevents two simultaneous webhook posts from generating the same quote_id
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const trySheets = [CFG.SHEETS.LOG, CFG.SHEETS.CRM];
    let maxN = 0;

    for (const name of trySheets) {
      const sh = ss.getSheetByName(name);
      if (!sh) continue;

      const lastRow = sh.getLastRow();
      if (lastRow < 2) continue;

      const hm = getHeaderMap_(sh);
      const qCol = hm.map["quote_id"];
      if (!qCol) continue;

      const values = sh.getRange(2, qCol, lastRow - 1, 1).getValues().flat();
      for (const v of values) {
        const m = String(v || "").match(/^quote(\d+)$/i);
        if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
      }
    }

    return "quote" + String(maxN + 1).padStart(4, "0");
  } finally {
    lock.releaseLock();
  }
}
