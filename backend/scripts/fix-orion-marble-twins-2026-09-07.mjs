// Orion marble-look porcelain tiles — repair "incomplete product" degradation.
// 2026-09-07.
//
// These 7 Marmorea / Calacatta marble-look porcelain TILES (verified porcelain
// floor-tile on Orion's live site + the July 2026 dealer list) had drifted into
// an unsellable state over successive re-scrapes:
//   • Orion switched the pages to "Get a Price" (quote-only) → scraper writes
//     retail=null on quote pages, so the real retail never refreshed. Leftover
//     DB retails were stale/below-cost, or the pricing row was missing entirely.
//   • SIZE_MAP in scrapers/orion.js had NO entries for these names → no Size
//     attribute was ever assigned.
//   • Rosso Verona carried a duplicate bare-slug stub SKU with no price/size.
//
// Ground truth (uploads/pricelists/Orion-wholesale-net-2026-07-15.pdf):
//   MARMOREA (Carrara/Nero/Rosso Verona/Verde Alpi) — matte rectified marble
//     porcelain, 24X24, 11.88 SF/box, $4.19/sf cost, made in Italy.
//   CALACATTA GOLD (Calacatta Mexico) — polished porcelain, 24x48, $2.89 India.
//   CALACATTA (Muse 2.0) — Muse Calacatta 24x48, $4.69 Italy.
// Retail convention = ceil(cost x 1.6) to the next dollar, minus $0.01 ($X.99).
// This reproduces BOTH the 2026-09-05 "verified ~$6.99/sf" note (4.19→6.99) AND
// the existing-correct Calacatta Gold retail (2.89→4.99), so it's the right rule.
//
// Owner-confirmed 2026-09-07: "Carrara" (bare) = the Spanish Blanco/Carrara
// polished line (24x48, $4.19 → $6.99), a distinct product from Marmorea Carrara.
// "Reverse" is absent from the July dealer list → discontinued (deactivated).
//
// The durable scraper guard (SIZE_MAP additions) lives in scrapers/orion.js so a
// future re-scrape re-applies these sizes; quote-page retail=null keeps our
// retail from being wiped.
//
// Idempotent: keyed by sku_id; safe to re-run.
//   docker compose exec -T api node scripts/fix-orion-marble-twins-2026-09-07.mjs
//   (prod) ssh -i ~/.ssh/roma-prod.pem ubuntu@32.188.96.3
//          docker compose exec -T api node scripts/fix-orion-marble-twins-2026-09-07.mjs

import { pool } from '../db.js';

const SIZE_ATTR = 'd50e8400-e29b-41d4-a716-446655440004';

// One row per SKU we are confident about. cost/retail from the July list +
// the $X.99 convention; size from the list / live pages.
const FIXES = [
  // Marmorea marble-look family — 24x24, $4.19 → $6.99
  { sku: '12794f87-d6be-44fa-8de3-8b4da79c4bc7', label: 'Marmorea Carrara',    cost: 4.19, retail: 6.99, size: '24x24' },
  { sku: '983c2cd7-3d6f-47e6-bfc8-c0282a721f88', label: 'Marmorea Verde Alpi', cost: 4.19, retail: 6.99, size: '24x24' },
  { sku: '24c274e4-ba53-45e4-bc61-2bfbd2d9baf6', label: 'Nero Marquinia',      cost: 4.19, retail: 6.99, size: '24x24' },
  { sku: 'ec8d310c-7a40-4b33-a513-1f7371da04cc', label: 'Rosso Verona',        cost: 4.19, retail: 6.99, size: '24x24' },
  // Calacatta Gold — cost/retail already correct, only the size was missing
  { sku: '8f69f70d-a9ba-4981-9629-0834c69ced55', label: 'Calacatta Gold',      cost: 2.89, retail: 4.99, size: '24x48' },
  // Calacatta (Muse 2.0) — had no pricing row at all
  { sku: '733b66a2-49f5-4ada-b80c-18be01ed6ee0', label: 'Calacatta (Muse)',    cost: 4.69, retail: 7.99, size: '24x48' },
  // Carrara — Spanish Blanco/Carrara polished (owner-confirmed), had no pricing row
  { sku: '3bfb2678-55d9-4c56-bcb5-d64767209d79', label: 'Carrara (Blanco)',    cost: 4.19, retail: 6.99, size: '24x48' },
];

// Duplicate bare-slug stub SKU (no price/size/orders) — retire it.
const DEDUP_SKU = '2616d1ab-61b8-4412-b865-91175b6694ac'; // Rosso Verona 'rosso-verona'

// Discontinued — not in the July dealer list, no cost source.
const DISCONTINUE_SKU = 'cc16b6b9-6f29-46ed-a800-d6ffd29e4ddc'; // Reverse
const DISCONTINUE_PRODUCT = '36fa5beb-d5fd-45ec-a04a-2f8782b4cb97';

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const f of FIXES) {
      // Pricing: upsert (many of these had no pricing row → blank/invisible).
      await client.query(
        `INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
         VALUES ($1, $2, $3, 'per_sqft')
         ON CONFLICT (sku_id) DO UPDATE
           SET cost = EXCLUDED.cost,
               retail_price = EXCLUDED.retail_price,
               price_basis = 'per_sqft'`,
        [f.sku, f.cost, f.retail]
      );

      // Size attribute upsert.
      await client.query(
        `INSERT INTO sku_attributes (sku_id, attribute_id, value)
         VALUES ($1, $2, $3)
         ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
        [f.sku, SIZE_ATTR, f.size]
      );

      console.log(`✓ ${f.label.padEnd(20)} cost $${f.cost}  retail $${f.retail}  size ${f.size}`);
    }

    // Retire the Rosso Verona duplicate stub SKU (no pricing/orders/cart).
    const dd = await client.query(
      `UPDATE skus SET status = 'inactive'
       WHERE id = $1 AND status <> 'inactive'
       RETURNING vendor_sku`,
      [DEDUP_SKU]
    );
    if (dd.rowCount) console.log(`✓ deactivated duplicate stub SKU: ${dd.rows[0].vendor_sku}`);
    else console.log('· duplicate stub SKU already inactive');

    // Discontinue Reverse (not in dealer list).
    const rs = await client.query(
      `UPDATE skus SET status = 'inactive' WHERE id = $1 AND status <> 'inactive' RETURNING vendor_sku`,
      [DISCONTINUE_SKU]
    );
    await client.query(`UPDATE products SET is_active = false WHERE id = $1`, [DISCONTINUE_PRODUCT]);
    if (rs.rowCount) console.log(`✓ discontinued: ${rs.rows[0].vendor_sku} (Reverse)`);
    else console.log('· Reverse already inactive');

    await client.query('COMMIT');
    console.log('\nDone.');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

main().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
