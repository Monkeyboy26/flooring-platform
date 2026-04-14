#!/usr/bin/env node
/**
 * msi-fix-primary-images.cjs
 *
 * Probes MSI CDN for correct primary images for products that currently
 * have mismatched primaries (banners, roomscenes, videos, wrong colornames).
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

// CDN section mapping by category slug
const CATEGORY_SECTIONS = {
  'porcelain-tile':        ['porcelainceramic', 'PorcelainCeramic'],
  'ceramic-tile':          ['porcelainceramic', 'PorcelainCeramic'],
  'mosaic-tile':           ['mosaics'],
  'natural-stone':         ['naturalstone'],
  'stacked-stone':         ['naturalstone', 'hardscaping'],
  'hardscaping':           ['hardscaping'],
  'pavers':                ['hardscaping'],
  'lvp-plank':             ['lvt'],
  'backsplash-wall':       ['mosaics', 'porcelainceramic', 'backsplash'],
  'backsplash-tile':       ['mosaics', 'porcelainceramic', 'backsplash'],
  'transitions-moldings':  ['lvt', 'porcelainceramic'],
  'quartzite-countertops': ['naturalstone'],
  'granite-countertops':   ['naturalstone'],
  'marble-countertops':    ['naturalstone'],
};

function slugify(name) {
  return name.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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

  // Build slug variations from name and collection
  const fullSlug = slugify(name);
  const collSlug = slugify(collection || '');
  const colorSlug = color ? slugify(color) : '';

  // Try various slug patterns
  const slugs = [fullSlug];
  if (collSlug && colorSlug) {
    slugs.push(`${colorSlug}-${collSlug}`);
    slugs.push(`${collSlug}-${colorSlug}`);
  }
  if (collSlug) slugs.push(collSlug);

  for (const section of sections) {
    for (const slug of slugs) {
      // Pattern: /images/{section}/{slug}-{type}.jpg
      for (const type of types) {
        urls.push(`${base}/${section}/${slug}-${type}.jpg`);
      }
      // Pattern: /images/{section}/{slug}.jpg
      urls.push(`${base}/${section}/${slug}.jpg`);
      // Pattern: /images/{section}/iso/{slug}-iso.jpg
      urls.push(`${base}/${section}/iso/${slug}-iso.jpg`);
    }
  }

  // Also try colornames with correct slug
  if (collSlug) {
    urls.push(`${base}/colornames/${collSlug}.jpg`);
    urls.push(`${base}/colornames/iso/${collSlug}-iso.jpg`);
    if (fullSlug !== collSlug) {
      urls.push(`${base}/colornames/${fullSlug}.jpg`);
      urls.push(`${base}/colornames/iso/${fullSlug}-iso.jpg`);
    }
  }

  // SKU-specific patterns
  if (colorSlug && collSlug) {
    urls.push(`${base}/skus/${colorSlug}-${collSlug}.jpg`);
    urls.push(`${base}/skus/iso/${colorSlug}-${collSlug}-iso.jpg`);
  }

  return [...new Set(urls)]; // deduplicate
}

async function main() {
  console.log(`\n=== MSI Primary Image Fix (${DRY_RUN ? 'DRY RUN' : 'LIVE'}) ===\n`);

  const client = await pool.connect();
  try {
    // Get products with bad primaries
    const { rows: badProducts } = await client.query(`
      SELECT p.id, p.name, p.collection, c.slug as cat_slug, ma.id as media_id, ma.url as bad_url,
        (SELECT sa.value FROM sku_attributes sa
         JOIN attributes a ON sa.attribute_id = a.id
         JOIN skus s ON sa.sku_id = s.id
         WHERE s.product_id = p.id AND a.slug = 'color' LIMIT 1) as color
      FROM media_assets ma
      JOIN products p ON ma.product_id = p.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.vendor_id = $1 AND p.is_active
        AND ma.asset_type = 'primary' AND ma.sku_id IS NULL
        AND (
          ma.url LIKE '%/banners/%' OR ma.url LIKE '%/roomscenes/%'
          OR ma.url LIKE '%/videos/%' OR ma.url LIKE '%/blogs/%'
          OR ma.url LIKE '%/hardscape-redesign/%' OR ma.url LIKE '%/collections/%'
          OR ma.url LIKE '%/large-format-tile/%' OR ma.url LIKE '%/backsplash-redesign/%'
          OR ma.url LIKE '%/stile/%'
          OR (ma.url LIKE '%/colornames/%' AND
              LOWER(REGEXP_REPLACE(ma.url, '.*/colornames/(?:iso/|detail/|skus/)?', ''))
              NOT LIKE LOWER(REPLACE(REPLACE(REPLACE(p.collection, ' ', '-'), '''', ''), '.', '')) || '%')
        )
      ORDER BY p.name
    `, [VENDOR_ID]);

    console.log(`  Products with bad primaries: ${badProducts.length}\n`);

    let fixed = 0;
    let notFound = 0;
    const BATCH = 5; // concurrent probes

    if (!DRY_RUN) await client.query('BEGIN');

    for (let i = 0; i < badProducts.length; i += BATCH) {
      const batch = badProducts.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async (prod) => {
        const candidates = generateCandidateUrls(prod.name, prod.collection, prod.color, prod.cat_slug);

        for (const url of candidates) {
          const found = await headUrl(url);
          if (found) return { prod, url: found };
        }
        return { prod, url: null };
      }));

      for (const { prod, url } of results) {
        if (url) {
          if (VERBOSE || DRY_RUN) {
            console.log(`  FOUND: "${prod.name}" → ${url}`);
          }
          if (!DRY_RUN) {
            await client.query('UPDATE media_assets SET url = $1 WHERE id = $2', [url, prod.media_id]);
          }
          fixed++;
        } else {
          if (VERBOSE) console.log(`  MISS:  "${prod.name}" (tried ${generateCandidateUrls(prod.name, prod.collection, prod.color, prod.cat_slug).length} URLs)`);
          notFound++;
        }
      }

      // Progress
      if ((i + BATCH) % 20 === 0 || i + BATCH >= badProducts.length) {
        process.stdout.write(`  Progress: ${Math.min(i + BATCH, badProducts.length)}/${badProducts.length} (${fixed} fixed)\r`);
      }
    }

    if (!DRY_RUN) await client.query('COMMIT');

    console.log(`\n\n  Fixed:     ${fixed}`);
    console.log(`  Not found: ${notFound}`);
    console.log(`  Total:     ${badProducts.length}\n`);

  } catch (err) {
    if (!DRY_RUN) await client.query('ROLLBACK').catch(() => {});
    console.error('FATAL:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
