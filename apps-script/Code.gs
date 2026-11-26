/**
 * SN Calling CRM – Google Apps Script backend (personal logins + roles)
 *
 * SETUP (one time):
 *  1. Open the Google Sheet → Extensions → Apps Script.
 *  2. Delete everything in Code.gs, paste this whole file, click Save (💾).
 *  3. Deploy → New deployment → ⚙ → Web app
 *       Execute as:      Me
 *       Who has access:  Anyone
 *     Deploy → Authorize access → choose your account → Advanced → Go to project → Allow.
 *  4. Copy the Web app URL (ends in /exec) – the website uses it.
 *  After changing this code later: Deploy → Manage deployments → ✏ → Version: New version → Deploy.
 *
 * Employees tab = the credentials database:
 *   ID | Name (login) | Phone | Active | Role | PIN (4 digits) | PIN Hash (auto) | Last Login (auto) | Created | Team Lead
 *   - Each Team Lead has a tab "Team – <name>" (made automatically) showing only their team; "Open sheet" opens it for them.
 *   - Team Lead (column J): the Team Lead this person reports to (name or ID). A Team Lead only sees, calls and assigns
 *     contacts of their own team. Admin and Manager see everyone. New contacts are given out by Admin / Manager.
 *   - People log in with their NAME + PIN. Names must be unique (case doesn't matter).
 *   - Role: Admin, Manager, Team Lead, Sales Manager or Telecaller Executive (see the Roles tab).
 *     Old "Employee" values are treated as Telecaller Executive.
 *   - PIN: exactly 4 digits. Type it in the PIN column for a new person OR to reset someone's PIN –
 *     a PIN typed here always wins over the old one. The PIN stays visible here (only Admin opens the sheet from the CRM).
 * LoginLog tab: every login attempt (time, name entered, result).
 * Website enquiries (home page callback form) are added to the Calling List as new, unassigned contacts.
 * "Leads" tab = read-only view of customers marked Interested / Converted (a FILTER formula on the Calling List).
 * Lead Cases tab: when a customer is marked Interested, a case is opened for the telecaller's Team Lead, who follows it up
 *   (product, amount, bank, status, disbursal …). The telecaller can only view the case from then on.
 * Field Work tab: SM meetings (same fields as the old Google Form) – see saveMeeting_.
 * Calling List tab (all contacts to call; was "Leads") column K "Source" = Website / Import / Manual, column L "Customer request" = what a website visitor asked for.
 */

const ROLES = ["Admin", "Manager", "Team Lead", "Sales Manager", "SM - Field work", "Telecaller Executive"];   // 11.16: SM - Field work
// ---- Permission levels: each role starts with its defaults; Admin can tick/untick extras per person
// (saved in Employees column K as e.g. "+reports, -doAssign"). Admin always has everything.
const PERM_KEYS = ["dash", "lead", "cases", "byemp", "assign", "import", "team", "logs", "meet", "conn", "reports", "perf",
  "doAssign", "caseEdit", "caseTL", "caseRemove", "empEdit", "pinReset", "sheet", "viewAs", "caseTransfer", "targetEdit", "scopeTeam", "scopeAll",
  "today", "eod", "pDay", "pList", "pInt", "pLoan", "pCalls", "pMeet", "pConn", "leadForm"];   // 11.16: leadForm = fill the lead form without the Lead Cases tab   // 11.15: Today, EOD Report and each tab of a person's own page
