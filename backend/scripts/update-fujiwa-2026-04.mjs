/**
 * Fujiwa Tile price-list update — "202645 Fujiwa Tile Price List PER SKU.pdf"
 * (Effective April 13, 2026 — replaces ALL previous price lists.)
 *
 * What it does:
 *   1. Updates pricing.cost to the new "YOUR COST" column and recomputes
 *      retail with the platform keystone rule: round-DOWN-to-.x9(cost × 1.6)
 *      with the covering floor (cost + $0.99) for per_sqft/sqft rows.
 *   2. Renames vendor_sku to the official price-list item codes where the
 *      importer had synthesized aliases (ALCO-DECO-501 → ALCO-501, CELICA →
 *      CEL, STONELEDGE → SL, VIP-813 → VIPS-813, …) so vendor POs carry codes
 *      Fujiwa recognizes. internal_sku is never touched.
 *   3. Deactivates SKUs absent from the new list (status → inactive). SKUs
 *      already inactive are left alone either way.
 *   4. Adds the three new families on the list: Doris, Metro, Zeta.
 *   5. Reactivates + renames the legacy `1" HEXagon` SKU as HEX-10 (White
 *      Matte — still on the list; its per-color siblings HEX-20..50 are active).
 *
 * Generic-model rows (DB collapses per-series items into shared SKUs):
 *   - DM-* depth markers  → all $10.80 on the new list (DEPTH-* rows)
 *   - TRIM-* pool trims   → all $5.40 on the new list (02/03/04/05 rows)
 *   - HSL-* skimmer lids  → not on the new list → deactivated
 *
 * Usage:
 *   node backend/scripts/update-fujiwa-2026-04.mjs            # dry run
 *   node backend/scripts/update-fujiwa-2026-04.mjs --apply    # commit
 */
import pg from 'pg';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const VENDOR_ID = '8ec5135f-8ded-4818-925e-2ca70bef4c0a'; // Fujiwa Tile
const BRAND_ID  = '91197c00-e449-486d-ba3a-0f6fa74c270e'; // Fujiwa
const CAT_POOL  = 'bbe1c9a0-1f6e-4f35-a714-acbb841520db'; // Pool Tile
const ATTR = {
  Color:    'd50e8400-e29b-41d4-a716-446655440001',
  Material: 'd50e8400-e29b-41d4-a716-446655440002',
  Size:     'd50e8400-e29b-41d4-a716-446655440004',
  Brand:    '4d2dd076-ea5c-4bf3-89fb-bc6fc2cefeda',
};

const RETAIL_MARKUP = 1.6;
const RETAIL_MIN_MARGIN = 0.99;
// Round DOWN to the nearest .x9 (see backfill-round-down-nine.mjs / base.js)
const newNine = (v) => {
  const cents = Math.round(Number(v) * 100);
  const k = Math.floor((cents - 9) / 10);
  return Math.max(9, k * 10 + 9) / 100;
};
function priceRetail(cost, basis) {
  const base = cost * RETAIL_MARKUP;
  const coveringFloor = (basis === 'per_sqft' || basis === 'sqft');
  const floorMin = coveringFloor ? cost + RETAIL_MIN_MARGIN : 0;
  let nine = newNine(Math.max(base, floorMin));
  if (floorMin > 0 && nine < floorMin - 1e-9) nine = Math.round((nine + 0.10) * 100) / 100;
  return nine;
}

// ==================== New price list: PDF item code → YOUR COST ====================
const P = {};
const set = (cost, ...codes) => codes.forEach(c => { P[c] = cost; });

