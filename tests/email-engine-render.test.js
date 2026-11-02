// Email renderer: the plan's template rules, plus the real B Intro and C Welcome
// templates rendered for real-looking contacts.
//
//   npm run test:ee
//   EE_WRITE_PREVIEWS=1 npm run test:ee   # also writes previews/ee-*.html to look at
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const RENDER_PATH = path.join(ROOT, 'js', 'lib', 'email-render.js');
const R = require(RENDER_PATH);
const FIELDS = JSON.parse(fs.readFileSync(path.join(ROOT, 'email-engine', 'seed', 'fields.json'), 'utf8')).fields;
const CONTENT = JSON.parse(fs.readFileSync(path.join(ROOT, 'email-engine', 'seed', 'content-bc.json'), 'utf8'));
const tpl = rel => fs.readFileSync(path.join(ROOT, 'email-engine', 'templates', rel), 'utf8');
const BLOCKS = Object.fromEntries(Object.entries(CONTENT.blocks).map(([k, b]) => [k, { flag: b.flag, html: tpl(b.html) }]));
const revisionFor = stepId => { const c = CONTENT.steps[stepId]; return { subject: c.subject, preheader: c.preheader, details_box: c.details_box, body_html: tpl(c.body) }; };

const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'email-engine', 'seed', 'config.json'), 'utf8'));
const CONTEXT = {
  sender_name: CONFIG.sender_name,
  business: CONFIG.business,
  unsubscribeUrl: 'https://mcps-log.vercel.app/api/t/u?d=TEST',
  openPixelUrl: 'https://mcps-log.vercel.app/api/t/o?d=TEST',
  deliveryToken: 'dlv_0123456789abcdef0123456789abcdef',
  links: { quote: 'https://mcps-log.vercel.app/service?c=b_intro' },
  trackLink: (id, url) => 'https://mcps-log.vercel.app/api/t/c?l=' + id + '&u=' + encodeURIComponent(url)
};
const MARIA = { first_name: 'Maria', last_name: 'Lopez', address: '118 Canyon Oak, Boerne, TX', startup_date: '2026-10-28', pool_school: 'Y' };
const run = (rev, contact, ctx, blocks) => R.render({ revision: rev, blocks: blocks || BLOCKS, fields: FIELDS, contact: contact || MARIA, context: Object.assign({}, CONTEXT, ctx || {}) });
const simple = body => ({ subject: 'Hello {{FirstName}}', body_html: body });

// ── The real templates ───────────────────────────────────────────────────────

