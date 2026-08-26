// Cold-list segmentation + marketing lane safety.
//
//   node tests/cold-list.test.js
//
// Three things here decide whether a real customer gets the wrong email, so they
// are executed against the real source rather than pattern-matched:
//
//   1. RECENCY MUST IGNORE contact_log[].date. That field is an editable date
//      input — a human's recollection — so a backdated entry could otherwise
//      make a lead look cold and earn them a "we've never spoken!" email the day
//      after somebody spoke to them. Server-written stamps only.
//   2. never_contacted MUST FAIL SAFE. A non-empty contact_log counts as
//      contacted even when no server stamp exists, because the alternative sends
//      cold-open copy to somebody a rep already worked.
//   3. MARKETING MUST NOT RIDE A PERSON'S MAILBOX. The lane is chosen by
//      category, so a cold blast can never be blocked by (or charged to) the
//      per-person sender registry.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const COMMS_SRC = path.join(ROOT, 'appscript', 'Comms.js');
const SEG_SRC = path.join(ROOT, 'appscript', 'LeadSegments.js');
const HUB_SRC = path.join(ROOT, 'appscript', 'SalesHub.js');

// leadStatus_ delegates to mcpsNormalizeStatus_, which lives in SalesHub.js and is
// available at runtime because every Apps Script file shares one global scope.
// Extract the REAL normaliser rather than copying its alias table into this file:
// a third copy of the status vocabulary is precisely what tests/quote-status.test.js
// exists to prevent. If SalesHub.js is restructured, this throws loudly instead of
// silently testing a stale duplicate.
function statusNormaliserSrc() {
  const src = fs.readFileSync(HUB_SRC, 'utf8');
  const start = src.indexOf('var MCPS_STATUS_ALIASES');
  const fnAt = src.indexOf('function mcpsNormalizeStatus_', start);
  const end = src.indexOf('\n}', fnAt);
  if (start === -1 || fnAt === -1 || end === -1) {
    throw new Error('Could not extract mcpsNormalizeStatus_ from SalesHub.js');
  }
  return src.slice(start, end + 2);
}

let pass = 0, fail = 0;
function t(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail ? '  ' + detail : '')); }
}

const NOW = Date.parse('2026-08-25T12:00:00Z');
const daysAgo = n => new Date(NOW - n * 86400000).toISOString();

// Freeze the Date CLASS, not just Date.now: code under test calls both
// `new Date()` and `Date.now()`, and a half-frozen clock produces tests that
// pass in the morning and fail in the evening.
class FrozenDate extends Date {
  constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
  static now() { return NOW; }
}

function build(props = {}, crmRows = [], opts = {}) {
  const sheets = { appended: [], updated: [], deleted: [] };
  const ctx = {
    console, JSON, Math, String, Number, Array, Object, RegExp, isNaN, encodeURIComponent,
    Date: FrozenDate,
    Logger: { log: () => {} },
    Utilities: {
      getUuid: () => 'uuid-' + (sheets.appended.length + 1),
      // Model the real signature: Utilities.formatDate(date, timeZone, pattern).
      // A stub that ignores the timezone makes any day-boundary test meaningless —
      // it would report a new day fifteen minutes from now.
      formatDate: (d, tz, fmt) => {
        const dt = new Date(d);
        if (fmt === 'yyyy-MM-dd') return dt.toLocaleDateString('en-CA', { timeZone: tz || 'UTC' });
        return dt.toISOString();
      },
      computeHmacSha256Signature: () => [1, 2, 3] },
    SpreadsheetApp: { getActiveSpreadsheet: () => null, openById: () => null },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ after: () => ({ create: () => {} }) }) }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'p@x.com' }), getActiveUser: () => ({ getEmail: () => '' }) },
    MailApp: { getRemainingDailyQuota: () => 1500 },
    GmailApp: { getAliases: () => [], sendEmail: () => {} },
    UrlFetchApp: { fetch: () => { throw new Error('no network'); } },
    huHeader_: h => String(h == null ? '' : h).trim().toLowerCase().replace(/ /g, '_'),
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (props[k] === undefined ? null : props[k]),
      setProperty: () => {}, deleteProperty: () => {} }) }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(COMMS_SRC, 'utf8'), ctx, { filename: 'Comms.js' });
  // Skippable so the graceful-degradation path can be exercised too.
  if (!opts.withoutStatusNormaliser) {
    vm.runInContext(statusNormaliserSrc(), ctx, { filename: 'SalesHub.status.js' });
  }
  // Skippable: a global function declaration is non-configurable and cannot be
  // deleted afterwards, so "LeadSegments.js was not deployed" has to be modelled
  // by never loading it rather than by removing it.
  if (!opts.withoutSegments) {
    vm.runInContext(fs.readFileSync(SEG_SRC, 'utf8'), ctx, { filename: 'LeadSegments.js' });
  }

  // Sheet layer + CRM stubbed AFTER load, so the real logic runs against
  // controlled data instead of a live spreadsheet.
  ctx.handleGetCRMData = () => ({ ok: true, data: crmRows });
  ctx.commsEnsureSheets_ = () => {};
  ctx.commsSheetRows_ = () => [];
  ctx.commsAppendRow_ = (k, o) => { sheets.appended.push({ key: k, obj: o }); return 2; };
  ctx.commsAppendRows_ = (k, o) => { sheets.appended.push({ key: k, rows: o }); return o.length; };
  ctx.commsUpdateRowById_ = (k, f, id, p) => { sheets.updated.push({ k, id, p }); return true; };
  ctx.commsDeleteRowById_ = (k, f, id) => { sheets.deleted.push({ k, id }); return true; };
  ctx.commsEnsureGuardTrigger_ = () => {};
  ctx.commsRecomputeWake_ = () => {};
  ctx.commsScheduleSweep_ = () => {};
  return { ctx, sheets };
}

