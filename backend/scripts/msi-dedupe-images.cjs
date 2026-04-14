#!/usr/bin/env node
/**
 * msi-dedupe-images.cjs
 *
 * For every primary image shared by multiple MSI products:
 *   1. Score each product against the image URL
 *   2. Keep the image on the single best-matching product
 *   3. Remove it from all others
 *
 * Wrong image is worse than no image — the storefront shows a clean
 * placeholder SVG when no image exists.
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';

function slugify(s) {
  return (s || '').toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const NOISE = new Set([
  'iso', 'front', 'edge', 'detail', 'two', 'matte', 'polished', 'honed', 'glossy',
  'porcelain', 'ceramic', 'vinyl', 'flooring', 'tile', 'marble', 'granite',
  'travertine', 'limestone', 'quartzite', 'sandstone', 'onyx',
  'pavers', 'paver', 'panels', 'panel', 'stacked', 'stone', 'ledger',
  'mosaic', 'hexagon', 'hex', 'herringbone', 'chevron', 'subway',
  'arabesque', 'picket', 'basketweave', 'penny', 'pencil',
  'trim', 'accessories', 'bullnose', 'molding', 'reducer', 'threshold',
  'stairnose', 'cap', 'corner', 'quarter', 'liner',
  'multi', 'finish', 'pattern', 'interlocking', 'mesh', 'backed',
  'tumbled', 'splitface', 'split', 'face', 'brushed', 'flamed',
  'manufactured', 'veneers', 'veneer',
  'jpg', 'png', 'jpeg', 'webp', 'medium', 'large', 'small',
  '2cm', '3cm', '4mm', '6mm', '8mm', '12mm',
  'variation', 'variations',
]);

function sigWords(text) {
  return slugify(text).split('-').filter(w => w.length > 2 && !NOISE.has(w));
}

function urlSigWords(url) {
  const m = url.match(/\/([^/]+?)(?:\.(jpg|png|jpeg|webp|svg))?$/i);
  if (!m) return [];
  return m[1].toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(w => w.length > 2 && !NOISE.has(w));
}

function matchScore(url, productName, collection) {
  const uw = urlSigWords(url);
  const pw = [...new Set([...sigWords(productName), ...sigWords(collection || '')])];
  if (uw.length === 0 || pw.length === 0) return 0;

  let matches = 0;
  for (const p of pw) {
    if (uw.some(u => u === p || (u.length >= 4 && p.length >= 4 && (u.startsWith(p) || p.startsWith(u))))) {
      matches++;
    }
  }
  return matches;
}

async function main() {
  console.log(`\n=== MSI Image Dedup (${DRY_RUN ? 'DRY RUN' : 'LIVE'}) ===\n`);
  const client = await pool.connect();

  try {
    // Find all shared primary images
    const { rows: sharedUrls } = await client.query(`
      WITH primaries AS (
        SELECT ma.id, ma.url, ma.product_id, p.name, p.collection
        FROM media_assets ma
        JOIN products p ON p.id = ma.product_id
        WHERE p.vendor_id = $1 AND p.is_active = true AND ma.asset_type = 'primary'
      )
      SELECT url, json_agg(json_build_object(
        'media_id', id, 'product_id', product_id, 'name', name, 'collection', collection
      )) as products
      FROM primaries
      GROUP BY url
      HAVING COUNT(DISTINCT product_id) > 1
      ORDER BY COUNT(DISTINCT product_id) DESC
    `, [VENDOR_ID]);

    let totalSharing = 0;
    let toRemove = [];

    for (const row of sharedUrls) {
      const products = row.products;
      totalSharing += products.length;

      // Score each product against the URL
      const scored = products.map(p => ({
        ...p,
        score: matchScore(row.url, p.name, p.collection),
      })).sort((a, b) => b.score - a.score);

      // Best match keeps it; all others lose it
      const keeper = scored[0];
      for (let i = 1; i < scored.length; i++) {
        toRemove.push({
          mediaId: scored[i].media_id,
          productId: scored[i].product_id,
          productName: scored[i].name,
          url: row.url,
          keeperName: keeper.name,
          keeperScore: keeper.score,
          loserScore: scored[i].score,
        });
      }
    }

    console.log(`  Shared URLs: ${sharedUrls.length}`);
    console.log(`  Products sharing: ${totalSharing}`);
    console.log(`  Images to remove: ${toRemove.length}`);
    console.log(`  Products keeping image: ${sharedUrls.length}`);

    // Also remove ALL non-primary shared images (alternates/lifestyle shared across products)
    const { rows: sharedNonPrimary } = await client.query(`
      WITH nonprimary AS (
        SELECT ma.id, ma.url, ma.product_id
        FROM media_assets ma
        JOIN products p ON p.id = ma.product_id
        WHERE p.vendor_id = $1 AND p.is_active = true AND ma.asset_type != 'primary'
      )
      SELECT n.id as media_id, n.product_id, n.url
      FROM nonprimary n
      WHERE n.url IN (
        SELECT url FROM nonprimary GROUP BY url HAVING COUNT(DISTINCT product_id) > 1
      )
    `, [VENDOR_ID]);

    // For non-primary shared, keep on first product alphabetically, remove from others
    const npByUrl = new Map();
    for (const r of sharedNonPrimary) {
      if (!npByUrl.has(r.url)) npByUrl.set(r.url, []);
      npByUrl.get(r.url).push(r);
    }
    let npRemoved = 0;
    const npRemoveIds = [];
    for (const [url, entries] of npByUrl) {
      // Keep first, remove rest
      for (let i = 1; i < entries.length; i++) {
        npRemoveIds.push(entries[i].media_id);
        npRemoved++;
      }
    }

    console.log(`  Shared non-primary images to remove: ${npRemoved}`);

    if (DRY_RUN) {
      console.log(`\n  --- Sample removals ---`);
      for (const r of toRemove.slice(0, 20)) {
        const short = r.url.replace('https://cdn.msisurfaces.com/images/', '').replace('/uploads/products/', 'uploads/');
        console.log(`    "${r.productName}" loses ${short} (kept by "${r.keeperName}", scores ${r.keeperScore}/${r.loserScore})`);
      }
      if (toRemove.length > 20) console.log(`    ... and ${toRemove.length - 20} more`);
      console.log(`\n  DRY RUN — no changes.\n`);
      return;
    }

    await client.query('BEGIN');

    // Remove shared primaries from non-owners
    const removeIds = toRemove.map(r => r.mediaId);
    const allRemoveIds = [...removeIds, ...npRemoveIds];
    for (let i = 0; i < allRemoveIds.length; i += 500) {
      await client.query('DELETE FROM media_assets WHERE id = ANY($1::uuid[])', [allRemoveIds.slice(i, i + 500)]);
    }

    // Promote alternates to primary where products lost their primary but have alternates
    const { rows: promotable } = await client.query(`
      WITH lost AS (
        SELECT DISTINCT p.id as product_id
        FROM products p
        WHERE p.vendor_id = $1 AND p.is_active = true
          AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id AND ma.asset_type = 'primary')
          AND EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
      )
      SELECT DISTINCT ON (l.product_id) ma.id, l.product_id
      FROM lost l
      JOIN media_assets ma ON ma.product_id = l.product_id
      ORDER BY l.product_id, ma.sort_order
    `, [VENDOR_ID]);

    for (const row of promotable) {
      await client.query(`UPDATE media_assets SET asset_type = 'primary', sort_order = 0 WHERE id = $1`, [row.id]);
    }

    await client.query('COMMIT');

    console.log(`\n  Removed ${removeIds.length} shared primaries + ${npRemoved} shared non-primaries`);
    console.log(`  Promoted ${promotable.length} alternates to primary`);

    // Final stats
    const { rows: [s] } = await client.query(`
      SELECT COUNT(*) as total,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id AND ma.asset_type = 'primary')) as has_primary,
        COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)) as no_image
      FROM products p WHERE p.vendor_id = $1 AND p.is_active = true
    `, [VENDOR_ID]);

    const { rows: [{ still_sharing }] } = await client.query(`
      WITH imgs AS (
        SELECT ma.url, ma.product_id FROM media_assets ma JOIN products p ON p.id = ma.product_id
        WHERE p.vendor_id = $1 AND p.is_active = true AND ma.asset_type = 'primary'
      )
      SELECT COUNT(DISTINCT i.product_id) as still_sharing
      FROM imgs i JOIN (SELECT url FROM imgs GROUP BY url HAVING COUNT(DISTINCT product_id) > 1) x ON x.url = i.url
    `, [VENDOR_ID]);

    console.log(`\n  === Final State ===`);
    console.log(`  Total: ${s.total}`);
    console.log(`  Has primary: ${s.has_primary} (${(s.has_primary/s.total*100).toFixed(1)}%)`);
    console.log(`  No image: ${s.no_image}`);
    console.log(`  Still sharing: ${still_sharing}`);

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
