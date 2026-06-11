/**
 * MSI DAM Image Importer
 *
 * Downloads high-resolution primary web images from the MSI AEM Digital Asset
 * Management portal (images.msisurfaces.com) and saves them to SKU-level
 * media_assets.
 *
 * The AEM DAM provides 3,300+ images at 1280×1280 JPEG renditions — higher
 * quality and broader coverage than CDN probing alone.
 *
 * Authentication:
 *   The DAM requires AEM form login. Set MSI_DAM_USERNAME and MSI_DAM_PASSWORD
 *   in .env, OR pass --manual-login to pause for manual browser login.
 *
 * Usage:
 *   node backend/scrapers/msi-dam-images.js                  # Full run
 *   node backend/scrapers/msi-dam-images.js --manual-login    # Pause for manual login
 *   node backend/scrapers/msi-dam-images.js --dry-run         # Preview matches only
 *   node backend/scrapers/msi-dam-images.js --limit=100       # Process first N matches
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';
import puppeteer from 'puppeteer';

// Load .env from project root (needed when running locally outside Docker)
const __filename_ = fileURLToPath(import.meta.url);
dotenv.config({ path: path.resolve(path.dirname(__filename_), '..', '..', '.env') });

import {
  delay,
  upsertMediaAsset,
} from './base.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ═══════════════════════════════════════════════════════════════════════════════
// CLI flags
// ═══════════════════════════════════════════════════════════════════════════════

const MANUAL_LOGIN  = process.argv.includes('--manual-login');
const DRY_RUN       = process.argv.includes('--dry-run');
const VERBOSE       = process.argv.includes('--verbose');
const LIMIT_ARG     = process.argv.find(a => a.startsWith('--limit='));
const LIMIT         = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : 0;

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const DAM_HOST      = 'https://images.msisurfaces.com';
const LOGIN_URL     = `${DAM_HOST}/libs/granite/core/content/login.html`;
const QUERY_URL     = `${DAM_HOST}/bin/querybuilder.json`;

// AEM rendition that gives us web-optimized 1280×1280 JPEG (~400-500KB each)
const RENDITION_SUFFIX = '/jcr:content/renditions/cq5dam.web.1280.1280.jpeg';

// DAM categories we care about (skip countertops, hardscape, sinks, faucets, etc.)
const RELEVANT_CATEGORIES = new Set([
  'porcelain', 'mosaics', 'natural-stone', 'lvt', 'hardscape',
]);

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function log(msg) {
  console.log(`[msi-dam] ${msg}`);
}

/**
 * Extract the DAM category from a path.
 * e.g., "/content/dam/msi-dam/photography/product/porcelain/primary-web-images/..." → "porcelain"
 */
