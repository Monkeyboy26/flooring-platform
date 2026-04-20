import {
  launchBrowser, delay, appendLog, addJobError,
  upsertProduct, upsertSku, upsertPricing, upsertPackaging,
  saveProductImages, saveSkuImages, upsertMediaAsset, upsertSkuAttribute,
  filterImageUrls, filterImagesByVariant, preferProductShot, isLifestyleUrl,
  extractSpecPDFs, fuzzyMatch, normalizeTriwestName
} from './base.js';
import { triwestLogin, triwestLoginFromCookies, PORTAL_BASE } from './triwest-auth.js';
import { searchByManufacturer, navigateToSearchForm } from './triwest-search.js';
import https from 'https';

const BASE_URL = 'https://www.provenzafloors.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/** TW collection name (uppercase) → Provenza website collection name */
const COLLECTION_MAP = {
  'AFFINITY': 'Affinity',
  'AFRICAN PLAINS': 'African Plains',
  'AFRICAN': 'African Plains',       // DNav truncated pattern
  'ANTICO': 'Antico',
  'CADEAU': 'Cadeau',
  'CONCORDE OAK': 'Concorde Oak',
  'CONCORDE': 'Concorde Oak',        // DNav truncated pattern
  'DUTCH MASTERS': 'Dutch Masters',
  'EUROPEAN OAK 4MM': 'Dutch Masters',
  'FIRST IMPRESSIONS': 'First Impressions',
  'FIRST IMP': 'First Impressions',  // DNav truncated pattern
  'GRAND POMPEII': 'Grand Pompeii',
  'GRAND POM': 'Grand Pompeii',      // DNav truncated pattern
  'HERRINGBONE RESERVE': 'Herringbone Reserve',
  'HERRINGBONE CUSTOM': 'Herringbone Custom',
  'LIGHTHOUSE COVE': 'Lighthouse Cove',
  'LIGHTHOUS': 'Lighthouse Cove',    // DNav truncated pattern
  'LUGANO': 'Lugano',
  'MATEUS': 'Mateus',
  'MODA LIVING ELITE': 'Moda Living Elite',
  'MODA LIVING': 'Moda Living',
  'MODERN RUSTIC': 'Modern Rustic',
  'MODESSA': 'Modessa',
  'NEW WAVE': 'New Wave',
  'NEW YORK LOFT': 'New York Loft',
  'NYC LOFT': 'New York Loft',
  'OLD WORLD': 'Old World',
  'OPIA': 'Opia',
  'PALAIS ROYALE': 'Palais Royale',
  'PALAIS RO': 'Palais Royale',      // DNav truncated pattern
  'POMPEII': 'Pompeii',
  'RICHMOND': 'Richmond',
  'STONESCAPE': 'Stonescape',
  'STONESCAT': 'Stonescape',         // DNav truncated pattern
  'STUDIO MODERNO': 'Studio Moderno',
  'STUDIO MO': 'Studio Moderno',     // DNav truncated pattern
  'TRESOR': 'Tresor',
  'UPTOWN CHIC': 'Uptown Chic',
  'UPTOWN CH': 'Uptown Chic',        // DNav truncated pattern
  'VITALI ELITE': 'Vitali Elite',
  'VITALI EL': 'Vitali Elite',       // DNav truncated pattern
  'VITALI': 'Vitali',
  'VOLTERRA': 'Volterra',
  'WALL CHIC': 'Wall Chic',
};

/** Color → collection reverse lookup for matching when DNav pattern is ambiguous */
const COLOR_TO_COLLECTION = new Map();
{
  const PROVENZA_COLORS = {
    'Affinity': ['Contour', 'Delight', 'Intrigue', 'Journey', 'Liberation', 'Mellow', 'Silhouette', 'Acclaim', 'Celebration', 'Engage'],
    'African Plains': ['Raffia', 'Sahara Sun', 'Black River', 'Serengeti'],
    'Antico': ['Auburn', 'Chamboard', 'Heritage', 'Caribou', 'Relic', 'Clay'],
    'Cadeau': ['Aria', 'Cadence', 'Chapelle', 'Dolce', 'Ferro', 'Largo', 'Noir', 'Shimmer', 'Sonata', 'Verdun'],
    'Concorde Oak': ['Brushed Pearl', 'Cool Classic', 'French Revival', 'London Fog', 'Loyal Friend', 'Mystic Moon', 'Royal Crest', 'Smoked Amber', 'Warm Tribute', 'Willow Wisp'],
    'Dutch Masters': ['Bosch', 'Cleve', 'Escher', 'Gaspar', 'Hals', 'Klee', 'Leyster', 'Mondrian', 'Steen', 'Vermeer'],
    'First Impressions': ['High Style', 'One N Only', 'Pop Art', 'Cool Comfort', 'Real Deal', 'Cozy Cottage', 'Best Choice'],
    'Grand Pompeii': ['Apollo', 'Stabiane', 'Regina', 'Loreto', 'Nolana'],
    'Herringbone Reserve': ['Autumn Wheat', 'Stone Grey', 'Dovetail'],
    'Herringbone Custom': ['Autumn Wheat Weathered', 'Stone Grey Weathered', 'Dovetail Weathered', 'Ivory White Weathered', 'Black Pearl Weathered', 'Frosty Taupe Weathered', 'Ruby Red Weathered'],
    'Lighthouse Cove': ['Ivory White', 'Black Pearl', 'Frosty Taupe', 'Ruby Red'],
    'Lugano': ['Bella', 'Forma', 'Oro', 'Chiara', 'Felice', 'Genre'],
    'Mateus': ['Adora', 'Chateau', 'Enzo', 'Lido', 'Luxor', 'Maxime', 'Prado', 'Remy', 'Savoy', 'Trevi'],
    'Moda Living': ['At Ease', 'First Crush', 'Jet Set', 'Fly Away', 'True Story', 'Soul Mate', 'Soft Whisper', 'Finally Mine', 'Hang Ten', 'Sweet Talker'],
    'Moda Living Elite': ['Bravo', 'Diva', 'Foxy', 'Inspire', 'Vogue', 'Luxe', 'Jewel', 'Oasis', 'Soulful', 'Gala'],
    'Modern Rustic': ['Moonlit Pearl', 'Silver Lining', 'Oyster White'],
    'Modessa': ['Showtime', 'So Chic', 'Cover Story', 'High Life', 'Game On', 'Grandstand', 'Heartbreaker', 'Starling', 'Knockout', 'Morning Light'],
    'New Wave': ['Bashful Beige', 'Daring Doe', 'Great Escape', 'Lunar Glow', 'Modern Mink', 'Nest Egg', 'Night Owl', 'Playful Pony', 'Rare Earth', 'Timber Wolf'],
    'New York Loft': ['Canal Street', 'Park Place', 'Pier 55', 'Penn Station', 'West End', 'Carnegie Hall'],
    'Old World': ['Cocoa Powder', 'Toasted Sesame', 'Mount Bailey', 'Gray Rocks', 'Mink', 'Pearl Grey', 'Desert Haze', 'Fossil Stone', 'Warm Sand', 'Tortoise Shell'],
    'Opia': ['Brulee', 'Coterie', 'Curio', 'Destiny', 'Echo', 'Fontaine', 'Galerie', 'Maestro', 'Portico', 'Silo'],
    'Palais Royale': ['Amiens', 'Orleans', 'Riviera', 'Toulouse', 'Versailles'],
    'Pompeii': ['Vesuvius', 'Salina'],
    'Richmond': ['Stone Bridge', 'Flint Hill', 'Merrimac'],
    'Stonescape': ['Ancient Earth', 'Angel Trail', 'Desert View', 'Formation Grey', 'Lava Dome', 'Mountain Mist'],
    'Studio Moderno': ['Fellini', 'Cavalli'],
    'Tresor': ['Amour', 'Classique', 'Diamonte', 'Jolie', 'Lyon', 'Symphonie', 'Orsay', 'Rondo'],
    'Uptown Chic': ['Big Easy', 'Catwalk', 'Class Act', 'Double Dare', 'Jazz Singer', 'Naturally Yours', 'Posh Beige', 'Sassy Grey', 'Rock N Roll', 'Bold Ambition'],
    'Vitali': ['Corsica', 'Genova', 'Milano', 'Napoli', 'Rocca', 'Arezzo', 'Fabio', 'Galo', 'Lucca'],
    'Vitali Elite': ['Alba', 'Bronte', 'Carrara', 'Cori', 'Modena', 'Paterno', 'Sandrio', 'Trento'],
    'Volterra': ['Grotto', 'Pisa', 'Antica', 'Valori', 'Avellino', 'Lombardy', 'Mara', 'Novara', 'Ravina', 'Savona'],
    'Wall Chic': ['Bombshell', 'Devotion', 'Elegance', 'Euphoria', 'Fearless', 'Finesse', 'Harmony', 'Ingenue', 'Intuition', 'Sensation'],
  };
  for (const [coll, colors] of Object.entries(PROVENZA_COLORS)) {
    for (const color of colors) {
      const key = color.toUpperCase();
      if (!COLOR_TO_COLLECTION.has(key)) COLOR_TO_COLLECTION.set(key, coll);
    }
  }
}

