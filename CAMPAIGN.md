# The reactivation campaign

Everything needed to send the `/service` link to MCP's past clients.

---

## Who the audience is — answered from the data

The open question was whether the 108 `LEAD` rows are all MCP past clients or a
mix. They are **not a mix**, and there is a clean discriminator:

| | the 108 LEAD rows | the other 66 rows |
|---|---|---|
| `year_built` set | **108 — every one** | **0 — none** |
| `timestamp` set | 0 | 61 |
| `created_by` set | 0 | 63 |
| `quote_source` set | 0 | 63 |
| `service` set | 0 | 66 |
| `pool_id` set | 0 | 57 |

Every provenance field on those 108 rows is blank and every one carries a
`year_built` — which nothing else in the CRM has. They arrived as one bulk
import before `handleImportLeads_` began stamping timestamps (the gap
`LeadSegments.js` documents in its own header). The `year_built` values run
**2020 – 2024**, and `specs_summary` holds construction-record descriptions:
`LAGOON 25X11`, `rect.15x36 w/ spa`, `RECT. 35X16 POOL`, `REMODEL`.

That is a builder's handover list, not a sales pipeline. **All 108 are the MCP
people.**

**Also worth knowing before the first send:**

- **101 are mailable** — have an email address, none marked do-not-contact.
- **Zero have ever been emailed.** `last_emailed_at` is empty on all 108 and not
  one has a contact-log entry. Nobody is getting a second touch, and there is no
  risk of contradicting an earlier conversation.
- Areas: 77 NW, 31 NE. Concentrated around Boerne, north San Antonio, Bulverde,
  New Braunfels, Fair Oaks Ranch.

### Building the audience

In the portal's Comms screen, save a segment with:

```
statuses:       ['LEAD']
has_email:      true
exclude_dnc:    true
min_year_built: 2020
```

`min_year_built` is what makes it precise rather than merely correct — if
non-MCP leads are ever added later, they will not carry a `year_built` and will
drop out on their own. Segments store as filters and re-resolve at send time,
so the list stays right without being rebuilt.

⚠️ Category must be **marketing** (or announcement) so it routes to the bulk
lane and carries the unsubscribe footer. Bulk creation is refused outright
unless `COMMS_BUSINESS_ADDRESS` is set in the Apps Script properties — CAN-SPAM
penalties accrue per message, so the guard is deliberate.

Bulk pacing is 100/day between 9am and 5pm, so 101 recipients is two days.

---

## The email

Written for the Comms markup dialect: `**bold**`, `[text](url)`, blank lines
between paragraphs. Placeholders available are `{{first_name}}`, `{{name}}`,
`{{address}}`, `{{city}}`, `{{area}}`.

⚠️ Do not put a placeholder **inside** a link URL. The `[text](url)` parser
rejects whitespace in the URL, so `{{address}}` would break the link silently.

### Subject line — pick one

1. `Your pool, three years on` — curiosity, no pitch
2. `We built your pool. We can look after it too.` — the clearest statement of
   who we are and why we are writing
3. `{{first_name}}, does your pool need anything?` — direct, highest urgency

**Recommendation: 2.** These people have never heard from MCPS, only from MCP.
The single job of the first email is explaining the connection — a subject line
that leads with curiosity wastes the one moment they are deciding whether this
is spam from a stranger.

### Body

```
Hi {{first_name}},

Mission Custom Pool built your pool, and our service team looks after pools
across the San Antonio area — cleanings, repairs, equipment and full
green-to-clean restorations.

If your pool needs anything right now, you can tell us in about a minute:

[Tell us what your pool needs](https://service.mcpoolsolutions.org/?c=mcp-reactivation-2026)

You will not be charged and nothing is scheduled — you tell us what is going
on, and we will get back to you within one business day with a day and a price.

A few of the things we are asked for most:

**Green-to-clean** — the pool has turned and needs bringing back
**Repairs** — pumps, filters, heaters, salt systems, lights and leaks
**Weekly service** — regular cleaning, chemistry and equipment checks
**One-time cleans** — before an event, after a storm, or while you travel

If everything is running well, no reply is needed at all. We are glad to hear
it, and we are here when something changes.

Thank you,
Mission Custom Pool Solutions
```

**Why it reads this way.** It opens by explaining the connection, because
without that the whole thing is a cold email from a company they have no
relationship with. It asks for nothing but a click. It says plainly that nothing
is charged and nothing is scheduled, which is the objection a homeowner brings
to any pool-service email. And it gives an explicit reason not to reply, which
costs a small number of clicks and buys the right to send a second one later.

No prices, no dates, no urgency invented for the occasion — the same discipline
the page itself keeps.

### The link

```
https://service.mcpoolsolutions.org/?c=mcp-reactivation-2026
```

Falls back to `https://mcps-log.vercel.app/service?c=mcp-reactivation-2026`
until the domain is pointed. The `?c=` tag lands on every request as
`campaign_id`, so response is attributable even before per-recipient tokens
exist.

Click tracking needs nothing: `commsTrackedHref_` already rewrites every link in
a campaign body into a signed per-recipient redirect and fills `clicked_at` on
the `Comms_Log` row. `comms_campaign_report` then reports clicks, click rate and
attributed revenue.

---

## Sending it

1. **Seed first.** Send to yourself plus two or three colleagues. Walk the whole
   flow — submit a request, watch it land in `/service-requests`, approve it,
   confirm the visit appears on the schedule.
2. **Check the from address.** Bulk marketing deliberately does not borrow a
   staff mailbox (`Comms.js`), so it sends from the configured bulk sender, not
   from Antonio.
3. **Release the rest.** 100/day, so two days for 101 people.
4. **Watch the queue,** not the inbox. Requests appear at `/service-requests`
   immediately; the office alert email is a convenience, not the system of
   record.
