// Click tracking — the escaping trap, the open redirect, and failing open.
//
//   node tests/comms-click-tracking.test.js
//
// Three things here are easy to get wrong and expensive to get wrong:
//
//   1. THE ESCAPE ORDER. Link rewriting happens AFTER commsEscapeHtml_, so a URL
//      arrives as https://x/a?b=1&amp;c=2. Encoding that verbatim sends the reader
//      to a destination containing a literal "&amp;" — every multi-parameter link
//      in every campaign silently breaks.
//   2. THE OPEN REDIRECT. An endpoint that forwards to whatever is in ?u= is an
//      open redirect on your own domain. The HMAC is what closes it.
//   3. FAILING OPEN. With no secret configured, links must still work. A missing
//      setting may cost us analytics; it may never cost a customer their link.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const COMMS_SRC = path.join(__dirname, '..', 'appscript', 'Comms.js');

let pass = 0, fail = 0;
function t(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail ? '  ' + detail : '')); }
}

function build(props = {}, logRows = []) {
  const patched = [];
  const ctx = {
    console, JSON, Math, String, Number, Array, Object, RegExp, Date, isNaN,
    encodeURIComponent, decodeURIComponent,
    Logger: { log: () => {} },
    Utilities: {
      getUuid: () => 'u',
      formatDate: d => new Date(d).toISOString(),
      // Real HMAC, so a signature forged in the test is a signature the code
      // would actually have rejected in production.
      computeHmacSha256Signature: (msg, key) => {
        const buf = crypto.createHmac('sha256', String(key)).update(String(msg)).digest();
        return Array.from(buf).map(b => (b > 127 ? b - 256 : b));
      }
    },
    SpreadsheetApp: { getActiveSpreadsheet: () => null, openById: () => null },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    ScriptApp: { getProjectTriggers: () => [], getService: () => ({ getUrl: () => 'https://script.google.com/exec' }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'p@x.com' }), getActiveUser: () => ({ getEmail: () => '' }) },
    MailApp: { getRemainingDailyQuota: () => 1500 },
    GmailApp: { getAliases: () => [] },
    HtmlService: { createHtmlOutput: h => ({ _html: h, getContent: () => h }) },
    UrlFetchApp: { fetch: () => { throw new Error('no network'); } },
    huHeader_: h => String(h == null ? '' : h).trim().toLowerCase().replace(/ /g, '_'),
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (props[k] === undefined ? null : props[k]),
      setProperty: () => {}, deleteProperty: () => {} }) }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(COMMS_SRC, 'utf8'), ctx, { filename: 'Comms.js' });
  ctx.commsSheet_ = () => ({});
  ctx.commsActualHeaders_ = () => [];
  ctx.commsSheetRows_ = () => logRows;
  ctx.commsPatchRow_ = (sh, h, row, patch) => { patched.push({ row, patch }); };
  ctx.commsUnsubPage_ = (heading, msg) => ({ _page: heading + '|' + msg });
  return { ctx, patched };
}

const SECRET = 's3cret';
const TRACK = { recipientId: 'rec-1' };
const hrefOf = html => (html.match(/href="([^"]*)"/) || [])[1] || '';
const uParam = href => {
  const m = href.replace(/&amp;/g, '&').match(/[?&]u=([^&]*)/);
  return m ? decodeURIComponent(m[1]) : '';
};

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nThe escaping trap: a multi-parameter link must survive intact');
{
  const { ctx } = build({ COMMS_CLICK_SECRET: SECRET });
  const DEST = 'https://missioncustompools.com/book?utm_source=email&utm_campaign=spring&ref=1';
  const html = ctx.commsRenderBody_('Book now: [here](' + DEST + ')', {}, TRACK);

  t('the destination round-trips byte for byte', uParam(hrefOf(html)) === DEST, uParam(hrefOf(html)));
  t('no literal &amp; leaked into the destination', uParam(hrefOf(html)).indexOf('&amp;') === -1);
  t('the visible link text is preserved', />here</.test(html));
  t('the href points at our endpoint', /action=comms_click/.test(hrefOf(html)));
  t('and carries the recipient', /[?&]r=rec-1/.test(hrefOf(html).replace(/&amp;/g, '&')));

  // The href itself lives in an HTML attribute, so its own separators must be
  // escaped or the markup breaks.
  t('the href is escaped for the attribute', hrefOf(html).indexOf('&amp;') !== -1);
}

console.log('\nWhat gets rewritten, and what must not');
{
  const { ctx } = build({ COMMS_CLICK_SECRET: SECRET });
  const R = (m) => ctx.commsRenderBody_(m, {}, TRACK);

  t('an https link is tracked', /action=comms_click/.test(R('[a](https://x.com/p)')));
  t('an http link is tracked', /action=comms_click/.test(R('[a](http://x.com/p)')));
  // A reader tapping "call us" should get their dialler, not a round trip.
  t('a tel: link is left alone', /href="tel:2105550000"/.test(R('[call](tel:2105550000)')));
  t('a mailto: link is left alone', /href="mailto:a@x.com"/.test(R('[mail](mailto:a@x.com)')));

  // The protocol allowlist is checked before rewriting, so tracking can never be
  // used to smuggle something past it.
  const bad = R('[x](javascript:alert(1))');
  t('a javascript: link is still dropped', !/javascript:/.test(bad) && !/comms_click/.test(bad), bad);
  t('but its visible text survives', />x</.test(bad) || /x/.test(bad));

  // Untracked rendering (preview, test draft) must be unchanged.
  const untracked = ctx.commsRenderBody_('[a](https://x.com/p)', {});
  t('rendering without a tracking context is untouched',
    /href="https:\/\/x.com\/p"/.test(untracked) && !/comms_click/.test(untracked));
}

