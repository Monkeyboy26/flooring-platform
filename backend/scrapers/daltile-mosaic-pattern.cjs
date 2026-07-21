/**
 * daltile-mosaic-pattern.cjs
 *
 * Decodes the mosaic LAYOUT / pattern (Brick Joint, Penny Round, Trapezoid,
 * Kaleidoscope, Fish Scale, …) for a Daltile SKU so it can be stated in the
 * variant name. Coveo's `designPattern` is blank for most mosaics, so sheets
 * that differ only by layout all showed the same bare "size, finish" label.
 *
 * The pattern is read from the VENDOR_SKU shape code — the letters after the
 * 4-char color prefix (`FL07 BKJ 24 MT` → BKJ = Brick Joint). That code is
 * per-SKU authoritative. The image filename is deliberately NOT used: Daltile
 * shares one render across a color's straight-joint / hexagon / penny variants,
 * so parsing the pattern out of the image mislabels the siblings.
 *
 * Used by scripts/daltile-enrich-mosaic-patterns.cjs (one-time backfill) and
 * scrapers/daltile-unified.js (import-time), so names stay consistent.
 */

'use strict';

const { skuIsTrim } = require('./daltile-image-rank.cjs');

// Vendor_sku shape code → display pattern. Matched as a PREFIX of the shape
// token (longest key first) so glued finish suffixes (WIDPL, TRIHN, PENNYMT)
// still resolve. Codes whose name is already descriptive (STJ, HEX, HER, …) are
// included so the dedup guard recognizes and skips them.
const SHAPE_PATTERNS = {
  // Matched as a prefix of the shape token, LONGEST KEY FIRST (see SHAPE_KEYS),
  // so glued finish suffixes and shorter codes don't shadow longer ones.
  ILUILLUS: 'Illusiary',
  RNDIL: 'Random Interlocking',
  ORPNY: 'Penny Round',
  ORHEX: 'Hexagon',
  PENNY: 'Penny Round',
  LINRG: 'Linked Ring',
  CHAIN: 'Chain Link',
  CUBIS: 'Cubist',
  PARQU: 'Parquet',
  WINDB: 'Windblown',
  MELOD: 'Melody',
  KAPAL: 'Kapali',
  INTMX: 'Intermix',
  SHAPT: 'Shapestry',
  RADNT: 'Radiant',
  PETAL: 'Petal',
  BALAN: 'Balance',
  HYPNO: 'Hypnotic',
  IMAG: 'Imaginare',
  MELD: 'Melded',
  STK: 'Stacked Joint',
  STJ: 'Straight Joint',
  STS: 'Straight Stack',
  HER: 'Herringbone',
  HEX: 'Hexagon',
  HHX: 'Half Hex',
  PHX: 'Pyramid Hex',
  FHX: 'Framed Hex',
  HXL: 'Hypnotic XL',
  BXL: 'Balance XL',
  CHV: 'Chevron',
  HAR: 'Harlequin',
  ARB: 'Arabesque',
  ARW: 'Archway',
  ARG: 'Argyle',
  AHS: 'Arches',
  ACR: 'Arch Reflections',
  LTW: 'Lattice Weave',
  PCK: 'Picket',
  BKJ: 'Brick Joint',
  BKW: 'Basketweave',
  PNR: 'Penny Round',
  PNY: 'Penny Round',
  FAN: 'Fan',
  EFN: 'Elongated Fan',
  KAL: 'Kaleidoscope',
  CIR: 'Circle',
  STR: 'Structural',
  ODT: 'Octagon Dot',
  TPZ: 'Trapezoid',
  FSL: 'Fish Scale',
  PCL: 'Pencil',
  RNS: 'Random Strip',
  RNL: 'Random Linear',
  RND: 'Random',
  PYR: 'Pyramid',
  FLR: 'Floret',
  WID: 'Window',
  WIN: 'Windmill',
  TRI: 'Triangle',
  FTR: 'Feather',
  FPB: 'Flat Pebble',
  STP: 'Striped Pebble',
  THP: 'Tri-Hex Pebble',
  RBL: 'River Pebble',
  PBL: 'Pebble',
  RDP: 'Raindrop',
  BAR: 'Baroque',
  CPS: 'Capsule',
  ING: 'Ingot',
  OVL: 'Oval',
  BLS: 'Blossom',
  LAN: 'Lantern',
  SWV: 'Swivel',
  REV: 'Reverse',
  DAS: 'Dash',
  SPG: 'Spring',
  HNG: 'Hinge',
  ZIP: 'Zipper',
  TRF: 'Trifecta',
  WDG: 'Wedge',
  MZE: 'Maze',
  TRC: 'Trace',
  BNS: 'Bannister',
  LF: 'Leaf',
};

