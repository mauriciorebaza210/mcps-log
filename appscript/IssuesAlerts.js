// IssuesAlerts.gs test
// Handles the submission, retrieval, resolution, and photo upload for issues and alerts.

const ALERT_PHOTOS_FOLDER_ID = '1rmtdgmWGqfTqc2TmBe8VuMZGq_VkRbm6';

function getIssuesAlertsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Issues_Alerts');
  if (!sheet) {
    sheet = ss.insertSheet('Issues_Alerts');
    sheet.appendRow([
      'id', 'timestamp', 'submitter_username', 'submitter_name', 'type',
      'message', 'visibility', 'linked_pool_id', 'status', 'resolved_by', 'resolved_at', 'photo_urls'
    ]);
    sheet.getRange("1:1").setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function handleSubmitIssueAlert_(payload, userObj) {
  try {
    const sheet = getIssuesAlertsSheet_();
    const id = Utilities.getUuid();
    const timestamp = new Date().toISOString();
    const submitter_username = userObj.username || '';
    const submitter_name = userObj.name || userObj.display_name || userObj.username || '';

    const type = String(payload.type || 'issue');
    const message = String(payload.message || '').trim();
    const visibility = String(payload.visibility || 'admin_only');
    const linked_pool_id = String(payload.linked_pool_id || '').trim();

    if (!message) return { ok: false, error: 'Message is required.' };

    sheet.appendRow([
      id, timestamp, submitter_username, submitter_name, type,
      message, visibility, linked_pool_id, 'open', '', '', ''
    ]);

    return { ok: true, id: id };
  } catch (err) {
    Logger.log("handleSubmitIssueAlert_ error: " + err);
    return { ok: false, error: String(err) };
  }
}

function handleGetIssueAlerts_(userObj) {
  const isUserAdmin = Array.isArray(userObj.roles) && (userObj.roles.includes('admin') || userObj.roles.includes('manager'));
  const cache    = CacheService.getScriptCache();
  const cacheKey = 'issue_alerts_' + (isUserAdmin ? 'admin' : 'public');
  const cached   = cache.get(cacheKey);
  if (cached) { try { return JSON.parse(cached); } catch(e) {} }

  try {
    const sheet = getIssuesAlertsSheet_();
    if (sheet.getLastRow() < 2) return { ok: true, alerts: [] };

    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    const alerts = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const status = row[headers.indexOf('status')];
      const visibility = row[headers.indexOf('visibility')];

      if (status !== 'open') continue;
      if (visibility === 'admin_only' && !isUserAdmin) continue;

      const photoUrlsRaw = row[headers.indexOf('photo_urls')] || '';
      alerts.push({
        id: row[headers.indexOf('id')],
        timestamp: row[headers.indexOf('timestamp')],
        submitter_username: row[headers.indexOf('submitter_username')],
        submitter_name: row[headers.indexOf('submitter_name')],
        type: row[headers.indexOf('type')],
        message: row[headers.indexOf('message')],
        visibility: row[headers.indexOf('visibility')],
        linked_pool_id: row[headers.indexOf('linked_pool_id')],
        status: status,
        photo_urls: photoUrlsRaw ? String(photoUrlsRaw).split(',').filter(u => u.trim()) : []
      });
    }

    alerts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const result = { ok: true, alerts: alerts };
    try { cache.put(cacheKey, JSON.stringify(result), 120); } catch(e) {}
    return result;
  } catch (err) {
    Logger.log("handleGetIssueAlerts_ error: " + err);
    return { ok: false, error: String(err) };
  }
}

function invalidateIssueAlertsCache_() {
  const cache = CacheService.getScriptCache();
  try { cache.remove('issue_alerts_admin'); cache.remove('issue_alerts_public'); } catch(e) {}
}