test('B Intro renders for a real contact: branded shell, merge fields, tracked CTA', () => {
  const r = run(revisionFor('b_intro'));
  assert.deepEqual(r.errors, []); assert.equal(r.ok, true);
  assert.equal(r.subject, 'An introduction from Mission Custom Pools');
  assert.match(r.html, /Hi Maria,/);
  assert.match(r.html, /mcps-lockup\.png/);                                    // shell logo
  assert.match(r.html, /Every pool matters\./);
  assert.match(r.html, /4640 South Flores Road, Elmendorf, TX 78112/);       // footer address (Mau, 2026-11-02)
  assert.match(r.html, /href="https:\/\/mcps-log\.vercel\.app\/api\/t\/u\?d=TEST"/);
  assert.match(r.html, /Get your free quote/);
  assert.match(r.html, /api\/t\/c\?l=button1&amp;u=https%3A%2F%2Fmcps-log\.vercel\.app%2Fservice%3Fc%3Db_intro/);
  assert.match(r.html, /href="tel:\+12105592073"/, 'phone links are not tracked');
  assert.match(r.html, /Ref dlv_0123456789abcdef/);
  assert.doesNotMatch(r.html, /\{\{/);
  assert.match(r.text, /Hi Maria,/); assert.match(r.text, /Unsubscribe: https:\/\/mcps-log/);
});

test('C Welcome with pool school: block included, details box filled, date in words', () => {
  const r = run(revisionFor('c_welcome'));
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.match(r.html, /Welcome to the Mission family, Maria\./);
  assert.match(r.html, /Pool School is included\./);
  assert.match(r.html, /Startup begins: Wednesday, October 28/);
  assert.match(r.html, /Pool address: 118 Canyon Oak, Boerne, TX/);
  assert.deepEqual(r.used_blocks, ['PoolSchool']);
});

test('C Welcome without pool school: the block disappears with no empty box or blank gap', () => {
  const withBlock = run(revisionFor('c_welcome'));
  const without = run(revisionFor('c_welcome'), Object.assign({}, MARIA, { pool_school: 'N' }));
  assert.equal(without.ok, true);
  assert.doesNotMatch(without.html, /Pool School/);
  assert.doesNotMatch(without.html, /F1FAF9/, 'no leftover block box');
  assert.doesNotMatch(without.html, /<\/p>\s*\n\s*\n\s*<p/, 'no blank line where the block was');
  assert.ok(without.html.length < withBlock.html.length);
});

test('Missing required values block the send with a clear error (no partial email)', () => {
  const r = run(revisionFor('c_welcome'), { first_name: 'Luis', startup_date: '2026-10-29', pool_school: 'N' });
  assert.equal(r.ok, false);
  assert.equal(r.html, undefined);
  assert.ok(r.errors.some(e => /missing required Address/.test(e)), r.errors.join('; '));
});

test('A missing first name falls back to "there" and still sends', () => {
  const r = run(revisionFor('b_intro'), { last_name: 'Nguyen' });
  assert.equal(r.ok, true); assert.match(r.html, /Hi there,/);
});

// ── Template rules (PLAN.md → Templates) ─────────────────────────────────────

test('Unknown merge fields and leftover braces block the send', () => {
  assert.ok(run(simple('<p>Hi {{Nickname}}</p>')).errors.some(e => /unknown field \{\{Nickname\}\}/.test(e)));
  assert.ok(run(simple('<p>Hi {{ First Name }}</p>')).errors.some(e => /unresolved/.test(e)));
  assert.ok(run({ subject: 'Hi {{Nope}}', body_html: '<p>x</p>' }).errors.some(e => /unknown field/.test(e)));
});

test('Field values are HTML-escaped (no injection through contact data)', () => {
  const r = run(simple('<p>Hi {{FirstName}}</p>'), { first_name: '<script>alert(1)</script>' });
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.html, /<script>alert/); assert.match(r.html, /&lt;script&gt;alert/);
  assert.equal(run(simple('<p>x</p>'), { first_name: 'Ana & Luis' }).subject, 'Hello Ana & Luis', 'subject is plain text');
});

test('A missing block, or a button with no configured link, blocks the send', () => {
  assert.ok(run(simple('<p>x</p>\n{{block:Nope}}')).errors.some(e => /missing block \{\{block:Nope\}\}/.test(e)));
  assert.ok(run(simple('{{button:Book now|booking}}')).errors.some(e => /button link "booking"/.test(e)));
});

test('Email-safe HTML only: https images with alt text; no styles, scripts, forms or absolute positioning', () => {
  const bad = {
    'http image': '<img src="http://x.com/a.png" alt="a" />',
    'local image': '<img src="/assets/a.png" alt="a" />',
    'no alt': '<img src="https://x.com/a.png" />',
    'style tag': '<style>p{color:red}</style><p>x</p>',
    'script': '<script>x()</script>',
    'absolute': '<div style="position:absolute;top:0">x</div>',
    'handler': '<p onclick="x()">x</p>',
    'form': '<form><input /></form>'
  };
  for (const [name, body] of Object.entries(bad)) assert.equal(run(simple(body)).ok, false, name);
  assert.equal(run(simple('<img src="https://x.com/a.png" alt="" />')).ok, true, 'decorative alt="" is allowed');
});

test('The footer must have a business address and an unsubscribe link (CAN-SPAM)', () => {
  assert.ok(run(simple('<p>x</p>'), null, { business: { name: 'MCPS', address: '' } }).errors.some(e => /business address/.test(e)));
  assert.ok(run(simple('<p>x</p>'), null, { unsubscribeUrl: '' }).errors.some(e => /unsubscribe/.test(e)));
});

test('Every link is tracked except tel: and mailto:; plain tags get inline brand styles', () => {
  const r = run(simple('<p>See <a href="https://example.com/a?b=1&amp;c=2">this</a>, <a href="mailto:x@y.com">mail</a>, <a href="tel:+1">call</a>.</p>'));
  assert.equal(r.ok, true);
  assert.match(r.html, /api\/t\/c\?l=a1&amp;u=https%3A%2F%2Fexample\.com%2Fa%3Fb%3D1%26c%3D2/, 'decodes &amp; before tracking');
  assert.match(r.html, /href="mailto:x@y\.com"/); assert.match(r.html, /href="tel:\+1"/);
  assert.match(r.html, /<p style="margin:0 0 16px;font-family:'Open Sans'/);
});

test('Test mode shows who the email was meant for', () => {
  const r = run(simple('<p>x</p>'), null, { testBanner: 'Maria Lopez <maria@example.com>' });
  assert.match(r.html, /TEST EMAIL\..*Maria Lopez &lt;maria@example\.com&gt;/);
  assert.doesNotMatch(run(simple('<p>x</p>')).html, /TEST EMAIL/);
});

test('Loads as a browser / Apps Script global (no module system)', () => {
  const ctx = { JSON, Math, Date, Object, Array, String, encodeURIComponent, decodeURIComponent };
  ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(RENDER_PATH, 'utf8'), ctx, { filename: 'email-render.js' });
  assert.equal(ctx.MCPS_EMAIL_RENDER.render({ revision: simple('<p>x</p>'), fields: FIELDS, contact: MARIA, context: CONTEXT }).ok, true);
});

if (process.env.EE_WRITE_PREVIEWS) {
  test('write previews', () => {
    const out = (name, r) => fs.writeFileSync(path.join(ROOT, 'previews', name), r.html);
    out('ee-b-intro.html', run(revisionFor('b_intro'), null, { testBanner: 'Maria Lopez <maria@example.com>' }));
    out('ee-c-welcome-pool-school.html', run(revisionFor('c_welcome')));
    out('ee-c-welcome-no-pool-school.html', run(revisionFor('c_welcome'), Object.assign({}, MARIA, { first_name: 'Tom', pool_school: 'N' })));
  });
}
