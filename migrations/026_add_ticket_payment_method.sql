-- How a repair was paid for. Until now tickets recorded amount_paid but not
-- the method, so there was no way to tell which repairs went through the card
-- machine and therefore which money is sitting in someone else's account.
--
-- card_payment_id links the ticket to its row in the card takings ledger, so
-- editing "Amount paid" on the ticket keeps the ledger in step instead of
-- leaving two numbers to disagree. See lib/tickets.js.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT '';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS card_payment_id TEXT;
-- Denormalised from the linked card payment so listing tickets does not need
-- one extra query per row just to know debit vs credit.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS payment_card_type TEXT NOT NULL DEFAULT '';