/** Known collections by category on provenzafloors.com */
const COLLECTIONS_BY_CATEGORY = {
  hardwood: [
    'Affinity', 'African Plains', 'Antico', 'Cadeau', 'Dutch Masters',
    'Grand Pompeii', 'Herringbone Reserve', 'Herringbone Custom',
    'Lighthouse Cove', 'Lugano', 'Mateus', 'Modern Rustic',
    'New York Loft', 'Old World', 'Opia', 'Palais Royale', 'Pompeii',
    'Richmond', 'Studio Moderno', 'Tresor', 'Vitali', 'Vitali Elite',
    'Volterra', 'Wall Chic',
  ],
  waterprooflvp: [
    'Concorde Oak', 'First Impressions', 'Moda Living', 'Moda Living Elite',
    'New Wave', 'Stonescape', 'Uptown Chic',
  ],
  maxcorelaminate: [
    'Modessa',
  ],
};

/** Accessory patterns — products matching these are NOT on provenzafloors.com */
const ACCESSORY_RE = /\b(stair\s*nos?e?|stair\s*ns|str\s*ns|flush\s*sn|reducer|t[- ]?mold|t[- ]?mldg|bullnose|quarter\s*round|qtr\s*rnd|threshold|end\s*cap|overlap|flush\s*mount|baby\s*threshold|multi[- ]?purpose|transition|scotia|shoe\s*mold|cleaner|touch\s*up|repair\s*kit|oil\s*refresh|stain\b|custom\s*mold|maintenance|fabricated|color\s*set)/i;

/** Mapping of spec label text (lowercase) → attribute slug for sku_attributes upsert */
const SPEC_LABEL_MAP = {
  'species': 'species',
  'wood species': 'species',
  'finish': 'finish',
  'surface finish': 'finish',
  'surface': 'finish',
  'finish type': 'finish',
  'width': 'size',
  'dimensions': 'size',
  'plank size': 'size',
  'size': 'size',
  'plank width': 'size',
  'thickness': 'thickness',
  'overall thickness': 'thickness',
  'total thickness': 'thickness',
  'construction': 'construction',
  'construction type': 'construction',
  'core type': 'construction',
  'core': 'construction',
  'wear layer': 'wear_layer',
  'wearlayer': 'wear_layer',
  'wear layer thickness': 'wear_layer',
  'installation': 'installation',
  'install method': 'installation',
  'installation method': 'installation',
  'edge': 'edge',
  'edge type': 'edge',
  'edge detail': 'edge',
  'grade': 'grade',
  'janka hardness': 'hardness',
  'hardness': 'hardness',
};

// ──────────────────────────────────────────────
// New constants for 6-phase pipeline
// ──────────────────────────────────────────────

/** Category slug map from provenzafloors.com categories to PIM category slugs */
const CATEGORY_SLUG_MAP = {
  hardwood: 'engineered-hardwood',
  waterprooflvp: 'lvp-plank',
  maxcorelaminate: 'laminate',
};

/** Default retail prices per category (used when no DNav pricing available) */
const DEFAULT_PRICES = {
  'engineered-hardwood': 7.49,
  'lvp-plank': 4.99,
  'laminate': 3.99,
};

/** DNav Pattern column values that indicate accessories */
const ACCESSORY_PATTERN_WORDS = [
  'STAIRNOSE', 'STAIR NOSE', 'STAIR NS', 'STR NS', 'FLUSH SN',
  'REDUCER', 'T-MLDG', 'T MLDG', 'T-MOLD',
  'QTR RND', 'QUARTER ROUND', 'END CAP', 'SQR NOSE', 'SQUARE NOSE',
  'THRESHOLD', 'BULLNOSE', 'MULTI-PURPOSE', 'MULTI PURPOSE',
  'FLUSH MOUNT', 'FLUSH MT', 'BABY THRESHOLD', 'BABY THRESH',
  'OVERLAP', 'TRANSITION', 'SCOTIA', 'SHOE MOLD', 'SHOE MOULD',
  'CLEANER', 'TOUCH UP', 'REPAIR KIT', 'REFRESHER', 'OSMO',
  'COLOR SET', 'CUSTOM MOLD', 'STAIN', 'OIL REFRESH',
  'MAINTENANCE', 'FABRICATED',
];

