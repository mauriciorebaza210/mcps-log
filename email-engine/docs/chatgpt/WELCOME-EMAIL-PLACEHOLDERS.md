# MCPS Welcome Email: placeholders and Drive upload (for ChatGPT)

Version: 1 (2026-11-16). Applies to the **MCP Startup → Welcome Email** (`step_id` `c_welcome`).
Read this together with `START HERE - ChatGPT instructions.txt` in the **MCPS Marketing** folder. Where the two differ for the Welcome Email, this file wins.

Everything below was checked against the engine's code (`Lib_EmailRender.js` `renderFull()`, `Templates.js`, the `Fields` tab). Rules marked **(blocks)** are enforced: a template that breaks one is rejected when Tony opens it in the portal, and nothing is sent.

---

## 1. What the Welcome Email is

- Goes to the owner of a brand-new pool whose startup MCPS is doing. The person is added automatically when the startup is approved and scheduled in the portal.
- Category: **service** (not marketing). It goes out when the startup is approved, or N days before the startup date, depending on the current ruleset; it never goes out later than 1 day before the startup.
- Purpose: welcome them, confirm the startup date and the pool address, tell them what to expect, and give them a way to reach us. It is **not** a sales email: no quote button.

## 2. Placeholders you may use

Write placeholders exactly as shown: double curly braces, exact capitalization, no spaces needed. The engine replaces each one per person at send time and HTML-escapes the value.

| Placeholder | Filled with | If the value is empty | Example output |
|---|---|---|---|
| `{{FirstName}}` | Contact's `first_name`. For couples/families it already holds the greeting form ("John and Mary", "Smith family") | Becomes `there` | `Hi Maria,` / `Hi there,` |
| `{{LastName}}` | Contact's `last_name` | Becomes empty text | `Garcia` |
| `{{Address}}` | Pool street address. For startups this **already includes the city** (e.g. `123 Oak Hill Dr, Boerne`) | **Send fails** (required) | `123 Oak Hill Dr, Boerne` |
| `{{StartupDate}}` | The first startup day, formatted as weekday + month + day, **no year** | **Send fails** (required) | `Wednesday, November 18` |
| `{{SenderName}}` | The sign-off name set in the portal (Emails → From) | **Send fails** (required) | `Tony` |

Two link placeholders also exist. They go **only** inside `href="…"`:

| Placeholder | Use | Rule |
|---|---|---|
| `{{UnsubscribeLink}}` | `<a href="{{UnsubscribeLink}}">Unsubscribe</a>` in the footer | **Required (blocks)**, even though the Welcome is a service email |
| `{{QuoteLink}}` | The tracked "request service / free quote" button | **Do not use in the Welcome Email.** It belongs to the marketing emails |

### Writing with them

