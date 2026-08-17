# MCPS Service Areas, Signing Calendar, and Customer Identity Handoff

This is the full feature inventory for the service-area / agreement-signing / customer-identity work. It is written for two audiences:

- Colleagues: what was built, what it does, and why it matters.
- Claude/Codex: what files, endpoints, tests, and invariants to protect if these features are edited later.

## Current Status

Local branch: `feat/agreement-signing-redesign`

Local checkpoint commits:

- `7618720` - Service areas and agreement workflows checkpoint
- `5ffbf97` - Schedule blackout admin controls
- `2d915ad` - People search and duplicate merge tools

Important deploy note:

- These changes are saved locally in git.
- They have not been pushed or published by Codex.
- Apps Script/GAS deploy and frontend/static deploy are separate paths.

## Executive Summary

We built the scheduling foundation that lets MCPS promise a customer a start day only when the system can actually support that promise.

The main idea:

- If a customer address resolves to a real Service Area or an explicit location override, the signing calendar can show route-locked service dates.
- If the address has no zone, no capacity, or no valid day, the signing calendar stays polished but switches to preferred-week mode.
- If the API/rendering fully fails, the plain date input remains the emergency fallback.

We also added the customer-identity foundation:

- Quote tool can search existing customers/properties for every service type.
- Backend search is broad, but automatic identity linking is conservative.
- Duplicate customers can be scanned and soft-merged without deleting history.

## Feature Inventory

### 1. Routes Schema Preservation

What it does:

- Preserves extra Routes columns when the route board is rebuilt or reordered.
- Extra columns follow the `pool_id`, not the row number.
- Applies to all Routes rows, not only pinned rows.

Why it matters:

- Prevents unpinned/monthly/startup rows from inheriting stale zone or metadata after a route reorder.
- Protects new route metadata like zone IDs and pin reasons.

Key files:

- `appscript/RoutePlanner.js`
- `tests/route-schema-preservation.test.js`

### 2. Route Geography Report

What it does:

- Analyzes existing route pools by day, ZIP, operator, and geography.
- Detects ZIPs served on multiple days.
- Reports scattered days, tight pockets, unclassifiable pools, and missing ZIP/geo data.
- Writes nothing; it is a read-only diagnostic.

Why it matters:

- Service Areas can be created from the routes MCPS already runs.
- Ambiguous ZIPs are reported for human review instead of guessed.

Key files:

- `appscript/RouteGeography.js`
- `appscript/WebhookReceiver.js`
- `tests/route-geography.test.js`

Endpoint:

- `analyze_route_geography`

### 3. Service Areas Admin

What it does:

- Adds a Service Areas admin card with tabs for:
  - Zones
  - Coverage
  - Suggestions
  - Blackouts
- Lets admins create, edit, archive, and restore zones.
- Enforces one ZIP per active zone.
- Lets multiple zones share the same weekday.
- Validates saved service days against `SCHEDULABLE_DAYS`.
- Treats blank `max_per_day` as no zone ceiling, not zero.

Why it matters:

- A Service Area is the source of truth for customer-facing day promises.
- Coverage makes gaps visible before customers sign.

Key files:

- `appscript/ServiceAreas.js`
- `js/features/service-areas.js`
- `index.html`
- `tests/service-areas.test.js`
- `tests/zone-proposals.test.js`

Endpoints:

- `get_service_areas`
- `save_service_area`
- `archive_service_area`
- `get_zone_coverage`
- `propose_service_areas`

### 4. Coverage Panel

What it does:

- Shows which ZIPs are covered and uncovered.
- Prioritizes uncovered ZIPs where MCPS already has customers.
- Counts customers without a zone.

Why it matters:

- A ZIP with no zone gets no service day promise at signing.
- Staff can fix the gaps with the highest customer impact first.

Key files:

- `appscript/ServiceAreas.js`
- `js/features/service-areas.js`

### 5. Suggested Zones

What it does:

- Produces draft Service Area suggestions from existing route geography.
- Uses existing pools, ZIPs, route days, and operators.
- Does not save anything automatically.
- Accepting a suggestion opens the normal zone editor, then calls `save_service_area`.

Why it matters:

