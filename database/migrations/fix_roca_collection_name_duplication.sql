-- Fix Roca naming duplication: collection name redundantly embedded in product names
-- Affects 26 products across 8 collections
--
-- Three fix types:
--   A. Merge true duplicates (Seattle): duplicate products have identical SKUs as clean products
--   B. Merge + rename (Tegel): bullnose accessory SKUs on separate "Tegel X" products → move to clean "X" products
--   C. Rename only (Serena, Weston, Downtown, Terre, Onice Supreme): strip collection name from product/variant names

BEGIN;

-- ══════════════════════════════════════════════════════════════════
-- A. Seattle: deactivate duplicate products + SKUs (clean versions already exist)
-- ══════════════════════════════════════════════════════════════════
-- "Seattle Blanco" (1 SKU) duplicates "Blanco" (1 SKU) — same 12X24 field tile
-- "Seattle Cinza"  (1 SKU) duplicates "Cinza"  (2 SKUs) — same 12X24 field tile

-- Deactivate duplicate SKUs
UPDATE skus SET status = 'inactive'
WHERE product_id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON p.vendor_id = v.id
  WHERE v.code = 'ROCA'
    AND p.collection = 'Seattle'
    AND p.name IN ('Seattle Blanco', 'Seattle Cinza')
);

-- Deactivate duplicate products
UPDATE products SET status = 'inactive'
WHERE id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON p.vendor_id = v.id
  WHERE v.code = 'ROCA'
    AND p.collection = 'Seattle'
    AND p.name IN ('Seattle Blanco', 'Seattle Cinza')
);

-- ══════════════════════════════════════════════════════════════════
-- B. Tegel: move bullnose SKUs to clean products, rename, deactivate old products
-- ══════════════════════════════════════════════════════════════════
-- "Tegel Forest"    (Bullnose 3X6) → move to "Forest"    product, rename variant
-- "Tegel Off White" (Bullnose 3X6) → move to "Off White" product, rename variant
-- "Tegel Taupe"     (Bullnose 3X6) → move to "Taupe"     product, rename variant
-- "Tegel Terra"     (Bullnose 3X6) → move to "Terra"     product, rename variant

-- Move SKUs: update product_id to point to the clean product
UPDATE skus SET product_id = clean.id
FROM (
  SELECT dup.sku_id, clean_prod.id
  FROM (
    SELECT s.id AS sku_id, REPLACE(p.name, 'Tegel ', '') AS clean_name
    FROM skus s
    JOIN products p ON s.product_id = p.id
    JOIN vendors v ON p.vendor_id = v.id
    WHERE v.code = 'ROCA'
      AND p.collection = 'Tegel'
      AND p.name LIKE 'Tegel %'
  ) dup
  JOIN products clean_prod ON clean_prod.name = dup.clean_name
  JOIN vendors v2 ON clean_prod.vendor_id = v2.id
  WHERE v2.code = 'ROCA'
    AND clean_prod.collection = 'Tegel'
) clean
WHERE skus.id = clean.sku_id;

-- Rename variant names: strip "Tegel " prefix
UPDATE skus SET variant_name = REPLACE(variant_name, 'Tegel ', '')
WHERE id IN (
  SELECT s.id FROM skus s
  JOIN products p ON s.product_id = p.id
  JOIN vendors v ON p.vendor_id = v.id
  WHERE v.code = 'ROCA'
    AND p.collection = 'Tegel'
    AND s.variant_name LIKE 'Tegel %'
);

-- Deactivate the now-empty duplicate products
UPDATE products SET status = 'inactive'
WHERE id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON p.vendor_id = v.id
  WHERE v.code = 'ROCA'
    AND p.collection = 'Tegel'
    AND p.name LIKE 'Tegel %'
);

-- ══════════════════════════════════════════════════════════════════
-- C. Rename: strip collection name from product names and variant names
-- ══════════════════════════════════════════════════════════════════

-- C1. Serena (10 products): strip "Serena " from product and variant names
--   "Serena Crosscut Bone" → "Crosscut Bone"
--   "Mosaic Serena Crosscut Bone" → "Mosaic Crosscut Bone"
--   "20mm Serena Crosscut Bone" → "20mm Crosscut Bone"

UPDATE products SET name = TRIM(REGEXP_REPLACE(REPLACE(name, 'Serena ', ''), '\s{2,}', ' ', 'g'))
WHERE id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON p.vendor_id = v.id
  WHERE v.code = 'ROCA'
    AND p.collection = 'Serena'
    AND p.name LIKE '%Serena %'
    AND p.status = 'active'
);

