#!/usr/bin/env node
/**
 * msi-fix-cdn-images.cjs
 *
 * Fixes ~721 MSI CDN images that are on the wrong products.
 * Three categories:
 *   1. Generic banners (hardscape-redesign, banners, blogs, stile, etc.)
 *   2. Roomscene/video alternates
 *   3. Wrong-product images (CDN slug doesn't match product name/collection)
 *
 * For each bad image:
 *   - Delete it
 *   - If it was a primary, probe CDN for a correct replacement
 */
const { Pool } = require('pg');
const https = require('https');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';

const CATEGORY_SECTIONS = {
  'porcelain-tile':        ['porcelainceramic'],
  'ceramic-tile':          ['porcelainceramic'],
  'mosaic-tile':           ['mosaics'],
  'natural-stone':         ['naturalstone'],
  'stacked-stone':         ['naturalstone', 'hardscaping'],
  'hardscaping':           ['hardscaping'],
  'pavers':                ['hardscaping'],
  'lvp-plank':             ['lvt'],
  'backsplash-wall':       ['mosaics', 'porcelainceramic'],
  'backsplash-tile':       ['mosaics', 'porcelainceramic'],
  'transitions-moldings':  ['lvt', 'porcelainceramic'],
  'quartzite-countertops': ['naturalstone'],
  'granite-countertops':   ['naturalstone'],
  'marble-countertops':    ['naturalstone'],
  'quartz-countertops':    ['naturalstone'],
};

