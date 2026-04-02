// WebhookReceiver.gs
// Receives POST requests from Zapier with QBO bill line items
// and writes them to Purchase_Log in Inventory Master.

const WEBHOOK_SECRET = "mcps_webhook_2026"; // change this to anything you want

// WebhookReceiver.gs  — doPost AUTH ROUTES TO ADD
// ─────────────────────────────────────────────────────────────────────────────
// Add these routes inside your existing doPost(), right after the secret check
// and BEFORE the get_metadata / submit_form blocks.
//
// Replace your current secret-check block with the version below so that
// the login action is allowed through WITHOUT a token (it doesn't have one yet).
// ─────────────────────────────────────────────────────────────────────────────
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

    // ── Login is the one action that doesn't require a token or secret ──────
    if (payload.action === 'login') {
      return jsonResponse_(handleLogin(payload));
    }

    if (payload.action === 'move_pool') {
      const data = movePool(
        payload.token || "",
        payload.pool_id || "",
        payload.new_day || "",
        payload.new_operator || "",
        payload.pinned
      );
      return ContentService.createTextOutput(JSON.stringify(data))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (payload.action === 'toggle_pin') {
      const data = togglePin(payload.token || "", payload.pool_id || "", payload.pinned === true);
      return ContentService.createTextOutput(JSON.stringify(data))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (payload.action === 'pin_day') {
      const data = pinDay(payload.token || "", payload.day || "", payload.pinned === true);
      return ContentService.createTextOutput(JSON.stringify(data))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (payload.action === 'recalculate_new') {
      const data = recalculateNew(payload.token || "");
      return ContentService.createTextOutput(JSON.stringify(data))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (payload.action === 'recalculate_routes') {
      const auth = validateToken(payload.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error });
      if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager'))
        return jsonResponse_({ ok: false, error: 'Not authorized' });
      try {
        calculateRoutes();
        return jsonResponse_({ ok: true });
      } catch (err) {
        return jsonResponse_({ ok: false, error: String(err) });
      }
    }

    // ── Training actions (token required, no webhook secret required) ────────
    const trActions = {
      get_modules: true,
      create_module: true,
      update_module: true,
      delete_module: true,
      create_video: true,
      update_video: true,
      delete_video: true,
      get_training_progress: true,
      upsert_training_progress: true
    };

    if (trActions[payload.action]) {
      const auth = validateToken(payload.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error || "Unauthorized" });

      // Build training session object expected by tr* functions
      const userObj = auth.user || {};
      const rolesArr = Array.isArray(userObj.roles) ? userObj.roles
                    : Array.isArray(auth.roles) ? auth.roles
                    : String(userObj.roles || auth.roles || '').split(',').map(s => s.trim()).filter(Boolean);

      const session = {
        username: userObj.username || auth.username || '',
        roles: rolesArr.join(',')
      };

      const trResult = trHandleAction_(payload, session);
      if (trResult) return jsonResponse_(trResult);
    }

    // ── All other actions require the webhook secret ─────────────────────────
    if (payload.secret !== WEBHOOK_SECRET) {
      return jsonResponse_({ ok: false, error: "Unauthorized" });
    }

    // ── Auth actions ─────────────────────────────────────────────────────────
    if (payload.action === 'logout')      return jsonResponse_(handleLogout(payload));
    if (payload.action === 'create_user') return jsonResponse_(handleCreateUser(payload));
    if (payload.action === 'update_user') return jsonResponse_(handleUpdateUser(payload));
    if (payload.action === 'list_users')  return jsonResponse_(handleListUsers(payload));
    if (payload.action === 'get_roles')   return jsonResponse_(handleGetRoles());

    // ── Form actions ─────────────────────────────────────────────────────────
    if (payload.action === 'get_metadata') {
      const metadata = getFormMetadata();
      return jsonResponse_({ ok: true, data: metadata });
    }

  if (payload.action === 'submit_form') {
    const auth = validateToken(payload.token);
    if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error });

    // ── Dedup guard ──────────────────────────────────────────────────────────
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const rawSheet = ss.getSheetByName('Chemical_Usage_Log');
    const lastRow = rawSheet.getLastRow();
    if (lastRow > 1) {
      const headers = rawSheet.getRange(1, 1, 1, rawSheet.getLastColumn()).getValues()[0];
      const poolColIdx = headers.indexOf('pool_id');
      const techColIdx = headers.indexOf('Technician');
      const tsColIdx   = 0; // Timestamp is always col A
      const lastData   = rawSheet.getRange(lastRow, 1, 1, rawSheet.getLastColumn()).getValues()[0];
      const lastTs     = new Date(lastData[tsColIdx]);
      const lastPool   = String(lastData[poolColIdx] || '');
      const lastTech   = String(lastData[techColIdx] || '');
      const incomingPool = String(payload.data.pool_id || '');
      const incomingTech = String(payload.data.Technician || '');
      const ageMs = new Date() - lastTs;

      if (lastPool === incomingPool && (new Date() - new Date(lastData[tsColIdx])) < 300000) {
        Logger.log('Dedup blocked: same pool within 5 minutes');
        return jsonResponse_({ ok: true });
      }
    }
    // ── end dedup ─────────────────────────────────────────────────────────────

    // ... rest of submit_form handler unchanged
    if (!canAccess(auth, 'service_log')) return jsonResponse_({ ok: false, error: 'Access denied.' });

    // Save photos to Drive first
    let photoUrls = [];
    if (Array.isArray(payload.photos) && payload.photos.length > 0) {
      try {
        photoUrls = saveVisitPhotos_(payload.photos, payload.data);
      } catch (photoErr) {
        Logger.log('Photo save error (non-fatal): ' + photoErr);
      }
    }

    // Write the row to Chemical_Usage_Log
    const result = submitCustomForm(payload.data);
    if (!result.success) return jsonResponse_({ ok: false, error: result.error });

    // Short pause for the sheet append to settle
    // Short pause for the sheet append to settle
    Utilities.sleep(1500);

    const newRowNum = rawSheet.getLastRow();  // ✅ ss and rawSheet already exist

    // Write photo URLs to the new row
    if (photoUrls.length > 0) {
      try {
        const headers = rawSheet.getRange(1, 1, 1, rawSheet.getLastColumn())
          .getValues()[0].map(h => String(h || '').trim());
        let photoColIdx = headers.indexOf('_photo_urls');
        if (photoColIdx === -1) {
          photoColIdx = rawSheet.getLastColumn();
          rawSheet.getRange(1, photoColIdx + 1).setValue('_photo_urls');
        }
        rawSheet.getRange(newRowNum, photoColIdx + 1).setValue(JSON.stringify(photoUrls));
      } catch (writeErr) {
        Logger.log('Could not write photo URLs to sheet: ' + writeErr);
      }
    }

    // ── FULL PIPELINE — triggers must be DELETED before deploying this ─────────

    // 1. Snapshot to Usage_Priced + analytics
    try {
      snapshotUsageToPriced_({ range: rawSheet.getRange(newRowNum, 1) });
    } catch (snapErr) {
      Logger.log('snapshotUsageToPriced_ error: ' + snapErr);
    }

    // 2. Inventory deduction
    try {
      deductInventoryOnFormSubmit_({ range: rawSheet.getRange(newRowNum, 1) });
    } catch (invErr) {
      Logger.log('deductInventoryOnFormSubmit_ error: ' + invErr);
    }

    // 3. Visit report email (photo URLs already in memory — no sheet race condition)
    try {
      const poolId = extractPoolId_(String(payload.data.pool_id || '').trim());
      if (poolId && poolId !== 'OTHER / POOL NOT LISTED' && poolId !== 'Other / Pool not listed') {
        const headers = rawSheet.getRange(1, 1, 1, rawSheet.getLastColumn())
          .getValues()[0].map(h => String(h || '').trim());
        const lastRowData = rawSheet.getRange(newRowNum, 1, 1, rawSheet.getLastColumn()).getValues()[0];
        sendVisitReportEmail(lastRowData, headers, poolId, photoUrls);
      }
    } catch (emailErr) {
      Logger.log('Visit report email error: ' + emailErr);
    }

    return jsonResponse_({ ok: true });
  }

    // ── Inventory reads (legacy in POST) ─────────────────────────────────────
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

    // ── QBO Bill Webhook (fallback) ──────────────────────────────────────────
    const result = processQBOBillPayload_(payload);
    return jsonResponse_({ ok: true, result });

  } catch (err) {
    Logger.log("doPost error: " + err);
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

// ─── Web App Entry Point (GET) ───────────────────────────────────────────────
function doGet(e) {
  try {
    if (e && e.parameter && e.parameter.action === 'get_unassigned') {
      const data = getUnassignedPools(e.parameter.token || "");
      return ContentService.createTextOutput(JSON.stringify(data))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── Training read route ──────────────────────────────────────────────────
    if (e && e.parameter && e.parameter.action === 'get_modules') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error || "Unauthorized" });

      const userObj = auth.user || {};
      const rolesArr = Array.isArray(userObj.roles) ? userObj.roles
                    : Array.isArray(auth.roles) ? auth.roles
                    : String(userObj.roles || auth.roles || '').split(',').map(s => s.trim()).filter(Boolean);

      const session = {
        username: userObj.username || auth.username || '',
        roles: rolesArr.join(',')
      };

      return jsonResponse_(trGetModules(e.parameter, session));
    }

    // ── Training progress (GET) ─────────────────────────────
    if (e && e.parameter && e.parameter.action === 'get_training_progress') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error || "Unauthorized" });

      const userObj = auth.user || {};
      const rolesArr = Array.isArray(userObj.roles) ? userObj.roles
                    : Array.isArray(auth.roles) ? auth.roles
                    : String(userObj.roles || auth.roles || '').split(',').map(s => s.trim()).filter(Boolean);

      const session = {
        username: userObj.username || auth.username || '',
        roles: rolesArr.join(',')
      };

      return jsonResponse_(trGetTrainingProgress(e.parameter, session));
    }

    // ── Route data (portal map page) ────────────────────────────────────────
    if (e && e.parameter && e.parameter.action === 'route_data') {
      const auth = validateToken(e.parameter.token || "");
      if (!auth.ok) return jsonResponse_({ ok: false, error: "Unauthorized" });
      return jsonResponse_(getRouteData(e.parameter.token || "", e.parameter.operator || ""));
    }

    // ── Margins dashboard ────────────────────────────────────────────────────
    if (e && e.parameter && e.parameter.action === 'margins_data') {
      return jsonResponse_(getMarginsDashboardData(e.parameter.labor || "false"));
    }

    // ── Map data (legacy) ────────────────────────────────────────────────────
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

    // ── Form metadata (legacy) ───────────────────────────────────────────────
    if (e && e.parameter && e.parameter.action === 'form_metadata') {
      try {
        return jsonResponse_({ ok: true, data: getFormMetadata() });
      } catch (err) {
        return jsonResponse_({ ok: false, error: String(err) });
      }
    }

    // ── Inventory reads ──────────────────────────────────────────────────────
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

    // ── Test ping ────────────────────────────────────────────────────────────
    if (e && e.parameter && e.parameter.test === 'true') {
      return jsonResponse_({ ok: true, message: "MCPS webhook receiver is live" });
    }

    // ── Default: serve the FormUI HTML ──────────────────────────────────────
    return HtmlService.createHtmlOutputFromFile("FormUI")
      .setTitle("MCPS Pool Log")
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1.0, user-scalable=0');

  } catch (err) {
    Logger.log("doGet error: " + err);
    return jsonResponse_({ ok: false, error: String(err) });
  }
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
