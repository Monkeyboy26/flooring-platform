#!/usr/bin/env node
/**
 * Import MSI Q Premium Natural Quartz SLABS — the slab/countertop program that is
 * NOT carried in MSI's EDI 832 tile catalog (msi-unified.js) nor the tile price
 * book (msi-pricelist-jan26.xlsb). Source: the CA/OR "2025 QZ PriceList — Oct '25"
 * PDF (parsed to backend/data/msi/quartz-slabs.json).
 *
 * Onboarded under vendor MSI (code MSI), brand "MSI Surfaces", as per-slab items:
 *   • sell_by = 'unit', price_basis = 'per_unit'
 *   • Cost basis = the price list's LOOSE $/sq ft channel (individual-slab buy).
 *   • Per-slab cost = loose $/sqft × nominal slab area (from the size chart).
 *   • Retail = keystone 1.6× via canonical upsertPricing (base.js): nine-ending
 *     charm pricing applied; keystone guard (1.95–2.05 band) does NOT fire at 1.6.
 *   • packaging.sqft_per_box = nominal slab area (informational; 1 slab = 1 piece).
 *
 * Modeling: one product per color(+finish); thickness (1.5/2/3 cm) = SKU variants
 * (thickness pills). Matte/Concrete/Honed/Brushed finishes are their own products
 * (distinct item IDs & pricing). Venetian Marble (RSL-) → marble-countertops.
 * Discontinued colors are imported with status='discontinued' (hidden).
 *
 * Idempotent — safe to re-run.
 * Usage:
 *   node scripts/import-msi-quartz-slabs.mjs --dry-run   # manifest only, no writes
 *   node scripts/import-msi-quartz-slabs.mjs             # apply
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { upsertPricing } from '../scrapers/base.js';

const DRY = process.argv.includes('--dry-run');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'msi', 'quartz-slabs.json');

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const MSI_BRAND = 'c00e0000-0000-0000-0000-000000000001'; // MSI Surfaces
const RETAIL_MARKUP = 1.6;

// ---------- naming / classification helpers ----------
const titleCase = s => s.toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
// Strip footnote markers (* = also in matte/concrete, ** = bookmatch avail) and (Discontinued).
const cleanName = s => s.replace(/\s*\(discontinued\)/i, '').replace(/\*+/g, '').replace(/\s*-\s*/g, ' ').replace(/\s+/g, ' ').trim();

function detectFinish(color) {
  if (/\bhoned\b/i.test(color)) return 'Honed';
  if (/\bmatte\b/i.test(color)) return 'Matte';
  if (/\bconcrete\b/i.test(color)) return 'Concrete';
  if (/\bbrushed\b/i.test(color)) return 'Brushed';
  return 'Polished';
}
// base color = name minus finish word, minus thickness, minus (Discontinued)
function baseColor(color) {
  return cleanName(color)
    .replace(/\s*\b(1\.5cm|1\.6\s*cm)\b/gi, '')
    .replace(/\s*\b(honed|matte|concrete|brushed)\b/gi, '')
    .replace(/\s+/g, ' ').trim();
}
// product key: what groups SKUs into one product
function productKey(r) {
  if (r.section === 'venetian') return titleCase(baseColor(r.color));
  if (r.section === 'thin')     return baseColor(r.color);           // merge into base color product
  return cleanName(r.color);                                          // group/matte/qplus keep finish in name
}
const sizeLabel = sizes => {
  const s = (sizes || [])[0];
  return s === 'jumbo' ? 'Super Jumbo' : (s || '126x63');
};

