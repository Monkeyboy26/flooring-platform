-- Fix Bedrosians categorization: split mixed-shape products, recategorize
-- Run inside: docker exec flooring-db psql -U postgres -d flooring_pim -f /fix_bedrosians_categorization.sql

BEGIN;

-- ═══════════════════════════════════════════════════════════════
-- 1. Move ledger/stacked-stone products to stacked-stone category
-- ═══════════════════════════════════════════════════════════════
UPDATE products SET category_id = (SELECT id FROM categories WHERE slug = 'stacked-stone')
WHERE vendor_id = '550e8400-e29b-41d4-a716-446655440002'
  AND status = 'active'
  AND (name ILIKE '%ledger%' OR collection ILIKE '%ledger%')
  AND category_id != (SELECT id FROM categories WHERE slug = 'stacked-stone');

-- Split-face variants that are stacked stone (only update products where ALL variants are split face)
UPDATE products SET category_id = (SELECT id FROM categories WHERE slug = 'stacked-stone')
WHERE vendor_id = '550e8400-e29b-41d4-a716-446655440002'
  AND status = 'active'
  AND id IN (
    SELECT p.id FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = '550e8400-e29b-41d4-a716-446655440002'
    GROUP BY p.id
    HAVING bool_and(s.variant_name ILIKE '%split face%')
  );

-- ═══════════════════════════════════════════════════════════════
-- 2. Create new "Mosaic" products for mosaic-shape SKUs currently
--    under non-mosaic products (mixed-shape products)
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  mosaic_cat_id UUID := (SELECT id FROM categories WHERE slug = 'mosaic-tile');
  wall_cat_id UUID := (SELECT id FROM categories WHERE slug = 'backsplash-wall');
  vendor UUID := '550e8400-e29b-41d4-a716-446655440002';
  rec RECORD;
  new_product_id UUID;
BEGIN
  -- ── Mosaic splitting: mixed products ──
  FOR rec IN
    SELECT DISTINCT p.id as product_id, p.name, p.collection, p.description_short, p.description_long
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = vendor
      AND p.status = 'active'
      AND p.category_id != mosaic_cat_id
      AND EXISTS (
        SELECT 1 FROM skus s2 WHERE s2.product_id = p.id
        AND (s2.variant_name ~* 'mosaic|penny round|hexagon|herringbone|basketweave|arabesque|picket|diamond|lantern|fan|chevron')
      )
      AND EXISTS (
        SELECT 1 FROM skus s3 WHERE s3.product_id = p.id
        AND NOT (s3.variant_name ~* 'mosaic|penny round|hexagon|herringbone|basketweave|arabesque|picket|diamond|lantern|fan|chevron')
      )
  LOOP
    -- Create new mosaic product (unique key: vendor_id, collection, name)
    INSERT INTO products (vendor_id, name, collection, category_id, description_short, description_long, status)
    VALUES (vendor, rec.name || ' Mosaic', rec.collection || ' Mosaics', mosaic_cat_id, rec.description_short, rec.description_long, 'active')
    ON CONFLICT (vendor_id, collection, name) DO UPDATE SET
      category_id = mosaic_cat_id
    RETURNING id INTO new_product_id;

    -- Move mosaic SKUs to the new product
    UPDATE skus SET product_id = new_product_id
    WHERE product_id = rec.product_id
      AND (variant_name ~* 'mosaic|penny round|hexagon|herringbone|basketweave|arabesque|picket|diamond|lantern|fan|chevron');

    -- Move media_assets for those SKUs
    UPDATE media_assets SET product_id = new_product_id
    WHERE sku_id IN (SELECT id FROM skus WHERE product_id = new_product_id)
      AND product_id = rec.product_id;

    RAISE NOTICE 'Split mosaics from "%" → "% Mosaic"', rec.name, rec.name;
  END LOOP;

  -- ── Products that are ALL mosaics (not mixed) — just recategorize ──
  UPDATE products SET category_id = mosaic_cat_id
  WHERE vendor_id = vendor
    AND status = 'active'
    AND category_id != mosaic_cat_id
    AND id IN (
      SELECT p.id FROM products p
      JOIN skus s ON s.product_id = p.id
      WHERE p.vendor_id = vendor
      GROUP BY p.id
      HAVING bool_and(s.variant_name ~* 'mosaic|penny round|hexagon|herringbone|basketweave|arabesque|picket|diamond|lantern|fan|chevron')
    );

  -- ── Wall tile splitting: mixed products ──
  FOR rec IN
    SELECT DISTINCT p.id as product_id, p.name, p.collection, p.description_short, p.description_long
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = vendor
      AND p.status = 'active'
      AND p.category_id != wall_cat_id
      AND EXISTS (
        SELECT 1 FROM skus s2 WHERE s2.product_id = p.id
        AND s2.variant_name ILIKE '%wall tile%'
      )
      AND EXISTS (
        SELECT 1 FROM skus s3 WHERE s3.product_id = p.id
        AND s3.variant_name NOT ILIKE '%wall tile%'
      )
  LOOP
    INSERT INTO products (vendor_id, name, collection, category_id, description_short, description_long, status)
    VALUES (vendor, rec.name || ' Wall Tile', rec.collection, wall_cat_id, rec.description_short, rec.description_long, 'active')
    ON CONFLICT (vendor_id, collection, name) DO UPDATE SET
      category_id = wall_cat_id
    RETURNING id INTO new_product_id;

    UPDATE skus SET product_id = new_product_id
    WHERE product_id = rec.product_id
      AND variant_name ILIKE '%wall tile%';

    UPDATE media_assets SET product_id = new_product_id
    WHERE sku_id IN (SELECT id FROM skus WHERE product_id = new_product_id)
      AND product_id = rec.product_id;

    RAISE NOTICE 'Split wall tiles from "%" → "% Wall Tile"', rec.name, rec.name;
  END LOOP;

  -- ── Products that are ALL wall tile — just recategorize ──
  UPDATE products SET category_id = wall_cat_id
  WHERE vendor_id = vendor
    AND status = 'active'
    AND category_id != wall_cat_id
    AND id IN (
      SELECT p.id FROM products p
      JOIN skus s ON s.product_id = p.id
      WHERE p.vendor_id = vendor
      GROUP BY p.id
      HAVING bool_and(s.variant_name ILIKE '%wall tile%')
    );
END $$;

-- ═══════════════════════════════════════════════════════════════
-- 3. Clean up: deactivate empty products (all SKUs moved out)
-- ═══════════════════════════════════════════════════════════════
UPDATE products SET status = 'inactive'
WHERE vendor_id = '550e8400-e29b-41d4-a716-446655440002'
  AND status = 'active'
  AND NOT EXISTS (SELECT 1 FROM skus WHERE product_id = products.id);

COMMIT;
