// The portal's own data as lifecycle contacts (pure). api/email.js → op=crm reads
// the sheets and hands the rows here. PLAN.md → Plan changes 2026-11-11
// "Connected to the portal's own data".
//
//   leadBreakdown(quotes, engineContacts)       what the Sales Hub holds, to define "MCP leads"
//   leadCandidates(quotes, rule)                Sales Hub leads matching the saved rule, as import contacts
//   customerEmails(quotes, clients)             everyone who is already a customer (never given the MCP intro)
//   startupContacts(quotes, visits, today)      startups with their live date; and the ones cancelled
const norm = v => String(v == null ? '' : v).trim();
const low = v => norm(v).toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const yes = v => /^(y|yes|true|1)$/i.test(norm(v));
const CLOSED = new Set(['LOST', 'EXPIRED']);

function nameOf(q) {
  let first = norm(q.first_name), last = norm(q.last_name);
  if (!first && !last) {
    const full = norm(q.client_name || q.customer_name).split(/\s+/);
    first = full.shift() || ''; last = full.join(' ');
  }
  return { first_name: first, last_name: last };
}
const sourceOf = q => low(q.lead_source).split(':')[0] || 'unknown';
// Which Sales Hub leads are MCP's (Mau, 2026-11-11: "all imported leads"). Import
// Leads was the only thing that made LEAD rows before lead_source existed
// (2026-08-25), so a LEAD with no source is an old import. Since then imports say
// 'import', and the import screen asks: 'mcp' or 'other_list'. Service requests and
// one-time jobs always record their own source, so they never match.
export const MCP_LEAD_SOURCES = ['mcp', 'import', 'unknown'];
export const DEFAULT_MCP_RULE = { statuses: ['LEAD'], lead_sources: MCP_LEAD_SOURCES, year_built: 'any', areas: [], group: 'B' };
const isLeadRow = q => norm(q.status).toUpperCase() === 'LEAD';

// rule: { statuses: ['LEAD'], lead_sources: ['import'], year_built: 'any'|'with'|'without', areas: [] }
export function matchesRule(q, rule = {}) {
  const statuses = (rule.statuses && rule.statuses.length ? rule.statuses : ['LEAD']).map(s => s.toUpperCase());
  if (!statuses.includes(norm(q.status).toUpperCase())) return false;
  if (rule.lead_sources && rule.lead_sources.length && !rule.lead_sources.includes(sourceOf(q))) return false;
  if (rule.year_built === 'with' && !norm(q.year_built)) return false;
  if (rule.year_built === 'without' && norm(q.year_built)) return false;
  if (rule.areas && rule.areas.length && !rule.areas.map(low).includes(low(q.area))) return false;
  return EMAIL.test(low(q.email));
}

export function leadBreakdown(quotes, engineContacts) {
  const inEngine = new Set((engineContacts || []).map(c => low(c.email_norm)));
  const linked = new Set((engineContacts || []).map(c => norm(c.quote_id)).filter(Boolean));
  const out = { leads: 0, with_email: 0, in_engine: 0, by_source: {}, by_status: {}, year_built: { with: 0, without: 0 }, by_area: {} };
  (quotes || []).forEach(q => {
    const st = norm(q.status).toUpperCase() || 'BLANK';
    out.by_status[st] = (out.by_status[st] || 0) + 1;
    if (!isLeadRow(q)) return;
    out.leads++;
    if (EMAIL.test(low(q.email))) out.with_email++;
    if (inEngine.has(low(q.email)) || linked.has(norm(q.quote_id))) out.in_engine++;
    const src = sourceOf(q); out.by_source[src] = (out.by_source[src] || 0) + 1;
    out.year_built[norm(q.year_built) ? 'with' : 'without']++;
    const a = norm(q.area).toUpperCase() || '—'; out.by_area[a] = (out.by_area[a] || 0) + 1;
  });
  return out;
}

