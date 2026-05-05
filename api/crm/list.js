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

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    const ok = await validatePortalToken(req.query.token);
    if (!ok) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });

    const data = await getCached('crm:list:v1', 45 * 1000, async () => {
      const rows = rowsToObjects(await readSheetRange('Quotes'));
      return rows.filter(row => row.quote_id).map(compact);
    });

    return sendJson(res, 200, { ok: true, data, source: 'sheets_api' }, 30);
  } catch (error) {
    console.error('crm/list failed', error);
    return sendJson(res, 500, { ok: false, error: error.message || 'CRM list failed' });
  }
}
