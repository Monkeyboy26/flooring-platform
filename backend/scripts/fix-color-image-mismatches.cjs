#!/usr/bin/env node
/**
 * fix-color-image-mismatches.cjs — Fix products whose primary/alternate/lifestyle
 * images show a different color variant than the product name indicates.
 *
 * Examples of mismatches this fixes:
 *   "Eramosa Ivory"  has URL containing "white-eramosa" (white != ivory)
 *   "Montauk Black"  has URL containing "montauk-blue"  (blue != black)
 *   "Seahorse Blue"  has URL containing "Seahorse-Medium-Red" (red != blue)
 *
 * Fix strategies (in priority order):
 *   1. Direct URL color replacement — swap wrong color word with correct, HEAD verify
 *   2. MSI CDN pattern construction — build URLs from product/collection name in MSI CDN patterns
 *   3. Sibling swap — if two products in same collection have each other's images
 *   4. Sibling pattern — derive correct URL from a sibling's URL pattern
 *
 * Usage:
 *   node backend/scripts/fix-color-image-mismatches.cjs --dry-run   # Preview (default)
 *   node backend/scripts/fix-color-image-mismatches.cjs --execute    # Apply changes
 */

const { Pool } = require('pg');
const https = require('https');
const http = require('http');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = !process.argv.includes('--execute');

// ─── Color Configuration ─────────────────────────────────────────────────────

const COLORS = [
  'taupe', 'white', 'red', 'ivory', 'black', 'gray', 'grey', 'beige', 'brown',
  'blue', 'green', 'gold', 'silver', 'cream', 'charcoal', 'walnut', 'oak',
  'sand', 'rust', 'copper', 'bronze',
];

// gray/grey are equivalent — not a mismatch
const EQUIVALENT_PAIRS = [['gray', 'grey']];

function areEquivalent(c1, c2) {
  if (c1 === c2) return true;
  for (const pair of EQUIVALENT_PAIRS) {
    if ((pair[0] === c1 && pair[1] === c2) || (pair[0] === c2 && pair[1] === c1)) return true;
  }
  return false;
}

// Words that contain a color as a substring but are NOT that color
const FALSE_POSITIVE_WORDS = [
  'reducer', 'credenza', 'redwood', 'sacred', 'shredded', 'centered', 'altered',
  'filtered', 'bordered', 'rendered', 'ordered', 'powered', 'layered', 'covered',
  'discovered', 'delivered', 'recovered', 'textured', 'structured', 'featured',
  'sandstone', 'sandalwood', 'sandblasted', 'thousand', 'husband',
  'greyhound', 'greystone',
  'golden', 'goldfinch',
  'blueprint', 'bluetooth', 'bluebell',
  'greenwich', 'greenhouse', 'greenfield',
  'brownstone', 'brownie',
  'silverado', 'silverstone',
  'oakhurst', 'oakland', 'oakmont', 'oakwood', 'oakdale', 'oakley',
  'copperton', 'copperfield',
  'blackberry', 'blackhawk', 'blackstone', 'blackwood', 'blackwell',
  'whitefield', 'whitehall', 'whitewood', 'whitefish', 'whitestone',
  'rustique', 'rustico', 'rustica', 'rustic',
  'creamsicle',
  'bronzewood',
  'walnutwood',
  'beigewood',
  'ivorydale',
];

/**
 * Extract color words from text using word-boundary-aware matching.
 * Returns array of {color, index} sorted by index.
 */
function extractColors(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const results = [];

  for (const color of COLORS) {
    const regex = new RegExp(`(?:^|[^a-z])${color}(?:[^a-z]|$)`, 'gi');
    let match;
    while ((match = regex.exec(lower)) !== null) {
      const startIdx = lower.indexOf(color, match.index);

      let isFalsePositive = false;
      for (const fpWord of FALSE_POSITIVE_WORDS) {
        const fpIdx = lower.indexOf(fpWord, Math.max(0, startIdx - fpWord.length));
        if (fpIdx >= 0 && startIdx >= fpIdx && startIdx < fpIdx + fpWord.length) {
          isFalsePositive = true;
          break;
        }
      }

      if (!isFalsePositive) {
        results.push({ color, index: startIdx });
      }
    }
  }

  const seen = new Set();
  return results.filter(r => {
    if (seen.has(r.color)) return false;
    seen.add(r.color);
    return true;
  }).sort((a, b) => a.index - b.index);
}

