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
    sort_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id UUID REFERENCES vendors(id),
    name TEXT NOT NULL,
    collection TEXT,
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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE pricing (
    sku_id UUID PRIMARY KEY REFERENCES skus(id),
    cost DECIMAL(10,2) NOT NULL,
    retail_price DECIMAL(10,2) NOT NULL,
    price_basis VARCHAR(20),
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
    is_sample BOOLEAN DEFAULT false
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

ALTER TABLE products ADD CONSTRAINT products_vendor_name_unique UNIQUE (vendor_id, name);

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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT media_assets_unique UNIQUE (product_id, asset_type, sort_order)
);
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
    approved_by UUID REFERENCES sales_reps(id),
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
