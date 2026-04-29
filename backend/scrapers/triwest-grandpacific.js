import { appendLog, addJobError, upsertMediaAsset, upsertSkuAttribute } from './base.js';

const BASE_URL = 'https://www.grandpacifichardwood.com';
const SQSP_PREFIX = 'https://images.squarespace-cdn.com/content/v1/599b51129f74566ac0d8870b/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Grand Pacific enrichment scraper for Tri-West.
 *
 * Scrapes grandpacifichardwood.com (Squarespace) for product images and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 *
 * Website: 28 colors at /{color-slug}, Squarespace CDN images.
 *
 * Three image naming patterns on the site:
 *   1. Numbered: {ITEM}+{Color}+%281%29.jpg (lifestyle) / %282%29.jpg (swatch)
 *   2. Room suffix: {ITEM}.jpg (swatch) / {ITEM}+{Color}+Room.jpg (lifestyle)
 *   3. Plain + 1: {ITEM}+{Color}.jpg / {ITEM}+{Color}+1.jpg
 *
 * Image strategy: product swatch → primary, lifestyle/room → lifestyle
 */

/** Map variant_name from DB to website slug */
const VARIANT_TO_SLUG = {
  'Stingray':              'stingray',
  'Rip Tide':              'rip-tide',
  'Castaway':              'castaway',
  'Sea Lion':              'sea-lion',
  'Worn Saddle':           'worn-saddle',
  'Misty Seas':            'misty-seas',
  'Sand Bar':              'sand-bar',
  'Evening Tides':         'evening-tides',
  'Morning Break':         'morning-break',
  'Oysters Pearl':         'oysters-pearl',
  'Breakers':              'breakers',
  'Cliffside':             'cliffside',
  'Pelican Bay':           'pelican-bay',
  'Endless Summer':        'endless-summer',
  'Lake House':            'lake-house',
  'Harbor Nights':         'harbor-nights',
  'Waterfront':            'waterfront',
  'Weather Vane':          'weather-vane',
  'South Swell':           'south-swell',
  'Kelp Bed':              'kelp-bed',
  "Fisherman S Pier":      'fishermans-pier',
  "Fisherman's Pier":      'fishermans-pier',
  'Shoreline':             'shoreline',
  'Coastal Shores':        'coastal-shores',
  'Dock Side':             'dockside',
  'Dockside':              'dockside',
  'Parasail':              'parasail',
  'Seaworthy':             'seaworthy',
  'Sunset Shimmer':        'sunset-shimmer',
  'Beach Hut':             'beach-hut',
};

/** Species by variant (most are White Oak, a few are Acacia) */
const ACACIA_VARIANTS = new Set(['Evening Tides', 'Sand Bar']);

