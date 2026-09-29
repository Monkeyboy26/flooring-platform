import { createRequire } from 'module';

const __require = createRequire(import.meta.url);
export const CA_TAX_RATES = __require('../data/ca-tax-rates.json');
export const NY_TAX_RATES = __require('../data/ny-tax-rates.json');

// States where Roma is registered to collect sales tax. Each destination ZIP is
// routed to the state whose 3-digit-prefix table it falls in; a ZIP outside every
// registered state gets 0 tax (no nexus → don't collect). Rates are the combined
// state+local rate for the destination (both CA and NY are destination-based).
// `fallback` covers a destination prefix not yet enumerated in that state's table.
const TAX_JURISDICTIONS = [
  { name: 'CA', table: CA_TAX_RATES, fallback: 0.0725, match: (p, n) => n >= 900 && n <= 966 },
  // NY prefixes span 100–149 (plus 005 Holtsville). Fallback = 4% state + 0.375%
  // MCTD; enumerate localities in ny-tax-rates.json for the correct combined rate.
  { name: 'NY', table: NY_TAX_RATES, fallback: 0.04375, match: (p, n) => p === '005' || (n >= 100 && n <= 149) },
];

export function calculateSalesTax(subtotal, shippingZip, isTaxExempt) {
  if (isTaxExempt) return { rate: 0, amount: 0 };
  const zip = String(shippingZip || '').trim();
  if (zip.length < 3) return { rate: 0, amount: 0 };
  const prefix = zip.substring(0, 3);
  const n = parseInt(prefix, 10);
  const jur = TAX_JURISDICTIONS.find(j => j.match(prefix, n));
  if (!jur) return { rate: 0, amount: 0 }; // destination outside every registered state
  const rate = jur.table[prefix] != null ? jur.table[prefix] : jur.fallback;
  const amount = parseFloat((subtotal * rate).toFixed(2));
  return { rate, amount };
}

// Backend-authoritative resale exemption check. Given a trade customer id or
// email, returns true only if that APPROVED trade account is flagged tax_exempt
// (set by a rep/admin after verifying the resale certificate). Never trust a
// client-supplied exemption flag — always resolve it here. `db` is a pool or
// transaction client.
export async function isTradeTaxExempt(db, { id, email } = {}) {
  if (!id && !email) return false;
  const clause = id ? 'id = $1' : 'LOWER(email) = LOWER($1)';
  const r = await db.query(
    `SELECT tax_exempt FROM trade_customers WHERE ${clause} AND status = 'approved' LIMIT 1`,
    [id || email]
  );
  return r.rows.length ? !!r.rows[0].tax_exempt : false;
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
