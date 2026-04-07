import pg from 'pg';
import { upsertMediaAsset } from './base.js';

/**
 * Floor & Decor Retail Price + Data Enrichment.
 *
 * Crawls flooranddecor.com product pages to:
 *   1. Set real retail prices (F&D price → our retail_price)
 *   2. Fill description gaps the manufacturer enrichment missed
 *   3. Capture UPC/GTIN barcodes (currently 0 UPCs for these brands)
 *   4. Add images where none exist
 *
 * Scope: Schluter (2,772 products), Mapei (464), Noble (233), CBP (193)
 * These came through Daltile's 832 EDI with retail_price == cost.
 *
 * Usage:
 *   docker compose exec api node scrapers/fnd-enrich.js [--dry-run] [brand]
 *   brand: schluter | mapei | cbp | all (default)
 *   --dry-run: show matches without writing to DB
 */

const { Pool } = pg;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REQUEST_DELAY_MS = 500;
const PAGE_SIZE = 48;

// ─── Brand Config ──────────────────────────────────────────────────────────

const BRAND_CONFIG = {
  'Schluter Systems LP': {
    alias: 'schluter',
    categoryPages: [
      'https://www.flooranddecor.com/schluter-installation-materials',
    ],
    fndBrandName: 'Schluter Systems',
    dbPrefix: /^Sch\s+/i,
  },
  'Mapei Corporation': {
    alias: 'mapei',
    categoryPages: [
      'https://www.flooranddecor.com/mapei-installation-materials',
    ],
    fndBrandName: 'Mapei',
    dbPrefix: /^Map\s+/i,
  },
  'Custom Building Products INC': {
    alias: 'cbp',
    categoryPages: [
      'https://www.flooranddecor.com/installation-materials?prefn1=brand&prefv1=Custom%20Building%20Products',
    ],
    fndBrandName: 'Custom Building Products',
    dbPrefix: /^Cbp\s+/i,
  },
};

// Reverse lookup: CLI alias → collection name
const ALIAS_MAP = {};
for (const [collection, cfg] of Object.entries(BRAND_CONFIG)) {
  ALIAS_MAP[cfg.alias] = collection;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const brandArg = args.find(a => !a.startsWith('--'))?.toLowerCase() || 'all';

  const pool = new Pool({
    host: process.env.DB_HOST || 'db',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || 'postgres',
  });

  try {
    console.log('=== Floor & Decor Retail Price Enrichment ===');
    if (dryRun) console.log('>>> DRY RUN — no DB writes <<<\n');

    // Determine brands to process
    let collections;
    if (brandArg === 'all') {
      collections = Object.keys(BRAND_CONFIG);
    } else {
      const collection = ALIAS_MAP[brandArg];
      if (!collection) {
        console.error(`Unknown brand: "${brandArg}". Valid: ${Object.keys(ALIAS_MAP).join(', ')}, all`);
        process.exit(1);
      }
      collections = [collection];
    }

    // Ensure 'upc' attribute exists
    await ensureUpcAttribute(pool);

    // Process each brand
    const allStats = [];
    for (const collection of collections) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`Processing: ${collection}`);
      console.log('─'.repeat(60));

      const stats = await enrichBrand(pool, collection, dryRun);
      allStats.push({ collection, ...stats });
    }

    // Refresh search vectors
    if (!dryRun) {
      console.log('\n' + '─'.repeat(60));
      console.log('Refreshing search vectors...');
      await refreshSearchVectors(pool, collections);
    }

    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log('SUMMARY');
    console.log('═'.repeat(60));
    for (const s of allStats) {
      console.log(`${s.collection}:`);
      console.log(`  F&D products crawled: ${s.fndProducts}`);
      console.log(`  DB products matched:  ${s.matched}/${s.dbProducts}`);
      console.log(`  Prices updated:       ${s.pricesUpdated}`);
      console.log(`  Descriptions added:   ${s.descsUpdated}`);
      console.log(`  UPCs stored:          ${s.upcsStored}`);
      console.log(`  Images added:         ${s.imagesAdded}`);
    }
    console.log('\nDone.\n');

  } finally {
    await pool.end();
  }
}

