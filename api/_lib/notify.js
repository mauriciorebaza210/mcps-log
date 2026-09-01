// ══════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS for service requests
//
// Two emails, both BEST EFFORT:
//   * to the customer — a receipt with their reference number
//   * to the office   — a new request landed, with the match verdict
//
// ⚠️ A failed email must NEVER fail the request. By the time these run the row
// is already saved; throwing here would show the customer an error for a request
// we actually have, and they would send it again. Every path resolves.
//
// Transport is Gmail, through the Apps Script backend — the same path every
// other MCPS email already takes (`send_mode: gmail`, confirmed against the live
// deployment). Vercel has no mail of its own and MCPS does not use Resend, so
// the only sender that exists is GmailApp inside Apps Script.
//
// Vercel builds the HTML and text; Apps Script is a dumb authenticated relay.
// Keeping the templates on this side means changing a word in an email does not
// need a clasp push and a redeploy.
//
// Requests are signed the way appscript/CommsSenders.js signs its sends —
// HMAC-SHA256 over the exact request body, plus a timestamp and a nonce, so a
// captured request cannot be replayed into an open send relay.
//
// ⚠️ FAILS OPEN, INCLUDING BEFORE THE APPS SCRIPT SIDE EXISTS. Until
// `service_request_notify` is deployed, the backend answers
// {ok:false,error:"Unauthorized"} and this logs and moves on. The request is
// already saved and already visible in the review queue; email is a
// convenience, never the system of record.

import crypto from 'node:crypto';
import { appsScriptUrl } from '../_sheets.js';

const TEAL = '#0D3D3E';
const AQUA = '#1FA7A8';
const AQUA_LIGHT = '#5ED6D3';
const GRAY = '#F3F5F6';
const INK = '#222222';
const LINE = '#E4E8EA';
const FOOT_INK = '#B9CDCD';

