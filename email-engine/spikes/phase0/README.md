# Phase 0 spikes: how to run them

These are throwaway tests, run in **your** Google account (mauricio@). They never touch the portal. The few test emails go only to you, and each is tagged `[EE spike]`. Results land in a spreadsheet the script creates: **EE Phase 0 Spike Results**.

Total hands-on time is about 10 minutes, plus about 80 minutes of waiting for spike 2c, which runs on its own.

## Setup (once, ~2 min)
1. Go to https://script.google.com and click **New project**. Name it `EE Phase 0 Spikes`.
2. Delete the sample code, then paste in all of `Code.gs` (this folder).
3. For spike 5: open the portal's Settings spreadsheet (the one the portal's Apps Script is attached to). Copy the long ID from its URL (`/d/<ID>/edit`) and paste it between the quotes on the `SETTINGS_SS_ID` line. This spike only reads; it changes nothing.
4. Click **Save**.

## Run (pick a function from the dropdown next to ▶ Run)
The first run asks for permissions: Gmail, Sheets, Drive, triggers. Approve them; it's your own project.

| Step | Function | Time | What happens |
|---|---|---|---|
| 1 | `spike2_sendLatency` | ~3 min | Sends you 8 test emails and measures how long each takes to show up in Sent search |
| 2 | `spike2c_install` | instant | Starts 8 background runs, one every 10 min. Each is deliberately cut off mid-send. **Leave it alone ~80 min** |
| 3 | `spike2d_headers` | ~30 s | Reads the headers of a few existing auto-replies and bounces (read-only) |
| 4 | `spike3_setup` | ~30 s | Creates two scratch spreadsheets |
| 5 | `spike3_run` | ~4 min | A practice send loop (no real emails) while unsubscribes are fired at it |
| 6 | `spike3_report` | ~10 s | Checks the unsubscribe rule held and measures lock times |
| 7 | `spike5_checkComms` | ~5 s | Checks that the shared opt-out tabs exist in Settings |
| 8 | `spike2c_report` | ~30 s | **After the 80 minutes:** what each cut-off send left behind |
| 9 | `spike_cleanup` | ~10 s | Removes the background trigger and leftover test drafts |

Steps 3–7 can run while step 2 is waiting.

## When you're done
Send me the link to **EE Phase 0 Spike Results** (or share it with me read-only). I'll write the findings into `email-engine/docs/SPIKES.md` and update the plan's Guarantees section to match.

Expect a couple of `[EE spike]` emails in your inbox and Sent folder. Search `[EE spike]` to delete them afterwards. Some background runs will show "Exceeded maximum execution time" errors in the Executions list; that's intended, it's the cut-off being tested.
