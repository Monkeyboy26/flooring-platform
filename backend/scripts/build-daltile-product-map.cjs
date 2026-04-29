#!/usr/bin/env node
/**
 * build-daltile-product-map.cjs
 *
 * Queries the Daltile Coveo API and generates a product map JSON file
 * organized by Series → Color → SKU variants, with accessories separated.
 *
 * This map becomes the source of truth for product structure in the
 * daltile-unified scraper. EDI 832 data is used only for pricing/packaging.
 *
 * Usage:
 *   node backend/scripts/build-daltile-product-map.cjs
 *   node backend/scripts/build-daltile-product-map.cjs --domain www.americanolean.com
 *
 * Output:
 *   backend/data/daltile-product-map.json
 */

const fs = require('fs');
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────────────────

const DOMAIN = process.argv.find(a => a.startsWith('--domain='))
  ?.split('=')[1] || 'www.daltile.com';

const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'daltile-product-map.json');

const PAGE_SIZE = 1000;
const COVEO_OFFSET_LIMIT = 5000;
const DELAY_MS = 200;

// Coveo caps firstResult at ~5000. Split by product type to stay under limit.
const PRODUCT_TYPE_SPLITS = [
  'Floor Tile',
  'Floor Tile Trim',
  'Wall Tile',
  'Wall Tile Trim',
  'Mosaic Tile',
  'Mosaic Tile Trim',
  'Mosaic Natural Stone Tile',
  'Stone Tile',
  'Stone Tile Trim',
  'LVT Trim',
  'LVT Plank',
  'Luxury Vinyl Tile',
  'Porcelain Slab',
  'Quartz Slab',
  'Natural Stone Slab',
  'Quarry Tile',
  'Quarry Tile Trim',
  'Floor Tile Deco',
  'Wall Tile Deco',
  'Wall Bathroom Accessories',
  'Windowsills-Thresholds',
];

// Fields to request from Coveo
const COVEO_FIELDS = [
  'sku', 'seriesname', 'colornameenglish', 'colorcode', 'nominalsize',
  'finish', 'designpattern', 'productshape', 'producttype', 'bodytype',
  'productimageurl', 'productswatchurl', 'primaryroomsceneurl',
  'pdpurl', 'seriespageurl', 'skudescription', 'specialfeatures',
  'nominalthickness', 'colorfamilyname', 'shadevariation',
  'countryofmanufacture', 'sampleavailable', 'partial_sku',
];

// Product types that are trims/accessories
const TRIM_TYPES = new Set([
  'Floor Tile Trim', 'Wall Tile Trim', 'Mosaic Tile Trim',
  'Stone Tile Trim', 'LVT Trim', 'Quarry Tile Trim',
]);

