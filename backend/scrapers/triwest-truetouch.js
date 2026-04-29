import {
  delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, normalizeTriwestName, fuzzyMatch
} from './base.js';

const BASE_URL = 'https://www.truetouchfloors.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * True Touch enrichment scraper for Tri-West.
 *
 * Scrapes truetouchfloors.com for product swatch images, lifestyle photos,
 * specs, and PDFs. Enriches EXISTING Tri-West TTF SKUs — never creates new products.
 * Tech: Squarespace site, HTTP fetch (no Puppeteer needed).
 *
 * Site structure (10 collections across 5 categories):
 *   /all-products          — lists all category pages
 *   /{collection}          — collection detail: hero, lifestyle gallery, swatch gallery, specs
 *
 * Image strategy:
 *   Swatch/product photo   → primary (filename pattern: {Color}-Swatch-{collection}-truetouch-floors.jpg)
 *   Lifestyle/room scene   → lifestyle (separate gallery block on collection page)
 *
 * Runs AFTER import-triwest-832.cjs populates SKUs in the DB.
 */

// ── Collection definitions ──────────────────────────────────────────────────
// Each collection has a page at BASE_URL/{slug} with galleries + specs.
// productType maps to the 832 category for reference.
const COLLECTIONS = [
  // WPC → LVP (Plank)
  { name: 'Tsunami',    slug: 'tsunami',    productType: 'WPC',       categorySlug: 'lvp-plank',          construction: 'WPC' },
  // Laminate
  { name: 'Coastline',  slug: 'coastline',  productType: 'Laminate',  categorySlug: 'laminate',           construction: 'Laminate' },
  // Hardwood → Engineered Hardwood
  { name: 'Longboard',  slug: 'longboard',  productType: 'Hardwood',  categorySlug: 'engineered-hardwood', construction: 'Engineered Hardwood' },
  { name: 'Coast',      slug: 'coast',      productType: 'Hardwood',  categorySlug: 'engineered-hardwood', construction: 'Engineered Hardwood' },
  // MonoTech → Waterproof Wood
  { name: 'EVOLV',      slug: 'evolv-map',  productType: 'MonoTech',  categorySlug: 'waterproof-wood',    construction: 'MonoTech Waterproof Real Wood' },
  { name: 'Momentum',   slug: 'momentum-map', productType: 'MonoTech', categorySlug: 'waterproof-wood',   construction: 'MonoTech Waterproof Real Wood' },
  { name: 'Predator',   slug: 'predator',   productType: 'MonoTech',  categorySlug: 'waterproof-wood',    construction: 'MonoTech Waterproof Real Wood' },
  // SPC → LVP (Plank)
  { name: 'Hawaii 4.5', slug: 'hawaii-4-5', productType: 'SPC',       categorySlug: 'lvp-plank',          construction: 'SPC' },
  { name: 'Hawaii 5.0', slug: 'hawaii-5-0', productType: 'SPC',       categorySlug: 'lvp-plank',          construction: 'SPC' },
  { name: 'Serenity',   slug: 'serenity',   productType: 'SPC',       categorySlug: 'lvp-plank',          construction: 'SPC' },
];

