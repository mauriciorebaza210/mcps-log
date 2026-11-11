# Lifecycle Email walkthrough (Mau only)

About 15 minutes. Everything runs in **test mode** and every email goes to **your** plus-addresses (`mauricio+demo…@`). Nothing reaches Tony or a customer.

Do it in the Chrome window that's signed in to Vercel. The emails' links point at the preview site, which sits behind Vercel's login, so clicks only work there. Open your Gmail in that same window.

## Setup (2 minutes)

1. In Tony's Apps Script, run **`eeDemoSetup`**. The log lists three addresses:
   - `mauricio+demo1b1@`: MCP Legacy, you'll **click** this one
   - `mauricio+demo1b2@`: MCP Legacy, you'll **reply** to this one
   - `mauricio+demo1c1@`: MCP Startup (startup in 3 days)
2. Open the preview → **Lifecycle Email**.

## Walkthrough

| # | Do | What should happen |
|---|---|---|
| 1 | **Run now** → confirm | "Run finished · 3 sent": 2 intros and 1 welcome in your inbox, from Tony's address |
| 2 | Open the intro to **…demo1b1** → tap **Get your free quote** | The quote page opens. On the Intro's **Recipients** tab: **Verified click** |
| 3 | **Run now** | **Contacts** → Mau Click 1: **Stopped · clicked**. No follow-up will ever go to it |
| 4 | Reply to the intro to **…demo1b2** ("Sounds good") | |
| 5 | **Run now** | Mau Reply 1: **Stopped · replied**, and your reply text on the Intro's Recipients tab |
| 6 | Open the welcome to **…demo1c1** → **Unsubscribe** → **Unsubscribe** | "You're unsubscribed". After the next run: **Stopped · unsubscribed** |
| 7 | **Activity** | Health, the runs you just made, and every action with your name under **Changes**. Try the **MCP Startup** switch off and on |

Gmail may group the two intros into one conversation, because they have the same subject. Expand the one sent to the right address before you click or reply.

## Run it again

Run **`eeDemoSetup`** again for a fresh round (`…demo2…`). Old demo contacts stay as test data and only ever reach your addresses.
