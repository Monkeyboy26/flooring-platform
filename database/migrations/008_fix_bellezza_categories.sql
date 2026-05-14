-- Migration 008: Fix Bellezza Ceramica product categories
--
-- 10 products have incorrect category assignments:
--
--   Gio (caa50695): "Wood Look Tile" → "Mosaic Tile"
--     All SKUs are hexagon (4x4, 2x2) and stacked linear (.82x2.8, .86x5.7, 1.26x5.7)
--     mosaics. Description says "Glazed Porcelain Mosaic, Pool Rated".
--
--   Puccini (59cae30c): "Wood Look Tile" → "Porcelain Tile"
--     All SKUs are 12x24, 24x24, 24x48 marble-look porcelain tiles.
--     Was in wrong collection too (fixed in migration 007).
--
--   Vilema (d74cb332): "Backsplash & Wall Tile" → "Wood Look Tile"
--     SKUs are 9.25x47.25 wood-look porcelain floor tiles. Description says
--     "Wood Look Porcelain". Collection is "Wood Look".
--
--   Antwerp (f517e56f), Camden (b63d8738), Grande (fe1c74ad),
--   Hudson (8731c62b), Nord (fa34ccc9), Park (236dd145):
--     "Porcelain Tile" → "Mosaic Tile"
--     All are 100% Recycled Glass mosaic sheets (single "Sheet" SKU each).
--     Description says "100% Recycled Glass, Pool Rated".
--
--   WG001 (060b553a): "Mosaic Tile" → "Porcelain Tile"
--     SKUs are 12x24, 24x24, 32x32 polished/matte porcelain tiles.
--     The 2x2 mosaic is an accessory variant. Despite "Recycled Glass" collection,
--     the main product is standard porcelain.
--
-- Run: docker exec -i flooring-db psql -U postgres -d flooring_pim < database/migrations/008_fix_bellezza_categories.sql

BEGIN;

-- =============================================================================
-- FIX 1: Gio — Wood Look Tile → Mosaic Tile
-- =============================================================================

UPDATE products
SET category_id = '650e8400-e29b-41d4-a716-446655440014'  -- Mosaic Tile
WHERE id = 'caa50695-56ff-4c5c-a748-a8b6ec99f521';

-- =============================================================================
-- FIX 2: Puccini — Wood Look Tile → Porcelain Tile
-- =============================================================================

UPDATE products
SET category_id = '650e8400-e29b-41d4-a716-446655440012'  -- Porcelain Tile
WHERE id = '59cae30c-dff0-4ac5-8470-9a8d3f4b403c';

-- =============================================================================
-- FIX 3: Vilema — Backsplash & Wall Tile → Wood Look Tile
-- =============================================================================

UPDATE products
SET category_id = '650e8400-e29b-41d4-a716-446655440015'  -- Wood Look Tile
WHERE id = 'd74cb332-2745-4395-b1ba-411b8a51b811';

-- =============================================================================
-- FIX 4: Recycled Glass mosaic sheets — Porcelain Tile → Mosaic Tile
-- Antwerp, Camden, Grande, Hudson, Nord, Park
-- =============================================================================

UPDATE products
SET category_id = '650e8400-e29b-41d4-a716-446655440014'  -- Mosaic Tile
WHERE id IN (
  'f517e56f-cebe-4c9c-924f-236e5a322aa1',  -- Antwerp
  'b63d8738-01d3-4a4b-83f2-07cfe71b7ded',  -- Camden
  'fe1c74ad-338d-4de7-b8ee-86d126619584',  -- Grande
  '8731c62b-6993-4403-9331-b31d0ce61d6f',  -- Hudson
  'fa34ccc9-cf25-40e2-bde8-2907eda01aa2',  -- Nord
  '236dd145-bf1d-4f57-b28f-f1eda8a3c922'   -- Park
);

-- =============================================================================
-- FIX 5: WG001 — Mosaic Tile → Porcelain Tile
-- =============================================================================

UPDATE products
SET category_id = '650e8400-e29b-41d4-a716-446655440012'  -- Porcelain Tile
WHERE id = '060b553a-a34d-4e4d-80e8-d083b2567f1d';

COMMIT;
