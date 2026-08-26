# Route Planner — what shipped

Working notes for the sprint that turned the Route Planner from a bulk-move tool
into a schedule control room. Nothing here is committed or deployed yet.

**Suite: 1113 assertions across 30 files, all green.**

---

## Bugs found and fixed

Four real defects, three of them pre-existing. Each has a regression test.

### 1. Route Planner threw on every load
[route-planner.js:43](js/features/route-planner.js#L43) called `_rpCurrentWeekStart_()`;
the function is `rpCurrentWeekStart_()`. Since `_rp.weekStart` starts empty, the
first load always hit it — `ReferenceError`, blank page.

### 2. Past days rendered as open on the fast path
`api/schedule.js` had a complete `lockedDays()` function that was **never called**.
The payload omitted `locked_days` and per-day `locked`, while
[routes.js:1224](js/features/routes.js#L1224) reads `d.locked` to grey out a day
that has already gone. Every day rendered open. `/api/schedule` is the default
path, so this was live.

Fixed by calling `lockedDays(weekStart)` and emitting the shape GAS documents
(`locked_days[]` + `days[].locked`).

### 3. Month view and week board disagreed about the schedule
`getCalendarData` read `Routes` + `Weekly_Overrides` + the legacy `AdHoc_Services`
sheet and **never touched `Scheduled_Visits`**. The week board merges them
([routes.js:402](js/features/routes.js#L402)), so startups, first-month and
temporary series, and G2C one-offs were invisible on the month while the same week
showed them.

### 4. `week_override` was computed and thrown away
The backend flagged every pool a weekly override had moved. Nothing rendered it.

---

## Features

### Batch detail drawer
`reschedule_detail` existed on the backend and had never been called. A ~560px
drawer in its own `#rp-detail-drawer` node — outside `.rp-layout`, so history
re-renders can't clobber it or the composer inside it. Header facts plus a
per-pool table (old → new day/tech, status, error, notify status). Range batches
collapse to one row per pool with a "×N weeks" expander, so 18 pools × 4 weeks
reads as 18 rows, not 72. Available on **every** batch status — `pending`,
`failed` and `reverted` are when you most want to look.

### Notification recipient preview + test send
- `reschedule_notify_preview` — runs the **real** `commsDedupeAndFlag_` the sender
  uses, so the preview count cannot drift from the send count. Returns totals,
  per-recipient skip reasons (missing email / opted out / told recently), and a
  sample rendered against a real moved pool. Writes nothing; asserted by
  snapshotting the sheets before and after.
- `reschedule_notify_test` — sends to the admin. `rsResolveCommsAudience_` honours
  `audience.test_email` by swapping only the address, so placeholders stay real.
  Two guards keep it clean: it skips the batch/item patch, and
  `rsAfterCommsRecipientSent_` returns early on a test audience. The test suite
  pairs each with a **control case** proving a real send *does* mark the item —
  otherwise those assertions could pass on a dead fixture.

### Apply confirmation
Apply opens a review panel instead of firing: pools, weeks, real route-entry count
(`expanded_item_count`), warnings, blockers, over-capacity days, and
"Notifications are not sent automatically."

### Distance warmup status
`reschedule_warmup_status` reports counts by bucket, `last_processed_at`, pending
weeks and recent failures. Badge in the side rail and drawer; **Warm now** drives
the existing `reschedule_warm_distances`, which had never had a caller. Labelled
"route ordering", not "distances" — the warmup evicts `rd:<week>` and calls
`computeRouteData_`, which repopulates `Route_Distance_Cache` as a side effect.

### Day constraints on the board — `reschedule_planner_context`
One read that lets the board warn *before* a move is staged rather than after
preflight rejects it. Everything is derived from sheets other features already own;
this only brings them together in one round trip.

- **Days already gone** — a past day, or today once the route has gone out. The
  column is hatched and badged **Past** / **Route is out**; staging into it warns
  first. Deliberately *not* called "locked" (see below).
- **Blackouts** — reuses `savBlackoutRanges_` / `savIsBlackedOut_` from
  StartAvailability so there is one definition of "we are closed". Blackouts were
  previously read *only* by customer start-date availability; the planner ignored
  them entirely.
- **Per-tech capacity** — `used/max` per technician per day, amber at the limit and
  red over it. A pool leaving a day isn't counted against the target.
- **Technician availability** — techs who don't work the chosen target day are
  disabled in the dropdown with "— off Thursday". Unknown data degrades to
  permissive, never to a locked-out dropdown.
- The target list now comes from **active technicians**, not just whoever has a
  stop this week — an idle tech was previously impossible to move work to.

### Unrouted tray
Active customers with no day or technician never appear on a Mon–Sat board, so the
one screen built for placing work was the one screen that couldn't see what needed
placing. Now surfaced with a count, and honest about its limits: the planner can't
place a pool with no `Routes` row, so the tray says to use Schedule. Monthly pools
missing a service week are called out separately. The 50-row display cap announces
itself.

### Temporary visit series — list, cancel, extend
The last Definition-of-Done item. New `appscript/VisitSeries.js`.

Creating a series always worked; seeing what a pool had, or shortening it, did not
— the only lever was re-running the creator with `replace_existing`, which cancels
*every* temporary row on that pool regardless of series.

Deliberately **no `Visit_Series` sheet and no migration**. Series identity is
already in the rows: `notes` carries `temporary_weekly:<startWeek>:<count>` and
`visit_type` carries the position. Grouping those is enough. Rows predating the
notes token still group by pool + family, so nothing is invisible.

Invariants under test:
- history is never rewritten — only `scheduled` rows dated today or later can be
  cancelled; completed, skipped and past-uncompleted rows survive
- extend is idempotent — a date with a live row for that pool is skipped, not
  doubled, including a date taken by an unrelated one-off
- startups, one-offs and weekly overrides are never swept up as series
- 26 visits is the ceiling, matching the creator's clamp
- `keep_through` shortens instead of cancelling outright

Surfaced in the planner as a tray beside Unrouted, with **Extend** and **End**.
The copy states these live in Scheduled Visits and a board move won't touch them.

### Map: no more silent drops
`rpRenderMap_` filtered out stops without lat/lng and said nothing — 6 dots for a
30-stop route read as the whole route. Now: *"6 of 30 stops plotted — 24 have no
coordinates yet. Run Calculate routes to geocode them."*

---

## Deliberately removed: the day-lock concept

`Route_Lock` exists to stop `calculateRoutes()` clobbering a hand-edited day. Two
facts make it dead weight:

- `autoRecalculateRoutes()` is an intentional no-op — *"Intentionally no auto-recalc
  to enforce confirmation workflow."* `calculateRoutes()` only runs when an admin
  explicitly triggers it.
- **Nothing writes `Route_Lock`.** Every reference in the codebase is a read; the
  sheet is created if missing and never filled. There is no UI or action to lock a
  day, so the table is permanently empty.

So a lock guards against something that cannot happen, using a table nobody can
fill. I initially wired manual locks into preflight as a "fix" — that was wrong,
and it would have blocked real work the first time anyone put a row in that sheet.
Reverted.

What remains is time, not policy: a day that has already passed, and today once the
route went out. Those block a move because scheduling into them is meaningless, and
the blocker now names the reason (`"Friday of 2026-08-31 has already passed."`)
instead of saying "locked" and sending someone hunting for a lock they never set.

**One judgment call left for you:** `RS_LOCK_HOUR = 6` closes *today* as a target
after 6am Central. Moving a pool *off* today still works — only moving one *onto*
today is blocked. If you'd rather be able to add a stop to today's route mid-morning,
that constant is the single knob (or it can go entirely, leaving only past days).

`getLockedDays_()` in `RouteData.js` still reads `Route_Lock` on the GAS fallback
path. Left alone — it also creates the sheet, and the table being empty makes it a
no-op. Worth deleting whenever that function is next touched.

## Not done, on purpose

- **Real basemap** (Google/Mapbox/Leaflet) — Phase 4, gated on whether the
  dependency and key management are worth it.
- **Approval workflow** (Phase 6) — probably overkill at current team size.
- **Manual stop ordering / `Route_Stop_Order`** (Phase 8).
- **`Visit_Series` ledger sheet + `batch_id`/`series_id` columns** (Phases 2, 9) —
  the derived approach delivers list/cancel/extend without a migration. Revisit if
  series need per-visit editing or reporting across years.

## Pre-existing collisions worth knowing

All feature files share one global scope. Three functions are defined twice with
**different bodies**, so the later `<script>` tag silently wins:

| Function | Files | Winner |
|---|---|---|
| `showDrawerMsg` | admin.js, training.js | training.js |
| `_finFmtCurrency` | financial.js, home.js | financial.js |

(`_ordSuffix_` is also duplicated in crm.js and home.js but the bodies are
identical, so it's harmless.) Untouched — fixing them changes behaviour in
features outside this work.

The `service-log.js` / `service-log-v2.js` overlap is *not* a bug: the
`document.write` switch in index.html guarantees exactly one ever loads.

---

## Deploy

```bash
# tests first — every file is standalone, there is no runner
for f in tests/*.test.js; do node "$f" || break; done

clasp push                        # creates appscript/VisitSeries.js
clasp deploy -i <pinned id>       # NOT the editor UI — the portal pins one deployment
```

`api/schedule.js` and the frontend deploy with Vercel on push to main.

**New GAS actions:** `reschedule_notify_preview`, `reschedule_notify_test`,
`reschedule_warmup_status`, `reschedule_planner_context`, `visit_series_list`,
`visit_series_cancel`, `visit_series_extend`. All POST, all admin/manager gated by
the `reschedule_`/`visit_series_` prefix branches in `WebhookReceiver.js`.

### Manual pass on `/route_planner`
1. Load the page — board renders (bug 1).
2. Trays: unrouted count, temporary series count.
3. Navigate to last week → past columns hatch and badge **Past**; staging warns.
4. Target day = a day a tech doesn't work → that tech greys out.
5. Stage 3 pools → Apply → counts correct → apply → warmup badge goes amber.
6. Detail on the batch, and on a reverted one.
7. Notify → recipient list, skip reasons, type a subject, Refresh preview → text
   survives. Send test to me → real day names; confirm `notify_status` still blank.
8. Series tray → Extend by 2, then Extend by 2 again → no duplicate dates.
9. Schedule → Month → a startup week shows a Visits pill; an override shows "moved".

## Git

No commit, no push until you say so. Stage explicitly — `git add .` would sweep in
the unrelated in-flight work in `index.html` and the agreement-signing branch.

Files touched: `appscript/Reschedule.js`, `appscript/VisitSeries.js` (new),
`appscript/RouteData.js`, `appscript/WebhookReceiver.js`, `api/schedule.js`,
`js/features/route-planner.js`, `js/features/routes.js`, `style.css`, and
`tests/{route-planner-ui,reschedule-notifications,route-distance-warmups,
planner-context,visit-series,calendar-overrides,schedule-fast-path}.test.js`.
