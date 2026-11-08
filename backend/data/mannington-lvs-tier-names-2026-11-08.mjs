// Name Mannington Luxury Vinyl Sheet variants by their REAL tier.
//
// The LVS block of the rolls price list sells each pattern+color in up to
// three wear tiers (style codes LVS1/LVS2/LVS3, catalog-prefixes 130/100/080)
// at different prices. Mannington markets these as PLATINUM / GOLD / SILVER
// (mannington.com /luxury-vinyl-sheet/{platinum,gold,silver}; third-party
// listings "Platinum Coral Bay 130103" / "Gold ... 100103" / "Silver ... 080100").
// The onboard named all tiers identically ("Terrace, 12' Sheet"), and the
// nightly variant deduper (quality/variantDedupe.js) auto-suffixed the
// colliding triplets with the vendor_sku — correct mechanics, meaningless to
// a customer.
//
// This script renames every LVS SKU to "{color}, {size} Sheet ({Tier})" and
// stamps sub_line = "{Tier}" (the attribute the PDP renders as pills, like
// ADURA Max/Flex), which is also what keeps the deduper satisfied going
// forward. Backup: skus_mann_lvs_tier_names_backup_20261108.
//
//   docker exec -e DB_HOST=db flooring-api node data/mannington-lvs-tier-names-2026-11-08.mjs [--apply]

import pg from 'pg';
import fs from 'fs';

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const APPLY = process.argv.includes('--apply');
const VENDOR_ID = 'dabbf50b-c1ed-4e81-8bf1-c1ac88a5a4bd'; // Mannington
const SUB_LINE_ATTR = '7eded353-d9ec-4be3-8685-9ca599d80d98';
const BACKUP = 'skus_mann_lvs_tier_names_backup_20261108';
const SRC = new URL('./mannington/mannington-pricelist-2026-11-06.json', import.meta.url).pathname;
const TIER = { LVS1: 'Platinum', LVS2: 'Gold', LVS3: 'Silver' };

async function main() {
  const { rolls } = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const lvs = rolls.filter(r => TIER[r.style_code]);
  const byCatalog = new Map(lvs.map(r => [r.catalog, r]));
  console.log(`LVS rows in list: ${lvs.length}`);

  const { rows: skus } = await pool.query(
    `SELECT s.id, s.vendor_sku, s.variant_name FROM skus s JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND s.sell_by = 'roll'`, [VENDOR_ID]);
  const plan = [];
  for (const s of skus) {
    const r = byCatalog.get(s.vendor_sku);
    if (!r) continue;
    const tier = TIER[r.style_code];
    const newName = `${r.color}, ${r.size} Sheet (${tier})`;
    plan.push({ sku_id: s.id, vendor_sku: s.vendor_sku, old: s.variant_name, newName, tier });
  }
  const changing = plan.filter(p => p.old !== p.newName);
  console.log(`LVS SKUs in DB: ${plan.length}; names changing: ${changing.length}`);
  for (const p of changing.slice(0, 8)) console.log(`  ${p.vendor_sku}: "${p.old}" -> "${p.newName}"`);

  if (!APPLY) { console.log('\nDRY RUN — re-run with --apply.'); await pool.end(); return; }

  const ids = plan.map(p => p.sku_id);
  await pool.query(`DROP TABLE IF EXISTS ${BACKUP}`);
  await pool.query(
    `CREATE TABLE ${BACKUP} AS SELECT id AS sku_id, vendor_sku, variant_name FROM skus WHERE id = ANY($1::uuid[])`, [ids]);

  for (const p of plan) {
    if (p.old !== p.newName) {
      await pool.query(`UPDATE skus SET variant_name = $2, updated_at = now() WHERE id = $1`, [p.sku_id, p.newName]);
    }
    await pool.query(
      `INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
       ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
      [p.sku_id, SUB_LINE_ATTR, p.tier]);
  }
  console.log(`Renamed ${changing.length}, sub_line stamped on ${plan.length} (backup ${BACKUP}).`);

  const { rows: after } = await pool.query(
    `SELECT s.vendor_sku, s.variant_name,
            (SELECT value FROM sku_attributes WHERE sku_id = s.id AND attribute_id = $2) AS sub_line
       FROM skus s WHERE s.id = ANY($1::uuid[]) AND s.vendor_sku IN ('589624','589630','589632') ORDER BY s.vendor_sku`,
    [ids, SUB_LINE_ATTR]);
  console.log('\nValencia Terrace triplet after:');
  for (const a of after) console.log(`  ${a.vendor_sku} "${a.variant_name}" sub_line=${a.sub_line}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
