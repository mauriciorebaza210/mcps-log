import { getCached, readSheetRange, rowsToObjects, sendJson, validatePortalToken } from '../_sheets.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    const ok = await validatePortalToken(req.query.token);
    if (!ok) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    const quoteId = String(req.query.quote_id || '').trim();
    if (!quoteId) return sendJson(res, 400, { ok: false, error: 'quote_id required' });

    const row = await getCached(`crm:detail:${quoteId}:v1`, 30 * 1000, async () => {
      const rows = rowsToObjects(await readSheetRange('Quotes'));
      return rows.find(item => String(item.quote_id || '').trim() === quoteId) || null;
    });

    if (!row) return sendJson(res, 404, { ok: false, error: 'Quote not found' });
    if (!row.client_name) row.client_name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
    return sendJson(res, 200, { ok: true, item: row, source: 'sheets_api' }, 15);
  } catch (error) {
    console.error('crm/detail failed', error);
    return sendJson(res, 500, { ok: false, error: error.message || 'CRM detail failed' });
  }
}
