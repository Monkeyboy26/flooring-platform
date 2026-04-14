import crypto from 'crypto';

export function createAuthMiddleware(pool) {
  function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return { hash, salt };
  }

  function verifyPassword(password, hash, salt) {
    const derived = crypto.scryptSync(password, salt, 64);
    const stored = Buffer.from(hash, 'hex');
    return crypto.timingSafeEqual(derived, stored);
  }

  function validatePassword(password) {
    if (!password || password.length < 8) return 'Password must be at least 8 characters';
    if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
    if (!/[0-9]/.test(password)) return 'Password must contain at least one number';
    return null;
  }

  async function repAuth(req, res, next) {
    const token = req.headers['x-rep-token'];
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    try {
      const result = await pool.query(`
        SELECT rs.id as session_id, sr.id, sr.email, sr.first_name, sr.last_name, sr.is_active
        FROM rep_sessions rs
        JOIN sales_reps sr ON sr.id = rs.rep_id
        WHERE rs.token = $1 AND rs.expires_at > CURRENT_TIMESTAMP
      `, [token]);

      if (!result.rows.length) return res.status(401).json({ error: 'Invalid or expired session' });
      if (!result.rows[0].is_active) return res.status(403).json({ error: 'Account deactivated' });

      req.rep = {
        id: result.rows[0].id,
        email: result.rows[0].email,
        first_name: result.rows[0].first_name,
        last_name: result.rows[0].last_name
      };
      next();
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  }

  async function tradeAuth(req, res, next) {
    const token = req.headers['x-trade-token'];
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    try {
      const result = await pool.query(`
        SELECT ts.id as session_id, tc.id, tc.email, tc.company_name, tc.contact_name, tc.status,
          mt.name as tier_name, mt.discount_percent
        FROM trade_sessions ts
        JOIN trade_customers tc ON tc.id = ts.trade_customer_id
        LEFT JOIN margin_tiers mt ON mt.id = tc.margin_tier_id
        WHERE ts.token = $1 AND ts.expires_at > CURRENT_TIMESTAMP
      `, [token]);

      if (!result.rows.length) return res.status(401).json({ error: 'Invalid or expired session' });
      if (result.rows[0].status !== 'approved') return res.status(403).json({ error: 'Account not approved' });

      req.tradeCustomer = {
        id: result.rows[0].id,
        email: result.rows[0].email,
        company_name: result.rows[0].company_name,
        contact_name: result.rows[0].contact_name,
        tier_name: result.rows[0].tier_name,
        discount_percent: parseFloat(result.rows[0].discount_percent) || 0
      };
      next();
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  }

  async function optionalTradeAuth(req, res, next) {
    const token = req.headers['x-trade-token'];
    if (!token) {
      req.tradeCustomer = null;
      return next();
    }

    try {
      const result = await pool.query(`
        SELECT ts.id as session_id, tc.id, tc.email, tc.company_name, tc.contact_name, tc.status,
          mt.name as tier_name, mt.discount_percent
        FROM trade_sessions ts
        JOIN trade_customers tc ON tc.id = ts.trade_customer_id
        LEFT JOIN margin_tiers mt ON mt.id = tc.margin_tier_id
        WHERE ts.token = $1 AND ts.expires_at > CURRENT_TIMESTAMP
      `, [token]);

      if (result.rows.length && result.rows[0].status === 'approved') {
        req.tradeCustomer = {
          id: result.rows[0].id,
          email: result.rows[0].email,
          company_name: result.rows[0].company_name,
          contact_name: result.rows[0].contact_name,
          tier_name: result.rows[0].tier_name,
          discount_percent: parseFloat(result.rows[0].discount_percent) || 0
        };
      } else {
        req.tradeCustomer = null;
      }
      next();
    } catch (err) {
      req.tradeCustomer = null;
      next();
    }
  }

  async function customerAuth(req, res, next) {
    const token = req.headers['x-customer-token'];
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    try {
      const result = await pool.query(`
        SELECT cs.id as session_id, c.id, c.email, c.first_name, c.last_name, c.phone,
          c.address_line1, c.address_line2, c.city, c.state, c.zip
        FROM customer_sessions cs
        JOIN customers c ON c.id = cs.customer_id
        WHERE cs.token = $1 AND cs.expires_at > CURRENT_TIMESTAMP
      `, [token]);

      if (!result.rows.length) return res.status(401).json({ error: 'Invalid or expired session' });

      req.customer = result.rows[0];
      next();
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  }

  async function optionalCustomerAuth(req, res, next) {
    const token = req.headers['x-customer-token'];
    if (!token) {
      req.customer = null;
      return next();
    }

    try {
      const result = await pool.query(`
        SELECT cs.id as session_id, c.id, c.email, c.first_name, c.last_name, c.phone,
          c.address_line1, c.address_line2, c.city, c.state, c.zip
        FROM customer_sessions cs
        JOIN customers c ON c.id = cs.customer_id
        WHERE cs.token = $1 AND cs.expires_at > CURRENT_TIMESTAMP
      `, [token]);

      if (result.rows.length) {
        req.customer = result.rows[0];
      } else {
        req.customer = null;
      }
      next();
    } catch (err) {
      req.customer = null;
      next();
    }
  }

  async function staffAuth(req, res, next) {
    const token = req.headers['x-staff-token'];
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    try {
      const result = await pool.query(`
        SELECT ss.id as session_id, sa.id, sa.email, sa.first_name, sa.last_name, sa.role, sa.is_active
        FROM staff_sessions ss
        JOIN staff_accounts sa ON sa.id = ss.staff_id
        WHERE ss.token = $1 AND ss.expires_at > CURRENT_TIMESTAMP
      `, [token]);

      if (!result.rows.length) return res.status(401).json({ error: 'Invalid or expired session' });
      if (!result.rows[0].is_active) return res.status(403).json({ error: 'Account deactivated' });

      req.staff = {
        id: result.rows[0].id,
        email: result.rows[0].email,
        first_name: result.rows[0].first_name,
        last_name: result.rows[0].last_name,
        role: result.rows[0].role
      };
      next();
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  }

  function requireRole(...roles) {
    return (req, res, next) => {
      if (!req.staff) return res.status(401).json({ error: 'Authentication required' });
      if (!roles.includes(req.staff.role)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      next();
    };
  }

  async function logAudit(staffId, action, entityType, entityId, details, ipAddress) {
    try {
      await pool.query(
        'INSERT INTO audit_log (staff_id, action, entity_type, entity_id, details, ip_address) VALUES ($1, $2, $3, $4, $5, $6)',
        [staffId, action, entityType || null, entityId || null, JSON.stringify(details || {}), ipAddress || null]
      );
    } catch (err) {
      console.error('Audit log error:', err.message);
    }
  }

  return {
    hashPassword, verifyPassword, validatePassword,
    staffAuth, repAuth, tradeAuth, optionalTradeAuth,
    customerAuth, optionalCustomerAuth, requireRole, logAudit
  };
}