// ─── Brand Enrichment ──────────────────────────────────────────────────────

async function enrichBrand(pool, collection, dryRun) {
  const config = BRAND_CONFIG[collection];
  const stats = {
    fndProducts: 0, dbProducts: 0, matched: 0,
    pricesUpdated: 0, descsUpdated: 0, upcsStored: 0, imagesAdded: 0,
  };

  // Step 1: Load DB products for this collection
  const dbProducts = await loadDbProducts(pool, collection);
  stats.dbProducts = dbProducts.length;
  console.log(`  Loaded ${dbProducts.length} DB products`);
  if (dbProducts.length === 0) return stats;

  // Step 2: Discover F&D product URLs from category pages
  console.log('  Discovering F&D product URLs...');
  const productUrls = await discoverProductUrls(config.categoryPages);
  console.log(`  Found ${productUrls.size} unique F&D product pages`);

  // Step 3: Crawl each F&D product page
  console.log('  Crawling F&D product pages...');
  const fndProducts = [];
  let crawled = 0;

  for (const url of productUrls) {
    try {
      const data = await crawlProductPage(url);
      if (data) fndProducts.push(data);
    } catch (err) {
      // Skip failed pages silently
    }
    crawled++;
    if (crawled % 20 === 0) {
      console.log(`    Crawled ${crawled}/${productUrls.size} pages (${fndProducts.length} parsed)`);
    }
    await delay(REQUEST_DELAY_MS);
  }
  stats.fndProducts = fndProducts.length;
  console.log(`  Parsed ${fndProducts.length} F&D products`);

  // Step 4: Build enrichment map keyed by normalized product-line name
  const enrichmentMap = buildEnrichmentMap(fndProducts, config.fndBrandName);
  console.log(`  Enrichment map: ${enrichmentMap.size} entries (before consolidation)`);

  // Step 4b: Consolidate entries that share a common word prefix
  consolidateEnrichmentMap(enrichmentMap);
  console.log(`  Enrichment map: ${enrichmentMap.size} entries (after consolidation)`);

  // Step 5: Match DB products and apply updates
  console.log('  Matching and updating...');
  let processed = 0;
  let errorCount = 0;
  for (const dbProd of dbProducts) {
    processed++;
    try {
      const result = await matchAndUpdate(pool, dbProd, enrichmentMap, config, dryRun);
      if (result.matched) {
        stats.matched++;
        stats.pricesUpdated += result.pricesUpdated || 0;
        stats.descsUpdated += result.descUpdated ? 1 : 0;
        stats.upcsStored += result.upcsStored || 0;
        stats.imagesAdded += result.imagesAdded || 0;
      }
    } catch (err) {
      errorCount++;
      if (errorCount <= 5) {
        console.error(`    Error on "${dbProd.name}": ${err.message}`);
      }
    }

    if (processed % 200 === 0) {
      console.log(`    Progress: ${processed}/${stats.dbProducts} — matched: ${stats.matched}`);
    }
  }

  console.log(`  Results for ${collection}:`);
  console.log(`    Matched:           ${stats.matched}/${stats.dbProducts}`);
  console.log(`    Prices updated:    ${stats.pricesUpdated}`);
  console.log(`    Descriptions:      ${stats.descsUpdated}`);
  console.log(`    UPCs:              ${stats.upcsStored}`);
  console.log(`    Images:            ${stats.imagesAdded}`);

  return stats;
}

// ─── URL Discovery ─────────────────────────────────────────────────────────

/**
 * Fetch category listing pages and extract all unique product detail URLs.
 * Paginates through all results using ?sz=48&start=N.
 */
