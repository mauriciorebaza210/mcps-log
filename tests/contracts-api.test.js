// api/contracts.js — the fast Sheets-reading endpoint behind the Contracts page.
//
//   node tests/contracts-api.test.js        (exits non-zero on failure)
//
// Covers the two things that matter most here:
//
//   1. THE ADMIN GATE. This endpoint returns contract pricing, signer IPs and the
//      full ESIGN audit trail for every customer. hasAdminAccess() is the only
//      thing standing between that and any signed-in technician.
//
//   2. THE CUSTOMER JOIN. Contracts store no customer name — only who signed. If
//      the join regresses, the page falls back to showing agreement numbers as
//      identity, which staff cannot read.
//
// ⚠️ SCOPE NOTE, stated plainly: these exercise the exported pure functions. The
// handler's own 401/403 wiring is NOT invoked here — it depends on ES-module
// imports (validatePortalSessionFromSheets) that would need a loader hook to
// intercept. What is asserted instead is that the gate FUNCTION is correct and
// that the handler references it. That is weaker than an end-to-end request test
// and should not be described as one.
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };

(async () => {
  const contracts = await import(pathToFileURL(path.join(ROOT, 'api/contracts.js')).href);
  const sheets = await import(pathToFileURL(path.join(ROOT, 'api/_sheets.js')).href);
  const { hasAdminAccess } = sheets;
  const { withContractCustomerNames, withContractFollowups } = contracts;

  // ── The gate ──────────────────────────────────────────────────────────────
  console.log('\n⚠️  Admin gate — this endpoint exposes pricing, signer IPs and audit trails');
  const cases = [
    ['admin',                { roles: ['admin'] },                       true ],
    ['manager',              { roles: ['manager'] },                     true ],
    ['admin among several',  { roles: ['technician', 'admin'] },         true ],
    ['mixed case role',      { roles: ['Admin'] },                       true ],
    ['padded role',          { roles: ['  manager  '] },                 true ],
    ['nested under user',    { user: { roles: ['admin'] } },             true ],
    ['technician',           { roles: ['technician'] },                  false],
    ['lead',                 { roles: ['lead'] },                        false],
    ['office',               { roles: ['office'] },                      false],
    ['trainee',              { roles: ['trainee'] },                     false],
    ['no roles',             { roles: [] },                              false],
    ['empty session',        {},                                         false],
    ['null session',         null,                                       false],
  ];
  cases.forEach(([label, session, expected]) => {
    t(`${expected ? 'ALLOWS' : 'refuses'}: ${label}`, hasAdminAccess(session) === expected);
  });

  console.log('\nThe handler actually uses that gate');
  const src = fs.readFileSync(path.join(ROOT, 'api/contracts.js'), 'utf8');
  t('rejects a missing/invalid session with 401', /401.*Unauthorized/s.test(src));
  t('rejects a non-admin session with 403', /hasAdminAccess\(session\)[\s\S]{0,80}403/.test(src));
  t('the 403 check comes AFTER the 401 check',
    src.indexOf('401') < src.indexOf('hasAdminAccess(session)'));
  t('non-GET is refused', /req\.method !== 'GET'[\s\S]{0,80}405/.test(src));

  // ── The join ──────────────────────────────────────────────────────────────
  console.log('\nCustomer join: Clients → Client_Locations → quote (quote LAST)');
  {
    const agreements = [{ agreement_id: 'AGR-1', client_id: 'C1', location_id: 'L1', source_quote_id: 'Q1' }];
    const clients   = [{ client_id: 'C1', display_name: 'Rivera Household',
                         first_name: 'Blasa', last_name: 'Rodriguez' }];
    const locations = [{ location_id: 'L1', service_address: '123 Mission Creek Dr', city: 'San Antonio' }];
    // Deliberately WRONG quote data — it must lose to the normalized records.
    const quotes    = [{ quote_id: 'Q1', first_name: 'Someone', last_name: 'Else',
                         address: '999 Wrong St', city: 'Nowhere' }];
    const out = withContractCustomerNames(agreements, clients, locations, quotes);
    t('prefers Clients.display_name over the quote', out[0].customer_name === 'Rivera Household',
      '(got ' + out[0].customer_name + ')');
    t('location label from Client_Locations',
      out[0].location_label === '123 Mission Creek Dr, San Antonio',
      '(got ' + out[0].location_label + ')');
    t('does not mutate the input row', agreements[0].customer_name === undefined);
  }

  console.log('Falls back to first+last when there is no display_name');
  {
    const out = withContractCustomerNames(
      [{ agreement_id: 'AGR-1', client_id: 'C1' }],
      [{ client_id: 'C1', first_name: 'Blasa', last_name: 'Rodriguez' }], [], []);
    t('composes first + last', out[0].customer_name === 'Blasa Rodriguez',
      '(got ' + out[0].customer_name + ')');
  }

  console.log('Falls back to the QUOTE only when the normalized records miss');
  {
    const out = withContractCustomerNames(
      [{ agreement_id: 'AGR-1', client_id: '', location_id: '', source_quote_id: 'Q1' }], [], [],
      [{ quote_id: 'Q1', first_name: 'Blasa', last_name: 'Rodriguez',
         address: '123 Mission Creek Dr', city: 'San Antonio' }]);
    t('name from the quote', out[0].customer_name === 'Blasa Rodriguez',
      '(got ' + out[0].customer_name + ')');
    t('address from the quote', out[0].location_label === '123 Mission Creek Dr, San Antonio',
      '(got ' + out[0].location_label + ')');
  }

  console.log('Unresolvable identity yields EMPTY, never a placeholder');
  {
    const out = withContractCustomerNames(
      [{ agreement_id: 'AGR-1', client_id: '', location_id: '', source_quote_id: '' }], [], [], []);
    // ⚠️ The frontend decides what to show when this is blank (signer, then
    // property, then agreement number as an error state). It must never receive
    // an invented name, and never the literal word "Customer".
    t('customer_name is an empty string', out[0].customer_name === '',
      '(got "' + out[0].customer_name + '")');
    t('never the literal word "Customer"', out[0].customer_name !== 'Customer');
    t('location_label empty too', out[0].location_label === '');
  }

  console.log('Join survives messy input');
  {
    t('empty agreement list', JSON.stringify(withContractCustomerNames([], [], [], [])) === '[]');
    t('null agreement list', JSON.stringify(withContractCustomerNames(null, null, null, null)) === '[]');
    const out = withContractCustomerNames(
      [{ agreement_id: 'AGR-1', client_id: 'NOPE', location_id: 'NOPE', source_quote_id: 'NOPE' }],
      [{ client_id: 'C1', display_name: 'X' }], [{ location_id: 'L1', service_address: 'Y' }],
      [{ quote_id: 'Q1', first_name: 'Z' }]);
    t('ids that match nothing resolve to empty, not to the first row',
      out[0].customer_name === '' && out[0].location_label === '');
  }

  // ── Follow-up state attached to the agreement rows ────────────────────────
  console.log('\nFollow-up state is surfaced on the agreement row');
  {
    const agreements = [{ agreement_id: 'AGR-1', proposal_id: 'P1', source_quote_id: 'Q1' }];
    const approvals = [{ approval_id: 'A1', proposal_id: 'P1', quote_id: 'Q1', status: 'SENT',
                         followup_next_index: '2', followup_cycle: '1',
                         last_followup_error: 'skipped_to_latest',
                         followup_stopped_reason: '', sent_at: '2026-08-01T00:00:00Z' }];
    const out = withContractFollowups(agreements, approvals);
    t('carries the follow-up position', out[0].followup_next_index === '2');
    t('carries the resend cycle', out[0].followup_cycle === '1');
    t('carries the last error', out[0].last_followup_error === 'skipped_to_latest');
    t('carries the approval status', out[0].approval_status === 'SENT');
    t('does not mutate the input row', agreements[0].followup_next_index === undefined);
  }

  console.log('No matching approval leaves the row untouched');
  {
    const out = withContractFollowups([{ agreement_id: 'AGR-1', proposal_id: 'PX' }], []);
    t('no follow-up fields invented', out[0].followup_next_index === undefined);
    t('row still returned', out[0].agreement_id === 'AGR-1');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('\nHARNESS ERROR: ' + (e && e.stack || e));
  process.exit(2);
});
