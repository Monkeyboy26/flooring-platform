/**
 * Generalized Moma collection onboarder (vendor 896) — reads new-collections-march2026.json
 * and onboards ONE collection by code. Pricing via base.js house model (NOT import-moma.js
 * 1.6x). Images self-hosted under /uploads/moma/<slug>/ by convention:
 *   <colorcode-lower>@1.jpg (primary), @2.jpg (alt), lifestyle{1,2,3}.jpg (shared).
 * The onboarder attaches only files that actually exist on disk (fs check in the container).
 * Idempotent. Dry-run by default.
 *   docker exec -e COLLECTION=ML -e APPLY=1 flooring-api node /app/data/moma/onboard-moma-collection.mjs
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { upsertPricing } from '../../scrapers/base.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.env.APPLY === '1';
const CODE = (process.env.COLLECTION || '').toUpperCase();
if (!CODE) { console.error('set COLLECTION=<code> (e.g. ML)'); process.exit(1); }

const pool = new pg.Pool({ host: process.env.DB_HOST || 'db', port: 5432,
  database: 'flooring_pim', user: 'postgres', password: process.env.DB_PASSWORD || 'postgres' });
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'new-collections-march2026.json')));
const col = data.collections.find(c => c.code === CODE);
if (!col) { console.error(`collection ${CODE} not in JSON`); process.exit(1); }

const BRAND_ID = '346db123-0390-4cd9-afa8-d9925ec8b6b8';
const VENDOR = '896';
const slugify = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const SLUG = slugify(col.name);
const IMG_DIR = `/app/uploads/moma/${SLUG}`;
const compact = (s) => s.replace(/[^0-9]/g, '');
const nominal = (s) => { const [a, b] = s.split('x'); return `${a}"x${b}"`; };
const FINSUF = { Natural: '', Polished: 'POL', R11: 'R11', Structured: 'STR', Lineal: 'LIN' };
const appOf = (r) => r === 'wall' ? 'Wall' : r === 'paver' ? 'Floor · Outdoor' : 'Floor · Wall';
function productName(p) {
  const base = `${col.name} ${p.size}`;
  const style = p.variant ? ` ${p.variant}` : '';
  if (p.role === 'paver') return `${base}${style}, ${p.finish} Paver`;
  if (p.role === 'wall') return p.variant ? `${base} ${p.variant} Wall` : (p.finish === 'Natural' ? `${base} Wall` : `${base}, ${p.finish} Wall`);
  return `${base}${style}`;
}
const colorName = (code) => (col.colors.find(c => c.code === code) || {}).name || code;
const exists = (f) => { try { return fs.existsSync(f); } catch { return false; } };
// resolve an image by basename trying common extensions; returns container path or null
const resolveImg = (stem) => { for (const e of ['jpg', 'png', 'webp', 'jpeg']) { const f = `${IMG_DIR}/${stem}.${e}`; if (exists(f)) return f; } return null; };

async function catId(slug) { const r = await pool.query('SELECT id FROM categories WHERE slug=$1', [slug]); if (!r.rows.length) throw new Error('no category ' + slug); return r.rows[0].id; }

async function main() {
  console.log(`=== Onboard ${col.name} (${col.code}) [${APPLY ? 'APPLY' : 'DRY-RUN'}] slug=${SLUG} ===`);
  const ven = await pool.query('SELECT id FROM vendors WHERE code=$1', [VENDOR]);
  const vendorId = ven.rows[0].id;
  const CAT = { field: await catId(col.category_proposed),
    wall: await catId(col.wall_category_proposed || col.category_proposed),
    paver: await catId(col.paver_category_proposed || 'pavers') };
  const lifestyle = [1, 2, 3].map(n => resolveImg(`lifestyle${n}`)).filter(Boolean)
    .map(f => f.replace('/app', ''));
  console.log(`lifestyle images: ${lifestyle.length}`);

  let nP = 0, nS = 0, nImg = 0, noImg = 0;
  for (const p of col.products) {
    const name = p.product_name || productName(p);
    const categoryId = CAT[p.role] || CAT.field;
    console.log(`\n${name}  $${p.cost}  (${p.colors.length} colors, ${p.role})`);
    let productId = null;
    if (APPLY) {
      const r = await pool.query(`
        INSERT INTO products (vendor_id, brand_id, name, collection, category_id, status, description_short, description_long, slug)
        VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8)
        ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
          brand_id=EXCLUDED.brand_id, category_id=EXCLUDED.category_id, status='active',
          description_short=EXCLUDED.description_short, description_long=EXCLUDED.description_long,
          slug=COALESCE(products.slug, EXCLUDED.slug), updated_at=CURRENT_TIMESTAMP
        RETURNING id`, [vendorId, BRAND_ID, name, col.name, categoryId, col.description_short, col.description_short, slugify(name)]);
      productId = r.rows[0].id;
    }
    nP++;
    let lifeAttached = false;
    for (const code of p.colors) {
      const cname = colorName(code);
      const suf = FINSUF[p.finish] ?? '';
      const internal = `MOMA-${code}-${compact(p.size)}${suf ? '-' + suf : ''}`;
      console.log(`  ${cname} (${code}) -> ${internal}`);
      nS++;
      if (!APPLY) continue;
      const s = await pool.query(`
        INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, status)
        VALUES ($1,$2,$3,$4,'box','active')
        ON CONFLICT (internal_sku) DO UPDATE SET product_id=EXCLUDED.product_id, vendor_sku=EXCLUDED.vendor_sku,
          variant_name=EXCLUDED.variant_name, status='active', updated_at=CURRENT_TIMESTAMP
        RETURNING id`, [productId, `${code}-${compact(p.size)}${suf ? '-' + suf : ''}`, internal, cname]);
      const skuId = s.rows[0].id;
      await upsertPricing(pool, skuId, { cost: p.cost, retail_price: +(p.cost * 2).toFixed(2), price_basis: 'per_sqft' });
      const [pcs, sqft, bpal, spal, lbs] = p.pkg || [];
      await pool.query(`
        INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs, boxes_per_pallet, sqft_per_pallet)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box, pieces_per_box=EXCLUDED.pieces_per_box,
          weight_per_box_lbs=EXCLUDED.weight_per_box_lbs, boxes_per_pallet=EXCLUDED.boxes_per_pallet, sqft_per_pallet=EXCLUDED.sqft_per_pallet`,
        [skuId, sqft ?? null, pcs ?? null, lbs ?? null, bpal ?? null, spal ?? null]);
      const attrs = { material: 'Porcelain', look: col.look, collection: col.name, color: cname, color_code: code,
        finish: p.finish, size: nominal(p.size), application: appOf(p.role), rectified: 'Yes', ...(col.attrs || {}) };
      if (p.role === 'paver' && p.thickness) attrs.thickness = p.thickness;
      for (const [slug, val] of Object.entries(attrs)) {
        if (val == null || val === '') continue;
        await pool.query(`
          INSERT INTO sku_attributes (sku_id, attribute_id, value)
          SELECT $1, a.id, $3 FROM attributes a WHERE a.slug=$2
          ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value=EXCLUDED.value`, [skuId, slug, String(val)]);
      }
      // media: per-color face(s) + shared lifestyle
      const lc = code.toLowerCase();
      const faces = [[resolveImg(`${lc}@1`), 'primary', 0], [resolveImg(`${lc}@2`), 'alternate', 0]].filter(([f]) => f);
      if (faces.length) nImg++; else noImg++;
      const media = [...faces.map(([f, t, o]) => [f.replace('/app', ''), t, o])];
      lifestyle.forEach((u, i) => media.push([u, 'lifestyle', i]));
      for (const [url, type, sort] of media) {
        await pool.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
          VALUES ($1,$2,$3,$4,$4,$5,'momaceramichegroup.com')
          ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
          DO UPDATE SET url=EXCLUDED.url, original_url=EXCLUDED.original_url, source=EXCLUDED.source`,
          [productId, skuId, type, url, sort]);
      }
    }
  }
  // accessories (e.g. Boiserie trim)
  if (col.accessories && APPLY) {
    const accCat = await catId('trim-accessories');
    const apName = `${col.name} Trim`;
    const ap = await pool.query(`
      INSERT INTO products (vendor_id, brand_id, name, collection, category_id, status, description_short, slug)
      VALUES ($1,$2,$3,$4,$5,'active',$6,$7)
      ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET status='active', updated_at=CURRENT_TIMESTAMP
      RETURNING id`, [vendorId, BRAND_ID, apName, col.name, accCat, `Matching trim for the ${col.name} collection.`, slugify(apName)]);
    for (const a of col.accessories) {
      for (const code of (a.colors || ['ALL'])) {
        const internal = `MOMA-${code}-TRIM`;
        const s = await pool.query(`
          INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, accessory_label, status)
          VALUES ($1,$2,$3,$4,'unit','accessory',$5,'active')
          ON CONFLICT (internal_sku) DO UPDATE SET status='active', updated_at=CURRENT_TIMESTAMP RETURNING id`,
          [ap.rows[0].id, `${code}-TRIM`, internal, `${a.label} — ${colorName(code)}`, a.label]);
        await upsertPricing(pool, s.rows[0].id, { cost: a.cost, retail_price: +(a.cost * 1.7).toFixed(2), price_basis: 'per_unit' });
      }
    }
    console.log(`\nAccessories: ${col.accessories.length} trim type(s)`);
  }
  console.log(`\n${APPLY ? 'Onboarded' : 'Would onboard'}: ${nP} products, ${nS} SKUs${APPLY ? `, faces on ${nImg} / ${noImg} without` : ''}.`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
