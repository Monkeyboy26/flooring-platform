-- Migration 014: Fix Gio color mismatches + reclassify lifestyle images
--
-- Part A: Fix 11 Gio primary images showing the wrong color
-- ================================================================
-- The scraper assigned all Gio images to all SKUs regardless of color.
-- Migrations 009+013 fixed format mismatches and cross-format alternates,
-- but many SKUs still show the wrong COLOR as their primary image.
--
-- CDN probe found missing images that exist but weren't in the DB:
--   - GIO-Black-{Matte,Glossy}-Stacked-Linear-*  (Black SL images exist!)
--   - GIO-White-{Matte,Glossy}-Stacked-Linear-*  (White SL images exist!)
--   - GIO-White-Matte-Hexagon-4x4-1.jpg          (White Matte 4x4 exists!)
--
-- Fixes:
--   6 Black SL SKUs: primary was Cobalt SL → now Black SL
--   4 White SL SKUs: primary was Grey SL → now White SL (matching finish)
--   1 White SL SKU:  primary was Grey SL → now White Glossy 1.26 (exact match)
--   1 White Hex SKU: primary was White Glossy 2x2 → now White Matte 4x4
--
-- Part B: Reclassify lifestyle images for Camden, Grande, Hudson, Nord, Park
-- ================================================================
-- Same issue as Antwerp (fixed in migration 010): the scraper classified
-- room scene / lifestyle renders as 'alternate' instead of 'lifestyle'.
-- These appear in the product image gallery alongside the actual product shot.
--
--   Camden: 5 alternates → all lifestyle (image-3, image-5, image-6, image-7-1, image-7-2)
--   Grande: 4 alternates → all lifestyle (image-1 through image-4)
--   Hudson: 5 alternates → all lifestyle (image-1 through image-5)
--   Nord:   3 alternates → all lifestyle (image-1, image-2, image-4)
--   Park:   5 alternates → all lifestyle (image-3, image-4, image-5, image-5-1, image-5-2)
--
-- Run: docker exec -i flooring-db psql -U postgres -d flooring_pim < database/migrations/014_fix_gio_color_mismatches_and_lifestyle_reclassify.sql

BEGIN;

-- =============================================================================
-- PART A: Fix Gio primary image color mismatches
-- =============================================================================

-- --- Black Stacked Linear SKUs (all showing Cobalt → fix to Black) ---

-- BLZ-R258-BLAC: Black Matte SL .82x2.8
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Black-Matte-Stacked-Linear-0.82x2.8-1.jpg'
  WHERE id = 'f5eb4e6f-dda7-4bf1-b910-a9761d8d6869';

-- BLZ-R259-BLAC: Black Matte SL .86x5.7
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Black-Matte-Stacked-Linear-0.86x5.7-1.jpg'
  WHERE id = '6a97e2cd-b8a3-4bf6-87f2-11cccd2bf5e1';

-- BLZ-R260-BLAC: Black Glossy SL .86x5.7
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Black-Glossy-Stacked-Linear-0.86x5.7-1.jpg'
  WHERE id = '3b23ad57-e1e1-474a-a6b9-04e652af44d2';

-- BLZ-R261-BLAC: Black Matte SL 1.26x5.7 (no 1.26 Black exists; .86 Matte is best)
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Black-Matte-Stacked-Linear-0.86x5.7-1.jpg'
  WHERE id = 'f8540efe-7ba1-4e65-a61e-7a3faf97028a';

-- BLZ-R262-BLAC: Black Glossy SL 1.26x5.7 (no 1.26 Black exists; .86 Glossy is best)
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Black-Glossy-Stacked-Linear-0.86x5.7-1.jpg'
  WHERE id = 'c7b1724f-be1d-49fb-bb6b-06ae5b017f39';

-- --- White Stacked Linear SKUs (all showing Grey → fix to White) ---

-- BLZ-R258-WHIT: White Matte SL .82x2.8
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-White-Matte-Stacked-Linear-0.82x2.8-1.jpg'
  WHERE id = '950fc27c-9967-47d3-b3ea-4c5a5ba66cf6';

-- BLZ-R259-WHIT: White Matte SL .86x5.7
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-White-Matte-Stacked-Linear-0.86x5.7-1.jpg'
  WHERE id = 'c6eb8742-223d-403e-8b1f-0375930b53d8';

-- BLZ-R260-WHIT: White Glossy SL .86x5.7
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-White-Glossy-Stacked-Linear-0.86x5.7-1.jpg'
  WHERE id = '5807cb93-7959-408d-ad74-d60ef12dd32e';

