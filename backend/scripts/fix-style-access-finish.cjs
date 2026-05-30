/**
 * Fix Style Access missing Finish attributes.
 *
 * 174 SKUs are missing the Finish attribute (70 active). This script:
 *   1. Tries extractFinish(variant_name) first — covers names containing
 *      Gloss/Satin/Matte/Flat/Dixie/Charleston/Swing etc.
 *   2. For remaining SKUs, fetches products from the WP API and matches
 *      by vendor_sku to extract finish from the WP product title.
 *
 * Run: docker compose exec api node scripts/fix-style-access-finish.cjs [--dry-run]
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const WP_API = 'https://style-access.com/wp-json/wp/v2/product';
const PER_PAGE = 100;
const DELAY_MS = 500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- Copied from import-style-access.js (kept in sync) ---

function extractFinish(desc) {
  const tokens = [];
  for (const p of ['Flat', 'Dixie', 'Charleston', 'Swing']) {
    if (new RegExp('\\b' + p + '\\b', 'i').test(desc)) tokens.push(p);
  }
  if (/\bFlower\s+Deco\b/i.test(desc)) tokens.push('Flower Deco');
  else if (/\bDeco\b/i.test(desc)) tokens.push('Deco');
  for (const l of ['Brick Joint', 'Cross Hatch']) {
    if (new RegExp('\\b' + l + '\\b', 'i').test(desc)) tokens.push(l);
  }
  for (const q of ['Gloss', 'Satin', 'Matte']) {
    if (new RegExp('\\b' + q + '\\b', 'i').test(desc)) tokens.push(q);
  }
  return tokens.length ? tokens.join(' ') : null;
}

// --- End copied functions ---

/**
 * Extract finish from WP product title — handles additional terms
 * that appear in WP titles but not in our variant_name data.
 */
function extractFinishFromTitle(title) {
  // Try the standard extractor first
  const standard = extractFinish(title);
  if (standard) return standard;

  // Additional WP-specific finish terms
  const tokens = [];
  if (/\bGlossy\b/i.test(title)) tokens.push('Gloss');
  if (/\bPolished\b/i.test(title)) tokens.push('Polished');
  if (/\bHoned\b/i.test(title)) tokens.push('Honed');
  if (/\bHoned\s+Matte\b/i.test(title)) return 'Honed Matte';
  if (/\bUndulated\b/i.test(title)) tokens.push('Undulated');
  if (/\bAntislip\b/i.test(title)) tokens.push('Antislip');
  return tokens.length ? tokens.join(' ') : null;
}

