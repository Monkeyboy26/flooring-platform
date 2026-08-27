// Conformance backfill — 2026-08-26
// Fixes the deterministic buckets surfaced by the quality rules engine
// (backend/quality/). Run with --dry-run first; a JSON backup of every touched
// row is written before applying.
//
//   node fix-conformance-backfill-2026-08.mjs --dry-run
//   node fix-conformance-backfill-2026-08.mjs --apply
//
// Fix 1: pricing.price_basis label normalization
//        'sqft' -> 'per_sqft', 'unit' -> 'per_unit',
//        NULL   -> inferred from sell_by (box=per_sqft, unit=per_unit, roll=per_sqyd)
//        Guard: box+NULL only inferred when retail looks like a sqft rate (< $60).
// Fix 2: skus.sell_by 'sqft' -> 'box' where price_basis=per_sqft and
//        packaging.sqft_per_box > 0 (coverage calc works). No-packaging rows left open.
// Fix 3: Emser product names — strip glued color-abbreviation chains
//        ("Spectra Matte Bo/Ce/Ho/Na" -> "Spectra Matte"); colors live in variants.
// Fix 4: variant_name recomposition for indistinguishable sibling SKUs —
//        append whitelisted attributes that DIFFER within the duplicate group
//        (finish, size, ...) in canonical order. Groups with no differing
//        whitelisted attr are left open for manual review (e.g. JMV top styles).

import fs from 'fs';
import { pool } from './db.js';

const APPLY = process.argv.includes('--apply');
const backup = { fix1_basis: [], fix2_sellby: [], fix3_emser_names: [], fix4_variant_names: [] };

// Canonical append order mirrors the "Color, Finish, Size, Pattern" convention.
const ATTR_ORDER = ['color', 'finish', 'size', 'pattern', 'species', 'thickness',
  'wear_layer', 'countertop_finish', 'edge', 'dimensions', 'width', 'depth', 'height'];

const log = (...a) => console.log(...a);

async function fix1() {
  const { rows } = await pool.query(`
    SELECT pr.sku_id, pr.price_basis, pr.retail_price, s.sell_by
    FROM pricing pr JOIN skus s ON s.id = pr.sku_id
    WHERE pr.price_basis IN ('sqft', 'unit')
       OR (pr.price_basis IS NULL AND s.sell_by IN ('box', 'unit', 'roll'))
  `);
  const updates = [];
  for (const r of rows) {
    let next = null;
    if (r.price_basis === 'sqft') next = 'per_sqft';
    else if (r.price_basis === 'unit') next = 'per_unit';
    else if (r.price_basis === null) {
      if (r.sell_by === 'unit') next = 'per_unit';
      else if (r.sell_by === 'roll') next = 'per_sqyd';
      else if (r.sell_by === 'box' && parseFloat(r.retail_price || 0) < 60) next = 'per_sqft';
    }
    if (next) updates.push({ sku_id: r.sku_id, from: r.price_basis, to: next });
  }
  log(`Fix 1 (price_basis labels): ${updates.length} rows` +
    ` (sqft->per_sqft: ${updates.filter(u => u.from === 'sqft').length},` +
    ` unit->per_unit: ${updates.filter(u => u.from === 'unit').length},` +
    ` null inferred: ${updates.filter(u => u.from === null).length};` +
    ` skipped box+null high-price: ${rows.length - updates.length})`);
  if (!APPLY) return;
  backup.fix1_basis = updates;
  for (const batchStart of range(updates.length, 1000)) {
    const chunk = updates.slice(batchStart, batchStart + 1000);
    await pool.query(`
      UPDATE pricing pr SET price_basis = u.to_basis
      FROM (SELECT UNNEST($1::uuid[]) AS sku_id, UNNEST($2::text[]) AS to_basis) u
      WHERE pr.sku_id = u.sku_id
    `, [chunk.map(u => u.sku_id), chunk.map(u => u.to)]);
  }
}

