// ══════════════════════════════════════════════════════════════════════════════
// TRAINING MODULES — Google Apps Script backend
//
// Add this file to your existing Apps Script project.
// Requires two sheets in your Google Spreadsheet:
//   "Modules"       — columns: id, title, description, order, created_by, created_at
//   "Module_Videos" — columns: id, module_id, title, drive_url, description, order, created_at
//
// The doPost / doGet handlers already exist in your main script.
// Route these actions there by adding calls like:
//
//   case 'get_modules':    return trGetModules(params, session);
//   case 'create_module':  return trCreateModule(params, session);
//   case 'update_module':  return trUpdateModule(params, session);
//   case 'delete_module':  return trDeleteModule(params, session);
//   case 'create_video':   return trCreateVideo(params, session);
//   case 'update_video':   return trUpdateVideo(params, session);
//   case 'delete_video':   return trDeleteVideo(params, session);
//
// ══════════════════════════════════════════════════════════════════════════════

// ── Sheet helpers ─────────────────────────────────────────────────────────────

function trGetSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (name === 'Modules') {
      sheet.appendRow(['id','title','description','order','created_by','created_at']);
    } else if (name === 'Module_Videos') {
      sheet.appendRow(['id','module_id','title','drive_url','description','order','created_at']);
    }
  }
  return sheet;
}

function trSheetToObjects_(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0];
  return data.slice(1).map(function(row) {
    var obj = {};
    headers.forEach(function(h, i) { obj[h] = row[i]; });
    return obj;
  });
}

function trGenerateId_() {
  return Utilities.getUuid().replace(/-/g,'').substring(0,16);
}

// ── GET Modules (with nested videos) ─────────────────────────────────────────

function trGetModules(params, session) {
  // Any authenticated user may read modules
  var modSheet = trGetSheet_('Modules');
  var vidSheet = trGetSheet_('Module_Videos');
  var modules  = trSheetToObjects_(modSheet);
  var videos   = trSheetToObjects_(vidSheet);

  // Sort modules by order then title
  modules.sort(function(a, b) {
    var oa = parseInt(a.order) || 999;
    var ob = parseInt(b.order) || 999;
    return oa !== ob ? oa - ob : String(a.title).localeCompare(String(b.title));
  });

  // Attach videos to each module, sorted by order
  modules.forEach(function(mod) {
    var modVids = videos.filter(function(v) { return v.module_id === mod.id; });
    modVids.sort(function(a, b) {
      var oa = parseInt(a.order) || 999;
      var ob = parseInt(b.order) || 999;
      return oa - ob;
    });
    mod.videos = modVids;
  });

  return { ok: true, modules: modules };
}

// ── Create Module ─────────────────────────────────────────────────────────────

function trCreateModule(params, session) {
  if (!trIsAdmin_(session)) return { ok: false, error: 'Admin access required.' };
  var title = String(params.title || '').trim();
  if (!title) return { ok: false, error: 'Title is required.' };

  var sheet = trGetSheet_('Modules');
  var id = trGenerateId_();
  var now = new Date().toISOString();
  sheet.appendRow([
    id,
    title,
    String(params.description || '').trim(),
    parseInt(params.order) || 1,
    session.username || '',
    now
  ]);
  return { ok: true, module_id: id };
}

// ── Update Module ─────────────────────────────────────────────────────────────

