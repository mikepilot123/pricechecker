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
