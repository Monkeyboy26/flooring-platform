import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, upsertProduct, upsertSku,
  upsertPricing, upsertPackaging,
} from './base.js';
import { MFGR_CATEGORY } from './triwest-search.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const BASE_URL = 'https://californiaclassicsfloors.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 50;

// ─── Collection definitions ───────────────────────────────────────────────────
// Scraped from californiaclassicsfloors.com — every collection, species, and color.
// URL pattern: /hardwood-flooring/{collectionSlug}/{speciesSlug}/{colorSlug}-flooring.aspx
// Image patterns:
//   swatch (product photo): images/swatch_{imgKey}.jpg
//   lifestyle (room scene): images/NewStyleImage/rooms_{imgKey}{dims}.jpg
//   zoom (close-up):        images/rollimage4/roll_{imgKey}.jpg
// where imgKey = collection slug (lowercase, no spaces) + color slug (lowercase, no spaces)

const COLLECTIONS = [
  {
    name: 'Louvre',
    urlSlug: 'Louvre',
    imgSlug: 'louvre',
    species: 'French Oak',
    speciesSlug: 'FrenchOak',
    colors: ['Renoir', 'Rembrandt', 'Michelangelo', 'Miro', 'Delacroix', 'Degas', 'Chagall', 'Magritte'],
  },
  {
    name: 'Mediterranean Collection 9.5',
    urlSlug: 'MediterraneanCollection9.5',
    imgSlug: 'mediterraneancollection9.5',
    species: 'French Oak',
    speciesSlug: 'FrenchOak',
    colors: ['Belluno', 'Montrieux', 'Corinthian', 'Varazze', 'Bellet', 'Vasto', 'Cosenza', 'Marisol', 'Paola', 'Alassio', 'Teodoro'],
  },
  {
    name: 'Mediterranean',
    urlSlug: 'Mediterranean',
    imgSlug: 'mediterranean',
    species: 'French Oak',
    speciesSlug: 'FrenchOak',
    colors: ['Bayonne', 'Sebastian', 'Bilbao', 'Mondariz', 'Moda', 'Lisbon', 'Margaux', 'Granville', 'Rochelle', 'Cannes', 'Toulon', 'Monaco', 'Calabria', 'Malta', 'Calypso', 'Gibraltar', 'Ionian', 'Kerrew', 'Tripoli', 'Vinaros', 'Aegean', 'Ligurian', 'Tyrrhenian', 'Valldemossa', 'Kazalla', 'Santolina', 'Crispus', 'Sargon', 'Levant', 'Positano', 'Vittoria'],
  },
  {
    name: 'Timeless Classics',
    urlSlug: 'TimelessClassics',
    imgSlug: 'timelessclassics',
    species: null, // mixed — determined per color
    speciesSlug: null,
    colors: [
      // Hickory colors
      { name: 'Aspen', species: 'Hickory', speciesSlug: 'Hickory' },
      { name: 'Bend', species: 'Hickory', speciesSlug: 'Hickory' },
      { name: 'Moab', species: 'Hickory', speciesSlug: 'Hickory' },
      { name: 'Breckenridge', species: 'Hickory', speciesSlug: 'Hickory' },
      { name: 'Telluride', species: 'Hickory', speciesSlug: 'Hickory' },
      { name: 'Boulder', species: 'Hickory', speciesSlug: 'Hickory' },
      { name: 'Snoqualmie', species: 'Hickory', speciesSlug: 'Hickory' },
      { name: 'Sequim', species: 'Hickory', speciesSlug: 'Hickory' },
      // Maple colors
      { name: "Coeur d'Alene", species: 'Maple', speciesSlug: 'Maple', colorSlug: "Coeurd'Alene" },
      { name: 'Kalispell', species: 'Maple', speciesSlug: 'Maple' },
      { name: 'Park City', species: 'Maple', speciesSlug: 'Maple', colorSlug: 'ParkCity' },
      { name: 'Calabasas', species: 'Maple', speciesSlug: 'Maple' },
      { name: 'Shasta', species: 'Maple', speciesSlug: 'Maple' },
      { name: 'Scottsdale', species: 'Maple', speciesSlug: 'Maple' },
      { name: 'Taos', species: 'Maple', speciesSlug: 'Maple' },
      { name: 'Sedona', species: 'Maple', speciesSlug: 'Maple' },
      { name: 'Big Sur', species: 'Maple', speciesSlug: 'Maple', colorSlug: 'BigSur' },
    ],
  },
  {
    name: 'Taverne',
    urlSlug: 'Taverne',
    imgSlug: 'taverne',
    species: 'French Oak',
    speciesSlug: 'FrenchOak',
    colors: ['Laramie', 'Caballero', 'Appaloosa', 'Mustang', 'Cheyenne', 'Paniolo', 'Vaquero', 'Sagebrush', 'Saguaro'],
  },
];

