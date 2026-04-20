import {
  launchBrowser, delay, appendLog, addJobError,
  upsertProduct, upsertSku, upsertPricing, upsertPackaging, upsertSkuAttribute,
} from './base.js';
import { triwestLogin, triwestLoginFromCookies, PORTAL_BASE } from './triwest-auth.js';
import {
  MANUFACTURER_NAMES, MFGR_CATEGORY,
  searchByManufacturer, navigateToSearchForm,
} from './triwest-search.js';

const MAX_ERRORS = 50;

/**
 * Provenza collection name map (uppercase key → canonical display name).
 * Mirrors COLLECTION_MAP from triwest-provenza.js.
 */
const PROVENZA_COLLECTION_MAP = {
  'AFFINITY': 'Affinity',
  'AFRICAN PLAINS': 'African Plains',
  'ANTICO': 'Antico',
  'CADEAU': 'Cadeau',
  'CONCORDE OAK': 'Concorde Oak',
  'DUTCH MASTERS': 'Dutch Masters',
  'EUROPEAN OAK 4MM': 'Dutch Masters',
  'FIRST IMPRESSIONS': 'First Impressions',
  'GRAND POMPEII': 'Grand Pompeii',
  'HERRINGBONE RESERVE': 'Herringbone Reserve',
  'HERRINGBONE CUSTOM': 'Herringbone Custom',
  'LIGHTHOUSE COVE': 'Lighthouse Cove',
  'LUGANO': 'Lugano',
  'MATEUS': 'Mateus',
  'MODA LIVING': 'Moda Living',
  'MODA LIVING ELITE': 'Moda Living Elite',
  'MODERN RUSTIC': 'Modern Rustic',
  'MODESSA': 'Modessa',
  'NEW WAVE': 'New Wave',
  'NEW YORK LOFT': 'New York Loft',
  'NYC LOFT': 'New York Loft',
  'OLD WORLD': 'Old World',
  'OPIA': 'Opia',
  'PALAIS ROYALE': 'Palais Royale',
  'POMPEII': 'Pompeii',
  'RICHMOND': 'Richmond',
  'STONESCAPE': 'Stonescape',
  'STUDIO MODERNO': 'Studio Moderno',
  'TRESOR': 'Tresor',
  'UPTOWN CHIC': 'Uptown Chic',
  'VITALI ELITE': 'Vitali Elite',
  'VITALI': 'Vitali',
  'VOLTERRA': 'Volterra',
  'WALL CHIC': 'Wall Chic',
};

/** Sorted canonical names longest-first for starts-with fallback matching */
const PROVENZA_CANONICAL_NAMES = Object.keys(PROVENZA_COLLECTION_MAP)
  .sort((a, b) => b.length - a.length);

/**
 * Color → Collection reverse map for Provenza.
 * When DNav pattern contains a color name instead of collection name,
 * this maps it back to the canonical collection.
 * Source: provenzafloors.com via fix-provenza-naming.cjs
 */
