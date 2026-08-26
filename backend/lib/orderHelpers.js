export async function recalculateBalance(pool, orderId, client) {
  const db = client || pool;
  const result = await db.query('SELECT total, amount_paid FROM orders WHERE id = $1', [orderId]);
  if (!result.rows.length) return null;
  const total = parseFloat(result.rows[0].total);
  const amount_paid = parseFloat(result.rows[0].amount_paid);
  const balance = parseFloat((total - amount_paid).toFixed(2));
  let balance_status = 'paid';
  if (balance > 0.01) balance_status = 'balance_due';
  else if (balance < -0.01) balance_status = 'credit';
  return { amount_paid, total, balance, balance_status };
}

// Recompute an order's money from its current line items and persist it:
// subtotal (all non-sample lines), materials-only sales tax scaled from the
// stored tax_rate (labor + samples excluded, matching order creation), then the
// grand total. Shared by every item add/remove/reprice endpoint so a change
// order re-taxes correctly instead of freezing the tax at its creation value.
// Legacy orders with no usable tax_rate keep their existing tax_amount rather
// than being zeroed. Returns { subtotal, tax_amount, total }.
export async function recalcOrderTotals(db, orderId) {
  const o = await db.query(
    'SELECT shipping, sample_shipping, transfer_fee, discount_amount, tax_rate, tax_amount FROM orders WHERE id = $1',
    [orderId]
  );
  if (!o.rows.length) return null;
  const row = o.rows[0];
  const sums = await db.query(`
    SELECT
      COALESCE(SUM(CASE WHEN NOT is_sample THEN subtotal ELSE 0 END), 0) AS subtotal,
      COALESCE(SUM(CASE WHEN NOT is_sample AND COALESCE(item_type, 'material') <> 'labor' THEN subtotal ELSE 0 END), 0) AS materials_subtotal
    FROM order_items WHERE order_id = $1
  `, [orderId]);
  const subtotal = parseFloat(parseFloat(sums.rows[0].subtotal).toFixed(2));
  const materialsSubtotal = parseFloat(sums.rows[0].materials_subtotal);
  const shipping = parseFloat(row.shipping || 0);
  const sampleShipping = parseFloat(row.sample_shipping || 0);
  const transferFee = parseFloat(row.transfer_fee || 0);
  const discount = parseFloat(row.discount_amount || 0);
  const rate = parseFloat(row.tax_rate || 0);
  const tax_amount = rate > 0
    ? parseFloat((materialsSubtotal * rate).toFixed(2))
    : parseFloat(parseFloat(row.tax_amount || 0).toFixed(2));
  const total = parseFloat((subtotal + shipping + sampleShipping + transferFee + tax_amount - discount).toFixed(2));
  await db.query('UPDATE orders SET subtotal = $1, tax_amount = $2, total = $3 WHERE id = $4',
    [subtotal.toFixed(2), tax_amount.toFixed(2), total.toFixed(2), orderId]);
  return { subtotal, tax_amount, total };
}

// Customer-facing edits that change the invoice and thus warrant a REVISED stamp.
// Excludes internal/warehouse/lifecycle events (cost_updated, item_ready, status).
// NOTE: 'discount_changed' has no emitter yet (orders have no post-creation
// discount-edit endpoint) — it's wired here so a future discount edit counts
// automatically once it logs that action.
const REVISION_EDIT_ACTIONS = new Set([
  'item_added', 'item_removed', 'price_adjusted', 'delivery_method_changed', 'discount_changed'
]);

