# Lifecycle Email Engine: contracts first, then a narrow B/C slice

## Context
Mau is building an email engine to demo to Tony. Contacts sit in 6 lifecycle buckets, and each bucket runs a timed, per-contact sequence of approved emails, with detailed tracking (sent, opened, clicked, replied) and enterprise-speed pages.

This plan has been through two reviews. The first produced the contract sections. The second (8.5/10) approved Phase 0 and asked for eight corrections before production work. All eight are integrated here:
1. Lock boundaries vs. stop requests
2. Retry vs. reconcile by send stage
3. Suppression vs. enrollment vs. step-level stops
4. Reply classification precedence and shared threads
5. Evidence and confidence instead of "confirmed"
6. Authenticated read path
7. An honest security boundary, plus rollback compatibility
8. One consistent rule for scheduling and versioning

Guarantees stay **provisional** until the Phase 0 spikes measure them. Performance numbers are **targets, unproven until benchmarked**.

**Review traceability (second review → where it's resolved)**
| # | Correction | Resolved in | Acceptance rows |
|---|---|---|---|
| 1 | Unsubscribe vs. single-writer lock | *Lock boundaries*: run lease ≠ script lock; script lock only for short sections with no external calls; Inbox ingest path never waits on a run; pre-send gate re-checks the Inbox, CacheService flag and `Comms_Optouts` before draft creation and before `send()` | 9 (sandbox), 10, 7, 8 |
| 2 | Unsafe "transient → eligible" | *State machines*: Stage A retries preparation only. Stage B (after `send()` is invoked) → reconcile, never eligible. Stage C retries bookkeeping only. Full UUID token persisted before `createDraft`. Orphan-draft recovery. Settled: nothing in `sending` is ever automatically resent; Phase 0 only sets the grace periods and quiescence | 1–6, 15, 41 |
| 3 | Stop model vs. category policy | *Stop model*: person suppression by scope (all / marketing), enrollment termination, and branch/step stops as separate layers. C Maintenance stops only `marketing_branch` | 18, 19; worked examples 14–16 |
| 4 | Reply precedence + shared threads | *Tracking → Replies*: precedence is sender → bounce → automation → contact → other. Dedupe by `gmail_message_id`, per-thread cursors, attribution to the latest prior delivery | 20, 21 |
| 5 | "Confirmed click" overstates | *Tracking*: raw observations kept, versioned classifier, low/medium/high confidence; "browser-verified" wording; beacon loss stated as an accepted limitation; external CTAs go through a `/go` interstitial | 22, 23 |
| 6 | Read path security | *Read-path security*: Bearer auth on every read, Permissions check, per-permission redaction after cache, `private, no-store` + `Vary`, per-user browser cache cleared on logout or user change | 31 |
| 7 | Owner-only claim, rollback | *Security boundary & rollback*: trusted maintainers stated explicitly; property-hash audit; read-compatibility ranges; expand → migrate → contract; rollback floor | 32, 33 |
| R4-1 | Journal must govern crash recovery | *Journal* section: authoritative ordered record, `op_id`s, `applied_seq`, catch-up replay before any claim or authorization, Gmail only after both writes, Journal-driven secondary writes, fail-closed pause; implemented in Phase 1 | 42–45, 39 |
| R4-2 | Fencing can't revoke an authorized Gmail call | *Lock boundaries* (fencing limit contract) + *State machines* (quiescence-gated Resend) | 35a, 35b, 46 |
| R4-c | Cleanup of contradictory text | Row count, Phase 0 verdict, traceability, cutoff wording, example 13, the permitted in-lock operations with latency budget, Journal in Phase 1, minimum runbook as a production gate | — |
| R3-1 | Stale worker after lease expiry | *Lock boundaries*: lease `generation` fencing token checked at every claim, transition and authorization; a stale worker stops; `sending` is only ever reconciled | 35 |
| R3-2 | Ambiguous sends stay manual | *Guarantees* + *State machines*: `sending` never returns to eligibility, unconditionally; Phase 0 results are guidance only; demo wording changed | 41, 1–6 |
| R3-3 | Precise unsubscribe cutoff | *Guarantees* + *Lock boundaries*: the authorization point is `drafted → sending` under the lock, ordered against ingestion | 36–38 |
| R3-4 | Restore beyond a Sent search | *Operations*: an independent write-ahead Journal, replay after the backup's `journal_seq`, accepted recovery-point loss stated | 39 |
| R3-5 | Test isolation incl. shared suppression | *Execution modes*: mode taken from the signed delivery identity; test writes never touch `Comms_Optouts` or `sup:prod:` | 40 |
| R3-a | Ambiguous `editor+` / `operator+` | *Configuration & authorization*: explicit capabilities, union of roles, no inheritance | 31 |
| R3-b | Performance acceptance | *Performance*: mandatory launch budgets (gate) vs. aspirational targets, with the fallback | Verification 5 |
| 8 | Scheduling vs. revision consistency | *Decisions* (best-effort Comms frequency, same local day); *Scheduling* (per-enrollment `rule_rev` with publish scope, run snapshot binds rules **and** content, `max_hold_days` + `hard_deadline`); every recovered draft passes the full gate; performance marked unproven and benchmarked by bytes and ranges | 12, 13, 15, 24, 25; worked example 13 |

**Exploration facts this relies on**
- **Stack.** The portal is vanilla JS plus plain Vercel functions, at exactly 12 functions (the Hobby cap).
- **Fast Vercel read path.** `api/_sheets.js` has a service-account token, `readSheetRanges` (one batchGet), `getCached`, `sendJson`, `validatePortalSession` (10-min cache) and `requireAdminPortalToken`.
- **Frontend cache:** `_appCacheGet/_appCacheSet/_appCacheRemove` in `app.js`.
- **Comms engine:**
  - `Comms_Optouts` (scopes `all`/`marketing_announcements`, tombstones) and `Comms_Log` (`email`, `sent_at`)
  - the parsers `cbParseBounce_` (`appscript/CommsBounces.js:35`) and `cbLooksLikeAutoReply_` (`:78`)
  - attribution in `CommsReport.js`
- **Signed relay pattern:** `api/_lib/notify.js` ↔ `ServiceRequestNotify.js`, with HMAC + ts + nonce.
- **Quote-form prefill:** `mintLinkToken`/`verifyLinkToken` in `api/service-request.js`.
- **UMD precedent:** `js/lib/pricing.js`.
- **`SEC` is public**, so it is never used for auth.
- **GAS deploy:** the portal's `.clasp.json` pushes only `appscript/`.
- **Tests:** plain Node scripts in `tests/`. Node is v24.

## Decisions
| Topic | Decision |
|---|---|
| Timing source | Mau's Oct 19 notebook (matrix below) |
| Frequency | ≤1 lifecycle email per contact per **local calendar day**, enforced inside the engine. Coordination with Comms is **best-effort**: the engine holds if `Comms_Log` shows a send to that address on the same local day. Same-second races across projects are possible, and the UI labels this "best-effort" |
| Re-entry | B never re-runs for a person; returning contacts go to Needs review. Each sequence has its own `reentry` policy |
| Click stop | B stops only on **high-confidence** click evidence (a browser-verified landing). Lower-confidence hits are recorded, never stop anything |
| Approvals | Permission-based. The two-person rule is an option (`require_second_approver`), off by default |
| Sender | Tony's account (antonio@mcpoolsolutions.org) |
| Engine location | Separate Apps Script project owned by Tony, bound to a new "MCPS Email Engine" spreadsheet |
| Functions | Merge `api/quotes/*` into one function. `api/email.js` handles everything else (11 total) |
| UI | Admin page "Lifecycle Email". The main Emails table has no "When it sends" column |
| Trust boundary | Project editors (Tony as owner, Mau as editor) are **trusted maintainers**. App permissions govern portal users only (see Security) |

## Priority: MCP Legacy (B) and MCP Startup (C) first
- **Until B and C are live in production, all build, test and UI effort goes to those two sequences.**
  - **Scheduled emails (7):**
    - B: MCP x MCPS Intro, MCPS Follow Up, Personal Check-In
    - C: Welcome Email (with attachments), Startup Progress ×4, Maintenance Invitation, Final Transition
  - **C event emails (startup visits, see *Event-triggered emails*):** Startup On the Way (each startup day), Startup Day Log (each startup day), Startup Summary (last startup day: summary/report + pool school scheduling)
- **Deferred until after B/C go-live:**
  - `monthly` and business-day timing in `decide()` and in the wizard (only A/D need them)
  - **Pulled forward (C needs it):** event-triggered sending. Its generic form for A/E (inquiry, proposal, milestone) still waits.
  - templates for A/D/E/F, hourly runs, the `/go` interstitial
- **Reserved now** so A/D/E/F stay cheap later: their Sheet columns and the 8 draft step rows (seeded, inactive). Nothing on them is built yet.
- **Order inside the priority:**
  1. B Intro + C Welcome (the sandbox slice)
  2. B Follow Up / Check-In + C Progress / Maintenance / Final Transition
  3. C startup event emails: On the Way, Day Log, Summary, plus the portal content they deliver (customer startup log, summary report, pool school booking)
  4. B/C contact loading: import of the legacy list into B; startup requests into C with live `Scheduled_Visits` dates

## Working on this across sessions (resume anytime)
- **The plan lives in the repo, not in a chat.** On the `feat/email-engine` branch (worktree `../mcps-log-email-engine`):
  - **`email-engine/docs/PLAN.md`:** this plan. Any change gets a dated line in its *Plan changes* section; nothing is edited silently.
  - **`email-engine/docs/PROGRESS.md`:** the living status, with these sections:
    - **Now:** current checkpoint, the exact next action, blockers, decisions waiting on Mau or Tony
    - **Checkpoint log:** date, tag, commit, evidence, what's next
    - **Parking lot:** sidetracks and tweaks to come back to
    - **Session notes**
  - Both files are committed (`tasks/` is gitignored, so they live next to the engine code; `email-engine/` is in `.vercelignore`).
- **`/email-engine` command.** A user-level skill (`~/.claude/skills/email-engine/SKILL.md`) works from any Claude Code session, in any folder:
  - **`/email-engine`:** reads PROGRESS.md (Now) and the active phase of PLAN.md, checks git status and commits since the last checkpoint tag, then says where we are and the next action.
  - **`/email-engine park "<note>"`:** before switching to other work, commits any WIP on the branch (`WIP:` message, explicit paths) and records the stopping point, plus the note, in PROGRESS.md.
  - **`/email-engine checkpoint`:** verifies the current checkpoint's exit criteria (runs the tests), then commits, tags it, logs the evidence and updates *Now*.
  - **`/email-engine tweak "<change>"`:** applies a plan change to PLAN.md with a dated *Plan changes* entry, and flags any checkpoint it affects.
- **A memory note** (`project_email_engine.md` + its MEMORY.md line) points at the worktree and the command, so a fresh chat knows this project exists.
- **Sidetracks don't disturb it.** Unrelated portal work happens in the main checkout (`~/mcps-log`), so the email-engine worktree stays exactly where we left it.

## Checkpoints
At each checkpoint:
1. All exit criteria pass.
2. Commit on `feat/email-engine`.
3. Annotated tag `ee/cpN-<name>`.
4. PROGRESS.md entry (evidence: test output, spike report, screenshots).
5. Memory note updated.

The tag is the rollback point (`git checkout ee/cpN-…`). Nothing reaches `main` or production without Mau's explicit go.

| CP | Name | Exit criteria |
|---|---|---|
| 0 | `setup` | Worktree; PLAN.md + PROGRESS.md committed; `/email-engine` skill and memory note in place; mockup v3 (no "When it sends", detailed evidence-graded tracking, `unknown` resolver, pause switches) **signed off by Mau** |
| 1 | `spikes` | Phase 0 spike report committed (project ownership, send boundary, G/G2, quiescence margin, lock-hold p95, bytes per read, `Comms_*` tabs live); Guarantees section updated to match the findings |
| 2 | `rules` | `lifecycle-rules.js` `decide()` for enrollment/startup/previous anchors, holds, deadlines and the stop model; worked examples 1–7, 9, 11–16 pass under `npm run test:ee` (discovery proven) |
| 3 | `journal` | Journal + fenced lease + delivery stages + reconcile + quiescence Resend; the FG matrix rows (incl. 42–46 fault injection) pass |
| 4 | `sandbox-send` | Engine project deployed in the sandbox; B Intro + C Welcome revisions approved; the test-delivery sends arrive branded; SB rows pass (1–5, 9, 35a/b, 36–40) |
| 5 | `tracking-api` | `api/email.js` (authenticated reads, c/o/beacon/u, heartbeat) + quotes merge; `vercel build` + import checks; API rows pass; quote flows OK on preview |
| 6 | `slice-demo` | Minimal Lifecycle page; **mandatory performance budgets pass**; demo script run for Tony. *Reviewer approval boundary* |
| 7 | `bc-scheduled` | **First: contact import (any spreadsheet format) and Start a batch with "Start on" dates** (moved up from CP10, Mau 2026-11-10). Then: ~~all 7 scheduled B/C emails approved~~ (moved to CP9, 2026-11-11); Attachment Library working (the Welcome PDFs can be added now or later); wizard for B/C (enrollment/startup/previous anchors); **each email's Setup editable (timing, stops, on/off) as new rule revisions with a scope choice**; **single email sequence type (`date` anchor) with the Template Library**; **send times** (campaign default + per batch, runs at those times, shown in Central time everywhere; failure rows 58–61; one-off trigger precision measured); **per-send overrides, moving batches and restarts working from the calendar** (rows 62–64); minimum runbook done; matrix green. *B may go live from here if Mau and Tony choose; it doesn't depend on the startup events* |
| 8 | `startup-events` *(after CP9, Mau 2026-11-11; Day Log redefined, WIP: startup report from the service log)* | Event pipeline (signed `ee_event`, immediate delivery, visit-keyed occurrences, hard deadlines, dynamic attachments); ~~portal: startup OTW routed to the engine~~ (dropped 2026-11-11: HeadsUp keeps On My Way); customer Startup Log, Startup Summary report, pool school booking page; **Day Log + Summary built but Off at launch**; event matrix rows 47–55 green (47–50 and 52 dropped with OTW); ~~OTW latency budget met~~ (dropped with OTW) |
| 9 | `bc-live` | **Go-live decision with Mau and Tony.** **Before the handoff to Tony: the in-portal tutorial and the "Request a change" button are built and Mau has walked through both** (Plan changes 2026-11-11). **All 7 scheduled B/C emails approved** (moved from CP7). **At launch only the MCP Startup Welcome is On**: every other B/C email (Intro, Follow Up, Check-In, Startup Progress, Maintenance Invitation, Final Transition) and the CP8 Day Log + Summary go live Off and are switched on later from the portal (Mau 2026-11-11). Portal GAS changes deployed; production enabled for B/C with test mode off; first week monitored, with no `unknown` deliveries left unresolved |
| 10 | `bc-contacts` | Legacy list loaded through the import (built in CP7) and the first batches lined up; C sync from startup requests with live dates |
| 11+ | other buckets | Phase 4 items: monthly/business-day timing, generic events (inquiry, proposal, milestone), then D, E, F, A |

## Guarantees
- **No automatic duplicates (unconditional for this release).** Once a delivery enters `sending`, it **never automatically returns to send eligibility**, whatever any experiment shows.
- **Interrupted execution resolves by evidence.** The delivery ends up `sent` (its token is found in Sent), `reconcile` (waiting for the grace period), or `unknown` (a human decides).
- **Exactly-one delivery cannot be guaranteed.** If execution dies just before Gmail accepts the message, it stays unsent until a human resolves it. At this volume that tradeoff is accepted. Phase 0 results are operational guidance (grace periods, runbook), not proof.
- **Phase 0 checked these guarantees against measurements (SPIKES.md, 2026-11-02) and none needed weakening:**
  - Drafts disappear on send, and sent mail is searchable within seconds (G = 2 min, G2 = 15 min).
  - Unsubscribe ordering held in 6 of 6 cases.
  - Lock-hold p95 is inside the budget.
  - The engine runs as Tony only when Tony deploys it (enforced by the deploy check and the owner guard).
  - No timing-based kill could interrupt a call, so interrupted sends are tested by fault injection.
- **Unsubscribe cutoff (precise).** A successfully recorded unsubscribe blocks every **send authorization** that comes after it. A delivery that was already authorized or in flight may complete. The authorization point and its ordering are defined under *Lock boundaries*.
- **Stop signals:**
  - Durable: unsubscribe, form submit, replies and bounces (the mailbox can be re-scanned).
  - Best-effort: browser-verified clicks. A lost beacon means a click doesn't stop B; this limitation is accepted and documented.
  - Opens and redirect hits never stop anything.
- **Suppression fails closed.** If opt-outs can't be read, nothing sends.

## Architecture
```
Browser (portal) ── Authorization: Bearer token ──► Vercel api/email.js (1 fn)
  render from per-user cache, then revalidate        op=read    authn + permission → bounded batchGet of engine SS → redact → private,no-store
  shared lifecycle-rules.js for instant previews     op=admin   authn + permission → signed relay → engine ee_* (writes)
                                                     op=c|o     302 / GIF immediately; waitUntil → signed → ee_track
                                                     op=beacon  landing-page evidence, sync → ee_track
                                                     op=u       GET page; POST sync → ee_unsubscribe
                                                     op=heartbeat (Vercel Cron) reads engine SS directly → portal GAS ee_alert
Engine GAS project (Tony)
  ingest path (ee_track, ee_unsubscribe): NO run lease; short script lock; append to Inbox (+ Comms_Optouts) + CacheService flag
  run path (trigger / Run now): run lease → per-delivery short critical sections → Gmail (Tony)
```

### Lock boundaries (correction 1)
- **The run lease is not the script lock, and it is fenced.** A run holds a *run lease*: a `PropertiesService` record `{run_id, owner, expires, generation}` that is acquired and renewed inside brief `LockService.getScriptLock()` sections.
  - `generation` is a **monotonically increasing fencing token**, incremented on every acquire.
  - **Every claim, every state transition and every authorization** re-checks, under the script lock, that the worker's generation is still current.
  - A worker whose generation is stale **stops immediately**. It initiates no external action (no `createDraft`, no `send()`) and writes nothing further.
  - If a replacement worker finds a delivery in `sending`, it **reconciles** it and never sends it again.
- **Send authorization is the single cutoff point.** It is the `drafted → sending` transition, a short critical section under the script lock that:
  1. verifies the lease generation
  2. checks the suppression cache flag and the Inbox for this contact (both written only under the same lock)
  3. re-reads `Comms_Optouts`
  4. checks enrollment and branch status, pause and kill switches, and the owner guard
  5. writes `sending` + `send_invoked_at` and flushes

  The lock is released and **only then** is `draft.send()` called.
- **Ordering.**
  - Our own unsubscribe ingestion also takes the script lock, so it is strictly ordered against authorizations: recorded before → this delivery is cancelled; recorded after → this delivery may complete, and every later authorization is blocked.
  - Opt-outs that Comms writes from the portal project are seen at the next authorization's `Comms_Optouts` read (best-effort ordering for that external source).
- **The script lock is held only for short critical sections:**
  - claiming one delivery
  - one state transition (Journal append + main-sheet apply + `flush()`)
  - one ingest append
- **Permitted inside the lock:**
  - `SpreadsheetApp` reads and writes on the engine spreadsheet, the Journal spreadsheet, and the `Comms_Optouts`/`Comms_Log` spreadsheet
  - `PropertiesService`
  - `CacheService`
- **Never permitted inside the lock:** `GmailApp`, `DriveApp`, `UrlFetchApp`.
- **Latency is measured.** The permitted operations are remote calls, so they count toward critical-section latency. Phase 0 measures lock-hold p50/p95 per section type. Budget: **p95 < 2 s**; a breach is a Phase 1 blocker.
- **Fencing limit (stated contract).** A stale worker cannot obtain a new authorization or commit any state change. **A Gmail call that was already authorized may still complete** after the worker loses its lease, because Gmail does not check our token. That delivery stays in `sending`/`reconcile` and is unavailable for another send. Human **Resend** is gated by quiescence (see State machines).
- **Stop requests have their own durable path.**
  - `ee_unsubscribe`, `ee_track` and the form/reply events append to an **Inbox** sheet (append-only).
  - Unsubscribes also append to `Comms_Optouts` and set the CacheService key `sup:{email_norm}` (6 h).
  - The request returns only after the append has been flushed. Ingest waits on the script lock only, which is never held across a send.
- **Pre-send gate.** Immediately before draft creation, *and again* immediately before `send()`, the run checks for that contact:
  - the CacheService suppression flag
  - the Inbox (TextFinder on `email_norm` / `contact_id`, rows newer than the run's last-processed cursor)
  - `Comms_Optouts`
  - the enrollment and step status
  - the pause and kill switches

  **A recorded stop therefore blocks every send authorization that comes after it** (the cutoff defined above), even while a run is mid-loop. The run also folds Inbox rows into enrollment state at start and between sends, so a pending stop is processed first.

### Journal: the authoritative ordered record (R4-1)
- **Authority.** The **Journal** (a separate spreadsheet file, append-only, hash-chained: each record stores `prev_hash`) is the **authoritative, ordered record**. The main spreadsheet is its **materialized state** and read model.
- **Every state change** is: Journal append → apply to the main sheet → advance the checkpoint. All three happen inside one short critical section.
- **Stable operation IDs.**
  - Every operation carries an `op_id` generated *before* its first attempt. Ingest uses the request nonce or `event_id`; transitions use `delivery_id` + target state + attempt.
  - **Uncertain append (lost acknowledgement):** before retrying, look up `op_id` in the Journal (TextFinder). If found, treat it as appended; never append twice.
- **Applied checkpoint.**
  - `applied_seq` (stored in the main sheet's `Meta` and mirrored in PropertiesService) advances **only after** the main-sheet write for that `journal_seq` has flushed.
  - Each materialized row stores `last_seq`, and apply skips any record with `seq ≤ last_seq`, which makes replay idempotent.
- **Catch-up before acting.**
  - A worker that acquires the lease **replays all outstanding records** (`applied_seq` < Journal head) **before** any claim or authorization.
  - Every authorization section re-checks that `applied_seq` equals the head.
  - A record written as `sending` but never applied becomes `sending` on replay, and is then reconciled. **Restarting the engine can never make an authorized delivery eligible again.**
- **Gmail only after both writes.** The worker calls Gmail only if the Journal append **and** the main-sheet apply both succeeded. If the apply failed, it aborts without calling Gmail. Replay then materializes `sending`, which goes to reconcile and then `unknown` ("authorized, no evidence").
- **Secondary writes are Journal-driven.**
  - An unsubscribe record carries `secondary: comms_optouts`. The applier appends to `Comms_Optouts` with the `op_id` in its `source` column (checking for that `op_id` first, so it's idempotent), then journals `secondary_applied`.
  - Replay re-applies any secondary write that was interrupted.
- **Fail closed.**
  - If the Journal can't be read, the head can't be determined, or replay finds a gap, a hash mismatch or an unknown record type, the engine **pauses itself**: no authorizations, plus an alert.
  - **Unsubscribe while the Journal is down:**
    - The request writes directly to `Comms_Optouts` and the `sup:prod:` cache, and records an `ingest_fallback` entry in PropertiesService. It reports success only if at least one durable store recorded it.
    - Sending stays closed until the Journal is healthy and the fallback entries have been journaled.

## Domain model (engine spreadsheet)
- **Contacts** (a person):
  - Identity: `contact_id, email_norm, alt_emails`
  - Details: `first_name, last_name, phone, address, language`
  - Bucket: `bucket, sub_bucket, tags, review_status`
  - Flags: `is_test, pool_school, pool_school_date`
  - Links: `source, quote_id, pool_id`
  - Anchor dates: `startup_date, startup_source, events_json`
  - Housekeeping: `created_at, updated_at`
- **Suppressions** (person level, by scope):
  - Scope `all`: unsubscribe-all, hard bounce, repeated soft bounce. Blocks every delivery.
  - Scope `marketing`: marketing-only unsubscribe. Blocks marketing deliveries only.
  - Read from `Comms_Optouts` (shared) and from the Inbox and CacheService (fresh), with a local mirror for audit.
- **Rulesets:** immutable published rule versions `{rule_rev, json, published_at, published_by}`. The draft editing state lives in `Sequences`/`Steps`.
- **Sequences:** `sequence_id, bucket, reentry: never|after_days:N|always, status`.
- **Steps:**
  - Identity: `step_id` (stable, never reused), `sequence_id, order, name, category (service|marketing), status (active|draft|retired)`
  - Audience: `audience_filter`
  - Timing: `anchor, event, month_day, offset, unit, repeat_every, repeat_count, window_days, max_hold_days` (default 2), `hard_deadline` (an offset relative to the anchor, optional)
  - Rules: `requires`, `stop_rules` (see Stop model), `on_send_sub_bucket`
  - Content: `published_revision_id`
  - Concurrency: `rev`
- **Enrollments:**
  - Columns: `enrollment_id, contact_id, sequence_id, rule_rev, mode`
  - State: `status (active|waiting_anchor|paused|completed|stopped), enrolled_at, anchor_snapshot_json, stop_reason, stopped_at`
  - Branch state: `stopped_branches` (e.g. `["marketing"]`)
- **Deliveries:**
  - Identity: `delivery_id`, `delivery_token` (full UUID v4 with prefix, for example `dlv_3f2b…`; written **before** draft creation), key `{enrollment_id}:{step_id}:{occurrence}`, `mode`
  - State: `state, attempt, lease_until, draft_id, message_id, thread_id, send_invoked_at`
  - Binding: `revision_id, shell_version, run_id`
  - Timing: `due_date, original_due_date, held_days, deadline`
  - Result: `sent_at, error, reconcile_notes`
- **Threads:** `thread_id, last_processed_message_id, last_scanned_at`. Replies are scanned per *thread*, not per delivery (correction 4).
- **Decisions:** scheduling outcomes (`due|held|skipped|suppressed|expired|waiting_anchor`), kept separate from delivery state. Only changes are logged.
- **Inbox:** stop/ingest requests, append-only: `inbox_id, type, contact_id, email_norm, delivery_id, payload, received_at, processed_at`.
- **Events** (raw observations, append-only, **one sheet per month** so reads stay bounded):
  - Columns: `event_id, gmail_message_id, delivery_id, enrollment_id, mode, type, link_id, received_at, seconds_since_send, method, ua_raw (90 d), ua_family, ip_prefix_hash (30 d), beacon_present, burst_count, source`
- **Engagement** (derived per delivery):
  - Columns: `classifier_version`, open/click/reply summaries with **confidence levels**, `scanner_like_hits`
  - Recomputable from Events when the classifier changes.
- **Runs, ChangeLog, Config** (operational, `config_rev`), **Fields**, **Permissions**, **SecurityAudit** (property-hash change log).

## Stop model (correction 3)
Three layers, evaluated separately:

| Layer | Trigger | Effect |
|---|---|---|
| **Person suppression** | Unsubscribe-all, bounce | Every delivery blocked; all enrollments → `stopped` |
| | Marketing unsubscribe | Marketing deliveries → outcome `suppressed`. **Enrollment continues**, and its service steps still send |
| **Enrollment termination** | bucket change, conversion, `prerequisite_expired`, manual, completion | The enrollment ends |
| **Branch / step stop** | Per-step `stop_rules: [{signal, min_confidence, stops: enrollment|marketing_branch|[step_ids]}]` | Only the named branch or steps stop |

- **B (all marketing):** a reply, a high-confidence click or a form submit on any B step stops the `enrollment`.
- **C:**
  - Maintenance Invitation: a high-confidence click or form submit stops the **`marketing_branch`**, so no further maintenance pitches. Progress and Final Transition (service) still send.
  - A reply to any C email stops nothing; it's flagged to Tony as a customer conversation.
  - A marketing opt-out suppresses the Maintenance Invitation only.

## State machines
**Enrollment:** `waiting_anchor ⇄ active → completed | stopped`, plus `active ⇄ paused`. Branch stops live in `stopped_branches` and don't change `status`.

**Delivery: retry vs. reconcile by stage (correction 2):**
```
Stage A: preparation (nothing has reached Gmail's send path)
  claimed: delivery_token persisted + flushed
     │  render; createDraft(token in body)
     ▼
  drafted: draft_id persisted + flushed
  A transient error in Stage A is retried safely (max 3, backoff).
  Recovery of a stale 'claimed': search drafts for the token → delete any orphan → back to eligible.

Stage B: send invoked (outcome may be ambiguous)
  sending: persisted + flushed, send_invoked_at set
     │  draft.send()
     ├─ returns message → Stage C
     └─ exception / timeout / execution killed → reconcile   (NEVER back to eligible)
  reconcile (Sent searched after grace G = 2 min, again after G2 = 15 min; set from spike 2b, where every message was searchable within 8.5 s):
     token found in Sent → sent (capture message_id / thread_id)
     not found after G2 (draft present or not) → unknown (human: Mark sent / Resend / Cancel)
     A delivery that has been in `sending` NEVER returns to automatic eligibility.
  Human Resend (quiescence gate, R4-2):
     allowed only when BOTH hold:
       - now ≥ authorized_at + max execution lifetime (6 min) + safety margin (30 min)
       - the Sent search after G2 found nothing
     Before then, the button is disabled with the time it unlocks ("an earlier attempt could still be running until 10:42").
     After quiescence, the UI still says "Gmail may have accepted the earlier attempt; check Tony's Sent folder".
     Resend journals a new attempt with a new token, then passes the full pre-send gate.
  A stale worker (lease generation superseded) cannot move any delivery out of `sending`;
  only the current worker's reconcile, or a human, can.

Stage C: accepted (Gmail returned the message)
  sent: message_id / thread_id written. A bookkeeping write failure retries the BOOKKEEPING only
        (message ids kept in a PropertiesService journal until written). Never resent.

Any resend (automatic or human) first passes the full pre-send gate:
  suppression (all sources) · enrollment + branch status · step not retired · bucket unchanged ·
  revision not revoked + integrity hash · pause / kill switch · owner guard · mode.
  If any check fails → cancelled (draft deleted).
```

## Scheduling semantics (correction 8)
- **Clock.** `decide({now, tz:'America/Chicago', rulesets, contentMap, snapshot})` is pure. Dates are local calendar dates, so DST never moves a date. A business day is Mon–Fri minus the Config `holidays`.
- **Send times (Mau, 2026-11-11).** Every delivery has a local send time (`HH:MM`, America/Chicago, 15-minute steps): the enrollment's `send_time` (copied from the batch that started it) or else the campaign default (Config `send_time_<bucket>`, default 09:00). Dates are unchanged: `decide()` still plans calendar days, and its optional `time` input gates the day: a delivery whose day has come is `due` only once `time ≥ send_time`, otherwise `upcoming: later_today`. A delivery from an earlier day (held, missed) waits for its time on the current day. Without `time` (simulation, old callers) there is no gate. The one-per-day limit, windows and deadlines are unchanged.
- **Runs at send times.** A scheduler trigger just after midnight works out the day's run times (each campaign's default, the send times of active enrollments, and batches starting that day; only times still ahead) and installs one one-off trigger per time, at most 12 a day (Apps Script allows 20 triggers per user per project; the rest are kept for the scheduler, Run now and resumes). It writes the day's plan to Config `run_plan` so the page shows it. Changing a default or saving a batch re-runs the scheduler. A scheduled run uses its planned slot as the gate time when its trigger fires early (up to 20 min), so early firing never skips a send; a missed run is caught by the next one that day. Run now gates by the real time. Precision of one-off triggers is measured before go-live (CP7 spike).
- **Per-send overrides (Campaigns calendar).** A person can change one planned send (delivery key): **skip** (never sent; a later step that `requires` it chains from the date it was due), **move** (to a date from its due date to its last send day; the time gate still applies), **next_run** (sent by the next run whatever its date or time, only once its prerequisite is sent and while its window is open), or **clear**. Stored in the engine's `Overrides` tab (one row per key, latest wins; written under the lock and logged in ChangeLog with the user, like Holds). `decide()` takes them as `overrides`; an override on a sent or in-flight delivery has no effect.
- **Planned sends on the page** come from the same `decide()`: the read model runs it over the current enrollments plus simulated enrollments for planned batches (picked people, or one weighted placeholder for "pick on the day"), for the next 60 days (`view=plan`). The page never works out dates itself.
- **Restarts.** A batch may name people who already finished or stopped the campaign (`restart_ids`, people chosen now only). Starting the batch marks them `restart_ok`; the planner's `decideEnrollment` enrolls them again (`restart_by_operator`, new enrollment id) and clears the mark. Someone with an active enrollment is never restarted. Automatic re-entry stays off.
- **Rule versions.**
  - Each enrollment follows its own `rule_rev`.
  - Publishing a change creates a new ruleset revision and asks for its scope: **"apply to active enrollments"**, which migrates their `rule_rev` (unsent steps re-plan), or **"new enrollments only"**, which leaves existing ones on their old `rule_rev`.
  - `decide()` evaluates each enrollment under its own revision.
- **Run snapshot.** At run start the run captures the ruleset revisions **and the published-content map**. Every claim in the run binds content from that snapshot, and publishes take effect on the next run. Rules and content therefore change together, at run boundaries.
- **"Previous"** means the actual send date of the `requires` step. Holds and late sends shift chained steps; startup- and event-anchored steps don't move.
- **Collision priority:** earliest `original_due_date`, then lower `order`. A held delivery outranks newly due ones (no starvation).
- **Holds:**
  - A hold extends the window by at most `max_hold_days`.
  - `hard_deadline` is absolute (for example, Welcome must send no later than startup − 1). Past it, the outcome is `expired` regardless of holds.
  - Nothing stays eligible forever.
- **Expiry:** the outcome is `expired`, and steps that `require` it expire too. If no sendable steps remain, the enrollment stops with `prerequisite_expired` and is flagged.
- **Missing anchor:** `waiting_anchor`. The engine never guesses.
- **Anchor moves:** unsent deliveries re-plan; sent ones are never re-sent. If an anchor moves after a step was sent, the Activity tab flags it.

**Worked examples** (unit tests):

| # | Situation | Expected |
|---|---|---|
| 1 | B confirmed Mon Oct 26 | Intro Oct 26 (Day 1) → Follow Up Oct 30 → Check-In Nov 8 |
| 2 | Intro sent late, Oct 28 | Follow Up Nov 1 |
| 3 | Intro blocked 8 days (window 7) | Intro `expired`; Follow Up / Check-In expired; enrollment `stopped: prerequisite_expired`, flagged |
| 4 | C startup Oct 28 | Welcome due Oct 25; hard deadline Oct 27 |
| 5 | Startup moved to Nov 4 before Welcome | Welcome Nov 1; Progress Nov 11, 18, 25, Dec 2 |
| 6 | Startup moved after Welcome sent | No re-send; Progress re-planned; Activity flag |
| 7 | Startup Sep 28 collisions | Progress #3 Oct 19, Maintenance Oct 20; Progress #4 Oct 26, Final Transition Oct 27 |
| 8 | Comms emailed the contact today (local) | Lifecycle delivery held to tomorrow (best-effort) |
| 9 | C without a startup date | `waiting_anchor` |
| 10 | D confirmed Fri Oct 23 | Personalized Intro Mon Oct 26 |
| 11 | Follow Up +4 → +6 published "active enrollments", Intro sent Oct 26 | Follow Up Nov 1. With "new enrollments only": Oct 30 |
| 12 | Contact returns to B | No new enrollment; Needs review |
| 13 | Welcome held 2 days in a row by collisions/Comms (max_hold 1, matching the matrix) | Expires at the hold cap or hard deadline (startup −1), whichever comes first; flagged |
| 14 | C marketing opt-out | Maintenance `suppressed`; Progress ×4 and Final Transition send |
| 15 | High-confidence click on Maintenance | No further marketing C steps; Final Transition sends |
| 16 | Form submit from Maintenance | Same as #15 |

## Email matrix (all 15; B and C active in the MVP)
| Step | Bkt | Cat | Anchor → due | Window / hold / deadline | Requires | Stop rules |
|---|---|---|---|---|---|---|
| MCP x MCPS Intro | B | mkt | enrollment +0 | 7 / 2 / — | — | reply, click≥high, form → enrollment |
| MCPS Follow Up | B | mkt | previous +4 | 7 / 2 / — | Intro | same |
| Personal Check-In | B | mkt | previous +9 | 7 / 2 / — | Follow Up | same |
| Welcome Email | C | svc | startup −3 | 2 / 1 / startup −1 | — | — |
| Startup On the Way ×(startup days) | C | svc | **event** `startup_visit_started`, immediate | deadline +2 h after event | — | — |
| Startup Day Log ×(startup days) | C | svc | **event** `startup_visit_completed`, immediate | deadline end of next day | — | — |
| Startup Summary | C | svc | **event** `startup_completed` (last startup day), immediate | deadline +3 days | — | — |
| Startup Progress ×4 | C | svc | startup +7, every 7 | 3 / 2 / next occurrence −1 | — | — |
| Maintenance Invitation | C | mkt | startup +21 | 5 / 2 / — | — | click≥high, form → marketing_branch |
| Final Transition | C | svc | startup +28 | 5 / 2 / — | — | — |
| Referral Campaign | A | mkt | tbd | — | — | tbd |
| Reviews Request | A | mkt | event service_milestone +1 | 7 / 2 / — | — | reply, click≥high (via `/go` interstitial) → enrollment |
| Customer Newsletter | A | mkt | monthly 1st | 5 / 0 / month end | — | — |
| Personalized Intro | D | mkt | enrollment +1 bd | 1 / 1 / — | — | reply, click≥high, form → enrollment |
| Referral Follow Up | D | mkt | enrollment +5 bd | 2 / 1 / — | Personalized Intro | same |
| Inquiry Response | E | svc | event inquiry +0 | 0 / 0 / same day | — | — (needs hourly runs) |
| Proposal Follow-Up | E | mkt | event proposal_sent +2 bd | 1 / 1 / — | — | reply, form → enrollment |
| Reintroduction | F | mkt | enrollment +60 | 30 / 2 / — | — | reply, click≥high, form → enrollment |

- Every step: person suppression by scope applies; `bucket_changed` ends the enrollment.
- Content requirements:
  - B CTAs go to `/service`.
  - Welcome requires `StartupDate` + `Address` and uses `{{block:PoolSchool}}`. Attachment items: **Safety Guidelines** and **Startup Guide** (from the Attachment Library; these can be added after launch).
  - **Every email in this plan sends from Tony's address** (antonio@mcpoolsolutions.org), including the startup visit emails. On the Way names the tech in the body ("{{TechName}} is on the way").
    - The pool school date isn't known at Welcome time; it's booked from the Startup Summary. So the PoolSchool block says the customer will pick a time on their last startup day, and needs no date field.
  - Startup On the Way: fields `{{TechName}}`, `{{VisitDay}}` (1/2/3), `{{ArrivalWindow}}`.
  - Startup Day Log: fields `{{VisitDay}}`, `{{TechName}}`; dynamic attachment (or link) = that day's customer Startup Log.
  - Startup Summary: the email body is whatever template is assigned to this step (editable and approved like every other email). Dynamic attachment = the **3-1 report**, a summary of the 3 startup days that the portal builds from the three Startup Day Logs. CTA = pool school booking link (first-party, so clicks can be browser-verified). The 3-1 report's layout is portal work in CP8.
  - Progress subjects include the week number (to avoid threading).
  - No task lists anywhere.

## Event-triggered emails (C startup visits; CP8)
- **Two kinds of steps.** *Scheduled* steps are planned by `decide()` and sent by runs. *Event* steps are sent because something happened in the portal. Both use the same templates, approval, revisions, Journal, delivery stages, suppression, tracking and timeline.
- **Ingest.** The portal posts a signed `ee_event` (relay pattern: HMAC + ts + nonce):
  - `{event_type, event_id, contact or pool_id, visit_id, occurred_at, fields{…}, attachments[drive_file_id…]}`
  - Event types: `startup_visit_started` (tech taps On My Way), `startup_visit_completed` (tech submits the startup log), `startup_completed` (last startup day closed).
  - The event is journaled and goes to the Inbox, and the request returns.
- **Identity.** The occurrence is the `visit_id` (or `event_id`), so the delivery key is `{enrollment}:{step}:{visit_id}`. A double tap, or a retried event, can never send twice.
- **Immediate delivery.**
  - If no run holds the lease, the ingest schedules a one-shot worker (`ScriptApp…after(~1 s)`) that takes the fenced lease and processes event deliveries only.
  - If a run is in progress, it **pulls event deliveries first**, at its next loop iteration.
  - Same authorization cutoff, same pre-send gate.
  - **Latency target:** On the Way sent within 2 min of the tap (p95). This is a CP8 gate.
- **Deadlines.** Every event step has a hard deadline: On the Way +2 h, Day Log end of next day, Summary +3 days. A late event expires and is flagged rather than sending stale news (no "on my way" at 6 pm).
- **Rules.**
  - Event steps are category `service`. They are exempt from the 1-per-day frequency limit and don't consume it.
  - They are blocked only by scope-`all` suppression. A blocked On the Way is flagged in the portal so the tech can call or text instead.
- **Dedupe with HeadsUp.** For a pool with an active C enrollment and a `startup_day_N` visit, the portal routes On My Way to the engine. `HeadsUp.js` keeps handling every other visit. This is a portal change, listed under Deployment.
- **Content lives in the portal; the engine only delivers it.** New portal work in CP8:
  - **Customer Startup Log:** designed for startups, built from the tech's startup checklist data (`StartupChecklists.js`), rendered to a PDF in a startup-logs Drive folder.
  - **Startup Summary report:** built from the startup days' logs.
  - **Pool school booking page:** first-party and token-signed. It writes `pool_school_date` and posts an `ee_event pool_school_scheduled`; a confirmation and a reminder can be added later as event steps.
- **Missing data.** A required event field that is missing (e.g. no `TechName`) → `blocked` + an immediate alert, because these emails are time-sensitive.

## Attachments (part of the versioning contract)
- **Static attachments live in an Attachment Library** (Mau, 2026-11-02), so PDFs can be added later and revised without re-approving every email.
  - Each library item (e.g. "Safety Guidelines", "Startup Guide") has its own immutable **versions**:
    - copied into `Attachments/{item}/v-N.pdf`, view-only, with a `sha256`
    - each version records its uploader, approver and approval time
  - Uploading a revised PDF creates a pending version. Approving it (the `approve_publish` capability, with the two-person rule if it's on) makes it the item's published version.
  - **Emails reference items, not files.** A step's revision lists `attachment_items`, so approving the email approves *which* items it carries. The item's published version is bound from the **run snapshot** at claim time, exactly like content, and the delivery records `attachment_versions` + hashes.
  - **Emails don't need attachments to go live.** Welcome can launch without its PDFs. Adding an item to an email later is an ordinary email edit and needs re-approval; revising a PDF that's already attached needs only the PDF's approval.
  - **Rollback:** re-publish an older version as a new version (history is kept). Retiring an item removes it from future sends; any email that still references it shows a warning in the wizard.
  - **UI:** an Attachments panel in the Emails tab (upload, versions, approve, roll back, "used by" list) and an attachment picker in the wizard's Content step.
- **Dynamic attachments** (Day Log, Summary report) come from the event payload as Drive file IDs.
  - The engine accepts only files inside the allowlisted portal output folders, ≤10 MB each, ≤20 MB per email.
  - It hashes each file at claim time, and the delivery records `attachment_hashes`.
- **Per step: "attach" or "link".** A link is a signed, tracked `/api/t/c` link to the file. It's lighter, avoids size limits and some spam filters, and shows opens of the document. Default: **attach** for the Welcome guides (Mau's preference); either works for logs and reports.
- **Integrity.** A hash mismatch, an oversize file or a file outside the allowlist means the delivery is `failed: attachment` and an alert fires. The email never goes out with a missing or altered file.

## Versioning contract
- **Immutable revision.** Approving publishes an immutable **Revision**:
  - Identity: `revision_id, step_id, rev_no, parent_revision_id`
  - Content: `subject, details_box`, body file per language (copied into `Revisions/`, view-only), `sha256` per file
  - Dependencies: `block_revision_ids`, `fields_snapshot`, `shell_version`
  - Approval: `editor, approver, approved_at, content_hash`
  - Status: `published|superseded|revoked`
- **Integrity.** Content is re-hashed at send; a mismatch makes the delivery `failed: integrity`.
- **Binding.** A delivery binds content **from its run's snapshot** at claim time.
- **Recovery.** A recovered draft keeps its bound revision **unless that revision is `revoked`**, in which case it is cancelled. Superseded content stays sendable, because it was approved.
- **Rollback** publishes a new revision whose parent points at the restored content.
- **Shell.** The shell is code (`SHELL_VERSION`, changed via PR), and the version used is recorded on each delivery.
- **Approval** requires the `approver` permission. When `require_second_approver` is on, the approver must differ from the editor.

## Cross-engine coordination
- **Shared key:** `email_norm` (lowercase + trim).
- **Suppression:**
  - Read fresh at both gates (see Lock boundaries).
  - Writes are append-only to `Comms_Optouts`, so no lost updates.
  - If the source is unreadable, nothing sends (`suppression_unavailable`, alert).
- **Frequency with Comms:** same local calendar day check against `Comms_Log`. Best-effort, as stated in Decisions and shown in the UI.
- **Quota:** separate mailboxes (Comms bulk uses the portal's account; lifecycle uses Tony's). The engine re-reads `MailApp.getRemainingDailyQuota()` before each send and stops at a reserve (Config `quota_reserve`, default 20). That quota counts only script-sent mail on Tony's account, not the mail Tony sends himself, so the reserve only keeps room for the engine's own alerts (corrected 2026-11-02: the original 200 blocked every send on Tony's account).
- **Phase 0:** confirm `Comms_Optouts` and `Comms_Log` exist live. If they don't, ask before creating tabs.

## Tracking: evidence and confidence (corrections 4 + 5)
- **Raw observations are kept and never overwritten.** The classifier is versioned, and Engagement is recomputed when the classifier changes.
- **Opens:**
  - Every pixel request is stored with `seconds_since_send`, `ua_family` and proxy type.
  - Confidence:
    - low: very early, or a known prefetch proxy such as Apple MPP
    - medium: a Gmail or other image proxy
    - nothing higher: no open is ever "proof"
  - The UI shows "Opened (estimated)" with confidence breakdown, unique and total counts, and first and last times.
- **Clicks:**
  - Signals: redirect hits (with `seconds_since_send`, method, UA, burst count), plus the **landing-page beacon** (`beacon_present`).
  - Confidence:
    - high: browser-verified, meaning a beacon from a first-party landing with a normal UA, with no burst
    - medium: a redirect hit that isn't scanner-like
    - low: HEAD requests, scanner UAs, bursts, or very early hits
  - Labels say "Browser-verified click", never "human".
  - Stop rules require `min_confidence: high`.
- **CTA coverage:** only **first-party** CTAs can drive stops. External destinations (such as a Google review link) go through a first-party `/go/<link_id>` interstitial that fires the beacon and then redirects. That's needed for A Reviews; B and C CTAs all point at `/service`.
- **Durability:**
  - Beacons are sent synchronously with 3 retries, then queued in localStorage for the next visit.
  - **If the visitor closes the page and never returns, that click is lost.** This is accepted and documented: the worst case is that the next B step sends, while reply and form stops still work. The future fix is to move ingestion to a durable queue (Vercel Queues).
- **Replies (precedence is explicit):** for each new Gmail message in a scanned thread, dedupe by `gmail_message_id` (one event per inbound message, ever), then check in order:
  1. From Tony or his aliases → ignore.
  2. Mailer-daemon/postmaster, or a DSN content type → **bounce** path.
  3. `Auto-Submitted` ≠ `no`, `X-Autoreply`/`X-Autorespond`, `Precedence: auto_reply|bulk|junk`, or `cbLooksLikeAutoReply_` → **auto_reply** (no stop).
  4. From `email_norm` or `alt_emails` → **reply**.
  5. Anything else → **reply_other** (stops conservatively for marketing; flagged).
- **Shared threads:** an inbound message is attributed to the **latest delivery in that thread sent before the message's date**, and to that delivery's enrollment only. Per-thread cursors stop one message from becoming several stop decisions.
- **Tracking UI:**
  - **Per email:** funnel by confidence, a day-by-day table and chart, per-link breakdown, a scanner-like section, CSV export (permission-gated).
  - **Per delivery:** the raw event list.
  - **Per contact:** a timeline across enrollments.

## Read-path security (correction 6)
- **Every `op=read` request** (overview, contacts, drawers, tracking detail, reply snippets, exports) requires `Authorization: Bearer <portal token>`, never in the query string. It is validated by `validatePortalSession` and checked against the engine Permissions sheet (read directly by Vercel).
- **The service account is infrastructure access only.**
- **Redaction by permission:**

| Permission | Sees |
|---|---|
| Capability | Sees |
|---|---|
| `view_aggregates` | aggregates, contact names |
| `view_pii` | emails, addresses, reply snippets |
| `export` | CSV export |

  Redaction happens after cache retrieval (see Configuration & authorization for the role → capability map).
- **Caching:**
  - The server-side cache key is `dataset:range-set:data_version`, holding raw data in function memory only.
  - Per-permission views are computed per request, so there is never a shared cache entry for a filtered view.
  - Responses carry `Cache-Control: private, no-store` and `Vary: Authorization`. Nothing is CDN-cached.
- **Browser cache:**
  - localStorage keys are prefixed `mcps_lc:{username}:`.
  - `doLogout()` and any session-user change clear every `mcps_lc:` key; this is a small edit in `js/lib/auth.js`.
  - Cached payloads already follow the user's permission level.

## Security boundary & rollback (correction 7)
- **Trusted maintainers.** Tony (owner) and Mau (editor) can change code and Script Properties. This is accepted as the security boundary, and the app never claims "owner-only" enforcement for them.
- **Detection.** Each run hashes the security properties and logs any change to SecurityAudit, which also triggers an alert.
- **Portal users** are governed by app permissions only, and they can never reach security config.
- **Schema compatibility:** code declares `SCHEMA_READ_MIN..SCHEMA_READ_MAX`.
  - **Additive** migrations stay inside the range in both directions.
  - **Semantic** migrations (a field's meaning changes, state machine changes, config shape changes) use **expand → migrate → contract** across 3 releases:
    - In the expand release, code reads and writes both forms.
    - The rollback floor is declared per release, and the deploy script refuses a rollback below it.
  - Last-resort recovery is a backup restore.
- **Tested:** an additive migration rolled back one release, and a semantic expand/contract with rollback at each stage, each followed by a full run on the migrated data.

## Execution modes
- **Simulation:** `decide()` plus rendering, with no writes. Powers the wizard, the audience panels and the next-run queue.
- **Test delivery:**
  - Only to allowlisted recipients. Uses test contacts (`is_test`) with their own enrollments, deliveries and events (`mode=test`).
  - **Mode is never taken from the request.** It is derived from the signed delivery identity (the link HMAC covers the mode) and from the delivery row it resolves to.
  - **Isolation at every write boundary:**
    - **Unsubscribe and bounce:** test mode writes only to the engine's `Suppressions_Test`, never to `Comms_Optouts`.
    - **Cache keys:** `sup:{mode}:{email_norm}`.
    - **Inbox rows and event dedupe keys** include the mode.
    - **Replies and bounces** are attributed through the thread → delivery mapping, so the delivery's mode wins even when the address also belongs to a production contact.
    - **Production gates** read only production suppression sources.
  - The demo uses this mode.
- **Production:** requires `engine_enabled`, the owner guard, and the `operator` permission for Run now.
- **Triggers:** `EE_scheduleTrigger` (daily, just after midnight Central) → today's one-off `EE_timedRun` triggers at the send times (see *Scheduling semantics → Runs at send times*). Each run is recorded with `trigger: scheduled` and its `planned_for` slot. Nothing is installed until go-live (`eeInstall`, as Tony).
- **Time on screen:** every time the page shows is Central time with its zone ("Mon, Nov 23 · 10:31 AM CST"), the engine's local time, whatever the viewer's computer is set to.

## Configuration & authorization
- **Operational edits** (`ee_update_config`, step changes, activation) are:
  - validated by a server-side schema
  - checked for conflicts with `rev`/`config_rev` (409 on conflict)
  - previewed for impact: affected enrollments, newly due today, and 7-day volume before and after
- **Actor:** the username from the Vercel-validated session, carried in the signed relay. Every edit is written to the ChangeLog.
- **Permissions are explicit capabilities, with no inheritance.** A user can hold several roles; their capabilities are the union.

| Role | Capabilities |
|---|---|
| viewer | `view_aggregates` |
| editor | `view_aggregates`, `view_pii`, `edit_drafts`, `edit_contacts` |
| approver | `view_aggregates`, `view_pii`, `approve_publish`, `activate_steps` |
| operator | `view_aggregates`, `view_pii`, `export`, `run_now`, `pause`, `resolve_unknown`, `edit_config` |

- Redaction is keyed on `view_pii` (emails, addresses, reply snippets). Export requires `export`. Every `ee_*` action declares the capability it needs.

## Performance
- **Mandatory launch budgets.** Live sends and the Tony rollout are **blocked** until all of these pass, with auth included, at 2× the initial workload:
  - fresh overview read p95 < 1.5 s
  - cached paint < 500 ms
  - write acknowledgement p95 < 5 s
  - overview payload fetched from Sheets < 1 MB
  - engine run < 200 s
- **Fallback if a mandatory budget fails:**
  1. The engine writes a precomputed read-model sheet after each run and ingest batch, so reads become a single small range.
  2. If that still fails, move Events and Engagement to a Marketplace database. This needs Mau's approval, because it changes the "Sheets only" constraint.
- **Aspirational targets** (reported, not gating):
  - Page paint from cache: < 300 ms
  - Fresh read: p95 < 800 ms cold, < 150 ms warm (auth included)
  - Drawer: < 100 ms (prefetched)
  - Tracking detail: lazy, p95 < 800 ms
  - Wizard recompute: < 50 ms at 5k contacts
  - Write acknowledgement: p95 < 3 s, with an optimistic UI
- **Bounded backend cost:**
  - Reads touch only Contacts, Steps, Enrollments (active), Deliveries (last 60 days), the Engagement summary and the current Runs, **never raw Events**.
  - Reads request **only the columns each page shows**, with `prettyPrint=false` (spike 4: each halves the payload).
  - The tracking drawer's per-delivery event list comes from `Engagement.events_json` (the last 25 events, kept by the engine), not from raw Events (spike 4: one Events month is 6.3 MB at benchmark size). Raw Events are read only for re-classification and CSV export.
  - Events are monthly sheets; older Deliveries are archived to `Deliveries_YYYY` (spike 4: without archiving, the read grows to 7.8 MB / 1.5 s).
  - **Measured (spike 4, from a dev machine, at launch size):** overview 359 KB / ≤ 0.41 s; narrow columns 180 KB. Mandatory budgets met with wide margin; re-measured from Vercel at CP6.
  - **The benchmarks record bytes fetched and ranges scanned per op, as well as latency.**

## Operations
- **Workload model** (initial):
  - About 110 B and ≤40 active C enrollments.
  - Typical day: ≤40 sends and ≤1k events, with B bursts paced by a cap of 50/day.
- **Benchmarks:** a synthetic generator (5k contacts, 20k deliveries, 200k events) measures run duration, per-send overhead, read latency, bytes and ranges, and reply-scan cost.
- **Migration triggers:**
  - run > 150 s on 3 consecutive runs
  - an Events month > 100k rows
  - narrow overview payload > 1 MB (spike 4: about 3,000 contacts at the current shape), which means switch to the precomputed read-model sheet
  - read p95 > 1.5 s for 7 days
  - > 500 sends/day
  - Sheets 429 errors on more than one day a week
- **SLOs:**

| Objective | Target |
|---|---|
| Unsubscribe | journaled before the page returns; blocks every later send authorization |
| Due deliveries | attempted by 12:00 local |
| Successful run | at least one every 26 h |
| `unknown` / `reconcile` deliveries | resolved within 24 h |

  Owners: Mau primary, Tony secondary.
- **Independent heartbeat:** Vercel Cron runs daily at 10:00 CT. It reads the engine spreadsheet directly, alerts via portal GAS `ee_alert` (a different project and account), and shows a portal banner.
- **Retention:**
  - `ua_raw` 90 days. Raw IPs are never stored; a salted /24 hash is kept 30 days.
  - Links are stored as `link_id`. Events are kept 13 months, then aggregated.
  - Deliveries, Revisions and ChangeLog are kept 3 years.
  - Deletion requests purge PII, keeping a hashed suppression entry.
- **Journal coverage** (see *Journal* under Architecture for the protocol). It records everything needed to resume safely:
  - contact creates and changes
  - enrollment create, stop and branch stop
  - delivery claim and every state transition, with the full identity (contact, enrollment, step, occurrence, `revision_id`, `rule_rev`, token)
  - Inbox events (unsubscribes, form submits, replies)
  - approvals and revisions
  - config and permission changes
- **Backup / restore:**
  - Nightly copies of the main spreadsheet and the Journal, 30 kept. Each main backup records the `journal_seq` it includes.
  - **Restore:** pause → restore the main spreadsheet → **replay Journal records after the backup's `journal_seq`** (idempotent by record id) → verify `sent` deliveries against Sent tokens → resume.
  - **Accepted recovery-point loss:** only if the Journal itself is lost at the same time. Then the engine stays paused until a human rebuilds the state from Sent and the Inbox (runbook).

## Deployment
- **Portal changes:**
  - GAS: the `ROLE_ACCESS` page entry and the `ee_alert` action. Deploy via the memory procedure: diff live (including `BuilderReports.js`), `gas-verify` baseline/check, `clasp push --force` (fail on "Skipping push"), `clasp deploy -i <pinned>`. Rollback with `-V <prev>`.
  - Frontend: the `auth.js` logout cache-clear.
  - **CP8 portal changes** (shipped by the same safe procedure):
    - On My Way routing for startup visits of C-enrolled pools (`HeadsUp.js` caller)
    - the signed `ee_event` posts on startup log submit and startup completion
    - customer Startup Log + Summary report generation
    - the pool school booking page
- **Engine project setup** (proved in Phase 0):
  1. Tony creates the spreadsheet and its bound script.
  2. Tony shares them with Mau (editor) and the spreadsheet with the service account (viewer). Tony needs editor access to the Settings spreadsheet.
  3. Tony deploys the web app as "Execute as me".
  4. Tony runs `eeSetup`, `eeSetupDrive` and `eeInstall`.
  5. **Measured in spike 1 (2026-11-02): the web app runs as whoever deployed it last.** After Mau redeployed, it ran as `mauricio@`. After Tony redeployed the same code, it ran as `antonio@` again. So **Mau edits and pushes code, and every deploy is done as Tony.** Triggers run as the person who installed them (Tony's ran as `antonio@`).
  - **Project IDs** (created under antonio@ on 2026-11-02, spike code for now):
    - spreadsheet "MCPS Email Engine": `1mR0Y0dlJLgqh3Zbyg9bQ45S9JtZXWx7pzOSoEh6sNSk`
    - script: `1LTV5PyIU7_NqlPsGy6EZd0L5rgXUHzgPf9WGiBjEP2yq6iAQQWR6qZ78`
    - web app deployment: `AKfycby4cJlb1hFupST63Wdjp6R1EeURsSgCGbpqcKkfFfadLMKrbbjS7kzTB7STAyAZsBpx`
- **Guarded deploy** (`scripts/ee-deploy.mjs`):
  - Asserts that the scriptId and deployment id match the expected constants.
  - Syncs the rules file and checks its hash.
  - Runs `npm run test:ee`, then the schema range and rollback-floor checks.
  - Pushes with `clasp push --force` and fails on "Skipping push".
  - Deploys **as Tony**, using clasp's named login (`clasp --user tony deploy -i <deployment id>`, after a one-time `clasp --user tony login`). Pushing code can use either login.
  - Then calls `ee_whoami`/`ee_health` and asserts **both the new version and `effective_user = antonio@`**. If the identity is wrong, it immediately redeploys the previous version as Tony and fails loudly. A deploy made any other way (e.g. by Mau in the browser) is caught by the same check on the next run, and by the owner guard, which refuses to send.
  - `--rollback <v>` refuses to go below the rollback floor.
- **Tests:**
  - `npm run test:ee` = `node --test "tests/email-engine-*.test.js"` (Node 24 expands the glob; each file runs in its own process).
  - Discovery is proven by temporarily failing one file.
  - Concurrency and Gmail rows use the sandbox integration suite (`npm run test:ee:sandbox`, run in Tony's or a sandbox account).

## Build order
**Phase 0: discovery spikes (approved)**
1. Project creation, binding, ownership, web-app identity after a redeploy, trigger ownership.
2. Gmail send-boundary investigation in a sandbox mailbox:
   - `draft.send()` removes the draft.
   - **Interrupted sends:** execution killed mid-`send()` near the time limit, repeated N times.
   - **Delayed sends:** time from `send()` to appearing in Sent, and Sent-search indexing latency (sets G and G2).
   - **Orphan drafts:** crash between `createDraft` and saving `draft_id`; are they findable by token search?
   - `getHeader('Auto-Submitted')` and the precedence headers.
   - Execution-lifetime observations, to confirm the quiescence margin. (Settled: a surviving draft never permits an automatic resend. These results are operational guidance only.)
3. Concurrency:
   - An unsubscribe web-app call during a long run completes within the target.
   - **Lock-hold p50/p95** for each critical-section type (Journal append + apply + flush, claim, ingest), including the remote spreadsheet and properties calls.
4. Service-account read and bytes per op on a synthetic spreadsheet.
5. `Comms_Optouts` and `Comms_Log` exist live.
6. The Node test glob works.

**Phase 1: core contracts, no UI**
- `js/lib/lifecycle-rules.js` (`decide()`, rulesets, holds and deadlines, stop model).
- Engine:
  - data model and migrations
  - **the Journal:** `op_id`s, hash chain, `applied_seq` checkpoint, catch-up replay, Journal-driven secondary writes, fail-closed pause, unsubscribe fallback
  - fenced run lease plus short critical sections
  - Inbox ingest
  - the delivery stages, reconcile, and the quiescence-gated Resend
  - revisions and integrity; suppression and frequency
  - modes; owner guard and kill switch; SecurityAudit
- The fake harness, with **fault injection between every Journal append and main-sheet write**.
- Worked examples 1–16, and the failure matrix rows that can run without a mailbox.

**Phase 2: narrow B/C slice + Tony demo**
- B Intro and C Welcome revisions.
- `api/email.js` (authenticated reads with redaction) and the quotes merge; `/service` beacon.
- Minimal page:
  - Emails overview (no "When it sends")
  - Drawer: Audience, Template + history, and full evidence-graded Tracking
  - Activity: queue, Run now, reconcile/`unknown` resolver, runs, errors, heartbeat
  - Contacts: list, Needs review, timeline
- First, update the mockup to match.

**Phase 3: full B/C + wizard**
- The remaining bodies; the 5-step wizard (scope prompt, category, stop rules, holds and deadlines, impact preview, diff, 409 handling); config editing; Permissions view; ChangeLog UI.
- **Email editor in the wizard's Content step** (Mau, 2026-11-02: click-to-edit + HTML mode):
  - **Edit text (default; safe for Tony):**
    - Click any text in the live preview and type. Headlines, paragraphs, the Pool School block and button labels are editable.
    - The layout, images, links and the branded shell stay locked.
    - Merge fields show as chips that can be moved or deleted but not mistyped; a chip picker adds new ones.
    - Pasted text arrives as plain text.
  - **Edit HTML (advanced, for Mau):** a code editor beside the live preview, for changing layout or adding blocks and buttons.
  - **Both modes:**
    - Run the same `email-render.js` checks on every keystroke and show the errors inline (unknown field, missing block, unsafe HTML, non-https image).
    - Use "Preview as" to switch contacts (e.g. pool school vs. none).
    - Save a **draft** only. A draft goes live through approval as a new immutable revision, and the previous one stays in history for rollback.
    - Concurrent edits get the 409 conflict check.
  - **Locked in both modes:** the shell (logo, footer, address, unsubscribe) is code (`SHELL_VERSION`), not editable from the portal.

**Phase 4: after B/C are live (CP8+)**
- Contact sync (C from startup requests with live `Scheduled_Visits` dates; A, E, F) into Needs review.
- Bucket rules, attribution, image upload to Blob, `/go` interstitial, hourly runs, then E go-live. Durable ingestion queue if click loss proves material.

**Minimum runbook (a gate before production is enabled)** `email-engine/RUNBOOK.md` covers:
- pausing the engine or one bucket
- resolving `reconcile`/`unknown` deliveries, including quiescence and checking Tony's Sent folder
- Journal fail-closed recovery
- restore + Journal replay
- the owner-guard and lease-stuck procedures

**Fuller docs (after the slice):** `emails/README.md` (template syntax, revisions, adding steps), secret rotation, owner change.

## Failure acceptance matrix
**FG** = fake Gmail counting real `send()` invocations. **SB** = sandbox mailbox integration (counts messages in Sent by token). **API** = Vercel handler tests.

| # | Scenario | Expected | Test |
|---|---|---|---|
| 1 | Gmail accepts, process dies before `sent` is written | Reconcile finds the token in Sent → `sent`; **external count = 1** | FG+SB |
| 2 | Dies after `drafted`, before `send()` | Stage A recovery; one send after the full gate | FG+SB |
| 3 | Dies after `createDraft`, before `draft_id` is saved | Orphan found by token and deleted; exactly one later send | FG+SB |
| 4 | `send()` throws or times out | → `reconcile`, **never eligible**; resolved by evidence or human | FG+SB |
| 5 | Delayed send (appears in Sent after the timeout) | Reconcile waits G/G2 and finds it; no duplicate | SB |
| 6 | Draft gone, token not in Sent | `unknown`; no automatic action; alert | FG |
| 7 | Trigger and Run now overlap | Run lease refuses the second; count unchanged | FG+SB |
| 8 | Resume trigger fires twice | The second refuses the lease, or finds claimed rows | FG |
| 9 | **Unsubscribe for a later recipient during a multi-contact run** | Recorded within target; that recipient gets no further email | **SB** |
| 10 | Unsubscribe after `send()` returned | That send stands; no further sends | FG |
| 11 | Suppression unreadable | 0 sends; alert | FG |
| 12 | Content published mid-run | The run binds snapshot content; the new content applies next run | FG |
| 13 | Rules published mid-run | Snapshot rules this run; per-scope re-plan next run | FG |
| 14 | Revision file altered | `failed: integrity`; no send | FG |
| 15 | Recovered draft after retire / bucket change / pause / revoke / opt-out | Cancelled; draft deleted | FG |
| 16 | Contact exits and re-enters B | No new enrollment; Needs review | FG |
| 17 | Startup moved after Welcome | No re-send; re-plan | FG |
| 18 | C marketing opt-out | Maintenance suppressed; service steps send | FG |
| 19 | Maintenance high-confidence click / form | Marketing branch stopped; Final Transition sends | FG |
| 20 | Out-of-office from the contact's own address | `auto_reply`; no stop | FG |
| 21 | One reply in a thread shared by 2 deliveries | One event, attributed to the latest prior delivery | FG |
| 22 | Tracking request duplicated / forged / scanner-like | Deduped / 400 with no event / low confidence, no stop | API |
| 23 | Beacon lost (page closed) | No stop; next B step sends (documented limitation) | API+FG |
| 24 | Comms sent today (same local day) | Held (best-effort) | FG |
| 25 | Hold cap or hard deadline reached | `expired`; flagged | FG |
| 26 | Quota or cap hit mid-run | Clean stop; continues next run | FG |
| 27 | Non-owner identity | Refuses; 0 sends | FG |
| 28 | Test-mode click or reply | Only the test enrollment changes | FG |
| 29 | Kill switch | 0 sends; simulation works | FG |
| 30 | Concurrent step edits | 409 | API |
| 31 | Read without a token / as viewer / logout | 401 / redacted fields / `mcps_lc:` cache cleared; headers `private, no-store` | API+UI |
| 32 | Rollback after an additive migration, and at each expand/contract stage | Full run passes; deploy refuses below the floor | FG |
| 33 | Security property changed | SecurityAudit entry + alert | FG |
| 34 | Backup restored mid-week | Paused until replay and reconcile finish; no duplicates | SB |
| 35a | **Stale worker before authorization:** A stalls while preparing, its lease expires, B takes over, then A resumes | A's generation check fails at authorization: no new `send()`, no writes; **external count unchanged** | **SB** + FG |
| 35b | **Stale worker after authorization, before Gmail:** A is paused after `sending` is committed and its lease expires; B takes over; then A resumes and calls Gmail | Per the contract, A's already-authorized send **may complete** (count ≤ 1). A's later `sent` write is rejected (stale generation). B sees `sending`, reconciles, and finds the token in Sent → `sent`. No second send; Resend stays disabled until quiescence | **SB** + FG |
| 36 | Unsubscribe recorded **before** authorization | That delivery is cancelled (draft deleted) | SB |
| 37 | Unsubscribe recorded **just after** authorization | That delivery may complete; every later authorization for the contact is blocked | SB |
| 38 | Unsubscribe **during the Gmail call** | Same as #37; logged as "in-flight at opt-out" | SB |
| 39 | **Restore after post-backup activity:** new contact + enrollment, a successful send, then a form stop, all missing from the restored backup | Journal replay restores the contact, enrollment, `sent` delivery and stop; no duplicate enrollment or delivery; the stop holds | SB |
| 40 | **Test isolation:** a test delivery to an address that also belongs to a production contact gets an unsubscribe, a bounce, a click and a reply | Production `Comms_Optouts`, the `sup:prod:` cache, production enrollments and production engagement are all unchanged | SB + API |
| 41 | Interrupted after `sending` (no evidence in Sent) | `reconcile` → `unknown`; never automatically eligible | FG + SB |
| 42 | **Fault between Journal append and main-sheet write**, injected at each transition (claim, drafted, **sending**, sent, enrollment create, branch stop, unsubscribe, approval) | After restart, catch-up replay materializes the journaled state before any claim. An authorized delivery is never eligible again; state is consistent | FG |
| 43 | Journal append succeeded but its acknowledgement was lost | The retry finds the `op_id` and doesn't append twice | FG |
| 44 | Journal unreadable, or hash chain broken, or a seq gap | The engine pauses itself, with no authorizations, and alerts. An unsubscribe is still recorded via the fallback (`Comms_Optouts` + cache) | FG |
| 45 | `Comms_Optouts` secondary write interrupted | Replay applies it exactly once (`op_id` in `source`) | FG |
| 46 | Human Resend before quiescence | Refused, with the unlock time shown; allowed after quiescence and a clean Sent search | FG + UI |
| 47 | Tech taps On My Way twice (or the event is retried) | One email (occurrence = `visit_id`) | FG + API |
| 48 | Event arrives while a daily run holds the lease | Pulled ahead of scheduled deliveries; sent within the latency target | SB |
| 49 | Event arrives with no run active | A one-shot worker takes the fenced lease and sends; p95 < 2 min | SB |
| 50 | On the Way event processed after its 2 h deadline | `expired`, flagged; never sent late | FG |
| 51 | Startup visit for a contact with scope-`all` opt-out | Not sent; the portal shows "call or text instead" | FG |
| 52 | Same startup visit through HeadsUp and the engine | Portal routing sends exactly one On My Way | API |
| 53 | Static attachment changed in Drive after approval | `failed: attachment`, no send, alert | FG |
| 54 | Dynamic attachment outside the allowlisted folder, or oversize | Rejected; `failed: attachment`; alert | FG |
| 55 | Event steps on a day a scheduled C email is due | The event email doesn't consume the 1-per-day limit; the scheduled one still sends | FG |
| 56 | A new Safety Guidelines version is approved mid-run | This run's deliveries carry the snapshot version; the next run carries the new one; each delivery records which | FG |
| 57 | Welcome is approved and live with no attachment items | Sends normally; adding the items later requires the email's re-approval; revising an attached PDF needs only the PDF's approval | FG |
| 58 | A scheduled run's trigger fires early (within 20 min of its slot) | Gates at the slot time; the slot's sends go out; recorded with `planned_for` | FG |
| 59 | A scheduled run never fires | The next run that day sends what was due (time already passed); if none, tomorrow's run at that email's time; windows still apply | FG |
| 60 | More than 12 distinct send times in a day | The scheduler installs the 12 earliest still ahead, alerts `too_many_send_times`; later sends wait for the next run | FG |
| 61 | A batch saved for today with a time already past | It starts and sends on a run scheduled right away (now + 1 min) | FG |
| 62 | An override on a delivery that is already sent or in flight | No effect; nothing re-sent | FG |
| 63 | Move outside the email's window, or next_run before its prerequisite is sent | Refused by the engine (and greyed out on the page); the planned send is unchanged | FG |
| 64 | Restart requested for someone whose enrollment is still active | Skipped (`still_in_sequence`); their current sequence continues | FG |

## How changes work later
| Change | Where | Code? |
|---|---|---|
| Copy | Wizard → draft → approve (immutable revision) | No |
| Timing, stops, audience | Wizard, with impact preview and scope ("active" vs "new enrollments") | No |
| Add / retire a step | Wizard (never delete) | No |
| Start a bucket | Approve revisions, activate steps | No |
| Pause | Activity switches | No |
| Undo content | History → Roll back | No |
| Sender, secrets, two-person rule | Script Properties (trusted maintainers; changes audited) | No |
| Merge field | Fields registry | No |
| Brand / footer | `SHELL_VERSION`, via PR | Yes |

## Verification
1. **Phase 0:** a written spike report with measured G/G2, the interrupted-send results, lock-wait timings, and bytes per read. The guarantees section is updated to match the findings.
2. `npm run test:ee` (discovery proven) and the sandbox suite pass. All matrix rows (1–46, including 35a/35b; plus 47–55 by CP8, 56–64 by CP7) pass, and the existing `tests/` still pass.
3. `vercel build` + node import of `api/email.js` and `api/quotes/index.js`. Quote flows work on preview. The performance targets are measured (latency, bytes, ranges) and either met or reported with their gap.
4. **Demo (test-delivery mode):**
   - 3 test contacts; approve the B Intro and C Welcome (with revision history).
   - Run now; branded mail arrives.
   - A browser-verified click stops B; a scanner-like hit doesn't.
   - A reply stops; an out-of-office doesn't.
   - An unsubscribe during a run blocks every later authorization.
   - **Interrupted execution causes no automatic duplicate.** The delivery ends `sent`, `reconcile` or `unknown`, according to the evidence.
   - Running twice gives the same external count.
5. **Mandatory performance budgets pass.** This is a launch gate; aspirational targets are reported separately.

## Plan changes
Every change to this plan gets a dated line here (use `/email-engine tweak "<change>"`).
- 2026-10-29: Plan approved (third review, 9.3/10: approved to build through the sandbox B/C slice). Priority set to MCP Legacy (B) + MCP Startup (C); resume protocol and checkpoints CP0–CP10 added.
- 2026-10-29: **C startup visit emails added** (Mau): Welcome gets Safety Guidelines + Startup Guide attachments; each startup day sends On the Way + a customer Startup Day Log; the last startup day sends a Startup Summary (summary report + pool school scheduling). Added: *Event-triggered emails* and *Attachments* sections, 3 C event steps in the matrix, failure rows 47–55, and CP7 split into `bc-scheduled` → `startup-events` → `bc-live` (CP11+ for other buckets). Event-triggered sending pulled forward from Phase 4. Welcome's PoolSchool block no longer needs a date. Sandbox slice (CP4–CP6) unchanged. Open: what the "3-1 report" is and what else the summary contains; who the startup emails come from.
- 2026-11-02: Answers from Mau: the "3-1 report" is the 3-day startup summary (portal-built from the three day logs); the Startup Summary email's other contents come from its assigned template; **every email sends from Tony's address**; PDFs live in an **Attachment Library** with their own versions and approvals, so they can be added after launch and revised without re-approving each email. Added failure rows 56–57; CP7 no longer requires the PDFs.
- 2026-11-02: Phase 0 spike results (SPIKES.md). Grace periods set to G = 2 min, G2 = 15 min (spike 2b). Recovery must treat `getDraft(missing)` as throwing (spike 2a). Timing-based kills couldn't interrupt a call (spike 2c), so the sandbox rows for interrupted sends and orphan drafts (1, 3, 4) use deterministic fault injection. Unsubscribe ordering held 6/6 and lock-hold p95 is inside the 2 s budget (spike 3); authorize is the section to watch. Settings spreadsheet = "Chem Log", `1WdmY9qUqlvA7Xswmf8K8n0FYP02FKEBxM7Zd_V5Er_U`, with both `Comms_Optouts` and `Comms_Log` present (spike 5). Guarantees unchanged.
- 2026-11-02: Spike 1 result: the web app runs as whoever deployed it last. Every deploy is now done as Tony (clasp named login), and the deploy script asserts `effective_user = antonio@` after each deploy, rolling back if wrong. Engine spreadsheet, script and deployment created under antonio@; IDs recorded under Deployment.
- 2026-11-02: Spike 4 results: at launch size every page read is ≤ 360 KB and ≤ 0.41 s, so the mandatory read budgets are met. Reads now request only the columns each page shows, with `prettyPrint=false`; the tracking drawer reads per-delivery events from `Engagement.events_json`, never raw Events; Deliveries archiving is required; new migration trigger: narrow overview > 1 MB (~3,000 contacts). Guarantees section notes that Phase 0 confirmed them.
- 2026-11-02: Footer address set to 4640 South Flores Road, Elmendorf, TX 78112 (same as Mission Custom Pools; `email-engine/seed/config.json`). The portal email editor will be click-to-edit text in the live preview plus an HTML mode, both saving drafts that need approval (Phase 3 / CP7).
- 2026-11-02: First sandbox run stopped at the quota guard. The reserve of 200 assumed a 1,500/day quota and the wrong reason (Tony's own mail doesn't count against Apps Script's quota). Now Config `quota_reserve`, default 20; a quota stop reports the remaining quota and the reserve; `eeDiagnostics()` shows the live numbers.
- 2026-11-09: **Contact import and batches** (Mau), built in CP10.
  - **Import (Lifecycle Email → Contacts → Import):** upload a CSV or Excel file, or paste rows from a Google Sheet; map columns (first/last name, email, phone, address, city/area, tags, source); pick the group (MCP Legacy, …). Before anything is written the import shows a check: valid and new / already in the engine (skipped; a returning B contact goes to Needs review, per Re-entry) / already a portal customer (flagged) / unsubscribed or bounced in `Comms_Optouts` (skipped) / bad or missing email (skipped). Confirmed rows are written in chunks through the signed admin relay, journaled like any contact, all with `review_status = needs_review`. Nobody is emailed by an import.
  - **Start a batch (Contacts → Needs review):** pick a group and filters (area, tags, source, "hasn't received the first email"), a count, and **Random** or **Oldest first**. The page shows the picked list (swap anyone out) and on confirm marks them `confirmed`; their sequence starts at the next run, still paced by the daily cap. Everyone else waits for the next batch. Needs the `edit_contacts` capability; logged in ChangeLog with the filters and count.
  - **MCP Startup (C)** contacts are not uploaded: they're created from approved startup requests with the live startup date (CP10 sync).
- 2026-11-09: **Import must handle any spreadsheet format** (Mau: the legacy list's format is unknown and more lists will come in other formats). Requirements: pick the sheet when a file has several; find the header row even when it isn't row 1; suggest the column mapping from header names and sample values (e.g. "E-mail", "Customer Email" → email; a column of @-values → email); split a single "Name" / "Full name" column into first and last, and accept the address as one column or as street/city/state/ZIP; normalize phones and emails, and take the first valid email when a cell holds several; **save each mapping by source** so the next file in the same format maps itself; show 10 sample rows as they'll be saved before the check step. Built and tested in CP10 against several made-up formats, since there is no sample yet.
- 2026-11-10: **Schedule view and per-send edits** (Mau), built in CP7.
  - **Schedule (new tab on the Lifecycle page):** a month calendar of programmed emails, each day showing how many sends are planned per sequence, plus a list view. Click a day → who gets which email that day. Projected on Vercel with the same `js/lib/lifecycle-rules.js` the engine uses (simulation mode, no writes), from the current contacts, enrollments, holds and rules, so it matches what the engine will do; days past the daily cap show the overflow moving to the next day.
  - **Edit a planned send:** **Skip** (this person never gets this email), **Move** to another date (only inside the email's window and before its deadline; the picker greys out other days), **Send in the next run**. Stored as journaled overrides that the planner reads (same idea as Holds), logged in ChangeLog with the user. Needs `edit_contacts`. Editing an email's *content* is the editor (CP7), not this.
- 2026-11-10: **Contact tags** (Mau). The `tags` column already exists; add editing: add/remove tags in the person drawer, bulk-tag selected rows in Contacts, filter Contacts by tag, tags from the import's column mapping, and tags as a Start-a-batch filter. Tags are free text with suggestions from tags already used. Built with CP10 (import), the drawer editing can land in CP7.
- 2026-11-10: **The demo is Mau-only**: `eeDemoSetup` uses only `mauricio+demo…@` addresses; nothing is sent or shown to Tony until Mau decides.
- 2026-11-10: **Template Library from a Drive folder** (Mau), built in CP7 alongside the editor; one source among others, not the only one.
  - A Drive folder (e.g. "MCPS Email Templates", shared with the engine's account) is the template bucket. Drop an `.html` file in it (or a subfolder per sequence) and it appears in the portal's **Templates** list with a preview.
  - When setting up or editing an email (wizard / editor), choose its body from: the library, the click-to-edit editor, or pasted HTML. Picking a library file **copies** it into that email's draft; the draft still goes through the renderer's checks (merge fields known, required fields present, unsafe HTML, images with alt text, footer and unsubscribe from the shell) and needs approval, which freezes it as an immutable revision. Later edits to the Drive file never change a sent or approved email; the library shows "newer version in Drive" and offers to start a new draft from it.
  - Shared blocks (e.g. PoolSchool) can live in the same folder (`blocks/`).
- 2026-11-10: **"Single email" sequence type** (Mau): a one-time scheduled send of one template to a chosen audience, inside Lifecycle Email. ~~Built first after B/C go-live~~ **Moved up to CP7 (Mau, 2026-11-10)**, built with the Template Library and editor. Until CP10's import and batches exist, its audience is contacts already in the engine, picked by tag; real lists work from CP10.
  - **Setup:** name, template (Template Library, editor or pasted HTML; approved like any email), send date (and the daily run sends it that morning), audience = a batch (Start a batch: group + filters + tags + count, random or oldest first) or every confirmed contact matching a tag. Category marketing by default.
  - **Rules engine:** a new `date` anchor in `lifecycle-rules.js` (a fixed calendar date instead of enrollment/startup/previous), one step, `reentry: never`, a window of a few days so the daily cap and quota can spread a large audience; each person gets it at most once.
  - **Everything else is the same engine:** suppression and unsubscribes, the one-lifecycle-email-per-day rule and the Comms same-day hold, tracking, replies and bounces, the Schedule calendar (the send day and any overflow), ChangeLog, and the same never-twice delivery guarantees.
  - **Versus Communications campaigns:** Comms stays the tool for bulk announcements sent from the portal's account; single emails here come from Tony's address with lifecycle tracking. The shared opt-out list and the same-day hold keep the two from double-mailing a person.
- 2026-11-10: **Batches get a "Start on" date, and import + batches move to the start of CP7** (Mau: priority).
  - **Start on:** each batch has a start date (today by default). Several can be lined up at once ("20 now, 20 on Nov 23, 20 on Nov 30"). The people are picked when the batch is created, so the list can be checked and adjusted then; picking at the start date instead (from whoever is still eligible) is an option per batch. A lined-up batch can be edited or cancelled until its date.
  - **Engine:** a Batches table (batch_id, filters, count, order random/oldest, start_on, picked contact ids, status planned/started/cancelled, created_by). On its start date the daily run confirms the batch's contacts, so their sequence starts that morning; a contact that unsubscribed, bounced or was enrolled meanwhile is skipped and reported. Journaled, ChangeLog'd, needs `edit_contacts`.
  - **Page:** batches appear on the Schedule calendar on their start day, and in Contacts → Batches with their status.
  - Import and batches are built first in CP7, before the editor and wizard, so the MCP Legacy list can be loaded and batches lined up as soon as the list exists. CP10 becomes loading the real list and the C sync.
- 2026-11-10: **Template layout: MCPS frame or Full template** (Mau: Drive templates will carry their own header and signature).
  - Each email revision records its layout. **MCPS frame** (today's behaviour): the shell adds header, signature and footer. **Full template:** the HTML is the entire email; the shell adds nothing visible.
  - Full templates must contain `{{UnsubscribeLink}}` (an `<a href="{{UnsubscribeLink}}">`) and `{{BusinessAddress}}` (or the address text); the renderer refuses approval without them (same checks as today, applied to the template instead of the shell). Merge fields and `{{button:…}}` work the same.
  - In both layouts the engine still rewrites links for click tracking, adds the open pixel, and appends the small `Ref dlv_…` line at the very bottom (needed for Sent-folder reconcile and orphan-draft recovery: never removable). Images need alt text; `http:` images and scripts are refused.
  - Template guidance for whoever builds them: 600 px wide, table layout with inline CSS (email clients ignore most `<style>`), web-safe font fallbacks, images hosted on the email asset host, no important text inside images.
- 2026-11-10: **Marketing kit for Tony + ChatGPT bridge + duplicate protection** (Mau).
  - **`eeSetupMarketingKit`** (run once as Tony): `MCPS Marketing/` in his Drive with `Email Templates/` (MCP Legacy, MCP Startup, Shared blocks; Script Property `EE_FOLDER_TEMPLATES`, the Template Library's folder), `START HERE - ChatGPT instructions.txt`, and `Example - MCP x MCPS Intro (full template).html`; shared with Mau.
  - **ChatGPT bridge, step 1 (now, no code; Mau: keep it simple):** Tony connects Google Drive in ChatGPT once and asks it to read the instructions file in MCPS Marketing; no Project to set up. Finished `.html` files go into the Drive folder; the Template Library picks them up (CP7). Editing: ChatGPT opens the file from the folder (or it's attached).
  - **Contact lists stay on Tony's computer** until he uploads one through the portal's import (CP7); only the header row is needed now, to prepare the column mapping.
  - **ChatGPT bridge, step 2 (after the portal side is public):** a custom GPT with an Action (OpenAPI, API key per user) on `/api/email` to list, open and save templates in the Drive folder directly, saving as a new draft that still needs approval. Needs a public endpoint, so not on the SSO-protected preview.
  - **Full templates also accept link placeholders:** `{{QuoteLink}}` (Config link_quote) and `{{UnsubscribeLink}}`, resolved and tracked by the engine.
  - **Duplicate protection at import:** emails normalized (case, spaces, Gmail dots/plus kept as given); duplicates inside the same file merged (first row wins, others reported); same email already in the engine → skipped (returning MCP Legacy contact → Needs review); same name + address as an existing contact with a different email → flagged for review, not imported automatically; `Do Not Contact = Yes` → skipped and added to the opt-out list; `Current MCPS Customer = Yes` or a match in the portal's customers → not given the MCP intro; opted-out or bounced addresses → skipped.
- 2026-11-10: **CP6's "demo script run for Tony" replaced by Mau's own walkthrough**; the demo for Tony waits until B/C are complete (Mau: Tony sees nothing until it's all done).
- 2026-11-10: **One template folder per email, several templates per email** (Mau). `eeSetupMarketingKit` creates `Email Templates/MCP Legacy/<n - email name>/` and `MCP Startup/<n - email name>/` from the ruleset's steps (ids kept as `EE_FOLDER_STEP_<step_id>`, so renames don't break the link; re-running adds missing folders only). Template Library (CP7): an email's drawer lists the templates in its own folder; pick one → checks → approval → live. Optional **split**: approve two or more for the same email and the engine alternates them between people (assignment stored on the delivery; one variant per person, never mixed within a send); Performance shows opens, clicks, replies per template (deliveries already record `revision_id`).
- 2026-11-10: **Restarting someone who already had a sequence is allowed, with a warning** (Mau; overrides "B never re-runs" for deliberate restarts). Start a batch lists them too, marked (e.g. "already had MCP Legacy · stopped: clicked · Nov 9"); picking them shows a warning naming who and why before saving; the engine then ends any old enrollment and enrolls them fresh (a new enrollment id, journaled, ChangeLog'd with the actor). Automatic re-entry stays off: only a person can restart someone. Not built yet (batches currently exclude them: aaa92d5).
- 2026-11-10: **Open: where campaigns are set up** (Mau: "the most important screen, feels hidden in Contacts"). Claude's recommendation: a **Campaigns** tab first (replacing Emails): one page per sequence/single email with the pipeline (Waiting → Lined up → In sequence → Finished/Stopped), its batches timeline, its emails and results, and the **Start a batch** button; a "New campaign" wizard as that page's start button; the Schedule calendar as a view of it; Contacts becomes the directory + Import. Waiting on Mau's choice; build nothing until he picks.
  - Mau: "we can't lose the Emails tab." Nothing on it is lost in any option. Revised recommendation (**B**): keep both tabs with one job each: **Campaigns** = who + when (pipeline, batches, Start a batch), **Emails** = what (every email with results and its drawer; in CP7 also templates from the Drive folders, approvals, versions, splits), **Contacts** = directory + Import, **Activity** = health/runs/changes. Option A (emails only inside each campaign) loses no data but buries content and approvals.
- 2026-11-10: **Decided (Mau): four tabs, Campaigns · Emails · Activity · Contacts.**
  - **Campaigns** (first tab): one page per campaign (each sequence, later each single email): pipeline Waiting → Lined up → In sequence → Finished/Stopped, batches timeline, its emails' results, **Start a batch**.
  - **The wizard is Campaigns' setup flow**, not a separate place: audience (group, filters, tags, import link), how many, random/oldest, start date(s), the picked people (with the restart warning for anyone who already had a sequence), review, launch.
  - **Calendar view inside Campaigns** (List / Calendar switch; this is the planned Schedule view): planned sends and lined-up batches on their days; clicking a day opens the wizard with that date filled in; dragging a planned batch moves its start date; per-send Skip / Move / Send next run from the day's list. Same batch objects and engine checks in every entry point.
  - **Emails** stays (what: every email with results and drawer; CP7 templates, approvals, versions, splits). **Contacts** = directory + Import. **Activity** unchanged.
- 2026-11-11: **MCP Legacy contacts come from Tony's own import, not the Sales Hub sync** (Mau). Automatic MCP lead adding is off by default; past synced leads with no sequence were removed once (`retire_synced_leads`). Imports replace an existing contact's details by default (no duplicates; the new list's source wins; removed contacts return to Needs review); a person can still pick Skip / Fill in blanks / Keep both per row.
- 2026-11-11: **Send times** (Mau): each campaign has a default send time and each batch can set its own; its emails keep that time. The engine runs at each needed time (scheduler + one-off triggers, max 12 a day) instead of once around 9 AM. Times show in Central time with the zone everywhere runs are monitored (calendar, batches, Activity runs, drawers, header). Changed together: *Scheduling semantics* (send times, runs at send times), *Execution modes* (triggers, time on screen), failure rows 58–61, CP7 exit criteria, *Verification* row range.
- 2026-11-11: **Campaigns tab wired** (Mau approved the mockup): per-send overrides (skip / move / next_run, `Overrides` tab, logged like Holds rather than journaled), `move_batch`, restarts (`restart_ids` → `restart_ok` → planner enrolls again), and planned sends from `decide()` in the read model (`view=plan`). Changed together: *Scheduling semantics* (overrides, planned sends, restarts), failure rows 62–64, CP7 exit criteria, *Verification* row range.
- 2026-11-11: **Template Library built** (CP7). The renderer takes **full templates** (complete HTML files, e.g. from ChatGPT) besides body templates: no MCPS shell; it requires the business address and `{{UnsubscribeLink}}` in the file, allows `<style>` and Google Fonts links, refuses scripts/forms/iframes and non-https or alt-less images, tracks `{{QuoteLink}}` as the main button, never tracks the unsubscribe link, and adds the delivery reference (needed by reconcile), the open pixel and the hidden preview text. Engine actions `list_templates`, `open_template`, `open_draft` (not logged), `import_template` (a copy into a draft; checked, refused with problems), `approve_draft` (frozen into Revisions, published, supersedes; two-person rule honoured), `discard_draft`. Starter drafts written with the portal (C Progress, Maintenance, Final Transition) are offered in the same list for emails with nothing live, without files in Tony's Drive. **Split** (alternating two approved templates) is deferred until after B/C go-live.
- 2026-11-11: **Connected to the portal's own data** (Mau: "fully integrated with what's already there"). Investigated, not guessed:
  - **MCP leads** are rows in CRM SS › `Quotes` with `status = LEAD`, written by the Sales Hub's Import Leads (`lead_source = import`, plus `year_built`, `area`, `pool_info`). Nothing in the data marks a list as MCP's specifically, so the page shows the live breakdown (by source, status, year built, area, already in the engine) and Mau saves the rule that defines "MCP leads" (Config `crm_lead_rule`). Matching leads are added to **Needs review** through the same server check as a file import (opt-outs, engine duplicates, active customers from `Clients` and `Quotes`, same person), keeping `quote_id` so each contact links back to the Sales Hub. With **Keep in sync** on, new matching leads are added by the daily heartbeat. Nobody is emailed by this: Needs review only, batches start people.
  - **Startups** are `Quotes` rows for the Pool Startup service (`service_key = pool_startup`, `pool_id` set, not LOST/EXPIRED). Their live date comes from Routes SS › `Scheduled_Visits` (`startup_day_1/2/3`; reschedules update those rows and Routes, **not** `Quotes.startup_start_date`, which is only the fallback). `startup_pool_school` sets the PoolSchool block. Startups from 33 days ago onward are synced into MCP Startup as confirmed contacts (`quote_id`, `pool_id`, `startup_date`, `startup_source`); date changes flow through the anchor rules (unsent emails re-plan, sent ones are flagged); a startup that is LOST/EXPIRED or has every startup visit cancelled is removed and its sequence stopped (`startup_cancelled`). Engine action `sync_startups`.
  - **When it runs:** the daily heartbeat (production, `CRON_SECRET`), **Sync now** on the page, and on opening the page (at most every 15 minutes) for people who can edit contacts. Reading uses the portal's own service account (the same reads the Sales Hub and schedule already do).
  - **Still open:** writing email activity back to the Sales Hub (`last_emailed_at`, contact log) — after B/C go-live; the startup-approval plain email vs the Welcome (open decision 0) still applies before C goes live.
- 2026-11-11: **MCP leads are identified and added automatically** (Mau: "all imported leads" are MCP's). Default rule: `status = LEAD` and `lead_source` in `mcp`, `import`, or blank (Import Leads was the only creator of LEAD rows before `lead_source` existed, 2026-08-25; service requests and one-time jobs always record their own source). The Sales Hub's Import Leads now asks where the list is from (MCP → `mcp`, another list → `other_list`). Automatic adding is **on by default** (Config `crm_lead_auto` = false turns it off): the heartbeat, Sync now and opening the page add new MCP leads to Needs review. The rule can still be changed in the MCP leads panel.
- 2026-11-11: **Contact cleanup and duplicates** (Mau): tidy names (capitals), recognise couples / families / businesses, and resolve repeated or possibly repeated contacts like a file-copy dialog, for current contacts and every future import (file, MCP leads, startups).
  - **Rules first** (`js/lib/contact-clean.js`, shared by the page, the API and tests): names re-cased only when typed in all capitals or all lower case (Mc/O'/hyphens, particles like de/la/van, Jr./Sr./II/III), titles dropped, "Smith, John" flipped; **kinds:** person, couple ("John & Mary Smith" → greeting "John and Mary", last "Smith"), family ("Smith Family", "The Smiths", "Familia Garza" → greeting "Smith family" / "Familia Garza"), business (LLC, Inc, Builders, Pools… flagged, not given the MCP intro by default); phones formatted (210) 555-1234; city/street re-cased the same way; **email warnings** (role addresses like info@/office@, likely domain typos such as gmial.com → gmail.com: suggested, never changed automatically); placeholder names ("N/A", "Unknown", "Customer") cleared so the greeting falls back to "there". The original name is kept (`name_original`) so every change can be undone.
  - **AI only where rules can't decide** (3+ word names, mixed couples with two surnames, unclear businesses): Claude Haiku 5.5 (Mau: "dirt cheap"), names only (no emails, phones or addresses), up to 40 per call, structured output, and an answer is rejected unless every word in it came from the original name (no invented names). Needs `ANTHROPIC_API_KEY` on Vercel; without it the rules still run and the page says the AI check is off.
  - **Duplicates:** same email (and Gmail dot/plus variants), same person with another email (name + street), same household (same street address and city, different names), similar names at the same address (typos). **Choices like a file-copy dialog:** Keep both · Keep existing (skip new) · Replace with new · Merge (keep one, add the other's email as an alternate and fill blanks), with "apply to all similar". Imports ask; the automatic MCP lead sync can't ask, so possible duplicates arrive as **Possible duplicate** (never batched) for review; exact email duplicates are skipped as before. Engine actions `update_contacts`, `merge_contacts` (the merged contact keeps a `merged_into` pointer; its active sequence stops `merged`; opt-outs are by email and still apply).
  - **Clean up** in Contacts: Names (before → after, kind, apply selected) and Possible duplicates (side by side, the four choices).
- 2026-11-11: **Email Setup is editable; the Welcome goes out at approval** (Mau).
  - **Setup tab** (an email's drawer) gets **Edit**: on/off, timing (days after the previous email / after the batch's start date / after the startup; repeating emails keep theirs), and, for marketing emails, which signals stop it (reply, verified click, service request). Needs `edit_config`.
  - **Saving publishes a new ruleset revision** (`bc-2`, `bc-3`, …; Admin.js `publish_rules`) and points Config `rule_rev` at it; revisions never change in place. The person picks the scope (*Scheduling* contract): **everyone in the sequence** (running enrollments of that sequence move to the new `rule_rev`) or **only people who join from now on**. A page that loaded an older revision is refused (`base_rev`), so two editors can't overwrite each other.
  - **Off** (`status: 'off'`): never sent (rules: `excluded/turned_off`; the core gate refuses it too). The next email still chains from the day the off one was due, like a per-send Skip.
  - **MCP Startup Welcome = at approval by default** (Mau: "the welcome email is the one sent as soon as we approve the startup"). Its anchor becomes `enrollment` (the startup joins the engine when approved; the portal now syncs right after approval instead of waiting for the morning sync), with its hard deadline moved to `{from: 'startup', offset: -1}` (new in the rules: a deadline counted from the startup date whatever the anchor). Its Setup offers **When the startup is approved** or **N days before the startup**, so it can be changed from the portal. Applied by publishing it from the Setup tab (the seed `bc-1` stays as the record of the original plan and the worked examples).
  - **Open decision 0 closed:** the plain "Your MCPS Pool Startup is Confirmed" email goes to the **builder** who sent the request and stays as it is, sent on approval, with no customization. The branded Welcome goes to the **homeowner**.
  - Wording: "The day they join" → "When their batch starts" (B) / "When the startup is approved" (C).
- 2026-11-11: **No double actions anywhere on the page** (Mau found that Preview could open several windows). Every button that calls the engine shows a spinner and ignores repeat clicks until it finishes (one guard in `lcOnClick_`, keyed by action + id, so a re-rendered copy of the button is covered too). Confirm sheets that save stay open with a spinner and show a failure inline instead of closing first. The template preview opens at once with a loading state. Import, cleanup and Use as draft are guarded the same way.
- 2026-11-11: **AI marker** (Mau): anything the AI suggested is tagged with a sparkle icon + "AI" chip (`lcAiTag_`); the Check with AI button carries the sparkle too.
- 2026-11-11: **Handoff to Tony: in-portal tutorial and "Request a change"** (Mau). Built before CP9, after B/C are complete. Tony is the main user, so he has to be able to understand and run the engine on his own.
  - **Tutorial:** a guided tour inside Lifecycle Email, step by step over the real screens: what each tab is for, how a campaign runs (batches, send times, the calendar), approving templates, Setup edits and their scope, reading Activity and resolving an unconfirmed send, pausing, and what never to do (e.g. reply to test emails). It can be restarted from a Help button, and it remembers which steps he has seen. Reuse the portal's existing `js/features/tour.js` if it fits.
  - **Request a change button:** a small button in a corner of every Lifecycle screen. Tony types what he wants, can attach pictures or files, and can **point at the thing he means** (click an element to highlight it). It sends Mau an email with: the request, the attachments, a screenshot of the screen with the chosen element outlined, and the context (tab, campaign, open drawer/step, element selector and text, page URL, Tony's username, time, app version), so the request can be acted on without a back-and-forth. It goes from the portal's own mailer to Mau, never through the engine (the engine sends as Tony).
- 2026-11-11: **On the Way stays with HeadsUp; startup day emails ship Off** (Mau). The portal's `appscript/HeadsUp.js` already emails the customer when the tech taps On My Way, for every visit including startup days, so the engine's Startup On the Way step and the HeadsUp routing change are dropped (failure rows 47–50 and 52 no longer apply; 51's "call or text instead" stays HeadsUp's behaviour). CP8 still builds the event pipeline for **Startup Day Log** and **Startup Summary** (customer Startup Log, 3-1 report, pool school booking), but both go live **turned Off** (Setup → Off) and are switched on later from the portal; they're not part of the B/C go-live (CP9).
- 2026-11-11: **The homeowner's approval email becomes the Welcome** (Mau: "this email is the one already in place, I just want to customize it through the portal"). Correction to the 2026-11-11 note above: the portal's plain "Your MCPS Pool Startup is Confirmed" (`appscript/StartupRequests.js`, `srSendBuilderEmail_` at approval) goes to the **homeowner** (`req.email`), not the builder. So: the MCP Startup **Welcome** (branded, editable in Lifecycle Email → Welcome Email → Templates → Edit) is that email now. It's anchored `enrollment` with its deadline from the startup; it is **immediate** (`isImmediate` in lifecycle-rules.js): no send-time wait, any hour. The approval in the portal syncs the startup (`srApprove` → `/api/email?op=crm` stage `sync`), the engine's `sync_startups` queues a run when it added someone, and the Welcome goes out about a minute after approval. The plain approval email is **removed** from StartupRequests.js on this branch; that portal GAS change ships with the go-live (CP9) so the homeowner never gets two. The "received" and "declined" portal emails stay as they are.
- 2026-11-11: **"All 7 B/C emails approved" moves from CP7 to CP9; only Welcome is On at launch** (Mau). The 3 MCP Startup starter drafts stay unapproved until launch and B Follow Up + Check-In wait for Tony's templates, so approval is a go-live gate, not a CP7 one. At launch the only email turned On is the MCP Startup Welcome (already live in test); everything else, including CP8's Day Log + Summary, ships Off and is switched on later from Setup. Also struck CP8's "OTW latency budget" (On the Way was dropped earlier today). Changed together: Checkpoints rows 7, 8, 9.
- 2026-11-11: **Go live (CP9) before CP8** (Mau). Only the Welcome is On at launch and it needs nothing from CP8, so `bc-live` comes next and `startup-events` follows it. **Startup Day Log is redefined, work in progress** (Mau): the portal already emails homeowner + builder the signed checklist PDF after each startup checklist (`appscript/StartupChecklists.js`), so the engine won't duplicate it. What Mau ultimately wants is a *different kind of startup report*, likely from the service log itself, with more startup-specific options when a tech logs a startup visit. Not designed yet; CP8 waits for that design. Changed together: Checkpoints rows 8 and 9 (order note), PROGRESS Now + Parking lot.

