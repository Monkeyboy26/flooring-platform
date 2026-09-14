#!/usr/bin/env node
/**
 * fix-roca-letter-variants.mjs
 *
 * Root-cause data fix for Roca's meaningless "A/B/C" letter variants.
 * The 2026 price book distinguishes same-size rows by glaze codes (MG/BG),
 * shape qualifiers (PICKET/BEVELED), series (SUITE), finishes (UP/PO/ABS) —
 * import-roca.js used to paper over all of them with position letters, and
 * collapsed distinct mosaic designs into single products. The importer is
 * now fixed for future books (see import-roca.js); this script repairs the
 * CURRENT catalog to match what the fixed importer produces:
 *
 *  1. Letter variants → meaningful labels + Finish attributes
 *     (Alba/Artesano/Feathers MG/BG, Flow picket, Hangar ABS, Lassa UP/PO,
 *      Statuary Wall beveled, Abbey ABS/Suite, Baltic/Limestone/Dolomita/
 *      Room SUITE, Color Collection bright/matte/picket)
 *  2. Alba "Nero" = vendor misparse of "Noite" (color W) → merge products
 *  3. Rockart "Carrara Marble" A/B/C = three DIFFERENT patterns
 *     (1x1 hexagon / 1x1 squares / 2x2 hexagon) → split into 3 products,
 *     drop the borrowed Lantern images from the two hexagon SKUs
 *  4. CC "Matte Snow White Octagon" A–E = three designs (plain / w-black /
 *     w-gray) × legacy+new codes → split into 3 products
 *
 * True duplicate listings (legacy code + "NEW SKU" SA code, identical
 * design: UFCC111-12MT / UFCC111SABG etc.) KEEP their A/B letters — both
 * codes are orderable warehouse stock; the storefront Option row shows them.
 *
 * Idempotent. DRY_RUN=1 (default) prints the plan; APPLY=1 executes.
 *
 * Usage: DB_PASSWORD=postgres node backend/scripts/fix-roca-letter-variants.mjs [APPLY=1]
 */
import pg from 'pg';

const APPLY = process.env.APPLY === '1';
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.DB_PASS || 'postgres',
});

const VENDOR_ID = 'b898517d-1643-4158-a92f-bf494bb69ef0'; // Roca USA
const ATTR_FINISH = 'd50e8400-e29b-41d4-a716-446655440003';
const ATTR_SIZE = 'd50e8400-e29b-41d4-a716-446655440004';

