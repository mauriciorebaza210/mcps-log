// Duplicate Clients merge — soft merge, no deletion.
//
//   node tests/merge-clients.test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = path.join(__dirname, '..', 'appscript/MergeClients.js');

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };

const CLIENT_HEADERS = ['client_id','first_name','last_name','display_name','email','phone','billing_address','billing_city','billing_state','billing_zip','status','created_at','updated_at','legacy_quote_ids','notes'];
const LOCATION_HEADERS = ['location_id','client_id','pool_id','service_address','city','state','zip_code','area','active','created_at','updated_at','notes'];
const PROPOSAL_HEADERS = ['proposal_id','client_id','location_id','updated_at'];
const SERVICE_HEADERS = ['service_account_id','client_id','location_id','updated_at'];
const AGREEMENT_HEADERS = ['agreement_id','client_id','location_id','updated_at'];
const QUOTE_HEADERS = ['quote_id','client_id','location_id'];
const LOG_HEADERS = ['timestamp','merge_id','survivor_client_id','duplicate_client_id','merged_by','reason','updated_counts','notes'];

function norm(h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); }

function Sheet(name, headers, rows) {
  return {
    name, headers: headers.slice(), rows: (rows || []).map(r => headers.map(h => r[h] || '')),
    getName() { return name; },
    getLastRow() { return this.rows.length + 1; },
    getLastColumn() { return this.headers.length; },
    getDataRange() { return { getValues: () => [this.headers.slice(), ...this.rows.map(r => r.slice())] }; },
    getRange(row, col, nr, nc) {
      const self = this;
      return {
        getValues() {
          if (row === 1) return [self.headers.slice(col - 1, col - 1 + (nc || self.headers.length))];
          return self.rows.slice(row - 2, row - 2 + (nr || 1)).map(r => r.slice(col - 1, col - 1 + (nc || 1)));
        },
        setValue(v) {
          if (row === 1) self.headers[col - 1] = v;
          else self.rows[row - 2][col - 1] = v;
        },
        setValues(values) {
          if (row === 1) self.headers = values[0].slice();
          return this;
        },
        setFontWeight() { return this; }
      };
    },
    setFrozenRows() {},
    appendRow(row) { this.rows.push(row.slice()); }
  };
}

function build() {
  const sheets = {
    Clients: Sheet('Clients', CLIENT_HEADERS, [
      { client_id:'CLI-001', first_name:'Tony', last_name:'Siller', display_name:'Tony Siller', email:'tony@example.com', phone:'', status:'active', legacy_quote_ids:'["Q-1"]' },
      { client_id:'CLI-002', first_name:'Anthony', last_name:'Siller', display_name:'Anthony Siller', email:'tony@example.com', phone:'2105551000', status:'prospect', legacy_quote_ids:'["Q-2"]' },
      { client_id:'CLI-003', first_name:'Ana', last_name:'Garcia', display_name:'Ana Garcia', email:'ana@example.com', phone:'2105552000', status:'active', legacy_quote_ids:'[]' }
    ]),
    Client_Locations: Sheet('Client_Locations', LOCATION_HEADERS, [
      { location_id:'LOC-2', client_id:'CLI-002', pool_id:'P-2', service_address:'123 Pool Lane', city:'San Antonio', state:'TX', zip_code:'78258', active:'TRUE' }
    ]),
    Proposals: Sheet('Proposals', PROPOSAL_HEADERS, [{ proposal_id:'PROP-2', client_id:'CLI-002', location_id:'LOC-2' }]),
    Service_Accounts: Sheet('Service_Accounts', SERVICE_HEADERS, [{ service_account_id:'SA-2', client_id:'CLI-002', location_id:'LOC-2' }]),
    Service_Agreements: Sheet('Service_Agreements', AGREEMENT_HEADERS, [{ agreement_id:'AGR-2', client_id:'CLI-002', location_id:'LOC-2' }]),
    Quotes: Sheet('Quotes', QUOTE_HEADERS, [{ quote_id:'Q-2', client_id:'CLI-002', location_id:'LOC-2' }]),
    Merge_Log: Sheet('Merge_Log', LOG_HEADERS, [])
  };

  function sheetToObjects_(sheet) {
    const h = sheet.headers.map(norm);
    return { headers: h, rows: sheet.rows.map((r, i) => {
      const obj = { _rowNum: i + 2 };
      h.forEach((k, j) => { obj[k] = r[j]; });
      return obj;
    }) };
  }
  function value_(obj, name, fallback) {
    const v = obj ? obj[norm(name)] : undefined;
    return v !== undefined && v !== null && v !== '' ? v : (fallback || '');
  }
  function findRowByValue_(sheet, field, val) {
    return sheetToObjects_(sheet).rows.find(r => String(value_(r, field)).trim() === String(val || '').trim()) || null;
  }
  function softSetCell_(sheet, rowNum, field, val) {
    let idx = sheet.headers.map(norm).indexOf(norm(field));
    if (idx === -1) { idx = sheet.headers.length; sheet.headers.push(field); sheet.rows.forEach(r => r.push('')); }
    sheet.rows[rowNum - 2][idx] = val == null ? '' : val;
  }
  function appendObject_(sheet, obj, headers) {
    sheet.appendRow(sheet.headers.map(h => obj[norm(h)] != null ? obj[norm(h)] : ''));
  }
  function nextSequence_(sheet, idColumn, prefix, width) {
    return prefix + '-' + String(sheet.rows.length + 1).padStart(width || 6, '0');
  }

  const ctx = {
    console, Date, String, Number, Math, JSON, Array, Object, isNaN, Infinity, RegExp,
    Logger: { log: () => {} },
    LockService: { getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) },
    MCPS_CLIENT_HEADERS: CLIENT_HEADERS,
    MCPS_LOCATION_HEADERS: LOCATION_HEADERS,
    MCPS_PROPOSAL_HEADERS: PROPOSAL_HEADERS,
    MCPS_SERVICE_ACCOUNT_HEADERS: SERVICE_HEADERS,
    MCPS_SERVICE_AGREEMENT_HEADERS: AGREEMENT_HEADERS,
    ensureSheet_: (name, headers) => sheets[name] || (sheets[name] = Sheet(name, headers || [], [])),
    getCrmSheet_: () => sheets.Quotes,
    sheetToObjects_, value_, findRowByValue_, softSetCell_, appendObject_, nextSequence_,
    parseJsonArray_: raw => { try { const x = raw ? JSON.parse(String(raw)) : []; return Array.isArray(x) ? x : []; } catch(e) { return []; } },
    normalizeEmail_: v => String(v || '').trim().toLowerCase(),
    normalizePhone_: v => String(v || '').replace(/\D/g, ''),
    normalizeAddress_: v => String(v || '').toLowerCase().replace(/[.,#]/g, '').replace(/\s+/g, ' ').trim(),
    nowIso_: () => '2026-08-16T12:00:00Z'
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'MergeClients.js' });
  return { ctx, sheets, value_ };
}