export async function run(pool, job, source) {
  const vendor_id = source.vendor_id;
  let errorCount = 0;
  let skusEnriched = 0;
  let skusSkipped = 0;
  let imagesAdded = 0;

  try {
    // Load all Grand Pacific SKUs
    const skuResult = await pool.query(`
      SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, s.product_id, p.name AS product_name
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1
        AND p.name LIKE 'Grand Pacific Coll%'
        AND p.name NOT LIKE 'Zz%'
        AND p.name NOT LIKE 'Zzz%'
        AND s.variant_name IS NOT NULL
    `, [vendor_id]);

    await appendLog(pool, job.id, `Found ${skuResult.rows.length} Grand Pacific SKUs to enrich`);

    if (skuResult.rows.length === 0) {
      await appendLog(pool, job.id, 'No Grand Pacific SKUs found — run triwest-catalog first');
      return;
    }

    // Deduplicate: if both BOS127BR and BOS127BRM exist for same color, only process M-suffix
    const byColor = new Map();
    for (const sku of skuResult.rows) {
      const key = sku.variant_name.trim();
      const existing = byColor.get(key);
      if (!existing || sku.vendor_sku.endsWith('M')) {
        byColor.set(key, sku);
      }
    }

    const skusToProcess = [...byColor.values()];
    await appendLog(pool, job.id, `Processing ${skusToProcess.length} unique colors (after dedup)`);

    for (const sku of skusToProcess) {
      const variantName = sku.variant_name.trim();

      // Strip species suffix for slug lookup
      const cleanName = variantName.replace(/[-\s]*(white oak|acacia|w\.o\.?)$/i, '').trim();
      const slug = VARIANT_TO_SLUG[variantName] || VARIANT_TO_SLUG[cleanName];

      if (!slug) {
        skusSkipped++;
        continue;
      }

      try {
        const pageUrl = `${BASE_URL}/${slug}`;
        const resp = await fetch(pageUrl, {
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(15000),
        });

        if (!resp.ok) {
          await addJobError(pool, job.id, `${variantName}: HTTP ${resp.status} for ${pageUrl}`);
          errorCount++;
          skusSkipped++;
          continue;
        }

        const html = await resp.text();
        const { productSwatch, lifestyleShot } = extractImages(html);

        // Upsert images — product swatch as primary, lifestyle as lifestyle
        if (productSwatch) {
          await upsertMediaAsset(pool, {
            product_id: sku.product_id,
            sku_id: sku.sku_id,
            asset_type: 'primary',
            url: productSwatch,
            original_url: productSwatch,
            sort_order: 0,
          });
          imagesAdded++;
        }

        if (lifestyleShot) {
          await upsertMediaAsset(pool, {
            product_id: sku.product_id,
            sku_id: sku.sku_id,
            asset_type: 'lifestyle',
            url: lifestyleShot,
            original_url: lifestyleShot,
            sort_order: 0,
          });
          imagesAdded++;
        }

        // Extract and upsert SKU attributes
        const specData = extractSpecs(html, variantName);
        for (const [attr, value] of Object.entries(specData)) {
          if (value) await upsertSkuAttribute(pool, sku.sku_id, attr, value);
        }

        skusEnriched++;

        if (skusEnriched % 5 === 0) {
          await appendLog(pool, job.id, `Progress: ${skusEnriched} enriched, ${imagesAdded} images`);
        }

        // Polite delay
        await new Promise(r => setTimeout(r, 1500));

      } catch (err) {
        errorCount++;
        if (errorCount <= 30) {
          await addJobError(pool, job.id, `${variantName}: ${err.message}`);
        }
        skusSkipped++;
      }
    }

    // Also assign images to non-M duplicate SKUs that share the same color
    const duplicates = skuResult.rows.filter(s => !byColor.has(s.variant_name.trim()) || byColor.get(s.variant_name.trim()) !== s);
    if (duplicates.length > 0) {
      await appendLog(pool, job.id, `Copying images to ${duplicates.length} duplicate SKUs...`);
      for (const dup of duplicates) {
        const primary = byColor.get(dup.variant_name.trim());
        if (!primary) continue;

        // Copy media from primary SKU to duplicate
        const mediaRows = await pool.query(
          'SELECT asset_type, url, original_url, sort_order FROM media_assets WHERE sku_id = $1',
          [primary.sku_id]
        );
        for (const media of mediaRows.rows) {
          await upsertMediaAsset(pool, {
            product_id: dup.product_id,
            sku_id: dup.sku_id,
            asset_type: media.asset_type,
            url: media.url,
            original_url: media.original_url,
            sort_order: media.sort_order,
          });
          imagesAdded++;
        }
      }
    }

    await appendLog(pool, job.id,
      `Complete. Enriched: ${skusEnriched}, Skipped: ${skusSkipped}, Images: ${imagesAdded}, Errors: ${errorCount}`,
      { skus_enriched: skusEnriched, images_added: imagesAdded }
    );

  } catch (err) {
    await addJobError(pool, job.id, `Fatal: ${err.message}`);
    throw err;
  }
}