set(6.60, 'ALCO-501','ALCO-502','ALCO-503','ALCO-504');
set(5.47, 'ALEX-504');
set(8.25, 'AMBON-6','AMBON-7');
set(18.70,'BOHOL-HILLS','BOHOL-LAKE');
set(6.33, 'CEL-201','CEL-202M','CEL-211','CEL-214','CEL-239','CEL-290','CEL-291','CEL-293','CEL-294');
set(7.15, 'DORIS-811','DORIS-812','DORIS-813','DORIS-814');
set(17.33,'EROS-102','EROS-104');
set(18.70,'EROS-602','EROS-604','EROS-605','EROS-608');
set(5.23, 'FGM-105');
set(7.15, 'FLORA-BELIZ','FLORA-VERA');
set(7.15, 'GLASSTEL-11','GLASSTEL-12','GLASSTEL-13','GLASSTEL-14','GLASSTEL-24','GLASSTEL-27','GLASSTEL-30','GLASSTEL-31','GLASSTEL-32','GLASSTEL-75','GLASSTEL-76');
set(6.60, 'GS-BLACK','GS-COBALT','GS-SKY BLUE','GS-WHITE');
set(7.15, 'HEX-10','HEX-20','HEX-30','HEX-40','HEX-50');
set(7.15, 'INKA-30','INKA-40');
set(7.15, 'JAVA-91','JAVA-92','JAVA-93','JAVA-94');
set(17.33,'JOYA-101','JOYA-102','JOYA-103','JOYA-104','JOYA-301','JOYA-302','JOYA-303','JOYA-304');
set(18.70,'JOYA-501','JOYA-502','JOYA-503','JOYA-504','JOYA-601','JOYA-602','JOYA-603','JOYA-604');
set(18.70,'KASURI-100');
set(18.70,'KAWA-51','KAWA-52','KAWA-53','KAWA-54','KAWA-55','KAWA-56');
set(6.60, 'KENJI-10','KENJI-20');
set(6.60, 'KLM-330','KLM-331');
set(4.73, 'KOLN-002','KOLN-005');
set(17.33,'LEGACY-96','LEGACY-97');
set(17.33,'LICATA-71','LICATA-72');
set(7.15, 'LOMBO-830','LOMBO-836','LOMBO-871','LOMBO-874','LOMBO-885');
set(8.25, 'LOMBO-881','LOMBO-882','LOMBO-883','LOMBO-884');
set(6.33, 'LT-1010','LT-1022');
set(8.25, 'LT-761MT','LT-762MT','LT-763MT');
set(18.70,'LUNAR-671','LUNAR-672','LUNAR-673','LUNAR-674');
set(7.15, 'LYRA-681','LYRA-682','LYRA-683','LYRA-684');
set(7.15, 'METRO-361','METRO-362','METRO-363','METRO-364');
set(17.33,'NAMI-152','NAMI-154');
set(18.70,'NAMI-652','NAMI-654');
set(5.23, 'NET-ATLANTIS');
set(18.70,'OMEGA-11','OMEGA-12','OMEGA-23','OMEGA-24');
set(6.33, 'PAD-171','PAD-172','PAD-173','PAD-174','PAD-175');
set(6.60, 'PATINA-9');
set(6.33, 'PEB-102','PEB-111','PEB-114','PEB-139','PEB-166','PEB-168','PEB-190','PEB-191','PEB-193','PEB-194','PEB-199');
set(6.60, 'PEBBLE-90','PEBBLE-91','PEBBLE-93','PEBBLE-102');
set(17.33,'PILOS-402','PILOS-404','PILOS-406','PILOS-408');
set(17.33,'PLANET-112','PLANET-113','PLANET-332','PLANET-333');
set(18.70,'PLANET-662','PLANET-663');
set(7.15, 'PNR-100','PNR-101','PNR-3421','PNR-3422','PNR-3423','PNR-3424','PNR-3425','PNR-3426','PNR-3427','PNR-3428');
set(7.15, 'QUARZO-GOLD','QUARZO-SODALITE');
set(6.60, 'RIO-901','RIO-902','RIO-903','RIO-904');
set(6.60, 'RIVERA-26');
set(17.33,'SAGA-112','SAGA-134');
set(18.70,'SAGA-661','SAGA-663');
set(6.05, 'SEKIS-622');
set(5.23, 'SIERRA-71');
set(18.70,'SL-AZURITE','SL-GRAY');
set(18.70,'SORA-771','SORA-778');
set(18.70,'STAK-331','STAK-338');
set(18.70,'STAR-331');
set(17.33,'STQ-331','STS-331');
set(6.60, 'SYDNEY-302','SYDNEY-306','SYDNEY-308');
set(8.80, 'TILIS-462','TILIS-463');
set(6.60, 'TITAN-331','TITAN-332','TITAN-333','TITAN-334','TITAN-762','TITAN-764');
set(8.25, 'TITAN-661','TITAN-662','TITAN-663','TITAN-664');
set(6.33, 'TNT-031','TNT-032','TNT-033','TNT-034');
set(17.33,'TOKYO-101','TOKYO-102','TOKYO-231','TOKYO-232');
set(18.70,'TOKYO-601','TOKYO-602');
set(9.00, 'UNG-100C','UNG-200C','UNG-201C');
set(10.20,'UNG-102C','UNG-202C');
set(6.60, 'VENIZ-345','VENIZ-346','VENIZ-347','VENIZ-348');
set(7.80, 'VIGAN-BAY','VIGAN-COAST','VIGAN-LAGOON','VIGAN-RIVER');
set(7.15, 'VINTA-200','VINTA-240','VINTA-241','VINTA-242','VINTA-243','VINTA-244','VINTA-245','VINTA-247');
set(6.33, 'VIP-702','VIP-703','VIP-711','VIP-713','VIP-714','VIP-791');
set(6.33, 'VIPS-813','VIPS-913','VIPS-917','VIPS-924','VIPS-925');
set(18.70,'YOMBA-5','YOMBA-6');
set(4.90, 'YUCCA-60');
set(8.80, 'ZETA-261','ZETA-262','ZETA-263','ZETA-264');
// Watermark art mosaics
set(66,  'Z-BALL-01','Z-LBS-41');
set(237, 'Z-BROWN-TLL-50');
set(165, 'Z-BROWN-TLS-54');
set(750, 'Z-CDG-101');
set(96,  'Z-CRL-30');
set(48,  'Z-CRS-32','Z-SHL-51','Z-SHL-53','Z-SHL-57','Z-STL-100','Z-STL-101','Z-STM-100','Z-STM-101','Z-STS-100','Z-STS-101');
set(225, 'Z-DOL-81','Z-POL-90');
set(171, 'Z-DOS-81','Z-POS-90');
set(132, 'Z-FIL-01','Z-FIL-03','Z-FIL-05','Z-FIL-07','Z-FIL-09','Z-FIL-11','Z-FIL-13','Z-FIL-20','Z-SHL-60');
set(81,  'Z-FIS-01','Z-FIS-03','Z-FIS-05','Z-FIS-07','Z-FIS-09','Z-FIS-11','Z-FIS-13','Z-SHM-62');
set(105, 'Z-LBL-40');
set(960, 'Z-MER-10');
set(87,  'Z-SCL-34');
set(147, 'Z-TIS-54','Z-TLM-52');
set(54,  'Z-TLB-58');
set(198, 'Z-TLL-50');

