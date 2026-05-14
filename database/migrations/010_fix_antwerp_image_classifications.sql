-- Migration 010: Fix Antwerp image classifications
--
-- All 4 Antwerp "product" images (1 primary + 3 alternates) are actually
-- lifestyle/room scene photos:
--   - image-3 (primary): Room with potted plant on penny mosaic floor
--   - image-5 (alternate): Wall with decorative vases, penny mosaic background
--   - image-2 (alternate): Close-up of wooden bench legs on penny mosaic floor
--   - image-1 (alternate): Kitchen backsplash scene with penny mosaic
--
-- There is also one image already correctly classified as lifestyle:
--   - Snow-Forest (lifestyle, sort_order 99)
--
-- No actual product close-up shot exists for Antwerp (unlike Camden, Grande,
-- Hudson, Nord, Park which all have flat-lay mosaic sheet photos).
--
-- Fix strategy:
--   1. Keep image-3 as primary — it prominently shows the tile pattern and is
--      the best available option for the product card image
--   2. Reclassify all 3 alternates as lifestyle — they are room scenes, not
--      product detail angles
--
-- Run: docker exec -i flooring-db psql -U postgres -d flooring_pim < database/migrations/010_fix_antwerp_image_classifications.sql

BEGIN;

-- =============================================================================
-- Reclassify Antwerp alternate images from "alternate" to "lifestyle"
-- These are all room scene photos, not product detail shots
-- =============================================================================

-- image-5 (wall with vases scene, was alternate sort_order 1)
UPDATE media_assets SET asset_type = 'lifestyle', sort_order = 97
  WHERE id = '20c2aa80-b7db-4d64-bbeb-a1a57c78035b';

-- image-2 (bench legs on mosaic floor, was alternate sort_order 3)
UPDATE media_assets SET asset_type = 'lifestyle', sort_order = 98
  WHERE id = '5a1a69bf-83c2-48e7-853a-40c8f8d49c8c';

-- image-1 (kitchen backsplash scene, was alternate sort_order 4)
UPDATE media_assets SET asset_type = 'lifestyle', sort_order = 96
  WHERE id = '16462286-a9b0-4dfe-9f29-42f4c57c0896';

COMMIT;
