import { createRequire } from 'module';

const __require = createRequire(import.meta.url);
const CA_TAX_RATES = __require('../data/ca-tax-rates.json');

export function calculateSalesTax(subtotal, shippingZip, isTaxExempt) {
  if (isTaxExempt) return { rate: 0, amount: 0 };
  if (!shippingZip || !shippingZip.startsWith('9')) return { rate: 0, amount: 0 };
  const prefix = shippingZip.substring(0, 3);
  const rate = CA_TAX_RATES[prefix] || 0.0725;
  const amount = parseFloat((subtotal * rate).toFixed(2));
  return { rate, amount };
}

export function getNextBusinessDay() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1); // Sun → Mon
  if (d.getDay() === 6) d.setDate(d.getDate() + 2); // Sat → Mon
  return d.toISOString().split('T')[0];
}

// Pickup-only detection: slabs and prefab countertops cannot be shipped
export function isPickupOnly(item) {
  if (item.variant_type === 'slab') return true;
  const vsku = (item.vendor_sku || '').toUpperCase();
  if (['RSL', 'VSL', 'CSL', 'PSL'].some(p => vsku.startsWith(p))) return true;
  const slug = (item.category_slug || '').toLowerCase();
  if (slug === 'prefab-countertops' || slug === 'countertops') return true;
  return false;
}
