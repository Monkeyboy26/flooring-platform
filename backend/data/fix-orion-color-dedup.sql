-- fix-orion-color-dedup.sql  (idempotent, portable local↔prod — keyed on
-- slug / vendor_sku / image-URL, NOT UUIDs, because Orion UUIDs differ per env)
--
-- Repairs the "ONI Pearl shows ONI Blue" family of Orion data bugs:
--   1. ONI descriptions cloned from Blue ("rich blue color" on every colour)
--   2. ONI Pearl's blue-dominant combo image
--   3. Marvel Gray primary = a green swatch (no clean grey swatch exists → use the
--      grey lifestyle)
--   4. Re-scrape duplicate SKUs (WP -2/-3/-copy suffix) under one product
--   5. WP-suffix drift on sole SKUs that the hardened scraper would otherwise orphan
--
-- Scraper hardening lands separately (backend/scrapers/orion.js). NOTE: a future
-- Orion re-scrape RE-CLOBBERS the ONI descriptions (step 1) because upsertProduct
-- COALESCEs the vendor page text — the vendor's own copy still says "blue". The
-- image/dedup fixes are durable; the description fix is a manual override.
--
-- Run:  docker exec -i flooring-db psql -U postgres -d flooring_pim < fix-orion-color-dedup.sql
-- Safe to re-run. Non-matching statements affect 0 rows.

\set ON_ERROR_STOP on
BEGIN;

-- Resolve the Orion vendor id once.
CREATE TEMP TABLE _orion ON COMMIT DROP AS
  SELECT id FROM vendors WHERE name ILIKE '%orion%' ORDER BY id LIMIT 1;

-- Helper: product ids for an Orion slug.
-- (inlined per statement below via subselect against _orion)

-- ============================================================
-- 1. ONI descriptions — per colour (undo the cloned blue boilerplate)
-- ============================================================
UPDATE products SET description_long =
'ONI Super Polished Blue is a 24”×48” porcelain tile with a glossy marble and onyx look. Its rich blue tones and reflective finish create a bold, luxurious style, while the durable porcelain surface makes it ideal for walls, floors, and feature areas.',
updated_at = CURRENT_TIMESTAMP
WHERE vendor_id IN (SELECT id FROM _orion) AND slug='oni-blue-super';

UPDATE products SET description_long =
'ONI Super Polished Coral is a 24”×48” porcelain tile with a glossy marble and onyx look. Its warm coral tones and reflective finish create a bold, luxurious style, while the durable porcelain surface makes it ideal for walls, floors, and feature areas.',
updated_at = CURRENT_TIMESTAMP
WHERE vendor_id IN (SELECT id FROM _orion) AND slug='oni-coral-super';

UPDATE products SET description_long =
'ONI Pearl Super Polished is a 24”×48” porcelain tile with a glossy marble and onyx look. Its soft pearl-white tones and reflective finish create an elegant, luxurious style, while the durable porcelain surface makes it ideal for walls, floors, and feature areas.',
updated_at = CURRENT_TIMESTAMP
WHERE vendor_id IN (SELECT id FROM _orion) AND slug='oni-pearl-super';

UPDATE products SET description_long =
'ONI White Super Polished is a 24”×48” porcelain tile with a glossy marble and onyx look. Its clean white tones and reflective finish create a bright, luxurious style, while the durable porcelain surface makes it ideal for walls, floors, and feature areas.',
updated_at = CURRENT_TIMESTAMP
WHERE vendor_id IN (SELECT id FROM _orion) AND slug='oni-white-super';

-- ============================================================
-- 2. ONI Pearl: drop the blue-dominant combo image
-- ============================================================
DELETE FROM media_assets
WHERE asset_type='alternate'
  AND COALESCE(original_url,url) ILIKE '%Oni-Blue%'
  AND product_id IN (SELECT id FROM products WHERE vendor_id IN (SELECT id FROM _orion) AND slug='oni-pearl-super');

-- ============================================================
-- 3. Marvel Gray: delete the wrong "Green" swatch; promote the grey lifestyle to
--    primary ONLY if the SKU is left with no primary (defensive on prod).
-- ============================================================
DELETE FROM media_assets
WHERE COALESCE(original_url,url) ILIKE '%Marvel-Onyx-Green%'
  AND product_id IN (SELECT id FROM products WHERE vendor_id IN (SELECT id FROM _orion) AND slug='marvel-gray-24-48');

UPDATE media_assets m SET asset_type='primary', sort_order=0
WHERE COALESCE(m.original_url,m.url) ILIKE '%Marvel-Onyx-Grey-Life-Style%'
  AND m.product_id IN (SELECT id FROM products WHERE vendor_id IN (SELECT id FROM _orion) AND slug='marvel-gray-24-48')
  AND NOT EXISTS (SELECT 1 FROM media_assets m2 WHERE m2.sku_id=m.sku_id AND m2.asset_type='primary');

