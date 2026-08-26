// Audiences tab — segment targeting and the late-binding contract.
//
//   node tests/cold-list-ui.test.js
//
// The compose screen has one subtle, load-bearing rule: an UNCURATED send
// transmits the FILTER so it re-resolves at send time, while touching a checkbox
// freezes an explicit list. Segment targeting has to sit inside that rule rather
// than beside it — a "cold leads" campaign scheduled for next Tuesday must reach
// whoever is cold by Tuesday, not whoever was cold when it was written.
//
// The other rule enforced here: changing WHO a campaign targets must drop any
// hand-curated list. The send path prefers a basket over a filter, so a stale
// basket would silently outrank the segment just chosen.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const UI_SRC = path.join(ROOT, 'js/features/comms.js');

let pass = 0, fail = 0;
function t(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail ? '  ' + detail : '')); }
}

const EXPORTS = `
;globalThis.__t = {
  compose: () => _commsCompose,
  basket: () => _commsBasket,
  unchecked: () => _commsUnchecked,
  setSegments: v => { _commsSegments = v; },
  segments: () => _commsSegments,
  setPreview: v => { _commsPreview = v; _commsUnchecked.clear(); },
  toBucket: b => commsComposeToBucket(b),
  toSegment: id => commsComposeToSegment(id),
  pick: id => commsPickSegment(id),
  toggle: (i, on) => commsTogglePreviewRow(i, on),
  addSelected: () => commsAddSelectedToList(),
  buildAudience: () => _commsBuildAudience(),
  sendAudience: () => _commsSendAudience(),
  isCurated: () => _commsIsCurated(),
  audiencesHtml: (a, s) => _commsAudiencesHtml(a, s),
  pacingNote: c => _commsPacingNote(c),
  performanceHtml: r => _commsPerformanceHtml(r),
  setWindowOpen: v => { _commsWindowOpen = v; },
  tab: () => _commsTab
};`;

function buildUI() {
  const els = {};
  const el = () => ({ innerHTML: '', className: '', textContent: '', getAttribute: () => '[]',
                      classList: { toggle: () => {}, add: () => {}, remove: () => {} } });
  const calls = [];
  const ctx = {
    console, JSON, Math, String, Number, Array, Object, Set, Map, RegExp, Date, isNaN, Promise,
    escHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    api: async p => { calls.push(p); return { ok: true, segments: [] }; },
    confirm: () => true,
    alert: () => {},
    setTimeout: () => {},
    clearInterval: () => {},
    _s: { token: 'tok' },
    _weekStartForOffset_: () => '2026-08-17',
    _VISIT_TYPE_LABELS: {},
    MCPS_STATUS: require(path.join(ROOT, 'js/lib/status.js')),
    isAdmin: () => true,
    hasRole: () => true,
    navigateTo: () => {},
    history: { replaceState: () => {} },
    location: { hash: '' },
    document: {
      getElementById: id => (els[id] || (els[id] = el())),
      createElement: () => ({ ...el(), style: {}, addEventListener: () => {}, querySelector: () => el(), remove: () => {} }),
      querySelectorAll: () => [],
      body: { appendChild: () => {} },
      head: { appendChild: () => {} }
    },
    window: {}
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(UI_SRC, 'utf8') + EXPORTS, ctx, { filename: 'comms.js' });
  return { ctx, api: ctx.__t, calls };
}

const R = (email, name) => ({
  email, name, first_name: name.split(' ')[0], last_name: name.split(' ')[1] || '',
  area: 'NW', quote_id: 'Q-' + email, pool_id: '',
  properties: [{ quote_id: 'Q-' + email }], invalid: false, opted_out: false
});
const PREVIEW = rs => ({ ok: true, total: rs.length, sendable_count: rs.length,
  invalid_count: 0, opted_out_count: 0, truncated: false, recipients: rs });

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nComposing to a cold bucket targets the filter');
{
  const { api } = buildUI();
  api.toBucket('quoted_never_sent');
  const c = api.compose();
  t('the audience switches to a segment', c.audienceType === 'segment');
  t('the bucket becomes the definition',
    JSON.stringify(c.segmentDef) === JSON.stringify({ cold_buckets: ['quoted_never_sent'] }));
  t('no saved segment id is implied', c.segmentId === '');
  // Reactivation mail is commercial, so it must land in the bulk lane and carry
  // the marketing permission wording and unsubscribe scope.
  t('the category is set to marketing', c.category === 'marketing');
  t('it navigates to compose', api.tab() === 'compose');

  const aud = api.buildAudience();
  t('the built audience is a segment', aud.type === 'segment');
  t('it carries the definition, not a member list',
    JSON.stringify(aud.definition) === JSON.stringify({ cold_buckets: ['quoted_never_sent'] }));
  t('it carries no frozen recipients', aud.recipients === undefined);
}

