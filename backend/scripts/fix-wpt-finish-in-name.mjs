/**
 * Western Pacific Tile — pull the finish word out of the product NAME.
 *
 * WPT bakes the finish into the Ecwid product title ("Taj Mahal Beige Polished",
 * "Mystical Charm Crema Matte"). The platform already stores finish as its own
 * attribute and as the variant suffix ("24x48, Polished"), so a finish word left
 * in the name surfaces the finish TWICE on the storefront:
 *
 *   - Duplicate   — "…Polished" in the name + "…, Polished" in the variant
 *                   ("…Polished Porcelain Tile … 24x48, Polished").
 *   - Conflict    — name says one finish, the spec/attribute says another.
 *                   Mystical Charm Crema: title "Matte" but the WPT spec sheet
 *                   ("Size 24"X48" Rectified, Polished Porcelain Tile") and our
 *                   finish attribute both say POLISHED → the PDP shows 2 finishes.
 *   - Missing attr — Soho *Glossy: finish is only in the name, attribute NULL.
 *
 * Fix (mirrors backend/scrapers/wpt.js extractTrailingFinish): strip the trailing
 * finish token from products.name, re-derive the color attribute from the cleaned
 * name, promote the name's finish into the finish attribute when it's missing, and
 * append the finish to the variant suffix when it's missing. The spec-derived
 * finish attribute always wins on conflict (we never overwrite an existing finish).
 *
 * Idempotent — after one run no WPT name ends in a finish token, so re-running is
 * a no-op. Dry-run by default; pass --apply to commit (writes a JSON backup first).
 *
 * Usage:
 *   node backend/scripts/fix-wpt-finish-in-name.mjs           # dry run
 *   node backend/scripts/fix-wpt-finish-in-name.mjs --apply   # commit
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ── Helpers (kept in sync with backend/scrapers/wpt.js) ──────────────────────
function canonFinish(tok) {
  const t = (tok || '').toLowerCase().replace(/\s+/g, '-');
  if (t.startsWith('semi')) return 'Semi-Polished';
  if (t.startsWith('unpolish')) return 'Unpolished';
  if (t === 'polished') return 'Polished';
  if (t === 'glossy' || t === 'gloss') return 'Glossy';
  if (t === 'matte' || t === 'matt') return 'Matte';
  if (t === 'honed') return 'Honed';
  if (t === 'satin') return 'Satin';
  if (t === 'lappato') return 'Lappato';
  return null;
}

function extractTrailingFinish(name) {
  const m = (name || '').match(/^(.*?)[\s,]+(semi[-\s]?polished|unpolished|polished|glossy|gloss|matte|matt|honed|satin|lappato)\s*$/i);
  if (!m || !m[1].trim()) return { base: (name || '').trim(), finish: null };
  return { base: m[1].trim(), finish: canonFinish(m[2]) };
}

function deriveColor(productName, collectionName) {
  if (!productName || !collectionName) return productName || '';
  let color = productName;
  const re = new RegExp(`^${collectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i');
  color = color.replace(re, '').trim();
  color = color.replace(/\s*\d+(?:["″])?\s*[xX×]\s*\d+(?:["″])?\s*$/, '').trim();
  color = color.replace(/\s+\d+["″]?\s*$/, '').trim();
  return color || productName;
}

async function main() {
  const client = await pool.connect();
  try {
    const { rows: vendorRows } = await client.query(
      `SELECT id FROM vendors WHERE LOWER(name) LIKE '%western pacific%' OR code = '807' LIMIT 1`
    );
    if (!vendorRows.length) throw new Error('Western Pacific Tile vendor not found');
    const vendorId = vendorRows[0].id;

    const finishAttrId = (await client.query(
      `SELECT id FROM attributes WHERE slug='finish' LIMIT 1`
    )).rows[0]?.id;
    const colorAttrId = (await client.query(
      `SELECT id FROM attributes WHERE slug='color' LIMIT 1`
    )).rows[0]?.id;

    // Every WPT product/SKU with its current name, color + finish attributes.
    const { rows } = await client.query(
      `SELECT p.id AS product_id, p.name, p.collection,
              s.id AS sku_id, s.variant_name,
              sf.value AS finish_attr,
              sc.value AS color_attr
         FROM products p
         JOIN skus s ON s.product_id = p.id
    LEFT JOIN sku_attributes sf ON sf.sku_id = s.id AND sf.attribute_id = $2
    LEFT JOIN sku_attributes sc ON sc.sku_id = s.id AND sc.attribute_id = $3
        WHERE p.vendor_id = $1
        ORDER BY p.name`,
      [vendorId, finishAttrId, colorAttrId]
    );

    const plan = [];
    for (const r of rows) {
      const { base, finish: nameFinish } = extractTrailingFinish(r.name);
      if (!nameFinish || base === r.name) continue; // no trailing finish → skip

      const newName = base;
      const newColor = deriveColor(newName, r.collection || '');
      const effectiveFinish = r.finish_attr || nameFinish; // spec/attr wins
      const promoteFinish = !r.finish_attr; // attr missing → set it

      // variant_name: ensure it carries the finish suffix.
      let newVariant = r.variant_name;
      if (newVariant && !new RegExp(`,\\s*${effectiveFinish}\\s*$`, 'i').test(newVariant)) {
        // Append finish if the variant has a size but no finish suffix.
        if (!/,\s*(polished|glossy|matte|honed|satin|semi-polished|unpolished|lappato)\s*$/i.test(newVariant)) {
          newVariant = `${newVariant}, ${effectiveFinish}`;
        }
      }

      plan.push({
        product_id: r.product_id,
        sku_id: r.sku_id,
        oldName: r.name,
        newName,
        oldColor: r.color_attr,
        newColor,
        hasColorRow: r.color_attr != null,
        finishAttr: r.finish_attr,
        promoteFinish: promoteFinish ? nameFinish : null,
        oldVariant: r.variant_name,
        newVariant: newVariant !== r.variant_name ? newVariant : null,
        conflict: r.finish_attr && r.finish_attr.toLowerCase() !== nameFinish.toLowerCase(),
      });
    }

    if (!plan.length) {
      console.log('✓ No WPT product names carry a trailing finish token. Nothing to do.');
      return;
    }

    console.log(`\n${plan.length} WPT product(s) with a finish word in the name:\n`);
    for (const c of plan) {
      const tag = c.conflict ? '  ⚠ CONFLICT (name≠spec, keeping spec)' : c.promoteFinish ? '  + promote finish attr' : '';
      console.log(`  "${c.oldName}"  →  "${c.newName}"${tag}`);
      if (c.newColor !== c.oldColor) console.log(`      color: "${c.oldColor}" → "${c.newColor}"`);
      if (c.promoteFinish) console.log(`      finish attr: (none) → "${c.promoteFinish}"`);
      if (c.newVariant) console.log(`      variant: "${c.oldVariant}" → "${c.newVariant}"`);
    }

    // Guard: renaming must not collide with an existing (vendor, collection, name).
    for (const c of plan) {
      const { rows: dup } = await client.query(
        `SELECT id FROM products WHERE vendor_id=$1 AND collection=(SELECT collection FROM products WHERE id=$2) AND LOWER(name)=LOWER($3) AND id<>$2`,
        [vendorId, c.product_id, c.newName]
      );
      if (dup.length) {
        console.log(`\n✗ ABORT: renaming "${c.oldName}" → "${c.newName}" collides with existing product ${dup[0].id}. Resolve manually.`);
        return;
      }
    }

    if (!APPLY) {
      console.log('\nDry run — pass --apply to commit.');
      return;
    }

    // Backup before writing.
    const backup = { generated_at: new Date().toISOString(), vendor_id: vendorId, rows: plan };
    const backupPath = path.join(__dirname, '..', 'data', `wpt-finish-in-name-backup-${Date.now()}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    console.log(`\nBackup written: ${backupPath}`);

    await client.query('BEGIN');
    let n = 0;
    for (const c of plan) {
      await client.query(`UPDATE products SET name=$1, updated_at=NOW() WHERE id=$2`, [c.newName, c.product_id]);
      if (c.newColor && (c.newColor !== c.oldColor || !c.hasColorRow)) {
        await client.query(
          `INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1,$2,$3)
           ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value=EXCLUDED.value`,
          [c.sku_id, colorAttrId, c.newColor]
        );
      }
      if (c.promoteFinish) {
        await client.query(
          `INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1,$2,$3)
           ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value=EXCLUDED.value`,
          [c.sku_id, finishAttrId, c.promoteFinish]
        );
      }
      if (c.newVariant) {
        await client.query(`UPDATE skus SET variant_name=$1, updated_at=NOW() WHERE id=$2`, [c.newVariant, c.sku_id]);
      }
      n++;
    }
    await client.query('COMMIT');
    console.log(`\n✓ Applied to ${n} product(s).`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
