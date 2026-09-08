-- SEO Phase 0 — data foundations (idempotent; safe to re-run)
-- Mirrors the CREATE TABLE additions in schema.sql for the live database.

-- categories: landing-page SEO copy
ALTER TABLE categories ADD COLUMN IF NOT EXISTS meta_title       TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS meta_description TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS intro_html       TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS footer_html      TEXT;

-- products: AI content-engine fields
ALTER TABLE products ADD COLUMN IF NOT EXISTS meta_title       TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS meta_description TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS seo_h1           TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS content_html     TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS content_status   VARCHAR(20) NOT NULL DEFAULT 'none';
ALTER TABLE products ADD COLUMN IF NOT EXISTS content_hash     TEXT;
DO $$ BEGIN
    ALTER TABLE products ADD CONSTRAINT products_content_status_check
        CHECK (content_status IN ('none', 'generated', 'reviewed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- media_assets: alt text
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS alt_text TEXT;

-- landing_pages (programmatic pillar/facet pages)
CREATE TABLE IF NOT EXISTS landing_pages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type VARCHAR(30) NOT NULL
        CHECK (type IN ('facet', 'material', 'brand', 'room', 'guide')),
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    h1 TEXT,
    meta_title TEXT,
    meta_description TEXT,
    intro_html TEXT,
    footer_html TEXT,
    filter_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_indexable BOOLEAN NOT NULL DEFAULT false,
    product_count INTEGER NOT NULL DEFAULT 0,
    content_status VARCHAR(20) NOT NULL DEFAULT 'none'
        CHECK (content_status IN ('none', 'generated', 'reviewed')),
    content_hash TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_landing_pages_type ON landing_pages(type);
CREATE INDEX IF NOT EXISTS idx_landing_pages_indexable ON landing_pages(is_indexable) WHERE is_indexable = true;

-- NOTE: product_reviews already exists (customer-authored). Phase 3 extends it for
-- aggregateRating; no changes to it in Phase 0.
