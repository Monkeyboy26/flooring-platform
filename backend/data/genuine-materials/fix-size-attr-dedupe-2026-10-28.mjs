/**
 * Fix: vendor 710 (Genuine Materials / Sintera) `size` attribute restates the
 * entire variant_name and only adds a fabrication note, e.g.
 *   variant_name = '108" x 26" x 3/4" Prefab'
 *   size attr    = '108" x 26" x 3/4" Prefab (2" miter)'
 * so the format block ("… Prefab") renders twice (PDP title + Size spec row, and
 * on older builds that append the size attr, inside the title itself:
 *   "… Playa Bahamas 108\" x 26\" x 3/4\" Prefab 108\" x 26\" x 3/4\" Prefab (2\" miter)")
 *
 * Normalize the `size` attribute to pure physical dimensions (+ any "(… miter)"
 * note), dropping the format word that already lives in variant_name. Consistent
 * with the slab convention (variant_name "Jumbo Slab", size "127x64x3/4").
 *   '108" x 26" x 3/4" Prefab (2" miter)'  -> '108" x 26" x 3/4" (2" miter)'
 *   '127" x 64" x 3/4" Jumbo Slab'         -> '127" x 64" x 3/4"'
 *   '120" x 55" Standard Slab'             -> '120" x 55"'
 *
 * Idempotent. Backs up changed rows to sku_attributes_gm_size_backup_20261028.
 * DRY RUN unless APPLY=1.
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const APPLY = process.env.APPLY === '1';
const VENDOR_CODE = '710';
const BACKUP = 'sku_attributes_gm_size_backup_20261028';

// Strip the standalone format descriptor that is already carried by variant_name.
// Capitalized multi/single-word forms only, so a lowercase note like "(2 per slab)"
// is never touched. Collapse the whitespace the removal leaves behind.
function cleanSize(v) {
  if (typeof v !== 'string') return v;
  let out = v.replace(/\s*\b(Jumbo Slab|Standard Slab|Prefab)\b/g, '');
  out = out.replace(/\s{2,}/g, ' ').replace(/\s+\)/g, ')').trim();
  return out;
}

async function main() {
  const { rows } = await pool.query(`
    SELECT sa.sku_id, sa.attribute_id, sa.value, s.vendor_sku
    FROM sku_attributes sa
    JOIN attributes a ON a.id = sa.attribute_id AND a.slug = 'size'
    JOIN skus s ON s.id = sa.sku_id
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id AND v.code = $1
    WHERE sa.value ~ '(Prefab|Jumbo Slab|Standard Slab)'
    ORDER BY s.vendor_sku
  `, [VENDOR_CODE]);

  const changes = rows
    .map(r => ({ ...r, next: cleanSize(r.value) }))
    .filter(r => r.next !== r.value);

  console.log(`Vendor ${VENDOR_CODE}: ${rows.length} size attrs with a format word, ${changes.length} need change.`);
  const distinct = new Map();
  for (const c of changes) distinct.set(c.value, c.next);
  for (const [from, to] of distinct) console.log(`  "${from}"  ->  "${to}"`);

  if (!changes.length) { await pool.end(); return; }
  if (!APPLY) { console.log('\nDRY RUN — set APPLY=1 to write.'); await pool.end(); return; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS ${BACKUP} (sku_id uuid, attribute_id uuid, old_value text, new_value text, backed_up_at timestamptz DEFAULT now())`);
    for (const c of changes) {
      await client.query(`INSERT INTO ${BACKUP} (sku_id, attribute_id, old_value, new_value) VALUES ($1,$2,$3,$4)`,
        [c.sku_id, c.attribute_id, c.value, c.next]);
      await client.query(`UPDATE sku_attributes SET value=$3 WHERE sku_id=$1 AND attribute_id=$2`,
        [c.sku_id, c.attribute_id, c.next]);
    }
    await client.query('COMMIT');
    console.log(`\nAPPLIED ${changes.length} updates. Backup -> ${BACKUP}.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
