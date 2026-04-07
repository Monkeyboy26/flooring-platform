import fs from 'fs';
import XLSX from 'xlsx';
import { upsertPricing, upsertPackaging, appendLog, addJobError } from './base.js';

/**
 * MSI Price List (XLSB/XLSX) ingestion scraper.
 *
 * Parses the MSI dealer price list Excel file (~2,597 rows), extracts
 * item number / pricing / packaging, then matches to existing DB SKUs
 * by vendor_sku (case-insensitive).
 *
 * This scraper does NOT create products — it only upserts pricing and
 * packaging for SKUs already imported by the catalog scraper (msi.js).
 *
 * Expects source.config.pdf_path to point to the uploaded file.
 */
export async function run(pool, job, source) {
  const filePath = source.config && source.config.pdf_path;
  if (!filePath) {
    throw new Error('No file configured. Upload a price list Excel file first.');
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  await appendLog(pool, job.id, `Parsing Excel file: ${filePath}`);

  // Step 1: Parse the Excel file
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames.find(n => /pricelist/i.test(n)) || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  await appendLog(pool, job.id, `Sheet "${sheetName}": ${rawRows.length} raw rows`);

  // Step 2: Find the header row (contains "ITEM NUMBER")
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rawRows.length, 20); i++) {
    const row = rawRows[i];
    if (row && row.some(cell => String(cell).toUpperCase().includes('ITEM NUMBER'))) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    throw new Error('Could not find header row with "ITEM NUMBER" in first 20 rows.');
  }

  const headers = rawRows[headerIdx].map(h => String(h || '').trim().toUpperCase());
  await appendLog(pool, job.id, `Header row ${headerIdx + 1}: ${headers.join(' | ')}`);

  // Build column index from header names
  const col = {};
  headers.forEach((h, i) => {
    if (h.includes('ITEM NUMBER')) col.itemNumber = i;
    else if (h.includes('PRODUCT COLLECTION') || h.includes('COLLECTION')) col.collection = i;
    else if (h === 'SQFT PER PIECE' || h.includes('SQFT PER PIECE')) col.sqftPerPiece = i;
    else if (h === 'PIECES PER BOX' || h.includes('PIECES PER BOX')) col.piecesPerBox = i;
    else if (h === 'SQFT PER BOX' || h.includes('SQFT PER BOX')) col.sqftPerBox = i;
    else if (h === 'U/M' || h === 'UOM') col.uom = i;
    else if (h.includes('PRICE') && h.includes('UOM')) col.price = i;
    else if (h === 'STATUS') col.status = i;
  });

  if (col.itemNumber == null) {
    throw new Error(`Could not locate ITEM NUMBER column. Headers found: ${headers.join(', ')}`);
  }

  await appendLog(pool, job.id, `Column mapping: itemNumber=${col.itemNumber}, uom=${col.uom}, price=${col.price}, sqftPerBox=${col.sqftPerBox}, piecesPerBox=${col.piecesPerBox}, status=${col.status}`);

  // Step 3: Parse data rows (everything after header)
  const dataRows = [];
  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!row) continue;

    const itemNumber = String(row[col.itemNumber] || '').trim();
    if (!itemNumber) continue; // skip category header rows

    // Skip non-active items if status column exists
    if (col.status != null) {
      const status = String(row[col.status] || '').trim().toLowerCase();
      if (status && status !== 'active' && status !== 'new') continue;
    }

    const priceRaw = col.price != null ? row[col.price] : null;
    const cost = priceRaw != null ? parseFloat(priceRaw) : NaN;
    if (isNaN(cost) || cost <= 0) continue;

    const uom = col.uom != null ? String(row[col.uom] || '').trim().toUpperCase() : '';
    const priceBasis = (uom === 'SQFT' || uom === 'SF' || uom === 'S/F') ? 'per_sqft' : 'per_unit';

    const entry = {
      itemNumber,
      collection: col.collection != null ? String(row[col.collection] || '').trim() : '',
      cost,
      priceBasis,
      sqftPerPiece: col.sqftPerPiece != null ? parseFloat(row[col.sqftPerPiece]) || null : null,
      piecesPerBox: col.piecesPerBox != null ? parseFloat(row[col.piecesPerBox]) || null : null,
      sqftPerBox: col.sqftPerBox != null ? parseFloat(row[col.sqftPerBox]) || null : null,
    };
    dataRows.push(entry);
  }

  await appendLog(pool, job.id, `Parsed ${dataRows.length} valid data rows from Excel`);

  if (dataRows.length === 0) {
    throw new Error('No valid price rows found in Excel file. Check format.');
  }

  // Log sample entries
  for (const entry of dataRows.slice(0, 5)) {
    await appendLog(pool, job.id, `  Sample: ${entry.itemNumber} | ${entry.collection} | $${entry.cost} ${entry.priceBasis} | ${entry.sqftPerBox || '-'} sqft/box`);
  }

  // Step 4: Load existing MSI SKUs from DB, index by UPPER(vendor_sku)
  const vendorId = source.vendor_id;
  const skuResult = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.vendor_sku IS NOT NULL
  `, [vendorId]);

  const skuMap = new Map();
  for (const row of skuResult.rows) {
    skuMap.set(row.vendor_sku.toUpperCase(), row.sku_id);
  }
  await appendLog(pool, job.id, `Loaded ${skuMap.size} MSI SKUs from DB for matching`);

  // Step 5: Match and upsert
  let matched = 0;
  let unmatched = 0;
  let pricingUpdated = 0;
  let packagingUpdated = 0;
  const unmatchedItems = [];

  for (const entry of dataRows) {
    const skuId = skuMap.get(entry.itemNumber.toUpperCase());

    if (!skuId) {
      unmatched++;
      if (unmatchedItems.length < 30) {
        unmatchedItems.push(`${entry.itemNumber} (${entry.collection})`);
      }
      continue;
    }

    matched++;

    // Upsert pricing
    try {
      const msiCost = parseFloat(entry.cost) || 0;
      await upsertPricing(pool, skuId, {
        cost: msiCost,
        retail_price: Math.round(msiCost * 2 * 100) / 100,
        price_basis: entry.priceBasis
      });
      pricingUpdated++;
    } catch (err) {
      await addJobError(pool, job.id, `Pricing upsert failed for ${entry.itemNumber}: ${err.message}`);
    }

    // Upsert packaging if we have data
    if (entry.sqftPerBox || entry.piecesPerBox) {
      try {
        await upsertPackaging(pool, skuId, {
          sqft_per_box: entry.sqftPerBox,
          pieces_per_box: entry.piecesPerBox
        });
        packagingUpdated++;
      } catch (err) {
        await addJobError(pool, job.id, `Packaging upsert failed for ${entry.itemNumber}: ${err.message}`);
      }
    }
  }

  // Log unmatched items for debugging
  if (unmatchedItems.length > 0) {
    await appendLog(pool, job.id, `Unmatched items (first ${unmatchedItems.length}):`);
    for (const u of unmatchedItems) {
      await appendLog(pool, job.id, `  ${u}`);
    }
  }

  // Count SKUs still without pricing
  const unpricedResult = await pool.query(`
    SELECT COUNT(*) AS cnt
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    WHERE p.vendor_id = $1 AND (pr.cost IS NULL OR pr.cost = 0)
  `, [vendorId]);
  const unpricedSkus = parseInt(unpricedResult.rows[0].cnt, 10);

  await appendLog(pool, job.id,
    `Complete. Excel rows: ${dataRows.length}, Matched: ${matched}, Unmatched: ${unmatched}, Pricing updated: ${pricingUpdated}, Packaging updated: ${packagingUpdated}, SKUs still unpriced: ${unpricedSkus}`,
    { products_found: dataRows.length, products_updated: pricingUpdated }
  );
}
