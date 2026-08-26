// Branded email wrapper — footer safety suite.
//
//   node tests/comms-email-footer.test.js
//
// buildCommsEmailHtml_ wraps EVERY campaign email, and its footer is customer-
// facing. It previously rendered a literal
//   [Business mailing address not set — set COMMS_BUSINESS_ADDRESS]
// whenever the COMMS_BUSINESS_ADDRESS script property was unset — i.e. a
// configuration reminder addressed to staff, delivered to customers, with nothing
// anywhere warning that it was happening.
//
// The rule this file enforces: missing config degrades the footer QUIETLY for the
// customer and LOUDLY for staff. Never the other way round.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const COMMS_SRC = path.join(__dirname, '..', 'appscript', 'Comms.js');
const SENDERS_SRC = path.join(__dirname, '..', 'appscript', 'CommsSenders.js');

let pass = 0;
let fail = 0;
function t(name, condition, detail = '') {
  if (condition) { pass += 1; console.log('  ok - ' + name); }
  else { fail += 1; console.log('  FAIL - ' + name + (detail ? ' ' + detail : '')); }
}

function build(props = {}) {
  const ctx = {
    console, JSON, Math, String, Number, Array, Object, RegExp, Date, isNaN, encodeURIComponent,
    Logger: { log: () => {} },
    Utilities: { getUuid: () => 'u', formatDate: d => new Date(d).toISOString(),
                 computeHmacSha256Signature: () => [1, 2, 3] },
    SpreadsheetApp: { getActiveSpreadsheet: () => null, openById: () => null },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    ScriptApp: { getProjectTriggers: () => [] },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'p@x.com' }), getActiveUser: () => ({ getEmail: () => '' }) },
    MailApp: { getRemainingDailyQuota: () => 1500 },
    GmailApp: { getAliases: () => [] },
    UrlFetchApp: { fetch: () => { throw new Error('no network'); } },
    huHeader_: h => String(h == null ? '' : h).trim().toLowerCase().replace(/ /g, '_'),
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (props[k] === undefined ? null : props[k]),
        setProperty: () => {}, deleteProperty: () => {}
      })
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(COMMS_SRC, 'utf8'), ctx, { filename: 'Comms.js' });
  vm.runInContext(fs.readFileSync(SENDERS_SRC, 'utf8'), ctx, { filename: 'CommsSenders.js' });
  ctx.commsSheetRows_ = () => [];
  ctx.commsEnsureSheets_ = () => {};
  return ctx;
}

console.log('\nUnset business address');
{
  const ctx = build({});
  const html = ctx.buildCommsEmailHtml_('<p>Hello</p>', { unsubscribeUrl: 'https://x/u' });
  t('no bracketed reminder reaches the customer',
    html.indexOf('[Business mailing address') === -1);
  t('the property name is never leaked into the email at all',
    html.indexOf('COMMS_BUSINESS_ADDRESS') === -1);
  t('and no stray placeholder brackets survive anywhere',
    !/\[[^\]]*not set[^\]]*\]/i.test(html));
  t('the email still renders', html.indexOf('<p>Hello</p>') !== -1 && /<\/html>/.test(html));
  t('the rest of the footer is intact',
    html.indexOf('(210) 559-2073') !== -1 && html.indexOf('missioncustompools.com') !== -1);
  t('no empty line is left where the address was',
    html.indexOf('<br><br>') === -1);
}

console.log('\nAddress set');
{
  const ctx = build({ COMMS_BUSINESS_ADDRESS: '123 Main St, San Antonio, TX 78201' });
  const html = ctx.buildCommsEmailHtml_('<p>Hi</p>', {});
  t('the address renders', html.indexOf('123 Main St, San Antonio, TX 78201') !== -1);
  t('followed by a line break before the phone',
    /78201<br>/.test(html));
}

{
  // The footer is built by string concatenation, so an unescaped address would be
  // an HTML injection into every customer's inbox.
  const ctx = build({ COMMS_BUSINESS_ADDRESS: '<script>alert(1)</script> & "Ste 5"' });
  const html = ctx.buildCommsEmailHtml_('<p>Hi</p>', {});
  t('an address containing markup is escaped',
    html.indexOf('<script>alert(1)</script>') === -1 && html.indexOf('&lt;script&gt;') !== -1);
  t('ampersands and quotes are escaped too',
    html.indexOf('&amp;') !== -1 && html.indexOf('&quot;Ste 5&quot;') !== -1);
}

console.log('\nStaff are told instead');
{
  const ctx = build({});
  const status = ctx.commsConfigStatus_();
  t('config status reports the missing address',
    (status.missing_properties || []).indexOf('COMMS_BUSINESS_ADDRESS') !== -1,
    '→ ' + JSON.stringify(status.missing_properties));
}
{
  const ctx = build({ COMMS_BUSINESS_ADDRESS: '123 Main St' });
  t('and stops reporting it once set',
    (ctx.commsConfigStatus_().missing_properties || []).indexOf('COMMS_BUSINESS_ADDRESS') === -1);
}
{
  const ctx = build({});
  const mine = ctx.handleCommsMySender_({ username: 'nobody' });
  t('the compose screen is told as well',
    (mine.missing_config || []).indexOf('COMMS_BUSINESS_ADDRESS') !== -1);
  t('without that masking the separate sender problem',
    mine.source === 'unconfigured');
}
{
  const ctx = build({ COMMS_BUSINESS_ADDRESS: '123 Main St' });
  t('nothing is reported when config is complete',
    (ctx.handleCommsMySender_({ username: 'nobody' }).missing_config || []).length === 0);
}

console.log('\nSource guard');
{
  const src = fs.readFileSync(COMMS_SRC, 'utf8');
  t('the reminder string is gone from the renderer',
    src.indexOf('[Business mailing address not set') === -1);
  const ui = fs.readFileSync(path.join(__dirname, '..', 'js/features/comms.js'), 'utf8');
  t('the compose screen renders missing_config',
    /missing_config/.test(ui) && /footer will be incomplete/.test(ui));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