function extractDamCategory(damPath) {
  const m = damPath.match(/\/product\/([^/]+)\//);
  return m ? m[1] : null;
}

/**
 * Extract the SKU/color identifier from a DAM filename.
 * Handles multiple naming patterns:
 *   "QUARZQUARTZITEGRI2424-Primary-Web-Image.tif" → "QUARZQUARTZITEGRI2424"
 *   "NGRAGLO3X6BEV Iso Product Photo.jpg"          → "NGRAGLO3X6BEV"
 *   "NGRICON2X2_b.tif"                              → "NGRICON2X2"
 *   "NGRICON2X2_b_2.tif"                            → "NGRICON2X2"
 */
function extractDamSku(damPath) {
  const filename = damPath.split('/').pop();
  return filename
    .replace(/-Primary-Web-Image\.\w+$/i, '')
    .replace(/_Primary-Web-Image\.\w+$/i, '')
    .replace(/[\s_-]*Iso[\s_-]*Product[\s_-]*Photo\.\w+$/i, '')
    .replace(/_b(?:_\d+)?\.\w+$/i, '')
    .replace(/\.\w+$/, '')
    .trim();
}

// ─── Asset type definitions ─────────────────────────────────────────────────

/**
 * DAM asset types we import, in processing order.
 * primary-web-image   → asset_type='primary',   sort_order=0  (flat product shot)
 * isometric           → asset_type='alternate',  sort_order=1  (angled shot)
 */
const DAM_ASSET_TYPES = [
  {
    tag: 'msi-asset-info:asset-type/primary-web-image',
    cacheFile: 'msi-dam-paths.json',
    assetType: 'primary',
    sortOrder: 0,
    label: 'primary-web-image',
    filterCategory: true,
  },
  {
    tag: 'msi-asset-info:asset-type/isometric-product-photo',
    cacheFile: 'msi-dam-iso-paths.json',
    assetType: 'alternate',
    sortOrder: 1,
    label: 'isometric (angled)',
    filterCategory: false,
  },
  // NOTE: The DAM also contains room-scene (1,770), full-slab-photo (315), and
  // vignette (113) assets, but their filenames are generic (e.g., "Bedroom-0011.tif",
  // "Steel-Gray-Full-Slab-Photo.tif", "Vignette-002-Alt-03.tif") — not SKU-based.
  // Matching these to products would require AEM relationship metadata queries.
];

/**
 * Build the rendition URL for a DAM path.
 */
function buildRenditionUrl(damPath) {
  return DAM_HOST + damPath + RENDITION_SUFFIX;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Authentication
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Authenticate to the AEM DAM portal via Puppeteer.
 *
 * Automated flow:
 *   1. Log into MSI Customer Portal with .env credentials (iframe login form)
 *   2. Find the "Digital Photography" link on the portal dashboard
 *   3. Click it → SSO token redirects into images.msisurfaces.com
 *
 * Falls back to --manual-login if automated flow fails.
 */
async function authenticateDAM(page) {
  const PORTAL_URL = 'https://www.msisurfaces.com/customer-portal/';

  const username = process.env.MSI_PORTAL_USERNAME;
  const password = process.env.MSI_PORTAL_PASSWORD;

  if (!MANUAL_LOGIN && (!username || !password)) {
    log('ERROR: No credentials. Set MSI_PORTAL_USERNAME/MSI_PORTAL_PASSWORD in .env, or use --manual-login.');
    return false;
  }

  // ── Step 1: Log into B2B portal directly ──────────────────────────────────
  const B2B_URL = 'https://b2b.msisurfaces.com/';

  if (MANUAL_LOGIN) {
    log('Navigating to MSI Customer Portal...');
    await page.goto(PORTAL_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(2000);
    log('');
    log('══════════════════════════════════════════════════════════');
    log('  MANUAL LOGIN REQUIRED');
    log('  1. Log into the Customer Portal');
    log('  2. Scroll down and click "Digital Photography"');
    log('  3. The script will continue once the DAM loads.');
    log('══════════════════════════════════════════════════════════');
    log('');
  } else {
    // Go straight to the B2B login page (same URL the portal iframe loads)
    const B2B_LOGIN = 'https://b2b.msisurfaces.com/b2bcustomer/LoginControl.aspx';
    log('Navigating to B2B login page...');
    await page.goto(B2B_LOGIN, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(3000);

    // Fill and submit login form via DOM (avoids clickability issues)
    log('  Filling login form...');
    const formResult = await page.evaluate((user, pass) => {
      // Find inputs
      const emailInput = document.querySelector('input[type="email"]')
        || document.querySelector('input[name*="email"]')
        || document.querySelector('input[name*="user"]')
        || document.querySelector('input[id*="user"]')
        || document.querySelector('input[type="text"]');
      const passInput = document.querySelector('input[type="password"]');

      if (!emailInput || !passInput) {
        return { error: 'missing-fields', html: document.body.innerHTML.substring(0, 500) };
      }

      // Set values via native setter (works with React/ASP.NET)
      const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      nativeSet.call(emailInput, user);
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
      emailInput.dispatchEvent(new Event('change', { bubbles: true }));

      nativeSet.call(passInput, pass);
      passInput.dispatchEvent(new Event('input', { bubbles: true }));
      passInput.dispatchEvent(new Event('change', { bubbles: true }));

      // Submit
      const btn = document.querySelector('button[type="submit"], input[type="submit"]');
      if (btn) { btn.click(); return { submitted: 'button' }; }

      const signIn = Array.from(document.querySelectorAll('a')).find(a => /^sign\s*in$/i.test(a.textContent.trim()));
      if (signIn) { signIn.click(); return { submitted: 'signIn-link' }; }

      const form = emailInput.closest('form') || document.querySelector('form');
      if (form) { form.submit(); return { submitted: 'form' }; }

      return { error: 'no-submit' };
    }, username, password).catch(e => ({ error: e.message }));

    if (formResult.error) {
      log(`  ERROR: ${formResult.error}`);
      if (formResult.html) log(`  Page preview: ${formResult.html.substring(0, 200)}`);
      log('  Try --manual-login instead.');
      return false;
    }
    log(`  Submit method: ${formResult.submitted}`);

    // Wait for the page to navigate after login
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await delay(5000);

    const postLoginUrl = page.url();
    log(`  Post-login URL: ${postLoginUrl}`);

    // Check if login succeeded
    const stillHasPassword = await page.evaluate(() =>
      document.querySelectorAll('input[type="password"]').length > 0
    ).catch(() => false);
    if (stillHasPassword) {
      log('ERROR: B2B login failed. Check MSI_PORTAL_USERNAME/PASSWORD in .env, or use --manual-login.');
      return false;
    }
    log('  B2B login successful!');

    // ── Step 2: Find and click "Digital Photography" ─────────────────────
    log('  Looking for "Digital Photography" link...');
    await delay(2000);

    // Scroll to reveal all content
    for (let i = 0; i < 10; i++) {
      await page.evaluate((step) => window.scrollTo(0, step * 500), i);
      await delay(500);
    }
    await delay(2000);

    // "Access Digital Photography" is a tile with class selectoritemclick and no href.
    // It opens the DAM via window.open or ASP.NET postback.

    // Allow popups
    await page.evaluate(() => { window._origOpen = window.open; });

    // Listen for popup windows
    const popupPromise = new Promise(resolve => {
      page.browser().on('targetcreated', async (target) => {
        if (target.type() === 'page') {
          const p = await target.page();
          resolve(p);
        }
      });
      setTimeout(() => resolve(null), 30000);
    });

    log('  Clicking "Access Digital Photography"...');
    // Use Puppeteer's native click (not evaluate) so popups aren't blocked
    const tileEl = await page.evaluateHandle(() => {
      const all = Array.from(document.querySelectorAll('a, div, span'));
      for (const el of all) {
        const text = (el.textContent || '').trim().toLowerCase();
        if ((text.includes('digital photography') || text.includes('access digital')) &&
            text.length < 100) {
          const clickable = el.closest('a') || el;
          clickable.scrollIntoView({ block: 'center' });
          return clickable;
        }
      }
      return null;
    });

    if (tileEl) {
      await tileEl.click();
      log('  Clicked tile. Waiting for popup or navigation...');

      // Wait for popup (new tab) or page navigation
      const [popup] = await Promise.all([
        popupPromise,
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => null),
      ]);

      if (popup) {
        const popupUrl = popup.url();
        log(`  Popup opened: ${popupUrl.substring(0, 80)}`);
      }
    } else {
      log('  "Digital Photography" tile not found on dashboard.');
    }
  }

  // ── Step 3: Wait for DAM to load ────────────────────────────────────────
  const browser = page.browser();

  // ── Step 3: Wait for DAM page to load ────────────────────────────────────
  log('  Waiting for DAM (images.msisurfaces.com) to load...');

  for (let i = 0; i < 120; i++) {
    await delay(5000);

    // Check all open tabs
    const allPages = await browser.pages();
    for (const p of allPages) {
      const pUrl = p.url();
      if (pUrl.includes('images.msisurfaces.com') && !pUrl.includes('login')) {
        log(`  DAM loaded: ${pUrl.substring(0, 80)}...`);
        await p.bringToFront();
        await delay(5000);
        try { await p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }); } catch {}
        await delay(3000);
        page._damPage = p;
        return true;
      }
    }

    if (i > 0 && i % 12 === 0) {
      const urls = allPages.map(p => p.url().substring(0, 60));
      log(`  Still waiting... (${i * 5}s). Tabs: ${urls.join(' | ')}`);
    }
  }

  log('ERROR: Timed out waiting for DAM access (10 minutes).');
  return false;
}

/** Find the first matching selector from a list of candidates. */
async function findFirst(context, selectors) {
  for (const sel of selectors) {
    const el = await context.$(sel).catch(() => null);
    if (el) return sel;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DAM Asset Discovery
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Query the AEM QueryBuilder API for all assets of a given type tag.
 * Returns array of DAM paths (strings).
 */
async function fetchDamPathsByTag(page, tag, label) {
  log(`Querying DAM for "${label}" assets...`);

  const queryParams = new URLSearchParams({
    'type': 'dam:Asset',
    'path': '/content/dam',
    '1_property': 'jcr:content/metadata/msi-asset-type',
    '1_property.value': tag,
    'p.limit': '-1',
    'p.hits': 'selective',
    'p.properties': 'jcr:path',
  });

  const url = `${QUERY_URL}?${queryParams}`;

  // Retry up to 3 times (page may navigate/reload after SSO token redirect)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await page.evaluate(async (fetchUrl) => {
        const resp = await fetch(fetchUrl);
        if (!resp.ok) return { error: resp.status };
        const data = await resp.json();
        return {
          total: data.total || 0,
          paths: (data.hits || []).map(h => h['jcr:path']),
        };
      }, url);

      if (result.error) {
        log(`ERROR: QueryBuilder returned ${result.error}. Auth may have expired.`);
        return [];
      }

      log(`  Found ${result.total} ${label} assets (${result.paths.length} paths retrieved).`);
      return result.paths;
    } catch (err) {
      log(`  Attempt ${attempt}/3 failed: ${err.message.split('\n')[0]}`);
      if (attempt < 3) {
        log(`  Waiting for page to settle before retry...`);
        await delay(5000);
        try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }); } catch {}
        await delay(3000);
      }
    }
  }

  log(`ERROR: All attempts to query "${label}" failed.`);
  return [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SKU Matching
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a match index from the database: vendor_sku → { sku_id, product_id }
 * Also builds a prefix index for partial matches.
 */
async function buildSkuIndex(pool) {
  const { rows } = await pool.query(`
    SELECT s.id as sku_id, s.product_id, s.vendor_sku, s.variant_type, s.variant_name,
           p.name as product_name, p.collection,
           c.name as category,
           (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON sa.attribute_id = a.id
            WHERE sa.sku_id = s.id AND a.name = 'color' LIMIT 1) as color,
           (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON sa.attribute_id = a.id
            WHERE sa.sku_id = s.id AND a.name = 'size' LIMIT 1) as size
    FROM skus s
    JOIN products p ON s.product_id = p.id
    JOIN vendors v ON p.vendor_id = v.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE v.code = 'MSI'
    ORDER BY s.vendor_sku
  `);

  const exact = new Map();      // vendor_sku → entry
  const normalized = new Map();  // normalized vendor_sku → entry (for fuzzy matching)
  const byProduct = new Map();   // product_id → [entries]

  for (const row of rows) {
    const entry = {
      sku_id: row.sku_id,
      product_id: row.product_id,
      vendor_sku: row.vendor_sku,
      variant_type: row.variant_type,
      variant_name: row.variant_name,
      product_name: row.product_name,
      collection: row.collection,
      category: row.category,
      color: row.color,
      size: row.size,
    };
    exact.set(row.vendor_sku, entry);
    // Normalize: replace / with - and lowercase for fuzzy matching
    // e.g., "VTWHINTON9.5X86-5/8-4MM" → "vtwhinton9.5x86-5-8-4mm"
    const norm = row.vendor_sku.replace(/\//g, '-').toLowerCase();
    normalized.set(norm, entry);
    if (!byProduct.has(row.product_id)) byProduct.set(row.product_id, []);
    byProduct.get(row.product_id).push(entry);
  }

  log(`  SKU index: ${exact.size} SKUs, ${byProduct.size} products`);
  return { exact, normalized, byProduct };
}

/**
 * Match a DAM filename to a database SKU.
 * Tries exact match first, then normalized, then prefix matching.
 * Returns { sku_id, product_id, vendor_sku, strategy } or null.
 */
function matchDamToSku(damSku, skuIndex) {
  // Strategy 1: Exact vendor_sku match
  if (skuIndex.exact.has(damSku)) {
    const entry = skuIndex.exact.get(damSku);
    return { ...entry, strategy: 'exact' };
  }

  // Strategy 2: Normalized match (handles slash/dash differences)
  // e.g., DAM "VTWADROAK7.5X75-1-2-2MM" matches DB "VTWADROAK7.5X75-1/2-2MM"
  const damNorm = damSku.replace(/\//g, '-').toLowerCase();
  if (skuIndex.normalized.has(damNorm)) {
    const entry = skuIndex.normalized.get(damNorm);
    return { ...entry, strategy: 'normalized' };
  }

  // Strategy 3: Find longest SKU that is a prefix of the DAM filename
  // e.g., DAM "QUARZQUARTZITEGRI2424-C" → SKU "QUARZQUARTZITEGRI2424"
  let bestMatch = null;
  for (const [sku, entry] of skuIndex.exact) {
    if (damSku.startsWith(sku) && sku.length >= 8) {
      const remainder = damSku.slice(sku.length).toUpperCase();
      // Prevent corner (COR) DAM images from matching non-corner SKUs via prefix
      if (remainder.includes('COR') && !sku.toUpperCase().includes('COR')) continue;
      // Prevent bullnose (BN) DAM images from matching field tile SKUs via prefix
      if (/^BN\b|^BN-/.test(remainder) && !sku.toUpperCase().includes('BN')) continue;
      if (!bestMatch || sku.length > bestMatch.vendor_sku.length) {
        bestMatch = { ...entry, strategy: 'prefix' };
      }
    }
  }
  if (bestMatch) return bestMatch;

  // Strategy 4: The DAM filename is a prefix of a vendor SKU
  // e.g., DAM "SMOT-GLBRK-AB8M" → SKU "SMOT-GLBRK-AB8MM"
  for (const [sku, entry] of skuIndex.exact) {
    if (sku.startsWith(damSku) && damSku.length >= 8 && (sku.length - damSku.length) <= 3) {
      // Prevent non-corner DAM images from matching corner SKUs
      if (sku.toUpperCase().includes('COR') && !damSku.toUpperCase().includes('COR')) continue;
      if (!bestMatch || sku.length < bestMatch.vendor_sku.length) {
        bestMatch = { ...entry, strategy: 'reverse-prefix' };
      }
    }
  }
  if (bestMatch) return bestMatch;

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Image Download + Save
// ═══════════════════════════════════════════════════════════════════════════════

const UPLOADS_BASE = process.env.UPLOADS_PATH || path.join(__dirname, '..', '..', 'uploads');
const DAM_IMG_DIR  = path.join(UPLOADS_BASE, 'msi-dam');

/**
 * Download a single image from the DAM via the authenticated Puppeteer page.
 * Returns the local file path on success, or null on failure.
 */
async function downloadDamImage(page, renditionUrl, destPath) {
  try {
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

    // Use page.evaluate to fetch the image as a base64 blob (stays authenticated)
    const base64 = await page.evaluate(async (url) => {
      try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const blob = await resp.blob();
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(blob);
        });
      } catch {
        return null;
      }
    }, renditionUrl);

    if (!base64) return null;

    await fs.promises.writeFile(destPath, Buffer.from(base64, 'base64'));
    return destPath;
  } catch {
    try { await fs.promises.unlink(destPath); } catch {}
    return null;
  }
}

/**
 * Process matched DAM assets: download images locally, save paths to DB.
 *
 * Downloads the 1280x1280 JPEG rendition from the authenticated DAM session,
 * saves to uploads/msi-dam/{vendor_sku}[-suffix].jpg, and stores the relative
 * path in media_assets.
 *
 * @param {string} assetType  - media_assets.asset_type ('primary', 'alternate', 'lifestyle')
 * @param {number} sortOrder  - media_assets.sort_order (0=primary, 1=alternate, 2+=lifestyle)
 * @param {string} fileSuffix - appended to filename for non-primary images (e.g. '-iso')
 */
async function processMatches(pool, page, matches, { assetType, sortOrder, fileSuffix = '' } = {}) {
  log(`Processing ${matches.length} matched DAM assets (type=${assetType}, order=${sortOrder})...`);
  await fs.promises.mkdir(DAM_IMG_DIR, { recursive: true });

  let saved = 0, skipped = 0, failed = 0;
  const savedSkuIds = new Set();

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];

    if (DRY_RUN) {
      log(`  [DRY] Would save ${assetType}: ${match.damSku} → SKU ${match.vendor_sku} (${match.strategy})`);
      saved++;
      savedSkuIds.add(match.sku_id);
      if ((i + 1) % 100 === 0) log(`  Progress: ${i + 1}/${matches.length}`);
      continue;
    }

    // Check if this SKU already has this asset type
    const { rows: existing } = await pool.query(
      'SELECT id, original_url FROM media_assets WHERE sku_id = $1 AND asset_type = $2 AND sort_order = $3 LIMIT 1',
      [match.sku_id, assetType, sortOrder]
    );

    if (existing.length > 0) {
      const existingUrl = existing[0].original_url || '';
      // Skip if already has an image (unless it's a DAM image from a previous run — allow re-download)
      const isDamImage = existingUrl.includes('msi-dam/') || existingUrl.includes('images.msisurfaces.com');
      if (!isDamImage) {
        if (VERBOSE) log(`  SKIP (has ${assetType}): ${match.vendor_sku}`);
        skipped++;
        continue;
      }
    }

    // Download image
    const filename = `${match.vendor_sku}${fileSuffix}.jpg`;
    const destPath = path.join(DAM_IMG_DIR, filename);

    // Check if already downloaded from a previous run
    if (fs.existsSync(destPath)) {
      const stat = fs.statSync(destPath);
      if (stat.size > 10000) {
        // Already downloaded and looks valid — just update DB
        const relUrl = `/uploads/msi-dam/${filename}`;
        await upsertMediaAsset(pool, {
          product_id: match.product_id,
          sku_id: match.sku_id,
          asset_type: assetType,
          url: relUrl,
          original_url: match.renditionUrl,
          sort_order: sortOrder,
        });
        saved++;
        savedSkuIds.add(match.sku_id);
        if ((i + 1) % 100 === 0) log(`  Progress: ${i + 1}/${matches.length} (saved=${saved}, skipped=${skipped}, failed=${failed})`);
        continue;
      }
    }

    const downloaded = await downloadDamImage(page, match.renditionUrl, destPath);
    if (!downloaded) {
      if (VERBOSE) log(`  FAIL (download): ${match.damSku}`);
      failed++;
      if ((i + 1) % 100 === 0) log(`  Progress: ${i + 1}/${matches.length} (saved=${saved}, skipped=${skipped}, failed=${failed})`);
      continue;
    }

    // Store relative path in DB (the image proxy will serve from uploads/)
    const relUrl = `/uploads/msi-dam/${filename}`;
    await upsertMediaAsset(pool, {
      product_id: match.product_id,
      sku_id: match.sku_id,
      asset_type: assetType,
      url: relUrl,
      original_url: match.renditionUrl,
      sort_order: sortOrder,
    });
    saved++;
    savedSkuIds.add(match.sku_id);

    if ((i + 1) % 50 === 0) {
      log(`  Progress: ${i + 1}/${matches.length} (saved=${saved}, skipped=${skipped}, failed=${failed})`);
    }

    // Small delay to avoid overwhelming the DAM server
    if ((i + 1) % 20 === 0) await delay(1000);
  }

  log(`  Final: ${matches.length}/${matches.length} (saved=${saved}, skipped=${skipped}, failed=${failed})`);
  return { saved, skipped, failed, savedSkuIds };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Sibling Inheritance
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * After saving DAM images, propagate to same-product siblings (same color,
 * different size) that didn't get a direct DAM match.
 */