/**
 * California Classics scraper for Tri-West.
 *
 * Phase 1: Parses pricing from DNav Excel price list (CaliforniaClassicsHardwood.xls).
 *   - Download from DNav → Dynamic Price List → "CALIFORNIA CLASSICS HARDWOOD"
 *   - Place at config.price_list_path (default: /app/data/CaliforniaClassicsHardwood.xls)
 *   - Item prefixes: MC* (Mediterranean), LC* (Louvre), TC* (Timeless), TA* (Taverne)
 *   - DNav manufacturer code is 'STX' (Evolutions Flooring), items prefixed with STX in portal
 *
 * Phase 2: Scrapes californiaclassicsfloors.com for images, descriptions, and specs.
 * Phase 3: Extracts spec sheet PDFs.
 *
 * Creates products grouped by collection, one SKU per color.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const retailMarkup = config.retail_markup || 2.0;
  const vendor_id = source.vendor_id;
  const skipDNav = config.skip_dnav || false;

  let browser = null;
  let errorCount = 0;
  let totalProducts = 0;
  let totalSkus = 0;
  let newProducts = 0;
  let newSkus = 0;
  let imagesAdded = 0;
  let dnavMatches = 0;

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { }
    }
  }

  try {
    // ── Resolve category ID ──
    const catSlug = MFGR_CATEGORY['CAL'] || 'engineered-hardwood';
    const catResult = await pool.query('SELECT id FROM categories WHERE slug = $1', [catSlug]);
    const categoryId = catResult.rows.length > 0 ? catResult.rows[0].id : null;

    // ── Phase 1: Parse DNav Excel price list for California Classics ──
    // The price list is downloaded from DNav portal → Dynamic Price List → "CALIFORNIA CLASSICS HARDWOOD"
    // It contains item numbers (without STX prefix), colors, prices, sqft/ctn for all collections.
    // Item# prefixes: MC* = Mediterranean, LC* = Louvre, TC* = Timeless Classics, TA* = Taverne
    // Moldings/accessories: GW* prefix (e.g., GWLVSR3S = Louvre reducer)
    let dnavRows = new Map(); // key → row
    const priceListPath = config.price_list_path || '/app/data/CaliforniaClassicsHardwood.xls';
    if (!skipDNav) {
      await appendLog(pool, job.id, 'Phase 1: Parsing California Classics price list from DNav Excel export...');
      try {
        const XLSX = require('xlsx');
        const fs = require('fs');
        if (!fs.existsSync(priceListPath)) {
          throw new Error(`Price list not found at ${priceListPath}. Download from DNav → Dynamic Price List → CALIFORNIA CLASSICS HARDWOOD`);
        }
        const wb = XLSX.readFile(priceListPath);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

        let currentPriceSqft = null;
        let currentSqftPerCtn = null;
        let itemCount = 0;

        for (const row of rows) {
          if (!row || row.length === 0) continue;
          const col0 = String(row[0] || '').trim();
          // Header rows set the price for subsequent items (only first item has price filled)
          if (row[5] && typeof row[5] === 'string' && row[5].startsWith('$')) {
            currentPriceSqft = parseFloat(row[5].replace('$', ''));
          }
          if (row[4] && typeof row[4] === 'number') {
            currentSqftPerCtn = row[4];
          }
          // Skip non-item rows (headers, dimension lines, notes, molding item numbers starting with GW)
          if (!col0 || col0.length < 4 || /^(Item|PRICE|Dimen|Return|All |A 20|Custom|Mater|Disc|The |TERMS|TRI-|CAL)/i.test(col0)) continue;
          if (/^GW/.test(col0)) continue; // molding/accessory item numbers
          if (!/^[A-Z]{2}/.test(col0)) continue; // must start with 2+ letters

          const itemNumber = col0;
          const color = String(row[1] || '').trim();
          const species = String(row[2] || '').trim();
          const sqftPerCtn = (typeof row[4] === 'number') ? row[4] : currentSqftPerCtn;
          let priceSqft = null;
          if (row[5] && typeof row[5] === 'string' && row[5].startsWith('$')) {
            priceSqft = parseFloat(row[5].replace('$', ''));
            currentPriceSqft = priceSqft;
          } else {
            priceSqft = currentPriceSqft;
          }

          if (!color) continue;

          const entry = {
            itemNumber,
            color,
            species,
            sqftPrice: priceSqft,
            sqftPerBox: sqftPerCtn,
          };

          // Index by item number (website SKU, e.g., LCCH978)
          dnavRows.set(itemNumber.toUpperCase(), entry);
          // Index by color name (for fallback matching)
          // Normalize: uppercase, collapse spaces, remove spaces around apostrophes
          const colorKey = color.toUpperCase().trim().replace(/\s*'\s*/g, "'").replace(/\s+/g, ' ');
          if (!dnavRows.has(`COLOR:${colorKey}`)) {
            dnavRows.set(`COLOR:${colorKey}`, entry);
          }
          itemCount++;
        }

        await appendLog(pool, job.id, `Price list parsed: ${itemCount} items indexed from ${priceListPath}`);
      } catch (err) {
        await appendLog(pool, job.id, `Price list parse failed (continuing without pricing): ${err.message}`);
      }
    } else {
      await appendLog(pool, job.id, 'Phase 1: Skipping pricing (skip_dnav=true)');
    }

    // ── Phase 2: Scrape californiaclassicsfloors.com ──
    await appendLog(pool, job.id, 'Phase 2: Scraping californiaclassicsfloors.com for product data + images...');

    browser = await launchBrowser();
    let page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900 });
    // Block images in the browser to speed up page loads — we construct image URLs directly
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'font', 'stylesheet'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    let pagesSinceLaunch = 0;

    for (const collection of COLLECTIONS) {
      const collectionDisplay = `California Classics - ${collection.name}`;
      await appendLog(pool, job.id, `Processing collection: ${collection.name} (${collection.colors.length} colors)`);

      // Upsert the product (one per collection)
      let product;
      try {
        product = await upsertProduct(pool, {
          vendor_id,
          name: collection.name,
          collection: collectionDisplay,
          category_id: categoryId,
        }, { jobId: job.id });
        totalProducts++;
        if (product.is_new) newProducts++;
      } catch (err) {
        await logError(`Product ${collection.name}: ${err.message}`);
        continue;
      }

      // Process each color in the collection
      for (const colorEntry of collection.colors) {
        const isObject = typeof colorEntry === 'object';
        const colorName = isObject ? colorEntry.name : colorEntry;
        const species = isObject ? colorEntry.species : collection.species;
        const speciesSlug = isObject ? colorEntry.speciesSlug : collection.speciesSlug;
        const colorSlug = (isObject && colorEntry.colorSlug) ? colorEntry.colorSlug : colorName.replace(/\s+/g, '');

        // Recycle browser every 20 pages
        if (pagesSinceLaunch >= 20) {
          try { await page.close(); } catch { }
          try { await browser.close(); } catch { }
          await delay(3000);
          browser = await launchBrowser();
          page = await browser.newPage();
          await page.setUserAgent(USER_AGENT);
          await page.setViewport({ width: 1440, height: 900 });
          await page.setRequestInterception(true);
          page.on('request', req => {
            if (['image', 'font', 'stylesheet'].includes(req.resourceType())) {
              req.abort();
            } else {
              req.continue();
            }
          });
          pagesSinceLaunch = 0;
        }

        try {
          // Navigate to color detail page
          const detailUrl = `${BASE_URL}/hardwood-flooring/${collection.urlSlug}/${speciesSlug}/${colorSlug}-flooring.aspx`;
          await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await delay(delayMs);
          pagesSinceLaunch++;

          // Extract SKU code and specs from the page
          const pageData = await page.evaluate(() => {
            const body = document.body?.innerText || '';

            // SKU code: 4-letter prefix + 3-5 digit number (e.g., LCRE690, TCAS3071)
            const skuMatch = body.match(/([A-Z]{2,5}\d{3,5})/);
            const skuCode = skuMatch ? skuMatch[1] : null;

            // Get the content area
            const contentEl = document.querySelector('#ctl00_ContentPlaceHolder1_UserProductDetail1_lblContent, [id*="ContentPlaceHolder"]');
            const contentText = contentEl ? contentEl.innerText : body;

            // Extract bullet point specs
            const specLines = contentText.split('\n')
              .map(l => l.trim())
              .filter(l => l.length > 10 && l.length < 500 && !l.includes('Customer') && !l.includes('Review'));

            // Get the zoom/lifestyle image URLs from DOM
            const zoomImg = document.querySelector('#zoom_01');
            const lifestyleSrc = zoomImg ? zoomImg.src : null;
            const zoomSrc = zoomImg ? zoomImg.getAttribute('data-zoom-image') : null;

            return {
              skuCode,
              specLines,
              lifestyleSrc,
              zoomSrc,
              title: document.title || '',
            };
          });

          // Build image URLs using the predictable pattern
          const imgKey = collection.imgSlug + colorName.toLowerCase().replace(/[\s']/g, '');
          const swatchUrl = `${BASE_URL}/images/swatch_${imgKey}.jpg`;
          const lifestyleUrl = pageData.lifestyleSrc || `${BASE_URL}/images/NewStyleImage/rooms_${imgKey}208.jpg`;
          const zoomUrl = pageData.zoomSrc
            ? new URL(pageData.zoomSrc, BASE_URL).href
            : `${BASE_URL}/images/rollimage4/roll_${imgKey}.jpg`;

          // Determine vendor SKU — prefer page SKU code, fall back to constructed code
          const vendorSku = pageData.skuCode || `CAL-${colorSlug}`;
          const internalSku = `TW-${vendorSku}`;

          // Match to price list data
          // Excel item numbers match website SKUs directly (e.g., LCCH978, MCAG470LCF, TACH8205)
          let dnavRow = dnavRows.get(vendorSku.toUpperCase());
          if (!dnavRow) {
            // Try matching by color name (normalize same as indexing)
            const colorKey = colorName.toUpperCase().trim().replace(/\s*'\s*/g, "'").replace(/\s+/g, ' ');
            dnavRow = dnavRows.get(`COLOR:${colorKey}`);
          }

          // Upsert SKU
          const sku = await upsertSku(pool, {
            product_id: product.id,
            vendor_sku: vendorSku,
            internal_sku: internalSku,
            variant_name: colorName,
            sell_by: 'sqft',
            variant_type: null,
          }, { jobId: job.id });
          totalSkus++;
          if (sku.is_new) newSkus++;

          // Apply DNav pricing if available
          if (dnavRow) {
            dnavMatches++;
            if (dnavRow.sqftPrice) {
              await upsertPricing(pool, sku.id, {
                cost: dnavRow.sqftPrice,
                retail_price: parseFloat((dnavRow.sqftPrice * retailMarkup).toFixed(2)),
                price_basis: 'per_sqft',
              }, { jobId: job.id });
            }
            if (dnavRow.sqftPerBox) {
              await upsertPackaging(pool, sku.id, {
                sqft_per_box: dnavRow.sqftPerBox,
              }, { jobId: job.id });
            }
          }

          // ── Images: swatch as PRIMARY, lifestyle + zoom as alternates ──
          // Swatch = product photo → primary
          await upsertMediaAsset(pool, {
            product_id: product.id,
            sku_id: sku.id,
            asset_type: 'primary',
            url: swatchUrl,
            original_url: swatchUrl,
            sort_order: 0,
          });
          imagesAdded++;

          // Zoom/roll = close-up of plank → alternate
          await upsertMediaAsset(pool, {
            product_id: product.id,
            sku_id: sku.id,
            asset_type: 'alternate',
            url: zoomUrl,
            original_url: zoomUrl,
            sort_order: 1,
          });
          imagesAdded++;

          // Lifestyle/room scene → lifestyle
          await upsertMediaAsset(pool, {
            product_id: product.id,
            sku_id: sku.id,
            asset_type: 'lifestyle',
            url: lifestyleUrl,
            original_url: lifestyleUrl,
            sort_order: 2,
          });
          imagesAdded++;

          // ── SKU attributes ──
          await upsertSkuAttribute(pool, sku.id, 'color', colorName);
          await upsertSkuAttribute(pool, sku.id, 'brand', 'California Classics');
          await upsertSkuAttribute(pool, sku.id, 'collection', collection.name);
          if (species) await upsertSkuAttribute(pool, sku.id, 'species', species);

          // Parse specs from page title (e.g., "5/8" thick x 9.4" wide x 86.6" long")
          const titleSpecs = parseSpecsFromTitle(pageData.title);
          if (titleSpecs.thickness) await upsertSkuAttribute(pool, sku.id, 'thickness', titleSpecs.thickness);
          if (titleSpecs.width) await upsertSkuAttribute(pool, sku.id, 'width', titleSpecs.width);
          if (titleSpecs.length) await upsertSkuAttribute(pool, sku.id, 'length', titleSpecs.length);

          // Parse additional specs from bullet points
          const bulletSpecs = parseSpecsFromBullets(pageData.specLines);
          if (bulletSpecs.finish) await upsertSkuAttribute(pool, sku.id, 'finish', bulletSpecs.finish);
          if (bulletSpecs.construction) await upsertSkuAttribute(pool, sku.id, 'construction', bulletSpecs.construction);
          if (bulletSpecs.wear_layer) await upsertSkuAttribute(pool, sku.id, 'wear_layer', bulletSpecs.wear_layer);
          if (bulletSpecs.warranty) await upsertSkuAttribute(pool, sku.id, 'warranty', bulletSpecs.warranty);
          if (bulletSpecs.surface) await upsertSkuAttribute(pool, sku.id, 'surface', bulletSpecs.surface);

        } catch (err) {
          await logError(`${collection.name} / ${colorName}: ${err.message}`);
        }
      }

      await appendLog(pool, job.id,
        `  ${collection.name}: ${collection.colors.length} colors processed`);
    }

    // ── Phase 3: Spec sheet PDFs ──
    await appendLog(pool, job.id, 'Phase 3: Checking for spec sheet PDFs...');
    try {
      await page.goto(`${BASE_URL}/hardwood-flooring/specification-sheets.aspx`, {
        waitUntil: 'domcontentloaded', timeout: 15000,
      });
      await delay(delayMs);

      const pdfLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href*=".pdf"]'))
          .map(a => ({ href: a.href, text: a.textContent.trim() }))
          .filter(l => l.href && l.text);
      });

      if (pdfLinks.length > 0) {
        await appendLog(pool, job.id, `Found ${pdfLinks.length} spec PDF links`);
        // Match PDFs to collections and store as spec_pdf assets
        for (const link of pdfLinks) {
          for (const collection of COLLECTIONS) {
            const collectionDisplay = `California Classics - ${collection.name}`;
            if (link.text.toLowerCase().includes(collection.name.toLowerCase())
              || link.href.toLowerCase().includes(collection.urlSlug.toLowerCase())) {
              // Find the product for this collection
              const prodResult = await pool.query(
                'SELECT id FROM products WHERE vendor_id = $1 AND collection = $2 LIMIT 1',
                [vendor_id, collectionDisplay]
              );
              if (prodResult.rows.length > 0) {
                await upsertMediaAsset(pool, {
                  product_id: prodResult.rows[0].id,
                  sku_id: null,
                  asset_type: 'spec_pdf',
                  url: link.href,
                  original_url: link.href,
                  sort_order: 0,
                });
              }
              break;
            }
          }
        }
      }
    } catch (err) {
      await appendLog(pool, job.id, `Spec PDF extraction failed (non-critical): ${err.message}`);
    }

    // ── Final summary ──
    await appendLog(pool, job.id,
      `Complete. Products: ${totalProducts} (${newProducts} new), ` +
      `SKUs: ${totalSkus} (${newSkus} new), ` +
      `Images: ${imagesAdded}, DNav price matches: ${dnavMatches}/${totalSkus}, ` +
      `Errors: ${errorCount}`,
      {
        products_found: totalProducts,
        products_created: newProducts,
        products_updated: totalProducts - newProducts,
        skus_created: newSkus,
      }
    );

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Parse dimension specs from the page title.
 * e.g., '5/8" thick x 9.4" wide x 86.6" long (75% long boards) - Louvre Renoir French Oak'
 * e.g., "1/2'' thickness, dramatic 4''/5''/6'' variable width..."
 */
