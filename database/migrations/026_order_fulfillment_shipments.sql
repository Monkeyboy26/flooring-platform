-- 026_order_fulfillment_shipments.sql
-- Phase 1 of the fulfillment workflow: first-class shipment entities so a single
-- order can ship in multiple parts (split / partial shipments + backorder
-- visibility). orders.status gains a 'processing' state (picking/packing) between
-- 'confirmed' and 'shipped'; orders.fulfillment_status is a code-maintained rollup
-- (see recalcFulfillment in backend/lib/orderHelpers.js). Idempotent.

-- Drift fix: order_activity_log existed in the live DB but not in schema.sql.
CREATE TABLE IF NOT EXISTS order_activity_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    performed_by UUID,
    performer_name TEXT,
    details JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_order_activity_log_order ON order_activity_log(order_id);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_status VARCHAR(20) DEFAULT 'unfulfilled';

CREATE TABLE IF NOT EXISTS shipments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    shipment_number TEXT UNIQUE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'packing', -- packing | shipped | delivered | cancelled
    delivery_method VARCHAR(20) DEFAULT 'shipping', -- shipping | pickup
    carrier TEXT,
    service_level TEXT,
    tracking_number TEXT,
    tracking_url TEXT,
    package_count INTEGER DEFAULT 1,
    total_weight_lbs DECIMAL(10,2),
    shipping_cost DECIMAL(10,2),
    freightview_shipment_id TEXT,
    notes TEXT,
    packed_by UUID,
    packed_at TIMESTAMP,
    shipped_at TIMESTAMP,
    delivered_at TIMESTAMP,
    created_by UUID,
    created_by_name TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments(order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);
CREATE INDEX IF NOT EXISTS idx_shipments_tracking ON shipments(tracking_number);

CREATE TABLE IF NOT EXISTS shipment_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shipment_id UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    order_item_id UUID NOT NULL REFERENCES order_items(id),
    sku_id UUID REFERENCES skus(id),
    qty_boxes INTEGER NOT NULL,
    sqft DECIMAL(10,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_shipment_items_shipment ON shipment_items(shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_items_order_item ON shipment_items(order_item_id);

-- ---- Backfill: synthesize one shipment per already-shipped/delivered order ----
-- so historical orders keep an intact fulfillment record. Idempotent (guards on
-- absence of an existing shipment). tracking_url is computed by the API on read.

INSERT INTO shipments (order_id, shipment_number, status, delivery_method, carrier,
    tracking_number, shipped_at, delivered_at, created_by_name, created_at)
SELECT o.id,
       o.order_number || '-S1',
       CASE WHEN o.status = 'delivered' THEN 'delivered' ELSE 'shipped' END,
       COALESCE(o.delivery_method, 'shipping'),
       o.shipping_carrier,
       o.tracking_number,
       COALESCE(o.shipped_at, o.confirmed_at, o.created_at),
       CASE WHEN o.status = 'delivered'
            THEN COALESCE(o.delivered_at, o.shipped_at, o.created_at) END,
       'Backfill (026)',
       COALESCE(o.shipped_at, o.created_at)
FROM orders o
WHERE o.status IN ('shipped', 'delivered')
  AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = o.id);

INSERT INTO shipment_items (shipment_id, order_item_id, sku_id, qty_boxes, sqft)
SELECT s.id, oi.id, oi.sku_id, oi.num_boxes, oi.sqft_needed
FROM shipments s
JOIN order_items oi ON oi.order_id = s.order_id AND COALESCE(oi.is_sample, false) = false
WHERE s.created_by_name = 'Backfill (026)'
  AND NOT EXISTS (SELECT 1 FROM shipment_items si WHERE si.shipment_id = s.id);

UPDATE orders o SET fulfillment_status = 'fulfilled'
WHERE o.status IN ('shipped', 'delivered')
  AND EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = o.id AND s.status <> 'cancelled');