async function fix2() {
  const { rows } = await pool.query(`
    SELECT s.id AS sku_id, s.internal_sku, s.sell_by
    FROM skus s
    JOIN pricing pr ON pr.sku_id = s.id
    JOIN packaging pk ON pk.sku_id = s.id
    WHERE s.sell_by = 'sqft' AND pr.price_basis IN ('per_sqft', 'sqft') AND pk.sqft_per_box > 0
  `);
  log(`Fix 2 (sell_by sqft->box, packaging present): ${rows.length} rows`);
  if (!APPLY) return;
  backup.fix2_sellby = rows.map(r => ({ sku_id: r.sku_id, internal_sku: r.internal_sku, from: 'sqft', to: 'box' }));
  await pool.query(`
    UPDATE skus SET sell_by = 'box', updated_at = CURRENT_TIMESTAMP
    WHERE id = ANY($1)
  `, [rows.map(r => r.sku_id)]);
}

// Strip color-abbreviation chains (Bo/Ce/Ho/Na, "Al Na Sk Gr Ca Rd") from
// Emser product names — but ONLY when the chain's 2-letter tokens actually
// prefix-match the product's variant color names. This spares tool/accessory
// names where similar-looking chains are compatibility specs ("Dv/Dc/Ds/Dx
// Bridge Saws" = saw model families).
function extractChains(name) {
  const chains = [];
  for (const m of name.matchAll(/\b[A-Za-z]{2}(?:\/[A-Za-z]{2}){2,}\b/g)) {
    chains.push({ text: m[0], tokens: m[0].split('/') });
  }
  for (const m of name.matchAll(/(?:^|\s)((?:[A-Z][a-z]?\s+){2,}[A-Z][a-z]?)(?=\s|$)/g)) {
    chains.push({ text: m[1], tokens: m[1].trim().split(/\s+/) });
  }
  return chains;
}

