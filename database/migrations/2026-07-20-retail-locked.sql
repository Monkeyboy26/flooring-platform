-- Freeze manually-set retail prices (e.g. Home-Depot-matched MSI LVP) so scrapes,
-- imports, and the keystone guard in scrapers/base.js can't overwrite them.
ALTER TABLE pricing ADD COLUMN IF NOT EXISTS retail_locked BOOLEAN DEFAULT false;
-- base.js upsertPricing preserves retail_price when retail_locked = true.
-- The MSI LVP HD prices themselves are data (see backend/data/msi-hd-lvp-prices.tsv,
-- matched by internal_sku) and are applied per-environment, not via this schema migration.
