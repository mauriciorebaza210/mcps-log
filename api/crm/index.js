// ══════════════════════════════════════════════════════════════════════════════
// CRM READS — list and detail, in one function
//
//   GET /api/crm?op=list&token=…               the whole CRM, compacted
//   GET /api/crm?op=detail&token=…&quote_id=…  one full row
//
// ⚠️ These were two functions (api/crm/list.js and api/crm/detail.js) until the
// service-request feature needed a slot. The Hobby plan allows 12 serverless
// functions per deployment and the project was already at exactly 12, so one
// had to give. Merging the two smallest and most closely related reads was the
// least invasive way to make room: same queries, same caches, same responses —
// only the entry point changed.
// ══════════════════════════════════════════════════════════════════════════════

import { getCached, readSheetRange, rowsToObjects, sendJson, validatePortalToken } from '../_sheets.js';

const LIST_FIELDS = [
  'quote_id', 'timestamp', 'status', 'contract_status', 'first_name', 'last_name',
  'client_name', 'email', 'phone', 'address', 'city', 'zip_code', 'area',
  'service', 'pool_type', 'pool_id', 'total_with_tax', 'year_built',
  'sponsored_by_mcp', 'proposal_number', 'proposal_pdf_url',
  'proposal_approval_url', 'proposal_sent_at', 'proposal_accepted_at',
  'proposal_declined_at', 'proposal_change_requested_at', 'proposal_response_note',
  'contract_url', 'sent_at', 'invoice_day', 'billing_start', 'service_end'
];

function compact(row) {
  const out = {};
  LIST_FIELDS.forEach(key => {
    if (row[key] !== undefined) out[key] = row[key];
  });
  if (!out.client_name) out.client_name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return out;
}

async function handleList(res) {
  const data = await getCached('crm:list:v1', 45 * 1000, async () => {
    const rows = rowsToObjects(await readSheetRange('Quotes'));
    return rows.filter(row => row.quote_id).map(compact);
  });
  return sendJson(res, 200, { ok: true, data, source: 'sheets_api' }, 30);
}

async function handleDetail(req, res) {
  const quoteId = String(req.query.quote_id || '').trim();
  if (!quoteId) return sendJson(res, 400, { ok: false, error: 'quote_id required' });

  const row = await getCached(`crm:detail:${quoteId}:v1`, 30 * 1000, async () => {
    const rows = rowsToObjects(await readSheetRange('Quotes'));
    return rows.find(item => String(item.quote_id || '').trim() === quoteId) || null;
  });

  if (!row) return sendJson(res, 404, { ok: false, error: 'Quote not found' });
  if (!row.client_name) row.client_name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return sendJson(res, 200, { ok: true, item: row, source: 'sheets_api' }, 15);
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    const ok = await validatePortalToken(req.query.token);
    if (!ok) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });

    // Defaults to list so a caller that omits op behaves as /api/crm/list did.
    const op = String(req.query.op || 'list').trim();
    if (op === 'detail') return await handleDetail(req, res);
    if (op === 'list') return await handleList(res);
    return sendJson(res, 400, { ok: false, error: 'Unknown operation.' });
  } catch (error) {
    console.error('crm read failed', error);
    return sendJson(res, 500, { ok: false, error: error.message || 'CRM read failed' });
  }
}
