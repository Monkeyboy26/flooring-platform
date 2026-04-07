import {
  delay, appendLog, addJobError,
  upsertMediaAsset, saveProductImages,
} from './base.js';

const BASE_URL = 'https://usa.sika.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 100;

// ──────────────────────────────────────────────
// Static URL map: normalized slug → full page path on usa.sika.com
// ──────────────────────────────────────────────

const PRODUCT_URL_MAP = {
  // ── Flooring Adhesives (SikaBond) ──
  'sikabond-t17':   '/en/construction/floor-covering/flooring-adhesives.list.html/products/sikabond-t17.html',
  'sikabond-t21':   '/en/construction/floor-covering/flooring-adhesives.list.html/products/sikabond-t21.html',
  'sikabond-t25':   '/en/construction/floor-covering/flooring-adhesives.list.html/products/sikabond-t25.html',
  'sikabond-t35':   '/en/industry/products-solutions/adhesives-and-sealants/sikabond/sikabond-t35.html',
  'sikabond-t-53':  '/en/construction/floor-covering/flooring-adhesives.list.html/products/sikabond-t-53.html',
  'sikabond-t53':   '/en/construction/floor-covering/flooring-adhesives.list.html/products/sikabond-t-53.html',
  'sikabond-t55':   '/en/construction/floor-covering/flooring-adhesives.list.html/products/sikabond-t55.html',
  'sikabond-t100':  '/en/construction/floor-covering/flooring-adhesives.list.html/products/sikabond-t100.html',
  'sikabond-5800':  '/en/construction-products/flooring-adhesives/resilient-flooringadhesives/sikabond-5800.html',
  'sikabond-5900':  '/en/construction-products/flooring-adhesives/resilient-flooringadhesives/sikabond-5900.html',

  // ── Tile & Stone — Grouts ──
  'sikatile-800-sandedgrout':        '/en/construction/floor-covering/tile-stone-installation/grouts/sikatile-800-sandedgrout.html',
  'sikatile-800-sanded-grout':       '/en/construction/floor-covering/tile-stone-installation/grouts/sikatile-800-sandedgrout.html',
  'sikatile-800-unsandedgrout':      '/en/construction/floor-covering/tile-stone-installation/grouts/sikatile-800-unsandedgrout.html',
  'sikatile-800-unsanded-grout':     '/en/construction/floor-covering/tile-stone-installation/grouts/sikatile-800-unsandedgrout.html',
  'sikatile-815-securegrout':        '/en/construction/floor-covering/tile-stone-installation/grouts/sikatile-815-securegrout.html',
  'sikatile-815-secure-grout':       '/en/construction/floor-covering/tile-stone-installation/grouts/sikatile-815-securegrout.html',
  'sikatile-825-epoxygrout':        '/en/construction/floor-covering/tile-stone-installation/grouts/sikatile-825-epoxygrout.html',
  'sikatile-825-epoxy-grout':       '/en/construction/floor-covering/tile-stone-installation/grouts/sikatile-825-epoxygrout.html',
  'sikatile-885-securesiliconecaulk': '/en/construction/floor-covering/tile-stone-installation/grouts/sikatile-885-securesiliconecaulk.html',
  'sikatile-885-secure-silicone-caulk': '/en/construction/floor-covering/tile-stone-installation/grouts/sikatile-885-securesiliconecaulk.html',
  'sikatile-890-revive':             '/en/construction/floor-covering/tile-stone-installation/grouts/sikatile-890-revive.html',
  'sikatile-ultima-grout':           '/en/construction/floor-covering/tile-stone-installation/grouts/sikatile-ultima-grout.html',

  // ── Tile & Stone — Adhesives ──
  'sikatile-300-set':                '/en/construction/floor-covering/tile-stone-installation/adhesives/sikatile-300-set.html',
  'sikatile-425-lhtsecuresetrapid':  '/en/construction/floor-covering/tile-stone-installation/sikatile-425-lhtsecuresetrapid.html',
  'sikatile-425-lht-secure-set-rapid': '/en/construction/floor-covering/tile-stone-installation/sikatile-425-lhtsecuresetrapid.html',
  'sikatile-500-lhtlite':           '/en/construction/floor-covering/tile-stone-installation/adhesives/sikatile-500-lhtlite.html',
  'sikatile-500-lht-lite':          '/en/construction/floor-covering/tile-stone-installation/adhesives/sikatile-500-lhtlite.html',

  // ── Tile & Stone — Surface Prep / Membranes ──
  'sikatile-100-moistureguard':      '/en/construction/floor-covering/tile-stone-installation/surface-preparation.list.html/products/sikatile-100-moistureguard.html',
  'sikatile-100-moisture-guard':     '/en/construction/floor-covering/tile-stone-installation/surface-preparation.list.html/products/sikatile-100-moistureguard.html',
  'sikatile-190-reinforcingfabric':  '/en/construction/floor-covering/tile-stone-installation/surface-preparation/sikatile-190-reinforcingfabric.html',
  'sikatile-190-reinforcing-fabric': '/en/construction/floor-covering/tile-stone-installation/surface-preparation/sikatile-190-reinforcingfabric.html',
  'sikatile-200-fractureguardrapid': '/en/construction/floor-covering/tile-stone-installation/surface-preparation.list.html/products/sikatile-200-fractureguardrapid.html',
  'sikatile-200-fracture-guard-rapid': '/en/construction/floor-covering/tile-stone-installation/surface-preparation.list.html/products/sikatile-200-fractureguardrapid.html',
  'sikatile-700-soundshieldpns':     '/en/construction/floor-covering/tile-stone-installation/surface-preparation.list.html/products/sikatile-700-soundshieldpns.html',
  'sikatile-700-sound-shield-pns':   '/en/construction/floor-covering/tile-stone-installation/surface-preparation.list.html/products/sikatile-700-soundshieldpns.html',

  // ── Levelers & Patches ──
  'sika-level-125':       '/en/construction/floor-covering/flooring-levelers-patches.list.html/products/sika-level-125.html',
  'sika-level-225':       '/en/construction/floor-covering/flooring-levelers-patches.list.html/products/sika-level-225.html',
  'sika-level-325':       '/en/construction/floor-covering/flooring-levelers-patches.list.html/products/sika-level-325.html',
  'sika-level-skimcoat':  '/en/construction/floor-covering/flooring-levelers-patches.list.html/products/sika-level-skimcoat.html',
  'sika-level-skim-coat': '/en/construction/floor-covering/flooring-levelers-patches.list.html/products/sika-level-skimcoat.html',
  'sikalevel-025-patch':  '/en/construction/floor-covering/flooring-levelers-patches.list.html/products/sikalevel-025-patch.html',
  'sika-level-025-patch': '/en/construction/floor-covering/flooring-levelers-patches.list.html/products/sikalevel-025-patch.html',
  'sikaquick-1000':       '/en/construction/floor-covering/flooring-levelers-patches.list.html/products/sikaquick-1000.html',
  'sika-quick-1000':      '/en/construction/floor-covering/flooring-levelers-patches.list.html/products/sikaquick-1000.html',

  // ── Primers & Moisture Barriers ──
  'sika-mb':              '/en/construction/floor-covering/flooring-primers-moisture-barriers/sika-mb.html',
  'sika-mb-redline':      '/en/construction/floor-covering/flooring-primers-moisture-barriers/sika-mb-redline.html',
  'sika-mb-red-line':     '/en/construction/floor-covering/flooring-primers-moisture-barriers/sika-mb-redline.html',
  'sika-mb-ez-rapid':     '/en/construction/floor-covering/flooring-primers-moisture-barriers/sika-mb-ez-rapid.html',
  'sika-level-01-primerplus':  '/en/construction/floor-covering/flooring-primers-moisture-barriers/sika-level-01-primerplus.html',
  'sika-level-01-primer-plus': '/en/construction/floor-covering/flooring-primers-moisture-barriers/sika-level-01-primerplus.html',
  'sika-level-02-ezprimer':    '/en/construction/floor-covering/flooring-primers-moisture-barriers/sika-level-02-ezprimer.html',
  'sika-level-02-ez-primer':   '/en/construction/floor-covering/flooring-primers-moisture-barriers/sika-level-02-ezprimer.html',

  // ── Short-name aliases (ST prefix in DB → full SikaTile product) ──
  'st-800-sanded-grout':    '/en/construction/floor-covering/tile-stone-installation/grouts/sikatile-800-sandedgrout.html',
  'st-800-unsanded-grout':  '/en/construction/floor-covering/tile-stone-installation/grouts/sikatile-800-unsandedgrout.html',
  'st-815-secure-grout':    '/en/construction/floor-covering/tile-stone-installation/grouts/sikatile-815-securegrout.html',
  'st-825-epoxy-grout':     '/en/construction/floor-covering/tile-stone-installation/grouts/sikatile-825-epoxygrout.html',
  'st-885-secure-silicone-caulk': '/en/construction/floor-covering/tile-stone-installation/grouts/sikatile-885-securesiliconecaulk.html',
  'st-890-revive':          '/en/construction/floor-covering/tile-stone-installation/grouts/sikatile-890-revive.html',

  // ── Other Sika products ──
  'sikalayer-03':        '/en/construction/floor-covering/flooring-underlayments/sikalayer-03.html',
  'sika-layer-03':       '/en/construction/floor-covering/flooring-underlayments/sikalayer-03.html',
  'sikaflex-self-leveling-sealant': '/en/construction/floor-covering/flooring-adhesives.list.html/products/sikaflex-self-leveling-sealant.html',
};

