#!/usr/bin/env node
/**
 * Attach MSI Q Quartz slab images (product-level primary) by verifying MSI CDN URLs.
 * Runs AFTER import-msi-quartz-slabs.mjs. Idempotent — safe to re-run.
 *
 * MSI slab CDN pattern (from msi-unified.js):
 *   https://cdn.msisurfaces.com/images/quartz-countertops/products/slab/large/<slug>-quartz.jpg
 * where <slug> = cdnSlugify(name). We try finish-specific then base-color slugs,
 * HEAD-check each, and attach the first 200 as asset_type='primary'.
 *
 * Usage: node scripts/attach-msi-quartz-images.mjs [--dry-run]
 */
import pg from 'pg';

const DRY = process.argv.includes('--dry-run');
const CDN = 'https://cdn.msisurfaces.com/images';
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const CDN_SPELLING_MAP = [
  [/\bcalcatta\b/g, 'calacatta'], [/\bcalacata\b/g, 'calacatta'], [/\bcalcata\b/g, 'calacatta'],
  [/\bcararra\b/g, 'carrara'], [/\bcarara\b/g, 'carrara'],
];
const slugify = t => (t || '').toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
const cdnSlugify = t => { let s = slugify(t); for (const [p, r] of CDN_SPELLING_MAP) s = s.replace(p, r); return s; };

// strip bookmatch tokens the CDN slug never includes
const stripBook = t => t.replace(/\b(un)?book[\s-]*match\b/gi, '').replace(/\s+/g, ' ').trim();
const candidates = (name, baseColor) => {
  const variants = [name, baseColor, stripBook(name), stripBook(baseColor)].filter(Boolean);
  const slugs = [...new Set(variants.map(cdnSlugify))];
  const urls = [];
  for (const s of slugs) {
    urls.push(`${CDN}/quartz-countertops/products/slab/large/${s}-quartz.jpg`);
    urls.push(`${CDN}/quartz-countertops/products/slab/large/${s}.jpg`);
    urls.push(`${CDN}/colornames/${s}-quartz.jpg`);
  }
  return [...new Set(urls)];
};

async function head(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 9000);
    const r = await fetch(url, { method: 'HEAD', signal: c.signal });
    clearTimeout(t);
    // require an actual image, not an error page
    const ct = r.headers.get('content-type') || '';
    const len = parseInt(r.headers.get('content-length') || '0', 10);
    return r.status === 200 && /image/i.test(ct) && len > 3000;
  } catch { return false; }
}

async function pmap(items, fn, conc = 8) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

async function main() {
  console.log(`=== MSI Q Quartz Image Attach ${DRY ? '(DRY RUN)' : ''} ===\n`);
  const { rows: prods } = await pool.query(`
    SELECT p.id, p.name,
      (SELECT value FROM sku_attributes sa JOIN attributes a ON a.id=sa.attribute_id
       JOIN skus s ON s.id=sa.sku_id WHERE s.product_id=p.id AND a.slug='color' LIMIT 1) AS base_color,
      EXISTS(SELECT 1 FROM media_assets m WHERE m.product_id=p.id AND m.sku_id IS NULL AND m.asset_type='primary') AS has_img
    FROM products p JOIN vendors v ON v.id=p.vendor_id
    WHERE v.code='MSI' AND p.collection IN ('Q Premium Natural Quartz','Venetian Marble')
    ORDER BY p.name`);
  console.log(`Products: ${prods.length} (already have image: ${prods.filter(p => p.has_img).length})\n`);

  const results = await pmap(prods, async (p) => {
    if (p.has_img) return { ...p, url: null, skip: true };
    for (const url of candidates(p.name, p.base_color || p.name)) {
      if (await head(url)) return { ...p, url };
    }
    return { ...p, url: null };
  });

  let attached = 0, missing = [];
  for (const r of results) {
    if (r.skip) continue;
    if (r.url) {
      attached++;
      if (!DRY) {
        await pool.query(`
          INSERT INTO media_assets (product_id, asset_type, url, original_url, sort_order)
          VALUES ($1,'primary',$2,$2,0)
          ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
          DO UPDATE SET url=EXCLUDED.url, original_url=EXCLUDED.original_url
        `, [r.id, r.url]);
      }
    } else missing.push(r.name);
  }
  console.log(`Attached: ${attached}${DRY ? ' (dry-run, not written)' : ''}`);
  console.log(`No image found: ${missing.length}`);
  if (missing.length) console.log('  ' + missing.join(', '));
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
