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
 *  5. Copy the /exec URL it gives you and set it as SCRIPT_URL at the
 *     top of assets/intake.js.
 *
 * Stores customer name + phone for staff to contact about pickup. Since
 * this sheet now holds personal info, it must stay unpublished (no
 * "Publish to web", no "Anyone with the link") — the app only ever talks
 * to this PIN-gated script, never a public CSV.
 *
 * Every status/issue/device/notes change is appended to a History column
 * as a timestamped log line, so the team can see the full timeline of
 * what happened to a device, not just its current state.
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
  "Issues",
  "Status",
  "Notes",
  "History",
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
    if (action === "delete") return json({ ok: true, deletedId: deleteTicket(sheet, p) });
    if (action === "clear") return json({ ok: true, deletedCount: clearTickets(sheet) });
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
  if (firstCell !== HEADERS[0]) {
    if (firstCell !== "") sheet.insertRowBefore(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight("bold");
    sheet.setFrozenRows(1);
    return;
  }

  // Migrate the original intake sheet in place. It had Device immediately
  // after Date Logged, so insert the missing client columns before it. This
  // preserves every existing device record while giving new/edited records a
  // durable place for the customer's name and phone number.
  var lastCol = sheet.getLastColumn();
  var existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var hasCustomer = existing.indexOf("Customer Name") !== -1 || existing.indexOf("Client Name") !== -1;
  if (!hasCustomer) {
    sheet.insertColumnsBefore(3, 2);
    lastCol += 2;
    existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  }

  // History arrived after the customer fields. Keep it directly before the
  // Last Updated column rather than overwriting any stored timestamps.
  if (existing.indexOf("History") === -1) {
    var updatedCol = existing.indexOf("Last Updated") + 1;
    if (updatedCol > 0) sheet.insertColumnBefore(updatedCol);
    else sheet.insertColumnAfter(sheet.getLastColumn());
  }
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
    // Keep the legacy field during the transition so older page versions
    // also show the customer rather than “Unknown customer”.
    client: row[2],
    phone: row[3],
    device: row[4],
    issues: row[5],
    issue: row[5],
    status: row[6],
    notes: row[7],
    history: row[8],
    updated: toIso(row[9]),
    _row: rowNum,
  };
}

function historyLine(msg) {
  return "[" + new Date().toISOString() + "] " + msg;
}

function addTicket(sheet, p) {
  var id = "T" + Date.now().toString(36).toUpperCase();
  var now = new Date();
  var status = STATUSES.indexOf(p.status) >= 0 ? p.status : "Received";
  var history = historyLine("Logged — " + status);
  sheet.appendRow([
    id,
    now,
    customerNameFrom(p),
    p.phone || "",
    p.device || "",
    issuesFrom(p),
    status,
    p.notes || "",
    history,
    now,
  ]);
  return rowToTicket([
    id,
    now,
    customerNameFrom(p),
    p.phone || "",
    p.device || "",
    issuesFrom(p),
    status,
    p.notes || "",
    history,
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
  var customerName = hasCustomerName(p) ? customerNameFrom(p) : current[2];
  var phone = p.phone != null ? p.phone : current[3];
  var device = p.device != null ? p.device : current[4];
  var issues = hasIssues(p) ? issuesFrom(p) : current[5];
  var status = STATUSES.indexOf(p.status) >= 0 ? p.status : current[6];
  var notes = p.notes != null ? p.notes : current[7];
  var now = new Date();

  // Build history entries for whatever actually changed.
  var lines = [];
  if (status !== current[6]) lines.push(historyLine("Status: " + current[6] + " → " + status));
  if (device !== current[4]) lines.push(historyLine("Device updated to " + device));
  if (issues !== current[5]) lines.push(historyLine("Issues updated: " + (issues || "—")));
  if (notes !== current[7]) lines.push(historyLine("Notes updated"));
  var history = current[8] || "";
  if (lines.length) history = (history ? history + "\n" : "") + lines.join("\n");

  sheet.getRange(rowNum, 3, 1, 7).setValues([[customerName, phone, device, issues, status, notes, history]]);
  sheet.getRange(rowNum, 10, 1, 1).setValue(now);
  return rowToTicket([current[0], current[1], customerName, phone, device, issues, status, notes, history, now]);
}

function deleteTicket(sheet, p) {
  if (!p.id) throw new Error("Ticket ID is required");
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error("Ticket not found");
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(p.id)) {
      sheet.deleteRow(i + 2);
      return p.id;
    }
  }
  throw new Error("Ticket not found: " + p.id);
}

function clearTickets(sheet) {
  var lastRow = sheet.getLastRow();
  var count = Math.max(0, lastRow - 1); // Keep the header row.
  if (count) sheet.deleteRows(2, count);
  return count;
}

function toIso(v) {
  if (!v) return null;
  var d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? null : d.toISOString();
}

// Accept both the current API names and the field names used by the first
// intake dashboard. This lets the website and deployed script be upgraded in
// either order without losing client information.
function hasCustomerName(p) {
  return p.customerName != null || p.client != null;
}

function customerNameFrom(p) {
  return p.customerName != null ? p.customerName : (p.client || "");
}

function hasIssues(p) {
  return p.issues != null || p.issue != null;
}

function issuesFrom(p) {
  return p.issues != null ? p.issues : (p.issue || "");
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