// ──────────────────────────────────────────────
// Name-to-slug normalization
// ──────────────────────────────────────────────

/**
 * Derive a URL-friendly slug from a DB product name.
 * Strips size/weight suffixes, parenthetical notes, and normalizes to hyphenated lowercase.
 *
 * Examples:
 *   "Sikabond T21 4-gallon"              → "sikabond-t21"
 *   "Sikatile 800 Sanded Grout 25lb"     → "sikatile-800-sanded-grout"
 *   "Sika Level-325 ( 55lb/bag )"        → "sika-level-325"
 *   "Sika Mb Ez Rapid 2.5 Gallon"        → "sika-mb-ez-rapid"
 *   "ST 800 Sanded Grout Bone 25 Lb"     → "st-800-sanded-grout"
 */
function deriveSlug(productName) {
  let name = productName.toLowerCase().trim();

  // Strip parenthetical content: "( 55lb/bag )"
  name = name.replace(/\s*\([^)]*\)\s*/g, ' ');

  // Strip color names that appear before size — for grout products with color in the name
  // e.g., "ST 800 Sanded Grout Bone 25 Lb" → strip "Bone" (the color) and "25 Lb"
  // We do this by stripping everything after the product descriptor for known grout/caulk patterns
  const groutMatch = name.match(/^((?:sikatile|st)\s+\d+\s+(?:sanded\s+grout|unsanded\s+grout|secure\s*grout|epoxy\s*grout|secure\s*silicone\s*caulk|revive|ultima\s*grout))/);
  if (groutMatch) {
    name = groutMatch[1];
  } else {
    // Strip size/weight suffixes: "25lb", "50lb", "1 gallon", "4-gallon", "2.5 Gallon", etc.
    name = name.replace(/\s+\d+[\s.-]*(lb|lbs|gallon|gal|pail|oz|quart|pint|bag|sqft|sf|roll|ct)\b.*$/i, '');
    // Strip decimal sizes: "2.5 gallon"
    name = name.replace(/\s+\d+\.\d+\s*(gallon|gal|lb|lbs|oz).*$/i, '');
    // Strip quantity suffixes: "2 Gallon Kit", "1 Pcs Per Box"
    name = name.replace(/\s+\d+\s*(each|per|pcs|piece|pk|kit).*$/i, '');
  }

  // Normalize to slug: spaces/special chars → hyphens, collapse, trim
  name = name.replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  return name;
}