/**
 * Extract product swatch and lifestyle images from page HTML.
 *
 * Handles three naming patterns found on Grand Pacific's Squarespace site:
 *   1. Numbered: ...+%281%29.jpg (lifestyle) / ...+%282%29.jpg (swatch)
 *   2. Room suffix: {ITEM}.jpg (swatch) / ...+Room.jpg (lifestyle)
 *   3. Plain + 1: ...+{Color}.jpg (swatch) / ...+{Color}+1.jpg (lifestyle)
 */
function extractImages(html) {
  // Collect all unique Squarespace product images (exclude logo, favicon)
  const sqspRegex = new RegExp(
    SQSP_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^"\'\\s<>]+\\.jpg',
    'g'
  );
  const allMatches = html.match(sqspRegex) || [];
  const seen = new Set();
  const images = [];
  for (const raw of allMatches) {
    const clean = raw.split('?')[0];
    if (seen.has(clean) || /logo|favicon/i.test(clean)) continue;
    seen.add(clean);
    images.push(clean);
  }

  if (images.length === 0) return { productSwatch: null, lifestyleShot: null };

  // Pattern 1: Numbered (1)/(2) — URL-encoded parens
  const numbered2 = images.find(u => u.includes('%282%29'));
  const numbered1 = images.find(u => u.includes('%281%29'));
  if (numbered2 || numbered1) {
    return { productSwatch: numbered2 || null, lifestyleShot: numbered1 || null };
  }

  // Pattern 2: Room suffix — lifestyle has "+Room" in filename
  const roomImg = images.find(u => /\+Room\./i.test(u));
  if (roomImg) {
    const swatch = images.find(u => u !== roomImg);
    return { productSwatch: swatch || null, lifestyleShot: roomImg };
  }

  // Pattern 3: Plain vs +1 suffix — the +1 image is the swatch, plain is lifestyle
  if (images.length >= 2) {
    const plusOne = images.find(u => /\+1\.jpg$/i.test(u) || /1\.jpg$/i.test(u.split('/').pop()));
    const plain = images.find(u => u !== plusOne);
    if (plusOne) {
      return { productSwatch: plusOne, lifestyleShot: plain || null };
    }
    // Fallback: longer filename is swatch (has color name + suffix)
    const sorted = [...images].sort((a, b) => b.length - a.length);
    return { productSwatch: sorted[0], lifestyleShot: sorted[1] };
  }

  // Single image — use as primary
  return { productSwatch: images[0], lifestyleShot: null };
}

/**
 * Extract specs from page HTML.
 * Format: <strong>LABEL</strong>&nbsp;VALUE or <strong>LABEL</strong> VALUE
 */
function extractSpecs(html, variantName) {
  const specs = {
    veneer:       '2mm',
    finish:       'Ultra Low Gloss Urethane (9 Coats)',
    construction: 'Engineered',
    warranty:     '50 Year Residential, 5 Year Light Commercial',
  };

  // Species: <strong>SPECIES</strong>&nbsp;White Oak
  const speciesMatch = html.match(/<strong>\s*SPECIES\s*<\/strong>\s*(?:&nbsp;)?\s*([^<]+)/i);
  if (speciesMatch) {
    specs.species = speciesMatch[1].replace(/&nbsp;/g, '').trim();
  } else {
    specs.species = ACACIA_VARIANTS.has(variantName) ? 'Acacia' : 'White Oak';
  }

  // Size: <strong>SIZE</strong>&nbsp;1/2" x 7.5" x Random Lengths up to 72"
  const sizeMatch = html.match(/<strong>\s*SIZE\s*<\/strong>\s*(?:&nbsp;)?\s*([^<]+)/i);
  if (sizeMatch) {
    specs.size = sizeMatch[1].replace(/&nbsp;/g, '').trim();
  }

  // Item: <strong>ITEM</strong>&nbsp;GPOK2668
  const itemMatch = html.match(/<strong>\s*ITEM\s*<\/strong>\s*(?:&nbsp;)?\s*([A-Z0-9]+)/i);
  if (itemMatch) {
    specs.manufacturer_sku = itemMatch[1].trim();
  }

  return specs;
}
