import { sendJson, requireAdminPortalToken } from '../_sheets.js';
import { getAccountMap, saveAccountMap, missingBuckets, REQUIRED_BUCKETS } from './_qbo.js';

// GET  /api/qbo/map?token=<admin>           → current bucket→account map
// POST /api/qbo/map  { token, map }         → save the map (full replace)
export default async function handler(req, res) {
  try {
    const session = await requireAdminPortalToken(req, res);
    if (!session) return;

    if (req.method === 'GET') {
      const map = await getAccountMap();
      return sendJson(res, 200, { ok: true, map, buckets: REQUIRED_BUCKETS, missing: missingBuckets(map) });
    }
    if (req.method === 'POST') {
      const incoming = (req.body && req.body.map) || {};
      const saved = await saveAccountMap(incoming);
      return sendJson(res, 200, { ok: true, map: saved, missing: missingBuckets(saved) });
    }
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (error) {
    console.error('qbo/map failed', error);
    return sendJson(res, 500, { ok: false, error: 'Could not read or save the account map.' });
  }
}