function parseSpecsFromTitle(title) {
  const specs = {};
  if (!title) return specs;

  // Thickness: 5/8", 1/2'', etc.
  const thickMatch = title.match(/([\d\/]+)[""'']+\s*thick/i);
  if (thickMatch) specs.thickness = thickMatch[1] + '"';

  // Width: 9.4", 4''/5''/6'' variable width, etc.
  const widthMatch = title.match(/([\d.\/''""]+(?:\/[\d.\/''""]+)*)[""'']*\s*wide/i);
  if (widthMatch) specs.width = widthMatch[1].replace(/[''""]+/g, '"');
  if (!specs.width) {
    const varWidthMatch = title.match(/([\d.]+[""'']+(?:\/[\d.]+[""'']+)+)\s*variable\s*width/i);
    if (varWidthMatch) specs.width = varWidthMatch[1].replace(/[''""]+/g, '"') + ' variable';
  }

  // Length: 86.6", 15''-60'', etc.
  const lenMatch = title.match(/([\d.]+)[""'']+\s*long/i);
  if (lenMatch) specs.length = lenMatch[1] + '"';
  if (!specs.length) {
    const rangeMatch = title.match(/length\s*(?:from\s*)?([\d.]+)[""'']+\s*[-–]\s*([\d.]+)[""'']+/i);
    if (rangeMatch) specs.length = `${rangeMatch[1]}"-${rangeMatch[2]}"`;
  }

  return specs;
}

