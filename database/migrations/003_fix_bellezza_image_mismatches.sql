-- Migration 003: Fix Bellezza Ceramica SKU-to-image mismatches
-- Corrects primary images where color variants were showing wrong-color images,
-- removes cross-color contamination from alternates, and promotes lifestyle
-- images to primary where no correct primary existed.
--
-- Run: docker exec -i flooring-db psql -U postgres -d flooring_pim < database/migrations/003_fix_bellezza_image_mismatches.sql

BEGIN;

-- =============================================================================
-- FIX 1: Altea Dusty Pink (3 SKUs)
-- Was sharing a combined Rosewood+DustyPink primary; swap to dedicated Dusty Pink image
-- =============================================================================

-- BLZ-R276-DUST: demote shared primary, promote dedicated Dusty Pink alternate
UPDATE media_assets SET asset_type = 'alternate', sort_order = 98
  WHERE id = 'fa884c05-c8fb-4c59-9063-c87f6d5286a3';
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = '31df9389-dfcf-493d-9a88-1b3909c114d9';

-- BLZ-R277-DUST
UPDATE media_assets SET asset_type = 'alternate', sort_order = 98
  WHERE id = '95f937a7-639e-4417-ac74-985e497a7346';
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = '6d0a976c-6aec-4924-b239-5e760cb9751e';

-- BLZ-R278-DUST
UPDATE media_assets SET asset_type = 'alternate', sort_order = 98
  WHERE id = 'b66bb93f-2c4f-470b-b5b6-9799f65bf029';
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = 'fe46cf16-ed25-469f-a19a-9780ad8fe8fd';

-- =============================================================================
-- FIX 2: Altea Rosewood (3 SKUs)
-- Was sharing a combined primary; swap to dedicated Rosewood image
-- =============================================================================

-- BLZ-R276-ROSE
UPDATE media_assets SET asset_type = 'alternate', sort_order = 98
  WHERE id = 'f6840256-eb4c-4ea1-a9eb-0b89ab160fea';
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = 'b2f6671c-1234-4fde-b8d5-e6c4bd03f7f7';

-- BLZ-R277-ROSE
UPDATE media_assets SET asset_type = 'alternate', sort_order = 98
  WHERE id = '04a42cb1-c4cc-442c-afd7-e7551633d874';
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = 'df596185-9cac-4373-826a-31bbe975f13c';

-- BLZ-R278-ROSE
UPDATE media_assets SET asset_type = 'alternate', sort_order = 98
  WHERE id = 'd4f48a8c-dfb8-4ecd-b295-239cae8346c6';
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = '2b1718e6-4357-4db4-a1ec-c11aeca4fd82';

-- =============================================================================
-- FIX 3: Altea Matcha (3 SKUs)
-- Had no primary image (broken placeholder); promote lifestyle to primary
-- =============================================================================

UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = 'efa61f6b-a33c-4969-8bdc-0caa6f69eddc'; -- BLZ-R276-MATC
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = '20e0f89f-152b-4447-a664-3526962d3320'; -- BLZ-R277-MATC
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = '2d104c29-d68e-416f-a1e1-5326fd3dd650'; -- BLZ-R278-MATC

-- =============================================================================
-- FIX 4: Delete wrong-color primary images
-- These SKUs had primaries showing a sibling color's image
-- =============================================================================

-- Chamonix Ocean (3 SKUs) - was showing Dark Gray image
DELETE FROM media_assets WHERE id = '201b1bc3-665d-46ca-8e6b-3abe8fcc499d'; -- Ocean 12x24
DELETE FROM media_assets WHERE id = '7a0ea492-1b14-470d-bc15-386f824a2288'; -- Ocean 24x48
DELETE FROM media_assets WHERE id = '48954bbe-11c9-4770-837f-3c6ada4ec980'; -- Ocean 24x24

-- Granby Ivory - was showing Beige image
DELETE FROM media_assets WHERE id = '1f863d0d-657a-4ccf-8d19-fc12dbc93189';

-- Metallic Dark Grey Mosaic - was showing Light Grey image
DELETE FROM media_assets WHERE id = '93ff3777-0ff6-4a91-8592-d43ab3a2459d';

-- Milano Mosaic Gold - was showing Crema image
DELETE FROM media_assets WHERE id = '29c54429-6929-4691-bd1b-43c468e3eb2e';