async function discoverProductUrls(categoryPages) {
  const allUrls = new Set();

  for (const baseUrl of categoryPages) {
    let start = 0;
    let hasMore = true;

    while (hasMore) {
      const sep = baseUrl.includes('?') ? '&' : '?';
      const url = `${baseUrl}${sep}sz=${PAGE_SIZE}&start=${start}`;

      try {
        const html = await fetchPage(url);
        const urls = extractProductUrls(html);

        if (urls.length === 0) {
          hasMore = false;
        } else {
          for (const u of urls) allUrls.add(u);
          start += PAGE_SIZE;
          // Safety: stop after 20 pages (960 products max per brand)
          if (start >= 960) hasMore = false;
        }
      } catch {
        hasMore = false;
      }

      await delay(REQUEST_DELAY_MS);
    }
  }

  return allUrls;
}

/**
 * Extract product detail page URLs from category listing HTML.
 * F&D uses: href="/{category}/{slug}-{id}.html"
 */
function extractProductUrls(html) {
  const urls = new Set();
  // Match href to .html product pages with numeric or M-prefixed IDs
  const regex = /href="(\/[a-z0-9-]+\/[a-z0-9][a-z0-9%._-]+-(?:\d{6,}|[A-Z]\d{3,})\.html)"/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    urls.add(`https://www.flooranddecor.com${m[1]}`);
  }
  return [...urls];
}

// ─── Page Crawling ─────────────────────────────────────────────────────────

/**
 * Crawl a single F&D product detail page.
 * Extracts JSON-LD Product schema + HTML specs.
 */
async function crawlProductPage(url) {
  const html = await fetchPage(url);

  // Extract JSON-LD Product data
  const jsonLd = extractJsonLdProduct(html);
  if (!jsonLd) return null;

  // Extract vendor part number from specs section
  const vendorPartNo = extractSpec(html, 'Vendor Part Number') ||
                        extractSpec(html, 'Manufacturer Part Number') ||
                        extractSpec(html, 'MFG Part Number');

  // Extract description from HTML (JSON-LD description is often better)
  const metaDesc = extractMetaContent(html, 'description');
  const ogDesc = extractMetaProperty(html, 'og:description');

  return {
    url,
    name: jsonLd.name || '',
    fndSku: jsonLd.sku || '',
    gtin: jsonLd.gtin || jsonLd.gtin13 || jsonLd.gtin12 || '',
    brand: typeof jsonLd.brand === 'object' ? jsonLd.brand?.name : jsonLd.brand || '',
    price: parseFloat(jsonLd.offers?.price || jsonLd.offers?.[0]?.price || 0),
    color: jsonLd.color || '',
    size: jsonLd.size || '',
    description: jsonLd.description || ogDesc || metaDesc || '',
    images: extractImages(jsonLd, html),
    vendorPartNo,
  };
}

/**
 * Extract the JSON-LD Product block from page HTML.
 */
function extractJsonLdProduct(html) {
  const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of blocks) {
    const content = block.replace(/<script[^>]*>|<\/script>/gi, '').trim();
    try {
      const data = JSON.parse(content);
      // Could be a single object or array
      if (data['@type'] === 'Product') return data;
      if (Array.isArray(data)) {
        const prod = data.find(d => d['@type'] === 'Product');
        if (prod) return prod;
      }
      if (data['@graph']) {
        const prod = data['@graph'].find(d => d['@type'] === 'Product');
        if (prod) return prod;
      }
    } catch { /* skip malformed JSON-LD */ }
  }
  return null;
}

/**
 * Extract images from JSON-LD and HTML.
 */
