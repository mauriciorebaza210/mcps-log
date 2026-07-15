// ── Payroll.js — K-1 partner distributions + W-2 owner-employee tracking ──────

var PAYROLL_CONFIG_KEY = 'payroll_config';

function getPayrollConfig_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty(PAYROLL_CONFIG_KEY);
    if (!raw) return { ok: true, w2: null, partners: [] };
    var config = JSON.parse(raw);
    return { ok: true, w2: config.w2 || null, partners: config.partners || [] };
  } catch (e) {
    Logger.log('getPayrollConfig_ error: ' + e);
    return { ok: false, error: String(e) };
  }
}

function savePayrollConfig_(config) {
  try {
    if (!config || typeof config !== 'object') return { ok: false, error: 'Invalid config' };
    var partners = config.partners || [];
    if (!Array.isArray(partners) || partners.length < 1) return { ok: false, error: 'At least one partner required' };
    var w2 = config.w2 || null;
    var w2Pct = w2 ? (parseFloat(w2.pct) || 0) : 0;
    var partnerPct = partners.reduce(function(s, p) { return s + (parseFloat(p.pct) || 0); }, 0);
    var totalPct = w2Pct + partnerPct;
    if (Math.abs(totalPct - 100) > 0.01) return { ok: false, error: 'All ownership percentages must sum to 100 (got ' + totalPct + ')' };
    if (w2 && (isNaN(w2Pct) || w2Pct <= 0)) return { ok: false, error: 'W-2 owner percentage must be a positive number' };
    PropertiesService.getScriptProperties().setProperty(PAYROLL_CONFIG_KEY, JSON.stringify({ w2: w2, partners: partners }));
    return { ok: true };
  } catch (e) {
    Logger.log('savePayrollConfig_ error: ' + e);
    return { ok: false, error: String(e) };
  }
}

function getPayrollLog_(year) {
  try {
    var sheet = ensurePayrollLogSheet_();
    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) return { ok: true, rows: [] };
    var headers = data[0];
    var rows = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var period = String(row[3] || '');
      if (year && !period.startsWith(String(year))) continue;
      rows.push({
        timestamp:  row[0] ? Utilities.formatDate(new Date(row[0]), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') : '',
        type:       String(row[1] || ''),
        person:     String(row[2] || ''),
        period:     period,
        gross:      parseFloat(row[4]) || 0,
        net:        parseFloat(row[5]) || 0,
        note:       String(row[6] || ''),
        logged_by:  String(row[7] || ''),
      });
    }
    // Return newest first
    rows.reverse();
    return { ok: true, rows: rows };
  } catch (e) {
    Logger.log('getPayrollLog_ error: ' + e);
    return { ok: false, error: String(e) };
  }
}

function logPayrollPayment_(type, person, period, grossAmount, netAmount, note, loggedBy) {
  try {
    if (!type || !person || !period) return { ok: false, error: 'type, person, and period are required' };
    var gross = parseFloat(grossAmount) || 0;
    var net   = parseFloat(netAmount)   || gross;
    var sheet = ensurePayrollLogSheet_();
    sheet.appendRow([
      new Date(),
      String(type),
      String(person),
      String(period),
      gross,
      net,
      String(note || ''),
      String(loggedBy || ''),
    ]);
    return { ok: true };
  } catch (e) {
    Logger.log('logPayrollPayment_ error: ' + e);
    return { ok: false, error: String(e) };
  }
}

function ensurePayrollLogSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Payroll_Log');
  if (!sheet) {
    sheet = ss.insertSheet('Payroll_Log');
    sheet.appendRow(['Timestamp', 'Type', 'Person', 'Period', 'Gross Amount', 'Net Amount', 'Note', 'Logged By']);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 8).setFontWeight('bold');
  }
  return sheet;
}

// ── W2 employee payroll: per-employee W4 config + per-submission approvals ─────

var PAYROLL_EMPLOYEES_KEY = 'payroll_employees';

function getPayrollEmployees_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(PAYROLL_EMPLOYEES_KEY);
    if (!raw) return { ok: true, employees: [] };
    var parsed = JSON.parse(raw);
    return { ok: true, employees: Array.isArray(parsed) ? parsed : [] };
  } catch (e) {
    Logger.log('getPayrollEmployees_ error: ' + e);
    return { ok: false, error: String(e) };
  }
}

