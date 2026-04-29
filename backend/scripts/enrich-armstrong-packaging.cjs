#!/usr/bin/env node
/**
 * enrich-armstrong-packaging.cjs
 *
 * Two-phase enrichment for Armstrong products:
 *
 * Phase A — Reclassify misclassified sell_by values:
 *   - Cleaning/maintenance products (Once N Done, Shinekeeper, etc.) → sell_by: 'unit'
 *   - Rubber stair treads & cove base → sell_by: 'unit'
 *   - Wallbase & tapes → sell_by: 'unit'
 *   - Sheet vinyl products are left as sell_by: 'sqft' (correct — cut from rolls)
 *
 * Phase B — Scrape Armstrong website for sqft_per_box on tile/plank/VCT products
 *   that genuinely should have box packaging data.
 *
 * Usage:
 *   node backend/scripts/enrich-armstrong-packaging.cjs --dry-run
 *   node backend/scripts/enrich-armstrong-packaging.cjs
 */

const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: process.env.DB_PORT || process.env.PGPORT || 5432,
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASS || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const BASE_URL = 'https://www.armstrongflooring.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DELAY_MS = 600;

// ── Product classification ───────────────────────────────────────────────

/**
 * Products that should be reclassified to sell_by: 'unit'.
 * These are currently incorrectly marked as 'sqft'.
 */
const UNIT_PRODUCT_PATTERNS = [
  // Cleaning / maintenance
  /once\s*n\s*done/i,
  /n\s*done\s*\d+\s*ounce/i,
  /shinekeeper/i,
  /fine\s*notch\s*rplmt/i,
  /new\s*beginning/i,
  /s-\d+\s*cleaner/i,
  // Rubber stair treads & cove base
  /rubber.*stair\s*tread/i,
  /rubber.*coved/i,
  /rbr\s*\d+in/i,
  // Wallbase
  /vinyl\s*wallbase/i,
  /wall\s*base/i,
  /color\s*intergrated\s*vinyl/i,
  // Tapes & misc installation
  /possibilities\s*tape/i,
];

/**
 * Products that are sheet/roll vinyl — these correctly sell by sqft
 * but will never have sqft_per_box (cut from rolls). Skip scraping.
 */
const SHEET_VINYL_PATTERNS = [
  /stratamax/i,
  /flexstep/i,
  /cushionstep/i,
  /station\s*square/i,
  /starstep/i,
  /progressions/i,
  /traditions/i,
  /possibilities(?!\s*tape)/i,
  /memories/i,
  /rhythm/i,          // catches "Rhythms" and "Rhythmics"
  /initiator/i,
  /abode/i,
  /natural\s*fusion/i,
  /royelle/i,
  /rhino/i,
  /destinations/i,
  /promo\s*(etchings|inlaid|ureth)/i,
  /promotional\s*initiator/i,
  /accolade\s*plus/i,
  /metro\s*\d+ft/i,
  /timberline/i,
  /zenscape/i,
  /nidra/i,
  /ambigu/i,
  /stonerun/i,
  /perspectives/i,
  /translations/i,
  /safeguard/i,
  /safety\s*zone/i,
  /marmorette/i,
  /natralis/i,
  /medin/i,           // catches Medintone, Medinpure, Medintech
  /meditone/i,        // "Meditone" (no 'n' — different from Medintone)
  /homogeneous/i,
  /heterogeneous/i,
  /linoleum/i,
  /sheet/i,
  /quiet\s*comfort\s*floating/i,
];

function shouldBeUnit(productName) {
  return UNIT_PRODUCT_PATTERNS.some(p => p.test(productName));
}