const LEAD = (over = {}) => Object.assign({
  quote_id: 'Q-1', first_name: 'Ana', last_name: 'Reyes', email: 'ana@x.com',
  phone: '2105550000', city: 'San Antonio', area: 'NW', status: 'LEAD',
  timestamp: daysAgo(400), contact_log: '[]'
}, over);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nRecency ignores the backdate-able contact_log date');
{
  const { ctx } = build();
  // Somebody spoke to this lead yesterday but typed a date; there is no server
  // stamp. Recency must report "unknown" rather than trusting the typed value.
  const typed = LEAD({ contact_log: JSON.stringify([{ date: daysAgo(1), method: 'Call', outcome: 'No Answer' }]) });
  t('a contact_log date contributes nothing to last-touched',
    ctx.leadLastTouchedAt_(typed) === 0, '=' + ctx.leadLastTouchedAt_(typed));

  // ...but it does prove contact happened, so the lead is NOT never-contacted.
  t('a contact_log entry still counts as contacted (fails safe)',
    ctx.leadNeverContacted_(typed) === false);

  const stamped = LEAD({ last_contact_logged_at: daysAgo(3) });
  t('a server-written stamp does count',
    ctx.leadDaysSince_(ctx.leadLastTouchedAt_(stamped), NOW) === 3);

  // A future-dated contact_log entry must not be able to suppress a real stamp.
  const both = LEAD({ last_contact_logged_at: daysAgo(10),
                      contact_log: JSON.stringify([{ date: daysAgo(-30), outcome: 'Interested' }]) });
  t('a future-dated log entry cannot move the recency signal',
    ctx.leadDaysSince_(ctx.leadLastTouchedAt_(both), NOW) === 10);

  t('malformed contact_log JSON does not throw',
    ctx.leadContactLog_(LEAD({ contact_log: '{not json' })).length === 0);
}

console.log('\nCold buckets are exclusive and correctly prioritised');
{
  const { ctx } = build();
  const bucket = r => { const b = ctx.leadColdBucketFor_(r, NOW); return b && b.bucket; };

  t('UNSENT is quoted_never_sent (the hottest segment)',
    bucket(LEAD({ status: 'UNSENT' })) === 'quoted_never_sent');

  t('an active customer is never a cold lead',
    bucket(LEAD({ status: 'ACTIVE_CUSTOMER' })) === null);
  t('a signed deal is never a cold lead',
    bucket(LEAD({ status: 'SIGNED' })) === null);
  t('do_not_contact removes a lead from every bucket',
    bucket(LEAD({ status: 'UNSENT', do_not_contact: 'TRUE' })) === null);
  t('do_not_contact accepts a real boolean too',
    bucket(LEAD({ status: 'UNSENT', do_not_contact: true })) === null);

  t('never contacted, with no other signal',
    bucket(LEAD()) === 'never_contacted');

  // Inside the normal reply window this is an OPEN deal, not a cold lead.
  t('a proposal sent 5 days ago is not yet cold',
    bucket(LEAD({ status: 'SENT', proposal_sent_at: daysAgo(5) })) === null);
  t('a proposal sent 60 days ago with no reply is cold',
    bucket(LEAD({ status: 'SENT', proposal_sent_at: daysAgo(60) })) === 'sent_no_response');
  t('a proposal that was accepted is not cold',
    bucket(LEAD({ status: 'SENT', proposal_sent_at: daysAgo(60), proposal_accepted_at: daysAgo(50) })) === null);
  t('a declined proposal is not re-listed as awaiting a reply',
    bucket(LEAD({ status: 'SENT', proposal_sent_at: daysAgo(60), proposal_declined_at: daysAgo(55) })) === null);

  t('logged interest that went quiet outranks the generic sent bucket',
    bucket(LEAD({ status: 'SENT', proposal_sent_at: daysAgo(90),
                  last_contact_logged_at: daysAgo(80),
                  contact_log: JSON.stringify([{ outcome: 'Interested' }]) })) === 'interested_went_dark');
  t('recent interest is left alone',
    bucket(LEAD({ status: 'LEAD', last_contact_logged_at: daysAgo(3),
                  contact_log: JSON.stringify([{ outcome: 'Follow Up' }]) })) === null);

  t('a lead lost 30 days ago is not revived yet',
    bucket(LEAD({ status: 'LOST', lost_at: daysAgo(30), last_contact_logged_at: daysAgo(30) })) === null);
  t('a lead lost 300 days ago is revivable',
    bucket(LEAD({ status: 'LOST', lost_at: daysAgo(300), last_contact_logged_at: daysAgo(300) })) === 'lost_revivable');
  t('an expired quote is revivable on the same terms',
    bucket(LEAD({ status: 'EXPIRED', proposal_sent_at: daysAgo(400) })) === 'lost_revivable');
  t('a declined quote is treated as closed, not as awaiting a reply',
    bucket(LEAD({ status: 'CHANGES_DECLINED', proposal_sent_at: daysAgo(400),
                  proposal_declined_at: daysAgo(390) })) === 'lost_revivable');

  // A lead a human marked Lost must never be described as one nobody contacted,
  // even when the contact log is empty — that reads as an untouched opportunity.
  t('a Lost lead with an empty log is never labelled "never contacted"',
    bucket(LEAD({ status: 'LOST', lost_at: daysAgo(300) })) === 'lost_revivable');
  t('a recently Lost lead with an empty log drops out entirely',
    bucket(LEAD({ status: 'LOST', lost_at: daysAgo(10) })) === null);
  t('a Lost lead with no closing date at all is left alone',
    bucket(LEAD({ status: 'LOST' })) === null);

  t('a row with no quote_id is ignored entirely',
    bucket(LEAD({ quote_id: '' })) === null);

  const b = ctx.leadColdBucketFor_(LEAD({ status: 'UNSENT', timestamp: daysAgo(120) }), NOW);
  t('every bucket carries a human-readable reason', !!b.why && b.why.length > 8, JSON.stringify(b.why));
  t('the reason names the date it is based on', /\d{4}-\d{2}-\d{2}/.test(b.why), b.why);
}

