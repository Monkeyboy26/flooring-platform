// Onboard the Versace Ceramics "Maximvs" porcelain slabs (by Gardenia Orchidea)
// sold by Mélange Boutique Tile (vendor MLG) as a new collection.
//
// Source: https://www.melangetile.com/maximvs-12mm-versace-slab (dealer-only,
// no public price) cross-checked against the maker's catalogue at
// versace-ceramics.com. These are large-format 163.5×323.5 cm slabs — the 12mm
// field marbles plus the 6mm Maximvs-6 decor/trim pieces.
//
// Pricing: CALL FOR PRICE — no pricing rows are written, so the storefront PDP
// renders "Call for Price" (retailPrice not > 0). Admin/rep can add real numbers
// later without any code change.
//
// Idempotent: re-running upserts products/skus by their unique keys and re-syncs
// media. Images are hotlinked to Melange (same as the rest of MLG's catalog) and
// then self-hosted by the mirror pass (run mirror-images-backfill or the inline
// mirror at the end).
//
//   node backend/scripts/import-versace-maximvs.mjs --dry-run
//   node backend/scripts/import-versace-maximvs.mjs [--no-mirror]

import { pool } from '../db.js';
import { mirrorMediaRow } from '../lib/imageMirror.js';

const DRY_RUN = process.argv.includes('--dry-run');
const NO_MIRROR = process.argv.includes('--no-mirror');

const VENDOR_CODE = 'MLG';
const COLLECTION = 'Versace Maximvs';
const CATEGORY_SLUG = 'porcelain-slabs';
const SLAB_SIZE = '163.5×323.5 cm';

// Melange hosts images under paths that contain literal spaces; encode them so
// fetch()/the mirror can resolve them. Keep already-encoded %20 intact.
const enc = (u) => u.replace(/ /g, '%20');

