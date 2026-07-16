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
} from "../_lib/tickets.js";
import { listMedia, addMedia, deleteMedia } from "../_lib/media.js";
import { listAppointments, addAppointment, updateAppointment, deleteAppointment } from "../_lib/appointments.js";
import { listExpenses, addExpense, updateExpense, deleteExpense } from "../_lib/expenses.js";
import { ensureSchema } from "../_lib/db.js";
import { checkPin, jsonResponse, preflightResponse } from "../_lib/security.js";

// Cloudflare Pages Functions build of api/intake.js. Same dispatch-by-action
// shape as the Vercel original and apps-script/Code.gs before it: same
// { action, pin, ...fields } request shape, same { ok, ... } response
// shape — so assets/intake.js, assets/appointments.js, and
// assets/dashboard.js only need their SCRIPT_URL/INTAKE_URL constant
// updated, no other changes.
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return preflightResponse(request);

  const body = request.method === "GET" ? Object.fromEntries(new URL(request.url).searchParams) : await readBody(request);

  const denied = checkPin(request, body.pin, env);
  if (denied) {
    return jsonResponse({ ok: false, error: denied.error }, request, denied.status);
  }

  const action = body.action || "list";
  try {
    await ensureSchema();
    if (action === "list") {
      return jsonResponse({ ok: true, tickets: await listTickets({ includeDeleted: !!body.includeDeleted }) }, request);
    }
    if (action === "add") {
      return jsonResponse({ ok: true, ticket: await addTicket(body) }, request);
    }
    if (action === "update") {
      return jsonResponse({ ok: true, ticket: await updateTicket(body) }, request);
    }
    if (action === "delete") {
      return jsonResponse({ ok: true, deletedId: await deleteTicket(body) }, request);
    }
    if (action === "clear") {
      const { deletedCount, backup } = await clearAll();
      return jsonResponse({ ok: true, deletedCount, backup }, request);
    }
    if (action === "listBackups") {
      return jsonResponse({ ok: true, backups: await listBackups() }, request);
    }
    if (action === "restoreBackup") {
      const { restoredCount, backup, tickets } = await restoreBackup(body);
      return jsonResponse({ ok: true, restoredCount, backup, tickets }, request);
    }
    if (action === "listTechnicians") {
      return jsonResponse({ ok: true, technicians: await listTechnicians() }, request);
    }
    if (action === "addTechnician") {
      return jsonResponse({ ok: true, technicians: await addTechnician(body) }, request);
    }
    if (action === "deleteTechnician") {
      return jsonResponse({ ok: true, technicians: await deleteTechnician(body) }, request);
    }
    if (action === "listMedia") {
      return jsonResponse({ ok: true, media: await listMedia(body.ticketId) }, request);
    }
    if (action === "addMedia") {
      return jsonResponse({ ok: true, media: await addMedia(body) }, request);
    }
    if (action === "deleteMedia") {
      return jsonResponse({ ok: true, deletedId: await deleteMedia(body) }, request);
    }
    if (action === "listMonthlySales") {
      return jsonResponse({ ok: true, months: await listMonthlySales(body) }, request);
    }
    if (action === "rebuildMonthlySales") {
      return jsonResponse({ ok: true, months: await rebuildMonthlySales() }, request);
    }
    if (action === "listAppointments") {
      return jsonResponse({ ok: true, appointments: await listAppointments() }, request);
    }
    if (action === "addAppointment") {
      return jsonResponse({ ok: true, appointment: await addAppointment(body) }, request);
    }
    if (action === "updateAppointment") {
      return jsonResponse({ ok: true, appointment: await updateAppointment(body) }, request);
    }
    if (action === "deleteAppointment") {
      return jsonResponse({ ok: true, deletedId: await deleteAppointment(body) }, request);
    }
    if (action === "listExpenses") {
      return jsonResponse({ ok: true, expenses: await listExpenses() }, request);
    }
    if (action === "addExpense") {
      return jsonResponse({ ok: true, expense: await addExpense(body) }, request);
    }
    if (action === "updateExpense") {
      return jsonResponse({ ok: true, expense: await updateExpense(body) }, request);
    }
    if (action === "deleteExpense") {
      return jsonResponse({ ok: true, deletedId: await deleteExpense(body) }, request);
    }
    return jsonResponse({ ok: false, error: "Unknown action: " + action }, request);
  } catch (err) {
    return jsonResponse({ ok: false, error: String((err && err.message) || err) }, request);
  }
}

// assets/intake.js posts with Content-Type: text/plain (to dodge a CORS
// preflight), so read the body as text and parse it ourselves — same as
// the Vercel version had to do, and same as Code.gs's doPost before that.
async function readBody(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