// ── 1. vendor_sku → { vn: new variant_name, finish?: Finish attr value, size?: Size attr fix }
// Derived row-by-row from ROCA USA 2026 PRICE BOOK II-JAN descriptions.
const RENAMES = {
  // Alba — MG (matte glazed) vs BG (bright glazed) pairs
  'UALBAAV128U': { vn: 'Matte 2X8', finish: 'Matte' },
  'UALBABV128U': { vn: 'Bright 2X8', finish: 'Bright' },
  'UALBAAM312U': { vn: 'Matte 3X12', finish: 'Matte' },
  'UALBAAB312U': { vn: 'Bright 3X12', finish: 'Bright' },
  'UALBABI128V': { vn: 'Matte 2X8', finish: 'Matte' },
  'UALBABB128V': { vn: 'Bright 2X8', finish: 'Bright' },
  'UALBABM312V': { vn: 'Matte 3X12', finish: 'Matte' },
  'UALBABB312V': { vn: 'Bright 3X12', finish: 'Bright' },
  'UALBACR128E': { vn: 'Matte 2X8', finish: 'Matte' },
  'UALBABR128E': { vn: 'Bright 2X8', finish: 'Bright' },
  'UALBACM312E': { vn: 'Matte 3X12', finish: 'Matte' },
  'UALBACB312E': { vn: 'Bright 3X12', finish: 'Bright' },
  'UALBANE128W': { vn: 'Matte 2X8', finish: 'Matte' },   // Nero → Noite (merge below)
  'UALBANB128W': { vn: 'Bright 2X8', finish: 'Bright' }, // Nero → Noite
  'UALBABE312W': { vn: 'Matte 3X12', finish: 'Matte' },
  'UALBANM312W': { vn: 'Bright 3X12', finish: 'Bright' },
  // Artesano
  'UARBLABG312': { vn: 'Bright 3X12', finish: 'Bright' },
  'UARBLAMG312': { vn: 'Matte 3X12', finish: 'Matte' },
  'UARWHIBG312': { vn: 'Bright 3X12', finish: 'Bright' },
  'UARWHIMG312': { vn: 'Matte 3X12', finish: 'Matte' },
  // Feathers
  'UFEWHIBG312': { vn: 'Bright 3X12', finish: 'Bright' },
  'UFEWHIMG312': { vn: 'Matte 3X12', finish: 'Matte' },
  // Color Collection — U7xx/U0xx = bright glaze, U2xx = matte glaze; -PICKET = picket shape
  'U761-312': { vn: 'Bright 3X12', finish: 'Bright' },
  'U261-312': { vn: 'Matte 3X12', finish: 'Matte' },
  'U761-PICKET': { vn: 'Bright Picket 3X12', finish: 'Bright' },
  'U261-PICKET': { vn: 'Matte Picket 3X12', finish: 'Matte' },
  'U081-312': { vn: 'Bright 3X12', finish: 'Bright' },
  'U281-312': { vn: 'Matte 3X12', finish: 'Matte' },
  'U081-PICKET': { vn: 'Bright Picket 3X12', finish: 'Bright' },
  'U281-PICKET': { vn: 'Matte Picket 3X12', finish: 'Matte' },
  // Flow — "-312P" = picket
  'FLOCB09-312': { vn: '3X12' }, 'FLOCB09-312P': { vn: 'Picket 3X12' },
  'FLODG08-312': { vn: '3X12' }, 'FLODG08-312P': { vn: 'Picket 3X12' },
  'FLOPG02-312': { vn: '3X12' }, 'FLOPG02-312P': { vn: 'Picket 3X12' },
  'FLOTG10-312': { vn: '3X12' }, 'FLOTG10-312P': { vn: 'Picket 3X12' },
  'FLOWH17-312': { vn: '3X12' }, 'FLOWH17-312P': { vn: 'Picket 3X12' },
  // Hangar — ABS = abrasive finish
  'F3601E8021': { vn: 'Abrasive 48X48', finish: 'Abrasive' },
  'F3602E8021': { vn: '48X48' },
  // Lassa — UP / PO (third code FLWPPT3A31 has no finish in the book; keeps its letter)
  'ULAWHGP2448R': { vn: 'Unpolished 24X48', finish: 'Unpolished' },
  'ULAWHPO2448R': { vn: 'Polished 24X48', finish: 'Polished' },
  // Statuary Wall — BV = beveled edge
  'UWAST101-410': { vn: '4X10' },
  'UWAST101-410BV': { vn: 'Beveled 4X10' },
  // Abbey — ABS rows; SUITE row is a 12"x36" tile filed under the 8X48 group
  'FN80H6O831': { vn: '8X48' }, 'FN80C6O831': { vn: 'Abrasive 8X48', finish: 'Abrasive' },
  'FN80H6O741': { vn: '8X48' }, 'FN80I6O741': { vn: 'Abrasive 8X48', finish: 'Abrasive' },
  'FN8A0AW371': { vn: 'Suite 12X36', size: '12x36' },
  'FN80H6O021': { vn: '8X48' }, 'FN80I6O021': { vn: 'Abrasive 8X48', finish: 'Abrasive' },
  'FN80H6O141': { vn: '8X48' },
  // Baltic — SUITE series rows
  'UBALTIMTLBI': { vn: '24X48' }, 'UBALTIWALBI': { vn: 'Suite 24X48' },
  'UBALTIMTLBU': { vn: '24X48' }, 'UBALTIWALBU': { vn: 'Suite 24X48' },
  'UBALTIMTLBE': { vn: '24X48' }, 'UBALTIWALBE': { vn: 'Suite 24X48' },
  // Limestone Arena / Marble Dolomita / Room — SUITE rows
  'FDB7D57371': { vn: 'Suite 12X24' },
  'F7I0A57011': { vn: '12X24' }, 'F7IB1MV011': { vn: 'Suite 12X24' },
  'FB4T3AW011': { vn: '12X36' }, 'FB43TAW011': { vn: 'Suite 12X36' },
};

