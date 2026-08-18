#!/usr/bin/env node
/**
 * Build the StoneX Tile & Stone catalog.json from the parsed April-2026 price list.
 *
 * StoneX Tile and Stone Inc. (Anaheim, CA) is a natural-stone importer/distributor:
 * porcelain tiles/pavers/pool-copings, marble/limestone/travertine/basalt/dolomite
 * tiles + mosaics + pencils/chair-rails, pavers, pool copings, ledger panels/corners
 * and stone veneers. The price-list PRICE column is Roma's COST (FOB Anaheim,
 * full-box quantities). Retail = cost x 1.6 keystone rounded to $0.05 — the store
 * standard used by the Stanza / Garrison / PDI / AFD onboardings ([[selling-conventions]]).
 *
 * Input:  backend/data/stonex/source-rows.json  (390 rows parsed from the PDF w/
 *         pdfplumber, each carrying section / sub-header / bucket / flag context)
 * Output: backend/data/stonex/catalog.json      (grouped into color/collection
 *         products, each with size/finish SKUs, attrs, packaging & pricing)
 *
 * Selling conventions applied here:
 *   - Field tiles / pavers / pool-copings / ledger panels / veneers (UOM=SF):
 *       sell_by='sqft', price_basis='per_sqft', cost = per-SF price as-is.
 *   - Mosaic sheets (UOM=SF): sell_by='unit', price_basis='per_unit',
 *       cost = per-SF price x one-sheet coverage, pieces_per_box=1.
 *   - Pencils / chair-rails / corners / slabs (UOM=EA/PIECE/LF): sell_by='unit',
 *       price_basis='per_unit', cost = per-piece price as-is; trim = accessory.
 *
 * Usage: node scripts/build-stonex-catalog.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'stonex');
const rows = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'source-rows.json'), 'utf8'));

// ---------- helpers ----------
const round05 = (n) => Math.round((n * 1.6) / 0.05) * 0.05;      // keystone x1.6 -> nearest $0.05
const money = (n) => Math.round(n * 100) / 100;
const parseCost = (s) => parseFloat(String(s).replace(/[^0-9.]/g, '')) || 0;
const num = (s) => { const n = parseFloat(String(s).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : null; };

// Title-case + fix the handful of price-list typos so display names read clean.
const TYPO = [
  [/\bWhie\b/g, 'White'], [/\bTraverine\b/g, 'Travertine'], [/\bCappucino\b/g, 'Cappuccino'],
  [/\bAlabastrino Ivory\b/g, 'Alabastrino (Ivory)'], [/\bMarfil\b/g, 'Marfil'],
];
function cleanName(s) {
  let x = (s || '').replace(/\s+/g, ' ').trim();
  // strip sale / new / special tags
  x = x.replace(/\s*[-–—]*\s*(ON SALE!!!|ON SPECIAL!!!|NEW!!!|SALE!!!|SPECIAL ORDER ONLY|SPECIAL!!!)\s*$/gi, '');
  x = x.replace(/\s*[-–—]\s*(NEW|SALE|SPECIAL)\b.*$/gi, '');
  x = x.replace(/-NEW\b/gi, '').replace(/!!!/g, '');
  for (const [re, to] of TYPO) x = x.replace(re, to);
  return x.replace(/\s+/g, ' ').trim();
}

// Family name derived from the sub-header ("Carrara White Marble - TILES" -> "Carrara White").
const MAT_WORDS = /\b(Marble|Limestone|Travertine|Basalt|Dolomite|Porcelain|Slate|Sandstone|Composite)\b/gi;
function familyFromSub(sub) {
  if (!sub) return null;
  let x = sub.replace(/\s*[-–—]\s*(TILES?|MOSAICS?( & TRIMS?)?|PAVERS?.*|POOL COPINGS?.*|SLAB.*|VENEERS?.*)\s*$/i, '');
  x = x.replace(MAT_WORDS, '').replace(/\s+/g, ' ').trim();
  x = x.replace(/\s*[-–—]\s*$/, '').trim();
  return cleanName(x) || null;
}

// Color family bucket for filtering (coarse).
function colorFamily(name, material) {
  const n = (name + ' ' + material).toLowerCase();
  if (/(nero|black|noce|walnut|graphite|basalt|emperador dark)/.test(n)) return 'Black';
  if (/(white|blanco|thassos|bianco|polar|dolomite|arctic|freedom|oriental|snow|alba)/.test(n)) return 'White';
  if (/(gray|grey|silver|argento|tundra|valensa|nordic|inca|london|cinderella|mist|cosmos|blue stone)/.test(n)) return 'Gray';
  if (/(gold|golden|yellow|sienna|beige|cream|marfil|ivory|sand|champagne|crema|caramel|noce|walnut|mocha|cappuccino|porto|euro|caen|honey|nova gold)/.test(n)) return 'Beige';
  if (/(green|verde|empress|seagrass)/.test(n)) return 'Green';
  if (/(blue|azul|caracas|lagos|belgian|nova blue|atlantis)/.test(n)) return 'Blue';
  if (/(calacatta|carrara|skyline)/.test(n)) return 'White';
  if (/(emperador|brown|coffee|mocha)/.test(n)) return 'Brown';
  return 'Multicolor';
}

// Category slug per bucket + material.
function categorySlug(bucket, material) {
  switch (bucket) {
    case 'mosaic': return 'mosaic-tile';
    case 'pencil':
    case 'chair_rail': return 'trim-accessories';
    case 'pool_coping': return 'pool-coping';
    case 'ledger_panel':
    case 'ledger_corner':
    case 'veneer':
    case 'veneer_corner': return 'stacked-stone';
    case 'paver': return 'pavers';
    case 'slab': return 'natural-stone';
    case 'tile':
    default:
      return material === 'Porcelain' ? 'porcelain-tile' : 'natural-stone';
  }
}

const BUCKET_SUFFIX = {
  paver: ' Paver', pool_coping: ' Pool Coping', slab: ' Slab',
};

// Determine the grouping/product identity for a row.
function productKey(r) {
  const material = r.material || '';
  const bucket = r.bucket;
  // Mosaics / pencils / chair-rails / corners / ledger / veneer are identified by their
  // own descriptive name (they vary within a family); everything else groups by family.
  const byDesc = ['mosaic', 'pencil', 'chair_rail', 'ledger_panel', 'ledger_corner', 'veneer', 'veneer_corner'].includes(bucket);
  let base;
  if (byDesc) {
    base = cleanName(r.desc);
  } else if (material === 'Porcelain') {
    base = cleanName(r.desc);                       // porcelain has no per-color sub-header
  } else {
    base = familyFromSub(r.sub) || cleanName(r.desc);
  }
  // strip any stray finish words the desc column absorbed (Silver "Filled &", "and", etc.)
  if (!byDesc) {
    base = base.replace(/\b(Filled|Unfilled|Vein[- ]?Cut|Cross[- ]?Cut|Brushed|Chiseled|Honed|Tumbled|Polished|and|&|With Porcelain Backing)\b.*$/i, '').trim() || base;
  }
  const family = (material === 'Porcelain') ? cleanName(r.desc) : (familyFromSub(r.sub) || base);
  const name = base + (BUCKET_SUFFIX[bucket] || '');
  return { key: [material, bucket === 'pool_coping' ? 'coping' : bucket === 'slab' ? 'tile' : bucket, name].join('||'), name, family, material, bucket };
}

// ---------- selling conventions per bucket ----------
function skuEconomics(r) {
  const bucket = r.bucket;
  const uom = (r.uom || '').toUpperCase();
  const sfPiece = num(r.sf_piece);
  const sfBox = num(r.sf_box);
  const pcsBox = num(r.pcs_box);
  const price = parseCost(r.cost);           // PDF PRICE = Roma cost

  const perUnitBuckets = ['mosaic', 'pencil', 'chair_rail', 'ledger_corner', 'veneer_corner', 'slab'];
  let sell_by, price_basis, cost, sqft_per_box = null, pieces_per_box = null, variant_type = null;

  if (bucket === 'mosaic') {
    const sheet = sfPiece || 1;              // one-sheet coverage
    sell_by = 'unit'; price_basis = 'per_unit';
    // UOM=SF -> price is per-SF, convert to per-sheet; UOM=EA/PIECE -> already per-sheet
    cost = money((uom === 'SF') ? price * sheet : price);
    sqft_per_box = sheet; pieces_per_box = 1;
  } else if (bucket === 'pencil' || bucket === 'chair_rail') {
    sell_by = 'unit'; price_basis = 'per_unit'; variant_type = 'accessory';
    cost = money(price);                     // already per piece (UOM EA/PIECE)
    pieces_per_box = pcsBox;
  } else if (bucket === 'ledger_corner' || bucket === 'veneer_corner') {
    sell_by = 'unit'; price_basis = 'per_unit';
    cost = money(price);                     // per piece / per LF
    pieces_per_box = pcsBox;
  } else if (bucket === 'slab') {
    sell_by = 'unit'; price_basis = 'per_unit';
    cost = money(price);                     // per SF, size TBD — priced per slab downstream
  } else {
    // tile, paver, pool_coping, ledger_panel, veneer  (all UOM=SF, area-priced)
    sell_by = 'sqft'; price_basis = 'per_sqft';
    cost = money(price);
    sqft_per_box = sfBox; pieces_per_box = pcsBox;
  }
  return { sell_by, price_basis, cost, retail: money(round05(cost)), sqft_per_box, pieces_per_box, variant_type };
}

// ---------- descriptions ----------
const MAT_BLURB = {
  Porcelain: 'Through-body porcelain with low water absorption — frost-resistant and hard-wearing for floors, walls and outdoor pavers.',
  Marble: 'Genuine quarried marble; natural veining, color and texture variation are expected and part of the material’s character.',
  Limestone: 'Natural limestone with soft, earthy tone and subtle fossil texture; a warm, matte alternative to marble.',
  Travertine: 'Classic travertine with natural pitting and movement; timeless for floors, walls, patios and pool decks.',
  Basalt: 'Dense volcanic basalt — a clean, uniform dark stone that reads contemporary indoors and out.',
  Dolomite: 'Bright dolomitic marble — harder and more stain-resistant than classic white marble with a crisp, clean look.',
  Slate: 'Natural cleft slate with rich, layered color for feature walls and rustic floors.',
  Sandstone: 'Warm natural sandstone with organic texture for veneer and feature applications.',
};
function describe(prod) {
  const finishes = [...new Set(prod.skus.map(s => s.attrs.finish).filter(Boolean))];
  const sizes = [...new Set(prod.skus.map(s => s.attrs.size).filter(Boolean))];
  const parts = [];
  parts.push(`${prod.name} — ${prod.material.toLowerCase()} from StoneX Tile.`);
  parts.push(MAT_BLURB[prod.material] || '');
  if (finishes.length) parts.push(`Available in ${finishes.join(', ').toLowerCase()} finish${finishes.length > 1 ? 'es' : ''}.`);
  if (sizes.length) parts.push(`Sizes: ${sizes.join(', ')}.`);
  parts.push('Sold in full-box quantities, FOB Anaheim.');
  return parts.filter(Boolean).join(' ');
}

// ---------- build ----------
const groups = new Map();
for (const r of rows) {
  const { key, name, family, material, bucket } = productKey(r);
  if (!groups.has(key)) {
    groups.set(key, {
      name,
      collection: family || name,
      category_slug: categorySlug(bucket, material),
      material,
      bucket,
      section: r.section,
      _rows: [],
    });
  }
  groups.get(key)._rows.push(r);
}

const catalog = [];
const usedSku = new Set();
const slugSeen = new Set();
let skuCount = 0;
for (const g of groups.values()) {
  const cfam = colorFamily(g.name, g.material);
  const product = {
    name: g.name,
    collection: g.collection,
    slug: null,   // filled below
    category_slug: g.category_slug,
    material: g.material,
    description: '',
    attrs: {
      material: g.material,
      color: g.name,
      collection: g.collection,
      look: g.material === 'Porcelain' ? 'Stone Look' : g.material,
    },
    skus: [],
  };
  for (const r of g._rows) {
    const eco = skuEconomics(r);
    let vsku = (r.item || '').trim();
    let internal = vsku ? `STX-${vsku}` : `STX-${slugify(g.name + '-' + (r.size || '') + '-' + (r.finish || ''))}`;
    // guarantee uniqueness of internal_sku
    let base = internal, n = 2;
    while (usedSku.has(internal)) internal = `${base}-${n++}`;
    usedSku.add(internal);
    skuCount++;
    const variantBits = [r.size, cleanFinish(r.finish)].filter(Boolean).join(' ');
    product.skus.push({
      internal_sku: internal,
      vendor_sku: vsku || internal,   // price list has no item# for a few rows — fall back to internal

      variant_name: variantBits || g.name,
      cost: eco.cost,
      retail: eco.retail,
      sell_by: eco.sell_by,
      price_basis: eco.price_basis,
      sqft_per_box: eco.sqft_per_box,
      pieces_per_box: eco.pieces_per_box,
      variant_type: eco.variant_type,
      attrs: {
        finish: cleanFinish(r.finish),
        size: r.size || null,
        thickness: r.thick || null,
        shape: shapeFor(g.bucket, r),
      },
      _flags: { on_sale: r.on_sale, is_new: r.is_new, made_usa: r.made_usa },
    });
  }
  product.slug = uniqueSlug(slugify(`stonex-${g.material}-${g.name}-${g.bucket}`));
  product.description = describe(product);
  catalog.push(product);
}

// ---------- small utils used above ----------
function slugify(s) {
  return String(s).toLowerCase().replace(/["'()]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
function uniqueSlug(s) { let x = s, n = 2; while (slugSeen.has(x)) x = `${s}-${n++}`; slugSeen.add(x); return x; }
// Canonicalize finish values so equivalent finishes collapse to one variant pill.
// The price list spells the same finish several ways ("Filled &Honed" / "Filled and
// Honed" / "Filled&Honed"; "Brushed / Chiseled" vs "Brushed/Chiseled") — left as-is
// they render as duplicate, mostly-greyed pills on the PDP.
function cleanFinish(f) {
  if (!f) return null;
  let x = f.replace(/\s+/g, ' ').trim();
  x = x.replace(/\bfilled and honed\b/gi, 'Filled & Honed'); // before generic "and"->"&"
  x = x.replace(/\band\b/gi, '&');
  x = x.replace(/\s*&\s*/g, ' & ');           // consistent " & " spacing
  x = x.replace(/\s*\/\s*/g, '/');            // slashes with no surrounding spaces
  x = x.replace(/vein[\s-]*cut/gi, 'Vein-Cut');
  x = x.replace(/cross[\s-]*cut/gi, 'Cross-Cut');
  x = x.replace(/\braked\b/gi, 'Raked');
  return x.replace(/\s+/g, ' ').trim();
}
function shapeFor(bucket, r) {
  const d = (r.desc || '').toLowerCase();
  if (bucket === 'mosaic') {
    if (/hexagon/.test(d)) return 'Hexagon';
    if (/herringbone/.test(d)) return 'Herringbone';
    if (/brick/.test(d)) return 'Brick';
    if (/square/.test(d)) return 'Square';
    if (/wavy/.test(d)) return 'Wavy';
    return 'Mosaic';
  }
  if (bucket === 'pencil' || bucket === 'chair_rail') return 'Linear Trim';
  if (/french pattern/.test(d)) return 'French Pattern';
  return null;
}

