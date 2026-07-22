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