/**
 * Extract colors from a URL path (split on delimiters to find color words).
 */
function extractUrlColors(url) {
  if (!url) return [];
  const pathPart = url.split('?')[0].toLowerCase();
  const parts = pathPart.split(/[-_/.\s]+/);
  const results = [];
  const seen = new Set();

  for (const part of parts) {
    for (const color of COLORS) {
      if (part === color && !seen.has(color)) {
        let isFalsePositive = false;
        for (const fpWord of FALSE_POSITIVE_WORDS) {
          if (pathPart.includes(fpWord) && fpWord.includes(color)) {
            isFalsePositive = true;
            break;
          }
        }
        if (!isFalsePositive) {
          seen.add(color);
          results.push(color);
        }
      }
    }
  }
  return results;
}

// ─── HTTP HEAD Helper ────────────────────────────────────────────────────────

const headCache = new Map();
let headRequests = 0;

async function headUrl(url) {
  if (headCache.has(url)) return headCache.get(url);
  headRequests++;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      headCache.set(url, false);
      resolve(false);
    }, 5000);

    try {
      const parsedUrl = new URL(url);
      const httpModule = parsedUrl.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'HEAD',
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ImageChecker/1.0)',
        },
      };

      const req = httpModule.request(options, (res) => {
        clearTimeout(timeout);
        const ok = res.statusCode >= 200 && res.statusCode < 400;
        headCache.set(url, ok);
        resolve(ok);
      });

      req.on('error', () => {
        clearTimeout(timeout);
        headCache.set(url, false);
        resolve(false);
      });

      req.on('timeout', () => {
        clearTimeout(timeout);
        req.destroy();
        headCache.set(url, false);
        resolve(false);
      });

      req.end();
    } catch {
      clearTimeout(timeout);
      headCache.set(url, false);
      resolve(false);
    }
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Slug Helper ─────────────────────────────────────────────────────────────

