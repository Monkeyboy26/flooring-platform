// Custom bound area rug pricing — shared, server-authoritative.
//
// A rug is cut from a broadloom roll of a fixed width (roll_width_ft, standard
// 12'). The customer's finished rug W×L is placed on the roll so the LONGER side
// runs across the roll width when it fits; otherwise the long side runs down the
// roll length ("one side can exceed the roll length"). You always buy the full
// roll width for the cut, so the material charged is the full cut rectangle
// (roll width × linear feet cut) including waste — see [[custom-rug-calculator]].
//
// Carpet is priced per SQUARE YARD (pricing.cut_price = $/sqyd), so cut area in
// sqft is divided by 9 before multiplying. Binding is charged per linear foot
// around the FINISHED rug perimeter, plus a flat per-rug fabrication fee.
//
// The frontend (storefront.jsx computeRugQuote) mirrors this formula for a live
// preview, but the cart endpoint recomputes here so the price is authoritative.

export const BINDING_PER_FT = 6;      // $ per linear foot of edge binding
export const RUG_SETUP_FEE = 50;      // flat $ per rug (fabrication/setup)
export const DEFAULT_ROLL_WIDTH_FT = 12;

// Internal COST basis (commission margin only — never shown to customers). The
// binding charge is $6/ft revenue but costs $2.50/ft to produce; fabrication is
// a $50 charge that costs $25. Material cost comes from the carpet's own
// pricing.cost ($/sqyd) — see recalculateCommission + [[custom-rug-calculator]].
export const BINDING_COST_PER_FT = 2.5;
export const FABRICATION_COST = 25;

export function computeRugQuote({ widthFt, lengthFt, rollWidthFt, cutPricePerSqyd }) {
  const w = Number(widthFt) || 0;
  const l = Number(lengthFt) || 0;
  const roll = Number(rollWidthFt) > 0 ? Number(rollWidthFt) : DEFAULT_ROLL_WIDTH_FT;
  const price = Number(cutPricePerSqyd) || 0;
  if (w <= 0 || l <= 0) return { valid: false, oversized: false, rollWidthFt: roll };

  const a = Math.max(w, l), b = Math.min(w, l);
  let linearFeet;
  if (a <= roll) linearFeet = b;         // long side across the roll width
  else if (b <= roll) linearFeet = a;    // long side runs down the roll length
  else return { valid: false, oversized: true, rollWidthFt: roll }; // needs seaming

  const cutAreaSqft = roll * linearFeet;
  const material = (cutAreaSqft / 9) * price;
  const perimeterFt = 2 * (w + l);
  const binding = perimeterFt * BINDING_PER_FT;
  const setup = RUG_SETUP_FEE;
  const perRug = material + binding + setup;
  return {
    valid: true, oversized: false, rollWidthFt: roll,
    linearFeet, cutAreaSqft, perimeterFt,
    material: round2(material), binding: round2(binding), setup,
    perRug: round2(perRug),
  };
}

// Internal per-rug COST (material + binding + fabrication), for commission margin.
// materialCostPerSqyd is the carpet's pricing.cost. Reuses computeRugQuote's
// geometry (cut area + perimeter) so cost tracks the same cut as the price.
export function computeRugCost({ widthFt, lengthFt, rollWidthFt, materialCostPerSqyd }) {
  const q = computeRugQuote({ widthFt, lengthFt, rollWidthFt, cutPricePerSqyd: 0 });
  if (!q.valid) return { valid: false, oversized: q.oversized };
  const materialCost = round2((q.cutAreaSqft / 9) * (Number(materialCostPerSqyd) || 0));
  const bindingCost = round2(q.perimeterFt * BINDING_COST_PER_FT);
  const fabricationCost = FABRICATION_COST;
  return {
    valid: true, materialCost, bindingCost, fabricationCost,
    totalCost: round2(materialCost + bindingCost + fabricationCost),
  };
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// "9' × 4'", "9'6\" × 4'" — feet with rounded inches, used in line-item labels.
function fmtFeet(ft) {
  const n = Number(ft) || 0;
  const whole = Math.floor(n);
  let inches = Math.round((n - whole) * 12);
  if (inches === 12) return `${whole + 1}'`;
  return inches === 0 ? `${whole}'` : `${whole}'${inches}"`;
}
export function formatRugDims(w, l) { return `${fmtFeet(w)} × ${fmtFeet(l)}`; }