// ==================== DB vendor_sku → official PDF code renames ====================
const ALIAS = {
  'ALCO-DECO-501':'ALCO-501','ALCO-DECO-502':'ALCO-502','ALCO-DECO-503':'ALCO-503','ALCO-DECO-504':'ALCO-504',
  'AMBON-DECO-6':'AMBON-6','AMBON-DECO-7':'AMBON-7',
  'CELICA-201':'CEL-201','CELICA-211':'CEL-211','CELICA-214':'CEL-214','CELICA-239':'CEL-239',
  'CELICA-290':'CEL-290','CELICA-291':'CEL-291','CELICA-293':'CEL-293','CELICA-294':'CEL-294',
  'GLOSS-SOLID-BLACK':'GS-BLACK','GLOSS-SOLID-COBALT':'GS-COBALT','GLOSS-SOLID-SKY-BLUE':'GS-SKY BLUE','GLOSS-SOLID-WHITE':'GS-WHITE',
  '1" HEXagon':'HEX-10',
  'JOYA-DECO-501':'JOYA-501','JOYA-DECO-502':'JOYA-502','JOYA-DECO-503':'JOYA-503','JOYA-DECO-504':'JOYA-504',
  'LANTERN-1010':'LT-1010','LANTERN-1022':'LT-1022','LANTERN-761MT':'LT-761MT','LANTERN-762MT':'LT-762MT','LANTERN-763MT':'LT-763MT',
  'STAK-DECO-331':'STAK-331','STAK-DECO-338':'STAK-338',
  'STARDON-331':'STAR-331',
  'STONELEDGE-AZURITE':'SL-AZURITE','STONELEDGE-GRAY':'SL-GRAY',
  'TITAN-DECO-661':'TITAN-661','TITAN-DECO-662':'TITAN-662','TITAN-DECO-663':'TITAN-663','TITAN-DECO-664':'TITAN-664',
  'VIGAN-BAY-AZURE':'VIGAN-BAY','VIGAN-RIVER-AQUA':'VIGAN-RIVER',
  'VIP-813':'VIPS-813','VIP-913':'VIPS-913','VIP-917':'VIPS-917','VIP-924':'VIPS-924','VIP-925':'VIPS-925',
  'YUCA-60':'YUCCA-60',
  'Z-CTL-60':'Z-BROWN-TLL-50','Z-CTS-64':'Z-BROWN-TLS-54','Z-CRS--32':'Z-CRS-32','Z-MER-01':'Z-MER-10',
};

