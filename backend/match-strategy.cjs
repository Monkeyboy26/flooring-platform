const { Pool } = require('pg');
const XLSX = require('xlsx');

const pool = new Pool({ host: 'db', port: 5432, user: 'postgres', password: 'postgres', database: 'flooring_pim' });

async function main() {
  const wb = XLSX.readFile('/tmp/az-porcelain.xlsx');
  const ws = wb.Sheets['Sheet1 (1)'];
  const plRows = XLSX.utils.sheet_to_json(ws);

  // Strategy: match by normalized product name + size + finish
  // DB names like "Bianco Carrara" with attrs size="12 X 12" finish="Honed"
  // PL names like "Carrara White Honed Marble Tile 12x12"

  // Get all DB SKUs with their attrs
  const dbResult = await pool.query(`
    SELECT s.id, s.variant_name, p.name, p.collection,
      MAX(CASE WHEN a.slug = 'size' THEN sa.value END) as size,
      MAX(CASE WHEN a.slug = 'finish' THEN sa.value END) as finish
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
    LEFT JOIN attributes a ON a.id = sa.attribute_id AND a.slug IN ('size', 'finish')
    WHERE v.name ILIKE '%arizona%' AND s.status = 'active'
    GROUP BY s.id, s.variant_name, p.name, p.collection
  `);

  // Normalize size for matching: "12 X 12" → "12x12", "Approximately 12x12" → "12x12"
  function normSize(s) {
    if (!s) return '';
    return s.toLowerCase().replace(/approximately\s*/i, '').replace(/["\s]+/g, '').replace(/x/g, 'x');
  }
  function normName(s) {
    if (!s) return '';
    // Remove common suffixes and normalize
    return s.toLowerCase()
      .replace(/\s+(marble|porcelain|limestone|travertine|granite|quartzite)\s+(tile|mosaic|slab|liner).*/i, '')
      .replace(/["']/g, '')
      .trim();
  }

  // Build PL lookup: normalized name → { code, finish, size, packaging }
  // Need to handle: "Carrara White Honed Marble Tile 12x12" where "Honed" is the finish
  const plLookup = {};
  for (const pl of plRows) {
    const rawName = pl['PRODUCT NAME'] || '';
    const plFinish = (pl['FINISH'] || '').toLowerCase();
    const plSize = normSize(pl['SIZE (Inch)'] || '');
    const baseName = normName(rawName);

    // Remove finish from base name for matching
    const nameNoFinish = baseName.replace(new RegExp('\\b' + plFinish + '\\b', 'i'), '').replace(/\s+/g, ' ').trim();

    const key = `${nameNoFinish}|${plSize}|${plFinish}`;
    plLookup[key] = pl;
  }

  // Now try matching DB SKUs
  // Known name mappings based on Arizona Tile's naming conventions
  const NAME_MAP = {
    'bianco carrara': 'carrara white',
    'bianco venatino': 'carrara venetino bianco',
    'crema marfil': 'crema marfil',
    'calacatta gold': 'calacata gold',
    'absolute black': 'absolute black',
    'thassos white': 'thassos white',
    'white dolomite': 'white dolomite',
  };

  let matched = 0, total = 0;
  for (const db of dbResult.rows) {
    total++;
    const dbName = (db.name || '').toLowerCase();
    const dbSize = normSize(db.size);
    const dbFinish = (db.finish || '').toLowerCase();

    // Try direct match
    let key = `${dbName}|${dbSize}|${dbFinish}`;
    let pl = plLookup[key];

    // Try with collection prefix
    if (!pl && db.collection && db.collection.toLowerCase() !== dbName) {
      key = `${db.collection.toLowerCase()} ${dbName}|${dbSize}|${dbFinish}`;
      pl = plLookup[key];
    }

    // Try with name mapping
    if (!pl) {
      const mappedName = NAME_MAP[dbName];
      if (mappedName) {
        key = `${mappedName}|${dbSize}|${dbFinish}`;
        pl = plLookup[key];
      }
    }

    if (pl) {
      matched++;
      if (matched <= 10) {
        console.log(`MATCH: DB "${db.name} ${db.size} ${db.finish}" ↔ PL "${pl['PRODUCT NAME']}"`);
        console.log(`  sqft/box=${pl['SqftPER Box']||'-'} pcs/box=${pl['Pieces Per Box']||'-'} sqft/pc=${pl['SqftPER Piece']||'-'} soldBy=${pl['Sold By']}`);
      }
    }
  }

  console.log(`\nMatched: ${matched}/${total}`);

  // Show some unmatched DB names to see what's missing
  console.log('\n=== Some unmatched DB product names ===');
  const unmatchedNames = new Set();
  for (const db of dbResult.rows) {
    const dbName = (db.name || '').toLowerCase();
    const dbSize = normSize(db.size);
    const dbFinish = (db.finish || '').toLowerCase();
    let key = `${dbName}|${dbSize}|${dbFinish}`;
    if (!plLookup[key] && !plLookup[`${NAME_MAP[dbName]}|${dbSize}|${dbFinish}`]) {
      if (!unmatchedNames.has(dbName)) {
        unmatchedNames.add(dbName);
        if (unmatchedNames.size <= 15) console.log(`  "${db.name}" (${db.finish}, ${db.size})`);
      }
    }
  }

  // Show some PL names that weren't matched
  console.log('\n=== Some pricelist names (for building name map) ===');
  const plNames = new Set();
  for (const pl of plRows) {
    const base = normName(pl['PRODUCT NAME'] || '');
    const plFinish = (pl['FINISH'] || '').toLowerCase();
    const nameNoFinish = base.replace(new RegExp('\\b' + plFinish + '\\b', 'i'), '').replace(/\s+/g, ' ').trim();
    if (!plNames.has(nameNoFinish)) {
      plNames.add(nameNoFinish);
    }
  }
  console.log([...plNames].sort().slice(0, 30).join('\n'));

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