console.log('\nNo secret means no tracking — never a broken link');
{
  const { ctx } = build({});   // COMMS_CLICK_SECRET unset
  const html = ctx.commsRenderBody_('[a](https://x.com/p?a=1&b=2)', {}, TRACK);
  t('the link still works', /href="https:\/\/x.com\/p\?a=1&amp;b=2"/.test(html), hrefOf(html));
  t('it is simply not tracked', !/comms_click/.test(html));

  const { ctx: c2 } = build({ COMMS_CLICK_SECRET: SECRET });
  const noRid = c2.commsRenderBody_('[a](https://x.com/p)', {}, {});
  t('a missing recipient id also falls back to a plain link', !/comms_click/.test(noRid));
}

console.log('\nThe redirect refuses anything it did not sign');
{
  const { ctx, patched } = build({ COMMS_CLICK_SECRET: SECRET },
    [{ _row: 5, recipient_id: 'rec-1', clicked_at: '' }]);
  const DEST = 'https://missioncustompools.com/book?a=1&b=2';
  const sig = ctx.commsClickSig_(SECRET, 'rec-1', DEST);

  const good = ctx.handleCommsClick_({ parameter: { r: 'rec-1', u: DEST, sig } });
  const html = good.getContent ? good.getContent() : '';
  t('a correctly signed link redirects', html.indexOf(DEST) !== -1 || /location.replace/.test(html));
  t('and the click is recorded', patched.length === 1 && !!patched[0].patch.clicked_at);
  t('on the right row', patched[0].row === 5);

  // Tampering with the destination is the open-redirect attack.
  const evil = ctx.handleCommsClick_({
    parameter: { r: 'rec-1', u: 'https://phishing.example.com/steal', sig } });
  t('a tampered destination is refused', !!evil._page, JSON.stringify(evil).slice(0, 80));
  t('and is NOT redirected to', !/phishing/.test(JSON.stringify(evil._page || '')));

  t('a missing signature is refused', !!ctx.handleCommsClick_({ parameter: { r: 'rec-1', u: DEST } })._page);
  t('a signature for another recipient is refused',
    !!ctx.handleCommsClick_({ parameter: { r: 'rec-2', u: DEST, sig } })._page);
  t('an empty request is refused', !!ctx.handleCommsClick_({ parameter: {} })._page);

  // With no secret nothing can be verified, so nothing may be forwarded.
  const { ctx: c3 } = build({}, [{ _row: 5, recipient_id: 'rec-1', clicked_at: '' }]);
  t('an unconfigured endpoint refuses rather than forwarding',
    !!c3.handleCommsClick_({ parameter: { r: 'rec-1', u: DEST, sig } })._page);
}

console.log('\nA click is counted once');
{
  const DEST = 'https://x.com/p';
  const { ctx, patched } = build({ COMMS_CLICK_SECRET: SECRET },
    [{ _row: 5, recipient_id: 'rec-1', clicked_at: '2026-08-20T00:00:00Z' }]);
  const sig = ctx.commsClickSig_(SECRET, 'rec-1', DEST);
  ctx.handleCommsClick_({ parameter: { r: 'rec-1', u: DEST, sig } });
  t('a second click does not overwrite the first', patched.length === 0);

  // ...but must still reach the destination.
  const out = ctx.handleCommsClick_({ parameter: { r: 'rec-1', u: DEST, sig } });
  t('and the reader still gets through', (out.getContent ? out.getContent() : '').indexOf(DEST) !== -1);

  // An unknown recipient must not throw — the link still has to work.
  const { ctx: c2 } = build({ COMMS_CLICK_SECRET: SECRET }, []);
  const s2 = c2.commsClickSig_(SECRET, 'ghost', DEST);
  let threw = null;
  try { c2.handleCommsClick_({ parameter: { r: 'ghost', u: DEST, sig: s2 } }); } catch (e) { threw = e; }
  t('an unknown recipient does not break the redirect', threw === null, String(threw));
}

console.log('\nUnescaping is exact');
{
  const { ctx } = build();
  t('entities reverse correctly',
    ctx.commsUnescapeHtml_('a&lt;b&gt;c&amp;d&quot;e&#39;f') === 'a<b>c&d"e\'f');
  // &amp; must be undone LAST, or &amp;lt; becomes "<" instead of "&lt;".
  t('a double-escaped entity is not over-decoded',
    ctx.commsUnescapeHtml_('&amp;lt;') === '&lt;');
  t('escape then unescape is a round trip',
    ctx.commsUnescapeHtml_(ctx.commsEscapeHtml_('x?a=1&b=<2>')) === 'x?a=1&b=<2>');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
