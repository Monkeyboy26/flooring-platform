// Strip the leading product-name echo from variant_name so variants stop
// displaying doubled ("Cross — Cross 7x7 Bone, Matte" → "Cross — 7x7 Bone, Matte").
// Idempotent: only strips when variant_name starts with the product name; a
// re-run finds nothing to do. Fixes quality rule `variant-echoes-product`.
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.DB_PASS || 'flooring_pim',
  database: process.env.DB_NAME || 'flooring_pim',
});
const DRY = process.env.DRY_RUN === '1';

const { rows } = await pool.query(`
  SELECT s.id AS sku_id, p.name, s.variant_name
  FROM skus s JOIN products p ON p.id = s.product_id
  JOIN vendors v ON v.id = p.vendor_id
  WHERE s.variant_name IS NOT NULL AND p.status = 'active'
    AND s.status = 'active' AND s.is_sample IS NOT TRUE
    AND (
      LOWER(TRIM(s.variant_name)) = LOWER(TRIM(p.name))
      OR LOWER(s.variant_name) LIKE LOWER(p.name) || ' %'
      OR LOWER(s.variant_name) LIKE LOWER(p.name) || ',%'
    )
`);

let changed = 0;
for (const r of rows) {
  const name = r.name.trim();
  const vn = r.variant_name;
  // Strip leading product name (case-insensitive) + following separator(s).
  const stripped = vn.slice(name.length).replace(/^[\s,]+/, '').trim();
  if (!stripped) { console.log(`SKIP (would be empty): "${vn}" (product "${name}")`); continue; }
  console.log(`"${vn}"  ->  "${stripped}"`);
  if (!DRY) {
    await pool.query('UPDATE skus SET variant_name = $1 WHERE id = $2', [stripped, r.sku_id]);
  }
  changed++;
}
console.log(`\n${DRY ? '[DRY] would update' : 'updated'} ${changed}/${rows.length} SKUs`);
await pool.end();
