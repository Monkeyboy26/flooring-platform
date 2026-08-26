// Centralized line-item name enrichment. Line-item queries scattered across the
// app select only a couple of flat attribute columns (color, size), which is not
// enough for the storefront PDP title builder (it also needs finish, pattern,
// product_line, brand, sub_line, overall_length + format_label/category/vendor).
// Rather than rewrite ~60 SQL statements, this helper does ONE batch lookup by
// sku_id and stamps each row with the full `attributes` array + the missing
// live-join fields, then computes `display_name` (the PDP-identical title) and
// `display_meta` (vendor · sku). Call it right after loading any order/quote/
// estimate/cart items and before rendering a document, email, or API response.
//
// See [[line-item-display]]. fullProductName / composeItemName live in
// productName.js / documents.js and remain the single naming source of truth.
import { pool } from '../db.js';
import { composeItemName } from './documents.js';

// Fetch the full SKU attribute set + product-level naming fields for a batch of
// sku_ids in one round-trip. finish is INITCAP'd to match the PDP SKU endpoint.
async function loadSkuNameData(skuIds) {
  const map = new Map();
  if (!skuIds.length) return map;
  const { rows } = await pool.query(
    `SELECT s.id AS sku_id,
            p.format_label,
            c.name AS category_name,
            v.code AS vendor_code, v.public_code AS vendor_public_code,
            (COALESCE(br.hide_public_name, false) OR COALESCE(v.hide_public_name, false)) AS brand_hidden,
            COALESCE((
              SELECT json_agg(json_build_object('slug', a.slug, 'value',
                       CASE WHEN a.slug = 'finish' THEN INITCAP(sa.value) ELSE sa.value END)
                     ORDER BY a.display_order, a.name)
                FROM sku_attributes sa
                JOIN attributes a ON a.id = sa.attribute_id
               WHERE sa.sku_id = s.id
            ), '[]'::json) AS attributes
       FROM skus s
       JOIN products p ON p.id = s.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN vendors v ON v.id = p.vendor_id
       LEFT JOIN brands br ON br.id = p.brand_id
      WHERE s.id = ANY($1)`,
    [skuIds]
  );
  for (const r of rows) map.set(String(r.sku_id), r);
  return map;
}

// Mutates each item in `items`, adding: attributes[], format_label, category_name,
// vendor_code (only where the row doesn't already carry them), then display_name +
// display_meta. Items without a sku_id (manual/custom/labor lines, custom rugs)
// still get display_name from whatever fields they carry. Returns the same array.
export async function enrichItemsForNaming(items) {
  if (!Array.isArray(items) || items.length === 0) return items;
  const skuIds = [...new Set(items.map(i => i && i.sku_id).filter(Boolean).map(String))];
  const data = await loadSkuNameData(skuIds);
  for (const it of items) {
    if (!it) continue;
    const nd = it.sku_id ? data.get(String(it.sku_id)) : null;
    if (nd) {
      // The batch lookup is the live source for these — attach unless the row
      // already provides a non-empty value (respect query-supplied overrides).
      if (!Array.isArray(it.attributes)) it.attributes = nd.attributes || [];
      if (it.format_label == null) it.format_label = nd.format_label;
      if (it.category_name == null) it.category_name = nd.category_name;
      if (it.vendor_code == null) it.vendor_code = nd.vendor_code;
      if (it.vendor_public_code == null) it.vendor_public_code = nd.vendor_public_code;
      if (it.brand_hidden == null) it.brand_hidden = nd.brand_hidden;
    }
    const ci = composeItemName(it);
    it.display_name = ci.nameLine;
    it.display_meta = ci.metaLine;
  }
  return items;
}

// Convenience for a single item (e.g. sample requests carry one line).
export async function enrichItemForNaming(item) {
  if (!item) return item;
  await enrichItemsForNaming([item]);
  return item;
}
