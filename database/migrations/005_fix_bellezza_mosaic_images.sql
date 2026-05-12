-- Migration 005: Fix Bellezza Ceramica mosaic image mismatches
-- Fixes multiple categories of incorrect image assignments across mosaic products:
--
--   1. Calacatta Gold large tiles (BLZ-R114, R115) showing PENNY mosaic images
--      - Move PENNY images to Penny Calacatta Gold (BLZ-R241) which had none
--      - Promote correct large-tile image to primary
--
--   2. Gio Grey & Taupe stacked linear SKUs showing hexagon images as primary
--      - Swap primary to the stacked-linear image that already exists as alternate
--
--   3. Milano Mosaic Gold & Silver showing Crema-color images
--      - Delete wrong-color images (no correct Gold/Silver images available)
--
--   4. Frammenti mosaic tiles with no primary image
--      - Promote best available alternate to primary
--
-- Run: docker exec -i flooring-db psql -U postgres -d flooring_pim < database/migrations/005_fix_bellezza_mosaic_images.sql

BEGIN;

-- =============================================================================
-- FIX 1: Calacatta Gold large tiles → move PENNY images to Penny Calacatta Gold
-- BLZ-R114 (Lux Semi-Polished 24x48) and BLZ-R115 (Matte 15.75x47.24) both
-- have PENNY mosaic images as primary. The actual Penny Calacatta Gold product
-- (BLZ-R241) has zero images.
-- =============================================================================

-- Move BLZ-R114's PENNY images to Penny Calacatta Gold (BLZ-R241)
UPDATE media_assets SET sku_id = '841dfee7-03b1-49ff-a885-3fa7680be29c', sort_order = 0
  WHERE id = 'b3f2b665-7a3a-44c5-a8fd-cb57e51f890a'; -- PENNY-Calacatta-Gold-1.jpg → primary for R241

UPDATE media_assets SET sku_id = '841dfee7-03b1-49ff-a885-3fa7680be29c', sort_order = 1
  WHERE id = 'a28b38a8-41cd-493e-9e42-7cdb91d338a9'; -- PENNY-Calacatta-Gold-s.jpg → alt for R241

UPDATE media_assets SET sku_id = '841dfee7-03b1-49ff-a885-3fa7680be29c', sort_order = 2
  WHERE id = '7127ed21-1c1c-4cca-804a-30db1f1f2edb'; -- PENNY-Calacatta-Gold-2.jpg → alt for R241

-- Delete BLZ-R115's duplicate PENNY images (R241 already gets the set from R114)
DELETE FROM media_assets WHERE id IN (
  '6385170c-84af-4bcd-a5c2-ddcbe703e050', -- PENNY-Calacatta-Gold-1.jpg
  'd824e38d-c83f-47af-88d7-4ea4b3430235', -- PENNY-Calacatta-Gold-s.jpg
  '3e916a6a-2822-4708-9e3d-e7e7818d1696'  -- PENNY-Calacatta-Gold-2.jpg
);

-- Promote Calacatta-Gold-Lux-Semi-24x48-3.jpg to primary for both large tile SKUs
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = '3c10cf12-b2b4-4b5e-9144-db09a93136bb'; -- BLZ-R114
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = '08dce768-4546-4e82-abf9-161aea6e692a'; -- BLZ-R115

-- Reclassify POR1307 install photos as lifestyle
UPDATE media_assets SET asset_type = 'lifestyle', sort_order = 10
  WHERE id = 'f76bc7d6-aa13-4603-90a3-05f01d263ef9'; -- BLZ-R114
UPDATE media_assets SET asset_type = 'lifestyle', sort_order = 10
  WHERE id = '5159a2cd-5244-48fb-81d7-43c51d9bdbbe'; -- BLZ-R115

-- =============================================================================
-- FIX 2: Gio Grey stacked linear SKUs — swap hexagon primary to stacked linear
-- 5 SKUs: R258-GREY, R259-GREY, R260-GREY, R261-GREY, R262-GREY
-- Each has hexagon image at primary(0) and stacked linear at alternate(2)
-- =============================================================================

-- Demote hexagon primaries to alternate
UPDATE media_assets SET asset_type = 'alternate', sort_order = 10
  WHERE id IN (
    '886f80e0-cca6-4e4b-8c49-342172422adb', -- R258-GREY
    '179f4672-ecaa-4693-bd40-c0226bf63ae2', -- R259-GREY
    '4a2b9b2d-033f-4a12-a842-e40a80e9f3b1', -- R260-GREY
    'ff197757-975a-405c-a3fc-2cfd7dc60f1c', -- R261-GREY
    '728a4ea6-cc95-469c-8189-8172c649d2f3'  -- R262-GREY
  );

