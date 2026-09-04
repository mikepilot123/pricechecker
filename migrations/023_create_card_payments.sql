-- Card takings ledger.
--
-- Payments for JQ Electronics (and Hidden Jewels) run through a card machine
-- registered to the owner's brother, so the money lands in HIS account the
-- next business day and has to be collected back. Each swipe is one row here.
--
-- The row's *state* is never stored, only derived (see lib/card-payments.js):
--   voided_at    -> void       (refund or mis-key; the row stays for history)
--   payout_id    -> collected  (cleared by a transfer, see payouts)
--   settles_at   -> settled    (in his account, i.e. owed to the shop)
--   otherwise    -> pending
-- Deriving it means the next-business-day flip needs no cron job, and the
-- owed balance is always exactly (sum of settled net) - (sum of collected net).
CREATE TABLE IF NOT EXISTS card_payments (
  id           TEXT PRIMARY KEY,          -- "CP..." base36, client-supplied so a retry can't double-log
  business     TEXT NOT NULL DEFAULT 'jq',-- 'jq' | 'hj' — the same machine takes both
  card_type    TEXT NOT NULL DEFAULT 'debit', -- 'debit' | 'credit' — decides the fee
  taken_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  gross        NUMERIC(12, 2) NOT NULL DEFAULT 0,  -- what the customer paid
  -- Machine fee, computed on save from the rates in app_settings (flat for
  -- debit, a percentage for credit) and then STORED, so changing the rates
  -- later never silently rewrites what past payouts were worth.
  fee          NUMERIC(12, 2) NOT NULL DEFAULT 0,
  settles_at   TIMESTAMPTZ NOT NULL,      -- next business day after taken_at, Port of Spain
  payout_id    TEXT,                      -- NULL = still owed
  ticket_id    TEXT,                      -- set when the payment came from a repair ticket
  customer     TEXT NOT NULL DEFAULT '',
  receipt_ref  TEXT NOT NULL DEFAULT '',  -- machine receipt no. — what reconciles against his bank statement
  last4        TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  voided_at    TIMESTAMPTZ,
  void_reason  TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

-- The two queries that matter: "what is still owed" (payout_id IS NULL) and
-- the ledger list ordered by when it was taken.
CREATE INDEX IF NOT EXISTS idx_card_payments_owed
  ON card_payments (deleted_at, voided_at, payout_id, settles_at);
CREATE INDEX IF NOT EXISTS idx_card_payments_taken
  ON card_payments (deleted_at, taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_card_payments_ticket
  ON card_payments (ticket_id);