// ── HTTP helper ─────────────────────────────────────────────────────────────
async function fetchHtml(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

// ── Parse collection page ───────────────────────────────────────────────────
// Extracts product photos, lifestyle images, and specs from a collection page.
function parseCollectionPage(html, collectionName) {
  const data = { swatches: [], lifestyleImages: [], specs: {} };

  const SKIP_FILENAMES = /logo|badge|icon|favicon|header|footer|certified|greenguard|lifeguard|floorscore|warranty|4ocean|one_tree|camera_icon|company_logo|room_vo|pet[-_]|waterproof[-_]|scratch[-_]|stain[-_]|spill[-_]|kid[-_]|worry|easy[-_]|life[-_]proof/i;

  // ── Extract product photos from Squarespace gallery ──
  // Squarespace uses data-image="url" with alt="ColorName" on gallery items.
  // The page has TWO galleries:
  //   1. Lifestyle gallery (top): descriptive alt text like "Biscayne flooring in a bedroom"
  //   2. Swatch gallery (bottom): clean color name alt text like "Biscayne"
  //
  // Product photos come from the swatch gallery (short, clean alt text).
  // Lifestyle images come from the lifestyle gallery (long/descriptive alt) or _RS filenames.

  // Words that indicate a descriptive alt (lifestyle gallery), not a clean color name
  const DESCRIPTIVE_ALT = /\b(?:floor(?:ing|s)?|room|living|bedroom|kitchen|bathroom|install|wooden|grain|texture|color|light|dark|interior|space|home|modern|style|visible|with|close-?up|surface|finish|pattern|variations?)\b/i;

  let match;
  const allItems = []; // Collect all gallery items first, then process
  const seenUrls = new Set();

  // Extract all data-image gallery items (both attribute orders)
  const patterns = [
    /data-image="(https:\/\/images\.squarespace-cdn\.com\/content\/[^"?]+)"[^>]*alt="([^"]+)"/gi,
    /alt="([^"]+)"[^>]*data-image="(https:\/\/images\.squarespace-cdn\.com\/content\/[^"?]+)"/gi,
  ];

  for (let pi = 0; pi < patterns.length; pi++) {
    const p = patterns[pi];
    while ((match = p.exec(html)) !== null) {
      const rawUrl = pi === 0 ? match[1] : match[2];
      const alt = (pi === 0 ? match[2] : match[1]).trim();
      if (seenUrls.has(rawUrl)) continue;
      seenUrls.add(rawUrl);

      const filename = decodeURIComponent(rawUrl.split('/').pop()).toLowerCase();
      if (SKIP_FILENAMES.test(filename) || filename.endsWith('.svg') || filename.endsWith('.png')) continue;
      if (!alt) continue;

      allItems.push({ rawUrl, alt, filename });
    }
  }

  // Classify items into swatches (product photos) vs lifestyle (room scenes).
  // Signals for swatch: "swatch" in filename or alt, or clean short alt text.
  // Signals for lifestyle: _rs/room-scene in filename, banner, or descriptive alt text.
  const seenColors = new Set();
  const lifestyleUrls = new Set();

  for (const item of allItems) {
    const { rawUrl, alt, filename } = item;

    // Room scene / banner detection (negative signal for swatch)
    const isRSFilename = filename.includes('_rs') || /\b-rs\b/.test(filename)
      || filename.includes('room-scene') || filename.includes('room_scene');
    const isBanner = filename.includes('banner');

    // Swatch detection (positive signal)
    const hasSwatchInFilename = filename.includes('swatch');
    const hasSwatchInAlt = /\bswatch\b/i.test(alt);
    const isCleanColorName = alt.length <= 25 && !DESCRIPTIVE_ALT.test(alt);
    const isProduct = (hasSwatchInFilename || hasSwatchInAlt || isCleanColorName)
      && !isRSFilename && !isBanner;

    // Skip items where alt text is literally a filename (decorative images)
    if (/\.\w{3,4}$/.test(alt)) continue;

    if (isProduct) {
      // Extract clean color name: strip "floor swatch", "floor color in...", trailing *, etc.
      let colorName = alt
        .replace(/\*$/, '')
        .replace(/\s+floor(?:ing)?\s+swatch$/i, '')
        .replace(/\s+floor(?:ing)?\s+color\b.*/i, '')
        .replace(/\s+floor(?:ing)?$/i, '')
        .replace(/\s+swatch$/i, '')
        .replace(/\s+color$/i, '')
        .trim();

      // If extracted name is still descriptive (long or has descriptive words),
      // fall back to extracting color name from filename.
      // Pattern: {collection}-{color}-swatch-truetouch-floors.jpg
      if (DESCRIPTIVE_ALT.test(colorName) || colorName.length > 30) {
        const beforeSwatch = filename.split(/[-_]swatch/)[0];
        const COLL_PREFIX = /^(?:coastline|coast|tsunami|hawaii-\d+-\d+|longboard|evolv|momentum|predator|serenity)[-_]?/i;
        let cleaned = beforeSwatch.replace(COLL_PREFIX, '');
        // Remove product codes (d75911, 75912, sn85701, lb75cb01) and trailing width digit (natural7 → natural)
        cleaned = cleaned.replace(/[-_]?(?:[a-z]{0,2}\d{4,}[a-z]?\d*)/g, '').replace(/\d+$/, '').replace(/^-+|-+$/g, '').replace(/-/g, ' ').trim();
        if (cleaned.length >= 2 && cleaned.length <= 25) {
          colorName = cleaned.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        } else {
          continue; // Can't determine color name — skip
        }
      }

      const colorKey = colorName.toLowerCase();
      if (colorKey && !seenColors.has(colorKey)) {
        seenColors.add(colorKey);
        data.swatches.push({
          colorName,
          url: rawUrl + '?format=1500w',
          originalUrl: rawUrl,
        });
      }
    } else if ((isRSFilename || isBanner || DESCRIPTIVE_ALT.test(alt)) && !lifestyleUrls.has(rawUrl)) {
      lifestyleUrls.add(rawUrl);
      // Try to extract color name from alt text (e.g., "Biscayne flooring in a bedroom" → "Biscayne")
      const altColorMatch = alt.match(/^(\w[\w\s]*?)\s+(?:floor|in\s|room|scene|swatch|color)/i);
      const colorHint = altColorMatch ? altColorMatch[1].trim() : null;
      data.lifestyleImages.push({ url: rawUrl + '?format=1500w', originalUrl: rawUrl, colorHint });
    }
  }

  // Fallback: find data-image URLs not already captured (room scenes without alt)
  const dataImagePattern = /data-image="(https:\/\/images\.squarespace-cdn\.com\/content\/[^"?]+)"/gi;
  while ((match = dataImagePattern.exec(html)) !== null) {
    const rawUrl = match[1];
    if (seenUrls.has(rawUrl)) continue;
    seenUrls.add(rawUrl);
    const filename = decodeURIComponent(rawUrl.split('/').pop()).toLowerCase();
    if (SKIP_FILENAMES.test(filename) || filename.endsWith('.svg') || filename.endsWith('.png')) continue;

    const isRS = filename.includes('_rs') || /\b-rs\b/.test(filename)
      || filename.includes('room-scene') || filename.includes('room_scene');
    if (isRS && !lifestyleUrls.has(rawUrl)) {
      lifestyleUrls.add(rawUrl);
      data.lifestyleImages.push({ url: rawUrl + '?format=1500w', originalUrl: rawUrl, colorHint: null });
    }
  }

  // ── Extract specs ──
  // Pattern: <strong>Label:</strong> Value or <b>Label:</b> Value
  // Also handles: <strong>Label:</strong>&nbsp;Value
  // And inline: <p><strong>Label:</strong> Value</p>
  const specPattern = /<(?:strong|b)>\s*([^<:]+):\s*<\/(?:strong|b)>\s*(?:&nbsp;)?\s*([^<]+)/gi;
  let specMatch;
  while ((specMatch = specPattern.exec(html)) !== null) {
    const label = specMatch[1].trim().toLowerCase();
    const value = specMatch[2].replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
    if (!value || value.length > 300) continue;

    if (label.includes('product type'))        data.specs.product_type = value;
    else if (label.includes('profile'))        data.specs.thickness = value;
    else if (label.includes('dimension'))      data.specs.dimensions = value;
    else if (label === 'width')                data.specs.width = value;
    else if (label === 'length')               data.specs.length = value;
    else if (label.includes('wear layer'))     data.specs.wear_layer = value;
    else if (label.includes('finish'))         data.specs.finish = value;
    else if (label.includes('click system'))   data.specs.click_system = value;
    else if (label.includes('edge'))           data.specs.edge_type = value;
    else if (label.includes('species'))        data.specs.material = value;
    else if (label.includes('core'))           data.specs.core = value;
    else if (label.includes('composition'))    data.specs.composition = value;
    else if (label.includes('warranty'))       data.specs.warranty = value;
    else if (label.includes('installation'))   data.specs.installation = value;
  }

  // Build dimensions from width + length if not already set
  if (!data.specs.dimensions && data.specs.width && data.specs.length) {
    data.specs.dimensions = `${data.specs.width} x ${data.specs.length}`;
  }

  return data;
}

