/**
 * Roca USA — Enhanced Image & Description Enrichment Scraper
 *
 * Products already imported from XLSX price book. This scraper visits
 * rocatileusa.com to capture product images, descriptions, and lifestyle
 * images from collection pages.
 *
 * Multi-pass matching strategy:
 *   Pass 1 — SKU code match (most reliable, handles CC Mosaics etc.)
 *   Pass 2 — Base color extraction + one-to-many (handles Block, Forge, etc.)
 *   Pass 3 — Fuzzy name match (fallback for remaining products)
 *
 * Collection resolution:
 *   A. Manual slug overrides (calacatta-oro → Calacata Gold, etc.)
 *   B. Fuzzy slug match (existing normalization)
 *   C. Name-prefix search (slug "astoria" finds products named "Astoria Fd Grey")
 *   D. SKU-only fallback (no collection match needed, just match SKU codes)
 *
 * Site structure:
 *   - Custom CMS (not WordPress/Shopify)
 *   - Collection pages at /collections/{slug}
 *   - All color variants on a single collection page (no pagination)
 *   - Static HTML, no lazy loading — plain <img src="/uploads/...">
 *   - Product cards: <img src="/uploads/..."> <h3>Name</h3> <p>Size<br>SKU</p>
 *
 * Usage: docker compose exec api node scrapers/roca.js
 */
import pg from 'pg';
import { delay, saveProductImages, upsertMediaAsset } from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const BASE_URL = 'https://rocatileusa.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const JUNK_PATTERNS = ['logo', 'icon', 'banner', 'thumbnail', 'badge', 'seal', 'certification', 'made-in', 'file-pdf'];

// Manual slug → DB collection name overrides for cases where names diverge
const SLUG_OVERRIDES = new Map([
  ['calacatta-oro', 'Calacata Gold'],
  ['decorative-accent-wall-tile', 'Decorative Accents & Trims'],
  ['maiolica-tile', 'Maiolica'],
  ['maiolica-floor', 'Maiolica'],
  ['pavers-styles', 'Pavers'],
  ['cc-porcelain-mosaics-plus', 'Cc Mosaics'],
  ['dolce-vita', 'Derby'],
  ['serpentino-stone-look-tile', 'Serpentino'],
  ['urban-antracita', 'Urban Antracita'],
]);

// Shape/format words to strip from DB product names when extracting base color
const FORMAT_WORDS = [
  // Shapes (longest first to avoid partial matches)
  'penny round', 'basket weave', 'basketweave', 'fish scale', 'flat top',
  'quarter round', 'chair rail', 'surface cap', 'mud cap',
  'arrow', 'flower', 'hexagon', 'square', 'triangle', 'octagon', 'arabesque',
  'picket', 'stacked', 'herringbone', 'chevron', 'diamond', 'lantern', 'fan',
  'brick', 'subway',
  // Trim types
  'bullnose', 'cove', 'v-cap', 'bead', 'pencil', 'liner', 'listello', 'jolly',
  // Formats/finishes
  'mosaic', 'field', 'fd', 'wall', 'floor',
  'smooth', 'quarry', 'polished', 'unpolished', 'matte', 'glossy', 'satin',
  'honed', 'lappato', 'structured', 'rectified',
  // CC Mosaics prefixes
  'bg', 'mg', 'ug',
  // Sizing descriptors
  'modular', 'random',
  // Common qualifiers
  'bright', 'crackled', 'rev', 'beveled', 'ac', 'br',
].sort((a, b) => b.length - a.length); // longest first for correct stripping

// ── Normalization helpers ──