UPDATE skus SET variant_name = TRIM(REGEXP_REPLACE(REPLACE(variant_name, 'Serena ', ''), '\s{2,}', ' ', 'g'))
WHERE product_id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON p.vendor_id = v.id
  WHERE v.code = 'ROCA'
    AND p.collection = 'Serena'
    AND p.status = 'active'
) AND variant_name LIKE '%Serena %';

-- C2. Weston (4 products): strip "Weston " prefix
--   "Weston Fd Us Beige" → "Fd Us Beige"

UPDATE products SET name = TRIM(REPLACE(name, 'Weston ', ''))
WHERE id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON p.vendor_id = v.id
  WHERE v.code = 'ROCA'
    AND p.collection = 'Weston'
    AND p.name LIKE 'Weston %'
    AND p.status = 'active'
);

UPDATE skus SET variant_name = TRIM(REPLACE(variant_name, 'Weston ', ''))
WHERE product_id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON p.vendor_id = v.id
  WHERE v.code = 'ROCA'
    AND p.collection = 'Weston'
    AND p.status = 'active'
) AND variant_name LIKE 'Weston %';

-- C3. Downtown (2 products): strip "Downtown " from middle
--   "Malla Downtown Blanco" → "Malla Blanco"

UPDATE products SET name = TRIM(REGEXP_REPLACE(REPLACE(name, 'Downtown ', ''), '\s{2,}', ' ', 'g'))
WHERE id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON p.vendor_id = v.id
  WHERE v.code = 'ROCA'
    AND p.collection = 'Downtown'
    AND p.name LIKE '%Downtown %'
    AND p.status = 'active'
);

UPDATE skus SET variant_name = TRIM(REGEXP_REPLACE(REPLACE(variant_name, 'Downtown ', ''), '\s{2,}', ' ', 'g'))
WHERE product_id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON p.vendor_id = v.id
  WHERE v.code = 'ROCA'
    AND p.collection = 'Downtown'
    AND p.status = 'active'
) AND variant_name LIKE '%Downtown %';

-- C4. Terre (2 products): strip "Terre " from middle
--   "Deko Terre Beige" → "Deko Beige"

UPDATE products SET name = TRIM(REGEXP_REPLACE(REPLACE(name, 'Terre ', ''), '\s{2,}', ' ', 'g'))
WHERE id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON p.vendor_id = v.id
  WHERE v.code = 'ROCA'
    AND p.collection = 'Terre'
    AND p.name LIKE '%Terre %'
    AND p.status = 'active'
);

UPDATE skus SET variant_name = TRIM(REGEXP_REPLACE(REPLACE(variant_name, 'Terre ', ''), '\s{2,}', ' ', 'g'))
WHERE product_id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON p.vendor_id = v.id
  WHERE v.code = 'ROCA'
    AND p.collection = 'Terre'
    AND p.status = 'active'
) AND variant_name LIKE '%Terre %';

-- C5. Onice Supreme (1 product): strip "Onice Supreme " from middle
--   "Marble Onice Supreme Marfil" → "Marble Marfil"

UPDATE products SET name = TRIM(REGEXP_REPLACE(REPLACE(name, 'Onice Supreme ', ''), '\s{2,}', ' ', 'g'))
WHERE id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON p.vendor_id = v.id
  WHERE v.code = 'ROCA'
    AND p.collection = 'Onice Supreme'
    AND p.name LIKE '%Onice Supreme %'
    AND p.status = 'active'
);

UPDATE skus SET variant_name = TRIM(REGEXP_REPLACE(REPLACE(variant_name, 'Onice Supreme ', ''), '\s{2,}', ' ', 'g'))
WHERE product_id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON p.vendor_id = v.id
  WHERE v.code = 'ROCA'
    AND p.collection = 'Onice Supreme'
    AND p.status = 'active'
) AND variant_name LIKE '%Onice Supreme %';

-- NOTE: Terra di Siena skipped — product name equals collection name, stripping leaves nothing.
-- "Terra di Siena" in collection "Terra di Siena" is not duplication, it's the only name.

-- ══════════════════════════════════════════════════════════════════
-- Refresh search vectors for all affected Roca products
-- ══════════════════════════════════════════════════════════════════
SELECT refresh_search_vectors(id) FROM products
WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'ROCA')
  AND status = 'active';

COMMIT;
