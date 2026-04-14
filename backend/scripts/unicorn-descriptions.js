#!/usr/bin/env node
/**
 * Generate long descriptions for Unicorn Tile products
 */
import pg from 'pg';
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const products = await pool.query(`
  SELECT p.id, p.name, p.collection, c.name as category,
    (SELECT array_agg(DISTINCT sa.value ORDER BY sa.value)
     FROM skus s2 JOIN sku_attributes sa ON sa.sku_id = s2.id
     JOIN attributes a ON a.id = sa.attribute_id
     WHERE s2.product_id = p.id AND a.slug = 'size' AND s2.variant_type != 'accessory') as sizes,
    (SELECT array_agg(DISTINCT sa.value ORDER BY sa.value)
     FROM skus s2 JOIN sku_attributes sa ON sa.sku_id = s2.id
     JOIN attributes a ON a.id = sa.attribute_id
     WHERE s2.product_id = p.id AND a.slug = 'color' AND s2.variant_type != 'accessory') as colors,
    (SELECT COUNT(*)::int FROM skus s2 WHERE s2.product_id = p.id AND s2.variant_type = 'accessory') as acc_skus
  FROM products p
  JOIN vendors v ON v.id = p.vendor_id
  JOIN categories c ON c.id = p.category_id
  WHERE v.code = 'UNICORN'
  ORDER BY p.collection, p.name
`);

const catInfo = {
  'Porcelain Tile': {
    material: 'porcelain',
    desc: 'Dense, kiln-fired porcelain with extremely low water absorption',
    uses: 'floors, walls, showers, and outdoor applications',
    durability: 'Highly scratch-resistant, frost-proof, and easy to maintain',
  },
  'Ceramic Tile': {
    material: 'ceramic',
    desc: 'Glazed ceramic with a smooth, refined surface',
    uses: 'walls, backsplashes, bathroom surrounds, and accent installations',
    durability: 'Easy to cut, install, and clean with lasting color retention',
  },
  'Mosaic Tile': {
    material: 'mosaic',
    desc: 'Precision-cut mosaic pieces mounted on mesh backing for easy installation',
    uses: 'backsplashes, shower floors, accent walls, and decorative borders',
    durability: 'Durable and versatile with consistent spacing for professional results',
  },
};

const finishWords = new Set(['Matte', 'Polished', 'Glossy', 'Honed', 'Satin', 'Lappato']);

let updated = 0;
for (const p of products.rows) {
  const brand = p.collection;
  const cat = catInfo[p.category] || catInfo['Porcelain Tile'];
  const sizes = (p.sizes || []).join(', ');
  const colors = (p.colors || []).filter(c => !finishWords.has(c));
  const colorStr = colors.length > 0 ? colors.join(', ') : '';

  let desc = `The ${p.name} collection by ${brand} is a premium ${cat.material} tile series designed for both residential and commercial spaces. ${cat.desc}, the ${p.name} delivers exceptional quality and timeless aesthetics.`;

  if (sizes && colorStr) {
    desc += ` Available in ${sizes} format${p.sizes.length > 1 ? 's' : ''}, the collection comes in ${colorStr} tones to suit a range of design visions.`;
  } else if (sizes) {
    desc += ` Available in ${sizes} format${p.sizes.length > 1 ? 's' : ''} to suit a range of design visions.`;
  } else if (colorStr) {
    desc += ` The collection comes in ${colorStr} tones to suit a range of design visions.`;
  }

  desc += ` Ideal for ${cat.uses}. ${cat.durability}.`;

  if (p.acc_skus > 0) {
    desc += ` Matching trim pieces and accessories are available for a polished, finished installation.`;
  }

  await pool.query('UPDATE products SET description_long = $1 WHERE id = $2', [desc, p.id]);
  updated++;
  console.log(`  ${p.name}: ${desc.substring(0, 100)}...`);
}

console.log(`\nUpdated ${updated} product descriptions`);
await pool.end();
