const { Pool } = require('pg');
const XLSX = require('xlsx');

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: 5432,
  user: 'postgres',
  password: 'postgres',
  database: 'flooring_pim'
});

async function main() {
  // Load pricelist
  const wb = XLSX.readFile('/tmp/az-porcelain.xlsx');
  const ws = wb.Sheets['Sheet1 (1)'];
  const plRows = XLSX.utils.sheet_to_json(ws);
  console.log(`Loaded ${plRows.length} pricelist rows`);

  // Load all Arizona Tile SKUs from DB with their attributes
  const dbResult = await pool.query(`
    SELECT s.id as sku_id, s.variant_name, s.sell_by, s.product_id,
      p.name as product_name, p.collection,
      pk.sqft_per_box, pk.pieces_per_box
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN packaging pk ON pk.sku_id = s.id
    WHERE v.name ILIKE '%arizona%' AND s.status = 'active'
  `);
  console.log(`Loaded ${dbResult.rows.length} Arizona Tile SKUs from DB`);

  // Load attributes for all Arizona SKUs
  const attrResult = await pool.query(`
    SELECT sa.sku_id, a.slug, sa.value
    FROM sku_attributes sa
    JOIN attributes a ON a.id = sa.attribute_id
    WHERE sa.sku_id IN (
      SELECT s.id FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      WHERE v.name ILIKE '%arizona%' AND s.status = 'active'
    )
    AND a.slug IN ('size', 'finish')
  `);

  const attrMap = {};
  for (const row of attrResult.rows) {
    if (!attrMap[row.sku_id]) attrMap[row.sku_id] = {};
    attrMap[row.sku_id][row.slug] = row.value;
  }

  // Build lookup: normalize name+size+finish → sku_id
  function normalizeKey(name, size, finish) {
    return [name, size, finish]
      .map(s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''))
      .join('|');
  }

  const dbLookup = {};
  for (const row of dbResult.rows) {
    const attrs = attrMap[row.sku_id] || {};
    // Use product_name + size attr + finish attr
    const key = normalizeKey(row.product_name, attrs.size, attrs.finish);
    dbLookup[key] = row;

    // Also try with collection prefix
    if (row.collection && row.collection !== row.product_name) {
      const key2 = normalizeKey(row.collection + ' ' + row.product_name, attrs.size, attrs.finish);
      dbLookup[key2] = row;
    }
  }

  // Now match pricelist rows to DB
  let matched = 0, unmatched = 0, packagingUpdated = 0, pricingUpdated = 0;

  for (const pl of plRows) {
    const plName = pl['PRODUCT NAME'] || '';
    const plSize = pl['SIZE (Inch)'] || '';
    const plFinish = pl['FINISH'] || '';

    const key = normalizeKey(plName, plSize, plFinish);
    // Also try extracting name without size suffix for matching
    // e.g., "Carrara White Honed Marble Tile 12x12" → try matching as "Carrara White" with size "12x12" and finish "Honed"

    let dbRow = dbLookup[key];

    if (!dbRow) {
      // Try alternative: parse product name to extract clean name
      // Pattern: "Carrara White Honed Marble Tile 12x12"
      // We want: name="Carrara White", size="12 X 12", finish="Honed"
      // But Arizona Tile website uses "Bianco Carrara" not "Carrara White"
      // So this matching will be imperfect
      unmatched++;
      continue;
    }

    matched++;

    // Update packaging
    const sqftPerBox = pl['SqftPER Box'] || null;
    const piecesPerBox = pl['Pieces Per Box'] || null;
    const sqftPerPiece = pl['SqftPER Piece'] || null;
    const weightPerBox = pl['WEIGHT PER Box'] || null;
    const boxesPerPallet = pl['BOX / TILE PER PALLET'] || null;
    const sqftPerPallet = pl['Sqft PER PALETT'] || null;
    const weightPerPallet = pl['WEIGHT PER PALLET/LB'] || null;

    if (sqftPerBox || piecesPerBox || sqftPerPiece) {
      // Calculate sqft_per_box from sqft_per_piece if no box data
      const effectiveSqftPerBox = sqftPerBox || (piecesPerBox && sqftPerPiece ? piecesPerBox * sqftPerPiece : null);

      await pool.query(`
        INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs,
          boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (sku_id) DO UPDATE SET
          sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
          pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box),
          weight_per_box_lbs = COALESCE(EXCLUDED.weight_per_box_lbs, packaging.weight_per_box_lbs),
          boxes_per_pallet = COALESCE(EXCLUDED.boxes_per_pallet, packaging.boxes_per_pallet),
          sqft_per_pallet = COALESCE(EXCLUDED.sqft_per_pallet, packaging.sqft_per_pallet),
          weight_per_pallet_lbs = COALESCE(EXCLUDED.weight_per_pallet_lbs, packaging.weight_per_pallet_lbs)
      `, [dbRow.sku_id, effectiveSqftPerBox, piecesPerBox, weightPerBox,
          boxesPerPallet, sqftPerPallet, weightPerPallet]);
      packagingUpdated++;
    }

    // Update sell_by based on pricelist
    const soldBy = (pl['Sold By'] || '').toLowerCase();
    if (soldBy === 'box' && dbRow.sell_by !== 'sqft') {
      // Sold by box — should use box calculator (sell_by stays 'sqft' with packaging data)
    }

    // Update pricing (cost = wholesale price)
    const price = pl['PRICE Sqft/Piece/Sheet'];
    if (price && price > 0) {
      await pool.query(`
        UPDATE pricing SET cost = $1 WHERE sku_id = $2
      `, [price, dbRow.sku_id]);
      pricingUpdated++;
    }
  }

  console.log(`\nResults:`);
  console.log(`  Matched: ${matched}`);
  console.log(`  Unmatched: ${unmatched}`);
  console.log(`  Packaging updated: ${packagingUpdated}`);
  console.log(`  Pricing (cost) updated: ${pricingUpdated}`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
