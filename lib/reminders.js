import { sql } from "./db.js";
import { setExpenseReclaimed, RECLAIM_REMINDER_PREFIX } from "./expenses.js";

function text(value) {
  return String(value == null ? "" : value).trim();
}

function dueAtFrom(value) {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) throw new Error("Reminder due date is invalid");
  return d.toISOString();
}

function boolFrom(value, fallback = false) {
  if (value == null) return fallback;
  return value === true || value === "true" || value === 1 || value === "1";
}

function rowToReminder(row) {
  return {
    id: row.id,
    created: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    title: row.title || "",
    notes: row.notes || "",
    dueAt: row.due_at ? new Date(row.due_at).toISOString() : null,
    done: !!row.done,
    doneAt: row.done_at ? new Date(row.done_at).toISOString() : null,
    assignee: row.assignee || "",
    priority: row.priority || "",
    ticketId: row.ticket_id || "",
    ticketLabel: row.ticket_label || "",
    kind: row.kind || "",
    amount: row.amount == null ? null : Number(row.amount),
    expenseId: row.expense_id || "",
  };
}

async function getReminder(id) {
  const rows = await sql`SELECT * FROM reminders WHERE id = ${id}`;
  if (!rows.length) throw new Error("Reminder not found: " + id);
  return rowToReminder(rows[0]);
}

export async function listReminders() {
  const rows = await sql`
    SELECT * FROM reminders
    WHERE deleted_at IS NULL
    ORDER BY done ASC, (due_at IS NULL) ASC, due_at ASC, created_at DESC
  `;
  return rows.map(rowToReminder);
}

export async function addReminder(p) {
  // Client-supplied ids let devices retry a save without duplicating on
  // a flaky connection, same convention as expenses/appointments.
  const id = text(p.id) || "R" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
  const title = text(p.title);
  if (!title) throw new Error("Reminder title is required");
  await sql`
    INSERT INTO reminders (id, title, notes, due_at, done, assignee, priority, ticket_id, ticket_label, kind, amount, expense_id)
    VALUES (
      ${id},
      ${title},
      ${text(p.notes)},
      ${dueAtFrom(p.dueAt)},
      ${boolFrom(p.done)},
      ${text(p.assignee)},
      ${text(p.priority)},
      ${text(p.ticketId) || null},
      ${text(p.ticketLabel)},
      ${text(p.kind)},
      ${p.amount == null || p.amount === "" ? null : Number(p.amount)},
      ${text(p.expenseId) || null}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  return getReminder(id);
}

export async function updateReminder(p) {
  const id = text(p.id);
  if (!id) throw new Error("Reminder ID is required");
  const rows = await sql`SELECT * FROM reminders WHERE id = ${id} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Reminder not found: " + id);
  const current = rows[0];
  const title = p.title != null ? text(p.title) : current.title;
  if (!title) throw new Error("Reminder title is required");
  const done = p.done != null ? boolFrom(p.done) : current.done;
  const wasDone = !!current.done;
  await sql`
    UPDATE reminders
    SET title = ${title},
        notes = ${p.notes != null ? text(p.notes) : current.notes},
        due_at = ${p.dueAt !== undefined ? dueAtFrom(p.dueAt) : current.due_at},
        done = ${done},
        done_at = ${done ? (wasDone ? current.done_at : new Date().toISOString()) : null},
        assignee = ${p.assignee != null ? text(p.assignee) : current.assignee},
        priority = ${p.priority != null ? text(p.priority) : current.priority},
        ticket_id = ${p.ticketId !== undefined ? (text(p.ticketId) || null) : current.ticket_id},
        ticket_label = ${p.ticketLabel != null ? text(p.ticketLabel) : current.ticket_label},
        kind = ${p.kind != null ? text(p.kind) : current.kind},
        amount = ${p.amount !== undefined ? (p.amount == null || p.amount === "" ? null : Number(p.amount)) : current.amount},
        expense_id = ${p.expenseId !== undefined ? (text(p.expenseId) || null) : current.expense_id},
        updated_at = now()
    WHERE id = ${id}
  `;
  const reminder = await getReminder(id);
  // Ticking off a cash-reclaim reminder is how staff record that the money
  // came back, so push that straight onto the expense it was generated from.
  if (reminder.expenseId && reminder.kind === "cash_reclaim" && done !== wasDone) {
    await setExpenseReclaimed(reminder.expenseId, done, reminder.doneAt);
  }
  return reminder;
}

export async function deleteReminder(p) {
  const id = text(p.id);
  if (!id) throw new Error("Reminder ID is required");
  const rows = await sql`SELECT * FROM reminders WHERE id = ${id} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Reminder not found: " + id);
  await sql`UPDATE reminders SET deleted_at = now(), updated_at = now() WHERE id = ${id}`;
  // Dismissing the reminder for a cash reclaim means "stop chasing this", so
  // clear the flag on the expense too — otherwise the next edit of that
  // expense would helpfully recreate the reminder staff just deleted.
  if (id.startsWith(RECLAIM_REMINDER_PREFIX)) {
    const expenseId = id.slice(RECLAIM_REMINDER_PREFIX.length);
    await sql`UPDATE expenses SET cash_reclaim = FALSE, reclaimed_at = NULL, reclaimed_amount = 0, updated_at = now() WHERE id = ${expenseId}`;
  }
  return id;
}
