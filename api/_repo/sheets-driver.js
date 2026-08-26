// ══════════════════════════════════════════════════════════════════════════════
// SHEETS DRIVER — turns a plan from quote-write.js into HTTP calls
//
// This is the ONLY file that knows the store is a spreadsheet. The planner emits
// inserts and updates as plain data; swapping this for a Postgres driver is the
// whole migration, and nothing above it changes.
//
// Cost of one save:
//   1  values:batchGet      all seven tabs at once
//   0-1 values:batchUpdate  header repair, only when a column is genuinely missing
//   n  values:append        one per tab receiving rows (Google allocates the row)
//   0-1 values:batchUpdate  every changed row, all ranges in one request
//
// ~5-9 requests. The Apps Script path it replaces spent 150-300 Sheets operations
// on the same work, most of them re-reading a header row it had already read.
// ══════════════════════════════════════════════════════════════════════════════

import {
  readSheetRanges, appendSheetRows, writeSheetRanges,
  rowsToObjects, normalizeHeader, a1, crmSpreadsheetId
} from '../_sheets.js';
import { ENTITIES, COMPAT_SHEET, QUOTE_CONTEXT_RANGES, entityBySheet } from './schema.js';

// Every column the write path may set, per tab. Used to repair a tab that is
// missing one — writing a value into a column that does not exist is a silent
// drop, which is how `scope_items_json` went missing for months before anyone
// added ensureColumn_ on the Apps Script side.
function declaredColumns(sheet) {
  if (sheet === COMPAT_SHEET) return null;   // legacy tab: never restructured
  const e = entityBySheet(sheet);
  return e ? e.columns : null;
}

export async function loadQuoteContext(extraRanges = []) {
  const ranges = QUOTE_CONTEXT_RANGES.concat(extraRanges);
  const raw = await readSheetRanges(ranges);

  const headers = {}, rows = {}, rowCount = {};
  ranges.forEach(sheet => {
    const values = raw[sheet] || [];
    headers[sheet] = (values[0] || []).map(normalizeHeader);
    rows[sheet] = rowsToObjects(values).map((obj, i) => Object.assign(obj, { _row: i + 2 }));
    rowCount[sheet] = values.length;   // includes the header row
  });
  return { headers, rows, rowCount };
}

// The planner works against plain arrays keyed by sheet name.
export function toSnapshot(ctx) {
  const snap = {};
  Object.keys(ctx.rows).forEach(sheet => { snap[sheet] = ctx.rows[sheet]; });
  return snap;
}

// Any tab whose header row is missing a declared column, with the repaired row.
function headerRepairs(ctx) {
  const repairs = [];
  Object.keys(ctx.headers).forEach(sheet => {
    const declared = declaredColumns(sheet);
    if (!declared) return;
    const have = ctx.headers[sheet];
    const missing = declared.filter(c => have.indexOf(normalizeHeader(c)) === -1);
    if (!missing.length) return;
    const merged = have.concat(missing.map(normalizeHeader));
    repairs.push({ sheet, missing, merged });
  });
  return repairs;
}

function rowFromObject(headerList, obj) {
  return headerList.map(h => {
    const v = obj[h];
    return v === undefined || v === null ? '' : v;
  });
}

