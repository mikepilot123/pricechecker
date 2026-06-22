/**
 * Device intake backend for the "JQ Reapirs" Google Sheet.
 *
 * Setup:
 *  1. Open the JQ Reapirs spreadsheet -> Extensions -> Apps Script.
 *  2. Replace any starter code with this file's contents.
 *  3. Change PIN below to a private value only your team knows.
 *  4. Deploy -> New deployment -> type "Web app".
 *     - Execute as: Me
 *     - Who has access: Anyone
 *  5. Copy the /exec URL it gives you.
 *  6. In the app's Intake tab, paste that URL + the PIN (one-time, per device).
 *
 * Stores customer name + phone for staff to contact about pickup. Since
 * this sheet now holds personal info, unpublish it from "Publish to web"
 * if it's currently published — the app never reads the public CSV, only
 * this PIN-gated script, so publishing it serves no purpose here.
 */

var PIN = "1234"; // <-- CHANGE THIS to your team's private PIN

var SHEET_NAME = "Intake"; // tab name to use/create
var STATUSES = [
  "Received",
  "Diagnosing",
  "Waiting for Parts",
  "In Progress",
  "Repaired",
  "Picked Up",
  "Cancelled",
];
var HEADERS = [
  "Ticket ID",
  "Date Logged",
  "Customer Name",
  "Phone",
  "Device",
  "Issue",
  "Status",
  "Notes",
  "Last Updated",
];

function doGet(e) {
  return handle((e && e.parameter) || {});
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    body = (e && e.parameter) || {};
  }
  return handle(body);
}

function handle(p) {
  try {
    if (String(p.pin) !== String(PIN)) {
      return json({ ok: false, error: "Invalid PIN" });
    }
    var sheet = getSheet();
    var action = p.action || "list";
    if (action === "list") return json({ ok: true, tickets: listTickets(sheet) });
    if (action === "add") return json({ ok: true, ticket: addTicket(sheet, p) });
    if (action === "update") return json({ ok: true, ticket: updateTicket(sheet, p) });
    return json({ ok: false, error: "Unknown action: " + action });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function getSheet() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    // Brand-new spreadsheet — use the first/active sheet instead of
    // creating a duplicate if it's still untouched (no headers yet).
    var first = ss.getSheets()[0];
    var firstCell = String(first.getRange(1, 1).getValue()).trim();
    sheet = firstCell === "" || firstCell === HEADERS[0] ? first : ss.insertSheet(SHEET_NAME);
  }
  ensureHeaders(sheet);
  return sheet;
}

function ensureHeaders(sheet) {
  var firstCell = String(sheet.getRange(1, 1).getValue()).trim();
  if (firstCell === HEADERS[0]) return;
  if (firstCell !== "") sheet.insertRowBefore(1);
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight("bold");
  sheet.setFrozenRows(1);
}

function listTickets(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var rows = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i][0]) continue; // skip blank rows
    out.push(rowToTicket(rows[i], i + 2));
  }
  out.sort(function (a, b) {
    return new Date(b.updated) - new Date(a.updated);
  });
  return out;
}

function rowToTicket(row, rowNum) {
  return {
    id: row[0],
    created: toIso(row[1]),
    customerName: row[2],
    phone: row[3],
    device: row[4],
    issue: row[5],
    status: row[6],
    notes: row[7],
    updated: toIso(row[8]),
    _row: rowNum,
  };
}

function addTicket(sheet, p) {
  var id = "T" + Date.now().toString(36).toUpperCase();
  var now = new Date();
  var status = STATUSES.indexOf(p.status) >= 0 ? p.status : "Received";
  sheet.appendRow([
    id,
    now,
    p.customerName || "",
    p.phone || "",
    p.device || "",
    p.issue || "",
    status,
    p.notes || "",
    now,
  ]);
  return rowToTicket([
    id,
    now,
    p.customerName || "",
    p.phone || "",
    p.device || "",
    p.issue || "",
    status,
    p.notes || "",
    now,
  ]);
}

function updateTicket(sheet, p) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error("Ticket not found");
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var rowNum = -1;
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(p.id)) {
      rowNum = i + 2;
      break;
    }
  }
  if (rowNum === -1) throw new Error("Ticket not found: " + p.id);

  var current = sheet.getRange(rowNum, 1, 1, HEADERS.length).getValues()[0];
  var customerName = p.customerName != null ? p.customerName : current[2];
  var phone = p.phone != null ? p.phone : current[3];
  var device = p.device != null ? p.device : current[4];
  var issue = p.issue != null ? p.issue : current[5];
  var status = STATUSES.indexOf(p.status) >= 0 ? p.status : current[6];
  var notes = p.notes != null ? p.notes : current[7];
  var now = new Date();

  sheet.getRange(rowNum, 3, 1, 7).setValues([[customerName, phone, device, issue, status, notes, now]]);
  return rowToTicket([current[0], current[1], customerName, phone, device, issue, status, notes, now]);
}

function toIso(v) {
  if (!v) return null;
  var d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? null : d.toISOString();
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
