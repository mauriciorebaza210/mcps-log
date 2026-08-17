# MCPS Service Areas + Customer Scheduling Summary

This is the simple team-facing version of what has been built.

## Big Picture

We built a smarter scheduling and customer setup system for new quotes and signed agreements.

The goal is simple:

**Only promise a customer a service day when we actually know we can service that area on that day.**

If we do not know yet, the customer can still sign smoothly, but they choose a preferred week instead of being promised a specific day.

## What Customers See When Signing

### If Their Address Is in a Service Area

The customer sees a calendar with real available start dates.

Example:

- Their ZIP belongs to a Tuesday service area.
- The calendar only shows available Tuesday dates.
- They pick an exact first service date.
- We can confidently say what day they will be serviced.

### If Their Address Is Not in a Service Area

The customer still sees a calendar, but it switches to preferred-week mode.

They pick a week they would like to start.

Important:

- We do not promise a specific day.
- We say we will confirm the exact first service day after they sign.
- This keeps the experience polished without overpromising.

### If the Availability System Fully Fails

There is still an emergency fallback date input so signing does not break.

## Service Areas

Service Areas are how we map ZIP codes to service days.

Example:

- Stone Oak = Tuesday
- Alamo Ranch = Thursday
- Southside = Tuesday

Two different areas can share the same weekday if different technicians are handling them.

The system prevents the same ZIP from being assigned to two active areas at the same time.

## Admin: Service Areas Page

Admins now have a Service Areas admin section with four parts.

### Zones

This is where we create and manage service areas.

Each zone has:

- Zone name
- Service day
- ZIP codes
- Primary technician
- Optional max pools per day
- Color
- Active/archive status

### Coverage

This shows which ZIP codes are covered and which are not.

Most important: it shows how many existing customers live in ZIPs with no service area.

That tells us where customers would not be shown a promised service day.

### Suggestions

The system can look at routes we already run and suggest possible service areas.

Nothing is saved automatically.

Staff still reviews the suggestion and chooses whether to create it.

### Blackouts

Admins can block date ranges where new starts should not be offered.

Examples:

- Holidays
- Company closure days
- Staffing holds
- Weeks where we do not want new starts

Archived blackouts are kept for history but ignored by the calendar.

## Capacity Logic

Availability is based mostly on the technician and date, not just the area.

That matters because two zones can share the same weekday.

Example:

- Ana handles North on Tuesday.
- Luis handles South on Tuesday.
- A South startup assigned to Luis should not make Ana’s North Tuesday unavailable.

But if Ana is handling both jobs, then her capacity is affected.

That is the logic now.

## Action Queue

Scheduling problems can now show up in Action Queue instead of only being emailed.

Examples:

- Customer ZIP has no service area
- Preferred day could not be honored
- First weekly service visit could not be safely created

Staff can see and resolve these items instead of losing them after an email alert.

## First Weekly Service Visit

When a customer signs and we have a real promised start date, the system can create the first weekly service visit.

It is protected from duplicates.

That means if someone refreshes, retries, or the system runs twice, it should not create the same first visit twice.

## Quote Tool: Existing Customers

The Quote Tool can now search for existing customers and properties.

Staff can search by:

- Name
- Email
- Phone
- Address
- ZIP code

This works for all quote types, not just repair jobs.

When staff selects an existing customer/property, the quote connects to the existing customer record instead of creating a duplicate.

## Customer Identity Rules

The system is careful about matching customers.

Search can be broad, but automatic matching is conservative.

Email alone is not enough to automatically decide two records are the same person.

Phone alone is not enough either.

The system needs stronger evidence, like:

- Email + name
- Email + address
- Phone + name
- Phone + address
- Name + address

This helps avoid accidentally combining two different people.

## Duplicate Customer Cleanup

Admins now have a Duplicate Customers tool.

It can find likely duplicate customer records by:

- Same email
- Same phone
- Same name and same property address

Staff chooses which customer record to keep.

When merging:

- The kept customer stays active.
- Linked records move to the kept customer.
- The duplicate is marked as merged.
- Nothing is deleted.
- A merge log is kept.

## What This Solves

Before this work:

- We could accidentally promise service days based on guesses.
- ZIPs with no clear service area were hard to spot.
- Scheduling exceptions could disappear after an email.
- Existing customers could accidentally get duplicate records.
- Repair jobs had better customer search than other quote types.

Now:

- Customer day promises come only from real service areas or explicit overrides.
- No-zone customers get preferred-week mode instead of a false promise.
- Admins can see coverage gaps.
- Admins can block no-start dates.
- Action Queue can show scheduling exceptions.
- Quotes can attach to existing customers/properties.
- Duplicate customers can be found and merged safely.

## Suggested Demo Flow

1. Show Service Areas > Coverage.
2. Point out ZIPs/customers with no zone.
3. Show Service Areas > Suggestions.
4. Explain that suggestions are drafts and do not save automatically.
5. Show Service Areas > Blackouts.
6. Show a customer in a covered ZIP getting exact available dates.
7. Show a customer in an uncovered ZIP getting preferred-week mode.
8. Show Action Queue assignment exceptions.
9. Show Quote Tool existing customer/property search.
10. Show Duplicate Customers scan.

## What Staff Should Remember

- A Service Area is what allows us to promise a customer a real service day.
- No Service Area means preferred week, not a promised day.
- Blackouts remove dates from the signing calendar.
- Coverage gaps should be fixed before expecting the calendar to promise days.
- Existing customers should be selected in the Quote Tool when possible.
- Duplicate merges should be reviewed carefully before clicking merge.

## Deployment Note

This work has been saved locally, but the team should still verify both deployment paths before calling it fully live:

- Apps Script backend deploy
- Frontend/static website deploy

Both sides matter because the backend controls the data and scheduling logic, while the frontend controls what staff and customers actually see.
