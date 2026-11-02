# Spike 1: run the engine as Tony

Checks the engine can live in Tony's account and always send as him, even when Mau updates the code. It sends no email. About 15 minutes.

**Use a separate window for Tony.** Open a Chrome *Guest* window or a separate Chrome profile and sign in there as antonio@. Apps Script gets confused when two accounts are signed in to the same window, and it can silently act as the wrong one.

## Part A: as Tony (in the Tony window)
1. Go to https://sheets.new. Name the spreadsheet **MCPS Email Engine**.
2. **Extensions → Apps Script.** Name the project **MCPS Email Engine**. Delete the sample code, paste in all of `Spike1.gs` (this folder), and save.
3. Choose `spike1_whoamiEditor` and click **Run**. Approve the permissions *as Tony* (Advanced → Go to MCPS Email Engine, if Google warns).
4. **Deploy → New deployment.**
   - Gear icon → **Web app**
   - Execute as: **Me (antonio@mcpoolsolutions.org)**
   - Who has access: **Anyone**
   - Click **Deploy**, then copy the **Web app URL**.
5. Choose `spike1_installTrigger` and click **Run**.
6. Back in the spreadsheet, click **Share**:
   - add **mauricio@mcpoolsolutions.org** as **Editor**
   - add **mcps-portal-sheets@radiant-poet-487216-g8.iam.gserviceaccount.com** as **Viewer** (the portal's service account, for the read-speed spike), and untick "Notify people"
7. In the Apps Script editor, click the **gear (Project Settings)** and copy the **Script ID**.

**Send me:** the Web app URL, the Script ID, and the spreadsheet's URL. I'll call the web app from here to check it answers as Tony.

## Part B: as yourself (your normal window, mauricio@)
Do these after I confirm Part A.
1. Open the **MCPS Email Engine** spreadsheet (it's under "Shared with me"). **Extensions → Apps Script.**
2. Change `SPIKE1_VERSION = 'v1'` to `'v2'` and save.
3. **Deploy → Manage deployments** → pencil icon on the web app → **Version: New version** → **Deploy**. Tell me when that's done; I'll call the web app again.
   - If the Manage deployments screen won't let you edit Tony's deployment, that's a result too. Tell me what it says.
4. Choose `spike1_whoamiEditor` and click **Run** (approve as yourself).
5. Choose `spike1_listTriggers` and click **Run**.

## What we learn
| Check | Hoping for |
|---|---|
| Editor run as Tony (A3) | `antonio@` |
| Web app before Mau's redeploy | `antonio@`, version v1 |
| Web app after Mau's redeploy (B3) | still `antonio@`, version v2. If it says `mauricio@`, Tony has to do every redeploy (fine, just documented) |
| Trigger Tony installed (A5) | `antonio@` |
| Editor run as Mau (B4) | `mauricio@`: this is why the engine's owner guard must refuse to send in that case |
| Triggers Mau can see (B5) | 0: confirms that only the owner can see and manage the engine's triggers |

All results land in the **spike1** tab of the MCPS Email Engine spreadsheet. This project becomes the real engine project later; the spike code is replaced then.
