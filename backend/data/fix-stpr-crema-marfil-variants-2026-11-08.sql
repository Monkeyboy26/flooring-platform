-- Stone Pride Crema Marfil variant-name cleanup — 2026-11-08
-- Decoded from pricelist descriptions:
--   Tile grade letters: C = Commercial grade, B = Standard grade
--   "-8mm"/"-7mm" sku suffixes = thinner stock (standard is 3/8"≈10mm) — these
--   were creating DUPLICATE variant names ("2 Hex, Tumbled" twice, "1x1,
--   Polished" twice, "5/8, Tumbled" twice, "F1, Polished" twice)
--   Discount/clearance skus are no-exchange-no-return — surface "Final Sale"
--   Trim profile codes: F1 = Chairrail 2x12, F2 = Ogee 2x12, F5 = Molding 2x12,
--   P12.5 = Pencil 1/2"x12, P20 = Pencil 3/4"x12 (codes kept in parens);
--   F1-P(BD) = 5 pc/box pack of the same chairrail
--   MS-CM-1x2-Rhomboid-H was labeled "Tumbled" but is Honed (w/ light tumble)
-- Idempotent; keyed by vendor code + vendor_sku.

BEGIN;

CREATE TABLE IF NOT EXISTS stpr_cm_variant_fix_backup_20261108 AS
SELECT s.id AS sku_id, s.vendor_sku, s.variant_name
FROM skus s
JOIN products p ON p.id = s.product_id
JOIN vendors v ON v.id = p.vendor_id AND v.code = 'STPR'
WHERE s.vendor_sku LIKE '%CM%' AND p.name ILIKE '%crema marfil%';

UPDATE skus s SET variant_name = r.new_vn, updated_at = CURRENT_TIMESTAMP
FROM (VALUES
  -- Crema Marfil Marble Tile
  ('Tile-CM-12-P-C',                '12x12, Polished, Commercial Grade'),
  ('Tile-CM-12-T(D)',               '12x12, Tumbled'),
  ('Tile-CM-18-H-B',                '18x18, Honed, Standard Grade'),
  ('Tile-CM-18-T(D)',               '18x18, Tumbled'),
  ('Tile-CM-4-T-Discount-7mm(D)',   '4x4 (7mm), Tumbled, Final Sale'),
  ('Tile-CM-6-T-Discount-7mm(D)',   '6x6 (7mm), Tumbled, Final Sale'),
  ('Tile-CM-6Hex-H(D)',             '6" Hexagon, Honed'),
  -- Crema Marfil Marble Mosaic
  ('MS-CM-1-Hex-P(D)',              '1" Hexagon, Polished'),
  ('MS-CM-1x1-P-8mm(D)',            '1x1 (8mm), Polished'),
  ('MS-CM-1x1-T-7mm(D)',            '1x1 (7mm), Tumbled, Final Sale'),
  ('MS-CM-1X2-Brick-P-8mm(D)',      '1x2 Brick (8mm), Polished'),
  ('MS-CM-1x2-Brick-T(BD)',         '1x2 Brick (3/8" Thick), Tumbled'),
  ('MS-CM-1x2-Brick-T-8mm(D)',      '1x2 Brick (8mm), Tumbled'),
  ('MS-CM-1x2-Rhomboid-H(D)',       '1x2 Rhomboid, Honed'),
  ('MS-CM-2-Hex-P-8mm(D)',          '2" Hexagon (8mm), Polished'),
  ('MS-CM-2-Hex-T(D)',              '2" Hexagon, Tumbled'),
  ('MS-CM-2-Hex-T-8mm(D)',          '2" Hexagon (8mm), Tumbled'),
  ('MS-CM-2-P-8mm(D)',              '2x2 (8mm), Polished, Final Sale'),
  ('MS-CM-2-T-8mm(D)',              '2x2 (8mm), Tumbled'),
  ('MS-CM-5/8-P',                   '5/8x5/8, Polished'),
  ('MS-CM-5/8-T(BD)(D)',            '5/8x5/8 (3/8" Thick), Tumbled'),
  ('MS-CM-5/8-T-8mm',               '5/8x5/8 (8mm), Tumbled'),
  ('MS-CM-Morocco-4-P',             '4" Morocco, Polished'),
  ('MS-CM-tight mosaics(no gap)-P(D', '3/4x3/4 Tight (No Grout Lines), Polished'),
  ('MS-CM-Vase-P(D)',               'Vase, Polished, Final Sale'),
  -- Crema Marfil Marble Trim & Moldings
  ('FR-CM-Baseboard-P',             'Baseboard 4x12, Polished'),
  ('FR-CM-F1-H(D)',                 'Chairrail 2x12 (F1), Honed'),
  ('FR-CM-F1-P',                    'Chairrail 2x12 (F1), Polished'),
  ('FR-CM-F1-P(BD)(D)',             'Chairrail 2x12 (F1), Polished, 5 pc/Box'),
  ('FR-CM-F2-H(D)',                 'Ogee 2x12 (F2), Honed'),
  ('FR-CM-F2-P(D)',                 'Ogee 2x12 (F2), Polished'),
  ('FR-CM-F5-H',                    'Molding 2x12 (F5), Honed'),
  ('FR-CM-P12.5-P',                 'Pencil 1/2x12 (P12.5), Polished'),
  ('FR-CM-P20-H',                   'Pencil 3/4x12 (P20), Honed'),
  ('FR-CM-P20-P',                   'Pencil 3/4x12 (P20), Polished')
) AS r(vsku, new_vn), products p, vendors v
WHERE s.vendor_sku = r.vsku
  AND p.id = s.product_id
  AND v.id = p.vendor_id AND v.code = 'STPR'
  AND s.variant_name IS DISTINCT FROM r.new_vn;

COMMIT;

-- Verify
SELECT p.name, s.vendor_sku, s.variant_name
FROM products p
JOIN vendors v ON v.id = p.vendor_id AND v.code = 'STPR'
JOIN skus s ON s.product_id = p.id
WHERE p.name ILIKE '%crema marfil%'
ORDER BY p.name, s.vendor_sku;
