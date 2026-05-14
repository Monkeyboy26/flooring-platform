-- Migration 013: Remove cross-format alternate images from Gio SKUs
--
-- Migration 009 fixed the 21 primary image mismatches, but the scraper also
-- dumped ALL product images as alternates onto every SKU regardless of format.
-- This means Hexagon SKUs show Stacked Linear alternates and vice versa.
--
-- 128 cross-format alternates exist:
--   - 48 Stacked Linear images on Hexagon SKUs
--   - 80 Hexagon images on Stacked Linear SKUs
--
-- Affected SKUs (16 lose all alternates, 16 lose some):
--   Default/Cobalt Hexagons: all 5 alternates are Cobalt SL → all removed
--   Grey Hexagons: 4 of 5 alternates are Grey SL → 4 removed, 1 kept
--   Taupe Hexagons: 2 of 5 alternates are Taupe SL → 2 removed, 3 kept
--   Black/White SL: all 5 alternates are Black/White Hex → all removed
--   Grey SL: 2 of 5 alternates are Grey Hex → 2 removed, 3 kept
--   Taupe SL: 4 of 5 alternates are Taupe Hex → 4 removed, 1 kept
--
-- SKUs that correctly keep all alternates (no changes):
--   Black/White Hexagons, Default/Cobalt SL
--
-- Run: docker exec -i flooring-db psql -U postgres -d flooring_pim < database/migrations/013_fix_gio_cross_format_alternates.sql

BEGIN;

-- =============================================================================
-- Delete all cross-format alternate images from Gio SKUs
-- Format detection: filename contains "Hexagon" or "Stacked-Linear"/"1.26x5.7"
-- =============================================================================

DELETE FROM media_assets
WHERE id IN (
  SELECT m.id
  FROM media_assets m
  JOIN skus s ON s.id = m.sku_id
  JOIN products p ON p.id = s.product_id
  WHERE p.name = 'Gio'
    AND m.asset_type = 'alternate'
    AND (
      -- Hexagon SKU with Stacked Linear alternate image
      (s.variant_name LIKE '%Hexagon%'
       AND (m.url LIKE '%Stacked-Linear%' OR m.url LIKE '%1.26x5.7%'))
      OR
      -- Stacked Linear SKU with Hexagon alternate image
      (s.variant_name LIKE '%Stacked Linear%'
       AND m.url LIKE '%Hexagon%')
    )
);

COMMIT;
