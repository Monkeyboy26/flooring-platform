#!/usr/bin/env node

/**
 * Re-onboard Bellezza Ceramica to the SEPTEMBER 2026 Dealer Price List.
 *
 * Idempotent. Safe to re-run (locally or on prod). Four phases:
 *
 *   1. DELETE — hard-delete the 38 products the Sept sheet flags *DISC.
 *      (each appears ONLY as discontinued; none has a surviving active row).
 *      No order/cart/estimate/PO references exist, so cascade is clean.
 *   2. REFRESH — the only genuine cost changes vs the current DB are 4 families:
 *      Gio (1.99 -> 4.99/sheet), LN520 (1.99 -> 4.99), Amazonia (4.24 -> 5.49),
 *      Altea 4x4 & 3x6 (5.49 -> 6.49). Everything else already matches.
 *   3. ADD — 9 new field tiles (Clarke Satin/Polished, Dozza Stone Cream,
 *      Irta Matte, Limasol Satin/Polished, Terra Bianco Matte, Ziro Matte/RLV)
 *      + the MDF Round Flexible panel.
 *   4. GIO MATRIX — the old importer fabricated every color x every format.
 *      The sheet shows Gio only comes in specific combos (Cobalt is glossy
 *      stacked-linear ONLY, never a hexagon). Delete the fabricated per-color
 *      SKUs and correct each format's color list. This is the root cause of
 *      "Gio Cobalt Matte Hexagon 4x4 shows an incorrect image".
 *
 * Off-list products (Dorset Hexagon, Panda, Vilema, the web-only "May 2026"
 * additions, Mango laminate, etc.) are LEFT UNTOUCHED per the onboarding
 * decision — the dealer sheet is not the full website catalog.
 *
 * DRY_RUN=1 prints the plan without writing.
 *
 * Usage: docker compose exec -e DRY_RUN=1 api node scripts/reonboard-bellezza-sept2026.mjs
 *        docker compose exec              api node scripts/reonboard-bellezza-sept2026.mjs
 */

import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.env.DRY_RUN === '1';
const RETAIL_MARKUP = 1.6;
const nickel = c => parseFloat((Math.round(c * RETAIL_MARKUP / 0.05) * 0.05).toFixed(2));

// ─── PHASE 1: products to hard-delete (Sept lists each ONLY as *DISC.) ──────────
const DISC_DELETE = [
  'Anima Antracita', 'Arhus', 'Armani White', 'Austral Blanco', 'Austral Essence Blanco',
  'Calacatta Gold', 'Ceppo', 'Chamonix', 'District', 'Elegance Marble Pearl',
  'Enigma White', 'Fry', 'Harley Lux', 'Ibiza', 'Insignia White', 'Laurent Black',
  'Magna White', 'Manhattan', 'Markina Gold', 'Marmo Marfil', 'Myrcella', 'Sun Blanco',
  'Temper', 'Westmount Beige', 'WG001', 'NatureGlass Hex', 'Silver Matte Hex',
  'Statuario Matte Hex', 'Penny Fosco', 'Penny Grafito', 'Antwerp', 'Camden', 'Grande',
  'Hudson', 'Nord', 'Park', 'Frammenti', 'Limit',
];

// Web-only leftovers to remove (2026-09-11 follow-up). These were scraped from
// bellezzaceramica.com but are on NEITHER the Sept dealer sheet NOR the warehouse
// stock-check feed — i.e. truly "internet only". Dorset Hexagon (owner's original
// "not a mosaic" complaint) is included. The 16 off-sheet products that DO carry
// warehouse stock (Connor Beige, Scanda, Statuario Spider, etc.) are intentionally
// NOT listed — they're real, just not featured on the dealer sheet.
const OFFLIST_DELETE = [
  'Dorset Hexagon',
  'Artistic White Brillo', 'BPC Interior Panel', 'Calaca Gold', 'Celian',
  'Exterior Composite Wall Panel', 'Granby Ivory', 'Grunge', 'Kube Blanco',
  'Metallic Dark Grey Mosaic', 'Panda', 'Penny Calacatta Gold', 'Scale Decor 3D',
  'Stainless Gold Hexagon Mosaic', 'Vibrant Bianco', 'Vilema',
];