/**
 * Parse specs from bullet-point text lines.
 */
function parseSpecsFromBullets(lines) {
  const specs = {};
  if (!lines || lines.length === 0) return specs;

  const combined = lines.join(' ');

  // Construction: "Engineered 4mm sawn veneer"
  const engMatch = combined.match(/Engineered\s+(\d+mm\s+sawn\s+veneer)/i);
  if (engMatch) specs.construction = `Engineered ${engMatch[1]}`;
  else if (/engineered/i.test(combined)) specs.construction = 'Engineered';

  // Wear layer: "2 mm wear layer", "4mm sawn veneer"
  const wearMatch = combined.match(/(\d+)\s*mm\s*(?:sawn\s+veneer|wear\s+layer)/i);
  if (wearMatch) specs.wear_layer = `${wearMatch[1]}mm`;

  // Finish: "8 coats of ... Valspar urethane finish"
  const finishMatch = combined.match(/(\d+)\s*[Cc]oats?\s+of\s+[^.]+(?:finish|urethane)/i);
  if (finishMatch) specs.finish = finishMatch[0].trim();

  // Surface treatment: "wire brushing", "Hand-Stained", "Hand Distressed"
  if (/wire.?brush/i.test(combined)) specs.surface = '3-D Elevated Wire Brushing';
  else if (/hand.?stain/i.test(combined) && /hand.?distress/i.test(combined)) specs.surface = 'Hand-Stained & Hand Distressed';
  else if (/hand.?scrap/i.test(combined)) specs.surface = 'Hand Scraped';

  // Warranty
  const warrantyMatch = combined.match(/(\d+)-Year\s+residential[^.]+warranty/i);
  if (warrantyMatch) specs.warranty = warrantyMatch[0].trim();

  return specs;
}
