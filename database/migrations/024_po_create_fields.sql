-- Add fields for rich PO create/edit experience
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS ship_to TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS expected_delivery DATE;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS recipient_email TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS cc_emails TEXT[] DEFAULT '{}';