// ---------- DB helpers (mirror import-mizunara.js) ----------
async function getCategoryId(slug) {
  const r = await pool.query('SELECT id FROM categories WHERE slug=$1', [slug]);
  return r.rows.length ? r.rows[0].id : null;
}
async function upsertProduct(vendorId, categoryId, p) {
  const r = await pool.query(`
    INSERT INTO products (vendor_id, brand_id, name, collection, category_id, status, category_source, description_short, description_long)
    VALUES ($1,$2,$3,$4,$5,$6,'manual',$7,$8)
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
      brand_id=EXCLUDED.brand_id, category_id=EXCLUDED.category_id, status=EXCLUDED.status,
      category_source='manual', description_short=EXCLUDED.description_short,
      description_long=EXCLUDED.description_long, updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [vendorId, MSI_BRAND, p.name, p.collection, categoryId, p.status, p.description_short, p.description_long]);
  return r.rows[0];
}
async function upsertSku(productId, s) {
  const r = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, status)
    VALUES ($1,$2,$3,$4,'unit',NULL,$5)
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id=EXCLUDED.product_id, vendor_sku=EXCLUDED.vendor_sku,
      variant_name=EXCLUDED.variant_name, sell_by='unit', status=EXCLUDED.status,
      updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [productId, s.vendor_sku, s.internal_sku, s.variant_name, s.status]);
  return r.rows[0];
}
async function upsertPackaging(skuId, sqft) {
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box) VALUES ($1,$2,1)
    ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box, pieces_per_box=1
  `, [skuId, sqft]);
}
const attrCache = new Map();
async function attrId(slug) {
  if (attrCache.has(slug)) return attrCache.get(slug);
  const r = await pool.query('SELECT id FROM attributes WHERE slug=$1', [slug]);
  const id = r.rows.length ? r.rows[0].id : null;
  attrCache.set(slug, id);
  return id;
}
async function setAttr(skuId, slug, value) {
  if (value == null || value === '') return;
  const id = await attrId(slug);
  if (!id) return;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1,$2,$3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value=EXCLUDED.value
  `, [skuId, id, String(value).trim()]);
}

// ---------- build product/sku plan from parsed rows ----------
function buildPlan(rows) {
  const products = new Map(); // key -> { name, collection, category, status, base, finish, skus:[] }
  for (const r of rows) {
    const key = productKey(r);
    const isVen = r.section === 'venetian';
    const finish = detectFinish(r.color);
    const base = isVen ? titleCase(baseColor(r.color)) : baseColor(r.color);
    if (!products.has(key)) {
      products.set(key, {
        name: key,
        collection: isVen ? 'Venetian Marble' : 'Q Premium Natural Quartz',
        categorySlug: isVen ? 'marble-countertops' : 'quartz-countertops',
        material: isVen ? 'Marble Look' : 'Quartz',
        base, finish,
        anyActive: false,
        skus: [],
        sizes: r.sizes, sqft: r.sqft,
      });
    }
    const P = products.get(key);
    // Each thickness present becomes a SKU
    const thicknesses = [];
    if (r.section === 'thin')      thicknesses.push(['1.5 cm', r.idThin, r.loose2]);
    else if (isVen)                thicknesses.push(['1.6 cm', r.idRsl, r.loose2]);
    else {
      if (r.id2 && r.loose2 != null) thicknesses.push(['2 cm', r.id2, r.loose2]);
      if (r.id3 && r.loose3 != null) thicknesses.push(['3 cm', r.id3, r.loose3]);
    }
    for (const [thk, itemId, looseSf] of thicknesses) {
      if (!itemId || looseSf == null) continue;
      const perSlabCost = +(looseSf * r.sqft).toFixed(2);
      const status = r.discontinued ? 'inactive' : 'active'; // skus_status_check has no 'discontinued'
      if (!r.discontinued) P.anyActive = true;
      P.skus.push({
        vendor_sku: itemId,
        internal_sku: `MSI-${itemId}`,
        variant_name: thk,
        thickness: thk,
        finish,
        color: base,
        material: P.material,
        looseSf, sqft: r.sqft, perSlabCost,
        retail: +(perSlabCost * RETAIL_MARKUP).toFixed(2),
        size: sizeLabel(r.sizes),
        status,
        qplus: r.section === 'qplus',
      });
    }
  }
  // product status: discontinued only if NO active sku
  for (const P of products.values()) P.status = P.anyActive ? 'active' : 'discontinued';
  return products;
}

function descFor(P) {
  const thks = [...new Set(P.skus.map(s => s.thickness))].join(', ');
  const short = `MSI Q Premium Natural Quartz slab — ${P.base}${P.finish !== 'Polished' ? `, ${P.finish.toLowerCase()} finish` : ''}. Sold per slab. Available thickness: ${thks}.`;
  const long = `${P.base} from MSI's Q Premium Natural Quartz program — engineered quartz surfacing for countertops, islands, and vertical applications. ${P.finish} finish. Nominal slab size ${P.skus[0]?.size || '126x63'} (sizes are approximate, ±2"). Non-porous, scratch- and stain-resistant. Residential Lifetime / Commercial 10-Year limited warranty. Priced per slab; pricing FOB MSI distribution center, subject to availability — fabricators must inspect material before cutting.`;
  return { short, long };
}

