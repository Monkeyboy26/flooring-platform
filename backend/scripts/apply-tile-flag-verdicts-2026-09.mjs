#!/usr/bin/env node
/**
 * apply-tile-flag-verdicts-2026-09.mjs
 *
 * Applies the human-investigated verdicts on the initial tile-leaf-mismatch
 * weak findings (2026-09-01 investigation):
 *   • MOVE sets: evidence-confirmed miscategorizations → target leaf, pinned
 *     category_source='manual' so nothing automated ever reverts them.
 *   • WAIVE: every remaining open tile-leaf-mismatch violation EXCEPT the DAL
 *     "Marazzi Pebble Matte" one (left open pending a per-sheet pricing look).
 *
 * Run in two phases with an audit in between, so moved products' violations
 * auto-close as 'fixed' and only true keeps get waived:
 *   node apply-tile-flag-verdicts-2026-09.mjs moves --apply
 *   (run the tile-leaf-mismatch audit)
 *   node apply-tile-flag-verdicts-2026-09.mjs waive --apply
 * Idempotent. Dry run without --apply.
 */
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const PHASE = process.argv[2] === 'waive' ? 'waive' : 'moves';
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});

// Each set: vendor code, SQL condition over products p (parameter-free — names
// are trusted literals from the investigation), target leaf slug.
const MOVES = [
  // Slabs filed as tile
  { v: 'ELY', where: `p.name LIKE 'Florim Slab Program%'`, to: 'porcelain-slabs', label: 'Florim Slab Program 47x110/63x126 slabs' },
  { v: 'EMS', where: `p.name LIKE 'Issima%2cm%'`, to: 'porcelain-slabs', label: 'Issima 2cm 59x94 slabs (join siblings)' },
  // Panels
  { v: 'ELS', where: `p.collection = 'Shower Panels'`, to: 'shower-panels', label: '96" engineered-marble shower panels' },
  { v: 'ET', where: `p.name = 'Workshop'`, to: 'wall-panels', label: '9ft wood-slat wall panels' },
  // Mosaics / ledger
  { v: 'AZT', where: `p.name LIKE 'Geo 2%'`, to: 'mosaic-tile', label: 'Geo 2 glass mosaic sheets' },
  { v: 'AZT', where: `p.name = 'Haisa Blue'`, to: 'stacked-stone', label: 'Split Honed Ledger 6x24 marble' },
  { v: 'MSI', where: `p.name = 'Coronado 4x12'`, to: 'stacked-stone', label: 'stone strip veneer' },
  { v: 'EMS', where: `p.name = 'Wainscot Engineered Stone'`, to: 'stacked-stone', label: 'wainscot veneer strips' },
  { v: 'SIEN', where: `p.name IN ('Ledgestone British Beige','Ledgestone Canada Gris','Ledgestone Gris','Ledgestone Sage')`, to: 'stacked-stone', label: 'porcelain 13x26 ledger panels' },
  // Wrong-material stragglers
  { v: '406', where: `p.name = 'LFT Cosmopolitan'`, to: 'porcelain-tile', label: 'porcelain in natural-stone' },
  { v: 'EMS', where: `p.name IN ('Milzetti Pebble Brushed','Milzetti Pebble Polished','Mixt 2 Pebble Matte','Mixt 2 Pebble R11 Grippor')`, to: 'porcelain-tile', label: 'porcelain pebble-look lines in natural-stone' },
  // Sundry stray
  { v: 'EMS', where: `p.name = '2x50 Mesh Tape Roll'`, to: 'surface-prep-levelers', label: 'actual mesh tape in porcelain-tile' },
  // Trim hiding in variants / names
  { v: 'ELY', where: `p.name IN ('Colores Blanco 29','AN Dolomite Supreme','Carrara Natural 2018','Seers Light','White Polished','Rock 2009 Flat Black')`, to: 'trim-accessories', label: 'bullnose-only lines' },
  { v: 'EMS', where: `p.name ~* '\\mcigaro\\M' AND c.slug = 'natural-stone'`, to: 'trim-accessories', label: 'Cigaro 1x12 pencil family' },
  { v: 'EMS', where: `p.name = 'Emser Signature Sills Travertine'`, to: 'trim-accessories', label: 'window sills' },
  { v: 'EMS', where: `p.name IN ('Radiant Angle Trim Matte','Radiant Triangular Trim Matte')`, to: 'trim-accessories', label: 'Radiant trim' },
  { v: 'SA', where: `p.name = 'Charcoal' AND c.slug = 'ceramic-tile'`, to: 'trim-accessories', label: 'Universal Jolly line' },
  // Stairs
  { v: 'EMS', where: `p.name = 'Mitford Glossy Stair Riserpvc'`, to: 'stair-treads-nosing', label: 'stair riser' },
  { v: '406', where: `p.name = 'Peldano Curvo Stair R11'`, to: 'stair-treads-nosing', label: 'stair tread' },
];

try {
  let totalMoved = 0;
  if (PHASE === 'waive') {
    // Post-audit phase: whatever is still open didn't reproduce as fixed —
    // these are the investigated keeps. Waive all but the DAL pricing case.
    const sel = await pool.query(`
      SELECT id, summary FROM quality_violations
      WHERE rule_key = 'tile-leaf-mismatch' AND status = 'open'
        AND summary NOT LIKE '%Marazzi Pebble Matte%'
    `);
    console.log(`open tile-leaf-mismatch to waive: ${sel.rows.length}`);
    for (const r of sel.rows.slice(0, 10)) console.log(`    ${r.summary}`);
    if (sel.rows.length > 10) console.log(`    … +${sel.rows.length - 10} more`);
    if (APPLY) {
      const res = await pool.query(`
        UPDATE quality_violations
        SET status = 'waived', waived_by = 'tile-flag investigation 2026-09-01',
            waive_note = 'Investigated: evidence supports current leaf (deco/scored/picket field tile, sintered stone, mixed line, per-piece stone, pinned placement, or family-consistent wall tile).',
            waived_at = CURRENT_TIMESTAMP
        WHERE id = ANY($1)
      `, [sel.rows.map(r => r.id)]);
      console.log(`waived ${res.rowCount}`);
    } else {
      console.log('[dry run] pass --apply to write');
    }
  }
  for (const m of PHASE === 'waive' ? [] : MOVES) {
    const sel = await pool.query(`
      SELECT p.id, p.name, c.slug AS from_slug
      FROM products p
      JOIN vendors v ON v.id = p.vendor_id AND v.code = $1
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.status = 'active' AND (${m.where}) AND c.slug IS DISTINCT FROM $2
    `, [m.v, m.to]);
    console.log(`${m.v} → ${m.to}: ${sel.rows.length} products (${m.label})`);
    for (const r of sel.rows) console.log(`    ${r.name}  [${r.from_slug} → ${m.to}]`);
    if (APPLY && sel.rows.length) {
      const res = await pool.query(`
        UPDATE products SET
          category_id = (SELECT id FROM categories WHERE slug = $2),
          category_source = 'manual', category_needs_review = false,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ANY($1)
          AND EXISTS (SELECT 1 FROM categories WHERE slug = $2)
      `, [sel.rows.map(r => r.id), m.to]);
      totalMoved += res.rowCount;
    }
  }

  if (PHASE !== 'waive') {
    if (APPLY) console.log(`\nmoved ${totalMoved} products total`);
    else console.log('\n[dry run] pass --apply to write');
  }
} finally {
  await pool.end();
}
