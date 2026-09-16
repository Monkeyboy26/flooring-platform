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
 * NAMING (2026-09 re-onboard): product names are MATERIAL-QUALIFIED, matching the
 * vendor's own site naming ("Silver Travertine", "Black Basalt", "Blue Stone Marble
 * Ledger Panel", "Absolute Mist Porcelain Paver"). ALL-CAPS price-list remnants are
 * title-cased and typos fixed (Whie/Veneeer/Cappucino). This kills the old bare
 * color names ("Silver", "Black", "White") and the "(Limestone)/(Porcelain)"
 * disambiguation suffixes — material in the name disambiguates naturally.
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
// Area (sqft) of ONE piece from a "WxH" size in inches (e.g. 12x24 -> 2.0). Null
// for non-rectangular sizes (mosaics/patterns/ranges) so they stay call-for-price.
const areaFromSize = (sz) => {
  if (!sz || typeof sz !== 'string') return null;
  if (/mesh|pattern|random|free|split|chevron|herringbone|versailles/i.test(sz)) return null;
  const m = sz.replace(/[×X]/g, 'x').match(/^\s*([\d.]+)"?\s*x\s*([\d.]+)"?/);
  if (!m) return null;
  const a = (parseFloat(m[1]) * parseFloat(m[2])) / 144;
  return a >= 0.02 ? Math.round(a * 10000) / 10000 : null;
};

