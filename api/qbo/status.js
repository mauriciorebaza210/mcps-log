import { sendJson, validatePortalToken } from '../_sheets.js';
import { getConnectionStatus, getAccountMap, missingBuckets } from './_qbo.js';

// GET /api/qbo/status?token=<portal token>
// Returns connection + whether the account map is complete (drives the UI banner).
export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    const ok = await validatePortalToken(req.query.token);
    if (!ok) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });

    const status = await getConnectionStatus();
    let mapComplete = false;
    let missing = [];
    if (status.connected) {
      const map = await getAccountMap();
      missing = missingBuckets(map);
      mapComplete = missing.length === 0;
    }
    return sendJson(res, 200, { ok: true, ...status, mapComplete, missing });
  } catch (error) {
    console.error('qbo/status failed', error);
    return sendJson(res, 500, { ok: false, error: 'Could not read QuickBooks status.' });
  }
}