console.log('\nSegment predicates');
{
  const { ctx } = build();
  const m = (r, def) => ctx.leadSegmentMatches_(r, def, NOW);

  t('an empty definition matches any emailable lead', m(LEAD(), {}) === true);
  t('a lead with no email is excluded by default', m(LEAD({ email: '' }), {}) === false);
  t('has_email:false lets addressless leads through (for a call list)',
    m(LEAD({ email: '' }), { has_email: false }) === true);

  t('statuses filter', m(LEAD({ status: 'UNSENT' }), { statuses: ['UNSENT'] }) === true);
  t('statuses filter excludes others', m(LEAD({ status: 'LEAD' }), { statuses: ['UNSENT'] }) === false);
  t('status aliases normalise via the shared server vocabulary (QUOTED -> SENT)',
    m(LEAD({ status: 'QUOTED' }), { statuses: ['SENT'] }) === true);
  t('another alias normalises too (COMPLETED -> COMPLETED_JOB)',
    ctx.leadStatus_({ status: 'completed' }) === 'COMPLETED_JOB');

  // If SalesHub.js has not loaded yet, fall back to the raw value rather than
  // crashing — a segment that throws takes the whole campaign screen down.
  const { ctx: bare } = build({}, [], { withoutStatusNormaliser: true });
  t('a missing normaliser degrades instead of throwing',
    bare.leadStatus_({ status: 'unsent' }) === 'UNSENT');

  t('areas filter is case-insensitive', m(LEAD({ area: 'nw' }), { areas: ['NW'] }) === true);
  t('areas filter excludes others', m(LEAD({ area: 'SE' }), { areas: ['NW'] }) === false);

  t('never_contacted matches an untouched lead', m(LEAD(), { never_contacted: true }) === true);
  t('never_contacted excludes a stamped lead',
    m(LEAD({ last_emailed_at: daysAgo(5) }), { never_contacted: true }) === false);

  // The extreme case of "not touched in N days" is "never touched", so it must
  // satisfy the predicate rather than being filtered out for lacking a date.
  t('never-touched satisfies not_touched_days for any N',
    m(LEAD(), { not_touched_days: 90 }) === true);
  t('not_touched_days excludes a recent touch',
    m(LEAD({ last_emailed_at: daysAgo(10) }), { not_touched_days: 90 }) === false);
  t('not_touched_days admits an old touch',
    m(LEAD({ last_emailed_at: daysAgo(200) }), { not_touched_days: 90 }) === true);

  t('cold_buckets filter', m(LEAD({ status: 'UNSENT' }), { cold_buckets: ['quoted_never_sent'] }) === true);
  t('cold_buckets excludes another bucket',
    m(LEAD({ status: 'UNSENT' }), { cold_buckets: ['never_contacted'] }) === false);

  // Suppression must not be defeatable by a filter a user can author.
  t('do_not_contact is excluded even with an otherwise-matching filter',
    m(LEAD({ status: 'UNSENT', do_not_contact: 'yes' }), { statuses: ['UNSENT'] }) === false);

  t('created_before filter', m(LEAD({ timestamp: daysAgo(400) }), { created_before: daysAgo(100) }) === true);
  t('created_before excludes newer', m(LEAD({ timestamp: daysAgo(10) }), { created_before: daysAgo(100) }) === false);
  t('year_built floor', m(LEAD({ year_built: '2001' }), { min_year_built: 1990 }) === true);
  t('year_built floor excludes older', m(LEAD({ year_built: '1980' }), { min_year_built: 1990 }) === false);
  t('a blank year_built does not silently pass a year filter',
    m(LEAD({ year_built: '' }), { min_year_built: 1990 }) === false);
}

console.log('\nSegments resolve through the normal audience pipeline');
{
  const rows = [
    LEAD({ quote_id: 'Q-1', email: 'a@x.com', status: 'UNSENT' }),
    LEAD({ quote_id: 'Q-2', email: 'b@x.com', status: 'ACTIVE_CUSTOMER' }),
    LEAD({ quote_id: 'Q-3', email: 'a@x.com', status: 'UNSENT' })   // duplicate address
  ];
  const { ctx } = build({}, rows);
  ctx.commsOptOutSet_ = () => ({});

  const res = ctx.resolveCommsAudience_({ type: 'segment', definition: { statuses: ['UNSENT'] } }, 'marketing');
  t('a segment audience resolves', res.ok === true);
  t('it excludes non-matching rows', res.recipients.length === 1, JSON.stringify(res.recipients.map(r => r.email)));
  t('it still dedupes by email', res.recipients[0].properties.length === 2);

  // The definition travels ON THE AUDIENCE. Editing the saved segment afterwards
  // must not redefine what an already-created campaign meant.
  const sheetDef = { statuses: ['LEAD'] };
  ctx.commsSheetRows_ = () => [{ segment_id: 'S1', definition_json: JSON.stringify(sheetDef) }];
  const pinned = ctx.resolveCommsAudience_(
    { type: 'segment', segment_id: 'S1', definition: { statuses: ['UNSENT'] } }, 'marketing');
  t('the snapshotted definition wins over the sheet', pinned.recipients.length === 1);

  // Opt-outs still apply to a segment, like every other audience type.
  ctx.commsOptOutSet_ = () => ({ 'a@x.com': true });
  const supp = ctx.resolveCommsAudience_({ type: 'segment', definition: { statuses: ['UNSENT'] } }, 'marketing');
  t('opt-outs are applied to segment audiences too', supp.recipients[0].opted_out === true);
}

