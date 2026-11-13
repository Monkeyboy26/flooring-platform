-- Dynamic competitive pricing (2026-11-12)
-- Monitors reputable competitor prices (anchor: Home Depot / Lowe's everyday)
-- and drives a shadow-mode repricing engine that undercuts by $0.10 while never
-- auto-pricing below the covering margin floor (cost + $1.50). See base.js
-- upsertPricing for the floor/charm rules the engine mirrors.

-- One observed competitor price per (sku, competitor). Refreshed in place by the
-- fetcher; match_status gates whether a row feeds the engine (pending rows wait
-- in the admin review queue until a human confirms the SKU<->listing match).
CREATE TABLE IF NOT EXISTS competitor_prices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sku_id UUID NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  competitor VARCHAR(40) NOT NULL,              -- 'home_depot' | 'lowes' | 'floor_decor' | ...
  competitor_sku VARCHAR(120),                  -- their model / internet number
  competitor_url TEXT,
  everyday_price DECIMAL(10,2),                 -- non-sale reference price (what we anchor to)
  sale_price DECIMAL(10,2),                     -- current promo, if any (NOT used as anchor)
  unit VARCHAR(20),                             -- normalized sell-by: 'sqft' | 'ea'
  raw_price DECIMAL(10,2),                      -- price as displayed, before unit-normalize
  raw_unit VARCHAR(20),                         -- unit as displayed (sanity / debugging)
  in_stock BOOLEAN,
  match_method VARCHAR(30),                     -- 'vendor_sku_exact' | 'model_fuzzy' | 'manual'
  match_confidence SMALLINT DEFAULT 0,          -- 0-100
  match_status VARCHAR(20) DEFAULT 'pending',   -- 'pending' | 'confirmed' | 'rejected'
  scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (sku_id, competitor)
);
CREATE INDEX IF NOT EXISTS idx_competitor_prices_sku ON competitor_prices(sku_id);
CREATE INDEX IF NOT EXISTS idx_competitor_prices_status ON competitor_prices(match_status);
CREATE INDEX IF NOT EXISTS idx_competitor_prices_stale ON competitor_prices(scraped_at);

-- Shadow-mode output: one proposal per sku per run. Durable so admin can review
-- "what would change" before we ever flip auto-apply on, and so we keep an audit
-- trail of why a price moved (reference evidence + floor).
CREATE TABLE IF NOT EXISTS reprice_proposals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id UUID NOT NULL,
  sku_id UUID NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  current_price DECIMAL(10,2),
  reference_competitor VARCHAR(40),             -- cheapest confirmed in-stock competitor used
  reference_price DECIMAL(10,2),                -- their everyday price
  target_price DECIMAL(10,2),                   -- proposed new retail (charm-rounded)
  floor_price DECIMAL(10,2),                    -- effective covering floor at run time
  action VARCHAR(20),                           -- 'cut' | 'raise' | 'hold' | 'below_floor' | 'no_match' | 'locked'
  flagged BOOLEAN DEFAULT false,
  flag_reason TEXT,
  applied BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reprice_proposals_run ON reprice_proposals(run_id);
CREATE INDEX IF NOT EXISTS idx_reprice_proposals_sku ON reprice_proposals(sku_id);
CREATE INDEX IF NOT EXISTS idx_reprice_proposals_action ON reprice_proposals(action);
