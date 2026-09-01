# Service request intake

Public page at `/service` where a customer says what their pool needs, plus a
staff queue at `/service-requests` that turns each request into a real visit,
work order, or quote.

Built for the MCP past-client reactivation campaign. **Live in production** —
merged to `main` and deployed; the staff queue is reachable at
`https://mcps-log.vercel.app/#service_requests`.

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
| `js/features/service-requests.js` | the staff queue, a page **inside the portal** (`/#service_requests`) |
| `api/service-request.js` | public intake (POST), prefill + status (GET) |
| `api/service-request-photo.js` | photo upload to Vercel Blob (private) |
| `api/service-requests/review.js` | staff actions — link, create lead, schedule, repair order, decline |
| `api/service-requests/photo.js` | authenticated read proxy for the private photos |
| `api/_lib/identity.js` | the matcher; pure, no I/O |
| `api/_lib/service-requests.js` | sheet schema, validation, idempotency; pure |
| `api/_lib/notify.js` | customer receipt + office alert, sent through Gmail via Apps Script |
| `api/_lib/ids.js` | Routes/Auth spreadsheet ids (`main`'s `_sheets.js` only exports the CRM one) |
| `scripts/preflight-service-request.mjs` | proves the service account can read+write both spreadsheets |
| `scripts/dev-service-request.mjs` | standalone local server for the intake page alone, see below |

Data lives in a new `Service_Requests` tab on the **CRM** spreadsheet. Visits go
to `Scheduled_Visits` and repairs to `Repair_Orders` on the **Routes**
spreadsheet.

## Running it

```bash
node scripts/preflight-service-request.mjs    # check spreadsheet access first
node scripts/dev-service-request.mjs          # http://localhost:3999/service
```

`vercel dev` **does** work in this repo — the earlier claim here (that the root
`requirements.txt` makes the CLI treat the project as Python and fail before
serving) is not what happens. `vercel dev` on :3000 serves the SPA and executes
the API routes; `/api/service-request` answers, and so do `/api/gas`,
`/api/quotes/*` and `/api/schedule`. `scripts/dev-service-request.mjs` remains
useful for working on the intake page in isolation, but it is not a workaround
for a broken `vercel dev`.

One real `vercel dev` gap, unrelated to the intake and **local-only**:
`api/crm/index.js` is never registered as a function by the CLI (v52.2.1). With
`"outputDirectory": "."` the repo root is the static root, so `/api/crm`,
`/api/crm/` and `/api/crm/index` all static-serve the file's source instead of
running it, and the Leads CRM page breaks on localhost. Production routes all
three to the function correctly (401 JSON), so this is a dev-only papercut.
Sibling functions are fine — `api/quotes/get.js` at `/api/quotes/get` executes —
so it is specific to directory-`index.js` resolution. Renaming the file to
`api/crm.js` would fix it in both places without changing the function count.

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

## Registering the portal page took five edits, not one

Adding `service_requests` to `ROLE_PAGES` alone does nothing. All five are
required, and four of them fail silently:

1. `js/lib/constants.js` — `PAGE_META` (the label)
2. `js/lib/constants.js` — `SIDEBAR_GROUPS` (the nav entry)
3. `js/lib/constants.js` — `ROLE_PAGES` (who may see it)
4. `js/lib/auth.js` — **the `order` array in `unionPages_`**. This filter is the
   last word on what a user gets, and a page missing from it is dropped with no
   error anywhere. This is the one that bites.
5. `js/lib/router.js` — the `if (page === '...') load...()` hook

Plus the `<div class="pf" id="page-service_requests">` and the `<script>` tag in
`index.html`.

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

**Feature CSS is injected at runtime, namespaced under the page.** Following
how `comms.js` ships its styles, rather than editing `style.css`. Every selector
is scoped to `#page-service_requests` because the portal defines its own
`--teal` at a different value and bare `.card` / `.tab` / `.b` rules would
collide. Two things that must NOT be namespaced: `@keyframes` and `@media` —
prefixing an at-rule makes it invalid, and one malformed rule makes the browser
discard everything after it. That happened here: a mangled `@keyframes` cost 13
rules and left the tab buttons rendering as unstyled browser defaults.

**A tie in the matcher refuses to match.** Two different people scoring equally
means we cannot tell which one it is. Do not "fix" it by taking the first.

**The blob store is PRIVATE, and the code depends on it.** These are photos of
customers' back gardens and equipment pads; a public blob URL is unguessable but
permanent and unauthenticated, so anyone who ever sees the link keeps access.
Consequences worth knowing:

- `put()` uses `access: 'private'`. Calling it with `'public'` against a private
  store throws outright — that is how this was discovered.
- The sheet stores a **pathname**, not a URL. That also makes the submit-side
  check stronger: a pathname cannot point at another host, so there is no host
  allowlist to get wrong — only a prefix to match.
- Reads go through `api/service-requests/photo.js`, which checks the portal
  session on every request. The console fetches with the token in a **header**
  and renders an object URL; an `<img src>` pointing at the proxy would put the
  session token in the DOM and in browser history.
- `Repair_Orders.photo_url` is deliberately left blank. The Jobs hub renders
  that field as an image and a private pathname would show as broken, so the
  photo count and request id go into the description instead.

**The dev server must stay as capable as the runtime.** `scripts/dev-service-request.mjs`
fakes Vercel's `req`/`res`. Its first version had only `send`/`json`/`end`, so
the streaming photo proxy failed with "res.write is not a function" in dev while
being entirely correct in production. A harness weaker than the real thing
invents bugs that do not exist and hides ones that do — if a handler needs a
response method, add it to the shim.

## Environment

| Variable | Effect if unset |
|---|---|
| `BLOB_READ_WRITE_TOKEN` | photo upload fails politely; requests still send |
| `BLOB_STORE_ID` | informational only; nothing reads it |
| `SERVICE_REQUEST_NOTIFY_SECRET` | no confirmation or office email; requests still save. Must match the Apps Script property of the same name |
| `SERVICE_REQUEST_OFFICE_EMAIL` | defaults to antonio@mcpoolsolutions.org (comma-separated list) |
| `SERVICE_LINK_SECRET` | personalised `?k=` links never verify; page falls back to its address form |
| `SERVICE_REQUEST_INTAKE=off` | kill switch — intake refuses politely, reads keep working |
| `MCPS_PHONE`, `SERVICE_REQUEST_REPLY_TO` | falls back to (210) 559-2073 / antonio@mcpoolsolutions.org |

## Email

MCPS does not use Resend. Everything sends through GmailApp inside Apps Script
(`send_mode: gmail`), so notifications go back through a relay:

```
Vercel builds subject + HTML + text
   → POST to the Apps Script /exec with ?sig=<HMAC of the exact body>
   → handleServiceRequestNotify_ verifies signature, ts skew, nonce
   → GmailApp.sendEmail
```

The relay is dumb on purpose — copy lives on the Vercel side so changing a word
in an email does not need a clasp push and a redeploy.

**To turn it on**, the same secret must exist in both places:

1. Apps Script → Project Settings → Script Properties →
   `SERVICE_REQUEST_NOTIFY_SECRET`
2. Vercel → the `mcps-log` project → Environment Variables → the same name and
   value
3. `clasp push` + redeploy, **from the full working branch only**

Until then it fails open at both stages: no secret configured returns `skipped`,
and a configured secret with the action not yet deployed returns
`{ok:false,error:"Unauthorized"}`. Either way the request is saved and sitting
in the review queue.

⚠️ `appscript/ServiceRequestNotify.js` and its route in `WebhookReceiver.js`
live on the **working branch**, not on this feature branch — `clasp push` sends
whatever `appscript/` the checkout has, so the relay has to travel with the rest
of the Apps Script code.

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