function slugify(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function titleCase(str) {
  if (!str) return '';
  const s = str.trim();
  if (s !== s.toUpperCase() || s.length <= 2) return s;
  return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

/** Determine if a DNav row is an accessory vs flooring. */
function isDnavAccessory(row) {
  // Check ALL text fields for accessory keywords, not just pattern
  const combined = `${row.pattern || ''} ${row.productName || ''} ${row.rawDescription || ''} ${row.color || ''}`.toUpperCase();
  for (const ap of ACCESSORY_PATTERN_WORDS) {
    if (combined.includes(ap)) return true;
  }
  if (ACCESSORY_RE.test(combined)) return true;
  // Non-flooring units (PC=piece, EA=each) are almost always accessories
  if (row.unit === 'PC' || row.unit === 'EA' || row.unit === 'ST') return true;
  return false;
}

/** Normalize accessory type from DNav data for product grouping. */
function normalizeAccessoryType(row) {
  const combined = `${row.pattern} ${row.productName} ${row.rawDescription} ${row.color || ''}`.toUpperCase();
  if (/STAIR\s*NOS?E?|STAIR\s*NS\b|STR\s*NS\b|FLUSH\s*SN\b/.test(combined)) return 'Stairnose';
  if (/REDUCER/.test(combined)) return 'Reducer';
  if (/T[-\s]?MOL[D]?|T[-\s]?MLDG/.test(combined)) return 'T-Molding';
  if (/QTR\s*RND|QUARTER\s*ROUND/.test(combined)) return 'Quarter Round';
  if (/END\s*CAP/.test(combined)) return 'End Cap';
  if (/SQR?\s*NOSE|SQUARE\s*NOSE/.test(combined)) return 'Square Nose';
  if (/BABY\s*THRESH/.test(combined)) return 'Baby Threshold';
  if (/THRESHOLD/.test(combined)) return 'Threshold';
  if (/BULLNOSE/.test(combined)) return 'Bullnose';
  if (/MULTI[-\s]?PURPOSE/.test(combined)) return 'Multi-Purpose';
  if (/FLUSH\s*MOUNT|FLUSH\s*MT/.test(combined)) return 'Flush Mount';
  if (/OVERLAP/.test(combined)) return 'Overlap';
  if (/TRANSITION/.test(combined)) return 'Transition';
  if (/SCOTIA/.test(combined)) return 'Scotia';
  if (/SHOE\s*MOL[D]?/.test(combined)) return 'Shoe Molding';
  if (/CLEANER/.test(combined)) return 'Cleaner';
  if (/OIL\s*REFRESH/.test(combined)) return 'Oil Refresher';
  if (/STAIN\b/.test(combined)) return 'Stain';
  if (/TOUCH\s*UP|REPAIR/.test(combined)) return 'Repair Kit';
  if (/MAINTENANCE|CLEANING\s*KIT/.test(combined)) return 'Maintenance Kit';
  if (/CUSTOM\s*MOLD/.test(combined)) return 'Custom Molding';
  if (/COLOR\s*SET/.test(combined)) return 'Color Set';
  if (/FABRICATED/.test(combined)) return 'Fabricated Stairnose';
  return 'Accessory';
}

/**
 * Map DNav pattern to canonical Provenza collection name.
 * Strips product-type suffixes and size dimensions, then looks up in COLLECTION_MAP.
 */
function dnavToCollection(pattern, row) {
  // Try pattern column first
  const result = _matchCollection(pattern);
  if (result) return result;

  // Try extracting collection from rawDescription (line 2 often has the full name)
  if (row && row.rawDescription) {
    const lines = row.rawDescription.split(/\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
      const line2 = lines[1]
        .replace(/\*[\d.]+/g, '').replace(/\d+\/?CT/gi, '').replace(/XXX/g, '')
        .replace(/COLL\b[\s."]*/gi, '').replace(/COLLECTION/gi, '')
        .trim();
      const fromDesc = _matchCollection(line2);
      if (fromDesc) return fromDesc;
    }
  }

  // Color → collection reverse lookup (when pattern is ambiguous)
  if (row && row.color) {
    const coll = COLOR_TO_COLLECTION.get(row.color.toUpperCase());
    if (coll) return coll;
  }

  return null;
}

function _matchCollection(text) {
  if (!text) return null;
  let normalized = text.toUpperCase()
    .replace(/\b(WPF-LVP|WPF|SPC-LVP|SPC|MAXCORE|LVP|LAMINATE)\b/g, '')
    .replace(/\s+COLLECTION$/i, '').replace(/\s+COLL$/i, '')
    .replace(/\b\d+MIL\b/g, '')
    .replace(/\b\d+MM?X[\d.]+\b/g, '')
    .replace(/\b[\d.]+\s*X\s*[\d.]+\b/g, '')
    .replace(/\s+/g, ' ').trim();

  if (COLLECTION_MAP[normalized]) return COLLECTION_MAP[normalized];

  // Longest-prefix match
  const sorted = Object.keys(COLLECTION_MAP).sort((a, b) => b.length - a.length);
  for (const key of sorted) {
    if (normalized.startsWith(key)) return COLLECTION_MAP[key];
  }

  // Contains match — check if any known collection appears in the text
  for (const key of sorted) {
    if (key.length >= 5 && normalized.includes(key)) return COLLECTION_MAP[key];
  }

  return null;
}

// ──────────────────────────────────────────────
// Main scraper: 6-phase website-first pipeline
// ──────────────────────────────────────────────

/**
 * Provenza website-first full catalog import.
 *
 * Phase 1: Scrape provenzafloors.com collection pages to build catalog of all colors.
 * Phase 2: Create products (1 per collection) + SKUs (1 per color) with images, specs, descriptions.
 * Phase 3: GCS image backfill for any SKUs still missing primary images.
 * Phase 4: DNav pricing overlay — login to portal, match DNav rows to website SKUs, update pricing.
 * Phase 5: Collection-level price propagation — fill pricing gaps from siblings or category defaults.
 * Phase 6: Activation + cleanup — activate products with images+pricing, deactivate orphans.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const retailMarkup = config.retail_markup || 2.0;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Provenza';

  let browser = null;
  let errorCount = 0;
  const stats = {
    productsCreated: 0,
    skusCreated: 0,
    imagesAdded: 0,
    specsAdded: 0,
    descriptionsAdded: 0,
    pdfsAdded: 0,
    dnavMatched: 0,
    dnavAccessoryProducts: 0,
    dnavAccessorySkus: 0,
    pricesPropagated: 0,
    activated: 0,
  };

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { }
    }
  }

  try {
    // ── Resolve category IDs ──
    const categoryCache = new Map();
    for (const slug of ['engineered-hardwood', 'lvp-plank', 'laminate']) {
      const res = await pool.query('SELECT id FROM categories WHERE slug = $1', [slug]);
      if (res.rows.length > 0) categoryCache.set(slug, res.rows[0].id);
    }

    // ══════════════════════════════════════════════════
    // Phase 1: Build Website Catalog
    // ══════════════════════════════════════════════════
    await appendLog(pool, job.id, 'Phase 1: Scraping provenzafloors.com collection pages...');
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900 });

    const catalog = await buildCatalog(page, pool, job, delayMs);

    let totalColors = 0;
    for (const [, group] of catalog) totalColors += group.colors.length;
    await appendLog(pool, job.id,
      `Phase 1 complete: ${totalColors} colors across ${catalog.size} collections`);

    // ══════════════════════════════════════════════════
    // Phase 2: Create Products + SKUs + Detail Page Enrichment
    // ══════════════════════════════════════════════════
    await appendLog(pool, job.id, 'Phase 2: Creating products and SKUs from website catalog...');
    const detailQueue = [];
    const productsWithPrimary = new Set();

    for (const [collectionName, group] of catalog) {
      try {
        const categorySlug = CATEGORY_SLUG_MAP[group.category] || 'engineered-hardwood';
        const categoryId = categoryCache.get(categorySlug) || null;
        const collectionDisplay = `${brandPrefix} - ${collectionName}`;

        const product = await upsertProduct(pool, {
          vendor_id,
          name: collectionName,
          collection: collectionDisplay,
          category_id: categoryId,
        }, { jobId: job.id });

        stats.productsCreated++;

        for (const color of group.colors) {
          try {
            const collSlug = slugify(collectionName);
            const colorSlug = slugify(color.colorName);
            const internalSku = `TW-PROV-${collSlug}-${colorSlug}`;

            const sku = await upsertSku(pool, {
              product_id: product.id,
              vendor_sku: null,
              internal_sku: internalSku,
              variant_name: color.colorName,
              sell_by: 'sqft',
              variant_type: null,
            }, { jobId: job.id });

            stats.skusCreated++;

            // Save SKU-level images from catalog
            if (color.imageUrls && color.imageUrls.length > 0) {
              const filtered = filterImageUrls(color.imageUrls, { maxImages: 4 });
              if (filtered.length > 0) {
                const sorted = preferProductShot(filtered, color.colorName);
                const saved = await saveSkuImages(pool, product.id, sku.id, sorted);
                stats.imagesAdded += saved;

                // Also set product-level primary image (first color wins)
                if (!productsWithPrimary.has(product.id)) {
                  await saveProductImages(pool, product.id, sorted.slice(0, 1));
                  productsWithPrimary.add(product.id);
                }
              }
            }

            // Save basic attributes from tile data
            await upsertSkuAttribute(pool, sku.id, 'color', color.colorName);
            await upsertSkuAttribute(pool, sku.id, 'brand', brandPrefix);
            await upsertSkuAttribute(pool, sku.id, 'collection', collectionName);
            if (color.species) await upsertSkuAttribute(pool, sku.id, 'species', color.species);
            if (color.finish) await upsertSkuAttribute(pool, sku.id, 'finish', color.finish);

            // Queue for detail page scraping
            detailQueue.push({
              sku_id: sku.id,
              product_id: product.id,
              catalogKey: `${collectionName}||${color.normColor}`,
              catalogEntry: {
                collection: collectionName,
                category: group.category,
                colorName: color.colorName,
                slug: color.slug || '',
                imageUrls: color.imageUrls || [],
              },
            });
          } catch (err) {
            await logError(`SKU ${color.colorName} (${collectionName}): ${err.message}`);
          }
        }

        if (stats.productsCreated % 5 === 0) {
          await appendLog(pool, job.id,
            `  Phase 2 progress: ${stats.productsCreated} products, ${stats.skusCreated} SKUs`);
        }
      } catch (err) {
        await logError(`Product ${collectionName}: ${err.message}`);
      }
    }

    await appendLog(pool, job.id,
      `Phase 2 products/SKUs created: ${stats.productsCreated} products, ${stats.skusCreated} SKUs, ${stats.imagesAdded} images`);

    // Detail page scraping (part of Phase 2)
    if (detailQueue.length > 0) {
      await appendLog(pool, job.id,
        `Phase 2 detail pages: visiting ${detailQueue.length} color pages for descriptions, specs, images, PDFs...`);
      const detailStats = await scrapeDetailPages(page, pool, job, detailQueue, delayMs, logError);
      stats.descriptionsAdded += detailStats.descriptionsAdded;
      stats.specsAdded += detailStats.specsAdded;
      stats.imagesAdded += detailStats.imagesAdded;
      stats.pdfsAdded += detailStats.pdfsAdded;
      await appendLog(pool, job.id,
        `Phase 2 detail pages done: ${detailStats.pagesVisited} pages, ${detailStats.descriptionsAdded} descriptions, ` +
        `${detailStats.specsAdded} specs, ${detailStats.imagesAdded} images, ${detailStats.pdfsAdded} PDFs`);
    }

    // Close website browser — done with provenzafloors.com
    await browser.close().catch(() => {});
    browser = null;

    // ══════════════════════════════════════════════════
    // Phase 3: GCS Image Backfill
    // ══════════════════════════════════════════════════
    await appendLog(pool, job.id, 'Phase 3: GCS image backfill for SKUs missing primary images...');

    const missingImages = await pool.query(`
      SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, s.internal_sku,
             p.id AS product_id, p.collection
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND p.collection LIKE 'Provenza%'
        AND s.variant_type IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM media_assets ma
          WHERE ma.sku_id = s.id AND ma.asset_type = 'primary'
        )
    `, [vendor_id]);

    let gcsBackfilled = 0;
    for (const row of missingImages.rows) {
      const gcsUrl = await tryGcsImageUrl(
        row.vendor_sku || row.internal_sku, row.variant_name, row.collection
      );
      if (gcsUrl) {
        try {
          await upsertMediaAsset(pool, {
            product_id: row.product_id,
            sku_id: row.sku_id,
            asset_type: 'primary',
            url: gcsUrl,
            original_url: gcsUrl,
            sort_order: 0,
          });
          gcsBackfilled++;
          stats.imagesAdded++;
        } catch (err) {
          await logError(`GCS backfill ${row.internal_sku}: ${err.message}`);
        }
      }
    }

    await appendLog(pool, job.id,
      `Phase 3 complete: ${gcsBackfilled} images backfilled from GCS (${missingImages.rows.length} checked)`);

    // ══════════════════════════════════════════════════
    // Phase 4: DNav Pricing Overlay
    // ══════════════════════════════════════════════════
    await appendLog(pool, job.id, 'Phase 4: DNav pricing overlay...');

    try {
      let dnavBrowser, dnavPage;
      try {
        const session = await triwestLogin(pool, job.id);
        dnavBrowser = session.browser;
        dnavPage = session.page;
        browser = dnavBrowser;
      } catch (loginErr) {
        await appendLog(pool, job.id,
          `  DNav login failed: ${loginErr.message}. Trying cookie fallback...`);
        const cookies = await triwestLoginFromCookies(pool, job.id);
        dnavBrowser = await launchBrowser();
        dnavPage = await dnavBrowser.newPage();
        await dnavPage.setUserAgent(USER_AGENT);
        await dnavPage.setViewport({ width: 1440, height: 900 });
        const cookiePairs = cookies.split('; ').map(pair => {
          const [name, ...rest] = pair.split('=');
          return { name, value: rest.join('='), domain: 'tri400.triwestltd.com' };
        });
        await dnavPage.setCookie(...cookiePairs);
        await dnavPage.goto(`${PORTAL_BASE}/main/`, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(3000);
        browser = dnavBrowser;
      }

      const dnavRows = await searchByManufacturer(dnavPage, 'PRO', pool, job.id, { maxRows: 5000 });
      await appendLog(pool, job.id, `  DNav returned ${dnavRows.length} rows for PRO`);

      if (dnavRows.length > 0) {
        // Load all website-created flooring SKUs for matching
        const websiteSkus = await pool.query(`
          SELECT s.id AS sku_id, s.internal_sku, s.variant_name,
                 p.id AS product_id, p.collection, p.name AS product_name
          FROM skus s
          JOIN products p ON p.id = s.product_id
          WHERE p.vendor_id = $1 AND p.collection LIKE 'Provenza%'
            AND s.variant_type IS NULL
        `, [vendor_id]);

        // Build lookup: collection → Map<normalizedColor, { sku_id, product_id }>
        const skuLookup = new Map();
        for (const row of websiteSkus.rows) {
          const coll = (row.collection || '').replace(/^Provenza\s*[-\u2013\u2014]\s*/i, '').trim();
          if (!skuLookup.has(coll)) skuLookup.set(coll, new Map());
          const normColor = normalizeColor(row.variant_name);
          if (normColor) {
            skuLookup.get(coll).set(normColor, {
              sku_id: row.sku_id,
              product_id: row.product_id,
            });
          }
        }

        // Classify DNav rows
        const flooringRows = [];
        const accessoryRows = [];
        for (const row of dnavRows) {
          if (isDnavAccessory(row)) {
            accessoryRows.push(row);
          } else {
            flooringRows.push(row);
          }
        }

        await appendLog(pool, job.id,
          `  DNav classified: ${flooringRows.length} flooring, ${accessoryRows.length} accessories`);

        // Match flooring rows to website SKUs and overlay pricing
        for (const row of flooringRows) {
          const dnavColl = dnavToCollection(row.pattern, row);
          if (!dnavColl) continue;

          const collMap = skuLookup.get(dnavColl);
          if (!collMap) continue;

          const normColor = normalizeColor(titleCase(row.color));
          if (!normColor) continue;

          // Exact match first
          let match = collMap.get(normColor);

          // Fuzzy match within collection
          if (!match) {
            let bestScore = 0;
            let bestEntry = null;
            for (const [key, entry] of collMap) {
              const score = fuzzyMatch(normColor, key);
              if (score > bestScore && score >= 0.8) {
                bestScore = score;
                bestEntry = entry;
              }
            }
            if (bestEntry) match = bestEntry;
          }

          if (match) {
            try {
              // Update vendor_sku on the SKU (DNav item number is authoritative)
              await pool.query(`
                UPDATE skus SET vendor_sku = $2, updated_at = CURRENT_TIMESTAMP
                WHERE id = $1 AND (vendor_sku IS NULL OR vendor_sku = '')
              `, [match.sku_id, row.itemNumber]);

              // Upsert pricing: cost × markup = retail
              if (row.sqftPrice) {
                await upsertPricing(pool, match.sku_id, {
                  cost: row.sqftPrice,
                  retail_price: parseFloat((row.sqftPrice * retailMarkup).toFixed(2)),
                  price_basis: 'per_sqft',
                }, { jobId: job.id });
              }

              // Upsert packaging
              if (row.sqftPerBox) {
                await upsertPackaging(pool, match.sku_id, {
                  sqft_per_box: row.sqftPerBox,
                }, { jobId: job.id });
              }

              // Size attribute from DNav
              if (row.size) {
                await upsertSkuAttribute(pool, match.sku_id, 'size', row.size);
              }

              stats.dnavMatched++;
            } catch (err) {
              await logError(`DNav match ${row.itemNumber}: ${err.message}`);
            }
          }
        }

        await appendLog(pool, job.id,
          `  DNav flooring matched: ${stats.dnavMatched}/${flooringRows.length}`);

        // Create accessory products + SKUs from DNav
        if (accessoryRows.length > 0) {
          const accessoryGroups = new Map();
          for (const row of accessoryRows) {
            const collection = dnavToCollection(row.pattern, row) || 'Provenza';
            const accType = normalizeAccessoryType(row);
            const key = `${collection}|||${accType}`;
            if (!accessoryGroups.has(key)) {
              accessoryGroups.set(key, { collection, accessoryType: accType, rows: [] });
            }
            accessoryGroups.get(key).rows.push(row);
          }

          for (const [, group] of accessoryGroups) {
            try {
              const collectionDisplay = `${brandPrefix} - ${group.collection}`;
              const productName = `${group.collection} ${group.accessoryType}`;

              // Determine category from the parent collection
              const parentCategory = Object.entries(COLLECTIONS_BY_CATEGORY)
                .find(([, colls]) => colls.includes(group.collection));
              const categorySlug = CATEGORY_SLUG_MAP[parentCategory?.[0] || 'hardwood'] || 'engineered-hardwood';

              const product = await upsertProduct(pool, {
                vendor_id,
                name: productName,
                collection: collectionDisplay,
                category_id: categoryCache.get(categorySlug) || null,
              }, { jobId: job.id });

              stats.dnavAccessoryProducts++;

              for (const row of group.rows) {
                try {
                  const internalSku = `TW-${row.itemNumber}`;
                  const colorName = titleCase(row.color);

                  const sku = await upsertSku(pool, {
                    product_id: product.id,
                    vendor_sku: row.itemNumber,
                    internal_sku: internalSku,
                    variant_name: colorName,
                    sell_by: 'unit',
                    variant_type: 'accessory',
                  }, { jobId: job.id });

                  stats.dnavAccessorySkus++;

                  // Accessory pricing (per unit, carton price as cost)
                  const cost = row.cartonPrice || row.sqftPrice || null;
                  if (cost) {
                    await upsertPricing(pool, sku.id, {
                      cost,
                      retail_price: parseFloat((cost * retailMarkup).toFixed(2)),
                      price_basis: 'per_unit',
                    }, { jobId: job.id });
                  }

                  // Attributes
                  if (colorName) await upsertSkuAttribute(pool, sku.id, 'color', colorName);
                  await upsertSkuAttribute(pool, sku.id, 'brand', brandPrefix);
                  if (group.collection) await upsertSkuAttribute(pool, sku.id, 'collection', group.collection);
                } catch (err) {
                  await logError(`Accessory SKU ${row.itemNumber}: ${err.message}`);
                }
              }
            } catch (err) {
              await logError(`Accessory product ${group.collection} ${group.accessoryType}: ${err.message}`);
            }
          }

          await appendLog(pool, job.id,
            `  DNav accessories: ${stats.dnavAccessoryProducts} products, ${stats.dnavAccessorySkus} SKUs`);
        }
      }

      // Close DNav browser
      await dnavBrowser.close().catch(() => {});
      browser = null;
    } catch (err) {
      await appendLog(pool, job.id,
        `Phase 4 DNav failed: ${err.message}. Continuing with price propagation.`);
      if (browser) { await browser.close().catch(() => {}); browser = null; }
    }

    // ══════════════════════════════════════════════════
    // Phase 5: Collection-Level Price Propagation
    // ══════════════════════════════════════════════════
    await appendLog(pool, job.id, 'Phase 5: Price propagation for unpriced SKUs...');

    // Find flooring SKUs without pricing
    const unpricedResult = await pool.query(`
      SELECT s.id AS sku_id, p.collection, p.category_id
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND p.collection LIKE 'Provenza%'
        AND s.variant_type IS NULL
        AND NOT EXISTS (SELECT 1 FROM pricing pr WHERE pr.sku_id = s.id)
    `, [vendor_id]);

    if (unpricedResult.rows.length > 0) {
      // Get average prices AND packaging by collection from priced siblings
      const collectionPrices = await pool.query(`
        SELECT p.collection, AVG(pr.retail_price) AS avg_retail, AVG(pr.cost) AS avg_cost
        FROM pricing pr
        JOIN skus s ON s.id = pr.sku_id
        JOIN products p ON p.id = s.product_id
        WHERE p.vendor_id = $1 AND p.collection LIKE 'Provenza%'
          AND s.variant_type IS NULL AND pr.retail_price > 0
        GROUP BY p.collection
      `, [vendor_id]);

      const collectionPackaging = await pool.query(`
        SELECT p.collection, pkg.sqft_per_box
        FROM packaging pkg
        JOIN skus s ON s.id = pkg.sku_id
        JOIN products p ON p.id = s.product_id
        WHERE p.vendor_id = $1 AND p.collection LIKE 'Provenza%'
          AND s.variant_type IS NULL AND pkg.sqft_per_box > 0
        GROUP BY p.collection, pkg.sqft_per_box
      `, [vendor_id]);

      const collPriceMap = new Map();
      for (const row of collectionPrices.rows) {
        collPriceMap.set(row.collection, {
          avgRetail: parseFloat(parseFloat(row.avg_retail).toFixed(2)),
          avgCost: parseFloat(parseFloat(row.avg_cost).toFixed(2)),
        });
      }

      const collPackMap = new Map();
      for (const row of collectionPackaging.rows) {
        if (!collPackMap.has(row.collection)) {
          collPackMap.set(row.collection, parseFloat(row.sqft_per_box));
        }
      }

      // Build category slug lookup for defaults
      const categorySlugMap = new Map();
      const catResult = await pool.query(
        `SELECT id, slug FROM categories WHERE slug IN ('engineered-hardwood', 'lvp-plank', 'laminate')`
      );
      for (const row of catResult.rows) categorySlugMap.set(row.id, row.slug);

      for (const row of unpricedResult.rows) {
        try {
          let price = collPriceMap.get(row.collection);

          if (!price) {
            // Fall back to category default
            const catSlug = categorySlugMap.get(row.category_id) || 'engineered-hardwood';
            const defaultRetail = DEFAULT_PRICES[catSlug] || DEFAULT_PRICES['engineered-hardwood'];
            price = {
              avgRetail: defaultRetail,
              avgCost: parseFloat((defaultRetail / retailMarkup).toFixed(2)),
            };
          }

          await upsertPricing(pool, row.sku_id, {
            cost: price.avgCost,
            retail_price: price.avgRetail,
            price_basis: 'per_sqft',
          }, { jobId: job.id });

          // Propagate packaging (sqft_per_box) from same-collection sibling
          const packSqft = collPackMap.get(row.collection);
          if (packSqft) {
            await upsertPackaging(pool, row.sku_id, {
              sqft_per_box: packSqft,
            }, { jobId: job.id });
          }

          stats.pricesPropagated++;
        } catch (err) {
          await logError(`Price propagation SKU ${row.sku_id}: ${err.message}`);
        }
      }
    }

    await appendLog(pool, job.id,
      `Phase 5 complete: ${stats.pricesPropagated} SKUs priced via propagation ` +
      `(${unpricedResult.rows.length} unpriced found)`);

    // ══════════════════════════════════════════════════
    // Phase 6: Activation + Cleanup
    // ══════════════════════════════════════════════════
    await appendLog(pool, job.id, 'Phase 6: Activation and cleanup...');

    // Activate products that have at least one SKU with primary image + pricing
    const activateResult = await pool.query(`
      UPDATE products SET status = 'active', is_active = true, updated_at = CURRENT_TIMESTAMP
      WHERE vendor_id = $1 AND collection LIKE 'Provenza%'
        AND status != 'active'
        AND EXISTS (
          SELECT 1 FROM skus s
          WHERE s.product_id = products.id
          AND EXISTS (SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id AND ma.asset_type = 'primary')
          AND EXISTS (SELECT 1 FROM pricing pr WHERE pr.sku_id = s.id AND pr.retail_price > 0)
        )
      RETURNING id
    `, [vendor_id]);

    // Activate SKUs that have pricing (images are at SKU level from Phase 2)
    const activateSkuResult = await pool.query(`
      UPDATE skus SET status = 'active', updated_at = CURRENT_TIMESTAMP
      FROM products p
      WHERE skus.product_id = p.id
        AND p.vendor_id = $1 AND p.collection LIKE 'Provenza%'
        AND p.is_active = true
        AND skus.status != 'active'
        AND EXISTS (SELECT 1 FROM pricing pr WHERE pr.sku_id = skus.id AND pr.retail_price > 0)
    `, [vendor_id]);

    stats.activated = activateResult.rowCount;

    // Deactivate orphan products (active but no active SKUs)
    const deactivateResult = await pool.query(`
      UPDATE products SET status = 'inactive', is_active = false, updated_at = CURRENT_TIMESTAMP
      WHERE vendor_id = $1 AND collection LIKE 'Provenza%'
        AND is_active = true
        AND NOT EXISTS (
          SELECT 1 FROM skus s WHERE s.product_id = products.id AND s.status = 'active'
        )
      RETURNING id
    `, [vendor_id]);

    // Quality summary
    const qualityCheck = await pool.query(`
      SELECT
        COUNT(DISTINCT p.id) AS total_products,
        COUNT(DISTINCT s.id) AS total_skus,
        COUNT(DISTINCT CASE WHEN ma.sku_id IS NOT NULL THEN s.id END) AS skus_with_images,
        COUNT(DISTINCT CASE WHEN pr.sku_id IS NOT NULL THEN s.id END) AS skus_with_pricing,
        COUNT(DISTINCT CASE WHEN p.is_active THEN p.id END) AS active_products,
        COUNT(DISTINCT CASE WHEN s.status = 'active' THEN s.id END) AS active_skus
      FROM products p
      LEFT JOIN skus s ON s.product_id = p.id
      LEFT JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
      LEFT JOIN pricing pr ON pr.sku_id = s.id AND pr.retail_price > 0
      WHERE p.vendor_id = $1 AND p.collection LIKE 'Provenza%'
    `, [vendor_id]);

    const q = qualityCheck.rows[0];
    const imgCoverage = q.total_skus > 0
      ? Math.round(q.skus_with_images / q.total_skus * 100) : 0;
    const priceCoverage = q.total_skus > 0
      ? Math.round(q.skus_with_pricing / q.total_skus * 100) : 0;

    await appendLog(pool, job.id,
      `Phase 6 complete: ${activateResult.rowCount} products activated, ` +
      `${activateSkuResult.rowCount} SKUs activated, ${deactivateResult.rowCount} orphans deactivated`);

    await appendLog(pool, job.id,
      `Quality: ${q.total_products} products, ${q.total_skus} SKUs, ` +
      `${imgCoverage}% image coverage, ${priceCoverage}% pricing coverage, ` +
      `${q.active_products} active products, ${q.active_skus} active SKUs`,
      {
        products_found: parseInt(q.total_products),
        products_created: stats.productsCreated,
        products_updated: stats.activated,
        skus_created: stats.skusCreated,
      }
    );

    await appendLog(pool, job.id,
      `Complete. Created: ${stats.productsCreated} products + ${stats.skusCreated} flooring SKUs. ` +
      `DNav: ${stats.dnavMatched} priced, ${stats.dnavAccessoryProducts} accessory products ` +
      `(${stats.dnavAccessorySkus} SKUs). Propagated: ${stats.pricesPropagated} prices. ` +
      `Images: ${stats.imagesAdded}. Errors: ${errorCount}`
    );

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ──────────────────────────────────────────────
// Phase 1: Build website catalog
// ──────────────────────────────────────────────