-- Milano Mosaic Silver - was showing Crema image
DELETE FROM media_assets WHERE id = '005cc67e-dddc-4751-a025-9d64743ced76';

-- =============================================================================
-- FIX 5: Montblanc Gold (4 SKUs)
-- Was showing caledonia-gold as primary; swap with MONTBLANC-GOLD-24X48.jpg lifestyle
-- =============================================================================

-- Demote wrong caledonia-gold primaries to alternate
UPDATE media_assets SET asset_type = 'alternate', sort_order = 98
  WHERE id = 'f47b240d-8f76-47c5-aedb-2d7e6b62e83e'; -- R183
UPDATE media_assets SET asset_type = 'alternate', sort_order = 98
  WHERE id = 'cde73d62-f3c7-4ffb-83f2-039323205197'; -- R185
UPDATE media_assets SET asset_type = 'alternate', sort_order = 98
  WHERE id = '5b8c7df4-f515-4cbf-9abc-51ee3cb4fca9'; -- R186
UPDATE media_assets SET asset_type = 'alternate', sort_order = 98
  WHERE id = '3609cbbf-db60-4a22-8c92-2e8c836a393c'; -- R187

-- Promote MONTBLANC-GOLD-24X48.jpg lifestyle to primary
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = 'e570c782-f70c-422f-8346-7094673ed4b6'; -- R183
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = 'acc613b9-28d0-4d94-960a-e7330a281793'; -- R185
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = 'f198a810-f27e-432e-95bc-c3b50095ee47'; -- R186
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = '86d9dad8-4cf8-4d00-879b-7cb47a8c0da9'; -- R187

-- =============================================================================
-- FIX 6: Chamonix Gray (3 SKUs)
-- Had no primary after wrong-color primary was removed; promote Gray_Laydown lifestyle
-- =============================================================================

UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = '07d4f092-cfc0-4591-a005-425fbbfbd05a'; -- R130-GRAY
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = '09dfe4eb-ea9d-4a8e-9349-99f01d7d8cb0'; -- R131-GRAY
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = 'd90c5562-621a-4467-8a3e-a4e2e0e40412'; -- R431-GRAY

-- =============================================================================
-- FIX 7: Chamonix Dark Gray (4 SKUs)
-- Had no primary after wrong-color primary was removed; promote Dark_Gray_Laydown lifestyle
-- =============================================================================

UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = 'a328ca96-aee2-401e-94d4-a0e0125a4847'; -- R130-DARK
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = '3303fd36-11ea-4413-979b-80d642774a87'; -- R131-DARK
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = 'c0691ef4-e535-46a7-b393-b448ac4e2fd4'; -- R431-DARK
UPDATE media_assets SET asset_type = 'primary', sort_order = 0
  WHERE id = '511ac769-e942-4de5-b2a4-3a80a5331931'; -- R132

-- =============================================================================
-- FIX 8: Chamonix Gray cleanup
-- Remove wrong-color Dark Gray images from Gray SKUs (cross-color contamination)
-- =============================================================================

-- Demoted wrong primaries (Dark_Gray_Laydown as alternate at sort_order 98)
DELETE FROM media_assets WHERE id = '4b16abd0-13c2-4305-b869-89f51fa0d59b'; -- R130-GRAY
DELETE FROM media_assets WHERE id = 'ce02d5ca-0833-40ab-b6a0-8e06eb4d21a1'; -- R131-GRAY
DELETE FROM media_assets WHERE id = 'fb3f3341-0bf9-490d-8c69-f81fdd919599'; -- R431-GRAY

-- Dark Gray Kitchen lifestyle images on Gray SKUs
DELETE FROM media_assets WHERE id = '1a806c34-3dbf-4dd5-811f-4242144a66f9'; -- R130-GRAY
DELETE FROM media_assets WHERE id = 'a9121efa-55a2-418a-b5ea-14bdc09a7fc3'; -- R131-GRAY
DELETE FROM media_assets WHERE id = 'b4464579-6127-441a-953a-47a9c37ec44f'; -- R431-GRAY

-- =============================================================================
-- FIX 9: Angelo Silver cleanup
-- Remove cross-color gold alternate images from Silver SKUs
-- =============================================================================

DELETE FROM media_assets WHERE id = '308cd93c-06a3-46b9-8acf-45fdb0e77c96'; -- R108-SILV
DELETE FROM media_assets WHERE id = 'eeafaabd-54b8-465b-baed-3ed03acf2af6'; -- R109-SILV

COMMIT;
