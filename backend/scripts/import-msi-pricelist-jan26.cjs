/**
 * MSI Price List Import — Jan 2026 VDL XLSB
 *
 * Reads the dealer pricelist, matches to existing MSI SKUs,
 * and upserts pricing + packaging data.
 */
const XLSX = require('xlsx');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const FILE = '/app/data/msi-pricelist-jan26.xlsb';

async function run() {
  // Step 1: Parse the Excel file
  console.log(`Reading ${FILE}...`);
  const workbook = XLSX.readFile(FILE);
  console.log(`Sheets: ${workbook.SheetNames.join(', ')}`);

  // Try to find the right sheet
  const sheetName = workbook.SheetNames.find(n => /price/i.test(n)) || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  console.log(`Sheet "${sheetName}": ${rawRows.length} raw rows`);

  // Step 2: Find header row
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rawRows.length, 30); i++) {
    const row = rawRows[i];
    if (row && row.some(cell => String(cell).toUpperCase().includes('ITEM NUMBER'))) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    // Fallback: try to find any row with "ITEM" or "SKU"
    for (let i = 0; i < Math.min(rawRows.length, 30); i++) {
      const row = rawRows[i];
      if (row && row.some(cell => /\b(ITEM|SKU|PRODUCT)\b/i.test(String(cell)))) {
        headerIdx = i;
        break;
      }
    }
  }

  if (headerIdx === -1) {
    // Dump first 15 rows to understand structure
    console.log('\nCould not find header row. First 15 rows:');
    for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
      console.log(`  Row ${i}: ${JSON.stringify(rawRows[i]?.slice(0, 10))}`);
    }
    process.exit(1);
  }

  const headers = rawRows[headerIdx].map(h => String(h || '').trim().toUpperCase());
  console.log(`Header row ${headerIdx + 1}: ${headers.join(' | ')}`);

  // Build column index
  const col = {};
  headers.forEach((h, i) => {
    if (h.includes('ITEM NUMBER') || h.includes('ITEM #') || h === 'ITEM' || h === 'SKU') col.itemNumber = i;
    else if (h.includes('DESCRIPTION') || h.includes('PRODUCT NAME')) col.description = i;
    else if (h.includes('PRODUCT COLLECTION') || h === 'COLLECTION') col.collection = i;
    else if (h === 'SQFT PER PIECE' || h.includes('SQ FT PER PIECE') || h.includes('SQFT/PC')) col.sqftPerPiece = i;
    else if (h === 'PIECES PER BOX' || h.includes('PCS PER BOX') || h.includes('PCS/BOX') || h.includes('PC PER BOX')) col.piecesPerBox = i;
    else if (h === 'SQFT PER BOX' || h.includes('SQ FT PER BOX') || h.includes('SQFT/BOX')) col.sqftPerBox = i;
    else if (h === 'U/M' || h === 'UOM' || h === 'UNIT') col.uom = i;
    else if (h === 'PRICE/UOM' || h === 'PRICE / UOM') col.price = i;
    else if (h === 'PRICE/EACH') col.priceEach = i;
    else if (h === 'PRICE/BOX') col.priceBox = i;
    else if (h.includes('DEALER') && h.includes('PRICE')) col.price = i;
    else if (h.includes('VDL') || h.includes('COST')) { if (col.price == null) col.price = i; }
    else if (h === 'STATUS') col.status = i;
    else if (h.includes('LIST') && h.includes('PRICE')) col.listPrice = i;
    else if (h.includes('RETAIL') || h.includes('MSRP')) col.retail = i;
  });

  // If no PRICE/UOM found, fall back to PRICE/EACH, then any PRICE column
  if (col.price == null && col.priceEach != null) col.price = col.priceEach;
  if (col.price == null) {
    headers.forEach((h, i) => {
      if (h.includes('PRICE') && col.price == null) col.price = i;
    });
  }

  console.log(`Column mapping: ${JSON.stringify(col)}`);

  if (col.itemNumber == null) {
    console.error(`Could not locate ITEM NUMBER column. Headers: ${headers.join(', ')}`);
    process.exit(1);
  }

  // Step 3: Parse data rows
  const dataRows = [];
  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!row) continue;

    const itemNumber = String(row[col.itemNumber] || '').trim();
    if (!itemNumber || itemNumber.length < 3) continue;

    // Skip non-active
    if (col.status != null) {
      const status = String(row[col.status] || '').trim().toLowerCase();
      if (status && status !== 'active' && status !== 'new' && status !== '') continue;
    }

    const costRaw = col.price != null ? row[col.price] : null;
    const cost = costRaw != null ? parseFloat(costRaw) : NaN;

    const retailRaw = col.retail != null ? row[col.retail] : (col.listPrice != null ? row[col.listPrice] : null);
    const retail = retailRaw != null ? parseFloat(retailRaw) : NaN;

    if ((isNaN(cost) || cost <= 0) && (isNaN(retail) || retail <= 0)) continue;

    const uom = col.uom != null ? String(row[col.uom] || '').trim().toUpperCase() : '';
    const priceBasis = (uom === 'SQFT' || uom === 'SF' || uom === 'S/F' || uom === 'SQ FT') ? 'per_sqft' : 'per_unit';

    dataRows.push({
      itemNumber,
      description: col.description != null ? String(row[col.description] || '').trim() : '',
      collection: col.collection != null ? String(row[col.collection] || '').trim() : '',
      cost: isNaN(cost) ? 0 : cost,
      retail: isNaN(retail) ? 0 : retail,
      priceBasis,
      sqftPerPiece: col.sqftPerPiece != null ? parseFloat(row[col.sqftPerPiece]) || null : null,
      piecesPerBox: col.piecesPerBox != null ? parseFloat(row[col.piecesPerBox]) || null : null,
      sqftPerBox: col.sqftPerBox != null ? parseFloat(row[col.sqftPerBox]) || null : null,
    });
  }

  console.log(`\nParsed ${dataRows.length} valid price rows`);

  // Sample entries
  console.log('\nSample entries:');
  for (const e of dataRows.slice(0, 8)) {
    console.log(`  ${e.itemNumber} | ${e.collection} | cost=$${e.cost} retail=$${e.retail} ${e.priceBasis} | ${e.sqftPerBox || '-'} sqft/box`);
  }

  // Step 4: Load existing MSI SKUs
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'MSI'");
  const vendorId = vendorRes.rows[0].id;

  const skuResult = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, p.is_active
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.vendor_sku IS NOT NULL
  `, [vendorId]);

  const skuMap = new Map();
  for (const row of skuResult.rows) {
    skuMap.set(row.vendor_sku.toUpperCase(), { skuId: row.sku_id, active: row.is_active });
  }
  console.log(`\nLoaded ${skuMap.size} MSI SKUs from DB`);

  // Step 5: Match and upsert
  let matched = 0, unmatched = 0, pricingUpdated = 0, packagingUpdated = 0;
  const unmatchedSamples = [];

  for (const entry of dataRows) {
    const lookup = skuMap.get(entry.itemNumber.toUpperCase());

    if (!lookup) {
      unmatched++;
      if (unmatchedSamples.length < 20) {
        unmatchedSamples.push(`${entry.itemNumber} (${entry.collection || entry.description})`);
      }
      continue;
    }

    matched++;
    const skuId = lookup.skuId;

    // Determine retail price: use retail from file, else 2x cost
    const costVal = parseFloat(entry.cost) || 0;
    let retailVal = parseFloat(entry.retail) || 0;
    if (retailVal <= 0 && costVal > 0) {
      retailVal = Math.round(costVal * 2 * 100) / 100;
    }

    // Upsert pricing
    try {
      await pool.query(`
        INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (sku_id)
        DO UPDATE SET cost = $2, retail_price = $3, price_basis = $4
      `, [skuId, costVal, retailVal, entry.priceBasis]);
      pricingUpdated++;
    } catch (err) {
      console.error(`  Pricing error for ${entry.itemNumber}: ${err.message}`);
    }

    // Upsert packaging
    if (entry.sqftPerBox || entry.piecesPerBox) {
      try {
        await pool.query(`
          INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box)
          VALUES ($1, $2, $3)
          ON CONFLICT (sku_id)
          DO UPDATE SET
            sqft_per_box = COALESCE($2, packaging.sqft_per_box),
            pieces_per_box = COALESCE($3, packaging.pieces_per_box)
        `, [skuId, entry.sqftPerBox, entry.piecesPerBox]);
        packagingUpdated++;
      } catch (err) {
        console.error(`  Packaging error for ${entry.itemNumber}: ${err.message}`);
      }
    }
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Excel rows parsed:  ${dataRows.length}`);
  console.log(`Matched to DB SKUs: ${matched}`);
  console.log(`Unmatched:          ${unmatched}`);
  console.log(`Pricing updated:    ${pricingUpdated}`);
  console.log(`Packaging updated:  ${packagingUpdated}`);

  if (unmatchedSamples.length > 0) {
    console.log(`\nUnmatched samples (first ${unmatchedSamples.length}):`);
    for (const u of unmatchedSamples) console.log(`  ${u}`);
  }

  // Check remaining unpriced
  const unpriced = await pool.query(`
    SELECT COUNT(*) AS cnt
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    WHERE p.vendor_id = $1 AND p.is_active = true AND (pr.cost IS NULL OR pr.cost = 0)
  `, [vendorId]);
  console.log(`\nMSI SKUs still unpriced: ${unpriced.rows[0].cnt}`);

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
