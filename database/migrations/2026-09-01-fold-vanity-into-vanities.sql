-- Fold the duplicate "Vanity" category (HR / Hardware Resources vanities, filed
-- under Hardware & Specialty) into the canonical "Vanities" category under Bath,
-- where JMV (James Martin) vanities already live. Ends up with ONE vanity
-- category, nested under Bath.
--
-- Idempotent + slug-based (prod category UUIDs differ from local): safe to run
-- more than once; a no-op if the 'vanity' category is already gone.
--
-- Paired with:
--   * backend/scripts/import-rom440.cjs — HR vanities now target slug 'vanities'
--   * backend/server.js browseGroupKey  — HR finish-collapse keys on 'vanities'

BEGIN;

DO $$
DECLARE
  v_vanity   uuid;  -- old duplicate (slug 'vanity')
  v_vanities uuid;  -- canonical target under Bath (slug 'vanities')
  n_children int;
BEGIN
  SELECT id INTO v_vanity   FROM categories WHERE slug = 'vanity';
  SELECT id INTO v_vanities FROM categories WHERE slug = 'vanities';

  IF v_vanity IS NULL THEN
    RAISE NOTICE 'No "vanity" category — already folded, nothing to do.';
    RETURN;
  END IF;

  IF v_vanities IS NULL THEN
    RAISE EXCEPTION 'Canonical "vanities" category not found; aborting.';
  END IF;

  -- Reassign every product off the old category.
  UPDATE products
     SET category_id = v_vanities, updated_at = CURRENT_TIMESTAMP
   WHERE category_id = v_vanity;

  -- Refuse to drop the old category if anything still points at it.
  SELECT count(*) INTO n_children FROM categories WHERE parent_id = v_vanity;
  IF n_children > 0 THEN
    RAISE EXCEPTION 'Old "vanity" category still has % child categories; aborting.', n_children;
  END IF;

  DELETE FROM categories WHERE id = v_vanity;

  RAISE NOTICE 'Folded "vanity" (%) into "vanities" (%).', v_vanity, v_vanities;
END $$;

COMMIT;
