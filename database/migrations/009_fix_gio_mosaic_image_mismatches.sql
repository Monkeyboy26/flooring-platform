-- Migration 009: Fix Gio mosaic SKU-to-image format mismatches
--
-- The Gio product has 48 SKUs across 6 colors × 8 formats (Hex 4x4, Hex 2x2,
-- Glossy Hex 2x2, plus 5 Stacked Linear sizes). The scraper dumped each color's
-- images onto every format variant, causing 21 primary image mismatches:
--
--   - Hexagon SKUs showing Stacked Linear images (8 SKUs)
--   - Hexagon 4x4 SKUs showing Hex 2x2 images (3 SKUs)
--   - Hexagon 2x2 SKUs showing Hex 4x4 images (2 SKUs)
--   - Stacked Linear SKUs showing Hexagon images (10 SKUs)
--
-- Fix strategy:
--   1. Swap primaries where correct-format image exists as alternate on same SKU
--   2. For SKUs with no correct-format image, update primary URL to best match:
--      - Default (no color) hexagons → use best-match color hexagon image
--      - Cobalt hexagons → use Grey/Taupe hex (no Cobalt hex images exist)
--      - Black stacked linears → use Cobalt stacked linear (no Black SL exists)
--      - White stacked linears → use Grey stacked linear (no White SL exists)
--
-- Run: docker exec -i flooring-db psql -U postgres -d flooring_pim < database/migrations/009_fix_gio_mosaic_image_mismatches.sql

BEGIN;

-- =============================================================================
-- FIX 1: R255-BLAC (Black Matte Hexagon 4x4) — swap primary from 2x2 to 4x4
-- Has Hex-4x4-1.jpg as alternate[3], should be primary
-- =============================================================================

UPDATE media_assets SET asset_type = 'alternate', sort_order = 10
  WHERE id = '2877a9c7-d44b-4fb7-bc37-920752d73786'; -- Hex-2x2-1 (was primary)

UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = '2726e36f-d8a1-4924-95eb-d3eff1621466'; -- Hex-4x4-1 (was alt[3])

-- =============================================================================
-- FIX 2: R256-WHIT (White Matte Hexagon 2x2) — swap Glossy primary to Matte
-- Has Matte-Hex-2x2-1.jpg as alternate[3], better match for Matte SKU
-- =============================================================================

UPDATE media_assets SET asset_type = 'alternate', sort_order = 10
  WHERE id = '27857ab1-0f34-41f9-b995-c4306f10e9dc'; -- Glossy-Hex-2x2-1 (was primary)

UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = 'ac3be6ea-3a77-464a-94bd-d063e10955bb'; -- Matte-Hex-2x2-1 (was alt[3])

-- =============================================================================
-- FIX 3: Default (no color) Hexagon SKUs — showing Cobalt Stacked Linear
-- No hexagon images exist for default/Cobalt. Use representative hex images.
-- =============================================================================

-- R255 (Matte Hexagon 4x4): Cobalt-SL → Grey-Hex-4x4 (only color with 4x4)
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Grey-Matte-Hexagon-4x4-1.jpg'
  WHERE id = '5a05af02-a710-441a-bdd6-43a0a68f4eb8';

-- R256 (Matte Hexagon 2x2): Cobalt-SL → Taupe-Hex-2x2
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Taupe-Matte-Hexagon-2x2-1.jpg'
  WHERE id = 'cd82628f-e6ea-4a8f-a8cd-34a355960275';

-- R257 (Glossy Hexagon 2x2): Cobalt-SL → White-Glossy-Hex-2x2 (exact format)
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-White-Glossy-Hexagon-2x2-1.jpg'
  WHERE id = 'c1c4a1a2-d00e-45a3-8caf-cccb284188e7';

-- =============================================================================
-- FIX 4: Cobalt Hexagon SKUs — showing Cobalt Stacked Linear
-- No Cobalt hexagon images exist. Use closest-color hex images.
-- =============================================================================

-- R255-COBA (Cobalt Matte Hexagon 4x4): → Grey-Hex-4x4
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Grey-Matte-Hexagon-4x4-1.jpg'
  WHERE id = '7d3f5ecb-f998-4d3d-9afe-6e4b8d1113b2';

-- R256-COBA (Cobalt Matte Hexagon 2x2): → Black-Hex-2x2 (dark color, closest)
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Black-Matte-Hexagon-2x2-1.jpg'
  WHERE id = 'cd432aed-95d2-4a0f-801a-16d19d28dc39';

-- R257-COBA (Cobalt Glossy Hexagon 2x2): → Black-Hex-2x2 (dark color, closest)
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Black-Matte-Hexagon-2x2-1.jpg'
  WHERE id = 'ef96f9dc-87c7-4b6e-a1bc-2f0db9d7c983';

-- =============================================================================
-- FIX 5: Black Stacked Linear SKUs — showing Black Hexagon 2x2
-- No Black stacked linear images exist. Use Cobalt SL (dark color, right format).
-- =============================================================================

UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Colbat-Glossy-Stacked-Linear-0.86x5.7-1.jpg'
  WHERE id IN (
    'f5eb4e6f-dda7-4bf1-b910-a9761d8d6869',  -- R258-BLAC
    '6a97e2cd-b8a3-4bf6-87f2-11cccd2bf5e1',  -- R259-BLAC
    '3b23ad57-e1e1-474a-a6b9-04e652af44d2',  -- R260-BLAC
    'f8540efe-7ba1-4e65-a61e-7a3faf97028a',  -- R261-BLAC
    'c7b1724f-be1d-49fb-bb6b-06ae5b017f39'   -- R262-BLAC
  );

-- =============================================================================
-- FIX 6: White Stacked Linear SKUs — showing White Hexagon 2x2
-- No White stacked linear images exist. Use Grey SL (neutral, right format).
-- =============================================================================

UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Grey-Glossy-Stacked-Linear-0.86x5.7-1.jpg'
  WHERE id IN (
    '950fc27c-9967-47d3-b3ea-4c5a5ba66cf6',  -- R258-WHIT
    'c6eb8742-223d-403e-8b1f-0375930b53d8',  -- R259-WHIT
    '5807cb93-7959-408d-ad74-d60ef12dd32e',  -- R260-WHIT
    'f5191414-59d6-43ef-a152-766f38c94832',  -- R261-WHIT
    '2f990fa9-4d05-48ef-8d0f-a0958391899f'   -- R262-WHIT
  );

COMMIT;
