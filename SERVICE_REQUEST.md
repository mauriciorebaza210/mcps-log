# Service request intake

Public page at `/service` where a customer says what their pool needs, plus a
staff queue at `/service-requests` that turns each request into a real visit,
work order, or quote.

Built for the MCP past-client reactivation campaign. **Not deployed.**

---

## The one invariant

> The public endpoint writes to `Service_Requests` and nowhere else.

It has no code path to `Quotes` or `Clients`. Every CRM and scheduling side
effect happens later, from the admin console, behind a portal session. A
duplicate person is therefore not something the form is *trusted* not to create
— it is something it *cannot* create. Do not "simplify" this by letting the
intake create a lead.

## Files

| Path | What it is |
|---|---|
| `service-request.html` + `js/service-request.js` | the customer page (`/service`) |
| `service-requests.html` + `js/service-requests-console.js` | the staff queue (`/service-requests`) |
| `api/service-request.js` | public intake (POST), prefill + status (GET) |
| `api/service-request-photo.js` | photo upload to Vercel Blob |
| `api/service-requests/review.js` | staff actions — link, create lead, schedule, repair order, decline |
| `api/_lib/identity.js` | the matcher; pure, no I/O |
| `api/_lib/service-requests.js` | sheet schema, validation, idempotency; pure |
| `api/_lib/notify.js` | customer receipt + office alert via Resend |
| `api/_lib/ids.js` | Routes/Auth spreadsheet ids (`main`'s `_sheets.js` only exports the CRM one) |
| `scripts/preflight-service-request.mjs` | proves the service account can read+write both spreadsheets |
| `scripts/dev-service-request.mjs` | local server — `vercel dev` cannot start in this repo, see below |

Data lives in a new `Service_Requests` tab on the **CRM** spreadsheet. Visits go
to `Scheduled_Visits` and repairs to `Repair_Orders` on the **Routes**
spreadsheet.

## Running it

```bash
node scripts/preflight-service-request.mjs    # check spreadsheet access first
node scripts/dev-service-request.mjs          # http://localhost:3999/service
```

`vercel dev` does **not** work in this repo: a `requirements.txt` at the root
makes the CLI treat the project as Python and the build fails before any route
is served. That is pre-existing and unrelated to this feature, which is why
there is a dedicated dev server rather than a change to project-wide config.

## Tests

```bash
node tests/service-request-identity.test.mjs   # pure — the matcher
node tests/service-request-intake.test.mjs     # pure — validation, idempotency, tokens
node tests/service-request-live.test.mjs       # LIVE — writes to real sheets, cleans up
node tests/service-requests-review.test.mjs    # LIVE — needs an admin portal session
```

The two live suites seed their own data and remove it, including the
`Scheduled_Visits` row and any `Quotes` lead. Run them by hand, not in CI. The
review suite finds an admin session on the `Sessions` sheet, or reads
`SR_TEST_TOKEN`.

## Traps worth knowing

**`ensureSheetWithHeaders` does not repair a partial header row.** It creates a
missing tab, but on an existing one it returns whatever header is there. A
column someone deleted or renamed by hand becomes a silent drop on write — lose
`idempotency_key` that way and every resubmit becomes a duplicate. Both
endpoints append missing columns before writing. Keep that guard.

**Scheduling needs a real `pool_id`.** The schedule joins address, customer name
and map pin by pool id, so a visit without one renders as a nameless stop.
`pool_id` is minted only by the quote/activation pipeline (`_mcpsNextPoolId_`,
`SalesHub.js`), never here. The console refuses, in the handler and not just in
a disabled button.

**Weekly service is deliberately not schedulable.** It needs a signed agreement,
billing and a route slot, so it routes to the quote tool.

**Repairs stop at `Repair_Orders` status `new`.** `Jobs.js` owns approval and
scheduling from there and is the path that mints the visit. Do not add a second
scheduler.

**The customer page must never load `js/lib/api.js`.** It auto-injects the staff
session token from `localStorage` into any payload omitting `token`, and this
page shares an origin with the portal — a logged-in admin would silently send
their session to a public endpoint. `constants.js` likewise ships the webhook
secret `SEC`. Both are why the page is standalone down to its own `post()`.

**A tie in the matcher refuses to match.** Two different people scoring equally
means we cannot tell which one it is. Do not "fix" it by taking the first.

## Environment

| Variable | Effect if unset |
|---|---|
| `BLOB_READ_WRITE_TOKEN` | photo upload fails politely; requests still send |
| `RESEND_API_KEY` | no confirmation or office email; requests still save |
| `SERVICE_REQUEST_OFFICE_EMAIL` | no office alert (comma-separated list) |
| `SERVICE_LINK_SECRET` | personalised `?k=` links never verify; page falls back to its address form |
| `SERVICE_REQUEST_INTAKE=off` | kill switch — intake refuses politely, reads keep working |
| `MCPS_PHONE`, `SERVICE_REQUEST_REPLY_TO` | footer contact falls back to defaults |

## Not done yet

**Personalised links.** The page reads a `?k=` token and greets people by name,
but minting per-recipient tokens needs a `{{service_link}}` placeholder in
`commsPlaceholderMap_` (`appscript/Comms.js`). That is an Apps Script change and
**must be pushed from the full working branch** — `clasp push` replaces every
file in the GAS project, so pushing from a `main`-based checkout would delete
`PeopleSearch.js`, `ActionQueue.js`, `ServiceAreas.js`, `StartAvailability.js`
and `LeadSegments.js` from the live backend.

Until then the campaign link is shared and customers type their address. Every
duplicate guard still applies.