const PAGE_KEYS = ["pDay", "pList", "pInt", "pLoan", "pCalls", "pMeet", "pConn"];  // on for everyone unless Admin switches one off
const TAB_KEYS = PERM_KEYS.slice(0, 12).concat(["eod"]);
const ROLE_PERMS = {
  "Manager":   ["dash", "lead", "cases", "byemp", "assign", "import", "team", "logs", "meet", "conn", "reports", "eod", "doAssign", "caseEdit", "caseTL", "empEdit", "pinReset", "scopeAll"],
  "Team Lead": ["dash", "lead", "cases", "byemp", "assign", "import", "team", "logs", "meet", "conn", "doAssign", "caseEdit", "pinReset", "scopeTeam"],
  "Sales Manager": [],            // own field work page – Admin can add tabs / actions / wider data
  "SM - Field work": ["leadForm"], // field work + connectors + lead form (cases go to their Team Lead)
  "Telecaller Executive": []      // own calling page – Admin can add tabs / actions / wider data
};
const NOT_EMP = PERM_KEYS.filter(k => k !== "empEdit");     // only Managers can be allowed to add / edit / remove employees
const PERM_ALLOWED = { "Manager": PERM_KEYS, "Team Lead": NOT_EMP, "Sales Manager": NOT_EMP, "SM - Field work": NOT_EMP.filter(k => k !== "pinReset"), "Telecaller Executive": NOT_EMP.filter(k => k !== "pinReset") };
const ROLE_PAGE_OFF = { "SM - Field work": ["pDay", "pList", "pCalls"] };   // page tabs a role starts without   // what Admin may tick per role
// Whose data someone sees: "all", "team" (their Team Lead's team) or "own"
function scope_(e) { const p = perms_(e); return p.has("scopeAll") ? "all" : p.has("scopeTeam") ? "team" : "own"; }
function hasDesk_(e) { const p = perms_(e); return rank_(e.role) <= rank_("Team Lead") || TAB_KEYS.some(k => p.has(k)); }
function teamOf_(e, emps) {
  if (e.role === "Team Lead") return teamIds_(e, emps);
  const tl = e.tl && emps.find(x => x.id === e.tl);
  return tl ? teamIds_(tl, emps) : new Set([e.id]);
}
// null = can see everyone; otherwise the set of employee IDs this person may see / work with
function limit_(me, emps) { const sc = scope_(me); return sc === "all" ? null : sc === "team" ? teamOf_(me, emps) : new Set([me.id]); }
// Designations typed by Admin (e.g. "Operations Executive") work like a Telecaller: own page, then Admin adds access with Permissions
const basePerms_ = role => (ROLE_PERMS[role] || []).concat(["today"], PAGE_KEYS.filter(k => (ROLE_PAGE_OFF[role] || []).indexOf(k) < 0));
const allowedPerms_ = role => PERM_ALLOWED[role] || PERM_ALLOWED["Telecaller Executive"];
const isCustomRole_ = role => ROLES.indexOf(role) < 0;
function roleOf_(raw) {                       // what's in the sheet → role
  const v = String(raw || "").trim();
  if (!v || /^employee$/i.test(v)) return "Telecaller Executive";
  return ROLES.find(x => x.toLowerCase() === v.toLowerCase()) || v;
}
function cleanRole_(raw) {                    // what Admin typed / picked → role to save
  const v = String(raw || "").replace(/[<>"]/g, "").replace(/^[=+\-@']+/, "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!v) return "";
  if (v.length < 2) throw new Error("Type a designation (at least 2 letters)");
  return ROLES.find(x => x.toLowerCase() === v.toLowerCase()) || v;
}
function perms_(e) {
  if (!e) return new Set();
  if (e.role === "Admin") return new Set(PERM_KEYS);
  const set = new Set(basePerms_(e.role)), ok = new Set(allowedPerms_(e.role));
  const raw = String(e.permRaw || "").split(/[,\s]+/);
  raw.forEach(t => { const k = t.slice(1); if (!ok.has(k)) return; if (t[0] === "+") set.add(k); else if (t[0] === "-") set.delete(k); });
  if (set.has("reports") && raw.indexOf("-eod") < 0) set.add("eod");   // EOD Report came with "Reports" before it had its own tick
  return set;
}
function can_(me, key) { if (!perms_(me).has(key)) throw new Error("You don't have permission to do that – ask Admin"); }
const MEET_COLS = 22;   // 11.17: column V = Location (area of the CP / connector / developer)
function meetCols_(sh) {                 // add the Location column to an older sheet the first time it is needed
  if (sh.getMaxColumns() < MEET_COLS) { sh.insertColumnsAfter(sh.getMaxColumns(), MEET_COLS - sh.getMaxColumns()); }
  if (String(sh.getRange(1, MEET_COLS, 1, 1).getDisplayValues()[0][0] || "").trim() === "") sh.getRange(1, MEET_COLS).setValue("Location");
  return MEET_COLS;
}
// Lead Cases tab – column order follows the team's own lead sheet, then a few columns the CRM fills in
const CASE_HDR = ["Timestamp", "SM Name", "Customer Name", "Contact Number", "Product", "Amount Required", "Lead Source",
  "Connector Name", "Connector Contact No", "Connector Location", "Lead Type", "Lead Shared by", "Lead Date", "Monthly",
  "Unique Lead Code", "Bank Name", "Banker Name", "Banker Contact No", "Status", "Remarks", "Disbursed Date", "Disbursed Month",
  "Customer Status", "Contact ID", "Team Lead", "Telecaller ID", "Last updated", "Updated by",
  "Follow-up history", "Next follow-up", "Login date", "Sanction date",
  "Login by", "Sanction by", "Disbursed by", "Sanction amount", "Disbursed amount"];   // columns after Follow-up history are added to the sheet automatically
const CASE_COLS = CASE_HDR.length, C_ = Object.fromEntries(CASE_HDR.map((h, i) => [h, i]));
// what a Team Lead / Manager / Admin may change from the CRM (everything else is filled automatically)
const CASE_EDIT = ["SM Name", "Lead Shared by", "Product", "Amount Required", "Lead Source", "Connector Name", "Connector Contact No", "Connector Location",
  "Lead Type", "Bank Name", "Banker Name", "Banker Contact No", "Status", "Remarks", "Disbursed Date", "Customer Status", "Next follow-up",
  "Login date", "Sanction date", "Sanction amount", "Disbursed amount"];   // 11.14: loan progress dates and amounts
const TARGET_HDR = ["Month", "Employee ID", "Name", "Calls", "Leads", "Cases", "Logins", "Disbursed cases", "Disbursal amount", "Set by", "Set at"];
const SESSION_DAYS = 30;
const MAX_FAILS = 5, LOCK_MIN = 15;

/* ---------------- entry points ---------------- */
function doGet(e) {
  return respond_(() => {
    const me = auth_(e.parameter.token);
    return load_(me);
  });
}

function doPost(e) {
  return respond_(() => {
    const b = JSON.parse((e.postData && e.postData.contents) || "{}");
    if (b.action === "login") return login_(b.login, b.pin);
    if (b.action === "enquiry") {                      // public "Request a callback" form on the home page
      const lk = LockService.getScriptLock(); lk.waitLock(20000);
      try { return enquiry_(b); } finally { lk.releaseLock(); }
    }
    const me = auth_(b.token);
    if (b.action === "logout") { PropertiesService.getScriptProperties().deleteProperty("s:" + b.token); return {}; }
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    let res;
    try { res = act_(me, b); } finally { lock.releaseLock(); }
    if (b.andLoad) res = Object.assign({}, res && typeof res === "object" ? res : {}, { fresh: load_(me) });   // send the fresh data back with the save – one trip instead of two
    return res;
  });
}
function act_(me, b) {
      switch (b.action) {
        case "logCall":   return logCall_(me, b);
        case "assign":    can_(me, "doAssign"); if (!b.to) throw new Error("Choose a telecaller"); return assign_(b.ids || [], b.to, me);
        case "addLeads":  can_(me, "import"); return addLeads_(b.leads || [], me);
        case "checkPhones": can_(me, "import"); return checkPhones_(b.phones || []);
        case "addEmp":    need_(me, "Manager"); can_(me, "empEdit"); return addEmp_(me, b);
        case "updateEmp": need_(me, "Manager"); can_(me, "empEdit"); return updateEmp_(me, b);
        case "resetPin":  can_(me, "pinReset"); return resetPin_(me, b.id, b.pin);
        case "removeEmp": need_(me, "Manager"); can_(me, "empEdit"); return removeEmp_(me, b.id);
        case "changePin": return changePin_(me, b.oldPin, b.newPin);
        case "saveMeeting":   return saveMeeting_(me, b.m || {});
        case "deleteMeeting": need_(me, "Manager"); return deleteMeeting_(b.id);
        case "saveCase":   return saveCase_(me, b.c || {});              // who may edit is checked inside (canEditCase_)
        case "newCase":    return newCase_(me, b.c || {}, !!b.force, String(b.to || ""));
        case "createCase": can_(me, "caseEdit"); return createCaseFor_(me, b.leadId);
        case "removeCase": can_(me, "caseRemove"); return removeCase_(me, b.code);
        case "removeLogs": if (me.role !== "Admin") throw new Error("Only Admin can remove call logs"); return removeLogs_(me, b.ids || []);
        case "transferCase": return transferCase_(me, b.code, b.to, b.note);
        case "transferCases": return transferCases_(me, b.codes || [], b.to);   // Admin (caseTransfer) or the SM who filled the case, while it's still with them
    case "saveTargets": can_(me, "targetEdit"); return saveTargets_(me, b.month, b.list);
        case "setPerms":   need_(me, "Admin"); return setPerms_(me, b.id, b.perms || []);
        case "saveConnector":   return saveConnector_(me, b.c || {}, !!b.force);
        case "removeConnector": if (me.role !== "Admin") throw new Error("Only Admin can remove a connector"); return removeConnector_(me, b.id);
        default: throw new Error("Unknown action: " + b.action);
      }
}

/* ---------------- connectors ---------------- */
// "Connectors" tab: one row per connector meeting. Columns A–N follow the team's own connector sheet; O–S are filled by the CRM.
const CONN_HDR = ["Timestamp", "Date", "SM Name", "Meeting Type", "Connector Type", "Name of The Connector", "Contact no of the Connector",
  "Current business per month (Value)", "No of Files per month", "Area of Operation", "Current Payout", "Payout from?", "Expected payout",
  "Contract form Signed", "Connector ID", "SM ID", "Added by", "Last updated", "Updated by"];
const CONN_COLS = CONN_HDR.length, K_ = Object.fromEntries(CONN_HDR.map((h, i) => [h, i]));
function connSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName("Connectors");
  if (!sh) { sh = ss.insertSheet("Connectors"); sh.getRange(1, 1, 1, CONN_COLS).setValues([CONN_HDR]); sh.setFrozenRows(1); }
  return sh;
}
// rows typed straight into the sheet without an ID get "R<row number>" so they can still be opened and saved
function connAll_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Connectors"); if (!sh) return [];
  const n = sh.getLastRow() - 1; if (n < 1) return [];
  return sh.getRange(2, 1, n, CONN_COLS).getDisplayValues().map((r, i) => { if (!String(r[K_["Connector ID"]]).trim()) r[K_["Connector ID"]] = "R" + (i + 2); return r; })
    .filter(r => String(r[K_["Name of The Connector"]]).trim() || String(r[K_["Contact no of the Connector"]]).trim());
}
function connRows_() { return memo_("conn", connAll_); }
// Admin, Manager and Team Leads see every connector; everyone else sees their own (by SM ID or SM Name)
function connScope_(me, emps) { return me.role === "Admin" || me.role === "Team Lead" || scope_(me) === "all" ? null : limit_(me, emps); }
function canSeeConn_(r, lim, emps) {
  if (!lim) return true;
  if (lim.has(String(r[K_["SM ID"]]).trim())) return true;
  return emps.some(x => lim.has(x.id) && norm_(x.name) === norm_(r[K_["SM Name"]]));
}
function connectorsFor_(me, emps) {
  try { if (me.role === "Sales Manager" && !perms_(me).has("conn")) return [];
    const lim = connScope_(me, emps); return connRows_().filter(r => canSeeConn_(r, lim, emps)); } catch (e) { return []; }
}
function saveConnector_(me, k, force) {
  const c = v => String(v == null ? "" : v).replace(/[<>]/g, "").replace(/^[=+\-@']+/, "").replace(/\s+/g, " ").trim(), t = v => tidyText_(c(v));
  const txt = v => { v = c(v); return v ? "'" + v : ""; };   // kept exactly as typed ("2-3" must not turn into a date, "40%" not into 0.4)
  const name = properName_(c(k.name)).slice(0, 120);
  if (name.length < 2) throw new Error("Enter the name of the connector");
  const ph = phoneKey_(k.phone);
  if (String(k.phone || "").trim() && ph.length < 10) throw new Error("The contact number looks too short – enter 10 digits or leave it empty");
  const emps = emps_(), lim = connScope_(me, emps), sh = connSheet_(), rows = connAll_();
  let idx = -1, rowNo = 0;
  if (k.id) {
    idx = rows.findIndex(r => String(r[K_["Connector ID"]]).trim() === String(k.id));
    if (idx < 0) throw new Error("Connector " + k.id + " not found – it may have been removed");
    if (!canSeeConn_(rows[idx], lim, emps)) throw new Error("You can only edit your own connectors");
    rowNo = /^R\d+$/.test(k.id) ? +k.id.slice(1) : 0;
    if (!rowNo) { const ids = sh.getRange(2, K_["Connector ID"] + 1, sh.getLastRow() - 1, 1).getDisplayValues(); rowNo = ids.findIndex(r => String(r[0]).trim() === String(k.id)) + 2; }
  }
  if (!force && ph.length >= 10) {                       // same number already saved → ask first
    const d = rows.find((r, i) => i !== idx && phoneKey_(r[K_["Contact no of the Connector"]]) === ph);
    if (d) return { saved: false, dup: { id: d[K_["Connector ID"]], name: d[K_["Name of The Connector"]], sm: d[K_["SM Name"]], date: d[K_["Date"]] } };
  }
  const old = idx >= 0 ? rows[idx] : null;
  // who it belongs to: Admin / Team Leads can choose; others always themselves
  let smName = me.name, smId = me.id;
  if (k.sm && (me.role === "Admin" || me.role === "Team Lead" || scope_(me) !== "own")) {
    const e = emps.find(x => norm_(x.name) === norm_(k.sm));
    smName = e ? e.name : properName_(c(k.sm)).slice(0, 60); smId = e ? e.id : "";
  } else if (old) { smName = old[K_["SM Name"]]; smId = old[K_["SM ID"]]; }
  let id = old && !/^R\d+$/.test(old[K_["Connector ID"]]) ? old[K_["Connector ID"]] : "";
  if (!id) { let max = 0; rows.forEach(r => { const m = String(r[K_["Connector ID"]]).match(/^CN-(\d+)$/); if (m && +m[1] > max) max = +m[1]; }); id = "CN-" + (max + 1); }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(k.date || "")) ? k.date : now_().slice(0, 10);
  const yn = /^(yes|no)$/i.test(String(k.signed || "")) ? (String(k.signed)[0].toUpperCase() + String(k.signed).slice(1).toLowerCase()) : "";
  const o = {
    "Timestamp": old ? "'" + old[K_["Timestamp"]] : "'" + now_(), "Date": "'" + date, "SM Name": smName, "Meeting Type": t(k.meetType).slice(0, 60),
    "Connector Type": t(k.connType).slice(0, 60), "Name of The Connector": name, "Contact no of the Connector": text_(c(k.phone).slice(0, 40)),
    "Current business per month (Value)": txt(k.business).slice(0, 40), "No of Files per month": txt(k.files).slice(0, 20), "Area of Operation": t(k.area).slice(0, 120),
    "Current Payout": txt(k.curPayout).slice(0, 40), "Payout from?": t(k.payoutFrom).slice(0, 80), "Expected payout": txt(k.expPayout).slice(0, 40),
    "Contract form Signed": yn, "Connector ID": id, "SM ID": smId, "Added by": old && old[K_["Added by"]] ? old[K_["Added by"]] : me.name,
    "Last updated": "'" + now_(), "Updated by": me.name };
  const row = CONN_HDR.map(h => o[h]);
  if (rowNo >= 2) sh.getRange(rowNo, 1, 1, CONN_COLS).setValues([row]);
  else sh.getRange(sh.getLastRow() + 1, 1, 1, CONN_COLS).setValues([row]);
  return { saved: true, id };
}
function removeConnector_(me, id) {
  const sh = connSheet_(), rows = connAll_(), r = rows.find(x => String(x[K_["Connector ID"]]).trim() === String(id));
  if (!r) throw new Error("Connector " + id + " not found");
  let rowNo = /^R\d+$/.test(id) ? +id.slice(1) : 0;
  if (!rowNo) { const ids = sh.getRange(2, K_["Connector ID"] + 1, sh.getLastRow() - 1, 1).getDisplayValues(); rowNo = ids.findIndex(x => String(x[0]).trim() === String(id)) + 2; }
  if (rowNo < 2) throw new Error("Connector " + id + " not found");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let rm = ss.getSheetByName("Removed Connectors");
  if (!rm) { rm = ss.insertSheet("Removed Connectors"); rm.getRange(1, 1, 1, CONN_COLS + 2).setValues([CONN_HDR.concat(["Removed at", "Removed by"])]); rm.setFrozenRows(1); }
  rm.getRange(rm.getLastRow() + 1, 1, 1, CONN_COLS + 2).setValues([r.map(v => /^[=+\-@]|^\d/.test(String(v)) ? "'" + v : v).concat(["'" + now_(), me.name])]);
  sh.deleteRow(rowNo);
  return { removed: id };
}

/* ---------------- auth ---------------- */
function login_(login, pin) {
  login = String(login || "").trim(); pin = String(pin || "").trim();
  if (!login || !pin) throw new Error("Enter your name and PIN");
  if (!/^\d{4}$/.test(pin)) throw new Error("PIN must be exactly 4 digits");
  const cache = CacheService.getScriptCache(), fk = "fail:" + norm_(login);
  const fails = Number(cache.get(fk) || 0);
  if (fails >= MAX_FAILS) { audit_(login, null, "Locked (too many attempts)"); throw new Error("Too many wrong attempts. Try again in " + LOCK_MIN + " minutes."); }
  const emps = emps_();
  const e = emps.find(x => norm_(x.name) === norm_(login)) || emps.find(x => x.id.toLowerCase() === login.toLowerCase());
  let ok = false;
  if (e && e.active) {
    if (e.pin) {                       // PIN typed in the sheet (new person or a reset) wins over the old hash
      ok = String(e.pin).trim() === pin;
      if (ok) {
        sheet_("Employees").getRange(e.row, 6, 1, 2).setNumberFormat("@").setValues([[pin, hash_(e.id, pin)]]); // PIN stays visible in the sheet
        if (e.hash && e.hash !== hash_(e.id, pin)) logoutAll_(e.id);  // the PIN was changed in the sheet: sign out old devices
      }
    } else if (e.hash) ok = hash_(e.id, pin) === e.hash;
  }
  if (!ok) {
    cache.put(fk, String(fails + 1), LOCK_MIN * 60);
    audit_(login, e, !e ? "Unknown name" : !e.active ? "Inactive account" : "Wrong PIN");
    throw new Error("Wrong name or PIN");
  }
  cache.remove(fk);
  sheet_("Employees").getRange(e.row, 8).setValue(now_());
  audit_(login, e, "Success");
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  Object.entries(props.getProperties()).forEach(([k, v]) => { // tidy expired sessions
    if (k.startsWith("s:")) { try { if (JSON.parse(v).exp < now) props.deleteProperty(k); } catch (x) { props.deleteProperty(k); } }
  });
  const token = Utilities.getUuid() + Utilities.getUuid().slice(0, 8);
  props.setProperty("s:" + token, JSON.stringify({ id: e.id, exp: now + SESSION_DAYS * 864e5 }));
  return { token, me: pub_(e) };
}

function auth_(token) {
  if (!token) throw new Error("AUTH: Please log in");
  const raw = PropertiesService.getScriptProperties().getProperty("s:" + token);
  if (!raw) throw new Error("AUTH: Session expired – please log in again");
  const s = JSON.parse(raw);
  if (s.exp < Date.now()) throw new Error("AUTH: Session expired – please log in again");
  const e = emps_().find(x => x.id === s.id);
  if (!e || !e.active) throw new Error("AUTH: Your account is no longer active");
  return e; // role is re-read from the sheet on every request
}

const rank_ = r => { const i = ROLES.indexOf(r); return i < 0 ? 99 : i; }; // lower = more power
function need_(me, role) { if (rank_(me.role) > rank_(role)) throw new Error("You don't have permission to do that"); }
function canManage_(me, targetRole) { // Managers can't create/edit Admins or other Managers
  if (me.role === "Admin") return;
  if (rank_(targetRole) <= rank_(me.role)) throw new Error("Only an Admin can manage " + targetRole + " accounts");
}

/* ---------------- data ---------------- */
// While building one load, each tab is read once and reused (Lead Cases was read 3 times, Lists twice)
let MEMO_ = null;
function memo_(k, f) { if (!MEMO_) return f(); if (!(k in MEMO_)) MEMO_[k] = f(); return MEMO_[k]; }
function load_(me) { MEMO_ = {}; try { return loadAll_(me); } finally { MEMO_ = null; } }
function loadAll_(me) {
  const emps = emps_(), isLead = hasDesk_(me), lim = limit_(me, emps);
  let leads = rows_("Leads", 12), logs = rows_("CallLogs", 10), people = isLead ? emps : [me];
  const allLogs = logs;
  if (lim) {                                           // own contacts, or their team's – Admin can widen this per person
    if (isLead) people = emps.filter(x => lim.has(x.id));
    leads = leads.filter(r => lim.has(String(r[4]).trim()));
    const ids = new Set(leads.map(r => String(r[0]).trim()));
    logs = logs.filter(r => ids.has(String(r[2]).trim()));
  }
  return {
    me: pub_(me),
    employees: people.map(x => [x.id, x.name, x.phone, x.active ? "Yes" : "No", x.role, x.hash || x.pin ? "set" : "", x.tl || "", isLead ? x.last : "", me.role === "Admin" ? x.permRaw : "", me.role === "Admin" ? x.pin : ""]),   // 11.23: Admin sees every PIN that is in the sheet
    leads, logs,
    sheetUrl: perms_(me).has("sheet") ? sheetUrlFor_(me) : "",   // Google Sheet link only for people allowed to open it
    ...meetings_(me, rank_(me.role) <= rank_("Team Lead") || scope_(me) !== "own"),
    cases: (fillCodesSafe_(), cases_(me, emps)),
    ...listsOut_(),
    transferTo: perms_(me).has("caseTransfer") ? transferTargets_(me, emps).map(x => [x.id, x.name, x.role]) : [],
    handTo: handTargets_(me, emps).map(x => [x.id, x.name, x.role]),
    connectors: connectorsFor_(me, emps),
    cpData: true,
    pagePerms: true,
    leadForm: true, cpLead: true, meetLoc: true, keepLead: true, fwNoShared: true, phoneEdit: true, cpShared: true, pinView: true, sharedLoan: true, stageNew: true,   // 11.25: new case at its step; field SM leads = Own field work · 11.24: Lead Shared by sees their cases · 11.23: Admin sees PINs · 11.21: CP details when Lead Shared by = CP · 11.20: add a missing customer number in the case window · 11.19: no "Lead Shared by" for SM - Field work · 11.18: whoever fills the lead form can keep it until documents come · 11.17: Location in field work, CP in the lead form · 11.16: "SM - Field work" role and the "Fill the lead form" permission                                  // Admin can switch each tab on / off, incl. a person's own page tabs (11.15+)                                     // this server knows "CP data" contacts (11.13+)
    stages: true,                                     // case window can save login / sanction dates and amounts (11.14+)
    ...perfOut_(me, emps, allLogs),
    serverTime: now_()
  };
}

function logCall_(me, b) {
  const leads = sheet_("Leads");
  const r = findRow_(leads, b.leadId);
  if (!r) throw new Error("Lead " + b.leadId + " not found");
  const lead = leads.getRange(r, 1, 1, 10).getDisplayValues()[0];
  if (rank_(me.role) > rank_("Team Lead") && String(lead[4]).trim() !== me.id) throw new Error("This contact isn't assigned to you");
  if (me.role === "Team Lead" && !teamIds_(me, emps_()).has(String(lead[4]).trim())) throw new Error("This contact isn't in your team");
  const isCP = /^cp data/i.test(String(leads.getRange(r, 11).getDisplayValue()).trim());   // contact imported as connector data
  const open = isCP ? null : caseRows_().find(x => String(x[C_["Contact ID"]]).trim() === String(lead[0]).trim());
  if (open && rank_(me.role) > rank_("Team Lead")) throw new Error("This customer is now with your Team Lead – you can view the updates only");
  let prep = null;
  if (b.outcome === "Interested" && !open && b.form && !isCP) {             // lead form filled in the call window – check it before saving anything
    const lc = leads.getRange(r, 1, 1, 12).getDisplayValues()[0];
    prep = prepareCase_(me, Object.assign({}, b.form, { Remarks: b.remark || b.form.Remarks || "" }), !!b.force, String(b.form.to || ""),
      { contactId: lead[0], phone: lead[2], name: lead[1], source: String(lc[10]).trim() === "Website" ? "Website" : "Telecalling" });
    if (prep.duplicate) return prep;                                // nothing saved yet – the caller decides
  }
  const at = now_();
  sheet_("CallLogs").appendRow(["C" + Date.now().toString(36).toUpperCase(), at, lead[0], lead[1], text_(lead[2]),
    me.id, me.name, b.outcome || "", b.remark || "", b.followUp || ""]);
  leads.getRange(r, 6, 1, 4).setValues([[b.outcome || "", b.followUp || "", b.remark || "", at]]);
  if (prep) return writeCase_(prep);
  if (isCP) {                                                      // connector data: Interested → a row in the Connectors tab for the person who called (never a lead case)
    if (b.outcome !== "Interested") return { saved: true };
    const k = Object.assign({ meetType: "Call", connType: "CP", area: lead[3] }, b.connector || {}, { name: lead[1], phone: lead[2], sm: "" });
    const res = saveConnector_(me, k, true);
    return { saved: true, connector: res.id };
  }
  if (b.outcome === "Interested" && !open) {                      // older website without the form: hand the customer to the Team Lead
    const lc = leads.getRange(r, 1, 1, 12).getDisplayValues()[0];
    const code = createCase_(me, lc, b.remark || "");
    return { saved: true, caseCode: code };
  }
  return { saved: true };
}

function assign_(ids, to, me) {
  const sh = sheet_("Leads"), n = sh.getLastRow() - 1;
  if (n < 1) return { updated: 0 };
  const idCol = sh.getRange(2, 1, n, 1).getDisplayValues(), asg = sh.getRange(2, 5, n, 1).getValues();
  const team = me ? limit_(me, emps_()) : null;   // people who see only their team (or own) can only move contacts inside it
  if (team && !team.has(to)) throw new Error("You can only assign to people in your team");
  if (to && !emps_().some(x => x.id === to && x.active)) throw new Error("That person isn't an active team member");
  if (to && emps_().some(x => x.id === to && x.role === "Admin")) throw new Error("Cases can't be assigned to an Admin");
  const set = new Set(ids.map(String)); let c = 0;
  idCol.forEach((r, i) => { if (set.has(String(r[0]).trim())) {
    if (team && !team.has(String(asg[i][0]).trim())) throw new Error("Contact " + r[0] + " isn't in your team");
    asg[i][0] = to; c++; } });
  sh.getRange(2, 5, n, 1).setValues(asg);
  return { updated: c };
}

function addLeads_(list, me) {
  const team = me ? limit_(me, emps_()) : null;
  if (team) {   // people who see only their team (or own) add contacts straight into it

    if (list.some(x => x && !team.has(String(x.assignedTo || "")))) throw new Error("Assign the new contacts to someone in your team");
  }
  // a duplicate = same mobile number AND same name (already in the Calling List, or repeated in this list) – it is skipped.
  // The same number with a different name (e.g. a family member) is added as a separate contact.
  const have = existingPhones_(), seen = new Set(), skipped = [];
  const keep = list.filter(x => {
    if (!x || !x.name || !x.phone) return false;
    const k = phoneKey_(x.phone), was = (have.get(k) || []).find(w => sameName_(w.name, x.name));
    if (was) { skipped.push({ phone: x.phone, name: x.name, was }); return false; }
    if ([...seen].some(s => s.k === k && sameName_(s.n, x.name))) { skipped.push({ phone: x.phone, name: x.name, repeat: true }); return false; }
    seen.add({ k, n: x.name }); return true;
  });
  if (list.length === 1 && skipped.length) {
    const w = skipped[0].was;
    throw new Error("This customer (same name and number) is already in the calling list" + (w ? " – " + w.name + (w.with ? " (with " + w.with + ")" : " (not assigned)") : ""));
  }
  const sh = sheet_("Leads"); let max = 1000;
  rows_("Leads", 1).forEach(r => { const v = parseInt(String(r[0]).replace(/\D/g, ""), 10); if (v > max) max = v; });
  const at = now_();
  const src = list.length > 1 ? "Import" : "Manual";
  // data type: connectors / channel partners are saved as "CP data" – an Interested call on them adds a connector, not a lead case
  const out = keep.map(x => ["L" + (++max), properName_(x.name), text_(x.phone), properName_(x.city || ""), x.assignedTo || "", "New", "", "", "", at, x.type === "cp" ? "CP data" : src]);
  if (out.length) sh.getRange(sh.getLastRow() + 1, 1, out.length, 11).setValues(out);
  return { added: out.length, skipped: skipped.length, dups: skipped.slice(0, 20) };
}
// last 10 digits of an Indian mobile (drops +91 / 0 in front)
function phoneKey_(p) { let d = digits_(p); if (d.length === 12 && d.startsWith("91")) d = d.slice(2); if (d.length === 11 && d.startsWith("0")) d = d.slice(1); return d; }
const nameKey_ = s => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
// same person: same name, or one name is the other plus more words ("Ankit" / "Ankit Gupta"); "Ramesh" is not "Rameshwar"
const nameToks_ = s => String(s || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
function sameName_(a, b) { const x = nameToks_(a), y = nameToks_(b); if (!x.length || !y.length) return false; const s = x.length <= y.length ? x : y, l = s === x ? y : x; return s.every((t, i) => t === l[i]) && (s.length > 1 || s[0].length >= 3); }
// every contact already saved under each mobile number
function existingPhones_() {
  const emps = emps_(), m = new Map();
  rows_("Leads", 5).forEach(r => { const k = phoneKey_(r[2]); if (k.length < 10) return; const e = emps.find(x => x.id === String(r[4]).trim());
    if (!m.has(k)) m.set(k, []); m.get(k).push({ id: r[0], name: r[1], with: e ? e.name : "" }); });
  return m;
}
// Import screen: which of these numbers are already in the Calling List (any team), and with whom
function checkPhones_(phones) {
  const m = existingPhones_(), found = {};
  (phones || []).slice(0, 3000).forEach(p => { const k = phoneKey_(p); if (m.has(k)) found[k] = m.get(k); });
  return { found };
}

function addEmp_(me, b) {
  const role = cleanRole_(b.role) || "Telecaller Executive";
  canManage_(me, role);
  checkName_(b.name);
  checkPhone_(b.phone);
  checkPin_(b.pin);
  let max = 0;
  emps_().forEach(x => { const v = parseInt(x.id.replace(/\D/g, ""), 10); if (v > max) max = v; });
  const id = "E" + (max + 1);
  sheet_("Employees").appendRow([id, properName_(b.name), text_(b.phone || ""), "Yes", role, "", hash_(id, b.pin), "", now_(), tlName_(b.tl, role)]);
  if (role === "Team Lead") ensureTeamTab_(properName_(b.name));
  if (role !== "Admin") addListValue_("SM Name", properName_(b.name));   // so the lead form's SM Name list has them, spelled the same
  return { id };
}
// Lists tab: add a value at the bottom of a column (by its heading) if it isn't there yet
function addListValue_(header, val) {
  val = String(val || "").trim(); if (!val) return;
  const sh = sheet_("Lists"), lc = sh.getLastColumn(); if (lc < 1) return;
  const c = sh.getRange(1, 1, 1, lc).getDisplayValues()[0].findIndex(h => norm_(h) === norm_(header)); if (c < 0) return;
  const n = sh.getLastRow(), col = n > 1 ? sh.getRange(2, c + 1, n - 1, 1).getDisplayValues().map(r => String(r[0]).trim()) : [];
  if (col.some(v => norm_(v) === norm_(val))) return;
  let last = col.length; while (last > 0 && !col[last - 1]) last--;
  sh.getRange(last + 2, c + 1).setValue(val);
}

function updateEmp_(me, b) {
  const e = emps_().find(x => x.id === b.id);
  if (!e) throw new Error("Team member not found");
  canManage_(me, e.role);
  const role = b.role ? cleanRole_(b.role) || e.role : e.role;
  canManage_(me, role);
  if (e.id === me.id && role !== me.role) throw new Error("You can't change your own role");
  if (b.name) checkName_(b.name, e.id);
  if (b.phone !== undefined) checkPhone_(b.phone, e.id);
  const newName = properName_(b.name || e.name), shE = sheet_("Employees");
  shE.getRange(e.row, 2, 1, 4).setValues([[newName, text_(b.phone !== undefined ? b.phone : e.phone), "Yes", role]]);
  if (b.tl !== undefined) shE.getRange(e.row, 10).setValue(tlName_(b.tl, role));
  if (e.role === "Team Lead" && newName !== e.name)               // keep team members pointing at the renamed Team Lead
    emps_().filter(x => x.tl === e.id).forEach(x => shE.getRange(x.row, 10).setValue(newName));
  if (role === "Team Lead") ensureTeamTab_(newName, e.role === "Team Lead" ? e.name : "");
  if (newName !== e.name && role !== "Admin") addListValue_("SM Name", newName);
  return { updated: true };
}

function resetPin_(me, id, pin) {
  const e = emps_().find(x => x.id === id);
  if (!e) throw new Error("Team member not found");
  if (e.id !== me.id) canManage_(me, e.role);
  const lim = limit_(me, emps_());
  if (lim) {                    // people who see only their team: only for people in it
    if (e.id === me.id) throw new Error("Use the 🔑 PIN button to change your own PIN");
    if (!lim.has(e.id)) throw new Error("You can only reset PINs for your own team");
  }
  checkPin_(pin);
  // New PIN goes into the sheet's PIN column (visible to admins); the old PIN stops working right away.
  sheet_("Employees").getRange(e.row, 6, 1, 2).setNumberFormat("@").setValues([[String(pin).trim(), ""]]);
  logoutAll_(e.id);
  return { reset: true };
}

function changePin_(me, oldPin, newPin) {
  const old = String(oldPin || "").trim();
  const ok = me.pin ? String(me.pin) === old : hash_(me.id, old) === me.hash;
  if (!ok) throw new Error("Current PIN is wrong");
  checkPin_(newPin);
  sheet_("Employees").getRange(me.row, 6, 1, 2).setNumberFormat("@").setValues([[String(newPin).trim(), hash_(me.id, newPin)]]);
  return { changed: true };
}

function removeEmp_(me, id) {
  const e = emps_().find(x => x.id === id);
  if (!e) throw new Error("Team member not found");
  if (e.id === me.id) throw new Error("You can't remove yourself");
  canManage_(me, e.role);
  sheet_("Employees").getRange(e.row, 4).setValue("No");
  logoutAll_(e.id);
  // 1) their contacts go back to the unassigned pool
  const ids = rows_("Leads", 5).filter(x => String(x[4]).trim() === e.id).map(x => String(x[0]).trim());
  if (ids.length) assign_(ids, "");
  // 2) their calls leave every report – kept in the "Removed Calls" tab, nothing is lost
  let calls = 0;
  const lsh = sheet_("CallLogs"), ln = lsh.getLastRow() - 1;
  if (ln > 0) {
    const logIds = lsh.getRange(2, 1, ln, 6).getDisplayValues().filter(r => String(r[5]).trim() === e.id).map(r => String(r[0]).trim()).filter(Boolean);
    for (let k = 0; k < logIds.length; k += 500) calls += removeLogs_({ name: me.name + " (removed " + e.name + ")" }, logIds.slice(k, k + 500)).removed;
  }
  // 3) lead cases that were with them stay (they are customers' loans) but go to "Not assigned" so someone takes them over
  let cases = 0;
  const csh = caseSheet_(), rows = caseRows_(), d = Utilities.formatDate(new Date(), "Asia/Kolkata", "d-MM");
  rows.forEach((r, i) => {
    if (!tlMatch_(r[C_["Team Lead"]], e)) return;
    const row = r.slice(), old = String(row[C_["Remarks"]] || "").trim();
    row[C_["Team Lead"]] = "";
    row[C_["Remarks"]] = (d + " " + e.name + " was removed – case needs a new owner" + (old ? " // " + old : "")).slice(0, 2000);
    row[C_["Last updated"]] = now_(); row[C_["Updated by"]] = me.name;
    csh.getRange(i + 2, 1, 1, CASE_COLS).setValues([row]); cases++;
  });
  return { removed: true, contacts: ids.length, calls, cases };
}

/* ---------------- field work ("Field Work" tab of this spreadsheet) ---------------- */
// Columns (same fields as the team's Google Form, plus ID / SM ID / audit):
//  A ID | B Timestamp | C SM Name | D SM ID | E Meeting Type | F Meeting Entity | G Name of the CP/Developer/Customer/Connector |
//  H Name of The Entity | I Willing to work with SN | J Existing % received in market if any | K Contact no of the Entity |
//  L Purpose of Meeting | M Meeting Outcome | N Interested / Not interested | O Remarks | P Any Tieup currently? |
//  Q If Yes, Tie up with which company | R Current pass back received | S Feedback | T Last updated | U Updated by
function mSheet_() { return sheet_("Field Work"); }
function meetings_(me, isLead) {
  try {
    const sh = mSheet_(), n = sh.getLastRow() - 1, w = Math.min(MEET_COLS, sh.getMaxColumns());
    let rows = n < 1 ? [] : sh.getRange(2, 1, n, w).getDisplayValues();
    if (!isLead) rows = rows.filter(r => String(r[3]).trim() === me.id || norm_(r[2]) === norm_(me.name));
    return { meetings: rows };
  } catch (e) { return { meetings: [], meetingsError: String(e && e.message || e) }; }
}
function saveMeeting_(me, m) {
  const isLead = rank_(me.role) <= rank_("Team Lead");
  const c = v => String(v == null ? "" : v).replace(/[<>]/g, "").replace(/^[=+\-@]/, "'$&").trim();
  const person = properName_(c(m.person)).slice(0, 120), entity = properName_(c(m.entity)).slice(0, 120);
  if (person.length < 2 && entity.length < 2) throw new Error("Enter the name of the person or the entity you met");
  const sh = mSheet_(); meetCols_(sh); const n = sh.getLastRow() - 1;
  const rows = n < 1 ? [] : sh.getRange(2, 1, n, MEET_COLS).getDisplayValues();
  let idx = -1;
  if (m.id) {
    idx = rows.findIndex(r => String(r[0]).trim() === String(m.id));
    if (idx < 0) throw new Error("Entry " + m.id + " not found – it may have been deleted");
    const r = rows[idx];
    if (!isLead && String(r[3]).trim() !== me.id && norm_(r[2]) !== norm_(me.name)) throw new Error("You can only edit your own field work");
  }
  let smName = me.name, smId = me.id;                       // leads can file for any SM; others always for themselves
  if (isLead && m.sm) { const e = emps_().find(x => norm_(x.name) === norm_(m.sm)); smName = e ? e.name : c(m.sm); smId = e ? e.id : c(m.smId); }
  else if (idx >= 0) { smName = rows[idx][2]; smId = rows[idx][3]; }
  let id = m.id;
  if (!id) { let max = 1000; rows.forEach(r => { const v = parseInt(String(r[0]).replace(/\D/g, ""), 10); if (v > max) max = v; }); id = "M" + (max + 1); }
  const at = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(m.at || "")) ? m.at : now_();
  const t = v => tidyText_(c(v));
  const row = [id, at, smName, smId, c(m.type).slice(0, 20), c(m.ent).slice(0, 40), person, entity, c(m.willing).slice(0, 10), t(m.existing).slice(0, 60),
    text_(c(m.phone).slice(0, 40)), t(m.purpose).slice(0, 100), t(m.outcome).slice(0, 120),
    (/^(Interested|Not interested)$/.test(m.interest || "") ? m.interest : ""), t(m.remarks).slice(0, 300), c(m.tieup).slice(0, 10),
    properName_(c(m.tieupWith)).slice(0, 100), t(m.passback).slice(0, 100), t(m.feedback).slice(0, 1000), now_(), me.name, properName_(c(m.location)).slice(0, 100)];
  if (idx >= 0) sh.getRange(idx + 2, 1, 1, MEET_COLS).setValues([row]);
  else sh.getRange(sh.getLastRow() + 1, 1, 1, MEET_COLS).setValues([row]);
  return { saved: true, id };
}
function deleteMeeting_(id) {
  const sh = mSheet_(), n = sh.getLastRow() - 1;
  if (n < 1) throw new Error("Meeting not found");
  const ids = sh.getRange(2, 1, n, 1).getDisplayValues();
  const i = ids.findIndex(r => String(r[0]).trim() === String(id));
  if (i < 0) throw new Error("Meeting not found");
  sh.deleteRow(i + 2);
  return { deleted: true };
}

/* ---------------- lead cases ("Lead Cases" tab) ---------------- */
function caseSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName("Lead Cases");
  if (!sh) { sh = ss.insertSheet("Lead Cases"); sh.getRange(1, 1, 1, CASE_COLS).setValues([CASE_HDR]); sh.setFrozenRows(1); }
  if (!caseColsOk_) {                                   // add Next follow-up / Login date / Sanction date columns once
    if (sh.getMaxColumns() < CASE_COLS) sh.insertColumnsAfter(sh.getMaxColumns(), CASE_COLS - sh.getMaxColumns());
    const hdr = sh.getRange(1, 1, 1, CASE_COLS).getDisplayValues()[0];
    // blank headers get their name; the CRM's own columns (Last updated onwards) always carry the right name
    const fix = hdr.map((h, i) => i >= C_["Last updated"] ? CASE_HDR[i] : (String(h).trim() || CASE_HDR[i]));
    if (fix.some((h, i) => h !== hdr[i])) sh.getRange(1, 1, 1, CASE_COLS).setValues([fix]);
    caseColsOk_ = true;
  }
  return sh;
}
let caseColsOk_ = false;
// Unique Lead Code: SNFS-1, SNFS-2 … always one more than the highest code in the sheet
function fillCodesSafe_() {
  if (!caseRows_().some(r => !String(r[C_["Unique Lead Code"]]).trim() && String(r[C_["Customer Name"]]).trim())) return;   // nothing to fill (the usual case) – no lock, no writes
  MEMO_ && delete MEMO_.cases;
  const lk = LockService.getScriptLock();
  if (!lk.tryLock(5000)) return;
  try { fillCodes_(); } catch (e) {} finally { lk.releaseLock(); }
}
function nextCode_(rows) {
  let max = 0;
  const rm = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Removed Cases");   // never reuse a removed case's code
  const codes = rows.map(r => r[C_["Unique Lead Code"]]);
  if (rm && rm.getLastRow() > 1) rm.getRange(2, C_["Unique Lead Code"] + 1, rm.getLastRow() - 1, 1).getDisplayValues().forEach(r => codes.push(r[0]));
  codes.forEach(v => { const m = String(v).trim().match(/^SNFS-(\d+)$/i); if (m) max = Math.max(max, +m[1]); });
  return "SNFS-" + (max + 1);
}
// Rows typed straight into the Lead Cases tab without a code get the next SNFS number
function fillCodes_() {
  const sh = caseSheet_(), rows = caseRows_(), col = C_["Unique Lead Code"] + 1;
  rows.forEach((r, i) => {
    if (!String(r[C_["Unique Lead Code"]]).trim() && String(r[C_["Customer Name"]]).trim()) {
      const code = nextCode_(rows); r[C_["Unique Lead Code"]] = code; sh.getRange(i + 2, col).setValue(code);
    }
  });
}
// Every drop-down list lives in the Lists tab of the sheet: one column per drop-down, name in row 1.
// Admin adds a new choice by typing it at the bottom of the right column. "Counts as" (next to Status)
// tells the dashboard how a status counts: New, In progress, Disbursed or Closed.
const LIST_COLS = ["Status", "Customer Status", "Product", "Lead Type", "Lead Source", "SM Name", "Bank Name", "Lead Shared by"];
// Targets and monthly numbers: everyone with the Performance tab sees the whole leaderboard, others only themselves
function perfOut_(me, emps, logs) {
  try {
    const all = perms_(me).has("perf"), mine = id => all || id === me.id;
    const b = board_(logs, caseRows_(), emps, lists_()), board = {};
    Object.keys(b).forEach(m => { board[m] = {}; Object.keys(b[m]).forEach(id => { if (mine(id)) board[m][id] = b[m][id]; }); });
    return { targets: targets_().filter(r => mine(r[1])), board, boardNames: all ? emps.map(x => [x.id, x.name, x.role, x.active ? "Yes" : "No", x.tl || ""]) : [] };
  } catch (e) { return { targets: [], board: {}, perfError: String(e.message || e) }; }
}
function listsOut_() { const L = lists_(); return { lists: Object.assign({}, L.lists, { "SM Name": smList_(L) }), statusType: L.statusType, banks: L.lists["Bank Name"] || [] }; }
// SM Name choices = the Lists tab column + every active employee (Team Leads too), so nobody who calls is missing from the form
function smList_(L) {
  const out = (L.lists["SM Name"] || []).slice(), seen = new Set(out.map(norm_));
  emps_().filter(e => e.active && e.role !== "Admin").forEach(e => { if (!seen.has(norm_(e.name))) { seen.add(norm_(e.name)); out.push(e.name); } });
  return out.sort((a, b) => a.localeCompare(b));
}
function lists_() { return memo_("lists", listsRead_); }
function listsRead_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName("Lists"), lists = {}, statusType = {};
  if (sh && sh.getLastRow() >= 1) {
    const d = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues(), hdr = d[0].map(h => String(h).trim()), ti = hdr.indexOf("Counts as");
    hdr.forEach((h, j) => {
      if (LIST_COLS.indexOf(h) < 0) return;
      const seen = new Set(); lists[h] = [];
      d.slice(1).forEach(r => {
        const v = String(r[j]).trim();
        if (!v || seen.has(v.toLowerCase())) return;
        seen.add(v.toLowerCase()); lists[h].push(v);
        if (h === "Status" && ti >= 0 && String(r[ti]).trim()) statusType[v] = String(r[ti]).trim();
      });
    });
  }
  if (!lists["Bank Name"] || !lists["Bank Name"].length) {        // older sheets: banks in a separate Banks tab
    const b = ss.getSheetByName("Banks");
    if (b && b.getLastRow() > 1) lists["Bank Name"] = b.getRange(2, 1, b.getLastRow() - 1, 1).getDisplayValues().map(r => String(r[0]).trim()).filter(String);
  }
  return { lists, statusType };
}
// A drop-down value must come from its list. A value the case already had (e.g. from old data) is kept as it is.
function pick_(h, v, old, L) {
  v = String(v == null ? "" : v).trim();
  if (!v) return "";
  const list = h === "SM Name" ? smList_(L) : (L.lists[h] || []);
  if (!list.length) return h === "SM Name" ? properName_(v) : v;
  const hit = list.find(x => x.toLowerCase() === v.toLowerCase());
  if (hit) return hit;
  if (v === String(old || "").trim()) return v;
  throw new Error("Choose " + h + " from the list. To add a new choice, Admin types it in the Lists tab of the sheet.");
}
// Next follow-up date: yyyy-MM-dd (or empty)
function fuDate_(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/) || null;
  if (!m) throw new Error("Next follow-up should be a date");
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (isNaN(d) || d.getFullYear() < 2020 || d.getFullYear() > 2100) throw new Error("Next follow-up should be a date");
  return Utilities.formatDate(d, "Asia/Kolkata", "yyyy-MM-dd");
}
// how a status counts: "new", "prog", "disb" or "closed" (Counts as column in the Lists tab, else the built-in rule)
function stType_(st, L) {
  const t = String(((L || lists_()).statusType || {})[st] || "").toLowerCase();
  if (t.indexOf("new") === 0) return "new"; if (t.indexOf("disb") === 0) return "disb";
  if (/^(clos|drop|lost)/.test(t)) return "closed"; if (t) return "prog";
  return !st || st === "New" ? "new" : st === "Disbursed" ? "disb" : ["Not Interested", "Cancelled", "Case Rejected", "Case Closed"].indexOf(st) >= 0 ? "closed" : "prog";
}
const MON_ = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function mon_(v) {                                      // "2026-11-18 …" or "Nov-2026" → "Nov-2026"
  const s = String(v || "").trim(), m = s.match(/^(\d{4})-(\d{1,2})/);
  if (m) return MON_[+m[2] - 1] + "-" + m[1];
  return /^[A-Z][a-z]{2}-\d{4}$/.test(s) ? s : "";
}
const num_ = v => { const n = parseFloat(String(v || "").replace(/[^\d.]/g, "")); return isFinite(n) ? n : 0; };

