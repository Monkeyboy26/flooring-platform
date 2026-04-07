/**
 * Bellezza Ceramica — Image + Metadata Enrichment Scraper
 *
 * Products already imported from XLSX price list (scripts/import-bellezza.js).
 * This scraper visits bellezzaceramica.com (WooCommerce) to capture product
 * images, structured metadata, and generate descriptions.
 *
 * URL pattern: bellezzaceramica.com/product/<slug>/
 * WooCommerce gallery with flexslider, images in /wp-content/uploads/
 *
 * Usage: docker compose exec api node scrapers/bellezza.js
 */

import pg from 'pg';
import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
} from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

const BASE_URL = 'https://bellezzaceramica.com';

// Map DB product names → website product page slugs (can be multiple slugs per product).
// Discovered by probing bellezzaceramica.com product pages (Mar 2026).
const URL_MAP = {
  // Porcelain & Ceramic Tiles
  'Angelo Silk Shimmer':      ['angelo-silk'],
  'Anima Antracita':          ['anima-antracita'],
  'Antwerp':                  ['antwerp-mosaic'],
  'Arena Chiaro':             ['arena-chiaro'],
  'Armani White':             ['armani-white'],
  'Austral Blanco':           ['austral-blanco'],
  'Austral Essence Blanco':   ['austral-essence-blanco'],
  'Bolonia Marengo':          ['bolonia-marengo-polished', 'bolonia-marengo-matte'],
  'Calaca Gold':              ['calaca-gold', 'calaca-gold-matte'],
  'Calacatta Gold':           ['calacatta-gold', 'calacatta-gold-lux'],
  'Calacatta Gloss':          ['calacatta-gloss-polished'],
  'Calacatta Hex Gloss':      ['calacatta-hex-gloss'],
  'Calacatta Natural':        ['calacatta-natural-polished'],
  'Calcutta Gold':            ['calcutta-gold'],
  'Camden':                   ['camden-mosaic'],
  'Ceppo':                    ['ceppo'],
  'Chamonix':                 ['chamonix'],
  'Concretus':                ['concretus', 'concretus-light-matte'],
  'Connor Beige':             ['connor-beige-matte'],
  'District':                 ['district'],
  'Docks':                    ['docks', 'docks-beige', 'docks-white'],
  'Dolomite':                 ['dolomite-matte'],
  'Emporio Calacatta':        ['emporio-calacatta-matte'],
  'Elegance Marble Pearl':    ['elegance-marble-pearl', 'elegance-marble'],
  'Epoque':                   ['epoque-white'],
  'Fry':                      ['fry'],
  'Granby Beige':             ['granby'],
  'Grunge':                   ['grunge', 'grunge-beige', 'grunge-smoke', 'grunge-multi'],
  'Harley Lux':               ['harley-lux', 'harley-lux-black', 'harley-lux-graphite', 'harley-lux-super-white'],
  'Ibiza':                    ['ibiza'],
  'Kadence':                  ['kadence-gris-polished'],
  'Larin Marfil':             ['larin-marfil'],
  'Laurent Black':            ['laurent-black-matte', 'laurent-black-polish-36x36', 'laurent-black-matte-36x36'],
  'Leccese Cesellata':        ['leccese'],
  'Markina Gold':             ['markina-gold'],
  'Marmo Marfil':             ['navarti-marmo-marfil'],
  'Milano Crema':             ['milano-crema'],
  'Milano Mosaic':            ['milano'],
  'Mixit Concept':            ['mixit-concept', 'mixit-concept-blanco'],
  'Modern Concrete Ivory':    ['modern-concrete-ivory'],
  'Montblanc Gold':           ['montblanc-gold'],
  'Myrcella':                 ['myrcella', 'myrcella-beige', 'myrcella-bone', 'myrcella-grey', 'myrcella-mocca'],
  'Naples White':             ['naples-white'],
  'Palatino':                 ['palatino', 'palatino-ivory', 'deco-palatino', 'deco-palatino-ivory'],
  'Pearl Onyx':               ['pearl-onyx-24x48'],
  'Puccini':                  ['puccini', 'puccini-blanco', 'puccini-marfil', 'puccini-perla'],
  'Sierra':                   ['sierra-matte-24x48'],
  'Scanda White':             ['scanda-white'],
  'Sekos White':              ['sekos-white'],
  'Spatula':                  ['spatula', 'spatula-antracite', 'spatula-grey', 'spatula-white', 'spatula-bone'],
  'Statuario Nice':           ['statuario-nice'],
  'Temper':                   ['temper'],
  'Unique Ceppo Bone':        ['unique-ceppo-bone'],
  'Volga':                    ['volga', 'volga-grafito', 'volga-gris'],
  'Westmount Beige':          ['westmount-beige'],
  'WG001':                    ['wg001m-matte'],
  // Mosaics & Hex
  'Hex XL Coimbra':           ['coimbra'],
  'Hex XL Fosco':             ['fosco'],
  'Hex XL Inverno Grey':      ['inverno-grey'],
  // GIO Collection
  'Gio':                      ['gio-white-glossy-hexagon-2x2', 'gio-white-matte-hexagon-2x2', 'gio-white-matte-hexagon-4x4'],
  // Subway & Artisan
  'Altea':                    ['altea-ash-blue-4x4-3x6', 'altea-black-4x4-3x6', 'altea-dusty-pink-4x4-3x6', 'altea-pine-green-4x4-3x6', 'altea-rosewood-4x4-3x6', 'altea-smoke-4x4-3x6', 'altea-thistle-blue-4x4-3x6', 'altea-white-4x4-3x6'],
  'Amazonia':                 ['amazonia-artic', 'amazonia-carbon', 'amazonia-chalk', 'amazonia-sand', 'amazonia-sapphire'],
  'Limit':                    ['limit-blanc-2%c2%bdx-10', 'limit-bleu-clair-2%c2%bdx-10', 'limit-bleu-izu-2%c2%bdx-10'],
  // Frammenti
  'Frammenti':                ['frammenti-fr-10-bianco-3-x16', 'frammenti-fr-10-bianco-8x8', 'frammenti-fr-12-blu-notte-3-x16', 'frammenti-fr-2-azzurro-3-x16', 'frammenti-fr-5-grigio-3-x16', 'frammenti-fr-8-nero-micro-macro-8x8'],
  // Recycled Glass (DB names: "NatureGlass Hex", "Silver Matte Hex", "Statuario Matte Hex")
  'NatureGlass Hex':          ['natureglass-black-hexagon', 'natureglass-smooth-grey-hex', 'natureglass-white-hexagon', 'grey-hexagon'],
  'Silver Matte Hex':         ['silver-matte-hexagon'],
  'Statuario Matte Hex':      ['statuario-white-matte-hexagon', 'white-hexagon-4x4'],
  // Panels
  'Acoustic MDF Sound Absorption Panel': ['mdf-acoustic-interior-medium-density-fiberboard'],
  'Exterior Composite Wall Panel':       ['wpc-exterior-wood-plastic-composite'],
};

