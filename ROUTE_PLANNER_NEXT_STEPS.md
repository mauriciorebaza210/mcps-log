# Route Planner Next Steps

This plan assumes the current working tree includes:

- Bulk Route Planner page.
- One-week, multi-week, and permanent reschedule backend.
- Specific-pool temporary weekly visits for 1-26 weeks.
- Batch rollback and conflict checks.
- Customer notification queue hook.
- Distance warmup queue.
- Basic map mode with rectangle selection.
- Month calendar override fix.

No git push or commit should happen until Mauricio explicitly asks.

---

## For Dummies

The Route Planner is becoming the control room for schedules.

There are three different kinds of schedule changes:

1. **Move it once**
   - Example: "Move this pool from Tuesday to Friday this week."
   - This should not change the normal route forever.

2. **Move it for X weeks**
   - Example: "Put this pool on Thursday with Mia for 6 weeks."
   - This should create or override only those weeks.

3. **Move it permanently**
   - Example: "This customer is now always Friday with Tony."
   - This changes the real recurring route.

The system should always do four things:

1. **Preview before changing**
   - Show what will happen.
   - Show warnings.
   - Block dangerous moves.

2. **Apply safely**
   - Save exactly what changed.
   - Use locks so two managers cannot overwrite each other.
   - Refresh route ordering in the background.

3. **Notify customers carefully**
   - Preview who will be notified.
   - Skip missing emails and opt-outs.
   - Do not mark anyone notified until the message actually sends.

4. **Undo safely**
   - Revert only the batch we created.
   - Do not erase newer human changes.

The next best build order:

1. Add better batch detail and recipient preview.
2. Add real edit/cancel/extend controls for temporary visit series.
3. Polish map mode and selection tools.
4. Add a constraints engine: tech availability, blackouts, zones, capacity, service windows.
5. Add approval workflow for big risky schedule changes.
6. Add operational reporting: stale warmups, failed notifications, unresolved conflicts.

---

## Why The Next Work Matters

The current implementation gives us the safe foundation. The next step is making it operationally comfortable:

- Managers need to see exactly who they are moving.
- They need to know why a move is risky.
- They need to tell customers without guessing.
- They need to schedule temporary work without duplicate visits.
- They need to recover from mistakes without corrupting the route.
- The system needs to keep working when there are more pools, more techs, more batches, and more edge cases.

---

## Product Principles

1. **No silent schedule mutations**
   - Any non-trivial schedule change needs a batch, series, or audit record.

2. **Temporary and permanent are different things**
   - Temporary changes belong to overrides or scheduled visits.
   - Permanent changes belong to `Routes`.

3. **Preflight is mandatory**
   - Apply must always re-run preflight under lock.

4. **Rollback must be conservative**
   - Revert can undo our own batch.
   - Revert must not overwrite a newer manual/admin change.

5. **Sheets are the durable record**
   - Caches speed reads.
   - Caches cannot be the source of truth.

6. **Customer communication is a separate step**
   - Applying a schedule change should not automatically spam customers.
   - Notifications need preview, test, queue, status, retry, and audit.

---

## Phase 1 - Stabilize The New Planner For Daily Use

### 1. Batch Detail Drawer

Build a detail view for a batch in Route Planner history.

Show:

- Batch ID.
- Status.
- Created by.
- Created time.
- Scope: this week, X weeks, permanent.
- Effective week and end week.
- Pool count.
- Applied count.
- Failed count.
- Notify status.
- Distance warmup status.
- Revert status.
- Each moved pool:
  - customer name
  - pool ID
  - old day
  - old tech
  - new day
  - new tech
  - warnings
  - error
  - notified or not

Backend already has:

- `reschedule_detail`
- `Reschedule_Batches`
- `Reschedule_Items`

Implementation:

- Add `rpOpenBatchDetail_(batchId)`.
- Render detail in the right panel or a compact drawer.
- Add a `Detail` button beside `Notify` and `Revert`.
- Use `reschedule_detail`.

Tests:

- Static UI test confirms detail action exists.
- Backend detail test confirms batch + items return.

Acceptance:

- Manager can answer: "what exactly did this batch do?"

---

### 2. Distance Warmup Visibility

