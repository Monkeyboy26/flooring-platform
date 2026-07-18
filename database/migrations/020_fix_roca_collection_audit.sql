-- Migration 020: Roca collection audit fixes
-- Addresses 12 categories of data quality issues across 711 Roca products
--
-- 1.  Seattle duplicate products: merge "Seattle Blanco/Cinza" into "Blanco/Cinza"
-- 2.  Tegel orphan products: delete 4 empty "Tegel *" duplicates
-- 3.  Pavers/Pro Max orphan products: delete 3 empty products
-- 4.  Color attribute contamination: fix 2 remaining Seattle entries
-- 5.  Nolita field tiles: reclassify from accessory to main SKUs
-- 6.  Forge trim variant_type: set missing accessory classification
-- 7.  Maiolica Crackled: reassign 6 misattributed bullnose SKUs to color products
-- 8.  Quote-mangled variant names: fix 45 broken variant names
-- 9.  Duplicate SKU dedup: remove 93 duplicate SKUs across collections
-- 10. Terra di Siena self-referencing name: rename product
-- 11. Indiana "Nocce" misspelling: fix to "Noce"
-- 12. Nolita "Mosaic Mosaic" stutter: fix 4 variant names

BEGIN;

-- ============================================================
-- 1. Seattle: merge duplicate products
-- ============================================================
-- "Seattle Blanco" (1 SKU) → merge into "Blanco" (1 SKU)
-- "Seattle Cinza"  (1 SKU) → merge into "Cinza"  (2 SKUs)
-- Then delete the empty duplicate products

-- Move SKU from "Seattle Blanco" to "Blanco"
UPDATE skus SET product_id = '6233a3a5-a9bc-471b-b55c-b73eb7640c31'
WHERE id = 'c55d60de-0274-4b9c-b2df-feaa0c6e2d5e';   -- I67170024 Seattle Blanco 12X24

-- Move SKU from "Seattle Cinza" to "Cinza"
UPDATE skus SET product_id = '4736733d-a149-441b-b8cf-017bc03cc469'
WHERE id = '386bab5b-435c-4647-8993-92807b2eb34f';   -- I67180024 Seattle Cinza 12X24

-- Rename the moved SKU variant names (strip "Seattle " prefix)
UPDATE skus SET variant_name = 'Blanco 12X24'
WHERE id = 'c55d60de-0274-4b9c-b2df-feaa0c6e2d5e';

UPDATE skus SET variant_name = 'Cinza 12X24'
WHERE id = '386bab5b-435c-4647-8993-92807b2eb34f';

-- Delete the now-empty "Seattle Blanco" and "Seattle Cinza" products
DELETE FROM products WHERE id IN (
  '3bd752d0-1d01-4819-8f10-6eb73b539997',  -- Seattle Blanco
  '045d43d8-fa6e-4c3d-996e-2ae6b18be9c0'   -- Seattle Cinza
);

-- ============================================================
-- 2. Tegel: delete 4 orphan products (0 SKUs, 0 images)
-- ============================================================
DELETE FROM products WHERE id IN (
  '9ffc3a25-1df2-4fa7-86e0-aa834c8f5b1e',  -- Tegel Forest
  '079d2fd4-9715-4c44-9080-eb26f100aa62',  -- Tegel Off White
  'f63f3d37-acb9-4238-8a94-424292b4b64c',  -- Tegel Taupe
  'bc052906-c8d8-4132-b98b-df4ee9fe6fd6'   -- Tegel Terra
);

-- ============================================================
-- 3. Pavers/Pro Max: delete 3 orphan products (0 SKUs, 0 images)
-- ============================================================
DELETE FROM products WHERE id IN (
  '939d343b-3ed5-4672-ac2c-bd819b22a175',  -- Pavers > 20mm Serena Crosscut Bone
  'e1209cd1-190b-45af-a801-ab1db2b8ea2f',  -- Pavers > 20mm Serena Crosscut Moka
  '9c68c2d2-8b3d-4bb6-9630-990b083a5f92'   -- Pro Max > Riviere Cacao
);