// Longest keys first for prefix matching.
const SHAPE_KEYS = Object.keys(SHAPE_PATTERNS).sort((a, b) => b.length - a.length);

// Every pattern word we know — used to detect a pattern the name ALREADY states
// (so we never append a second, possibly conflicting one).
const KNOWN_PATTERN_WORDS = [
  'straight joint', 'stacked joint', 'straight stack', 'herringbone', 'hexagon',
  'half hex', 'pyramid hex', 'framed hex', 'chevron', 'harlequin', 'arabesque',
  'lattice', 'picket', 'brick joint', 'basketweave', 'penny', 'fan',
  'kaleidoscope', 'circle', 'structural', 'octagon', 'trapezoid', 'fish scale',
  'pencil', 'random', 'pyramid', 'floret', 'window', 'windmill', 'triangle',
  'feather', 'pebble', 'cube', 'wave', 'diamond', 'spiga', 'cloe', 'pinwheel',
  'leaf', 'baroque', 'raindrop', 'capsule', 'patchwork', 'argyle', 'archway',
  'arch reflections', 'arches', 'linked ring', 'chain link', 'cubist', 'parquet',
  'swivel', 'windblown', 'reverse', 'dash', 'melody', 'melded', 'kapali',
  'intermix', 'illusiary', 'spring', 'hinge', 'shapestry', 'blossom', 'lantern',
  'ingot', 'oval', 'imaginare', 'radiant', 'zipper', 'petal', 'trifecta',
  'wedge', 'maze', 'trace', 'bannister', 'hypnotic', 'balance',
];

const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Whether the image URL / product looks like a mosaic (used only to gate which
 * SKUs we consider — not to derive the pattern).
 */
function isMosaicUrl(url) {
  return !!url && /_?msc/i.test(url);
}

/**
 * Decode the pattern from the vendor_sku shape code (letters after the 4-char
 * color prefix), or null if the code is unknown.
 */
function patternFromVendorSku(vendorSku) {
  if (!vendorSku || vendorSku.length < 5) return null;
  const shape = vendorSku.slice(4).match(/^([A-Z]+)/i);
  if (!shape) return null;
  const token = shape[1].toUpperCase();
  for (const key of SHAPE_KEYS) {
    if (token.startsWith(key)) return SHAPE_PATTERNS[key];
  }
  return null;
}

function nameAlreadyHasPattern(name) {
  const n = normalize(name);
  return KNOWN_PATTERN_WORDS.some((w) => n.includes(normalize(w)));
}

/**
 * Resolve the mosaic pattern to state for a SKU, or null when there's nothing
 * to add. Returns null for trims, non-mosaics, unknown shape codes, and names
 * that already state a pattern.
 *
 * @param {object} p
 * @param {string} p.vendorSku
 * @param {string} [p.imageUrl]     primary image URL (only a mosaic gate)
 * @param {string} [p.currentName]  existing variant_name (for dedup)
 * @param {string} [p.productType]  Coveo productType (helps trim detection)
 * @param {string} [p.productName]  parent product name (mosaic hint)
 * @returns {string|null}
 */
function resolveMosaicPattern({ vendorSku, imageUrl, currentName, productType, productName }) {
  if (skuIsTrim(vendorSku, productType)) return null;

  const looksMosaic = isMosaicUrl(imageUrl) || /mosaic/i.test(productName || '');
  if (!looksMosaic) return null;

  const pattern = patternFromVendorSku(vendorSku);
  if (!pattern) return null;

  // Skip if the name already states this — or any other — pattern.
  if (nameAlreadyHasPattern(currentName)) return null;

  return pattern;
}

module.exports = {
  resolveMosaicPattern,
  patternFromVendorSku,
  nameAlreadyHasPattern,
  isMosaicUrl,
};