async function fix3() {
  const { rows } = await pool.query(`
    SELECT p.id, p.name,
      ARRAY(
        SELECT DISTINCT sa.value FROM skus s
        JOIN sku_attributes sa ON sa.sku_id = s.id
        JOIN attributes a ON a.id = sa.attribute_id
        WHERE s.product_id = p.id AND a.slug = 'color'
      ) AS colors
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'EMS' AND p.status = 'active'
      AND (p.name ~ '\\m[A-Za-z]{2}(/[A-Za-z]{2}){2,}\\M' OR p.name ~ '( [A-Z][a-z]?){3}( |$)')
  `);
  const updates = [];
  let skipped = 0;
  for (const r of rows) {
    const colorPrefixes = new Set(r.colors.flatMap(c =>
      c.toLowerCase().split(/[\s/-]+/).map(w => w.slice(0, 2))));
    let next = r.name;
    for (const chain of extractChains(r.name)) {
      const matched = chain.tokens.filter(t => colorPrefixes.has(t.toLowerCase().slice(0, 2))).length;
      if (chain.tokens.length && matched / chain.tokens.length >= 0.7) {
        next = next.replace(chain.text, ' ');
      }
    }
    // Sweep a dangling 2-letter color token left adjacent to a removed chain
    // ("Infinity Mosaic On Wh/Be/Na" — "On" is Onyx).
    next = next.replace(/\s{2,}/g, ' ').trim();
    const dangling = next.match(/\s([A-Z][a-z])$/);
    if (dangling && colorPrefixes.has(dangling[1].toLowerCase())) {
      next = next.slice(0, -3).trim();
    }
    if (next !== r.name && next.length >= 4) updates.push({ id: r.id, from: r.name, to: next });
    else skipped++;
  }

  // Color-split sibling products ("...Co/Go/Si/Br" + "...Fo/Ma/Vi/Ye") land on
  // the SAME stripped name — the (vendor, collection, name) unique constraint
  // forbids that, and they're really one product split by color group. Merge:
  // keeper = most SKUs; move skus + media over, delete the empty shell.
  const meta = await pool.query(`
    SELECT p.id, p.collection, (SELECT COUNT(*) FROM skus s WHERE s.product_id = p.id)::int AS sku_count
    FROM products p WHERE p.id = ANY($1)
  `, [updates.map(u => u.id)]);
  const metaById = new Map(meta.rows.map(m => [m.id, m]));
  const byTarget = new Map();
  for (const u of updates) {
    const key = `${metaById.get(u.id)?.collection || ''}|${u.to.toLowerCase()}`;
    if (!byTarget.has(key)) byTarget.set(key, []);
    byTarget.get(key).push(u);
  }
  const renames = [];
  const merges = [];
  for (const [key, group] of byTarget.entries()) {
    // A clean-named product may ALREADY exist (Emser splits color groups off a
    // main product) — then the chain-named ones merge into it, no rename needed.
    const [collection] = key.split('|');
    const targetName = group[0].to;
    const existing = await pool.query(`
      SELECT p.id, (SELECT COUNT(*) FROM skus s WHERE s.product_id = p.id)::int AS sku_count
      FROM products p JOIN vendors v ON v.id = p.vendor_id
      WHERE v.code = 'EMS' AND p.collection = $1 AND LOWER(p.name) = LOWER($2)
        AND p.id <> ALL($3)
    `, [collection, targetName, group.map(u => u.id)]);
    if (existing.rows.length) {
      merges.push({
        keeper: { id: existing.rows[0].id, from: `${targetName} (existing, ${existing.rows[0].sku_count} skus)`, to: targetName },
        absorbed: group,
      });
    } else if (group.length === 1) {
      renames.push(group[0]);
    } else {
      group.sort((a, b) => (metaById.get(b.id)?.sku_count || 0) - (metaById.get(a.id)?.sku_count || 0));
      merges.push({ keeper: group[0], absorbed: group.slice(1) });
    }
  }
  log(`Fix 3 (Emser color-chain names): ${renames.length} simple renames, ${merges.length} color-split merges, ${skipped} skipped (chains are not color lists)`);
  for (const u of renames) log(`   rename "${u.from}" -> "${u.to}"`);
  for (const m of merges) log(`   merge  "${m.keeper.from}" + ${m.absorbed.map(a => `"${a.from}"`).join(' + ')} -> "${m.keeper.to}"`);
  if (!APPLY) return;
  backup.fix3_emser_names = { renames, merges };
  for (const u of renames) {
    await pool.query('UPDATE products SET name = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [u.id, u.to]);
  }
  for (const m of merges) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const a of m.absorbed) {
        await client.query('UPDATE skus SET product_id = $1, updated_at = CURRENT_TIMESTAMP WHERE product_id = $2', [m.keeper.id, a.id]);
        // sort_order offset keeps the (product_id, sku_id, asset_type, sort_order) indexes conflict-free
        await client.query('UPDATE media_assets SET product_id = $1, sort_order = sort_order + 1000 WHERE product_id = $2', [m.keeper.id, a.id]);
        await client.query('DELETE FROM products WHERE id = $1', [a.id]);
      }
      await client.query('UPDATE products SET name = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [m.keeper.id, m.keeper.to]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      log(`   MERGE FAILED for "${m.keeper.to}": ${err.message}`);
    } finally {
      client.release();
    }
  }
}

