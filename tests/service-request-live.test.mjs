// LIVE end-to-end check for the service-request intake.
//
//   node tests/service-request-live.test.mjs
//
// ⚠️ This one talks to the REAL CRM spreadsheet. It creates rows in
// Service_Requests and deletes them again at the end. It is separate from the
// two pure suites precisely so `node tests/*.test.mjs` in CI does not write to
// production data — run this by hand, deliberately.
//
// What it proves that the pure tests cannot:
//   * a real CRM lead is recognised as themselves, with the right quote_id
//   * the same submission twice produces ONE row, not two
//   * the public endpoint adds NOTHING to Quotes or Clients — the structural
//     invariant the whole duplicate story rests on
//   * the prefill and status endpoints leak no internal ids

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true, quiet: true });
process.env.SERVICE_LINK_SECRET = process.env.SERVICE_LINK_SECRET || 'e2e-temp-secret';

const { crmSpreadsheetId, readSheetRange, rowsToObjects } = await import('../api/_sheets.js');
const handler = (await import('../api/service-request.js')).default;
const { mintLinkToken } = await import('../api/service-request.js');
const ID = crmSpreadsheetId();

let pass=0, fail=0;
const t=(n,c,d='')=>{ if(c){pass++;console.log('  ok - '+n);} else {fail++;console.log('  FAIL - '+n+(d?'  '+d:''));} };

// sendJson() in api/_sheets.js does res.status(n).send(JSON.stringify(body)),
// so the mock has to parse the string back — otherwise every body.ok read is
// undefined and every assertion fails while the endpoint is actually fine.
function mockRes(){ const r={_s:0,_j:null,headers:{}};
  const take=b=>{ r._j = typeof b==='string' ? (()=>{try{return JSON.parse(b)}catch(_){return b}})() : b; return r; };
  r.status=c=>{r._s=c;return r}; r.json=take; r.send=take;
  r.setHeader=(k,v)=>{r.headers[k]=v}; r.end=()=>r; return r; }
const post=async body=>{ const res=mockRes();
  await handler({method:'POST',body,headers:{'user-agent':'e2e-test','x-forwarded-for':'203.0.113.'+Math.floor(Math.random()*250)},query:{},socket:{}},res);
  return {status:res._s, body:res._j}; };
const get=async query=>{ const res=mockRes();
  await handler({method:'GET',query,headers:{},socket:{}},res); return {status:res._s, body:res._j}; };

const countRows = async tab => (await readSheetRange(`${tab}!A:A`, ID)).length;
const quotesBefore = await countRows('Quotes');
const clientsBefore = await countRows('Clients');
console.log(`\nBaseline: Quotes=${quotesBefore} rows, Clients=${clientsBefore} rows`);

// Pick a real LEAD to impersonate.
const quotes = rowsToObjects(await readSheetRange('Quotes', ID));
const realLead = quotes.find(q => String(q.status||'').toUpperCase()==='LEAD' && String(q.email||'').includes('@') && String(q.address||'').trim());
console.log(`Impersonating real lead: ${realLead.quote_id} (${realLead.first_name} ${realLead.last_name})`);

const stamp = Date.now();
const created = [];

console.log('\n1. Brand-new stranger');
{
  const r = await post({ category:'green_to_clean', subcategory:'a_month',
    first_name:'E2ETest', last_name:`Stranger${stamp}`, email:`e2e.${stamp}@e2e-test.invalid`,
    phone:'2105550000', service_address:`${stamp} E2E Test Parkway`, city:'San Antonio',
    zip_code:'78259', description:'e2e automated test row', timing_preference:'flexible' });
  t('accepted', r.status===200 && r.body.ok, JSON.stringify(r.body));
  t('returns a reference number', /^SR-[0-9A-F]{8}$/.test(r.body.request_id||''), r.body.request_id);
  t('returns the category label', r.body.category_label==='Green-to-clean');
  if(r.body.request_id) created.push(r.body.request_id);
}

console.log('\n2. Existing lead — must MATCH, not duplicate');
let leadReqId=null;
{
  const r = await post({ category:'repair', subcategory:'pump',
    first_name:realLead.first_name, last_name:realLead.last_name,
    email:String(realLead.email).toUpperCase(), phone:realLead.phone,
    service_address:String(realLead.address).toLowerCase(), city:realLead.city,
    zip_code:realLead.zip_code, description:'e2e automated test row — pump noise',
    timing_preference:'this_week' });
  t('accepted', r.status===200 && r.body.ok, JSON.stringify(r.body));
  leadReqId = r.body.request_id; if(leadReqId) created.push(leadReqId);
}

