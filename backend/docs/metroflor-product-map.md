# Metroflor Product Map

## Overview

| Source | SKUs | Notes |
|--------|------|-------|
| Shopify (metroflor.com) | 409 | All "Luxury Vinyl", vendor "Metroflor" |
| Triwest 832 EDI | 1,200 | 485 flooring + 701 accessories + 14 sundries |
| **Overlap (both)** | **197** | Matched by stripping `MET` prefix from 832 vendor_sku |
| 832-only flooring | 288 | Legacy lines + Attraxion + alternate formats |
| 832-only accessories | 701 | Transitions/moldings (not on Shopify site) |
| 832-only sundries | 14 | Prevail cleaning/adhesive products |
| Shopify-only | 212 | Newer SKUs or different SKU format in 832 |

## SKU Translation Rule

```
832 vendor_sku:  MET + <shopify_sku>
Example:         METINC20019PAD  →  INC20019PAD (Shopify)
                 METGE231001AB   →  GE231001AB
                 METDN477101     →  DN477101
                 METDT20001      →  DT20001
                 MET87109KO      →  87109KO
```

**Rule:** Strip the `MET` prefix from the 832 `vendor_sku` to match Shopify variant SKU.

---

## Site Structure (metroflor.com — Shopify)

**Tech:** Shopify (FloorTitan theme), `/products.json` API available
**Title pattern:** `"Line - SubLine, Color"` (e.g. "Inception - 200, Tobacco")
**Tags:** `Collection_<name>` tag per product (8 collection tags)
**Variants:** Single variant per product (1 SKU = 1 Shopify product, "Default Title")
**Images:** 1-2 images per product (product shot + room scene)
**body_html:** 368 of 409 products have descriptions (paragraph text, no structured specs table)

### Shopify Collections (URL handles)

| Collection | Handle | Notes |
|------------|--------|-------|
| All Products | `all-products` | |
| Artistek | `artistek` | |
| Attraxion | `attraxion` | Magnetic/loose-lay |
| Déjà New | `deja-new` | |
| French Quarter | `french-quarter` | |
| Genesis | `genesis` | |
| Inception | `inception` | |
| Metroflor LVT | `metroflor-lvt` | Catch-all for glue-down lines |
| Metrostone | `metrostone` | SPC stone-look tile |
| Provident | `provident` | |
| + color/type filter collections | various | e.g. beige, white, glue-down, SPC, WPC |

### Navigation

```
Catalog
├── Products (→ /collections/all)
└── Floor Care
About Us
Flooring Visualizer
Technical Documents
Dealer Locator
```

---

## Product Line Hierarchy

### 1. Provident (55 Shopify / ~55 in 832)
SPC click-lock with attached pad. Premium residential.

| Sub-Line | Shopify | SKU Prefix | Sample SKU | Notes |
|----------|---------|------------|------------|-------|
| Metropolis XL | 4 | ME9 | ME9212 | 9" wide plank |
| Metropolis | 8 | ME7 | ME7212 | Standard width |
| Public | 11 | PR7 | PR7120LP-20M | 20mil commercial-rated |
| Civic | 11 | PR7 | PR7... | |
| Urban | 21 | PR7 | PR7... | |

**832 collection names:** Not present as "Provident" — these are newer products, mostly Shopify-only (212 of Shopify-only SKUs include Provident).

---

### 2. Inception (132 Shopify / ~120+ in 832)
SPC click-lock. Multiple thickness/wear-layer tiers.

| Sub-Line | Shopify | SKU Prefix | 832 Collection Name | Cost/sqft |
|----------|---------|------------|---------------------|-----------|
| 200 | 48 | INC200 | Inception(200) 8.66 X59.45 - 20mil | $5.00 |
| 200 Island | 25 | HAW... | Inception(20) 7 X48 Dl100 - 20mil | $5.00 |
| 200XXL | 8 | INC200 | Inception 200 Xxl 20mil W/pad 9 X72 | $5.00 |
| 120 | 34 | INC... | (Shopify-only, newer) | — |
| 120XL | 12 | INC... | (Shopify-only, newer) | — |
| 120MW | 3 | INC... | (Shopify-only, newer) | — |