function trUpdateModule(params, session) {
  if (!trIsAdmin_(session)) return { ok: false, error: 'Admin access required.' };
  var moduleId = String(params.module_id || '').trim();
  if (!moduleId) return { ok: false, error: 'module_id is required.' };
  var title = String(params.title || '').trim();
  if (!title) return { ok: false, error: 'Title is required.' };

  var sheet = trGetSheet_('Modules');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var idCol = headers.indexOf('id');
  for (var i = 1; i < data.length; i++) {
    if (data[i][idCol] === moduleId) {
      var row = i + 1; // 1-indexed
      sheet.getRange(row, headers.indexOf('title') + 1).setValue(title);
      sheet.getRange(row, headers.indexOf('description') + 1).setValue(String(params.description || '').trim());
      sheet.getRange(row, headers.indexOf('order') + 1).setValue(parseInt(params.order) || 1);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Module not found.' };
}

// ── Delete Module (cascades to videos) ───────────────────────────────────────

function trDeleteModule(params, session) {
  if (!trIsAdmin_(session)) return { ok: false, error: 'Admin access required.' };
  var moduleId = String(params.module_id || '').trim();
  if (!moduleId) return { ok: false, error: 'module_id is required.' };

  // Delete the module row
  var modSheet = trGetSheet_('Modules');
  var modData = modSheet.getDataRange().getValues();
  var modIdCol = modData[0].indexOf('id');
  for (var i = modData.length - 1; i >= 1; i--) {
    if (modData[i][modIdCol] === moduleId) {
      modSheet.deleteRow(i + 1);
      break;
    }
  }

  // Cascade: delete all videos in this module
  var vidSheet = trGetSheet_('Module_Videos');
  var vidData = vidSheet.getDataRange().getValues();
  var vidModCol = vidData[0].indexOf('module_id');
  for (var j = vidData.length - 1; j >= 1; j--) {
    if (vidData[j][vidModCol] === moduleId) {
      vidSheet.deleteRow(j + 1);
    }
  }

  return { ok: true };
}

// ── Create Video ──────────────────────────────────────────────────────────────

function trCreateVideo(params, session) {
  if (!trIsAdmin_(session)) return { ok: false, error: 'Admin access required.' };
  var title = String(params.title || '').trim();
  var driveUrl = String(params.drive_url || '').trim();
  var moduleId = String(params.module_id || '').trim();
  if (!title) return { ok: false, error: 'Title is required.' };
  if (!driveUrl) return { ok: false, error: 'drive_url is required.' };
  if (!moduleId) return { ok: false, error: 'module_id is required.' };

  var sheet = trGetSheet_('Module_Videos');
  var id = trGenerateId_();
  var now = new Date().toISOString();
  sheet.appendRow([
    id,
    moduleId,
    title,
    driveUrl,
    String(params.description || '').trim(),
    parseInt(params.order) || 1,
    now
  ]);
  return { ok: true, video_id: id };
}

// ── Update Video ──────────────────────────────────────────────────────────────

function trUpdateVideo(params, session) {
  if (!trIsAdmin_(session)) return { ok: false, error: 'Admin access required.' };
  var videoId = String(params.video_id || '').trim();
  if (!videoId) return { ok: false, error: 'video_id is required.' };
  var title = String(params.title || '').trim();
  if (!title) return { ok: false, error: 'Title is required.' };

  var sheet = trGetSheet_('Module_Videos');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var idCol = headers.indexOf('id');
  for (var i = 1; i < data.length; i++) {
    if (data[i][idCol] === videoId) {
      var row = i + 1;
      sheet.getRange(row, headers.indexOf('title') + 1).setValue(title);
      sheet.getRange(row, headers.indexOf('drive_url') + 1).setValue(String(params.drive_url || '').trim());
      sheet.getRange(row, headers.indexOf('description') + 1).setValue(String(params.description || '').trim());
      sheet.getRange(row, headers.indexOf('order') + 1).setValue(parseInt(params.order) || 1);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Video not found.' };
}

// ── Delete Video ──────────────────────────────────────────────────────────────

function trDeleteVideo(params, session) {
  if (!trIsAdmin_(session)) return { ok: false, error: 'Admin access required.' };
  var videoId = String(params.video_id || '').trim();
  if (!videoId) return { ok: false, error: 'video_id is required.' };

  var sheet = trGetSheet_('Module_Videos');
  var data = sheet.getDataRange().getValues();
  var idCol = data[0].indexOf('id');
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][idCol] === videoId) {
      sheet.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Video not found.' };
}

// ── Role check helper ─────────────────────────────────────────────────────────

function trIsAdmin_(session) {
  if (!session) return false;
  var roles = String(session.roles || '').split(',');
  return roles.indexOf('admin') !== -1 || roles.indexOf('manager') !== -1;
}
