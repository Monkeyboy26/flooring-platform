-- Migration 002: EDI Integration
-- Adds tables and columns for Shaw EDI 850/855/856/810 document exchange.
--
-- Usage:
--   docker exec -i flooring-platform-db-1 psql -U postgres -d flooring_pim < database/migrations/002_edi_integration.sql

-- Enable uuid generation if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==================== New Tables ====================

-- Audit log for all EDI documents sent/received
CREATE TABLE IF NOT EXISTS edi_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id UUID NOT NULL REFERENCES vendors(id),
    document_type VARCHAR(10) NOT NULL,
    direction VARCHAR(10) NOT NULL,
    filename TEXT,
    interchange_control_number BIGINT,
    purchase_order_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL,
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    status VARCHAR(30) DEFAULT 'pending',
    raw_content TEXT,
    error_message TEXT,
    processed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_edi_transactions_vendor ON edi_transactions(vendor_id);
CREATE INDEX IF NOT EXISTS idx_edi_transactions_type ON edi_transactions(document_type);
CREATE INDEX IF NOT EXISTS idx_edi_transactions_po ON edi_transactions(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_edi_transactions_filename ON edi_transactions(filename);

-- Parsed 810 invoice headers
CREATE TABLE IF NOT EXISTS edi_invoices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id UUID NOT NULL REFERENCES vendors(id),
    edi_transaction_id UUID REFERENCES edi_transactions(id),
    invoice_number TEXT NOT NULL,
    invoice_date DATE,
    po_number TEXT,
    purchase_order_id UUID REFERENCES purchase_orders(id),
    total_amount DECIMAL(12,2),
    status VARCHAR(30) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_edi_invoices_vendor ON edi_invoices(vendor_id);
CREATE INDEX IF NOT EXISTS idx_edi_invoices_po ON edi_invoices(purchase_order_id);

-- Line items from 810 invoices
CREATE TABLE IF NOT EXISTS edi_invoice_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    edi_invoice_id UUID NOT NULL REFERENCES edi_invoices(id) ON DELETE CASCADE,
    line_number INTEGER,
    vendor_sku TEXT,
    description TEXT,
    qty DECIMAL(12,4),
    unit_of_measure VARCHAR(10),
    unit_price DECIMAL(12,4),
    subtotal DECIMAL(12,2)
);
CREATE INDEX IF NOT EXISTS idx_edi_invoice_items_invoice ON edi_invoice_items(edi_invoice_id);

-- Auto-incrementing ISA/GS/ST control numbers per vendor
CREATE TABLE IF NOT EXISTS edi_control_numbers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id UUID NOT NULL REFERENCES vendors(id),
    number_type VARCHAR(20) NOT NULL,
    last_number BIGINT NOT NULL DEFAULT 0,
    UNIQUE(vendor_id, number_type)
);

-- ==================== Alter Existing Tables ====================

-- Purchase orders: EDI tracking columns
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS edi_interchange_id BIGINT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS edi_ack_status VARCHAR(30);
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS edi_ack_received_at TIMESTAMP;

-- Purchase order items: line-level EDI data
ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS edi_line_status VARCHAR(30);
ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS dye_lot TEXT;
ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS qty_shipped INTEGER;

-- Vendors: EDI config
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS edi_config JSONB;

-- ==================== Seed Shaw EDI Config ====================

-- Set edi_config on Shaw vendor (update if Shaw vendor exists)
UPDATE vendors SET edi_config = '{
  "enabled": true,
  "sftp_host": "shawedi.shawfloors.com",
  "sftp_port": 22,
  "sftp_user": "edi07408",
  "sftp_pass": "ef6049",
  "inbox_dir": "/Inbox",
  "outbox_dir": "/Outbox",
  "outbox_archive_dir": "/Outbox/Archive",
  "sender_id": "ROMAFLOOR",
  "sender_qualifier": "ZZ",
  "receiver_id": "SHAWFLOORS",
  "receiver_qualifier": "01",
  "gs_sender_id": "ROMAFLOOR",
  "gs_receiver_id": "SHAWFLOORS",
  "account_number": "0133954",
  "usage_indicator": "P",
  "segment_terminator": "~",
  "element_separator": "*",
  "sub_element_separator": ":",
  "hard_surface_categories": ["hardwood", "laminate", "vinyl", "lvt", "lvp", "spc", "wpc", "tile", "stone", "resilient", "rigid core", "engineered hardwood"]
}'::jsonb
WHERE LOWER(name) LIKE '%shaw%';

-- Initialize control numbers for Shaw
INSERT INTO edi_control_numbers (vendor_id, number_type, last_number)
SELECT id, 'interchange', 0 FROM vendors WHERE LOWER(name) LIKE '%shaw%'
ON CONFLICT (vendor_id, number_type) DO NOTHING;

INSERT INTO edi_control_numbers (vendor_id, number_type, last_number)
SELECT id, 'group', 0 FROM vendors WHERE LOWER(name) LIKE '%shaw%'
ON CONFLICT (vendor_id, number_type) DO NOTHING;

INSERT INTO edi_control_numbers (vendor_id, number_type, last_number)
SELECT id, 'transaction', 0 FROM vendors WHERE LOWER(name) LIKE '%shaw%'
ON CONFLICT (vendor_id, number_type) DO NOTHING;

-- Create vendor_source for shaw-edi-poller
INSERT INTO vendor_sources (vendor_id, source_type, name, base_url, scraper_key, schedule, config, is_active)
SELECT id, 'edi_sftp', 'Shaw EDI Poller (855/856/810)', 'sftp://shawedi.shawfloors.com',
  'shaw-edi-poller', '*/30 * * * *',
  '{"edi": {"sftp_host": "shawedi.shawfloors.com", "sftp_port": 22, "sftp_user": "edi07408", "sftp_pass": "ef6049", "outbox_dir": "/Outbox", "outbox_archive_dir": "/Outbox/Archive"}}'::jsonb,
  true
FROM vendors WHERE LOWER(name) LIKE '%shaw%'
ON CONFLICT DO NOTHING;

-- Done
SELECT 'EDI migration complete' AS status;