-- ============================================================
-- 4. Color attribute contamination: fix 2 remaining Seattle entries
-- ============================================================
-- These were missed by the earlier fix_roca_color_attributes.sql migration
UPDATE sku_attributes SET value = 'Blanco'
WHERE sku_id = 'c55d60de-0274-4b9c-b2df-feaa0c6e2d5e'
  AND attribute_id = (SELECT id FROM attributes WHERE name = 'Color')
  AND value = 'Seattle Blanco';

UPDATE sku_attributes SET value = 'Cinza'
WHERE sku_id = '386bab5b-435c-4647-8993-92807b2eb34f'
  AND attribute_id = (SELECT id FROM attributes WHERE name = 'Color')
  AND value = 'Seattle Cinza';

-- ============================================================
-- 5. Nolita: reclassify field tiles from accessory to main
-- ============================================================
-- 8 field tile SKUs (12X24, 24X48) are incorrectly marked as accessory/unit
-- Bullnose and Mosaic SKUs correctly remain as accessories
UPDATE skus SET variant_type = NULL, sell_by = 'box'
WHERE id IN (
  'ec5dbf6a-7023-4a0d-8d42-ae0259bb07e8',  -- Antracita Field 12X24
  'c79f47df-acc7-446e-a83b-8941deebb7b5',  -- Antracita Field 24X48
  'e5a9da58-868d-4410-b481-ebb2f79b1bfd',  -- Blanco Field 12X24
  '34b40c18-7d86-48c1-a191-72fe92a995cc',  -- Blanco Field 24X48
  '85416ad9-c745-4172-9570-798ca1efe2d8',  -- Grafito Field 12X24
  '1a5f5d6a-f27f-4668-aa92-77766103a4e5',  -- Grafito Field 24X48
  '3ac9e485-2e38-43a2-b0d3-c770cfbdcdb2',  -- Gris Field 12X24
  'fa55a125-3067-4b17-8d3b-dd1ab8c4ebba'   -- Gris Field 24X48
);

-- ============================================================
-- 6. Forge: set missing variant_type = 'accessory' for trim SKUs
-- ============================================================
-- 8 trim SKUs (Bullnose, Inside/Outside Corner) have empty variant_type
-- The Cove Quarry SKUs already correctly have variant_type = 'accessory'
UPDATE skus SET variant_type = 'accessory'
WHERE id IN (
  '7da42992-7b1f-47ab-89a9-4230bf6d36e0',  -- Sahara Bullnose Quarry
  '512151b1-28da-4ee4-a1a1-0c0c8f637de5',  -- Sahara Smooth Inside Corner
  '96fbe346-5570-4b5e-9672-5db5aaa6ca4c',  -- Sahara Smooth Outside Corner
  'd605d4f2-2cc7-43cc-821c-ed69de9d61b0',  -- Spanish Gray Smooth Inside Corner
  '218664fb-e5b4-4d73-b7dc-b9abe12ef543',  -- Spanish Gray Smooth Outside Corner
  'b4c1fb95-6d90-4cb0-a61e-4337fa3d1e34',  -- Spanish Red Bullnose Quarry
  '7d4553d5-0e60-42b1-9c29-6c0b0be315ec',  -- Spanish Red Inside Corner
  '59a32cba-b83b-44d0-814d-38efe60e3a27'   -- Spanish Red Outside Corner
);

-- ============================================================
-- 7. Maiolica Crackled: reassign 6 misattributed bullnose SKUs
-- ============================================================
-- All 6 bullnose SKUs are on the generic "Crackled" product but belong
-- to specific color products. Letter code mapping:
--   A = Aqua, B = Biscuit, G = Tender Gray, W = White, S = Blue Steel, T = Taupe

-- Move SKUs to their correct color products
UPDATE skus SET product_id = '14a3a579-693f-4cd9-af54-5743ef0a9609',  -- Crackled Aqua
               variant_name = 'Crackled Aqua Bullnose 3X12',
               variant_type = 'accessory'
WHERE id = '6a8b347e-1459-4d38-b2bd-a0ba598830d5';  -- UMAICABN312

UPDATE skus SET product_id = '70a4cd90-f5c9-4291-b6f2-2595fa5d5b08',  -- Crackled Biscuit
               variant_name = 'Crackled Biscuit Bullnose 3X12',
               variant_type = 'accessory'
WHERE id = '904f788c-4b0b-4308-855c-31832771edf2';  -- UMAICBBN312

