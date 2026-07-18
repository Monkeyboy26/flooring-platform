-- Migration 021: Split Avalon and Avenue out of the Aura collection
--
-- Root cause: The Roca pricebook has "AVALON-GLAZED PORCELAIN" and
-- "AVENUE-GLAZED PORCELAIN" (no spaces around dash), so the import
-- parser didn't recognize them as collection headers. All their
-- products got absorbed into the preceding "Aura" collection.
--
-- Fixes:
--   1. Move 4 Avalon products to new "Avalon" collection
--   2. Move 2 Avenue products to new "Avenue" collection
--   3. Strip collection prefix from product names (Avalon Arena → Arena)
--   4. Strip collection prefix from variant names
--   5. Fix Color attributes (remove collection prefix)
--   6. Fix Material attributes (Ceramic Wall → Glazed Porcelain)
--   7. Fix categories (Backsplash & Wall Tile → Porcelain Tile for floor tiles)
--
-- After: Aura retains 3 genuine products (Aquamarine, Ocean Blue, Seashell)

BEGIN;

-- ============================================================
-- 1 & 2. Move products to correct collections
-- ============================================================

-- Avalon products
UPDATE products SET collection = 'Avalon'
WHERE id IN (
  '1fa838fd-46a7-42d0-8573-d2f29fab079c',  -- Avalon Arena
  '2d091769-64ec-4f16-9865-47028301026d',  -- Avalon Blanco
  '8a225696-ecdb-4b3a-8d35-30dbcb7492db',  -- Avalon Arena Mosaic
  'c193a2c7-cfed-4a14-8453-c9a8cc33ca78'   -- Avalon Blanco Mosaic
);

-- Avenue products
UPDATE products SET collection = 'Avenue'
WHERE id IN (
  'd02d1c6b-4275-45d9-a00b-076c6e225c8a',  -- Avenue Gold
  '5defc4b1-f811-4da4-b187-94d50ce83789'   -- Avenue Gray
);

-- ============================================================
-- 3. Strip collection prefix from product names
-- ============================================================

-- Avalon: "Avalon Arena" → "Arena", etc.
UPDATE products SET name = 'Arena'        WHERE id = '1fa838fd-46a7-42d0-8573-d2f29fab079c';
UPDATE products SET name = 'Blanco'       WHERE id = '2d091769-64ec-4f16-9865-47028301026d';
UPDATE products SET name = 'Arena Mosaic' WHERE id = '8a225696-ecdb-4b3a-8d35-30dbcb7492db';
UPDATE products SET name = 'Blanco Mosaic' WHERE id = 'c193a2c7-cfed-4a14-8453-c9a8cc33ca78';

-- Avenue: "Avenue Gold" → "Gold", etc.
UPDATE products SET name = 'Gold' WHERE id = 'd02d1c6b-4275-45d9-a00b-076c6e225c8a';
UPDATE products SET name = 'Gray' WHERE id = '5defc4b1-f811-4da4-b187-94d50ce83789';

-- ============================================================
-- 4. Strip collection prefix from variant names
-- ============================================================

-- Avalon Arena: "Avalon Arena 12X24" → "Arena 12X24"
UPDATE skus SET variant_name = regexp_replace(variant_name, '^Avalon Arena ', 'Arena ')
WHERE product_id = '1fa838fd-46a7-42d0-8573-d2f29fab079c';

-- Avalon Blanco: "Avalon Blanco 12X24" → "Blanco 12X24"
UPDATE skus SET variant_name = regexp_replace(variant_name, '^Avalon Blanco ', 'Blanco ')
WHERE product_id = '2d091769-64ec-4f16-9865-47028301026d';

-- Avalon Arena Mosaic: "Avalon Arena Mosaic 12X12" → "Arena Mosaic 12X12"
UPDATE skus SET variant_name = regexp_replace(variant_name, '^Avalon Arena Mosaic ', 'Arena Mosaic ')
WHERE product_id = '8a225696-ecdb-4b3a-8d35-30dbcb7492db';

-- Avalon Blanco Mosaic: "Avalon Blanco Mosaic 12X12" → "Blanco Mosaic 12X12"
UPDATE skus SET variant_name = regexp_replace(variant_name, '^Avalon Blanco Mosaic ', 'Blanco Mosaic ')
WHERE product_id = 'c193a2c7-cfed-4a14-8453-c9a8cc33ca78';

-- Avenue Gold: "Avenue Gold 21X21" → "Gold 21X21"
UPDATE skus SET variant_name = regexp_replace(variant_name, '^Avenue Gold ', 'Gold ')
WHERE product_id = 'd02d1c6b-4275-45d9-a00b-076c6e225c8a';

-- Avenue Gray: "Avenue Gray 21X21" → "Gray 21X21"
UPDATE skus SET variant_name = regexp_replace(variant_name, '^Avenue Gray ', 'Gray ')
WHERE product_id = '5defc4b1-f811-4da4-b187-94d50ce83789';