// Raw keys are for storage, not for reading. "asap" in an email to the office
// is the machine's word, not ours.
const TIMING_LABEL = {
  asap: 'As soon as possible', this_week: 'This week',
  next_week: 'Next week', flexible: 'Flexible'
};
function timingLabel(key) {
  return TIMING_LABEL[String(key || '').trim()] || 'Flexible';
}
function prettyKey(key) {
  const v = String(key || '').replace(/_/g, ' ').trim();
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : '';
}

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function notifyConfig() {
  return {
    secret: env('SERVICE_REQUEST_NOTIFY_SECRET', ''),
    office: env('SERVICE_REQUEST_OFFICE_EMAIL', 'antonio@mcpoolsolutions.org')
      .split(',').map(s => s.trim()).filter(Boolean),
    phone: env('MCPS_PHONE', '(210) 559-2073'),
    replyTo: env('SERVICE_REQUEST_REPLY_TO', 'antonio@mcpoolsolutions.org'),
    consoleUrl: env('PORTAL_BASE_URL', 'https://mcps-log.vercel.app') + '/#service_requests',
    // Mirrors commsBrandCfg_ in appscript/Comms.js so a receipt from here is
    // indistinguishable from every other email MCPS sends.
    name: env('COMMS_BUSINESS_NAME', 'Mission Custom Pool Solutions'),
    address: env('COMMS_BUSINESS_ADDRESS', '4640 S Flores Rd, Elmendorf, TX 78112'),
    website: env('COMMS_WEBSITE', 'missioncustompools.com'),
    // ⚠️ NOT logo.png. That one is 1024x1024 and 348KB — a square mark forced
    // into the 200x56 header slot renders as a tiny square, and a third of a
    // megabyte is a lot to ask of a phone on cell data for a header image.
    // assets/email-logo.png is the horizontal lockup at 440x131 and 20KB.
    logoUrl: env('COMMS_LOGO_URL', 'https://mcps-log.vercel.app/assets/email-logo.png')
  };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ⚠️ THE SIGNED BODY MUST BE PURE ASCII.
//
// Node hashes the UTF-8 bytes of a string; Apps Script's
// Utilities.computeHmacSha256Signature does not agree with it on any character
// above U+007F. Signing a body containing one produces "Bad signature" on a
// request that is perfectly genuine.
//
// This was not theoretical. It was found by sending a real test: an office
// alert failed while the customer receipt succeeded, and the only difference
// between them was a "·" in the match summary. On a San Antonio customer list
// it would have silently killed the email for every José, Peña and Gutiérrez —
// and for anyone whose description contained a curly quote pasted from a phone
// keyboard.
//
// Escaping to \uXXXX keeps the JSON valid and parses back to exactly the same
// object on the far side, so accents survive into the email itself. Only the
// bytes being signed change.
// RFC 2606 / 6761 reserve these so they can never resolve. Anything addressed to
// one is guaranteed to bounce, and a bounce is not free: it lands in the sending
// mailbox as noise and it costs domain reputation, which matters most in the
// days around a cold campaign — exactly when this feature is busiest.
//
// This started as test hygiene (the live suites seed @e2e-test.invalid and each
// run mailed Mau a bounce) but it belongs in production regardless: a customer
// who typos "gmail.invalid" should cost us nothing.
const UNDELIVERABLE_TLDS = ['invalid', 'test', 'example', 'localhost', 'local'];

function isUndeliverable(address) {
  const domain = String(address || '').split('@')[1];
  if (!domain) return true;
  const tld = domain.trim().toLowerCase().split('.').pop();
  return UNDELIVERABLE_TLDS.includes(tld);
}

function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, ch =>
    '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

async function send(msg) {
  const cfg = notifyConfig();
  if (!cfg.secret) return { ok: false, skipped: 'no SERVICE_REQUEST_NOTIFY_SECRET configured' };

  const recipients = (Array.isArray(msg.to) ? msg.to : [msg.to])
    .map(a => String(a || '').trim())
    .filter(Boolean)
    .filter(a => !isUndeliverable(a));
  if (!recipients.length) return { ok: false, skipped: 'no deliverable recipient' };

  const body = asciiJson({
    action: 'service_request_notify',
    to: recipients.join(','),
    subject: msg.subject,
    htmlBody: msg.html,
    plainBody: msg.text,
    replyTo: cfg.replyTo,
    dedupeKey: msg.idempotencyKey || '',
    ts: Date.now(),
    nonce: crypto.randomUUID()
  });

  // The signature covers the exact bytes sent, so there is no canonical form to
  // agree on and no field-ordering bug to have.
  const sig = crypto.createHmac('sha256', cfg.secret).update(body).digest('hex');
  const url = appsScriptUrl() + (appsScriptUrl().includes('?') ? '&' : '?') + 'sig=' + sig;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    redirect: 'follow'
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch (_) { return { ok: false, error: 'Apps Script returned non-JSON: ' + text.slice(0, 120) }; }
  if (!json.ok) return { ok: false, error: json.error || 'Apps Script refused the send' };
  return { ok: true, id: json.messageId || '' };
}

// ── Shell ───────────────────────────────────────────────────────────────────

// The house email shell, matching buildCommsEmailHtml_ in appscript/Comms.js.
//
// ⚠️ An earlier version of this invented its own: a teal band with the company
// name set in text. It looked generic in a real inbox, and for a reason worth
// remembering — email clients do not load web fonts, so Montserrat fell back to
// Arial and the only thing carrying the brand was a colour. The real shell
// leads with the LOGO on white, which survives having no fonts at all.
//
// Keep this in step with Comms.js. Two shells that drift is how a customer ends
// up able to tell which system sent them something.
function shell(bodyHtml, cfg, opts) {
  const o = opts || {};
  const pre = o.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(o.preheader)}</div>`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light only">
</head>
<body style="margin:0;padding:0;background:${GRAY};">${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${GRAY};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#FFFFFF;border-radius:8px;overflow:hidden;border:1px solid ${LINE};">
  <tr><td align="center" style="padding:28px 24px 16px;background:#FFFFFF;">
    <img src="${esc(cfg.logoUrl)}" alt="${esc(cfg.name)}" width="200" style="display:block;max-height:56px;width:auto;border:0;">
  </td></tr>
  <tr><td style="padding:0 24px;"><div style="height:3px;background:${AQUA};border-radius:2px;"></div></td></tr>
  <tr><td style="padding:24px;font-family:'Open Sans',Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:${INK};">
    ${bodyHtml}
  </td></tr>
  <tr><td style="padding:20px 24px;background:${TEAL};font-family:'Open Sans',Arial,Helvetica,sans-serif;">
    <div style="font-size:15px;font-weight:bold;color:#FFFFFF;margin-bottom:4px;">${esc(cfg.name)}</div>
    <div style="font-size:12px;color:${FOOT_INK};line-height:1.5;">
      Pool service in San Antonio, TX<br>
      ${esc(cfg.address)}<br>
      ${esc(cfg.phone)} &nbsp;&bull;&nbsp; ${esc(cfg.website)}
    </div>
  </td></tr>
</table></td></tr></table></body></html>`;
}

function factTable(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${GRAY};border-radius:8px;margin:0 0 22px;">` +
    rows.filter(Boolean).map(([k, v]) =>
      `<tr><td style="padding:11px 16px;font-family:'Open Sans',Arial,Helvetica,sans-serif;font-size:13px;color:#5c6b6b;width:38%;">${esc(k)}</td>` +
      `<td style="padding:11px 16px;font-family:'Open Sans',Arial,Helvetica,sans-serif;font-size:14px;color:${INK};font-weight:600;">${esc(v)}</td></tr>`
    ).join('') + '</table>';
}

// ── Customer receipt ────────────────────────────────────────────────────────

