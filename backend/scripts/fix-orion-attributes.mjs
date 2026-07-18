/**
 * Populate missing Orion product attributes: Color, Finish, Look, Application, Material.
 *
 * Usage: node backend/scripts/fix-orion-attributes.mjs [--dry-run]
 */
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || 'postgres',
});

const VENDOR_ID = '94dd7078-a068-4ea0-b78b-b0565731e758';
const DRY_RUN = process.argv.includes('--dry-run');

// ── Attribute IDs ──
const ATTR_IDS = {
  color:       'd50e8400-e29b-41d4-a716-446655440001',
  material:    'd50e8400-e29b-41d4-a716-446655440002',
  finish:      'd50e8400-e29b-41d4-a716-446655440003',
  size:        'd50e8400-e29b-41d4-a716-446655440004',
  application: 'd50e8400-e29b-41d4-a716-446655440009',
  thickness:   'd50e8400-e29b-41d4-a716-446655440010',
  look:        'd50e8400-e29b-41d4-a716-446655440012',
  edge:        'd50e8400-e29b-41d4-a716-446655440011',
};

// ── Color mapping (product name → color) ──
// For products whose color isn't in the parsed name
const COLOR_OVERRIDES = {
  '7a101': 'Gray',
  'albany': 'Gray',
  'alpine': 'White',
  'aspen': 'Beige',
  'augusto': 'Gray',
  'bianco superior': 'White',
  'black raj': 'Black',
  'blond': 'Beige',
  'blue eagle': 'Blue',
  'blue forest': 'Blue',
  'boston': 'Gray',
  'brown persa': 'Brown',
  'calacatta': 'White',
  'carrara': 'White',
  'crema roma': 'Cream',
  'dallas': 'Gray',
  'dark rose': 'Brown',
  'delicattus': 'Beige',
  'feline': 'Gray',
  'fusion': 'White',
  'gabana': 'Gray',
  'gery': 'Gray',
  'gold macaubas': 'Gold',
  'houston': 'Brown',
  'jtf962861': 'Gray',
  'jtf962901': 'Gray',
  'jtf98007a01': 'Beige',
  'l01': 'White',
  'l02': 'Gray',
  'l03': 'White',
  'l03m': 'White',
  'l04': 'Gray',
  'l05': 'Beige',
  'l06': 'Brown',
  'l07': 'Black',
  'l08': 'Gray',
  'lunar': 'Gray',
  'matarazzo': 'Brown',
  'matira': 'Gray',
  'matrix': 'Gray',
  'meridian': 'Beige',
  'mountain mist': 'Gray',
  'natural granite': 'Gray',
  'natural terrazzo': 'Gray',
  'nero marquinia': 'Black',
  'nilo': 'Brown',
  'onic': 'White',
  'orinoco': 'Brown',
  'palma': 'Beige',
  'pedre': 'Gray',
  'perla santana': 'Beige',
  'platino': 'Gray',
  'reverse': 'Gray',
  'rigid core': 'Gray',
  'roma': 'Beige',
  'rosso verona': 'Red',
  'ruby fusion': 'Red',
  'sequoia maxi': 'Beige',
  'siberia': 'White',
  'taj mahal': 'Gold',
  'titanium': 'Gray',
  'vancouver': 'White',
  'waterfall': 'White',
  'white paradise': 'White',
};

// ── Finish mapping ──
// Most Orion porcelain tiles are matte unless specified
const POLISHED_PRODUCTS = new Set([
  'bracciano pearl', 'calacatta', 'calacatta black', 'calacatta gold',
  'calacatta da vinci', 'carrara', 'feline', 'feline crystal',
  'fusion', 'gabana', 'gold macaubas', 'labradorite blue',
  'lilac purple', 'lunar', 'lux danae navi', 'marmorea carrara',
  'marmorea verde alpi', 'marvel gray', 'nebulato azul', 'nero marquinia',
  'oni coral super', 'oni pearl super', 'oni white super',
  'quartzito azul', 'ruby fusion', 'serene bianco',
  'star emerald', 'star indigo', 'star purple',
  'super white calacatta', 'taj mahal', 'tempest blue',
]);

const LAPPATO_PRODUCTS = new Set([
  'aeterna grey', 'amazona jade', 'arno azzurro', 'augusto',
  'blue forest', 'crema roma', 'dark rose', 'ekali noir',
  'elegance white', 'gare white gray', 'horton white',
  'illusion snow', 'macauba azul', 'olympia white',
  'pisa gold', 'scarlet black', 'scarlet blle', 'scarlet white',
  'silke blanco', 'silke gris', 'viken beige',
]);