console.log('\nCold audit report');
{
  const rows = [
    LEAD({ quote_id: 'Q-1', email: 'a@x.com', status: 'UNSENT' }),
    LEAD({ quote_id: 'Q-2', email: '', status: 'UNSENT' }),               // unreachable
    LEAD({ quote_id: 'Q-3', email: 'c@x.com' }),                          // never contacted
    LEAD({ quote_id: 'Q-4', email: 'd@x.com', status: 'ACTIVE_CUSTOMER' })// not cold
  ];
  const { ctx } = build({}, rows);
  const rep = ctx.handleLeadColdAudit_({});
  t('the audit succeeds', rep.ok === true);
  t('active customers are excluded from the totals', rep.total_cold === 3, 'cold=' + rep.total_cold);
  t('unreachable leads are counted but not listed', rep.total_reachable === 2, 'reach=' + rep.total_reachable);
  const qns = rep.buckets.filter(b => b.bucket === 'quoted_never_sent')[0];
  t('the addressless lead is reported as such', qns.no_email === 1 && qns.leads.length === 1);
  t('every bucket is present even when empty', rep.buckets.length === ctx.LEAD_COLD_BUCKETS.length);
  t('thresholds are reported so the numbers are explicable', !!rep.thresholds.STALE_DAYS);
}

console.log('\nMarketing never rides a personal mailbox');
{
  const { ctx } = build();
  t('marketing is a bulk lane', ctx.commsLaneForCategory_('marketing') === 'bulk');
  t('announcements are a bulk lane', ctx.commsLaneForCategory_('announcement') === 'bulk');
  t('service updates stay personal', ctx.commsLaneForCategory_('service_update') === 'personal');
  t('an unknown category defaults to personal (the safer, attributable lane)',
    ctx.commsLaneForCategory_('') === 'personal');

  const { ctx: c2 } = build({ COMMS_SEND_MODE_BULK: 'resend' });
  t('the bulk lane can use its own transport', c2.commsTransportForLane_('bulk') === 'resend');
  t('the personal lane is unaffected by it', c2.commsTransportForLane_('personal') === 'gmail');

  // The regression that matters: a marketing campaign must be creatable when the
  // per-person sender registry is absent, because it must never consult it.
  const rows = [LEAD({ email: 'a@x.com', status: 'UNSENT' })];
  const { ctx: c3, sheets } = build({ COMMS_BUSINESS_ADDRESS: '1 Pool Way, San Antonio TX' }, rows);
  c3.commsOptOutSet_ = () => ({});
  let senderConsulted = false;
  c3.commsResolveSender_ = () => { senderConsulted = true; return { ok: false, error: 'no row' }; };

  const mk = c3.handleCommsSendCampaign_({ name: 'A', username: 'mau' }, {
    name: 'Reactivation', category: 'marketing', subject: 'Hi', body_markup: 'Hello',
    audience: { type: 'segment', definition: { statuses: ['UNSENT'] } }
  });
  t('a marketing campaign is created without a sender row', mk.ok === true, JSON.stringify(mk));
  t('the per-person registry is never consulted for marketing', senderConsulted === false);
  const camp = sheets.appended.filter(a => a.key === 'campaigns')[0];
  t('the lane is pinned onto the campaign row', camp && camp.obj.lane === 'bulk');
  t('no sender is stamped on a bulk campaign', camp && camp.obj.sender_email === '');

  // ...while a service update still refuses rather than silently using the
  // shared mailbox under somebody else's name.
  const { ctx: c4 } = build({ COMMS_BUSINESS_ADDRESS: 'x' }, rows);
  c4.commsOptOutSet_ = () => ({});
  c4.commsResolveSender_ = () => ({ ok: false, error: 'You have no sender registered.' });
  const su = c4.handleCommsSendCampaign_({ name: 'A', username: 'mau' }, {
    name: 'B', category: 'service_update', subject: 'Hi', body_markup: 'Hello',
    audience: { type: 'segment', definition: { statuses: ['UNSENT'] } }
  });
  t('a personal-lane campaign still requires a registered sender', su.ok === false);

  // And a missing CommsSenders.js must produce an explanation, not a crash.
  const { ctx: c5 } = build({ COMMS_BUSINESS_ADDRESS: 'x' }, rows);
  c5.commsOptOutSet_ = () => ({});
  delete c5.commsResolveSender_;
  let threw = null, out = null;
  try {
    out = c5.handleCommsSendCampaign_({ name: 'A', username: 'mau' }, {
      name: 'B', category: 'service_update', subject: 'Hi', body_markup: 'Hello',
      audience: { type: 'segment', definition: { statuses: ['UNSENT'] } }
    });
  } catch (e) { threw = e; }
  t('an undeployed sender registry does not throw', threw === null, String(threw));
  t('it returns an actionable message instead',
    out && out.ok === false && /not deployed/i.test(out.error), JSON.stringify(out));
}

console.log('\nCAN-SPAM: commercial mail refuses to send without a postal address');
{
  const rows = [LEAD({ email: 'a@x.com', status: 'UNSENT' })];
  const { ctx } = build({}, rows);          // no COMMS_BUSINESS_ADDRESS
  ctx.commsOptOutSet_ = () => ({});
  ctx.commsResolveSender_ = () => ({ ok: true, sender: { username: 'm', sender_email: 'm@x.com', sender_script_url: 'u' } });

  const bad = ctx.handleCommsSendCampaign_({ name: 'A' }, {
    name: 'X', category: 'marketing', subject: 'S', body_markup: 'B',
    audience: { type: 'segment', definition: { statuses: ['UNSENT'] } } });
  t('marketing is refused with no address', bad.ok === false);
  t('the error names the property to set', /COMMS_BUSINESS_ADDRESS/.test(bad.error), bad.error);

  // A service update is transactional and must still go out.
  const good = ctx.handleCommsSendCampaign_({ name: 'A' }, {
    name: 'X', category: 'service_update', subject: 'S', body_markup: 'B',
    audience: { type: 'segment', definition: { statuses: ['UNSENT'] } } });
  t('a service update is not blocked by the marketing guard', good.ok === true, JSON.stringify(good));
}