UPDATE skus SET product_id = 'd3dc8ad6-78f7-479c-a090-7e8fa199e250',  -- Crackled Tender Gray
               variant_name = 'Crackled Tender Gray Bullnose 3X12',
               variant_type = 'accessory'
WHERE id = '5a7c2a1e-fb1d-42f1-a876-a1abe927bff9';  -- UMAICGBN312

UPDATE skus SET product_id = '7ccac82b-3059-443e-9b14-80c6353f11be',  -- Crackled White
               variant_name = 'Crackled White Bullnose 3X12',
               variant_type = 'accessory'
WHERE id = '66502361-bb2e-4993-9970-5747e4a21d24';  -- UMAICWBN312

UPDATE skus SET product_id = '7ee860e3-2096-42d2-8260-ab6a32afd35a',  -- Crackled Blue Steel
               variant_name = 'Crackled Blue Steel Bullnose 3X12',
               variant_type = 'accessory'
WHERE id = '6e3d9a73-014d-49bd-bbe3-4f0fd0dbab27';  -- UMAICSBN312

UPDATE skus SET product_id = '17cac1d7-c139-4c07-ab97-495624f2aa90',  -- Crackled Taupe
               variant_name = 'Crackled Taupe Bullnose 3X12',
               variant_type = 'accessory'
WHERE id = '798b0071-99a5-4807-b8a9-216007f3e61c';  -- UMAICTBN312

-- Delete the now-empty "Crackled" product (had only the 6 misattributed SKUs)
-- First clean up any media_assets referencing this product
DELETE FROM media_assets WHERE product_id = '2dff6628-6c86-4818-992c-59d702d1f7f7';
DELETE FROM products WHERE id = '2dff6628-6c86-4818-992c-59d702d1f7f7';

-- ============================================================
-- 8. Fix quote-mangled variant names
-- ============================================================

-- Pattern A: Color Collection — 'X " Bullnose 3X6 3"' → 'X 3" Bullnose 3X6'
-- These had the 3" size displaced to the end
UPDATE skus SET variant_name = regexp_replace(variant_name, '" Bullnose 3X6 3"$', '3" Bullnose 3X6')
WHERE id IN (
  '2206b3d0-659c-4f56-909c-db6a056c3c12',  -- Biscuit " Bullnose 3X6 3"
  '0f9f7fe4-5dc1-4714-ab36-1e43eea28388',  -- Biscuit " Bullnose 3X6 3" (dup)
  '124c0a4d-7eed-4df8-96fc-ebab768152da',  -- Black " Bullnose 3X6 3"
  'd9c0491e-eb19-4dc6-9240-81498a51778e',  -- Cocoa " Bullnose 3X6 3"
  'e2bf1731-6a6e-4403-8380-e3d650c3a6af',  -- Red Pepper " Bullnose 3X6 3"
  '6b68aac4-ee45-4773-9db1-8f07bbca15b1',  -- Snow White " Bullnose 3X6 3"
  'dbb028eb-5d9a-4a4c-875f-a4e55b149623',  -- Taupe " Bullnose 3X6 3"
  '5818415f-82cd-458e-a80d-fd0e42467c2e',  -- Tender Gray " Bullnose 3X6 3"
  'ff040d3d-141d-405d-836c-88f8245060b5',  -- Tender Gray " Bullnose 3X6 3" (dup)
  'd5b693c4-89c5-4735-9cef-02538c7d2735',  -- White Ice " Bullnose 3X6 3"
  '0f683962-68f0-402b-920e-07069a51f64e'   -- White Ice " Bullnose 3X6 3" (dup)
);

