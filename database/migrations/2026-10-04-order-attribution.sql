-- Order acquisition-source tracking (2026-10-04)
-- acquisition_source: queryable classification (google-organic, google-shopping,
--   google-ads, email, social, ai-assistant, referral:<host>, direct, rep,
--   trade-portal). NULL = order predates tracking ("untracked" in reports).
-- attribution: raw first/last-touch blobs the storefront captured
--   ({landing, referrer, utm_*, gclid, srsltid, ts}).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS acquisition_source TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS attribution JSONB;
