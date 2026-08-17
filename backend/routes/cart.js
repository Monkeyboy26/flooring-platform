import { Router } from 'express';
import { isTradeTaxExempt } from '../lib/helpers.js';
import { computeRugQuote } from '../lib/rugPricing.js';

export default function createCartRoutes(ctx) {
  const router = Router();
  const { pool, calculateSalesTax, isPickupOnly, optionalTradeAuth } = ctx;

  // Server-authoritative price for a custom bound area rug: recompute from the
  // finished dimensions + the carpet SKU's own cut_price (never trust the client
  // price). Returns { perRug, quote } or null if the SKU isn't priced/oversized.
  async function priceCustomRug(sku_id, widthFt, lengthFt) {
    const r = await pool.query(
      `SELECT pr.cut_price, pk.roll_width_ft
         FROM pricing pr
         LEFT JOIN packaging pk ON pk.sku_id = pr.sku_id
        WHERE pr.sku_id = $1`, [sku_id]);
    if (!r.rows.length || r.rows[0].cut_price == null) return null;
    const quote = computeRugQuote({
      widthFt, lengthFt,
      rollWidthFt: r.rows[0].roll_width_ft,
      cutPricePerSqyd: r.rows[0].cut_price,
    });
    if (!quote.valid) return { quote };
    return { perRug: quote.perRug, quote };
  }

  // Shared enrichment select so a cart row resolves its display name identically
  // on GET, POST (add) and PUT (update). Crucially it derives product_name/
  // collection/color via the SKU's own product_id — accessories are added by
  // sku_id only (no product_id in the payload), so a product_id-gated lookup
  // would leave them nameless and the UI would render the "Product" fallback
  // (see [[line-item-display]]). `$1` binds the WHERE target.
  const cartRowQuery = (where) => `
    SELECT ci.*, COALESCE(p.display_name, p.name) as product_name, p.collection,
      CASE WHEN ci.is_custom_rug THEN 'unit' ELSE s.sell_by END as sell_by,
      s.variant_type, s.vendor_sku, s.internal_sku, s.variant_name, s.accessory_label, c.name as category_name, c.slug as category_slug,
      v.name as vendor_name, COALESCE(br.name, v.name) as brand_name, COALESCE(br.hide_public_name, v.hide_public_name, false) AS brand_hidden, sa_c.value as color, sa_sz.value as size,
      pr.cut_price, pr.roll_price, pr.roll_min_sqft,
      COALESCE(ma_sku.url, ma_prod.url) as primary_image,
      COALESCE(v.has_public_inventory, false) as vendor_has_inventory,
      CASE
        WHEN inv.fresh_until IS NULL OR inv.fresh_until <= NOW() THEN 'unknown'
        WHEN inv.qty_on_hand > 10 THEN 'in_stock'
        WHEN inv.qty_on_hand > 0 THEN 'low_stock'
        ELSE 'out_of_stock'
      END as stock_status
    FROM cart_items ci
    LEFT JOIN skus s ON s.id = ci.sku_id
    LEFT JOIN products p ON p.id = COALESCE(s.product_id, ci.product_id)
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN pricing pr ON pr.sku_id = ci.sku_id
    LEFT JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN brands br ON br.id = p.brand_id
    LEFT JOIN inventory_snapshots inv ON inv.sku_id = ci.sku_id AND inv.warehouse = 'default'
    LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = ci.sku_id
      AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
    LEFT JOIN sku_attributes sa_sz ON sa_sz.sku_id = ci.sku_id
      AND sa_sz.attribute_id = (SELECT id FROM attributes WHERE slug = 'size' LIMIT 1)
    LEFT JOIN media_assets ma_sku ON ma_sku.sku_id = ci.sku_id AND ma_sku.asset_type = 'primary'
    LEFT JOIN media_assets ma_prod ON ma_prod.product_id = COALESCE(s.product_id, ci.product_id) AND ma_prod.asset_type = 'primary' AND ma_sku.id IS NULL
    ${where}
  `;

  // Re-fetch a single enriched cart row (used by POST/PUT so their response body
  // matches what GET would return for the same row).
  async function fetchCartRow(id) {
    const r = await pool.query(cartRowQuery('WHERE ci.id = $1'), [id]);
    if (!r.rows.length) return null;
    const item = r.rows[0];
    return { ...item, pickup_only: !item.is_sample && isPickupOnly(item) };
  }

  router.get('/api/cart', async (req, res) => {
    try {
      const { session_id } = req.query;
      if (!session_id) return res.status(400).json({ error: 'session_id is required' });

      const result = await pool.query(cartRowQuery('WHERE ci.session_id = $1 ORDER BY ci.created_at'), [session_id]);
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
      const { session_id, product_id, sku_id, sqft_needed, num_boxes, include_overage, unit_price, subtotal, is_sample, sell_by, price_tier, parent_collection, parent_color, is_custom_rug, custom_width_ft, custom_length_ft } = req.body;
      if (!session_id || !num_boxes) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      if (!is_sample && !is_custom_rug && (!unit_price || !subtotal)) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Custom bound area rug: price is computed server-side from the finished
      // dimensions + the SKU's cut_price. Skips the standard SKU price-validation
      // and out-of-stock gate (a rug is made-to-order, cut from the roll).
      if (is_custom_rug) {
        if (!sku_id) return res.status(400).json({ error: 'A carpet is required for a custom rug' });
        const priced = await priceCustomRug(sku_id, custom_width_ft, custom_length_ft);
        if (!priced) {
          return res.status(400).json({ error: 'This carpet is not available for custom rugs. Please call (714) 999-0009.' });
        }
        if (priced.quote.oversized) {
          return res.status(400).json({ error: 'Both sides exceed the roll width — call (714) 999-0009 for oversized rugs.' });
        }
        if (!priced.perRug) {
          return res.status(400).json({ error: 'Please enter valid rug dimensions.' });
        }
        const qty = Math.max(1, parseInt(num_boxes) || 1);
        const rugInsert = await pool.query(`
          INSERT INTO cart_items (session_id, product_id, sku_id, num_boxes, unit_price, subtotal, sell_by, is_custom_rug, custom_width_ft, custom_length_ft)
          VALUES ($1, $2, $3, $4, $5, $6, 'unit', true, $7, $8)
          RETURNING *
        `, [session_id, product_id || null, sku_id, qty, priced.perRug.toFixed(2), (priced.perRug * qty).toFixed(2), custom_width_ft, custom_length_ft]);
        const rugRow = await fetchCartRow(rugInsert.rows[0].id) || rugInsert.rows[0];
        return res.json({ item: rugRow });
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

      // Block out-of-stock items (skip for samples)
      if (!is_sample && sku_id) {
        const stockCheck = await pool.query(`
          SELECT
            COALESCE(v.has_public_inventory, false) as vendor_has_inventory,
            CASE
              WHEN inv.fresh_until IS NULL OR inv.fresh_until <= NOW() THEN 'unknown'
              WHEN inv.qty_on_hand > 10 THEN 'in_stock'
              WHEN inv.qty_on_hand > 0 THEN 'low_stock'
              ELSE 'out_of_stock'
            END as stock_status
          FROM skus s
          JOIN products p ON p.id = s.product_id
          LEFT JOIN vendors v ON v.id = p.vendor_id
          LEFT JOIN inventory_snapshots inv ON inv.sku_id = s.id AND inv.warehouse = 'default'
          WHERE s.id = $1
        `, [sku_id]);
        if (stockCheck.rows.length) {
          const { stock_status, vendor_has_inventory } = stockCheck.rows[0];
          if (stock_status === 'out_of_stock' && vendor_has_inventory) {
            return res.status(400).json({ error: 'This item is currently out of stock.' });
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
        if (!dbPrice.rows.length) {
          return res.status(400).json({ error: 'This item is not yet available for purchase. Please call (714) 999-0009 for pricing.' });
        }
        if (dbPrice.rows.length) {
          let dbRetail = parseFloat(dbPrice.rows[0].retail_price);
          const priceBasis = dbPrice.rows[0].price_basis;
          const sqftBox = parseFloat(dbPrice.rows[0].sqft_per_box) || 0;
          const pcsBox = parseFloat(dbPrice.rows[0].pieces_per_box) || 0;
          // Convert per-unit price to per-sqft when sell_by is box
          if (sell_by === 'box' && priceBasis === 'per_unit' && sqftBox > 0 && pcsBox > 0) {
            dbRetail = dbRetail / (sqftBox / pcsBox);
          }
          // Convert per-sqft price to per-unit when sell_by is unit
          if (sell_by === 'unit' && (priceBasis === 'per_sqft' || priceBasis === 'sqft') && sqftBox > 0) {
            dbRetail = dbRetail * sqftBox;
          }
          if (Math.abs(parseFloat(validatedUnitPrice) - dbRetail) > 0.01) {
            validatedUnitPrice = dbRetail;
            if (sell_by === 'box' && sqft_needed) {
              validatedSubtotal = parseFloat((dbRetail * parseFloat(sqft_needed)).toFixed(2));
            } else {
              validatedSubtotal = parseFloat((dbRetail * num_boxes).toFixed(2));
            }
          }
        }
      }

      const result = await pool.query(`
        INSERT INTO cart_items (session_id, product_id, sku_id, sqft_needed, num_boxes, include_overage, unit_price, subtotal, is_sample, sell_by, price_tier, parent_collection, parent_color)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *
      `, [session_id, product_id || null, sku_id || null, sqft_needed || null, num_boxes, include_overage || false, validatedUnitPrice, validatedSubtotal, is_sample || false, sell_by || null, price_tier || null, parent_collection || null, parent_color || null]);

      // Return the fully-enriched row (name/collection/color/image resolved via
      // the SKU) so accessories added by sku_id alone still carry a display name.
      const item = await fetchCartRow(result.rows[0].id) || result.rows[0];
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

      // Custom rug: the only editable field is quantity. Recompute the per-rug
      // price from its stored dimensions + the SKU cut_price so the line total
      // stays server-authoritative regardless of what the client sends.
      const rugRowRes = await pool.query('SELECT sku_id, is_custom_rug, custom_width_ft, custom_length_ft FROM cart_items WHERE id = $1 AND session_id = $2', [id, session_id]);
      if (rugRowRes.rows.length && rugRowRes.rows[0].is_custom_rug) {
        const rr = rugRowRes.rows[0];
        const qty = Math.max(1, parseInt(num_boxes) || 1);
        const priced = await priceCustomRug(rr.sku_id, rr.custom_width_ft, rr.custom_length_ft);
        const per = priced && priced.perRug ? priced.perRug : null;
        const updated = await pool.query(`
          UPDATE cart_items
          SET num_boxes = $1,
              unit_price = COALESCE($2, unit_price),
              subtotal = COALESCE($3, subtotal),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $4 AND session_id = $5 RETURNING *
        `, [qty, per != null ? per.toFixed(2) : null, per != null ? (per * qty).toFixed(2) : null, id, session_id]);
        if (!updated.rows.length) return res.status(404).json({ error: 'Cart item not found' });
        const item = await fetchCartRow(updated.rows[0].id) || updated.rows[0];
        return res.json({ item });
      }

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
            if (itemSellBy === 'box' && priceBasis === 'per_unit' && sqftBox > 0 && pcsBox > 0) {
              dbRetail = dbRetail / (sqftBox / pcsBox);
            }
            if (itemSellBy === 'unit' && (priceBasis === 'per_sqft' || priceBasis === 'sqft') && sqftBox > 0) {
              dbRetail = dbRetail * sqftBox;
            }
            if (unit_price != null && Math.abs(parseFloat(unit_price) - dbRetail) > 0.01) {
              validatedUnitPrice = dbRetail;
              if (num_boxes && itemSellBy === 'box' && sqft_needed) {
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

      const item = await fetchCartRow(result.rows[0].id) || result.rows[0];
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
  router.get('/api/cart/tax-estimate', optionalTradeAuth, async (req, res) => {
    try {
      const { zip, session_id } = req.query;
      if (!session_id) return res.status(400).json({ error: 'session_id is required' });

      const result = await pool.query(
        `SELECT COALESCE(SUM(subtotal), 0) as subtotal FROM cart_items WHERE session_id = $1 AND is_sample = false`,
        [session_id]
      );
      const subtotal = parseFloat(result.rows[0].subtotal) || 0;
      // Logged-in resale-exempt trade customers see no tax.
      const taxExempt = req.tradeCustomer ? await isTradeTaxExempt(pool, { id: req.tradeCustomer.id }) : false;
      const { rate, amount } = calculateSalesTax(subtotal, zip, taxExempt);
      res.json({ rate, amount, subtotal, tax_exempt: taxExempt });
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