function extractImages(jsonLd, html) {
  const images = [];
  const seen = new Set();

  const addImage = (url) => {
    if (!url || typeof url !== 'string') return;
    if (!url.startsWith('http')) return;
    const lower = url.toLowerCase();
    if (lower.includes('logo') || lower.includes('icon') || lower.includes('placeholder')) return;
    // Normalize for dedup: strip query params and size suffixes
    const norm = lower.split('?')[0].replace(/_thumb$/, '');
    if (seen.has(norm)) return;
    seen.add(norm);
    // Use high quality version
    const highQualUrl = url.includes('amplience.net')
      ? url.replace(/\?.*$/, '?fmt=auto&qlt=85&w=800')
      : url;
    images.push(highQualUrl);
  };

  // JSON-LD images
  if (jsonLd.image) {
    const imgList = Array.isArray(jsonLd.image) ? jsonLd.image : [jsonLd.image];
    for (const img of imgList) {
      addImage(typeof img === 'string' ? img : img?.url);
    }
  }

  // og:image
  const ogMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  if (ogMatch) addImage(ogMatch[1]);

  // Amplience CDN images from img tags
  const imgRegex = /(?:src|data-src)=["'](https:\/\/i\d+\.amplience\.net\/i\/flooranddecor\/[^"']+)["']/gi;
  let m;
  while ((m = imgRegex.exec(html)) !== null) {
    const url = m[1];
    // Skip tiny thumbnails
    if (url.includes('_thumb') || url.includes('maxW=40') || url.includes('w=50')) continue;
    addImage(url);
  }

  return images.slice(0, 6);
}

/**
 * Extract a spec value from the product specs section.
 */
