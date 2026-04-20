#!/usr/bin/env node
/**
 * Backfill Daltile product images from Coveo API.
 *
 * Targets products that have NO images at all and tries to match them
 * against Coveo catalog data by collection + color name.
 *
 * Usage:
 *   node backend/scripts/backfill-daltile-images.cjs --dry-run
 *   node backend/scripts/backfill-daltile-images.cjs
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: parseInt(process.env.DB_PORT || process.env.PGPORT || '5432'),
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

const COVEO_URL = 'https://www.daltile.com/coveo/rest/search';
const COVEO_FIELDS = [
  'sku', 'seriesname', 'colornameenglish', 'productimageurl',
  'primaryroomsceneurl', 'producttype',
];

// Placeholder / generic image patterns to skip
const SKIP_PATTERNS = [
  'No-Series-Image-Available',
  'S1212J', 'P43F9', 'P43C9',
  'SLIMT', 'VSLCAP', 'VQRND', 'EXTSN', 'RNDSTRD', 'VNOSE', 'TMOLD', 'ENDCAP',
  'VSTRD', 'VRDSN', 'VSCAP',
];

// Suffixes to strip from our color names before matching
const STRIP_SUFFIXES = [
  /\s+satin$/i,
  /\s+abrasive$/i,
  /\s+double\s+abrasive$/i,
  /\s+glossy$/i,
];

function isValidImageUrl(url) {
  if (!url) return false;
  return !SKIP_PATTERNS.some(p => url.includes(p));
}

function cleanScene7Url(url) {
  if (!url) return null;
  // Strip Scene7 query params like ?$TRIMTHUMBNAIL$
  let clean = url.split('?')[0];
  // For AEM DAM URLs, use full-res "original" rendition instead of tiny thumbnails
  if (clean.includes('/jcr:content/renditions/')) {
    clean = clean.replace(/\/jcr:content\/renditions\/.*$/, '/jcr:content/renditions/original');
  }
  return clean;
}

function normalize(str) {
  // Normalize: lowercase, strip non-alphanumeric, and normalize grey/gray
  return (str || '').toLowerCase().replace(/\bgray\b/g, 'grey').replace(/[^a-z0-9]/g, '');
}

function stripSuffixes(color) {
  let result = color;
  for (const re of STRIP_SUFFIXES) {
    result = result.replace(re, '');
  }
  return result.trim();
}

async function queryCoveo(seriesName) {
  const aq = `@sitetargethostname=="www.daltile.com" @sourcedisplayname==product @seriesname=="${seriesName}"`;
  const resp = await fetch(COVEO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      q: '', aq,
      firstResult: 0,
      numberOfResults: 100,
      fieldsToInclude: COVEO_FIELDS,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Coveo API error ${resp.status}`);
  return resp.json();
}

function getField(raw, key) {
  const val = raw[key];
  if (Array.isArray(val)) return val[0] || '';
  return val || '';
}

async function main() {
  console.log(`\nDaltile Image Backfill${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  // Step 1: Find all products missing images
  const missingRes = await pool.query(`
    SELECT p.id AS product_id, p.name, p.display_name, p.collection,
      ARRAY_AGG(DISTINCT s.id) AS sku_ids
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    JOIN skus s ON s.product_id = p.id AND s.status = 'active'
      AND s.variant_type IS DISTINCT FROM 'accessory'
    LEFT JOIN media_assets m ON (m.product_id = p.id OR m.sku_id = s.id)
      AND m.asset_type IN ('primary','alternate','lifestyle')
    WHERE v.code = 'DAL' AND p.status = 'active'
    GROUP BY p.id, p.name, p.display_name, p.collection
    HAVING COUNT(m.id) = 0
    ORDER BY p.collection, p.name
  `);

  console.log(`Products missing images: ${missingRes.rows.length}`);

  // Group by collection
  const byCollection = new Map();
  for (const row of missingRes.rows) {
    const coll = row.collection || 'unknown';
    if (!byCollection.has(coll)) byCollection.set(coll, []);
    byCollection.get(coll).push(row);
  }

  console.log(`Unique collections to query: ${byCollection.size}\n`);

  let stats = { queried: 0, matched: 0, primarySet: 0, lifestyleSet: 0, noMatch: 0 };

  for (const [collection, products] of byCollection) {
    console.log(`--- ${collection} (${products.length} products) ---`);

    // Step 2: Query Coveo for this collection
    let coveoData;
    try {
      coveoData = await queryCoveo(collection);
    } catch (err) {
      console.log(`  Coveo query failed: ${err.message}`);
      continue;
    }
    stats.queried++;

    const coveoResults = coveoData.results || [];
    if (coveoResults.length === 0) {
      console.log(`  No Coveo results`);
      for (const prod of products) stats.noMatch++;
      continue;
    }

    // Step 3: Build color → {imageUrl, roomUrl} map from Coveo
    // Store under multiple normalized keys for better matching
    const colorMap = new Map();
    for (const result of coveoResults) {
      const raw = result.raw || {};
      const color = getField(raw, 'colornameenglish').trim();
      const imageUrl = cleanScene7Url(getField(raw, 'productimageurl'));
      const roomUrl = cleanScene7Url(getField(raw, 'primaryroomsceneurl'));
      const productType = getField(raw, 'producttype');

      // Skip trims
      if (productType.toLowerCase().includes('trim')) continue;

      // Skip invalid image URLs
      if (!isValidImageUrl(imageUrl)) continue;

      const entry = {
        imageUrl,
        roomUrl: isValidImageUrl(roomUrl) ? roomUrl : null,
        colorName: color,
      };

      const normColor = normalize(color);
      if (!normColor) continue;

      // Store under original normalized color
      if (!colorMap.has(normColor)) colorMap.set(normColor, entry);

      // Also store under suffix-stripped version (e.g., "Satin" removed)
      const stripped = normalize(stripSuffixes(color));
      if (stripped && stripped !== normColor && !colorMap.has(stripped)) {
        colorMap.set(stripped, entry);
      }

      // Strip "Warm " / "Cool " prefix for Quartetto-style collections
      const warmCoolMatch = color.match(/^(Warm|Cool)\s+(.+)$/i);
      if (warmCoolMatch) {
        const unprefixed = normalize(warmCoolMatch[2]);
        if (unprefixed && !colorMap.has(unprefixed)) {
          colorMap.set(unprefixed, entry);
        }
      }
    }

    console.log(`  Coveo color keys: ${colorMap.size} (${[...new Set([...colorMap.values()].map(v => v.colorName))].join(', ')})`);

    // Step 4: Match products to Coveo colors
    for (const prod of products) {
      // Extract color from product name by stripping collection prefix
      let color = prod.name.replace(new RegExp(`^${collection.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '').trim();

      // Also try display_name (strip collection + body type suffix)
      let displayColor = (prod.display_name || '')
        .replace(new RegExp(`^${collection.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '')
        .replace(/\s*(Porcelain Tile|Ceramic Tile|Mosaic Tile|Backsplash Tile|Glass Tile|LVT|Luxury Vinyl Tile|Luxury Vinyl Plank|Porcelain|Ceramic|Tile)$/i, '')
        .trim();

      // For products where name = collection (no color), try from sku_attributes
      if (!color || color === collection) {
        const colorAttr = await pool.query(`
          SELECT DISTINCT sa.value
          FROM sku_attributes sa
          JOIN attributes a ON a.id = sa.attribute_id
          WHERE a.slug = 'color' AND sa.sku_id = ANY($1)
        `, [prod.sku_ids]);
        if (colorAttr.rows.length === 1) {
          color = colorAttr.rows[0].value;
        }
      }

      // Build a list of normalized candidates to try
      const candidates = new Set();
      if (color) {
        candidates.add(normalize(color));
        candidates.add(normalize(stripSuffixes(color)));
      }
      if (displayColor) {
        candidates.add(normalize(displayColor));
        candidates.add(normalize(stripSuffixes(displayColor)));
      }
      // Remove empty strings
      candidates.delete('');

      let coveo = null;
      let matchStrategy = '';

      // Strategy 1: Direct key lookup (exact, suffix-stripped, grey/gray normalized)
      for (const candidate of candidates) {
        if (colorMap.has(candidate)) {
          coveo = colorMap.get(candidate);
          matchStrategy = 'exact';
          break;
        }
      }

      // Strategy 2: Partial match — check if any Coveo color key is contained in product name
      if (!coveo) {
        const normName = normalize(prod.name);
        for (const [normCoveoColor, data] of colorMap) {
          if (normCoveoColor.length >= 4 && normName.includes(normCoveoColor)) {
            coveo = data;
            matchStrategy = 'partial-in-name';
            break;
          }
        }
      }

      // Strategy 3: Check if any candidate is a prefix of a Coveo key (or vice versa)
      if (!coveo) {
        for (const candidate of candidates) {
          if (!candidate || candidate.length < 3) continue;
          for (const [normCoveoColor, data] of colorMap) {
            if (normCoveoColor.length < 3) continue;
            if (normCoveoColor.startsWith(candidate) || candidate.startsWith(normCoveoColor)) {
              coveo = data;
              matchStrategy = 'prefix';
              break;
            }
          }
          if (coveo) break;
        }
      }

      // Strategy 4: Check if candidate is a substring of any Coveo color key
      // e.g., "Greige" matches "Lineage Greige", "Townhouse" matches "Refined Townhouse"
      if (!coveo) {
        for (const candidate of candidates) {
          if (!candidate || candidate.length < 5) continue;
          for (const [normCoveoColor, data] of colorMap) {
            if (normCoveoColor.length > candidate.length && normCoveoColor.includes(candidate)) {
              coveo = data;
              matchStrategy = 'substring-in-coveo';
              break;
            }
          }
          if (coveo) break;
        }
      }

      // Strategy 5: For products where name contains install type (Glue Down, Rigid Click),
      // skip — these are format variants, not colors
      if (!coveo && /glue\s+down|rigid\s+click/i.test(color)) {
        stats.noMatch++;
        if (DRY_RUN) console.log(`  SKIP (install type): "${prod.name}"`);
        continue;
      }

      // Strategy 6: For products with no color and only one Coveo non-trim color, use it
      if (!coveo && (!color || color === collection) && colorMap.size === 1) {
        coveo = [...colorMap.values()][0];
        matchStrategy = 'single-coveo-color';
      }

      if (!coveo) {
        stats.noMatch++;
        if (DRY_RUN) console.log(`  NO MATCH: "${prod.name}" (color="${color}", display="${displayColor}")`);
        continue;
      }

      stats.matched++;
      if (DRY_RUN) {
        console.log(`  MATCH [${matchStrategy}]: "${prod.name}" → ${coveo.colorName} → ${coveo.imageUrl.split('/').pop()}`);
      }

      if (!DRY_RUN) {
        // Upsert primary image at product level
        if (coveo.imageUrl) {
          await pool.query(`
            INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
            VALUES ($1, NULL, 'primary', $2, $2, 0, 'coveo-backfill')
            ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
            DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
          `, [prod.product_id, coveo.imageUrl]);
          stats.primarySet++;
        }

        // Upsert lifestyle/room scene image
        if (coveo.roomUrl && coveo.roomUrl !== coveo.imageUrl) {
          await pool.query(`
            INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
            VALUES ($1, NULL, 'lifestyle', $2, $2, 0, 'coveo-backfill')
            ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
            DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
          `, [prod.product_id, coveo.roomUrl]);
          stats.lifestyleSet++;
        }
      }
    }
    console.log('');
  }

  // Coverage after
  const coverage = await pool.query(`
    SELECT COUNT(DISTINCT s.id) AS total,
      COUNT(DISTINCT CASE WHEN m.id IS NOT NULL THEN s.id END) AS has_image
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets m ON (m.sku_id = s.id OR m.product_id = p.id) AND m.asset_type IN ('primary','alternate','lifestyle')
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
      AND s.variant_type IS DISTINCT FROM 'accessory'
  `);

  const { total, has_image } = coverage.rows[0];
  const pct = total > 0 ? ((has_image / total) * 100).toFixed(1) : '0';

  console.log('=== Summary ===');
  console.log(`Collections queried: ${stats.queried}`);
  console.log(`Products matched: ${stats.matched}`);
  console.log(`Primary images set: ${stats.primarySet}`);
  console.log(`Lifestyle images set: ${stats.lifestyleSet}`);
  console.log(`No match: ${stats.noMatch}`);
  console.log(`\nImage coverage (non-trim): ${has_image}/${total} (${pct}%)`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