/* ---------------- monthly targets & what each person actually did ---------------- */
function targetSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName("Targets");
  if (!sh) { sh = ss.insertSheet("Targets"); sh.getRange(1, 1, 1, TARGET_HDR.length).setValues([TARGET_HDR]); sh.setFrozenRows(1); }
  return sh;
}
function targets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName("Targets");
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 9).getDisplayValues().filter(r => r[0] && r[1]);
}
// per month, per person: [calls, leads, cases, logins, disbursed cases, disbursal amount]
function board_(logs, rows, emps, L) {
  const out = {}, add = (m, id, k, n) => { if (!m || !id) return; const a = ((out[m] = out[m] || {})[id] = out[m][id] || [0, 0, 0, 0, 0, 0]); a[k] += n; };
  logs.forEach(r => { const m = mon_(r[1]), id = String(r[5]).trim(); add(m, id, 0, 1); if (/^(interested|converted)$/i.test(String(r[7]).trim())) add(m, id, 1, 1); });
  const tlId = {};                                      // Team Lead name in a case → that person's ID
  rows.forEach(r => {
    const t = String(r[C_["Team Lead"]]).trim(); if (!t) return;
    if (!(t in tlId)) { const e = emps.find(x => tlMatch_(t, x)); tlId[t] = e ? e.id : ""; }
    const id = tlId[t]; if (!id || !r[C_["Unique Lead Code"]]) return;
    add(mon_(r[C_["Lead Date"]]) || mon_(r[C_["Monthly"]]), id, 2, 1);
    add(mon_(r[C_["Login date"]]), id, 3, 1);
    if (stType_(String(r[C_["Status"]]), L) === "disb") { const m = mon_(r[C_["Disbursed Month"]]) || mon_(r[C_["Disbursed Date"]]); add(m, id, 4, 1); add(m, id, 5, num_(r[C_["Disbursed amount"]]) || num_(r[C_["Amount Required"]])); }
  });
  return out;
}
// Admin (or someone allowed): replace one month's targets
function saveTargets_(me, month, list) {
  if (!/^[A-Z][a-z]{2}-\d{4}$/.test(String(month || ""))) throw new Error("Choose a month");
  const emps = emps_(), sh = targetSheet_(), at = now_();
  const keep = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, TARGET_HDR.length).getDisplayValues().filter(r => r[0] && r[0] !== month) : [];
  const add = (list || []).map(t => {
    const e = emps.find(x => x.id === String(t.id || "")); if (!e) return null;
    const v = [t.calls, t.leads, t.cases, t.logins, t.disb, t.amt].map(x => { const n = Math.round(num_(x)); return n > 0 ? n : ""; });
    return v.some(x => x !== "") ? [month, e.id, e.name].concat(v, [me.name, at]) : null;
  }).filter(Boolean);
  const all = keep.concat(add), n = Math.max(all.length, sh.getLastRow() - 1);      // rewrite the list; blank out leftover rows
  while (all.length < n) all.push(TARGET_HDR.map(() => ""));
  if (n > 0) sh.getRange(2, 1, n, TARGET_HDR.length).setValues(all);
  audit_(me.name, me, "Targets for " + month + ": " + add.length + " people");
  return { saved: true, count: add.length };
}

