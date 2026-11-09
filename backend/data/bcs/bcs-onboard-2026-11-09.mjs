// Onboard Best Cheer Stone (BCS, Anaheim) from the 9/2/2026 wholesale price
// list (parse-bcs-pricelist.py -> bcs-raw.json). Insert-only; re-runs skip
// existing vendor_skus. Creates vendor BCS + brand Best Cheer Stone if absent.
//
// Modeling (mirrors existing vendors):
//   - Prefabs (quartz 110" series, natural stone 108" series): GMI-style —
//     one product per color, sku per size(/finish), sell_by=unit, cost =
//     "Per Piece" price (crate price = volume discount, not carried),
//     packaging sqft_per_box = piece area, pieces_per_box = 1.
//   - Slabs (priced $/SF by vendor): Orion-style — sell_by=sqft,
//     price_basis=per_sqft, cost = SF Price (bundle price not carried).
//   - Shower wall panels: sell_by=unit per panel/set, category shower-panels;
//     product named "{Color} Shower Panel" (avoids name collision with quartz
//     colors, e.g. Bianco Swan exists in both lines).
//   Retail routes through base.js upsertPricing (retail=2x in -> 1.70x
//   keystone + charm + margin floors), same as Tarkett/Icon onboards.
//
// Page-break fixes (vendor PDF row groups split across pages):
//   - stone_slab: TAJ MAHAL's 4th row (Polished 2CM $36.49) belongs to
//     TAJ MAHAL-Premium.
//   - shower: SMC WAVE TILE's (96x36 $150) row belongs to SMC WHITE SLATE ROCK.
// Name fixes: cell-clipped "EVEREST CREEK GOL[D]" / "NEW COLONIAL CREA[M]",
// vendor typo "ELEGANT BRWON", "CALA. TAJ" -> Calacatta Taj.
//
//   docker exec -e DB_HOST=db flooring-api node data/bcs/bcs-onboard-2026-11-09.mjs [--apply]
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { upsertPricing, slugify } from '../../scrapers/base.js';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});
const APPLY = process.argv.includes('--apply');
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'bcs-raw.json'), 'utf8'));

// ── Normalization helpers ────────────────────────────────────────────────
const NAME_FIX = {
  'CALA. TAJ': 'Calacatta Taj',
  'ELEGANT BRWON': 'Elegant Brown',
  'EVEREST CREEK GOL': 'Everest Creek Gold',
  'NEW COLONIAL CREA': 'New Colonial Cream',
};
const MATERIALS = ['Granite', 'Quartzite', 'Dolomite', 'Marble'];
const CAT_BY_MATERIAL = {
  Quartz: 'quartz-countertops',
  Granite: 'granite-countertops',
  Quartzite: 'quartzite-countertops',
  Dolomite: 'marble-countertops',
  Marble: 'marble-countertops',
};
const FIN_TOK = { Polished: 'POL', Leathered: 'LEA', Honed: 'HON' };

function titleCase(name) {
  return name.split(/\s+/).map(w =>
    w === 'SMC' ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  ).join(' ');
}
function fixName(n) {
  let x = NAME_FIX[n] || n;
  x = x.replace(/-Premium$/i, ' PREMIUM');
  return titleCase(x);
}
function money(t) {
  if (!t || /coming/i.test(t) || t === '-') return null;
  const m = String(t).match(/\$?\s*([\d,]+(?:\.\d+)?)/);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}
function cleanMaterial(m) {
  const hit = MATERIALS.find(k => m === k || m.endsWith(k)); // 'DQuartzite' wrap
  return hit || null;
}
const skuTok = n => slugify(n).toUpperCase().replace(/[^A-Z0-9-]/g, '');

// ── Build product plan ──────────────────────────────────────────────────
// products: key -> { name, category, collection, materials:Set, flags, skus:[] }
const products = new Map();
function prod(key, name, category) {
  if (!products.has(key)) {
    products.set(key, { name, category, flags: {}, skus: [] });
  }
  return products.get(key);
}