console.log('\n3. Resubmit the SAME thing — must update, not append');
{
  const r = await post({ category:'repair', subcategory:'pump',
    first_name:realLead.first_name, last_name:realLead.last_name,
    email:realLead.email, phone:realLead.phone,
    service_address:realLead.address, city:realLead.city, zip_code:realLead.zip_code,
    description:'e2e automated test row — pump noise, resubmitted', timing_preference:'asap' });
  t('accepted', r.status===200 && r.body.ok);
  t('folded into the SAME request', r.body.request_id===leadReqId, `${r.body.request_id} vs ${leadReqId}`);
  t('flagged as an update', r.body.updated===true);
}

console.log('\n4. Validation is enforced end to end');
{
  t('no contact method → 400', (await post({category:'repair', service_address:'1 X St'})).status===400);
  t('unknown category → 400', (await post({category:'free_pool', email:'a@b.com', service_address:'1 X St'})).status===400);
  t('no address → 400', (await post({category:'repair', email:'a@b.com'})).status===400);
}

console.log('\n5. Prefill + status privacy');
{
  const tok = mintLinkToken(realLead.quote_id);
  const r = await get({ k: tok });
  t('a valid token prefills', r.body.ok && r.body.prefill && r.body.prefill.first_name===String(realLead.first_name).trim());
  const leaked = Object.keys(r.body.prefill||{}).filter(k=>['client_id','quote_id','pool_id','email','phone','status'].includes(k));
  t('prefill leaks no internal ids or contact details', leaked.length===0, leaked.join(','));
  t('a forged token falls through to null', (await get({k:'AAAA.bbbbbbbbbbbbbbbb'})).body.prefill===null);
  t('garbage falls through to null', (await get({k:'garbage'})).body.prefill===null);

  const s = await get({ r: leadReqId });
  t('status without contact returns one coarse word', s.body.ok && !!s.body.status && !s.body.verified);
  t('unverified status hides the address', s.body.service_address===undefined);
  const sv = await get({ r: leadReqId, contact: realLead.email });
  t('status WITH the right email unlocks detail', sv.body.verified===true);
  t('verified status still never returns photos', sv.body.photo_urls===undefined);
  const sw = await get({ r: leadReqId, contact: 'wrong@example.com' });
  t('the wrong email does not unlock', !sw.body.verified);
  t('an unknown reference 404s', (await get({r:'SR-00000000'})).status===404);
}

console.log('\n6. THE INVARIANT — the public path wrote nothing to the CRM');
{
  const qAfter = await countRows('Quotes');
  const cAfter = await countRows('Clients');
  t('no Quotes rows added', qAfter===quotesBefore, `${quotesBefore} -> ${qAfter}`);
  t('no Clients rows added', cAfter===clientsBefore, `${clientsBefore} -> ${cAfter}`);
}

console.log('\n7. What landed in Service_Requests');
{
  const rows = rowsToObjects(await readSheetRange('Service_Requests', ID));
  const mine = rows.filter(r=>created.includes(r.request_id));
  t('exactly 2 rows for 3 submissions (idempotency held)', mine.length===2, `got ${mine.length}`);
  const stranger = mine.find(r=>String(r.email).includes('e2e-test.invalid'));
  const lead = mine.find(r=>r.request_id===leadReqId);
  t('the stranger got NO match', stranger && stranger.match_status==='none', stranger&&stranger.match_status);
  t('the stranger has no pool_id', stranger && !stranger.match_pool_id);
  t('the real lead MATCHED confidently', lead && lead.match_status==='confident', lead&&lead.match_status);
  t('the match points at the right quote', lead && lead.match_quote_id===realLead.quote_id, `${lead&&lead.match_quote_id} vs ${realLead.quote_id}`);
  t('match reasons recorded', lead && String(lead.match_reasons).length>0, lead&&lead.match_reasons);
  t('candidate evidence stored', lead && JSON.parse(lead.match_candidates_json||'[]').length>0);
  t('the resubmit is in the action log', lead && JSON.parse(lead.action_log||'[]').some(e=>e.action==='resubmit'));
  t('status starts at new', lead && lead.status==='new');
  console.log(`\n  matched: ${lead.match_reasons}  score=${lead.match_confidence}  pool_id=${lead.match_pool_id||'(none)'}`);
}

// ── Cleanup ───────────────────────────────────────────────────────────────
// These rows went into the real CRM spreadsheet. Blank them rather than leaving
// automated test data sitting in an operational tab.
console.log('\n8. Cleanup');
{
  const { writeSheetRange } = await import('../api/_sheets.js');
  const values = await readSheetRange('Service_Requests', ID);
  const width = (values[0]||[]).length;
  let removed = 0;
  for (let i=1;i<values.length;i++){
    if (created.includes(String(values[i][0]||''))) {
      await writeSheetRange(`Service_Requests!A${i+1}:AP${i+1}`, [new Array(width).fill('')], ID);
      removed++;
    }
  }
  t(`removed ${removed} test rows`, removed===created.length, `${removed} of ${created.length}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
