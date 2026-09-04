import {
  listTickets,
  addTicket,
  updateTicket,
  deleteTicket,
  clearAll,
  listBackups,
  restoreBackup,
  listTechnicians,
  addTechnician,
  deleteTechnician,
  listMonthlySales,
  rebuildMonthlySales,
  listTicketNotes,
  listAllTicketNotes,
  addTicketNote,
  deleteTicketNote,
} from "../lib/tickets.js";
import { listMedia, addMedia, deleteMedia } from "../lib/media.js";
import { listCustomers } from "../lib/customers.js";
import { listAppointments, addAppointment, updateAppointment, deleteAppointment } from "../lib/appointments.js";
import { listExpenses, addExpense, updateExpense, deleteExpense } from "../lib/expenses.js";
import { listReminders, addReminder, updateReminder, deleteReminder } from "../lib/reminders.js";
import {
  listCardPayments,
  listCollectable,
  accountSummary,
  addCardPayment,
  updateCardPayment,
  voidCardPayment,
  syncTakingsReminder,
} from "../lib/card-payments.js";
import { listPayouts, addPayout, voidPayout } from "../lib/payouts.js";
import { getAccountSettings, saveAccountSettings } from "../lib/settings.js";
import { ensureSchema } from "../lib/db.js";
import { applyCors, checkPin } from "../lib/security.js";