export async function logOrderActivity(queryable, orderId, action, performerId, performerName, details = {}) {
  try {
    await queryable.query(
      `INSERT INTO order_activity_log (order_id, action, performed_by, performer_name, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderId, action, performerId || null, performerName || null, JSON.stringify(details)]
    );
    // Latch the order "revised" only when its customer-facing contents are edited
    // AFTER it has already been sent to the customer (invoice / payment request).
    // This is what stamps REVISED on the invoice; a plain resend never sets it.
    if (REVISION_EDIT_ACTIONS.has(action)) {
      await queryable.query(
        `UPDATE orders SET is_revised = true
         WHERE id = $1 AND is_revised = false
           AND EXISTS (SELECT 1 FROM order_activity_log
                       WHERE order_id = $1 AND action IN ('invoice_sent', 'payment_request_sent'))`,
        [orderId]
      );
    }
  } catch (err) {
    console.error('Failed to log order activity:', err.message);
  }
}

export async function recalculateCommission(queryable, orderId) {
  try {
    // Fetch order
    const orderRes = await queryable.query(
      'SELECT id, total, subtotal, discount_amount, status, sales_rep_id, amount_paid FROM orders WHERE id = $1',
      [orderId]
    );
    if (!orderRes.rows.length) return;
    const order = orderRes.rows[0];
    if (!order.sales_rep_id) return;

    // Fetch commission config
    const configRes = await queryable.query('SELECT rate, labor_rate, default_cost_ratio FROM commission_config LIMIT 1');
    if (!configRes.rows.length) return;
    const config = configRes.rows[0];
    const rate = parseFloat(config.rate);
    const laborRate = parseFloat(config.labor_rate);
    const defaultCostRatio = parseFloat(config.default_cost_ratio);

    // Calculate vendor cost from purchase_order_items (excluding cancelled POs).
    // POs only carry material lines, so this cost is materials-only. Custom rug
    // lines are EXCLUDED here — they carry their own true cost on order_items.cost
    // (material + binding + fabrication), added below, so counting a rug's PO too
    // would double-count. (A rug PO is $0 today anyway; the join future-proofs it.)
    const costRes = await queryable.query(`
      SELECT COALESCE(SUM(poi.subtotal), 0) as vendor_cost
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
      LEFT JOIN order_items oi ON oi.id = poi.order_item_id
      WHERE po.order_id = $1 AND po.status != 'cancelled'
        AND COALESCE(oi.is_custom_rug, false) = false
    `, [orderId]);
    let vendorCost = parseFloat(costRes.rows[0].vendor_cost);

    // Custom bound area rugs: real per-line cost (material + binding + fabrication)
    // stored on order_items.cost at checkout. num_boxes = rug quantity.
    const rugRes = await queryable.query(`
      SELECT COALESCE(SUM(subtotal), 0) as rug_revenue,
             COALESCE(SUM(COALESCE(cost, 0) * num_boxes), 0) as rug_cost
      FROM order_items
      WHERE order_id = $1 AND COALESCE(is_sample, false) = false
        AND COALESCE(item_type, 'material') <> 'labor' AND is_custom_rug = true
    `, [orderId]);
    const rugRevenue = parseFloat(rugRes.rows[0].rug_revenue);
    const rugCost = parseFloat(rugRes.rows[0].rug_cost);

    // Labor lines are commissioned separately (flat labor_rate on labor revenue),
    // so they must be pulled out of the material margin base to avoid paying the
    // material rate on top of the labor rate.
    const laborRes = await queryable.query(`
      SELECT COALESCE(SUM(subtotal), 0) as labor_subtotal
      FROM order_items
      WHERE order_id = $1 AND COALESCE(is_sample, false) = false
        AND COALESCE(item_type, 'material') = 'labor'
    `, [orderId]);
    const laborSubtotal = parseFloat(laborRes.rows[0].labor_subtotal);

    const orderTotal = parseFloat(order.total);
    // Commission is paid on MERCHANDISE margin only. Base = the non-sample
    // line-item subtotal (order.subtotal) minus labor (commissioned separately at
    // the labor rate) minus the order discount. Shipping, sample shipping,
    // transfer fees and tax are NOT part of order.subtotal, so they're excluded —
    // reps earn no commission on shipping or fees.
    const orderSubtotal = parseFloat(order.subtotal || 0);
    const orderDiscount = parseFloat(order.discount_amount || 0);
    const materialsBase = Math.max(0, orderSubtotal - laborSubtotal - orderDiscount);

    // Fallback: if no PO data, estimate materials cost from the materials base —
    // but only for the NON-rug portion, since rugs carry their own real cost
    // (added separately below). Otherwise the rug would be costed twice.
    if (vendorCost === 0) {
      vendorCost = Math.max(0, materialsBase - rugRevenue) * defaultCostRatio;
    }

    // Total materials cost = PO/estimated cost (non-rug) + rugs' real cost.
    const totalVendorCost = vendorCost + rugCost;
    const margin = Math.max(0, materialsBase - totalVendorCost); // materials gross profit
    const materialsCommission = margin * rate;
    const laborCommission = laborSubtotal * laborRate;
    const commissionAmount = materialsCommission + laborCommission;

    // Determine status. Commission is only payable once the order is finalized —
    // delivered AND paid in full; cancelled/refunded orders forfeit it.
    let commissionStatus = 'pending';
    if (['cancelled', 'refunded'].includes(order.status)) {
      commissionStatus = 'forfeited';
    } else if (order.status === 'delivered' && parseFloat(order.amount_paid) >= orderTotal) {
      commissionStatus = 'earned';
    }

    // Upsert — preserve 'paid' status
    await queryable.query(`
      INSERT INTO rep_commissions (order_id, rep_id, order_total, vendor_cost, margin, commission_rate, commission_amount, labor_subtotal, labor_commission, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (order_id) DO UPDATE SET
        rep_id = EXCLUDED.rep_id,
        order_total = EXCLUDED.order_total,
        vendor_cost = EXCLUDED.vendor_cost,
        margin = EXCLUDED.margin,
        commission_rate = EXCLUDED.commission_rate,
        commission_amount = EXCLUDED.commission_amount,
        labor_subtotal = EXCLUDED.labor_subtotal,
        labor_commission = EXCLUDED.labor_commission,
        status = CASE WHEN rep_commissions.status = 'paid' THEN 'paid' ELSE EXCLUDED.status END,
        updated_at = CURRENT_TIMESTAMP
    `, [orderId, order.sales_rep_id, orderTotal.toFixed(2), totalVendorCost.toFixed(2),
        margin.toFixed(2), rate, commissionAmount.toFixed(2),
        laborSubtotal.toFixed(2), laborCommission.toFixed(2), commissionStatus]);
  } catch (err) {
    console.error('Failed to recalculate commission:', err.message);
  }
}

// ==================== Store Credit ====================
// A signed ledger: balance = SUM(amount) per customer. Keyed like invoices —
// trade customers by trade_customer_id, retail by LOWER(customer_email).
// Positive rows = credit granted; negative rows = credit redeemed at checkout.

export async function getStoreCreditBalance(queryable, { email, trade_customer_id } = {}) {
  let res;
  if (trade_customer_id) {
    res = await queryable.query(
      'SELECT COALESCE(SUM(amount), 0) AS bal FROM store_credit_ledger WHERE trade_customer_id = $1',
      [trade_customer_id]
    );
  } else if (email) {
    res = await queryable.query(
      'SELECT COALESCE(SUM(amount), 0) AS bal FROM store_credit_ledger WHERE LOWER(customer_email) = LOWER($1) AND trade_customer_id IS NULL',
      [email]
    );
  } else {
    return 0;
  }
  return parseFloat(parseFloat(res.rows[0].bal).toFixed(2));
}

// Grant credit (positive entry). Use inside a transaction (pass the tx client).
export async function grantStoreCredit(client, {
  email, trade_customer_id, amount, reason, source_type, source_id, order_id,
  staffId, staffName, expiresAt
}) {
  const amt = parseFloat(parseFloat(amount).toFixed(2));
  if (!(amt > 0)) throw new Error('Store credit grant amount must be positive');
  const res = await client.query(
    `INSERT INTO store_credit_ledger
       (customer_email, trade_customer_id, amount, reason, source_type, source_id, order_id, created_by, created_by_name, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [email || null, trade_customer_id || null, amt, reason || null, source_type,
     source_id || null, order_id || null, staffId || null, staffName || null, expiresAt || null]
  );
  return res.rows[0];
}

// Redeem credit against an order (negative entry) AND record it as an
// order_payments tender so recalculateBalance() sees it. Use inside the
// order's transaction, after the order row exists.
export async function redeemStoreCredit(client, { email, trade_customer_id, amount, order_id, staffId, staffName }) {
  const amt = parseFloat(parseFloat(amount).toFixed(2));
  if (!(amt > 0)) throw new Error('Store credit redemption amount must be positive');
  const balance = await getStoreCreditBalance(client, { email, trade_customer_id });
  if (amt > balance + 0.01) {
    throw new Error(`Insufficient store credit (balance ${balance.toFixed(2)}, requested ${amt.toFixed(2)})`);
  }
  const ledgerRes = await client.query(
    `INSERT INTO store_credit_ledger
       (customer_email, trade_customer_id, amount, reason, source_type, source_id, order_id, created_by, created_by_name)
     VALUES ($1,$2,$3,'Applied to order','redemption',$4,$5,$6,$7) RETURNING *`,
    [email || null, trade_customer_id || null, -amt, order_id || null, order_id || null, staffId || null, staffName || null]
  );
  const payRes = await client.query(
    `INSERT INTO order_payments
       (order_id, payment_type, amount, description, initiated_by, initiated_by_name, status, payment_method)
     VALUES ($1, 'charge', $2, 'Store credit applied', $3, $4, 'completed', 'store_credit') RETURNING id`,
    [order_id, amt, staffId || null, staffName || null]
  );
  await client.query('UPDATE orders SET amount_paid = COALESCE(amount_paid, 0) + $1 WHERE id = $2', [amt, order_id]);
  return { ledger: ledgerRes.rows[0], order_payment_id: payRes.rows[0].id };
}

// Sync an order_payment to invoice_payments (AR receipt) if an invoice exists for the order
export async function syncOrderPaymentToInvoice(orderPaymentId, orderId, queryable) {
  try {
    const invRes = await queryable.query(
      "SELECT id, total, amount_paid FROM invoices WHERE order_id = $1 AND status != 'void' LIMIT 1",
      [orderId]
    );
    if (!invRes.rows.length) return;
    const invoice = invRes.rows[0];

    // Check if already synced
    const existing = await queryable.query(
      'SELECT id FROM invoice_payments WHERE order_payment_id = $1',
      [orderPaymentId]
    );
    if (existing.rows.length) return;

    // Get payment details. order_payments has no reference_number column — derive
    // the AR receipt reference from whichever Stripe/check identifier is present.
    const opRes = await queryable.query(
      `SELECT amount, payment_method,
              COALESCE(stripe_payment_intent_id, stripe_checkout_session_id, check_number) AS reference_number
       FROM order_payments WHERE id = $1`,
      [orderPaymentId]
    );
    if (!opRes.rows.length) return;
    const op = opRes.rows[0];

    await queryable.query(
      `INSERT INTO invoice_payments (invoice_id, order_payment_id, amount, payment_method, reference_number, payment_date)
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)`,
      [invoice.id, orderPaymentId, op.amount, op.payment_method || 'stripe', op.reference_number]
    );

    // Update invoice amount_paid and status
    const totals = await queryable.query(
      'SELECT COALESCE(SUM(amount), 0) as total_paid FROM invoice_payments WHERE invoice_id = $1',
      [invoice.id]
    );
    const totalPaid = parseFloat(totals.rows[0].total_paid);
    const invoiceTotal = parseFloat(invoice.total);
    const newStatus = totalPaid >= invoiceTotal ? 'paid' : totalPaid > 0 ? 'partial' : 'sent';

    await queryable.query(
      `UPDATE invoices SET amount_paid = $1, status = $2, paid_at = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4`,
      [totalPaid, newStatus, newStatus === 'paid' ? new Date() : null, invoice.id]
    );
  } catch (err) {
    console.error('syncOrderPaymentToInvoice error:', err.message);
  }
}