function parsePayrollNumber_(value) {
  var cleaned = String(value || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return cleaned ? (parseFloat(cleaned[0]) || 0) : 0;
}

function getPayrollOnboardingW4_(username) {
  try {
    var uname = String(username || '').trim();
    if (!uname) return { ok: false, error: 'username is required' };
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Onboarding_Submissions');
    if (!sheet || sheet.getLastRow() < 2) return { ok: true, w4: null };
    var data = sheet.getDataRange().getValues();
    var headers = data[0].map(function (h) { return String(h || '').trim(); });
    var idx = function (name) { return headers.indexOf(name); };
    var uIdx = idx('username');
    if (uIdx === -1) return { ok: true, w4: null };
    for (var i = data.length - 1; i >= 1; i--) {
      if (String(data[i][uIdx] || '').trim() !== uname) continue;
      var dep1 = parsePayrollNumber_(idx('w4_dependents_1') >= 0 ? data[i][idx('w4_dependents_1')] : 0);
      var dep2 = parsePayrollNumber_(idx('w4_dependents_2') >= 0 ? data[i][idx('w4_dependents_2')] : 0);
      var statusRaw = String(idx('w4_filing_status') >= 0 ? data[i][idx('w4_filing_status')] : 'single') || 'single';
      var status = statusRaw === 'married' ? 'mfj' : (statusRaw === 'head' ? 'hoh' : statusRaw);
      return {
        ok: true,
        w4: {
          filing_status:        ['single', 'mfj', 'hoh'].indexOf(status) >= 0 ? status : 'single',
          multiple_jobs:        String(idx('w4_multiple_jobs') >= 0 ? data[i][idx('w4_multiple_jobs')] : '').toUpperCase() === 'TRUE',
          dependents_amt:       dep1 * 2200 + dep2 * 500,
          other_income:         parsePayrollNumber_(idx('w4_other_income') >= 0 ? data[i][idx('w4_other_income')] : 0),
          deductions:           parsePayrollNumber_(idx('w4_deductions') >= 0 ? data[i][idx('w4_deductions')] : 0),
          extra_withholding:    parsePayrollNumber_(idx('w4_extra_withholding') >= 0 ? data[i][idx('w4_extra_withholding')] : 0),
          pay_periods_per_year: 26
        }
      };
    }
    return { ok: true, w4: null };
  } catch (e) {
    Logger.log('getPayrollOnboardingW4_ error: ' + e);
    return { ok: false, error: String(e) };
  }
}

// Count active users in the Users sheet whose display name matches (case/space-insensitive).
function countActiveUsersByName_(name) {
  var target = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!target) return 0;
  var count = 0;
  try {
    var sheet = SpreadsheetApp.openById(AUTH_SHEET_ID).getSheetByName('Users');
    if (!sheet || sheet.getLastRow() < 2) return 0;
    var data = sheet.getDataRange().getValues();
    var hdrs = data[0].map(function (h) { return String(h || '').trim(); });
    var nameIdx = hdrs.indexOf('name');
    var activeIdx = hdrs.indexOf('active');
    if (nameIdx === -1) return 0;
    for (var i = 1; i < data.length; i++) {
      var isActive = activeIdx === -1 || String(data[i][activeIdx]).toUpperCase() === 'TRUE';
      if (!isActive) continue;
      var n = String(data[i][nameIdx] || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (n === target) count++;
    }
  } catch (e) {
    Logger.log('countActiveUsersByName_ error: ' + e);
  }
  return count;
}

function savePayrollEmployee_(emp) {
  try {
    if (!emp || typeof emp !== 'object') return { ok: false, error: 'Invalid employee' };
    var username = String(emp.username || '').trim();
    var name = String(emp.name || '').trim();
    if (!username) return { ok: false, error: 'Employee username is required' };
    if (!name) return { ok: false, error: 'Employee name is required' };

    // Fix 2 guard: a display name shared by 2+ active users can't be matched unambiguously
    // against Job_Completions (which stores only the display name).
    if (countActiveUsersByName_(name) > 1) {
      return { ok: false, error: 'Display name "' + name + '" is shared by multiple active users. ' +
                                 'Rename one before tracking payroll for this employee.' };
    }

    var w4in = emp.w4 || {};
    var w4 = {
      filing_status:        ['single', 'mfj', 'hoh'].indexOf(String(w4in.filing_status || 'single')) >= 0
                              ? String(w4in.filing_status) : 'single',
      multiple_jobs:        !!w4in.multiple_jobs,
      dependents_amt:       parsePayrollNumber_(w4in.dependents_amt),
      other_income:         parsePayrollNumber_(w4in.other_income),
      deductions:           parsePayrollNumber_(w4in.deductions),
      extra_withholding:    parsePayrollNumber_(w4in.extra_withholding),
      pay_periods_per_year: parseInt(w4in.pay_periods_per_year, 10) || 26
    };
    // pay_anchor: the Thursday that starts the first counted weekly (Thu–Wed) pay period.
    var payAnchor = String(emp.pay_anchor || '').trim();
    if (payAnchor && !/^\d{4}-\d{2}-\d{2}$/.test(payAnchor)) payAnchor = '';
    var method = emp.withholding_method === 'cumulative' ? 'cumulative' : 'standard';
    var record = { username: username, name: name, pay_rate: parsePayrollNumber_(emp.pay_rate),
                   pay_anchor: payAnchor, withholding_method: method, w4: w4 };

    var list = getPayrollEmployees_().employees || [];
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].username || '') === username) { idx = i; break; }
    }
    if (idx >= 0) list[idx] = record; else list.push(record);

    PropertiesService.getScriptProperties().setProperty(PAYROLL_EMPLOYEES_KEY, JSON.stringify(list));
    return { ok: true, employees: list };
  } catch (e) {
    Logger.log('savePayrollEmployee_ error: ' + e);
    return { ok: false, error: String(e) };
  }
}

function ensurePayrollApprovalsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Payroll_Approvals');
  if (!sheet) {
    sheet = ss.insertSheet('Payroll_Approvals');
    sheet.appendRow(['Payroll UID', 'Username', 'Pool ID', 'Visit Date', 'Approved', 'Approved By', 'Approved At']);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 7).setFontWeight('bold');
  }
  return sheet;
}

function getPayrollApprovals_(username) {
  try {
    var sheet = ensurePayrollApprovalsSheet_();
    var approved = {};
    if (sheet.getLastRow() < 2) return { ok: true, approved: approved };
    var data = sheet.getDataRange().getValues();
    var filterUser = String(username || '').trim();
    for (var i = 1; i < data.length; i++) {
      var uid = String(data[i][0] || '');
      if (!uid) continue;
      if (filterUser && String(data[i][1] || '') !== filterUser) continue;
      if (String(data[i][4]).toUpperCase() === 'TRUE') approved[uid] = true;
    }
    return { ok: true, approved: approved };
  } catch (e) {
    Logger.log('getPayrollApprovals_ error: ' + e);
    return { ok: false, error: String(e) };
  }
}

function setPayrollApproval_(payrollUid, meta, approved, by) {
  try {
    var uid = String(payrollUid || '').trim();
    if (!uid) return { ok: false, error: 'payroll_uid is required' };
    meta = meta || {};
    var sheet = ensurePayrollApprovalsSheet_();
    var lastRow = sheet.getLastRow();
    var foundRow = -1;
    if (lastRow >= 2) {
      var keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < keys.length; i++) {
        if (String(keys[i][0] || '') === uid) { foundRow = i + 2; break; }
      }
    }
    var rowValues = [
      uid,
      String(meta.username || ''),
      String(meta.pool_id || ''),
      String(meta.visit_date || ''),
      approved ? 'TRUE' : 'FALSE',
      String(by || ''),
      new Date().toISOString()
    ];
    if (foundRow >= 0) {
      sheet.getRange(foundRow, 1, 1, rowValues.length).setValues([rowValues]);
    } else {
      sheet.appendRow(rowValues);
    }
    return { ok: true };
  } catch (e) {
    Logger.log('setPayrollApproval_ error: ' + e);
    return { ok: false, error: String(e) };
  }
}

// ── Employee completions feed + submission detail (read by the Payroll tab) ────

var ROUTES_SS_ID_PAYROLL = '1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM';

// Resolve a username → its display name(s) from the Users sheet (active-user aware).
function resolveUsernameToNames_(username) {
  var uname = String(username || '').trim().toLowerCase();
  var names = [];
  if (!uname) return names;
  try {
    var sheet = SpreadsheetApp.openById(AUTH_SHEET_ID).getSheetByName('Users');
    if (!sheet || sheet.getLastRow() < 2) return names;
    var data = sheet.getDataRange().getValues();
    var hdrs = data[0].map(function (h) { return String(h || '').trim(); });
    var uIdx = hdrs.indexOf('username');
    var nIdx = hdrs.indexOf('name');
    if (uIdx === -1 || nIdx === -1) return names;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][uIdx] || '').trim().toLowerCase() === uname) {
        var n = String(data[i][nIdx] || '').trim();
        if (n && names.indexOf(n) === -1) names.push(n);
      }
    }
  } catch (e) {
    Logger.log('resolveUsernameToNames_ error: ' + e);
  }
  return names;
}