We already queue distance warmups. Now expose them.

Add:

- `reschedule_warmup_status`
- pending count
- failed count
- last processed timestamp
- manual "Warm now" button for admins/managers

Backend:

- Add `rsDistanceWarmupStatus_()`.
- Add action `reschedule_warmup_status`.
- Existing action `reschedule_warm_distances` can process manually.

Frontend:

- Show small badge in Route Planner impact/history:
  - "Route ordering warming"
  - "Route ordering ready"
  - "Warmup failed"

Tests:

- Queue status reports pending/done/failed.
- Manual warm action processes pending rows.

Acceptance:

- Manager knows whether route order may still be stale after a big move.

---

### 3. Better Apply Confirmation

Right now apply is operational but simple.

Add a confirmation summary:

- "You are moving 18 pools."
- "This affects 4 weeks."
- "72 route entries will be changed."
- "3 warnings need acknowledgement."
- "0 blockers."
- "Notifications are not sent automatically."

Implementation:

- Use existing preflight response.
- Add a review modal or right-panel confirmation step before `reschedule_apply`.

Acceptance:

- It is hard to accidentally apply a large batch without noticing.

---

## Phase 2 - Make Specific-Pool Temporary Visits A Real Series

Current state:

- Specific-pool temporary weekly visits can schedule 1-26 weeks.
- It writes `Scheduled_Visits`.
- It cancels prior active first-month/temporary rows for that pool.

Next scalable version:

Create a `Visit_Series` sheet.

Headers:

- `series_id`
- `pool_id`
- `customer_name`
- `series_type`
- `status`
- `start_week`
- `end_week`
- `visit_count`
- `day_of_week`
- `assigned_technician`
- `reason`
- `created_by`
- `created_at`
- `updated_by`
- `updated_at`
- `cancelled_by`
- `cancelled_at`
- `notes`

Add `series_id` to `Scheduled_Visits`.

Why:

- Notes-based grouping works short-term.
- A real series lets us cancel, extend, shorten, edit, report, and audit cleanly.

### Features

1. **Create series**
   - pool
   - start week
   - day
   - tech
   - number of weeks
   - reason

2. **Edit series**
   - change future unsent/incomplete visits only
   - preserve completed/skipped visits

3. **Extend series**
   - add more weeks
   - avoid duplicates

4. **Shorten series**
   - cancel future scheduled rows outside new end
   - preserve history

5. **Cancel series**
   - cancel future scheduled rows
   - keep completed rows

6. **Convert series to permanent**
   - set `Routes.day_of_week`
   - set `Routes.operator`
   - stop future temporary rows after permanent start
   - optionally notify customer

Backend actions:

- `visit_series_create`
- `visit_series_update`
- `visit_series_cancel`
- `visit_series_extend`
- `visit_series_list`
- `visit_series_detail`
- `visit_series_convert_to_permanent`

Tests:

- create 6-week series
- rerun same request idempotently
- edit day from week 3 forward
- completed week 1 is preserved
- cancel future only
- extend from 4 to 8 weeks
- convert to permanent from week 9
- no duplicate scheduled visits

Acceptance:

- A manager can manage temporary work like a real object, not loose rows.

---

## Phase 3 - Notification Center For Reschedules

Current state:

- Backend can create a Comms campaign for a reschedule batch.
- Route Planner now has a simple subject/body composer.
- Post-send hook marks customers notified only after send.

Next version:

### 1. Recipient Preview

Show before queueing:

- total customers
- sendable customers
- missing email
- opted out
- already notified recently
- duplicate emails
- old day
- new day
- effective date

Backend:

- Add `reschedule_notify_preview`.
- Reuse `rsResolveCommsAudience_`.
- Include skip reasons.

Frontend:

- In notify composer, show recipient table.
- Disable queue when zero sendable recipients.

Tests:

- missing email skipped
- opted out skipped
- duplicate email handled once or explicitly listed
- placeholders are populated

### 2. Test Send

Add:

- send test to current admin
- render placeholders using first real moved pool
- do not mark customer notified

Backend:

- `reschedule_notify_test`

Acceptance:

- Manager can see the email before customers do.

### 3. Message Templates

Templates:

- one-week change
- multi-week temporary change
- permanent change
- weather/emergency route shuffle
- technician change only
- day change only

Placeholders:

- `{{first_name}}`
- `{{old_day}}`
- `{{new_day}}`
- `{{old_operator}}`
- `{{new_operator}}`
- `{{effective_date}}`
- `{{end_date}}`
- `{{week_count}}`
- `{{company_phone}}`

Acceptance:

- Most changes can be notified with two clicks.

---

## Phase 4 - Map And Selection Tools

Current state:

- Basic map-like coordinate plot.
- Rectangle selection.
- Board/map toggle.

Next version:

### 1. Map Legend

Show colors for:

- selected
- staged
- warning
- blocked
- no coordinates
- current technician

### 2. Lasso/Rectangle Workflows

Actions after selection:

- stage move
- assign technician
- schedule temporary visits
- exclude selected
- invert selection
- save selection as group

### 3. Cluster Selection

Useful for:

- moving an entire neighborhood
- weather event in one part of town
- technician outage

Implementation:

- Client-side bounding box first.
- Later: actual polygon/lasso.

### 4. Real Basemap Option

Keep the current no-SDK plot as fallback.

Possible future:

- Google Maps embed
- Mapbox
- Leaflet/OpenStreetMap

Do this only if it is worth the dependency and key management.

Acceptance:

- Manager can visually grab a neighborhood and move it.

---

## Phase 5 - Constraints Engine

This is where the planner becomes smart instead of just safe.

Create a shared constraint evaluator used by:

- preflight
- route planner UI
- customer start availability
- temporary visit scheduler
- auto assignment

Constraints to support:

### Hard blockers

- inactive pool
- startup complete
- target day locked
- target date in the past
- technician inactive
- technician does not work that day
- customer suspended
- service blackout
- missing required address for map/routing

### Warnings

- pool is pinned
- exceeds max stops per day
- exceeds route drive-time target
- customer notified recently
- missing customer email
- customer opted out
- temporary visit overlaps recurring route
- monthly pool moved to a non-matching week
- technician zone mismatch
- gate/access issue exists

### Future constraints

- customer time windows
- service frequency
- skill/certification requirements
- chemical/equipment type
- route zone rules
- VIP priority
- weather risk
- holiday closures
- truck capacity
- trainee pairing rules

Implementation:

- Add `ScheduleConstraints.js`.
- Main function: `evaluateScheduleMove_(context, move)`.
- Return structured:
  - `blockers: []`
  - `warnings: []`
  - `facts: {}`
  - `capacity: {}`

Tests:

- One test file per constraint family.
- Preflight must not parse human strings to make decisions.

Acceptance:

- New rules are added in one place instead of scattered through the app.

---

## Phase 6 - Approval Workflow For Risky Changes

Not every schedule move should apply immediately.

Require approval when:

- more than N pools
- more than N weeks
- affects VIP customers
- exceeds capacity
- moves locked-ish dates
- sends customer notifications
- changes permanent route for many pools

Sheets:

- `Schedule_Approvals`

Headers:

- `approval_id`
- `batch_id`
- `status`
- `requested_by`
- `requested_at`
- `approved_by`
- `approved_at`
- `rejected_by`
- `rejected_at`
- `risk_score`
- `reason`
- `notes`

Backend:

- `reschedule_request_approval`
- `reschedule_approve`
- `reschedule_reject`

Frontend:

- Apply button becomes "Request approval" when risk threshold is high.
- Admin can approve from history/detail.

Acceptance:

- Big risky changes get a second set of eyes.

---

## Phase 7 - Reporting And Monitoring

Build an operations panel for schedule health.

Show:

- pending reschedule batches
- failed reschedule items
- partial reverts
- pending distance warmups
- failed distance warmups
- queued notifications
- failed notifications
- customers missing emails
- pools with no coordinates
- pools with duplicate scheduled visits
- temporary series ending soon
- temporary series overdue to convert/cancel

Backend:

- `schedule_ops_health`

Tests:

- each category can be detected
- empty state is clean

Acceptance:

- Problems surface before customers or technicians notice.

---

## Phase 8 - Route Optimization Upgrades

Current:

- Distance cache warms in background.
- Route ordering uses cached driving distance.