export async function commitPlan(plan, ctx, opts = {}) {
  const spreadsheetId = opts.spreadsheetId || crmSpreadsheetId();
  const stats = { batchGets: 0, headerRepairs: 0, appends: 0, rowUpdates: 0, requests: 0 };

  // ── 1. Repair header rows first, so appended rows align to real columns ────
  const repairs = headerRepairs(ctx);
  if (repairs.length) {
    await writeSheetRanges(repairs.map(r => ({
      range: a1(r.sheet, 0, 1, r.merged.length - 1),
      values: [r.merged]
    })), spreadsheetId);
    repairs.forEach(r => { ctx.headers[r.sheet] = r.merged; });
    stats.headerRepairs = repairs.reduce((n, r) => n + r.missing.length, 0);
    stats.requests += 1;
  }

  // ── 2. Inserts, one request per tab. append lets Google allocate the row,
  //       which is what keeps two simultaneous saves from claiming the same one.
  const insertSheets = Object.keys(plan.inserts || {});
  for (const sheet of insertSheets) {
    const list = plan.inserts[sheet] || [];
    if (!list.length) continue;
    const headerList = ctx.headers[sheet] || [];
    if (!headerList.length) throw new Error('Sheet has no header row: ' + sheet);
    await appendSheetRows(sheet, list.map(obj => rowFromObject(headerList, obj)), spreadsheetId);
    stats.appends += 1;
    stats.requests += 1;
  }

  // ── 3. The compatibility export ───────────────────────────────────────────
  if (plan.compat) {
    const headerList = ctx.headers[COMPAT_SHEET] || [];
    if (!headerList.length) throw new Error('Quotes sheet has no header row');
    // Columns the legacy tab does not have are dropped deliberately: this row is
    // an export for existing readers, not a place to grow the schema.
    await appendSheetRows(COMPAT_SHEET, [rowFromObject(headerList, plan.compat)], spreadsheetId);
    stats.appends += 1;
    stats.requests += 1;
  }

  // ── 4. Updates: whole rows, all ranges in one request ──────────────────────
  // A full-row write rather than per-cell, because one range per changed row is
  // a single batch entry, while per-cell would be one entry per field.
  const rowUpdates = [];
  (plan.updates || []).forEach(u => {
    const sheet = u.sheet;
    const headerList = ctx.headers[sheet] || [];
    if (!headerList.length) return;
    const idCol = u.idColumn || (entityBySheet(sheet) || {}).id;
    const existing = (ctx.rows[sheet] || []).find(r => String(r[idCol] || '').trim() === String(u.id).trim());
    if (!existing) return;   // nothing to update; the insert path covers new rows
    const merged = Object.assign({}, existing, u.patch);
    delete merged._row;
    rowUpdates.push({
      range: a1(sheet, 0, existing._row, headerList.length - 1),
      values: [rowFromObject(headerList, merged)]
    });
    // Keep the in-memory snapshot truthful in case a caller plans again.
    Object.assign(existing, u.patch);
  });
  if (rowUpdates.length) {
    await writeSheetRanges(rowUpdates, spreadsheetId);
    stats.rowUpdates = rowUpdates.length;
    stats.requests += 1;
  }

  return stats;
}

// Read one quote back, joined across the relational tabs. This is what makes a
// saved quote reopenable — there was no `get_quote` action anywhere in the
// backend, so everything the quote tool rendered after a save existed only in
// that browser tab's memory.
export function hydrateQuote(snapshot, quoteId) {
  const qid = String(quoteId || '').trim();
  if (!qid) return null;

  const proposal = (snapshot[ENTITIES.proposals.sheet] || [])
    .find(r => String(r.legacy_quote_id || '').trim() === qid);
  if (!proposal) return null;

  const byId = (sheet, col, val) =>
    (snapshot[sheet] || []).find(r => String(r[col] || '').trim() === String(val || '').trim()) || null;

  const client = byId(ENTITIES.clients.sheet, 'client_id', proposal.client_id);
  const location = byId(ENTITIES.locations.sheet, 'location_id', proposal.location_id);
  const items = (snapshot[ENTITIES.proposalItems.sheet] || [])
    .filter(r => String(r.proposal_id || '').trim() === String(proposal.proposal_id || '').trim())
    .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));

  // ⚠️ Originals only. Parent and amendments share source_quote_id, so taking the
  // first match can hand back an amendment — a bug that was fixed in five places
  // on the Apps Script side and must not be reintroduced here.
  const agreements = (snapshot[ENTITIES.agreements.sheet] || [])
    .filter(r => String(r.source_quote_id || '').trim() === qid);
  const original = agreements.find(r => {
    const type = String(r.agreement_type || '').trim().toLowerCase();
    return type === '' || type === 'original';
  }) || null;
  const amendments = agreements.filter(r => String(r.agreement_type || '').trim().toLowerCase() === 'amendment');

  const serviceAccount = (snapshot[ENTITIES.serviceAccounts.sheet] || [])
    .find(r => String(r.source_quote_id || '').trim() === qid) || null;

  return { quote_id: qid, proposal, client, location, items, agreement: original, amendments, service_account: serviceAccount };
}