function extractSpec(html, label) {
  // Pattern: <td>Label</td><td>Value</td> or <dt>Label</dt><dd>Value</dd>
  // Also: <span class="label">Label</span><span class="value">Value</span>
  const patterns = [
    new RegExp(`<t[dh][^>]*>[^<]*${escapeRegex(label)}[^<]*</t[dh]>\\s*<td[^>]*>([^<]+)</td>`, 'i'),
    new RegExp(`<dt[^>]*>[^<]*${escapeRegex(label)}[^<]*</dt>\\s*<dd[^>]*>([^<]+)</dd>`, 'i'),
    new RegExp(`${escapeRegex(label)}[:\\s]*</[^>]+>\\s*<[^>]+>([^<]+)<`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function extractMetaContent(html, name) {
  const m = html.match(new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i'));
  return m ? m[1].trim() : null;
}

function extractMetaProperty(html, prop) {
  const m = html.match(new RegExp(`<meta[^>]*property=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i'));
  return m ? m[1].trim() : null;
}

// ─── Enrichment Map Building ───────────────────────────────────────────────

/**
 * Build an enrichment map keyed by normalized product-line name.
 * Groups F&D products by product line (strips brand prefix, size, color).
 *
 * Each entry: { prices: [{price, size}], description, images, gtin, vendorPartNo }
 */
function buildEnrichmentMap(fndProducts, brandName) {
  const map = new Map();

  for (const prod of fndProducts) {
    if (!prod.name || prod.price <= 0) continue;

    // Extract product line from F&D name
    const lineName = extractProductLine(prod.name, brandName);
    if (!lineName) continue;
    const key = normalize(lineName);

    if (!map.has(key)) {
      map.set(key, {
        fndName: prod.name,
        lineName,
        description: prod.description || '',
        images: prod.images || [],
        prices: [],
        gtins: [],
        vendorPartNos: [],
      });
    }

    const entry = map.get(key);
    entry.prices.push({ price: prod.price, size: prod.size, color: prod.color, fndSku: prod.fndSku });
    if (prod.gtin) entry.gtins.push(prod.gtin);
    if (prod.vendorPartNo) entry.vendorPartNos.push(prod.vendorPartNo);

    // Keep the best description (longest)
    if (prod.description && prod.description.length > entry.description.length) {
      entry.description = prod.description;
    }
    // Keep the most images
    if (prod.images && prod.images.length > entry.images.length) {
      entry.images = prod.images;
    }
  }

  return map;
}

/**
 * Consolidate enrichment map by merging entries that share a common word prefix.
 *
 * Example: "kerdi drain flange pvc", "kerdi drain outlet body", "kerdi drain grate assembly"
 * all share the 2-word prefix "kerdi drain" → merged into one entry with aggregated prices.
 *
 * This ensures DB products like "Sch Kerdi Drain" (→ "kerdi drain") get exact matches
 * instead of relying on fuzzy containment across fragmented entries.
 */
function consolidateEnrichmentMap(map) {
  // Collect all 2-word prefixes and which keys share them
  const prefixBuckets = new Map(); // prefix → [key, key, ...]

  for (const key of map.keys()) {
    const words = key.split(' ');
    if (words.length < 2 || words[0].length < 3) continue;

    // Generate 2-word prefix (the core product line for most Schluter products)
    const prefix = words.slice(0, 2).join(' ');
    if (!prefixBuckets.has(prefix)) prefixBuckets.set(prefix, []);
    prefixBuckets.get(prefix).push(key);
  }

  // For each prefix shared by 2+ entries, create a merged entry
  for (const [prefix, keys] of prefixBuckets) {
    if (keys.length < 2) continue;
    if (map.has(prefix)) continue; // already exists as its own entry

    const entries = keys.map(k => map.get(k));
    map.set(prefix, {
      lineName: prefix,
      fndName: entries[0].fndName,
      description: entries.reduce((best, e) =>
        e.description.length > best.length ? e.description : best, ''),
      images: entries.reduce((best, e) =>
        e.images.length > best.length ? e.images : best, []),
      prices: entries.flatMap(e => e.prices),
      gtins: [...new Set(entries.flatMap(e => e.gtins))],
      vendorPartNos: [...new Set(entries.flatMap(e => e.vendorPartNos))],
    });
  }
}

/**
 * Extract product-line name from an F&D product name.
 *
 * Schluter products use hyphenated compound names as product lines:
 *   "Schluter Kerdi-Drain Flange PVC 3in. Outlet" → "Kerdi-Drain"
 *   "Schluter DITRA-HEAT-DUO 3ft. Membrane"       → "DITRA-HEAT-DUO"
 *   "Schluter Schiene Edge Trim 1/2in."            → "Schiene"
 *
 * Mapei/CBP use multi-word names (no hyphen convention):
 *   "Mapei 5220 Eggshell Ultracolor Plus FA Grout" → "Eggshell Ultracolor Plus FA Grout"
 *   "Custom Building Products VersaBond 50 lb."    → "VersaBond"
 */
function extractProductLine(fndName, brandName) {
  let name = fndName;

  // Strip brand prefix words
  const brandWords = brandName.toLowerCase().split(/\s+/);
  const nameWords = name.split(/\s+/);
  while (nameWords.length > 0 && brandWords.includes(nameWords[0].toLowerCase())) {
    nameWords.shift();
  }
  name = nameWords.join(' ');

  // Strip leading 3+ digit color codes (e.g., "5220 Eggshell" → "Eggshell")
  name = name.replace(/^\d{3,}\s+/, '');

  // For Schluter: product line = first hyphenated compound word cluster
  // "Kerdi-Drain Flange PVC" → "Kerdi-Drain"
  // "DITRA-HEAT-DUO 3ft. Membrane" → "DITRA-HEAT-DUO"
  // "Schiene Edge Trim" → "Schiene" (single word, no hyphen)
  const isSchluter = /schluter/i.test(brandName);
  if (isSchluter) {
    const hyphenMatch = name.match(/^([A-Za-z]+(?:-[A-Za-z0-9]+)*)/);
    if (hyphenMatch && hyphenMatch[1].length >= 3) {
      return hyphenMatch[1];
    }
  }

  // For other brands: strip trailing size/quantity, keep full product-line name
  name = name
    .replace(/\s+\d+(\.\d+)?\s*(in|ft|mm|cm|lb|lbs|oz|gal|qt|sqft|sf|pc|pcs|roll|each|ct|bag|pail|kit|pt|fl|mil)\b.*$/i, '')
    .replace(/\s+\d+"?\s*[xX×]\s*\d+"?.*$/i, '')       // dimensions NxN
    .replace(/\s+\d+'\s*[xX×]\s*\d+'?.*$/i, '')         // dimensions N'xN'
    .trim();

  // Strip trailing numbers
  while (/\s+\d+(\.\d+)?\s*$/.test(name)) {
    name = name.replace(/\s+\d+(\.\d+)?\s*$/, '').trim();
  }

  return name.length >= 3 ? name : null;
}

// ─── Matching ──────────────────────────────────────────────────────────────

/**
 * Match a DB product to the enrichment map and apply updates.
 * Reuses the findMatch logic from dal-enrich.js.
 */
async function matchAndUpdate(pool, dbProd, enrichmentMap, config, dryRun) {
  const result = { matched: false, pricesUpdated: 0, descUpdated: false, upcsStored: 0, imagesAdded: 0 };

  const match = findMatch(dbProd, enrichmentMap, config.dbPrefix);
  if (!match) return result;
  result.matched = true;

  if (dryRun) {
    console.log(`    MATCH: "${dbProd.name}" → "${match.lineName}" (${match.prices.length} F&D variants)`);
    if (match.prices.length > 0) {
      const prices = match.prices.map(p => `$${p.price} (${p.size || 'default'})`).join(', ');
      console.log(`           Prices: ${prices}`);
    }
    return result;
  }

  // Update retail_price for SKUs where retail_price == cost
  if (match.prices.length > 0) {
    result.pricesUpdated = await updatePrices(pool, dbProd.id, match.prices);
  }

  // Update descriptions where missing
  if (match.description) {
    const needsDesc = !dbProd.description_long || dbProd.description_long === dbProd.description_short;
    if (needsDesc) {
      const descShort = match.description.length > 300
        ? match.description.slice(0, 297) + '...'
        : match.description;
      await pool.query(
        `UPDATE products SET
           description_short = COALESCE(description_short, $2),
           description_long = COALESCE(description_long, $3),
           updated_at = NOW()
         WHERE id = $1`,
        [dbProd.id, descShort, match.description]
      );
      result.descUpdated = true;
    }
  }

  // Store GTINs as UPC attributes
  if (match.gtins.length > 0) {
    result.upcsStored = await storeUpcs(pool, dbProd.id, match.gtins);
  }

  // Add images only where none exist
  if (match.images.length > 0) {
    const existing = await pool.query(
      'SELECT id FROM media_assets WHERE product_id = $1 LIMIT 1',
      [dbProd.id]
    );
    if (existing.rows.length === 0) {
      for (let i = 0; i < Math.min(match.images.length, 6); i++) {
        const assetType = i === 0 ? 'primary' : (i <= 2 ? 'alternate' : 'lifestyle');
        await upsertMediaAsset(pool, {
          product_id: dbProd.id,
          sku_id: null,
          asset_type: assetType,
          url: match.images[i],
          original_url: match.images[i],
          sort_order: i,
        });
        result.imagesAdded++;
      }
    }
  }

  return result;
}

/**
 * Find the best match for a DB product in the enrichment map.
 * Same strategy as dal-enrich.js: strip prefix → strip quantities → normalize → match.
 */
function findMatch(dbProd, enrichmentMap, prefixRegex) {
  const name = dbProd.name;

  // Strip brand prefix (e.g., "Sch " → "")
  let baseName = name.replace(prefixRegex, '').trim();

  // Strip trailing quantity/unit patterns
  baseName = baseName
    .replace(/\s+\d+"?\s*[xX×]\s*\d+"?.*$/i, '')
    .replace(/\s+\d+'?\s*[xX×]\s*\d+'?.*$/i, '')
    .replace(/\s+\d+(\.\d+)?\s*(lb|lbs|gal|oz|pc|pcs|roll|sqft|qt|gm|ft|lf|sf|each|ct|tube|bag|pail|bucket|kit|pt|fl|mil)\b.*$/i, '')
    .replace(/\s+\d+sf\s+.*$/i, '')
    .trim();

  // Strip trailing numbers repeatedly
  while (/\s+\d+(\.\d+)?\s*$/.test(baseName)) {
    baseName = baseName.replace(/\s+\d+(\.\d+)?\s*$/, '').trim();
  }

  const key = normalize(baseName);
  if (!key) return null;

  // Exact match
  if (enrichmentMap.has(key)) return enrichmentMap.get(key);

  // Without ampersands
  const keyClean = key.replace(/&/g, '').replace(/\s+/g, ' ').trim();
  if (enrichmentMap.has(keyClean)) return enrichmentMap.get(keyClean);

  // Containment — score by overlap ratio (shorter/longer), prefer tightest fit
  let bestContainment = null;
  let bestRatio = 0;

  for (const [mapKey, data] of enrichmentMap) {
    if (mapKey.length < 3) continue;
    let ratio = 0;
    if (key.includes(mapKey)) {
      // DB key contains map key — score = map key coverage of DB key
      ratio = mapKey.length / key.length;
    } else if (mapKey.includes(key)) {
      // Map key contains DB key — score = DB key coverage of map key
      ratio = key.length / mapKey.length;
    }
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestContainment = data;
    }
  }
  if (bestContainment && bestRatio >= 0.4) return bestContainment;

  // Word overlap (Jaccard >= 0.5)
  const keyWords = new Set(key.split(' ').filter(w => w.length >= 2));
  let bestScore = 0;
  let bestMatch = null;

  for (const [mapKey, data] of enrichmentMap) {
    const mapWords = new Set(mapKey.split(' ').filter(w => w.length >= 2));
    const intersection = [...keyWords].filter(w => mapWords.has(w));
    const union = new Set([...keyWords, ...mapWords]);
    const jaccard = union.size > 0 ? intersection.length / union.size : 0;

    if (jaccard > bestScore && jaccard >= 0.5) {
      bestScore = jaccard;
      bestMatch = data;
    }
  }

  return bestMatch;
}

// ─── DB Updates ────────────────────────────────────────────────────────────

/**
 * Update retail_price for SKUs of a product, but only where retail == cost.
 * If multiple F&D size variants exist, try to match by size; otherwise use median price.
 */
async function updatePrices(pool, productId, fndPrices) {
  // Get SKUs where retail_price equals cost (no markup yet)
  const skus = await pool.query(`
    SELECT s.id, s.variant_name, p2.cost, p2.retail_price,
           sa.value AS size_attr
    FROM skus s
    JOIN pricing p2 ON p2.sku_id = s.id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
      AND sa.attribute_id = (SELECT id FROM attributes WHERE slug = 'size')
    WHERE s.product_id = $1
      AND p2.retail_price IS NOT NULL
      AND p2.cost IS NOT NULL
      AND p2.retail_price = p2.cost
  `, [productId]);

  if (skus.rows.length === 0) return 0;

  let updated = 0;

  // Sort F&D prices by price ascending for fallback
  const sortedPrices = [...fndPrices].sort((a, b) => a.price - b.price);
  const medianPrice = sortedPrices[Math.floor(sortedPrices.length / 2)]?.price;

  for (const sku of skus.rows) {
    // Try to match by size if multiple F&D prices exist
    let bestPrice = medianPrice;
    if (fndPrices.length > 1 && sku.size_attr) {
      const sizeMatch = findBestPriceBySize(sku.size_attr, sku.variant_name, fndPrices);
      if (sizeMatch) bestPrice = sizeMatch;
    } else if (fndPrices.length === 1) {
      bestPrice = fndPrices[0].price;
    }

    if (bestPrice && bestPrice > 0) {
      await pool.query(
        'UPDATE pricing SET retail_price = $2 WHERE sku_id = $1',
        [sku.id, bestPrice]
      );
      updated++;
    }
  }

  return updated;
}

/**
 * Try to find the best F&D price for a DB SKU based on size/variant attributes.
 */
function findBestPriceBySize(dbSize, variantName, fndPrices) {
  const dbSizeNorm = normalizeSize(dbSize || '');
  const variantNorm = normalizeSize(variantName || '');

  for (const fp of fndPrices) {
    const fndSizeNorm = normalizeSize(fp.size || '');
    if (fndSizeNorm && (fndSizeNorm === dbSizeNorm || fndSizeNorm === variantNorm)) {
      return fp.price;
    }
    // Check if F&D size appears in variant name
    if (variantNorm && fndSizeNorm && variantNorm.includes(fndSizeNorm)) {
      return fp.price;
    }
  }
  return null;
}

function normalizeSize(s) {
  return s.toLowerCase()
    .replace(/["″'']/g, '')
    .replace(/\s*[xX×]\s*/g, 'x')
    .replace(/\s+/g, '')
    .replace(/\.$/, '')
    .trim();
}

/**
 * Store UPC/GTIN values as sku_attributes.
 */
async function storeUpcs(pool, productId, gtins) {
  if (gtins.length === 0) return 0;

  const attrResult = await pool.query("SELECT id FROM attributes WHERE slug = 'upc'");
  if (attrResult.rows.length === 0) return 0;
  const upcAttrId = attrResult.rows[0].id;

  // Get all SKUs for this product
  const skus = await pool.query('SELECT id FROM skus WHERE product_id = $1', [productId]);
  if (skus.rows.length === 0) return 0;

  // Use the first GTIN for all SKUs of this product (they're variants of the same line)
  const gtin = gtins[0];
  let stored = 0;

  for (const sku of skus.rows) {
    const result = await pool.query(`
      INSERT INTO sku_attributes (sku_id, attribute_id, value)
      VALUES ($1, $2, $3)
      ON CONFLICT (sku_id, attribute_id) DO NOTHING
    `, [sku.id, upcAttrId, gtin]);
    if (result.rowCount > 0) stored++;
  }

  return stored;
}

/**
 * Ensure the 'upc' attribute exists in the attributes table.
 */
async function ensureUpcAttribute(pool) {
  await pool.query(`
    INSERT INTO attributes (name, slug, is_filterable)
    VALUES ('UPC', 'upc', false)
    ON CONFLICT (slug) DO NOTHING
  `);
}

// ─── DB Loading ────────────────────────────────────────────────────────────

async function loadDbProducts(pool, collection) {
  const result = await pool.query(`
    SELECT p.id, p.name, p.collection, p.vendor_id,
           p.description_short, p.description_long
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'DAL'
      AND p.collection = $1
    ORDER BY p.name
  `, [collection]);
  return result.rows;
}

// ─── Search Vector Refresh ─────────────────────────────────────────────────

async function refreshSearchVectors(pool, collections) {
  for (const collection of collections) {
    const result = await pool.query(`
      UPDATE products p SET search_vector =
        setweight(to_tsvector('english', unaccent(coalesce(p.name, ''))), 'A') ||
        setweight(to_tsvector('english', unaccent(coalesce(p.collection, ''))), 'A') ||
        setweight(to_tsvector('english', unaccent(coalesce(v.name, ''))), 'B') ||
        setweight(to_tsvector('english', unaccent(coalesce(
          (SELECT c.name FROM categories c WHERE c.id = p.category_id), ''))), 'B') ||
        setweight(to_tsvector('english', unaccent(coalesce(p.description_short, ''))), 'C') ||
        setweight(to_tsvector('english', unaccent(coalesce(
          (SELECT string_agg(DISTINCT sa.value, ' ')
           FROM skus s JOIN sku_attributes sa ON sa.sku_id = s.id
           WHERE s.product_id = p.id AND s.status = 'active'), ''))), 'D')
      FROM vendors v
      WHERE v.id = p.vendor_id
        AND p.collection = $1
    `, [collection]);
    console.log(`  ${collection}: ${result.rowCount} search vectors refreshed`);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function normalize(name) {
  return name.toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchPage(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  return resp.text();
}

// ─── Entry Point ───────────────────────────────────────────────────────────

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