// Quartz prefabs (110" x W) + quartz slabs merge under one product per color.
const Q_WIDTHS = [26, 36, 42, 52];
for (const item of raw.sections.quartz_prefab) {
  const name = fixName(item.name);
  const p = prod(`Q|${name}`, name, 'quartz-countertops');
  Object.assign(p.flags, item.flags.full_body ? { full_body: true } : {});
  p.material = 'Quartz';
  const piece = item.rows.find(r => r[0] === 'Per Piece');
  if (!piece) continue;
  Q_WIDTHS.forEach((w, i) => {
    const cost = money(piece[i + 1]);
    if (cost == null) return;
    p.skus.push({
      vendor_sku: `${skuTok(name)}-P${w}`,
      variant_name: `110" x ${w}" Prefab`,
      sell_by: 'unit', price_basis: 'per_unit', cost,
      packaging: { sqft_per_box: +(110 * w / 144).toFixed(2), pieces_per_box: 1 },
      attrs: { size: `110" x ${w}"` },
    });
  });
}
for (const item of raw.sections.quartz_slab) {
  const name = fixName(item.name);
  const p = prod(`Q|${name}`, name, 'quartz-countertops');
  if (item.flags.full_body) p.flags.full_body = true;
  if (item.flags.jumbo) p.flags.jumbo = true;
  p.material = 'Quartz';
  for (const r of item.rows) {
    if (r.length < 4 || !r[0]) continue;
    const [finish, thickness] = r;
    const cost = money(r[2]);
    if (cost == null) continue;
    p.skus.push({
      vendor_sku: `${skuTok(name)}-S${thickness}-${FIN_TOK[finish] || 'STD'}`,
      variant_name: `${thickness} Slab, ${finish}`,
      sell_by: 'sqft', price_basis: 'per_sqft', cost,
      attrs: { finish, thickness },
    });
  }
}

// Natural stone prefabs + slabs, one product per item name; category from material.
const S_WIDTHS = [26, 36, 42, 52];
for (const item of raw.sections.stone_prefab) {
  const name = fixName(item.name);
  for (const r of item.rows) {
    if (r.length < 7 || r[2] !== 'Per Piece') continue;
    const material = cleanMaterial(r[0]);
    const finish = r[1];
    if (!material) continue;
    const p = prod(`S|${name}`, name, CAT_BY_MATERIAL[material]);
    if (item.flags.size_varies) p.flags.size_varies = true;
    p.material = material;
    S_WIDTHS.forEach((w, i) => {
      const cost = money(r[3 + i]);
      if (cost == null) return;
      p.skus.push({
        vendor_sku: `${skuTok(name)}-${FIN_TOK[finish] || 'STD'}-P${w}`,
        variant_name: `108" x ${w}" Prefab, ${finish}`,
        sell_by: 'unit', price_basis: 'per_unit', cost,
        packaging: { sqft_per_box: +(108 * w / 144).toFixed(2), pieces_per_box: 1 },
        attrs: { size: `108" x ${w}"`, finish },
      });
    });
  }
}
// Page-break fix: TAJ MAHAL's stray 4th slab row ($36.49 polished 2CM) is
// TAJ MAHAL-Premium's first row.
{
  const tm = raw.sections.stone_slab.find(x => x.name === 'TAJ MAHAL');
  const tmp = raw.sections.stone_slab.find(x => x.name === 'TAJ MAHAL-Premium');
  if (tm && tmp) {
    const stray = tm.rows.findIndex(r => money(r[3]) === 36.49);
    if (stray >= 0) tmp.rows.unshift(...tm.rows.splice(stray, 1));
  }
}
for (const item of raw.sections.stone_slab) {
  const name = fixName(item.name);
  for (const r of item.rows) {
    if (r.length < 5) continue;
    const material = cleanMaterial(r[0]);
    const [, finish, thickness] = r;
    const cost = money(r[3]);
    if (!material || cost == null) continue;
    const p = prod(`S|${name}`, name, CAT_BY_MATERIAL[material]);
    p.material = p.material || material;
    p.skus.push({
      vendor_sku: `${skuTok(name)}-S${thickness}-${FIN_TOK[finish] || 'STD'}`,
      variant_name: `${thickness} Slab, ${finish}`,
      sell_by: 'sqft', price_basis: 'per_sqft', cost,
      attrs: { finish, thickness },
    });
  }
}