/**
 * Try to resolve a product name to a website URL path.
 * Attempts the derived slug directly, plus common variations.
 */
function resolveUrl(productName) {
  const slug = deriveSlug(productName);
  if (!slug) return null;

  // Direct lookup
  if (PRODUCT_URL_MAP[slug]) return PRODUCT_URL_MAP[slug];

  // Try collapsed variant (no hyphens between words except brand-number):
  // e.g., "sikatile-800-sanded-grout" → "sikatile-800-sandedgrout"
  const collapsed = slug.replace(/(\d+)-([a-z])/, '$1-$2')
    .replace(/-([a-z]+)-([a-z]+)$/, '-$1$2')      // collapse last two words
    .replace(/-([a-z]+)-([a-z]+)-([a-z]+)$/, '-$1$2$3'); // collapse last three
  if (PRODUCT_URL_MAP[collapsed]) return PRODUCT_URL_MAP[collapsed];

  // Try removing "sika-" prefix variations
  // e.g., "sika-bond-t21" → "sikabond-t21"
  const noDash = slug.replace(/^sika-/, 'sika');
  if (PRODUCT_URL_MAP[noDash]) return PRODUCT_URL_MAP[noDash];

  // Try adding "sika" prefix for short names
  // e.g., "level-325" → "sika-level-325"
  if (!slug.startsWith('sika')) {
    const withPrefix = 'sika-' + slug;
    if (PRODUCT_URL_MAP[withPrefix]) return PRODUCT_URL_MAP[withPrefix];
    const withPrefixCollapsed = 'sika' + slug;
    if (PRODUCT_URL_MAP[withPrefixCollapsed]) return PRODUCT_URL_MAP[withPrefixCollapsed];
  }

  return null;
}

