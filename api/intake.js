import {
  listTickets,
  getTicketById,
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
import { listExpenses, addExpense, updateExpense, deleteExpense, addExpenseCollection, undoExpenseCollection } from "../lib/expenses.js";
import { listReminders, addReminder, updateReminder, deleteReminder } from "../lib/reminders.js";
// Card payments/payouts (lib/card-payments.js, lib/payouts.js) and their
// settings (lib/settings.js) are retired — no more UI to log a swipe or
// record a transfer, so those actions are no longer dispatched here. Only
// accountSummary survives, for the Dashboard's residual "card takings owed"
// tile; the historical data and library code are otherwise untouched.
import { accountSummary } from "../lib/card-payments.js";
import { listBankTransactions, bankAccountSummary, addBankTransaction, updateBankTransaction, deleteBankTransaction, addCashDepositToBank, depositRepairPayment } from "../lib/bank-transactions.js";
import { listPartsOrders, addPartsOrder, updatePartsOrder, deletePartsOrder, renamePartsShipment, setPartsShipmentPaymentStatus } from "../lib/parts-orders.js";
import { extractPartsFromPdf } from "../lib/parts-order-extraction.js";
import { ensureSchema } from "../lib/db.js";
import { syncInvoicePaymentForTicket } from "../lib/invoices.js";
import { applyCors, checkPin, checkOwnerPin, createBrowserCredential, deviceIdForCredential } from "../lib/security.js";
import { ownerPinSource, verifyOwnerPin, saveOwnerPin } from "../lib/owner-pin.js";
import { registerDevice, effectiveHidden, listDevices, updateDevice, restrictOtherDevices } from "../lib/devices.js";

// Data behind a section the owner can hide per device (lib/devices.js). An
// action is refused only when EVERY section listed for it is hidden, since
// the Dashboard and Targets share the monthly sales history. What the
// sections show is computed from data the rest of the app also needs
// (tickets, invoices), so the app hides those parts too
// (assets/device-access.js); this keeps the figures that exist only for
// these sections off a restricted device.
const SECTION_GUARDED_ACTIONS = {
  listMonthlySales: ["dashboard", "targets"],
  accountSummary: ["dashboard"],
  listBankTransactions: ["accounting"],
  bankAccountSummary: ["accounting"],
  addBankTransaction: ["accounting"],
  updateBankTransaction: ["accounting"],
  deleteBankTransaction: ["accounting"],
  addCashDepositToBank: ["accounting"],
  listExpenses: ["accounting"],
  deleteExpense: ["accounting"],
  addExpenseCollection: ["accounting"],
  undoExpenseCollection: ["accounting"],
};

// Default is 10s, which isn't enough for extractPartsOrderPdf: Gemini answers
// "503 high demand" often enough that the retry chain in
// lib/parts-order-extraction.js needs room to actually wait and re-ask. Retry
// gaps are idle I/O, so this raises the ceiling without raising active CPU.
export const maxDuration = 60;

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
    if (action === "registerBrowser") {
      const credential = createBrowserCredential(body.pin);
      if (!credential) return res.status(200).json({ ok: false, error: "Invalid PIN" });
      // Recorded before the credential is handed out, hidden until the owner
      // allows it (lib/devices.js).
      await ensureSchema();
      await registerDevice(deviceIdForCredential(credential), { userAgent: req.headers["user-agent"] });
      return res.status(200).json({ ok: true, credential });
    }
    await ensureSchema();
    const deviceId = deviceIdForCredential(body.pin);
    const guardedSections = SECTION_GUARDED_ACTIONS[action];
    if (guardedSections) {
      const hidden = await effectiveHidden(deviceId, { managed: !!(await ownerPinSource()), userAgent: req.headers["user-agent"] });
      if (guardedSections.every((section) => hidden.includes(section))) {
        return res.status(403).json({ ok: false, error: "This device doesn't have access to that. Ask the owner to allow it in Settings → Devices." });
      }
    }
    if (action === "deviceAccess") {
      // ownerPin: where the owner PIN comes from — "" until the owner creates
      // one in Settings → Devices, which is what turns permissions on.
      const ownerPin = await ownerPinSource();
      const hidden = await effectiveHidden(deviceId, { managed: !!ownerPin, userAgent: req.headers["user-agent"] });
      return res.status(200).json({ ok: true, deviceId, managed: !!ownerPin, ownerPin, hidden });
    }
    if (action === "setOwnerPin") {
      // Creating the first owner PIN needs only the team PIN (checked above);
      // replacing it needs the current one.
      const replacing = !!(await ownerPinSource());
      if (replacing) {
        const ownerDenied = await checkOwnerPin(req, body.ownerPin, verifyOwnerPin);
        if (ownerDenied) return res.status(ownerDenied.status).json({ ok: false, error: ownerDenied.error });
      }
      await saveOwnerPin(body.newOwnerPin, { replacing });
      return res.status(200).json({ ok: true, ownerPin: await ownerPinSource() });
    }
    if (action === "listDevices" || action === "updateDevice" || action === "restrictOtherDevices") {
      const ownerDenied = await checkOwnerPin(req, body.ownerPin, verifyOwnerPin);
      if (ownerDenied) return res.status(ownerDenied.status).json({ ok: false, error: ownerDenied.error });
      if (action === "restrictOtherDevices") {
        const restricted = await restrictOtherDevices(deviceId);
        return res.status(200).json({ ok: true, restricted, deviceId, devices: await listDevices() });
      }
      if (action === "updateDevice") {
        const device = await updateDevice({ id: body.id, name: body.name, hidden: body.hidden });
        return res.status(200).json({ ok: true, device });
      }
      return res.status(200).json({ ok: true, deviceId, devices: await listDevices() });
    }
    if (action === "list") {
      return res.status(200).json({ ok: true, tickets: await listTickets({ includeDeleted: !!body.includeDeleted }) });
    }
    if (action === "add") {
      const ticket = await addTicket(body);
      const accountDeposit = body.depositToAccount
        ? await depositForRepair(ticket, body.paymentMethod, Number(ticket.amountPaid) || 0)
        : null;
      return res.status(200).json({ ok: true, ticket, accountDeposit });
    }
    if (action === "update") {
      const before = body.depositToAccount ? await getTicketById(body.id) : null;
      const ticket = await updateTicket(body);
      // Only what was newly collected goes to the account, never the total
      // paid so far — earlier payments were deposited when they were taken.
      const accountDeposit = before
        ? await depositForRepair(ticket, body.paymentMethod, (Number(ticket.amountPaid) || 0) - (Number(before.amountPaid) || 0))
        : null;
      let invoiceSync = null;
      // Amount Paid is a source-of-truth field for the linked invoice. Run
      // this on the server so an older/cached browser cannot leave the invoice
      // stale. Empty string is a real edit (clear payment), so check presence
      // rather than truthiness.
      if (body.amountPaid !== undefined || body.paid !== undefined) {
        try {
          invoiceSync = await syncInvoicePaymentForTicket(ticket.id);
        } catch (syncError) {
          // Never lose the repair edit because invoice reconciliation failed.
          // Return the warning so the current UI can surface it when supported.
          invoiceSync = { changed: false, error: String(syncError?.message || syncError) };
        }
      }
      return res.status(200).json({ ok: true, ticket, invoiceSync, accountDeposit });
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
    if (action === "addExpenseCollection") {
      return res.status(200).json({ ok: true, expense: await addExpenseCollection(body) });
    }
    if (action === "undoExpenseCollection") {
      return res.status(200).json({ ok: true, expense: await undoExpenseCollection(body) });
    }
    if (action === "deleteExpense") {
      return res.status(200).json({ ok: true, deletedId: await deleteExpense(body) });
    }
    if (action === "listPartsOrders") {
      return res.status(200).json({ ok: true, partsOrders: await listPartsOrders() });
    }
    if (action === "addPartsOrder") {
      return res.status(200).json({ ok: true, partsOrder: await addPartsOrder(body) });
    }
    if (action === "updatePartsOrder") {
      return res.status(200).json({ ok: true, partsOrder: await updatePartsOrder(body) });
    }
    if (action === "deletePartsOrder") {
      return res.status(200).json({ ok: true, deletedId: await deletePartsOrder(body) });
    }
    if (action === "renamePartsShipment") {
      return res.status(200).json({ ok: true, shipment: await renamePartsShipment(body) });
    }
    if (action === "setPartsShipmentPaymentStatus") {
      return res.status(200).json({ ok: true, shipment: await setPartsShipmentPaymentStatus(body) });
    }
    if (action === "extractPartsOrderPdf") {
      const pdfBase64 = String(body.pdfBase64 || "").trim();
      if (!pdfBase64) return res.status(200).json({ ok: false, error: "PDF data is required" });
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(pdfBase64)) {
        return res.status(200).json({ ok: false, error: "PDF data is invalid" });
      }
      if (Buffer.byteLength(pdfBase64, "base64") > 2.5 * 1024 * 1024) {
        return res.status(200).json({ ok: false, error: "That PDF is over 2.5MB — compress or split it." });
      }
      const extracted = await extractPartsFromPdf(pdfBase64);
      return res.status(200).json({ ok: true, ...extracted });
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
    if (action === "listBankTransactions") {
      return res.status(200).json({ ok: true, transactions: await listBankTransactions() });
    }
    if (action === "bankAccountSummary") {
      return res.status(200).json({ ok: true, summary: await bankAccountSummary() });
    }
    if (action === "addBankTransaction") {
      return res.status(200).json({ ok: true, transaction: await addBankTransaction(body) });
    }
    if (action === "updateBankTransaction") {
      return res.status(200).json({ ok: true, transaction: await updateBankTransaction(body) });
    }
    if (action === "deleteBankTransaction") {
      return res.status(200).json({ ok: true, deletedId: await deleteBankTransaction(body) });
    }
    if (action === "addCashDepositToBank") {
      const { withdrawal, deposit } = await addCashDepositToBank(body);
      return res.status(200).json({ ok: true, withdrawal, deposit });
    }
    if (action === "accountSummary") {
      return res.status(200).json({ ok: true, summary: await accountSummary() });
    }
    return res.status(200).json({ ok: false, error: "Unknown action: " + action });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String((err && err.message) || err), ...(err?.code ? { code: err.code } : {}) });
  }
}

// A repair payment staff confirmed as cash or bank transfer is deposited to
// the Account tab automatically. Never fails the repair save — the repair is
// the record that matters; a failed deposit comes back so the UI can say so.
async function depositForRepair(ticket, method, amount) {
  try {
    const deposit = await depositRepairPayment({
      method,
      amount,
      ticketId: ticket.id,
      customerName: ticket.customerName,
      issues: ticket.issues,
      device: ticket.device,
    });
    return deposit ? { ok: true, deposit } : null;
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
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
