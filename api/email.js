// /api/email — the Lifecycle Email Engine's one Vercel Function.
//
//   GET  /api/email?op=read&view=overview|contacts|contact   (Authorization: Bearer <portal token>)
//   GET  /api/email?op=c&…   tracked click   → 302 now; the event is relayed after the response
//   GET  /api/email?op=o&…   open pixel      → GIF now; relayed after
//   POST /api/email?op=beacon {ee}           landing-page proof of a real browser; relayed before answering
//   GET  /api/email?op=u&…   unsubscribe confirmation page; POST records it (relayed before answering)
//   GET  /api/email/heartbeat  Vercel Cron, daily (vercel.json); emails Mau if the engine looks unhealthy
//   POST /api/email?op=admin  {action, params}  (Bearer) page actions, each gated by a capability
//   POST /api/email?op=import {stage: mappings|check|save|save_mapping, …}  (Bearer, edit_contacts)
//
// Links are built and signed by the engine with js/lib/email-tracking.js; a link
// that fails its signature is refused and records nothing (matrix row 22).
// One function on purpose: Hobby's 12-function cap (see api/quotes/index.js).
//
// Read path (PLAN.md → Read-path security):
//   • the token comes only from the Authorization header, never the query string;
//   • capabilities come from the engine's Permissions tab, not portal roles;
//   • raw sheet values are cached briefly in function memory, and every response
//     is redacted for its viewer afterwards, so no filtered view is ever shared;
//   • responses are `private, no-store` with `Vary: Authorization`.
import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import * as sheets from './_sheets.js';
import { READ_TABS, OPTIONAL_TABS, toTables, capabilitiesFor, buildOverview, buildContacts, buildContact, buildStep, buildPlan, health } from './_lib/email-read.js';
import { relayEvents, relayAdmin } from './_lib/email-relay.js';
import { checkImport, importRecord } from './_lib/email-import.js';
import { sendEngineAlert } from './_lib/notify.js';
// UMD: a default import yields module.exports. Never createRequire here (memory: Vercel createRequire trap).
import TRACKING from '../js/lib/email-tracking.js';

const RAW_TTL_MS = 15 * 1000;
const SETTINGS_SS_ID = () => String(process.env.EE_SETTINGS_SS_ID || '1WdmY9qUqlvA7Xswmf8K8n0FYP02FKEBxM7Zd_V5Er_U').trim();   // "Chem Log": Comms_Optouts
const IMPORT_CHECK_MAX = 5000, IMPORT_SAVE_MAX = 100;
// The capability each page action needs (PLAN.md → Configuration & authorization).
const ADMIN_CAP = { list_templates: 'view_aggregates', open_template: 'view_aggregates', open_draft: 'view_aggregates', import_template: 'edit_drafts', approve_draft: 'approve_publish', discard_draft: 'edit_drafts',
  set_send_time: 'edit_config', move_batch: 'edit_contacts', send_override: 'edit_contacts', create_batch: 'edit_contacts', cancel_batch: 'edit_contacts', maintenance: 'edit_config', ping: 'view_aggregates', run_now: 'run_now', set_enabled: 'pause', set_bucket_paused: 'pause', mark_sent: 'resolve_unknown',
  abandon: 'resolve_unknown', resend: 'resolve_unknown' };
let rawVersion = 0;          // bumped after a write, so this instance never serves the pre-write cache

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

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const DEFAULT_DEPS = { ...sheets, relayEvents, relayAdmin, waitUntil, sendEngineAlert, now: () => Date.now(),
  cronSecret: () => String(process.env.CRON_SECRET || '').trim(),
  linkSecret: () => String(process.env.EE_LINK_SECRET || '').trim(),
  firstPartyHosts: () => ['mcps-log.vercel.app'].concat(String(process.env.EE_FIRST_PARTY_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean)) };

const escHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function page(res, status, title, body) {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-robots-tag', 'noindex');
  res.status(status).send('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escHtml(title) + ' · Mission Custom Pool Solutions</title></head>' +
    '<body style="margin:0;background:#E9EDEE;font-family:Arial,Helvetica,sans-serif;color:#2E3A3A;">' +
    '<div style="max-width:520px;margin:40px auto;background:#fff;border-radius:6px;padding:28px 24px;">' +
    '<img src="https://mcps-email-assets.vercel.app/mcps-lockup-badge.png" width="214" height="59" alt="Mission Custom Pool Solutions" style="display:block;margin:0 auto 18px;">' +
    '<h1 style="font-family:Georgia,serif;font-size:24px;color:#0D3D3E;margin:0 0 12px;">' + escHtml(title) + '</h1>' + body + '</div></body></html>');
}
function clientIpHash(req, secret) {
  const ip = String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '').split(',')[0].trim();
  if (!ip) return '';
  // Never store the address: a salted hash of its /24 (or the first 3 IPv6 groups).
  const prefix = ip.includes(':') ? ip.split(':').slice(0, 3).join(':') : ip.split('.').slice(0, 3).join('.');
  return crypto.createHmac('sha256', secret).update('ip|' + prefix).digest('hex').slice(0, 16);
}
function trackEvent(req, v, type, secret) {
  return { event_id: crypto.randomUUID(), type, token: v.token, link_id: v.link_id || '', mode: v.mode,
    method: String(req.method || 'GET').toUpperCase(), ua: String((req.headers && req.headers['user-agent']) || '').slice(0, 300),
    ip_hash: clientIpHash(req, secret), received_at: Date.now(), source: 'vercel' };
}

