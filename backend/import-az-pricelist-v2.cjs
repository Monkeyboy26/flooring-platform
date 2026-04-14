const { Pool } = require('pg');
const XLSX = require('xlsx');

const pool = new Pool({ host: 'db', port: 5432, user: 'postgres', password: 'postgres', database: 'flooring_pim' });

// Known name mappings: website name → pricelist name
const NAME_MAP = {
  'bianco venatino': ['carrara venetino bianco'],
  'calacatta gold': ['calacata gold', 'calacatta gold'],
  'absolute black': ['absolute black'],
  'thassos white': ['thassos white'],
  'white dolomite': ['white dolomite'],
  'negro marquina': ['negro marquina'],
  'crema marfil': ['crema marfil'],
  'emperador dark': ['emperador dark'],
  'emperador light': ['emperador light'],
  'bianco mare': ['bianco mare'],
  'crema vosscione': ['crema vosscione'],
  'beaumaniere': ['beaumaniere'],
};

function normSize(s) {
  if (!s) return '';
  return s.toLowerCase()
    .replace(/approximately\s*/i, '')
    .replace(/aprxmtly\s*/i, '')
    .replace(/["\s]+/g, '')
    .replace(/×/g, 'x');
}

function normName(s) {
  return (s || '').toLowerCase()
    .replace(/\s+(marble|porcelain|limestone|travertine|granite|quartzite|onyx)\s+(tile|mosaic|slab|liner|mercer crown|chair rail).*/i, '')
    .replace(/["'""]/g, '')
    .trim();
}

async function main() {
  // Load both price lists
  const wb = XLSX.readFile('/tmp/az-porcelain.xlsx');

  // Sheet 2 has detailed data with packaging
  const ws2 = wb.Sheets['Sheet1 (1)'];
  const plRows = XLSX.utils.sheet_to_json(ws2);
  console.log(`Loaded ${plRows.length} pricelist rows (detailed sheet)`);

  // Get all Arizona Tile SKUs with attributes
  const dbResult = await pool.query(`
    SELECT s.id as sku_id, s.variant_name, s.sell_by, s.product_id,
      p.name as product_name, p.collection,
      MAX(CASE WHEN a.slug = 'size' THEN sa.value END) as size,
      MAX(CASE WHEN a.slug = 'finish' THEN sa.value END) as finish
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
    LEFT JOIN attributes a ON a.id = sa.attribute_id AND a.slug IN ('size', 'finish')
    WHERE v.name ILIKE '%arizona%' AND s.status = 'active'
    GROUP BY s.id, s.variant_name, s.sell_by, s.product_id, p.name, p.collection
  `);
  console.log(`Loaded ${dbResult.rows.length} Arizona Tile SKUs from DB\n`);

  // Build PL lookup: multiple keys per row for fuzzy matching
  const plByKey = {};
  for (const pl of plRows) {
    const rawName = pl['PRODUCT NAME'] || '';
    const plFinish = (pl['FINISH'] || '').toLowerCase();
    const plSize = normSize(pl['SIZE (Inch)'] || '');
    const baseName = normName(rawName);

    // Remove finish from base name
    const nameNoFinish = baseName.replace(new RegExp('\\b' + plFinish.replace(/[()]/g, '\\$&') + '\\b', 'i'), '').replace(/\s+/g, ' ').trim();

    // Store under both versions
    plByKey[`${nameNoFinish}|${plSize}|${plFinish}`] = pl;
    plByKey[`${baseName}|${plSize}|${plFinish}`] = pl;
    plByKey[`${baseName}|${plSize}|`] = pl; // no finish
  }

  // Match DB SKUs to pricelist
  let matched = 0, packagingUpserted = 0, costUpdated = 0;
  const matchedSkuIds = new Set();

  for (const db of dbResult.rows) {
    const dbName = (db.product_name || '').toLowerCase();
    const dbSize = normSize(db.size);
    const dbFinish = (db.finish || '').toLowerCase();

    let pl = null;

    // Try direct match
    pl = plByKey[`${dbName}|${dbSize}|${dbFinish}`];

    // Try with NAME_MAP
    if (!pl) {
      const mappedNames = NAME_MAP[dbName] || [];
      for (const mn of mappedNames) {
        pl = plByKey[`${mn}|${dbSize}|${dbFinish}`];
        if (pl) break;
        // Also try without finish in the lookup name
        const mnNoFinish = mn.replace(new RegExp('\\b' + dbFinish + '\\b', 'i'), '').trim();
        pl = plByKey[`${mnNoFinish}|${dbSize}|${dbFinish}`];
        if (pl) break;
      }
    }

    // Try with collection + name
    if (!pl && db.collection) {
      const collName = `${db.collection.toLowerCase()} ${dbName}`;
      pl = plByKey[`${collName}|${dbSize}|${dbFinish}`];
    }

    if (!pl) continue;
    matched++;
    matchedSkuIds.add(db.sku_id);

    // Extract packaging data
    const sqftPerBox = parseFloat(pl['SqftPER Box']) || null;
    const piecesPerBox = parseInt(pl['Pieces Per Box']) || null;
    const sqftPerPiece = parseFloat(pl['SqftPER Piece']) || null;
    const weightPerBox = parseFloat(pl['WEIGHT PER Box']) || null;
    const boxesPerPallet = parseInt(pl['BOX / TILE PER PALLET']) || null;
    const sqftPerPallet = parseFloat(pl['Sqft PER PALETT']) || null;
    const weightPerPallet = parseFloat(pl['WEIGHT PER PALLET/LB']) || null;
    const weightPerPiece = parseFloat(pl['WEIGHT PER Piece(LB)']) || null;

    const hasPkgData = sqftPerBox || piecesPerBox || sqftPerPiece;

    if (hasPkgData) {
      // For tiles sold by piece (not box), create "box" of 1 so calculator works
      const effectiveSqftPerBox = sqftPerBox || sqftPerPiece || null;
      const effectivePcsPerBox = piecesPerBox || (sqftPerPiece ? 1 : null);
      const effectiveWeightPerBox = weightPerBox || weightPerPiece || null;

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
      `, [db.sku_id, effectiveSqftPerBox, effectivePcsPerBox, effectiveWeightPerBox,
          boxesPerPallet, sqftPerPallet, weightPerPallet]);
      packagingUpserted++;
    }

    // Update cost (wholesale price)
    const cost = parseFloat(pl['PRICE Sqft/Piece/Sheet']);
    if (cost > 0) {
      const res = await pool.query(`UPDATE pricing SET cost = $1 WHERE sku_id = $2`, [cost, db.sku_id]);
      if (res.rowCount > 0) costUpdated++;
    }
  }

  console.log(`Results:`);
  console.log(`  Matched: ${matched}/${dbResult.rows.length} SKUs`);
  console.log(`  Packaging upserted: ${packagingUpserted}`);
  console.log(`  Cost updated: ${costUpdated}`);

  // Show some matches for verification
  console.log('\nSample matches:');
  let shown = 0;
  for (const db of dbResult.rows) {
    if (!matchedSkuIds.has(db.sku_id)) continue;
    if (shown++ >= 5) break;
    console.log(`  ${db.product_name} ${db.size||''} ${db.finish||''}`);
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
