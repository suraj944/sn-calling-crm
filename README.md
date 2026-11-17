# SN Financial Services – website + Calling CRM

| Page | Link | What it is |
|---|---|---|
| **Home page** | https://suraj944.github.io/sn-calling-crm/ | Public site: every loan type, EMI calculator, *Request a callback* form |
| **Calling CRM** | https://suraj944.github.io/sn-calling-crm/crm/ | Staff login (name + PIN), contact assignment, click-to-call, call remarks |

Callback requests from the home page go straight into the **Calling List** tab of the Google Sheet as new, unassigned contacts (remark starts with "Website enquiry – …"), ready to assign to a Telecaller Executive in the CRM.
Contact details shown on the home page are set in the `CONTACT` block at the bottom of `index.html`.

# SN Calling CRM

**Dashboard** (Admin, Manager, Team Lead): date range (today, yesterday, 7/30 days, this month, all time, custom), KPIs (calls, connected, leads, converted, new contacts, callbacks due), calls-per-day chart, outcome breakdown, telecaller performance table, calling list status and contact sources.

**Teams:** in the Employees tab, column **Team Lead** says who each telecaller reports to (also set in the CRM: Employees → Edit). A Team Lead sees, calls and assigns only their own team's contacts; Admin and Manager see everyone and can filter every page by team. New (unassigned) contacts are given out by Admin / Manager.

**By Employee** tab (Admin, Manager, Team Lead): pick a person to see their calling list, leads and calls, with counts for everyone side by side.

**Lead Cases:** when a telecaller marks a customer **Interested**, a case opens by itself (code like SN2611-0001) in the **Lead Cases** tab of the sheet and goes to that telecaller's Team Lead. The Team Lead follows up and fills Product, Amount, Bank, Banker, Status, Disbursed date and so on. The telecaller can only view the case. Admin and Manager see all cases.

