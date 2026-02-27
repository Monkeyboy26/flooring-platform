import express from 'express';
import cors from 'cors';
import pg from 'pg';
import crypto from 'crypto';
import Stripe from 'stripe';
import EasyPostClient from '@easypost/api';
import multer from 'multer';
import XLSX from 'xlsx';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand, GetObjectCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { sendOrderConfirmation, sendQuoteSent, sendOrderStatusUpdate, sendTradeApproval, sendTradeDenial, sendTierPromotion, send2FACode, sendRenewalReminder, sendSubscriptionWarning, sendSubscriptionLapsed, sendSubscriptionDeactivated, sendInstallationInquiryNotification, sendInstallationInquiryConfirmation, sendPasswordReset, sendPurchaseOrderToVendor, sendPaymentRequest, sendPaymentReceived, sendVisitRecap, sendSampleRequestConfirmation, sendSampleRequestShipped, sendScraperFailure, sendStockAlert } from './services/emailService.js';
import { generateQuoteSentHTML } from './templates/quoteSent.js';
import healthRoutes from './routes/health.js';
import { generate850 } from './services/ediGenerator.js';
import { createSftpConnection, uploadFile } from './services/ediSftp.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
const easypost = process.env.EASYPOST_API_KEY ? new EasyPostClient(process.env.EASYPOST_API_KEY) : null;

// Shipping configuration
const WEIGHT_THRESHOLD_LBS = 150; // parcel vs LTL cutoff
const SHIP_FROM = { zip: '92806', city: 'Anaheim', state: 'CA', country: 'US' };

// ==================== Document Helpers ====================

function getDocumentBaseCSS() {
  return `
    @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500;600&family=Inter:wght@300;400;500;600&display=swap');
    body { font-family: 'Inter', Arial, sans-serif; margin: 0; padding: 2rem; color: #1c1917; font-size: 13px; line-height: 1.5; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2rem; padding-bottom: 1.5rem; border-bottom: 2px solid #c8a97e; }
    .company { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 1.75rem; font-weight: 300; margin-bottom: 0.25rem; }
    .company-info { font-size: 0.75rem; color: #57534e; line-height: 1.6; }
    .doc-title { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 1.5rem; font-weight: 400; color: #c8a97e; }
    .doc-meta { font-size: 0.8125rem; color: #57534e; line-height: 1.8; text-align: right; }
    .info-block { margin-bottom: 1.5rem; padding: 1rem; background: #fafaf9; border: 1px solid #e7e5e4; }
    .info-block h3 { font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.1em; color: #78716c; margin: 0 0 0.5rem; }
    .info-columns { display: flex; gap: 2rem; margin-bottom: 1.5rem; }
    .info-columns .info-block { flex: 1; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; }
    th { background: #1c1917; color: #fff; padding: 0.625rem 0.75rem; text-align: left; font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.05em; }
    td { padding: 0.625rem 0.75rem; border-bottom: 1px solid #e7e5e4; font-size: 0.8125rem; }
    tr:nth-child(even) td { background: #fafaf9; }
    .totals { text-align: right; margin-top: 1rem; }
    .totals .line { display: flex; justify-content: flex-end; gap: 2rem; font-size: 0.875rem; padding: 0.25rem 0; }
    .totals .total-line { font-weight: 600; font-size: 1rem; border-top: 2px solid #1c1917; padding-top: 0.5rem; margin-top: 0.5rem; }
    .footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #e7e5e4; font-size: 0.6875rem; color: #78716c; text-align: center; }
    .badge { display: inline-block; padding: 2px 8px; font-size: 0.6875rem; font-weight: 600; text-transform: uppercase; border-radius: 3px; }
    .badge-status { background: #e7e5e4; color: #57534e; }
    .badge-revised { background: #fef3c7; color: #92400e; }
    .badge-sent { background: #dbeafe; color: #1e40af; }
    .badge-fulfilled { background: #dcfce7; color: #166534; }
    .badge-cancelled { background: #fee2e2; color: #991b1b; }
    .notes-section { margin-top: 1.5rem; padding: 1rem; background: #fafaf9; border: 1px solid #e7e5e4; }
    .notes-section h4 { font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.1em; color: #78716c; margin: 0 0 0.5rem; }
  `;
}

function getDocumentHeader(title) {
  return `
    <div class="header">
      <div>
        <div class="company">Roma Flooring Designs</div>
        <div class="company-info">
          1440 S. State College Blvd #6M<br/>
          Anaheim, CA 92806<br/>
          (714) 999-0009<br/>
          Sales@romaflooringdesigns.com
        </div>
      </div>
      <div>
        <div class="doc-title">${title}</div>
      </div>
    </div>
  `;
}

function getDocumentFooter() {
  return `
    <div class="footer">
      <p>Roma Flooring Designs | License #830966 | www.romaflooringdesigns.com</p>
    </div>
  `;
}

async function generatePDF(html, filename, req, res) {
  // Preview mode: return HTML directly for iframe rendering
  if (req.query.preview === 'true') {
    res.set('Content-Type', 'text/html');
    return res.send(html);
  }
  try {
    const puppeteer = await import('puppeteer');
    const browser = await puppeteer.default.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const pdf = await page.pdf({ format: 'Letter', margin: { top: '0.75in', bottom: '0.75in', left: '0.75in', right: '0.75in' } });
    await browser.close();
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"` });
    res.send(pdf);
  } catch (pdfErr) {
    // Fallback: return HTML if Puppeteer unavailable
    res.set('Content-Type', 'text/html');
    res.send(html);
  }
}

async function generatePOHtml(poId) {
  const po = await pool.query(`
    SELECT po.*, v.name as vendor_name, v.code as vendor_code, v.email as vendor_email,
      sa.first_name || ' ' || sa.last_name as approved_by_name,
      o.order_number
    FROM purchase_orders po
    JOIN vendors v ON v.id = po.vendor_id
    LEFT JOIN staff_accounts sa ON sa.id = po.approved_by
    LEFT JOIN orders o ON o.id = po.order_id
    WHERE po.id = $1
  `, [poId]);
  if (!po.rows.length) return null;
  const p = po.rows[0];
  const items = await pool.query('SELECT * FROM purchase_order_items WHERE purchase_order_id = $1 ORDER BY created_at', [poId]);

  const html = `<!DOCTYPE html><html><head><style>
    ${getDocumentBaseCSS()}
  </style></head><body>
    ${getDocumentHeader('Purchase Order')}
    <div class="doc-meta" style="margin-top: -1.5rem; margin-bottom: 1.5rem;">
      <strong>${p.po_number}</strong>
      ${p.is_revised ? ' <span class="badge badge-revised">REVISED</span>' : ''}
      <br/>
      Date: ${new Date(p.created_at).toLocaleDateString()}
      ${p.order_number ? '<br/>Order: ' + p.order_number : ''}
    </div>
    <div class="info-columns">
      <div class="info-block">
        <h3>Vendor</h3>
        <strong>${p.vendor_name}</strong><br/>
        Code: ${p.vendor_code}
      </div>
      <div class="info-block">
        <h3>Ship To</h3>
        <strong>Roma Flooring Designs</strong><br/>
        1440 S. State College Blvd., Suite 6M<br/>
        Anaheim, CA 92806
      </div>
    </div>
    <table>
      <thead><tr>
        <th>Product</th><th>Vendor SKU</th>
        <th style="text-align:right">Qty</th>
        <th style="text-align:right">Cost</th><th style="text-align:right">Subtotal</th>
      </tr></thead>
      <tbody>
        ${items.rows.map(i => {
          return `<tr>
            <td>${i.product_name || ''}</td>
            <td>${i.vendor_sku || '—'}</td>
            <td style="text-align:right">${i.qty}</td>
            <td style="text-align:right">$${parseFloat(i.cost).toFixed(2)}</td>
            <td style="text-align:right">$${parseFloat(i.subtotal).toFixed(2)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    <div class="totals">
      <div class="line total-line"><span>PO Total:</span><span>$${parseFloat(p.subtotal || 0).toFixed(2)}</span></div>
    </div>
    ${p.notes ? `<div class="notes-section"><h4>Notes</h4><div>${p.notes}</div></div>` : ''}
    ${p.approved_by_name ? `<div style="margin-top:1rem;font-size:0.8125rem;color:#57534e;">Approved by ${p.approved_by_name} on ${new Date(p.approved_at).toLocaleDateString()}</div>` : ''}
    ${getDocumentFooter()}
  </body></html>`;

  return { html, po: p, items: items.rows };
}

async function generatePDFBuffer(html) {
  const puppeteer = await import('puppeteer');
  const browser = await puppeteer.default.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  const pdf = await page.pdf({ format: 'Letter', margin: { top: '0.75in', bottom: '0.75in', left: '0.75in', right: '0.75in' } });
  await browser.close();
  return Buffer.from(pdf);
}

function getNextBusinessDay() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1); // Sun → Mon
  if (d.getDay() === 6) d.setDate(d.getDate() + 2); // Sat → Mon
  return d.toISOString().split('T')[0];
}

// Pickup-only detection: slabs and prefab countertops cannot be shipped
function isPickupOnly(item) {
  if (item.variant_type === 'slab') return true;
  const vsku = (item.vendor_sku || '').toUpperCase();
  if (['RSL', 'VSL', 'CSL', 'PSL'].some(p => vsku.startsWith(p))) return true;
  const slug = (item.category_slug || '').toLowerCase();
  if (slug === 'prefab-countertops' || slug === 'countertops') return true;
  return false;
}

// ==================== Order Balance Helper ====================

async function recalculateBalance(orderId, client) {
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

// ==================== Order Activity Log Helper ====================

async function logOrderActivity(queryable, orderId, action, performerId, performerName, details = {}) {
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

// ==================== Rep Notification Helper ====================

async function createRepNotification(queryable, repId, type, title, message, entityType, entityId) {
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

async function notifyAllActiveReps(queryable, type, title, message, entityType, entityId) {
  try {
    const reps = await queryable.query('SELECT id FROM sales_reps WHERE is_active = true');
    for (const rep of reps.rows) {
      await createRepNotification(queryable, rep.id, type, title, message, entityType, entityId);
    }
  } catch (err) {
    console.error('Failed to notify all reps:', err.message);
  }
}

// ==================== Commission Recalculation Helper ====================

async function recalculateCommission(queryable, orderId) {
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

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres'
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/assets', express.static('assets'));
app.use(healthRoutes);

// ==================== S3/MinIO Client ====================
const S3_BUCKET = process.env.S3_BUCKET || 'trade-documents';
let s3 = null;
if (process.env.S3_ENDPOINT) {
  s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin',
      secretAccessKey: process.env.S3_SECRET_KEY || 'minioadmin'
    },
    forcePathStyle: true
  });
  // Ensure bucket exists
  (async () => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
    } catch {
      try {
        await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
        console.log(`[S3] Created bucket: ${S3_BUCKET}`);
      } catch (err) {
        console.error('[S3] Failed to create bucket:', err.message);
      }
    }
  })();
}

async function uploadToS3(fileKey, buffer, mimeType) {
  if (!s3) throw new Error('S3 not configured');
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: fileKey,
    Body: buffer,
    ContentType: mimeType
  }));
  return fileKey;
}

async function getPresignedUrl(fileKey) {
  if (!s3) throw new Error('S3 not configured');
  const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: fileKey });
  return getSignedUrl(s3, command, { expiresIn: 3600 });
}

const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

app.get('/api/products', optionalTradeAuth, async (req, res) => {
  try {
    const { category } = req.query;
    let query = `
      SELECT p.*, v.name as vendor_name, c.name as category_name, c.slug as category_slug,
        (SELECT pr.retail_price FROM pricing pr
         JOIN skus s ON s.id = pr.sku_id
         WHERE s.product_id = p.id LIMIT 1) as price,
        (SELECT ma.url FROM media_assets ma
         WHERE ma.product_id = p.id AND ma.asset_type = 'primary'
         ORDER BY CASE WHEN ma.sku_id IS NULL THEN 0 ELSE 1 END, ma.sort_order LIMIT 1) as primary_image,
        (SELECT CASE
           WHEN MAX(CASE WHEN inv.fresh_until > NOW() THEN inv.qty_on_hand END) IS NULL THEN 'unknown'
           WHEN MAX(CASE WHEN inv.fresh_until > NOW() THEN inv.qty_on_hand ELSE 0 END) > 10 THEN 'in_stock'
           WHEN MAX(CASE WHEN inv.fresh_until > NOW() THEN inv.qty_on_hand ELSE 0 END) > 0 THEN 'low_stock'
           ELSE 'out_of_stock'
         END
         FROM skus s2
         LEFT JOIN inventory_snapshots inv ON inv.sku_id = s2.id
         WHERE s2.product_id = p.id
        ) as stock_status
      FROM products p
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.status = 'active'
    `;
    const params = [];
    let paramIndex = 1;

    if (req.query.search) {
      params.push('%' + req.query.search + '%');
      query += ` AND (p.name ILIKE $${paramIndex} OR p.collection ILIKE $${paramIndex} OR (p.collection || ' ' || p.name) ILIKE $${paramIndex} OR p.description_short ILIKE $${paramIndex} OR v.name ILIKE $${paramIndex})`;
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

    if (req.query.collection) {
      params.push(req.query.collection);
      query += ` AND (p.collection = $${paramIndex} OR LOWER(REGEXP_REPLACE(p.collection, '[^a-zA-Z0-9]+', '-', 'g')) = LOWER($${paramIndex}))`;
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

    // Sort
    const sortMap = {
      price_asc: 'price ASC NULLS LAST',
      price_desc: 'price DESC NULLS LAST',
      newest: 'created_at DESC',
      name_asc: 'name ASC',
      name_desc: 'name DESC'
    };
    const sortKey = req.query.sort && sortMap[req.query.sort] ? req.query.sort : 'name_asc';
    const orderClause = sortMap[sortKey];

    // Wrap as subquery so we can sort by computed aliases (price)
    const countQuery = `SELECT COUNT(*) FROM (${query}) AS filtered`;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].count);

    query = `SELECT * FROM (${query}) AS filtered ORDER BY ${orderClause}`;

    // Pagination
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 24, 1), 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    params.push(limit);
    query += ` LIMIT $${paramIndex}`;
    paramIndex++;
    params.push(offset);
    query += ` OFFSET $${paramIndex}`;
    paramIndex++;

    const result = await pool.query(query, params);

    let products = result.rows;
    if (req.tradeCustomer && req.tradeCustomer.discount_percent > 0) {
      products = products.map(p => {
        if (p.price) {
          const retail = parseFloat(p.price);
          return {
            ...p,
            trade_price: (retail * (1 - req.tradeCustomer.discount_percent / 100)).toFixed(2),
            trade_tier: req.tradeCustomer.tier_name
          };
        }
        return p;
      });
    }

    res.json({ products, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products/:id', optionalTradeAuth, async (req, res) => {
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

    const skusResult = await pool.query(`
      SELECT s.*, pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs, pk.freight_class, pk.boxes_per_pallet, pk.sqft_per_pallet, pk.weight_per_pallet_lbs,
        pr.cost, pr.retail_price, pr.price_basis,
        inv.qty_on_hand, inv.qty_in_transit, inv.fresh_until,
        CASE WHEN pk.sqft_per_box > 0 THEN ROUND(COALESCE(inv.qty_on_hand, 0) * pk.sqft_per_box) END as qty_on_hand_sqft,
        CASE WHEN pk.sqft_per_box > 0 THEN ROUND(COALESCE(inv.qty_in_transit, 0) * pk.sqft_per_box) END as qty_in_transit_sqft,
        CASE
          WHEN inv.fresh_until IS NULL OR inv.fresh_until <= NOW() THEN 'unknown'
          WHEN inv.qty_on_hand > 10 THEN 'in_stock'
          WHEN inv.qty_on_hand > 0 THEN 'low_stock'
          ELSE 'out_of_stock'
        END as stock_status
      FROM skus s
      LEFT JOIN packaging pk ON pk.sku_id = s.id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      LEFT JOIN inventory_snapshots inv ON inv.sku_id = s.id AND inv.warehouse = 'default'
      WHERE s.product_id = $1
      ORDER BY s.created_at
    `, [id]);

    let skus = skusResult.rows;
    if (req.tradeCustomer && req.tradeCustomer.discount_percent > 0) {
      skus = skus.map(s => {
        if (s.retail_price) {
          const retail = parseFloat(s.retail_price);
          return {
            ...s,
            trade_price: (retail * (1 - req.tradeCustomer.discount_percent / 100)).toFixed(2),
            trade_tier: req.tradeCustomer.tier_name
          };
        }
        return s;
      });
    }

    const media = await pool.query(`
      SELECT id, asset_type, url, sort_order, sku_id FROM media_assets
      WHERE product_id = $1 AND asset_type != 'spec_pdf'
      ORDER BY
        CASE asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 WHEN 'lifestyle' THEN 2 ELSE 3 END,
        CASE WHEN sku_id IS NULL THEN 0 ELSE 1 END,
        sort_order
    `, [id]);

    // Fetch SKU attributes
    let skuAttributes = {};
    try {
      const attrResult = await pool.query(`
        SELECT sa.sku_id, a.name, a.slug, sa.value, a.display_order
        FROM sku_attributes sa
        JOIN attributes a ON a.id = sa.attribute_id
        JOIN skus s ON s.id = sa.sku_id
        WHERE s.product_id = $1
        ORDER BY a.display_order, a.name
      `, [id]);
      for (const row of attrResult.rows) {
        if (!skuAttributes[row.sku_id]) skuAttributes[row.sku_id] = [];
        skuAttributes[row.sku_id].push({ name: row.name, slug: row.slug, value: row.value });
      }
    } catch (attrErr) {
      // sku_attributes table may not exist yet
    }

    // Attach attributes to each SKU
    skus = skus.map(s => ({ ...s, attributes: skuAttributes[s.id] || [] }));

    res.json({ product: product.rows[0], skus, media: media.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products/:id/recommendations', async (req, res) => {
  try {
    const { id } = req.params;
    const product = await pool.query('SELECT collection, category_id FROM products WHERE id = $1', [id]);
    if (!product.rows.length) return res.status(404).json({ error: 'Product not found' });

    const { collection, category_id } = product.rows[0];
    const selectCols = `
      SELECT p.id, p.name, p.collection, v.name as vendor_name, c.name as category_name, c.slug as category_slug,
        (SELECT pr.retail_price FROM pricing pr
         JOIN skus s ON s.id = pr.sku_id
         WHERE s.product_id = p.id LIMIT 1) as price,
        (SELECT ma.url FROM media_assets ma
         WHERE ma.product_id = p.id AND ma.asset_type = 'primary'
         ORDER BY CASE WHEN ma.sku_id IS NULL THEN 0 ELSE 1 END, ma.sort_order LIMIT 1) as primary_image,
        (SELECT CASE
           WHEN MAX(CASE WHEN inv.fresh_until > NOW() THEN inv.qty_on_hand END) IS NULL THEN 'unknown'
           WHEN MAX(CASE WHEN inv.fresh_until > NOW() THEN inv.qty_on_hand ELSE 0 END) > 10 THEN 'in_stock'
           WHEN MAX(CASE WHEN inv.fresh_until > NOW() THEN inv.qty_on_hand ELSE 0 END) > 0 THEN 'low_stock'
           ELSE 'out_of_stock'
         END
         FROM skus s2
         LEFT JOIN inventory_snapshots inv ON inv.sku_id = s2.id
         WHERE s2.product_id = p.id
        ) as stock_status
      FROM products p
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.status = 'active' AND p.id != $1
    `;

    let recs = [];

    // Same collection first
    if (collection) {
      const collRes = await pool.query(
        selectCols + ' AND p.collection = $2 ORDER BY RANDOM() LIMIT 4',
        [id, collection]
      );
      recs = collRes.rows;
    }

    // Fill remaining with same category
    if (recs.length < 4 && category_id) {
      const excludeIds = [id, ...recs.map(r => r.id)];
      const placeholders = excludeIds.map((_, i) => `$${i + 1}`).join(', ');
      const catRes = await pool.query(
        selectCols.replace('p.id != $1', `p.id NOT IN (${placeholders})`) +
          ` AND p.category_id = $${excludeIds.length + 1} ORDER BY RANDOM() LIMIT $${excludeIds.length + 2}`,
        [...excludeIds, category_id, 4 - recs.length]
      );
      recs = recs.concat(catRes.rows);
    }

    res.json({ recommendations: recs });
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

app.get('/api/collections', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.collection as name,
        COUNT(*)::int as product_count,
        (SELECT ma.url FROM media_assets ma
         JOIN products p2 ON p2.id = ma.product_id
         WHERE p2.collection = p.collection AND p2.status = 'active' AND ma.asset_type != 'spec_pdf'
         ORDER BY CASE ma.asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 WHEN 'lifestyle' THEN 2 ELSE 3 END,
           CASE WHEN ma.sku_id IS NOT NULL THEN 0 ELSE 1 END, ma.sort_order LIMIT 1) as image
      FROM products p
      WHERE p.status = 'active' AND p.collection IS NOT NULL AND p.collection != ''
      GROUP BY p.collection
      ORDER BY p.collection
    `);
    const collections = result.rows.map(r => ({
      ...r,
      slug: r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    }));
    res.json({ collections });
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
      SELECT c.id, c.name, c.slug, c.parent_id, c.sort_order, c.image_url,
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
        image_url: p.image_url || null,
        product_count: parent_count,
        children
      };
    });

    res.json({ categories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Storefront SKU Browse ====================

app.get('/api/storefront/skus', optionalTradeAuth, async (req, res) => {
  try {
    const { category, collection, search, sort, q } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 24, 100);
    const offset = parseInt(req.query.offset) || 0;
    const searchTerm = search || q;

    let params = [];
    let paramIndex = 1;
    let whereClauses = ["p.status = 'active'", "s.is_sample = false", "s.status = 'active'", "COALESCE(s.variant_type, '') != 'accessory'"];

    // Category filter (includes children)
    if (category) {
      params.push(category);
      whereClauses.push(`(c.slug = $${paramIndex} OR c.parent_id IN (SELECT id FROM categories WHERE slug = $${paramIndex}))`);
      paramIndex++;
    }

    // Collection filter
    if (collection) {
      params.push(collection);
      whereClauses.push(`LOWER(p.collection) = LOWER($${paramIndex})`);
      paramIndex++;
    }

    // Search
    if (searchTerm) {
      params.push('%' + searchTerm + '%');
      whereClauses.push(`(p.name ILIKE $${paramIndex} OR p.collection ILIKE $${paramIndex} OR (p.collection || ' ' || p.name) ILIKE $${paramIndex} OR v.name ILIKE $${paramIndex} OR s.variant_name ILIKE $${paramIndex} OR p.description_short ILIKE $${paramIndex})`);
      paramIndex++;
    }

    // Product IDs filter (for wishlist)
    if (req.query.product_ids) {
      const pids = req.query.product_ids.split(',').filter(Boolean);
      if (pids.length > 0) {
        const pidPlaceholders = pids.map(pid => { params.push(pid); return `$${paramIndex++}`; });
        whereClauses.push(`p.id IN (${pidPlaceholders.join(',')})`);
      }
    }

    // Attribute filters: any query param matching an attribute slug
    const reservedParams = ['category', 'collection', 'search', 'q', 'sort', 'limit', 'offset', 'product_ids'];
    const attrFilters = {};
    for (const [key, val] of Object.entries(req.query)) {
      if (!reservedParams.includes(key) && val) {
        attrFilters[key] = val.split(',').map(v => v.trim()).filter(Boolean);
      }
    }

    for (const [slug, values] of Object.entries(attrFilters)) {
      const slugParam = paramIndex++;
      params.push(slug);
      const valuePlaceholders = values.map(v => {
        params.push(v);
        return `$${paramIndex++}`;
      });
      whereClauses.push(`s.id IN (SELECT sa.sku_id FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id WHERE a.slug = $${slugParam} AND sa.value IN (${valuePlaceholders.join(',')}))`);
    }

    const whereSQL = whereClauses.join(' AND ');

    // Sort — column names without table prefixes (used in outer query over subquery)
    let orderBy = 'product_name ASC, variant_name ASC';
    if (sort === 'price_asc') orderBy = 'retail_price ASC NULLS LAST, product_name ASC';
    else if (sort === 'price_desc') orderBy = 'retail_price DESC NULLS LAST, product_name ASC';
    else if (sort === 'newest') orderBy = 'created_at DESC';
    else if (sort === 'name_asc') orderBy = 'product_name ASC, variant_name ASC';
    else if (sort === 'name_desc') orderBy = 'product_name DESC, variant_name DESC';

    // Count query — count distinct products, not individual SKUs
    const countSQL = `
      SELECT COUNT(DISTINCT p.id) as total
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE ${whereSQL}
    `;

    // Main query — CTEs pre-compute images & variant counts (avoids correlated subqueries)
    const mainSQL = `
      WITH sku_images AS (
        SELECT DISTINCT ON (sku_id) sku_id, url
        FROM media_assets
        WHERE asset_type = 'primary' AND sku_id IS NOT NULL
        ORDER BY sku_id, sort_order
      ),
      product_images AS (
        SELECT DISTINCT ON (product_id) product_id, url
        FROM media_assets
        WHERE asset_type = 'primary' AND sku_id IS NULL
        ORDER BY product_id, sort_order
      ),
      variant_counts AS (
        SELECT product_id, COUNT(*) as variant_count
        FROM skus
        WHERE status = 'active' AND is_sample = false AND COALESCE(variant_type, '') != 'accessory'
        GROUP BY product_id
      )
      SELECT * FROM (
        SELECT DISTINCT ON (p.id)
          s.id as sku_id, s.product_id, s.variant_name, s.internal_sku, s.sell_by, s.created_at,
          p.name as product_name, p.collection, p.description_short,
          v.name as vendor_name,
          COALESCE(v.has_public_inventory, false) as vendor_has_inventory,
          c.name as category_name, c.slug as category_slug,
          pr.retail_price, pr.price_basis,
          pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs,
          COALESCE(si.url, pi.url) as primary_image,
          CASE
            WHEN inv.fresh_until IS NULL OR inv.fresh_until <= NOW() THEN 'unknown'
            WHEN inv.qty_on_hand > 10 THEN 'in_stock'
            WHEN inv.qty_on_hand > 0 THEN 'low_stock'
            ELSE 'out_of_stock'
          END as stock_status,
          COALESCE(vc.variant_count, 0) as variant_count
        FROM skus s
        JOIN products p ON p.id = s.product_id
        JOIN vendors v ON v.id = p.vendor_id
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN pricing pr ON pr.sku_id = s.id
        LEFT JOIN packaging pk ON pk.sku_id = s.id
        LEFT JOIN inventory_snapshots inv ON inv.sku_id = s.id AND inv.warehouse = 'default'
        LEFT JOIN sku_images si ON si.sku_id = s.id
        LEFT JOIN product_images pi ON pi.product_id = p.id
        LEFT JOIN variant_counts vc ON vc.product_id = p.id
        WHERE ${whereSQL}
        ORDER BY p.id, s.created_at
      ) grouped
      ORDER BY ${orderBy}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(limit, offset);

    const [countResult, skuResult] = await Promise.all([
      pool.query(countSQL, params.slice(0, paramIndex - 1)),
      pool.query(mainSQL, params)
    ]);

    const total = parseInt(countResult.rows[0].total);
    let skus = skuResult.rows;

    // Batch-fetch attributes for returned SKUs
    if (skus.length > 0) {
      const skuIds = skus.map(s => s.sku_id);
      const attrResult = await pool.query(`
        SELECT sa.sku_id, a.name, a.slug, sa.value
        FROM sku_attributes sa
        JOIN attributes a ON a.id = sa.attribute_id
        WHERE sa.sku_id = ANY($1)
        ORDER BY a.display_order, a.name
      `, [skuIds]);

      const attrMap = {};
      for (const row of attrResult.rows) {
        if (!attrMap[row.sku_id]) attrMap[row.sku_id] = [];
        attrMap[row.sku_id].push({ slug: row.slug, name: row.name, value: row.value });
      }
      skus = skus.map(s => ({ ...s, attributes: attrMap[s.sku_id] || [] }));
    }

    // Apply trade pricing if authenticated
    if (req.tradeCustomer && req.tradeCustomer.discount_percent > 0) {
      skus = skus.map(s => {
        if (s.retail_price) {
          const retail = parseFloat(s.retail_price);
          return {
            ...s,
            trade_price: (retail * (1 - req.tradeCustomer.discount_percent / 100)).toFixed(2)
          };
        }
        return s;
      });
    }

    res.json({ skus, total });
  } catch (err) {
    console.error('Storefront SKU browse error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/storefront/skus/:skuId', optionalTradeAuth, async (req, res) => {
  try {
    const { skuId } = req.params;

    // Main SKU query with full details
    const skuResult = await pool.query(`
      SELECT
        s.id as sku_id, s.product_id, s.variant_name, s.internal_sku, s.vendor_sku, s.sell_by, s.variant_type,
        p.name as product_name, p.collection, p.category_id, p.description_long, p.description_short,
        v.name as vendor_name, v.code as vendor_code,
        COALESCE(v.has_public_inventory, false) as vendor_has_inventory,
        c.name as category_name, c.slug as category_slug,
        pr.retail_price, pr.cost, pr.price_basis,
        pr.cut_price, pr.roll_price, pr.cut_cost, pr.roll_cost, pr.roll_min_sqft,
        pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs, pk.freight_class,
        pk.boxes_per_pallet, pk.sqft_per_pallet, pk.weight_per_pallet_lbs,
        pk.roll_width_ft,
        inv.qty_on_hand, inv.qty_in_transit, inv.fresh_until,
        CASE WHEN pk.sqft_per_box > 0 THEN ROUND(COALESCE(inv.qty_on_hand, 0) * pk.sqft_per_box) END as qty_on_hand_sqft,
        CASE
          WHEN inv.fresh_until IS NULL OR inv.fresh_until <= NOW() THEN 'unknown'
          WHEN inv.qty_on_hand > 10 THEN 'in_stock'
          WHEN inv.qty_on_hand > 0 THEN 'low_stock'
          ELSE 'out_of_stock'
        END as stock_status
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      LEFT JOIN packaging pk ON pk.sku_id = s.id
      LEFT JOIN inventory_snapshots inv ON inv.sku_id = s.id AND inv.warehouse = 'default'
      WHERE s.id = $1
    `, [skuId]);

    if (!skuResult.rows.length) return res.status(404).json({ error: 'SKU not found' });
    let sku = skuResult.rows[0];

    // Accessories don't have their own page — redirect to parent product's first main SKU
    if (sku.variant_type === 'accessory') {
      const parentSku = await pool.query(`
        SELECT s.id FROM skus s
        WHERE s.product_id = $1 AND s.id != $2 AND COALESCE(s.variant_type, '') != 'accessory'
          AND s.status = 'active' AND s.is_sample = false
        ORDER BY s.created_at LIMIT 1
      `, [sku.product_id, skuId]);
      if (parentSku.rows.length) {
        return res.json({ redirect_to_sku: parentSku.rows[0].id });
      }
      return res.status(404).json({ error: 'Product not found' });
    }

    // SKU attributes
    const attrResult = await pool.query(`
      SELECT a.name, a.slug, sa.value, a.display_order
      FROM sku_attributes sa
      JOIN attributes a ON a.id = sa.attribute_id
      WHERE sa.sku_id = $1
      ORDER BY a.display_order, a.name
    `, [skuId]);

    sku.attributes = attrResult.rows;

    // Trade pricing
    if (req.tradeCustomer && req.tradeCustomer.discount_percent > 0 && sku.retail_price) {
      const retail = parseFloat(sku.retail_price);
      sku.trade_price = (retail * (1 - req.tradeCustomer.discount_percent / 100)).toFixed(2);
      sku.trade_tier = req.tradeCustomer.tier_name;
    }

    // Media: prefer SKU-specific images; only fall back to product-level if no SKU images exist
    const skuMediaResult = await pool.query(`
      SELECT id, asset_type, url, sort_order, sku_id
      FROM media_assets
      WHERE product_id = $2 AND sku_id = $1
      ORDER BY CASE asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 WHEN 'lifestyle' THEN 2 ELSE 3 END, sort_order
    `, [skuId, sku.product_id]);

    let mediaResult;
    if (skuMediaResult.rows.length > 0) {
      mediaResult = skuMediaResult;
    } else {
      mediaResult = await pool.query(`
        SELECT id, asset_type, url, sort_order, sku_id
        FROM media_assets
        WHERE product_id = $1 AND sku_id IS NULL
        ORDER BY CASE asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 WHEN 'lifestyle' THEN 2 ELSE 3 END, sort_order
      `, [sku.product_id]);
    }

    // Deduplicate media by URL
    const seenUrls = new Set();
    const dedupedMedia = [];
    for (const row of mediaResult.rows) {
      if (!seenUrls.has(row.url)) {
        seenUrls.add(row.url);
        dedupedMedia.push(row);
      }
    }

    // Same-product siblings (other SKUs of the same product)
    const siblingsResult = await pool.query(`
      SELECT
        s.id as sku_id, s.variant_name, s.internal_sku, s.variant_type, s.sell_by,
        pr.retail_price, pr.price_basis,
        COALESCE(
          (SELECT ma.url FROM media_assets ma WHERE ma.sku_id = s.id AND ma.asset_type = 'primary' ORDER BY ma.sort_order LIMIT 1),
          (SELECT ma.url FROM media_assets ma WHERE ma.product_id = s.product_id AND ma.sku_id IS NULL AND ma.asset_type = 'primary' ORDER BY ma.sort_order LIMIT 1)
        ) as primary_image,
        CASE
          WHEN inv.fresh_until IS NULL OR inv.fresh_until <= NOW() THEN 'unknown'
          WHEN inv.qty_on_hand > 10 THEN 'in_stock'
          WHEN inv.qty_on_hand > 0 THEN 'low_stock'
          ELSE 'out_of_stock'
        END as stock_status
      FROM skus s
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      LEFT JOIN inventory_snapshots inv ON inv.sku_id = s.id AND inv.warehouse = 'default'
      WHERE s.product_id = $1 AND s.id != $2 AND s.is_sample = false AND s.status = 'active'
      ORDER BY s.variant_name
    `, [sku.product_id, skuId]);

    // Batch-fetch attributes for siblings
    let sameSiblings = siblingsResult.rows;
    if (sameSiblings.length > 0) {
      const sibIds = sameSiblings.map(s => s.sku_id);
      const sibAttrResult = await pool.query(`
        SELECT sa.sku_id, a.name, a.slug, sa.value
        FROM sku_attributes sa
        JOIN attributes a ON a.id = sa.attribute_id
        WHERE sa.sku_id = ANY($1)
        ORDER BY a.display_order
      `, [sibIds]);
      const sibAttrMap = {};
      for (const row of sibAttrResult.rows) {
        if (!sibAttrMap[row.sku_id]) sibAttrMap[row.sku_id] = [];
        sibAttrMap[row.sku_id].push({ slug: row.slug, name: row.name, value: row.value });
      }
      sameSiblings = sameSiblings.map(s => ({ ...s, attributes: sibAttrMap[s.sku_id] || [] }));
    }

    // Collection siblings (other products in same collection, same category, excluding mosaics/hexagons/bullnose)
    let collectionSiblings = [];
    if (sku.collection) {
      const isMosaicProduct = /mosaic|hexagon|bullnose/i.test(sku.product_name);
      const collResult = await pool.query(`
        SELECT DISTINCT ON (p.id)
          s.id as sku_id, s.variant_name, p.id as product_id, p.name as product_name, p.collection,
          pr.retail_price, pr.price_basis,
          COALESCE(
            (SELECT ma.url FROM media_assets ma WHERE ma.sku_id = s.id AND ma.asset_type = 'primary' ORDER BY ma.sort_order LIMIT 1),
            (SELECT ma.url FROM media_assets ma WHERE ma.product_id = p.id AND ma.sku_id IS NULL AND ma.asset_type = 'primary' ORDER BY ma.sort_order LIMIT 1)
          ) as primary_image
        FROM products p
        JOIN skus s ON s.product_id = p.id AND s.is_sample = false AND s.status = 'active'
        LEFT JOIN pricing pr ON pr.sku_id = s.id
        WHERE LOWER(p.collection) = LOWER($1) AND p.id != $2 AND p.status = 'active'
          AND p.category_id = $3
          AND (
            ($4 = true AND p.name ~* '(mosaic|hexagon|bullnose)')
            OR ($4 = false AND p.name !~* '(mosaic|hexagon|bullnose)')
          )
        ORDER BY p.id, s.created_at
        LIMIT 50
      `, [sku.collection, sku.product_id, sku.category_id, isMosaicProduct]);
      collectionSiblings = collResult.rows;
    }

    // Collection-wide attribute values (all sizes/finishes across all colors)
    // Used so variant pills don't disappear when current color has fewer options
    let collectionAttributes = {};
    if (sku.collection) {
      const isMosaicProduct = /mosaic|hexagon|bullnose/i.test(sku.product_name);
      const caResult = await pool.query(`
        SELECT a.slug, a.name, ARRAY_AGG(DISTINCT sa.value) as values
        FROM products p
        JOIN skus s ON s.product_id = p.id AND s.status = 'active' AND s.is_sample = false
        JOIN sku_attributes sa ON sa.sku_id = s.id
        JOIN attributes a ON a.id = sa.attribute_id
        WHERE LOWER(p.collection) = LOWER($1) AND p.status = 'active'
          AND p.category_id = $2
          AND (
            ($3 = true AND p.name ~* '(mosaic|hexagon|bullnose)')
            OR ($3 = false AND p.name !~* '(mosaic|hexagon|bullnose)')
          )
        GROUP BY a.slug, a.name
      `, [sku.collection, sku.category_id, isMosaicProduct]);
      for (const row of caResult.rows) {
        collectionAttributes[row.slug] = { name: row.name, values: row.values };
      }
    }

    // Grouped products (e.g. matching cabinets, mirrors for vanities via group_number + color)
    let groupedProducts = [];
    const groupAttr = sku.attributes.find(a => a.slug === 'group_number');
    const groupNumber = groupAttr ? groupAttr.value : null;
    const colorAttr = sku.attributes.find(a => a.slug === 'color');
    const skuColor = colorAttr ? colorAttr.value : null;
    if (groupNumber) {
      const gpParams = [groupNumber, sku.category_id, sku.product_id];
      let colorFilter = '';
      if (skuColor) {
        colorFilter = `AND (
          EXISTS (
            SELECT 1 FROM sku_attributes sa_c
            JOIN attributes a_c ON a_c.id = sa_c.attribute_id AND a_c.slug = 'color'
            WHERE sa_c.sku_id = s.id AND sa_c.value = $4
          )
          OR (
            NOT EXISTS (
              SELECT 1 FROM sku_attributes sa_c2
              JOIN attributes a_c2 ON a_c2.id = sa_c2.attribute_id AND a_c2.slug = 'color'
              WHERE sa_c2.sku_id = s.id
            )
            AND s.variant_name ILIKE '%' || $4 || '%'
          )
        )`;
        gpParams.push(skuColor);
      }
      const gpResult = await pool.query(`
        SELECT DISTINCT ON (p.id)
          s.id as sku_id, s.variant_name, s.variant_type, s.sell_by,
          p.id as product_id, p.name as product_name, p.collection,
          c.name as category_name, c.slug as category_slug,
          pr.retail_price, pr.price_basis,
          COALESCE(
            (SELECT ma.url FROM media_assets ma WHERE ma.sku_id = s.id AND ma.asset_type = 'primary' LIMIT 1),
            (SELECT ma.url FROM media_assets ma WHERE ma.product_id = p.id AND ma.sku_id IS NULL AND ma.asset_type = 'primary' LIMIT 1)
          ) as primary_image
        FROM sku_attributes sa
        JOIN skus s ON s.id = sa.sku_id AND s.status = 'active' AND s.is_sample = false
        JOIN products p ON p.id = s.product_id AND p.status = 'active'
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN pricing pr ON pr.sku_id = s.id
        WHERE sa.attribute_id = (SELECT id FROM attributes WHERE slug = 'group_number')
          AND sa.value = $1
          AND p.category_id != $2
          AND p.id != $3
          ${colorFilter}
        ORDER BY p.id, pr.retail_price DESC NULLS LAST
        LIMIT 20
      `, gpParams);
      groupedProducts = gpResult.rows;
    }

    res.json({
      sku,
      media: dedupedMedia,
      same_product_siblings: sameSiblings,
      collection_siblings: collectionSiblings,
      collection_attributes: collectionAttributes,
      grouped_products: groupedProducts
    });
  } catch (err) {
    console.error('Storefront SKU detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/storefront/facets', async (req, res) => {
  try {
    const { category, collection, search, q } = req.query;
    const searchTerm = search || q;

    // Build base WHERE for non-attribute filters
    let params = [];
    let paramIndex = 1;
    let baseWhere = ["p.status = 'active'", "s.is_sample = false", "s.status = 'active'"];

    if (category) {
      params.push(category);
      baseWhere.push(`(c.slug = $${paramIndex} OR c.parent_id IN (SELECT id FROM categories WHERE slug = $${paramIndex}))`);
      paramIndex++;
    }
    if (collection) {
      params.push(collection);
      baseWhere.push(`LOWER(p.collection) = LOWER($${paramIndex})`);
      paramIndex++;
    }
    if (searchTerm) {
      params.push('%' + searchTerm + '%');
      baseWhere.push(`(p.name ILIKE $${paramIndex} OR p.collection ILIKE $${paramIndex} OR (p.collection || ' ' || p.name) ILIKE $${paramIndex} OR v.name ILIKE $${paramIndex} OR s.variant_name ILIKE $${paramIndex})`);
      paramIndex++;
    }

    // Collect attribute filters from query params
    const reservedParams = ['category', 'collection', 'search', 'q', 'sort', 'limit', 'offset'];
    const attrFilters = {};
    for (const [key, val] of Object.entries(req.query)) {
      if (!reservedParams.includes(key) && val) {
        attrFilters[key] = val.split(',').map(v => v.trim()).filter(Boolean);
      }
    }

    // Get all filterable attributes
    const attrsResult = await pool.query(
      "SELECT id, name, slug FROM attributes WHERE is_filterable = true ORDER BY display_order, name"
    );

    // For each attribute group, compute disjunctive counts
    // (apply all OTHER attribute filters, but not the current one)
    const facetPromises = attrsResult.rows.map(async (attr) => {
      let facetParams = [...params];
      let facetParamIndex = paramIndex;
      let facetWhere = [...baseWhere];

      // Apply all attribute filters EXCEPT this one (disjunctive faceting)
      for (const [slug, values] of Object.entries(attrFilters)) {
        if (slug === attr.slug) continue; // skip self
        const slugP = facetParamIndex++;
        facetParams.push(slug);
        const valPlaceholders = values.map(v => {
          facetParams.push(v);
          return `$${facetParamIndex++}`;
        });
        facetWhere.push(`s.id IN (SELECT sa2.sku_id FROM sku_attributes sa2 JOIN attributes a2 ON a2.id = sa2.attribute_id WHERE a2.slug = $${slugP} AND sa2.value IN (${valPlaceholders.join(',')}))`);
      }

      const facetSQL = `
        SELECT sa.value, COUNT(DISTINCT s.id) as count
        FROM sku_attributes sa
        JOIN attributes a ON a.id = sa.attribute_id
        JOIN skus s ON s.id = sa.sku_id
        JOIN products p ON p.id = s.product_id
        JOIN vendors v ON v.id = p.vendor_id
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE a.slug = $${facetParamIndex} AND ${facetWhere.join(' AND ')}
        GROUP BY sa.value
        ORDER BY count DESC, sa.value ASC
      `;
      facetParams.push(attr.slug);

      const result = await pool.query(facetSQL, facetParams);
      return {
        name: attr.name,
        slug: attr.slug,
        values: result.rows.map(r => ({ value: r.value, count: parseInt(r.count) }))
      };
    });

    const facets = (await Promise.all(facetPromises)).filter(f => f.values.length > 0);

    res.json({ facets });
  } catch (err) {
    console.error('Storefront facets error:', err);
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
        s.sell_by, s.variant_type, s.vendor_sku, c.slug as category_slug,
        pr.cut_price, pr.roll_price, pr.roll_min_sqft
      FROM cart_items ci
      LEFT JOIN products p ON p.id = ci.product_id
      LEFT JOIN skus s ON s.id = ci.sku_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN pricing pr ON pr.sku_id = ci.sku_id
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

    const result = await pool.query(`
      INSERT INTO cart_items (session_id, product_id, sku_id, sqft_needed, num_boxes, include_overage, unit_price, subtotal, is_sample, sell_by, price_tier)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [session_id, product_id || null, sku_id || null, sqft_needed || null, num_boxes, include_overage || false, unit_price || 0, subtotal || 0, is_sample || false, sell_by || null, price_tier || null]);

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
    const { num_boxes, sqft_needed, subtotal, unit_price, price_tier } = req.body;

    const result = await pool.query(`
      UPDATE cart_items
      SET num_boxes = COALESCE($1, num_boxes),
          sqft_needed = COALESCE($2, sqft_needed),
          subtotal = COALESCE($3, subtotal),
          unit_price = COALESCE($4, unit_price),
          price_tier = COALESCE($5, price_tier),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *
    `, [num_boxes, sqft_needed, subtotal, unit_price, price_tier, id]);

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

async function getLTLRates(freightItems, destination, options = {}) {
  const token = await getFreightViewToken();
  const pickupDate = getNextBusinessDay();
  const residential = options.residential !== false; // default true
  const liftgate = options.liftgate !== false; // default true

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
  console.log('[FreightView] Response keys:', Object.keys(data), 'quotes count:', (data.quotes || []).length);
  if (data.quotes && data.quotes.length > 0) {
    console.log('[FreightView] First quote keys:', Object.keys(data.quotes[0]), JSON.stringify(data.quotes[0]));
  }
  const quotes = data.quotes || [];
  if (quotes.length === 0) {
    throw new Error('No LTL freight rates available for this destination');
  }
  const sorted = quotes.sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount));
  return sorted.slice(0, 3).map((q, idx) => ({
    id: 'fv-' + idx,
    amount: parseFloat(parseFloat(q.amount).toFixed(2)),
    carrier: q.providerName || 'LTL Carrier',
    service: q.serviceType || 'LTL Freight',
    transit_days: q.transitDays || q.transitTime || null,
    is_cheapest: idx === 0,
    is_fallback: false
  }));
}

function getFallbackLTLEstimate(totalWeightLbs, destinationZip) {
  const baseRate = 0.50; // $/lb
  const minCharge = 150;
  // Zone multiplier by first digit of destination zip
  const zoneMultipliers = {
    '9': 1.0, '8': 1.1, // west
    '7': 1.2, '6': 1.25, // south/midwest
    '5': 1.3, '4': 1.35, // midwest
    '3': 1.4, '2': 1.5, // southeast/mid-atlantic
    '1': 1.55, '0': 1.6  // northeast
  };
  const firstDigit = (destinationZip || '9')[0];
  const multiplier = zoneMultipliers[firstDigit] || 1.3;
  const economy = Math.max(minCharge, totalWeightLbs * baseRate * multiplier);
  const standard = parseFloat((economy * 1.3).toFixed(2));
  const expedited = parseFloat((economy * 1.75).toFixed(2));
  // Zone-based transit day estimates (west coast origin)
  const zoneTransit = { '9': 3, '8': 4, '7': 5, '6': 6, '5': 7, '4': 7, '3': 8, '2': 9, '1': 9, '0': 10 };
  const baseDays = zoneTransit[firstDigit] || 7;
  return [
    { id: 'fallback-economy', amount: parseFloat(economy.toFixed(2)), carrier: 'Economy Freight', service: 'LTL Economy', transit_days: baseDays + 3, is_cheapest: true, is_fallback: true },
    { id: 'fallback-standard', amount: standard, carrier: 'Standard Freight', service: 'LTL Standard', transit_days: baseDays, is_cheapest: false, is_fallback: true },
    { id: 'fallback-expedited', amount: expedited, carrier: 'Expedited Freight', service: 'LTL Expedited', transit_days: Math.max(2, baseDays - 3), is_cheapest: false, is_fallback: true }
  ];
}

async function calculateShipping(sessionId, destination, shippingOptions = {}) {
  const residential = shippingOptions.residential !== false;
  const liftgate = shippingOptions.liftgate !== false;

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
    return { options: [{ id: 'none', amount: 0, carrier: null, service: null, transit_days: null, is_cheapest: true, is_fallback: false }], method: null, weight_lbs: 0, total_boxes: 0, residential, liftgate };
  }

  let options;
  let method;

  if (totalWeightLbs <= WEIGHT_THRESHOLD_LBS) {
    method = 'parcel';
    const rateResult = await getParcelRates(totalWeightLbs, destination);
    options = [{
      id: 'parcel-0',
      amount: parseFloat(parseFloat(rateResult.amount).toFixed(2)),
      carrier: rateResult.carrier,
      service: rateResult.service,
      transit_days: null,
      is_cheapest: true,
      is_fallback: false
    }];
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
    try {
      options = await getLTLRates(freightItems, destination, { residential, liftgate });
    } catch (fvErr) {
      console.error('FreightView API failed, using fallback:', fvErr.message);
      options = getFallbackLTLEstimate(totalWeightLbs, destination.zip);
    }
  }

  return {
    options,
    method,
    weight_lbs: parseFloat(totalWeightLbs.toFixed(2)),
    total_boxes: totalBoxes,
    residential,
    liftgate
  };
}

// Same as calculateShipping but queries order_items instead of cart_items
async function calculateShippingForOrder(orderId, destination, shippingOptions = {}) {
  const residential = shippingOptions.residential !== false;
  const liftgate = shippingOptions.liftgate !== false;

  const result = await pool.query(`
    SELECT oi.num_boxes, oi.is_sample, pk.weight_per_box_lbs, pk.freight_class
    FROM order_items oi
    JOIN skus s ON s.id = oi.sku_id
    LEFT JOIN packaging pk ON pk.sku_id = s.id
    WHERE oi.order_id = $1 AND oi.is_sample = false
  `, [orderId]);

  let totalWeightLbs = 0;
  let totalBoxes = 0;
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

  if (totalWeightLbs === 0 || totalBoxes === 0) {
    return { options: [{ id: 'none', amount: 0, carrier: null, service: null, transit_days: null, is_cheapest: true, is_fallback: false }], method: null, weight_lbs: 0, total_boxes: 0, residential, liftgate };
  }

  let options;
  let method;

  if (totalWeightLbs <= WEIGHT_THRESHOLD_LBS) {
    method = 'parcel';
    const rateResult = await getParcelRates(totalWeightLbs, destination);
    options = [{
      id: 'parcel-0',
      amount: parseFloat(parseFloat(rateResult.amount).toFixed(2)),
      carrier: rateResult.carrier,
      service: rateResult.service,
      transit_days: null,
      is_cheapest: true,
      is_fallback: false
    }];
  } else {
    method = 'ltl_freight';
    const freightItems = Object.entries(byFreightClass).map(([fc, weight]) => ({
      quantity: 1,
      weight: Math.ceil(weight),
      weightUOM: 'lbs',
      freightClass: parseInt(fc),
      description: 'Flooring materials',
      type: 'pallet'
    }));
    try {
      options = await getLTLRates(freightItems, destination, { residential, liftgate });
    } catch (fvErr) {
      console.error('FreightView API failed, using fallback:', fvErr.message);
      options = getFallbackLTLEstimate(totalWeightLbs, destination.zip);
    }
  }

  return {
    options,
    method,
    weight_lbs: parseFloat(totalWeightLbs.toFixed(2)),
    total_boxes: totalBoxes,
    residential,
    liftgate
  };
}

app.post('/api/shipping/estimate', async (req, res) => {
  try {
    const { session_id, destination, delivery_method, residential, liftgate } = req.body;

    // Pickup orders have no shipping cost
    if (delivery_method === 'pickup') {
      return res.json({ options: [{ id: 'pickup', amount: 0, carrier: null, service: null, transit_days: null, is_cheapest: true, is_fallback: false }], method: 'pickup', weight_lbs: 0, total_boxes: 0, residential: false, liftgate: false });
    }

    if (!session_id || !destination || !destination.zip) {
      return res.status(400).json({ error: 'session_id and destination.zip are required' });
    }

    const result = await calculateShipping(session_id, destination, { residential, liftgate });
    res.json(result);
  } catch (err) {
    console.error('Shipping estimate error:', err.message);
    res.status(500).json({ error: 'Unable to calculate shipping: ' + err.message });
  }
});

// ==================== Promo Code Helper ====================

async function calculatePromoDiscount(promoCode, items, customerEmail, dbClient) {
  const client = dbClient || pool;
  if (!promoCode || !promoCode.trim()) return { valid: false, error: 'No promo code provided' };

  // Look up code case-insensitively
  const codeResult = await client.query(
    'SELECT * FROM promo_codes WHERE UPPER(code) = UPPER($1)',
    [promoCode.trim()]
  );
  if (codeResult.rows.length === 0) return { valid: false, error: 'Invalid promo code' };

  const promo = codeResult.rows[0];

  // Check active
  if (!promo.is_active) return { valid: false, error: 'This promo code is no longer active' };

  // Check expiration
  if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
    return { valid: false, error: 'This promo code has expired' };
  }

  // Check max total uses (only count usages with order_id, not quote-only)
  if (promo.max_uses !== null) {
    const usageCount = await client.query(
      'SELECT COUNT(*)::int as cnt FROM promo_code_usages WHERE promo_code_id = $1 AND order_id IS NOT NULL',
      [promo.id]
    );
    if (usageCount.rows[0].cnt >= promo.max_uses) {
      return { valid: false, error: 'This promo code has reached its usage limit' };
    }
  }

  // Check per-customer uses
  if (promo.max_uses_per_customer !== null && customerEmail) {
    const custUsageCount = await client.query(
      'SELECT COUNT(*)::int as cnt FROM promo_code_usages WHERE promo_code_id = $1 AND order_id IS NOT NULL AND LOWER(customer_email) = LOWER($2)',
      [promo.id, customerEmail]
    );
    if (custUsageCount.rows[0].cnt >= promo.max_uses_per_customer) {
      return { valid: false, error: 'You have already used this promo code the maximum number of times' };
    }
  }

  // Filter eligible items (exclude samples, apply category/product restrictions)
  const restrictedCategories = promo.restricted_category_ids || [];
  const restrictedProducts = promo.restricted_product_ids || [];
  const hasRestrictions = restrictedCategories.length > 0 || restrictedProducts.length > 0;

  const eligibleItems = items.filter(item => {
    if (item.is_sample) return false;
    if (!hasRestrictions) return true;
    if (restrictedProduct_ids_match(item.product_id, restrictedProducts)) return true;
    if (restrictedCategory_ids_match(item.category_id, restrictedCategories)) return true;
    return false;
  });

  const fullProductSubtotal = items.filter(i => !i.is_sample).reduce((sum, i) => sum + parseFloat(i.subtotal || 0), 0);
  const eligibleSubtotal = eligibleItems.reduce((sum, i) => sum + parseFloat(i.subtotal || 0), 0);

  // Check min order amount against full product subtotal
  const minOrder = parseFloat(promo.min_order_amount || 0);
  if (minOrder > 0 && fullProductSubtotal < minOrder) {
    return { valid: false, error: `Minimum order amount of $${minOrder.toFixed(2)} required` };
  }

  if (eligibleSubtotal <= 0) {
    return { valid: false, error: hasRestrictions ? 'No eligible items in cart for this promo code' : 'No eligible items in cart' };
  }

  // Calculate discount
  let discountAmount = 0;
  if (promo.discount_type === 'percent') {
    discountAmount = eligibleSubtotal * parseFloat(promo.discount_value) / 100;
  } else {
    discountAmount = Math.min(parseFloat(promo.discount_value), eligibleSubtotal);
  }

  // Never round up in merchant's favor
  discountAmount = Math.floor(discountAmount * 100) / 100;

  return {
    valid: true,
    promo,
    discount_amount: discountAmount,
    eligible_subtotal: eligibleSubtotal
  };
}

function restrictedProduct_ids_match(productId, restrictedIds) {
  if (!productId || !restrictedIds || restrictedIds.length === 0) return false;
  return restrictedIds.some(id => id === productId);
}

function restrictedCategory_ids_match(categoryId, restrictedIds) {
  if (!categoryId || !restrictedIds || restrictedIds.length === 0) return false;
  return restrictedIds.some(id => id === categoryId);
}

// ==================== Promo Code Validation Endpoints ====================

app.post('/api/promo-codes/validate', async (req, res) => {
  try {
    const { code, session_id, customer_email } = req.body;
    if (!code || !session_id) return res.status(400).json({ valid: false, error: 'Code and session_id are required' });

    // Fetch cart items with category_id
    const cartResult = await pool.query(`
      SELECT ci.*, p.category_id, p.id as product_id
      FROM cart_items ci
      LEFT JOIN products p ON p.id = ci.product_id
      WHERE ci.session_id = $1
    `, [session_id]);

    if (cartResult.rows.length === 0) return res.json({ valid: false, error: 'Cart is empty' });

    const items = cartResult.rows.map(row => ({
      product_id: row.product_id,
      category_id: row.category_id,
      subtotal: row.subtotal,
      is_sample: row.is_sample
    }));

    const result = await calculatePromoDiscount(code, items, customer_email || null);

    if (!result.valid) return res.json({ valid: false, error: result.error });

    res.json({
      valid: true,
      code: result.promo.code,
      discount_type: result.promo.discount_type,
      discount_value: parseFloat(result.promo.discount_value),
      discount_amount: result.discount_amount,
      description: result.promo.description || ''
    });
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message });
  }
});

// ==================== Checkout API ====================

app.post('/api/checkout/create-payment-intent', async (req, res) => {
  try {
    const { session_id, destination, delivery_method, shipping_option_id, residential, liftgate, promo_code } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id is required' });

    const result = await pool.query(`
      SELECT ci.*, p.name as product_name, p.collection, p.category_id,
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
        const shippingResult = await calculateShipping(session_id, destination, { residential, liftgate });
        const opts = shippingResult.options || [];
        // Select the option matching shipping_option_id, or default to cheapest
        const selected = (shipping_option_id && opts.find(o => o.id === shipping_option_id)) || opts.find(o => o.is_cheapest) || opts[0];
        shippingCost = selected ? selected.amount : 0;
        shippingMethod = shippingResult.method;
      } catch (shipErr) {
        console.error('Shipping calc error during payment intent:', shipErr.message);
      }
    }

    // Validate promo code if provided
    let discountAmount = 0;
    let promoCodeStr = null;
    if (promo_code) {
      const promoItems = items.map(row => ({
        product_id: row.product_id,
        category_id: row.category_id,
        subtotal: row.subtotal,
        is_sample: row.is_sample
      }));
      const promoResult = await calculatePromoDiscount(promo_code, promoItems);
      if (!promoResult.valid) {
        return res.status(400).json({ error: promoResult.error });
      }
      discountAmount = promoResult.discount_amount;
      promoCodeStr = promoResult.promo.code;
    }

    const total = productSubtotal + shippingCost + sampleShipping - discountAmount;

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
      shipping_method: shippingMethod,
      discount_amount: discountAmount,
      promo_code: promoCodeStr
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
           oi.sqft_needed, oi.sell_by, oi.description, oi.price_tier,
           p.vendor_id, v.code as vendor_code, v.name as vendor_name,
           s.id as sku_id, s.vendor_sku,
           COALESCE(pr.cost, 0) as vendor_cost,
           COALESCE(pr.price_basis, 'per_sqft') as price_basis,
           pr.cut_cost, pr.roll_cost,
           pk.sqft_per_box
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN skus s ON s.id = oi.sku_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    LEFT JOIN packaging pk ON pk.sku_id = s.id
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

    // Calculate subtotal — cost per box * qty (boxes)
    let poSubtotal = 0;
    for (const item of group.items) {
      const sqftPerBox = parseFloat(item.sqft_per_box || 1);
      // For carpet items, use cut_cost or roll_cost based on price_tier
      let vendorCost = parseFloat(item.vendor_cost);
      if (item.price_tier === 'roll' && item.roll_cost != null) {
        vendorCost = parseFloat(item.roll_cost);
      } else if (item.price_tier === 'cut' && item.cut_cost != null) {
        vendorCost = parseFloat(item.cut_cost);
      }
      const costPerBox = item.price_basis === 'per_sqft' ? vendorCost * sqftPerBox : vendorCost;
      poSubtotal += costPerBox * item.qty;
    }

    // Create purchase order
    const poResult = await client.query(`
      INSERT INTO purchase_orders (order_id, vendor_id, po_number, status, subtotal)
      VALUES ($1, $2, $3, 'draft', $4)
      RETURNING *
    `, [orderId, group.vendor_id, poNumber, poSubtotal.toFixed(2)]);

    const po = poResult.rows[0];

    // Create purchase order items — all prices normalized to per-box
    for (const item of group.items) {
      const sqftPerBox = parseFloat(item.sqft_per_box || 1);
      let vendorCost = parseFloat(item.vendor_cost);
      if (item.price_tier === 'roll' && item.roll_cost != null) {
        vendorCost = parseFloat(item.roll_cost);
      } else if (item.price_tier === 'cut' && item.cut_cost != null) {
        vendorCost = parseFloat(item.cut_cost);
      }
      const costPerBox = item.price_basis === 'per_sqft' ? vendorCost * sqftPerBox : vendorCost;
      const retailPerBox = item.unit_price
        ? (item.price_basis === 'per_sqft' ? parseFloat(item.unit_price) * sqftPerBox : parseFloat(item.unit_price))
        : null;
      const itemSubtotal = costPerBox * item.qty;
      await client.query(`
        INSERT INTO purchase_order_items
          (purchase_order_id, order_item_id, sku_id, product_name, vendor_sku, description, qty, sell_by, cost, original_cost, retail_price, subtotal)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [po.id, item.order_item_id, item.sku_id, item.product_name, item.vendor_sku,
          item.description, item.qty, item.sell_by,
          costPerBox.toFixed(2), costPerBox.toFixed(2),
          retailPerBox !== null ? retailPerBox.toFixed(2) : null,
          itemSubtotal.toFixed(2)]);
    }

    createdPOs.push(po);
  }

  // Recalculate commission now that cost data is available
  if (createdPOs.length > 0) {
    setImmediate(() => recalculateCommission(pool, orderId));
  }

  return createdPOs;
}

app.post('/api/checkout/place-order', optionalTradeAuth, optionalCustomerAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { session_id, payment_intent_id, customer_name: bodyName, customer_email: bodyEmail, phone: bodyPhone, shipping, delivery_method,
            po_number, project_id, is_tax_exempt, shipping_option_id, residential, liftgate,
            create_account, account_password, promo_code } = req.body;

    // Pre-fill from customer profile if logged in
    const customer_name = bodyName || (req.customer ? (req.customer.first_name + ' ' + req.customer.last_name) : '');
    const customer_email = bodyEmail || (req.customer ? req.customer.email : '');
    const phone = bodyPhone || (req.customer ? req.customer.phone : '');

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
      SELECT ci.*, p.name as product_name, p.collection, p.category_id
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
    let selectedCarrier = null;
    let selectedTransitDays = null;
    let isResidential = residential !== false;
    let isLiftgate = liftgate !== false;
    let isFallback = false;
    if (isPickup) {
      shippingCost = 0;
      shippingMethod = 'pickup';
    } else if (productItems.length > 0) {
      try {
        const shippingResult = await calculateShipping(session_id, {
          zip: shipping.zip, city: shipping.city, state: shipping.state
        }, { residential: isResidential, liftgate: isLiftgate });
        const opts = shippingResult.options || [];
        const selected = (shipping_option_id && opts.find(o => o.id === shipping_option_id)) || opts.find(o => o.is_cheapest) || opts[0];
        shippingCost = selected ? selected.amount : 0;
        shippingMethod = shippingResult.method;
        selectedCarrier = selected ? selected.carrier : null;
        selectedTransitDays = selected ? selected.transit_days : null;
        isFallback = selected ? (selected.is_fallback || false) : false;
      } catch (shipErr) {
        console.error('Shipping calc error during order placement:', shipErr.message);
      }
    }

    // Validate promo code if provided (re-validate for race condition protection)
    let discountAmount = 0;
    let promoCodeId = null;
    let promoCodeStr = null;
    if (promo_code) {
      const promoItems = items.map(row => ({
        product_id: row.product_id,
        category_id: row.category_id,
        subtotal: row.subtotal,
        is_sample: row.is_sample
      }));
      const promoResult = await calculatePromoDiscount(promo_code, promoItems, customer_email, client);
      if (!promoResult.valid) {
        return res.status(400).json({ error: promoResult.error });
      }
      discountAmount = promoResult.discount_amount;
      promoCodeId = promoResult.promo.id;
      promoCodeStr = promoResult.promo.code;
    }

    const total = productSubtotal + shippingCost + sampleShipping - discountAmount;
    const tradeCustomerId = req.tradeCustomer ? req.tradeCustomer.id : null;
    const existingCustomerId = req.customer ? req.customer.id : null;

    const orderNumber = 'ORD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();

    await client.query('BEGIN');

    const orderResult = await client.query(`
      INSERT INTO orders (order_number, session_id, customer_email, customer_name, phone,
        shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip,
        subtotal, shipping, shipping_method, sample_shipping, total, stripe_payment_intent_id, delivery_method, status,
        trade_customer_id, po_number, is_tax_exempt, project_id,
        shipping_carrier, shipping_transit_days, shipping_residential, shipping_liftgate, shipping_is_fallback,
        customer_id, promo_code_id, promo_code, discount_amount, amount_paid)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'confirmed', $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)
      RETURNING *
    `, [orderNumber, session_id, customer_email, customer_name, phone || null,
        isPickup ? null : shipping.line1, isPickup ? null : (shipping.line2 || null),
        isPickup ? null : shipping.city, isPickup ? null : shipping.state, isPickup ? null : shipping.zip,
        productSubtotal.toFixed(2), shippingCost.toFixed(2), shippingMethod, sampleShipping.toFixed(2), total.toFixed(2),
        payment_intent_id, isPickup ? 'pickup' : 'shipping',
        tradeCustomerId, po_number || null, is_tax_exempt || false, project_id || null,
        selectedCarrier, selectedTransitDays, isResidential, isLiftgate, isFallback,
        existingCustomerId, promoCodeId, promoCodeStr, discountAmount.toFixed(2), total.toFixed(2)]);

    const order = orderResult.rows[0];

    for (const item of items) {
      await client.query(`
        INSERT INTO order_items (order_id, product_id, sku_id, product_name, collection,
          sqft_needed, num_boxes, unit_price, subtotal, is_sample, sell_by, price_tier)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [order.id, item.product_id || null, item.sku_id || null,
          item.product_name || null, item.collection || null,
          item.sqft_needed || null, item.num_boxes,
          item.unit_price || null, item.subtotal || null, item.is_sample || false,
          item.sell_by || null, item.price_tier || null]);
    }

    // Record initial charge in order_payments ledger
    await client.query(`
      INSERT INTO order_payments (order_id, payment_type, amount, stripe_payment_intent_id, description, status)
      VALUES ($1, 'charge', $2, $3, 'Original payment', 'completed')
    `, [order.id, total.toFixed(2), payment_intent_id]);

    // Record promo code usage
    if (promoCodeId && discountAmount > 0) {
      await client.query(
        'INSERT INTO promo_code_usages (promo_code_id, order_id, customer_email, discount_amount) VALUES ($1, $2, $3, $4)',
        [promoCodeId, order.id, customer_email, discountAmount.toFixed(2)]
      );
    }

    // Customer account creation at checkout
    let newCustomerToken = null;
    let newCustomerData = null;
    if (create_account && account_password && !req.customer) {
      const existingCust = await client.query('SELECT id FROM customers WHERE email = $1', [customer_email]);
      if (!existingCust.rows.length) {
        const nameParts = customer_name.trim().split(/\s+/);
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || '';
        const { hash, salt } = hashPassword(account_password);
        const custResult = await client.query(
          `INSERT INTO customers (email, password_hash, password_salt, first_name, last_name, phone,
            address_line1, address_line2, city, state, zip)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
          [customer_email, hash, salt, firstName, lastName, phone || null,
           isPickup ? null : (shipping ? shipping.line1 : null),
           isPickup ? null : (shipping ? shipping.line2 || null : null),
           isPickup ? null : (shipping ? shipping.city : null),
           isPickup ? null : (shipping ? shipping.state : null),
           isPickup ? null : (shipping ? shipping.zip : null)]
        );
        const newCust = custResult.rows[0];
        await client.query('UPDATE orders SET customer_id = $1 WHERE id = $2', [newCust.id, order.id]);

        newCustomerToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await client.query(
          'INSERT INTO customer_sessions (customer_id, token, expires_at) VALUES ($1, $2, $3)',
          [newCust.id, newCustomerToken, expiresAt]
        );
        newCustomerData = { id: newCust.id, email: newCust.email, first_name: newCust.first_name, last_name: newCust.last_name };
      }
    }

    // Generate purchase orders (one per vendor)
    await generatePurchaseOrders(order.id, client);

    // Trade customer: increment spend and check tier promotion
    if (tradeCustomerId) {
      await client.query(
        'UPDATE trade_customers SET total_spend = total_spend + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [total, tradeCustomerId]
      );
      const promotion = await checkTierPromotion(tradeCustomerId, client);
      if (promotion) {
        console.log(`[Trade] Customer ${tradeCustomerId} promoted to ${promotion.name}`);
      }

      // Auto-assign rep if unassigned
      const custCheck = await client.query('SELECT assigned_rep_id FROM trade_customers WHERE id = $1', [tradeCustomerId]);
      if (!custCheck.rows[0].assigned_rep_id) {
        const rep = await getNextAvailableRep();
        if (rep) {
          await client.query(
            'UPDATE trade_customers SET assigned_rep_id = $1, assigned_at = CURRENT_TIMESTAMP WHERE id = $2',
            [rep.id, tradeCustomerId]
          );
          await client.query(
            "INSERT INTO customer_rep_history (trade_customer_id, to_rep_id, reason) VALUES ($1, $2, 'Auto-assigned on first order')",
            [tradeCustomerId, rep.id]
          );
        }
      }
    }

    // Clear cart
    await client.query('DELETE FROM cart_items WHERE session_id = $1', [session_id]);

    await client.query('COMMIT');

    // Return order with items (include customer token if account was created)
    const orderItems = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
    const response = { order: { ...order, items: orderItems.rows } };
    if (newCustomerToken && newCustomerData) {
      response.customer_token = newCustomerToken;
      response.customer = newCustomerData;
    }
    res.json(response);

    // Recalculate commission for storefront order (if rep assigned)
    setImmediate(() => recalculateCommission(pool, order.id));

    // Fire-and-forget: send order confirmation email
    const emailOrder = { ...order, items: orderItems.rows };
    setImmediate(() => sendOrderConfirmation(emailOrder));

    // Fire-and-forget: notify all active reps about new storefront order
    setImmediate(() => notifyAllActiveReps(pool, 'new_order',
      'New Order ' + order.order_number,
      order.customer_name + ' placed order ' + order.order_number + ' ($' + parseFloat(order.total).toFixed(2) + ')',
      'order', order.id));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==================== Admin API ====================

// staffAuth removed in Phase 8 — all admin endpoints now use staffAuth
// Role-based access: staffAuth validates session, requireRole restricts by role
// Products/vendors/categories/import/scrapers/reps/margin-tiers: admin + manager
// Orders: all staff roles (warehouse needs read access)
// Trade customers: admin + manager + sales_rep
// Staff management: admin only
// Audit log: admin + manager (enforced at its own route)

// Dashboard stats
app.get('/api/admin/stats', staffAuth, async (req, res) => {
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

// Dashboard analytics
app.get('/api/admin/analytics', staffAuth, async (req, res) => {
  try {
    const period = req.query.period || '30d';
    let sinceDate = null;
    const now = new Date();
    if (period === '30d') {
      sinceDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    } else if (period === '90d') {
      sinceDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    } else if (period === '12m') {
      sinceDate = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    }
    // 'all' => sinceDate stays null

    const dateFilter = sinceDate ? `AND o.created_at >= $1` : '';
    const params = sinceDate ? [sinceDate.toISOString()] : [];

    const [summaryRes, costRes, revenueRes, topProductsRes, vendorRes, statusRes] = await Promise.all([
      // 1. Summary stats
      pool.query(`
        SELECT COALESCE(SUM(total), 0) as revenue,
               COUNT(*)::int as orders,
               COALESCE(AVG(total), 0) as avg_order_value
        FROM orders o
        WHERE status != 'cancelled' ${dateFilter}
      `, params),

      // 2. Cost & margin from purchase orders
      pool.query(`
        SELECT COALESCE(SUM(poi.subtotal), 0) as total_cost
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi.purchase_order_id
        JOIN orders o ON o.id = po.order_id
        WHERE o.status != 'cancelled' ${dateFilter}
      `, params),

      // 3. Revenue over time
      pool.query(
        (period === '12m' || period === 'all')
          ? `SELECT TO_CHAR(o.created_at, 'YYYY-MM') as date,
                    COALESCE(SUM(o.total), 0) as revenue,
                    COUNT(*)::int as order_count
             FROM orders o
             WHERE o.status != 'cancelled' ${dateFilter}
             GROUP BY TO_CHAR(o.created_at, 'YYYY-MM')
             ORDER BY date`
          : `SELECT DATE(o.created_at)::text as date,
                    COALESCE(SUM(o.total), 0) as revenue,
                    COUNT(*)::int as order_count
             FROM orders o
             WHERE o.status != 'cancelled' ${dateFilter}
             GROUP BY DATE(o.created_at)
             ORDER BY date`,
        params
      ),

      // 4. Top 10 products by revenue
      pool.query(`
        SELECT oi.product_id, COALESCE(p.name, oi.product_name) as name,
               COALESCE(SUM(oi.subtotal), 0) as revenue,
               COALESCE(SUM(oi.num_boxes), 0)::int as units_sold
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        LEFT JOIN products p ON p.id = oi.product_id
        WHERE o.status != 'cancelled' ${dateFilter}
        GROUP BY oi.product_id, p.name, oi.product_name
        ORDER BY revenue DESC
        LIMIT 10
      `, params),

      // 5. Vendor performance
      pool.query(`
        SELECT v.id as vendor_id, v.name,
               COALESCE(SUM(poi.retail_price * poi.qty), 0) as revenue,
               COALESCE(SUM(poi.subtotal), 0) as cost
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi.purchase_order_id
        JOIN vendors v ON v.id = po.vendor_id
        JOIN orders o ON o.id = po.order_id
        WHERE o.status != 'cancelled' ${dateFilter}
        GROUP BY v.id, v.name
        ORDER BY revenue DESC
      `, params),

      // 6. Order status breakdown
      pool.query(`
        SELECT status, COUNT(*)::int as count
        FROM orders o
        WHERE 1=1 ${dateFilter}
        GROUP BY status
        ORDER BY count DESC
      `, params)
    ]);

    const revenue = parseFloat(summaryRes.rows[0].revenue);
    const totalCost = parseFloat(costRes.rows[0].total_cost);
    const marginPct = revenue > 0 ? ((revenue - totalCost) / revenue) * 100 : 0;

    res.json({
      period,
      summary: {
        revenue,
        orders: summaryRes.rows[0].orders,
        avg_order_value: parseFloat(summaryRes.rows[0].avg_order_value),
        margin_pct: parseFloat(marginPct.toFixed(1))
      },
      revenue_over_time: revenueRes.rows.map(r => ({
        date: r.date,
        revenue: parseFloat(r.revenue),
        order_count: r.order_count
      })),
      top_products: topProductsRes.rows.map(r => ({
        product_id: r.product_id,
        name: r.name,
        revenue: parseFloat(r.revenue),
        units_sold: r.units_sold
      })),
      vendor_performance: vendorRes.rows.map(r => ({
        vendor_id: r.vendor_id,
        name: r.name,
        revenue: parseFloat(r.revenue),
        cost: parseFloat(r.cost),
        margin_pct: parseFloat(r.revenue) > 0
          ? parseFloat((((parseFloat(r.revenue) - parseFloat(r.cost)) / parseFloat(r.revenue)) * 100).toFixed(1))
          : 0
      })),
      order_status: statusRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all products (admin view - any status)
app.get('/api/admin/products', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const { search, vendor_id, category_id, status, sort, sort_dir } = req.query;

    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (search) {
      conditions.push(`(p.name ILIKE $${paramIdx} OR p.collection ILIKE $${paramIdx} OR (p.collection || ' ' || p.name) ILIKE $${paramIdx})`);
      params.push(`%${search}%`);
      paramIdx++;
    }
    if (vendor_id) {
      conditions.push(`p.vendor_id = $${paramIdx}`);
      params.push(vendor_id);
      paramIdx++;
    }
    if (category_id) {
      conditions.push(`p.category_id = $${paramIdx}`);
      params.push(category_id);
      paramIdx++;
    }
    if (status) {
      conditions.push(`p.status = $${paramIdx}`);
      params.push(status);
      paramIdx++;
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const allowedSorts = { name: 'p.name', vendor: 'v.name', category: 'c.name', price: 'price', skus: 'sku_count', status: 'p.status', created: 'p.created_at' };
    const orderCol = allowedSorts[sort] || 'p.created_at';
    const orderDir = sort_dir === 'asc' ? 'ASC' : 'DESC';

    const countResult = await pool.query(
      `SELECT COUNT(*)::int as total FROM products p
       LEFT JOIN vendors v ON v.id = p.vendor_id
       LEFT JOIN categories c ON c.id = p.category_id
       ${whereClause}`, params
    );

    const dataResult = await pool.query(
      `SELECT p.*, v.name as vendor_name, c.name as category_name,
        (SELECT COUNT(*)::int FROM skus s WHERE s.product_id = p.id) as sku_count,
        (SELECT pr.retail_price FROM pricing pr
         JOIN skus s ON s.id = pr.sku_id
         WHERE s.product_id = p.id LIMIT 1) as price,
        (SELECT ma.url FROM media_assets ma
         WHERE ma.product_id = p.id AND ma.asset_type != 'spec_pdf'
         ORDER BY CASE ma.asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 WHEN 'lifestyle' THEN 2 ELSE 3 END,
           CASE WHEN ma.sku_id IS NOT NULL THEN 0 ELSE 1 END, ma.sort_order LIMIT 1) as primary_image
      FROM products p
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      ${whereClause}
      ORDER BY ${orderCol} ${orderDir} NULLS LAST
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    );

    res.json({ products: dataResult.rows, total: countResult.rows[0].total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk update product status
app.patch('/api/admin/products/bulk/status', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.patch('/api/admin/products/bulk/category', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.delete('/api/admin/products/bulk', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.get('/api/admin/products/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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

    // Attach sku_attributes to each SKU
    if (skus.rows.length > 0) {
      const skuIds = skus.rows.map(s => s.id);
      const attrs = await pool.query(`
        SELECT sa.sku_id, a.slug, a.name, sa.value
        FROM sku_attributes sa
        JOIN attributes a ON a.id = sa.attribute_id
        WHERE sa.sku_id = ANY($1)
        ORDER BY a.display_order
      `, [skuIds]);
      const attrMap = {};
      for (const a of attrs.rows) {
        if (!attrMap[a.sku_id]) attrMap[a.sku_id] = [];
        attrMap[a.sku_id].push({ slug: a.slug, name: a.name, value: a.value });
      }
      for (const sku of skus.rows) {
        sku.attributes = attrMap[sku.id] || [];
      }
    }

    const media = await pool.query(`
      SELECT id, asset_type, url, sort_order, sku_id FROM media_assets
      WHERE product_id = $1 AND asset_type != 'spec_pdf'
      ORDER BY
        CASE asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 WHEN 'lifestyle' THEN 2 ELSE 3 END,
        CASE WHEN sku_id IS NULL THEN 0 ELSE 1 END,
        sort_order
    `, [id]);

    res.json({ product: product.rows[0], skus: skus.rows, media: media.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create product
app.post('/api/admin/products', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.put('/api/admin/products/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.delete('/api/admin/products/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.get('/api/admin/products/:productId/skus', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { productId } = req.params;
    const result = await pool.query(`
      SELECT s.*, pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs, pk.freight_class, pk.boxes_per_pallet, pk.sqft_per_pallet, pk.weight_per_pallet_lbs, pk.roll_width_ft,
        pr.cost, pr.retail_price, pr.price_basis, pr.cut_price, pr.roll_price, pr.cut_cost, pr.roll_cost, pr.roll_min_sqft
      FROM skus s
      LEFT JOIN packaging pk ON pk.sku_id = s.id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      WHERE s.product_id = $1
      ORDER BY s.created_at
    `, [productId]);

    // Attach sku_attributes
    if (result.rows.length > 0) {
      const skuIds = result.rows.map(s => s.id);
      const attrs = await pool.query(`
        SELECT sa.sku_id, a.slug, a.name, sa.value
        FROM sku_attributes sa
        JOIN attributes a ON a.id = sa.attribute_id
        WHERE sa.sku_id = ANY($1)
        ORDER BY a.display_order
      `, [skuIds]);
      const attrMap = {};
      for (const a of attrs.rows) {
        if (!attrMap[a.sku_id]) attrMap[a.sku_id] = [];
        attrMap[a.sku_id].push({ slug: a.slug, name: a.name, value: a.value });
      }
      for (const sku of result.rows) {
        sku.attributes = attrMap[sku.id] || [];
      }
    }

    res.json({ skus: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create SKU + packaging + pricing
app.post('/api/admin/products/:productId/skus', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { productId } = req.params;
    const { vendor_sku, internal_sku, variant_name, sell_by, sqft_per_box, pieces_per_box, weight_per_box_lbs, freight_class, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs, cost, retail_price, price_basis, cut_price, roll_price, cut_cost, roll_cost, roll_min_sqft, roll_width_ft } = req.body;
    if (!vendor_sku || !internal_sku) return res.status(400).json({ error: 'vendor_sku and internal_sku are required' });

    await client.query('BEGIN');

    const sku = await client.query(`
      INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [productId, vendor_sku, internal_sku, variant_name || null, sell_by || 'sqft']);

    const skuId = sku.rows[0].id;

    if (sqft_per_box || pieces_per_box || weight_per_box_lbs || boxes_per_pallet || roll_width_ft) {
      await client.query(`
        INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs, freight_class, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs, roll_width_ft)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [skuId, sqft_per_box || null, pieces_per_box || null, weight_per_box_lbs || null, freight_class || 70, boxes_per_pallet || null, sqft_per_pallet || null, weight_per_pallet_lbs || null, roll_width_ft || null]);
    }

    if (cost != null && retail_price != null) {
      await client.query(`
        INSERT INTO pricing (sku_id, cost, retail_price, price_basis, cut_price, roll_price, cut_cost, roll_cost, roll_min_sqft)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [skuId, cost, retail_price, price_basis || 'per_sqft', cut_price || null, roll_price || null, cut_cost || null, roll_cost || null, roll_min_sqft || null]);
    }

    await client.query('COMMIT');

    // Return full SKU with joins
    const full = await pool.query(`
      SELECT s.*, pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs, pk.freight_class, pk.boxes_per_pallet, pk.sqft_per_pallet, pk.weight_per_pallet_lbs, pk.roll_width_ft,
        pr.cost, pr.retail_price, pr.price_basis, pr.cut_price, pr.roll_price, pr.cut_cost, pr.roll_cost, pr.roll_min_sqft
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
app.put('/api/admin/skus/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { vendor_sku, internal_sku, variant_name, sell_by, sqft_per_box, pieces_per_box, weight_per_box_lbs, freight_class, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs, cost, retail_price, price_basis, cut_price, roll_price, cut_cost, roll_cost, roll_min_sqft, roll_width_ft } = req.body;

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
      INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs, freight_class, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs, roll_width_ft)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (sku_id) DO UPDATE SET
        sqft_per_box = COALESCE($2, packaging.sqft_per_box),
        pieces_per_box = COALESCE($3, packaging.pieces_per_box),
        weight_per_box_lbs = COALESCE($4, packaging.weight_per_box_lbs),
        freight_class = COALESCE($5, packaging.freight_class),
        boxes_per_pallet = COALESCE($6, packaging.boxes_per_pallet),
        sqft_per_pallet = COALESCE($7, packaging.sqft_per_pallet),
        weight_per_pallet_lbs = COALESCE($8, packaging.weight_per_pallet_lbs),
        roll_width_ft = COALESCE($9, packaging.roll_width_ft)
    `, [id, sqft_per_box, pieces_per_box, weight_per_box_lbs, freight_class, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs, roll_width_ft]);

    // Upsert pricing
    if (cost != null && retail_price != null) {
      await client.query(`
        INSERT INTO pricing (sku_id, cost, retail_price, price_basis, cut_price, roll_price, cut_cost, roll_cost, roll_min_sqft)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (sku_id) DO UPDATE SET
          cost = COALESCE($2, pricing.cost),
          retail_price = COALESCE($3, pricing.retail_price),
          price_basis = COALESCE($4, pricing.price_basis),
          cut_price = $5,
          roll_price = $6,
          cut_cost = $7,
          roll_cost = $8,
          roll_min_sqft = $9
      `, [id, cost, retail_price, price_basis, cut_price || null, roll_price || null, cut_cost || null, roll_cost || null, roll_min_sqft || null]);
    }

    await client.query('COMMIT');

    const full = await pool.query(`
      SELECT s.*, pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs, pk.freight_class, pk.boxes_per_pallet, pk.sqft_per_pallet, pk.weight_per_pallet_lbs, pk.roll_width_ft,
        pr.cost, pr.retail_price, pr.price_basis, pr.cut_price, pr.roll_price, pr.cut_cost, pr.roll_cost, pr.roll_min_sqft
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

// Update SKU attributes (batch upsert)
app.put('/api/admin/skus/:id/attributes', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { attributes } = req.body; // [{ slug, value }, ...]
    if (!Array.isArray(attributes)) return res.status(400).json({ error: 'attributes must be an array' });

    await client.query('BEGIN');

    for (const attr of attributes) {
      if (!attr.slug) continue;
      const attrRow = await client.query('SELECT id FROM attributes WHERE slug = $1', [attr.slug]);
      if (!attrRow.rows.length) continue;
      const attribute_id = attrRow.rows[0].id;

      if (!attr.value || !attr.value.trim()) {
        await client.query('DELETE FROM sku_attributes WHERE sku_id = $1 AND attribute_id = $2', [id, attribute_id]);
      } else {
        await client.query(`
          INSERT INTO sku_attributes (sku_id, attribute_id, value)
          VALUES ($1, $2, $3)
          ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
        `, [id, attribute_id, attr.value.trim()]);
      }
    }

    await client.query('COMMIT');

    // Return updated attributes
    const result = await pool.query(`
      SELECT a.slug, a.name, sa.value
      FROM sku_attributes sa
      JOIN attributes a ON a.id = sa.attribute_id
      WHERE sa.sku_id = $1
      ORDER BY a.display_order
    `, [id]);

    res.json({ attributes: result.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Delete SKU + related rows
app.delete('/api/admin/skus/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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

// ==================== Media Upload API ====================

const UPLOADS_DIR = process.env.UPLOADS_PATH || './uploads';

const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOADS_DIR, 'products', req.params.id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// 3A. Upload file
app.post('/api/admin/products/:id/media/upload', staffAuth, requireRole('admin', 'manager'), mediaUpload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'No valid file uploaded' });
    const product = await pool.query('SELECT id FROM products WHERE id = $1', [id]);
    if (!product.rows.length) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(404).json({ error: 'Product not found' });
    }
    const assetType = req.body.asset_type || 'alternate';
    let sortOrder = req.body.sort_order;
    if (sortOrder == null) {
      const maxSort = await pool.query(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM media_assets WHERE product_id = $1 AND asset_type = $2',
        [id, assetType]
      );
      sortOrder = maxSort.rows[0].next;
    }
    const url = `/uploads/products/${id}/${req.file.filename}`;
    const result = await pool.query(
      `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (product_id, asset_type, sort_order) DO UPDATE
       SET url = EXCLUDED.url, original_url = EXCLUDED.original_url, sku_id = EXCLUDED.sku_id
       RETURNING *`,
      [id, req.body.sku_id || null, assetType, url, req.file.originalname, sortOrder]
    );
    res.json({ media: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3B. Add media by URL
app.post('/api/admin/products/:id/media/url', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { url, asset_type = 'alternate', sort_order, sku_id } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const product = await pool.query('SELECT id FROM products WHERE id = $1', [id]);
    if (!product.rows.length) return res.status(404).json({ error: 'Product not found' });
    let finalSort = sort_order;
    if (finalSort == null) {
      const maxSort = await pool.query(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM media_assets WHERE product_id = $1 AND asset_type = $2',
        [id, asset_type]
      );
      finalSort = maxSort.rows[0].next;
    }
    const result = await pool.query(
      `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (product_id, asset_type, sort_order) DO UPDATE
       SET url = EXCLUDED.url, original_url = EXCLUDED.original_url, sku_id = EXCLUDED.sku_id
       RETURNING *`,
      [id, sku_id || null, asset_type, url, url, finalSort]
    );
    res.json({ media: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3C. Update media asset
app.put('/api/admin/media/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const fields = [];
    const vals = [];
    let i = 1;
    for (const key of ['asset_type', 'sort_order', 'sku_id']) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = $${i++}`);
        vals.push(req.body[key]);
      }
    }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    vals.push(id);
    const result = await pool.query(
      `UPDATE media_assets SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Media not found' });
    res.json({ media: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3D. Delete media asset
app.delete('/api/admin/media/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM media_assets WHERE id = $1 RETURNING *', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Media not found' });
    const deleted = result.rows[0];
    if (deleted.url && deleted.url.startsWith('/uploads/')) {
      const filePath = path.join(UPLOADS_DIR, deleted.url.replace('/uploads/', ''));
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
    res.json({ deleted: deleted.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3E. Reorder media assets
app.patch('/api/admin/products/:id/media/reorder', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { order } = req.body;
    if (!order || !order.length) return res.status(400).json({ error: 'order array is required' });
    await client.query('BEGIN');
    // Offset only the items being reordered to avoid unique constraint violations
    const reorderIds = order.map(o => o.id);
    await client.query(
      'UPDATE media_assets SET sort_order = sort_order + 10000 WHERE product_id = $1 AND id = ANY($2)',
      [id, reorderIds]
    );
    for (const item of order) {
      await client.query(
        'UPDATE media_assets SET sort_order = $1 WHERE id = $2 AND product_id = $3',
        [item.sort_order, item.id, id]
      );
    }
    await client.query('COMMIT');
    const result = await pool.query(
      'SELECT * FROM media_assets WHERE product_id = $1 ORDER BY asset_type, sort_order',
      [id]
    );
    res.json({ media: result.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 3F. List media for a product
app.get('/api/admin/products/:id/media', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM media_assets WHERE product_id = $1 ORDER BY asset_type, sort_order',
      [id]
    );
    res.json({ media: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List vendors with product counts
app.get('/api/admin/vendors', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.post('/api/admin/vendors', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { name, code, website, email } = req.body;
    if (!name || !code) return res.status(400).json({ error: 'Name and code are required' });

    const result = await pool.query(`
      INSERT INTO vendors (name, code, website, email)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [name, code, website || null, email || null]);
    res.json({ vendor: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update vendor
app.put('/api/admin/vendors/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, code, website, email } = req.body;

    const result = await pool.query(`
      UPDATE vendors SET
        name = COALESCE($1, name),
        code = COALESCE($2, code),
        website = COALESCE($3, website),
        email = $4,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING *
    `, [name, code, website, email || null, id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Vendor not found' });
    res.json({ vendor: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle vendor active status
app.patch('/api/admin/vendors/:id/toggle', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.get('/api/admin/categories', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.post('/api/admin/categories', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.put('/api/admin/categories/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.delete('/api/admin/categories/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.get('/api/admin/orders', staffAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.*,
        sr.first_name || ' ' || sr.last_name as rep_name,
        (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) as item_count
      FROM orders o
      LEFT JOIN staff_accounts sr ON sr.id = o.sales_rep_id
      ORDER BY o.created_at DESC
    `);
    res.json({ orders: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single order with items
app.get('/api/admin/orders/:id', staffAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const order = await pool.query(`
      SELECT o.*, sr.first_name || ' ' || sr.last_name as rep_name
      FROM orders o LEFT JOIN staff_accounts sr ON sr.id = o.sales_rep_id
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

    const payments = await pool.query('SELECT * FROM order_payments WHERE order_id = $1 ORDER BY created_at', [id]);
    const paymentRequests = await pool.query('SELECT * FROM payment_requests WHERE order_id = $1 ORDER BY created_at DESC', [id]);
    const balanceInfo = await recalculateBalance(id);

    res.json({ order: order.rows[0], items: items.rows, payments: payments.rows, payment_requests: paymentRequests.rows, balance: balanceInfo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update order status
app.put('/api/admin/orders/:id/status', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { status, tracking_number, carrier, shipped_at } = req.body;
    const validStatuses = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refunded'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be one of: ' + validStatuses.join(', ') });
    }

    // Refunded status can only be set via the dedicated refund endpoint
    if (status === 'refunded') {
      return res.status(400).json({ error: 'Use the refund endpoint to issue refunds' });
    }

    await client.query('BEGIN');

    // Block uncancelling a refunded order
    const currentOrder = await client.query('SELECT status, stripe_refund_id FROM orders WHERE id = $1', [id]);
    if (currentOrder.rows.length && currentOrder.rows[0].status === 'cancelled' && currentOrder.rows[0].stripe_refund_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot uncancel an order that has been refunded' });
    }

    // For shipped status with shipping delivery, require tracking info
    let result;
    if (status === 'shipped' && tracking_number) {
      result = await client.query(`
        UPDATE orders SET status = $1, tracking_number = $2, shipping_carrier = $3, shipped_at = COALESCE($4::timestamp, NOW())
        WHERE id = $5
        RETURNING *
      `, [status, tracking_number, carrier || null, shipped_at || null, id]);
    } else if (status === 'shipped') {
      // Check if this is a shipping order — if so, require tracking
      const orderCheck = await client.query('SELECT delivery_method FROM orders WHERE id = $1', [id]);
      if (orderCheck.rows.length && orderCheck.rows[0].delivery_method === 'shipping') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Tracking number is required for shipping orders' });
      }
      // Pickup order — no tracking needed
      result = await client.query(`
        UPDATE orders SET status = $1, shipped_at = NOW()
        WHERE id = $2
        RETURNING *
      `, [status, id]);
    } else if (status === 'confirmed') {
      result = await client.query(
        'UPDATE orders SET status = $1, confirmed_at = NOW() WHERE id = $2 RETURNING *',
        [status, id]
      );
    } else if (status === 'delivered') {
      result = await client.query(
        'UPDATE orders SET status = $1, delivered_at = NOW() WHERE id = $2 RETURNING *',
        [status, id]
      );
    } else {
      // When reverting to an earlier status, clear downstream timestamps
      const statusOrder = ['pending', 'confirmed', 'shipped', 'delivered'];
      const targetIdx = statusOrder.indexOf(status);
      const clearFields = [];
      const clearValues = [status, id];
      if (targetIdx >= 0) {
        if (targetIdx < 1) clearFields.push('confirmed_at = NULL');
        if (targetIdx < 2) clearFields.push('shipped_at = NULL, tracking_number = NULL, shipping_carrier = NULL');
        if (targetIdx < 3) clearFields.push('delivered_at = NULL');
      }
      const setClauses = ['status = $1'].concat(clearFields).join(', ');
      result = await client.query(
        'UPDATE orders SET ' + setClauses + ' WHERE id = $2 RETURNING *',
        clearValues
      );
    }

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

    // Cascade PO cancellation when order is cancelled
    if (status === 'cancelled') {
      const pos = await client.query(
        "SELECT id, status FROM purchase_orders WHERE order_id = $1 AND status NOT IN ('fulfilled', 'cancelled')",
        [id]
      );
      for (const po of pos.rows) {
        await client.query(
          "UPDATE purchase_orders SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
          [po.id]
        );
        await client.query(
          `INSERT INTO po_activity_log (purchase_order_id, action, performed_by, performer_name, details)
           VALUES ($1, 'auto_cancelled', $2, $3, $4)`,
          [po.id, req.staff.id, req.staff.first_name + ' ' + req.staff.last_name, JSON.stringify({ reason: 'order_cancelled' })]
        );
      }
    }

    // Delete cancelled POs when order is uncancelled — fresh POs will be generated on re-confirm
    const oldStatus = currentOrder.rows.length ? currentOrder.rows[0].status : null;
    if (oldStatus === 'cancelled' && status !== 'cancelled') {
      const cancelledPOs = await client.query(
        "SELECT id FROM purchase_orders WHERE order_id = $1 AND status = 'cancelled'",
        [id]
      );
      for (const po of cancelledPOs.rows) {
        await client.query('DELETE FROM po_activity_log WHERE purchase_order_id = $1', [po.id]);
        await client.query('DELETE FROM purchase_order_items WHERE purchase_order_id = $1', [po.id]);
        await client.query('DELETE FROM purchase_orders WHERE id = $1', [po.id]);
      }
    }

    await logOrderActivity(client, id, 'status_changed', req.staff.id, req.staff.first_name + ' ' + req.staff.last_name,
      { from: oldStatus, to: status, ...(tracking_number ? { tracking_number, carrier: carrier || null } : {}) });

    await client.query('COMMIT');
    const updatedOrder = result.rows[0];
    res.json({ order: updatedOrder });

    // Recalculate commission on admin status change
    setImmediate(() => recalculateCommission(pool, id));

    // Fire-and-forget: send status update email for shipped/delivered/cancelled
    setImmediate(() => sendOrderStatusUpdate(updatedOrder, status));

    // Notify assigned rep about admin status change
    if (updatedOrder.sales_rep_id) {
      setImmediate(() => createRepNotification(pool, updatedOrder.sales_rep_id, 'order_status_changed',
        'Order ' + updatedOrder.order_number + ' → ' + status,
        'Admin changed status to ' + status,
        'order', id));
    }
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Change delivery method on existing order (admin)
app.put('/api/admin/orders/:id/delivery-method', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { delivery_method, shipping_address, shipping_option_index, residential, liftgate } = req.body;

    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (!orderResult.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];

    if (!['pending', 'confirmed'].includes(order.status)) {
      return res.status(400).json({ error: 'Can only change delivery method on pending or confirmed orders' });
    }

    if (!['pickup', 'shipping'].includes(delivery_method)) {
      return res.status(400).json({ error: 'delivery_method must be "pickup" or "shipping"' });
    }

    const oldDeliveryMethod = order.delivery_method;
    const staffName = req.staff.first_name + ' ' + req.staff.last_name;

    // Switch to pickup
    if (delivery_method === 'pickup') {
      const newTotal = (parseFloat(order.subtotal) + parseFloat(order.sample_shipping || 0) - parseFloat(order.discount_amount || 0)).toFixed(2);
      const updated = await pool.query(`
        UPDATE orders SET delivery_method = 'pickup', shipping = 0, shipping_method = 'pickup',
          shipping_carrier = NULL, shipping_transit_days = NULL, shipping_residential = false,
          shipping_liftgate = false, shipping_is_fallback = false,
          shipping_address_line1 = NULL, shipping_address_line2 = NULL,
          shipping_city = NULL, shipping_state = NULL, shipping_zip = NULL,
          total = $2
        WHERE id = $1 RETURNING *
      `, [id, newTotal]);
      await logOrderActivity(pool, id, 'delivery_method_changed', req.staff.id, staffName,
        { from: oldDeliveryMethod, to: 'pickup' });
      const balanceInfo = await recalculateBalance(id);
      return res.json({ order: updated.rows[0], balance: balanceInfo });
    }

    // Switch to shipping — need address
    if (!shipping_address || !shipping_address.line1 || !shipping_address.city || !shipping_address.state || !shipping_address.zip) {
      return res.status(400).json({ error: 'shipping_address with line1, city, state, zip is required' });
    }

    // If no option selected yet, calculate rates and return them
    if (shipping_option_index === undefined || shipping_option_index === null) {
      const destination = { zip: shipping_address.zip, city: shipping_address.city, state: shipping_address.state };
      const rates = await calculateShippingForOrder(order.id, destination, { residential: residential !== false, liftgate: liftgate !== false });
      return res.json({ shipping_options: rates.options, method: rates.method, weight_lbs: rates.weight_lbs, total_boxes: rates.total_boxes });
    }

    // Apply selected shipping option
    const destination = { zip: shipping_address.zip, city: shipping_address.city, state: shipping_address.state };
    const rates = await calculateShippingForOrder(order.id, destination, { residential: residential !== false, liftgate: liftgate !== false });

    const optionIdx = parseInt(shipping_option_index);
    if (optionIdx < 0 || optionIdx >= rates.options.length) {
      return res.status(400).json({ error: 'Invalid shipping_option_index' });
    }

    const selected = rates.options[optionIdx];
    const shippingCost = parseFloat(selected.amount || 0);
    const newTotal = (parseFloat(order.subtotal) + shippingCost + parseFloat(order.sample_shipping || 0) - parseFloat(order.discount_amount || 0)).toFixed(2);

    const updated = await pool.query(`
      UPDATE orders SET delivery_method = 'shipping', shipping = $2, shipping_method = $3,
        shipping_carrier = $4, shipping_transit_days = $5,
        shipping_residential = $6, shipping_liftgate = $7, shipping_is_fallback = $8,
        shipping_address_line1 = $9, shipping_address_line2 = $10,
        shipping_city = $11, shipping_state = $12, shipping_zip = $13,
        total = $14
      WHERE id = $1 RETURNING *
    `, [id, shippingCost.toFixed(2), rates.method,
        selected.carrier || null, selected.transit_days || null,
        residential !== false, liftgate !== false, selected.is_fallback || false,
        shipping_address.line1, shipping_address.line2 || null,
        shipping_address.city, shipping_address.state, shipping_address.zip,
        newTotal]);

    await logOrderActivity(pool, id, 'delivery_method_changed', req.staff.id, staffName,
      { from: oldDeliveryMethod, to: 'shipping', shipping_cost: shippingCost.toFixed(2) });
    const balanceInfo = await recalculateBalance(id);
    return res.json({ order: updated.rows[0], balance: balanceInfo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Refund order (admin)
app.post('/api/admin/orders/:id/refund', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, reason } = req.body || {};
    const order = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });

    const o = order.rows[0];
    if (!o.stripe_payment_intent_id) {
      return res.status(400).json({ error: 'No Stripe payment found for this order' });
    }

    // Calculate max refundable from ledger
    const chargesResult = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) as total FROM order_payments WHERE order_id = $1 AND payment_type IN ('charge', 'additional_charge') AND status = 'completed'",
      [id]
    );
    const refundsResult = await pool.query(
      "SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM order_payments WHERE order_id = $1 AND payment_type = 'refund' AND status = 'completed'",
      [id]
    );
    const totalCharged = parseFloat(chargesResult.rows[0].total);
    const totalRefunded = parseFloat(refundsResult.rows[0].total);
    const maxRefundable = parseFloat((totalCharged - totalRefunded).toFixed(2));

    if (maxRefundable <= 0) {
      return res.status(400).json({ error: 'No refundable amount remaining' });
    }

    // Partial refund: use provided amount; full refund: requires cancelled status
    let refundAmount;
    if (amount != null) {
      refundAmount = parseFloat(parseFloat(amount).toFixed(2));
      if (isNaN(refundAmount) || refundAmount <= 0) {
        return res.status(400).json({ error: 'Invalid refund amount' });
      }
      if (refundAmount > maxRefundable) {
        return res.status(400).json({ error: `Refund amount exceeds maximum refundable ($${maxRefundable.toFixed(2)})` });
      }
    } else {
      // Full refund — require cancelled status
      if (o.status !== 'cancelled') {
        return res.status(400).json({ error: 'Order must be cancelled before issuing a full refund' });
      }
      refundAmount = maxRefundable;
    }

    const refundOpts = { payment_intent: o.stripe_payment_intent_id, amount: Math.round(refundAmount * 100) };
    const refund = await stripe.refunds.create(refundOpts);

    const staffName = req.staff.first_name + ' ' + req.staff.last_name;
    const description = reason || (amount != null ? `Partial refund of $${refundAmount.toFixed(2)}` : 'Full refund');

    // Record in ledger
    await pool.query(`
      INSERT INTO order_payments (order_id, payment_type, amount, stripe_payment_intent_id, stripe_refund_id, description, initiated_by, initiated_by_name, status)
      VALUES ($1, 'refund', $2, $3, $4, $5, $6, $7, 'completed')
    `, [id, (-refundAmount).toFixed(2), o.stripe_payment_intent_id, refund.id, description, req.staff.id, staffName]);

    // Update amount_paid
    const newAmountPaid = parseFloat((parseFloat(o.amount_paid) - refundAmount).toFixed(2));
    const isFullRefund = !amount && o.status === 'cancelled';

    const result = await pool.query(
      `UPDATE orders SET amount_paid = $1, stripe_refund_id = $2, refund_amount = COALESCE(refund_amount, 0) + $3,
        refunded_at = NOW(), refunded_by = $4 ${isFullRefund ? ", status = 'refunded'" : ''}
       WHERE id = $5 RETURNING *`,
      [newAmountPaid.toFixed(2), refund.id, refundAmount.toFixed(2), req.staff.id, id]
    );

    await logOrderActivity(pool, id, 'refund_issued', req.staff.id, staffName,
      { amount: refundAmount.toFixed(2), reason: reason || null, is_full: isFullRefund });
    const balanceInfo = await recalculateBalance(id);
    res.json({ order: result.rows[0], balance: balanceInfo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add item to existing order (admin)
// Supports two modes:
//   SKU mode: { sku_id, num_boxes, sqft_needed? }
//   Custom mode: { product_name, unit_price, vendor_id, num_boxes, description?, sqft_needed? }
app.post('/api/admin/orders/:id/add-item', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { sku_id, num_boxes, sqft_needed, product_name, unit_price, vendor_id, description } = req.body;

    const isCustom = !sku_id;
    if (isCustom) {
      if (!product_name || !product_name.trim()) return res.status(400).json({ error: 'product_name is required for custom items' });
      if (unit_price == null || parseFloat(unit_price) < 0) return res.status(400).json({ error: 'unit_price >= 0 is required for custom items' });
      if (!vendor_id) return res.status(400).json({ error: 'vendor_id is required for custom items' });
      if (!num_boxes || num_boxes < 1) return res.status(400).json({ error: 'num_boxes >= 1 is required' });
    } else {
      if (!num_boxes || num_boxes < 1) return res.status(400).json({ error: 'sku_id and num_boxes (>= 1) are required' });
    }

    const orderResult = await client.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (!orderResult.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (!['pending', 'confirmed'].includes(order.status)) {
      return res.status(400).json({ error: 'Can only add items to pending or confirmed orders' });
    }

    let sku = null;
    let unitPrice, isSample, sqftPerBox, isPerSqft, computedSqft, itemSubtotal;
    let itemVendorId;

    if (!isCustom) {
      // SKU mode: Look up SKU + product + pricing + cost
      const skuResult = await client.query(`
        SELECT s.*, p.name as product_name, p.collection, p.vendor_id,
          pr.retail_price, pr.price_basis, pr.cost,
          pk.sqft_per_box, pk.weight_per_box_lbs
        FROM skus s
        JOIN products p ON p.id = s.product_id
        LEFT JOIN pricing pr ON pr.sku_id = s.id
        LEFT JOIN packaging pk ON pk.sku_id = s.id
        WHERE s.id = $1
      `, [sku_id]);
      if (!skuResult.rows.length) return res.status(404).json({ error: 'SKU not found' });
      sku = skuResult.rows[0];

      unitPrice = parseFloat(sku.retail_price || 0);
      isSample = sku.is_sample || false;
      sqftPerBox = parseFloat(sku.sqft_per_box || 1);
      isPerSqft = sku.price_basis === 'per_sqft';
      computedSqft = isPerSqft ? num_boxes * sqftPerBox : null;
      itemSubtotal = isSample ? 0 : parseFloat((isPerSqft ? unitPrice * computedSqft : unitPrice * num_boxes).toFixed(2));
      itemVendorId = sku.vendor_id;
    } else {
      // Custom mode
      unitPrice = parseFloat(unit_price);
      isSample = false;
      itemSubtotal = parseFloat((unitPrice * num_boxes).toFixed(2));
      itemVendorId = vendor_id;

      // Validate vendor exists
      const vendorCheck = await client.query('SELECT id FROM vendors WHERE id = $1', [vendor_id]);
      if (!vendorCheck.rows.length) return res.status(400).json({ error: 'Vendor not found' });
    }

    await client.query('BEGIN');

    // Insert order item
    let newItemId;
    if (!isCustom) {
      const insertResult = await client.query(`
        INSERT INTO order_items (order_id, product_id, sku_id, product_name, collection,
          sqft_needed, num_boxes, unit_price, subtotal, is_sample, sell_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id
      `, [id, sku.product_id, sku_id, sku.product_name, sku.collection,
          sqft_needed || computedSqft || null, num_boxes, unitPrice.toFixed(2), itemSubtotal.toFixed(2),
          isSample, sku.sell_by || null]);
      newItemId = insertResult.rows[0].id;
    } else {
      const insertResult = await client.query(`
        INSERT INTO order_items (order_id, product_id, sku_id, product_name, collection,
          sqft_needed, num_boxes, unit_price, subtotal, is_sample, sell_by, description)
        VALUES ($1, NULL, NULL, $2, NULL, $3, $4, $5, $6, false, NULL, $7)
        RETURNING id
      `, [id, product_name.trim(), sqft_needed || null, num_boxes, unitPrice.toFixed(2),
          itemSubtotal.toFixed(2), description || null]);
      newItemId = insertResult.rows[0].id;
    }

    // Recalculate order totals
    const totalsResult = await client.query(`
      SELECT COALESCE(SUM(CASE WHEN NOT is_sample THEN subtotal ELSE 0 END), 0) as new_subtotal
      FROM order_items WHERE order_id = $1
    `, [id]);
    const newSubtotal = parseFloat(parseFloat(totalsResult.rows[0].new_subtotal).toFixed(2));
    const newTotal = parseFloat((newSubtotal + parseFloat(order.shipping || 0) + parseFloat(order.sample_shipping || 0) - parseFloat(order.discount_amount || 0)).toFixed(2));

    await client.query('UPDATE orders SET subtotal = $1, total = $2 WHERE id = $3',
      [newSubtotal.toFixed(2), newTotal.toFixed(2), id]);

    // --- Auto-update Purchase Orders ---
    if (!isSample) {
      // Find existing draft PO for this vendor on this order
      const existingPO = await client.query(
        `SELECT id, subtotal FROM purchase_orders
         WHERE order_id = $1 AND vendor_id = $2 AND status = 'draft'
         LIMIT 1`,
        [id, itemVendorId]
      );

      let poId;
      if (existingPO.rows.length) {
        poId = existingPO.rows[0].id;
      } else {
        // Create new draft PO for this vendor
        const vendorResult = await client.query('SELECT code FROM vendors WHERE id = $1', [itemVendorId]);
        const vendorCode = vendorResult.rows[0]?.code || 'CUST';
        const poNumber = `PO-${vendorCode}-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
        const newPO = await client.query(
          `INSERT INTO purchase_orders (order_id, vendor_id, po_number, status, subtotal)
           VALUES ($1, $2, $3, 'draft', 0) RETURNING id`,
          [id, itemVendorId, poNumber]
        );
        poId = newPO.rows[0].id;
      }

      // Build PO item values
      let poCost, poRetail, poVendorSku, poProductName;
      if (sku) {
        const skuSqftPerBox = parseFloat(sku.sqft_per_box || 1);
        const vendorCost = parseFloat(sku.cost || 0);
        poCost = sku.price_basis === 'per_sqft' ? vendorCost * skuSqftPerBox : vendorCost;
        poRetail = sku.price_basis === 'per_sqft' ? unitPrice * skuSqftPerBox : unitPrice;
        poVendorSku = sku.vendor_sku;
        poProductName = sku.product_name;
      } else {
        poCost = unitPrice;
        poRetail = unitPrice;
        poVendorSku = null;
        poProductName = product_name.trim();
      }

      // Insert PO item linked to order item
      await client.query(`
        INSERT INTO purchase_order_items
          (purchase_order_id, order_item_id, sku_id, product_name, vendor_sku, description,
           qty, sell_by, cost, original_cost, retail_price, subtotal)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11)
      `, [poId, newItemId, sku?.id || null, poProductName, poVendorSku,
          description || null, num_boxes, sku?.sell_by || null,
          poCost.toFixed(2), poRetail ? poRetail.toFixed(2) : null,
          (poCost * num_boxes).toFixed(2)]);

      // Recalculate PO subtotal
      await client.query(`
        UPDATE purchase_orders SET subtotal = (
          SELECT COALESCE(SUM(subtotal), 0) FROM purchase_order_items WHERE purchase_order_id = $1
        ) WHERE id = $1
      `, [poId]);
    }

    await logOrderActivity(client, id, 'item_added', req.staff.id, req.staff.first_name + ' ' + req.staff.last_name,
      { product_name: isCustom ? product_name.trim() : sku.product_name, is_custom: isCustom, num_boxes, subtotal: itemSubtotal.toFixed(2) });

    await client.query('COMMIT');

    const balanceInfo = await recalculateBalance(id);
    const updatedOrder = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    const updatedItems = await pool.query(`
      SELECT oi.*, p.name as current_product_name, p.collection as current_collection
      FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1 ORDER BY oi.id
    `, [id]);

    // Fetch updated POs for response
    const posResult = await pool.query(`
      SELECT po.*, v.name as vendor_name
      FROM purchase_orders po
      JOIN vendors v ON v.id = po.vendor_id
      WHERE po.order_id = $1
      ORDER BY po.created_at
    `, [id]);
    const purchaseOrders = posResult.rows;
    for (const po of purchaseOrders) {
      const poItems = await pool.query('SELECT * FROM purchase_order_items WHERE purchase_order_id = $1 ORDER BY created_at', [po.id]);
      po.items = poItems.rows;
    }

    res.json({ order: updatedOrder.rows[0], items: updatedItems.rows, balance: balanceInfo, purchase_orders: purchaseOrders });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Remove item from existing order (admin)
app.delete('/api/admin/orders/:id/items/:itemId', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id, itemId } = req.params;

    const orderResult = await client.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (!orderResult.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (!['pending', 'confirmed'].includes(order.status)) {
      return res.status(400).json({ error: 'Can only remove items from pending or confirmed orders' });
    }

    const itemResult = await client.query('SELECT * FROM order_items WHERE id = $1 AND order_id = $2', [itemId, id]);
    if (!itemResult.rows.length) return res.status(404).json({ error: 'Order item not found' });

    await client.query('BEGIN');

    // Delete linked PO items first (FK constraint), then recalculate affected PO subtotals
    const linkedPOItems = await client.query(
      'SELECT id, purchase_order_id FROM purchase_order_items WHERE order_item_id = $1', [itemId]
    );
    const affectedPOIds = [...new Set(linkedPOItems.rows.map(r => r.purchase_order_id))];
    if (linkedPOItems.rows.length > 0) {
      await client.query('DELETE FROM purchase_order_items WHERE order_item_id = $1', [itemId]);
    }

    await client.query('DELETE FROM order_items WHERE id = $1', [itemId]);

    // Recalculate affected PO subtotals and remove empty POs
    for (const poId of affectedPOIds) {
      const remaining = await client.query('SELECT COUNT(*) as cnt FROM purchase_order_items WHERE purchase_order_id = $1', [poId]);
      if (parseInt(remaining.rows[0].cnt) === 0) {
        await client.query('DELETE FROM purchase_orders WHERE id = $1', [poId]);
      } else {
        await client.query(`
          UPDATE purchase_orders SET subtotal = (
            SELECT COALESCE(SUM(subtotal), 0) FROM purchase_order_items WHERE purchase_order_id = $1
          ) WHERE id = $1
        `, [poId]);
      }
    }

    // Recalculate order totals
    const totalsResult = await client.query(`
      SELECT COALESCE(SUM(CASE WHEN NOT is_sample THEN subtotal ELSE 0 END), 0) as new_subtotal
      FROM order_items WHERE order_id = $1
    `, [id]);
    const newSubtotal = parseFloat(parseFloat(totalsResult.rows[0].new_subtotal).toFixed(2));
    const newTotal = parseFloat((newSubtotal + parseFloat(order.shipping || 0) + parseFloat(order.sample_shipping || 0) - parseFloat(order.discount_amount || 0)).toFixed(2));

    await client.query('UPDATE orders SET subtotal = $1, total = $2 WHERE id = $3',
      [newSubtotal.toFixed(2), newTotal.toFixed(2), id]);

    const removedItem = itemResult.rows[0];
    await logOrderActivity(client, id, 'item_removed', req.staff.id, req.staff.first_name + ' ' + req.staff.last_name,
      { product_name: removedItem.product_name, num_boxes: removedItem.num_boxes, subtotal: parseFloat(removedItem.subtotal).toFixed(2) });

    await client.query('COMMIT');

    const balanceInfo = await recalculateBalance(id);
    const updatedOrder = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    const updatedItems = await pool.query(`
      SELECT oi.*, p.name as current_product_name, p.collection as current_collection
      FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1 ORDER BY oi.id
    `, [id]);

    // Fetch updated POs
    const posResult = await pool.query(`
      SELECT po.*, v.name as vendor_name
      FROM purchase_orders po
      JOIN vendors v ON v.id = po.vendor_id
      WHERE po.order_id = $1
      ORDER BY po.created_at
    `, [id]);
    const purchaseOrders = posResult.rows;
    for (const po of purchaseOrders) {
      const poItems = await pool.query('SELECT * FROM purchase_order_items WHERE purchase_order_id = $1 ORDER BY created_at', [po.id]);
      po.items = poItems.rows;
    }

    res.json({ order: updatedOrder.rows[0], items: updatedItems.rows, balance: balanceInfo, purchase_orders: purchaseOrders });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Send payment request (admin)
app.post('/api/admin/orders/:id/payment-request', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body || {};
    const order = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });
    const o = order.rows[0];

    const balanceInfo = await recalculateBalance(id);
    if (!balanceInfo || balanceInfo.balance_status !== 'balance_due') {
      return res.status(400).json({ error: 'No balance due on this order' });
    }

    const amountDue = balanceInfo.balance;
    const staffName = req.staff.first_name + ' ' + req.staff.last_name;

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: o.customer_email,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `Balance Due — Order ${o.order_number}` },
          unit_amount: Math.round(amountDue * 100)
        },
        quantity: 1
      }],
      metadata: { order_id: id, type: 'payment_request' },
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/account?order=${id}&payment=success`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/account?order=${id}&payment=cancelled`,
      expires_at: Math.floor(Date.now() / 1000) + 72 * 3600
    });

    const prResult = await pool.query(`
      INSERT INTO payment_requests (order_id, amount, stripe_checkout_session_id, stripe_checkout_url, sent_to_email, sent_by, sent_by_name, message, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
    `, [id, amountDue.toFixed(2), session.id, session.url, o.customer_email, req.staff.id, staffName, message || null,
        new Date(Date.now() + 72 * 3600 * 1000)]);

    // Update metadata with payment_request_id
    await stripe.checkout.sessions.update(session.id, {
      metadata: { order_id: id, payment_request_id: prResult.rows[0].id, type: 'payment_request' }
    });

    await logOrderActivity(pool, id, 'payment_request_sent', req.staff.id, staffName,
      { amount: amountDue.toFixed(2), sent_to: o.customer_email });

    // Send email
    setImmediate(() => sendPaymentRequest({ order: o, amount: amountDue, checkout_url: session.url, message: message || null }));

    res.json({ payment_request: prResult.rows[0], checkout_url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel payment request (admin)
app.post('/api/admin/orders/:id/payment-requests/:reqId/cancel', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id, reqId } = req.params;
    const pr = await pool.query('SELECT * FROM payment_requests WHERE id = $1 AND order_id = $2', [reqId, id]);
    if (!pr.rows.length) return res.status(404).json({ error: 'Payment request not found' });
    if (pr.rows[0].status !== 'pending') return res.status(400).json({ error: 'Payment request is not pending' });

    // Expire the Stripe session
    if (pr.rows[0].stripe_checkout_session_id) {
      try { await stripe.checkout.sessions.expire(pr.rows[0].stripe_checkout_session_id); } catch (e) { /* session may already be expired */ }
    }

    await pool.query("UPDATE payment_requests SET status = 'cancelled' WHERE id = $1", [reqId]);
    await logOrderActivity(pool, id, 'payment_request_cancelled', req.staff.id, req.staff.first_name + ' ' + req.staff.last_name,
      { amount: parseFloat(pr.rows[0].amount).toFixed(2) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SKU search for add-item (admin)
app.get('/api/admin/skus/search', staffAuth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ results: [] });
    const results = await pool.query(`
      SELECT s.id as sku_id, s.internal_sku, s.vendor_sku, s.variant_name, s.is_sample, s.sell_by,
        p.name as product_name, p.collection, p.vendor_id,
        v.name as vendor_name,
        pr.retail_price, pr.cost, pr.price_basis,
        pk.sqft_per_box
      FROM skus s
      JOIN products p ON p.id = s.product_id
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      LEFT JOIN packaging pk ON pk.sku_id = s.id
      WHERE p.status = 'active' AND s.status = 'active'
        AND (p.name ILIKE $1 OR s.internal_sku ILIKE $1 OR s.vendor_sku ILIKE $1 OR s.variant_name ILIKE $1 OR p.collection ILIKE $1 OR (p.collection || ' ' || p.name) ILIKE $1)
      ORDER BY p.name, s.variant_name
      LIMIT 15
    `, ['%' + q + '%']);
    res.json({ results: results.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
app.get('/api/admin/import/fields', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.post('/api/admin/import/upload', staffAuth, requireRole('admin', 'manager'), importUpload.single('file'), (req, res) => {
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
app.post('/api/admin/import/validate', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.post('/api/admin/import/execute', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.post('/api/admin/import/templates', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.get('/api/admin/import/templates', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.delete('/api/admin/import/templates/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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

// --- Scraper orchestration: locking, concurrency, timeouts ---

// Scrapers that launch a Puppeteer browser (high memory — need concurrency limits)
const BROWSER_SCRAPERS = new Set([
  'msi', 'bed', 'tradepro-pricebooks', 'tradepro-inventory', 'bosphorus-inventory',
  'triwest-catalog', 'triwest-pricing', 'triwest-inventory',
  'triwest-provenza', 'triwest-paradigm', 'triwest-quickstep', 'triwest-armstrong',
  'triwest-metroflor', 'triwest-mirage', 'triwest-calclassics', 'triwest-grandpacific',
  'triwest-bravada', 'triwest-hartco', 'triwest-truetouch', 'triwest-citywide',
  'triwest-ahf', 'triwest-flexco', 'triwest-opulux', 'triwest-shaw', 'triwest-stanton',
  'triwest-bruce', 'triwest-congoleum', 'triwest-kraus', 'triwest-sika',
  'triwest-usrubber', 'triwest-tec', 'triwest-kenmark', 'triwest-bosphorus',
  'triwest-babool', 'triwest-elysium', 'triwest-forester', 'triwest-hardwoodsspecialty',
  'triwest-jmcork', 'triwest-rcglobal', 'triwest-summit', 'triwest-traditions',
  'triwest-wftaylor',
]);

// Enrichment scrapers (triwest-* brand scrapers) — separate pool so they don't block catalog/inventory
const ENRICHMENT_SCRAPERS = new Set([
  'triwest-provenza', 'triwest-paradigm', 'triwest-quickstep', 'triwest-armstrong',
  'triwest-metroflor', 'triwest-mirage', 'triwest-calclassics', 'triwest-grandpacific',
  'triwest-bravada', 'triwest-hartco', 'triwest-truetouch', 'triwest-citywide',
  'triwest-ahf', 'triwest-flexco', 'triwest-opulux', 'triwest-shaw', 'triwest-stanton',
  'triwest-bruce', 'triwest-congoleum', 'triwest-kraus', 'triwest-sika',
  'triwest-usrubber', 'triwest-tec', 'triwest-kenmark', 'triwest-bosphorus',
  'triwest-babool', 'triwest-elysium', 'triwest-forester', 'triwest-hardwoodsspecialty',
  'triwest-jmcork', 'triwest-rcglobal', 'triwest-summit', 'triwest-traditions',
  'triwest-wftaylor',
]);

// Concurrency control — two separate pools:
//   Catalog/pricing scrapers: max 2 (high memory, critical operations)
//   Enrichment scrapers: max 3 (separate pool, won't block catalog imports)
const MAX_BROWSER_SCRAPERS = 2;
const MAX_ENRICHMENT_SCRAPERS = 3;
let activeBrowserScrapers = 0;
let activeEnrichmentScrapers = 0;
const browserQueue = []; // { resolve, source }
const enrichmentQueue = []; // { resolve, source }

function isEnrichmentScraper(source) {
  return ENRICHMENT_SCRAPERS.has(source.scraper_key);
}

function acquireBrowserSlot(source) {
  if (!BROWSER_SCRAPERS.has(source.scraper_key)) return Promise.resolve(); // non-browser scrapers pass through

  if (isEnrichmentScraper(source)) {
    if (activeEnrichmentScrapers < MAX_ENRICHMENT_SCRAPERS) {
      activeEnrichmentScrapers++;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      enrichmentQueue.push({ resolve, source });
      console.log(`[Scraper] ${source.scraper_key} queued (enrichment) — ${enrichmentQueue.length} waiting, ${activeEnrichmentScrapers} active`);
    });
  }

  // Catalog/pricing/inventory scrapers
  if (activeBrowserScrapers < MAX_BROWSER_SCRAPERS) {
    activeBrowserScrapers++;
    return Promise.resolve();
  }
  return new Promise(resolve => {
    browserQueue.push({ resolve, source });
    console.log(`[Scraper] ${source.scraper_key} queued (browser) — ${browserQueue.length} waiting, ${activeBrowserScrapers} active`);
  });
}

function releaseBrowserSlot(source) {
  if (!BROWSER_SCRAPERS.has(source.scraper_key)) return;

  if (isEnrichmentScraper(source)) {
    activeEnrichmentScrapers = Math.max(0, activeEnrichmentScrapers - 1);
    if (enrichmentQueue.length > 0) {
      const next = enrichmentQueue.shift();
      activeEnrichmentScrapers++;
      console.log(`[Scraper] Dequeued ${next.source.scraper_key} (enrichment) — ${enrichmentQueue.length} still waiting`);
      next.resolve();
    }
    return;
  }

  activeBrowserScrapers = Math.max(0, activeBrowserScrapers - 1);
  if (browserQueue.length > 0) {
    const next = browserQueue.shift();
    activeBrowserScrapers++;
    console.log(`[Scraper] Dequeued ${next.source.scraper_key} (browser) — ${browserQueue.length} still waiting`);
    next.resolve();
  }
}

// Global timeout for scraper jobs (default 4 hours)
const SCRAPER_TIMEOUT_MS = parseInt(process.env.SCRAPER_TIMEOUT_MS || String(4 * 60 * 60 * 1000), 10);

// Track running scraper jobs so they can be stopped
// Map<jobId, AbortController>
const activeScraperJobs = new Map();

// Run a scraper for a given vendor source (async — does not await completion)
async function runScraper(source, configOverride = null) {
  // Merge config override into source config (for partial re-scrapes, direct URLs, etc.)
  if (configOverride) {
    source = { ...source, config: { ...(source.config || {}), ...configOverride } };
  }
  // --- Job locking: prevent duplicate concurrent runs per vendor_source ---
  const runningCheck = await pool.query(
    `SELECT id, started_at FROM scrape_jobs WHERE vendor_source_id = $1 AND status = 'running' LIMIT 1`,
    [source.id]
  );
  if (runningCheck.rows.length > 0) {
    const existing = runningCheck.rows[0];
    console.log(`[Scraper] Skipping ${source.scraper_key} — job ${existing.id} already running since ${existing.started_at}`);
    return { skipped: true, reason: 'already_running', existing_job_id: existing.id };
  }

  // Create job row
  const jobResult = await pool.query(`
    INSERT INTO scrape_jobs (vendor_source_id, status, started_at)
    VALUES ($1, 'running', CURRENT_TIMESTAMP)
    RETURNING *
  `, [source.id]);
  const job = jobResult.rows[0];

  // Create abort controller for this job so it can be stopped
  const abortController = new AbortController();
  activeScraperJobs.set(job.id, abortController);

  // Run in background
  (async () => {
    // Wait for browser concurrency slot if needed
    await acquireBrowserSlot(source);

    // Wrap execution in a timeout
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Scraper timed out after ${Math.round(SCRAPER_TIMEOUT_MS / 60000)} minutes`));
      }, SCRAPER_TIMEOUT_MS);
    });

    // Wrap abort signal as a rejecting promise
    const abortPromise = new Promise((_, reject) => {
      abortController.signal.addEventListener('abort', () => {
        reject(new Error('Scraper stopped by user'));
      }, { once: true });
    });

    try {
      const scraperModule = await import(`./scrapers/${source.scraper_key}.js`);
      await Promise.race([
        scraperModule.run(pool, job, source),
        timeoutPromise,
        abortPromise
      ]);
      clearTimeout(timeoutHandle);

      await pool.query(`
        UPDATE scrape_jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = $1
      `, [job.id]);
      await pool.query(`
        UPDATE vendor_sources SET last_scraped_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1
      `, [source.id]);
    } catch (err) {
      clearTimeout(timeoutHandle);
      const wasStopped = abortController.signal.aborted;
      const finalStatus = wasStopped ? 'cancelled' : 'failed';
      console.error(`Scraper ${source.scraper_key} ${finalStatus}:`, err.message);
      await pool.query(`
        UPDATE scrape_jobs SET status = $2, completed_at = CURRENT_TIMESTAMP,
          errors = errors || $3::jsonb
        WHERE id = $1
      `, [job.id, finalStatus, JSON.stringify([{ message: err.message, time: new Date().toISOString() }])]).catch(() => {});

      // Send failure notification email (not for user-initiated stops)
      if (!wasStopped) {
        const durationMin = job.started_at
          ? Math.round((Date.now() - new Date(job.started_at).getTime()) / 60000)
          : null;
        sendScraperFailure({
          source_name: source.name || source.scraper_key,
          scraper_key: source.scraper_key,
          job_id: job.id,
          error: err.message,
          started_at: job.started_at,
          duration_minutes: durationMin
        }).catch(emailErr => console.error('[Scraper] Failed to send failure alert email:', emailErr.message));
      }
    } finally {
      activeScraperJobs.delete(job.id);
      releaseBrowserSlot(source);
    }
  })();

  return job;
}

// List available scraper keys with defaults
app.get('/api/admin/scrapers', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  const scraperMeta = {
    'bed': {
      label: 'Bedrosians Catalog', source_type: 'website', base_url: 'https://www.bedrosians.com',
      categories: [
        '/en/product/list/porcelain/',
        '/en/product/list/ceramic-tiles/',
        '/en/product/list/marble-tiles/',
        '/en/product/list/travertine-tiles/',
        '/en/product/list/slate-tiles/',
        '/en/product/list/granite-tiles/',
        '/en/product/list/limestone-tiles/',
        '/en/product/list/glass-tiles/',
        '/en/product/list/mosaic/',
        '/en/product/list/subway-tiles/',
        '/en/product/list/decorative-tiles/',
        '/en/product/list/large-format/',
        '/en/product/list/zellige-tiles/',
        '/en/product/list/vinyl-flooring/',
        '/en/product/list/wood-look-tile/',
        '/en/product/list/outdoor/',
        '/en/product/list/pavers/',
        '/en/product/list/slabs/',
        '/en/product/list/trim-tiles/',
      ]
    },
    'bed-pricing': {
      label: 'Bedrosians Price List', source_type: 'pdf', base_url: '',
      categories: []
    },
    'msi': {
      label: 'MSI Catalog', source_type: 'website', base_url: 'https://www.msisurfaces.com',
      categories: [
        '/porcelain-tile/',
        '/marble-tile/',
        '/travertine-tile/',
        '/granite-tile/',
        '/quartzite-tile/',
        '/slate-tile/',
        '/sandstone-tile/',
        '/limestone-tile/',
        '/onyx-tile/',
        '/wood-look-tile-and-planks/',
        '/large-format-tile/',
        '/commercial-tile/',
        '/luxury-vinyl-flooring/',
        '/waterproof-hybrid-rigid-core/',
        '/w-luxury-genuine-hardwood/',
        '/quartz-countertops/',
        '/granite-countertops/',
        '/marble-countertops/',
        '/quartzite-countertops/',
        '/stile/porcelain-slabs/',
        '/prefabricated-countertops/',
        '/soapstone-countertops/',
        '/vanity-tops-countertops/',
        '/backsplash-tile/',
        '/mosaics/collections-mosaics/',
        '/fluted-looks/',
        '/hardscape/rockmount-stacked-stone/',
        '/hardscape/arterra-porcelain-pavers/',
        '/evergrass-turf/',
        '/waterproof-wood-flooring/woodhills/',
      ]
    },
    'msi-pricing-xlsx': {
      label: 'MSI Price List (Excel)', source_type: 'pdf', base_url: '',
      categories: []
    },
    'msi-inventory': {
      label: 'MSI Inventory', source_type: 'website', base_url: 'https://www.msisurfaces.com',
      categories: []
    },
    'daltile-pricing': {
      label: 'Daltile Price List (PDF)', source_type: 'pdf', base_url: '',
      categories: []
    },
    'ao-pricing': {
      label: 'American Olean Price List (PDF)', source_type: 'pdf', base_url: '',
      categories: []
    },
    'marazzi-pricing': {
      label: 'Marazzi Price List (PDF)', source_type: 'pdf', base_url: '',
      categories: []
    },
    'daltile-catalog': {
      label: 'Daltile Catalog (Website)', source_type: 'website', base_url: 'https://www.daltile.com',
      categories: []
    },
    'ao-catalog': {
      label: 'American Olean Catalog (Website)', source_type: 'website', base_url: 'https://www.americanolean.com',
      categories: []
    },
    'marazzi-catalog': {
      label: 'Marazzi Catalog (Website)', source_type: 'website', base_url: 'https://www.marazziusa.com',
      categories: []
    },
    'tradepro-pricebooks': {
      label: 'TradePro Price Book Download', source_type: 'portal', base_url: 'https://www.tradeproexchange.com',
      categories: []
    },
    'tradepro-inventory': {
      label: 'TradePro Inventory Check', source_type: 'portal', base_url: 'https://www.tradeproexchange.com',
      categories: []
    },
    'elysium': {
      label: 'Elysium Tile Catalog', source_type: 'portal', base_url: 'http://elysiumtile.com',
      categories: ['Mosaic', 'Porcelain Tile', 'SPC Vinyl', 'Marble Slab', 'Thin Porcelain Slab 6mm', 'Quartz, Quartzite, Granite', 'Ceramic Tile', 'Marble Tile']
    },
    'elysium-inventory': {
      label: 'Elysium Tile Inventory', source_type: 'portal', base_url: 'http://elysiumtile.com',
      categories: []
    },
    'elysium-pricelist': {
      label: 'Elysium Tile Price List (PDF)', source_type: 'portal', base_url: 'http://elysiumtile.com',
      categories: []
    },
    'arizona': {
      label: 'Arizona Tile Catalog', source_type: 'website', base_url: 'https://www.arizonatile.com',
      categories: ['Porcelain & Ceramic', 'Marble Tile', 'Mosaics', 'Granite Slab', 'Quartz', 'Quartzite', 'Marble Slab', 'Porcelain Slabs', 'Pavers']
    },
    'arizona-pricelist': {
      label: 'Arizona Tile Price List (PDF)', source_type: 'portal', base_url: 'https://www.arizonatile.com',
      categories: []
    },
    'emser-catalog': {
      label: 'Emser Tile Catalog (API)', source_type: 'website', base_url: 'https://www.emser.com',
      categories: ['Porcelain', 'Ceramic', 'Natural Stone', 'Mosaic', 'Glass', 'LVT']
    },
    'emser-pricelist': {
      label: 'Emser Price List (PDF)', source_type: 'pdf', base_url: '',
      categories: []
    },
    'bosphorus': {
      label: 'Bosphorus Imports Catalog', source_type: 'website', base_url: 'https://www.bosphorusimports.com',
      categories: []
    },
    'bosphorus-pricelist': {
      label: 'Bosphorus Imports Price List (PDF)', source_type: 'pdf', base_url: '',
      categories: []
    },
    'bosphorus-inventory': {
      label: 'Bosphorus Imports Inventory', source_type: 'portal', base_url: 'https://www.bosphorusimports.com',
      categories: []
    },
    'engfloors-832': {
      label: 'Engineered Floors EDI 832 (SFTP)', source_type: 'edi_sftp', base_url: 'sftp://ftp.engfloors.org',
      categories: []
    },
    'engfloors-webservices': {
      label: 'Engineered Floors Web Services (fcB2B)', source_type: 'api', base_url: 'https://www.engfloors.info/B2B',
      categories: []
    },
    'shaw-832': {
      label: 'Shaw Floors EDI 832 (SFTP)', source_type: 'edi_sftp', base_url: 'sftp://shawedi.shawfloors.com',
      categories: []
    },
    'shaw-edi-poller': {
      label: 'Shaw EDI Poller (855/856/810)', source_type: 'edi_sftp', base_url: 'sftp://shawedi.shawfloors.com',
      categories: []
    },
  };
  try {
    const fs = await import('fs');
    const path = await import('path');
    const dir = path.default.join(import.meta.dirname || '.', 'scrapers');
    const files = fs.default.readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'base.js');
    const scrapers = [];
    for (const f of files) {
      const key = f.replace('.js', '');
      try {
        const mod = await import(`./scrapers/${key}.js`);
        if (typeof mod.run === 'function') {
          const meta = scraperMeta[key] || {};
          scrapers.push({
            key,
            label: meta.label || key,
            source_type: meta.source_type || 'website',
            base_url: meta.base_url || '',
            categories: meta.categories || []
          });
        }
      } catch (e) { /* skip non-runnable */ }
    }
    res.json({ scrapers });
  } catch (err) {
    console.error('List scrapers error:', err);
    res.status(500).json({ error: err.message });
  }
});

// List vendor sources with last job info
app.get('/api/admin/vendor-sources', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.post('/api/admin/vendor-sources', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.put('/api/admin/vendor-sources/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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

    // Reload cron schedule if schedule or is_active changed
    const updated = result.rows[0];
    rescheduleSource(updated);

    res.json({ source: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete vendor source
app.delete('/api/admin/vendor-sources/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.post('/api/admin/vendor-sources/:id/scrape', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const sourceResult = await pool.query('SELECT * FROM vendor_sources WHERE id = $1', [id]);
    if (!sourceResult.rows.length) return res.status(404).json({ error: 'Source not found' });
    const source = sourceResult.rows[0];
    if (!source.scraper_key) {
      return res.status(400).json({ error: 'No scraper_key configured for this source' });
    }
    // Optional config override from request body (onlyCategories, directUrls, etc.)
    const configOverride = req.body.config || null;
    const result = await runScraper(source, configOverride);
    if (result.skipped) {
      return res.status(409).json({ error: 'A job is already running for this source', existing_job_id: result.existing_job_id });
    }
    res.json({ job: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop a running scrape job
app.post('/api/admin/scrape-jobs/:id/stop', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const jobResult = await pool.query('SELECT id, status FROM scrape_jobs WHERE id = $1', [id]);
    if (!jobResult.rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = jobResult.rows[0];
    if (job.status !== 'running') {
      return res.status(400).json({ error: 'Job is not currently running (status: ' + job.status + ')' });
    }

    const controller = activeScraperJobs.get(id);
    if (controller) {
      controller.abort();
      res.json({ stopped: true, job_id: id });
    } else {
      // Job marked as running in DB but no active controller (e.g., server restarted)
      await pool.query(`
        UPDATE scrape_jobs SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP,
          errors = errors || $2::jsonb
        WHERE id = $1
      `, [id, JSON.stringify([{ message: 'Stopped by user (no active process — stale job)', time: new Date().toISOString() }])]);
      res.json({ stopped: true, job_id: id, note: 'Stale job marked as cancelled' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload price list PDF for a vendor source
const pricelistUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOADS_DIR, 'pricelists', req.params.id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const timestamp = Date.now();
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${timestamp}-${safeName}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.toLowerCase().split('.').pop();
    const allowed = ['pdf', 'xlsb', 'xlsx', 'xls'];
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and Excel files are allowed'));
    }
  }
});

app.post('/api/admin/vendor-sources/:id/upload-pricelist', staffAuth, requireRole('admin', 'manager'), pricelistUpload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const sourceResult = await pool.query('SELECT * FROM vendor_sources WHERE id = $1', [id]);
    if (!sourceResult.rows.length) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(404).json({ error: 'Source not found' });
    }

    const pdfPath = req.file.path;
    const existingConfig = sourceResult.rows[0].config || {};
    const newConfig = { ...existingConfig, pdf_path: pdfPath };

    const result = await pool.query(`
      UPDATE vendor_sources SET config = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 RETURNING *
    `, [JSON.stringify(newConfig), id]);

    res.json({ source: result.rows[0], pdf_path: pdfPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List scrape jobs (paginated)
app.get('/api/admin/scrape-jobs', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
app.get('/api/admin/scrape-jobs/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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

// ==================== Trade Auth Middleware ====================

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
    res.status(500).json({ error: err.message });
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

// ==================== Customer Auth Middleware ====================

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
    res.status(500).json({ error: err.message });
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

// ==================== Staff Auth Middleware ====================

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
    res.status(500).json({ error: err.message });
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

// ==================== Staff Auth Endpoints ====================

// Check if any staff accounts exist (for first-time setup)
app.get('/api/staff/setup-check', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*)::int as count FROM staff_accounts');
    res.json({ needs_setup: result.rows[0].count === 0 });
  } catch (err) {
    // Table may not exist yet
    res.json({ needs_setup: true });
  }
});

// First-time setup: create initial admin account
app.post('/api/staff/setup', async (req, res) => {
  try {
    const existing = await pool.query('SELECT COUNT(*)::int as count FROM staff_accounts');
    if (existing.rows[0].count > 0) {
      return res.status(400).json({ error: 'Setup already completed. Use login instead.' });
    }

    const { email, password, first_name, last_name } = req.body;
    if (!email || !password || !first_name || !last_name) {
      return res.status(400).json({ error: 'Email, password, first name, and last name are required' });
    }

    const { hash, salt } = hashPassword(password);
    const result = await pool.query(`
      INSERT INTO staff_accounts (email, password_hash, password_salt, first_name, last_name, role)
      VALUES ($1, $2, $3, $4, $5, 'admin')
      RETURNING id, email, first_name, last_name, role
    `, [email.toLowerCase().trim(), hash, salt, first_name.trim(), last_name.trim()]);

    const staff = result.rows[0];

    // Create session
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO staff_sessions (staff_id, token, expires_at) VALUES ($1, $2, $3)',
      [staff.id, token, expiresAt]
    );

    await logAudit(staff.id, 'staff.setup', 'staff_accounts', staff.id, { email: staff.email }, req.ip);

    res.json({ token, staff });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account with this email already exists' });
    res.status(500).json({ error: err.message });
  }
});

// Rate limiting store for login attempts
const loginAttempts = {};
const LOGIN_MAX = 5;
const LOGIN_WINDOW = 15 * 60 * 1000; // 15 minutes

app.post('/api/staff/login', async (req, res) => {
  try {
    const { email, password, remember_me, device_fingerprint } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const emailKey = email.toLowerCase().trim();

    // Rate limiting
    const now = Date.now();
    if (!loginAttempts[emailKey]) loginAttempts[emailKey] = [];
    loginAttempts[emailKey] = loginAttempts[emailKey].filter(t => now - t < LOGIN_WINDOW);
    if (loginAttempts[emailKey].length >= LOGIN_MAX) {
      return res.status(429).json({ error: 'Too many login attempts. Please try again in 15 minutes.' });
    }

    const result = await pool.query('SELECT * FROM staff_accounts WHERE email = $1', [emailKey]);
    if (!result.rows.length) {
      loginAttempts[emailKey].push(now);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const staff = result.rows[0];
    if (!staff.is_active) return res.status(403).json({ error: 'Account deactivated' });
    if (!verifyPassword(password, staff.password_hash, staff.password_salt)) {
      loginAttempts[emailKey].push(now);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check if device is trusted
    const fpHash = device_fingerprint ? crypto.createHash('sha256').update(device_fingerprint).digest('hex') : null;
    let isTrusted = false;
    if (fpHash) {
      const trusted = await pool.query(
        'SELECT id FROM staff_sessions WHERE staff_id = $1 AND device_fingerprint = $2 AND is_trusted = true AND trusted_until > NOW()',
        [staff.id, fpHash]
      );
      isTrusted = trusted.rows.length > 0;
    }

    // If untrusted device, require 2FA (skip in dev when SMTP not configured)
    const smtpConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
    if (!isTrusted && fpHash && smtpConfigured) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const codeExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
      await pool.query(
        'INSERT INTO staff_2fa_codes (staff_id, code, expires_at) VALUES ($1, $2, $3)',
        [staff.id, code, codeExpires]
      );
      const { send2FACode } = await import('./services/emailService.js');
      await send2FACode(staff.email, code);
      return res.json({ requires_2fa: true, staff_id: staff.id });
    }
    if (!isTrusted && fpHash && !smtpConfigured) {
      console.log(`[Auth] 2FA bypassed for ${emailKey} — SMTP not configured (dev mode)`);
    }

    // Trusted device or no fingerprint — create session directly
    const token = crypto.randomBytes(32).toString('hex');
    const ttl = remember_me ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + ttl);

    await pool.query(
      'INSERT INTO staff_sessions (staff_id, token, device_fingerprint, is_trusted, trusted_until, remember_me, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [staff.id, token, fpHash, isTrusted, isTrusted ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null, remember_me || false, expiresAt]
    );

    await logAudit(staff.id, 'staff.login', 'staff_accounts', staff.id, { trusted_device: isTrusted }, req.ip);

    res.json({
      token,
      staff: {
        id: staff.id,
        email: staff.email,
        first_name: staff.first_name,
        last_name: staff.last_name,
        role: staff.role
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify 2FA code
app.post('/api/staff/verify-2fa', async (req, res) => {
  try {
    const { staff_id, code, trust_device, device_fingerprint } = req.body;
    if (!staff_id || !code) return res.status(400).json({ error: 'Staff ID and code are required' });

    const result = await pool.query(
      'SELECT * FROM staff_2fa_codes WHERE staff_id = $1 AND code = $2 AND expires_at > NOW() AND used = false ORDER BY created_at DESC LIMIT 1',
      [staff_id, code]
    );
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid or expired code' });

    // Mark code as used
    await pool.query('UPDATE staff_2fa_codes SET used = true WHERE id = $1', [result.rows[0].id]);

    // Get staff
    const staffResult = await pool.query('SELECT * FROM staff_accounts WHERE id = $1 AND is_active = true', [staff_id]);
    if (!staffResult.rows.length) return res.status(404).json({ error: 'Staff not found' });
    const staff = staffResult.rows[0];

    const fpHash = device_fingerprint ? crypto.createHash('sha256').update(device_fingerprint).digest('hex') : null;
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const trustedUntil = trust_device ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null;

    await pool.query(
      'INSERT INTO staff_sessions (staff_id, token, device_fingerprint, is_trusted, trusted_until, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [staff.id, token, fpHash, trust_device || false, trustedUntil, expiresAt]
    );

    await logAudit(staff.id, 'staff.login.2fa', 'staff_accounts', staff.id, { trusted: trust_device || false }, req.ip);

    res.json({
      token,
      staff: {
        id: staff.id,
        email: staff.email,
        first_name: staff.first_name,
        last_name: staff.last_name,
        role: staff.role
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/staff/logout', staffAuth, async (req, res) => {
  try {
    const token = req.headers['x-staff-token'];
    await pool.query('DELETE FROM staff_sessions WHERE token = $1', [token]);
    await logAudit(req.staff.id, 'staff.logout', 'staff_accounts', req.staff.id, {}, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/staff/me', staffAuth, async (req, res) => {
  res.json({ staff: req.staff });
});

// Staff CRUD (admin only)
app.get('/api/admin/staff', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sa.id, sa.email, sa.first_name, sa.last_name, sa.phone, sa.role, sa.is_active, sa.created_at,
        (SELECT COUNT(*)::int FROM trade_customers tc WHERE tc.assigned_rep_id = sa.id) as assigned_customers
      FROM staff_accounts sa
      ORDER BY sa.created_at DESC
    `);
    res.json({ staff: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/staff', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { email, password, first_name, last_name, phone, role } = req.body;
    if (!email || !password || !first_name || !last_name) {
      return res.status(400).json({ error: 'Email, password, first name, and last name are required' });
    }
    const validRoles = ['admin', 'manager', 'sales_rep', 'warehouse'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be one of: ' + validRoles.join(', ') });
    }
    // Managers cannot create admin accounts
    if (req.staff.role === 'manager' && role === 'admin') {
      return res.status(403).json({ error: 'Managers cannot create admin accounts' });
    }

    const { hash, salt } = hashPassword(password);
    const result = await pool.query(`
      INSERT INTO staff_accounts (email, password_hash, password_salt, first_name, last_name, phone, role)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, email, first_name, last_name, phone, role, is_active, created_at
    `, [email.toLowerCase().trim(), hash, salt, first_name.trim(), last_name.trim(), phone || null, role || 'sales_rep']);

    await logAudit(req.staff.id, 'staff.create', 'staff_accounts', result.rows[0].id, { email: email, role: role || 'sales_rep' }, req.ip);
    res.json({ staff_member: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account with this email already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/staff/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { email, first_name, last_name, phone, role } = req.body;
    const validRoles = ['admin', 'manager', 'sales_rep', 'warehouse'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    // Managers cannot edit admin accounts or promote to admin
    if (req.staff.role === 'manager') {
      const target = await pool.query('SELECT role FROM staff_accounts WHERE id = $1', [id]);
      if (target.rows.length && target.rows[0].role === 'admin') {
        return res.status(403).json({ error: 'Managers cannot edit admin accounts' });
      }
      if (role === 'admin') {
        return res.status(403).json({ error: 'Managers cannot promote accounts to admin' });
      }
    }

    const result = await pool.query(`
      UPDATE staff_accounts SET
        email = COALESCE($1, email),
        first_name = COALESCE($2, first_name),
        last_name = COALESCE($3, last_name),
        phone = COALESCE($4, phone),
        role = COALESCE($5, role),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING id, email, first_name, last_name, phone, role, is_active, created_at
    `, [email ? email.toLowerCase().trim() : null, first_name, last_name, phone, role, id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Staff member not found' });
    await logAudit(req.staff.id, 'staff.update', 'staff_accounts', id, { changes: req.body }, req.ip);
    res.json({ staff_member: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account with this email already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/staff/:id/toggle', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    // Prevent self-deactivation
    if (id === req.staff.id) {
      return res.status(400).json({ error: 'Cannot deactivate your own account' });
    }
    // Managers cannot toggle admin accounts
    if (req.staff.role === 'manager') {
      const target = await pool.query('SELECT role FROM staff_accounts WHERE id = $1', [id]);
      if (target.rows.length && target.rows[0].role === 'admin') {
        return res.status(403).json({ error: 'Managers cannot modify admin accounts' });
      }
    }

    const result = await pool.query(`
      UPDATE staff_accounts SET is_active = NOT is_active, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, email, first_name, last_name, phone, role, is_active, created_at
    `, [id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Staff member not found' });

    // Kill sessions if deactivated
    if (!result.rows[0].is_active) {
      await pool.query('DELETE FROM staff_sessions WHERE staff_id = $1', [id]);
    }

    await logAudit(req.staff.id, result.rows[0].is_active ? 'staff.activate' : 'staff.deactivate', 'staff_accounts', id, {}, req.ip);
    res.json({ staff_member: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/staff/:id/password', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password is required' });

    const { hash, salt } = hashPassword(password);
    const result = await pool.query(
      'UPDATE staff_accounts SET password_hash = $1, password_salt = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING id',
      [hash, salt, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Staff member not found' });

    // Kill all sessions for this staff member
    await pool.query('DELETE FROM staff_sessions WHERE staff_id = $1', [id]);

    await logAudit(req.staff.id, 'staff.password_reset', 'staff_accounts', id, {}, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Trade Auth Endpoints ====================

app.post('/api/trade/register', async (req, res) => {
  try {
    const { email, password, company_name, contact_name, phone } = req.body;
    if (!email || !password || !company_name || !contact_name) {
      return res.status(400).json({ error: 'Email, password, company name, and contact name are required' });
    }

    const { hash, salt } = hashPassword(password);
    await pool.query(
      `INSERT INTO trade_customers (email, password_hash, password_salt, company_name, contact_name, phone)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [email.toLowerCase().trim(), hash, salt, company_name.trim(), contact_name.trim(), phone || null]
    );

    res.json({ success: true, message: 'Registration submitted. Your account is pending approval.' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trade/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const result = await pool.query('SELECT * FROM trade_customers WHERE email = $1', [email.toLowerCase().trim()]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid email or password' });

    const customer = result.rows[0];
    if (customer.status === 'pending') {
      return res.status(403).json({ error: 'Your account is still pending approval. We will notify you once approved.' });
    }
    if (customer.status === 'rejected') {
      return res.status(403).json({ error: 'Your trade application has been declined.' });
    }
    if (!verifyPassword(password, customer.password_hash, customer.password_salt)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.query(
      'INSERT INTO trade_sessions (trade_customer_id, token, expires_at) VALUES ($1, $2, $3)',
      [customer.id, token, expiresAt]
    );

    // Fetch tier info
    let tier = null;
    if (customer.margin_tier_id) {
      const tierResult = await pool.query('SELECT name, discount_percent FROM margin_tiers WHERE id = $1', [customer.margin_tier_id]);
      if (tierResult.rows.length) tier = tierResult.rows[0];
    }

    res.json({
      token,
      customer: {
        id: customer.id,
        email: customer.email,
        company_name: customer.company_name,
        contact_name: customer.contact_name,
        tier_name: tier ? tier.name : null,
        discount_percent: tier ? parseFloat(tier.discount_percent) : 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trade/logout', tradeAuth, async (req, res) => {
  try {
    const token = req.headers['x-trade-token'];
    await pool.query('DELETE FROM trade_sessions WHERE token = $1', [token]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trade/me', tradeAuth, async (req, res) => {
  res.json({ customer: req.tradeCustomer });
});

// ==================== Trade Registration Enhancements (Phase 2) ====================

// Create Stripe SetupIntent for payment collection during registration
app.post('/api/trade/register/setup-intent', async (req, res) => {
  try {
    const { email } = req.body;
    const customer = await stripe.customers.create({ email });
    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ['card']
    });
    res.json({ client_secret: setupIntent.client_secret, stripe_customer_id: customer.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload document during registration
app.post('/api/trade/register/upload', docUpload.single('document'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No valid file uploaded' });
    const { doc_type } = req.body;
    if (!doc_type) return res.status(400).json({ error: 'doc_type is required' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    const fileKey = `trade-docs/${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    await uploadToS3(fileKey, req.file.buffer, req.file.mimetype);

    // Store temp doc reference (will link to trade_customer after registration)
    const result = await pool.query(`
      INSERT INTO trade_documents (trade_customer_id, doc_type, file_name, file_key, file_size, mime_type)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [
      req.body.trade_customer_id || null,
      doc_type, req.file.originalname, fileKey, req.file.size, req.file.mimetype
    ]);

    res.json({ document_id: result.rows[0].id, file_key: fileKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enhanced registration with business type, documents, and Stripe
app.post('/api/trade/register/enhanced', async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, password, company_name, contact_name, phone, business_type, document_ids, stripe_customer_id, address_line1, city, state, zip, contractor_license } = req.body;
    if (!email || !password || !company_name || !contact_name) {
      return res.status(400).json({ error: 'Email, password, company name, and contact name are required' });
    }
    if (!address_line1 || !city || !state || !zip) {
      return res.status(400).json({ error: 'Address, city, state, and zip are required' });
    }

    await client.query('BEGIN');

    const { hash, salt } = hashPassword(password);
    const result = await client.query(
      `INSERT INTO trade_customers (email, password_hash, password_salt, company_name, contact_name, phone, business_type, stripe_customer_id, address_line1, city, state, zip, contractor_license)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [email.toLowerCase().trim(), hash, salt, company_name.trim(), contact_name.trim(), phone || null, business_type || null, stripe_customer_id || null, address_line1.trim(), city.trim(), state.trim().toUpperCase(), zip.trim(), contractor_license || null]
    );

    const customerId = result.rows[0].id;

    // Link uploaded documents
    if (document_ids && document_ids.length > 0) {
      await client.query(
        'UPDATE trade_documents SET trade_customer_id = $1 WHERE id = ANY($2)',
        [customerId, document_ids]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Registration submitted. Your account is pending approval.' });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'An account with this email already exists' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Admin: get documents for a trade customer (presigned URLs)
app.get('/api/admin/trade-customers/:id/documents', staffAuth, requireRole('admin', 'manager', 'sales_rep'), async (req, res) => {
  try {
    const docs = await pool.query(
      'SELECT * FROM trade_documents WHERE trade_customer_id = $1 ORDER BY uploaded_at',
      [req.params.id]
    );
    const docsWithUrls = await Promise.all(docs.rows.map(async (doc) => {
      let url = null;
      try { url = await getPresignedUrl(doc.file_key); } catch {}
      return { ...doc, url };
    }));
    res.json({ documents: docsWithUrls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: approve trade customer (creates Stripe subscription)
app.post('/api/admin/trade-customers/:id/approve', staffAuth, requireRole('admin', 'manager', 'sales_rep'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { margin_tier_id } = req.body;

    const cust = await client.query('SELECT * FROM trade_customers WHERE id = $1', [id]);
    if (!cust.rows.length) return res.status(404).json({ error: 'Customer not found' });
    const tc = cust.rows[0];

    if (tc.status === 'approved') return res.status(400).json({ error: 'Already approved' });

    await client.query('BEGIN');

    // If no tier specified, find Silver tier
    let tierId = margin_tier_id;
    if (!tierId) {
      const silver = await client.query("SELECT id FROM margin_tiers WHERE tier_level = 0 ORDER BY tier_level LIMIT 1");
      if (silver.rows.length) tierId = silver.rows[0].id;
    }

    // Create Stripe subscription if customer has stripe_customer_id
    let subscriptionId = null;
    let subscriptionExpiry = null;
    if (tc.stripe_customer_id) {
      try {
        const subscription = await stripe.subscriptions.create({
          customer: tc.stripe_customer_id,
          items: [{ price_data: { currency: 'usd', product_data: { name: 'Roma Flooring Trade Membership' }, recurring: { interval: 'year' }, unit_amount: 9900 } }],
        });
        subscriptionId = subscription.id;
        subscriptionExpiry = new Date(subscription.current_period_end * 1000);
      } catch (stripeErr) {
        console.error('Stripe subscription creation failed:', stripeErr.message);
      }
    }

    const staffId = req.staff ? req.staff.id : null;

    await client.query(`
      UPDATE trade_customers SET
        status = 'approved',
        margin_tier_id = COALESCE($1, margin_tier_id),
        stripe_subscription_id = $2,
        subscription_status = $3,
        subscription_expires_at = $4,
        approved_by = $5,
        approved_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
    `, [tierId, subscriptionId, subscriptionId ? 'active' : 'none', subscriptionExpiry, staffId, id]);

    await client.query('COMMIT');

    if (staffId) await logAudit(staffId, 'trade.approve', 'trade_customers', id, { margin_tier_id: tierId }, req.ip);

    // Send approval email
    try {
      const { sendTradeApproval } = await import('./services/emailService.js');
      if (sendTradeApproval) await sendTradeApproval(tc);
    } catch {}

    const full = await pool.query(`
      SELECT tc.*, mt.name as tier_name, mt.discount_percent
      FROM trade_customers tc LEFT JOIN margin_tiers mt ON mt.id = tc.margin_tier_id WHERE tc.id = $1
    `, [id]);
    res.json({ customer: full.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Admin: deny trade customer
app.post('/api/admin/trade-customers/:id/deny', staffAuth, requireRole('admin', 'manager', 'sales_rep'), async (req, res) => {
  try {
    const { id } = req.params;
    const { denial_reason } = req.body;

    const result = await pool.query(`
      UPDATE trade_customers SET
        status = 'rejected',
        denial_reason = $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
    `, [denial_reason || null, id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Customer not found' });

    // Clean up Stripe payment method if exists
    const tc = result.rows[0];
    if (tc.stripe_customer_id) {
      try {
        const paymentMethods = await stripe.paymentMethods.list({ customer: tc.stripe_customer_id, type: 'card' });
        for (const pm of paymentMethods.data) {
          await stripe.paymentMethods.detach(pm.id);
        }
      } catch {}
    }

    // Kill sessions
    await pool.query('DELETE FROM trade_sessions WHERE trade_customer_id = $1', [id]);

    const staffId = req.staff ? req.staff.id : null;
    if (staffId) await logAudit(staffId, 'trade.deny', 'trade_customers', id, { denial_reason }, req.ip);

    // Send denial email
    try {
      const { sendTradeDenial } = await import('./services/emailService.js');
      if (sendTradeDenial) await sendTradeDenial(tc);
    } catch {}

    res.json({ customer: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Tier Progression (Phase 3) ====================

async function checkTierPromotion(tradeCustomerId, client) {
  const db = client || pool;
  const cust = await db.query('SELECT id, total_spend, margin_tier_id FROM trade_customers WHERE id = $1', [tradeCustomerId]);
  if (!cust.rows.length) return null;

  const spend = parseFloat(cust.rows[0].total_spend) || 0;
  const currentTierId = cust.rows[0].margin_tier_id;

  // Get current tier level
  let currentLevel = -1;
  if (currentTierId) {
    const ct = await db.query('SELECT tier_level FROM margin_tiers WHERE id = $1', [currentTierId]);
    if (ct.rows.length) currentLevel = ct.rows[0].tier_level;
  }

  // Find the highest qualifying tier (never demote)
  const tiers = await db.query(
    'SELECT id, name, tier_level, spend_threshold FROM margin_tiers WHERE is_active = true AND spend_threshold <= $1 AND tier_level > $2 ORDER BY tier_level DESC LIMIT 1',
    [spend, currentLevel]
  );

  if (tiers.rows.length) {
    const newTier = tiers.rows[0];
    await db.query(
      'UPDATE trade_customers SET margin_tier_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newTier.id, tradeCustomerId]
    );
    // Send tier promotion email
    const custData = await db.query('SELECT email, contact_name, company_name FROM trade_customers WHERE id = $1', [tradeCustomerId]);
    if (custData.rows.length) {
      setImmediate(() => sendTierPromotion(custData.rows[0], newTier.name));
    }
    // Audit log
    try { await logAudit(null, 'trade.tier_promotion', 'trade_customer', tradeCustomerId, { new_tier: newTier.name, spend: spend }); } catch (_) {}
    return newTier;
  }
  return null;
}

// PUT /api/trade/payment-method — update Stripe payment method
app.put('/api/trade/payment-method', tradeAuth, async (req, res) => {
  try {
    const { payment_method_id } = req.body;
    if (!payment_method_id) return res.status(400).json({ error: 'payment_method_id required' });

    const cust = await pool.query('SELECT stripe_customer_id, stripe_subscription_id FROM trade_customers WHERE id = $1', [req.tradeCustomer.id]);
    const stripeCustomerId = cust.rows[0]?.stripe_customer_id;
    if (!stripeCustomerId) return res.status(400).json({ error: 'No Stripe customer on file' });

    // Attach the new payment method to the customer
    await stripe.paymentMethods.attach(payment_method_id, { customer: stripeCustomerId });

    // Set as default payment method
    await stripe.customers.update(stripeCustomerId, {
      invoice_settings: { default_payment_method: payment_method_id }
    });

    // If subscription exists, update its default payment method too
    const subId = cust.rows[0]?.stripe_subscription_id;
    if (subId) {
      await stripe.subscriptions.update(subId, { default_payment_method: payment_method_id });
    }

    res.json({ success: true, message: 'Payment method updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trade membership endpoints
app.get('/api/trade/membership', tradeAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT tc.total_spend, tc.subscription_status, tc.subscription_expires_at,
        tc.stripe_subscription_id, mt.name as tier_name, mt.discount_percent, mt.tier_level,
        mt.spend_threshold
      FROM trade_customers tc
      LEFT JOIN margin_tiers mt ON mt.id = tc.margin_tier_id
      WHERE tc.id = $1
    `, [req.tradeCustomer.id]);

    // Get next tier info
    const nextTier = await pool.query(
      'SELECT name, spend_threshold, discount_percent FROM margin_tiers WHERE is_active = true AND tier_level > COALESCE((SELECT tier_level FROM margin_tiers WHERE id = $1), -1) ORDER BY tier_level LIMIT 1',
      [result.rows[0] ? result.rows[0].margin_tier_id : null]
    );

    res.json({
      membership: result.rows[0],
      next_tier: nextTier.rows[0] || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trade/cancel-membership', tradeAuth, async (req, res) => {
  try {
    const cust = await pool.query('SELECT stripe_subscription_id FROM trade_customers WHERE id = $1', [req.tradeCustomer.id]);
    const subId = cust.rows[0]?.stripe_subscription_id;

    if (subId) {
      await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
      await pool.query(
        "UPDATE trade_customers SET subscription_status = 'cancelling', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [req.tradeCustomer.id]
      );
    }
    res.json({ success: true, message: 'Membership will end at the current billing period' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stripe webhook handler
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = req.body;
    switch (event.type) {
      case 'invoice.payment_succeeded': {
        const sub = event.data.object.subscription;
        if (sub) {
          await pool.query(
            "UPDATE trade_customers SET subscription_status = 'active', subscription_expires_at = to_timestamp($1), updated_at = CURRENT_TIMESTAMP WHERE stripe_subscription_id = $2",
            [event.data.object.period_end, sub]
          );
        }
        break;
      }
      case 'invoice.payment_failed': {
        const sub = event.data.object.subscription;
        if (sub) {
          await pool.query(
            "UPDATE trade_customers SET subscription_status = 'past_due', updated_at = CURRENT_TIMESTAMP WHERE stripe_subscription_id = $1",
            [sub]
          );
          // Send lapsed notification
          const pastDueCust = await pool.query('SELECT id, email, contact_name, company_name FROM trade_customers WHERE stripe_subscription_id = $1', [sub]);
          if (pastDueCust.rows.length) {
            setImmediate(() => sendSubscriptionLapsed(pastDueCust.rows[0]));
          }
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const subId = event.data.object.id;
        await pool.query(
          "UPDATE trade_customers SET subscription_status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE stripe_subscription_id = $1",
          [subId]
        );
        break;
      }
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.metadata && session.metadata.type === 'payment_request') {
          const { order_id, payment_request_id } = session.metadata;
          const paidAmount = (session.amount_total || 0) / 100;

          // Mark payment request as paid
          if (payment_request_id) {
            await pool.query(
              "UPDATE payment_requests SET status = 'paid', paid_at = NOW() WHERE id = $1",
              [payment_request_id]
            );
          }

          // Record additional charge in ledger
          await pool.query(`
            INSERT INTO order_payments (order_id, payment_type, amount, stripe_checkout_session_id, description, status)
            VALUES ($1, 'additional_charge', $2, $3, 'Additional payment via checkout', 'completed')
          `, [order_id, paidAmount.toFixed(2), session.id]);

          // Update amount_paid
          await pool.query(
            'UPDATE orders SET amount_paid = amount_paid + $1 WHERE id = $2',
            [paidAmount.toFixed(2), order_id]
          );

          // Send confirmation email
          const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [order_id]);
          if (orderResult.rows.length) {
            setImmediate(() => sendPaymentReceived(orderResult.rows[0], paidAmount));

            // Notify assigned rep about payment received
            if (orderResult.rows[0].sales_rep_id) {
              setImmediate(() => createRepNotification(pool, orderResult.rows[0].sales_rep_id, 'payment_received',
                'Payment received for ' + orderResult.rows[0].order_number,
                '$' + paidAmount.toFixed(2) + ' payment received for order ' + orderResult.rows[0].order_number,
                'order', order_id));
            }
          }
        }
        break;
      }
      case 'checkout.session.expired': {
        const session = event.data.object;
        if (session.metadata && session.metadata.type === 'payment_request' && session.metadata.payment_request_id) {
          await pool.query(
            "UPDATE payment_requests SET status = 'expired' WHERE id = $1 AND status = 'pending'",
            [session.metadata.payment_request_id]
          );
        }
        break;
      }
    }
    res.json({ received: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Customer-Rep Assignment (Phase 4) ====================

async function getNextAvailableRep() {
  const result = await pool.query(`
    SELECT sa.id, sa.first_name, sa.last_name, COUNT(tc.id)::int as customer_count
    FROM staff_accounts sa
    LEFT JOIN trade_customers tc ON tc.assigned_rep_id = sa.id
    WHERE sa.role IN ('sales_rep', 'manager') AND sa.is_active = true
    GROUP BY sa.id, sa.first_name, sa.last_name
    ORDER BY customer_count ASC, sa.created_at ASC
    LIMIT 1
  `);
  return result.rows[0] || null;
}

app.put('/api/admin/trade-customers/:id/assign-rep', staffAuth, requireRole('admin', 'manager', 'sales_rep'), async (req, res) => {
  try {
    const { id } = req.params;
    const { rep_id } = req.body;
    const staffId = req.staff ? req.staff.id : null;

    const cust = await pool.query('SELECT assigned_rep_id FROM trade_customers WHERE id = $1', [id]);
    if (!cust.rows.length) return res.status(404).json({ error: 'Customer not found' });
    const fromRepId = cust.rows[0].assigned_rep_id;

    await pool.query(
      'UPDATE trade_customers SET assigned_rep_id = $1, assigned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [rep_id || null, id]
    );

    // Log history
    await pool.query(
      'INSERT INTO customer_rep_history (trade_customer_id, from_rep_id, to_rep_id, reason, changed_by) VALUES ($1, $2, $3, $4, $5)',
      [id, fromRepId, rep_id, req.body.reason || 'Manual assignment', staffId]
    );

    if (staffId) await logAudit(staffId, 'trade.assign_rep', 'trade_customers', id, { from_rep_id: fromRepId, to_rep_id: rep_id }, req.ip);

    const full = await pool.query(`
      SELECT tc.*, mt.name as tier_name, mt.discount_percent,
        sa.first_name || ' ' || sa.last_name as rep_name
      FROM trade_customers tc
      LEFT JOIN margin_tiers mt ON mt.id = tc.margin_tier_id
      LEFT JOIN staff_accounts sa ON sa.id = tc.assigned_rep_id
      WHERE tc.id = $1
    `, [id]);
    res.json({ customer: full.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trade/my-rep', tradeAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sa.first_name, sa.last_name, sa.email, sa.phone
      FROM staff_accounts sa
      JOIN trade_customers tc ON tc.assigned_rep_id = sa.id
      WHERE tc.id = $1
    `, [req.tradeCustomer.id]);
    res.json({ rep: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/staff/my-customers — list trade customers assigned to current staff member
app.get('/api/staff/my-customers', staffAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT tc.id, tc.company_name, tc.contact_name, tc.email, tc.phone,
        tc.status, tc.total_spend, tc.subscription_status,
        mt.name as tier_name, mt.discount_percent
      FROM trade_customers tc
      LEFT JOIN margin_tiers mt ON mt.id = tc.margin_tier_id
      WHERE tc.assigned_rep_id = $1
      ORDER BY tc.company_name ASC
    `, [req.staff.id]);
    res.json({ customers: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/staff/:id/terminate — deactivate staff and free assigned customers
app.patch('/api/admin/staff/:id/terminate', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    if (req.staff && !['admin', 'manager'].includes(req.staff.role)) {
      return res.status(403).json({ error: 'Admin or manager role required' });
    }
    const { id } = req.params;
    const staffId = req.staff ? req.staff.id : null;

    // Can't terminate yourself
    if (staffId === id) return res.status(400).json({ error: 'Cannot terminate your own account' });

    const target = await pool.query('SELECT id, first_name, last_name, email, role, is_active FROM staff_accounts WHERE id = $1', [id]);
    if (!target.rows.length) return res.status(404).json({ error: 'Staff member not found' });

    // Deactivate the staff account
    await pool.query('UPDATE staff_accounts SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

    // Invalidate all sessions
    await pool.query('DELETE FROM staff_sessions WHERE staff_id = $1', [id]);

    // Get assigned customers
    const customers = await pool.query(
      'SELECT id, company_name FROM trade_customers WHERE assigned_rep_id = $1',
      [id]
    );

    // Find recommended replacement rep via round-robin
    const recommendedRep = await getNextAvailableRep();

    // Unassign all customers (admin can then reassign them)
    if (customers.rows.length > 0) {
      await pool.query(
        'UPDATE trade_customers SET assigned_rep_id = NULL, assigned_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE assigned_rep_id = $1',
        [id]
      );

      // Log history for each customer
      for (const c of customers.rows) {
        await pool.query(
          "INSERT INTO customer_rep_history (trade_customer_id, from_rep_id, to_rep_id, reason, changed_by) VALUES ($1, $2, NULL, 'Staff terminated', $3)",
          [c.id, id, staffId]
        );
      }
    }

    await logAudit(staffId, 'staff.terminate', 'staff_accounts', id, {
      terminated: target.rows[0].email,
      freed_customers: customers.rows.length
    }, req.ip);

    res.json({
      success: true,
      terminated: { id, name: target.rows[0].first_name + ' ' + target.rows[0].last_name },
      freed_customers: customers.rows.map(c => ({ id: c.id, company_name: c.company_name })),
      recommended_rep: recommendedRep ? { id: recommendedRep.id, name: recommendedRep.first_name + ' ' + recommendedRep.last_name } : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Trade Dashboard (Phase 5) ====================

app.get('/api/trade/dashboard', tradeAuth, async (req, res) => {
  try {
    const id = req.tradeCustomer.id;
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM orders WHERE trade_customer_id = $1) as total_orders,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE trade_customer_id = $1 AND status != 'cancelled') as total_spent,
        (SELECT COUNT(*)::int FROM trade_projects WHERE trade_customer_id = $1 AND status = 'active') as active_projects,
        (SELECT COUNT(*)::int FROM trade_favorites WHERE trade_customer_id = $1) as favorite_collections
    `, [id]);

    const recentOrders = await pool.query(`
      SELECT id, order_number, total, status, created_at FROM orders
      WHERE trade_customer_id = $1 ORDER BY created_at DESC LIMIT 5
    `, [id]);

    const membership = await pool.query(`
      SELECT tc.total_spend, tc.subscription_status, tc.subscription_expires_at,
        mt.name as tier_name, mt.discount_percent, mt.tier_level
      FROM trade_customers tc LEFT JOIN margin_tiers mt ON mt.id = tc.margin_tier_id
      WHERE tc.id = $1
    `, [id]);

    const mem = membership.rows[0] || {};
    // Find next tier
    const nextTier = await pool.query(
      'SELECT name, spend_threshold FROM margin_tiers WHERE tier_level > $1 ORDER BY tier_level ASC LIMIT 1',
      [mem.tier_level || 0]
    );
    const nt = nextTier.rows[0];

    res.json({
      tier_name: mem.tier_name || 'Silver',
      total_spend: parseFloat(mem.total_spend || 0),
      order_count: stats.rows[0].total_orders,
      subscription_status: mem.subscription_status,
      next_tier_name: nt ? nt.name : null,
      next_tier_threshold: nt ? parseFloat(nt.spend_threshold) : null,
      recent_orders: recentOrders.rows,
      active_projects: stats.rows[0].active_projects,
      favorite_collections: stats.rows[0].favorite_collections
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trade orders
app.get('/api/trade/orders', tradeAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.*, (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) as item_count
      FROM orders o WHERE o.trade_customer_id = $1 ORDER BY o.created_at DESC
    `, [req.tradeCustomer.id]);
    // Attach items to each order for expandable detail
    const orders = result.rows;
    for (const o of orders) {
      const items = await pool.query('SELECT oi.product_name, oi.collection, oi.num_boxes, oi.unit_price, oi.subtotal, oi.sqft_needed, s.internal_sku as sku_code FROM order_items oi LEFT JOIN skus s ON s.id = oi.sku_id WHERE oi.order_id = $1 ORDER BY oi.id', [o.id]);
      o.items = items.rows;
    }
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trade/orders/:id', tradeAuth, async (req, res) => {
  try {
    const order = await pool.query('SELECT * FROM orders WHERE id = $1 AND trade_customer_id = $2', [req.params.id, req.tradeCustomer.id]);
    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });
    const items = await pool.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [req.params.id]);
    res.json({ order: order.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trade projects CRUD
app.get('/api/trade/projects', tradeAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT tp.*, (SELECT COUNT(*)::int FROM orders o WHERE o.project_id = tp.id) as order_count FROM trade_projects tp WHERE tp.trade_customer_id = $1 ORDER BY tp.created_at DESC',
      [req.tradeCustomer.id]
    );
    res.json({ projects: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trade/projects', tradeAuth, async (req, res) => {
  try {
    const { name, client_name, address, notes, expected_date } = req.body;
    if (!name) return res.status(400).json({ error: 'Project name is required' });
    const result = await pool.query(
      'INSERT INTO trade_projects (trade_customer_id, name, client_name, address, notes, expected_date) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [req.tradeCustomer.id, name, client_name || null, address || null, notes || null, expected_date || null]
    );
    res.json({ project: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/trade/projects/:id', tradeAuth, async (req, res) => {
  try {
    const { name, client_name, address, notes, expected_date, status } = req.body;
    const result = await pool.query(`
      UPDATE trade_projects SET name = COALESCE($1, name), client_name = COALESCE($2, client_name),
        address = COALESCE($3, address), notes = COALESCE($4, notes), expected_date = COALESCE($5, expected_date),
        status = COALESCE($6, status), updated_at = CURRENT_TIMESTAMP
      WHERE id = $7 AND trade_customer_id = $8 RETURNING *
    `, [name, client_name, address, notes, expected_date, status, req.params.id, req.tradeCustomer.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Project not found' });
    res.json({ project: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trade/projects/:id', tradeAuth, async (req, res) => {
  try {
    const project = await pool.query('SELECT * FROM trade_projects WHERE id = $1 AND trade_customer_id = $2', [req.params.id, req.tradeCustomer.id]);
    if (!project.rows.length) return res.status(404).json({ error: 'Project not found' });
    const orders = await pool.query('SELECT id, order_number, total, status, created_at FROM orders WHERE project_id = $1 ORDER BY created_at DESC', [req.params.id]);
    res.json({ project: project.rows[0], orders: orders.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete (archive) project
app.delete('/api/trade/projects/:id', tradeAuth, async (req, res) => {
  try {
    // Unlink any orders from this project first
    await pool.query('UPDATE orders SET project_id = NULL WHERE project_id = $1 AND trade_customer_id = $2', [req.params.id, req.tradeCustomer.id]);
    const result = await pool.query(
      'DELETE FROM trade_projects WHERE id = $1 AND trade_customer_id = $2 RETURNING id',
      [req.params.id, req.tradeCustomer.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Project not found' });
    res.json({ deleted: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assign order to project
app.put('/api/trade/orders/:id/project', tradeAuth, async (req, res) => {
  try {
    const { project_id } = req.body;
    const result = await pool.query(
      'UPDATE orders SET project_id = $1 WHERE id = $2 AND trade_customer_id = $3 RETURNING *',
      [project_id || null, req.params.id, req.tradeCustomer.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json({ order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trade favorites CRUD
app.get('/api/trade/favorites', tradeAuth, async (req, res) => {
  try {
    const collections = await pool.query(
      'SELECT tf.*, (SELECT COUNT(*)::int FROM trade_favorite_items tfi WHERE tfi.favorite_id = tf.id) as item_count FROM trade_favorites tf WHERE tf.trade_customer_id = $1 ORDER BY tf.created_at DESC',
      [req.tradeCustomer.id]
    );
    res.json({ favorites: collections.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trade/favorites', tradeAuth, async (req, res) => {
  try {
    const { collection_name } = req.body;
    if (!collection_name) return res.status(400).json({ error: 'Collection name is required' });
    const result = await pool.query(
      'INSERT INTO trade_favorites (trade_customer_id, collection_name) VALUES ($1, $2) RETURNING *',
      [req.tradeCustomer.id, collection_name]
    );
    res.json({ favorite: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/trade/favorites/:id', tradeAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM trade_favorites WHERE id = $1 AND trade_customer_id = $2 RETURNING id',
      [req.params.id, req.tradeCustomer.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Collection not found' });
    res.json({ deleted: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trade/favorites/:id/items', tradeAuth, async (req, res) => {
  try {
    const items = await pool.query(`
      SELECT tfi.*, p.name as product_name, p.collection,
        (SELECT ma.url FROM media_assets ma WHERE ma.product_id = tfi.product_id AND ma.asset_type != 'spec_pdf'
         ORDER BY CASE ma.asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 WHEN 'lifestyle' THEN 2 ELSE 3 END,
           CASE WHEN ma.sku_id IS NOT NULL THEN 0 ELSE 1 END, ma.sort_order LIMIT 1) as primary_image,
        (SELECT pr.retail_price FROM pricing pr WHERE pr.sku_id = tfi.sku_id) as price
      FROM trade_favorite_items tfi
      LEFT JOIN products p ON p.id = tfi.product_id
      WHERE tfi.favorite_id = $1
      ORDER BY tfi.added_at DESC
    `, [req.params.id]);
    res.json({ items: items.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trade/favorites/:id/items', tradeAuth, async (req, res) => {
  try {
    const { product_id, sku_id, notes } = req.body;
    // Verify ownership
    const fav = await pool.query('SELECT id FROM trade_favorites WHERE id = $1 AND trade_customer_id = $2', [req.params.id, req.tradeCustomer.id]);
    if (!fav.rows.length) return res.status(404).json({ error: 'Collection not found' });

    const result = await pool.query(
      'INSERT INTO trade_favorite_items (favorite_id, product_id, sku_id, notes) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.params.id, product_id || null, sku_id || null, notes || null]
    );
    res.json({ item: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/trade/favorites/:favId/items/:itemId', tradeAuth, async (req, res) => {
  try {
    const fav = await pool.query('SELECT id FROM trade_favorites WHERE id = $1 AND trade_customer_id = $2', [req.params.favId, req.tradeCustomer.id]);
    if (!fav.rows.length) return res.status(404).json({ error: 'Collection not found' });
    const result = await pool.query('DELETE FROM trade_favorite_items WHERE id = $1 AND favorite_id = $2 RETURNING id', [req.params.itemId, req.params.favId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Item not found' });
    res.json({ deleted: req.params.itemId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trade account management
app.get('/api/trade/account', tradeAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT tc.id, tc.email, tc.company_name, tc.contact_name, tc.phone, tc.business_type,
        tc.status, tc.total_spend, tc.subscription_status, tc.subscription_expires_at,
        mt.name as tier_name, mt.discount_percent
      FROM trade_customers tc
      LEFT JOIN margin_tiers mt ON mt.id = tc.margin_tier_id
      WHERE tc.id = $1
    `, [req.tradeCustomer.id]);
    res.json({ account: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/trade/account', tradeAuth, async (req, res) => {
  try {
    const { company_name, contact_name, phone } = req.body;
    const result = await pool.query(`
      UPDATE trade_customers SET
        company_name = COALESCE($1, company_name),
        contact_name = COALESCE($2, contact_name),
        phone = COALESCE($3, phone),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING id, email, company_name, contact_name, phone
    `, [company_name, contact_name, phone, req.tradeCustomer.id]);
    res.json({ account: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trade/change-password', tradeAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Both current and new password are required' });

    const cust = await pool.query('SELECT password_hash, password_salt FROM trade_customers WHERE id = $1', [req.tradeCustomer.id]);
    if (!verifyPassword(current_password, cust.rows[0].password_hash, cust.rows[0].password_salt)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const { hash, salt } = hashPassword(new_password);
    await pool.query('UPDATE trade_customers SET password_hash = $1, password_salt = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3', [hash, salt, req.tradeCustomer.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Trade Checkout Enhancements (Phase 6) ====================

// Bulk order
app.post('/api/trade/bulk-order', tradeAuth, async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'Items are required' });

    const validated = [];
    const errors = [];

    for (const item of items) {
      const skuCode = item.sku || item.sku_code;
      const sku = await pool.query(`
        SELECT s.id, s.vendor_sku, s.internal_sku, p.id as product_id, p.name as product_name, p.collection,
          pr.retail_price, pk.sqft_per_box, s.sell_by
        FROM skus s
        JOIN products p ON p.id = s.product_id
        LEFT JOIN pricing pr ON pr.sku_id = s.id
        LEFT JOIN packaging pk ON pk.sku_id = s.id
        WHERE s.internal_sku = $1 OR s.vendor_sku = $1
      `, [skuCode]);

      if (!sku.rows.length) {
        errors.push({ sku: skuCode, error: 'SKU not found' });
        continue;
      }

      const s = sku.rows[0];
      const qty = parseInt(item.qty || item.quantity) || 1;
      let price = parseFloat(s.retail_price) || 0;

      // Apply trade discount
      if (req.tradeCustomer.discount_percent > 0) {
        price = price * (1 - req.tradeCustomer.discount_percent / 100);
      }

      validated.push({
        product_id: s.product_id,
        sku_id: s.id,
        sku_code: s.internal_sku || s.vendor_sku,
        product_name: s.product_name,
        collection: s.collection,
        vendor_sku: s.vendor_sku,
        num_boxes: qty,
        quantity: qty,
        unit_price: price,
        subtotal: price * qty,
        sell_by: s.sell_by,
        sqft_per_box: parseFloat(s.sqft_per_box) || 0
      });
    }

    res.json({ validated_items: validated, errors, total: validated.reduce((sum, i) => sum + i.subtotal, 0) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Confirm bulk order — creates an actual order from validated items
app.post('/api/trade/bulk-order/confirm', tradeAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { items, po_number, project_id } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'Items are required' });

    const total = items.reduce((sum, i) => sum + (parseFloat(i.subtotal) || 0), 0);
    const orderNumber = 'ORD-' + Date.now();

    await client.query('BEGIN');

    const orderResult = await client.query(`
      INSERT INTO orders (order_number, customer_email, customer_name, subtotal, total, status, trade_customer_id, po_number, project_id)
      VALUES ($1, $2, $3, $4, $4, 'pending', $5, $6, $7) RETURNING *
    `, [orderNumber, req.tradeCustomer.email, req.tradeCustomer.contact_name, total,
        req.tradeCustomer.id, po_number || null, project_id || null]);
    const order = orderResult.rows[0];

    for (const item of items) {
      await client.query(`
        INSERT INTO order_items (order_id, sku_id, product_name, collection, num_boxes, unit_price, subtotal)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [order.id, item.sku_id, item.product_name, item.collection || null,
          item.num_boxes, item.unit_price, item.subtotal]);
    }

    // Increment trade spend + check tier
    await client.query(
      'UPDATE trade_customers SET total_spend = total_spend + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [total, req.tradeCustomer.id]
    );
    const promotion = await checkTierPromotion(req.tradeCustomer.id, client);
    if (promotion) console.log(`[Trade] Bulk order promoted ${req.tradeCustomer.id} to ${promotion.name}`);

    await client.query('COMMIT');
    res.json({ order: { ...order, items } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Trade quotes
app.get('/api/trade/quotes', tradeAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT q.*, (SELECT COUNT(*)::int FROM quote_items qi WHERE qi.quote_id = q.id) as item_count
      FROM quotes q WHERE q.trade_customer_id = $1 ORDER BY q.created_at DESC
    `, [req.tradeCustomer.id]);
    res.json({ quotes: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trade/quotes/:id', tradeAuth, async (req, res) => {
  try {
    const quote = await pool.query('SELECT * FROM quotes WHERE id = $1 AND trade_customer_id = $2', [req.params.id, req.tradeCustomer.id]);
    if (!quote.rows.length) return res.status(404).json({ error: 'Quote not found' });
    const items = await pool.query('SELECT * FROM quote_items WHERE quote_id = $1 ORDER BY id', [req.params.id]);
    res.json({ quote: quote.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accept a quote (convert to order)
app.post('/api/trade/quotes/:id/accept', tradeAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const quote = await client.query('SELECT * FROM quotes WHERE id = $1 AND trade_customer_id = $2', [req.params.id, req.tradeCustomer.id]);
    if (!quote.rows.length) return res.status(404).json({ error: 'Quote not found' });
    const q = quote.rows[0];

    if (q.expires_at && new Date(q.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Quote has expired' });
    }
    if (q.status === 'converted') return res.status(400).json({ error: 'Quote already converted' });

    const qItems = await client.query('SELECT * FROM quote_items WHERE quote_id = $1', [q.id]);
    if (!qItems.rows.length) return res.status(400).json({ error: 'Quote has no items' });

    await client.query('BEGIN');

    const orderNumber = 'ORD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();
    const orderResult = await client.query(`
      INSERT INTO orders (order_number, customer_email, customer_name, phone,
        shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip,
        subtotal, shipping, total, status, trade_customer_id, delivery_method)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13, $14) RETURNING *
    `, [orderNumber, q.customer_email, q.customer_name, q.phone,
        q.shipping_address_line1, q.shipping_address_line2, q.shipping_city, q.shipping_state, q.shipping_zip,
        q.subtotal, q.shipping, q.total, req.tradeCustomer.id, q.delivery_method || 'shipping']);

    const order = orderResult.rows[0];
    for (const item of qItems.rows) {
      await client.query(`
        INSERT INTO order_items (order_id, product_id, sku_id, product_name, collection, description, sqft_needed, num_boxes, unit_price, subtotal, sell_by, is_sample)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [order.id, item.product_id, item.sku_id, item.product_name, item.collection, item.description,
          item.sqft_needed, item.num_boxes, item.unit_price, item.subtotal, item.sell_by, item.is_sample]);
    }

    await client.query("UPDATE quotes SET status = 'converted', converted_order_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [order.id, q.id]);
    await client.query('COMMIT');

    res.json({ order });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Quote PDF download - accepts token from header or query param (for browser popup)
app.get('/api/trade/quotes/:id/pdf', (req, res, next) => {
  if (!req.headers['x-trade-token'] && req.query.token) {
    req.headers['x-trade-token'] = req.query.token;
  }
  next();
}, tradeAuth, async (req, res) => {
  try {
    const quote = await pool.query('SELECT * FROM quotes WHERE id = $1 AND trade_customer_id = $2', [req.params.id, req.tradeCustomer.id]);
    if (!quote.rows.length) return res.status(404).json({ error: 'Quote not found' });
    const q = quote.rows[0];
    const items = await pool.query('SELECT * FROM quote_items WHERE quote_id = $1 ORDER BY id', [req.params.id]);
    const customer = await pool.query('SELECT * FROM trade_customers WHERE id = $1', [req.tradeCustomer.id]);
    const c = customer.rows[0] || {};

    const isExpired = q.expires_at && new Date(q.expires_at) < new Date();
    const expiryStr = q.expires_at ? new Date(q.expires_at).toLocaleDateString() : 'N/A';

    const html = `<!DOCTYPE html><html><head><style>
      ${getDocumentBaseCSS()}
      .expired-badge { display: inline-block; background: #dc2626; color: white; padding: 2px 8px; font-size: 0.6875rem; font-weight: 600; text-transform: uppercase; }
      .valid-badge { display: inline-block; background: #16a34a; color: white; padding: 2px 8px; font-size: 0.6875rem; font-weight: 600; text-transform: uppercase; }
    </style></head><body>
      ${getDocumentHeader('Quote')}
      <div class="doc-meta" style="margin-top: -1.5rem; margin-bottom: 1.5rem;">
        <strong>${q.quote_number || 'Q-' + q.id.substring(0, 8).toUpperCase()}</strong><br/>
        Date: ${new Date(q.created_at).toLocaleDateString()}<br/>
        Valid Until: ${expiryStr} ${isExpired ? '<span class="expired-badge">Expired</span>' : '<span class="valid-badge">Valid</span>'}
      </div>
      <div class="info-block">
        <h3>Prepared For</h3>
        <strong>${c.company_name || q.customer_name || ''}</strong><br/>
        ${c.contact_name || q.customer_name || ''}<br/>
        ${q.customer_email || c.email || ''}
        ${q.phone ? '<br/>' + q.phone : ''}
        ${q.shipping_address_line1 ? '<br/>' + q.shipping_address_line1 : ''}
        ${q.shipping_address_line2 ? '<br/>' + q.shipping_address_line2 : ''}
        ${q.shipping_city ? '<br/>' + q.shipping_city + ', ' + (q.shipping_state || '') + ' ' + (q.shipping_zip || '') : ''}
      </div>
      <table>
        <thead><tr><th>Item</th><th>Description</th><th style="text-align:right">Qty</th><th style="text-align:right">Unit Price</th><th style="text-align:right">Subtotal</th></tr></thead>
        <tbody>
          ${items.rows.map(i => `<tr>
            <td>${i.product_name || ''}</td>
            <td>${i.collection || i.description || ''}</td>
            <td style="text-align:right">${i.num_boxes || i.quantity || 1}</td>
            <td style="text-align:right">$${parseFloat(i.unit_price || 0).toFixed(2)}</td>
            <td style="text-align:right">$${parseFloat(i.subtotal || 0).toFixed(2)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div class="totals">
        <div class="line"><span>Subtotal:</span><span>$${parseFloat(q.subtotal || 0).toFixed(2)}</span></div>
        ${parseFloat(q.shipping || 0) > 0 ? `<div class="line"><span>Shipping:</span><span>$${parseFloat(q.shipping).toFixed(2)}</span></div>` : ''}
        ${parseFloat(q.tax || 0) > 0 ? `<div class="line"><span>Tax:</span><span>$${parseFloat(q.tax).toFixed(2)}</span></div>` : ''}
        <div class="line total-line"><span>Total:</span><span>$${parseFloat(q.total || 0).toFixed(2)}</span></div>
      </div>
      <div class="footer">
        <p>This quote is valid for 14 days from the date of issue. Prices are subject to change after expiry.</p>
        <p>Roma Flooring Designs | License #830966 | www.romaflooringdesigns.com</p>
      </div>
    </body></html>`;

    await generatePDF(html, `quote-${q.quote_number || q.id.substring(0, 8)}.pdf`, req, res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Packing Slip & Order Filters (Phase 7) ====================

// Packing slip - accepts token from header or query param (for browser popup)
app.get('/api/staff/orders/:id/packing-slip', async (req, res, next) => {
  if (!req.headers['x-staff-token'] && req.query.token) {
    req.headers['x-staff-token'] = req.query.token;
  }
  next();
}, staffAuth, async (req, res) => {
  try {
    const order = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });
    const items = await pool.query(`
      SELECT oi.*, p.sqft_per_box
      FROM order_items oi
      LEFT JOIN packaging p ON p.sku_id = oi.sku_id
      WHERE oi.order_id = $1 ORDER BY oi.id
    `, [req.params.id]);
    const o = order.rows[0];

    const isPickup = o.delivery_method === 'pickup';
    const shipToBlock = isPickup
      ? `<div class="info-block">
          <h3>Store Pickup</h3>
          <strong>Roma Flooring Designs</strong><br/>
          1440 S. State College Blvd., Suite 6M<br/>
          Anaheim, CA 92806
        </div>`
      : `<div class="info-block">
          <h3>Ship To</h3>
          <strong>${o.customer_name}</strong><br/>
          ${o.shipping_address_line1 || ''}${o.shipping_address_line2 ? '<br/>' + o.shipping_address_line2 : ''}<br/>
          ${o.shipping_city || ''}, ${o.shipping_state || ''} ${o.shipping_zip || ''}
        </div>`;

    const html = `<!DOCTYPE html><html><head><style>
      ${getDocumentBaseCSS()}
    </style></head><body>
      ${getDocumentHeader('Packing Slip')}
      <div class="doc-meta" style="margin-top: -1.5rem; margin-bottom: 1.5rem;">
        <strong>${o.order_number}</strong><br/>
        Date: ${new Date(o.created_at).toLocaleDateString()}
      </div>
      ${shipToBlock}
      <table>
        <thead><tr><th>Product</th><th>Description</th><th style="text-align:right">Qty</th><th style="text-align:right">SqFt/Box</th><th style="text-align:right">Total SqFt</th></tr></thead>
        <tbody>
          ${items.rows.map(i => {
            const isUnit = i.sell_by === 'unit';
            const sqftPerBox = i.sqft_per_box ? parseFloat(i.sqft_per_box) : null;
            const totalSqft = i.sqft_needed ? parseFloat(i.sqft_needed) : (sqftPerBox ? sqftPerBox * i.num_boxes : null);
            return `<tr>
              <td>${i.product_name || ''}</td>
              <td>${i.collection || i.description || ''}</td>
              <td style="text-align:right">${i.num_boxes}${isUnit ? '' : ' box' + (i.num_boxes > 1 ? 'es' : '')}</td>
              <td style="text-align:right">${isUnit ? '—' : (sqftPerBox ? sqftPerBox.toFixed(2) : '—')}</td>
              <td style="text-align:right">${isUnit ? '—' : (totalSqft ? totalSqft.toFixed(1) : '—')}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      ${getDocumentFooter()}
    </body></html>`;

    await generatePDF(html, `packing-slip-${o.order_number}.pdf`, req, res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Invoice PDF - accepts token from header or query param
app.get('/api/staff/orders/:id/invoice', async (req, res, next) => {
  if (!req.headers['x-staff-token'] && req.query.token) {
    req.headers['x-staff-token'] = req.query.token;
  }
  next();
}, staffAuth, async (req, res) => {
  try {
    const order = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });
    const items = await pool.query(`
      SELECT oi.*, p.sqft_per_box
      FROM order_items oi
      LEFT JOIN packaging p ON p.sku_id = oi.sku_id
      WHERE oi.order_id = $1 ORDER BY oi.id
    `, [req.params.id]);
    const o = order.rows[0];

    const isPickup = o.delivery_method === 'pickup';
    const billToBlock = `<div class="info-block">
      <h3>Bill To</h3>
      <strong>${o.customer_name}</strong><br/>
      ${o.customer_email}${o.phone ? '<br/>' + o.phone : ''}
    </div>`;
    const shipToBlock = isPickup
      ? `<div class="info-block">
          <h3>Store Pickup</h3>
          <strong>Roma Flooring Designs</strong><br/>
          1440 S. State College Blvd., Suite 6M<br/>
          Anaheim, CA 92806
        </div>`
      : `<div class="info-block">
          <h3>Ship To</h3>
          <strong>${o.customer_name}</strong><br/>
          ${o.shipping_address_line1 || ''}${o.shipping_address_line2 ? '<br/>' + o.shipping_address_line2 : ''}<br/>
          ${o.shipping_city || ''}, ${o.shipping_state || ''} ${o.shipping_zip || ''}
        </div>`;

    const html = `<!DOCTYPE html><html><head><style>
      ${getDocumentBaseCSS()}
    </style></head><body>
      ${getDocumentHeader('Invoice')}
      <div class="doc-meta" style="margin-top: -1.5rem; margin-bottom: 1.5rem;">
        <strong>${o.order_number}</strong><br/>
        Date: ${new Date(o.created_at).toLocaleDateString()}
      </div>
      <div class="info-columns">
        ${billToBlock}
        ${shipToBlock}
      </div>
      <table>
        <thead><tr>
          <th>Product</th><th>Description</th>
          <th style="text-align:right">SqFt</th><th style="text-align:right">Qty</th>
          <th style="text-align:right">Unit Price</th><th style="text-align:right">Subtotal</th>
        </tr></thead>
        <tbody>
          ${items.rows.map(i => {
            const isUnit = i.sell_by === 'unit';
            return `<tr>
            <td>${i.product_name || ''}</td>
            <td>${i.collection || i.description || ''}</td>
            <td style="text-align:right">${isUnit ? '—' : (i.sqft_needed ? parseFloat(i.sqft_needed).toFixed(1) : '—')}</td>
            <td style="text-align:right">${i.num_boxes}${isUnit ? '' : ' box' + (i.num_boxes > 1 ? 'es' : '')}</td>
            <td style="text-align:right">${i.unit_price ? '$' + parseFloat(i.unit_price).toFixed(2) + (isUnit ? '/ea' : '/sf') : '—'}</td>
            <td style="text-align:right">$${parseFloat(i.subtotal || 0).toFixed(2)}</td>
          </tr>`;}).join('')}
        </tbody>
      </table>
      <div class="totals">
        <div class="line"><span>Subtotal:</span><span>$${parseFloat(o.subtotal || 0).toFixed(2)}</span></div>
        ${parseFloat(o.shipping || 0) > 0 ? `<div class="line"><span>Shipping${o.shipping_method ? ' (' + (o.shipping_method === 'ltl_freight' ? 'LTL Freight' : 'Parcel') + ')' : ''}:</span><span>$${parseFloat(o.shipping).toFixed(2)}</span></div>` : ''}
        ${isPickup ? '<div class="line"><span>Shipping (Store Pickup):</span><span style="color:#16a34a">FREE</span></div>' : ''}
        ${parseFloat(o.sample_shipping || 0) > 0 ? `<div class="line"><span>Sample Shipping:</span><span>$${parseFloat(o.sample_shipping).toFixed(2)}</span></div>` : ''}
        ${parseFloat(o.discount_amount || 0) > 0 ? `<div class="line"><span>Discount${o.promo_code ? ' (' + o.promo_code + ')' : ''}:</span><span style="color:#16a34a">-$${parseFloat(o.discount_amount).toFixed(2)}</span></div>` : ''}
        <div class="line total-line"><span>Total:</span><span>$${parseFloat(o.total || 0).toFixed(2)}</span></div>
      </div>
      ${o.payment_method || o.stripe_payment_intent_id ? `
        <div class="notes-section">
          <h4>Payment Information</h4>
          ${o.payment_method ? '<div>Method: ' + o.payment_method + '</div>' : ''}
          ${o.stripe_payment_intent_id ? '<div style="font-size:0.75rem;color:#78716c;">Stripe ID: ' + o.stripe_payment_intent_id + '</div>' : ''}
        </div>
      ` : ''}
      ${getDocumentFooter()}
    </body></html>`;

    await generatePDF(html, `invoice-${o.order_number}.pdf`, req, res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Audit log (admin/manager)
app.get('/api/admin/audit-log', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { limit, offset, action, entity_type } = req.query;
    let query = `
      SELECT al.*, sa.email as staff_email, sa.first_name || ' ' || sa.last_name as staff_name
      FROM audit_log al
      LEFT JOIN staff_accounts sa ON sa.id = al.staff_id
      WHERE 1=1
    `;
    const params = [];
    let idx = 1;
    if (action) { query += ` AND al.action = $${idx}`; params.push(action); idx++; }
    if (entity_type) { query += ` AND al.entity_type = $${idx}`; params.push(entity_type); idx++; }
    query += ` ORDER BY al.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
    params.push(parseInt(limit) || 50, parseInt(offset) || 0);

    const result = await pool.query(query, params);
    res.json({ entries: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    // Original stat counts
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

    // Sales metrics scoped to this rep
    const metricsRes = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)
          AND status NOT IN ('cancelled','refunded') THEN total ELSE 0 END), 0) as sales_this_month,
        COALESCE(SUM(CASE WHEN date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
          AND status NOT IN ('cancelled','refunded') THEN total ELSE 0 END), 0) as sales_last_month,
        COALESCE(AVG(CASE WHEN status NOT IN ('cancelled','refunded') THEN total END), 0) as avg_order_value
      FROM orders WHERE sales_rep_id = $1
    `, [req.rep.id]);

    const metrics = metricsRes.rows[0];
    const salesThisMonth = parseFloat(metrics.sales_this_month);
    const salesLastMonth = parseFloat(metrics.sales_last_month);
    const momChange = salesLastMonth > 0 ? ((salesThisMonth - salesLastMonth) / salesLastMonth * 100) : (salesThisMonth > 0 ? 100 : 0);

    // Quote conversion
    const quoteMetrics = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status NOT IN ('draft'))::int as quotes_total_sent,
        COUNT(*) FILTER (WHERE converted_order_id IS NOT NULL)::int as quotes_converted
      FROM quotes WHERE sales_rep_id = $1
    `, [req.rep.id]);
    const qm = quoteMetrics.rows[0];
    const conversionRate = qm.quotes_total_sent > 0 ? (qm.quotes_converted / qm.quotes_total_sent * 100) : 0;

    // Pipeline value
    const pipelineRes = await pool.query(`
      SELECT COALESCE(SUM(total), 0) as pipeline_value
      FROM quotes WHERE sales_rep_id = $1 AND status IN ('draft', 'sent')
    `, [req.rep.id]);

    // Top 5 products by revenue
    const topProducts = await pool.query(`
      SELECT oi.product_name, SUM(oi.subtotal::numeric) as revenue, SUM(oi.num_boxes)::int as qty_sold
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.sales_rep_id = $1 AND o.status NOT IN ('cancelled','refunded') AND oi.product_name IS NOT NULL
      GROUP BY oi.product_name
      ORDER BY revenue DESC
      LIMIT 5
    `, [req.rep.id]);

    const recentOrders = await pool.query(`
      SELECT o.id, o.order_number, o.customer_name, o.total, o.status, o.created_at,
        o.delivery_method, o.shipping_method,
        sr.first_name || ' ' || sr.last_name as rep_name,
        (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) as item_count
      FROM orders o
      LEFT JOIN sales_reps sr ON sr.id = o.sales_rep_id
      ORDER BY o.created_at DESC LIMIT 10
    `);

    res.json({
      stats: stats.rows[0],
      metrics: {
        sales_this_month: salesThisMonth,
        sales_last_month: salesLastMonth,
        month_over_month_change: parseFloat(momChange.toFixed(1)),
        avg_order_value: parseFloat(parseFloat(metrics.avg_order_value).toFixed(2)),
        conversion_rate: parseFloat(conversionRate.toFixed(1)),
        quotes_converted: qm.quotes_converted,
        quotes_total_sent: qm.quotes_total_sent,
        pipeline_value: parseFloat(parseFloat(pipelineRes.rows[0].pipeline_value).toFixed(2)),
        top_products: topProducts.rows.map(r => ({
          product_name: r.product_name,
          revenue: parseFloat(parseFloat(r.revenue).toFixed(2)),
          qty_sold: r.qty_sold
        }))
      },
      recent_orders: recentOrders.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Rep Commission Endpoints ====================

app.get('/api/rep/commissions', repAuth, async (req, res) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT rc.*, o.order_number, o.customer_name, o.status as order_status, o.created_at as order_date
      FROM rep_commissions rc
      JOIN orders o ON o.id = rc.order_id
      WHERE rc.rep_id = $1
    `;
    const params = [req.rep.id];
    let idx = 2;

    if (status) {
      query += ` AND rc.status = $${idx}`;
      params.push(status);
      idx++;
    }

    query += ' ORDER BY rc.created_at DESC';
    const commissions = await pool.query(query, params);

    const summaryRes = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'earned' THEN commission_amount ELSE 0 END), 0) as total_earned,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN commission_amount ELSE 0 END), 0) as total_pending,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN commission_amount ELSE 0 END), 0) as total_paid,
        COALESCE(SUM(CASE WHEN status = 'forfeited' THEN commission_amount ELSE 0 END), 0) as total_forfeited
      FROM rep_commissions WHERE rep_id = $1
    `, [req.rep.id]);

    const configRes = await pool.query('SELECT rate FROM commission_config LIMIT 1');
    const commissionRate = configRes.rows.length ? parseFloat(configRes.rows[0].rate) : 0.10;

    res.json({
      summary: summaryRes.rows[0],
      commission_rate: commissionRate,
      commissions: commissions.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rep/commissions/summary', repAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'earned' THEN commission_amount ELSE 0 END), 0) as total_earned,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN commission_amount ELSE 0 END), 0) as total_pending,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN commission_amount ELSE 0 END), 0) as total_paid
      FROM rep_commissions WHERE rep_id = $1
    `, [req.rep.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Showroom Visits (Rep) ====================

app.post('/api/rep/visits', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { customer_name, customer_email, customer_phone, message, items } = req.body;
    if (!customer_name) return res.status(400).json({ error: 'Customer name is required' });
    if (!items || !items.length) return res.status(400).json({ error: 'At least one product is required' });

    await client.query('BEGIN');
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    const visitRes = await client.query(`
      INSERT INTO showroom_visits (token, rep_id, customer_name, customer_email, customer_phone, message, status, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7) RETURNING *
    `, [token, req.rep.id, customer_name, customer_email || null, customer_phone || null, message || null, expiresAt]);
    const visit = visitRes.rows[0];

    const resolvedItems = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let productName = item.product_name || 'Unknown';
      let collection = null;
      let variantName = null;
      let retailPrice = null;
      let priceBasis = null;
      let primaryImage = null;
      let productId = item.product_id || null;
      let skuId = item.sku_id || null;

      if (item.product_id) {
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

      if (item.sku_id) {
        const sRes = await client.query(`
          SELECT s.variant_name, s.product_id,
            pr.retail_price, pr.price_basis,
            p.name as product_name, p.collection,
            (SELECT url FROM media_assets WHERE product_id = p.id AND asset_type = 'primary' ORDER BY sort_order LIMIT 1) as primary_image
          FROM skus s
          JOIN products p ON p.id = s.product_id
          LEFT JOIN pricing pr ON pr.sku_id = s.id
          WHERE s.id = $1
        `, [item.sku_id]);
        if (sRes.rows.length) {
          const s = sRes.rows[0];
          productId = s.product_id;
          productName = s.product_name;
          collection = s.collection;
          variantName = s.variant_name;
          retailPrice = s.retail_price ? parseFloat(s.retail_price) : null;
          priceBasis = s.price_basis;
          primaryImage = s.primary_image;
        }
      } else if (item.product_id) {
        // No SKU — try to get price from first active SKU
        const prRes = await client.query(`
          SELECT pr.retail_price, pr.price_basis, s.variant_name
          FROM skus s LEFT JOIN pricing pr ON pr.sku_id = s.id
          WHERE s.product_id = $1 AND s.status = 'active' ORDER BY s.created_at LIMIT 1
        `, [item.product_id]);
        if (prRes.rows.length) {
          retailPrice = prRes.rows[0].retail_price ? parseFloat(prRes.rows[0].retail_price) : null;
          priceBasis = prRes.rows[0].price_basis;
          if (!variantName) variantName = prRes.rows[0].variant_name;
        }
      }

      const itemRes = await client.query(`
        INSERT INTO showroom_visit_items (visit_id, product_id, sku_id, product_name, collection, variant_name, retail_price, price_basis, primary_image, rep_note, sort_order)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *
      `, [visit.id, productId, skuId, productName, collection, variantName, retailPrice, priceBasis, primaryImage, item.rep_note || null, i]);
      resolvedItems.push(itemRes.rows[0]);
    }

    await client.query('COMMIT');
    res.json({ visit, items: resolvedItems });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/rep/visits', repAuth, async (req, res) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT sv.*,
        (SELECT COUNT(*)::int FROM showroom_visit_items WHERE visit_id = sv.id) as item_count
      FROM showroom_visits sv
      WHERE sv.rep_id = $1
    `;
    const params = [req.rep.id];
    let idx = 2;

    if (status) {
      query += ` AND sv.status = $${idx}`;
      params.push(status);
      idx++;
    }

    query += ' ORDER BY sv.created_at DESC';
    const result = await pool.query(query, params);
    res.json({ visits: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rep/visits/:id', repAuth, async (req, res) => {
  try {
    const visitRes = await pool.query('SELECT * FROM showroom_visits WHERE id = $1 AND rep_id = $2', [req.params.id, req.rep.id]);
    if (!visitRes.rows.length) return res.status(404).json({ error: 'Visit not found' });

    const itemsRes = await pool.query('SELECT * FROM showroom_visit_items WHERE visit_id = $1 ORDER BY sort_order', [req.params.id]);
    res.json({ visit: visitRes.rows[0], items: itemsRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rep/visits/:id', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const visitRes = await client.query('SELECT * FROM showroom_visits WHERE id = $1 AND rep_id = $2', [req.params.id, req.rep.id]);
    if (!visitRes.rows.length) return res.status(404).json({ error: 'Visit not found' });
    if (visitRes.rows[0].status !== 'draft') return res.status(400).json({ error: 'Can only edit draft visits' });

    await client.query('BEGIN');
    const { customer_name, customer_email, customer_phone, message, items } = req.body;

    // Update visit info
    const fields = [];
    const vals = [];
    let idx = 1;
    if (customer_name !== undefined) { fields.push(`customer_name = $${idx}`); vals.push(customer_name); idx++; }
    if (customer_email !== undefined) { fields.push(`customer_email = $${idx}`); vals.push(customer_email || null); idx++; }
    if (customer_phone !== undefined) { fields.push(`customer_phone = $${idx}`); vals.push(customer_phone || null); idx++; }
    if (message !== undefined) { fields.push(`message = $${idx}`); vals.push(message || null); idx++; }

    if (fields.length) {
      vals.push(req.params.id);
      await client.query(`UPDATE showroom_visits SET ${fields.join(', ')} WHERE id = $${idx}`, vals);
    }

    // Replace items if provided
    if (items) {
      await client.query('DELETE FROM showroom_visit_items WHERE visit_id = $1', [req.params.id]);
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        let productName = item.product_name || 'Unknown';
        let collection = null;
        let variantName = null;
        let retailPrice = null;
        let priceBasis = null;
        let primaryImage = null;
        let productId = item.product_id || null;
        let skuId = item.sku_id || null;

        if (item.sku_id) {
          const sRes = await client.query(`
            SELECT s.variant_name, s.product_id,
              pr.retail_price, pr.price_basis,
              p.name as product_name, p.collection,
              (SELECT url FROM media_assets WHERE product_id = p.id AND asset_type = 'primary' ORDER BY sort_order LIMIT 1) as primary_image
            FROM skus s
            JOIN products p ON p.id = s.product_id
            LEFT JOIN pricing pr ON pr.sku_id = s.id
            WHERE s.id = $1
          `, [item.sku_id]);
          if (sRes.rows.length) {
            const s = sRes.rows[0];
            productId = s.product_id;
            productName = s.product_name;
            collection = s.collection;
            variantName = s.variant_name;
            retailPrice = s.retail_price ? parseFloat(s.retail_price) : null;
            priceBasis = s.price_basis;
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
          const prRes = await client.query(`
            SELECT pr.retail_price, pr.price_basis, s.variant_name
            FROM skus s LEFT JOIN pricing pr ON pr.sku_id = s.id
            WHERE s.product_id = $1 AND s.status = 'active' ORDER BY s.created_at LIMIT 1
          `, [item.product_id]);
          if (prRes.rows.length) {
            retailPrice = prRes.rows[0].retail_price ? parseFloat(prRes.rows[0].retail_price) : null;
            priceBasis = prRes.rows[0].price_basis;
            if (!variantName) variantName = prRes.rows[0].variant_name;
          }
        }

        await client.query(`
          INSERT INTO showroom_visit_items (visit_id, product_id, sku_id, product_name, collection, variant_name, retail_price, price_basis, primary_image, rep_note, sort_order)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [req.params.id, productId, skuId, productName, collection, variantName, retailPrice, priceBasis, primaryImage, item.rep_note || null, i]);
      }
    }

    await client.query('COMMIT');
    const updatedVisit = await pool.query('SELECT * FROM showroom_visits WHERE id = $1', [req.params.id]);
    const updatedItems = await pool.query('SELECT * FROM showroom_visit_items WHERE visit_id = $1 ORDER BY sort_order', [req.params.id]);
    res.json({ visit: updatedVisit.rows[0], items: updatedItems.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/rep/visits/:id', repAuth, async (req, res) => {
  try {
    const visitRes = await pool.query('SELECT * FROM showroom_visits WHERE id = $1 AND rep_id = $2', [req.params.id, req.rep.id]);
    if (!visitRes.rows.length) return res.status(404).json({ error: 'Visit not found' });
    if (visitRes.rows[0].status !== 'draft') return res.status(400).json({ error: 'Can only delete draft visits' });

    await pool.query('DELETE FROM showroom_visits WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rep/visits/:id/send', repAuth, async (req, res) => {
  try {
    const visitRes = await pool.query('SELECT * FROM showroom_visits WHERE id = $1 AND rep_id = $2', [req.params.id, req.rep.id]);
    if (!visitRes.rows.length) return res.status(404).json({ error: 'Visit not found' });
    const visit = visitRes.rows[0];
    if (!visit.customer_email) return res.status(400).json({ error: 'Customer email is required to send' });

    const itemsRes = await pool.query('SELECT * FROM showroom_visit_items WHERE visit_id = $1 ORDER BY sort_order', [visit.id]);

    const repRes = await pool.query('SELECT first_name, last_name, email FROM sales_reps WHERE id = $1', [req.rep.id]);
    const rep = repRes.rows[0];

    const storefrontUrl = process.env.STOREFRONT_URL || `http://localhost:3000`;
    const recapUrl = `${storefrontUrl}/visit/${visit.token}`;

    await sendVisitRecap({
      customer_name: visit.customer_name,
      customer_email: visit.customer_email,
      rep_name: `${rep.first_name} ${rep.last_name}`,
      rep_email: rep.email,
      message: visit.message,
      items: itemsRes.rows,
      recap_url: recapUrl
    });

    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    await pool.query(`UPDATE showroom_visits SET status = 'sent', sent_at = NOW(), expires_at = $2 WHERE id = $1`, [visit.id, expiresAt]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Showroom Visits (Public) ====================

app.get('/api/visit-recap/:token', async (req, res) => {
  try {
    const visitRes = await pool.query(`
      SELECT sv.*, sr.first_name || ' ' || sr.last_name as rep_name
      FROM showroom_visits sv
      JOIN sales_reps sr ON sr.id = sv.rep_id
      WHERE sv.token = $1
    `, [req.params.token]);
    if (!visitRes.rows.length) return res.status(404).json({ error: 'Visit recap not found' });

    const visit = visitRes.rows[0];
    if (visit.expires_at && new Date(visit.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This visit recap has expired' });
    }

    // Update status to opened on first view
    if (visit.status === 'sent') {
      await pool.query(`UPDATE showroom_visits SET status = 'opened', opened_at = NOW() WHERE id = $1`, [visit.id]);
    }

    const itemsRes = await pool.query('SELECT * FROM showroom_visit_items WHERE visit_id = $1 ORDER BY sort_order', [visit.id]);

    res.json({
      visit: {
        customer_name: visit.customer_name,
        message: visit.message,
        rep_name: visit.rep_name,
        created_at: visit.created_at
      },
      items: itemsRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/visit-recap/:token/carted', async (req, res) => {
  try {
    const visitRes = await pool.query('SELECT * FROM showroom_visits WHERE token = $1', [req.params.token]);
    if (!visitRes.rows.length) return res.status(404).json({ error: 'Visit not found' });

    const visit = visitRes.rows[0];
    if (visit.status !== 'carted') {
      await pool.query(`UPDATE showroom_visits SET status = 'carted', items_carted_at = NOW() WHERE id = $1`, [visit.id]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Rep Sample Request Endpoints ====================

app.post('/api/rep/sample-requests', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { customer_name, customer_email, customer_phone, shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip, delivery_method, notes, items } = req.body;
    if (!customer_name) return res.status(400).json({ error: 'Customer name is required' });
    if (!items || !items.length) return res.status(400).json({ error: 'At least one item is required' });
    if (items.length > 5) return res.status(400).json({ error: 'Maximum 5 items per sample request' });

    // Check for duplicate product_ids
    const productIds = items.map(i => i.product_id).filter(Boolean);
    if (new Set(productIds).size !== productIds.length) {
      return res.status(400).json({ error: 'Duplicate products are not allowed' });
    }

    await client.query('BEGIN');

    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
    const request_number = `SR-${ts}-${rand}`;
    const dm = delivery_method === 'pickup' ? 'pickup' : 'shipping';

    const srRes = await client.query(`
      INSERT INTO sample_requests (request_number, rep_id, customer_name, customer_email, customer_phone,
        shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip, delivery_method, notes, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'requested') RETURNING *
    `, [request_number, req.rep.id, customer_name, customer_email || null, customer_phone || null,
        shipping_address_line1 || null, shipping_address_line2 || null, shipping_city || null, shipping_state || null, shipping_zip || null, dm, notes || null]);
    const sample_request = srRes.rows[0];

    const resolvedItems = [];
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
            p.name as product_name, p.collection,
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
      `, [sample_request.id, productId, skuId, productName, collection, variantName, primaryImage, i]);
      resolvedItems.push(itemRes.rows[0]);
    }

    await client.query('COMMIT');

    // Fire-and-forget: email + notification
    if (customer_email) {
      setImmediate(() => sendSampleRequestConfirmation({
        customer_name, customer_email, request_number,
        delivery_method: dm,
        items: resolvedItems,
        shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip
      }));
    }
    setImmediate(() => createRepNotification(pool, req.rep.id, 'sample_request_created',
      `Sample request ${request_number} created`,
      `Sample request for ${customer_name} with ${resolvedItems.length} item(s)`,
      'sample_request', sample_request.id));

    res.json({ sample_request, items: resolvedItems });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/rep/sample-requests', repAuth, async (req, res) => {
  try {
    const { status, search } = req.query;
    let query = `
      SELECT sr.*,
        (SELECT COUNT(*)::int FROM sample_request_items WHERE sample_request_id = sr.id) as item_count
      FROM sample_requests sr
      WHERE sr.rep_id = $1
    `;
    const params = [req.rep.id];
    let idx = 2;

    if (status) {
      query += ` AND sr.status = $${idx}`;
      params.push(status);
      idx++;
    }
    if (search) {
      query += ` AND (sr.customer_name ILIKE $${idx} OR sr.customer_email ILIKE $${idx} OR sr.request_number ILIKE $${idx})`;
      params.push('%' + search + '%');
      idx++;
    }

    query += ' ORDER BY sr.created_at DESC';
    const result = await pool.query(query, params);
    res.json({ sample_requests: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rep/sample-requests/:id', repAuth, async (req, res) => {
  try {
    const srRes = await pool.query('SELECT * FROM sample_requests WHERE id = $1 AND rep_id = $2', [req.params.id, req.rep.id]);
    if (!srRes.rows.length) return res.status(404).json({ error: 'Sample request not found' });

    const itemsRes = await pool.query('SELECT * FROM sample_request_items WHERE sample_request_id = $1 ORDER BY sort_order', [req.params.id]);
    res.json({ sample_request: srRes.rows[0], items: itemsRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rep/sample-requests/:id', repAuth, async (req, res) => {
  try {
    const srRes = await pool.query('SELECT * FROM sample_requests WHERE id = $1 AND rep_id = $2', [req.params.id, req.rep.id]);
    if (!srRes.rows.length) return res.status(404).json({ error: 'Sample request not found' });
    if (srRes.rows[0].status !== 'requested') return res.status(400).json({ error: 'Can only edit requests in requested status' });

    const { customer_name, customer_email, customer_phone, shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip, delivery_method, notes } = req.body;
    const fields = [];
    const vals = [];
    let idx = 1;
    if (customer_name !== undefined) { fields.push(`customer_name = $${idx}`); vals.push(customer_name); idx++; }
    if (customer_email !== undefined) { fields.push(`customer_email = $${idx}`); vals.push(customer_email || null); idx++; }
    if (customer_phone !== undefined) { fields.push(`customer_phone = $${idx}`); vals.push(customer_phone || null); idx++; }
    if (shipping_address_line1 !== undefined) { fields.push(`shipping_address_line1 = $${idx}`); vals.push(shipping_address_line1 || null); idx++; }
    if (shipping_address_line2 !== undefined) { fields.push(`shipping_address_line2 = $${idx}`); vals.push(shipping_address_line2 || null); idx++; }
    if (shipping_city !== undefined) { fields.push(`shipping_city = $${idx}`); vals.push(shipping_city || null); idx++; }
    if (shipping_state !== undefined) { fields.push(`shipping_state = $${idx}`); vals.push(shipping_state || null); idx++; }
    if (shipping_zip !== undefined) { fields.push(`shipping_zip = $${idx}`); vals.push(shipping_zip || null); idx++; }
    if (delivery_method !== undefined) { fields.push(`delivery_method = $${idx}`); vals.push(delivery_method === 'pickup' ? 'pickup' : 'shipping'); idx++; }
    if (notes !== undefined) { fields.push(`notes = $${idx}`); vals.push(notes || null); idx++; }

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    vals.push(req.params.id);
    await pool.query(`UPDATE sample_requests SET ${fields.join(', ')} WHERE id = $${idx}`, vals);

    const updated = await pool.query('SELECT * FROM sample_requests WHERE id = $1', [req.params.id]);
    res.json({ sample_request: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rep/sample-requests/:id/ship', repAuth, async (req, res) => {
  try {
    const srRes = await pool.query('SELECT * FROM sample_requests WHERE id = $1 AND rep_id = $2', [req.params.id, req.rep.id]);
    if (!srRes.rows.length) return res.status(404).json({ error: 'Sample request not found' });
    if (srRes.rows[0].status !== 'requested') return res.status(400).json({ error: 'Can only ship requests in requested status' });

    const { tracking_number } = req.body || {};
    await pool.query(
      `UPDATE sample_requests SET status = 'shipped', shipped_at = NOW(), tracking_number = $2 WHERE id = $1`,
      [req.params.id, tracking_number || null]
    );

    const updated = await pool.query('SELECT * FROM sample_requests WHERE id = $1', [req.params.id]);
    const sr = updated.rows[0];

    // Fire-and-forget: email + notification
    if (sr.customer_email) {
      const itemsRes = await pool.query('SELECT * FROM sample_request_items WHERE sample_request_id = $1 ORDER BY sort_order', [sr.id]);
      setImmediate(() => sendSampleRequestShipped({
        customer_name: sr.customer_name,
        customer_email: sr.customer_email,
        request_number: sr.request_number,
        tracking_number: sr.tracking_number,
        items: itemsRes.rows
      }));
    }
    setImmediate(() => createRepNotification(pool, req.rep.id, 'sample_request_shipped',
      `Sample request ${sr.request_number} shipped`,
      tracking_number ? `Tracking: ${tracking_number}` : 'No tracking number provided',
      'sample_request', sr.id));

    res.json({ sample_request: sr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rep/sample-requests/:id/deliver', repAuth, async (req, res) => {
  try {
    const srRes = await pool.query('SELECT * FROM sample_requests WHERE id = $1 AND rep_id = $2', [req.params.id, req.rep.id]);
    if (!srRes.rows.length) return res.status(404).json({ error: 'Sample request not found' });
    if (srRes.rows[0].status !== 'shipped') return res.status(400).json({ error: 'Can only mark shipped requests as delivered' });

    await pool.query(`UPDATE sample_requests SET status = 'delivered', delivered_at = NOW() WHERE id = $1`, [req.params.id]);
    const updated = await pool.query('SELECT * FROM sample_requests WHERE id = $1', [req.params.id]);
    res.json({ sample_request: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rep/sample-requests/:id/cancel', repAuth, async (req, res) => {
  try {
    const srRes = await pool.query('SELECT * FROM sample_requests WHERE id = $1 AND rep_id = $2', [req.params.id, req.rep.id]);
    if (!srRes.rows.length) return res.status(404).json({ error: 'Sample request not found' });
    if (!['requested', 'shipped'].includes(srRes.rows[0].status)) return res.status(400).json({ error: 'Can only cancel requested or shipped sample requests' });

    await pool.query(`UPDATE sample_requests SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`, [req.params.id]);
    const updated = await pool.query('SELECT * FROM sample_requests WHERE id = $1', [req.params.id]);
    res.json({ sample_request: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/rep/sample-requests/:id', repAuth, async (req, res) => {
  try {
    const srRes = await pool.query('SELECT * FROM sample_requests WHERE id = $1 AND rep_id = $2', [req.params.id, req.rep.id]);
    if (!srRes.rows.length) return res.status(404).json({ error: 'Sample request not found' });
    if (srRes.rows[0].status !== 'requested') return res.status(400).json({ error: 'Can only delete requests in requested status' });

    await pool.query('DELETE FROM sample_requests WHERE id = $1', [req.params.id]);
    res.json({ success: true });
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

// ==================== Quick Create Order (Rep) ====================

app.post('/api/rep/orders', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { customer_name, customer_email, phone, delivery_method, shipping_address,
            payment_method, items, promo_code } = req.body;

    if (!customer_name || !customer_email) {
      return res.status(400).json({ error: 'Customer name and email are required' });
    }
    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required' });
    }
    if (!payment_method || !['offline', 'stripe'].includes(payment_method)) {
      return res.status(400).json({ error: 'payment_method must be offline or stripe' });
    }

    const isPickup = delivery_method === 'pickup';
    if (!isPickup && (!shipping_address || !shipping_address.line1 || !shipping_address.city || !shipping_address.state || !shipping_address.zip)) {
      return res.status(400).json({ error: 'Shipping address is required for delivery orders' });
    }

    await client.query('BEGIN');

    // Resolve items
    const resolvedItems = [];
    for (const item of items) {
      if (item.sku_id) {
        // SKU-based item
        const skuResult = await client.query(`
          SELECT s.id as sku_id, s.product_id, s.vendor_sku, s.variant_name, s.sell_by, s.is_sample,
            p.name as product_name, p.collection, p.category_id,
            pr.retail_price, pr.cost, pr.price_basis,
            pk.sqft_per_box
          FROM skus s
          JOIN products p ON p.id = s.product_id
          LEFT JOIN pricing pr ON pr.sku_id = s.id
          LEFT JOIN packaging pk ON pk.sku_id = s.id
          WHERE s.id = $1 AND s.status = 'active'
        `, [item.sku_id]);

        if (!skuResult.rows.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'SKU not found: ' + item.sku_id });
        }

        const sku = skuResult.rows[0];
        const numBoxes = parseInt(item.num_boxes) || 1;
        const unitPrice = parseFloat(sku.retail_price || 0);
        const sqftPerBox = parseFloat(sku.sqft_per_box || 0);
        const sqftNeeded = sqftPerBox > 0 ? sqftPerBox * numBoxes : null;
        const subtotal = unitPrice * numBoxes;

        resolvedItems.push({
          product_id: sku.product_id,
          sku_id: sku.sku_id,
          product_name: sku.product_name + (sku.variant_name ? ' — ' + sku.variant_name : ''),
          collection: sku.collection,
          category_id: sku.category_id,
          sqft_needed: sqftNeeded,
          num_boxes: numBoxes,
          unit_price: unitPrice,
          subtotal,
          sell_by: sku.sell_by,
          is_sample: sku.is_sample || false
        });
      } else if (item.product_name && item.unit_price != null) {
        // Custom item
        const numBoxes = parseInt(item.num_boxes) || 1;
        const unitPrice = parseFloat(item.unit_price);
        resolvedItems.push({
          product_id: null,
          sku_id: null,
          product_name: item.product_name,
          collection: null,
          category_id: null,
          description: item.description || null,
          sqft_needed: null,
          num_boxes: numBoxes,
          unit_price: unitPrice,
          subtotal: unitPrice * numBoxes,
          sell_by: null,
          is_sample: false
        });
      } else {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Each item must have either sku_id or product_name + unit_price' });
      }
    }

    const productItems = resolvedItems.filter(i => !i.is_sample);
    const subtotal = productItems.reduce((sum, i) => sum + i.subtotal, 0);

    // Promo code
    let discountAmount = 0;
    let promoCodeId = null;
    let promoCodeStr = null;
    if (promo_code) {
      const promoItems = resolvedItems.map(i => ({
        product_id: i.product_id,
        category_id: i.category_id,
        subtotal: i.subtotal,
        is_sample: i.is_sample
      }));
      const promoResult = await calculatePromoDiscount(promo_code, promoItems, customer_email, client);
      if (!promoResult.valid) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: promoResult.error });
      }
      discountAmount = promoResult.discount_amount;
      promoCodeId = promoResult.promo.id;
      promoCodeStr = promoResult.promo.code;
    }

    const total = subtotal - discountAmount;
    const orderNumber = 'ORD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();
    const orderStatus = payment_method === 'offline' ? 'confirmed' : 'pending';

    let stripePaymentIntentId = null;
    if (payment_method === 'stripe') {
      const totalCents = Math.round(total * 100);
      if (totalCents > 0) {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: totalCents,
          currency: 'usd',
        });
        stripePaymentIntentId = paymentIntent.id;
      }
    }

    const orderResult = await client.query(`
      INSERT INTO orders (order_number, customer_email, customer_name, phone,
        shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip,
        subtotal, shipping, total, status, sales_rep_id, payment_method, delivery_method,
        stripe_payment_intent_id, promo_code_id, promo_code, discount_amount,
        amount_paid)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      RETURNING *
    `, [orderNumber, customer_email.toLowerCase().trim(), customer_name, phone || null,
        isPickup ? null : shipping_address.line1, isPickup ? null : (shipping_address.line2 || null),
        isPickup ? null : shipping_address.city, isPickup ? null : shipping_address.state, isPickup ? null : shipping_address.zip,
        subtotal.toFixed(2), total.toFixed(2), orderStatus, req.rep.id, payment_method,
        isPickup ? 'pickup' : 'shipping',
        stripePaymentIntentId, promoCodeId, promoCodeStr, discountAmount.toFixed(2),
        payment_method === 'offline' ? total.toFixed(2) : '0.00']);

    const order = orderResult.rows[0];

    for (const item of resolvedItems) {
      await client.query(`
        INSERT INTO order_items (order_id, product_id, sku_id, product_name, collection, description,
          sqft_needed, num_boxes, unit_price, subtotal, sell_by, is_sample)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [order.id, item.product_id, item.sku_id, item.product_name, item.collection,
          item.description || null, item.sqft_needed, item.num_boxes,
          item.unit_price.toFixed(2), item.subtotal.toFixed(2), item.sell_by || null, item.is_sample]);
    }

    // Record offline payment in ledger
    if (payment_method === 'offline') {
      await client.query(`
        INSERT INTO order_payments (order_id, payment_type, amount, description, initiated_by, initiated_by_name, status)
        VALUES ($1, 'charge', $2, 'Offline payment (rep-created)', $3, $4, 'completed')
      `, [order.id, total.toFixed(2), req.rep.id, req.rep.first_name + ' ' + req.rep.last_name]);
    }

    // Record promo usage
    if (promoCodeId && discountAmount > 0) {
      await client.query(
        'INSERT INTO promo_code_usages (promo_code_id, order_id, customer_email, discount_amount) VALUES ($1, $2, $3, $4)',
        [promoCodeId, order.id, customer_email, discountAmount.toFixed(2)]
      );
    }

    // Generate POs if confirmed
    if (orderStatus === 'confirmed') {
      await generatePurchaseOrders(order.id, client);
    }

    // Log activity
    const repName = req.rep.first_name + ' ' + req.rep.last_name;
    await logOrderActivity(client, order.id, 'order_created', req.rep.id, repName,
      { payment_method, item_count: resolvedItems.length, total: total.toFixed(2) });

    await client.query('COMMIT');

    const orderItems = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
    res.json({ order: { ...order, items: orderItems.rows } });

    // Recalculate commission for rep-created order
    setImmediate(() => recalculateCommission(pool, order.id));

    // Fire-and-forget: send confirmation email
    const emailOrder = { ...order, items: orderItems.rows };
    setImmediate(() => sendOrderConfirmation(emailOrder));

    // Fire-and-forget: notify creating rep
    setImmediate(() => createRepNotification(pool, req.rep.id, 'order_created',
      'Order ' + orderNumber + ' created',
      'You created order ' + orderNumber + ' for ' + customer_name + ' ($' + total.toFixed(2) + ')',
      'order', order.id));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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

    const payments = await pool.query('SELECT * FROM order_payments WHERE order_id = $1 ORDER BY created_at', [id]);
    const paymentRequests = await pool.query('SELECT * FROM payment_requests WHERE order_id = $1 ORDER BY created_at DESC', [id]);
    const balanceInfo = await recalculateBalance(id);

    res.json({
      order: order.rows[0],
      items: items.rows,
      price_adjustments: adjustments.rows,
      payments: payments.rows,
      payment_requests: paymentRequests.rows,
      balance: balanceInfo
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rep/orders/:id/status', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { status, tracking_number, carrier, shipped_at, cancel_reason } = req.body;
    const validStatuses = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refunded'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Refunded status can only be set via the dedicated refund endpoint
    if (status === 'refunded') {
      return res.status(400).json({ error: 'Use the refund endpoint to issue refunds' });
    }

    // Require cancel reason
    if (status === 'cancelled' && (!cancel_reason || !cancel_reason.trim())) {
      return res.status(400).json({ error: 'A cancellation reason is required' });
    }

    await client.query('BEGIN');

    // Block uncancelling a refunded order
    const currentOrder = await client.query('SELECT status, stripe_refund_id FROM orders WHERE id = $1', [id]);
    if (currentOrder.rows.length && currentOrder.rows[0].status === 'cancelled' && currentOrder.rows[0].stripe_refund_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot reopen an order that has been refunded' });
    }

    let result;
    if (status === 'shipped' && tracking_number) {
      result = await client.query(`
        UPDATE orders SET status = $1, tracking_number = $2, shipping_carrier = $3, shipped_at = COALESCE($4::timestamp, NOW())
        WHERE id = $5
        RETURNING *
      `, [status, tracking_number, carrier || null, shipped_at || null, id]);
    } else if (status === 'shipped') {
      const orderCheck = await client.query('SELECT delivery_method FROM orders WHERE id = $1', [id]);
      if (orderCheck.rows.length && orderCheck.rows[0].delivery_method === 'shipping') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Tracking number is required for shipping orders' });
      }
      result = await client.query(`
        UPDATE orders SET status = $1, shipped_at = NOW()
        WHERE id = $2
        RETURNING *
      `, [status, id]);
    } else if (status === 'confirmed') {
      result = await client.query(
        'UPDATE orders SET status = $1, confirmed_at = NOW() WHERE id = $2 RETURNING *',
        [status, id]
      );
    } else if (status === 'delivered') {
      result = await client.query(
        'UPDATE orders SET status = $1, delivered_at = NOW() WHERE id = $2 RETURNING *',
        [status, id]
      );
    } else if (status === 'cancelled') {
      result = await client.query(
        'UPDATE orders SET status = $1, cancel_reason = $2 WHERE id = $3 RETURNING *',
        [status, cancel_reason.trim(), id]
      );
    } else {
      // For uncancelling or other transitions, clear cancel_reason
      result = await client.query(
        'UPDATE orders SET status = $1, cancel_reason = NULL WHERE id = $2 RETURNING *',
        [status, id]
      );
    }

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

    // Cascade PO cancellation when order is cancelled
    if (status === 'cancelled') {
      const pos = await client.query(
        "SELECT id, status FROM purchase_orders WHERE order_id = $1 AND status NOT IN ('fulfilled', 'cancelled')",
        [id]
      );
      for (const po of pos.rows) {
        await client.query(
          "UPDATE purchase_orders SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
          [po.id]
        );
        const repName = req.rep.first_name + ' ' + req.rep.last_name;
        await client.query(
          `INSERT INTO po_activity_log (purchase_order_id, action, performer_name, details)
           VALUES ($1, 'auto_cancelled', $2, $3)`,
          [po.id, repName, JSON.stringify({ reason: 'order_cancelled' })]
        );
      }
    }

    // Delete cancelled POs when order is uncancelled — fresh POs will be generated on re-confirm
    const oldStatusRep = currentOrder.rows.length ? currentOrder.rows[0].status : null;
    if (oldStatusRep === 'cancelled' && status !== 'cancelled') {
      const cancelledPOs = await client.query(
        "SELECT id FROM purchase_orders WHERE order_id = $1 AND status = 'cancelled'",
        [id]
      );
      for (const po of cancelledPOs.rows) {
        await client.query('DELETE FROM po_activity_log WHERE purchase_order_id = $1', [po.id]);
        await client.query('DELETE FROM purchase_order_items WHERE purchase_order_id = $1', [po.id]);
        await client.query('DELETE FROM purchase_orders WHERE id = $1', [po.id]);
      }
    }
    const repName = req.rep.first_name + ' ' + req.rep.last_name;
    await logOrderActivity(client, id, 'status_changed', req.rep.id, repName,
      { from: oldStatusRep, to: status,
        ...(tracking_number ? { tracking_number, carrier: carrier || null } : {}),
        ...(status === 'cancelled' && cancel_reason ? { cancel_reason: cancel_reason.trim() } : {}) });

    // Auto-assign rep if order is unassigned
    if (!result.rows[0].sales_rep_id) {
      await client.query('UPDATE orders SET sales_rep_id = $1 WHERE id = $2', [req.rep.id, id]);
      result.rows[0].sales_rep_id = req.rep.id;
      await logOrderActivity(client, id, 'rep_assigned', req.rep.id, repName, { rep_name: repName, auto: true });
    }

    await client.query('COMMIT');
    const updatedOrder = result.rows[0];
    res.json({ order: updatedOrder });

    // Recalculate commission on status change
    setImmediate(() => recalculateCommission(pool, id));

    // Fire-and-forget: send status update email for shipped/delivered/cancelled
    setImmediate(() => sendOrderStatusUpdate(updatedOrder, status));

    // Notify assigned rep if a different rep made the change
    if (updatedOrder.sales_rep_id && updatedOrder.sales_rep_id !== req.rep.id) {
      setImmediate(() => createRepNotification(pool, updatedOrder.sales_rep_id, 'order_status_changed',
        'Order ' + updatedOrder.order_number + ' → ' + status,
        req.rep.first_name + ' ' + req.rep.last_name + ' changed status to ' + status,
        'order', id));
    }
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Change delivery method on existing order (rep)
app.put('/api/rep/orders/:id/delivery-method', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { delivery_method, shipping_address, shipping_option_index, residential, liftgate } = req.body;

    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (!orderResult.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];

    if (!['pending', 'confirmed'].includes(order.status)) {
      return res.status(400).json({ error: 'Can only change delivery method on pending or confirmed orders' });
    }

    if (!['pickup', 'shipping'].includes(delivery_method)) {
      return res.status(400).json({ error: 'delivery_method must be "pickup" or "shipping"' });
    }

    const oldDeliveryMethod = order.delivery_method;
    const repName = req.rep.first_name + ' ' + req.rep.last_name;

    // Switch to pickup
    if (delivery_method === 'pickup') {
      const newTotal = (parseFloat(order.subtotal) + parseFloat(order.sample_shipping || 0) - parseFloat(order.discount_amount || 0)).toFixed(2);
      const updated = await pool.query(`
        UPDATE orders SET delivery_method = 'pickup', shipping = 0, shipping_method = 'pickup',
          shipping_carrier = NULL, shipping_transit_days = NULL, shipping_residential = false,
          shipping_liftgate = false, shipping_is_fallback = false,
          shipping_address_line1 = NULL, shipping_address_line2 = NULL,
          shipping_city = NULL, shipping_state = NULL, shipping_zip = NULL,
          total = $2
        WHERE id = $1 RETURNING *
      `, [id, newTotal]);
      await logOrderActivity(pool, id, 'delivery_method_changed', req.rep.id, repName,
        { from: oldDeliveryMethod, to: 'pickup' });
      const balanceInfo = await recalculateBalance(id);
      return res.json({ order: updated.rows[0], balance: balanceInfo });
    }

    // Switch to shipping — need address
    if (!shipping_address || !shipping_address.line1 || !shipping_address.city || !shipping_address.state || !shipping_address.zip) {
      return res.status(400).json({ error: 'shipping_address with line1, city, state, zip is required' });
    }

    // If no option selected yet, calculate rates and return them
    if (shipping_option_index === undefined || shipping_option_index === null) {
      const destination = { zip: shipping_address.zip, city: shipping_address.city, state: shipping_address.state };
      const rates = await calculateShippingForOrder(order.id, destination, { residential: residential !== false, liftgate: liftgate !== false });
      return res.json({ shipping_options: rates.options, method: rates.method, weight_lbs: rates.weight_lbs, total_boxes: rates.total_boxes });
    }

    // Apply selected shipping option
    const destination = { zip: shipping_address.zip, city: shipping_address.city, state: shipping_address.state };
    const rates = await calculateShippingForOrder(order.id, destination, { residential: residential !== false, liftgate: liftgate !== false });

    const optionIdx = parseInt(shipping_option_index);
    if (optionIdx < 0 || optionIdx >= rates.options.length) {
      return res.status(400).json({ error: 'Invalid shipping_option_index' });
    }

    const selected = rates.options[optionIdx];
    const shippingCost = parseFloat(selected.amount || 0);
    const newTotal = (parseFloat(order.subtotal) + shippingCost + parseFloat(order.sample_shipping || 0) - parseFloat(order.discount_amount || 0)).toFixed(2);

    const updated = await pool.query(`
      UPDATE orders SET delivery_method = 'shipping', shipping = $2, shipping_method = $3,
        shipping_carrier = $4, shipping_transit_days = $5,
        shipping_residential = $6, shipping_liftgate = $7, shipping_is_fallback = $8,
        shipping_address_line1 = $9, shipping_address_line2 = $10,
        shipping_city = $11, shipping_state = $12, shipping_zip = $13,
        total = $14
      WHERE id = $1 RETURNING *
    `, [id, shippingCost.toFixed(2), rates.method,
        selected.carrier || null, selected.transit_days || null,
        residential !== false, liftgate !== false, selected.is_fallback || false,
        shipping_address.line1, shipping_address.line2 || null,
        shipping_address.city, shipping_address.state, shipping_address.zip,
        newTotal]);

    await logOrderActivity(pool, id, 'delivery_method_changed', req.rep.id, repName,
      { from: oldDeliveryMethod, to: 'shipping', shipping_cost: shippingCost.toFixed(2) });
    const balanceInfo = await recalculateBalance(id);
    return res.json({ order: updated.rows[0], balance: balanceInfo });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const repName = req.rep.first_name + ' ' + req.rep.last_name;
    await logOrderActivity(pool, id, 'rep_assigned', req.rep.id, repName, { rep_name: repName });
    res.json({ order: result.rows[0] });

    // Notify the assigned rep
    setImmediate(() => createRepNotification(pool, req.rep.id, 'order_assigned',
      'Order ' + result.rows[0].order_number + ' assigned to you',
      'You have been assigned to order ' + result.rows[0].order_number,
      'order', id));
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

    await logOrderActivity(client, id, 'price_adjusted', req.rep.id, req.rep.first_name + ' ' + req.rep.last_name,
      { product_name: current.product_name, previous_price: prevPrice.toFixed(2), new_price: newPrice.toFixed(2), reason: reason || null });

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

    const balanceInfo = await recalculateBalance(id);
    res.json({ order: updatedOrder.rows[0], items: updatedItems.rows, price_adjustments: adjustments.rows, balance: balanceInfo });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Add item to existing order (rep)
// Supports two modes:
//   SKU mode: { sku_id, num_boxes, sqft_needed? }
//   Custom mode: { product_name, unit_price, vendor_id, num_boxes, description?, sqft_needed? }
app.post('/api/rep/orders/:id/add-item', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { sku_id, num_boxes, sqft_needed, product_name, unit_price, vendor_id, description } = req.body;

    const isCustom = !sku_id;
    if (isCustom) {
      if (!product_name || !product_name.trim()) return res.status(400).json({ error: 'product_name is required for custom items' });
      if (unit_price == null || parseFloat(unit_price) < 0) return res.status(400).json({ error: 'unit_price >= 0 is required for custom items' });
      if (!vendor_id) return res.status(400).json({ error: 'vendor_id is required for custom items' });
      if (!num_boxes || num_boxes < 1) return res.status(400).json({ error: 'num_boxes >= 1 is required' });
    } else {
      if (!num_boxes || num_boxes < 1) return res.status(400).json({ error: 'sku_id and num_boxes (>= 1) are required' });
    }

    const orderResult = await client.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (!orderResult.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (!['pending', 'confirmed'].includes(order.status)) {
      return res.status(400).json({ error: 'Can only add items to pending or confirmed orders' });
    }

    let sku = null;
    let unitPrice, isSample, sqftPerBox, isPerSqft, computedSqft, itemSubtotal;
    let itemVendorId;

    if (!isCustom) {
      const skuResult = await client.query(`
        SELECT s.*, p.name as product_name, p.collection, p.vendor_id,
          pr.retail_price, pr.price_basis, pr.cost,
          pk.sqft_per_box, pk.weight_per_box_lbs
        FROM skus s
        JOIN products p ON p.id = s.product_id
        LEFT JOIN pricing pr ON pr.sku_id = s.id
        LEFT JOIN packaging pk ON pk.sku_id = s.id
        WHERE s.id = $1
      `, [sku_id]);
      if (!skuResult.rows.length) return res.status(404).json({ error: 'SKU not found' });
      sku = skuResult.rows[0];

      unitPrice = parseFloat(sku.retail_price || 0);
      isSample = sku.is_sample || false;
      sqftPerBox = parseFloat(sku.sqft_per_box || 1);
      isPerSqft = sku.price_basis === 'per_sqft';
      computedSqft = isPerSqft ? num_boxes * sqftPerBox : null;
      itemSubtotal = isSample ? 0 : parseFloat((isPerSqft ? unitPrice * computedSqft : unitPrice * num_boxes).toFixed(2));
      itemVendorId = sku.vendor_id;
    } else {
      unitPrice = parseFloat(unit_price);
      isSample = false;
      itemSubtotal = parseFloat((unitPrice * num_boxes).toFixed(2));
      itemVendorId = vendor_id;

      const vendorCheck = await client.query('SELECT id FROM vendors WHERE id = $1', [vendor_id]);
      if (!vendorCheck.rows.length) return res.status(400).json({ error: 'Vendor not found' });
    }

    await client.query('BEGIN');

    let newItemId;
    if (!isCustom) {
      const insertResult = await client.query(`
        INSERT INTO order_items (order_id, product_id, sku_id, product_name, collection,
          sqft_needed, num_boxes, unit_price, subtotal, is_sample, sell_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id
      `, [id, sku.product_id, sku_id, sku.product_name, sku.collection,
          sqft_needed || computedSqft || null, num_boxes, unitPrice.toFixed(2), itemSubtotal.toFixed(2),
          isSample, sku.sell_by || null]);
      newItemId = insertResult.rows[0].id;
    } else {
      const insertResult = await client.query(`
        INSERT INTO order_items (order_id, product_id, sku_id, product_name, collection,
          sqft_needed, num_boxes, unit_price, subtotal, is_sample, sell_by, description)
        VALUES ($1, NULL, NULL, $2, NULL, $3, $4, $5, $6, false, NULL, $7)
        RETURNING id
      `, [id, product_name.trim(), sqft_needed || null, num_boxes, unitPrice.toFixed(2),
          itemSubtotal.toFixed(2), description || null]);
      newItemId = insertResult.rows[0].id;
    }

    const totalsResult = await client.query(`
      SELECT COALESCE(SUM(CASE WHEN NOT is_sample THEN subtotal ELSE 0 END), 0) as new_subtotal
      FROM order_items WHERE order_id = $1
    `, [id]);
    const newSubtotal = parseFloat(parseFloat(totalsResult.rows[0].new_subtotal).toFixed(2));
    const newTotal = parseFloat((newSubtotal + parseFloat(order.shipping || 0) + parseFloat(order.sample_shipping || 0) - parseFloat(order.discount_amount || 0)).toFixed(2));

    await client.query('UPDATE orders SET subtotal = $1, total = $2 WHERE id = $3',
      [newSubtotal.toFixed(2), newTotal.toFixed(2), id]);

    // --- Auto-update Purchase Orders ---
    if (!isSample) {
      const existingPO = await client.query(
        `SELECT id, subtotal FROM purchase_orders
         WHERE order_id = $1 AND vendor_id = $2 AND status = 'draft'
         LIMIT 1`,
        [id, itemVendorId]
      );

      let poId;
      if (existingPO.rows.length) {
        poId = existingPO.rows[0].id;
      } else {
        const vendorResult = await client.query('SELECT code FROM vendors WHERE id = $1', [itemVendorId]);
        const vendorCode = vendorResult.rows[0]?.code || 'CUST';
        const poNumber = `PO-${vendorCode}-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
        const newPO = await client.query(
          `INSERT INTO purchase_orders (order_id, vendor_id, po_number, status, subtotal)
           VALUES ($1, $2, $3, 'draft', 0) RETURNING id`,
          [id, itemVendorId, poNumber]
        );
        poId = newPO.rows[0].id;
      }

      let poCost, poRetail, poVendorSku, poProductName;
      if (sku) {
        const skuSqftPerBox = parseFloat(sku.sqft_per_box || 1);
        const vendorCost = parseFloat(sku.cost || 0);
        poCost = sku.price_basis === 'per_sqft' ? vendorCost * skuSqftPerBox : vendorCost;
        poRetail = sku.price_basis === 'per_sqft' ? unitPrice * skuSqftPerBox : unitPrice;
        poVendorSku = sku.vendor_sku;
        poProductName = sku.product_name;
      } else {
        poCost = unitPrice;
        poRetail = unitPrice;
        poVendorSku = null;
        poProductName = product_name.trim();
      }

      await client.query(`
        INSERT INTO purchase_order_items
          (purchase_order_id, order_item_id, sku_id, product_name, vendor_sku, description,
           qty, sell_by, cost, original_cost, retail_price, subtotal)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11)
      `, [poId, newItemId, sku?.id || null, poProductName, poVendorSku,
          description || null, num_boxes, sku?.sell_by || null,
          poCost.toFixed(2), poRetail ? poRetail.toFixed(2) : null,
          (poCost * num_boxes).toFixed(2)]);

      await client.query(`
        UPDATE purchase_orders SET subtotal = (
          SELECT COALESCE(SUM(subtotal), 0) FROM purchase_order_items WHERE purchase_order_id = $1
        ) WHERE id = $1
      `, [poId]);
    }

    await logOrderActivity(client, id, 'item_added', req.rep.id, req.rep.first_name + ' ' + req.rep.last_name,
      { product_name: isCustom ? product_name.trim() : sku.product_name, is_custom: isCustom, num_boxes, subtotal: itemSubtotal.toFixed(2) });

    await client.query('COMMIT');

    const balanceInfo = await recalculateBalance(id);
    const updatedOrder = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    const updatedItems = await pool.query(`
      SELECT oi.*, p.name as current_product_name, p.collection as current_collection
      FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1 ORDER BY oi.id
    `, [id]);

    const posResult = await pool.query(`
      SELECT po.*, v.name as vendor_name
      FROM purchase_orders po
      JOIN vendors v ON v.id = po.vendor_id
      WHERE po.order_id = $1
      ORDER BY po.created_at
    `, [id]);
    const purchaseOrders = posResult.rows;
    for (const po of purchaseOrders) {
      const poItems = await pool.query('SELECT * FROM purchase_order_items WHERE purchase_order_id = $1 ORDER BY created_at', [po.id]);
      po.items = poItems.rows;
    }

    res.json({ order: updatedOrder.rows[0], items: updatedItems.rows, balance: balanceInfo, purchase_orders: purchaseOrders });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Remove item from existing order (rep)
app.delete('/api/rep/orders/:id/items/:itemId', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id, itemId } = req.params;

    const orderResult = await client.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (!orderResult.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (!['pending', 'confirmed'].includes(order.status)) {
      return res.status(400).json({ error: 'Can only remove items from pending or confirmed orders' });
    }

    const itemResult = await client.query('SELECT * FROM order_items WHERE id = $1 AND order_id = $2', [itemId, id]);
    if (!itemResult.rows.length) return res.status(404).json({ error: 'Order item not found' });

    await client.query('BEGIN');

    // Delete linked PO items first (FK constraint), then recalculate affected PO subtotals
    const linkedPOItems = await client.query(
      'SELECT id, purchase_order_id FROM purchase_order_items WHERE order_item_id = $1', [itemId]
    );
    const affectedPOIds = [...new Set(linkedPOItems.rows.map(r => r.purchase_order_id))];
    if (linkedPOItems.rows.length > 0) {
      await client.query('DELETE FROM purchase_order_items WHERE order_item_id = $1', [itemId]);
    }

    await client.query('DELETE FROM order_items WHERE id = $1', [itemId]);

    // Recalculate affected PO subtotals and remove empty POs
    for (const poId of affectedPOIds) {
      const remaining = await client.query('SELECT COUNT(*) as cnt FROM purchase_order_items WHERE purchase_order_id = $1', [poId]);
      if (parseInt(remaining.rows[0].cnt) === 0) {
        await client.query('DELETE FROM purchase_orders WHERE id = $1', [poId]);
      } else {
        await client.query(`
          UPDATE purchase_orders SET subtotal = (
            SELECT COALESCE(SUM(subtotal), 0) FROM purchase_order_items WHERE purchase_order_id = $1
          ) WHERE id = $1
        `, [poId]);
      }
    }

    const totalsResult = await client.query(`
      SELECT COALESCE(SUM(CASE WHEN NOT is_sample THEN subtotal ELSE 0 END), 0) as new_subtotal
      FROM order_items WHERE order_id = $1
    `, [id]);
    const newSubtotal = parseFloat(parseFloat(totalsResult.rows[0].new_subtotal).toFixed(2));
    const newTotal = parseFloat((newSubtotal + parseFloat(order.shipping || 0) + parseFloat(order.sample_shipping || 0) - parseFloat(order.discount_amount || 0)).toFixed(2));

    await client.query('UPDATE orders SET subtotal = $1, total = $2 WHERE id = $3',
      [newSubtotal.toFixed(2), newTotal.toFixed(2), id]);

    const removedItemRep = itemResult.rows[0];
    await logOrderActivity(client, id, 'item_removed', req.rep.id, req.rep.first_name + ' ' + req.rep.last_name,
      { product_name: removedItemRep.product_name, num_boxes: removedItemRep.num_boxes, subtotal: parseFloat(removedItemRep.subtotal).toFixed(2) });

    await client.query('COMMIT');

    const balanceInfo = await recalculateBalance(id);
    const updatedOrder = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    const updatedItems = await pool.query(`
      SELECT oi.*, p.name as current_product_name, p.collection as current_collection
      FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1 ORDER BY oi.id
    `, [id]);

    // Fetch updated POs
    const posResult = await pool.query(`
      SELECT po.*, v.name as vendor_name
      FROM purchase_orders po
      JOIN vendors v ON v.id = po.vendor_id
      WHERE po.order_id = $1
      ORDER BY po.created_at
    `, [id]);
    const purchaseOrders = posResult.rows;
    for (const po of purchaseOrders) {
      const poItems = await pool.query('SELECT * FROM purchase_order_items WHERE purchase_order_id = $1 ORDER BY created_at', [po.id]);
      po.items = poItems.rows;
    }

    res.json({ order: updatedOrder.rows[0], items: updatedItems.rows, balance: balanceInfo, purchase_orders: purchaseOrders });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Send payment request (rep)
app.post('/api/rep/orders/:id/payment-request', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body || {};
    const order = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });
    const o = order.rows[0];

    const balanceInfo = await recalculateBalance(id);
    if (!balanceInfo || balanceInfo.balance_status !== 'balance_due') {
      return res.status(400).json({ error: 'No balance due on this order' });
    }

    const amountDue = balanceInfo.balance;
    const repName = req.rep.first_name + ' ' + req.rep.last_name;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: o.customer_email,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `Balance Due — Order ${o.order_number}` },
          unit_amount: Math.round(amountDue * 100)
        },
        quantity: 1
      }],
      metadata: { order_id: id, type: 'payment_request' },
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/account?order=${id}&payment=success`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/account?order=${id}&payment=cancelled`,
      expires_at: Math.floor(Date.now() / 1000) + 72 * 3600
    });

    const prResult = await pool.query(`
      INSERT INTO payment_requests (order_id, amount, stripe_checkout_session_id, stripe_checkout_url, sent_to_email, sent_by, sent_by_name, message, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
    `, [id, amountDue.toFixed(2), session.id, session.url, o.customer_email, req.rep.id, repName, message || null,
        new Date(Date.now() + 72 * 3600 * 1000)]);

    await stripe.checkout.sessions.update(session.id, {
      metadata: { order_id: id, payment_request_id: prResult.rows[0].id, type: 'payment_request' }
    });

    await logOrderActivity(pool, id, 'payment_request_sent', req.rep.id, repName,
      { amount: amountDue.toFixed(2), sent_to: o.customer_email });

    setImmediate(() => sendPaymentRequest({ order: o, amount: amountDue, checkout_url: session.url, message: message || null }));

    res.json({ payment_request: prResult.rows[0], checkout_url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Vendors list for rep (used in custom item dropdown)
app.get('/api/rep/vendors', repAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, code FROM vendors WHERE is_active = true ORDER BY name');
    res.json({ vendors: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SKU search for add-item (rep)
app.get('/api/rep/skus/search', repAuth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ results: [] });
    const results = await pool.query(`
      SELECT s.id as sku_id, s.internal_sku, s.vendor_sku, s.variant_name, s.is_sample, s.sell_by,
        p.name as product_name, p.collection, p.vendor_id,
        v.name as vendor_name,
        pr.retail_price, pr.cost, pr.price_basis,
        pk.sqft_per_box
      FROM skus s
      JOIN products p ON p.id = s.product_id
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      LEFT JOIN packaging pk ON pk.sku_id = s.id
      WHERE p.status = 'active' AND s.status = 'active'
        AND (p.name ILIKE $1 OR s.internal_sku ILIKE $1 OR s.vendor_sku ILIKE $1 OR s.variant_name ILIKE $1 OR p.collection ILIKE $1 OR (p.collection || ' ' || p.name) ILIKE $1)
      ORDER BY p.name, s.variant_name
      LIMIT 15
    `, ['%' + q + '%']);
    res.json({ results: results.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Rep Product Catalog ====================

app.get('/api/rep/products', repAuth, async (req, res) => {
  try {
    const { search, category, collection, page: pageParam, limit: limitParam } = req.query;
    const page = parseInt(pageParam) || 1;
    const limit = Math.min(parseInt(limitParam) || 30, 100);
    const offset = (page - 1) * limit;

    let query = `
      SELECT p.*, v.name as vendor_name, c.name as category_name, c.slug as category_slug,
        (SELECT pr.retail_price FROM pricing pr
         JOIN skus s ON s.id = pr.sku_id
         WHERE s.product_id = p.id AND s.status = 'active' LIMIT 1) as price,
        (SELECT pr.cost FROM pricing pr
         JOIN skus s ON s.id = pr.sku_id
         WHERE s.product_id = p.id AND s.status = 'active' LIMIT 1) as cost,
        (SELECT ma.url FROM media_assets ma
         WHERE ma.product_id = p.id AND ma.asset_type = 'primary'
         ORDER BY CASE WHEN ma.sku_id IS NULL THEN 0 ELSE 1 END, ma.sort_order LIMIT 1) as primary_image,
        (SELECT CASE
           WHEN MAX(CASE WHEN inv.fresh_until > NOW() THEN inv.qty_on_hand END) IS NULL THEN 'unknown'
           WHEN MAX(CASE WHEN inv.fresh_until > NOW() THEN inv.qty_on_hand ELSE 0 END) > 10 THEN 'in_stock'
           WHEN MAX(CASE WHEN inv.fresh_until > NOW() THEN inv.qty_on_hand ELSE 0 END) > 0 THEN 'low_stock'
           ELSE 'out_of_stock'
         END
         FROM skus s2
         LEFT JOIN inventory_snapshots inv ON inv.sku_id = s2.id
         WHERE s2.product_id = p.id
        ) as stock_status
      FROM products p
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.status = 'active'
    `;
    const params = [];
    let paramIndex = 1;

    if (search) {
      params.push('%' + search + '%');
      query += ` AND (p.name ILIKE $${paramIndex} OR p.collection ILIKE $${paramIndex} OR (p.collection || ' ' || p.name) ILIKE $${paramIndex} OR p.description_short ILIKE $${paramIndex} OR v.name ILIKE $${paramIndex})`;
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

    if (collection) {
      params.push(collection);
      query += ` AND (p.collection = $${paramIndex} OR LOWER(REGEXP_REPLACE(p.collection, '[^a-zA-Z0-9]+', '-', 'g')) = LOWER($${paramIndex}))`;
      paramIndex++;
    }

    // Attribute filters
    try {
      const attrResult = await pool.query('SELECT slug FROM attributes WHERE is_filterable = true');
      for (const attr of attrResult.rows) {
        if (req.query[attr.slug]) {
          const values = req.query[attr.slug].split(',').map(v => v.trim()).filter(Boolean);
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
            params.push(...values, attr.slug);
            paramIndex += values.length + 1;
          }
        }
      }
    } catch (attrErr) { /* attributes table may not exist yet */ }

    // Count total
    const countQuery = query.replace(/SELECT p\.\*.*?FROM products p/s, 'SELECT COUNT(*)::int as total FROM products p');
    const countResult = await pool.query(countQuery, params);
    const total = countResult.rows[0].total;

    query += ` ORDER BY p.name LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Add margin_pct
    const products = result.rows.map(p => {
      const retail = parseFloat(p.price || 0);
      const cost = parseFloat(p.cost || 0);
      const margin_pct = retail > 0 ? ((retail - cost) / retail * 100) : 0;
      return { ...p, margin_pct: parseFloat(margin_pct.toFixed(1)) };
    });

    res.json({ products, total, page, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rep/products/:id', repAuth, async (req, res) => {
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
      SELECT s.*, pr.retail_price, pr.cost, pr.price_basis,
        pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs, pk.boxes_per_pallet,
        (SELECT CASE
           WHEN inv.fresh_until > NOW() THEN
             CASE WHEN inv.qty_on_hand > 10 THEN 'in_stock'
                  WHEN inv.qty_on_hand > 0 THEN 'low_stock'
                  ELSE 'out_of_stock' END
           ELSE 'unknown' END
         FROM inventory_snapshots inv WHERE inv.sku_id = s.id LIMIT 1
        ) as stock_status,
        (SELECT inv.qty_on_hand FROM inventory_snapshots inv WHERE inv.sku_id = s.id LIMIT 1) as qty_on_hand
      FROM skus s
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      LEFT JOIN packaging pk ON pk.sku_id = s.id
      WHERE s.product_id = $1 AND s.status = 'active'
      ORDER BY s.variant_name
    `, [id]);

    // Add margin_pct per SKU
    const skuRows = skus.rows.map(s => {
      const retail = parseFloat(s.retail_price || 0);
      const cost = parseFloat(s.cost || 0);
      const margin_pct = retail > 0 ? ((retail - cost) / retail * 100) : 0;
      return { ...s, margin_pct: parseFloat(margin_pct.toFixed(1)) };
    });

    const media = await pool.query(
      'SELECT * FROM media_assets WHERE product_id = $1 ORDER BY asset_type, sort_order',
      [id]
    );

    res.json({ product: product.rows[0], skus: skuRows, media: media.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Order activity log (rep)
app.get('/api/rep/orders/:id/activity', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM order_activity_log WHERE order_id = $1 ORDER BY created_at DESC',
      [id]
    );
    res.json({ activity: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// Rep bulk update PO item statuses (must be before :itemId routes)
app.put('/api/rep/purchase-orders/:poId/items/bulk-status', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { poId } = req.params;
    const { status } = req.body;
    const validStatuses = ['pending', 'ordered', 'shipped', 'received', 'cancelled'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status. Allowed: ' + validStatuses.join(', ') });

    const po = await client.query('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
    if (!po.rows.length) return res.status(404).json({ error: 'Purchase order not found' });

    await client.query('BEGIN');

    await client.query(
      `UPDATE purchase_order_items SET status = $1 WHERE purchase_order_id = $2 AND status NOT IN ('received', 'cancelled')`,
      [status, poId]
    );

    const allItems = await client.query('SELECT status FROM purchase_order_items WHERE purchase_order_id = $1', [poId]);
    const statuses = allItems.rows.map(r => r.status);
    let newPOStatus = null;
    if (statuses.length > 0 && statuses.every(s => s === 'received')) newPOStatus = 'fulfilled';
    else if (statuses.length > 0 && statuses.every(s => s === 'cancelled')) newPOStatus = 'cancelled';

    if (newPOStatus && po.rows[0].status !== newPOStatus) {
      await client.query('UPDATE purchase_orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newPOStatus, poId]);
    }

    // Log activity
    const repName = req.rep.first_name + ' ' + req.rep.last_name;
    await client.query(
      `INSERT INTO po_activity_log (purchase_order_id, action, details, performer_type, performer_id, performer_name)
       VALUES ($1, 'bulk_item_status_update', $2, 'rep', $3, $4)`,
      [poId, JSON.stringify({ status, derived_po_status: newPOStatus }), req.rep.id, repName]
    );

    await client.query('COMMIT');
    res.json({ success: true, derived_po_status: newPOStatus });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Rep update single PO item status
app.put('/api/rep/purchase-orders/:poId/items/:itemId/status', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { poId, itemId } = req.params;
    const { status } = req.body;
    const validStatuses = ['pending', 'ordered', 'shipped', 'received', 'cancelled'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status. Allowed: ' + validStatuses.join(', ') });

    const po = await client.query('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
    if (!po.rows.length) return res.status(404).json({ error: 'Purchase order not found' });

    await client.query('BEGIN');

    const item = await client.query('SELECT * FROM purchase_order_items WHERE id = $1 AND purchase_order_id = $2', [itemId, poId]);
    if (!item.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'PO item not found' }); }

    await client.query('UPDATE purchase_order_items SET status = $1 WHERE id = $2', [status, itemId]);

    // Auto-derive PO-level status
    const allItems = await client.query('SELECT status FROM purchase_order_items WHERE purchase_order_id = $1', [poId]);
    const statuses = allItems.rows.map(r => r.status);
    let newPOStatus = null;
    if (statuses.length > 0 && statuses.every(s => s === 'received')) newPOStatus = 'fulfilled';
    else if (statuses.length > 0 && statuses.every(s => s === 'cancelled')) newPOStatus = 'cancelled';

    if (newPOStatus && po.rows[0].status !== newPOStatus) {
      await client.query('UPDATE purchase_orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newPOStatus, poId]);
    }

    // Log activity
    const repName = req.rep.first_name + ' ' + req.rep.last_name;
    await client.query(
      `INSERT INTO po_activity_log (purchase_order_id, action, details, performer_type, performer_id, performer_name)
       VALUES ($1, 'item_status_update', $2, 'rep', $3, $4)`,
      [poId, JSON.stringify({ item_id: itemId, status, derived_po_status: newPOStatus }), req.rep.id, repName]
    );

    await client.query('COMMIT');
    res.json({ success: true, derived_po_status: newPOStatus });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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
    const poCheck = await pool.query(`
      SELECT po.*, v.name as vendor_name, v.email as vendor_email
      FROM purchase_orders po
      JOIN vendors v ON v.id = po.vendor_id
      WHERE po.id = $1
    `, [poId]);
    if (!poCheck.rows.length) return res.status(404).json({ error: 'Purchase order not found' });
    if (poCheck.rows[0].status !== 'draft') {
      return res.status(400).json({ error: 'Only draft POs can be approved' });
    }

    const po = poCheck.rows[0];
    const newRevision = (po.revision || 0) + 1;
    const isRevised = newRevision > 1;

    const result = await pool.query(`
      UPDATE purchase_orders SET status = 'sent', revision = $1, is_revised = $2,
        approved_by = $3, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $4 RETURNING *
    `, [newRevision, isRevised, req.rep.id, poId]);

    const repName = req.rep.first_name + ' ' + req.rep.last_name;
    let emailSent = false;

    // Send email if vendor has email
    if (po.vendor_email) {
      try {
        const poData = await generatePOHtml(poId);
        if (poData) {
          const pdfBuffer = await generatePDFBuffer(poData.html);
          const emailResult = await sendPurchaseOrderToVendor({
            vendor_email: po.vendor_email,
            vendor_name: po.vendor_name,
            po_number: po.po_number,
            is_revised: isRevised,
            pdf_buffer: pdfBuffer
          });
          emailSent = emailResult.sent;
        }
      } catch (emailErr) {
        console.error('[Rep PO Approve] Email send failed:', emailErr.message);
      }
    }

    // Log activity
    const action = isRevised ? 'revised_and_sent' : 'sent';
    await pool.query(
      `INSERT INTO po_activity_log (purchase_order_id, action, performed_by, performer_name, recipient_email, revision, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [poId, action, req.rep.id, repName, po.vendor_email || null, newRevision,
       JSON.stringify({ email_sent: emailSent, approved_via: 'rep_portal' })]
    );

    res.json({ purchase_order: result.rows[0], email_sent: emailSent });
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

app.post('/api/rep/promo-codes/validate', repAuth, async (req, res) => {
  try {
    const { code, items, customer_email } = req.body;
    if (!code) return res.status(400).json({ valid: false, error: 'Code is required' });
    if (!items || items.length === 0) return res.json({ valid: false, error: 'No items provided' });

    // Look up category_id for each item's product_id
    const enrichedItems = [];
    for (const item of items) {
      let category_id = item.category_id || null;
      if (!category_id && item.product_id) {
        const pResult = await pool.query('SELECT category_id FROM products WHERE id = $1', [item.product_id]);
        if (pResult.rows.length > 0) category_id = pResult.rows[0].category_id;
      }
      enrichedItems.push({
        product_id: item.product_id,
        category_id,
        subtotal: item.subtotal,
        is_sample: item.is_sample || false
      });
    }

    const result = await calculatePromoDiscount(code, enrichedItems, customer_email || null);
    if (!result.valid) return res.json({ valid: false, error: result.error });

    res.json({
      valid: true,
      code: result.promo.code,
      discount_type: result.promo.discount_type,
      discount_value: parseFloat(result.promo.discount_value),
      discount_amount: result.discount_amount,
      description: result.promo.description || ''
    });
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message });
  }
});

app.post('/api/rep/quotes', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { customer_name, customer_email, phone, shipping_address_line1, shipping_address_line2,
            shipping_city, shipping_state, shipping_zip, notes, items, delivery_method, promo_code } = req.body;
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

      // Validate promo code if provided
      let discountAmount = 0;
      let promoCodeId = null;
      let promoCodeStr = null;
      if (promo_code) {
        const promoItems = items.map(i => ({
          product_id: i.product_id,
          category_id: i.category_id || null,
          subtotal: i.subtotal,
          is_sample: i.is_sample || false
        }));
        // Enrich items with category_id
        for (const pi of promoItems) {
          if (!pi.category_id && pi.product_id) {
            const pResult = await client.query('SELECT category_id FROM products WHERE id = $1', [pi.product_id]);
            if (pResult.rows.length > 0) pi.category_id = pResult.rows[0].category_id;
          }
        }
        const promoResult = await calculatePromoDiscount(promo_code, promoItems, customer_email, client);
        if (promoResult.valid) {
          discountAmount = promoResult.discount_amount;
          promoCodeId = promoResult.promo.id;
          promoCodeStr = promoResult.promo.code;
        }
      }

      const total = subtotal - discountAmount;
      await client.query(
        'UPDATE quotes SET subtotal = $1, total = $2, promo_code_id = $3, promo_code = $4, discount_amount = $5 WHERE id = $6',
        [subtotal.toFixed(2), total.toFixed(2), promoCodeId, promoCodeStr, discountAmount.toFixed(2), quote.id]
      );

      // Record promo usage
      if (promoCodeId && discountAmount > 0) {
        await client.query(
          'INSERT INTO promo_code_usages (promo_code_id, quote_id, customer_email, discount_amount) VALUES ($1, $2, $3, $4)',
          [promoCodeId, quote.id, customer_email.toLowerCase().trim(), discountAmount.toFixed(2)]
        );
      }
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
            shipping_city, shipping_state, shipping_zip, notes, shipping, delivery_method, promo_code } = req.body;

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

    const q = result.rows[0];

    // Handle promo code update
    let discountAmount = parseFloat(q.discount_amount || 0);
    let promoCodeId = q.promo_code_id;
    let promoCodeStr = q.promo_code;

    if (promo_code !== undefined) {
      if (promo_code === '' || promo_code === null) {
        // Remove promo
        discountAmount = 0;
        promoCodeId = null;
        promoCodeStr = null;
        await pool.query('DELETE FROM promo_code_usages WHERE quote_id = $1', [id]);
      } else {
        // Validate new promo code against current items
        const itemsResult = await pool.query('SELECT qi.*, p.category_id FROM quote_items qi LEFT JOIN products p ON p.id = qi.product_id WHERE qi.quote_id = $1', [id]);
        const promoItems = itemsResult.rows.map(i => ({
          product_id: i.product_id,
          category_id: i.category_id,
          subtotal: i.subtotal,
          is_sample: i.is_sample
        }));
        const promoResult = await calculatePromoDiscount(promo_code, promoItems, q.customer_email);
        if (promoResult.valid) {
          discountAmount = promoResult.discount_amount;
          promoCodeId = promoResult.promo.id;
          promoCodeStr = promoResult.promo.code;
          // Upsert usage
          await pool.query('DELETE FROM promo_code_usages WHERE quote_id = $1', [id]);
          if (discountAmount > 0) {
            await pool.query(
              'INSERT INTO promo_code_usages (promo_code_id, quote_id, customer_email, discount_amount) VALUES ($1, $2, $3, $4)',
              [promoCodeId, id, q.customer_email, discountAmount.toFixed(2)]
            );
          }
        }
      }
      await pool.query(
        'UPDATE quotes SET promo_code_id = $1, promo_code = $2, discount_amount = $3 WHERE id = $4',
        [promoCodeId, promoCodeStr, discountAmount.toFixed(2), id]
      );
    }

    // Recalculate total
    const total = parseFloat((parseFloat(q.subtotal || 0) + parseFloat(q.shipping || 0) - discountAmount).toFixed(2));
    await pool.query('UPDATE quotes SET total = $1 WHERE id = $2', [total.toFixed(2), id]);
    q.total = total.toFixed(2);
    q.discount_amount = discountAmount.toFixed(2);
    q.promo_code_id = promoCodeId;
    q.promo_code = promoCodeStr;

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

    // Send email and report delivery status
    const emailData = {
      ...q,
      items: quoteItems.rows,
      rep_first_name: req.rep.first_name,
      rep_last_name: req.rep.last_name,
      rep_email: req.rep.email
    };
    const emailResult = await sendQuoteSent(emailData);
    const emailed = emailResult && emailResult.sent;

    if (emailed) {
      res.json({ success: true, message: 'Quote emailed to ' + q.customer_email, emailed: true });
    } else {
      res.json({ success: true, message: 'Quote marked as sent (email not configured)', emailed: false });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rep/quotes/:id/preview', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const quote = await pool.query('SELECT * FROM quotes WHERE id = $1', [id]);
    if (!quote.rows.length) return res.status(404).json({ error: 'Quote not found' });

    const q = quote.rows[0];
    const quoteItems = await pool.query(
      'SELECT * FROM quote_items WHERE quote_id = $1 ORDER BY id', [id]
    );

    const emailData = {
      ...q,
      items: quoteItems.rows,
      rep_first_name: req.rep.first_name,
      rep_last_name: req.rep.last_name,
      rep_email: req.rep.email
    };

    const html = generateQuoteSentHTML(emailData);

    res.json({
      html,
      subject: `Your Custom Quote — ${q.quote_number}`,
      to: q.customer_email,
      reply_to: req.rep.email
    });
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

    // Copy promo code from quote to order
    const quotePromoCodeId = q.promo_code_id || null;
    const quotePromoCode = q.promo_code || null;
    const quoteDiscount = parseFloat(q.discount_amount || 0);

    const orderResult = await client.query(`
      INSERT INTO orders (order_number, customer_email, customer_name, phone,
        shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip,
        subtotal, shipping, total, status, sales_rep_id, payment_method, quote_id, stripe_payment_intent_id, delivery_method,
        promo_code_id, promo_code, discount_amount)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
      RETURNING *
    `, [orderNumber, q.customer_email, q.customer_name, q.phone,
        isPickupQuote ? null : (q.shipping_address_line1 || ''),
        isPickupQuote ? null : q.shipping_address_line2,
        isPickupQuote ? null : (q.shipping_city || ''),
        isPickupQuote ? null : (q.shipping_state || ''),
        isPickupQuote ? null : (q.shipping_zip || ''),
        q.subtotal, quoteShipping, quoteTotal, orderStatus, req.rep.id, payment_method, id, stripePaymentIntentId,
        q.delivery_method || 'shipping',
        quotePromoCodeId, quotePromoCode, quoteDiscount.toFixed(2)]);

    const order = orderResult.rows[0];

    // Copy quote items to order items
    for (const item of itemsResult.rows) {
      await client.query(`
        INSERT INTO order_items (order_id, product_id, sku_id, product_name, collection, description, sqft_needed, num_boxes, unit_price, subtotal, sell_by, is_sample)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [order.id, item.product_id, item.sku_id, item.product_name, item.collection,
          item.description, item.sqft_needed, item.num_boxes, item.unit_price, item.subtotal, item.sell_by, item.is_sample]);
    }

    // Record promo usage for the order (quote row stays for audit)
    if (quotePromoCodeId && quoteDiscount > 0) {
      await client.query(
        'INSERT INTO promo_code_usages (promo_code_id, order_id, customer_email, discount_amount) VALUES ($1, $2, $3, $4)',
        [quotePromoCodeId, order.id, q.customer_email, quoteDiscount.toFixed(2)]
      );
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

// ==================== Rep Customer Endpoints ====================

// GET /api/rep/customers — unified list (mirrors admin endpoint)
app.get('/api/rep/customers', repAuth, async (req, res) => {
  try {
    const { search, type = 'all', sort = 'last_order', dir = 'desc', page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50));

    const queries = [];

    // Retail customers
    if (type === 'all' || type === 'retail') {
      queries.push(pool.query(`
        SELECT c.id, c.first_name || ' ' || c.last_name as name, c.email, c.phone,
          'retail' as customer_type, c.created_at,
          COUNT(o.id)::int as order_count,
          COALESCE(SUM(o.total), 0) as total_spent,
          MAX(o.created_at) as last_order_date
        FROM customers c
        LEFT JOIN orders o ON o.customer_id = c.id
        GROUP BY c.id
      `));
    }

    // Guest customers
    if (type === 'all' || type === 'guest') {
      queries.push(pool.query(`
        SELECT 'guest_' || LOWER(o.customer_email) as id,
          (array_agg(o.customer_name ORDER BY o.created_at DESC))[1] as name,
          LOWER(o.customer_email) as email,
          (array_agg(o.phone ORDER BY o.created_at DESC))[1] as phone,
          'guest' as customer_type,
          MIN(o.created_at) as created_at,
          COUNT(o.id)::int as order_count,
          COALESCE(SUM(o.total), 0) as total_spent,
          MAX(o.created_at) as last_order_date
        FROM orders o
        WHERE o.customer_id IS NULL AND o.trade_customer_id IS NULL
          AND o.customer_email IS NOT NULL
        GROUP BY LOWER(o.customer_email)
      `));
    }

    // Trade customers
    if (type === 'all' || type === 'trade') {
      queries.push(pool.query(`
        SELECT tc.id, tc.contact_name as name, tc.email, tc.phone,
          'trade' as customer_type, tc.created_at,
          COUNT(o.id)::int as order_count,
          COALESCE(SUM(o.total), 0) as total_spent,
          MAX(o.created_at) as last_order_date,
          tc.company_name, mt.name as tier_name, tc.status as trade_status
        FROM trade_customers tc
        LEFT JOIN orders o ON o.trade_customer_id = tc.id
        LEFT JOIN margin_tiers mt ON mt.id = tc.margin_tier_id
        GROUP BY tc.id, mt.name
      `));
    }

    const results = await Promise.all(queries);
    let all = [];
    for (const r of results) {
      all = all.concat(r.rows);
    }

    // Prefix IDs for retail/trade (guest already prefixed in query)
    all = all.map(c => {
      if (c.customer_type === 'retail') c.id = 'retail_' + c.id;
      else if (c.customer_type === 'trade') c.id = 'trade_' + c.id;
      c.total_spent = parseFloat(c.total_spent) || 0;
      return c;
    });

    // Search filter
    if (search) {
      const s = search.toLowerCase();
      all = all.filter(c =>
        (c.name && c.name.toLowerCase().includes(s)) ||
        (c.email && c.email.toLowerCase().includes(s)) ||
        (c.phone && c.phone.toLowerCase().includes(s)) ||
        (c.company_name && c.company_name.toLowerCase().includes(s))
      );
    }

    const total = all.length;

    // Sort
    const sortDir2 = (dir || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    const sortKey = sort || 'last_order';
    all.sort((a, b) => {
      let av, bv;
      switch (sortKey) {
        case 'name': av = (a.name || '').toLowerCase(); bv = (b.name || '').toLowerCase(); return av < bv ? -sortDir2 : av > bv ? sortDir2 : 0;
        case 'email': av = (a.email || '').toLowerCase(); bv = (b.email || '').toLowerCase(); return av < bv ? -sortDir2 : av > bv ? sortDir2 : 0;
        case 'orders': return (a.order_count - b.order_count) * sortDir2;
        case 'spent': return (a.total_spent - b.total_spent) * sortDir2;
        case 'created': av = new Date(a.created_at || 0).getTime(); bv = new Date(b.created_at || 0).getTime(); return (av - bv) * sortDir2;
        case 'last_order': default:
          av = a.last_order_date ? new Date(a.last_order_date).getTime() : 0;
          bv = b.last_order_date ? new Date(b.last_order_date).getTime() : 0;
          return (av - bv) * sortDir2;
      }
    });

    // Paginate
    const offset = (pageNum - 1) * limitNum;
    const customers = all.slice(offset, offset + limitNum);

    res.json({ customers, total, page: pageNum, limit: limitNum });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rep/customers/:id — detail view (mirrors admin endpoint)
app.get('/api/rep/customers/:id', repAuth, async (req, res) => {
  try {
    const { type } = req.query;
    const refId = req.params.id;
    if (!type || !['retail', 'guest', 'trade'].includes(type)) {
      return res.status(400).json({ error: 'type query param required (retail|guest|trade)' });
    }

    let customer, orders, noteRef;

    if (type === 'retail') {
      const cResult = await pool.query(`
        SELECT id, first_name, last_name, first_name || ' ' || last_name as name, email, phone,
          address_line1, address_line2, city, state, zip, created_at
        FROM customers WHERE id = $1
      `, [refId]);
      if (!cResult.rows.length) return res.status(404).json({ error: 'Customer not found' });
      customer = cResult.rows[0];
      customer.customer_type = 'retail';
      noteRef = refId;

      const oResult = await pool.query(`
        SELECT o.*, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id)::int as item_count
        FROM orders o WHERE o.customer_id = $1 ORDER BY o.created_at DESC
      `, [refId]);
      orders = oResult.rows;

    } else if (type === 'trade') {
      const cResult = await pool.query(`
        SELECT tc.id, tc.email, tc.company_name, tc.contact_name, tc.contact_name as name,
          tc.phone, tc.status, tc.notes, tc.created_at, tc.updated_at, tc.business_type,
          tc.subscription_status, tc.subscription_expires_at, tc.total_spend,
          tc.address_line1, tc.city, tc.state, tc.zip, tc.contractor_license,
          mt.name as tier_name, mt.discount_percent,
          sa.first_name || ' ' || sa.last_name as rep_name
        FROM trade_customers tc
        LEFT JOIN margin_tiers mt ON mt.id = tc.margin_tier_id
        LEFT JOIN staff_accounts sa ON sa.id = tc.assigned_rep_id
        WHERE tc.id = $1
      `, [refId]);
      if (!cResult.rows.length) return res.status(404).json({ error: 'Trade customer not found' });
      customer = cResult.rows[0];
      customer.customer_type = 'trade';
      noteRef = refId;

      const oResult = await pool.query(`
        SELECT o.*, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id)::int as item_count
        FROM orders o WHERE o.trade_customer_id = $1 ORDER BY o.created_at DESC
      `, [refId]);
      orders = oResult.rows;

    } else {
      // Guest — refId is the email
      const email = refId.toLowerCase();
      const oResult = await pool.query(`
        SELECT o.*, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id)::int as item_count
        FROM orders o
        WHERE LOWER(o.customer_email) = $1 AND o.customer_id IS NULL AND o.trade_customer_id IS NULL
        ORDER BY o.created_at DESC
      `, [email]);
      orders = oResult.rows;
      if (!orders.length) return res.status(404).json({ error: 'No guest orders found for this email' });

      const latest = orders[0];
      customer = {
        customer_type: 'guest',
        name: latest.customer_name,
        email: latest.customer_email,
        phone: latest.phone,
        address_line1: latest.shipping_address_line1,
        address_line2: latest.shipping_address_line2,
        city: latest.shipping_city,
        state: latest.shipping_state,
        zip: latest.shipping_zip,
        created_at: orders[orders.length - 1].created_at
      };
      noteRef = email;
    }

    // Notes — join on sales_reps instead of staff_accounts for rep portal
    const notesResult = await pool.query(`
      SELECT cn.*, COALESCE(
        (SELECT sa.first_name || ' ' || sa.last_name FROM staff_accounts sa WHERE sa.id = cn.staff_id),
        (SELECT sr.first_name || ' ' || sr.last_name FROM sales_reps sr WHERE sr.id = cn.staff_id),
        'Staff'
      ) as staff_name
      FROM customer_notes cn
      WHERE cn.customer_type = $1 AND cn.customer_ref = $2
      ORDER BY cn.created_at DESC
    `, [type, noteRef]);

    // Stats — basic
    const totalOrders = orders.length;
    const totalSpent = orders.reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0);
    const avgOrderValue = totalOrders > 0 ? totalSpent / totalOrders : 0;
    const firstOrderDate = orders.length ? orders[orders.length - 1].created_at : null;
    const lastOrderDate = orders.length ? orders[0].created_at : null;

    // Stats — financial: open balance & available credit
    const openBalance = orders
      .filter(o => !['cancelled', 'refunded'].includes(o.status))
      .reduce((sum, o) => {
        const bal = (parseFloat(o.total) || 0) - (parseFloat(o.amount_paid) || 0);
        return sum + (bal > 0.01 ? bal : 0);
      }, 0);

    const availableCredit = orders
      .filter(o => !['cancelled', 'refunded'].includes(o.status))
      .reduce((sum, o) => {
        const over = (parseFloat(o.amount_paid) || 0) - (parseFloat(o.total) || 0);
        return sum + (over > 0.01 ? over : 0);
      }, 0);

    // Quotes & payment requests — run in parallel
    const orderIds = orders.map(o => o.id);

    const quotesPromise = (async () => {
      try {
        let quotesQuery, quotesParam;
        if (type === 'trade') {
          quotesQuery = `SELECT q.id, q.quote_number, q.total, q.status, q.expires_at, q.created_at,
            (SELECT COUNT(*)::int FROM quote_items qi WHERE qi.quote_id = q.id) as item_count
            FROM quotes q WHERE q.trade_customer_id = $1 AND q.status IN ('draft', 'sent')
            ORDER BY q.created_at DESC`;
          quotesParam = refId;
        } else {
          const email = (customer.email || '').toLowerCase();
          quotesQuery = `SELECT q.id, q.quote_number, q.total, q.status, q.expires_at, q.created_at,
            (SELECT COUNT(*)::int FROM quote_items qi WHERE qi.quote_id = q.id) as item_count
            FROM quotes q WHERE LOWER(q.customer_email) = $1 AND q.status IN ('draft', 'sent')
            ORDER BY q.created_at DESC`;
          quotesParam = email;
        }
        const result = await pool.query(quotesQuery, [quotesParam]);
        return result.rows;
      } catch (e) { return []; }
    })();

    const paymentReqPromise = (async () => {
      try {
        if (!orderIds.length) return [];
        const result = await pool.query(`
          SELECT pr.id, pr.order_id, pr.amount, pr.status, pr.sent_to_email, pr.expires_at, pr.created_at,
            o.order_number
          FROM payment_requests pr
          JOIN orders o ON o.id = pr.order_id
          WHERE pr.order_id = ANY($1::uuid[]) AND pr.status = 'pending'
          ORDER BY pr.created_at DESC
        `, [orderIds]);
        return result.rows;
      } catch (e) { return []; }
    })();

    const [quotes, paymentRequests] = await Promise.all([quotesPromise, paymentReqPromise]);

    const openQuotesCount = quotes.length;
    const openQuotesValue = quotes.reduce((sum, q) => sum + (parseFloat(q.total) || 0), 0);
    const pendingPaymentsCount = paymentRequests.length;
    const pendingPaymentsTotal = paymentRequests.reduce((sum, pr) => sum + (parseFloat(pr.amount) || 0), 0);

    res.json({
      customer,
      orders,
      notes: notesResult.rows,
      quotes,
      payment_requests: paymentRequests,
      stats: {
        total_orders: totalOrders, total_spent: totalSpent, avg_order_value: avgOrderValue,
        first_order_date: firstOrderDate, last_order_date: lastOrderDate,
        open_balance: openBalance, available_credit: availableCredit,
        open_quotes_count: openQuotesCount, open_quotes_value: openQuotesValue,
        pending_payments_count: pendingPaymentsCount, pending_payments_total: pendingPaymentsTotal
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rep/customers/:id/notes — add a note (mirrors admin endpoint)
app.post('/api/rep/customers/:id/notes', repAuth, async (req, res) => {
  try {
    const { customer_type, customer_ref, note } = req.body;
    if (!customer_type || !customer_ref || !note) {
      return res.status(400).json({ error: 'customer_type, customer_ref, and note are required' });
    }
    const result = await pool.query(`
      INSERT INTO customer_notes (customer_type, customer_ref, staff_id, note)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [customer_type, customer_ref, req.rep.id, note.trim()]);

    const newNote = result.rows[0];
    newNote.staff_name = req.rep.first_name + ' ' + req.rep.last_name;
    res.json({ note: newNote });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rep/customers/:id/timeline — unified activity feed
app.get('/api/rep/customers/:id/timeline', repAuth, async (req, res) => {
  try {
    const { type } = req.query;
    const refId = req.params.id;
    if (!type || !['retail', 'guest', 'trade'].includes(type)) {
      return res.status(400).json({ error: 'type query param required (retail|guest|trade)' });
    }

    // Resolve order IDs and email based on customer type
    let orderIds = [];
    let customerEmail = '';

    if (type === 'retail') {
      const oRes = await pool.query('SELECT id FROM orders WHERE customer_id = $1', [refId]);
      orderIds = oRes.rows.map(r => r.id);
      const cRes = await pool.query('SELECT email FROM customers WHERE id = $1', [refId]);
      customerEmail = cRes.rows.length ? cRes.rows[0].email.toLowerCase() : '';
    } else if (type === 'trade') {
      const oRes = await pool.query('SELECT id FROM orders WHERE trade_customer_id = $1', [refId]);
      orderIds = oRes.rows.map(r => r.id);
      const cRes = await pool.query('SELECT email FROM trade_customers WHERE id = $1', [refId]);
      customerEmail = cRes.rows.length ? cRes.rows[0].email.toLowerCase() : '';
    } else {
      const email = refId.toLowerCase();
      const oRes = await pool.query(
        'SELECT id FROM orders WHERE LOWER(customer_email) = $1 AND customer_id IS NULL AND trade_customer_id IS NULL',
        [email]
      );
      orderIds = oRes.rows.map(r => r.id);
      customerEmail = email;
    }

    const timeline = [];

    if (orderIds.length > 0) {
      // Orders placed
      const ordersRes = await pool.query(`
        SELECT id, order_number, total, status, created_at
        FROM orders WHERE id = ANY($1::uuid[])
      `, [orderIds]);
      for (const o of ordersRes.rows) {
        timeline.push({
          event_type: 'order_placed',
          entity_id: o.id,
          entity_type: 'order',
          title: 'Order ' + o.order_number + ' placed',
          description: '$' + parseFloat(o.total).toFixed(2) + ' — ' + o.status,
          timestamp: o.created_at
        });
      }

      // Status changes
      const statusRes = await pool.query(`
        SELECT oal.id, oal.order_id, oal.details, oal.performer_name, oal.created_at, o.order_number
        FROM order_activity_log oal
        JOIN orders o ON o.id = oal.order_id
        WHERE oal.order_id = ANY($1::uuid[]) AND oal.action = 'status_changed'
      `, [orderIds]);
      for (const s of statusRes.rows) {
        const details = s.details || {};
        timeline.push({
          event_type: 'status_change',
          entity_id: s.order_id,
          entity_type: 'order',
          title: 'Order ' + s.order_number + ': ' + (details.from || '?') + ' → ' + (details.to || '?'),
          description: s.performer_name ? 'by ' + s.performer_name : '',
          timestamp: s.created_at
        });
      }

      // Payments
      const payRes = await pool.query(`
        SELECT op.id, op.order_id, op.payment_type, op.amount, op.description, op.created_at, o.order_number
        FROM order_payments op
        JOIN orders o ON o.id = op.order_id
        WHERE op.order_id = ANY($1::uuid[]) AND op.status = 'completed'
      `, [orderIds]);
      for (const p of payRes.rows) {
        timeline.push({
          event_type: 'payment',
          entity_id: p.order_id,
          entity_type: 'order',
          title: (p.payment_type === 'refund' ? 'Refund' : 'Payment') + ' on ' + p.order_number,
          description: '$' + Math.abs(parseFloat(p.amount)).toFixed(2) + (p.description ? ' — ' + p.description : ''),
          timestamp: p.created_at
        });
      }

      // Samples
      const sampleRes = await pool.query(`
        SELECT oi.id, oi.product_name, oi.order_id, o.order_number, o.created_at
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE oi.is_sample = true AND oi.order_id = ANY($1::uuid[])
      `, [orderIds]);
      for (const s of sampleRes.rows) {
        timeline.push({
          event_type: 'sample_request',
          entity_id: s.order_id,
          entity_type: 'order',
          title: 'Sample requested: ' + (s.product_name || 'Unknown'),
          description: 'Order ' + s.order_number,
          timestamp: s.created_at
        });
      }
    }

    // Quotes
    if (customerEmail || type === 'trade') {
      let quotesRes;
      if (type === 'trade') {
        quotesRes = await pool.query(`
          SELECT id, quote_number, total, status, created_at
          FROM quotes WHERE trade_customer_id = $1
        `, [refId]);
      } else {
        quotesRes = await pool.query(`
          SELECT id, quote_number, total, status, created_at
          FROM quotes WHERE LOWER(customer_email) = $1 AND trade_customer_id IS NULL
        `, [customerEmail]);
      }
      for (const q of quotesRes.rows) {
        timeline.push({
          event_type: 'quote',
          entity_id: q.id,
          entity_type: 'quote',
          title: 'Quote ' + q.quote_number + ' — ' + q.status,
          description: '$' + parseFloat(q.total).toFixed(2),
          timestamp: q.created_at
        });
      }
    }

    // Notes
    const noteRef = type === 'guest' ? refId.toLowerCase() : refId;
    const notesRes = await pool.query(`
      SELECT cn.id, cn.note, cn.created_at,
        COALESCE(
          (SELECT sa.first_name || ' ' || sa.last_name FROM staff_accounts sa WHERE sa.id = cn.staff_id),
          (SELECT sr.first_name || ' ' || sr.last_name FROM sales_reps sr WHERE sr.id = cn.staff_id),
          'Staff'
        ) as staff_name
      FROM customer_notes cn
      WHERE cn.customer_type = $1 AND cn.customer_ref = $2
    `, [type, noteRef]);
    for (const n of notesRes.rows) {
      timeline.push({
        event_type: 'note',
        entity_id: n.id,
        entity_type: 'note',
        title: 'Note by ' + n.staff_name,
        description: n.note.length > 120 ? n.note.substring(0, 120) + '...' : n.note,
        timestamp: n.created_at
      });
    }

    // Showroom Visits
    if (customerEmail) {
      const visitsRes = await pool.query(`
        SELECT id, customer_name, status, sent_at, opened_at, items_carted_at, created_at,
          (SELECT COUNT(*)::int FROM showroom_visit_items WHERE visit_id = sv.id) as item_count
        FROM showroom_visits sv WHERE LOWER(customer_email) = $1 ORDER BY created_at DESC
      `, [customerEmail]);
      for (const v of visitsRes.rows) {
        const statusLabel = { draft: 'Draft', sent: 'Sent', opened: 'Opened', carted: 'Items Carted' };
        timeline.push({
          event_type: 'showroom_visit', entity_id: v.id, entity_type: 'visit',
          title: 'Showroom visit \u2014 ' + (statusLabel[v.status] || v.status),
          description: v.item_count + ' item' + (v.item_count !== 1 ? 's' : '') + (v.status === 'carted' ? ' \u2014 Customer added items to cart' : v.status === 'opened' ? ' \u2014 Customer viewed the visit' : ''),
          timestamp: v.items_carted_at || v.opened_at || v.sent_at || v.created_at
        });
      }
    }

    // Standalone Sample Requests
    if (customerEmail) {
      const srRes = await pool.query(`
        SELECT sr.id, sr.request_number, sr.status, sr.delivery_method,
          sr.shipped_at, sr.delivered_at, sr.created_at,
          (SELECT COUNT(*)::int FROM sample_request_items WHERE sample_request_id = sr.id) as item_count
        FROM sample_requests sr WHERE LOWER(customer_email) = $1 ORDER BY created_at DESC
      `, [customerEmail]);
      for (const s of srRes.rows) {
        timeline.push({
          event_type: 'standalone_sample', entity_id: s.id, entity_type: 'sample',
          title: 'Sample request ' + s.request_number + ' \u2014 ' + s.status,
          description: s.item_count + ' sample' + (s.item_count !== 1 ? 's' : '') + (s.delivery_method === 'pickup' ? ' \u2014 In-store pickup' : '') + (s.shipped_at ? ' \u2014 Shipped' : '') + (s.delivered_at ? ', Delivered' : ''),
          timestamp: s.delivered_at || s.shipped_at || s.created_at
        });
      }
    }

    // Installation Inquiries
    if (customerEmail) {
      const inquiryRes = await pool.query(`
        SELECT id, status, product_name, collection, estimated_sqft, created_at
        FROM installation_inquiries WHERE LOWER(customer_email) = $1 ORDER BY created_at DESC
      `, [customerEmail]);
      for (const inq of inquiryRes.rows) {
        const sqftText = inq.estimated_sqft ? ' \u2014 ' + parseFloat(inq.estimated_sqft).toFixed(0) + ' sqft' : '';
        timeline.push({
          event_type: 'installation_inquiry', entity_id: inq.id, entity_type: 'inquiry',
          title: 'Installation inquiry' + (inq.product_name ? ': ' + inq.product_name : ''),
          description: (inq.collection || '') + sqftText + (inq.status !== 'new' ? ' \u2014 ' + inq.status : ''),
          timestamp: inq.created_at
        });
      }
    }

    // Sort by timestamp desc, limit to 100
    timeline.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ timeline: timeline.slice(0, 100) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Rep Notification Endpoints ====================

app.get('/api/rep/notifications', repAuth, async (req, res) => {
  try {
    const { unread_only, limit: limitParam, offset: offsetParam } = req.query;
    const limit = Math.min(parseInt(limitParam) || 50, 100);
    const offset = parseInt(offsetParam) || 0;

    let query = 'SELECT * FROM rep_notifications WHERE rep_id = $1';
    const params = [req.rep.id];
    let idx = 2;

    if (unread_only === 'true') {
      query += ' AND is_read = false';
    }

    const countQuery = query.replace('SELECT *', 'SELECT COUNT(*)::int as total');
    const totalResult = await pool.query(countQuery, params);
    const total = totalResult.rows[0].total;

    const unreadResult = await pool.query(
      'SELECT COUNT(*)::int as cnt FROM rep_notifications WHERE rep_id = $1 AND is_read = false',
      [req.rep.id]
    );
    const unread_count = unreadResult.rows[0].cnt;

    query += ` ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    res.json({ notifications: result.rows, unread_count, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rep/notifications/count', repAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT COUNT(*)::int as unread_count FROM rep_notifications WHERE rep_id = $1 AND is_read = false',
      [req.rep.id]
    );
    res.json({ unread_count: result.rows[0].unread_count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rep/notifications/read-all', repAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE rep_notifications SET is_read = true WHERE rep_id = $1 AND is_read = false',
      [req.rep.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rep/notifications/:id/read', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      'UPDATE rep_notifications SET is_read = true WHERE id = $1 AND rep_id = $2',
      [id, req.rep.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Admin Promo Codes ====================

app.get('/api/admin/promo-codes', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pc.*,
        (SELECT COUNT(*)::int FROM promo_code_usages pcu WHERE pcu.promo_code_id = pc.id AND pcu.order_id IS NOT NULL) as usage_count
      FROM promo_codes pc
      ORDER BY pc.created_at DESC
    `);
    res.json({ promo_codes: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/promo-codes', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { code, description, discount_type, discount_value, min_order_amount,
            max_uses, max_uses_per_customer, restricted_category_ids, restricted_product_ids,
            is_active, expires_at } = req.body;

    if (!code || !code.trim()) return res.status(400).json({ error: 'Code is required' });
    if (!discount_type || !['percent', 'fixed'].includes(discount_type)) return res.status(400).json({ error: 'Discount type must be percent or fixed' });
    if (!discount_value || parseFloat(discount_value) <= 0) return res.status(400).json({ error: 'Discount value must be greater than 0' });
    if (discount_type === 'percent' && parseFloat(discount_value) > 100) return res.status(400).json({ error: 'Percentage discount cannot exceed 100%' });

    const result = await pool.query(`
      INSERT INTO promo_codes (code, description, discount_type, discount_value, min_order_amount,
        max_uses, max_uses_per_customer, restricted_category_ids, restricted_product_ids,
        is_active, expires_at, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `, [code.trim().toUpperCase(), description || null, discount_type, parseFloat(discount_value).toFixed(2),
        parseFloat(min_order_amount || 0).toFixed(2),
        max_uses || null, max_uses_per_customer || null,
        restricted_category_ids || '{}', restricted_product_ids || '{}',
        is_active !== false, expires_at || null, req.staff.id]);

    await logAudit(req.staff.id, 'create_promo_code', 'promo_code', result.rows[0].id, { code: result.rows[0].code }, req.ip);
    res.json({ promo_code: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'A promo code with this code already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/promo-codes/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { code, description, discount_type, discount_value, min_order_amount,
            max_uses, max_uses_per_customer, restricted_category_ids, restricted_product_ids,
            is_active, expires_at } = req.body;

    if (discount_type && !['percent', 'fixed'].includes(discount_type)) return res.status(400).json({ error: 'Discount type must be percent or fixed' });
    if (discount_value !== undefined && parseFloat(discount_value) <= 0) return res.status(400).json({ error: 'Discount value must be greater than 0' });
    if (discount_type === 'percent' && discount_value !== undefined && parseFloat(discount_value) > 100) return res.status(400).json({ error: 'Percentage discount cannot exceed 100%' });

    const result = await pool.query(`
      UPDATE promo_codes SET
        code = COALESCE($1, code),
        description = $2,
        discount_type = COALESCE($3, discount_type),
        discount_value = COALESCE($4, discount_value),
        min_order_amount = COALESCE($5, min_order_amount),
        max_uses = $6,
        max_uses_per_customer = $7,
        restricted_category_ids = COALESCE($8, restricted_category_ids),
        restricted_product_ids = COALESCE($9, restricted_product_ids),
        is_active = COALESCE($10, is_active),
        expires_at = $11,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $12
      RETURNING *
    `, [code ? code.trim().toUpperCase() : null, description !== undefined ? description : null,
        discount_type, discount_value ? parseFloat(discount_value).toFixed(2) : null,
        min_order_amount !== undefined ? parseFloat(min_order_amount || 0).toFixed(2) : null,
        max_uses !== undefined ? (max_uses || null) : undefined,
        max_uses_per_customer !== undefined ? (max_uses_per_customer || null) : undefined,
        restricted_category_ids || null, restricted_product_ids || null,
        is_active, expires_at !== undefined ? (expires_at || null) : undefined,
        id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Promo code not found' });

    await logAudit(req.staff.id, 'update_promo_code', 'promo_code', id, { code: result.rows[0].code }, req.ip);
    res.json({ promo_code: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'A promo code with this code already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/promo-codes/:id/toggle', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE promo_codes SET is_active = NOT is_active, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
      [id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Promo code not found' });
    await logAudit(req.staff.id, 'toggle_promo_code', 'promo_code', id, { is_active: result.rows[0].is_active }, req.ip);
    res.json({ promo_code: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/promo-codes/:id/usages', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT pcu.*, o.order_number, q.quote_number
      FROM promo_code_usages pcu
      LEFT JOIN orders o ON o.id = pcu.order_id
      LEFT JOIN quotes q ON q.id = pcu.quote_id
      WHERE pcu.promo_code_id = $1
      ORDER BY pcu.created_at DESC
    `, [id]);
    res.json({ usages: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin assign any rep to order
app.put('/api/admin/orders/:id/assign', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { sales_rep_id } = req.body;
    const result = await pool.query(
      'UPDATE orders SET sales_rep_id = $1 WHERE id = $2 RETURNING *',
      [sales_rep_id || null, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Order not found' });
    if (sales_rep_id) {
      const rep = await pool.query('SELECT first_name, last_name FROM staff_accounts WHERE id = $1', [sales_rep_id]);
      const repName = rep.rows.length ? rep.rows[0].first_name + ' ' + rep.rows[0].last_name : 'Unknown';
      await logOrderActivity(pool, id, 'rep_assigned', req.staff.id, req.staff.first_name + ' ' + req.staff.last_name,
        { rep_name: repName });
    } else {
      await logOrderActivity(pool, id, 'rep_assigned', req.staff.id, req.staff.first_name + ' ' + req.staff.last_name,
        { unassigned: true });
    }
    res.json({ order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Order activity log (admin)
app.get('/api/admin/orders/:id/activity', staffAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM order_activity_log WHERE order_id = $1 ORDER BY created_at DESC',
      [id]
    );
    res.json({ activity: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Admin Purchase Order Endpoints ====================

// List POs for an order (admin)
app.get('/api/admin/orders/:id/purchase-orders', staffAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const pos = await pool.query(`
      SELECT po.*, v.name as vendor_name, v.code as vendor_code, v.edi_config,
        sr.first_name || ' ' || sr.last_name as approved_by_name
      FROM purchase_orders po
      JOIN vendors v ON v.id = po.vendor_id
      LEFT JOIN staff_accounts sr ON sr.id = po.approved_by
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

// Update PO status (with revert support and revision tracking)
app.put('/api/admin/purchase-orders/:poId/status', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { poId } = req.params;
    const { status } = req.body;

    const validTransitions = {
      draft: ['sent'],
      sent: ['acknowledged', 'draft'],
      acknowledged: ['fulfilled', 'sent'],
      fulfilled: ['acknowledged'],
    };

    const po = await pool.query('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
    if (!po.rows.length) return res.status(404).json({ error: 'Purchase order not found' });

    const current = po.rows[0].status;
    const allowed = validTransitions[current] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `Cannot transition from ${current} to ${status}. Allowed: ${allowed.join(', ')}` });
    }

    let extraSets = '';
    const params = [status, poId];

    // When reverting to draft, clear approval
    if (status === 'draft') {
      extraSets = ', approved_by = NULL, approved_at = NULL';
    }

    // When transitioning draft→sent, increment revision and mark revised if re-sent
    if (current === 'draft' && status === 'sent') {
      const newRevision = (po.rows[0].revision || 0) + 1;
      const isRevised = newRevision > 1;
      extraSets = `, revision = ${newRevision}, is_revised = ${isRevised}, approved_by = $3, approved_at = CURRENT_TIMESTAMP`;
      params.push(req.staff.id);
    }

    const result = await pool.query(
      `UPDATE purchase_orders SET status = $1, updated_at = CURRENT_TIMESTAMP${extraSets} WHERE id = $2 RETURNING *`,
      params
    );

    // Log status change to activity log
    const actionMap = { sent: 'sent', acknowledged: 'acknowledged', fulfilled: 'fulfilled', cancelled: 'cancelled', draft: 'reverted' };
    const action = actionMap[status] || status;
    const staffName = req.staff.first_name + ' ' + req.staff.last_name;
    await pool.query(
      `INSERT INTO po_activity_log (purchase_order_id, action, performed_by, performer_name, revision, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [poId, action, req.staff.id, staffName, result.rows[0].revision || 0, JSON.stringify({ from_status: current, to_status: status })]
    );

    res.json({ purchase_order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin update PO notes
app.put('/api/admin/purchase-orders/:poId', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { poId } = req.params;
    const { notes } = req.body;
    const po = await pool.query('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
    if (!po.rows.length) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.rows[0].status !== 'draft') return res.status(400).json({ error: 'Only draft POs can be edited' });
    const result = await pool.query(
      'UPDATE purchase_orders SET notes = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [notes || null, poId]
    );
    res.json({ purchase_order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send PO to vendor via EDI (if configured) or email
app.post('/api/admin/purchase-orders/:poId/send', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { poId } = req.params;

    // Fetch PO with vendor email and EDI config
    const poResult = await pool.query(`
      SELECT po.*, v.name as vendor_name, v.email as vendor_email, v.edi_config
      FROM purchase_orders po
      JOIN vendors v ON v.id = po.vendor_id
      WHERE po.id = $1
    `, [poId]);
    if (!poResult.rows.length) return res.status(404).json({ error: 'Purchase order not found' });
    const po = poResult.rows[0];

    const ediConfig = po.edi_config;
    const ediEnabled = ediConfig && ediConfig.enabled;

    if (!ediEnabled && !po.vendor_email) {
      return res.status(400).json({ error: 'Vendor has no email configured and EDI is not enabled. Edit the vendor to add an email address.' });
    }

    if (!['draft', 'sent'].includes(po.status)) {
      return res.status(400).json({ error: 'Only draft or sent POs can be sent to vendors' });
    }

    let action = 'sent';
    const staffName = req.staff.first_name + ' ' + req.staff.last_name;

    if (po.status === 'draft') {
      const newRevision = (po.revision || 0) + 1;
      const isRevised = newRevision > 1;
      await pool.query(`
        UPDATE purchase_orders SET status = 'sent', revision = $1, is_revised = $2,
          approved_by = $3, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = $4
      `, [newRevision, isRevised, req.staff.id, poId]);
      action = isRevised ? 'revised_and_sent' : 'sent';
    } else {
      action = 'resent';
    }

    let sentVia = 'email';
    let emailResult = { sent: false };
    let ediDetails = null;

    // EDI path: generate 850 and upload to SFTP
    if (ediEnabled) {
      let ediSuccess = false;
      try {
        const docs = await generate850(pool, poId, ediConfig);
        const sftp = await createSftpConnection(ediConfig);
        const inboxDir = ediConfig.inbox_dir || '/Inbox';

        try {
          for (const doc of docs) {
            // Record transaction
            const txnResult = await pool.query(
              `INSERT INTO edi_transactions
               (vendor_id, document_type, direction, filename, interchange_control_number, purchase_order_id, order_id, status, raw_content)
               VALUES ($1, '850', 'outbound', $2, $3, $4, $5, 'pending', $6)
               RETURNING id`,
              [po.vendor_id, doc.filename, doc.icn, poId, po.order_id, doc.content]
            );
            const txnId = txnResult.rows[0].id;

            // Upload to SFTP
            await uploadFile(sftp, `${inboxDir}/${doc.filename}`, doc.content);

            // Mark as sent
            await pool.query(
              `UPDATE edi_transactions SET status = 'sent', processed_at = CURRENT_TIMESTAMP WHERE id = $1`,
              [txnId]
            );

            // Store interchange ID on PO
            await pool.query(
              `UPDATE purchase_orders SET edi_interchange_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
              [poId, doc.icn]
            );
          }

          ediSuccess = true;
          sentVia = 'edi';
          ediDetails = { docs_sent: docs.length, filenames: docs.map(d => d.filename) };
          console.log(`[PO Send] EDI 850 sent for ${po.po_number}: ${docs.map(d => d.filename).join(', ')}`);
        } finally {
          try { await sftp.end(); } catch (_) {}
        }
      } catch (ediErr) {
        console.error(`[PO Send] EDI failed for ${po.po_number}, falling back to email:`, ediErr.message);
        ediDetails = { edi_error: ediErr.message, fallback: 'email' };
        // Fall through to email
      }

      if (ediSuccess) {
        // Log activity and return
        const updatedPO = await pool.query('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
        await pool.query(
          `INSERT INTO po_activity_log (purchase_order_id, action, performed_by, performer_name, revision, details)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [poId, 'edi_sent', req.staff.id, staffName, updatedPO.rows[0].revision || 0,
           JSON.stringify(ediDetails)]
        );
        return res.json({ purchase_order: updatedPO.rows[0], sent_via: 'edi', edi: ediDetails });
      }
    }

    // Email path (default or EDI fallback)
    if (!po.vendor_email) {
      return res.status(400).json({ error: 'EDI send failed and vendor has no email configured for fallback.' });
    }

    const poData = await generatePOHtml(poId);
    if (!poData) return res.status(404).json({ error: 'Purchase order not found' });

    const updatedData = await generatePOHtml(poId);
    let pdfBuffer;
    try {
      pdfBuffer = await generatePDFBuffer(updatedData.html);
    } catch (pdfErr) {
      console.error('[PO Send] PDF generation failed:', pdfErr.message);
      return res.status(500).json({ error: 'PDF generation failed. Puppeteer may not be available.' });
    }

    emailResult = await sendPurchaseOrderToVendor({
      vendor_email: po.vendor_email,
      vendor_name: po.vendor_name,
      po_number: po.po_number,
      is_revised: action === 'revised_and_sent',
      pdf_buffer: pdfBuffer
    });

    // Log activity
    const updatedPO = await pool.query('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
    await pool.query(
      `INSERT INTO po_activity_log (purchase_order_id, action, performed_by, performer_name, recipient_email, revision, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [poId, action, req.staff.id, staffName, po.vendor_email, updatedPO.rows[0].revision || 0,
       JSON.stringify({ email_sent: emailResult.sent, ...(ediDetails || {}) })]
    );

    res.json({ purchase_order: updatedPO.rows[0], sent_via: sentVia, email_sent: emailResult.sent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== EDI Admin Endpoints ====================

// List EDI transactions with filtering
app.get('/api/admin/edi/transactions', staffAuth, async (req, res) => {
  try {
    const { vendor_id, document_type, direction, status, limit = 50, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (vendor_id) { conditions.push(`et.vendor_id = $${paramIdx++}`); params.push(vendor_id); }
    if (document_type) { conditions.push(`et.document_type = $${paramIdx++}`); params.push(document_type); }
    if (direction) { conditions.push(`et.direction = $${paramIdx++}`); params.push(direction); }
    if (status) { conditions.push(`et.status = $${paramIdx++}`); params.push(status); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(`
      SELECT et.id, et.vendor_id, v.name as vendor_name, et.document_type, et.direction,
        et.filename, et.interchange_control_number, et.purchase_order_id, po.po_number,
        et.order_id, et.status, et.error_message, et.processed_at, et.created_at
      FROM edi_transactions et
      JOIN vendors v ON v.id = et.vendor_id
      LEFT JOIN purchase_orders po ON po.id = et.purchase_order_id
      ${where}
      ORDER BY et.created_at DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx}
    `, [...params, parseInt(limit), parseInt(offset)]);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM edi_transactions et ${where}`, params
    );

    res.json({ transactions: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single EDI transaction with raw content
app.get('/api/admin/edi/transactions/:id', staffAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT et.*, v.name as vendor_name, po.po_number
      FROM edi_transactions et
      JOIN vendors v ON v.id = et.vendor_id
      LEFT JOIN purchase_orders po ON po.id = et.purchase_order_id
      WHERE et.id = $1
    `, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'EDI transaction not found' });
    res.json({ transaction: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List EDI invoices
app.get('/api/admin/edi/invoices', staffAuth, async (req, res) => {
  try {
    const { vendor_id, status, limit = 50, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (vendor_id) { conditions.push(`ei.vendor_id = $${paramIdx++}`); params.push(vendor_id); }
    if (status) { conditions.push(`ei.status = $${paramIdx++}`); params.push(status); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(`
      SELECT ei.*, v.name as vendor_name, po.po_number
      FROM edi_invoices ei
      JOIN vendors v ON v.id = ei.vendor_id
      LEFT JOIN purchase_orders po ON po.id = ei.purchase_order_id
      ${where}
      ORDER BY ei.created_at DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx}
    `, [...params, parseInt(limit), parseInt(offset)]);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM edi_invoices ei ${where}`, params
    );

    res.json({ invoices: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single EDI invoice with line items
app.get('/api/admin/edi/invoices/:id', staffAuth, async (req, res) => {
  try {
    const invoiceResult = await pool.query(`
      SELECT ei.*, v.name as vendor_name, po.po_number
      FROM edi_invoices ei
      JOIN vendors v ON v.id = ei.vendor_id
      LEFT JOIN purchase_orders po ON po.id = ei.purchase_order_id
      WHERE ei.id = $1
    `, [req.params.id]);
    if (!invoiceResult.rows.length) return res.status(404).json({ error: 'EDI invoice not found' });

    const itemsResult = await pool.query(
      `SELECT * FROM edi_invoice_items WHERE edi_invoice_id = $1 ORDER BY line_number`,
      [req.params.id]
    );

    res.json({ invoice: invoiceResult.rows[0], items: itemsResult.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update EDI invoice status
app.put('/api/admin/edi/invoices/:id/status', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['pending', 'matched', 'approved', 'paid', 'disputed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Allowed: ' + validStatuses.join(', ') });
    }
    const result = await pool.query(
      `UPDATE edi_invoices SET status = $2 WHERE id = $1 RETURNING *`,
      [req.params.id, status]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'EDI invoice not found' });
    res.json({ invoice: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger immediate EDI poll for a vendor
app.post('/api/admin/edi/poll-now', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    // Find Shaw EDI poller vendor source
    const sourceResult = await pool.query(
      `SELECT vs.*, v.edi_config FROM vendor_sources vs
       JOIN vendors v ON v.id = vs.vendor_id
       WHERE vs.scraper_key = 'shaw-edi-poller' AND vs.is_active = true
       LIMIT 1`
    );
    if (!sourceResult.rows.length) {
      return res.status(404).json({ error: 'Shaw EDI poller source not found or inactive' });
    }
    const source = sourceResult.rows[0];

    // Dynamic import of poller
    const pollerModule = await import('./scrapers/shaw-edi-poller.js');

    // Create a job record
    const jobResult = await pool.query(
      `INSERT INTO scrape_jobs (vendor_source_id, status, started_at)
       VALUES ($1, 'running', CURRENT_TIMESTAMP) RETURNING id`,
      [source.id]
    );

    // Run poller asynchronously
    const jobId = jobResult.rows[0].id;
    pollerModule.run(pool, { id: jobId }, source).then(async (stats) => {
      await pool.query(
        `UPDATE scrape_jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
         products_found = $2, products_created = $3
         WHERE id = $1`,
        [jobId, stats.files_found || 0, stats.processed || 0]
      );
    }).catch(async (err) => {
      console.error('[EDI Poll Now] Error:', err.message);
      await pool.query(
        `UPDATE scrape_jobs SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error = $2 WHERE id = $1`,
        [jobId, err.message]
      );
    });

    res.json({ message: 'EDI poll triggered', job_id: jobId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get PO activity log
app.get('/api/admin/purchase-orders/:poId/activity', staffAuth, async (req, res) => {
  try {
    const { poId } = req.params;
    const result = await pool.query(
      'SELECT * FROM po_activity_log WHERE purchase_order_id = $1 ORDER BY created_at DESC',
      [poId]
    );
    res.json({ activity: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin bulk update PO item statuses (must be before :itemId routes)
app.put('/api/admin/purchase-orders/:poId/items/bulk-status', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { poId } = req.params;
    const { status } = req.body;
    const validStatuses = ['pending', 'ordered', 'shipped', 'received', 'cancelled'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status. Allowed: ' + validStatuses.join(', ') });

    const po = await client.query('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
    if (!po.rows.length) return res.status(404).json({ error: 'Purchase order not found' });

    await client.query('BEGIN');

    await client.query(
      `UPDATE purchase_order_items SET status = $1 WHERE purchase_order_id = $2 AND status NOT IN ('received', 'cancelled')`,
      [status, poId]
    );

    const allItems = await client.query('SELECT status FROM purchase_order_items WHERE purchase_order_id = $1', [poId]);
    const statuses = allItems.rows.map(r => r.status);
    let newPOStatus = null;
    if (statuses.length > 0 && statuses.every(s => s === 'received')) newPOStatus = 'fulfilled';
    else if (statuses.length > 0 && statuses.every(s => s === 'cancelled')) newPOStatus = 'cancelled';

    if (newPOStatus && po.rows[0].status !== newPOStatus) {
      await client.query('UPDATE purchase_orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newPOStatus, poId]);
    }

    await client.query('COMMIT');
    res.json({ success: true, derived_po_status: newPOStatus });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Admin edit cost/qty on draft PO item
app.put('/api/admin/purchase-orders/:poId/items/:itemId', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { poId, itemId } = req.params;
    const { cost, qty } = req.body;

    if (cost == null && qty == null) return res.status(400).json({ error: 'cost or qty is required' });

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

    const newCost = cost != null ? parseFloat(cost) : parseFloat(item.rows[0].cost);
    const newQty = qty != null ? parseInt(qty) : item.rows[0].qty;
    if (isNaN(newCost) || newCost < 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Invalid cost' }); }
    if (isNaN(newQty) || newQty < 1) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Invalid qty' }); }

    const itemSubtotal = newCost * newQty;
    await client.query(
      'UPDATE purchase_order_items SET cost = $1, qty = $2, subtotal = $3 WHERE id = $4',
      [newCost.toFixed(2), newQty, itemSubtotal.toFixed(2), itemId]
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

// Admin add line item to draft PO
app.post('/api/admin/purchase-orders/:poId/items', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { poId } = req.params;
    const { product_name, vendor_sku, description, qty, cost, sell_by } = req.body;

    if (!product_name || cost == null || qty == null) return res.status(400).json({ error: 'product_name, cost, and qty are required' });
    const parsedCost = parseFloat(cost);
    const parsedQty = parseInt(qty);
    if (isNaN(parsedCost) || parsedCost < 0) return res.status(400).json({ error: 'Invalid cost' });
    if (isNaN(parsedQty) || parsedQty < 1) return res.status(400).json({ error: 'Invalid qty' });

    const po = await client.query('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
    if (!po.rows.length) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.rows[0].status !== 'draft') return res.status(400).json({ error: 'Only draft POs can be edited' });

    await client.query('BEGIN');

    const subtotal = parsedCost * parsedQty;
    const itemResult = await client.query(
      `INSERT INTO purchase_order_items (purchase_order_id, product_name, vendor_sku, description, qty, sell_by, cost, original_cost, subtotal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8) RETURNING *`,
      [poId, product_name, vendor_sku || null, description || null, parsedQty, sell_by || 'sqft', parsedCost.toFixed(2), subtotal.toFixed(2)]
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
    res.json({ item: itemResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Admin delete line item from draft PO
app.delete('/api/admin/purchase-orders/:poId/items/:itemId', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { poId, itemId } = req.params;

    const po = await client.query('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
    if (!po.rows.length) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.rows[0].status !== 'draft') return res.status(400).json({ error: 'Only draft POs can be edited' });

    await client.query('BEGIN');

    const del = await client.query('DELETE FROM purchase_order_items WHERE id = $1 AND purchase_order_id = $2 RETURNING id', [itemId, poId]);
    if (!del.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'PO item not found' }); }

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

// Admin update single PO item status
app.put('/api/admin/purchase-orders/:poId/items/:itemId/status', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { poId, itemId } = req.params;
    const { status } = req.body;
    const validStatuses = ['pending', 'ordered', 'shipped', 'received', 'cancelled'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status. Allowed: ' + validStatuses.join(', ') });

    const po = await client.query('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
    if (!po.rows.length) return res.status(404).json({ error: 'Purchase order not found' });

    await client.query('BEGIN');

    const item = await client.query('SELECT * FROM purchase_order_items WHERE id = $1 AND purchase_order_id = $2', [itemId, poId]);
    if (!item.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'PO item not found' }); }

    await client.query('UPDATE purchase_order_items SET status = $1 WHERE id = $2', [status, itemId]);

    // Auto-derive PO-level status from item statuses
    const allItems = await client.query('SELECT status FROM purchase_order_items WHERE purchase_order_id = $1', [poId]);
    const statuses = allItems.rows.map(r => r.status);
    let newPOStatus = null;
    if (statuses.length > 0 && statuses.every(s => s === 'received')) newPOStatus = 'fulfilled';
    else if (statuses.length > 0 && statuses.every(s => s === 'cancelled')) newPOStatus = 'cancelled';

    if (newPOStatus && po.rows[0].status !== newPOStatus) {
      await client.query('UPDATE purchase_orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newPOStatus, poId]);
    }

    await client.query('COMMIT');
    res.json({ success: true, derived_po_status: newPOStatus });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PO Document PDF - accepts token from header or query param
app.get('/api/staff/purchase-orders/:id/pdf', async (req, res, next) => {
  if (!req.headers['x-staff-token'] && req.query.token) {
    req.headers['x-staff-token'] = req.query.token;
  }
  next();
}, staffAuth, async (req, res) => {
  try {
    const result = await generatePOHtml(req.params.id);
    if (!result) return res.status(404).json({ error: 'Purchase order not found' });
    await generatePDF(result.html, `PO-${result.po.po_number}.pdf`, req, res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Admin Trade Management ====================

// Margin Tiers CRUD
app.get('/api/admin/margin-tiers', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT mt.*, (SELECT COUNT(*)::int FROM trade_customers tc WHERE tc.margin_tier_id = mt.id) as customer_count
      FROM margin_tiers mt
      ORDER BY mt.discount_percent
    `);
    res.json({ tiers: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/margin-tiers', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { name, discount_percent } = req.body;
    if (!name || discount_percent == null) return res.status(400).json({ error: 'Name and discount_percent are required' });
    const result = await pool.query(
      'INSERT INTO margin_tiers (name, discount_percent) VALUES ($1, $2) RETURNING *',
      [name.trim(), discount_percent]
    );
    res.json({ tier: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A tier with this name already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/margin-tiers/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { name, discount_percent, is_active } = req.body;
    const result = await pool.query(
      `UPDATE margin_tiers SET name = COALESCE($1, name), discount_percent = COALESCE($2, discount_percent),
       is_active = COALESCE($3, is_active), updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *`,
      [name, discount_percent, is_active, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Tier not found' });
    res.json({ tier: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A tier with this name already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/margin-tiers/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const count = await pool.query('SELECT COUNT(*)::int as c FROM trade_customers WHERE margin_tier_id = $1', [req.params.id]);
    if (count.rows[0].c > 0) {
      return res.status(409).json({ error: `Cannot delete: ${count.rows[0].c} customer(s) assigned to this tier` });
    }
    const result = await pool.query('DELETE FROM margin_tiers WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Tier not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trade Customers Management
app.get('/api/admin/trade-customers', staffAuth, requireRole('admin', 'manager', 'sales_rep'), async (req, res) => {
  try {
    let query = `
      SELECT tc.*, mt.name as tier_name, mt.discount_percent,
        sa.first_name || ' ' || sa.last_name as rep_name
      FROM trade_customers tc
      LEFT JOIN margin_tiers mt ON mt.id = tc.margin_tier_id
      LEFT JOIN staff_accounts sa ON sa.id = tc.assigned_rep_id
    `;
    const params = [];
    if (req.query.status) {
      query += ' WHERE tc.status = $1';
      params.push(req.query.status);
    }
    query += ' ORDER BY tc.created_at DESC';
    const result = await pool.query(query, params);
    res.json({ customers: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/trade-customers/:id', staffAuth, requireRole('admin', 'manager', 'sales_rep'), async (req, res) => {
  try {
    const { status, margin_tier_id, notes } = req.body;
    const result = await pool.query(
      `UPDATE trade_customers SET status = COALESCE($1, status), margin_tier_id = COALESCE($2, margin_tier_id),
       notes = COALESCE($3, notes), updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *`,
      [status, margin_tier_id, notes, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Trade customer not found' });

    // Kill sessions if status changed to non-approved
    if (status && status !== 'approved') {
      await pool.query('DELETE FROM trade_sessions WHERE trade_customer_id = $1', [req.params.id]);
    }

    // Re-fetch with tier info
    const full = await pool.query(`
      SELECT tc.*, mt.name as tier_name, mt.discount_percent
      FROM trade_customers tc
      LEFT JOIN margin_tiers mt ON mt.id = tc.margin_tier_id
      WHERE tc.id = $1
    `, [req.params.id]);

    res.json({ customer: full.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/trade-customers/:id', staffAuth, requireRole('admin', 'manager', 'sales_rep'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM trade_customers WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Trade customer not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Admin Customers ====================

// GET /api/admin/customers — unified list
app.get('/api/admin/customers', staffAuth, requireRole('admin', 'manager', 'sales_rep'), async (req, res) => {
  try {
    const { search, type = 'all', sort = 'last_order', dir = 'desc', page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50));

    const queries = [];

    // Retail customers
    if (type === 'all' || type === 'retail') {
      queries.push(pool.query(`
        SELECT c.id, c.first_name || ' ' || c.last_name as name, c.email, c.phone,
          'retail' as customer_type, c.created_at,
          COUNT(o.id)::int as order_count,
          COALESCE(SUM(o.total), 0) as total_spent,
          MAX(o.created_at) as last_order_date
        FROM customers c
        LEFT JOIN orders o ON o.customer_id = c.id
        GROUP BY c.id
      `));
    }

    // Guest customers
    if (type === 'all' || type === 'guest') {
      queries.push(pool.query(`
        SELECT 'guest_' || LOWER(o.customer_email) as id,
          (array_agg(o.customer_name ORDER BY o.created_at DESC))[1] as name,
          LOWER(o.customer_email) as email,
          (array_agg(o.phone ORDER BY o.created_at DESC))[1] as phone,
          'guest' as customer_type,
          MIN(o.created_at) as created_at,
          COUNT(o.id)::int as order_count,
          COALESCE(SUM(o.total), 0) as total_spent,
          MAX(o.created_at) as last_order_date
        FROM orders o
        WHERE o.customer_id IS NULL AND o.trade_customer_id IS NULL
          AND o.customer_email IS NOT NULL
        GROUP BY LOWER(o.customer_email)
      `));
    }

    // Trade customers
    if (type === 'all' || type === 'trade') {
      queries.push(pool.query(`
        SELECT tc.id, tc.contact_name as name, tc.email, tc.phone,
          'trade' as customer_type, tc.created_at,
          COUNT(o.id)::int as order_count,
          COALESCE(SUM(o.total), 0) as total_spent,
          MAX(o.created_at) as last_order_date,
          tc.company_name, mt.name as tier_name, tc.status as trade_status
        FROM trade_customers tc
        LEFT JOIN orders o ON o.trade_customer_id = tc.id
        LEFT JOIN margin_tiers mt ON mt.id = tc.margin_tier_id
        GROUP BY tc.id, mt.name
      `));
    }

    const results = await Promise.all(queries);
    let all = [];
    for (const r of results) {
      all = all.concat(r.rows);
    }

    // Prefix IDs for retail/trade (guest already prefixed in query)
    all = all.map(c => {
      if (c.customer_type === 'retail') c.id = 'retail_' + c.id;
      else if (c.customer_type === 'trade') c.id = 'trade_' + c.id;
      c.total_spent = parseFloat(c.total_spent) || 0;
      return c;
    });

    // Search filter
    if (search) {
      const s = search.toLowerCase();
      all = all.filter(c =>
        (c.name && c.name.toLowerCase().includes(s)) ||
        (c.email && c.email.toLowerCase().includes(s)) ||
        (c.phone && c.phone.toLowerCase().includes(s)) ||
        (c.company_name && c.company_name.toLowerCase().includes(s))
      );
    }

    const total = all.length;

    // Sort
    const sortDir = (dir || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    const sortKey = sort || 'last_order';
    all.sort((a, b) => {
      let av, bv;
      switch (sortKey) {
        case 'name': av = (a.name || '').toLowerCase(); bv = (b.name || '').toLowerCase(); return av < bv ? -sortDir : av > bv ? sortDir : 0;
        case 'email': av = (a.email || '').toLowerCase(); bv = (b.email || '').toLowerCase(); return av < bv ? -sortDir : av > bv ? sortDir : 0;
        case 'orders': return (a.order_count - b.order_count) * sortDir;
        case 'spent': return (a.total_spent - b.total_spent) * sortDir;
        case 'created': av = new Date(a.created_at || 0).getTime(); bv = new Date(b.created_at || 0).getTime(); return (av - bv) * sortDir;
        case 'last_order': default:
          av = a.last_order_date ? new Date(a.last_order_date).getTime() : 0;
          bv = b.last_order_date ? new Date(b.last_order_date).getTime() : 0;
          return (av - bv) * sortDir;
      }
    });

    // Paginate
    const offset = (pageNum - 1) * limitNum;
    const customers = all.slice(offset, offset + limitNum);

    res.json({ customers, total, page: pageNum, limit: limitNum });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/customers/:id — detail view
app.get('/api/admin/customers/:id', staffAuth, requireRole('admin', 'manager', 'sales_rep'), async (req, res) => {
  try {
    const { type } = req.query;
    const refId = req.params.id;
    if (!type || !['retail', 'guest', 'trade'].includes(type)) {
      return res.status(400).json({ error: 'type query param required (retail|guest|trade)' });
    }

    let customer, orders, noteRef;

    if (type === 'retail') {
      const cResult = await pool.query(`
        SELECT id, first_name, last_name, first_name || ' ' || last_name as name, email, phone,
          address_line1, address_line2, city, state, zip, created_at
        FROM customers WHERE id = $1
      `, [refId]);
      if (!cResult.rows.length) return res.status(404).json({ error: 'Customer not found' });
      customer = cResult.rows[0];
      customer.customer_type = 'retail';
      noteRef = refId;

      const oResult = await pool.query(`
        SELECT o.*, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id)::int as item_count
        FROM orders o WHERE o.customer_id = $1 ORDER BY o.created_at DESC
      `, [refId]);
      orders = oResult.rows;

    } else if (type === 'trade') {
      const cResult = await pool.query(`
        SELECT tc.id, tc.email, tc.company_name, tc.contact_name, tc.contact_name as name,
          tc.phone, tc.status, tc.notes, tc.created_at, tc.updated_at, tc.business_type,
          tc.subscription_status, tc.subscription_expires_at, tc.total_spend,
          tc.address_line1, tc.city, tc.state, tc.zip, tc.contractor_license,
          mt.name as tier_name, mt.discount_percent,
          sa.first_name || ' ' || sa.last_name as rep_name
        FROM trade_customers tc
        LEFT JOIN margin_tiers mt ON mt.id = tc.margin_tier_id
        LEFT JOIN staff_accounts sa ON sa.id = tc.assigned_rep_id
        WHERE tc.id = $1
      `, [refId]);
      if (!cResult.rows.length) return res.status(404).json({ error: 'Trade customer not found' });
      customer = cResult.rows[0];
      customer.customer_type = 'trade';
      noteRef = refId;

      const oResult = await pool.query(`
        SELECT o.*, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id)::int as item_count
        FROM orders o WHERE o.trade_customer_id = $1 ORDER BY o.created_at DESC
      `, [refId]);
      orders = oResult.rows;

    } else {
      // Guest — refId is the email
      const email = refId.toLowerCase();
      const oResult = await pool.query(`
        SELECT o.*, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id)::int as item_count
        FROM orders o
        WHERE LOWER(o.customer_email) = $1 AND o.customer_id IS NULL AND o.trade_customer_id IS NULL
        ORDER BY o.created_at DESC
      `, [email]);
      orders = oResult.rows;
      if (!orders.length) return res.status(404).json({ error: 'No guest orders found for this email' });

      const latest = orders[0];
      customer = {
        customer_type: 'guest',
        name: latest.customer_name,
        email: latest.customer_email,
        phone: latest.phone,
        address_line1: latest.shipping_address_line1,
        address_line2: latest.shipping_address_line2,
        city: latest.shipping_city,
        state: latest.shipping_state,
        zip: latest.shipping_zip,
        created_at: orders[orders.length - 1].created_at
      };
      noteRef = email;
    }

    // Notes — COALESCE to resolve names from both staff_accounts and sales_reps
    const notesResult = await pool.query(`
      SELECT cn.*, COALESCE(
        (SELECT sa.first_name || ' ' || sa.last_name FROM staff_accounts sa WHERE sa.id = cn.staff_id),
        (SELECT sr.first_name || ' ' || sr.last_name FROM sales_reps sr WHERE sr.id = cn.staff_id),
        'Staff'
      ) as staff_name
      FROM customer_notes cn
      WHERE cn.customer_type = $1 AND cn.customer_ref = $2
      ORDER BY cn.created_at DESC
    `, [type, noteRef]);

    // Stats — basic
    const totalOrders = orders.length;
    const totalSpent = orders.reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0);
    const avgOrderValue = totalOrders > 0 ? totalSpent / totalOrders : 0;
    const firstOrderDate = orders.length ? orders[orders.length - 1].created_at : null;
    const lastOrderDate = orders.length ? orders[0].created_at : null;

    // Stats — financial: open balance & available credit (computed from orders)
    const openBalance = orders
      .filter(o => !['cancelled', 'refunded'].includes(o.status))
      .reduce((sum, o) => {
        const bal = (parseFloat(o.total) || 0) - (parseFloat(o.amount_paid) || 0);
        return sum + (bal > 0.01 ? bal : 0);
      }, 0);

    const availableCredit = orders
      .filter(o => !['cancelled', 'refunded'].includes(o.status))
      .reduce((sum, o) => {
        const over = (parseFloat(o.amount_paid) || 0) - (parseFloat(o.total) || 0);
        return sum + (over > 0.01 ? over : 0);
      }, 0);

    // Quotes & payment requests — run in parallel
    const orderIds = orders.map(o => o.id);

    const quotesPromise = (async () => {
      try {
        let quotesQuery, quotesParam;
        if (type === 'trade') {
          quotesQuery = `SELECT q.id, q.quote_number, q.total, q.status, q.expires_at, q.created_at,
            (SELECT COUNT(*)::int FROM quote_items qi WHERE qi.quote_id = q.id) as item_count
            FROM quotes q WHERE q.trade_customer_id = $1 AND q.status IN ('draft', 'sent')
            ORDER BY q.created_at DESC`;
          quotesParam = refId;
        } else {
          const email = (customer.email || '').toLowerCase();
          quotesQuery = `SELECT q.id, q.quote_number, q.total, q.status, q.expires_at, q.created_at,
            (SELECT COUNT(*)::int FROM quote_items qi WHERE qi.quote_id = q.id) as item_count
            FROM quotes q WHERE LOWER(q.customer_email) = $1 AND q.status IN ('draft', 'sent')
            ORDER BY q.created_at DESC`;
          quotesParam = email;
        }
        const result = await pool.query(quotesQuery, [quotesParam]);
        return result.rows;
      } catch (e) { return []; }
    })();

    const paymentReqPromise = (async () => {
      try {
        if (!orderIds.length) return [];
        const result = await pool.query(`
          SELECT pr.id, pr.order_id, pr.amount, pr.status, pr.sent_to_email, pr.expires_at, pr.created_at,
            o.order_number
          FROM payment_requests pr
          JOIN orders o ON o.id = pr.order_id
          WHERE pr.order_id = ANY($1::uuid[]) AND pr.status = 'pending'
          ORDER BY pr.created_at DESC
        `, [orderIds]);
        return result.rows;
      } catch (e) { return []; }
    })();

    const [quotes, paymentRequests] = await Promise.all([quotesPromise, paymentReqPromise]);

    const openQuotesCount = quotes.length;
    const openQuotesValue = quotes.reduce((sum, q) => sum + (parseFloat(q.total) || 0), 0);
    const pendingPaymentsCount = paymentRequests.length;
    const pendingPaymentsTotal = paymentRequests.reduce((sum, pr) => sum + (parseFloat(pr.amount) || 0), 0);

    res.json({
      customer,
      orders,
      notes: notesResult.rows,
      quotes,
      payment_requests: paymentRequests,
      stats: {
        total_orders: totalOrders, total_spent: totalSpent, avg_order_value: avgOrderValue,
        first_order_date: firstOrderDate, last_order_date: lastOrderDate,
        open_balance: openBalance, available_credit: availableCredit,
        open_quotes_count: openQuotesCount, open_quotes_value: openQuotesValue,
        pending_payments_count: pendingPaymentsCount, pending_payments_total: pendingPaymentsTotal
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/customers/:id/notes — add a note
app.post('/api/admin/customers/:id/notes', staffAuth, requireRole('admin', 'manager', 'sales_rep'), async (req, res) => {
  try {
    const { customer_type, customer_ref, note } = req.body;
    if (!customer_type || !customer_ref || !note) {
      return res.status(400).json({ error: 'customer_type, customer_ref, and note are required' });
    }
    const result = await pool.query(`
      INSERT INTO customer_notes (customer_type, customer_ref, staff_id, note)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [customer_type, customer_ref, req.staff.id, note.trim()]);

    const newNote = result.rows[0];
    newNote.staff_name = req.staff.first_name + ' ' + req.staff.last_name;
    res.json({ note: newNote });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Scheduler Init ====================

const scheduledTasks = new Map();

/**
 * Register or update the cron task for a single vendor source.
 * Called on startup (initScheduler) and when a source is updated via PUT.
 */
function rescheduleSource(source) {
  // Cancel existing task for this source
  const existing = scheduledTasks.get(source.id);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(source.id);
    console.log(`[Scheduler] Cancelled existing schedule for "${source.name}"`);
  }

  // Register new schedule if active + has valid cron + has scraper_key
  if (source.is_active && source.schedule && source.scraper_key && cron.validate(source.schedule)) {
    const task = cron.schedule(source.schedule, () => {
      console.log(`[Scheduler] Scheduled scrape starting for: ${source.name}`);
      runScraper(source).catch(err => console.error(`[Scheduler] Scheduled scrape failed for ${source.name}:`, err.message));
    });
    scheduledTasks.set(source.id, task);
    console.log(`[Scheduler] Registered "${source.name}": ${source.schedule}`);
  }
}

async function initScheduler() {
  try {
    const result = await pool.query(
      'SELECT * FROM vendor_sources WHERE is_active = true AND schedule IS NOT NULL'
    );
    for (const source of result.rows) {
      rescheduleSource(source);
    }
    console.log(`[Scheduler] Initialized ${scheduledTasks.size} scheduled scraper(s)`);
  } catch (err) {
    // Tables may not exist yet on first run
    console.log('[Scheduler] Init skipped (tables may not exist yet):', err.message);
  }
}

// --- Stale job reaper: mark stuck jobs as failed every 15 minutes ---
const STALE_JOB_HOURS = parseInt(process.env.STALE_JOB_HOURS || '4', 10);

cron.schedule('*/15 * * * *', async () => {
  try {
    const result = await pool.query(`
      UPDATE scrape_jobs SET
        status = 'failed',
        completed_at = CURRENT_TIMESTAMP,
        errors = errors || $1::jsonb
      WHERE status = 'running'
        AND started_at < NOW() - INTERVAL '1 hour' * $2
      RETURNING id, vendor_source_id, started_at
    `, [
      JSON.stringify([{ message: `Reaped: job exceeded ${STALE_JOB_HOURS}h time limit`, time: new Date().toISOString() }]),
      STALE_JOB_HOURS
    ]);

    if (result.rows.length > 0) {
      console.log(`[Reaper] Marked ${result.rows.length} stale job(s) as failed`);
      for (const stale of result.rows) {
        // Look up source name for the notification
        const srcResult = await pool.query('SELECT name, scraper_key FROM vendor_sources WHERE id = $1', [stale.vendor_source_id]);
        const src = srcResult.rows[0] || {};
        sendScraperFailure({
          source_name: src.name || 'Unknown',
          scraper_key: src.scraper_key || 'unknown',
          job_id: stale.id,
          error: `Job exceeded ${STALE_JOB_HOURS}-hour time limit and was reaped`,
          started_at: stale.started_at,
          duration_minutes: STALE_JOB_HOURS * 60
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[Reaper] Error checking for stale jobs:', err.message);
  }
});

// ==================== Stock Alert Helper + Cron ====================

async function checkAndSendStockAlerts(skuId, newQtyOnHand) {
  if (newQtyOnHand <= 0) return;
  try {
    const alerts = await pool.query(`
      SELECT sa.id, sa.email,
        p.name as product_name, s.variant_name, s.internal_sku as sku_code, s.id as sku_id,
        (SELECT url FROM media_assets WHERE product_id = p.id AND asset_type = 'primary' ORDER BY sort_order LIMIT 1) as primary_image
      FROM stock_alerts sa
      JOIN skus s ON s.id = sa.sku_id
      JOIN products p ON p.id = s.product_id
      WHERE sa.sku_id = $1 AND sa.status = 'active'
    `, [skuId]);
    for (const alert of alerts.rows) {
      const productUrl = (process.env.SITE_URL || 'https://www.romaflooringdesigns.com') + '/shop/sku/' + alert.sku_id;
      await sendStockAlert({
        product_name: alert.product_name,
        variant_name: alert.variant_name,
        sku_code: alert.sku_code,
        primary_image: alert.primary_image,
        product_url: productUrl,
        email: alert.email
      });
      await pool.query("UPDATE stock_alerts SET status = 'notified', notified_at = CURRENT_TIMESTAMP WHERE id = $1", [alert.id]);
    }
    if (alerts.rows.length > 0) {
      console.log(`[StockAlerts] Notified ${alerts.rows.length} subscriber(s) for SKU ${skuId}`);
    }
  } catch (err) {
    console.error('[StockAlerts] Error sending alerts:', err.message);
  }
}

// Check stock alerts every 30 minutes
cron.schedule('*/30 * * * *', async () => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT sa.sku_id, inv.qty_on_hand
      FROM stock_alerts sa
      JOIN inventory_snapshots inv ON inv.sku_id = sa.sku_id
      WHERE sa.status = 'active'
        AND inv.qty_on_hand > 0
        AND inv.fresh_until > NOW()
    `);
    for (const row of result.rows) {
      await checkAndSendStockAlerts(row.sku_id, row.qty_on_hand);
    }
    if (result.rows.length > 0) {
      console.log(`[StockAlerts Cron] Checked ${result.rows.length} SKU(s) with active alerts and fresh inventory`);
    }
  } catch (err) {
    console.error('[StockAlerts Cron] Error:', err.message);
  }
});

// ==================== Membership Lifecycle Cron Jobs ====================

// Run daily at 6 AM UTC
cron.schedule('0 6 * * *', async () => {
  console.log('[Cron] Running membership lifecycle checks...');
  try {
    // 1) 30-day renewal reminders — active subscriptions expiring within 30 days
    const renewals = await pool.query(`
      SELECT id, email, contact_name, company_name, subscription_expires_at
      FROM trade_customers
      WHERE subscription_status = 'active'
        AND subscription_expires_at IS NOT NULL
        AND subscription_expires_at BETWEEN CURRENT_TIMESTAMP AND CURRENT_TIMESTAMP + INTERVAL '30 days'
        AND subscription_expires_at > CURRENT_TIMESTAMP + INTERVAL '29 days'
    `);
    for (const c of renewals.rows) {
      const daysLeft = Math.ceil((new Date(c.subscription_expires_at) - Date.now()) / (1000 * 60 * 60 * 24));
      await sendRenewalReminder({ ...c, days_until_expiry: daysLeft });
      console.log(`[Cron] Renewal reminder sent to ${c.email} (${daysLeft} days left)`);
    }

    // 2) 15-day lapse warning — past_due subscriptions (payment failed 15+ days ago)
    const warnings = await pool.query(`
      SELECT id, email, contact_name, company_name
      FROM trade_customers
      WHERE subscription_status = 'past_due'
        AND subscription_expires_at IS NOT NULL
        AND subscription_expires_at < CURRENT_TIMESTAMP - INTERVAL '15 days'
        AND subscription_expires_at > CURRENT_TIMESTAMP - INTERVAL '16 days'
    `);
    for (const c of warnings.rows) {
      await sendSubscriptionWarning(c);
      console.log(`[Cron] Subscription warning sent to ${c.email}`);
    }

    // 3) 30-day grace expiry — past_due for 30+ days → deactivate
    const expired = await pool.query(`
      SELECT id, email, contact_name, company_name, stripe_subscription_id
      FROM trade_customers
      WHERE subscription_status = 'past_due'
        AND subscription_expires_at IS NOT NULL
        AND subscription_expires_at < CURRENT_TIMESTAMP - INTERVAL '30 days'
    `);
    for (const c of expired.rows) {
      // Cancel the Stripe subscription if still active
      if (c.stripe_subscription_id) {
        try { await stripe.subscriptions.cancel(c.stripe_subscription_id); } catch (_) {}
      }
      // Deactivate: set status to rejected, clear subscription
      await pool.query(`
        UPDATE trade_customers
        SET subscription_status = 'cancelled', status = 'rejected', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [c.id]);
      await sendSubscriptionDeactivated(c);
      await logAudit(null, 'trade.membership_deactivated', 'trade_customer', c.id, { reason: 'grace_period_expired' });
      console.log(`[Cron] Membership deactivated for ${c.email} (grace period expired)`);
    }

    // 4) Cleanup expired staff sessions and 2FA codes
    await pool.query("DELETE FROM staff_sessions WHERE expires_at < CURRENT_TIMESTAMP");
    await pool.query("DELETE FROM staff_2fa_codes WHERE expires_at < CURRENT_TIMESTAMP");
    console.log('[Cron] Cleaned up expired sessions and 2FA codes');

    console.log('[Cron] Membership lifecycle checks complete');
  } catch (err) {
    console.error('[Cron] Membership lifecycle error:', err.message);
  }
});

// ==================== Customer Accounts ====================

app.post('/api/customer/register', async (req, res) => {
  try {
    const { email, password, first_name, last_name, phone } = req.body;
    if (!email || !password || !first_name || !last_name) {
      return res.status(400).json({ error: 'Email, password, first name, and last name are required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters with 1 uppercase letter and 1 number' });
    }

    const existing = await pool.query('SELECT id FROM customers WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }

    const { hash, salt } = hashPassword(password);
    const result = await pool.query(
      `INSERT INTO customers (email, password_hash, password_salt, first_name, last_name, phone)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, first_name, last_name, phone`,
      [email.toLowerCase(), hash, salt, first_name, last_name, phone || null]
    );
    const customer = result.rows[0];

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await pool.query('INSERT INTO customer_sessions (customer_id, token, expires_at) VALUES ($1, $2, $3)',
      [customer.id, token, expiresAt]);

    res.json({ token, customer });
  } catch (err) {
    console.error('Customer register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/customer/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await pool.query(
      'SELECT id, email, password_hash, password_salt, first_name, last_name, phone FROM customers WHERE email = $1',
      [email.toLowerCase()]
    );
    if (!result.rows.length) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const cust = result.rows[0];
    if (!verifyPassword(password, cust.password_hash, cust.password_salt)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await pool.query('INSERT INTO customer_sessions (customer_id, token, expires_at) VALUES ($1, $2, $3)',
      [cust.id, token, expiresAt]);

    res.json({
      token,
      customer: { id: cust.id, email: cust.email, first_name: cust.first_name, last_name: cust.last_name, phone: cust.phone }
    });
  } catch (err) {
    console.error('Customer login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/customer/logout', customerAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM customer_sessions WHERE id = $1', [req.customer.session_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/customer/me', customerAuth, async (req, res) => {
  res.json({ customer: req.customer });
});

app.put('/api/customer/profile', customerAuth, async (req, res) => {
  try {
    const { first_name, last_name, phone, address_line1, address_line2, city, state, zip } = req.body;
    const result = await pool.query(
      `UPDATE customers SET first_name = COALESCE($1, first_name), last_name = COALESCE($2, last_name),
        phone = COALESCE($3, phone), address_line1 = COALESCE($4, address_line1),
        address_line2 = COALESCE($5, address_line2), city = COALESCE($6, city),
        state = COALESCE($7, state), zip = COALESCE($8, zip), updated_at = CURRENT_TIMESTAMP
       WHERE id = $9
       RETURNING id, email, first_name, last_name, phone, address_line1, address_line2, city, state, zip`,
      [first_name, last_name, phone, address_line1, address_line2, city, state, zip, req.customer.id]
    );
    res.json({ customer: result.rows[0] });
  } catch (err) {
    console.error('Customer profile update error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

app.put('/api/customer/password', customerAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    if (new_password.length < 8 || !/[A-Z]/.test(new_password) || !/[0-9]/.test(new_password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters with 1 uppercase letter and 1 number' });
    }

    const result = await pool.query('SELECT password_hash, password_salt FROM customers WHERE id = $1', [req.customer.id]);
    const cust = result.rows[0];
    if (!verifyPassword(current_password, cust.password_hash, cust.password_salt)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const { hash, salt } = hashPassword(new_password);
    await pool.query('UPDATE customers SET password_hash = $1, password_salt = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [hash, salt, req.customer.id]);

    res.json({ success: true });
  } catch (err) {
    console.error('Customer password change error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

app.post('/api/customer/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    // Always return success to not leak whether email exists
    if (!email) return res.json({ success: true });

    const result = await pool.query('SELECT id, email FROM customers WHERE email = $1', [email.toLowerCase()]);
    if (result.rows.length) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await pool.query(
        'UPDATE customers SET password_reset_token = $1, password_reset_expires = $2 WHERE id = $3',
        [resetToken, expires, result.rows[0].id]
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

app.post('/api/customer/reset-password', async (req, res) => {
  try {
    const { token, new_password } = req.body;
    if (!token || !new_password) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }
    if (new_password.length < 8 || !/[A-Z]/.test(new_password) || !/[0-9]/.test(new_password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters with 1 uppercase letter and 1 number' });
    }

    const result = await pool.query(
      'SELECT id FROM customers WHERE password_reset_token = $1 AND password_reset_expires > CURRENT_TIMESTAMP',
      [token]
    );
    if (!result.rows.length) {
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }

    const { hash, salt } = hashPassword(new_password);
    await pool.query(
      'UPDATE customers SET password_hash = $1, password_salt = $2, password_reset_token = NULL, password_reset_expires = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [hash, salt, result.rows[0].id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ==================== Wishlist Endpoints ====================

app.get('/api/wishlist', customerAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT product_id FROM wishlists WHERE customer_id = $1 ORDER BY created_at DESC',
      [req.customer.id]
    );
    res.json({ product_ids: result.rows.map(r => r.product_id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/wishlist', customerAuth, async (req, res) => {
  try {
    const { product_id } = req.body;
    if (!product_id) return res.status(400).json({ error: 'product_id is required' });
    await pool.query(
      'INSERT INTO wishlists (customer_id, product_id) VALUES ($1, $2) ON CONFLICT (customer_id, product_id) DO NOTHING',
      [req.customer.id, product_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/wishlist/:productId', customerAuth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM wishlists WHERE customer_id = $1 AND product_id = $2',
      [req.customer.id, req.params.productId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/wishlist/sync', customerAuth, async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

// ==================== Product Reviews ====================

app.get('/api/storefront/products/:productId/reviews', async (req, res) => {
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

app.post('/api/storefront/products/:productId/reviews', customerAuth, async (req, res) => {
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

app.post('/api/storefront/stock-alerts', optionalCustomerAuth, async (req, res) => {
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

app.delete('/api/storefront/stock-alerts/:id', async (req, res) => {
  try {
    await pool.query("UPDATE stock_alerts SET status = 'cancelled' WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Stock alert cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel alert' });
  }
});

app.get('/api/storefront/stock-alerts/check', optionalCustomerAuth, async (req, res) => {
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

app.get('/api/customer/orders', customerAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, order_number, customer_name, customer_email, status, subtotal, shipping, total, amount_paid,
        delivery_method, shipping_method, tracking_number, shipping_carrier, shipped_at, created_at
       FROM orders WHERE customer_id = $1 ORDER BY created_at DESC`,
      [req.customer.id]
    );
    res.json({ orders: result.rows });
  } catch (err) {
    console.error('Customer orders error:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

app.get('/api/customer/orders/:id', customerAuth, async (req, res) => {
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

// ==================== Installation Inquiries ====================

app.post('/api/installation-inquiries', async (req, res) => {
  try {
    const { customer_name, customer_email, phone, zip_code, estimated_sqft, message, product_id } = req.body;

    if (!customer_name || !customer_email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer_email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    let product_name = null;
    let collection = null;
    if (product_id) {
      const prodResult = await pool.query(
        'SELECT p.name, p.collection FROM products p WHERE p.id = $1',
        [product_id]
      );
      if (prodResult.rows.length > 0) {
        product_name = prodResult.rows[0].name;
        collection = prodResult.rows[0].collection;
      }
    }

    const result = await pool.query(
      `INSERT INTO installation_inquiries (customer_name, customer_email, phone, zip_code, estimated_sqft, message, product_id, product_name, collection)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [customer_name, customer_email, phone || null, zip_code || null, estimated_sqft || null, message || null, product_id || null, product_name, collection]
    );

    const inquiry = {
      id: result.rows[0].id,
      customer_name,
      customer_email,
      phone,
      zip_code,
      estimated_sqft,
      message,
      product_id,
      product_name,
      collection
    };

    // Fire-and-forget emails
    sendInstallationInquiryNotification(inquiry).catch(err => console.error('[Install Inquiry] Staff email error:', err.message));
    sendInstallationInquiryConfirmation(inquiry).catch(err => console.error('[Install Inquiry] Confirmation email error:', err.message));

    res.json({ success: true, inquiry_id: result.rows[0].id });
  } catch (err) {
    console.error('Installation inquiry error:', err);
    res.status(500).json({ error: 'Failed to submit inquiry' });
  }
});

// ==================== Admin Installation Inquiries ====================

app.get('/api/admin/installation-inquiries', staffAuth, requireRole('admin', 'manager', 'sales_rep'), async (req, res) => {
  try {
    const { status, search, limit = 50, offset = 0 } = req.query;
    const params = [];
    const conditions = [];

    if (status) {
      params.push(status);
      conditions.push(`ii.status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(ii.customer_name ILIKE $${params.length} OR ii.customer_email ILIKE $${params.length})`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await pool.query(
      `SELECT COUNT(*)::int as total FROM installation_inquiries ii ${where}`, params
    );

    params.push(parseInt(limit));
    params.push(parseInt(offset));
    const result = await pool.query(`
      SELECT ii.*, sa.first_name || ' ' || sa.last_name as assigned_name
      FROM installation_inquiries ii
      LEFT JOIN staff_accounts sa ON sa.id = ii.assigned_to
      ${where}
      ORDER BY CASE WHEN ii.status = 'new' THEN 0 ELSE 1 END, ii.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    res.json({ inquiries: result.rows, total: countResult.rows[0].total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/installation-inquiries/:id', staffAuth, requireRole('admin', 'manager', 'sales_rep'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ii.*, sa.first_name || ' ' || sa.last_name as assigned_name
      FROM installation_inquiries ii
      LEFT JOIN staff_accounts sa ON sa.id = ii.assigned_to
      WHERE ii.id = $1
    `, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Inquiry not found' });
    res.json({ inquiry: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/installation-inquiries/:id', staffAuth, requireRole('admin', 'manager', 'sales_rep'), async (req, res) => {
  try {
    const { status, staff_notes, assigned_to } = req.body;
    const validStatuses = ['new', 'contacted', 'quoted', 'scheduled', 'completed', 'closed'];

    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const sets = [];
    const params = [];

    if (status !== undefined) { params.push(status); sets.push(`status = $${params.length}`); }
    if (staff_notes !== undefined) { params.push(staff_notes); sets.push(`staff_notes = $${params.length}`); }
    if (assigned_to !== undefined) { params.push(assigned_to || null); sets.push(`assigned_to = $${params.length}`); }

    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    await pool.query(`UPDATE installation_inquiries SET ${sets.join(', ')} WHERE id = $${params.length}`, params);

    const result = await pool.query(`
      SELECT ii.*, sa.first_name || ' ' || sa.last_name as assigned_name
      FROM installation_inquiries ii
      LEFT JOIN staff_accounts sa ON sa.id = ii.assigned_to
      WHERE ii.id = $1
    `, [req.params.id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Inquiry not found' });
    res.json({ inquiry: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/installation-inquiries/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM installation_inquiries WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Inquiry not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === Sitemap XML ===
function generateSlugBackend(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

app.get('/api/sitemap.xml', async (req, res) => {
  try {
    const baseUrl = 'https://www.romaflooringdesigns.com';
    const today = new Date().toISOString().split('T')[0];

    const [skusResult, categoriesResult, collectionsResult] = await Promise.all([
      pool.query(`SELECT s.id, p.name as product_name, s.updated_at FROM skus s JOIN products p ON s.product_id = p.id WHERE p.status = 'active' ORDER BY s.id`),
      pool.query(`SELECT slug FROM categories WHERE is_active = true ORDER BY slug`),
      pool.query(`SELECT DISTINCT collection as name FROM products WHERE status = 'active' AND collection IS NOT NULL AND collection != '' ORDER BY collection`)
    ]);

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    // Static pages
    const staticPages = ['/', '/shop', '/collections', '/trade'];
    for (const page of staticPages) {
      xml += `  <url><loc>${baseUrl}${page}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>${page === '/' ? '1.0' : '0.8'}</priority></url>\n`;
    }

    // Category pages
    for (const row of categoriesResult.rows) {
      xml += `  <url><loc>${baseUrl}/shop?category=${encodeURIComponent(row.slug)}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>\n`;
    }

    // Collection pages
    for (const row of collectionsResult.rows) {
      const slug = generateSlugBackend(row.name);
      xml += `  <url><loc>${baseUrl}/collections/${encodeURIComponent(slug)}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>\n`;
    }

    // SKU pages
    for (const row of skusResult.rows) {
      const slug = generateSlugBackend(row.product_name);
      const lastmod = row.updated_at ? new Date(row.updated_at).toISOString().split('T')[0] : today;
      xml += `  <url><loc>${baseUrl}/shop/sku/${row.id}/${encodeURIComponent(slug)}</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq><priority>0.9</priority></url>\n`;
    }

    xml += '</urlset>';

    res.set('Content-Type', 'application/xml');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(xml);
  } catch (err) {
    console.error('Sitemap error:', err);
    res.status(500).send('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
  }
});

// Startup migration: consolidate sales_reps FK to allow staff_accounts IDs
async function runMigrations() {
  try {
    // Drop old FK constraints on orders.sales_rep_id and quotes.sales_rep_id
    // so that staff_accounts IDs can be stored there
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_sales_rep_id_fkey;
        ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_sales_rep_id_fkey;
      EXCEPTION WHEN OTHERS THEN NULL;
      END $$;
    `);
    console.log('Migrations: FK constraints updated');

    // PO enhancements: item status, revision tracking, nullable order_item_id
    await pool.query(`
      ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending';
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS revision INTEGER DEFAULT 0;
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS is_revised BOOLEAN DEFAULT false;
    `);
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE purchase_order_items ALTER COLUMN order_item_id DROP NOT NULL;
      EXCEPTION WHEN OTHERS THEN NULL;
      END $$;
    `);
    console.log('Migrations: PO enhancements applied');

    // Order balance & payments
    await pool.query(`
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount_paid DECIMAL(10,2) DEFAULT 0;
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_payments (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        payment_type VARCHAR(20) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        stripe_payment_intent_id TEXT,
        stripe_refund_id TEXT,
        stripe_checkout_session_id TEXT,
        description TEXT,
        initiated_by UUID,
        initiated_by_name TEXT,
        status VARCHAR(20) DEFAULT 'completed',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_order_payments_order ON order_payments(order_id);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payment_requests (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        amount DECIMAL(10,2) NOT NULL,
        stripe_checkout_session_id TEXT,
        stripe_checkout_url TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        sent_to_email TEXT NOT NULL,
        sent_by UUID,
        sent_by_name TEXT,
        message TEXT,
        paid_at TIMESTAMP,
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_payment_requests_order ON payment_requests(order_id);
    `);
    // Backfill amount_paid for existing orders
    await pool.query(`
      UPDATE orders SET amount_paid = total WHERE stripe_payment_intent_id IS NOT NULL AND status NOT IN ('refunded') AND amount_paid = 0;
    `);
    await pool.query(`
      UPDATE orders SET amount_paid = total - COALESCE(refund_amount, 0) WHERE status = 'refunded' AND amount_paid = 0;
    `);
    // Seed initial charge records
    await pool.query(`
      INSERT INTO order_payments (order_id, payment_type, amount, stripe_payment_intent_id, description, status)
        SELECT id, 'charge', total, stripe_payment_intent_id, 'Original payment', 'completed'
        FROM orders WHERE stripe_payment_intent_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM order_payments op WHERE op.order_id = orders.id AND op.payment_type = 'charge');
    `);
    // Seed existing refunds
    await pool.query(`
      INSERT INTO order_payments (order_id, payment_type, amount, stripe_payment_intent_id, stripe_refund_id, description, initiated_by, status)
        SELECT id, 'refund', -1*COALESCE(refund_amount,0), stripe_payment_intent_id, stripe_refund_id, 'Full refund', refunded_by, 'completed'
        FROM orders WHERE stripe_refund_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM order_payments op WHERE op.order_id = orders.id AND op.payment_type = 'refund');
    `);
    console.log('Migrations: Order balance & payments applied');

    // Customer notes table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customer_notes (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        customer_type VARCHAR(10) NOT NULL,
        customer_ref TEXT NOT NULL,
        staff_id UUID REFERENCES staff_accounts(id),
        note TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_customer_notes_ref ON customer_notes(customer_type, customer_ref);
    `);
    console.log('Migrations: Customer notes table applied');

    // Order activity log
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_activity_log (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        performed_by UUID,
        performer_name TEXT,
        details JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_order_activity_log_order ON order_activity_log(order_id);
    `);
    console.log('Migrations: Order activity log applied');
  } catch (err) {
    console.error('Migration warning:', err.message);
  }

  try {
    await pool.query(`
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
    `);
    console.log('Migrations: Cancel reason column applied');
  } catch (err) {
    console.error('Migration warning:', err.message);
  }

  // Drop staff_accounts FK on customer_notes so sales_reps can also add notes
  try {
    await pool.query(`
      ALTER TABLE customer_notes DROP CONSTRAINT IF EXISTS customer_notes_staff_id_fkey;
    `);
    console.log('Migrations: Customer notes staff_id FK relaxed');
  } catch (err) {
    console.error('Migration warning:', err.message);
  }

  // Rep notifications table
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rep_notifications (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        rep_id UUID NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL,
        title TEXT NOT NULL,
        message TEXT,
        entity_type VARCHAR(30),
        entity_id UUID,
        is_read BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_rep_notifications_rep ON rep_notifications(rep_id);
      CREATE INDEX IF NOT EXISTS idx_rep_notifications_unread ON rep_notifications(rep_id, is_read) WHERE is_read = false;
      CREATE INDEX IF NOT EXISTS idx_rep_notifications_created ON rep_notifications(created_at);
    `);
    console.log('Migrations: Rep notifications table applied');
  } catch (err) {
    console.error('Migration warning:', err.message);
  }

  // Commission tables
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS commission_config (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        rate DECIMAL(5,4) NOT NULL DEFAULT 0.10,
        default_cost_ratio DECIMAL(5,4) NOT NULL DEFAULT 0.55,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO commission_config (rate, default_cost_ratio)
        SELECT 0.10, 0.55 WHERE NOT EXISTS (SELECT 1 FROM commission_config);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rep_commissions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        rep_id UUID NOT NULL REFERENCES sales_reps(id),
        order_total DECIMAL(10,2) NOT NULL,
        vendor_cost DECIMAL(10,2) NOT NULL DEFAULT 0,
        margin DECIMAL(10,2) NOT NULL DEFAULT 0,
        commission_rate DECIMAL(5,4) NOT NULL,
        commission_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        paid_at TIMESTAMP,
        paid_by UUID,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rep_commissions_order ON rep_commissions(order_id);
      CREATE INDEX IF NOT EXISTS idx_rep_commissions_rep ON rep_commissions(rep_id);
      CREATE INDEX IF NOT EXISTS idx_rep_commissions_status ON rep_commissions(status);
    `);
    console.log('Migrations: Commission tables applied');
  } catch (err) {
    console.error('Migration warning:', err.message);
  }

  // Showroom visits tables
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS showroom_visits (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        token VARCHAR(64) UNIQUE NOT NULL,
        rep_id UUID NOT NULL REFERENCES sales_reps(id),
        customer_name TEXT NOT NULL,
        customer_email TEXT,
        customer_phone TEXT,
        message TEXT,
        status VARCHAR(20) DEFAULT 'draft',
        sent_at TIMESTAMP,
        opened_at TIMESTAMP,
        items_carted_at TIMESTAMP,
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_showroom_visits_rep ON showroom_visits(rep_id);
      CREATE INDEX IF NOT EXISTS idx_showroom_visits_token ON showroom_visits(token);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS showroom_visit_items (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        visit_id UUID NOT NULL REFERENCES showroom_visits(id) ON DELETE CASCADE,
        product_id UUID REFERENCES products(id),
        sku_id UUID REFERENCES skus(id),
        product_name TEXT NOT NULL,
        collection TEXT,
        variant_name TEXT,
        retail_price DECIMAL(10,2),
        price_basis VARCHAR(20),
        primary_image TEXT,
        rep_note TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_showroom_visit_items_visit ON showroom_visit_items(visit_id);
    `);
    console.log('Migrations: Showroom visits tables applied');
  } catch (err) {
    console.error('Migration warning:', err.message);
  }

  // Sample requests tables
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sample_requests (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        request_number VARCHAR(40) UNIQUE NOT NULL,
        rep_id UUID NOT NULL REFERENCES sales_reps(id),
        customer_name TEXT NOT NULL,
        customer_email TEXT,
        customer_phone TEXT,
        shipping_address_line1 TEXT,
        shipping_address_line2 TEXT,
        shipping_city TEXT,
        shipping_state TEXT,
        shipping_zip TEXT,
        status VARCHAR(20) DEFAULT 'requested',
        tracking_number TEXT,
        notes TEXT,
        shipped_at TIMESTAMP,
        delivered_at TIMESTAMP,
        cancelled_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_sample_requests_rep ON sample_requests(rep_id);
      CREATE INDEX IF NOT EXISTS idx_sample_requests_status ON sample_requests(status);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sample_request_items (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        sample_request_id UUID NOT NULL REFERENCES sample_requests(id) ON DELETE CASCADE,
        product_id UUID REFERENCES products(id),
        sku_id UUID REFERENCES skus(id),
        product_name TEXT NOT NULL,
        collection TEXT,
        variant_name TEXT,
        primary_image TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_sample_request_items_request ON sample_request_items(sample_request_id);
    `);
    console.log('Migrations: Sample requests tables applied');
  } catch (err) {
    console.error('Migration warning:', err.message);
  }

  // Sample requests delivery_method column
  try {
    await pool.query(`ALTER TABLE sample_requests ADD COLUMN IF NOT EXISTS delivery_method VARCHAR(20) DEFAULT 'shipping'`);
    console.log('Migrations: Sample requests delivery_method applied');
  } catch (err) {
    console.error('Migration warning:', err.message);
  }

  // Wishlists table
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wishlists (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(customer_id, product_id)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_wishlists_customer ON wishlists(customer_id)');
    console.log('Migrations: Wishlists table applied');
  } catch (err) {
    console.error('Migration warning:', err.message);
  }

  // Installation inquiries management columns
  try {
    await pool.query(`
      ALTER TABLE installation_inquiries ADD COLUMN IF NOT EXISTS staff_notes TEXT;
      ALTER TABLE installation_inquiries ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES staff_accounts(id);
    `);
    console.log('Migrations: Installation inquiries management columns applied');
  } catch (err) {
    console.error('Migration warning:', err.message);
  }

  // Products unique constraint: (vendor_id, name) → (vendor_id, collection, name)
  try {
    await pool.query(`UPDATE products SET collection = '' WHERE collection IS NULL`);
    await pool.query(`ALTER TABLE products ALTER COLUMN collection SET DEFAULT ''`);
    await pool.query(`ALTER TABLE products DROP CONSTRAINT IF EXISTS products_vendor_name_unique`);
    await pool.query(`
      ALTER TABLE products ADD CONSTRAINT products_vendor_collection_name_unique
      UNIQUE (vendor_id, collection, name)
    `);
    console.log('Migrations: Products unique constraint updated to (vendor_id, collection, name)');
  } catch (err) {
    console.error('Migration warning:', err.message);
  }
}

// ==================== Email Template Preview (Dev Only) ====================

import { generateOrderConfirmationHTML } from './templates/orderConfirmation.js';
import { generateOrderStatusUpdateHTML } from './templates/orderStatusUpdate.js';
import { generatePasswordResetHTML } from './templates/passwordReset.js';
import { generateTradeApprovalHTML } from './templates/tradeApproval.js';
import { generateTradeDenialHTML } from './templates/tradeDenial.js';
import { generateTierPromotionHTML } from './templates/tierPromotion.js';
import { generateRenewalReminderHTML } from './templates/renewalReminder.js';
import { generateSubscriptionWarningHTML } from './templates/subscriptionWarning.js';
import { generateSubscriptionLapsedHTML } from './templates/subscriptionLapsed.js';
import { generateSubscriptionDeactivatedHTML } from './templates/subscriptionDeactivated.js';
import { generateInstallationInquiryStaffHTML } from './templates/installationInquiryStaff.js';
import { generateInstallationInquiryConfirmationHTML } from './templates/installationInquiryConfirmation.js';
import { generateVisitRecapHTML } from './templates/visitRecap.js';
import { generateSampleRequestConfirmationHTML } from './templates/sampleRequestConfirmation.js';
import { generateSampleRequestShippedHTML } from './templates/sampleRequestShipped.js';

const EMAIL_PREVIEW_TEMPLATES = {
  orderConfirmation: () => generateOrderConfirmationHTML({
    order_number: 'ORD-20260217-A1B2',
    created_at: new Date().toISOString(),
    customer_name: 'Maria Santos',
    shipping_address_line1: '742 Evergreen Terrace',
    shipping_address_line2: 'Suite 4',
    shipping_city: 'Anaheim',
    shipping_state: 'CA',
    shipping_zip: '92806',
    delivery_method: 'shipping',
    subtotal: '1,247.50',
    shipping: '89.00',
    sample_shipping: '12.00',
    total: '1,348.50',
    items: [
      { product_name: 'European White Oak', collection: 'Heritage Collection', num_boxes: 12, subtotal: '1,047.50', is_sample: false },
      { product_name: 'Calacatta Gold Marble Mosaic', collection: 'Luxe Stone', num_boxes: 3, subtotal: '200.00', is_sample: false },
      { product_name: 'Smoky Grey Porcelain', collection: 'Modern Edge', num_boxes: 1, subtotal: '0.00', is_sample: true },
    ]
  }),

  orderStatusUpdate: () => generateOrderStatusUpdateHTML({
    order_number: 'ORD-20260217-A1B2',
    customer_name: 'Maria Santos',
    tracking_number: '1Z999AA10123456784',
    shipping_carrier: 'UPS',
    shipped_at: new Date().toISOString()
  }),

  quoteSent: () => generateQuoteSentHTML({
    quote_number: 'QT-20260217-X9Y8',
    customer_name: 'James Chen',
    customer_email: 'james@example.com',
    subtotal: '3,450.00',
    shipping: '175.00',
    total: '3,625.00',
    rep_first_name: 'Alex',
    rep_last_name: 'Rivera',
    rep_email: 'alex@romaflooringdesigns.com',
    items: [
      { product_name: 'French Oak Chevron', collection: 'Parisian Collection', description: '5" wide plank, natural finish', num_boxes: 24, subtotal: '2,400.00' },
      { product_name: 'Carrara Hex Mosaic', collection: 'Classic Marble', description: '2" hexagon, honed', num_boxes: 8, subtotal: '1,050.00' },
    ]
  }),

  tradeApproval: () => generateTradeApprovalHTML({
    contact_name: 'David Park',
    company_name: 'Park Interior Design Studio'
  }),

  tradeDenial: () => generateTradeDenialHTML({
    contact_name: 'Sarah Johnson',
    company_name: 'Johnson Renovations LLC',
    denial_reason: 'We were unable to verify the business credentials provided. Please reapply with a valid EIN and resale certificate.'
  }),

  tierPromotion: () => generateTierPromotionHTML({
    contact_name: 'Michael Torres',
    tierName: 'Gold'
  }),

  renewalReminder: () => generateRenewalReminderHTML({
    contact_name: 'Lisa Wang',
    company_name: 'Wang & Associates Design',
    days_until_expiry: 14
  }),

  subscriptionWarning: () => generateSubscriptionWarningHTML({
    contact_name: 'Robert Kim',
    company_name: 'Kim Contractors Inc.'
  }),

  subscriptionLapsed: () => generateSubscriptionLapsedHTML({
    contact_name: 'Robert Kim',
    company_name: 'Kim Contractors Inc.'
  }),

  subscriptionDeactivated: () => generateSubscriptionDeactivatedHTML({
    contact_name: 'Robert Kim',
    company_name: 'Kim Contractors Inc.'
  }),

  installationInquiryStaff: () => generateInstallationInquiryStaffHTML({
    customer_name: 'Angela Martinez',
    customer_email: 'angela@example.com',
    phone: '(714) 555-0199',
    zip_code: '92801',
    estimated_sqft: '850',
    product_name: 'European White Oak',
    collection: 'Heritage Collection',
    message: 'We are remodeling our kitchen and living room. Looking for installation in about 3 weeks. The subfloor is concrete slab.'
  }),

  installationInquiryConfirmation: () => generateInstallationInquiryConfirmationHTML({
    customer_name: 'Angela Martinez',
    product_name: 'European White Oak',
    collection: 'Heritage Collection',
    zip_code: '92801',
    estimated_sqft: '850',
    message: 'We are remodeling our kitchen and living room. Looking for installation in about 3 weeks.'
  }),

  passwordReset: () => generatePasswordResetHTML({
    resetUrl: 'https://romaflooringdesigns.com/reset-password?token=abc123def456'
  }),

  visitRecap: () => generateVisitRecapHTML({
    customer_name: 'Jennifer Lee',
    message: 'It was wonderful meeting you today! Here are the products we discussed for your master bathroom renovation. The Calacatta Gold would pair beautifully with the warm oak accents you mentioned.',
    rep_name: 'Alex Rivera',
    recap_url: 'https://romaflooringdesigns.com/recap/abc123',
    items: [
      { product_name: 'Calacatta Gold Marble', collection: 'Luxe Stone', variant_name: '24x24 Polished', retail_price: '18.50', price_basis: 'per_sqft', rep_note: 'Perfect for the shower accent wall', primary_image: '' },
      { product_name: 'European White Oak', collection: 'Heritage Collection', variant_name: '7" Wide Plank Natural', retail_price: '8.75', price_basis: 'per_sqft', rep_note: '', primary_image: '' },
    ]
  }),

  sampleRequestConfirmation: () => generateSampleRequestConfirmationHTML({
    customer_name: 'Jennifer Lee',
    request_number: 'SR-20260217-X4K9',
    delivery_method: 'shipping',
    shipping_address_line1: '1500 Oak Street',
    shipping_address_line2: '',
    shipping_city: 'Irvine',
    shipping_state: 'CA',
    shipping_zip: '92614',
    items: [
      { product_name: 'European White Oak', collection: 'Heritage Collection', variant_name: '7" Wide Plank Natural', primary_image: '' },
      { product_name: 'Calacatta Gold Marble', collection: 'Luxe Stone', variant_name: '24x24 Polished', primary_image: '' },
    ]
  }),

  'sampleRequestConfirmation-pickup': () => generateSampleRequestConfirmationHTML({
    customer_name: 'Jennifer Lee',
    request_number: 'SR-20260217-X4K9',
    delivery_method: 'pickup',
    items: [
      { product_name: 'Smoky Grey Porcelain', collection: 'Modern Edge', variant_name: '12x24 Matte', primary_image: '' },
    ]
  }),

  sampleRequestShipped: () => generateSampleRequestShippedHTML({
    customer_name: 'Jennifer Lee',
    request_number: 'SR-20260217-X4K9',
    tracking_number: '9400111899223033005282',
    items: [
      { product_name: 'European White Oak', collection: 'Heritage Collection', variant_name: '7" Wide Plank Natural', primary_image: '' },
      { product_name: 'Calacatta Gold Marble', collection: 'Luxe Stone', variant_name: '24x24 Polished', primary_image: '' },
    ]
  }),

  'sampleRequestShipped-noTracking': () => generateSampleRequestShippedHTML({
    customer_name: 'Jennifer Lee',
    request_number: 'SR-20260217-X4K9',
    tracking_number: '',
    items: [
      { product_name: 'Smoky Grey Porcelain', collection: 'Modern Edge', variant_name: '12x24 Matte', primary_image: '' },
    ]
  }),
};

// Index page listing all templates
app.get('/api/dev/email-preview', (req, res) => {
  const names = Object.keys(EMAIL_PREVIEW_TEMPLATES);
  const links = names.map(n => `<li style="margin:4px 0;"><a href="/api/dev/email-preview/${n}" target="_blank" style="color:#292524;font-size:15px;">${n}</a></li>`).join('');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Email Template Preview</title>
    <style>body{font-family:Inter,Arial,sans-serif;max-width:600px;margin:40px auto;padding:0 20px;color:#1c1917;}
    h1{font-family:'Cormorant Garamond',Georgia,serif;font-weight:400;font-size:28px;margin-bottom:8px;}
    p{color:#78716c;font-size:14px;}ul{list-style:none;padding:0;}a{text-decoration:none;}a:hover{text-decoration:underline;}</style>
    </head><body><h1>Email Template Preview</h1><p>${names.length} templates available</p><ul>${links}</ul></body></html>`);
});

// Individual template render
app.get('/api/dev/email-preview/:name', (req, res) => {
  const generator = EMAIL_PREVIEW_TEMPLATES[req.params.name];
  if (!generator) return res.status(404).send('Template not found. <a href="/api/dev/email-preview">View all templates</a>');
  try {
    res.send(generator());
  } catch (err) {
    res.status(500).send(`<pre>Error rendering template: ${err.message}\n\n${err.stack}</pre>`);
  }
});

runMigrations().then(() => {
  app.listen(PORT, () => {
    console.log(`API running on port ${PORT}`);
    initScheduler();
  });
});