function isSheetVinyl(productName) {
  return SHEET_VINYL_PATTERNS.some(p => p.test(productName));
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function httpGet(url) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Item code derivation ──────────────────────────────────────────────────

function deriveItemCode(vendorSku) {
  if (!vendorSku || !vendorSku.startsWith('ARM')) return null;
  const inner = vendorSku.slice(3);
  if (inner.length < 5) return null;
  return inner.slice(0, 5).toUpperCase();
}

// ── Collection discovery (reused from triwest-armstrong.js) ───────────────

/**
 * Discover item codes and their page URLs from Armstrong's browse APIs.
 * Returns Map<itemCode, detailUrl> where detailUrl is the path like "hom/medintone/item/h2001.html"
 */
async function discoverFromBrowseApi() {
  const itemCodeMap = new Map(); // itemCode → detailUrl path

  console.log('Phase 1: Discovering items from Armstrong browse APIs...');

  // Commercial API — paginate to get all
  for (let start = 0; start < 5000; start += 999) {
    const url = `${BASE_URL}/commercial/api/en-us/browse/products?q=matchall&size=999&start=${start}`;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(20000),
      });
      if (!resp.ok) break;
      const data = await resp.json();
      const products = data.products || [];
      if (products.length === 0) break;

      for (const p of products) {
        const code = (p.line2 || '').trim().toUpperCase();
        const detailUrl = p.detailUrl || '';
        if (code && detailUrl) {
          itemCodeMap.set(code, detailUrl);
          // Also map 5-char prefix
          if (code.length > 5) {
            itemCodeMap.set(code.slice(0, 5), detailUrl);
          }
        }
      }
      console.log(`  Commercial API (start=${start}): ${products.length} products → ${itemCodeMap.size} codes total`);
      if (products.length < 999) break;
    } catch { break; }
    await delay(300);
  }

  // Residential API — paginate
  for (let start = 0; start < 5000; start += 999) {
    const url = `${BASE_URL}/residential/api/en-us/browse/products?q=matchall&filters=type:ResidentialProduct&filters=type:Trim&filters=type:IMA&size=999&start=${start}&region=`;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(20000),
      });
      if (!resp.ok) break;
      const data = await resp.json();
      const products = data.products || [];
      if (products.length === 0) break;

      for (const p of products) {
        const line1 = p.line1 || '';
        const m = line1.match(/\|\s*([A-Za-z0-9]+)$/);
        const code = m ? m[1].toUpperCase() : '';
        const detailUrl = p.detailUrl || '';
        if (code && detailUrl) {
          itemCodeMap.set(code, detailUrl);
          if (code.length > 5) {
            itemCodeMap.set(code.slice(0, 5), detailUrl);
          }
        }
      }
      console.log(`  Residential API (start=${start}): ${products.length} products → ${itemCodeMap.size} codes total`);
      if (products.length < 999) break;
    } catch { break; }
    await delay(300);
  }

  console.log(`  Discovery complete: ${itemCodeMap.size} item codes mapped`);
  return itemCodeMap;
}

// ── Static mapping fallback ──────────────────────────────────────────────