// Shower wall panels. Page-break fix: WAVE TILE's (96x36 $150) row belongs to
// SMC WHITE SLATE ROCK.
{
  const wave = raw.sections.shower_panel.find(x => x.name === 'SMC WAVE TILE');
  const slate = raw.sections.shower_panel.find(x => x.name === 'SMC WHITE SLATE ROCK');
  if (wave && slate) {
    const stray = wave.rows.findIndex(r => r[1] === '36' && money(r[3]) === 150);
    if (stray >= 0) slate.rows.unshift(...wave.rows.splice(stray, 1));
  }
}
for (const item of raw.sections.shower_panel) {
  const color = fixName(item.name);
  const name = `${color} Shower Panel`;
  const p = prod(`W|${name}`, name, 'shower-panels');
  p.colorName = color;
  for (const r of item.rows) {
    const [h, w, t] = r;
    const cost = money(r[3]);
    if (cost == null) continue;
    p.skus.push({
      vendor_sku: `${skuTok(color)}-SW-${h}X${w}-${t}MM`,
      variant_name: `${h}" x ${w}", ${t}mm`,
      sell_by: 'unit', price_basis: 'per_unit', cost,
      packaging: { sqft_per_box: +(h * w / 144).toFixed(2), pieces_per_box: 1 },
      attrs: { size: `${h}" x ${w}"`, thickness: `${t}mm` },
    });
  }
}

// Drop productless entries (all-Coming-Soon colors).
for (const [k, p] of products) if (!p.skus.length) products.delete(k);

// Duplicate vendor_sku guard (same color+finish+size listed twice would collide).
{
  const seen = new Map();
  for (const [, p] of products) for (const s of p.skus) {
    if (seen.has(s.vendor_sku)) throw new Error(`dup vendor_sku ${s.vendor_sku}`);
    seen.set(s.vendor_sku, p.name);
  }
}

// ── Plan summary ─────────────────────────────────────────────────────────
const byCat = {};
let skuTotal = 0;
for (const [, p] of products) {
  byCat[p.category] = byCat[p.category] || { products: 0, skus: 0 };
  byCat[p.category].products++;
  byCat[p.category].skus += p.skus.length;
  skuTotal += p.skus.length;
}
console.log(`BCS onboard plan: ${products.size} products / ${skuTotal} skus`);
for (const [c, n] of Object.entries(byCat)) console.log(`  ${c}: ${n.products} products, ${n.skus} skus`);

if (!APPLY) {
  for (const [, p] of products) {
    console.log(`\n[${p.category}] ${p.name}${p.flags.full_body ? ' (full body print)' : ''}${p.flags.jumbo ? ' (jumbo avail)' : ''}`);
    for (const s of p.skus) {
      console.log(`   ${s.vendor_sku.padEnd(34)} ${String(s.variant_name).padEnd(30)} $${s.cost}${s.price_basis === 'per_sqft' ? '/sqft' : '/pc'}`);
    }
  }
  console.log('\nDRY RUN — re-run with --apply to insert.');
  await pool.end();
  process.exit(0);
}