/**
 * Scrape all known collection pages on provenzafloors.com.
 * Uses Angular scope data (AngularJS app) for reliable extraction.
 *
 * Returns Map<collectionName, { category, colors: colorEntry[] }>
 * where colorEntry = { colorName, normColor, slug, imageUrls[], species, finish }
 */
async function buildCatalog(page, pool, job, delayMs) {
  const catalog = new Map();
  let totalPages = 0;

  for (const [category, collections] of Object.entries(COLLECTIONS_BY_CATEGORY)) {
    for (const collection of collections) {
      try {
        const url = `${BASE_URL}/${category}?collection=${encodeURIComponent(collection)}`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(3000);

        // Wait for Angular to render tiles
        await page.waitForSelector('div.product.clearfix', { timeout: 10000 }).catch(() => null);
        await delay(1000);

        // Extract tile data from Angular scope (reliable, not dependent on CSS selectors)
        const products = await page.evaluate(() => {
          const results = [];
          const seen = new Set();

          const cards = document.querySelectorAll('div.product.clearfix');

          // Primary strategy: read Angular scope data from product cards
          if (typeof angular !== 'undefined' && cards.length > 0) {
            const scope = angular.element(cards[0]).scope();
            const tiles = scope?.tiles || [];
            for (const tile of tiles) {
              if (!tile.active) continue;
              const color = (tile.color || '').trim();
              const imgUrl = (tile.imageUrl || '').trim();
              // Capture slug/URL for detail page navigation
              const slug = (tile.slug || tile.colorSlug || tile.seo || tile.url || '').trim();
              // Capture all available images from the tile object
              const allImages = [];
              if (imgUrl) allImages.push(imgUrl);
              if (Array.isArray(tile.images)) {
                for (const img of tile.images) {
                  const u = typeof img === 'string' ? img : (img.url || img.src || img.imageUrl || '');
                  if (u && !allImages.includes(u)) allImages.push(u);
                }
              }
              // Extract additional tile metadata
              const species = tile.species || (tile.specieMap && typeof tile.specieMap === 'object'
                ? Object.values(tile.specieMap).flat().join(', ') : '') || '';
              const finish = Array.isArray(tile.finishes)
                ? tile.finishes.join(', ') : (tile.finishes || tile.finish || '');

              if (color && imgUrl && !seen.has(color.toLowerCase())) {
                seen.add(color.toLowerCase());
                results.push({ colorName: color, imageUrl: imgUrl, slug, allImages, species, finish });
              }
            }
          }

          // Fallback: extract from DOM if Angular scope unavailable
          if (results.length === 0) {
            for (const card of cards) {
              const img = card.querySelector('img.product-image');
              if (!img) continue;
              const src = img.currentSrc || img.src || '';
              const nameEl = card.querySelector('a.ng-binding') || card.querySelector('h3, h4');
              const name = (nameEl?.textContent || img.alt || '').trim();
              const href = card.querySelector('a')?.getAttribute('href') || '';
              if (src && name && !seen.has(name.toLowerCase())) {
                seen.add(name.toLowerCase());
                results.push({ colorName: name, imageUrl: src, slug: href, allImages: [src], species: '', finish: '' });
              }
            }
          }

          return results;
        });

        if (!catalog.has(collection)) {
          catalog.set(collection, { category, colors: [] });
        }
        const existingColors = new Set(
          catalog.get(collection).colors.map(c => c.normColor)
        );

        for (const product of products) {
          const normalized = normalizeColor(product.colorName);
          if (!normalized || normalized.length < 2) continue;
          if (existingColors.has(normalized)) continue;
          existingColors.add(normalized);

          catalog.get(collection).colors.push({
            colorName: product.colorName,
            normColor: normalized,
            slug: product.slug || '',
            imageUrls: product.allImages.length > 0 ? product.allImages : [product.imageUrl],
            species: product.species || '',
            finish: product.finish || '',
          });
        }

        totalPages++;
        if (products.length > 0) {
          await appendLog(pool, job.id,
            `  ${category}/${collection}: ${products.length} colors found`);
        }
      } catch (err) {
        await appendLog(pool, job.id,
          `  Warning: failed to load ${category}/${collection}: ${err.message}`);
      }

      await delay(delayMs);
    }
  }

  await appendLog(pool, job.id, `Scraped ${totalPages} collection pages`);
  return catalog;
}

