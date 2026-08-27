/**
 * goton-mosaics-to-accessories.mjs
 *
 * Reclassifies Goton mosaic SKUs that currently render as separate size-variant PILLS
 * (blank variant_type, mosaic-named, inside a product that also has field tiles) into
 * variant_type='accessory' so they show in the PDP "Matching Accessories" section
 * instead. Sets a tidy accessory_label (e.g. "Porcelain Mosaic 2x2"). Mosaic-ONLY
 * products (glass mosaics) are untouched. Reversible.
 *
 *   node backend/scripts/goton-mosaics-to-accessories.mjs            # dry run
 *   node backend/scripts/goton-mosaics-to-accessories.mjs --commit   # apply
 */
import pg from 'pg';
const COMMIT = process.argv.includes('--commit');
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const MOSAIC_RE = 'mosaic|hexagon|herringbone|chevron|basketweave';
// target set: Goton, active, mosaic-named, blank variant_type, in a product that also
// has ≥1 non-mosaic field SKU (so we don't gut mosaic-only products)
const TARGET = `
  s.status='active'
  AND p.vendor_id=(SELECT id FROM vendors WHERE code='GOT')
  AND s.variant_name ~* '${MOSAIC_RE}'
  AND (s.variant_type IS NULL OR s.variant_type='')
  AND EXISTS (
    SELECT 1 FROM skus f WHERE f.product_id=p.id AND f.status='active'
      AND (f.variant_type IS NULL OR f.variant_type='')
      AND f.variant_name !~* '${MOSAIC_RE}')`;
// tidy label: from the (optional material +) mosaic keyword to end
const LABEL = `substring(s.variant_name from '(?i)((?:Porcelain |Glass |Ceramic |Stone )?(?:Mosaic|Hexagon|Herringbone|Chevron|Basketweave).*)$')`;

console.log(`=== Goton mosaics → accessories — ${COMMIT ? 'COMMIT' : 'DRY RUN'} ===`);
const { rows: sample } = await pool.query(`
  SELECT p.name, s.variant_name, ${LABEL} AS label
  FROM skus s JOIN products p ON p.id=s.product_id WHERE ${TARGET} ORDER BY p.name LIMIT 12`);
const { rows: [cnt] } = await pool.query(`
  SELECT COUNT(*) n, COUNT(DISTINCT p.id) prods
  FROM skus s JOIN products p ON p.id=s.product_id WHERE ${TARGET}`);
console.log(`Target: ${cnt.n} mosaic SKUs across ${cnt.prods} products`);
console.log('Sample (variant_name → accessory_label):');
sample.forEach(r => console.log(`  ${r.name}: "${r.variant_name}" → "${r.label}"`));

if (!COMMIT) { console.log('\nDry run — re-run with --commit to apply.'); await pool.end(); process.exit(0); }

const res = await pool.query(`
  UPDATE skus s SET variant_type='accessory',
    accessory_label = COALESCE(${LABEL}, 'Mosaic')
  FROM products p
  WHERE s.product_id=p.id AND ${TARGET}
  RETURNING s.id`);
console.log(`Reclassified ${res.rowCount} SKUs to accessory`);

// Link each mosaic accessory to its same-product, same-COLOR-attribute field SKUs so
// it shows in the PDP "Matching Accessories" (served from sku_accessories, color-matched).
// The generic link-sibling script keys color off the variant_name (incl. size), which
// doesn't work for Goton's naming — so match on the clean color attribute here.
const link = await pool.query(`
  INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
  SELECT field.id, mos.id, 50
  FROM skus mos
  JOIN products p ON p.id=mos.product_id
  JOIN sku_attributes mca ON mca.sku_id=mos.id AND mca.attribute_id=(SELECT id FROM attributes WHERE slug='color')
  JOIN skus field ON field.product_id=mos.product_id AND field.status='active'
    AND COALESCE(field.variant_type,'')='' AND field.variant_name !~* '${MOSAIC_RE}'
  JOIN sku_attributes fca ON fca.sku_id=field.id AND fca.attribute_id=mca.attribute_id AND fca.value=mca.value
  WHERE p.vendor_id=(SELECT id FROM vendors WHERE code='GOT')
    AND mos.status='active' AND mos.variant_type='accessory'
    AND mos.variant_name ~* '${MOSAIC_RE}'
  ON CONFLICT (parent_sku_id, accessory_sku_id) DO NOTHING`);
console.log(`Linked mosaic accessories → field SKUs: ${link.rowCount} new sku_accessories rows`);
// refresh search vectors for affected products
const { rows: prods } = await pool.query(`
  SELECT DISTINCT p.id FROM products p WHERE p.vendor_id=(SELECT id FROM vendors WHERE code='GOT')`);
for (const r of prods) await pool.query('SELECT refresh_search_vectors($1)', [r.id]).catch(()=>{});
console.log(`Refreshed search vectors (${prods.length} products)`);
await pool.end();
console.log('=== done ===');