console.log('\nThe footer tells each audience the truth about why they got the email');
{
  const { ctx } = build({ COMMS_BUSINESS_ADDRESS: '1 Pool Way' });
  const mk = c => ctx.buildCommsEmailHtml_('<p>hi</p>', { unsubscribeUrl: 'https://u', category: c });

  t('a service update still says "customer"', /you are a Mission Custom Pool Solutions customer/i.test(mk('service_update')));
  // A cold lead was never a customer, so claiming otherwise is both false and the
  // fastest route to a spam complaint.
  t('marketing does NOT claim the reader is a customer', !/you are a .*customer/i.test(mk('marketing')), mk('marketing').slice(-400));
  t('marketing explains the real basis instead', /asked us about pool service|mailing list/i.test(mk('marketing')));
  t('announcements use the marketing wording too', !/you are a .*customer/i.test(mk('announcement')));
  t('the unsubscribe link survives in both', /https:\/\/u/.test(mk('marketing')) && /https:\/\/u/.test(mk('service_update')));

  const { ctx: c2 } = build({ COMMS_BUSINESS_ADDRESS: '1 Pool Way',
                              COMMS_MARKETING_PERMISSION_TEXT: 'You signed up at a home show.' });
  t('the wording is overridable without a deploy',
    /You signed up at a home show\./.test(c2.buildCommsEmailHtml_('x', { category: 'marketing' })));

  // The permission line is interpolated, so it must be escaped like everything else.
  const { ctx: c3 } = build({ COMMS_MARKETING_PERMISSION_TEXT: 'Bad <script>alert(1)</script>' });
  const html = c3.buildCommsEmailHtml_('x', { category: 'marketing' });
  t('the overridable text cannot inject markup', !/<script>/.test(html) && /&lt;script&gt;/.test(html));
}

console.log('\nA campaign cannot change transport mid-flight');
{
  const { ctx } = build({ COMMS_SEND_MODE: 'gmail' });
  let used = null;
  ctx.commsSendViaResend_ = m => { used = 'resend'; return { ok: true, provider: 'resend' }; };
  ctx.commsSendViaGmail_ = m => { used = 'gmail'; return { ok: true, provider: 'gmail' }; };

  ctx.sendCommsEmail_({ to: 'a@x.com', subject: 's', transport: 'resend' });
  t('a pinned transport is honoured over the global mode', used === 'resend');
  used = null;
  ctx.sendCommsEmail_({ to: 'a@x.com', subject: 's' });
  t('an unpinned send still follows the global mode', used === 'gmail');
}


console.log('\nTimestamp backfill is honest and idempotent');
{
  // Minimal Sheets double: a 2D array with the handful of Range methods the
  // migration actually uses.
  function fakeSheet(headers, rows) {
    const grid = [headers.slice()].concat(rows.map(r => r.slice()));
    return {
      _grid: grid,
      getLastColumn: () => headers.length,
      getLastRow: () => grid.length,
      getRange: (r, c, nr, nc) => ({
        getValues: () => {
          const h = nr === undefined ? 1 : nr, w = nc === undefined ? 1 : nc;
          return grid.slice(r - 1, r - 1 + h).map(row => row.slice(c - 1, c - 1 + w));
        },
        setValue: v => { grid[r - 1][c - 1] = v; },
        getValue: () => grid[r - 1][c - 1]
      })
    };
  }

  const H = ['quote_id', 'timestamp', 'timestamp_source', 'proposal_sent_at', 'sent_at', 'signed_at'];
  //                                      real       blank      blank(evidence)  blank      real
  const ROWS = [
    ['Q-1', daysAgo(500), '', '', '', ''],                 // real, must be untouched
    ['Q-2', '',           '', '', '', ''],                 // interpolate between 500 and 100
    ['Q-3', '',           '', daysAgo(300), '', ''],       // direct evidence wins
    ['Q-4', daysAgo(100), '', '', '', ''],                 // real
    ['Q-5', '',           '', '', '', ''],                 // trailing blank -> floor from above
    ['',    '',           '', '', '', '']                  // blank row, skipped entirely
  ];

  function run(dry) {
    const sheet = fakeSheet(H, ROWS);
    const { ctx } = build();
    ctx.getCrmSheet_ = () => sheet;
    ctx.ensureColumn_ = () => {};
    ctx.invalidateCrmCache_ = () => {};
    const res = ctx.leadBackfillTimestamps_(dry);
    return { res, sheet };
  }

  const dry = run(true);
  t('the dry run reports a plan', dry.res.would_write === 3, 'would_write=' + dry.res.would_write);
  t('the dry run writes nothing at all',
    dry.sheet._grid[2][1] === '' && dry.sheet._grid[3][1] === '');
  t('it reports being a dry run', dry.res.dry_run === true);
  t('a blank row is skipped, not dated', dry.res.counts.skipped === 1);
  t('rows that already have a date are left alone', dry.res.counts.already === 2);

  const live = run(false);
  const g = live.sheet._grid;
  t('an existing real timestamp is never overwritten',
    g[1][1] === daysAgo(500) && g[1][2] === '');

  t('direct evidence is used and labelled',
    g[3][1] === daysAgo(300) && g[3][2] === 'derived', JSON.stringify([g[3][1], g[3][2]]));

  const q2 = Date.parse(g[2][1]);
  t('an interior blank is interpolated inside its known bracket',
    q2 < Date.parse(daysAgo(100)) && q2 > Date.parse(daysAgo(500)), g[2][1]);
  t('the interpolated row is labelled as an estimate', g[2][2] === 'interpolated');

  t('a trailing blank falls back to the nearest known date', g[5][2] === 'floor');

  // The whole point of the source column: a report can exclude estimates. If any
  // estimated row were labelled '' it would be indistinguishable from real data.
  const estimated = g.slice(1).filter(r => r[0] && r[1] && r[2] !== '');
  const real = g.slice(1).filter(r => r[0] && r[1] && r[2] === '');
  t('every written date carries a source label', estimated.length === 3);
  t('and only genuinely-real dates are left unlabelled', real.length === 2);

  // Re-running must be a no-op: a migration you cannot safely repeat is one you
  // cannot safely interrupt.
  const { ctx: c2 } = build();
  c2.getCrmSheet_ = () => live.sheet;
  c2.ensureColumn_ = () => {};
  c2.invalidateCrmCache_ = () => {};
  const rerun = c2.leadBackfillTimestamps_(false);
  t('a second run has nothing left to do', rerun.would_write === 0, 'would_write=' + rerun.would_write);

  const empty = fakeSheet(H, []);
  const { ctx: c3 } = build();
  c3.getCrmSheet_ = () => empty; c3.ensureColumn_ = () => {}; c3.invalidateCrmCache_ = () => {};
  t('an empty sheet is handled', c3.leadBackfillTimestamps_(true).rows === 0);
}


