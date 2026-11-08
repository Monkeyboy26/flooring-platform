-- Terrazzo name cleanup — 2026-11-08
-- 1) Stone Pride (STPR): rename the three in-stock "Terrazzo SP####" products to
--    descriptive colorway names (SP codes are factory part numbers with no public
--    name; colors read off the swatch images — codes remain in vendor_sku).
-- 2) STPR "Terrazzo Tile"/"Terrazzo Mosaic": un-smash variant names
--    ("Blue12x24x3/8, Polished" -> "Blue, 12x24x3/8, Polished"; drop "P(D" junk;
--    expand CM/LG to Crema Marfil/Light Grey).
-- 3) Add color attributes (none of these SKUs had one).
-- 4) Orion "Natural Terrazzo": move Natural Stone -> Terrazzo Tile category and
--    replace slug-in-parens variant names with "16x16, Matte".
-- Idempotent; keyed by vendor code + vendor_sku (no env-specific UUIDs).

BEGIN;

CREATE TABLE IF NOT EXISTS terrazzo_name_fix_backup_20261108 AS
SELECT p.id AS product_id, p.name AS product_name, p.category_id,
       s.id AS sku_id, s.vendor_sku, s.variant_name
FROM products p
JOIN vendors v ON v.id = p.vendor_id
LEFT JOIN skus s ON s.product_id = p.id
WHERE (v.code = 'STPR' AND p.name ILIKE '%terrazzo%')
   OR (v.code = '169' AND p.name = 'Natural Terrazzo');

-- ── 1. STPR product renames ──────────────────────────────────────────────
UPDATE products p SET name = r.new_name, updated_at = CURRENT_TIMESTAMP
FROM (VALUES
  ('Terrazzo SP1870 Tile',  'Misty Grey Terrazzo Tile'),
  ('Terrazzo SP20646 Tile', 'Midnight Black Terrazzo Tile'),
  ('Terrazzo SP6268 Tile',  'Frost White Terrazzo Tile')
) AS r(old_name, new_name)
JOIN vendors v ON v.code = 'STPR'
WHERE p.vendor_id = v.id AND p.name = r.old_name;

-- ── 2. STPR variant name cleanup ─────────────────────────────────────────
UPDATE skus s SET variant_name = r.new_vn, updated_at = CURRENT_TIMESTAMP
FROM (VALUES
  -- Terrazzo Tile
  ('Tile-Terrazzo Blue12x24x3/8-P',   'Blue, 12x24x3/8, Polished'),
  ('Tile-Terrazzo Blue24x24x3/8-P',   'Blue, 24x24x3/8, Polished'),
  ('Tile-Terrazzo Blue4x12-P',        'Blue, 4x12, Polished'),
  ('Tile-Terrazzo Blue6Hex-P',        'Blue, 6" Hexagon, Polished'),
  ('Tile-Terrazzo Blue6x12-P',        'Blue, 6x12, Polished'),
  ('Tile-Terrazzo Gold12x24x3/8-P',   'Gold, 12x24x3/8, Polished'),
  ('Tile-Terrazzo Gold24x24x3/8-P(D', 'Gold, 24x24x3/8, Polished'),
  ('Tile-Terrazzo Gold4x12-P(D)',     'Gold, 4x12, Polished'),
  ('Tile-Terrazzo Gold6Hex-P',        'Gold, 6" Hexagon, Polished'),
  ('Tile-Terrazzo Gold6x12-P',        'Gold, 6x12, Polished'),
  ('Tile-Terrazzo Silver12x12-P',     'Silver, 12x12x5/8, Polished'),
  ('Tile-Terrazzo Silver12x12-P/N(D', 'Silver (No Mirror), 12x12x5/8, Polished'),
  ('Tile-Terrazzo Silver12x24x3/8-P', 'Silver, 12x24x3/8, Polished'),
  ('Tile-Terrazzo Silver12x24x5/8-P', 'Silver, 12x24x5/8, Polished'),
  ('Tile-Terrazzo Silver24x24-P(D)',  'Silver, 24x24x5/8, Polished'),
  ('Tile-Terrazzo Silver4x12-P(D)',   'Silver, 4x12, Polished'),
  ('Tile-Terrazzo Silver6Hex-P',      'Silver, 6" Hexagon, Polished'),
  ('Tile-Terrazzo Silver6x12-P(D)',   'Silver, 6x12, Polished'),
  ('Tile-Terrazzo-CM-12x12-5/8-P(D)', 'Crema Marfil, 12x12x5/8, Polished'),
  ('Tile-Terrazzo-LG-12x24x5/8-H(D)', 'Light Grey, 12x24x5/8, Honed'),
  -- Terrazzo Mosaic
  ('MS-Terrazzo Blue Morocco-P(D)',   'Blue, 4" Morocco, Polished'),
  ('MS-Terrazzo Blue3Hex-P',          'Blue, 3" Hexagon, Polished'),
  ('MS-Terrazzo Gold Morocco-P(D)',   'Gold, 4" Morocco, Polished'),
  ('MS-Terrazzo Gold3Hex-P',          'Gold, 3" Hexagon, Polished'),
  ('MS-Terrazzo Silver Morocco-P(D)', 'Silver, 4" Morocco, Polished'),
  ('MS-Terrazzo Silver3Hex-H',        'Silver, 3" Hexagon, Honed'),
  ('MS-Terrazzo Silver3Hex-P',        'Silver, 3" Hexagon, Polished')
) AS r(vsku, new_vn), products p, vendors v
WHERE s.vendor_sku = r.vsku
  AND p.id = s.product_id
  AND v.id = p.vendor_id AND v.code = 'STPR';