function slugify(name) {
  return name.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractBase(name) {
  return name
    .replace(/\s+Trim\s*&\s*Accessories.*$/i, '')
    .replace(/\s+\d+\s*Mm\b.*/i, '')
    .replace(/\s+\d{4}\s+/g, ' ')
    .replace(/\s+(Matte|Polished|Honed|Glossy|Lappato|Satin|Rectified)\s*$/i, '')
    .replace(/\s+(3d|Mosaic|Bullnose|Hexagon)\s*.*/i, '')
    .replace(/\s*\(\s*\d+\s*Pcs?\s.*/i, '')
    .replace(/\s+(Cop|Pav|Tread|Cobble|Pebble|Coping|Pool|Kits|Pattern|Shotblast|Sandblast|Tumbl|Honed|Unfil|Eased).*/i, '')
    .replace(/x\d+.*/i, '')
    .replace(/\s+\d+["']?.*/i, '')
    .replace(/\s+(R11|R10|R9)\s*$/i, '')
    .replace(/\s+(Bullnose\s+)?(Mat|Pol)\s*$/i, '')
    .trim();
}

function headUrl(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 400 ? url : null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function generateCandidateUrls(name, collection, color, catSlug) {
  const urls = [];
  const base = 'https://cdn.msisurfaces.com/images';
  const sections = CATEGORY_SECTIONS[catSlug] || ['porcelainceramic', 'mosaics', 'naturalstone', 'hardscaping', 'lvt'];
  const types = ['detail', 'front', 'iso'];

  const baseName = extractBase(name);
  const fullSlug = slugify(baseName);
  const collSlug = slugify(collection || '');
  const colorSlug = color ? slugify(color) : '';

  // Build slug variations (keep small to avoid OOM)
  const slugs = [];
  if (fullSlug) slugs.push(fullSlug);
  if (collSlug && colorSlug) slugs.push(`${colorSlug}-${collSlug}`);
  if (collSlug && fullSlug !== collSlug) slugs.push(collSlug);

  for (const section of sections) {
    for (const slug of slugs) {
      urls.push(`${base}/${section}/${slug}.jpg`);
      urls.push(`${base}/${section}/${slug}-detail.jpg`);
      urls.push(`${base}/${section}/detail/${slug}.jpg`);
      urls.push(`${base}/${section}/iso/${slug}-iso.jpg`);
      urls.push(`${base}/${section}/edge/${slug}-edge.jpg`);
      urls.push(`${base}/${section}/${slug}-front.jpg`);
    }
  }

  // colornames
  if (collSlug) {
    urls.push(`${base}/colornames/${collSlug}.jpg`);
    urls.push(`${base}/colornames/detail-two/${collSlug}-detail-two.jpg`);
  }
  if (fullSlug && fullSlug !== collSlug) {
    urls.push(`${base}/colornames/${fullSlug}.jpg`);
  }

  return [...new Set(urls)];
}

function isGenericBanner(url) {
  return /\/(banners|hardscape-redesign|blogs|stile|large-format-tile|backsplash-redesign|collections)\//i.test(url);
}

function isRoomsceneOrVideo(url) {
  return /\/(roomscenes|videos|lvt-videos)\//i.test(url);
}

function getFilenameSlug(url) {
  const m = url.match(/\/([^/]+)\.(jpg|png|jpeg|webp)$/i);
  if (!m) return '';
  return m[1].toLowerCase()
    .replace(/-(iso|edge|detail|detail-two|front|variations|roomscene|video|header|swatch)$/, '');
}

function imageMatchesProduct(url, name, collection) {
  const fileSlug = getFilenameSlug(url);
  if (!fileSlug) return true; // can't determine

  const nameSlug = slugify(extractBase(name));
  const collSlug = slugify(collection || '');
  const nameWords = nameSlug.split('-').filter(w => w.length >= 4);
  const collWords = collSlug.split('-').filter(w => w.length >= 4);

  // Check if filename contains any distinctive word from name or collection
  for (const w of nameWords) {
    if (fileSlug.includes(w)) return true;
  }
  for (const w of collWords) {
    if (fileSlug.includes(w)) return true;
  }

  // For short names (< 4 chars first word), be lenient
  const firstWord = nameSlug.split('-')[0];
  if (firstWord.length < 4) return true; // can't reliably determine

  return false;
}

async function main() {
  console.log(`\n=== MSI CDN Image Fix (${DRY_RUN ? 'DRY RUN' : 'LIVE'}) ===\n`);

  const client = await pool.connect();
  try {
    // Load all CDN images for active MSI products
    const { rows: cdnImages } = await client.query(`
      SELECT ma.id as media_id, ma.product_id, ma.url, ma.asset_type, ma.sort_order,
        p.name, p.collection, c.slug as cat_slug,
        (SELECT sa.value FROM sku_attributes sa
         JOIN attributes a ON sa.attribute_id = a.id
         JOIN skus s ON sa.sku_id = s.id
         WHERE s.product_id = p.id AND a.slug = 'color' LIMIT 1) as color
      FROM media_assets ma
      JOIN products p ON ma.product_id = p.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.vendor_id = $1 AND p.is_active = true
        AND ma.url LIKE 'https://cdn.msisurfaces.com/%'
        AND ma.asset_type IN ('primary', 'alternate')
      ORDER BY p.name, ma.asset_type, ma.sort_order
    `, [VENDOR_ID]);

    console.log(`  Total CDN images: ${cdnImages.length}`);

    // Categorize bad images
    const badImages = [];
    for (const img of cdnImages) {
      let reason = null;
      if (isGenericBanner(img.url)) {
        reason = 'generic_banner';
      } else if (isRoomsceneOrVideo(img.url)) {
        reason = 'roomscene_video';
      } else if (!imageMatchesProduct(img.url, img.name, img.collection)) {
        reason = 'wrong_product';
      }
      if (reason) {
        badImages.push({ ...img, reason });
      }
    }

    console.log(`  Bad images found: ${badImages.length}`);
    const byReason = {};
    for (const img of badImages) {
      byReason[img.reason] = (byReason[img.reason] || 0) + 1;
    }
    for (const [reason, count] of Object.entries(byReason)) {
      console.log(`    ${reason}: ${count}`);
    }

    // Group by product
    const byProduct = new Map();
    for (const img of badImages) {
      if (!byProduct.has(img.product_id)) {
        byProduct.set(img.product_id, {
          name: img.name, collection: img.collection,
          cat_slug: img.cat_slug, color: img.color,
          bad: []
        });
      }
      byProduct.get(img.product_id).bad.push(img);
    }
    console.log(`  Affected products: ${byProduct.size}\n`);

    // Check which products will lose their primary
    const productsLosingPrimary = [];
    for (const [pid, info] of byProduct) {
      const hasBadPrimary = info.bad.some(b => b.asset_type === 'primary');
      if (hasBadPrimary) {
        // Check if they have a good primary or alternate that could be promoted
        const goodImages = cdnImages.filter(i =>
          i.product_id === pid &&
          !badImages.some(b => b.media_id === i.media_id)
        );
        productsLosingPrimary.push({
          pid, name: info.name, collection: info.collection,
          cat_slug: info.cat_slug, color: info.color,
          hasGoodPrimary: goodImages.some(i => i.asset_type === 'primary'),
          hasGoodAlternate: goodImages.some(i => i.asset_type === 'alternate'),
        });
      }
    }

    // Also check for non-CDN images (uploads) that could serve as primary
    const pidsNeedingPrimary = productsLosingPrimary
      .filter(p => !p.hasGoodPrimary)
      .map(p => p.pid);

    let uploadPrimaries = new Set();
    if (pidsNeedingPrimary.length > 0) {
      const { rows: uploads } = await client.query(`
        SELECT DISTINCT product_id FROM media_assets
        WHERE product_id = ANY($1)
          AND asset_type = 'primary'
          AND url NOT LIKE 'https://cdn.msisurfaces.com/%'
      `, [pidsNeedingPrimary]);
      uploadPrimaries = new Set(uploads.map(r => r.product_id));
    }

    const needsCdnProbe = productsLosingPrimary.filter(p =>
      !p.hasGoodPrimary && !uploadPrimaries.has(p.pid)
    );

    console.log(`  Products losing primary: ${productsLosingPrimary.length}`);
    console.log(`  Have good alternate to promote: ${productsLosingPrimary.filter(p => !p.hasGoodPrimary && p.hasGoodAlternate).length}`);
    console.log(`  Have upload primary: ${uploadPrimaries.size}`);
    console.log(`  Need CDN probe: ${needsCdnProbe.length}\n`);

    if (VERBOSE || DRY_RUN) {
      console.log('  --- Sample bad images ---');
      for (const img of badImages.slice(0, 20)) {
        const short = img.url.replace('https://cdn.msisurfaces.com/images/', '');
        console.log(`    [${img.asset_type}] "${img.name}" ← ${short} (${img.reason})`);
      }
      if (badImages.length > 20) console.log(`    ... and ${badImages.length - 20} more`);
      console.log();
    }

    // Phase 1: CDN probe for replacements
    console.log('  Phase 1: Probing CDN for correct images...');
    const replacements = new Map(); // pid -> url
    const BATCH = 3;

    for (let i = 0; i < needsCdnProbe.length; i += BATCH) {
      const batch = needsCdnProbe.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async (prod) => {
        const candidates = generateCandidateUrls(prod.name, prod.collection, prod.color, prod.cat_slug);
        for (const url of candidates) {
          const found = await headUrl(url);
          if (found) return { pid: prod.pid, url: found, name: prod.name };
        }
        return { pid: prod.pid, url: null, name: prod.name };
      }));

      for (const r of results) {
        if (r.url) {
          replacements.set(r.pid, r.url);
          if (VERBOSE) console.log(`    FOUND: "${r.name}" → ${r.url}`);
        } else if (VERBOSE) {
          console.log(`    MISS:  "${r.name}"`);
        }
      }

      if ((i + BATCH) % 40 === 0 || i + BATCH >= needsCdnProbe.length) {
        process.stdout.write(`    Progress: ${Math.min(i + BATCH, needsCdnProbe.length)}/${needsCdnProbe.length} (${replacements.size} found)\r`);
      }
    }
    console.log(`\n    Found replacements: ${replacements.size} / ${needsCdnProbe.length}\n`);

    if (DRY_RUN) {
      console.log('  DRY RUN — no changes made.\n');
      return;
    }

    // Phase 2: Execute changes
    console.log('  Phase 2: Applying fixes...');
    await client.query('BEGIN');

    // Delete all bad images
    const badIds = badImages.map(b => b.media_id);
    await client.query('DELETE FROM media_assets WHERE id = ANY($1::uuid[])', [badIds]);
    console.log(`    Deleted ${badIds.length} bad images`);

    // Promote alternates to primary for products that lost their primary and have no replacement
    let promoted = 0;
    for (const p of productsLosingPrimary) {
      if (p.hasGoodPrimary || uploadPrimaries.has(p.pid) || replacements.has(p.pid)) continue;
      if (!p.hasGoodAlternate) continue;

      // Find best alternate to promote
      const { rows: alts } = await client.query(`
        SELECT id, url FROM media_assets
        WHERE product_id = $1 AND asset_type = 'alternate'
        ORDER BY sort_order LIMIT 1
      `, [p.pid]);

      if (alts.length > 0) {
        await client.query(`
          UPDATE media_assets SET asset_type = 'primary', sort_order = 0
          WHERE id = $1
        `, [alts[0].id]);
        promoted++;
      }
    }
    console.log(`    Promoted ${promoted} alternates to primary`);

    // Insert CDN replacement primaries
    let replaced = 0;
    for (const [pid, url] of replacements) {
      await client.query(`
        INSERT INTO media_assets (product_id, url, asset_type, sort_order)
        VALUES ($1, $2, 'primary', 0)
      `, [pid, url]);
      replaced++;
    }
    console.log(`    Inserted ${replaced} CDN replacement primaries`);

    // For products still without primary, try sharing from same-collection sibling
    const { rows: stillMissing } = await client.query(`
      SELECT p.id, p.name, p.collection
      FROM products p
      WHERE p.vendor_id = $1 AND p.is_active = true
        AND NOT EXISTS (
          SELECT 1 FROM media_assets ma
          WHERE ma.product_id = p.id AND ma.asset_type = 'primary'
        )
        AND p.collection IS NOT NULL AND p.collection != ''
    `, [VENDOR_ID]);

    let shared = 0;
    for (const p of stillMissing) {
      const { rows: siblings } = await client.query(`
        SELECT ma.url FROM media_assets ma
        JOIN products p2 ON ma.product_id = p2.id
        WHERE p2.collection = $1 AND p2.vendor_id = $2 AND p2.is_active = true
          AND p2.id != $3 AND ma.asset_type = 'primary' AND ma.sku_id IS NULL
        LIMIT 1
      `, [p.collection, VENDOR_ID, p.id]);

      if (siblings.length > 0) {
        await client.query(`
          INSERT INTO media_assets (product_id, url, asset_type, sort_order)
          VALUES ($1, $2, 'primary', 0)
        `, [p.id, siblings[0].url]);
        shared++;
      }
    }
    console.log(`    Shared ${shared} sibling images`);

    await client.query('COMMIT');
    console.log('\n  Changes committed.\n');

    // Verify
    const { rows: [{ total_products, has_primary, pct }] } = await client.query(`
      SELECT
        COUNT(*) as total_products,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id AND ma.asset_type = 'primary'
        )) as has_primary,
        ROUND(100.0 * COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id AND ma.asset_type = 'primary'
        )) / COUNT(*), 1) as pct
      FROM products p
      WHERE p.vendor_id = $1 AND p.is_active = true
    `, [VENDOR_ID]);
    console.log(`  Final: ${has_primary}/${total_products} products have primary image (${pct}%)\n`);

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FATAL:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
