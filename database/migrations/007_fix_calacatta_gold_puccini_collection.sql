-- Migration 007: Fix Calacatta Gold description and Puccini collection assignment
--
-- Calacatta Gold (e996358d): description_short incorrectly says "mosaic tile"
-- but R114/R115 are 24x48 and 15.75x47.24 large-format porcelain tiles.
-- This wrong description causes them to appear in "mosaic" search results.
--
-- Puccini (59cae30c): collection is "Hexagon & Mosaic" but 19 of 20 SKUs are
-- standard porcelain tiles (12x24, 24x24, 24x48). Only BLZ-R304 (Mosaic 2x2)
-- is a mosaic, and it's an accessory variant. The product belongs in "Marble Look".
--
-- Run: docker exec -i flooring-db psql -U postgres -d flooring_pim < database/migrations/007_fix_calacatta_gold_puccini_collection.sql

BEGIN;

-- =============================================================================
-- FIX 1: Calacatta Gold — fix description_short from "mosaic tile" to "porcelain tile"
-- =============================================================================

UPDATE products
SET description_short = 'The Calacatta Gold is a porcelain tile from the Bellezza Ceramica collection.'
WHERE id = 'e996358d-c465-49c7-bebc-6ac0a05631ba';

-- =============================================================================
-- FIX 2: Puccini — move from "Hexagon & Mosaic" to "Marble Look"
-- =============================================================================

UPDATE products
SET collection = 'Marble Look'
WHERE id = '59cae30c-dff0-4ac5-8470-9a8d3f4b403c';

COMMIT;