-- Promote stacked linear alternates to primary
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id IN (
    'e0aef7ec-d6d9-4c08-badb-ee6af433bb74', -- R258-GREY
    'b1973cc4-585d-4e7f-9573-52a5bcbce6b8', -- R259-GREY
    '3d763f09-05fe-4020-b9aa-9b9bdf104703', -- R260-GREY
    '0bc3bfad-015d-4b69-a97c-f534a41b59d1', -- R261-GREY
    'f4d5e1ed-d72a-464b-a1cc-ada2b5e6eadf'  -- R262-GREY
  );

-- =============================================================================
-- FIX 3: Gio Taupe stacked linear SKUs — swap hexagon primary to stacked linear
-- 5 SKUs: R258-TAUP, R259-TAUP, R260-TAUP, R261-TAUP, R262-TAUP
-- Each has hexagon image at primary(0) and stacked linear at alternate(4)
-- =============================================================================

-- Demote hexagon primaries to alternate
UPDATE media_assets SET asset_type = 'alternate', sort_order = 10
  WHERE id IN (
    '8d23989f-ff30-46d5-ad29-fa177b9370e2', -- R258-TAUP
    'f92fa4b8-f78d-40c4-b7c7-06e825974d03', -- R259-TAUP
    '5d235bd5-e195-47e4-9199-944942e9f75f', -- R260-TAUP
    'ad219f1d-a3e1-4754-8fbc-727c2b822f63', -- R261-TAUP
    'b9ef34b9-976a-4e84-8e3e-d4d4150a59fc'  -- R262-TAUP
  );

-- Promote stacked linear alternates to primary
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id IN (
    '97827433-3dd3-4446-ae5e-a21628d4181e', -- R258-TAUP
    '7eee317d-bed5-4c5b-879b-7c230811fd04', -- R259-TAUP
    'e3e8f401-00bb-4bab-862c-813fe16bdaea', -- R260-TAUP
    '8b0f2864-e53d-4b91-acbb-3ab0b437a060', -- R261-TAUP
    '07668495-66c1-48f3-8183-c9e1884417b8'  -- R262-TAUP
  );

-- =============================================================================
-- FIX 4: Milano Mosaic Gold & Silver — delete wrong-color Crema images
-- BLZ-R237-GOLD and BLZ-R237-SILV have only Crema images (wrong color)
-- =============================================================================

-- Delete all Crema images from Milano Mosaic Gold
DELETE FROM media_assets WHERE id IN (
  '78e9e0fd-c0ab-490c-a7b3-0ee5aa484ae2', -- APM_MILANO_CREMA... (alt 1)
  'ab9bf9be-1acd-4599-ae57-cf0601c20c14', -- Milano-Crema-0.jpg (alt 2)
  '1f893d0e-61f6-4dd3-b7fb-b90e98da9274', -- Milano-Crema-1.jpg (alt 3)
  '315f74a4-9be2-4f51-8490-d9e3a337a1e2', -- APG_MILANO_CREMA... hotel (alt 4)
  '6a8ffc52-9f79-4744-bc09-a9bf1db1ca4a'  -- APG_MILANO_CREMA... rooftop (alt 5)
);

-- Delete all Crema images from Milano Mosaic Silver
DELETE FROM media_assets WHERE id IN (
  '69f3719b-a34e-4b58-a739-0efdb6c869df', -- APM_MILANO_CREMA... (alt 1)
  '5d7c1131-d3a8-4947-9ff7-051715100bc1', -- Milano-Crema-0.jpg (alt 2)
  '60674c9e-2d7f-43b2-a591-2e60906de86f', -- Milano-Crema-1.jpg (alt 3)
  '0ba187cb-957a-4bc2-a327-b84f9bb817eb', -- APG_MILANO_CREMA... hotel (alt 4)
  '1c30bc66-b4b9-4db1-80c7-5d7199c07a9b'  -- APG_MILANO_CREMA... rooftop (alt 5)
);

-- =============================================================================
-- FIX 5: Frammenti mosaic tiles — promote alternate to primary
-- Azzurro (R267), Nero (R268), Grigio (R272) have no primary, only lifestyle+alt
-- Promote FR-2-MACRO_2000.jpeg (best product shot) from alternate to primary
-- =============================================================================

UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = '2958b6f1-1110-4421-b5a7-cce449fe3d0a'; -- R267 Azzurro
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = 'b03a9ee2-2460-4f1d-8e94-2f56c259928b'; -- R268 Nero
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = 'e8ea16d6-eb8c-43ca-a012-48bc4e1beeb9'; -- R272 Grigio

COMMIT;
