import {
  upsertMediaAsset,
  appendLog, addJobError
} from './base.js';

const BLOOMREACH_URL = 'https://core.dxpapi.com/api/v1/core/';
const BLOOMREACH_PARAMS = {
  account_id: '6674',
  auth_key: 'alc9wtv7de2jmwtq',
  domain_key: 'quick-step.com',
  url: 'us.quick-step.com',
  q: '*',
  rows: '200',
  start: '0',
  search_type: 'keyword',
  request_type: 'search',
  fl: 'pid,title,collection_name,sku_color,sku_swatch_images,sku_thumb_images,room_scene,url',
};

const MAX_ERRORS = 30;

/**
 * Quick-Step enrichment scraper for Tri-West.
 *
 * Uses the public Bloomreach Search API (core.dxpapi.com) to fetch
 * collection/color images. No Puppeteer needed.
 * Enriches EXISTING Tri-West products — never creates new ones.
 *
 * DB naming (inverted from typical):
 *   products.name       = product line (e.g., "COLOSSIA COLL. 10MM", "ABREEZA FLUSH STAIR NOSE")
 *   products.collection = "Quick-Step - {COLOR}" (e.g., "Quick-Step - DRIED CLAY OAK")
 *
 * Matching strategy:
 *   1. collection:color exact match (e.g., "colossia:dried clay oak")
 *   2. color-only fallback (for accessories where product name doesn't contain collection)
 */
