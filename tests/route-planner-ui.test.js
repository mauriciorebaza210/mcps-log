// Route Planner UI guard.
//
//   node tests/route-planner-ui.test.js
//
// Keeps the bulk rescheduling controls understandable: one week, N weeks, or
// permanent. The backend owns correctness; this file guards the product wording
// and payload shape that make those choices obvious to managers.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js/features/route-planner.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

let pass = 0;
let fail = 0;
function t(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log('  ok - ' + name);
  } else {
    fail += 1;
    console.log('  FAIL - ' + name + (detail ? ' ' + detail : ''));
  }
}

console.log('\nRoute Planner scope controls');

t('scope labels are plain English',
  /This week only/.test(src) &&
  /For multiple weeks/.test(src) &&
  /Permanent route change/.test(src));

t('multi-week mode uses a weeks count control',
  /id="rp-week-count"/.test(src) &&
  /min="2"/.test(src) &&
  /max="26"/.test(src));

t('range payload is derived from duration_weeks',
  /duration_weeks:\s*scope === 'range'/.test(src) &&
  /rpRangeEndWeek_\(\)/.test(src));

t('range summary has dedicated styling',
  /\.rp-range-summary/.test(css) &&
  /\.rp-weeks/.test(css));

t('scope changes trigger a fresh preflight',
  /function rpSetScope_/.test(src) &&
  /rpPreflight_\(\)/.test(src));

t('history exposes notification composer for applied batches',
  /rpOpenNotify_/.test(src) &&
  /reschedule_notify/.test(src) &&
  /Queue notification/.test(src));

t('map mode supports rectangle selection',
  /rpSetView_\('map'\)/.test(src) &&
  /function rpRenderMap_/.test(src) &&
  /function rpMapStart_/.test(src) &&
  /function rpMapEnd_/.test(src) &&
  /\.rp-map-rect/.test(css));

t('map never drops uncoordinated stops silently',
  // 6 dots for a 30-stop route reads as "this is the route" unless we say so.
  /const missing = visible\.length - pools\.length/.test(src) &&
  /rp-map-note/.test(src) &&
  /stops plotted/.test(src) &&
  /no coordinates/.test(src) &&
  /\.rp-map-note/.test(css));

console.log('\nBatch detail drawer');

t('history exposes a detail action wired to reschedule_detail',
  /function rpOpenBatchDetail_/.test(src) &&
  /action: 'reschedule_detail'/.test(src) &&
  />Detail</.test(src));

// The Detail button must sit outside the applied/partially_applied ternary so
// pending, failed, and reverted batches stay inspectable.
const actionsBlock = src.slice(src.indexOf('class="rp-history-actions"'));
t('detail button is not gated on applied status',
  actionsBlock.indexOf('>Detail<') > -1 &&
  actionsBlock.indexOf('>Detail<') < actionsBlock.indexOf("['applied','partially_applied']"));

t('drawer renders outside the history panel',
  // #rp-detail-drawer is a sibling of .rp-layout, so rpRenderHistory_ can never
  // clobber an open drawer or the composer inside it.
  /id="rp-detail-drawer"/.test(src) &&
  /function rpRenderDetail_/.test(src) &&
  /\.rp-drawer/.test(css) &&
  /\.rp-drawer-backdrop/.test(css));

t('drawer closes on escape and backdrop',
  /e\.key === 'Escape'/.test(src) &&
  /rp-drawer-backdrop" onclick="rpCloseDetail_\(\)/.test(src));

t('wide item table gets its own horizontal scroll container',
  /\.rp-detail-scroll\{[^}]*overflow-x:auto/.test(css));

console.log('\nNotification recipient preview');

t('composer text is held in state, not read back off the DOM',
  // A preview refresh re-renders #rp-history; DOM-only values would be wiped.
  /function rpNotifyField_/.test(src) &&
  /oninput="rpNotifyField_\('subject'/.test(src) &&
  /oninput="rpNotifyField_\('body'/.test(src) &&
  !/getElementById\('rp-notify-subject'\)\.value/.test(src) &&
  !/getElementById\('rp-notify-body'\)\.value/.test(src));

t('composer previews recipients before queueing',
  /action: 'reschedule_notify_preview'/.test(src) &&
  /function rpLoadNotifyPreview_/.test(src) &&
  /\.rp-recipients/.test(css));

t('queue button is disabled when nothing is sendable',
  /function rpNotifySendable_/.test(src) &&
  /rpNotifySendable_\(\) === 0 \? 'disabled' : ''/.test(src) &&
  /Queue notification \(\$\{n\}\)/.test(src));

t('skip reasons are surfaced per recipient',
  /skip_reason/.test(src) &&
  /missing_email/.test(src) &&
  /opted_out/.test(src) &&
  /notified_recently/.test(src));

t('test send goes to the admin without notifying customers',
  /action: 'reschedule_notify_test'/.test(src) &&
  /Send test to me/.test(src) &&
  /No customer was notified/.test(src));

console.log('\nApply confirmation');

