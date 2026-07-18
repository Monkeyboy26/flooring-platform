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
const SIZE_ATTR_ID = 'd50e8400-e29b-41d4-a716-446655440004';

// Product name prefix → size from the Orion dealer price list (Q4-2025)
// Sorted longest-first for matching specificity
const SIZE_MAP = [
  // Porcelain tiles
  ['aeterna', '24x48'],
  ['albany', '24x24'],
  ['amazona jade', '24x48'],
  ['arno azzurro', '24x48'],
  ['aspen', '8x48'],
  ['astro', '24x48'],
  ['augusto', '24x48'],
  ['au dusk', '8x48'],
  ['axe', '8x48'],
  ['blond', '8x48'],
  ['blue forest', '24x48'],
  ['bois de lille', '8x48'],
  ['boston', '24x24'],
  ['bracciano', '24x48'],
  ['cf light', '32x32'],
  ['coreu gris', '24x24'],
  ['crema roma', '24x48'],
  ['cromatic black', '24x24'],
  ['cromatic blanco', '24x24'],
  ['dark rose', '24x48'],
  ['ekali noir', '24x48'],
  ['elegance white', '24x48'],
  ['essential', '8x48'],
  ['gare white', '24x48'],
  ['gery', '8x48'],
  ['heisinki', '8x48'],
  ['horton white', '24x48'],
  ['ikon amber', '8x48'],
  ['illusion snow', '24x48'],
  ['jet antracita', '8x48'],
  ['jungle blanco', '8x48'],
  ['km blanco', '8x48'],
  ['komi noce', '8x48'],
  ['la blue grigio', '24x24'],
  ['la blue nero', '24x24'],
  ['labradorite blue', '24x48'],
  ['lilac purple', '24x48'],
  ['lux danae', '24x48'],
  ['macauba azul', '24x48'],
  ['marmette bianco', '24x24'],
  ['marmette jeans', '24x24'],
  ['marmette mix', '24x24'],
  ['marvel', '24x48'],
  ['mazero gold', '24x48'],
  ['montclair blanco', '24x24'],
  ['montclair ivory', '24x24'],
  ['montclair perla', '24x24'],
  ['mukali', '8x48'],
  ['natural terrazzo', '16x16'],
  ['neowood', '8x48'],
  ['olympia white', '24x48'],
  ['oni coral', '24x48'],
  ['oni pearl', '24x48'],
  ['oni white', '24x48'],
  ['paint blue', '24x48'],
  ['paint gray', '24x48'],
  ['paint rose', '24x48'],
  ['paint salvia', '24x48'],
  ['paint white', '24x48'],
  ['palma', '24x48'],
  ['pamesa crema marfil', '24x48'],
  ['pisa gold', '24x48'],
  ['roma', '24x48'],
  ['scarlet black', '24x48'],
  ['scarlet blle', '24x48'],
  ['scarlet white', '24x48'],
  ['segesta ivory', '24x48'],
  ['sequoia maxi', '9x48'],
  ['serene', '24x48'],
  ['silke blanco', '24x48'],
  ['silke gris', '24x48'],
  ['spark blanco', '35x35'],
  ['star emerald', '24x48'],
  ['star indigo', '24x48'],
  ['star purple', '24x48'],
  ['sybil silver', '24x48'],
  ['taj mahal', '24x48'],
  ['toscana', '24x48'],
  ['viken', '24x48'],
  ['wetwood', '7x47'],
  ['tmg', '8x48'],

  // LVP / SPC vinyl
  ['dallas', '7x48'],
  ['houston', '7x48'],
  ['7a101', '7x48'],
  ['jtf962861', '7x48'],
  ['jtf962901', '7x48'],
  ['jtf98007', '7x48'],
  ['rigid core', '7x48'],
];

function normalize(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[""''|()\/\\,\-–—.×&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findSize(productName) {
  const norm = normalize(productName);
  const sorted = [...SIZE_MAP].sort((a, b) => b[0].length - a[0].length);
  for (const [pattern, size] of sorted) {
    if (norm.startsWith(normalize(pattern))) return size;
  }
  return null;
}

async function main() {
  // Get ALL Orion SKUs (update existing + insert missing)
  const { rows } = await pool.query(`
    SELECT s.id as sku_id, p.name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1
    ORDER BY p.name
  `, [VENDOR_ID]);

  console.log(`Found ${rows.length} Orion SKUs`);

  let updated = 0;
  let skipped = 0;
  const missedNames = new Set();

  for (const row of rows) {
    const size = findSize(row.name);
    if (!size) {
      skipped++;
      missedNames.add(row.name);
      continue;
    }

    await pool.query(`
      INSERT INTO sku_attributes (sku_id, attribute_id, value)
      VALUES ($1, $2, $3)
      ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = $3
    `, [row.sku_id, SIZE_ATTR_ID, size]);
    updated++;
  }

  console.log(`\nSizes set: ${updated}`);
  console.log(`Skipped (no size in price list): ${skipped}`);
  if (missedNames.size) {
    console.log('\nProducts without size (slabs — no size in price list):');
    [...missedNames].sort().forEach(n => console.log(`  ${n}`));
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