// Returns Job_Completions rows for one employee within [start, end] (yyyy-MM-dd inclusive).
// Normalize a cell that may be a Date object or a string into yyyy-MM-dd (or '').
function payrollToYmd_(v) {
  if (v instanceof Date) return isNaN(v) ? '' : Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var s = String(v || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10); // already ISO-ish
  var d = new Date(s);
  return isNaN(d) ? '' : Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function getEmployeeCompletions_(username, start, end) {
  try {
    var names = resolveUsernameToNames_(username);
    if (!names.length) return { ok: true, rows: [] };
    var nameSet = {};
    names.forEach(function (n) { nameSet[n.toLowerCase().replace(/\s+/g, ' ')] = true; });

    var startMs = start ? new Date(start + 'T00:00:00').getTime() : -Infinity;
    var endMs = end ? new Date(end + 'T23:59:59').getTime() : Infinity;

    var jcSheet = SpreadsheetApp.openById(ROUTES_SS_ID_PAYROLL).getSheetByName('Job_Completions');
    if (!jcSheet || jcSheet.getLastRow() < 2) return { ok: true, rows: [] };
    var data = jcSheet.getDataRange().getValues();
    var hdrs = data[0].map(function (h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); });
    var iUid = hdrs.indexOf('payroll_uid');
    var iPool = hdrs.indexOf('pool_id');
    var iTech = hdrs.indexOf('technician');
    var iDate = hdrs.indexOf('date');
    var iComp = hdrs.indexOf('completed_at');
    var iLogRow = hdrs.indexOf('service_log_row');

    // Many older Job_Completions rows have a blank `technician`. Recover the name from the
    // Chemical_Usage_Log row each completion points at (service_log_row → Technician column).
    var chemTechByRow = {};
    try {
      var chem = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Chemical_Usage_Log');
      if (chem && chem.getLastRow() >= 2) {
        var cData = chem.getDataRange().getValues();
        var cTechIdx = cData[0].map(function (h) { return String(h || '').trim(); }).indexOf('Technician');
        if (cTechIdx >= 0) {
          for (var ci = 1; ci < cData.length; ci++) {
            var ct = String(cData[ci][cTechIdx] || '').trim();
            if (ct) chemTechByRow[ci + 1] = ct; // ci is 0-based incl. header → sheet row number = ci+1
          }
        }
      }
    } catch (che) { Logger.log('getEmployeeCompletions_ chemTech: ' + che); }

    // Build pool_id → client name/address map from CRM Quotes.
    var clientMap = {};
    try {
      var qSheet = SpreadsheetApp.openById('1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E').getSheetByName('Quotes');
      if (qSheet && qSheet.getLastRow() >= 2) {
        var q = qSheet.getDataRange().getValues();
        var qH = q[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
        var qPid = qH.indexOf('pool_id'), qFn = qH.indexOf('first_name'), qLn = qH.indexOf('last_name'), qAddr = qH.indexOf('address');
        if (qPid !== -1) {
          for (var r = 1; r < q.length; r++) {
            var cpid = String(q[r][qPid] || '').trim();
            if (cpid && !clientMap[cpid]) {
              clientMap[cpid] = {
                name: ((qFn >= 0 ? String(q[r][qFn] || '') : '') + ' ' + (qLn >= 0 ? String(q[r][qLn] || '') : '')).trim(),
                address: qAddr >= 0 ? String(q[r][qAddr] || '').trim() : ''
              };
            }
          }
        }
      }
    } catch (ce) { Logger.log('getEmployeeCompletions_ clientMap: ' + ce); }

    var rows = [];
    for (var i = 1; i < data.length; i++) {
      var slr = iLogRow >= 0 ? (parseInt(data[i][iLogRow], 10) || 0) : 0;
      // Effective technician: Job_Completions value, else recovered from the chem log row.
      var effTech = String(data[i][iTech] || '').trim() || (slr ? (chemTechByRow[slr] || '') : '');
      if (!nameSet[effTech.toLowerCase().replace(/\s+/g, ' ')]) continue;

      var dateStr = payrollToYmd_(iDate >= 0 ? data[i][iDate] : '');
      if (!dateStr && iComp >= 0) dateStr = payrollToYmd_(data[i][iComp]);
      var dms = dateStr ? new Date(dateStr + 'T12:00:00').getTime() : NaN;
      if (isNaN(dms) || dms < startMs || dms > endMs) continue;

      var poolId = iPool >= 0 ? String(data[i][iPool] || '') : '';
      var client = clientMap[poolId] || {};
      rows.push({
        payroll_uid:         iUid >= 0 ? String(data[i][iUid] || '') : '',
        pool_id:             poolId,
        technician:          effTech,
        technician_username: username,
        date:                dateStr,
        service_log_row:     slr || '',
        client_name:         client.name || '',
        client_address:      client.address || ''
      });
    }
    // Merge manual pool entries (missed-form fallback) for the same window.
    var manual = getManualPoolRows_(username, startMs, endMs, clientMap);
    for (var m = 0; m < manual.length; m++) rows.push(manual[m]);

    rows.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    return { ok: true, rows: rows };
  } catch (e) {
    Logger.log('getEmployeeCompletions_ error: ' + e);
    return { ok: false, error: String(e) };
  }
}

// Resolve + validate a submission's detail by payroll_uid (never trust a client row number).
function getSubmissionDetail_(payrollUid) {
  try {
    var uid = String(payrollUid || '').trim();
    if (!uid) return { ok: false, error: 'payroll_uid is required' };

    var jcSheet = SpreadsheetApp.openById(ROUTES_SS_ID_PAYROLL).getSheetByName('Job_Completions');
    if (!jcSheet || jcSheet.getLastRow() < 2) return { ok: true, detail: null };
    var jc = jcSheet.getDataRange().getValues();
    var jh = jc[0].map(function (h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); });
    var jUid = jh.indexOf('payroll_uid'), jPool = jh.indexOf('pool_id'), jDate = jh.indexOf('date'), jLog = jh.indexOf('service_log_row');
    var expectPool = '', expectDate = '', logRow = 0;
    for (var i = 1; i < jc.length; i++) {
      if (jUid >= 0 && String(jc[i][jUid] || '') === uid) {
        expectPool = jPool >= 0 ? String(jc[i][jPool] || '').trim() : '';
        expectDate = jDate >= 0 ? payrollToYmd_(jc[i][jDate]) : '';
        logRow = jLog >= 0 ? parseInt(jc[i][jLog], 10) || 0 : 0;
        break;
      }
    }
    if (!expectPool) return { ok: true, detail: null };

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var logSheet = ss.getSheetByName('Chemical_Usage_Log');
    if (!logSheet || logSheet.getLastRow() < 2) return { ok: true, detail: null };
    var lh = logSheet.getRange(1, 1, 1, logSheet.getLastColumn()).getValues()[0].map(function (h) { return String(h || '').trim(); });
    var lPoolIdx = lh.indexOf('pool_id');

    // Chem log pool_id may hold a verbose dropdown label ("MCPS-0007 — Dave Libby"); reduce
    // both sides to the bare "MCPS-####" token before comparing.
    var normPool = function (v) {
      v = String(v || '').trim();
      var m = v.match(/MCPS-\d+/i);
      return (m ? m[0] : v).toUpperCase();
    };
    var wantPool = normPool(expectPool);

    // Test-key lookup for the frontend dosing comparison (mirrors FormUI labels).
    var testKey = { 'Free Chlorine (FC)': 'fc', 'pH': 'ph', 'Total Alkalinity (TA)': 'ta',
                    'Calcium Hardness (CH)': 'ch', 'Cyanuric Acid (CYA)': 'cya', 'Salt Level': 'salt' };
    var unitMap = {};
    try { unitMap = getChemicalUnitMap_(); } catch (ue) {}

    // Build a categorized detail object: timestamp, tests (in WATER_RANGES order),
    // chemicals used, notes, photos, and pool info (size/material/tablet → gallons est.).
    var buildDetail = function (rowVals) {
      var get = function (name) {
        var i = lh.indexOf(name);
        var v = (i >= 0) ? rowVals[i] : '';
        return String(v !== undefined && v !== null ? v : '').trim();
      };

      var tests = [];
      Object.keys(WATER_RANGES).forEach(function (label) {
        var raw = get(label);
        var val = parseFloat(raw);
        var range = WATER_RANGES[label];
        if (range.optional && !isFinite(val)) return; // untested optional readings hidden
        if (raw === '' && !isFinite(val)) return;
        var target = (range.max === Infinity) ? ('≥ ' + range.min) : (range.min + '–' + range.max);
        var ok = isFinite(val) && val >= range.min && val <= range.max;
        tests.push({
          key: testKey[label] || '', label: label,
          value: isFinite(val) ? String(val) : raw,
          unit: range.unit || '', target: target,
          status: isFinite(val) ? (ok ? 'In range' : 'Monitor') : '', ok: ok
        });
      });

      var chemicals = [];
      for (var c = 0; c < lh.length; c++) {
        var h = lh[c];
        if (h === '_chemical_fields') continue;
        if (!h || VR_NON_CHEM.has(h) || h.indexOf(' Unit Cost (Snapshot)') >= 0) continue;
        var qty = parseFloat(rowVals[c]);
        if (isFinite(qty) && qty > 0) {
          chemicals.push({ name: h, qty: qty, unit: unitMap[h] || VR_UNIT_FALLBACK[h] || '' });
        }
      }

      var photos = [];
      try { photos = JSON.parse(get('_photo_urls') || '[]'); } catch (pe) { photos = []; }
      if (!Array.isArray(photos)) photos = [];

      var notes = get('Notes').replace(/\s*\[condition:[^\]]*\]\s*/ig, ' ').replace(/\s{2,}/g, ' ').trim();

      var sizeRaw = get('Pool Size').toLowerCase();
      var gallons = sizeRaw.indexOf('large') >= 0 ? 22500 : (sizeRaw.indexOf('medium') >= 0 ? 17500 : 12000);

      return {
        timestamp:     get('Timestamp'),
        tests:         tests,
        chemicals:     chemicals,
        notes:         notes,
        photos:        photos,
        pool_size:     get('Pool Size'),
        pool_material: get('Pool Material'),
        tablet_level:  get('Tablet Level'),
        gallons:       gallons
      };
    };

    // 1) Try the captured row pointer, validate pool_id matches.
    if (logRow >= 2 && logRow <= logSheet.getLastRow()) {
      var rowVals = logSheet.getRange(logRow, 1, 1, logSheet.getLastColumn()).getDisplayValues()[0];
      if (lPoolIdx === -1 || normPool(rowVals[lPoolIdx]) === wantPool) {
        return { ok: true, detail: buildDetail(rowVals), pool_id: expectPool, date: expectDate };
      }
    }

    // 2) Pointer drifted/voided → fall back to pool_id (+ date when it disambiguates).
    var all = logSheet.getDataRange().getDisplayValues();
    var lTsIdx = lh.indexOf('Timestamp');
    var poolMatch = null; // most-recent row for the pool, as a fallback if no date lines up
    for (var k = all.length - 1; k >= 1; k--) {
      if (lPoolIdx >= 0 && normPool(all[k][lPoolIdx]) !== wantPool) continue;
      if (!poolMatch) poolMatch = all[k];
      if (expectDate && lTsIdx >= 0) {
        var ts = String(all[k][lTsIdx] || '');
        var tsDay = (new Date(ts + '').toString() !== 'Invalid Date')
          ? Utilities.formatDate(new Date(ts), Session.getScriptTimeZone(), 'yyyy-MM-dd')
          : ts.slice(0, 10);
        if (tsDay !== expectDate) continue;
      }
      return { ok: true, detail: buildDetail(all[k]), pool_id: expectPool, date: expectDate };
    }
    // No exact date match but the pool exists → return the most-recent visit for that pool.
    if (poolMatch) return { ok: true, detail: buildDetail(poolMatch), pool_id: expectPool, date: expectDate };
    return { ok: true, detail: null };
  } catch (e) {
    Logger.log('getSubmissionDetail_ error: ' + e);
    return { ok: false, error: String(e) };
  }
}

