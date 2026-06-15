// WebhookReceiver.gs
// Receives POST requests from Zapier with QBO bill line items
// and writes them to Purchase_Log in Inventory Master.
// Add this at the top of your script


const WEBHOOK_SECRET = "220ed543794285b632c27dec0b1b6529"; // change this to anything you want
// 1. Configuration for the sheet name
const CFG = {
  SHEETS: {
    SIGNED: "Signed_Customers"
  }
};

// 2. The sync function updated with your Spreadsheet ID
function updateVisitLogDropdownFromSignedCustomers_() {
  // We use openById because this script project is not "bound" to the sheet
  const ss = SpreadsheetApp.openById("1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E");
  const optionsSet = new Set();

  const buildOption_ = (row, pidCol, lnCol, svcCol, addrCol) => {
    const poolId   = String(row[pidCol]  || "").trim();
    const lastName = String(row[lnCol]   || "").trim();
    const service  = String(row[svcCol]  || "").trim();
    const address  = String(row[addrCol] || "").trim();
    if (!poolId) return null;
    return `${lastName} - ${service} - ${address} - ${poolId}`;
  };

  // Source 1: Signed_Customers (existing signed contracts)
  const signedSheet = ss.getSheetByName(CFG.SHEETS.SIGNED);
  if (signedSheet && signedSheet.getLastRow() >= 2) {
    const headers = signedSheet.getRange(1, 1, 1, signedSheet.getLastColumn()).getValues()[0]
      .map(h => String(h || "").trim().toLowerCase());
    const pidCol = headers.indexOf("pool_id");
    const lnCol  = headers.indexOf("last_name");
    const svcCol = headers.indexOf("service");
    const addrCol = headers.indexOf("address");
    if (pidCol !== -1 && lnCol !== -1) {
      const data = signedSheet.getRange(2, 1, signedSheet.getLastRow() - 1, signedSheet.getLastColumn()).getValues();
      data.forEach(row => {
        const opt = buildOption_(row, pidCol, lnCol, svcCol, addrCol);
        if (opt) optionsSet.add(opt);
      });
    }
  }

  // Source 2: Quotes sheet — ACTIVE_CUSTOMER status (startup transfers and
  // customers activated directly from the CRM without a Signed_Customers row)
  const quotesSheet = ss.getSheetByName("Quotes");
  if (quotesSheet && quotesSheet.getLastRow() >= 2) {
    const headers = quotesSheet.getRange(1, 1, 1, quotesSheet.getLastColumn()).getValues()[0]
      .map(h => String(h || "").trim().toLowerCase());
    const pidCol    = headers.indexOf("pool_id");
    const statusCol = headers.indexOf("status");
    const lnCol     = headers.indexOf("last_name");
    const svcCol    = headers.indexOf("service");
    const addrCol   = headers.indexOf("address");
    if (pidCol !== -1 && statusCol !== -1) {
      const data = quotesSheet.getRange(2, 1, quotesSheet.getLastRow() - 1, quotesSheet.getLastColumn()).getValues();
      data.forEach(row => {
        const status = String(row[statusCol] || "").trim().toUpperCase();
        if (status !== "ACTIVE_CUSTOMER") return;
        const opt = buildOption_(row, pidCol, lnCol, svcCol, addrCol);
        if (opt) optionsSet.add(opt);
      });
    }
  }

  const uniqueOptions = [...optionsSet].sort((a, b) => a.localeCompare(b));
  const OTHER_OPTION = "Other / Pool not listed";
  if (!uniqueOptions.includes(OTHER_OPTION)) uniqueOptions.push(OTHER_OPTION);

  // Write choices directly to Portal_Schema sheet
  updatePoolDropdownInSchema(uniqueOptions);
}

// WebhookReceiver.gs  — doPost AUTH ROUTES TO ADD
// ─────────────────────────────────────────────────────────────────────────────
// Add these routes inside your existing doPost(), right after the secret check
// and BEFORE the get_metadata / submit_form blocks.
//
// Replace your current secret-check block with the version below so that
// the login action is allowed through WITHOUT a token (it doesn't have one yet).
// ─────────────────────────────────────────────────────────────────────────────

function handleValidateToken_(token) {
  const ss = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet = ss.getSheetByName('Sessions');
  if (!sheet) return { ok: false };
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === token) {
      const expiry = new Date(data[i][2]);
      if (expiry > new Date()) {
        const username = data[i][1];
        const users = ss.getSheetByName('Users');
        const uData = users.getDataRange().getValues();
        const header = uData[0];
        const uRow = uData.find(r => r[header.indexOf('username')] === username);
        return {
          ok: true, username,
          roles: uRow ? uRow[header.indexOf('roles')].split(',') : [],
          name: uRow ? uRow[header.indexOf('name')] : username,
          pay_rate: uRow ? uRow[header.indexOf('pay_rate')] || '' : ''
        };
      }
    }
  }
  return { ok: false };
}

function saveVisitPhotos_(photos, formData) {
  const poolId   = String(formData.pool_id || formData['pool_id'] || 'UNKNOWN').trim();
  const dateStr  = Utilities.formatDate(new Date(), "America/Chicago", "yyyy-MM-dd");
 
  // ── Find or create root folder ───────────────────────────────────────────
  const ROOT_FOLDER_NAME = "MCPS Visit Photos";
  let rootFolder;
  const rootSearch = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  if (rootSearch.hasNext()) {
    rootFolder = rootSearch.next();
  } else {
    rootFolder = DriveApp.createFolder(ROOT_FOLDER_NAME);
  }
 
  // ── Find or create pool subfolder ────────────────────────────────────────
  let poolFolder;
  const poolSearch = rootFolder.getFoldersByName(poolId);
  if (poolSearch.hasNext()) {
    poolFolder = poolSearch.next();
  } else {
    poolFolder = rootFolder.createFolder(poolId);
  }
 
  // ── Find or create date subfolder ────────────────────────────────────────
  let dateFolder;
  const dateSearch = poolFolder.getFoldersByName(dateStr);
  if (dateSearch.hasNext()) {
    dateFolder = dateSearch.next();
  } else {
    dateFolder = poolFolder.createFolder(dateStr);
  }
 
  // ── Save each photo ───────────────────────────────────────────────────────
  const urls = [];
  photos.forEach(function(photo, idx) {
    try {
      const mimeType = photo.mimeType || 'image/jpeg';
      const ext      = mimeType.split('/')[1] || 'jpg';
      const fileName = photo.name || (poolId + '_' + dateStr + '_photo' + (idx + 1) + '.' + ext);
 
      // Decode base64 — strip data URI prefix if present
      const b64 = photo.base64.replace(/^data:[^;]+;base64,/, '');
      const blob = Utilities.newBlob(Utilities.base64Decode(b64), mimeType, fileName);
 
      const file = dateFolder.createFile(blob);
 
      // Make publicly readable so Gmail can fetch it
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
 
      // Use the direct thumbnail URL — works inline in email clients
      // Format: https://drive.google.com/thumbnail?id=FILE_ID&sz=w800
      const fileId = file.getId();
      urls.push('https://drive.google.com/thumbnail?id=' + fileId + '&sz=w800');
 
    } catch(e) {
      Logger.log("Failed to save photo " + idx + ": " + e);
    }
  });
  Logger.log("Saved " + urls.length + " photos for " + poolId + " on " + dateStr);
  return urls;
}

function getEmployeeSensitiveSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('EMPLOYEE_SENSITIVE_SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.create('MCPS Employee Sensitive Info');
  props.setProperty('EMPLOYEE_SENSITIVE_SPREADSHEET_ID', ss.getId());
  return ss;
}

function getEmployeeSensitiveSheet_() {
  const ss = getEmployeeSensitiveSpreadsheet_();
  let sheet = ss.getSheetByName('Employee_Sensitive_Info');
  const headers = [
    'submitted_at','updated_at','username','full_legal_name','preferred_name','date_of_birth',
    'phone','email','home_address_line1','home_address_line2','home_city','home_state','home_zip',
    'drivers_license_photo_url','drivers_license_number','drivers_license_expiration','emergency_contact_name',
    'emergency_contact_relationship','emergency_contact_phone','allergies',
    'emergency_medical_notes','shirt_size'
  ];
  if (!sheet) {
    sheet = ss.insertSheet('Employee_Sensitive_Info');
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  } else {
    const existing = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0]
      .map(function(h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); });
    headers.forEach(function(h) {
      if (existing.indexOf(h) === -1) {
        sheet.getRange(1, sheet.getLastColumn() + 1).setValue(h);
        existing.push(h);
      }
    });
  }
  return sheet;
}

function getEmployeeSensitiveFolder_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('EMPLOYEE_SENSITIVE_DRIVE_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  const folder = DriveApp.createFolder('MCPS Employee Sensitive Docs');
  props.setProperty('EMPLOYEE_SENSITIVE_DRIVE_FOLDER_ID', folder.getId());
  return folder;
}

function saveSensitiveDriverLicense_(payload, username) {
  const dataUrl = String(payload.drivers_license_photo || '');
  if (!dataUrl) return '';
  const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) throw new Error('Invalid driver license image.');
  const mimeType = matches[1];
  const ext = mimeType.indexOf('png') !== -1 ? 'png' : mimeType.indexOf('webp') !== -1 ? 'webp' : 'jpg';
  const cleanName = String(payload.drivers_license_photo_name || 'drivers_license').replace(/[^\w.-]+/g, '_');
  const blob = Utilities.newBlob(Utilities.base64Decode(matches[2]), mimeType, username + '_drivers_license_' + Date.now() + '_' + cleanName + '.' + ext);
  const file = getEmployeeSensitiveFolder_().createFile(blob);
  return file.getUrl();
}

function saveEmployeeSensitiveInfo_(payload, auth) {
  const username = String(auth.username || '').trim().toLowerCase();
  if (!username) return { ok: false, error: 'Unauthorized' };
  const sheet = getEmployeeSensitiveSheet_();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function(h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); });
  const data = sheet.getLastRow() >= 2 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues() : [];
  const usernameCol = headers.indexOf('username');
  let rowIdx = -1;
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][usernameCol] || '').trim().toLowerCase() === username) {
      rowIdx = i + 2;
      break;
    }
  }
  const now = new Date().toISOString();
  const dlUrl = payload.drivers_license_photo ? saveSensitiveDriverLicense_(payload, username) : '';
  const values = {
    submitted_at: rowIdx === -1 ? now : '',
    updated_at: now,
    username: username,
    full_legal_name: payload.legal_name || '',
    preferred_name: payload.preferred_name || '',
    date_of_birth: payload.dob || '',
    phone: payload.phone || '',
    email: payload.email || '',
    home_address_line1: payload.address_line1 || '',
    home_address_line2: payload.address_line2 || '',
    home_city: payload.address_city || '',
    home_state: payload.address_state || '',
    home_zip: payload.address_zip || '',
    drivers_license_photo_url: dlUrl,
    drivers_license_number: payload.drivers_license_number || '',
    drivers_license_expiration: payload.drivers_license_expiration || '',
    emergency_contact_name: payload.emergency_name || '',
    emergency_contact_relationship: payload.emergency_relationship || '',
    emergency_contact_phone: payload.emergency_phone || '',
    allergies: payload.allergies || '',
    emergency_medical_notes: payload.medical_conditions || '',
    shirt_size: payload.shirt_size || ''
  };
  if (rowIdx === -1) {
    const row = new Array(headers.length).fill('');
    headers.forEach(function(h, i) { if (values[h] !== undefined) row[i] = values[h]; });
    sheet.appendRow(row);
  } else {
    headers.forEach(function(h, i) {
      if (values[h] === undefined) return;
      if (h === 'submitted_at' && !values[h]) return;
      if (h === 'drivers_license_photo_url' && !values[h]) return;
      sheet.getRange(rowIdx, i + 1).setValue(values[h]);
    });
  }
  const onboardingStatus = getOnboardingStatusForUsername_(username);
  const i9Status = getEmployeeI9StatusForUsername_(username);
  return { ok: true, sensitive_info_done: true, i9_done: i9Status.done, info_done: onboardingStatus.info_done, contract_done: onboardingStatus.contract_done };
}

function getSensitiveInfoStatusForUsername_(username) {
  try {
    const sheet = getEmployeeSensitiveSheet_();
    if (!sheet || sheet.getLastRow() < 2) return { done: false };
    const data = sheet.getDataRange().getValues();
    const headers = data[0].map(function(h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); });
    const usernameCol = headers.indexOf('username');
    if (usernameCol < 0) return { done: false };
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][usernameCol] || '').trim().toLowerCase() === String(username || '').trim().toLowerCase()) {
        const get = function(col) {
          const idx = headers.indexOf(col);
          return idx >= 0 ? data[i][idx] : '';
        };
        return {
          done: true,
          full_name: get('full_legal_name'),
          preferred_name: get('preferred_name'),
          phone: get('phone'),
          email: get('email')
        };
      }
    }
  } catch(e) {
    Logger.log('getSensitiveInfoStatusForUsername_: ' + e);
  }
  return { done: false };
}

function getOnboardingStatusForUsername_(username) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Onboarding_Submissions");
  if (!sheet || sheet.getLastRow() < 2) return { info_done: false, contract_done: false };
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1] || '').trim().toLowerCase() === String(username || '').trim().toLowerCase()) {
      return { info_done: !!data[i][0], contract_done: !!data[i][7] };
    }
  }
  return { info_done: false, contract_done: false };
}

function getEmployeeI9Sheet_() {
  const ss = getEmployeeSensitiveSpreadsheet_();
  let sheet = ss.getSheetByName('Employee_I9_Submissions');
  const headers = [
    'submitted_at','updated_at','username','full_name','ssn_last4','citizenship_status',
    'work_authorization_expiration','uscis_number','i94_number','foreign_passport',
    'foreign_passport_country','preparer_used','signature_name','signature_date',
    'i9_pdf_url','admin_section2_status','admin_section2_signed_at'
  ];
  if (!sheet) {
    sheet = ss.insertSheet('Employee_I9_Submissions');
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  } else {
    const existing = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0]
      .map(function(h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); });
    headers.forEach(function(h) {
      if (existing.indexOf(h) === -1) {
        sheet.getRange(1, sheet.getLastColumn() + 1).setValue(h);
        existing.push(h);
      }
    });
  }
  return sheet;
}

