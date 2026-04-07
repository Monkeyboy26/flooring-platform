# Vendor Scraper Onboarding Guide

Step-by-step guide for building a new vendor scraper for the Roma Flooring PIM.

---

## 1. Required Data Fields

Every scraper should attempt to capture these fields. Not all vendors will have everything — that's OK, but the more you capture upfront the less manual cleanup is needed.

### Product-Level Fields

| PIM Column | Table | Required | Notes |
|---|---|---|---|
| `name` | products | **YES** | Product/collection display name. Title-case ALL CAPS names. |
| `collection` | products | YES | Collection or product line name. Empty string if none. |
| `category_id` | products | No | UUID of matching category. Usually set post-import. |
| `description_short` | products | No | One-liner for cards/listings |
| `description_long` | products | No | Full HTML or text description |

### SKU-Level Fields

| PIM Column | Table | Required | Notes |
|---|---|---|---|
| `vendor_sku` | skus | **YES** | Vendor's own SKU/model number |
| `internal_sku` | skus | **YES** | Our internal unique ID. Convention: `VENDORCODE-vendorsku` |
| `variant_name` | skus | No | Size, color, or format descriptor (e.g., "12x24, Matte") |
| `sell_by` | skus | YES | `'sqft'` (flooring) or `'unit'` (accessories, trim, adhesive) |
| `variant_type` | skus | No | Set to `'accessory'` for trim/molding/accessories |

### Pricing Fields

| PIM Column | Table | Required | Notes |
|---|---|---|---|
| `cost` | pricing | **YES** | Dealer/wholesale cost. Defaults to 0 if unknown. |
| `retail_price` | pricing | **YES** | Retail/MSRP price. **Always `parseFloat()` before storing.** |
| `price_basis` | pricing | No | `'per_sqft'` (default) or `'per_unit'` or `'per_lnft'` |
| `map_price` | pricing | No | Minimum advertised price, if vendor enforces MAP |
| `cut_price` / `roll_price` | pricing | No | For carpet/vinyl with cut vs. roll pricing |

### Packaging Fields

| PIM Column | Table | Required | Notes |
|---|---|---|---|
| `sqft_per_box` | packaging | **YES** for sqft products | Critical for coverage calculator |
| `pieces_per_box` | packaging | No | Number of tiles/planks per box |
| `weight_per_box_lbs` | packaging | No | For shipping estimates |
| `boxes_per_pallet` | packaging | No | For freight/bulk orders |
| `sqft_per_pallet` | packaging | No | Usually `sqft_per_box * boxes_per_pallet` |
| `weight_per_pallet_lbs` | packaging | No | For LTL freight quotes |
| `roll_width_ft` / `roll_length_ft` | packaging | No | For roll goods (carpet, sheet vinyl) |

### Media Fields

| PIM Column | Table | Required | Notes |
|---|---|---|---|
| `url` | media_assets | **YES** (at least primary) | Direct URL or local path to image |
| `asset_type` | media_assets | YES | `'primary'`, `'alternate'`, `'lifestyle'`, `'spec_pdf'` |
| `original_url` | media_assets | No | Vendor's original URL (for re-download later) |
| `sort_order` | media_assets | No | 0 = primary, 1+ = gallery order |

### Attributes (EAV)

| Attribute Slug | Notes |
|---|---|
| `color` | Color/shade name |
| `size` | Tile/plank dimensions (e.g., "12x24", "7x48") |
| `finish` | Surface finish (Matte, Polished, Honed, Wire Brushed) |
| `material` | Porcelain, Ceramic, LVP, Hardwood, etc. |
| `thickness` | In mm or inches |
| `edge` | Rectified, Pressed, Micro-bevel |
| `species` | Wood species for hardwood |
| `wear_layer` | Wear layer thickness (LVP/engineered) |

Use `upsertSkuAttribute(pool, skuId, 'color', 'Ivory')` — the slug must already exist in the `attributes` table.

### Inventory Fields

| PIM Column | Table | Notes |
|---|---|---|
| `qty_on_hand_sqft` | inventory_snapshots | Current stock in sqft |
| `qty_in_transit_sqft` | inventory_snapshots | Incoming stock in sqft |
| `warehouse` | inventory_snapshots | Warehouse name/location |

---

## 2. Where to Find Data

### Embedded JSON
Many modern sites embed product data in the page source:
- **Next.js**: `window.__NEXT_DATA__` in a `<script id="__NEXT_DATA__">` tag
- **Angular/React**: `window.__DATA__`, `window.__INITIAL_STATE__`, `window.dataLayer`
- **Shopify**: `<script>var meta = {...}</script>` or `/products.json` endpoint
- **JSON-LD**: `<script type="application/ld+json">` (standard product schema)

