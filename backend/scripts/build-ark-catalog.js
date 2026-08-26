#!/usr/bin/env node
/**
 * Build backend/data/ark/catalog.json from the ARK Floors Q2-2026 Preferred
 * Price List (+ 2026 Engineered Oak Close-Out sheet + molding wholesale sheet).
 *
 * ARK Floors, Inc. — 11119 Rush Street, S. El Monte, CA 91733 — is the wholesale
 * distributor/manufacturer (exotic + oak engineered & solid hardwood). The
 * "COST F.O.B. ARK WHSE / PREFERRED" column on the sheet is Roma's COST; retail =
 * cost x1.6 nickel-rounded keystone (store standard — see [[selling-conventions]],
 * [[garrison-onboarding]]). Flooring is sold per sqft by the box.
 *
 * The catalog groups floor rows into products by (construction, collection,
 * species, color). Engineered and Solid are ALWAYS separate products because the
 * storefront category (engineered-hardwood vs solid-hardwood) lives on the
 * product, not the SKU. Same-color rows that differ only by width / wear-layer
 * become size-variant SKUs of one product (e.g. Genuine Mahogany Sable Solid =
 * 3-5/8" + 4-3/4").
 *
 * Moldings: the sheet prices custom color-matched transition moldings by the
 * BASE WOOD they are milled from, not per color — two sets:
 *   A "Oak & Maple"        (QR35/RD64/TM64/EC64/SN88)  → Oak/Birch/Hickory/Acacia
 *   B "Brazilian Cherry"   (QR35/RD72/TM72/EC72/SN120) → the reddish exotics
 * Each set is one storefront product (5 per-piece accessory SKUs) attached to
 * every floor of the matching species so they surface in "Matching Accessories".
 *
 * Usage: node scripts/build-ark-catalog.js   (pure, no DB — writes catalog.json)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'ark', 'catalog.json');

// ---- Flat floor rows straight off the PDF -----------------------------------
// c=construction (E engineered / S solid). st=status flag: ''=active,
// 'closeout', 'disc'(ontinued). thk=nominal thickness, wl=engineered wear layer,
// w=face width, len=length spec, lwt=the mm L*W*T string, sf=sqft/box,
// lb=lbs/box, bp=boxes/pallet, cost=preferred cost/sqft.
const F = (o) => o;
const ROWS = [
  // ===== ELEGANT EXOTIC — ENGINEERED =====
  F({ item:'ARK-EB07A01', col:'Elegant Exotic', sp:'Genuine Mahogany', clr:'Natural', name:'Genuine Mahogany Natural', c:'E', thk:'1/2"', wl:'1.5mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12/1.5', sf:33.70, lb:60, bp:40, cost:3.49 }),
  F({ item:'ARK-EB07A02', col:'Elegant Exotic', sp:'Genuine Mahogany', clr:'Cocoa', name:'Genuine Mahogany Cocoa', c:'E', thk:'1/2"', wl:'1.5mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12/1.5', sf:33.70, lb:60, bp:40, cost:3.49 }),
  F({ item:'ARK-EB07A03', col:'Elegant Exotic', sp:'Genuine Mahogany', clr:'Sable', name:'Genuine Mahogany Sable', c:'E', thk:'1/2"', wl:'1.5mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12/1.5', sf:33.70, lb:60, bp:40, cost:3.49 }),
  F({ item:'ARK-EB07A04', col:'Elegant Exotic', sp:'Genuine Mahogany', clr:'Silver', name:'Genuine Mahogany Silver', c:'E', thk:'1/2"', wl:'1.5mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12/1.5', sf:33.70, lb:60, bp:40, cost:3.49 }),
  F({ item:'ARK-EB44A02', col:'Elegant Exotic', sp:'Acacia', clr:'Morning Coffee', name:'Acacia Morning Coffee', c:'E', thk:'1/2"', wl:'1.5mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12/1.5', sf:33.70, lb:55, bp:40, cost:3.49 }),
  F({ item:'ARK-EB44A08', col:'Elegant Exotic', sp:'Acacia', clr:'Bourbon', name:'Acacia Bourbon', c:'E', thk:'1/2"', wl:'1.5mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12/1.5', sf:33.70, lb:55, bp:40, cost:3.49 }),
  F({ item:'ARK-EB08A01-3M', col:'Elegant Exotic', sp:'Brazilian Cherry (Jatoba)', clr:'Cherry Stain', name:'Brazilian Cherry (Jatoba) Cherry Stain', c:'E', thk:'1/2"', wl:'3.0mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12/3.0', sf:33.70, lb:62, bp:40, cost:4.49 }),
  F({ item:'ARK-EB08A01-N', col:'Elegant Exotic', sp:'Brazilian Cherry (Jatoba)', clr:'Natural', name:'Brazilian Cherry (Jatoba) Natural', c:'E', thk:'1/2"', wl:'2.0mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12.7/2.0', sf:33.70, lb:62, bp:40, cost:3.99 }),
  F({ item:'ARK-EB08A01-N-3M', col:'Elegant Exotic', sp:'Brazilian Cherry (Jatoba)', clr:'Natural', name:'Brazilian Cherry (Jatoba) Natural', c:'E', thk:'1/2"', wl:'3.0mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12/3.0', sf:33.70, lb:62, bp:40, cost:4.49 }),
  F({ item:'ARK-EB08A02', col:'Elegant Exotic', sp:'Brazilian Cherry (Jatoba)', clr:'Sable', name:'Brazilian Cherry (Jatoba) Sable', c:'E', thk:'1/2"', wl:'2.0mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12.7/2.0', sf:33.70, lb:62, bp:40, cost:3.99 }),
  F({ item:'ARK-EB11A01', col:'Elegant Exotic', sp:'Tigerwood', clr:'Natural', name:'Tigerwood Natural', c:'E', thk:'1/2"', wl:'2.0mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12.7/2.0', sf:33.70, lb:60, bp:40, cost:3.99 }),
  F({ item:'ARK-EB12A01', col:'Elegant Exotic', sp:'Santos Mahogany', clr:'Natural', name:'Santos Mahogany Natural', c:'E', thk:'1/2"', wl:'2.0mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12.7/2.0', sf:33.70, lb:60, bp:40, cost:4.99 }),
  F({ item:'ARK-EB10A01', col:'Elegant Exotic', sp:'Brazilian Teak (Cumaru)', clr:'Natural', name:'Brazilian Teak (Cumaru) Natural', c:'E', thk:'1/2"', wl:'3.0mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*120*12/3.0', sf:32.87, lb:62, bp:40, cost:4.49 }),
  F({ item:'ARK-EB10A02', col:'Elegant Exotic', sp:'Brazilian Teak (Cumaru)', clr:'Red', name:'Brazilian Teak (Cumaru) Red', c:'E', thk:'1/2"', wl:'3.0mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*120*12/3.0', sf:32.87, lb:62, bp:40, cost:3.99 }),
  F({ item:'ARK-EB10A03', col:'Elegant Exotic', sp:'Brazilian Teak (Cumaru)', clr:'Chocolate', name:'Brazilian Teak (Cumaru) Chocolate', c:'E', thk:'1/2"', wl:'3.0mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*120*12/3.0', sf:32.87, lb:62, bp:40, cost:3.99 }),
  F({ item:'ARK-EB35J01', col:'Elegant Exotic', sp:'Kuku Cigar', clr:'Walnut Natural', name:'Kuku Cigar Walnut Natural', c:'E', thk:'1/2"', wl:'3.0mm', w:'5-2/3"', len:"1'-6' RL Avg 3'", lwt:'RL(2121)*144*12.7/3.0', sf:32.88, lb:60, bp:48, cost:4.79 }),

  // ===== ELEGANT EXOTIC — SOLID =====
  F({ item:'ARK-S07B03', col:'Elegant Exotic', sp:'Genuine Mahogany', clr:'Sable', name:'Genuine Mahogany Sable', c:'S', thk:'3/4"', wl:null, w:'3-5/8"', len:"1'-5' RL Avg 2.3'", lwt:'RL(2121)*92*18', sf:25.20, lb:62, bp:52, cost:4.49 }),
  F({ item:'ARK-S07B04', col:'Elegant Exotic', sp:'Genuine Mahogany', clr:'Silver', name:'Genuine Mahogany Silver', c:'S', thk:'3/4"', wl:null, w:'3-5/8"', len:"1'-5' RL Avg 2.3'", lwt:'RL(2121)*92*18', sf:25.20, lb:62, bp:52, cost:4.49 }),
  F({ item:'ARK-S08B01', col:'Elegant Exotic', sp:'Brazilian Cherry (Jatoba)', clr:'Cherry Stain', name:'Brazilian Cherry (Jatoba) Cherry Stain', c:'S', thk:'3/4"', wl:null, w:'3-5/8"', len:"1'-6' RL Avg 2.3'", lwt:'RL(2121)*92*18', sf:25.50, lb:92, bp:44, cost:5.99 }),
  F({ item:'ARK-S08B01-N', col:'Elegant Exotic', sp:'Brazilian Cherry (Jatoba)', clr:'Natural', name:'Brazilian Cherry (Jatoba) Natural', c:'S', thk:'3/4"', wl:null, w:'3-5/8"', len:"1'-6' RL Avg 2.3'", lwt:'RL(2121)*92*18', sf:25.58, lb:92, bp:44, cost:5.99 }),
  F({ item:'ARK-S08B02', col:'Elegant Exotic', sp:'Brazilian Cherry (Jatoba)', clr:'Sable', name:'Brazilian Cherry (Jatoba) Sable', c:'S', thk:'3/4"', wl:null, w:'3-5/8"', len:"1'-6' RL Avg 2.3'", lwt:'RL(2121)*92*18', sf:25.50, lb:92, bp:44, cost:5.99 }),
  F({ item:'ARK-S10B01', col:'Elegant Exotic', sp:'Brazilian Teak (Cumaru)', clr:'Natural', name:'Brazilian Teak (Cumaru) Natural', c:'S', thk:'3/4"', wl:null, w:'3-5/8"', len:"1'-6' RL Avg 2.3'", lwt:'RL(2121)*93*18', sf:25.58, lb:95, bp:44, cost:6.49 }),
  F({ item:'ARK-S10B02', col:'Elegant Exotic', sp:'Brazilian Teak (Cumaru)', clr:'Red', name:'Brazilian Teak (Cumaru) Red', c:'S', thk:'3/4"', wl:null, w:'3-5/8"', len:"1'-6' RL Avg 2.3'", lwt:'RL(2121)*93*18', sf:25.58, lb:95, bp:44, cost:6.49 }),
  F({ item:'ARK-S07A03', col:'Elegant Exotic', sp:'Genuine Mahogany', clr:'Sable', name:'Genuine Mahogany Sable', c:'S', thk:'3/4"', wl:null, w:'4-3/4"', len:"1'-5' RL Avg 2.3'", lwt:'RL(2121)*123*18', sf:22.47, lb:60, bp:48, cost:4.89 }),
  F({ item:'ARK-S08A01', col:'Elegant Exotic', sp:'Brazilian Cherry (Jatoba)', clr:'Cherry Stain', name:'Brazilian Cherry (Jatoba) Cherry Stain', c:'S', thk:'3/4"', wl:null, w:'4-3/4"', len:"1'-6' RL Avg 2.3'", lwt:'RL(2121)*123*18', sf:22.56, lb:85, bp:48, cost:6.99 }),
  F({ item:'ARK-S08A01-N', col:'Elegant Exotic', sp:'Brazilian Cherry (Jatoba)', clr:'Natural', name:'Brazilian Cherry (Jatoba) Natural', c:'S', thk:'3/4"', wl:null, w:'4-3/4"', len:"1'-6' RL Avg 2.3'", lwt:'RL(2121)*123*18', sf:22.56, lb:85, bp:48, cost:6.99 }),
  F({ item:'ARK-S08A02', col:'Elegant Exotic', sp:'Brazilian Cherry (Jatoba)', clr:'Sable', name:'Brazilian Cherry (Jatoba) Sable', c:'S', thk:'3/4"', wl:null, w:'4-3/4"', len:"1'-6' RL Avg 2.3'", lwt:'RL(2121)*123*18', sf:22.56, lb:85, bp:48, cost:6.99 }),

  // ===== ARTISTIC — DISTRESSED ENGINEERED =====
  F({ item:'ARK-D02EB02A01', col:'Artistic', sp:'Birch', clr:'Natural', name:'Scraped Birch Natural', c:'E', thk:'1/2"', wl:'2.0mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12.7/2.0', sf:33.70, lb:60, bp:48, cost:2.99, tex:'Hand-Scraped' }),
  F({ item:'ARK-D02EC36K01', col:'Artistic', sp:'Hickory', clr:'Natural', name:'Scraped Hickory Natural', c:'E', thk:'3/8"', wl:'1.2mm', w:'6-1/2"', len:"1'-6' RL Avg 2.3'", lwt:'RL(1800)*165*9.5/1.2', sf:31.97, lb:44, bp:54, cost:3.19, tex:'Hand-Scraped' }),
  F({ item:'ARK-D02EC36K20', col:'Artistic', sp:'Hickory', clr:'Espresso', name:'Scraped Hickory Espresso', c:'E', thk:'3/8"', wl:'1.2mm', w:'6-1/2"', len:"1'-6' RL Avg 2.3'", lwt:'RL(1800)*165*9.5/1.2', sf:31.97, lb:44, bp:54, cost:2.99, tex:'Hand-Scraped' }),
  F({ item:'ARK-D02EC36K21', col:'Artistic', sp:'Hickory', clr:'Mocha', name:'Scraped Hickory Mocha', c:'E', thk:'3/8"', wl:'1.2mm', w:'6-1/2"', len:"1'-6' RL Avg 2.3'", lwt:'RL(1800)*165*9.5/1.2', sf:31.97, lb:44, bp:54, cost:2.99, tex:'Hand-Scraped' }),
  F({ item:'ARK-D02EC36K25', col:'Artistic', sp:'Hickory', clr:'Chestnut', name:'Scraped Hickory Chestnut', c:'E', thk:'3/8"', wl:'1.2mm', w:'6-1/2"', len:"1'-6' RL Avg 2.3'", lwt:'RL(1800)*165*9.5/1.2', sf:31.97, lb:44, bp:54, cost:2.99, tex:'Hand-Scraped' }),
  F({ item:'ARK-D02EC02K27', col:'Artistic', sp:'Birch', clr:'Grey', name:'Scraped Birch Grey', c:'E', thk:'3/8"', wl:'1.2mm', w:'6-1/2"', len:"1'-6' RL Avg 2.3'", lwt:'RL(1800)*165*9.5/1.2', sf:31.97, lb:44, bp:54, cost:2.99, tex:'Hand-Scraped' }),

  // ===== FRENCH — ENGINEERED =====
  F({ item:'ARK-D03EB02A05', col:'French', sp:'Birch', clr:'Butterscotch', name:'Birch Butterscotch', c:'E', thk:'1/2"', wl:'2.0mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12.7/2.0', sf:33.70, lb:60, bp:48, cost:2.99 }),
  F({ item:'ARK-D03EB02A06', col:'French', sp:'Birch', clr:'Kahlua', name:'Birch Kahlua', c:'E', thk:'1/2"', wl:'2.0mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12.7/2.0', sf:33.70, lb:60, bp:48, cost:2.99 }),
  F({ item:'ARK-D03EB02A13', col:'French', sp:'Birch', clr:'Brown Sugar', name:'Distressed Birch Brown Sugar', c:'E', thk:'1/2"', wl:'2.0mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12.7/2.0', sf:33.70, lb:60, bp:48, cost:2.99, tex:'Distressed' }),

  // ===== ESTATE KING RANCH — 4MM ENGINEERED =====
  F({ item:'ARK-EE01L10', col:'Estate King Ranch', sp:'Oak', clr:'Moonlight', name:'Oak Moonlight', c:'E', thk:'5/8"', wl:'4mm', w:'7-1/2"', len:"2'-6.3' RL Avg 4'", lwt:'RL(1900)*190*15.8/4.0', sf:23.32, lb:60, bp:40, cost:4.99 }),
  F({ item:'ARK-EE01L12', col:'Estate King Ranch', sp:'Oak', clr:'Shadow', name:'Oak Shadow', c:'E', thk:'5/8"', wl:'4mm', w:'7-1/2"', len:"2'-6.3' RL Avg 4'", lwt:'RL(1900)*190*15.8/4.0', sf:23.32, lb:60, bp:40, cost:4.99 }),
  F({ item:'ARK-EE01L13', col:'Estate King Ranch', sp:'Oak', clr:'Wheat', name:'Oak Wheat', c:'E', thk:'5/8"', wl:'4mm', w:'7-1/2"', len:"2'-6.3' RL Avg 4'", lwt:'RL(1900)*190*15.8/4.0', sf:23.32, lb:60, bp:40, cost:4.99 }),
  F({ item:'ARK-EE01L15', col:'Estate King Ranch', sp:'Oak', clr:'Tranquility', name:'Oak Tranquility', c:'E', thk:'5/8"', wl:'4mm', w:'7-1/2"', len:"2'-6.3' RL Avg 4'", lwt:'RL(1900)*190*15.8/4.0', sf:23.32, lb:60, bp:40, cost:4.99 }),
  F({ item:'ARK-EE01L11', col:'Estate King Ranch', sp:'Oak', clr:'Twilight', name:'Oak Twilight', c:'E', thk:'5/8"', wl:'4mm', w:'7-1/2"', len:"2'-6.3' RL Avg 4'", lwt:'RL(1900)*190*15.8/4.0', sf:23.32, lb:60, bp:40, cost:3.49, st:'closeout' }),
  F({ item:'ARK-EE01L14', col:'Estate King Ranch', sp:'Oak', clr:'Eclipse', name:'Oak Eclipse', c:'E', thk:'5/8"', wl:'4mm', w:'7-1/2"', len:"2'-6.3' RL Avg 4'", lwt:'RL(1900)*190*15.8/4.0', sf:23.32, lb:60, bp:40, cost:3.49, st:'closeout' }),

  // ===== LUXURY EXOTIC — 3MM ENGINEERED (close-out) =====
  F({ item:'ARK-EA07L08', col:'Luxury Exotic', sp:'Genuine Mahogany', clr:'Taupe', name:'Genuine Mahogany Taupe', c:'E', thk:'9/16"', wl:'3.0mm', w:'7-1/2"', len:"1'-6' RL Avg 4'", lwt:'RL(1900)*190*14/3.0', sf:23.19, lb:60, bp:50, cost:2.49, st:'closeout' }),

  // ===== ESTATE — 3MM ENGINEERED (close-out) =====
  F({ item:'ARK-EH01A05', col:'Estate', sp:'Oak', clr:'Smoke', name:'Oak Smoke', c:'E', thk:'1/2"', wl:'3.0mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12.7/3.0', sf:33.70, lb:62, bp:40, cost:1.99, st:'closeout' }),
  F({ item:'ARK-EH01A03', col:'Estate', sp:'Oak', clr:'Brushed Linen', name:'Oak Brushed Linen', c:'E', thk:'1/2"', wl:'3.0mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12.7/3.0', sf:33.70, lb:62, bp:40, cost:2.29, st:'closeout' }),
  F({ item:'ARK-EH01A04', col:'Estate', sp:'Oak', clr:'Saddle', name:'Oak Saddle', c:'E', thk:'1/2"', wl:'3.0mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12.7/3.0', sf:33.70, lb:62, bp:40, cost:2.29, st:'closeout' }),
  F({ item:'ARK-EH01A07', col:'Estate', sp:'Oak', clr:'Dark Grey', name:'Oak Dark Grey', c:'E', thk:'1/2"', wl:'3.0mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12.7/3.0', sf:33.70, lb:62, bp:40, cost:2.29, st:'closeout' }),
  F({ item:'ARK-EH01A21', col:'Estate', sp:'Oak', clr:'Bellini', name:'Oak Bellini', c:'E', thk:'1/2"', wl:'3.0mm', w:'4-3/4"', len:"1'-4' RL Avg 2.3'", lwt:'RL(2121)*123*12.7/3.0', sf:33.70, lb:62, bp:40, cost:2.29, st:'closeout' }),

  // ===== ESTATE VILLA SERIES — 3MM ENGINEERED (close-out) =====
  F({ item:'ARK-EH01L05', col:'Estate Villa', sp:'Oak', clr:'Ecru', name:'Oak Ecru', c:'E', thk:'1/2"', wl:'3.0mm', w:'7-1/2"', len:"1'-6.3' RL Avg 2.5'", lwt:'RL(1900)*190*12/3.0', sf:31.09, lb:60, bp:45, cost:2.99, st:'closeout' }),
  F({ item:'ARK-EH01L14', col:'Estate Villa', sp:'Oak', clr:'Pearl', name:'Oak Pearl', c:'E', thk:'1/2"', wl:'3.0mm', w:'7-1/2"', len:"1'-6.3' RL Avg 2.5'", lwt:'RL(1900)*190*12/3.0', sf:31.09, lb:60, bp:45, cost:2.99, st:'closeout' }),

  // ===== DISCONTINUED (final sale) =====
  F({ item:'ARK-EB16A01', col:'Discontinued', sp:'Walnut', clr:'Caribbean', name:'Caribbean Walnut', c:'E', thk:'1/2"', wl:'3.0mm', w:'4-3/4"', len:null, lwt:null, sf:32.9, lb:null, bp:null, cost:1.50, st:'disc' }),
  F({ item:'ARK-EK02A04', col:'Discontinued', sp:'Birch', clr:'Toffee', name:'Birch Toffee', c:'E', thk:'3/8"', wl:'1.2mm', w:'4-3/4"', len:null, lwt:null, sf:39.4, lb:null, bp:null, cost:1.50, st:'disc' }),
  F({ item:'ARK-D03EB02A09', col:'Discontinued', sp:'Birch', clr:'Shade', name:'Birch Shade', c:'E', thk:'1/2"', wl:'3.0mm', w:'4-3/4"', len:null, lwt:null, sf:33.7, lb:null, bp:null, cost:1.50, st:'disc' }),
  F({ item:'ARK-EH01I03-L', col:'Discontinued', sp:'Oak', clr:'Noir', name:'Oak Noir', c:'E', thk:'1/2"', wl:'3.0mm', w:'6-1/2"', len:null, lwt:null, sf:25.58, lb:null, bp:null, cost:1.50, st:'disc' }),
  F({ item:'ARK-EH01I12-L', col:'Discontinued', sp:'Oak', clr:'Dune', name:'Oak Dune', c:'E', thk:'1/2"', wl:'3.0mm', w:'6-1/2"', len:null, lwt:null, sf:25.58, lb:null, bp:null, cost:1.50, st:'disc' }),
  F({ item:'ARK-EK19E05', col:'Discontinued', sp:'Ipe', clr:'Black', name:'Ipe Black', c:'E', thk:'3/8"', wl:'0.6mm', w:'5"', len:null, lwt:null, sf:40, lb:null, bp:null, cost:1.50, st:'disc' }),
];

// ---- Molding sets (wholesale sheet) -----------------------------------------
// Custom prefinished, color-matched, 96" sticks, sold per piece; cost per piece.
const MOLDING_SETS = {
  A: {
    key: 'A', name: 'Oak & Maple', base_wood: 'Solid Oak / Solid Maple',
    matches: 'Oak, Birch, Hickory & Acacia floors',
    species: ['Oak', 'Birch', 'Hickory', 'Acacia'],
    pieces: [
      { type: 'Quarter Round',    code: 'QR', width: '3/4"', cost: 35.00, per_box: 25 },
      { type: 'Flush Reducer',    code: 'RD', width: '2"',   cost: 64.00, per_box: 15 },
      { type: 'T-Molding',        code: 'TM', width: '2"',   cost: 64.00, per_box: 15 },
      { type: 'End Cap',          code: 'EC', width: '2"',   cost: 64.00, per_box: 15 },
      { type: 'Flush Stair Nose', code: 'SN', width: '3.5"', cost: 88.00, per_box: 6 },
    ],
  },
  B: {
    key: 'B', name: 'Brazilian Cherry', base_wood: 'Solid Brazilian Cherry',
    matches: 'Brazilian Cherry, Brazilian Teak, Walnut & other exotic species floors',
    species: ['Genuine Mahogany', 'Santos Mahogany', 'Tigerwood', 'Brazilian Cherry (Jatoba)', 'Brazilian Teak (Cumaru)', 'Kuku Cigar', 'Walnut', 'Ipe'],
    pieces: [
      { type: 'Quarter Round',    code: 'QR', width: '3/4"', cost: 35.00,  per_box: 25 },
      { type: 'Flush Reducer',    code: 'RD', width: '2"',   cost: 72.00,  per_box: 15 },
      { type: 'T-Molding',        code: 'TM', width: '2"',   cost: 72.00,  per_box: 15 },
      { type: 'End Cap',          code: 'EC', width: '2"',   cost: 72.00,  per_box: 15 },
      { type: 'Flush Stair Nose', code: 'SN', width: '3.5"', cost: 120.00, per_box: 6 },
    ],
  },
};
const SPECIES_TO_SET = {};
for (const set of Object.values(MOLDING_SETS)) for (const sp of set.species) SPECIES_TO_SET[sp] = set.key;

// ---- Build products ---------------------------------------------------------
const CONSTRUCTION = { E: 'Engineered', S: 'Solid' };
const CATEGORY = { E: 'engineered-hardwood', S: 'solid-hardwood' };

function variantName(r) {
  if (r.c === 'S') return r.w;                                  // solids differ by width
  return r.wl ? `${r.w} · ${r.wl} wear layer` : r.w;            // engineered by width + wear layer
}
function sizeAttr(r) {
  const core = `${r.thk} x ${r.w}`;
  return r.c === 'E' && r.wl ? `${core} (${r.wl} wear layer)` : `${core} solid`;
}

const productMap = new Map();
for (const r of ROWS) {
  const key = `${r.c}|${r.col}|${r.sp}|${r.clr}`;
  if (!productMap.has(key)) {
    const isSolid = r.c === 'S';
    productMap.set(key, {
      collection: r.col,
      construction: CONSTRUCTION[r.c],
      category: CATEGORY[r.c],
      name: isSolid ? `${r.name} (Solid)` : r.name,
      species: r.sp,
      color: r.clr,
      material: isSolid ? 'Solid Hardwood' : 'Engineered Hardwood',
      surface_texture: r.tex || null,
      status: r.st === 'disc' ? 'draft' : 'active',
      closeout: r.st === 'closeout',
      discontinued: r.st === 'disc',
      molding_set: SPECIES_TO_SET[r.sp] || null,
      skus: [],
    });
  }
  const p = productMap.get(key);
  if (r.tex && !p.surface_texture) p.surface_texture = r.tex;
  p.skus.push({
    vendor_sku: r.item,
    internal_sku: `ARK-${r.item.replace(/^ARK-/, '')}`,
    variant_name: variantName(r),
    size: sizeAttr(r),
    cost: r.cost,
    sqft_box: r.sf,
    lbs_box: r.lb,
    box_per_pallet: r.bp,
    thickness: r.thk,
    wear_layer: r.wl,
    width: r.w,
    length: r.len,
    lwt_mm: r.lwt,
    status: r.st === 'disc' ? 'draft' : 'active',
    closeout: r.st === 'closeout',
  });
}

// Sort SKUs within a product by width so variant pills read small→large.
const widthNum = (w) => {
  const m = String(w).match(/(\d+)(?:-(\d+)\/(\d+))?/);
  if (!m) return 0;
  return parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) / parseInt(m[3], 10) : 0);
};
const products = [...productMap.values()];
for (const p of products) p.skus.sort((a, b) => widthNum(a.width) - widthNum(b.width));

// Format siblings: link the Engineered and Solid product of the same species+color
// so the storefront shows a "Style: Engineered / Solid" variant pill
// (products.format_group shared, format_label = the construction). Only set when
// BOTH constructions exist for that color (otherwise no pill).
const slugify = (s) => s.toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const byColor = new Map();
for (const p of products) {
  const k = `${p.species}||${p.color}`;
  (byColor.get(k) || byColor.set(k, []).get(k)).push(p);
}
let fmtPairs = 0;
for (const [k, ps] of byColor) {
  if (new Set(ps.map((p) => p.construction)).size < 2) continue;
  const [species, color] = k.split('||');
  const fg = `ARK-${slugify(species)}-${slugify(color)}`;
  for (const p of ps) { p.format_group = fg; p.format_label = p.construction; }
  fmtPairs++;
}

const catalog = {
  vendor: {
    name: 'ARK Floors',
    code: 'ARK',
    website: 'https://www.ark-floors.com',
    email: 'orders@ark-floors.com',
    phone: '800-918-6188',
    address: '11119 Rush Street, S. El Monte, CA 91733',
    notes: "Wholesale distributor/manufacturer of exotic + oak engineered and solid hardwood (member, NWFA). Q2-2026 Preferred Price List + 2026 Engineered Oak Close-Out sheet. Preferred cost = Roma COST; retail = cost x1.6 nickel keystone. Custom color-matched transition moldings priced by base wood (Oak/Maple vs Brazilian Cherry), attached per species as accessories. Close-out & Discontinued collections are FINAL SALE, no returns/exchange; Discontinued imported as draft.",
  },
  molding_sets: MOLDING_SETS,
  products,
};

fs.writeFileSync(OUT, JSON.stringify(catalog, null, 2));
const nSku = products.reduce((a, p) => a + p.skus.length, 0);
console.log(`Wrote ${OUT}`);
console.log(`  ${products.length} products, ${nSku} floor SKUs`);
console.log(`  engineered: ${products.filter((p) => p.construction === 'Engineered').length}, solid: ${products.filter((p) => p.construction === 'Solid').length}`);
console.log(`  active: ${products.filter((p) => p.status === 'active').length}, draft(disc): ${products.filter((p) => p.status === 'draft').length}, closeout: ${products.filter((p) => p.closeout).length}`);
console.log(`  format sibling pairs (Engineered↔Solid): ${fmtPairs}`);
console.log(`  molding sets: A(${MOLDING_SETS.A.pieces.length}) B(${MOLDING_SETS.B.pieces.length})`);
