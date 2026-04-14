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

export async function logOrderActivity(queryable, orderId, action, performerId, performerName, details = {}) {
  try {
    await queryable.query(
      `INSERT INTO order_activity_log (order_id, action, performed_by, performer_name, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderId, action, performerId || null, performerName || null, JSON.stringify(details)]
    );
  } catch (err) {
    console.error('Failed to log order activity:', err.message);
  }
}

export async function recalculateCommission(queryable, orderId) {
  try {
    // Fetch order
    const orderRes = await queryable.query(
      'SELECT id, total, status, sales_rep_id, amount_paid FROM orders WHERE id = $1',
      [orderId]
    );
    if (!orderRes.rows.length) return;
    const order = orderRes.rows[0];
    if (!order.sales_rep_id) return;

    // Fetch commission config
    const configRes = await queryable.query('SELECT rate, default_cost_ratio FROM commission_config LIMIT 1');
    if (!configRes.rows.length) return;
    const config = configRes.rows[0];
    const rate = parseFloat(config.rate);
    const defaultCostRatio = parseFloat(config.default_cost_ratio);

    // Calculate vendor cost from purchase_order_items (excluding cancelled POs)
    const costRes = await queryable.query(`
      SELECT COALESCE(SUM(poi.subtotal), 0) as vendor_cost
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE po.order_id = $1 AND po.status != 'cancelled'
    `, [orderId]);
    let vendorCost = parseFloat(costRes.rows[0].vendor_cost);

    // Fallback: if no PO data, estimate cost
    const orderTotal = parseFloat(order.total);
    if (vendorCost === 0) {
      vendorCost = orderTotal * defaultCostRatio;
    }

    const margin = Math.max(0, orderTotal - vendorCost);
    const commissionAmount = margin * rate;

    // Determine status
    let commissionStatus = 'pending';
    if (['cancelled', 'refunded'].includes(order.status)) {
      commissionStatus = 'forfeited';
    } else if (order.status === 'delivered' && parseFloat(order.amount_paid) >= orderTotal) {
      commissionStatus = 'earned';
    }

    // Upsert — preserve 'paid' status
    await queryable.query(`
      INSERT INTO rep_commissions (order_id, rep_id, order_total, vendor_cost, margin, commission_rate, commission_amount, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (order_id) DO UPDATE SET
        rep_id = EXCLUDED.rep_id,
        order_total = EXCLUDED.order_total,
        vendor_cost = EXCLUDED.vendor_cost,
        margin = EXCLUDED.margin,
        commission_rate = EXCLUDED.commission_rate,
        commission_amount = EXCLUDED.commission_amount,
        status = CASE WHEN rep_commissions.status = 'paid' THEN 'paid' ELSE EXCLUDED.status END,
        updated_at = CURRENT_TIMESTAMP
    `, [orderId, order.sales_rep_id, orderTotal.toFixed(2), vendorCost.toFixed(2),
        margin.toFixed(2), rate, commissionAmount.toFixed(2), commissionStatus]);
  } catch (err) {
    console.error('Failed to recalculate commission:', err.message);
  }
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

    // Get payment details
    const opRes = await queryable.query(
      'SELECT amount, payment_method, reference_number FROM order_payments WHERE id = $1',
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