// ── 3/4. Product splits: existing multi-design products → one product per design
const SPLITS = [
  {
    // Rockart "Carrara Marble": A/B/C are three different mosaic patterns
    find: { collection: 'Rockart', name: 'Carrara Marble' },
    keep: { vendor_sku: 'USTMHEX011', rename: 'Carrara Marble 1x1 Hexagon', vn: '12X12' },
    out: [
      { vendor_sku: 'USTMSQ022', name: 'Carrara Marble 1x1 Squares', slug: 'rockart-carrara-marble-1x1-squares', vn: '12X12' },
      { vendor_sku: 'USTMHEX022', name: 'Carrara Marble 2x2 Hexagon', slug: 'rockart-carrara-marble-2x2-hexagon', vn: '12X12' },
    ],
    // Both hexagon SKUs carry the LANTERN photo (borrowed by name-match) — wrong pattern, drop it
    dropMediaLike: { vendor_skus: ['USTMHEX011', 'USTMHEX022'], urlLike: '%Carrara-Lantern%' },
  },
  {
    // CC Mosaics "Matte Snow White Octagon": three designs × legacy+new codes
    find: { collection: 'Cc Mosaics', name: 'Matte Snow White Octagon' },
    keep: { vendor_sku: 'UFCC100SAMG', vn: 'B 12X12' }, // plain design, new code
    pullIn: [
      // plain design's legacy code sits in its own drifted product ("Matte White Octagon")
      { vendor_sku: 'UFCC100-12MT', vn: 'A 12X12', deactivateEmptiedProduct: true },
    ],
    out: [
      { vendor_sku: 'UFCC101-12MT', name: 'Matte Snow White & Black Octagon', slug: 'cc-mosaics-matte-snow-white-black-octagon', vn: 'A 12X12' },
      { vendor_sku: 'UFCC101SAMG', sameAs: 'UFCC101-12MT', vn: 'B 12X12' },
      { vendor_sku: 'UFCC112-12MS', name: 'Matte Snow White & Gray Octagon', slug: 'cc-mosaics-matte-snow-white-gray-octagon', vn: 'A 12X12' },
      { vendor_sku: 'UFCC112SAMG', sameAs: 'UFCC112-12MS', vn: 'B 12X12' },
    ],
  },
];