Next:

### 1. Stale Route Badge

If warmup pending:

- show "ordering updating"
- show "raw order may be stale"

### 2. Per-Day Reorder

After moving pools:

- allow manager to manually reorder stops
- preserve manual route order
- pin specific stop order if needed

Potential sheet:

- `Route_Stop_Order`

Headers:

- `week_start`
- `day`
- `operator`
- `pool_id`
- `sort_order`
- `locked`
- `source`
- `updated_by`
- `updated_at`

### 3. Optimization Modes

Modes:

- shortest drive
- farthest first
- honor time windows
- keep pinned first/last
- technician preferred order

Acceptance:

- Route order is explainable and controllable.

---

## Phase 9 - Data Model Cleanup

The current architecture can work, but these schema additions make it cleaner:

### Add `batch_id` to `Scheduled_Visits`

Why:

- Batch-owned temporary rows are currently found by notes.
- A real column is safer and easier to query.

### Add `series_id` to `Scheduled_Visits`

Why:

- Lets us manage X-week visit series cleanly.

### Add `source` to schedule rows

Useful values:

- `recurring_route`
- `weekly_override`
- `temporary_series`
- `startup`
- `one_time`
- `manual`

### Add `Schedule_Audit`

For a unified audit log:

- `event_id`
- `event_type`
- `actor`
- `created_at`
- `entity_type`
- `entity_id`
- `before_json`
- `after_json`
- `reason`

Acceptance:

- Audits do not require reverse-engineering multiple sheets.

---

## Phase 10 - Performance And Scale

Rules:

- Read only needed ranges.
- Batch writes.
- Avoid full-sheet rewrites for large sheets.
- Queue expensive Maps work.
- Cap batch sizes.
- Use idempotency keys.
- Store request hashes.
- Use locks only around mutation, not slow previews.

Specific improvements:

- Convert `Weekly_Overrides` rewrite to targeted delete/append or compact periodically.
- Add pruning jobs for old override blank rows.
- Add pagination to batch history.
- Add cursor-based detail for very large batches.
- Add retry states for failed warmups.
- Add daily maintenance job:
  - prune expired overrides
  - process distance warmups
  - detect duplicate scheduled visits
  - report failed notifications

Acceptance:

- Planner stays usable with thousands of route rows and years of history.

---

## Implementation Order

### Next immediate sprint

1. Batch detail drawer.
2. Notification recipient preview.
3. Distance warmup status UI.
4. Visit series ledger.
5. Edit/cancel/extend temporary series.

### Second sprint

1. Map legend and selection actions.
2. Better apply confirmation.
3. Constraint engine extraction.
4. Approval workflow for risky changes.

### Third sprint

1. Route order management.
2. Manual stop ordering.
3. Operations health dashboard.
4. Daily maintenance job.

---

## Test Plan

Keep these tests as permanent guards:

- `tests/reschedule.test.js`
- `tests/calendar-overrides.test.js`
- `tests/route-planner-ui.test.js`
- `tests/temporary-weekly-visits.test.js`
- `tests/temporary-weekly-ui.test.js`

Add:

- `tests/reschedule-notifications.test.js`
- `tests/visit-series.test.js`
- `tests/schedule-constraints.test.js`
- `tests/reschedule-approval.test.js`
- `tests/route-distance-warmups.test.js`
- `tests/schedule-ops-health.test.js`

High-risk scenarios to test:

- two managers apply overlapping batches
- revert after later manual change
- customer missing email
- opted-out customer
- permanent future move promotes later
- temporary series overlaps recurring route
- temporary series edited after one visit completed
- locked day cannot be moved
- map selection includes only points inside rectangle
- route warmup failure does not fail schedule apply
- notification failure does not falsely mark customer notified

---

## Definition Of Done For The Next Release

The next release is ready when:

- A manager can open Route Planner and understand all staged changes.
- A manager can inspect any batch after applying.
- A manager can notify customers with preview and test send.
- A manager can schedule a specific pool for any number of temporary weeks.
- A manager can cancel or extend that temporary schedule.
- Distance warmup status is visible.
- Failed items are visible and actionable.
- All tests pass.
- No git push happens until approved.