async function inheritSiblings(pool, skuIndex, matchedSkuIds) {
  log('Sibling inheritance pass...');
  let inherited = 0;

  for (const [, entries] of skuIndex.byProduct) {
    // Only use non-accessory SKUs as image donors (prevents corner images on panels)
    const withImage = entries.filter(e => matchedSkuIds.has(e.sku_id) && e.variant_type !== 'accessory');
    const withoutImage = entries.filter(e => !matchedSkuIds.has(e.sku_id) && e.variant_type !== 'accessory');

    if (withImage.length === 0 || withoutImage.length === 0) continue;

    for (const entry of withoutImage) {
      // Check if this SKU already has any image
      const { rows: existing } = await pool.query(
        "SELECT id FROM media_assets WHERE sku_id = $1 AND asset_type = 'primary' LIMIT 1",
        [entry.sku_id]
      );
      if (existing.length > 0) continue;

      // Find a sibling with an image (prefer same color prefix)
      const sibling = withImage[0]; // Same product = same color
      const { rows: sibImg } = await pool.query(
        "SELECT url FROM media_assets WHERE sku_id = $1 AND asset_type = 'primary' LIMIT 1",
        [sibling.sku_id]
      );
      if (sibImg.length === 0) continue;

      await upsertMediaAsset(pool, {
        product_id: entry.product_id,
        sku_id: entry.sku_id,
        asset_type: 'primary',
        url: sibImg[0].url,
        original_url: sibImg[0].url,
        sort_order: 0,
      });
      matchedSkuIds.add(entry.sku_id);
      inherited++;
    }
  }

  log(`  Inherited: ${inherited} additional SKUs`);
  return inherited;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CDN Fallback — probe public msisurfaces.com CDN for SKUs the DAM missed
// ═══════════════════════════════════════════════════════════════════════════════

const CDN = 'https://cdn.msisurfaces.com/images';

function slugify(text) {
  return (text || '').toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-|-$/g, '');
}