const PROVENZA_COLORS = {
  // Hardwood
  'Affinity': ['Contour', 'Delight', 'Intrigue', 'Journey', 'Liberation', 'Mellow', 'Silhouette', 'Acclaim', 'Celebration', 'Engage', 'Serenity', 'Legacy', 'Glam', 'Grandeur', 'Charmed', 'Cameo', 'Appeal'],
  'African Plains': ['Raffia', 'Sahara Sun', 'Black River', 'Serengeti'],
  'Antico': ['Auburn', 'Chamboard', 'Heritage', 'Caribou', 'Relic', 'Clay'],
  'Cadeau': ['Aria', 'Cadence', 'Chapelle', 'Dolce', 'Ferro', 'Largo', 'Noir', 'Shimmer', 'Sonata', 'Verdun'],
  'Grand Pompeii': ['Apollo', 'Stabiane', 'Regina', 'Loreto', 'Nolana', 'Aleria', 'Baggio', 'Marcellina', 'Pantera', 'Sorentina'],
  'Herringbone Reserve': ['Autumn Wheat', 'Stone Grey', 'Dovetail'],
  'Lugano': ['Bella', 'Forma', 'Oro', 'Chiara', 'Felice', 'Genre'],
  'Mateus': ['Adora', 'Chateau', 'Enzo', 'Lido', 'Luxor', 'Maxime', 'Prado', 'Remy', 'Savoy', 'Trevi'],
  'Modern Rustic': ['Moonlit Pearl', 'Silver Lining', 'Oyster White'],
  'New York Loft': ['Canal Street', 'Park Place', 'Pier 55', 'Penn Station', 'West End', 'Carnegie Hall', 'Ferry Point', 'Rock Island', 'Music Hall', 'Marquee', 'Grand Central', 'Midtown', 'Saratoga'],
  'Old World': ['Cocoa Powder', 'Toasted Sesame', 'Mount Bailey', 'Gray Rocks', 'Mink', 'Pearl Grey', 'Desert Haze', 'Fossil Stone', 'Warm Sand', 'Tortoise Shell', 'French Revival', 'Haute Pepper'],
  'Opia': ['Brulee', 'Coterie', 'Curio', 'Destiny', 'Echo', 'Fontaine', 'Galerie', 'Maestro', 'Portico', 'Silo'],
  'Palais Royale': ['Amiens', 'Orleans', 'Riviera', 'Toulouse', 'Versailles', 'Martinique', 'Provence'],
  'Pompeii': ['Vesuvius', 'Salina', 'Lipari', 'Messina', 'Porta', 'Sabatini', 'Amiata', 'Dogana', 'Fortezza', 'Greco', 'Terra'],
  'Richmond': ['Stone Bridge', 'Flint Hill', 'Merrimac'],
  'Studio Moderno': ['Fellini', 'Cavalli', 'Diamonte', 'Rondo', 'Symphonie', 'Classique', 'Jolie'],
  'Tresor': ['Amour', 'Classique', 'Diamonte', 'Jolie', 'Lyon', 'Symphonie', 'Orsay', 'Rondo', 'Blanche', 'Rivoli'],
  'Vitali': ['Corsica', 'Genova', 'Milano', 'Napoli', 'Rocca', 'Arezzo', 'Emilia', 'Fabio', 'Galo', 'Lucca'],
  'Vitali Elite': ['Alba', 'Bronte', 'Carrara', 'Cori', 'Modena', 'Paterno', 'Sandrio', 'Trento'],
  'Volterra': ['Grotto', 'Pisa', 'Antica', 'Valori', 'Avellino', 'Lombardy', 'Mara', 'Novara', 'Ravina', 'Savona', 'Continental'],
  'Dutch Masters': ['Bosch', 'Cleve', 'Escher', 'Gaspar', 'Hals', 'Klee', 'Leyster', 'Mondrian', 'Steen', 'Vermeer'],
  'Lighthouse Cove': ['Ivory White', 'Black Pearl', 'Frosty Taupe', 'Ruby Red'],
  // LVP
  'Concorde Oak': ['Brushed Pearl', 'Cool Classic', 'French Revival', 'London Fog', 'Loyal Friend', 'Mystic Moon', 'Royal Crest', 'Smoked Amber', 'Warm Tribute', 'Willow Wisp', 'Coco Classic', 'Grey Feather'],
  'First Impressions': ['High Style', 'One N Only', 'Pop Art', 'Cool Comfort', 'Real Deal', 'Cozy Cottage', 'Best Choice'],
  'Moda Living': ['At Ease', 'First Crush', 'Jet Set', 'Fly Away', 'True Story', 'Soul Mate', 'Soft Whisper', 'Finally Mine', 'Hang Ten', 'Sweet Talker', 'Free Spirit', 'Good Life', 'Happy Place', 'Last Chance', 'Next Level', 'Wild Thing'],
  'Moda Living Elite': ['Bravo', 'Diva', 'Foxy', 'Inspire', 'Vogue', 'Luxe', 'Jewel', 'Oasis', 'Soulful', 'Gala', 'Indie', 'Showpiece'],
  'New Wave': ['Bashful Beige', 'Daring Doe', 'Great Escape', 'Lunar Glow', 'Modern Mink', 'Nest Egg', 'Night Owl', 'Playful Pony', 'Rare Earth', 'Timber Wolf', 'Barely Beige', 'Brown Sugar', 'Delight'],
  'Stonescape': ['Ancient Earth', 'Angel Trail', 'Desert View', 'Formation Grey', 'Lava Dome', 'Mountain Mist', 'Navajo Bridge', 'Cape Royale', 'Cliff Hanger', 'Eagle Dancer', 'Happy Trails', 'Jackpot', 'Magic Hour', 'Marble Canyon', 'Moon Dancer', 'Ridge Point', 'Roaring Springs', 'Rockface', 'Shooting Star', 'Hourglass'],
  'Uptown Chic': ['Big Easy', 'Catwalk', 'Class Act', 'Double Dare', 'Jazz Singer', 'Naturally Yours', 'Posh Beige', 'Sassy Grey', 'Rock N Roll', 'Bold Ambition', 'Be Mine', 'Better Times', 'Born Ready', 'Spring Fever', 'Summer Wind', 'Rise N Shine', 'Smash Hit', 'Just Lucky', 'Star Struck', 'Starlit Sea', 'Sundance', 'Wild Applause', 'Road Trip', 'Just Chill', 'Midas Touch', 'Love Birds', 'Endless Summer', 'Sandy Cliff', 'Diamond Sky', 'Simply Silver', 'Rule Breaker', 'Cover Story', 'Pitch Perfect', 'Grand Tour', 'Joy Ride', 'Butter Cup', 'Moderne Icon', 'Grey Rocks', 'Oak Ram', 'Breathless', 'Cloud Nine', 'Foxy', 'Gala', 'After Party', 'The Natural', 'True North', 'Warm Tribute', 'Sassy Grey'],
  // Laminate
  'Modessa': ['Showtime', 'So Chic', 'Cover Story', 'High Life', 'Game On', 'Grandstand', 'Heartbreaker', 'Starling', 'Knockout', 'Morning Light', 'Parfait'],
};

