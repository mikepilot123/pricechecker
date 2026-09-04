import { sql } from "./db.js";
import { getAccountSettings } from "./settings.js";

// Card takings ledger — see migrations/023_create_card_payments.sql.
//
// The shop's card machine is registered to the owner's brother, so every swipe
// is money that lands in HIS account the next business day and has to be
// collected back. This module owns three things the rest of the app relies on:
//
//   1. the fee rules (flat per debit transaction, a percentage on credit),
//   2. next-business-day settlement, and
//   3. the derived state that makes the owed balance self-maintaining.
//
// Nothing here stores a state column. "Settled" is just settles_at having
// passed, which means the balance is correct the moment you look at it and
// there is no scheduled job to go wrong overnight.

// Trinidad & Tobago is fixed at UTC-4 with no DST, but the conversion is done
// by Postgres rather than assumed here — same approach as lib/appointments.js.
const SHOP_TIME_ZONE = "America/Port_of_Spain";

const BUSINESSES = ["jq", "hj"];
const CARD_TYPES = ["debit", "credit"];

function text(value) {
  return String(value == null ? "" : value).trim();
}

function boolFrom(value, fallback = false) {
  if (value == null) return fallback;
  return value === true || value === "true" || value === 1 || value === "1";
}

function money(value, field) {
  const n = Number(value);
  if (!isFinite(n) || n < 0) throw new Error(`${field} must be a non-negative number`);
  return Math.round(n * 100) / 100;
}

function timestampFrom(value, field) {
  if (value == null || value === "") return new Date().toISOString();
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) throw new Error(`${field} is invalid`);
  return d.toISOString();
}

function businessFrom(value, fallback = "jq") {
  const v = text(value).toLowerCase();
  return BUSINESSES.includes(v) ? v : fallback;
}

function cardTypeFrom(value, fallback = "debit") {
  const v = text(value).toLowerCase();
  return CARD_TYPES.includes(v) ? v : fallback;
}

/**
 * What the machine keeps. Debit is a flat charge per transaction; credit is a
 * percentage of the amount. Both rates live in app_settings so they can change
 * without a deploy — but the result is written onto the payment row, so a
 * later rate change never rewrites what past payouts were worth.
 */
export function computeFee(cardType, gross, settings) {
  const type = cardTypeFrom(cardType);
  const raw = type === "credit" ? (Number(gross) || 0) * (settings.creditFeePct / 100) : settings.debitFee;
  return Math.round(raw * 100) / 100;
}

/**
 * When the money reaches his account: the next business day after the swipe,
 * at the shop-local hour funds are treated as landed.
 *
 * ISODOW is Mon=1 … Sun=7, so Friday, Saturday and Sunday all roll forward to
 * Monday and every other day advances by one. Public holidays aren't modelled
 * — they'd make a payment look collectable a day early, which shows up as a
 * balance that can't be paid yet rather than as money going missing.
 */
async function computeSettlesAt(takenAtIso, settlementHour) {
  const rows = await sql`
    SELECT ((next_day + make_interval(hours => ${settlementHour}::int)) AT TIME ZONE ${SHOP_TIME_ZONE}) AS settles_at
    FROM (
      SELECT taken_day + CASE EXTRACT(ISODOW FROM taken_day)::int
                           WHEN 5 THEN 3   -- Friday    -> Monday
                           WHEN 6 THEN 2   -- Saturday  -> Monday
                           WHEN 7 THEN 1   -- Sunday    -> Monday
                           ELSE 1
                         END AS next_day
      FROM (SELECT (${takenAtIso}::timestamptz AT TIME ZONE ${SHOP_TIME_ZONE})::date AS taken_day) d
    ) n
  `;
  return rows[0].settles_at;
}

/** void | collected | settled | pending — order matters, they're checked most-final first. */
export function stateOf(row, nowMs = Date.now()) {
  if (row.voided_at) return "void";
  if (row.payout_id) return "collected";
  return new Date(row.settles_at).getTime() <= nowMs ? "settled" : "pending";
}

