// Stage 4d — expired-link recovery. Exercises the real ActionQueue.js against
// in-memory sheets; only the Sheets access helpers are stubbed.
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = path.join(__dirname, '..', 'appscript/ActionQueue.js');

const iso = d => new Date(d).toISOString();
const DAY = 86400000;
const NOW = Date.now();

function Sheet(headers, rows) {
  return {
    rows: [headers.slice(), ...rows.map(r => r.slice())],
    getLastRow() { return this.rows.length; },
    getDataRange() { return { getValues: () => this.rows }; }
  };
}

function build(opts) {
  const o = opts || {};
  const quotes = Sheet(
    ['quote_id','first_name','last_name','service','address','pool_id',
     'requested_start_date','requested_start_at','service_start','proposal_sent_at'],
    o.quotes || []);
  const approvals = Sheet(
    ['approval_id','proposal_id','quote_id','token','status','customer_note',
     'sent_at','responded_at','expires_at','created_at','updated_at'].concat(o.extraCols || []),
    o.approvals || []);

  const ctx = {
    console, Date, String, Number, Math, JSON, Array, Object,
    MCPS_PROPOSAL_APPROVAL_HEADERS: approvals.rows[0].slice(),
    ensureNormalizedSalesSheets_() {},
    getCrmSheet_: () => quotes,
    ensureSheet_: name => (name === 'Proposal_Approvals' ? approvals : quotes),
    nowIso_: () => iso(NOW),
    hdr_(sheet, f) { return sheet.rows[0].indexOf(f); },
    findRowByValue_(sheet, field, val) {
      const h = sheet.rows[0], i = h.indexOf(field);
      if (i === -1) return null;
      for (let r = 1; r < sheet.rows.length; r++) {
        if (String(sheet.rows[r][i]) === String(val)) {
          const obj = {}; h.forEach((k, c) => obj[k] = sheet.rows[r][c]);
          obj._rowNum = r + 1; return obj;
        }
      }
      return null;
    },
    value_: (obj, f) => (obj && obj[f] != null ? obj[f] : ''),
    softSetCell_(sheet, rowNum, field, val) {
      const i = sheet.rows[0].indexOf(field);
      if (i === -1) throw new Error('softSetCell_ on missing column: ' + field);
      sheet.rows[rowNum - 1][i] = val;
    },
    ensureColumn_(sheet, name) {
      if (sheet.rows[0].indexOf(name) !== -1) return;
      sheet.rows[0].push(name);
      for (let r = 1; r < sheet.rows.length; r++) sheet.rows[r].push('');
    },
    getQuoteById_(id) {
      const h = quotes.rows[0], i = h.indexOf('quote_id');
      for (let r = 1; r < quotes.rows.length; r++) {
        if (String(quotes.rows[r][i]) === String(id)) {
          const obj = {}; h.forEach((k, c) => obj[k] = quotes.rows[r][c]);
          return { object: obj, sheet: quotes, rowNum: r + 1 };
        }
      }
      return null;
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'ActionQueue.js' });
  return { ctx, quotes, approvals };
}

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };
const col = (sheet, field, rowNum) => sheet.rows[rowNum - 1][sheet.rows[0].indexOf(field)];

// ── handleRequestQuoteUpdate_ ───────────────────────────────────────────────
console.log('\nhandleRequestQuoteUpdate_');
{
  const mk = () => build({
    quotes: [['Q1','Jordan','Rivera','Weekly Full Service','123 Mission Creek Dr','','','','','']],
    approvals: [['A1','P1','Q1','tok-good','SENT','','', '', iso(NOW - 5*DAY), '', '']]
  });

  let { ctx } = mk();
  t('missing token refused', ctx.handleRequestQuoteUpdate_({}).ok === false);

  ({ ctx } = mk());
  const unknown = ctx.handleRequestQuoteUpdate_({ token: 'nope' });
  const malformed = ctx.handleRequestQuoteUpdate_({ token: '<<>>' });
  t('unknown token refused', unknown.ok === false);
  t('unknown and malformed give identical replies (no token probing)',
    unknown.error === malformed.error, '(' + unknown.error + ' / ' + malformed.error + ')');

  let s = mk();
  const r1 = s.ctx.handleRequestQuoteUpdate_({ token: 'tok-good', note: 'Add spa service' });
  t('valid request accepted', r1.ok === true);
  t('not flagged already on first request', r1.already === false);
  t('update_requested_at written', String(col(s.approvals, 'update_requested_at', 2)) === iso(NOW));
  t('note written', col(s.approvals, 'update_request_note', 2) === 'Add spa service');

  const r2 = s.ctx.handleRequestQuoteUpdate_({ token: 'tok-good', note: '' });
  t('second request flagged already', r2.ok === true && r2.already === true);
  t('empty note does not erase the first', col(s.approvals, 'update_request_note', 2) === 'Add spa service');

  s = mk();
  s.ctx.handleRequestQuoteUpdate_({ token: 'tok-good', note: 'x'.repeat(5000) });
  t('note capped at 1000 chars', String(col(s.approvals, 'update_request_note', 2)).length === 1000);

  // The client must not be able to steer which quote gets the request.
  s = build({
    quotes: [['Q1','Jordan','Rivera','Weekly','123 A','','','','',''],
             ['Q2','Sam','Vega','Weekly','456 B','','','','','']],
    approvals: [['A1','P1','Q1','tok-good','SENT','','','', iso(NOW - 5*DAY), '',''],
                ['A2','P2','Q2','tok-other','SENT','','','', iso(NOW - 5*DAY), '','']]
  });
  s.ctx.handleRequestQuoteUpdate_({ token: 'tok-good', quote_id: 'Q2', approval_id: 'A2', note: 'hi' });
  t('quote resolved from token, not from client payload',
    String(col(s.approvals, 'update_requested_at', 2)) === iso(NOW) &&
    String(col(s.approvals, 'update_requested_at', 3)) === '');

  ['APPROVED','SIGNED'].forEach(st => {
    const g = build({
      quotes: [['Q1','Jordan','Rivera','Weekly','123 A','','','','','']],
      approvals: [['A1','P1','Q1','tok-good', st, '','','', iso(NOW - 5*DAY), '','']]
    });
    const r = g.ctx.handleRequestQuoteUpdate_({ token: 'tok-good' });
    t('refused when already ' + st, r.ok === false);
  });
}