console.log('\nMarketing cannot eat the quota transactional mail needs');
{
  const { ctx } = build();
  // A campaign on a per-person sender spends THAT staff member's allowance, and
  // one on an external provider spends none of ours, so neither is constrained.
  t('a shared-Gmail campaign draws on this quota',
    ctx.commsUsesGmailQuota_({ provider: 'gmail', sender_script_url: '' }) === true);
  t('a per-person sender campaign does not',
    ctx.commsUsesGmailQuota_({ provider: 'gmail', sender_script_url: 'https://script/exec' }) === false);
  t('a Resend campaign does not',
    ctx.commsUsesGmailQuota_({ provider: 'resend', sender_script_url: '' }) === false);
  t('a campaign with no pinned provider falls back to the global mode',
    ctx.commsUsesGmailQuota_({ provider: '', sender_script_url: '' }) === true);
  t('a missing campaign is not treated as quota-bearing',
    ctx.commsUsesGmailQuota_(null) === false);

  // The reserve is what keeps a signature request sendable after a blast.
  t('the reserve leaves real headroom',
    ctx.COMMS_QUOTA_RESERVE > 0 && ctx.COMMS_QUOTA_RESERVE < ctx.COMMS_GMAIL_DAILY_QUOTA);

  // An unreadable quota (scope error, consumer account) must not stall sending.
  const { ctx: c2 } = build();
  c2.MailApp = { getRemainingDailyQuota: () => { throw new Error('no scope'); } };
  t('an unreadable quota degrades to "unknown", not to zero',
    c2.commsRemainingQuota_() === -1);
}


console.log('\nRetry distinguishes "provider refused" from "we might have sent it"');
{
  const { ctx } = build();
  t('an HTTP 503 is transient', ctx.commsIsTransientError_('Resend HTTP 503: unavailable') === true);
  t('a rate limit is transient', ctx.commsIsTransientError_('HTTP 429 too many requests') === true);
  t('a timeout is transient', ctx.commsIsTransientError_('Request timed out') === true);
  t('a network error is transient', ctx.commsIsTransientError_('ECONNRESET on socket') === true);

  t('an invalid address is permanent', ctx.commsIsTransientError_('blank or invalid email') === false);
  t('a 400 is permanent', ctx.commsIsTransientError_('Resend HTTP 400: bad request') === false);
  t('an empty error is not treated as retryable', ctx.commsIsTransientError_('') === false);

  // The crash message must never read as transient — that row may already have
  // been delivered, and re-sending it is a duplicate cold email.
  t('the crashed-lease message is NOT transient',
    ctx.commsIsTransientError_('attempt crashed; possible duplicate — not retried') === false);

  t('backoff grows with each attempt',
    ctx.commsRetryDelayMs_(1) < ctx.commsRetryDelayMs_(2) &&
    ctx.commsRetryDelayMs_(2) < ctx.commsRetryDelayMs_(3));
  t('backoff is clamped rather than running off the end',
    ctx.commsRetryDelayMs_(99) === ctx.commsRetryDelayMs_(3));
  t('a first attempt still gets a real delay', ctx.commsRetryDelayMs_(1) > 0);
}

console.log('\nBulk pacing: window, cap, and the sleep that follows');
{
  const { ctx } = build();
  const at = iso => new Date(Date.parse(iso));
  // Central time; the codebase already relies on this toLocaleString pattern.
  t('a Tuesday mid-morning is inside the window', ctx.commsBulkWindowOk_(at('2026-08-25T15:00:00Z')) === true);
  t('3am is outside it', ctx.commsBulkWindowOk_(at('2026-08-25T08:00:00Z')) === false);
  t('late evening is outside it', ctx.commsBulkWindowOk_(at('2026-08-26T03:00:00Z')) === false);
  t('Sunday is never a marketing day', ctx.commsBulkWindowOk_(at('2026-08-23T16:00:00Z')) === false);
  t('Saturday is allowed', ctx.commsBulkWindowOk_(at('2026-08-22T16:00:00Z')) === true);

  const { ctx: c2 } = build({ COMMS_BULK_HOUR_START: '11', COMMS_BULK_HOUR_END: '12' });
  t('the window is configurable', c2.commsBulkWindowOk_(at('2026-08-25T15:00:00Z')) === false);
  t('and honours the configured hour', c2.commsBulkWindowOk_(at('2026-08-25T16:30:00Z')) === true);

  const { ctx: c3 } = build({ COMMS_BULK_HOUR_START: 'nonsense' });
  t('a malformed window setting falls back rather than blocking forever',
    c3.commsBulkWindowOk_(at('2026-08-25T15:00:00Z')) === true);

  // Sleeping until the window reopens, rather than rescanning every 45s all night.
  const night = at('2026-08-26T04:00:00Z');          // ~11pm CT Tuesday
  const waitW = ctx.commsMsUntilBulkWindow_(night);
  t('an out-of-window sweep sleeps for hours, not seconds', waitW > 3 * 3600000, 'ms=' + waitW);
  t('and it lands inside the window', ctx.commsBulkWindowOk_(new Date(night.getTime() + waitW)) === true);

  // A cap resets at midnight, NOT when the window next opens — mid-morning the
  // next open slot is 15 minutes away but the allowance is still spent.
  const morning = at('2026-08-25T15:00:00Z');
  const waitC = ctx.commsMsUntilCapReset_(morning);
  t('a capped sweep waits for the date to roll, not for the next open slot',
    waitC > 12 * 3600000, 'ms=' + waitC);
  const after = new Date(morning.getTime() + waitC);
  t('and it resumes on a later day', ctx.commsDayKey_ && after.getTime() > morning.getTime());
  t('landing inside the window again', ctx.commsBulkWindowOk_(after) === true);
}