function slugify(text) {
  return text.toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ─── URL Color Replacement ───────────────────────────────────────────────────

/**
 * Given a URL containing wrongColor, produce candidate URLs with correctColor substituted.
 */
function generateCandidateUrls(url, wrongColor, correctColor) {
  const candidates = [];

  // Try both gray and grey when targeting gray-family
  const targetVariants = correctColor === 'gray' ? ['gray', 'grey']
    : correctColor === 'grey' ? ['grey', 'gray']
    : [correctColor];

  for (const targetColor of targetVariants) {
    const [pathPart, queryPart] = url.split('?');

    // Replace the wrong color with the target color (case-insensitive, word-boundary)
    const regex = new RegExp(`(^|[^a-zA-Z])${wrongColor}([^a-zA-Z]|$)`, 'gi');
    let newPath = pathPart;
    // Replace all occurrences
    newPath = newPath.replace(regex, (match, before, after) => {
      return before + targetColor + after;
    });
    // Run twice in case of overlapping matches (e.g. "-gray-gray-")
    newPath = newPath.replace(regex, (match, before, after) => {
      return before + targetColor + after;
    });

    if (newPath !== pathPart) {
      const newUrl = queryPart ? `${newPath}?${queryPart}` : newPath;
      if (!candidates.includes(newUrl)) candidates.push(newUrl);
    }

    // Also try with first letter capitalized
    const capitalTarget = targetColor.charAt(0).toUpperCase() + targetColor.slice(1);
    const capRegex = new RegExp(`(^|[^a-zA-Z])${wrongColor}([^a-zA-Z]|$)`, 'gi');
    let capPath = pathPart;
    capPath = capPath.replace(capRegex, (match, before, after) => {
      return before + capitalTarget + after;
    });

    if (capPath !== pathPart && capPath !== newPath) {
      const newUrl = queryPart ? `${capPath}?${queryPart}` : capPath;
      if (!candidates.includes(newUrl)) candidates.push(newUrl);
    }
  }

  return candidates;
}

/**
 * Generate MSI CDN URL candidates for a given product based on common MSI URL patterns.
 * Tries constructing URLs from the collection/product name in various MSI CDN paths.
 */
function generateMsiCandidateUrls(productName, collection, correctColor, assetType) {
  const candidates = [];
  const collSlug = slugify(collection || '');
  const nameSlug = slugify(productName || '');
  const colorSlug = correctColor.toLowerCase();

  // Also try gray/grey variants
  const colorVariants = colorSlug === 'gray' ? ['gray', 'grey']
    : colorSlug === 'grey' ? ['grey', 'gray']
    : [colorSlug];

  const CDN = 'https://cdn.msisurfaces.com/images';

  // MSI URL patterns observed:
  // porcelainceramic: {color}-{collection}-porcelain, {color}-{collection}-ceramic
  // mosaics: {collection}-{color}-{pattern}, {collection}-{color}-{size}
  // hardscaping: {collection}-{color}-{type}
  // lvt: {collection}-{color}-vinyl-flooring
  // colornames: {collection}-{color}

  for (const cv of colorVariants) {
    // Determine suffix variations based on asset_type
    const suffixMap = {
      primary: ['', '-iso'],
      alternate: ['-edge', '-iso', '-detail-two'],
      lifestyle: ['-variation', '-variations', ''],
    };
    const suffixes = suffixMap[assetType] || [''];

    // Pattern families for porcelain/ceramic
    for (const sfx of suffixes) {
      const subdir = assetType === 'primary' && sfx === '-iso' ? 'iso/' :
        assetType === 'alternate' && sfx === '-edge' ? 'edge/' :
        assetType === 'alternate' && sfx === '-iso' ? 'iso/' :
        assetType === 'alternate' && sfx === '-detail-two' ? 'detail-two/' :
        assetType === 'lifestyle' && (sfx === '-variation' || sfx === '-variations') ? 'variations/' :
        assetType === 'lifestyle' && sfx === '-variation' ? 'variation/' :
        '';

      // porcelainceramic patterns
      candidates.push(`${CDN}/porcelainceramic/${subdir}${cv}-${collSlug}-porcelain${sfx}.jpg`);
      candidates.push(`${CDN}/porcelainceramic/${subdir}${cv}-${collSlug}-ceramic${sfx}.jpg`);
      candidates.push(`${CDN}/porcelainceramic/${subdir}${collSlug}-${cv}-porcelain${sfx}.jpg`);
      candidates.push(`${CDN}/porcelainceramic/${subdir}${collSlug}-${cv}${sfx}.jpg`);

      // mosaic patterns
      candidates.push(`${CDN}/mosaics/${subdir}${collSlug}-${cv}${sfx}.jpg`);
      candidates.push(`${CDN}/mosaics/${subdir}${cv}-${collSlug}${sfx}.jpg`);

      // hardscaping patterns
      candidates.push(`${CDN}/hardscaping/${subdir.replace(/^$/, 'detail/')}${collSlug}-${cv}${sfx.replace('-iso', '')}.jpg`);

      // lvt patterns
      candidates.push(`${CDN}/lvt/${subdir.replace(/^$/, 'detail/')}${collSlug}-${cv}-vinyl-flooring${sfx.replace('-iso', '')}.jpg`);

      // colornames patterns
      candidates.push(`${CDN}/colornames/${subdir}${collSlug}-${cv}${sfx}.jpg`);
      candidates.push(`${CDN}/colornames/${subdir}${cv}-${collSlug}${sfx}.jpg`);
    }
  }

  // Deduplicate
  return [...new Set(candidates)];
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log();
  console.log(DRY_RUN ? '=== DRY RUN MODE (pass --execute to apply changes) ===' : '=== LIVE MODE ===');
  console.log();

  // ── Step 1: Load all active products with CDN media assets ──
  console.log('Step 1: Loading products with CDN images...');

  const result = await pool.query(`
    SELECT
      ma.id as media_id,
      ma.product_id,
      ma.asset_type,
      ma.url,
      ma.sort_order,
      p.name as product_name,
      p.collection,
      v.name as vendor_name,
      v.id as vendor_id
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE p.is_active = true
      AND ma.url LIKE 'https://%'
      AND ma.sku_id IS NULL
    ORDER BY v.name, p.collection, p.name, ma.asset_type, ma.sort_order
  `);

  console.log(`  Loaded ${result.rows.length} media assets\n`);

  // ── Step 2: Identify mismatches ──
  console.log('Step 2: Identifying color mismatches...');

  const mismatches = [];

  for (const row of result.rows) {
    const nameColors = extractColors(row.product_name);
    if (nameColors.length === 0) continue;

    const urlColors = extractUrlColors(row.url);
    if (urlColors.length === 0) continue;

    const nameColorSet = new Set(nameColors.map(c => c.color));

    // Expand equivalents
    const acceptableColors = new Set(nameColorSet);
    for (const nc of nameColorSet) {
      for (const pair of EQUIVALENT_PAIRS) {
        if (pair[0] === nc) acceptableColors.add(pair[1]);
        if (pair[1] === nc) acceptableColors.add(pair[0]);
      }
    }

    const urlHasCorrectColor = urlColors.some(uc => acceptableColors.has(uc));
    if (urlHasCorrectColor) continue;

    const wrongUrlColors = urlColors.filter(uc => !acceptableColors.has(uc));
    if (wrongUrlColors.length === 0) continue;

    mismatches.push({
      ...row,
      nameColors: [...nameColorSet],
      wrongUrlColors,
      correctColor: nameColors[nameColors.length - 1].color,
    });
  }

  console.log(`  Found ${mismatches.length} mismatched images\n`);

  // Breakdown
  const byVendorType = {};
  for (const m of mismatches) {
    const key = `${m.vendor_name} | ${m.asset_type}`;
    byVendorType[key] = (byVendorType[key] || 0) + 1;
  }
  console.log('  Breakdown:');
  for (const [key, count] of Object.entries(byVendorType).sort()) {
    console.log(`    ${key}: ${count}`);
  }
  console.log();

  // ── Step 3: Build sibling lookup ──
  console.log('Step 3: Building sibling product lookup...');

  const siblingMap = new Map();

  for (const row of result.rows) {
    const key = `${row.vendor_id}|${row.collection}`;
    if (!siblingMap.has(key)) siblingMap.set(key, new Map());
    const collectionProducts = siblingMap.get(key);

    if (!collectionProducts.has(row.product_id)) {
      const nameColors = extractColors(row.product_name);
      collectionProducts.set(row.product_id, {
        product_name: row.product_name,
        nameColors: nameColors.map(c => c.color),
        urls: [],
      });
    }
    collectionProducts.get(row.product_id).urls.push({
      media_id: row.media_id,
      url: row.url,
      asset_type: row.asset_type,
      sort_order: row.sort_order,
    });
  }

  console.log(`  Built lookup for ${siblingMap.size} collection groups\n`);

  // ── Step 4: Attempt fixes ──
  console.log('Step 4: Attempting fixes...\n');

  const fixes = [];
  const unfixable = [];

  const stats = {
    urlReplacement: 0,
    msiPattern: 0,
    siblingSwap: 0,
    siblingPattern: 0,
    unfixable: 0,
  };

  const mismatchesByProduct = new Map();
  for (const m of mismatches) {
    if (!mismatchesByProduct.has(m.product_id)) {
      mismatchesByProduct.set(m.product_id, []);
    }
    mismatchesByProduct.get(m.product_id).push(m);
  }

  const fixedMediaIds = new Set();

  // Process mismatches; process primaries first (so alternates/lifestyles can follow the same pattern)
  const sortedMismatches = [...mismatches].sort((a, b) => {
    const order = { primary: 0, alternate: 1, lifestyle: 2, spec_pdf: 3 };
    return (order[a.asset_type] ?? 9) - (order[b.asset_type] ?? 9);
  });

  // Track successful URL patterns per product so alternates/lifestyles can follow
  const successfulPatterns = new Map(); // product_id → { wrongColor, correctColor, fromUrl, toUrl }

  for (const m of sortedMismatches) {
    if (fixedMediaIds.has(m.media_id)) continue;

    // Skip spec_pdf — these are shared catalog PDFs, not per-color images
    if (m.asset_type === 'spec_pdf') continue;

    const isMSI = m.vendor_name === 'MSI Surfaces';
    let fixed = false;

    // ── Strategy 1: URL Color Replacement ──
    if (!fixed) {
      for (const wrongColor of m.wrongUrlColors) {
        const candidates = generateCandidateUrls(m.url, wrongColor, m.correctColor);

        for (const candidateUrl of candidates) {
          const exists = await headUrl(candidateUrl);
          if (exists) {
            fixes.push({
              media_id: m.media_id,
              old_url: m.url,
              new_url: candidateUrl,
              method: 'url_replacement',
              product_name: m.product_name,
              vendor: m.vendor_name,
              asset_type: m.asset_type,
              wrongColor,
              correctColor: m.correctColor,
            });
            fixedMediaIds.add(m.media_id);
            stats.urlReplacement++;
            fixed = true;

            // Record pattern for siblings/alternates
            if (!successfulPatterns.has(m.product_id)) {
              successfulPatterns.set(m.product_id, []);
            }
            successfulPatterns.get(m.product_id).push({
              wrongColor, correctColor: m.correctColor, fromUrl: m.url, toUrl: candidateUrl
            });
            break;
          }
        }
        if (fixed) break;
      }

      if (headRequests % 20 === 0) await delay(100);
    }

    // ── Strategy 1b: Use pattern from primary fix for alternates/lifestyles ──
    if (!fixed && m.asset_type !== 'primary') {
      const patterns = successfulPatterns.get(m.product_id);
      if (patterns) {
        for (const pat of patterns) {
          // Try applying the same color replacement to this URL
          const candidates = generateCandidateUrls(m.url, pat.wrongColor, pat.correctColor);
          for (const candidateUrl of candidates) {
            const exists = await headUrl(candidateUrl);
            if (exists) {
              fixes.push({
                media_id: m.media_id,
                old_url: m.url,
                new_url: candidateUrl,
                method: 'pattern_follow',
                product_name: m.product_name,
                vendor: m.vendor_name,
                asset_type: m.asset_type,
                wrongColor: pat.wrongColor,
                correctColor: pat.correctColor,
              });
              fixedMediaIds.add(m.media_id);
              stats.urlReplacement++;
              fixed = true;
              break;
            }
          }
          if (fixed) break;
        }
      }
    }

    // ── Strategy 2: MSI CDN Pattern Construction ──
    if (!fixed && isMSI) {
      const candidates = generateMsiCandidateUrls(
        m.product_name, m.collection, m.correctColor, m.asset_type
      );

      // Test candidates in batches (there can be many)
      for (let i = 0; i < candidates.length; i++) {
        const exists = await headUrl(candidates[i]);
        if (exists) {
          fixes.push({
            media_id: m.media_id,
            old_url: m.url,
            new_url: candidates[i],
            method: 'msi_pattern',
            product_name: m.product_name,
            vendor: m.vendor_name,
            asset_type: m.asset_type,
            correctColor: m.correctColor,
          });
          fixedMediaIds.add(m.media_id);
          stats.msiPattern++;
          fixed = true;
          break;
        }
        if (i % 10 === 0 && i > 0) await delay(50);
      }
    }

    // ── Strategy 3: Sibling Swap ──
    if (!fixed) {
      const collKey = `${m.vendor_id}|${m.collection}`;
      const siblings = siblingMap.get(collKey);

      if (siblings) {
        for (const [sibProdId, sibData] of siblings) {
          if (sibProdId === m.product_id) continue;

          for (const sibUrl of sibData.urls) {
            if (sibUrl.asset_type !== m.asset_type) continue;

            const sibUrlColors = extractUrlColors(sibUrl.url);
            const hasOurColor = sibUrlColors.some(uc => areEquivalent(uc, m.correctColor));

            if (hasOurColor) {
              const sibNameColors = new Set(sibData.nameColors);
              const ourUrlHasSibColor = m.wrongUrlColors.some(wc =>
                [...sibNameColors].some(snc => areEquivalent(wc, snc)));

              if (ourUrlHasSibColor) {
                const sibMismatches = mismatchesByProduct.get(sibProdId) || [];
                const sibAlsoMismatched = sibMismatches.some(sm => sm.asset_type === m.asset_type);

                if (sibAlsoMismatched && !fixedMediaIds.has(sibUrl.media_id)) {
                  fixes.push({
                    media_id: m.media_id,
                    old_url: m.url,
                    new_url: sibUrl.url,
                    method: 'sibling_swap',
                    product_name: m.product_name,
                    vendor: m.vendor_name,
                    asset_type: m.asset_type,
                    swapWith: sibData.product_name,
                  });
                  fixes.push({
                    media_id: sibUrl.media_id,
                    old_url: sibUrl.url,
                    new_url: m.url,
                    method: 'sibling_swap',
                    product_name: sibData.product_name,
                    vendor: m.vendor_name,
                    asset_type: m.asset_type,
                    swapWith: m.product_name,
                  });
                  fixedMediaIds.add(m.media_id);
                  fixedMediaIds.add(sibUrl.media_id);
                  stats.siblingSwap += 2;
                  fixed = true;
                  break;
                }
              }
            }
          }
          if (fixed) break;
        }
      }
    }

    // ── Strategy 4: Sibling Pattern Derivation ──
    // Look at a correctly-matched sibling's URL and try to construct our URL from their pattern
    if (!fixed) {
      const collKey = `${m.vendor_id}|${m.collection}`;
      const siblings = siblingMap.get(collKey);

      if (siblings) {
        for (const [sibProdId, sibData] of siblings) {
          if (sibProdId === m.product_id) continue;

          for (const sibUrl of sibData.urls) {
            if (sibUrl.asset_type !== m.asset_type) continue;

            // Check that sibling's URL correctly matches sibling's name colors
            const sibUrlColors = extractUrlColors(sibUrl.url);
            const sibNameColorSet = new Set(sibData.nameColors);
            const sibUrlCorrect = sibUrlColors.some(uc => {
              for (const snc of sibNameColorSet) {
                if (areEquivalent(uc, snc)) return true;
              }
              return false;
            });

            if (sibUrlCorrect) {
              // Try replacing sibling's color with our color
              for (const sibColor of sibData.nameColors) {
                const candidates = generateCandidateUrls(sibUrl.url, sibColor, m.correctColor);
                for (const candidateUrl of candidates) {
                  if (candidateUrl === m.url) continue;
                  const exists = await headUrl(candidateUrl);
                  if (exists) {
                    fixes.push({
                      media_id: m.media_id,
                      old_url: m.url,
                      new_url: candidateUrl,
                      method: 'sibling_pattern',
                      product_name: m.product_name,
                      vendor: m.vendor_name,
                      asset_type: m.asset_type,
                      patternFrom: sibData.product_name,
                      correctColor: m.correctColor,
                    });
                    fixedMediaIds.add(m.media_id);
                    stats.siblingPattern++;
                    fixed = true;
                    break;
                  }
                }
                if (fixed) break;
              }
            }
            if (fixed) break;
          }
          if (fixed) break;
        }
      }
    }

    if (!fixed) {
      stats.unfixable++;
      unfixable.push({
        media_id: m.media_id,
        product_name: m.product_name,
        collection: m.collection,
        vendor: m.vendor_name,
        asset_type: m.asset_type,
        url: m.url,
        nameColors: m.nameColors,
        wrongUrlColors: m.wrongUrlColors,
        correctColor: m.correctColor,
      });
    }
  }

  // ── Step 5: Report ──
  console.log('\n' + '='.repeat(80));
  console.log('RESULTS');
  console.log('='.repeat(80) + '\n');

  console.log(`Total mismatched images found: ${mismatches.length} (excl. spec_pdf)`);
  console.log(`Fixes via URL replacement:     ${stats.urlReplacement}`);
  console.log(`Fixes via MSI pattern:         ${stats.msiPattern}`);
  console.log(`Fixes via sibling swap:        ${stats.siblingSwap}`);
  console.log(`Fixes via sibling pattern:     ${stats.siblingPattern}`);
  console.log(`Unfixable (no valid alt found): ${stats.unfixable}`);
  console.log(`Total HEAD requests made:      ${headRequests}`);
  console.log();

  // Print all fixes
  if (fixes.length > 0) {
    console.log(`--- FIXES (${fixes.length}) ---\n`);

    const fixesByVendor = {};
    for (const f of fixes) {
      if (!fixesByVendor[f.vendor]) fixesByVendor[f.vendor] = [];
      fixesByVendor[f.vendor].push(f);
    }

    for (const [vendor, vendorFixes] of Object.entries(fixesByVendor).sort()) {
      console.log(`  [${vendor}] (${vendorFixes.length} fixes)`);
      for (const f of vendorFixes) {
        console.log(`    ${f.product_name} [${f.asset_type}] — ${f.method}${f.swapWith ? ` (swap with "${f.swapWith}")` : ''}${f.patternFrom ? ` (from "${f.patternFrom}")` : ''}`);
        if (f.wrongColor) console.log(`      Color: ${f.wrongColor} -> ${f.correctColor}`);
        console.log(`      OLD: ${f.old_url}`);
        console.log(`      NEW: ${f.new_url}`);
      }
      console.log();
    }
  }

  // Print unfixable
  if (unfixable.length > 0) {
    console.log(`--- UNFIXABLE (${unfixable.length}) ---\n`);

    const unfixByVendor = {};
    for (const u of unfixable) {
      if (!unfixByVendor[u.vendor]) unfixByVendor[u.vendor] = [];
      unfixByVendor[u.vendor].push(u);
    }

    for (const [vendor, items] of Object.entries(unfixByVendor).sort()) {
      console.log(`  [${vendor}] (${items.length})`);
      for (const u of items) {
        console.log(`    ${u.product_name} [${u.asset_type}] color=${u.correctColor} url_has=${u.wrongUrlColors.join(',')}`);
        console.log(`      ${u.url}`);
      }
      console.log();
    }
  }

  // ── Step 6: Apply fixes ──
  if (!DRY_RUN && fixes.length > 0) {
    console.log('\n--- APPLYING FIXES ---\n');

    let applied = 0;
    let errors = 0;

    for (const f of fixes) {
      try {
        await pool.query(
          'UPDATE media_assets SET url = $1 WHERE id = $2',
          [f.new_url, f.media_id]
        );
        applied++;
      } catch (err) {
        console.error(`  ERROR updating ${f.media_id}: ${err.message}`);
        errors++;
      }
    }

    console.log(`  Applied: ${applied}`);
    console.log(`  Errors:  ${errors}\n`);
  } else if (DRY_RUN && fixes.length > 0) {
    console.log(`\n[DRY RUN] Would update ${fixes.length} media_assets rows.`);
    console.log('Run with --execute to apply changes.\n');
  } else {
    console.log('\nNo fixes to apply.\n');
  }

  // Summary by asset_type
  const fixByType = {};
  for (const f of fixes) {
    fixByType[f.asset_type] = (fixByType[f.asset_type] || 0) + 1;
  }
  const unfixByType = {};
  for (const u of unfixable) {
    unfixByType[u.asset_type] = (unfixByType[u.asset_type] || 0) + 1;
  }

  console.log('Summary by asset type:');
  console.log('  Asset Type   | Fixed | Unfixable');
  console.log('  -------------|-------|----------');
  const allTypes = new Set([...Object.keys(fixByType), ...Object.keys(unfixByType)]);
  for (const t of [...allTypes].sort()) {
    console.log(`  ${t.padEnd(13)} | ${String(fixByType[t] || 0).padStart(5)} | ${String(unfixByType[t] || 0).padStart(9)}`);
  }

  // Summary by method
  console.log('\nSummary by fix method:');
  const byMethod = {};
  for (const f of fixes) {
    byMethod[f.method] = (byMethod[f.method] || 0) + 1;
  }
  for (const [method, count] of Object.entries(byMethod).sort()) {
    console.log(`  ${method}: ${count}`);
  }

  console.log();
  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  pool.end().finally(() => process.exit(1));
});