console.log('\nDuplicate detection');
{
  const { ctx } = build();
  const res = ctx.handleFindDuplicatePeople_({});
  t('scan succeeds', res.ok === true);
  t('same email group found', res.groups.some(g => g.clients.map(c => c.client_id).includes('CLI-001') && g.clients.map(c => c.client_id).includes('CLI-002')));
  t('unrelated client is not pulled into the group',
    !res.groups.some(g => g.clients.map(c => c.client_id).includes('CLI-003') && g.clients.map(c => c.client_id).includes('CLI-001')));
}

console.log('\nSoft merge repoints records and keeps audit trail');
{
  const { ctx, sheets, value_ } = build();
  const res = ctx.handleMergeClients_({
    survivor_client_id: 'CLI-001',
    duplicate_client_id: 'CLI-002',
    merged_by: 'tester',
    reason: 'same_email'
  });
  t('merge succeeds', res.ok === true, '(got ' + JSON.stringify(res) + ')');
  t('location repointed', sheets.Client_Locations.rows[0][LOCATION_HEADERS.indexOf('client_id')] === 'CLI-001');
  t('proposal repointed', sheets.Proposals.rows[0][PROPOSAL_HEADERS.indexOf('client_id')] === 'CLI-001');
  t('service account repointed', sheets.Service_Accounts.rows[0][SERVICE_HEADERS.indexOf('client_id')] === 'CLI-001');
  t('agreement repointed', sheets.Service_Agreements.rows[0][AGREEMENT_HEADERS.indexOf('client_id')] === 'CLI-001');
  t('quote repointed', sheets.Quotes.rows[0][QUOTE_HEADERS.indexOf('client_id')] === 'CLI-001');

  const clients = ctx.sheetToObjects_(sheets.Clients).rows;
  const survivor = clients.find(c => value_(c, 'client_id') === 'CLI-001');
  const dup = clients.find(c => value_(c, 'client_id') === 'CLI-002');
  t('survivor kept and filled blank phone from duplicate', value_(survivor, 'phone') === '2105551000');
  t('duplicate row is marked merged, not deleted', value_(dup, 'status') === 'merged');
  t('duplicate notes point at survivor', /CLI-001/.test(value_(dup, 'notes')));
  t('merge log written', sheets.Merge_Log.rows.length === 1);
}

if (fail) {
  console.log(`\n${fail} failing assertion(s), ${pass} passing`);
  process.exit(1);
}
console.log(`\nAll ${pass} assertions passed`);
