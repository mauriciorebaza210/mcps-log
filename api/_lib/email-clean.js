// Cleanup and duplicates on the server (PLAN.md → "Contact cleanup and duplicates").
// Every way contacts come in (file import, MCP leads) runs cleanIncoming → the import
// check → flagDuplicates; the Clean up view runs scanEngine over the engine's contacts.
import CLEAN from '../../js/lib/contact-clean.js';

const live = c => !/^(removed|merged)$/.test(String(c.review_status || '')) && String(c.is_test || '').toUpperCase() !== 'Y' && c.is_test !== true;

// Rows as they'll be saved: names re-cased, couples/families recognised, phones formatted.
// The original name is kept (name_original) whenever the name changed.
export function cleanIncoming(rows) {
  return (rows || []).map(r => {
    const c = CLEAN.cleanContact(r), out = { ...r, ...c.changes };
    if (c.changes.first_name !== undefined || c.changes.last_name !== undefined) out.name_original = [r.first_name, r.last_name].filter(Boolean).join(' ');
    if (c.kind !== 'person') out.name_kind = c.kind;
    out._clean = { flags: c.flags, issues: c.issues, needs_ai: c.needs_ai, kind: c.kind, changed: Object.keys(c.changes) };
    return out;
  });
}

const view = c => ({ contact_id: c.contact_id, name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email_norm, address: c.address || '', city: c.city || '',
  phone: c.phone || '', status: c.review_status || '', bucket: c.bucket || '' });

// After the import check: rows it calls new that look like an engine contact (same inbox,
// same household, a similar name at the same address) or like another row in the same
// file become possible_duplicate, with the match to compare against.
export function flagDuplicates(verdictRows, cleaned, engineContacts) {
  const engine = (engineContacts || []).filter(live);
  const byRow = new Map(cleaned.map(c => [Number(c.row), c]));
  const fresh = verdictRows.filter(r => r.status === 'new').map(r => byRow.get(Number(r.row))).filter(Boolean);
  const hits = new Map();
  CLEAN.duplicates(fresh, engine).forEach(p => hits.set(Number(p.a.row), { ...view(p.b), reason: p.reason, confidence: p.confidence }));
  // Two rows of the same file for the same household: the later one is flagged.
  const earlier = [];
  fresh.forEach(r => {
    if (hits.has(Number(r.row))) return;
    const p = CLEAN.duplicates([r], earlier)[0];
    if (p) hits.set(Number(r.row), { name: [p.b.first_name, p.b.last_name].filter(Boolean).join(' '), email: p.b.email_norm, address: p.b.address || '', row: p.b.row, reason: p.reason, confidence: p.confidence, in_file: true });
    earlier.push(r);
  });
  return verdictRows.map(r => {
    const c = byRow.get(Number(r.row)) || {};
    const base = { ...r, first_name: c.first_name || r.first_name, last_name: c.last_name || r.last_name, clean: c._clean };
    if (r.status === 'new' && hits.has(Number(r.row))) return { ...base, status: 'possible_duplicate', match: hits.get(Number(r.row)) };
    if (r.status === 'same_person') {
      const m = engine.find(e => e.contact_id === r.contact_id);
      return { ...base, match: m ? { ...view(m), reason: 'same_person', confidence: 'high' } : null };
    }
    if (r.status === 'existing') {
      const m = engine.find(e => e.contact_id === r.contact_id);
      return { ...base, match: m ? { ...view(m), reason: 'same_email', confidence: 'high' } : null };
    }
    return base;
  });
}

// The Clean up view: names the rules would change (or want the AI to look at), email
// warnings, and possible duplicates among the engine's own contacts.
export function scanEngine(engineContacts) {
  const engine = (engineContacts || []).filter(live);
  const names = [];
  engine.forEach(c => {
    const r = CLEAN.cleanContact(c);
    const reviewed = !!String(c.name_kind || '').trim();
    const wantsAi = r.needs_ai && !reviewed;
    if (!Object.keys(r.changes).length && !wantsAi && !r.issues.length) return;
    names.push({ ...view(c), first_name: c.first_name || '', last_name: c.last_name || '', after: r.changes, kind: r.kind, flags: r.flags, needs_ai: wantsAi, issues: r.issues });
  });
  const pairs = CLEAN.duplicates(engine, engine, { symmetric: true })
    .filter(p => {
      const no = String(p.a.not_duplicate_of || '').split(',').concat(String(p.b.not_duplicate_of || '').split(','));
      return no.indexOf(p.a.contact_id) === -1 && no.indexOf(p.b.contact_id) === -1;
    })
    .map(p => ({ a: view(p.a), b: view(p.b), reason: p.reason, confidence: p.confidence }));
  // Possible duplicates saved by the automatic sync, against the contact they matched.
  engine.filter(c => c.review_status === 'possible_duplicate' && c.duplicate_of).forEach(c => {
    const m = engine.find(e => e.contact_id === c.duplicate_of);
    if (m && !pairs.some(p => [p.a.contact_id, p.b.contact_id].sort().join() === [c.contact_id, m.contact_id].sort().join())) pairs.push({ a: view(m), b: view(c), reason: 'possible_duplicate', confidence: 'medium' });
  });
  return { names, pairs };
}
