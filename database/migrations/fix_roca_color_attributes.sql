-- Fix Roca Color attributes: strip collection name contamination from sku_attributes
-- The previous migration (fix_roca_collection_name_duplication.sql) cleaned product.name
-- and skus.variant_name but missed the Color attribute values in sku_attributes.
-- Affects 42 SKUs across 7 collections + 2 Statuary Wall edge cases.
-- No re-contamination risk: roca.js scraper only writes images, never Color attributes.

BEGIN;

-- ══════════════════════════════════════════════════════════════════
-- 1. Strip collection name from Color attributes (7 collections)
-- ══════════════════════════════════════════════════════════════════

-- 1a. Serena: "Serena Crosscut Bone" → "Crosscut Bone"
--            "Mosaic Serena Crosscut Bone" → "Mosaic Crosscut Bone"
--            "20mm Serena Crosscut Bone" → "20mm Crosscut Bone"
UPDATE sku_attributes SET value = TRIM(REGEXP_REPLACE(REPLACE(value, 'Serena ', ''), '\s{2,}', ' ', 'g'))
WHERE attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
  AND value LIKE '%Serena %'
  AND sku_id IN (
    SELECT s.id FROM skus s
    JOIN products p ON s.product_id = p.id
    JOIN vendors v ON p.vendor_id = v.id
    WHERE v.code = 'ROCA' AND p.collection = 'Serena' AND p.status = 'active'
  );

-- 1b. Weston: "Weston Fd Us Beige" → "Fd Us Beige"
UPDATE sku_attributes SET value = TRIM(REPLACE(value, 'Weston ', ''))
WHERE attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
  AND value LIKE 'Weston %'
  AND sku_id IN (
    SELECT s.id FROM skus s
    JOIN products p ON s.product_id = p.id
    JOIN vendors v ON p.vendor_id = v.id
    WHERE v.code = 'ROCA' AND p.collection = 'Weston' AND p.status = 'active'
  );

-- 1c. Downtown: "Malla Downtown Blanco" → "Malla Blanco"
UPDATE sku_attributes SET value = TRIM(REGEXP_REPLACE(REPLACE(value, 'Downtown ', ''), '\s{2,}', ' ', 'g'))
WHERE attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
  AND value LIKE '%Downtown %'
  AND sku_id IN (
    SELECT s.id FROM skus s
    JOIN products p ON s.product_id = p.id
    JOIN vendors v ON p.vendor_id = v.id
    WHERE v.code = 'ROCA' AND p.collection = 'Downtown' AND p.status = 'active'
  );

-- 1d. Terre: "Deko Terre Beige" → "Deko Beige"
UPDATE sku_attributes SET value = TRIM(REGEXP_REPLACE(REPLACE(value, 'Terre ', ''), '\s{2,}', ' ', 'g'))
WHERE attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
  AND value LIKE '%Terre %'
  AND sku_id IN (
    SELECT s.id FROM skus s
    JOIN products p ON s.product_id = p.id
    JOIN vendors v ON p.vendor_id = v.id
    WHERE v.code = 'ROCA' AND p.collection = 'Terre' AND p.status = 'active'
  );

-- 1e. Onice Supreme: "Marble Onice Supreme Marfil" → "Marble Marfil"
UPDATE sku_attributes SET value = TRIM(REGEXP_REPLACE(REPLACE(value, 'Onice Supreme ', ''), '\s{2,}', ' ', 'g'))
WHERE attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
  AND value LIKE '%Onice Supreme %'
  AND sku_id IN (
    SELECT s.id FROM skus s
    JOIN products p ON s.product_id = p.id
    JOIN vendors v ON p.vendor_id = v.id
    WHERE v.code = 'ROCA' AND p.collection = 'Onice Supreme' AND p.status = 'active'
  );

-- 1f. Tegel: "Tegel Forest" → "Forest", etc.
UPDATE sku_attributes SET value = TRIM(REPLACE(value, 'Tegel ', ''))
WHERE attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
  AND value LIKE 'Tegel %'
  AND sku_id IN (
    SELECT s.id FROM skus s
    JOIN products p ON s.product_id = p.id
    JOIN vendors v ON p.vendor_id = v.id
    WHERE v.code = 'ROCA' AND p.collection = 'Tegel' AND p.status = 'active'
  );

-- ══════════════════════════════════════════════════════════════════
-- 2. Fix Statuary Wall edge cases (2 SKUs)
-- ══════════════════════════════════════════════════════════════════
-- "Bright Bullnose 6X18" (product "Bright"): Color "Statuary" → "Bright"
-- "White Bullnose 3X12" (product "White"): Color "Statuary White" → "White"

UPDATE sku_attributes SET value = p.name
FROM skus s
JOIN products p ON s.product_id = p.id
JOIN vendors v ON p.vendor_id = v.id
WHERE sku_attributes.sku_id = s.id
  AND sku_attributes.attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
  AND v.code = 'ROCA'
  AND p.collection = 'Statuary Wall'
  AND sku_attributes.value IN ('Statuary', 'Statuary White')
  AND p.status = 'active';

-- ══════════════════════════════════════════════════════════════════
-- 3. Refresh search vectors for affected Roca products
-- ══════════════════════════════════════════════════════════════════
SELECT refresh_search_vectors(id) FROM products
WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'ROCA')
  AND status = 'active';

COMMIT;