// ──────────────────────────────────────────────
// HTTP fetching
// ──────────────────────────────────────────────

async function httpGet(url) {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────
// HTML extraction (regex-based)
// ──────────────────────────────────────────────

/**
 * Extract description from HTML page.
 * Tries og:description, then meta description, then first content paragraph.
 */
function extractDescription(html) {
  // 1. og:description
  const ogMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i)
    || html.match(/<meta\s+content="([^"]+)"\s+property="og:description"/i);
  if (ogMatch) {
    const desc = decodeHtmlEntities(ogMatch[1]).trim();
    if (desc.length > 30 && !desc.toLowerCase().includes('page not found')) {
      return desc.slice(0, 2000);
    }
  }

  // 2. meta description
  const metaMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)
    || html.match(/<meta\s+content="([^"]+)"\s+name="description"/i);
  if (metaMatch) {
    const desc = decodeHtmlEntities(metaMatch[1]).trim();
    if (desc.length > 30 && !desc.toLowerCase().includes('page not found')) {
      return desc.slice(0, 2000);
    }
  }

  // 3. First substantial paragraph in content area
  const paraPattern = /<p[^>]*class="[^"]*(?:description|intro|lead|summary)[^"]*"[^>]*>([\s\S]*?)<\/p>/i;
  const paraMatch = html.match(paraPattern);
  if (paraMatch) {
    const text = stripHtml(paraMatch[1]).trim();
    if (text.length > 30) return text.slice(0, 2000);
  }

  return null;
}

/**
 * Extract image URLs from HTML page.
 * Tries og:image, Scene7 CDN, PIM images.
 */