async function scrollToLoadAll(page) {
  await page.evaluate(async () => {
    for (let i = 0; i < 15; i++) {
      window.scrollBy(0, 400);
      await new Promise(r => setTimeout(r, 200));
    }
    window.scrollTo(0, 0);
  });
  await delay(1000);
}

async function extractProductImages(page, url) {
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    if (!resp || resp.status() >= 400) {
      console.log(`    HTTP ${resp?.status()} for ${url}`);
      return { images: [], metadata: null };
    }
    await delay(1500);
    await scrollToLoadAll(page);

    const result = await page.evaluate(() => {
      const imgs = [];
      const seen = new Set();

      // WooCommerce product gallery
      const galleryImgs = document.querySelectorAll(
        '.woocommerce-product-gallery img, ' +
        '.wp-post-image, ' +
        'img.attachment-woocommerce_single'
      );
      for (const img of galleryImgs) {
        const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-large_image') || '';
        if (src && !seen.has(src) && src.includes('/wp-content/uploads/') && !src.includes('placeholder')) {
          seen.add(src);
          imgs.push(src);
        }
      }

      // Gallery link hrefs (full-size images)
      const galleryLinks = document.querySelectorAll('.woocommerce-product-gallery__image a');
      for (const a of galleryLinks) {
        const href = a.href || '';
        if (href && !seen.has(href) && href.includes('/wp-content/uploads/')) {
          seen.add(href);
          imgs.push(href);
        }
      }

      // JSON-LD structured data
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of ldScripts) {
        try {
          const data = JSON.parse(script.textContent);
          const imageArr = data.image || (data['@graph'] || []).flatMap(g => g.image || []);
          for (const imgUrl of [].concat(imageArr).filter(Boolean)) {
            const u = typeof imgUrl === 'string' ? imgUrl : imgUrl.url || '';
            if (u && !seen.has(u) && u.includes('/wp-content/uploads/')) {
              seen.add(u);
              imgs.push(u);
            }
          }
        } catch {}
      }

      // Fallback: any large content images
      if (imgs.length === 0) {
        const allImgs = document.querySelectorAll('.entry-content img, .et_pb_module img, #content img');
        for (const img of allImgs) {
          const src = img.src || '';
          if (src && !seen.has(src) && src.includes('/wp-content/uploads/') &&
              !src.includes('logo') && !src.includes('icon') && !src.includes('banner') &&
              img.naturalWidth > 100) {
            seen.add(src);
            imgs.push(src);
          }
        }
      }

      // Extract structured metadata from WooCommerce product page
      const meta = {};
      // Method 1: WooCommerce additional info table
      const attrRows = document.querySelectorAll('.woocommerce-product-attributes tr');
      for (const row of attrRows) {
        const label = (row.querySelector('th')?.textContent || '').trim().toLowerCase();
        const value = (row.querySelector('td')?.textContent || '').trim();
        if (label && value) meta[label] = value;
      }
      // Method 2: product meta spans (Item #, Size, Finish, Color, Application)
      const metaEl = document.querySelector('.product_meta');
      if (metaEl) {
        const text = metaEl.innerText || '';
        for (const line of text.split('\n')) {
          const m = line.match(/^(Item\s*#|Size|Finish|Color|Application|Material)\s*:\s*(.+)/i);
          if (m) meta[m[1].toLowerCase().trim()] = m[2].trim();
        }
      }
      // Method 3: short description
      const shortDesc = document.querySelector('.woocommerce-product-details__short-description');
      if (shortDesc) {
        const text = shortDesc.innerText?.trim();
        if (text && text.length > 10 && !text.startsWith('http')) meta.short_description = text;
      }
      // Method 4: categories and tags
      const cats = [];
      document.querySelectorAll('.posted_in a').forEach(a => cats.push(a.textContent.trim()));
      if (cats.length) meta.categories = cats.join(', ');
      const tags = [];
      document.querySelectorAll('.tagged_as a').forEach(a => tags.push(a.textContent.trim()));
      if (tags.length) meta.tags = tags.join(', ');

      return { images: imgs, metadata: Object.keys(meta).length > 0 ? meta : null };
    });

    return result;
  } catch (err) {
    console.log(`    Error loading ${url}: ${err.message}`);
    return { images: [], metadata: null };
  }
}