t('apply opens a confirmation before mutating',
  /function rpConfirmApply_/.test(src) &&
  /id="rp-confirm-apply"/.test(src) &&
  /mode: 'confirm'/.test(src));

t('confirmation reports the real entry count',
  /expanded_item_count/.test(src) &&
  /You are moving/.test(src) &&
  /Notifications are not sent automatically/.test(src) &&
  /\.rp-confirm-list/.test(css));

console.log('\nDistance warmup status');

t('warmup status is fetched and badged',
  /action: 'reschedule_warmup_status'/.test(src) &&
  /function rpWarmupBadge_/.test(src) &&
  /Route ordering ready/.test(src) &&
  /Route ordering updating/.test(src) &&
  /\.rp-warmup/.test(css));

t('managers can warm pending weeks on demand',
  /action: 'reschedule_warm_distances'/.test(src) &&
  /function rpWarmNow_/.test(src) &&
  /Warm now/.test(src));

t('warmup status refreshes after apply and revert',
  (src.match(/rpLoadWarmupStatus_\(\)/g) || []).length >= 4);

console.log('\nDay constraints on the board');

t('planner context is loaded and refreshed per week',
  /action: 'reschedule_planner_context'/.test(src) &&
  /function rpLoadPlannerContext_/.test(src) &&
  // Closed days, blackouts and load are week-specific — stale context mislabels days.
  /_rp\.ctx = null;/.test(src));

t('days already gone and blackout days are marked on the column',
  /function rpDayGoneReason_/.test(src) &&
  /function rpDayBlackout_/.test(src) &&
  /Blackout/.test(src) &&
  /\.rp-col\.closed/.test(css));

t('a closed day is labelled by what actually happened',
  // "Locked" implied an admin freeze this app has no way to create.
  /'Route is out'/.test(src) &&
  /'Past'/.test(src) &&
  /already went out/.test(src));

t('the planner never speaks of locked days',
  !/Locked by admin/.test(src) && !/rpDayLocked_/.test(src));

t('per-technician capacity shows on each day',
  /function rpDayCapacityHtml_/.test(src) &&
  /max_per_day/.test(src) &&
  /\.rp-cap/.test(css) &&
  /\.rp-cap\.bad/.test(css));

t('a pool leaving a day is not counted against the target',
  /if \(p\._ghost\) return;/.test(src));

t('staging into a closed day warns first',
  /rpDayClosed_\(day\)/.test(src) &&
  /Stage it anyway\?/.test(src));

t('technicians who do not work the target day are disabled',
  /function rpTechWorksDay_/.test(src) &&
  /function rpTargetDayChanged_/.test(src) &&
  /onchange="rpTargetDayChanged_\(\)"/.test(src) &&
  /off ' \+ escHtml/.test(src));

t('unknown technician days never block a choice',
  // No capacity data must degrade to permissive, not to a locked-out dropdown.
  /if \(!tech \|\| !tech\.days \|\| !tech\.days\.length\) return true/.test(src));

console.log('\nUnrouted tray');

t('pools needing routing surface on the planner',
  /function rpRenderUnrouted_/.test(src) &&
  /need routing/.test(src) &&
  /\.rp-unrouted/.test(css));

t('monthly pools needing a week are distinguished',
  /needs_monthly_week/.test(src) && /needs a service week/.test(src));

t('the tray says where to place them',
  // The planner cannot place a pool with no Routes row; it must not pretend to.
  /Give them a day and technician/.test(src));

t('a truncated tray announces the cap',
  /un\.truncated/.test(src) && /Showing the first/.test(src));

console.log('\nTemporary series management');

t('active series are listed on the planner',
  /action: 'visit_series_list'/.test(src) &&
  /function rpSeriesHtml_/.test(src) &&
  /temporary series/.test(src));

t('a series shows how many visits are left',
  /Number\(s\.remaining\)\} of \$\{Number\(s\.total\)\} left/.test(src) &&
  /next ' \+ escHtml\(s\.next_date\)/.test(src));

t('a series can be extended and ended',
  /action: 'visit_series_extend'/.test(src) &&
  /action: 'visit_series_cancel'/.test(src) &&
  /function rpExtendSeries_/.test(src) &&
  /function rpCancelSeries_/.test(src));

t('ending a series promises completed visits are kept',
  /Completed visits are kept/.test(src));

t('extend surfaces skipped duplicate dates',
  // The backend skips a date that already has a visit; silently dropping it
  // would look like the extension came up short for no reason.
  /skipped_dates/.test(src) && /already had a visit/.test(src));

t('the tray explains series are not on the recurring route',
  // A manager who bulk-moves the board must know these rows are untouched.
  /won't touch them/.test(src));

t('a series change busts the route cache and reloads',
  /function rpAfterSeriesChange_/.test(src) &&
  /_clearRouteCache/.test(src) &&
  /rpLoadSeries_\(\);/.test(src));

t('both trays share one node so neither clobbers the other',
  /id="rp-trays"/.test(src) &&
  /function rpRenderTrays_/.test(src) &&
  /\.rp-trays/.test(css));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
