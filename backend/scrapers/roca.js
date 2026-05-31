/**
 * Roca USA — Enhanced Image & Description Enrichment Scraper
 *
 * Products already imported from XLSX price book. This scraper visits
 * rocatileusa.com to capture product images, descriptions, and lifestyle
 * images from collection pages.
 *
 * SKU-level gap-filler: for any SKU not already covered by the portal
 * scrape (roca-portal-scrape.mjs), get per-SKU primary images from
 * the website collection pages. Also scrapes PDFs (tech sheets, sell sheets).
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
import { delay, saveProductImages, saveSkuImages, upsertMediaAsset } from './base.js';

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

// Shape/finish words to PRESERVE for mosaic collections (CC Mosaics, CC Porcelain)
// so that "Bright White Picket" and "Matte White Penny Round" don't both reduce to "white"
const MOSAIC_KEEP_WORDS = new Set([
  'penny round', 'basket weave', 'basketweave', 'fish scale', 'flat top',
  'arrow', 'flower', 'hexagon', 'square', 'triangle', 'octagon', 'arabesque',
  'picket', 'stacked', 'herringbone', 'chevron', 'diamond', 'lantern', 'fan',
  'brick', 'subway',
  'bright', 'matte', 'glossy', 'crackled',
]);

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
 * Extract a size string (e.g., "12x24") from <p> tag text on collection pages.
 * Handles formats: 12"x24", 12x24, 12 x 24, 8"x8", 12"x24" R
 */
function extractSizeFromText(text) {
  if (!text) return null;
  const m = text.match(/(\d+)\s*["″]?\s*[xX×]\s*(\d+)\s*["″]?/);
  if (m) return `${m[1]}x${m[2]}`;
  return null;
}

/**
 * Given a product and a collection page entry, find the best-matching SKU
 * within that product's SKUs.
 *
 * Priority:
 * 1. If only one non-accessory SKU → return it
 * 2. Match entry size against SKU variant_name sizes
 * 3. Match entry color words against SKU variant_name
 * 4. Fall back to first candidate needing an image
 */
function findBestSku(productId, entry, skusByProduct, needsImageFn) {
  const skus = skusByProduct.get(productId);
  if (!skus || skus.length === 0) return null;

  // Filter to non-accessory SKUs
  const candidates = skus.filter(s => s.variant_type !== 'accessory');
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Try matching by size
  const entrySize = entry.size || extractSizeFromText(entry.color);
  if (entrySize) {
    const normEntrySize = entrySize.replace(/\s/g, '').toLowerCase();
    for (const sku of candidates) {
      if (!sku.variant_name) continue;
      const normVariant = sku.variant_name.replace(/\s/g, '').toLowerCase();
      if (normVariant.includes(normEntrySize)) {
        if (needsImageFn(sku.sku_id)) return sku;
      }
    }
  }

  // Try matching entry color words against variant_name
  if (entry.color) {
    const colorWords = entry.color.toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 3);
    if (colorWords.length > 0) {
      let bestSku = null;
      let bestOverlap = 0;
      for (const sku of candidates) {
        if (!sku.variant_name) continue;
        const variantWords = sku.variant_name.toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 3);
        const overlap = colorWords.filter(w => variantWords.includes(w)).length;
        if (overlap > bestOverlap && needsImageFn(sku.sku_id)) {
          bestOverlap = overlap;
          bestSku = sku;
        }
      }
      if (bestSku) return bestSku;
    }
  }

  // Fall back to first candidate needing an image
  const needingImage = candidates.find(s => needsImageFn(s.sku_id));
  return needingImage || candidates[0];
}

/**
 * Extract the base color from a DB product name by stripping format/shape
 * words, size patterns, and common qualifiers.
 * E.g., "Hexagon Acero" → "acero", "Bg Black Penny Round" → "black",
 *       "Astoria Fd Grey" → "astoria grey"
 */
