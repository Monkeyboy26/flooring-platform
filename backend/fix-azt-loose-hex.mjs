// One-time data fix accompanying the 2026-09-13 loose-hex scraper root fix
// (owner: "Icon Silver Hex from AZT is not a mosaic" / "Jade Mosaics Jade Hex 8
// is an 8-inch tile — review all the incorrect hexes").
//
// The scraper re-run moves loose SF/BX-priced hex SKUs out of their per-piece
// "X Mosaics / X Hex" products into the field-tile products as size variants.
// This script cleans up what the re-run can't:
//   1. Deactivate emptied hex husk products (SKUs moved away) that the
//      orphan-deactivation guard didn't catch.
//   2. Dedupe doubled slugs on the AFFECTED AZT families only
//      (icon-mosaics-icon-silver → icon-mosaics-silver). Storewide legacy
//      doubled slugs are intentionally left alone (URL churn).
//   3. Strip the wrong-variant leading sentence from Icon/Shibusa descriptions
//      ("ICON SMOKE HEX 20 X 24." on Icon Silver etc.).
//
// Idempotent. DRY_RUN=1 to preview.
import pg from 'pg';

const DRY = process.env.DRY_RUN === '1';
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const AFFECTED_COLLECTIONS = [
  'Icon Mosaics', 'Jade Mosaics', 'Basalt Mosaics', 'Basalt Black Mosaics',
  'Sahara Mosaics', 'Shibusa Mosaics', 'Paros Mosaics', 'Spark Mosaics',
  'Calacatta Royale Mosaics', 'Calacatta Umber Mosaics',
  'Dolomite White Mosaics', 'Cotto Toscano Mosaics', 'Oriental White Mosaics',
];

const slugify = (t) => String(t || '').toLowerCase().replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function main() {
  const { rows: [{ id: vendorId }] } = await pool.query(
    `SELECT id FROM vendors WHERE code = 'AZT'`);

  // ── 1. Slug dedupe on affected AZT collections ──
  // (The emptied hex husk products were already deactivated by the scraper's
  // own orphan pass; products with only-draft SKUs are deliberately left alone.)
  const prods = await pool.query(`
    SELECT id, name, collection, slug FROM products
    WHERE vendor_id = $1 AND is_active AND collection = ANY($2) AND slug IS NOT NULL
  `, [vendorId, AFFECTED_COLLECTIONS]);
  for (const p of prods.rows) {
    const colSlug = slugify(p.collection);
    if (!p.slug.startsWith(colSlug + '-')) continue;
    const rest = p.slug.slice(colSlug.length + 1).split('-');
    const colToks = colSlug.split('-');
    let k = 0;
    while (k < rest.length && k < colToks.length && rest[k] === colToks[k]) k++;
    if (k === 0) continue;
    const newSlug = colSlug + (rest.slice(k).length ? '-' + rest.slice(k).join('-') : '');
    if (newSlug === p.slug) continue;
    const clash = await pool.query(
      `SELECT 1 FROM products WHERE slug = $1 AND id <> $2`, [newSlug, p.id]);
    if (clash.rows.length) { console.log(`slug: SKIP (clash) ${p.slug} → ${newSlug}`); continue; }
    console.log(`slug: ${p.slug} → ${newSlug}`);
    if (!DRY) await pool.query(
      `UPDATE products SET slug=$1, updated_at=NOW() WHERE id=$2`, [newSlug, p.id]);
  }

  // ── 3. Strip wrong-variant leading sentence from descriptions ──
  // AZT page descriptions open with one specific variant's name ("ICON SMOKE
  // HEX 20 X 24.", "SHIBUSA CREMA HEX 9 X 11.") and the page smears it across
  // every color. Strip the leading all-caps variant sentence wherever it
  // doesn't match the product's own name.
  const descProds = await pool.query(`
    SELECT id, name, description_short, description_long FROM products
    WHERE vendor_id = $1 AND is_active
      AND (description_short ~ '^[A-Z][A-Z0-9 &X/.-]+ \\d+ ?X ?\\d+\\.'
           OR description_long ~ '^[A-Z][A-Z0-9 &X/.-]+ \\d+ ?X ?\\d+\\.')
  `, [vendorId]);
  const LEAD_RE = /^[A-Z][A-Z0-9 &X/.-]*\d+ ?X ?\d+\.\s*/;
  for (const p of descProds.rows) {
    const lead = (p.description_short || p.description_long || '').match(LEAD_RE)?.[0] || '';
    // keep the sentence when it actually names this product (e.g. "ICON SMOKE
    // HEX…" on Icon Smoke Hex itself)
    const leadKey = lead.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
    const nameKey = p.name.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
    if (nameKey && leadKey.startsWith(nameKey)) continue;
    const ds = (p.description_short || '').replace(LEAD_RE, '').trim() || null;
    const dl = (p.description_long || '').replace(LEAD_RE, '').trim() || null;
    console.log(`desc: ${p.name}: strip "${lead.trim()}"`);
    if (!DRY) await pool.query(
      `UPDATE products SET description_short=$1, description_long=$2, updated_at=NOW() WHERE id=$3`,
      [ds, dl, p.id]);
  }

  // ── 4. Space out fused shape+dims in variant names ──
  // normalizeSize used to eat the space after a shape word ending in "x"
  // ("Hex 20x24" → "Hex20x24"); root-fixed in base.js, this repairs stored rows.
  const fused = await pool.query(`
    SELECT s.id, s.variant_name FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
      AND s.variant_name ~* '^(hex|hexagon|penny|chevron|herringbone|basketweave|picket|rhomboid)[0-9]'
  `, [vendorId]);
  for (const f of fused.rows) {
    const nu = f.variant_name.replace(/^(hex|hexagon|penny|chevron|herringbone|basketweave|picket|rhomboid)(\d)/i, '$1 $2');
    if (nu === f.variant_name) continue;
    console.log(`variant: "${f.variant_name}" → "${nu}"`);
    if (!DRY) await pool.query(
      `UPDATE skus SET variant_name=$1, updated_at=NOW() WHERE id=$2`, [nu, f.id]);
  }

  console.log(DRY ? '(dry run — nothing written)' : 'done');
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