const CDN_SPELLING_MAP = [
  [/\bcalcatta\b/g, 'calacatta'],
  [/\bcalacata\b/g, 'calacatta'],
  [/\bcalcata\b/g, 'calacatta'],
  [/\bcararra\b/g, 'carrara'],
  [/\bcarara\b/g, 'carrara'],
];

function cdnSlugify(text) {
  let s = slugify(text);
  for (const [pattern, replacement] of CDN_SPELLING_MAP) s = s.replace(pattern, replacement);
  return s;
}

function headUrl(url) {
  return new Promise(resolve => {
    let resolved = false;
    const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
    const req = https.request(url, { method: 'HEAD', timeout: 10000 }, res => {
      res.resume();
      done(res.statusCode === 200 ? url : null);
    });
    req.on('error', () => done(null));
    req.on('timeout', () => { req.destroy(); done(null); });
    req.end();
  });
}

async function probeFirst(urls, concurrency = 15) {
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(u => headUrl(u)));
    const hit = results.find(r => r !== null);
    if (hit) return hit;
  }
  return null;
}

function buildCdnCandidates(entry) {
  const { vendor_sku, collection, product_name, category, color, size } = entry;
  const variantName = color || entry.variant_name || product_name;
  const catLower = (category || '').toLowerCase();
  const urls = [];

  const collSlug = cdnSlugify(collection);
  const colorSlug = slugify(variantName);
  const nameSlug = cdnSlugify(product_name);
  const sizeSlug = size ? size.toLowerCase().replace(/[^0-9x]/g, '') : null;

  // ── LVP / Vinyl ──
  if (/luxury.vinyl|lvp|spc|wpc|vinyl|rigid.core/i.test(catLower)) {
    if (collSlug && colorSlug) {
      urls.push(`${CDN}/lvt/detail/${collSlug}-${colorSlug}-vinyl-flooring.jpg`);
      urls.push(`${CDN}/lvt/detail/${colorSlug}-${collSlug}-vinyl-flooring.jpg`);
      urls.push(`${CDN}/lvt/iso/${collSlug}-${colorSlug}-vinyl-flooring-iso.jpg`);
    }
    if (colorSlug) urls.push(`${CDN}/lvt/detail/${colorSlug}-vinyl-flooring.jpg`);
    if (nameSlug) urls.push(`${CDN}/lvt/detail/${nameSlug}-vinyl-flooring.jpg`);
    if (collSlug && colorSlug) {
      urls.push(`${CDN}/colornames/${colorSlug}-${collSlug}.jpg`);
      urls.push(`${CDN}/colornames/${collSlug}-${colorSlug}.jpg`);
    }
    if (colorSlug) urls.push(`${CDN}/colornames/${colorSlug}.jpg`);
    return [...new Set(urls)];
  }

  // ── Hardwood ──
  if (/hardwood|engineered/i.test(catLower)) {
    if (collSlug && colorSlug) {
      urls.push(`${CDN}/lvt/detail/${collSlug}-${colorSlug}-vinyl-flooring.jpg`);
      urls.push(`${CDN}/colornames/${colorSlug}-${collSlug}.jpg`);
      urls.push(`${CDN}/colornames/${collSlug}-${colorSlug}.jpg`);
    }
    if (nameSlug) urls.push(`${CDN}/colornames/${nameSlug}.jpg`);
    return [...new Set(urls)];
  }

  // ── Mosaic / Glass Tile ──
  if (/mosaic|glass.tile/i.test(catLower)) {
    if (nameSlug) {
      urls.push(`${CDN}/mosaics/${nameSlug}.jpg`);
      urls.push(`${CDN}/mosaics/thumbnails/${nameSlug}.jpg`);
      for (const f of ['polished', 'honed', 'matte', 'glossy']) {
        urls.push(`${CDN}/mosaics/${nameSlug}-${f}.jpg`);
      }
    }
    // Also try porcelain patterns as fallback
    if (collSlug && colorSlug) {
      urls.push(`${CDN}/porcelainceramic/${colorSlug}-${collSlug}-porcelain.jpg`);
      urls.push(`${CDN}/porcelainceramic/iso/${colorSlug}-${collSlug}-porcelain-iso.jpg`);
    }
    return [...new Set(urls)];
  }

  // ── Stacked Stone / Ledger ──
  if (/stacked.stone|ledger/i.test(catLower)) {
    if (nameSlug) {
      for (const pat of ['ledger-panel', 'stacked-stone-panel', 'rockmount-stacked-stone']) {
        urls.push(`${CDN}/hardscaping/detail/${nameSlug}-${pat}.jpg`);
      }
      urls.push(`${CDN}/hardscaping/detail/${nameSlug}.jpg`);
      urls.push(`${CDN}/colornames/${nameSlug}.jpg`);
    }
    return [...new Set(urls)];
  }

  // ── Natural Stone ──
  if (/natural.stone|marble|granite|travertine|quartzite|limestone|slate|sandstone|onyx/i.test(catLower)) {
    if (nameSlug) {
      urls.push(`${CDN}/natural-stone/detail/${nameSlug}.jpg`);
      for (const m of ['granite', 'marble', 'quartzite', 'travertine', 'limestone', 'slate']) {
        urls.push(`${CDN}/colornames/${nameSlug}-${m}.jpg`);
      }
      urls.push(`${CDN}/colornames/${nameSlug}.jpg`);
    }
    return [...new Set(urls)];
  }

  // ── Porcelain / Ceramic (default for tile) ──
  if (collSlug && colorSlug) {
    if (sizeSlug) {
      urls.push(`${CDN}/porcelainceramic/${colorSlug}-${collSlug}-porcelain-${sizeSlug}-polished.jpg`);
      urls.push(`${CDN}/porcelainceramic/${colorSlug}-${collSlug}-${sizeSlug}-polished.jpg`);
    }
    urls.push(`${CDN}/porcelainceramic/iso/${colorSlug}-${collSlug}-porcelain-iso.jpg`);
    urls.push(`${CDN}/porcelainceramic/iso/${collSlug}-${colorSlug}-porcelain-iso.jpg`);
    urls.push(`${CDN}/porcelainceramic/${colorSlug}-${collSlug}-porcelain.jpg`);
    urls.push(`${CDN}/porcelainceramic/${colorSlug}-${collSlug}-ceramic.jpg`);
    urls.push(`${CDN}/porcelainceramic/${collSlug}-${colorSlug}-porcelain.jpg`);
    urls.push(`${CDN}/colornames/${colorSlug}-${collSlug}.jpg`);
    urls.push(`${CDN}/colornames/${collSlug}-${colorSlug}.jpg`);
  }
  if (nameSlug) {
    urls.push(`${CDN}/porcelainceramic/iso/${nameSlug}-porcelain-iso.jpg`);
    urls.push(`${CDN}/porcelainceramic/${nameSlug}-porcelain.jpg`);
    urls.push(`${CDN}/colornames/${nameSlug}.jpg`);
    // Reverse word order
    const parts = nameSlug.split('-');
    if (parts.length >= 2) {
      const rev = [...parts].reverse().join('-');
      urls.push(`${CDN}/porcelainceramic/${rev}-porcelain.jpg`);
      urls.push(`${CDN}/porcelainceramic/iso/${rev}-porcelain-iso.jpg`);
    }
  }

  return [...new Set(urls)];
}

