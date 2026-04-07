CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

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
    description TEXT,
    banner_image TEXT,
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
    slug TEXT,
    status VARCHAR(20) DEFAULT 'draft',
    description_long TEXT,
    description_short TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX products_slug_unique ON products (slug) WHERE slug IS NOT NULL;

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
    roll_length_ft DECIMAL(7,2),
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
    map_price DECIMAL(10,2),
    sale_price DECIMAL(10,2),
    sale_ends_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pricing_sale ON pricing(sale_price) WHERE sale_price IS NOT NULL;

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
    bank_transfer_instructions JSONB,
    bank_transfer_expires_at TIMESTAMP,
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
    avg_quality_score INTEGER,
    warning_count INTEGER DEFAULT 0,
    skus_affected INTEGER DEFAULT 0,
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
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
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
    order_item_id UUID REFERENCES order_items(id),
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
    stripe_customer_id TEXT,
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

-- Auto-created customer accounts (rep-initiated)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_set BOOLEAN DEFAULT true;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS assigned_rep_id UUID REFERENCES sales_reps(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS created_via VARCHAR(30);

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id);
ALTER TABLE sample_requests ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id);
ALTER TABLE showroom_visits ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id);

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
  rep_id UUID REFERENCES sales_reps(id),
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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  stripe_checkout_session_id TEXT,
  shipping_payment_collected BOOLEAN DEFAULT false,
  shipping_payment_collected_at TIMESTAMP
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
  status VARCHAR(20) DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  vendor_notified_at TIMESTAMP,
  vendor_notified_email TEXT
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

-- ==================== Product Reviews ====================

CREATE TABLE IF NOT EXISTS product_reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title VARCHAR(200),
  body TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(product_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_product_reviews_product ON product_reviews(product_id);

-- ==================== Stock Alerts ====================

CREATE TABLE IF NOT EXISTS stock_alerts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sku_id UUID NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  notified_at TIMESTAMP,
  UNIQUE(sku_id, email)
);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_sku ON stock_alerts(sku_id);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_status ON stock_alerts(status) WHERE status = 'active';

-- ==================== EDI Integration ====================

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

-- ==================== Accounting Module ====================

-- Expense categories with type classification for P&L
CREATE TABLE IF NOT EXISTS expense_categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    expense_type VARCHAR(20) NOT NULL DEFAULT 'operating' CHECK (expense_type IN ('cogs', 'operating', 'overhead')),
    parent_id UUID REFERENCES expense_categories(id),
    sort_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed default expense categories
INSERT INTO expense_categories (name, slug, expense_type, sort_order) VALUES
  ('Shipping & Freight', 'shipping-freight', 'cogs', 1),
  ('Returns & Damages', 'returns-damages', 'cogs', 2),
  ('Warehouse', 'warehouse', 'operating', 3),
  ('Vehicle & Gas', 'vehicle-gas', 'operating', 4),
  ('Office Supplies', 'office-supplies', 'operating', 5),
  ('Marketing', 'marketing', 'operating', 6),
  ('Tools & Equipment', 'tools-equipment', 'operating', 7),
  ('Commissions', 'commissions', 'operating', 8),
  ('Insurance', 'insurance', 'overhead', 9),
  ('Rent', 'rent', 'overhead', 10),
  ('Utilities', 'utilities', 'overhead', 11),
  ('Professional Services', 'professional-services', 'overhead', 12),
  ('Payroll', 'payroll', 'overhead', 13),
  ('Miscellaneous', 'miscellaneous', 'operating', 14)
ON CONFLICT (slug) DO NOTHING;

-- Expenses log
CREATE TABLE IF NOT EXISTS expenses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
    category_id UUID NOT NULL REFERENCES expense_categories(id),
    vendor_name TEXT,
    description TEXT,
    amount DECIMAL(10,2) NOT NULL,
    payment_method VARCHAR(20),
    reference_number TEXT,
    receipt_url TEXT,
    is_recurring BOOLEAN DEFAULT false,
    notes TEXT,
    created_by UUID REFERENCES staff_accounts(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id);

-- AR Invoices
CREATE TABLE IF NOT EXISTS invoices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_number TEXT UNIQUE NOT NULL,
    order_id UUID REFERENCES orders(id),
    customer_email TEXT,
    customer_name TEXT,
    trade_customer_id UUID REFERENCES trade_customers(id),
    billing_address TEXT,
    payment_terms VARCHAR(20) DEFAULT 'due_on_receipt',
    issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE NOT NULL DEFAULT CURRENT_DATE,
    subtotal DECIMAL(10,2) NOT NULL DEFAULT 0,
    tax_rate DECIMAL(5,4) DEFAULT 0,
    tax_amount DECIMAL(10,2) DEFAULT 0,
    shipping DECIMAL(10,2) DEFAULT 0,
    discount_amount DECIMAL(10,2) DEFAULT 0,
    total DECIMAL(10,2) NOT NULL DEFAULT 0,
    amount_paid DECIMAL(10,2) DEFAULT 0,
    balance DECIMAL(10,2) GENERATED ALWAYS AS (total - amount_paid) STORED,
    status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft','sent','paid','overdue','partial','void')),
    sent_at TIMESTAMP,
    paid_at TIMESTAMP,
    notes TEXT,
    created_by UUID REFERENCES staff_accounts(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices(order_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_email);

-- Invoice line items
CREATE TABLE IF NOT EXISTS invoice_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    order_item_id UUID REFERENCES order_items(id),
    sku_id UUID REFERENCES skus(id),
    description TEXT NOT NULL,
    qty DECIMAL(10,2) NOT NULL DEFAULT 1,
    unit_price DECIMAL(10,2) NOT NULL DEFAULT 0,
    subtotal DECIMAL(10,2) NOT NULL DEFAULT 0,
    sort_order INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);