-- ============================================================
-- 4. Fold known re-scrape duplicate SKUs (by vendor_sku; no-op if prod differs).
--    Delete the dupe's media, then soft-deactivate it. Never deactivates the last
--    active SKU of a product (cascade trigger only deactivates a product when ALL
--    its SKUs are inactive — every fold here leaves a base keeper active).
-- ============================================================
-- active dupes to remove
DELETE FROM media_assets WHERE sku_id IN (
  SELECT s.id FROM skus s JOIN products p ON s.product_id=p.id
  WHERE p.vendor_id IN (SELECT id FROM _orion) AND s.vendor_sku IN (
    'viken-beige-matte-porcelain-tile-24x48-2',
    'natural-terrazzo-tile-16x16-2','natural-terrazzo-tile-16x16-3',
    'multifios-breton-2'));
UPDATE skus s SET status='inactive', updated_at=CURRENT_TIMESTAMP
  FROM products p WHERE s.product_id=p.id AND p.vendor_id IN (SELECT id FROM _orion)
  AND s.status='active' AND s.vendor_sku IN (
    'viken-beige-matte-porcelain-tile-24x48-2',
    'natural-terrazzo-tile-16x16-2','natural-terrazzo-tile-16x16-3',
    'multifios-breton-2');

-- already-inactive dupes still holding competing media → drop their media
DELETE FROM media_assets WHERE sku_id IN (
  SELECT s.id FROM skus s JOIN products p ON s.product_id=p.id
  WHERE p.vendor_id IN (SELECT id FROM _orion) AND s.status='inactive' AND s.vendor_sku IN (
    'sybil-silver-porcelain-tile-24x48','rosso-verona'));

-- aeterna-grey URL-rename dupe (empty, no media) → deactivate
UPDATE skus s SET status='inactive', updated_at=CURRENT_TIMESTAMP
  FROM products p WHERE s.product_id=p.id AND p.vendor_id IN (SELECT id FROM _orion)
  AND s.status='active' AND s.vendor_sku='aeterna-grey-porcelain-tile-collection'
  AND (SELECT count(*) FROM skus s2 WHERE s2.product_id=p.id AND s2.status='active') > 1;

-- ============================================================
-- 5. Normalize sole-SKU WP suffixes to base so the hardened scraper matches in
--    place instead of orphaning them. Only where the base identity is free.
-- ============================================================
UPDATE skus s
SET vendor_sku  = regexp_replace(s.vendor_sku,'(-copy)?(-[1-9][0-9]?)?$',''),
    internal_sku= 'ORN-'||regexp_replace(s.vendor_sku,'(-copy)?(-[1-9][0-9]?)?$',''),
    updated_at  = CURRENT_TIMESTAMP
FROM products p
WHERE s.product_id=p.id AND p.vendor_id IN (SELECT id FROM _orion) AND s.status='active'
  AND regexp_replace(s.vendor_sku,'(-copy)?(-[1-9][0-9]?)?$','') <> s.vendor_sku
  AND NOT EXISTS (
    SELECT 1 FROM skus s3
    WHERE s3.internal_sku = 'ORN-'||regexp_replace(s.vendor_sku,'(-copy)?(-[1-9][0-9]?)?$','')
      AND s3.id <> s.id);

COMMIT;

-- ============================================================
-- DIAGNOSTIC (read-only) — run after COMMIT to confirm prod state. Reveals any
-- REMAINING genuine duplicates (two active SKUs sharing colour+size+finish) that
-- are prod-specific and need a manual fold.
-- ============================================================
WITH a AS (
  SELECT s.id, s.product_id,
    max(sa.value) FILTER (WHERE at.slug='color')  AS color,
    max(sa.value) FILTER (WHERE at.slug='finish') AS finish,
    max(sa.value) FILTER (WHERE at.slug='size')   AS size
  FROM skus s
  JOIN products p ON s.product_id=p.id
  JOIN vendors v ON p.vendor_id=v.id AND v.name ILIKE '%orion%'
  LEFT JOIN sku_attributes sa ON sa.sku_id=s.id
  LEFT JOIN attributes at ON sa.attribute_id=at.id
  WHERE s.status='active'
  GROUP BY s.id, s.product_id)
SELECT p.slug, a.color, a.finish, a.size, count(*) AS active_dupe_skus
FROM a JOIN products p ON a.product_id=p.id
WHERE a.color IS NOT NULL
GROUP BY p.slug, a.color, a.finish, a.size
HAVING count(*)>1
ORDER BY p.slug;
