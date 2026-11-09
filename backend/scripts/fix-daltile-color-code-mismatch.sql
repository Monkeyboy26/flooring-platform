-- fix-daltile-color-code-mismatch.sql
--
-- One-time fix for Daltile SKUs whose primary/swatch image was a DIFFERENT
-- COLOR's render (found by audit-daltile-color-code-mismatch.sql: the
-- series+color code embedded in the image filename, DAL_/MZ_/AO_<code>_,
-- disagreed with the SKU's 4-char vendor_sku prefix). 19 rows: Prime Historic
-- Grey showed NS10 Heirloom White, Color Wheel Artisan Brown trims showed AR07
-- Articulo beige, Suede Gray coves showed 0001 Light Travertine, Bee Hive trim
-- showed an Emerson Wood plank, Terra Rock showed Terra Core, Hawthorne
-- Scholarly Gray showed HT15 Refined White. Replacements are same-code renders
-- verified live (HTTP 200) before use; mirrored_at reset so the nightly
-- mirror-images-backfill localizes them.
--
-- APPLIED 2026-11-08 to LOCAL + PROD. Rollback rows are preserved in table
-- media_assets_colorfix_backup_20261108. Known false alarm the audit keeps
-- reporting: PO38 vs P038 (Concrete Masonry Greige) is a vendor letter-O
-- filename typo — the image itself is correct.

BEGIN;
CREATE TABLE IF NOT EXISTS media_assets_colorfix_backup_20261108 AS
SELECT ma.* FROM media_assets ma JOIN skus s ON s.id=ma.sku_id
WHERE (left(s.vendor_sku,4)='NS12' AND ma.original_url ILIKE '%NS10_12x24_HeirloomWhite%')
   OR (left(s.vendor_sku,4)='0182' AND ma.original_url ILIKE '%DAL_0001_LightTravertine%')
   OR (left(s.vendor_sku,4)='0744' AND ma.original_url ILIKE '%AR07_6x18_WaveWall%')
   OR (left(s.vendor_sku,4)='P010' AND ma.original_url ILIKE '%EP01_8x48_ButterPecan%')
   OR (left(s.vendor_sku,4)='TP44' AND ma.original_url ILIKE '%TP45_Terra_Core%')
   OR (left(s.vendor_sku,4)='HT17' AND ma.original_url ILIKE '%HT15_10x14_Flat_RefinedWhite%');

UPDATE media_assets ma SET url='https://s7d9.scene7.com/is/image/daltile/DAL_NS12_12x24_HistoricGrey_MT_Silo_01',
  original_url='https://s7d9.scene7.com/is/image/daltile/DAL_NS12_12x24_HistoricGrey_MT_Silo_01',
  source='color-code-fix', mirrored_at=NULL, mirror_bytes=NULL
FROM skus s WHERE s.id=ma.sku_id AND left(s.vendor_sku,4)='NS12' AND ma.original_url ILIKE '%NS10_12x24_HeirloomWhite%';

UPDATE media_assets ma SET url='https://s7d9.scene7.com/is/image/daltile/DAL_0182_6x6_SuedeGray_SGloss_Classic_swatch',
  original_url='https://s7d9.scene7.com/is/image/daltile/DAL_0182_6x6_SuedeGray_SGloss_Classic_swatch',
  source='color-code-fix', mirrored_at=NULL, mirror_bytes=NULL
FROM skus s WHERE s.id=ma.sku_id AND left(s.vendor_sku,4)='0182' AND ma.original_url ILIKE '%DAL_0001_LightTravertine%';

UPDATE media_assets ma SET url='https://s7d9.scene7.com/is/image/daltile/DAL_0744_3x6_MatteArtisanBrown_swatch',
  original_url='https://s7d9.scene7.com/is/image/daltile/DAL_0744_3x6_MatteArtisanBrown_swatch',
  source='color-code-fix', mirrored_at=NULL, mirror_bytes=NULL
FROM skus s WHERE s.id=ma.sku_id AND left(s.vendor_sku,4)='0744' AND ma.original_url ILIKE '%AR07_6x18_WaveWall%';

UPDATE media_assets ma SET url='https://s7d9.scene7.com/is/image/daltile/DAL_P010_Hex_Grey',
  original_url='https://s7d9.scene7.com/is/image/daltile/DAL_P010_Hex_Grey',
  source='color-code-fix', mirrored_at=NULL, mirror_bytes=NULL
FROM skus s WHERE s.id=ma.sku_id AND left(s.vendor_sku,4)='P010' AND ma.original_url ILIKE '%EP01_8x48_ButterPecan%';

UPDATE media_assets ma SET url='https://s7d9.scene7.com/is/image/daltile/DT_TP44_Terra_Rock_39x39_web',
  original_url='https://s7d9.scene7.com/is/image/daltile/DT_TP44_Terra_Rock_39x39_web',
  source='color-code-fix', mirrored_at=NULL, mirror_bytes=NULL
FROM skus s WHERE s.id=ma.sku_id AND left(s.vendor_sku,4)='TP44' AND ma.original_url ILIKE '%TP45_Terra_Core%';

-- HT17: fix primary; drop the swatch row (it duplicated the wrong primary URL)
UPDATE media_assets ma SET url='https://s7d9.scene7.com/is/image/daltile/MZ_HT17_10x14_Bevel_ScholarlyGray_Panel',
  original_url='https://s7d9.scene7.com/is/image/daltile/MZ_HT17_10x14_Bevel_ScholarlyGray_Panel',
  source='color-code-fix', mirrored_at=NULL, mirror_bytes=NULL
FROM skus s WHERE s.id=ma.sku_id AND left(s.vendor_sku,4)='HT17' AND ma.asset_type='primary' AND ma.original_url ILIKE '%HT15_10x14_Flat_RefinedWhite%';
DELETE FROM media_assets ma USING skus s
WHERE s.id=ma.sku_id AND left(s.vendor_sku,4)='HT17' AND ma.asset_type='swatch' AND ma.original_url ILIKE '%HT15_10x14_Flat_RefinedWhite%';

SELECT source, count(*) FROM media_assets WHERE source='color-code-fix' GROUP BY 1;
COMMIT;
