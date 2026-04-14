export async function createRepNotification(queryable, repId, type, title, message, entityType, entityId) {
  try {
    await queryable.query(
      `INSERT INTO rep_notifications (rep_id, type, title, message, entity_type, entity_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [repId, type, title, message || null, entityType || null, entityId || null]
    );
  } catch (err) {
    console.error('Failed to create rep notification:', err.message);
  }
}

export async function notifyAllActiveReps(queryable, type, title, message, entityType, entityId) {
  try {
    const reps = await queryable.query('SELECT id FROM sales_reps WHERE is_active = true');
    for (const rep of reps.rows) {
      await createRepNotification(queryable, rep.id, type, title, message, entityType, entityId);
    }
  } catch (err) {
    console.error('Failed to notify all reps:', err.message);
  }
}

export const AUTO_TASK_DEFAULT_DAYS = {
  quote_sent: 3, estimate_sent: 3, sample_shipped: 5,
  order_delivered: 7, deal_stuck: 0, trade_renewal: 0
};

export async function createAutoTask(pool, repId, sourceType, sourceId, title, options = {}) {
  try {
    const defaultDays = AUTO_TASK_DEFAULT_DAYS[sourceType] || 3;
    const dueDate = options.due_date || new Date(Date.now() + defaultDays * 86400000).toISOString().split('T')[0];
    const result = await pool.query(`
      INSERT INTO rep_tasks (rep_id, title, description, due_date, priority, source, source_type, source_id,
        customer_name, customer_email, customer_phone,
        linked_order_id, linked_quote_id, linked_estimate_id, linked_deal_id)
      VALUES ($1, $2, $3, $4, $5, 'auto', $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (rep_id, source_type, source_id) WHERE source = 'auto' AND status != 'dismissed'
      DO NOTHING
      RETURNING *
    `, [repId, title, options.description || null, dueDate, options.priority || 'medium',
        sourceType, String(sourceId),
        options.customer_name || null, options.customer_email || null, options.customer_phone || null,
        options.linked_order_id || null, options.linked_quote_id || null,
        options.linked_estimate_id || null, options.linked_deal_id || null]);
    return result.rows[0] || null;
  } catch (err) {
    console.error('[AutoTask] Failed to create auto-task:', err.message);
    return null;
  }
}