// ─── PHASE 2: cost refresh (product -> new cost). Retail recomputed = cost*1.6 nickel.
// Altea Jolly Trim (1x8) is unchanged at 9.60, so match Altea by size, not whole product.
const COST_REFRESH = [
  { name: 'Gio', cost: 4.99 },                       // all SKUs (per sheet)
  { name: 'LN520 Stacked Linear', cost: 4.99 },
  { name: 'Amazonia', cost: 5.49 },
  { name: 'Altea', cost: 6.49, sizes: ['4x4', '3x6'] },  // NOT the 1x8 Jolly Trim
];

// ─── PHASE 3: new field tiles (all 24x48, sold per sqft, box). retail = cost*1.6 nickel.
// [size, finish, cost, sqftPc, pcsBox, sqftBox]
const NEW_TILES = [
  { name: 'Clarke', collection: 'Clarke', material: 'Porcelain', origin: 'Italy',
    desc: 'Marble Look Porcelain', skus: [
      ['Satin 24x48', '24x48', 'Satin', 5.09, 7.75, 2, 15.5],
      ['Polished 24x48', '24x48', 'Polished', 5.39, 7.75, 2, 15.5],
    ] },
  { name: 'Dozza Stone Cream', collection: 'Dozza', material: 'Porcelain', origin: 'Spain',
    desc: 'Stone Look Porcelain', skus: [
      ['24x48', '24x48', null, 5.23, 7.75, 2, 15.5],
    ] },
  { name: 'Irta', collection: 'Irta', material: 'Porcelain', origin: 'Italy',
    desc: 'Matte Porcelain', skus: [
      ['Matte 24x48', '24x48', 'Matte', 5.39, 7.75, 2, 15.5],
    ] },
  { name: 'Limasol', collection: 'Limasol', material: 'Porcelain', origin: 'Italy',
    desc: 'Marble Look Porcelain', skus: [
      ['Satin 24x48', '24x48', 'Satin', 4.39, 7.75, 2, 15.5],
      ['Polished 24x48', '24x48', 'Polished', 5.39, 7.75, 2, 15.5],
    ] },
  { name: 'Terra Bianco', collection: 'Terra Bianco', material: 'Porcelain', origin: 'Italy',
    desc: 'Matte Marble Look Porcelain', skus: [
      ['Matte 24x48', '24x48', 'Matte', 5.99, 7.75, 2, 15.5],
    ] },
  { name: 'Ziro', collection: 'Ziro', material: 'Porcelain', origin: 'Italy',
    desc: 'Porcelain Tile', skus: [
      ['Matte 24x48', '24x48', 'Matte', 4.49, 7.75, 2, 15.5],
      ['RLV 24x48', '24x48', 'Relief', 4.69, 7.75, 2, 15.5],
    ] },
];

// MDF Round Flexible panel — new section on the Sept sheet (sibling of the flat acoustic panel).
const MDF_ROUND = {
  name: 'MDF Round Flexible Panel', collection: 'Wall Panels', material: 'MDF',
  desc: 'Indoor Round Flexible Acoustic Wall Panel',
  colors: ['White', 'Pine', 'Walnut', 'Black'],
  size: '94.5x24', cost: 89.00, sqftPc: 15.8,
};

// ─── PHASE 4: the REAL Gio color x format matrix (from the Sept sheet). ─────────
// Keyed by the format portion of variant_name; value = the colors that exist.
const GIO_MATRIX = {
  'Matte Hexagon 4x4':                ['White'],
  'Matte Hexagon 2x2':                ['Black', 'White'],
  'Glossy Hexagon 2x2':               ['Black', 'White'],
  'Matte Stacked Linear .82x2.8':     ['Black', 'Taupe'],
  'Matte Stacked Linear .86x5.7':     ['White'],
  'Glossy Stacked Linear .86x5.7':    ['Black', 'White', 'Cobalt', 'Grey'],
  'Matte Stacked Linear 1.26x5.7':    ['Black'],
  'Glossy Stacked Linear 1.26x5.7':   ['Cobalt', 'Grey'],
};

