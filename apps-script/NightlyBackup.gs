/**
 * Nightly off-site backup of the Repair Hub into this Google Sheet.
 *
 * Why this exists: the app's own listBackups/restoreBackup snapshots live in
 * the same Postgres database as the live data, so if that database is lost or
 * the app goes down they go with it. This pulls the data out to somewhere
 * completely independent — a Sheet in the owner's Google account — every
 * night, so there is always a readable copy that survives the app.
 *
 * SETUP (one time)
 *  1. Extensions -> Apps Script in this spreadsheet, paste this file.
 *  2. Project Settings -> Script Properties -> add: INTAKE_PIN = <team PIN>.
 *     The PIN is read from there, never stored in this file, because this
 *     file is committed to the repo.
 *  3. Project Settings -> set the timezone to (GMT-04:00) Atlantic Time —
 *     Trinidad, or the 9pm trigger will fire on the wrong clock.
 *  4. Run installBackupTrigger() once and approve the permission prompt.
 *
 * After that it runs itself at 9pm nightly. runBackupNow() does an immediate
 * backup if you ever want to force one.
 */

var API_URL = "https://pricechecker-cyan.vercel.app/api/intake";
var LEADS_URL = "https://pricechecker-cyan.vercel.app/api/leads";

// 21 = 9pm, in the script's timezone (see setup step 3).
var BACKUP_HOUR = 21;

// Dated snapshots of the tickets tab are kept so a single bad night can't
// silently overwrite the last good copy — a backup you can destroy by
// running it isn't a backup. Older ones are pruned to keep the file small.
var SNAPSHOT_PREFIX = "Snapshot ";
var SNAPSHOTS_TO_KEEP = 14;

var LOG_SHEET = "Backup Log";

/** Each dataset: sheet tab, request, and the columns to write. */
function datasets() {
  return [
    { tab: "Tickets", url: API_URL, payload: { action: "list", includeDeleted: true }, key: "tickets",
      cols: ["id","created","updated","customerName","phone","email","device","issues","status","technician",
             "repairCost","amountPaid","repairDueDate","notes","history"] },
    { tab: "Ticket Notes", url: API_URL, payload: { action: "listAllTicketNotes" }, key: "notes",
      cols: ["id","ticketId","note","created"] },
    { tab: "Appointments", url: API_URL, payload: { action: "listAppointments" }, key: "appointments",
      cols: ["id","created","client","phone","device","issue","technician","date","time","source","status","notes"] },
    { tab: "Expenses", url: API_URL, payload: { action: "listExpenses" }, key: "expenses",
      cols: ["id","date","category","vendor","amount","notes","cashReclaim","reclaimFrom","reclaimDueAt","reclaimedAt"] },
    { tab: "Reminders", url: API_URL, payload: { action: "listReminders" }, key: "reminders",
      cols: ["id","title","notes","dueAt","done","doneAt","assignee","priority","kind","ticketId","expenseId"] },
    { tab: "Customers", url: API_URL, payload: { action: "listCustomers" }, key: "customers",
      cols: ["id","name","phone","email","ticketCount","lastTicketAt","created","updated"] },
    { tab: "Leads", url: LEADS_URL, payload: { action: "list" }, key: "leads",
      cols: ["id","created","customerName","phone","email","device","issue","quotedAmount","source","status","followUpDate"] }
  ];
}

function pin_() {
  var value = PropertiesService.getScriptProperties().getProperty("INTAKE_PIN");
  if (!value) {
    throw new Error("INTAKE_PIN is not set. Project Settings -> Script Properties -> add INTAKE_PIN.");
  }
  return value;
}

