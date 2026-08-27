import { sql } from "./db.js";

export const APPOINTMENT_STATUSES = ["scheduled", "completed", "cancelled"];

function text(value) {
  return String(value == null ? "" : value).trim();
}

function dateFrom(value) {
  if (value instanceof Date && !isNaN(value)) return value.toISOString().slice(0, 10);
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error("Appointment date must be YYYY-MM-DD");
  return raw;
}

function timeFrom(value) {
  const raw = text(value);
  if (!/^\d{2}:\d{2}$/.test(raw)) throw new Error("Appointment time must be HH:MM");
  return raw;
}

function statusFrom(value, fallback = "scheduled") {
  const status = text(value).toLowerCase() || fallback;
  return APPOINTMENT_STATUSES.includes(status) ? status : fallback;
}

// Every appointment mirrors into one reminder, so it shows up in the
// Reminders tab and pops up as an alert without staff having to remember to
// add one by hand. Fires a fixed lead time before the appointment rather
// than at the exact minute, so there's still time to prep or call ahead.
const APPT_REMINDER_PREFIX = "APPT:";
const APPT_REMINDER_LEAD_MINUTES = 30;
// Trinidad & Tobago is fixed at UTC-4 with no DST (the app's currency and
// prices are already TTD-only — see lib/invoices.js), so appointment date +
// time, entered as shop wall-clock time, converts to a real instant via this
// zone rather than guessing an offset from the request.
const SHOP_TIME_ZONE = "America/Port_of_Spain";

function appointmentReminderId(id) {
  return APPT_REMINDER_PREFIX + id;
}

async function syncAppointmentReminder(appt) {
  const id = appointmentReminderId(appt.id);
  if (appt.status !== "scheduled") {
    // Completed or cancelled — the heads-up has served its purpose (or
    // never needs to fire), so retire it rather than leaving a stale alert.
    await sql`
      UPDATE reminders
      SET deleted_at = COALESCE(deleted_at, now()), updated_at = now()
      WHERE id = ${id} AND deleted_at IS NULL
    `;
    return;
  }
  const title = `Appointment: ${appt.client}${appt.device ? " — " + appt.device : ""}`;
  const notes = [
    `Scheduled for ${appt.date} at ${appt.time}${appt.technician ? " with " + appt.technician : ""}.`,
    appt.issue ? `Issue: ${appt.issue}.` : "",
    appt.phone ? `Phone: ${appt.phone}.` : "",
    appt.notes,
  ].filter(Boolean).join(" ");
  // Guarded rather than an unconditional INSERT: the legacy-bookings
  // migration (assets/appointments.js's migrateLegacyAppointments) can push a
  // whole batch of old localStorage appointments through addAppointment in
  // one go, and a reminder for something that already happened weeks ago is
  // just noise. Reminders only get created (or refreshed) while the
  // appointment is still within a day of "coming up".
  await sql`
    INSERT INTO reminders (id, title, notes, due_at, done, assignee, priority, kind, appointment_id)
    SELECT ${id}, ${title}, ${notes}, computed.due_at, FALSE, ${appt.technician}, '', 'appointment', ${appt.id}
    FROM (
      SELECT ((${appt.date}::date + ${appt.time}::time) AT TIME ZONE ${SHOP_TIME_ZONE})
             - (${APPT_REMINDER_LEAD_MINUTES} || ' minutes')::interval AS due_at
    ) computed
    WHERE computed.due_at > now() - interval '1 day'
    ON CONFLICT (id) DO UPDATE
    SET title = EXCLUDED.title,
        notes = EXCLUDED.notes,
        due_at = EXCLUDED.due_at,
        assignee = EXCLUDED.assignee,
        kind = EXCLUDED.kind,
        appointment_id = EXCLUDED.appointment_id,
        deleted_at = NULL,
        updated_at = now()
  `;
}

function rowToAppointment(row) {
  return {
    id: row.id,
    created: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    client: row.client || "",
    phone: row.phone || "",
    device: row.device || "",
    issue: row.issue || "",
    technician: row.technician || "",
    date: row.date ? dateFrom(row.date) : "",
    time: row.time || "",
    source: row.source || "",
    notes: row.notes || "",
    status: row.status || "scheduled",
  };
}

async function getAppointment(id) {
  const rows = await sql`SELECT * FROM appointments WHERE id = ${id}`;
  if (!rows.length) throw new Error("Appointment not found: " + id);
  return rowToAppointment(rows[0]);
}

export async function listAppointments() {
  const rows = await sql`SELECT * FROM appointments WHERE deleted_at IS NULL ORDER BY date, time`;
  return rows.map(rowToAppointment);
}

export async function addAppointment(p) {
  // Devices that migrate their old localStorage bookings send their own ids;
  // ON CONFLICT keeps a retry (or two devices migrating the same shared
  // browser profile) from throwing instead of converging.
  const id = text(p.id) || "A" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
  const client = text(p.client);
  if (!client) throw new Error("Client name is required");
  await sql`
    INSERT INTO appointments (id, client, phone, device, issue, technician, date, time, source, notes, status)
    VALUES (
      ${id},
      ${client},
      ${text(p.phone)},
      ${text(p.device)},
      ${text(p.issue)},
      ${text(p.technician)},
      ${dateFrom(p.date)},
      ${timeFrom(p.time)},
      ${text(p.source)},
      ${text(p.notes)},
      ${statusFrom(p.status)}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  const appointment = await getAppointment(id);
  await syncAppointmentReminder(appointment);
  return appointment;
}

export async function updateAppointment(p) {
  const id = text(p.id);
  if (!id) throw new Error("Appointment ID is required");
  const rows = await sql`SELECT * FROM appointments WHERE id = ${id} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Appointment not found: " + id);
  const current = rows[0];
  const client = p.client != null ? text(p.client) : current.client;
  if (!client) throw new Error("Client name is required");
  await sql`
    UPDATE appointments
    SET client = ${client},
        phone = ${p.phone != null ? text(p.phone) : current.phone},
        device = ${p.device != null ? text(p.device) : current.device},
        issue = ${p.issue != null ? text(p.issue) : current.issue},
        technician = ${p.technician != null ? text(p.technician) : current.technician},
        date = ${p.date != null ? dateFrom(p.date) : dateFrom(current.date)},
        time = ${p.time != null ? timeFrom(p.time) : current.time},
        source = ${p.source != null ? text(p.source) : current.source},
        notes = ${p.notes != null ? text(p.notes) : current.notes},
        status = ${p.status != null ? statusFrom(p.status, current.status) : current.status},
        updated_at = now()
    WHERE id = ${id}
  `;
  const appointment = await getAppointment(id);
  await syncAppointmentReminder(appointment);
  return appointment;
}

export async function deleteAppointment(p) {
  const id = text(p.id);
  if (!id) throw new Error("Appointment ID is required");
  const rows = await sql`SELECT * FROM appointments WHERE id = ${id} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Appointment not found: " + id);
  await sql`UPDATE appointments SET deleted_at = now(), updated_at = now() WHERE id = ${id}`;
  await sql`
    UPDATE reminders
    SET deleted_at = COALESCE(deleted_at, now()), updated_at = now()
    WHERE id = ${appointmentReminderId(id)} AND deleted_at IS NULL
  `;
  return id;
}