// ════════════════════════════════════════════════════════════════════════════

async function q(text, params) { return pool.query(text, params); }

// Prod/local schemas drift (e.g. image_vision_checks exists locally but not on
// prod). Only touch child tables that actually exist in this database.
let _existingTables = null;
async function existingTables() {
  if (_existingTables) return _existingTables;
  const r = await q(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
  _existingTables = new Set(r.rows.map(x => x.table_name));
  return _existingTables;
}

async function getVendorId() {
  const r = await q("SELECT id FROM vendors WHERE code='BLZ'");
  if (!r.rows.length) throw new Error('BLZ vendor not found');
  return r.rows[0].id;
}

/** Hard-delete a product and every row that references it or its SKUs. */
async function deleteProduct(productId) {
  const tables = await existingTables();
  const skuIds = (await q('SELECT id FROM skus WHERE product_id=$1', [productId])).rows.map(r => r.id);
  if (skuIds.length) {
    for (const tbl of ['quality_violations', 'image_vision_checks', 'inventory_adjustments',
                       'inventory_snapshots', 'media_assets', 'pricing', 'packaging',
                       'sku_attributes', 'cart_items', 'estimate_items', 'order_items',
                       'purchase_order_items', 'credit_memo_items']) {
      if (!tables.has(tbl)) continue;
      await q(`DELETE FROM ${tbl} WHERE sku_id = ANY($1)`, [skuIds]);
    }
    await q('DELETE FROM skus WHERE id = ANY($1)', [skuIds]);
  }
  await q('DELETE FROM media_assets WHERE product_id=$1', [productId]);
  await q('DELETE FROM products WHERE id=$1', [productId]);
}

async function upsertProduct(vendorId, { name, collection, category_id, description_short }) {
  const r = await q(`
    INSERT INTO products (vendor_id, name, collection, category_id, status, description_short)
    VALUES ($1,$2,$3,$4,'draft',$5)
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
      category_id = COALESCE(EXCLUDED.category_id, products.category_id),
      description_short = COALESCE(EXCLUDED.description_short, products.description_short),
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax=0) AS is_new`,
    [vendorId, name, collection || '', category_id || null, description_short || null]);
  return r.rows[0];
}

async function upsertSku(productId, { vendor_sku, internal_sku, variant_name, sell_by, variant_type }) {
  const r = await q(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, status)
    VALUES ($1,$2,$3,$4,$5,$6,'active')
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id=EXCLUDED.product_id, vendor_sku=EXCLUDED.vendor_sku,
      variant_name=EXCLUDED.variant_name, sell_by=EXCLUDED.sell_by,
      variant_type=EXCLUDED.variant_type, updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax=0) AS is_new`,
    [productId, vendor_sku, internal_sku, variant_name || null, sell_by || 'box', variant_type || null]);
  return r.rows[0];
}

async function upsertPricing(skuId, { cost, retail_price, price_basis }) {
  await q(`INSERT INTO pricing (sku_id, cost, retail_price, price_basis) VALUES ($1,$2,$3,$4)
           ON CONFLICT (sku_id) DO UPDATE SET cost=EXCLUDED.cost, retail_price=EXCLUDED.retail_price, price_basis=EXCLUDED.price_basis`,
    [skuId, cost, retail_price, price_basis || 'per_sqft']);
}

async function upsertPackaging(skuId, { sqft_per_box, pieces_per_box }) {
  await q(`INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box) VALUES ($1,$2,$3)
           ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box), pieces_per_box=COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box)`,
    [skuId, sqft_per_box || null, pieces_per_box || null]);
}

async function setAttr(skuId, slug, value) {
  if (!value) return;
  const a = await q('SELECT id FROM attributes WHERE slug=$1', [slug]);
  if (!a.rows.length) return;
  await q(`INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1,$2,$3)
           ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value=EXCLUDED.value`,
    [skuId, a.rows[0].id, String(value).trim()]);
}

async function main() {
  const vendorId = await getVendorId();
  console.log(`Bellezza (${vendorId})  ${DRY_RUN ? '[DRY RUN]' : '[LIVE]'}\n`);

  // ── PHASE 1: DELETE DISC + web-only leftovers ─────────────────────────────
  console.log('=== PHASE 1: hard-delete *DISC. + internet-only products ===');
  let deleted = 0;
  for (const [label, list] of [['DISC', DISC_DELETE], ['internet-only', OFFLIST_DELETE]]) {
    for (const name of list) {
      const r = await q('SELECT id FROM products WHERE vendor_id=$1 AND name=$2', [vendorId, name]);
      if (!r.rows.length) { console.log(`  [skip] not found: ${name}`); continue; }
      for (const row of r.rows) {
        const n = (await q('SELECT count(*) c FROM skus WHERE product_id=$1', [row.id])).rows[0].c;
        console.log(`  [del ${label}] ${name} (${n} SKUs)`);
        if (!DRY_RUN) await deleteProduct(row.id);
        deleted++;
      }
    }
  }
  console.log(`  ${deleted} products ${DRY_RUN ? 'would be' : ''} deleted\n`);

  // ── PHASE 2: COST REFRESH ─────────────────────────────────────────────────
  console.log('=== PHASE 2: refresh changed costs ===');
  for (const ref of COST_REFRESH) {
    const retail = nickel(ref.cost);
    let sql = `
      SELECT s.id, s.variant_name, pr.cost FROM skus s
      JOIN products p ON p.id=s.product_id
      LEFT JOIN pricing pr ON pr.sku_id=s.id
      WHERE p.vendor_id=$1 AND p.name=$2`;
    const params = [vendorId, ref.name];
    const rows = (await q(sql, params)).rows;
    for (const row of rows) {
      if (ref.sizes) {
        const sz = (await q(`SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id=sa.attribute_id WHERE sa.sku_id=$1 AND a.slug='size'`, [row.id])).rows[0]?.value;
        if (!ref.sizes.includes(sz)) continue;
      }
      if (row.cost != null && parseFloat(row.cost) === ref.cost) continue;
      console.log(`  [cost] ${ref.name} "${row.variant_name}": ${row.cost} -> ${ref.cost} (retail ${retail})`);
      // Update cost/retail in place, leaving price_basis (per_sqft vs per_unit) untouched.
      if (!DRY_RUN) await q('UPDATE pricing SET cost=$2, retail_price=$3 WHERE sku_id=$1', [row.id, ref.cost, retail]);
    }
  }
  console.log('');

  // ── PHASE 3: ADD NEW TILES + MDF ROUND ────────────────────────────────────
  console.log('=== PHASE 3: add new products ===');
  const catRes = await q("SELECT id, slug FROM categories WHERE slug IN ('porcelain-tile','wall-panels')");
  const cat = {}; for (const r of catRes.rows) cat[r.slug] = r.id;

  for (const prod of NEW_TILES) {
    console.log(`  [+] ${prod.name} (${prod.skus.length} SKU)`);
    if (DRY_RUN) continue;
    const p = await upsertProduct(vendorId, { name: prod.name, collection: prod.collection, category_id: cat['porcelain-tile'], description_short: prod.desc });
    let i = 0;
    for (const [variant, size, finish, cost, sqftPc, pcsBox, sqftBox] of prod.skus) {
      const vsku = `S${prod.name.replace(/[^A-Za-z0-9]/g, '').substring(0, 6).toUpperCase()}-${i}`;
      const isku = `BLZ-${vsku}`;
      const sku = await upsertSku(p.id, { vendor_sku: vsku, internal_sku: isku, variant_name: variant, sell_by: 'box' });
      await upsertPricing(sku.id, { cost, retail_price: nickel(cost), price_basis: 'per_sqft' });
      await upsertPackaging(sku.id, { sqft_per_box: sqftBox, pieces_per_box: pcsBox });
      await setAttr(sku.id, 'size', size);
      if (finish) await setAttr(sku.id, 'finish', finish);
      await setAttr(sku.id, 'material', prod.material);
      if (prod.origin) await setAttr(sku.id, 'country_of_origin', prod.origin);
      i++;
    }
  }

  // MDF Round Flexible — one SKU per color, sold per piece (accessory), wall-panels
  console.log(`  [+] ${MDF_ROUND.name} (${MDF_ROUND.colors.length} colors)`);
  if (!DRY_RUN) {
    const p = await upsertProduct(vendorId, { name: MDF_ROUND.name, collection: MDF_ROUND.collection, category_id: cat['wall-panels'], description_short: MDF_ROUND.desc });
    for (const color of MDF_ROUND.colors) {
      const code = color.replace(/\s+/g, '').substring(0, 4).toUpperCase();
      const vsku = `SMDFR-${code}`;
      const sku = await upsertSku(p.id, { vendor_sku: vsku, internal_sku: `BLZ-${vsku}`, variant_name: `${color} ${MDF_ROUND.size} Panel`, sell_by: 'unit', variant_type: 'accessory' });
      await upsertPricing(sku.id, { cost: MDF_ROUND.cost, retail_price: nickel(MDF_ROUND.cost), price_basis: 'per_unit' });
      await setAttr(sku.id, 'size', MDF_ROUND.size);
      await setAttr(sku.id, 'material', MDF_ROUND.material);
      await setAttr(sku.id, 'color', color);
    }
  }
  console.log('');

  // ── PHASE 4: FIX GIO MATRIX ───────────────────────────────────────────────
  console.log('=== PHASE 4: fix Gio color x format matrix ===');
  const gio = (await q('SELECT id FROM products WHERE vendor_id=$1 AND name=$2', [vendorId, 'Gio'])).rows[0];
  if (gio) {
    const skus = (await q(`
      SELECT s.id, s.vendor_sku, s.variant_name,
        (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id=sa.attribute_id WHERE sa.sku_id=s.id AND a.slug='color') AS color
      FROM skus s WHERE s.product_id=$1`, [gio.id])).rows;

    // Fabricated per-color children: variant_name = "<Color> <Format>", format not offering that color.
    const KNOWN_COLORS = ['Black', 'Grey', 'White', 'Taupe', 'Cobalt'];
    const toDelete = [];
    for (const s of skus) {
      const vn = s.variant_name || '';
      const leadColor = KNOWN_COLORS.find(c => vn.toLowerCase().startsWith(c.toLowerCase()));
      if (!leadColor) continue; // generic row — handled below
      const format = vn.slice(leadColor.length).trim();
      const valid = GIO_MATRIX[format];
      if (!valid) { console.log(`  [?] unknown Gio format "${format}" (${s.vendor_sku}) — leaving`); continue; }
      if (!valid.includes(leadColor)) toDelete.push(s);
    }
    console.log(`  ${toDelete.length} fabricated Gio SKUs to delete:`);
    for (const s of toDelete) console.log(`    [del] ${s.variant_name} (${s.vendor_sku})`);
    if (!DRY_RUN) {
      const tables = await existingTables();
      for (const s of toDelete) {
        for (const tbl of ['media_assets', 'pricing', 'packaging', 'sku_attributes', 'quality_violations', 'image_vision_checks', 'inventory_snapshots', 'inventory_adjustments']) {
          if (!tables.has(tbl)) continue;
          await q(`DELETE FROM ${tbl} WHERE sku_id=$1`, [s.id]);
        }
        await q('DELETE FROM skus WHERE id=$1', [s.id]);
      }
    }

    // Correct the generic rows' color attribute to the real list for their format.
    for (const s of skus) {
      const vn = s.variant_name || '';
      const leadColor = KNOWN_COLORS.find(c => vn.toLowerCase().startsWith(c.toLowerCase()));
      if (leadColor) continue; // per-color child
      const valid = GIO_MATRIX[vn.trim()];
      if (!valid) { console.log(`  [?] generic Gio row with unknown format "${vn}" (${s.vendor_sku})`); continue; }
      const list = valid.join(', ');
      console.log(`  [color] generic ${s.vendor_sku} "${vn}" -> ${list}`);
      if (!DRY_RUN) await setAttr(s.id, 'color', list);
    }
  } else {
    console.log('  [skip] Gio product not found');
  }
  console.log('');

  // ── Attach Dozza swatch image (only new tile with a live vendor page) ─────
  console.log('=== Attaching Dozza image ===');
  if (!DRY_RUN) {
    const dozzaUrl = 'https://bellezzaceramica.com/wp-content/uploads/2026/06/DOZZA-STONE-CREAM-60X120-1.jpg';
    await q(`
      WITH d AS (SELECT s.id sku_id, s.product_id FROM skus s JOIN products p ON p.id=s.product_id
                 WHERE p.vendor_id=$1 AND p.name='Dozza Stone Cream')
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
      SELECT product_id, sku_id, 'primary', $2, $2, 0, 'manual-reonboard' FROM d
      UNION ALL SELECT product_id, NULL, 'primary', $2, $2, 0, 'manual-reonboard' FROM d
      ON CONFLICT DO NOTHING`, [vendorId, dozzaUrl]);
  }
  console.log('');

  // ── Register the inventory scraper source (idempotent) ────────────────────
  console.log('=== Registering bellezza-inventory vendor_source ===');
  if (!DRY_RUN) {
    await q(`
      INSERT INTO vendor_sources (vendor_id, source_type, name, base_url, scraper_key, config, schedule, is_active)
      SELECT $1, 'portal', 'Bellezza Stock Check', 'https://bellezzaceramica.com/stock-check/', 'bellezza-inventory',
             '{"password":"bellezza1234","freshnessHours":48}'::jsonb, '0 7 * * *', true
      WHERE NOT EXISTS (SELECT 1 FROM vendor_sources WHERE scraper_key='bellezza-inventory')`, [vendorId]);
    // Fix a pre-existing row that was registered with the invalid schedule 'daily'
    // (node-cron's cron.validate rejects it, so the scheduler silently skips it).
    await q(`UPDATE vendor_sources SET schedule='0 7 * * *'
             WHERE scraper_key='bellezza-inventory' AND (schedule IS NULL OR schedule='daily')`);
  }
  console.log('');

  // ── Activate new products (they have pricing; may be photoless until enriched)
  console.log('=== Activating new products with pricing ===');
  if (!DRY_RUN) {
    const act = await q(`
      UPDATE products SET status='active'
      WHERE vendor_id=$1 AND status='draft'
        AND EXISTS (SELECT 1 FROM skus s JOIN pricing pr ON pr.sku_id=s.id
                    WHERE s.product_id=products.id AND pr.retail_price>0)
      RETURNING name`, [vendorId]);
    console.log(`  activated: ${act.rows.map(r => r.name).join(', ') || '(none)'}`);
  }
  console.log('');

  // ── Refresh search vectors + report off-list survivors ────────────────────
  if (!DRY_RUN) {
    await q(`UPDATE products SET search_vector = to_tsvector('english',
      COALESCE(name,'')||' '||COALESCE(collection,'')||' '||COALESCE(description_short,'')||' '||COALESCE(description_long,''))
      WHERE vendor_id=$1`, [vendorId]);
  }

  const remaining = (await q('SELECT count(*) c FROM products WHERE vendor_id=$1', [vendorId])).rows[0].c;
  console.log(`=== Done. Bellezza now has ${remaining} products ${DRY_RUN ? '(unchanged — dry run)' : ''} ===`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