function normalizeForMatch(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Normalize grey↔gray spelling for consistent color matching */
function normalizeSpelling(str) {
  return str.replace(/grey/gi, 'gray');
}

/**
 * Convert a URL-style slug to Title Case.
 * "dolce-vita" → "Dolce Vita"
 */
function deslugify(slug) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Extract the base color from a DB product name by stripping format/shape
 * words, size patterns, and common qualifiers.
 * E.g., "Hexagon Acero" → "acero", "Bg Black Penny Round" → "black",
 *       "Astoria Fd Grey" → "astoria grey"
 */
function extractBaseColor(productName) {
  let name = productName.toLowerCase();

  // Remove format words
  for (const fw of FORMAT_WORDS) {
    const escaped = fw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    name = name.replace(new RegExp('\\b' + escaped + '\\b', 'g'), ' ');
  }

  // Remove size patterns: "3 3/4x6", "12x24", etc.
  name = name.replace(/\d+\s*\d*\/?\d*\s*[x×]\s*\d+\s*\d*\/?\d*/g, ' ');
  // Remove standalone dimensions with inch marks: 6", 12"
  name = name.replace(/\d+["″']/g, ' ');
  // Remove mm measurements: 6mm, 9mm
  name = name.replace(/\d+\s*mm\b/g, ' ');
  // Remove trailing "r" (rectified marker, e.g., "12x24r")
  name = name.replace(/\b\d+r\b/g, ' ');

  return name.replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Check if a website color label matches a DB base color.
 * Uses word-level comparison: all words of the shorter set must appear in the longer set.
 * Normalizes grey↔gray spelling.
 */
function colorsMatch(webColor, dbBaseColor) {
  if (!webColor || !dbBaseColor) return false;

  // Strip format/finish words from web label too (e.g., "Biscuit Bright" → "biscuit")
  const cleanWeb = extractBaseColor(webColor);
  const cleanDb = dbBaseColor; // already stripped by caller

  const normWeb = normalizeForMatch(normalizeSpelling(cleanWeb));
  const normDb = normalizeForMatch(normalizeSpelling(cleanDb));
  if (!normWeb || !normDb) return false;
  if (normWeb === normDb) return true;

  // Word-level matching — require high overlap to avoid false positives
  // e.g. "Gris" should NOT match "Dolce Gris" (different product)
  const webWords = normalizeSpelling(cleanWeb).split(/\s+/).filter(w => w.length >= 2);
  const dbWords = normalizeSpelling(cleanDb).split(/\s+/).filter(w => w.length >= 2);
  if (!webWords.length || !dbWords.length) return false;

  // All words of the shorter set must appear in the longer set
  const [shorter, longer] = webWords.length <= dbWords.length
    ? [webWords, dbWords] : [dbWords, webWords];
  const longerSet = new Set(longer);
  if (!shorter.every(w => longerSet.has(w))) return false;

  // Require the shorter set covers at least 2/3 of the longer set's words.
  // This prevents 1-word labels ("Gris") from matching 2+ word names ("Dolce Gris")
  // while allowing exact matches and cases where format stripping leaves identical words.
  const coverage = shorter.length / longer.length;
  return coverage >= 0.65;
}

// ── Fetch ──

async function fetchHtml(url) {
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!resp.ok) return null;
    return resp.text();
  } catch { return null; }
}

// ── Step 1: Discover collection slugs from /category/all ──

async function getCollectionSlugs() {
  const html = await fetchHtml(`${BASE_URL}/category/all`);
  if (!html) return [];
  const slugs = new Set();
  const regex = /href="\/collections\/([^"]+)"/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    slugs.add(m[1].replace(/\/$/, ''));
  }
  return [...slugs];
}

// ── Extract product entries (image + name + SKU codes) from a collection page ──

function extractProductEntries(html) {
  const results = [];
  const seen = new Set();

  // Pattern: <img src="/uploads/..."> ... <h3>Name</h3> optionally followed by <p>size<br>SKU</p>
  const entryRegex = /<img\s+[^>]*src="(\/uploads\/[^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([^<]+)<\/h3>(?:\s*<p[^>]*>([\s\S]*?)<\/p>)?/gi;
  let m;
  while ((m = entryRegex.exec(html)) !== null) {
    const imgPath = m[1];
    const colorName = m[2].trim();
    const detailsHtml = m[3] || '';

    // Filter out junk images
    const imgLower = imgPath.toLowerCase();
    if (JUNK_PATTERNS.some(junk => imgLower.includes(junk))) continue;

    // Extract SKU codes from the <p> content
    const skuCodes = [];
    if (detailsHtml) {
      const text = detailsHtml.replace(/<[^>]+>/g, ' ');
      const tokens = text.split(/[\s,;]+/).filter(Boolean);
      for (const token of tokens) {
        // SKU pattern: 2+ uppercase letters followed by alphanumeric/hyphens, 6+ chars total
        if (/^[A-Z]{2,}[\w-]+$/.test(token) && token.length >= 6) {
          skuCodes.push(token);
        }
      }
    }

    if (!seen.has(imgPath)) {
      seen.add(imgPath);
      results.push({ url: BASE_URL + imgPath, color: colorName, skuCodes });
    }
  }

  return results;
}