-- Pattern B: Maiolica — 'X " Bullnose WXH"' → 'X Bullnose WXH'
-- Stray inch marks around bullnose size
UPDATE skus SET variant_name = regexp_replace(variant_name, ' " Bullnose (\d+X\d+)"', ' Bullnose \1')
WHERE id IN (
  'ec63bd6b-6e03-4c31-8a3e-9500804e0f87',  -- Aqua " Bullnose 3X10"
  'ac5b59fe-3d2a-4a45-bd31-378b63a126fb',  -- Aqua " Bullnose 3X10" (dup)
  'f7a77e9a-6c7a-47de-93b9-ec2b9b8ba034',  -- Aqua " Bullnose 3X6"
  'de7e58b3-f935-46a5-bffa-f31f46c549c0',  -- Biscuit " Bullnose 3X10"
  '6f9657d6-1759-49c4-8015-1c796b81c94b',  -- Biscuit " Bullnose 3X6"
  'eec559b2-6a36-4443-937a-e70fe96a675d',  -- Blue Steel " Bullnose 3X10"
  'dce6bdf2-1ddb-4dd1-8bb6-f44ac963d163',  -- Blue Steel " Bullnose 3X6"
  '61a26bf7-22ee-4381-b5d9-6e02d3e2112e',  -- Taupe " Bullnose 3X10"
  '44f55b2c-0e7e-47a9-9c4f-7a360c3eb63a',  -- Taupe " Bullnose 3X10" (dup)
  '38703078-97de-4bd0-8514-a88f6482e6a3',  -- Taupe " Bullnose 3X6"
  '4450ab39-8ef1-487b-bec8-85d2ae635205',  -- Tender Gray " Bullnose 3X10"
  '9f5275d7-7488-4476-a65c-7b892372c613',  -- Tender Gray " Bullnose 3X10" (dup)
  'd32394ff-a5e2-4c91-b36d-3a304ffbdf2c',  -- Tender Gray " Bullnose 3X6"
  'e588f7b3-0e08-4d02-8bdf-a252b930c5ea',  -- White " Bullnose 3X10"
  '9e10f204-d1ce-42f3-9fbe-5a40a11a73cd'   -- White " Bullnose 3X6"
);

-- Pattern C: Terre/Room — 'X 12"X36"' → 'X 12X36' (normalize dimension inch marks)
UPDATE skus SET variant_name = regexp_replace(variant_name, '(\d+)"X(\d+)"', '\1X\2')
WHERE id IN (
  '8637b032-41ad-46d0-a16c-65cf97621a91',  -- Beige 12"X36"
  'c05d9ac7-7482-43b9-9658-c54634acc37d',  -- Blanco 12"X36"
  '2b7cdd2f-9fc1-408b-8d56-91db55bd3da9',  -- Deko Beige 12"X36"
  'a3da16c0-9af8-4f2f-8971-f6f70a693ec4',  -- Deko Gris 12"X36"
  '5aedd375-db0f-4ce9-ae44-e7867b517c5a',  -- Grafito 12"X36"
  'dc46eea4-7ba7-41d1-a5fb-08b3322a8218',  -- Gris 12"X36"
  '284a0861-25c0-421c-b6bc-2d78f3118700',  -- Blanco A 12"X36"
  '96de748e-3d02-4ffe-a966-2c721902eb7d'   -- Blanco B 12"X36"
);

-- Pattern D: Brick Metallic — 'Cobre 3"X12"' → 'Cobre 3X12'
UPDATE skus SET variant_name = regexp_replace(variant_name, '(\d+)"X(\d+)"', '\1X\2')
WHERE id = 'f4ef9e01-17cd-449f-82d1-e5aa4d9aa218';  -- Cobre 3"X12"

-- ============================================================
-- 9. Duplicate SKU dedup: remove 93 duplicate SKUs
-- ============================================================
-- Duplicates are SKUs with the same (product_id, variant_name) but different
-- vendor_skus — caused by double-import from regular + special order price sheets.
-- Strategy: keep the first SKU (by created_at), delete subsequent duplicates.
-- No order_items, cart_items, quote_items, or estimate_items reference these SKUs.

-- Collect duplicate SKU IDs to delete into a temp table
CREATE TEMP TABLE roca_dup_skus_to_delete AS
WITH ranked AS (
  SELECT s.id,
         ROW_NUMBER() OVER (
           PARTITION BY s.product_id, s.variant_name
           ORDER BY s.created_at, s.vendor_sku
         ) AS rn
  FROM skus s
  JOIN products p ON p.id = s.product_id
  WHERE p.vendor_id = 'b898517d-1643-4158-a92f-bf494bb69ef0'
)
SELECT id FROM ranked WHERE rn > 1;

