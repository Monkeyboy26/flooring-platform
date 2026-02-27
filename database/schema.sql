CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE vendors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    code TEXT UNIQUE NOT NULL,
    website TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    parent_id UUID REFERENCES categories(id),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    image_url TEXT,
    sort_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id UUID REFERENCES vendors(id),
    name TEXT NOT NULL,
    collection TEXT NOT NULL DEFAULT '',
    category_id UUID REFERENCES categories(id),
    status VARCHAR(20) DEFAULT 'draft',
    description_long TEXT,
    description_short TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE skus (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID REFERENCES products(id),
    vendor_sku TEXT NOT NULL,
    internal_sku TEXT UNIQUE NOT NULL,
    variant_name TEXT,
    sell_by VARCHAR(20),
    variant_type VARCHAR(50),
    is_sample BOOLEAN DEFAULT false,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE packaging (
    sku_id UUID PRIMARY KEY REFERENCES skus(id),
    sqft_per_box DECIMAL(10,4),
    pieces_per_box INTEGER,
    weight_per_box_lbs DECIMAL(10,2),
    freight_class SMALLINT DEFAULT 70,
    boxes_per_pallet INTEGER,
    sqft_per_pallet DECIMAL(10,2),
    weight_per_pallet_lbs DECIMAL(10,2),
    roll_width_ft DECIMAL(5,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE pricing (
    sku_id UUID PRIMARY KEY REFERENCES skus(id),
    cost DECIMAL(10,2) NOT NULL,
    retail_price DECIMAL(10,2) NOT NULL,
    price_basis VARCHAR(20),
    cut_price DECIMAL(10,2),
    roll_price DECIMAL(10,2),
    cut_cost DECIMAL(10,2),
    roll_cost DECIMAL(10,2),
    roll_min_sqft DECIMAL(10,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_number TEXT UNIQUE NOT NULL,
    session_id TEXT,
    customer_email TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    phone TEXT,
    shipping_address_line1 TEXT,
    shipping_address_line2 TEXT,
    shipping_city TEXT,
    shipping_state TEXT,
    shipping_zip TEXT,
    delivery_method VARCHAR(20) DEFAULT 'shipping',
    subtotal DECIMAL(10,2) NOT NULL,
    shipping DECIMAL(10,2) DEFAULT 0,
    shipping_method VARCHAR(50),
    sample_shipping DECIMAL(10,2) DEFAULT 0,
    total DECIMAL(10,2) NOT NULL,
    stripe_payment_intent_id TEXT,
    status VARCHAR(30) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID REFERENCES orders(id) NOT NULL,
    product_id UUID REFERENCES products(id),
    sku_id UUID REFERENCES skus(id),
    product_name TEXT,
    collection TEXT,
    description TEXT,
    sqft_needed DECIMAL(10,2),
    num_boxes INTEGER NOT NULL,
    unit_price DECIMAL(10,2),
    subtotal DECIMAL(10,2),
    sell_by VARCHAR(20),
    is_sample BOOLEAN DEFAULT false,
    price_tier VARCHAR(10)
);

CREATE TABLE cart_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id TEXT NOT NULL,
    product_id UUID REFERENCES products(id),
    sku_id UUID REFERENCES skus(id),
    sqft_needed DECIMAL(10,2),
    num_boxes INTEGER NOT NULL,
    include_overage BOOLEAN DEFAULT false,
    unit_price DECIMAL(10,2) NOT NULL,
    subtotal DECIMAL(10,2) NOT NULL,
    is_sample BOOLEAN DEFAULT false,
    sell_by TEXT,
    price_tier VARCHAR(10),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE attributes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    display_order INTEGER DEFAULT 0,
    is_filterable BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sku_attributes (
    sku_id UUID REFERENCES skus(id),
    attribute_id UUID REFERENCES attributes(id),
    value TEXT NOT NULL,
    PRIMARY KEY (sku_id, attribute_id)
);

CREATE TABLE import_mapping_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id UUID REFERENCES vendors(id) NOT NULL,
    name TEXT NOT NULL,
    mapping JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE products ADD CONSTRAINT products_vendor_collection_name_unique UNIQUE (vendor_id, collection, name);

CREATE INDEX idx_products_vendor ON products(vendor_id);
CREATE INDEX idx_skus_product ON skus(product_id);
CREATE INDEX idx_cart_items_session ON cart_items(session_id);
CREATE INDEX idx_sku_attributes_attr ON sku_attributes(attribute_id);
CREATE INDEX idx_orders_session ON orders(session_id);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_import_templates_vendor ON import_mapping_templates(vendor_id);

CREATE TABLE vendor_sources (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id UUID REFERENCES vendors(id) NOT NULL,
    source_type VARCHAR(20) NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    config JSONB DEFAULT '{}',
    scraper_key TEXT,
    schedule TEXT,
    is_active BOOLEAN DEFAULT true,
    last_scraped_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE scrape_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_source_id UUID REFERENCES vendor_sources(id) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    products_found INTEGER DEFAULT 0,
    products_created INTEGER DEFAULT 0,
    products_updated INTEGER DEFAULT 0,
    skus_created INTEGER DEFAULT 0,
    errors JSONB DEFAULT '[]',
    log TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_vendor_sources_vendor ON vendor_sources(vendor_id);
CREATE INDEX idx_scrape_jobs_source ON scrape_jobs(vendor_source_id);
CREATE INDEX idx_scrape_jobs_status ON scrape_jobs(status);

CREATE TABLE media_assets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID NOT NULL REFERENCES products(id),
    sku_id UUID REFERENCES skus(id),
    asset_type VARCHAR(30) NOT NULL DEFAULT 'primary',
    url TEXT NOT NULL,
    original_url TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- Separate unique indexes for SKU-level and product-level images
CREATE UNIQUE INDEX IF NOT EXISTS media_assets_unique_sku
    ON media_assets (product_id, sku_id, asset_type, sort_order)
    WHERE sku_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS media_assets_unique_product
    ON media_assets (product_id, asset_type, sort_order)
    WHERE sku_id IS NULL;
CREATE INDEX idx_media_assets_product ON media_assets(product_id);
CREATE INDEX idx_media_assets_type ON media_assets(product_id, asset_type);

CREATE TABLE inventory_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sku_id UUID NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
    warehouse TEXT NOT NULL DEFAULT 'default',
    qty_on_hand INTEGER DEFAULT 0,
    qty_in_transit INTEGER DEFAULT 0,
    qty_on_hand_sqft INTEGER DEFAULT 0,
    qty_in_transit_sqft INTEGER DEFAULT 0,
    fresh_until TIMESTAMP,
    snapshot_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(sku_id, warehouse)
);
CREATE INDEX idx_inventory_snapshots_sku ON inventory_snapshots(sku_id);

-- ==================== Sales Rep Portal ====================

CREATE TABLE sales_reps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE rep_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rep_id UUID NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE quotes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    quote_number TEXT UNIQUE NOT NULL,
    sales_rep_id UUID NOT NULL REFERENCES sales_reps(id),
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    phone TEXT,
    shipping_address_line1 TEXT,
    shipping_address_line2 TEXT,
    shipping_city TEXT,
    shipping_state TEXT,
    shipping_zip TEXT,
    subtotal DECIMAL(10,2) DEFAULT 0,
    shipping DECIMAL(10,2) DEFAULT 0,
    total DECIMAL(10,2) DEFAULT 0,
    notes TEXT,
    delivery_method VARCHAR(20) DEFAULT 'shipping',
    status VARCHAR(30) DEFAULT 'draft',
    converted_order_id UUID REFERENCES orders(id),
    payment_method VARCHAR(20),
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE quote_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id),
    sku_id UUID REFERENCES skus(id),
    product_name TEXT,
    collection TEXT,
    description TEXT,
    sqft_needed DECIMAL(10,2),
    num_boxes INTEGER NOT NULL,
    unit_price DECIMAL(10,2) NOT NULL,
    subtotal DECIMAL(10,2) NOT NULL,
    sell_by VARCHAR(20),
    is_sample BOOLEAN DEFAULT false
);

CREATE TABLE order_price_adjustments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    rep_id UUID NOT NULL REFERENCES sales_reps(id),
    previous_unit_price DECIMAL(10,2),
    new_unit_price DECIMAL(10,2) NOT NULL,
    previous_subtotal DECIMAL(10,2),
    new_subtotal DECIMAL(10,2) NOT NULL,
    reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE orders ADD COLUMN sales_rep_id UUID REFERENCES sales_reps(id);
ALTER TABLE orders ADD COLUMN payment_method VARCHAR(20) DEFAULT 'stripe';
ALTER TABLE orders ADD COLUMN quote_id UUID REFERENCES quotes(id);

CREATE INDEX idx_orders_sales_rep ON orders(sales_rep_id);
CREATE INDEX idx_quotes_rep ON quotes(sales_rep_id);
CREATE INDEX idx_quote_items_quote ON quote_items(quote_id);
CREATE INDEX idx_rep_sessions_token ON rep_sessions(token);
CREATE INDEX idx_order_price_adj_item ON order_price_adjustments(order_item_id);

-- ==================== Purchase Orders ====================

CREATE TABLE purchase_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    vendor_id UUID NOT NULL REFERENCES vendors(id),
    po_number TEXT UNIQUE NOT NULL,
    status VARCHAR(30) DEFAULT 'draft',
    subtotal DECIMAL(10,2) DEFAULT 0,
    notes TEXT,
    approved_by UUID REFERENCES staff_accounts(id),
    approved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE purchase_order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    order_item_id UUID NOT NULL REFERENCES order_items(id),
    sku_id UUID REFERENCES skus(id),
    product_name TEXT,
    vendor_sku TEXT,
    description TEXT,
    qty INTEGER NOT NULL,
    sell_by VARCHAR(20),
    cost DECIMAL(10,2) NOT NULL,
    original_cost DECIMAL(10,2) NOT NULL,
    retail_price DECIMAL(10,2),
    subtotal DECIMAL(10,2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_purchase_orders_order ON purchase_orders(order_id);
CREATE INDEX idx_purchase_orders_vendor ON purchase_orders(vendor_id);
CREATE INDEX idx_purchase_orders_status ON purchase_orders(status);
CREATE INDEX idx_purchase_order_items_po ON purchase_order_items(purchase_order_id);
CREATE INDEX idx_purchase_order_items_order_item ON purchase_order_items(order_item_id);

-- ==================== Trade Pricing ====================

CREATE TABLE margin_tiers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE,
    discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE trade_customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    company_name TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    phone TEXT,
    status VARCHAR(20) DEFAULT 'pending',
    margin_tier_id UUID REFERENCES margin_tiers(id),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE trade_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trade_customer_id UUID NOT NULL REFERENCES trade_customers(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_trade_sessions_token ON trade_sessions(token);
CREATE INDEX idx_trade_customers_status ON trade_customers(status);
CREATE INDEX idx_trade_customers_tier ON trade_customers(margin_tier_id);

-- ==================== Staff Accounts ====================

CREATE TABLE staff_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone TEXT,
    role VARCHAR(20) NOT NULL DEFAULT 'sales_rep',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT staff_role_check CHECK (role IN ('admin', 'manager', 'sales_rep', 'warehouse'))
);

CREATE TABLE staff_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    staff_id UUID NOT NULL REFERENCES staff_accounts(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    device_fingerprint TEXT,
    is_trusted BOOLEAN DEFAULT false,
    trusted_until TIMESTAMP,
    remember_me BOOLEAN DEFAULT false,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    staff_id UUID REFERENCES staff_accounts(id),
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id UUID,
    details JSONB DEFAULT '{}',
    ip_address TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_staff_sessions_token ON staff_sessions(token);
CREATE INDEX idx_staff_sessions_staff ON staff_sessions(staff_id);
CREATE INDEX idx_audit_log_staff ON audit_log(staff_id);
CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);

-- ==================== Shipping Detail Columns ====================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_carrier TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_transit_days INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_residential BOOLEAN DEFAULT true;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_liftgate BOOLEAN DEFAULT true;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_is_fallback BOOLEAN DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMP;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;

-- ==================== Trade Application Enhancements ====================

ALTER TABLE trade_customers ADD COLUMN IF NOT EXISTS business_type VARCHAR(50);
ALTER TABLE trade_customers ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE trade_customers ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE trade_customers ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(30) DEFAULT 'none';
ALTER TABLE trade_customers ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP;
ALTER TABLE trade_customers ADD COLUMN IF NOT EXISTS denial_reason TEXT;
ALTER TABLE trade_customers ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES staff_accounts(id);
ALTER TABLE trade_customers ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;
ALTER TABLE trade_customers ADD COLUMN IF NOT EXISTS total_spend DECIMAL(12,2) DEFAULT 0;
ALTER TABLE trade_customers ADD COLUMN IF NOT EXISTS tier_locked_until TIMESTAMP;
ALTER TABLE trade_customers ADD COLUMN IF NOT EXISTS assigned_rep_id UUID REFERENCES staff_accounts(id);
ALTER TABLE trade_customers ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP;

CREATE TABLE trade_documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trade_customer_id UUID REFERENCES trade_customers(id) ON DELETE CASCADE,
    doc_type VARCHAR(50) NOT NULL,
    file_name TEXT NOT NULL,
    file_key TEXT NOT NULL,
    file_size INTEGER,
    mime_type TEXT,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_trade_documents_customer ON trade_documents(trade_customer_id);

-- ==================== Tier Progression ====================

ALTER TABLE margin_tiers ADD COLUMN IF NOT EXISTS spend_threshold DECIMAL(12,2) DEFAULT 0;
ALTER TABLE margin_tiers ADD COLUMN IF NOT EXISTS tier_level INTEGER DEFAULT 0;

-- ==================== Orders Trade Enhancements ====================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS trade_customer_id UUID REFERENCES trade_customers(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS po_number TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_tax_exempt BOOLEAN DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS project_id UUID;

-- ==================== Quotes Trade Enhancement ====================

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS trade_customer_id UUID REFERENCES trade_customers(id);
ALTER TABLE quotes ALTER COLUMN sales_rep_id DROP NOT NULL;

-- ==================== Customer-Rep History ====================

CREATE TABLE customer_rep_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trade_customer_id UUID NOT NULL REFERENCES trade_customers(id) ON DELETE CASCADE,
    from_rep_id UUID REFERENCES staff_accounts(id),
    to_rep_id UUID REFERENCES staff_accounts(id),
    reason TEXT,
    changed_by UUID REFERENCES staff_accounts(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_customer_rep_history_customer ON customer_rep_history(trade_customer_id);

-- ==================== Trade Dashboard Tables ====================

CREATE TABLE trade_projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trade_customer_id UUID NOT NULL REFERENCES trade_customers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    client_name TEXT,
    address TEXT,
    notes TEXT,
    expected_date DATE,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE trade_favorites (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trade_customer_id UUID NOT NULL REFERENCES trade_customers(id) ON DELETE CASCADE,
    collection_name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE trade_favorite_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    favorite_id UUID NOT NULL REFERENCES trade_favorites(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id),
    sku_id UUID REFERENCES skus(id),
    notes TEXT,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_trade_projects_customer ON trade_projects(trade_customer_id);
CREATE INDEX idx_trade_favorites_customer ON trade_favorites(trade_customer_id);
CREATE INDEX idx_trade_favorite_items_fav ON trade_favorite_items(favorite_id);

-- ==================== Trade Customer Address ====================

ALTER TABLE trade_customers ADD COLUMN IF NOT EXISTS address_line1 TEXT;
ALTER TABLE trade_customers ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE trade_customers ADD COLUMN IF NOT EXISTS state VARCHAR(2);
ALTER TABLE trade_customers ADD COLUMN IF NOT EXISTS zip VARCHAR(10);
ALTER TABLE trade_customers ADD COLUMN IF NOT EXISTS contractor_license TEXT;

-- ==================== 2FA ====================

CREATE TABLE staff_2fa_codes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    staff_id UUID NOT NULL REFERENCES staff_accounts(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_staff_2fa_codes_staff ON staff_2fa_codes(staff_id);

-- ==================== Installation Inquiries ====================

CREATE TABLE installation_inquiries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_name VARCHAR(200) NOT NULL,
    customer_email VARCHAR(255) NOT NULL,
    phone VARCHAR(30),
    zip_code VARCHAR(10),
    estimated_sqft NUMERIC(10,2),
    message TEXT,
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,
    product_name VARCHAR(300),
    collection VARCHAR(200),
    status VARCHAR(20) DEFAULT 'new',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_installation_inquiries_status ON installation_inquiries(status);

-- ==================== Customer Accounts ====================

CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone TEXT,
    address_line1 TEXT,
    address_line2 TEXT,
    city TEXT,
    state TEXT,
    zip TEXT,
    password_reset_token TEXT,
    password_reset_expires TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE customer_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_customer_sessions_token ON customer_sessions(token);
CREATE INDEX idx_customers_email ON customers(email);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id);
CREATE INDEX idx_orders_customer ON orders(customer_id);

-- ==================== Promo Codes ====================

CREATE TABLE promo_codes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code TEXT NOT NULL UNIQUE,
    description TEXT,
    discount_type VARCHAR(10) NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
    discount_value DECIMAL(10,2) NOT NULL,
    min_order_amount DECIMAL(10,2) DEFAULT 0,
    max_uses INTEGER,
    max_uses_per_customer INTEGER,
    restricted_category_ids UUID[] DEFAULT '{}',
    restricted_product_ids UUID[] DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    expires_at TIMESTAMP,
    created_by UUID REFERENCES staff_accounts(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX idx_promo_codes_upper_code ON promo_codes(UPPER(code));

CREATE TABLE promo_code_usages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    promo_code_id UUID NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
    order_id UUID REFERENCES orders(id),
    quote_id UUID REFERENCES quotes(id),
    customer_email TEXT NOT NULL,
    discount_amount DECIMAL(10,2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_promo_usages_code ON promo_code_usages(promo_code_id);
CREATE INDEX idx_promo_usages_email ON promo_code_usages(customer_email);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_code_id UUID REFERENCES promo_codes(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(10,2) DEFAULT 0;

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS promo_code_id UUID REFERENCES promo_codes(id);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS promo_code TEXT;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(10,2) DEFAULT 0;

-- ==================== PO Enhancements ====================

-- PO item-level status tracking
ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending';
CREATE INDEX IF NOT EXISTS idx_poi_status ON purchase_order_items(status);

-- PO revision tracking
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS revision INTEGER DEFAULT 0;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS is_revised BOOLEAN DEFAULT false;

-- Allow manually-added PO line items (no parent order item)
ALTER TABLE purchase_order_items ALTER COLUMN order_item_id DROP NOT NULL;

-- ==================== Vendor Email + PO Activity Log ====================

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS has_public_inventory BOOLEAN DEFAULT false;

CREATE TABLE IF NOT EXISTS po_activity_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    performed_by UUID REFERENCES staff_accounts(id),
    performer_name TEXT,
    recipient_email TEXT,
    revision INTEGER,
    details JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_po_activity_po_id ON po_activity_log(purchase_order_id);

-- ==================== Order Refund Tracking ====================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_refund_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_amount DECIMAL(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMP;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_by UUID REFERENCES staff_accounts(id);

-- ==================== Order Balance & Payments ====================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount_paid DECIMAL(10,2) DEFAULT 0;

CREATE TABLE IF NOT EXISTS order_payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    payment_type VARCHAR(20) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    stripe_payment_intent_id TEXT,
    stripe_refund_id TEXT,
    stripe_checkout_session_id TEXT,
    description TEXT,
    initiated_by UUID,
    initiated_by_name TEXT,
    status VARCHAR(20) DEFAULT 'completed',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_order_payments_order ON order_payments(order_id);

CREATE TABLE IF NOT EXISTS payment_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    amount DECIMAL(10,2) NOT NULL,
    stripe_checkout_session_id TEXT,
    stripe_checkout_url TEXT,
    status VARCHAR(20) DEFAULT 'pending',
    sent_to_email TEXT NOT NULL,
    sent_by UUID,
    sent_by_name TEXT,
    message TEXT,
    paid_at TIMESTAMP,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payment_requests_order ON payment_requests(order_id);

-- ==================== Customer Notes ====================

CREATE TABLE IF NOT EXISTS customer_notes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_type VARCHAR(10) NOT NULL,
    customer_ref TEXT NOT NULL,
    staff_id UUID REFERENCES staff_accounts(id),
    note TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_customer_notes_ref ON customer_notes(customer_type, customer_ref);

-- ==================== Rep Notifications ====================

CREATE TABLE IF NOT EXISTS rep_notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rep_id UUID NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    title TEXT NOT NULL,
    message TEXT,
    entity_type VARCHAR(30),
    entity_id UUID,
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rep_notifications_rep ON rep_notifications(rep_id);
CREATE INDEX IF NOT EXISTS idx_rep_notifications_unread ON rep_notifications(rep_id, is_read) WHERE is_read = false;
CREATE INDEX IF NOT EXISTS idx_rep_notifications_created ON rep_notifications(created_at);

-- ==================== Commission Config ====================

CREATE TABLE IF NOT EXISTS commission_config (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rate DECIMAL(5,4) NOT NULL DEFAULT 0.10,
    default_cost_ratio DECIMAL(5,4) NOT NULL DEFAULT 0.55,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO commission_config (rate, default_cost_ratio)
    SELECT 0.10, 0.55 WHERE NOT EXISTS (SELECT 1 FROM commission_config);

-- ==================== Rep Commissions ====================

CREATE TABLE IF NOT EXISTS rep_commissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    rep_id UUID NOT NULL REFERENCES sales_reps(id),
    order_total DECIMAL(10,2) NOT NULL,
    vendor_cost DECIMAL(10,2) NOT NULL DEFAULT 0,
    margin DECIMAL(10,2) NOT NULL DEFAULT 0,
    commission_rate DECIMAL(5,4) NOT NULL,
    commission_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    paid_at TIMESTAMP,
    paid_by UUID,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rep_commissions_order ON rep_commissions(order_id);
CREATE INDEX IF NOT EXISTS idx_rep_commissions_rep ON rep_commissions(rep_id);
CREATE INDEX IF NOT EXISTS idx_rep_commissions_status ON rep_commissions(status);

-- ==================== Showroom Visits ====================

CREATE TABLE IF NOT EXISTS showroom_visits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token VARCHAR(64) UNIQUE NOT NULL,
  rep_id UUID NOT NULL REFERENCES sales_reps(id),
  customer_name TEXT NOT NULL,
  customer_email TEXT,
  customer_phone TEXT,
  message TEXT,
  status VARCHAR(20) DEFAULT 'draft',
  sent_at TIMESTAMP,
  opened_at TIMESTAMP,
  items_carted_at TIMESTAMP,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_showroom_visits_rep ON showroom_visits(rep_id);
CREATE INDEX IF NOT EXISTS idx_showroom_visits_token ON showroom_visits(token);

CREATE TABLE IF NOT EXISTS showroom_visit_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  visit_id UUID NOT NULL REFERENCES showroom_visits(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id),
  sku_id UUID REFERENCES skus(id),
  product_name TEXT NOT NULL,
  collection TEXT,
  variant_name TEXT,
  retail_price DECIMAL(10,2),
  price_basis VARCHAR(20),
  primary_image TEXT,
  rep_note TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_showroom_visit_items_visit ON showroom_visit_items(visit_id);

-- ==================== Sample Requests ====================

CREATE TABLE IF NOT EXISTS sample_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_number VARCHAR(40) UNIQUE NOT NULL,
  rep_id UUID NOT NULL REFERENCES sales_reps(id),
  customer_name TEXT NOT NULL,
  customer_email TEXT,
  customer_phone TEXT,
  shipping_address_line1 TEXT,
  shipping_address_line2 TEXT,
  shipping_city TEXT,
  shipping_state TEXT,
  shipping_zip TEXT,
  delivery_method VARCHAR(20) DEFAULT 'shipping',
  status VARCHAR(20) DEFAULT 'requested',
  tracking_number TEXT,
  notes TEXT,
  shipped_at TIMESTAMP,
  delivered_at TIMESTAMP,
  cancelled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sample_requests_rep ON sample_requests(rep_id);
CREATE INDEX IF NOT EXISTS idx_sample_requests_status ON sample_requests(status);

CREATE TABLE IF NOT EXISTS sample_request_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sample_request_id UUID NOT NULL REFERENCES sample_requests(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id),
  sku_id UUID REFERENCES skus(id),
  product_name TEXT NOT NULL,
  collection TEXT,
  variant_name TEXT,
  primary_image TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sample_request_items_request ON sample_request_items(sample_request_id);

-- ==================== Wishlists ====================

CREATE TABLE IF NOT EXISTS wishlists (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(customer_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_wishlists_customer ON wishlists(customer_id);

-- ==================== Storefront SKU Browse ====================

CREATE INDEX IF NOT EXISTS idx_media_assets_sku ON media_assets(sku_id) WHERE sku_id IS NOT NULL;
