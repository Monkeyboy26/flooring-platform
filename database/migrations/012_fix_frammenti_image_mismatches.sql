-- Migration 012: Fix Frammenti per-SKU image mismatches
--
-- The Frammenti product has 3 Bellezza SKUs that all share identical images
-- due to the scraper dumping all product images onto every SKU:
--
--   R267: Azzurro Macro Matte 8x8  (sku: 4f23fe91)
--   R268: Nero Macro Matte 8x8     (sku: 24ef7cc4)
--   R272: Grigio Brick Glossy 3x16  (sku: 7f0553d2)
--
-- All 3 currently show FR-2-MACRO_2000.jpeg (Azzurro) as primary.
-- Vendor catalog (FOLDER-FRAMMENTI-FR-2810.png) confirms:
--   FR 2  = Azzurro (light grey/blue-grey base)
--   FR 8  = Nero    (dark/black base)
--   FR 10 = Grigio  (white/cream base, grey fragments)
--
-- Only FR-2, FR-8, FR-10 exist on the vendor CDN (FR-1,3-7,9,11-20 all 404).
-- No brick-format (3x16) images exist — FR-10 Macro 8x8 is the best available
-- for R272 Grigio Brick.
--
-- Fix strategy:
--   1. R267 (Azzurro): FR-2 primary is correct — no change
--   2. R268 (Nero): Swap primary from FR-2 to FR-8
--   3. R272 (Grigio): Demote FR-2 to alternate, insert FR-10 as new primary
--
-- Run: docker exec -i flooring-db psql -U postgres -d flooring_pim < database/migrations/012_fix_frammenti_image_mismatches.sql

BEGIN;

-- =============================================================================
-- FIX 1: R268 (Nero Macro Matte 8x8) — swap primary from FR-2 to FR-8
-- FR-2 (Azzurro) is wrong color; FR-8 (Nero) already exists as alternate[5]
-- =============================================================================

-- Demote FR-2 from primary to alternate
UPDATE media_assets SET asset_type = 'alternate', sort_order = 10
  WHERE id = 'b03a9ee2-2460-4f1d-8e94-2f56c259928b'; -- FR-2 (was primary)

-- Promote FR-8 from alternate to primary
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = '721aeafd-f4b8-48e9-ba7b-9647575ee3c3'; -- FR-8 (was alternate[5])

-- =============================================================================
-- FIX 2: R272 (Grigio Brick Glossy 3x16) — replace FR-2 primary with FR-10
-- FR-2 (Azzurro) is wrong color; no FR-10 image exists in DB for this SKU
-- =============================================================================

-- Demote FR-2 from primary to alternate
UPDATE media_assets SET asset_type = 'alternate', sort_order = 10
  WHERE id = 'e8ea16d6-eb8c-43ca-a012-48bc4e1beeb9'; -- FR-2 (was primary)

-- Insert FR-10 (Grigio) as new primary
INSERT INTO media_assets (product_id, sku_id, asset_type, url, sort_order, source)
VALUES (
  '2c72e62e-0153-47e1-a69d-ff8430b3b71d',
  '7f0553d2-0e85-4624-ba8e-26004781d584',
  'primary',
  'https://bellezzaceramica.com/wp-content/uploads/2022/05/FR-10-MACRO_2000.jpeg',
  0,
  'manual'
);

COMMIT;