// ── Apply ────────────────────────────────────────────────────────────────
async function main() {
  // Vendor + brand
  let { rows: vRows } = await pool.query(`SELECT id FROM vendors WHERE code='BCS'`);
  let vendorId = vRows[0]?.id;
  if (!vendorId) {
    const ins = await pool.query(
      `INSERT INTO vendors (name, code, website, phone, address, public_code, is_active, hide_public_name, notes)
       VALUES ('Best Cheer Stone','BCS','https://bestcheerstone.com','(714) 399-1588',
               '3190 E. Miraloma Ave, Anaheim, CA 92806','825',true,true,
               'Onboarded from BCS Wholesale Price List 9/2/2026. Prefab costs = per-piece (crate tier not carried); slab costs = $/SF (bundle tier not carried). Also has San Diego + North Hollywood branches.')
       RETURNING id`);
    vendorId = ins.rows[0].id;
    console.log('Created vendor BCS', vendorId);
  }
  let { rows: bRows } = await pool.query(`SELECT id FROM brands WHERE lower(name)='best cheer stone'`);
  let brandId = bRows[0]?.id;
  if (!brandId) {
    const ins = await pool.query(
      `INSERT INTO brands (name, code, website, hide_public_name) VALUES ('Best Cheer Stone','BCS','https://bestcheerstone.com',true) RETURNING id`);
    brandId = ins.rows[0].id;
    console.log('Created brand Best Cheer Stone', brandId);
  }

  const catIds = {};
  for (const slug of new Set([...products.values()].map(p => p.category))) {
    const r = await pool.query(`SELECT id FROM categories WHERE slug=$1`, [slug]);
    if (!r.rows.length) throw new Error(`missing category ${slug}`);
    catIds[slug] = r.rows[0].id;
  }
  const attrIds = {};
  for (const slug of ['color', 'material', 'countertop_material', 'finish', 'thickness', 'size', 'brand']) {
    const r = await pool.query(`SELECT id FROM attributes WHERE slug=$1`, [slug]);
    if (r.rows.length) attrIds[slug] = r.rows[0].id;
  }

  const { rows: ex } = await pool.query(
    `SELECT s.vendor_sku FROM skus s JOIN products p ON p.id=s.product_id WHERE p.vendor_id=$1`, [vendorId]);
  const existing = new Set(ex.map(r => r.vendor_sku));

  let prodNew = 0, skuNew = 0, skuSkip = 0;
  for (const [, p] of products) {
    const newSkus = p.skus.filter(s => !existing.has(s.vendor_sku));
    skuSkip += p.skus.length - newSkus.length;
    if (!newSkus.length) continue;

    const descBits = [];
    if (p.flags.full_body) descBits.push('Full body print quartz.');
    if (p.flags.jumbo) descBits.push('Jumbo size (138" x 79") availability.');
    if (p.flags.size_varies) descBits.push('Sizes may vary — confirm with vendor.');
    const desc = descBits.join(' ') || null;

    let prodId;
    const found = await pool.query(
      `SELECT id FROM products WHERE vendor_id=$1 AND collection='' AND name=$2`, [vendorId, p.name]);
    if (found.rows.length) prodId = found.rows[0].id;
    else {
      let slug = slugify(p.name);
      const clash = await pool.query(`SELECT 1 FROM products WHERE slug=$1`, [slug]);
      if (clash.rows.length) slug = `${slug}-bcs`;
      const ins = await pool.query(
        `INSERT INTO products (vendor_id, brand_id, name, collection, category_id, status, slug, description_short)
         VALUES ($1,$2,$3,'',$4,'active',$5,$6) RETURNING id`,
        [vendorId, brandId, p.name, catIds[p.category], slug, desc]);
      prodId = ins.rows[0].id;
      prodNew++;
    }

    for (const s of newSkus) {
      const ins = await pool.query(
        `INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, status)
         VALUES ($1,$2,$3,$4,$5,'active') ON CONFLICT (internal_sku) DO NOTHING RETURNING id`,
        [prodId, s.vendor_sku, `BCS-${s.vendor_sku}`, s.variant_name, s.sell_by]);
      if (!ins.rows.length) { skuSkip++; continue; }
      const skuId = ins.rows[0].id;
      skuNew++;
      await upsertPricing(pool, skuId, { cost: s.cost, retail_price: s.cost * 2, price_basis: s.price_basis });
      if (s.packaging) {
        await pool.query(
          `INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box) VALUES ($1,$2,$3)
           ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box, pieces_per_box=EXCLUDED.pieces_per_box`,
          [skuId, s.packaging.sqft_per_box, s.packaging.pieces_per_box]);
      }
      // No 'brand' attr: BCS is a hidden (white-label) vendor — the
      // hide_public_name flag masks vendor/brand joins, but a raw brand
      // attribute value would leak the name into attr-driven UI.
      const attrs = {
        color: p.colorName || p.name,
        ...(p.material ? { material: p.material, countertop_material: p.material } : {}),
        ...s.attrs,
      };
      for (const [slug, val] of Object.entries(attrs)) {
        if (!attrIds[slug] || val == null || val === '') continue;
        await pool.query(
          `INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1,$2,$3)
           ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value=EXCLUDED.value`,
          [skuId, attrIds[slug], String(val).trim()]);
      }
    }
  }
  console.log(`\nProducts created: ${prodNew}; SKUs inserted: ${skuNew}; skipped existing: ${skuSkip}`);
  console.log('All SKUs imageless — bestcheerstone.com product-page image scrape is the follow-up (urls in bcs-raw.json).');
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