console.log('\nThe late-binding contract still holds for segments');
{
  const { api } = buildUI();
  api.toBucket('never_contacted');
  api.setPreview(PREVIEW([R('a@x.com', 'Ana Reyes'), R('b@x.com', 'Beto Cruz')]));

  t('an untouched segment send is not curated', api.isCurated() === false);
  const uncurated = api.sendAudience();
  t('an uncurated send transmits the FILTER so it re-resolves at send time',
    uncurated.type === 'segment', JSON.stringify(uncurated));

  // The moment a human picks and chooses, "who I picked" is the point, and
  // re-resolving later would silently undo it.
  api.toggle(1, false);
  t('unticking a row makes it curated', api.isCurated() === true);
  const curated = api.sendAudience();
  t('a curated send freezes to an explicit list', curated.type === 'selected');
  t('and it contains only the kept recipient',
    curated.recipients.length === 1 && curated.recipients[0].email === 'a@x.com');
}

console.log('\nChanging the audience drops a stale curated list');
{
  const { api } = buildUI();
  api.setSegments([
    { segment_id: 'S1', name: 'Never contacted', definition: { never_contacted: true } },
    { segment_id: 'S2', name: 'Quoted, never sent', definition: { cold_buckets: ['quoted_never_sent'] } }
  ]);
  api.toBucket('never_contacted');
  api.setPreview(PREVIEW([R('a@x.com', 'Ana Reyes')]));
  api.addSelected();
  t('a basket was built', api.basket().length === 1);
  t('the send would use the frozen basket', api.sendAudience().type === 'selected');

  // Picking a different segment must not leave the old basket in charge.
  api.pick('S2');
  t('picking another segment clears the basket', api.basket().length === 0);
  t('and clears unticked rows', api.unchecked().size === 0);
  t('the send reverts to the new filter', api.sendAudience().type === 'segment');
  t('with the newly chosen definition',
    JSON.stringify(api.buildAudience().definition) === JSON.stringify({ cold_buckets: ['quoted_never_sent'] }));
  t('and records which saved segment it came from', api.compose().segmentId === 'S2');

  api.pick('');
  t('clearing the picker empties the definition',
    JSON.stringify(api.compose().segmentDef) === '{}' && api.compose().segmentId === '');
}

console.log('\nComposing to a saved segment');
{
  const { api } = buildUI();
  api.setSegments([{ segment_id: 'S9', name: 'Gone quiet', definition: { not_touched_days: 90 } }]);
  api.toSegment('S9');
  t('the definition comes from the saved segment',
    JSON.stringify(api.compose().segmentDef) === JSON.stringify({ not_touched_days: 90 }));
  t('the segment id is recorded', api.compose().segmentId === 'S9');

  // An unknown id must be inert rather than producing an empty-definition segment
  // that would silently resolve to "everyone".
  const before = JSON.stringify(api.compose());
  api.toSegment('does-not-exist');
  t('an unknown segment id changes nothing', JSON.stringify(api.compose()) === before);
}

console.log('\nThe report explains itself');
{
  const { api } = buildUI();
  const html = api.audiencesHtml({
    ok: true, total_cold: 3, total_reachable: 2,
    thresholds: { STALE_DAYS: 30, DARK_DAYS: 45, REVIVE_DAYS: 180 },
    buckets: [
      { bucket: 'quoted_never_sent', label: 'Quoted, never sent', count: 2, no_email: 1, truncated: false,
        leads: [{ name: 'Ana Reyes', email: 'a@x.com', why: 'Quote built 2026-03-14, never sent', value: 1450 }] },
      { bucket: 'never_contacted', label: 'Never contacted', count: 0, no_email: 0, leads: [] }
    ]
  }, [{ segment_id: 'S1', name: 'Gone quiet', last_count: 12, last_counted_at: '2026-08-20T00:00:00Z' }]);

  t('the headline counts render', /\b3\b/.test(html) && /cold leads/.test(html));
  t('unreachable leads are surfaced as needing a call', /need a phone call/.test(html));
  t('each lead shows WHY it qualified', /Quote built 2026-03-14, never sent/.test(html));
  t('the thresholds are stated so the numbers are explicable', /30 days/.test(html) && /180/.test(html));
  t('it says recency ignores hand-typed dates', /never a hand-typed contact date/.test(html));
  t('an empty bucket renders without a call to action', /Never contacted[\s\S]{0,120}none</.test(html));
  t('saved segments are listed', /Gone quiet/.test(html) && /12 matched/.test(html));
  t('a quote value is shown when known', /\$1,450/.test(html));

  // Lead names come from the CRM and are interpolated into markup.
  const evil = api.audiencesHtml({
    ok: true, total_cold: 1, total_reachable: 1, thresholds: {},
    buckets: [{ bucket: 'never_contacted', label: 'Never contacted', count: 1, no_email: 0, truncated: false,
      leads: [{ name: '<script>alert(1)</script>', email: 'x@x.com', why: 'w', value: 0 }] }]
  }, []);
  t('a hostile lead name cannot inject markup',
    !/<script>alert\(1\)<\/script>/.test(evil) && /&lt;script&gt;/.test(evil));
}


