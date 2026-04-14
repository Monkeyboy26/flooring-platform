import { Router } from 'express';

export default function createCartRoutes(ctx) {
  const router = Router();
  const { pool, calculateSalesTax, isPickupOnly } = ctx;

  router.get('/api/cart', async (req, res) => {
    try {
      const { session_id } = req.query;
      if (!session_id) return res.status(400).json({ error: 'session_id is required' });

      const result = await pool.query(`
        SELECT ci.*, COALESCE(p.display_name, p.name) as product_name, p.collection,
          s.sell_by, s.variant_type, s.vendor_sku, s.variant_name, c.slug as category_slug,
          pr.cut_price, pr.roll_price, pr.roll_min_sqft,
          COALESCE(v.has_public_inventory, false) as vendor_has_inventory,
          CASE
            WHEN inv.fresh_until IS NULL OR inv.fresh_until <= NOW() THEN 'unknown'
            WHEN inv.qty_on_hand > 10 THEN 'in_stock'
            WHEN inv.qty_on_hand > 0 THEN 'low_stock'
            ELSE 'out_of_stock'
          END as stock_status
        FROM cart_items ci
        LEFT JOIN products p ON p.id = ci.product_id
        LEFT JOIN skus s ON s.id = ci.sku_id
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN pricing pr ON pr.sku_id = ci.sku_id
        LEFT JOIN vendors v ON v.id = p.vendor_id
        LEFT JOIN inventory_snapshots inv ON inv.sku_id = ci.sku_id AND inv.warehouse = 'default'
        WHERE ci.session_id = $1
        ORDER BY ci.created_at
      `, [session_id]);
      const cart = result.rows.map(item => ({
        ...item,
        pickup_only: !item.is_sample && isPickupOnly(item)
      }));
      res.json({ cart });
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/cart', async (req, res) => {
    try {
      const { session_id, product_id, sku_id, sqft_needed, num_boxes, include_overage, unit_price, subtotal, is_sample, sell_by, price_tier } = req.body;
      if (!session_id || !num_boxes) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      if (!is_sample && (!unit_price || !subtotal)) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Sample-specific validation
      if (is_sample) {
        // Check sample limit (max 5 per session)
        const countResult = await pool.query(
          'SELECT COUNT(*) FROM cart_items WHERE session_id = $1 AND is_sample = true',
          [session_id]
        );
        if (parseInt(countResult.rows[0].count) >= 5) {
          return res.status(400).json({ error: 'Sample limit reached (max 5)' });
        }

        // Check for duplicate product sample
        if (product_id) {
          const dupResult = await pool.query(
            'SELECT id FROM cart_items WHERE session_id = $1 AND product_id = $2 AND is_sample = true',
            [session_id, product_id]
          );
          if (dupResult.rows.length > 0) {
            return res.status(400).json({ error: 'You already have a sample of this product in your cart' });
          }
        }
      }

      // Server-side price validation: override client price with DB price
      let validatedUnitPrice = unit_price || 0;
      let validatedSubtotal = subtotal || 0;
      if (!is_sample && sku_id) {
        const dbPrice = await pool.query(
          `SELECT pr.retail_price, pr.price_basis, pk.sqft_per_box, pk.pieces_per_box
           FROM pricing pr
           LEFT JOIN packaging pk ON pk.sku_id = pr.sku_id
           WHERE pr.sku_id = $1`, [sku_id]);
        if (dbPrice.rows.length) {
          let dbRetail = parseFloat(dbPrice.rows[0].retail_price);
          const priceBasis = dbPrice.rows[0].price_basis;
          const sqftBox = parseFloat(dbPrice.rows[0].sqft_per_box) || 0;
          const pcsBox = parseFloat(dbPrice.rows[0].pieces_per_box) || 0;
          // Convert per-unit price to per-sqft when sell_by is sqft
          if (sell_by === 'sqft' && priceBasis === 'per_unit' && sqftBox > 0 && pcsBox > 0) {
            dbRetail = dbRetail / (sqftBox / pcsBox);
          }
          // Convert per-sqft price to per-unit when sell_by is unit
          if (sell_by === 'unit' && (priceBasis === 'per_sqft' || priceBasis === 'sqft') && sqftBox > 0) {
            dbRetail = dbRetail * sqftBox;
          }
          if (Math.abs(parseFloat(validatedUnitPrice) - dbRetail) > 0.01) {
            validatedUnitPrice = dbRetail;
            if (sell_by === 'sqft' && sqft_needed) {
              validatedSubtotal = parseFloat((dbRetail * parseFloat(sqft_needed)).toFixed(2));
            } else {
              validatedSubtotal = parseFloat((dbRetail * num_boxes).toFixed(2));
            }
          }
        }
      }

      const result = await pool.query(`
        INSERT INTO cart_items (session_id, product_id, sku_id, sqft_needed, num_boxes, include_overage, unit_price, subtotal, is_sample, sell_by, price_tier)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
      `, [session_id, product_id || null, sku_id || null, sqft_needed || null, num_boxes, include_overage || false, validatedUnitPrice, validatedSubtotal, is_sample || false, sell_by || null, price_tier || null]);

      // Return with product info
      const item = result.rows[0];
      if (item.product_id) {
        const prod = await pool.query('SELECT name, collection FROM products WHERE id = $1', [item.product_id]);
        if (prod.rows.length) {
          item.product_name = prod.rows[0].name;
          item.collection = prod.rows[0].collection;
        }
      }
      res.json({ item });
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/cart/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { session_id, num_boxes, sqft_needed, subtotal, unit_price, price_tier } = req.body;
      if (!session_id) return res.status(400).json({ error: 'session_id is required' });

      // Server-side price validation
      let validatedUnitPrice = unit_price;
      let validatedSubtotal = subtotal;
      if (unit_price != null || subtotal != null) {
        const existing = await pool.query('SELECT sku_id, sell_by FROM cart_items WHERE id = $1 AND session_id = $2', [id, session_id]);
        if (existing.rows.length && existing.rows[0].sku_id) {
          const dbPrice = await pool.query(
            `SELECT pr.retail_price, pr.price_basis, pk.sqft_per_box, pk.pieces_per_box
             FROM pricing pr
             LEFT JOIN packaging pk ON pk.sku_id = pr.sku_id
             WHERE pr.sku_id = $1`, [existing.rows[0].sku_id]);
          if (dbPrice.rows.length) {
            let dbRetail = parseFloat(dbPrice.rows[0].retail_price);
            const priceBasis = dbPrice.rows[0].price_basis;
            const sqftBox = parseFloat(dbPrice.rows[0].sqft_per_box) || 0;
            const pcsBox = parseFloat(dbPrice.rows[0].pieces_per_box) || 0;
            const itemSellBy = existing.rows[0].sell_by;
            if (itemSellBy === 'sqft' && priceBasis === 'per_unit' && sqftBox > 0 && pcsBox > 0) {
              dbRetail = dbRetail / (sqftBox / pcsBox);
            }
            if (itemSellBy === 'unit' && (priceBasis === 'per_sqft' || priceBasis === 'sqft') && sqftBox > 0) {
              dbRetail = dbRetail * sqftBox;
            }
            if (unit_price != null && Math.abs(parseFloat(unit_price) - dbRetail) > 0.01) {
              validatedUnitPrice = dbRetail;
              if (num_boxes && itemSellBy === 'sqft' && sqft_needed) {
                validatedSubtotal = parseFloat((dbRetail * parseFloat(sqft_needed)).toFixed(2));
              } else if (num_boxes) {
                validatedSubtotal = parseFloat((dbRetail * num_boxes).toFixed(2));
              }
            }
          }
        }
      }

      const result = await pool.query(`
        UPDATE cart_items
        SET num_boxes = COALESCE($1, num_boxes),
            sqft_needed = COALESCE($2, sqft_needed),
            subtotal = COALESCE($3, subtotal),
            unit_price = COALESCE($4, unit_price),
            price_tier = COALESCE($5, price_tier),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $6 AND session_id = $7
        RETURNING *
      `, [num_boxes, sqft_needed, validatedSubtotal, validatedUnitPrice, price_tier, id, session_id]);

      if (!result.rows.length) return res.status(404).json({ error: 'Cart item not found' });

      const item = result.rows[0];
      if (item.product_id) {
        const prod = await pool.query('SELECT name, collection FROM products WHERE id = $1', [item.product_id]);
        if (prod.rows.length) {
          item.product_name = prod.rows[0].name;
          item.collection = prod.rows[0].collection;
        }
      }
      res.json({ item });
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/cart/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { session_id } = req.query;
      if (!session_id) return res.status(400).json({ error: 'session_id is required' });
      const result = await pool.query('DELETE FROM cart_items WHERE id = $1 AND session_id = $2 RETURNING id', [id, session_id]);
      if (!result.rows.length) return res.status(404).json({ error: 'Cart item not found' });
      res.json({ deleted: id });
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Tax estimate for checkout
  router.get('/api/cart/tax-estimate', async (req, res) => {
    try {
      const { zip, session_id } = req.query;
      if (!session_id) return res.status(400).json({ error: 'session_id is required' });

      const result = await pool.query(
        `SELECT COALESCE(SUM(subtotal), 0) as subtotal FROM cart_items WHERE session_id = $1 AND is_sample = false`,
        [session_id]
      );
      const subtotal = parseFloat(result.rows[0].subtotal) || 0;
      const { rate, amount } = calculateSalesTax(subtotal, zip, false);
      res.json({ rate, amount, subtotal });
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
