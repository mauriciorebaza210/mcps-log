import { verifyState, exchangeCodeAndStore } from './_qbo.js';

function page(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title}</title>
    <style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0d4d44;color:#fff;
      display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
      .card{background:#fff;color:#0d4d44;border-radius:14px;padding:2rem 2.5rem;max-width:420px;text-align:center;
      box-shadow:0 10px 40px rgba(0,0,0,.3)} h1{margin:.2rem 0 1rem;font-size:1.25rem}
      p{color:#444;line-height:1.5} .ok{color:#166534}</style></head>
    <body><div class="card"><h1 class="${title.includes('Connected') ? 'ok' : ''}">${title}</h1>
    <p>${message}</p><p style="margin-top:1.5rem;font-size:.85rem;color:#888">You can close this tab and return to the portal.</p>
    </div></body></html>`;
}

// GET /api/qbo/callback?code=...&realmId=...&state=...  (Intuit redirect target)
export default async function handler(req, res) {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  try {
    const { code, realmId, state, error } = req.query || {};
    if (error) { res.status(400).send(page('Connection cancelled', String(error))); return; }
    if (!verifyState(state)) { res.status(400).send(page('Connection failed', 'Invalid or expired request. Please start the connection again from the portal.')); return; }
    if (!code || !realmId) { res.status(400).send(page('Connection failed', 'Missing authorization code from QuickBooks.')); return; }

    const tokens = await exchangeCodeAndStore(String(code), String(realmId));
    res.status(200).send(page('QuickBooks Connected', `Linked to <strong>${tokens.company_name || 'your company'}</strong>. Next, map your accounts in the portal.`));
  } catch (e) {
    console.error('qbo/callback failed', e);
    res.status(500).send(page('Connection failed', 'Could not complete the QuickBooks connection. Please try again.'));
  }
}