function mapProductToPath(name) {
  const n = (name || '').toLowerCase();
  if (n.startsWith('alterna') && !n.includes('grout') && !n.includes('classic') && !n.includes('reserve'))
    return '/residential/en-us/engineered-tile/alterna-engineered-tile';
  if (n.startsWith('imperial texture')) return '/commercial/en-us/products/vinyl-composition-tile/std-excelon-imp-texture';
  if (n.startsWith('crown texture')) return '/commercial/en-us/products/vinyl-composition-tile/premium-excelon-crown-texture';
  if (n.startsWith('stonetex')) return '/commercial/en-us/products/vinyl-composition-tile/excelon-stonetex';
  if (n.startsWith('feature tile') || n.startsWith('feature strip'))
    return '/commercial/en-us/products/vinyl-composition-tile/excelon-feature-tile-strip';
  if (n === 'static dissipative') return '/commercial/en-us/products/esd/static-dissp-excelon-sdt';
  if (n.startsWith('natralis') && !n.includes('weld')) return '/commercial/en-us/products/hom/natralis';
  if (n.startsWith('medintone') || n.startsWith('meditone')) return '/commercial/en-us/products/hom/medintone';
  if (n.startsWith('medinpure')) return '/commercial/en-us/products/hom/medinpure';
  if (n.startsWith('biome')) return '/commercial/en-us/products/lvt-luxury-flooring/biome';
  if (n.startsWith('exchange')) return '/commercial/en-us/products/lvt-luxury-flooring/exchange';
  if (n.startsWith('theorem')) return '/commercial/en-us/products/lvt-luxury-flooring/theorem';
  if (n.startsWith('duo')) return '/commercial/en-us/products/lvt-luxury-flooring/duo';
  if (n.startsWith('terra')) return '/commercial/en-us/products/lvt-luxury-flooring/terra';
  if (n.startsWith('coalesce')) return '/commercial/en-us/products/lvt-luxury-flooring/coalesce';
  if (n.startsWith('unify')) return '/commercial/en-us/products/lvt-luxury-flooring/unify';
  if (n.startsWith('natural creations')) return '/commercial/en-us/products/lvt-luxury-flooring/natural-creations-with-diamond-10';
  if (n.includes('parallel') && n.includes('12')) return '/commercial/en-us/products/lvt-luxury-flooring/parallel-usa-12';
  if (n.includes('parallel') && n.includes('20')) return '/commercial/en-us/products/lvt-luxury-flooring/parallel-usa-20';
  if (n.startsWith('kaleido')) return '/commercial/en-us/products/lvt-luxury-flooring/kaleido';
  if (n.startsWith('nidra')) return '/commercial/en-us/products/het/nidra';
  if (n.startsWith('zenscape')) return '/commercial/en-us/products/het/zenscape';
  if (n.startsWith('safety zone')) return '/commercial/en-us/products/srf/safety-zone';
  if (n.startsWith('memories')) return '/residential/en-us/vinyl-flooring/vinyl-sheet/memories';
  if (n.startsWith('marmorette')) return '/commercial/en-us/products/hom/marmorette';
  if (n.startsWith('lam for life')) return '/residential/en-us/laminate-flooring/lam-for-life-plank';
  if (n.startsWith('rhino')) return '/commercial/en-us/products/het/rhino-classics';
  return null;
}

// ── Specs extraction ─────────────────────────────────────────────────────

/**
 * Extract packaging specs from an Armstrong item page HTML.
 * Returns { sqft_per_box, pieces_per_box } or null if nothing found.
 */
