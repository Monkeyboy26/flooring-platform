# Siena Decor — Catalog Audit (2026-08-27)

**Method:** Every collection we carry (79) diffed against the live sienadecor.com portfolio
pages. Our data was built from a **Feb-2024 price-list PDF** (`backend/scrapers/siena.js`
`PRICE_LIST`); the website is the current catalog.

## Verdict

Our entire Siena catalog is stale. Siena refreshed the line since the 2024 PDF and
**~60 of 79 collections have drifted** — colors renamed or fully swapped, and formats
changed. Two of the user's specific observations are confirmed system-wide:

1. **Products that no longer exist.** e.g. *Carpet Arena / Ceniza / Granate / Marengo* are
   gone — Carpet is now **Sand / Vestige**. Whole color sets were replaced on Cento Per
   Cento, Opal, Garda, Canvas, Zafiro, Rock, Lux, Orchestra, Viena, Terra, and more.
2. **Larger sizes were never created.** Siena moved much of the line to large formats we
   never built SKUs for (see list below).

## Dead / repurposed pages (highest priority)

| Collection | State |
|---|---|
| Factoryhex | Page 404 (both slug variants) — discontinued |
| Monochrome Wave | Page 404 — discontinued |
| Factory | Slug now serves "FactoryHEX" 9x19 hexagon — our rectangular Factory gone |
| Nativa | Slug now a 6x16 stone-look (Dark/Light/Medium) — our porcelain Nativa gone |
| Lux | Entirely new India-made marble range — our 3 "Polished" colors gone |

## Large formats on the site that we never created ("larger sizes never created")

| Collection | Our size(s) | Current site format(s) |
|---|---|---|
| Carpet | 18x18, 10x30 | **24x40, 20x40**, 10x30 |
| Bohemian | 6x25 | **20x40, 60x60, 100x100** |
| Pierre | 3x12 | **60x120, 120x120**, 12x24 |
| Circe | 12x36 | **30x90, 60x120**, 12x36 |
| Marmo | 10x30, 18x18 | **24x48, 32x32**, 24x24, 12x24 |
| Powder | 12x24 | **24x48** |
| Ecoluxe | 12x36 | **24x48** |
| Wales | 12x24 | **24x48** |
| Geoblanco | 12x36 | **24x48** |
| Terrazo | 24x24 | **32x32** |
| Orlando | 18x18 | **30x30** |
| Levante | 12x36 | **30x30** |
| Timeless | 12x24 | **9x60** (wood plank) |
| Nolan | 12x24 | **12x48, 8x48** (wood plank) |
| Torp | 8x48 | **24x24** |
| Super White | 12x24 | **24x48, 32x32** + more |
| Sabina | 12x24 | **6x36** (wood plank) |
| Madison | 12x24 | **6x36** |
| Color Collection | 4x16 max | **6x18** + more |

## Full color/size turnover (effectively re-onboard) 

Cento Per Cento, Opal, Industrial, Marble Carrara, Canvas, Zafiro, Garda, Rock, Materica,
Canet, Dimsey, Orchestra, Viena, Stony, De Brick, Terra, Oxford 948, Pulpis, Powder,
Geoblanco, Romani, Bohemian, Pierre, Circe, Marmo, Lux, Country, Carpet.

## Renames only (same product, new color names — safe to re-map)

Garda→Lake Garda towns, Rock→Petra/Teide/Vulcano, Materica→English names,
Devon Decor→Inlay, Marquina Black→Nero, Ledgestone British Bone→British Beige,
Formworks Cenere→Grey, Color Collection White Ice→White Glossy, Carpet Arena→Sand.

## Clean / near-matches (colors still valid)

Forest, Kehl, Limestone, H-Stone (+new mosaics), Crosswood, Peak, Paddington, Wales,
Vulcani, Fossil, Victorian (colors same, size 10x10→4x12), Flagstone (colors same).

## Caveat on confidence

Per-collection color/size strings come from a small extraction model reading each page and
occasionally garble a size (e.g. "30' X 30'" for 30x30). The **aggregate signal — pervasive
staleness — is high confidence** (I hand-verified Carpet). Before any bulk edit, the current
detail should be reconciled against **Siena's current price-list PDF**, which is also the
right source for accurate SKUs, packaging (pcs/box, sqft/box), and pricing — the website
only shows colors/sizes, not price or packaging.

## Recommendation

Do **not** patch collection-by-collection — the drift is too broad. Get Siena's **current
price list** and re-onboard the whole vendor (rewrite `PRICE_LIST` in `siena.js`, re-run the
scraper, deactivate SKUs that no longer exist). Until then, consider **deactivating** the
dead pages (Factoryhex, Monochrome Wave, Factory, Nativa, Lux) so customers can't buy
discontinued items.
