import { sendJson, requireAdminPortalToken } from '../_sheets.js';
import { disconnect } from './_qbo.js';

// POST /api/qbo/disconnect { token }  → revoke + clear stored tokens.
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    const session = await requireAdminPortalToken(req, res);
    if (!session) return;
    await disconnect();
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    console.error('qbo/disconnect failed', error);
    return sendJson(res, 500, { ok: false, error: 'Could not disconnect QuickBooks.' });
  }
}