function caseRows_() { return memo_("cases", caseRowsRead_); }
function caseRowsRead_() { try { const sh = caseSheet_(), n = sh.getLastRow() - 1; return n < 1 ? [] : sh.getRange(2, 1, n, CASE_COLS).getDisplayValues(); } catch (e) { return []; } }
// the Team Lead a case belongs to: the contact's telecaller's Team Lead (or the telecaller, if they lead a team)
function caseTL_(emps, assigneeId, me) {
  const a = emps.find(x => x.id === assigneeId);
  if (a && a.role === "Team Lead") return a;
  if (a && a.tl) return emps.find(x => x.id === a.tl) || null;
  return me && me.role === "Team Lead" ? me : null;
}
const tlMatch_ = (val, e) => !!e && (String(val).trim() === e.id || norm_(val) === norm_(e.name));
// 11.24: the person named in "Lead Shared by" sees that case (read only) once it has a lead code – every step
function sharedLoan_(row, me) { return !!norm_(me.name) && norm_(row[C_["Lead Shared by"]]) === norm_(me.name); }
function canSeeCase_(me, row, emps, team) {
  const sc = scope_(me);
  if (sc === "all") return true;
  if (tlMatch_(row[C_["Team Lead"]], me)) return true;                  // cases sent to them as Team Lead
  if (sharedLoan_(row, me)) return true;
  const tel = String(row[C_["Telecaller ID"]]).trim();
  if (sc !== "team") return tel === me.id;                               // their own cases
  if (team.has(tel)) return true;                                        // filled in the CRM by someone in the team
  const mates = emps.filter(x => team.has(x.id));
  return mates.some(x => tlMatch_(row[C_["Team Lead"]], x) ||            // with someone in the team now
    norm_(row[C_["SM Name"]]) === norm_(x.name));                        // SM Name is someone in the team (also old imported cases)
}
// Who may change a case: the person it is with now; the SM who filled it, until they transfer it;
// and people with "Edit lead cases" who can see the whole team or everyone.
function canEditCase_(me, row, emps) {
  const holder = String(row[C_["Team Lead"]] || "").trim(), mine = String(row[C_["Telecaller ID"]]).trim() === me.id;
  if (holder && tlMatch_(holder, me)) return true;
  if (!holder && mine) return true;
  return perms_(me).has("caseEdit") && scope_(me) !== "own" && canSeeCase_(me, row, emps, teamFor_(me, emps));
}
// Who a case can be handed to for further process: any active person (executives, telecallers, Team Leads, Managers) – never Admin
const handTargets_ = (me, emps) => {
  const all = emps.filter(x => x.active && x.id !== me.id && x.role !== "Admin");
  if (me.role !== "SM - Field work") return all;
  const tls = all.filter(x => x.role === "Team Lead"), mine = tls.filter(x => x.id === me.tl);   // 11.17: field work leads go to their own Team Lead only
  return mine.length ? mine : tls;
};
const teamFor_ = (me, emps) => scope_(me) === "team" ? teamOf_(me, emps) : new Set();
function cases_(me, emps) {
  const team = teamFor_(me, emps);
  return caseRows_().filter(r => r[C_["Unique Lead Code"]] && canSeeCase_(me, r, emps, team));
}
function createCase_(me, lc, remark) {
  const emps = emps_(), tl = caseTL_(emps, String(lc[4]).trim(), me), now = new Date();
  const code = nextCode_(caseRows_());
  const tel = emps.find(x => x.id === String(lc[4]).trim());
  const row = new Array(CASE_COLS).fill("");
  row[C_["Timestamp"]] = now_(); row[C_["Customer Name"]] = lc[1]; row[C_["Contact Number"]] = text_(lc[2]);
  row[C_["Lead Source"]] = String(lc[10]).trim() === "Website" ? "Website" : "Telecalling";
  row[C_["Lead Shared by"]] = tel ? tel.name : me.name; row[C_["Lead Date"]] = Utilities.formatDate(now, "Asia/Kolkata", "yyyy-MM-dd");
  row[C_["Monthly"]] = Utilities.formatDate(now, "Asia/Kolkata", "MMM-yyyy"); row[C_["Unique Lead Code"]] = code;
  row[C_["Status"]] = "New"; row[C_["Remarks"]] = remark ? "Telecaller: " + remark : "";
  row[C_["Contact ID"]] = lc[0]; row[C_["Team Lead"]] = tl ? tl.name : ""; row[C_["Telecaller ID"]] = String(lc[4]).trim();
  row[C_["Last updated"]] = now_(); row[C_["Updated by"]] = me.name;
  row[C_["Next follow-up"]] = Utilities.formatDate(now, "Asia/Kolkata", "yyyy-MM-dd");   // a new case shows in the Team Lead's Today list
  const sh = caseSheet_(); sh.getRange(sh.getLastRow() + 1, 1, 1, CASE_COLS).setValues([row]);
  return code;
}
function createCaseFor_(me, leadId) {                                  // open a case by hand for an Interested contact
  const leads = sheet_("Leads"), r = findRow_(leads, leadId);
  if (!r) throw new Error("Contact " + leadId + " not found");
  const lc = leads.getRange(r, 1, 1, 12).getDisplayValues()[0];
  if (caseRows_().some(x => String(x[C_["Contact ID"]]).trim() === String(lc[0]).trim())) throw new Error("This customer already has a case");
  const lim = limit_(me, emps_());
  if (lim && !lim.has(String(lc[4]).trim())) throw new Error("This contact isn't in your team");
  return { saved: true, caseCode: createCase_(me, lc, String(lc[7] || "")) };
}
// Lead & Inquiry form inside the CRM: the SM fills it, Lead Date is today. Every choice must come from the Lists tab.
// Lead & Inquiry form. Lead Date is today; every choice must come from the Lists tab.
// It opens when a caller marks a customer Interested (logCall_), or from Lead Cases for people with Lead Cases access.
// People without Lead Cases access fill only the basics and must send the case to someone for further process.
function prepareCase_(me, c, force, to, src) {
  src = src || {};
  const L = lists_(), emps = emps_(), now = new Date(), full = perms_(me).has("cases"), cp = full || perms_(me).has("leadForm") || String(c["Lead Shared by"] || "").trim() === "CP" || c.fromCP === true || String(c["Lead Source"] || "").trim() === "CP";   // 11.21/11.22: a lead from a CP → anyone may name the CP   // 11.17: SM - Field work can name the CP who gave the lead
  // 11.18: nobody has to send the case on straight away – they can keep it until the documents come, then send it (Suraj, 25 Nov)
  const cl = v => String(v == null ? "" : v).replace(/[<>]/g, "").replace(/^[=+\-@]/, "").replace(/\s+/g, " ").trim().slice(0, 300);
  const need = (h, label) => { const v = cl(c[h]); if (!v) throw new Error("Fill in " + (label || h)); return v; };
  const choose = h => { const v = need(h); const list = h === "SM Name" ? smList_(L) : (L.lists[h] || []); if (!list.length) return properName_(v);
    const hit = list.find(x => x.toLowerCase() === v.toLowerCase()); if (!hit) throw new Error("Choose " + h + " from the list"); return hit; };
  const ph = digits_(src.phone || need("Contact Number")).replace(/^(91|0)(?=\d{10}$)/, "");
  if (!/^[6-9]\d{9}$/.test(ph)) throw new Error("Contact Number should be a 10-digit mobile number");
  const amt = full ? Math.round(num_(c["Amount Required"])) : "";
  if (full && !src.contactId && !(amt > 0)) throw new Error("Amount Required should be a number, e.g. 500000");
  let cph = cp ? digits_(cl(c["Connector Contact No"])).replace(/^(91|0)(?=\d{10}$)/, "") : "";
  if (cph && !/^\d{10}$/.test(cph)) throw new Error("Connector Contact No should have 10 digits");
  const rows = caseRows_();
  if (!force) {                                                        // same mobile number already has a case?
    const dup = rows.filter(r => digits_(r[C_["Contact Number"]]).slice(-10) === ph).map(r => ({ code: r[C_["Unique Lead Code"]], name: r[C_["Customer Name"]], status: r[C_["Status"]], with: r[C_["Team Lead"]], date: r[C_["Lead Date"]] }));
    if (dup.length) return { duplicate: dup.slice(0, 5) };
  }
  let t = null;
  if (to) { t = handTargets_(me, emps).find(x => x.id === to); if (!t) throw new Error("Choose who to send the case to from the list"); }
  const row = new Array(CASE_COLS).fill(""), today = Utilities.formatDate(now, "Asia/Kolkata", "yyyy-MM-dd"), d = Utilities.formatDate(now, "Asia/Kolkata", "d-MM");
  row[C_["Timestamp"]] = now_(); row[C_["Lead Date"]] = today; row[C_["Monthly"]] = Utilities.formatDate(now, "Asia/Kolkata", "MMM-yyyy");
  row[C_["Lead Type"]] = choose("Lead Type"); row[C_["Customer Name"]] = properName_(cl(c["Customer Name"]) || src.name || need("Customer Name"));
  row[C_["Contact Number"]] = ph.slice(0, 5) + " " + ph.slice(5); row[C_["SM Name"]] = choose("SM Name"); row[C_["Product"]] = choose("Product");
  row[C_["Lead Shared by"]] = me.role === "SM - Field work" && !cl(c["Lead Shared by"]) ? "Own field work" : choose("Lead Shared by");   // 11.25: a field SM's own lead is "Own field work"
  row[C_["Lead Source"]] = cp && cl(c["Lead Source"]) ? choose("Lead Source") : src.source || "";
  if (full) row[C_["Amount Required"]] = amt || "";                   // amount only from people with Lead Cases access
  if (cp) {                                                            // connector / CP who gave the lead
    row[C_["Connector Name"]] = properName_(cl(c["Connector Name"])); row[C_["Connector Contact No"]] = cph ? cph.slice(0, 5) + " " + cph.slice(5) : "";
    row[C_["Connector Location"]] = properName_(cl(c["Connector Location"]));
  }
  row[C_["Status"]] = "New";
  // 11.25: a case that already moved ahead can be added at its step – Login / Sanction / Disbursal with dates and amounts
  const stage = full ? String(c.stage || "") : "", lv = { login: 1, sanc: 2, disb: 3 }[stage] || 0;
  if (lv && C_["Login date"] !== undefined) {
    const day = k => { const v = cl(c[k]); if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || v > today) throw new Error("Fill a correct date for the step the case is at"); return v; };
    const money = k => { const n = Number(String(c[k] || "").replace(/[^\d.]/g, "")); if (!n) throw new Error("Fill the amount for the step the case is at"); return n; };
    row[C_["Login date"]] = day("loginD"); row[C_["Login by"]] = me.name; row[C_["Status"]] = "Login Done";
    if (lv >= 2) { row[C_["Sanction date"]] = day("sancD"); row[C_["Sanction amount"]] = money("sancA"); row[C_["Sanction by"]] = me.name; row[C_["Status"]] = "Sanction Done"; }
    if (lv >= 3) { const d = day("disbD"); row[C_["Disbursed Date"]] = d; row[C_["Disbursed Month"]] = Utilities.formatDate(new Date(d + "T12:00:00"), "Asia/Kolkata", "MMM-yyyy");
      row[C_["Disbursed amount"]] = money("disbA"); row[C_["Disbursed by"]] = me.name; row[C_["Status"]] = "Disbursed"; }
  }
  row[C_["Telecaller ID"]] = me.id; row[C_["Contact ID"]] = src.contactId || ""; row[C_["Next follow-up"]] = today;
  const note = tidyText_(cl(c.Remarks)), lines = [];
  if (t) lines.push(d + " Transferred from " + me.name + " to " + t.name + " by " + me.name);
  if (note) lines.push(d + " " + note);
  row[C_["Remarks"]] = lines.join(" // ");
  row[C_["Team Lead"]] = t ? t.name : me.name;                          // not sent on: the case stays with the person who filled it
  row[C_["Last updated"]] = now_(); row[C_["Updated by"]] = me.name;
  return { row, code: nextCode_(rows), to: t ? t.name : "" };
}
function writeCase_(p) {
  p.row[C_["Unique Lead Code"]] = p.code;
  const sh = caseSheet_(); sh.getRange(sh.getLastRow() + 1, 1, 1, CASE_COLS).setValues([p.row]);
  return { saved: true, code: p.code, caseCode: p.code, to: p.to };
}
function newCase_(me, c, force, to) {
  if (!perms_(me).has("cases") && !perms_(me).has("leadForm")) throw new Error("Mark the customer Interested in your calling list – the lead form opens there");
  const p = prepareCase_(me, c, force, to, {});
  return p.duplicate ? p : writeCase_(p);
}
// Admin only: take a case out of Lead Cases (e.g. opened by mistake). The row is kept in the "Removed Cases" tab
// with who removed it and when, so nothing is lost. The contact stays in the Calling List and can get a new case later.
// Admin only: save one person's permissions as differences from their role's defaults (Employees column K)
function setPerms_(me, id, list) {
  const e = emps_().find(x => x.id === id);
  if (!e) throw new Error("Employee not found");
  if (e.role === "Admin") throw new Error("Admin always has full access");
  const ok = allowedPerms_(e.role), want = new Set(list.filter(k => ok.indexOf(k) >= 0)), base = new Set(basePerms_(e.role));
  const diff = ok.filter(k => want.has(k) !== base.has(k)).map(k => (want.has(k) ? "+" : "-") + k);
  if (want.has("reports") && !want.has("eod") && diff.indexOf("-eod") < 0) diff.push("-eod");   // keep EOD off even though Reports is on
  const sh = sheet_("Employees");
  if (sh.getMaxColumns() < 11) sh.insertColumnsAfter(sh.getMaxColumns(), 11 - sh.getMaxColumns());
  if (!String(sh.getRange(1, 11).getDisplayValues()[0][0]).trim()) sh.getRange(1, 11).setValues([["Permissions (set in CRM)"]]);
  sh.getRange(e.row, 11).setValues([[diff.join(", ")]]);
  audit_(me.name, me, "Permissions for " + e.name + ": " + (diff.join(", ") || "role default"));
  return { saved: true };
}
// Case transfer: to someone at the same or a higher level (Team Lead / Manager) – never to an Admin
function transferTargets_(me, emps) {
  if (me.role === "Admin") return handTargets_(me, emps);
  return emps.filter(x => x.active && x.id !== me.id && (x.role === "Team Lead" || x.role === "Manager") &&
    (me.role === "Admin" || rank_(x.role) <= rank_(me.role)));
}
function transferCase_(me, code, to, note) {
  const sh = caseSheet_(), rows = caseRows_(), emps = emps_();
  const i = rows.findIndex(r => String(r[C_["Unique Lead Code"]]).trim() === String(code || "").trim());
  if (i < 0) throw new Error("Case " + code + " not found");
  const row = rows[i].slice();
  if (!canSeeCase_(me, row, emps, teamFor_(me, emps))) throw new Error("This case isn't in your team");
  const holder = String(row[C_["Team Lead"]] || "").trim();
  const owner = String(row[C_["Telecaller ID"]]).trim() === me.id && (!holder || tlMatch_(holder, me));
  const admin = perms_(me).has("caseTransfer");
  if (!admin && !owner) throw new Error(holder ? "This case is already with " + holder + " – only Admin can move it now" : "Only Admin can transfer this case");
  const t = (admin ? transferTargets_(me, emps) : handTargets_(me, emps)).find(x => x.id === to);
  if (!t) throw new Error(admin ? "You can only transfer a case to a Team Lead or Manager at your level or above" : "Choose someone from the list");
  if (tlMatch_(row[C_["Team Lead"]], t)) throw new Error("This case is already with " + t.name);
  const filler = emps.find(x => x.id === String(row[C_["Telecaller ID"]]).trim());
  const from = holder || (filler ? filler.name : "Not assigned");
  note = String(note || "").replace(/[<>]/g, "").replace(/^[=+\-@]/, "").replace(/\s+/g, " ").trim().slice(0, 200);
  const d = Utilities.formatDate(new Date(), "Asia/Kolkata", "d-MM");
  const line = d + " Transferred from " + from + " to " + t.name + " by " + me.name + (note ? ": " + note : "");
  const old = String(row[C_["Remarks"]] || "").trim();
  row[C_["Team Lead"]] = t.name;
  row[C_["Remarks"]] = (line + (old ? " // " + old : "")).slice(0, 2000);
  row[C_["Last updated"]] = now_(); row[C_["Updated by"]] = me.name;
  sh.getRange(i + 2, 1, 1, CASE_COLS).setValues([row]);
  return { saved: true, to: t.name };
}
// Admin: move many cases to one person at once (e.g. the open cases of an SM who left). SM Name never changes.
function transferCases_(me, codes, to) {
  if (!perms_(me).has("caseTransfer")) throw new Error("Only Admin can transfer many cases at once");
  const want = new Set((codes || []).map(x => String(x).trim()).filter(Boolean));
  if (!want.size) throw new Error("Choose the cases to transfer");
  if (want.size > 500) throw new Error("Transfer at most 500 cases at a time");
  const sh = caseSheet_(), rows = caseRows_(), emps = emps_(), team = teamFor_(me, emps);
  const t = transferTargets_(me, emps).find(x => x.id === to);
  if (!t) throw new Error("Choose someone from the list");
  const d = Utilities.formatDate(new Date(), "Asia/Kolkata", "d-MM"), at = now_();
  let done = 0, skipped = 0;
  rows.forEach((r, i) => {
    if (!want.has(String(r[C_["Unique Lead Code"]]).trim())) return;
    if (!canSeeCase_(me, r, emps, team)) { skipped++; return; }
    if (tlMatch_(r[C_["Team Lead"]], t)) { skipped++; return; }
    const row = r.slice(), holder = String(row[C_["Team Lead"]] || "").trim(), filler = emps.find(x => x.id === String(row[C_["Telecaller ID"]]).trim());
    const from = holder || (filler ? filler.name : "Not assigned"), old = String(row[C_["Remarks"]] || "").trim();
    row[C_["Team Lead"]] = t.name;
    row[C_["Remarks"]] = (d + " Transferred from " + from + " to " + t.name + " by " + me.name + (old ? " // " + old : "")).slice(0, 2000);
    row[C_["Last updated"]] = at; row[C_["Updated by"]] = me.name;
    sh.getRange(i + 2, 1, 1, CASE_COLS).setValues([row]); done++;
  });
  return { saved: true, done, skipped, to: t.name };
}
// Admin only: take wrong call logs out of CallLogs. The rows are kept in the "Removed Calls" tab (with who removed them and when),
// so nothing is lost. A contact whose latest call was removed goes back to its latest remaining call (or to "not called yet").
function removeLogs_(me, ids) {
  const want = new Set((ids || []).map(x => String(x).trim()).filter(Boolean));
  if (!want.size) throw new Error("Choose the calls to remove");
  if (want.size > 500) throw new Error("Remove at most 500 calls at a time");
  const ss = SpreadsheetApp.getActiveSpreadsheet(), sh = sheet_("CallLogs"), n = sh.getLastRow() - 1;
  if (n < 1) throw new Error("There are no call logs");
  const nc = Math.max(10, sh.getLastColumn()), vals = sh.getRange(2, 1, n, nc).getDisplayValues();
  const hit = []; vals.forEach((r, i) => { if (want.has(String(r[0]).trim())) hit.push(i); });
  if (!hit.length) throw new Error("Those calls were not found – press Refresh");
  let rm = ss.getSheetByName("Removed Calls");
  if (!rm) {
    rm = ss.insertSheet("Removed Calls");
    rm.getRange(1, 1, 1, nc + 2).setValues([sh.getRange(1, 1, 1, nc).getDisplayValues()[0].concat(["Removed at", "Removed by"])]); rm.setFrozenRows(1);
  }
  const at = now_();
  rm.getRange(rm.getLastRow() + 1, 1, hit.length, nc + 2).setValues(hit.map(i => vals[i].concat([at, me.name])));
  for (let k = hit.length - 1; k >= 0;) {                 // delete from the bottom up, a block of neighbouring rows at a time
    let j = k; while (j > 0 && hit[j - 1] === hit[j] - 1) j--;
    sh.deleteRows(hit[j] + 2, k - j + 1); k = j - 1;
  }
  const gone = new Set(hit), leads = sheet_("Leads");
  new Set(hit.map(i => String(vals[i][2]).trim())).forEach(id => {
    const r = id && findRow_(leads, id); if (!r) return;
    const lastAt = String(leads.getRange(r, 9).getDisplayValue()).trim();
    if (!hit.some(i => String(vals[i][2]).trim() === id && String(vals[i][1]).trim() === lastAt)) return;   // its latest call is still there
    let last = null; vals.forEach((x, i) => { if (!gone.has(i) && String(x[2]).trim() === id) last = x; });
    leads.getRange(r, 6, 1, 4).setValues([last ? [last[7], last[9], last[8], last[1]] : ["", "", "", ""]]);
  });
  return { saved: true, removed: hit.length };
}
function removeCase_(me, code) {
  const sh = caseSheet_(), rows = caseRows_();
  const i = rows.findIndex(r => String(r[C_["Unique Lead Code"]]).trim() === String(code || "").trim());
  if (i < 0) throw new Error("Case " + code + " not found");
  const emps = emps_();
  if (!canSeeCase_(me, rows[i], emps, teamFor_(me, emps))) throw new Error("This case isn't in your team");
  const ss = SpreadsheetApp.getActiveSpreadsheet(), nc = sh.getLastColumn();
  const hdr = sh.getRange(1, 1, 1, nc).getDisplayValues()[0], row = sh.getRange(i + 2, 1, 1, nc).getValues()[0];
  let rm = ss.getSheetByName("Removed Cases");
  if (!rm) { rm = ss.insertSheet("Removed Cases"); rm.getRange(1, 1, 1, nc + 2).setValues([hdr.concat(["Removed at", "Removed by"])]); rm.setFrozenRows(1); }
  rm.appendRow(row.concat(Array(Math.max(0, nc - row.length)).fill(""), [now_(), me.name]));
  sh.deleteRow(i + 2);
  return { saved: true, removed: code };
}
function saveCase_(me, c) {
  const sh = caseSheet_(), rows = caseRows_(), emps = emps_();
  const i = rows.findIndex(r => String(r[C_["Unique Lead Code"]]) === String(c.code || ""));
  if (i < 0) throw new Error("Case " + c.code + " not found");
  const row = rows[i].slice();
  if (!canEditCase_(me, row, emps)) throw new Error(String(row[C_["Team Lead"]]).trim() ? "This case is with " + row[C_["Team Lead"]] + " – you can see its updates, but only they (or Admin) can change it" : "You can't change this case – ask Admin");
  const cl = v => String(v == null ? "" : v).replace(/[<>]/g, "").replace(/^[=+\-@]/, "'$&").trim().slice(0, 500);
  const L = lists_();
  const stepDate_ = (h, v) => { const s = String(v == null ? "" : v).trim(); if (!s) return ""; if (s === String(rows[i][C_[h]]).trim()) return s;   // unchanged
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    const d = m && new Date(+m[1], +m[2] - 1, +m[3]); if (!d || isNaN(d) || d.getFullYear() < 2020 || d > new Date()) throw new Error(h + " should be a date, not in the future");
    return Utilities.formatDate(d, "Asia/Kolkata", "yyyy-MM-dd"); };
  const amt_ = (h, v) => { const s = String(v == null ? "" : v).replace(/[,\s₹]/g, ""); if (!s) return ""; const n = Math.round(Number(s)); if (!(n > 0)) throw new Error(h + " should be a number, e.g. 500000"); return n; };
  CASE_EDIT.forEach(h => { if (c[h] !== undefined) row[C_[h]] = h === "Remarks" ? tidyText_(cl(c[h])) : h === "Next follow-up" ? fuDate_(c[h]) :
    h === "Login date" || h === "Sanction date" || h === "Disbursed Date" ? stepDate_(h, c[h]) : h === "Sanction amount" || h === "Disbursed amount" ? amt_(h, c[h]) : LIST_COLS.indexOf(h) >= 0 ? pick_(h, cl(c[h]), rows[i][C_[h]], L) : h === "Banker Name" || h === "Connector Name" ? properName_(cl(c[h])) : cl(c[h]); });
  const st = String(row[C_["Status"]]), was = String(rows[i][C_["Status"]]), today = Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyy-MM-dd");
  const ty = stType_(st, L), who = String(row[C_["Team Lead"]] || "").trim() || me.name;   // credit goes to the person the case is with
  if (st !== was) {                                     // remember when (and by whom) a case reached login, sanction and disbursal
    if (/sanction/i.test(st)) {
      if (!row[C_["Sanction date"]]) row[C_["Sanction date"]] = today; if (!row[C_["Sanction by"]]) row[C_["Sanction by"]] = who;
      if (!row[C_["Login date"]]) row[C_["Login date"]] = today; if (!row[C_["Login by"]]) row[C_["Login by"]] = who;
    } else if (/login/i.test(st)) { if (!row[C_["Login date"]]) row[C_["Login date"]] = today; if (!row[C_["Login by"]]) row[C_["Login by"]] = who; }
    if (ty === "disb" && !row[C_["Disbursed by"]]) row[C_["Disbursed by"]] = who;
  }
  // a step date filled in by hand (11.14) – remember who it counts for, once
  [["Login date", "Login by"], ["Sanction date", "Sanction by"], ["Disbursed Date", "Disbursed by"]].forEach(([d, b]) => {
    if (String(row[C_[d]]).trim() && !String(row[C_[b]]).trim()) row[C_[b]] = who; });
  if (String(row[C_["Sanction date"]]).trim() && !String(row[C_["Login date"]]).trim()) row[C_["Login date"]] = row[C_["Sanction date"]];
  if (ty === "disb" || ty === "closed") row[C_["Next follow-up"]] = "";   // nothing more to follow up
  if (c["Contact Number"] !== undefined && String(c["Contact Number"]).trim()) {   // 11.20: add a missing customer number (Admin can also correct one)
    const was = digits_(rows[i][C_["Contact Number"]]), d = digits_(c["Contact Number"]).replace(/^(91|0)(?=\d{10}$)/, "");
    if (d !== was.slice(-10)) {
      if (was && me.role !== "Admin") throw new Error("Only Admin can change a customer number that is already there");
      if (!/^[6-9]\d{9}$/.test(d)) throw new Error("Customer mobile should be a 10-digit number");
      row[C_["Contact Number"]] = d.slice(0, 5) + " " + d.slice(5);
    }
  }
  row[C_["Contact Number"]] = text_(row[C_["Contact Number"]]);
  ["Connector Contact No", "Banker Contact No"].forEach(h => row[C_[h]] = text_(row[C_[h]]));
  const dd = String(row[C_["Disbursed Date"]]).match(/^(\d{4})-(\d{2})-(\d{2})/);
  row[C_["Disbursed Month"]] = dd ? Utilities.formatDate(new Date(+dd[1], +dd[2] - 1, +dd[3]), "Asia/Kolkata", "MMM-yyyy") : "";
  if (c["Team Lead"] !== undefined && perms_(me).has("caseTL")) {   // people allowed to move a case to another Team Lead
    const t = emps.find(x => x.role === "Team Lead" && (x.id === c["Team Lead"] || norm_(x.name) === norm_(c["Team Lead"])));
    if (t) row[C_["Team Lead"]] = t.name; else if (!String(c["Team Lead"]).trim()) row[C_["Team Lead"]] = "";   // 11.20: a holder who is not a Team Lead is kept
  }
  row[C_["Last updated"]] = now_(); row[C_["Updated by"]] = me.name;
  sh.getRange(i + 2, 1, 1, CASE_COLS).setValues([row]);
  return { saved: true };
}

