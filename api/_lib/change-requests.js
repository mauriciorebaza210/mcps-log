// ══════════════════════════════════════════════════════════════════════════════
// CHANGE REQUESTS from the Lifecycle page ("Request a change", js/features/lifecycle-help.js)
//
//   GET  op=request                      → { requests: [...] }   (anyone with Lifecycle access)
//   GET  op=request&file=<pathname>      → the screenshot or an attached file (same access)
//   POST op=request { text, context, screenshot, files }  → saved, Mau emailed
//   POST op=request { done: <id> }       → marked done (edit_config)
//
// Stored in the PRIVATE Blob store (like service-request photos), one folder per
// request: change-requests/<id>/request.json, shot.jpg, file-N.<ext>. Nothing is
// ever readable by URL; files go through this route with the portal session.
// The email to Mau goes from the portal's own Gmail (api/_lib/notify.js), never the
// engine, which sends as Tony. It is best effort: the request is saved first.
// ══════════════════════════════════════════════════════════════════════════════
import crypto from 'node:crypto';

export const RQ_PREFIX = 'change-requests/';
const MAX_TEXT = 4000, MAX_SHOT = 2 * 1024 * 1024, MAX_FILES = 3, MAX_FILES_BYTES = 3 * 1024 * 1024;
const ID = /^rq_[0-9a-z]{6,12}_[A-Za-z0-9_-]{6,16}$/;
const FILE = /^change-requests\/rq_[0-9a-z]{6,12}_[A-Za-z0-9_-]{6,16}\/(shot\.jpg|file-[0-2]\.(png|jpg|gif|webp|pdf))$/;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' };

// The type comes from the bytes, never the name or the declared type.
export function sniff(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  if (buf.length > 6 && buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.length > 5 && buf.toString('latin1', 0, 5) === '%PDF-') return 'pdf';
  return '';
}
function fromDataUrl(s) {
  const m = /^data:[\w/+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ''));
  return m ? Buffer.from(m[1], 'base64') : null;
}
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, n);
// Only the context fields the page sends, as short strings.
function cleanContext(c) {
  const o = {}; c = c && typeof c === 'object' ? c : {};
  ['tab', 'campaign', 'view', 'day', 'drawer', 'drawer_tab', 'drawer_title', 'url', 'at', 'version', 'screen'].forEach(k => { if (c[k] != null && c[k] !== '') o[k] = clip(c[k], 300); });
  if (c.target && typeof c.target === 'object') o.target = { selector: clip(c.target.selector, 400), text: clip(c.target.text, 160), tag: clip(c.target.tag, 20) };
  return o;
}
export function where(c) {
  const tab = { campaigns: 'Campaigns', emails: 'Emails', activity: 'Activity', contacts: 'Contacts' }[c.tab] || c.tab || '';
  return [tab, c.campaign, c.view === 'calendar' ? 'Calendar' : '', c.drawer_title].filter(Boolean).join(' › ');
}
const summary = r => ({ id: r.id, text: r.text, user: r.user, at: r.at, where: where(r.context || {}), files: (r.files || []).length,
  shot: r.shot || '', file_list: r.files || [], target: (r.context || {}).target || null, context: r.context || {}, status: r.status || 'open', done_by: r.done_by || '', done_at: r.done_at || '' });

