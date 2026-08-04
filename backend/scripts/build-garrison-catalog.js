#!/usr/bin/env node
/**
 * Build backend/data/garrison/catalog.json from the Garrison Collection
 * "Engineered Hardwood — Preferred Customer Price List v2026.03".
 *
 * Garrison Collection (exclusively manufactured by Old Master Products, Inc.,
 * garrisoncollection.com) is onboarded as its OWN vendor (code GARRISON).
 * All products are engineered hardwood, sold per sqft (by the box).
 *
 * Pricing: the "Preferred Customer" sheet price is the dealer/wholesale price =
 * Roma's COST. Retail = cost x 1.6, nickel-rounded (store keystone standard —
 * see [[selling-conventions]]). Applied in import-garrison.js.
 *
 * Modeling:
 *   - Products are grouped by (collection, color, species). Most colors are one
 *     product / one SKU. Where the same color+species ships in several plank
 *     sizes (Contractor's Choice, Crystal Valley, Crystal Valley America) the
 *     sizes become size-variant SKUs under one product.
 *   - Mouldings (T-Moulding / Reducer / Baby Threshold / Nosing) are the priced,
 *     color-matched accessories. Each color's 4 mouldings are attached to that
 *     color's plank SKU(s) via sku_accessories (see [[pdi-onboarding]]).
 *   - Adhesives & care/maintenance products are UNPRICED on the sheet
 *     ("contact for pricing") and are NOT imported. Exotics + Contractor's
 *     Choice mouldings are likewise contact-for-pricing → no mouldings emitted.
 *
 * Item codes are transcribed exactly as printed (Garrison SKUs use the letter
 * "O", verified against the live garrisoncollection.com product-page HTML).
 *
 * Usage: node scripts/build-garrison-catalog.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'data', 'garrison');

// ---- Moulding price sets (cost = preferred-customer price) ----
// oak99: single-species oak lines (BH, Gold Label, Newport, Private Selection, Legends)
const MP_OAK = { 'T-Moulding': 74.99, 'Reducer': 74.99, 'Baby Threshold': 74.99, 'Nosing': 99.99 };
// cv:   Crystal Valley / Crystal Valley America — all species
const MP_CV = { 'T-Moulding': 64.99, 'Reducer': 64.99, 'Baby Threshold': 64.99, 'Nosing': 84.99 };
// mix:  distressed multi-species lines — Hickory priced higher than the rest
const MP_MIX_HICKORY = { 'T-Moulding': 74.99, 'Reducer': 74.99, 'Baby Threshold': 74.99, 'Nosing': 94.99 };
const MP_MIX_OTHER   = { 'T-Moulding': 64.99, 'Reducer': 64.99, 'Baby Threshold': 64.99, 'Nosing': 84.99 };
const mpMix = (species) => (species === 'Hickory' ? MP_MIX_HICKORY : MP_MIX_OTHER);

const MOULD_TYPES = ['T-Moulding', 'Reducer', 'Baby Threshold', 'Nosing'];

// Each collection: metadata + colors[]. A color row:
//   { color, sku, price, species?, size?, sqftBox?, lbsBox?, finish?, status?, m?: [TM,RE,BT,NO] }
// m omitted / null → no mouldings for that color.
const COLLECTIONS = [
  {
    name: 'Beverly Hills',
    species: 'European Oak',
    finish: 'Light Wire-Brushed, Aluminum Oxide',
    mp: () => MP_OAK,
    mouldSpecs: { 'T-Moulding': '5/8" x 2" x 96"', 'Reducer': '5/8" x 2" x 96"', 'Baby Threshold': '5/8" x 2" x 96"', 'Nosing': '5/8" x 3-1/2" x 96"' },
    specs: { thickness: '5/8" (15mm)', width: '9-1/2" (241.3mm)', length: 'mostly 7\' 2-1/2" (2179mm)', construction: 'Engineered, Plywood Substrate, Micro-Beveled Edge', edge_type: 'Micro-Beveled', wear_layer: '4mm', grade: 'Select Character', installation_method: 'Nail, Staple, Glue, Float', surface_texture: 'Light Wire-Brushed' },
    sqftBox: 22.74, lbsBox: 45,
    colors: [
      { color: 'Alpine', sku: 'GFBHO9507', price: 5.89, m: ['GCBHTM8O07', 'GCBHRE8O07', 'GCBHBT8O07', 'GCBHNO8O07'] },
      { color: 'Burton Way', sku: 'GFBHO9501', price: 5.89, m: ['GCBHTM8O01', 'GCBHRE8O01', 'GCBHBT8O01', 'GCBHNO8O01'] },
      { color: 'Canon', sku: 'GFBHO9502', price: 5.89, m: ['GCBHTM8O02', 'GCBHRE8O02', 'GCBHBT8O02', 'GCBHNO8O02'] },
      { color: 'Carmelita', sku: 'GFBHO9510', price: 5.89, m: ['GCBHTM8O10', 'GCBHRE8O10', 'GCBHBT8O10', 'GCBHNO8O10'] },
      { color: 'Doheny', sku: 'GFBHO9508', price: 5.89, m: ['GCBHTM8O08', 'GCBHRE8O08', 'GCBHBT8O08', 'GCBHNO8O08'] },
      { color: 'Hillcrest', sku: 'GFBHO9503', price: 5.89, m: ['GCBHTM8O03', 'GCBHRE8O03', 'GCBHBT8O03', 'GCBHNO8O03'] },
      { color: 'Loma Linda', sku: 'GFBHO9511', price: 5.89, m: ['GCBHTM8O11', 'GCBHRE8O11', 'GCBHBT8O11', 'GCBHNO8O11'] },
      { color: 'Rodeo Drive', sku: 'GFBHO9505', price: 5.89, m: ['GCBHTM8O05', 'GCBHRE8O05', 'GCBHBT8O05', 'GCBHNO8O05'] },
      { color: 'Roxbury', sku: 'GFBHO9509', price: 5.89, m: ['GCBHTM8O09', 'GCBHRE8O09', 'GCBHBT8O09', 'GCBHNO8O09'] },
      { color: 'Walden', sku: 'GFBHO9506', price: 5.89, m: ['GCBHTM8O06', 'GCBHRE8O06', 'GCBHBT8O06', 'GCBHNO8O06'] },
      { color: 'Rexford', sku: 'GFBHO9504', price: 4.49, note: 'While supplies last; color is being discontinued.', m: ['GCBHTM8O04', 'GCBHRE8O04', 'GCBHBT8O04', 'GCBHNO8O04'] },
    ],
  },
  {
    name: 'Carolina Classic',
    finish: 'Hand-Distressed with Chatter, Aluminum Oxide',
    mp: (s) => mpMix(s),
    mouldSpecs: { 'T-Moulding': '5/8" x 2" x 96"', 'Reducer': '1/2" x 2" x 96"', 'Baby Threshold': '5/8" x 2" x 96"', 'Nosing': '1/2" x 3-1/2" x 96"' },
    specs: { thickness: '1/2" (12.7mm)', width: '5" (127mm)', length: '1.5\' (457mm) - 4.5\' (1372mm)', construction: 'Tongue and Groove, Plywood Substrate, Hand-Scraped Beveled Edge', edge_type: 'Hand-Scraped Beveled', wear_layer: '2.4mm', grade: 'Select Character', installation_method: 'Nail, Staple, Glue, Float', surface_texture: 'Hand-Distressed with Chatter' },
    sqftBox: 17.50, lbsBox: 33,
    colors: [
      { color: 'Beaufort', species: 'Hickory', sku: 'GHCCH588', price: 4.29, m: ['GCCCTM8H88', 'GCCCRE8H88', 'GCCCBT8H88', 'GCCCNO8H88'] },
      { color: 'Charlotte', species: 'Hickory', sku: 'GHCCH589', price: 4.29, m: ['GCCCTM8H89', 'GCCCRE8H89', 'GCCCBT8H89', 'GCCCNO8H89'] },
      { color: 'Salem', species: 'Hickory', sku: 'GHCCH590', price: 4.29, m: ['GCCCTM8H90', 'GCCCRE8H90', 'GCCCBT8H90', 'GCCCNO8H90'] },
      { color: 'Durham', species: 'Maple', sku: 'GHCCM592', price: 4.19, m: ['GCCCTM8M92', 'GCCCRE8M92', 'GCCCBT8M92', 'GCCCNO8M92'] },
      { color: 'Monroe', species: 'Maple', sku: 'GHCCM593', price: 4.19, m: ['GCCCTM8M93', 'GCCCRE8M93', 'GCCCBT8M93', 'GCCCNO8M93'] },
    ],
  },
  {
    name: 'Competition Buster',
    finish: 'Hand-Distressed with Chatter, Aluminum Oxide',
    mp: (s) => mpMix(s),
    mouldSpecs: { 'T-Moulding': '5/8" x 2" x 96"', 'Reducer': '3/8" x 2" x 96"', 'Baby Threshold': '5/8" x 2" x 96"', 'Nosing': '3/8" x 3-1/2" x 96"' },
    specs: { thickness: '3/8" (9.5mm)', width: '5" (127mm)', length: '1.5\' (457mm) - 4.5\' (1372mm)', construction: 'Tongue and Groove, Plywood Substrate, Hand-Scraped Beveled Edge', edge_type: 'Hand-Scraped Beveled', wear_layer: '1.5mm', grade: 'Select Character', installation_method: 'Nail, Staple, Glue', surface_texture: 'Hand-Distressed with Chatter' },
    sqftBox: 26.25, lbsBox: 39,
    colors: [
      { color: 'Antique', species: 'Hickory', sku: 'ETCBH523', price: 3.29, m: ['GCCBTM8H23', 'GCCBRE8H23', 'GCCBBT8H23', 'GCCBNO8H23'] },
      { color: 'Vintage', species: 'Hickory', sku: 'ETCBH5141', price: 3.29, m: ['GCCBTM8H141', 'GCCBRE8H141', 'GCCBBT8H141', 'GCCBNO8H141'] },
      { color: 'Chestnut', species: 'Birch', sku: 'ETCBB506', price: 3.09, m: ['GCCBTM8B06', 'GCCBRE8B06', 'GCCBBT8B06', 'GCCBNO8B06'] },
      { color: 'Harvest', species: 'Birch', sku: 'ETCBB517', price: 3.09, m: ['GCCBTM8B17', 'GCCBRE8B17', 'GCCBBT8B17', 'GCCBNO8B17'] },
      { color: 'Spice', species: 'Birch', sku: 'ETCBB5145', price: 3.09, m: ['GCCBTM8B145', 'GCCBRE8B145', 'GCCBBT8B145', 'GCCBNO8B145'] },
      { color: 'Truffle', species: 'Birch', sku: 'ETCBB5144', price: 3.09, m: ['GCCBTM8B144', 'GCCBRE8B144', 'GCCBBT8B144', 'GCCBNO8B144'] },
    ],
  },
  {
    name: "Contractor's Choice",
    species: 'American White Oak',
    finish: 'Smooth, Unfinished',
    mp: null, // mouldings are contact-for-pricing → none imported
    specs: { thickness: '5/8"', length: 'Random, 16" up to 84"', construction: 'Tongue and Groove, Plywood Substrate', edge_type: 'Micro-Beveled', wear_layer: '4mm', grade: 'Premium', installation_method: 'Nail, Staple, Glue, Float', surface_texture: 'Smooth (Unfinished)' },
    // Single color (American White Oak) in 4 plank widths → one product, 4 size SKUs.
    colors: [
      { color: 'American White Oak', sku: 'GFCOO214PS', price: 5.69, size: '5/8" x 2-1/4"', width: '2-1/4"', sqftBox: 20.68, lbsBox: 40 },
      { color: 'American White Oak', sku: 'GFCOO314PS', price: 5.89, size: '5/8" x 3-1/4"', width: '3-1/4"', sqftBox: 22.4, lbsBox: 42 },
      { color: 'American White Oak', sku: 'GFCOO5PS', price: 5.99, size: '5/8" x 5"', width: '5"', sqftBox: 17.5, lbsBox: 34 },
      { color: 'American White Oak', sku: 'GFCOO7PS', price: 6.59, size: '5/8" x 7"', width: '7"', sqftBox: 24.14, lbsBox: 50 },
    ],
  },
  {
    name: 'Crystal Valley',
    finish: 'Smooth, Aluminum Oxide',
    mp: () => MP_CV,
    mouldSpecs: { 'T-Moulding': '5/8" x 2" x 96"', 'Reducer': '1/2" x 2" x 96"', 'Baby Threshold': '5/8" x 2" x 96"', 'Nosing': '1/2" x 3-1/2" x 96"' },
    specs: { length: '1.5\' (457mm) - 4.5\' (1372mm)', construction: 'Tongue and Groove, Plywood Substrate, Micro-Beveled Edge', edge_type: 'Micro-Beveled', grade: 'Select', installation_method: 'Nail, Staple, Glue, Float', surface_texture: 'Smooth' },
    // T x W vary by row; grouped into products by (color, species), sizes = SKUs.
    colors: [
      { color: 'Natural', species: 'Maple', sku: 'GHCVM31438', price: 4.39, size: '1/2" x 3-1/4"', width: '3-1/4"', thickness: '1/2"', wear_layer: '2.2mm', grade: 'Premium', sqftBox: 22.40, lbsBox: 38, m: ['GCCVTM8M38', 'GCCVRE8MH38', 'GCCVBT8M38', 'GCCVNO8MH38'] },
      { color: 'Natural', species: 'Maple', sku: 'GNCVM538', price: 5.29, size: '1/2" x 5"', width: '5"', thickness: '1/2"', wear_layer: '4mm', grade: 'Premium', sqftBox: 17.50, lbsBox: 31, m: ['GCCVTM8M38', 'GCCVRE8MH38', 'GCCVBT8M38', 'GCCVNO8MH38'] },
      { color: 'Natural', species: 'Red Oak', sku: 'GHCVR31438', price: 4.89, size: '1/2" x 3-1/4"', width: '3-1/4"', thickness: '1/2"', wear_layer: '2.2mm', grade: 'Select', sqftBox: 22.40, lbsBox: 38, m: ['GCCVTM8R38', 'GCCVRE8RH38', 'GCCVBT8R38', 'GCCVNO8RH38'] },
      { color: 'Natural', species: 'Red Oak', sku: 'GHCVR538', price: 5.29, size: '1/2" x 5"', width: '5"', thickness: '1/2"', wear_layer: '2.2mm', grade: 'Select', sqftBox: 17.50, lbsBox: 36, m: ['GCCVTM8R38', 'GCCVRE8RH38', 'GCCVBT8R38', 'GCCVNO8RH38'] },
      { color: 'Natural', species: 'White Oak', sku: 'GHCVO31438', price: 4.59, size: '1/2" x 3-1/4"', width: '3-1/4"', thickness: '1/2"', wear_layer: '2.2mm', grade: 'Select', sqftBox: 22.40, lbsBox: 36, m: ['GCCVTM8O38', 'GCCVRE8OH38', 'GCCVBT8O38', 'GCCVNO8OH38'] },
      { color: 'Natural', species: 'White Oak', sku: 'GHCVO538', price: 4.99, size: '1/2" x 5"', width: '5"', thickness: '1/2"', wear_layer: '2.2mm', grade: 'Select', sqftBox: 17.50, lbsBox: 27, m: ['GCCVTM8O38', 'GCCVRE8OH38', 'GCCVBT8O38', 'GCCVNO8OH38'] },
      { color: 'Prairie Wheat', species: 'White Oak', sku: 'GHCVO31468', price: 4.59, size: '1/2" x 3-1/4"', width: '3-1/4"', thickness: '1/2"', wear_layer: '2.2mm', grade: 'Select', sqftBox: 22.40, lbsBox: 36, m: ['GCCVTM8O68', 'GCCVRE8OH68', 'GCCVBT8O68', 'GCCVNO8OH68'] },
      { color: 'Prairie Wheat', species: 'White Oak', sku: 'GHCVO568', price: 4.99, size: '1/2" x 5"', width: '5"', thickness: '1/2"', wear_layer: '2.2mm', grade: 'Select', sqftBox: 17.50, lbsBox: 27, m: ['GCCVTM8O68', 'GCCVRE8OH68', 'GCCVBT8O68', 'GCCVNO8OH68'] },
    ],
  },
  {
    name: 'Crystal Valley America',
    finish: 'Smooth, Aluminum Oxide',
    mp: () => MP_CV,
    mouldSpecs: { 'T-Moulding': '5/8" x 2" x 96"', 'Reducer': '1/2" x 2" x 96"', 'Baby Threshold': '5/8" x 2" x 96"', 'Nosing': '1/2" x 3-1/2" x 96"' },
    mouldNote: 'Non-stocking, made to order. Allow 5–7 business days for production.',
    specs: { length: '1.5\' (457mm) - 7\' (2133mm)', construction: 'Tongue and Groove, Plywood Substrate, Micro-Beveled Edge', edge_type: 'Micro-Beveled', wear_layer: '3mm', grade: 'Select', installation_method: 'Nail, Staple, Glue, Float', surface_texture: 'Smooth' },
    colors: [
      { color: 'Natural', species: 'Maple', sku: 'GHCVM538USA', price: 5.89, size: '1/2" x 5"', width: '5"', thickness: '1/2"', sqftBox: 33.75, lbsBox: 58, m: ['GCCVTM8M38USA', 'GCCVRE8MH38USA', 'GCCVBT8M38USA', 'GCCVNO8MH38USA'] },
      { color: 'Natural', species: 'Red Oak', sku: 'GHCVR31438USA-33', price: 5.79, size: '1/2" x 3-1/4"', width: '3-1/4"', thickness: '1/2"', sqftBox: 33, lbsBox: 56, m: ['GCCVTM8R38USA', 'GCCVRE8RH38USA', 'GCCVBT8R38USA', 'GCCVNO8RH38USA'] },
      { color: 'Natural', species: 'Red Oak', sku: 'GHCVR538USA', price: 5.79, size: '1/2" x 5"', width: '5"', thickness: '1/2"', sqftBox: 33.75, lbsBox: 58, m: ['GCCVTM8R38USA', 'GCCVRE8RH38USA', 'GCCVBT8R38USA', 'GCCVNO8RH38USA'] },
      { color: 'Natural', species: 'White Oak', sku: 'GHCVO31438USA-33', price: 6.19, size: '1/2" x 3-1/4"', width: '3-1/4"', thickness: '1/2"', sqftBox: 33, lbsBox: 56, m: ['GCCVTM8O38USA', 'GCCVRE8OH38USA', 'GCCVBT8O38USA', 'GCCVNO8OH38USA'] },
      { color: 'Natural', species: 'White Oak', sku: 'GHCVO538USA', price: 6.19, size: '1/2" x 5"', width: '5"', thickness: '1/2"', sqftBox: 33.75, lbsBox: 58, m: ['GCCVTM8O38USA', 'GCCVRE8OH38USA', 'GCCVBT8O38USA', 'GCCVNO8OH38USA'] },
      { color: 'Prairie Wheat', species: 'White Oak', sku: 'GHCVO31468USA-33', price: 6.19, size: '1/2" x 3-1/4"', width: '3-1/4"', thickness: '1/2"', sqftBox: 33, lbsBox: 56, m: ['GCCVTM8O68USA', 'GCCVRE8OH68USA', 'GCCVBT8O68USA', 'GCCVNO8OH68USA'] },
      { color: 'Prairie Wheat', species: 'White Oak', sku: 'GHCVO568USA', price: 6.19, size: '1/2" x 5"', width: '5"', thickness: '1/2"', sqftBox: 33.75, lbsBox: 58, m: ['GCCVTM8O68USA', 'GCCVRE8OH68USA', 'GCCVBT8O68USA', 'GCCVNO8OH68USA'] },
    ],
  },
  {
    name: 'Exotics',
    mp: null, // Exotics mouldings are contact-for-pricing → none imported
    specs: { thickness: '1/2" (12.7mm)', width: '5" (127mm)', construction: 'Tongue and Groove, Plywood Substrate', wear_layer: '2mm', grade: 'Select Character', installation_method: 'Nail, Staple, Glue, Float' },
    colors: [
      { color: 'Black Walnut', species: 'Acacia', sku: 'GHEXA516', price: 5.69, finish: 'Distressed, Aluminum Oxide', edge_type: 'Pillowed', length: 'Random, up to 4\' (1219mm)', sqftBox: 29.53, lbsBox: 49 },
      { color: 'Bronze', species: 'Acacia', sku: 'GHEXA5146', price: 5.69, finish: 'Distressed, Aluminum Oxide', edge_type: 'Pillowed', length: 'Random, up to 4\' (1219mm)', sqftBox: 29.53, lbsBox: 49 },
      { color: 'Gold', species: 'Acacia', sku: 'GHEXA5147', price: 5.69, finish: 'Distressed, Aluminum Oxide', edge_type: 'Pillowed', length: 'Random, up to 4\' (1219mm)', sqftBox: 29.53, lbsBox: 49 },
      { color: 'Natural', species: 'Acacia', sku: 'GHEXA538', price: 5.69, finish: 'Distressed, Aluminum Oxide', edge_type: 'Pillowed', length: 'Random, up to 4\' (1219mm)', sqftBox: 29.53, lbsBox: 49 },
      { color: 'Natural', species: 'Brazilian Cherry', sku: 'GHEXB538', price: 6.29, finish: 'Smooth, Aluminum Oxide', edge_type: 'Beveled', length: 'Random, up to 7\' (2134mm)', sqftBox: 34.94, lbsBox: 60 },
      { color: 'Natural', species: 'Patagonian Rosewood', sku: 'GHEXPR538', price: 6.49, finish: 'Smooth, Aluminum Oxide', edge_type: 'Beveled', length: 'Random, up to 7\' (2134mm)', sqftBox: 34.94, lbsBox: 60 },
      { color: 'Natural', species: 'Santos Mahogany', sku: 'GHEXSM538', price: 6.89, finish: 'Smooth, Aluminum Oxide', edge_type: 'Beveled', length: 'Random, up to 7\' (2134mm)', sqftBox: 34.94, lbsBox: 60 },
      { color: 'Natural', species: 'Sapele', sku: 'GHEXS538', price: 5.59, finish: 'Smooth, Aluminum Oxide', edge_type: 'Beveled', length: 'Random, up to 7\' (2134mm)', sqftBox: 34.94, lbsBox: 60 },
      { color: 'Natural', species: 'Tigerwood', sku: 'GHEXTI538', price: 6.19, finish: 'Smooth, Aluminum Oxide', edge_type: 'Beveled', length: 'Random, up to 7\' (2134mm)', sqftBox: 34.94, lbsBox: 60 },
    ],
  },
  {
    name: 'Garrison II Distressed',
    finish: 'Hand-Distressed, Aluminum Oxide',
    mp: (s) => mpMix(s),
    mouldSpecs: { 'T-Moulding': '5/8" x 2" x 96"', 'Reducer': '9/16" x 2" x 96"', 'Baby Threshold': '5/8" x 2" x 96"', 'Nosing': '9/16" x 3-1/2" x 96"' },
    specs: { thickness: '9/16" (14.3mm)', width: '5" (127mm)', length: 'up to 4.5\' (1372mm)', construction: 'Tongue and Groove, Plywood Substrate, Pillowed Edge', edge_type: 'Pillowed', wear_layer: '4mm', grade: 'Select Character', installation_method: 'Nail, Staple, Glue, Float', surface_texture: 'Hand-Distressed' },
    sqftBox: 17.50, lbsBox: 32,
    colors: [
      { color: 'Chateau', species: 'Hickory', sku: 'GNIIH551', price: 5.89, m: ['GCIITM8H51', 'GCIIRE8H51', 'GCIIBT8H51', 'GCIINO8H51'] },
      { color: 'Natural', species: 'Hickory', sku: 'GNIIH538', price: 5.89, m: ['GCIITM8H38', 'GCIIRE7H38', 'GCIIBT8H38', 'GCIINO8H38'] },
      { color: 'Sierra', species: 'Hickory', sku: 'GNIIH502', price: 5.89, m: ['GCIITM8H02', 'GCIIRE8H02', 'GCIIBT8H02', 'GCIINO8H02'] },
      { color: 'Chestnut', species: 'Maple', sku: 'GNIIM506', price: 5.29, m: ['GCIITM8M06', 'GCIIRE8M06', 'GCIIBT8M06', 'GCIINO8M06'] },
      { color: 'Espresso', species: 'Maple', sku: 'GNIIM508', price: 5.29, m: ['GCIITM8M08', 'GCIIRE8M08', 'GCIIBT8M08', 'GCIINO8M08'] },
      { color: 'Latte', species: 'Maple', sku: 'GNIIM5171', price: 5.29, m: ['GCIITM8M171', 'GCIIRE8M171', 'GCIIBT8M171', 'GCIINO8M171'] },
      { color: 'Syrup', species: 'Maple', sku: 'GNIIM577', price: 5.29, m: ['GCIITM8M77', 'GCIIRE8M77', 'GCIIBT8M77', 'GCIINO8M77'] },
      { color: 'Wheat', species: 'Maple', sku: 'GNIIM554', price: 5.29, m: ['GCIITM8M54', 'GCIIRE8M54', 'GCIIBT8M54', 'GCIINO8M54'] },
      { color: 'Autumn', species: 'White Oak', sku: 'GNIIO513', price: 4.99, m: ['GCIITM8O13', 'GCIIRE8O13', 'GCIIBT8O13', 'GCIINO8O13'] },
      { color: 'Antique', species: 'Walnut', sku: 'GNIIW523', price: 6.29, m: ['GCIITM8W23', 'GCIIRE8W23', 'GCIIBT8W23', 'GCIINO8W23'] },
      { color: 'Natural', species: 'Walnut', sku: 'GNIIW538', price: 6.29, m: ['GCIITM8W38', 'GCIIRE8W38', 'GCIIBT8W38', 'GCIINO8W38'] },
    ],
  },
  {
    name: 'Garrison II Smooth',
    finish: 'Smooth, Aluminum Oxide',
    mp: (s) => mpMix(s),
    mouldSpecs: { 'T-Moulding': '5/8" x 2" x 96"', 'Reducer': '9/16" x 2" x 96"', 'Baby Threshold': '5/8" x 2" x 96"', 'Nosing': '9/16" x 3-1/2" x 96"' },
    specs: { thickness: '9/16" (14.3mm)', width: '5" (127mm)', length: 'up to 4.5\' (1372mm)', construction: 'Tongue and Groove, Plywood Substrate, Micro-Beveled Edge', edge_type: 'Micro-Beveled', wear_layer: '4mm', grade: 'Select Character', installation_method: 'Nail, Staple, Glue, Float', surface_texture: 'Smooth' },
    sqftBox: 17.50, lbsBox: 32,
    colors: [
      { color: 'Chateau', species: 'Hickory', sku: 'GNSSH551', price: 5.79, m: ['GCIITM8H51', 'GCIIRE8H51', 'GCIIBT8H51', 'GCSSNO8H51'] },
      { color: 'Natural', species: 'Hickory', sku: 'GNSSH538', price: 5.79, m: ['GCIITM8H38', 'GCIIRE8H38', 'GCIIBT8H38', 'GCSSNO8H38'] },
      { color: 'Chestnut', species: 'Maple', sku: 'GNSSM506', price: 5.19, m: ['GCIITM8M06', 'GCIIRE8M06', 'GCIIBT8M06', 'GCSSNO8M06'] },
      { color: 'Espresso', species: 'Maple', sku: 'GNSSM508', price: 5.19, m: ['GCIITM8M08', 'GCIIRE8M08', 'GCIIBT8M08', 'GCSSNO8M08'] },
      { color: 'Syrup', species: 'Maple', sku: 'GNSSM577', price: 5.19, m: ['GCIITM8M77', 'GCIIRE8M77', 'GCIIBT8M77', 'GCSSNO8M77'] },
      { color: 'Wheat', species: 'Maple', sku: 'GNSSM554', price: 5.19, m: ['GCIITM8M54', 'GCIIRE8M54', 'GCIIBT8M54', 'GCSSNO8M54'] },
      { color: 'Antique', species: 'Walnut', sku: 'GNSSW523', price: 6.39, m: ['GCIITM8W23', 'GCIIRE8W23', 'GCIIBT8W23', 'GCSSNO8W23'] },
      { color: 'Natural', species: 'Walnut', sku: 'GNSSW538', price: 6.39, m: ['GCIITM8W38', 'GCIIRE8W38', 'GCIIBT8W38', 'GCSSNO8W38'] },
    ],
  },
  {
    name: 'Gold Label',
    species: 'American Oak',
    mp: () => MP_OAK,
    mouldSpecs: { 'T-Moulding': '5/8" x 2" x 96"', 'Reducer': '5/8" x 2" x 96"', 'Baby Threshold': '5/8" x 2" x 96"', 'Nosing': '5/8" x 3-1/2" x 96"' },
    specs: { thickness: '5/8" (15.9mm)', width: '9-1/2" (241.3mm)', length: 'mostly 7\' (2134mm)', construction: 'Tongue and Groove, Plywood Substrate, Micro-Beveled Edge', edge_type: 'Micro-Beveled', wear_layer: '4mm', grade: 'Select (AB)', installation_method: 'Nail, Staple, Glue, Float', surface_texture: 'Light Wire-Brushed' },
    sqftBox: 22.74, lbsBox: 45,
    colors: [
      { color: 'Cashmere', sku: 'GFGLR9501', price: 6.99, finish: 'Light Wire-Brushed, UV Oil', m: ['GCGLTM8R01', 'GCGLRE8R01', 'GCGLBT8R01', 'GCGLNO8R01'] },
      { color: 'Champagne', sku: 'GFGLR9502', price: 6.99, finish: 'Light Wire-Brushed, UV Oil', m: ['GCGLTM8R02', 'GCGLRE8R02', 'GCGLBT8R02', 'GCGLNO8R02'] },
      { color: 'Linen', sku: 'GFGLR9503', price: 6.99, finish: 'Light Wire-Brushed, UV Lacquer', m: ['GCGLTM8R03', 'GCGLRE8R03', 'GCGLBT8R03', 'GCGLNO8R03'] },
      { color: 'Silk', sku: 'GFGLR9504', price: 6.99, finish: 'Light Wire-Brushed, UV Oil', m: ['GCGLTM8R04', 'GCGLRE8R04', 'GCGLBT8R04', 'GCGLNO8R04'] },
      { color: 'Suede', sku: 'GFGLR9505', price: 6.99, finish: 'Light Wire-Brushed, UV Lacquer', m: ['GCGLTM8R05', 'GCGLRE8R05', 'GCGLBT8R05', 'GCGLNO8R05'] },
      { color: 'White Lotus', sku: 'GFGLR9506', price: 6.99, finish: 'Light Wire-Brushed, UV Lacquer', m: ['GCGLTM8R06', 'GCGLRE8R06', 'GCGLBT8R06', 'GCGLNO8R06'] },
    ],
  },
  {
    name: 'Legends',
    mp: () => MP_OAK,
    mouldSpecs: { 'T-Moulding': '5/8" x 2" x 96"', 'Reducer': '5/8" x 2" x 96"', 'Baby Threshold': '5/8" x 2" x 96"', 'Nosing': '5/8" x 2" x 96"' },
    specs: { construction: 'Tongue and Groove, Plywood Substrate, Micro-Beveled Edge', edge_type: 'Micro-Beveled', wear_layer: '4mm', grade: 'Select Character', installation_method: 'Nail, Staple, Glue, Float' },
    // Each color has its own width/size + finish; single SKU each.
    colors: [
      { color: 'Bianca', species: 'European Oak', sku: 'GFLEO7501', price: 5.99, finish: 'Light Wire-Brushed, Aluminum Oxide', thickness: '5/8" (15.8mm)', width: '7-1/2" (190.5mm)', length: '2\'–6.3\' (610–1920mm)', sqftBox: 23.32, lbsBox: 42, m: ['GCLETM8O7501', 'GCLERE8O7501', 'GCLEBT8O7501', 'GCLENO8O7501'] },
      { color: 'Brigitte', species: 'European Oak', sku: 'GFLEO7502', price: 5.99, finish: 'Light Wire-Brushed, UV Oil', thickness: '5/8" (15.8mm)', width: '7-1/2" (190.5mm)', length: '2\'–6.3\' (610–1920mm)', sqftBox: 23.32, lbsBox: 42, m: ['GCLETM8O7502', 'GCLERE8O7502', 'GCLEBT8O7502', 'GCLENO8O7502'] },
      { color: 'Caffe', species: 'European Oak', sku: 'GFLEO7503', price: 5.99, finish: 'Light Wire-Brushed, Natural Oil', thickness: '5/8" (15.8mm)', width: '7-1/2" (190.5mm)', length: '2\'–6.3\' (610–1920mm)', sqftBox: 23.32, lbsBox: 42, m: ['GCLETM8O7503', 'GCLERE8O7503', 'GCLEBT8O7503', 'GCLENO8O7503'] },
      { color: 'Chantal', species: 'European Oak', sku: 'GFLEO7504', price: 5.99, finish: 'Smooth, UV Oil', thickness: '5/8" (15.8mm)', width: '7-1/2" (190.5mm)', length: '2\'–6.3\' (610–1920mm)', sqftBox: 23.32, lbsBox: 42, m: ['GCLETM8O7504', 'GCLERE8O7504', 'GCLEBT8O7504', 'GCLENO8O7504'] },
      { color: 'Lugana', species: 'European Oak', sku: 'GFLEO7505', price: 5.99, finish: 'Light Wire-Brushed, UV Oil', thickness: '5/8" (15.8mm)', width: '7-1/2" (190.5mm)', length: '2\'–6.3\' (610–1920mm)', sqftBox: 23.32, lbsBox: 42, m: ['GCLETM8O7505', 'GCLERE8O7505', 'GCLEBT8O7505', 'GCLENO8O7505'] },
      { color: 'Pinot', species: 'European Oak', sku: 'GFLEO7506', price: 5.99, finish: 'Light Wire-Brushed, Aluminum Oxide', thickness: '5/8" (15.8mm)', width: '7-1/2" (190.5mm)', length: '2\'–6.3\' (610–1920mm)', sqftBox: 23.32, lbsBox: 42, m: ['GCLETM8O7506', 'GCLERE8O7506', 'GCLEBT8O7506', 'GCLENO8O7506'] },
      { color: 'Provence', species: 'European Oak', sku: 'GFLEO7507', price: 5.99, finish: 'Light Wire-Brushed, UV Oil', thickness: '5/8" (15.8mm)', width: '7-1/2" (190.5mm)', length: '2\'–6.3\' (610–1920mm)', sqftBox: 23.32, lbsBox: 42, m: ['GCLETM8O7507', 'GCLERE8O7507', 'GCLEBT8O7507', 'GCLENO8O7507'] },
      { color: 'Walnut Natural', species: 'Walnut', sku: 'GFLEW7501', price: 6.99, finish: 'Smooth, Matte Lacquer', thickness: '5/8" (15.8mm)', width: '7-1/2" (190.5mm)', length: '2\'–6.3\' (610–1920mm)', sqftBox: 23.32, lbsBox: 42 },
      { color: 'Caffe Herringbone', species: 'European Oak', sku: 'GFLEPH501', price: 5.99, finish: 'Light Wire-Brushed, Natural Oil', thickness: '5/8" (15.8mm)', width: '5" (127mm)', length: '24-1/16" (611mm)', sqftBox: 10.03, lbsBox: 22, pattern: 'Herringbone' },
      { color: 'Brescia', species: 'European Oak', sku: 'GFLEO9501', price: 6.69, finish: 'Light Wire-Brushed + Hand-Distressed with Chatter, Aluminum Oxide', thickness: '5/8" (15.8mm)', width: '9-1/2" (241.3mm)', length: '2\'–6.3\' (610–1920mm)', sqftBox: 22.74, lbsBox: 46, m: ['GCLETM8O9501', 'GCLERE8O9501', 'GCLEBT8O9501', 'GCLENO8O9501'] },
      { color: 'La Belle', species: 'European Oak', sku: 'GFLEO9502', price: 6.69, finish: 'Light Wire-Brushed + Hand-Distressed with Chatter, Natural Oil', thickness: '5/8" (15.8mm)', width: '9-1/2" (241.3mm)', length: '2\'–6.3\' (610–1920mm)', sqftBox: 22.74, lbsBox: 46, m: ['GCLETM8O9502', 'GCLERE8O9502', 'GCLEBT8O9502', 'GCLENO8O9502'] },
      { color: 'Monza', species: 'European Oak', sku: 'GFLEO9503', price: 6.69, finish: 'Light Wire-Brushed', thickness: '5/8" (15.8mm)', width: '9-1/2" (241.3mm)', length: '2\'–6.3\' (610–1920mm)', sqftBox: 22.74, lbsBox: 46, m: ['GCLETM8O9503', 'GCLERE8O9503', 'GCLEBT8O9503', 'GCLENO8O9503'] },
      { color: 'Romantique', species: 'European Oak', sku: 'GFLEO9504', price: 6.69, finish: 'Light Wire-Brushed + Hand-Distressed with Chatter, UV Oil', thickness: '5/8" (15.8mm)', width: '9-1/2" (241.3mm)', length: '2\'–6.3\' (610–1920mm)', sqftBox: 22.74, lbsBox: 46, m: ['GCLETM8O9504', 'GCLERE8O9504', 'GCLEBT8O9504', 'GCLENO8O9504'] },
      { color: 'Verona', species: 'European Oak', sku: 'GFLEO9505', price: 6.69, finish: 'Light Wire-Brushed', thickness: '5/8" (15.8mm)', width: '9-1/2" (241.3mm)', length: '2\'–6.3\' (610–1920mm)', sqftBox: 22.74, lbsBox: 46, m: ['GCLETM8O9505', 'GCLERE8O9505', 'GCLEBT8O9505', 'GCLENO8O9505'] },
      { color: 'Glenwood', species: 'European Oak', sku: 'GFLEO1001', price: 6.99, finish: 'Light Wire-Brushed, Aluminum Oxide', thickness: '5/8" (15.8mm)', width: '10-1/4" (260.35mm)', length: '2\'–7.3\' (610–2225mm)', sqftBox: 24.63, lbsBox: 49, m: ['GCLETM8O1001', 'GCLERE8O1001', 'GCLEBT8O1001', 'GCLENO8O1001'] },
      { color: 'Lodi', species: 'European Oak', sku: 'GFLEO1002', price: 6.99, finish: 'Light Wire-Brushed, Aluminum Oxide', thickness: '5/8" (15.8mm)', width: '10-1/4" (260.35mm)', length: '2\'–7.3\' (610–2225mm)', sqftBox: 24.63, lbsBox: 49, m: ['GCLETM8O1002', 'GCLERE8O1002', 'GCLEBT8O1002', 'GCLENO8O1002'] },
      { color: 'Paria', species: 'European Oak', sku: 'GFLEO1003', price: 6.99, finish: 'Light Wire-Brushed, Aluminum Oxide', thickness: '5/8" (15.8mm)', width: '10-1/4" (260.35mm)', length: '2\'–7.3\' (610–2225mm)', sqftBox: 24.63, lbsBox: 49, m: ['GCLETM8O1003', 'GCLERE8O1003', 'GCLEBT8O1003', 'GCLENO8O1003'] },
    ],
  },
  {
    name: 'Newport',
    species: 'European Oak',
    finish: 'Wire-Brushed, Aluminum Oxide',
    mp: () => MP_OAK,
    mouldSpecs: { 'T-Moulding': '5/8" x 2" x 96"', 'Reducer': '1/2" x 2" x 96"', 'Baby Threshold': '5/8" x 2" x 96"', 'Nosing': '1/2" x 3-1/2" x 96"' },
    specs: { thickness: '1/2" (12.7mm)', width: '7-1/2" (190.5mm)', length: '6\' (1829mm)', construction: 'Tongue and Groove, Plywood Substrate, Micro-Beveled Edge', edge_type: 'Micro-Beveled', wear_layer: '2mm', grade: 'Select Character (ABCD)', installation_method: 'Nail, Staple, Glue, Float', surface_texture: 'Wire-Brushed' },
    sqftBox: 23.32, lbsBox: 40,
    colors: [
      { color: 'Carmel', sku: 'GHNPO200', price: 4.19, m: ['GCNPTM8O200', 'GCNPRE8O200', 'GCNPBT8O200', 'GCNPNO8O200'] },
      { color: 'Del Mar', sku: 'GHNPO201', price: 4.19, m: ['GCNPTM8O201', 'GCNPRE8O201', 'GCNPBT8O201', 'GCNPNO8O201'] },
      { color: 'Laguna Beach', sku: 'GHNPO210', price: 4.19, m: ['GCNPTM8O210', 'GCNPRE8O210', 'GCNPBT8O210', 'GCNPNO8O210'] },
      { color: 'Manhattan Beach', sku: 'GHNPO211', price: 4.19, m: ['GCNPTM8O211', 'GCNPRE8O211', 'GCNPBT8O211', 'GCNPNO8O211'] },
      { color: 'Paradise Cove', sku: 'GHNPO212', price: 4.19, m: ['GCNPTM8O212', 'GCNPRE8O212', 'GCNPBT8O212', 'GCNPNO8O212'] },
      { color: 'Pebble Beach', sku: 'GHNPO206', price: 4.19, m: ['GCNPTM8O206', 'GCNPRE8O206', 'GCNPBT8O206', 'GCNPNO8O206'] },
      { color: 'Zuma Beach', sku: 'GHNPO208', price: 4.19, m: ['GCNPTM8O208', 'GCNPRE8O208', 'GCNPBT8O208', 'GCNPNO8O208'] },
      { color: 'Shell Beach', sku: 'GHNPO207', price: 4.19, m: ['GCNPTM8O207', 'GCNPRE8O207', 'GCNPBT8O207', 'GCNPNO8O207'] },
    ],
  },
  {
    name: 'Private Selection',
    species: 'European Oak',
    mp: () => MP_OAK,
    mouldSpecs: { 'T-Moulding': '5/8" x 2" x 96"', 'Reducer': '5/8" x 2" x 96"', 'Baby Threshold': '5/8" x 2" x 96"', 'Nosing': '5/8" x 3-1/2" x 96"' },
    specs: { thickness: '9/16" (14.2mm)', width: '8-5/8" (219mm)', length: 'mostly 7\' (2134mm)', construction: 'Tongue and Groove, Plywood Substrate, Micro-Beveled Edge', edge_type: 'Micro-Beveled', wear_layer: '3.5mm', grade: 'Select Character', installation_method: 'Nail, Staple, Glue, Float' },
    sqftBox: 31, lbsBox: 49,
    colors: [
      { color: 'Adobe', sku: 'GNPSO85804', price: 5.69, finish: 'Light Wire-Brushed, Aluminum Oxide', m: ['GCPSTM8O04', 'GCPSRE8O04', 'GCPSBT8O04', 'GCPSNO8O04'] },
      { color: 'Gobi', sku: 'GNPSO85806', price: 5.69, finish: 'Light Wire-Brushed, Aluminum Oxide', m: ['GCPSTM8O06', 'GCPSRE8O06', 'GCPSBT8O06', 'GCPSNO8O06'] },
      { color: 'Mesa', sku: 'GNPSO85802', price: 5.69, finish: 'Light Wire-Brushed, Aluminum Oxide', m: ['GCPSTM8O02', 'GCPSRE8O02', 'GCPSBT8O02', 'GCPSNO8O02'] },
      { color: 'Mirage', sku: 'GNPSO85801', price: 5.69, finish: 'Light Wire-Brushed, Aluminum Oxide', m: ['GCPSTM8O01', 'GCPSRE8O01', 'GCPSBT8O01', 'GCPSNO8O01'] },
      { color: 'Dune', sku: 'GNPSO85803', price: 5.69, finish: 'Smooth, Aluminum Oxide', m: ['GCPSTM8O03', 'GCPSRE8O03', 'GCPSBT8O03', 'GCPSNO8O03'] },
      { color: 'Sahara', sku: 'GNPSO85805', price: 5.69, finish: 'Smooth, Aluminum Oxide', m: ['GCPSTM8O05', 'GCPSRE8O05', 'GCPSBT8O05', 'GCPSNO8O05'] },
    ],
  },
];

// ---- Expand into flat product/sku/moulding structure ----
function build() {
  const products = [];

  for (const col of COLLECTIONS) {
    // count color names to decide whether to disambiguate by species
    const colorCounts = {};
    for (const c of col.colors) colorCounts[c.color] = (colorCounts[c.color] || 0) + 1;

    // group rows by (color|species) → one product, sizes become SKUs
    const groups = new Map();
    for (const c of col.colors) {
      const species = c.species || col.species || null;
      const key = `${c.color}||${species}`;
      if (!groups.has(key)) groups.set(key, { color: c.color, species, rows: [] });
      groups.get(key).rows.push(c);
    }

    for (const g of groups.values()) {
      const nameCollides = colorCounts[g.color] > (g.rows.length); // same color, different species elsewhere
      const displayName = nameCollides && g.species ? `${g.color} (${g.species})` : g.color;

      const skus = g.rows.map((r) => ({
        vendor_sku: r.sku,
        internal_sku: `GARRISON-${r.sku}`,
        variant_name: r.size || col.specs.width || null,
        size: r.size || (col.specs.width ? `${col.specs.thickness || ''} x ${col.specs.width}`.trim() : null),
        cost: r.price,
        sqft_box: r.sqftBox ?? col.sqftBox ?? null,
        lbs_box: r.lbsBox ?? col.lbsBox ?? null,
        status: r.status || 'active',
        note: r.note || null,
        // per-row spec overrides
        thickness: r.thickness || col.specs.thickness || null,
        width: r.width || col.specs.width || null,
        length: r.length || col.specs.length || null,
        wear_layer: r.wear_layer || col.specs.wear_layer || null,
        grade: r.grade || col.specs.grade || null,
        edge_type: r.edge_type || col.specs.edge_type || null,
        finish: r.finish || col.finish || null,
        pattern: r.pattern || null,
      }));

      // mouldings for this product (dedup by vendor_sku across the group's rows)
      const mseen = new Set();
      const mouldings = [];
      if (col.mp) {
        for (const r of g.rows) {
          if (!r.m) continue;
          const prices = col.mp(g.species);
          r.m.forEach((code, i) => {
            if (!code || mseen.has(code)) return;
            mseen.add(code);
            const type = MOULD_TYPES[i];
            mouldings.push({
              type,
              accessory_label: `${type} — ${g.color}`,
              vendor_sku: code,
              internal_sku: `GARRISON-${code}`,
              cost: prices[type],
              size: (col.mouldSpecs && col.mouldSpecs[type]) || null,
            });
          });
        }
      }

      products.push({
        collection: col.name,
        name: displayName,
        color: g.color,
        species: g.species,
        finish: skus[0].finish,
        category: 'engineered-hardwood',
        material: 'Engineered Hardwood',
        specs: col.specs,
        mould_note: col.mouldNote || null,
        skus,
        mouldings,
      });
    }
  }

  return {
    vendor: {
      name: 'Garrison Collection',
      code: 'GAR',
      website: 'https://www.garrisoncollection.com',
      email: null,
      phone: null,
      address: null,
      notes: 'Engineered hardwood, exclusively manufactured by Old Master Products, Inc. Preferred Customer Price List v2026.03 (replaces 2025.05). Preferred-customer (dealer) price = Roma COST; retail = cost x1.6 keystone. 13 collections; color-matched mouldings (T-Moulding/Reducer/Baby Threshold/Nosing) attached as accessories. Adhesives & care/maintenance products exist but are unpriced (contact for pricing) and are NOT imported. Exotics + Contractor\'s Choice mouldings are also contact-for-pricing.',
    },
    products,
  };
}

const catalog = build();
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2));

const nSku = catalog.products.reduce((a, p) => a + p.skus.length, 0);
const nMould = catalog.products.reduce((a, p) => a + p.mouldings.length, 0);
const byCol = {};
for (const p of catalog.products) byCol[p.collection] = (byCol[p.collection] || 0) + 1;
console.log(`Wrote ${path.join(OUT_DIR, 'catalog.json')}`);
console.log(`Products: ${catalog.products.length}  Plank SKUs: ${nSku}  Moulding SKUs: ${nMould}`);
console.log('Products per collection:');
for (const [k, v] of Object.entries(byCol)) console.log(`  ${k}: ${v}`);