// ─── Coveo API ───────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function queryCoveo(domain, extraFilter, firstResult, numberOfResults) {
  const aq = `@sitetargethostname=="${domain}" @sourcedisplayname==product${extraFilter}`;

  const resp = await fetch(`https://${domain}/coveo/rest/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      q: '',
      aq,
      firstResult,
      numberOfResults,
      fieldsToInclude: COVEO_FIELDS,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Coveo API error ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function paginateQuery(domain, extraFilter, totalCount) {
  const results = [];
  let offset = 0;
  while (offset < totalCount && offset < COVEO_OFFSET_LIMIT) {
    const pageSize = Math.min(PAGE_SIZE, totalCount - offset);
    const resp = await queryCoveo(domain, extraFilter, offset, pageSize);
    const batch = resp.results || [];
    if (batch.length === 0) break;
    results.push(...batch);
    offset += batch.length;
    if (offset < totalCount) await delay(DELAY_MS);
  }
  return results;
}

async function fetchAllCoveoResults(domain) {
  // Probe total count
  const probe = await queryCoveo(domain, '', 0, 0);
  const totalCount = probe.totalCount || 0;
  console.log(`Coveo reports ${totalCount} total products for ${domain}`);
  if (totalCount === 0) return [];

  if (totalCount <= COVEO_OFFSET_LIMIT) {
    return paginateQuery(domain, '', totalCount);
  }

  // Split by product type to stay under offset limit
  console.log(`Total (${totalCount}) exceeds offset limit (${COVEO_OFFSET_LIMIT}). Splitting by product type.`);
  const allResults = [];
  const seenSkus = new Set();

  for (const productType of PRODUCT_TYPE_SPLITS) {
    const typeFilter = ` @producttype=="${productType}"`;
    const typeProbe = await queryCoveo(domain, typeFilter, 0, 0);
    const typeCount = typeProbe.totalCount || 0;
    if (typeCount === 0) continue;

    console.log(`  ${productType}: ${typeCount} results`);
    const results = await paginateQuery(domain, typeFilter, typeCount);

    for (const r of results) {
      const rawSku = getField(r, 'sku');
      if (!rawSku) continue;
      const skuParts = rawSku.split(/[;,]/).map(s => s.trim()).filter(Boolean);
      const key = skuParts.map(s => s.toUpperCase()).sort().join('|');
      if (!seenSkus.has(key)) {
        seenSkus.add(key);
        allResults.push(r);
      }
    }
  }

  // Catch-all for unlisted product types
  const catchAllFilter = PRODUCT_TYPE_SPLITS.map(t => `@producttype<>"${t}"`).join(' ');
  const catchProbe = await queryCoveo(domain, ` ${catchAllFilter}`, 0, 0);
  const catchCount = catchProbe.totalCount || 0;
  if (catchCount > 0) {
    console.log(`  (other types): ${catchCount} results`);
    const results = await paginateQuery(domain, ` ${catchAllFilter}`, Math.min(catchCount, COVEO_OFFSET_LIMIT));
    for (const r of results) {
      const rawSku = getField(r, 'sku');
      if (!rawSku) continue;
      const skuParts = rawSku.split(/[;,]/).map(s => s.trim()).filter(Boolean);
      const key = skuParts.map(s => s.toUpperCase()).sort().join('|');
      if (!seenSkus.has(key)) {
        seenSkus.add(key);
        allResults.push(r);
      }
    }
  }

  return allResults;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getField(result, fieldName) {
  const raw = result.raw || {};
  const val = raw[fieldName] ?? raw[fieldName.toLowerCase()] ?? null;
  if (val == null) return '';
  if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean).join(', ');
  return String(val).trim();
}

function cleanScene7Url(url) {
  if (!url) return '';
  let cleaned = url.split('?')[0];
  // Remove Scene7 preset suffixes like :SwatchThumbnail, $TRIMTHUMBNAIL$
  cleaned = cleaned.replace(/[:$][A-Za-z$]+$/, '');
  // For DAM URLs, upgrade to web-quality JPEG rendition (avoid TIF originals and tiny 170x170 thumbnails)
  if (cleaned.includes('digitalassets.daltile.com') && cleaned.includes('/jcr:content/renditions/')) {
    cleaned = cleaned.replace(/\/jcr:content\/renditions\/[^/]+$/, '/jcr:content/renditions/cq5dam.web.1280.1280.jpeg');
  }
  return cleaned;
}

function isPlaceholderUrl(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  return lower.includes('placeholder') || lower.includes('no-series-image') ||
    lower.includes('no.series') || lower.includes('coming-soon');
}

/**
 * Clean Coveo color name by stripping embedded finish names.
 * e.g., "Matte Balance Matte" → "Balance", "Desert Gray Matte" → "Desert Gray"
 */
function cleanCoveoColor(colorName, finish) {
  if (!colorName) return '';
  let v = colorName.trim();
  v = v.replace(/\s+[A-Z0-9]{8,}$/, '').trim();
  const wrappedMatch = v.match(/^(Matte|Glossy|Polished|Honed|Textured)\s+(.+?)\s+(Matte|Glossy|Polished|Honed|Textured)$/i);
  if (wrappedMatch) return wrappedMatch[2].trim() || v;
  v = v.replace(/\s+(Matte|Glossy|Polished|Honed|Textured|Tumbled|Lappato|Structured|Satin Polished|Light Polished|Superguardx?\s*Technology|Enhanced Urethane)$/i, '').trim();
  v = v.replace(/^(Matte|Glossy|Polished|Honed|Textured)\s+/i, '').trim();
  return v || colorName.trim();
}

/**
 * Normalize product type to a category slug for our DB.
 */
function normalizeProductType(type) {
  if (!type) return null;
  const map = {
    'Floor Tile': 'porcelain-tile', 'Floor Tile Trim': 'porcelain-tile',
    'Floor Tile Deco': 'porcelain-tile',
    'Wall Tile': 'backsplash-tile', 'Wall Tile Trim': 'backsplash-tile',
    'Wall Tile Deco': 'backsplash-tile',
    'Wall Bathroom Accessories': 'backsplash-tile',
    'Mosaic Tile': 'mosaic-tile', 'Mosaic Tile Trim': 'mosaic-tile',
    'Mosaic Natural Stone Tile': 'mosaic-tile',
    'Stone Tile': 'natural-stone', 'Stone Tile Trim': 'natural-stone',
    'Quarry Tile': 'ceramic-tile', 'Quarry Tile Trim': 'ceramic-tile',
    'Porcelain Slab': 'porcelain-slabs',
    'Quartz Slab': 'quartz-countertops',
    'Natural Stone Slab': 'natural-stone',
    'Luxury Vinyl Tile': 'lvp-plank', 'LVT Trim': 'lvp-plank', 'LVT Plank': 'lvp-plank',
    'Windowsills-Thresholds': 'natural-stone',
  };
  return map[type] || 'porcelain-tile';
}

/**
 * Derive the trim type from a product title or type.
 * e.g., "Sterling Bullnose" → "Bullnose", "Quarter Round" → "Quarter Round"
 */
function deriveTrimType(title, productType) {
  const text = `${title || ''} ${productType || ''}`;
  const patterns = [
    [/bullnos[ei]/i, 'Bullnose'],
    [/quarter\s*round/i, 'Quarter Round'],
    [/pencil\s*liner/i, 'Pencil Liner'],
    [/chair\s*rail/i, 'Chair Rail'],
    [/cove\s*base/i, 'Cove Base'],
    [/v[-\s]?cap/i, 'V-Cap'],
    [/mud\s*cap/i, 'Mud Cap'],
    [/jolly/i, 'Jolly Trim'],
    [/s[ei]mming/i, 'Trim'],
    [/liner/i, 'Liner'],
    [/trim/i, 'Trim'],
  ];
  for (const [re, label] of patterns) {
    if (re.test(text)) return label;
  }
  return 'Trim';
}

/**
 * Parse a dimension string (integer, decimal, or fraction) to a number.
 * e.g., "12" → 12, "2.25" → 2.25, "2 3/8" → 2.375, "3/4" → 0.75
 */
function parseDim(s) {
  s = s.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const fracMatch = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (fracMatch) return parseInt(fracMatch[1]) + parseInt(fracMatch[2]) / parseInt(fracMatch[3]);
  const pureFrac = s.match(/^(\d+)\/(\d+)$/);
  if (pureFrac) return parseInt(pureFrac[1]) / parseInt(pureFrac[2]);
  return null;
}

/**
 * Resolve per-SKU size from a combined Coveo size string.
 * Coveo bundles multiple sizes into one field like "12X12, 18X18".
 * The SKU code encodes dimensions after the shape code (e.g., SQU1212MT → 12X12).
 * Returns the matched individual size, or the original combined string if no match.
 */
function resolveSkuSize(coveoSku, combinedSize) {
  if (!combinedSize || !combinedSize.includes(',')) return combinedSize;
  const sizes = combinedSize.split(',').map(s => s.trim()).filter(Boolean);
  if (sizes.length <= 1) return combinedSize;
  const skuUpper = coveoSku.toUpperCase();

  // Method 1: Extract digits after shape code (most precise)
  const shapeMatch = skuUpper.match(/(SQU|RCT|HEX|OCT|BKJ|STJ|CRC|HER|DIA)(\d+)/);
  if (shapeMatch) {
    const skuDigits = shapeMatch[2];
    for (const size of sizes) {
      // Integer sizes: "12X24" → "1224"
      const intMatch = size.match(/^(\d+)\s*[Xx]\s*(\d+)$/);
      if (intMatch && (intMatch[1] + intMatch[2]) === skuDigits) return size;
      // Decimal/fractional sizes: try floor/ceil/round combos
      const decMatch = size.match(/^([\d\s\/.]+)\s*[Xx]\s*([\d\s\/.]+)$/);
      if (decMatch) {
        const w = parseDim(decMatch[1]), h = parseDim(decMatch[2]);
        if (w != null && h != null) {
          for (const wi of new Set([Math.floor(w), Math.ceil(w), Math.round(w)])) {
            for (const hi of new Set([Math.floor(h), Math.ceil(h), Math.round(h)])) {
              if (`${wi}${hi}` === skuDigits) return size;
            }
          }
        }
      }
    }
  }

  // Method 2: Substring match on full SKU, longer digit sequences first
  const candidates = sizes
    .map(s => {
      const m = s.match(/^(\d+)\s*[Xx]\s*(\d+)$/);
      return m ? { size: s, digits: m[1] + m[2] } : null;
    })
    .filter(c => c && c.digits.length >= 2)
    .sort((a, b) => b.digits.length - a.digits.length);
  for (const c of candidates) {
    if (skuUpper.includes(c.digits)) return c.size;
  }

  // Method 3: Derive size from shape code digits even when not in available sizes.
  // Coveo sometimes bundles SKUs with the wrong size group, but the SKU code is correct.
  if (shapeMatch) {
    const derived = deriveSizeFromDigits(shapeMatch[2]);
    if (derived) return derived;
  }

  return combinedSize;
}

/**
 * Derive a tile size string from the digit portion of a SKU shape code.
 * e.g., "28" → "2X8", "412" → "4X12", "1224" → "12X24"
 * Returns null if the digits can't be parsed to a valid tile size.
 */
function deriveSizeFromDigits(digits) {
  const len = digits.length;
  if (len < 2 || len > 4) return null;

  const trySplit = (w, h) => {
    const wi = parseInt(w), hi = parseInt(h);
    if (wi >= 1 && wi <= 48 && hi >= 1 && hi <= 96) return `${wi}X${hi}`;
    return null;
  };

  if (len === 2) {
    // "28" → 2X8, "44" → 4X4, "36" → 3X6
    return trySplit(digits[0], digits[1]);
  }
  if (len === 3) {
    // Try 1+2 first (4X12, 6X18, 8X24), then 2+1 (15X3, etc.)
    return trySplit(digits[0], digits.slice(1)) || trySplit(digits.slice(0, 2), digits[2]);
  }
  if (len === 4) {
    // "1212" → 12X12, "1224" → 12X24, "1530" → 15X30
    return trySplit(digits.slice(0, 2), digits.slice(2));
  }
  return null;
}

/**
 * Try to fix per-SKU Scene7 image URL by replacing the size in the URL
 * with the resolved per-SKU size. Returns the original URL if no fix needed.
 */
function resolveSkuImageUrl(imageUrl, resolvedSize, combinedSize) {
  if (!imageUrl || !resolvedSize || resolvedSize === combinedSize) return imageUrl;
  if (!combinedSize || !combinedSize.includes(',')) return imageUrl;

  // Extract the size embedded in the Scene7 URL (e.g., "12x24", "6x6")
  const urlSizeMatch = imageUrl.match(/(\d+)x(\d+)/i);
  if (!urlSizeMatch) return imageUrl;
  const urlSize = `${urlSizeMatch[1]}X${urlSizeMatch[2]}`;

  // If URL already has the resolved size, no change needed
  const resolvedClean = resolvedSize.replace(/\s/g, '').toUpperCase();
  if (urlSize.toUpperCase() === resolvedClean) return imageUrl;

  // Replace the size in the URL with the resolved size (lowercase for Scene7 convention)
  const sizeMatch = resolvedSize.match(/^(\d+)\s*[Xx]\s*(\d+)$/);
  if (!sizeMatch) return imageUrl;
  const newSizeStr = `${sizeMatch[1]}x${sizeMatch[2]}`;
  return imageUrl.replace(/\d+x\d+/i, newSizeStr);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`build-daltile-product-map.cjs — fetching from ${DOMAIN}`);
  console.log('─'.repeat(60));

  const allResults = await fetchAllCoveoResults(DOMAIN);
  console.log(`\nFetched ${allResults.length} total Coveo results`);

  if (allResults.length === 0) {
    console.error('No results from Coveo API. Check domain or API availability.');
    process.exit(1);
  }

  // Group by series → color → SKUs
  const seriesMap = {};
  let totalSkus = 0;
  let totalAccessorySkus = 0;
  let totalProducts = 0;

  for (const item of allResults) {
    const rawSku = getField(item, 'sku');
    if (!rawSku) continue;

    const seriesName = getField(item, 'seriesname');
    const colorName = getField(item, 'colornameenglish');
    const colorCode = getField(item, 'colorcode');
    const size = getField(item, 'nominalsize');
    const finish = getField(item, 'finish');
    const designPattern = getField(item, 'designpattern');
    const shape = getField(item, 'productshape');
    const productType = getField(item, 'producttype');
    const bodyType = getField(item, 'bodytype');
    const productImageUrl = getField(item, 'productimageurl');
    const swatchUrl = getField(item, 'productswatchurl');
    const roomSceneUrl = getField(item, 'primaryroomsceneurl');
    const pdpUrl = getField(item, 'pdpurl');
    const seriesPageUrl = getField(item, 'seriespageurl');
    const thickness = getField(item, 'nominalthickness');
    const colorFamily = getField(item, 'colorfamilyname');
    const shadeVariation = getField(item, 'shadevariation');
    const country = getField(item, 'countryofmanufacture');

    if (!seriesName) continue;

    // Initialize series
    if (!seriesMap[seriesName]) {
      seriesMap[seriesName] = {
        category: normalizeProductType(productType),
        seriespageurl: seriesPageUrl || '',
        products: {},
        accessories: {},
      };
    }
    const series = seriesMap[seriesName];

    // Update category if we get a more specific one
    if (productType && !series.category) {
      series.category = normalizeProductType(productType);
    }
    if (seriesPageUrl && !series.seriespageurl) {
      series.seriespageurl = seriesPageUrl;
    }

    const isTrim = TRIM_TYPES.has(productType);

    // Split multi-SKU entries (semicolon-delimited)
    const skuList = rawSku.split(/[;,]/).map(s => s.trim()).filter(Boolean);

    // Clean image URLs
    const cleanedImageUrl = productImageUrl && !isPlaceholderUrl(productImageUrl)
      ? cleanScene7Url(productImageUrl) : '';
    const cleanedSwatchUrl = swatchUrl && !isPlaceholderUrl(swatchUrl)
      ? cleanScene7Url(swatchUrl) : '';
    const cleanedRoomUrl = roomSceneUrl && !isPlaceholderUrl(roomSceneUrl)
      ? cleanScene7Url(roomSceneUrl) : '';

    // Clean the color name
    const cleanedColor = cleanCoveoColor(colorName, finish) || colorName;

    for (const coveoSku of skuList) {
      // Resolve per-SKU size from combined size string (e.g., "12X12, 18X18" → "12X12")
      const resolvedSize = resolveSkuSize(coveoSku, size);
      // Fix Scene7 image URL to match the resolved size
      const resolvedImageUrl = resolveSkuImageUrl(cleanedImageUrl, resolvedSize, size);

      const skuEntry = {
        coveoSku,
        size: resolvedSize || '',
        finish: finish || '',
        designPattern: designPattern || '',
        shape: shape || '',
        productType: productType || '',
        bodyType: bodyType || '',
        thickness: thickness || '',
        shadeVariation: shadeVariation || '',
        country: country || '',
        productImageUrl: resolvedImageUrl,
        swatchUrl: cleanedSwatchUrl,
        roomSceneUrl: cleanedRoomUrl,
        pdpUrl: pdpUrl || '',
      };

      if (isTrim) {
        // Accessory — group by color+trimType within series
        const trimType = deriveTrimType(cleanedColor, productType);
        const accKey = cleanedColor ? `${cleanedColor} ${trimType}` : trimType;

        if (!series.accessories[accKey]) {
          series.accessories[accKey] = {
            colorcode: colorCode || '',
            colorFamily: colorFamily || '',
            skus: [],
          };
        }
        skuEntry.trimType = trimType;
        series.accessories[accKey].skus.push(skuEntry);
        totalAccessorySkus++;
      } else {
        // Main product — group by cleaned color name
        const productKey = cleanedColor || 'Default';

        if (!series.products[productKey]) {
          series.products[productKey] = {
            colorcode: colorCode || '',
            colorFamily: colorFamily || '',
            skus: [],
          };
          totalProducts++;
        }
        // Update colorcode if we didn't have one
        if (colorCode && !series.products[productKey].colorcode) {
          series.products[productKey].colorcode = colorCode;
        }
        series.products[productKey].skus.push(skuEntry);
        totalSkus++;
      }
    }
  }

  const seriesCount = Object.keys(seriesMap).length;

  // Build output
  const output = {
    generated: new Date().toISOString(),
    domain: DOMAIN,
    summary: {
      series: seriesCount,
      products: totalProducts,
      skus: totalSkus,
      accessories: totalAccessorySkus,
    },
    series: seriesMap,
  };

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Product map written to ${OUTPUT_PATH}`);
  console.log(`  Series: ${seriesCount}`);
  console.log(`  Products (series+color combos): ${totalProducts}`);
  console.log(`  SKUs (main variants): ${totalSkus}`);
  console.log(`  Accessory SKUs: ${totalAccessorySkus}`);
  console.log(`  File size: ${(fs.statSync(OUTPUT_PATH).size / 1024 / 1024).toFixed(1)} MB`);

  // Show top 10 series by product count
  const seriesBySize = Object.entries(seriesMap)
    .map(([name, data]) => ({ name, products: Object.keys(data.products).length, skus: Object.values(data.products).reduce((sum, p) => sum + p.skus.length, 0) }))
    .sort((a, b) => b.products - a.products)
    .slice(0, 10);
  console.log(`\nTop 10 series by product count:`);
  for (const s of seriesBySize) {
    console.log(`  ${s.name}: ${s.products} products, ${s.skus} SKUs`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