**Tip**: Before writing CSS selectors, check `page.evaluate(() => { ... })` for embedded data — it's faster and more reliable than DOM scraping.

### HTML Tables & Accordions
Specs and packaging info is usually in:
- `<table>` elements in a "Specifications" or "Technical Data" section
- Accordion/tab panels (click to expand before reading)
- `<dl>` (definition lists) with `<dt>`/`<dd>` pairs

### API Endpoints
Check the browser Network tab for:
- XHR/Fetch requests to `/api/products`, `/graphql`, etc.
- Pagination via `?page=2` or cursor-based params
- Auth headers that may need to be replicated

### PDF Price Lists
Some vendors only provide pricing via PDF. Options:
- Download and parse with a PDF library
- Import manually via the admin's CSV import
- Store as `spec_pdf` media asset for reference

### EDI Feeds (832/855/856/810)
For vendors with EDI integration:
- 832 = Product catalog (items, pricing, packaging)
- 855 = Purchase order acknowledgment
- 856 = Advance ship notice
- 810 = Invoice

See `backend/services/ediParser.js` and `backend/scripts/import-triwest-832.cjs` for examples.

---

## 3. Base Class Utilities (`base.js`)

Import what you need from `backend/scrapers/base.js`:

```js
import {
  launchBrowser,        // Puppeteer launch with sandbox disabled
  delay,                // Simple ms delay
  deslugify,            // "oak-ridge" → "Oak Ridge"
  normalizeSize,        // '12" x 24"' → "12x24"
  buildVariantName,     // (size, finish, ...) → "12x24, Matte"
  upsertProduct,        // Insert/update product by (vendor_id, collection, name)
  upsertSku,            // Insert/update SKU by internal_sku
  upsertSkuAttribute,   // Insert/update attribute by (sku_id, slug)
  upsertPricing,        // Insert/update pricing by sku_id
  upsertPackaging,      // Insert/update packaging by sku_id
  upsertMediaAsset,     // Insert/update media asset
  upsertInventorySnapshot, // Insert/update inventory
  appendLog,            // Add log line to scrape job
  addJobError,          // Add error to scrape job
  downloadImage,        // Download image URL to local file
  extractLargeImages,   // Get product images from page (filters icons/logos)
  collectSiteWideImages,// Get site-wide images to exclude from product shots
  extractSpecPDFs,      // Find spec/technical PDF links on page
  preferProductShot,    // Sort images: product shots first, lifestyle last
  fuzzyMatch,           // Fuzzy name matching (0–1 confidence score)
  resolveImageExtension,// ".jpg" from URL
  normalizeTriwestName, // Tri-West specific name cleanup
} from './base.js';
```

### Common Patterns

**Creating a product + SKU + pricing:**
```js
const product = await upsertProduct(pool, {
  vendor_id: vendorId,
  name: 'Coastal Oak',
  collection: 'Heritage Collection',
  category_id: null,
  description_short: 'Wire-brushed engineered hardwood',
});

const sku = await upsertSku(pool, {
  product_id: product.id,
  vendor_sku: 'HRT-COAST-5',
  internal_sku: 'SHAW-HRT-COAST-5',
  variant_name: '5" Wide',
  sell_by: 'sqft',
});

await upsertPricing(pool, sku.id, {
  cost: 3.49,
  retail_price: 5.99,
  price_basis: 'per_sqft',
});

await upsertPackaging(pool, sku.id, {
  sqft_per_box: 23.31,
  pieces_per_box: 10,
  boxes_per_pallet: 48,
});
```

**Adding images with product-shot preference:**
```js
const siteWideImages = await collectSiteWideImages(page, 'https://vendor.com');
const images = await extractLargeImages(page, siteWideImages);
const sorted = preferProductShot(images.map(i => i.src), colorName);

for (let i = 0; i < sorted.length; i++) {
  await upsertMediaAsset(pool, {
    product_id: product.id,
    sku_id: sku.id,
    asset_type: i === 0 ? 'primary' : 'alternate',
    url: sorted[i],
    original_url: sorted[i],
    sort_order: i,
  });
}
```

**Adding attributes:**
```js
await upsertSkuAttribute(pool, sku.id, 'color', 'Coastal Oak');
await upsertSkuAttribute(pool, sku.id, 'size', '5x48');
await upsertSkuAttribute(pool, sku.id, 'finish', 'Wire Brushed');
await upsertSkuAttribute(pool, sku.id, 'material', 'Engineered Hardwood');
await upsertSkuAttribute(pool, sku.id, 'thickness', '3/8"');
```

---

## 4. Scraper Types