function extractSpecs(html) {
  const result = { sqft_per_box: null, pieces_per_box: null };
  let found = false;

  // Residential format: "Square Feet per Box" → value
  const sqftBoxMatch = html.match(/Square\s+Feet\s+per\s+Box[^<]*<[^>]*>\s*<[^>]*>\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (sqftBoxMatch) {
    result.sqft_per_box = parseFloat(sqftBoxMatch[1]);
    found = true;
  }

  // Commercial format: "Coverage Per Carton" → "XX square feet"
  if (!result.sqft_per_box) {
    const coverageMatch = html.match(/Coverage\s+Per\s+Carton[^<]*<[^>]*>\s*<[^>]*>\s*([0-9]+(?:\.[0-9]+)?)\s*(?:square\s*feet|sq\s*ft|SF)/i);
    if (coverageMatch) {
      result.sqft_per_box = parseFloat(coverageMatch[1]);
      found = true;
    }
  }

  // Alternative: look for the text more loosely (some pages have different HTML structure)
  if (!result.sqft_per_box) {
    // Strip tags and look for key-value pairs
    const stripped = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '|')
      .replace(/\|+/g, '|');

    // "Square Feet per Box|24.13"
    const sqftMatch2 = stripped.match(/Square\s+Feet\s+per\s+Box\|+\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (sqftMatch2) {
      result.sqft_per_box = parseFloat(sqftMatch2[1]);
      found = true;
    }

    // "Coverage Per Carton|45 square feet"
    if (!result.sqft_per_box) {
      const covMatch2 = stripped.match(/Coverage\s+Per\s+Carton\|+\s*([0-9]+(?:\.[0-9]+)?)\s*(?:square\s*feet|sq|SF)/i);
      if (covMatch2) {
        result.sqft_per_box = parseFloat(covMatch2[1]);
        found = true;
      }
    }

    // "SF/Carton|24.89"
    if (!result.sqft_per_box) {
      const sfCtMatch = stripped.match(/SF\s*\/\s*(?:Carton|Box|Case)\|+\s*([0-9]+(?:\.[0-9]+)?)/i);
      if (sfCtMatch) {
        result.sqft_per_box = parseFloat(sfCtMatch[1]);
        found = true;
      }
    }
  }

  // "Pieces per Carton" → value
  const pcsMatch = html.match(/Pieces?\s+per\s+(?:Carton|Box|Case)[^<]*<[^>]*>\s*<[^>]*>\s*([0-9]+)/i);
  if (pcsMatch) {
    result.pieces_per_box = parseInt(pcsMatch[1]);
    found = true;
  }
  if (!result.pieces_per_box) {
    const stripped = html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
    const pcsMatch2 = stripped.match(/Pieces?\s+per\s+(?:Carton|Box|Case)\|+\s*([0-9]+)/i);
    if (pcsMatch2) {
      result.pieces_per_box = parseInt(pcsMatch2[1]);
      found = true;
    }
  }

  // If we found pieces but not sqft, try to compute from dimensions
  if (result.pieces_per_box && !result.sqft_per_box) {
    // Look for tile size like "12 in. x 12 in." or "12 x 24"
    const sizeMatch = html.match(/(\d+(?:\.\d+)?)\s*(?:in\.?|")\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*(?:in\.?|")/i);
    if (sizeMatch) {
      const widthIn = parseFloat(sizeMatch[1]);
      const lengthIn = parseFloat(sizeMatch[2]);
      const sqftPerPiece = (widthIn * lengthIn) / 144;
      result.sqft_per_box = parseFloat((sqftPerPiece * result.pieces_per_box).toFixed(2));
      found = true;
    }
  }

  return found ? result : null;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`enrich-armstrong-packaging.cjs — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('═'.repeat(60));

  // ── Phase A: Reclassify misclassified sell_by values ────────────────────
  console.log('\n▸ PHASE A: Reclassify misclassified sell_by values');
  console.log('─'.repeat(60));

  const misclassified = await pool.query(`
    SELECT s.id as sku_id, s.vendor_sku, s.variant_name, s.sell_by,
      p.name as product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.name = 'Tri-West'
      AND s.vendor_sku LIKE 'ARM%'
      AND s.status = 'active'
      AND COALESCE(s.sell_by, 'sqft') = 'sqft'
      AND COALESCE(s.variant_type, '') != 'accessory'
    ORDER BY p.name
  `);

  let reclassifiedToUnit = 0;
  const reclassifiedProducts = new Set();

  for (const row of misclassified.rows) {
    if (shouldBeUnit(row.product_name)) {
      if (DRY_RUN) {
        if (!reclassifiedProducts.has(row.product_name)) {
          console.log(`  → unit: ${row.product_name}`);
          reclassifiedProducts.add(row.product_name);
        }
      } else {
        await pool.query(
          `UPDATE skus SET sell_by = 'unit' WHERE id = $1`,
          [row.sku_id]
        );
      }
      reclassifiedToUnit++;
    }
  }

  console.log(`Reclassified to unit: ${reclassifiedToUnit} SKUs (${reclassifiedProducts.size} products)`);

  // ── Phase B: Scrape packaging for tile/plank/VCT products ──────────────
  console.log('\n▸ PHASE B: Scrape packaging data for tile/plank/VCT products');
  console.log('─'.repeat(60));

  // Reload after reclassification — only sqft products still missing packaging
  const skusResult = await pool.query(`
    SELECT s.id as sku_id, s.vendor_sku, s.variant_name, s.sell_by,
      p.name as product_name, p.id as product_id, p.description_short, p.description_long
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN packaging pkg ON pkg.sku_id = s.id
    WHERE v.name = 'Tri-West'
      AND s.vendor_sku LIKE 'ARM%'
      AND COALESCE(s.variant_type, '') != 'accessory'
      AND s.status = 'active'
      AND COALESCE(s.sell_by, 'sqft') = 'sqft'
      AND (pkg.sqft_per_box IS NULL OR pkg.sqft_per_box = 0)
    ORDER BY p.name, s.vendor_sku
  `);

  console.log(`Found ${skusResult.rows.length} Armstrong sqft SKUs still missing sqft_per_box`);

  // Separate sheet vinyl (skip scraping) from tile/plank (scrape)
  const sheetSkus = [];
  const scrapeCandidates = [];

  for (const row of skusResult.rows) {
    if (isSheetVinyl(row.product_name)) {
      sheetSkus.push(row);
    } else {
      scrapeCandidates.push(row);
    }
  }

  console.log(`  Sheet/roll products (skip scraping): ${sheetSkus.length} SKUs`);
  console.log(`  Tile/plank/VCT candidates (will scrape): ${scrapeCandidates.length} SKUs`);

  if (scrapeCandidates.length === 0) {
    console.log('No tile/plank products to scrape — all remaining are sheet vinyl.');
    await printSummary();
    await pool.end();
    return;
  }

  // Group scrape candidates by item code
  const byItemCode = new Map();
  for (const row of scrapeCandidates) {
    const itemCode = deriveItemCode(row.vendor_sku);
    if (!itemCode) continue;
    if (!byItemCode.has(itemCode)) {
      byItemCode.set(itemCode, { skus: [], productName: row.product_name });
    }
    byItemCode.get(itemCode).skus.push(row);
  }

  console.log(`Grouped into ${byItemCode.size} unique item codes to scrape`);

  // Discover items from browse APIs
  const itemCodeMap = await discoverFromBrowseApi();

  // Map missing codes to URLs
  let mapped = 0;
  let unmapped = 0;
  const codeToUrl = new Map();

  for (const [itemCode, group] of byItemCode) {
    if (itemCodeMap.has(itemCode)) {
      const detailUrl = itemCodeMap.get(itemCode);
      const section = detailUrl.startsWith('hom/') || detailUrl.startsWith('het/') ||
        detailUrl.startsWith('srf/') || detailUrl.startsWith('esd/') ||
        detailUrl.startsWith('lvt-') || detailUrl.startsWith('vinyl-comp')
        ? '/commercial/en-us/products/'
        : '/residential/en-us/';
      codeToUrl.set(itemCode, `${BASE_URL}${section}${detailUrl}`);
      mapped++;
      continue;
    }

    // Try longer codes from vendor_sku
    const vsku = group.skus[0].vendor_sku;
    let found = false;
    for (const len of [6, 7, 8, 9, 10]) {
      if (3 + len > vsku.length) break;
      const longerCode = vsku.slice(3, 3 + len).toUpperCase();
      if (itemCodeMap.has(longerCode)) {
        const detailUrl = itemCodeMap.get(longerCode);
        const section = detailUrl.startsWith('hom/') || detailUrl.startsWith('het/') ||
          detailUrl.startsWith('srf/') || detailUrl.startsWith('esd/') ||
          detailUrl.startsWith('lvt-') || detailUrl.startsWith('vinyl-comp')
          ? '/commercial/en-us/products/'
          : '/residential/en-us/';
        codeToUrl.set(itemCode, `${BASE_URL}${section}${detailUrl}`);
        mapped++;
        found = true;
        break;
      }
    }
    if (found) continue;

    // Try static mapping by product name
    const staticPath = mapProductToPath(group.productName);
    if (staticPath) {
      codeToUrl.set(itemCode, `${BASE_URL}${staticPath}/item/${itemCode}.html`);
      mapped++;
      continue;
    }

    unmapped++;
  }

  console.log(`\nMapped: ${mapped} item codes, Unmapped: ${unmapped}`);

  // Fetch item pages and extract specs
  let enriched = 0;
  let skusUpdated = 0;
  let failed = 0;
  let noSpecs = 0;
  let idx = 0;
  const specsCache = new Map();

  for (const [itemCode, group] of byItemCode) {
    idx++;
    const pageUrl = codeToUrl.get(itemCode);
    if (!pageUrl) {
      failed += group.skus.length;
      continue;
    }

    if (specsCache.has(itemCode)) {
      const cached = specsCache.get(itemCode);
      if (cached) {
        for (const sku of group.skus) {
          if (!DRY_RUN) {
            await upsertPackaging(sku.sku_id, cached);
            await updateDescription(sku, cached);
          }
          skusUpdated++;
        }
        enriched++;
      } else {
        noSpecs += group.skus.length;
      }
      continue;
    }

    const html = await httpGet(pageUrl);

    if (!html || html.includes('"headline":"Error') || html.includes('<title>Error')) {
      specsCache.set(itemCode, null);
      failed += group.skus.length;
      if (idx <= 30 || idx % 50 === 0) {
        console.log(`  [${idx}/${byItemCode.size}] MISS: ${itemCode} (${group.productName}) — ${!html ? 'no response' : 'error page'}`);
      }
      await delay(DELAY_MS);
      continue;
    }

    const specs = extractSpecs(html);
    specsCache.set(itemCode, specs);

    if (specs && specs.sqft_per_box) {
      if (DRY_RUN) {
        console.log(`  [${idx}] ${itemCode} → sqft_per_box=${specs.sqft_per_box}, pieces=${specs.pieces_per_box || '?'} (${group.skus.length} SKUs) — ${group.productName}`);
      } else {
        for (const sku of group.skus) {
          await upsertPackaging(sku.sku_id, specs);
          await updateDescription(sku, specs);
          skusUpdated++;
        }
      }
      enriched++;
    } else {
      noSpecs += group.skus.length;
      if (idx <= 30) {
        console.log(`  [${idx}] ${itemCode} → no specs found on page (${group.productName})`);
      }
    }

    if (idx % 25 === 0) {
      console.log(`  Progress: ${idx}/${byItemCode.size} codes | enriched: ${enriched}, SKUs updated: ${skusUpdated}, failed: ${failed}, no specs: ${noSpecs}`);
    }

    await delay(DELAY_MS);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Phase B results:`);
  console.log(`  Item codes processed: ${byItemCode.size}`);
  console.log(`  Enriched: ${enriched} item codes → ${skusUpdated} SKUs updated`);
  console.log(`  Failed (no page): ${failed} SKUs`);
  console.log(`  No specs found: ${noSpecs} SKUs`);

  await printSummary();
  console.log('\nDone!');
  await pool.end();
}