function getEmployeeI9StatusForUsername_(username) {
  try {
    const sheet = getEmployeeI9Sheet_();
    if (!sheet || sheet.getLastRow() < 2) return { done: false };
    const data = sheet.getDataRange().getValues();
    const headers = data[0].map(function(h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); });
    const usernameCol = headers.indexOf('username');
    const pdfCol = headers.indexOf('i9_pdf_url');
    const submittedCol = headers.indexOf('submitted_at');
    if (usernameCol < 0) return { done: false };
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][usernameCol] || '').trim().toLowerCase() === String(username || '').trim().toLowerCase()) {
        return {
          done: !!(data[i][submittedCol] && data[i][pdfCol]),
          i9_pdf_url: pdfCol >= 0 ? data[i][pdfCol] : ''
        };
      }
    }
  } catch(e) {
    Logger.log('getEmployeeI9StatusForUsername_: ' + e);
  }
  return { done: false };
}

function saveEmployeeI9Info_(payload, auth) {
  const username = String(auth.username || '').trim().toLowerCase();
  if (!username) return { ok: false, error: 'Unauthorized' };
  const sensitiveStatus = getSensitiveInfoStatusForUsername_(username);
  if (!sensitiveStatus.done) return { ok: false, error: 'Complete Personal Information first.' };
  if (!payload.i9_base64) return { ok: false, error: 'Review and sign the I-9 before submitting.' };

  const folder = getEmployeeSensitiveFolder_();
  const blob = Utilities.newBlob(Utilities.base64Decode(payload.i9_base64), 'application/pdf', username + '_i9.pdf');
  const file = folder.createFile(blob);
  const i9Url = file.getUrl();

  const sheet = getEmployeeI9Sheet_();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function(h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); });
  const data = sheet.getLastRow() >= 2 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues() : [];
  const usernameCol = headers.indexOf('username');
  let rowIdx = -1;
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][usernameCol] || '').trim().toLowerCase() === username) {
      rowIdx = i + 2;
      break;
    }
  }
  const now = new Date().toISOString();
  const ssnLast4 = payload.ssn_full ? String(payload.ssn_full).replace(/\D/g, '').slice(-4) : '';
  const values = {
    submitted_at: rowIdx === -1 ? now : now,
    updated_at: now,
    username: username,
    full_name: payload.full_name || '',
    ssn_last4: ssnLast4,
    citizenship_status: payload.citizenship_status || '',
    work_authorization_expiration: payload.work_authorization_expiration || '',
    uscis_number: payload.uscis_number || '',
    i94_number: payload.i94_number || '',
    foreign_passport: payload.foreign_passport || '',
    foreign_passport_country: payload.foreign_passport_country || '',
    preparer_used: payload.preparer_used ? 'yes' : 'no',
    signature_name: payload.signature_name || '',
    signature_date: payload.signature_date || '',
    i9_pdf_url: i9Url,
    admin_section2_status: 'pending_review'
  };

  if (rowIdx === -1) {
    const row = new Array(headers.length).fill('');
    headers.forEach(function(h, i) { if (values[h] !== undefined) row[i] = values[h]; });
    sheet.appendRow(row);
  } else {
    headers.forEach(function(h, i) {
      if (values[h] !== undefined) sheet.getRange(rowIdx, i + 1).setValue(values[h]);
    });
  }

  const onboardingStatus = getOnboardingStatusForUsername_(username);
  return {
    ok: true,
    sensitive_info_done: true,
    i9_done: true,
    info_done: onboardingStatus.info_done,
    contract_done: onboardingStatus.contract_done,
    i9_pdf_url: i9Url
  };
}

// ── processPendingSvcJobs_ ────────────────────────────────────────────────────
// Time-based trigger fired ~5s after submit_form returns ok:true.
// Handles the slow post-processing that would otherwise block the technician:
//   • snapshotUsageToPriced_ (reads 2 sheets)
//   • deductInventoryOnFormSubmit_ (opens 2 external spreadsheets via openById)
//   • sendVisitReportEmail (Zapier webhook)
//   • Scheduled_Visits append (opens Routes spreadsheet via openById)
function processPendingSvcJobs_() {
  // Delete all copies of this trigger first (GAS accumulates one per submission)
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === 'processPendingSvcJobs_'; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });

  const props = PropertiesService.getScriptProperties();
  const jobIds = JSON.parse(props.getProperty('svc_jobs_pending') || '[]');
  if (!jobIds.length) return;
  props.deleteProperty('svc_jobs_pending');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName('Chemical_Usage_Log');
  if (!rawSheet) return;
  const lastCol = rawSheet.getLastColumn();
  const headers = rawSheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h || '').trim(); });

  jobIds.forEach(function(jobId) {
    const jobRaw = props.getProperty('svc_job_' + jobId);
    if (!jobRaw) return;
    props.deleteProperty('svc_job_' + jobId);
    try {
      const job = JSON.parse(jobRaw);
      const rowNum = job.rowNum;
      const poolId = job.poolId;
      const portalUser = job.portalUser || '';
      const photoUrls = job.photoUrls || [];
      const e = { range: rawSheet.getRange(rowNum, 1) };

      try { snapshotUsageToPriced_(e); } catch (err) { Logger.log('processPendingSvcJobs_ snapshot: ' + err); }
      try { deductInventoryOnFormSubmit_(e); } catch (err) { Logger.log('processPendingSvcJobs_ deduct: ' + err); }

      const svPoolId = extractPoolId_(poolId);
      if (svPoolId && svPoolId !== 'OTHER / POOL NOT LISTED' && svPoolId !== 'Other / Pool not listed') {
        const lastRowData = rawSheet.getRange(rowNum, 1, 1, lastCol).getValues()[0];
        try { sendVisitReportEmail(lastRowData, headers, svPoolId, photoUrls); } catch (err) { Logger.log('processPendingSvcJobs_ email: ' + err); }

        try {
          const svSheet = (function() {
            const existing = ss.getSheetByName('Scheduled_Visits');
            if (existing) return existing;
            const created = ss.insertSheet('Scheduled_Visits');
            created.appendRow(['visit_id', 'pool_id', 'technician', 'date', 'service_type', 'status', 'chem_log_ref']);
            return created;
          })();
          const routesSs = SpreadsheetApp.openById('1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM');
          const routesSheet = routesSs.getSheetByName('Routes');
          let svServiceType = 'Weekly Full Service';
          if (routesSheet && routesSheet.getLastRow() >= 2) {
            const rData = routesSheet.getDataRange().getValues();
            const rH = rData[0].map(function(h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); });
            const rPid = rH.indexOf('pool_id');
            const rSvc = rH.indexOf('service');
            if (rPid !== -1 && rSvc !== -1) {
              for (let ri = 1; ri < rData.length; ri++) {
                if (String(rData[ri][rPid] || '').trim() === svPoolId) {
                  const found = String(rData[ri][rSvc] || '').trim();
                  if (found) svServiceType = found;
                  break;
                }
              }
            }
          }
          const completedAtRaw = lastRowData[0];
          const completedAt = completedAtRaw ? new Date(completedAtRaw) : new Date();
          const safeCompletedAt = isNaN(completedAt.getTime()) ? new Date() : completedAt;
          svSheet.appendRow([Utilities.getUuid(), svPoolId, portalUser, safeCompletedAt.toISOString(), svServiceType, 'completed', rowNum]);

          // Write to Job_Completions table in Routes SS
          const completedDateStr = Utilities.formatDate(safeCompletedAt, 'America/Chicago', 'yyyy-MM-dd');
          const visitId = svPoolId + '_' + completedDateStr;
          const dayNum = safeCompletedAt.getDay();
          const weekStartDate = new Date(safeCompletedAt);
          weekStartDate.setDate(weekStartDate.getDate() + (dayNum === 0 ? -6 : 1 - dayNum));
          const weekStart = Utilities.formatDate(weekStartDate, 'America/Chicago', 'yyyy-MM-dd');
          const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
          let jcSheet = routesSs.getSheetByName('Job_Completions');
          if (!jcSheet) {
            jcSheet = routesSs.insertSheet('Job_Completions');
            jcSheet.appendRow(['visit_id','pool_id','technician','completed_at','week_start','day_of_week','service_log_row','date']);
          }
          let alreadyRecorded = false;
          if (jcSheet.getLastRow() >= 2) {
            const jcValues = jcSheet.getRange(1, 1, jcSheet.getLastRow(), jcSheet.getLastColumn()).getValues();
            const jcHeaders = jcValues[0].map(function(h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); });
            const visitIdCol = jcHeaders.indexOf('visit_id');
            if (visitIdCol >= 0) {
              alreadyRecorded = jcValues.slice(1).some(function(r) { return String(r[visitIdCol] || '') === visitId; });
            }
          }
          if (!alreadyRecorded) {
            jcSheet.appendRow([visitId, svPoolId, portalUser, safeCompletedAt.toISOString(), weekStart, dayNames[dayNum], rowNum, completedDateStr]);
          }
        } catch (svErr) { Logger.log('processPendingSvcJobs_ Routes writes: ' + svErr); }
      }
    } catch (jobErr) {
      Logger.log('processPendingSvcJobs_ job ' + jobId + ' error: ' + jobErr);
    }
  });
}


// ── TEST / DRY-RUN HELPERS (safe to run anytime — no data is modified) ────────

// Test 1: Verifies Script Properties queue round-trip + trigger creation.
// Run from Apps Script editor. Check Logs for PASS/FAIL.
function testSvcQueue_() {
  Logger.log('=== testSvcQueue_ START ===');
  const props = PropertiesService.getScriptProperties();
  const jobId = 'TEST_' + Date.now();
  const fakeJob = { rowNum: 999, poolId: 'DRY_RUN', portalUser: 'Test', photoUrls: [] };

  // Write
  props.setProperty('svc_job_' + jobId, JSON.stringify(fakeJob));
  const pending = JSON.parse(props.getProperty('svc_jobs_pending') || '[]');
  pending.push(jobId);
  props.setProperty('svc_jobs_pending', JSON.stringify(pending));
  Logger.log('PASS: wrote job to Script Properties');

  // Read back
  const readBack = JSON.parse(props.getProperty('svc_job_' + jobId));
  if (readBack.rowNum !== 999 || readBack.poolId !== 'DRY_RUN') {
    Logger.log('FAIL: job data mismatch — ' + JSON.stringify(readBack));
  } else {
    Logger.log('PASS: job data reads back correctly');
  }

  // Clean up
  props.deleteProperty('svc_job_' + jobId);
  const cleanedPending = JSON.parse(props.getProperty('svc_jobs_pending') || '[]').filter(function(id) { return id !== jobId; });
  if (cleanedPending.length === 0) props.deleteProperty('svc_jobs_pending');
  else props.setProperty('svc_jobs_pending', JSON.stringify(cleanedPending));
  Logger.log('PASS: cleaned up Script Properties');

  // Trigger creation (creates and immediately deletes — no trigger left behind)
  try {
    const t = ScriptApp.newTrigger('processPendingSvcJobs_').timeBased().after(60000).create();
    ScriptApp.deleteTrigger(t);
    Logger.log('PASS: trigger creation + deletion works');
  } catch (err) {
    Logger.log('FAIL: trigger creation error — ' + err);
  }

  Logger.log('=== testSvcQueue_ DONE ===');
}

// Test 2: Reads the real last row of Chemical_Usage_Log and logs exactly what
// processPendingSvcJobs_ would do — no writes, no email, no inventory changes.
function dryRunSvcPostProcess_() {
  Logger.log('=== dryRunSvcPostProcess_ START (READ-ONLY) ===');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName('Chemical_Usage_Log');
  if (!rawSheet) { Logger.log('FAIL: Chemical_Usage_Log sheet not found'); return; }

  const lastCol = rawSheet.getLastColumn();
  const lastRow = rawSheet.getLastRow();
  if (lastRow < 2) { Logger.log('FAIL: no data rows in Chemical_Usage_Log'); return; }

  const headers = rawSheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h || '').trim(); });
  const rowData = rawSheet.getRange(lastRow, 1, 1, lastCol).getValues()[0];
  Logger.log('Using row ' + lastRow + ' — headers count: ' + headers.length);

  // What pool would be processed?
  const pidIdx = headers.indexOf('pool_id');
  const rawPoolId = pidIdx !== -1 ? String(rowData[pidIdx] || '') : '';
  const svPoolId = extractPoolId_(rawPoolId);
  Logger.log('pool_id raw: "' + rawPoolId + '"  →  extractPoolId_: "' + svPoolId + '"');

  // Would email be sent?
  if (!svPoolId || svPoolId === 'OTHER / POOL NOT LISTED' || svPoolId === 'Other / Pool not listed') {
    Logger.log('Email: SKIP — no valid pool_id');
  } else {
    Logger.log('Email: WOULD call sendVisitReportEmail for ' + svPoolId);
  }

  // Would inventory be deducted?
  Logger.log('Inventory deduction: WOULD call deductInventoryOnFormSubmit_ for row ' + lastRow);
  Logger.log('  (opens CHEM_LOG_SS + INV_DEDUCT_SPREADSHEET via openById — this is the slow part)');

  // Would snapshot run?
  Logger.log('Snapshot: WOULD call snapshotUsageToPriced_ for row ' + lastRow);

  // Would Scheduled_Visits get a row?
  if (svPoolId && svPoolId !== 'OTHER / POOL NOT LISTED') {
    Logger.log('Scheduled_Visits: WOULD append completed visit for ' + svPoolId);
    // Dry-run the Routes lookup (read-only)
    try {
      const routesSs = SpreadsheetApp.openById('1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM');
      const routesSheet = routesSs.getSheetByName('Routes');
      let svServiceType = 'Weekly Full Service (default)';
      if (routesSheet && routesSheet.getLastRow() >= 2) {
        const rData = routesSheet.getDataRange().getValues();
        const rH = rData[0].map(function(h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); });
        const rPid = rH.indexOf('pool_id');
        const rSvc = rH.indexOf('service');
        if (rPid !== -1 && rSvc !== -1) {
          for (let ri = 1; ri < rData.length; ri++) {
            if (String(rData[ri][rPid] || '').trim() === svPoolId) {
              const found = String(rData[ri][rSvc] || '').trim();
              if (found) svServiceType = found;
              break;
            }
          }
        }
      }
      Logger.log('  Routes lookup OK — service_type would be: "' + svServiceType + '"');
    } catch (err) {
      Logger.log('  Routes lookup FAILED: ' + err);
    }
  } else {
    Logger.log('Scheduled_Visits: SKIP — no valid pool_id');
  }

  Logger.log('=== dryRunSvcPostProcess_ DONE — nothing was written ===');
}

/*  REPLACE your existing doPost() with this full version:  */



