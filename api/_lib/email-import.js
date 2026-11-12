// Import check (pure): what happens to each incoming contact, before anything is
// written. Run on the server against the engine's contacts, the shared opt-out
// list and the portal's clients; the save step runs it again, so the browser's
// copy of the verdicts is never trusted (api/email.js → op=import).
//
// Rules: email-engine/docs/PLAN.md → Plan changes 2026-11-10 (duplicate protection).
//   new            imported into Needs review
//   existing       same email already in the engine → skipped
//   same_person    same name and street as an engine contact with another email → held for review
//   customer       already an MCPS customer (flag in the file, or an active portal client) → not given the MCP intro
//   opted_out      unsubscribed or bounced in Comms_Optouts → skipped
//   do_not_contact marked in the file → skipped, and added to the opt-out list on save
// A portal prospect (a Sales Hub lead) is imported normally, with a note.

const norm = v => String(v || '').trim().toLowerCase();
const words = v => norm(v).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
// Name + the first part of the street: "Maria Lopez|118 canyon oak"
function personKey(c) {
  const street = words(String(c.address || '').split(',')[0]);
  const name = words([c.first_name, c.last_name].join(' '));
  return name && street ? name + '|' + street : '';
}

// sources: { engineContacts: [{email_norm, alt_emails, first_name, last_name, address, contact_id}],
//            optouts: [{email, removed_at}], clients: [{email, status}] }
export function checkImport(contacts, sources, opts = {}) {
  const group = opts.group || 'B';
  const engineEmails = new Map(), enginePeople = new Map();
  (sources.engineContacts || []).forEach(c => {
    [c.email_norm].concat(String(c.alt_emails || '').split(',')).map(norm).filter(Boolean).forEach(e => engineEmails.set(e, c));
    const k = personKey(c); if (k) enginePeople.set(k, c);
  });
  const optedOut = new Set((sources.optouts || []).filter(o => !String(o.removed_at || '').trim()).map(o => norm(o.email)));
  const clients = new Map((sources.clients || []).filter(c => c.email).map(c => [norm(c.email), norm(c.status)]));

  const rows = contacts.map(c => {
    const email = norm(c.email_norm);
    const base = { row: c.row, email_norm: email, first_name: c.first_name || '', last_name: c.last_name || '' };
    if (c.do_not_contact) return { ...base, status: 'do_not_contact' };
    if (optedOut.has(email)) return { ...base, status: 'opted_out' };
    if (engineEmails.has(email)) return { ...base, status: 'existing', contact_id: engineEmails.get(email).contact_id };
    const client = clients.get(email);
    if (group === 'B' && (c.current_customer || client === 'active')) return { ...base, status: 'customer', reason: c.current_customer ? 'marked in the file' : 'active portal client' };
    const twin = enginePeople.get(personKey(c));
    if (twin) return { ...base, status: 'same_person', contact_id: twin.contact_id, other_email: twin.email_norm };
    return { ...base, status: 'new', note: client === 'prospect' ? 'Sales Hub lead' : '' };
  });
  const summary = {};
  rows.forEach(r => { summary[r.status] = (summary[r.status] || 0) + 1; });
  return { rows, summary };
}

// The fields the engine stores for an imported contact (anything else in the payload is dropped).
export function importRecord(c, opts = {}) {
  return {
    email_norm: norm(c.email_norm), first_name: String(c.first_name || '').slice(0, 60), last_name: String(c.last_name || '').slice(0, 80),
    phone: String(c.phone || '').slice(0, 30), address: String(c.address || '').slice(0, 200), city: String(c.city || '').slice(0, 60),
    state: String(c.state || '').slice(0, 20), zip: String(c.zip || '').slice(0, 12), area: String(c.area || '').slice(0, 60),
    pool_build_year: String(c.pool_build_year || '').slice(0, 4), notes: String(c.notes || '').slice(0, 500),
    tags: (Array.isArray(c.tags) ? c.tags : []).map(t => String(t).slice(0, 40)).slice(0, 20).join(','),
    source: String(opts.source || c.source || '').slice(0, 80),
    // The Sales Hub row it came from (api/_lib/email-crm.js), so the contact links back.
    quote_id: String(c.quote_id || '').slice(0, 20),
    // Cleanup (api/_lib/email-clean.js): the name as typed, couple/family/business, and the contact it may duplicate.
    name_original: String(c.name_original || '').slice(0, 120), name_kind: String(c.name_kind || '').slice(0, 20),
    duplicate_of: String(c.duplicate_of || '').slice(0, 40)
  };
}
