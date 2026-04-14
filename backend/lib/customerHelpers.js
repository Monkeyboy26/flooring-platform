import crypto from 'crypto';

export function createCustomerHelpers(hashPassword, sendWelcomeSetPassword) {
  async function findOrCreateCustomer(client, { email, firstName, lastName, phone, repId, createdVia }) {
    const normalEmail = email.toLowerCase().trim();

    // 1. Check if customer exists by email
    const existing = await client.query('SELECT * FROM customers WHERE email = $1', [normalEmail]);

    if (existing.rows.length > 0) {
      const cust = existing.rows[0];
      // Backfill missing fields (phone, name, rep) if they were empty
      const updates = [];
      const vals = [];
      let idx = 1;
      if (!cust.phone && phone) { updates.push(`phone = $${idx++}`); vals.push(phone); }
      if (!cust.first_name && firstName) { updates.push(`first_name = $${idx++}`); vals.push(firstName); }
      if (!cust.last_name && lastName) { updates.push(`last_name = $${idx++}`); vals.push(lastName); }
      if (!cust.assigned_rep_id && repId) {
        updates.push(`assigned_rep_id = $${idx++}`); vals.push(repId);
        updates.push(`assigned_at = NOW()`);
      }
      if (updates.length > 0) {
        vals.push(cust.id);
        await client.query(`UPDATE customers SET ${updates.join(', ')} WHERE id = $${idx}`, vals);
      }
      return { customer: cust, created: false };
    }

    // 2. Create new customer with random placeholder password
    const placeholder = crypto.randomBytes(32).toString('hex');
    const { hash, salt } = hashPassword(placeholder);

    const result = await client.query(
      `INSERT INTO customers (email, password_hash, password_salt, first_name, last_name, phone, password_set, assigned_rep_id, assigned_at, created_via)
       VALUES ($1, $2, $3, $4, $5, $6, false, $7, NOW(), $8)
       RETURNING *`,
      [normalEmail, hash, salt, firstName || '', lastName || '', phone || null, repId || null, createdVia || 'rep']
    );

    const newCustomer = result.rows[0];

    // 3. Generate password-set token (7-day expiry)
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await client.query(
      'UPDATE customers SET password_reset_token = $1, password_reset_expires = $2 WHERE id = $3',
      [token, expires, newCustomer.id]
    );

    // 4. Send welcome email asynchronously (fire after transaction commits)
    const resetUrl = `${process.env.FRONTEND_URL || 'https://romaflooringdesigns.com'}/account?action=set-password&token=${token}`;
    setImmediate(() => {
      sendWelcomeSetPassword(newCustomer.email, newCustomer.first_name, resetUrl).catch(err => {
        console.error('Failed to send welcome email:', err);
      });
    });

    return { customer: newCustomer, created: true };
  }

  return { findOrCreateCustomer };
}