// Title-case + fix the handful of price-list typos so display names read clean.
const TYPO = [
  [/\bWhie\b/g, 'White'], [/\bTraverine\b/g, 'Travertine'], [/\bCappucino\b/g, 'Cappuccino'],
  [/\bVeneee?r\b/g, 'Veneer'], [/\bBlueStone\b/g, 'Blue Stone'],
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

// ALL-CAPS tokens from the price list ("ABSOLUTE MIST", "LAGOS GRAY", "(SIERRA)")
// -> Title Case. Leaves mixed-case tokens and dimension strings untouched.
function titleCaps(s) {
  if (!s) return s;
  return s.split(/\s+/).map(tok => {
    const core = tok.replace(/[()"',.]/g, '');
    if (core.length >= 2 && /^[A-Z]+$/.test(core)) {
      return tok.replace(core, core[0] + core.slice(1).toLowerCase());
    }
    return tok;
  }).join(' ');
}

// Normalize size strings for variant display: "8X18" -> "8x18", keep fractions.
const cleanSize = (sz) => sz ? sz.replace(/(\d)\s*[X×]\s*(\d)/g, '$1x$2').trim() : sz;

// Compact thickness label for a variant ("1-1/4\"" / "2\"").
const thickLabel = (t) => t ? String(t).replace(/\s+/g, '') : null;

// Edge profile of a pool coping, parsed from its desc.
function edgeProfile(desc) {
  const d = desc || '';
  if (/modern eased edge/i.test(d)) return 'Modern Eased Edge';
  if (/eased edge/i.test(d)) return 'Eased Edge';
  if (/bullnose/i.test(d)) return 'Bullnose';
  return null;
}

// A distinguishing surface-treatment token from the desc that isn't already in
// the variant — used to split SKUs that collide on size+finish (e.g. Walnut
// "Polished" that is really Unfilled vs Filled Vein-Cut travertine).
function descToken(desc, variant) {
  const d = (desc || '').toLowerCase();
  const v = (variant || '').toLowerCase();
  for (const t of ['Unfilled', 'Filled', 'Vein-Cut', 'Cross-Cut', 'Brushed', 'Chiseled', 'Straight Edge', 'Antiqued']) {
    const re = new RegExp('\\b' + t.replace(/-/g, '[- ]?') + '\\b', 'i');
    if (re.test(d) && !v.includes(t.toLowerCase())) return t;
  }
  return null;
}

// Ensure every SKU in a product has a unique display variant. Escalates:
// thickness -> desc treatment token; then drops exact duplicates (same variant
// AND cost, e.g. two item#s for the identical piece). Returns the kept SKUs.
function disambiguateVariants(skus) {
  const norm = (s) => s.variant_name.toLowerCase().replace(/\s+/g, ' ').trim();
  for (let pass = 0; pass < 3; pass++) {
    const groups = {};
    for (const s of skus) (groups[norm(s)] ||= []).push(s);
    let changed = false;
    for (const g of Object.values(groups)) {
      if (g.length < 2) continue;
      const thicks = new Set(g.map(s => s.attrs.thickness || ''));
      if (thicks.size > 1) {
        for (const s of g) {
          const tl = thickLabel(s.attrs.thickness);
          if (tl && !norm(s).includes(tl.toLowerCase())) { s.variant_name += ' ' + tl; changed = true; }
        }
        continue;
      }
      for (const s of g) {
        const tok = descToken(s._row.desc, s.variant_name);
        if (tok) { s.variant_name += ' ' + tok; changed = true; }
      }
    }
    if (!changed) break;
  }
  // Drop exact duplicates (identical variant + cost).
  const seen = new Set(), kept = [];
  let dropped = 0;
  for (const s of skus) {
    const k = norm(s) + '|' + s.cost;
    if (seen.has(k)) { dropped++; continue; }
    seen.add(k); kept.push(s);
  }
  return { kept, dropped };
}

const MAT_WORDS = /\b(Marble|Limestone|Travertine|Basalt|Dolomite|Porcelain|Slate|Sandstone|Composite)\b/gi;
const STRIP_PAREN = (s) => s.replace(/\s*\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();

// Family name WITH material from the sub-header:
//   "Silver Travertine - TILES"          -> "Silver Travertine"
//   "Crema Marfil Marble CLASSIC - TILES"-> "Crema Marfil Classic Marble"
//   "TAJ MAHAL LIGHT COMPOSITE MARBLE"   -> "Taj Mahal Light Composite Marble"
function familyMat(sub) {
  if (!sub) return null;
  let x = sub.replace(/\s*[-–—]\s*(TILES?|MOSAICS?( & TRIMS?)?|PAVERS?.*|POOL COPINGS?.*|SLAB.*|VENEERS?.*)\s*$/i, '').trim();
  const cm = x.match(/^Crema Marfil Marble (CLASSIC|SELECT)$/i);
  if (cm) x = `Crema Marfil ${titleCaps(cm[1].toUpperCase())} Marble`;
  x = titleCaps(cleanName(x));
  return x || null;
}

// Family WITHOUT the material word(s) ("Carrara White Marble" -> "Carrara White",
// "Dolomite White" -> "White") — used to find the family prefix inside a desc.
function familyBare(fam) {
  if (!fam) return null;
  const x = fam.replace(MAT_WORDS, '').replace(/\s+/g, ' ').trim();
  return x || fam;
}

// Rows whose desc identifies a DIFFERENT stone than their sub-header section.
// "Breccia Oniciata (Italian)" sits under the Breccia Bianco MOSAICS & TRIMS
// header but is its own Italian marble sold as 12x12/18x18 FIELD TILE (the
// vendor site titles them "... Marble Tile") — re-bucket + re-family.
function descOverride(r) {
  if (/^Breccia Oniciata/i.test(r.desc || '')) {
    return { family: 'Breccia Oniciata (Italian) Marble', bucket: 'tile' };
  }
  return null;
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

// ---------- naming ----------
// Determine the grouping/product identity for a row. Every name carries its
// material; ALL-CAPS is title-cased; typos fixed.
function productKey(r) {
  const material = r.material || '';
  const over = descOverride(r);
  const bucket = over ? over.bucket : r.bucket;
  const fam = over ? over.family : familyMat(r.sub);   // "Silver Travertine" | null

  let name, family;
  if (material === 'Porcelain') {
    // Porcelain descs are per-product ("ABSOLUTE MIST", "NOVABEL Lounge Ivory Tile").
    let base = titleCaps(cleanName(r.desc)).replace(/\s+Tiles?$/i, '').trim();
    family = base;
    name = base + ' Porcelain' + (BUCKET_SUFFIX[bucket] || (bucket === 'tile' ? ' Tile' : ''));
  } else if (['mosaic', 'pencil', 'chair_rail'].includes(bucket)) {
    // Inject the material into the desc-based name, in the vendor-site style:
    // "Carrara White Brick Mosaics" -> "Carrara White Marble Brick Mosaic".
    let base = titleCaps(cleanName(r.desc)).replace(/\bMosaics\b/g, 'Mosaic');
    base = base.replace(/\bOG \(Chair Rail\)/i, 'Ogee Chair Rail');
    base = base.replace(/Mosaic Antiqued$/i, 'Antiqued Mosaic');
    const bare = familyBare(fam);                       // "Carrara White" | "White"
    const bareShort = bare ? STRIP_PAREN(bare) : null;  // "Capri"
    if (fam && bare && base.toLowerCase().startsWith(bare.toLowerCase())) {
      name = fam + base.slice(bare.length);             // full-family prefix
    } else if (fam && bareShort && base.toLowerCase().startsWith(bareShort.toLowerCase())) {
      name = STRIP_PAREN(fam) + base.slice(bareShort.length); // "Capri Limestone Mosaic"
    } else {
      name = base;                                      // desc names its own stone
    }
    family = fam || name;
  } else if (['ledger_panel', 'ledger_corner'].includes(bucket)) {
    // "Silver Ledger Panel" + Travertine -> "Silver Travertine Ledger Panel"
    const base = titleCaps(cleanName(r.desc));
    const m = base.match(/^(.*?)\s+(Ledger (?:Panel|Corner))$/i);
    if (m && material && !new RegExp(`\\b${material}\\b`, 'i').test(m[1])) {
      name = `${m[1]} ${material} ${m[2]}`;
      family = `${m[1]} ${material}`;
    } else {
      name = base; family = base.replace(/\s+Ledger (Panel|Corner)$/i, '');
    }
  } else if (['veneer', 'veneer_corner'].includes(bucket)) {
    // "Royal White" (Limestone 8x18) -> "Royal White Limestone Veneer";
    // "CHATEAUX CREAM Veneer CORNERS" -> "Chateaux Cream Limestone Veneer Corner";
    // '4"x Random Ivory' -> "Ivory Travertine Veneer" (size lives in the variant).
    let base = titleCaps(cleanName(r.desc));
    base = base.replace(/\s*Veneer\s*Corners?$/i, '').replace(/\s*Veneers?$/i, '').trim();
    base = base.replace(/^[\d"'\s]*x\s*Random\s+/i, '').trim();   // drop leading size prefix
    const kind = bucket === 'veneer_corner' ? 'Veneer Corner' : 'Veneer';
    const hasMat = material && new RegExp(`\\b${material}\\b`, 'i').test(base);
    name = hasMat ? `${base} ${kind}` : `${base} ${material} ${kind}`.replace(/\s+/g, ' ').trim();
    family = hasMat ? base : `${base} ${material}`.trim();
  } else {
    // Field tile / paver / pool coping / slab: family+material carries the name.
    let base = fam;
    if (!base) {
      base = titleCaps(cleanName(r.desc));
      base = base.replace(/\b(Filled|Unfilled|Vein[- ]?Cut|Cross[- ]?Cut|Brushed|Chiseled|Honed|Tumbled|Polished|and|&|With Porcelain Backing)\b.*$/i, '').trim() || base;
      if (material && !new RegExp(`\\b${material}\\b`, 'i').test(base)) base = `${base} ${material}`;
    }
    name = base + (BUCKET_SUFFIX[bucket] || '');
    family = base;
  }

  name = name.replace(/\s+/g, ' ').trim();
  family = (family || name).replace(/\s+/g, ' ').trim();
  const keyBucket = bucket === 'pool_coping' ? 'coping' : bucket === 'slab' ? 'tile' : bucket;
  return { key: [material, keyBucket, name].join('||'), name, family, material, bucket };
}

// ---------- selling conventions per bucket ----------
function skuEconomics(r, bucket) {
  const uom = (r.uom || '').toUpperCase();
  const sfPiece = num(r.sf_piece);
  const sfBox = num(r.sf_box);
  const pcsBox = num(r.pcs_box);
  const price = parseCost(r.cost);           // PDF PRICE = Roma cost

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
  } else if (bucket === 'ledger_panel') {
    // ~1 sqft split-face panels sold PER PANEL, not per sqft (platform convention:
    // ledger sells per unit — see DQ rule mosaic-not-per-sheet).
    const panel = sfPiece || 1;
    sell_by = 'unit'; price_basis = 'per_unit';
    cost = money((uom === 'SF') ? price * panel : price);
    sqft_per_box = sfBox || null; pieces_per_box = pcsBox || null;
  } else if (bucket === 'slab') {
    sell_by = 'unit'; price_basis = 'per_unit';
    cost = money(price);                     // per SF, size TBD — priced per slab downstream
  } else if (sfBox > 0) {
    // Genuinely boxed field tile — sold by the box, priced per sqft.
    sell_by = 'sqft'; price_basis = 'per_sqft';
    cost = money(price);
    sqft_per_box = sfBox; pieces_per_box = pcsBox;
  } else {
    // Loose natural stone (tile/paver/coping) with no box packaging is sold BY
    // THE PIECE. Keep the per-SF rate but mark it as a unit with the piece area,
    // so storefront/rep compute piece price = rate × area (no call-for-price).
    const area = sfPiece || areaFromSize(r.size);
    cost = money(price);
    if (area > 0) {
      sell_by = 'unit'; price_basis = 'per_sqft';
      sqft_per_box = area; pieces_per_box = 1;
    } else {
      sell_by = 'sqft'; price_basis = 'per_sqft';   // no clean size — stays call-for-price
    }
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
let droppedDupes = 0;
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
      color: g.collection,
      collection: g.collection,
      look: g.material === 'Porcelain' ? 'Stone Look' : g.material,
    },
    skus: [],
  };
  for (const r of g._rows) {
    const eco = skuEconomics(r, g.bucket);
    let vsku = (r.item || '').trim();
    let internal = vsku ? `STX-${vsku}` : `STX-${slugify(g.name + '-' + (r.size || '') + '-' + (r.finish || ''))}`;
    // guarantee uniqueness of internal_sku
    let base = internal, n = 2;
    while (usedSku.has(internal)) internal = `${base}-${n++}`;
    usedSku.add(internal);
    skuCount++;
    const size = cleanSize(r.size);
    const sizeForVariant = size && !/^TBD$/i.test(size) ? size : null;
    // Pool copings differ by edge profile (Bullnose vs Modern Eased Edge) and
    // thickness (3cm vs 5cm) with no finish — bake both into the variant so the
    // pieces are distinguishable; other buckets use size + finish.
    const edge = g.bucket === 'pool_coping' ? edgeProfile(r.desc) : null;
    const variantBits = g.bucket === 'pool_coping'
      ? [sizeForVariant, edge, thickLabel(r.thick)].filter(Boolean).join(' ')
      : [sizeForVariant, cleanFinish(r.finish)].filter(Boolean).join(' ');
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
        size: sizeForVariant,
        thickness: r.thick || null,
        shape: shapeFor(g.bucket, r),
        edge: edge || null,
      },
      _flags: { on_sale: r.on_sale, is_new: r.is_new, made_usa: r.made_usa },
      _row: r,
    });
  }
  // Split any SKUs that still collide on size+finish (thickness / treatment), and
  // drop exact duplicate item#s (same piece, two price-list rows).
  const { kept, dropped } = disambiguateVariants(product.skus);
  droppedDupes += dropped;
  product.skus = kept;
  for (const s of product.skus) delete s._row;
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
// constraint ignores material, so two same-named products would collapse into one
// row on import. Material-in-name makes this nearly impossible now, but keep the
// guard: disambiguate by appending the material.
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
for (const p of catalog) { delete p._disamb; }
const matCount = {};
for (const p of catalog) { matCount[p.material] = (matCount[p.material] || 0) + 1; }
for (const p of catalog) { delete p.material; }  // strip build-only field

fs.writeFileSync(path.join(DATA_DIR, 'catalog.json'), JSON.stringify(catalog, null, 1));

// ---------- summary ----------
const byCat = {};
for (const p of catalog) { byCat[p.category_slug] = (byCat[p.category_slug] || 0) + 1; }
console.log(`Products: ${catalog.length}`);
console.log(`SKUs:     ${skuCount - droppedDupes} (dropped ${droppedDupes} duplicate item#s)`);
console.log('By category:', byCat);
console.log('By material:', matCount);
console.log('Wrote', path.join(DATA_DIR, 'catalog.json'));
