import { Router } from 'express';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { generateQuoteHtml } from '../lib/documents.js';

export default function createCustomerRoutes(ctx) {
  const router = Router();
  const {
    pool, customerAuth, optionalCustomerAuth,
    hashPassword, verifyPassword, hashToken, logAudit,
    sendPasswordReset, sendWelcomeSetPassword,
    recalculateBalance,
    generatePDF, generateSampleRequestConfirmationHtml
  } = ctx;

  router.post('/api/customer/register', async (req, res) => {
    try {
      let { email, password, first_name, last_name, phone, newsletter } = req.body;
      if (!email || !password || !first_name || !last_name || !phone) {
        return res.status(400).json({ error: 'Email, password, first name, last name, and phone number are required' });
      }
      email = String(email).trim().slice(0, 255);
      first_name = String(first_name).trim().slice(0, 100);
      last_name = String(last_name).trim().slice(0, 100);
      phone = String(phone).trim().slice(0, 30);
      if (!first_name || !last_name) {
        return res.status(400).json({ error: 'First and last name are required' });
      }
      if (phone.replace(/\D/g, '').length < 10) {
        return res.status(400).json({ error: 'Enter a valid 10-digit phone number' });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }
      if (password.length < 8 || password.length > 128 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
        return res.status(400).json({ error: 'Password must be 8–128 characters with 1 uppercase letter and 1 number' });
      }

      const existing = await pool.query('SELECT id, email, first_name, password_set FROM customers WHERE email = $1', [email.toLowerCase()]);
      if (existing.rows.length) {
        // Account exists but was auto-created by a rep and never claimed.
        // We must NOT let an unauthenticated caller set its password just by
        // knowing the email — that is account takeover. Email a set-password
        // link instead, so only the inbox owner can claim it.
        if (existing.rows[0].password_set === false) {
          const claimToken = crypto.randomBytes(32).toString('hex');
          const tokenHash = crypto.createHash('sha256').update(claimToken).digest('hex');
          const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
          await pool.query(
            'UPDATE customers SET password_reset_token = $1, password_reset_expires = $2 WHERE id = $3',
            [tokenHash, expires, existing.rows[0].id]
          );
          const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
          const claimUrl = `${frontendUrl}/account?action=set-password&token=${claimToken}`;
          sendWelcomeSetPassword(existing.rows[0].email, existing.rows[0].first_name, claimUrl)
            .catch(err => console.error('[Email] Set-password link error:', err.message));
          // 409, not a 200 with a session: the caller has not proven they own
          // the inbox, so they get no token. Existing clients render data.error.
          return res.status(409).json({ error: 'This email already has an account. Check your inbox for a link to set your password.' });
        }
        return res.status(400).json({ error: 'An account with this email already exists' });
      }

      const { hash, salt } = await hashPassword(password);
      const result = await pool.query(
        `INSERT INTO customers (email, password_hash, password_salt, first_name, last_name, phone, password_set)
         VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id, email, first_name, last_name, phone, address_line1, address_line2, city, state, zip, password_set, created_via`,
        [email.toLowerCase(), hash, salt, first_name, last_name, phone || null]
      );
      const customer = result.rows[0];

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await pool.query('INSERT INTO customer_sessions (customer_id, token, expires_at) VALUES ($1, $2, $3)',
        [customer.id, hashToken(token), expiresAt]);

      if (newsletter) {
        await pool.query('INSERT INTO newsletter_subscribers (email) VALUES ($1) ON CONFLICT (email) DO NOTHING', [email.toLowerCase()]);
      }

      res.json({ token, customer });
    } catch (err) {
      console.error('Customer register error:', err);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  router.post('/api/customer/login', async (req, res) => {
    try {
      let { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }
      email = String(email).trim().slice(0, 255);

      const result = await pool.query(
        'SELECT id, email, password_hash, password_salt, first_name, last_name, phone, password_set, created_via, address_line1, address_line2, city, state, zip FROM customers WHERE email = $1',
        [email.toLowerCase()]
      );
      if (!result.rows.length) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const cust = result.rows[0];

      // Auto-created accounts that never set a password can't log in by
      // password. Return the same generic error as a bad password so this
      // isn't an account-existence oracle. (These accounts also carry an
      // unusable placeholder hash, so verifyPassword below would fail anyway.)
      if (cust.password_set === false) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      if (!(await verifyPassword(password, cust.password_hash, cust.password_salt))) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await pool.query('INSERT INTO customer_sessions (customer_id, token, expires_at) VALUES ($1, $2, $3)',
        [cust.id, hashToken(token), expiresAt]);

      // Non-staff actor: log under entity_type/entity_id, staff_id stays null.
      await logAudit(null, 'customer.login', 'customers', cust.id, { email: cust.email }, req.ip);

      res.json({
        token,
        customer: { id: cust.id, email: cust.email, first_name: cust.first_name, last_name: cust.last_name, phone: cust.phone, address_line1: cust.address_line1, address_line2: cust.address_line2, city: cust.city, state: cust.state, zip: cust.zip, password_set: cust.password_set, created_via: cust.created_via }
      });
    } catch (err) {
      console.error('Customer login error:', err);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  router.post('/api/customer/logout', customerAuth, async (req, res) => {
    try {
      await pool.query('DELETE FROM customer_sessions WHERE id = $1', [req.customer.session_id]);
      await logAudit(null, 'customer.logout', 'customers', req.customer.id, {}, req.ip);
      res.json({ success: true });
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/customer/me', customerAuth, async (req, res) => {
    res.json({ customer: req.customer });
  });

  router.put('/api/customer/profile', customerAuth, async (req, res) => {
    try {
      const { first_name, last_name, phone, address_line1, address_line2, city, state, zip } = req.body;
      const result = await pool.query(
        `UPDATE customers SET first_name = COALESCE($1, first_name), last_name = COALESCE($2, last_name),
          phone = COALESCE($3, phone), address_line1 = COALESCE($4, address_line1),
          address_line2 = COALESCE($5, address_line2), city = COALESCE($6, city),
          state = COALESCE($7, state), zip = COALESCE($8, zip), updated_at = CURRENT_TIMESTAMP
         WHERE id = $9
         RETURNING id, email, first_name, last_name, phone, address_line1, address_line2, city, state, zip, password_set, created_via`,
        [first_name, last_name, phone, address_line1, address_line2, city, state, zip, req.customer.id]
      );
      res.json({ customer: result.rows[0] });
    } catch (err) {
      console.error('Customer profile update error:', err);
      res.status(500).json({ error: 'Failed to update profile' });
    }
  });

  router.put('/api/customer/password', customerAuth, async (req, res) => {
    try {
      const { current_password, new_password } = req.body;
      if (!current_password || !new_password) {
        return res.status(400).json({ error: 'Current and new password are required' });
      }
      if (new_password.length < 8 || new_password.length > 128 || !/[A-Z]/.test(new_password) || !/[0-9]/.test(new_password)) {
        return res.status(400).json({ error: 'Password must be 8–128 characters with 1 uppercase letter and 1 number' });
      }

      const result = await pool.query('SELECT password_hash, password_salt FROM customers WHERE id = $1', [req.customer.id]);
      const cust = result.rows[0];
      if (!(await verifyPassword(current_password, cust.password_hash, cust.password_salt))) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }

      const { hash, salt } = await hashPassword(new_password);
      await pool.query('UPDATE customers SET password_hash = $1, password_salt = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [hash, salt, req.customer.id]);

      // Revoke all other sessions so a stolen token can't survive a password
      // change; keep the current session so the user stays signed in.
      await pool.query('DELETE FROM customer_sessions WHERE customer_id = $1 AND id != $2',
        [req.customer.id, req.customer.session_id]);

      res.json({ success: true });
    } catch (err) {
      console.error('Customer password change error:', err);
      res.status(500).json({ error: 'Failed to change password' });
    }
  });

  router.post('/api/customer/forgot-password', async (req, res) => {
    try {
      let { email } = req.body;
      // Always return success to not leak whether email exists
      if (!email) return res.json({ success: true });
      email = String(email).trim().slice(0, 255);

      const result = await pool.query('SELECT id, email FROM customers WHERE email = $1', [email.toLowerCase()]);
      if (result.rows.length) {
        const resetToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
        const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
        await pool.query(
          'UPDATE customers SET password_reset_token = $1, password_reset_expires = $2 WHERE id = $3',
          [tokenHash, expires, result.rows[0].id]
        );
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        const resetUrl = `${frontendUrl}?reset_token=${resetToken}`;
        sendPasswordReset(result.rows[0].email, resetUrl).catch(err => console.error('[Email] Password reset error:', err.message));
      }

      res.json({ success: true });
    } catch (err) {
      console.error('Forgot password error:', err);
      res.json({ success: true });
    }
  });

  router.post('/api/customer/reset-password', async (req, res) => {
    try {
      const { token, new_password } = req.body;
      if (!token || !new_password) {
        return res.status(400).json({ error: 'Token and new password are required' });
      }
      if (new_password.length < 8 || new_password.length > 128 || !/[A-Z]/.test(new_password) || !/[0-9]/.test(new_password)) {
        return res.status(400).json({ error: 'Password must be 8–128 characters with 1 uppercase letter and 1 number' });
      }

      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const result = await pool.query(
        'SELECT id FROM customers WHERE password_reset_token = $1 AND password_reset_expires > CURRENT_TIMESTAMP',
        [tokenHash]
      );
      if (!result.rows.length) {
        return res.status(400).json({ error: 'Invalid or expired reset link' });
      }

      const customerId = result.rows[0].id;
      const { hash, salt } = await hashPassword(new_password);
      await pool.query(
        'UPDATE customers SET password_hash = $1, password_salt = $2, password_set = true, password_reset_token = NULL, password_reset_expires = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [hash, salt, customerId]
      );

      // Invalidate all existing sessions for this customer
      await pool.query('DELETE FROM customer_sessions WHERE customer_id = $1', [customerId]);

      // Create a new session so the user is auto-logged in
      const sessionToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await pool.query('INSERT INTO customer_sessions (customer_id, token, expires_at) VALUES ($1, $2, $3)',
        [customerId, hashToken(sessionToken), expiresAt]);
      const custResult = await pool.query(
        'SELECT id, email, first_name, last_name, phone, address_line1, address_line2, city, state, zip, password_set, created_via FROM customers WHERE id = $1',
        [customerId]
      );

      res.json({ success: true, token: sessionToken, customer: custResult.rows[0] });
    } catch (err) {
      console.error('Reset password error:', err);
      res.status(500).json({ error: 'Failed to reset password' });
    }
  });

  // ==================== Google OAuth ====================

  router.post('/api/customer/auth/google', async (req, res) => {
    try {
      const { credential } = req.body;
      if (!credential) return res.status(400).json({ error: 'Missing credential' });

      const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
      if (!clientId) return res.status(500).json({ error: 'Google Sign-In is not configured' });

      const client = new OAuth2Client(clientId);
      let ticket;
      try {
        ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
      } catch (verifyErr) {
        console.error('Google token verification failed:', verifyErr.message);
        return res.status(401).json({ error: 'Invalid Google credential' });
      }

      const payload = ticket.getPayload();
      const googleId = payload.sub;
      const email = payload.email?.toLowerCase();
      const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
      const firstName = payload.given_name || '';
      const lastName = payload.family_name || '';

      if (!email) return res.status(400).json({ error: 'Google account has no email' });
      // Require Google to assert the email is verified. Without this, an
      // attacker with an unverified Google account bearing someone else's
      // address could be matched to — and take over — an existing account.
      if (!emailVerified) return res.status(401).json({ error: 'Your Google email address is not verified' });

      // 1. Lookup by google_id
      let existing = await pool.query(
        'SELECT id, email, first_name, last_name, phone, address_line1, address_line2, city, state, zip, password_set, created_via, google_id FROM customers WHERE google_id = $1',
        [googleId]
      );

      if (!existing.rows.length) {
        // 2. Lookup by email (safe: email ownership is proven by Google above)
        existing = await pool.query(
          'SELECT id, email, first_name, last_name, phone, address_line1, address_line2, city, state, zip, password_set, created_via, google_id FROM customers WHERE email = $1',
          [email]
        );
      }

      let customer;

      if (existing.rows.length) {
        customer = existing.rows[0];

        // Link google_id if not already set
        if (!customer.google_id) {
          await pool.query('UPDATE customers SET google_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [googleId, customer.id]);
        }

        // Rep-created account (password_set=false): claim it
        if (customer.password_set === false) {
          await pool.query(
            `UPDATE customers SET first_name = COALESCE(NULLIF($1, ''), first_name), last_name = COALESCE(NULLIF($2, ''), last_name),
             password_set = true, google_id = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4`,
            [firstName, lastName, googleId, customer.id]
          );
          // Re-fetch updated customer
          const updated = await pool.query(
            'SELECT id, email, first_name, last_name, phone, address_line1, address_line2, city, state, zip, password_set, created_via FROM customers WHERE id = $1',
            [customer.id]
          );
          customer = updated.rows[0];
        }
      } else {
        // 3. New user — create with placeholder password
        const placeholderHash = 'google_oauth_no_password';
        const placeholderSalt = 'google_oauth_no_password';
        const result = await pool.query(
          `INSERT INTO customers (email, password_hash, password_salt, first_name, last_name, password_set, created_via, google_id)
           VALUES ($1, $2, $3, $4, $5, false, 'google', $6)
           RETURNING id, email, first_name, last_name, phone, address_line1, address_line2, city, state, zip, password_set, created_via`,
          [email, placeholderHash, placeholderSalt, firstName, lastName, googleId]
        );
        customer = result.rows[0];
      }

      // Create session
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await pool.query('INSERT INTO customer_sessions (customer_id, token, expires_at) VALUES ($1, $2, $3)',
        [customer.id, hashToken(token), expiresAt]);

      // Non-staff actor: log under entity_type/entity_id, staff_id stays null.
      await logAudit(null, 'customer.login', 'customers', customer.id, { email: customer.email, via: 'google' }, req.ip);

      res.json({ token, customer });
    } catch (err) {
      console.error('Google auth error:', err);
      res.status(500).json({ error: 'Google sign-in failed' });
    }
  });

  // ==================== Wishlist Endpoints ====================

  router.get('/api/wishlist', customerAuth, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT product_id FROM wishlists WHERE customer_id = $1 ORDER BY created_at DESC',
        [req.customer.id]
      );
      res.json({ product_ids: result.rows.map(r => r.product_id) });
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/wishlist', customerAuth, async (req, res) => {
    try {
      const { product_id } = req.body;
      if (!product_id) return res.status(400).json({ error: 'product_id is required' });
      await pool.query(
        'INSERT INTO wishlists (customer_id, product_id) VALUES ($1, $2) ON CONFLICT (customer_id, product_id) DO NOTHING',
        [req.customer.id, product_id]
      );
      res.json({ success: true });
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/wishlist/:productId', customerAuth, async (req, res) => {
    try {
      await pool.query(
        'DELETE FROM wishlists WHERE customer_id = $1 AND product_id = $2',
        [req.customer.id, req.params.productId]
      );
      res.json({ success: true });
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/wishlist/sync', customerAuth, async (req, res) => {
    try {
      const { product_ids } = req.body;
      if (Array.isArray(product_ids)) {
        for (const pid of product_ids) {
          await pool.query(
            'INSERT INTO wishlists (customer_id, product_id) VALUES ($1, $2) ON CONFLICT (customer_id, product_id) DO NOTHING',
            [req.customer.id, pid]
          );
        }
      }
      const result = await pool.query(
        'SELECT product_id FROM wishlists WHERE customer_id = $1 ORDER BY created_at DESC',
        [req.customer.id]
      );
      res.json({ product_ids: result.rows.map(r => r.product_id) });
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ==================== Product Reviews ====================

  router.get('/api/storefront/products/:productId/reviews', async (req, res) => {
    try {
      const { productId } = req.params;
      const reviews = await pool.query(`
        SELECT pr.id, pr.rating, pr.title, pr.body, pr.created_at, c.first_name
        FROM product_reviews pr
        JOIN customers c ON c.id = pr.customer_id
        WHERE pr.product_id = $1
        ORDER BY pr.created_at DESC
      `, [productId]);
      const stats = await pool.query(`
        SELECT COALESCE(AVG(rating), 0) as average_rating, COUNT(*)::int as review_count
        FROM product_reviews WHERE product_id = $1
      `, [productId]);
      res.json({
        reviews: reviews.rows,
        average_rating: parseFloat(parseFloat(stats.rows[0].average_rating).toFixed(1)),
        review_count: stats.rows[0].review_count
      });
    } catch (err) {
      console.error('Get reviews error:', err);
      res.status(500).json({ error: 'Failed to fetch reviews' });
    }
  });

  router.post('/api/storefront/products/:productId/reviews', customerAuth, async (req, res) => {
    try {
      const { productId } = req.params;
      const { rating, title, body } = req.body;
      if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });
      const result = await pool.query(`
        INSERT INTO product_reviews (product_id, customer_id, rating, title, body)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (product_id, customer_id)
        DO UPDATE SET rating = EXCLUDED.rating, title = EXCLUDED.title, body = EXCLUDED.body, created_at = CURRENT_TIMESTAMP
        RETURNING id, rating, title, body, created_at
      `, [productId, req.customer.id, rating, title || null, body || null]);
      res.json({ review: { ...result.rows[0], first_name: req.customer.first_name } });
    } catch (err) {
      console.error('Submit review error:', err);
      res.status(500).json({ error: 'Failed to submit review' });
    }
  });

  // ==================== Stock Alerts ====================

  router.post('/api/storefront/stock-alerts', optionalCustomerAuth, async (req, res) => {
    try {
      const { sku_id, email } = req.body;
      if (!sku_id || !email) return res.status(400).json({ error: 'sku_id and email required' });
      const customerId = req.customer ? req.customer.id : null;
      await pool.query(`
        INSERT INTO stock_alerts (sku_id, email, customer_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (sku_id, email) DO UPDATE SET status = 'active', customer_id = COALESCE(EXCLUDED.customer_id, stock_alerts.customer_id)
      `, [sku_id, email, customerId]);
      res.json({ success: true });
    } catch (err) {
      console.error('Stock alert subscribe error:', err);
      res.status(500).json({ error: 'Failed to subscribe' });
    }
  });

  router.delete('/api/storefront/stock-alerts/:id', async (req, res) => {
    try {
      const { email } = req.query;
      if (!email) return res.status(400).json({ error: 'email is required' });
      const result = await pool.query("UPDATE stock_alerts SET status = 'cancelled' WHERE id = $1 AND email = $2 RETURNING id", [req.params.id, email]);
      if (!result.rows.length) return res.status(404).json({ error: 'Alert not found' });
      res.json({ success: true });
    } catch (err) {
      console.error('Stock alert cancel error:', err);
      res.status(500).json({ error: 'Failed to cancel alert' });
    }
  });

  router.get('/api/storefront/stock-alerts/check', optionalCustomerAuth, async (req, res) => {
    try {
      const { sku_id, email } = req.query;
      if (!sku_id || !email) return res.json({ subscribed: false });
      const result = await pool.query(
        "SELECT id FROM stock_alerts WHERE sku_id = $1 AND email = $2 AND status = 'active'",
        [sku_id, email]
      );
      res.json({ subscribed: result.rows.length > 0, alert_id: result.rows[0]?.id });
    } catch (err) {
      console.error('Stock alert check error:', err);
      res.status(500).json({ error: 'Failed to check alert' });
    }
  });

  router.get('/api/customer/orders', customerAuth, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT o.id, o.order_number, o.customer_name, o.customer_email, o.status, o.subtotal, o.shipping, o.total, o.amount_paid,
          o.delivery_method, o.shipping_method, o.tracking_number, o.shipping_carrier, o.shipped_at, o.created_at,
          (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) as item_count,
          (SELECT json_agg(t) FROM (
            SELECT oi.product_name,
              (SELECT url FROM media_assets ma WHERE ma.product_id = oi.product_id AND ma.asset_type = 'primary' ORDER BY ma.sort_order LIMIT 1) as primary_image
            FROM order_items oi WHERE oi.order_id = o.id
            ORDER BY COALESCE(oi.is_sample, false), oi.subtotal DESC NULLS LAST
            LIMIT 5
          ) t) as items_preview
         FROM orders o WHERE o.customer_id = $1 ORDER BY o.created_at DESC`,
        [req.customer.id]
      );
      res.json({ orders: result.rows });
    } catch (err) {
      console.error('Customer orders error:', err);
      res.status(500).json({ error: 'Failed to fetch orders' });
    }
  });

  router.get('/api/customer/orders/:id', customerAuth, async (req, res) => {
    try {
      const orderResult = await pool.query(
        `SELECT id, order_number, customer_email, customer_name, phone,
          shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip,
          delivery_method, subtotal, shipping, shipping_method, sample_shipping, total, amount_paid,
          status, tracking_number, shipping_carrier, shipped_at, delivered_at, created_at,
          promo_code, discount_amount
        FROM orders WHERE id = $1 AND customer_id = $2`,
        [req.params.id, req.customer.id]
      );
      if (!orderResult.rows.length) {
        return res.status(404).json({ error: 'Order not found' });
      }
      const itemsResult = await pool.query(`
        SELECT oi.*,
          poi.status as fulfillment_status
        FROM order_items oi
        LEFT JOIN LATERAL (
          SELECT status FROM purchase_order_items
          WHERE order_item_id = oi.id AND status != 'cancelled'
          ORDER BY CASE status
            WHEN 'received' THEN 4
            WHEN 'shipped' THEN 3
            WHEN 'ordered' THEN 2
            WHEN 'pending' THEN 1
            ELSE 0
          END DESC
          LIMIT 1
        ) poi ON true
        WHERE oi.order_id = $1
      `, [req.params.id]);
      const items = itemsResult.rows;
      const balanceInfo = await recalculateBalance(req.params.id);
      const totalItems = items.filter(i => !i.is_sample).length;
      const receivedItems = items.filter(i => !i.is_sample && i.fulfillment_status === 'received').length;
      res.json({ order: orderResult.rows[0], items, balance: balanceInfo, fulfillment_summary: { total: totalItems, received: receivedItems } });
    } catch (err) {
      console.error('Customer order detail error:', err);
      res.status(500).json({ error: 'Failed to fetch order' });
    }
  });

  // ==================== Customer Sample Requests ====================

  router.get('/api/customer/sample-requests', customerAuth, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT sr.*, json_agg(json_build_object(
            'id', sri.id, 'product_id', sri.product_id, 'sku_id', sri.sku_id,
            'product_name', sri.product_name, 'collection', sri.collection,
            'variant_name', sri.variant_name, 'primary_image', sri.primary_image,
            'status', sri.status, 'sort_order', sri.sort_order
          ) ORDER BY sri.sort_order) AS items
         FROM sample_requests sr
         LEFT JOIN sample_request_items sri ON sri.sample_request_id = sr.id
         WHERE sr.customer_id = $1
         GROUP BY sr.id
         ORDER BY sr.created_at DESC`,
        [req.customer.id]
      );
      // Clean up null items (from LEFT JOIN with no items)
      const requests = result.rows.map(r => ({
        ...r,
        items: r.items && r.items[0] && r.items[0].id ? r.items : []
      }));
      res.json({ sample_requests: requests });
    } catch (err) {
      console.error('Customer sample requests error:', err);
      res.status(500).json({ error: 'Failed to fetch sample requests' });
    }
  });

  router.post('/api/customer/sample-requests/:id/add-items', customerAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const { items } = req.body;
      if (!items || !items.length) {
        return res.status(400).json({ error: 'At least one item is required' });
      }

      const srRes = await client.query(
        'SELECT * FROM sample_requests WHERE id = $1 AND customer_id = $2',
        [req.params.id, req.customer.id]
      );
      if (!srRes.rows.length) {
        return res.status(404).json({ error: 'Sample request not found' });
      }
      const sr = srRes.rows[0];
      if (sr.status !== 'requested') {
        return res.status(400).json({ error: 'Can only add items to open sample requests' });
      }

      // Check current item count
      const countRes = await client.query(
        'SELECT COUNT(*)::int as cnt FROM sample_request_items WHERE sample_request_id = $1',
        [sr.id]
      );
      const currentCount = countRes.rows[0].cnt;
      if (currentCount + items.length > 5) {
        return res.status(400).json({ error: `Maximum 5 items per sample request (currently ${currentCount})` });
      }

      await client.query('BEGIN');

      const addedItems = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        let productName = 'Unknown';
        let collection = null;
        let variantName = null;
        let primaryImage = null;
        let productId = item.product_id || null;
        let skuId = item.sku_id || null;

        if (item.sku_id) {
          const sRes = await client.query(`
            SELECT s.variant_name, s.product_id,
              COALESCE(p.display_name, p.name) as product_name, p.collection,
              (SELECT url FROM media_assets WHERE product_id = p.id AND asset_type = 'primary' ORDER BY sort_order LIMIT 1) as primary_image
            FROM skus s
            JOIN products p ON p.id = s.product_id
            WHERE s.id = $1
          `, [item.sku_id]);
          if (sRes.rows.length) {
            const s = sRes.rows[0];
            productId = s.product_id;
            productName = s.product_name;
            collection = s.collection;
            variantName = s.variant_name;
            primaryImage = s.primary_image;
          }
        } else if (item.product_id) {
          const pRes = await client.query(`
            SELECT p.name, p.collection,
              (SELECT url FROM media_assets WHERE product_id = p.id AND asset_type = 'primary' ORDER BY sort_order LIMIT 1) as primary_image
            FROM products p WHERE p.id = $1
          `, [item.product_id]);
          if (pRes.rows.length) {
            productName = pRes.rows[0].name;
            collection = pRes.rows[0].collection;
            primaryImage = pRes.rows[0].primary_image;
          }
        }

        const itemRes = await client.query(`
          INSERT INTO sample_request_items (sample_request_id, product_id, sku_id, product_name, collection, variant_name, primary_image, sort_order)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
        `, [sr.id, productId, skuId, productName, collection, variantName, primaryImage, currentCount + i]);
        addedItems.push(itemRes.rows[0]);
      }

      await client.query('COMMIT');
      res.json({ items: addedItems });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Add sample items error:', err);
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  // Customer sample request PDF
  router.get('/api/customer/sample-requests/:id/pdf', customerAuth, async (req, res) => {
    try {
      const sr = await pool.query('SELECT * FROM sample_requests WHERE id = $1 AND customer_id = $2', [req.params.id, req.customer.id]);
      if (!sr.rows.length) return res.status(404).json({ error: 'Sample request not found' });
      const result = await generateSampleRequestConfirmationHtml(req.params.id);
      if (!result) return res.status(404).json({ error: 'Sample request not found' });
      await generatePDF(result.html, result.filename, req, res);
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ==================== Customer Quotes & Visits ====================

  router.get('/api/customer/quotes', customerAuth, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT q.*, (SELECT COUNT(*)::int FROM quote_items qi WHERE qi.quote_id = q.id) as item_count
        FROM quotes q WHERE q.customer_id = $1 AND q.status != 'draft'
        ORDER BY q.created_at DESC
      `, [req.customer.id]);
      res.json({ quotes: result.rows });
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/customer/quotes/:id', customerAuth, async (req, res) => {
    try {
      const quote = await pool.query('SELECT * FROM quotes WHERE id = $1 AND customer_id = $2 AND status != \'draft\'', [req.params.id, req.customer.id]);
      if (!quote.rows.length) return res.status(404).json({ error: 'Quote not found' });
      const items = await pool.query(`
        SELECT qi.*, v.name as vendor_name, s.vendor_sku, s.variant_name, sa_c.value as color, p.collection as current_collection
        FROM quote_items qi
        LEFT JOIN skus s ON s.id = qi.sku_id
        LEFT JOIN products p ON p.id = COALESCE(s.product_id, qi.product_id)
        LEFT JOIN vendors v ON v.id = p.vendor_id
        LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = qi.sku_id
          AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
        WHERE qi.quote_id = $1 ORDER BY qi.id
      `, [req.params.id]);
      res.json({ quote: quote.rows[0], items: items.rows });
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Branded quote PDF — same shared document as the rep and trade endpoints
  router.get('/api/customer/quotes/:id/pdf', customerAuth, async (req, res) => {
    try {
      const quote = await pool.query(`
        SELECT q.*, sr.first_name || ' ' || sr.last_name as rep_name, sr.email as rep_email
        FROM quotes q LEFT JOIN sales_reps sr ON sr.id = q.sales_rep_id
        WHERE q.id = $1 AND q.customer_id = $2 AND q.status != 'draft'
      `, [req.params.id, req.customer.id]);
      if (!quote.rows.length) return res.status(404).json({ error: 'Quote not found' });
      const q = quote.rows[0];
      const items = await pool.query(`
        SELECT qi.*, sk.variant_name, sa_c.value as color, v.name as vendor_name, sk.vendor_sku,
          (SELECT ma.url FROM media_assets ma WHERE ma.product_id = p.id AND ma.asset_type = 'primary'
           ORDER BY CASE WHEN ma.sku_id = qi.sku_id THEN 0 WHEN ma.sku_id IS NULL THEN 1 ELSE 2 END, ma.sort_order LIMIT 1) as primary_image
        FROM quote_items qi
        LEFT JOIN skus sk ON sk.id = qi.sku_id
        LEFT JOIN products p ON p.id = COALESCE(sk.product_id, qi.product_id)
        LEFT JOIN vendors v ON v.id = p.vendor_id
        LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = qi.sku_id
          AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
        WHERE qi.quote_id = $1 ORDER BY qi.id
      `, [req.params.id]);
      const html = generateQuoteHtml(q, items.rows);
      await generatePDF(html, `quote-${q.quote_number || q.id.substring(0, 8)}.pdf`, req, res);
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/customer/visits', customerAuth, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT sv.*, (SELECT COUNT(*)::int FROM showroom_visit_items WHERE visit_id = sv.id) as item_count
        FROM showroom_visits sv WHERE sv.customer_id = $1 AND sv.status IN ('sent', 'opened', 'carted')
        ORDER BY sv.created_at DESC
      `, [req.customer.id]);
      res.json({ visits: result.rows });
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/customer/visits/:id', customerAuth, async (req, res) => {
    try {
      const visit = await pool.query("SELECT * FROM showroom_visits WHERE id = $1 AND customer_id = $2 AND status IN ('sent', 'opened', 'carted')", [req.params.id, req.customer.id]);
      if (!visit.rows.length) return res.status(404).json({ error: 'Visit not found' });
      const items = await pool.query('SELECT * FROM showroom_visit_items WHERE visit_id = $1 ORDER BY sort_order, id', [req.params.id]);
      res.json({ visit: visit.rows[0], items: items.rows });
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ==================== Customer Estimates ====================
  // Rep-entered estimates, visible once sent (drafts stay internal).
  // internal_notes is deliberately excluded.

  router.get('/api/customer/estimates', customerAuth, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT e.id, e.estimate_number, e.customer_name, e.project_name,
          e.project_address_line1, e.project_city, e.project_state,
          e.materials_subtotal, e.labor_subtotal, e.subtotal, e.tax_amount, e.total,
          e.notes, e.status, e.expires_at, e.sent_at, e.created_at,
          (SELECT COUNT(*)::int FROM estimate_items ei WHERE ei.estimate_id = e.id) as item_count,
          sr.first_name || ' ' || sr.last_name as rep_name
        FROM estimates e
        LEFT JOIN sales_reps sr ON sr.id = e.sales_rep_id
        WHERE e.customer_id = $1 AND e.status != 'draft'
        ORDER BY e.created_at DESC
      `, [req.customer.id]);
      res.json({ estimates: result.rows });
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/customer/estimates/:id', customerAuth, async (req, res) => {
    try {
      const est = await pool.query(`
        SELECT e.id, e.estimate_number, e.customer_name, e.customer_email, e.phone, e.project_name,
          e.project_address_line1, e.project_address_line2, e.project_city, e.project_state, e.project_zip,
          e.materials_subtotal, e.labor_subtotal, e.subtotal, e.tax_rate, e.tax_amount, e.total,
          e.notes, e.status, e.expires_at, e.sent_at, e.created_at,
          sr.first_name || ' ' || sr.last_name as rep_name
        FROM estimates e
        LEFT JOIN sales_reps sr ON sr.id = e.sales_rep_id
        WHERE e.id = $1 AND e.customer_id = $2 AND e.status != 'draft'
      `, [req.params.id, req.customer.id]);
      if (!est.rows.length) return res.status(404).json({ error: 'Estimate not found' });
      const items = await pool.query(
        'SELECT * FROM estimate_items WHERE estimate_id = $1 ORDER BY sort_order, created_at',
        [req.params.id]
      );
      res.json({ estimate: est.rows[0], items: items.rows });
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