async function main() {
  console.log(`=== MSI Q Quartz Slab Import ${DRY ? '(DRY RUN)' : ''} ===\n`);
  const rows = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const vRes = await pool.query("SELECT id, name FROM vendors WHERE code='MSI'");
  const vendorId = vRes.rows[0].id;
  const catQuartz = await getCategoryId('quartz-countertops');
  const catMarble = await getCategoryId('marble-countertops');
  console.log(`Vendor ${vRes.rows[0].name} (${vendorId})`);
  console.log(`Categories: quartz=${catQuartz} marble=${catMarble}\n`);

  const plan = buildPlan(rows);
  const stats = { products: 0, active: 0, disc: 0, skus: 0, quartz: 0, marble: 0, sNew: 0, sUpd: 0, pNew: 0, pUpd: 0 };
  const manifest = [];

  for (const [key, P] of plan) {
    const categoryId = P.categorySlug === 'marble-countertops' ? catMarble : catQuartz;
    P.categorySlug === 'marble-countertops' ? stats.marble++ : stats.quartz++;
    stats.products++;
    P.status === 'active' ? stats.active++ : stats.disc++;
    const { short, long } = descFor(P);

    manifest.push({
      product: P.name, collection: P.collection, category: P.categorySlug, status: P.status,
      finish: P.finish, sqft: P.sqft,
      skus: P.skus.map(s => ({ id: s.vendor_sku, thk: s.thickness, looseSf: s.looseSf, perSlabCost: s.perSlabCost, retail: s.retail, status: s.status })),
    });

    if (!DRY) {
      const prod = await upsertProduct(vendorId, categoryId, {
        name: P.name, collection: P.collection, status: P.status, description_short: short, description_long: long,
      });
      prod.is_new ? stats.pNew++ : stats.pUpd++;
      for (const s of P.skus) {
        const sku = await upsertSku(prod.id, s);
        sku.is_new ? stats.sNew++ : stats.sUpd++;
        await upsertPricing(pool, sku.id, { cost: s.perSlabCost, retail_price: s.retail, price_basis: 'per_unit' });
        await upsertPackaging(sku.id, s.sqft);
        await setAttr(sku.id, 'color', s.color);
        await setAttr(sku.id, 'thickness', s.thickness);
        await setAttr(sku.id, 'finish', s.finish);
        await setAttr(sku.id, 'material', s.material);
        await setAttr(sku.id, 'size', `${s.size} in`);
        stats.skus++;
      }
    } else {
      stats.skus += P.skus.length;
    }
  }

  // Write manifest for review
  const mfPath = path.join(__dirname, '..', 'data', 'msi', 'quartz-slabs-manifest.json');
  fs.writeFileSync(mfPath, JSON.stringify(manifest, null, 2));

  console.log(`Products: ${stats.products} (active ${stats.active}, discontinued ${stats.disc}) | quartz ${stats.quartz}, marble ${stats.marble}`);
  console.log(`SKUs: ${stats.skus}`);
  if (!DRY) console.log(`  products new/upd: ${stats.pNew}/${stats.pUpd} | skus new/upd: ${stats.sNew}/${stats.sUpd}`);
  console.log(`\nManifest written: ${mfPath}`);

  // Sample manifest print
  console.log('\n=== SAMPLE (first 8 products) ===');
  for (const m of manifest.slice(0, 8)) {
    console.log(`\n${m.status === 'active' ? '●' : '○'} ${m.product}  [${m.collection} / ${m.category} / ${m.finish} / ${m.sqft}sf]`);
    for (const s of m.skus) console.log(`    ${s.thk.padEnd(6)} ${s.id.padEnd(26)} loose $${s.looseSf}/sf → cost $${s.perSlabCost} → retail $${s.retail} ${s.status==='discontinued'?'(disc)':''}`);
  }
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
