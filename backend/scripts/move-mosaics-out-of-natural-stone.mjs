/**
 * Move mosaics out of Natural Stone — 2026-08-30.
 *
 * The Natural Stone browse grid was surfacing mosaic cards two ways:
 *
 *  1. Six products whose sellable SKUs are (almost) all mosaic sheets sat in
 *     natural-stone: Bedrosians Monet marble mosaics (×3, 10/13 mosaic SKUs +
 *     deco/trim), Bedrosians hexagon-sheet wall lines "Crema Marfil Select" /
 *     "White Carrara" (Wall), and Emser "Opuscar Pebbles Honed" (Pebb/12x12
 *     pebble sheets). These move to mosaic-tile. Matches current scraper logic
 *     (bed.js mosaic-shape override, emser-catalog pebble→mosaic route), so a
 *     re-scrape agrees rather than reverts.
 *
 *  2. 27 Daltile mixed marble/limestone lines carry a STALE display_name suffix
 *     "… Mosaic Tile" — fix-daltile-product-info.cjs appended the then-current
 *     category suffix, and the products were later (correctly) recategorized to
 *     natural-stone. They are field-tile-majority lines, so they STAY in
 *     natural-stone and the suffix is rewritten to the category convention
 *     ("… Natural Stone"). Their mosaic SKUs remain as PDP variants.
 *
 *  3. Bedrosians marble line "Calacatta" (natural-stone, field-tile majority)
 *     displays as "Calacatta Chevron" — a stale disambiguator that reads as a
 *     mosaic card. Renamed to "Calacatta Marble" (plain "Calacatta" is taken by
 *     four other BED porcelain lines; "Marble" survives bed.js reconcile, which
 *     only strips TYPE_SUFFIXES like "Mosaic Tile").
 *
 * DRY RUN by default; pass EXECUTE=1 to write. Idempotent. Backup JSON written
 * alongside backend/data/ before any write.
 */
import pg from 'pg';
import fs from 'fs';

const EXECUTE = process.env.EXECUTE === '1';
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});

// Exact (vendor code, product name) pairs — resolved by name so the same script
// runs unchanged against prod. All must currently sit in natural-stone.
const MOVES = [
  ['BED', 'Monet Nero Marquina'],
  ['BED', 'Monet Oriental White'],
  ['BED', 'Monet White Carrara'],
  ['BED', 'Crema Marfil Select'],  // display "Crema Marfil Select Wall" — only box SKU is the 10.5x12 hexagon sheet
  ['BED', 'White Carrara'],        // display "White Carrara Wall" — hexagon + mosaic sheets
  ['EMS', 'Opuscar Pebbles Honed'],
];

async function main() {
  const { rows: cats } = await pool.query(
    `SELECT id, slug FROM categories WHERE slug IN ('natural-stone','mosaic-tile')`);
  const catId = Object.fromEntries(cats.map(c => [c.slug, c.id]));

  // ── Part 1: recategorize mosaic-dominant products → mosaic-tile ──
  const { rows: movers } = await pool.query(`
    SELECT pr.id, v.code, pr.name, pr.display_name, c.slug AS cat
    FROM products pr
    JOIN vendors v ON v.id = pr.vendor_id
    JOIN categories c ON c.id = pr.category_id
    WHERE (v.code, pr.name) IN (${MOVES.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(',')})
      AND c.slug = 'natural-stone'
    ORDER BY v.code, pr.name`, MOVES.flat());

  // ── Part 2: fix stale Daltile "… Mosaic Tile" display suffixes ──
  const { rows: renames } = await pool.query(`
    SELECT pr.id, pr.name, pr.display_name
    FROM products pr
    JOIN vendors v ON v.id = pr.vendor_id
    JOIN categories c ON c.id = pr.category_id
    WHERE v.code = 'DAL' AND c.slug = 'natural-stone' AND pr.status = 'active'
      AND pr.display_name LIKE '% Mosaic Tile'
    ORDER BY pr.display_name`);

  // ── Part 3: BED "Calacatta" marble line displays as "Calacatta Chevron" ──
  const { rows: bedCalacatta } = await pool.query(`
    SELECT pr.id, pr.name, pr.display_name
    FROM products pr
    JOIN vendors v ON v.id = pr.vendor_id
    JOIN categories c ON c.id = pr.category_id
    WHERE v.code = 'BED' AND c.slug = 'natural-stone' AND pr.status = 'active'
      AND pr.name = 'Calacatta' AND pr.display_name = 'Calacatta Chevron'`);

  console.log(`Movers → mosaic-tile (${movers.length}):`);
  for (const m of movers) console.log(`  ${m.code}  ${m.name}  (display: ${m.display_name || '—'})`);
  console.log(`\nDaltile display-suffix fixes (${renames.length}):`);
  for (const r of renames) console.log(`  ${r.display_name}  →  ${r.display_name.replace(/ Mosaic Tile$/, ' Natural Stone')}`);
  console.log(`\nBED Calacatta display rename (${bedCalacatta.length}):`);
  for (const b of bedCalacatta) console.log(`  ${b.display_name}  →  Calacatta Marble`);

  if (!EXECUTE) { console.log('\nDRY RUN — pass EXECUTE=1 to write.'); await pool.end(); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = { movers, renames, bedCalacatta };
  // repo root cwd locally; /app (= backend/) inside the api container on prod
  const dataDir = fs.existsSync('backend/data') ? 'backend/data' : 'data';
  const backupPath = `${dataDir}/mosaics-out-of-natural-stone-backup-${stamp}.json`;
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\nBackup: ${backupPath}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (movers.length) {
      const { rowCount } = await client.query(
        `UPDATE products SET category_id = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ANY($2) AND category_id = $3`,
        [catId['mosaic-tile'], movers.map(m => m.id), catId['natural-stone']]);
      console.log(`Recategorized ${rowCount} products → mosaic-tile`);
    }
    if (renames.length) {
      const { rowCount } = await client.query(
        `UPDATE products
         SET display_name = regexp_replace(display_name, ' Mosaic Tile$', ' Natural Stone'),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ANY($1) AND display_name LIKE '% Mosaic Tile'`,
        [renames.map(r => r.id)]);
      console.log(`Fixed ${rowCount} Daltile display names`);
    }
    if (bedCalacatta.length) {
      const { rowCount } = await client.query(
        `UPDATE products SET display_name = 'Calacatta Marble', updated_at = CURRENT_TIMESTAMP
         WHERE id = ANY($1) AND display_name = 'Calacatta Chevron'`,
        [bedCalacatta.map(b => b.id)]);
      console.log(`Renamed ${rowCount} BED Calacatta display`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