// deps are injectable so tests/email-engine-api.test.js runs the real handler offline.
export function createEmailHandler(deps = DEFAULT_DEPS) {
  deps = { ...DEFAULT_DEPS, ...deps };
  async function loadTables(fresh) {
    const id = engineSpreadsheetId();
    const load = async () => {
      // Optional tabs first; if one doesn't exist yet, read the required ones alone.
      try { return toTables(await deps.readSheetRanges(READ_TABS.concat(OPTIONAL_TABS), id)); }
      catch (e) { if (!/unable to parse range/i.test(String(e && e.message))) throw e; }
      try { return toTables(await deps.readSheetRanges(READ_TABS, id)); }
      catch (e) {
        // One batchGet for all tabs: a tab that doesn't exist fails the whole read.
        if (/unable to parse range/i.test(String(e && e.message))) { const err = new Error('engine_tabs_missing'); err.status = 503; throw err; }
        throw e;
      }
    };
    return fresh ? load() : deps.getCached('ee:raw:' + id + ':' + rawVersion, RAW_TTL_MS, load);
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
    else if (view === 'plan') data = buildPlan(tables, caps, Date.now(), { mode: q.mode, bucket: q.bucket, days: q.days });
    else if (view === 'contacts') data = buildContacts(tables, caps, { q: q.q, bucket: q.bucket, review: q.review, limit: q.limit });
    else if (view === 'step') {
      data = buildStep(tables, caps, String(q.id || ''), Date.now(), { mode: q.mode });
      if (!data) return reply(res, 404, { ok: false, error: 'Email not found' });
    }
    else if (view === 'contact') {
      data = buildContact(tables, caps, String(q.id || ''));
      if (!data) return reply(res, 404, { ok: false, error: 'Contact not found' });
    } else return reply(res, 400, { ok: false, error: 'Unknown view' });

    return reply(res, 200, { ok: true, view, capabilities: [...caps].sort(), data, ms: Date.now() - started });
  }

  const hmac = () => { const secret = deps.linkSecret(); return secret ? (m => crypto.createHmac('sha256', secret).update(m).digest('hex')) : null; };
  // After the response: a click or open must never wait on Apps Script.
  const later = (events) => deps.waitUntil(deps.relayEvents(events).then(r => {
    if (!r || !r.ok) console.error('email track relay failed', r && r.error);
  }));

  async function opClick(req, res) {
    const h = hmac();
    const v = h ? TRACKING.verify('c', req.query, h) : { ok: false, reason: 'not_configured' };
    if (!v.ok) return page(res, 400, 'This link isn’t valid', '<p>The link may have been cut off. You can reach us at (210) 559-2073 or reply to our email.</p>');
    let dest = v.url;
    let host = '';
    try { host = new URL(dest).host.toLowerCase(); } catch (_) { /* verify already required http(s) */ }
    if (deps.firstPartyHosts().includes(host)) dest = TRACKING.withBeacon(dest, TRACKING.beaconParam(h, v.token, v.link_id, v.mode));
    later([trackEvent(req, v, 'click', deps.linkSecret())]);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('location', dest);
    return res.status(302).send('');
  }

  async function opOpen(req, res) {
    const h = hmac();
    const v = h ? TRACKING.verify('o', req.query, h) : { ok: false };
    if (v.ok) later([trackEvent(req, v, 'open', deps.linkSecret())]);
    res.setHeader('content-type', 'image/gif');
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private');
    return res.status(200).send(GIF);       // always the image: a broken pixel helps nobody
  }

  async function opBeacon(req, res) {
    if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'Method not allowed' });
    const h = hmac();
    const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch (_) { return {}; } })() : (req.body || {});
    const v = h ? TRACKING.verifyBeacon(body.ee, h) : { ok: false };
    if (!v.ok) return reply(res, 400, { ok: false, error: 'invalid' });
    const r = await deps.relayEvents([trackEvent(req, v, 'beacon', deps.linkSecret())]);
    // Not ok → the page keeps it and retries (PLAN.md → Tracking → Durability).
    return reply(res, r && r.ok ? 200 : 502, { ok: !!(r && r.ok) });
  }

  async function opUnsubscribe(req, res) {
    const h = hmac();
    const params = req.method === 'POST'
      ? (typeof req.body === 'string' ? Object.fromEntries(new URLSearchParams(req.body)) : (req.body || {}))
      : (req.query || {});
    const v = h ? TRACKING.verify('u', params, h) : { ok: false };
    const fallback = '<p>Reply to any of our emails with the word <strong>unsubscribe</strong> and we’ll remove you right away.</p>';
    if (!v.ok) return page(res, 400, 'This link isn’t valid', fallback);
    if (req.method !== 'POST') {
      // A GET only asks. Link scanners follow GETs, so only the button records it.
      return page(res, 200, 'Unsubscribe', '<p>Stop emails from Mission Custom Pool Solutions?</p>' +
        '<form method="post" action="/api/email?op=u">' +
        ['t', 'm', 's'].map(k => '<input type="hidden" name="' + k + '" value="' + escHtml(params[k]) + '">').join('') +
        '<button type="submit" style="background:#0D3D3E;color:#fff;border:0;border-radius:6px;padding:12px 22px;font-size:15px;cursor:pointer;">Unsubscribe</button></form>');
    }
    const r = await deps.relayEvents([trackEvent(req, v, 'unsubscribe', deps.linkSecret())]);
    const first = r && r.ok && r.results && r.results[0];
    if (first && first.status === 'recorded' && first.stop_recorded) {
      return page(res, 200, 'You’re unsubscribed', '<p>You won’t receive these emails anymore. If this was a mistake, just reply to any of our emails.</p>');
    }
    console.error('email unsubscribe not recorded', r && (r.error || JSON.stringify(r.results)));
    return page(res, 503, 'We couldn’t finish that', fallback);
  }

  // Vercel Cron sends Authorization: Bearer $CRON_SECRET. Without the secret
  // configured, nobody can trigger it.
  async function opHeartbeat(req, res) {
    const secret = deps.cronSecret();
    if (!secret || bearer(req) !== secret) return reply(res, 401, { ok: false, error: 'Unauthorized' });
    if (!engineSpreadsheetId()) return reply(res, 503, { ok: false, error: 'EE_ENGINE_SS_ID not set' });
    let tables, h;
    try {
      tables = await loadTables(true);
      h = health(tables, deps.now());
    } catch (e) {
      // Can't even read the engine: that is the alert.
      h = { ok: false, issues: [{ kind: 'engine_unreadable', detail: String(e && e.message || e).slice(0, 200) }] };
    }
    let alerted = null;
    if (!h.ok) {
      const cfg = {}; ((tables && tables.Config) || []).forEach(r => { cfg[r.key] = r.value; });
      const to = cfg.alert_email || 'mauricio@mcpoolsolutions.org';
      const text = 'The lifecycle email engine needs a look:\n\n' + h.issues.map(i => '• ' + i.kind + ': ' + i.detail).join('\n') +
        '\n\nLast run: ' + (h.last_run_at || 'none') + '\nPortal: https://mcps-log.vercel.app (Lifecycle Email)';
      alerted = await deps.sendEngineAlert(to, '[Email engine] heartbeat: ' + h.issues.length + ' issue(s)', text).catch(e => ({ ok: false, error: String(e) }));
    }
    return reply(res, 200, { ok: true, healthy: h.ok, issues: h.issues, alerted });
  }

  async function opAdmin(req, res) {
    if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'Method not allowed' });
    const session = await deps.validatePortalSession(bearer(req));
    if (!session) return reply(res, 401, { ok: false, error: 'Unauthorized' });
    if (!engineSpreadsheetId()) return reply(res, 503, { ok: false, error: 'The email engine is not connected yet (EE_ENGINE_SS_ID).' });
    const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch (_) { return {}; } })() : (req.body || {});
    const action = String(body.action || '');
    if (!ADMIN_CAP[action]) return reply(res, 400, { ok: false, error: 'Unknown action' });
    // Permissions are read fresh: a just-removed user must not keep acting on a cached grant.
    let tables;
    try { tables = await loadTables(true); }
    catch (e) { if (e.status === 503) return reply(res, 503, { ok: false, error: 'The engine sheet is missing tabs; run eeSetup.' }); throw e; }
    const caps = capabilitiesFor(session.username, tables.Permissions);
    if (!caps.has(ADMIN_CAP[action])) return reply(res, 403, { ok: false, error: 'You don’t have permission to do that.' });
    const params = body.params && typeof body.params === 'object' ? body.params : {};
    const r = await deps.relayAdmin({ action, params, actor: String(session.username || '') });
    rawVersion++;
    if (!r || r.error === 'relay not configured') return reply(res, 503, { ok: false, error: 'The engine can’t be reached right now.' });
    return reply(res, 200, { ...r, ok: !!r.ok });
  }

  // Import (PLAN.md → Plan changes 2026-11-10). The page parses the file
  // (js/lib/contact-import.js); here every row is checked against the engine's
  // contacts, the shared opt-out list and the portal's clients, and the save
  // step checks again before relaying a chunk to the engine.
  async function opImport(req, res) {
    if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'Method not allowed' });
    const session = await deps.validatePortalSession(bearer(req));
    if (!session) return reply(res, 401, { ok: false, error: 'Unauthorized' });
    if (!engineSpreadsheetId()) return reply(res, 503, { ok: false, error: 'The email engine is not connected yet (EE_ENGINE_SS_ID).' });
    const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch (_) { return {}; } })() : (req.body || {});
    let tables;
    try { tables = await loadTables(true); }
    catch (e) { if (e.status === 503) return reply(res, 503, { ok: false, error: 'The engine sheet is missing tabs; run eeSetup.' }); throw e; }
    const caps = capabilitiesFor(session.username, tables.Permissions);
    if (!caps.has('edit_contacts')) return reply(res, 403, { ok: false, error: 'You don’t have permission to import contacts.' });
    const stage = String(body.stage || '');

    if (stage === 'mappings') {
      const out = {};
      (tables.Config || []).filter(r => String(r.key).startsWith('import_mapping:'))
        .forEach(r => { out[String(r.key).slice('import_mapping:'.length)] = typeof r.value === 'object' ? r.value : {}; });
      return reply(res, 200, { ok: true, mappings: out });
    }
    if (stage === 'save_mapping') {
      const r = await deps.relayAdmin({ action: 'save_import_mapping', params: { key: body.key, mapping: body.mapping, source: body.source }, actor: session.username });
      rawVersion++;
      return reply(res, r && r.ok ? 200 : 502, { ok: !!(r && r.ok), error: r && r.error });
    }
    if (stage !== 'check' && stage !== 'save') return reply(res, 400, { ok: false, error: 'Unknown stage' });

    const contacts = Array.isArray(body.contacts) ? body.contacts : [];
    const limit = stage === 'check' ? IMPORT_CHECK_MAX : IMPORT_SAVE_MAX;
    if (!contacts.length || contacts.length > limit) return reply(res, 400, { ok: false, error: 'Send 1 to ' + limit + ' contacts.' });
    const group = /^[A-F]$/.test(String(body.group || '')) ? String(body.group) : 'B';
    const [settings, crm] = await Promise.all([
      deps.readSheetRanges(['Comms_Optouts'], SETTINGS_SS_ID()),
      deps.readSheetRanges(['Clients'], deps.crmSpreadsheetId())
    ]);
    const sources = { engineContacts: tables.Contacts || [], optouts: sheets.rowsToObjects(settings.Comms_Optouts || []),
      clients: sheets.rowsToObjects(crm.Clients || []) };
    const verdict = checkImport(contacts, sources, { group });
    if (stage === 'check') return reply(res, 200, { ok: true, ...verdict });

    // Save: only rows the server itself calls new (or same_person rows the person chose to include).
    const include = new Set((body.include_rows || []).map(Number));
    const byRow = new Map(contacts.map(c => [Number(c.row), c]));
    const toSave = verdict.rows.filter(r => r.status === 'new' || (r.status === 'same_person' && include.has(Number(r.row))))
      .map(r => importRecord(byRow.get(Number(r.row)), { source: body.source }));
    const dnc = verdict.rows.filter(r => r.status === 'do_not_contact').map(r => r.email_norm);
    if (!toSave.length && !dnc.length) return reply(res, 200, { ok: true, added: 0, skipped: [], rows: verdict.rows });
    const r = await deps.relayAdmin({ action: 'import_contacts', params: { group, source: String(body.source || ''), contacts: toSave, do_not_contact: dnc }, actor: session.username });
    rawVersion++;
    if (!r || r.error === 'relay not configured') return reply(res, 503, { ok: false, error: 'The engine can’t be reached right now.' });
    return reply(res, r.ok ? 200 : 502, { ...r, rows: verdict.rows });
  }

  const OPS = { import: opImport, read: opRead, c: opClick, o: opOpen, beacon: opBeacon, u: opUnsubscribe, heartbeat: opHeartbeat, admin: opAdmin };

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
