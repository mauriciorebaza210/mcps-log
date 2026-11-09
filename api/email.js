// /api/email — the Lifecycle Email Engine's one Vercel Function.
//
//   GET  /api/email?op=read&view=overview|contacts|contact   (Authorization: Bearer <portal token>)
//
// Tracking (c / o / beacon / u) and the heartbeat join this file in CP5c/5d
// (email-engine/docs/PLAN.md → Architecture). One function on purpose: Hobby's
// 12-function cap (see api/quotes/index.js).
//
// Read path (PLAN.md → Read-path security):
//   • the token comes only from the Authorization header, never the query string;
//   • capabilities come from the engine's Permissions tab, not portal roles;
//   • raw sheet values are cached briefly in function memory, and every response
//     is redacted for its viewer afterwards, so no filtered view is ever shared;
//   • responses are `private, no-store` with `Vary: Authorization`.
import * as sheets from './_sheets.js';
import { READ_TABS, toTables, capabilitiesFor, buildOverview, buildContacts, buildContact } from './_lib/email-read.js';

const RAW_TTL_MS = 15 * 1000;

function engineSpreadsheetId() {
  return String(process.env.EE_ENGINE_SS_ID || '').trim();
}
function bearer(req) {
  const h = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : '';
}
function reply(res, status, body) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('vary', 'Authorization');
  res.status(status).send(JSON.stringify(body));
}

// deps are injectable so tests/email-api.test.js runs the real handler offline.
export function createEmailHandler(deps = sheets) {
  async function loadTables(fresh) {
    const id = engineSpreadsheetId();
    const load = async () => {
      try { return toTables(await deps.readSheetRanges(READ_TABS, id)); }
      catch (e) {
        // One batchGet for all tabs: a tab that doesn't exist fails the whole read.
        if (/unable to parse range/i.test(String(e && e.message))) { const err = new Error('engine_tabs_missing'); err.status = 503; throw err; }
        throw e;
      }
    };
    return fresh ? load() : deps.getCached('ee:raw:' + id, RAW_TTL_MS, load);
  }

  async function opRead(req, res) {
    if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'Method not allowed' });
    if (req.query && req.query.token) return reply(res, 400, { ok: false, error: 'Send the token in the Authorization header, not the URL.' });
    const session = await deps.validatePortalSession(bearer(req));
    if (!session) return reply(res, 401, { ok: false, error: 'Unauthorized' });
    if (!engineSpreadsheetId()) return reply(res, 503, { ok: false, error: 'The email engine is not connected yet (EE_ENGINE_SS_ID).' });

    const started = Date.now();
    const q = req.query || {};
    let tables;
    try { tables = await loadTables(q.fresh === '1'); }
    catch (e) { if (e.status === 503) return reply(res, 503, { ok: false, error: 'The engine sheet is missing tabs (Permissions?); run eeSetup.' }); throw e; }
    const caps = capabilitiesFor(session.username, tables.Permissions);
    if (!caps.has('view_aggregates')) return reply(res, 403, { ok: false, error: 'You don’t have access to Lifecycle Email.' });

    const view = String(q.view || 'overview');
    let data;
    if (view === 'overview') data = buildOverview(tables, caps, Date.now(), { mode: q.mode });
    else if (view === 'contacts') data = buildContacts(tables, caps, { q: q.q, bucket: q.bucket, review: q.review, limit: q.limit });
    else if (view === 'contact') {
      data = buildContact(tables, caps, String(q.id || ''));
      if (!data) return reply(res, 404, { ok: false, error: 'Contact not found' });
    } else return reply(res, 400, { ok: false, error: 'Unknown view' });

    return reply(res, 200, { ok: true, view, capabilities: [...caps].sort(), data, ms: Date.now() - started });
  }

  const OPS = { read: opRead };

  return async function handler(req, res) {
    const op = String((req.query && req.query.op) || '').trim();
    const fn = OPS[op];
    try {
      if (!fn) return reply(res, 404, { ok: false, error: 'Unknown email operation.' });
      return await fn(req, res);
    } catch (error) {
      console.error('email/' + op + ' failed', error);
      return reply(res, 500, { ok: false, error: 'Email engine request failed.' });
    }
  };
}

export default createEmailHandler();
