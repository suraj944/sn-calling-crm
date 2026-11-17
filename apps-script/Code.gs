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
 *   - Team Lead (column J): the Team Lead this person reports to (name or ID). A Team Lead only sees, calls and assigns
 *     contacts of their own team. Admin and Manager see everyone. New contacts are given out by Admin / Manager.
 *   - People log in with their NAME + PIN. Names must be unique (case doesn't matter).
 *   - Role: Admin, Manager, Team Lead, Sales Manager or Telecaller Executive (see the Roles tab).
 *     Old "Employee" values are treated as Telecaller Executive.
 *   - PIN: exactly 4 digits. Type it in the PIN column for a new person OR to reset someone's PIN –
 *     a PIN typed here always wins over the old one. On the next login it is replaced by a salted hash and cleared.
 * LoginLog tab: every login attempt (time, name entered, result).
 * Website enquiries (home page callback form) are added to the Calling List as new, unassigned contacts.
 * "Leads" tab = read-only view of customers marked Interested / Converted (a FILTER formula on the Calling List).
 * Field Work tab: SM meetings (same fields as the old Google Form) – see saveMeeting_.
 * Calling List tab (all contacts to call; was "Leads") column K "Source" = Website / Import / Manual, column L "Customer request" = what a website visitor asked for.
 */

const ROLES = ["Admin", "Manager", "Team Lead", "Sales Manager", "Telecaller Executive"];
const MEET_COLS = 21;
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
    try {
      switch (b.action) {
        case "logCall":   return logCall_(me, b);
        case "assign":    need_(me, "Team Lead"); if (!b.to) throw new Error("Choose a telecaller"); return assign_(b.ids || [], b.to, me);
        case "addLeads":  need_(me, "Team Lead"); return addLeads_(b.leads || [], me);
        case "addEmp":    need_(me, "Manager");   return addEmp_(me, b);
        case "updateEmp": need_(me, "Manager");   return updateEmp_(me, b);
        case "resetPin":  need_(me, "Manager");   return resetPin_(me, b.id, b.pin);
        case "removeEmp": need_(me, "Manager");   return removeEmp_(me, b.id);
        case "changePin": return changePin_(me, b.oldPin, b.newPin);
        case "saveMeeting":   return saveMeeting_(me, b.m || {});
        case "deleteMeeting": need_(me, "Manager"); return deleteMeeting_(b.id);
        default: throw new Error("Unknown action: " + b.action);
      }
    } finally { lock.releaseLock(); }
  });
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
        sheet_("Employees").getRange(e.row, 6, 1, 2).setValues([["", hash_(e.id, pin)]]); // move it to the hash
        if (e.hash) logoutAll_(e.id);  // it was a reset: sign out old devices
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
function load_(me) {
  const isLead = rank_(me.role) <= rank_("Team Lead");
  const emps = emps_();
  let leads = rows_("Leads", 12), logs = rows_("CallLogs", 10), people = isLead ? emps : [me];
  if (!isLead || me.role === "Team Lead") {           // telecallers: own contacts; Team Leads: their team's contacts
    const team = !isLead ? new Set([me.id]) : teamIds_(me, emps);
    if (isLead) people = emps.filter(x => team.has(x.id));
    leads = leads.filter(r => team.has(String(r[4]).trim()));
    const ids = new Set(leads.map(r => String(r[0]).trim()));
    logs = logs.filter(r => ids.has(String(r[2]).trim()));
  }
  return {
    me: pub_(me),
    employees: people.map(x => [x.id, x.name, x.phone, x.active ? "Yes" : "No", x.role, x.hash || x.pin ? "set" : "", x.tl || ""]),
    leads, logs,
    sheetUrl: isLead ? SpreadsheetApp.getActiveSpreadsheet().getUrl() : "",
    ...meetings_(me, isLead),
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
  const at = now_();
  sheet_("CallLogs").appendRow(["C" + Date.now().toString(36).toUpperCase(), at, lead[0], lead[1], text_(lead[2]),
    me.id, me.name, b.outcome || "", b.remark || "", b.followUp || ""]);
  leads.getRange(r, 6, 1, 4).setValues([[b.outcome || "", b.followUp || "", b.remark || "", at]]);
  return { saved: true };
}

function assign_(ids, to, me) {
  const sh = sheet_("Leads"), n = sh.getLastRow() - 1;
  if (n < 1) return { updated: 0 };
  const idCol = sh.getRange(2, 1, n, 1).getDisplayValues(), asg = sh.getRange(2, 5, n, 1).getValues();
  const team = me && me.role === "Team Lead" ? teamIds_(me, emps_()) : null;   // Team Leads only move contacts inside their team
  if (team && !team.has(to)) throw new Error("You can only assign to people in your team");
  if (to && !emps_().some(x => x.id === to && x.active)) throw new Error("That person isn't an active team member");
  const set = new Set(ids.map(String)); let c = 0;
  idCol.forEach((r, i) => { if (set.has(String(r[0]).trim())) {
    if (team && !team.has(String(asg[i][0]).trim())) throw new Error("Contact " + r[0] + " isn't in your team");
    asg[i][0] = to; c++; } });
  sh.getRange(2, 5, n, 1).setValues(asg);
  return { updated: c };
}

function addLeads_(list, me) {
  if (me && me.role === "Team Lead") {   // Team Leads add contacts straight to their own team
    const team = teamIds_(me, emps_());
    if (list.some(x => x && !team.has(String(x.assignedTo || "")))) throw new Error("Assign the new contacts to someone in your team");
  }
  const sh = sheet_("Leads"); let max = 1000;
  rows_("Leads", 1).forEach(r => { const v = parseInt(String(r[0]).replace(/\D/g, ""), 10); if (v > max) max = v; });
  const at = now_();
  const src = list.length > 1 ? "Import" : "Manual";
  const out = list.filter(x => x && x.name && x.phone).map(x => ["L" + (++max), properName_(x.name), text_(x.phone), properName_(x.city || ""), x.assignedTo || "", "New", "", "", "", at, src]);
  if (out.length) sh.getRange(sh.getLastRow() + 1, 1, out.length, 11).setValues(out);
  return { added: out.length };
}

function addEmp_(me, b) {
  const role = ROLES.includes(b.role) ? b.role : "Telecaller Executive";
  canManage_(me, role);
  checkName_(b.name);
  checkPhone_(b.phone);
  checkPin_(b.pin);
  let max = 0;
  emps_().forEach(x => { const v = parseInt(x.id.replace(/\D/g, ""), 10); if (v > max) max = v; });
  const id = "E" + (max + 1);
  sheet_("Employees").appendRow([id, properName_(b.name), text_(b.phone || ""), "Yes", role, "", hash_(id, b.pin), "", now_(), tlName_(b.tl, role)]);
  return { id };
}

function updateEmp_(me, b) {
  const e = emps_().find(x => x.id === b.id);
  if (!e) throw new Error("Team member not found");
  canManage_(me, e.role);
  const role = ROLES.includes(b.role) ? b.role : e.role;
  canManage_(me, role);
  if (e.id === me.id && role !== me.role) throw new Error("You can't change your own role");
  if (b.name) checkName_(b.name, e.id);
  if (b.phone !== undefined) checkPhone_(b.phone, e.id);
  const newName = properName_(b.name || e.name), shE = sheet_("Employees");
  shE.getRange(e.row, 2, 1, 4).setValues([[newName, text_(b.phone !== undefined ? b.phone : e.phone), "Yes", role]]);
  if (b.tl !== undefined) shE.getRange(e.row, 10).setValue(tlName_(b.tl, role));
  if (e.role === "Team Lead" && newName !== e.name)               // keep team members pointing at the renamed Team Lead
    emps_().filter(x => x.tl === e.id).forEach(x => shE.getRange(x.row, 10).setValue(newName));
  return { updated: true };
}

function resetPin_(me, id, pin) {
  const e = emps_().find(x => x.id === id);
  if (!e) throw new Error("Team member not found");
  if (e.id !== me.id) canManage_(me, e.role);
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
  sheet_("Employees").getRange(me.row, 6, 1, 2).setValues([["", hash_(me.id, newPin)]]);
  return { changed: true };
}

function removeEmp_(me, id) {
  const e = emps_().find(x => x.id === id);
  if (!e) throw new Error("Team member not found");
  if (e.id === me.id) throw new Error("You can't remove yourself");
  canManage_(me, e.role);
  sheet_("Employees").getRange(e.row, 4).setValue("No");
  logoutAll_(e.id);
  const ids = rows_("Leads", 5).filter(x => String(x[4]).trim() === e.id).map(x => String(x[0]).trim());
  if (ids.length) assign_(ids, "");
  return { removed: true };
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
    const sh = mSheet_(), n = sh.getLastRow() - 1;
    let rows = n < 1 ? [] : sh.getRange(2, 1, n, MEET_COLS).getDisplayValues();
    if (!isLead) rows = rows.filter(r => String(r[3]).trim() === me.id || norm_(r[2]) === norm_(me.name));
    return { meetings: rows };
  } catch (e) { return { meetings: [], meetingsError: String(e && e.message || e) }; }
}
function saveMeeting_(me, m) {
  const isLead = rank_(me.role) <= rank_("Team Lead");
  const c = v => String(v == null ? "" : v).replace(/[<>]/g, "").replace(/^[=+\-@]/, "'$&").trim();
  const person = properName_(c(m.person)).slice(0, 120), entity = properName_(c(m.entity)).slice(0, 120);
  if (person.length < 2 && entity.length < 2) throw new Error("Enter the name of the person or the entity you met");
  const sh = mSheet_(), n = sh.getLastRow() - 1;
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
    properName_(c(m.tieupWith)).slice(0, 100), t(m.passback).slice(0, 100), t(m.feedback).slice(0, 1000), now_(), me.name];
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

