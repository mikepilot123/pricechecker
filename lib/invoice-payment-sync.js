/* Pure helpers for keeping invoice payments aligned with linked repairs. */

export function paymentNumber(value) {
  if (value == null || String(value).trim() === "") return 0;
  const amount = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

export function sumTicketAmountPaid(tickets) {
  return Math.round((tickets || []).reduce(
    (sum, ticket) => sum + paymentNumber(ticket && (ticket.amountPaid ?? ticket.amount_paid)),
    0
  ) * 100) / 100;
}

/**
 * Older repair-card clients update invoices with exactly { items, paymentMade }.
 * Recognize that shape so the server can replace any stale/double-counted
 * paymentMade value with the authoritative linked-ticket total. Normal invoice
 * editor saves include additional fields; quick invoice payments omit items.
 */
export function isRepairSyncPaymentUpdate(changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return false;
  const keys = Object.keys(changes);
  return keys.includes("items")
    && keys.includes("paymentMade")
    && keys.every((key) => key === "items" || key === "paymentMade");
}