/** One API call. The API returns { ok: false, error } rather than an HTTP error for a bad PIN. */
function fetchDataset_(dataset) {
  var payload = {};
  for (var k in dataset.payload) payload[k] = dataset.payload[k];
  payload.pin = pin_();
  var res = UrlFetchApp.fetch(dataset.url, {
    method: "post",
    contentType: "text/plain;charset=utf-8",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200) throw new Error(dataset.tab + ": HTTP " + code);
  var body = JSON.parse(res.getContentText());
  if (!body.ok) throw new Error(dataset.tab + ": " + (body.error || "rejected"));
  return body[dataset.key] || [];
}

function cell_(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  // Long history/notes blobs can exceed a cell's 50k character limit.
  var text = String(value);
  return text.length > 49000 ? text.slice(0, 49000) + "…[truncated]" : text;
}

function writeSheet_(spreadsheet, tabName, cols, rows) {
  var sheet = spreadsheet.getSheetByName(tabName) || spreadsheet.insertSheet(tabName);
  sheet.clear();
  var values = [cols];
  for (var i = 0; i < rows.length; i++) {
    var row = [];
    for (var c = 0; c < cols.length; c++) row.push(cell_(rows[i][cols[c]]));
    values.push(row);
  }
  // One setValues call — writing row by row is what makes Apps Script slow.
  sheet.getRange(1, 1, values.length, cols.length).setValues(values);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, cols.length).setFontWeight("bold");
  return rows.length;
}

/** Dated copy of the tickets tab, with old ones pruned. */
function writeSnapshot_(spreadsheet, cols, rows) {
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  var name = SNAPSHOT_PREFIX + stamp;
  var existing = spreadsheet.getSheetByName(name);
  if (existing) spreadsheet.deleteSheet(existing); // re-running the same day replaces it
  writeSheet_(spreadsheet, name, cols, rows);

  var snapshots = spreadsheet.getSheets()
    .map(function (s) { return s.getName(); })
    .filter(function (n) { return n.indexOf(SNAPSHOT_PREFIX) === 0; })
    .sort();
  while (snapshots.length > SNAPSHOTS_TO_KEEP) {
    var oldest = snapshots.shift();
    var sheet = spreadsheet.getSheetByName(oldest);
    if (sheet) spreadsheet.deleteSheet(sheet);
  }
}

function logRun_(spreadsheet, status, detail) {
  var sheet = spreadsheet.getSheetByName(LOG_SHEET) || spreadsheet.insertSheet(LOG_SHEET);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["When", "Status", "Detail"]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 3).setFontWeight("bold");
  }
  sheet.appendRow([
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss"),
    status,
    detail
  ]);
}

/** The nightly job. */
function runBackupNow() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var list = datasets();
  var counts = [];
  var failures = [];

  for (var i = 0; i < list.length; i++) {
    var dataset = list[i];
    try {
      var rows = fetchDataset_(dataset);
      writeSheet_(spreadsheet, dataset.tab, dataset.cols, rows);
      counts.push(dataset.tab + ": " + rows.length);
      if (dataset.tab === "Tickets") writeSnapshot_(spreadsheet, dataset.cols, rows);
    } catch (err) {
      // One failing dataset must not cost us the others — a partial backup
      // beats none, and the log says exactly what was missed.
      failures.push(String(err && err.message ? err.message : err));
    }
  }

  var detail = counts.join(", ") + (failures.length ? " | FAILED: " + failures.join("; ") : "");
  logRun_(spreadsheet, failures.length ? "PARTIAL/FAILED" : "OK", detail);

  // A backup that fails quietly is worse than no backup, because you think
  // you're covered. Shout about it.
  if (failures.length) notifyFailure_(detail);
  return detail;
}

function notifyFailure_(detail) {
  try {
    var email = Session.getEffectiveUser().getEmail();
    if (!email) return;
    MailApp.sendEmail(email, "Repair Hub backup FAILED", "The nightly backup did not complete:\n\n" + detail);
  } catch (err) {
    // Mail scope not granted / quota hit — the log row still records it.
  }
}

// Puts a "Repair Hub Backup" menu in the Sheet's own menu bar. Running a
// backup by hand shouldn't mean opening the script editor and hunting for the
// right function in the Run dropdown — from here it's one click, which also
// makes it easy to confirm the thing still works after any change.
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Repair Hub Backup")
    .addItem("Back up now", "runBackupNow")
    .addSeparator()
    .addItem("Reschedule nightly 9pm job", "installBackupTrigger")
    .addToUi();
}

/** Run once, by hand, to schedule the nightly job. Safe to re-run. */
function installBackupTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "runBackupNow") ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger("runBackupNow").timeBased().atHour(BACKUP_HOUR).everyDays(1).create();
  var when = BACKUP_HOUR + ":00 " + Session.getScriptTimeZone();
  logRun_(SpreadsheetApp.getActiveSpreadsheet(), "TRIGGER INSTALLED", "Nightly backup scheduled for ~" + when);
  return "Nightly backup scheduled for ~" + when;
}