function extractImages(html) {
  const images = [];
  const seen = new Set();

  function addImage(url) {
    if (!url || typeof url !== 'string') return;
    // Ensure absolute URL
    let fullUrl = url.startsWith('//') ? 'https:' + url : url;
    if (!fullUrl.startsWith('http')) return;
    // Ensure HTTPS
    fullUrl = fullUrl.replace(/^http:/, 'https:');
    // Deduplicate by base path (without query params)
    const base = fullUrl.split('?')[0].toLowerCase();
    if (seen.has(base)) return;
    // Filter junk
    const lower = base;
    if (lower.includes('logo') || lower.includes('icon') || lower.includes('favicon')
      || lower.includes('placeholder') || lower.includes('1x1') || lower.includes('pixel')
      || lower.includes('tracking') || lower.includes('sprite') || lower.includes('spacer')
      || lower.includes('arrow') || lower.includes('chevron') || lower.includes('spinner')) return;
    seen.add(base);
    images.push(fullUrl);
  }

  // 1. og:image meta tag (highest priority — curated by Sika)
  const ogMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)
    || html.match(/<meta\s+content="([^"]+)"\s+property="og:image"/i);
  if (ogMatch) addImage(ogMatch[1]);

  // 2. Scene7 CDN images (sika.scene7.com)
  const scene7Pattern = /https?:\/\/sika\.scene7\.com\/is\/image\/sikacs\/[^"'\s<>)]+/gi;
  let match;
  while ((match = scene7Pattern.exec(html)) !== null) {
    addImage(match[0]);
  }

  // 3. PIM images (pim2.sika.com)
  const pimPattern = /https?:\/\/pim2\.sika\.com\/medias\/[^"'\s<>)]+\.(?:jpg|jpeg|png|webp)/gi;
  while ((match = pimPattern.exec(html)) !== null) {
    addImage(match[0]);
  }

  // 4. Other sika.com hosted images in content area
  const sikaImgPattern = /https?:\/\/[^"'\s<>)]*usa\.sika\.com[^"'\s<>)]*\.(?:jpg|jpeg|png|webp)/gi;
  while ((match = sikaImgPattern.exec(html)) !== null) {
    addImage(match[0]);
  }

  return images;
}

/**
 * Extract PDF links from HTML page.
 * Focuses on product data sheets and safety data sheets under /dam/dms/.
 */
function extractPdfs(html) {
  const pdfs = [];
  const seen = new Set();

  // Pattern 1: /dam/dms/ paths (Sika's document management system)
  const damPattern = /(?:https?:\/\/[^"'\s<>]*)?\/dam\/dms\/[^"'\s<>]+\.pdf/gi;
  let match;
  while ((match = damPattern.exec(html)) !== null) {
    let url = match[0];
    if (!url.startsWith('http')) url = BASE_URL + url;
    url = url.replace(/^http:/, 'https:');
    const lower = url.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      pdfs.push(url);
    }
  }

  // Pattern 2: General PDF links on sika.com
  const pdfLinkPattern = /href="([^"]*\.pdf)"/gi;
  while ((match = pdfLinkPattern.exec(html)) !== null) {
    let url = match[1];
    if (!url.startsWith('http')) url = BASE_URL + url;
    url = url.replace(/^http:/, 'https:');
    const lower = url.toLowerCase();
    if (!seen.has(lower) && lower.includes('sika')) {
      seen.add(lower);
      pdfs.push(url);
    }
  }

  // Filter to product-relevant PDFs (PDS, SDS, TDS, specs)
  const SPEC_KEYWORDS = ['pds', 'sds', 'tds', 'spec', 'technical', 'data-sheet', 'datasheet',
    'product-data', 'safety-data', 'install', 'guide', 'brochure'];

  return pdfs.filter(url => {
    const lower = url.toLowerCase();
    // Accept all /dam/dms/ PDFs (Sika's standard doc path)
    if (lower.includes('/dam/dms/')) return true;
    // Otherwise, require a spec keyword
    return SPEC_KEYWORDS.some(kw => lower.includes(kw));
  });
}

/**
 * Decode common HTML entities.
 */
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&reg;/g, '®')
    .replace(/&trade;/g, '™');
}

