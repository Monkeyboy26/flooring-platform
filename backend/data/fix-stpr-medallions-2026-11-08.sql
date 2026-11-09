-- Stone Pride medallion cleanup — 2026-11-08
-- 1) Variant names that were raw "(vendor_sku)" differentiators or smashed text,
--    decoded from the pricelist descriptions:
--      Aptus (EL)/(RA) = Emperador Light / Rojo Alicante colorways
--      Sonoma (GO) = Green Onyx accent; Grace-white = white background
--      Imperial BW/SilverMk = "Black White with Silver Mink"; 02ED = Emperador Dark
--      Rafael (Burg-Red) = Burgundy Red; /Simplified = simplified design
--      Odyssey "-2" = NEW VERSION of the design (vendor's own 2018 file is named
--      "新版本…Odyssey" = "new version Odyssey"); the two 60" skus are original vs
--      new version at the same price
--      Primavera 48SQ is a REPAIRED piece (pricelist disclosure) — surface it
-- 2) Milan-Black 48" showed the Milan-LIGHT photo; vendor has
--    MilanBlack-available-in-48in-1.jpg (verified visually: black border ring).
-- No vendor photos exist for Rafael/Geneva/Lucerne/Radial/Rose/Kamila/Aptus/
-- Roman/Aluminum-Backed designs (site + WP media API searched) — left imageless.
-- Idempotent; keyed by vendor code + vendor_sku.

BEGIN;

CREATE TABLE IF NOT EXISTS stpr_medallion_fix_backup_20261108 AS
SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, m.id AS media_id, m.url, m.original_url
FROM skus s
JOIN products p ON p.id = s.product_id
JOIN vendors v ON v.id = p.vendor_id AND v.code = 'STPR'
LEFT JOIN media_assets m ON m.sku_id = s.id AND m.asset_type = 'primary'
WHERE s.vendor_sku LIKE 'MM-%';

-- ── 1. Variant names ───────────────────────────────────────────────────────
UPDATE skus s SET variant_name = r.new_vn, updated_at = CURRENT_TIMESTAMP
FROM (VALUES
  ('MM-26-48RD-Aptus(EL)',            '48" Round, Emperador Light'),
  ('MM-26-48RD-Aptus(RA)',            '48" Round, Rojo Alicante'),
  ('MM-14-36RD-Sonoma',               '36" Round'),
  ('MM-14-36RD-Sonoma(GO)',           '36" Round, Green Onyx'),
  ('MM-18-36RD-Grace',                '36" Round'),
  ('MM-18-36RD-Grace-white',          '36" Round, White Background'),
  ('MM-02-48RD-Imperial-BW/SilverMk', '48" Round, Black & White with Silver Mink'),
  ('MM-02ED-48RD-Imperial',           '48" Round, Emperador Dark'),
  ('MM-21-36RD-Rafael(Burg-Red)',     '36" Round, Burgundy Red'),
  ('MM-21-36RD-Rafael/Simplified',    '36" Round, Simplified'),
  ('MM-21-48RD-Rafael(Burg-Red)',     '48" Round, Burgundy Red'),
  ('MM-21-60RD-Rafael(Burg-Red)',     '60" Round, Burgundy Red'),
  ('MM-21-72RD-Rafael',               '72" Round'),
  ('MM-21-72RD-Rafael(burg-red)',     '72" Round, Burgundy Red'),
  ('MM-24-60RD-Odyssey',              '60" Round (Original)'),
  ('MM-24-60RD-Odyssey-2',            '60" Round (New Version)'),
  ('MM-48RD-Kamila',                  '48" Round'),
  ('MM-20-3x5 Rect.Casablanca',       '3''x5'' Rectangular'),
  ('MM-36Triangular medallion',       '36" Triangular'),
  ('MM-A-06-3x4',                     'Design A-06, 3''x4'''),
  ('MM-A-07-3x4 oval',                'Design A-07, 3''x4'' Oval'),
  ('MM-YT-03',                        'Design YT-03'),
  ('MM-46-36RD-Monroe-Simplified',    '36" Round, Simplified'),
  ('MM-03ED-48SQ-Primavera REPAIRED', '48" Square, Repaired')
) AS r(vsku, new_vn), products p, vendors v
WHERE s.vendor_sku = r.vsku
  AND p.id = s.product_id
  AND v.id = p.vendor_id AND v.code = 'STPR'
  AND s.variant_name IS DISTINCT FROM r.new_vn;

-- ── 2. Milan-Black gets the Black photo (was showing Milan-Light) ──────────
UPDATE media_assets m
SET url = 'https://www.stone-pride.com/wp-content/uploads/2017/05/MilanBlack-available-in-48in-1.jpg',
    original_url = 'https://www.stone-pride.com/wp-content/uploads/2017/05/MilanBlack-available-in-48in-1.jpg',
    mirrored_at = NULL, mirror_bytes = NULL
FROM skus s, products p, vendors v
WHERE m.sku_id = s.id AND m.asset_type = 'primary'
  AND s.vendor_sku = 'MM-38-48RD-Milan-Black'
  AND p.id = s.product_id AND v.id = p.vendor_id AND v.code = 'STPR'
  AND m.original_url IS DISTINCT FROM 'https://www.stone-pride.com/wp-content/uploads/2017/05/MilanBlack-available-in-48in-1.jpg';

COMMIT;

-- Verify
SELECT p.name, s.vendor_sku, s.variant_name, s.status,
       COALESCE(ms.original_url, ms.url, '') AS sku_img
FROM products p
JOIN vendors v ON v.id = p.vendor_id AND v.code = 'STPR'
JOIN skus s ON s.product_id = p.id
LEFT JOIN LATERAL (SELECT url, original_url FROM media_assets WHERE sku_id = s.id AND asset_type='primary' ORDER BY sort_order LIMIT 1) ms ON true
WHERE s.vendor_sku LIKE 'MM-%' AND (
  p.name IN ('Aptus','Sonoma','Grace','Imperial','Rafael','Odyssey','Kamila','Casablanca','Aluminum-Backed','Milan','Monroe','Primavera'))
ORDER BY p.name, s.vendor_sku;
