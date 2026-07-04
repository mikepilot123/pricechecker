-- Durable month-over-month sales ledger. Kept separate from the tickets
-- table so a soft-delete or "Clear all" never erases a past month's
-- recognized revenue — lib/tickets.js adjusts totals additively (on ticket
-- creation and on repair-cost corrections), never by recomputing from the
-- live tickets table.
CREATE TABLE IF NOT EXISTS monthly_sales (
  month_key TEXT PRIMARY KEY,
  total_sales NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ticket_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One-time backfill from existing ticket history (including previously
-- soft-deleted/cleared tickets, since those still represent revenue that
-- happened) so shops upgrading to this ledger see their real history
-- immediately instead of starting empty.
INSERT INTO monthly_sales (month_key, total_sales, ticket_count, updated_at)
SELECT to_char(created_at, 'YYYY-MM') AS month_key,
       SUM(repair_cost)::numeric(12, 2) AS total_sales,
       COUNT(*)::int AS ticket_count,
       now()
FROM tickets
WHERE repair_cost IS NOT NULL
GROUP BY to_char(created_at, 'YYYY-MM')
ON CONFLICT (month_key) DO NOTHING;
