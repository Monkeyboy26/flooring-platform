import crypto from 'crypto';
import { titleCaseName, formatPhone, normMiddleInitial, collapse } from './customerNormalize.js';

// Normalize a phone to its last 10 digits (drops +1 / formatting). Returns '' when
// there aren't 10 digits — so partial/empty phones never match anything.
export function phoneKey(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

// Find an existing account (retail OR trade) that EXACTLY matches by lowercased
// email or by normalized 10-digit phone. Returns the match (email matches ranked
// first) or null. `db` is a pool or client. `excludeId` skips a customer row
// (used when editing an existing record). Phone comparison is format-agnostic.
export async function findExactDuplicate(db, { email, phone, excludeId = null } = {}) {
  const emailNorm = (email || '').toLowerCase().trim();
  const pk = phoneKey(phone);
  if (!emailNorm && !pk) return null;
  const { rows } = await db.query(`
    SELECT id, (first_name || ' ' || last_name) AS name, email, phone, company_name,
           'retail' AS type, password_set, (email = $1) AS email_match
    FROM customers
    WHERE (($1 <> '' AND email = $1)
        OR ($2 <> '' AND right(regexp_replace(coalesce(phone,''),'[^0-9]','','g'), 10) = $2))
      AND ($3::uuid IS NULL OR id <> $3)
    UNION ALL
    SELECT id, contact_name AS name, email, phone, company_name,
           'trade' AS type, true AS password_set, (email = $1) AS email_match
    FROM trade_customers
    WHERE (($1 <> '' AND email = $1)
        OR ($2 <> '' AND right(regexp_replace(coalesce(phone,''),'[^0-9]','','g'), 10) = $2))
    ORDER BY email_match DESC
    LIMIT 1
  `, [emailNorm, pk, excludeId]);
  return rows[0] || null;
}

// When a customer registers or logs in, attach any prior GUEST records that used
// their email but were never owned (customer_id IS NULL), so their guest orders/
// quotes/estimates/samples show up in "My account". Returns counts moved.
export async function claimGuestRecords(db, customerId, email) {
  const e = (email || '').toLowerCase().trim();
  if (!customerId || !e) return {};
  const moved = {};
  for (const t of ['orders', 'quotes', 'estimates', 'sample_requests']) {
    const r = await db.query(
      `UPDATE ${t} SET customer_id = $1 WHERE customer_id IS NULL AND lower(customer_email) = $2`,
      [customerId, e]
    );
    moved[t] = r.rowCount;
  }
  return moved;
}

export function createCustomerHelpers(hashPassword, sendWelcomeSetPassword) {
  async function findOrCreateCustomer(client, { email, firstName, lastName, middleInitial, phone, companyName, repId, createdVia }) {
    const normalEmail = email.toLowerCase().trim();

    // 1. Check if customer exists by email, then fall back to a phone match so we
    //    don't spawn a duplicate account for the same person using a new email.
    let existing = await client.query('SELECT * FROM customers WHERE email = $1', [normalEmail]);
    if (existing.rows.length === 0) {
      const pk = phoneKey(phone);
      if (pk) {
        existing = await client.query(
          `SELECT * FROM customers WHERE right(regexp_replace(coalesce(phone,''),'[^0-9]','','g'), 10) = $1 LIMIT 1`,
          [pk]
        );
      }
    }

    if (existing.rows.length > 0) {
      const cust = existing.rows[0];
      // Backfill missing fields (phone, name, rep) if they were empty
      const updates = [];
      const vals = [];
      let idx = 1;
      if (!cust.phone && phone) { updates.push(`phone = $${idx++}`); vals.push(phone); }
      if (!cust.first_name && firstName) { updates.push(`first_name = $${idx++}`); vals.push(firstName); }
      if (!cust.last_name && lastName) { updates.push(`last_name = $${idx++}`); vals.push(lastName); }
      if (!cust.company_name && companyName) { updates.push(`company_name = $${idx++}`); vals.push(companyName); }
      // Free-agent auto-claim: the acting rep takes ownership if the customer is
      // unassigned OR its current rep is deactivated (a "free agent"). We never
      // take a customer away from another ACTIVE rep.
      if (repId && cust.assigned_rep_id !== repId) {
        let claim = !cust.assigned_rep_id;
        if (!claim) {
          const owner = await client.query('SELECT is_active FROM staff_accounts WHERE id = $1', [cust.assigned_rep_id]);
          claim = !owner.rows.length || owner.rows[0].is_active === false;
        }
        if (claim) {
          updates.push(`assigned_rep_id = $${idx++}`); vals.push(repId);
          updates.push(`assigned_at = NOW()`);
        }
      }
      if (updates.length > 0) {
        vals.push(cust.id);
        await client.query(`UPDATE customers SET ${updates.join(', ')} WHERE id = $${idx}`, vals);
      }
      return { customer: cust, created: false };
    }

    // Every customer must have a real first AND last name (normalized to Title Case).
    const fn = titleCaseName(firstName);
    const ln = titleCaseName(lastName);
    if (!fn || !ln) {
      const err = new Error('Customer first and last name are required');
      err.status = 400;
      throw err;
    }
    const mi = normMiddleInitial(middleInitial);

    // 2. Create new customer with random placeholder password
    const placeholder = crypto.randomBytes(32).toString('hex');
    const { hash, salt } = await hashPassword(placeholder);

    const result = await client.query(
      `INSERT INTO customers (email, password_hash, password_salt, first_name, last_name, middle_initial, phone, company_name, password_set, assigned_rep_id, assigned_at, created_via)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, NOW(), $10)
       RETURNING *`,
      [normalEmail, hash, salt, fn, ln, mi, formatPhone(phone) || null, collapse(companyName), repId || null, createdVia || 'rep']
    );

    const newCustomer = result.rows[0];

    // 3. Generate password-set token (7-day expiry)
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await client.query(
      'UPDATE customers SET password_reset_token = $1, password_reset_expires = $2 WHERE id = $3',
      [tokenHash, expires, newCustomer.id]
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
