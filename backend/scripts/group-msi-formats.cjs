/**
 * MSI Format Grouping
 *
 * Many MSI natural-stone looks are split into separate products by FORMAT:
 *   "California Gold"                          (field tile)
 *   "California Gold Ashler Versailles Pattern" (versailles pattern layout)
 *   "California Gold Panel"                     (stacked-stone ledger panel)
 *   "California Gold Mosaic"                    (mosaic sheet)
 *
 * These share no link, so the storefront PDP for the field tile never offers the
 * other formats as variants. The storefront surfaces cross-product format variants
 * via `products.format_group` (see format_siblings in server.js) — a mechanism that
 * is NOT category-scoped, so it can bridge natural-stone tile <-> stacked-stone panel.
 *
 * This script groups each MSI look across its formats by name:
 *   - strips a known format suffix to derive the base look name
 *   - assigns every product in a base group a shared format_group + a format_label
 *     ("Field Tile" / "Versailles Pattern" / "Ledger Panel" / "Mosaic")
 *   - unifies the `color` attribute within each group so the color-faceted filter in
 *     format_siblings doesn't hide a sibling that happens to carry a different color
 *     string (e.g. tile "Multicolor" vs panel "Brown" for the same stone).
 *
 * Idempotent: it first clears every MSI-* format_group it owns, then rebuilds.
 * Wired into the `msi` pipeline so weekly re-imports don't wipe the grouping.
 *
 * A distinct base name (e.g. "New California Gold") naturally forms its own group and
 * is never folded into a different look — the base-name match is exact.
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

// Ordered longest-first: the first suffix that matches wins.
const FORMAT_SUFFIXES = [
  { re: /\s+Ashler\s+Versailles\s+Pattern$/i, label: 'Versailles Pattern' },
  { re: /\s+Versailles\s+Pattern$/i,          label: 'Versailles Pattern' },
  { re: /\s+Ledger\s+Panel$/i,                label: 'Ledger Panel' },
  { re: /\s+Panel$/i,                         label: 'Ledger Panel' },
  { re: /\s+Mosaic$/i,                        label: 'Mosaic' },
];

function classify(name) {
  for (const { re, label } of FORMAT_SUFFIXES) {
    if (re.test(name)) return { base: name.replace(re, '').trim(), label };
  }
  return { base: name.trim(), label: 'Field Tile' };
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function run() {
  const client = await pool.connect();
  try {
    const vend = await client.query("SELECT id FROM vendors WHERE code='MSI'");
    if (!vend.rows.length) { console.log('No MSI vendor'); return; }
    const vendorId = vend.rows[0].id;

    // Reset the format groups this script owns so the run is idempotent and stale
    // groupings (a product renamed/retired between runs) don't linger.
    const reset = await client.query(
      `UPDATE products SET format_group=NULL, format_label=NULL, updated_at=NOW()
       WHERE vendor_id=$1 AND format_group LIKE 'MSI-%'`, [vendorId]);
    console.log(`Cleared ${reset.rowCount} previously-grouped MSI product(s)`);

    const prods = await client.query(
      `SELECT id, name FROM products WHERE vendor_id=$1 AND status='active'`, [vendorId]);

    // Bucket products by base look name.
    const groups = new Map(); // baseKey -> { base, members: [{id,name,label}] }
    for (const p of prods.rows) {
      const { base, label } = classify(p.name);
      const key = slugify(base);
      if (!groups.has(key)) groups.set(key, { base, members: [] });
      groups.get(key).members.push({ id: p.id, name: p.name, label });
    }

    let groupedLooks = 0, groupedProducts = 0, colorFixes = 0;

    for (const [key, g] of groups) {
      // A look only needs grouping when it exists in more than one format.
      const labels = new Set(g.members.map(m => m.label));
      if (g.members.length < 2 || labels.size < 2) continue;

      const formatGroup = `MSI-${key}`;
      for (const m of g.members) {
        await client.query(
          `UPDATE products SET format_group=$1, format_label=$2, updated_at=NOW() WHERE id=$3`,
          [formatGroup, m.label, m.id]);
      }
      groupedLooks++;
      groupedProducts += g.members.length;

      // Unify the color attribute across the group's non-accessory SKUs, so the
      // format_siblings color-faceted filter never hides a format. Anchor on the
      // "Field Tile" product's color when present, else the most common value.
      const memberIds = g.members.map(m => m.id);
      const colorRows = await client.query(
        `SELECT s.id AS sku_id, s.product_id, sa.value
           FROM skus s
           JOIN sku_attributes sa ON sa.sku_id=s.id
           JOIN attributes a ON a.id=sa.attribute_id AND a.slug='color'
          WHERE s.product_id = ANY($1) AND s.status='active' AND s.is_sample=false
            AND COALESCE(s.variant_type,'') <> 'accessory'`, [memberIds]);
      if (colorRows.rows.length > 1) {
        const fieldTileId = g.members.find(m => m.label === 'Field Tile')?.id;
        const counts = new Map();
        for (const r of colorRows.rows) counts.set(r.value, (counts.get(r.value) || 0) + 1);
        let target = null;
        if (fieldTileId) {
          const ft = colorRows.rows.find(r => r.product_id === fieldTileId);
          if (ft) target = ft.value;
        }
        if (!target) target = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

        for (const r of colorRows.rows) {
          if (r.value !== target) {
            await client.query(
              `UPDATE sku_attributes SET value=$1
                 WHERE sku_id=$2 AND attribute_id=(SELECT id FROM attributes WHERE slug='color')`,
              [target, r.sku_id]);
            colorFixes++;
          }
        }
      }

      console.log(`  ${g.base}: ${g.members.map(m => m.label).join(' | ')}`);
    }

    console.log(`\nGrouped ${groupedLooks} MSI look(s) across ${groupedProducts} products; ${colorFixes} color value(s) unified.`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
