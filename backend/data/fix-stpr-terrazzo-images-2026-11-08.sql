-- Stone Pride terrazzo image + CM-sku fixes — 2026-11-08
-- Audit findings (see terrazzo-name-cleanup memory for the naming pass):
--  * Gold/Silver terrazzo MOSAICS showed the BLUE hex image (product-level
--    fallback was the only image). Vendor site has exact per-color/per-shape
--    shots (3" Hex + Morocco arabesque) — attach as sku-level primaries.
--  * Terrazzo TILE 6" Hexagon + 24x24 skus showed the 4x12 color shots; vendor
--    published fresh 2026/08 re-shoots of exactly these — upgrade in place.
--  * SP#### in-stock colorways had ONE product-level image; vendor has per-size
--    shots (SP6269-* files are the SP6268 colorway — vendor filename typo,
--    verified visually: white base + blue specks).
--  * Tile-Terrazzo-CM-12x12-5/8-P(D) is NOT terrazzo: desc "Polished Crema
--    Marfil Tiles", cost $5.01 ≈ CM marble 12x12 C-grade $5.00 (terrazzo 12x12
--    runs $6.50-7.15). It sat in the pricelist's terrazzo section. Move to the
--    existing "Crema Marfil Marble Tile" product.
-- All new URLs verified 200 + visually color-matched. The nightly image-mirror
-- cron self-hosts them (mirrored_at NULL + https url). Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS terrazzo_media_fix_backup_20261108 AS
SELECT m.id AS media_id, m.sku_id, m.product_id, m.asset_type, m.url, m.original_url,
       m.mirrored_at, s.vendor_sku, s.product_id AS sku_product_id, s.variant_name
FROM media_assets m
LEFT JOIN skus s ON s.id = m.sku_id
WHERE m.product_id IN (
  SELECT p.id FROM products p JOIN vendors v ON v.id = p.vendor_id
  WHERE v.code = 'STPR' AND p.name ILIKE '%terrazzo%'
)
UNION ALL
SELECT NULL, s.id, NULL, 'SKU-MOVE-MARKER', NULL, NULL, NULL,
       s.vendor_sku, s.product_id, s.variant_name
FROM skus s WHERE s.vendor_sku = 'Tile-Terrazzo-CM-12x12-5/8-P(D)';

-- ── 1. Upgrade existing sku-level primaries (Terrazzo Tile 6Hex/24x24/6x12) ──
UPDATE media_assets m
SET url = r.new_url, original_url = r.new_url,
    mirrored_at = NULL, mirror_bytes = NULL
FROM (VALUES
  ('Tile-Terrazzo Blue6Hex-P',       'https://www.stone-pride.com/wp-content/uploads/2026/08/Terrazzo-Blue-6in-hexagon-scaled.jpg'),
  ('Tile-Terrazzo Gold6Hex-P',       'https://www.stone-pride.com/wp-content/uploads/2026/08/Terrazzo-Gold-6in-hexagon.jpg'),
  ('Tile-Terrazzo Silver6Hex-P',     'https://www.stone-pride.com/wp-content/uploads/2026/08/Terrazzo-Silver-6in-hexagon-scaled.jpg'),
  ('Tile-Terrazzo Blue24x24x3/8-P',  'https://www.stone-pride.com/wp-content/uploads/2026/08/Terrazzo-Blue-polished-24x24-1.jpg'),
  ('Tile-Terrazzo Gold24x24x3/8-P(D','https://www.stone-pride.com/wp-content/uploads/2026/08/Terrazzo-Gold-polished-24x24-1.jpg'),
  ('Tile-Terrazzo Silver24x24-P(D)', 'https://www.stone-pride.com/wp-content/uploads/2026/08/Terrazzo-Silver-polished-24x24-.jpg'),
  ('Tile-Terrazzo Silver6x12-P(D)',  'https://www.stone-pride.com/wp-content/uploads/2018/11/Terrazzo-6x12-Silver-1.jpg')
) AS r(vsku, new_url), skus s, products p, vendors v
WHERE m.sku_id = s.id AND m.asset_type = 'primary'
  AND s.vendor_sku = r.vsku
  AND p.id = s.product_id AND v.id = p.vendor_id AND v.code = 'STPR'
  AND m.original_url IS DISTINCT FROM r.new_url;

