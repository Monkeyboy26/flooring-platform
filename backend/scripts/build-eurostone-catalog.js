#!/usr/bin/env node
/**
 * Build Eurostone (Surfaces Unlimited) catalog.json from the 2026 Distributor Price List.
 *
 * Eurostone / Surfaces Unlimited (Beverly Hills, CA; yard in Downtown LA) is a slab
 * distributor: 2cm engineered quartz slabs (Zero-silica + CMT recycled lines) and 1/2"
 * porcelain slabs, plus a stone sealer. The PDF lists DISTRIBUTOR (dealer) prices = Roma's
 * COST; retail = cost x 1.6 keystone (store standard), rounded to $0.05.
 *
 * Slabs are whole pieces: sell_by='unit', price_basis='per_unit', slab area in
 * packaging.sqft_per_box so the storefront renders them as slabs (/ea).
 *
 * Quartz comes in two piece sizes; a model may offer Standard, Jumbo, or both:
 *   Standard 56" x 120" x 3/4"  = 46.67 sqft
 *   Jumbo    63" x 126" x 3/4"  = 55.13 sqft
 * Porcelain slabs are a single size: 63" x 126" x 1/2" = 55.13 sqft, all $999.
 *
 * Output: backend/data/eurostone/catalog.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'data', 'eurostone');

const STD_SQFT = 46.67;   // 56 x 120 / 144
const JMB_SQFT = 55.13;   // 63 x 126 / 144
const PORC_SQFT = 55.13;  // 63 x 126 / 144

const keystone = (cost) => Math.round((cost * 1.6) / 0.05) * 0.05;
const money = (n) => Math.round(n * 100) / 100;

const slugify = (s) => s.toLowerCase()
  .replace(/['’]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

// Base color = model name minus the silica/finish descriptor tokens.
const colorOf = (name) => name
  .replace(/\*/g, '')
  .replace(/\b(Zero|CMT|Grain|Rocplan)\b/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const silicaText = (silica) => {
  if (silica === 'zero') return 'Zero-silica engineered surface — contains no crystalline silica for safer fabrication.';
  if (silica === 'cmt') return 'CMT engineered stone: 0–25% silica, made from 100% recycled content (GREENGUARD Gold / Eco-Stone line).';
  return 'Premium engineered quartz surface.';
};

// ==================== Quartz price sheet ====================
// [name, finish, silica ('zero'|'cmt'|''), std$, jumbo$, availability ('in'|'limited')]
const QUARTZ = [
  // Group 1
  ['Carrara Venatino', 'Polished', '',    999, 1099, 'limited'],
  ['Pure White Zero',  'Polished', 'zero', 999, 1099, 'in'],
  // Group 2 — Standard $1,199
  ['Carrara',    'Polished', '',    1199, 1299, 'limited'],
  ['K Art',      'Polished', '',    1199, null, 'limited'],
  ['K Soul',     'Polished', '',    1199, null, 'limited'],
  ['Milano CMT', 'Polished', 'cmt', 1199, null, 'in'],
  // Group 3 — Standard $1,399
  ['Basic CMT',           'Polished', 'cmt', 1399, null, 'in'],
  ['Calacatta Nuovo',     'Polished', '',    1399, null, 'limited'],
  ['Greige',              'Polished', '',    1399, null, 'limited'],
  ['Imperial Grain CMT',  'Honed',    'cmt', 1399, null, 'in'],
  ['K Gold Grain',        'Honed',    '',    1399, null, 'limited'],
  ['K Soul Grain',        'Honed',    '',    1399, null, 'limited'],
  ['Milano Grain CMT',    'Honed',    'cmt', 1399, null, 'in'],
  // Group 4 — Standard $1,499 / Jumbo $1,699
  ['Arabescato Gold Zero',    'Polished', 'zero', null, 1699, 'in'],
  ['Base Grain CMT',          'Honed',    'cmt', 1499, null, 'in'],
  ['Basic Grain CMT',         'Honed',    'cmt', 1499, null, 'in'],
  ['Brillant Bianco CMT',     'Polished', 'cmt', 1499, null, 'in'],
  ['Calacatta Nuovo 23 Zero', 'Polished', 'zero', null, 1699, 'in'],
  ['Calacatta Oro Zero',      'Polished', 'zero', null, 1699, 'in'],
  ['Carrara White Zero',      'Polished', 'zero', null, 1699, 'in'],
  ['Crystal Tan Zero',        'Polished', 'zero', null, 1699, 'in'],
  ['Lido CMT',                'Polished', 'cmt', 1499, null, 'in'],
  ['Luna Grain',              'Honed',    'cmt', 1499, null, 'in'],
  ['Nero Marquina',           'Polished', '',    null, 1699, 'limited'],
  ['Orange Zero',             'Polished', 'zero', 1499, null, 'in'],
  ['Pearl White Zero',        'Polished', 'zero', null, 1699, 'in'],
  ['Sabbia Marina Grain CMT', 'Honed',    'cmt', 1499, null, 'in'],
  ['Statuario',               'Polished', '',    null, 1699, 'limited'],
  ["Statuario Gold '26 Zero", 'Polished', 'zero', null, 1699, 'in'],
  ['Statuario Nuovo Gold Zero','Polished','zero', null, 1699, 'in'],
  ['Statuario Nuovo Grey Zero','Polished','zero', null, 1699, 'in'],
  ['Statuario White',         'Polished', '',    null, 1699, 'limited'],
  ['Super Bianco Zero',       'Polished', 'zero', 1499, null, 'in'],
  ['Taj Mahal Zero',          'Polished', 'zero', null, 1699, 'in'],
  // Group 4.5 — Standard $1,599
  ['Base Rocplan CMT',        'Textured', 'cmt', 1599, null, 'in'],
  ['Grey Argo Grain Zero',    'Honed',    'zero', 1599, null, 'in'],
  ['Imperiale Rocplan CMT',   'Textured', 'cmt', 1599, null, 'in'],
  ['Meteor Ice Grain Zero',   'Honed',    'zero', 1599, null, 'in'],
  ['Meteor Light Grain Zero', 'Honed',    'zero', 1599, null, 'in'],
  ['Milano Rocplan CMT',      'Textured', 'cmt', 1599, null, 'in'],
  ['Super Bianco Grain Zero', 'Honed',    'zero', 1599, null, 'in'],
  ['White Teti Grain Zero',   'Honed',    'zero', 1599, null, 'in'],
  // Group 5 — Standard $1,799
  ['Basic Rocplan CMT',        'Textured', 'cmt', 1799, null, 'in'],
  ['Grey Argo Rocplan Zero',   'Textured', 'zero', 1799, null, 'in'],
  ['Meteor Ice Rocplan Zero',  'Textured', 'zero', 1799, null, 'in'],
  ['Meteor Light Rocplan Zero','Textured', 'zero', 1799, null, 'in'],
  ['Super Bianco Rocplan Zero','Textured', 'zero', 1799, null, 'in'],
  ['White Teti Rocplan Zero',  'Textured', 'zero', 1799, null, 'in'],
];

// ==================== Porcelain price sheet ====================
// [name, surface, bookmatch(bool)] — all 63"x126"x1/2", $999
const PORCELAIN = [
  ['Apollo White',        'Honed',    true],
  ['Arabescato',          'Honed',    false],
  ['Calacatta Royal',     'Honed',    true],
  ['Carrara Gold',        'Honed',    false],
  ['Calacatta Oro Lucido','Polished', false],
  ['Imperio Armani Grey', 'Honed',    false],
  ['Magma Black',         'Polished', true],
  ['Patagonia Bianco',    'Honed',    false],
  ['Statuario Natural',   'Honed',    true],
  ['Turkey Onyx',         'Polished', false],
  ['Veronic Arabesque',   'Honed',    false],
];

const products = [];

// ---- Quartz ----
for (const [name, finish, silica, std, jumbo, avail] of QUARTZ) {
  const color = colorOf(name);
  const collection = silica === 'zero' ? 'ZEROSilica' : silica === 'cmt' ? 'Eco-Stone' : 'Eurostone Quartz';
  const availText = avail === 'limited' ? 'Limited to stock on hand.' : 'In stock.';
  const sizes = [];
  const skus = [];
  if (std != null) {
    sizes.push('Standard 56" × 120"');
    skus.push({
      internal_sku: `ES-${slugify(name)}-STD`,
      vendor_sku: `ES-${slugify(name)}-STD`,
      variant_name: 'Standard 56" × 120" × 3/4"',
      cost: std, retail: money(keystone(std)),
      sell_by: 'unit', price_basis: 'per_unit',
      sqft_per_box: STD_SQFT, pieces_per_box: 1,
      attrs: { size: 'Standard — 56" × 120" × 3/4" (2cm)' },
    });
  }
  if (jumbo != null) {
    sizes.push('Jumbo 63" × 126"');
    skus.push({
      internal_sku: `ES-${slugify(name)}-JMB`,
      vendor_sku: `ES-${slugify(name)}-JMB`,
      variant_name: 'Jumbo 63" × 126" × 3/4"',
      cost: jumbo, retail: money(keystone(jumbo)),
      sell_by: 'unit', price_basis: 'per_unit',
      sqft_per_box: JMB_SQFT, pieces_per_box: 1,
      attrs: { size: 'Jumbo — 63" × 126" × 3/4" (2cm)' },
    });
  }
  products.push({
    line: 'Quartz',
    brand_name: 'Eurostone',
    category_slug: 'quartz-countertops',
    collection,
    name,
    slug: slugify(name),
    silica,
    description: `${name} — ${finish.toLowerCase()} 2cm engineered quartz slab by Eurostone. ${silicaText(silica)} ${availText} Piece sizes: ${sizes.join(' and ')}.`,
    attrs: {
      brand: 'Eurostone',
      collection,
      color,
      finish,
      material: 'Engineered Quartz',
      countertop_material: silica === 'zero' ? 'Quartz (Zero-Silica)' : 'Quartz',
      thickness: '3/4" (2cm)',
    },
    skus,
  });
}

// ---- Porcelain ----
for (const [name, surface, bookmatch] of PORCELAIN) {
  products.push({
    line: 'Porcelain',
    brand_name: 'Eurostone',
    category_slug: 'porcelain-slabs',
    collection: 'Porcelain Slabs',
    name,
    slug: slugify(name),
    silica: 'porcelain',
    description: `${name} — ${surface.toLowerCase()} porcelain slab by Eurostone. ${bookmatch ? 'Bookmatch available.' : 'Does not bookmatch.'} Large-format 63" × 126" × 1/2" slab.`,
    attrs: {
      brand: 'Eurostone',
      collection: 'Porcelain Slabs',
      color: name,
      finish: surface,
      material: 'Porcelain',
      countertop_material: 'Porcelain',
      thickness: '1/2" (12mm)',
    },
    skus: [{
      internal_sku: `ES-${slugify(name)}-PORC`,
      vendor_sku: `ES-${slugify(name)}-PORC`,
      variant_name: '63" × 126" × 1/2"',
      cost: 999, retail: money(keystone(999)),
      sell_by: 'unit', price_basis: 'per_unit',
      sqft_per_box: PORC_SQFT, pieces_per_box: 1,
      attrs: { size: '63" × 126" × 1/2"', bookmatch: bookmatch ? 'Yes' : 'No' },
    }],
  });
}

// ---- Sealer accessory ----
products.push({
  line: 'Accessory',
  brand_name: 'Eurostone',
  category_slug: 'adhesives-sealants',
  collection: 'Care & Maintenance',
  name: 'Stain-Proof Dense Stone Impregnating Sealer (500ml)',
  slug: 'stain-proof-sealer-500ml',
  silica: '',
  description: 'Stain-Proof Dense Stone Impregnating Sealer (formerly DryTreat Stain-Proof Plus), 500ml bottle. Premium impregnating sealer for dense stone and engineered surfaces. One 500ml bottle covers up to 3 slabs.',
  attrs: { brand: 'Eurostone', material: 'Impregnating Sealer' },
  skus: [{
    internal_sku: 'ES-SEALER-500ML',
    vendor_sku: 'ES-SEALER-500ML',
    variant_name: '500ml bottle',
    cost: 59, retail: money(keystone(59)),
    sell_by: 'unit', price_basis: 'per_unit',
    variant_type: 'accessory',
    attrs: { size: '500ml' },
  }],
});

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'catalog.json'), JSON.stringify(products, null, 2));

const skuCount = products.reduce((n, p) => n + p.skus.length, 0);
console.log(`Wrote ${products.length} products / ${skuCount} SKUs to ${path.join(OUT_DIR, 'catalog.json')}`);
console.log(`  Quartz: ${products.filter(p => p.line === 'Quartz').length}`);
console.log(`  Porcelain: ${products.filter(p => p.line === 'Porcelain').length}`);
console.log(`  Accessory: ${products.filter(p => p.line === 'Accessory').length}`);
