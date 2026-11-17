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
 * Employees tab columns:  ID | Name | Phone | Active | Role | PIN | PIN Hash
 *   Role: Admin, Manager, Team Lead or Employee
 *   PIN:  type a first-time PIN here; on first login it is replaced by a hash (PIN Hash) and cleared.
 */

const ROLES = ["Admin", "Manager", "Team Lead", "Employee"];
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
    const me = auth_(b.token);
    if (b.action === "logout") { PropertiesService.getScriptProperties().deleteProperty("s:" + b.token); return {}; }
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      switch (b.action) {
        case "logCall":   return logCall_(me, b);
        case "assign":    need_(me, "Team Lead"); return assign_(b.ids || [], b.to || "");
        case "addLeads":  need_(me, "Team Lead"); return addLeads_(b.leads || []);
        case "addEmp":    need_(me, "Manager");   return addEmp_(me, b);
        case "updateEmp": need_(me, "Manager");   return updateEmp_(me, b);
        case "resetPin":  need_(me, "Manager");   return resetPin_(me, b.id, b.pin);
        case "removeEmp": need_(me, "Manager");   return removeEmp_(me, b.id);
        case "changePin": return changePin_(me, b.oldPin, b.newPin);
        default: throw new Error("Unknown action: " + b.action);
      }
    } finally { lock.releaseLock(); }
  });
}

/* ---------------- auth ---------------- */
function login_(login, pin) {
  login = String(login || "").trim(); pin = String(pin || "").trim();
  if (!login || !pin) throw new Error("Enter your mobile number and PIN");
  const cache = CacheService.getScriptCache(), fk = "fail:" + digits_(login || "x");
  const fails = Number(cache.get(fk) || 0);
  if (fails >= MAX_FAILS) throw new Error("Too many wrong attempts. Try again in " + LOCK_MIN + " minutes.");
  const emps = emps_();
  const d = digits_(login).slice(-10);
  const e = emps.find(x => (d.length >= 10 && digits_(x.phone).slice(-10) === d) || x.id.toLowerCase() === login.toLowerCase());
  let ok = false;
  if (e && e.active) {
    if (e.hash) ok = hash_(e.id, pin) === e.hash;
    else if (e.pin) {
      ok = String(e.pin).trim() === pin;
      if (ok) sheet_("Employees").getRange(e.row, 6, 1, 2).setValues([["", hash_(e.id, pin)]]); // move first-time PIN to hash
    }
  }
  if (!ok) { cache.put(fk, String(fails + 1), LOCK_MIN * 60); throw new Error("Wrong mobile number or PIN"); }
  cache.remove(fk);
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
  let leads = rows_("Leads", 10), logs = rows_("CallLogs", 10);
  if (!isLead) {
    leads = leads.filter(r => String(r[4]).trim() === me.id);
    const ids = new Set(leads.map(r => String(r[0]).trim()));
    logs = logs.filter(r => ids.has(String(r[2]).trim()));
  }
  return {
    me: pub_(me),
    employees: (isLead ? emps : [me]).map(x => [x.id, x.name, x.phone, x.active ? "Yes" : "No", x.role, x.hash || x.pin ? "set" : ""]),
    leads, logs,
    sheetUrl: isLead ? SpreadsheetApp.getActiveSpreadsheet().getUrl() : "",
    serverTime: now_()
  };
}

function logCall_(me, b) {
  const leads = sheet_("Leads");
  const r = findRow_(leads, b.leadId);
  if (!r) throw new Error("Lead " + b.leadId + " not found");
  const lead = leads.getRange(r, 1, 1, 10).getDisplayValues()[0];
  if (rank_(me.role) > rank_("Team Lead") && String(lead[4]).trim() !== me.id) throw new Error("This lead isn't assigned to you");
  const at = now_();
  sheet_("CallLogs").appendRow(["C" + Date.now().toString(36).toUpperCase(), at, lead[0], lead[1], text_(lead[2]),
    me.id, me.name, b.outcome || "", b.remark || "", b.followUp || ""]);
  leads.getRange(r, 6, 1, 4).setValues([[b.outcome || "", b.followUp || "", b.remark || "", at]]);
  return { saved: true };
}

function assign_(ids, to) {
  const sh = sheet_("Leads"), n = sh.getLastRow() - 1;
  if (n < 1) return { updated: 0 };
  const idCol = sh.getRange(2, 1, n, 1).getDisplayValues(), asg = sh.getRange(2, 5, n, 1).getValues();
  const set = new Set(ids.map(String)); let c = 0;
  idCol.forEach((r, i) => { if (set.has(String(r[0]).trim())) { asg[i][0] = to; c++; } });
  sh.getRange(2, 5, n, 1).setValues(asg);
  return { updated: c };
}

