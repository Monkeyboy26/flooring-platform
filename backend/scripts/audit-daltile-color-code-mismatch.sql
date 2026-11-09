-- audit-daltile-color-code-mismatch.sql
--
-- Flags Daltile media whose image filename embeds a series+color code
-- (DAL_/MZ_/AO_<code>_) that disagrees with the SKU's 4-char vendor_sku
-- prefix — i.e. the SKU is showing a DIFFERENT color/series' render.
-- Re-runnable any time (e.g. after a Daltile re-scrape):
--   docker exec -i flooring-db psql -U postgres -d flooring_pim < backend/scripts/audit-daltile-color-code-mismatch.sql
--
-- Expected standing output: P038RCT1530MT / PO38 — a vendor letter-O filename
-- typo (Concrete Masonry Greige); the image is the correct color. Anything
-- else is a real mismatch (see fix-daltile-color-code-mismatch.sql for the
-- 2026-11-08 batch).

WITH x AS (
  SELECT s.vendor_sku, ma.original_url,
    upper(substring(ma.original_url FROM '(?:DAL|MZ|AO)_([A-Za-z0-9]{4})_')) AS img_code,
    upper(left(s.vendor_sku,4)) AS sku_code
  FROM media_assets ma JOIN skus s ON s.id=ma.sku_id
  JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
  WHERE v.code='DAL' AND ma.asset_type IN ('primary','swatch','alternate')
    AND ma.original_url ~ '(DAL|MZ|AO)_[A-Za-z0-9]{4}_' AND s.status='active'
)
SELECT vendor_sku, img_code, sku_code, split_part(original_url,'/',6) AS img
FROM x WHERE img_code <> sku_code;