- Speeds up zone creation while keeping humans in control.
- Ambiguous ZIPs still require review.

Key files:

- `appscript/ServiceAreas.js`
- `appscript/RouteGeography.js`
- `js/features/service-areas.js`
- `tests/zone-proposals.test.js`

### 6. Route-Locked Start Availability

What it does:

- Adds a signing-page availability endpoint.
- For weekly service, only a real Service Area or explicit location override can produce a customer-facing day promise.
- Returns route-locked dates only when the resolved day is schedulable and capacity exists.
- Refuses to promise days from cluster/fallback guesses.

Calendar modes:

- `route_locked`: customer sees selectable dates for the resolved route day.
- `preferred_week`: customer selects a week, not a promised day.
- API/render failure: plain preferred-date fallback.

Key files:

- `appscript/StartAvailability.js`
- `agreement.html`
- `tests/start-availability.test.js`

Endpoint:

- `get_start_availability`

### 7. Preferred-Week Fallback

What it does:

- Keeps the same calendar UI when a date cannot honestly be promised.
- Earliest selectable week starts the following week.
- Hovering a weekday highlights the whole service week.
- Sunday is excluded.
- Clicking any day selects that week.
- Submits `requested_start_week`.
- Does not submit or imply a committed service day.

Why it matters:

- Keeps the signing experience polished without making a false scheduling promise.

Key files:

- `agreement.html`
- `appscript/StartAvailability.js`

Payload fields:

- `requested_start_week`
- `requested_start_date_hint`
- `requested_start_date` remains blank in preferred-week mode
- `committed_service_day` remains blank in preferred-week mode

### 8. Capacity Rules

What it does:

- Capacity is checked by person and date first.
- Zone capacity is an optional extra ceiling.
- Blank `zone.max_per_day` means no zone ceiling.
- Dated visits count against the assigned technician on that date.
- Route pools and weekly service visits for the same pool are counted once.

Why it matters:

- A South-zone startup on Luis should not close Ana's North Tuesday.
- The same startup on Ana should consume Ana's capacity, even if it is in a different zone.

Key files:

- `appscript/StartAvailability.js`
- `appscript/ScheduledVisits.js`
- `tests/start-availability.test.js`
- `tests/scheduled-visit-idempotency.test.js`

### 9. Schedule Blackouts

What it does:

- Adds a Blackouts tab inside Service Areas.
- Staff can create, edit, archive, and restore date ranges where starts should not be offered.
- Availability reads `Schedule_Blackouts`.
- Archived blackout rows are ignored by the calendar but kept for audit.

Why it matters:

- Staff can block holidays, closure weeks, staffing holds, or other no-start periods without code changes.

Key files:

- `appscript/ServiceAreas.js`
- `appscript/StartAvailability.js`
- `js/features/service-areas.js`
- `tests/schedule-blackouts.test.js`
- `tests/start-availability.test.js`

Endpoints:

- `list_schedule_blackouts`
- `save_schedule_blackout`
- `archive_schedule_blackout`

Sheet:

- `Schedule_Blackouts`

### 10. Assignment Exceptions Persistence

What it does:

- Assignment exceptions are now durable rows, not just emails.
- Exceptions are written to `Assignment_Exceptions`.
- Action Queue can show and resolve them.

Exception examples:

- unresolved zone
- preferred day unavailable
- missing first weekly service visit after a lost concurrency claim

Why it matters:

- Ops can actually see unresolved scheduling problems in the portal.
- Exceptions no longer vanish after an email alert.

Key files:

- `appscript/AssignmentExceptions.js`
- `appscript/StartAvailability.js`
- `appscript/ScheduledVisits.js`
- `appscript/WebhookReceiver.js`
- `js/features/action-queue.js`
- `tests/action-queue-nav.test.js`

Endpoints:

- `get_assignment_exceptions`
- `resolve_assignment_exception`

Sheet:

- `Assignment_Exceptions`

### 11. Weekly Service Visit Idempotency

What it does:

- Adds `ensureWeeklyServiceVisit_`.
- Creates the first `weekly_service` scheduled visit once.
- Uses the sheet as the durable source of truth.
- Uses dedup claims only as a race/retry guard.
- If a claim is lost and the row still does not appear, it does not append anyway.
- Records an exception instead of creating a duplicate.