console.log('\nA paced campaign explains why it is not finished');
{
  const { api } = buildUI();
  const C = o => Object.assign({ status: 'sending', daily_cap: 100, sendable_count: 500,
                                 sent_count: 100, failed_count: 0, sent_today: 100 }, o);

  const capped = api.pacingNote(C());
  t('a campaign at its daily limit says so', /Daily limit of 100 reached/.test(capped), capped);
  t('it says how many are left', /400 to go/.test(capped));
  t('and roughly how long', /about 4 more days/.test(capped));

  api.setWindowOpen(false);
  const closed = api.pacingNote(C({ sent_today: 10 }));
  t('outside sending hours it says that instead', /outside sending hours/.test(closed), closed);
  api.setWindowOpen(true);
  t('inside hours and under the cap it states the rate',
    /Sending up to 100 a day/.test(api.pacingNote(C({ sent_today: 10 }))));

  // An unpaced or finished campaign must stay silent — a note on every row is
  // noise, and noise is how the one that matters gets missed.
  t('an unpaced campaign shows no note', api.pacingNote(C({ daily_cap: 0 })) === '');
  t('a finished campaign shows no note', api.pacingNote(C({ status: 'done' })) === '');
  t('a campaign with nothing left shows no note',
    api.pacingNote(C({ sent_count: 500, sent_today: 500 })) === '');
  t('a single remaining day is not described in days',
    !/more day/.test(api.pacingNote(C({ sendable_count: 150, sent_count: 100, sent_today: 100 }))));
}


console.log('\nThe performance number carries its own caveat');
{
  const { api } = buildUI();
  const REPORT = {
    ok: true,
    totals: { revenue: 4200, signings: 3, signings_outside_window: 1 },
    model: { basis: 'last-touch', window_days: 30, join: 'email',
             scope: 'marketing and announcement campaigns only',
             caveat: 'Influenced, not incremental — there is no holdout group.' },
    campaigns: [
      { campaign_id: 'C1', name: 'Spring reactivation', attributable: true, sent: 100,
        clicked: 12, click_rate: 12, bounced: 2, bounce_rate: 2, quotes_after: 5,
        signings: 3, revenue: 4200 },
      { campaign_id: 'C2', name: 'Day change notice', attributable: false, sent: 40,
        clicked: 0, click_rate: 0, bounced: 8, bounce_rate: 20, quotes_after: 0,
        signings: 0, revenue: 0 },
      { campaign_id: 'C3', name: 'Never sent', attributable: true, sent: 0,
        clicked: 0, click_rate: 0, bounced: 0, bounce_rate: 0, quotes_after: 0,
        signings: 0, revenue: 0 }
    ]
  };
  const html = api.performanceHtml(REPORT);

  t('the revenue headline renders', /\$4,200/.test(html));
  t('click rate is shown', /12 clicked \(12%\)/.test(html));
  t('quotes raised after the send are shown', /5 quotes raised after/.test(html));

  // The caveat is the difference between a useful figure and a vanity metric.
  t('the attribution basis is printed next to the number', /last-touch/.test(html));
  t('so is the window', /30-day window/.test(html));
  t('and the honest limitation', /not incremental/.test(html));
  t('opens are explained as deliberately absent', /Apple Mail/.test(html));

  // Operational mail must be visibly excluded, not silently zeroed.
  t('an uncredited campaign is labelled', /not credited/.test(html));
  // A 20% bounce rate is the number that decides whether the domain stays healthy.
  t('a high bounce rate is flagged', /comms-tag err">8 bounced \(20%\)/.test(html), html.slice(0,0));
  t('a low bounce rate is not flagged', /<span class="">2 bounced \(2%\)/.test(html));

  t('a never-sent campaign is not listed as a result', !/Never sent/.test(html));
  t('signings that missed the window are surfaced', /signed too late to credit/.test(html));

  const empty = api.performanceHtml({ ok: true, totals: {}, model: {}, campaigns: [] });
  t('an empty report renders without crashing', /Nothing has been sent yet/.test(empty));
  t('and shows a zero rather than a blank', /\$0/.test(empty));

  // Campaign names come from user input.
  const evil = api.performanceHtml({ ok: true, totals: {}, model: {},
    campaigns: [{ campaign_id: 'X', name: '<img src=x onerror=alert(1)>', attributable: true,
                  sent: 1, clicked: 0, click_rate: 0, bounced: 0, bounce_rate: 0,
                  quotes_after: 0, signings: 0, revenue: 0 }] });
  t('a hostile campaign name cannot inject markup',
    !/<img src=x/.test(evil) && /&lt;img/.test(evil));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
