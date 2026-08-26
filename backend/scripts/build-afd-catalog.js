#!/usr/bin/env node
/**
 * Build the AFD catalog.json from the vendor price list PDF.
 *
 * Source: "AFD Metro Los Angeles Price List — Flooring & Moulding" (effective
 * May 5, 2025). American Flooring Distributor (3847 Capitol Ave, City of
 * Industry, CA 90601 — orders@afdfloor.com / 909-923-1111) is onboarded as its
 * OWN vendor (code AFD). Warehouses in City of Industry CA, N. Las Vegas NV,
 * and Phoenix AZ.
 *
 * Product families:
 *   SPC          — rigid-core waterproof vinyl plank (10 collections + glue-down LVT)
 *   Laminate     — water-resistant laminate (Oak / Aqua Tech / Aqua Tech Plus / Lakeview)
 *   Wall panel   — acoustic slat wood wall panels
 *   Accessory    — generic SPC trim (T-mould / reducer / end-cap / Q-round / stair)
 *   Underlayment — EPE / EVA foam + poly moisture barrier
 *   Moulding     — MDF baseboard (wall-base), casing + crown (moulding)
 *
 * Pricing: the sheet lists a STOCK PRICE (min 2-pallet) and a JOB PACK PRICE for
 * flooring; moulding lists Pallet / Min-60 / Job Pack per-piece tiers. Per the
 * store owner, Roma's COST = the JOB PACK price (real small-lot buy price) across
 * the board. Retail = cost x 1.6, nickel-rounded at import time (store keystone —
 * see [[selling-conventions]]). This script only transcribes the sheet.
 *
 * Flooring / wall panels sold per sqft (by the box → sell_by 'box', price_basis
 * 'per_sqft'). Accessories / underlayment / moulding sold per piece or roll
 * (sell_by 'unit', price_basis 'per_unit'). Each vendor item# = one product with
 * a single field SKU (mirrors the Mango/PDI model — see [[pdi-onboarding]]).
 *
 * Usage: node scripts/build-afd-catalog.js   (writes ../data/afd/catalog.json)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'data', 'afd');

const VENDOR = {
  name: 'American Flooring Distributor',
  code: 'AFD',
  website: 'https://afdfloor.com',
  email: 'orders@afdfloor.com',
  phone: '909-923-1111',
  address: '3847 Capitol Ave, City of Industry, CA 90601',
  notes: 'Metro Los Angeles price list effective May 5, 2025. Cost = Job Pack price; retail applied at x1.6. Distributor — warehouses in City of Industry CA (HQ), N. Las Vegas NV, Phoenix AZ. Families: SPC rigid vinyl, water-resistant laminate, acoustic wall panels, MDF baseboard/casing/crown moulding.',
};

// ============================================================================
// FLOORING & WALL-PANEL GROUPS: shared specs + [item#, colorName, {overrides}]
// `cost` is the Job Pack price. `over` on a row overrides a shared field.
// ============================================================================
const GROUPS = [
  // ============================ SPC — 10 collections ============================
  {
    collection: "Builder's Choice", category: 'lvp-plank', material: 'SPC', family: 'spc',
    sqft_box: 29, cost: 1.65,
    specs: {
      construction: '100% Waterproof Rigid Core (SPC)', thickness: '5 mm',
      width: '7 in', length: '48 in', wear_layer: '12 mil',
      underlayer: '1 mm EVA attached pad', edge_type: 'Painted Bevel',
      surface_texture: 'Wood Grain Embossed', installation_method: 'Floating (Click Lock)',
      features: 'Waterproof', certification: 'FloorScore Certified',
    },
    rows: [
      ['BC001', 'BC001'], ['BC002', 'BC002'], ['BC003', 'BC003'],
      ['BC004', 'BC004'], ['BC005', 'BC005'], ['BC006', 'BC006'],
    ],
  },
  {
    collection: 'Metropolitan', category: 'lvp-plank', material: 'SPC', family: 'spc',
    sqft_box: 30.33, cost: 1.75,
    specs: {
      construction: '100% Waterproof Rigid Core (SPC)', thickness: '5 mm',
      width: '9 1/4 in', length: '48 in', wear_layer: '20 mil',
      underlayer: '1 mm EVA attached pad', edge_type: 'Painted Bevel',
      surface_texture: 'Deep Embossed', installation_method: 'Floating (Uniclic)',
      features: 'Waterproof', certification: 'FloorScore Certified',
    },
    rows: [
      ['M741', 'Los Angeles'], ['M742', 'San Diego'], ['M743', 'Las Vegas'],
      ['M744', 'San Jose'], ['M747', 'New York'], ['M752', 'Miami'],
      ['M753', 'Seattle'], ['M756', 'San Antonio'],
      ['M754', 'Phoenix', { width: '7 1/4 in', sqft_box: 24.82 }],
      ['M755', 'Chicago', { width: '7 1/4 in', sqft_box: 24.82 }],
    ],
  },
  {
    collection: 'American', category: 'lvp-plank', material: 'SPC', family: 'spc',
    sqft_box: 29.55, cost: 1.75,
    specs: {
      construction: '100% Waterproof Rigid Core (SPC)', thickness: '5.7 mm',
      width: '7 1/4 in', length: '60 in', wear_layer: '20 mil',
      underlayer: '1.5 mm IXPE attached pad', edge_type: 'Painted Bevel',
      surface_texture: 'Wood Grain Embossed', installation_method: 'Floating (Click Lock)',
      features: 'Waterproof', certification: 'FloorScore Certified',
    },
    rows: [
      ['A501', 'Savannah'], ['A504', 'Key West'], ['A505', 'Monterey'], ['A512', 'Pensacola'],
    ],
  },
  {
    collection: 'Beach', category: 'lvp-plank', material: 'SPC', family: 'spc',
    sqft_box: 22.28, cost: 1.95,
    specs: {
      construction: '100% Waterproof Rigid Core (SPC)', thickness: '6.5 mm',
      width: '9 in', length: '60 in', wear_layer: '20 mil',
      underlayer: '1.5 mm EVA attached pad', edge_type: 'Painted Bevel',
      surface_texture: 'EIR Registered Emboss', installation_method: 'Floating (Click Lock)',
      features: 'Waterproof', certification: 'FloorScore Certified',
    },
    rows: [
      ['B401', 'Clearwater'], ['B402', 'Harris'], ['B403', 'Coronado'],
      ['B404', 'Santa Monica'], ['B405', 'Newport'], ['B406', 'Laguna'],
      ['B407', 'Daytona'], ['B408', 'Carmel'], ['B409', 'South Beach'], ['B410', 'Myrtle Beach'],
    ],
  },
  {
    collection: 'Natural', category: 'lvp-plank', material: 'SPC', family: 'spc',
    sqft_box: 22.5, cost: 1.85,
    specs: {
      construction: '100% Waterproof Rigid Core (SPC)', thickness: '6 mm',
      width: '9 in', length: '60 in', wear_layer: '20 mil',
      underlayer: '1.5 mm EVA attached pad', edge_type: 'Painted Bevel',
      surface_texture: 'Wood Grain Embossed', installation_method: 'Floating (Click Lock)',
      features: 'Waterproof', certification: 'FloorScore Certified',
    },
    rows: [
      ['N961', 'Hot Springs'], ['N962', 'Great Basin'], ['N963', 'White Sands'],
      ['N964', 'Joshua Tree'], ['N965', 'Kings Canyon'],
    ],
  },
  {
    collection: 'Natural Plus', category: 'lvp-plank', material: 'SPC', family: 'spc',
    sqft_box: 22.5, cost: 2.05,
    specs: {
      construction: '100% Waterproof Rigid Core (SPC)', thickness: '6 mm',
      width: '9 in', length: '60 in', wear_layer: '20 mil',
      underlayer: '1.0 mm IXPE attached pad', edge_type: 'Painted Bevel',
      surface_texture: 'EIR Registered Emboss', installation_method: 'Floating (Click Lock)',
      features: 'Waterproof', certification: 'FloorScore Certified',
    },
    rows: [
      ['N971', 'Acadia'], ['N972', 'Big Bend'], ['N973', 'Biscayne'],
      ['N974', 'Carlsbad'], ['N975', 'Denali'], ['N976', 'Everglades'],
      ['N977', 'Glacier'], ['N978', 'Grand Canyon'], ['N979', 'Sequoia'],
    ],
  },
  {
    collection: 'European', category: 'lvp-plank', material: 'SPC', family: 'spc',
    sqft_box: 22.73, cost: 2.05,
    specs: {
      construction: '100% Waterproof Rigid Core (SPC)', thickness: '6.5 mm',
      width: '9 1/4 in', length: '60 in', wear_layer: '20 mil',
      underlayer: '1.5 mm IXPE attached pad', edge_type: 'Painted Bevel',
      surface_texture: 'Wood Grain Embossed', installation_method: 'Floating (Click Lock)',
      features: 'Waterproof', certification: 'FloorScore Certified',
    },
    rows: [
      ['E621', 'Sevilla'], ['E622', 'Lyon'], ['E624', 'Madrid'], ['E626', 'Napoli'],
      ['E627', 'Messina'], ['E630', 'Dijon'], ['E631', 'Paris'],
    ],
  },
  {
    collection: 'Paramount', category: 'lvp-plank', material: 'SPC', family: 'spc',
    sqft_box: 18.65, cost: 2.25,
    specs: {
      construction: '100% Waterproof Rigid Core (SPC)', thickness: '8 mm',
      width: '9 1/4 in', length: '60 in', wear_layer: '20 mil',
      underlayer: '2 mm IXPE attached pad', edge_type: 'Painted Bevel',
      surface_texture: 'Wood Grain Embossed', installation_method: 'Floating (Click Lock)',
      features: 'Waterproof', certification: 'FloorScore Certified',
    },
    rows: [
      ['P851', 'Amber'], ['P852', 'Coral'], ['P853', 'Ruby'],
      ['P856', 'Pearl'], ['P857', 'Jasper'], ['P858', 'Diamond'],
    ],
  },
  {
    collection: 'Olympus', category: 'lvp-plank', material: 'SPC', family: 'spc',
    sqft_box: 27.14, cost: 2.39,
    specs: {
      construction: '100% Waterproof Rigid Core (SPC)', thickness: '8 mm',
      width: '9 in', length: '72 in', wear_layer: '20 mil',
      underlayer: '1.5 mm EVA attached pad', edge_type: 'Painted Bevel',
      surface_texture: 'EIR Registered Emboss', installation_method: 'Floating (Click Lock)',
      features: 'Waterproof', certification: 'FloorScore Certified',
    },
    rows: [
      ['O2501', 'Zeus'], ['O2502', 'Poseidon'], ['O2503', 'Hera'], ['O2504', 'Demeter'],
    ],
  },
  {
    collection: 'Celestial', category: 'lvp-plank', material: 'SPC', family: 'spc',
    sqft_box: 22.71, cost: 2.39,
    specs: {
      construction: '100% Waterproof Rigid Core (SPC)', thickness: '8 mm',
      width: '9 in', length: '60 in', wear_layer: '20 mil',
      underlayer: '1.5 mm IXPE attached pad', edge_type: 'Painted Bevel',
      surface_texture: 'EIR Registered Emboss', installation_method: 'Floating (Click Lock)',
      features: 'Waterproof', certification: 'FloorScore Certified',
    },
    rows: [
      ['C1201', 'Antares'], ['C1202', 'Rigel'], ['C1203', 'Vega'],
      ['C1204', 'Sirius'], ['C1205', 'Pollux'],
    ],
  },
  {
    // Glue-down flexible LVT plank (not rigid SPC). Plank-format → lvp-plank.
    collection: 'LVT Glue Down', category: 'lvp-plank', material: 'LVT', family: 'lvt',
    sqft_box: 53.1, cost: 0.99,
    specs: {
      construction: 'Glue-Down Luxury Vinyl (LVT)', thickness: '2 mm',
      width: '7 1/4 in', length: '48 in', wear_layer: '12 mil',
      edge_type: 'Square', surface_texture: 'Wood Grain', installation_method: 'Glue-Down',
      features: 'Water Resistant',
    },
    rows: [
      ['819-6', '819-6'], ['828-8', '828-8'], ['818-2', '818-2'], ['825-1', '825-1'],
      ['1034-2', '1034-2'], ['6169-1', '6169-1'], ['6253-5', '6253-5'],
    ],
  },

  // ======================= LAMINATE — 4 collections =======================
  {
    collection: 'Oak', category: 'laminate', material: 'Laminate', family: 'laminate',
    sqft_box: 23.11, cost: 1.85,
    specs: {
      construction: 'Water-Resistant Laminate', thickness: '12 mm',
      width: '9 1/4 in', length: '60 in', abrasion_resistance: 'AC4',
      surface_texture: 'EIR Registered Emboss', installation_method: 'Floating (Click Lock)',
      features: 'Water Resistant',
    },
    rows: [
      ['T351', 'Willow Oak'], ['T352', 'English Oak'], ['T353', 'Post Oak'],
      ['T354', 'Scarlet Oak'], ['T355', 'Chestnut Oak'], ['T356', 'Cork Oak'],
    ],
  },
  {
    collection: 'Aqua Tech', category: 'laminate', material: 'Laminate', family: 'laminate',
    sqft_box: 20.54, cost: 1.09,
    specs: {
      construction: 'Water-Resistant Laminate', thickness: '8 mm',
      width: '7 3/4 in', length: '48 in', abrasion_resistance: 'AC3',
      surface_texture: 'EIR Registered Emboss', installation_method: 'Floating (Click Lock)',
      features: 'Water Resistant',
    },
    rows: [['T291', 'Tahoe'], ['T292', 'Shasta']],
  },
  {
    collection: 'Aqua Tech Plus', category: 'laminate', material: 'Laminate', family: 'laminate',
    sqft_box: 18.74, cost: 1.39,
    specs: {
      construction: 'Water-Resistant Laminate', thickness: '12 mm',
      width: '9 3/8 in', length: 'Random 24 / 48 / 72 in', abrasion_resistance: 'AC4',
      surface_texture: 'EIR Registered Emboss', installation_method: 'Floating (Click Lock)',
      features: 'Water Resistant',
    },
    rows: [
      ['T381', 'Powell'], ['T382', 'Michigan'], ['T383', 'Ozarks'],
      ['T384', 'Superior'], ['T385', 'Champlain'],
    ],
  },
  {
    collection: 'Lakeview', category: 'laminate', material: 'Laminate', family: 'laminate',
    sqft_box: 23.29, cost: 2.25,
    specs: {
      construction: 'Water-Resistant Laminate', thickness: '12 mm',
      width: '9 3/8 in', length: '60 in', abrasion_resistance: 'AC5',
      surface_texture: 'EIR Registered Emboss', installation_method: 'Floating (Click Lock)',
      features: 'Water Resistant',
    },
    rows: [
      ['L111', 'Echo'], ['L112', 'Martin'], ['L113', 'Mile Lacs'], ['L114', 'Flathead'],
      ['L115', 'Liberty'], ['L116', 'Havasu'], ['L117', 'Folsom'], ['L118', 'Silverwood'],
      ['L119', 'Erie'], ['L120', 'Chelan'], ['L121', 'Saint Clair'], ['L122', 'Lanier'],
      ['L123', 'Huron'], ['L124', 'Clark'],
    ],
  },

  // ===================== WALL PANELS — acoustic slat =====================
  {
    collection: 'Acoustic Slat Wall Panels', category: 'wall-panels',
    material: 'Acoustic Wood Slat', family: 'wall_panel',
    sqft_box: 36, cost: 4.25,
    specs: {
      construction: 'Acoustic Slat Wall Panel (felt-backed wood slat)',
      size: '108 in x 24 in x 3/4 in', installation_method: 'Cleat / Screw Mount',
      features: 'Sound Absorbing', inner_quantity: '2 pcs/box',
    },
    rows: [
      ['WP-01', 'American Walnut'], ['WP-02', 'Natural Oak'], ['WP-03', 'Dusty Grey'],
      ['WP-04', 'Midnight Grey'], ['WP-05', 'Luxury Black'], ['WP-06', 'Snow White'],
    ],
  },
  {
    collection: 'Acoustic Slat Wall Panels', category: 'wall-panels',
    material: 'Acoustic Wood Slat', family: 'wall_panel',
    sqft_box: 37.5, cost: 4.95,
    specs: {
      construction: 'Acoustic Slat Wall Panel (felt-backed wood slat)',
      size: '120 in x 22 1/2 in x 13/16 in', installation_method: 'Cleat / Screw Mount',
      features: 'Sound Absorbing', inner_quantity: '2 pcs/box',
    },
    rows: [
      ['WP-1013', 'Zebra Wood'], ['WP-1014', 'South American Walnut'],
      ['WP-1015', 'White Oak'], ['WP-1016', 'Black Walnut'],
    ],
  },
];

// ============================================================================
// UNIT ITEMS — one product each, sold per piece/roll (sell_by 'unit').
// cost = Job Pack price. Grouped by category for the importer.
// ============================================================================

// Generic SPC trim / accessories (not color-matched) — category transitions-moldings
const ACCESSORIES = [
  { code: 'AFD-TMOLD', name: 'T-Moulding', desc: 'SPC floor T-moulding, 94.5" long. Bridges two floors of equal height in a doorway or transition.', cost: 19.50 },
  { code: 'AFD-REDUCER', name: 'Reducer', desc: 'SPC floor reducer, 94.5" long. Transitions from SPC flooring down to a lower surface.', cost: 19.50 },
  { code: 'AFD-ENDCAP', name: 'End Cap', desc: 'SPC floor end cap, 94.5" long. Finishes an exposed floor edge at a sliding door, carpet, or hearth.', cost: 19.50 },
  { code: 'AFD-QROUND', name: 'Quarter Round', desc: 'SPC floor quarter round, 94.5" long. Covers the expansion gap along a baseboard.', cost: 19.50 },
  { code: 'AFD-STAIRNOSE', name: 'Flush Stair Nose', desc: 'SPC flush stair nose, 94.5" long. Finishes the leading edge of a stair tread.', cost: 32.00 },
  { code: 'AFD-STAIRTREAD', name: 'Stair Tread', desc: 'SPC stair tread, 12" x 49". Full-depth prefinished tread for a staircase step.', cost: 55.00 },
];

// Underlayment / moisture barrier — category underlayment (sold per roll)
const UNDERLAYMENT = [
  { code: 'AFD-EPE3', name: '3mm EPE Silver Foam', desc: '3 mm EPE silver foam underlayment, 200 sq ft per roll.', cost: 20.00, coverage: '200 sq ft/roll' },
  { code: 'AFD-EVA3', name: '3mm EVA Black Foam', desc: '3 mm EVA black foam underlayment, 200 sq ft per roll.', cost: 35.00, coverage: '200 sq ft/roll' },
  { code: 'AFD-POLY6', name: '6mil Poly Moisture Barrier', desc: '6 mil clear virgin polyethylene moisture barrier sheet, 500 sq ft per roll.', cost: 35.00, coverage: '500 sq ft/roll' },
];

// ---------------------------- MDF MOULDING ---------------------------------
// cost = Job Pack per-piece price. Baseboard → wall-base; casing + crown → moulding.
// Rows: [item#, profileName, thickness, width, length, jobPackPC]
const BASEBOARD = [
  ['AFD314-3', 'Coronado Base', '9/16 in', '3 1/4 in', '16 ft', 9.12],
  ['AFD388-3', '1 Eased Edge Craftsman Base', '1/2 in', '3 1/2 in', '16 ft', 8.80],
  ['AFD311-3', '#711 Base', '1/2 in', '3 1/2 in', '16 ft', 8.80],
  ['AFD329-3', 'Newport Base', '9/16 in', '3 7/8 in', '16 ft', 10.88],
  ['AFD318-4', 'Cape Cod Base', '9/16 in', '4 in', '16 ft', 11.20],
  ['AFD326-4', 'Crescent Base', '9/16 in', '4 1/4 in', '16 ft', 11.84],
  ['AFD314-4', 'Coronado Base', '9/16 in', '4 1/4 in', '16 ft', 11.84],
  ['AFD118-4', 'Colonial Base', '9/16 in', '4 1/4 in', '16 ft', 11.84],
  ['AFD327-4', 'Del Mar Base', '9/16 in', '4 1/2 in', '16 ft', 12.48],
  ['AFD325-4', 'Imperial Base', '9/16 in', '4 1/2 in', '16 ft', 12.48],
  ['AFD388-4', '1 Eased Edge Craftsman Base', '1/2 in', '4 1/2 in', '16 ft', 11.20],
  ['AFD392-4', 'S4S Notched Modern Base', '9/16 in', '4 1/2 in', '16 ft', 12.48],
  ['AFD330-5', 'Newport Base', '9/16 in', '5 in', '16 ft', 13.92],
  ['AFD390-5', 'Intrada Base', '9/16 in', '5 in', '16 ft', 13.92],
  ['AFD318-5', 'Cape Cod Base', '9/16 in', '5 1/4 in', '16 ft', 14.72],
  ['AFD118-5', 'Colonial Base', '9/16 in', '5 1/4 in', '16 ft', 14.72],
  ['AFD314-5', 'Coronado Base', '9/16 in', '5 1/4 in', '16 ft', 14.72],
  ['AFD328-5', 'Vintage Base', '9/16 in', '5 1/4 in', '16 ft', 14.72],
  ['AFD388-5', '1 Eased Edge Craftsman Base', '1/2 in', '5 1/2 in', '16 ft', 13.76],
  ['AFD392-5', 'S4S Notched Modern Base', '9/16 in', '5 1/2 in', '16 ft', 15.36],
  ['AFD332-5', 'Crescent Base', '9/16 in', '5 3/4 in', '16 ft', 19.68],
  ['AFD342-6', 'Imperial Base', '9/16 in', '6 in', '16 ft', 16.96],
  ['AFD328-6', 'Vintage Base', '9/16 in', '6 1/8 in', '16 ft', 17.28],
  ['AFD388-7', '1 Eased Edge Craftsman Base', '1/2 in', '7 1/4 in', '16 ft', 18.24],
  ['AFD314-7', 'Coronado Base', '9/16 in', '7 1/4 in', '16 ft', 20.48],
  ['AFDPR300FJ', 'Pine Base Shoe', '1/2 in', '3/4 in', '16 ft', 6.40],
  ['AFDPR301', 'Pine Base Shoe', '7/16 in', '11/16 in', '16 ft', 6.40],
  ['AFDR504', 'LVL Quarter Round', '3/4 in', '3/4 in', '16 ft', 8.00],
  ['AFDR504FJ', 'Pine Quarter Round', '3/4 in', '3/4 in', '16 ft', 8.00],
  ['AFDR505', 'Pine Quarter Round', '11/16 in', '11/16 in', '16 ft', 8.00],
  ['AFD300S', 'Wood Square Base Shoe', '1/2 in', '3/4 in', '16 ft', 6.40],
  ['AFD715-3', 'S4S 3 1/2" Square Edge Base', '11/16 in', '3 1/2 in', '17 ft', 12.07],
  ['AFD715-7', 'S4S 7 1/4" Square Edge Base', '11/16 in', '7 1/4 in', '17 ft', 21.28],
  ['AFD715-11', 'S4S 11 1/4" Square Edge Base', '11/16 in', '11 1/4 in', '17 ft', 36.55],
  ['AFD2010-6', '6" Shiplap', '5/8 in', '6 in', '17 ft', 23.80],
  ['AFD2010-8', '8" Shiplap', '5/8 in', '8 in', '17 ft', 30.60],
];

const CASING = [
  ['AFD102', 'Beveled / Streamline Casing', '9/16 in', '1 5/8 in', '17 ft', 4.08],
  ['AFD120', '2 Round Edge Casing', '9/16 in', '2 1/4 in', '17 ft', 5.95],
  ['AFD122', '2 Round Edge Casing', '9/16 in', '2 3/4 in', '17 ft', 7.48],
  ['AFD139', '2 Round Edge Casing', '9/16 in', '3 1/4 in', '17 ft', 8.67],
  ['AFD152', 'Colonial Casing', '5/8 in', '2 1/4 in', '17 ft', 6.46],
  ['AFD108', '#711 Casing', '5/8 in', '2 1/2 in', '17 ft', 7.14],
  ['AFD134', 'Newport Casing', '5/8 in', '2 1/2 in', '17 ft', 6.97],
  ['AFD150', 'Cape Cod Casing', '5/8 in', '2 1/2 in', '17 ft', 7.14],
  ['AFD127', 'Del Mar Casing', '5/8 in', '3 in', '17 ft', 8.67],
  ['AFD197', 'Notched Modern Casing', '11/16 in', '2 1/2 in', '17 ft', 7.99],
  ['AFD198', 'Ogee Casing', '11/16 in', '2 1/2 in', '17 ft', 7.99],
  ['AFD169', 'Victorian Casing', '11/16 in', '2 1/2 in', '17 ft', 7.82],
  ['AFD168', 'Crescent Casing', '3/4 in', '2 5/8 in', '17 ft', 9.01],
  ['AFD125', 'Newport Casing', '11/16 in', '2 7/8 in', '17 ft', 9.18],
  ['AFD188', 'I Step Casing', '3/4 in', '2 1/2 in', '17 ft', 10.54],
  ['AFD192', 'Intrada Casing', '11/16 in', '3 in', '17 ft', 10.03],
  ['AFD129', 'Bel-Air Casing', '3/4 in', '3 1/4 in', '17 ft', 11.56],
  ['AFD191', 'Chandler Casing', '1 in', '3 1/4 in', '17 ft', 15.30],
  ['AFD159', 'Lancaster Casing', '1 in', '2 1/2 in', '17 ft', 11.39],
  ['AFD160', 'Lancaster Casing', '1 3/16 in', '3 1/4 in', '17 ft', 18.36],
];

const CROWN = [
  ['AFD405', 'Colonial Crown', '9/16 in', '3 1/4 in', '16 ft', 8.16],
  ['AFD410-4', 'Charleston Crown', '9/16 in', '4 1/4 in', '16 ft', 10.56],
  ['AFD422', 'Venetian Crown', '9/16 in', '4 1/2 in', '16 ft', 11.36],
  ['AFD426', 'Georgian Crown', '9/16 in', '3 7/16 in', '16 ft', 8.80],
  ['AFD406', 'Colonial Crown', '9/16 in', '4 1/16 in', '16 ft', 10.40],
  ['AFD412', 'Georgian Crown', '9/16 in', '4 1/2 in', '16 ft', 11.36],
  ['AFD414', 'Colonial Crown', '9/16 in', '5 1/4 in', '16 ft', 12.80],
  ['AFD416', 'Colonial Crown', '9/16 in', '6 1/2 in', '16 ft', 16.00],
  ['AFD417', 'Colonial Crown', '9/16 in', '7 1/4 in', '16 ft', 18.56],
  ['AFD460-4', 'Craftsman Crown', '9/16 in', '4 1/4 in', '16 ft', 10.40],
  ['AFD410-6', 'Charleston Crown', '9/16 in', '6 in', '16 ft', 15.68],
  ['AFD421', 'Double Bead Carolina Crown', '3/4 in', '3 3/8 in', '16 ft', 11.20],
  ['AFD444-4', 'Contemporary Crown', '9/16 in', '4 1/4 in', '16 ft', 10.56],
  ['AFD460-5', 'Craftsman Crown', '3/4 in', '5 1/4 in', '16 ft', 17.44],
  ['AFD427', 'Georgian Crown', '3/4 in', '6 1/2 in', '16 ft', 22.40],
  ['AFD423', 'Double Bead Carolina Crown', '3/4 in', '4 5/8 in', '16 ft', 16.00],
  ['AFD424-6', 'Double Bead Carolina Crown', '1 in', '6 1/2 in', '16 ft', 29.44],
  ['AFD424-7', 'Double Bead Carolina Crown', '1 in', '7 3/16 in', '16 ft', 34.24],
  ['AFD410-8', 'Charleston Crown', '1 in', '8 in', '16 ft', 38.72],
  ['AFD428', 'Georgian Crown', '1 in', '8 in', '16 ft', 38.72],
  ['AFD444-5', 'Contemporary Crown', '1 1/4 in', '5 5/8 in', '16 ft', 32.32],
  ['AFD433', 'Del Mar Crown', '1 in', '6 3/4 in', '16 ft', 29.92],
  ['AFD444-7', 'Contemporary Crown', '1 1/4 in', '7 1/4 in', '16 ft', 42.88],
  ['AFD454', 'Del Mar Crown', '1 in', '8 1/2 in', '16 ft', 41.12],
];

// ============================================================================
// Assemble catalog
// ============================================================================
function sizeStr(s) {
  if (s.size) return s.size;
  const parts = [s.width, s.length].filter(Boolean).join(' x ');
  return s.thickness ? `${parts} x ${s.thickness}` : parts;
}

const products = [];
for (const g of GROUPS) {
  for (const [code, color, over] of g.rows) {
    const specs = { ...g.specs, ...(over || {}) };
    const sqft_box = (over && over.sqft_box != null) ? over.sqft_box : g.sqft_box;
    products.push({
      code, internal_sku: `AFD-${code}`,
      name: color, collection: g.collection,
      category: g.category, material: g.material, family: g.family,
      status: 'active', sell_by: 'box', price_basis: 'per_sqft',
      sqft_box, cost: g.cost, specs: { ...specs, size: sizeStr(specs) },
    });
  }
}

// Moulding: one product per profile (family 'moulding'), sold per unit.
// A profile name (e.g. "Coronado Base") recurs at several widths within a
// collection, so the width is folded into the product name to keep it unique
// (product unique key is vendor+collection+name).
const mould = (rows, category, kind) => rows.map(([code, name, thickness, width, length, cost]) => ({
  code, internal_sku: `AFD-${code}`,
  name: `${name} ${width.replace(/ in$/, '"')}`, collection: kind, category, material: 'MDF', family: 'moulding',
  status: 'active', sell_by: 'unit', price_basis: 'per_unit',
  cost, specs: { material: 'MDF', profile_code: code, thickness, width, length, size: `${thickness} x ${width} x ${length}` },
}));

// NOTE: MDF baseboard / casing / crown are intentionally NOT imported per the
// store owner (2026-07-30). The BASEBOARD / CASING / CROWN transcriptions and the
// mould() helper are retained above for reference / easy restore, but are not
// emitted into catalog.json.
void mould; void BASEBOARD; void CASING; void CROWN;

const catalog = {
  vendor: VENDOR,
  products,          // flooring + wall panels (sell_by box / per_sqft)
  accessories: ACCESSORIES,
  underlayment: UNDERLAYMENT,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2));

// ---- Summary ----
const byCat = {};
for (const p of products) byCat[p.category] = (byCat[p.category] || 0) + 1;
console.log('=== AFD catalog.json written ===');
console.log(`Flooring/wall-panel products: ${products.length}`);
console.log(`Accessories:                  ${ACCESSORIES.length}`);
console.log(`Underlayment:                 ${UNDERLAYMENT.length}`);
console.log(`Total sellable items:         ${products.length + ACCESSORIES.length + UNDERLAYMENT.length}`);
console.log('(MDF baseboard/casing/crown excluded per owner)');
console.log('By category:', byCat);