/** Reverse map: uppercase color name → canonical collection name */
const PROVENZA_COLOR_TO_COLLECTION = new Map();
for (const [collection, colors] of Object.entries(PROVENZA_COLORS)) {
  for (const color of colors) {
    const key = color.toUpperCase();
    if (!PROVENZA_COLOR_TO_COLLECTION.has(key)) {
      PROVENZA_COLOR_TO_COLLECTION.set(key, collection);
    }
  }
}

/**
 * Accessory patterns — items matching are classified as accessories.
 * Shared with triwest-provenza.js enrichment scraper.
 */
const ACCESSORY_RE = /\b(stair\s*nose|reducer|t[-\s]?mold|bullnose|quarter\s*round|threshold|end\s*cap|overlap|flush\s*mount|baby\s*threshold|multi[-\s]?purpose|transition|scotia|shoe\s*mold|sq(?:uare)?\s*nose|cleaner|touch[-\s]?up|repair\s*kit|molding|moulding)/i;

/** DNav Pattern column values that indicate accessories (uppercase for comparison) */
const ACCESSORY_PATTERN_WORDS = [
  'STAIRNOSE', 'STAIR NOSE', 'REDUCER', 'T-MLDG', 'T MLDG', 'T-MOLD',
  'QTR RND', 'QUARTER ROUND', 'END CAP', 'SQR NOSE', 'SQUARE NOSE',
  'THRESHOLD', 'BULLNOSE', 'MULTI-PURPOSE', 'MULTI PURPOSE',
  'FLUSH MOUNT', 'FLUSH MT', 'BABY THRESHOLD', 'BABY THRESH',
  'OVERLAP', 'TRANSITION', 'SCOTIA', 'SHOE MOLD', 'SHOE MOULD',
  'CLEANER', 'TOUCH UP', 'REPAIR KIT',
];

