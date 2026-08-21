-- Quote internal notes: reuse the customer_notes table (same as order notes)
-- by adding a quote_id foreign key alongside the existing order_id.
-- Powers the multi-entry Internal Notes widget on the rep quote workspace,
-- mirroring the order-detail notes widget.

ALTER TABLE customer_notes
  ADD COLUMN IF NOT EXISTS quote_id uuid REFERENCES quotes(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_customer_notes_quote ON customer_notes(quote_id);

-- Backfill: carry each quote's existing single free-text notes field into the
-- new multi-entry widget so nothing disappears. Idempotent (skips quotes that
-- already have a quote-scoped note). Authored to the quote's sales rep.
INSERT INTO customer_notes (customer_type, customer_ref, quote_id, staff_id, note, created_at)
SELECT
  CASE WHEN q.trade_customer_id IS NOT NULL THEN 'trade'
       WHEN q.customer_id IS NOT NULL THEN 'retail'
       ELSE 'guest' END,
  COALESCE(q.trade_customer_id::text, q.customer_id::text, q.customer_email, q.id::text),
  q.id, q.sales_rep_id, left(trim(q.notes), 4000), q.created_at
FROM quotes q
WHERE q.notes IS NOT NULL AND trim(q.notes) <> ''
  AND NOT EXISTS (SELECT 1 FROM customer_notes cn WHERE cn.quote_id = q.id);