// ── Look mapping ──
const LOOK_MAP = [
  // Specific collections first (longer matches)
  ['natural terrazzo', 'Terrazzo'],
  ['marmette', 'Terrazzo'],
  ['natural granite', 'Granite'],
  ['sequoia maxi', 'Wood'],
  ['cromatic', 'Solid'],
  ['paint ', 'Solid'],
  ['spark blanco', 'Solid'],

  // Wood-look tiles
  ['aspen', 'Wood'], ['au dusk', 'Wood'], ['axe', 'Wood'], ['blond', 'Wood'],
  ['bois de lille', 'Wood'], ['essential', 'Wood'], ['gery', 'Wood'],
  ['heisinki', 'Wood'], ['ikon amber', 'Wood'], ['jet antracita', 'Wood'],
  ['jungle blanco', 'Wood'], ['km blanco', 'Wood'], ['komi noce', 'Wood'],
  ['mukali', 'Wood'], ['neowood', 'Wood'], ['tmg', 'Wood'],
  ['wetwood', 'Wood'], ['multifios', 'Wood'],

  // LVP / SPC vinyl
  ['dallas', 'Wood'], ['houston', 'Wood'], ['7a101', 'Wood'],
  ['jtf', 'Wood'], ['rigid core', 'Wood'],

  // Marble-look
  ['calacatta', 'Marble'], ['carrara', 'Marble'], ['taj mahal', 'Marble'],
  ['bianco superior', 'Marble'], ['statuario', 'Marble'],
  ['marmorea', 'Marble'], ['nero marquinia', 'Marble'],
  ['bracciano', 'Marble'], ['crema roma', 'Marble'],
  ['oni ', 'Marble'], ['serene', 'Marble'], ['siberia', 'Marble'],
  ['super white calacatta', 'Marble'], ['olympia', 'Marble'],
  ['pamesa crema marfil', 'Marble'], ['white paradise', 'Marble'],
  ['elegance white', 'Marble'], ['illusion snow', 'Marble'],
  ['horton white', 'Marble'], ['gare white', 'Marble'],

  // Stone-look
  ['alpine', 'Stone'], ['black raj', 'Stone'], ['brown persa', 'Stone'],
  ['delicattus', 'Stone'], ['gold macaubas', 'Stone'],
  ['labradorite', 'Stone'], ['matarazzo', 'Stone'], ['matira', 'Stone'],
  ['matrix', 'Stone'], ['meridian', 'Stone'], ['mountain mist', 'Stone'],
  ['nilo', 'Stone'], ['orinoco', 'Stone'], ['pedre', 'Stone'],
  ['perla santana', 'Stone'], ['platino', 'Stone'], ['reverse', 'Stone'],
  ['rosso verona', 'Stone'], ['ruby fusion', 'Stone'],
  ['titanium', 'Stone'], ['vancouver', 'Stone'], ['waterfall', 'Stone'],
  ['aurelius', 'Stone'], ['feline', 'Stone'], ['frost cz', 'Stone'],
  ['fusion', 'Stone'], ['gabana', 'Stone'], ['lunar', 'Stone'],
  ['nebulato', 'Stone'], ['quartzito', 'Stone'], ['tempest', 'Stone'],
  ['star ', 'Stone'], ['onic', 'Stone'], ['opus white', 'Stone'],
  ['blue eagle', 'Stone'], ['cristallo', 'Stone'],
  ['gvx desert silver', 'Stone'], ['ete et serena', 'Stone'],
  ['mazero gold', 'Stone'], ['sybil silver', 'Stone'],
  ['pisa gold', 'Stone'], ['dark rose', 'Stone'],
  ['scarlet', 'Stone'], ['lilac purple', 'Stone'],
  ['macauba azul', 'Stone'], ['amazona jade', 'Stone'],
  ['arno azzurro', 'Stone'], ['augusto', 'Stone'],
  ['blue forest', 'Stone'], ['ekali noir', 'Stone'],
  ['lux danae', 'Stone'], ['marvel', 'Stone'],
  ['silke', 'Stone'], ['aeterna', 'Stone'], ['viken', 'Stone'],

  // Concrete/cement-look
  ['albany', 'Concrete'], ['boston', 'Concrete'], ['cf light', 'Concrete'],
  ['montclair', 'Concrete'], ['coreu gris', 'Concrete'],
  ['la blue', 'Concrete'], ['roma', 'Concrete'], ['palma', 'Concrete'],
  ['segesta', 'Concrete'], ['toscana', 'Concrete'], ['astro', 'Concrete'],

  // L-series slabs (varied stone/marble looks)
  ['l01', 'Marble'], ['l02', 'Stone'], ['l03', 'Marble'],
  ['l03m', 'Marble'], ['l04', 'Stone'], ['l05', 'Stone'],
  ['l06', 'Stone'], ['l07', 'Stone'], ['l08', 'Stone'],
];