function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    const payload = JSON.parse(raw);

    if (payload.action === 'login') {
      return jsonResponse_(handleLogin(payload));
    }

    if (payload.action === 'debug_payroll_auth') {
      const tok = payload.token || '';
      const auth = validateToken(tok);
      const hasAdminRole = auth.ok && (auth.roles || []).includes('admin');
      const hasManagerRole = auth.ok && (auth.roles || []).includes('manager');
      let saveResult = null;
      try {
        if (auth.ok && (hasAdminRole || hasManagerRole)) {
          saveResult = savePayrollConfig_(payload.config || { w2: { name: 'Debug', pct: 50, filing_status: 'single' }, partners: [{ name: 'P1', pct: 50 }] });
        }
      } catch(dbgErr) { saveResult = { error: String(dbgErr) }; }
      return jsonResponse_({
        ok: true,
        token_received: tok.length > 0,
        token_length: tok.length,
        token_prefix: tok.slice(0, 8),
        auth_ok: auth.ok,
        auth_error: auth.error || null,
        auth_username: auth.username || null,
        auth_roles: auth.roles || null,
        has_admin: hasAdminRole,
        has_manager: hasManagerRole,
        save_result: saveResult,
      });
    }

    if (payload.action === 'validate_token') {
      const auth = validateToken(payload.token || '');
      return jsonResponse_(auth);
    }

    if (payload.action === 'admin_create_employee_invite') {
      return jsonResponse_(handleCreateEmployeeInvite(payload));
    }

    if (payload.action === 'admin_list_employee_invites') {
      return jsonResponse_(handleListEmployeeInvites(payload));
    }

    if (payload.action === 'admin_cancel_employee_invite') {
      return jsonResponse_(handleCancelEmployeeInvite(payload));
    }

    if (payload.action === 'admin_resend_employee_invite') {
      return jsonResponse_(handleResendEmployeeInvite(payload));
    }

    if (payload.action === 'employee_invite_lookup') {
      return jsonResponse_(handleEmployeeInviteLookup(payload));
    }

    if (payload.action === 'employee_register') {
      return jsonResponse_(handleEmployeeRegister(payload));
    }

    // Zapier/SignRequest callback. Zapier may not have a portal session token,
    // so allow either a valid portal token or the shared webhook secret.
    if (payload.action === 'service_agreement_signed') {
      const auth = payload.token ? validateToken(payload.token || '') : { ok: false };
      const secretOk = payload.secret && String(payload.secret) === WEBHOOK_SECRET;
      if (!auth.ok && !secretOk) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(handleServiceAgreementSigned_(payload));
    }

    if (payload.action === 'get_proposal_approval') {
      return jsonResponse_(handleGetProposalApproval_(payload));
    }

    if (payload.action === 'respond_to_proposal') {
      const proposalResponse = handleRespondToProposal_(payload);
      invalidateCrmCache_();
      return jsonResponse_(proposalResponse);
    }

    if (payload.action === 'save_sensitive_info') {
      const auth = validateToken(payload.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error || "Unauthorized" });
      try {
        const result = saveEmployeeSensitiveInfo_(payload, auth);
        return jsonResponse_(result);
      } catch (err) {
        return jsonResponse_({ ok: false, error: err.toString() });
      }
    }

    if (payload.action === 'save_i9_info') {
      const auth = validateToken(payload.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error || "Unauthorized" });
      try {
        const result = saveEmployeeI9Info_(payload, auth);
        return jsonResponse_(result);
      } catch (err) {
        return jsonResponse_({ ok: false, error: err.toString() });
      }
    }
    
    // ── ONBOARDING: Save Personal Info + Generate W-9/W-4 in Google Drive ──────────
    if (payload.action === 'save_info') {
      const auth = validateToken(payload.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error || "Unauthorized" });
      try {
        var username = auth.user ? auth.user.username : (auth.username || '');
        var i9GateStatus = getEmployeeI9StatusForUsername_(username);
        if (!i9GateStatus.done) return jsonResponse_({ ok: false, error: "Complete I-9 first." });
        var workerType = auth.user && auth.user.worker_type ? auth.user.worker_type : (auth.worker_type || "1099_contractor");
        var w9Url = null;
        var w4Url = null;
        
        if (payload.w9_base64) {
          var folder = DriveApp.getFolderById("1ayk3CdpgBIn1DbYJbgneVMPBsq2rUlNZ");
          var blob = Utilities.newBlob(Utilities.base64Decode(payload.w9_base64), 'application/pdf', username + '_w9.pdf');
          var file = folder.createFile(blob);
          w9Url = file.getUrl();
        }

        if (payload.w4_base64) {
          var folder = DriveApp.getFolderById("1ayk3CdpgBIn1DbYJbgneVMPBsq2rUlNZ"); 
          var blob = Utilities.newBlob(Utilities.base64Decode(payload.w4_base64), 'application/pdf', username + '_w4.pdf');
          var file = folder.createFile(blob);
          w4Url = file.getUrl();
        }
        
        var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Onboarding_Submissions");
        if (!sheet) {
          sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet("Onboarding_Submissions");
          sheet.appendRow(["info_submitted_at", "username", "full_name", "phone", "tax_type", "tax_id_last4", "w9_url", "contract_signed_at", "contract_signed_name", "approved_by", "approved_at", "status", "admin_notes", "dob", "address_line1", "address_city", "address_state", "address_zip", "emergency_name", "emergency_phone"]);
        }
        
        var headersRange = sheet.getRange(1, 1, 1, sheet.getLastColumn());
        var headers = headersRange.getValues()[0];
        
        if (headers.indexOf('w4_url') === -1) {
          sheet.getRange(1, headers.length + 1).setValue('w4_url');
          headers.push('w4_url');
        }
        if (headers.indexOf('worker_type') === -1) {
          sheet.getRange(1, headers.length + 1).setValue('worker_type');
          headers.push('worker_type');
        }

        var data = sheet.getDataRange().getValues();
        var rowIdx = -1;
        for (var i = 1; i < data.length; i++) {
          if (data[i][1] === username) { rowIdx = i + 1; break; }
        }
        
        var taxLast4 = payload.tax_id_full ? payload.tax_id_full.replace(/\D/g, '').slice(-4) : '';
        
        var rowData = [
          new Date().toISOString(), username, payload.legal_name, payload.phone, payload.tax_type, taxLast4, w9Url,
          "", "", "", "", "in_progress", "", payload.dob, payload.address_line1, payload.address_city, payload.address_state, payload.address_zip, payload.emergency_name, payload.emergency_phone, w4Url || '', workerType
        ];
        
        if (rowIdx > -1) {
          for (var j = 0; j < headers.length; j++) {
            if (headers[j] === 'info_submitted_at') sheet.getRange(rowIdx, j+1).setValue(new Date().toISOString());
            if (headers[j] === 'full_name') sheet.getRange(rowIdx, j+1).setValue(payload.legal_name);
            if (headers[j] === 'phone') sheet.getRange(rowIdx, j+1).setValue(payload.phone);
            if (headers[j] === 'tax_type') sheet.getRange(rowIdx, j+1).setValue(payload.tax_type);
            if (headers[j] === 'tax_id_last4') sheet.getRange(rowIdx, j+1).setValue(taxLast4);
            if (w9Url && headers[j] === 'w9_url') sheet.getRange(rowIdx, j+1).setValue(w9Url);
            if (w4Url && headers[j] === 'w4_url') sheet.getRange(rowIdx, j+1).setValue(w4Url);
            if (headers[j] === 'worker_type') sheet.getRange(rowIdx, j+1).setValue(workerType);
            if (headers[j] === 'dob') sheet.getRange(rowIdx, j+1).setValue(payload.dob);
            if (headers[j] === 'address_line1') sheet.getRange(rowIdx, j+1).setValue(payload.address_line1);
            if (headers[j] === 'address_city') sheet.getRange(rowIdx, j+1).setValue(payload.address_city);
            if (headers[j] === 'address_state') sheet.getRange(rowIdx, j+1).setValue(payload.address_state);
            if (headers[j] === 'address_zip') sheet.getRange(rowIdx, j+1).setValue(payload.address_zip);
            if (headers[j] === 'emergency_name') sheet.getRange(rowIdx, j+1).setValue(payload.emergency_name);
            if (headers[j] === 'emergency_phone') sheet.getRange(rowIdx, j+1).setValue(payload.emergency_phone);
          }
        } else {
          while(rowData.length < headers.length) rowData.push('');
          sheet.appendRow(rowData);
        }
        
        var savedStatus = getOnboardingStatusForUsername_(username);
        var savedSensitiveStatus = getSensitiveInfoStatusForUsername_(username);
        var savedI9Status = getEmployeeI9StatusForUsername_(username);
        return jsonResponse_({
          ok: true,
          sensitive_info_done: savedSensitiveStatus.done,
          i9_done: savedI9Status.done,
          info_done: true,
          contract_done: savedStatus.contract_done
        });
      } catch (err) {
        return jsonResponse_({ ok: false, error: err.toString() });
      }
    }
    
    // ── ONBOARDING: Save Contract Signature ──────────
    if (payload.action === 'onboarding_save_contract') {
      const auth = validateToken(payload.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      try {
        var username = auth.user ? auth.user.username : (auth.username || '');
        var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Onboarding_Submissions");
        if (!sheet) return jsonResponse_({ ok: false, error: "Setup missing." });
        var data = sheet.getDataRange().getValues();
        var headers = data[0];
        var rowIdx = -1;
        for (var i = 1; i < data.length; i++) {
          if (data[i][1] === username) { rowIdx = i + 1; break; }
        }
        if (rowIdx === -1) return jsonResponse_({ ok: false, error: "Submit personal info first." });
        
        for (var j = 0; j < headers.length; j++) {
          if (headers[j] === 'contract_signed_at') sheet.getRange(rowIdx, j+1).setValue(payload.signed_at);
          if (headers[j] === 'contract_signed_name') sheet.getRange(rowIdx, j+1).setValue(payload.signed_name);
          if (headers[j] === 'status') sheet.getRange(rowIdx, j+1).setValue("pending_review");
        }
        var contractSensitiveStatus = getSensitiveInfoStatusForUsername_(username);
        var contractI9Status = getEmployeeI9StatusForUsername_(username);
        return jsonResponse_({
          ok: true,
          sensitive_info_done: contractSensitiveStatus.done,
          i9_done: contractI9Status.done,
          info_done: true,
          contract_done: true
        });
      } catch (err) {
        return jsonResponse_({ ok: false, error: err.toString() });
      }
    }

    // ── ONBOARDING: Approve / Reject ──────────
    if (payload.action === 'onboarding_approve' || payload.action === 'onboarding_reject') {
      const auth = validateToken(payload.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      try {
        var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Onboarding_Submissions");
        var data = sheet.getDataRange().getValues();
        var headers = data[0];
        var rowIdx = -1;
        for (var i = 1; i < data.length; i++) {
          if (data[i][1] === payload.username) { rowIdx = i + 1; break; }
        }
        if (rowIdx > -1) {
          for (var j = 0; j < headers.length; j++) {
            if (payload.action === 'onboarding_approve') {
              if (headers[j] === 'status') sheet.getRange(rowIdx, j+1).setValue("approved");
              if (headers[j] === 'approved_at') sheet.getRange(rowIdx, j+1).setValue(new Date().toISOString());
              if (headers[j] === 'approved_by') sheet.getRange(rowIdx, j+1).setValue(auth.user ? auth.user.username : auth.username);
            } else {
              if (headers[j] === 'status') sheet.getRange(rowIdx, j+1).setValue("rejected");
              if (headers[j] === 'admin_notes') sheet.getRange(rowIdx, j+1).setValue(payload.note || "");
            }
          }
        }
        return jsonResponse_({ ok: true });
      } catch (err) {
        return jsonResponse_({ ok: false, error: err.toString() });
      }
    }

    if (payload.action === 'move_pool') {
      const data = movePool(payload.token || "", payload.pool_id || "", payload.new_day || "", payload.new_operator || "", payload.pinned);
      // For startup pools: persist the start date so GAS can filter by week
      if (data.ok && payload.startup_start_date) {
        setStartupDate_(payload.pool_id || "", payload.startup_start_date);
      }
      return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
    }

    if (payload.action === 'move_pool_week') {
      return jsonResponse_(movePoolThisWeek(
        payload.token || "", payload.pool_id || "",
        payload.new_day || "", payload.week_start || "",
        payload.new_operator || ""
      ));
    }

    if (payload.action === 'save_gate_code') {
      const auth = validateToken(payload.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return jsonResponse_({ ok: false, error: 'Admin access required.' });
      if (!payload.pool_id) return jsonResponse_({ ok: false, error: 'pool_id required' });
      const saved = saveGateCode_(String(payload.pool_id), String(payload.gate_code || ""));
      return jsonResponse_({ ok: saved, error: saved ? undefined : 'Pool not found in Routes sheet' });
    }

    if (payload.action === 'reschedule_startup') {
      return jsonResponse_(rescheduleStartupVisits(
        payload.token || "", payload.pool_id || "", payload.day_1_date || ""
      ));
    }

    if (payload.action === 'mark_startup_pending') {
      return jsonResponse_(markStartupPending(payload.token || "", payload.pool_id || ""));
    }

    if (payload.action === 'schedule_first_month_visits') {
      return jsonResponse_(scheduleFirstMonthVisits(
        payload.token || "",
        payload.pool_id || "",
        payload.week_1_monday || "",
        payload.day_of_week || "",
        payload.assigned_technician || ""
      ));
    }

    if (payload.action === 'convert_startup_to_weekly') {
      const res = convertStartupToWeekly(
        payload.token || "", payload.pool_id || "",
        payload.new_day || "", payload.service_start_date || ""
      );
      if (res && res.ok) {
        try {
          const hit = getQuoteByPoolId_(payload.pool_id || '');
          if (hit && hit.object && hit.object.quote_id) {
            completeStartupAndCreateWeeklyService_(String(hit.object.quote_id), res.service_start || '');
          }
        } catch(syncErr) {
          Logger.log('convert_startup_to_weekly normalized sync failed: ' + syncErr);
        }
      }
      return jsonResponse_(res);
    }

    if (payload.action === 'mark_startup_complete') {
      const res = markStartupComplete(payload.token || "", payload.pool_id || "");
      if (res && res.ok) {
        try { markStartupServiceCompleteByPool_(payload.pool_id || ""); }
        catch(syncErr) { Logger.log('mark_startup_complete normalized sync failed: ' + syncErr); }
      }
      return jsonResponse_(res);
    }

    if (payload.action === 'toggle_pin') {
      const data = togglePin(payload.token || "", payload.pool_id || "", payload.pinned === true);
      return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
    }

    if (payload.action === 'pin_day') {
      const data = pinDay(payload.token || "", payload.day || "", payload.pinned === true);
      return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
    }

    if (payload.action === 'recalculate_new') {
      const data = recalculateNew(payload.token || "");
      return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
    }

    if (payload.action === 'recalculate_routes') {
      const auth = validateToken(payload.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return jsonResponse_({ ok: false, error: 'Not authorized' });
      try {
        calculateRoutes();
        return jsonResponse_({ ok: true });
      } catch (err) {
        return jsonResponse_({ ok: false, error: String(err) });
      }
    }

    const trActions = { get_modules: true, create_module: true, update_module: true, delete_module: true, create_video: true, update_video: true, delete_video: true, create_content: true, update_content: true, delete_content: true, get_training_progress: true, upsert_training_progress: true, submit_quiz: true, get_quiz_results: true };
    if (trActions[payload.action]) {
      const auth = validateToken(payload.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error || "Unauthorized" });
      const userObj = auth.user || {};
      const rolesArr = Array.isArray(userObj.roles) ? userObj.roles : Array.isArray(auth.roles) ? auth.roles : String(userObj.roles || auth.roles || '').split(',').map(s => s.trim()).filter(Boolean);
      const session = { username: userObj.username || auth.username || '', roles: rolesArr.join(',') };
      const trResult = trHandleAction_(payload, session);
      if (trResult) return jsonResponse_(trResult);
    }

    if (payload.action === 'get_crm_data') { // Updated to handle Sales Hub fields
      const auth = validateToken(payload.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(handleSalesHubFetch_());
    }

    if (payload.action === 'update_lead') {
      const auth = validateToken(payload.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(handleUpdateLead_(payload));
    }

    if (payload.action === 'import_leads') {
      const auth = validateToken(payload.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(handleImportLeads_(payload.leads));
    }

    if (payload.action === 'convert_to_wfs') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return jsonResponse_({ ok: false, error: 'Not authorized' });
      return jsonResponse_(handleConvertToWFS_(payload));
    }

    if (payload.action === 'set_weekly_goal') {
      const auth = validateToken(payload.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(handleSetWeeklyGoal_(payload.goal));
    }

    const normalizedSalesActions = {
      setup_normalized_sales_sheets: true,
      migrate_quotes_normalized: true,
      get_clients: true,
      upsert_client: true,
      get_client_locations: true,
      upsert_client_location: true,
      get_client_proposals: true,
      get_location_proposals: true,
      create_proposal: true,
      upsert_proposal: true,
      save_proposal_items: true,
      get_proposal: true,
      get_latest_client_proposal: true,
      get_proposals_by_status: true,
      update_proposal_status: true,
      send_proposal_for_approval: true,
      get_service_agreements: true,
      get_client_service_agreements: true,
      get_location_service_agreements: true,
      get_service_agreement: true,
      create_service_agreement_from_proposal: true,
      create_direct_service_agreement: true,
      update_service_agreement: true,
      service_agreement_signed: true,
      activate_service_account_from_agreement: true,
      get_service_accounts: true,
      get_client_service_accounts: true,
      get_location_service_accounts: true,
      update_service_account: true,
      get_startup_companies: true,
      upsert_startup_company: true
    };
    if (normalizedSalesActions[payload.action]) {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      if ((payload.action === 'setup_normalized_sales_sheets' || payload.action === 'migrate_quotes_normalized' ||
           payload.action === 'activate_service_account_from_agreement') &&
          !hasRole(auth, 'admin') && !hasRole(auth, 'manager')) {
        return jsonResponse_({ ok: false, error: 'Admin access required.' });
      }
      const nsRes = handleNormalizedSalesAction_(payload);
      if (payload.action === 'send_proposal_for_approval' ||
          payload.action === 'update_proposal_status' ||
          payload.action === 'update_service_agreement') {
        invalidateCrmCache_();
      }
      return jsonResponse_(nsRes);
    }


    if (payload.action === 'save_quote') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      const sqRes = handleSaveQuote_(payload);
      invalidateCrmCache_();
      try {
        const c = CacheService.getScriptCache();
        c.remove('unassigned_pools');
        c.remove('weekly_goal');
      } catch(e) {}
      return sqRes;
    }

    if (payload.action === 'generate_contract') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(handleGenerateContract_(payload.quote_id || ''));
    }

    if (payload.action === 'generate_proposal') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(handleGenerateProposal_(payload));
    }

    if (payload.action === 'send_contract') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(handleSendContract_(payload.quote_id || ''));
    }

    if (payload.action === 'update_quote_info') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      const uqRes = jsonResponse_(handleUpdateQuoteInfo_(payload));
      invalidateCrmCache_();
      return uqRes;
    }
    
    if (payload.action === 'submit_issue_alert') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      const res = jsonResponse_(handleSubmitIssueAlert_(payload, auth.user || auth));
      invalidateIssueAlertsCache_();
      return res;
    }

    if (payload.action === 'resolve_issue_alert') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      const res = jsonResponse_(handleResolveIssueAlert_(payload, auth.user || auth));
      invalidateIssueAlertsCache_();
      return res;
    }

    if (payload.action === 'resolve_unmatched') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager'))
        return jsonResponse_({ ok: false, error: 'Unauthorized' });
      const resolvedBy = (auth.user && auth.user.name) ? auth.user.name : (auth.name || auth.username || 'admin');
      return jsonResponse_(resolveUnmatchedSubmission(
        Number(payload.row_index || 0),
        payload.pool_id || '',
        resolvedBy
      ));
    }

    if (payload.action === 'upload_alert_photo') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(handleUploadAlertPhoto_(payload, auth.user || auth));
    }
    
    if (payload.action === 'add_adhoc_event') {
      return jsonResponse_(addAdHocEvent(payload.token || '', payload.event || {}));
    }

    if (payload.action === 'schedule_gtc_visit') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(handleScheduleGtcVisit_(payload, auth));
    }

    if (payload.action === 'get_gtc_visits') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(handleGetGtcVisits_(payload.pool_id || ''));
    }

    if (payload.action === 'get_gtc_pools') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(handleGetGtcPools_());
    }

    if (payload.action === 'send_heads_up') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(sendHeadsUp(payload.pool_id || '', payload.customer_name || ''));
    }

    if (payload.action === 'get_pool_phone') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(getPoolPhone_(payload.pool_id || '', payload.customer_name || ''));
    }

    if (payload.action === 'save_payroll_config') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error || 'Unauthorized' });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return jsonResponse_({ ok: false, error: 'Admin access required.' });
      return jsonResponse_(savePayrollConfig_(payload.config));
    }

    if (payload.action === 'log_payroll_payment') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error || 'Unauthorized' });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return jsonResponse_({ ok: false, error: 'Admin access required.' });
      const name = (auth.user && auth.user.name) ? auth.user.name : (auth.name || auth.username || '');
      return jsonResponse_(logPayrollPayment_(payload.type, payload.person, payload.period, payload.gross_amount, payload.net_amount, payload.note, name));
    }

    if (payload.action === 'save_startup_checklist') {
      return handleSaveStartupChecklist_(payload);
    }

    if (payload.secret !== WEBHOOK_SECRET) {
      return jsonResponse_({ ok: false, error: "Unauthorized" });
    }


    if (payload.action === 'logout')      return jsonResponse_(handleLogout(payload));
    if (payload.action === 'create_user') return jsonResponse_(handleCreateUser(payload));
    if (payload.action === 'update_user') return jsonResponse_(handleUpdateUser(payload));
    if (payload.action === 'list_users')  return jsonResponse_(handleListUsers(payload));
    if (payload.action === 'get_roles')   return jsonResponse_(handleGetRoles());

    if (payload.action === 'get_metadata') {
      return jsonResponse_({ ok: true, data: getFormMetadata() });
    }

    if (payload.action === 'get_portal_schema') {
      const auth = validateToken(payload.token);
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return jsonResponse_({ ok: false, error: 'Admin access required.' });
      return jsonResponse_({ ok: true, data: getPortalSchema_() });
    }

    if (payload.action === 'save_portal_schema') {
      const auth = validateToken(payload.token);
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return jsonResponse_({ ok: false, error: 'Admin access required.' });
      if (!Array.isArray(payload.schema)) return jsonResponse_({ ok: false, error: 'schema must be an array.' });
      savePortalSchema_(payload.schema);
      return jsonResponse_({ ok: true });
    }

    if (payload.action === 'sync_pool_dropdown') {
      const auth = validateToken(payload.token);
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return jsonResponse_({ ok: false, error: 'Admin access required.' });
      updateVisitLogDropdownFromSignedCustomers_();
      return jsonResponse_({ ok: true });
    }

    
    if (payload.action === 'get_pool_list') {
      const auth = validateToken(payload.token);
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error });
      try {
        const ss = SpreadsheetApp.openById('1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E');

        // Primary source: Quotes sheet filtered by ACTIVE_CUSTOMER
        const quotesSheet = ss.getSheetByName('Quotes');
        let pools = [];
        if (quotesSheet) {
          const rows = quotesSheet.getDataRange().getValues();
          const h = rows[0];
          const iPoolId   = h.indexOf('pool_id');
          const iStatus   = h.indexOf('status');
          const iLastName = h.indexOf('last_name');
          const iService  = h.indexOf('service');
          const iAddress  = h.indexOf('address');
          pools = rows.slice(1)
            .filter(r => (r[iStatus] || '').toString().trim().toUpperCase() === 'ACTIVE_CUSTOMER')
            .filter(r => r[iPoolId])
            .map(r => `${r[iLastName]} - ${r[iService]} - ${r[iAddress]} - ${r[iPoolId]}`)
            .sort();
        }

        // Fallback: Signed_Customers sheet (migration safety net — used until all customers are activated in Quotes)
        if (!pools.length) {
          const signedSheet = ss.getSheets().find(s => s.getSheetId() === 743951880);
          if (signedSheet) {
            const rows = signedSheet.getDataRange().getValues();
            const h = rows[0];
            const iPoolId   = h.indexOf('pool_id');
            const iStatus   = h.indexOf('status');
            const iLastName = h.indexOf('last_name');
            const iService  = h.indexOf('service');
            const iAddress  = h.indexOf('address');
            pools = rows.slice(1)
              .filter(r => (r[iStatus] || '').toString().trim().toLowerCase() === 'signed')
              .filter(r => r[iPoolId])
              .map(r => `${r[iLastName]} - ${r[iService]} - ${r[iAddress]} - ${r[iPoolId]}`)
              .sort();
          }
        }

        pools.push('Other / Pool not listed');
        return jsonResponse_({ ok: true, pools });
      } catch(err) {
        return jsonResponse_({ ok: false, error: err.message });
      }
    }



    if (payload.action === 'sync_chemicals') {
      const auth = validateToken(payload.token);
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return jsonResponse_({ ok: false, error: 'Admin access required.' });
      syncChemicalsToForm();
      return jsonResponse_({ ok: true });
    }

    if (payload.action === 'get_pool_context') {
      const auth = validateToken(payload.token);
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error });
      return jsonResponse_({ ok: true, data: getPoolContext_(payload.pool_id || '') });
    }

    if (payload.action === 'submit_form') {
      const auth = validateToken(payload.token);
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error });

      const userObj = auth.user || {};
      const portalUserName = String(userObj.name || userObj.display_name || userObj.username || '').trim();
      if (portalUserName) {
        payload.data.Technician = portalUserName;
      }

      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const rawSheet = ss.getSheetByName('Chemical_Usage_Log');
      const lastRow = rawSheet.getLastRow();
      if (lastRow > 1) {
        const headers = rawSheet.getRange(1, 1, 1, rawSheet.getLastColumn()).getValues()[0];
        const poolColIdx = headers.indexOf('pool_id');
        const techColIdx = headers.indexOf('Technician');
        const tsColIdx   = 0;
        const lastData   = rawSheet.getRange(lastRow, 1, 1, rawSheet.getLastColumn()).getValues()[0];
        const lastTs     = new Date(lastData[tsColIdx]);
        const lastPool   = String(lastData[poolColIdx] || '');
        const incomingPool = String(payload.data.pool_id || '');
        
        if (lastPool === incomingPool && (new Date() - lastTs) < 300000) {
          Logger.log('Dedup blocked: same pool within 5 minutes');
          return jsonResponse_({ ok: true });
        }
      }

      if (!canAccess(auth, 'service_log')) return jsonResponse_({ ok: false, error: 'Access denied.' });

      let photoUrls = [];
      if (Array.isArray(payload.photos) && payload.photos.length > 0) {
        try { photoUrls = saveVisitPhotos_(payload.photos, payload.data); } catch (e) {}
      }

      const result = submitCustomForm(payload.data);
      if (!result.success) return jsonResponse_({ ok: false, error: result.error });

      // appendRow is synchronous — no sleep needed
      const newRowNum = rawSheet.getLastRow();
      if (photoUrls.length > 0) {
        try {
          const headers = rawSheet.getRange(1, 1, 1, rawSheet.getLastColumn()).getValues()[0].map(h => String(h || '').trim());
          let photoColIdx = headers.indexOf('_photo_urls');
          if (photoColIdx === -1) {
            photoColIdx = rawSheet.getLastColumn();
            rawSheet.getRange(1, photoColIdx + 1).setValue('_photo_urls');
          }
          rawSheet.getRange(newRowNum, photoColIdx + 1).setValue(JSON.stringify(photoUrls));
        } catch (e) {}
      }

      // Queue slow post-processing (inventory deduction, email, Scheduled_Visits)
      // in a time-based trigger so the technician gets an instant response.
      // Each of these operations opens external spreadsheets or calls Zapier,
      // which can take 10–20s combined. The trigger fires ~5s after return.
      try {
        const jobId = Utilities.getUuid();
        const props = PropertiesService.getScriptProperties();
        props.setProperty('svc_job_' + jobId, JSON.stringify({
          rowNum: newRowNum,
          poolId: String(payload.data.pool_id || '').trim(),
          portalUser: portalUserName,
          photoUrls: photoUrls
        }));
        const pending = JSON.parse(props.getProperty('svc_jobs_pending') || '[]');
        pending.push(jobId);
        props.setProperty('svc_jobs_pending', JSON.stringify(pending));
        ScriptApp.newTrigger('processPendingSvcJobs_').timeBased().after(5000).create();
      } catch (queueErr) {
        // Fallback: run synchronously if trigger setup fails
        Logger.log('svc queue setup failed, running sync: ' + queueErr);
        try { snapshotUsageToPriced_({ range: rawSheet.getRange(newRowNum, 1) }); } catch (e) {}
        try { deductInventoryOnFormSubmit_({ range: rawSheet.getRange(newRowNum, 1) }); } catch (e) {}
        try {
          const poolId = extractPoolId_(String(payload.data.pool_id || '').trim());
          if (poolId && poolId !== 'OTHER / POOL NOT LISTED' && poolId !== 'Other / Pool not listed') {
            const headers = rawSheet.getRange(1, 1, 1, rawSheet.getLastColumn()).getValues()[0].map(h => String(h || '').trim());
            const lastRowData = rawSheet.getRange(newRowNum, 1, 1, rawSheet.getLastColumn()).getValues()[0];
            sendVisitReportEmail(lastRowData, headers, poolId, photoUrls);
          }
        } catch (e) {}
      }

      return jsonResponse_({ ok: true });
    }

    if (e && e.parameter && e.parameter.action === 'get_inventory') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      return jsonResponse_(getInventoryForPortal_());
    }

    if (e && e.parameter && e.parameter.action === 'get_purchase_log') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      return jsonResponse_({ ok: true, data: getPurchaseLog(100) });
    }
    
    if (e && e.parameter && e.parameter.action === 'get_pending_skus') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      return jsonResponse_({ ok: true, data: getPendingSkus() });
    }



    // ── Inventory management actions ────────────────────────────────────────────

    if (payload.action === 'manual_check_poolcorp') {
      const auth = validateToken(payload.token);
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return jsonResponse_({ ok: false, error: 'Admin access required.' });
      return jsonResponse_(manualCheckPoolCorpEmails());
    }

    if (payload.action === 'manual_apply_purchases') {
      const auth = validateToken(payload.token);
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return jsonResponse_({ ok: false, error: 'Admin access required.' });
      try {
        const result = manualApplyPurchases();
        return jsonResponse_({ ok: true, result });
      } catch(e) {
        return jsonResponse_({ ok: false, error: e.message });
      }
    }

    if (payload.action === 'approve_pending_sku') {
      const auth = validateToken(payload.token);
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return jsonResponse_({ ok: false, error: 'Admin access required.' });
      try {
        const result = approvePendingSku(payload.rowIndex, payload.overrides || {});
        return jsonResponse_(result);
      } catch(e) {
        return jsonResponse_({ ok: false, error: e.message });
      }
    }

    if (payload.action === 'reject_pending_sku') {
      const auth = validateToken(payload.token);
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return jsonResponse_({ ok: false, error: 'Admin access required.' });
      try {
        const result = rejectPendingSku(payload.rowIndex);
        return jsonResponse_(result);
      } catch(e) {
        return jsonResponse_({ ok: false, error: e.message });
      }
    }

    if (payload.action === 'set_inventory_qty') {
      const auth = validateToken(payload.token);
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return jsonResponse_({ ok: false, error: 'Admin access required.' });
      try {
        const result = setInventoryQty_(payload.chemical, payload.qty, auth.user || {});
        return jsonResponse_(result);
      } catch(e) {
        return jsonResponse_({ ok: false, error: e.message });
      }
    }

    // ── End inventory actions ───────────────────────────────────────────────────

    if (payload.action === 'technician_check_out') {
      const auth = validateToken(payload.token);
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error });
      try {
        const userObj = auth.user || {};
        const username = String(userObj.username || '').trim();
        const techName = String(userObj.name || userObj.display_name || username || '').trim();
        const checkoutTime = new Date();
        const checkoutId = Utilities.getUuid();
        const dayNum = checkoutTime.getDay();
        const weekStartDate = new Date(checkoutTime);
        weekStartDate.setDate(weekStartDate.getDate() + (dayNum === 0 ? -6 : 1 - dayNum));
        const weekStart = payload.week_start || Utilities.formatDate(weekStartDate, 'America/Chicago', 'yyyy-MM-dd');
        const poolsCompleted = parseInt(payload.pools_completed || 0, 10);
        const routesSs = SpreadsheetApp.openById('1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM');
        let coSheet = routesSs.getSheetByName('Checkout_Log');
        if (!coSheet) {
          coSheet = routesSs.insertSheet('Checkout_Log');
          coSheet.appendRow(['checkout_id','username','technician_name','checkout_time','week_start','pools_completed']);
        }
        coSheet.appendRow([checkoutId, username, techName, checkoutTime.toISOString(), weekStart, poolsCompleted]);
        return jsonResponse_({ ok: true, checkout_id: checkoutId });
      } catch(e) {
        return jsonResponse_({ ok: false, error: e.message });
      }
    }

    const result = processQBOBillPayload_(payload);
    return jsonResponse_({ ok: true, result });

  } catch (err) {
    Logger.log("doPost error: " + err);
    return jsonResponse_({ ok: false, error: String(err) });
  }
}



