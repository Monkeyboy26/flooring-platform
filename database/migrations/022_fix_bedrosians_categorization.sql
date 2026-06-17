-- Migration 022: Fix Bedrosians categorization
-- Moves mosaics from Porcelain Tile / Natural Stone → Mosaic Tile
-- Moves porcelain slabs → Porcelain Slabs
-- Moves natural stone slabs → appropriate countertop categories

BEGIN;

-- ── 1. Move mosaics to Mosaic Tile ──
-- Match products with mosaic shape indicators in name or SKU attributes
UPDATE products p
SET category_id = (SELECT id FROM categories WHERE slug = 'mosaic-tile')
WHERE p.vendor_id = (SELECT id FROM vendors WHERE name ILIKE '%bedrosians%')
  AND p.category_id IN (
    SELECT id FROM categories WHERE slug IN ('porcelain-tile', 'natural-stone', 'ceramic-tile')
  )
  AND (
    -- Match mosaic shapes in product name
    p.name ~* '\y(mosaic|penny\s*round|hexagon|herringbone|basketweave|arabesque|picket|diamond|lantern|fan|chevron)\y'
    -- Or match via SKU attributes where shape indicates mosaic
    OR EXISTS (
      SELECT 1 FROM skus s
      JOIN sku_attributes sa ON sa.sku_id = s.id
      JOIN attributes a ON a.id = sa.attribute_id
      WHERE s.product_id = p.id
        AND a.slug = 'shape'
        AND sa.value ~* '\y(mosaic|penny\s*round|hexagon|herringbone|basketweave|arabesque|picket|diamond|lantern|fan|chevron)\y'
    )
  );

-- ── 2. Move porcelain slabs to Porcelain Slabs ──
-- Products with "slab" in name or SKU, sold by unit, in porcelain category
UPDATE products p
SET category_id = (SELECT id FROM categories WHERE slug = 'porcelain-slabs')
WHERE p.vendor_id = (SELECT id FROM vendors WHERE name ILIKE '%bedrosians%')
  AND p.category_id = (SELECT id FROM categories WHERE slug = 'porcelain-tile')
  AND EXISTS (
    SELECT 1 FROM skus s
    WHERE s.product_id = p.id
      AND s.sell_by = 'unit'
      AND (
        s.vendor_sku ILIKE '%SLAB%'
        OR p.name ~* '\yslab\y'
        OR p.name ~* '\ymagnifica\y'
      )
  );

-- ── 3. Move natural stone slabs to countertop categories ──
-- Marble/travertine/limestone/onyx slabs → Marble Countertops
UPDATE products p
SET category_id = (SELECT id FROM categories WHERE slug = 'marble-countertops')
WHERE p.vendor_id = (SELECT id FROM vendors WHERE name ILIKE '%bedrosians%')
  AND p.category_id = (SELECT id FROM categories WHERE slug = 'natural-stone')
  AND EXISTS (
    SELECT 1 FROM skus s
    WHERE s.product_id = p.id
      AND s.sell_by = 'unit'
      AND (s.vendor_sku ILIKE '%SLAB%' OR p.name ~* '\yslab\y')
  )
  AND EXISTS (
    SELECT 1 FROM skus s
    JOIN sku_attributes sa ON sa.sku_id = s.id
    JOIN attributes a ON a.id = sa.attribute_id
    WHERE s.product_id = p.id
      AND a.slug = 'material'
      AND sa.value ~* '\y(marble|travertine|limestone|onyx)\y'
  );

-- Quartzite slabs → Quartzite Countertops
UPDATE products p
SET category_id = (SELECT id FROM categories WHERE slug = 'quartzite-countertops')
WHERE p.vendor_id = (SELECT id FROM vendors WHERE name ILIKE '%bedrosians%')
  AND p.category_id = (SELECT id FROM categories WHERE slug = 'natural-stone')
  AND EXISTS (
    SELECT 1 FROM skus s
    WHERE s.product_id = p.id
      AND s.sell_by = 'unit'
      AND (s.vendor_sku ILIKE '%SLAB%' OR p.name ~* '\yslab\y')
  )
  AND EXISTS (
    SELECT 1 FROM skus s
    JOIN sku_attributes sa ON sa.sku_id = s.id
    JOIN attributes a ON a.id = sa.attribute_id
    WHERE s.product_id = p.id
      AND a.slug = 'material'
      AND sa.value ~* '\yquartzite\y'
  );

-- Granite slabs → Granite Countertops
UPDATE products p
SET category_id = (SELECT id FROM categories WHERE slug = 'granite-countertops')
WHERE p.vendor_id = (SELECT id FROM vendors WHERE name ILIKE '%bedrosians%')
  AND p.category_id = (SELECT id FROM categories WHERE slug = 'natural-stone')
  AND EXISTS (
    SELECT 1 FROM skus s
    WHERE s.product_id = p.id
      AND s.sell_by = 'unit'
      AND (s.vendor_sku ILIKE '%SLAB%' OR p.name ~* '\yslab\y')
  )
  AND EXISTS (
    SELECT 1 FROM skus s
    JOIN sku_attributes sa ON sa.sku_id = s.id
    JOIN attributes a ON a.id = sa.attribute_id
    WHERE s.product_id = p.id
      AND a.slug = 'material'
      AND sa.value ~* '\ygranite\y'
  );

-- Soapstone slabs → Soapstone Countertops
UPDATE products p
SET category_id = (SELECT id FROM categories WHERE slug = 'soapstone-countertops')
WHERE p.vendor_id = (SELECT id FROM vendors WHERE name ILIKE '%bedrosians%')
  AND p.category_id = (SELECT id FROM categories WHERE slug = 'natural-stone')
  AND EXISTS (
    SELECT 1 FROM skus s
    WHERE s.product_id = p.id
      AND s.sell_by = 'unit'
      AND (s.vendor_sku ILIKE '%SLAB%' OR p.name ~* '\yslab\y')
  )
  AND EXISTS (
    SELECT 1 FROM skus s
    JOIN sku_attributes sa ON sa.sku_id = s.id
    JOIN attributes a ON a.id = sa.attribute_id
    WHERE s.product_id = p.id
      AND a.slug = 'material'
      AND sa.value ~* '\ysoapstone\y'
  );

-- Catch-all: remaining natural stone slabs with sell_by=unit and SLAB in SKU
-- that didn't match a specific material → Marble Countertops (most common natural stone slab)
UPDATE products p
SET category_id = (SELECT id FROM categories WHERE slug = 'marble-countertops')
WHERE p.vendor_id = (SELECT id FROM vendors WHERE name ILIKE '%bedrosians%')
  AND p.category_id = (SELECT id FROM categories WHERE slug = 'natural-stone')
  AND EXISTS (
    SELECT 1 FROM skus s
    WHERE s.product_id = p.id
      AND s.sell_by = 'unit'
      AND (s.vendor_sku ILIKE '%SLAB%' OR p.name ~* '\yslab\y')
  );

COMMIT;