function emps_() {
  const sh = sheet_("Employees"), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const list = sh.getRange(2, 1, n, 10).getDisplayValues().map((r, i) => ({
    id: String(r[0]).trim(), name: String(r[1]).trim(), phone: String(r[2]).trim(),
    active: String(r[3] || "Yes").trim().toLowerCase() !== "no",
    role: ROLES.find(x => x.toLowerCase() === String(r[4] || "").trim().toLowerCase()) || "Telecaller Executive",
    pin: String(r[5] || "").trim(), hash: String(r[6] || "").trim(), tlRaw: String(r[9] || "").trim(), row: i + 2
  })).filter(x => x.id && x.name);
  // column J "Team Lead" may hold the Team Lead's name or ID
  const tls = list.filter(x => x.role === "Team Lead");
  list.forEach(x => { const t = x.tlRaw && x.role !== "Team Lead" ? tls.find(y => y.id.toLowerCase() === x.tlRaw.toLowerCase() || norm_(y.name) === norm_(x.tlRaw)) : null; x.tl = t ? t.id : ""; });
  return list;
}
// A Team Lead's team = the Team Lead + everyone whose "Team Lead" column points at them
function teamIds_(me, emps) { return new Set(emps.filter(x => x.id === me.id || x.tl === me.id).map(x => x.id)); }
function tlName_(tlId, role) {
  if (!tlId || role === "Team Lead" || rank_(role) < rank_("Team Lead")) return "";
  const t = emps_().find(x => x.id === tlId && x.role === "Team Lead");
  if (!t) throw new Error("Choose a Team Lead from the list");
  return t.name;
}
const pub_ = e => ({ id: e.id, name: e.name, role: e.role, phone: e.phone });
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
