\set ON_ERROR_STOP on
BEGIN;

-- 1. Rep-portal manager gating flag on the unified identity table.
ALTER TABLE staff_accounts ADD COLUMN IF NOT EXISTS is_manager BOOLEAN DEFAULT false;

-- 2. Copy the sales_reps into staff_accounts, PRESERVING id so every existing FK
--    value stays valid. Reps become role='sales_rep'; is_manager carried over.
INSERT INTO staff_accounts
  (id, email, password_hash, password_salt, first_name, last_name, phone,
   role, is_active, is_manager, last_login_at, created_at, updated_at)
SELECT id, email, password_hash, password_salt, first_name, last_name, phone,
   'sales_rep', is_active, is_manager, NULL, created_at, NOW()
FROM sales_reps;

-- 3. Repoint the 11 existing FK constraints from sales_reps -> staff_accounts,
--    preserving each ON DELETE behavior (CASCADE on rep_sessions/rep_notifications).
ALTER TABLE cash_drawers            DROP CONSTRAINT cash_drawers_rep_id_fkey,            ADD CONSTRAINT cash_drawers_rep_id_fkey            FOREIGN KEY (rep_id)          REFERENCES staff_accounts(id);
ALTER TABLE customers               DROP CONSTRAINT customers_assigned_rep_id_fkey,      ADD CONSTRAINT customers_assigned_rep_id_fkey      FOREIGN KEY (assigned_rep_id) REFERENCES staff_accounts(id);
ALTER TABLE deals                   DROP CONSTRAINT deals_rep_id_fkey,                   ADD CONSTRAINT deals_rep_id_fkey                   FOREIGN KEY (rep_id)          REFERENCES staff_accounts(id);
ALTER TABLE estimates               DROP CONSTRAINT estimates_sales_rep_id_fkey,         ADD CONSTRAINT estimates_sales_rep_id_fkey         FOREIGN KEY (sales_rep_id)    REFERENCES staff_accounts(id);
ALTER TABLE order_price_adjustments DROP CONSTRAINT order_price_adjustments_rep_id_fkey, ADD CONSTRAINT order_price_adjustments_rep_id_fkey FOREIGN KEY (rep_id)          REFERENCES staff_accounts(id);
ALTER TABLE rep_commissions         DROP CONSTRAINT rep_commissions_rep_id_fkey,         ADD CONSTRAINT rep_commissions_rep_id_fkey         FOREIGN KEY (rep_id)          REFERENCES staff_accounts(id);
ALTER TABLE rep_notifications       DROP CONSTRAINT rep_notifications_rep_id_fkey,       ADD CONSTRAINT rep_notifications_rep_id_fkey       FOREIGN KEY (rep_id)          REFERENCES staff_accounts(id) ON DELETE CASCADE;
ALTER TABLE rep_sessions            DROP CONSTRAINT rep_sessions_rep_id_fkey,            ADD CONSTRAINT rep_sessions_rep_id_fkey            FOREIGN KEY (rep_id)          REFERENCES staff_accounts(id) ON DELETE CASCADE;
ALTER TABLE rep_tasks               DROP CONSTRAINT rep_tasks_rep_id_fkey,               ADD CONSTRAINT rep_tasks_rep_id_fkey               FOREIGN KEY (rep_id)          REFERENCES staff_accounts(id);
ALTER TABLE sample_requests         DROP CONSTRAINT sample_requests_rep_id_fkey,         ADD CONSTRAINT sample_requests_rep_id_fkey         FOREIGN KEY (rep_id)          REFERENCES staff_accounts(id);
ALTER TABLE showroom_visits         DROP CONSTRAINT showroom_visits_rep_id_fkey,         ADD CONSTRAINT showroom_visits_rep_id_fkey         FOREIGN KEY (rep_id)          REFERENCES staff_accounts(id);

-- 4. orders/quotes had the column but no live FK (schema drift) — add proper FKs now.
ALTER TABLE orders ADD CONSTRAINT orders_sales_rep_id_fkey FOREIGN KEY (sales_rep_id) REFERENCES staff_accounts(id);
ALTER TABLE quotes ADD CONSTRAINT quotes_sales_rep_id_fkey FOREIGN KEY (sales_rep_id) REFERENCES staff_accounts(id);

-- 5. Legacy identity table no longer referenced.
DROP TABLE sales_reps;

COMMIT;