// ──────────────────────────────────────────────
// Detail page scraping (Phase 2 continuation)
// ──────────────────────────────────────────────

/**
 * Scrape individual color detail pages on provenzafloors.com.
 * Extracts descriptions, spec attributes, alternate/lifestyle images, and spec PDFs.
 *
 * @param {import('puppeteer').Page} page
 * @param {import('pg').Pool} pool
 * @param {object} job
 * @param {Array} matchedSkus - Array of { sku_id, product_id, catalogKey, catalogEntry }
 * @param {number} delayMs
 * @param {Function} logError
 * @returns {Promise<object>} Stats
 */
async function scrapeDetailPages(page, pool, job, matchedSkus, delayMs, logError) {
  const stats = { pagesVisited: 0, descriptionsAdded: 0, specsAdded: 0, imagesAdded: 0, pdfsAdded: 0 };

  // Group matched SKUs by catalog entry to avoid visiting the same detail page twice
  const detailQueue = new Map(); // catalogKey → { entry, skus: [{ sku_id, product_id }] }
  for (const match of matchedSkus) {
    if (!detailQueue.has(match.catalogKey)) {
      detailQueue.set(match.catalogKey, { entry: match.catalogEntry, skus: [] });
    }
    detailQueue.get(match.catalogKey).skus.push({ sku_id: match.sku_id, product_id: match.product_id });
  }

  await appendLog(pool, job.id,
    `  Detail pages: ${detailQueue.size} unique colors to visit across ${matchedSkus.length} SKUs`);

  let visited = 0;

  for (const [, { entry, skus }] of detailQueue) {
    try {
      const detailData = await navigateAndExtractDetail(page, entry);
      stats.pagesVisited++;
      visited++;

      if (!detailData) {
        if (visited % 20 === 0) {
          await appendLog(pool, job.id, `  Detail progress: ${visited}/${detailQueue.size} pages`);
        }
        await delay(delayMs);
        continue;
      }

      // Get unique product IDs from matched SKUs
      const productIds = [...new Set(skus.map(s => s.product_id))];

      // ── Upsert description at product level ──
      if (detailData.description && detailData.description.length > 20) {
        for (const pid of productIds) {
          const descShort = detailData.description.length > 300
            ? detailData.description.slice(0, 297) + '...'
            : detailData.description;
          await pool.query(`
            UPDATE products SET
              description_short = COALESCE(description_short, $2),
              description_long = COALESCE(description_long, $3),
              updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
          `, [pid, descShort, detailData.description]);
          stats.descriptionsAdded++;
        }
      }

      // ── Upsert spec attributes for all matching SKUs ──
      if (Object.keys(detailData.specs).length > 0) {
        for (const sku of skus) {
          for (const [label, value] of Object.entries(detailData.specs)) {
            const slug = SPEC_LABEL_MAP[label];
            if (slug && value) {
              try {
                await upsertSkuAttribute(pool, sku.sku_id, slug, value);
                stats.specsAdded++;
              } catch (err) {
                await logError(`Spec attr ${slug} for SKU ${sku.sku_id}: ${err.message}`);
              }
            }
          }
        }
      }

      // ── Upsert alternate/lifestyle images for all matching SKUs ──
      if (detailData.images.length > 1) {
        // Filter out images belonging to OTHER colors in the same collection
        const siblingColors = [];
        for (const [, item] of detailQueue) {
          if (item.entry.collection === entry.collection && item.entry.colorName !== entry.colorName) {
            siblingColors.push(item.entry.colorName);
          }
        }

        const { matched, shared } = filterImagesByVariant(
          detailData.images,
          entry.colorName,
          { otherColors: siblingColors, productName: entry.collection }
        );

        // Prefer matched (contain this color's name), then shared (neutral/generic)
        const candidates = [...matched, ...shared];
        const filtered = filterImageUrls(candidates, { maxImages: 8 });
        const sorted = preferProductShot(filtered, entry.colorName);

        for (const sku of skus) {
          // Skip index 0 — primary already set in Phase 2
          for (let i = 1; i < sorted.length; i++) {
            const assetType = i <= 2 ? 'alternate' : 'lifestyle';
            try {
              await upsertMediaAsset(pool, {
                product_id: sku.product_id,
                sku_id: sku.sku_id,
                asset_type: assetType,
                url: sorted[i],
                original_url: sorted[i],
                sort_order: i,
              });
              stats.imagesAdded++;
            } catch (err) {
              await logError(`Image for SKU ${sku.sku_id}: ${err.message}`);
            }
          }
        }
      }

      // ── Upsert spec PDFs at product level ──
      if (detailData.pdfs && detailData.pdfs.length > 0) {
        for (const pid of productIds) {
          for (let i = 0; i < detailData.pdfs.length; i++) {
            try {
              await upsertMediaAsset(pool, {
                product_id: pid,
                sku_id: null,
                asset_type: 'spec_pdf',
                url: detailData.pdfs[i].url,
                original_url: detailData.pdfs[i].url,
                sort_order: i,
              });
              stats.pdfsAdded++;
            } catch (err) {
              await logError(`PDF for product ${pid}: ${err.message}`);
            }
          }
        }
      }

      if (visited % 20 === 0) {
        await appendLog(pool, job.id,
          `  Detail progress: ${visited}/${detailQueue.size} (${stats.specsAdded} specs, ${stats.imagesAdded} imgs, ${stats.pdfsAdded} PDFs)`);
      }
    } catch (err) {
      await logError(`Detail page ${entry.colorName} (${entry.collection}): ${err.message}`);
    }

    await delay(delayMs + 1000); // Extra delay between detail pages to avoid rate limiting
  }

  return stats;
}