function rowToPayment(row, nowMs = Date.now()) {
  const gross = row.gross == null ? 0 : Number(row.gross);
  const fee = row.fee == null ? 0 : Number(row.fee);
  return {
    id: row.id,
    business: row.business || "jq",
    cardType: row.card_type || "debit",
    takenAt: row.taken_at ? new Date(row.taken_at).toISOString() : null,
    gross,
    fee,
    // What he actually owes: the machine's cut never reaches his account.
    net: Math.round((gross - fee) * 100) / 100,
    settlesAt: row.settles_at ? new Date(row.settles_at).toISOString() : null,
    state: stateOf(row, nowMs),
    payoutId: row.payout_id || "",
    ticketId: row.ticket_id || "",
    customer: row.customer || "",
    receiptRef: row.receipt_ref || "",
    last4: row.last4 || "",
    notes: row.notes || "",
    voidedAt: row.voided_at ? new Date(row.voided_at).toISOString() : null,
    voidReason: row.void_reason || "",
    created: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function getPayment(id) {
  const rows = await sql`SELECT * FROM card_payments WHERE id = ${id}`;
  if (!rows.length) throw new Error("Card payment not found: " + id);
  return rowToPayment(rows[0]);
}

// ---- Reads -----------------------------------------------------------------

/**
 * @param p.state    one of void|collected|settled|pending, or omitted for all
 * @param p.business jq|hj
 * @param p.month    "YYYY-MM", filtered on when the payment was taken
 * @param p.includeVoided voided rows are noise in the day-to-day list, so
 *                        they're excluded unless asked for
 */
export async function listCardPayments(p = {}) {
  const business = text(p.business).toLowerCase();
  const month = text(p.month);
  if (month && !/^\d{4}-\d{2}$/.test(month)) throw new Error("Month must be YYYY-MM");
  const state = text(p.state).toLowerCase();
  const includeVoided = boolFrom(p.includeVoided) || state === "void";
  const rows = await sql`
    SELECT * FROM card_payments
    WHERE deleted_at IS NULL
      AND (${includeVoided} OR voided_at IS NULL)
      AND (${business === ""} OR business = ${business})
      AND (${month === ""} OR to_char(taken_at AT TIME ZONE ${SHOP_TIME_ZONE}, 'YYYY-MM') = ${month})
    ORDER BY taken_at DESC, created_at DESC
  `;
  const payments = rows.map((row) => rowToPayment(row));
  return state ? payments.filter((payment) => payment.state === state) : payments;
}

/** Every payment that could go into a payout right now, oldest first. */
export async function listCollectable() {
  const rows = await sql`
    SELECT * FROM card_payments
    WHERE deleted_at IS NULL AND voided_at IS NULL AND payout_id IS NULL AND settles_at <= now()
    ORDER BY settles_at ASC, taken_at ASC
  `;
  return rows.map((row) => rowToPayment(row));
}

/**
 * The Account overview in one query. Everything is computed from the same
 * predicate the ledger uses, so the tiles can never disagree with the list.
 */
export async function accountSummary() {
  const [totals] = await sql`
    SELECT
      COALESCE(SUM(gross - fee) FILTER (WHERE payout_id IS NULL AND settles_at <= now()), 0) AS owed,
      COALESCE(SUM(gross - fee) FILTER (WHERE payout_id IS NULL AND settles_at > now()), 0) AS pending,
      COUNT(*) FILTER (WHERE payout_id IS NULL AND settles_at <= now()) AS owed_count,
      COUNT(*) FILTER (WHERE payout_id IS NULL AND settles_at > now()) AS pending_count,
      COALESCE(SUM(gross - fee) FILTER (WHERE payout_id IS NULL AND settles_at <= now() AND business = 'jq'), 0) AS owed_jq,
      COALESCE(SUM(gross - fee) FILTER (WHERE payout_id IS NULL AND settles_at <= now() AND business = 'hj'), 0) AS owed_hj,
      COALESCE(SUM(gross - fee) FILTER (
        WHERE payout_id IS NOT NULL
          AND to_char(taken_at AT TIME ZONE ${SHOP_TIME_ZONE}, 'YYYY-MM')
              = to_char(now() AT TIME ZONE ${SHOP_TIME_ZONE}, 'YYYY-MM')), 0) AS collected_this_month,
      COALESCE(SUM(fee) FILTER (
        WHERE to_char(taken_at AT TIME ZONE ${SHOP_TIME_ZONE}, 'YYYY-MM')
            = to_char(now() AT TIME ZONE ${SHOP_TIME_ZONE}, 'YYYY-MM')), 0) AS fees_this_month,
      MIN(settles_at) FILTER (WHERE payout_id IS NULL AND settles_at <= now()) AS oldest_uncollected_at
    FROM card_payments
    WHERE deleted_at IS NULL AND voided_at IS NULL
  `;
  // The other half of "who owes what": cash fronted from Hidden Jewels for
  // parts and marketing that JQ still has to pay back. Different mechanism
  // (see lib/expenses.js) but the same question, so it belongs on the same
  // screen rather than making staff check two places.
  const [reclaim] = await sql`
    SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
    FROM expenses
    WHERE deleted_at IS NULL AND cash_reclaim = TRUE AND reclaimed_at IS NULL
  `;
  const settings = await getAccountSettings();
  const oldest = totals.oldest_uncollected_at ? new Date(totals.oldest_uncollected_at) : null;
  const heldDays = oldest ? Math.floor((Date.now() - oldest.getTime()) / 86400000) : 0;
  return {
    owed: Number(totals.owed),
    owedCount: Number(totals.owed_count),
    pending: Number(totals.pending),
    pendingCount: Number(totals.pending_count),
    owedByBusiness: { jq: Number(totals.owed_jq), hj: Number(totals.owed_hj) },
    collectedThisMonth: Number(totals.collected_this_month),
    feesThisMonth: Number(totals.fees_this_month),
    oldestUncollectedAt: oldest ? oldest.toISOString() : null,
    oldestUncollectedDays: heldDays,
    // Surfaced rather than computed client-side so the alert threshold lives
    // in exactly one place.
    overdue: !!oldest && heldDays >= settings.holdAlertDays,
    expenseReclaim: { total: Number(reclaim.total), count: Number(reclaim.count) },
    settings,
  };
}

// ---- Writes ----------------------------------------------------------------

export async function addCardPayment(p) {
  // Client-supplied ids let a device retry a save on a flaky connection
  // without double-logging, same convention as expenses and reminders.
  const id = text(p.id) || "CP" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
  const settings = await getAccountSettings();
  const cardType = cardTypeFrom(p.cardType);
  const gross = money(p.gross, "Amount");
  // An explicit fee wins — the machine occasionally charges something odd and
  // the ledger has to be able to say what actually happened.
  const fee = p.fee == null || p.fee === "" ? computeFee(cardType, gross, settings) : money(p.fee, "Fee");
  if (fee > gross) throw new Error("Fee cannot be more than the amount taken");
  const takenAt = timestampFrom(p.takenAt, "Date taken");
  const settlesAt = await computeSettlesAt(takenAt, settings.settlementHour);
  await sql`
    INSERT INTO card_payments (
      id, business, card_type, taken_at, gross, fee, settles_at,
      ticket_id, customer, receipt_ref, last4, notes
    )
    VALUES (
      ${id}, ${businessFrom(p.business)}, ${cardType}, ${takenAt}, ${gross}, ${fee}, ${settlesAt},
      ${text(p.ticketId) || null}, ${text(p.customer)}, ${text(p.receiptRef)}, ${text(p.last4)}, ${text(p.notes)}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  const payment = await getPayment(id);
  await syncTakingsReminder();
  return payment;
}

export async function updateCardPayment(p) {
  const id = text(p.id);
  if (!id) throw new Error("Card payment ID is required");
  const rows = await sql`SELECT * FROM card_payments WHERE id = ${id} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Card payment not found: " + id);
  const current = rows[0];
  // A collected payment is part of a payout's arithmetic. Letting its amount
  // change would leave that payout's stored total wrong with nothing to point
  // at, so the payout has to be voided first — same reason payouts themselves
  // are never edited.
  if (current.payout_id) throw new Error("This payment is part of a payout. Void the payout first to change it.");
  if (current.voided_at) throw new Error("This payment is voided. Record a new one instead.");

  const settings = await getAccountSettings();
  const cardType = p.cardType != null ? cardTypeFrom(p.cardType, current.card_type) : current.card_type;
  const gross = p.gross != null ? money(p.gross, "Amount") : Number(current.gross);
  let fee;
  if (p.fee != null && p.fee !== "") {
    fee = money(p.fee, "Fee");
  } else if (p.cardType != null || p.gross != null) {
    // Changing the card type or the amount changes what the machine charged,
    // so recompute rather than carrying a stale figure forward.
    fee = computeFee(cardType, gross, settings);
  } else {
    fee = Number(current.fee);
  }
  if (fee > gross) throw new Error("Fee cannot be more than the amount taken");
  const takenAt = p.takenAt != null ? timestampFrom(p.takenAt, "Date taken") : new Date(current.taken_at).toISOString();
  const settlesAt = p.takenAt != null
    ? await computeSettlesAt(takenAt, settings.settlementHour)
    : current.settles_at;

  await sql`
    UPDATE card_payments
    SET business = ${p.business != null ? businessFrom(p.business, current.business) : current.business},
        card_type = ${cardType},
        taken_at = ${takenAt},
        gross = ${gross},
        fee = ${fee},
        settles_at = ${settlesAt},
        ticket_id = ${p.ticketId !== undefined ? (text(p.ticketId) || null) : current.ticket_id},
        customer = ${p.customer != null ? text(p.customer) : current.customer},
        receipt_ref = ${p.receiptRef != null ? text(p.receiptRef) : current.receipt_ref},
        last4 = ${p.last4 != null ? text(p.last4) : current.last4},
        notes = ${p.notes != null ? text(p.notes) : current.notes},
        updated_at = now()
    WHERE id = ${id}
  `;
  const payment = await getPayment(id);
  await syncTakingsReminder();
  return payment;
}

/**
 * Refunds and mis-keys. The row stays in the ledger with its reason so the
 * history has no holes; it just stops counting toward anything.
 */
export async function voidCardPayment(p) {
  const id = text(p.id);
  if (!id) throw new Error("Card payment ID is required");
  const reason = text(p.reason);
  if (!reason) throw new Error("Say why this payment is being voided");
  const rows = await sql`SELECT * FROM card_payments WHERE id = ${id} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Card payment not found: " + id);
  if (rows[0].payout_id) throw new Error("This payment is part of a payout. Void the payout first.");
  await sql`
    UPDATE card_payments
    SET voided_at = COALESCE(voided_at, now()), void_reason = ${reason}, updated_at = now()
    WHERE id = ${id}
  `;
  const payment = await getPayment(id);
  await syncTakingsReminder();
  return payment;
}

// ---- Reminder --------------------------------------------------------------

// One rolling reminder for the whole owed balance, rewritten on every change —
// the same mirror-into-reminders pattern as expenses' cash reclaim
// (lib/expenses.js syncReclaimReminder) and appointments. One entry rather
// than one per payment, because he settles in batches and a reminder per swipe
// would bury the Reminders tab.
export const TAKINGS_REMINDER_ID = "CARDPAY:balance";

function moneyLabel(amount) {
  return "$" + Number(amount || 0).toFixed(2);
}

export async function syncTakingsReminder() {
  const [totals] = await sql`
    SELECT
      COALESCE(SUM(gross - fee) FILTER (WHERE payout_id IS NULL AND settles_at <= now()), 0) AS owed,
      COUNT(*) FILTER (WHERE payout_id IS NULL AND settles_at <= now()) AS owed_count,
      MIN(settles_at) FILTER (WHERE payout_id IS NULL AND settles_at <= now()) AS oldest
    FROM card_payments
    WHERE deleted_at IS NULL AND voided_at IS NULL
  `;
  const owed = Number(totals.owed);
  const count = Number(totals.owed_count);
  if (owed <= 0 || count === 0) {
    // Nothing outstanding: retire the reminder rather than leave a "collect
    // $0.00" nagging in the tab.
    await sql`
      UPDATE reminders
      SET deleted_at = COALESCE(deleted_at, now()), updated_at = now()
      WHERE id = ${TAKINGS_REMINDER_ID} AND deleted_at IS NULL
    `;
    return;
  }
  const settings = await getAccountSettings();
  const who = settings.holderName ? " from " + settings.holderName : "";
  const title = `Collect ${moneyLabel(owed)} card takings${who}`;
  const notes = `${count} settled card payment${count === 1 ? "" : "s"} not yet transferred across.`;
  // due_at is the moment the oldest one became collectable, so the existing
  // overdue styling in the Reminders tab ages it correctly with no extra work.
  //
  // NOTE: `done` is always written as FALSE. This reminder is derived from the
  // balance, so ticking it by hand can't be how the money gets marked
  // collected — the next ledger change would just reopen it. The Account tab
  // gives its card a "Record payout" button instead (see assets/account.js).
  await sql`
    INSERT INTO reminders (id, title, notes, due_at, done, priority, kind, amount)
    VALUES (${TAKINGS_REMINDER_ID}, ${title}, ${notes}, ${totals.oldest}, FALSE, '', 'card_takings', ${owed})
    ON CONFLICT (id) DO UPDATE
    SET title = EXCLUDED.title,
        notes = EXCLUDED.notes,
        due_at = EXCLUDED.due_at,
        done = FALSE,
        done_at = NULL,
        kind = EXCLUDED.kind,
        amount = EXCLUDED.amount,
        deleted_at = NULL,
        updated_at = now()
  `;
}