function doGet(e) {
  try {
    if (e && e.parameter && e.parameter.action === 'onboarding_get_status') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      var username = auth.user ? auth.user.username : (auth.username || '');
      var workerType = auth.user && auth.user.worker_type ? auth.user.worker_type : (auth.worker_type || "1099_contractor");
      var sensitiveStatus = getSensitiveInfoStatusForUsername_(username);
      var i9Status = getEmployeeI9StatusForUsername_(username);
      var userEmail = auth.user && auth.user.email ? auth.user.email : (auth.email || '');
      var userPhone = auth.user && auth.user.phone ? auth.user.phone : (auth.phone || '');
      
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Onboarding_Submissions");
      if (!sheet) return jsonResponse_({
        ok: true,
        sensitive_info_done: sensitiveStatus.done,
        i9_done: i9Status.done,
        info_done: false,
        contract_done: false,
        status: 'in_progress',
        worker_type: workerType,
        full_name: sensitiveStatus.full_name || '',
        preferred_name: sensitiveStatus.preferred_name || '',
        phone: sensitiveStatus.phone || userPhone,
        email: sensitiveStatus.email || userEmail
      });
      var data = sheet.getDataRange().getValues();
      for (var i = 1; i < data.length; i++) {
        if (data[i][1] === username) {
          return jsonResponse_({
            ok: true,
            sensitive_info_done: sensitiveStatus.done,
            i9_done: i9Status.done,
            info_done: !!data[i][0],
            contract_done: !!data[i][7],
            status: data[i][11] || 'in_progress',
            full_name: sensitiveStatus.full_name || data[i][2],
            preferred_name: sensitiveStatus.preferred_name || '',
            phone: sensitiveStatus.phone || data[i][3] || userPhone,
            email: sensitiveStatus.email || userEmail,
            worker_type: workerType
          });
        }
      }
      return jsonResponse_({
        ok: true,
        sensitive_info_done: sensitiveStatus.done,
        i9_done: i9Status.done,
        info_done: false,
        contract_done: false,
        status: 'in_progress',
        worker_type: workerType,
        full_name: sensitiveStatus.full_name || '',
        preferred_name: sensitiveStatus.preferred_name || '',
        phone: sensitiveStatus.phone || userPhone,
        email: sensitiveStatus.email || userEmail
      });
    }
    
    if (e && e.parameter && e.parameter.action === 'onboarding_list_pending') {
      var _auth = validateToken(e.parameter.token || "");
      if (!_auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      if (!hasRole(_auth, 'admin') && !hasRole(_auth, 'manager')) return jsonResponse_({ ok: false, error: "Admin access required." });
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Onboarding_Submissions");
      if (!sheet) return jsonResponse_({ ok: true, applications: [] });
      var data = sheet.getDataRange().getValues();
      var headers = data[0];
      var wTypeIdx = headers.indexOf('worker_type');
      
      var apps = [];
      for (var i = 1; i < data.length; i++) {
        if (data[i][11] === 'pending_review') {
          var pendingI9Status = getEmployeeI9StatusForUsername_(data[i][1]);
          apps.push({
            username: data[i][1],
            full_name: data[i][2],
            phone: data[i][3],
            info_submitted_at: data[i][0],
            info_done: !!data[i][0],
            i9_done: pendingI9Status.done,
            contract_done: !!data[i][7],
            status: 'pending_review',
            worker_type: wTypeIdx > -1 ? data[i][wTypeIdx] : '1099_contractor'
          });
        }
      }
      return jsonResponse_({ ok: true, applications: apps });
    }
    
    if (e && e.parameter && e.parameter.action === 'onboarding_list_all') {
      var _auth = validateToken(e.parameter.token || "");
      if (!_auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      if (!hasRole(_auth, 'admin') && !hasRole(_auth, 'manager')) return jsonResponse_({ ok: false, error: "Admin access required." });
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Onboarding_Submissions");
      if (!sheet) return jsonResponse_({ ok: true, applications: [] });
      var data = sheet.getDataRange().getValues();
      var headers = data[0];
      var wTypeIdx = headers.indexOf('worker_type');
      
      var apps = [];
      for (var i = 1; i < data.length; i++) {
        if (!data[i][1]) continue;
        var allI9Status = getEmployeeI9StatusForUsername_(data[i][1]);
        apps.push({
          username: data[i][1],
          full_name: data[i][2],
          phone: data[i][3],
          info_submitted_at: data[i][0],
          approved_at: data[i][10],
          info_done: !!data[i][0],
          i9_done: allI9Status.done,
          contract_done: !!data[i][7],
          status: data[i][11],
          worker_type: wTypeIdx > -1 ? data[i][wTypeIdx] : '1099_contractor'
        });
      }
      return jsonResponse_({ ok: true, applications: apps.reverse() });
    }
    
    if (e && e.parameter && e.parameter.action === 'onboarding_get_documents') {
      var _auth = validateToken(e.parameter.token || "");
      if (!_auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      if (!hasRole(_auth, 'admin') && !hasRole(_auth, 'manager')) return jsonResponse_({ ok: false, error: "Admin access required." });
      var username = e.parameter.username;
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Onboarding_Submissions");
      if (!sheet) return jsonResponse_({ ok: false, error: "Not found" });
      var data = sheet.getDataRange().getValues();
      var headers = data[0];
      var wTypeIdx = headers.indexOf('worker_type');
      var w4Idx = headers.indexOf('w4_url');
      var i9Status = getEmployeeI9StatusForUsername_(username);

      for (var i = 1; i < data.length; i++) {
        if (data[i][1] === username) {
          return jsonResponse_({
            ok: true,
            full_name: data[i][2], phone: data[i][3], tax_type: data[i][4], tax_id_last4: data[i][5], 
            w9_signed_url: data[i][6],
            i9_signed_url: i9Status.i9_pdf_url || null,
            w4_signed_url: w4Idx > -1 ? data[i][w4Idx] : null,
            worker_type: wTypeIdx > -1 ? data[i][wTypeIdx] : '1099_contractor',
            contract_signed_at: data[i][7], contract_signed_name: data[i][8],
            dob: data[i][13], address_line1: data[i][14], address_city: data[i][15], address_state: data[i][16], address_zip: data[i][17],
            emergency_name: data[i][18], emergency_phone: data[i][19]
          });
        }
      }
      return jsonResponse_({ ok: false, error: "Not found" });
    }
    
    if (e && e.parameter && e.parameter.action === 'onboarding_get_context') {
      const CONTRACT_HTML_TEMPLATE = `INDEPENDENT CONTRACTOR AGREEMENT
  Mission Custom Pool Solutions (MCPS) · San Antonio, TX · Effective: {{date}}

  SERVICES: Contractor agrees to perform residential pool maintenance including chemical testing, dosing, cleaning, and customer communication as assigned.

  COMPENSATION: \${{pay_rate}} per pool stop. Invoices submitted weekly. Payment issued within 5 business days.

  DO'S: Maintain professional appearance. Arrive on schedule. Report issues immediately. Protect customer property. Follow MCPS chemical safety protocols.

  DON'TS: Do not share customer addresses, routes, or pricing with anyone. Do not enter side agreements with MCPS clients. Do not handle chemicals outside training guidelines.

  NON-DISCLOSURE: Customer list, route data, chemical pricing, and business systems are confidential and may not be disclosed during or after engagement.

  CLASSIFICATION: Contractor is an independent contractor, not an employee. No benefits provided. Contractor is responsible for own taxes. MCPS will issue Form 1099-NEC for payments >= $600/year.

  TERMINATION: Either party may terminate with 14 days written notice.

  By signing below, Contractor confirms they have read, understood, and agreed to this agreement.`;
  
      const EMPLOYMENT_HTML_TEMPLATE = `EMPLOYMENT AGREEMENT
  Mission Custom Pool Solutions (MCPS) · San Antonio, TX · Effective: {{date}}

  SERVICES: Employee agrees to perform residential pool maintenance as a W-2 employee, under the direction and supervision of MCPS management.

  COMPENSATION: \${{pay_rate}} hourly or per pool stop as defined. Paid on standard payroll schedule.

  EMPLOYEE DUTIES: Adhere strictly to company schedules, protocols, and safety guidelines. Wear provided uniform.

  AT-WILL EMPLOYMENT: This agreement constitutes at-will employment. Either party can terminate employment at any time.

  By signing below, Employee confirms they have read, understood, and agreed to this agreement.`;
      
      const auth = validateToken(e.parameter.token || "");
      var payRate = auth.user && auth.user.pay_rate ? auth.user.pay_rate : (auth.pay_rate || "___");
      var workerType = auth.user && auth.user.worker_type ? auth.user.worker_type : (auth.worker_type || "1099_contractor");
      
      const dt = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      var isW2 = workerType === 'w2_employee';
      var textHTML = isW2 ? EMPLOYMENT_HTML_TEMPLATE : CONTRACT_HTML_TEMPLATE;

      return jsonResponse_({ 
        ok: true, 
        pay_rate: payRate, 
        worker_type: workerType,
        contract_html: textHTML.replace('{{pay_rate}}', payRate || '___').replace('{{date}}', dt) 
      });
    }

    if (e && e.parameter && e.parameter.action === 'get_internal_notes') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const sheet = ss.getSheetByName('Chemical_Usage_Log');
      if (!sheet) return jsonResponse_({ ok: true, notes: [] });
      const data = sheet.getDataRange().getDisplayValues();
      if (data.length < 2) return jsonResponse_({ ok: true, notes: [] });
      const headers = data[0].map(h => String(h || '').trim());
      const poolColIdx = headers.indexOf('pool_id');
      const techColIdx = headers.indexOf('Technician');
      const notesColIdx = headers.indexOf('Internal Notes');
      const tsColIdx = 0;
      const notes = [];
      for (let i = data.length - 1; i >= 1; i--) {
        const noteData = String(data[i][notesColIdx] || '').trim();
        if (noteData) {
          notes.push({ date: data[i][tsColIdx], pool_id: data[i][poolColIdx] || 'Unknown Pool', tech: data[i][techColIdx] || 'Unknown', note: noteData });
        }
        if (notes.length >= 50) break;
      }
      return jsonResponse_({ ok: true, notes: notes });
    }

    if (e && e.parameter && e.parameter.action === 'get_unassigned') {
      const data = getUnassignedPools(e.parameter.token || "");
      return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
    }

    if (e && e.parameter && e.parameter.action === 'get_gtc_pools') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error || "Unauthorized" });
      return jsonResponse_(handleGetGtcPools_());
    }

    if (e && e.parameter && e.parameter.action === 'get_modules') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error || "Unauthorized" });
      const userObj = auth.user || {};
      const rolesArr = Array.isArray(userObj.roles) ? userObj.roles : Array.isArray(auth.roles) ? auth.roles : String(userObj.roles || auth.roles || '').split(',').map(s => s.trim()).filter(Boolean);
      const session = { username: userObj.username || auth.username || '', roles: rolesArr.join(',') };
      return jsonResponse_(trGetModules(e.parameter, session));
    }

    if (e && e.parameter && e.parameter.action === 'get_training_progress') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error || "Unauthorized" });
      const userObj = auth.user || {};
      const rolesArr = Array.isArray(userObj.roles) ? userObj.roles : Array.isArray(auth.roles) ? auth.roles : String(userObj.roles || auth.roles || '').split(',').map(s => s.trim()).filter(Boolean);
      const session = { username: userObj.username || auth.username || '', roles: rolesArr.join(',') };
      return jsonResponse_(trGetTrainingProgress(e.parameter, session));
    }

    if (e && e.parameter && e.parameter.action === 'get_job_completions') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return jsonResponse_({ ok: false, error: "Admin access required." });
      try {
        const dateFilter = e.parameter.date || Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');
        const routesSs = SpreadsheetApp.openById('1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM');
        const jcSheet = routesSs.getSheetByName('Job_Completions');
        if (!jcSheet || jcSheet.getLastRow() < 2) return jsonResponse_({ ok: true, completions: [], date: dateFilter });
        const data = jcSheet.getDataRange().getValues();
        const hdrs = data[0].map(function(h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); });
        const iVisitId = hdrs.indexOf('visit_id');
        const iPoolId  = hdrs.indexOf('pool_id');
        const iTech    = hdrs.indexOf('technician');
        const iCompAt  = hdrs.indexOf('completed_at');
        const iDate    = hdrs.indexOf('date');
        const iDow     = hdrs.indexOf('day_of_week');
        const tz = 'America/Chicago';
        const completions = [];
        for (var i = 1; i < data.length; i++) {
          var rowDate = iDate >= 0 ? String(data[i][iDate] || '').trim() : '';
          if (!rowDate && iCompAt >= 0 && data[i][iCompAt]) {
            try { rowDate = Utilities.formatDate(new Date(data[i][iCompAt]), tz, 'yyyy-MM-dd'); } catch(e2) {}
          }
          if (rowDate !== dateFilter) continue;
          completions.push({
            visit_id    : iVisitId >= 0 ? String(data[i][iVisitId] || '') : '',
            pool_id     : iPoolId  >= 0 ? String(data[i][iPoolId]  || '') : '',
            technician  : iTech    >= 0 ? String(data[i][iTech]    || '') : '',
            completed_at: iCompAt  >= 0 ? String(data[i][iCompAt]  || '') : '',
            day_of_week : iDow     >= 0 ? String(data[i][iDow]     || '') : '',
          });
        }
        return jsonResponse_({ ok: true, completions, date: dateFilter });
      } catch(err) {
        return jsonResponse_({ ok: false, error: err.message });
      }
    }

    if (e && e.parameter && e.parameter.action === 'route_data') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      return jsonResponse_(getRouteData(e.parameter.token || "", e.parameter.operator || "", e.parameter.week_start || ""));
    }

    if (e && e.parameter && e.parameter.action === 'calendar_data') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      const m = parseInt(e.parameter.month) || new Date().getMonth() + 1;
      const y = parseInt(e.parameter.year) || new Date().getFullYear();
      return jsonResponse_(getCalendarData(e.parameter.token || "", m, y, e.parameter.operator || ""));
    }

    if (e && e.parameter && e.parameter.action === 'margins_data') {
      return jsonResponse_(getMarginsDashboardData(e.parameter.labor || "false"));
    }

    if (e && e.parameter && e.parameter.action === 'map_data') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      try {
        const ss = SpreadsheetApp.openById("1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM");
        const sheet = ss.getSheetByName("Routes");
        if (!sheet) throw new Error("Routes sheet not found");
        const data = sheet.getDataRange().getValues();
        if (data.length < 2) return jsonResponse_({ ok: true, data: [] });
        const headers = data[0].map(h => String(h).trim().toLowerCase().replace(/ /g, "_"));
        const results = [];
        for (let i = 1; i < data.length; i++) {
          if (!data[i][0]) continue;
          const obj = {};
          headers.forEach((h, j) => { obj[h] = data[i][j]; });
          results.push(obj);
        }
        return jsonResponse_({ ok: true, data: results });
      } catch (err) {
        return jsonResponse_({ ok: false, error: String(err) });
      }
    }

    if (e && e.parameter && e.parameter.action === 'form_metadata') {
      try { return jsonResponse_({ ok: true, data: getFormMetadata() }); } catch (err) { return jsonResponse_({ ok: false, error: String(err) }); }
    }

    if (e && e.parameter && e.parameter.action === 'get_inventory') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      return jsonResponse_(getInventoryForPortal_());
    }

    if (e && e.parameter && e.parameter.action === 'get_purchase_log') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      return jsonResponse_({ ok: true, data: getPurchaseLog(100) });
    }

    if (e && e.parameter && e.parameter.action === 'get_pending_skus') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      return jsonResponse_({ ok: true, data: getPendingSkus() });
    }

    if (e && e.parameter && e.parameter.action === 'distance') {
      const dest = (e.parameter.dest || '').trim();
      if (!dest) return jsonResponse_({ ok: false, error: 'Missing dest' });
      try {
        const travel = computeTravelWithCache_(dest);
        return jsonResponse_({ ok: true, travel });
      } catch (err) { return jsonResponse_({ ok: false, error: String(err) }); }
    }

    const normalizedSalesGetActions = {
      setup_normalized_sales_sheets: true,
      migrate_quotes_normalized: true,
      get_clients: true,
      get_client_locations: true,
      get_client_proposals: true,
      get_location_proposals: true,
      get_proposal: true,
      get_latest_client_proposal: true,
      get_proposals_by_status: true,
      get_service_agreements: true,
      get_client_service_agreements: true,
      get_location_service_agreements: true,
      get_service_agreement: true,
      get_service_accounts: true,
      get_client_service_accounts: true,
      get_location_service_accounts: true,
      get_startup_companies: true
    };
    if (e && e.parameter && normalizedSalesGetActions[e.parameter.action]) {
      const auth = validateToken(e.parameter.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      if ((e.parameter.action === 'setup_normalized_sales_sheets' || e.parameter.action === 'migrate_quotes_normalized') &&
          !hasRole(auth, 'admin') && !hasRole(auth, 'manager')) {
        return jsonResponse_({ ok: false, error: 'Admin access required.' });
      }
      return jsonResponse_(handleNormalizedSalesAction_(e.parameter));
    }

    // ── CRM Data Retrieval ──
    if (e.parameter.action === 'get_crm_data') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      return jsonResponse_(handleGetCRMData());
    }

    if (e && e.parameter && e.parameter.action === 'get_startup_checklists') {
      return handleGetStartupChecklists_(e.parameter);
    }

    if (e && e.parameter && e.parameter.test === 'true') {
      return jsonResponse_({ ok: true, message: "MCPS webhook receiver is live" });
    }

    if (e && e.parameter && e.parameter.action === 'get_weekly_goal') {
      return jsonResponse_(handleGetWeeklyGoal_());
    }

    if (e && e.parameter && e.parameter.action === 'scheduled_visits') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      return jsonResponse_(getScheduledVisitsForWeek(
        e.parameter.token || "",
        e.parameter.week_start || "",
        e.parameter.operator || ""
      ));
    }

    if (e && e.parameter && e.parameter.action === 'get_invoice_alerts') {
      const auth = validateToken(e.parameter.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return jsonResponse_({ ok: false, error: 'Not authorized' });
      return jsonResponse_(handleGetInvoiceAlerts_());
    }

    if (e && e.parameter && e.parameter.action === 'get_issue_alerts') {
      const auth = validateToken(e.parameter.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(handleGetIssueAlerts_(auth.user || auth));
    }

    if (e && e.parameter && e.parameter.action === 'get_alert_history') {
      const auth = validateToken(e.parameter.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(handleGetAlertHistory_(auth.user || auth));
    }

    if (e && e.parameter && e.parameter.action === 'get_visit_history_v2') {
      const auth = validateToken(e.parameter.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager'))
        return jsonResponse_({ ok: false, error: 'Not authorized' });
      try {
        const ss = SpreadsheetApp.getActiveSpreadsheet();
        const svSheet = ss.getSheetByName('Scheduled_Visits');
        if (!svSheet || svSheet.getLastRow() < 2)
          return jsonResponse_({ ok: true, visits: [] });

        const svData = svSheet.getDataRange().getValues();
        const svH = svData[0].map(h => String(h || '').trim().toLowerCase());
        const iVid  = svH.indexOf('visit_id');
        const iPid  = svH.indexOf('pool_id');
        const iTech = svH.indexOf('technician');
        const iDate = svH.indexOf('date');
        const iSvc  = svH.indexOf('service_type');
        const iStat = svH.indexOf('status');
        const iRef  = svH.indexOf('chem_log_ref');

        // ── Date range filter ──────────────────────────────────────────────
        const drParam = e.parameter.date_range || '';
        let filterStart = null, filterEnd = null;
        if (drParam === 'last_7' || drParam === 'last_30' || drParam === 'last_90') {
          const days = drParam === 'last_7' ? 7 : drParam === 'last_30' ? 30 : 90;
          filterStart = new Date();
          filterStart.setDate(filterStart.getDate() - days);
          filterStart.setHours(0, 0, 0, 0);
        } else if (e.parameter.start) {
          filterStart = new Date(e.parameter.start + 'T00:00:00');
        }
        if (e.parameter.end) {
          filterEnd = new Date(e.parameter.end + 'T23:59:59');
        }

        const filterPool  = (e.parameter.pool_id     || '').trim().toUpperCase();
        const filterTech2 = (e.parameter.technician  || '').trim().toLowerCase();
        const filterSvc   = (e.parameter.service_type|| '').trim().toLowerCase();

        // ── Build customer name map from CRM ──────────────────────────────
        const nameMap = {};
        try {
          const crmSs = SpreadsheetApp.openById('1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E');
          const qSheet = crmSs.getSheetByName('Quotes');
          if (qSheet && qSheet.getLastRow() >= 2) {
            const qData = qSheet.getDataRange().getValues();
            const qH = qData[0].map(h => String(h || '').trim().toLowerCase());
            const qPid = qH.indexOf('pool_id');
            const qFn  = qH.indexOf('first_name');
            const qLn  = qH.indexOf('last_name');
            if (qPid !== -1) {
              for (let qi = 1; qi < qData.length; qi++) {
                const pid = String(qData[qi][qPid] || '').trim();
                if (pid && !nameMap[pid]) {
                  const fn = qFn >= 0 ? String(qData[qi][qFn] || '').trim() : '';
                  const ln = qLn >= 0 ? String(qData[qi][qLn] || '').trim() : '';
                  nameMap[pid] = (fn + ' ' + ln).trim();
                }
              }
            }
          }
        } catch (crmErr) { Logger.log('get_visit_history_v2 CRM lookup: ' + crmErr); }

        // ── Collect and filter rows ───────────────────────────────────────
        const visits = [];
        for (let ri = 1; ri < svData.length; ri++) {
          const row = svData[ri];
          const pid     = String(row[iPid]  || '').trim();
          const tech    = String(row[iTech] || '').trim();
          const dateRaw = row[iDate];
          const svc     = String(row[iSvc]  || '').trim();
          const stat    = String(row[iStat] || '').trim();
          const ref     = row[iRef];

          if (!pid && !dateRaw) continue;

          const dateObj = dateRaw ? new Date(dateRaw) : null;

          if (filterStart && dateObj && dateObj < filterStart) continue;
          if (filterEnd   && dateObj && dateObj > filterEnd)   continue;
          if (filterPool  && pid.toUpperCase() !== filterPool) continue;
          if (filterTech2 && tech.toLowerCase() !== filterTech2) continue;
          if (filterSvc   && svc.toLowerCase().indexOf(filterSvc) === -1) continue;

          visits.push({
            visit_id      : iVid  >= 0 ? String(row[iVid] || '') : '',
            pool_id       : pid,
            customer_name : nameMap[pid] || '',
            technician    : tech,
            date          : dateObj ? dateObj.toISOString() : String(dateRaw || ''),
            service_type  : svc,
            status        : stat,
            chem_log_ref  : ref !== '' && ref !== null && ref !== undefined ? Number(ref) : null
          });
        }

        // Sort descending by date
        visits.sort(function(a, b) {
          return new Date(b.date) - new Date(a.date);
        });

        return jsonResponse_({ ok: true, visits: visits });
      } catch (v2Err) {
        Logger.log('get_visit_history_v2 error: ' + v2Err);
        return jsonResponse_({ ok: false, error: String(v2Err) });
      }
    }

    if (e && e.parameter && e.parameter.action === 'get_payroll_config') {
      const auth = validateToken(e.parameter.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(getPayrollConfig_());
    }

    if (e && e.parameter && e.parameter.action === 'get_payroll_log') {
      const auth = validateToken(e.parameter.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) return jsonResponse_({ ok: false, error: 'Admin access required.' });
      return jsonResponse_(getPayrollLog_(e.parameter.year || ''));
    }

    if (e && e.parameter && e.parameter.action === 'get_visit_history') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });

      const isAdminOrManager = hasRole(auth, 'admin') || hasRole(auth, 'manager');
      const filterTech = isAdminOrManager
        ? (e.parameter.operator || null)
        : (auth.user && auth.user.name ? auth.user.name : auth.name || auth.username || null);

      const payRate = (auth.user && auth.user.pay_rate) ? auth.user.pay_rate : (auth.pay_rate || "");

      // Cache rows+pay_rates by operator filter; payRate comes from token (no extra sheet read)
      const vhCache    = CacheService.getScriptCache();
      const vhCacheKey = 'visit_hist:' + (filterTech ? filterTech.toLowerCase() : 'all');
      const vhCached   = vhCache.get(vhCacheKey);
      if (vhCached) {
        try {
          const hit = JSON.parse(vhCached);
          return jsonResponse_({ ok: true, rows: hit.rows, pay_rate: payRate, pay_rates: hit.pay_rates });
        } catch(e) {}
      }

      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const sheet = ss.getSheetByName("Usage_Priced");
      if (!sheet || sheet.getLastRow() < 2)
        return jsonResponse_({ ok: true, rows: [], pay_rate: payRate, pay_rates: {} });

      const data = sheet.getDataRange().getDisplayValues();
      const headers = data[0].map(function(h) { return String(h || "").trim(); });
      const iTs   = headers.indexOf("Timestamp");
      const iTech = headers.indexOf("Technician");
      const iPool = headers.indexOf("pool_id");
      const iWk   = headers.indexOf("WeekKey");
      const iWs   = headers.indexOf("Week Start");
      const iCost = headers.indexOf("Total Visit Chem Cost (Snapshot)");

      // Columns to skip from the detail map (already top-level or internal)
      var skipDetail = { 'Timestamp':1, 'Technician':1, 'pool_id':1, 'WeekKey':1,
                         'Week Start':1, 'Visit # in Week':1,
                         'Total Visit Chem Cost (Snapshot)':1, 'Email Address':1 };

      // Build client name map: pool_id → { name, address, service }
      var clientMap = {};
      try {
        var crmSs = SpreadsheetApp.openById('1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E');
        var qSheet = crmSs.getSheetByName('Quotes');
        if (qSheet && qSheet.getLastRow() >= 2) {
          var qData = qSheet.getDataRange().getValues();
          var qH = qData[0].map(function(h){ return String(h||'').trim().toLowerCase(); });
          var qPid = qH.indexOf('pool_id'), qFn = qH.indexOf('first_name'),
              qLn  = qH.indexOf('last_name'), qAddr = qH.indexOf('address'),
              qSvc = qH.indexOf('service');
          if (qPid !== -1) {
            for (var q = 1; q < qData.length; q++) {
              var cpid = String(qData[q][qPid]||'').trim();
              if (cpid && !clientMap[cpid]) {
                clientMap[cpid] = {
                  name   : ((qFn >= 0 ? String(qData[q][qFn]||'') : '') + ' ' +
                            (qLn >= 0 ? String(qData[q][qLn]||'') : '')).trim(),
                  address: qAddr >= 0 ? String(qData[q][qAddr]||'').trim() : '',
                  service: qSvc  >= 0 ? String(qData[q][qSvc] ||'').trim() : ''
                };
              }
            }
          }
        }
      } catch(ce) { Logger.log('clientMap error: ' + ce); }

      var rows = [];
      for (var i = data.length - 1; i >= 1; i--) {
        var tech = String(data[i][iTech] || "").trim();
        if (filterTech && tech.toLowerCase() !== filterTech.toLowerCase()) continue;

        var poolId = iPool >= 0 ? data[i][iPool] : "";
        var client = clientMap[poolId] || {};

        // Build detail: every non-empty column that isn't in skipDetail
        var detail = {};
        for (var c = 0; c < headers.length; c++) {
          var hdr = headers[c];
          if (!hdr || skipDetail[hdr]) continue;
          var val = data[i][c];
          if (val !== '' && val !== null && val !== undefined) detail[hdr] = val;
        }

        rows.push({
          timestamp      : iTs   >= 0 ? data[i][iTs]  : "",
          technician     : tech,
          pool_id        : poolId,
          week_key       : iWk   >= 0 ? data[i][iWk]  : "",
          week_start     : iWs   >= 0 ? data[i][iWs]  : "",
          chem_cost      : iCost >= 0 ? data[i][iCost]: "",
          client_name    : client.name    || '',
          client_address : client.address || '',
          client_service : client.service || '',
          detail         : detail
        });
        if (rows.length >= 500) break;
      }

      // Build pay_rates map: { "Display Name": rate }
      var pay_rates = {};
      try {
        var authSs = SpreadsheetApp.openById(AUTH_SHEET_ID);
        var usersSheet = authSs.getSheetByName('Users');
        if (usersSheet && usersSheet.getLastRow() >= 2) {
          var uData = usersSheet.getDataRange().getValues();
          var uHdrs = uData[0].map(function(h){ return String(h||'').trim(); });
          var nameIdx = uHdrs.indexOf('name'), rateIdx = uHdrs.indexOf('pay_rate');
          if (nameIdx !== -1 && rateIdx !== -1) {
            for (var u = 1; u < uData.length; u++) {
              var uName = String(uData[u][nameIdx]||'').trim();
              var uRate = uData[u][rateIdx];
              if (uName && uRate !== '' && uRate !== null)
                pay_rates[uName] = parseFloat(uRate) || 0;
            }
          }
        }
      } catch(err) { Logger.log('pay_rates lookup error: ' + err); }

      try { vhCache.put(vhCacheKey, JSON.stringify({ rows: rows, pay_rates: pay_rates }), 300); } catch(e) {}
      return jsonResponse_({ ok: true, rows: rows, pay_rate: payRate, pay_rates: pay_rates });
    }

    if (e && e.parameter && e.parameter.action === 'get_unmatched_submissions') {
      const auth = validateToken(e.parameter.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager'))
        return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_({ ok: true, rows: getUnmatchedSubmissions() });
    }

    if (e && e.parameter && e.parameter.action === 'get_pools_for_matching') {
      const auth = validateToken(e.parameter.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager'))
        return jsonResponse_({ ok: false, error: 'Unauthorized' });
      try {
        const crmSs = SpreadsheetApp.openById('1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E');
        const qSheet = crmSs.getSheetByName('Quotes');
        const pools = [];
        if (qSheet && qSheet.getLastRow() >= 2) {
          const rows = qSheet.getDataRange().getValues();
          const h = rows[0];
          const iPid  = h.indexOf('pool_id');
          const iStat = h.indexOf('status');
          const iLast = h.indexOf('last_name');
          const iSvc  = h.indexOf('service');
          const iAdr  = h.indexOf('address');
          rows.slice(1).forEach(function(r) {
            const pid  = String(r[iPid]  || '').trim();
            const stat = String(r[iStat] || '').trim().toUpperCase();
            if (!pid || stat !== 'ACTIVE_CUSTOMER') return;
            const label = [r[iLast], r[iSvc], r[iAdr], pid]
              .map(function(v) { return String(v || '').trim(); }).join(' — ');
            pools.push({ poolId: pid, label: label });
          });
        }
        pools.sort(function(a, b) { return a.label.localeCompare(b.label); });
        return jsonResponse_({ ok: true, pools: pools });
      } catch(err) {
        return jsonResponse_({ ok: false, error: String(err) });
      }
    }

    return HtmlService.createHtmlOutputFromFile("FormUI")
      .setTitle("MCPS Pool Log")
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1.0, user-scalable=0');

  } catch (err) {
    Logger.log("doGet error: " + err);
    return jsonResponse_({ ok: false, error: String(err) });
  }
}



// ─── Shared JSON response helper ─────────────────────────────────────────────
function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── Build description -> display_name map from SKU_Map descriptions ──────────
// SKU_Map has: sku | display_name | notes
// We match QBO description text against the notes column (which has Heritage desc)
function buildDescriptionMap_() {
  const ss    = SpreadsheetApp.openById(PL_INVENTORY_SS_ID);
  const sheet = ss.getSheetByName(PL_SKU_MAP);
  if (!sheet || sheet.getLastRow() < 2) return {};

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  const map  = {};

  data.forEach(function(r) {
    const displayName = String(r[1] || "").trim();
    const notes       = String(r[2] || "").trim().toUpperCase();
    if (displayName && notes) map[notes] = displayName;
  });

  return map;
}

// ─── Fuzzy description match ──────────────────────────────────────────────────
// Checks if any key word sequence from the SKU_Map notes appears in the QBO desc
function matchDescription_(description, descMap) {
  const desc = description.toUpperCase();

  // Direct match first
  if (descMap[desc]) return descMap[desc];

  // Partial match — check if desc contains any known keyword cluster
  const keywords = {
    "MURIATIC ACID"        : "Muriatic Acid",
    "LIQUID CHLORINE"      : "Liquid Chlorine",
    "SCALETEC"             : "ScaleTec (Calcium Remover)",
    "ALGATEC"              : "Algaecide",
    "STARTUP TEC"          : "Startup-Tec",
    "CALCIUM HARDNESS"     : "Calcium Hardness Increaser",
    "TOTAL ALKALINITY"     : "Alkalinity Increaser",
    "ALKALINITY INCREASER" : "Alkalinity Increaser",
    "CYANURIC ACID"        : "Cyanuric Acid (Stabilizer)",
    'CHLORINATING TABLETS' : 'Chlorine Tablets (3")',
    "SCALE-OFF"            : "Scale-Off Tile Cleaner",
    "TILE CLEANER"         : "Scale-Off Tile Cleaner"
  };

  for (var kw in keywords) {
    if (desc.includes(kw)) return keywords[kw];
  }

  return ""; // unmapped — will show as warning in Orders tab
}

function processQBOBillPayload_(payload) {
  const invoiceId   = String(payload.invoice_id  || payload.bill_id  || payload.id   || "").trim();
  const invoiceDate = String(payload.invoice_date || payload.txn_date || payload.date || "").trim();
  const vendor      = String(payload.vendor       || payload.vendor_name              || "").trim();

  const vendorLower = vendor.toLowerCase();
  if (vendorLower && !vendorLower.includes("heritage")) {
    Logger.log("Skipping non-Heritage vendor: " + vendor);
    return { skipped: true, reason: "Non-Heritage vendor: " + vendor };
  }

  const lines = Array.isArray(payload.line_items)
    ? payload.line_items
    : (payload.line_item ? [payload.line_item] : [payload]);

  const skuMap  = buildSkuMap_();
  const descMap = buildDescriptionMap_(); // new — description -> display_name
  const items   = [];

  lines.forEach(function(line) {
    const sku         = String(line.sku || line.item_id || line.item || "").trim().toUpperCase();
    const description = String(line.description || line.desc || "").trim().split("\n")[0];
    const uom         = String(line.uom  || line.unit || "EA").trim();
    const extended    = Number(line.amount || line.total || 0);

    // Skip blank, subtotal, and tax lines
    if (!description) return;
    if (description.toLowerCase().includes("sales tax"))  return;
    if (description.toLowerCase().includes("sub-total"))  return;

    // Resolve display_name: SKU first, then description match
    let displayName = skuMap[sku] || "";
    if (!displayName) displayName = matchDescription_(description, descMap);

    items.push({
      invoice_id     : invoiceId,
      invoice_date   : invoiceDate,
      sku            : sku,
      description    : description,
      uom            : uom,
      qty_ordered    : 0,   // QBO AccountBased bills don't carry qty
      qty_shipped    : 0,   // will be filled in manually or via Heritage API later
      price_per_uom  : 0,
      extended_amount: extended,
      display_name   : displayName,
      applied        : "",
      applied_at     : ""
    });
  });

  if (!items.length) return { written: 0, skipped: 0, reason: "No valid line items" };

  return writeToPurchaseLog(items);
}

// ─── Manual test with fake Heritage invoice payload ───────────────────────────
function TEST_webhookWithFakeInvoice() {
  const fakePayload = {
    secret      : WEBHOOK_SECRET,
    invoice_id  : "0025471985-001",
    invoice_date: "2026-03-10",
    vendor      : "Heritage Pool Supply",
    line_items  : [
      { sku: "HAS15041",   description: "HASA Muriatic Acid",          uom: "EA",  qty_shipped: 2, unit_price: 4.99,  amount: 9.98   },
      { sku: "MCGEC70064", description: "McGrayel Startup Tec",        uom: "EA",  qty_shipped: 5, unit_price: 41.05, amount: 205.25 },
      { sku: "MCGEC20064", description: "McGrayel ScaleTec Plus",      uom: "EA",  qty_shipped: 1, unit_price: 45.67, amount: 45.67  },
      { sku: "MCGEC10064", description: "McGrayel Algatec",            uom: "EA",  qty_shipped: 1, unit_price: 35.09, amount: 35.09  },
      { sku: "PBZ88674",   description: "Pool Breeze Calcium Hard",    uom: "BAG", qty_shipped: 5, unit_price: 12.47, amount: 62.35  },
      { sku: "PBZ88673",   description: "Pool Breeze Total Alkalinity", uom: "BAG", qty_shipped: 5, unit_price: 15.72, amount: 78.60 },
      { sku: "HAS01841CS", description: "HASA Liquid Chlorine 12.5%",  uom: "CS",  qty_shipped: 5, unit_price: 18.94, amount: 94.70  }
    ]
  };

  const result = processQBOBillPayload_(fakePayload);
  Logger.log("Test result: " + JSON.stringify(result));
  SpreadsheetApp.getActiveSpreadsheet().toast("Test complete — check Purchase_Log", "MCPS");
}

function testDedup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Chemical_Usage_Log');
  const lastRow = sheet.getLastRow();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const poolColIdx = headers.indexOf('pool_id');
  const techColIdx = headers.indexOf('Technician');
  const lastData = sheet.getRange(lastRow, 1, 1, sheet.getLastColumn()).getValues()[0];
  
  Logger.log('Last row pool_id: ' + lastData[poolColIdx]);
  Logger.log('Last row technician: ' + lastData[techColIdx]);
  Logger.log('Last row timestamp: ' + lastData[0]);
  Logger.log('Age in ms: ' + (new Date() - new Date(lastData[0])));
}

/**
 * Helper to fetch history/context for a specific pool
 * This powers the popups and pre-filling in the service log
 */
function getPoolContext_(poolId) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Chemical_Usage_Log');
    if (!sheet) return { found: false };

    const data = sheet.getDisplayValues();
    if (data.length < 2) return { found: false };

    const headers = data[0].map(h => String(h || '').trim());
    const poolColIdx = headers.indexOf('pool_id');
    const sizeColIdx = headers.indexOf('Pool Size');
    const matColIdx = headers.indexOf('Pool Material');
    const tabletColIdx = headers.indexOf('Tablet Level');
    const clColIdx = headers.indexOf('Chlorine (Cl)');
    const phColIdx = headers.indexOf('pH');
    const taColIdx = headers.indexOf('Total Alkalinity (TA)');
    const notesColIdx = headers.indexOf('Internal Notes'); // Fetches the tech-only notes
    if (poolColIdx === -1) return { found: false };
    
    const requestedPool = String(poolId || '').trim();
    const requestedId = extractPoolId_(requestedPool);
    let lastSize = "";
    let lastMat = "";
    let lastTablet = "";
    let lastInternalNote = "";
    let visitCount = 0;
    const recentRows = [];

    // Loop backwards through your logs to find the most recent info for this pool
    for (let i = data.length - 1; i >= 1; i--) {
      const rowPool = String(data[i][poolColIdx] || '').trim();
      if (rowPool === requestedPool || extractPoolId_(rowPool) === requestedId) {
        visitCount++;
        if (recentRows.length < 5) recentRows.push(data[i]);
        
        // Grab the latest internal note if we haven't found one yet
        if (!lastInternalNote && notesColIdx !== -1 && data[i][notesColIdx]) {
          lastInternalNote = data[i][notesColIdx];
        }
        
        // Grab the latest size/material settings
        if (!lastSize && sizeColIdx !== -1) lastSize = data[i][sizeColIdx];
        if (!lastMat && matColIdx !== -1) lastMat = data[i][matColIdx];
        if (!lastTablet && tabletColIdx !== -1) lastTablet = data[i][tabletColIdx];
      }
    }

    if (!visitCount) return { found: false };

    function avg(colIdx) {
      if (colIdx === -1) return null;
      const nums = recentRows.map(r => parseFloat(r[colIdx])).filter(n => !isNaN(n) && n >= 0);
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    }

    const trends = [];
    const phAvg = avg(phColIdx);
    if (phAvg !== null) {
      if (phAvg > 7.65) trends.push('pH runs high (avg ' + phAvg.toFixed(1) + ')');
      else if (phAvg < 7.15) trends.push('pH runs low (avg ' + phAvg.toFixed(1) + ')');
      else trends.push('pH usually in range (avg ' + phAvg.toFixed(1) + ')');
    }
    const clAvg = avg(clColIdx);
    if (clAvg !== null) {
      if (clAvg > 4) trends.push('chlorine tends to run high (avg ' + clAvg.toFixed(1) + ' ppm)');
      else if (clAvg < 1) trends.push('chlorine tends to run low (avg ' + clAvg.toFixed(1) + ' ppm)');
    }
    const taAvg = avg(taColIdx);
    if (taAvg !== null) {
      if (taAvg > 120) trends.push('TA runs high (avg ' + Math.round(taAvg) + ' ppm)');
      else if (taAvg < 80) trends.push('TA runs low (avg ' + Math.round(taAvg) + ' ppm)');
    }

    return {
      found: true,
      last_size: lastSize,
      last_material: lastMat,
      last_tablet: lastTablet,
      internal_notes: lastInternalNote, // This triggers the yellow banner
      visit_count: visitCount,
      trends: trends
    };
  } catch (err) {
    Logger.log("getPoolContext error: " + err);
    return { found: false, error: String(err) };
  }
}