- Greeting: `Hi {{FirstName}},`. Don't write `Hi {{FirstName}} {{LastName}},`: `first_name` may already be "John and Mary".
- Startup date sentence: `Your pool startup begins on {{StartupDate}}.` Don't add a year, a weekday or "the" around it; the value already reads as `Wednesday, November 18`.
- Address: `at {{Address}}`. Don't append a city, state or ZIP; the city is already in the value and the other two aren't available.
- `{{LastName}}` is optional and can be empty, so never make a sentence depend on it ("Dear Mr. {{LastName}}" would read "Dear Mr. ," when it's empty).
- Sign-off: `{{SenderName}}` followed by `Mission Custom Pool Solutions`.

### Where placeholders may go

| Place | Allowed? |
|---|---|
| Visible text in the body (paragraphs, headings, table cells) | Yes |
| The `<title>` (the portal suggests it as the subject line) | Yes, but keep the subject free of placeholders, see below |
| Inside a URL, e.g. a Google Maps link built from `{{Address}}` | **No.** The value is HTML-escaped, not URL-encoded, and every link is rewritten for click tracking; the link will break |
| `alt=""` text of an image | Avoid |
| HTML comments | **No.** The engine still sees the `{{ }}` and rejects unknown names inside them |

**Subject line:** keep it without placeholders (e.g. `Welcome to Mission Custom Pool Solutions`). `{{FirstName}}` would produce "Welcome, there" for contacts with no first name.

## 3. Placeholders that do NOT exist (blocks)

Any other `{{Name}}` is rejected with `unknown field {{Name}}`, and any leftover `{{` or `}}` is rejected with `unresolved {{ }} left in the email`. In particular:

| You might want | Status | Write instead |
|---|---|---|
| `{{Technician}}` / technician name | **Not available.** The portal does not send the assigned technician to the email engine today | "your MCPS technician" / "our technician will complete your startup following our standard procedures" |
| `{{City}}`, `{{State}}`, `{{Zip}}` | Not available as placeholders | Nothing; `{{Address}}` already includes the city |
| `{{Phone}}`, `{{Email}}` (the customer's) | Not available | Don't reference the customer's contact details |
| `{{PoolId}}`, `{{QuoteId}}` | Not available | Don't reference them |
| `{{details}}`, `{{block:PoolSchool}}`, `{{button:…}}` | Exist only in the portal's own editor, **not** in complete HTML files from ChatGPT (blocks) | Write the content directly in the HTML (see §5) |

If Tony asks for one of these, tell him it needs a change in the engine first (Mau can add it), and use the "Write instead" wording until then. Never invent a placeholder or type a real customer's name, address or date into the template.

## 4. Template rules the engine enforces (blocks)

The file is a **complete HTML document** (the engine calls this format `full`). It is checked like this:

1. Contains `<html …>`, `<body …>` and `</body>`.
2. The footer shows the business address, word for word: **`4640 South Flores Road, Elmendorf, TX 78112`**. The check ignores tags, case and extra spaces, but not wording: `Rd` instead of `Road`, or a missing comma, fails.
3. Contains `{{UnsubscribeLink}}` (as `<a href="{{UnsubscribeLink}}">Unsubscribe</a>`).
4. No `<script>`, `<iframe>`, `<form>`, `<object>`, `<embed>`, and no `on…=` attributes (`onclick`, `onload`, …).
5. `<link>` tags only for `https://fonts.googleapis.com/…`.
6. Every `<img>` has an `https://` `src` and an `alt="…"` attribute. Logo: `https://mcps-email-assets.vercel.app/mcps-lockup-badge.png` (214 × 59).
7. Only the placeholders in §2. No other `{{` or `}}` anywhere outside a `<style>` block.
8. File under 200 KB.

Also follow the design and voice rules in START HERE (600 px table layout, inline styles, brand colors, Montserrat/Open Sans with Arial fallback, short paragraphs, no emojis, no ALL CAPS, never list service tasks). The engine adds the open-tracking pixel and a small reference line before `</body>` by itself; don't add your own tracking.

## 5. Welcome Email content guide

Suggested structure:

1. Logo header.
2. Headline: welcome to the Mission family (the mantra "Every pool matters." may appear once).
3. `Hi {{FirstName}},` plus one or two sentences: the pool is almost ready for its first swim; MCPS will handle the startup.
4. A light-gray details panel (`#F3F5F6`), written in HTML:
   - **Startup begins:** `{{StartupDate}}`
   - **Pool address:** `{{Address}}`
5. What to expect: a technician will complete the startup following our standard procedures over the first days, and they'll get a short update every week during the first month. Don't list chemicals, steps or tasks.
6. Pool School: the portal version shows a Pool School section only to customers who asked for it. A ChatGPT file can't do that conditionally, so either leave Pool School out, or mention it in neutral terms that make sense to everyone (e.g. "Ask us about a short Pool School session when your technician visits").
7. Questions: "Just reply to this email, or call us at (210) 559-2073." Phone link: `<a href="tel:+12105592073">(210) 559-2073</a>` (tel: links are not tracked or rewritten).
8. Sign-off: `{{SenderName}}`, Mission Custom Pool Solutions.
9. Footer: company name, `4640 South Flores Road, Elmendorf, TX 78112`, `<a href="{{UnsubscribeLink}}">Unsubscribe</a>`.

No `{{QuoteLink}}` button, no prices, no promotions.

## 6. What to hand back

1. The complete `.html` file (from `<!DOCTYPE html>` to `</html>`), nothing else inside it. Put the subject line in `<title>` too; the portal pre-fills it from there.
2. Outside the file, in the chat: the **subject line** (under 50 characters, no placeholders) and the **preview text** (under 90 characters, may use `{{FirstName}}` but better without). Tony pastes these into the portal.
3. A one-line list of the placeholders the file uses.

Before handing it back, check the file yourself against §3 and §4: search it for `{{` and confirm every hit is one of `FirstName`, `LastName`, `Address`, `StartupDate`, `SenderName`, `UnsubscribeLink`; confirm the exact footer address; confirm every `<img>` has `https://` and `alt`.

## 7. Putting the file in Google Drive

**Destination folder (Tony's Drive):**
`MCPS Marketing` › `Email Templates` › `MCP Startup` › `1 - Welcome Email`

This is the only folder the portal reads for the Welcome Email. A file anywhere else (My Drive root, the `MCP Startup` folder itself, or another email's folder) won't show up for this email.

**File requirements**

- File name ends in `.html`, e.g. `welcome-email-2026-11-16-v1.html`. Use a **new name for every version** (date + `v2`, `v3`…); never overwrite or rename a file that's already there, because Tony may have imported it.
- It must be a plain HTML file (MIME type `text/html`), **not** a Google Doc. Don't use "Open with Google Docs" or any convert/import option: a Google Doc isn't an `.html` file, and the portal ignores it.
- UTF-8 text. Use HTML entities (`&rsquo;`, `&mdash;`) or plain characters; both work.

**If your Google Drive tool can create files:** create the file with the content above, name and MIME type `text/html`, with the parent folder set to `1 - Welcome Email` (find it by searching Drive for the folder name `1 - Welcome Email` inside `MCP Startup`). Then tell Tony the file name.

**If your Drive tool is read-only (most ChatGPT Drive connectors are):** give Tony the file as a downloadable `.html` file and tell him:
1. Download the file.
2. In Google Drive, open MCPS Marketing › Email Templates › MCP Startup › 1 - Welcome Email.
3. Drag the file into that folder (or New → File upload). Keep the `.html` name; if Drive asks to convert it, say no.

**Never write anywhere under the `MCPS Email Engine` folder** (`Drafts`, `Revisions`, `Attachments`, `Backups`). Those are the engine's own copies; editing them makes the approved email fail its fingerprint check instead of sending. Never edit the engine spreadsheets either.

## 8. What Tony does next (so you can guide him)

1. Portal (mcps-log.vercel.app) → **Lifecycle Email** → **Emails** → **Welcome Email** → **Templates**.
2. The new file is listed there. Opening it runs the same checks as §4 and shows a preview with sample data. If it lists errors, paste them back to ChatGPT to fix, and save the fix as a new file.
3. **Make draft**: confirm the **Subject line** and **Preview text (optional)** fields.
4. **Approve** to make it the live version. Nothing is sent before this step, and approving freezes a copy, so later changes to the Drive file don't affect the live email.

Common errors and what they mean:

| Error shown in the portal | Fix |
|---|---|
| `unknown field {{Technician}}` (or any name) | Remove that placeholder (see §3) |
| `unresolved {{ }} left in the email` | A stray `{{` or `}}`, or a placeholder in an HTML comment |
| `the template must show the business address (…) in its footer` | Use the exact address text from §4 |
| `the template needs an unsubscribe link` | Add `<a href="{{UnsubscribeLink}}">Unsubscribe</a>` |
| `every image must load from an https:// URL` / `needs alt text` | Fix that `<img>` |
| `a complete file needs <body> … </body>` | Return the full document, not a fragment |
| `missing required Address` / `StartupDate` (at send time, not in the preview) | That customer's record is missing the value in the portal; fix the startup in the portal, not the template |
