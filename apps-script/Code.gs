/* ============================================================
   Repair Hub — backend (Google Apps Script)
   Reads/writes a private "Repairs" tab in this spreadsheet.

   SETUP (one time):
   1. Open your Google Sheet (the same pricelist spreadsheet).
   2. Extensions -> Apps Script.
   3. Delete any sample code, paste THIS file's contents.
   4. Change PIN below to a private team PIN (digits are easiest).
   5. Click Deploy -> New deployment -> type "Web app".
        - Description: Repair Hub API
        - Execute as: Me
        - Who has access: Anyone
      Deploy, authorise when prompted, and COPY the Web app URL
      (it ends in /exec).
   6. In the app, go to the Repairs tab -> paste that URL + the PIN.

   The "Repairs" tab is created automatically on first use. Do NOT
   publish that tab to the web — keep client info private. Access is
   gated by the PIN, which only your team enters on their devices.

   To change anything later, edit here and Deploy -> Manage
   deployments -> edit -> Version: New version. (Same URL stays valid.)
   ============================================================ */

var PIN = "1234"; // <-- CHANGE THIS to your team's private PIN
var SHEET_NAME = "Repairs";
var STATUSES = [
  "Received",
  "Diagnosing",
  "Awaiting Approval",
  "In Progress",
  "Awaiting Parts",
  "Ready for Pickup",
  "Collected",
  "Cancelled",
];
var HEADERS = [
  "Ticket ID",
  "Date Logged",
  "Client Name",
  "Phone",
  "Device",
  "Issue / Repair",
  "Quoted Price",
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
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function listTickets(sheet) {
  var values = sheet.getDataRange().getValues();
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (!row[0]) continue;
    out.push(rowToTicket(row));
  }
  out.reverse(); // newest first
  return out;
}

function rowToTicket(row) {
  return {
    id: row[0],
    created: toIso(row[1]),
    client: row[2],
    phone: row[3],
    device: row[4],
    issue: row[5],
    price: row[6],
    status: row[7],
    notes: row[8],
    updated: toIso(row[9]),
  };
}

function addTicket(sheet, p) {
  var now = new Date();
  var id = "R" + String(now.getTime()).slice(-6);
  var status = STATUSES.indexOf(p.status) >= 0 ? p.status : "Received";
  var row = [
    id,
    now,
    p.client || "",
    p.phone || "",
    p.device || "",
    p.issue || "",
    p.price || "",
    status,
    p.notes || "",
    now,
  ];
  sheet.appendRow(row);
  return rowToTicket(row);
}

function updateTicket(sheet, p) {
  var values = sheet.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]) === String(p.id)) {
      var now = new Date();
      var row = values[r];
      if (p.client !== undefined) row[2] = p.client;
      if (p.phone !== undefined) row[3] = p.phone;
      if (p.device !== undefined) row[4] = p.device;
      if (p.issue !== undefined) row[5] = p.issue;
      if (p.price !== undefined) row[6] = p.price;
      if (p.status !== undefined && STATUSES.indexOf(p.status) >= 0) row[7] = p.status;
      if (p.notes !== undefined) row[8] = p.notes;
      row[9] = now;
      sheet.getRange(r + 1, 1, 1, HEADERS.length).setValues([row]);
      return rowToTicket(row);
    }
  }
  throw new Error("Ticket not found: " + p.id);
}

function toIso(v) {
  if (v instanceof Date) return v.toISOString();
  return v || "";
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
