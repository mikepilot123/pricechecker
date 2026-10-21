/* Pure helpers for putting a check-in on the client's existing invoice
   instead of starting a new one (lib/invoices.js checkinInvoice):
     • an invoice made for the client before their repair was logged, and
     • the invoice already covering the client's other active repairs,
   so a client with several devices in the shop has one invoice. */

// Repairs in these statuses are finished — their invoice is closed off and a
// new device starts a fresh one. Keep in sync with assets/intake.js
// FINAL_TICKET_STATUSES.
export const FINAL_TICKET_STATUSES = ["Picked Up", "No Fix", "Cancelled"];

// An invoice made before the client was logged is only picked up for this
// long, so an old accessory sale never swallows a new repair.
export const UNLINKED_INVOICE_DAYS = 30;

export function phoneKey(phone) {
  return String(phone || "").replace(/\D/g, "").slice(-7);
}

/** Same client: by phone number when both have one, otherwise by name.
 *  Mirrors assets/intake.js isSameClient(). */
export function sameClient(a, b) {
  const pa = phoneKey(a?.phone);
  const pb = phoneKey(b?.phone);
  if (pa.length === 7 && pb.length === 7) return pa === pb;
  const na = String(a?.name || "").trim().toLowerCase();
  return !!na && na === String(b?.name || "").trim().toLowerCase();
}

function tokens(value) {
  return String(value || "").toLowerCase().match(/[a-z0-9]+/g) || [];
}

export function deviceKey(value) {
  return tokens(value).join(" ");
}

// Words that make a longer, different model ("iPhone 13" vs "iPhone 13 Pro").
const MODEL_QUALIFIERS = new Set(["pro", "max", "plus", "mini", "ultra", "lite", "se", "fe", "xl", "xr", "xs", "note", "edge", "fold", "flip"]);
// Fees and accessories can start with the model too; they aren't the repair.
const NON_REPAIR_LINE = /\b(fee|fees|courier|delivery|shipping|transport|call[\s-]?out|travel|labou?r|deposit|tax|vat|discount|protector|tempered\s+glass|case|charger|adapter|cable|power\s*bank|earphones?|headphones?)\b/i;

/** The invoice already bills this device: a repair line reads
 *  "<device> <repair>", the way check-in and the Invoices tab write them. */
export function itemsMentionDevice(items, device) {
  const dev = tokens(device);
  if (!dev.length) return false;
  return (items || []).some((item) => {
    if (NON_REPAIR_LINE.test(String(item?.description || ""))) return false;
    const desc = tokens(item?.description);
    if (desc.length < dev.length || !dev.every((part, i) => desc[i] === part)) return false;
    return !MODEL_QUALIFIERS.has(desc[dev.length]);
  });
}

function createdMs(invoice) {
  return new Date(invoice?.createdAt || invoice?.invoiceDate || 0).getTime() || 0;
}

/**
 * Which of the client's invoices a check-in should join, or null for a new one.
 *   invoices:        the client's candidate invoices (any order)
 *   activeTicketIds: the client's open repairs, not counting this check-in
 *   devices:         [{ device }] being logged now
 * Order of preference:
 *   1. an unlinked invoice (made before the repair was logged) that already
 *      bills one of these devices — it *is* this repair's invoice;
 *   2. the invoice covering the client's other active repairs;
 *   3. any recent unlinked invoice for the client.
 */
export function pickCheckinInvoice({ invoices, activeTicketIds, devices, now = Date.now() }) {
  const active = new Set((activeTicketIds || []).filter(Boolean));
  const newestFirst = [...(invoices || [])].sort((a, b) => createdMs(b) - createdMs(a));
  const cutoff = now - UNLINKED_INVOICE_DAYS * 86400000;
  const unlinked = newestFirst.filter((inv) => !(inv.ticketIds || []).length && createdMs(inv) >= cutoff);
  const billsDevice = unlinked.find((inv) => (devices || []).some((d) => itemsMentionDevice(inv.items, d.device)));
  if (billsDevice) return { invoice: billsDevice, reason: "unlinked" };
  const shared = newestFirst.find((inv) => (inv.ticketIds || []).some((id) => active.has(id)));
  if (shared) return { invoice: shared, reason: "active" };
  if (unlinked.length) return { invoice: unlinked[0], reason: "unlinked" };
  return null;
}

/**
 * The invoice once this check-in's devices are on it.
 *   linkedDevices: devices of the repairs already linked to the invoice
 *   devices:       [{ ticketId, device, items }] being logged now
 * A device the invoice already bills (and no linked repair has claimed) keeps
 * its existing lines; any other device's lines are added at the end.
 */
export function mergeCheckinItems({ invoice, linkedDevices, devices }) {
  const claimed = new Map();
  for (const device of linkedDevices || []) {
    const key = deviceKey(device);
    claimed.set(key, (claimed.get(key) || 0) + 1);
  }
  const items = [...(invoice.items || [])];
  const added = [];
  const alreadyBilled = [];
  for (const d of devices || []) {
    const key = deviceKey(d.device);
    if (!claimed.get(key) && itemsMentionDevice(invoice.items, d.device)) {
      alreadyBilled.push(d.device);
    } else {
      items.push(...(d.items || []));
      added.push(d.device);
    }
    claimed.set(key, (claimed.get(key) || 0) + 1);
  }
  const ticketIds = [...new Set([...(invoice.ticketIds || []), ...(devices || []).map((d) => d.ticketId)].filter(Boolean))];
  return { items, ticketIds, added, alreadyBilled };
}

/** Payment Made after joining: what the invoice already shows, or what its
 *  repairs (old and new) have been paid, whichever is more — a deposit
 *  taken on the invoice and typed again at check-in isn't counted twice. */
export function mergedPaymentMade({ invoicePaid, linkedPaid, newPaid }) {
  const n = (v) => Number(v) || 0;
  return Math.round(Math.max(n(invoicePaid), n(linkedPaid) + n(newPaid)) * 100) / 100;
}