Why it matters:

- Signing retries or concurrent executions should not duplicate promised first visits.

Key files:

- `appscript/ScheduledVisits.js`
- `appscript/SalesHub.js`
- `tests/scheduled-visit-idempotency.test.js`

### 12. Staff/Public Auth Separation

What it does:

- Public signing availability resolves from approval token only.
- Staff preview by `quote_id` requires a valid portal session.
- Public responses do not leak operational details.

Not leaked publicly:

- technician names
- capacity counts
- pool IDs
- zone IDs
- distances

Key files:

- `appscript/StartAvailability.js`
- `agreement.html`
- `tests/start-availability.test.js`

### 13. Existing Customer / Property Search in Quote Tool

What it does:

- Adds `search_people`.
- Searches Clients and Client_Locations together.
- Quote tool can find existing customers by:
  - name
  - email
  - phone
  - address
  - ZIP
- Selecting a customer fills contact fields.
- Selecting a property fills address, city, ZIP, area, and pool hint.
- Works for all quote types, not only repair jobs.

Why it matters:

- New proposals can attach to the existing person/location instead of creating duplicates.
- Existing customer selection is no longer repair-only.

Key files:

- `appscript/PeopleSearch.js`
- `appscript/SalesHub.js`
- `appscript/WebhookReceiver.js`
- `js/features/quotes.js`
- `index.html`
- `tests/people-search.test.js`
- `tests/scope-chips.test.js`

Endpoint:

- `search_people`

### 14. Conservative Person Auto-Linking

What it does:

- Automatic backend quote-to-client matching now requires a stronger match.
- Email-only is not enough.
- Phone-only is not enough.
- Confident matches require at least two signals.

Examples of confident signals:

- email + name
- email + address
- phone + name
- phone + address
- name + address
- email + phone

Why it matters:

- Search can be broad, but automatic linking must not collapse two different people into one client row.

Key files:

- `appscript/PeopleSearch.js`
- `appscript/SalesHub.js`
- `tests/people-search.test.js`

### 15. Duplicate Customer Scan and Soft Merge

What it does:

- Adds an Admin card for Duplicate Customers.
- Scans likely duplicate Clients rows.
- Flags duplicate groups by:
  - same email
  - same phone
  - same name + same address
- Lets staff pick which customer to keep.
- Merges duplicates one at a time.

Soft-merge behavior:

- Keeps the survivor Clients row.
- Repoints child records from duplicate to survivor.
- Fills blank survivor fields from the duplicate.
- Marks the duplicate Clients row as `merged`.
- Writes a row to `Merge_Log`.
- Does not delete customer rows.

Tables repointed:

- `Client_Locations`
- `Proposals`
- `Service_Accounts`
- `Service_Agreements`
- `Quotes.client_id`

Key files:

- `appscript/MergeClients.js`
- `appscript/SalesHub.js`
- `appscript/WebhookReceiver.js`
- `js/features/merge-duplicates.js`
- `index.html`
- `tests/merge-clients.test.js`

Endpoints:

- `find_duplicate_people`
- `merge_clients`

Sheet:

- `Merge_Log`

## Go-Live Checklist

Before calling this live, verify both deploy paths.

Apps Script path:

- `clasp push`
- `clasp deploy -i <deployment-id>`

Make sure these Apps Script files are included:

- `ServiceAreas.js`
- `RouteGeography.js`
- `StartAvailability.js`
- `ScheduledVisits.js`
- `AssignmentExceptions.js`
- `PeopleSearch.js`
- `MergeClients.js`
- `SalesHub.js`
- `WebhookReceiver.js`

Frontend/static path:

- Deploy through the normal repo/static/Vercel flow.

Make sure these frontend files are deployed:

- `agreement.html`
- `index.html`
- `js/features/service-areas.js`
- `js/features/action-queue.js`
- `js/features/quotes.js`
- `js/features/merge-duplicates.js`
- `style.css`

Smoke tests after deploy:

- Open Admin > Service Areas > Coverage.
- Open Admin > Service Areas > Suggestions.
- Create/archive/restore a test blackout.
- Preview a weekly agreement in a zoned ZIP and confirm route-locked dates.
- Preview an unzoned ZIP and confirm preferred-week mode.
- Confirm Sunday is not selectable in preferred-week mode.
- Confirm Action Queue shows assignment exceptions.
- In Quote Tool, search an existing customer by address/ZIP and select a property.
- Save a non-repair quote and verify `client_id` / `location_id` persist.
- Run Duplicate Customers scan.
- Do not merge production duplicates without reviewing the survivor carefully.

## Test Suite

Run all local tests:

```bash
node -e "const fs=require('fs'),cp=require('child_process'); const files=fs.readdirSync('tests').filter(f=>f.endsWith('.test.js')).sort(); let passed=0; for (const f of files){ console.log('\n### '+f); cp.execFileSync(process.execPath,['tests/'+f],{stdio:'inherit'}); passed++; } console.log('\nAll '+passed+' test files passed');"
```

Most relevant focused tests:

```bash
node tests/service-areas.test.js
node tests/zone-proposals.test.js
node tests/route-geography.test.js
node tests/route-schema-preservation.test.js
node tests/start-availability.test.js
node tests/schedule-blackouts.test.js
node tests/scheduled-visit-idempotency.test.js
node tests/action-queue-nav.test.js
node tests/people-search.test.js
node tests/merge-clients.test.js
node tests/scope-chips.test.js
```

Last local verification from Codex:

- Full suite passed: all 21 test files.

## Invariants Claude Must Not Break

These are the rules to preserve if editing this feature set.

1. Only `zone` or `override` may produce a customer-facing service day.
2. `cluster` and fallback assignment logic may help internal routing, but must never render as a customer day promise.
3. If no authoritative day can be promised, use `preferred_week`, not a fake date.
4. Preferred-week mode must not imply a weekday.
5. Preferred-week selectable weeks start no earlier than the following week.
6. Sunday must not be a serviceable/selectable promise.
7. Capacity is person + date first.
8. Zone `max_per_day` is an optional extra ceiling.
9. Blank `max_per_day` means no zone ceiling, effectively Infinity.
10. Staff `quote_id` availability preview requires a portal session.
11. Public signing availability resolves only from approval token.
12. Public availability responses must not leak tech names, pool IDs, capacity numbers, distances, or zone IDs.
13. Assignment exceptions must persist to `Assignment_Exceptions`.
14. First weekly-service visit creation must use `ensureWeeklyServiceVisit_`, not raw `createScheduledVisit_`.
15. Lost dedup claims must not append anyway.
16. Routes extra columns must follow `pool_id`, not row number.
17. One ZIP may belong to only one active Service Area.
18. Search can be broad; automatic person linking must be conservative.
19. Email-only or phone-only is not enough to auto-link a client.
20. Duplicate customer merge is soft merge only: repoint, mark merged, log; never delete.
21. Blackouts are archived/restored, not hard-deleted.

## Presentation Talking Points

Short version for colleagues:

- We now have a real ZIP-to-service-day map instead of guessing.
- Customers only see a promised day when the system knows the route can support it.
- If we do not know the route or capacity, customers pick a preferred week instead of being misled.
- Staff can see uncovered ZIPs, create zones, accept suggested zones, and block no-start dates.
- Ops exceptions now appear in Action Queue instead of disappearing after an email.
- New quotes can attach to existing customers and properties.
- Duplicate customer rows can be found and merged without deleting history.

Suggested demo flow:

1. Show Admin > Service Areas > Coverage and the customer-without-zone count.
2. Show Suggestions and explain that suggestions write nothing until accepted.
3. Show a zoned customer signing calendar in route-locked mode.
4. Show an unzoned customer signing calendar in preferred-week mode.
5. Show the Blackouts tab and explain holiday/staffing holds.
6. Show Action Queue assignment exceptions.
7. Show Quote Tool existing customer/property search.
8. Show Duplicate Customers scan and explain soft merge.

## Known Boundaries

- This document describes the built feature set, not a deployment record.
- Apps Script and frontend deploys must both be verified before go-live.
- New sheets such as `Schedule_Blackouts` and `Merge_Log` are created on demand.
- Production duplicate merges should be reviewed carefully; the tool is designed to preserve history, but merging is still a real data operation.
