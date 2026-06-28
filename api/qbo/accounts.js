import { sendJson, requireAdminPortalToken } from '../_sheets.js';
import { qboFetch } from './_qbo.js';

// GET /api/qbo/accounts?token=<admin>
// Returns the active chart of accounts for the mapping dropdowns.
export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    const session = await requireAdminPortalToken(req, res);
    if (!session) return;

    const query = 'select Id, Name, FullyQualifiedName, AccountType, AccountSubType, Classification from Account where Active = true MAXRESULTS 1000';
    const json = await qboFetch(`query?query=${encodeURIComponent(query)}`);
    const accounts = ((json.QueryResponse && json.QueryResponse.Account) || []).map(a => ({
      id: a.Id,
      name: a.FullyQualifiedName || a.Name,
      type: a.AccountType,
      subType: a.AccountSubType,
      classification: a.Classification
    }));
    return sendJson(res, 200, { ok: true, accounts });
  } catch (error) {
    console.error('qbo/accounts failed', error);
    return sendJson(res, 502, { ok: false, error: 'Could not load QuickBooks accounts.' });
  }
}
