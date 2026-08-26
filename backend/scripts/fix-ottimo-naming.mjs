/**
 * Fix Ottimo naming (2026-08-22)
 * --------------------------------
 * 1. Applies reviewed per-SKU attribute corrections from
 *    backend/data/ottimo-attr-overrides.json — pulls mosaic chip geometry
 *    (Arc, Offset, Hexagon, Triangle, Rhombus, Picket, Lines, ...) out of the
 *    `color`/`finish` attributes and into the dedicated `pattern` attribute so
 *    `color` becomes the true color.
 * 2. Rebuilds every active Ottimo variant_name to the canonical order:
 *       Color, Finish, Size[, Pattern]
 *    (pattern appended only when present, so mosaic variants stay distinct).
 *
 * Dry-run by default. Pass --apply to commit.
 *
 * Usage:
 *   docker compose exec api node scripts/fix-ottimo-naming.mjs          # preview
 *   docker compose exec api node scripts/fix-ottimo-naming.mjs --apply  # write
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const overrides = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'ottimo-attr-overrides.json'), 'utf-8')
);
delete overrides._comment;

/** Compose the canonical variant label: Color, Finish, Size, Pattern (skip blanks). */
function buildLabel({ color, finish, size, pattern }) {
  return [color, finish, size, pattern]
    .map(v => (v || '').trim())
    .filter(Boolean)
    .join(', ') || null;
}

async function attrId(slug) {
  const r = await pool.query('SELECT id FROM attributes WHERE slug = $1', [slug]);
  if (!r.rows.length) throw new Error(`Missing attribute: ${slug}`);
  return r.rows[0].id;
}

async function setAttr(client, skuId, attributeId, value) {
  const v = (value || '').trim();
  if (!v) {
    await client.query('DELETE FROM sku_attributes WHERE sku_id = $1 AND attribute_id = $2', [skuId, attributeId]);
    return;
  }
  await client.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [skuId, attributeId, v]);
}

async function run() {
  console.log(`\n═══ Fix Ottimo naming ${APPLY ? '(APPLY)' : '(DRY RUN)'} ═══\n`);

  const ATTR = {
    color: await attrId('color'),
    finish: await attrId('finish'),
    size: await attrId('size'),
    pattern: await attrId('pattern'),
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Apply per-SKU attribute overrides ───────────────────────────────
    let applied = 0, missing = [];
    for (const [vendorSku, o] of Object.entries(overrides)) {
      const skuRes = await client.query(`
        SELECT s.id FROM skus s
        JOIN products p ON p.id = s.product_id
        JOIN vendors v ON v.id = p.vendor_id
        WHERE v.code = 'OTT' AND s.vendor_sku = $1 AND s.status = 'active'
      `, [vendorSku]);
      if (!skuRes.rows.length) { missing.push(vendorSku); continue; }
      const skuId = skuRes.rows[0].id;

      await setAttr(client, skuId, ATTR.color, o.color);
      await setAttr(client, skuId, ATTR.finish, o.finish);
      await setAttr(client, skuId, ATTR.pattern, o.pattern);
      applied++;
    }
    console.log(`Attribute overrides applied to ${applied}/${Object.keys(overrides).length} SKUs`);
    if (missing.length) console.log(`  ⚠ not found (active OTT): ${missing.join(', ')}`);

    // ── 1b. Strip finish words baked into `color` (catalog-wide, safe) ───────
    // Matte/Polished/Glossy/Honed/Satin are never colors, so this is
    // unambiguous. Skips SKUs already handled by the override map above.
    // Color → true color; the stripped word populates `finish` if it's empty.
    const FINISH_RE = /\s*\(?\b(matte|polished|glossy|honed|satin)\b\)?/i;
    const overrideSkus = new Set(Object.keys(overrides));
    const colorRows = await client.query(`
      SELECT s.id, s.vendor_sku,
        MAX(CASE WHEN a.slug='color'  THEN sa.value END) AS color,
        MAX(CASE WHEN a.slug='finish' THEN sa.value END) AS finish
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
      LEFT JOIN attributes a ON a.id = sa.attribute_id
      WHERE v.code = 'OTT' AND s.status = 'active'
      GROUP BY s.id, s.vendor_sku
    `);
    let colorCleaned = 0;
    for (const r of colorRows.rows) {
      if (overrideSkus.has(r.vendor_sku) || !r.color) continue;
      const m = r.color.match(FINISH_RE);
      if (!m) continue;
      const word = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
      const cleaned = r.color.replace(FINISH_RE, '').replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
      if (!cleaned || cleaned === r.color) continue; // never blank out the color
      await setAttr(client, r.id, ATTR.color, cleaned);
      if (!r.finish || !r.finish.trim()) await setAttr(client, r.id, ATTR.finish, word);
      colorCleaned++;
    }
    console.log(`Finish stripped from color on ${colorCleaned} SKUs`);

    // ── 2. Rebuild variant_name for every active OTT SKU ────────────────────
    const rows = await client.query(`
      SELECT s.id, s.vendor_sku, s.variant_name,
        MAX(CASE WHEN a.slug='color'   THEN sa.value END) AS color,
        MAX(CASE WHEN a.slug='finish'  THEN sa.value END) AS finish,
        MAX(CASE WHEN a.slug='size'    THEN sa.value END) AS size,
        MAX(CASE WHEN a.slug='pattern' THEN sa.value END) AS pattern
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
      LEFT JOIN attributes a ON a.id = sa.attribute_id
      WHERE v.code = 'OTT' AND s.status = 'active'
      GROUP BY s.id, s.vendor_sku, s.variant_name
      ORDER BY s.vendor_sku
    `);

    let changed = 0;
    const sample = [];
    for (const r of rows.rows) {
      const label = buildLabel(r);
      if (label !== r.variant_name) {
        changed++;
        if (sample.length < 70) sample.push(`  ${r.vendor_sku.padEnd(12)} ${String(r.variant_name).padEnd(34)} →  ${label}`);
        if (APPLY) await client.query('UPDATE skus SET variant_name = $1 WHERE id = $2', [label, r.id]);
      }
    }

    console.log(`\nvariant_name rebuilt: ${changed}/${rows.rows.length} active OTT SKUs changed`);
    if (sample.length) {
      console.log('  ── sample (old → new) ──');
      console.log(sample.join('\n'));
    }

    if (APPLY) { await client.query('COMMIT'); console.log('\n✅ COMMITTED\n'); }
    else { await client.query('ROLLBACK'); console.log('\n(dry run — rolled back; re-run with --apply)\n'); }
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