/** Generate a description from scraped metadata + product name */
function generateDescription(productName, collection, meta) {
  const parts = [];
  const name = productName || collection;

  // Determine material type from categories or name
  let materialType = 'tile';
  const catStr = (meta?.categories || '').toLowerCase();
  const nameLC = (name || '').toLowerCase();
  if (catStr.includes('mosaic') || nameLC.includes('mosaic') || nameLC.includes('hex')) {
    materialType = 'mosaic tile';
  } else if (catStr.includes('porcelain') || nameLC.includes('porcelain')) {
    materialType = 'porcelain tile';
  } else if (catStr.includes('ceramic') || nameLC.includes('ceramic')) {
    materialType = 'ceramic tile';
  } else if (catStr.includes('glass') || nameLC.includes('glass')) {
    materialType = 'recycled glass tile';
  } else if (nameLC.includes('panel')) {
    materialType = 'panel';
  } else if (nameLC.includes('grout')) {
    materialType = 'grout';
  } else if (nameLC.includes('trim') || nameLC.includes('schluter')) {
    materialType = 'trim profile';
  } else if (catStr.includes('porcelain') || catStr.includes('stone look') || catStr.includes('marble look')) {
    materialType = 'porcelain tile';
  }

  // Build main sentence
  const finish = meta?.finish;
  const color = meta?.color;
  const size = meta?.size;
  const application = meta?.application;

  let desc = `The ${name} is a`;
  if (finish) desc += ` ${finish.toLowerCase()}`;
  if (color && !name.toLowerCase().includes(color.toLowerCase())) desc += ` ${color.toLowerCase()}`;
  desc += ` ${materialType} from the Bellezza Ceramica collection`;

  if (size) desc += `, available in ${size}`;
  desc += '.';

  if (application) {
    desc += ` Suitable for ${application.toLowerCase()} applications.`;
  }

  return desc;
}

