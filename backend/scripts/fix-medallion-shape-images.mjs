#!/usr/bin/env node
/**
 * Stone Pride medallions — make every image match the variant's SHAPE (2026-09-13)
 *
 * Trigger: "Marble Medallions Odyssey 48\" Round shows the square" — the Odyssey
 * product (4 ROUND SKUs: 48/60/72RD) had exactly one image, the vendor's SQUARE
 * photo (MM-24-48-SQ-Odyssey.jpg, square greek-key layout).
 *
 * Shape ground truth = stone-pride.com per-shape listing pages (round-/square-/
 * oval-medallions, rectangular-medallion) + visual verification of every mirrored
 * webp and every newly attached photo. Audit of all 97 medallion SKUs found:
 *   - Odyssey: 4 round SKUs on a square-only photo (vendor has NO round photo;
 *     the 2018 vendor image Odyssey.9-6-2017.jpg has the round greek-key layout
 *     inside square corners — we circle-cropped it onto white:
 *     uploads/stone-pride/odyssey-round-mm24.jpg. Same artwork, no fabrication).
 *   - Casablanca: product hero was the OVAL custom-order photo; both SKUs are
 *     rectangular (per-SKU rect images were already correct).
 *   - August Green 24SQ/36SQ: fell back to the round hero; vendor square photo
 *     exists (Onyx-Collection-August-Green...).
 *   - Mini: all 8 SKUs fell back to the design-101 hero; vendor has one photo
 *     per design (022/101/250/251/252).
 *   - Alpine, Bloomdale: photoless; vendor round photos exist (verified round).
 *   - Aluminum-Backed A-07 3x4 oval: photoless; vendor oval photo exists.
 * Residual (vendor has no imagery — left photoless, do NOT fabricate):
 *   Aptus, Geneva, Kamila, Lucerne, Radial, Rafael, Rose, Roman,
 *   Aluminum-Backed (A-06 / YT-03 / 36Triangular), Grace 24"SQ Corner.
 *
 * Idempotent. Reverse: DELETE FROM media_assets WHERE source='fixup-medallion-shape';
 * (hero repoints are logged with previous URLs).
 *
 * Usage: DB_PASSWORD=postgres node backend/scripts/fix-medallion-shape-images.mjs [--dry-run]
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});
const DRY = process.argv.includes('--dry-run');
const SOURCE = 'fixup-medallion-shape';

const SP = 'https://www.stone-pride.com/wp-content/uploads';
const ODYSSEY_ROUND = '/uploads/stone-pride/odyssey-round-mm24.jpg';
const CASABLANCA_RECT = `${SP}/2017/05/Casablanca-available-in-3ft-x-5ft-and-4ft-x-6ft.jpg`;
const AUGUST_GREEN_SQ = `${SP}/2017/05/Onyx-Collection-August-Green-Stone-names-Crema-Marfil-Emperador-Dark-Green-Onyx-Mixed-Red-Onyx-Emperador-Light.jpg`;
const ALPINE_RD = `${SP}/2017/05/Alpine-available-in-36in-and-4.jpg`;
const BLOOMDALE_RD = `${SP}/2017/05/Bloomdale-available-in-36in.jpg`;
const A07_OVAL = `${SP}/2017/05/Onyx-Collection-A-07-3ftx4ft-Stone-names-Crema-Marfil-Emperador-Dark-Emperador-Light-Red-Onyx-Green-Onyx.jpg`;
const MINI = (d) => `${SP}/2017/05/Mini-Collection-${d}-${d === '022' ? '18in-and-24in' : '4in-18in-and-24in'}-Stone-names-Crema-Marfil-Emperador-Dark-Emperador-Light.jpg`;

async function medallionProduct(client, name) {
  const { rows } = await client.query(
    `SELECT p.id FROM products p
     JOIN vendors v ON v.id = p.vendor_id AND v.code = 'STPR'
     JOIN categories c ON c.id = p.category_id AND c.slug = 'medallions'
     WHERE p.name = $1`, [name]);
  if (rows.length !== 1) throw new Error(`expected 1 medallion product "${name}", got ${rows.length}`);
  return rows[0].id;
}

async function attachSkuPrimary(client, productId, skuId, url, label) {
  const cur = await client.query(
    `SELECT id, url FROM media_assets
     WHERE sku_id = $1 AND asset_type = 'primary' AND sort_order = 0`, [skuId]);
  if (cur.rows.length && cur.rows[0].url === url) return console.log(`  = ${label} already correct`);
  if (DRY) return console.log(`  ~ would set ${label} -> ${url}`);
  if (cur.rows.length) {
    await client.query(`UPDATE media_assets SET url = $2, source = $3 WHERE id = $1`,
      [cur.rows[0].id, url, SOURCE]);
    console.log(`  ^ ${label} repointed (was ${cur.rows[0].url})`);
  } else {
    await client.query(
      `INSERT INTO media_assets (product_id, sku_id, asset_type, sort_order, url, source)
       VALUES ($1, $2, 'primary', 0, $3, $4)`, [productId, skuId, url, SOURCE]);
    console.log(`  + ${label} attached`);
  }
}

async function repointProductHero(client, productId, url, label) {
  const cur = await client.query(
    `SELECT id, url FROM media_assets
     WHERE product_id = $1 AND sku_id IS NULL AND asset_type = 'primary' AND sort_order = 0`, [productId]);
  if (cur.rows.length && cur.rows[0].url === url) return console.log(`  = ${label} hero already correct`);
  if (DRY) return console.log(`  ~ would set ${label} hero -> ${url}`);
  if (cur.rows.length) {
    await client.query(`UPDATE media_assets SET url = $2, source = $3 WHERE id = $1`,
      [cur.rows[0].id, url, SOURCE]);
    console.log(`  ^ ${label} hero repointed (was ${cur.rows[0].url})`);
  } else {
    await client.query(
      `INSERT INTO media_assets (product_id, asset_type, sort_order, url, source)
       VALUES ($1, 'primary', 0, $2, $3)`, [productId, url, SOURCE]);
    console.log(`  + ${label} hero attached`);
  }
  // drop product-level alternates that now duplicate the hero URL
  const dup = await client.query(
    `DELETE FROM media_assets
     WHERE product_id = $1 AND sku_id IS NULL AND asset_type = 'alternate' AND url = $2
     RETURNING id`, [productId, url]);
  if (dup.rows.length) console.log(`  - ${label}: removed ${dup.rows.length} duplicate alternate(s)`);
}

async function skusOf(client, productId) {
  const { rows } = await client.query(
    `SELECT id, vendor_sku FROM skus WHERE product_id = $1`, [productId]);
  return rows;
}

const client = await pool.connect();
try {
  await client.query('BEGIN');

  console.log('Odyssey — round crop for hero + all 4 round SKUs');
  const odyssey = await medallionProduct(client, 'Odyssey');
  await repointProductHero(client, odyssey, ODYSSEY_ROUND, 'Odyssey');
  for (const s of await skusOf(client, odyssey))
    await attachSkuPrimary(client, odyssey, s.id, ODYSSEY_ROUND, s.vendor_sku);

  console.log('Casablanca — hero oval -> rect');
  const casablanca = await medallionProduct(client, 'Casablanca');
  await repointProductHero(client, casablanca, CASABLANCA_RECT, 'Casablanca');

  console.log('August Green — square photo on the two SQ SKUs');
  const august = await medallionProduct(client, 'August Green');
  for (const s of await skusOf(client, august))
    if (/SQ/i.test(s.vendor_sku))
      await attachSkuPrimary(client, august, s.id, AUGUST_GREEN_SQ, s.vendor_sku);

  console.log('Mini — per-design photos');
  const mini = await medallionProduct(client, 'Mini');
  for (const s of await skusOf(client, mini)) {
    const m = s.vendor_sku.match(/MM-Mini-(\d{3})-/);
    if (m) await attachSkuPrimary(client, mini, s.id, MINI(m[1]), s.vendor_sku);
    else console.log(`  ! no design token in ${s.vendor_sku}`);
  }

  console.log('Alpine — round photo (was photoless)');
  const alpine = await medallionProduct(client, 'Alpine');
  await repointProductHero(client, alpine, ALPINE_RD, 'Alpine');
  for (const s of await skusOf(client, alpine))
    await attachSkuPrimary(client, alpine, s.id, ALPINE_RD, s.vendor_sku);

  console.log('Bloomdale — round photo (was photoless)');
  const bloomdale = await medallionProduct(client, 'Bloomdale');
  await repointProductHero(client, bloomdale, BLOOMDALE_RD, 'Bloomdale');
  for (const s of await skusOf(client, bloomdale))
    await attachSkuPrimary(client, bloomdale, s.id, BLOOMDALE_RD, s.vendor_sku);

  console.log('Aluminum-Backed — oval photo on the A-07 oval SKU only');
  const alu = await medallionProduct(client, 'Aluminum-Backed');
  for (const s of await skusOf(client, alu))
    if (/^MM-A-07/i.test(s.vendor_sku))
      await attachSkuPrimary(client, alu, s.id, A07_OVAL, s.vendor_sku);

  await client.query(DRY ? 'ROLLBACK' : 'COMMIT');
  console.log(DRY ? '\nDRY RUN — rolled back' : '\nCOMMITTED');
} catch (e) {
  await client.query('ROLLBACK');
  console.error('FAILED, rolled back:', e);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
