import express from 'express';
import cors from 'cors';
import pg from 'pg';
import crypto from 'crypto';
import Stripe from 'stripe';
import EasyPostClient from '@easypost/api';
import multer from 'multer';
import XLSX from 'xlsx';
import cron from 'node-cron';
import { sendOrderConfirmation, sendQuoteSent, sendOrderStatusUpdate } from './services/emailService.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
const easypost = process.env.EASYPOST_API_KEY ? new EasyPostClient(process.env.EASYPOST_API_KEY) : null;

// Shipping configuration
const WEIGHT_THRESHOLD_LBS = 150; // parcel vs LTL cutoff
const SHIP_FROM = { zip: '92806', city: 'Anaheim', state: 'CA', country: 'US' };

// Pickup-only detection: slabs and prefab countertops cannot be shipped
function isPickupOnly(item) {
  if (item.variant_type === 'slab') return true;
  const vsku = (item.vendor_sku || '').toUpperCase();
  if (['RSL', 'VSL', 'CSL', 'PSL'].some(p => vsku.startsWith(p))) return true;
  const slug = (item.category_slug || '').toLowerCase();
  if (slug === 'prefab-countertops' || slug === 'countertops') return true;
  return false;
}

const app = express();
const PORT = 3001;

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres'
});

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/products', async (req, res) => {
  try {
    const { category } = req.query;
    let query = `
      SELECT p.*, v.name as vendor_name, c.name as category_name, c.slug as category_slug,
        (SELECT pr.retail_price FROM pricing pr
         JOIN skus s ON s.id = pr.sku_id
         WHERE s.product_id = p.id LIMIT 1) as price,
        (SELECT ma.url FROM media_assets ma
         WHERE ma.product_id = p.id AND ma.asset_type = 'primary'
         ORDER BY ma.sort_order LIMIT 1) as primary_image
      FROM products p
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.status = 'active'
    `;
    const params = [];
    let paramIndex = 1;

    if (req.query.search) {
      params.push('%' + req.query.search + '%');
      query += ` AND (p.name ILIKE $${paramIndex} OR p.collection ILIKE $${paramIndex} OR p.description_short ILIKE $${paramIndex} OR v.name ILIKE $${paramIndex})`;
      paramIndex++;
    }

    if (category) {
      params.push(category);
      query += `
        AND p.category_id IN (
          SELECT id FROM categories WHERE slug = $${paramIndex}
          UNION
          SELECT id FROM categories WHERE parent_id = (
            SELECT id FROM categories WHERE slug = $${paramIndex}
          )
        )
      `;
      paramIndex++;
    }

    // Attribute filters: look up valid filterable slugs, then check query params
    try {
      const attrResult = await pool.query(
        'SELECT slug FROM attributes WHERE is_filterable = true'
      );
      const validSlugs = attrResult.rows.map(r => r.slug);

      for (const slug of validSlugs) {
        if (req.query[slug]) {
          const values = req.query[slug].split(',').map(v => v.trim()).filter(Boolean);
          if (values.length > 0) {
            const placeholders = values.map((_, i) => `$${paramIndex + i}`).join(', ');
            query += `
              AND p.id IN (
                SELECT s.product_id FROM skus s
                JOIN sku_attributes sa ON sa.sku_id = s.id
                JOIN attributes a ON a.id = sa.attribute_id
                WHERE a.slug = $${paramIndex + values.length} AND sa.value IN (${placeholders})
              )
            `;
            params.push(...values, slug);
            paramIndex += values.length + 1;
          }
        }
      }
    } catch (attrErr) {
      // attributes table may not exist yet — skip filtering
    }

    query += ' ORDER BY p.name';
    const result = await pool.query(query, params);
    res.json({ products: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const product = await pool.query(`
      SELECT p.*, v.name as vendor_name, c.name as category_name, c.slug as category_slug
      FROM products p
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.id = $1
    `, [id]);
    if (!product.rows.length) return res.status(404).json({ error: 'Product not found' });

    const skus = await pool.query(`
      SELECT s.*, pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs, pk.freight_class, pk.boxes_per_pallet, pk.sqft_per_pallet, pk.weight_per_pallet_lbs,
        pr.cost, pr.retail_price, pr.price_basis
      FROM skus s
      LEFT JOIN packaging pk ON pk.sku_id = s.id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      WHERE s.product_id = $1
      ORDER BY s.created_at
    `, [id]);

    const media = await pool.query(`
      SELECT id, asset_type, url, sort_order FROM media_assets
      WHERE product_id = $1
      ORDER BY CASE asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 ELSE 2 END, sort_order
    `, [id]);

    res.json({ product: product.rows[0], skus: skus.rows, media: media.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/attributes', async (req, res) => {
  try {
    const { category } = req.query;
    let query = `
      SELECT a.name, a.slug, sa.value, COUNT(DISTINCT s.product_id)::int as count
      FROM attributes a
      JOIN sku_attributes sa ON sa.attribute_id = a.id
      JOIN skus s ON s.id = sa.sku_id
      JOIN products p ON p.id = s.product_id
      WHERE a.is_filterable = true AND p.status = 'active'
    `;
    const params = [];

    if (category) {
      params.push(category);
      query += `
        AND p.category_id IN (
          SELECT id FROM categories WHERE slug = $1
          UNION
          SELECT id FROM categories WHERE parent_id = (
            SELECT id FROM categories WHERE slug = $1
          )
        )
      `;
    }

    query += `
      GROUP BY a.name, a.slug, a.display_order, sa.value
      ORDER BY a.display_order, a.name, count DESC, sa.value
    `;

    const result = await pool.query(query, params);

    // Group by attribute slug
    const grouped = {};
    for (const row of result.rows) {
      if (!grouped[row.slug]) {
        grouped[row.slug] = { name: row.name, slug: row.slug, values: [] };
      }
      grouped[row.slug].values.push({ value: row.value, count: row.count });
    }

    res.json({ attributes: Object.values(grouped) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const result = await pool.query(`
      WITH category_counts AS (
        SELECT c.id, COUNT(p.id)::int as product_count
        FROM categories c
        LEFT JOIN products p ON p.category_id = c.id AND p.status = 'active'
        GROUP BY c.id
      )
      SELECT c.id, c.name, c.slug, c.parent_id, c.sort_order,
        COALESCE(cc.product_count, 0) as product_count
      FROM categories c
      LEFT JOIN category_counts cc ON cc.id = c.id
      WHERE c.is_active = true
      ORDER BY c.sort_order, c.name
    `);

    const rows = result.rows;
    const parents = rows.filter(r => !r.parent_id);
    const categories = parents.map(p => {
      const children = rows
        .filter(r => r.parent_id === p.id)
        .map(ch => ({
          id: ch.id,
          name: ch.name,
          slug: ch.slug,
          product_count: ch.product_count
        }));
      const parent_count = p.product_count + children.reduce((sum, ch) => sum + ch.product_count, 0);
      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        product_count: parent_count,
        children
      };
    });

    res.json({ categories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/calculate', async (req, res) => {
  try {
    const { sqft_needed } = req.body;
    const sqftPerBox = 10;
    const pricePerSqft = 15.99;
    const boxesNeeded = Math.ceil(sqft_needed / sqftPerBox);
    const actualSqft = boxesNeeded * sqftPerBox;
    
    res.json({
      boxes_needed: boxesNeeded,
      actual_sqft: actualSqft,
      overage: actualSqft - sqft_needed,
      subtotal: (pricePerSqft * actualSqft).toFixed(2)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cart endpoints
app.get('/api/cart', async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'session_id is required' });

    const result = await pool.query(`
      SELECT ci.*, p.name as product_name, p.collection,
        s.sell_by, s.variant_type, s.vendor_sku, c.slug as category_slug
      FROM cart_items ci
      LEFT JOIN products p ON p.id = ci.product_id
      LEFT JOIN skus s ON s.id = ci.sku_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE ci.session_id = $1
      ORDER BY ci.created_at
    `, [session_id]);
    const cart = result.rows.map(item => ({
      ...item,
      pickup_only: !item.is_sample && isPickupOnly(item)
    }));
    res.json({ cart });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cart', async (req, res) => {
  try {
    const { session_id, product_id, sku_id, sqft_needed, num_boxes, include_overage, unit_price, subtotal, is_sample } = req.body;
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

    const result = await pool.query(`
      INSERT INTO cart_items (session_id, product_id, sku_id, sqft_needed, num_boxes, include_overage, unit_price, subtotal, is_sample)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [session_id, product_id || null, sku_id || null, sqft_needed || null, num_boxes, include_overage || false, unit_price || 0, subtotal || 0, is_sample || false]);

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
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/cart/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { num_boxes, sqft_needed, subtotal } = req.body;

    const result = await pool.query(`
      UPDATE cart_items
      SET num_boxes = COALESCE($1, num_boxes),
          sqft_needed = COALESCE($2, sqft_needed),
          subtotal = COALESCE($3, subtotal),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
    `, [num_boxes, sqft_needed, subtotal, id]);

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
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/cart/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM cart_items WHERE id = $1 RETURNING id', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Cart item not found' });
    res.json({ deleted: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Shipping API ====================

async function getParcelRates(weightLbs, destination) {
  if (!easypost) throw new Error('EasyPost API key not configured');
  const weightOz = Math.ceil(weightLbs * 16);
  const shipment = await easypost.Shipment.create({
    from_address: { zip: SHIP_FROM.zip, city: SHIP_FROM.city, state: SHIP_FROM.state, country: SHIP_FROM.country },
    to_address: { zip: destination.zip, city: destination.city || '', state: destination.state || '', country: 'US' },
    parcel: { weight: weightOz }
  });
  if (!shipment.rates || shipment.rates.length === 0) {
    throw new Error('No parcel rates available for this destination');
  }
  const sorted = shipment.rates.sort((a, b) => parseFloat(a.rate) - parseFloat(b.rate));
  return { amount: parseFloat(sorted[0].rate), carrier: sorted[0].carrier, service: sorted[0].service };
}

// FreightView v2 OAuth2 token cache
const FV_BASE = 'https://api.freightview.com';
let fvToken = null;
let fvTokenExpiry = 0;

async function getFreightViewToken() {
  if (fvToken && Date.now() < fvTokenExpiry) return fvToken;

  const clientId = process.env.FREIGHTVIEW_CLIENT_ID;
  const clientSecret = process.env.FREIGHTVIEW_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('FreightView credentials not configured');

  const resp = await fetch(FV_BASE + '/v2.0/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('FreightView auth failed (' + resp.status + '): ' + text);
  }

  const data = await resp.json();
  fvToken = data.access_token;
  // Token valid for 24hrs (86400s) — refresh 60s early
  fvTokenExpiry = Date.now() + ((data.expires_in || 86400) - 60) * 1000;
  return fvToken;
}

async function getLTLRates(freightItems, destination) {
  const token = await getFreightViewToken();

  // pickupDate = next business day
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const pickupDate = tomorrow.toISOString().split('T')[0];

  const resp = await fetch(FV_BASE + '/v2.0/shipments/ltl?returnQuotes=true&waitDuration=15', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      pickupDate,
      origin: {
        postalCode: SHIP_FROM.zip,
        country: 'us'
      },
      destination: {
        postalCode: destination.zip,
        country: 'us'
      },
      items: freightItems
    })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('FreightView rate request failed (' + resp.status + '): ' + text);
  }

  const data = await resp.json();
  const quotes = data.quotes || [];
  if (quotes.length === 0) {
    throw new Error('No LTL freight rates available for this destination');
  }
  const sorted = quotes.sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount));
  const best = sorted[0];
  return {
    amount: parseFloat(best.amount),
    carrier: best.providerName || 'LTL Carrier',
    service: 'LTL Freight'
  };
}

async function calculateShipping(sessionId, destination) {
  // Get packaging weight + freight class for non-sample cart items
  const result = await pool.query(`
    SELECT ci.num_boxes, ci.is_sample, pk.weight_per_box_lbs, pk.freight_class
    FROM cart_items ci
    JOIN skus s ON s.id = ci.sku_id
    LEFT JOIN packaging pk ON pk.sku_id = s.id
    WHERE ci.session_id = $1 AND ci.is_sample = false
  `, [sessionId]);

  let totalWeightLbs = 0;
  let totalBoxes = 0;
  // Group weight by freight class for LTL items array
  const byFreightClass = {};
  for (const row of result.rows) {
    const boxes = parseInt(row.num_boxes) || 0;
    const weightPerBox = parseFloat(row.weight_per_box_lbs) || 0;
    const weight = boxes * weightPerBox;
    const fc = parseInt(row.freight_class) || 70;
    totalWeightLbs += weight;
    totalBoxes += boxes;
    if (!byFreightClass[fc]) byFreightClass[fc] = 0;
    byFreightClass[fc] += weight;
  }

  // Sample-only order — no product shipping
  if (totalWeightLbs === 0 || totalBoxes === 0) {
    return { shipping: 0, method: null, carrier: null, weight_lbs: 0, total_boxes: 0 };
  }

  let rateResult;
  let method;

  if (totalWeightLbs <= WEIGHT_THRESHOLD_LBS) {
    method = 'parcel';
    rateResult = await getParcelRates(totalWeightLbs, destination);
  } else {
    method = 'ltl_freight';
    // Build one FreightView item per freight class
    const freightItems = Object.entries(byFreightClass).map(([fc, weight]) => ({
      quantity: 1,
      weight: Math.ceil(weight),
      weightUOM: 'lbs',
      freightClass: parseInt(fc),
      description: 'Flooring materials',
      type: 'pallet'
    }));
    rateResult = await getLTLRates(freightItems, destination);
  }

  return {
    shipping: parseFloat(rateResult.amount.toFixed(2)),
    method,
    carrier: rateResult.carrier,
    service: rateResult.service,
    weight_lbs: parseFloat(totalWeightLbs.toFixed(2)),
    total_boxes: totalBoxes
  };
}

app.post('/api/shipping/estimate', async (req, res) => {
  try {
    const { session_id, destination, delivery_method } = req.body;

    // Pickup orders have no shipping cost
    if (delivery_method === 'pickup') {
      return res.json({ shipping: 0, method: 'pickup', carrier: null, weight_lbs: 0, total_boxes: 0 });
    }

    if (!session_id || !destination || !destination.zip) {
      return res.status(400).json({ error: 'session_id and destination.zip are required' });
    }

    const result = await calculateShipping(session_id, destination);
    res.json(result);
  } catch (err) {
    console.error('Shipping estimate error:', err.message);
    res.status(500).json({ error: 'Unable to calculate shipping: ' + err.message });
  }
});

// ==================== Checkout API ====================

app.post('/api/checkout/create-payment-intent', async (req, res) => {
  try {
    const { session_id, destination, delivery_method } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id is required' });

    const result = await pool.query(`
      SELECT ci.*, p.name as product_name, p.collection,
        s.variant_type, s.vendor_sku, c.slug as category_slug
      FROM cart_items ci
      LEFT JOIN products p ON p.id = ci.product_id
      LEFT JOIN skus s ON s.id = ci.sku_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE ci.session_id = $1
      ORDER BY ci.created_at
    `, [session_id]);

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const items = result.rows;
    const productItems = items.filter(i => !i.is_sample);
    const sampleItems = items.filter(i => i.is_sample);
    const productSubtotal = productItems.reduce((sum, i) => sum + parseFloat(i.subtotal || 0), 0);
    const sampleShipping = sampleItems.length > 0 ? 12 : 0;

    // Calculate product shipping
    let shippingCost = 0;
    let shippingMethod = null;
    if (delivery_method === 'pickup') {
      shippingCost = 0;
      shippingMethod = 'pickup';
    } else if (destination && destination.zip && productItems.length > 0) {
      // Validate no pickup-only items when shipping
      const hasPickupOnly = productItems.some(i => isPickupOnly(i));
      if (hasPickupOnly) {
        return res.status(400).json({ error: 'Cart contains items that are available for store pickup only (slabs/prefab). Please select store pickup.' });
      }
      try {
        const shippingResult = await calculateShipping(session_id, destination);
        shippingCost = shippingResult.shipping;
        shippingMethod = shippingResult.method;
      } catch (shipErr) {
        console.error('Shipping calc error during payment intent:', shipErr.message);
      }
    }

    const total = productSubtotal + shippingCost + sampleShipping;

    if (total <= 0) {
      return res.status(400).json({ error: 'Order total must be greater than zero' });
    }

    const totalCents = Math.round(total * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalCents,
      currency: 'usd',
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      amount: total,
      shipping: shippingCost,
      shipping_method: shippingMethod
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Purchase Order Generation ====================

async function generatePurchaseOrders(orderId, client) {
  // Get order items with vendor and cost info (exclude samples and custom items)
  const itemsResult = await client.query(`
    SELECT oi.id as order_item_id, oi.product_name, oi.num_boxes as qty, oi.unit_price,
           oi.sell_by, oi.description,
           p.vendor_id, v.code as vendor_code, v.name as vendor_name,
           s.id as sku_id, s.vendor_sku,
           COALESCE(pr.cost, 0) as vendor_cost
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN skus s ON s.id = oi.sku_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    WHERE oi.order_id = $1
      AND oi.is_sample = false
      AND oi.product_id IS NOT NULL
  `, [orderId]);

  if (itemsResult.rows.length === 0) return [];

  // Group items by vendor
  const vendorGroups = {};
  for (const item of itemsResult.rows) {
    if (!vendorGroups[item.vendor_id]) {
      vendorGroups[item.vendor_id] = {
        vendor_id: item.vendor_id,
        vendor_code: item.vendor_code,
        items: []
      };
    }
    vendorGroups[item.vendor_id].items.push(item);
  }

  const createdPOs = [];

  for (const group of Object.values(vendorGroups)) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 4).toUpperCase();
    const poNumber = `PO-${group.vendor_code}-${timestamp}-${random}`;

    // Calculate subtotal
    let poSubtotal = 0;
    for (const item of group.items) {
      poSubtotal += parseFloat(item.vendor_cost) * item.qty;
    }

    // Create purchase order
    const poResult = await client.query(`
      INSERT INTO purchase_orders (order_id, vendor_id, po_number, status, subtotal)
      VALUES ($1, $2, $3, 'draft', $4)
      RETURNING *
    `, [orderId, group.vendor_id, poNumber, poSubtotal.toFixed(2)]);

    const po = poResult.rows[0];

    // Create purchase order items
    for (const item of group.items) {
      const cost = parseFloat(item.vendor_cost);
      const itemSubtotal = cost * item.qty;
      await client.query(`
        INSERT INTO purchase_order_items
          (purchase_order_id, order_item_id, sku_id, product_name, vendor_sku, description, qty, sell_by, cost, original_cost, retail_price, subtotal)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [po.id, item.order_item_id, item.sku_id, item.product_name, item.vendor_sku,
          item.description, item.qty, item.sell_by,
          cost.toFixed(2), cost.toFixed(2),
          item.unit_price ? parseFloat(item.unit_price).toFixed(2) : null,
          itemSubtotal.toFixed(2)]);
    }

    createdPOs.push(po);
  }

  return createdPOs;
}

app.post('/api/checkout/place-order', async (req, res) => {
  const client = await pool.connect();
  try {
    const { session_id, payment_intent_id, customer_name, customer_email, phone, shipping, delivery_method } = req.body;
    if (!session_id || !payment_intent_id || !customer_name || !customer_email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const isPickup = delivery_method === 'pickup';

    // Validate shipping address only when shipping (not pickup)
    if (!isPickup) {
      if (!shipping || !shipping.line1 || !shipping.city || !shipping.state || !shipping.zip) {
        return res.status(400).json({ error: 'Missing required shipping fields' });
      }
    }

    // Verify payment succeeded
    const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment has not been completed' });
    }

    // Get cart items
    const cartResult = await client.query(`
      SELECT ci.*, p.name as product_name, p.collection
      FROM cart_items ci
      LEFT JOIN products p ON p.id = ci.product_id
      WHERE ci.session_id = $1
      ORDER BY ci.created_at
    `, [session_id]);

    if (cartResult.rows.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const items = cartResult.rows;
    const productItems = items.filter(i => !i.is_sample);
    const sampleItems = items.filter(i => i.is_sample);
    const productSubtotal = productItems.reduce((sum, i) => sum + parseFloat(i.subtotal || 0), 0);
    const sampleShipping = sampleItems.length > 0 ? 12 : 0;

    // Calculate product shipping
    let shippingCost = 0;
    let shippingMethod = null;
    if (isPickup) {
      shippingCost = 0;
      shippingMethod = 'pickup';
    } else if (productItems.length > 0) {
      try {
        const shippingResult = await calculateShipping(session_id, {
          zip: shipping.zip, city: shipping.city, state: shipping.state
        });
        shippingCost = shippingResult.shipping;
        shippingMethod = shippingResult.method;
      } catch (shipErr) {
        console.error('Shipping calc error during order placement:', shipErr.message);
      }
    }

    const total = productSubtotal + shippingCost + sampleShipping;

    const orderNumber = 'ORD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();

    await client.query('BEGIN');

    const orderResult = await client.query(`
      INSERT INTO orders (order_number, session_id, customer_email, customer_name, phone,
        shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip,
        subtotal, shipping, shipping_method, sample_shipping, total, stripe_payment_intent_id, delivery_method, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'confirmed')
      RETURNING *
    `, [orderNumber, session_id, customer_email, customer_name, phone || null,
        isPickup ? null : shipping.line1, isPickup ? null : (shipping.line2 || null),
        isPickup ? null : shipping.city, isPickup ? null : shipping.state, isPickup ? null : shipping.zip,
        productSubtotal.toFixed(2), shippingCost.toFixed(2), shippingMethod, sampleShipping.toFixed(2), total.toFixed(2),
        payment_intent_id, isPickup ? 'pickup' : 'shipping']);

    const order = orderResult.rows[0];

    for (const item of items) {
      await client.query(`
        INSERT INTO order_items (order_id, product_id, sku_id, product_name, collection,
          sqft_needed, num_boxes, unit_price, subtotal, is_sample)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [order.id, item.product_id || null, item.sku_id || null,
          item.product_name || null, item.collection || null,
          item.sqft_needed || null, item.num_boxes,
          item.unit_price || null, item.subtotal || null, item.is_sample || false]);
    }

    // Generate purchase orders (one per vendor)
    await generatePurchaseOrders(order.id, client);

    // Clear cart
    await client.query('DELETE FROM cart_items WHERE session_id = $1', [session_id]);

    await client.query('COMMIT');

    // Return order with items
    const orderItems = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
    res.json({ order: { ...order, items: orderItems.rows } });

    // Fire-and-forget: send order confirmation email
    const emailOrder = { ...order, items: orderItems.rows };
    setImmediate(() => sendOrderConfirmation(emailOrder));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==================== Admin API ====================

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_API_KEY || !key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Dashboard stats
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const counts = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM products) as products,
        (SELECT COUNT(*)::int FROM vendors) as vendors,
        (SELECT COUNT(*)::int FROM categories) as categories,
        (SELECT COUNT(*)::int FROM skus) as skus,
        (SELECT COUNT(*)::int FROM orders) as orders
    `);
    const recent = await pool.query(`
      SELECT p.id, p.name, p.status, v.name as vendor_name, p.created_at
      FROM products p
      LEFT JOIN vendors v ON v.id = p.vendor_id
      ORDER BY p.created_at DESC LIMIT 5
    `);
    const recentOrders = await pool.query(`
      SELECT o.id, o.order_number, o.customer_name, o.customer_email, o.total, o.status, o.created_at,
        (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) as item_count
      FROM orders o
      ORDER BY o.created_at DESC LIMIT 5
    `);
    res.json({ counts: counts.rows[0], recent_products: recent.rows, recent_orders: recentOrders.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all products (admin view - any status)
app.get('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, v.name as vendor_name, c.name as category_name,
        (SELECT COUNT(*)::int FROM skus s WHERE s.product_id = p.id) as sku_count,
        (SELECT pr.retail_price FROM pricing pr
         JOIN skus s ON s.id = pr.sku_id
         WHERE s.product_id = p.id LIMIT 1) as price,
        (SELECT ma.url FROM media_assets ma
         WHERE ma.product_id = p.id AND ma.asset_type = 'primary'
         ORDER BY ma.sort_order LIMIT 1) as primary_image
      FROM products p
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      ORDER BY p.created_at DESC
    `);
    res.json({ products: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk update product status
app.patch('/api/admin/products/bulk/status', adminAuth, async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!ids || !ids.length) return res.status(400).json({ error: 'ids array is required' });
    if (!['active', 'draft'].includes(status)) return res.status(400).json({ error: 'status must be active or draft' });
    const result = await pool.query(
      'UPDATE products SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($2) RETURNING id',
      [status, ids]
    );
    res.json({ updated: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk update product category
app.patch('/api/admin/products/bulk/category', adminAuth, async (req, res) => {
  try {
    const { ids, category_id } = req.body;
    if (!ids || !ids.length) return res.status(400).json({ error: 'ids array is required' });
    const result = await pool.query(
      'UPDATE products SET category_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($2) RETURNING id',
      [category_id || null, ids]
    );
    res.json({ updated: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk delete products (cascade)
app.delete('/api/admin/products/bulk', adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.status(400).json({ error: 'ids array is required' });
    await client.query('BEGIN');

    const skuResult = await client.query('SELECT id FROM skus WHERE product_id = ANY($1)', [ids]);
    const skuIds = skuResult.rows.map(r => r.id);
    if (skuIds.length > 0) {
      await client.query('DELETE FROM sku_attributes WHERE sku_id = ANY($1)', [skuIds]);
      await client.query('DELETE FROM packaging WHERE sku_id = ANY($1)', [skuIds]);
      await client.query('DELETE FROM pricing WHERE sku_id = ANY($1)', [skuIds]);
      await client.query('DELETE FROM skus WHERE product_id = ANY($1)', [ids]);
    }
    await client.query('DELETE FROM media_assets WHERE product_id = ANY($1)', [ids]);
    const result = await client.query('DELETE FROM products WHERE id = ANY($1) RETURNING id', [ids]);

    await client.query('COMMIT');
    res.json({ deleted: result.rowCount });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Get single product with full details
app.get('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const product = await pool.query(`
      SELECT p.*, v.name as vendor_name, c.name as category_name, c.slug as category_slug
      FROM products p
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.id = $1
    `, [id]);
    if (!product.rows.length) return res.status(404).json({ error: 'Product not found' });

    const skus = await pool.query(`
      SELECT s.*, pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs, pk.freight_class, pk.boxes_per_pallet, pk.sqft_per_pallet, pk.weight_per_pallet_lbs,
        pr.cost, pr.retail_price, pr.price_basis
      FROM skus s
      LEFT JOIN packaging pk ON pk.sku_id = s.id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      WHERE s.product_id = $1
      ORDER BY s.created_at
    `, [id]);

    const media = await pool.query(`
      SELECT id, asset_type, url, sort_order FROM media_assets
      WHERE product_id = $1
      ORDER BY CASE asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 ELSE 2 END, sort_order
    `, [id]);

    res.json({ product: product.rows[0], skus: skus.rows, media: media.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create product
app.post('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const { name, collection, vendor_id, category_id, status, description_short, description_long } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const result = await pool.query(`
      INSERT INTO products (name, collection, vendor_id, category_id, status, description_short, description_long)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [name, collection || null, vendor_id || null, category_id || null, status || 'draft', description_short || null, description_long || null]);

    res.json({ product: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update product
app.put('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, collection, vendor_id, category_id, status, description_short, description_long } = req.body;

    const result = await pool.query(`
      UPDATE products SET
        name = COALESCE($1, name),
        collection = COALESCE($2, collection),
        vendor_id = COALESCE($3, vendor_id),
        category_id = COALESCE($4, category_id),
        status = COALESCE($5, status),
        description_short = COALESCE($6, description_short),
        description_long = COALESCE($7, description_long),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
      RETURNING *
    `, [name, collection, vendor_id, category_id, status, description_short, description_long, id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json({ product: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete product (cascade)
app.delete('/api/admin/products/:id', adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('BEGIN');

    const skuIds = await client.query('SELECT id FROM skus WHERE product_id = $1', [id]);
    const ids = skuIds.rows.map(r => r.id);
    if (ids.length > 0) {
      await client.query('DELETE FROM sku_attributes WHERE sku_id = ANY($1)', [ids]);
      await client.query('DELETE FROM packaging WHERE sku_id = ANY($1)', [ids]);
      await client.query('DELETE FROM pricing WHERE sku_id = ANY($1)', [ids]);
      await client.query('DELETE FROM skus WHERE product_id = $1', [id]);
    }
    await client.query('DELETE FROM media_assets WHERE product_id = $1', [id]);
    const result = await client.query('DELETE FROM products WHERE id = $1 RETURNING id', [id]);

    await client.query('COMMIT');
    if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json({ deleted: id });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// List SKUs for a product
app.get('/api/admin/products/:productId/skus', adminAuth, async (req, res) => {
  try {
    const { productId } = req.params;
    const result = await pool.query(`
      SELECT s.*, pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs, pk.freight_class, pk.boxes_per_pallet, pk.sqft_per_pallet, pk.weight_per_pallet_lbs,
        pr.cost, pr.retail_price, pr.price_basis
      FROM skus s
      LEFT JOIN packaging pk ON pk.sku_id = s.id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      WHERE s.product_id = $1
      ORDER BY s.created_at
    `, [productId]);
    res.json({ skus: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create SKU + packaging + pricing
app.post('/api/admin/products/:productId/skus', adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { productId } = req.params;
    const { vendor_sku, internal_sku, variant_name, sell_by, sqft_per_box, pieces_per_box, weight_per_box_lbs, freight_class, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs, cost, retail_price, price_basis } = req.body;
    if (!vendor_sku || !internal_sku) return res.status(400).json({ error: 'vendor_sku and internal_sku are required' });

    await client.query('BEGIN');

    const sku = await client.query(`
      INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [productId, vendor_sku, internal_sku, variant_name || null, sell_by || 'sqft']);

    const skuId = sku.rows[0].id;

    if (sqft_per_box || pieces_per_box || weight_per_box_lbs || boxes_per_pallet) {
      await client.query(`
        INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs, freight_class, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [skuId, sqft_per_box || null, pieces_per_box || null, weight_per_box_lbs || null, freight_class || 70, boxes_per_pallet || null, sqft_per_pallet || null, weight_per_pallet_lbs || null]);
    }

    if (cost != null && retail_price != null) {
      await client.query(`
        INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
        VALUES ($1, $2, $3, $4)
      `, [skuId, cost, retail_price, price_basis || 'per_sqft']);
    }

    await client.query('COMMIT');

    // Return full SKU with joins
    const full = await pool.query(`
      SELECT s.*, pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs, pk.freight_class, pk.boxes_per_pallet, pk.sqft_per_pallet, pk.weight_per_pallet_lbs,
        pr.cost, pr.retail_price, pr.price_basis
      FROM skus s
      LEFT JOIN packaging pk ON pk.sku_id = s.id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      WHERE s.id = $1
    `, [skuId]);

    res.json({ sku: full.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Update SKU + upsert packaging + pricing
app.put('/api/admin/skus/:id', adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { vendor_sku, internal_sku, variant_name, sell_by, sqft_per_box, pieces_per_box, weight_per_box_lbs, freight_class, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs, cost, retail_price, price_basis } = req.body;

    await client.query('BEGIN');

    await client.query(`
      UPDATE skus SET
        vendor_sku = COALESCE($1, vendor_sku),
        internal_sku = COALESCE($2, internal_sku),
        variant_name = COALESCE($3, variant_name),
        sell_by = COALESCE($4, sell_by),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
    `, [vendor_sku, internal_sku, variant_name, sell_by, id]);

    // Upsert packaging
    await client.query(`
      INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs, freight_class, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (sku_id) DO UPDATE SET
        sqft_per_box = COALESCE($2, packaging.sqft_per_box),
        pieces_per_box = COALESCE($3, packaging.pieces_per_box),
        weight_per_box_lbs = COALESCE($4, packaging.weight_per_box_lbs),
        freight_class = COALESCE($5, packaging.freight_class),
        boxes_per_pallet = COALESCE($6, packaging.boxes_per_pallet),
        sqft_per_pallet = COALESCE($7, packaging.sqft_per_pallet),
        weight_per_pallet_lbs = COALESCE($8, packaging.weight_per_pallet_lbs)
    `, [id, sqft_per_box, pieces_per_box, weight_per_box_lbs, freight_class, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs]);

    // Upsert pricing
    if (cost != null && retail_price != null) {
      await client.query(`
        INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (sku_id) DO UPDATE SET
          cost = COALESCE($2, pricing.cost),
          retail_price = COALESCE($3, pricing.retail_price),
          price_basis = COALESCE($4, pricing.price_basis)
      `, [id, cost, retail_price, price_basis]);
    }

    await client.query('COMMIT');

    const full = await pool.query(`
      SELECT s.*, pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs, pk.freight_class, pk.boxes_per_pallet, pk.sqft_per_pallet, pk.weight_per_pallet_lbs,
        pr.cost, pr.retail_price, pr.price_basis
      FROM skus s
      LEFT JOIN packaging pk ON pk.sku_id = s.id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      WHERE s.id = $1
    `, [id]);

    if (!full.rows.length) return res.status(404).json({ error: 'SKU not found' });
    res.json({ sku: full.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Delete SKU + related rows
app.delete('/api/admin/skus/:id', adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('BEGIN');
    await client.query('DELETE FROM sku_attributes WHERE sku_id = $1', [id]);
    await client.query('DELETE FROM packaging WHERE sku_id = $1', [id]);
    await client.query('DELETE FROM pricing WHERE sku_id = $1', [id]);
    const result = await client.query('DELETE FROM skus WHERE id = $1 RETURNING id', [id]);
    await client.query('COMMIT');
    if (!result.rows.length) return res.status(404).json({ error: 'SKU not found' });
    res.json({ deleted: id });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// List vendors with product counts
app.get('/api/admin/vendors', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT v.*, (SELECT COUNT(*)::int FROM products p WHERE p.vendor_id = v.id) as product_count
      FROM vendors v
      ORDER BY v.name
    `);
    res.json({ vendors: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create vendor
app.post('/api/admin/vendors', adminAuth, async (req, res) => {
  try {
    const { name, code, website } = req.body;
    if (!name || !code) return res.status(400).json({ error: 'Name and code are required' });

    const result = await pool.query(`
      INSERT INTO vendors (name, code, website)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [name, code, website || null]);
    res.json({ vendor: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update vendor
app.put('/api/admin/vendors/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, code, website } = req.body;

    const result = await pool.query(`
      UPDATE vendors SET
        name = COALESCE($1, name),
        code = COALESCE($2, code),
        website = COALESCE($3, website),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
    `, [name, code, website, id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Vendor not found' });
    res.json({ vendor: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle vendor active status
app.patch('/api/admin/vendors/:id/toggle', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      UPDATE vendors SET is_active = NOT is_active, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Vendor not found' });
    res.json({ vendor: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List categories (flat + tree)
app.get('/api/admin/categories', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, (SELECT COUNT(*)::int FROM products p WHERE p.category_id = c.id) as product_count
      FROM categories c
      ORDER BY c.sort_order, c.name
    `);
    const rows = result.rows;
    const flat = rows;

    const parents = rows.filter(r => !r.parent_id);
    const tree = parents.map(p => ({
      ...p,
      children: rows.filter(r => r.parent_id === p.id)
    }));

    res.json({ flat, tree });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create category
app.post('/api/admin/categories', adminAuth, async (req, res) => {
  try {
    const { name, slug, parent_id, sort_order } = req.body;
    if (!name || !slug) return res.status(400).json({ error: 'Name and slug are required' });

    const result = await pool.query(`
      INSERT INTO categories (name, slug, parent_id, sort_order)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [name, slug, parent_id || null, sort_order || 0]);
    res.json({ category: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update category
app.put('/api/admin/categories/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, slug, parent_id, sort_order } = req.body;

    const result = await pool.query(`
      UPDATE categories SET
        name = COALESCE($1, name),
        slug = COALESCE($2, slug),
        parent_id = COALESCE($3, parent_id),
        sort_order = COALESCE($4, sort_order),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING *
    `, [name, slug, parent_id, sort_order, id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Category not found' });
    res.json({ category: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete category (blocked if has children or products)
app.delete('/api/admin/categories/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const children = await pool.query('SELECT COUNT(*)::int as count FROM categories WHERE parent_id = $1', [id]);
    if (children.rows[0].count > 0) {
      return res.status(400).json({ error: 'Cannot delete category with subcategories. Remove children first.' });
    }

    const products = await pool.query('SELECT COUNT(*)::int as count FROM products WHERE category_id = $1', [id]);
    if (products.rows[0].count > 0) {
      return res.status(400).json({ error: 'Cannot delete category with products. Reassign products first.' });
    }

    const result = await pool.query('DELETE FROM categories WHERE id = $1 RETURNING id', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Category not found' });
    res.json({ deleted: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all orders
app.get('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.*,
        sr.first_name || ' ' || sr.last_name as rep_name,
        (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) as item_count
      FROM orders o
      LEFT JOIN sales_reps sr ON sr.id = o.sales_rep_id
      ORDER BY o.created_at DESC
    `);
    res.json({ orders: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single order with items
app.get('/api/admin/orders/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const order = await pool.query(`
      SELECT o.*, sr.first_name || ' ' || sr.last_name as rep_name
      FROM orders o LEFT JOIN sales_reps sr ON sr.id = o.sales_rep_id
      WHERE o.id = $1
    `, [id]);
    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });

    const items = await pool.query(`
      SELECT oi.*, p.name as current_product_name, p.collection as current_collection
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1
      ORDER BY oi.id
    `, [id]);

    res.json({ order: order.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update order status
app.put('/api/admin/orders/:id/status', adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { status } = req.body;
    const validStatuses = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be one of: ' + validStatuses.join(', ') });
    }

    await client.query('BEGIN');

    const result = await client.query(`
      UPDATE orders SET status = $1
      WHERE id = $2
      RETURNING *
    `, [status, id]);

    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    // Auto-generate POs when order becomes confirmed (idempotency guard)
    if (status === 'confirmed') {
      const existing = await client.query('SELECT id FROM purchase_orders WHERE order_id = $1 LIMIT 1', [id]);
      if (existing.rows.length === 0) {
        await generatePurchaseOrders(id, client);
      }
    }

    await client.query('COMMIT');
    const updatedOrder = result.rows[0];
    res.json({ order: updatedOrder });

    // Fire-and-forget: send status update email for shipped/delivered/cancelled
    setImmediate(() => sendOrderStatusUpdate(updatedOrder, status));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==================== Spreadsheet Import API ====================

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.toLowerCase().split('.').pop();
    if (['xlsx', 'xls', 'csv'].includes(ext)) cb(null, true);
    else cb(new Error('Only XLSX, XLS, and CSV files are allowed'));
  }
});

// In-memory cache for parsed spreadsheet data between upload and import
const importSessions = new Map();
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, s] of importSessions) {
    if (s.createdAt < cutoff) importSessions.delete(id);
  }
}, 5 * 60 * 1000);

const PIM_FIELDS = [
  { value: '', label: '-- Skip this column --', group: '' },
  { value: 'name', label: 'Product Name', group: 'Product' },
  { value: 'category', label: 'Category', group: 'Product' },
  { value: 'collection', label: 'Collection', group: 'Product' },
  { value: 'description_short', label: 'Short Description', group: 'Product' },
  { value: 'description_long', label: 'Long Description', group: 'Product' },
  { value: 'vendor_sku', label: 'Vendor SKU *', group: 'SKU' },
  { value: 'internal_sku', label: 'Internal SKU (auto if blank)', group: 'SKU' },
  { value: 'variant_name', label: 'Variant Name', group: 'SKU' },
  { value: 'sqft_per_box', label: 'SqFt Per Box', group: 'Packaging' },
  { value: 'pieces_per_box', label: 'Pieces Per Box', group: 'Packaging' },
  { value: 'weight_per_box_lbs', label: 'Weight Per Box (lbs)', group: 'Packaging' },
  { value: 'freight_class', label: 'Freight Class', group: 'Packaging' },
  { value: 'cost', label: 'Cost', group: 'Pricing' },
  { value: 'retail_price', label: 'Retail Price', group: 'Pricing' },
];

function applyMapping(row, mapping) {
  const result = {};
  for (const [colIndex, fieldName] of Object.entries(mapping)) {
    if (!fieldName) continue;
    const idx = parseInt(colIndex);
    if (idx >= 0 && idx < row.length) {
      const value = row[idx];
      result[fieldName] = value != null ? String(value).trim() : '';
    }
  }
  return result;
}

// GET /api/admin/import/fields — list available PIM target fields
app.get('/api/admin/import/fields', adminAuth, async (req, res) => {
  try {
    const attrResult = await pool.query('SELECT name, slug FROM attributes ORDER BY display_order, name');
    const fields = [...PIM_FIELDS];
    for (const attr of attrResult.rows) {
      fields.push({ value: attr.slug, label: attr.name, group: 'Attributes' });
    }
    res.json({ fields });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/import/upload — upload and parse spreadsheet
app.post('/api/admin/import/upload', adminAuth, importUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (rawData.length < 2) {
      return res.status(400).json({ error: 'File must have at least a header row and one data row' });
    }

    const headers = rawData[0].map(h => String(h).trim());
    const allRows = rawData.slice(1);
    const previewRows = allRows.slice(0, 5);
    const totalRows = allRows.length;

    const importSessionId = crypto.randomUUID();
    importSessions.set(importSessionId, {
      headers,
      allRows,
      fileName: req.file.originalname,
      createdAt: Date.now()
    });

    res.json({
      import_session_id: importSessionId,
      file_name: req.file.originalname,
      sheet_name: sheetName,
      headers,
      preview_rows: previewRows,
      total_rows: totalRows
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to parse file: ' + err.message });
  }
});

// POST /api/admin/import/validate — validate mapped data
app.post('/api/admin/import/validate', adminAuth, async (req, res) => {
  try {
    const { import_session_id, vendor_id, category_id, mapping, defaults } = req.body;

    const session = importSessions.get(import_session_id);
    if (!session) return res.status(400).json({ error: 'Import session expired. Please re-upload the file.' });

    // Look up vendor code
    const vendorResult = await pool.query('SELECT code FROM vendors WHERE id = $1', [vendor_id]);
    if (!vendorResult.rows.length) return res.status(400).json({ error: 'Vendor not found' });
    const vendorCode = vendorResult.rows[0].code.toUpperCase();

    // Load existing internal_skus for duplicate detection
    const existingSkus = new Set();
    const skuResult = await pool.query('SELECT internal_sku FROM skus');
    skuResult.rows.forEach(r => existingSkus.add(r.internal_sku));

    // Load attribute IDs
    const attrResult = await pool.query('SELECT id, slug FROM attributes');
    const attrMap = {};
    attrResult.rows.forEach(r => { attrMap[r.slug] = r.id; });

    // Load categories for per-row category mapping
    const catResult = await pool.query('SELECT id, name, slug FROM categories');
    const categoryLookup = {};
    catResult.rows.forEach(c => {
      categoryLookup[c.name.toLowerCase().trim()] = c.id;
      categoryLookup[c.slug.toLowerCase().trim()] = c.id;
    });

    const seenInBatch = new Set();
    const rows = [];
    let validCount = 0;
    let errorCount = 0;

    for (let i = 0; i < session.allRows.length; i++) {
      const raw = session.allRows[i];
      const mapped = applyMapping(raw, mapping);

      // Skip completely empty rows
      const hasData = Object.values(mapped).some(v => v !== '');
      if (!hasData) continue;

      const errors = [];

      // Require vendor_sku or name
      if (!mapped.vendor_sku && !mapped.name) {
        errors.push('Missing vendor SKU and product name');
      }

      // Resolve per-row category
      if (mapped.category && mapped.category !== '') {
        const catKey = mapped.category.toLowerCase().trim();
        if (categoryLookup[catKey]) {
          mapped._category_id = categoryLookup[catKey];
        } else if (!category_id) {
          errors.push('Unknown category: "' + mapped.category + '" and no default set');
        }
        // else: falls back to default category_id
      }

      // Generate internal_sku
      const rawSku = mapped.internal_sku || (mapped.vendor_sku || '');
      const internalSku = mapped.internal_sku || (vendorCode + '-' + rawSku).toUpperCase().replace(/\s+/g, '-');
      mapped._internal_sku = internalSku;

      // Check duplicates
      if (existingSkus.has(internalSku)) {
        errors.push('Duplicate: ' + internalSku + ' already exists in database');
      } else if (seenInBatch.has(internalSku)) {
        errors.push('Duplicate: ' + internalSku + ' appears earlier in this file');
      }
      seenInBatch.add(internalSku);

      // Validate numeric fields
      const numericFields = ['cost', 'retail_price', 'sqft_per_box', 'pieces_per_box', 'weight_per_box_lbs', 'freight_class'];
      for (const field of numericFields) {
        if (mapped[field] && mapped[field] !== '') {
          const cleaned = String(mapped[field]).replace(/[$,]/g, '');
          const num = parseFloat(cleaned);
          if (isNaN(num)) {
            errors.push(field + ': invalid number "' + mapped[field] + '"');
          } else {
            mapped[field] = cleaned;
          }
        }
      }

      const status = errors.length > 0 ? 'error' : 'valid';
      if (status === 'valid') validCount++;
      else errorCount++;

      rows.push({
        row_number: i + 1,
        status,
        errors,
        data: mapped
      });
    }

    res.json({
      total_rows: rows.length,
      valid_count: validCount,
      error_count: errorCount,
      rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/import/execute — bulk import products
app.post('/api/admin/import/execute', adminAuth, async (req, res) => {
  try {
    const { import_session_id, vendor_id, category_id, mapping, defaults } = req.body;
    const defaultStatus = (defaults && defaults.status) || 'draft';
    const defaultSellBy = (defaults && defaults.sell_by) || 'sqft';
    const defaultPriceBasis = (defaults && defaults.price_basis) || 'per_sqft';

    const session = importSessions.get(import_session_id);
    if (!session) return res.status(400).json({ error: 'Import session expired. Please re-upload the file.' });

    // Look up vendor code
    const vendorResult = await pool.query('SELECT code FROM vendors WHERE id = $1', [vendor_id]);
    if (!vendorResult.rows.length) return res.status(400).json({ error: 'Vendor not found' });
    const vendorCode = vendorResult.rows[0].code.toUpperCase();

    // Load existing internal_skus
    const existingSkus = new Set();
    const skuResult = await pool.query('SELECT internal_sku FROM skus');
    skuResult.rows.forEach(r => existingSkus.add(r.internal_sku));

    // Load attribute IDs
    const attrResult = await pool.query('SELECT id, slug FROM attributes');
    const attrMap = {};
    attrResult.rows.forEach(r => { attrMap[r.slug] = r.id; });

    const client = await pool.connect();
    const results = { imported: 0, skipped: 0, errors: [] };

    try {
      await client.query('BEGIN');

      for (let i = 0; i < session.allRows.length; i++) {
        const raw = session.allRows[i];
        const mapped = applyMapping(raw, mapping);

        // Skip empty rows
        const hasData = Object.values(mapped).some(v => v !== '');
        if (!hasData) { results.skipped++; continue; }

        // Generate internal_sku
        const internalSku = mapped.internal_sku || (vendorCode + '-' + (mapped.vendor_sku || '')).toUpperCase().replace(/\s+/g, '-');

        // Skip duplicates
        if (existingSkus.has(internalSku)) {
          results.skipped++;
          results.errors.push({ row: i + 1, error: 'Duplicate SKU: ' + internalSku });
          continue;
        }

        // Validate required fields
        if (!mapped.vendor_sku && !mapped.name) {
          results.skipped++;
          results.errors.push({ row: i + 1, error: 'Missing vendor SKU and product name' });
          continue;
        }

        // Parse numeric fields
        const cost = mapped.cost ? parseFloat(String(mapped.cost).replace(/[$,]/g, '')) : null;
        const retailPrice = mapped.retail_price ? parseFloat(String(mapped.retail_price).replace(/[$,]/g, '')) : null;
        const sqftPerBox = mapped.sqft_per_box ? parseFloat(String(mapped.sqft_per_box).replace(/[$,]/g, '')) : null;
        const piecesPerBox = mapped.pieces_per_box ? parseInt(String(mapped.pieces_per_box).replace(/[$,]/g, '')) : null;
        const weightPerBox = mapped.weight_per_box_lbs ? parseFloat(String(mapped.weight_per_box_lbs).replace(/[$,]/g, '')) : null;
        const freightClass = mapped.freight_class ? parseInt(String(mapped.freight_class)) : 70;

        // Skip if any critical numeric field is NaN
        if ((mapped.cost && isNaN(cost)) || (mapped.retail_price && isNaN(retailPrice))) {
          results.skipped++;
          results.errors.push({ row: i + 1, error: 'Invalid price value' });
          continue;
        }

        // INSERT product
        const productResult = await client.query(`
          INSERT INTO products (vendor_id, name, collection, category_id, status, description_short, description_long)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id
        `, [
          vendor_id,
          mapped.name || mapped.vendor_sku || internalSku,
          mapped.collection || null,
          category_id,
          defaultStatus,
          mapped.description_short || null,
          mapped.description_long || null
        ]);
        const productId = productResult.rows[0].id;

        // INSERT sku
        const skuInsert = await client.query(`
          INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id
        `, [
          productId,
          mapped.vendor_sku || internalSku,
          internalSku,
          mapped.variant_name || null,
          mapped.sell_by || defaultSellBy
        ]);
        const skuId = skuInsert.rows[0].id;

        // INSERT packaging
        if (sqftPerBox != null || piecesPerBox != null || weightPerBox != null) {
          await client.query(`
            INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs, freight_class, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `, [skuId, sqftPerBox, piecesPerBox, weightPerBox, freightClass, mapped.boxes_per_pallet || null, mapped.sqft_per_pallet || null, mapped.weight_per_pallet_lbs || null]);
        }

        // INSERT pricing
        if (cost != null || retailPrice != null) {
          await client.query(`
            INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
            VALUES ($1, $2, $3, $4)
          `, [skuId, cost || 0, retailPrice || 0, mapped.price_basis || defaultPriceBasis]);
        }

        // INSERT sku_attributes (EAV fields)
        const eavFields = ['color', 'material', 'finish', 'size', 'thickness'];
        for (const field of eavFields) {
          if (mapped[field] && mapped[field] !== '' && attrMap[field]) {
            await client.query(`
              INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
            `, [skuId, attrMap[field], mapped[field]]);
          }
        }

        existingSkus.add(internalSku);
        results.imported++;
      }

      await client.query('COMMIT');
      importSessions.delete(import_session_id);
      res.json({ results });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: 'Import failed: ' + err.message, results });
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/import/templates — save a mapping template
app.post('/api/admin/import/templates', adminAuth, async (req, res) => {
  try {
    const { vendor_id, name, mapping } = req.body;
    if (!vendor_id || !name || !mapping) return res.status(400).json({ error: 'vendor_id, name, and mapping are required' });
    const result = await pool.query(`
      INSERT INTO import_mapping_templates (vendor_id, name, mapping)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [vendor_id, name, JSON.stringify(mapping)]);
    res.json({ template: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/import/templates — list templates
app.get('/api/admin/import/templates', adminAuth, async (req, res) => {
  try {
    const { vendor_id } = req.query;
    let query = 'SELECT * FROM import_mapping_templates';
    const params = [];
    if (vendor_id) { query += ' WHERE vendor_id = $1'; params.push(vendor_id); }
    query += ' ORDER BY updated_at DESC';
    const result = await pool.query(query, params);
    res.json({ templates: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/import/templates/:id — delete a template
app.delete('/api/admin/import/templates/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM import_mapping_templates WHERE id = $1 RETURNING id', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Template not found' });
    res.json({ deleted: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Scraper API ====================

// Run a scraper for a given vendor source (async — does not await completion)
async function runScraper(source) {
  // Create job row
  const jobResult = await pool.query(`
    INSERT INTO scrape_jobs (vendor_source_id, status, started_at)
    VALUES ($1, 'running', CURRENT_TIMESTAMP)
    RETURNING *
  `, [source.id]);
  const job = jobResult.rows[0];

  // Run in background
  (async () => {
    try {
      const scraperModule = await import(`./scrapers/${source.scraper_key}.js`);
      await scraperModule.run(pool, job, source);
      await pool.query(`
        UPDATE scrape_jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = $1
      `, [job.id]);
      await pool.query(`
        UPDATE vendor_sources SET last_scraped_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1
      `, [source.id]);
    } catch (err) {
      console.error(`Scraper ${source.scraper_key} failed:`, err.message);
      await pool.query(`
        UPDATE scrape_jobs SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
          errors = errors || $2::jsonb
        WHERE id = $1
      `, [job.id, JSON.stringify([{ message: err.message, time: new Date().toISOString() }])]);
    }
  })();

  return job;
}

// List vendor sources with last job info
app.get('/api/admin/vendor-sources', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT vs.*,
        v.name as vendor_name,
        (SELECT row_to_json(j) FROM (
          SELECT sj.id, sj.status, sj.started_at, sj.completed_at,
            sj.products_found, sj.products_created, sj.products_updated
          FROM scrape_jobs sj WHERE sj.vendor_source_id = vs.id
          ORDER BY sj.created_at DESC LIMIT 1
        ) j) as last_job
      FROM vendor_sources vs
      JOIN vendors v ON v.id = vs.vendor_id
      ORDER BY vs.created_at DESC
    `);
    res.json({ sources: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create vendor source
app.post('/api/admin/vendor-sources', adminAuth, async (req, res) => {
  try {
    const { vendor_id, source_type, name, base_url, config, scraper_key, schedule } = req.body;
    if (!vendor_id || !name || !base_url) {
      return res.status(400).json({ error: 'vendor_id, name, and base_url are required' });
    }
    const result = await pool.query(`
      INSERT INTO vendor_sources (vendor_id, source_type, name, base_url, config, scraper_key, schedule)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [vendor_id, source_type || 'website', name, base_url,
        JSON.stringify(config || {}), scraper_key || null, schedule || null]);
    res.json({ source: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update vendor source
app.put('/api/admin/vendor-sources/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, base_url, config, scraper_key, schedule, is_active, source_type } = req.body;
    const result = await pool.query(`
      UPDATE vendor_sources SET
        name = COALESCE($1, name),
        base_url = COALESCE($2, base_url),
        config = COALESCE($3, config),
        scraper_key = COALESCE($4, scraper_key),
        schedule = $5,
        is_active = COALESCE($6, is_active),
        source_type = COALESCE($7, source_type),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
      RETURNING *
    `, [name, base_url, config ? JSON.stringify(config) : null, scraper_key,
        schedule !== undefined ? schedule : null, is_active, source_type, id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Source not found' });
    res.json({ source: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete vendor source
app.delete('/api/admin/vendor-sources/:id', adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('BEGIN');
    await client.query('DELETE FROM scrape_jobs WHERE vendor_source_id = $1', [id]);
    const result = await client.query('DELETE FROM vendor_sources WHERE id = $1 RETURNING id', [id]);
    await client.query('COMMIT');
    if (!result.rows.length) return res.status(404).json({ error: 'Source not found' });
    res.json({ deleted: id });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Trigger manual scrape
app.post('/api/admin/vendor-sources/:id/scrape', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const sourceResult = await pool.query('SELECT * FROM vendor_sources WHERE id = $1', [id]);
    if (!sourceResult.rows.length) return res.status(404).json({ error: 'Source not found' });
    const source = sourceResult.rows[0];
    if (!source.scraper_key) {
      return res.status(400).json({ error: 'No scraper_key configured for this source' });
    }
    const job = await runScraper(source);
    res.json({ job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List scrape jobs (paginated)
app.get('/api/admin/scrape-jobs', adminAuth, async (req, res) => {
  try {
    const { vendor_source_id, limit, offset } = req.query;
    let query = `
      SELECT sj.*, vs.name as source_name, v.name as vendor_name
      FROM scrape_jobs sj
      JOIN vendor_sources vs ON vs.id = sj.vendor_source_id
      JOIN vendors v ON v.id = vs.vendor_id
    `;
    const params = [];
    let paramIdx = 1;

    if (vendor_source_id) {
      query += ` WHERE sj.vendor_source_id = $${paramIdx}`;
      params.push(vendor_source_id);
      paramIdx++;
    }

    query += ' ORDER BY sj.created_at DESC';
    query += ` LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    params.push(parseInt(limit) || 20, parseInt(offset) || 0);

    const result = await pool.query(query, params);
    res.json({ jobs: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single scrape job detail
app.get('/api/admin/scrape-jobs/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT sj.*, vs.name as source_name, v.name as vendor_name
      FROM scrape_jobs sj
      JOIN vendor_sources vs ON vs.id = sj.vendor_source_id
      JOIN vendors v ON v.id = vs.vendor_id
      WHERE sj.id = $1
    `, [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Job not found' });
    res.json({ job: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Sales Rep Auth Helpers ====================

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
    res.status(500).json({ error: err.message });
  }
}

// ==================== Rep Auth Endpoints ====================

app.post('/api/rep/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const result = await pool.query('SELECT * FROM sales_reps WHERE email = $1', [email.toLowerCase().trim()]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid email or password' });

    const rep = result.rows[0];
    if (!rep.is_active) return res.status(403).json({ error: 'Account deactivated' });
    if (!verifyPassword(password, rep.password_hash, rep.password_salt)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await pool.query(
      'INSERT INTO rep_sessions (rep_id, token, expires_at) VALUES ($1, $2, $3)',
      [rep.id, token, expiresAt]
    );

    res.json({
      token,
      rep: { id: rep.id, email: rep.email, first_name: rep.first_name, last_name: rep.last_name }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rep/logout', repAuth, async (req, res) => {
  try {
    const token = req.headers['x-rep-token'];
    await pool.query('DELETE FROM rep_sessions WHERE token = $1', [token]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rep/me', repAuth, async (req, res) => {
  res.json({ rep: req.rep });
});

// ==================== Rep Dashboard ====================

app.get('/api/rep/dashboard', repAuth, async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM orders) as total_orders,
        (SELECT COUNT(*)::int FROM orders WHERE sales_rep_id = $1) as my_orders,
        (SELECT COUNT(*)::int FROM orders WHERE status = 'pending') as pending_orders,
        (SELECT COUNT(*)::int FROM orders WHERE status = 'confirmed') as confirmed_orders,
        (SELECT COUNT(*)::int FROM orders WHERE status = 'shipped') as shipped_orders,
        (SELECT COUNT(*)::int FROM quotes WHERE sales_rep_id = $1) as my_quotes,
        (SELECT COUNT(*)::int FROM quotes WHERE sales_rep_id = $1 AND status = 'draft') as draft_quotes
    `, [req.rep.id]);

    const recentOrders = await pool.query(`
      SELECT o.id, o.order_number, o.customer_name, o.total, o.status, o.created_at,
        sr.first_name || ' ' || sr.last_name as rep_name,
        (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) as item_count
      FROM orders o
      LEFT JOIN sales_reps sr ON sr.id = o.sales_rep_id
      ORDER BY o.created_at DESC LIMIT 10
    `);

    res.json({ stats: stats.rows[0], recent_orders: recentOrders.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Rep Order Endpoints ====================

app.get('/api/rep/orders', repAuth, async (req, res) => {
  try {
    const { status, search, mine } = req.query;
    let query = `
      SELECT o.*,
        sr.first_name || ' ' || sr.last_name as rep_name,
        (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) as item_count
      FROM orders o
      LEFT JOIN sales_reps sr ON sr.id = o.sales_rep_id
      WHERE 1=1
    `;
    const params = [];
    let idx = 1;

    if (status) {
      query += ` AND o.status = $${idx}`;
      params.push(status);
      idx++;
    }
    if (mine === 'true') {
      query += ` AND o.sales_rep_id = $${idx}`;
      params.push(req.rep.id);
      idx++;
    }
    if (search) {
      query += ` AND (o.customer_name ILIKE $${idx} OR o.customer_email ILIKE $${idx} OR o.order_number ILIKE $${idx})`;
      params.push('%' + search + '%');
      idx++;
    }

    query += ' ORDER BY o.created_at DESC';
    const result = await pool.query(query, params);
    res.json({ orders: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rep/orders/:id', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const order = await pool.query(`
      SELECT o.*, sr.first_name || ' ' || sr.last_name as rep_name
      FROM orders o
      LEFT JOIN sales_reps sr ON sr.id = o.sales_rep_id
      WHERE o.id = $1
    `, [id]);
    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });

    const items = await pool.query(`
      SELECT oi.*, p.name as current_product_name, p.collection as current_collection
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1
      ORDER BY oi.id
    `, [id]);

    // Get price adjustment history for each item
    const adjustments = await pool.query(`
      SELECT opa.*, sr.first_name || ' ' || sr.last_name as rep_name
      FROM order_price_adjustments opa
      JOIN sales_reps sr ON sr.id = opa.rep_id
      WHERE opa.order_item_id = ANY(SELECT id FROM order_items WHERE order_id = $1)
      ORDER BY opa.created_at DESC
    `, [id]);

    res.json({
      order: order.rows[0],
      items: items.rows,
      price_adjustments: adjustments.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rep/orders/:id/status', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { status } = req.body;
    const validStatuses = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    await client.query('BEGIN');

    const result = await client.query(
      'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    // Auto-generate POs when order becomes confirmed (idempotency guard)
    if (status === 'confirmed') {
      const existing = await client.query('SELECT id FROM purchase_orders WHERE order_id = $1 LIMIT 1', [id]);
      if (existing.rows.length === 0) {
        await generatePurchaseOrders(id, client);
      }
    }

    await client.query('COMMIT');
    const updatedOrder = result.rows[0];
    res.json({ order: updatedOrder });

    // Fire-and-forget: send status update email for shipped/delivered/cancelled
    setImmediate(() => sendOrderStatusUpdate(updatedOrder, status));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/rep/orders/:id/assign', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE orders SET sales_rep_id = $1 WHERE id = $2 RETURNING *',
      [req.rep.id, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json({ order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rep/orders/:id/items/:itemId/price', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id, itemId } = req.params;
    const { unit_price, reason } = req.body;
    if (unit_price == null) return res.status(400).json({ error: 'unit_price is required' });

    const newPrice = parseFloat(unit_price);
    if (isNaN(newPrice) || newPrice < 0) return res.status(400).json({ error: 'Invalid price' });

    await client.query('BEGIN');

    // Get current item
    const item = await client.query(
      'SELECT * FROM order_items WHERE id = $1 AND order_id = $2',
      [itemId, id]
    );
    if (!item.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order item not found' });
    }

    const current = item.rows[0];
    const prevPrice = parseFloat(current.unit_price || 0);
    const prevSubtotal = parseFloat(current.subtotal || 0);
    const newSubtotal = current.is_sample ? 0 : parseFloat((newPrice * current.num_boxes).toFixed(2));

    // Record adjustment
    await client.query(`
      INSERT INTO order_price_adjustments (order_item_id, rep_id, previous_unit_price, new_unit_price, previous_subtotal, new_subtotal, reason)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [itemId, req.rep.id, prevPrice, newPrice, prevSubtotal, newSubtotal, reason || null]);

    // Update item
    await client.query(
      'UPDATE order_items SET unit_price = $1, subtotal = $2 WHERE id = $3',
      [newPrice.toFixed(2), newSubtotal.toFixed(2), itemId]
    );

    // Recalculate order totals
    const totalsResult = await client.query(`
      SELECT
        COALESCE(SUM(CASE WHEN NOT is_sample THEN subtotal ELSE 0 END), 0) as new_subtotal
      FROM order_items WHERE order_id = $1
    `, [id]);
    const orderSubtotal = parseFloat(parseFloat(totalsResult.rows[0].new_subtotal).toFixed(2));

    const orderRow = await client.query('SELECT shipping, sample_shipping FROM orders WHERE id = $1', [id]);
    const shipping = parseFloat(orderRow.rows[0].shipping || 0);
    const sampleShipping = parseFloat(orderRow.rows[0].sample_shipping || 0);
    const orderTotal = parseFloat((orderSubtotal + shipping + sampleShipping).toFixed(2));

    await client.query(
      'UPDATE orders SET subtotal = $1, total = $2 WHERE id = $3',
      [orderSubtotal.toFixed(2), orderTotal.toFixed(2), id]
    );

    await client.query('COMMIT');

    // Return updated order + items
    const updatedOrder = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    const updatedItems = await pool.query(`
      SELECT oi.*, p.name as current_product_name, p.collection as current_collection
      FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1 ORDER BY oi.id
    `, [id]);
    const adjustments = await pool.query(`
      SELECT opa.*, sr.first_name || ' ' || sr.last_name as rep_name
      FROM order_price_adjustments opa
      JOIN sales_reps sr ON sr.id = opa.rep_id
      WHERE opa.order_item_id = ANY(SELECT oi2.id FROM order_items oi2 WHERE oi2.order_id = $1)
      ORDER BY opa.created_at DESC
    `, [id]);

    res.json({ order: updatedOrder.rows[0], items: updatedItems.rows, price_adjustments: adjustments.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==================== Rep Purchase Order Endpoints ====================

// List POs for an order
app.get('/api/rep/orders/:id/purchase-orders', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const pos = await pool.query(`
      SELECT po.*, v.name as vendor_name, v.code as vendor_code,
        sr.first_name || ' ' || sr.last_name as approved_by_name
      FROM purchase_orders po
      JOIN vendors v ON v.id = po.vendor_id
      LEFT JOIN sales_reps sr ON sr.id = po.approved_by
      WHERE po.order_id = $1
      ORDER BY po.created_at
    `, [id]);

    const poIds = pos.rows.map(p => p.id);
    let items = [];
    if (poIds.length > 0) {
      const itemsResult = await pool.query(`
        SELECT poi.* FROM purchase_order_items poi
        WHERE poi.purchase_order_id = ANY($1)
        ORDER BY poi.created_at
      `, [poIds]);
      items = itemsResult.rows;
    }

    // Attach items to their POs
    const result = pos.rows.map(po => ({
      ...po,
      items: items.filter(i => i.purchase_order_id === po.id)
    }));

    res.json({ purchase_orders: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update cost on a draft PO item
app.put('/api/rep/purchase-orders/:poId/items/:itemId', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { poId, itemId } = req.params;
    const { cost } = req.body;

    if (cost == null) return res.status(400).json({ error: 'cost is required' });
    const newCost = parseFloat(cost);
    if (isNaN(newCost) || newCost < 0) return res.status(400).json({ error: 'Invalid cost' });

    // Verify PO is draft
    const po = await client.query('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
    if (!po.rows.length) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.rows[0].status !== 'draft') {
      return res.status(400).json({ error: 'Only draft POs can be edited' });
    }

    await client.query('BEGIN');

    // Get item and update
    const item = await client.query('SELECT * FROM purchase_order_items WHERE id = $1 AND purchase_order_id = $2', [itemId, poId]);
    if (!item.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'PO item not found' });
    }

    const itemSubtotal = newCost * item.rows[0].qty;
    await client.query(
      'UPDATE purchase_order_items SET cost = $1, subtotal = $2 WHERE id = $3',
      [newCost.toFixed(2), itemSubtotal.toFixed(2), itemId]
    );

    // Recalculate PO subtotal
    const totals = await client.query(
      'SELECT COALESCE(SUM(subtotal), 0) as total FROM purchase_order_items WHERE purchase_order_id = $1',
      [poId]
    );
    await client.query(
      'UPDATE purchase_orders SET subtotal = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [parseFloat(totals.rows[0].total).toFixed(2), poId]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Approve & send PO
app.post('/api/rep/purchase-orders/:poId/approve', repAuth, async (req, res) => {
  try {
    const { poId } = req.params;
    const po = await pool.query('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
    if (!po.rows.length) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.rows[0].status !== 'draft') {
      return res.status(400).json({ error: 'Only draft POs can be approved' });
    }

    const result = await pool.query(`
      UPDATE purchase_orders SET status = 'sent', approved_by = $1, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 RETURNING *
    `, [req.rep.id, poId]);

    res.json({ purchase_order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel PO
app.post('/api/rep/purchase-orders/:poId/cancel', repAuth, async (req, res) => {
  try {
    const { poId } = req.params;
    const po = await pool.query('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
    if (!po.rows.length) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.rows[0].status === 'fulfilled') {
      return res.status(400).json({ error: 'Cannot cancel a fulfilled PO' });
    }
    if (po.rows[0].status === 'cancelled') {
      return res.status(400).json({ error: 'PO is already cancelled' });
    }

    const result = await pool.query(
      "UPDATE purchase_orders SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *",
      [poId]
    );

    res.json({ purchase_order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Rep Quote Endpoints ====================

app.get('/api/rep/quotes', repAuth, async (req, res) => {
  try {
    const { status, search } = req.query;
    let query = `
      SELECT q.*,
        sr.first_name || ' ' || sr.last_name as rep_name,
        (SELECT COUNT(*)::int FROM quote_items qi WHERE qi.quote_id = q.id) as item_count
      FROM quotes q
      LEFT JOIN sales_reps sr ON sr.id = q.sales_rep_id
      WHERE q.sales_rep_id = $1
    `;
    const params = [req.rep.id];
    let idx = 2;

    if (status) {
      query += ` AND q.status = $${idx}`;
      params.push(status);
      idx++;
    }
    if (search) {
      query += ` AND (q.customer_name ILIKE $${idx} OR q.customer_email ILIKE $${idx} OR q.quote_number ILIKE $${idx})`;
      params.push('%' + search + '%');
      idx++;
    }

    query += ' ORDER BY q.created_at DESC';
    const result = await pool.query(query, params);
    res.json({ quotes: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rep/quotes', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { customer_name, customer_email, phone, shipping_address_line1, shipping_address_line2,
            shipping_city, shipping_state, shipping_zip, notes, items, delivery_method } = req.body;
    if (!customer_name || !customer_email) {
      return res.status(400).json({ error: 'Customer name and email are required' });
    }

    const quoteNumber = 'QT-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();

    await client.query('BEGIN');

    const quoteResult = await client.query(`
      INSERT INTO quotes (quote_number, sales_rep_id, customer_name, customer_email, phone,
        shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip, notes, delivery_method)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `, [quoteNumber, req.rep.id, customer_name, customer_email.toLowerCase().trim(), phone || null,
        shipping_address_line1 || null, shipping_address_line2 || null,
        shipping_city || null, shipping_state || null, shipping_zip || null, notes || null,
        delivery_method || 'shipping']);

    const quote = quoteResult.rows[0];

    // Insert items if provided
    if (items && items.length > 0) {
      for (const item of items) {
        await client.query(`
          INSERT INTO quote_items (quote_id, product_id, sku_id, product_name, collection, description, sqft_needed, num_boxes, unit_price, subtotal, sell_by, is_sample)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [quote.id, item.product_id || null, item.sku_id || null,
            item.product_name || null, item.collection || null,
            item.description || null,
            item.sqft_needed || null, item.num_boxes || 1,
            parseFloat(item.unit_price || 0).toFixed(2),
            parseFloat(item.subtotal || 0).toFixed(2),
            item.sell_by || null,
            item.is_sample || false]);
      }

      // Recalculate totals
      const totals = await client.query(`
        SELECT COALESCE(SUM(subtotal), 0) as subtotal FROM quote_items WHERE quote_id = $1
      `, [quote.id]);
      const subtotal = parseFloat(parseFloat(totals.rows[0].subtotal).toFixed(2));
      await client.query(
        'UPDATE quotes SET subtotal = $1, total = $1 WHERE id = $2',
        [subtotal.toFixed(2), quote.id]
      );
    }

    await client.query('COMMIT');

    // Return full quote with items
    const fullQuote = await pool.query('SELECT * FROM quotes WHERE id = $1', [quote.id]);
    const quoteItems = await pool.query('SELECT * FROM quote_items WHERE quote_id = $1', [quote.id]);
    res.json({ quote: fullQuote.rows[0], items: quoteItems.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/rep/quotes/:id', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const quote = await pool.query(`
      SELECT q.*, sr.first_name || ' ' || sr.last_name as rep_name
      FROM quotes q LEFT JOIN sales_reps sr ON sr.id = q.sales_rep_id
      WHERE q.id = $1
    `, [id]);
    if (!quote.rows.length) return res.status(404).json({ error: 'Quote not found' });

    const items = await pool.query('SELECT * FROM quote_items WHERE quote_id = $1 ORDER BY id', [id]);
    res.json({ quote: quote.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rep/quotes/:id', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { customer_name, customer_email, phone, shipping_address_line1, shipping_address_line2,
            shipping_city, shipping_state, shipping_zip, notes, shipping, delivery_method } = req.body;

    const result = await pool.query(`
      UPDATE quotes SET
        customer_name = COALESCE($1, customer_name),
        customer_email = COALESCE($2, customer_email),
        phone = COALESCE($3, phone),
        shipping_address_line1 = COALESCE($4, shipping_address_line1),
        shipping_address_line2 = COALESCE($5, shipping_address_line2),
        shipping_city = COALESCE($6, shipping_city),
        shipping_state = COALESCE($7, shipping_state),
        shipping_zip = COALESCE($8, shipping_zip),
        notes = COALESCE($9, notes),
        shipping = COALESCE($10, shipping),
        delivery_method = COALESCE($12, delivery_method),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $11
      RETURNING *
    `, [customer_name, customer_email, phone, shipping_address_line1, shipping_address_line2,
        shipping_city, shipping_state, shipping_zip, notes, shipping, id, delivery_method]);

    if (!result.rows.length) return res.status(404).json({ error: 'Quote not found' });

    // Recalculate total
    const q = result.rows[0];
    const total = parseFloat((parseFloat(q.subtotal || 0) + parseFloat(q.shipping || 0)).toFixed(2));
    await pool.query('UPDATE quotes SET total = $1 WHERE id = $2', [total.toFixed(2), id]);
    q.total = total.toFixed(2);

    res.json({ quote: q });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rep/quotes/:id/items', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { product_id, sku_id, product_name, collection, description, sqft_needed, num_boxes, unit_price, subtotal, sell_by, is_sample } = req.body;

    await client.query('BEGIN');

    const itemResult = await client.query(`
      INSERT INTO quote_items (quote_id, product_id, sku_id, product_name, collection, description, sqft_needed, num_boxes, unit_price, subtotal, sell_by, is_sample)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `, [id, product_id || null, sku_id || null, product_name || null, collection || null,
        description || null,
        sqft_needed || null, num_boxes || 1,
        parseFloat(unit_price || 0).toFixed(2),
        parseFloat(subtotal || 0).toFixed(2),
        sell_by || null,
        is_sample || false]);

    // Recalculate quote totals
    const totals = await client.query(
      'SELECT COALESCE(SUM(subtotal), 0) as sub FROM quote_items WHERE quote_id = $1', [id]
    );
    const newSubtotal = parseFloat(parseFloat(totals.rows[0].sub).toFixed(2));
    const quoteRow = await client.query('SELECT shipping FROM quotes WHERE id = $1', [id]);
    const shippingVal = parseFloat(quoteRow.rows[0].shipping || 0);
    const newTotal = parseFloat((newSubtotal + shippingVal).toFixed(2));

    await client.query(
      'UPDATE quotes SET subtotal = $1, total = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [newSubtotal.toFixed(2), newTotal.toFixed(2), id]
    );

    await client.query('COMMIT');
    res.json({ item: itemResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/rep/quotes/:id/items/:itemId', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id, itemId } = req.params;
    const { num_boxes, unit_price, sqft_needed, subtotal, product_name, collection, description, sell_by } = req.body;

    await client.query('BEGIN');

    const result = await client.query(`
      UPDATE quote_items SET
        num_boxes = COALESCE($1, num_boxes),
        unit_price = COALESCE($2, unit_price),
        sqft_needed = COALESCE($3, sqft_needed),
        subtotal = COALESCE($4, subtotal),
        product_name = COALESCE($7, product_name),
        collection = COALESCE($8, collection),
        description = COALESCE($9, description),
        sell_by = COALESCE($10, sell_by)
      WHERE id = $5 AND quote_id = $6
      RETURNING *
    `, [num_boxes, unit_price, sqft_needed, subtotal, itemId, id, product_name, collection, description, sell_by]);

    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Quote item not found' });
    }

    // Recalculate
    const totals = await client.query(
      'SELECT COALESCE(SUM(subtotal), 0) as sub FROM quote_items WHERE quote_id = $1', [id]
    );
    const newSubtotal = parseFloat(parseFloat(totals.rows[0].sub).toFixed(2));
    const quoteRow = await client.query('SELECT shipping FROM quotes WHERE id = $1', [id]);
    const shippingVal = parseFloat(quoteRow.rows[0].shipping || 0);
    const newTotal = parseFloat((newSubtotal + shippingVal).toFixed(2));

    await client.query(
      'UPDATE quotes SET subtotal = $1, total = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [newSubtotal.toFixed(2), newTotal.toFixed(2), id]
    );

    await client.query('COMMIT');
    res.json({ item: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/rep/quotes/:id/items/:itemId', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id, itemId } = req.params;

    await client.query('BEGIN');

    const result = await client.query(
      'DELETE FROM quote_items WHERE id = $1 AND quote_id = $2 RETURNING id', [itemId, id]
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Quote item not found' });
    }

    // Recalculate
    const totals = await client.query(
      'SELECT COALESCE(SUM(subtotal), 0) as sub FROM quote_items WHERE quote_id = $1', [id]
    );
    const newSubtotal = parseFloat(parseFloat(totals.rows[0].sub).toFixed(2));
    const quoteRow = await client.query('SELECT shipping FROM quotes WHERE id = $1', [id]);
    const shippingVal = parseFloat(quoteRow.rows[0].shipping || 0);
    const newTotal = parseFloat((newSubtotal + shippingVal).toFixed(2));

    await client.query(
      'UPDATE quotes SET subtotal = $1, total = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [newSubtotal.toFixed(2), newTotal.toFixed(2), id]
    );

    await client.query('COMMIT');
    res.json({ deleted: itemId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/rep/quotes/:id/send', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const quote = await pool.query('SELECT * FROM quotes WHERE id = $1', [id]);
    if (!quote.rows.length) return res.status(404).json({ error: 'Quote not found' });

    const q = quote.rows[0];
    if (q.status !== 'draft' && q.status !== 'sent') {
      return res.status(400).json({ error: 'Quote cannot be sent in current status' });
    }

    // Mark as sent
    await pool.query(
      "UPDATE quotes SET status = 'sent', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [id]
    );

    // Fetch quote items for the email
    const quoteItems = await pool.query(
      'SELECT * FROM quote_items WHERE quote_id = $1 ORDER BY id', [id]
    );

    res.json({ success: true, message: 'Quote sent to ' + q.customer_email });

    // Fire-and-forget: send quote email to customer
    const emailData = {
      ...q,
      items: quoteItems.rows,
      rep_first_name: req.rep.first_name,
      rep_last_name: req.rep.last_name,
      rep_email: req.rep.email
    };
    setImmediate(() => sendQuoteSent(emailData));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rep/quotes/:id/convert', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { payment_method } = req.body;
    if (!payment_method || !['stripe', 'offline'].includes(payment_method)) {
      return res.status(400).json({ error: 'payment_method must be stripe or offline' });
    }

    const quoteResult = await client.query('SELECT * FROM quotes WHERE id = $1', [id]);
    if (!quoteResult.rows.length) {
      return res.status(404).json({ error: 'Quote not found' });
    }
    const q = quoteResult.rows[0];
    if (q.status === 'converted') {
      return res.status(400).json({ error: 'Quote already converted' });
    }

    const itemsResult = await client.query('SELECT * FROM quote_items WHERE quote_id = $1 ORDER BY id', [id]);
    if (itemsResult.rows.length === 0) {
      return res.status(400).json({ error: 'Quote has no items' });
    }

    await client.query('BEGIN');

    const orderNumber = 'ORD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();
    const orderStatus = payment_method === 'offline' ? 'confirmed' : 'pending';

    let stripePaymentIntentId = null;
    if (payment_method === 'stripe') {
      const totalCents = Math.round(parseFloat(q.total) * 100);
      if (totalCents > 0) {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: totalCents,
          currency: 'usd',
        });
        stripePaymentIntentId = paymentIntent.id;
      }
    }

    const isPickupQuote = q.delivery_method === 'pickup';
    const quoteShipping = isPickupQuote ? '0.00' : q.shipping;
    const quoteTotal = isPickupQuote ? parseFloat(parseFloat(q.subtotal || 0).toFixed(2)).toFixed(2) : q.total;

    const orderResult = await client.query(`
      INSERT INTO orders (order_number, customer_email, customer_name, phone,
        shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip,
        subtotal, shipping, total, status, sales_rep_id, payment_method, quote_id, stripe_payment_intent_id, delivery_method)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *
    `, [orderNumber, q.customer_email, q.customer_name, q.phone,
        isPickupQuote ? null : (q.shipping_address_line1 || ''),
        isPickupQuote ? null : q.shipping_address_line2,
        isPickupQuote ? null : (q.shipping_city || ''),
        isPickupQuote ? null : (q.shipping_state || ''),
        isPickupQuote ? null : (q.shipping_zip || ''),
        q.subtotal, quoteShipping, quoteTotal, orderStatus, req.rep.id, payment_method, id, stripePaymentIntentId,
        q.delivery_method || 'shipping']);

    const order = orderResult.rows[0];

    // Copy quote items to order items
    for (const item of itemsResult.rows) {
      await client.query(`
        INSERT INTO order_items (order_id, product_id, sku_id, product_name, collection, description, sqft_needed, num_boxes, unit_price, subtotal, sell_by, is_sample)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [order.id, item.product_id, item.sku_id, item.product_name, item.collection,
          item.description, item.sqft_needed, item.num_boxes, item.unit_price, item.subtotal, item.sell_by, item.is_sample]);
    }

    // Update quote status
    await client.query(
      "UPDATE quotes SET status = 'converted', converted_order_id = $1, payment_method = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3",
      [order.id, payment_method, id]
    );

    // Generate purchase orders if order is confirmed (offline payment)
    if (orderStatus === 'confirmed') {
      await generatePurchaseOrders(order.id, client);
    }

    await client.query('COMMIT');

    const orderItems = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
    res.json({ order: { ...order, items: orderItems.rows } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==================== Admin Rep CRUD ====================

app.get('/api/admin/reps', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sr.id, sr.email, sr.first_name, sr.last_name, sr.phone, sr.is_active, sr.created_at,
        (SELECT COUNT(*)::int FROM orders o WHERE o.sales_rep_id = sr.id) as assigned_orders
      FROM sales_reps sr
      ORDER BY sr.created_at DESC
    `);
    res.json({ reps: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reps', adminAuth, async (req, res) => {
  try {
    const { email, password, first_name, last_name, phone } = req.body;
    if (!email || !password || !first_name || !last_name) {
      return res.status(400).json({ error: 'Email, password, first name, and last name are required' });
    }

    const { hash, salt } = hashPassword(password);
    const result = await pool.query(`
      INSERT INTO sales_reps (email, password_hash, password_salt, first_name, last_name, phone)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, email, first_name, last_name, phone, is_active, created_at
    `, [email.toLowerCase().trim(), hash, salt, first_name, last_name, phone || null]);

    res.json({ rep: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'A rep with this email already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/reps/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { email, first_name, last_name, phone } = req.body;

    const result = await pool.query(`
      UPDATE sales_reps SET
        email = COALESCE($1, email),
        first_name = COALESCE($2, first_name),
        last_name = COALESCE($3, last_name),
        phone = COALESCE($4, phone),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING id, email, first_name, last_name, phone, is_active, created_at
    `, [email ? email.toLowerCase().trim() : null, first_name, last_name, phone, id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Rep not found' });
    res.json({ rep: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'A rep with this email already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/reps/:id/toggle', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      UPDATE sales_reps SET is_active = NOT is_active, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, email, first_name, last_name, phone, is_active, created_at
    `, [id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Rep not found' });

    // Kill sessions if deactivated
    if (!result.rows[0].is_active) {
      await pool.query('DELETE FROM rep_sessions WHERE rep_id = $1', [id]);
    }

    res.json({ rep: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/reps/:id/password', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password is required' });

    const { hash, salt } = hashPassword(password);
    const result = await pool.query(
      'UPDATE sales_reps SET password_hash = $1, password_salt = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING id',
      [hash, salt, id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Rep not found' });

    // Kill all sessions
    await pool.query('DELETE FROM rep_sessions WHERE rep_id = $1', [id]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin assign any rep to order
app.put('/api/admin/orders/:id/assign', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { sales_rep_id } = req.body;
    const result = await pool.query(
      'UPDATE orders SET sales_rep_id = $1 WHERE id = $2 RETURNING *',
      [sales_rep_id || null, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json({ order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Admin Purchase Order Endpoints ====================

// List POs for an order (admin)
app.get('/api/admin/orders/:id/purchase-orders', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const pos = await pool.query(`
      SELECT po.*, v.name as vendor_name, v.code as vendor_code,
        sr.first_name || ' ' || sr.last_name as approved_by_name
      FROM purchase_orders po
      JOIN vendors v ON v.id = po.vendor_id
      LEFT JOIN sales_reps sr ON sr.id = po.approved_by
      WHERE po.order_id = $1
      ORDER BY po.created_at
    `, [id]);

    const poIds = pos.rows.map(p => p.id);
    let items = [];
    if (poIds.length > 0) {
      const itemsResult = await pool.query(`
        SELECT poi.* FROM purchase_order_items poi
        WHERE poi.purchase_order_id = ANY($1)
        ORDER BY poi.created_at
      `, [poIds]);
      items = itemsResult.rows;
    }

    const result = pos.rows.map(po => ({
      ...po,
      items: items.filter(i => i.purchase_order_id === po.id)
    }));

    res.json({ purchase_orders: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update PO status (admin progression: sent→acknowledged→fulfilled, or cancel)
app.put('/api/admin/purchase-orders/:poId/status', adminAuth, async (req, res) => {
  try {
    const { poId } = req.params;
    const { status } = req.body;

    const validTransitions = {
      draft: ['sent', 'cancelled'],
      sent: ['acknowledged', 'cancelled'],
      acknowledged: ['fulfilled', 'cancelled'],
    };

    const po = await pool.query('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
    if (!po.rows.length) return res.status(404).json({ error: 'Purchase order not found' });

    const current = po.rows[0].status;
    if (current === 'fulfilled') return res.status(400).json({ error: 'Cannot change status of a fulfilled PO' });
    if (current === 'cancelled') return res.status(400).json({ error: 'Cannot change status of a cancelled PO' });

    const allowed = validTransitions[current] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `Cannot transition from ${current} to ${status}. Allowed: ${allowed.join(', ')}` });
    }

    const result = await pool.query(
      'UPDATE purchase_orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [status, poId]
    );

    res.json({ purchase_order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin edit cost on draft PO item
app.put('/api/admin/purchase-orders/:poId/items/:itemId', adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { poId, itemId } = req.params;
    const { cost } = req.body;

    if (cost == null) return res.status(400).json({ error: 'cost is required' });
    const newCost = parseFloat(cost);
    if (isNaN(newCost) || newCost < 0) return res.status(400).json({ error: 'Invalid cost' });

    const po = await client.query('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
    if (!po.rows.length) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.rows[0].status !== 'draft') {
      return res.status(400).json({ error: 'Only draft POs can be edited' });
    }

    await client.query('BEGIN');

    const item = await client.query('SELECT * FROM purchase_order_items WHERE id = $1 AND purchase_order_id = $2', [itemId, poId]);
    if (!item.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'PO item not found' });
    }

    const itemSubtotal = newCost * item.rows[0].qty;
    await client.query(
      'UPDATE purchase_order_items SET cost = $1, subtotal = $2 WHERE id = $3',
      [newCost.toFixed(2), itemSubtotal.toFixed(2), itemId]
    );

    const totals = await client.query(
      'SELECT COALESCE(SUM(subtotal), 0) as total FROM purchase_order_items WHERE purchase_order_id = $1',
      [poId]
    );
    await client.query(
      'UPDATE purchase_orders SET subtotal = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [parseFloat(totals.rows[0].total).toFixed(2), poId]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==================== Scheduler Init ====================

const scheduledTasks = new Map();

async function initScheduler() {
  try {
    const result = await pool.query(
      'SELECT * FROM vendor_sources WHERE is_active = true AND schedule IS NOT NULL'
    );
    for (const source of result.rows) {
      if (cron.validate(source.schedule)) {
        const task = cron.schedule(source.schedule, () => {
          console.log(`Scheduled scrape starting for: ${source.name}`);
          runScraper(source).catch(err => console.error(`Scheduled scrape failed for ${source.name}:`, err.message));
        });
        scheduledTasks.set(source.id, task);
        console.log(`Scheduled scrape for "${source.name}": ${source.schedule}`);
      }
    }
  } catch (err) {
    // Tables may not exist yet on first run
    console.log('Scheduler init skipped (tables may not exist yet):', err.message);
  }
}

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
  initScheduler();
});