// One-time, idempotent backfill: fills payroll_uid only where blank; never overwrites.
// Also creates the column header. Run once after deploy to pre-warm the schema.
function backfillPayrollUids_() {
  var jcSheet = SpreadsheetApp.openById(ROUTES_SS_ID_PAYROLL).getSheetByName('Job_Completions');
  if (!jcSheet) return { ok: false, error: 'Job_Completions sheet not found' };
  var lastCol = jcSheet.getLastColumn();
  var headers = jcSheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var uidCol = headers.indexOf('payroll_uid');
  if (uidCol === -1) {
    jcSheet.getRange(1, lastCol + 1).setValue('payroll_uid');
    uidCol = lastCol; // 0-based index of the new column
    lastCol = lastCol + 1;
  }
  var lastRow = jcSheet.getLastRow();
  if (lastRow < 2) return { ok: true, filled: 0 };
  var range = jcSheet.getRange(2, uidCol + 1, lastRow - 1, 1);
  var vals = range.getValues();
  var filled = 0;
  for (var i = 0; i < vals.length; i++) {
    if (!String(vals[i][0] || '').trim()) { vals[i][0] = Utilities.getUuid(); filled++; }
  }
  if (filled) range.setValues(vals);
  Logger.log('backfillPayrollUids_: filled ' + filled + ' of ' + vals.length + ' rows');
  return { ok: true, filled: filled };
}