// Generic-model SKUs: flat new cost regardless of per-series PDF rows
const FLAT = [
  { prefix: 'DM-',   cost: 10.80 }, // all depth markers now $10.80
  { prefix: 'TRIM-', cost: 5.40 },  // all trims now $5.40 (incl. former "upgrade" tier)
];

// Metallic Lantern variant names were imported as "(Matte)" — fix while we're here
const VARIANT_NAME_FIX = {
  'LANTERN-761MT': '2" Arabesque (Metallic)',
  'LANTERN-762MT': '2" Arabesque (Metallic)',
  'LANTERN-763MT': '2" Arabesque (Metallic)',
};

// ==================== New families on the April 2026 list ====================
const NEW_FAMILIES = [
  { product: 'Doris', desc: '6" x 6" Pool Tile', size: '6x6', sizeLabel: '6" x 6"', sqft: 1.00, cost: 7.15,
    colors: { 'DORIS-811':'Marlin Green','DORIS-812':'Cayman Blue','DORIS-813':'Sandy Beach','DORIS-814':'French Grey' } },
  { product: 'Metro', desc: '3" x 6" Pool Tile', size: '3x6', sizeLabel: '3" x 6"', sqft: 1.00, cost: 7.15,
    colors: { 'METRO-361':'Atlas White','METRO-362':'Lapis','METRO-363':'Marina','METRO-364':'Shadow Gray' } },
  { product: 'Zeta',  desc: '2" x 6" Pool Tile', size: '2x6', sizeLabel: '2" x 6"', sqft: 1.00, cost: 8.80,
    colors: { 'ZETA-261':'Ash White','ZETA-262':'Cool Blue','ZETA-263':'Emerald','ZETA-264':'Pacific Blue' } },
];

const round2 = (v) => Math.round(Number(v) * 100) / 100;