// ── Extract collection description ──

function extractDescription(html) {
  // Find the <h1> tag, then look for the first substantial <p> after it
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (!h1Match) return null;

  const afterH1 = html.substring(h1Match.index + h1Match[0].length);
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = pRegex.exec(afterH1)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (text.length >= 40) return text;
    // Don't search too far from the h1
    if (m.index > 2000) break;
  }
  return null;
}

// ── Extract lifestyle/room scene images ──

function extractLifestyleImages(html, productImagePaths) {
  const lifestyle = [];
  const seen = new Set(productImagePaths);

  const imgRegex = /<img\s+[^>]*src="(\/uploads\/[^"]+)"[^>]*>/gi;
  let m;
  while ((m = imgRegex.exec(html)) !== null) {
    const imgPath = m[1];
    if (seen.has(imgPath)) continue;
    seen.add(imgPath);

    const lower = imgPath.toLowerCase();
    if (JUNK_PATTERNS.some(junk => lower.includes(junk))) continue;
    // Skip WordPress-style thumbnails (e.g., -400x400.jpeg.webp)
    if (/-\d+x\d+\./.test(lower)) continue;

    lifestyle.push(BASE_URL + imgPath);
  }

  return lifestyle.slice(0, 6);
}

// ── Match website slug to a DB collection ──

function findBestCollection(slug, byCollection) {
  const normSlug = normalizeForMatch(slug);

  // Exact normalized match
  if (byCollection.has(normSlug)) return byCollection.get(normSlug);

  // Prefix/suffix match where strings are similar length
  for (const [normCol, prods] of byCollection) {
    const shorter = Math.min(normCol.length, normSlug.length);
    const longer = Math.max(normCol.length, normSlug.length);
    if (shorter < 4) continue;
    if (shorter / longer < 0.7) continue;
    if (normSlug.startsWith(normCol) || normCol.startsWith(normSlug)) return prods;
  }

  return null;
}

// ── Resolve a website slug to DB collection + products ──

function resolveCollection(slug, allByCollection) {
  // A. Manual overrides
  if (SLUG_OVERRIDES.has(slug)) {
    const override = SLUG_OVERRIDES.get(slug);
    const normCol = normalizeForMatch(override);
    if (allByCollection.has(normCol)) {
      const prods = allByCollection.get(normCol);
      return { products: prods, collectionName: prods[0].collection, subPrefix: null };
    }
  }

  // B. Fuzzy slug match
  const fuzzyResult = findBestCollection(slug, allByCollection);
  if (fuzzyResult) {
    return { products: fuzzyResult, collectionName: fuzzyResult[0].collection, subPrefix: null };
  }

  // C. Name-prefix search: deslugify slug and look for products whose name starts with it
  const deslug = deslugify(slug);
  const deslugLower = deslug.toLowerCase();
  for (const [, prods] of allByCollection) {
    const matching = prods.filter(p => {
      const nameLower = p.name.toLowerCase();
      return nameLower.startsWith(deslugLower + ' ') || nameLower === deslugLower;
    });
    if (matching.length > 0) {
      return { products: matching, collectionName: matching[0].collection, subPrefix: deslug };
    }
  }

  return null;
}

// ── Main ──