console.log('\nThe day counter is per-day and per-campaign');
{
  let stored = {};
  const { ctx } = build();
  ctx.PropertiesService = { getScriptProperties: () => ({
    getProperty: k => (stored[k] === undefined ? null : stored[k]),
    setProperty: (k, v) => { stored[k] = v; }, deleteProperty: k => { delete stored[k]; } }) };

  const c = ctx.commsReadDayCounter_();
  t('a fresh counter starts empty', Object.keys(c.campaigns).length === 0);
  c.campaigns['A'] = 40;
  ctx.commsWriteDayCounter_(c);
  t('it round-trips', ctx.commsReadDayCounter_().campaigns['A'] === 40);
  t('campaigns are counted separately',
    ctx.commsReadDayCounter_().campaigns['B'] === undefined);

  // Yesterday's spend must not consume today's allowance.
  stored['COMMS_DAY_COUNTER'] = JSON.stringify({ day: '2000-01-01', campaigns: { A: 999 } });
  t('a counter from another day resets', ctx.commsReadDayCounter_().campaigns['A'] === undefined);

  stored['COMMS_DAY_COUNTER'] = '{not json';
  t('a corrupt counter resets instead of throwing',
    Object.keys(ctx.commsReadDayCounter_().campaigns).length === 0);
}

console.log('\nA bulk campaign is paced by default; operational mail is not');
{
  const rows = [LEAD({ email: 'a@x.com', status: 'UNSENT' })];
  const { ctx, sheets } = build({ COMMS_BUSINESS_ADDRESS: '1 Pool Way' }, rows);
  ctx.commsOptOutSet_ = () => ({});
  ctx.commsResolveSender_ = () => ({ ok: true, sender: { username: 'm', sender_email: 'm@x.com', sender_script_url: 'u' } });
  const aud = { type: 'segment', definition: { statuses: ['UNSENT'] } };

  ctx.handleCommsSendCampaign_({ name: 'A' }, { name: 'M', category: 'marketing', subject: 'S', body_markup: 'B', audience: aud });
  const bulk = sheets.appended.filter(a => a.key === 'campaigns').pop();
  t('a marketing campaign is capped by default', Number(bulk.obj.daily_cap) > 0, 'cap=' + bulk.obj.daily_cap);

  ctx.handleCommsSendCampaign_({ name: 'A' }, { name: 'S', category: 'service_update', subject: 'S', body_markup: 'B', audience: aud });
  const svc = sheets.appended.filter(a => a.key === 'campaigns').pop();
  t('a service update is never paced', Number(svc.obj.daily_cap) === 0);

  const { ctx: c2, sheets: s2 } = build({ COMMS_BUSINESS_ADDRESS: 'x', COMMS_BULK_DAILY_CAP: '25' }, rows);
  c2.commsOptOutSet_ = () => ({});
  c2.handleCommsSendCampaign_({ name: 'A' }, { name: 'M', category: 'marketing', subject: 'S', body_markup: 'B', audience: aud });
  t('the cap is configurable',
    Number(s2.appended.filter(a => a.key === 'campaigns').pop().obj.daily_cap) === 25);
}


console.log('\nSending marks the lead, so the next campaign does not repeat it');
{
  function crmSheet(rows) {
    const H = ['quote_id', 'email', 'last_emailed_at', 'email_count'];
    const grid = [H.slice()].concat(rows.map(r => r.slice()));
    const writes = [];
    return {
      _grid: grid, _writes: writes,
      getLastColumn: () => H.length,
      getLastRow: () => grid.length,
      getRange: (r, c, nr, nc) => ({
        getValues: () => {
          const h = nr === undefined ? 1 : nr, w = nc === undefined ? 1 : nc;
          return grid.slice(r - 1, r - 1 + h).map(row => row.slice(c - 1, c - 1 + w));
        },
        setValues: v => { writes.push({ r, c }); v.forEach((row, i) => row.forEach((val, j) => { grid[r - 1 + i][c - 1 + j] = val; })); },
        setValue: v => { grid[r - 1][c - 1] = v; }
      })
    };
  }

  const ISO = '2026-08-25T12:00:00.000Z';
  function run(ids, rows) {
    const sheet = crmSheet(rows);
    const { ctx } = build();
    let invalidated = false;
    ctx.getCrmSheet_ = () => sheet;
    ctx.ensureColumn_ = () => {};
    ctx.invalidateCrmCache_ = () => { invalidated = true; };
    const n = ctx.leadRecordEmailed_(ids, ISO);
    return { n, sheet, invalidated, ctx };
  }

  const rows = [['Q-1', 'a@x.com', '', ''], ['Q-2', 'b@x.com', '', 3], ['Q-3', 'c@x.com', '', '']];
  const r1 = run(['Q-1', 'Q-3'], rows);
  t('only the emailed rows are stamped', r1.n === 2);
  t('the timestamp lands on the right row', r1.sheet._grid[1][2] === ISO);
  t('an untouched row is left alone', r1.sheet._grid[2][2] === '');
  t('the third row is stamped too', r1.sheet._grid[3][2] === ISO);
  t('the counter starts at one', r1.sheet._grid[1][3] === 1);
  t('an existing counter increments rather than resetting',
    run(['Q-2'], rows).sheet._grid[2][3] === 4);

  // The audit reads through the cached CRM, so a stale cache would keep showing
  // leads that were emailed minutes ago.
  t('the CRM cache is invalidated', r1.invalidated === true);

  // Two column writes, not one per recipient — the whole reason this is batched.
  t('it writes columns, not rows', r1.sheet._writes.length === 2, 'writes=' + r1.sheet._writes.length);

  t('an empty list does nothing', run([], rows).n === 0);
  t('blank ids are ignored', run(['', null], rows).n === 0);
  t('an unknown id matches nothing', run(['Q-999'], rows).n === 0);
  t('nothing is written when nothing matched', run(['Q-999'], rows).sheet._writes.length === 0);

  // A stamped lead must drop straight out of the never-contacted bucket.
  const { ctx } = build();
  const before = ctx.leadColdBucketFor_(LEAD({ quote_id: 'Q-1' }), NOW);
  const after = ctx.leadColdBucketFor_(LEAD({ quote_id: 'Q-1', last_emailed_at: ISO }), NOW);
  t('before sending it is never_contacted', before && before.bucket === 'never_contacted');
  t('after sending it leaves the cold list', after === null);
}


