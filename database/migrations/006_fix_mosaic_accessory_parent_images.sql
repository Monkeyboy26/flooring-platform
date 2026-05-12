-- Migration 006: Fix mosaic accessories showing parent tile images as primary
-- These mosaic 2x2 accessories inherited images from their parent products.
-- The vendor site has no mosaic-specific photos for these product lines.
-- Fix: demote parent-tile primaries to lifestyle (preserves color reference via
-- fallback) and delete wrong-color images entirely.
--
-- Products affected:
--   Arena Chiaro Mosaic 2x2 (BLZ-R105)
--   Ceppo R11 Sabbia Mosaic 2x2 (BLZ-R293) — also has wrong-color Avorio/Grigio images
--   Fry Bianco Mosaic 2x2 (BLZ-R298)
--   Fry Grigio Mosaic 2x2 (BLZ-R299)
--   Kadence Perla Matte Mosaic 2x2 (BLZ-R300)
--   Puccini Blanco Polished Mosaic 2x2 (BLZ-R304)
--
-- Run: docker exec -i flooring-db psql -U postgres -d flooring_pim < database/migrations/006_fix_mosaic_accessory_parent_images.sql

BEGIN;

-- =============================================================================
-- FIX 1: Arena Chiaro Mosaic 2x2 (BLZ-R105)
-- Primary shows parent Arena Chiaro tile image — demote to lifestyle
-- =============================================================================

UPDATE media_assets SET asset_type = 'lifestyle', sort_order = 20
  WHERE id = '6834dff0-b737-4306-bf6a-7d8f71ddfa8a'; -- Arena-Chiaro-1.jpg (was primary)

-- =============================================================================
-- FIX 2: Ceppo R11 Sabbia Mosaic 2x2 (BLZ-R293)
-- Has Avorio + Grigio tile images (wrong color entirely) — delete those
-- Keep Ceppo-Sabbia-1.png lifestyle (correct color, already lifestyle)
-- =============================================================================

DELETE FROM media_assets WHERE id IN (
  '1e6491c2-3c6f-4c6e-8a14-dbe77136e34d', -- Ceppo-Avorio.png (wrong color)
  '7f46801f-5d96-4efd-904c-666f089e478f', -- Ceppo-Avorio-2.png (wrong color)
  '04bb4808-66d6-491e-b248-bfa9c1ea36d8', -- Ceppo-Grigio-1.png (wrong color)
  'cef3262c-76f6-4fc1-8c31-ab9f8b0cebc3', -- Ceppo-Grigio.png (wrong color)
  '1910afa6-290a-481b-8fd8-5fa67823bfdc'  -- Ceppo-Grigio-2.png (wrong color)
);

-- =============================================================================
-- FIX 3: Fry Bianco Mosaic 2x2 (BLZ-R298)
-- Primary shows 12x24/24x48 parent tile — demote to lifestyle
-- =============================================================================

UPDATE media_assets SET asset_type = 'lifestyle', sort_order = 20
  WHERE id = '7e0400b0-a6ee-4454-932a-615173467b67'; -- FryBiancoMatte12X2424X48-scaled.jpg

-- =============================================================================
-- FIX 4: Fry Grigio Mosaic 2x2 (BLZ-R299)
-- Primary shows 12x24/24x48 parent tile — demote to lifestyle
-- =============================================================================

UPDATE media_assets SET asset_type = 'lifestyle', sort_order = 20
  WHERE id = '429b4760-9a80-4748-a14b-b490e7ee83ee'; -- FryGrigioMatte12X2424X48-scaled.jpg

-- =============================================================================
-- FIX 5: Kadence Perla Matte Mosaic 2x2 (BLZ-R300)
-- Primary shows parent Kadence Perla tile — demote to lifestyle
-- Alternates are also parent tile images — reclassify to lifestyle
-- =============================================================================

UPDATE media_assets SET asset_type = 'lifestyle', sort_order = 20
  WHERE id = '42c36242-5493-4231-9aaa-b68d5ea0b290'; -- KADENCE-PERLA-scaled-1.jpg (was primary)

UPDATE media_assets SET asset_type = 'lifestyle', sort_order = 21
  WHERE id = '8fdc5b4e-83da-4808-8883-ffb08e7b3bc5'; -- KADENCE-2.png (was alternate)

UPDATE media_assets SET asset_type = 'lifestyle', sort_order = 22
  WHERE id = '91e91f55-c6c4-413d-87af-43833fd21fb2'; -- AMB-KADENCE2-scaled-1.jpg (was alternate)

-- =============================================================================
-- FIX 6: Puccini Blanco Polished Mosaic 2x2 (BLZ-R304)
-- Primary shows parent Puccini Blanco tile — demote to lifestyle
-- =============================================================================

UPDATE media_assets SET asset_type = 'lifestyle', sort_order = 20
  WHERE id = 'ff546d8e-00f5-4f4a-83a1-9052674131c6'; -- Puccini-Blanco.jpg (was primary)

COMMIT;