-- ── 3. Color attributes for all STPR terrazzo SKUs ───────────────────────
INSERT INTO sku_attributes (sku_id, attribute_id, value)
SELECT s.id, a.id,
  CASE
    WHEN s.vendor_sku LIKE 'SP-Terrazzo-SP1870-%'  THEN 'Gray'
    WHEN s.vendor_sku LIKE 'SP-Terrazzo-SP20646-%' THEN 'Black'
    WHEN s.vendor_sku LIKE 'SP-Terrazzo-SP6268-%'  THEN 'White'
    WHEN s.vendor_sku ILIKE '%Terrazzo Blue%'      THEN 'Blue'
    WHEN s.vendor_sku ILIKE '%Terrazzo Gold%'      THEN 'Gold'
    WHEN s.vendor_sku ILIKE '%Terrazzo Silver%'    THEN 'Silver'
    WHEN s.vendor_sku LIKE 'Tile-Terrazzo-CM-%'    THEN 'Beige'
    WHEN s.vendor_sku LIKE 'Tile-Terrazzo-LG-%'    THEN 'Gray'
  END
FROM skus s
JOIN products p ON p.id = s.product_id
JOIN vendors v ON v.id = p.vendor_id AND v.code = 'STPR'
JOIN attributes a ON a.slug = 'color'
WHERE (s.vendor_sku LIKE 'SP-Terrazzo-%' OR s.vendor_sku ILIKE '%Terrazzo%')
  AND p.name ILIKE '%terrazzo%'
  AND CASE
    WHEN s.vendor_sku LIKE 'SP-Terrazzo-SP1870-%'  THEN 'Gray'
    WHEN s.vendor_sku LIKE 'SP-Terrazzo-SP20646-%' THEN 'Black'
    WHEN s.vendor_sku LIKE 'SP-Terrazzo-SP6268-%'  THEN 'White'
    WHEN s.vendor_sku ILIKE '%Terrazzo Blue%'      THEN 'Blue'
    WHEN s.vendor_sku ILIKE '%Terrazzo Gold%'      THEN 'Gold'
    WHEN s.vendor_sku ILIKE '%Terrazzo Silver%'    THEN 'Silver'
    WHEN s.vendor_sku LIKE 'Tile-Terrazzo-CM-%'    THEN 'Beige'
    WHEN s.vendor_sku LIKE 'Tile-Terrazzo-LG-%'    THEN 'Gray'
  END IS NOT NULL
ON CONFLICT (sku_id, attribute_id) DO NOTHING;

-- ── 4. Orion Natural Terrazzo: category + variant names ──────────────────
UPDATE products p
SET category_id = c.id, updated_at = CURRENT_TIMESTAMP
FROM vendors v, categories c
WHERE v.code = '169' AND p.vendor_id = v.id
  AND p.name = 'Natural Terrazzo'
  AND c.slug = 'terrazzo-tile';

UPDATE skus s SET variant_name = '16x16, Matte', updated_at = CURRENT_TIMESTAMP
FROM products p, vendors v
WHERE s.product_id = p.id
  AND v.id = p.vendor_id AND v.code = '169'
  AND p.name = 'Natural Terrazzo'
  AND s.vendor_sku LIKE 'natural-terrazzo-tile-16x16%';

COMMIT;

-- Verify
SELECT v.code, p.name, c.name AS category, s.vendor_sku, s.variant_name, s.status
FROM products p
JOIN vendors v ON v.id = p.vendor_id
LEFT JOIN categories c ON c.id = p.category_id
JOIN skus s ON s.product_id = p.id
WHERE (v.code = 'STPR' AND (p.name ILIKE '%terrazzo%')) OR (v.code = '169' AND p.name = 'Natural Terrazzo')
ORDER BY v.code, p.name, s.vendor_sku;