// look: 'Marble' for the field slabs, 'Decorative' for the Manifesto/Megabarocco/
// Greca/Lux decor + trim pieces. thickness: 12mm field, 6mm decor.
// primary = product shot; alt = extra product shots; life = room scenes.
const PRODUCTS = [
  // ---- 12mm Maximvs field slabs (marble looks) ----
  { code: '4248', name: 'Black & Gold', look: 'Marble', thickness: '12 mm', size: SLAB_SIZE,
    primary: 'https://www.melangetile.com/assets/images/versace/product shots/versace-black-and-gold-ps1.jpg',
    life: ['https://www.melangetile.com/assets/images/versace/roomscenes/versace-black-and-gold-rs1.jpg',
           'https://www.melangetile.com/assets/images/versace/roomscenes/versace-black-and-gold-rs2.jpg',
           'https://www.melangetile.com/assets/images/versace/roomscenes/50-248-gardeniamaximusversaceristorantev1.jpg'] },
  { code: '4249', name: 'Calacatta Bright', look: 'Marble', thickness: '12 mm', size: SLAB_SIZE,
    primary: 'https://www.melangetile.com/assets/images/versace/product shots/calacatta-bright_a-ps1.jpg',
    alt: ['https://www.melangetile.com/assets/images/versace/product shots/calacatta-bright_b-ps1.jpg'],
    life: ['https://www.melangetile.com/assets/images/versace/roomscenes/calacatta-bright-rs1.jpg',
           'https://www.melangetile.com/assets/images/versace/roomscenes/calacatta-bright-rs2.jpg'] },
  { code: '4250', name: 'Calacatta Bright Megabarocco', look: 'Marble', thickness: '12 mm', size: SLAB_SIZE,
    primary: 'https://www.melangetile.com/assets/images/versace/product shots/calacatta-bright-megabarocco_a-ps1.jpg',
    alt: ['https://www.melangetile.com/assets/images/versace/product shots/calacatta-bright-megabarocco_b-ps1.jpg',
          'https://www.melangetile.com/assets/images/versace/product shots/calacatta-bright-megabaroccors1.jpg'] },
  { code: '4251', name: 'Calacatta Green', look: 'Marble', thickness: '12 mm', size: SLAB_SIZE,
    primary: 'https://www.melangetile.com/assets/images/versace/product shots/calacatta-green-ps1.jpg',
    life: ['https://www.melangetile.com/assets/images/versace/roomscenes/calacatta-green-rs1.jpg',
           'https://www.melangetile.com/assets/images/versace/roomscenes/calacatta-green-rs2.jpg'] },
  { code: '4252', name: 'Galaxy Blue', look: 'Marble', thickness: '12 mm', size: SLAB_SIZE,
    primary: 'https://www.melangetile.com/assets/images/versace/product shots/galaxy-blue-a-lux-ps1.jpg',
    life: ['https://www.melangetile.com/assets/images/versace/roomscenes/galaxy-blue-rs1.jpg',
           'https://www.melangetile.com/assets/images/versace/roomscenes/galaxy-blue-rs2.jpg'] },
  { code: '4253', name: 'Galaxy Brown', look: 'Marble', thickness: '12 mm', size: SLAB_SIZE,
    primary: 'https://www.melangetile.com/assets/images/versace/product shots/galaxy-brown-a-lux-ps1.jpg',
    life: ['https://www.melangetile.com/assets/images/versace/roomscenes/galaxy-brown-a-lux-rs1.jpg',
           'https://www.melangetile.com/assets/images/versace/roomscenes/galaxy-brown-a-lux-rs2.jpg'] },
  { code: '4254', name: 'Panda White', look: 'Marble', thickness: '12 mm', size: SLAB_SIZE,
    primary: 'https://www.melangetile.com/assets/images/versace/product shots/panda-white-a-lux-ps1.jpg',
    alt: ['https://www.melangetile.com/assets/images/versace/product shots/panda-white-b-lux-ps1.jpg'],
    life: ['https://www.melangetile.com/assets/images/versace/roomscenes/panda-white-rs1.jpg',
           'https://www.melangetile.com/assets/images/versace/roomscenes/panda-white-rs2.jpg'] },
  { code: '4255', name: 'Rosa Venezia', look: 'Marble', thickness: '12 mm', size: SLAB_SIZE,
    primary: 'https://www.melangetile.com/assets/images/versace/product shots/rosa-venezia-a-lux-ps1.jpg',
    alt: ['https://www.melangetile.com/assets/images/versace/product shots/rosa-venezia-b-lux-ps1.jpg'],
    life: ['https://www.melangetile.com/assets/images/versace/roomscenes/rosa-venezia-rs1.jpg'] },
  { code: '4256', name: 'Statuario White', look: 'Marble', thickness: '12 mm', size: SLAB_SIZE,
    primary: 'https://www.melangetile.com/assets/images/versace/product shots/statuario-white-a-ps1.jpg',
    alt: ['https://www.melangetile.com/assets/images/versace/product shots/statuario-white-b-ps1.jpg'],
    life: ['https://www.melangetile.com/assets/images/versace/roomscenes/statuario-white-rs1.jpg',
           'https://www.melangetile.com/assets/images/versace/roomscenes/statuario-white-rs2.jpg'] },
  { code: '4257', name: 'Statuario White Megabarocco', look: 'Marble', thickness: '12 mm', size: SLAB_SIZE,
    primary: 'https://www.melangetile.com/assets/images/versace/product shots/statuario-white-megabarocco-a-ps1.jpg',
    alt: ['https://www.melangetile.com/assets/images/versace/product shots/statuario-white-megabarocco-b-ps1.jpg'] },

  // ---- 6mm Maximvs-6 decor & trim pieces ----
  { code: '4349', name: 'Manifesto Lettering', look: 'Decorative', thickness: '6 mm',
    primary: 'https://www.melangetile.com/assets/images/versace/product shots/manifesto-lettering-a-g67640-ps1.jpg',
    alt: ['https://www.melangetile.com/assets/images/versace/product shots/manifesto-lettering-b-67641-ps1.jpg'],
    life: ['https://www.melangetile.com/assets/images/versace/roomscenes/manifesto-lettering-versace-maximvs-6-rs1.jpg',
           'https://www.melangetile.com/assets/images/versace/roomscenes/manifesto-lettering-versace-maximvs-6-rs2.jpg'] },
  { code: '4350', name: 'Manifesto Foulard', look: 'Decorative', thickness: '6 mm',
    primary: 'https://www.melangetile.com/assets/images/versace/product shots/manifesto-foulard-g67672-ps1.jpg',
    life: ['https://www.melangetile.com/assets/images/versace/roomscenes/manifesto-foulard-versace-slab-maximvs-6-rs1.jpg'] },
  { code: '4351', name: 'Manifesto Megabarocco Color', look: 'Decorative', thickness: '6 mm',
    primary: 'https://www.melangetile.com/assets/images/versace/product shots/megabarocco-color--g67642-ps1.jpg',
    life: ['https://www.melangetile.com/assets/images/versace/roomscenes/manifesto-megabarocco-color-versace-maximvs-6-rs1.jpg'] },
  { code: '4352', name: 'Megabarocco Maxi White', look: 'Decorative', thickness: '6 mm',
    primary: 'https://www.melangetile.com/assets/images/versace/product shots/barooco-maxi-white-67671-ps1.jpg',
    life: ['https://www.melangetile.com/assets/images/versace/roomscenes/manifesto-megabarocco-maxi-white-versace-maximvs-6-rs-3.jpg'] },
  { code: '4353', name: 'Rosa Venezia Megabarocco', look: 'Decorative', thickness: '6 mm',
    primary: 'https://www.melangetile.com/assets/images/versace/product shots/rosa-venezia-megabarocco-g67527-ps1.jpg' },
  { code: '4355', name: 'Black & Gold Megabarocco', look: 'Decorative', thickness: '6 mm',
    primary: 'https://www.melangetile.com/assets/images/versace/product shots/versace-black-and-gold-ps2.jpg' },
  { code: '4356', name: 'Greca Sabbiata Statuario White', look: 'Decorative', thickness: '6 mm',
    primary: 'https://www.melangetile.com/assets/images/versace/product shots/greca-sabbiata-saturaio-white-67830-ps1.jpg',
    alt: ['https://www.melangetile.com/assets/images/versace/product shots/1000003543.jpg'] },
  { code: '4357', name: 'Lux Avori-Oro', look: 'Decorative', thickness: '6 mm',
    primary: 'https://www.melangetile.com/assets/images/versace/product shots/lux-avorio-oro-maximvs-fascia-ps2.jpg',
    alt: ['https://www.melangetile.com/assets/images/versace/product shots/lux-avorio-oro-maximvs-fascia ps1.jpg',
          'https://www.melangetile.com/assets/images/versace/product shots/lux-avorio-oro-maximvs-angolo-ps1.jpg'] },
];

