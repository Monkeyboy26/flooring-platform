// Enrich the Tarkett onboard (0905d53) with data scraped from
// commercial.tarkett.com: per-color swatch images from the tarkettexchange
// DAM (matched by SAP part number / color code, 206/211 flooring products),
// collection-level marketing descriptions, and the iD Latitude 20 mil wear
// layer attr. Room scenes intentionally NOT attached (Daltile lesson:
// collection-wide scenes on every color = color-mismatch epidemic).
//
// Insert-only for media (skips products that already have a primary);
// description_long overwritten only for the five flooring collections.
//
//   docker exec -e DB_HOST=db flooring-api node data/bigd/tarkett-enrich-site-data-2026-11-08.mjs [--apply]

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
const VENDOR_ID = '71708161-0077-4b80-b128-a52d689de455';
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'tarkett-site-data.json'), 'utf8'));

async function main() {
  let imgNew = 0, imgSkip = 0, imgNoProd = 0, descN = 0, wearN = 0;

  for (const [key, url] of Object.entries(data.swatches)) {
    const [collection, name] = key.split('|||');
    const { rows } = await pool.query(
      `SELECT p.id, (SELECT count(*) FROM media_assets m WHERE m.product_id=p.id AND m.asset_type='primary') n
         FROM products p WHERE p.vendor_id=$1 AND p.collection=$2 AND p.name=$3`,
      [VENDOR_ID, collection, name]);
    if (!rows.length) { imgNoProd++; console.warn(`  ! no product ${collection} / ${name}`); continue; }
    if (parseInt(rows[0].n) > 0) { imgSkip++; continue; }
    if (APPLY) {
      await pool.query(
        `INSERT INTO media_assets (product_id, asset_type, url, original_url, sort_order, source)
         VALUES ($1,'primary',$2,$3,0,'scraper')`,
        [rows[0].id, url + '?io=transform:fit,width:1200', url]);
    }
    imgNew++;
  }

  for (const [collection, desc] of Object.entries(data.descriptions)) {
    if (APPLY) {
      const r = await pool.query(
        `UPDATE products SET description_long=$3, description_short=left($3,250)
          WHERE vendor_id=$1 AND collection=$2`, [VENDOR_ID, collection, desc]);
      descN += r.rowCount;
    } else {
      const r = await pool.query(
        `SELECT count(*) FROM products WHERE vendor_id=$1 AND collection=$2`, [VENDOR_ID, collection]);
      descN += parseInt(r.rows[0].count);
    }
  }

  for (const [collection, wear] of Object.entries(data.wear_layer || {})) {
    const { rows: [attr] } = await pool.query(`SELECT id FROM attributes WHERE slug='wear_layer'`);
    if (!attr) break;
    if (APPLY) {
      const r = await pool.query(
        `INSERT INTO sku_attributes (sku_id, attribute_id, value)
         SELECT s.id, $3, $4 FROM skus s JOIN products p ON p.id=s.product_id
          WHERE p.vendor_id=$1 AND p.collection=$2
         ON CONFLICT (sku_id, attribute_id) DO NOTHING`,
        [VENDOR_ID, collection, attr.id, wear]);
      wearN += r.rowCount;
    } else {
      const r = await pool.query(
        `SELECT count(*) FROM skus s JOIN products p ON p.id=s.product_id WHERE p.vendor_id=$1 AND p.collection=$2`,
        [VENDOR_ID, collection]);
      wearN += parseInt(r.rows[0].count);
    }
  }

  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}: primary images +${imgNew} (skipped-existing ${imgSkip}, no-product ${imgNoProd}); descriptions ${descN} products; wear_layer ${wearN} skus`);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