### Full Catalog Crawl
Use when: New vendor, no EDI feed, need to scrape everything from website.
- Navigate to category/collection listing pages
- Paginate through all products
- Visit each product detail page
- Extract all data fields

### Enrichment-Only Scraper
Use when: Vendor already in DB via EDI import or CSV, but missing images/descriptions.
- Query existing products/SKUs for this vendor from DB
- Visit vendor's website and match by name/SKU
- Fill in missing images, descriptions, specs
- Do NOT overwrite existing pricing (EDI is source of truth for price)

### API/Portal Integration
Use when: Vendor provides a dealer portal or API.
- Authenticate via login page or API key
- Fetch product catalogs via API endpoints
- Often more reliable than HTML scraping
- See `triwest-auth.js`, `elysium-auth.js`, `bosphorus-auth.js` for auth patterns

---

## 5. Common Pitfalls

### ALL CAPS Normalization
Many vendor sites show product names in ALL CAPS. Always title-case:
```js
// BAD: name = "COASTAL OAK ENGINEERED HARDWOOD"
// GOOD:
if (name === name.toUpperCase() && name.includes(' ')) {
  name = name.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}
```
The `deslugify()` and `normalizeTriwestName()` helpers handle common cases.

### Price-as-String Gotcha
PostgreSQL returns `DECIMAL` columns as strings. Always parse:
```js
// BAD:  price = row.retail_price  // "4.99" (string!)
// GOOD: price = parseFloat(row.retail_price)
```

### Accessory Detection
Trim, molding, underlayment, adhesive = accessories. Set `variant_type: 'accessory'` and `sell_by: 'unit'`:
```js
const ACCESSORY_KEYWORDS = [
  'trim', 'molding', 'moulding', 'reducer', 'stair nose', 'transition',
  'threshold', 't-molding', 'quarter round', 'underlayment', 'adhesive',
  'grout', 'sealer', 'caulk', 'spacer'
];
const isAccessory = ACCESSORY_KEYWORDS.some(kw =>
  productName.toLowerCase().includes(kw)
);
```

### Image Deduplication
Strip query params before comparing URLs to avoid duplicates:
```js
const cleanUrl = url => url.split('?')[0].split('#')[0];
```
The `extractLargeImages()` helper does this automatically.

### Non-Product Page Filtering
Skip these pages during crawls:
- About/Contact/FAQ pages
- Blog posts
- Sample order forms
- Login/registration pages

### Pagination Gotchas
- "Load More" buttons: Click and `await delay(1500)` for content to render
- Infinite scroll: Scroll to bottom in a loop until no new items appear
- URL-based: Watch for off-by-one errors with `?page=` params

### Rate Limiting
- Add `await delay(1000–3000)` between page navigations
- Randomize delays slightly to avoid detection
- If blocked, try adding realistic User-Agent headers

---

## 6. File Naming Convention

Scraper files are named: `backend/scrapers/<vendor-code>.js`

For vendors with sub-scrapers (auth, inventory, pricing):
```
backend/scrapers/triwest-auth.js      # Authentication
backend/scrapers/triwest-shaw.js      # Shaw catalog via Tri-West
backend/scrapers/triwest-inventory.js # Inventory polling
```

---

## 7. Testing Your Scraper

### Quick Manual Test
```bash
# Start the stack
docker compose up -d

# Run your scraper directly
docker compose exec api node scrapers/your-vendor.js

# Check what got inserted
docker exec -it flooring-platform-db-1 psql -U postgres -d flooring_pim \
  -c "SELECT COUNT(*) FROM products WHERE vendor_id = '<vendor-uuid>'"
```

### Validate Data Quality
After running your scraper, use the validation tool:
```bash
node backend/scripts/validate-vendor.js --vendor "VendorName"
```
This checks for missing images, pricing gaps, packaging gaps, duplicate SKUs, and more. Fix any ERRORs before considering the scraper complete.

---

## 8. Checklist for New Scrapers

- [ ] Created field map document (see `FIELD_MAP_TEMPLATE.md`)
- [ ] Scraper file created at `backend/scrapers/<vendor-code>.js`
- [ ] Products upserted with name, collection
- [ ] SKUs upserted with vendor_sku, internal_sku, sell_by
- [ ] Pricing upserted (at minimum cost + retail_price)
- [ ] Packaging data captured (sqft_per_box at minimum for sqft products)
- [ ] Primary images captured for each SKU
- [ ] Key attributes set (color, size, material at minimum)
- [ ] Accessories detected and marked with `variant_type: 'accessory'`
- [ ] Validation script passes with no ERRORs
- [ ] Vendor source record created in `vendor_sources` table
