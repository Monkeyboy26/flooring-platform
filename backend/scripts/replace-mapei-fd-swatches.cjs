#!/usr/bin/env node
/**
 * Replace Floor & Decor (i8.amplience.net) per-color swatch images on the
 * Mapei grout/caulk SKUs with self-hosted solid-color chips generated from
 * Mapei's OFFICIAL palette hex values.
 *
 * Source of hex values: Mapei Ultracolor Plus FA color palette
 *   https://www.mapei.com/us/en-us/products-and-solutions/products/detail/ultracolor-plus-fa
 * (each swatch is published as an inline `background-color:#RRGGBB` chip).
 *
 * The F&D-hosted photos had "Floor & Decor" branding baked in; these chips are
 * fully owned (served from /uploads/mapei-swatches/) with no third-party marks.
 *
 * Usage:
 *   node backend/scripts/replace-mapei-fd-swatches.cjs          # apply
 *   node backend/scripts/replace-mapei-fd-swatches.cjs --dry    # preview only
 */
const path = require('path');
const fs = require('fs');
const sharp = require(path.join(__dirname, '..', 'node_modules', 'sharp'));
const { Pool } = require(path.join(__dirname, '..', 'node_modules', 'pg'));

const DRY = process.argv.includes('--dry');

// Mapei official palette (name -> hex). Names normalized (leading color # stripped).
const PALETTE = {
  'Alabaster': '#C6BFB3', 'Pewter': '#A49E95', 'Bahama Beige': '#7E7166',
  'Chamois': '#A9917D', 'Harvest': '#CAB397', 'Chocolate': '#5F5148',
  'Gray': '#78706A', 'Black': '#4A4A4A', 'Sahara Beige': '#898178',
  'Biscuit': '#D3C7B6', 'Bone': '#C9B6A3', 'Pearl Gray': '#7F7E7F',
  'Silver': '#A8A6A2', 'Avalanche': '#EDE9E2', 'Ivory': '#B9AC9C',
  'Mocha': '#867162', 'Pale Umber': '#BFA58C', 'Charcoal': '#625F5B',
  'Light Almond': '#E0D2BF', 'Frost': '#D3CFCA', 'Cocoa': '#6C5950',
  'Warm Gray': '#C5C0BA', 'Rain': '#C1C4C4', 'Cobblestone': '#B7B4B1',
  'Timberwolf': '#9E9C9C', 'Driftwood': '#9E9180', 'Iron': '#827F7B',
  'Eggshell': '#E9E5D9', 'Moonbeam': '#E5E2DE', 'Honey Butter': '#E8DBD0',
  'Honeybutter': '#E8DBD0', 'Oatmeal': '#D6C8C0', 'Wicker': '#B8A297',
  'Sandstorm': '#A28A7F', 'Nutmeg': '#7D635A', 'Castle Wall': '#C6C5BC',
  'Cavern Moss': '#8D918B', 'Sea Salt': '#D0D4D2', 'Armor': '#9EA4A6',
  'Deep Ocean': '#5F6D76', 'Night Sky': '#48545C',
  // Keracaulk-only colors (not in the 40-swatch FA chart)
  'Jet Black': '#1C1C1C', 'Pure White': '#F5F4EF',
};
const PALETTE_SRC = 'https://www.mapei.com/us/en-us/products-and-solutions/products/detail/ultracolor-plus-fa';

const OUT_DIR = path.join(__dirname, '..', '..', 'uploads', 'mapei-swatches');
const URL_BASE = '/uploads/mapei-swatches';
const SIZE = 400;

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function genChip(hex, file) {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  await sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: { r, g, b } } })
    .png().toFile(file);
}

function normalize(name) {
  if (PALETTE[name]) return name;
  // strip leading Mapei number ("5014 Biscuit" -> "Biscuit")
  const stripped = name.replace(/^\d+\s+/, '').trim();
  if (PALETTE[stripped]) return stripped;
  // case-insensitive
  const hit = Object.keys(PALETTE).find(k => k.toLowerCase() === stripped.toLowerCase());
  return hit || null;
}

(async () => {
  const pool = new Pool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  // Pull the F&D swatch rows to replace (Mapei only; leave Schluter for a separate pass)
  const { rows } = await pool.query(`
    SELECT ma.id, ma.url, ma.asset_type, s.variant_name, p.name AS product
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN brands b ON b.id = p.brand_id
    LEFT JOIN skus s ON s.id = ma.sku_id
    WHERE b.name ILIKE '%mapei%' AND ma.url ILIKE '%flooranddecor%'
    ORDER BY p.name, s.variant_name`);

  console.log(`Found ${rows.length} Mapei F&D swatch rows to replace.\n`);

  // Map each row -> palette color, collect the unique chips we need
  const needed = new Map(); // slug -> hex
  const plan = [];
  const unmatched = [];
  for (const r of rows) {
    const key = normalize(r.variant_name || '');
    if (!key) { unmatched.push(r.variant_name); continue; }
    const hex = PALETTE[key];
    const sl = slug(key);
    needed.set(sl, hex);
    plan.push({ id: r.id, product: r.product, color: r.variant_name, hex, url: `${URL_BASE}/${sl}.png` });
  }

  if (unmatched.length) {
    console.log('⚠️  Unmatched colors (no palette hex):', unmatched.join(', '), '\n');
  }

  console.log(`Will generate ${needed.size} unique color chips → ${OUT_DIR}`);
  console.log(`Will repoint ${plan.length} media_assets rows.\n`);
  plan.slice(0, 6).forEach(p => console.log(`  ${p.product} / ${p.color}  ${p.hex} -> ${p.url}`));
  console.log('  ...\n');

  if (DRY) { console.log('DRY RUN — no files written, no DB changes.'); await pool.end(); return; }

  // 1) generate chips
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [sl, hex] of needed) {
    await genChip(hex, path.join(OUT_DIR, `${sl}.png`));
  }
  console.log(`✓ Generated ${needed.size} PNG chips.`);

  // 2) update DB rows
  let updated = 0;
  for (const p of plan) {
    await pool.query(
      `UPDATE media_assets SET url = $1, original_url = $2, source = 'mapei-hex' WHERE id = $3`,
      [p.url, PALETTE_SRC, p.id]);
    updated++;
  }
  console.log(`✓ Updated ${updated} media_assets rows (source='mapei-hex').`);

  // verify no F&D left on Mapei
  const { rows: left } = await pool.query(`
    SELECT count(*)::int AS n FROM media_assets ma
    JOIN products p ON p.id=ma.product_id JOIN brands b ON b.id=p.brand_id
    WHERE b.name ILIKE '%mapei%' AND ma.url ILIKE '%flooranddecor%'`);
  console.log(`\nRemaining Mapei F&D rows: ${left[0].n}`);

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
