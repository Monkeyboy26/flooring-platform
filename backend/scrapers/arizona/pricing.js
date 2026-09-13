import { UNIT_CATEGORIES } from './categorize.js';

export function resolveSellBy(pimSlug, accessory, parsedSoldBy) {
  if (accessory) return 'unit';
  if (pimSlug && UNIT_CATEGORIES.has(pimSlug)) return 'unit';
  return parsedSoldBy || 'box';
}

// Collections sold by the FULL BOX only (owner rule), even where the AZ list
// prices the individual patterns per piece (EA). Their EA rows convert to
// box/per_sqft via Sf/Pc so they sell like field tile.
export const BOX_ONLY_SERIES = /cementine|flash bars|spark bars/i;

// Derive sell_by + cost + price_basis from a price-list entry.
// Mosaics, ledger/stack panels, and trim are sold per sheet/piece — always,
// even when they ship in boxes (business rule: customers can buy single
// sheets). SF-priced entries in per-piece categories convert to a per-sheet
// price via Sf/Pc so unit pricing is never left on a per-sqft basis; slabs
// (no piece coverage) keep per-sqft pricing for the inquire flow.
export function planFromPriceList(plEntry, catSlug) {
  // BX rows carry the whole-box net price — convert to per-sqft or the box
  // would be costed ~12x (Cementine B&W Mix: $109.70/box → $9.44/sf).
  if (plEntry.unit === 'BX' && plEntry.sfPerBox > 0) {
    return {
      sellBy: 'box',
      cost: Math.round(plEntry.netPrice / plEntry.sfPerBox * 100) / 100,
      priceBasis: 'per_sqft',
    };
  }
  const perPiece = plEntry.unit === 'EA' || plEntry.unit === 'SHT';
  if (perPiece) {
    if (BOX_ONLY_SERIES.test(plEntry.series || plEntry.itemId || '') && plEntry.sfPerPc > 0) {
      return {
        sellBy: 'box',
        cost: Math.round(plEntry.netPrice / plEntry.sfPerPc * 100) / 100,
        priceBasis: 'per_sqft',
      };
    }
    return { sellBy: 'unit', cost: plEntry.netPrice, priceBasis: 'per_unit' };
  }
  if (catSlug && UNIT_CATEGORIES.has(catSlug)) {
    // Loose-piece guard (owner, 2026-09-05; ceiling dropped 2026-09-13 — same
    // rule as MSI _looseSmallPiece): AZ's own list marks mesh sheets SHT and
    // loose tiles SF with box packs. An SF row whose piece sits inside a real
    // multi-piece box (Paloma 4x8 hex @ 36/box, Icon Hex 20x24 @ 4/box,
    // Shibusa Hex 9x11, Jade 8in hex…) is loose field tile that only LANDED
    // in a per-piece category — sell it per box at the SF rate, don't
    // per-piece it. The old <0.5 sqft ceiling let Icon (2.53 sf/pc), Paros
    // 14x16 (1.12) and Shibusa (0.52) through as fabricated $8–20 "sheets";
    // the 2026-09 list has zero SF+box rows that are true sheets.
    const loosePiece = plEntry.sfPerPc > 0
      && plEntry.pcsPerBox > 1 && plEntry.sfPerBox > plEntry.sfPerPc;
    if (plEntry.sfPerPc > 0 && !loosePiece) {
      return {
        sellBy: 'unit',
        cost: Math.round(plEntry.netPrice * plEntry.sfPerPc * 100) / 100,
        priceBasis: 'per_unit',
      };
    }
    if (loosePiece) {
      return { sellBy: 'box', cost: plEntry.netPrice, priceBasis: 'per_sqft' };
    }
    return { sellBy: 'unit', cost: plEntry.netPrice, priceBasis: 'per_sqft' };
  }
  return { sellBy: 'box', cost: plEntry.netPrice, priceBasis: 'per_sqft' };
}
