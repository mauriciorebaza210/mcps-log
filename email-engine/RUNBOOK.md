# Lifecycle Email Engine: Runbook

What to do when something goes wrong. For Mau (first) and Tony (second).
The plan's contract is in [docs/PLAN.md](docs/PLAN.md) (Operations, Guarantees, Journal).

**Where things are**
- **Portal:** Sales Hub → **Lifecycle Email**. Everything day to day happens here.
- **Engine:** Tony's Apps Script project "MCPS Email Engine" (runs as antonio@). Deploy only with `npm run ee:deploy "<what>"` from the `feat/email-engine` worktree. That command checks it runs as Tony and rolls back if not.
- **Data:** the engine's main spreadsheet (Script Property `EE_MAIN_SS_ID`) and the separate **Journal** spreadsheet (`EE_JOURNAL_SS_ID`).
- **Backups:** Drive → MCPS Email Engine → Backups, one copy of each spreadsheet every night and the newest 30 kept (Backup.js). They run with the midnight scheduler, so they start once **eeInstall** has been run at go-live.
- **Alerts:** emailed to the Config `alert_email` (default Mau) and listed in Lifecycle Email → Activity. A heartbeat checks the engine every morning from Vercel, separately from the engine itself.

**The one rule:** when unsure, **turn sending off first**, then investigate. Nothing is lost while it's off. Emails that come due wait, and they go out when sending is back on, as long as they're still inside their window.

---

## 1. Pause the engine or one sequence
- **Everything:** Lifecycle Email → Activity → **Sending** switch → Off (confirm). Config `engine_enabled` becomes `false`. Every send is refused at its last check (`kill_switch`), including a run already in progress.
- **One sequence:** Activity → the switch next to MCP Legacy or MCP Startup. Config `paused_buckets` gets that sequence. Pausing is per sequence: pausing MCP Legacy doesn't hold a single email to the same people.
- **A single email:** open it (Campaigns → Single emails), then Setup → **Cancel this email**. This can't be undone; to send it later, make a new one.
- **One email in a sequence:** Emails → the email → Setup → Edit → **Off**. The emails after it still go on their usual days.
- **One person:** Campaigns → calendar → their send → **Skip**.

Turning back on: the same switch. Due emails go out at the next planned run, or right away with **Send due emails now** (Activity tab).

## 2. Resolve an unconfirmed send (`unknown` / `reconcile`)
**What it means:** the engine asked Gmail to send, and the execution ended before it could record the answer. The email may or may not have gone out. The engine never guesses, so it waits for a person.