/* ---------------- website enquiries ---------------- */
// Adds a new, unassigned lead to the Leads tab. Light spam protection: honeypot field,
// Indian mobile validation, one request per number per 6 hours, max 200 requests per hour.
function enquiry_(b) {
  if (b.website) return { saved: true };                            // bots fill the hidden field
  const name = String(b.name || "").replace(/[<>]/g, "").trim().slice(0, 80);
  const d = digits_(b.phone).replace(/^(91|0)(?=\d{10}$)/, "");
  if (name.length < 2) throw new Error("Please enter your name");
  if (!/^[6-9]\d{9}$/.test(d)) throw new Error("Please enter a valid 10-digit mobile number");
  const cache = CacheService.getScriptCache();
  if (cache.get("enq:" + d)) return { saved: true, duplicate: true };
  const count = Number(cache.get("enq:count") || 0);
  if (count >= 200) throw new Error("We're receiving a lot of requests right now");
  cache.put("enq:count", String(count + 1), 3600);
  cache.put("enq:" + d, "1", 6 * 3600);
  const clean = v => String(v || "").replace(/[<>]/g, "").replace(/^[=+\-@]/, "'$&").trim();
  const need = clean(b.need).slice(0, 60) || "Not specified";
  const msg = clean(b.msg).slice(0, 400);
  const sh = sheet_("Leads"); let max = 1000;
  rows_("Leads", 1).forEach(r => { const v = parseInt(String(r[0]).replace(/\D/g, ""), 10); if (v > max) max = v; });
  const at = now_();
  sh.appendRow(["L" + (max + 1), properName_(clean(name)), d.slice(0, 5) + " " + d.slice(5), properName_(clean(b.city)).slice(0, 60), "", "New", "",
    "Website enquiry – " + need + (msg ? ": " + msg : ""), "", at, "Website", need + (msg ? ": " + msg : "")]);
  return { saved: true };
}