-- ── 2. New sku-level primaries (mosaics + SP#### sizes; none existed) ──────
INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
SELECT s.product_id, s.id, 'primary', r.new_url, r.new_url, 0, 'manual'
FROM (VALUES
  ('MS-Terrazzo Blue3Hex-P',          'https://www.stone-pride.com/wp-content/uploads/2018/07/MS-Terrazzo-3-Hex-Blue.jpg'),
  ('MS-Terrazzo Gold3Hex-P',          'https://www.stone-pride.com/wp-content/uploads/2018/07/MS-Terrazzo-3-Hex-Gold.jpg'),
  ('MS-Terrazzo Silver3Hex-P',        'https://www.stone-pride.com/wp-content/uploads/2018/07/MS-Terrazzo-3-Hex-Silver.jpg'),
  ('MS-Terrazzo Silver3Hex-H',        'https://www.stone-pride.com/wp-content/uploads/2018/07/MS-Terrazzo-3-Hex-Silver.jpg'),
  ('MS-Terrazzo Blue Morocco-P(D)',   'https://www.stone-pride.com/wp-content/uploads/2018/07/MS-Morocco-blue-diamond.jpg'),
  ('MS-Terrazzo Gold Morocco-P(D)',   'https://www.stone-pride.com/wp-content/uploads/2018/07/MS-Morocco-gold-diamond.jpg'),
  ('MS-Terrazzo Silver Morocco-P(D)', 'https://www.stone-pride.com/wp-content/uploads/2018/07/MS-Morocco-silver-diamond-.jpg'),
  ('SP-Terrazzo-SP1870-12x24',        'https://www.stone-pride.com/wp-content/uploads/2018/01/SP1870-12x24-1.jpg'),
  ('SP-Terrazzo-SP1870-24x24',        'https://www.stone-pride.com/wp-content/uploads/2018/01/SP1870-24x24-1.jpg'),
  ('SP-Terrazzo-SP1870-4x12',         'https://www.stone-pride.com/wp-content/uploads/2018/01/SP1870-4x12-1.jpg'),
  ('SP-Terrazzo-SP1870-6Hex',         'https://www.stone-pride.com/wp-content/uploads/2018/01/SP1870-hexagon-tile.png'),
  ('SP-Terrazzo-SP20646-24x24',       'https://www.stone-pride.com/wp-content/uploads/2018/01/SP20646-24x24-1.jpg'),
  ('SP-Terrazzo-SP6268-12x24',        'https://www.stone-pride.com/wp-content/uploads/2018/01/SP6269-12x24-1.jpg'),
  ('SP-Terrazzo-SP6268-24x24',        'https://www.stone-pride.com/wp-content/uploads/2018/01/SP6269-24x24-1.jpg'),
  ('SP-Terrazzo-SP6268-4x12',         'https://www.stone-pride.com/wp-content/uploads/2018/01/SP6269-4x12-1.jpg')
) AS r(vsku, new_url)
JOIN skus s ON s.vendor_sku = r.vsku
JOIN products p ON p.id = s.product_id
JOIN vendors v ON v.id = p.vendor_id AND v.code = 'STPR'
WHERE NOT EXISTS (
  SELECT 1 FROM media_assets e WHERE e.sku_id = s.id AND e.asset_type = 'primary'
);

-- ── 3. Terrazzo Mosaic product hero: blue 6" TILE hexagon -> blue 3" MOSAIC ──
UPDATE media_assets m
SET url = 'https://www.stone-pride.com/wp-content/uploads/2018/07/MS-Terrazzo-3-Hex-Blue.jpg',
    original_url = 'https://www.stone-pride.com/wp-content/uploads/2018/07/MS-Terrazzo-3-Hex-Blue.jpg',
    mirrored_at = NULL, mirror_bytes = NULL
FROM products p, vendors v
WHERE m.product_id = p.id AND m.sku_id IS NULL AND m.asset_type = 'primary'
  AND v.id = p.vendor_id AND v.code = 'STPR' AND p.name = 'Terrazzo Mosaic'
  AND m.original_url IS DISTINCT FROM 'https://www.stone-pride.com/wp-content/uploads/2018/07/MS-Terrazzo-3-Hex-Blue.jpg';

-- ── 4. Move the Crema Marfil marble sku out of Terrazzo Tile ────────────────
UPDATE skus s
SET product_id = cm.id, variant_name = '12x12x5/8, Polished', updated_at = CURRENT_TIMESTAMP
FROM products tz, vendors v,
     products cm
WHERE s.vendor_sku = 'Tile-Terrazzo-CM-12x12-5/8-P(D)'
  AND s.product_id = tz.id AND tz.vendor_id = v.id AND v.code = 'STPR'
  AND cm.vendor_id = v.id AND cm.name = 'Crema Marfil Marble Tile';

COMMIT;

-- Verify
SELECT p.name, s.vendor_sku, s.variant_name,
       CASE WHEN ms.url IS NOT NULL THEN 'sku' WHEN mp.url IS NOT NULL THEN 'product' ELSE 'NONE' END AS img,
       COALESCE(ms.original_url, ms.url, mp.original_url, mp.url) AS img_url
FROM products p
JOIN vendors v ON v.id = p.vendor_id AND v.code = 'STPR'
JOIN skus s ON s.product_id = p.id
LEFT JOIN LATERAL (SELECT url, original_url FROM media_assets WHERE sku_id = s.id AND asset_type='primary' ORDER BY sort_order LIMIT 1) ms ON true
LEFT JOIN LATERAL (SELECT url, original_url FROM media_assets WHERE product_id = p.id AND sku_id IS NULL AND asset_type='primary' ORDER BY sort_order LIMIT 1) mp ON true
WHERE p.name ILIKE '%terrazzo%' OR s.vendor_sku = 'Tile-Terrazzo-CM-12x12-5/8-P(D)'
ORDER BY p.name, s.vendor_sku;