/**
 * Navigate to a color's detail page and extract data.
 * Tries multiple strategies: direct slug URL, conventional URL pattern,
 * then falling back to clicking tile on the collection page.
 *
 * @param {import('puppeteer').Page} page
 * @param {object} entry - Catalog entry { collection, category, colorName, slug, imageUrls }
 * @returns {Promise<object|null>} { description, specs, images, pdfs } or null
 */
async function navigateAndExtractDetail(page, entry) {
  const { collection, category, colorName, slug } = entry;

  // Strategy 1: Direct URL using slug from Angular scope (e.g., "/hardwood/affinity/acclaim")
  if (slug && slug.startsWith('/')) {
    try {
      const directUrl = slug.startsWith('http') ? slug : `${BASE_URL}${slug}`;
      await page.goto(directUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      await delay(2000);
      const data = await extractDetailData(page);
      if (data && (data.description || Object.keys(data.specs).length > 0 || data.images.length > 1)) {
        data.pdfs = await extractSpecPDFs(page);
        return data;
      }
    } catch { /* fall through to next strategy */ }
  }

  // Strategy 2: Conventional URL pattern /{category}/{collection-slug}/{color-slug}
  const collSlug = collection.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const colorSlug = colorName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  try {
    const detailUrl = `${BASE_URL}/${category}/${collSlug}/${colorSlug}`;
    const resp = await page.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(2000);
    if (resp && resp.status() === 200) {
      const data = await extractDetailData(page);
      if (data && (data.description || Object.keys(data.specs).length > 0 || data.images.length > 1)) {
        data.pdfs = await extractSpecPDFs(page);
        return data;
      }
    }
  } catch { /* fall through */ }

  // Strategy 3: Navigate to collection page and click the color tile
  try {
    const collUrl = `${BASE_URL}/${category}?collection=${encodeURIComponent(collection)}`;
    await page.goto(collUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(3000);
    await page.waitForSelector('div.product.clearfix', { timeout: 10000 }).catch(() => null);
    await delay(1000);

    const clicked = await page.evaluate((targetColor) => {
      const colorLower = targetColor.toLowerCase();
      const cards = document.querySelectorAll('div.product.clearfix');

      // Try Angular scope: click the tile matching this color
      if (typeof angular !== 'undefined' && cards.length > 0) {
        for (const card of cards) {
          const nameEl = card.querySelector('a.ng-binding') || card.querySelector('h3, h4');
          if (nameEl && nameEl.textContent.trim().toLowerCase() === colorLower) {
            const link = card.querySelector('a[href]');
            if (link) { link.click(); return true; }
          }
        }
        // Fallback: match by img alt text
        for (const card of cards) {
          const img = card.querySelector('img');
          if (img && (img.alt || '').trim().toLowerCase() === colorLower) {
            const link = card.querySelector('a[href]') || card;
            link.click();
            return true;
          }
        }
      }

      // Fallback: click by text content match
      for (const card of cards) {
        const text = card.textContent.trim().toLowerCase();
        if (text.includes(colorLower)) {
          const link = card.querySelector('a[href]');
          if (link) { link.click(); return true; }
        }
      }

      return false;
    }, colorName);

    if (clicked) {
      await delay(3000);
      // Wait for detail view to render (Angular route change or page load)
      await page.waitForFunction(() => {
        return document.querySelector(
          '.product-detail, .color-detail, .product-specs, .specifications, ' +
          '.product-description, dl, .spec-table, .tech-specs'
        );
      }, { timeout: 8000 }).catch(() => null);
      await delay(1000);

      const data = await extractDetailData(page);
      if (data && (data.description || Object.keys(data.specs).length > 0 || data.images.length > 1)) {
        data.pdfs = await extractSpecPDFs(page);
        return data;
      }
    }
  } catch { /* exhausted all strategies */ }

  return null;
}

/**
 * Extract detail data (description, specs, images) from the current page.
 * Tries multiple DOM patterns and Angular scope paths for robustness.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<{ description: string, specs: object, images: string[] }>}
 */
async function extractDetailData(page) {
  return page.evaluate(() => {
    const result = { description: '', specs: {}, images: [] };

    // ── Description ──
    const descSelectors = [
      '.product-description', '.description', '.product-detail-description',
      '[ng-bind-html*="description"]', '.overview', '.product-overview',
      '.detail-text', '.product-info p', '.about-product', '.product-about',
    ];
    for (const sel of descSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 20) {
        result.description = el.textContent.trim();
        break;
      }
    }

    // Try Angular scope for description
    if (!result.description && typeof angular !== 'undefined') {
      const scopeEl = document.querySelector('[ng-controller]') ||
                       document.querySelector('[ng-app]') ||
                       document.querySelector('.product-detail');
      if (scopeEl) {
        try {
          const scope = angular.element(scopeEl).scope();
          if (scope) {
            const candidates = [
              scope.product?.description, scope.selectedProduct?.description,
              scope.color?.description, scope.detail?.description,
              scope.product?.longDescription, scope.selectedColor?.description,
              scope.tileDetail?.description,
            ];
            for (const c of candidates) {
              if (c && c.length > 20) { result.description = c; break; }
            }
          }
        } catch { /* scope access failed */ }
      }
    }

    // ── Specs ──
    // Strategy A: table rows
    const tableSelectors = [
      '.specs tr', '.product-specs tr', '.specifications tr',
      '.tech-specs tr', '.product-details tr', '.detail-specs tr',
      '.spec-table tr', '.features tr',
    ];
    for (const sel of tableSelectors) {
      const rows = document.querySelectorAll(sel);
      for (const row of rows) {
        const cells = row.querySelectorAll('td, th');
        if (cells.length >= 2) {
          const label = cells[0].textContent.trim();
          const value = cells[1].textContent.trim();
          if (label && value && label.length < 50) {
            result.specs[label.toLowerCase().replace(/[:\s]+$/g, '')] = value;
          }
        }
      }
      if (Object.keys(result.specs).length > 0) break;
    }

    // Strategy B: definition list (dl/dt/dd)
    if (Object.keys(result.specs).length === 0) {
      for (const dt of document.querySelectorAll('dt')) {
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === 'DD') {
          const label = dt.textContent.trim();
          const value = dd.textContent.trim();
          if (label && value && label.length < 50) {
            result.specs[label.toLowerCase().replace(/[:\s]+$/g, '')] = value;
          }
        }
      }
    }

    // Strategy C: labeled spans/divs (.label + .value pairs)
    if (Object.keys(result.specs).length === 0) {
      const labelEls = document.querySelectorAll('.label, .spec-label, .attr-label, .spec-name');
      for (const labelEl of labelEls) {
        const valueEl = labelEl.nextElementSibling;
        if (valueEl) {
          const label = labelEl.textContent.trim();
          const value = valueEl.textContent.trim();
          if (label && value && label.length < 50) {
            result.specs[label.toLowerCase().replace(/[:\s]+$/g, '')] = value;
          }
        }
      }
    }

    // Strategy D: Angular scope for specs (including tileDetail)
    if (Object.keys(result.specs).length === 0 && typeof angular !== 'undefined') {
      const scopeEl = document.querySelector('[ng-controller]') ||
                       document.querySelector('[ng-app]') ||
                       document.querySelector('.product-detail');
      if (scopeEl) {
        try {
          const scope = angular.element(scopeEl).scope();
          if (scope) {
            const specSources = [
              scope.specs, scope.product?.specs, scope.selectedProduct?.specs,
              scope.color?.specs, scope.attributes, scope.product?.attributes,
              scope.selectedColor?.specs, scope.detail?.specs,
              scope.tileDetail, scope.tileDetail?.specs,
            ];
            for (const specData of specSources) {
              if (specData && typeof specData === 'object') {
                if (Array.isArray(specData)) {
                  for (const item of specData) {
                    const lbl = item.label || item.name || item.key || '';
                    const val = item.value != null ? String(item.value) : '';
                    if (lbl && val) result.specs[lbl.toLowerCase()] = val;
                  }
                } else {
                  for (const [k, v] of Object.entries(specData)) {
                    if (v != null) {
                      result.specs[k.toLowerCase()] = typeof v === 'string' ? v : (v.value || String(v));
                    }
                  }
                }
                if (Object.keys(result.specs).length > 0) break;
              }
            }
          }
        } catch { /* scope access failed */ }
      }
    }

    // ── Images ──
    const imgSelectors = [
      '.product-detail img', '.gallery img', '.product-gallery img',
      '.slider img', '.swiper img', '.carousel img', '.product-images img',
      '.detail-images img', '.product-slider img', '.color-detail img',
    ];
    const seen = new Set();
    for (const sel of imgSelectors) {
      for (const img of document.querySelectorAll(sel)) {
        if (!img.complete || img.naturalHeight < 100) continue;
        const src = img.currentSrc || img.src || img.dataset?.src || '';
        if (src && src.startsWith('http') && !seen.has(src.split('?')[0])) {
          seen.add(src.split('?')[0]);
          result.images.push(src);
        }
      }
    }

    // Broader image search if targeted selectors found nothing
    if (result.images.length === 0) {
      const EXCLUDE = ['logo', 'icon', 'favicon', 'social', 'sprite', 'pixel', 'tracking', 'nav', 'footer', 'header'];
      for (const img of document.querySelectorAll('img')) {
        if (!img.complete || img.naturalWidth < 200 || img.naturalHeight < 200) continue;
        const src = img.currentSrc || img.src || '';
        if (!src || !src.startsWith('http')) continue;
        const lower = src.toLowerCase();
        if (EXCLUDE.some(p => lower.includes(p))) continue;
        if (!seen.has(src.split('?')[0])) {
          seen.add(src.split('?')[0]);
          result.images.push(src);
        }
      }
    }

    // Angular scope image arrays
    if (typeof angular !== 'undefined') {
      const scopeEl = document.querySelector('[ng-controller]') ||
                       document.querySelector('[ng-app]') ||
                       document.querySelector('.product-detail');
      if (scopeEl) {
        try {
          const scope = angular.element(scopeEl).scope();
          if (scope) {
            const imgSources = [
              scope.images, scope.product?.images, scope.selectedProduct?.images,
              scope.gallery, scope.color?.images, scope.selectedColor?.images,
            ];
            for (const imgs of imgSources) {
              if (Array.isArray(imgs) && imgs.length > 0) {
                for (const img of imgs) {
                  const url = typeof img === 'string' ? img : (img.url || img.src || img.imageUrl || '');
                  if (url && url.startsWith('http') && !seen.has(url.split('?')[0])) {
                    seen.add(url.split('?')[0]);
                    result.images.push(url);
                  }
                }
                break;
              }
            }
          }
        } catch { /* scope access failed */ }
      }
    }

    return result;
  });
}

