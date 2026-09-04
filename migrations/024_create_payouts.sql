-- One transfer from the card-machine holder back to the shop, clearing a
-- batch of settled card payments.
--
-- A payout is an IMMUTABLE RECEIPT: its amount is computed server-side from
-- the payments it clears and is never edited afterwards. Getting one wrong is
-- fixed by voiding it (which releases its payments back to "settled") and
-- recording a fresh one. That is what keeps
--   owed = sum(settled net) - sum(collected net)
-- true at all times instead of drifting as amounts get hand-corrected.
--
-- No business column: he sends one transfer covering whatever the machine
-- took, so the jq/hj split lives on the payment, not here.
CREATE TABLE IF NOT EXISTS payouts (
  id           TEXT PRIMARY KEY,          -- "PO..." base36
  paid_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  amount       NUMERIC(12, 2) NOT NULL DEFAULT 0,  -- = sum of (gross - fee) over its payments
  method       TEXT NOT NULL DEFAULT '',  -- bank transfer / cash / Linx
  reference    TEXT NOT NULL DEFAULT '',  -- bank reference, for statement matching
  notes        TEXT NOT NULL DEFAULT '',
  voided_at    TIMESTAMPTZ,
  void_reason  TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payouts_paid_at ON payouts (deleted_at, paid_at DESC);