// ── Main run function ───────────────────────────────────────────────────────
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 1500;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Truetouch Floors';

  let errorCount = 0;
  let skusEnriched = 0;
  let skusSkipped = 0;
  let imagesAdded = 0;
  let specsAdded = 0;

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { }
    }
  }

  try {
    // ── Load existing True Touch products & SKUs from DB ──
    // True Touch products are stored under Tri-West vendor with collection containing brand name.
    // The 832 import uses brand "Truetouch Floors (onit)" as the collection prefix.
    const prodResult = await pool.query(`
      SELECT p.id AS product_id, p.name, p.collection, p.description_long
      FROM products p
      WHERE p.vendor_id = $1 AND (
        p.collection ILIKE '%truetouch%' OR p.collection ILIKE '%true touch%'
      )
    `, [vendor_id]);

    const skuResult = await pool.query(`
      SELECT s.id AS sku_id, s.vendor_sku, s.internal_sku, s.variant_name, s.variant_type, s.product_id
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND (
        p.collection ILIKE '%truetouch%' OR p.collection ILIKE '%true touch%'
      )
    `, [vendor_id]);

    await appendLog(pool, job.id, `Found ${prodResult.rows.length} True Touch products (${skuResult.rows.length} SKUs) to enrich`);

    if (prodResult.rows.length === 0) {
      await appendLog(pool, job.id, 'No True Touch products found — run import-triwest-832 first');
      return;
    }

    // Build lookup structures
    const skusByProduct = new Map();
    for (const row of skuResult.rows) {
      if (!skusByProduct.has(row.product_id)) skusByProduct.set(row.product_id, []);
      skusByProduct.get(row.product_id).push(row);
    }

    // Check which SKUs already have a primary image — skip those individually
    const existingImages = await pool.query(`
      SELECT ma.sku_id
      FROM media_assets ma
      JOIN skus s ON s.id = ma.sku_id
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND ma.asset_type = 'primary' AND ma.sku_id IS NOT NULL
    `, [vendor_id]);
    const skusWithImages = new Set(existingImages.rows.map(r => r.sku_id));

    // Build product groups
    const productGroups = [];
    for (const row of prodResult.rows) {
      productGroups.push({
        product_id: row.product_id,
        name: row.name,
        collection: row.collection,
        description_long: row.description_long,
        skus: skusByProduct.get(row.product_id) || [],
      });
    }

    const skusNeedingImages = skuResult.rows.filter(s => !skusWithImages.has(s.sku_id)).length;
    await appendLog(pool, job.id, `${productGroups.length} products, ${skuResult.rows.length} SKUs total (${skusWithImages.size} SKUs already have images, ${skusNeedingImages} need enrichment)`);

    // ── Fix missing accessory variant_type ──
    // Some accessory products from the 832 import may be missing variant_type='accessory'.
    // Detect by product name containing accessory keywords.
    const accessoryKeywords = /square.?nose|stair.?nose|quarter.?round|reducer|t.?mold|end.?cap|threshold|transition/i;

    // Also find True Touch accessories that were assigned to wrong collections by the 832 import.
    // Require name to START with a True Touch collection name (Coast, Tsunami, etc.)
    // to avoid false positives like "Genesis Quarter Round Hawaii".
    const misattributedResult = await pool.query(`
      SELECT p.id FROM products p
      WHERE p.vendor_id = $1
        AND p.collection NOT ILIKE '%truetouch%' AND p.collection NOT ILIKE '%true touch%'
        AND (p.name ~* '^(Coast|Tsunami|Coastline|Longboard|Evolv|Momentum|Predator|Hawaii|Serenity)')
        AND (p.name ~* '(square.?nose|stair.?nose|quarter.?round|reducer|t.?mold|end.?cap)')
    `, [vendor_id]);
    if (misattributedResult.rows.length > 0) {
      const ids = misattributedResult.rows.map(r => r.id);
      await pool.query(
        `UPDATE products SET collection = 'Truetouch Floors (onit)' WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      await appendLog(pool, job.id, `Fixed ${ids.length} True Touch accessory product(s) → correct collection`);

      // Reload product groups with newly-included products
      const extraProds = await pool.query(`
        SELECT p.id AS product_id, p.name, p.collection, p.description_long
        FROM products p WHERE p.id = ANY($1::uuid[])
      `, [ids]);
      const extraSkus = await pool.query(`
        SELECT s.id AS sku_id, s.vendor_sku, s.internal_sku, s.variant_name, s.variant_type, s.product_id
        FROM skus s WHERE s.product_id = ANY($1::uuid[])
      `, [ids]);
      for (const row of extraProds.rows) {
        const skus = extraSkus.rows.filter(s => s.product_id === row.product_id);
        productGroups.push({
          product_id: row.product_id,
          name: row.name,
          collection: 'Truetouch Floors (onit)',
          description_long: row.description_long,
          skus,
        });
        for (const s of skus) {
          if (!skusByProduct.has(row.product_id)) skusByProduct.set(row.product_id, []);
          skusByProduct.get(row.product_id).push(s);
        }
      }
    }

    for (const group of productGroups) {
      if (accessoryKeywords.test(group.name)) {
        const nonAccessorySkus = group.skus.filter(s => s.variant_type !== 'accessory');
        if (nonAccessorySkus.length > 0) {
          const skuIds = nonAccessorySkus.map(s => s.sku_id);
          await pool.query(
            `UPDATE skus SET variant_type = 'accessory', sell_by = 'unit' WHERE id = ANY($1::uuid[])`,
            [skuIds]
          );
          await appendLog(pool, job.id, `Fixed ${skuIds.length} SKUs in "${group.name}" → variant_type='accessory'`);
        }
      }
    }

    // ── Fix accessory variant names ──
    // Append accessory type from SKU suffix so names make sense on storefront.
    // e.g., "Biscayne" → "Biscayne - Square Nose"
    const SKU_SUFFIX_MAP = {
      FSTN: 'Flush Stair Nose',
      QTR: 'Quarter Round',
      RED: 'Reducer',
      SQN: 'Square Nose',
      TMD: 'T-Mold',
    };
    let namesFixed = 0;
    for (const group of productGroups) {
      for (const sku of group.skus) {
        if (sku.variant_type !== 'accessory') continue;
        if (sku.variant_name && sku.variant_name.includes(' - ')) continue; // already has type
        const vs = sku.vendor_sku || '';
        let accType = null;
        for (const [suffix, label] of Object.entries(SKU_SUFFIX_MAP)) {
          if (vs.endsWith(suffix)) { accType = label; break; }
        }
        // Coast accessories end with "4S" (Summit Square Nose)
        if (!accType && /4S$/i.test(vs)) accType = 'Square Nose';
        if (accType && sku.variant_name) {
          const newName = `${sku.variant_name} - ${accType}`;
          await pool.query('UPDATE skus SET variant_name = $1 WHERE id = $2', [newName, sku.sku_id]);
          sku.variant_name = newName;
          namesFixed++;
        }
      }
    }
    if (namesFixed > 0) {
      await appendLog(pool, job.id, `Fixed ${namesFixed} accessory variant names with type suffix`);
    }

    // ── Scrape all collection pages ──
    await appendLog(pool, job.id, `Scraping ${COLLECTIONS.length} collection pages...`);
    const siteData = new Map(); // collectionName → { swatches, lifestyleImages, specs }

    for (const coll of COLLECTIONS) {
      try {
        const url = `${BASE_URL}/${coll.slug}`;
        const html = await fetchHtml(url);
        const pageData = parseCollectionPage(html, coll.name);
        siteData.set(coll.name, { ...pageData, ...coll });
        await appendLog(pool, job.id,
          `  ${coll.name}: ${pageData.swatches.length} colors, ${pageData.lifestyleImages.length} lifestyle imgs, ${Object.keys(pageData.specs).length} specs`
        );
        await delay(delayMs);
      } catch (err) {
        await logError(`Failed to scrape ${coll.name} (${coll.slug}): ${err.message}`);
      }
    }

    // ── Match DB products to site collections ──
    // Product names from the 832 contain the collection name (e.g., "Coast Collection 7.5 X75",
    // "Evolv Collection (12mm) 9-3/8 W X 5 L"). We need to match these to site collections.
    let matched = 0;
    let unmatched = 0;

    for (const group of productGroups) {
      // Skip accessory products for image matching (they share images with their parent collection)
      const isAccessory = accessoryKeywords.test(group.name);

      // Try to match product name to a collection
      const productNameLower = group.name.toLowerCase();
      let bestCollection = null;
      let bestScore = 0;

      for (const [collName, collData] of siteData) {
        const collLower = collName.toLowerCase();
        // Direct name match (e.g., "Coast Collection" contains "coast", "Evolv Collection" contains "evolv")
        if (productNameLower.includes(collLower) || productNameLower.includes(collLower.replace(/\s+/g, ''))) {
          bestCollection = { name: collName, ...collData };
          bestScore = 1.0;
          break;
        }
        // Fuzzy: collection name appears in product name or collection field
        const collectionField = (group.collection || '').toLowerCase();
        if (collectionField.includes(collLower)) {
          bestCollection = { name: collName, ...collData };
          bestScore = 0.9;
        }
      }

      if (!bestCollection || bestCollection.swatches.length === 0) {
        unmatched++;
        skusSkipped += group.skus.length;
        continue;
      }

      matched++;

      // ── Match SKU colors to swatches ──
      const mainSkus = group.skus.filter(s => s.variant_type !== 'accessory');
      const skusToMatch = mainSkus.length > 0 ? mainSkus : group.skus;

      for (const sku of skusToMatch) {
        // Skip SKUs that already have a primary image
        if (skusWithImages.has(sku.sku_id)) {
          skusSkipped++;
          continue;
        }

        const variantName = normalizeTriwestName(sku.variant_name || '').toLowerCase();
        if (!variantName) continue;

        // Find best swatch match
        let bestSwatch = null;
        let bestSwatchScore = 0;

        for (const swatch of bestCollection.swatches) {
          const swatchColor = swatch.colorName.toLowerCase();

          // Exact match
          if (variantName === swatchColor) {
            bestSwatch = swatch;
            bestSwatchScore = 1.0;
            break;
          }

          // Fuzzy match
          const score = fuzzyMatch(variantName, swatchColor);
          if (score > bestSwatchScore && score >= 0.7) {
            bestSwatch = swatch;
            bestSwatchScore = score;
          }
        }

        if (!bestSwatch) {
          skusSkipped++;
          continue;
        }

        // ── Save swatch image as primary for this SKU ──
        try {
          await upsertMediaAsset(pool, {
            product_id: group.product_id,
            sku_id: sku.sku_id,
            asset_type: 'primary',
            url: bestSwatch.url,
            original_url: bestSwatch.originalUrl,
            sort_order: 0,
          });
          imagesAdded++;
          skusEnriched++;
        } catch (err) {
          await logError(`Image save failed for ${sku.vendor_sku}: ${err.message}`);
          skusSkipped++;
        }
      }

      // ── Save lifestyle images per-SKU where color matches ──
      if (bestCollection.lifestyleImages && bestCollection.lifestyleImages.length > 0) {
        let sortOrder = 10;
        for (const img of bestCollection.lifestyleImages) {
          // Try to match lifestyle image to a specific SKU via colorHint
          let matchedSkuId = null;
          if (img.colorHint) {
            const hint = img.colorHint.toLowerCase();
            for (const sku of skusToMatch) {
              const vn = (sku.variant_name || '').toLowerCase();
              if (vn && (vn === hint || hint.includes(vn) || vn.includes(hint))) {
                matchedSkuId = sku.sku_id;
                break;
              }
            }
          }
          // Only save if we can associate with a specific SKU (avoid unrelated images on other SKU pages)
          if (!matchedSkuId) continue;
          try {
            await upsertMediaAsset(pool, {
              product_id: group.product_id,
              sku_id: matchedSkuId,
              asset_type: 'lifestyle',
              url: img.url,
              original_url: img.originalUrl,
              sort_order: sortOrder++,
            });
            imagesAdded++;
          } catch { }
        }
      }

      // ── Save specs as SKU attributes ──
      const specs = bestCollection.specs || {};
      if (Object.keys(specs).length > 0) {
        for (const sku of group.skus) {
          for (const [attrSlug, value] of Object.entries(specs)) {
            if (value) {
              try {
                await upsertSkuAttribute(pool, sku.sku_id, attrSlug, value);
                specsAdded++;
              } catch { }
            }
          }
        }
      }

      // ── Fix category if wrong ──
      if (bestCollection.categorySlug) {
        const catResult = await pool.query(
          'SELECT id FROM categories WHERE slug = $1', [bestCollection.categorySlug]
        );
        if (catResult.rows.length > 0) {
          await pool.query(
            'UPDATE products SET category_id = $1 WHERE id = $2 AND (category_id IS NULL OR category_id != $1)',
            [catResult.rows[0].id, group.product_id]
          );
        }
      }

      // ── Update product description if missing ──
      if (!group.description_long && bestCollection.construction) {
        const desc = `${bestCollection.name} ${bestCollection.construction} flooring by TrueTouch Floors. Part of the ${bestCollection.productType} collection.`;
        await pool.query(
          'UPDATE products SET description_long = $1 WHERE id = $2 AND description_long IS NULL',
          [desc, group.product_id]
        );
      }

      if ((matched + unmatched) % 5 === 0) {
        await appendLog(pool, job.id, `Progress: ${matched + unmatched}/${productGroups.length} products, ${imagesAdded} images, ${specsAdded} specs`);
      }
    }

    await appendLog(pool, job.id,
      `Complete. Matched: ${matched}, Unmatched: ${unmatched}, SKUs enriched: ${skusEnriched}, ` +
      `Skipped: ${skusSkipped}, Images: ${imagesAdded}, Specs: ${specsAdded}, Errors: ${errorCount}`,
      { products_found: productGroups.length, products_updated: matched }
    );

  } catch (err) {
    await logError(`Fatal: ${err.message}`);
    throw err;
  }
}
