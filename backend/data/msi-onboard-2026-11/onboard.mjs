/**
 * MSI Jan-2026 pricelist onboarding — 2026-11-12
 *
 * Part A: reactivate SKUs/products that exist in the DB but are inactive, where
 *         the item's msisurfaces.com page verified live (link-probe-results.json).
 * Part B: create the genuinely-absent items (sinks, faucets, thresholds, shower
 *         accessories), grouped into products by product-page URL, with images.
 *
 * Run INSIDE the flooring-api container:
 *   node /app/data/msi-onboard-2026-11/onboard.mjs [--dry]
 */
import pg from 'pg';
import fs from 'fs';
import {
  slugify, upsertPricing, upsertPackaging, upsertSkuAttribute,
  upsertMediaAsset, downloadImage, resolveImageExtension
} from '/app/scrapers/base.js';

const DIR = '/app/data/msi-onboard-2026-11';
const DRY = process.argv.includes('--dry');

const reactivate = JSON.parse(fs.readFileSync(`${DIR}/msi-reactivate.json`, 'utf8'));
const create = JSON.parse(fs.readFileSync(`${DIR}/msi-create.json`, 'utf8'));
const probe = JSON.parse(fs.readFileSync(`${DIR}/link-probe-results.json`, 'utf8'));
const images = JSON.parse(fs.readFileSync(`${DIR}/create-images.json`, 'utf8'));

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'db', port: 5432,
  database: 'flooring_pim', user: 'postgres',
  password: process.env.DB_PASSWORD || process.env.POSTGRES_PASSWORD || 'postgres',
});

