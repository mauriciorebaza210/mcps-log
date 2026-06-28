import { sendJson, requireAdminPortalToken } from '../_sheets.js';
import { buildAuthorizeUrl } from './_qbo.js';

// GET /api/qbo/connect?token=<admin portal token>
// Validates the admin, then redirects the browser to Intuit's consent screen.
export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    const session = await requireAdminPortalToken(req, res);
    if (!session) return; // response already sent
    const url = buildAuthorizeUrl();
    res.statusCode = 302;
    res.setHeader('Location', url);
    res.end();
  } catch (error) {
    console.error('qbo/connect failed', error);
    return sendJson(res, 500, { ok: false, error: 'Could not start QuickBooks connection.' });
  }
}
