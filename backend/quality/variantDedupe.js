// Variant-name deduper — the durable fix for `indistinguishable-variants`.
//
// Importers/scrapers routinely build variant_name from color (+finish) only,
// while the axis that actually distinguishes two SKUs (Mannington ADURA
// Flex vs Max sub_line, Tri-West collection, James Martin cabinet config /
// group number) lands in sku_attributes or the vendor_sku and never reaches
// the display name — so customers see two identical cards ("2 SKUs all
// display as ..."). Instead of patching every importer, this pass finds every
// product whose ACTIVE SKUs collide on lower(variant_name) and appends the
// highest-priority attribute that actually differs within the colliding
// group. SKUs a chosen attribute can't split fall back to the vendor_sku
// (always unique). Wired into the nightly quality cron (server.js) ahead of
// the audit, and runnable standalone via scripts/dedupe-variant-names.mjs.
//
// Idempotent: once names differ the collision query no longer returns them.

// Display-worthy distinguishers, most meaningful first. Deliberately excludes
// color (it IS the typical variant name), and non-display data (upc, msrp,
// weight, brand, material_class, soft_close).
const PRIORITY = [
  'sub_line', 'series', 'style', 'num_drawers', 'num_doors', 'num_sinks',
  'group_number', 'style_code', 'width', 'depth', 'height', 'collection',
  'color_code', 'pattern', 'finish', 'thickness', 'size',
  // Last resort before the raw vendor_sku: JMV vanities that differ only by
  // which countertop package ships (F vs 3 SKU codes) carry distinct top refs.
  'top_ref_sku',
];

const MAX_LEN = 120;

function formatValue(slug, value) {
  const v = String(value).trim();
  switch (slug) {
    case 'num_drawers': return `${v} Drawer${v === '1' ? '' : 's'}`;
    case 'num_doors': return `${v} Door${v === '1' ? '' : 's'}`;
    case 'num_sinks': return v === '1' ? 'Single Sink' : v === '2' ? 'Double Sink' : `${v} Sinks`;
    case 'width': return `${v}" W`;
    case 'depth': return `${v}" D`;
    case 'height': return `${v}" H`;
    case 'group_number': return `Group ${v}`;
    case 'top_ref_sku': return `Top ${v}`;
    default: return v;
  }
}

function appendSegment(name, segment) {
  const base = (name || '').trim();
  if (!base) return segment.slice(0, MAX_LEN);
  // Don't echo a value the name already carries ("Walnut, Walnut").
  if (base.toLowerCase().includes(segment.toLowerCase())) return base;
  return `${base}, ${segment}`.slice(0, MAX_LEN);
}

/**
 * @returns {Promise<{groups: number, renamed: Array, skuFallback: Array}>}
 */
export async function runVariantDedupe(pool, { apply = false, vendorId = null } = {}) {
  // Colliding active SKUs, grouped per product + display name.
  const { rows: members } = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, s.variant_name, s.vendor_sku,
           v.code AS vendor_code, p.name AS product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE s.status = 'active' AND p.status = 'active'
      AND ($1::uuid IS NULL OR p.vendor_id = $1)
      AND (s.product_id, LOWER(COALESCE(s.variant_name, ''))) IN (
        SELECT s2.product_id, LOWER(COALESCE(s2.variant_name, ''))
        FROM skus s2 JOIN products p2 ON p2.id = s2.product_id
        WHERE s2.status = 'active' AND p2.status = 'active'
          AND ($1::uuid IS NULL OR p2.vendor_id = $1)
        GROUP BY 1, 2 HAVING COUNT(*) > 1
      )
    ORDER BY s.product_id, LOWER(COALESCE(s.variant_name, ''))`, [vendorId]);

  if (!members.length) return { groups: 0, renamed: [], skuFallback: [] };

  const { rows: attrRows } = await pool.query(`
    SELECT sa.sku_id, a.slug, sa.value
    FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
    WHERE sa.sku_id = ANY($1) AND a.slug = ANY($2)`,
    [members.map(m => m.sku_id), PRIORITY]);
  const attrsBySku = new Map();
  for (const r of attrRows) {
    if (!attrsBySku.has(r.sku_id)) attrsBySku.set(r.sku_id, {});
    attrsBySku.get(r.sku_id)[r.slug] = r.value;
  }

  // Group members by (product, lower(name)).
  const groups = new Map();
  for (const m of members) {
    const key = `${m.product_id}|${(m.variant_name || '').toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  const renamed = [];   // { sku_id, vendor_code, product_name, from, to, via }
  const skuFallback = [];

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const vals = (slug) => group.map(m => (attrsBySku.get(m.sku_id) || {})[slug]);
    // Prefer an attribute that fully splits the group; else the first that
    // splits it at all (leftover ties fall back to vendor_sku below).
    let chosen = PRIORITY.find(slug => {
      const v = vals(slug);
      return v.every(x => x != null && String(x).trim() !== '')
        && new Set(v.map(x => String(x).trim().toLowerCase())).size === group.length;
    }) || PRIORITY.find(slug =>
      new Set(vals(slug).filter(x => x != null && String(x).trim() !== '')
        .map(x => String(x).trim().toLowerCase())).size >= 2);

    const proposed = new Map(); // sku_id -> new name
    for (const m of group) {
      const val = chosen ? (attrsBySku.get(m.sku_id) || {})[chosen] : null;
      proposed.set(m.sku_id,
        val != null && String(val).trim() !== ''
          ? appendSegment(m.variant_name, formatValue(chosen, val))
          : (m.variant_name || '').trim());
    }
    // Any names still colliding (attr missing or same value) → vendor_sku.
    const seen = new Map();
    for (const m of group) {
      const name = proposed.get(m.sku_id).toLowerCase();
      seen.set(name, (seen.get(name) || 0) + 1);
    }
    for (const m of group) {
      let name = proposed.get(m.sku_id);
      if (seen.get(name.toLowerCase()) > 1 && m.vendor_sku) {
        name = appendSegment(name, `(${m.vendor_sku})`);
        skuFallback.push({ sku_id: m.sku_id, vendor_code: m.vendor_code, product_name: m.product_name });
      }
      if (name !== (m.variant_name || '')) {
        renamed.push({
          sku_id: m.sku_id, vendor_code: m.vendor_code, product_name: m.product_name,
          from: m.variant_name, to: name, via: chosen || 'vendor_sku',
        });
      }
    }
  }

  if (apply && renamed.length) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of renamed) {
        await client.query(
          `UPDATE skus SET variant_name = $2, updated_at = NOW() WHERE id = $1`,
          [r.sku_id, r.to]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return { groups: groups.size, renamed, skuFallback };
}