**832 accessories:** ~180 transition/molding SKUs for Inception (T-molding, reducer, stairnose, quarter round, end cap, cap-a-tread, riser — 72" and 94" lengths, color-matched).

---

### 3. Genesis (39 Shopify / ~28 in 832)
SPC click-lock with pad. Two distinct sub-lines.

| Sub-Line | Shopify | SKU Prefix | 832 Collection Name | Cost/sqft |
|----------|---------|------------|---------------------|-----------|
| Silhouette | 22 | GE232 | Genesis Silhouette Coll. 7 X60 20mil | $5.00 |
| Authentics | 17 | GE231 | Genesis Authentics Coll. 9 X72 - 20mil | $5.00 |

**832 accessories:** ~250 transition SKUs (end cap, flush stairnose, overlap stairnose, quarter round, reducer, T-molding — 94.49" lengths). Also Hawaii-only quarter round variants.

**832 legacy sub-lines (not on Shopify):**
- Genesis 800 (8mil, $3.99/sqft) — 1 SKU
- Genesis 1200 (12mil, $5.99/sqft) — 1 SKU
- Genesis 1200MW — 1 SKU
- Genesis 2000 ($4.99-$6.99/sqft) — 3 SKUs
- Genesis 2000 Drop Lock ($5.05-$5.80/sqft) — 7 SKUs
- Genesis 2000T (Hawaii, $5.99) — 1 SKU
- Genesis 2000XL ($6.99) — 1 SKU

---

### 4. Metroflor LVT (127 Shopify / ~100+ in 832)
Glue-down LVT. Large umbrella collection with many sub-lines.

#### Déjà New Sub-Lines (47 Shopify)

| Sub-Line | Shopify | SKU Prefix | 832 Collection Name | Cost/sqft |
|----------|---------|------------|---------------------|-----------|
| Alleyway | 10 | DN1249 | (Shopify-only) | — |
| Belgium Weave | 6 | DN477 | Deja New LVT Db Belgium Weave Tile 16x32 | $4.00 |
| Clean Oak | 6 | DN529 | (Shopify-only) | — |
| Coastal Oak | 3 | DN8218 | (Shopify-only) | — |
| English Walnut | 4 | DN2345 | (Shopify-only) | — |
| Oak Framing | 4 | DN1241 | Deja New LVT Oak Framing Plank 7 X48 | $4.00 |
| San Marcos Oak | 8 | DN1445 | Deja New LVT Oak Framing Plank 9 X60 | $4.00 |
| Smooth Concrete | 6 | DN1238 | Deja New LVT Smooth Concrete Tile 24 X24 | $4.00 |
| Terrazzo | 8 | DN180/DN5 | (partially in 832) | — |

**832 also has Attraxion variants** (magnetic/loose-lay): DN___ATX suffix, $4.99-$5.99/sqft
**832 also has "Over the Top" variants** (5mm): OTT prefix, $4.99/sqft

#### Double Take Sub-Lines (35 Shopify)

| Sub-Line | Shopify | SKU Prefix | 832 Collection Name | Cost/sqft |
|----------|---------|------------|---------------------|-----------|
| Wood | 16 | DT200 | Double Take 20mil 7 X48 | $4.00 |
| Abstract | 8 | DT200 | Double Take 20mil 12 X24 | $4.00 |
| Textile | 4 | DT200 | Double Take 20mil 12 X24 | $4.00 |
| Terrazzo | 4 | DT200 | Double Take 20mil 18 X36 | $4.00 |
| Stone | 3 | DT200 | Double Take 20mil 18 X36 | $4.00 |

#### Other Metroflor LVT Sub-Lines

| Sub-Line | Shopify | SKU Prefix | 832 Collection Name | Cost/sqft |
|----------|---------|------------|---------------------|-----------|
| Performer | 14 | PDB | Performer Dry Back 7 X48 12mil | $3.00 |
| Studio Plus | 8 | 871/KO | Studio Plus Db 12mil 6 X48 | $3.00 |
| Savanna Plank | 7 | 201 | (Shopify-only) | — |
| Cosmopolitan | — | COS | Cosmopolitan Db 12mil 6 X48 | $3.00 |

---

### 5. Artistek (14 Shopify / ~14 in 832)
Budget LVT line.

| Sub-Line | Shopify | SKU Prefix | 832 Notes |
|----------|---------|------------|-----------|
| American Plank Plus | 14 | 710/733/760+ | Numeric SKUs, legacy format |

---

### 6. Metrostone (18 Shopify / 0 in 832)
SPC stone-look tile. **Shopify-only — not in the 832.**

| Sub-Line | Shopify | SKU Prefix |
|----------|---------|------------|
| 12x24 | 10 | 96_ |
| 16x32 | 8 | 96_ |

---

### 7. Inception Reserve (12 Shopify / ~7 in 832)
Premium Inception variant.

| Sub-Line | Shopify | SKU Prefix | 832 Collection Name | Cost/sqft |
|----------|---------|------------|---------------------|-----------|
| 200 7x48 | ~4 | WE1 | Inception Reserve 200 7 X48 W/pad 20mil | $5.00 |
| 200 9x60 | ~8 | FA2/CA3 | Inception Reserve 200 9 X60 W/pad 20mil | $5.00 |

---

### 8. French Quarter (12 Shopify / ~18 in 832)
SPC with herringbone/chevron/basketweave patterns.

| Sub-Line | Shopify | SKU Prefix | 832 Collection Name | Cost/sqft |
|----------|---------|------------|---------------------|-----------|
| Basketweave | ~4 | FQ4 | French Quarter-basketweave 20mil 8mm | — |
| Chevron | ~4 | FQ4 | French Quarter-chevron 8mm | — |
| Plank | ~4 | FQ4 | French Quarter-plank 8mm | — |

---

## 832-Only Legacy Lines (NOT on Shopify — 57 collections, 288 flooring SKUs)

These are older/discontinued products still in the Triwest catalog but removed from Metroflor's consumer site.

| Collection | SKUs | Cost/sqft | SKU Format |
|------------|------|-----------|------------|
| Barnwood 7-1/4x48 | 7 | $4.10 | 711xx |
| Corin Stone 12x12 | 4 | $3.50 | 620xx |
| Cork Tile 18x18 | 3 | $2.08 | 969xx |
| Designer Metal 18x18 | 3 | $3.62 | 15xx |
| Designer Stone 18x18 | 5 | $3.62 | 15xx |
| Designer Wood 4x36 | 2 | $3.62 | 19xx |
| Exo/Venezia 4x36 | 10 | $8.64 | 0xx |
| Feature Strip | 20 | $94.95 | 2FS-xx |
| Forest Wood 4x36 | 5 | $3.30 | 711xx |
| Grand Stripwood 6x48 | 3 | $3.30 | 711xx/720xx |
| Handstand Oak 4x36 | 12 | $6.62 | 05x |
| Engage Island 12/20mil | 9 | $3.15-$4.10 | HAWxxxx |
| Moroccan Sandstone | 5 | $3.00 | 622xx |
| Rustic Burlington | 4 | $2.14 | 360xx |
| Soledad Dakota Slate | 2 | $2.34 | 105xx |
| Soledad Travertine | 7 | $3.96 | 619xx |
| Studio Plus 8mil | 3 | $1.99 | 871xx |
| Tumbled Mosaic/Marble | 35 | $2.59-$45.95 | 614xx-615xx |
| Texture Metal 18x18 | 3 | $3.62 | 805xx |
| Timeless 6x48 | 5 | $1.60 | 103xx |
| Tru Tile/Tru Tymber | 22 | $1.29-$5.56 | 307xx-663xx |
| Venetian Travertine | 4 | $3.60 | 622xx |
| Versailles Shale | 7 | $1.86 | 101xx/603xx |
| + Attraxion magnetic variants | 38 | $4.99-$5.99 | DN___ATX |
| + Over the Top 5mm | 3 | $4.99 | OTTxxx |

---

## 832 Accessories/Transitions (701 SKUs)

All sold by unit (EA), not sqft. Color-matched to flooring lines.

| Transition Type | Total SKUs | Lines Covered |
|-----------------|-----------|---------------|
| T-Molding (72"/94") | ~100 | Inception, Genesis, Island |
| Reducer (72"/94") | ~90 | Inception, Genesis |
| Flush Stairnose (94") | ~90 | Inception, Genesis |
| Overlap Stairnose (94") | ~90 | Inception, Genesis |
| End Cap (72"/94") | ~85 | Inception, Genesis |
| Quarter Round (94") | ~85 | Inception, Genesis, Island |
| Cap-a-Tread (47") | ~20 | Genesis, Inception |
| Riser (47") | ~10 | Genesis |
| Multi-Purpose Reducer | ~25 | Inception |
| Wall Base (94") | ~5 | Generic |
| End Molding (72"/94") | ~10 | Genesis |

**Pricing:** $15.95-$49.00 per piece (varies by type and length)

---

## 832 Sundries (14 SKUs)

Prevail brand maintenance products. All sold by unit.

| Product | SKU | Cost |
|---------|-----|------|
| Neutral Cleaner (Gallon) | PREV-... | varies |
| Neutral Cleaner (Quart) | PREV-... | varies |
| RTU Cleaner (16oz) | PREV-... | varies |
| Grip Strip Adhesive (1oz) | PREV-... | varies |
| 3500 Adhesive (Gallon/4-Gal) | PREV-... | varies |
| 6000 Adhesive (Gallon/4-Gal) | PREV-... | varies |
| Glue-Down Underlayment (200sf roll) | PREV-... | varies |
| Universal Underlayment 1mm (200 roll) | PREV-... | varies |
| Tapping Block | PREV-... | varies |
| Gloss Finish / Scuff Remover / Stripper | PREV-... | varies |

---

## Data Flow Summary

```
Triwest FTP (832 EDI)                    metroflor.com (Shopify JSON)
─────────────────────                    ────────────────────────────
vendor_sku: MET<sku>                     variant.sku: <sku>
color (PID 73)                           title: "Line - Sub, Color"
collection (TRN/PID 77)                  tags: Collection_<name>
cost (CTP LPR)                           price (MSRP)
sqft_per_box (MEA SU)                    —
brand: METROFLOR LUXURY VINYL TILE      vendor: Metroflor
category: (none — infer from MAC)        product_type: Luxury Vinyl
                                         body_html: description (368/409)
                                         images: 1-2 per product
                                         handle: URL slug
        ↓                                         ↓
    ┌───────────────────────────────────────────────┐
    │              OUR DATABASE (PIM)               │
    │                                               │
    │  vendor: Tri-West                             │
    │  product.collection: "Metroflor - <832 coll>" │
    │  sku.vendor_sku: MET<sku>                     │
    │  sku.internal_sku: <sku> (Shopify format)     │
    │  pricing: from 832 cost + margin_tiers        │
    │  images: from Shopify JSON API                │
    │  description: from Shopify body_html          │
    │  specs: parsed from body_html                 │
    │  accessories: variant_type='accessory'        │
    └───────────────────────────────────────────────┘
```

## Import Strategy

1. **`import-triwest-832.cjs`** — Imports ALL 1,200 Metroflor SKUs from Triwest FTP (flooring + accessories + sundries). Creates products/skus/pricing.
2. **`triwest-metroflor.js` scraper** — Enrichment only. Fetches Shopify `/products.json`, matches to existing DB products by SKU (strip MET prefix) or fuzzy title match. Adds images, descriptions, spec PDFs.
3. **Gap:** 212 Shopify-only SKUs won't match any 832 items (newer products not yet in Triwest catalog, or different SKU format).