/* ---------------- helpers ---------------- */
const ACR_=new Set(["SBI","HDFC","ICICI","BOM","BOB","PNB","LIC","IDFC","IDBI","UCO","RBL","AU","NBFC","CRM","PSF","PL","BL","HL","LAP","CP","KYC","DSA","LLP","CR","EMI","MD","CEO","GM"]);
const SMALL_=new Set(["of","and","in","for","the","to","at","on","by","with"]);
// Proper case for names ("amit nagdevi" -> "Amit Nagdevi", keeps SBI / HDFC / KR in capitals)
function properName_(s){let i=0;return String(s==null?"":s).replace(/\s+/g," ").trim().replace(/[A-Za-z][A-Za-z’']*/g,w=>{const first=i++===0;const core=w.replace(/[’']s$/i,"");
  if(ACR_.has(core.toUpperCase()))return core.toUpperCase()+w.slice(core.length).toLowerCase();if(w===w.toUpperCase()&&w.length<=2)return w;
  if(!first&&SMALL_.has(w.toLowerCase()))return w.toLowerCase();return w[0].toUpperCase()+w.slice(1).toLowerCase()})}
// Tidy free text: capital first letter, "1cr" -> "1 CR"
function tidyText_(s){s=String(s==null?"":s).replace(/[ \t]+/g," ").trim().replace(/(\d+(?:\.\d+)?)\s*cr\b/gi,"$1 CR");return s?s[0].toUpperCase()+s.slice(1):s}

