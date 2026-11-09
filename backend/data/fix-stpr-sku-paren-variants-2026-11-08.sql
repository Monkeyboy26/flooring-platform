-- Stone Pride: decode the remaining "(vendor_sku)" variant differentiators — 2026-11-08
-- The 2026-08 conformance backfill appended the raw sku to dedupe colliding
-- variant names. Real meanings (from pricelist descs + costs):
--   -8mm / -7mm           = thinner stock (standard ≈ 10mm / 3/8")
--   (BD) on MOSAICS       = 3/8" thickness lot      (desc: '3/8" Thickness')
--   (BD) on TRIM          = boxed pack (5 pc/box moldings, 10 pc/box pencils)
--   (A+)                  = Premium grade           (desc: 'Premium …')
--   (GRN)                 = separate lot of Black Absolute (kept as lot code)
--   (Dark blend)          = darker Carrara blend
--   North Pearl (A2..A5)  = color/shade lot numbers (desc: 'Color#A2 …')
-- Also normalizes '1 Hex/2 Hex/3 Hex' → '1"/2"/3" Hexagon' on touched rows.
-- Idempotent; keyed by vendor code + vendor_sku.

BEGIN;

CREATE TABLE IF NOT EXISTS stpr_paren_variant_fix_backup_20261108 AS
SELECT s.id AS sku_id, s.vendor_sku, s.variant_name
FROM skus s
JOIN products p ON p.id = s.product_id
JOIN vendors v ON v.id = p.vendor_id AND v.code = 'STPR'
WHERE s.variant_name ~ '\((MS|FR|Tile|MM|SP|WJ|ML|MSL)-' OR s.vendor_sku LIKE 'Tile-NP-%';

UPDATE skus s SET variant_name = r.new_vn, updated_at = CURRENT_TIMESTAMP
FROM (VALUES
  -- Black Absolute
  ('MS-BA-2-Hex-P(A+)',          '2" Hexagon, Polished, Premium'),
  ('MS-BA-2-Hex-P(GRN)(D)',      '2" Hexagon, Polished (GRN Lot)'),
  ('FR-BA-F5-P (A+)',            'Molding 2x12 (F5), Polished, Premium'),
  ('FR-BA-F5-P(D)',              'Molding 2x12 (F5), Polished'),
  -- Black Marquina
  ('MS-BM-2x2-T',                '2x2, Tumbled'),
  ('MS-BM-2x2-T-8mm(D)',         '2x2 (8mm), Tumbled'),
  -- Carrara White mosaics
  ('MS-CW-1-Hex-P',              '1" Hexagon, Polished'),
  ('MS-CW-1-Hex-P(BD)(D)',       '1" Hexagon (3/8" Thick), Polished'),
  ('MS-CW-1x1-P',                '1x1, Polished'),
  ('MS-CW-1x1-P(BD)(D)',         '1x1 (3/8" Thick), Polished'),
  ('MS-CW-1x2-Brick-P(D)',       '1x2 Brick, Polished'),
  ('MS-CW-1x2-Brick-P(BD)(D)',   '1x2 Brick (3/8" Thick), Polished'),
  ('MS-CW-1x2-Brick-P-8mm(D)',   '1x2 Brick (8mm), Polished'),
  ('MS-CW-1x2-Brick-T(D)',       '1x2 Brick, Tumbled'),
  ('MS-CW-1x2-Brick-T-7mm(D)',   '1x2 Brick (7mm), Tumbled'),
  ('MS-CW-2-Hex-P',              '2" Hexagon, Polished'),
  ('MS-CW-2-Hex-P(BD)(D)',       '2" Hexagon (3/8" Thick), Polished'),
  ('MS-CW-3-Hex-H',              '3" Hexagon, Honed'),
  ('MS-CW-3-Hex-H(Dark blend)(D)', '3" Hexagon (Dark Blend), Honed'),
  ('MS-CW-3-Hex-P',              '3" Hexagon, Polished'),
  ('MS-CW-3-Hex-P(BD)(D)',       '3" Hexagon (3/8" Thick), Polished'),
  -- Carrara White trim
  ('FR-CW-F1-P',                 'Chairrail 2x12 (F1), Polished'),
  ('FR-CW-F1-P(BD)',             'Chairrail 2x12 (F1), Polished, 5 pc/Box'),
  ('FR-CW-F5-P',                 'Molding 2x12 (F5), Polished'),
  ('FR-CW-F5-P(BD)(D)',          'Molding 2x12 (F5), Polished, 5 pc/Box'),
  ('FR-CW-P20-P',                'Pencil 3/4x12 (P20), Polished'),
  ('FR-CW-P20-P(BD)(D)',         'Pencil 3/4x12 (P20), Polished, 10 pc/Box'),
  -- Crema Marfil leftovers
  ('MS-CM-1x1-P(D)',             '1x1, Polished'),
  ('MS-CM-1x2-Brick-P(D)',       '1x2 Brick, Polished'),
  -- Emperador Dark / Light, Honey Onyx, Rojo Alicante
  ('MS-ED-1-T(D)',               '1x1, Tumbled'),
  ('MS-ED-1-T-8mm',              '1x1 (8mm), Tumbled'),
  ('MS-EL-1X2-Brick-T(D)',       '1x2 Brick, Tumbled'),
  ('MS-EL-1x2-Brick-T-8mm(D)',   '1x2 Brick (8mm), Tumbled'),
  ('MS-HO-1-T(D)',               '1x1, Tumbled'),
  ('MS-HO-1-T-8mm(D)',           '1x1 (8mm), Tumbled'),
  ('MS-RA-2-T(D)',               '2x2, Tumbled'),
  ('MS-RA-2-T-8mm(D)',           '2x2 (8mm), Tumbled'),
  -- North Pearl color lots
  ('Tile-NP-12x24-H(A2)(D)',     '12x24, Honed, Color #A2'),
  ('Tile-NP-12x24-H(A3)(D)',     '12x24, Honed, Color #A3'),
  ('Tile-NP-12x24-H(A5)(D)',     '12x24, Honed, Color #A5'),
  ('Tile-NP-12x24-P(A2)(D)',     '12x24, Polished, Color #A2'),
  ('Tile-NP-24x24-H(A2)(D)',     '24x24, Honed, Color #A2'),
  ('Tile-NP-24x24-H(A3)(D)',     '24x24, Honed, Color #A3'),
  ('Tile-NP-24x24-H(A4)(D)',     '24x24, Honed, Color #A4'),
  ('Tile-NP-24x24-H(A5)(D)',     '24x24, Honed, Color #A5'),
  ('Tile-NP-24x24-P(A3)(D)',     '24x24, Polished, Color #A3'),
  ('Tile-NP-24x24-P(A4)(D)',     '24x24, Polished, Color #A4'),
  ('Tile-NP-24x24-P(A5)',        '24x24, Polished, Color #A5')
) AS r(vsku, new_vn), products p, vendors v
WHERE s.vendor_sku = r.vsku
  AND p.id = s.product_id
  AND v.id = p.vendor_id AND v.code = 'STPR'
  AND s.variant_name IS DISTINCT FROM r.new_vn;

COMMIT;

-- Verify: nothing with a raw sku-in-parens left at STPR
SELECT COUNT(*) AS remaining_sku_paren_variants
FROM skus s
JOIN products p ON p.id = s.product_id
JOIN vendors v ON v.id = p.vendor_id AND v.code = 'STPR'
WHERE s.variant_name ~ '\((MS|FR|Tile|MM|SP|WJ|ML|MSL)-';