// ── Manual pool entries (missed-form fallback) ────────────────────────────────
// Stored separately from Job_Completions so they never affect routes/scheduling/analytics.
// Merged into the employee completions feed and approvable via the normal payroll_uid path.

function ensureManualPoolSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Manual_Pool_Entries');
  if (!sheet) {
    sheet = ss.insertSheet('Manual_Pool_Entries');
    sheet.appendRow(['Payroll UID', 'Username', 'Pool ID', 'Date', 'Note', 'Created By', 'Created At']);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 7).setFontWeight('bold');
  }
  return sheet;
}

function addManualPool_(username, poolId, date, note, by) {
  try {
    var uname = String(username || '').trim();
    var pid   = String(poolId || '').trim();
    var dt    = payrollToYmd_(date);
    if (!uname) return { ok: false, error: 'username is required' };
    if (!pid)   return { ok: false, error: 'pool is required' };
    if (!dt)    return { ok: false, error: 'a valid date is required' };
    var sheet = ensureManualPoolSheet_();
    var uid = Utilities.getUuid();
    sheet.appendRow([uid, uname, pid, dt, String(note || ''), String(by || ''), new Date().toISOString()]);
    return { ok: true, payroll_uid: uid };
  } catch (e) {
    Logger.log('addManualPool_ error: ' + e);
    return { ok: false, error: String(e) };
  }
}

