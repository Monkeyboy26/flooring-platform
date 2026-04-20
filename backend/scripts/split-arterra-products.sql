-- Split Arterra mega-products into individual stone products
-- Each stone code becomes its own product in collection "Arterra"

BEGIN;

-- Step 1: Create stone code → display name mapping
-- Merge related codes (CEMSIL/CEMSILL, FOSSNO/FOSSNOPAT, etc.)
CREATE TEMP TABLE arterra_stones (
  code TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  color TEXT NOT NULL
);

INSERT INTO arterra_stones (code, display_name, color) VALUES
  ('ARGTRA', 'Argento Travertino', 'Gray'),
  ('ATLGRI', 'Atlas Grigio', 'Gray'),
  ('BETANT', 'Beton Antracite', 'Charcoal'),
  ('BETBLA', 'Beton Blanco', 'White'),
  ('BETGRE', 'Beton Grey', 'Gray'),
  ('BLUSTO', 'Bluestone', 'Blue'),
  ('BLUSTOPAT', 'Bluestone', 'Blue'),
  ('CALBLA', 'Caldera Blanca', 'White'),
  ('CALGRI', 'Caldera Grigio', 'Gray'),
  ('CEMGRA', 'Cementique Gray', 'Charcoal'),
  ('CEMSIL', 'Cementique Silver', 'Gray'),
  ('CEMSILL', 'Cementique Silver', 'Gray'),
  ('CEMTAL', 'Cementique Taupe', 'Ivory'),
  ('CORAVO', 'Coral Avorio', 'Beige'),
  ('CORLABLA', 'Coralia Blanca', 'Ivory'),
  ('FAUNA', 'Fauna', 'Brown'),
  ('FOSSNO', 'Fossil Snow', 'White'),
  ('FOSSNOPAT', 'Fossil Snow', 'White'),
  ('GOLWHI', 'Golden White', 'White'),
  ('GRIALM', 'Gritzo Almond', 'Beige'),
  ('GRISAL', 'Gritzo Salt', 'White'),
  ('KAYZERBLA', 'Kaya Zermatta Blanca', 'White'),
  ('LIVBEI', 'Livingstyle Beige', 'Beige'),
  ('LIVCRE', 'Livingstyle Cream', 'Beige'),
  ('LIVPEA', 'Livingstyle Pearl', 'Gray'),
  ('LIVTRA', 'Livingstyle Travertino', 'Beige'),
  ('LUCANI', 'Lucca Antico', 'Gray'),
  ('LUCBET', 'Lucca Beton', 'Brown'),
  ('LUCCAN', 'Lucca Canitia', 'Gray'),
  ('LUNSIL', 'Luna Silver', 'Gray'),
  ('MIDMON', 'Montauk Black', 'Black'),
  ('MIDMST', 'Montauk Stone', 'Blue'),
  ('PRACAR', 'Prada Carrara', 'White'),
  ('PRACRE', 'Prada Cream', 'Beige'),
  ('PRAGRE', 'Prada Grey', 'Gray'),
  ('QUABEI', 'Quarzo Beige', 'Beige'),
  ('QUAGRA', 'Quarzo Gray', 'Gray'),
  ('QUASIL', 'Quarzo Silver', 'White'),
  ('QUAWHI', 'Quarzo White', 'White'),
  ('SORGRI', 'Soreno Grigio', 'Gray'),
  ('SORIVO', 'Soreno Ivory', 'Ivory'),
  ('SORTAU', 'Soreno Taupe', 'Beige'),
  ('TAJIVO', 'Taj Ivory', 'Ivory'),
  ('TERGLA', 'Terrazo Glacial', 'White'),
  ('TERGRI', 'Terrazo Gris', 'Gray'),
  ('TIEBEI', 'Tierra Beige', 'Beige'),
  ('TIEIVO', 'Tierra Ivory', 'Ivory'),
  ('TIEIVOPAT', 'Tierra Ivory', 'Ivory'),
  ('TRESIL', 'Travertino Silver', 'Gray'),
  ('TRUBLU', 'True Blue', 'Blue'),
  ('TRUBLUPAT', 'True Blue', 'Blue'),
  ('VORCHA', 'Vortex Charcoal', 'Charcoal'),
  ('VORIVO', 'Vortex Ivory', 'Ivory'),
  ('VORSIL', 'Vortex Silver', 'Gray'),
  ('VULGRE', 'Vulkon Grey', 'Gray'),
  ('VULNER', 'Vulkon Nero', 'Black'),
  ('ZEMBLA', 'Zemento Blanca', 'White'),
  ('ZEMNAC', 'Zemento Nacre', 'Beige');

