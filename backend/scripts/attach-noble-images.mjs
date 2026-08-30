#!/usr/bin/env node
/**
 * Emser sundries — attach Noble Company brand-site images (2026-08-30)
 *
 * Emser's Shower Systems (and related waterproofing/sealant sundries) are
 * largely Noble Company products sourced via Emser's EDI (see
 * noble-through-emser). Emser has no imagery for them; noblecompany.com
 * (WooCommerce) hosts per-line product photos — harvested to
 * backend/data/noble/line-images.json. Attached as PRODUCT-level primaries
 * for photoless products only.
 *
 * Non-Noble brands sharing these categories (Laticrete Hydro Ban, Prova,
 * Protecto Wrap, Sika, Durock...) are excluded by a brand guard; they get
 * their own passes. Strainers/grates are deliberately left unmatched —
 * Noble's site has no per-strainer imagery and a drain-kit photo on a
 * strainer product would be the borrowed-image problem again.
 *
 * Usage:
 *   node backend/scripts/attach-noble-images.mjs --dry-run
 *   node backend/scripts/attach-noble-images.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const LINES = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/noble/line-images.json'), 'utf8'));

// Never match products from other brands that share these categories.
const OTHER_BRANDS = /\b(hydro\s*ban|h\s*ban|prova|protecto|flexdeck|sika|durock|laticrete|stonetech|nuheat|dewalt|blanke|jiffy\s*seal|fracture\s*guard|crack\s*buster|moisture\s*guard)\b/i;

// Most-specific-first. [regex, slug]
const RULES = [
  [/(mtr|mortar)\s*bed\s*(adapter|kt|kit).*(lin|linear)|(lin|linear).*(mtr|mortar)\s*bed\s*(adapter|kt|kit)/i, 'mortar-bed-adapter-kit-linear-drain'],
  [/(mtr|mortar)\s*bed\s*(adapter|kt|kit)/i, 'mortar-bed-adapter-kit-thin-bed-drain'],
  [/nobleflex|nobleflx/i, 'nobleflex'],
  [/fs\s*lin\s*drn|freestyle\s*linear|noble\s*freestyle/i, 'freestyle-linear-drains'],
  [/freestyle\s*thin|fs\s*thin|thin\s*bed\s*drain/i, 'freestyle-thin-bed-drains'],
  [/probase\s*ex/i, 'probase-ex'],
  [/probase.*\bramp\b|ramp.*probase/i, 'probase-ii-ramp'],
  [/probase.*(\bss\b|single)/i, 'probase-ii-single-slope'],
  [/probase/i, 'probase-ii-multi-slope'],
  [/pro\s*slope|proslope/i, 'pro-slope'],
  [/recess\s*it|\bniche\b/i, 'noble-niches'],
  [/\bbench/i, 'noble-benches'],
  [/\bcurb/i, 'noblecurbs'],
  [/noble\s*seal\s*ts/i, 'nobleseal-ts'],
  [/noble\s*seal\s*sis/i, 'nobleseal-sis'],
  [/noble\s*seal\s*cis/i, 'nobleseal-cis'],
  [/noble\s*seal/i, 'nobleseal-ts'],
  [/noble\s*deck/i, 'noble-deck'],
  [/chloraloy/i, 'chloraloy'],
  [/richpan/i, 'richpan'],
  [/pan\s*liner|shower\s*pan/i, 'pvc-shower-pan-liner'],
  [/seam\s*cement/i, 'pvc-seam-cement'],
  [/aquablue.*mesh|flashing\s*mesh/i, 'aquablue-flashing-mesh'],
  [/aquablue/i, 'aquablue-w'],
  [/aquaseal.*(drain|flashing)/i, 'aquaseal-drain-flashing'],
  [/aquaseal/i, 'aquaseal'],
  [/nobleboard/i, 'nobleboard'],
  [/noblebond/i, 'noblebond-ext'],
  [/noblesealant\s*150|sealant\s*150/i, 'noblesealant-150'],
  [/noblesealant\s*250|sealant\s*250/i, 'noblesealant-250'],
  [/nobleweld/i, 'nobleweld-100'],
  [/positive\s*weep|weep\s*protector/i, 'positive-weep-protector'],
  [/thin\s*line/i, 'thin-line'],
  [/npact/i, 'npact'],
  [/surround\s*kit/i, 'surround-kit'],
  [/dam\s*corner|noble\s*(inside|outside)\s*corner/i, 'cpe-pvc-dam-corners'],
  [/clamping\s*ring/i, 'clamping-ring-drains'],
  [/strainer\s*connector/i, 'strainer-connector'],
  [/sheet\s*membrane/i, 'sheet-membranes-cut-to-length'],
];

// Freestyle strainer/grate patterns → strainer-only or per-pattern drain shots
const PATTERNS = [
  [/slotted/i, 'slotted'], [/tile\s*top|tiletop/i, 'tile-top'], [/wave/i, 'wave'],
  [/pyrmd|pyramid/i, 'pyramid'], [/xhtc|cross\s*hatch/i, 'cross-hatch'], [/\bsolid\b/i, 'solid'],
];
function freestyleVariant(name) {
  const pat = PATTERNS.find(([re]) => re.test(name))?.[1] || null;
  const isStrainer = /(strnr|strainer)/i.test(name) && !/lin\s*drn|linear\s*drain/i.test(name);
  if (isStrainer) return pat ? `fs-strainer-${pat}` : null; // triangle etc. — no image, skip
  if (!pat) return 'freestyle-linear-drains';
  const mat = /\babs\b/i.test(name) ? 'abs' : 'pvc';
  return `fs-drain-${mat}-${pat}`;
}

function matchLine(name) {
  if (OTHER_BRANDS.test(name)) return null;
  // Standalone Noble strainers (slotted/tile-top/wave...) get strainer-only shots
  if (/noble.*(strnr|strainer)|tile\s*top\s*strainer/i.test(name) && !/connector/i.test(name)) {
    return freestyleVariant(name);
  }
  for (const [re, slug] of RULES) {
    if (!re.test(name)) continue;
    if (slug === 'freestyle-linear-drains') return freestyleVariant(name);
    return slug;
  }
  return null;
}

async function main() {
  console.log(`=== Attach Noble line images ===${DRY_RUN ? ' [DRY RUN]' : ''}\n`);
  const { rows } = await pool.query(`
    SELECT p.id, p.name, c.name category
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE v.code = 'EMS' AND p.status = 'active'
      AND c.name IN ('Shower Systems','Adhesives & Sealants','Surface Prep & Levelers',
                     'Installation & Sundries','Functional Hardware','Underlayment')
      AND NOT EXISTS (SELECT 1 FROM media_assets m JOIN skus s2 ON s2.id = m.sku_id WHERE s2.product_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM media_assets m2 WHERE m2.product_id = p.id AND m2.sku_id IS NULL AND m2.asset_type = 'primary')
  `);
  console.log(`Photoless candidate products: ${rows.length}`);

  const bySlug = new Map();
  let matched = 0;
  const unmatchedSample = [];
  const inserts = [];
  for (const r of rows) {
    const slug = matchLine(r.name);
    if (!slug) { if (unmatchedSample.length < 20 && /noble|fs\s|freestyle/i.test(r.name)) unmatchedSample.push(r.name); continue; }
    const url = LINES[slug]?.image;
    if (!url) continue;
    matched++;
    bySlug.set(slug, (bySlug.get(slug) || 0) + 1);
    inserts.push({ productId: r.id, url });
  }

  console.log(`Matched to a Noble line: ${matched}`);
  console.log('\nPer line:');
  for (const [slug, n] of [...bySlug.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${slug}`);
  console.log('\nUnmatched Noble-ish sample:');
  unmatchedSample.forEach(n => console.log(`  ✗ ${n}`));

  if (!DRY_RUN && inserts.length) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const ins of inserts) {
        await client.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
          VALUES ($1, NULL, 'primary', $2, $2, 0, 'noble-brand-site')
        `, [ins.productId, ins.url]);
      }
      await client.query('COMMIT');
      console.log(`\nInserted ${inserts.length} product-level primaries.`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
