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
// Transport is Resend, the same provider appscript/Comms.js already supports
// (commsSendViaResend_, Comms.js:66) — so this reuses an existing account rather
// than introducing a second one. Copy RESEND_API_KEY from the Apps Script
// properties into the Vercel environment and both halves send as the same
// domain. With no key set, nothing sends and nothing breaks: the request is
// still saved and still appears in the review console.
//
// Markup follows the brand email shell in Comms.js:959-1010 — 600px table, teal
// masthead, aqua rule, Open Sans body, teal footer band — so a receipt from here
// looks like every other email MCPS sends.
// ══════════════════════════════════════════════════════════════════════════════

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
    key: env('RESEND_API_KEY', ''),
    from: env('SERVICE_REQUEST_FROM', 'Mission Custom Pool Solutions <noreply@mcpoolsolutions.org>'),
    office: env('SERVICE_REQUEST_OFFICE_EMAIL', '')
      .split(',').map(s => s.trim()).filter(Boolean),
    phone: env('MCPS_PHONE', '(210) 559-2073'),
    replyTo: env('SERVICE_REQUEST_REPLY_TO', 'antonio@mcpoolsolutions.org'),
    consoleUrl: env('PORTAL_BASE_URL', 'https://mcps-log.vercel.app') + '/service-requests',
    logoUrl: env('COMMS_LOGO_URL', 'https://mcps-log.vercel.app/logo.png')
  };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function send(msg) {
  const cfg = notifyConfig();
  if (!cfg.key) return { ok: false, skipped: 'no RESEND_API_KEY configured' };
  if (!msg.to || !msg.to.length) return { ok: false, skipped: 'no recipient' };

  const headers = { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' };
  // Resend honours this for 24h, so a retry after a timeout cannot double-send.
  if (msg.idempotencyKey) headers['Idempotency-Key'] = String(msg.idempotencyKey);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      from: cfg.from,
      to: Array.isArray(msg.to) ? msg.to : [msg.to],
      reply_to: cfg.replyTo,
      subject: msg.subject,
      html: msg.html,
      text: msg.text
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: json.message || `Resend returned ${res.status}` };
  return { ok: true, id: json.id };
}

// ── Shell ───────────────────────────────────────────────────────────────────

function shell(bodyHtml, cfg) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:${GRAY};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${GRAY};padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid ${LINE};border-radius:8px;overflow:hidden;">
  <tr><td style="background:${TEAL};padding:24px 30px;text-align:center;">
    <div style="font-family:'Montserrat',Arial,sans-serif;font-weight:700;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:${AQUA_LIGHT};">Mission Custom Pool Solutions</div>
  </td></tr>
  <tr><td style="height:3px;background:${AQUA};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:30px;font-family:'Open Sans',Arial,sans-serif;font-size:16px;line-height:1.6;color:${INK};">
    ${bodyHtml}
  </td></tr>
  <tr><td style="background:${TEAL};padding:22px 30px;text-align:center;font-family:'Open Sans',Arial,sans-serif;font-size:12px;line-height:1.7;color:${FOOT_INK};">
    <div style="font-family:'Montserrat',Arial,sans-serif;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:${AQUA_LIGHT};font-size:10px;margin-bottom:8px;">Every pool matters.</div>
    Questions? ${esc(cfg.phone)} &middot; <a href="mailto:${esc(cfg.replyTo)}" style="color:${AQUA_LIGHT};">${esc(cfg.replyTo)}</a>
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

function factTable(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${GRAY};border-radius:8px;margin:0 0 22px;">` +
    rows.filter(Boolean).map(([k, v]) =>
      `<tr><td style="padding:11px 16px;font-family:'Open Sans',Arial,sans-serif;font-size:13px;color:#5c6b6b;width:38%;">${esc(k)}</td>` +
      `<td style="padding:11px 16px;font-family:'Open Sans',Arial,sans-serif;font-size:14px;color:${INK};font-weight:600;">${esc(v)}</td></tr>`
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
      `<h1 style="font-family:'Montserrat',Arial,sans-serif;font-weight:700;font-size:21px;color:${TEAL};margin:0 0 16px;">We have your request</h1>` +
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
      html: shell(body, cfg),
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
      `<h1 style="font-family:'Montserrat',Arial,sans-serif;font-weight:700;font-size:21px;color:${TEAL};margin:0 0 6px;">New service request</h1>` +
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
      `<a href="${esc(cfg.consoleUrl)}" style="display:inline-block;padding:14px 28px;font-family:'Montserrat',Arial,sans-serif;font-weight:700;font-size:14px;color:#ffffff;text-decoration:none;">Open the review queue</a>` +
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
      html: shell(body, cfg),
      text,
      idempotencyKey: 'sr-office-' + request.request_id
    });
  } catch (error) {
    return { ok: false, error: String(error && error.message || error) };
  }
}
