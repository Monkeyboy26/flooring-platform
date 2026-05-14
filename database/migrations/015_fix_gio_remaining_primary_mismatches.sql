-- Migration 015: Fix remaining Gio primary image mismatches
--
-- Comprehensive CDN audit found additional images that exist on Bellezza's CDN
-- but were never properly assigned. This migration fixes primary images that
-- show the wrong finish, wrong size, or completely wrong product.
--
-- Part A: Finish mismatch — Glossy SKU showing Matte image (1 fix)
-- ================================================================
-- BLZ-R257-BLAC (Black Glossy Hex 2x2): shows Black MATTE Hex 2x2 image
--   → CDN has GIO-Black-Glossy-Hexagon-2x2-1.jpg (exact match!)
--   → Bellezza product page confirms this is the correct product photo
--
-- Part B: Size mismatch — 1.26x5.7 SKUs showing .86x5.7 image (5 fixes)
-- ================================================================
-- CDN has dedicated 1.26x5.7 product photos that weren't in the DB:
--   BLZ-R261-BLAC (Black Matte SL 1.26):  .86 → Black-Matte-SL-1.26x5.7-1
--   BLZ-R261-WHIT (White Matte SL 1.26):  .86 → White-Matte-SL-1.26x5.7-1
--   BLZ-R262-COBA (Cobalt Glossy SL 1.26): .86 → Colbat-Glossy-1.26x5.7-1
--   BLZ-R262-GREY (Grey Glossy SL 1.26):  .86 → Grey-Glossy-1.26x5.7-1
--   BLZ-R262 (Default Glossy SL 1.26):    .86 → Colbat-Glossy-1.26x5.7-1
--
-- Part C: Best-available fixes — no exact match but closer image exists (4 fixes)
-- ================================================================
-- These SKUs have no exact CDN match (vendor never photographed that combo)
-- but a closer image exists than what's currently assigned:
--   BLZ-R261-COBA (Cobalt Matte SL 1.26): Glossy .86 → Glossy 1.26 (right size)
--   BLZ-R261-GREY (Grey Matte SL 1.26):   Glossy .86 → Glossy 1.26 (right size)
--   BLZ-R261 (Default Matte SL 1.26):     Cobalt Glossy .86 → Black Matte 1.26
--   BLZ-R258 (Default Matte SL .82):      Cobalt Glossy .86 → Taupe Matte .82
--
-- CDN image availability summary (Bellezza never photographed these):
--   ✗ No Cobalt Matte images exist (only Cobalt Glossy)
--   ✗ No Grey Matte Stacked Linear images exist (only Grey Glossy SL)
--   ✗ No Grey Hexagon 2x2 images exist (only Grey Hex 4x4)
--   ✗ No Taupe Hexagon 4x4 images exist (only Taupe Hex 2x2)
--   ✗ No Taupe Glossy images exist (only Taupe Matte)
--   ✗ No Taupe SL .86 or 1.26 images exist (only Taupe SL .82)
--   ✗ No Cobalt Hexagon images exist at all
--   ✗ No Black Glossy 1.26 images exist
--
-- Run: docker exec -i flooring-db psql -U postgres -d flooring_pim < database/migrations/015_fix_gio_remaining_primary_mismatches.sql

BEGIN;

-- =============================================================================
-- PART A: Fix finish mismatch (Glossy SKU showing Matte image)
-- =============================================================================

-- BLZ-R257-BLAC: Black Glossy Hex 2x2 — showing Matte, CDN has Glossy
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Black-Glossy-Hexagon-2x2-1.jpg'
  WHERE id = '3edcea7c-81a6-4b1b-8d49-ebfbc11dd235';

-- =============================================================================
-- PART B: Fix size mismatches — exact 1.26x5.7 product photos exist on CDN
-- =============================================================================

-- BLZ-R261-BLAC: Black Matte SL 1.26 — showing .86, CDN has 1.26
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Black-Matte-Stacked-Linear-1.26x5.7-1.jpg'
  WHERE id = 'f8540efe-7ba1-4e65-a61e-7a3faf97028a';

-- BLZ-R261-WHIT: White Matte SL 1.26 — showing .86, CDN has 1.26
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-White-Matte-Stacked-Linear-1.26x5.7-1.jpg'
  WHERE id = 'f5191414-59d6-43ef-a152-766f38c94832';

-- BLZ-R262-COBA: Cobalt Glossy SL 1.26 — showing .86, CDN has 1.26
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Colbat-Glossy-1.26x5.7-1.jpg'
  WHERE id = 'bb1fe1ab-29f5-44e2-aaea-7dd23991e065';

-- BLZ-R262-GREY: Grey Glossy SL 1.26 — showing .86, CDN has 1.26
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Grey-Glossy-1.26x5.7-1.jpg'
  WHERE id = 'f4d5e1ed-d72a-464b-a1cc-ada2b5e6eadf';

-- BLZ-R262: Default Glossy SL 1.26 — showing Cobalt .86, fix to Cobalt 1.26 (right size)
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Colbat-Glossy-1.26x5.7-1.jpg'
  WHERE id = 'a04d664c-d2d7-4f70-a00f-4466251b3781';

-- =============================================================================
-- PART C: Best-available fixes (no exact match, but closer than current)
-- =============================================================================

-- BLZ-R261-COBA: Cobalt Matte SL 1.26 — no Cobalt Matte exists; Glossy 1.26 is closest
-- (currently: Cobalt Glossy .86 → fix to Cobalt Glossy 1.26 = right color + right size)
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Colbat-Glossy-1.26x5.7-1.jpg'
  WHERE id = 'f881605e-f4a2-4fd4-b177-eddfd4a54d74';

-- BLZ-R261-GREY: Grey Matte SL 1.26 — no Grey Matte SL exists; Grey Glossy 1.26 is closest
-- (currently: Grey Glossy .86 → fix to Grey Glossy 1.26 = right color + right size)
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Grey-Glossy-1.26x5.7-1.jpg'
  WHERE id = '0bc3bfad-015d-4b69-a97c-f534a41b59d1';

-- BLZ-R261: Default Matte SL 1.26 — showing Cobalt Glossy .86 (wrong finish + size)
-- Black Matte SL 1.26 exists and matches finish + size
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Black-Matte-Stacked-Linear-1.26x5.7-1.jpg'
  WHERE id = 'd663014d-7492-46b6-be97-98910592eddd';

-- BLZ-R258: Default Matte SL .82 — showing Cobalt Glossy .86 (wrong everything!)
-- Taupe Matte .82 exists and matches finish + format + size
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Taupe-Matte-Stacked-Linear-0.82x2.8-1.jpg'
  WHERE id = '455b956d-80a9-436f-a0d9-2a409210f712';

COMMIT;