async function main() {
  const client = await pool.connect();
  const touched = new Set(); // product ids for search-vector refresh
  try {
    await client.query('BEGIN');

    // ── 1. Variant renames + finish/size attributes ──
    let renamed = 0;
    for (const [vsku, spec] of Object.entries(RENAMES)) {
      const { rows } = await client.query(`
        SELECT s.id, s.variant_name, s.product_id FROM skus s
        JOIN products p ON p.id = s.product_id
        WHERE p.vendor_id = $1 AND s.vendor_sku = $2`, [VENDOR_ID, vsku]);
      if (!rows.length) { console.log(`  ⚠ missing sku ${vsku}`); continue; }
      const s = rows[0];
      if (s.variant_name !== spec.vn) {
        console.log(`  rename ${vsku}: "${s.variant_name}" → "${spec.vn}"`);
        if (APPLY) await client.query('UPDATE skus SET variant_name = $1, updated_at = NOW() WHERE id = $2', [spec.vn, s.id]);
        renamed++;
      }
      if (spec.finish && APPLY) {
        await client.query(`
          INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
          ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
          [s.id, ATTR_FINISH, spec.finish]);
      }
      if (spec.size && APPLY) {
        await client.query(`
          INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
          ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
          [s.id, ATTR_SIZE, spec.size]);
      }
      touched.add(s.product_id);
    }
    console.log(`Renames: ${renamed}`);

    // ── 2. Merge Alba "Nero" (vendor misparse) into "Noite" ──
    const nero = (await client.query(
      `SELECT id, slug, status FROM products WHERE vendor_id = $1 AND collection = 'Alba' AND name = 'Nero'`, [VENDOR_ID])).rows[0];
    const noite = (await client.query(
      `SELECT id FROM products WHERE vendor_id = $1 AND collection = 'Alba' AND name = 'Noite'`, [VENDOR_ID])).rows[0];
    if (nero && noite && nero.status === 'active') {
      console.log(`Merge Alba Nero (${nero.id}) → Noite (${noite.id})`);
      if (APPLY) {
        await client.query(`UPDATE skus SET product_id = $1, updated_at = NOW() WHERE product_id = $2`, [noite.id, nero.id]);
        await client.query(`
          UPDATE sku_attributes sa SET value = 'Noite'
          FROM skus s WHERE s.id = sa.sku_id AND s.product_id = $1
            AND sa.attribute_id = 'd50e8400-e29b-41d4-a716-446655440001' AND sa.value = 'Nero'`, [noite.id]);
        await client.query(`UPDATE products SET status = 'inactive', updated_at = NOW() WHERE id = $1`, [nero.id]);
        if (nero.slug) {
          await client.query(`
            INSERT INTO slug_aliases (old_slug, product_id) VALUES ($1, $2)
            ON CONFLICT (old_slug) DO UPDATE SET product_id = EXCLUDED.product_id`, [nero.slug, noite.id]);
        }
      }
      touched.add(noite.id);
    } else if (!nero) {
      console.log('Alba Nero already merged (not found or inactive)');
    }

    // ── 3/4. Product splits ──
    for (const split of SPLITS) {
      const src = (await client.query(
        `SELECT * FROM products WHERE vendor_id = $1 AND collection = $2 AND name = $3`,
        [VENDOR_ID, split.find.collection, split.find.name])).rows[0];
      if (!src) { console.log(`Split source already renamed/absent: ${split.find.name}`); continue; }
      console.log(`Split: ${split.find.collection} :: ${split.find.name}`);

      const newProducts = new Map(); // vendor_sku → new product id
      for (const out of split.out) {
        if (out.sameAs) continue;
        const existing = (await client.query(
          `SELECT id FROM products WHERE vendor_id = $1 AND collection = $2 AND name = $3`,
          [VENDOR_ID, split.find.collection, out.name])).rows[0];
        if (existing) { newProducts.set(out.vendor_sku, existing.id); continue; }
        console.log(`  + product "${out.name}" (${out.slug})`);
        if (APPLY) {
          const { rows } = await client.query(`
            INSERT INTO products (vendor_id, name, collection, category_id, status, slug, brand_id)
            VALUES ($1, $2, $3, $4, 'active', $5, $6) RETURNING id`,
            [VENDOR_ID, out.name, split.find.collection, src.category_id, out.slug, src.brand_id]);
          newProducts.set(out.vendor_sku, rows[0].id);
          touched.add(rows[0].id);
        }
      }
      for (const out of split.out) {
        const targetId = newProducts.get(out.sameAs || out.vendor_sku);
        console.log(`  move ${out.vendor_sku} → "${(split.out.find(o => o.vendor_sku === (out.sameAs || out.vendor_sku)) || {}).name}" vn="${out.vn}"`);
        if (APPLY && targetId) {
          await client.query(`
            UPDATE skus SET product_id = $1, variant_name = $2, updated_at = NOW()
            WHERE vendor_sku = $3 AND product_id = $4`, [targetId, out.vn, out.vendor_sku, src.id]);
        }
      }
      // keep: rename source product / set variant name
      if (split.keep.rename && src.name !== split.keep.rename) {
        console.log(`  rename product "${src.name}" → "${split.keep.rename}"`);
        if (APPLY) await client.query(`UPDATE products SET name = $1, updated_at = NOW() WHERE id = $2`, [split.keep.rename, src.id]);
      }
      if (APPLY) {
        await client.query(`UPDATE skus SET variant_name = $1, updated_at = NOW() WHERE vendor_sku = $2 AND product_id = $3`,
          [split.keep.vn, split.keep.vendor_sku, src.id]);
      }
      touched.add(src.id);

      // pullIn: adopt skus from other (drifted) products
      for (const pi of (split.pullIn || [])) {
        const row = (await client.query(`
          SELECT s.id, s.product_id FROM skus s JOIN products p ON p.id = s.product_id
          WHERE p.vendor_id = $1 AND s.vendor_sku = $2`, [VENDOR_ID, pi.vendor_sku])).rows[0];
        if (!row) { console.log(`  ⚠ pullIn sku missing: ${pi.vendor_sku}`); continue; }
        if (row.product_id === src.id) continue; // already merged
        console.log(`  pull in ${pi.vendor_sku} (from ${row.product_id}) vn="${pi.vn}"`);
        if (APPLY) {
          await client.query(`UPDATE skus SET product_id = $1, variant_name = $2, updated_at = NOW() WHERE id = $3`, [src.id, pi.vn, row.id]);
          if (pi.deactivateEmptiedProduct) {
            await client.query(`
              UPDATE products SET status = 'inactive', updated_at = NOW()
              WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = $1 AND s.status = 'active')`,
              [row.product_id]);
          }
        }
      }

      // wrong borrowed images
      if (split.dropMediaLike) {
        const { rows } = await client.query(`
          SELECT m.id, m.url, s.vendor_sku FROM media_assets m
          JOIN skus s ON s.id = m.sku_id
          WHERE s.vendor_sku = ANY($1) AND m.url LIKE $2`,
          [split.dropMediaLike.vendor_skus, split.dropMediaLike.urlLike]);
        for (const m of rows) {
          console.log(`  drop wrong image on ${m.vendor_sku}: ${m.url}`);
          if (APPLY) await client.query('DELETE FROM media_assets WHERE id = $1', [m.id]);
        }
      }
    }

    if (APPLY) {
      for (const pid of touched) {
        await client.query('SELECT refresh_search_vectors($1)', [pid]);
      }
      await client.query('COMMIT');
      console.log(`\nAPPLIED. ${touched.size} products touched.`);
    } else {
      await client.query('ROLLBACK');
      console.log('\nDRY RUN (set APPLY=1 to execute).');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