// Mirrors apps-script/Code.gs's handle(p) dispatch-by-action shape exactly,
// so assets/intake.js needs no changes beyond pointing SCRIPT_URL at this
// endpoint: same { action, pin, ...fields } request shape, same { ok, ... }
// response shape. Two new actions (listBackups, restoreBackup) are additive —
// the current frontend doesn't call them yet, they're for the Settings
// version-history UI.
export default async function handler(req, res) {
  // The frontend (GitHub Pages) is cross-origin from this Vercel deployment.
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const body = req.method === "GET" ? (req.query || {}) : readBody(req);

  const denied = checkPin(req, body.pin);
  if (denied) {
    return res.status(denied.status).json({ ok: false, error: denied.error });
  }

  const action = body.action || "list";
  try {
    await ensureSchema();
    if (action === "list") {
      return res.status(200).json({ ok: true, tickets: await listTickets({ includeDeleted: !!body.includeDeleted }) });
    }
    if (action === "add") {
      return res.status(200).json({ ok: true, ticket: await addTicket(body) });
    }
    if (action === "update") {
      return res.status(200).json({ ok: true, ticket: await updateTicket(body) });
    }
    if (action === "delete") {
      return res.status(200).json({ ok: true, deletedId: await deleteTicket(body) });
    }
    if (action === "clear") {
      const { deletedCount, backup } = await clearAll();
      return res.status(200).json({ ok: true, deletedCount, backup });
    }
    if (action === "listBackups") {
      return res.status(200).json({ ok: true, backups: await listBackups() });
    }
    if (action === "restoreBackup") {
      const { restoredCount, backup, tickets } = await restoreBackup(body);
      return res.status(200).json({ ok: true, restoredCount, backup, tickets });
    }
    if (action === "listTechnicians") {
      return res.status(200).json({ ok: true, technicians: await listTechnicians() });
    }
    if (action === "addTechnician") {
      return res.status(200).json({ ok: true, technicians: await addTechnician(body) });
    }
    if (action === "deleteTechnician") {
      return res.status(200).json({ ok: true, technicians: await deleteTechnician(body) });
    }
    if (action === "listCustomers") {
      return res.status(200).json({ ok: true, customers: await listCustomers() });
    }
    if (action === "listMedia") {
      return res.status(200).json({ ok: true, media: await listMedia(body.ticketId) });
    }
    if (action === "addMedia") {
      return res.status(200).json({ ok: true, media: await addMedia(body) });
    }
    if (action === "deleteMedia") {
      return res.status(200).json({ ok: true, deletedId: await deleteMedia(body) });
    }
    if (action === "listMonthlySales") {
      return res.status(200).json({ ok: true, months: await listMonthlySales(body) });
    }
    if (action === "rebuildMonthlySales") {
      return res.status(200).json({ ok: true, months: await rebuildMonthlySales() });
    }
    if (action === "listAppointments") {
      return res.status(200).json({ ok: true, appointments: await listAppointments() });
    }
    if (action === "addAppointment") {
      return res.status(200).json({ ok: true, appointment: await addAppointment(body) });
    }
    if (action === "updateAppointment") {
      return res.status(200).json({ ok: true, appointment: await updateAppointment(body) });
    }
    if (action === "deleteAppointment") {
      return res.status(200).json({ ok: true, deletedId: await deleteAppointment(body) });
    }
    if (action === "listExpenses") {
      return res.status(200).json({ ok: true, expenses: await listExpenses() });
    }
    if (action === "addExpense") {
      return res.status(200).json({ ok: true, expense: await addExpense(body) });
    }
    if (action === "updateExpense") {
      return res.status(200).json({ ok: true, expense: await updateExpense(body) });
    }
    if (action === "deleteExpense") {
      return res.status(200).json({ ok: true, deletedId: await deleteExpense(body) });
    }
    if (action === "listTicketNotes") {
      return res.status(200).json({ ok: true, notes: await listTicketNotes(body.ticketId) });
    }
    if (action === "listAllTicketNotes") {
      return res.status(200).json({ ok: true, notes: await listAllTicketNotes() });
    }
    if (action === "addTicketNote") {
      return res.status(200).json({ ok: true, notes: await addTicketNote(body) });
    }
    if (action === "deleteTicketNote") {
      return res.status(200).json({ ok: true, notes: await deleteTicketNote(body) });
    }
    if (action === "listReminders") {
      return res.status(200).json({ ok: true, reminders: await listReminders() });
    }
    if (action === "addReminder") {
      return res.status(200).json({ ok: true, reminder: await addReminder(body) });
    }
    if (action === "updateReminder") {
      return res.status(200).json({ ok: true, reminder: await updateReminder(body) });
    }
    if (action === "deleteReminder") {
      return res.status(200).json({ ok: true, deletedId: await deleteReminder(body) });
    }
    if (action === "listCardPayments") {
      return res.status(200).json({ ok: true, payments: await listCardPayments(body) });
    }
    if (action === "listCollectable") {
      return res.status(200).json({ ok: true, payments: await listCollectable() });
    }
    if (action === "accountSummary") {
      return res.status(200).json({ ok: true, summary: await accountSummary() });
    }
    if (action === "addCardPayment") {
      return res.status(200).json({ ok: true, payment: await addCardPayment(body) });
    }
    if (action === "updateCardPayment") {
      return res.status(200).json({ ok: true, payment: await updateCardPayment(body) });
    }
    if (action === "voidCardPayment") {
      return res.status(200).json({ ok: true, payment: await voidCardPayment(body) });
    }
    if (action === "listPayouts") {
      return res.status(200).json({ ok: true, payouts: await listPayouts() });
    }
    if (action === "addPayout") {
      return res.status(200).json({ ok: true, payout: await addPayout(body) });
    }
    if (action === "voidPayout") {
      return res.status(200).json({ ok: true, payout: await voidPayout(body) });
    }
    if (action === "getAccountSettings") {
      return res.status(200).json({ ok: true, settings: await getAccountSettings() });
    }
    if (action === "saveAccountSettings") {
      const settings = await saveAccountSettings(body.settings || body);
      // The takings reminder quotes the holder's name and is only otherwise
      // rewritten when the ledger moves, so refresh it here or a rename sits
      // unapplied until the next payment.
      await syncTakingsReminder();
      return res.status(200).json({ ok: true, settings });
    }
    return res.status(200).json({ ok: false, error: "Unknown action: " + action });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
}

// assets/intake.js posts with Content-Type: text/plain (to dodge a CORS
// preflight), so Vercel's automatic body parser hands us a raw string here
// instead of a parsed object — parse it ourselves, same as Code.gs's doPost
// already had to.
function readBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}
