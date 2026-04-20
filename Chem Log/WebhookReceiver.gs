// WebhookReceiver.gs
// Receives POST requests from Zapier with QBO bill line items
// and writes them to Purchase_Log in Inventory Master.
// Add this at the top of your script


const WEBHOOK_SECRET = "mcps_webhook_2026"; // change this to anything you want
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


/*  REPLACE your existing doPost() with this full version:  */



function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    const payload = JSON.parse(raw);

    if (payload.action === 'login') {
      return jsonResponse_(handleLogin(payload));
    }

    if (payload.action === 'validate_token') {
      const auth = validateToken(payload.token || '');
      return jsonResponse_(auth);
    }
    
    // ── ONBOARDING: Save Personal Info + Generate W-9/W-4 in Google Drive ──────────
    if (payload.action === 'save_info') {
      const auth = validateToken(payload.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error || "Unauthorized" });
      try {
        var username = auth.user ? auth.user.username : (auth.username || '');
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
        
        return jsonResponse_({ ok: true, contract_done: false });
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
        return jsonResponse_({ ok: true, info_done: true });
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
      return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
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

    if (payload.action === 'set_weekly_goal') {
      const auth = validateToken(payload.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(handleSetWeeklyGoal_(payload.goal));
    }


    if (payload.action === 'save_quote') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return handleSaveQuote_(payload);
    }

    if (payload.action === 'generate_contract') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(handleGenerateContract_(payload.quote_id || ''));
    }

    if (payload.action === 'send_contract') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(handleSendContract_(payload.quote_id || ''));
    }

    if (payload.action === 'update_quote_info') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(handleUpdateQuoteInfo_(payload));
    }
    
    if (payload.action === 'add_adhoc_event') {
      return jsonResponse_(addAdHocEvent(payload.token || '', payload.event || {}));
    }

    if (payload.action === 'send_heads_up') {
      const auth = validateToken(payload.token || '');
      if (!auth.ok) return jsonResponse_({ ok: false, error: 'Unauthorized' });
      return jsonResponse_(sendHeadsUp(payload.pool_id || '', payload.customer_name || ''));
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

      Utilities.sleep(1500);

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
      
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Onboarding_Submissions");
      if (!sheet) return jsonResponse_({ ok: true, info_done: false, contract_done: false, status: 'in_progress', worker_type: workerType });
      var data = sheet.getDataRange().getValues();
      for (var i = 1; i < data.length; i++) {
        if (data[i][1] === username) {
          return jsonResponse_({
            ok: true,
            info_done: !!data[i][0],
            contract_done: !!data[i][7],
            status: data[i][11] || 'in_progress',
            full_name: data[i][2],
            phone: data[i][3],
            worker_type: workerType
          });
        }
      }
      return jsonResponse_({ ok: true, info_done: false, contract_done: false, status: 'in_progress', worker_type: workerType });
    }
    
    if (e && e.parameter && e.parameter.action === 'onboarding_list_pending') {
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Onboarding_Submissions");
      if (!sheet) return jsonResponse_({ ok: true, applications: [] });
      var data = sheet.getDataRange().getValues();
      var headers = data[0];
      var wTypeIdx = headers.indexOf('worker_type');
      
      var apps = [];
      for (var i = 1; i < data.length; i++) {
        if (data[i][11] === 'pending_review') {
          apps.push({
            username: data[i][1],
            full_name: data[i][2],
            phone: data[i][3],
            info_submitted_at: data[i][0],
            info_done: !!data[i][0],
            contract_done: !!data[i][7],
            status: 'pending_review',
            worker_type: wTypeIdx > -1 ? data[i][wTypeIdx] : '1099_contractor'
          });
        }
      }
      return jsonResponse_({ ok: true, applications: apps });
    }
    
    if (e && e.parameter && e.parameter.action === 'onboarding_list_all') {
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Onboarding_Submissions");
      if (!sheet) return jsonResponse_({ ok: true, applications: [] });
      var data = sheet.getDataRange().getValues();
      var headers = data[0];
      var wTypeIdx = headers.indexOf('worker_type');
      
      var apps = [];
      for (var i = 1; i < data.length; i++) {
        if (!data[i][1]) continue;
        apps.push({
          username: data[i][1],
          full_name: data[i][2],
          phone: data[i][3],
          info_submitted_at: data[i][0],
          approved_at: data[i][10],
          info_done: !!data[i][0],
          contract_done: !!data[i][7],
          status: data[i][11],
          worker_type: wTypeIdx > -1 ? data[i][wTypeIdx] : '1099_contractor'
        });
      }
      return jsonResponse_({ ok: true, applications: apps.reverse() });
    }
    
    if (e && e.parameter && e.parameter.action === 'onboarding_get_documents') {
      var username = e.parameter.username;
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Onboarding_Submissions");
      if (!sheet) return jsonResponse_({ ok: false, error: "Not found" });
      var data = sheet.getDataRange().getValues();
      var headers = data[0];
      var wTypeIdx = headers.indexOf('worker_type');
      var w4Idx = headers.indexOf('w4_url');

      for (var i = 1; i < data.length; i++) {
        if (data[i][1] === username) {
          return jsonResponse_({
            ok: true,
            full_name: data[i][2], phone: data[i][3], tax_type: data[i][4], tax_id_last4: data[i][5], 
            w9_signed_url: data[i][6],
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

    if (e && e.parameter && e.parameter.action === 'route_data') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      return jsonResponse_(getRouteData(e.parameter.token || "", e.parameter.operator || ""));
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

    // ── CRM Data Retrieval ──
    if (e.parameter.action === 'get_crm_data') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      return jsonResponse_(handleGetCRMData());
    }

    if (e && e.parameter && e.parameter.test === 'true') {
      return jsonResponse_({ ok: true, message: "MCPS webhook receiver is live" });
    }

    if (e && e.parameter && e.parameter.action === 'get_weekly_goal') {
      return jsonResponse_(handleGetWeeklyGoal_()); 
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
    const notesColIdx = headers.indexOf('Internal Notes'); // Fetches the tech-only notes
    
    let lastSize = "";
    let lastMat = "";
    let lastInternalNote = "";
    let visitCount = 0;

    // Loop backwards through your logs to find the most recent info for this pool
    for (let i = data.length - 1; i >= 1; i--) {
      if (String(data[i][poolColIdx]).trim() === poolId.trim()) {
        visitCount++;
        
        // Grab the latest internal note if we haven't found one yet
        if (!lastInternalNote && notesColIdx !== -1 && data[i][notesColIdx]) {
          lastInternalNote = data[i][notesColIdx];
        }
        
        // Grab the latest size/material settings
        if (!lastSize && sizeColIdx !== -1) lastSize = data[i][sizeColIdx];
        if (!lastMat && matColIdx !== -1) lastMat = data[i][matColIdx];
      }
    }

    return {
      found: true,
      last_size: lastSize,
      last_material: lastMat,
      internal_notes: lastInternalNote, // This triggers the yellow banner
      visit_count: visitCount,
      trends: [] // You can expand this later for chem trends
    };
  } catch (err) {
    Logger.log("getPoolContext error: " + err);
    return { found: false, error: String(err) };
  }
}


/**
 * Reads CRM data from the Quotes sheet.
 */
function handleGetCRMData() {
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

    return { ok: true, data: data };
  } catch (err) {
    return { ok: false, error: "handleGetCRMData Error: " + err.toString() };
  }
}