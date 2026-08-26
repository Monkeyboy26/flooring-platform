-- POs are often picked up by Roma at the distributor rather than shipped in.
-- fulfillment_method: 'ship' (default, ship to Roma) | 'pickup' (Roma picks up at distributor).
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS fulfillment_method VARCHAR(20) DEFAULT 'ship';