// deps: { blob: { put, get, list }, now(), notify(req) → Promise, portalUrl }
export function changeRequests(deps) {
  async function readJson(pathname) {
    const r = await deps.blob.get(pathname, { access: 'private' });
    if (!r) return null;
    const body = r.stream || r.body || r;
    return JSON.parse(Buffer.from(await new Response(body).arrayBuffer()).toString('utf8'));
  }
  async function listAll() {
    const out = [];
    let cursor;
    do {
      const page = await deps.blob.list({ prefix: RQ_PREFIX, limit: 1000, cursor });
      (page.blobs || []).filter(b => /\/request\.json$/.test(b.pathname)).forEach(b => out.push(b.pathname));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor && out.length < 500);
    const rows = await Promise.all(out.map(p => readJson(p).catch(() => null)));
    return rows.filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  async function create(body, session) {
    const text = clip(body.text, MAX_TEXT).trim();
    if (!text) return { status: 400, body: { ok: false, error: 'Say what you’d like changed.' } };
    const at = new Date(deps.now()).toISOString();
    const id = 'rq_' + deps.now().toString(36) + '_' + crypto.randomBytes(6).toString('base64url');
    const dir = RQ_PREFIX + id + '/';
    let shot = '';
    const shotBuf = fromDataUrl(body.screenshot);
    if (shotBuf && shotBuf.length <= MAX_SHOT && sniff(shotBuf) === 'jpg') {
      shot = dir + 'shot.jpg';
      await deps.blob.put(shot, shotBuf, { access: 'private', contentType: 'image/jpeg', addRandomSuffix: false });
    }
    const files = [];
    let total = 0;
    for (const f of (Array.isArray(body.files) ? body.files : []).slice(0, MAX_FILES)) {
      const buf = fromDataUrl(f && f.data), ext = buf ? sniff(buf) : '';
      if (!buf || !ext) continue;
      total += buf.length;
      if (total > MAX_FILES_BYTES) return { status: 413, body: { ok: false, error: 'Files are too big together (3 MB max).' } };
      const pathname = dir + 'file-' + files.length + '.' + ext;
      await deps.blob.put(pathname, buf, { access: 'private', contentType: TYPES[ext], addRandomSuffix: false });
      files.push({ pathname, name: clip(f.name, 120) || ('file.' + ext), type: TYPES[ext], size: buf.length });
    }
    const rec = { id, text, user: clip(session.username, 60), at, context: cleanContext(body.context), shot, files, status: 'open' };
    await deps.blob.put(dir + 'request.json', JSON.stringify(rec), { access: 'private', contentType: 'application/json', addRandomSuffix: false });
    const mailed = await Promise.resolve(deps.notify(rec)).catch(e => ({ ok: false, error: String(e && e.message || e) }));
    return { status: 200, body: { ok: true, id, emailed: !!(mailed && mailed.ok) } };
  }

  async function markDone(id, session) {
    if (!ID.test(String(id || ''))) return { status: 400, body: { ok: false, error: 'Unknown request' } };
    const pathname = RQ_PREFIX + id + '/request.json';
    const rec = await readJson(pathname).catch(() => null);
    if (!rec) return { status: 404, body: { ok: false, error: 'Request not found' } };
    rec.status = 'done'; rec.done_by = clip(session.username, 60); rec.done_at = new Date(deps.now()).toISOString();
    await deps.blob.put(pathname, JSON.stringify(rec), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
    return { status: 200, body: { ok: true } };
  }

  return {
    list: async () => ({ status: 200, body: { ok: true, requests: (await listAll()).map(summary) } }),
    create, markDone,
    // Streams a stored file to someone with access; anything not shaped like ours is refused.
    file: async (pathname) => {
      if (!FILE.test(String(pathname || ''))) return { status: 400 };
      const r = await deps.blob.get(pathname, { access: 'private' });
      if (!r) return { status: 404 };
      const ext = pathname.split('.').pop();
      return { status: 200, type: TYPES[ext] || 'application/octet-stream', body: Buffer.from(await new Response(r.stream || r.body || r).arrayBuffer()) };
    }
  };
}

// The email to Mau: the request, where it was made, and a link to see the screenshot and files.
export function changeRequestEmail(rec, portalUrl) {
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const c = rec.context || {}, w = where(c), t = c.target;
  const when = new Date(rec.at).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT';
  const link = String(portalUrl || 'https://mcps-log.vercel.app').replace(/\/$/, '') + '/#lifecycle';
  const rows = [['From', rec.user], ['When', when], ['Where', w || c.tab || ''], t ? ['Pointed at', (t.text || t.tag) + (t.selector ? '\n' + t.selector : '')] : null,
    ['Screenshot', rec.shot ? 'Yes (in the portal)' : 'No'], ['Files', (rec.files || []).map(f => f.name).join(', ') || 'None'], ['Page', c.url || ''], ['Version', [c.version, c.screen].filter(Boolean).join(' · ')]].filter(Boolean);
  const subject = 'Change request from ' + rec.user + ': ' + rec.text.replace(/\s+/g, ' ').slice(0, 60) + (rec.text.length > 60 ? '…' : '');
  const text = rec.text + '\n\n' + rows.map(([k, v]) => k + ': ' + v).join('\n') + '\n\nSee it in the portal (Lifecycle Email → Activity → Change requests): ' + link;
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:600px">' +
    '<p style="font-size:16px;line-height:1.5;white-space:pre-wrap;margin:0 0 18px">' + esc(rec.text) + '</p>' +
    '<table cellpadding="0" cellspacing="0" style="background:#F3F5F6;border-radius:8px;width:100%;font-size:13px">' +
    rows.map(([k, v]) => '<tr><td style="padding:8px 14px;color:#7A8687;width:110px;vertical-align:top">' + esc(k) + '</td><td style="padding:8px 14px;white-space:pre-wrap;word-break:break-word">' + esc(v) + '</td></tr>').join('') + '</table>' +
    '<p style="margin:20px 0 0"><a href="' + esc(link) + '" style="background:#0D3D3E;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:bold;font-size:14px">See the screenshot in the portal</a></p>' +
    '<p style="color:#7A8687;font-size:12px;margin-top:18px">Lifecycle Email → Activity → Change requests</p></div>';
  return { subject, text, html };
}