/** Generate a basic description for products without website metadata */
function generateBasicDescription(productName, collection) {
  const nameLC = (productName || '').toLowerCase();
  let type = 'tile';
  if (nameLC.includes('mosaic') || nameLC.includes('hex')) type = 'mosaic tile';
  else if (nameLC.includes('panel')) type = 'panel';
  else if (nameLC.includes('grout')) type = 'grout';
  else if (nameLC.includes('trim') || nameLC.includes('schluter')) type = 'trim profile';
  else if (nameLC.includes('penny')) type = 'penny round mosaic tile';
  else if (nameLC.includes('linear') || nameLC.includes('stacked')) type = 'linear mosaic tile';

  return `The ${productName} is a ${type} from the Bellezza Ceramica collection.`;
}

async function run() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'BELLEZZA'");
  if (!vendorRes.rows.length) {
    console.error('Bellezza vendor not found. Run import-bellezza.js first.');
    return;
  }
  const vendorId = vendorRes.rows[0].id;

  // Get all products for this vendor
  const prodRows = await pool.query(`
    SELECT id, name, collection, description_short FROM products WHERE vendor_id = $1 ORDER BY name
  `, [vendorId]);

  console.log(`Found ${prodRows.rowCount} Bellezza products to enrich\n`);

  const productMap = new Map();
  for (const row of prodRows.rows) {
    productMap.set(row.name, { id: row.id, collection: row.collection, description_short: row.description_short });
  }

  const browser = await launchBrowser();
  let imagesSaved = 0;
  let productsMatched = 0;
  let descriptionsSet = 0;
  let attributesSet = 0;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    });
    // Override webdriver detection
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
    });

    console.log('=== Scraping Product Pages ===\n');

    for (const [productName, slugs] of Object.entries(URL_MAP)) {
      const prod = productMap.get(productName);
      if (!prod) {
        console.log(`  [SKIP] No DB match for: ${productName}`);
        continue;
      }
      const productId = prod.id;

      const allImageUrls = [];
      const seenUrls = new Set();
      let collectedMeta = null;

      for (const slug of slugs) {
        const url = `${BASE_URL}/product/${slug}/`;
        console.log(`  Visiting: ${url}`);

        const { images, metadata } = await extractProductImages(page, url);
        for (const imgUrl of images) {
          if (!seenUrls.has(imgUrl)) {
            seenUrls.add(imgUrl);
            allImageUrls.push(imgUrl);
          }
        }
        // Keep first valid metadata
        if (!collectedMeta && metadata) collectedMeta = metadata;
        console.log(`    Found ${images.length} images${metadata ? ' + metadata' : ''}`);
        await delay(800);
      }

      // Save images (up to 6)
      if (allImageUrls.length > 0) {
        const toSave = allImageUrls.slice(0, 6);
        const skuRows = await pool.query('SELECT id FROM skus WHERE product_id = $1', [productId]);
        for (const skuRow of skuRows.rows) {
          for (let i = 0; i < toSave.length; i++) {
            const assetType = i === 0 ? 'primary' : (i <= 2 ? 'alternate' : 'lifestyle');
            await upsertMediaAsset(pool, {
              product_id: productId,
              sku_id: skuRow.id,
              asset_type: assetType,
              url: toSave[i],
              original_url: toSave[i],
              sort_order: i,
            });
            imagesSaved++;
          }
        }
        productsMatched++;
        console.log(`  [SAVED] ${productName} — ${toSave.length} image(s)`);
      } else {
        console.log(`  [NO IMAGES] ${productName}`);
      }

      // Save description if not already set
      if (!prod.description_short && collectedMeta) {
        const desc = generateDescription(productName, prod.collection, collectedMeta);
        await pool.query('UPDATE products SET description_short = $1 WHERE id = $2', [desc, productId]);
        descriptionsSet++;
        console.log(`  [DESC] ${desc}`);
      }

      // Save SKU attributes from metadata
      if (collectedMeta) {
        const skuRows = await pool.query('SELECT id FROM skus WHERE product_id = $1', [productId]);
        const attrMap = {
          'finish': collectedMeta.finish,
          'color': collectedMeta.color,
          'application': collectedMeta.application,
          'size': collectedMeta.size,
        };
        for (const skuRow of skuRows.rows) {
          for (const [attr, val] of Object.entries(attrMap)) {
            if (val) {
              await upsertSkuAttribute(pool, skuRow.id, attr, val);
              attributesSet++;
            }
          }
        }
      }

      console.log('');
    }

    // Pass 2: Generate descriptions for products still without one
    console.log('\n=== Generating descriptions for remaining products ===\n');
    const noDescRows = await pool.query(`
      SELECT id, name, collection FROM products
      WHERE vendor_id = $1 AND description_short IS NULL
      ORDER BY name
    `, [vendorId]);

    for (const row of noDescRows.rows) {
      const desc = generateBasicDescription(row.name, row.collection);
      await pool.query('UPDATE products SET description_short = $1 WHERE id = $2', [desc, row.id]);
      descriptionsSet++;
      console.log(`  [DESC] ${row.name}: ${desc}`);
    }

    // Pass 3: Activate products with images + pricing
    console.log('\n=== Activating products ===\n');
    // First activate SKUs that have pricing
    const skuActivated = await pool.query(`
      UPDATE skus SET status = 'active'
      WHERE product_id IN (SELECT id FROM products WHERE vendor_id = $1)
        AND status = 'draft'
        AND EXISTS (SELECT 1 FROM pricing pr WHERE pr.sku_id = skus.id AND pr.retail_price > 0)
      RETURNING id
    `, [vendorId]);
    console.log(`  Activated ${skuActivated.rowCount} SKUs with pricing`);

    // Then activate products that have active SKUs
    const prodActivated = await pool.query(`
      UPDATE products SET status = 'active'
      WHERE vendor_id = $1
        AND status = 'draft'
        AND EXISTS (SELECT 1 FROM skus s WHERE s.product_id = products.id AND s.status = 'active')
      RETURNING id
    `, [vendorId]);
    console.log(`  Activated ${prodActivated.rowCount} products`);

    // Refresh search vectors
    await pool.query(`
      UPDATE products SET search_vector = to_tsvector('english',
        COALESCE(name,'') || ' ' || COALESCE(collection,'') || ' ' ||
        COALESCE(description_short,'') || ' ' || COALESCE(description_long,''))
      WHERE vendor_id = $1
    `, [vendorId]);
    console.log('  Refreshed search vectors');

    console.log(`\n=== Scrape Complete ===`);
    console.log(`Products matched: ${productsMatched} / ${productMap.size}`);
    console.log(`Total images saved: ${imagesSaved}`);
    console.log(`Descriptions set: ${descriptionsSet}`);
    console.log(`Attributes set: ${attributesSet}`);

  } finally {
    await browser.close();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