function handleGetAlertHistory_(userObj) {
  try {
    const sheet = getIssuesAlertsSheet_();
    if (sheet.getLastRow() < 2) return { ok: true, alerts: [] };

    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const isUserAdmin = Array.isArray(userObj.roles) && (userObj.roles.includes('admin') || userObj.roles.includes('manager'));

    const alerts = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const status = row[headers.indexOf('status')];
      const visibility = row[headers.indexOf('visibility')];

      if (status !== 'resolved') continue;
      if (visibility === 'admin_only' && !isUserAdmin) continue;

      const photoUrlsRaw = row[headers.indexOf('photo_urls')] || '';
      alerts.push({
        id: row[headers.indexOf('id')],
        timestamp: row[headers.indexOf('timestamp')],
        submitter_username: row[headers.indexOf('submitter_username')],
        submitter_name: row[headers.indexOf('submitter_name')],
        type: row[headers.indexOf('type')],
        message: row[headers.indexOf('message')],
        visibility: row[headers.indexOf('visibility')],
        linked_pool_id: row[headers.indexOf('linked_pool_id')],
        status: status,
        resolved_by: row[headers.indexOf('resolved_by')],
        resolved_at: row[headers.indexOf('resolved_at')],
        photo_urls: photoUrlsRaw ? String(photoUrlsRaw).split(',').filter(u => u.trim()) : []
      });
    }

    // Newest resolved first, capped at 100
    alerts.sort((a, b) => new Date(b.resolved_at) - new Date(a.resolved_at));
    return { ok: true, alerts: alerts.slice(0, 100) };
  } catch (err) {
    Logger.log("handleGetAlertHistory_ error: " + err);
    return { ok: false, error: String(err) };
  }
}

function handleResolveIssueAlert_(payload, userObj) {
  try {
    const sheet = getIssuesAlertsSheet_();
    if (sheet.getLastRow() < 2) return { ok: false, error: 'No alerts found.' };

    const isUserAdmin = Array.isArray(userObj.roles) && (userObj.roles.includes('admin') || userObj.roles.includes('manager'));

    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idIdx = headers.indexOf('id');
    const submitterIdx = headers.indexOf('submitter_username');
    const statusIdx = headers.indexOf('status');
    const resolvedByIdx = headers.indexOf('resolved_by');
    const resolvedAtIdx = headers.indexOf('resolved_at');

    let foundRowIdx = -1;
    for (let i = 1; i < data.length; i++) {
      if (data[i][idIdx] === payload.alert_id) {
        if (!isUserAdmin && data[i][submitterIdx] !== userObj.username) {
          return { ok: false, error: 'Not authorized to resolve this alert.' };
        }
        foundRowIdx = i + 1;
        break;
      }
    }

    if (foundRowIdx === -1) return { ok: false, error: 'Alert not found.' };

    sheet.getRange(foundRowIdx, statusIdx + 1).setValue('resolved');
    sheet.getRange(foundRowIdx, resolvedByIdx + 1).setValue(userObj.username);
    sheet.getRange(foundRowIdx, resolvedAtIdx + 1).setValue(new Date().toISOString());

    return { ok: true };
  } catch (err) {
    Logger.log("handleResolveIssueAlert_ error: " + err);
    return { ok: false, error: String(err) };
  }
}

function handleUploadAlertPhoto_(payload, userObj) {
  try {
    const alertId = String(payload.alert_id || '').trim();
    const photoBase64 = String(payload.photo_base64 || '').trim();
    const mimeType = String(payload.mime_type || 'image/jpeg').trim();
    const fileName = String(payload.file_name || 'photo.jpg').trim();

    if (!alertId || !photoBase64) return { ok: false, error: 'alert_id and photo_base64 are required.' };

    // Subfolder named by date + alert ID so photos are grouped and easy to browse
    const dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const subfolderName = dateStr + '_' + alertId.slice(0, 8);

    const rootFolder = DriveApp.getFolderById(ALERT_PHOTOS_FOLDER_ID);
    let subFolder;
    const existing = rootFolder.getFoldersByName(subfolderName);
    subFolder = existing.hasNext() ? existing.next() : rootFolder.createFolder(subfolderName);

    const blob = Utilities.newBlob(Utilities.base64Decode(photoBase64), mimeType, fileName);
    const file = subFolder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    const thumbnailUrl = 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w600';

    // Append URL to the alert row's photo_urls cell
    const sheet = getIssuesAlertsSheet_();
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idIdx = headers.indexOf('id');
    const photoUrlsIdx = headers.indexOf('photo_urls');

    for (let i = 1; i < data.length; i++) {
      if (data[i][idIdx] === alertId) {
        const existing = String(data[i][photoUrlsIdx] || '').trim();
        const updated = existing ? existing + ',' + thumbnailUrl : thumbnailUrl;
        sheet.getRange(i + 1, photoUrlsIdx + 1).setValue(updated);
        break;
      }
    }

    return { ok: true, url: thumbnailUrl };
  } catch (err) {
    Logger.log("handleUploadAlertPhoto_ error: " + err);
    return { ok: false, error: String(err) };
  }
}