// ── Application mapping by category ──
const APP_BY_CATEGORY = {
  'Porcelain Tile': 'Floor & Wall',
  'Wood Look Tile': 'Floor & Wall',
  'Porcelain Slabs': 'Countertop',
  'LVP (Plank)': 'Floor',
};

// ── Material corrections ──
const MATERIAL_BY_CATEGORY = {
  'Porcelain Tile': 'Porcelain',
  'Wood Look Tile': 'Porcelain',
  'Porcelain Slabs': 'Sintered Stone',
  'LVP (Plank)': 'SPC Vinyl',
};

function findLook(productName) {
  const lower = productName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const [pattern, look] of LOOK_MAP) {
    if (lower.startsWith(pattern) || lower.includes(pattern)) return look;
  }
  return null;
}

async function main() {
  // Get all Orion products with their current attributes
  const { rows } = await pool.query(`
    SELECT p.id as product_id, p.name, c.name as category,
      s.id as sku_id
    FROM products p
    JOIN categories c ON c.id = p.category_id
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
    ORDER BY p.name, s.id
  `, [VENDOR_ID]);

  console.log(`Processing ${rows.length} Orion SKUs`);
  if (DRY_RUN) console.log('(DRY RUN)\n');

  const stats = { color: 0, finish: 0, look: 0, application: 0, material: 0, edge: 0 };

  for (const row of rows) {
    const nameLower = row.name.toLowerCase();

    // ── Color ──
    const colorOverride = COLOR_OVERRIDES[nameLower];
    if (colorOverride) {
      if (!DRY_RUN) await upsert(row.sku_id, ATTR_IDS.color, colorOverride);
      stats.color++;
    }

    // ── Finish ──
    let finish = 'Matte'; // default for Orion porcelain
    if (POLISHED_PRODUCTS.has(nameLower)) finish = 'Polished';
    else if (LAPPATO_PRODUCTS.has(nameLower)) finish = 'Lappato';
    else if (row.category === 'LVP (Plank)') finish = 'Embossed';
    else if (row.category === 'Porcelain Slabs') finish = 'Polished';
    if (!DRY_RUN) await upsert(row.sku_id, ATTR_IDS.finish, finish);
    stats.finish++;

    // ── Look ──
    const look = findLook(row.name);
    if (look) {
      if (!DRY_RUN) await upsert(row.sku_id, ATTR_IDS.look, look);
      stats.look++;
    }

    // ── Application ──
    const app = APP_BY_CATEGORY[row.category];
    if (app) {
      if (!DRY_RUN) await upsert(row.sku_id, ATTR_IDS.application, app);
      stats.application++;
    }

    // ── Material (fix inconsistent values) ──
    const material = MATERIAL_BY_CATEGORY[row.category];
    if (material) {
      if (!DRY_RUN) await upsert(row.sku_id, ATTR_IDS.material, material);
      stats.material++;
    }

    // ── Edge (all Orion porcelain tiles are rectified) ──
    if (row.category !== 'LVP (Plank)') {
      if (!DRY_RUN) await upsert(row.sku_id, ATTR_IDS.edge, 'Rectified');
      stats.edge++;
    }
  }

  // Fix bad Color value "White , Blue , Gary , Rosé , SALVIA" → individual colors
  if (!DRY_RUN) {
    const { rows: badColors } = await pool.query(`
      SELECT sa.sku_id, s.product_id
      FROM sku_attributes sa
      JOIN skus s ON s.id = sa.sku_id
      JOIN products p ON p.id = s.product_id
      WHERE sa.attribute_id = $1
      AND sa.value LIKE '%,%'
      AND p.vendor_id = $2
    `, [ATTR_IDS.color, VENDOR_ID]);

    for (const bc of badColors) {
      // Get the product name to derive the correct color
      const { rows: [prod] } = await pool.query('SELECT name FROM products WHERE id = $1', [bc.product_id]);
      if (prod) {
        const parts = prod.name.split(' ');
        const color = parts.length > 1 ? parts.slice(1).join(' ') : parts[0];
        await upsert(bc.sku_id, ATTR_IDS.color, color);
        console.log(`  Fixed bad color: "${prod.name}" → "${color}"`);
      }
    }
  }

  console.log('\n── Summary ──');
  console.log(`Color set/updated: ${stats.color}`);
  console.log(`Finish set: ${stats.finish}`);
  console.log(`Look set: ${stats.look}`);
  console.log(`Application set: ${stats.application}`);
  console.log(`Material fixed: ${stats.material}`);
  console.log(`Edge set: ${stats.edge}`);

  await pool.end();
}

async function upsert(skuId, attrId, value) {
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = $3
  `, [skuId, attrId, value]);
}

main().catch(err => { console.error(err); process.exit(1); });