/**
 * Determine if a DNav row is an accessory vs flooring.
 */
function isAccessory(row) {
  const upperPattern = (row.pattern || '').toUpperCase().trim();
  for (const ap of ACCESSORY_PATTERN_WORDS) {
    if (upperPattern.includes(ap)) return true;
  }
  if (ACCESSORY_RE.test(row.rawDescription) || ACCESSORY_RE.test(row.productName)) return true;
  return false;
}

/**
 * Normalize accessory type from DNav data for product grouping.
 * Returns a display-friendly type name (e.g., "Stairnose", "Reducer").
 */
function normalizeAccessoryType(row) {
  const combined = `${row.pattern} ${row.productName} ${row.rawDescription}`.toUpperCase();

  if (/STAIR\s*NOSE/.test(combined)) return 'Stairnose';
  if (/REDUCER/.test(combined)) return 'Reducer';
  if (/T[-\s]?MOL[D]?|T[-\s]?MLDG/.test(combined)) return 'T-Molding';
  if (/QTR\s*RND|QUARTER\s*ROUND/.test(combined)) return 'Quarter Round';
  if (/END\s*CAP/.test(combined)) return 'End Cap';
  if (/SQR?\s*NOSE|SQUARE\s*NOSE/.test(combined)) return 'Square Nose';
  if (/BABY\s*THRESH/.test(combined)) return 'Baby Threshold';
  if (/THRESHOLD/.test(combined)) return 'Threshold';
  if (/BULLNOSE/.test(combined)) return 'Bullnose';
  if (/MULTI[-\s]?PURPOSE/.test(combined)) return 'Multi-Purpose';
  if (/FLUSH/.test(combined)) return 'Flush Mount';
  if (/OVERLAP/.test(combined)) return 'Overlap';
  if (/TRANSITION/.test(combined)) return 'Transition';
  if (/SCOTIA/.test(combined)) return 'Scotia';
  if (/SHOE\s*MOL[D]?/.test(combined)) return 'Shoe Molding';
  if (/CLEANER/.test(combined)) return 'Cleaner';
  if (/TOUCH\s*UP|REPAIR/.test(combined)) return 'Repair Kit';

  return 'Accessory';
}

/**
 * Title-case an ALL-CAPS string. "AUTUMN GREY" → "Autumn Grey"
 * Preserves mixed-case or short strings as-is.
 */
