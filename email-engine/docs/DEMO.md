# Lifecycle Email demo for Tony

About 15 minutes. Everything runs in **test mode**: only the demo addresses can receive anything, and no customer is ever emailed.

## The day before: one setting

The emails' links point at the preview site, which sits behind Vercel's login. On Tony's phone a click would land on a Vercel sign-in page. Pick one:

- **A. Turn Vercel's protection off for preview deployments during the demo (recommended).** Vercel → mcps-log → Settings → Deployment Protection → Vercel Authentication → off for Preview. Turn it back on right after. Clicks, opens and unsubscribes then work from any phone. The preview behaves like the live portal: it still needs a portal login.
- **B. Do the clicking from your laptop.** Use a Chrome window signed in to Vercel (it can open Tony's demo email in Gmail on the web). Replies still come from Tony's phone. Opens won't be counted.

## 10 minutes before: rehearse

1. In Tony's Apps Script, run **`eeDemoSetup`**. The log lists four addresses:
   - `antonio+demo1b@` (MCP Legacy) and `antonio+demo1c@` (MCP Startup)
   - `mauricio+demo1b@` and `mauricio+demo1c@`
2. Open the portal preview → **Lifecycle Email** → **Run now**. Within a minute or two: "Run finished · 4 sent".
3. Check that the emails arrived on both phones. Then run **`eeDemoSetup`** again, so the real demo starts from a clean round 2.

## The demo

| # | Do | Show / say | What happens |
|---|---|---|---|
| 1 | Open **Lifecycle Email** | Two sequences, each email's status and numbers. Click **MCP x MCPS Intro** → **Setup** | The schedule in words and what stops it. Only approved emails are live |
| 2 | **Run now** → confirm | "Every morning at 9 this runs on its own" | "Run finished · 4 sent". Tony's phone gets the MCP intro and the startup welcome, from his own address |
| 3 | Tony opens the **intro** and taps **Get your free quote** | The quote page opens | The Intro's **Recipients** tab shows **Verified click** for Tony right away |
| 4 | **Run now** | "A real click stops the sequence, so he never gets a follow-up" | **Contacts** → Tony Demo: **Stopped · clicked** |
| 5 | Mau replies to **his** intro from his phone ("Sounds good") | | |
| 6 | **Run now** | "Replies stop it too. An out-of-office wouldn't" | Mau Demo: **Stopped · replied**. The reply text shows on the Intro's Recipients tab |
| 7 | Tony taps **Unsubscribe** on the **welcome** email → **Unsubscribe** | "One click, and it's recorded before the page answers" | "You're unsubscribed". That address never gets another email |
| 8 | **Activity** tab | Health, runs, and every action with who did it. The **MCP Startup** switch pauses one sequence | |

Things worth saying while it runs:
- Every email goes out from Tony's Gmail and lands in his Sent folder like any email he writes.
- If something goes wrong mid-send, it never sends twice. Anything unclear shows up under **Needs a decision** for a person to settle.
- Opens are estimates (phones prefetch images). Only verified clicks and replies count as interest.

## After

- Option A: turn Vercel's preview protection back on.
- The demo contacts stay in the engine as test data. They're harmless and only ever reach the demo addresses.