console.log('\nLogging a call takes the lead off the cold list');
{
  const { ctx } = build();
  const bucket = r => { const b = ctx.leadColdBucketFor_(r, NOW); return b && b.bucket; };

  // The server stamp is what moves recency — it is the half a user cannot forge.
  t('a freshly logged call clears the never-contacted bucket',
    bucket(LEAD({ last_contact_logged_at: daysAgo(0),
                  contact_log: JSON.stringify([{ date: daysAgo(0), outcome: 'No Answer' }]) })) === null);

  // ...and the stamp, not the typed date, is what recency reads.
  const backdated = LEAD({ last_contact_logged_at: daysAgo(2),
                           contact_log: JSON.stringify([{ date: daysAgo(400), outcome: 'No Answer' }]) });
  t('a backdated entry cannot make a fresh call look stale',
    ctx.leadDaysSince_(ctx.leadLastTouchedAt_(backdated), NOW) === 2);

  // logged_at is carried on the entry too, so the drawer can show both truths.
  const withLoggedAt = LEAD({
    contact_log: JSON.stringify([{ date: daysAgo(400), logged_at: daysAgo(2), outcome: 'Interested' }]) });
  t('the entry keeps the human date as narrative',
    ctx.leadContactLog_(withLoggedAt)[0].date === daysAgo(400));
  t('and carries the server time alongside it',
    ctx.leadContactLog_(withLoggedAt)[0].logged_at === daysAgo(2));

  // Interest logged long ago should still surface as gone-dark.
  t('old logged interest still goes dark',
    bucket(LEAD({ status: 'SENT', last_contact_logged_at: daysAgo(120),
                  contact_log: JSON.stringify([{ outcome: 'Interested' }]) })) === 'interested_went_dark');
}


console.log('\nAn empty segment is refused, not resolved to everyone');
{
  const rows = [LEAD({ quote_id: 'Q-1', email: 'a@x.com' }), LEAD({ quote_id: 'Q-2', email: 'b@x.com' })];
  const { ctx } = build({ COMMS_BUSINESS_ADDRESS: '1 Pool Way' }, rows);
  ctx.commsOptOutSet_ = () => ({});

  t('no narrowing key means no predicate', ctx.leadSegmentHasPredicate_({}) === false);
  t('an unselected dropdown is not a predicate', ctx.leadSegmentHasPredicate_(null) === false);
  // These two are applied to every segment, so alone they still mean "everyone".
  t('has_email alone is not a predicate', ctx.leadSegmentHasPredicate_({ has_email: true }) === false);
  t('exclude_dnc alone is not a predicate', ctx.leadSegmentHasPredicate_({ exclude_dnc: true }) === false);
  t('an empty status array is not a predicate', ctx.leadSegmentHasPredicate_({ statuses: [] }) === false);
  t('never_contacted:false is not a predicate', ctx.leadSegmentHasPredicate_({ never_contacted: false }) === false);

  t('a status list is a predicate', ctx.leadSegmentHasPredicate_({ statuses: ['UNSENT'] }) === true);
  t('a cold bucket is a predicate', ctx.leadSegmentHasPredicate_({ cold_buckets: ['never_contacted'] }) === true);
  t('a recency window is a predicate', ctx.leadSegmentHasPredicate_({ not_touched_days: 90 }) === true);

  const empty = ctx.resolveCommsAudience_({ type: 'segment', definition: {} }, 'marketing');
  t('resolving an empty segment fails', empty.ok === false);
  t('and explains what would have happened', /every lead/i.test(empty.error), empty.error);

  const real = ctx.resolveCommsAudience_({ type: 'segment', definition: { statuses: ['LEAD'] } }, 'marketing');
  t('a real segment still resolves', real.ok === true && real.recipients.length === 2);

  // The guard has to sit in front of campaign creation, not merely the preview.
  const camp = ctx.handleCommsSendCampaign_({ name: 'A' }, {
    name: 'X', category: 'marketing', subject: 'S', body_markup: 'B',
    audience: { type: 'segment', definition: {} } });
  t('a campaign cannot be created from an empty segment', camp.ok === false);

  const { ctx: c2 } = build({}, rows, { withoutSegments: true });
  c2.commsOptOutSet_ = () => ({});
  const undeployed = c2.resolveCommsAudience_(
    { type: 'segment', definition: { statuses: ['LEAD'] } }, 'marketing');
  t('a missing LeadSegments.js is reported, not silently permissive', undeployed.ok === false);
  t('and it names the missing file', /LeadSegments/.test(undeployed.error), undeployed.error);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
