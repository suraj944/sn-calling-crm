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

### Website (GitHub Pages) with personal logins
**Live site:** https://suraj944.github.io/sn-calling-crm/

Everyone logs in with **their own name and PIN** (no mobile number needed). The Google Apps Script in [`apps-script/Code.gs`](apps-script/Code.gs) checks every login and request, so the rules below are enforced by the server, not just hidden in the page.

| Role | Sees | Can do | Open Google Sheet |
|---|---|---|---|
| **Admin** | Everything | Everything, incl. creating Admins/Managers | ✅ |
| **Manager** | Everything | Assign/import leads, add/edit Team Leads & Employees, reset their PINs | ✅ |
| **Team Lead** | All leads, team dashboard, call logs | Assign/import leads, log calls | ✅ |
| **Employee** | Only leads assigned to them | Call, log outcome + remark | ❌ |

### Credentials database (Google Sheet)

**Employees** tab, one row per person:

| Column | What it is |
|---|---|
| ID | `E1`, `E2`… (or `ADMIN`) – set by the CRM |
| Name (login) | The name they log in with. Unique, case-insensitive |
| Phone (optional) | Contact number only |
| Active | `Yes` / `No` (dropdown). `No` blocks login and unassigns their leads |
| Role | `Admin` / `Manager` / `Team Lead` / `Employee` (dropdown) |
| PIN (first-time) | 4–8 digits, kept as text. Cleared after first login |
| PIN Hash (auto) | Salted SHA-256 of the PIN – the real PIN is never stored (protected column) |
| Last Login (auto) | Updated on each successful login (protected column) |
| Created | When the account was added |

**LoginLog** tab: every login attempt (time, name entered, ID, result: Success / Wrong PIN / Unknown name / Inactive / Locked).
**Roles** tab: what each role can see and do.

- To give someone a first-time PIN, type it in the **PIN** column (or use *Reset PIN* in the app). On their first login it is replaced by a salted SHA-256 hash and the PIN cell is cleared.
- After 5 wrong PINs, that login is locked for 15 minutes. Sessions last 30 days, and a PIN reset logs the person out of all devices.
- Anyone can change their own PIN with **🔑 PIN**.
- **Open sheet** only works for people whose Google account also has access to the sheet, so share the sheet with your managers and team leads.

**One-time deployment:** open the sheet → Extensions → Apps Script → paste `Code.gs` → Deploy → New deployment → Web app (Execute as: **Me**, Who has access: **Anyone**) → copy the `/exec` URL into `BUILTIN_API` at the top of the script in `index.html`. After editing `Code.gs`, redeploy via **Manage deployments → Edit → New version**.

### Claude artifact (claude.ai)
Inside claude.ai the page uses the viewer's own Google Sheets connector and gives full (admin) access. Use it only for people who already have edit access to the sheet.

## Notes
- The Call button dials on phones, or on desktops that have a calling app set up. The number is always shown so it can be dialled by hand.