export async function notifyCustomer(request, categoryLabel) {
  try {
    const cfg = notifyConfig();
    if (!request.email) return { ok: false, skipped: 'no customer email' };

    const first = String(request.first_name || '').trim();
    const greeting = first ? `Hi ${esc(first)},` : 'Hello,';
    const address = [request.service_address, request.city].filter(Boolean).join(', ');

    const body =
      `<h1 style="font-family:'Montserrat',Arial,Helvetica,sans-serif;font-weight:bold;font-size:20px;color:${TEAL};margin:0 0 16px;">We have your request</h1>` +
      `<p style="margin:0 0 18px;">${greeting} thank you for reaching out. We have your request and a member of our team will contact you within one business day to confirm the day and the price.</p>` +
      factTable([
        ['Reference', request.request_id],
        ['What you need', categoryLabel],
        address ? ['Property', address] : null,
        ['Received', new Date(request.created_at || Date.now()).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })]
      ]) +
      `<p style="margin:0 0 18px;">Nothing is scheduled and nothing is charged until we speak with you and you approve the work.</p>` +
      `<p style="margin:0;">Thank you for choosing Mission Custom Pool Solutions.</p>`;

    const text = [
      `${first ? 'Hi ' + first + ',' : 'Hello,'} thank you for reaching out.`,
      '',
      'We have your request and a member of our team will contact you within one business day to confirm the day and the price.',
      '',
      `Reference: ${request.request_id}`,
      `What you need: ${categoryLabel}`,
      address ? `Property: ${address}` : '',
      '',
      'Nothing is scheduled and nothing is charged until we speak with you and you approve the work.',
      '',
      `Questions? ${cfg.phone} or ${cfg.replyTo}`,
      'Thank you for choosing Mission Custom Pool Solutions.'
    ].filter(Boolean).join('\n');

    return await send({
      to: request.email,
      subject: `We have your pool service request (${request.request_id})`,
      html: shell(body, cfg, { preheader: `We'll contact you within one business day. Reference ${request.request_id}.` }),
      text,
      idempotencyKey: 'sr-cust-' + request.request_id
    });
  } catch (error) {
    return { ok: false, error: String(error && error.message || error) };
  }
}

// ── Office alert ────────────────────────────────────────────────────────────

export async function notifyOffice(request, categoryLabel, matchSummary) {
  try {
    const cfg = notifyConfig();
    if (!cfg.office.length) return { ok: false, skipped: 'no SERVICE_REQUEST_OFFICE_EMAIL configured' };

    const name = [request.first_name, request.last_name].filter(Boolean).join(' ').trim() || 'No name given';
    const address = [request.service_address, request.city, request.zip_code].filter(Boolean).join(', ');
    const urgent = request.timing_preference === 'asap';

    const body =
      `<h1 style="font-family:'Montserrat',Arial,Helvetica,sans-serif;font-weight:bold;font-size:20px;color:${TEAL};margin:0 0 6px;">New service request</h1>` +
      `<p style="margin:0 0 18px;color:#5c6b6b;font-size:14px;">${esc(request.request_id)}${urgent ? ' &middot; <strong style="color:#b42318;">ASAP</strong>' : ''}</p>` +
      factTable([
        ['Customer', name],
        ['What they need', categoryLabel + (request.subcategory ? ' · ' + prettyKey(request.subcategory) : '')],
        address ? ['Property', address] : null,
        request.phone ? ['Phone', request.phone] : null,
        request.email ? ['Email', request.email] : null,
        ['Timing', timingLabel(request.timing_preference)],
        ['CRM match', matchSummary]
      ]) +
      (request.description
        ? `<p style="margin:0 0 22px;padding:14px 16px;background:${GRAY};border-radius:8px;font-size:14px;">${esc(request.description)}</p>`
        : '') +
      `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:${AQUA};">` +
      `<a href="${esc(cfg.consoleUrl)}" style="display:inline-block;padding:14px 28px;font-family:'Montserrat',Arial,Helvetica,sans-serif;font-weight:bold;font-size:14px;color:#ffffff;text-decoration:none;">Open the review queue</a>` +
      `</td></tr></table>`;

    const text = [
      `New service request ${request.request_id}${urgent ? ' — ASAP' : ''}`,
      '',
      `Customer: ${name}`,
      `Needs: ${categoryLabel}`,
      address ? `Property: ${address}` : '',
      request.phone ? `Phone: ${request.phone}` : '',
      request.email ? `Email: ${request.email}` : '',
      `Timing: ${timingLabel(request.timing_preference)}`,
      `CRM match: ${matchSummary}`,
      request.description ? `\n${request.description}` : '',
      '',
      cfg.consoleUrl
    ].filter(Boolean).join('\n');

    return await send({
      to: cfg.office,
      subject: `${urgent ? '[ASAP] ' : ''}New service request — ${name} (${categoryLabel})`,
      html: shell(body, cfg, { preheader: `${name} — ${categoryLabel}` }),
      text,
      idempotencyKey: 'sr-office-' + request.request_id
    });
  } catch (error) {
    return { ok: false, error: String(error && error.message || error) };
  }
}
