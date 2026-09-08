// Attach Marmorea Carrara's real gallery images — 2026-09-07.
//
// Marmorea Carrara (ORN-carrara-marble-marmorea) was photoless: the Woodmart
// gallery on its live page (carrara-marble-marmorea) returns an empty node set
// to the puppeteer scraper (a page-specific DOM quirk — 0 errors, SKU is touched
// but data.images is empty), so the scraper never imports anything and, because
// its DELETE+reimport only runs when images ARE found, it also never clobbers a
// manual attach. We pull the gallery URLs straight from the live page HTML.
//
// The wordy hero ("Carrara-marble-embodies-…") is deliberately EXCLUDED: its
// filename tokens match the bare "Carrara" (Blanco) product, so the post-scrape
// borrowed-image integrity pass would strip it every run. The CARRARA-2..7 files
// carry only the shared "carrara" token, which is a subset of this product's own
// name ("Marmorea Carrara") — kept by the patched rule (a). So this set is stable.
//
// Idempotent: clears this SKU's assets, then re-inserts the fixed set.
//   (prod) ssh -i ~/.ssh/roma-prod.pem ubuntu@32.188.96.3
//          docker compose exec -T api node scripts/attach-marmorea-carrara-images-2026-09-07.mjs

import { pool } from '../db.js';

const PRODUCT_ID = 'dad207fa-8e72-493a-8e96-75271f5454fc';
const SKU_ID     = '12794f87-d6be-44fa-8de3-8b4da79c4bc7';
const BASE = 'https://orionflooring.com/wp-content/uploads/2025/10/';

// asset_type + order chosen like classifyOrionImages: most-portrait = primary.
const IMAGES = [
  { file: 'CARRARA-7.jpg', type: 'primary'   }, // 1200x1751 (most portrait)
  { file: 'CARRARA-6.jpg', type: 'alternate' }, // 1200x1719
  { file: 'CARRARA-2.jpg', type: 'lifestyle' }, // 1200x1200
  { file: 'CARRARA-5.jpg', type: 'lifestyle' }, // 1200x1200
  { file: 'CARRARA-3.jpg', type: 'lifestyle' }, // 1200x961
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM media_assets WHERE sku_id = $1', [SKU_ID]);
    let order = 0;
    for (const { file, type } of IMAGES) {
      const url = BASE + file;
      await client.query(
        `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
         VALUES ($1, $2, $3, $4, $4, $5, 'manual')`,
        [PRODUCT_ID, SKU_ID, type, url, order++]
      );
      console.log(`✓ ${type.padEnd(10)} ${url}`);
    }
    await client.query('COMMIT');
    console.log(`\nAttached ${IMAGES.length} images to Marmorea Carrara.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

main().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
