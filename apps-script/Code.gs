/**
 * SN Calling CRM – Google Apps Script backend
 *
 * Lets the CRM website (GitHub Pages) read and write this Google Sheet.
 *
 * SETUP (one time, ~2 minutes):
 *  1. Open the Google Sheet → Extensions → Apps Script.
 *  2. Delete everything in Code.gs and paste this whole file.
 *  3. Change API_KEY below to your own secret (any long random text).
 *  4. Click Deploy → New deployment → type "Web app".
 *       Execute as:      Me
 *       Who has access:  Anyone
 *     Click Deploy, allow the permissions, and copy the Web app URL.
 *  5. Open the CRM website → "⚙ Connect sheet" → paste the URL and the key.
 *
 * The sheet must have three tabs: Employees, Leads, CallLogs (see README).
 */

const API_KEY = "CHANGE_ME_TO_A_LONG_SECRET";
const TZ = "Asia/Kolkata";

/* ---------- entry points ---------- */
function doGet(e) {
  return respond(() => {
    checkKey(e.parameter.key);
    if ((e.parameter.action || "load") === "load") return load();
    throw new Error("Unknown action");
  });
}

function doPost(e) {
  return respond(() => {
    const body = JSON.parse(e.postData.contents || "{}");
    checkKey(body.key);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      switch (body.action) {
        case "logCall":   return logCall(body);
        case "assign":    return assign(body.ids || [], body.to || "");
        case "addLeads":  return addLeads(body.leads || []);
        case "addEmp":    return addEmp(body.name, body.phone);
        case "removeEmp": return removeEmp(body.id);
        default: throw new Error("Unknown action: " + body.action);
      }
    } finally {
      lock.releaseLock();
    }
  });
}

/* ---------- actions ---------- */
function load() {
  return {
    employees: rows_("Employees", 4),
    leads: rows_("Leads", 10),
    logs: rows_("CallLogs", 10),
    serverTime: now_()
  };
}

function logCall(b) {
  const leads = sheet_("Leads");
  const r = findRow_(leads, b.leadId);
  if (!r) throw new Error("Lead " + b.leadId + " not found");
  const lead = leads.getRange(r, 1, 1, 10).getDisplayValues()[0];
  const at = now_();
  sheet_("CallLogs").appendRow([
    "C" + Date.now().toString(36).toUpperCase(), at, lead[0], lead[1], text_(lead[2]),
    b.by || "", b.byName || "", b.outcome || "", b.remark || "", b.followUp || ""
  ]);
  leads.getRange(r, 6, 1, 4).setValues([[b.outcome || "", b.followUp || "", b.remark || "", at]]);
  return { saved: true };
}

function assign(ids, to) {
  const sh = sheet_("Leads");
  const n = sh.getLastRow() - 1;
  if (n < 1) return { updated: 0 };
  const idCol = sh.getRange(2, 1, n, 1).getDisplayValues();
  const asg = sh.getRange(2, 5, n, 1).getValues();
  const set = new Set(ids.map(String));
  let c = 0;
  idCol.forEach((r, i) => { if (set.has(String(r[0]).trim())) { asg[i][0] = to; c++; } });
  sh.getRange(2, 5, n, 1).setValues(asg);
  return { updated: c };
}

function addLeads(list) {
  const sh = sheet_("Leads");
  let max = 1000;
  rows_("Leads", 1).forEach(r => { const v = parseInt(String(r[0]).replace(/\D/g, ""), 10); if (v > max) max = v; });
  const at = now_();
  const out = list.filter(x => x && x.name && x.phone).map(x =>
    ["L" + (++max), x.name, text_(x.phone), x.city || "", x.assignedTo || "", "New", "", "", "", at]);
  if (out.length) sh.getRange(sh.getLastRow() + 1, 1, out.length, 10).setValues(out);
  return { added: out.length };
}

function addEmp(name, phone) {
  if (!name) throw new Error("Name is required");
  let max = 0;
  rows_("Employees", 1).forEach(r => { const v = parseInt(String(r[0]).replace(/\D/g, ""), 10); if (v > max) max = v; });
  sheet_("Employees").appendRow(["E" + (max + 1), name, text_(phone || ""), "Yes"]);
  return { id: "E" + (max + 1) };
}

function removeEmp(id) {
  const sh = sheet_("Employees");
  const r = findRow_(sh, id);
  if (r) sh.getRange(r, 4).setValue("No");
  const ids = rows_("Leads", 5).filter(x => String(x[4]).trim() === String(id)).map(x => String(x[0]).trim());
  if (ids.length) assign(ids, "");
  return { removed: !!r };
}

/* ---------- helpers ---------- */
function respond(fn) {
  let out;
  try { out = Object.assign({ ok: true }, fn()); }
  catch (err) { out = { ok: false, error: String(err && err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
function checkKey(k) { if (!k || k !== API_KEY) throw new Error("Wrong access key"); }
function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error("Tab '" + name + "' not found in the sheet");
  return sh;
}
function rows_(name, cols) {
  const sh = sheet_(name);
  const n = sh.getLastRow() - 1;
  return n < 1 ? [] : sh.getRange(2, 1, n, cols).getDisplayValues();
}
function findRow_(sh, id) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  const ids = sh.getRange(2, 1, n, 1).getDisplayValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]).trim() === String(id)) return i + 2;
  return 0;
}
function now_() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm"); }
// keep phone numbers as text (stops "+91…" becoming a formula and long numbers losing format)
function text_(p) { p = String(p || ""); return p && !p.startsWith("'") && /^[+\d]/.test(p) && !/\s/.test(p) ? "'" + p : p; }
