/**
 * Roca category backfill — size-aware classifier.
 *
 * Fixes the pricebook-TYPE-driven miscategorization: category is derived from
 * material + actual field-tile format, not from whichever SKU happened to be seen
 * first. Keeps small decorative/subway tile in Backsplash & Wall, moves floor-size
 * porcelain out of it, routes slab-scale panels to Porcelain Slabs, and detects
 * wood-look plank collections.
 *
 * The classifyRocaCategory() function is mirrored verbatim in import-roca.js.
 * DRY RUN by default; pass EXECUTE=1 to write.
 */
import pg from 'pg';

const EXECUTE = process.env.EXECUTE === '1';

const CAT = {
  porcelain:      '650e8400-e29b-41d4-a716-446655440012',
  ceramic:        '650e8400-e29b-41d4-a716-446655440013',
  mosaic:         '650e8400-e29b-41d4-a716-446655440014',
  naturalStone:   '650e8400-e29b-41d4-a716-446655440011',
  porcelainSlab:  '650e8400-e29b-41d4-a716-446655440045',
  pavers:         '650e8400-e29b-41d4-a716-446655440062',
  woodLook:       '650e8400-e29b-41d4-a716-446655440015',
  wallTile:       '650e8400-e29b-41d4-a716-446655440050',
  bathAccessories:'03ab6adf-d7b2-463b-a1a4-9efa0e7cdc05',
};
const SLUG = { [CAT.porcelain]:'porcelain-tile',[CAT.ceramic]:'ceramic-tile',[CAT.mosaic]:'mosaic-tile',
  [CAT.naturalStone]:'natural-stone',[CAT.porcelainSlab]:'porcelain-slabs',[CAT.pavers]:'pavers',
  [CAT.woodLook]:'wood-look-tile',[CAT.wallTile]:'backsplash-wall',[CAT.bathAccessories]:'bath-accessories' };
const SLUG_TO_ID = Object.fromEntries(Object.entries(SLUG).map(([id, slug]) => [slug, id]));

// Wood-look plank collections (confirmed by wood-species color names: Roble=oak, Noce=walnut,
// Fresno=ash, Walnut, Wenge, Nogal — all in plank formats).
const WOOD_COLLECTIONS = new Set(['PINE','NORTHWOOD','WESTON','ABBEY','BOHEME','COLONIAL','INDIANA','LAGOM']);
const TRIM_RE = /bullnose|cove|liner|\brope\b|pencil|chair|skirt|\bbase\b|nose|\btrim\b|corner|quarter round|reducer|threshold|\bstep\b|border|jolly|listel/i;