**Access:** *Viewing as* and *Open sheet* are Admin-only. Team Leads get **My Team** (members, last login, reset a member's PIN) and **My calls** (their own list). Nobody can assign contacts to an Admin.

**Words used:** a **contact** is any name + number on the calling list. A **lead** is a contact marked **Interested** on a call (or later Converted). The **Leads** tab in the CRM and the **Leads** tab in the sheet show only these.

**Field Work** (everyone): Sales Managers log their meetings with the same 16 fields as the old Google Form (Timestamp, SM Name, Meeting Type, Meeting Entity, Name of the CP/Developer/Customer/Connector, Name of The Entity, Willing to work with SN, Existing % received in market if any, Contact no of the Entity, Purpose of Meeting, Meeting Outcome, Remarks, Any Tieup currently?, If Yes Tie up with which company, Interested / Not interested, Current pass back received, Feedback). Names are saved in proper case automatically (SBI, HDFC etc. kept in capitals). Each SM sees and edits only their own entries; Admin / Manager / Team Lead see and edit everyone's; Admin / Manager can delete. Stored in the **Field Work** tab of the CRM sheet.

**⬇ Reports** (Admin, Manager): Excel/CSV downloads for the selected period – Full report workbook (Summary, Leads, Telecaller performance, Call log, Calling list, Website enquiries, Pending callbacks, Field work), Leads (interested customers), Call log (filter by telecaller/outcome), Telecaller performance, Calling list, Website enquiries, Field work, Pending callbacks.

A lightweight calling CRM for a tele-calling team. A manager assigns lists of names and numbers to employees, employees tap **📞 Call** to open their phone's dialer, and after each call they log an outcome, a remark and an optional callback time. Everything is stored in a Google Sheet.

## Features

**Admin / Manager**
- Dashboard: total leads, unassigned, calls today, interested, converted, pending callbacks, and progress per employee
- Leads: customers marked Interested / Converted, filter by date, telecaller and status; tick cases and **assign** them to a telecaller (Admin, Manager and Team Lead)
- In any customer's call window, Admin / Manager / Team Lead can change **Assigned to** directly
- Calling List & Assign: search, multi-select, assign or unassign contacts to a telecaller, or auto-distribute all unassigned contacts equally
- Add / Import Contacts: add one contact, or paste many lines (`Name, Number, City`) straight from Excel / Google Sheets
- Employees: add or remove employees (removing one unassigns their contacts)
- Call Logs: every call with employee, outcome, remark and follow-up; filter by employee/outcome; copy as CSV

**Employee**
- Own calling list with status filters and search, plus a **My leads** tab (interested customers)
- Click-to-call (`tel:` link, so it opens the phone dialer); the log form opens automatically after tapping Call
- Outcomes: Interested, Call back later, Not interested, No answer / Busy, Wrong / Switched off, Converted
- Remark and callback date/time; due callbacks are highlighted at the top
- Full call history per contact

## Google Sheet as the database

The sheet ID is set at the top of the script in `index.html` (`SHEET_ID`). The sheet has three tabs:

| Tab | Columns |
|---|---|
| **Employees** | ID · Name · Phone · Active (Yes/No) |
| **Calling List** | ID · Name · Phone · City · Assigned To (Emp ID) · Status · Follow-up · Last Remark · Last Called · Created · Source · Customer request |
| **Leads** | Read-only, fills itself: contacts whose Status is Interested or Converted, with the telecaller's name |
| **CallLogs** | Log ID · Date & Time · Contact ID · Customer · Phone · Emp ID · Employee · Outcome · Remark · Follow-up |

- You can also add or edit rows directly in the sheet. *Assigned To* accepts an employee ID (`E1`) or name.
- Dates are written as `YYYY-MM-DD HH:mm`.
- Status values must match the outcome labels above (or `New`).

## How it runs

### Website (GitHub Pages) with personal logins
**CRM:** https://suraj944.github.io/sn-calling-crm/crm/

Everyone logs in with **their own name and PIN** (no mobile number needed). The Google Apps Script in [`apps-script/Code.gs`](apps-script/Code.gs) checks every login and request, so the rules below are enforced by the server, not just hidden in the page.

| Role | Sees | Can do | Open Google Sheet |
|---|---|---|---|
| **Admin** | Everything | Everything, incl. creating Admins/Managers | ✅ |
| **Manager** | Everything | Assign/import contacts, add/edit Team Leads & Employees, reset their PINs | ✅ |
| **Team Lead** | Full calling list, leads, team dashboard, call logs | Assign/import contacts, log calls | ✅ |
| **Sales Manager** | Own Field Work | Log meetings | ❌ |
| **Telecaller Executive** | Only contacts assigned to them, and their own leads | Call, log outcome + remark | ❌ |

### Credentials database (Google Sheet)

**Employees** tab, one row per person:

| Column | What it is |
|---|---|
| ID | `E1`, `E2`… (or `ADMIN`) – set by the CRM |
| Name (login) | The name they log in with. Unique, case-insensitive |
| Phone (optional) | Contact number only |
| Active | `Yes` / `No` (dropdown). `No` blocks login and unassigns their contacts |
| Role | `Admin` / `Manager` / `Team Lead` / `Telecaller Executive` (dropdown) |
| PIN (4 digits) | Exactly 4 digits, kept as text. Cleared after the next login |
| PIN Hash (auto) | Salted SHA-256 of the PIN – the real PIN is never stored (protected column) |
| Last Login (auto) | Updated on each successful login (protected column) |
| Created | When the account was added |

**Calling List** tab (was called *Leads*) columns: ID · Name · Phone · City · Assigned To · Status · Follow-up · Last Remark · Last Called · Created · **Source** (Website / Import / Manual) · **Customer request** (what a website visitor asked for).

**LoginLog** tab: every login attempt (time, name entered, ID, result: Success / Wrong PIN / Unknown name / Inactive / Locked).
**Roles** tab: what each role can see and do.

- PINs are exactly **4 digits**.
- To give someone a first PIN **or reset a PIN**, type the new 4-digit PIN in the **PIN** column (or use *Reset PIN* in the app, which writes it there too). A PIN in that column always replaces the old one straight away. On their next login it is replaced by a salted SHA-256 hash and the PIN cell is cleared.
- After 5 wrong PINs, that login is locked for 15 minutes. Sessions last 30 days, and a PIN reset logs the person out of all devices.
- Anyone can change their own PIN with **🔑 PIN**.
- **Open sheet** only works for people whose Google account also has access to the sheet, so share the sheet with your managers and team leads.

**One-time deployment:** open the sheet → Extensions → Apps Script → paste `Code.gs` → Deploy → New deployment → Web app (Execute as: **Me**, Who has access: **Anyone**) → copy the `/exec` URL into `BUILTIN_API` at the top of the script in `crm/index.html` (and `API` in the home page `index.html`). After editing `Code.gs`, redeploy via **Manage deployments → Edit → New version**.

### Claude artifact (claude.ai)
Inside claude.ai the page uses the viewer's own Google Sheets connector and gives full (admin) access. Use it only for people who already have edit access to the sheet.

## Notes
- The Call button dials on phones, or on desktops that have a calling app set up. The number is always shown so it can be dialled by hand.