const slugify = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function attrId(slug) {
  const r = await pool.query('SELECT id FROM attributes WHERE slug = $1', [slug]);
  if (!r.rows.length) throw new Error(`missing attribute: ${slug}`);
  return r.rows[0].id;
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===\n' : '=== LIVE ===\n');

  const v = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
  if (!v.rows.length) throw new Error('MLG vendor not found');
  const vendorId = v.rows[0].id;

  const cat = await pool.query('SELECT id FROM categories WHERE slug = $1', [CATEGORY_SLUG]);
  if (!cat.rows.length) throw new Error('porcelain-slabs category not found');
  const categoryId = cat.rows[0].id;

  const A = {
    color: await attrId('color'), size: await attrId('size'),
    material: await attrId('material'), look: await attrId('look'),
    thickness: await attrId('thickness'), brand: await attrId('brand'),
  };

  let nProd = 0, nSku = 0, nMedia = 0;
  const mediaRowsToMirror = [];

  for (const p of PRODUCTS) {
    const slug = `versace-maximvs-${slugify(p.name)}`;
    const desc = p.look === 'Marble'
      ? `Versace Ceramics Maximvs — ${p.name}. A large-format ${p.thickness} porcelain slab (${SLAB_SIZE}) with a luxury marble look, from the Versace Home surfaces collection by Gardenia Orchidea. Call for price and availability.`
      : `Versace Ceramics Maximvs — ${p.name}. A ${p.thickness} porcelain decor from the Versace Home Maximvs collection by Gardenia Orchidea. Call for price and availability.`;

    if (DRY_RUN) {
      const imgs = [p.primary, ...(p.alt || []), ...(p.life || [])].length;
      console.log(`  ${p.code}  ${COLLECTION} ${p.name}  [${p.look}/${p.thickness}]  ${imgs} imgs  slug=${slug}`);
      nProd++; continue;
    }

    // ---- product (call-for-price → no pricing rows anywhere) ----
    const prodRes = await pool.query(`
      INSERT INTO products (vendor_id, name, collection, category_id, category_source,
                            status, is_active, slug, description_short, content_status)
      VALUES ($1,$2,$3,$4,'manual','active',true,$5,$6,'reviewed')
      ON CONFLICT (vendor_id, collection, name) DO UPDATE SET
        category_id = EXCLUDED.category_id,
        status = 'active', is_active = true,
        slug = COALESCE(products.slug, EXCLUDED.slug),
        description_short = EXCLUDED.description_short,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id`, [vendorId, p.name, COLLECTION, categoryId, slug, desc]);
    const productId = prodRes.rows[0].id;
    nProd++;

    // ---- single SKU (the Maximvs slab) ----
    const internalSku = `MLG-VRS-${p.code}`;
    const variantName = p.size ? `${p.size} · ${p.thickness}` : p.thickness;
    const skuRes = await pool.query(`
      INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, status)
      VALUES ($1,$2,$3,$4,'unit','active')
      ON CONFLICT (internal_sku) DO UPDATE SET
        product_id = EXCLUDED.product_id, vendor_sku = EXCLUDED.vendor_sku,
        variant_name = EXCLUDED.variant_name, sell_by = 'unit', status = 'active',
        updated_at = CURRENT_TIMESTAMP
      RETURNING id`, [productId, p.code, internalSku, variantName]);
    const skuId = skuRes.rows[0].id;
    nSku++;

    // ---- attributes ----
    const attrs = [
      [A.color, p.name], [A.material, 'Porcelain'], [A.look, p.look],
      [A.thickness, p.thickness], [A.brand, 'Versace'],
    ];
    if (p.size) attrs.push([A.size, p.size]);
    for (const [aid, val] of attrs) {
      await pool.query(`
        INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1,$2,$3)
        ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
        [skuId, aid, val]);
    }

    // ---- media (per-SKU): primary shot, extra shots as alternate, room scenes as lifestyle ----
    const media = [
      { url: p.primary, type: 'primary' },
      ...(p.alt || []).map(u => ({ url: u, type: 'alternate' })),
      ...(p.life || []).map(u => ({ url: u, type: 'lifestyle' })),
    ];
    // Replace this SKU's media so re-runs stay clean.
    await pool.query('DELETE FROM media_assets WHERE sku_id = $1', [skuId]);
    for (let i = 0; i < media.length; i++) {
      const src = enc(media[i].url);
      const r = await pool.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1,$2,$3,$4,$4,$5) RETURNING id, url, original_url`,
        [productId, skuId, media[i].type, src, i]);
      mediaRowsToMirror.push(r.rows[0]);
      nMedia++;
    }

    console.log(`  ✓ ${p.code}  ${COLLECTION} ${p.name}  (${media.length} imgs)`);
  }

  console.log(`\nUpserted: ${nProd} products, ${nSku} skus, ${nMedia} media (call-for-price)`);

  // ---- mirror images to self-hosted uploads/mirror ----
  if (!DRY_RUN && !NO_MIRROR && mediaRowsToMirror.length) {
    console.log(`\nMirroring ${mediaRowsToMirror.length} images…`);
    let ok = 0, skip = 0;
    for (const row of mediaRowsToMirror) {
      try { (await mirrorMediaRow(pool, row)) ? ok++ : skip++; }
      catch { skip++; }
    }
    console.log(`  mirrored ${ok}, kept vendor url ${skip}`);
  }

  console.log('\n=== Versace Maximvs onboarding complete ===');
  await pool.end();
}

main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
