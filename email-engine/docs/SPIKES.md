# Phase 0 spike report (CP1)

Each spike records what was measured, how, and what it changes in PLAN.md. CP1 closes when every spike has a result and the plan's *Guarantees* section matches them.

| # | Spike | Status | Result in one line |
|---|---|---|---|
| 1 | Engine project ownership, binding, web-app identity after redeploy, trigger ownership | **done 2026-11-02** | web app runs as whoever deployed last; every deploy must be done as Tony |
| 2a | Draft removed on send | **done 2026-11-02** | 8/8 drafts gone after `send()`; `getDraft(missing)` throws "Not found" |
| 2b | Sent-search latency (sets G/G2) | **done 2026-11-02** | every message found on the first search, ≤ 8.5 s after sending |
| 2c | Interrupted sends and orphan drafts | **done, inconclusive** | no call was cut off mid-flight (0/8); see below |
| 2d | Auto-reply and bounce headers | **partial** | auto-reply headers readable; bounce rows captured the wrong message (script bug) |
| 3 | Unsubscribe ordering + lock-hold p50/p95 | **done 2026-11-02** | contract HELD 6/6; authorize hold p95 1.70 s (budget 2 s) |
| 4 | Service-account read latency and bytes per op | not started (needs the read path, CP5 prep) | |
| 5 | `Comms_Optouts` and `Comms_Log` exist live | **done 2026-11-02** | both exist; Settings spreadsheet found |
| 6 | Node test glob discovers the whole suite | **done 2026-11-02** | `node --test "<glob>"` correct; plain `node <glob>` skips files |

Raw data: `EE Phase 0 Spike Results` spreadsheet in Mau's Drive (downloaded copy: `~/Downloads/EE Phase 0 Spike Results.xlsx`). The spike runs were made in Mau's account (mauricio@), in a throwaway standalone project, on 2026-11-02 between 10:16 and 11:35 CT.

## 1. Engine identity (done 2026-11-02)
Created under antonio@ in an Incognito window (a window with two accounts signed in failed with "unable to open the file", `authuser=1`). Run by Mau using Tony's login. Each identity was recorded by the script itself in the `spike1` tab of the engine spreadsheet, and read back through the portal's service account.

| Step | Done as | Code version | Ran as |
|---|---|---|---|
| Editor run | Tony | v1 | `antonio@` ✔ |
| Web app, called anonymously from Claude's machine | (deployed by Tony) | v1 | `antonio@` ✔ |
| Time trigger, installed by Tony | Tony | v1 | `antonio@` ✔ |
| Editor run | Mau | v2 | `mauricio@` (expected) |
| Web app after **Mau** redeployed | (deployed by Mau) | v2 | **`mauricio@`** ✖ |
| Web app after **Tony** redeployed the same code | (deployed by Tony) | v2 | `antonio@` ✔ |
| Triggers visible to Mau | Mau | v2 | not measured: "An unknown error has occurred" (Google documents that each user sees only their own triggers) |

**Conclusion:** a web app set to "Execute as: Me" runs as **the person who deployed it last**, not the person who created it. Code can come from anyone with edit access, but **every deploy must be done as Tony**.
- The guarded deploy script deploys with clasp's named login (`clasp --user tony deploy`) and checks `effective_user = antonio@` after every deploy, rolling back if it's wrong.
- The engine's owner guard (refuse to send unless running as `engine_owner_email`) is essential, not just a precaution: a single deploy from Mau's browser would otherwise move all sending to Mau's Gmail.

Also confirmed: the portal's service account (`mcps-portal-sheets@…`) can read the engine spreadsheet once shared as Viewer: a small range read in 0.6 s.

Project IDs are recorded in PLAN.md → Deployment → Engine project setup.

## 2a. Draft removed on send
- 8 drafts created and sent with `draft.send()`. After every send, the draft was **gone** from `GmailApp.getDrafts()`.
- `GmailApp.getDraft(<id of a sent draft>)` **throws "Not found"** rather than returning null. Recovery code must use try/catch, or `getDrafts()`, to test whether a draft exists.
- `send()` returned a message id and thread id every time (needed for the reply scan).
- `send()` call time: 296–2,255 ms (median ≈ 420 ms).

## 2b. Sent-search latency
- `in:sent "<token>"` found **all 8 messages on the first search round**. Measured from each send: 0.9 s to 8.5 s. These are upper bounds; polling began only after all 8 sends finished, so the true latency is shorter.
- **Plan change:** grace periods set to **G = 2 min** and **G2 = 15 min**, both far above anything observed. They only decide how soon an unclear send moves from `reconcile` to `unknown`. The safety rule (nothing in `sending` is ever resent automatically) doesn't depend on them.

## 2c. Interrupted sends (inconclusive)
- 8 runs each waited until 357.5–359.6 s into the execution, then called `send()` or `createDraft()`. **Every call returned normally** (`last_stage = call_returned` on all 8), at 357.6–359.8 s by the script's own clock. The Executions page shows 359.7–361.2 s because it includes start-up time.
- So **no call was cut off mid-flight**. The calls take well under a second, and Google ended each execution only after the call had returned. This doesn't prove an interruption can't happen; it means this method couldn't produce one.
- The 4 `createDraft` runs left their drafts in place with ids recorded (expected). No orphan draft was produced.
- **What it changes:** nothing in the guarantees. The plan is already unconditional: a delivery in `sending` is never resent automatically, and the quiescence margin (6 min execution limit + 30 min) stays.
- **Follow-up for the sandbox suite:** the orphan-draft case (matrix row 3) and the interrupted-send cases (rows 1, 4) will use **deterministic fault injection** (throw right after `createDraft`, right after `send()`), not timing-based kills. That's reproducible; this spike showed timing-based kills aren't.
- **Correction:** during the run I told Mau that Google let calls finish past the 6-minute limit. That was a misreading of the Executions durations; the calls finished before the limit.