// ── handleGetActionQueue_ ───────────────────────────────────────────────────
console.log('\nhandleGetActionQueue_ — recovery cards');
{
  const withReq = (reqAt, sentAt, status) => build({
    extraCols: ['update_requested_at','update_request_note'],
    quotes: [['Q1','Jordan','Rivera','Weekly Full Service','123 Mission Creek Dr','','','','', sentAt || '']],
    approvals: [['A1','P1','Q1','tok','' + (status || 'SENT'),'','','', iso(NOW - 2*DAY), '','', reqAt, 'Add spa service']]
  });

  let { ctx } = withReq(iso(NOW - 1*DAY), '');
  let res = ctx.handleGetActionQueue_({});
  let rec = res.items.filter(i => i.type === 'recovery');
  t('recovery card emitted', rec.length === 1);
  t('carries the customer note', rec[0] && rec[0].note === 'Add spa service');
  t('names the customer', rec[0] && rec[0].title.includes('Jordan Rivera'));
  t('counts include recovery', res.counts.recovery === 1);
  t('no duplicate expiring card for the same approval',
    res.items.filter(i => i.type === 'expiring').length === 0);

  // Superseded once a newer proposal goes out.
  ({ ctx } = withReq(iso(NOW - 3*DAY), iso(NOW - 1*DAY)));
  res = ctx.handleGetActionQueue_({});
  t('resolved by a newer proposal', res.items.filter(i => i.type === 'recovery').length === 0);

  ({ ctx } = withReq(iso(NOW - 1*DAY), iso(NOW - 3*DAY)));
  res = ctx.handleGetActionQueue_({});
  t('an OLDER proposal does not resolve it', res.items.filter(i => i.type === 'recovery').length === 1);

  // Ranking: recovery above everything else.
  ({ ctx } = build({
    extraCols: ['update_requested_at','update_request_note'],
    quotes: [
      ['Q1','Jordan','Rivera','Weekly','123 A','','','','',''],
      ['Q2','Sam','Vega','Weekly','456 B','','2026-09-01', iso(NOW), '', ''],
      ['Q3','Ali','Chen','Weekly','789 C','','','','','']
    ],
    approvals: [
      ['A1','P1','Q1','t1','SENT','','','', iso(NOW - 1*DAY), '','', iso(NOW - 6*DAY), 'note'],
      ['A3','P3','Q3','t3','SENT','','', iso(NOW), iso(NOW + 2*DAY), '','', '', '']
    ]
  }));
  res = ctx.handleGetActionQueue_({});
  t('recovery sorts first', res.items[0] && res.items[0].type === 'recovery',
    '(got ' + (res.items[0] && res.items[0].type) + ')');
  t('start and expiring still present',
    res.items.some(i => i.type === 'start') && res.items.some(i => i.type === 'expiring'));

  // EXPIRED-status rows must not fall out of the queue.
  ({ ctx } = build({
    quotes: [['Q1','Jordan','Rivera','Weekly','123 A','','','','','']],
    approvals: [['A1','P1','Q1','t1','EXPIRED','','','', iso(NOW - 1*DAY), '','']]
  }));
  res = ctx.handleGetActionQueue_({});
  const exp = res.items.filter(i => i.type === 'expiring');
  t('EXPIRED status still surfaces', exp.length === 1);
  t('labelled Expired', exp[0] && exp[0].kind === 'Expired');

  // No recovery column at all (nobody has ever requested) must not throw.
  ({ ctx } = build({
    quotes: [['Q1','Jordan','Rivera','Weekly','123 A','','','','','']],
    approvals: [['A1','P1','Q1','t1','SENT','','','', iso(NOW + 20*DAY), '','']]
  }));
  res = ctx.handleGetActionQueue_({});
  t('missing recovery columns handled', res.ok === true && res.counts.recovery === 0);
  t('quote outside the warning window is not surfaced', res.items.length === 0);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