function decodeHtmlEntities(s) {
  if (!s) return '';
  return s
    .replace(/&#8243;/g, '"')
    .replace(/&#8242;/g, "'")
    .replace(/&#215;/g, '×')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&#038;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function extractSkuCandidates(excerpt) {
  if (!excerpt) return [];
  const text = excerpt.replace(/<[^>]+>/g, '').trim();
  const matches = [...text.matchAll(/\b([A-Z]{2,}[A-Z0-9]{3,})\b/gi)];
  return matches.map(m => m[1].toUpperCase());
}

async function fetchAllWpProducts() {
  const allProducts = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `${WP_API}?per_page=${PER_PAGE}&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`  API error on page ${page}: ${res.status}`);
      break;
    }
    totalPages = parseInt(res.headers.get('x-wp-totalpages') || '1', 10);
    const products = await res.json();
    allProducts.push(...products);
    console.log(`  Fetched page ${page}/${totalPages} (${products.length} products)`);
    page++;
    if (page <= totalPages) await sleep(DELAY_MS);
  }
  return allProducts;
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Look up vendor + finish attribute
    const { rows: vendorRows } = await client.query(
      `SELECT id FROM vendors WHERE code = 'STYLEACCESS'`
    );
    if (!vendorRows.length) { console.error('Vendor STYLEACCESS not found!'); return; }
    const vendorId = vendorRows[0].id;

    const { rows: attrRows } = await client.query(
      `SELECT id FROM attributes WHERE slug = 'finish'`
    );
    const finishAttrId = attrRows[0]?.id;
    if (!finishAttrId) { console.error('No "finish" attribute found!'); return; }

    console.log(`=== Fix Style Access Finish Attributes ${DRY_RUN ? '(DRY RUN)' : ''} ===\n`);
    console.log(`Finish attribute ID: ${finishAttrId}\n`);

    // Query Style Access SKUs missing finish attribute
    const { rows: skusMissing } = await client.query(`
      SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, s.status,
             p.name AS product_name, p.collection
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      WHERE v.id = $1
        AND NOT EXISTS (
          SELECT 1 FROM sku_attributes sa
          WHERE sa.sku_id = s.id AND sa.attribute_id = $2
        )
      ORDER BY p.collection, p.name, s.variant_name
    `, [vendorId, finishAttrId]);

    console.log(`Found ${skusMissing.length} SKUs missing finish attribute\n`);

    let setByVariantName = 0, setByWpApi = 0, stillMissing = 0;
    const needsWpLookup = [];

    // Pass 1: Try extractFinish from variant_name
    console.log('--- Pass 1: Extract from variant_name ---\n');
    for (const sku of skusMissing) {
      const finish = extractFinish(sku.variant_name || '');
      if (finish) {
        console.log(`  ${sku.collection} / ${sku.product_name} / ${sku.variant_name} -> "${finish}"`);
        if (!DRY_RUN) {
          await client.query(`
            INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
            ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
          `, [sku.sku_id, finishAttrId, finish]);
        }
        setByVariantName++;
      } else {
        needsWpLookup.push(sku);
      }
    }

    console.log(`\nSet ${setByVariantName} finishes from variant_name`);
    console.log(`${needsWpLookup.length} SKUs still need WP API lookup\n`);

    // Pass 2: Fetch WP products and match by vendor_sku
    if (needsWpLookup.length > 0) {
      console.log('--- Pass 2: WP API lookup ---\n');

      console.log('Fetching WP products...');
      const wpProducts = await fetchAllWpProducts();
      console.log(`Fetched ${wpProducts.length} WP products\n`);

      // Build vendor_sku -> WP title map from excerpts
      const skuToWpTitle = new Map();
      for (const wp of wpProducts) {
        const title = decodeHtmlEntities(wp.title?.rendered || '');
        const excerpt = wp.excerpt?.rendered || '';
        const candidates = extractSkuCandidates(excerpt);
        for (const code of candidates) {
          skuToWpTitle.set(code, title);
        }
      }

      for (const sku of needsWpLookup) {
        const raw = (sku.vendor_sku || '').replace(/^SA-/, '').toUpperCase();
        const wpTitle = skuToWpTitle.get(raw);

        if (wpTitle) {
          const finish = extractFinishFromTitle(wpTitle);
          if (finish) {
            console.log(`  ${sku.collection} / ${sku.variant_name} -> "${finish}" (from WP: "${wpTitle}")`);
            if (!DRY_RUN) {
              await client.query(`
                INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
                ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
              `, [sku.sku_id, finishAttrId, finish]);
            }
            setByWpApi++;
          } else {
            if (VERBOSE) console.log(`  NO FINISH in WP title: "${wpTitle}" (${sku.variant_name})`);
            stillMissing++;
          }
        } else {
          if (VERBOSE) console.log(`  NO WP MATCH: ${sku.vendor_sku} (${sku.variant_name})`);
          stillMissing++;
        }
      }
    }

    console.log(`\n=== Summary ===`);
    console.log(`Total SKUs missing finish: ${skusMissing.length}`);
    console.log(`Set by variant_name extraction: ${setByVariantName}`);
    console.log(`Set by WP API lookup: ${setByWpApi}`);
    console.log(`Still missing (no finish found): ${stillMissing}`);

    if (DRY_RUN) {
      console.log('\n[DRY RUN] No changes made. Remove --dry-run to apply.');
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
      console.log('\nDone! Restart API to see changes: docker compose restart api');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
