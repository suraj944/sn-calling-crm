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

`index.html` is a single self-contained page published as a Claude artifact. It reads and writes the sheet through the viewer's own **Google Sheets connector** on claude.ai (`get_values`, `update_values`, `append_values`), so no API keys are stored in the code.

Each user needs:
1. The artifact shared with them on claude.ai
2. The Google Sheets connector added in claude.ai → Settings → Connectors
3. Edit access to the Google Sheet

If the page can't reach the sheet, for example when opened as a plain file, it shows a banner and runs on sample data that is **not saved**.

## Notes
- "Viewing as" is a role picker, not a login. A next step would be an Email column in *Employees* so each person only sees their own leads.
- The Call button dials on phones, or on desktops that have a calling app set up. The number is always shown so it can be dialled by hand.
