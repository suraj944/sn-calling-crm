# SN Calling CRM

A lightweight calling CRM for a tele-calling team. A manager assigns lists of names and numbers to employees, employees tap **📞 Call** to open their phone's dialer, and after each call they log an outcome, a remark and an optional callback time. Everything is stored in a Google Sheet.

## Features

**Admin / Manager**
- Dashboard: total leads, unassigned, calls today, interested, converted, pending callbacks, and progress per employee
- Leads & Assign: search, multi-select, assign or unassign leads to an employee, or auto-distribute all unassigned leads equally
- Add / Import: add one lead, or paste many lines (`Name, Number, City`) straight from Excel / Google Sheets
- Employees: add or remove employees (removing one unassigns their leads)
- Call Logs: every call with employee, outcome, remark and follow-up; filter by employee/outcome; copy as CSV

**Employee**
- Own lead list with status filters and search
- Click-to-call (`tel:` link, so it opens the phone dialer); the log form opens automatically after tapping Call
- Outcomes: Interested, Call back later, Not interested, No answer / Busy, Wrong / Switched off, Converted
- Remark and callback date/time; due callbacks are highlighted at the top
- Full call history per lead

## Google Sheet as the database

The sheet ID is set at the top of the script in `index.html` (`SHEET_ID`). The sheet has three tabs:

| Tab | Columns |
|---|---|
| **Employees** | ID · Name · Phone · Active (Yes/No) |
| **Leads** | ID · Name · Phone · City · Assigned To (Emp ID) · Status · Follow-up · Last Remark · Last Called · Created |
| **CallLogs** | Log ID · Date & Time · Lead ID · Customer · Phone · Emp ID · Employee · Outcome · Remark · Follow-up |

- You can also add or edit rows directly in the sheet. *Assigned To* accepts an employee ID (`E1`) or name.
- Dates are written as `YYYY-MM-DD HH:mm`.
- Status values must match the outcome labels above (or `New`).

## How it runs

`index.html` is a single self-contained page that works in two places:

### 1. As a website (GitHub Pages): uses a Google Apps Script
**Live site:** https://suraj944.github.io/sn-calling-crm/

One-time setup by the admin:
1. Open the Google Sheet → **Extensions → Apps Script**.
2. Replace the contents of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs) and set `API_KEY` to your own long secret.
3. **Deploy → New deployment → Web app**. Set *Execute as*: **Me** and *Who has access*: **Anyone**. Authorize it and copy the **Web app URL**.
4. Open the website → **⚙ Connect sheet** → paste the URL and the key → **Save & connect**.
5. In the same dialog, click **Copy setup link** and send that link to employees. Opening it connects their phone automatically.

The key is never stored in this repo; each device keeps it in its own browser storage. Anyone who has the setup link can read and edit the CRM data, so share it only with your team. To revoke access, change `API_KEY` in Apps Script and redeploy (**Manage deployments → Edit → New version**).

> After you change `Code.gs`, always redeploy as a **new version**, or the website keeps using the old code.

### 2. As a Claude artifact: uses the claude.ai Google Sheets connector
Opened inside claude.ai, the page reads and writes through the viewer's own Google Sheets connector (`get_values`, `update_values`, `append_values`). Each user needs the artifact shared with them, the Google Sheets connector added, and edit access to the sheet.

If the page isn't connected to the sheet, it shows a banner and runs on sample data that is **not saved**.

## Notes
- "Viewing as" is a role picker, not a login. A next step would be an Email column in *Employees* so each person only sees their own leads.
- The Call button dials on phones, or on desktops that have a calling app set up. The number is always shown so it can be dialled by hand.
