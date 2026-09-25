-- Check-in invoices get Zoho-style sequential numbers (INV-000090, …).
-- Starts at 90 to carry on from the shop's last Zoho invoice (INV-000089);
-- the number stays editable per invoice in the app.
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START WITH 90;
