// ── Duplicate people detection and soft-merge ────────────────────────────────
//
// Merging a person is referential surgery, so it is intentionally boring:
// keep the survivor row, repoint normalized child rows, mark the duplicate as
// merged, and log what happened. Never delete a Clients row.

var MCPS_MERGE_LOG_HEADERS = [
  'timestamp', 'merge_id', 'survivor_client_id', 'duplicate_client_id',
  'merged_by', 'reason', 'updated_counts', 'notes'
];

function mcNorm_(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function mcEmail_(value) {
  return typeof normalizeEmail_ === 'function'
    ? normalizeEmail_(value) : mcNorm_(value);
}

function mcPhone_(value) {
  return typeof normalizePhone_ === 'function'
    ? normalizePhone_(value) : String(value || '').replace(/\D/g, '');
}

function mcAddress_(value) {
  return typeof normalizeAddress_ === 'function'
    ? normalizeAddress_(value) : mcNorm_(value).replace(/[^a-z0-9]+/g, ' ').trim();
}

function mcValue_(obj, name) {
  return typeof value_ === 'function' ? value_(obj, name) : (obj && obj[name] != null ? obj[name] : '');
}

function mcClientName_(c) {
  return String(mcValue_(c, 'display_name') || '').trim() ||
    [mcValue_(c, 'first_name'), mcValue_(c, 'last_name')].filter(Boolean).join(' ').trim();
}

function mcRows_(sheetName, headers) {
  return sheetToObjects_(ensureSheet_(sheetName, headers)).rows || [];
}

function mcGroupLocations_(locations) {
  var by = {};
  (locations || []).forEach(function (l) {
    var id = String(mcValue_(l, 'client_id') || '').trim();
    if (!id) return;
    if (!by[id]) by[id] = [];
    by[id].push(l);
  });
  return by;
}

function mcClientWire_(client, locations) {
  return {
    client_id: String(mcValue_(client, 'client_id') || '').trim(),
    display_name: mcClientName_(client),
    first_name: String(mcValue_(client, 'first_name') || '').trim(),
    last_name: String(mcValue_(client, 'last_name') || '').trim(),
    email: String(mcValue_(client, 'email') || '').trim(),
    phone: String(mcValue_(client, 'phone') || '').trim(),
    status: String(mcValue_(client, 'status') || '').trim(),
    location_count: (locations || []).length,
    locations: (locations || []).map(function (l) {
      return {
        location_id: String(mcValue_(l, 'location_id') || '').trim(),
        pool_id: String(mcValue_(l, 'pool_id') || '').trim(),
        service_address: String(mcValue_(l, 'service_address') || '').trim(),
        city: String(mcValue_(l, 'city') || '').trim(),
        zip_code: String(mcValue_(l, 'zip_code') || '').trim()
      };
    })
  };
}

function mcAddGroup_(groups, seen, reason, key, clientIds, byId, locsByClient) {
  var ids = (clientIds || []).filter(function (id, i, arr) {
    return id && arr.indexOf(id) === i && byId[id] &&
      String(mcValue_(byId[id], 'status') || '').toLowerCase() !== 'merged';
  }).sort();
  if (ids.length < 2) return;
  var sig = ids.join('|');
  if (seen[sig]) {
    if (seen[sig].reasons.indexOf(reason) === -1) seen[sig].reasons.push(reason);
    return;
  }
  var group = {
    duplicate_group_id: 'DUP-' + String(groups.length + 1).padStart(4, '0'),
    reason: reason,
    reasons: [reason],
    key: key,
    clients: ids.map(function (id) { return mcClientWire_(byId[id], locsByClient[id] || []); })
  };
  seen[sig] = group;
  groups.push(group);
}

function findDuplicatePeople_() {
  var clients = mcRows_('Clients', MCPS_CLIENT_HEADERS);
  var locations = mcRows_('Client_Locations', MCPS_LOCATION_HEADERS);
  var locsByClient = mcGroupLocations_(locations);
  var byId = {};
  clients.forEach(function (c) {
    var id = String(mcValue_(c, 'client_id') || '').trim();
    if (id) byId[id] = c;
  });

  var groups = [], seen = {};
  var byEmail = {}, byPhone = {}, byNameAddress = {};

  clients.forEach(function (c) {
    var id = String(mcValue_(c, 'client_id') || '').trim();
    if (!id || String(mcValue_(c, 'status') || '').toLowerCase() === 'merged') return;
    var email = mcEmail_(mcValue_(c, 'email'));
    var phone = mcPhone_(mcValue_(c, 'phone'));
    if (email) {
      if (!byEmail[email]) byEmail[email] = [];
      byEmail[email].push(id);
    }
    if (phone && phone.length >= 7) {
      if (!byPhone[phone]) byPhone[phone] = [];
      byPhone[phone].push(id);
    }
    var name = mcNorm_(mcClientName_(c));
    (locsByClient[id] || []).forEach(function (l) {
      var addr = mcAddress_(mcValue_(l, 'service_address'));
      var zip = String(mcValue_(l, 'zip_code') || '').trim();
      if (!name || !addr) return;
      var key = name + '|' + addr + '|' + zip;
      if (!byNameAddress[key]) byNameAddress[key] = [];
      byNameAddress[key].push(id);
    });
  });

  Object.keys(byEmail).forEach(function (k) { mcAddGroup_(groups, seen, 'same_email', k, byEmail[k], byId, locsByClient); });
  Object.keys(byPhone).forEach(function (k) { mcAddGroup_(groups, seen, 'same_phone', k, byPhone[k], byId, locsByClient); });
  Object.keys(byNameAddress).forEach(function (k) { mcAddGroup_(groups, seen, 'same_name_and_address', k, byNameAddress[k], byId, locsByClient); });

  groups.sort(function (a, b) {
    return b.clients.length - a.clients.length || String(a.key || '').localeCompare(String(b.key || ''));
  });
  return groups;
}

function handleFindDuplicatePeople_(payload) {
  try {
    var groups = findDuplicatePeople_();
    var limit = Math.max(1, Math.min(100, Number(payload && payload.limit) || 50));
    return { ok: true, groups: groups.slice(0, limit), total_groups: groups.length };
  } catch (e) {
    return { ok: false, error: 'handleFindDuplicatePeople_ Error: ' + e };
  }
}

function mcSetIfBlank_(sheet, rowNum, survivor, duplicate, field) {
  if (String(mcValue_(survivor, field) || '').trim()) return false;
  var val = mcValue_(duplicate, field);
  if (!String(val || '').trim()) return false;
  softSetCell_(sheet, rowNum, field, val);
  return true;
}

function mcRepointSheet_(sheetName, headers, fromClientId, toClientId) {
  var sheet = ensureSheet_(sheetName, headers);
  var rows = sheetToObjects_(sheet).rows || [];
  var updated = 0;
  rows.forEach(function (r) {
    if (String(mcValue_(r, 'client_id') || '').trim() !== fromClientId) return;
    softSetCell_(sheet, r._rowNum, 'client_id', toClientId);
    if (sheetName !== 'Client_Locations') softSetCell_(sheet, r._rowNum, 'updated_at', nowIso_());
    updated++;
  });
  return updated;
}

function mcRepointQuotes_(fromClientId, toClientId) {
  var sheet = getCrmSheet_();
  if (!sheet) return 0;
  var rows = sheetToObjects_(sheet).rows || [];
  var updated = 0;
  rows.forEach(function (r) {
    if (String(mcValue_(r, 'client_id') || '').trim() !== fromClientId) return;
    softSetCell_(sheet, r._rowNum, 'client_id', toClientId);
    updated++;
  });
  return updated;
}

function mergeClients_(payload) {
  var survivorId = String(payload.survivor_client_id || payload.survivor_id || '').trim();
  var duplicateId = String(payload.duplicate_client_id || payload.duplicate_id || '').trim();
  if (!survivorId || !duplicateId) return { ok: false, error: 'survivor_client_id and duplicate_client_id are required.' };
  if (survivorId === duplicateId) return { ok: false, error: 'Choose two different clients.' };

  var lock = null;
  try {
    if (typeof LockService !== 'undefined') {
      lock = LockService.getScriptLock();
      lock.waitLock(30000);
    }

    var clientsSheet = ensureSheet_('Clients', MCPS_CLIENT_HEADERS);
    var survivor = findRowByValue_(clientsSheet, 'client_id', survivorId);
    var duplicate = findRowByValue_(clientsSheet, 'client_id', duplicateId);
    if (!survivor) return { ok: false, error: 'Survivor client not found: ' + survivorId };
    if (!duplicate) return { ok: false, error: 'Duplicate client not found: ' + duplicateId };
    if (String(mcValue_(duplicate, 'status') || '').toLowerCase() === 'merged') {
      return { ok: false, error: 'Duplicate client is already merged.' };
    }

    var filled = 0;
    ['first_name','last_name','display_name','email','phone','billing_address',
     'billing_city','billing_state','billing_zip'].forEach(function (field) {
      if (mcSetIfBlank_(clientsSheet, survivor._rowNum, survivor, duplicate, field)) filled++;
    });
    var survivorLegacy = parseJsonArray_(mcValue_(survivor, 'legacy_quote_ids'));
    parseJsonArray_(mcValue_(duplicate, 'legacy_quote_ids')).forEach(function (id) {
      if (id && survivorLegacy.indexOf(id) === -1) survivorLegacy.push(id);
    });
    if (survivorLegacy.length) softSetCell_(clientsSheet, survivor._rowNum, 'legacy_quote_ids', JSON.stringify(survivorLegacy));
    if (String(mcValue_(duplicate, 'status') || '').toLowerCase() === 'active') {
      softSetCell_(clientsSheet, survivor._rowNum, 'status', 'active');
    }
    softSetCell_(clientsSheet, survivor._rowNum, 'updated_at', nowIso_());

    var counts = {
      client_locations: mcRepointSheet_('Client_Locations', MCPS_LOCATION_HEADERS, duplicateId, survivorId),
      proposals: mcRepointSheet_('Proposals', MCPS_PROPOSAL_HEADERS, duplicateId, survivorId),
      service_accounts: mcRepointSheet_('Service_Accounts', MCPS_SERVICE_ACCOUNT_HEADERS, duplicateId, survivorId),
      service_agreements: mcRepointSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS, duplicateId, survivorId),
      quotes: mcRepointQuotes_(duplicateId, survivorId),
      survivor_fields_filled: filled
    };

    var note = 'Merged into ' + survivorId + ' at ' + nowIso_();
    var oldNotes = String(mcValue_(duplicate, 'notes') || '').trim();
    softSetCell_(clientsSheet, duplicate._rowNum, 'status', 'merged');
    softSetCell_(clientsSheet, duplicate._rowNum, 'notes', [oldNotes, note].filter(Boolean).join('\n'));
    softSetCell_(clientsSheet, duplicate._rowNum, 'updated_at', nowIso_());

    var log = ensureSheet_('Merge_Log', MCPS_MERGE_LOG_HEADERS);
    var mergeId = nextSequence_(log, 'merge_id', 'MERGE', 6);
    appendObject_(log, {
      timestamp: nowIso_(),
      merge_id: mergeId,
      survivor_client_id: survivorId,
      duplicate_client_id: duplicateId,
      merged_by: String(payload.merged_by || payload.user || ''),
      reason: String(payload.reason || ''),
      updated_counts: JSON.stringify(counts),
      notes: note
    }, MCPS_MERGE_LOG_HEADERS);

    return { ok: true, merge_id: mergeId, survivor_client_id: survivorId, duplicate_client_id: duplicateId, updated_counts: counts };
  } catch (e) {
    return { ok: false, error: 'mergeClients_ Error: ' + e };
  } finally {
    try { if (lock) lock.releaseLock(); } catch (releaseErr) {}
  }
}

function handleMergeClients_(payload) {
  return mergeClients_(payload || {});
}
