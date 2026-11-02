# Lifecycle Email Engine: Progress

Plan: [PLAN.md](PLAN.md) · Branch: `feat/email-engine` · Worktree: `~/mcps-log-email-engine`
Resume in any Claude Code session with `/email-engine`.

## Now
- **Checkpoint in progress:** CP1 `spikes` (Phase 0 discovery)
- **Goal:** measure the things the guarantees depend on before writing engine code. Results go in `email-engine/docs/SPIKES.md`, and the Guarantees section of PLAN.md is updated to match.
- **Done:** spike 6 (Node test glob). Result in SPIKES.md: the planned `node --test` command is correct, and the plain `node <glob>` form silently skips files.
- **Done 2026-11-02:** spikes 2a, 2b, 2c (inconclusive by design limits), 3 and 5, plus 2d partially. Results and plan changes in SPIKES.md: grace periods G = 2 min / G2 = 15 min; unsubscribe ordering held 6/6; lock-hold p95 inside budget; Settings spreadsheet found ("Chem Log") with both Comms tabs.
- **Done 2026-11-02:** spike 1. The web app runs as whoever deployed last, so every deploy is done as Tony (clasp named login + identity check). Engine spreadsheet, script and deployment exist under antonio@.
- **Next action:** spike 4 (read speed and bytes per op on a synthetic engine spreadsheet). Then close CP1.
- **Blocked on / waiting for:** nothing.
- **Open decisions (not blocking yet):** (1) the 3-1 report layout (CP8 portal work); (2) final Safety Guidelines + Startup Guide PDFs (can be added after launch through the Attachment Library); (3) A "positive service milestone"; (4) Referral Campaign timing.
- **Settled 2026-11-02:** 3-1 report = 3-day startup summary; summary email contents come from its template; all emails send from Tony's address; PDFs via the Attachment Library.

## Checkpoint log
| CP | Tag | Date | Commit | Evidence | Next |
|---|---|---|---|---|---|
| CP0 | `ee/cp0-setup` | 2026-11-02 | (this commit) | Worktree + branch; PLAN.md + PROGRESS.md committed; `/email-engine` skill; memory note; mockup v3 signed off by Mau (claude.ai/artifact/K3PVxvC3B82UisqAASpWxz) | CP1 spikes |

## Parking lot
Sidetracks and tweaks to come back to. Add with `/email-engine park "<note>"`.
- Vercel CLI is outdated (52.x). Upgrade before CP5 (`vercel build` checks).

## Session notes
- 2026-10-17 → 10-29: exploration, mockups v1–v2, and three plan reviews (7 → 8.5 → 9 → 9.3/10). Timing source: Mau's Oct 19 notebook.