// Returns manual entries for a username within [startMs, endMs], shaped like completion rows.
function getManualPoolRows_(username, startMs, endMs, clientMap) {
  var out = [];
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Manual_Pool_Entries');
    if (!sheet || sheet.getLastRow() < 2) return out;
    var uname = String(username || '').trim().toLowerCase();
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1] || '').trim().toLowerCase() !== uname) continue;
      var dt = payrollToYmd_(data[i][3]);
      var dms = dt ? new Date(dt + 'T12:00:00').getTime() : NaN;
      if (isNaN(dms) || dms < startMs || dms > endMs) continue;
      var poolId = String(data[i][2] || '');
      var client = (clientMap && clientMap[poolId]) || {};
      out.push({
        payroll_uid:         String(data[i][0] || ''),
        pool_id:             poolId,
        technician:          '',
        technician_username: username,
        date:                dt,
        service_log_row:     '',
        client_name:         client.name || '',
        client_address:      client.address || '',
        manual:              true,
        note:                String(data[i][4] || '')
      });
    }
  } catch (e) {
    Logger.log('getManualPoolRows_ error: ' + e);
  }
  return out;
}

// ── Employee paycheck records (history) ───────────────────────────────────────

// Canonical column order for Employee_Paychecks. New columns are appended to the
// right; reads/writes go through a header map (see headerMap_) so positional drift
// can't corrupt data once columns are added to an existing sheet.
var EMP_PAYCHECK_HEADERS = [
  'Paycheck ID', 'Username', 'Name', 'Period Start', 'Period End', 'Verified Date',
  'Pay Date', 'Pool Count', 'Gross', 'Federal', 'SS', 'Medicare', 'Net',
  'Pool UIDs', 'Note', 'Logged By', 'Logged At',
  'ER_SS', 'ER_Medicare', 'FUTA', 'SUTA',
  'QBO_JE_ID', 'QBO_Status', 'QBO_Synced_At', 'QBO_Doc_Number', 'QBO_Error'
];

// Build { headerName: zeroBasedColumnIndex } from a sheet's first row.
function headerMap_(sheet) {
  var lastCol = Math.max(1, sheet.getLastColumn());
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  for (var c = 0; c < headers.length; c++) map[String(headers[c]).trim()] = c;
  return map;
}

function ensureEmployeePaychecksSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Employee_Paychecks');
  if (!sheet) {
    sheet = ss.insertSheet('Employee_Paychecks');
    sheet.appendRow(EMP_PAYCHECK_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, EMP_PAYCHECK_HEADERS.length).setFontWeight('bold');
    return sheet;
  }
  // Existing sheet: append any headers it's missing (no data loss, preserves order).
  var map = headerMap_(sheet);
  var missing = EMP_PAYCHECK_HEADERS.filter(function (h) { return map[h] === undefined; });
  if (missing.length) {
    var startCol = sheet.getLastColumn() + 1;
    sheet.getRange(1, startCol, 1, missing.length).setValues([missing]).setFontWeight('bold');
  }
  return sheet;
}

function saveEmployeePaycheck_(rec, by) {
  try {
    rec = rec || {};
    var username = String(rec.username || '').trim();
    var periodStart = payrollToYmd_(rec.period_start);
    var periodEnd   = payrollToYmd_(rec.period_end);
    if (!username)    return { ok: false, error: 'username is required' };
    if (!periodStart) return { ok: false, error: 'period start is required' };
    var poolUids = Array.isArray(rec.pool_uids) ? rec.pool_uids.join(',') : String(rec.pool_uids || '');
    var sheet = ensureEmployeePaychecksSheet_();
    var map = headerMap_(sheet);

    // Reject duplicates for the same employee + pay period (double-clicks, retries, second tab).
    if (sheet.getLastRow() >= 2) {
      var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
      for (var x = 0; x < data.length; x++) {
        if (String(data[x][map['Username']] || '').trim() === username &&
            payrollToYmd_(data[x][map['Period Start']]) === periodStart) {
          return { ok: false, error: 'A paycheck for this pay period is already recorded.' };
        }
      }
    }

    var paycheckId = Utilities.getUuid();
    var row = new Array(sheet.getLastColumn()).fill('');
    var set = function (header, val) { if (map[header] !== undefined) row[map[header]] = val; };
    set('Paycheck ID',   paycheckId);
    set('Username',      username);
    set('Name',          String(rec.name || ''));
    set('Period Start',  periodStart);
    set('Period End',    periodEnd);
    set('Verified Date', payrollToYmd_(rec.verified_date));
    set('Pay Date',      payrollToYmd_(rec.pay_date));
    set('Pool Count',    parseInt(rec.pool_count, 10) || 0);
    set('Gross',         parsePayrollNumber_(rec.gross));
    set('Federal',       parsePayrollNumber_(rec.fed));
    set('SS',            parsePayrollNumber_(rec.ss));
    set('Medicare',      parsePayrollNumber_(rec.med));
    set('Net',           parsePayrollNumber_(rec.net));
    set('Pool UIDs',     poolUids);
    set('Note',          String(rec.note || ''));
    set('Logged By',     String(by || ''));
    set('Logged At',     new Date().toISOString());
    set('ER_SS',         parsePayrollNumber_(rec.er_ss));
    set('ER_Medicare',   parsePayrollNumber_(rec.er_med));
    set('FUTA',          parsePayrollNumber_(rec.futa));
    set('SUTA',          parsePayrollNumber_(rec.suta));
    sheet.appendRow(row);
    return { ok: true, paycheck_id: paycheckId };
  } catch (e) {
    Logger.log('saveEmployeePaycheck_ error: ' + e);
    return { ok: false, error: String(e) };
  }
}

