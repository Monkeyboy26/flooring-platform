# Vendor Field Map Template

Copy this template and fill it out before (or while) building a new scraper. Save the completed version as `FIELD_MAP_<vendor-code>.md` in this directory.

---

## Vendor Info

| Field | Value |
|---|---|
| **Vendor Name** | ___ |
| **Vendor Code** | ___ |
| **Website** | ___ |
| **Source Type** | `website` / `dealer portal` / `API` / `EDI` |
| **Auth Required?** | Yes / No |
| **Contact/Rep** | ___ |

---

## Field Mapping

| PIM Field | Source Location | Selector / Path / Key | Transform Notes |
|---|---|---|---|
| `product.name` | | | |
| `product.collection` | | | |
| `product.description_short` | | | |
| `product.description_long` | | | |
| `sku.vendor_sku` | | | |
| `sku.internal_sku` | | Convention: `CODE-vendor_sku` | |
| `sku.variant_name` | | | |
| `sku.sell_by` | | `sqft` / `unit` | |
| `sku.variant_type` | | `null` / `accessory` | |
| `pricing.cost` | | | |
| `pricing.retail_price` | | | Parse `"$X.XX/sqft"` |
| `pricing.price_basis` | | `per_sqft` / `per_unit` | |
| `pricing.map_price` | | | |
| `packaging.sqft_per_box` | | | |
| `packaging.pieces_per_box` | | | |
| `packaging.weight_per_box_lbs` | | | |
| `packaging.boxes_per_pallet` | | | |
| `attr: color` | | | |
| `attr: size` | | | |
| `attr: finish` | | | |
| `attr: material` | | | |
| `attr: thickness` | | | |
| `attr: species` | | | |
| `attr: wear_layer` | | | |
| `attr: edge` | | | |
| `inventory.qty_on_hand` | | | |
| `inventory.warehouse` | | | |

---

## Image Strategy

| Setting | Value |
|---|---|
| **Download to disk or CDN URLs?** | `download` / `cdn_urls` |
| **Primary image selector** | |
| **Gallery/alternate selector** | |
| **Lifestyle image detection** | |
| **Spec PDF selector** | |

---

## Pagination

| Setting | Value |
|---|---|
| **Type** | `url_param` / `load_more_button` / `infinite_scroll` / `api_cursor` / `none` |
| **Selector/pattern** | |
| **Items per page** | |
| **Total pages (approx)** | |

---

## Product Listing Pages

| Collection/Category | URL | Approx Products |
|---|---|---|
| | | |
| | | |
| | | |

---

## Special Handling Notes

_Document anything unusual about this vendor:_
- ALL CAPS names? → Title-case with `deslugify()` or manual transform
- Accessory products mixed in? → How to detect them
- Multiple SKUs per product? → What creates the variants (size, color, finish)
- Login/session required? → Auth flow details
- Rate limiting? → Observed limits and delay strategy
- Known data gaps? → Fields the vendor doesn't provide

---

## Verification Queries

After running the scraper, check these:

```sql
-- Count products and SKUs
SELECT COUNT(DISTINCT p.id) as products, COUNT(s.id) as skus
FROM products p JOIN skus s ON s.product_id = p.id
WHERE p.vendor_id = '<vendor-uuid>';

-- Check image coverage
SELECT COUNT(*) as total_skus,
  COUNT(ma.id) as with_image
FROM skus s
JOIN products p ON s.product_id = p.id
LEFT JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
WHERE p.vendor_id = '<vendor-uuid>';

-- Check pricing coverage
SELECT COUNT(*) as total_skus,
  COUNT(pr.sku_id) as with_pricing
FROM skus s
JOIN products p ON s.product_id = p.id
LEFT JOIN pricing pr ON pr.sku_id = s.id
WHERE p.vendor_id = '<vendor-uuid>';
```

Or just run: `node backend/scripts/validate-vendor.js --vendor "VendorName"`
