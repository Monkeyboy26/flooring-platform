#!/usr/bin/env node
/**
 * AHF Contract — Catalog Enrichment & Product Mapping
 *
 * Scrapes ahfcontract.com product catalog, matches to DB SKUs,
 * assigns per-SKU images, extracts specs, regroups products,
 * and attaches accessories.
 *
 * Usage:
 *   node backend/scripts/enrich-ahf-contract.cjs              # Full run
 *   node backend/scripts/enrich-ahf-contract.cjs --dry-run     # Preview only
 *   node backend/scripts/enrich-ahf-contract.cjs --images-only # Just assign images
 *   node backend/scripts/enrich-ahf-contract.cjs --regroup     # Just regroup products
 */

const { Pool } = require('pg');
const https = require('https');
const http = require('http');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const IMAGES_ONLY = process.argv.includes('--images-only');
const REGROUP_ONLY = process.argv.includes('--regroup');

const BASE_URL = 'https://www.ahfcontract.com';
const CDN_SWATCH = `${BASE_URL}/cdn/swatch`;
const VENDOR_CODE = 'TW';

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchPage(res.headers.location));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function headCheck(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method: 'GET', headers: {
      'User-Agent': 'Mozilla/5.0',
      'Range': 'bytes=0-0',
    }}, res => {
      res.resume();
      resolve(res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(8000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Phase 1: AHF Contract catalog (site is JS-rendered, so catalog is embedded)
// Format: [itemCode, colorCamelCase, collectionSlug, categorySlug]
// Scraped from ahfcontract.com/en-us/products.html — 131 products
// ---------------------------------------------------------------------------
const SITE_CATALOG_RAW = [
  // Nod to Nature USA — Loose Lay LVT (4.5mm)
  ['L7161','SunLuster','nod-to-nature-usa','loose-lay-lvt'],
  ['L7162','SunsetTouch','nod-to-nature-usa','loose-lay-lvt'],
  ['L7163','RustledBrown','nod-to-nature-usa','loose-lay-lvt'],
  ['L7165','CopperedGlow','nod-to-nature-usa','loose-lay-lvt'],
  ['L7166','AcornHat','nod-to-nature-usa','loose-lay-lvt'],
  ['L7192','QuietMoment','nod-to-nature-usa','loose-lay-lvt'],
  ['L7193','SilentTwilight','nod-to-nature-usa','loose-lay-lvt'],
  ['L7194','LatePromenade','nod-to-nature-usa','loose-lay-lvt'],
  // Nod to Nature USA — Dry Back LVT (2.5mm)
  ['ST161','SunLuster','nod-to-nature-usa','dry-back-lvt'],
  ['ST162','SunsetTouch','nod-to-nature-usa','dry-back-lvt'],
  ['ST163','RustledBrown','nod-to-nature-usa','dry-back-lvt'],
  ['ST165','CopperedGlow','nod-to-nature-usa','dry-back-lvt'],
  ['ST166','AcornHat','nod-to-nature-usa','dry-back-lvt'],
  ['ST170','GoldenHour','nod-to-nature-usa','dry-back-lvt'],
  ['ST171','TideWashed','nod-to-nature-usa','dry-back-lvt'],
  ['ST172','SunFaded','nod-to-nature-usa','dry-back-lvt'],
  ['ST174','Nutshell','nod-to-nature-usa','dry-back-lvt'],
  ['ST175','RedwoodBark','nod-to-nature-usa','dry-back-lvt'],
  ['ST180','FeatheredGray','nod-to-nature-usa','dry-back-lvt'],
  ['ST181','BirdTrill','nod-to-nature-usa','dry-back-lvt'],
  ['ST182','Spikelet','nod-to-nature-usa','dry-back-lvt'],
  ['ST183','GingeryTan','nod-to-nature-usa','dry-back-lvt'],
  ['ST185','ForestTrail','nod-to-nature-usa','dry-back-lvt'],
  ['ST192','QuietMoment','nod-to-nature-usa','dry-back-lvt'],
  ['ST193','SilentTwilight','nod-to-nature-usa','dry-back-lvt'],
  ['ST194','LatePromenade','nod-to-nature-usa','dry-back-lvt'],
  ['ST770','LinenWhisper','nod-to-nature-usa','dry-back-lvt'],
  ['ST771','RainfallGray','nod-to-nature-usa','dry-back-lvt'],
  ['ST791','LyricalBeige','nod-to-nature-usa','dry-back-lvt'],
  ['ST793','AtmosphereTan','nod-to-nature-usa','dry-back-lvt'],
  ['ST821','CloudGray','nod-to-nature-usa','dry-back-lvt'],
  ['ST822','WhiteClay','nod-to-nature-usa','dry-back-lvt'],
  // Concepts of Landscape — Heterogeneous Sheet
  ['1HE2M001','Dune','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M002','Natural','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M003','Harvest','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M004','Boardwalk','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M005','Dawn','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M006','Espresso','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M007','Latte','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M008','Auburn','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M009','Macchiato','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M010','Weathered','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M011','Cocoa','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M013','SereneMapleLight','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M014','SereneMapleMedium','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M015','SereneMapleDark','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M016','DreamOutdoorsOak','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M401','Watermark','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M402','Brownstone','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M403','Reflection','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M404','Ironside','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M405','SilhouettesLight','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M406','SilhouettesGray','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M407','SilhouettesTaupe','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M408','SilhouettesDarkGray','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M409','ConcreteEffectLight','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M410','ConcreteEffectTaupe','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M411','ConcreteEffectDarkGray','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M412','ConcreteEffectDarkGray','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M413','ArtisanalDetailLight','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M414','ArtisanalDetailTaupe','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M415','ArtisanalDetailGray','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M416','ArtisanalDetailDarkGray','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M417','FinelyWovenLight','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M418','FinelyWovenTaupe','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M419','FinelyWovenGray','concepts-of-landscape','heterogeneous-sheet'],
  ['1HE2M420','FinelyWovenDarkGray','concepts-of-landscape','heterogeneous-sheet'],
  // Mixed & Variegated — Homogeneous Sheet
  ['1HG2M001','Sand','mixed-and-variegated','homogeneous-sheet'],
  ['1HG2M002','Ice','mixed-and-variegated','homogeneous-sheet'],
  ['1HG2M003','Frost','mixed-and-variegated','homogeneous-sheet'],
  ['1HG2M004','Storm','mixed-and-variegated','homogeneous-sheet'],
  ['1HG2M005','Fog','mixed-and-variegated','homogeneous-sheet'],
  ['1HG2M006','Midnight','mixed-and-variegated','homogeneous-sheet'],
  ['1HG2M007','Wheat','mixed-and-variegated','homogeneous-sheet'],
  ['1HG2M008','Tangerine','mixed-and-variegated','homogeneous-sheet'],
  ['1HG2M009','BlueVelvet','mixed-and-variegated','homogeneous-sheet'],
  ['1HG2M010','Dusk','mixed-and-variegated','homogeneous-sheet'],
  ['1HG2M011','AlpineLandscape','mixed-and-variegated','homogeneous-sheet'],
  ['1HG2M012','CityDweller','mixed-and-variegated','homogeneous-sheet'],
  ['1HG2M013','UncommonGray','mixed-and-variegated','homogeneous-sheet'],
  ['1HG2M014','SpringRain','mixed-and-variegated','homogeneous-sheet'],
  ['1HG2M015','PacificBluff','mixed-and-variegated','homogeneous-sheet'],
  ['1HG2M016','NeutralToned','mixed-and-variegated','homogeneous-sheet'],
  ['1HG2M017','DreamEscape','mixed-and-variegated','homogeneous-sheet'],
  ['1HG2M018','CrystalLake','mixed-and-variegated','homogeneous-sheet'],
  ['1HG2M019','CastingShade','mixed-and-variegated','homogeneous-sheet'],
  // Iliad — Vinyl Composition Tile
  ['CR001','DynasticWhite','iliad','vinyl-composition-tile'],
  ['CR002','GloriousBeige','iliad','vinyl-composition-tile'],
  ['CR003','SovereignGray','iliad','vinyl-composition-tile'],
  ['CR004','RoyalSilver','iliad','vinyl-composition-tile'],
  ['CR005','FalconGray','iliad','vinyl-composition-tile'],
  ['CR006','ImperialBlack','iliad','vinyl-composition-tile'],
  ['CR007','ErmineWhite','iliad','vinyl-composition-tile'],
  ['CR008','CrystalGray','iliad','vinyl-composition-tile'],
  ['CR009','DominantGray','iliad','vinyl-composition-tile'],
  ['CR010','TriumphalGray','iliad','vinyl-composition-tile'],
  ['CR011','CitadelGold','iliad','vinyl-composition-tile'],
  ['CR012','GlowingLight','iliad','vinyl-composition-tile'],
  ['CR013','VictoriousBeige','iliad','vinyl-composition-tile'],
  ['CR014','ValorGreen','iliad','vinyl-composition-tile'],
  ['CR015','NobleBlue','iliad','vinyl-composition-tile'],
  ['CR016','RegalLinen','iliad','vinyl-composition-tile'],
  ['CR017','HuntPassion','iliad','vinyl-composition-tile'],
  ['CR018','QueenBliss','iliad','vinyl-composition-tile'],
  ['CR019','LeisureGreen','iliad','vinyl-composition-tile'],
  ['CR020','PorcelainBlue','iliad','vinyl-composition-tile'],
  // Highlights — Vinyl Composition Tile
  ['HR001','BlueSapphire','highlights','vinyl-composition-tile'],
  ['HR002','CorinthianCobalt','highlights','vinyl-composition-tile'],
  ['HR003','SantoriniBlue','highlights','vinyl-composition-tile'],
  ['HR004','CoastAzure','highlights','vinyl-composition-tile'],
  ['HR005','MedditerianBlue','highlights','vinyl-composition-tile'],
  ['HR006','BlueMosaic','highlights','vinyl-composition-tile'],
  ['HR007','DelphiFog','highlights','vinyl-composition-tile'],
  ['HR008','ParthenonPine','highlights','vinyl-composition-tile'],
  ['HR009','ElysianGreen','highlights','vinyl-composition-tile'],
  ['HR010','DemeterApple','highlights','vinyl-composition-tile'],
  ['HR011','GreenOlive','highlights','vinyl-composition-tile'],
  ['HR012','GrecianMeadow','highlights','vinyl-composition-tile'],
  ['HR013','IthacaWaters','highlights','vinyl-composition-tile'],
  ['HR014','DelicateGlow','highlights','vinyl-composition-tile'],
  ['HR015','OlympianGold','highlights','vinyl-composition-tile'],
  ['HR016','AcropolisApricot','highlights','vinyl-composition-tile'],
  ['HR017','HeliosHot','highlights','vinyl-composition-tile'],
  ['HR018','AcropolisRed','highlights','vinyl-composition-tile'],
  ['HR019','VermilionFlame','highlights','vinyl-composition-tile'],
  ['HR020','GaiaGarnet','highlights','vinyl-composition-tile'],
  ['HR021','TerraClay','highlights','vinyl-composition-tile'],
  ['HR022','PhoenixPlum','highlights','vinyl-composition-tile'],
  ['HR023','BacchusWine','highlights','vinyl-composition-tile'],
  ['HR024','AmethystCharm','highlights','vinyl-composition-tile'],
  ['HR025','AphroditesKiss','highlights','vinyl-composition-tile'],
];

function buildCatalog() {
  console.log('\n── Phase 1: Loading AHF Contract catalog ──');
  const catalog = SITE_CATALOG_RAW.map(([code, color, coll, cat]) => ({
    code,
    colorCamel: color,
    collection: slugToTitle(coll),
    category: slugToTitle(cat),
    url: `${BASE_URL}/en-us/products/${cat}/${coll}/${code.toLowerCase()}.html`,
    imgUrl: color ? `${CDN_SWATCH}/${code}_${color}.jpg` : null,
  }));
  console.log(`  Loaded ${catalog.length} products from embedded catalog`);

  const byColl = {};
  for (const e of catalog) {
    byColl[e.collection] = (byColl[e.collection] || 0) + 1;
  }
  for (const [coll, count] of Object.entries(byColl)) {
    console.log(`    ${coll}: ${count} items`);
  }

  return catalog;
}

function slugToTitle(slug) {
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .replace(/\bUsa\b/, 'USA')
    .replace(/\bLvt\b/, 'LVT')
    .replace(/\bVct\b/, 'VCT');
}

function unCamelCase(camel) {
  return camel.replace(/([a-z])([A-Z])/g, '$1 $2');
}

// ---------------------------------------------------------------------------
// Phase 2: Match catalog to DB SKUs
// ---------------------------------------------------------------------------
async function matchCatalogToDb(catalog) {
  console.log('\n── Phase 2: Matching catalog to DB SKUs ──');

  // Get vendor ID
  const vendorRes = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
  if (!vendorRes.rows.length) throw new Error('Vendor TW not found');
  const vendorId = vendorRes.rows[0].id;

  // Load all AHF-prefix SKUs
  const skuRes = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, s.product_id,
           p.name AS product_name, p.collection
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.vendor_sku LIKE 'AHF%'
    ORDER BY s.vendor_sku
  `, [vendorId]);

  console.log(`  Loaded ${skuRes.rows.length} AHF SKUs from DB`);

  // Build site item code lookup (sorted longest first for greedy prefix matching)
  const siteCodesSorted = catalog
    .map(e => e.code)
    .sort((a, b) => b.length - a.length);

  const catalogByCode = new Map();
  for (const entry of catalog) {
    catalogByCode.set(entry.code, entry);
  }

  const matched = [];
  const unmatched = [];

  for (const sku of skuRes.rows) {
    // Strip AHF prefix
    const stripped = sku.vendor_sku.replace(/^AHF/i, '').toUpperCase();

    // Try exact match first, then prefix match
    let matchedCode = null;
    if (catalogByCode.has(stripped)) {
      matchedCode = stripped;
    } else {
      for (const siteCode of siteCodesSorted) {
        if (stripped.startsWith(siteCode)) {
          matchedCode = siteCode;
          break;
        }
      }
    }

    if (matchedCode) {
      const entry = catalogByCode.get(matchedCode);
      matched.push({
        sku_id: sku.sku_id,
        vendor_sku: sku.vendor_sku,
        variant_name: sku.variant_name,
        product_id: sku.product_id,
        product_name: sku.product_name,
        collection: sku.collection,
        siteCode: matchedCode,
        siteEntry: entry,
      });
    } else {
      unmatched.push(sku);
    }
  }

  console.log(`  Matched: ${matched.length} SKUs`);
  console.log(`  Unmatched: ${unmatched.length} SKUs`);

  if (unmatched.length > 0 && unmatched.length <= 30) {
    console.log('  Unmatched SKUs:');
    for (const u of unmatched.slice(0, 20)) {
      console.log(`    ${u.vendor_sku} → ${u.variant_name} (${u.collection})`);
    }
  }

  return { matched, unmatched, vendorId };
}

// ---------------------------------------------------------------------------
// Phase 3: Assign per-SKU images
// ---------------------------------------------------------------------------
async function assignImages(matched) {
  console.log('\n── Phase 3: Assigning per-SKU images ──');

  // Check which SKUs already have images
  const existingRes = await pool.query(`
    SELECT DISTINCT sku_id FROM media_assets
    WHERE sku_id = ANY($1) AND asset_type = 'primary'
  `, [matched.map(m => m.sku_id)]);
  const alreadyHaveImage = new Set(existingRes.rows.map(r => r.sku_id));

  const toAssign = matched.filter(m => !alreadyHaveImage.has(m.sku_id) && m.siteEntry?.imgUrl);
  console.log(`  ${alreadyHaveImage.size} SKUs already have primary images`);
  console.log(`  ${toAssign.length} SKUs need images`);

  let assigned = 0;
  let verified = 0;
  let failed = 0;
  const batchSize = 10;

  for (let i = 0; i < toAssign.length; i += batchSize) {
    const batch = toAssign.slice(i, i + batchSize);
    const checks = await Promise.all(batch.map(async (m) => {
      const url = m.siteEntry.imgUrl;
      const ok = await headCheck(url);
      return { ...m, url, ok };
    }));

    for (const item of checks) {
      if (!item.ok) {
        failed++;
        continue;
      }
      verified++;

      if (DRY_RUN) {
        console.log(`  [DRY] ${item.vendor_sku} → ${item.url}`);
        assigned++;
        continue;
      }

      // Upsert media_asset for this SKU (per-SKU, not per-product)
      await pool.query(`
        INSERT INTO media_assets (sku_id, product_id, asset_type, url, original_url, sort_order)
        VALUES ($1, $2, 'primary', $3, $3, 0)
        ON CONFLICT (product_id, sku_id, asset_type, sort_order)
        WHERE sku_id IS NOT NULL
        DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
      `, [item.sku_id, item.product_id, item.url]);
      assigned++;
    }

    if ((i + batchSize) % 50 === 0) {
      console.log(`  Progress: ${Math.min(i + batchSize, toAssign.length)}/${toAssign.length} checked`);
    }
  }

  console.log(`  Verified: ${verified}, Failed HEAD check: ${failed}, Assigned: ${assigned}`);
  return assigned;
}

// ---------------------------------------------------------------------------
// Phase 3b: Also try CDN URL construction for unmatched SKUs
// ---------------------------------------------------------------------------
async function tryConstructCdnUrls(unmatched) {
  console.log('\n── Phase 3b: Constructing CDN URLs for unmatched AHF SKUs ──');

  // For SKUs not on the site catalog but still AHF brand,
  // try constructing CDN URLs from vendor_sku + variant_name
  const candidates = unmatched.filter(u => {
    const coll = (u.collection || '').toLowerCase();
    // Skip accessories/adhesives/weld rods
    return !coll.includes('weld') && !coll.includes('adhesive') &&
           !coll.includes('s-730') && !coll.includes('wallbase');
  });

  if (candidates.length === 0) {
    console.log('  No candidates for CDN URL construction');
    return 0;
  }

  console.log(`  ${candidates.length} candidates to try`);

  // Check existing images
  const existingRes = await pool.query(`
    SELECT DISTINCT sku_id FROM media_assets
    WHERE sku_id = ANY($1) AND asset_type = 'primary'
  `, [candidates.map(c => c.sku_id)]);
  const alreadyHaveImage = new Set(existingRes.rows.map(r => r.sku_id));

  const toTry = candidates.filter(c => !alreadyHaveImage.has(c.sku_id));
  console.log(`  ${toTry.length} need images (${alreadyHaveImage.size} already have)`);

  let assigned = 0;
  for (const sku of toTry) {
    // Strip AHF prefix and trailing packaging digits to get item code
    const stripped = sku.vendor_sku.replace(/^AHF/i, '');
    // Extract color name — take part before hyphen if present
    let colorName = (sku.variant_name || '').split('-')[0].trim();
    if (!colorName) continue;

    // CamelCase the color name (remove spaces)
    const camelColor = colorName.replace(/\s+/g, '');

    // Try known item code patterns
    // Pattern 1: Use full stripped code
    // Pattern 2: Strip trailing 3-digit suffix
    const codeCandidates = [stripped];
    if (/\d{3}$/.test(stripped) && stripped.length > 5) {
      codeCandidates.push(stripped.slice(0, -3));
    }

    let found = false;
    for (const code of codeCandidates) {
      const url = `${CDN_SWATCH}/${code}_${camelColor}.jpg`;
      const ok = await headCheck(url);
      if (ok) {
        if (DRY_RUN) {
          console.log(`  [DRY] ${sku.vendor_sku} (${colorName}) → ${url}`);
        } else {
          await pool.query(`
            INSERT INTO media_assets (sku_id, product_id, asset_type, url, original_url, sort_order)
            VALUES ($1, $2, 'primary', $3, $3, 0)
            ON CONFLICT (product_id, sku_id, asset_type, sort_order)
            WHERE sku_id IS NOT NULL
            DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
          `, [sku.sku_id, sku.product_id, url]);
        }
        assigned++;
        found = true;
        break;
      }
    }
  }

  console.log(`  Assigned ${assigned} additional images via CDN URL construction`);
  return assigned;
}

// ---------------------------------------------------------------------------
// Phase 4: Extract specs from detail pages
// ---------------------------------------------------------------------------
async function extractSpecs(matched) {
  console.log('\n── Phase 4: Extracting specs from detail pages ──');

  // Group by siteCode to avoid re-scraping the same page
  const byCode = new Map();
  for (const m of matched) {
    if (!byCode.has(m.siteCode)) {
      byCode.set(m.siteCode, { entry: m.siteEntry, skus: [] });
    }
    byCode.get(m.siteCode).skus.push(m);
  }

  // Check which products already have description
  const needSpecs = [];
  for (const [code, group] of byCode) {
    const prodId = group.skus[0].product_id;
    const descRes = await pool.query(
      'SELECT description_long FROM products WHERE id = $1',
      [prodId]
    );
    if (!descRes.rows[0]?.description_long) {
      needSpecs.push({ code, ...group });
    }
  }

  console.log(`  ${byCode.size} unique site pages, ${needSpecs.length} need specs`);

  if (needSpecs.length === 0 || DRY_RUN) {
    if (DRY_RUN) console.log('  [DRY RUN] Would extract specs from detail pages');
    return;
  }

  let enriched = 0;
  let pdfsFound = 0;

  for (const group of needSpecs) {
    try {
      const url = group.entry.url;
      const { status, body } = await fetchPage(url);
      if (status !== 200) continue;

      // Extract specs from HTML
      const specs = parseSpecsFromHtml(body);
      const pdfs = parsePdfsFromHtml(body);
      const description = parseDescriptionFromHtml(body);

      const prodId = group.skus[0].product_id;

      // Update product description
      if (description) {
        await pool.query(
          'UPDATE products SET description_long = $1 WHERE id = $2 AND description_long IS NULL',
          [description, prodId]
        );
      }

      // Upsert specs as SKU attributes for all SKUs in this group
      if (Object.keys(specs).length > 0) {
        for (const sku of group.skus) {
          for (const [slug, value] of Object.entries(specs)) {
            await upsertSkuAttribute(sku.sku_id, slug, value);
          }
        }
        enriched++;
      }

      // Upsert PDFs as product-level media assets
      for (let i = 0; i < pdfs.length; i++) {
        await pool.query(`
          INSERT INTO media_assets (product_id, asset_type, url, original_url, sort_order)
          VALUES ($1, 'spec_pdf', $2, $2, $3)
          ON CONFLICT (product_id, asset_type, sort_order)
          WHERE sku_id IS NULL
          DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
        `, [prodId, pdfs[i].url, i]);
        pdfsFound++;
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.log(`    Error on ${group.code}: ${err.message}`);
    }
  }

  console.log(`  Enriched ${enriched} products with specs, found ${pdfsFound} PDFs`);
}

function parseSpecsFromHtml(html) {
  const specs = {};
  // Match table rows with spec data
  const trRegex = /<tr[^>]*>\s*<t[dh][^>]*>(.*?)<\/t[dh]>\s*<t[dh][^>]*>(.*?)<\/t[dh]>/gis;
  let match;
  while ((match = trRegex.exec(html)) !== null) {
    const label = stripHtml(match[1]).toLowerCase().trim();
    const value = stripHtml(match[2]).trim();
    if (!label || !value) continue;
    if (label.includes('collection')) specs.collection_name = value;
    if (label.includes('construction')) specs.construction = value;
    if (label.includes('color') && !label.includes('group')) specs.color_detail = value;
    if (label.includes('gloss')) specs.gloss = value;
    if (label.includes('finish')) specs.finish = value;
    if (label.includes('edge')) specs.edge = value;
    if (label.includes('plank width') || label === 'width' || label.includes('tile width')) specs.width = value;
    if (label.includes('plank length') || label === 'length' || label.includes('tile length')) specs.length = value;
    if (label.includes('thickness') && !label.includes('veneer')) specs.thickness = value;
    if (label.includes('wear layer')) specs.wear_layer = value;
    if (label.includes('size')) specs.size = value;
    if (label.includes('gauge') || label.includes('total thickness')) specs.gauge = value;
  }
  return specs;
}

function parsePdfsFromHtml(html) {
  const pdfs = [];
  const seen = new Set();
  const pdfRegex = /href="(https?:\/\/[^"]*\.pdf)"/gi;
  let match;
  while ((match = pdfRegex.exec(html)) !== null) {
    const url = match[1];
    if (!seen.has(url.toLowerCase())) {
      seen.add(url.toLowerCase());
      pdfs.push({ url });
    }
  }
  return pdfs;
}

function parseDescriptionFromHtml(html) {
  // Try JSON-LD
  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const data = JSON.parse(jsonLdMatch[1]);
      if (data['@type'] === 'Product' && data.description) {
        return data.description.trim().slice(0, 2000);
      }
    } catch {}
  }
  return null;
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim();
}

async function upsertSkuAttribute(skuId, slug, value) {
  if (!value || !String(value).trim()) return;
  const attr = await pool.query('SELECT id FROM attributes WHERE slug = $1', [slug]);
  if (!attr.rows.length) {
    // Create attribute if it doesn't exist
    const newAttr = await pool.query(
      `INSERT INTO attributes (name, slug, data_type) VALUES ($1, $2, 'text')
       ON CONFLICT (slug) DO NOTHING RETURNING id`,
      [slug.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()), slug]
    );
    if (!newAttr.rows.length) {
      const retry = await pool.query('SELECT id FROM attributes WHERE slug = $1', [slug]);
      if (!retry.rows.length) return;
    }
  }
  const attrId = (attr.rows[0] || (await pool.query('SELECT id FROM attributes WHERE slug = $1', [slug])).rows[0])?.id;
  if (!attrId) return;

  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = $3
  `, [skuId, attrId, String(value).trim()]);
}

// ---------------------------------------------------------------------------
// Phase 5: Regroup products under clean collection names
// ---------------------------------------------------------------------------
const COLLECTION_REMAP = {
  // AHF Contract collections → clean names
  'Nod to Nature Usa-20mil 2.5mm': 'AHF Contract - Nod to Nature USA',
  'Nod to Nature Usa-20mil 4.5mm': 'AHF Contract - Nod to Nature USA',
  'Nod to Nature Individuality 20mil Loose Lay LVT': 'AHF Contract - Nod to Nature USA',
  'Nod to Nature Individuality 20mil Loose Lay LVT Plank': 'AHF Contract - Nod to Nature USA',
  'Nod to Nature Rewilding-20mil 7wx48l Dry Back LVT Plank': 'AHF Contract - Nod to Nature USA',
  'Concepts of Landscape 6.5 Heterogeneous': 'AHF Contract - Concepts of Landscape',
  'Mixed and Variegated 6.5 Homogeneous': 'AHF Contract - Mixed & Variegated',
  'Iliad 12 X12 1/8': 'AHF Contract - Iliad',
  'Expressive Ideas Vbt 20mil': 'AHF Contract - Expressive Ideas',
  'Solid Color Welding Rod': 'AHF Contract - Welding Rods',
  'Medinpure PVC Free Weld Rod Solid': 'AHF Contract - Welding Rods',
  'Medintone Vinyl Weld Rod Solid': 'AHF Contract - Welding Rods',
  'S-730 Wall Wallbase 1 Gallon': 'AHF Contract - Adhesives',
  'S-730 Wall Wallbase 30 Oz.': 'AHF Contract - Adhesives',
  'S-730 Wall Wallbase 4 Gallon Pail': 'AHF Contract - Adhesives',
};

// Product name cleaning
const PRODUCT_NAME_REMAP = {
  'Nod to Nature Usa-20mil 2.5mm': 'Nod to Nature USA Dry Back LVT',
  'Nod to Nature Usa-20mil 4.5mm': 'Nod to Nature USA Loose Lay LVT',
  'Nod to Nature Individuality 20mil Loose Lay LVT': 'Nod to Nature USA Individuality LVT',
  'Nod to Nature Individuality 20mil Loose Lay LVT Plank': 'Nod to Nature USA Individuality LVT Plank',
  'Nod to Nature Rewilding-20mil 7wx48l Dry Back LVT Plank': 'Nod to Nature USA Rewilding LVT',
  'Concepts of Landscape 6.5 Heterogeneous': 'Concepts of Landscape Heterogeneous Sheet',
  'Mixed and Variegated 6.5 Homogeneous': 'Mixed & Variegated Homogeneous Sheet',
  'Iliad 12 X12 1/8': 'Iliad VCT',
  'Expressive Ideas Vbt 20mil': 'Expressive Ideas VBT',
  'Solid Color Welding Rod': 'Solid Color Welding Rod',
  'Medinpure PVC Free Weld Rod Solid': 'Medinpure PVC Free Weld Rod',
  'Medintone Vinyl Weld Rod Solid': 'Medintone Vinyl Weld Rod',
};

async function regroupProducts(vendorId) {
  console.log('\n── Phase 5: Regrouping AHF products ──');

  // Get all AHF products
  const prodRes = await pool.query(`
    SELECT p.id, p.name, p.collection
    FROM products p
    WHERE p.vendor_id = $1
    AND EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.vendor_sku LIKE 'AHF%')
    ORDER BY p.collection
  `, [vendorId]);

  let renamed = 0;
  for (const prod of prodRes.rows) {
    const newCollection = COLLECTION_REMAP[prod.collection];
    const newName = PRODUCT_NAME_REMAP[prod.name];

    if (newCollection || newName) {
      if (DRY_RUN) {
        console.log(`  [DRY] "${prod.name}" (${prod.collection})`);
        if (newCollection) console.log(`    → collection: ${newCollection}`);
        if (newName) console.log(`    → name: ${newName}`);
      } else {
        await pool.query(`
          UPDATE products
          SET collection = COALESCE($1, collection),
              name = COALESCE($2, name),
              updated_at = NOW()
          WHERE id = $3
        `, [newCollection || null, newName || null, prod.id]);
      }
      renamed++;
    }
  }

  console.log(`  Regrouped ${renamed} products`);

  // Now merge products that ended up with the same collection + name
  await mergeduplicateProducts(vendorId);
}

async function mergeduplicateProducts(vendorId) {
  console.log('\n  Checking for duplicate products to merge...');

  const dupes = await pool.query(`
    SELECT collection, name, array_agg(id ORDER BY created_at) as ids, count(*) as cnt
    FROM products
    WHERE vendor_id = $1
    AND EXISTS (SELECT 1 FROM skus s WHERE s.product_id = id AND s.vendor_sku LIKE 'AHF%')
    GROUP BY collection, name
    HAVING count(*) > 1
    ORDER BY collection, name
  `, [vendorId]);

  if (dupes.rows.length === 0) {
    console.log('  No duplicates found');
    return;
  }

  for (const row of dupes.rows) {
    const [keepId, ...mergeIds] = row.ids;
    console.log(`  Merging ${row.cnt} "${row.name}" (${row.collection}): keep ${keepId.slice(0, 8)}, merge ${mergeIds.length}`);

    if (DRY_RUN) continue;

    for (const oldId of mergeIds) {
      // Move SKUs
      await pool.query('UPDATE skus SET product_id = $1 WHERE product_id = $2', [keepId, oldId]);
      // Move media_assets
      await pool.query('UPDATE media_assets SET product_id = $1 WHERE product_id = $2', [keepId, oldId]);
      // Delete old product
      await pool.query('DELETE FROM products WHERE id = $1', [oldId]);
    }
  }

  console.log(`  Merged ${dupes.rows.length} duplicate groups`);
}

// ---------------------------------------------------------------------------
// Phase 6: Attach accessories
// ---------------------------------------------------------------------------
const ACCESSORY_COLLECTIONS = [
  'AHF Contract - Welding Rods',
  'AHF Contract - Adhesives',
];

// Map accessory collections → parent flooring product collections
const ACCESSORY_PARENT_MAP = {
  'AHF Contract - Welding Rods': [
    'AHF Contract - Concepts of Landscape',
    'AHF Contract - Mixed & Variegated',
    'AHF Contract - Iliad',
  ],
  'AHF Contract - Adhesives': [
    'AHF Contract - Concepts of Landscape',
    'AHF Contract - Nod to Nature USA',
    'AHF Contract - Mixed & Variegated',
    'AHF Contract - Iliad',
    'AHF Contract - Expressive Ideas',
  ],
};

async function attachAccessories(vendorId) {
  console.log('\n── Phase 6: Attaching accessories ──');

  // Mark accessory SKUs with variant_type = 'accessory'
  const accRes = await pool.query(`
    SELECT s.id as sku_id, s.vendor_sku, s.variant_name, s.variant_type,
           p.name as product_name, p.collection
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1
    AND s.vendor_sku LIKE 'AHF%'
    AND (
      p.collection ILIKE '%weld%' OR p.collection ILIKE '%adhesive%'
      OR p.name ILIKE '%weld%' OR p.name ILIKE '%adhesive%'
      OR p.name ILIKE '%wallbase%'
    )
  `, [vendorId]);

  console.log(`  Found ${accRes.rows.length} accessory SKUs`);

  let marked = 0;
  for (const sku of accRes.rows) {
    if (sku.variant_type !== 'accessory') {
      if (DRY_RUN) {
        console.log(`  [DRY] Mark as accessory: ${sku.vendor_sku} (${sku.variant_name})`);
      } else {
        await pool.query(
          "UPDATE skus SET variant_type = 'accessory', sell_by = 'unit' WHERE id = $1",
          [sku.sku_id]
        );
      }
      marked++;
    }
  }

  console.log(`  Marked ${marked} SKUs as accessories`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== AHF Contract Enrichment ===');
  if (DRY_RUN) console.log('[DRY RUN MODE]');

  try {
    if (REGROUP_ONLY) {
      const vendorRes = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
      const vendorId = vendorRes.rows[0].id;
      await regroupProducts(vendorId);
      await attachAccessories(vendorId);
      console.log('\n=== Done (regroup only) ===');
      return;
    }

    // Phase 1: Load catalog (embedded — site is JS-rendered)
    const catalog = buildCatalog();

    // Phase 2: Match to DB
    const { matched, unmatched, vendorId } = await matchCatalogToDb(catalog);

    // Phase 3: Assign images
    const imgCount = await assignImages(matched);

    // Phase 3b: Try CDN URLs for unmatched
    if (!IMAGES_ONLY) {
      await tryConstructCdnUrls(unmatched);
    }

    if (!IMAGES_ONLY) {
      // Phase 4: Extract specs
      await extractSpecs(matched);

      // Phase 5: Regroup
      await regroupProducts(vendorId);

      // Phase 6: Accessories
      await attachAccessories(vendorId);
    }

    console.log('\n=== Complete ===');
    console.log(`  Images assigned: ${imgCount}`);
    console.log(`  Catalog items: ${catalog.length}`);
    console.log(`  SKUs matched: ${matched.length}`);
    console.log(`  SKUs unmatched: ${unmatched.length}`);

  } catch (err) {
    console.error('Fatal error:', err);
  } finally {
    await pool.end();
  }
}

main();
