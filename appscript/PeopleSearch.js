// ── People Search / identity matching ────────────────────────────────────────
//
// One person should have one Clients row. Search can be generous; automatic
// linking must be conservative. Email-only or phone-only is a useful candidate,
// but not enough to silently merge a new quote into an existing person.

function psValue_(obj, name) {
  if (typeof value_ === 'function') return value_(obj, name);
  return obj && obj[name] != null ? obj[name] : '';
}

function psEmail_(value) {
  if (typeof normalizeEmail_ === 'function') return normalizeEmail_(value);
  return String(value || '').trim().toLowerCase();
}

function psPhone_(value) {
  if (typeof normalizePhone_ === 'function') return normalizePhone_(value);
  return String(value || '').replace(/\D/g, '');
}

function psAddress_(value) {
  if (typeof normalizeAddress_ === 'function') return normalizeAddress_(value);
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function psText_(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function psActive_(value) {
  var s = String(value == null ? '' : value).trim().toUpperCase();
  return s !== 'FALSE' && s !== 'NO' && s !== '0' && s !== 'ARCHIVED';
}

function psClientName_(c) {
  return String(psValue_(c, 'display_name') || '').trim() ||
    [psValue_(c, 'first_name'), psValue_(c, 'last_name')].filter(Boolean).join(' ').trim();
}

function psRows_(sheetName, headers) {
  try {
    return sheetToObjects_(ensureSheet_(sheetName, headers)).rows || [];
  } catch (e) {
    Logger.log('psRows_ failed for ' + sheetName + ' (non-blocking): ' + e);
    return [];
  }
}

function psLocationsByClient_(locations) {
  var by = {};
  (locations || []).forEach(function (l) {
    var id = String(psValue_(l, 'client_id') || '').trim();
    if (!id) return;
    if (!by[id]) by[id] = [];
    by[id].push(l);
  });
  return by;
}

function psInputFromQuote_(q) {
  return {
    first: psText_(psValue_(q, 'first_name')),
    last: psText_(psValue_(q, 'last_name')),
    name: psText_([psValue_(q, 'first_name'), psValue_(q, 'last_name')].filter(Boolean).join(' ')),
    email: psEmail_(psValue_(q, 'email')),
    phone: psPhone_(psValue_(q, 'phone')),
    address: psAddress_(psValue_(q, 'address')),
    zip: String(psValue_(q, 'zip_code') || '').trim()
  };
}

function psNameMatches_(input, client) {
  var first = psText_(psValue_(client, 'first_name'));
  var last = psText_(psValue_(client, 'last_name'));
  var display = psText_(psClientName_(client));
  if (input.first && input.last) return first === input.first && last === input.last;
  if (input.name) return display === input.name;
  return false;
}

function psAddressMatches_(input, locations) {
  if (!input.address) return false;
  for (var i = 0; i < (locations || []).length; i++) {
    var locAddr = psAddress_(psValue_(locations[i], 'service_address'));
    var locZip = String(psValue_(locations[i], 'zip_code') || '').trim();
    if (!locAddr || locAddr !== input.address) continue;
    if (input.zip && locZip && locZip !== input.zip) continue;
    return true;
  }
  return false;
}

function psScoreIdentity_(input, client, locations) {
  var emailMatch = !!(input.email && psEmail_(psValue_(client, 'email')) === input.email);
  var phoneMatch = !!(input.phone && psPhone_(psValue_(client, 'phone')) === input.phone);
  var nameMatch = psNameMatches_(input, client);
  var addressMatch = psAddressMatches_(input, locations);

  var score = 0, reasons = [];
  if (emailMatch) { score += 40; reasons.push('email'); }
  if (phoneMatch) { score += 40; reasons.push('phone'); }
  if (nameMatch) { score += 30; reasons.push('name'); }
  if (addressMatch) { score += 35; reasons.push('address'); }

  var confident = (emailMatch && phoneMatch) ||
    (emailMatch && nameMatch) ||
    (emailMatch && addressMatch) ||
    (phoneMatch && nameMatch) ||
    (phoneMatch && addressMatch) ||
    (nameMatch && addressMatch);

  return { score: score, confident: confident, reasons: reasons };
}

function findConfidentClientForQuote_(q) {
  var clients = psRows_('Clients', MCPS_CLIENT_HEADERS);
  var locations = psRows_('Client_Locations', MCPS_LOCATION_HEADERS);
  var byClient = psLocationsByClient_(locations);
  var input = psInputFromQuote_(q);
  var hits = [];

  clients.forEach(function (client) {
    var id = String(psValue_(client, 'client_id') || '').trim();
    if (!id) return;
    var scored = psScoreIdentity_(input, client, byClient[id] || []);
    if (scored.confident) hits.push({ client: client, score: scored.score, reasons: scored.reasons });
  });

  hits.sort(function (a, b) { return b.score - a.score; });
  if (!hits.length) return null;
  if (hits.length > 1 && hits[0].score === hits[1].score) return null;
  return hits[0].client;
}

function psLocationWire_(l) {
  return {
    location_id: String(psValue_(l, 'location_id') || '').trim(),
    client_id: String(psValue_(l, 'client_id') || '').trim(),
    pool_id: String(psValue_(l, 'pool_id') || '').trim(),
    service_address: String(psValue_(l, 'service_address') || '').trim(),
    city: String(psValue_(l, 'city') || '').trim(),
    state: String(psValue_(l, 'state') || '').trim(),
    zip_code: String(psValue_(l, 'zip_code') || '').trim(),
    area: String(psValue_(l, 'area') || '').trim(),
    active: psActive_(psValue_(l, 'active'))
  };
}

function psSearchScore_(query, client, locations) {
  var q = psText_(query);
  var qPhone = psPhone_(query);
  var qEmail = psEmail_(query);
  var qAddress = psAddress_(query);
  var score = 0, reasons = [];

  var id = String(psValue_(client, 'client_id') || '').trim();
  var name = psClientName_(client);
  var email = psEmail_(psValue_(client, 'email'));
  var phone = psPhone_(psValue_(client, 'phone'));
  var clientHay = psText_([
    id, name, psValue_(client, 'first_name'), psValue_(client, 'last_name'),
    psValue_(client, 'email'), psValue_(client, 'phone'), psValue_(client, 'status')
  ].join(' '));

  if (!q) return { matched: false, score: 0, reasons: [] };
  if (id && psText_(id) === q) { score += 200; reasons.push('client_id'); }
  if (qEmail && email && qEmail === email) { score += 150; reasons.push('email'); }
  if (qPhone && qPhone.length >= 7 && phone && phone.indexOf(qPhone) !== -1) { score += 140; reasons.push('phone'); }
  if (clientHay.indexOf(q) !== -1) { score += 80; reasons.push('name'); }

  (locations || []).forEach(function (l) {
    var zip = String(psValue_(l, 'zip_code') || '').trim();
    var locHay = psText_([
      psValue_(l, 'location_id'), psValue_(l, 'pool_id'), psValue_(l, 'service_address'),
      psValue_(l, 'city'), psValue_(l, 'state'), zip, psValue_(l, 'area')
    ].join(' '));
    if (locHay.indexOf(q) !== -1 || (qAddress && psAddress_(psValue_(l, 'service_address')).indexOf(qAddress) !== -1)) {
      score += 55;
      reasons.push('location');
    }
    if (q && zip && q === psText_(zip)) {
      score += 45;
      reasons.push('zip');
    }
    if (psValue_(l, 'pool_id')) score += 2;
  });

  return { matched: score > 0, score: score, reasons: reasons };
}

function searchPeople_(payload) {
  var q = String((payload && (payload.q || payload.search)) || '').trim();
  var limit = Math.max(1, Math.min(50, Number(payload && payload.limit) || 12));
  if (q.length < 2) return { ok: true, people: [] };

  var clients = psRows_('Clients', MCPS_CLIENT_HEADERS);
  var locations = psRows_('Client_Locations', MCPS_LOCATION_HEADERS);
  var byClient = psLocationsByClient_(locations);
  var results = [];

  clients.forEach(function (client) {
    var id = String(psValue_(client, 'client_id') || '').trim();
    if (!id) return;
    var locs = byClient[id] || [];
    var scored = psSearchScore_(q, client, locs);
    if (!scored.matched) return;
    var activeLocs = locs.filter(function (l) { return psActive_(psValue_(l, 'active')); });
    results.push({
      client_id: id,
      display_name: psClientName_(client),
      first_name: String(psValue_(client, 'first_name') || '').trim(),
      last_name: String(psValue_(client, 'last_name') || '').trim(),
      email: String(psValue_(client, 'email') || '').trim(),
      phone: String(psValue_(client, 'phone') || '').trim(),
      status: String(psValue_(client, 'status') || '').trim(),
      locations: locs.map(psLocationWire_),
      location_count: locs.length,
      active_location_count: activeLocs.length,
      score: scored.score,
      match_reasons: scored.reasons.filter(function (x, i, a) { return a.indexOf(x) === i; })
    });
  });

  results.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.display_name || '').localeCompare(String(b.display_name || ''));
  });
  return { ok: true, people: results.slice(0, limit) };
}

function handleSearchPeople_(payload) {
  try {
    return searchPeople_(payload || {});
  } catch (e) {
    return { ok: false, error: 'handleSearchPeople_ Error: ' + e };
  }
}
