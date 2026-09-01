// ══════════════════════════════════════════════════════════════════════════════
// IDENTITY MATCHING — is this person already in the CRM?
//
// A port of psScoreIdentity_ / findConfidentClientForQuote_ from
// appscript/PeopleSearch.js, which lives only on the unmerged working branch.
// The rule from that file's header is the whole design and is preserved exactly:
//
//   "Search can be generous; automatic linking must be conservative.
//    Email-only or phone-only is a useful candidate, but not enough to
//    silently merge a new quote into an existing person."
//
// Two-signal confidence, and a TIE REFUSES TO MATCH. Both matter. The tie rule
// is the one that is tempting to drop — if two rows score identically we cannot
// tell which person this is, and picking the first is picking at random.
//
// This module is pure: no fetch, no sheet access, no Date.now(). Callers pass in
// rows; that is what makes it testable without a spreadsheet.
//
// ⚠️ This decides whether a HUMAN is shown a suggested match. It never links
// anything by itself. Nothing downstream may treat `confident` as permission to
// write to the CRM.
// ══════════════════════════════════════════════════════════════════════════════

// ── Normalisers ─────────────────────────────────────────────────────────────

export function normEmail(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

// Digits only, and the US country code dropped. '+1 (210) 555-0142' and
// '2105550142' are the same phone; storing whichever the customer typed and
// comparing raw is how the same person fails to match themselves.
export function normPhone(value) {
  const digits = String(value == null ? '' : value).replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

export function normName(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/\s+/g, ' ').trim();
}

// Street-suffix folding, ported from normAddress in api/_repo/quote-write.js.
// Its comment there is worth repeating: "'123 Pool Ln' and '123 pool lane.' are
// the same property and creating a second location for it is how one customer
// ends up with two pool_ids and a phantom stop on the route board."
const STREET_SUFFIXES = {
  street: 'st', str: 'st', st: 'st',
  avenue: 'ave', av: 'ave', ave: 'ave',
  road: 'rd', rd: 'rd',
  drive: 'dr', dr: 'dr',
  lane: 'ln', ln: 'ln',
  court: 'ct', ct: 'ct',
  circle: 'cir', cir: 'cir',
  boulevard: 'blvd', blvd: 'blvd',
  place: 'pl', pl: 'pl',
  trail: 'trl', trl: 'trl',
  parkway: 'pkwy', pkwy: 'pkwy',
  highway: 'hwy', hwy: 'hwy',
  terrace: 'ter', ter: 'ter',
  way: 'way', cove: 'cv', cv: 'cv',
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw'
};

export function normAddress(value) {
  const base = String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!base) return '';
  return base.split(' ')
    .map(token => STREET_SUFFIXES[token] || token)
    .join(' ');
}

// ── Scoring ─────────────────────────────────────────────────────────────────

// Weights are carried over verbatim from PeopleSearch.js. They are not
// arbitrary: email and phone are the strongest because a person supplies them
// deliberately; address is next because two people can share it (spouses) but
// rarely by accident; name is weakest because two Tony Sillers exist.
export const WEIGHTS = { email: 40, phone: 40, address: 35, name: 30 };

export function buildInput(raw) {
  const r = raw || {};
  const first = normName(r.first_name);
  const last = normName(r.last_name);
  return {
    first,
    last,
    name: normName(r.name) || [first, last].filter(Boolean).join(' '),
    email: normEmail(r.email),
    phone: normPhone(r.phone),
    address: normAddress(r.address || r.service_address),
    zip: String(r.zip_code == null ? '' : r.zip_code).trim()
  };
}

function nameMatches(input, candidate) {
  const first = normName(candidate.first_name);
  const last = normName(candidate.last_name);
  const display = normName(candidate.display_name) ||
    [first, last].filter(Boolean).join(' ');
  if (input.first && input.last) return first === input.first && last === input.last;
  if (input.name && display) return display === input.name;
  return false;
}

// A candidate's addresses: for a Clients row these come from Client_Locations;
// for a Quotes row the address is on the row itself. Both shapes are accepted so
// one scorer serves both tables.
function addressMatches(input, addresses) {
  if (!input.address) return false;
  for (const addr of addresses || []) {
    const value = normAddress(addr && addr.address);
    if (!value || value !== input.address) continue;
    // A ZIP that disagrees is a different property with a coincidentally
    // similar street line. Only vetoes when BOTH sides have one.
    const zip = String((addr && addr.zip) == null ? '' : addr.zip).trim();
    if (input.zip && zip && zip !== input.zip) continue;
    return true;
  }
  return false;
}

export function scoreIdentity(input, candidate, addresses) {
  const emailMatch = !!(input.email && normEmail(candidate.email) === input.email);
  const phoneMatch = !!(input.phone && normPhone(candidate.phone) === input.phone);
  const nameMatch = nameMatches(input, candidate);
  const addressMatch = addressMatches(input, addresses);

  let score = 0;
  const reasons = [];
  if (emailMatch)   { score += WEIGHTS.email;   reasons.push('email'); }
  if (phoneMatch)   { score += WEIGHTS.phone;   reasons.push('phone'); }
  if (addressMatch) { score += WEIGHTS.address; reasons.push('address'); }
  if (nameMatch)    { score += WEIGHTS.name;    reasons.push('name'); }

  // Any TWO independent signals. Written as a count rather than the six explicit
  // pairs in the original so adding a seventh signal later cannot silently miss
  // a combination.
  const signals = [emailMatch, phoneMatch, addressMatch, nameMatch].filter(Boolean).length;

  return { score, reasons, confident: signals >= 2, signals };
}

// ── The decision ────────────────────────────────────────────────────────────