// ─── Invoice Action Alerts ────────────────────────────────────────────────────
/**
 * Returns three lists for the Home page alert banners:
 *   first_invoice   — ACTIVE_CUSTOMER pools with billing_start set but payment_log empty
 *   startup_invoice — Pool Startup pools with >= 3 visits and no startup invoice sent
 *   startup_convert — Pool Startup pools with exactly 3 visits, not yet converted
 */
function handleGetInvoiceAlerts_() {
  const CRM_SS_ID = "1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E";
  try {
    const crmSs = SpreadsheetApp.openById(CRM_SS_ID);
    const quotesSheet = crmSs.getSheetByName("Quotes");
    if (!quotesSheet || quotesSheet.getLastRow() < 2)
      return { ok: true, first_invoice: [], startup_invoice: [], startup_convert: [] };

    const rows = quotesSheet.getDataRange().getValues();
    const rawHeaders = rows[0];
    const headers = rawHeaders.map(h => String(h || '').trim().toLowerCase().replace(/ /g, '_'));

    const iQuoteId      = headers.indexOf('quote_id');
    const iStatus       = headers.indexOf('status');
    const iService      = headers.indexOf('service');
    const iBillingStart = headers.indexOf('billing_start');
    const iPaymentLog   = headers.indexOf('payment_log');
    const iFirstName    = headers.indexOf('first_name');
    const iLastName     = headers.indexOf('last_name');
    const iAddress      = headers.indexOf('address');
    const iCity         = headers.indexOf('city');
    const iPoolId       = headers.indexOf('pool_id');

    // Build set of pool_ids for startup pools — needed to count visits
    const startupPoolIds = new Set();
    for (let i = 1; i < rows.length; i++) {
      const svc = String(rows[i][iService] || '').toLowerCase();
      if (svc.includes('pool startup')) {
        const pid = String(rows[i][iPoolId] || '').trim();
        if (pid) startupPoolIds.add(pid);
      }
    }

    // Count visits per pool from Chemical_Usage_Log (all rows = completed visits)
    const visitCounts = {};
    const lastVisitDates = {};
    if (startupPoolIds.size > 0) {
      const logSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Chemical_Usage_Log');
      if (logSheet && logSheet.getLastRow() >= 2) {
        const logData = logSheet.getDataRange().getValues();
        const logH = logData[0].map(h => String(h || '').trim());
        const pidIdx = logH.indexOf('pool_id');
        if (pidIdx !== -1) {
          for (let r = 1; r < logData.length; r++) {
            const pid = String(logData[r][pidIdx] || '').trim();
            if (startupPoolIds.has(pid)) {
              visitCounts[pid] = (visitCounts[pid] || 0) + 1;
              // Timestamp is always column 0; last row wins (already iterating forward)
              const ts = logData[r][0];
              if (ts) lastVisitDates[pid] = Utilities.formatDate(new Date(ts), Session.getScriptTimeZone(), 'yyyy-MM-dd');
            }
          }
        }
      }
    }

    const firstInvoice   = [];
    const startupInvoice = [];
    const startupConvert = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const quoteId = String(row[iQuoteId] || '').trim();
      if (!quoteId) continue;

      const status  = String(row[iStatus]  || '').trim().toUpperCase();
      const service = String(row[iService] || '').trim().toLowerCase();
      const poolId  = iPoolId !== -1 ? String(row[iPoolId] || '').trim() : '';

      const customerName = (
        (iFirstName !== -1 ? String(row[iFirstName] || '') : '') + ' ' +
        (iLastName  !== -1 ? String(row[iLastName]  || '') : '')
      ).trim();
      const address = iAddress !== -1 ? String(row[iAddress] || '').trim() : '';
      const city    = iCity    !== -1 ? String(row[iCity]    || '').trim() : '';

      // Parse payment_log safely
      let paymentLog = [];
      try {
        const raw = row[iPaymentLog];
        if (raw && raw !== '') {
          const parsed = JSON.parse(String(raw));
          if (Array.isArray(parsed)) paymentLog = parsed;
        }
      } catch(e) { paymentLog = []; }

      const entry = { pool_id: poolId, customer_name: customerName, address: address, city: city, quote_id: quoteId };

      // First invoice: ACTIVE_CUSTOMER + billing_start set + no payments logged yet
      if (status === 'ACTIVE_CUSTOMER' && iBillingStart !== -1) {
        const billingStart = String(row[iBillingStart] || '').trim();
        if (billingStart && paymentLog.length === 0) {
          firstInvoice.push(entry);
        }
      }

      // Startup alerts
      if (service.includes('pool startup')) {
        const count = visitCounts[poolId] || 0;
        // Startup invoice not yet sent = no payment_log entry with type === "startup"
        const startupInvoiced = paymentLog.some(function(p) {
          return String(p.type || '').toLowerCase() === 'startup';
        });

        if (count >= 3 && !startupInvoiced) {
          startupInvoice.push(entry);
        }

        // Conversion prompt: exactly 3 visits, service still "Pool Startup"
        if (count === 3) {
          const lastDate = lastVisitDates[poolId] ||
            Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
          startupConvert.push(Object.assign({}, entry, { last_visit_date: lastDate }));
        }
      }
    }

    // ── First-month complete alerts ─────────────────────────────────────────
    // Pools where first_month_start is set in Routes and visit count since that date >= 4
    const firstMonthDone = [];
    try {
      const routesSs = SpreadsheetApp.openById("1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM");
      const routesSheet = routesSs.getSheetByName("Routes");
      if (routesSheet && routesSheet.getLastRow() >= 2) {
        const rData = routesSheet.getDataRange().getValues();
        const rH = rData[0].map(h => String(h || '').trim().toLowerCase().replace(/ /g, '_'));
        const rPid  = rH.indexOf('pool_id');
        const rFm   = rH.indexOf('first_month_start');
        const rName = rH.indexOf('customer_name');
        const rAddr = rH.indexOf('address');
        const rCity = rH.indexOf('city');
        if (rPid !== -1 && rFm !== -1) {
          // Count visits per pool from Chemical_Usage_Log
          const logSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Chemical_Usage_Log');
          const logVisits = {};
          if (logSheet && logSheet.getLastRow() >= 2) {
            const logData = logSheet.getDataRange().getValues();
            const lH = logData[0].map(h => String(h || '').trim());
            const lPid = lH.indexOf('pool_id');
            if (lPid !== -1) {
              logData.slice(1).forEach(function(r) {
                const pid = String(r[lPid] || '').trim();
                if (pid) logVisits[pid] = (logVisits[pid] || []).concat([r[0]]);
              });
            }
          }
          for (let r = 1; r < rData.length; r++) {
            const fmRaw = rData[r][rFm];
            if (!fmRaw) continue;
            const fmStr = fmRaw instanceof Date
              ? Utilities.formatDate(fmRaw, 'America/Chicago', 'yyyy-MM-dd')
              : String(fmRaw).trim();
            if (!fmStr) continue;
            const pid = rPid >= 0 ? String(rData[r][rPid] || '').trim() : '';
            if (!pid) continue;
            const fmDate = new Date(fmStr + 'T00:00:00');
            const visits = (logVisits[pid] || []).filter(function(ts) {
              return ts && new Date(ts) >= fmDate;
            });
            if (visits.length >= 4) {
              firstMonthDone.push({
                pool_id:       pid,
                customer_name: rName >= 0 ? String(rData[r][rName] || '') : '',
                address:       rAddr >= 0 ? String(rData[r][rAddr] || '') : '',
                city:          rCity >= 0 ? String(rData[r][rCity] || '') : '',
                visit_count:   visits.length
              });
            }
          }
        }
      }
    } catch(fmErr) { Logger.log('first_month_done error: ' + fmErr); }

    return { ok: true, first_invoice: firstInvoice, startup_invoice: startupInvoice, startup_convert: startupConvert, first_month_done: firstMonthDone };

  } catch(err) {
    Logger.log('handleGetInvoiceAlerts_ error: ' + err);
    return { ok: false, error: String(err) };
  }
}

