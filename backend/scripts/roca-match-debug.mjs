/**
 * Debug matching between portal product names and DB products
 */
import pg from 'pg';
const pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });

function normalizeForMatch(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseProductKey(title) {
  let clean = title
    .replace(/_F\d+_\d+X\d+$/i, '')
    .replace(/ F\d+$/i, '')
    .replace(/\s*\(\d+\)\s*$/i, '')
    .replace(/_\d+X\d+$/i, '')
    .trim();
  return clean;
}

async function go() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'ROCA'");
  const vendorId = vendorRes.rows[0].id;

  // Get products needing images
  const dbProducts = await pool.query(`
    SELECT p.id as product_id, p.name, p.collection
    FROM products p
    JOIN skus s ON s.product_id = p.id
    LEFT JOIN media_assets ma ON ma.product_id = p.id AND ma.asset_type = 'primary'
    WHERE p.vendor_id = $1 AND ma.id IS NULL
    GROUP BY p.id, p.name, p.collection
    ORDER BY p.collection, p.name
  `, [vendorId]);

  console.log(`DB products needing images: ${dbProducts.rowCount}`);

  // Group by collection
  const byCol = new Map();
  for (const p of dbProducts.rows) {
    if (!byCol.has(p.collection)) byCol.set(p.collection, []);
    byCol.get(p.collection).push(p.name);
  }
  console.log(`\nDB collections needing images:`);
  for (const [col, names] of [...byCol].sort((a,b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${col}: ${names.join(', ')}`);
  }

  // Now check portal categories
  const BASE = 'https://marketing-assets.rocatileusa.com';
  const portalCats = {
    'ABACO': 230, 'ABBEY': 56, 'AGATA': 62, 'ALASKA': 329, 'ALLURE': 347,
    'ATHEA': 332, 'ATHOS': 338, 'AVENUE': 350, 'AVALON': 299,
    'BALTIC': 357, 'BIANCO VENATINO': 359, 'BOHEME': 361, 'BLOCK': 381,
    'BRECCIA': 426, 'CALACATA': 427, 'CARRARA': 464, 'CASABLANCA': 477,
    'COLONIAL': 527, 'CONCRETE': 540, 'CRYSTAL': 558, 'DERBY': 562,
    'DOWNTOWN': 658, 'ESSENCE': 719, 'EVERGLADE': 742, 'FIRE': 760,
    'FIORITO': 1519, 'FOSSIL': 800, 'FULMINE': 797, 'GRAN CALACATA': 790,
    'HAVANNA': 757, 'INFINITY': 856, 'IRON': 853, 'JEWELS': 803,
    'JUNE': 859, 'KORONIS': 893, 'KRONOS': 909, 'LAGOM': 925,
    'LASSA WHITE': 940, 'LEGNO ROVERE': 959, 'LEGEND': 960,
    'LITHOLOGY': 962, 'LIVERPOOL': 961, 'MAIOLICA': 1121,
    'MARBLE DOLOMITA': 1167, 'MARBLE LASSA': 1161, 'MARBLE LINCOLN': 1147,
    'MARBLE NOUVEAU': 1185, 'MARBLE PLATINUM': 1182, 'MAYNE': 1195,
    'NERO CARESSI': 1200, 'NERO MARQUINA': 1201, 'NOLITA': 1202,
    'NORDICO': 1242, 'NORTHWOOD': 1240, 'NUAGE': 1252,
    'OLD FASHIONES': 1269, 'OLYMPIA': 1270, 'ONICE SUPREME': 1271,
    'ONYX': 1272, 'ONYX WHITE': 1273, 'PANTHEON': 1295, 'PARANA': 1302,
    'PATAGONIA': 1309, 'PAVERS': 1312, 'PETR GREY': 1372,
    'PIASENTINA': 1373, 'PORT NOIR': 1374, 'POSITANO': 1407, 'PRO': 1408,
    'PRO MAX': 1493, 'PULPIS INTENSO': 1492, 'ROSSO LEPANTO': 1491,
    'SAHARA NOIR': 1483, 'SAINT TROPEZ': 1485, 'SAVOY': 1487,
    'SEGESTA': 1490, 'SERENA': 1934, 'SERPENTINO': 1577,
    'STATUARIO': 1591, 'STATUARY': 1595, 'STONE BASEL': 1616,
    'TAJ MAHAL': 1618, 'TEMPESTA': 1619, 'TERRANOVA': 1620,
    'TOPAZIO': 1706, 'TREVI': 1703, 'UNIQUE GROUND': 1705,
    'VENATO': 1704, 'WESTON': 1739, 'ZEBRINO': 1740, 'ZEN STONE': 1741,
  };

  // Match portal categories to DB collections
  console.log('\n\nPortal → DB collection matching:');
  let matchedCats = 0;
  let unmatchedCats = [];
  for (const portalCat of Object.keys(portalCats)) {
    const normPortal = normalizeForMatch(portalCat);
    let match = null;
    for (const dbCol of byCol.keys()) {
      const normDB = normalizeForMatch(dbCol);
      if (normDB === normPortal) match = dbCol;
      else if (normPortal.includes(normDB) || normDB.includes(normPortal)) {
        if (Math.min(normDB.length, normPortal.length) / Math.max(normDB.length, normPortal.length) > 0.7)
          match = dbCol;
      }
    }
    if (match) {
      matchedCats++;
      console.log(`  ✓ ${portalCat} → ${match} (${byCol.get(match)?.length} products)`);
    } else {
      unmatchedCats.push(portalCat);
    }
  }
  console.log(`\nMatched: ${matchedCats}/${Object.keys(portalCats).length}`);
  console.log(`Unmatched portal categories: ${unmatchedCats.join(', ')}`);

  // Show DB collections with no portal match
  const unmatchedDB = [];
  for (const dbCol of byCol.keys()) {
    const normDB = normalizeForMatch(dbCol);
    let matched = false;
    for (const portalCat of Object.keys(portalCats)) {
      const normPortal = normalizeForMatch(portalCat);
      if (normDB === normPortal || normPortal.includes(normDB) || normDB.includes(normPortal)) {
        matched = true;
        break;
      }
    }
    if (!matched) unmatchedDB.push(dbCol);
  }
  console.log(`\nDB collections with NO portal match (${unmatchedDB.length}):`);
  for (const col of unmatchedDB) console.log(`  ${col}: ${byCol.get(col)?.join(', ')}`);

  await pool.end();
}
go().catch(console.error);