async function cdnFallback(pool, skuIndex, matchedSkuIds) {
  log('');
  log('══ CDN FALLBACK (public website) ══');

  // Find SKUs that still have no primary image
  const { rows: missing } = await pool.query(`
    SELECT s.id as sku_id
    FROM skus s
    JOIN products p ON s.product_id = p.id
    JOIN vendors v ON p.vendor_id = v.id
    LEFT JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
    WHERE v.code = 'MSI' AND ma.id IS NULL AND s.variant_type IS DISTINCT FROM 'accessory'
  `);
  const missingSet = new Set(missing.map(r => r.sku_id));
  log(`  ${missingSet.size} SKUs still missing primary images after DAM phase.`);

  if (missingSet.size === 0 || DRY_RUN) {
    if (DRY_RUN) log('  (skipping CDN probe in dry-run mode)');
    return 0;
  }

  let saved = 0, probed = 0, noCandidates = 0;

  for (const [, entry] of skuIndex.exact) {
    if (!missingSet.has(entry.sku_id)) continue;
    if (entry.variant_type === 'accessory') continue;

    const candidates = buildCdnCandidates(entry);
    if (candidates.length === 0) { noCandidates++; continue; }

    probed++;
    let hit = await probeFirst(candidates);

    // Promote thumbnail to full-size
    if (hit && /\/thumbnails\//i.test(hit)) {
      const full = hit.replace('/thumbnails/', '/');
      const fullHit = await headUrl(full);
      if (fullHit) hit = fullHit;
    }

    if (hit) {
      await upsertMediaAsset(pool, {
        product_id: entry.product_id,
        sku_id: entry.sku_id,
        asset_type: 'primary',
        url: hit,
        original_url: hit,
        sort_order: 0,
      });
      matchedSkuIds.add(entry.sku_id);
      saved++;
    }

    if (probed % 200 === 0) log(`  CDN progress: ${probed} probed, ${saved} found`);
    // Small delay every 50 requests to be polite
    if (probed % 50 === 0) await delay(500);
  }

  log(`  CDN fallback: ${probed} probed, ${saved} saved, ${noCandidates} no candidates`);
  return saved;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Load DAM paths for one asset type: from cache (in dry-run) or via QueryBuilder API.
 * Returns the array of DAM paths.
 */
async function loadDamPaths(page, assetTypeDef) {
  const cachePath = path.join(__dirname, '..', 'data', assetTypeDef.cacheFile);

  if (DRY_RUN && fs.existsSync(cachePath)) {
    const paths = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    log(`  [${assetTypeDef.label}] Loaded ${paths.length} paths from cache (dry-run).`);
    return paths;
  }

  if (!page) {
    // No browser session — fall back to cache if available
    if (fs.existsSync(cachePath)) {
      const paths = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      log(`  [${assetTypeDef.label}] Loaded ${paths.length} paths from cache (no browser).`);
      return paths;
    }
    log(`  [${assetTypeDef.label}] No cache available and no browser session. Skipping.`);
    return [];
  }

  // Fetch from DAM API
  const paths = await fetchDamPathsByTag(page, assetTypeDef.tag, assetTypeDef.label);
  if (paths.length === 0 && fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    log(`  [${assetTypeDef.label}] API returned 0 — loaded ${cached.length} from cache.`);
    return cached;
  }
  if (paths.length > 0) {
    fs.writeFileSync(cachePath, JSON.stringify(paths, null, 2));
    log(`  [${assetTypeDef.label}] Cached ${paths.length} paths to ${assetTypeDef.cacheFile}.`);
  }
  return paths;
}

/**
 * Match a set of DAM paths to DB SKUs, with optional category filtering.
 * Returns { uniqueMatches, noMatch }.
 */
function matchPaths(damPaths, skuIndex, { filterCategory, label }) {
  // Optionally filter to relevant product categories
  const filtered = filterCategory
    ? damPaths.filter(p => { const cat = extractDamCategory(p); return cat && RELEVANT_CATEGORIES.has(cat); })
    : damPaths;
  log(`  [${label}] ${filtered.length} paths after category filter (of ${damPaths.length}).`);

  const matches = [];
  const noMatch = [];

  for (const damPath of filtered) {
    const damSku = extractDamSku(damPath);
    const match = matchDamToSku(damSku, skuIndex);
    if (match) {
      matches.push({ damPath, damSku, renditionUrl: buildRenditionUrl(damPath), ...match });
    } else {
      noMatch.push(damSku);
    }
  }

  // Deduplicate: one match per SKU
  const seenSkus = new Set();
  const uniqueMatches = [];
  for (const m of matches) {
    if (seenSkus.has(m.sku_id)) continue;
    seenSkus.add(m.sku_id);
    uniqueMatches.push(m);
  }

  log(`  [${label}] Matched: ${matches.length} total, ${uniqueMatches.length} unique SKUs, ${noMatch.length} unmatched.`);

  // Strategy breakdown
  const byStrategy = {};
  for (const m of uniqueMatches) {
    byStrategy[m.strategy] = (byStrategy[m.strategy] || 0) + 1;
  }
  log(`  [${label}] Strategies: ${Object.entries(byStrategy).map(([k,v]) => `${k}=${v}`).join(', ')}`);

  return { uniqueMatches, noMatch };
}

async function run() {
  log('MSI DAM Image Importer');
  log(`Options: manual-login=${MANUAL_LOGIN}, dry-run=${DRY_RUN}, limit=${LIMIT || 'all'}`);
  log(`Asset types: ${DAM_ASSET_TYPES.map(t => t.label).join(', ')}`);

  // Connect to database
  const pool = new pg.Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     process.env.DB_PORT     || 5432,
    database: process.env.DB_NAME     || 'flooring_pim',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  let browser;
  try {
    // Build SKU index from database
    log('Building SKU index from database...');
    const skuIndex = await buildSkuIndex(pool);

    // Launch browser if needed (not needed for dry-run with cache)
    let page = null;
    const allCached = DRY_RUN && DAM_ASSET_TYPES.every(t =>
      fs.existsSync(path.join(__dirname, '..', 'data', t.cacheFile))
    );

    if (!allCached) {
      const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH
        || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      browser = await puppeteer.launch({
        headless: false,  // Must be visible — DAM opens via popup/window.open
        executablePath: chromePath,
        args: [
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
          '--window-size=1200,900', '--window-position=100,50',
        ],
        defaultViewport: null,
      });
      page = await browser.newPage();
      page.setDefaultTimeout(30000);

      // Bring Chrome window to front on macOS
      if (MANUAL_LOGIN && process.platform === 'darwin') {
        const { exec } = await import('child_process');
        exec(`osascript -e 'tell application "Google Chrome" to activate'`);
        log('Brought Chrome window to front.');
      }

      const authenticated = await authenticateDAM(page);
      if (!authenticated) {
        log('Authentication failed. Exiting.');
        return;
      }
      // If DAM opened in a new tab, switch to that page
      if (page._damPage) {
        page = page._damPage;
      }
    }

    // ── Process each DAM asset type ──────────────────────────────────────────
    const allSavedSkuIds = new Set();
    let totalSaved = 0, totalSkipped = 0, totalFailed = 0;
    const summaryLines = [];

    for (const assetTypeDef of DAM_ASSET_TYPES) {
      log('');
      log(`══ ${assetTypeDef.label.toUpperCase()} (→ ${assetTypeDef.assetType}, order=${assetTypeDef.sortOrder}) ══`);

      // Load paths (from cache or API)
      const damPaths = await loadDamPaths(page, assetTypeDef);
      if (damPaths.length === 0) {
        log(`  No paths available for ${assetTypeDef.label}. Skipping.`);
        summaryLines.push(`  ${assetTypeDef.label}: 0 paths, 0 saved`);
        continue;
      }

      // Match to DB SKUs
      const { uniqueMatches, noMatch } = matchPaths(damPaths, skuIndex, {
        filterCategory: assetTypeDef.filterCategory,
        label: assetTypeDef.label,
      });

      if (VERBOSE && noMatch.length > 0) {
        log(`  Sample unmatched (first 15):`);
        noMatch.slice(0, 15).forEach(s => log(`    ${s}`));
      }

      // Apply limit
      const toProcess = LIMIT ? uniqueMatches.slice(0, LIMIT) : uniqueMatches;

      // File suffix for non-primary images (so primary.jpg and iso.jpg don't collide)
      const fileSuffix = assetTypeDef.sortOrder === 0 ? '' : '-iso';

      // Download + save
      const { saved, skipped, failed, savedSkuIds } = await processMatches(pool, page, toProcess, {
        assetType: assetTypeDef.assetType,
        sortOrder: assetTypeDef.sortOrder,
        fileSuffix,
      });

      for (const id of savedSkuIds) allSavedSkuIds.add(id);
      totalSaved += saved;
      totalSkipped += skipped;
      totalFailed += failed;
      summaryLines.push(`  ${assetTypeDef.label}: ${damPaths.length} paths, ${uniqueMatches.length} matched, ${saved} saved, ${skipped} skipped, ${failed} failed`);
    }

    // ── CDN Fallback for SKUs without images ──────────────────────────────────
    const cdnSaved = await cdnFallback(pool, skuIndex, allSavedSkuIds);
    totalSaved += cdnSaved;
    if (cdnSaved > 0) summaryLines.push(`  cdn-fallback: ${cdnSaved} saved`);

    // ── Sibling inheritance (primary images only) ────────────────────────────
    const inherited = await inheritSiblings(pool, skuIndex, allSavedSkuIds);

    // ── Summary ──────────────────────────────────────────────────────────────
    log('');
    log('═══════════════════════════════════════════════════════════');
    log('  SUMMARY');
    for (const line of summaryLines) log(line);
    log('  ─────────────────────────────────────────────────────────');
    log(`  Total saved:            ${totalSaved}`);
    log(`  Total skipped:          ${totalSkipped}`);
    log(`  Total failed:           ${totalFailed}`);
    log(`  Sibling inherited:      ${inherited}`);
    log('═══════════════════════════════════════════════════════════');

    // Final coverage check
    const { rows: coverage } = await pool.query(`
      SELECT
        COUNT(DISTINCT s.id) as total_skus,
        COUNT(DISTINCT CASE WHEN ma.id IS NOT NULL THEN s.id END) as skus_with_images,
        COUNT(DISTINCT p.id) as total_products,
        COUNT(DISTINCT CASE WHEN ma2.id IS NOT NULL THEN p.id END) as products_with_images
      FROM skus s
      JOIN products p ON s.product_id = p.id
      JOIN vendors v ON p.vendor_id = v.id
      LEFT JOIN media_assets ma ON ma.sku_id = s.id
      LEFT JOIN media_assets ma2 ON ma2.product_id = p.id
      WHERE v.code = 'MSI'
    `);
    const c = coverage[0];
    log(`  Coverage: ${c.skus_with_images}/${c.total_skus} SKUs (${(c.skus_with_images/c.total_skus*100).toFixed(1)}%), ${c.products_with_images}/${c.total_products} products (${(c.products_with_images/c.total_products*100).toFixed(1)}%)`);

  } catch (err) {
    log(`FATAL: ${err.message}`);
    console.error(err);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await pool.end().catch(() => {});
  }
}

run();
