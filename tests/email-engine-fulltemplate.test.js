// Full templates (complete HTML files from the Template Library / ChatGPT):
// js/lib/email-render.js → renderFull. PLAN.md → Template Library.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../js/lib/email-render.js');
const fields = require('../email-engine/seed/fields.json').fields;

const ADDR = '4640 South Flores Road, Elmendorf, TX 78112';
const page = (body, head) => '<!DOCTYPE html><html><head>' + (head || '') + '</head><body>' + body + '</body></html>';
const good = page('<p>Hi {{FirstName}},</p><a href="{{QuoteLink}}">Get your free quote</a> <a href="https://mcpoolsolutions.org">Website</a>' +
  '<p>Mission Custom Pool Solutions &middot; 4640 South Flores Road,<br>Elmendorf, TX 78112</p><a href="{{UnsubscribeLink}}">Unsubscribe</a>');
const ctx = extra => Object.assign({ sender_name: 'Tony', business: { name: 'Mission Custom Pool Solutions', address: ADDR }, unsubscribeUrl: 'https://mcps.test/u/abc',
  links: { quote: 'https://mcps.test/service' }, deliveryToken: 'tok-1', openPixelUrl: 'https://mcps.test/o/abc', trackLink: (id, u) => 'https://mcps.test/c/' + id + '?to=' + encodeURIComponent(u) }, extra || {});
const run = (html, extra, rev) => R.render({ revision: Object.assign({ subject: 'For {{FirstName}}', preheader: 'Quick note', body_html: html }, rev || {}), fields, contact: { first_name: 'Ana' }, context: ctx(extra) });

test('A complete file renders as-is: fields merged, quote link tracked as the button, unsubscribe not tracked', () => {
  const r = run(good);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.format, 'full');
  assert.equal(r.subject, 'For Ana');
  assert.match(r.html, /Hi Ana,/);
  assert.match(r.html, /href="https:\/\/mcps\.test\/c\/button1\?to=https%3A%2F%2Fmcps\.test%2Fservice"/);
  assert.match(r.html, /href="https:\/\/mcps\.test\/c\/a2\?to=/, 'other links are tracked too');
  assert.match(r.html, /href="https:\/\/mcps\.test\/u\/abc"/, 'unsubscribe goes straight to the unsubscribe page');
  assert.ok(!/MCPS lockup|mcps-lockup-badge/.test(r.html), 'no MCPS shell around it');
});

test('The engine adds what it needs: delivery reference (reconcile), open pixel, hidden preheader', () => {
  const r = run(good);
  assert.match(r.html, /Ref tok-1<\/div><img src="https:\/\/mcps\.test\/o\/abc"[^>]*><\/body>/);
  assert.match(r.html, /<body><div style="display:none[^"]*">Quick note<\/div>/);
  assert.match(r.text, /Hi Ana,/);
});

test('Refused without the address or the unsubscribe link (CAN-SPAM), and for unsafe or broken HTML', () => {
  assert.match(run(good.replace('4640 South Flores Road,<br>', '')).errors.join(), /business address/);
  assert.match(run(good.replace('{{UnsubscribeLink}}', 'https://x')).errors.join(), /unsubscribe link/);
  assert.match(run(good.replace('<p>Hi', '<script>x()</script><p>Hi')).errors.join(), /script/);
  assert.match(run(good.replace('<p>Hi', '<img src="http://x/a.png"><p>Hi')).errors.join(), /https[\s\S]*alt text/);
  assert.match(run(good.replace('{{FirstName}}', '{{Nickname}}')).errors.join(), /unknown field \{\{Nickname\}\}/);
  assert.match(run(good, null, { subject: '' }).errors.join(), /subject is empty/);
});

test('Google Fonts links and <style> blocks are allowed in the head; other stylesheets are not', () => {
  assert.equal(run(page(good.slice(good.indexOf('<body>') + 6, good.indexOf('</body>')), '<link href="https://fonts.googleapis.com/css2?family=Montserrat" rel="stylesheet"><style>.x{color:red}</style>')).ok, true);
  assert.match(run(page('<p>x</p>', '<link href="https://evil.test/a.css" rel="stylesheet">')).errors.join(), /Google Fonts/);
});

test('Body templates still use the MCPS frame; format can be forced either way', () => {
  const body = run('<p>Hi {{FirstName}}</p>', null, {});
  assert.equal(body.ok, true);
  assert.match(body.html, /mcps-lockup-badge/);
  assert.equal(R.isFull({ body_html: good }), true);
  assert.equal(R.isFull({ body_html: good, format: 'body' }), false);
});
