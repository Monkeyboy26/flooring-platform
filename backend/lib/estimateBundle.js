// Shared estimate serializer: one source of truth for the rep workspace, PDF,
// email, and the public customer page. Loads the estimate (by id or public
// token), its areas, and enriched items, then groups items per area with
// computed subtotals. Per-area subtotals are always computed here, never
// stored — estimates.materials_subtotal/labor_subtotal stay the only stored
// rollups (see recalculateEstimateTotals in server.js).

export const LABOR_CATEGORY_LABELS = {
  installation: 'Installation', tearout: 'Tearout', underlayment: 'Underlayment',
  transitions: 'Transitions', baseboards: 'Baseboards', floor_leveling: 'Floor Leveling',
  moisture_barrier: 'Moisture Barrier', furniture_moving: 'Furniture Moving', other: 'Other'
};

// Categories billed per linear foot rather than per square foot.
export const LINEAR_LABOR_CATS = { baseboards: true };
export const laborUnitShort = (cat) => LINEAR_LABOR_CATS[cat] ? 'lin ft' : 'sqft';

// "Other" carries a free-text name (stored in product_name); every other
// category shows its fixed label.
export const laborDisplayName = (item) => (item.labor_category === 'other' && item.product_name)
  ? item.product_name
  : (LABOR_CATEGORY_LABELS[item.labor_category] || item.labor_category || 'Labor');

// status stays 'sent' in the DB when the clock runs out; expiry is a computed
// view so accepting after a re-send (which refreshes expires_at) needs no
// "unexpire" transition.
export function effectiveStatus(estimate) {
  if (estimate.status === 'sent' && estimate.expires_at && new Date(estimate.expires_at) < new Date()) {
    return 'expired';
  }
  return estimate.status;
}

// Optional deposit the customer can pay online at accept time. deposit_type is
// 'none' | 'percent' (deposit_value = % of total) | 'fixed' (dollar amount).
// Returns a rounded dollar figure, floored at 0 and capped at the total; 0 when
// no deposit is configured. Always derived, never stored.
export function depositAmount(estimate) {
  const total = parseFloat(estimate.total || 0);
  const val = parseFloat(estimate.deposit_value || 0);
  if (!total || val <= 0 || !estimate.deposit_type || estimate.deposit_type === 'none') return 0;
  const raw = estimate.deposit_type === 'percent' ? total * (val / 100) : val;
  return parseFloat(Math.min(Math.max(raw, 0), total).toFixed(2));
}

// Compute a draw/payment schedule's display state. Each milestone's amount is
// percent×total (or its fixed `amount` when no percent). Paid-status is DERIVED
// by walking the schedule in order against cumulative amountPaid: fully-covered
// milestones are 'paid', the first not-yet-covered is 'due' (the next to
// collect), the rest 'upcoming'. Returns milestones enriched with
// { amount, paid_applied, remaining, status }.
export function computeSchedule(milestones, total, amountPaid = 0) {
  const t = parseFloat(total || 0);
  let pool = parseFloat(amountPaid || 0);
  let dueAssigned = false;
  return (milestones || []).map(m => {
    const hasPct = m.percent != null && m.percent !== '';
    const amount = parseFloat((hasPct ? (parseFloat(m.percent || 0) / 100) * t : parseFloat(m.amount || 0)).toFixed(2));
    const applied = Math.max(0, Math.min(amount, pool));
    pool = Math.max(0, pool - amount);
    let status;
    if (amount > 0 && applied >= amount - 0.005) status = 'paid';
    else if (!dueAssigned) { status = 'due'; dueAssigned = true; }
    else status = 'upcoming';
    return { ...m, amount, paid_applied: parseFloat(applied.toFixed(2)),
      remaining: parseFloat((amount - applied).toFixed(2)), status };
  });
}