export async function run(pool, job, source) {
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Quick-Step';
  let errorCount = 0;
  let productsMatched = 0;
  let productsSkipped = 0;
  let imagesAdded = 0;

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { }
    }
  }

  try {
    // ── Step 1: Fetch Bloomreach catalog ──
    await appendLog(pool, job.id, 'Fetching Bloomreach catalog for Quick-Step...');

    const params = new URLSearchParams(BLOOMREACH_PARAMS);
    const resp = await fetch(`${BLOOMREACH_URL}?${params}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      await appendLog(pool, job.id, `Bloomreach API returned ${resp.status} — aborting`);
      return;
    }

    const data = await resp.json();
    const docs = data?.response?.docs || [];
    await appendLog(pool, job.id, `Bloomreach returned ${docs.length} documents`);

    if (docs.length === 0) {
      await appendLog(pool, job.id, 'No documents from Bloomreach — nothing to do');
      return;
    }

    // ── Step 2: Build lookup maps ──
    // Primary: "collection:color" → images (precise match)
    // Fallback: "color" → images (for accessories where product name has no collection)
    const collectionColorMap = new Map();
    const colorOnlyMap = new Map();
    const colorCollapsedMap = new Map();

    for (const doc of docs) {
      const collectionName = doc.collection_name;
      const variants = doc.variants || [];
      // Top-level room_scene as fallback
      const docRoomScene = doc.room_scene || null;

      if (!collectionName || variants.length === 0) continue;

      const collKey = collectionName.toLowerCase().trim();

      for (const variant of variants) {
        const color = variant.sku_color;
        if (!color) continue;

        const colorKey = color.toLowerCase().trim();

        // Variant-level images (arrays — take first element)
        const swatchUrl = variant.sku_swatch_images?.[0] || variant.sku_thumb_images?.[0] || null;
        const roomSceneUrl = variant.room_scene?.[0] || docRoomScene || null;

        if (!swatchUrl && !roomSceneUrl) continue;

        const images = {
          swatch_url: swatchUrl ? ensureHiRes(swatchUrl) : null,
          room_scene_url: roomSceneUrl ? ensureHiRes(roomSceneUrl) : null,
        };

        collectionColorMap.set(`${collKey}:${colorKey}`, images);
        // Color-only fallback (first one wins — all same color should be same swatch)
        if (!colorOnlyMap.has(colorKey)) {
          colorOnlyMap.set(colorKey, images);
        }
        // Space-collapsed key for fuzzy matching ("leatherbound oak" matches "leather bound oak")
        const collapsedKey = colorKey.replace(/\s+/g, '');
        if (!colorCollapsedMap.has(collapsedKey)) {
          colorCollapsedMap.set(collapsedKey, images);
        }
      }
    }

    await appendLog(pool, job.id,
      `Built lookup: ${collectionColorMap.size} collection:color, ${colorOnlyMap.size} color-only, ${colorCollapsedMap.size} collapsed entries`);

    // ── Step 3: Load DB products needing images ──
    const productResult = await pool.query(`
      SELECT p.id, p.name, p.collection
      FROM products p
      WHERE p.vendor_id = $1
        AND p.collection LIKE $2
        AND NOT EXISTS (
          SELECT 1 FROM media_assets ma
          WHERE ma.product_id = p.id AND ma.asset_type = 'primary'
        )
    `, [vendor_id, `${brandPrefix}%`]);

    await appendLog(pool, job.id, `Found ${productResult.rows.length} products missing images`);

    if (productResult.rows.length === 0) {
      await appendLog(pool, job.id, 'All Quick-Step products already have images — done');
      return;
    }

    // ── Step 4: Match and upsert images ──
    let matchedByCollection = 0;
    let matchedByColor = 0;
    let matchedByFuzzy = 0;

    for (const product of productResult.rows) {
      try {
        const dbColor = normalizeDbColor(product.collection);
        if (!dbColor) {
          productsSkipped++;
          continue;
        }

        const dbCollectionLine = normalizeDbProductLine(product.name);

        // Strategy 1: collection:color exact match
        let images = null;
        if (dbCollectionLine) {
          images = collectionColorMap.get(`${dbCollectionLine}:${dbColor}`);
          if (images) matchedByCollection++;
        }

        // Strategy 2: color-only exact match (for accessories/profiles)
        if (!images) {
          images = colorOnlyMap.get(dbColor);
          if (images) matchedByColor++;
        }

        // Strategy 3: fuzzy fallbacks for near-misses
        if (!images) {
          // 3a: space-collapsed ("leather bound oak" → "leatherboundoak")
          images = colorCollapsedMap.get(dbColor.replace(/\s+/g, ''));
          // 3b: try appending " oak" (DB has "CLOUDBURST", Bloomreach has "cloudburst oak")
          if (!images && !dbColor.includes('oak') && !dbColor.includes('hickory') && !dbColor.includes('maple')) {
            images = colorOnlyMap.get(`${dbColor} oak`);
          }
          if (images) matchedByFuzzy++;
        }

        if (!images) {
          productsSkipped++;
          continue;
        }

        let sortOrder = 0;

        // Swatch as primary
        if (images.swatch_url) {
          await upsertMediaAsset(pool, {
            product_id: product.id,
            sku_id: null,
            asset_type: 'primary',
            url: images.swatch_url,
            original_url: images.swatch_url,
            sort_order: sortOrder++,
          });
          imagesAdded++;
        }

        // Room scene as lifestyle
        if (images.room_scene_url) {
          await upsertMediaAsset(pool, {
            product_id: product.id,
            sku_id: null,
            asset_type: 'lifestyle',
            url: images.room_scene_url,
            original_url: images.room_scene_url,
            sort_order: sortOrder++,
          });
          imagesAdded++;
        }

        productsMatched++;
      } catch (err) {
        await logError(`Product ${product.id} (${product.collection}): ${err.message}`);
        productsSkipped++;
      }
    }

    await appendLog(pool, job.id,
      `Complete. Matched: ${productsMatched} (${matchedByCollection} collection+color, ${matchedByColor} color-only, ${matchedByFuzzy} fuzzy), ` +
      `Skipped: ${productsSkipped}, Images added: ${imagesAdded}, Errors: ${errorCount}`,
      { products_found: productResult.rows.length, products_updated: productsMatched }
    );

  } catch (err) {
    await appendLog(pool, job.id, `Fatal error: ${err.message}`);
    throw err;
  }
}

// ── Normalization helpers ──

/**
 * Normalize DB product line (products.name) to extract collection name.
 * Only returns a value when the product name contains a recognizable collection.
 *
 * "COLOSSIA COLL. 10MM" → "colossia"
 * "Propello Coll 12mm W/pad" → "propello"
 * "Palisades Park Coll.w/pad" → "palisades park"
 * "ABREEZA FLUSH STAIR NOSE" → "abreeza"
 * "5 IN 1 MULTI FUNCTION PROFILE" → "" (no collection — will use color-only fallback)
 * "Zz Colossia Coll. 10mm" → "colossia"
 */
function normalizeDbProductLine(name) {
  if (!name) return '';
  let s = name.toLowerCase().trim();

  // Strip leading "Zz" / "Zz " prefix (discontinued marker)
  s = s.replace(/^zz\s*/i, '');

  // If name contains COLL/COLLECTION, extract everything before it
  const collMatch = s.match(/^(.+?)\s+coll(?:ection)?[\s.]/i);
  if (collMatch) return collMatch[1].trim();

  // If name contains W/PAD or W PAD, extract everything before the dimension/pad suffix
  const padMatch = s.match(/^(.+?)\s+(?:\d|w[/ ]pad)/i);
  if (padMatch) return padMatch[1].trim();

  // For accessories like "ABREEZA FLUSH STAIR NOSE", extract first word(s) before
  // known accessory keywords
  const accMatch = s.match(/^(.+?)\s+(?:flush|overlap|quarter|5\s*in\s*1|5in1|incizo|stair|multi|shim|square)/i);
  if (accMatch) return accMatch[1].trim();

  return '';
}

/**
 * Normalize DB color (products.collection) to match Bloomreach sku_color.
 *
 * "Quick-Step - HUTIA OAK" → "hutia oak"
 * "Quick-Step - RUSSET OAK-12MM" → "russet oak"
 * "Quick-Step - GOLDEN NEST OAK 12MM" → "golden nest oak"
 * "Quick-Step - BROWN THRASHER OAK - 84"" → "brown thrasher oak"
 * "Quick-Step - MOCHA OAK 2-STRP PLK 84"" → "mocha oak"
 * "Quick-Step - LEATHER BOUND OAK-12MM" → "leather bound oak"
 * "Quick-Step" → "" (no color)
 */
function normalizeDbColor(collection) {
  if (!collection) return '';
  let s = collection.trim();

  // Must have a color after "Quick-Step - "
  const prefixMatch = s.match(/^Quick-?Step\s*[-–—]\s*(.+)/i);
  if (!prefixMatch) return '';

  s = prefixMatch[1].trim();

  // Skip non-color suffixes: TW MFG, ***, BOX-B/C, numeric-only
  if (/^(TW MFG|XXX|\*|BOX-?[A-Z]?\b)/i.test(s)) return '';
  if (/^\d+\s*(EA|KITS?|QT)\//i.test(s)) return '';

  // Strip PROFILE prefix: "PROFILE 84"-CLOUDBURST OAK" → "CLOUDBURST OAK"
  // "PROFILE-LEATHER BOUND OAK  84"" → "LEATHER BOUND OAK  84""
  s = s.replace(/^PROFILE\s*[-–]?\s*(\d+(\.\d+)?["″]?\s*[-–]?\s*)?/i, '');

  // Strip "FOR ..." prefix: "FOR RECLAIME PLANK" → skip (not a color)
  if (/^FOR\s+/i.test(s)) return '';

  // Strip trailing junk: dimensions, XXX markers, length specs
  // "BROWN THRASHER OAK - 84"" → "BROWN THRASHER OAK"
  // "MOCHA OAK 2-STRP PLK 84"" → "MOCHA OAK"
  // "GOLDEN NEST OAK 12MM" → "GOLDEN NEST OAK"
  // "HUTIA OAK-12MM" → "HUTIA OAK"
  // "BOOK CASE OAK 78.5"XXX" → "BOOK CASE OAK"
  s = s.replace(/\s*[-–]\s*\d+(\.\d+)?["″]?\s*$/, '');  // " - 84""
  s = s.replace(/\s+\d+(\.\d+)?["″]?(XXX)?\s*$/, '');    // " 84"", " 84"XXX"
  s = s.replace(/[-\s]+\d+(\.\d+)?mm\s*$/i, '');          // "-12MM", " 12MM"
  s = s.replace(/\s+\d+-STRP\s+PLK.*$/i, '');             // " 2-STRP PLK 84""
  s = s.replace(/\s*XXX.*$/i, '');                         // "XXX..." suffix
  s = s.replace(/\s+\d+\s*EA\/CT.*$/i, '');               // " 10 EA/CT"
  s = s.replace(/\s+\d+\s*KITS?\/CTN.*$/i, '');           // " 10 KITS/CTN"
  s = s.replace(/\s+\d+\s*QT\/CTN.*$/i, '');              // " 12 QT/CTN"

  // Strip "PLANKS"/"PLANK" suffix: "HEATHERED OAK PLANKS" → "HEATHERED OAK"
  s = s.replace(/\s+PLANKS?\b/i, '');

  // Handle multi-color: "RAIN FOREST/BROWN THRASHER OAK" → take first color
  if (s.includes('/')) {
    s = s.split('/')[0].trim();
  }

  return s.toLowerCase().trim();
}

/**
 * Ensure a scene7 image URL returns high-res by appending ?wid=1200.
 */
function ensureHiRes(url) {
  if (!url) return url;
  if (url.includes('scene7.com')) {
    return `${url.split('?')[0]}?wid=1200`;
  }
  return url;
}
