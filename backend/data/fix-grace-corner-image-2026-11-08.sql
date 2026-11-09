-- Grace 24"x24" Square Corner showed the ROUND product primary (vendor has no
-- square-corner studio photo; verified via site + WP media API). The only
-- vendor image featuring the corner elements is the installed-with-border
-- photo (already a product alternate) — make it this sku's own primary so the
-- hero shows the corner treatment, not a different-shape medallion. Idempotent.
BEGIN;
INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
SELECT s.product_id, s.id, 'primary', m.url, m.original_url, 0, 'manual'
FROM skus s
JOIN products p ON p.id = s.product_id
JOIN vendors v ON v.id = p.vendor_id AND v.code = 'STPR'
JOIN LATERAL (
  SELECT url, original_url FROM media_assets
  WHERE product_id = s.product_id
    AND original_url LIKE '%Grace-custom-size-with-border-installed%'
  LIMIT 1
) m ON true
WHERE s.vendor_sku = 'MM-18-Grace-24"SQ Corner'
  AND NOT EXISTS (SELECT 1 FROM media_assets e WHERE e.sku_id = s.id AND e.asset_type = 'primary');
COMMIT;
SELECT s.vendor_sku, ma.asset_type, ma.url FROM skus s JOIN media_assets ma ON ma.sku_id = s.id
WHERE s.vendor_sku = 'MM-18-Grace-24"SQ Corner';