/**
 * Strip HTML tags from a string.
 */
function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ──────────────────────────────────────────────
// Main scraper entry point
// ──────────────────────────────────────────────

/**
 * Sika enrichment scraper for Tri-West — HTTP-only (no Puppeteer).
 *
 * Strategy:
 * 1. Load all Sika products from DB (collection ILIKE '%Sika%')
 * 2. Derive a slug from each product name and look up in static PRODUCT_URL_MAP
 * 3. Group products by resolved URL (many products map to the same page)
 * 4. Fetch each unique page via HTTP GET
 * 5. Extract images, description, and spec PDFs via regex
 * 6. Enrich matched DB products (COALESCE — never overwrite existing data)
 *
 * Merkrete products (~44) are skipped — legacy sub-brand not on usa.sika.com.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 800;
  const vendor_id = source.vendor_id;

  // Counters
  let totalProducts = 0;
  let totalMatched = 0;
  let totalEnriched = 0;
  let totalSkipped = 0;
  let totalImagesAdded = 0;
  let totalPdfsAdded = 0;
  let errorCount = 0;

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { }
    }
  }

  try {
    // ── Phase 1: Load Sika products from DB ──
    const prodResult = await pool.query(`
      SELECT p.id AS product_id, p.name, p.collection,
             p.description_short, p.description_long
      FROM products p
      WHERE p.vendor_id = $1
        AND (p.collection ILIKE '%sika%' OR p.name ILIKE 'sika%' OR p.name ILIKE 'ST %')
      ORDER BY p.name
    `, [vendor_id]);

    totalProducts = prodResult.rows.length;
    await appendLog(pool, job.id, `Found ${totalProducts} Sika products in DB`);
    if (totalProducts === 0) return;

    // ── Check existing media assets ──
    const productIds = prodResult.rows.map(r => r.product_id);
    const existingImages = await pool.query(`
      SELECT DISTINCT product_id FROM media_assets
      WHERE product_id = ANY($1::uuid[]) AND asset_type = 'primary' AND sku_id IS NULL
    `, [productIds]);
    const productsWithImages = new Set(existingImages.rows.map(r => r.product_id));

    const existingPdfs = await pool.query(`
      SELECT DISTINCT product_id FROM media_assets
      WHERE product_id = ANY($1::uuid[]) AND asset_type = 'spec_pdf'
    `, [productIds]);
    const productsWithPdfs = new Set(existingPdfs.rows.map(r => r.product_id));

    await appendLog(pool, job.id,
      `${productsWithImages.size} already have images, ${productsWithPdfs.size} have PDFs`
    );

    // ── Phase 2: Map products to website URLs ──
    // Group products by their resolved URL. Many DB products (size variants) share one page.
    const urlGroups = new Map(); // url → [{ product_id, name, ... }]
    const skippedProducts = [];

    for (const row of prodResult.rows) {
      // Skip Merkrete products (legacy sub-brand, not on usa.sika.com)
      if (row.name.toLowerCase().startsWith('merkrete') || row.collection?.toLowerCase().includes('merkrete')) {
        skippedProducts.push(row.name);
        totalSkipped++;
        continue;
      }

      const urlPath = resolveUrl(row.name);
      if (!urlPath) {
        skippedProducts.push(row.name);
        totalSkipped++;
        continue;
      }

      totalMatched++;
      const fullUrl = BASE_URL + urlPath;
      if (!urlGroups.has(fullUrl)) urlGroups.set(fullUrl, []);
      urlGroups.get(fullUrl).push(row);
    }

    await appendLog(pool, job.id,
      `Matched ${totalMatched} products to ${urlGroups.size} unique URLs | ${totalSkipped} skipped (Merkrete/unmapped)`
    );

    if (skippedProducts.length > 0 && skippedProducts.length <= 20) {
      await appendLog(pool, job.id, `Skipped: ${skippedProducts.join(', ')}`);
    } else if (skippedProducts.length > 20) {
      await appendLog(pool, job.id, `Skipped ${skippedProducts.length} products (Merkrete + unmapped)`);
    }

    // ── Phase 3: Fetch & Enrich ──
    let urlIdx = 0;
    const totalUrls = urlGroups.size;

    for (const [url, products] of urlGroups) {
      urlIdx++;

      // Check if ALL products in this group already have images + descriptions
      const allHaveImages = products.every(p => productsWithImages.has(p.product_id));
      const allHaveDescs = products.every(p => p.description_long);
      const allHavePdfs = products.every(p => productsWithPdfs.has(p.product_id));
      if (allHaveImages && allHaveDescs && allHavePdfs) {
        continue; // all enriched already
      }

      try {
        const html = await httpGet(url);
        if (!html) {
          await logError(`Failed to fetch: ${url}`);
          await delay(delayMs);
          continue;
        }

        // Extract data from page
        const description = extractDescription(html);
        const images = extractImages(html);
        const pdfs = extractPdfs(html);

        // Apply enrichment to all products mapped to this URL
        for (const product of products) {
          let enriched = false;

          // Update description (COALESCE — never overwrite)
          if (description && !product.description_long) {
            await pool.query(
              'UPDATE products SET description_long = $1 WHERE id = $2 AND description_long IS NULL',
              [description, product.product_id]
            );
            enriched = true;
          }

          // Also set description_short if empty (use first sentence)
          if (description && !product.description_short) {
            const short = description.split(/\.\s/)[0];
            if (short && short.length >= 20 && short.length <= 500) {
              await pool.query(
                'UPDATE products SET description_short = $1 WHERE id = $2 AND description_short IS NULL',
                [short.endsWith('.') ? short : short + '.', product.product_id]
              );
            }
          }

          // Save images (product-level — shared across all size/color SKUs)
          if (images.length > 0 && !productsWithImages.has(product.product_id)) {
            const saved = await saveProductImages(pool, product.product_id, images, { maxImages: 4 });
            totalImagesAdded += saved;
            productsWithImages.add(product.product_id); // mark so we don't re-save for sibling products
            enriched = true;
          }

          // Save spec PDFs
          if (pdfs.length > 0 && !productsWithPdfs.has(product.product_id)) {
            for (let i = 0; i < pdfs.length && i < 5; i++) {
              await upsertMediaAsset(pool, {
                product_id: product.product_id,
                sku_id: null,
                asset_type: 'spec_pdf',
                url: pdfs[i],
                original_url: pdfs[i],
                sort_order: i,
              });
              totalPdfsAdded++;
            }
            productsWithPdfs.add(product.product_id);
            enriched = true;
          }

          if (enriched) totalEnriched++;
        }

        await delay(delayMs);
      } catch (err) {
        await logError(`Error processing ${url}: ${err.message}`);
      }

      // Progress log every 10 URLs
      if (urlIdx % 10 === 0 || urlIdx === totalUrls) {
        await appendLog(pool, job.id,
          `Progress: ${urlIdx}/${totalUrls} URLs | enriched: ${totalEnriched} | ` +
          `images: ${totalImagesAdded}, PDFs: ${totalPdfsAdded}, errors: ${errorCount}`
        );
      }
    }

    // ── Final summary ──
    await appendLog(pool, job.id,
      `Complete. ${totalProducts} products | ${totalMatched} matched → ${totalEnriched} enriched | ` +
      `${totalImagesAdded} images, ${totalPdfsAdded} PDFs | ${totalSkipped} skipped | ${errorCount} errors`,
      { products_found: totalProducts, products_updated: totalEnriched }
    );

  } catch (err) {
    await logError(`Fatal: ${err.message}`);
    throw err;
  }
}