export function leadCandidates(quotes, rule) {
  const seen = new Set();
  return (quotes || []).filter(q => matchesRule(q, rule)).map((q, i) => {
    const email = low(q.email);
    if (seen.has(email)) return null;            // the same person twice in the Sales Hub: first row wins
    seen.add(email);
    return { row: i + 1, email_norm: email, ...nameOf(q), phone: norm(q.phone), address: norm(q.address), city: norm(q.city),
      zip: norm(q.zip_code), area: norm(q.area), pool_build_year: norm(q.year_built).slice(0, 4), notes: norm(q.pool_info).slice(0, 500),
      quote_id: norm(q.quote_id), source: 'sales_hub' + (sourceOf(q) !== 'unknown' ? ':' + sourceOf(q) : '') };
  }).filter(Boolean);
}

// For the import check's "already a customer" rule: Clients plus any Quotes row that is a customer.
export function customerEmails(quotes, clients) {
  const out = (clients || []).filter(c => c.email).map(c => ({ email: c.email, status: c.status }));
  (quotes || []).forEach(q => {
    if (/^(ACTIVE_CUSTOMER|PAUSED|COMPLETED_JOB)$/i.test(norm(q.status)) && EMAIL.test(low(q.email))) out.push({ email: q.email, status: 'active' });
  });
  return out;
}

const isStartup = q => low(q.service_key) === 'pool_startup' || /pool startup/i.test(norm(q.service));
const addDays = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const OFFSET = { startup_day_1: 0, startup_day_2: -1, startup_day_3: -2 };
const GONE = new Set(['cancelled', 'removed', 'skipped']);

// Live startup date per pool from the schedule: day 1, worked back from any startup day still on it.
export function startupDates(visits) {
  const out = {};
  (visits || []).forEach(v => {
    const off = OFFSET[norm(v.visit_type)], pool = norm(v.pool_id), d = norm(v.scheduled_date).slice(0, 10);
    if (off === undefined || !pool || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    const rec = out[pool] = out[pool] || { day1: '', live: 0, gone: 0 };
    if (GONE.has(low(v.status))) { rec.gone++; return; }
    rec.live++;
    const day1 = addDays(d, off);
    if (!rec.day1 || day1 < rec.day1) rec.day1 = day1;
  });
  return out;
}

// today: local YYYY-MM-DD. Startups from 33 days ago on (the last C email is startup +28, window 5).
export function startupContacts(quotes, visits, today) {
  const dates = startupDates(visits), since = addDays(today, -33);
  const contacts = [], removed = [], skipped = [];
  (quotes || []).filter(isStartup).forEach(q => {
    const pool = norm(q.pool_id), qid = norm(q.quote_id), email = low(q.email);
    if (!pool || !qid) return;                                  // not activated yet (no start date)
    const sched = dates[pool];
    const cancelled = CLOSED.has(norm(q.status).toUpperCase()) || (sched && !sched.live && sched.gone);
    if (cancelled) { removed.push({ quote_id: qid, pool_id: pool, reason: CLOSED.has(norm(q.status).toUpperCase()) ? 'quote_' + norm(q.status).toLowerCase() : 'visits_cancelled' }); return; }
    const fromSchedule = sched && sched.day1;
    const startup = fromSchedule || norm(q.startup_start_date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startup)) { skipped.push({ quote_id: qid, reason: 'no_startup_date' }); return; }
    if (startup < since) return;                                // its emails are all past
    if (!EMAIL.test(email)) { skipped.push({ quote_id: qid, reason: 'no_email' }); return; }
    contacts.push({ quote_id: qid, pool_id: pool, email_norm: email, ...nameOf(q), phone: norm(q.phone),
      address: [norm(q.address), norm(q.city)].filter(Boolean).join(', '), city: norm(q.city), zip: norm(q.zip_code), area: norm(q.area),
      startup_date: startup, startup_source: fromSchedule ? 'schedule' : 'quote', pool_school: yes(q.startup_pool_school) ? 'Y' : 'N' });
  });
  return { contacts, removed, skipped };
}