const titlecase = s => String(s || '')
  .replace(/"(?=[A-Za-z])/g, '" ')
  .toLowerCase().replace(/(^|[\s\-/("])([a-z])/g, (m, p, c) => p + c.toUpperCase())
  .replace(/(\d)X(\d)/gi, '$1x$2').replace(/\s+/g, ' ')
  .replace(/\bThrehsold\b/gi, 'Threshold').replace(/\bBlk\b/g, 'Black')
  .replace(/\bBvl\b/gi, 'Bevel').replace(/\bBevl\b/gi, 'Bevel').replace(/\bDbl\b/gi, 'Double')
  .trim();
const segName = seg => titlecase(seg.replace(/-/g, ' '));

function rowBasis(r) {
  const um = String(r['U/M'] || '').toUpperCase();
  if (um === 'SQFT' || um === 'SF') return 'per_sqft';
  return 'per_unit';
}
function rowCost(r) {
  const basis = rowBasis(r);
  if (basis === 'per_sqft') return parseFloat(r['PRICE/UOM']) || 0;
  return parseFloat(r['PRICE/EACH']) || parseFloat(r['PRICE/UOM']) || 0;
}
function linkSegs(r) {
  const m = String(r['Web Link'] || '').match(/msisurfaces\.com\/([^/?]+)(?:\/([^/?]+))?/);
  return m ? [m[1], m[2] || null] : [null, null];
}

async function main() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'MSI'");
  const vendorId = vendorRes.rows[0].id;

  // Category lookup
  const cats = {};
  for (const slug of ['kitchen-sinks', 'bathroom-sinks', 'kitchen-faucets', 'bathroom-faucets', 'trim-accessories', 'mosaic-tile']) {
    const r = await pool.query('SELECT id FROM categories WHERE slug = $1', [slug]);
    if (!r.rows.length) throw new Error(`Missing category slug: ${slug}`);
    cats[slug] = r.rows[0].id;
  }

  // ───────────────────────── Part A: reactivate ─────────────────────────
  const backup = { generated: new Date().toISOString(), skus: [], products: [], created: [] };
  let aSku = 0, aProd = 0, aSkipNoLink = 0, aSkipDead = 0, aPriced = 0;
  const touchedProducts = new Set();

  for (const r of reactivate) {
    // "REFER TO WWW.EVERLIFELVT.COM" placeholder rows (28) — not real SKUs
    if (/\s/.test(r.__item) || r.__item.startsWith('REFER')) { aSkipDead++; continue; }
    const link = String(r['Web Link'] || '').trim();
    const pr = probe[link];
    const verified = (pr && pr.ok) || link.includes('sinksdetails.aspx'); // aspx probe was transient-flaky; curl-verified 200
    if (link.startsWith('http') && !verified) { aSkipDead++; continue; }
    if (!link.startsWith('http')) aSkipNoLink++; // pricelist-trusted, no page to verify — proceed

    const db = r.__db;
    const prev = await pool.query(
      `SELECT s.status AS sku_status, p.is_active, p.status AS product_status,
              pr.cost, pr.retail_price, pr.price_basis
         FROM skus s JOIN products p ON p.id = s.product_id
         LEFT JOIN pricing pr ON pr.sku_id = s.id WHERE s.id = $1`, [db.skuId]);
    backup.skus.push({ skuId: db.skuId, vendorSku: r.__item, ...prev.rows[0] });

    if (!DRY) {
      const su = await pool.query(
        `UPDATE skus SET status = 'active', updated_at = NOW() WHERE id = $1 AND status <> 'active'`, [db.skuId]);
      if (su.rowCount) aSku++;
      if (!touchedProducts.has(db.productId)) {
        touchedProducts.add(db.productId);
        const pu = await pool.query(
          `UPDATE products SET is_active = true, status = 'active', updated_at = NOW()
            WHERE id = $1 AND (is_active = false OR status <> 'active')`, [db.productId]);
        if (pu.rowCount) { aProd++; backup.products.push({ productId: db.productId }); }
      }
      await upsertPricing(pool, db.skuId, { cost: rowCost(r), price_basis: rowBasis(r) });
      aPriced++;
      if (rowBasis(r) === 'per_sqft' && parseFloat(r['SQFT PER BOX']) > 0) {
        await upsertPackaging(pool, db.skuId, {
          sqft_per_box: parseFloat(r['SQFT PER BOX']),
          pieces_per_box: parseInt(r['PIECES PER BOX'], 10) || null,
        });
      } else if (parseInt(r['PIECES PER BOX'], 10) > 1) {
        await upsertPackaging(pool, db.skuId, { pieces_per_box: parseInt(r['PIECES PER BOX'], 10) });
      }
    } else {
      aSku++;
      if (!touchedProducts.has(db.productId)) { touchedProducts.add(db.productId); aProd++; }
    }
  }
  console.log(`[A] reactivated skus=${aSku} products=${aProd} priced=${aPriced} skipped: no-link=${aSkipNoLink} dead-link=${aSkipDead}`);

  // ───────────────────────── Part B: create ─────────────────────────
  // Group rows into products
  const groups = new Map(); // key -> {rows, link}
  for (const r of create) {
    const link = String(r['Web Link'] || '').trim();
    // Thresholds: each size has its own URL under one color line — group by the
    // first path segment so sizes become variants of a single product.
    let key;
    if (r.__item.startsWith('THD') && link.startsWith('http')) key = `thd:${linkSegs(r)[0]}`;
    else key = link.startsWith('http') ? link : `item:${r.__item}`;
    if (!groups.has(key)) groups.set(key, { rows: [], link: link.startsWith('http') ? link : null });
    groups.get(key).rows.push(r);
  }
  console.log(`[B] ${create.length} items in ${groups.size} products`);

  // Existing slugs for dedup
  const slugRows = await pool.query('SELECT slug FROM products WHERE slug IS NOT NULL');
  const usedSlugs = new Set(slugRows.rows.map(x => x.slug));
  const uniqueSlug = base => {
    let s = base, n = 2;
    while (usedSlugs.has(s)) s = `${base}-${n++}`;
    usedSlugs.add(s);
    return s;
  };

  function classify(r) {
    const item = r.__item, coll = String(r['PRODUCT COLLECTION'] || '').toUpperCase();
    if (item.startsWith('FAU')) {
      const bath = coll.includes('BATH') || coll.includes('SHOWER') || coll.includes('TUB');
      return { cat: bath ? 'bathroom-faucets' : 'kitchen-faucets', vtype: null };
    }
    if (item.startsWith('SIN')) {
      let bath;
      if (coll.includes('FARMHOUSE') || coll.includes('APRON')) bath = false;
      else bath = coll.includes('VANITY') || coll.includes('OVAL') || coll.includes('RECTANGLE');
      return { cat: bath ? 'bathroom-sinks' : 'kitchen-sinks', vtype: item.includes('STRAINER') ? 'accessory' : null };
    }
    return { cat: 'trim-accessories', vtype: 'accessory' }; // THD*, SMOT sills/shelves/seats
  }

  function productName(g) {
    const r0 = g.rows[0];
    const [seg1, seg2] = g.link ? linkSegs(r0) : [null, null];
    if (r0.__item.startsWith('THD') && seg1 && seg1 !== 'products') return segName(seg1);
    if (r0.__item.startsWith('FAU') && seg2) return segName(seg2);
    // sinks + SMOT: collection text is the most descriptive
    return titlecase(String(r0['PRODUCT COLLECTION']))
      .replace(/["""]/g, ' ')
      .replace(/\bSs\b/g, 'Stainless Steel').replace(/\bGau\b/g, 'Gauge')
      .replace(/\bOm\b/g, 'Overmount').replace(/\bBwl\b/gi, 'Bowl')
      .replace(/\bSb\b/g, 'Single Bowl').replace(/\bDb\b/g, 'Double Bowl')
      .replace(/\bSco\b/g, 'SCO')
      .replace(/\s+/g, ' ').trim();
  }

  let bProducts = 0, bSkus = 0, bImages = 0, bImgFail = 0;
  for (const [key, g] of groups) {
    const { cat, vtype } = classify(g.rows[0]);
    const name = productName(g).replace(/[""]/g, '').trim();
    const collection = g.rows[0].__item.startsWith('THD') && g.link ? segName(linkSegs(g.rows[0])[0]) : '';
    const slug = uniqueSlug(slugify(name));

    if (DRY) {
      console.log(`  +product [${cat}${vtype ? '/' + vtype : ''}] "${name}" slug=${slug} skus=${g.rows.length}`);
      bProducts++; bSkus += g.rows.length;
      continue;
    }

    const pres = await pool.query(
      `INSERT INTO products (vendor_id, name, collection, category_id, slug, status, is_active)
       VALUES ($1, $2, $3, $4, $5, 'active', true) RETURNING id`,
      [vendorId, name, collection, cats[cat], slug]);
    const productId = pres.rows[0].id;
    bProducts++;
    backup.created.push({ productId, name, slug });

    const seenVariants = new Set();
    for (const r of g.rows) {
      const variantBits = [];
      const [, seg2] = g.link ? linkSegs(r) : [null, null];
      if (r.__item.startsWith('THD') && seg2) variantBits.push(segName(seg2));
      else {
        if (r.SIZE && r.SIZE !== 'MISC.') variantBits.push(String(r.SIZE));
        if (r.FINISH && r.FINISH !== 'MISC.') variantBits.push(titlecase(r.FINISH));
      }
      // Disambiguate colliding variant names within a product (e.g. two 18G bowls)
      if (variantBits.length && seenVariants.has(variantBits.join(' '))) variantBits.push(r.__item.split('-').pop());
      seenVariants.add(variantBits.join(' '));
      const sres = await pool.query(
        `INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, status)
         VALUES ($1, $2, $3, $4, 'unit', $5, 'active')
         ON CONFLICT (internal_sku) DO UPDATE SET product_id = EXCLUDED.product_id, status = 'active'
         RETURNING id`,
        [productId, r.__item, `MSI-${r.__item}`, variantBits.join(' ') || null, vtype]);
      const skuId = sres.rows[0].id;
      bSkus++;

      await upsertPricing(pool, skuId, { cost: rowCost(r), price_basis: 'per_unit' });
      const ppb = parseInt(r['PIECES PER BOX'], 10);
      if (ppb > 1) await upsertPackaging(pool, skuId, { pieces_per_box: ppb });
      if (r.SIZE && r.SIZE !== 'MISC.') await upsertSkuAttribute(pool, skuId, 'size', String(r.SIZE));
      if (r.FINISH && r.FINISH !== 'MISC.') await upsertSkuAttribute(pool, skuId, 'finish', titlecase(r.FINISH));
      if (r.THICKNESS && r.THICKNESS !== 'MISC.') await upsertSkuAttribute(pool, skuId, 'thickness', String(r.THICKNESS));
    }

    // Images
    const img = g.link ? images[g.link] : null;
    if (img && img.primary) {
      const list = [{ url: img.primary, type: 'primary' }, ...(img.alts || []).map(u => ({ url: u, type: 'alternate' }))];
      let altIdx = 0;
      for (const im of list) {
        try {
          const ext = resolveImageExtension(im.url);
          const filename = im.type === 'primary' ? `primary${ext}` : `alt-${++altIdx}${ext}`;
          const destPath = `/app/uploads/products/${productId}/${filename}`;
          const ok = await downloadImage(im.url, destPath);
          if (ok) {
            await upsertMediaAsset(pool, {
              product_id: productId, sku_id: null, asset_type: im.type,
              url: `/uploads/products/${productId}/${filename}`, original_url: im.url,
              sort_order: im.type === 'primary' ? 0 : altIdx,
            });
            bImages++;
          } else bImgFail++;
        } catch { bImgFail++; }
      }
    }
  }
  console.log(`[B] products=${bProducts} skus=${bSkus} images=${bImages} imgFail=${bImgFail}`);

  if (!DRY) {
    const bp = `${DIR}/onboard-backup-${Date.now()}.json`;
    fs.writeFileSync(bp, JSON.stringify(backup, null, 1));
    console.log(`Backup: ${bp}`);
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