function addLeads_(list) {
  const sh = sheet_("Leads"); let max = 1000;
  rows_("Leads", 1).forEach(r => { const v = parseInt(String(r[0]).replace(/\D/g, ""), 10); if (v > max) max = v; });
  const at = now_();
  const out = list.filter(x => x && x.name && x.phone).map(x => ["L" + (++max), x.name, text_(x.phone), x.city || "", x.assignedTo || "", "New", "", "", "", at]);
  if (out.length) sh.getRange(sh.getLastRow() + 1, 1, out.length, 10).setValues(out);
  return { added: out.length };
}

function addEmp_(me, b) {
  const role = ROLES.includes(b.role) ? b.role : "Employee";
  canManage_(me, role);
  if (!b.name) throw new Error("Name is required");
  checkPhone_(b.phone);
  checkPin_(b.pin);
  let max = 0;
  emps_().forEach(x => { const v = parseInt(x.id.replace(/\D/g, ""), 10); if (v > max) max = v; });
  const id = "E" + (max + 1);
  sheet_("Employees").appendRow([id, b.name, text_(b.phone), "Yes", role, "", hash_(id, b.pin)]);
  return { id };
}

function updateEmp_(me, b) {
  const e = emps_().find(x => x.id === b.id);
  if (!e) throw new Error("Employee not found");
  canManage_(me, e.role);
  const role = ROLES.includes(b.role) ? b.role : e.role;
  canManage_(me, role);
  if (e.id === me.id && role !== me.role) throw new Error("You can't change your own role");
  if (b.phone !== undefined) checkPhone_(b.phone, e.id);
  sheet_("Employees").getRange(e.row, 2, 1, 4).setValues([[b.name || e.name, text_(b.phone !== undefined ? b.phone : e.phone), "Yes", role]]);
  return { updated: true };
}

function resetPin_(me, id, pin) {
  const e = emps_().find(x => x.id === id);
  if (!e) throw new Error("Employee not found");
  if (e.id !== me.id) canManage_(me, e.role);
  checkPin_(pin);
  sheet_("Employees").getRange(e.row, 6, 1, 2).setValues([["", hash_(e.id, pin)]]);
  logoutAll_(e.id);
  return { reset: true };
}

function changePin_(me, oldPin, newPin) {
  const ok = me.hash ? hash_(me.id, String(oldPin || "").trim()) === me.hash : String(me.pin) === String(oldPin || "").trim();
  if (!ok) throw new Error("Current PIN is wrong");
  checkPin_(newPin);
  sheet_("Employees").getRange(me.row, 6, 1, 2).setValues([["", hash_(me.id, newPin)]]);
  return { changed: true };
}

function removeEmp_(me, id) {
  const e = emps_().find(x => x.id === id);
  if (!e) throw new Error("Employee not found");
  if (e.id === me.id) throw new Error("You can't remove yourself");
  canManage_(me, e.role);
  sheet_("Employees").getRange(e.row, 4).setValue("No");
  logoutAll_(e.id);
  const ids = rows_("Leads", 5).filter(x => String(x[4]).trim() === e.id).map(x => String(x[0]).trim());
  if (ids.length) assign_(ids, "");
  return { removed: true };
}

/* ---------------- helpers ---------------- */
function emps_() {
  const sh = sheet_("Employees"), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, 7).getDisplayValues().map((r, i) => ({
    id: String(r[0]).trim(), name: String(r[1]).trim(), phone: String(r[2]).trim(),
    active: String(r[3] || "Yes").trim().toLowerCase() !== "no",
    role: ROLES.find(x => x.toLowerCase() === String(r[4] || "").trim().toLowerCase()) || "Employee",
    pin: String(r[5] || "").trim(), hash: String(r[6] || "").trim(), row: i + 2
  })).filter(x => x.id && x.name);
}
const pub_ = e => ({ id: e.id, name: e.name, role: e.role, phone: e.phone });
function checkPin_(p) { if (!/^\d{4,8}$/.test(String(p || "").trim())) throw new Error("PIN must be 4–8 digits"); }
function checkPhone_(p, selfId) {
  const d = digits_(p).slice(-10);
  if (d.length < 10) throw new Error("Enter a valid 10-digit mobile number");
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
function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
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
function now_() { return Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyy-MM-dd HH:mm"); }
function text_(p) { p = String(p || ""); return p && !p.startsWith("'") && /^[+\d]/.test(p) && !/\s/.test(p) ? "'" + p : p; }