function getEmployeePaychecks_(username) {
  try {
    var sheet = ensureEmployeePaychecksSheet_();
    if (sheet.getLastRow() < 2) return { ok: true, paychecks: [] };
    var uname = String(username || '').trim().toLowerCase();
    var map = headerMap_(sheet);
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
    var out = [];
    var get = function (r, h) { return map[h] !== undefined ? r[map[h]] : ''; };
    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      if (uname && String(get(r, 'Username') || '').trim().toLowerCase() !== uname) continue;
      out.push({
        paycheck_id:    String(get(r, 'Paycheck ID') || ''),
        username:       String(get(r, 'Username') || ''),
        name:           String(get(r, 'Name') || ''),
        period_start:   payrollToYmd_(get(r, 'Period Start')),
        period_end:     payrollToYmd_(get(r, 'Period End')),
        verified_date:  payrollToYmd_(get(r, 'Verified Date')),
        pay_date:       payrollToYmd_(get(r, 'Pay Date')),
        pool_count:     parseInt(get(r, 'Pool Count'), 10) || 0,
        gross:          parsePayrollNumber_(get(r, 'Gross')),
        fed:            parsePayrollNumber_(get(r, 'Federal')),
        ss:             parsePayrollNumber_(get(r, 'SS')),
        med:            parsePayrollNumber_(get(r, 'Medicare')),
        net:            parsePayrollNumber_(get(r, 'Net')),
        pool_uids:      String(get(r, 'Pool UIDs') || ''),
        note:           String(get(r, 'Note') || ''),
        logged_by:      String(get(r, 'Logged By') || ''),
        logged_at:      String(get(r, 'Logged At') || ''),
        er_ss:          parsePayrollNumber_(get(r, 'ER_SS')),
        er_med:         parsePayrollNumber_(get(r, 'ER_Medicare')),
        futa:           parsePayrollNumber_(get(r, 'FUTA')),
        suta:           parsePayrollNumber_(get(r, 'SUTA')),
        qbo_je_id:      String(get(r, 'QBO_JE_ID') || ''),
        qbo_status:     String(get(r, 'QBO_Status') || ''),
        qbo_doc_number: String(get(r, 'QBO_Doc_Number') || ''),
        qbo_error:      String(get(r, 'QBO_Error') || '')
      });
    }
    out.reverse(); // newest first
    return { ok: true, paychecks: out };
  } catch (e) {
    Logger.log('getEmployeePaychecks_ error: ' + e);
    return { ok: false, error: String(e) };
  }
}

// Stamp QuickBooks sync result onto a paycheck row, matched by paycheck_id.
// fields: { je_id, status, doc_number, error }. Status 'synced' clears any prior error.
function setPaycheckQboRef_(paycheckId, fields) {
  try {
    paycheckId = String(paycheckId || '').trim();
    if (!paycheckId) return { ok: false, error: 'paycheck_id is required' };
    fields = fields || {};
    var sheet = ensureEmployeePaychecksSheet_();
    if (sheet.getLastRow() < 2) return { ok: false, error: 'paycheck not found' };
    var map = headerMap_(sheet);
    var idCol = map['Paycheck ID'];
    var ids = sheet.getRange(2, idCol + 1, sheet.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0] || '').trim() !== paycheckId) continue;
      var rowNum = i + 2;
      var status = String(fields.status || '').trim();
      var write = function (header, val) {
        if (map[header] !== undefined) sheet.getRange(rowNum, map[header] + 1).setValue(val);
      };
      if (fields.je_id !== undefined)      write('QBO_JE_ID', String(fields.je_id || ''));
      if (status)                          write('QBO_Status', status);
      if (fields.doc_number !== undefined) write('QBO_Doc_Number', String(fields.doc_number || ''));
      write('QBO_Synced_At', new Date().toISOString());
      // On success clear the error; otherwise record the (already-sanitized) message.
      write('QBO_Error', status === 'synced' ? '' : String(fields.error || ''));
      return { ok: true };
    }
    return { ok: false, error: 'paycheck not found' };
  } catch (e) {
    Logger.log('setPaycheckQboRef_ error: ' + e);
    return { ok: false, error: String(e) };
  }
}