-- Step 2: Extract stone code from each Arterra SKU
CREATE TEMP TABLE arterra_sku_map AS
SELECT
  s.id as sku_id,
  s.vendor_sku,
  p.id as old_product_id,
  p.vendor_id,
  p.category_id,
  CASE
    WHEN s.vendor_sku LIKE 'LPAVN%' THEN regexp_replace(s.vendor_sku, '^LPAVN([A-Z]+).*$', '\1')
    WHEN s.vendor_sku LIKE 'LCOPN%' THEN regexp_replace(s.vendor_sku, '^LCOPN([A-Z]+).*$', '\1')
    WHEN s.vendor_sku LIKE 'P-LPAVN%' THEN regexp_replace(s.vendor_sku, '^P-LPAVN([A-Z]+).*$', '\1')
    WHEN s.vendor_sku LIKE 'P-LCOPN%' THEN regexp_replace(s.vendor_sku, '^P-LCOPN([A-Z]+).*$', '\1')
    ELSE 'UNKNOWN'
  END as stone_code
FROM skus s
JOIN products p ON p.id = s.product_id
WHERE p.name ILIKE 'arterra %' AND p.status = 'active';

-- Step 3: Get distinct product names to create (avoid duplicates from merged codes)
CREATE TEMP TABLE arterra_new_products AS
SELECT DISTINCT ON (st.display_name)
  gen_random_uuid() as new_id,
  m.vendor_id,
  'Arterra ' || st.display_name || ' ' || st.color as name,
  'Arterra' as collection,
  m.category_id,
  'Arterra ' || st.display_name as prod_display_name,
  'arterra-' || lower(replace(st.display_name, ' ', '-')) as slug
FROM arterra_sku_map m
JOIN arterra_stones st ON st.code = m.stone_code
WHERE m.stone_code != 'UNKNOWN'
ORDER BY st.display_name, m.stone_code;

-- Step 4: Create new products (skip if slug already exists)
INSERT INTO products (id, vendor_id, name, collection, category_id, status, display_name, slug, is_active)
SELECT new_id, vendor_id, name, collection, category_id, 'active', prod_display_name, slug, true
FROM arterra_new_products
WHERE NOT EXISTS (SELECT 1 FROM products p2 WHERE p2.slug = arterra_new_products.slug);

-- Step 5: Move SKUs to their new products
UPDATE skus SET product_id = (
  SELECT p.id FROM products p
  JOIN arterra_stones st ON p.slug = 'arterra-' || lower(replace(st.display_name, ' ', '-'))
  WHERE st.code = (
    CASE
      WHEN skus.vendor_sku LIKE 'LPAVN%' THEN regexp_replace(skus.vendor_sku, '^LPAVN([A-Z]+).*$', '\1')
      WHEN skus.vendor_sku LIKE 'LCOPN%' THEN regexp_replace(skus.vendor_sku, '^LCOPN([A-Z]+).*$', '\1')
      WHEN skus.vendor_sku LIKE 'P-LPAVN%' THEN regexp_replace(skus.vendor_sku, '^P-LPAVN([A-Z]+).*$', '\1')
      WHEN skus.vendor_sku LIKE 'P-LCOPN%' THEN regexp_replace(skus.vendor_sku, '^P-LCOPN([A-Z]+).*$', '\1')
    END
  )
  LIMIT 1
)
WHERE skus.id IN (SELECT sku_id FROM arterra_sku_map WHERE stone_code != 'UNKNOWN');

-- Step 6: Update variant_name on moved SKUs
UPDATE skus SET variant_name = st.color
FROM arterra_sku_map m
JOIN arterra_stones st ON st.code = m.stone_code
WHERE skus.id = m.sku_id
  AND m.stone_code != 'UNKNOWN';

-- Step 7: Deactivate the old mega-products
UPDATE products SET is_active = false, status = 'inactive'
WHERE name ILIKE 'arterra %'
  AND status = 'active'
  AND name IN ('Arterra Gray', 'Arterra Beige', 'Arterra White', 'Arterra Ivory',
               'Arterra Black', 'Arterra Brown', 'Arterra Charcoal', 'Arterra Blue',
               'Arterra Pure White');

COMMIT;