// ─── Convert Startup Pool to Weekly Full Service ──────────────────────────────
/**
 * Updates the Quotes sheet row for quote_id:
 *   service       → "Weekly Full Service"
 *   billing_start → provided date (the 3rd visit date, ISO yyyy-MM-dd)
 * invoice_day is intentionally NOT set — first charge is one-time at 4th visit.
 */
function handleConvertToWFS_(payload) {
  const CRM_SS_ID = "1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E";
  try {
    const quoteId      = String(payload.quote_id      || '').trim();
    const billingStart = String(payload.billing_start || '').trim();
    if (!quoteId) return { ok: false, error: 'Missing quote_id' };

    const ss = SpreadsheetApp.openById(CRM_SS_ID);
    const sheet = ss.getSheetByName('Quotes');
    if (!sheet) return { ok: false, error: 'Quotes sheet not found' };

    const rows = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => String(h || '').trim().toLowerCase().replace(/ /g, '_'));
    const iQuoteId      = headers.indexOf('quote_id');
    const iService      = headers.indexOf('service');
    const iBillingStart = headers.indexOf('billing_start');

    if (iQuoteId === -1) return { ok: false, error: 'quote_id column not found in Quotes sheet' };

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][iQuoteId] || '').trim() === quoteId) {
        if (iService !== -1)
          sheet.getRange(i + 1, iService + 1).setValue('Weekly Full Service');
        if (iBillingStart !== -1 && billingStart)
          sheet.getRange(i + 1, iBillingStart + 1).setValue(billingStart);
        try {
          completeStartupAndCreateWeeklyService_(quoteId, billingStart);
        } catch(syncErr) {
          Logger.log('convert_to_wfs normalized sync failed: ' + syncErr);
        }
        Logger.log('convert_to_wfs: updated ' + quoteId + ' → WFS, billing_start=' + billingStart);
        return { ok: true };
      }
    }

    return { ok: false, error: 'Quote not found: ' + quoteId };

  } catch(err) {
    Logger.log('handleConvertToWFS_ error: ' + err);
    return { ok: false, error: String(err) };
  }
}

