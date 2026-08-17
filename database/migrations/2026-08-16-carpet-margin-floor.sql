-- Carpet retail margin floor: carpet is priced per square yard (cut_price for
-- single cuts, roll_price for bulk). Enforce at least $1 profit per square foot,
-- i.e. price/sqyd >= cost/sqyd + $9 (9 sqft per sqyd). Only touches carpet rows
-- that already have a real price AND a real cost — never invents a price on a
-- $0 (unpriced) or unknown-cost row. Nickel-rounded up so it never sits under
-- the floor. Going-forward enforcement lives in upsertPricing() (base.js).
-- See [[carpet-margin-floor]].

UPDATE pricing SET
  cut_price = ROUND(CEIL((COALESCE(cut_cost, cost) + 9) / 0.05) * 0.05, 2)
WHERE price_basis = 'per_sqyd'
  AND cut_price > 0 AND COALESCE(cut_cost, cost) > 0
  AND cut_price < COALESCE(cut_cost, cost) + 9;

UPDATE pricing SET
  roll_price = ROUND(CEIL((COALESCE(roll_cost, cost) + 9) / 0.05) * 0.05, 2)
WHERE price_basis = 'per_sqyd'
  AND roll_price > 0 AND COALESCE(roll_cost, cost) > 0
  AND roll_price < COALESCE(roll_cost, cost) + 9;