-- Invoice payments (AR receipts)
CREATE TABLE IF NOT EXISTS invoice_payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    order_payment_id UUID REFERENCES order_payments(id),
    amount DECIMAL(10,2) NOT NULL,
    payment_method VARCHAR(20) DEFAULT 'stripe',
    reference_number TEXT,
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    notes TEXT,
    recorded_by UUID REFERENCES staff_accounts(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments(invoice_id);

-- AP Bills
CREATE TABLE IF NOT EXISTS bills (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bill_number TEXT,
    internal_bill_number TEXT UNIQUE NOT NULL,
    vendor_id UUID NOT NULL REFERENCES vendors(id),
    purchase_order_id UUID REFERENCES purchase_orders(id),
    edi_invoice_id UUID REFERENCES edi_invoices(id),
    bill_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE NOT NULL DEFAULT CURRENT_DATE,
    payment_terms VARCHAR(20) DEFAULT 'net_30',
    subtotal DECIMAL(10,2) NOT NULL DEFAULT 0,
    tax_amount DECIMAL(10,2) DEFAULT 0,
    shipping DECIMAL(10,2) DEFAULT 0,
    total DECIMAL(10,2) NOT NULL DEFAULT 0,
    amount_paid DECIMAL(10,2) DEFAULT 0,
    balance DECIMAL(10,2) GENERATED ALWAYS AS (total - amount_paid) STORED,
    status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft','received','approved','paid','partial','void')),
    payment_method VARCHAR(20),
    payment_reference TEXT,
    notes TEXT,
    created_by UUID REFERENCES staff_accounts(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bills_status ON bills(status);
CREATE INDEX IF NOT EXISTS idx_bills_vendor ON bills(vendor_id);
CREATE INDEX IF NOT EXISTS idx_bills_po ON bills(purchase_order_id);

-- Bill line items
CREATE TABLE IF NOT EXISTS bill_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bill_id UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    purchase_order_item_id UUID REFERENCES purchase_order_items(id),
    sku_id UUID REFERENCES skus(id),
    description TEXT NOT NULL,
    qty DECIMAL(10,2) NOT NULL DEFAULT 1,
    unit_price DECIMAL(10,2) NOT NULL DEFAULT 0,
    subtotal DECIMAL(10,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bill_items_bill ON bill_items(bill_id);

-- Bill payments (AP disbursements)
CREATE TABLE IF NOT EXISTS bill_payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bill_id UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    amount DECIMAL(10,2) NOT NULL,
    payment_method VARCHAR(20) DEFAULT 'check',
    reference_number TEXT,
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    notes TEXT,
    recorded_by UUID REFERENCES staff_accounts(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bill_payments_bill ON bill_payments(bill_id);

-- Trade customer payment terms
ALTER TABLE trade_customers ADD COLUMN IF NOT EXISTS payment_terms VARCHAR(20) DEFAULT 'due_on_receipt';

-- Tax columns on orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_rate DECIMAL(5,4) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_amount DECIMAL(10,2) DEFAULT 0;

-- Tracking columns on orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS freightview_shipment_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_status VARCHAR(30);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_last_checked TIMESTAMP;

-- Tracking events timeline
CREATE TABLE IF NOT EXISTS tracking_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    description TEXT,
    location TEXT,
    event_time TIMESTAMP,
    source VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tracking_events_order ON tracking_events(order_id);

-- ==================== In-Store Payment Enhancements ====================

ALTER TABLE order_payments ADD COLUMN IF NOT EXISTS check_number VARCHAR(50);
ALTER TABLE order_payments ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20);

CREATE TABLE IF NOT EXISTS cash_drawers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rep_id UUID NOT NULL REFERENCES sales_reps(id),
    rep_name TEXT NOT NULL,
    opening_balance DECIMAL(10,2) NOT NULL DEFAULT 0,
    expected_balance DECIMAL(10,2) NOT NULL DEFAULT 0,
    actual_balance DECIMAL(10,2),
    over_short DECIMAL(10,2),
    status VARCHAR(20) DEFAULT 'open',
    notes TEXT,
    opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cash_drawers_rep ON cash_drawers(rep_id);
CREATE INDEX IF NOT EXISTS idx_cash_drawers_status ON cash_drawers(rep_id, status);

CREATE TABLE IF NOT EXISTS cash_drawer_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    drawer_id UUID NOT NULL REFERENCES cash_drawers(id) ON DELETE CASCADE,
    order_id UUID REFERENCES orders(id),
    type VARCHAR(20) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cash_drawer_txns_drawer ON cash_drawer_transactions(drawer_id);

-- ==================== Order Documents ====================

CREATE TABLE IF NOT EXISTS order_documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    doc_type VARCHAR(50) NOT NULL,
    file_name TEXT NOT NULL,
    file_key TEXT NOT NULL,
    file_size INTEGER,
    mime_type TEXT,
    uploaded_by UUID REFERENCES staff_accounts(id),
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_order_documents_order ON order_documents(order_id);

-- ==================== Site Analytics ====================

CREATE TABLE IF NOT EXISTS analytics_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id TEXT,
    visitor_id TEXT,
    event_type VARCHAR(60) NOT NULL,
    properties JSONB DEFAULT '{}',
    page_path TEXT,
    referrer TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_analytics_events_type ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session ON analytics_events(session_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON analytics_events(created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_type_created ON analytics_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_sku ON analytics_events((properties->>'sku_id')) WHERE properties->>'sku_id' IS NOT NULL;

CREATE TABLE IF NOT EXISTS analytics_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id TEXT UNIQUE NOT NULL,
    visitor_id TEXT,
    customer_id UUID,
    trade_customer_id UUID,
    user_agent TEXT,
    referrer TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    device_type VARCHAR(20),
    first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    page_count INTEGER DEFAULT 1,
    is_converted BOOLEAN DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_visitor ON analytics_sessions(visitor_id);
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_first_seen ON analytics_sessions(first_seen_at);

CREATE TABLE IF NOT EXISTS analytics_daily_stats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    stat_date DATE UNIQUE NOT NULL,
    total_sessions INTEGER DEFAULT 0,
    unique_visitors INTEGER DEFAULT 0,
    page_views INTEGER DEFAULT 0,
    product_views INTEGER DEFAULT 0,
    add_to_carts INTEGER DEFAULT 0,
    checkouts_started INTEGER DEFAULT 0,
    orders_completed INTEGER DEFAULT 0,
    searches INTEGER DEFAULT 0,
    sample_requests INTEGER DEFAULT 0,
    trade_signups INTEGER DEFAULT 0,
    total_revenue DECIMAL(12,2) DEFAULT 0,
    avg_session_duration_secs INTEGER DEFAULT 0,
    bounce_rate DECIMAL(5,2) DEFAULT 0,
    cart_abandonment_rate DECIMAL(5,2) DEFAULT 0,
    top_search_terms JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_analytics_daily_stats_date ON analytics_daily_stats(stat_date);

-- ==================== Estimates ====================
CREATE TABLE IF NOT EXISTS estimates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    estimate_number TEXT UNIQUE NOT NULL,
    sales_rep_id UUID NOT NULL REFERENCES sales_reps(id),
    customer_id UUID REFERENCES customers(id),
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    phone TEXT,
    project_name TEXT,
    project_address_line1 TEXT,
    project_address_line2 TEXT,
    project_city TEXT,
    project_state TEXT,
    project_zip TEXT,
    materials_subtotal DECIMAL(10,2) DEFAULT 0,
    labor_subtotal DECIMAL(10,2) DEFAULT 0,
    subtotal DECIMAL(10,2) DEFAULT 0,
    tax_rate DECIMAL(5,4) DEFAULT 0,
    tax_amount DECIMAL(10,2) DEFAULT 0,
    total DECIMAL(10,2) DEFAULT 0,
    notes TEXT,
    internal_notes TEXT,
    status VARCHAR(30) DEFAULT 'draft',
    converted_quote_id UUID REFERENCES quotes(id),
    converted_order_id UUID REFERENCES orders(id),
    expires_at TIMESTAMP,
    sent_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_estimates_rep ON estimates(sales_rep_id);
CREATE INDEX IF NOT EXISTS idx_estimates_status ON estimates(status);

CREATE TABLE IF NOT EXISTS estimate_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    estimate_id UUID NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
    item_type VARCHAR(20) NOT NULL DEFAULT 'material',
    product_id UUID REFERENCES products(id),
    sku_id UUID REFERENCES skus(id),
    product_name TEXT,
    collection TEXT,
    description TEXT,
    sqft_needed DECIMAL(10,2),
    num_boxes INTEGER,
    sell_by VARCHAR(20),
    labor_category VARCHAR(50),
    rate_type VARCHAR(20),
    rate_sqft DECIMAL(10,2),
    labor_sqft DECIMAL(10,2),
    unit_price DECIMAL(10,2) NOT NULL,
    quantity DECIMAL(10,2) DEFAULT 1,
    subtotal DECIMAL(10,2) NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_estimate_items_estimate ON estimate_items(estimate_id);

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) NOT NULL UNIQUE,
    subscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==================== CRM: Deals & Tasks ====================

CREATE TABLE IF NOT EXISTS deals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rep_id UUID NOT NULL REFERENCES sales_reps(id),
    title TEXT NOT NULL,
    estimated_value DECIMAL(10,2) DEFAULT 0,
    stage VARCHAR(20) NOT NULL DEFAULT 'lead' CHECK (stage IN ('lead','quoted','negotiating','won','lost')),
    stage_entered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    customer_type VARCHAR(10),
    customer_ref TEXT,
    customer_name TEXT NOT NULL,
    customer_email TEXT,
    linked_quote_id UUID REFERENCES quotes(id) ON DELETE SET NULL,
    linked_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    linked_estimate_id UUID REFERENCES estimates(id) ON DELETE SET NULL,
    notes TEXT,
    lost_reason TEXT,
    expected_close_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_deals_rep ON deals(rep_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
CREATE INDEX IF NOT EXISTS idx_deals_customer ON deals(customer_type, customer_ref);

CREATE TABLE IF NOT EXISTS rep_tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rep_id UUID NOT NULL REFERENCES sales_reps(id),
    title TEXT NOT NULL,
    description TEXT,
    due_date DATE,
    priority VARCHAR(10) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
    status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','dismissed')),
    completed_at TIMESTAMP,
    source VARCHAR(10) DEFAULT 'manual' CHECK (source IN ('manual','auto')),
    source_type VARCHAR(30),
    source_id TEXT,
    snoozed_until DATE,
    customer_name TEXT,
    customer_email TEXT,
    customer_phone TEXT,
    linked_customer_type VARCHAR(10),
    linked_customer_ref TEXT,
    linked_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    linked_quote_id UUID REFERENCES quotes(id) ON DELETE SET NULL,
    linked_estimate_id UUID REFERENCES estimates(id) ON DELETE SET NULL,
    linked_deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rep_tasks_rep_status ON rep_tasks(rep_id, status);
CREATE INDEX IF NOT EXISTS idx_rep_tasks_due ON rep_tasks(due_date) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_rep_tasks_customer ON rep_tasks(linked_customer_type, linked_customer_ref);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rep_tasks_source_unique
  ON rep_tasks(rep_id, source_type, source_id)
  WHERE source = 'auto' AND status != 'dismissed';
CREATE INDEX IF NOT EXISTS idx_rep_tasks_snoozed ON rep_tasks(snoozed_until) WHERE status = 'open' AND snoozed_until IS NOT NULL;

-- ==================== Full-Text Search ====================

ALTER TABLE products ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION refresh_search_vectors(target_product_id uuid DEFAULT NULL)
RETURNS void AS $$
BEGIN
  UPDATE products p SET search_vector =
    setweight(to_tsvector('english', unaccent(coalesce(p.name, ''))), 'A') ||
    setweight(to_tsvector('english', unaccent(coalesce(p.collection, ''))), 'A') ||
    setweight(to_tsvector('english', unaccent(coalesce(v.name, ''))), 'B') ||
    setweight(to_tsvector('english', unaccent(coalesce(
      (SELECT c.name FROM categories c WHERE c.id = p.category_id), ''))), 'B') ||
    -- Variant names (e.g. "French Oak Natural") at weight B
    setweight(to_tsvector('english', unaccent(coalesce(
      (SELECT string_agg(DISTINCT s.variant_name, ' ')
       FROM skus s WHERE s.product_id = p.id AND s.status = 'active'
       AND s.variant_name IS NOT NULL AND s.variant_name != ''), ''))), 'B') ||
    -- SKU codes as literal tokens (no stemming) at weight B
    setweight(to_tsvector('simple', coalesce(
      (SELECT string_agg(DISTINCT coalesce(s.vendor_sku, '') || ' ' || coalesce(s.internal_sku, ''), ' ')
       FROM skus s WHERE s.product_id = p.id AND s.status = 'active'), '')), 'B') ||
    -- Product tags at weight B
    setweight(to_tsvector('english', unaccent(coalesce(
      (SELECT string_agg(td.name, ' ')
       FROM product_tags pt JOIN tag_definitions td ON td.id = pt.tag_id
       WHERE pt.product_id = p.id), ''))), 'B') ||
    setweight(to_tsvector('english', unaccent(coalesce(p.description_short, ''))), 'C') ||
    setweight(to_tsvector('english', unaccent(coalesce(
      (SELECT string_agg(DISTINCT sa.value, ' ')
       FROM skus s JOIN sku_attributes sa ON sa.sku_id = s.id
       WHERE s.product_id = p.id AND s.status = 'active'), ''))), 'D')
  FROM vendors v
  WHERE v.id = p.vendor_id
    AND (target_product_id IS NULL OR p.id = target_product_id);
END;
$$ LANGUAGE plpgsql;

CREATE INDEX IF NOT EXISTS idx_products_search_vector ON products USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING GIN(name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_collection_trgm ON products USING GIN(collection gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_categories_name_trgm ON categories USING GIN(name gin_trgm_ops);

-- ==================== SKU Code Search Indexes ====================

CREATE INDEX IF NOT EXISTS idx_skus_vendor_sku_trgm ON skus USING GIN(vendor_sku gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_skus_internal_sku_trgm ON skus USING GIN(internal_sku gin_trgm_ops);

-- ==================== Product Popularity (materialized view) ====================

CREATE MATERIALIZED VIEW IF NOT EXISTS product_popularity AS
  WITH view_counts AS (
    SELECT s.product_id, COUNT(*) as views
    FROM analytics_events ae
    JOIN skus s ON s.id = (ae.properties->>'sku_id')::uuid
    WHERE ae.event_type = 'product_view'
      AND ae.properties->>'sku_id' IS NOT NULL
      AND ae.created_at > NOW() - INTERVAL '90 days'
    GROUP BY s.product_id
  ),
  order_counts AS (
    SELECT oi.product_id, COUNT(*) as orders
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.product_id IS NOT NULL
      AND o.created_at > NOW() - INTERVAL '180 days'
    GROUP BY oi.product_id
  )
  SELECT p.id as product_id,
    COALESCE(LN(1 + COALESCE(vc.views, 0)), 0) + COALESCE(LN(1 + COALESCE(oc.orders, 0)), 0) * 3.0 as popularity_score
  FROM products p
  LEFT JOIN view_counts vc ON vc.product_id = p.id
  LEFT JOIN order_counts oc ON oc.product_id = p.id
  WHERE p.status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_popularity_id ON product_popularity(product_id);

-- ==================== Search Vocabulary (materialized view for did-you-mean) ====================

CREATE MATERIALIZED VIEW IF NOT EXISTS search_vocabulary AS
  SELECT DISTINCT LOWER(term) as term FROM (
    -- Product names (split into words)
    SELECT UNNEST(string_to_array(LOWER(name), ' ')) as term FROM products WHERE status = 'active'
    UNION
    -- Collection names (split into words)
    SELECT UNNEST(string_to_array(LOWER(collection), ' ')) as term FROM products WHERE status = 'active' AND collection != ''
    UNION
    -- Category names (split into words)
    SELECT UNNEST(string_to_array(LOWER(name), ' ')) as term FROM categories
    UNION
    -- Vendor names (split into words)
    SELECT UNNEST(string_to_array(LOWER(name), ' ')) as term FROM vendors
    UNION
    -- Variant names (split into words)
    SELECT UNNEST(string_to_array(LOWER(variant_name), ' ')) as term FROM skus WHERE status = 'active' AND variant_name IS NOT NULL AND variant_name != ''
    UNION
    -- Attribute values (split into words)
    SELECT UNNEST(string_to_array(LOWER(value), ' ')) as term FROM sku_attributes
  ) raw_terms
  WHERE LENGTH(term) >= 3 AND term ~ '^[a-z]+$';

CREATE UNIQUE INDEX IF NOT EXISTS idx_search_vocabulary_term ON search_vocabulary(term);
CREATE INDEX IF NOT EXISTS idx_search_vocabulary_trgm ON search_vocabulary USING GIN(term gin_trgm_ops);

-- ==================== Search Synonyms Table ====================

CREATE TABLE IF NOT EXISTS search_synonyms (
    id SERIAL PRIMARY KEY,
    term VARCHAR(100) NOT NULL UNIQUE,
    expansion TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==================== Product Tags ====================

CREATE TABLE IF NOT EXISTS tag_definitions (
    id SERIAL PRIMARY KEY,
    slug VARCHAR(80) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(40) NOT NULL,
    icon VARCHAR(40),
    display_order INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS product_tags (
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    tag_id INT REFERENCES tag_definitions(id) ON DELETE CASCADE,
    PRIMARY KEY (product_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_product_tags_tag ON product_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_product_tags_product ON product_tags(product_id);

-- Seed tag definitions
INSERT INTO tag_definitions (slug, name, category, display_order) VALUES
  -- Features
  ('waterproof', 'Waterproof', 'feature', 1),
  ('water-resistant', 'Water Resistant', 'feature', 2),
  ('pet-friendly', 'Pet Friendly', 'feature', 3),
  ('scratch-resistant', 'Scratch Resistant', 'feature', 4),
  ('stain-resistant', 'Stain Resistant', 'feature', 5),
  ('slip-resistant', 'Slip Resistant', 'feature', 6),
  ('fade-resistant', 'Fade Resistant', 'feature', 7),
  ('radiant-heat-compatible', 'Radiant Heat Compatible', 'feature', 8),
  ('commercial-grade', 'Commercial Grade', 'feature', 9),
  ('eco-friendly', 'Eco Friendly', 'feature', 10),
  ('low-maintenance', 'Low Maintenance', 'feature', 11),
  ('soundproof', 'Soundproof', 'feature', 12),
  -- Rooms
  ('bathroom', 'Bathroom', 'room', 1),
  ('kitchen', 'Kitchen', 'room', 2),
  ('living-room', 'Living Room', 'room', 3),
  ('bedroom', 'Bedroom', 'room', 4),
  ('basement', 'Basement', 'room', 5),
  ('outdoor', 'Outdoor', 'room', 6),
  ('shower', 'Shower', 'room', 7),
  ('entryway', 'Entryway', 'room', 8),
  ('laundry-room', 'Laundry Room', 'room', 9),
  ('commercial-space', 'Commercial Space', 'room', 10),
  -- Styles
  ('modern', 'Modern', 'style', 1),
  ('traditional', 'Traditional', 'style', 2),
  ('rustic', 'Rustic', 'style', 3),
  ('farmhouse', 'Farmhouse', 'style', 4),
  ('contemporary', 'Contemporary', 'style', 5),
  ('minimalist', 'Minimalist', 'style', 6),
  ('mediterranean', 'Mediterranean', 'style', 7),
  -- Install methods
  ('click-lock', 'Click Lock', 'install', 1),
  ('glue-down', 'Glue Down', 'install', 2),
  ('nail-down', 'Nail Down', 'install', 3),
  ('peel-and-stick', 'Peel and Stick', 'install', 4),
  ('floating', 'Floating', 'install', 5),
  ('diy-friendly', 'DIY Friendly', 'install', 6)
ON CONFLICT (slug) DO NOTHING;

-- Installation attributes
INSERT INTO attributes (name, slug, display_order, is_filterable) VALUES
  ('Installation Method', 'installation_method', 50, true),
  ('Subfloor Requirements', 'subfloor_requirements', 51, false),
  ('Acclimation Time', 'acclimation_time', 52, false),
  ('Expansion Gap', 'expansion_gap', 54, false),
  ('Radiant Heat Compatible', 'radiant_heat', 55, true)
ON CONFLICT (slug) DO NOTHING;

-- Additional product attributes (enrichment)
INSERT INTO attributes (name, slug, display_order, is_filterable) VALUES
  ('Wear Layer', 'wear_layer', 15, true),
  ('Certification', 'certification', 16, false),
  ('Rectified', 'rectified', 17, false),
  ('Edge Type', 'edge_type', 18, false),
  ('Core Type', 'core_type', 19, true),
  ('Style', 'style', 20, false),
  ('Pattern', 'pattern', 21, false),
  ('Weight', 'weight', 22, false),
  ('Width', 'width', 23, false),
  ('Species', 'species', 24, true),
  ('UPC', 'upc', 25, false),
  ('Fiber', 'fiber', 26, true),
  ('Construction', 'construction', 27, false),
  ('Color Code', 'color_code', 28, false),
  ('Roll Width', 'roll_width', 29, false),
  ('Roll Length', 'roll_length', 30, false),
  ('Weight per Sq Yd', 'weight_per_sqyd', 31, false),
  ('Collection', 'collection', 32, false)
ON CONFLICT (slug) DO NOTHING;

-- Seed additional synonyms (beyond the hardcoded ones in server.js)
INSERT INTO search_synonyms (term, expansion) VALUES
  ('bathroom flooring', 'waterproof vinyl porcelain tile bathroom'),
  ('kitchen flooring', 'porcelain tile hardwood vinyl kitchen'),
  ('outdoor tile', 'outdoor porcelain paver exterior'),
  ('shower tile', 'shower porcelain mosaic wall tile waterproof'),
  ('pool tile', 'pool porcelain mosaic outdoor waterproof'),
  ('fireplace tile', 'fireplace tile porcelain natural stone marble'),
  ('stair nosing', 'stair nose trim molding'),
  ('grey', 'gray grey'),
  ('gray', 'gray grey'),
  ('beige', 'beige cream sand'),
  ('white marble', 'calacatta carrara white marble porcelain'),
  ('dark wood', 'dark walnut espresso wood hardwood engineered'),
  ('light wood', 'light oak natural blonde wood hardwood engineered'),
  ('rustic', 'rustic distressed reclaimed hand scraped'),
  ('modern', 'modern contemporary sleek porcelain large format'),
  ('large format', 'large format 24x24 24x48 36x36'),
  ('small tile', 'mosaic small tile 2x2 4x4'),
  ('matte', 'matte finish'),
  ('polished', 'polished finish glossy'),
  ('textured', 'textured finish brushed'),
  ('plank', 'plank vinyl hardwood engineered laminate'),
  ('wide plank', 'wide plank 7 inch hardwood engineered'),
  ('narrow plank', 'narrow plank 3 inch 4 inch strip'),
  ('click', 'click lock floating'),
  ('floating floor', 'floating floor click lock'),
  ('peel and stick', 'peel stick self adhesive'),
  ('commercial', 'commercial grade heavy duty high traffic'),
  ('residential', 'residential home interior'),
  ('pet friendly', 'pet friendly scratch resistant waterproof'),
  ('soundproof', 'sound proof acoustic underlayment cork'),
  ('heated floor', 'radiant heat compatible'),
  ('thick', 'thick heavy duty 12mm 14mm'),
  ('thin', 'thin 6mm 8mm overlay'),
  ('cheap', 'budget affordable value'),
  ('premium', 'premium luxury high end designer'),
  ('italian', 'italian italy imported marble porcelain'),
  ('spanish', 'spanish spain imported porcelain'),
  ('brazilian', 'brazilian brazil exotic hardwood'),
  ('countertop', 'countertop slab quartz marble granite'),
  ('grout', 'grout sealant caulk'),
  ('adhesive', 'adhesive mortar thinset glue')
ON CONFLICT (term) DO NOTHING;

-- ==================== PIM Data Governance ====================

-- 1. CHECK constraints on enum-like columns
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_status_check;
ALTER TABLE products ADD CONSTRAINT products_status_check
  CHECK (status IN ('draft', 'active', 'inactive', 'discontinued'));

ALTER TABLE skus DROP CONSTRAINT IF EXISTS skus_status_check;
ALTER TABLE skus ADD CONSTRAINT skus_status_check
  CHECK (status IN ('active', 'draft', 'inactive'));

ALTER TABLE skus DROP CONSTRAINT IF EXISTS skus_sell_by_check;
ALTER TABLE skus ADD CONSTRAINT skus_sell_by_check
  CHECK (sell_by IN ('sqft', 'unit', 'sqyd'));

ALTER TABLE skus DROP CONSTRAINT IF EXISTS skus_variant_type_check;
ALTER TABLE skus ADD CONSTRAINT skus_variant_type_check
  CHECK (variant_type IS NULL OR variant_type IN ('accessory', 'floor_tile', 'wall_tile', 'mosaic', 'lvt', 'quarry_tile', 'stone_tile', 'floor_deco'));

ALTER TABLE pricing DROP CONSTRAINT IF EXISTS pricing_price_basis_check;
ALTER TABLE pricing ADD CONSTRAINT pricing_price_basis_check
  CHECK (price_basis IN ('per_sqft', 'per_unit', 'per_sqyd', 'sqft', 'unit'));

ALTER TABLE pricing DROP CONSTRAINT IF EXISTS pricing_cost_positive;
ALTER TABLE pricing ADD CONSTRAINT pricing_cost_positive CHECK (cost >= 0);

ALTER TABLE pricing DROP CONSTRAINT IF EXISTS pricing_retail_positive;
ALTER TABLE pricing ADD CONSTRAINT pricing_retail_positive CHECK (retail_price >= 0);

ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_type_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_type_check
  CHECK (asset_type IN ('primary', 'alternate', 'lifestyle', 'spec_pdf', 'swatch'));

-- 2. Attribute governance: required attributes per category
CREATE TABLE IF NOT EXISTS category_required_attributes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category_slug TEXT NOT NULL,
    attribute_slug TEXT NOT NULL,
    is_required BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(category_slug, attribute_slug)
);

-- Seed governance rules
INSERT INTO category_required_attributes (category_slug, attribute_slug, is_required) VALUES
  -- Tile categories require: color, size, finish, material
  ('porcelain-tile', 'color', true), ('porcelain-tile', 'size', true), ('porcelain-tile', 'finish', true), ('porcelain-tile', 'material', true),
  ('ceramic-tile', 'color', true), ('ceramic-tile', 'size', true), ('ceramic-tile', 'finish', true), ('ceramic-tile', 'material', true),
  ('mosaic-tile', 'color', true), ('mosaic-tile', 'size', true), ('mosaic-tile', 'finish', true),
  ('natural-stone', 'color', true), ('natural-stone', 'size', true), ('natural-stone', 'finish', true), ('natural-stone', 'material', true),
  ('backsplash-tile', 'color', true), ('backsplash-tile', 'size', true), ('backsplash-tile', 'finish', true),
  ('wood-look-tile', 'color', true), ('wood-look-tile', 'size', true), ('wood-look-tile', 'finish', true),
  ('pool-tile', 'color', true), ('pool-tile', 'size', true),
  ('large-format-tile', 'color', true), ('large-format-tile', 'size', true), ('large-format-tile', 'finish', true),
  -- Hardwood categories require: color, species, finish, thickness
  ('engineered-hardwood', 'color', true), ('engineered-hardwood', 'species', true), ('engineered-hardwood', 'finish', true), ('engineered-hardwood', 'thickness', true),
  ('solid-hardwood', 'color', true), ('solid-hardwood', 'species', true), ('solid-hardwood', 'finish', true), ('solid-hardwood', 'thickness', true),
  ('hardwood', 'color', true), ('hardwood', 'species', true), ('hardwood', 'finish', true),
  -- LVP/Vinyl require: color, thickness, wear_layer, core_type
  ('luxury-vinyl', 'color', true), ('luxury-vinyl', 'thickness', true), ('luxury-vinyl', 'wear_layer', true),
  ('lvp-plank', 'color', true), ('lvp-plank', 'thickness', true), ('lvp-plank', 'wear_layer', true),
  ('waterproof-wood', 'color', true), ('waterproof-wood', 'thickness', true),
  -- Laminate requires: color, thickness
  ('laminate', 'color', true), ('laminate', 'thickness', true),
  ('laminate-flooring', 'color', true), ('laminate-flooring', 'thickness', true),
  -- Carpet requires: color, fiber
  ('carpet', 'color', true), ('carpet', 'fiber', true),
  ('carpet-tile', 'color', true), ('carpet-tile', 'fiber', true),
  -- Countertops require: color, finish
  ('countertops', 'color', true), ('countertops', 'finish', true),
  ('quartz-countertops', 'color', true), ('quartz-countertops', 'finish', true),
  ('granite-countertops', 'color', true), ('granite-countertops', 'finish', true),
  ('marble-countertops', 'color', true), ('marble-countertops', 'finish', true)
ON CONFLICT (category_slug, attribute_slug) DO NOTHING;

-- 3. Search vector auto-refresh trigger
CREATE OR REPLACE FUNCTION trigger_refresh_search_vector()
RETURNS trigger AS $$
BEGIN
  -- Determine which product_id to refresh
  IF TG_TABLE_NAME = 'products' THEN
    PERFORM refresh_search_vectors(NEW.id);
  ELSIF TG_TABLE_NAME = 'skus' THEN
    PERFORM refresh_search_vectors(NEW.product_id);
    -- If product_id changed, also refresh the old product
    IF TG_OP = 'UPDATE' AND OLD.product_id IS DISTINCT FROM NEW.product_id THEN
      PERFORM refresh_search_vectors(OLD.product_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'sku_attributes' THEN
    PERFORM refresh_search_vectors(
      (SELECT product_id FROM skus WHERE id = NEW.sku_id)
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger on products: refresh when name, collection, category, or description changes
DROP TRIGGER IF EXISTS trg_products_search_vector ON products;
CREATE TRIGGER trg_products_search_vector
  AFTER UPDATE OF name, collection, category_id, description_short ON products
  FOR EACH ROW EXECUTE FUNCTION trigger_refresh_search_vector();

-- Trigger on skus: refresh when variant_name or status changes
DROP TRIGGER IF EXISTS trg_skus_search_vector ON skus;
CREATE TRIGGER trg_skus_search_vector
  AFTER INSERT OR UPDATE OF variant_name, status, product_id ON skus
  FOR EACH ROW EXECUTE FUNCTION trigger_refresh_search_vector();

-- Trigger on sku_attributes: refresh when attribute values change
DROP TRIGGER IF EXISTS trg_sku_attributes_search_vector ON sku_attributes;
CREATE TRIGGER trg_sku_attributes_search_vector
  AFTER INSERT OR UPDATE OF value ON sku_attributes
  FOR EACH ROW EXECUTE FUNCTION trigger_refresh_search_vector();

-- 4. Product/SKU status cascade triggers

-- When a product is deactivated, cascade to all its SKUs
CREATE OR REPLACE FUNCTION cascade_product_deactivation()
RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('inactive', 'discontinued') AND OLD.status NOT IN ('inactive', 'discontinued') THEN
    UPDATE skus SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
    WHERE product_id = NEW.id AND status = 'active';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cascade_product_status ON products;
CREATE TRIGGER trg_cascade_product_status
  AFTER UPDATE OF status ON products
  FOR EACH ROW
  WHEN (NEW.status IN ('inactive', 'discontinued'))
  EXECUTE FUNCTION cascade_product_deactivation();

-- When the last active SKU on a product is deactivated, auto-deactivate the product
CREATE OR REPLACE FUNCTION cascade_sku_deactivation()
RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('inactive', 'draft') AND OLD.status = 'active' THEN
    IF (SELECT COUNT(*) FROM skus WHERE product_id = NEW.product_id AND status = 'active' AND id != NEW.id) = 0 THEN
      UPDATE products SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
      WHERE id = NEW.product_id AND status = 'active';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cascade_sku_status ON skus;
CREATE TRIGGER trg_cascade_sku_status
  AFTER UPDATE OF status ON skus
  FOR EACH ROW
  WHEN (NEW.status IN ('inactive', 'draft') AND OLD.status = 'active')
  EXECUTE FUNCTION cascade_sku_deactivation();

-- 5. SKU quality score materialized view
CREATE MATERIALIZED VIEW IF NOT EXISTS sku_quality_scores AS
  SELECT
    s.id AS sku_id,
    s.internal_sku,
    s.vendor_sku,
    p.id AS product_id,
    p.name AS product_name,
    p.collection,
    v.name AS vendor_name,
    v.code AS vendor_code,
    c.slug AS category_slug,
    c.name AS category_name,
    -- Individual scores (0 or 1)
    CASE WHEN EXISTS (
      SELECT 1 FROM media_assets ma
      WHERE (ma.sku_id = s.id OR (ma.product_id = p.id AND ma.sku_id IS NULL))
        AND ma.asset_type = 'primary'
    ) THEN 1 ELSE 0 END AS has_image,
    CASE WHEN pr.cost IS NOT NULL AND pr.cost > 0 THEN 1 ELSE 0 END AS has_cost,
    CASE WHEN pr.retail_price IS NOT NULL AND pr.retail_price > 0 THEN 1 ELSE 0 END AS has_retail,
    CASE WHEN pk.sqft_per_box IS NOT NULL OR s.sell_by = 'unit' THEN 1 ELSE 0 END AS has_packaging,
    CASE WHEN p.description_short IS NOT NULL AND LENGTH(p.description_short) > 10 THEN 1 ELSE 0 END AS has_description,
    CASE WHEN (
      SELECT COUNT(*) FROM sku_attributes sa WHERE sa.sku_id = s.id
    ) >= 2 THEN 1 ELSE 0 END AS has_attributes,
    CASE WHEN EXISTS (
      SELECT 1 FROM sku_attributes sa
      JOIN attributes a ON a.id = sa.attribute_id AND a.slug = 'color'
      WHERE sa.sku_id = s.id
    ) THEN 1 ELSE 0 END AS has_color,
    -- Missing required attributes count
    (SELECT COUNT(*)::int FROM category_required_attributes cra
     WHERE cra.category_slug = c.slug
       AND cra.is_required = true
       AND NOT EXISTS (
         SELECT 1 FROM sku_attributes sa
         JOIN attributes a ON a.id = sa.attribute_id
         WHERE sa.sku_id = s.id AND a.slug = cra.attribute_slug
       )
    ) AS missing_required_attrs,
    -- Total required attributes for this category
    (SELECT COUNT(*)::int FROM category_required_attributes cra
     WHERE cra.category_slug = c.slug AND cra.is_required = true
    ) AS total_required_attrs,
    -- Composite quality score (0-100)
    (
      (CASE WHEN EXISTS (SELECT 1 FROM media_assets ma WHERE (ma.sku_id = s.id OR (ma.product_id = p.id AND ma.sku_id IS NULL)) AND ma.asset_type = 'primary') THEN 25 ELSE 0 END) +
      (CASE WHEN pr.cost IS NOT NULL AND pr.cost > 0 THEN 20 ELSE 0 END) +
      (CASE WHEN pr.retail_price IS NOT NULL AND pr.retail_price > 0 THEN 15 ELSE 0 END) +
      (CASE WHEN pk.sqft_per_box IS NOT NULL OR s.sell_by = 'unit' THEN 10 ELSE 0 END) +
      (CASE WHEN p.description_short IS NOT NULL AND LENGTH(p.description_short) > 10 THEN 10 ELSE 0 END) +
      (CASE WHEN (SELECT COUNT(*) FROM sku_attributes sa WHERE sa.sku_id = s.id) >= 2 THEN 10 ELSE 0 END) +
      -- Required attributes score: 10 points proportional to how many are present
      (CASE WHEN (SELECT COUNT(*) FROM category_required_attributes cra WHERE cra.category_slug = c.slug AND cra.is_required = true) = 0 THEN 10
            ELSE (10.0 * (
              (SELECT COUNT(*) FROM category_required_attributes cra
               WHERE cra.category_slug = c.slug AND cra.is_required = true
               AND EXISTS (SELECT 1 FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id WHERE sa.sku_id = s.id AND a.slug = cra.attribute_slug))
              ::float /
              GREATEST((SELECT COUNT(*) FROM category_required_attributes cra WHERE cra.category_slug = c.slug AND cra.is_required = true), 1)
            ))::int
       END)
    ) AS quality_score
  FROM skus s
  JOIN products p ON p.id = s.product_id
  JOIN vendors v ON v.id = p.vendor_id
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN pricing pr ON pr.sku_id = s.id
  LEFT JOIN packaging pk ON pk.sku_id = s.id
  WHERE s.status = 'active' AND p.status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_sku_quality_scores_sku ON sku_quality_scores(sku_id);
CREATE INDEX IF NOT EXISTS idx_sku_quality_scores_score ON sku_quality_scores(quality_score);
CREATE INDEX IF NOT EXISTS idx_sku_quality_scores_vendor ON sku_quality_scores(vendor_code);

-- ==================== AI Enrichment ====================

CREATE TABLE IF NOT EXISTS enrichment_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_type VARCHAR(30) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    scope JSONB DEFAULT '{}',
    triggered_by VARCHAR(30) DEFAULT 'manual',
    scrape_job_id UUID REFERENCES scrape_jobs(id),
    total_items INT DEFAULT 0,
    processed_items INT DEFAULT 0,
    skipped_items INT DEFAULT 0,
    failed_items INT DEFAULT 0,
    updated_items INT DEFAULT 0,
    prompt_tokens_used INT DEFAULT 0,
    completion_tokens_used INT DEFAULT 0,
    estimated_cost_usd DECIMAL(10,6) DEFAULT 0,
    errors JSONB DEFAULT '[]',
    log TEXT DEFAULT '',
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_status ON enrichment_jobs(status);
CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_type ON enrichment_jobs(job_type);

CREATE TABLE IF NOT EXISTS enrichment_results (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    enrichment_job_id UUID REFERENCES enrichment_jobs(id) NOT NULL,
    entity_type VARCHAR(20) NOT NULL,
    entity_id UUID NOT NULL,
    field_name TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    confidence DECIMAL(3,2),
    status VARCHAR(20) DEFAULT 'applied',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_enrichment_results_job ON enrichment_results(enrichment_job_id);
CREATE INDEX IF NOT EXISTS idx_enrichment_results_status ON enrichment_results(status) WHERE status = 'pending_review';