1. **Wait 15 minutes.** A `reconcile` delivery is checked automatically: the engine searches Tony's **Sent** folder for the email's reference token. If it's there, the delivery becomes `sent`. Most cases end here.
2. If it's still **Send unconfirmed** (Activity → *needs a decision*), open **Tony's Gmail → Sent** and search for the **Ref** code shown on the delivery. The same code is printed in small type at the bottom of every email.
3. Decide:
   - **Found it in Sent → Mark sent.** Nothing is sent again.
   - **Not in Sent → Resend.** The button stays locked for **36 minutes** after the send attempt (the quiescence period, so a slow execution can't still be sending). After that the next run sends it again.
   - **Shouldn't go at all → Abandon.** It's never sent, and its leftover Gmail draft is deleted.
4. The target is to resolve these within 24 hours. The heartbeat alerts if one stays unresolved.

Never send a lifecycle email by hand from Gmail drafts: the engine would not know, and could send it again.

## 3. Safety pause (Journal integrity)
**What it means:** Activity shows **Safety pause**, and an alert says `journal_integrity` with a reason. The engine found its record of changes (the Journal) unreadable or inconsistent, and stopped every send (fail-closed). It sets the Script Property `EE_SAFETY_PAUSE` to the reason.

| Reason | Usually means | Fix |
|---|---|---|
| `journal_unavailable` | The Journal spreadsheet can't be opened (deleted, unshared, Google outage) | Restore access, or point `EE_JOURNAL_SS_ID` at the right file |
| `journal_behind_checkpoint` | The Journal is older than the main sheet (someone restored only one of them) | Restore the matching Journal backup (section 4) |
| `seq_gap`, `chain_broken`, `hash_mismatch` | A Journal row was edited, deleted or reordered by hand | Restore the Journal from the newest backup taken before the edit (section 4). Never "fix" Journal rows by hand |

**To resume:**
1. Turn sending off in the portal (section 1).
2. Fix the cause as in the table above.
3. In Tony's Apps Script project → Project Settings → Script Properties, **delete `EE_SAFETY_PAUSE`**. Tony, or Mau as editor, can do this.
4. Check: open the engine's web app URL (`…/exec`). It should show `safety_pause: ""`, with `applied_seq` equal to `journal_head`.
5. Turn sending back on. Check Activity for unconfirmed sends (section 2).

## 4. Restore from a backup, then replay the Journal
Use this if the main spreadsheet is damaged, rows were deleted, or a bad edit can't be undone.

**How it works:** the main sheet records `applied_seq`, the last Journal record it includes. Every time the engine takes its lock, it replays any Journal records after that number (each only once). So restoring an older main sheet and letting the engine catch up rebuilds everything since the backup.

1. **Turn sending off** (section 1).
2. In Drive → MCPS Email Engine → Backups, pick the newest **main** backup taken before the damage. Its name and description include `seq N`.
3. Copy its tabs over the live main spreadsheet: open the backup, then on each tab use right-click → *Copy to* → the live sheet, replacing the live tab's contents. Keep the live file itself, because Vercel and the engine know it by its id. **Include the `Meta` tab**, because it holds `applied_seq`.
4. **Don't restore the Journal** unless it's the Journal that's damaged (section 3). The Journal is the record that brings the main sheet up to date.
5. Replay the Journal: in Tony's Apps Script project run **eeCatchUp** (it sends nothing, even with sending on). It replays every Journal record after `seq N`. Then open the web app URL (`…/exec`) and check that `applied_seq` equals `journal_head`. (**Send due emails now** doesn’t do this while sending is off: it stops before touching anything.)
6. Compare **sent** deliveries against Tony's **Sent** folder for the period since the backup: every Ref code in Sent should be a `sent` delivery. Mark any missing ones with **Mark sent** (section 2).
7. Turn sending back on.

**If the Journal is lost as well** (the only accepted data loss, PLAN.md): restore both from the same night, keep sending **off**, and rebuild what happened since from Tony's Sent folder (Mark sent) and the unsubscribes and replies in his inbox. Only then turn sending on.

A backup can also be made on demand: run **eeBackupNow** in Tony's Apps Script project (the engine's `maintenance` action `backup` does the same over the portal relay).

## 5. Wrong account (`owner_guard`)
**What it means:** runs stop with **Wrong account**. The engine only sends as its owner (`EE_OWNER_EMAIL` = antonio@). Something made it run as someone else, usually a deploy from another Google account, or a trigger installed by someone else.

1. Redeploy as Tony: `npm run ee:deploy "owner fix"`. The script signs in as Tony (clasp user `tony`), deploys, and checks the live identity. If the Tony login expired, run `clasp --user tony login` in `email-engine/` and Tony signs in.
2. Triggers: Tony runs **eeInstall** once (it refuses to run as anyone else). It deletes the old schedule triggers and installs the midnight scheduler.
3. Check the web app URL (`…/exec`): `effective_user` must be antonio@.

## 6. A run seems stuck (`already_running` / lease)
**What it means:** runs stop with **Already running**. Only one run can hold the run lease at a time, so two runs can never send the same email.

- **Wait 7 minutes.** A lease lasts 7 minutes, longer than Apps Script's 6-minute limit, so a crashed run's lease expires on its own. The next run proceeds, and recovers anything the crashed run left half-done (drafts are found by token; nothing is sent twice).
- **Still stuck after that** (should not happen): in Apps Script → Executions, confirm nothing is running, then delete the Script Property `EE_LEASE`. **Never** delete it while an execution is running. Leave `EE_LEASE_GEN` alone: it only ever goes up.
- **Superseded** (`lease_lost`) on one run is normal after a slow run: the newer run took over.

---

## Daily checks (2 minutes)
- Activity shows **All clear**, and **Today's runs** ran at their times.
- There are no **needs a decision** items older than a day.
- The header shows a recent **ran** time. The heartbeat alerts if no run happened in over a day.