async function main() {
  const { rows: skus } = await pool.query(`
    SELECT s.id, s.vendor_sku, s.variant_name, s.sell_by, s.status, s.product_id,
           pr.cost, pr.retail_price, pr.price_basis, pr.retail_locked
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    WHERE p.vendor_id = $1
    ORDER BY s.vendor_sku
  `, [VENDOR_ID]);

  const backup = skus.map(s => ({ ...s }));
  const priceUpdates = [];   // {id, vendor_sku, oldCost, newCost, oldRetail, newRetail}
  const renames = [];        // {id, from, to}
  const discontinued = [];   // {id, vendor_sku, status}
  const unmatchedInactive = [];
  const matchedPdf = new Set();

  for (const s of skus) {
    const flat = FLAT.find(f => s.vendor_sku.startsWith(f.prefix));
    const pdfCode = ALIAS[s.vendor_sku] || s.vendor_sku;
    const pdfCost = flat ? flat.cost : P[pdfCode];

    if (pdfCost == null) {
      if (s.status === 'active' || s.status === 'draft') {
        discontinued.push({ id: s.id, vendor_sku: s.vendor_sku, status: s.status });
      } else {
        unmatchedInactive.push(s.vendor_sku);
      }
      continue;
    }
    if (!flat) matchedPdf.add(pdfCode);

    if (ALIAS[s.vendor_sku]) renames.push({ id: s.id, from: s.vendor_sku, to: ALIAS[s.vendor_sku] });

    if (s.retail_locked) continue;
    const basis = s.price_basis || (s.sell_by === 'unit' ? 'per_unit' : 'per_sqft');
    const newRetail = priceRetail(pdfCost, basis);
    if (round2(s.cost) !== round2(pdfCost) || round2(s.retail_price) !== round2(newRetail)) {
      priceUpdates.push({ id: s.id, vendor_sku: s.vendor_sku, oldCost: s.cost, newCost: pdfCost, oldRetail: s.retail_price, newRetail });
    }
  }

  // PDF codes with no DB row (informational)
  const dbCodes = new Set(skus.map(s => ALIAS[s.vendor_sku] || s.vendor_sku));
  const newFamilyCodes = new Set(NEW_FAMILIES.flatMap(f => Object.keys(f.colors)));
  const pdfMissing = Object.keys(P).filter(c => !dbCodes.has(c) && !newFamilyCodes.has(c));

  console.log(`Fujiwa SKUs in DB: ${skus.length}`);
  console.log(`\nPrice updates: ${priceUpdates.length}`);
  for (const u of priceUpdates) {
    console.log(`  ${u.vendor_sku.padEnd(22)} cost ${String(u.oldCost).padStart(7)} -> ${String(u.newCost).padStart(7)}   retail ${String(u.oldRetail).padStart(8)} -> ${String(u.newRetail).padStart(8)}`);
  }
  console.log(`\nVendor-SKU renames to official codes: ${renames.length}`);
  for (const r of renames) console.log(`  ${r.from}  ->  ${r.to}`);
  console.log(`\nDiscontinued (will set inactive): ${discontinued.length}`);
  for (const d of discontinued) console.log(`  ${d.vendor_sku} (${d.status})`);
  console.log(`\nAlready-inactive SKUs not on new list (left as-is): ${unmatchedInactive.length}`);
  console.log(`  ${unmatchedInactive.join(', ')}`);
  console.log(`\nOn PDF but not in DB (not being added): ${pdfMissing.join(', ') || 'none'}`);
  console.log(`\nNew families to add: ${NEW_FAMILIES.map(f => f.product).join(', ')} (${NEW_FAMILIES.reduce((n,f) => n + Object.keys(f.colors).length, 0)} SKUs)`);

  if (!APPLY) {
    console.log('\nDRY RUN — re-run with --apply to commit.');
    await pool.end();
    return;
  }

  const backupName = `fujiwa-update-backup-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.json`;
  let backupPath = path.join(__dirname, '..', 'data', backupName);
  try {
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  } catch (e) {
    // data/ isn't writable in the prod container (owned by a different uid)
    backupPath = path.join(os.tmpdir(), backupName);
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  }
  console.log(`\nBackup written: ${backupPath}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const u of priceUpdates) {
      await client.query(
        `UPDATE pricing SET cost = $2, retail_price = $3 WHERE sku_id = $1`,
        [u.id, u.newCost, u.newRetail]
      );
    }
    for (const r of renames) {
      await client.query(
        `UPDATE skus SET vendor_sku = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [r.id, r.to]
      );
    }
    for (const [vsku, vname] of Object.entries(VARIANT_NAME_FIX)) {
      await client.query(
        `UPDATE skus SET variant_name = $2, updated_at = CURRENT_TIMESTAMP
         WHERE vendor_sku IN ($1, $3) AND product_id IN (SELECT id FROM products WHERE vendor_id = $4)`,
        [vsku, vname, ALIAS[vsku] || vsku, VENDOR_ID]
      );
    }
    for (const d of discontinued) {
      await client.query(
        `UPDATE skus SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [d.id]
      );
    }

    // Reactivate HEX-10 (White Matte) — still on the list; siblings HEX-20..50 active
    await client.query(
      `UPDATE skus SET status = 'active', updated_at = CURRENT_TIMESTAMP
       WHERE vendor_sku = 'HEX-10' AND product_id IN (SELECT id FROM products WHERE vendor_id = $1)`,
      [VENDOR_ID]
    );

    // New families
    for (const fam of NEW_FAMILIES) {
      const { rows: [prod] } = await client.query(`
        INSERT INTO products (vendor_id, brand_id, name, collection, category_id, status, description_short)
        VALUES ($1, $2, $3, 'Pool Tile', $4, 'active', $5)
        ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `, [VENDOR_ID, BRAND_ID, fam.product, CAT_POOL, fam.desc]);

      for (const [code, color] of Object.entries(fam.colors)) {
        const { rows: [sku] } = await client.query(`
          INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, status)
          VALUES ($1, $2, $3, $4, 'sqft', 'wall_tile', 'active')
          ON CONFLICT (internal_sku) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
          RETURNING id
        `, [prod.id, code, `FUJIWA-${code}`, fam.sizeLabel]);
        await client.query(`
          INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
          VALUES ($1, $2, $3, 'per_sqft')
          ON CONFLICT (sku_id) DO UPDATE SET cost = EXCLUDED.cost, retail_price = EXCLUDED.retail_price
        `, [sku.id, fam.cost, priceRetail(fam.cost, 'per_sqft')]);
        await client.query(`
          INSERT INTO packaging (sku_id, sqft_per_box) VALUES ($1, $2)
          ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box = EXCLUDED.sqft_per_box
        `, [sku.id, fam.sqft]);
        const attrs = [[ATTR.Color, color], [ATTR.Size, fam.size], [ATTR.Material, 'Ceramic'], [ATTR.Brand, 'Fujiwa']];
        for (const [attrId, value] of attrs) {
          await client.query(`
            INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
            ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
          `, [sku.id, attrId, value]);
        }
        console.log(`  + ${code} (${fam.product} · ${color})`);
      }
    }

    await client.query('COMMIT');
    console.log('\nAPPLIED.');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