function titleCase(str) {
  if (!str) return '';
  const s = str.trim();
  if (s !== s.toUpperCase() || s.length <= 2) return s;
  return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Clean collection name from DNav pattern data.
 * Strips "COLLECTION"/"COLL" suffix and title-cases.
 * For Provenza products, normalizes to canonical collection names using PROVENZA_COLLECTION_MAP:
 *   "UPTOWN CHIC WPF COLLECTION 7.15 X60" → "Uptown Chic"
 *   "MODA LIVING WPF-LVP 20MIL 8MMX7.16 X72" → "Moda Living"
 *   "AFFINITY COLLECTION" → "Affinity"
 * Non-Provenza brands pass through with basic cleanup only.
 */
function cleanCollectionName(pattern, brandName) {
  if (!pattern) return '';
  let name = pattern.trim();
  name = name.replace(/\s+COLLECTION$/i, '').replace(/\s+COLL$/i, '').trim();

  // For Provenza, try to normalize to a canonical collection name
  if (brandName === 'Provenza') {
    let normalized = name.toUpperCase();
    // Strip known product-type suffixes
    normalized = normalized
      .replace(/\b(WPF-LVP|WPF|SPC-LVP|SPC|MAXCORE|LVP|LAMINATE)\b/g, '')
      .trim();
    // Strip size dimensions: "20MIL", "8MMX7.16", "7.15 X60", "9 X72", etc.
    normalized = normalized
      .replace(/\b\d+MIL\b/g, '')
      .replace(/\b\d+MM?X[\d.]+\b/g, '')
      .replace(/\b[\d.]+\s*X\s*[\d.]+\b/g, '')
      .trim();
    // Collapse multiple spaces
    normalized = normalized.replace(/\s+/g, ' ').trim();

    // Direct lookup in collection map
    if (PROVENZA_COLLECTION_MAP[normalized]) {
      return PROVENZA_COLLECTION_MAP[normalized];
    }
    // Starts-with fallback (longest match first)
    for (const key of PROVENZA_CANONICAL_NAMES) {
      if (normalized.startsWith(key)) {
        return PROVENZA_COLLECTION_MAP[key];
      }
    }

    // Color→Collection reverse lookup: DNav pattern may contain a color name
    // instead of a collection name (e.g., "JUST LUCKY" → Uptown Chic)
    // Strip species suffixes first: "ACCLAIM-EUROPEAN OAK" → "ACCLAIM"
    let colorKey = normalized
      .replace(/[-\s]+(WHITE OAK|EUROPEAN OAK|SIBERIAN OAK|OAK|MAPLE|HEVEA|ACACIA|W\.?O\.?)$/i, '')
      .trim();
    if (PROVENZA_COLOR_TO_COLLECTION.has(colorKey)) {
      return PROVENZA_COLOR_TO_COLLECTION.get(colorKey);
    }
    // Also try the original normalized (without species stripping)
    if (PROVENZA_COLOR_TO_COLLECTION.has(normalized)) {
      return PROVENZA_COLOR_TO_COLLECTION.get(normalized);
    }
  }

  return titleCase(name);
}

/**
 * Tri-West DNav Portal Catalog Importer.
 *
 * Logs into the DNav dealer portal, searches by manufacturer, and imports
 * the full product catalog (flooring + accessories) with pricing and packaging.
 *
 * Much larger dataset than 832 EDI feed: ~260 flooring colors + ~1,349 accessories
 * for Provenza alone (vs ~11 colors from 832).
 *
 * Config options (vendor_sources.config):
 *   manufacturers: string[]  — 3-letter codes (default: ["PRO"])
 *   delay_ms: number         — delay between operations (default: 2000)
 *   include_accessories: bool — import accessories too (default: true)
 *   retail_markup: number     — cost × markup = retail (default: 2.0)
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const retailMarkup = config.retail_markup || 2.0;
  const includeAccessories = config.include_accessories !== false;
  const manufacturerCodes = config.manufacturers || ['PRO'];
  const vendor_id = source.vendor_id;

  let browser = null;
  let errorCount = 0;
  let totalProducts = 0;
  let totalSkus = 0;
  let totalNewProducts = 0;
  let totalNewSkus = 0;

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { }
    }
  }

  try {
    // ── Resolve category IDs upfront ──
    const categoryCache = new Map();
    for (const code of manufacturerCodes) {
      const slug = MFGR_CATEGORY[code.toUpperCase()];
      if (slug && !categoryCache.has(slug)) {
        const res = await pool.query('SELECT id FROM categories WHERE slug = $1', [slug]);
        if (res.rows.length > 0) categoryCache.set(slug, res.rows[0].id);
      }
    }

    // ── Login ──
    let page;
    try {
      const session = await triwestLogin(pool, job.id);
      browser = session.browser;
      page = session.page;
    } catch (err) {
      await appendLog(pool, job.id, `Puppeteer login failed: ${err.message} — trying cookie fallback...`);
      const cookies = await triwestLoginFromCookies(pool, job.id);
      browser = await launchBrowser();
      page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.setViewport({ width: 1440, height: 900 });
      const cookiePairs = cookies.split('; ').map(pair => {
        const [name, ...rest] = pair.split('=');
        return { name, value: rest.join('='), domain: 'tri400.triwestltd.com' };
      });
      await page.setCookie(...cookiePairs);
      await page.goto(`${PORTAL_BASE}/main/`, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(3000);
    }

    await appendLog(pool, job.id,
      `Portal loaded. Importing catalog for ${manufacturerCodes.length} manufacturer(s): ${manufacturerCodes.join(', ')}`);

    // ── Process each manufacturer ──
    for (let m = 0; m < manufacturerCodes.length; m++) {
      const mfgrCode = manufacturerCodes[m].toUpperCase();
      const brandName = MANUFACTURER_NAMES[mfgrCode] || mfgrCode;

      // Provenza is now fully handled by triwest-provenza scraper (website-first pipeline)
      if (mfgrCode === 'PRO') {
        await appendLog(pool, job.id, `  Skipping ${brandName} — handled by triwest-provenza scraper`);
        continue;
      }

      const categorySlug = MFGR_CATEGORY[mfgrCode] || 'engineered-hardwood';
      const categoryId = categoryCache.get(categorySlug) || null;

      await appendLog(pool, job.id,
        `[${m + 1}/${manufacturerCodes.length}] Cataloging: ${brandName} (${mfgrCode})`);

      // Search DNav for all items by this manufacturer
      const rows = await searchByManufacturer(page, mfgrCode, pool, job.id, { maxRows: 5000 });

      if (rows.length === 0) {
        await appendLog(pool, job.id, `  ${brandName}: no results, skipping`);
        if (m < manufacturerCodes.length - 1) {
          const navOk = await navigateBack(page, pool, job, brandName, delayMs);
          if (!navOk) {
            ({ browser, page } = await relogin(browser, pool, job));
            if (!page) break;
          }
        }
        continue;
      }

      await appendLog(pool, job.id, `  ${brandName}: ${rows.length} total rows from portal`);

      // ── Classify rows ──
      const flooringRows = [];
      const accessoryRows = [];

      for (const row of rows) {
        if (isAccessory(row)) {
          accessoryRows.push(row);
        } else {
          flooringRows.push(row);
        }
      }

      await appendLog(pool, job.id,
        `  ${brandName}: ${flooringRows.length} flooring, ${accessoryRows.length} accessories`);

      // ── Group flooring by collection → one product per collection ──
      const flooringGroups = new Map();
      for (const row of flooringRows) {
        const collection = cleanCollectionName(row.pattern, brandName) || brandName;
        const key = `${brandName}|||${collection}`;
        if (!flooringGroups.has(key)) {
          flooringGroups.set(key, { brand: brandName, collection, rows: [] });
        }
        flooringGroups.get(key).rows.push(row);
      }

      // ── Group accessories by type + collection ──
      const accessoryGroups = new Map();
      for (const row of accessoryRows) {
        const collection = cleanCollectionName(row.pattern, brandName) || brandName;
        const accType = normalizeAccessoryType(row);
        const key = `${brandName}|||${collection}|||${accType}`;
        if (!accessoryGroups.has(key)) {
          accessoryGroups.set(key, { brand: brandName, collection, accessoryType: accType, rows: [] });
        }
        accessoryGroups.get(key).rows.push(row);
      }

      // ── Upsert flooring products + SKUs ──
      for (const [, group] of flooringGroups) {
        try {
          const collectionDisplay = `${group.brand} - ${group.collection}`;
          const productName = group.collection;

          const product = await upsertProduct(pool, {
            vendor_id,
            name: productName,
            collection: collectionDisplay,
            category_id: categoryId,
          }, { jobId: job.id });

          totalProducts++;
          if (product.is_new) totalNewProducts++;

          // Each color = one SKU
          for (const row of group.rows) {
            try {
              const internalSku = `TW-${row.itemNumber}`;
              const colorName = titleCase(row.color);

              const sku = await upsertSku(pool, {
                product_id: product.id,
                vendor_sku: row.itemNumber,
                internal_sku: internalSku,
                variant_name: colorName,
                sell_by: 'sqft',
                variant_type: null,
              }, { jobId: job.id });

              totalSkus++;
              if (sku.is_new) totalNewSkus++;

              // Pricing: sqftPrice as dealer cost, × markup for retail
              if (row.sqftPrice) {
                await upsertPricing(pool, sku.id, {
                  cost: row.sqftPrice,
                  retail_price: parseFloat((row.sqftPrice * retailMarkup).toFixed(2)),
                  price_basis: 'per_sqft',
                }, { jobId: job.id });
              }

              // Packaging
              if (row.sqftPerBox) {
                await upsertPackaging(pool, sku.id, {
                  sqft_per_box: row.sqftPerBox,
                }, { jobId: job.id });
              }

              // Attributes
              if (colorName) await upsertSkuAttribute(pool, sku.id, 'color', colorName);
              if (group.brand) await upsertSkuAttribute(pool, sku.id, 'brand', group.brand);
              if (group.collection) await upsertSkuAttribute(pool, sku.id, 'collection', group.collection);
              if (row.size) await upsertSkuAttribute(pool, sku.id, 'size', row.size);

            } catch (err) {
              await logError(`SKU ${row.itemNumber}: ${err.message}`);
            }
          }
        } catch (err) {
          await logError(`Product ${group.collection}: ${err.message}`);
        }
      }

      // ── Upsert accessory products + SKUs ──
      if (includeAccessories && accessoryRows.length > 0) {
        for (const [, group] of accessoryGroups) {
          try {
            const collectionDisplay = `${group.brand} - ${group.collection}`;
            const productName = `${group.collection} ${group.accessoryType}`;

            const product = await upsertProduct(pool, {
              vendor_id,
              name: productName,
              collection: collectionDisplay,
              category_id: categoryId,
            }, { jobId: job.id });

            totalProducts++;
            if (product.is_new) totalNewProducts++;

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

                totalSkus++;
                if (sku.is_new) totalNewSkus++;

                // Accessories use carton price as unit cost (sold per piece)
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
                if (group.brand) await upsertSkuAttribute(pool, sku.id, 'brand', group.brand);
                if (group.collection) await upsertSkuAttribute(pool, sku.id, 'collection', group.collection);

              } catch (err) {
                await logError(`Accessory SKU ${row.itemNumber}: ${err.message}`);
              }
            }
          } catch (err) {
            await logError(`Accessory product ${group.collection} ${group.accessoryType}: ${err.message}`);
          }
        }
      }

      await appendLog(pool, job.id,
        `  ${brandName} done: ${flooringGroups.size} flooring products (${flooringRows.length} SKUs), ` +
        `${accessoryGroups.size} accessory products (${accessoryRows.length} SKUs)`,
        { products_found: totalProducts, products_created: totalNewProducts, skus_created: totalNewSkus }
      );

      // Navigate back to search form for next manufacturer
      if (m < manufacturerCodes.length - 1) {
        const navOk = await navigateBack(page, pool, job, brandName, delayMs);
        if (!navOk) {
          ({ browser, page } = await relogin(browser, pool, job));
          if (!page) break;
        }
      }
    }

    // ── Final summary ──
    await appendLog(pool, job.id,
      `Complete. Products: ${totalProducts} (${totalNewProducts} new), ` +
      `SKUs: ${totalSkus} (${totalNewSkus} new), Errors: ${errorCount}`,
      {
        products_found: totalProducts,
        products_created: totalNewProducts,
        products_updated: totalProducts - totalNewProducts,
        skus_created: totalNewSkus,
      }
    );

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Navigate back to the search form between manufacturers.
 * Returns true if navigation succeeded, false if re-login is needed.
 */
async function navigateBack(page, pool, job, brandName, delayMs) {
  const navResult = await navigateToSearchForm(page, PORTAL_BASE);
  if (navResult === 'relogin' || !navResult) {
    return false;
  }
  await delay(delayMs);
  return true;
}

/**
 * Close old browser and re-login to DNav portal.
 * Returns { browser, page } on success, { browser: null, page: null } on failure.
 */
async function relogin(oldBrowser, pool, job) {
  await appendLog(pool, job.id, 'Session expired, re-logging in...');
  await oldBrowser.close().catch(() => {});
  try {
    const session = await triwestLogin(pool, job.id);
    return { browser: session.browser, page: session.page };
  } catch (err) {
    await appendLog(pool, job.id, `Re-login failed: ${err.message} — aborting remaining manufacturers`);
    return { browser: null, page: null };
  }
}