function emps_() { return memo_("emps", empsRead_); }
function empsRead_() {
  const sh = sheet_("Employees"), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const nc = Math.min(11, sh.getMaxColumns());
  const list = sh.getRange(2, 1, n, nc).getDisplayValues().map((r, i) => ({
    id: String(r[0]).trim(), name: String(r[1]).trim(), phone: String(r[2]).trim(),
    active: String(r[3] || "Yes").trim().toLowerCase() !== "no",
    role: roleOf_(r[4]),
    pin: String(r[5] || "").trim(), hash: String(r[6] || "").trim(), tlRaw: String(r[9] || "").trim(),
    last: String(r[7] || "").trim(), permRaw: String(r[10] || "").trim(), row: i + 2
  })).filter(x => x.id && x.name);
  // column J "Team Lead" may hold the Team Lead's name or ID
  const tls = list.filter(x => x.role === "Team Lead");
  list.forEach(x => { const t = x.tlRaw && x.role !== "Team Lead" ? tls.find(y => y.id.toLowerCase() === x.tlRaw.toLowerCase() || norm_(y.name) === norm_(x.tlRaw)) : null; x.tl = t ? t.id : ""; });
  return list;
}
// Each Team Lead gets a tab "Team – <name>": a copy of an existing team tab with the name in B1 (all formulas)
function ensureTeamTab_(name, oldName) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet(), tab = n => n ? ss.getSheetByName("Team – " + n) : null;
    let sh = tab(oldName) || tab(name);
    if (!sh) {
      const tpl = ss.getSheets().find(x => x.getName().indexOf("Team – ") === 0);
      if (!tpl) return;
      sh = tpl.copyTo(ss);
      sh.protect().setDescription("Team tab fills itself – make changes in the CRM or the main tabs").setWarningOnly(true);
    }
    if (sh.getName() !== "Team – " + name) sh.setName("Team – " + name);
    sh.getRange(1, 2).setValue(name);
  } catch (err) { /* the team tab is a convenience – never block saving a person */ }
}
function sheetUrlFor_(me) {
  const ss = SpreadsheetApp.getActiveSpreadsheet(), url = ss.getUrl();
  if (me.role !== "Team Lead") return url;
  const t = ss.getSheetByName("Team – " + me.name);
  return t ? url + "#gid=" + t.getSheetId() : url;
}
// A Team Lead's team = the Team Lead + everyone whose "Team Lead" column points at them
function teamIds_(me, emps) { return new Set(emps.filter(x => x.id === me.id || x.tl === me.id).map(x => x.id)); }
function tlName_(tlId, role) {
  if (!tlId || role === "Team Lead" || rank_(role) < rank_("Team Lead")) return "";
  const t = emps_().find(x => x.id === tlId && x.role === "Team Lead");
  if (!t) throw new Error("Choose a Team Lead from the list");
  return t.name;
}
const pub_ = e => ({ id: e.id, name: e.name, role: e.role, phone: e.phone, perms: [...perms_(e)] });
function checkPin_(p) { if (!/^\d{4}$/.test(String(p || "").trim())) throw new Error("PIN must be exactly 4 digits"); }
function checkName_(n, selfId) {
  n = String(n || "").trim();
  if (n.length < 2) throw new Error("Enter a name (it's used to log in)");
  if (emps_().some(x => x.id !== selfId && x.active && norm_(x.name) === norm_(n))) throw new Error("Someone already has the name \"" + n + "\" – add a surname or initial so logins stay unique");
}
function checkPhone_(p, selfId) {            // mobile is optional contact info
  const d = digits_(p).slice(-10);
  if (!d) return;
  if (d.length < 10) throw new Error("Enter a valid 10-digit mobile number (or leave it empty)");
  if (emps_().some(x => x.id !== selfId && x.active && digits_(x.phone).slice(-10) === d)) throw new Error("Another employee already uses this mobile number");
}
function hash_(id, pin) {
  const props = PropertiesService.getScriptProperties();
  let salt = props.getProperty("salt");
  if (!salt) { salt = Utilities.getUuid(); props.setProperty("salt", salt); }
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + "|" + id + "|" + String(pin).trim());
  return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, "0")).join("");
}
function logoutAll_(id) {
  const props = PropertiesService.getScriptProperties();
  Object.entries(props.getProperties()).forEach(([k, v]) => { if (k.startsWith("s:")) { try { if (JSON.parse(v).id === id) props.deleteProperty(k); } catch (x) {} } });
}
function respond_(fn) {
  let out;
  try { out = Object.assign({ ok: true }, fn()); }
  catch (err) { const m = String(err && err.message || err); out = { ok: false, auth: m.startsWith("AUTH: "), error: m.replace(/^AUTH: /, "") }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
// The contacts tab is called "Calling List" (it was "Leads" before; a "Leads" tab now shows only interested customers).
function sheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = name === "Leads" ? (ss.getSheetByName("Calling List") || ss.getSheetByName("Leads")) : ss.getSheetByName(name);
  if (!sh) throw new Error("Tab '" + name + "' not found in the sheet");
  return sh;
}
function rows_(name, cols) { const sh = sheet_(name), n = sh.getLastRow() - 1; return n < 1 ? [] : sh.getRange(2, 1, n, cols).getDisplayValues(); }
function findRow_(sh, id) {
  const n = sh.getLastRow() - 1; if (n < 1) return 0;
  const ids = sh.getRange(2, 1, n, 1).getDisplayValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]).trim() === String(id)) return i + 2;
  return 0;
}
const digits_ = s => String(s || "").replace(/\D/g, "");
const norm_ = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
function audit_(login, e, result) {
  try { const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("LoginLog");
    if (sh) sh.appendRow([now_(), String(login).slice(0, 60), e ? e.id : "", e ? e.name : "", result]); } catch (x) {}
}
function now_() { return Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyy-MM-dd HH:mm"); }
function text_(p) { p = String(p || ""); return p && !p.startsWith("'") && /^[+\d]/.test(p) && !/\s/.test(p) ? "'" + p : p; }