// ──────────────────────────────────────────────
// Utility functions
// ──────────────────────────────────────────────

/**
 * Extract the Provenza collection name from TW data.
 * Uses COLLECTION_MAP to translate TW's uppercase collection names.
 */
function extractCollectionName(group) {
  const raw = (group.collection || '').replace(/^Provenza\s*[-\u2013\u2014]\s*/i, '').trim();
  if (!raw || raw.toLowerCase() === 'provenza') return null;

  // Direct map lookup
  const mapped = COLLECTION_MAP[raw.toUpperCase()];
  if (mapped) return mapped;

  // Fuzzy lookup — try to match against known collections
  const upper = raw.toUpperCase();
  for (const [key, val] of Object.entries(COLLECTION_MAP)) {
    if (upper.includes(key) || key.includes(upper)) return val;
  }

  return null;
}

/**
 * Normalize a color name for catalog lookup.
 * Lowercase, strip wood species suffixes, collapse whitespace.
 */
function normalizeColor(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/\s*[-\u2013\u2014]\s*(white oak|european oak|maple|hickory|walnut|acacia|oak)\s*$/i, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ──────────────────────────────────────────────
// GCS URL construction (fallback for Angular scraping)
// ──────────────────────────────────────────────

const GCS_BASE = 'https://storage.googleapis.com/provenza-web/images/products';

/** Collection → GCS URL config */
const GCS_CONFIG = {
  'Affinity':          { cat: 'hardwood', slug: 'affinity',          prefix: 'Affinity',          skuMode: 'full' },
  'African Plains':    { cat: 'hardwood', slug: 'africanplains',     prefix: 'AfricanPlains',     skuMode: 'full' },
  'Antico':            { cat: 'hardwood', slug: 'antico',            prefix: 'Antico',            skuMode: 'full' },
  'Cadeau':            { cat: 'hardwood', slug: 'cadeau',            prefix: 'Cadeau',            skuMode: 'full' },
  'Dutch Masters':     { cat: 'hardwood', slug: 'dutchmasters',      prefix: 'DutchMasters',      skuMode: 'cdm' },
  'Grand Pompeii':     { cat: 'hardwood', slug: 'grandpompeii',      prefix: 'GrandPompeii',      skuMode: 'full' },
  'Herringbone Reserve':{ cat: 'hardwood', slug: 'herringbonereserve', prefix: 'HerringboneReserve', skuMode: 'full' },
  'Lighthouse Cove':   { cat: 'hardwood', slug: 'lighthousecove',    prefix: 'LighthouseCove',    skuMode: 'full' },
  'Lugano':            { cat: 'hardwood', slug: 'lugano',            prefix: 'Lugano',            skuMode: 'full' },
  'Mateus':            { cat: 'hardwood', slug: 'mateus',            prefix: 'Mateus',            skuMode: 'full' },
  'Modern Rustic':     { cat: 'hardwood', slug: 'modernrustic',      prefix: 'ModernRustic',      skuMode: 'full' },
  'New York Loft':     { cat: 'hardwood', slug: 'newyorkloft',       prefix: 'NewYorkLoft',       skuMode: 'full' },
  'Old World':         { cat: 'hardwood', slug: 'oldworld',          prefix: 'OldWorld',          skuMode: 'full' },
  'Opia':              { cat: 'hardwood', slug: 'opia',              prefix: 'Opia',              skuMode: 'full' },
  'Palais Royale':     { cat: 'hardwood', slug: 'palaisroyale',      prefix: 'PalaisRoyale',      skuMode: 'full' },
  'Pompeii':           { cat: 'hardwood', slug: 'pompeii',           prefix: 'Pompeii',           skuMode: 'full' },
  'Richmond':          { cat: 'hardwood', slug: 'richmond',          prefix: 'Richmond',          skuMode: 'full' },
  'Studio Moderno':    { cat: 'hardwood', slug: 'studiomoderno',     prefix: 'StudioModerno',     skuMode: 'full' },
  'Tresor':            { cat: 'hardwood', slug: 'tresor',            prefix: 'Tresor',            skuMode: 'full' },
  'Vitali':            { cat: 'hardwood', slug: 'vitali',            prefix: 'Vitali',            skuMode: 'full' },
  'Vitali Elite':      { cat: 'hardwood', slug: 'vitalielite',       prefix: 'VitaliElite',       skuMode: 'full' },
  'Volterra':          { cat: 'hardwood', slug: 'volterra',          prefix: 'Volterra',          skuMode: 'full' },
  'Wall Chic':         { cat: 'hardwood', slug: 'wallchic',          prefix: 'WallChic',          skuMode: 'full' },
  'Concorde Oak':      { cat: 'lvp', slug: 'concordeoak',      prefix: 'ConcordeOak',      skuMode: 'numeric', maxcore: true },
  'First Impressions': { cat: 'lvp', slug: 'firstimpressions', prefix: 'FirstImpressions', skuMode: 'numeric', maxcore: true },
  'Moda Living':       { cat: 'lvp', slug: 'modaliving',       prefix: 'ModaLiving',       skuMode: 'numeric', maxcore: true },
  'Moda Living Elite': { cat: 'lvp', slug: 'modalivingelite',  prefix: 'ModaLivingElite',  skuMode: 'numeric', maxcore: true },
  'New Wave':          { cat: 'lvp', slug: 'newwave',          prefix: 'NewWave',          skuMode: 'numeric', maxcore: true },
  'Stonescape':        { cat: 'lvp', slug: 'stonescape',       prefix: 'Stonescape',       skuMode: 'numeric', maxcore: true },
  'Uptown Chic':       { cat: 'lvp', slug: 'uptownchic',       prefix: 'UptownChic',       skuMode: 'numeric', maxcore: true },
  'Modessa':           { cat: 'laminate', slug: 'modessa', prefix: 'Modessa', skuMode: 'numeric', maxcore: true },
};

/** HTTP HEAD check — returns true if URL returns 200 */
function headCheck(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', timeout: 8000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Try to find a GCS image URL for a given SKU by constructing predictable URLs
 * and verifying them with HEAD requests.
 *
 * @returns {string|null} Working image URL or null
 */
async function tryGcsImageUrl(vendorSku, variantName, collectionRaw) {
  const collName = collectionRaw
    .replace(/^Provenza\s*[-\u2013\u2014]\s*/i, '')
    .replace(/\s*\d+(\.\d+)?"?\s*(4mm|6mm|mm)?\s*$/i, '')
    .replace(/\s*\(.*\)\s*$/i, '')
    .replace(/\s*Coll\.?\s*\d*.*$/i, '')
    .replace(/\s*-?Maxcore$/i, '')
    .replace(/\s*Wpf(-Lvp)?$/i, '')
    .replace(/\s*Spc\s*\d*.*$/i, '')
    .trim();

  const config = GCS_CONFIG[collName];
  if (!config) return null;

  // Clean color name from variant_name
  const colorName = (variantName || '')
    .replace(/\s*\d+(\.\d+)?"?\s*[xX\u00d7]\s*\d+(\.\d+)?"?\s*(\(?\w+\)?)?\s*$/i, '')
    .replace(/\s*\d+(\.\d+)?"?[Ww]\s*[xX]?\s*\d+(\.\d+)?"?[Ll]?\s*$/i, '')
    .replace(/\s*\(Laminate\)\s*$/i, '')
    .replace(/\s*\(Wpf\s*$/i, '')
    .replace(/^Dutch Masters\s+/i, '')
    .trim();
  if (!colorName || colorName.length < 2) return null;

  const colorUrl = colorName.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');

  // Build SKU codes to try
  const fullSku = vendorSku;
  const numericSku = vendorSku.replace(/^PRO/i, '');
  const cdmMatch = vendorSku.match(/CMD(?:10|HB)?(\d{2,3})$/i);
  const cdmSku = cdmMatch ? `CDM${cdmMatch[1].padStart(3, '0')}` : null;

  const skuCodes = [];
  if (config.skuMode === 'cdm' && cdmSku) skuCodes.push(cdmSku);
  else if (config.skuMode === 'numeric') { skuCodes.push(numericSku); skuCodes.push(fullSku); }
  else { skuCodes.push(fullSku); skuCodes.push(numericSku); }

  const { cat, slug, prefix, maxcore } = config;
  const suffixes = ['', '-v2', '-fs'];

  for (const sku of skuCodes) {
    for (const suffix of suffixes) {
      const urls = [];
      if (maxcore || cat === 'laminate') {
        urls.push(`${GCS_BASE}/${cat}/${slug}/detail/Provenza-MaxCore-${prefix}-${sku}-${colorUrl}${suffix}.jpg`);
      }
      urls.push(`${GCS_BASE}/${cat}/${slug}/detail/Provenza-${prefix}-${sku}-${colorUrl}${suffix}.jpg`);

      for (const url of urls) {
        if (await headCheck(url)) return url;
      }
    }
  }

  return null;
}