function parseDim(s) {
  s = String(s).replace(/["']/g, '').trim();
  const m = s.match(/(\d+(?:\.\d+)?|\d+\/\d+)\s*[xX]\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const num = x => x.includes('/') ? parseInt(x.split('/')[0]) / parseInt(x.split('/')[1]) : parseFloat(x);
  return [num(m[1]), num(m[2])];
}

/**
 * @param collection  product collection name
 * @param material    material string from the pricebook header
 * @param fieldSizes  array of size labels for the product's FIELD (non-trim) SKUs
 * @param flags       { isMosaic, isPaver, isBath }
 */
export function classifyRocaCategory(collection, material, fieldSizes, flags = {}) {
  const c = (collection || '').toUpperCase().trim();
  const m = (material || '').toUpperCase();
  const dims = (fieldSizes || []).map(parseDim).filter(Boolean);
  const maxDim = dims.length ? Math.max(...dims.flatMap(d => d)) : 0;

  // Slab / large panel: dedicated collections or slab-scale format (>=90" longest side).
  // Uses the longest side so planks (e.g. 10.5x64) are NOT mistaken for slabs — only genuinely
  // wide+long panels (48x98, 48x110, 63x126) qualify. 48x48 large tiles stay tile.
  if (c === 'SLABS' || c === 'XL SLABS' || maxDim >= 90) return CAT.porcelainSlab;
  // Bath fixtures
  if (flags.isBath || c === 'BATH FIXTURES') return CAT.bathAccessories;
  // Pavers
  if (flags.isPaver || c === 'PAVERS' || m.includes('FULL BODY PORCELAIN STONEWARE')) return CAT.pavers;
  // Mosaics
  if (flags.isMosaic || /^CC\s+(MOSAICS?|PORCELAIN)/.test(c) || c === 'ROCKART' || c === 'METALS'
      || m.includes('GLASS MOSAIC') || m.includes('NATURAL STONE') || m.includes('ALUMINUM')) return CAT.mosaic;
  // Wood-look plank
  if (WOOD_COLLECTIONS.has(c)) return CAT.woodLook;
  // Quarry
  if (m.includes('QUARRY')) return CAT.ceramic;
  // Decorative / brick / subway / pencil wall: every field size is NARROW-format — longest side
  // <=24" AND shortest side <=6" (3x6/3x12/4x10 subway, 2x10/4x24 brick, 3x17 chevron, 5x6 hexagon).
  // A single tile with a short side >6" (8x8, 12x24, 24x24, 24x48, 35x35) counts as a floor tile,
  // so square-format deco (8x8 encaustic) stays a floor tile rather than being forced to wall.
  const hasFloorTile = dims.some(([a, b]) => Math.max(a, b) > 24 || Math.min(a, b) > 6);
  if (dims.length > 0 && !hasFloorTile) return CAT.wallTile;
  // Pure ceramic wall body (no floor-capable body) → wall (covers size-less wall trims too)
  if (m.includes('CERAMIC WALL') && !/PORCELAIN|GRES|STONEWARE/.test(m)) return CAT.wallTile;
  // Floor-capable bodies
  if (/PORCELAIN|GRES|STONEWARE|COLOR BODY/.test(m)) return CAT.porcelain;
  if (m.includes('CERAMIC')) return CAT.wallTile;
  return CAT.porcelain;
}

const SIZE_ATTR = 'd50e8400-e29b-41d4-a716-446655440004';
const MAT_ATTR  = 'd50e8400-e29b-41d4-a716-446655440002';

async function main() {
  const pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });

  // One row per product with material + all field/non-field size labels + current category
  const { rows } = await pool.query(`
    SELECT p.id, p.name, p.collection, c.slug AS cur_slug,
           max(mat.value) AS material,
           array_remove(array_agg(DISTINCT sz.value), NULL) AS field_sizes
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    JOIN skus s ON s.product_id = p.id
    LEFT JOIN sku_attributes sz  ON sz.sku_id = s.id  AND sz.attribute_id = '${SIZE_ATTR}'
    LEFT JOIN sku_attributes mat ON mat.sku_id = s.id AND mat.attribute_id = '${MAT_ATTR}'
    WHERE v.code = 'ROCA'
    GROUP BY p.id, p.name, p.collection, c.slug
  `);

  const changes = [];
  const dist = {};
  for (const r of rows) {
    const fieldSizes = r.field_sizes || [];
    const nameOrMat = `${r.name} ${r.material || ''} ${r.collection}`;
    const flags = {
      isMosaic: r.cur_slug === 'mosaic-tile' || /mosaic/i.test(r.name),
      isPaver:  r.cur_slug === 'pavers',
      isBath:   r.cur_slug === 'bath-accessories',
    };
    const newCat = classifyRocaCategory(r.collection, r.material, fieldSizes, flags);
    let newSlug = SLUG[newCat];
    // Guard: never move a product on missing size data into the material-default zone
    // (porcelain/wall) — keep whatever it already had. Slab/wood/mosaic/paver/bath are
    // collection/material-driven and safe even without sizes.
    const hasDims = fieldSizes.some(parseDim);
    if (!hasDims && (newSlug === 'porcelain-tile' || newSlug === 'backsplash-wall') && r.cur_slug) {
      newSlug = r.cur_slug;
    }
    dist[newSlug] = (dist[newSlug] || 0) + 1;
    if (newSlug !== r.cur_slug) changes.push({ ...r, fieldSizes, newSlug, newCat: newSlug === r.cur_slug ? null : (SLUG_TO_ID[newSlug] || newCat) });
  }

  // report
  console.log(`\n=== Roca recategorize (${EXECUTE ? 'EXECUTE' : 'DRY RUN'}) — ${rows.length} products ===`);
  const byMove = {};
  for (const ch of changes) {
    const k = `${ch.cur_slug || 'NULL'} -> ${ch.newSlug}`;
    (byMove[k] = byMove[k] || []).push(ch);
  }
  for (const [move, list] of Object.entries(byMove).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${move}  (${list.length})`);
    const byCol = {};
    for (const ch of list) (byCol[ch.collection] = byCol[ch.collection] || []).push(ch.name);
    for (const [col, names] of Object.entries(byCol).sort())
      console.log(`   ${col}: ${names.length <= 6 ? names.join(', ') : names.length + ' products'}`);
  }
  console.log(`\nNew distribution:`);
  for (const [slug, n] of Object.entries(dist).sort((a, b) => b[1] - a[1])) console.log(`   ${slug}: ${n}`);
  console.log(`\nTotal products changing: ${changes.length}`);

  if (EXECUTE && changes.length) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const ch of changes)
        await client.query('UPDATE products SET category_id=$1 WHERE id=$2', [ch.newCat, ch.id]);
      await client.query('COMMIT');
      console.log(`\nUPDATED ${changes.length} products.`);
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } else if (!EXECUTE) {
    console.log(`(dry run — pass EXECUTE=1 to apply)`);
  }
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