-- BLZ-R261-WHIT: White Matte SL 1.26x5.7 (no White Matte 1.26; .86 Matte is best)
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-White-Matte-Stacked-Linear-0.86x5.7-1.jpg'
  WHERE id = 'f5191414-59d6-43ef-a152-766f38c94832';

-- BLZ-R262-WHIT: White Glossy SL 1.26x5.7 (exact match exists!)
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-White-Glossy-1.26x5.7-1.jpg'
  WHERE id = '2f990fa9-4d05-48ef-8d0f-a0958391899f';

-- --- White Matte Hexagon 4x4 (showing Glossy 2x2 → fix to Matte 4x4) ---

-- BLZ-R255-WHIT: White Matte Hexagon 4x4
UPDATE media_assets SET url = 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-White-Matte-Hexagon-4x4-1.jpg'
  WHERE id = 'fc28455d-20f4-4b39-b1ad-bc002137ae96';

-- =============================================================================
-- PART B: Reclassify lifestyle images (alternate → lifestyle)
-- Same pattern as Antwerp (migration 010)
-- =============================================================================

-- Camden: 5 alternates → lifestyle
UPDATE media_assets SET asset_type = 'lifestyle' WHERE id IN (
  'ce2aee60-6941-4802-ad3f-e91cef6e60f4',  -- Camden-image-7-2.jpg
  '2f9b8178-8f1b-4755-9ae9-b08d44a4bef0',  -- Camden-image-7-1.jpg
  'ff4f3014-087a-4dc9-aa95-7de3b4eb9ca2',  -- Camden-image-6.jpg
  'f71f9e7c-abd7-4581-bb5c-59b632bd7fe6',  -- Camden-image-5.jpg
  '55496ebf-20c8-4bc5-8698-93b3e6369685'   -- Camden-image-3.jpg
);

-- Grande: 4 alternates → lifestyle
UPDATE media_assets SET asset_type = 'lifestyle' WHERE id IN (
  'ed981613-16d5-4c6b-ba30-96efcc4f32b9',  -- Grande-image-4.jpg
  'f9d03932-407d-4fbd-9f4e-b120a13d41dd',  -- Grande-image-3.jpg
  '9c661d8a-4fb2-4e25-be1b-9403ce3c6663',  -- Grande-image-2.jpg
  'baabe787-6e6d-439a-832a-3c4d6d1f888d'   -- Grande-image-1.jpg
);

-- Hudson: 5 alternates → lifestyle
UPDATE media_assets SET asset_type = 'lifestyle' WHERE id IN (
  '380b57c0-e40d-437e-b8f8-75bde8b4a5f2',  -- Hudson-Oslo-image-4.jpg
  'f2b339c5-050b-40dd-a3ca-12c3a1ef691d',  -- Hudson-Oslo-image-3.jpg
  'f6ad6552-35ec-42a2-b40a-9c247f16fff2',  -- Hudson-Oslo-image-2.jpg
  '8457f680-8c62-4c9a-9f71-1f15cb23eb14',  -- Hudson-Oslo-image-5.jpg
  'b818ec6d-06f4-4e99-b07b-e8fd8c5b0c2f'   -- Hudson-Oslo-image-1.jpg
);

-- Nord: 3 alternates → lifestyle
UPDATE media_assets SET asset_type = 'lifestyle' WHERE id IN (
  '7eb3ea47-d3f0-425c-baad-470f145a2fec',  -- Nord-image-4.jpg
  '3d7c0f32-9f4a-4d43-a63e-6b8ca5e0925d',  -- Nord-image-2.jpg
  '1f784641-908e-49b4-8ff2-77527adc8413'   -- Nord-image-1.jpg
);

-- Park: 5 alternates → lifestyle
UPDATE media_assets SET asset_type = 'lifestyle' WHERE id IN (
  '292df14f-d230-41b4-9103-78848e902218',  -- Park-image-5-2.jpg
  'f1ff5cac-efc3-45b4-806d-8ac55eeae804',  -- Park-image-5-1.jpg
  'eb992686-5cc9-4aee-ac09-672ffebfc54b',  -- Park-image-5.jpg
  '6451b613-a3db-450a-835a-70c0fe915f47',  -- Park-image-4.jpg
  'a1584cdf-3139-4d1b-b918-2b15700b5799'   -- Park-image-3.jpg
);

COMMIT;
