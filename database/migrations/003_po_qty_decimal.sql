-- Carpet is ordered by the SQUARE YARD (EDI 850 unit "SY"), but purchase_order_items.qty
-- was an INTEGER and carpet lines stored the placeholder num_boxes = 1 while the real
-- yardage lived only in subtotal (= cost/sqyd × sqyd). That made qty×cost ≠ subtotal and
-- transmitted "1 SY" to vendors. Widen qty to allow fractional square yards, then backfill
-- the placeholder carpet rows to the real sqyd (recoverable as subtotal ÷ cost).
BEGIN;

ALTER TABLE purchase_order_items ALTER COLUMN qty TYPE NUMERIC(10,2);

-- Recover the true square-yard quantity for carpet placeholder rows. Rep-edited rows
-- (qty already > 1) and rows with no cost are left untouched.
UPDATE purchase_order_items
SET qty = ROUND(subtotal / cost, 2)
WHERE sell_by = 'roll'
  AND cost > 0
  AND qty <= 1;

COMMIT;