/**
 * @param {object} submitted            raw request fields from the customer
 * @param {object[]} clients            Clients rows
 * @param {object[]} locations          Client_Locations rows
 * @param {object[]} quotes             Quotes rows
 * @returns {{status, match, candidates}}
 *   status     'confident' | 'ambiguous' | 'none'
 *   match      the single winning candidate, or null
 *   candidates top 3 scored candidates, always populated when anything scored
 */
export function findMatch(submitted, clients, locations, quotes) {
  const input = buildInput(submitted);

  // Nothing to match on. Two blank fields would otherwise "agree" with every
  // blank row in the sheet and confidently match a stranger.
  if (!input.email && !input.phone && !input.address && !input.name) {
    return { status: 'none', match: null, candidates: [], input };
  }

  const locationsByClient = new Map();
  for (const loc of locations || []) {
    const key = String(loc.client_id || '').trim();
    if (!key) continue;
    if (!locationsByClient.has(key)) locationsByClient.set(key, []);
    locationsByClient.get(key).push({
      address: loc.service_address,
      zip: loc.zip_code,
      location_id: loc.location_id,
      pool_id: loc.pool_id
    });
  }

  const scored = [];

  for (const client of clients || []) {
    const id = String(client.client_id || '').trim();
    if (!id) continue;
    const addresses = locationsByClient.get(id) || [];
    // A Clients row has no address of its own; billing_address is a mailing
    // address and is deliberately not treated as the service address.
    const result = scoreIdentity(input, client, addresses);
    if (!result.score) continue;
    const hit = addresses.find(a => normAddress(a.address) === input.address);
    scored.push({
      kind: 'client',
      client_id: id,
      quote_id: '',
      location_id: hit ? String(hit.location_id || '') : '',
      pool_id: hit ? String(hit.pool_id || '') : '',
      display: String(client.display_name || '').trim() ||
        [client.first_name, client.last_name].filter(Boolean).join(' ').trim(),
      email: String(client.email || '').trim(),
      phone: String(client.phone || '').trim(),
      address: hit ? String(hit.address || '').trim() : '',
      status: String(client.status || '').trim(),
      ...result
    });
  }

  // Quotes are scored too, and this is not redundant. The MCP past clients are
  // LEAD rows on Quotes; many have no Clients row at all, so a client-only
  // search would report "no match" for exactly the people this campaign targets.
  for (const quote of quotes || []) {
    const qid = String(quote.quote_id || '').trim();
    if (!qid) continue;
    const addresses = [{ address: quote.address, zip: quote.zip_code, pool_id: quote.pool_id }];
    const result = scoreIdentity(input, quote, addresses);
    if (!result.score) continue;
    scored.push({
      kind: 'quote',
      client_id: String(quote.client_id || '').trim(),
      quote_id: qid,
      location_id: String(quote.location_id || '').trim(),
      pool_id: String(quote.pool_id || '').trim(),
      display: [quote.first_name, quote.last_name].filter(Boolean).join(' ').trim(),
      email: String(quote.email || '').trim(),
      phone: String(quote.phone || '').trim(),
      address: String(quote.address || '').trim(),
      status: String(quote.status || '').trim(),
      ...result
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, 3);
  const confident = scored.filter(c => c.confident);

  if (!confident.length) {
    // Something scored but nothing reached two signals — a lone email hit, say.
    // That is a lead for a human to look at, not a match.
    return { status: scored.length ? 'ambiguous' : 'none', match: null, candidates, input };
  }

  // ⚠️ Collapse rows that describe the SAME PERSON before testing for a tie.
  //
  // This is not an optimisation, it is required for correctness. A returning
  // customer normally has both a Clients row and one or more Quotes rows, and
  // they score identically because they hold identical contact details. Testing
  // for a tie first would call every genuine returning customer "ambiguous" —
  // the matcher would refuse in exactly the case it exists to handle.
  //
  // Two rows are the same person when they agree on a strong identifier. Email
  // first, then phone; falling back to name+address only when neither exists.
  const groups = new Map();
  for (const c of confident) {
    const key = normEmail(c.email) || normPhone(c.phone) ||
      (normName(c.display) + '|' + normAddress(c.address));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  // Each group's representative carries the best score in the group and the
  // union of its ids, because pool_id often lives on the Quotes row while the
  // canonical client_id lives on the Clients row, and scheduling needs both.
  const merged = [...groups.values()].map(rows => {
    const best = rows.reduce((a, b) => (b.score > a.score ? b : a));
    const pick = field => best[field] || (rows.find(r => r[field]) || {})[field] || '';
    return {
      ...best,
      client_id: pick('client_id'),
      quote_id: pick('quote_id'),
      location_id: pick('location_id'),
      pool_id: pick('pool_id'),
      // An ACTIVE_CUSTOMER status anywhere in the group wins: it is the fact the
      // console must surface, and a stale LEAD row must not mask it.
      status: rows.map(r => r.status).find(st => String(st).toUpperCase() === 'ACTIVE_CUSTOMER') || best.status,
      matched_rows: rows.map(r => ({ kind: r.kind, id: r.quote_id || r.client_id, score: r.score }))
    };
  }).sort((a, b) => b.score - a.score);

  // ⚠️ THE TIE RULE. Two DIFFERENT people scoring equally means we cannot tell
  // which one this is, and choosing the first is choosing at random. Refusing
  // sends it to a human, which is the correct outcome and the entire reason this
  // function is conservative. Do not "fix" this by taking [0].
  if (merged.length > 1 && merged[0].score === merged[1].score) {
    return { status: 'ambiguous', match: null, candidates, input };
  }

  return { status: 'confident', match: merged[0], candidates, input };
}