## 2d. Automation and bounce headers (partial)
- **Auto-reply:** a real out-of-office message ("Accounts Payable", Out of Office…) exposed `Auto-Submitted: auto-replied`, `X-Autoreply: yes` and `Precedence: bulk` through `GmailMessage.getHeader()`. The plan's reply-classification precedence (automation headers checked before accepting a reply) works with real headers.
- Normal messages return empty values for those headers, as expected.
- **Bounce rows are invalid:** the script logged the *first message of each thread*, which in a bounce thread is MCPS's own outgoing email (e.g. "We're on our way, Roland"), not the mailer-daemon reply. Bounce detection will reuse the existing, tested `cbParseBounce_` (`appscript/CommsBounces.js:35`), so this doesn't block CP1; the script fix is to select the message whose sender is mailer-daemon/postmaster.
- Side finding: Mau's mailbox holds real bounces of portal emails (On My Way, service request confirmations, inventory summary). Worth a look separately; it's unrelated to this project.

## 3. Unsubscribe ordering and lock-hold latency
A practice loop of 45 recipients followed the plan's lock rules (no Gmail/Drive/UrlFetch inside the lock; Journal append + apply + flush inside it). A separate execution fired 6 unsubscribes at it mid-run, through the same script lock.

**Ordering: the contract HELD in 6 of 6 cases.**

| Unsubscribe recorded while the recipient was… | Cases | Outcome |
|---|---|---|
| not yet authorized (`pending`) | 3 (r26, r31, r39) | cancelled, never authorized ✔ |
| already authorized (`sending`) | 2 (r24, r27) | sent; later authorizations blocked ✔ |
| in flight (`sent`) | 1 (r28) | sent ✔ |

**Lock-hold times** (budget p95 < 2,000 ms):

| Section | n | p50 | p95 | max |
|---|---|---|---|---|
| authorize | 45 | 901 ms | **1,703 ms** ✔ | 2,243 ms |
| bookkeeping (sent write) | 42 | 676 ms | 1,244 ms ✔ | 1,904 ms |
| ingest (unsubscribe append) | 6 | 399 ms | 690 ms ✔ | 690 ms |

Inside *authorize*, p95 by step: Inbox lookup 590 ms, opt-out lookup (separate spreadsheet) 587 ms, flush 562 ms, Journal append 316 ms, apply 170 ms. The wait to acquire the lock was p95 106 ms.

- All three sections are inside the budget, but authorize p95 is at 85% of it with a 2,000-row opt-out file. **Plan note:** authorize is the section to watch. If production pushes p95 over 2 s, the first fix is a CacheService suppression flag checked before the TextFinder lookups (both are already in the plan's gate), then a per-run in-memory opt-out snapshot refreshed only when an ingest lands.
- Script bug, corrected in this analysis: the logger wrote rows by position, so *bookkeeping* times landed in the `lock_wait_ms` column of `3_sections`. The figures above read the right column.

## 5. Shared Comms tabs
- The portal's Settings spreadsheet (the one its Apps Script is bound to) is **"Chem Log"**, ID `1WdmY9qUqlvA7Xswmf8K8n0FYP02FKEBxM7Zd_V5Er_U`. It was the only match for the portal's own tabs. This becomes the engine's `settings_ss_id`.
- `Comms_Optouts` **exists**, with 0 rows. Headers: `email, scope, opted_out_at, source, recipient_id, removed_at, removed_by`, which matches what the plan's append-only writes need.
- `Comms_Log` **exists**, with 30 rows. It has `email`, `status` and `sent_at`, which the same-day frequency check needs.

## 6. Node test glob (done 2026-11-02)
**Setup:** Node v24.14.1, a scratch folder with `tests/email-engine-a.test.js` and `-b.test.js` (both pass), `-c.test.js` (`process.exit(1)`), and an unrelated `tests/other.test.js`.

| Command | Files run | Exit code | Verdict |
|---|---|---|---|
| `node --test "tests/email-engine-*.test.js"` (quoted), all passing | a, b (other.test.js excluded) | 0 | ✔ |
| Same, with c failing | a, b, c; reports "fail 1" and names c | 1 | ✔ |
| `node --test tests/email-engine-*.test.js` (unquoted, shell-expanded) | a, b, c | 1 | ✔ also works |
| `node tests/email-engine-*.test.js` (no `--test`) | **only a**; b and c are passed as arguments to a | **0, despite c failing** | ✖ the trap the reviewer flagged |

**Conclusion:** `npm run test:ee` = `node --test "tests/email-engine-*.test.js"` is correct. No plan change needed.

## Still open for CP1
- **Spike 4**: read latency and bytes per op through the service account, on a synthetic engine spreadsheet.
- Optional: re-run 2d with the bounce fix.