-- ============================================================
-- 5. Fix Color attributes (strip collection prefix)
-- ============================================================

-- Avalon Arena SKUs: "Avalon Arena" → "Arena"
UPDATE sku_attributes SET value = 'Arena'
WHERE attribute_id = (SELECT id FROM attributes WHERE name = 'Color')
  AND value = 'Avalon Arena'
  AND sku_id IN (SELECT id FROM skus WHERE product_id = '1fa838fd-46a7-42d0-8573-d2f29fab079c');

-- Avalon Blanco SKUs: "Avalon Blanco" → "Blanco"
UPDATE sku_attributes SET value = 'Blanco'
WHERE attribute_id = (SELECT id FROM attributes WHERE name = 'Color')
  AND value = 'Avalon Blanco'
  AND sku_id IN (SELECT id FROM skus WHERE product_id = '2d091769-64ec-4f16-9865-47028301026d');

-- Avalon Arena Mosaic: "Avalon Arena Mosaic" → "Arena Mosaic"
UPDATE sku_attributes SET value = 'Arena Mosaic'
WHERE attribute_id = (SELECT id FROM attributes WHERE name = 'Color')
  AND value = 'Avalon Arena Mosaic'
  AND sku_id IN (SELECT id FROM skus WHERE product_id = '8a225696-ecdb-4b3a-8d35-30dbcb7492db');

-- Avalon Blanco Mosaic: "Avalon Blanco Mosaic" → "Blanco Mosaic"
UPDATE sku_attributes SET value = 'Blanco Mosaic'
WHERE attribute_id = (SELECT id FROM attributes WHERE name = 'Color')
  AND value = 'Avalon Blanco Mosaic'
  AND sku_id IN (SELECT id FROM skus WHERE product_id = 'c193a2c7-cfed-4a14-8453-c9a8cc33ca78');

-- Avenue Gold: "Avenue Gold" → "Gold"
UPDATE sku_attributes SET value = 'Gold'
WHERE attribute_id = (SELECT id FROM attributes WHERE name = 'Color')
  AND value = 'Avenue Gold'
  AND sku_id IN (SELECT id FROM skus WHERE product_id = 'd02d1c6b-4275-45d9-a00b-076c6e225c8a');

-- Avenue Gray: "Avenue Gray" → "Gray"
UPDATE sku_attributes SET value = 'Gray'
WHERE attribute_id = (SELECT id FROM attributes WHERE name = 'Color')
  AND value = 'Avenue Gray'
  AND sku_id IN (SELECT id FROM skus WHERE product_id = '5defc4b1-f811-4da4-b187-94d50ce83789');

-- ============================================================
-- 6. Fix Material attributes
-- ============================================================
-- Avalon and Avenue are "GLAZED PORCELAIN" per the pricebook,
-- but inherited "Ceramic Wall" from the Aura collection header.

-- All Avalon SKUs (field + mosaic)
UPDATE sku_attributes SET value = 'Glazed Porcelain'
WHERE attribute_id = (SELECT id FROM attributes WHERE name = 'Material')
  AND value = 'Ceramic Wall'
  AND sku_id IN (
    SELECT s.id FROM skus s WHERE s.product_id IN (
      '1fa838fd-46a7-42d0-8573-d2f29fab079c',
      '2d091769-64ec-4f16-9865-47028301026d',
      '8a225696-ecdb-4b3a-8d35-30dbcb7492db',
      'c193a2c7-cfed-4a14-8453-c9a8cc33ca78'
    )
  );

-- All Avenue SKUs
UPDATE sku_attributes SET value = 'Glazed Porcelain'
WHERE attribute_id = (SELECT id FROM attributes WHERE name = 'Material')
  AND value = 'Ceramic Wall'
  AND sku_id IN (
    SELECT s.id FROM skus s WHERE s.product_id IN (
      'd02d1c6b-4275-45d9-a00b-076c6e225c8a',
      '5defc4b1-f811-4da4-b187-94d50ce83789'
    )
  );

-- ============================================================
-- 7. Fix categories
-- ============================================================
-- Avalon floor tiles and Avenue are porcelain floor tiles, not wall tile.
-- Mosaics stay as Mosaic Tile (already correct).

-- Avalon Arena + Avalon Blanco: Backsplash & Wall Tile → Porcelain Tile
UPDATE products SET category_id = '650e8400-e29b-41d4-a716-446655440012'  -- Porcelain Tile
WHERE id IN (
  '1fa838fd-46a7-42d0-8573-d2f29fab079c',  -- Arena
  '2d091769-64ec-4f16-9865-47028301026d'   -- Blanco
);

-- Avenue Gold + Avenue Gray: Backsplash & Wall Tile → Porcelain Tile
UPDATE products SET category_id = '650e8400-e29b-41d4-a716-446655440012'  -- Porcelain Tile
WHERE id IN (
  'd02d1c6b-4275-45d9-a00b-076c6e225c8a',  -- Gold
  '5defc4b1-f811-4da4-b187-94d50ce83789'   -- Gray
);

COMMIT;