// Resolve (collection, name) collisions — the products_vendor_collection_name_unique
// constraint ignores material, so e.g. a porcelain and a limestone "Cardinal Beige Paver"
// would collapse into one row on import. Disambiguate by appending the material.
const seenCN = new Map();
for (const p of catalog) {
  const k = p.collection + '||' + p.name;
  if (seenCN.has(k)) {
    const first = seenCN.get(k);
    if (!first._disamb) { first.name = `${first.name} (${first.material})`; first._disamb = true; }
    p.name = `${p.name} (${p.material})`;
  } else {
    seenCN.set(k, p);
  }
}
for (const p of catalog) { delete p._disamb; delete p.material; }  // strip build-only fields

fs.writeFileSync(path.join(DATA_DIR, 'catalog.json'), JSON.stringify(catalog, null, 1));

// ---------- summary ----------
const byCat = {}, byMat = {};
for (const p of catalog) { byCat[p.category_slug] = (byCat[p.category_slug] || 0) + 1; byMat[p.material] = (byMat[p.material] || 0) + 1; }
console.log(`Products: ${catalog.length}`);
console.log(`SKUs:     ${skuCount}`);
console.log('By category:', byCat);
console.log('By material:', byMat);
console.log('Wrote', path.join(DATA_DIR, 'catalog.json'));