async function fix4() {
  // Duplicate display-name groups among active, non-sample siblings.
  const { rows: groups } = await pool.query(`
    SELECT p.id AS product_id, v.code AS vendor_code, p.name,
           LOWER(COALESCE(s.variant_name, '')) AS vkey,
           ARRAY_AGG(s.id) AS sku_ids
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE s.status = 'active' AND p.status = 'active' AND s.is_sample IS NOT TRUE
    GROUP BY p.id, v.code, p.name, LOWER(COALESCE(s.variant_name, ''))
    HAVING COUNT(*) > 1
  `);
  log(`Fix 4 (variant recomposition): ${groups.length} duplicate groups to examine`);

  const allSkuIds = groups.flatMap(g => g.sku_ids);
  const attrRows = await pool.query(`
    SELECT sa.sku_id, a.slug, sa.value
    FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
    WHERE sa.sku_id = ANY($1) AND a.slug = ANY($2)
  `, [allSkuIds, ATTR_ORDER]);
  const attrsBySku = new Map();
  for (const r of attrRows.rows) {
    if (!attrsBySku.has(r.sku_id)) attrsBySku.set(r.sku_id, {});
    attrsBySku.get(r.sku_id)[r.slug] = (r.value || '').trim();
  }
  const nameRows = await pool.query(
    `SELECT id, variant_name FROM skus WHERE id = ANY($1)`, [allSkuIds]);
  const nameBySku = new Map(nameRows.rows.map(r => [r.id, r.variant_name || '']));

  const updates = [];
  let unresolvable = 0;
  for (const g of groups) {
    // Which whitelisted attrs actually differ within this group?
    const differing = ATTR_ORDER.filter(slug => {
      const vals = new Set(g.sku_ids.map(id => (attrsBySku.get(id)?.[slug] || '').toLowerCase()));
      return vals.size > 1;
    });
    if (!differing.length) { unresolvable++; continue; }

    const proposed = new Map();
    for (const id of g.sku_ids) {
      const base = nameBySku.get(id) || '';
      const parts = [base];
      for (const slug of differing) {
        const val = attrsBySku.get(id)?.[slug];
        // Skip junk attribute values (Emser stores literal "N/a ..." and bare
        // numbers) — appending them writes name artifacts.
        if (!val || /^n\/?a\b/i.test(val) || /^\d+(\.\d+)?$/.test(val)) continue;
        // Containment must check the ACCUMULATED name, not just the base —
        // two different attrs can carry the same value ("Blue Steel" color+finish).
        if (!parts.join(', ').toLowerCase().includes(val.toLowerCase())) parts.push(val);
      }
      proposed.set(id, parts.filter(Boolean).join(', '));
    }
    // Only apply if the recomposition actually disambiguates the group.
    const distinct = new Set([...proposed.values()].map(n => n.toLowerCase()));
    if (distinct.size === g.sku_ids.length) {
      for (const id of g.sku_ids) {
        const next = proposed.get(id);
        if (next !== nameBySku.get(id)) {
          updates.push({ sku_id: id, product: `${g.vendor_code} ${g.name}`, from: nameBySku.get(id), to: next });
        }
      }
    } else {
      unresolvable++;
    }
  }
  log(`Fix 4: ${updates.length} variant_name updates across ${groups.length - unresolvable} groups; ` +
    `${unresolvable} groups unresolvable (no differing whitelisted attrs) — left open for review`);
  for (const u of updates.slice(0, 15)) log(`   [${u.product}] "${u.from}" -> "${u.to}"`);
  if (updates.length > 15) log(`   ... and ${updates.length - 15} more`);
  if (!APPLY) return;
  backup.fix4_variant_names = updates;
  for (const batchStart of range(updates.length, 1000)) {
    const chunk = updates.slice(batchStart, batchStart + 1000);
    await pool.query(`
      UPDATE skus s SET variant_name = u.next_name, updated_at = CURRENT_TIMESTAMP
      FROM (SELECT UNNEST($1::uuid[]) AS sku_id, UNNEST($2::text[]) AS next_name) u
      WHERE s.id = u.sku_id
    `, [chunk.map(u => u.sku_id), chunk.map(u => u.to)]);
  }
}

function range(n, step) {
  const out = [];
  for (let i = 0; i < n; i += step) out.push(i);
  return out;
}

log(APPLY ? '=== APPLYING ===' : '=== DRY RUN (no writes) ===');
await fix1();
await fix2();
await fix3();
await fix4();

if (APPLY) {
  const path = `./data/conformance-backfill-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(path, JSON.stringify(backup, null, 2));
  log(`Backup written: ${path}`);
}
await pool.end();