async function printSummary() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('FINAL SUMMARY');
  console.log('─'.repeat(60));

  const summary = await pool.query(`
    SELECT
      COALESCE(s.sell_by, 'sqft') as sell_by,
      CASE
        WHEN COALESCE(s.sell_by, 'sqft') = 'unit' THEN 'n/a'
        WHEN pkg.sqft_per_box > 0 THEN 'has_packaging'
        ELSE 'no_packaging'
      END as pkg_status,
      COUNT(*) as cnt
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN packaging pkg ON pkg.sku_id = s.id
    WHERE v.name = 'Tri-West'
      AND s.vendor_sku LIKE 'ARM%'
      AND COALESCE(s.variant_type, '') != 'accessory'
      AND s.status = 'active'
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);

  for (const row of summary.rows) {
    console.log(`  ${row.sell_by} / ${row.pkg_status}: ${row.cnt} SKUs`);
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────

async function upsertPackaging(skuId, specs) {
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
      pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box)
  `, [skuId, specs.sqft_per_box || null, specs.pieces_per_box || null]);
}

async function updateDescription(sku, specs) {
  if (!specs.sqft_per_box) return;
  const sfText = `${specs.sqft_per_box} SF/Box`;
  const shortDesc = sku.description_short || '';
  // Only update if not already present
  if (!shortDesc.includes('SF/Box') && !shortDesc.includes('sf/box')) {
    const newShort = shortDesc
      ? `${shortDesc} | ${sfText}`
      : `${sfText}`;
    await pool.query(
      'UPDATE products SET description_short = $1 WHERE id = $2',
      [newShort, sku.product_id]
    );
  }
  // Also update description_long if it's generic
  const longDesc = sku.description_long || '';
  if (!longDesc.includes('sq ft per') && !longDesc.includes('SF/Box')) {
    const newLong = longDesc
      ? `${longDesc} ${specs.sqft_per_box} sq ft per carton.`
      : `${specs.sqft_per_box} sq ft per carton.`;
    await pool.query(
      'UPDATE products SET description_long = $1 WHERE id = $2',
      [newLong, sku.product_id]
    );
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