export async function getEstimateBundle(pool, { id = null, token = null, includeInternal = true } = {}) {
  const where = id ? 'e.id = $1' : 'e.public_token = $1';
  const estimateRes = await pool.query(`
    SELECT e.*, sr.first_name || ' ' || sr.last_name as rep_name, sr.email as rep_email
    FROM estimates e LEFT JOIN sales_reps sr ON sr.id = e.sales_rep_id
    WHERE ${where}
  `, [id || token]);
  if (!estimateRes.rows.length) return null;
  const estimate = estimateRes.rows[0];
  estimate.effective_status = effectiveStatus(estimate);
  estimate.deposit_amount = depositAmount(estimate);

  const itemsRes = await pool.query(`
    SELECT ei.*, v.name as vendor_name, s.vendor_sku, s.internal_sku, s.variant_name,
      s.accessory_label, s.variant_type, sa_c.value as color, sa_sz.value as size,
      p.collection as current_collection, COALESCE(ei.cost, pr.cost) as vendor_cost,
      (SELECT ma.url FROM media_assets ma WHERE ma.product_id = p.id AND ma.asset_type = 'primary'
       ORDER BY CASE WHEN ma.sku_id = ei.sku_id THEN 0 WHEN ma.sku_id IS NULL THEN 1 ELSE 2 END, ma.sort_order LIMIT 1) as primary_image
    FROM estimate_items ei
    LEFT JOIN skus s ON s.id = ei.sku_id
    LEFT JOIN products p ON p.id = COALESCE(s.product_id, ei.product_id)
    LEFT JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN pricing pr ON pr.sku_id = ei.sku_id
    LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = ei.sku_id
      AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
    LEFT JOIN sku_attributes sa_sz ON sa_sz.sku_id = ei.sku_id
      AND sa_sz.attribute_id = (SELECT id FROM attributes WHERE slug = 'size' LIMIT 1)
    WHERE ei.estimate_id = $1 ORDER BY ei.sort_order, ei.created_at
  `, [estimate.id]);
  let items = itemsRes.rows;

  const areasRes = await pool.query(
    'SELECT * FROM estimate_areas WHERE estimate_id = $1 ORDER BY sort_order, created_at',
    [estimate.id]
  );
  const areas = areasRes.rows;

  // Draw/payment schedule (progress billing). On the estimate it's just the plan,
  // so paid-status is computed against $0 paid.
  const milestonesRes = await pool.query(
    'SELECT * FROM payment_milestones WHERE estimate_id = $1 ORDER BY sort_order, created_at', [estimate.id]);
  const milestones = computeSchedule(milestonesRes.rows, estimate.total, 0);

  if (!includeInternal) {
    delete estimate.internal_notes;
    items = items.map(({ vendor_cost, ...rest }) => rest);
  }

  // Group items per area; NULL area_id lands in the synthetic "general" bucket
  // (legacy estimates and quick adds). General renders last.
  const itemsByArea = {};
  for (const area of areas) itemsByArea[area.id] = [];
  itemsByArea.general = [];
  for (const item of items) {
    (itemsByArea[item.area_id] || itemsByArea.general).push(item);
  }

  const subtotalOf = (list, type) => parseFloat(list
    .filter(i => i.item_type === type)
    .reduce((sum, i) => sum + parseFloat(i.subtotal || 0), 0)
    .toFixed(2));
  const areaSubtotals = {};
  for (const key of [...areas.map(a => a.id), 'general']) {
    const list = itemsByArea[key];
    const materials = subtotalOf(list, 'material');
    const labor = subtotalOf(list, 'labor');
    areaSubtotals[key] = { materials, labor, total: parseFloat((materials + labor).toFixed(2)) };
  }

  return { estimate, areas, items, itemsByArea, areaSubtotals, milestones };
}

// Ordered [label, scopeNotes, areaSqft, items[]] sections for renderers (PDF,
// email, public page): named areas first in sort order, General last and only
// when it has items.
export function bundleSections(bundle) {
  const sections = bundle.areas.map(a => ({
    key: a.id, name: a.name, scope_notes: a.scope_notes, area_sqft: a.area_sqft,
    items: bundle.itemsByArea[a.id], subtotals: bundle.areaSubtotals[a.id]
  }));
  if (bundle.itemsByArea.general.length) {
    sections.push({
      key: 'general', name: bundle.areas.length ? 'General' : null, scope_notes: null, area_sqft: null,
      items: bundle.itemsByArea.general, subtotals: bundle.areaSubtotals.general
    });
  }
  return sections.filter(s => s.items.length || s.key !== 'general');
}