/**
 * Reads CRM data from the Quotes sheet.
 */
function handleGetCRMData() {
  const cache    = CacheService.getScriptCache();
  const cacheKey = 'crm_data';
  const cached   = cache.get(cacheKey);
  if (cached) { try { return JSON.parse(cached); } catch(e) {} }

  const SS_ID = "1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E";
  try {
    const ss = SpreadsheetApp.openById(SS_ID);
    const sheet = ss.getSheetByName("Quotes") || ss.getSheetByName("CRM") || ss.getSheets()[0];
    const rows = sheet.getDataRange().getValues();
    if (rows.length < 2) return { ok: true, data: [] };

    const headers = rows.shift();
    const data = rows.map(row => {
      let obj = {};
      headers.forEach((h, i) => {
        const key = String(h || '').toLowerCase().trim().replace(/ /g, '_');
        if (key) obj[key] = row[i];
      });
      return obj;
    }).filter(item => item.quote_id);

    const result = { ok: true, data: data };
    try { cache.put(cacheKey, JSON.stringify(result), 300); } catch(e) {
      Logger.log('crm_data cache put failed (payload too large?): ' + e);
    }
    return result;
  } catch (err) {
    return { ok: false, error: "handleGetCRMData Error: " + err.toString() };
  }
}

function invalidateCrmCache_() {
  try { CacheService.getScriptCache().remove('crm_data'); } catch(e) {}
}