-- Cascade delete through all referencing tables (none have ON DELETE CASCADE
-- except inventory_snapshots, sku_accessories, stock_alerts)
DELETE FROM pricing WHERE sku_id IN (SELECT id FROM roca_dup_skus_to_delete);
DELETE FROM sku_attributes WHERE sku_id IN (SELECT id FROM roca_dup_skus_to_delete);
DELETE FROM packaging WHERE sku_id IN (SELECT id FROM roca_dup_skus_to_delete);
DELETE FROM media_assets WHERE sku_id IN (SELECT id FROM roca_dup_skus_to_delete);
DELETE FROM trade_favorite_items WHERE sku_id IN (SELECT id FROM roca_dup_skus_to_delete);
DELETE FROM sample_request_items WHERE sku_id IN (SELECT id FROM roca_dup_skus_to_delete);
DELETE FROM showroom_visit_items WHERE sku_id IN (SELECT id FROM roca_dup_skus_to_delete);
DELETE FROM purchase_order_items WHERE sku_id IN (SELECT id FROM roca_dup_skus_to_delete);

-- Now delete the duplicate SKUs themselves
DELETE FROM skus WHERE id IN (SELECT id FROM roca_dup_skus_to_delete);

DROP TABLE roca_dup_skus_to_delete;

-- ============================================================
-- 10. Terra di Siena: rename self-referencing product
-- ============================================================
-- Product named "Terra di Siena" inside collection "Terra di Siena"
-- The variant_name is "Terra di Siena 35X35" suggesting it's the standard finish
UPDATE products SET name = 'Natural'
WHERE id = '00fcb9d0-9c16-490a-a30b-7b648562e126';

-- ============================================================
-- 11. Indiana: fix "Nocce" misspelling → "Noce"
-- ============================================================
UPDATE products SET name = 'Noce'
WHERE id = 'c4182e42-c931-4841-82f2-e77834c7a00b';

-- Fix the Color attribute if it also says "Nocce"
UPDATE sku_attributes SET value = 'Noce'
WHERE sku_id IN (SELECT id FROM skus WHERE product_id = 'c4182e42-c931-4841-82f2-e77834c7a00b')
  AND attribute_id = (SELECT id FROM attributes WHERE name = 'Color')
  AND value = 'Nocce';

-- Fix variant names that contain "Nocce"
UPDATE skus SET variant_name = regexp_replace(variant_name, 'Nocce', 'Noce')
WHERE product_id = 'c4182e42-c931-4841-82f2-e77834c7a00b'
  AND variant_name LIKE '%Nocce%';

-- ============================================================
-- 12. Nolita: fix "Mosaic Mosaic" stutter in variant names
-- ============================================================
UPDATE skus SET variant_name = regexp_replace(variant_name, 'Mosaic Mosaic', 'Mosaic')
WHERE id IN (
  '3bce36bd-0b98-43ae-b3dd-279b9660c8f9',  -- Antracita Mosaic Mosaic 12X12
  'de97dd08-b79f-4fbe-a4a1-646aa3d25ec9',  -- Blanco Mosaic Mosaic 12X12
  'b7b535ea-3311-4c0d-a69d-5fee95777742',  -- Grafito Mosaic Mosaic 12X12
  '8ac25c4d-cbba-410e-8717-c10d6866f9f1'   -- Gris Mosaic Mosaic 12X12
);

-- ============================================================
-- Verification queries (check results before committing)
-- ============================================================

-- Should return 0: no more duplicate product names in Seattle
-- SELECT collection, name, COUNT(*) FROM products
-- WHERE vendor_id = 'b898517d-1643-4158-a92f-bf494bb69ef0' AND collection = 'Seattle'
-- GROUP BY collection, name HAVING COUNT(*) > 1;

-- Should return 0: no more orphan products with 0 SKUs in Tegel
-- SELECT p.id, p.name FROM products p
-- WHERE p.vendor_id = 'b898517d-1643-4158-a92f-bf494bb69ef0' AND p.collection = 'Tegel'
--   AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id);

-- Should return 0: no more duplicate SKU variant names
-- SELECT p.collection, p.name, s.variant_name, COUNT(*)
-- FROM products p JOIN skus s ON s.product_id = p.id
-- WHERE p.vendor_id = 'b898517d-1643-4158-a92f-bf494bb69ef0'
-- GROUP BY p.collection, p.name, s.variant_name HAVING COUNT(*) > 1;

COMMIT;