async function run() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'ROCA'");
  if (!vendorRes.rows.length) { console.error('ROCA vendor not found'); return; }
  const vendorId = vendorRes.rows[0].id;

  // Get all products with SKU info
  const dbProducts = await pool.query(`
    SELECT p.id as product_id, p.name, p.collection, p.description_short,
           array_agg(DISTINCT s.vendor_sku) FILTER (WHERE s.vendor_sku IS NOT NULL) as vendor_skus
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
    GROUP BY p.id, p.name, p.collection, p.description_short
    ORDER BY p.collection, p.name
  `, [vendorId]);

  // Check which already have images (both product-level AND SKU-level)
  const existingImages = await pool.query(`
    SELECT DISTINCT p.id as product_id
    FROM products p
    WHERE p.vendor_id = $1 AND EXISTS (
      SELECT 1 FROM media_assets ma
      WHERE ma.product_id = p.id AND ma.asset_type = 'primary'
    )
  `, [vendorId]);
  const alreadyHasImage = new Set(existingImages.rows.map(r => r.product_id));

  // Build vendor_sku → product lookup for Pass 1
  const skuToProduct = new Map();
  for (const prod of dbProducts.rows) {
    if (prod.vendor_skus) {
      for (const sku of prod.vendor_skus) {
        skuToProduct.set(sku.toUpperCase(), prod);
      }
    }
  }

  // Group ALL products by normalized collection name
  const allByCollection = new Map();
  for (const prod of dbProducts.rows) {
    const normCol = normalizeForMatch(prod.collection);
    if (!allByCollection.has(normCol)) allByCollection.set(normCol, []);
    allByCollection.get(normCol).push(prod);
  }

  const totalProducts = dbProducts.rowCount;
  const initialWithImages = alreadyHasImage.size;
  console.log(`Total Roca products: ${totalProducts}`);
  console.log(`Already have images: ${initialWithImages}`);
  console.log(`Need images: ${totalProducts - initialWithImages}\n`);

  // Step 1: Discover collection slugs
  console.log('=== Step 1: Discovering collection URLs ===');
  const slugs = await getCollectionSlugs();
  console.log(`  Found ${slugs.length} collection slugs\n`);

  // Step 2: Process each collection page
  console.log('=== Step 2: Scraping collection pages ===');
  let totalMatched = 0;
  let totalDescriptions = 0;
  let totalLifestyle = 0;
  const newlyMatchedIds = new Set();
  const unmatchedSlugs = [];

  const needsImage = (pid) => !alreadyHasImage.has(pid) && !newlyMatchedIds.has(pid);

  for (const slug of slugs) {
    const url = `${BASE_URL}/collections/${slug}`;
    const html = await fetchHtml(url);
    if (!html) { await delay(300); continue; }

    const entries = extractProductEntries(html);
    const description = extractDescription(html);

    // ── Resolve slug → DB collection ──
    const resolved = resolveCollection(slug, allByCollection);

    // ── If no collection match, try SKU-only matching ──
    if (!resolved) {
      if (entries.length > 0) {
        let skuMatches = 0;
        for (const entry of entries) {
          for (const skuCode of entry.skuCodes) {
            const prod = skuToProduct.get(skuCode.toUpperCase());
            if (prod && needsImage(prod.product_id)) {
              await saveProductImages(pool, prod.product_id, [entry.url], { maxImages: 1 });
              newlyMatchedIds.add(prod.product_id);
              skuMatches++;
            }
          }
        }
        if (skuMatches > 0) {
          console.log(`  [SKU-only] ${slug}: ${skuMatches} products matched`);
          totalMatched += skuMatches;
        } else {
          unmatchedSlugs.push(slug);
        }
      }
      await delay(500);
      continue;
    }

    const { products: collectionProducts, collectionName, subPrefix } = resolved;
    const prefixToStrip = subPrefix || collectionName;

    // ── Update descriptions ──
    if (description) {
      if (subPrefix) {
        // Sub-collection: only update the filtered products
        for (const prod of collectionProducts) {
          if (!prod.description_short) {
            await pool.query('UPDATE products SET description_short = $1 WHERE id = $2 AND description_short IS NULL',
              [description, prod.product_id]);
            totalDescriptions++;
          }
        }
      } else {
        const descRes = await pool.query(`
          UPDATE products SET description_short = $1
          WHERE vendor_id = $2 AND collection = $3 AND description_short IS NULL
        `, [description, vendorId, collectionName]);
        if (descRes.rowCount > 0) totalDescriptions += descRes.rowCount;
      }
    }

    if (!entries.length) { await delay(500); continue; }

    let collectionMatched = 0;

    // ── Pass 1: SKU code match (unrestricted by collection) ──
    for (const entry of entries) {
      for (const skuCode of entry.skuCodes) {
        const prod = skuToProduct.get(skuCode.toUpperCase());
        if (prod && needsImage(prod.product_id)) {
          await saveProductImages(pool, prod.product_id, [entry.url], { maxImages: 1 });
          newlyMatchedIds.add(prod.product_id);
          collectionMatched++;
        }
      }
    }

    // ── Pass 2: Base color extraction with best-match scoring ──
    // Collect all candidate matches, score by Jaccard word overlap, assign best per product
    const pass2Candidates = new Map(); // product_id → [{entry, score}]

    for (const entry of entries) {
      // Strip collection/sub-collection prefix from the website label
      let webColor = entry.color;
      if (webColor.toUpperCase().startsWith(prefixToStrip.toUpperCase() + ' ')) {
        webColor = webColor.substring(prefixToStrip.length + 1).trim();
      }
      webColor = webColor.replace(/^Suite\s+/i, '').trim();
      if (!webColor) continue;

      for (const prod of collectionProducts) {
        if (!needsImage(prod.product_id)) continue;

        // For sub-collections, strip the sub-prefix from DB name too
        let dbName = prod.name;
        if (subPrefix) {
          const spLower = subPrefix.toLowerCase();
          if (dbName.toLowerCase().startsWith(spLower + ' ')) {
            dbName = dbName.substring(subPrefix.length + 1).trim();
          } else if (dbName.toLowerCase().startsWith(spLower)) {
            dbName = dbName.substring(subPrefix.length).trim();
          }
        }
        const baseColor = extractBaseColor(dbName);
        if (colorsMatch(webColor, baseColor)) {
          // Score by Jaccard similarity between web label (+ image filename) and full product name.
          // Image filename often contains shape info (e.g. CARRARA-PENNY-ROUND-12X12.jpeg)
          // that distinguishes same-label entries on the page.
          const labelWords = normalizeSpelling(webColor.toLowerCase()).split(/[^a-z]+/).filter(w => w.length >= 2);
          const imgFile = entry.url.split('/').pop().replace(/\.(jpeg|jpg|png|webp|gif)/gi, '').toLowerCase();
          const imgWords = imgFile.split(/[^a-z]+/).filter(w => w.length >= 3);
          const webWords = new Set([...labelWords, ...imgWords]);
          const nameWords = normalizeSpelling(dbName.toLowerCase()).split(/[^a-z]+/).filter(w => w.length >= 2);
          const intersection = nameWords.filter(w => webWords.has(w)).length;
          const union = new Set([...webWords, ...nameWords]).size;
          const score = union > 0 ? intersection / union : 0;

          if (!pass2Candidates.has(prod.product_id)) pass2Candidates.set(prod.product_id, []);
          pass2Candidates.get(prod.product_id).push({ entry, score });
        }
      }
    }

    // Assign best-scoring match per product
    for (const [pid, candidates] of pass2Candidates) {
      candidates.sort((a, b) => b.score - a.score);
      await saveProductImages(pool, pid, [candidates[0].entry.url], { maxImages: 1 });
      newlyMatchedIds.add(pid);
      collectionMatched++;
    }

    // ── Pass 3: Fuzzy name match (remaining unmatched products) ──
    for (const prod of collectionProducts) {
      if (!needsImage(prod.product_id)) continue;

      const normProd = normalizeForMatch(prod.name);
      let bestEntry = null;
      let bestScore = 0;

      for (const entry of entries) {
        const normFull = normalizeForMatch(entry.color);

        // Strip collection prefix
        let colorOnly = entry.color;
        if (colorOnly.toUpperCase().startsWith(prefixToStrip.toUpperCase() + ' ')) {
          colorOnly = colorOnly.substring(prefixToStrip.length + 1).trim();
        }
        const normColor = normalizeForMatch(colorOnly);

        let score = 0;
        if (normColor === normProd || normFull === normProd) {
          score = 1.0;
        } else if (normProd.length >= 3 && (normColor.includes(normProd) || normProd.includes(normColor))) {
          // Require substring to be at least 70% of the longer string to avoid
          // false positives like "gris" matching "dolcegris"
          const ratio = Math.min(normColor.length, normProd.length) / Math.max(normColor.length, normProd.length);
          if (ratio >= 0.7) score = 0.7;
        } else if (normProd.length >= 3 && (normFull.includes(normProd) || normProd.includes(normFull))) {
          const ratio = Math.min(normFull.length, normProd.length) / Math.max(normFull.length, normProd.length);
          if (ratio >= 0.7) score = 0.6;
        }

        if (score > bestScore) {
          bestScore = score;
          bestEntry = entry;
        }
      }

      if (bestEntry && bestScore >= 0.6) {
        await saveProductImages(pool, prod.product_id, [bestEntry.url], { maxImages: 1 });
        newlyMatchedIds.add(prod.product_id);
        collectionMatched++;
      }
    }

    // ── Lifestyle images ──
    const productImagePaths = new Set(entries.map(e => e.url.replace(BASE_URL, '')));
    const lifestyleUrls = extractLifestyleImages(html, productImagePaths);
    if (lifestyleUrls.length > 0) {
      const targetProd = collectionProducts[0];
      for (let i = 0; i < lifestyleUrls.length; i++) {
        await upsertMediaAsset(pool, {
          product_id: targetProd.product_id,
          sku_id: null,
          asset_type: 'lifestyle',
          url: lifestyleUrls[i],
          original_url: lifestyleUrls[i],
          sort_order: 10 + i,
        });
        totalLifestyle++;
      }
    }

    if (collectionMatched > 0) {
      const label = subPrefix ? `${collectionName} → ${subPrefix}` : collectionName;
      console.log(`  ${label}: ${collectionMatched}/${collectionProducts.length} products matched (${entries.length} entries on page)`);
      totalMatched += collectionMatched;
    }

    await delay(800);
  }

  // ── Results ──
  const stillMissing = dbProducts.rows.filter(p => !alreadyHasImage.has(p.product_id) && !newlyMatchedIds.has(p.product_id));
  const missingByCollection = new Map();
  for (const p of stillMissing) {
    if (!missingByCollection.has(p.collection)) missingByCollection.set(p.collection, []);
    missingByCollection.get(p.collection).push(p.name);
  }

  console.log(`\n=== Scrape Complete ===`);
  console.log(`Products already had images: ${initialWithImages}`);
  console.log(`Products newly matched: ${totalMatched}`);
  console.log(`Products with descriptions added: ${totalDescriptions}`);
  console.log(`Lifestyle images saved: ${totalLifestyle}`);
  console.log(`Products still missing images: ${stillMissing.length}`);
  console.log(`Total with images now: ${initialWithImages + newlyMatchedIds.size}/${totalProducts} (${Math.round((initialWithImages + newlyMatchedIds.size) / totalProducts * 100)}%)`);

  if (unmatchedSlugs.length > 0) {
    console.log(`\nUnmatched website slugs (${unmatchedSlugs.length}): ${unmatchedSlugs.join(', ')}`);
  }

  if (missingByCollection.size > 0) {
    console.log(`\nMissing by collection (${missingByCollection.size} collections):`);
    for (const [col, names] of [...missingByCollection].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (names.length <= 5) {
        console.log(`  ${col}: ${names.join(', ')}`);
      } else {
        console.log(`  ${col}: ${names.length} products (${names.slice(0, 3).join(', ')}...)`);
      }
    }
  }

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
