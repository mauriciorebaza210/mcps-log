# Lifecycle Email Engine: Progress

Plan: [PLAN.md](PLAN.md) · Branch: `feat/email-engine` · Worktree: `~/mcps-log-email-engine`
Resume in any Claude Code session with `/email-engine`.

## Now
- **Checkpoint in progress:** CP0 `setup`
- **Done in CP0:** worktree + branch; plan approved and committed here; this log; `/email-engine` command; memory note; `email-engine/` hidden from Vercel.
- **Next action:** update the mockup to v3 (`previews/lifecycle-email-mockup.html`, published at https://claude.ai/artifact/K3PVxvC3B82UisqAASpWxz):
  - remove the "When it sends" column from the Emails table (it moves to the drawer)
  - detailed, evidence-graded tracking: per-email funnel by confidence, per-link clicks, scanner-like hits, a per-delivery event list, CSV export
  - a resolver for `reconcile`/`unknown` deliveries, with the quiescence timer on Resend
  - pause switches for the engine and per bucket
  - emphasize B/C, with other buckets shown as deferred
- **Blocked on / waiting for:** Mau's sign-off on mockup v3 (the last CP0 exit criterion).
- **Open decisions (not blocking yet):** what counts as a "positive service milestone" (A Reviews Request); Referral Campaign timing.

## Checkpoint log
| CP | Tag | Date | Commit | Evidence | Next |
|---|---|---|---|---|---|
| | | | | | |

## Parking lot
Sidetracks and tweaks to come back to. Add with `/email-engine park "<note>"`.
- Vercel CLI is outdated (52.x). Upgrade before CP5 (`vercel build` checks).

## Session notes
- 2026-10-17 → 10-29: exploration, mockups v1–v2, and three plan reviews (7 → 8.5 → 9 → 9.3/10). Timing source: Mau's Oct 19 notebook.