function extractBaseColor(productName, { keepMosaicWords = false } = {}) {
  let name = productName.toLowerCase();

  // Remove format words (skip shape/finish words for mosaic collections)
  for (const fw of FORMAT_WORDS) {
    if (keepMosaicWords && MOSAIC_KEEP_WORDS.has(fw)) continue;
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
function colorsMatch(webColor, dbBaseColor, { keepMosaicWords = false } = {}) {
  if (!webColor || !dbBaseColor) return false;

  // Strip format/finish words from web label too (e.g., "Biscuit Bright" → "biscuit")
  const cleanWeb = extractBaseColor(webColor, { keepMosaicWords });
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

// ── Extract product entries (image + name + SKU codes + size) from a collection page ──

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

    // Extract SKU codes and size from the <p> content
    const skuCodes = [];
    let size = null;
    if (detailsHtml) {
      const text = detailsHtml.replace(/<[^>]+>/g, ' ');
      size = extractSizeFromText(text);
      const tokens = text.split(/[\s,;]+/).filter(Boolean);
      for (const token of tokens) {
        // SKU code pattern: starts with uppercase letter, second char is uppercase or digit,
        // then word chars/hyphens, 6+ chars total. Filters regular English words (lowercase 2nd char).
        // Matches: U081BV-12MT, UFCC126-12MT, GRNE0BO161, U259CCI-12, FWM6A57021
        // Rejects: Bright, Mosaic, Beveled, Wall (lowercase 2nd char)
        if (/^[A-Z][A-Z0-9][\w-]*$/.test(token) && token.length >= 6) {
          skuCodes.push(token);
        }
        // Short SKU prefix pattern: letter(s) + digits, 3-5 chars (e.g., "U081", "R90")
        else if (/^[A-Z]\d{2,4}$/i.test(token) && token.length >= 3 && token.length <= 5) {
          skuCodes.push(token);
        }
        // Alphanumeric codes with hyphens that look like vendor SKUs (e.g., "081-A106")
        else if (/^\d{2,4}-[A-Z]\d+$/i.test(token)) {
          skuCodes.push(token);
        }
      }
    }

    if (!seen.has(imgPath)) {
      seen.add(imgPath);
      results.push({ url: BASE_URL + imgPath, color: colorName, skuCodes, size });
    } else {
      // Same image used for multiple sizes — merge SKU codes into existing entry
      const existing = results.find(r => r.url === BASE_URL + imgPath);
      if (existing) {
        for (const code of skuCodes) {
          if (!existing.skuCodes.includes(code)) existing.skuCodes.push(code);
        }
      }
    }
  }

  return results;
}

// ── Extract PDF links from collection page ──

function extractPdfLinks(html) {
  const pdfs = [];
  const seen = new Set();
  const regex = /<a\s+[^>]*href="(\/uploads\/[^"]+\.pdf)"[^>]*>([^<]*)<\/a>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const path = m[1];
    if (seen.has(path)) continue;
    seen.add(path);
    pdfs.push({ url: BASE_URL + path, label: m[2].trim() });
  }
  return pdfs;
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
      const nameLower = p.product_name.toLowerCase();
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

  // Load all SKUs with product info
  const dbSkus = await pool.query(`
    SELECT s.id as sku_id, s.product_id, s.vendor_sku, s.variant_name, s.variant_type,
           p.name as product_name, p.collection, p.description_short
    FROM skus s JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1
    ORDER BY p.collection, p.name, s.variant_name
  `, [vendorId]);

  // Which SKUs already have primary images (from portal)?
  const existingSkuImages = await pool.query(`
    SELECT DISTINCT sku_id FROM media_assets
    WHERE sku_id IS NOT NULL AND asset_type = 'primary'
    AND product_id IN (SELECT id FROM products WHERE vendor_id = $1)
  `, [vendorId]);
  const skusWithImages = new Set(existingSkuImages.rows.map(r => r.sku_id));

  // Which products already have PDFs?
  const existingPdfs = await pool.query(`
    SELECT DISTINCT product_id FROM media_assets
    WHERE asset_type = 'spec_pdf'
    AND product_id IN (SELECT id FROM products WHERE vendor_id = $1)
  `, [vendorId]);
  const productsWithPdfs = new Set(existingPdfs.rows.map(r => r.product_id));

  // Build lookups
  const vendorSkuToSku = new Map(); // vendor_sku (uppercase) → SKU record
  const skusByProduct = new Map();  // product_id → SkuRecord[]
  const productSet = new Set();     // unique product_ids
  const skuPrefixMap = new Map();   // prefix (part before first "-", uppercase) → SkuRecord[]

  for (const sku of dbSkus.rows) {
    if (sku.vendor_sku) {
      vendorSkuToSku.set(sku.vendor_sku.toUpperCase(), sku);
      // Build prefix map: "U081-28" → prefix "U081", "081-A106" → prefix "081"
      const prefix = sku.vendor_sku.split('-')[0].toUpperCase();
      if (prefix.length >= 3 && prefix.length <= 5) {
        if (!skuPrefixMap.has(prefix)) skuPrefixMap.set(prefix, []);
        skuPrefixMap.get(prefix).push(sku);
      }
    }
    if (!skusByProduct.has(sku.product_id)) skusByProduct.set(sku.product_id, []);
    skusByProduct.get(sku.product_id).push(sku);
    productSet.add(sku.product_id);
  }

  // Group ALL products by normalized collection name (deduplicated by product_id)
  const allByCollection = new Map();
  const seenProducts = new Set();
  for (const sku of dbSkus.rows) {
    if (seenProducts.has(sku.product_id)) continue;
    seenProducts.add(sku.product_id);
    const normCol = normalizeForMatch(sku.collection);
    if (!allByCollection.has(normCol)) allByCollection.set(normCol, []);
    allByCollection.get(normCol).push(sku);
  }

  const totalSkus = dbSkus.rowCount;
  const totalProducts = productSet.size;
  const initialSkusWithImages = skusWithImages.size;
  console.log(`Total Roca SKUs: ${totalSkus} (across ${totalProducts} products)`);
  console.log(`SKUs already have primary images: ${initialSkusWithImages}`);
  console.log(`SKUs need images: ${totalSkus - initialSkusWithImages}`);
  console.log(`Products already have PDFs: ${productsWithPdfs.size}\n`);

  // Step 1: Discover collection slugs
  console.log('=== Step 1: Discovering collection URLs ===');
  const slugs = await getCollectionSlugs();
  console.log(`  Found ${slugs.length} collection slugs\n`);

  // Step 2: Process each collection page
  console.log('=== Step 2: Scraping collection pages ===');
  let totalMatched = 0;
  let totalDescriptions = 0;
  // Lifestyle scraping disabled — collection page images mix product shots from other variants
  let totalPdfs = 0;
  const newlyMatchedSkuIds = new Set();
  const unmatchedSlugs = [];

  const needsImage = (skuId) => !skusWithImages.has(skuId) && !newlyMatchedSkuIds.has(skuId);

  for (const slug of slugs) {
    const url = `${BASE_URL}/collections/${slug}`;
    const html = await fetchHtml(url);
    if (!html) { await delay(300); continue; }

    const entries = extractProductEntries(html);
    const description = extractDescription(html);

    // ── Resolve slug → DB collection ──
    const resolved = resolveCollection(slug, allByCollection);

    // ── If no collection match, try SKU-only matching (full + prefix) ──
    if (!resolved) {
      if (entries.length > 0) {
        let skuMatches = 0;
        for (const entry of entries) {
          for (const skuCode of entry.skuCodes) {
            const upper = skuCode.toUpperCase();
            // Try exact vendor_sku match first
            const sku = vendorSkuToSku.get(upper);
            if (sku && needsImage(sku.sku_id)) {
              await saveSkuImages(pool, sku.product_id, sku.sku_id, [entry.url], { maxImages: 1 });
              newlyMatchedSkuIds.add(sku.sku_id);
              skuMatches++;
            } else if (!sku) {
              // Try prefix match: short code like "U081" → all SKUs with that prefix
              const prefixSkus = skuPrefixMap.get(upper);
              if (prefixSkus) {
                for (const pSku of prefixSkus) {
                  if (pSku.variant_type === 'accessory') continue;
                  if (needsImage(pSku.sku_id)) {
                    await saveSkuImages(pool, pSku.product_id, pSku.sku_id, [entry.url], { maxImages: 1 });
                    newlyMatchedSkuIds.add(pSku.sku_id);
                    skuMatches++;
                  }
                }
              }
            }
          }
        }
        if (skuMatches > 0) {
          console.log(`  [SKU-only] ${slug}: ${skuMatches} SKUs matched`);
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

    // ── Pass 1: SKU code match (exact + prefix, unrestricted by collection) ──
    const pass1UsedEntries = new Set(); // entries consumed by SKU code match — skip in Pass 2/3
    for (const entry of entries) {
      for (const skuCode of entry.skuCodes) {
        const upper = skuCode.toUpperCase();
        // Try exact vendor_sku match
        const sku = vendorSkuToSku.get(upper);
        if (sku && needsImage(sku.sku_id)) {
          await saveSkuImages(pool, sku.product_id, sku.sku_id, [entry.url], { maxImages: 1 });
          newlyMatchedSkuIds.add(sku.sku_id);
          collectionMatched++;
          pass1UsedEntries.add(entry);
        } else if (!sku) {
          // Prefix match: save to ALL non-accessory SKUs sharing this prefix
          const prefixSkus = skuPrefixMap.get(upper);
          if (prefixSkus) {
            let prefixMatched = false;
            for (const pSku of prefixSkus) {
              if (pSku.variant_type === 'accessory') continue;
              if (needsImage(pSku.sku_id)) {
                await saveSkuImages(pool, pSku.product_id, pSku.sku_id, [entry.url], { maxImages: 1 });
                newlyMatchedSkuIds.add(pSku.sku_id);
                collectionMatched++;
                prefixMatched = true;
              }
            }
            if (prefixMatched) pass1UsedEntries.add(entry);
          }
        }
      }
    }

    // ── Pass 2: Base color extraction with best-match scoring ──
    // Collect all candidate matches, score by Jaccard word overlap, assign best per product
    // Skip entries already consumed by Pass 1 (SKU code match) to prevent cross-contamination
    // For mosaic collections, preserve shape/finish words to prevent "white picket" matching "white penny round"
    const isMosaicCollection = /^cc\s+(mosaics?|porcelain)/i.test(collectionName);
    const pass2Candidates = new Map(); // product_id → [{entry, score}]

    for (const entry of entries) {
      if (pass1UsedEntries.has(entry)) continue; // already matched by SKU code
      // Strip collection/sub-collection prefix from the website label
      let webColor = entry.color;
      if (webColor.toUpperCase().startsWith(prefixToStrip.toUpperCase() + ' ')) {
        webColor = webColor.substring(prefixToStrip.length + 1).trim();
      }
      webColor = webColor.replace(/^Suite\s+/i, '').trim();
      if (!webColor) continue;

      for (const prod of collectionProducts) {
        // Check if any SKU in this product needs an image
        const prodSkus = skusByProduct.get(prod.product_id) || [];
        const hasSkuNeedingImage = prodSkus.some(s => s.variant_type !== 'accessory' && needsImage(s.sku_id));
        if (!hasSkuNeedingImage) continue;

        // For sub-collections, strip the sub-prefix from DB name too
        let dbName = prod.product_name;
        if (subPrefix) {
          const spLower = subPrefix.toLowerCase();
          if (dbName.toLowerCase().startsWith(spLower + ' ')) {
            dbName = dbName.substring(subPrefix.length + 1).trim();
          } else if (dbName.toLowerCase().startsWith(spLower)) {
            dbName = dbName.substring(subPrefix.length).trim();
          }
        }
        const baseColor = extractBaseColor(dbName, { keepMosaicWords: isMosaicCollection });
        if (colorsMatch(webColor, baseColor, { keepMosaicWords: isMosaicCollection })) {
          // Score by Jaccard similarity between web label (+ image filename) and full product name.
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

    // Assign best match per product with 1:1 entry constraint (each entry used at most once)
    // This prevents one website image from being assigned to multiple products
    const allPass2 = [];
    for (const [pid, candidates] of pass2Candidates) {
      for (const c of candidates) {
        allPass2.push({ pid, entry: c.entry, score: c.score });
      }
    }
    allPass2.sort((a, b) => b.score - a.score);

    const pass2UsedEntries = new Set();
    const pass2AssignedProducts = new Set();
    for (const { pid, entry, score } of allPass2) {
      if (pass2UsedEntries.has(entry) || pass2AssignedProducts.has(pid)) continue;
      const bestSku = findBestSku(pid, entry, skusByProduct, needsImage);
      if (bestSku) {
        await saveSkuImages(pool, pid, bestSku.sku_id, [entry.url], { maxImages: 1 });
        newlyMatchedSkuIds.add(bestSku.sku_id);
      } else {
        await saveProductImages(pool, pid, [entry.url], { maxImages: 1 });
      }
      pass2UsedEntries.add(entry);
      pass2AssignedProducts.add(pid);
      collectionMatched++;
    }

    // ── Pass 3: Fuzzy name match (remaining unmatched products) ──
    // Skip entries already consumed by Pass 1 or Pass 2
    // Collect all candidates, then do 1:1 assignment (same as Pass 2)
    const pass3Candidates = [];
    for (const prod of collectionProducts) {
      const prodSkus = skusByProduct.get(prod.product_id) || [];
      const hasSkuNeedingImage = prodSkus.some(s => s.variant_type !== 'accessory' && needsImage(s.sku_id));
      if (!hasSkuNeedingImage) continue;

      const normProd = normalizeForMatch(prod.product_name);

      for (const entry of entries) {
        if (pass1UsedEntries.has(entry) || pass2UsedEntries.has(entry)) continue;
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
          const ratio = Math.min(normColor.length, normProd.length) / Math.max(normColor.length, normProd.length);
          if (ratio >= 0.7) score = 0.7;
        } else if (normProd.length >= 3 && (normFull.includes(normProd) || normProd.includes(normFull))) {
          const ratio = Math.min(normFull.length, normProd.length) / Math.max(normFull.length, normProd.length);
          if (ratio >= 0.7) score = 0.6;
        }

        if (score >= 0.6) {
          pass3Candidates.push({ pid: prod.product_id, entry, score });
        }
      }
    }

    // 1:1 assignment: each entry and product used at most once
    pass3Candidates.sort((a, b) => b.score - a.score);
    const pass3UsedEntries = new Set();
    const pass3AssignedProducts = new Set();
    for (const { pid, entry, score } of pass3Candidates) {
      if (pass3UsedEntries.has(entry) || pass3AssignedProducts.has(pid)) continue;
      const bestSku = findBestSku(pid, entry, skusByProduct, needsImage);
      if (bestSku) {
        await saveSkuImages(pool, pid, bestSku.sku_id, [entry.url], { maxImages: 1 });
        newlyMatchedSkuIds.add(bestSku.sku_id);
      } else {
        await saveProductImages(pool, pid, [entry.url], { maxImages: 1 });
      }
      pass3UsedEntries.add(entry);
      pass3AssignedProducts.add(pid);
      collectionMatched++;
    }

    // ── PDFs (tech sheets, sell sheets) ──
    const pdfLinks = extractPdfLinks(html);
    if (pdfLinks.length > 0 && collectionProducts.length > 0) {
      for (const prod of collectionProducts) {
        if (productsWithPdfs.has(prod.product_id)) continue;
        for (let i = 0; i < pdfLinks.length; i++) {
          await upsertMediaAsset(pool, {
            product_id: prod.product_id,
            sku_id: null,
            asset_type: 'spec_pdf',
            url: pdfLinks[i].url,
            original_url: pdfLinks[i].url,
            sort_order: i,
          });
        }
        productsWithPdfs.add(prod.product_id);
        totalPdfs++;
      }
    }

    if (collectionMatched > 0) {
      const label = subPrefix ? `${collectionName} → ${subPrefix}` : collectionName;
      console.log(`  ${label}: ${collectionMatched} SKUs matched (${entries.length} entries on page)`);
      totalMatched += collectionMatched;
    }

    await delay(800);
  }

  // ── Results ──
  const allSkuIds = dbSkus.rows.filter(s => s.variant_type !== 'accessory').map(s => s.sku_id);
  const stillMissing = dbSkus.rows.filter(s =>
    s.variant_type !== 'accessory' &&
    !skusWithImages.has(s.sku_id) &&
    !newlyMatchedSkuIds.has(s.sku_id)
  );
  const missingByCollection = new Map();
  for (const s of stillMissing) {
    if (!missingByCollection.has(s.collection)) missingByCollection.set(s.collection, []);
    missingByCollection.get(s.collection).push(`${s.product_name} [${s.variant_name || s.vendor_sku}]`);
  }

  const totalCoveredNow = initialSkusWithImages + newlyMatchedSkuIds.size;
  const nonAccessoryCount = allSkuIds.length;

  console.log(`\n=== Scrape Complete ===`);
  console.log(`SKUs already had images (portal): ${initialSkusWithImages}`);
  console.log(`SKUs newly matched (website): ${newlyMatchedSkuIds.size}`);
  console.log(`Total image matches this run: ${totalMatched}`);
  console.log(`Products with descriptions added: ${totalDescriptions}`);
  // Lifestyle scraping disabled
  console.log(`Products with PDFs saved: ${totalPdfs}`);
  console.log(`SKUs still missing images: ${stillMissing.length}`);
  console.log(`Total SKUs with images now: ${totalCoveredNow}/${nonAccessoryCount} (${Math.round(totalCoveredNow / nonAccessoryCount * 100)}%)`);

  if (unmatchedSlugs.length > 0) {
    console.log(`\nUnmatched website slugs (${unmatchedSlugs.length}): ${unmatchedSlugs.join(', ')}`);
  }

  if (missingByCollection.size > 0) {
    console.log(`\nMissing by collection (${missingByCollection.size} collections):`);
    for (const [col, names] of [...missingByCollection].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (names.length <= 5) {
        console.log(`  ${col}: ${names.join(', ')}`);
      } else {
        console.log(`  ${col}: ${names.length} SKUs (${names.slice(0, 3).join(', ')}...)`);
      }
    }
  }

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
