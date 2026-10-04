BEGIN;
-- 9x24 XL panel: drop the wrong (6x24 regular-panel) image, attach MSI's real XL images
DELETE FROM media_assets WHERE sku_id = '3a31f8ff-c8e3-4616-931c-baa4caaf015f';
INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
VALUES
 ('2f63d27e-4719-4287-8129-5a8e178c7d2f', '3a31f8ff-c8e3-4616-931c-baa4caaf015f', 'primary',
  'https://cdn.msisurfaces.com/images/hardscaping/detail/xl-alaska-gray-stacked-stone.jpg',
  'https://cdn.msisurfaces.com/images/hardscaping/detail/xl-alaska-gray-stacked-stone.jpg', 0, 'manual'),
 ('2f63d27e-4719-4287-8129-5a8e178c7d2f', '3a31f8ff-c8e3-4616-931c-baa4caaf015f', 'alternate',
  'https://cdn.msisurfaces.com/images/hardscaping/iso/xl-alaska-gray-stacked-stone-iso.jpg',
  'https://cdn.msisurfaces.com/images/hardscaping/iso/xl-alaska-gray-stacked-stone-iso.jpg', 1, 'manual'),
 ('2f63d27e-4719-4287-8129-5a8e178c7d2f', '3a31f8ff-c8e3-4616-931c-baa4caaf015f', 'alternate',
  'https://cdn.msisurfaces.com/images/hardscaping/edge/xl-alaska-gray-stacked-stone-edge.jpg',
  'https://cdn.msisurfaces.com/images/hardscaping/edge/xl-alaska-gray-stacked-stone-edge.jpg', 2, 'manual');
-- 9x18 XL corner (inactive, had no media): attach MSI's corner image
INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
SELECT '2f63d27e-4719-4287-8129-5a8e178c7d2f', '14a9b0b0-0590-41bb-8e64-8fb0f7d87b35', 'primary',
  'https://cdn.msisurfaces.com/images/hardscaping/detail/alaska-gray-xlrockmount-panels-9x18-corner.jpg',
  'https://cdn.msisurfaces.com/images/hardscaping/detail/alaska-gray-xlrockmount-panels-9x18-corner.jpg', 0, 'manual'
WHERE NOT EXISTS (SELECT 1 FROM media_assets WHERE sku_id = '14a9b0b0-0590-41bb-8e64-8fb0f7d87b35');
-- Make the XL findable: MSI sells this as "Alaska Gray XL"
UPDATE skus SET variant_name = '9x24 XL Splitface', updated_at = NOW()
 WHERE id = '3a31f8ff-c8e3-4616-931c-baa4caaf015f' AND variant_name = '9x24 Splitface';
COMMIT;
BEGIN;

-- ── 9x24 XL panels wearing the regular 6x24 panel photo: swap to MSI's real XL images
-- (arctic-white, golden-honey, sierra-blue, roman-beige)
CREATE TEMP TABLE xl_panels (vendor_sku text, slug text) ON COMMIT DROP;
INSERT INTO xl_panels VALUES
 ('LPNLQARCWHI924','arctic-white'),
 ('LPNLQGLDHON924','golden-honey'),
 ('LPNLQSIEBLU924','sierra-blue'),
 ('LPNLTROMBEI924','roman-beige');

DELETE FROM media_assets m USING skus s, xl_panels x
 WHERE m.sku_id = s.id AND s.vendor_sku = x.vendor_sku;

INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
SELECT s.product_id, s.id, v.asset_type, v.url, v.url, v.sort_order, 'manual'
FROM skus s
JOIN xl_panels x ON x.vendor_sku = s.vendor_sku
CROSS JOIN LATERAL (VALUES
  ('primary',   'https://cdn.msisurfaces.com/images/hardscaping/detail/xl-' || x.slug || '-stacked-stone.jpg', 0),
  ('alternate', 'https://cdn.msisurfaces.com/images/hardscaping/iso/xl-'    || x.slug || '-stacked-stone-iso.jpg', 1),
  ('alternate', 'https://cdn.msisurfaces.com/images/hardscaping/edge/xl-'   || x.slug || '-stacked-stone-edge.jpg', 2)
) AS v(asset_type, url, sort_order);

-- ── Golden White 9x18 corner wearing a 12x12 tile image: swap to the real corner photo
DELETE FROM media_assets m USING skus s
 WHERE m.sku_id = s.id AND s.vendor_sku = 'LPNLQGLDWHI918COR';

-- ── Imageless 9x18 XL corners: attach the corner photo (public CDN, verified 200)
CREATE TEMP TABLE xl_corners (vendor_sku text, slug text) ON COMMIT DROP;
INSERT INTO xl_corners VALUES
 ('LPNLQGLDWHI918COR','golden-white'),
 ('LPNLQARCWHI918COR','arctic-white'),
 ('LPNLQGLDHON918COR','golden-honey'),
 ('LPNLQSIEBLU918COR','sierra-blue'),
 ('LPNLTROMBEI918COR','roman-beige'),
 ('LPNLLMAYWHI918COR','mayra-white'),
 ('LPNLSPREBLK918COR','premium-black'),
 ('LPNLQROYWHI918COR','royal-white'),
 ('LPNLTSIL918COR','silver-travertine');

INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
SELECT s.product_id, s.id, 'primary',
       'https://cdn.msisurfaces.com/images/hardscaping/detail/' || x.slug || '-xlrockmount-panels-9x18-corner.jpg',
       'https://cdn.msisurfaces.com/images/hardscaping/detail/' || x.slug || '-xlrockmount-panels-9x18-corner.jpg',
       0, 'manual'
FROM skus s
JOIN xl_corners x ON x.vendor_sku = s.vendor_sku
WHERE NOT EXISTS (SELECT 1 FROM media_assets m WHERE m.sku_id = s.id AND m.asset_type = 'primary');

-- ── Make the XL line findable by name (matches MSI's "Alaska Gray XL" branding)
UPDATE skus SET variant_name = '9x24 XL Splitface', updated_at = NOW()
 WHERE vendor_sku IN ('LPNLQARCWHI924','LPNLQGLDHON924','LPNLQSIEBLU924','LPNLTROMBEI924',
                      'LPNLQGLDWHI924','LPNLQROYWHI924','LPNLLMAYWHI924','LPNLSPREBLK924',
                      'LPNLTSIL924','LPNLSCALGLD924')
   AND variant_name = '9x24 Splitface';

COMMIT;
