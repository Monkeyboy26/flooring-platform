import express from 'express';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import crypto from 'crypto';
import Stripe from 'stripe';
import EasyPostClient from '@easypost/api';
import XLSX from 'xlsx';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { sendOrderConfirmation, sendQuoteSent, sendOrderStatusUpdate, sendTradeApproval, sendTradeDenial, sendTierPromotion, send2FACode, sendRenewalReminder, sendSubscriptionWarning, sendSubscriptionLapsed, sendSubscriptionDeactivated, sendInstallationInquiryNotification, sendInstallationInquiryConfirmation, sendPasswordReset, sendPurchaseOrderToVendor, sendPaymentRequest, sendPaymentReceived, sendVisitRecap, sendSampleRequestConfirmation, sendSampleRequestShipped, sendScraperFailure, sendStockAlert, sendInvoiceSent, sendInvoiceReminder, sendSampleRequestToVendor, sendSampleShippingPayment, sendWelcomeSetPassword, sendOrderInvoiceEmail, sendDailyAnalyticsSummary, sendEstimateSent, sendProductShare, sendScraperHealthCheck, sendBankTransferAwaitingEmail, sendQualityDigest } from './services/emailService.js';
import { generateSampleRequestVendorHTML } from './templates/sampleRequestVendor.js';
import { generateQuoteSentHTML } from './templates/quoteSent.js';
import { generateEstimateSentHTML } from './templates/estimateSent.js';
import healthRoutes from './routes/health.js';
import createSeoRouter from './services/seoRenderer.js';
import { generate850 } from './services/ediGenerator.js';
import { createSftpConnection, uploadFile } from './services/ediSftp.js';
import { createFtpConnection, uploadFile as ftpUploadFile } from './services/ediFtp.js';
import sharp from 'sharp';
import { pool } from './db.js';
import { createAuthMiddleware } from './lib/auth.js';
import { calculateSalesTax, isPickupOnly, getNextBusinessDay } from './lib/helpers.js';
import { recalculateBalance, logOrderActivity, recalculateCommission, syncOrderPaymentToInvoice } from './lib/orderHelpers.js';
import { createRepNotification, notifyAllActiveReps, createAutoTask, AUTO_TASK_DEFAULT_DAYS } from './lib/notifications.js';
import { createCustomerHelpers } from './lib/customerHelpers.js';
import { generatePDF, generatePDFBuffer, generatePOHtml, getDocumentBaseCSS, getDocumentHeader, getDocumentFooter, itemDescriptionCell } from './lib/documents.js';
import { s3, S3_BUCKET, uploadToS3, getPresignedUrl } from './lib/s3.js';
import { docUpload, mediaUpload, importUpload, pricelistUpload, receiptUpload } from './lib/uploads.js';
import createCartRoutes from './routes/cart.js';
import createCustomerRoutes from './routes/customer.js';
import createAnalyticsRoutes from './routes/analytics.js';

const { staffAuth, repAuth, tradeAuth, optionalTradeAuth, customerAuth, optionalCustomerAuth, requireRole, hashPassword, verifyPassword, validatePassword, logAudit } = createAuthMiddleware(pool);
const { findOrCreateCustomer } = createCustomerHelpers(hashPassword, sendWelcomeSetPassword);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
const easypost = process.env.EASYPOST_API_KEY ? new EasyPostClient(process.env.EASYPOST_API_KEY) : null;
const UPLOADS_DIR = process.env.UPLOADS_PATH || './uploads';

// Shipping configuration
const WEIGHT_THRESHOLD_LBS = 150; // parcel vs LTL cutoff
const SHIP_FROM = { zip: '92806', city: 'Anaheim', state: 'CA', country: 'US' };

// Sales tax, helpers, documents, auth — extracted to lib/ modules



const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);


app.disable('x-powered-by');
app.set('trust proxy', 1); // Trust first proxy (nginx)

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));
app.use('/assets', express.static('assets'));
app.use(healthRoutes);
app.use(createSeoRouter(pool));

// ==================== Rate Limiters ====================
const globalLimiter = rateLimit({ windowMs: 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts, please try again later' } });
const checkoutLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const searchLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
const registrationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 3, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many registration attempts, please try again later' } });

app.use(globalLimiter);
app.use('/api/staff/login', authLimiter);
app.use('/api/trade/login', authLimiter);
app.use('/api/rep/login', authLimiter);
app.use('/api/customer/login', authLimiter);
app.use('/api/customer/reset-password', authLimiter);
app.use('/api/checkout', checkoutLimiter);
app.use('/api/storefront/search/suggest', searchLimiter);
app.use('/api/trade/register', registrationLimiter);
app.use('/api/trade/register/upload', registrationLimiter);

// ==================== Image Resize Proxy ====================
const imgLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const IMG_CACHE_DIR = path.join(process.cwd(), '_cache');
if (!fs.existsSync(IMG_CACHE_DIR)) fs.mkdirSync(IMG_CACHE_DIR, { recursive: true });
const imgInflight = new Map(); // cacheKey → Promise<Buffer> — dedup concurrent requests

function isPrivateUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!['http:', 'https:'].includes(u.protocol)) return true;
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true;
    const parts = host.split('.').map(Number);
    if (parts.length === 4 && !parts.some(isNaN)) {
      if (parts[0] === 10) return true;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      if (parts[0] === 192 && parts[1] === 168) return true;
      if (parts[0] === 169 && parts[1] === 254) return true;
    }
    return false;
  } catch { return true; }
}

app.get('/api/img', imgLimiter, async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url required' });

    const w = Math.min(parseInt(req.query.w) || 800, 1200);
    const h = req.query.h ? Math.min(parseInt(req.query.h), 1200) : undefined;
    const q = Math.min(parseInt(req.query.q) || 80, 100);
    const acceptsWebp = (req.headers.accept || '').includes('image/webp');
    let fmt = req.query.f || 'auto';
    if (fmt === 'auto') fmt = acceptsWebp ? 'webp' : 'jpeg';
    if (!['webp', 'jpeg', 'png'].includes(fmt)) fmt = 'jpeg';

    const cacheKey = crypto.createHash('sha256').update(`${url}|${w}|${h || ''}|${q}|${fmt}`).digest('hex');
    const ext = fmt === 'jpeg' ? 'jpg' : fmt;
    const cachePath = path.join(IMG_CACHE_DIR, `${cacheKey}.${ext}`);

    const contentType = `image/${fmt === 'jpg' ? 'jpeg' : fmt}`;

    // Serve from disk cache
    if (fs.existsSync(cachePath)) {
      res.set({ 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Cache': 'HIT' });
      return fs.createReadStream(cachePath).pipe(res);
    }

    // Deduplicate concurrent requests for the same image+size
    if (!imgInflight.has(cacheKey)) {
      const work = (async () => {
        let inputBuffer;
        if (url.startsWith('/uploads/') || url.startsWith('/assets/')) {
          const localPath = path.join(process.cwd(), url.split('?')[0]);
          if (!fs.existsSync(localPath)) return null;
          inputBuffer = fs.readFileSync(localPath);
        } else {
          if (isPrivateUrl(url)) return null;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          try {
            const resp = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Roma-ImageProxy/1.0' } });
            clearTimeout(timeout);
            if (!resp.ok) return null;
            inputBuffer = Buffer.from(await resp.arrayBuffer());
          } catch { clearTimeout(timeout); return null; }
        }
        const resizeOpts = { width: w, fit: 'inside', withoutEnlargement: true };
        if (h) resizeOpts.height = h;
        let pipeline = sharp(inputBuffer).resize(resizeOpts);
        if (fmt === 'webp') pipeline = pipeline.webp({ quality: q });
        else if (fmt === 'jpeg') pipeline = pipeline.jpeg({ quality: q, mozjpeg: true });
        else pipeline = pipeline.png({ quality: q });
        const outputBuffer = await pipeline.toBuffer();
        if (outputBuffer.length > 500) {
          fs.writeFile(cachePath, outputBuffer, () => {});
        }
        return outputBuffer;
      })();
      imgInflight.set(cacheKey, work);
      work.finally(() => imgInflight.delete(cacheKey));
    }

    const outputBuffer = await imgInflight.get(cacheKey);
    if (!outputBuffer) return res.status(502).end();

    res.set({
      'Content-Type': contentType,
      'Cache-Control': outputBuffer.length > 500 ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Cache': 'MISS'
    });
    res.send(outputBuffer);
  } catch (err) {
    console.error('[img] resize error:', err.message);
    res.status(500).end();
  }
});

// S3, uploads, auth — extracted to lib/ modules

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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/collections', async (req, res) => {
  try {
    const { vendor } = req.query;
    const params = [];
    let vendorClause = '';
    if (vendor) {
      params.push(vendor);
      vendorClause = ' AND p.vendor_id::text = $1';
    }
    const result = await pool.query(`
      SELECT p.collection as name,
        COUNT(*)::int as product_count,
        (SELECT ma.url FROM media_assets ma
         JOIN products p2 ON p2.id = ma.product_id
         WHERE p2.collection = p.collection AND p2.status = 'active' AND ma.asset_type != 'spec_pdf'
         ORDER BY CASE ma.asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 WHEN 'lifestyle' THEN 2 ELSE 3 END,
           CASE WHEN ma.sku_id IS NOT NULL THEN 0 ELSE 1 END, ma.sort_order LIMIT 1) as image
      FROM products p
      WHERE p.status = 'active' AND p.collection IS NOT NULL AND p.collection != ''${vendorClause}
      GROUP BY p.collection
      ORDER BY p.collection
    `, params);
    const collections = result.rows.map(r => ({
      ...r,
      slug: r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    }));
    res.json({ collections });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
      SELECT c.id, c.name, c.slug, c.parent_id, c.sort_order, c.image_url, c.description, c.banner_image,
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
          image_url: ch.image_url || null,
          product_count: ch.product_count,
          description: ch.description || null,
          banner_image: ch.banner_image || null
        }));
      const parent_count = p.product_count + children.reduce((sum, ch) => sum + ch.product_count, 0);
      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        image_url: p.image_url || null,
        description: p.description || null,
        banner_image: p.banner_image || null,
        product_count: parent_count,
        children
      };
    });

    res.json({ categories });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Analytics routes — extracted to routes/analytics.js
app.use(createAnalyticsRoutes({ pool }));

// ==================== Featured Products (best-sellers) ====================

app.get('/api/storefront/featured', async (req, res) => {
  try {
    const LIMIT = 8;

    // Best-sellers: SKUs ordered most often in confirmed/shipped/delivered orders
    const bestSellersSQL = `
      WITH best AS (
        SELECT oi.sku_id, COUNT(oi.id)::int as times_ordered
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        JOIN skus s ON s.id = oi.sku_id
        JOIN products p ON p.id = s.product_id
        WHERE o.status IN ('confirmed', 'shipped', 'delivered')
          AND oi.is_sample = false
          AND s.status = 'active' AND p.status = 'active'
          AND COALESCE(s.variant_type, '') != 'accessory'
        GROUP BY oi.sku_id
        ORDER BY times_ordered DESC
        LIMIT $1
      ),
      sku_images AS (
        SELECT DISTINCT ON (sku_id) sku_id, url
        FROM media_assets WHERE asset_type = 'primary' AND sku_id IS NOT NULL
        ORDER BY sku_id, sort_order
      ),
      product_images AS (
        SELECT DISTINCT ON (product_id) product_id, url
        FROM media_assets WHERE asset_type = 'primary' AND sku_id IS NULL
        ORDER BY product_id, sort_order
      ),
      sku_alt_images AS (
        SELECT DISTINCT ON (sku_id) sku_id, url
        FROM media_assets WHERE asset_type = 'alternate' AND sku_id IS NOT NULL
        ORDER BY sku_id, sort_order
      ),
      product_alt_images AS (
        SELECT DISTINCT ON (product_id) product_id, url
        FROM media_assets WHERE asset_type = 'alternate' AND sku_id IS NULL
        ORDER BY product_id, sort_order
      ),
      sku_any_images AS (
        SELECT DISTINCT ON (sku_id) sku_id, url
        FROM media_assets WHERE asset_type = 'alternate' AND sku_id IS NOT NULL
        ORDER BY sku_id, sort_order
      ),
      product_any_images AS (
        SELECT DISTINCT ON (product_id) product_id, url
        FROM media_assets WHERE asset_type = 'alternate' AND sku_id IS NULL
        ORDER BY product_id, sort_order
      ),
      sibling_images AS (
        SELECT DISTINCT ON (s2.product_id) s2.product_id, ma.url
        FROM media_assets ma
        JOIN skus s2 ON s2.id = ma.sku_id
        WHERE ma.asset_type = 'primary' AND ma.sku_id IS NOT NULL
        ORDER BY s2.product_id, ma.sort_order
      ),
      variant_counts AS (
        SELECT product_id, COUNT(*) as variant_count
        FROM skus WHERE status = 'active' AND is_sample = false AND COALESCE(variant_type, '') != 'accessory'
        GROUP BY product_id
      )
      SELECT
        s.id as sku_id, s.product_id, s.variant_name, s.internal_sku, s.vendor_sku, s.sell_by, s.created_at,
        COALESCE(p.display_name, p.name) as product_name, p.collection, p.description_short,
        v.name as vendor_name,
        COALESCE(v.has_public_inventory, false) as vendor_has_inventory,
        c.name as category_name, c.slug as category_slug,
        pr.retail_price, pr.price_basis, pr.cut_price,
        CASE WHEN pr.sale_price IS NOT NULL AND (pr.sale_ends_at IS NULL OR pr.sale_ends_at > NOW()) THEN pr.sale_price ELSE NULL END as sale_price,
        pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs,
        COALESCE(si.url, pi.url, sany.url, pany.url, sib.url) as primary_image,
        COALESCE(sai.url, pai.url) as alternate_image,
        CASE
          WHEN inv.fresh_until IS NULL OR inv.fresh_until <= NOW() THEN 'unknown'
          WHEN inv.qty_on_hand > 10 THEN 'in_stock'
          WHEN inv.qty_on_hand > 0 THEN 'low_stock'
          ELSE 'out_of_stock'
        END as stock_status,
        COALESCE(vc.variant_count, 0) as variant_count,
        b.times_ordered
      FROM best b
      JOIN skus s ON s.id = b.sku_id
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      LEFT JOIN packaging pk ON pk.sku_id = s.id
      LEFT JOIN inventory_snapshots inv ON inv.sku_id = s.id AND inv.warehouse = 'default'
      LEFT JOIN sku_images si ON si.sku_id = s.id
      LEFT JOIN product_images pi ON pi.product_id = p.id
      LEFT JOIN sku_alt_images sai ON sai.sku_id = s.id
      LEFT JOIN product_alt_images pai ON pai.product_id = p.id
      LEFT JOIN sku_any_images sany ON sany.sku_id = s.id
      LEFT JOIN product_any_images pany ON pany.product_id = p.id
      LEFT JOIN sibling_images sib ON sib.product_id = p.id
      LEFT JOIN variant_counts vc ON vc.product_id = p.id
      ORDER BY b.times_ordered DESC
    `;

    const { rows: bestSellers } = await pool.query(bestSellersSQL, [LIMIT]);

    let skus = bestSellers;

    // Fallback: pad with newest SKUs if fewer than LIMIT best-sellers
    if (skus.length < LIMIT) {
      const existingIds = skus.map(s => s.sku_id);
      const padSQL = `
        WITH sku_images AS (
          SELECT DISTINCT ON (sku_id) sku_id, url
          FROM media_assets WHERE asset_type = 'primary' AND sku_id IS NOT NULL
          ORDER BY sku_id, sort_order
        ),
        product_images AS (
          SELECT DISTINCT ON (product_id) product_id, url
          FROM media_assets WHERE asset_type = 'primary' AND sku_id IS NULL
          ORDER BY product_id, sort_order
        ),
        sku_alt_images AS (
          SELECT DISTINCT ON (sku_id) sku_id, url
          FROM media_assets WHERE asset_type = 'alternate' AND sku_id IS NOT NULL
          ORDER BY sku_id, sort_order
        ),
        product_alt_images AS (
          SELECT DISTINCT ON (product_id) product_id, url
          FROM media_assets WHERE asset_type = 'alternate' AND sku_id IS NULL
          ORDER BY product_id, sort_order
        ),
        sku_any_images AS (
          SELECT DISTINCT ON (sku_id) sku_id, url
          FROM media_assets WHERE asset_type = 'alternate' AND sku_id IS NOT NULL
          ORDER BY sku_id, sort_order
        ),
        product_any_images AS (
          SELECT DISTINCT ON (product_id) product_id, url
          FROM media_assets WHERE asset_type = 'alternate' AND sku_id IS NULL
          ORDER BY product_id, sort_order
        ),
        sibling_images AS (
          SELECT DISTINCT ON (s2.product_id) s2.product_id, ma.url
          FROM media_assets ma
          JOIN skus s2 ON s2.id = ma.sku_id
          WHERE ma.asset_type = 'primary' AND ma.sku_id IS NOT NULL
          ORDER BY s2.product_id, ma.sort_order
        ),
        variant_counts AS (
          SELECT product_id, COUNT(*) as variant_count
          FROM skus WHERE status = 'active' AND is_sample = false AND COALESCE(variant_type, '') != 'accessory'
          GROUP BY product_id
        )
        SELECT * FROM (
          SELECT DISTINCT ON (p.id)
            s.id as sku_id, s.product_id, s.variant_name, s.internal_sku, s.vendor_sku, s.sell_by, s.created_at,
            COALESCE(p.display_name, p.name) as product_name, p.collection, p.description_short,
            v.name as vendor_name,
            COALESCE(v.has_public_inventory, false) as vendor_has_inventory,
            c.name as category_name, c.slug as category_slug,
            pr.retail_price, pr.price_basis, pr.cut_price,
            CASE WHEN pr.sale_price IS NOT NULL AND (pr.sale_ends_at IS NULL OR pr.sale_ends_at > NOW()) THEN pr.sale_price ELSE NULL END as sale_price,
            pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs,
            COALESCE(si.url, pi.url, sany.url, pany.url, sib.url) as primary_image,
            COALESCE(sai.url, pai.url) as alternate_image,
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
          LEFT JOIN sku_alt_images sai ON sai.sku_id = s.id
          LEFT JOIN product_alt_images pai ON pai.product_id = p.id
          LEFT JOIN sku_any_images sany ON sany.sku_id = s.id
          LEFT JOIN product_any_images pany ON pany.product_id = p.id
          LEFT JOIN sibling_images sib ON sib.product_id = p.id
          LEFT JOIN variant_counts vc ON vc.product_id = p.id
          WHERE p.status = 'active' AND s.status = 'active' AND s.is_sample = false
            AND COALESCE(s.variant_type, '') != 'accessory'
            ${existingIds.length > 0 ? 'AND s.id != ALL($2)' : ''}
          ORDER BY p.id, s.created_at
        ) grouped
        ORDER BY CASE WHEN primary_image IS NOT NULL THEN 0 ELSE 1 END, created_at DESC
        LIMIT $1
      `;
      const padParams = [LIMIT - skus.length];
      if (existingIds.length > 0) padParams.push(existingIds);
      const { rows: padRows } = await pool.query(padSQL, padParams);
      skus = [...skus, ...padRows];
    }

    // Batch-fetch attributes
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

    // Strip times_ordered from response
    skus = skus.map(({ times_ordered, ...rest }) => rest);

    res.json({ skus });
  } catch (err) {
    console.error('[Featured] Error:', err);
    res.status(500).json({ error: 'Failed to load featured products' });
  }
});

// ==================== Newsletter Signup ====================

app.post('/api/newsletter/subscribe', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
    await pool.query(`
      INSERT INTO newsletter_subscribers (email)
      VALUES ($1)
      ON CONFLICT (email) DO UPDATE SET subscribed_at = CURRENT_TIMESTAMP
    `, [email.toLowerCase().trim()]);
    res.json({ success: true });
  } catch (err) {
    console.error('[Newsletter] Error:', err.message);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// ==================== Search Synonyms / Aliases ====================

const SEARCH_SYNONYMS = {
  // Abbreviations
  'lvp': 'luxury vinyl plank',
  'lvt': 'luxury vinyl tile',
  'spc': 'stone polymer composite rigid core vinyl',
  'wpc': 'wood polymer composite vinyl',
  'cof': 'coefficient of friction',
  'porcy': 'porcelain',
  'herring': 'herringbone',
  'hw': 'hardwood',
  'eng': 'engineered hardwood',
  'lam': 'laminate',
  'calc': 'calacatta',
  'trav': 'travertine',
  'slab': 'countertop slab',
  // Context-aware expansions
  'backsplash': 'mosaic wall tile backsplash',
  'subway': 'subway wall tile',
  'penny': 'penny round mosaic',
  'hex': 'hexagon mosaic',
  'bullnose': 'bullnose trim',
  'schluter': 'trim transition profile',
  'reducer': 'transition reducer molding',
  'quarter round': 'quarter round molding trim',
  't-molding': 't molding transition',
  'underlayment': 'underlayment pad',
  'waterproof': 'waterproof flooring vinyl laminate',
  'click lock': 'click lock floating floor',
  'glue down': 'glue down adhesive',
  'wood look': 'wood look porcelain plank tile',
  'marble look': 'marble look porcelain tile',
  'stone look': 'stone look porcelain tile',
  // Room/use context
  'shower': 'shower wall floor tile waterproof',
  'bathroom': 'bathroom floor wall tile porcelain',
  'kitchen': 'kitchen floor tile backsplash',
  'outdoor': 'outdoor patio exterior tile',
  'patio': 'outdoor patio exterior tile',
  'fireplace': 'fireplace surround wall tile stone',
  'pool': 'pool tile waterline mosaic',
  'stair': 'stair nose molding transition',
  'stair nose': 'stair nose molding transition',
  // Material expansions
  'vinyl plank': 'luxury vinyl plank lvp',
  'vinyl tile': 'luxury vinyl tile lvt',
  'engineered': 'engineered hardwood',
  'solid hardwood': 'solid hardwood floor',
  'natural stone': 'natural stone marble travertine slate',
  'ceramic': 'ceramic tile',
  'porcelain tile': 'porcelain tile floor wall',
  // Pattern/style
  'chevron': 'chevron herringbone pattern',
  'basketweave': 'basketweave mosaic pattern',
  'arabesque': 'arabesque lantern mosaic',
  'lantern': 'lantern arabesque mosaic',
  'picket': 'picket elongated hexagon mosaic',
  // Trim & accessories
  'threshold': 'threshold transition molding',
  'nosing': 'stair nose nosing molding',
  'baseboard': 'baseboard molding trim',
  'caulk': 'caulk sealant grout',
  'sealer': 'sealer grout stone',
  'thinset': 'thinset mortar adhesive',
  'mortar': 'mortar thinset adhesive',
  'backer board': 'backer board cement underlayment',
  // Common misspellings
  'pocelain': 'porcelain',
  'porcelian': 'porcelain',
  'porclain': 'porcelain',
  'procelain': 'porcelain',
  'porcelin': 'porcelain',
  'calacata': 'calacatta',
  'calacatta': 'calacatta',
  'calcatta': 'calacatta',
  'calacutta': 'calacatta',
  'cararra': 'carrara',
  'carara': 'carrara',
  'carrarra': 'carrara',
  'herringbon': 'herringbone',
  'herringbne': 'herringbone',
  'harwood': 'hardwood',
  'hadwood': 'hardwood',
  'hardwoood': 'hardwood',
  'laminent': 'laminate',
  'laminat': 'laminate',
  'lamenate': 'laminate',
  'travertene': 'travertine',
  'travertine': 'travertine',
  'travartine': 'travertine',
  'moasic': 'mosaic',
  'mosaik': 'mosaic',
  'mosiac': 'mosaic',
  'vinly': 'vinyl',
  'vinal': 'vinyl',
  'vynil': 'vinyl',
  'grout': 'grout',
  'quartz': 'quartz countertop',
  'quartzite': 'quartzite natural stone',
  'teracotta': 'terracotta',
  'teracota': 'terracotta',
  'terakotta': 'terracotta',
  'encaustic': 'encaustic cement tile',
  'zellige': 'zellige handmade tile',
};

// Live synonym dictionary — loaded from DB at startup, refreshed hourly
let searchSynonyms = { ...SEARCH_SYNONYMS };
async function loadSynonymsFromDb() {
  try {
    const res = await pool.query('SELECT term, expansion FROM search_synonyms');
    const db = {};
    for (const row of res.rows) db[row.term.toLowerCase()] = row.expansion;
    searchSynonyms = { ...SEARCH_SYNONYMS, ...db };
    console.log(`[Search] Loaded ${res.rows.length} synonyms from DB (${Object.keys(searchSynonyms).length} total)`);
  } catch (err) {
    // Table may not exist yet — fall back to hardcoded
    searchSynonyms = { ...SEARCH_SYNONYMS };
  }
}
// Load on startup, refresh hourly
loadSynonymsFromDb();
setInterval(loadSynonymsFromDb, 3600000);

function expandSynonyms(query) {
  const lower = query.toLowerCase().trim();
  if (searchSynonyms[lower]) return { text: query + ' ' + searchSynonyms[lower], expandedFrom: lower };
  const words = lower.split(/\s+/);
  let expanded = false;
  let expandedFrom = null;
  const result = [];
  // Check bigrams first, then individual words
  for (let i = 0; i < words.length; i++) {
    if (i < words.length - 1) {
      const bigram = words[i] + ' ' + words[i + 1];
      if (searchSynonyms[bigram]) {
        expanded = true;
        expandedFrom = expandedFrom || bigram;
        result.push(searchSynonyms[bigram]);
        i++; // skip next word — consumed by bigram
        continue;
      }
    }
    if (searchSynonyms[words[i]]) {
      expanded = true;
      expandedFrom = expandedFrom || words[i];
      result.push(searchSynonyms[words[i]]);
    } else {
      result.push(words[i]);
    }
  }
  if (expanded) {
    const exp = query + ' ' + result.join(' ');
    return { text: exp, expandedFrom };
  }
  return { text: query, expandedFrom: null };
}

// ==================== Query Normalization ====================

function normalizeSearchQuery(raw) {
  let q = raw;
  // Normalize dimension separators: 12"x24" → 12x24, 12" x 24" → 12x24, 6.5"x48" → 6.5x48
  q = q.replace(/(\d+(?:\.\d+)?)["″'']?\s*[xX×]\s*(\d+(?:\.\d+)?)["″'']?/g, '$1x$2');
  // Strip trailing measurement units
  q = q.replace(/\b(sqft|sq\s*ft|sf|square\s*feet)\b/gi, '');
  return q.trim();
}

// ==================== Dimension Parsing ====================

function parseDimensions(query) {
  // Match patterns like "12x24", "6.5x48", "2.5x8", "6mm", "8mm", "3/4"
  const dims = {};
  const sizeMatch = query.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/i);
  if (sizeMatch) {
    dims.width = sizeMatch[1];
    dims.height = sizeMatch[2];
    dims.sizePattern = sizeMatch[1] + 'x' + sizeMatch[2];
  }
  const thicknessMatch = query.match(/(\d+(?:\.\d+)?)\s*mm\b/i);
  if (thicknessMatch) dims.thickness = thicknessMatch[1];
  return Object.keys(dims).length > 0 ? dims : null;
}

// ==================== LRU Search Cache ====================

class SearchCache {
  constructor(maxSize, ttlMs) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttlMs) { this.cache.delete(key); return null; }
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }
  set(key, value) {
    this.cache.delete(key); // refresh position
    if (this.cache.size >= this.maxSize) {
      // Delete oldest (first entry)
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { value, ts: Date.now() });
  }
  clear() { this.cache.clear(); }
  get size() { return this.cache.size; }
}

const suggestCache = new SearchCache(500, 5 * 60 * 1000); // 5 min TTL
const popularCache = new SearchCache(1, 10 * 60 * 1000); // 10 min TTL

function clearSearchCaches() {
  suggestCache.clear();
  popularCache.clear();
}

// ==================== Storefront Search Suggest ====================

app.get('/api/storefront/search/suggest', async (req, res) => {
  try {
    const raw = (req.query.q || '').trim();
    if (!raw || raw.length < 2) return res.json({ categories: [], collections: [], products: [], total: 0 });

    const normalized = normalizeSearchQuery(raw);
    const sanitized = normalized.replace(/[^\w\s'.-]/g, '').trim();
    if (!sanitized) return res.json({ categories: [], collections: [], products: [], total: 0 });

    // Check cache first
    const cacheKey = sanitized.toLowerCase();
    const cached = suggestCache.get(cacheKey);
    if (cached) return res.json(cached);

    const { text: expanded, expandedFrom } = expandSynonyms(sanitized);
    const words = expanded.split(/\s+/).filter(Boolean);
    const andTsQuery = words.map(w => w + ':*').join(' & ');
    const orTsQuery = words.map(w => w + ':*').join(' | ');
    const phraseInput = expanded;
    const dims = parseDimensions(sanitized);

    // Detect SKU-like patterns (letters+digits+hyphens, at least one digit and one letter)
    const isSkuLike = /[a-zA-Z]/.test(sanitized) && /\d/.test(sanitized) && /^[\w.-]+$/.test(sanitized.replace(/\s/g, ''));

    // SKU fast path — direct ILIKE prefix match on vendor_sku / internal_sku
    let skuDirectRows = [];
    if (isSkuLike) {
      const skuSearch = sanitized.replace(/\s+/g, '');
      const skuResult = await pool.query(`
        SELECT s.id as sku_id, s.product_id, COALESCE(p.display_name, p.name) as product_name, p.collection, s.variant_name,
          s.vendor_sku, s.internal_sku,
          v.name as vendor_name,
          pr.retail_price, pr.price_basis, s.sell_by, pk.sqft_per_box,
          CASE WHEN pr.sale_price IS NOT NULL AND (pr.sale_ends_at IS NULL OR pr.sale_ends_at > NOW()) THEN pr.sale_price ELSE NULL END as sale_price,
          COALESCE(
            (SELECT url FROM media_assets WHERE sku_id = s.id AND asset_type = 'primary' LIMIT 1),
            (SELECT url FROM media_assets WHERE product_id = p.id AND asset_type = 'primary' AND sku_id IS NULL LIMIT 1),
            (SELECT url FROM media_assets WHERE sku_id = s.id AND asset_type IN ('alternate','lifestyle') LIMIT 1),
            (SELECT url FROM media_assets WHERE product_id = p.id AND asset_type IN ('alternate','lifestyle') AND sku_id IS NULL LIMIT 1)
          ) as primary_image
        FROM skus s
        JOIN products p ON p.id = s.product_id AND p.status = 'active'
        JOIN vendors v ON v.id = p.vendor_id
        LEFT JOIN pricing pr ON pr.sku_id = s.id
        LEFT JOIN packaging pk ON pk.sku_id = s.id
        WHERE s.status = 'active' AND s.is_sample = false
          AND (s.vendor_sku ILIKE $1 || '%' OR s.internal_sku ILIKE $1 || '%')
        ORDER BY CASE WHEN LOWER(s.vendor_sku) = LOWER($1) THEN 0 WHEN LOWER(s.internal_sku) = LOWER($1) THEN 0 ELSE 1 END,
                 s.vendor_sku
        LIMIT 4
      `, [skuSearch]);
      skuDirectRows = skuResult.rows;
    }

    // Run categories, collections, and progressive FTS product search in parallel
    const [catResult, colResult, ftsResult] = await Promise.all([
      // Categories — trigram + ILIKE (small table, fast)
      pool.query(`
        SELECT c.name, c.slug, c.image_url, COUNT(DISTINCT p.id) as product_count
        FROM categories c
        JOIN products p ON p.category_id = c.id
        WHERE p.status = 'active'
          AND (c.name % $1 OR c.name ILIKE '%' || $1 || '%')
        GROUP BY c.id
        ORDER BY similarity(c.name, $1) DESC
        LIMIT 3
      `, [sanitized]),

      // Collections — trigram + ILIKE on products.collection
      pool.query(`
        SELECT p.collection, COUNT(DISTINCT p.id) as product_count,
          MIN(ma.url) FILTER (WHERE ma.asset_type = 'primary' AND ma.sku_id IS NULL) as image
        FROM products p
        LEFT JOIN media_assets ma ON ma.product_id = p.id
        WHERE p.status = 'active'
          AND p.collection != ''
          AND (p.collection % $1 OR p.collection ILIKE '%' || $1 || '%')
        GROUP BY p.collection
        ORDER BY similarity(p.collection, $1) DESC
        LIMIT 3
      `, [sanitized]),

      // Products — Progressive FTS: phrase → AND → OR cascade in one query
      pool.query(`
        WITH phrase_products AS (
          SELECT p.id,
            ts_rank(p.search_vector, phraseto_tsquery('english', unaccent($3))) * 4.0 as score,
            'phrase' as match_tier
          FROM products p
          WHERE p.status = 'active'
            AND p.search_vector @@ phraseto_tsquery('english', unaccent($3))
          LIMIT 12
        ),
        and_products AS (
          SELECT p.id,
            ts_rank(p.search_vector, to_tsquery('english', unaccent($1))) * 2.0 as score,
            'and' as match_tier
          FROM products p
          WHERE p.status = 'active'
            AND p.search_vector @@ to_tsquery('english', unaccent($1))
            AND p.id NOT IN (SELECT id FROM phrase_products)
          LIMIT 12
        ),
        or_products AS (
          SELECT p.id,
            ts_rank(p.search_vector, to_tsquery('english', unaccent($2))) * 0.5 as score,
            'or' as match_tier
          FROM products p
          WHERE p.status = 'active'
            AND p.search_vector @@ to_tsquery('english', unaccent($2))
            AND p.id NOT IN (SELECT id FROM phrase_products)
            AND p.id NOT IN (SELECT id FROM and_products)
            AND (SELECT COUNT(*) FROM phrase_products) + (SELECT COUNT(*) FROM and_products) < 12
          LIMIT 12
        ),
        all_matches AS (
          SELECT * FROM phrase_products
          UNION ALL SELECT * FROM and_products
          UNION ALL SELECT * FROM or_products
        ),
        ranked AS (
          SELECT am.id, am.score + COALESCE(pp.popularity_score, 0) * 0.1
            + CASE WHEN LOWER(p.name) = LOWER($4) OR LOWER(p.collection) = LOWER($4) THEN 5.0 ELSE 0.0 END as final_score,
            COUNT(*) OVER() as total_count
          FROM all_matches am
          JOIN products p ON p.id = am.id
          LEFT JOIN product_popularity pp ON pp.product_id = am.id
          ORDER BY am.score + COALESCE(pp.popularity_score, 0) * 0.1
            + CASE WHEN LOWER(p.name) = LOWER($4) OR LOWER(p.collection) = LOWER($4) THEN 5.0 ELSE 0.0 END DESC
          LIMIT 8
        ),
        top_skus AS (
          SELECT DISTINCT ON (r.id)
            s.id as sku_id, r.id as product_id, COALESCE(p.display_name, p.name) as product_name, p.collection, s.variant_name,
            s.vendor_sku,
            v.name as vendor_name,
            pr.retail_price, pr.price_basis, s.sell_by, pk.sqft_per_box,
            CASE WHEN pr.sale_price IS NOT NULL AND (pr.sale_ends_at IS NULL OR pr.sale_ends_at > NOW()) THEN pr.sale_price ELSE NULL END as sale_price,
            r.final_score, r.total_count
          FROM ranked r
          JOIN products p ON p.id = r.id
          JOIN vendors v ON v.id = p.vendor_id
          JOIN skus s ON s.product_id = r.id AND s.status = 'active' AND s.is_sample = false AND COALESCE(s.variant_type, '') != 'accessory'
          LEFT JOIN pricing pr ON pr.sku_id = s.id
          LEFT JOIN packaging pk ON pk.sku_id = s.id
          ORDER BY r.id, s.created_at
        )
        SELECT ts.*,
          COALESCE(
            (SELECT url FROM media_assets WHERE sku_id = ts.sku_id AND asset_type = 'primary' LIMIT 1),
            (SELECT url FROM media_assets WHERE product_id = ts.product_id AND asset_type = 'primary' AND sku_id IS NULL LIMIT 1),
            (SELECT url FROM media_assets WHERE sku_id = ts.sku_id AND asset_type IN ('alternate','lifestyle') LIMIT 1),
            (SELECT url FROM media_assets WHERE product_id = ts.product_id AND asset_type IN ('alternate','lifestyle') AND sku_id IS NULL LIMIT 1)
          ) as primary_image
        FROM top_skus ts
        ORDER BY ts.final_score DESC
        LIMIT 6
      `, [andTsQuery, orTsQuery, phraseInput, sanitized])
    ]);

    // Merge SKU direct results (priority) + FTS results
    let prodRows = ftsResult.rows;
    let totalCount = prodRows.length > 0 ? parseInt(prodRows[0].total_count) : 0;

    // Insert SKU direct matches at the top (deduplicate by sku_id)
    if (skuDirectRows.length > 0) {
      const ftsSkuIds = new Set(prodRows.map(r => r.sku_id));
      const uniqueSkuRows = skuDirectRows.filter(r => !ftsSkuIds.has(r.sku_id));
      prodRows = [...uniqueSkuRows, ...prodRows];
      totalCount += uniqueSkuRows.length;
    }

    // If still fewer than 6 products, try trigram fallback
    if (prodRows.length < 6) {
      const existingIds = prodRows.map(r => r.product_id).filter(Boolean);
      const trgmResult = await pool.query(`
        WITH trgm_products AS (
          SELECT p.id, greatest(similarity(p.name, $1), similarity(p.collection, $1)) as trgm_score
          FROM products p
          WHERE p.status = 'active'
            AND (p.name % $1 OR p.collection % $1)
            ${existingIds.length > 0 ? 'AND p.id != ALL($2::uuid[])' : ''}
          ORDER BY greatest(similarity(p.name, $1), similarity(p.collection, $1)) DESC
          LIMIT 8
        ),
        top_skus AS (
          SELECT DISTINCT ON (tp.id)
            s.id as sku_id, tp.id as product_id, COALESCE(p.display_name, p.name) as product_name, p.collection, s.variant_name,
            s.vendor_sku,
            v.name as vendor_name,
            pr.retail_price, pr.price_basis, s.sell_by, pk.sqft_per_box,
            CASE WHEN pr.sale_price IS NOT NULL AND (pr.sale_ends_at IS NULL OR pr.sale_ends_at > NOW()) THEN pr.sale_price ELSE NULL END as sale_price,
            0::float as final_score, tp.trgm_score
          FROM trgm_products tp
          JOIN products p ON p.id = tp.id
          JOIN vendors v ON v.id = p.vendor_id
          JOIN skus s ON s.product_id = tp.id AND s.status = 'active' AND s.is_sample = false AND COALESCE(s.variant_type, '') != 'accessory'
          LEFT JOIN pricing pr ON pr.sku_id = s.id
          LEFT JOIN packaging pk ON pk.sku_id = s.id
          ORDER BY tp.id, s.created_at
        )
        SELECT ts.*,
          COALESCE(
            (SELECT url FROM media_assets WHERE sku_id = ts.sku_id AND asset_type = 'primary' LIMIT 1),
            (SELECT url FROM media_assets WHERE product_id = ts.product_id AND asset_type = 'primary' AND sku_id IS NULL LIMIT 1),
            (SELECT url FROM media_assets WHERE sku_id = ts.sku_id AND asset_type IN ('alternate','lifestyle') LIMIT 1),
            (SELECT url FROM media_assets WHERE product_id = ts.product_id AND asset_type IN ('alternate','lifestyle') AND sku_id IS NULL LIMIT 1)
          ) as primary_image
        FROM top_skus ts
        ORDER BY ts.trgm_score DESC
        LIMIT 6
      `, existingIds.length > 0 ? [sanitized, existingIds] : [sanitized]);

      const trgmRows = trgmResult.rows;
      totalCount += trgmRows.length;
      prodRows = prodRows.concat(trgmRows);
    }

    // Dimension scoring boost — re-sort if dimensions detected
    if (dims && dims.sizePattern && prodRows.length > 0) {
      const skuIds = prodRows.map(r => r.sku_id);
      const dimResult = await pool.query(`
        SELECT sa.sku_id FROM sku_attributes sa
        JOIN attributes a ON a.id = sa.attribute_id
        WHERE sa.sku_id = ANY($1) AND a.slug = 'size' AND sa.value ILIKE '%' || $2 || '%'
      `, [skuIds, dims.sizePattern]);
      const matchingSkuIds = new Set(dimResult.rows.map(r => r.sku_id));
      // Boost matching products by moving them up
      prodRows.sort((a, b) => {
        const aMatch = matchingSkuIds.has(a.sku_id) ? 1 : 0;
        const bMatch = matchingSkuIds.has(b.sku_id) ? 1 : 0;
        if (aMatch !== bMatch) return bMatch - aMatch;
        const scoreA = parseFloat(a.final_score || 0) + parseFloat(a.trgm_score || 0);
        const scoreB = parseFloat(b.final_score || 0) + parseFloat(b.trgm_score || 0);
        return scoreB - scoreA;
      });
    }

    prodRows = prodRows.slice(0, 6);

    // Did-you-mean: if zero product results, try spelling correction
    let didYouMean = null;
    if (prodRows.length === 0) {
      try {
        const queryWords = sanitized.toLowerCase().split(/\s+/).filter(Boolean);
        const corrections = [];
        for (const word of queryWords) {
          if (word.length < 3) { corrections.push(word); continue; }
          const vocabResult = await pool.query(`
            SELECT term, similarity(term, $1) as sim
            FROM search_vocabulary
            WHERE term % $1 AND similarity(term, $1) > 0.3
            ORDER BY similarity(term, $1) DESC
            LIMIT 1
          `, [word]);
          if (vocabResult.rows.length > 0 && vocabResult.rows[0].term !== word) {
            corrections.push(vocabResult.rows[0].term);
          } else {
            corrections.push(word);
          }
        }
        const corrected = corrections.join(' ');
        if (corrected !== sanitized.toLowerCase()) {
          didYouMean = corrected;
        }
      } catch (err) {
        // search_vocabulary may not exist yet — skip
      }
    }

    const result = {
      categories: catResult.rows.map(r => ({ name: r.name, slug: r.slug, image_url: r.image_url, product_count: parseInt(r.product_count) })),
      collections: colResult.rows.map(r => ({ name: r.collection, product_count: parseInt(r.product_count), image: r.image })),
      products: prodRows.map(r => ({
        sku_id: r.sku_id, product_name: r.product_name, collection: r.collection,
        variant_name: r.variant_name, vendor_name: r.vendor_name, primary_image: r.primary_image,
        vendor_sku: r.vendor_sku,
        retail_price: r.retail_price, price_basis: r.price_basis, sell_by: r.sell_by, sqft_per_box: r.sqft_per_box, sale_price: r.sale_price
      })),
      total: totalCount,
      ...(didYouMean ? { didYouMean } : {}),
      ...(expandedFrom ? { expandedFrom, expandedTo: expanded } : {})
    };

    // Cache the result
    suggestCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('Search suggest error:', err);
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/storefront/search/popular', async (req, res) => {
  try {
    const cached = popularCache.get('popular');
    if (cached) return res.json(cached);
    const result = await pool.query(`
      SELECT properties->>'query' as term, COUNT(*) as cnt
      FROM analytics_events
      WHERE event_type = 'search'
        AND properties->>'query' IS NOT NULL
        AND properties->>'query' != ''
        AND created_at > NOW() - INTERVAL '30 days'
      GROUP BY properties->>'query'
      HAVING COUNT(*) >= 2
      ORDER BY cnt DESC
      LIMIT 8
    `);
    const data = { terms: result.rows.map(r => r.term) };
    popularCache.set('popular', data);
    res.json(data);
  } catch (err) {
    console.error('Popular searches error:', err);
    res.json({ terms: ['marble tile', 'porcelain', 'calacatta', 'wood look', 'mosaic', 'subway tile', '12x24', 'herringbone'] });
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
    let whereClauses = ["p.status = 'active'", "s.is_sample = false", "s.status = 'active'", "COALESCE(s.variant_type, '') NOT IN ('accessory','trim','floor_trim','wall_trim','lvt_trim','quarry_trim','mosaic_trim')",
      "p.collection NOT LIKE 'AHF%'", "(pr.retail_price IS NULL OR pr.retail_price > 0)"];

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

    // Search — Progressive FTS (AND → OR cascade) + trigram hybrid (with synonym expansion)
    let searchParamIdx = null;
    let searchTsQueryIdx = null;
    let searchOrTsQueryIdx = null;
    if (searchTerm) {
      const normalized = normalizeSearchQuery(searchTerm);
      const sanitized = normalized.replace(/[^\w\s'.-]/g, '').trim();
      if (sanitized) {
        params.push(sanitized);
        searchParamIdx = paramIndex;
        paramIndex++;
        const { text: expanded } = expandSynonyms(sanitized);
        const words = expanded.split(/\s+/).filter(Boolean);
        const andTsQuery = words.map(w => w + ':*').join(' & ');
        const orTsQuery = words.map(w => w + ':*').join(' | ');
        params.push(andTsQuery);
        searchTsQueryIdx = paramIndex;
        paramIndex++;
        params.push(orTsQuery);
        searchOrTsQueryIdx = paramIndex;
        paramIndex++;
        whereClauses.push(`(
          p.search_vector @@ to_tsquery('english', unaccent($${searchTsQueryIdx}))
          OR p.search_vector @@ to_tsquery('english', unaccent($${searchOrTsQueryIdx}))
          OR p.name % $${searchParamIdx}
          OR p.collection % $${searchParamIdx}
          OR (p.collection || ' ' || p.name) ILIKE '%' || $${searchParamIdx} || '%'
          OR s.vendor_sku ILIKE $${searchParamIdx} || '%'
          OR s.internal_sku ILIKE $${searchParamIdx} || '%'
        )`);
      }
    }

    // Product IDs filter (for wishlist)
    if (req.query.product_ids) {
      const pids = req.query.product_ids.split(',').filter(Boolean);
      if (pids.length > 0) {
        const pidPlaceholders = pids.map(pid => { params.push(pid); return `$${paramIndex++}`; });
        whereClauses.push(`p.id IN (${pidPlaceholders.join(',')})`);
      }
    }

    // Vendor filter
    if (req.query.vendor) {
      const vendorNames = req.query.vendor.split('|').map(v => v.trim()).filter(Boolean);
      const vendorPlaceholders = vendorNames.map(v => { params.push(v); return `$${paramIndex++}`; });
      whereClauses.push(`v.name IN (${vendorPlaceholders.join(',')})`);
    }

    // Price range filters
    if (req.query.price_min) {
      params.push(parseFloat(req.query.price_min));
      whereClauses.push(`pr.retail_price >= $${paramIndex++}`);
    }
    if (req.query.price_max) {
      params.push(parseFloat(req.query.price_max));
      whereClauses.push(`pr.retail_price <= $${paramIndex++}`);
    }

    // Attribute filters: any query param matching an attribute slug
    // Sale filter
    if (req.query.sale === 'true') {
      whereClauses.push("pr.sale_price IS NOT NULL AND (pr.sale_ends_at IS NULL OR pr.sale_ends_at > NOW())");
    }

    // Tag filter
    if (req.query.tags) {
      const tagSlugs = req.query.tags.split('|').filter(Boolean);
      const tagPlaceholders = tagSlugs.map(t => { params.push(t); return `$${paramIndex++}`; });
      whereClauses.push(`p.id IN (SELECT pt.product_id FROM product_tags pt JOIN tag_definitions td ON td.id = pt.tag_id WHERE td.slug IN (${tagPlaceholders.join(',')}))`);
    }

    const reservedParams = ['category', 'collection', 'search', 'q', 'sort', 'limit', 'offset', 'product_ids', 'vendor', 'price_min', 'price_max', 'sale', 'tags'];
    const attrFilters = {};
    for (const [key, val] of Object.entries(req.query)) {
      if (!reservedParams.includes(key) && val) {
        attrFilters[key] = val.split('|').map(v => v.trim()).filter(Boolean);
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

    // Sort — relevance-first when searching (unless user explicitly chose a sort)
    let orderBy = 'CASE WHEN primary_image IS NOT NULL THEN 0 ELSE 1 END, product_name ASC, variant_name ASC';
    if (sort === 'discount') orderBy = 'CASE WHEN sale_price IS NOT NULL AND retail_price > 0 THEN (retail_price - sale_price) / retail_price ELSE 0 END DESC, product_name ASC';
    else if (sort === 'price_asc') orderBy = 'retail_price ASC NULLS LAST, product_name ASC';
    else if (sort === 'price_desc') orderBy = 'retail_price DESC NULLS LAST, product_name ASC';
    else if (sort === 'newest') orderBy = 'created_at DESC';
    else if (sort === 'name_asc') orderBy = 'product_name ASC, variant_name ASC';
    else if (sort === 'name_desc') orderBy = 'product_name DESC, variant_name DESC';
    else if (searchParamIdx && !sort) {
      orderBy = `(
        COALESCE(ts_rank(search_vector, to_tsquery('english', unaccent($${searchTsQueryIdx}))), 0) * 2
        + greatest(similarity(product_name, $${searchParamIdx}), similarity(collection, $${searchParamIdx}))
        + COALESCE(popularity_score, 0) * 0.1
        + CASE WHEN LOWER(product_name) = LOWER($${searchParamIdx}) OR LOWER(collection) = LOWER($${searchParamIdx}) THEN 5.0 ELSE 0.0 END
      ) DESC, product_name ASC`;
    }

    // Count query — count distinct products, not individual SKUs
    const countSQL = `
      SELECT COUNT(DISTINCT p.id) as total
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
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
      sku_alt_images AS (
        SELECT DISTINCT ON (sku_id) sku_id, url
        FROM media_assets
        WHERE asset_type = 'alternate' AND sku_id IS NOT NULL
        ORDER BY sku_id, sort_order
      ),
      product_alt_images AS (
        SELECT DISTINCT ON (product_id) product_id, url
        FROM media_assets
        WHERE asset_type = 'alternate' AND sku_id IS NULL
        ORDER BY product_id, sort_order
      ),
      sku_any_images AS (
        SELECT DISTINCT ON (sku_id) sku_id, url
        FROM media_assets
        WHERE asset_type = 'alternate' AND sku_id IS NOT NULL
        ORDER BY sku_id, sort_order
      ),
      product_any_images AS (
        SELECT DISTINCT ON (product_id) product_id, url
        FROM media_assets
        WHERE asset_type = 'alternate' AND sku_id IS NULL
        ORDER BY product_id, sort_order
      ),
      sibling_images AS (
        SELECT DISTINCT ON (s2.product_id) s2.product_id, ma.url
        FROM media_assets ma
        JOIN skus s2 ON s2.id = ma.sku_id
        WHERE ma.asset_type = 'primary' AND ma.sku_id IS NOT NULL
        ORDER BY s2.product_id, ma.sort_order
      ),
      variant_counts AS (
        SELECT product_id, COUNT(*) as variant_count
        FROM skus
        WHERE status = 'active' AND is_sample = false AND COALESCE(variant_type, '') NOT IN ('accessory','trim','floor_trim','wall_trim','lvt_trim','quarry_trim','mosaic_trim')
        GROUP BY product_id
      )
      SELECT * FROM (
        SELECT DISTINCT ON (p.id)
          s.id as sku_id, s.product_id, s.variant_name, s.internal_sku, s.vendor_sku, s.sell_by, s.created_at,
          COALESCE(p.display_name, p.name) as product_name, p.collection, p.description_short, p.search_vector,
          p.slug as product_slug,
          v.name as vendor_name,
          COALESCE(v.has_public_inventory, false) as vendor_has_inventory,
          c.name as category_name, c.slug as category_slug,
          pr.retail_price, pr.price_basis, pr.cut_price,
          CASE WHEN pr.sale_price IS NOT NULL AND (pr.sale_ends_at IS NULL OR pr.sale_ends_at > NOW()) THEN pr.sale_price ELSE NULL END as sale_price,
          pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs,
          COALESCE(si.url, pi.url, sany.url, pany.url, sib.url) as primary_image,
          COALESCE(sai.url, pai.url) as alternate_image,
          CASE
            WHEN inv.fresh_until IS NULL OR inv.fresh_until <= NOW() THEN 'unknown'
            WHEN inv.qty_on_hand > 10 THEN 'in_stock'
            WHEN inv.qty_on_hand > 0 THEN 'low_stock'
            ELSE 'out_of_stock'
          END as stock_status,
          COALESCE(vc.variant_count, 0) as variant_count,
          COALESCE(pp.popularity_score, 0) as popularity_score
        FROM skus s
        JOIN products p ON p.id = s.product_id
        JOIN vendors v ON v.id = p.vendor_id
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN pricing pr ON pr.sku_id = s.id
        LEFT JOIN packaging pk ON pk.sku_id = s.id
        LEFT JOIN inventory_snapshots inv ON inv.sku_id = s.id AND inv.warehouse = 'default'
        LEFT JOIN sku_images si ON si.sku_id = s.id
        LEFT JOIN product_images pi ON pi.product_id = p.id
        LEFT JOIN sku_alt_images sai ON sai.sku_id = s.id
        LEFT JOIN product_alt_images pai ON pai.product_id = p.id
        LEFT JOIN sku_any_images sany ON sany.sku_id = s.id
        LEFT JOIN product_any_images pany ON pany.product_id = p.id
        LEFT JOIN sibling_images sib ON sib.product_id = p.id
        LEFT JOIN variant_counts vc ON vc.product_id = p.id
        LEFT JOIN product_popularity pp ON pp.product_id = p.id
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

    // Did-you-mean for browse with zero results + search query
    let didYouMean = null;
    if (total === 0 && searchTerm) {
      try {
        const queryWords = searchTerm.toLowerCase().replace(/[^\w\s'.-]/g, '').trim().split(/\s+/).filter(Boolean);
        const corrections = [];
        for (const word of queryWords) {
          if (word.length < 3) { corrections.push(word); continue; }
          const vocabResult = await pool.query(`
            SELECT term, similarity(term, $1) as sim
            FROM search_vocabulary
            WHERE term % $1 AND similarity(term, $1) > 0.3
            ORDER BY similarity(term, $1) DESC LIMIT 1
          `, [word]);
          corrections.push(vocabResult.rows.length > 0 && vocabResult.rows[0].term !== word ? vocabResult.rows[0].term : word);
        }
        const corrected = corrections.join(' ');
        if (corrected !== searchTerm.toLowerCase().replace(/[^\w\s'.-]/g, '').trim()) didYouMean = corrected;
      } catch (e) { /* search_vocabulary may not exist */ }
    }

    const response = { skus: skus.map(({ search_vector, popularity_score, ...rest }) => rest), total };
    if (didYouMean) response.didYouMean = didYouMean;
    res.json(response);
  } catch (err) {
    console.error('Storefront SKU browse error:', err);
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Compare up to 4 SKUs side-by-side
app.get('/api/storefront/skus/compare', async (req, res) => {
  try {
    const idsParam = req.query.ids || '';
    const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 4);
    if (ids.length < 2) return res.status(400).json({ error: 'Provide at least 2 SKU ids' });

    const result = await pool.query(`
      SELECT
        s.id as sku_id, s.variant_name, s.sell_by,
        COALESCE(p.display_name, p.name) as product_name, p.collection,
        v.name as vendor_name,
        c.name as category_name,
        pr.retail_price, pr.price_basis,
        CASE WHEN pr.sale_price IS NOT NULL AND (pr.sale_ends_at IS NULL OR pr.sale_ends_at > NOW()) THEN pr.sale_price ELSE NULL END as sale_price,
        pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs,
        COALESCE(
          (SELECT ma.url FROM media_assets ma WHERE ma.sku_id = s.id AND ma.asset_type = 'primary' ORDER BY ma.sort_order LIMIT 1),
          (SELECT ma.url FROM media_assets ma WHERE ma.product_id = p.id AND ma.sku_id IS NULL AND ma.asset_type = 'primary' ORDER BY ma.sort_order LIMIT 1)
        ) as primary_image
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      LEFT JOIN packaging pk ON pk.sku_id = s.id
      WHERE s.id = ANY($1)
    `, [ids]);

    // Fetch attributes for all
    const attrResult = await pool.query(`
      SELECT sa.sku_id, a.name, a.slug, sa.value
      FROM sku_attributes sa
      JOIN attributes a ON a.id = sa.attribute_id
      WHERE sa.sku_id = ANY($1)
      ORDER BY a.display_order, a.name
    `, [ids]);

    const attrMap = {};
    for (const row of attrResult.rows) {
      if (!attrMap[row.sku_id]) attrMap[row.sku_id] = [];
      attrMap[row.sku_id].push({ slug: row.slug, name: row.name, value: row.value });
    }

    const skus = result.rows.map(s => ({ ...s, attributes: attrMap[s.sku_id] || [] }));
    // Preserve requested order
    const ordered = ids.map(id => skus.find(s => s.sku_id === id)).filter(Boolean);

    res.json({ skus: ordered });
  } catch (err) {
    console.error('SKU compare error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Slug-based product detail ====================
app.get('/api/storefront/products/:categorySlug/:productSlug', optionalTradeAuth, async (req, res) => {
  try {
    const { categorySlug, productSlug } = req.params;

    // Look up product by category slug + product slug
    const productResult = await pool.query(`
      SELECT p.id as product_id
      FROM products p
      JOIN categories c ON c.id = p.category_id
      WHERE c.slug = $1 AND p.slug = $2 AND p.status = 'active'
      LIMIT 1
    `, [categorySlug, productSlug]);

    if (!productResult.rows.length) return res.status(404).json({ error: 'Product not found' });
    const productId = productResult.rows[0].product_id;

    // Find the default SKU (first non-accessory SKU)
    const defaultSku = await pool.query(`
      SELECT id FROM skus
      WHERE product_id = $1 AND status = 'active' AND is_sample = false
        AND COALESCE(variant_type, '') NOT IN ('accessory','trim','floor_trim','wall_trim','lvt_trim','quarry_trim','mosaic_trim')
      ORDER BY created_at
      LIMIT 1
    `, [productId]);

    if (!defaultSku.rows.length) return res.status(404).json({ error: 'No active SKUs found' });

    // Return the default SKU ID so the frontend can fetch full detail via /api/storefront/skus/:id
    res.json({ resolve_sku_id: defaultSku.rows[0].id });
  } catch (err) {
    console.error('Storefront product slug detail error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== SKU redirect (old UUID → new slugs) ====================
app.get('/api/storefront/sku-redirect/:skuId', async (req, res) => {
  try {
    const { skuId } = req.params;
    const result = await pool.query(`
      SELECT p.slug as product_slug, c.slug as category_slug
      FROM skus s
      JOIN products p ON p.id = s.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE s.id = $1
    `, [skuId]);

    if (!result.rows.length || !result.rows[0].product_slug || !result.rows[0].category_slug) {
      return res.status(404).json({ error: 'Slug not found' });
    }

    res.json({
      categorySlug: result.rows[0].category_slug,
      productSlug: result.rows[0].product_slug
    });
  } catch (err) {
    console.error('SKU redirect lookup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/storefront/skus/:skuId', optionalTradeAuth, async (req, res) => {
  try {
    const { skuId } = req.params;

    // Main SKU query with full details
    const skuResult = await pool.query(`
      SELECT
        s.id as sku_id, s.product_id, s.variant_name, s.internal_sku, s.vendor_sku, s.sell_by, s.variant_type,
        COALESCE(p.display_name, p.name) as product_name, p.collection, p.category_id, p.description_long, p.description_short,
        p.slug as product_slug,
        v.name as vendor_name, v.code as vendor_code,
        COALESCE(v.has_public_inventory, false) as vendor_has_inventory,
        c.name as category_name, c.slug as category_slug,
        pr.retail_price, pr.cost, pr.price_basis,
        pr.cut_price, pr.roll_price, pr.cut_cost, pr.roll_cost, pr.roll_min_sqft,
        pr.sale_price, pr.sale_ends_at,
        pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs, pk.freight_class,
        pk.boxes_per_pallet, pk.sqft_per_pallet, pk.weight_per_pallet_lbs,
        pk.roll_width_ft, pk.roll_length_ft,
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

    // Nullify expired sales
    if (sku.sale_price && sku.sale_ends_at && new Date(sku.sale_ends_at) <= new Date()) {
      sku.sale_price = null;
      sku.sale_ends_at = null;
    }

    // Accessories that share a product with non-accessory SKUs redirect to the parent
    // Standalone accessory products (e.g. "Console Base") render their own page
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
      // No non-accessory sibling — this is a standalone product, render normally
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
    const isAdexVendor = /adex/i.test(sku.vendor_name || '');
    if (skuMediaResult.rows.length > 0) {
      // SKU has its own images — also include product-level lifestyle (room scenes)
      // For ADEX: also include product-level alternate (shape drawing) as the primary display image
      const extraTypes = isAdexVendor ? "'lifestyle','alternate'" : "'lifestyle'";
      const productExtra = await pool.query(`
        SELECT id, asset_type, url, sort_order, sku_id
        FROM media_assets
        WHERE product_id = $1 AND sku_id IS NULL AND asset_type IN (${extraTypes})
        ORDER BY CASE asset_type WHEN 'alternate' THEN 0 WHEN 'lifestyle' THEN 1 ELSE 2 END, sort_order
      `, [sku.product_id]);
      if (isAdexVendor) {
        // For ADEX: show shape image first, then SKU color swatch, then lifestyle
        mediaResult = { rows: [...productExtra.rows, ...skuMediaResult.rows] };
      } else {
        mediaResult = { rows: [...skuMediaResult.rows, ...productExtra.rows] };
      }
    } else {
      // No SKU images — fall back to product-level primary/alternate only (not lifestyle,
      // which would show a random color variant's room scene)
      mediaResult = await pool.query(`
        SELECT id, asset_type, url, sort_order, sku_id
        FROM media_assets
        WHERE product_id = $1 AND sku_id IS NULL AND asset_type IN ('primary', 'alternate')
        ORDER BY CASE asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 ELSE 2 END, sort_order
      `, [sku.product_id]);

      // If still no images, fall back to first sibling SKU's primary image
      if (mediaResult.rows.length === 0) {
        mediaResult = await pool.query(`
          SELECT id, asset_type, url, sort_order, sku_id
          FROM media_assets
          WHERE product_id = $1 AND sku_id IS NOT NULL AND asset_type = 'primary'
          ORDER BY sort_order
          LIMIT 1
        `, [sku.product_id]);
      }
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
        s.id as sku_id, s.variant_name, s.internal_sku, s.vendor_sku, s.variant_type, s.sell_by,
        pr.retail_price, pr.price_basis, pk.sqft_per_box,
        CASE WHEN pr.sale_price IS NOT NULL AND (pr.sale_ends_at IS NULL OR pr.sale_ends_at > NOW()) THEN pr.sale_price ELSE NULL END as sale_price,
        COALESCE(
          (SELECT ma.url FROM media_assets ma WHERE ma.sku_id = s.id AND ma.asset_type = 'primary' ORDER BY ma.sort_order LIMIT 1),
          (SELECT ma.url FROM media_assets ma WHERE ma.product_id = s.product_id AND ma.sku_id IS NULL AND ma.asset_type = 'primary' ORDER BY ma.sort_order LIMIT 1),
          (SELECT ma.url FROM media_assets ma WHERE ma.sku_id = s.id AND ma.asset_type IN ('alternate','lifestyle') ORDER BY ma.sort_order LIMIT 1),
          (SELECT ma.url FROM media_assets ma WHERE ma.product_id = s.product_id AND ma.sku_id IS NULL AND ma.asset_type IN ('alternate','lifestyle') ORDER BY ma.sort_order LIMIT 1)
        ) as primary_image,
        (SELECT ma.url FROM media_assets ma WHERE ma.sku_id = s.id AND ma.asset_type = 'primary' ORDER BY ma.sort_order LIMIT 1) as sku_image,
        (SELECT ma.url FROM media_assets ma
         JOIN skus s_top ON s_top.id = ma.sku_id AND ma.asset_type = 'primary'
         JOIN sku_attributes sa_ref ON sa_ref.sku_id = s.id
         JOIN attributes a_ref ON a_ref.id = sa_ref.attribute_id AND a_ref.slug = 'top_ref_sku'
         WHERE s_top.vendor_sku IN (sa_ref.value || '-SNK', sa_ref.value, regexp_replace(sa_ref.value, '-([^-]+)$', '-BS-\\1'))
         LIMIT 1) as countertop_image,
        CASE
          WHEN inv.fresh_until IS NULL OR inv.fresh_until <= NOW() THEN 'unknown'
          WHEN inv.qty_on_hand > 10 THEN 'in_stock'
          WHEN inv.qty_on_hand > 0 THEN 'low_stock'
          ELSE 'out_of_stock'
        END as stock_status
      FROM skus s
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      LEFT JOIN packaging pk ON pk.sku_id = s.id
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

    // Cross-product accessory suggestions (for vendors like Shaw where accessories
    // live in separate type-based products: "T Molding", "Round Stair Tread", etc.)
    // Uses companion_skus attribute — the authoritative mapping of accessories to
    // a specific main SKU's color. Color_code matching was evaluated as a fallback
    // but rejected: Shaw's color_codes are reused across many unrelated colors
    // (same code = different shades in different collections), so fuzzy matches
    // would mislead users.
    let crossProductAccessories = [];
    const companionSkusAttrX = (sku.attributes || []).find(a => a.slug === 'companion_skus');
    const companionVskus = companionSkusAttrX
      ? companionSkusAttrX.value.split(',').map(s => s.trim()).filter(Boolean)
      : [];

    if (companionVskus.length > 0 && sku.variant_type !== 'accessory') {
      const vendorRow = await pool.query(`SELECT vendor_id FROM products WHERE id = $1`, [sku.product_id]);
      const vendorIdX = vendorRow.rows[0]?.vendor_id;
      if (vendorIdX) {
        const cpaResult = await pool.query(`
          SELECT DISTINCT ON (s.product_id)
            s.id as sku_id, s.variant_name, s.sell_by,
            COALESCE(p.display_name, p.name) as product_name, p.id as accessory_product_id,
            pr.retail_price, pr.price_basis, pk.sqft_per_box,
            CASE WHEN pr.sale_price IS NOT NULL AND (pr.sale_ends_at IS NULL OR pr.sale_ends_at > NOW()) THEN pr.sale_price ELSE NULL END as sale_price,
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
          JOIN products p ON p.id = s.product_id AND p.status = 'active'
          LEFT JOIN categories c ON c.id = p.category_id
          LEFT JOIN pricing pr ON pr.sku_id = s.id
          LEFT JOIN packaging pk ON pk.sku_id = s.id
          LEFT JOIN inventory_snapshots inv ON inv.sku_id = s.id AND inv.warehouse = 'default'
          WHERE p.vendor_id = $1 AND s.status = 'active' AND s.is_sample = false
            AND s.product_id != $2
            AND c.name IN ('Transitions & Moldings','Wall Base','Installation & Sundries','Adhesives & Sealants','Underlayment')
            AND s.vendor_sku = ANY($3::text[])
          ORDER BY s.product_id, s.created_at
          LIMIT 30
        `, [vendorIdX, sku.product_id, companionVskus]);

        if (cpaResult.rows.length > 0) {
          const ids = cpaResult.rows.map(r => r.sku_id);
          const attrRes = await pool.query(`
            SELECT sa.sku_id, a.name, a.slug, sa.value
            FROM sku_attributes sa
            JOIN attributes a ON a.id = sa.attribute_id
            WHERE sa.sku_id = ANY($1) AND a.slug IN ('size','finish')
          `, [ids]);
          const attrMap = {};
          for (const row of attrRes.rows) {
            if (!attrMap[row.sku_id]) attrMap[row.sku_id] = [];
            attrMap[row.sku_id].push({ slug: row.slug, name: row.name, value: row.value });
          }
          crossProductAccessories = cpaResult.rows.map(r => ({
            ...r,
            variant_type: 'accessory',
            attributes: attrMap[r.sku_id] || []
          }));
        }
      }
    }

    // Collection siblings (other products in same collection, same category, excluding mosaics/hexagons/bullnose)
    let collectionSiblings = [];
    // isAdexVendor already declared above (media section)
    if (sku.collection) {
      const isMosaicProduct = /mosaic|hexagon|bullnose/i.test(sku.product_name);
      if (isAdexVendor) {
        // ADEX: return ALL SKUs in entire collection (all colors, finishes, products) for swatch grid
        const collResult = await pool.query(`
          SELECT s.id as sku_id, s.variant_name, s.sell_by, p.id as product_id, COALESCE(p.display_name, p.name) as product_name, p.collection,
            pr.retail_price, pr.price_basis, pk.sqft_per_box,
            CASE WHEN pr.sale_price IS NOT NULL AND (pr.sale_ends_at IS NULL OR pr.sale_ends_at > NOW()) THEN pr.sale_price ELSE NULL END as sale_price,
            (SELECT ma.url FROM media_assets ma WHERE ma.sku_id = s.id AND ma.asset_type = 'primary' ORDER BY ma.sort_order LIMIT 1) as primary_image,
            (SELECT ma.url FROM media_assets ma WHERE ma.product_id = p.id AND ma.sku_id IS NULL AND ma.asset_type IN ('primary','alternate') ORDER BY ma.sort_order LIMIT 1) as shape_image,
            (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id WHERE sa.sku_id = s.id AND a.slug = 'color' LIMIT 1) as color,
            (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id WHERE sa.sku_id = s.id AND a.slug = 'finish' LIMIT 1) as finish
          FROM products p
          JOIN skus s ON s.product_id = p.id AND s.is_sample = false AND s.status = 'active'
          LEFT JOIN pricing pr ON pr.sku_id = s.id
          LEFT JOIN packaging pk ON pk.sku_id = s.id
          WHERE LOWER(p.collection) = LOWER($1) AND p.status = 'active'
            AND p.category_id = $2
            AND s.id != $3
          ORDER BY p.name, s.variant_name
          LIMIT 500
        `, [sku.collection, sku.category_id, skuId]);
        collectionSiblings = collResult.rows;
      } else {
        const collResult = await pool.query(`
          SELECT DISTINCT ON (p.id)
            s.id as sku_id, s.variant_name, s.sell_by, p.id as product_id, COALESCE(p.display_name, p.name) as product_name, p.collection,
            pr.retail_price, pr.price_basis, pk.sqft_per_box,
            CASE WHEN pr.sale_price IS NOT NULL AND (pr.sale_ends_at IS NULL OR pr.sale_ends_at > NOW()) THEN pr.sale_price ELSE NULL END as sale_price,
            COALESCE(
              (SELECT ma.url FROM media_assets ma WHERE ma.sku_id = s.id AND ma.asset_type = 'primary' ORDER BY ma.sort_order LIMIT 1),
              (SELECT ma.url FROM media_assets ma WHERE ma.product_id = p.id AND ma.sku_id IS NULL AND ma.asset_type = 'primary' ORDER BY ma.sort_order LIMIT 1)
            ) as primary_image,
            (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id WHERE sa.sku_id = s.id AND a.slug = 'color' LIMIT 1) as color,
            (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id WHERE sa.sku_id = s.id AND a.slug = 'finish' LIMIT 1) as finish
          FROM products p
          JOIN skus s ON s.product_id = p.id AND s.is_sample = false AND s.status = 'active'
          LEFT JOIN pricing pr ON pr.sku_id = s.id
          LEFT JOIN packaging pk ON pk.sku_id = s.id
          WHERE LOWER(p.collection) = LOWER($1) AND p.id != $2 AND p.status = 'active'
            AND p.category_id = $3
            AND (
              ($4 = true AND p.name ~* '(mosaic|hexagon|bullnose)')
              OR ($4 = false AND p.name !~* '(mosaic|hexagon|bullnose)')
            )
          ORDER BY p.id, (s.variant_name = $5) DESC, s.created_at
          LIMIT 50
        `, [sku.collection, sku.product_id, sku.category_id, isMosaicProduct, sku.variant_name]);
        collectionSiblings = collResult.rows;
      }
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
          AND COALESCE(s.variant_type, '') <> 'accessory'
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
          p.id as product_id, COALESCE(p.display_name, p.name) as product_name, p.collection,
          c.name as category_name, c.slug as category_slug,
          pr.retail_price, pr.price_basis, pk.sqft_per_box,
          CASE WHEN pr.sale_price IS NOT NULL AND (pr.sale_ends_at IS NULL OR pr.sale_ends_at > NOW()) THEN pr.sale_price ELSE NULL END as sale_price,
          COALESCE(
            (SELECT ma.url FROM media_assets ma WHERE ma.sku_id = s.id AND ma.asset_type = 'primary' LIMIT 1),
            (SELECT ma.url FROM media_assets ma WHERE ma.product_id = p.id AND ma.sku_id IS NULL AND ma.asset_type = 'primary' LIMIT 1)
          ) as primary_image
        FROM sku_attributes sa
        JOIN skus s ON s.id = sa.sku_id AND s.status = 'active' AND s.is_sample = false
        JOIN products p ON p.id = s.product_id AND p.status = 'active'
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN pricing pr ON pr.sku_id = s.id
        LEFT JOIN packaging pk ON pk.sku_id = s.id
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

    // Look up countertop-only image for current SKU via top_ref_sku attribute
    let countertopImage = null;
    const topRefAttr = (sku.attributes || []).find(a => a.slug === 'top_ref_sku');
    if (topRefAttr) {
      const ref = topRefAttr.value;
      // Try: exact match, with -SNK suffix, and with -BS- before the finish code
      const bsVariant = ref.replace(/-([^-]+)$/, '-BS-$1');
      const ctResult = await pool.query(`
        SELECT ma.url FROM media_assets ma
        JOIN skus s_top ON s_top.id = ma.sku_id AND ma.asset_type = 'primary'
        WHERE s_top.vendor_sku = ANY($1)
        LIMIT 1
      `, [[ref + '-SNK', ref, bsVariant]]);
      if (ctResult.rows.length) countertopImage = ctResult.rows[0].url;
    }

    // Product tags
    let productTags = [];
    try {
      const tagResult = await pool.query(`
        SELECT td.slug, td.name, td.category
        FROM product_tags pt JOIN tag_definitions td ON td.id = pt.tag_id
        WHERE pt.product_id = $1 ORDER BY td.category, td.display_order
      `, [sku.product_id]);
      productTags = tagResult.rows;
    } catch (e) { /* tag tables may not exist yet */ }

    // Build title_parts from attributes
    const attrIdx = {};
    (sku.attributes || []).forEach(a => { attrIdx[a.slug] = a.value; });
    const titleParts = {
      collection: sku.collection || null,
      color: attrIdx.color || null,
      size: attrIdx.size || null,
      finish: attrIdx.finish || null
    };

    res.json({
      sku,
      title_parts: titleParts,
      media: dedupedMedia,
      countertop_image: countertopImage,
      tags: productTags,
      same_product_siblings: sameSiblings,
      cross_product_accessories: crossProductAccessories,
      collection_siblings: collectionSiblings,
      collection_attributes: collectionAttributes,
      grouped_products: groupedProducts
    });
  } catch (err) {
    console.error('Storefront SKU detail error:', err);
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/storefront/sale/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(DISTINCT p.id) as count,
        MAX(CASE WHEN pr.retail_price > 0 THEN ROUND(((pr.retail_price - pr.sale_price) / pr.retail_price) * 100) ELSE 0 END) as max_discount
      FROM pricing pr
      JOIN skus s ON s.id = pr.sku_id AND s.status = 'active' AND s.is_sample = false AND COALESCE(s.variant_type, '') != 'accessory'
      JOIN products p ON p.id = s.product_id AND p.status = 'active'
      WHERE pr.sale_price IS NOT NULL
        AND (pr.sale_ends_at IS NULL OR pr.sale_ends_at > NOW())
    `);
    const row = result.rows[0];
    res.json({ count: parseInt(row.count) || 0, max_discount: parseInt(row.max_discount) || 0 });
  } catch (err) {
    console.error('Sale stats error:', err);
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/storefront/facets', async (req, res) => {
  try {
    const { category, collection, search, q } = req.query;
    const searchTerm = search || q;

    // Build base WHERE for non-attribute filters
    let params = [];
    let paramIndex = 1;
    let baseWhere = ["p.status = 'active'", "s.is_sample = false", "s.status = 'active'",
      "COALESCE(s.variant_type, '') NOT IN ('accessory','trim','floor_trim','wall_trim','lvt_trim','quarry_trim','mosaic_trim')", "p.collection NOT LIKE 'AHF%'"];

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
      const sanitized = searchTerm.replace(/[^\w\s'.-]/g, '').trim();
      if (sanitized) {
        params.push(sanitized);
        const sIdx = paramIndex++;
        const tsQuery = sanitized.split(/\s+/).filter(Boolean).map(w => w + ':*').join(' & ');
        params.push(tsQuery);
        const tsIdx = paramIndex++;
        baseWhere.push(`(
          p.search_vector @@ to_tsquery('english', unaccent($${tsIdx}))
          OR p.name % $${sIdx}
          OR p.collection % $${sIdx}
          OR (p.collection || ' ' || p.name) ILIKE '%' || $${sIdx} || '%'
        )`);
      }
    }

    // Vendor filter
    if (req.query.vendor) {
      const vendorNames = req.query.vendor.split('|').map(v => v.trim()).filter(Boolean);
      const vendorPlaceholders = vendorNames.map(v => { params.push(v); return `$${paramIndex++}`; });
      baseWhere.push(`v.name IN (${vendorPlaceholders.join(',')})`);
    }

    // Price range filters
    if (req.query.price_min) {
      params.push(parseFloat(req.query.price_min));
      baseWhere.push(`pr.retail_price >= $${paramIndex++}`);
    }
    if (req.query.price_max) {
      params.push(parseFloat(req.query.price_max));
      baseWhere.push(`pr.retail_price <= $${paramIndex++}`);
    }

    // Sale filter
    if (req.query.sale === 'true') {
      baseWhere.push("pr.sale_price IS NOT NULL AND (pr.sale_ends_at IS NULL OR pr.sale_ends_at > NOW())");
    }

    // Tag filter
    if (req.query.tags) {
      const tagSlugs = req.query.tags.split('|').filter(Boolean);
      const tagPlaceholders = tagSlugs.map(t => { params.push(t); return `$${paramIndex++}`; });
      baseWhere.push(`p.id IN (SELECT pt.product_id FROM product_tags pt JOIN tag_definitions td ON td.id = pt.tag_id WHERE td.slug IN (${tagPlaceholders.join(',')}))`);
    }

    // Collect attribute filters from query params
    const reservedParams = ['category', 'collection', 'search', 'q', 'sort', 'limit', 'offset', 'vendor', 'price_min', 'price_max', 'product_ids', 'sale', 'tags'];
    const attrFilters = {};
    for (const [key, val] of Object.entries(req.query)) {
      if (!reservedParams.includes(key) && val) {
        attrFilters[key] = val.split('|').map(v => v.trim()).filter(Boolean);
      }
    }

    // Hidden facets — technical attributes not useful for shoppers
    const hiddenFacets = ['color_code', 'style_code', 'upc', 'collection', 'brand', 'subcategory', 'weight_per_sqyd'];

    // Build WHERE clause for attr filters (used in pre-filter + facet queries)
    let attrWhereFragments = [];
    let attrWhereParams = [...params];
    let attrParamIndex = paramIndex;
    for (const [slug, values] of Object.entries(attrFilters)) {
      const slugP = attrParamIndex++;
      attrWhereParams.push(slug);
      const valPlaceholders = values.map(v => {
        attrWhereParams.push(v);
        return `$${attrParamIndex++}`;
      });
      attrWhereFragments.push({ slug, clause: `s.id IN (SELECT sa2.sku_id FROM sku_attributes sa2 JOIN attributes a2 ON a2.id = sa2.attribute_id WHERE a2.slug = $${slugP} AND sa2.value IN (${valPlaceholders.join(',')}))` });
    }

    // Pre-filter: only query attributes that actually exist in the current result set
    const allAttrWhere = [...baseWhere, ...attrWhereFragments.map(f => f.clause)].join(' AND ');
    const preFilterSQL = `
      SELECT DISTINCT a.id, a.name, a.slug, a.display_order
      FROM sku_attributes sa
      JOIN attributes a ON a.id = sa.attribute_id AND a.is_filterable = true
      JOIN skus s ON s.id = sa.sku_id
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      WHERE ${allAttrWhere}
      ORDER BY a.display_order, a.name
    `;
    const attrsResult = await pool.query(preFilterSQL, attrWhereParams);
    const relevantAttrs = attrsResult.rows.filter(a => !hiddenFacets.includes(a.slug));

    // For each relevant attribute, compute disjunctive counts
    const facetPromises = relevantAttrs.map(async (attr) => {
      let facetParams = [...params];
      let facetParamIndex = paramIndex;
      let facetWhere = [...baseWhere];

      // Apply all attribute filters EXCEPT this one (disjunctive faceting)
      for (const frag of attrWhereFragments) {
        if (frag.slug === attr.slug) continue;
        // Re-build the clause with current param indices
        const slugP = facetParamIndex++;
        facetParams.push(frag.slug);
        const values = attrFilters[frag.slug];
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
        LEFT JOIN pricing pr ON pr.sku_id = s.id
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

    // Vendor counts (disjunctive: skip vendor filter from WHERE)
    const vendorWhereFragments = [...baseWhere.filter(w => !w.startsWith('v.name IN')), ...attrWhereFragments.map(f => f.clause)];
    const vendorSQL = `
      SELECT v.name, COUNT(DISTINCT s.id) as count
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      WHERE ${vendorWhereFragments.join(' AND ')}
      GROUP BY v.name
      ORDER BY count DESC
    `;

    // Price range (applied to full filter set minus price filters)
    const priceWhereFragments = [...baseWhere.filter(w => !w.includes('pr.retail_price')), ...attrWhereFragments.map(f => f.clause)];
    const priceSQL = `
      SELECT MIN(pr.retail_price::numeric) as min_price, MAX(pr.retail_price::numeric) as max_price
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      WHERE pr.retail_price IS NOT NULL AND pr.retail_price::numeric > 0 AND ${priceWhereFragments.join(' AND ')}
    `;

    // Tag facets (disjunctive: skip tag filter from WHERE)
    const tagWhereFragments = [...baseWhere.filter(w => !w.includes('product_tags')), ...attrWhereFragments.map(f => f.clause)];
    const tagFacetSQL = `
      SELECT td.slug, td.name, td.category, COUNT(DISTINCT p.id) as count
      FROM product_tags pt
      JOIN tag_definitions td ON td.id = pt.tag_id
      JOIN products p ON p.id = pt.product_id
      JOIN skus s ON s.product_id = p.id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      WHERE ${tagWhereFragments.join(' AND ')}
      GROUP BY td.id, td.slug, td.name, td.category
      HAVING COUNT(DISTINCT p.id) > 0
      ORDER BY td.category, td.display_order
    `;

    const [facetResults, vendorResult, priceResult, tagFacetResult] = await Promise.all([
      Promise.all(facetPromises),
      pool.query(vendorSQL, attrWhereParams),
      pool.query(priceSQL, attrWhereParams),
      pool.query(tagFacetSQL, attrWhereParams)
    ]);

    const facets = facetResults.filter(f => f.values.length > 0);
    const vendors = vendorResult.rows.map(r => ({ name: r.name, count: parseInt(r.count) }));
    const priceRow = priceResult.rows[0];
    const priceRange = {
      min: priceRow && priceRow.min_price ? parseFloat(parseFloat(priceRow.min_price).toFixed(2)) : 0,
      max: priceRow && priceRow.max_price ? parseFloat(parseFloat(priceRow.max_price).toFixed(2)) : 1000
    };
    const tags = tagFacetResult.rows.map(r => ({ slug: r.slug, name: r.name, category: r.category, count: parseInt(r.count) }));

    res.json({ facets, vendors, priceRange, tags });
  } catch (err) {
    console.error('Storefront facets error:', err);
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Cart routes — extracted to routes/cart.js
app.use(createCartRoutes({ pool, calculateSalesTax, isPickupOnly }));

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

// ==================== Direct Carrier LTL Rate APIs ====================
// Calls R+L Carriers, FedEx Freight, and Estes Express in parallel.
// Each carrier is independent — missing env vars or API errors cause
// that carrier to be silently skipped while others still return quotes.

const LTL_TIMEOUT_MS = 5000;

// --- FedEx Freight OAuth2 token cache ---
let fedexToken = null;
let fedexTokenExpiry = 0;

async function getFedExToken() {
  if (fedexToken && Date.now() < fedexTokenExpiry) return fedexToken;
  const clientId = process.env.FEDEX_CLIENT_ID;
  const clientSecret = process.env.FEDEX_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('FedEx credentials not configured');

  const resp = await fetch('https://apis.fedex.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
    signal: AbortSignal.timeout(LTL_TIMEOUT_MS)
  });
  if (!resp.ok) throw new Error('FedEx auth failed (' + resp.status + ')');
  const data = await resp.json();
  fedexToken = data.access_token;
  fedexTokenExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  return fedexToken;
}

// --- Estes Express auth (API key + bearer token) ---
let estesToken = null;
let estesTokenExpiry = 0;

async function getEstesAuth() {
  if (estesToken && Date.now() < estesTokenExpiry) return estesToken;
  const clientId = process.env.ESTES_CLIENT_ID;
  const clientSecret = process.env.ESTES_CLIENT_SECRET;
  const username = process.env.ESTES_USERNAME;
  const password = process.env.ESTES_PASSWORD;
  if (!clientId || !clientSecret || !username || !password) throw new Error('Estes credentials not configured');

  const resp = await fetch('https://cloudapi.estes-express.com/authenticate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': clientId,
      'client_secret': clientSecret
    },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(LTL_TIMEOUT_MS)
  });
  if (!resp.ok) throw new Error('Estes auth failed (' + resp.status + ')');
  const data = await resp.json();
  estesToken = { apiKey: clientId, bearer: data.access_token || data.token };
  estesTokenExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  return estesToken;
}

// --- R+L Carriers rate quote ---
async function getRLCRate(freightItems, destinationZip, options) {
  const apiKey = process.env.RLC_API_KEY;
  if (!apiKey) return null;
  try {
    const resp = await fetch('https://api.rlc.com/RateQuote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apiKey': apiKey },
      body: JSON.stringify({
        Origin: { City: SHIP_FROM.city, StateOrProvince: SHIP_FROM.state, ZipOrPostalCode: SHIP_FROM.zip, CountryCode: 'USA' },
        Destination: { ZipOrPostalCode: destinationZip, CountryCode: 'USA' },
        Items: freightItems.map(item => ({
          Class: String(item.freightClass),
          Weight: String(item.weight)
        })),
        DeclaredValue: 0,
        Accessorials: [
          ...(options.residential ? ['ResidentialDelivery'] : []),
          ...(options.liftgate ? ['LiftgateDelivery'] : [])
        ],
        PickupDate: getNextBusinessDay()
      }),
      signal: AbortSignal.timeout(LTL_TIMEOUT_MS)
    });
    if (!resp.ok) throw new Error('R+L rate failed (' + resp.status + ')');
    const data = await resp.json();
    const levels = data.ServiceLevels || data.serviceLevels || [];
    if (levels.length === 0) return null;
    // Pick the cheapest service level
    const best = levels.reduce((a, b) => parseFloat(a.NetCharge || a.netCharge) < parseFloat(b.NetCharge || b.netCharge) ? a : b);
    return {
      carrier: 'R+L Carriers',
      amount: parseFloat(parseFloat(best.NetCharge || best.netCharge).toFixed(2)),
      service: best.Title || best.title || 'LTL Freight',
      transit_days: parseInt(best.ServiceDays || best.serviceDays) || null
    };
  } catch (err) {
    console.error('[LTL] R+L Carriers error:', err.message);
    return null;
  }
}

// --- FedEx Freight rate quote ---
async function getFedExFreightRate(freightItems, destinationZip, options) {
  if (!process.env.FEDEX_CLIENT_ID || !process.env.FEDEX_CLIENT_SECRET) return null;
  try {
    const token = await getFedExToken();
    const accountNumber = process.env.FEDEX_FREIGHT_ACCOUNT;
    if (!accountNumber) return null;

    const resp = await fetch('https://apis.fedex.com/rate/v1/rates/quotes', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'X-locale': 'en_US'
      },
      body: JSON.stringify({
        accountNumber: { value: accountNumber },
        rateRequestControlParameters: { returnTransitTimes: true },
        requestedShipment: {
          shipper: { address: { postalCode: SHIP_FROM.zip, countryCode: 'US' } },
          recipient: { address: { postalCode: destinationZip, countryCode: 'US', residential: options.residential } },
          serviceType: 'FEDEX_FREIGHT_ECONOMY',
          freightShipmentDetail: {
            role: 'SHIPPER',
            accountNumber: { value: accountNumber },
            lineItems: freightItems.map((item, i) => ({
              id: String(i + 1),
              freightClass: 'CLASS_' + item.freightClass,
              weight: { value: item.weight, units: 'LB' },
              pieces: item.quantity || 1,
              packaging: 'PALLET',
              description: 'Flooring materials'
            }))
          },
          requestedPackageLineItems: [{ weight: { value: freightItems.reduce((s, i) => s + i.weight, 0), units: 'LB' } }],
          pickupType: 'USE_SCHEDULED_PICKUP',
          shipDateStamp: getNextBusinessDay()
        }
      }),
      signal: AbortSignal.timeout(LTL_TIMEOUT_MS)
    });
    if (!resp.ok) throw new Error('FedEx Freight rate failed (' + resp.status + ')');
    const data = await resp.json();
    const details = (data.output && data.output.rateReplyDetails) || [];
    if (details.length === 0) return null;
    // Find the cheapest reply
    let best = null;
    for (const detail of details) {
      for (const rated of (detail.ratedShipmentDetails || [])) {
        const charge = parseFloat(rated.totalNetCharge || rated.totalNetFedExCharge || 0);
        if (charge > 0 && (!best || charge < best.amount)) {
          best = {
            carrier: 'FedEx Freight',
            amount: parseFloat(charge.toFixed(2)),
            service: detail.serviceDescription?.description || detail.serviceType || 'FedEx Freight Economy',
            transit_days: detail.commit?.dateDetail?.dayCount ? parseInt(detail.commit.dateDetail.dayCount) : null
          };
        }
      }
    }
    return best;
  } catch (err) {
    console.error('[LTL] FedEx Freight error:', err.message);
    return null;
  }
}

// --- Estes Express rate quote ---
async function getEstesRate(freightItems, destinationZip, options) {
  if (!process.env.ESTES_CLIENT_ID || !process.env.ESTES_USERNAME) return null;
  try {
    const auth = await getEstesAuth();
    const resp = await fetch('https://cloudapi.estes-express.com/v1/rate-quotes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': auth.apiKey,
        'Authorization': 'Bearer ' + auth.bearer
      },
      body: JSON.stringify({
        origin: { postalCode: SHIP_FROM.zip, countryCode: 'US' },
        destination: { postalCode: destinationZip, countryCode: 'US' },
        pickupDate: getNextBusinessDay(),
        handlingUnits: [{
          count: 1,
          type: 'PLT',
          weight: { value: freightItems.reduce((s, i) => s + i.weight, 0), unit: 'Pounds' }
        }],
        lineItems: freightItems.map(item => ({
          classification: String(item.freightClass),
          weight: { value: item.weight, unit: 'Pounds' },
          pieces: item.quantity || 1,
          description: 'Flooring materials'
        })),
        accessorials: [
          ...(options.residential ? [{ code: 'RESDEL' }] : []),
          ...(options.liftgate ? [{ code: 'LFGDEL' }] : [])
        ]
      }),
      signal: AbortSignal.timeout(LTL_TIMEOUT_MS)
    });
    if (!resp.ok) throw new Error('Estes rate failed (' + resp.status + ')');
    const data = await resp.json();
    const quote = data.data || data;
    const charges = parseFloat(quote.totalCharges || quote.total_charges || 0);
    if (charges <= 0) return null;
    return {
      carrier: 'Estes Express',
      amount: parseFloat(charges.toFixed(2)),
      service: quote.serviceLevel || 'LTL Freight',
      transit_days: parseInt(quote.transitDays || quote.transit_days) || null
    };
  } catch (err) {
    console.error('[LTL] Estes Express error:', err.message);
    return null;
  }
}

// --- Multi-carrier LTL rate shop ---
async function getLTLRates(freightItems, destination, options = {}) {
  const residential = options.residential !== false;
  const liftgate = options.liftgate !== false;
  const opts = { residential, liftgate };

  const results = await Promise.allSettled([
    getRLCRate(freightItems, destination.zip, opts),
    getFedExFreightRate(freightItems, destination.zip, opts),
    getEstesRate(freightItems, destination.zip, opts)
  ]);

  const quotes = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  if (quotes.length === 0) {
    throw new Error('No LTL freight rates available');
  }

  const sorted = quotes.sort((a, b) => a.amount - b.amount);
  return {
    shipmentId: null,
    quotes: sorted.slice(0, 3).map((q, idx) => ({
      id: 'ltl-' + idx,
      amount: parseFloat(q.amount.toFixed(2)),
      carrier: q.carrier,
      service: q.service,
      transit_days: q.transit_days,
      is_cheapest: idx === 0,
      is_fallback: false
    }))
  };
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
    // Build one item per freight class for carrier rate APIs
    const freightItems = Object.entries(byFreightClass).map(([fc, weight]) => ({
      quantity: 1,
      weight: Math.ceil(weight),
      freightClass: parseInt(fc),
      description: 'Flooring materials'
    }));
    try {
      const ltlResult = await getLTLRates(freightItems, destination, { residential, liftgate });
      options = ltlResult.quotes;
    } catch (ltlErr) {
      console.error('LTL carrier APIs failed, using fallback:', ltlErr.message);
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
      freightClass: parseInt(fc),
      description: 'Flooring materials'
    }));
    try {
      const ltlResult = await getLTLRates(freightItems, destination, { residential, liftgate });
      options = ltlResult.quotes;
    } catch (ltlErr) {
      console.error('LTL carrier APIs failed, using fallback:', ltlErr.message);
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
    console.error('Shipping calculation error:', err);
    res.status(500).json({ error: 'Unable to calculate shipping' });
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
    console.error(err); res.status(500).json({ valid: false, error: 'Internal server error' });
  }
});

// ==================== Checkout API ====================

app.post('/api/checkout/create-payment-intent', async (req, res) => {
  try {
    const { session_id, destination, delivery_method, shipping_option_id, residential, liftgate, promo_code } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id is required' });

    const result = await pool.query(`
      SELECT ci.*, COALESCE(p.display_name, p.name) as product_name, p.collection, p.category_id,
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

    // Check stock status for all SKUs
    const skuIds = items.filter(i => i.sku_id).map(i => i.sku_id);
    let stockWarnings = [];
    if (skuIds.length > 0) {
      const stockResult = await pool.query(`
        SELECT s.id as sku_id,
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
        WHERE s.id = ANY($1)
      `, [skuIds]);
      stockWarnings = stockResult.rows
        .filter(r => r.stock_status === 'out_of_stock' && r.vendor_has_inventory)
        .map(r => r.sku_id);
    }

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

    // Calculate sales tax
    const destZip = (delivery_method === 'pickup') ? SHIP_FROM.zip : (destination ? destination.zip : null);
    const { rate: taxRate, amount: taxAmount } = calculateSalesTax(productSubtotal, destZip, false);

    const total = productSubtotal + shippingCost + sampleShipping + taxAmount - discountAmount;

    if (total <= 0) {
      return res.status(400).json({ error: 'Order total must be greater than zero' });
    }

    const totalCents = Math.round(total * 100);

    // Build shipping for Affirm (required for US transactions)
    const STORE_ADDRESS = { line1: '1440 S. State College Blvd., Suite 6M', city: 'Anaheim', state: 'CA', postal_code: '92806', country: 'US' };
    const piShipping = (delivery_method === 'pickup' || !destination)
      ? { name: 'Store Pickup', address: STORE_ADDRESS }
      : { name: 'Customer', address: { line1: destination.zip || '', city: destination.city || '', state: destination.state || '', postal_code: destination.zip || '', country: 'US' } };

    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalCents,
      currency: 'usd',
      payment_method_types: ['card', 'klarna'],
      shipping: piShipping,
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: total,
      shipping: shippingCost,
      shipping_method: shippingMethod,
      discount_amount: discountAmount,
      promo_code: promoCodeStr,
      tax_rate: taxRate,
      tax_amount: taxAmount,
      stock_warnings: stockWarnings
    });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a bank transfer (customer_balance) payment intent — separate from card/klarna
app.post('/api/checkout/create-bank-transfer-intent', async (req, res) => {
  try {
    const { session_id, destination, delivery_method, shipping_option_id, residential, liftgate, promo_code, customer_email } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id is required' });
    if (!customer_email) return res.status(400).json({ error: 'customer_email is required' });

    const result = await pool.query(`
      SELECT ci.*, COALESCE(p.display_name, p.name) as product_name, p.collection, p.category_id,
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

    // Enforce $500 minimum for bank transfer
    if (productSubtotal < 500) {
      return res.status(400).json({ error: 'Bank transfer requires a minimum product subtotal of $500.' });
    }

    // Calculate product shipping
    let shippingCost = 0;
    let shippingMethod = null;
    if (delivery_method === 'pickup') {
      shippingCost = 0;
      shippingMethod = 'pickup';
    } else if (destination && destination.zip && productItems.length > 0) {
      const hasPickupOnly = productItems.some(i => isPickupOnly(i));
      if (hasPickupOnly) {
        return res.status(400).json({ error: 'Cart contains items that are available for store pickup only (slabs/prefab). Please select store pickup.' });
      }
      try {
        const shippingResult = await calculateShipping(session_id, destination, { residential, liftgate });
        const opts = shippingResult.options || [];
        const selected = (shipping_option_id && opts.find(o => o.id === shipping_option_id)) || opts.find(o => o.is_cheapest) || opts[0];
        shippingCost = selected ? selected.amount : 0;
        shippingMethod = shippingResult.method;
      } catch (shipErr) {
        console.error('Shipping calc error during bank transfer intent:', shipErr.message);
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

    // Calculate sales tax
    const destZip = (delivery_method === 'pickup') ? SHIP_FROM.zip : (destination ? destination.zip : null);
    const { rate: taxRate, amount: taxAmount } = calculateSalesTax(productSubtotal, destZip, false);

    const total = productSubtotal + shippingCost + sampleShipping + taxAmount - discountAmount;

    if (total <= 0) {
      return res.status(400).json({ error: 'Order total must be greater than zero' });
    }

    const totalCents = Math.round(total * 100);

    // Find or create Stripe Customer by email
    const existingCustomers = await stripe.customers.list({ email: customer_email, limit: 1 });
    let stripeCustomer;
    if (existingCustomers.data.length > 0) {
      stripeCustomer = existingCustomers.data[0];
    } else {
      stripeCustomer = await stripe.customers.create({ email: customer_email });
    }

    // Save stripe_customer_id on the customers table if they have an account
    const custRow = await pool.query('SELECT id, stripe_customer_id FROM customers WHERE email = $1', [customer_email]);
    if (custRow.rows.length && !custRow.rows[0].stripe_customer_id) {
      await pool.query('UPDATE customers SET stripe_customer_id = $1 WHERE id = $2', [stripeCustomer.id, custRow.rows[0].id]);
    }

    // Create confirmed payment intent with customer_balance
    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalCents,
      currency: 'usd',
      customer: stripeCustomer.id,
      payment_method_types: ['customer_balance'],
      payment_method_data: { type: 'customer_balance' },
      payment_method_options: {
        customer_balance: {
          funding_type: 'bank_transfer',
          bank_transfer: { type: 'us_bank_transfer' }
        }
      },
      confirm: true,
    });

    // Extract bank transfer instructions from next_action
    const bankInstructions = paymentIntent.next_action
      && paymentIntent.next_action.display_bank_transfer_instructions
      ? paymentIntent.next_action.display_bank_transfer_instructions
      : null;

    res.json({
      paymentIntentId: paymentIntent.id,
      bankInstructions,
      amount: total,
      shipping: shippingCost,
      shipping_method: shippingMethod,
      discount_amount: discountAmount,
      promo_code: promoCodeStr,
      tax_rate: taxRate,
      tax_amount: taxAmount,
    });
  } catch (err) {
    console.error('Bank transfer intent error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// Update PaymentIntent shipping with full customer details (for Affirm redirect)
app.post('/api/checkout/update-payment-intent-shipping', async (req, res) => {
  try {
    const { payment_intent_id, shipping } = req.body;
    if (!payment_intent_id || !shipping || !shipping.name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    await stripe.paymentIntents.update(payment_intent_id, {
      shipping: {
        name: shipping.name,
        address: {
          line1: shipping.address.line1 || '',
          line2: shipping.address.line2 || '',
          city: shipping.address.city || '',
          state: shipping.address.state || '',
          postal_code: shipping.address.postal_code || '',
          country: 'US',
        },
      },
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Update PI shipping error:', err.message);
    res.status(500).json({ error: 'Failed to update payment intent shipping' });
  }
});

// ==================== Sequential Number Generation ====================

async function getNextOrderNumber() {
  const result = await pool.query("SELECT nextval('order_number_seq')");
  return 'RD-' + result.rows[0].nextval;
}

async function getNextQuoteNumber() {
  const result = await pool.query("SELECT nextval('quote_number_seq')");
  return 'RDQ-' + result.rows[0].nextval;
}

async function getNextEstimateNumber() {
  const result = await pool.query("SELECT nextval('estimate_number_seq')");
  return 'RDE-' + result.rows[0].nextval;
}

async function getNextSampleNumber() {
  const result = await pool.query("SELECT nextval('sample_number_seq')");
  return 'RDS-' + result.rows[0].nextval;
}

async function getNextPONumber(vendorCode) {
  const result = await pool.query("SELECT nextval('po_number_seq')");
  return 'RDP-' + (vendorCode || 'XX') + '-' + result.rows[0].nextval;
}

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
    const poNumber = await getNextPONumber(group.vendor_code);

    // Calculate subtotal — cost per box * qty (boxes), or cost per sqyd * sqyd for carpet
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
      let itemCost;
      if (item.price_basis === 'per_sqyd') {
        // Carpet: cost/sqyd * sqyd (sqft_needed is in sqft, convert to sqyd)
        const sqyd = parseFloat(item.sqft_needed || 0) / 9;
        itemCost = vendorCost * sqyd;
      } else if (item.price_basis === 'per_sqft' || item.price_basis === 'sqft') {
        itemCost = vendorCost * sqftPerBox * item.qty;
      } else {
        itemCost = vendorCost * item.qty;
      }
      poSubtotal += itemCost;
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
      const sqftPerBox = parseFloat(item.sqft_per_box || 1);
      let vendorCost = parseFloat(item.vendor_cost);
      if (item.price_tier === 'roll' && item.roll_cost != null) {
        vendorCost = parseFloat(item.roll_cost);
      } else if (item.price_tier === 'cut' && item.cut_cost != null) {
        vendorCost = parseFloat(item.cut_cost);
      }
      let costPerBox, retailPerBox, itemSubtotal;
      if (item.price_basis === 'per_sqyd') {
        const sqyd = parseFloat(item.sqft_needed || 0) / 9;
        costPerBox = vendorCost; // cost per sqyd
        retailPerBox = item.unit_price ? parseFloat(item.unit_price) : null; // retail per sqyd
        itemSubtotal = vendorCost * sqyd;
      } else if (item.price_basis === 'per_sqft' || item.price_basis === 'sqft') {
        costPerBox = vendorCost * sqftPerBox;
        retailPerBox = item.unit_price ? parseFloat(item.unit_price) * sqftPerBox : null;
        itemSubtotal = costPerBox * item.qty;
      } else {
        costPerBox = vendorCost;
        retailPerBox = item.unit_price ? parseFloat(item.unit_price) : null;
        itemSubtotal = costPerBox * item.qty;
      }
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
  // Honeypot: hidden field that real users never fill in
  if (req.body.company_url) {
    return res.json({ success: true, order_number: 'RD-' + Date.now() });
  }

  const client = await pool.connect();
  try {
    const { session_id, payment_intent_id, customer_name: bodyName, customer_email: bodyEmail, phone: bodyPhone, shipping, delivery_method,
            po_number, project_id, is_tax_exempt, shipping_option_id, residential, liftgate,
            create_account, account_password, promo_code, payment_method: reqPaymentMethod } = req.body;

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

    // Verify payment succeeded (bank_transfer uses requires_action until funds arrive)
    const isBankTransfer = reqPaymentMethod === 'bank_transfer';
    const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);
    if (isBankTransfer) {
      if (paymentIntent.status !== 'requires_action' && paymentIntent.status !== 'succeeded') {
        return res.status(400).json({ error: 'Bank transfer payment intent is not in the expected state' });
      }
    } else if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment has not been completed' });
    }

    // Get cart items
    const cartResult = await client.query(`
      SELECT ci.*, COALESCE(p.display_name, p.name) as product_name, p.collection, p.category_id
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

    // Calculate sales tax
    const destZip = isPickup ? SHIP_FROM.zip : (shipping ? shipping.zip : null);
    const { rate: taxRate, amount: taxAmount } = calculateSalesTax(productSubtotal, destZip, is_tax_exempt);

    const total = productSubtotal + shippingCost + sampleShipping + taxAmount - discountAmount;
    const tradeCustomerId = req.tradeCustomer ? req.tradeCustomer.id : null;
    const existingCustomerId = req.customer ? req.customer.id : null;

    const orderNumber = await getNextOrderNumber();

    await client.query('BEGIN');

    const orderStatus = isBankTransfer ? 'awaiting_payment' : 'confirmed';
    const amountPaid = isBankTransfer ? '0.00' : total.toFixed(2);
    const bankInstructions = isBankTransfer ? (req.body.bank_instructions || null) : null;
    const bankExpiresAt = isBankTransfer ? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) : null;

    const orderResult = await client.query(`
      INSERT INTO orders (order_number, session_id, customer_email, customer_name, phone,
        shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip,
        subtotal, shipping, shipping_method, sample_shipping, total, stripe_payment_intent_id, delivery_method, status,
        trade_customer_id, po_number, is_tax_exempt, project_id,
        shipping_carrier, shipping_transit_days, shipping_residential, shipping_liftgate, shipping_is_fallback,
        customer_id, promo_code_id, promo_code, discount_amount, amount_paid,
        tax_rate, tax_amount, payment_method, bank_transfer_instructions, bank_transfer_expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37)
      RETURNING *
    `, [orderNumber, session_id, customer_email, customer_name, phone || null,
        isPickup ? null : shipping.line1, isPickup ? null : (shipping.line2 || null),
        isPickup ? null : shipping.city, isPickup ? null : shipping.state, isPickup ? null : shipping.zip,
        productSubtotal.toFixed(2), shippingCost.toFixed(2), shippingMethod, sampleShipping.toFixed(2), total.toFixed(2),
        payment_intent_id, isPickup ? 'pickup' : 'shipping', orderStatus,
        tradeCustomerId, po_number || null, is_tax_exempt || false, project_id || null,
        selectedCarrier, selectedTransitDays, isResidential, isLiftgate, isFallback,
        existingCustomerId, promoCodeId, promoCodeStr, discountAmount.toFixed(2), amountPaid,
        taxRate, taxAmount.toFixed(2), reqPaymentMethod || 'stripe', bankInstructions ? JSON.stringify(bankInstructions) : null, bankExpiresAt]);

    const order = orderResult.rows[0];

    // Insert only product items into order_items
    for (const item of productItems) {
      await client.query(`
        INSERT INTO order_items (order_id, product_id, sku_id, product_name, collection,
          sqft_needed, num_boxes, unit_price, subtotal, is_sample, sell_by, price_tier)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [order.id, item.product_id || null, item.sku_id || null,
          item.product_name || null, item.collection || null,
          item.sqft_needed || null, item.num_boxes,
          item.unit_price || null, item.subtotal || null, false,
          item.sell_by || null, item.price_tier || null]);
    }

    // Record initial charge in order_payments ledger
    const paymentStatus = isBankTransfer ? 'pending' : 'completed';
    const paymentDesc = isBankTransfer ? 'Bank transfer payment (awaiting funds)' : 'Original payment';
    const opResult = await client.query(`
      INSERT INTO order_payments (order_id, payment_type, amount, stripe_payment_intent_id, description, status)
      VALUES ($1, 'charge', $2, $3, $4, $5) RETURNING id
    `, [order.id, total.toFixed(2), payment_intent_id, paymentDesc, paymentStatus]);
    if (!isBankTransfer) {
      await syncOrderPaymentToInvoice(opResult.rows[0].id, order.id, client);
    }

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

    // Generate purchase orders (one per vendor) — only for product items (skip for bank transfer until payment arrives)
    if (productItems.length > 0 && !isBankTransfer) {
      await generatePurchaseOrders(order.id, client);
    }

    // Create sample request if there are sample items
    let sampleRequest = null;
    if (sampleItems.length > 0) {
      const srNumber = await getNextSampleNumber();

      // Resolve customer_id: use existing customer, newly created customer, or find/create one
      let srCustomerId = existingCustomerId;
      if (!srCustomerId && newCustomerData) {
        srCustomerId = newCustomerData.id;
      }
      if (!srCustomerId) {
        const nameParts = customer_name.trim().split(/\s+/);
        const { customer: cust } = await findOrCreateCustomer(client, {
          email: customer_email, firstName: nameParts[0] || '', lastName: nameParts.slice(1).join(' ') || '',
          phone: phone || null, createdVia: 'checkout_sample'
        });
        srCustomerId = cust.id;
      }

      const dm = isPickup ? 'pickup' : 'shipping';
      const srRes = await client.query(`
        INSERT INTO sample_requests (request_number, rep_id, customer_name, customer_email, customer_phone,
          shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip,
          delivery_method, status, customer_id, shipping_payment_collected, shipping_payment_collected_at)
        VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'requested', $11, $12, $13) RETURNING *
      `, [srNumber, customer_name, customer_email || null, phone || null,
          isPickup ? null : (shipping ? shipping.line1 : null),
          isPickup ? null : (shipping ? shipping.line2 || null : null),
          isPickup ? null : (shipping ? shipping.city : null),
          isPickup ? null : (shipping ? shipping.state : null),
          isPickup ? null : (shipping ? shipping.zip : null),
          dm, srCustomerId,
          dm === 'shipping', dm === 'shipping' ? new Date() : null]);
      sampleRequest = srRes.rows[0];

      // Insert sample request items with resolved product data
      const resolvedSampleItems = [];
      for (let i = 0; i < sampleItems.length; i++) {
        const item = sampleItems[i];
        let productName = item.product_name || 'Unknown';
        let collection = item.collection || null;
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
        }

        const itemRes = await client.query(`
          INSERT INTO sample_request_items (sample_request_id, product_id, sku_id, product_name, collection, variant_name, primary_image, sort_order)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
        `, [sampleRequest.id, productId, skuId, productName, collection, variantName, primaryImage, i]);
        resolvedSampleItems.push(itemRes.rows[0]);
      }
      sampleRequest.items = resolvedSampleItems;
    }

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
    const response = { order: { ...order, items: orderItems.rows }, sample_request: sampleRequest || null };
    if (isBankTransfer && bankInstructions) {
      response.bank_instructions = bankInstructions;
    }
    if (newCustomerToken && newCustomerData) {
      response.customer_token = newCustomerToken;
      response.customer = newCustomerData;
    }
    res.json(response);

    // Recalculate commission for storefront order (if rep assigned)
    setImmediate(() => recalculateCommission(pool, order.id));

    // Fire-and-forget: send order email
    const emailOrder = { ...order, items: orderItems.rows };
    if (isBankTransfer) {
      // Send "awaiting payment" email with bank instructions
      setImmediate(() => sendBankTransferAwaitingEmail(emailOrder, bankInstructions));
    } else {
      // Send standard order confirmation
      setImmediate(() => sendOrderConfirmation(emailOrder));
    }

    // Fire-and-forget: send sample request confirmation email
    if (sampleRequest && customer_email) {
      setImmediate(() => sendSampleRequestConfirmation({
        customer_name, customer_email, request_number: sampleRequest.request_number,
        delivery_method: sampleRequest.delivery_method,
        items: sampleRequest.items,
        shipping_address_line1: isPickup ? null : (shipping ? shipping.line1 : null),
        shipping_address_line2: isPickup ? null : (shipping ? shipping.line2 || null : null),
        shipping_city: isPickup ? null : (shipping ? shipping.city : null),
        shipping_state: isPickup ? null : (shipping ? shipping.state : null),
        shipping_zip: isPickup ? null : (shipping ? shipping.zip : null)
      }));
    }

    // Fire-and-forget: notify all active reps about new storefront order
    const repNotifTitle = isBankTransfer ? 'New Bank Transfer Order ' + order.order_number : 'New Order ' + order.order_number;
    const repNotifBody = order.customer_name + ' placed order ' + order.order_number + ' ($' + parseFloat(order.total).toFixed(2) + ')' + (isBankTransfer ? ' — awaiting bank transfer' : '');
    setImmediate(() => notifyAllActiveReps(pool, 'new_order', repNotifTitle, repNotifBody, 'order', order.id));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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

// Search vector rebuild
app.post('/api/admin/search/rebuild', staffAuth, requireRole('admin'), async (req, res) => {
  try {
    await pool.query('SELECT refresh_search_vectors()');
    clearSearchCaches();
    res.json({ success: true, message: 'Search vectors rebuilt' });
  } catch (err) {
    console.error('Search rebuild error:', err);
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Dashboard stats
app.get('/api/admin/stats', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Dashboard analytics
app.get('/api/admin/analytics', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
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

    const [summaryRes, costRes, revenueRes, topProductsRes, vendorRes, statusRes, arRes, commRes] = await Promise.all([
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
        SELECT oi.product_id, COALESCE(p.display_name, p.name, oi.product_name) as name,
               COALESCE(SUM(oi.subtotal), 0) as revenue,
               COALESCE(SUM(oi.num_boxes), 0)::int as units_sold
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        LEFT JOIN skus s ON s.id = oi.sku_id
        LEFT JOIN products p ON p.id = COALESCE(s.product_id, oi.product_id)
        WHERE o.status != 'cancelled' ${dateFilter}
        GROUP BY oi.product_id, p.display_name, p.name, oi.product_name
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
      `, params),

      // 7. Outstanding AR balance
      pool.query(`
        SELECT COALESCE(SUM(balance), 0) as outstanding_balance,
               COUNT(*) FILTER (WHERE status = 'overdue')::int as overdue_count,
               COUNT(*)::int as open_count
        FROM invoices WHERE status IN ('sent', 'partial', 'overdue')
      `),

      // 8. Pending commissions
      pool.query(`
        SELECT COALESCE(SUM(commission_amount), 0) as pending_commissions,
               COUNT(*)::int as pending_count
        FROM rep_commissions WHERE status IN ('pending', 'earned')
      `)
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
      order_status: statusRes.rows,
      outstanding_ar: {
        balance: parseFloat(arRes.rows[0].outstanding_balance),
        overdue_count: arRes.rows[0].overdue_count,
        open_count: arRes.rows[0].open_count
      },
      pending_commissions: {
        total: parseFloat(commRes.rows[0].pending_commissions),
        count: commRes.rows[0].pending_count
      }
    });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Site Analytics Admin API ====================

app.get('/api/admin/site-analytics', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const period = req.query.period || '7d';
    const days = period === '90d' ? 90 : period === '30d' ? 30 : 7;
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const [dailyRes, totalsRes, devicesRes, referrersRes, pagesRes] = await Promise.all([
      pool.query(
        `SELECT stat_date::text, total_sessions, unique_visitors, page_views, product_views,
                add_to_carts, checkouts_started, orders_completed, total_revenue, bounce_rate
         FROM analytics_daily_stats WHERE stat_date >= $1 ORDER BY stat_date`, [since]),
      pool.query(
        `SELECT COALESCE(SUM(total_sessions),0)::int as sessions,
                COALESCE(SUM(unique_visitors),0)::int as visitors,
                COALESCE(SUM(page_views),0)::int as page_views,
                COALESCE(SUM(product_views),0)::int as product_views,
                COALESCE(SUM(add_to_carts),0)::int as add_to_carts,
                COALESCE(SUM(checkouts_started),0)::int as checkouts_started,
                COALESCE(SUM(orders_completed),0)::int as orders_completed,
                COALESCE(SUM(searches),0)::int as searches,
                COALESCE(SUM(total_revenue),0) as revenue,
                COALESCE(AVG(avg_session_duration_secs),0)::int as avg_duration,
                COALESCE(AVG(bounce_rate),0) as bounce_rate,
                COALESCE(AVG(cart_abandonment_rate),0) as cart_abandonment_rate
         FROM analytics_daily_stats WHERE stat_date >= $1`, [since]),
      pool.query(
        `SELECT device_type, COUNT(*)::int as count FROM analytics_sessions
         WHERE first_seen_at >= $1 AND device_type IS NOT NULL
         GROUP BY device_type ORDER BY count DESC`, [since]),
      pool.query(
        `SELECT referrer, COUNT(*)::int as count FROM analytics_sessions
         WHERE first_seen_at >= $1 AND referrer IS NOT NULL AND referrer != ''
         GROUP BY referrer ORDER BY count DESC LIMIT 10`, [since]),
      pool.query(
        `SELECT page_path, COUNT(*)::int as views FROM analytics_events
         WHERE event_type = 'page_view' AND created_at >= $1
         GROUP BY page_path ORDER BY views DESC LIMIT 10`, [since])
    ]);

    res.json({
      daily: dailyRes.rows,
      totals: totalsRes.rows[0] || {},
      devices: devicesRes.rows,
      referrers: referrersRes.rows,
      top_pages: pagesRes.rows
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/admin/site-analytics/funnel', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const days = period === '90d' ? 90 : period === '30d' ? 30 : 7;
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const result = await pool.query(`
      SELECT event_type, COUNT(DISTINCT session_id)::int as sessions
      FROM analytics_events
      WHERE event_type IN ('page_view','product_view','add_to_cart','checkout_started','order_completed')
        AND created_at >= $1
      GROUP BY event_type
    `, [since]);

    const map = {};
    result.rows.forEach(r => { map[r.event_type] = r.sessions; });
    const steps = [
      { step: 'Page Views', count: map.page_view || 0 },
      { step: 'Product Views', count: map.product_view || 0 },
      { step: 'Add to Cart', count: map.add_to_cart || 0 },
      { step: 'Checkout Started', count: map.checkout_started || 0 },
      { step: 'Order Completed', count: map.order_completed || 0 }
    ];
    for (let i = 1; i < steps.length; i++) {
      steps[i].dropoff = steps[i-1].count > 0
        ? parseFloat((100 - (steps[i].count / steps[i-1].count * 100)).toFixed(1))
        : 0;
    }
    res.json({ steps });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/admin/site-analytics/products', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const days = period === '90d' ? 90 : period === '30d' ? 30 : 7;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const result = await pool.query(`
      WITH views AS (
        SELECT properties->>'sku_id' as sku_id,
               COALESCE(properties->>'product_name', '') as product_name,
               COUNT(*)::int as view_count,
               COUNT(DISTINCT session_id)::int as unique_sessions
        FROM analytics_events
        WHERE event_type = 'product_view' AND created_at >= $1
          AND properties->>'sku_id' IS NOT NULL
        GROUP BY properties->>'sku_id', properties->>'product_name'
      ),
      carts AS (
        SELECT properties->>'sku_id' as sku_id, COUNT(*)::int as cart_count
        FROM analytics_events
        WHERE event_type = 'add_to_cart' AND created_at >= $1
          AND properties->>'sku_id' IS NOT NULL
        GROUP BY properties->>'sku_id'
      ),
      orders AS (
        SELECT properties->>'sku_id' as sku_id, COUNT(*)::int as order_count
        FROM analytics_events
        WHERE event_type = 'order_completed' AND created_at >= $1
          AND properties->>'sku_id' IS NOT NULL
        GROUP BY properties->>'sku_id'
      )
      SELECT v.sku_id, v.product_name, v.view_count, v.unique_sessions,
             COALESCE(c.cart_count, 0) as cart_count,
             COALESCE(o.order_count, 0) as order_count,
             CASE WHEN v.view_count > 0 THEN
               ROUND((v.view_count - COALESCE(c.cart_count, 0))::numeric / v.view_count * 100, 1)
             ELSE 0 END as opportunity_score
      FROM views v
      LEFT JOIN carts c ON c.sku_id = v.sku_id
      LEFT JOIN orders o ON o.sku_id = v.sku_id
      ORDER BY opportunity_score DESC, v.view_count DESC
      LIMIT $2
    `, [since, limit]);

    res.json({ products: result.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/admin/site-analytics/searches', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const days = period === '90d' ? 90 : period === '30d' ? 30 : 7;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const [topTerms, zeroResults] = await Promise.all([
      pool.query(`
        SELECT LOWER(properties->>'query') as term, COUNT(*)::int as count
        FROM analytics_events
        WHERE event_type = 'search' AND created_at >= $1
          AND properties->>'query' IS NOT NULL AND properties->>'query' != ''
        GROUP BY LOWER(properties->>'query')
        ORDER BY count DESC LIMIT $2
      `, [since, limit]),
      pool.query(`
        SELECT LOWER(properties->>'query') as term, COUNT(*)::int as count
        FROM analytics_events
        WHERE event_type = 'search' AND created_at >= $1
          AND properties->>'query' IS NOT NULL AND properties->>'query' != ''
          AND properties->>'results_count' IS NOT NULL AND (properties->>'results_count')::int = 0
        GROUP BY LOWER(properties->>'query')
        ORDER BY count DESC LIMIT $2
      `, [since, limit])
    ]);

    res.json({ top_terms: topTerms.rows, zero_results: zeroResults.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/admin/site-analytics/realtime', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const [sessionsRes, eventsRes] = await Promise.all([
      pool.query(
        `SELECT COUNT(DISTINCT session_id)::int as active_sessions
         FROM analytics_events WHERE created_at >= $1`, [thirtyMinAgo]),
      pool.query(
        `SELECT event_type, properties, page_path, created_at
         FROM analytics_events WHERE created_at >= $1
         ORDER BY created_at DESC LIMIT 50`, [thirtyMinAgo])
    ]);

    res.json({
      active_sessions: sessionsRes.rows[0]?.active_sessions || 0,
      recent_events: eventsRes.rows
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// ==================== Data Quality ====================

app.get('/api/admin/data-quality/summary', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const [overallRes, vendorRes, issuesRes, govRes] = await Promise.all([
      // Overall score distribution
      pool.query(`
        SELECT
          COUNT(*)::int as total_skus,
          COUNT(*) FILTER (WHERE quality_score >= 80)::int as good,
          COUNT(*) FILTER (WHERE quality_score BETWEEN 50 AND 79)::int as fair,
          COUNT(*) FILTER (WHERE quality_score < 50)::int as poor,
          ROUND(AVG(quality_score))::int as avg_score,
          COUNT(*) FILTER (WHERE has_image = 0)::int as missing_image,
          COUNT(*) FILTER (WHERE has_cost = 0)::int as missing_cost,
          COUNT(*) FILTER (WHERE has_retail = 0)::int as missing_retail,
          COUNT(*) FILTER (WHERE has_packaging = 0)::int as missing_packaging,
          COUNT(*) FILTER (WHERE has_description = 0)::int as missing_description,
          COUNT(*) FILTER (WHERE has_color = 0)::int as missing_color,
          COUNT(*) FILTER (WHERE missing_required_attrs > 0)::int as missing_governance
        FROM sku_quality_scores
      `),
      // Per-vendor breakdown
      pool.query(`
        SELECT vendor_name, vendor_code,
          COUNT(*)::int as total,
          ROUND(AVG(quality_score))::int as avg_score,
          COUNT(*) FILTER (WHERE quality_score >= 80)::int as good,
          COUNT(*) FILTER (WHERE quality_score BETWEEN 50 AND 79)::int as fair,
          COUNT(*) FILTER (WHERE quality_score < 50)::int as poor,
          COUNT(*) FILTER (WHERE has_image = 0)::int as no_image,
          COUNT(*) FILTER (WHERE has_cost = 0)::int as no_cost,
          COUNT(*) FILTER (WHERE has_retail = 0)::int as no_retail,
          COUNT(*) FILTER (WHERE has_color = 0)::int as no_color
        FROM sku_quality_scores
        GROUP BY vendor_name, vendor_code
        ORDER BY avg_score ASC
      `),
      // Lowest scoring SKUs
      pool.query(`
        SELECT sku_id, internal_sku, vendor_sku, product_name, collection, vendor_name,
          category_name, quality_score, has_image, has_cost, has_retail, has_packaging,
          has_description, has_attributes, has_color, missing_required_attrs, total_required_attrs
        FROM sku_quality_scores
        ORDER BY quality_score ASC, vendor_name
        LIMIT 50
      `),
      // Governance gaps by category
      pool.query(`
        SELECT category_name, category_slug,
          COUNT(*)::int as total_skus,
          SUM(missing_required_attrs)::int as total_missing,
          ROUND(AVG(CASE WHEN total_required_attrs > 0
            THEN (1.0 - missing_required_attrs::float / total_required_attrs) * 100
            ELSE 100 END))::int as attr_completeness
        FROM sku_quality_scores
        WHERE total_required_attrs > 0
        GROUP BY category_name, category_slug
        ORDER BY attr_completeness ASC
      `)
    ]);

    res.json({
      overall: overallRes.rows[0],
      vendors: vendorRes.rows,
      worst_skus: issuesRes.rows,
      governance: govRes.rows
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/admin/data-quality/refresh', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY sku_quality_scores');
    res.json({ success: true, refreshed_at: new Date().toISOString() });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// ==================== AI Enrichment Endpoints ====================

// Status dashboard: gap counts + recent jobs
app.get('/api/admin/enrichment/status', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const [descGap, attrGap, catGap, imgGap, recentJobs, costSummary] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int as cnt FROM products WHERE status = 'active' AND (description_long IS NULL OR LENGTH(description_long) < 20)`),
      pool.query(`SELECT COUNT(DISTINCT s.id)::int as cnt
        FROM skus s JOIN products p ON p.id = s.product_id LEFT JOIN categories c ON c.id = p.category_id
        WHERE s.status = 'active' AND p.status = 'active' AND c.slug IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM category_required_attributes cra
          WHERE cra.category_slug = c.slug AND cra.is_required = true
          AND NOT EXISTS (SELECT 1 FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id WHERE sa.sku_id = s.id AND a.slug = cra.attribute_slug)
        )`),
      pool.query(`SELECT COUNT(*)::int as cnt FROM products WHERE status = 'active' AND category_id IS NULL`),
      pool.query(`SELECT COUNT(*)::int as cnt FROM media_assets ma JOIN products p ON p.id = ma.product_id WHERE ma.asset_type = 'primary' AND ma.sort_order > 0 AND p.status = 'active'`),
      pool.query(`SELECT id, job_type, status, total_items, processed_items, updated_items, skipped_items, failed_items, prompt_tokens_used, completion_tokens_used, estimated_cost_usd, triggered_by, started_at, completed_at, created_at FROM enrichment_jobs ORDER BY created_at DESC LIMIT 20`),
      pool.query(`SELECT job_type, COUNT(*)::int as runs, SUM(prompt_tokens_used)::int as total_prompt_tokens, SUM(completion_tokens_used)::int as total_completion_tokens, SUM(estimated_cost_usd)::numeric as total_cost, SUM(updated_items)::int as total_updated FROM enrichment_jobs WHERE status = 'completed' GROUP BY job_type`),
    ]);

    res.json({
      gaps: {
        missing_descriptions: descGap.rows[0].cnt,
        missing_attributes: attrGap.rows[0].cnt,
        uncategorized: catGap.rows[0].cnt,
        unclassified_images: imgGap.rows[0].cnt,
      },
      recent_jobs: recentJobs.rows,
      cost_summary: costSummary.rows,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// Start enrichment job
app.post('/api/admin/enrichment/run', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { job_type, scope } = req.body;
    const validTypes = ['descriptions', 'attributes', 'categorization', 'image_classification'];
    if (!validTypes.includes(job_type)) return res.status(400).json({ error: 'Invalid job_type' });

    if (!process.env.OPENAI_API_KEY) return res.status(400).json({ error: 'OPENAI_API_KEY not configured' });

    const { rows } = await pool.query(
      `INSERT INTO enrichment_jobs (job_type, scope, triggered_by, status)
       VALUES ($1, $2, 'manual', 'pending') RETURNING *`,
      [job_type, JSON.stringify(scope || {})]
    );
    const job = rows[0];

    // Run async in background
    const { runEnrichmentJob } = await import('./services/aiEnrichment.js');
    runEnrichmentJob(pool, job.id).catch(err =>
      console.error(`[Enrichment] Job ${job.id} failed:`, err.message)
    );

    res.json(job);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// Job detail + results
app.get('/api/admin/enrichment/jobs/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { rows: jobs } = await pool.query('SELECT * FROM enrichment_jobs WHERE id = $1', [req.params.id]);
    if (!jobs.length) return res.status(404).json({ error: 'Job not found' });

    const { rows: results } = await pool.query(
      `SELECT * FROM enrichment_results WHERE enrichment_job_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.params.id]
    );

    res.json({ ...jobs[0], results });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// Pending review items
app.get('/api/admin/enrichment/review', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT er.*, ej.job_type,
        CASE WHEN er.entity_type = 'product' THEN (SELECT p.name FROM products p WHERE p.id = er.entity_id)
             WHEN er.entity_type = 'sku' THEN (SELECT s.vendor_sku FROM skus s WHERE s.id = er.entity_id)
             ELSE NULL END as entity_name,
        CASE WHEN er.entity_type = 'product' THEN (SELECT p.collection FROM products p WHERE p.id = er.entity_id)
             ELSE NULL END as entity_collection
      FROM enrichment_results er
      JOIN enrichment_jobs ej ON ej.id = er.enrichment_job_id
      WHERE er.status = 'pending_review'
      ORDER BY er.created_at DESC
      LIMIT 200
    `);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// Approve/reject review item
app.post('/api/admin/enrichment/review/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { action } = req.body;
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

    const { rows } = await pool.query('SELECT * FROM enrichment_results WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Result not found' });
    const result = rows[0];

    if (result.status !== 'pending_review') return res.status(400).json({ error: 'Not pending review' });

    if (action === 'approve' && result.field_name === 'category_id') {
      // Apply the categorization
      await pool.query(
        `UPDATE products SET category_id = (SELECT id FROM categories WHERE slug = $2),
                updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND category_id IS NULL
           AND EXISTS (SELECT 1 FROM categories WHERE slug = $2)`,
        [result.entity_id, result.new_value]
      );
    }

    await pool.query(
      `UPDATE enrichment_results SET status = $2 WHERE id = $1`,
      [req.params.id, action === 'approve' ? 'applied' : 'rejected']
    );

    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// Cancel running job
app.post('/api/admin/enrichment/cancel/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { cancelEnrichmentJob } = await import('./services/aiEnrichment.js');
    const cancelled = cancelEnrichmentJob(req.params.id);
    if (cancelled) {
      await pool.query(`UPDATE enrichment_jobs SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [req.params.id]);
      res.json({ success: true });
    } else {
      // Job may have already finished
      await pool.query(`UPDATE enrichment_jobs SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP WHERE id = $1 AND status IN ('pending', 'running')`, [req.params.id]);
      res.json({ success: true, note: 'Job was not actively running' });
    }
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// List all products (admin view - any status)
app.get('/api/admin/products', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const { search, vendor_id, category_id, status, sort, sort_dir, quality, missing } = req.query;

    const conditions = [];
    const params = [];
    let paramIdx = 1;
    let needQualityJoin = false;

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
    // Quality score filter: good (80+), fair (50-79), poor (<50)
    if (quality === 'good' || quality === 'fair' || quality === 'poor') {
      needQualityJoin = true;
      if (quality === 'good') conditions.push(`qs.avg_quality >= 80`);
      else if (quality === 'fair') conditions.push(`qs.avg_quality >= 50 AND qs.avg_quality < 80`);
      else conditions.push(`qs.avg_quality < 50`);
    }
    // Missing data filter: no_image, no_price, no_color, no_category, no_description
    if (missing === 'no_image') {
      needQualityJoin = true;
      conditions.push(`qs.has_image = 0`);
    } else if (missing === 'no_price') {
      needQualityJoin = true;
      conditions.push(`qs.has_retail = 0`);
    } else if (missing === 'no_color') {
      needQualityJoin = true;
      conditions.push(`qs.has_color = 0`);
    } else if (missing === 'no_category') {
      conditions.push(`p.category_id IS NULL`);
    } else if (missing === 'no_description') {
      conditions.push(`(p.description_short IS NULL OR p.description_short = '')`);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const qualityJoin = needQualityJoin
      ? `LEFT JOIN (SELECT product_id, ROUND(AVG(quality_score))::int as avg_quality,
           MIN(has_image) as has_image, MIN(has_retail) as has_retail, MIN(has_color) as has_color
           FROM sku_quality_scores GROUP BY product_id) qs ON qs.product_id = p.id`
      : '';

    const allowedSorts = { name: 'p.name', vendor: 'v.name', category: 'c.name', price: 'price', skus: 'sku_count', status: 'p.status', created: 'p.created_at', quality: 'avg_quality' };
    const orderCol = allowedSorts[sort] || 'p.created_at';
    const orderDir = sort_dir === 'asc' ? 'ASC' : 'DESC';

    const countResult = await pool.query(
      `SELECT COUNT(*)::int as total FROM products p
       LEFT JOIN vendors v ON v.id = p.vendor_id
       LEFT JOIN categories c ON c.id = p.category_id
       ${qualityJoin}
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
           CASE WHEN ma.sku_id IS NOT NULL THEN 0 ELSE 1 END, ma.sort_order LIMIT 1) as primary_image,
        (SELECT ROUND(AVG(qs2.quality_score))::int FROM sku_quality_scores qs2 WHERE qs2.product_id = p.id) as quality_score,
        (SELECT json_build_object(
           'has_image', MIN(qs3.has_image), 'has_cost', MIN(qs3.has_cost), 'has_retail', MIN(qs3.has_retail),
           'has_color', MIN(qs3.has_color), 'has_description', MIN(qs3.has_description), 'has_packaging', MIN(qs3.has_packaging)
         ) FROM sku_quality_scores qs3 WHERE qs3.product_id = p.id) as quality_flags
      FROM products p
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      ${qualityJoin}
      ${whereClause}
      ORDER BY ${orderCol} ${orderDir} NULLS LAST
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    );

    res.json({ products: dataResult.rows, total: countResult.rows[0].total });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Bulk update product status
app.patch('/api/admin/products/bulk/status', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!ids || !ids.length) return res.status(400).json({ error: 'ids array is required' });
    if (!['active', 'draft', 'discontinued'].includes(status)) return res.status(400).json({ error: 'status must be active, draft, or discontinued' });

    // Activation guard: check products are ready before setting to 'active'
    if (status === 'active') {
      const guardResult = await pool.query(`
        SELECT p.id,
          COALESCE(p.display_name, p.name) as name,
          v.name as vendor_name,
          (SELECT COUNT(*) FROM skus s WHERE s.product_id = p.id AND s.status = 'active') as sku_count,
          p.category_id,
          EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id AND ma.asset_type = 'primary') as has_image,
          (SELECT ROUND(AVG(qs.quality_score))::int FROM sku_quality_scores qs WHERE qs.product_id = p.id) as quality_score
        FROM products p
        LEFT JOIN vendors v ON v.id = p.vendor_id
        WHERE p.id = ANY($1)
      `, [ids]);

      const blocked = [];
      const warnings = [];
      for (const p of guardResult.rows) {
        const issues = [];
        if (parseInt(p.sku_count) === 0) issues.push('no active SKUs');
        if (!p.category_id) issues.push('no category');
        if (!p.has_image) issues.push('no image');
        if (p.quality_score != null && p.quality_score < 50) issues.push(`quality score ${p.quality_score} (min 50)`);
        if (issues.length > 0) blocked.push({ ...p, issues });
        else if (p.quality_score != null && p.quality_score < 70) {
          warnings.push(`${p.name}: quality score ${p.quality_score}`);
        }
      }
      if (blocked.length > 0) {
        const reasons = blocked.slice(0, 5).map(p => `${p.name}: ${p.issues.join(', ')}`);
        return res.status(400).json({
          error: `${blocked.length} product(s) cannot be activated`,
          details: reasons,
          blocked_ids: blocked.map(p => p.id)
        });
      }
      // Quality warnings (non-blocking) — included in response
      if (warnings.length > 0) {
        // Still allow activation but return warnings
        const result = await pool.query(
          'UPDATE products SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($2) RETURNING id',
          [status, ids]
        );
        clearSearchCaches();
        return res.json({ updated: result.rowCount, quality_warnings: warnings });
      }
    }

    const result = await pool.query(
      'UPDATE products SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($2) RETURNING id',
      [status, ids]
    );
    clearSearchCaches();
    res.json({ updated: result.rowCount });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    clearSearchCaches();
    res.json({ updated: result.rowCount });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Product Tags ====================

// Get all tag definitions grouped by category
app.get('/api/admin/tags', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query('SELECT id, slug, name, category, icon, display_order FROM tag_definitions ORDER BY category, display_order');
    const grouped = {};
    for (const row of result.rows) {
      if (!grouped[row.category]) grouped[row.category] = [];
      grouped[row.category].push(row);
    }
    res.json({ tags: result.rows, grouped });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Get tags for a specific product
app.get('/api/admin/products/:id/tags', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query('SELECT tag_id FROM product_tags WHERE product_id = $1', [req.params.id]);
    res.json({ tag_ids: result.rows.map(r => r.tag_id) });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Set tags for a product (replace all)
app.put('/api/admin/products/:id/tags', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { tag_ids } = req.body;
    if (!Array.isArray(tag_ids)) return res.status(400).json({ error: 'tag_ids must be an array' });

    await pool.query('DELETE FROM product_tags WHERE product_id = $1', [id]);
    if (tag_ids.length > 0) {
      const values = tag_ids.map((tid, i) => `($1, $${i + 2})`).join(',');
      await pool.query(`INSERT INTO product_tags (product_id, tag_id) VALUES ${values} ON CONFLICT DO NOTHING`, [id, ...tag_ids]);
    }

    // Refresh search vector for this product
    await pool.query('SELECT refresh_search_vectors($1)', [id]);
    clearSearchCaches();

    res.json({ success: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Bulk add/remove tags for multiple products
app.patch('/api/admin/products/bulk/tags', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { product_ids, add_tag_ids, remove_tag_ids } = req.body;
    if (!Array.isArray(product_ids) || product_ids.length === 0) return res.status(400).json({ error: 'product_ids required' });

    // Remove tags
    if (Array.isArray(remove_tag_ids) && remove_tag_ids.length > 0) {
      await pool.query('DELETE FROM product_tags WHERE product_id = ANY($1) AND tag_id = ANY($2)', [product_ids, remove_tag_ids]);
    }

    // Add tags
    if (Array.isArray(add_tag_ids) && add_tag_ids.length > 0) {
      const rows = [];
      const params = [];
      let idx = 1;
      for (const pid of product_ids) {
        for (const tid of add_tag_ids) {
          rows.push(`($${idx++}, $${idx++})`);
          params.push(pid, tid);
        }
      }
      await pool.query(`INSERT INTO product_tags (product_id, tag_id) VALUES ${rows.join(',')} ON CONFLICT DO NOTHING`, params);
    }

    // Refresh search vectors for affected products
    for (const pid of product_ids) {
      await pool.query('SELECT refresh_search_vectors($1)', [pid]);
    }
    clearSearchCaches();

    res.json({ success: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Update product
app.put('/api/admin/products/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, collection, vendor_id, category_id, status, description_short, description_long } = req.body;

    // Activation guard: check product is ready before setting to 'active'
    if (status === 'active') {
      const current = await pool.query('SELECT status FROM products WHERE id = $1', [id]);
      if (current.rows.length && current.rows[0].status !== 'active') {
        const guard = await pool.query(`
          SELECT
            (SELECT COUNT(*) FROM skus s WHERE s.product_id = $1 AND s.status = 'active')::int as sku_count,
            EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = $1 AND ma.asset_type = 'primary') as has_image,
            (SELECT ROUND(AVG(qs.quality_score))::int FROM sku_quality_scores qs WHERE qs.product_id = $1) as quality_score
        `, [id]);
        const g = guard.rows[0];
        const issues = [];
        if (g.sku_count === 0) issues.push('no active SKUs');
        if (!category_id && !(await pool.query('SELECT category_id FROM products WHERE id = $1', [id])).rows[0]?.category_id) issues.push('no category');
        if (!g.has_image) issues.push('no image');
        if (g.quality_score != null && g.quality_score < 50) issues.push(`quality score ${g.quality_score} (min 50)`);
        if (issues.length > 0) {
          return res.status(400).json({ error: `Cannot activate: ${issues.join(', ')}` });
        }
      }
    }

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
    clearSearchCaches();
    res.json({ product: result.rows[0] });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// List SKUs for a product
app.get('/api/admin/products/:productId/skus', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { productId } = req.params;
    const result = await pool.query(`
      SELECT s.*, pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs, pk.freight_class, pk.boxes_per_pallet, pk.sqft_per_pallet, pk.weight_per_pallet_lbs, pk.roll_width_ft, pk.roll_length_ft,
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Create SKU + packaging + pricing
app.post('/api/admin/products/:productId/skus', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { productId } = req.params;
    const { vendor_sku, internal_sku, variant_name, sell_by, sqft_per_box, pieces_per_box, weight_per_box_lbs, freight_class, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs, cost, retail_price, price_basis, cut_price, roll_price, cut_cost, roll_cost, roll_min_sqft, roll_width_ft, roll_length_ft } = req.body;
    if (!vendor_sku || !internal_sku) return res.status(400).json({ error: 'vendor_sku and internal_sku are required' });

    await client.query('BEGIN');

    const sku = await client.query(`
      INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [productId, vendor_sku, internal_sku, variant_name || null, sell_by || 'sqft']);

    const skuId = sku.rows[0].id;

    if (sqft_per_box || pieces_per_box || weight_per_box_lbs || boxes_per_pallet || roll_width_ft || roll_length_ft) {
      await client.query(`
        INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs, freight_class, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs, roll_width_ft, roll_length_ft)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [skuId, sqft_per_box || null, pieces_per_box || null, weight_per_box_lbs || null, freight_class || 70, boxes_per_pallet || null, sqft_per_pallet || null, weight_per_pallet_lbs || null, roll_width_ft || null, roll_length_ft || null]);
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
      SELECT s.*, pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs, pk.freight_class, pk.boxes_per_pallet, pk.sqft_per_pallet, pk.weight_per_pallet_lbs, pk.roll_width_ft, pk.roll_length_ft,
        pr.cost, pr.retail_price, pr.price_basis, pr.cut_price, pr.roll_price, pr.cut_cost, pr.roll_cost, pr.roll_min_sqft
      FROM skus s
      LEFT JOIN packaging pk ON pk.sku_id = s.id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      WHERE s.id = $1
    `, [skuId]);

    res.json({ sku: full.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Update SKU + upsert packaging + pricing
app.put('/api/admin/skus/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { vendor_sku, internal_sku, variant_name, sell_by, sqft_per_box, pieces_per_box, weight_per_box_lbs, freight_class, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs, cost, retail_price, price_basis, cut_price, roll_price, cut_cost, roll_cost, roll_min_sqft, roll_width_ft, roll_length_ft } = req.body;

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
      INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs, freight_class, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs, roll_width_ft, roll_length_ft)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (sku_id) DO UPDATE SET
        sqft_per_box = COALESCE($2, packaging.sqft_per_box),
        pieces_per_box = COALESCE($3, packaging.pieces_per_box),
        weight_per_box_lbs = COALESCE($4, packaging.weight_per_box_lbs),
        freight_class = COALESCE($5, packaging.freight_class),
        boxes_per_pallet = COALESCE($6, packaging.boxes_per_pallet),
        sqft_per_pallet = COALESCE($7, packaging.sqft_per_pallet),
        weight_per_pallet_lbs = COALESCE($8, packaging.weight_per_pallet_lbs),
        roll_width_ft = COALESCE($9, packaging.roll_width_ft),
        roll_length_ft = COALESCE($10, packaging.roll_length_ft)
    `, [id, sqft_per_box, pieces_per_box, weight_per_box_lbs, freight_class, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs, roll_width_ft, roll_length_ft]);

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
      SELECT s.*, pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs, pk.freight_class, pk.boxes_per_pallet, pk.sqft_per_pallet, pk.weight_per_pallet_lbs, pk.roll_width_ft, pk.roll_length_ft,
        pr.cost, pr.retail_price, pr.price_basis, pr.cut_price, pr.roll_price, pr.cut_cost, pr.roll_cost, pr.roll_min_sqft
      FROM skus s
      LEFT JOIN packaging pk ON pk.sku_id = s.id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      WHERE s.id = $1
    `, [id]);

    if (!full.rows.length) return res.status(404).json({ error: 'SKU not found' });
    clearSearchCaches();
    res.json({ sku: full.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ==================== Media Upload API ====================

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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// List vendors with product counts
app.get('/api/admin/vendors', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT v.*,
        (SELECT COUNT(*)::int FROM products p WHERE p.vendor_id = v.id) as product_count,
        (SELECT COUNT(*)::int FROM products p WHERE p.vendor_id = v.id AND p.status = 'active') as active_product_count
      FROM vendors v
      ORDER BY v.name
    `);
    res.json({ vendors: result.rows });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Vendor Health ====================

// Vendor health summary (all vendors)
app.get('/api/admin/vendor-health', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        v.id as vendor_id,
        v.name as vendor_name,
        v.code as vendor_code,
        v.is_active,
        COALESCE(stats.total_products, 0)::int as total_products,
        COALESCE(stats.total_skus, 0)::int as total_skus,
        COALESCE(stats.skus_with_images, 0)::int as skus_with_images,
        COALESCE(stats.skus_with_pricing, 0)::int as skus_with_pricing,
        COALESCE(stats.skus_with_packaging, 0)::int as skus_with_packaging,
        COALESCE(stats.products_with_description, 0)::int as products_with_description,
        COALESCE(stats.products_in_draft, 0)::int as products_in_draft,
        COALESCE(stats.skus_with_attributes, 0)::int as skus_with_attributes,
        scrape_info.last_scraped,
        scrape_info.last_scrape_status
      FROM vendors v
      LEFT JOIN LATERAL (
        SELECT
          (SELECT COUNT(*)::int FROM products WHERE vendor_id = v.id) as total_products,
          (SELECT COUNT(*)::int FROM skus s JOIN products p ON s.product_id = p.id WHERE p.vendor_id = v.id) as total_skus,
          (SELECT COUNT(DISTINCT s.id)::int FROM skus s JOIN products p ON s.product_id = p.id
           WHERE p.vendor_id = v.id AND EXISTS (
             SELECT 1 FROM media_assets ma WHERE (ma.sku_id = s.id OR (ma.product_id = p.id AND ma.sku_id IS NULL)) AND ma.asset_type = 'primary'
           )) as skus_with_images,
          (SELECT COUNT(*)::int FROM pricing pr JOIN skus s ON pr.sku_id = s.id JOIN products p ON s.product_id = p.id WHERE p.vendor_id = v.id) as skus_with_pricing,
          (SELECT COUNT(*)::int FROM packaging pk JOIN skus s ON pk.sku_id = s.id JOIN products p ON s.product_id = p.id WHERE p.vendor_id = v.id) as skus_with_packaging,
          (SELECT COUNT(*)::int FROM products WHERE vendor_id = v.id AND ((description_short IS NOT NULL AND description_short != '') OR (description_long IS NOT NULL AND description_long != ''))) as products_with_description,
          (SELECT COUNT(*)::int FROM products WHERE vendor_id = v.id AND status = 'draft') as products_in_draft,
          (SELECT COUNT(DISTINCT s.id)::int FROM skus s JOIN products p ON s.product_id = p.id
           WHERE p.vendor_id = v.id AND EXISTS (SELECT 1 FROM sku_attributes sa WHERE sa.sku_id = s.id)) as skus_with_attributes
      ) stats ON true
      LEFT JOIN LATERAL (
        SELECT sj.completed_at as last_scraped, sj2.status as last_scrape_status
        FROM (SELECT 1) x
        LEFT JOIN LATERAL (
          SELECT sj.completed_at FROM scrape_jobs sj JOIN vendor_sources vs ON sj.vendor_source_id = vs.id
          WHERE vs.vendor_id = v.id AND sj.status = 'completed' ORDER BY sj.completed_at DESC LIMIT 1
        ) sj ON true
        LEFT JOIN LATERAL (
          SELECT sj.status FROM scrape_jobs sj JOIN vendor_sources vs ON sj.vendor_source_id = vs.id
          WHERE vs.vendor_id = v.id ORDER BY sj.created_at DESC LIMIT 1
        ) sj2 ON true
      ) scrape_info ON true
      ORDER BY v.name
    `);
    res.json({ vendors: result.rows });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== Scraper Health Monitoring ==========
async function computeScraperHealth() {
  const result = await pool.query(`
    WITH recent_jobs AS (
      SELECT sj.*, ROW_NUMBER() OVER (PARTITION BY sj.vendor_source_id ORDER BY sj.created_at DESC) AS rn
      FROM scrape_jobs sj
    ),
    job_stats AS (
      SELECT vendor_source_id,
        COUNT(*)::int AS total_recent,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
        MAX(completed_at) FILTER (WHERE status = 'completed') AS last_success_at
      FROM recent_jobs WHERE rn <= 5
      GROUP BY vendor_source_id
    ),
    last_completed AS (
      SELECT DISTINCT ON (vendor_source_id) vendor_source_id, products_found AS last_products_found
      FROM recent_jobs WHERE status = 'completed' ORDER BY vendor_source_id, rn
    ),
    prev_completed AS (
      SELECT DISTINCT ON (vendor_source_id) vendor_source_id, products_found AS prev_products_found
      FROM recent_jobs WHERE status = 'completed' AND rn >= 2 ORDER BY vendor_source_id, rn
    )
    SELECT vs.id AS source_id, vs.name AS source_name, vs.scraper_key, vs.schedule,
      vs.is_active, vs.last_scraped_at, v.id AS vendor_id, v.name AS vendor_name,
      COALESCE(dq.total_products, 0)::int AS total_products,
      COALESCE(dq.active_products, 0)::int AS active_products,
      COALESCE(dq.total_skus, 0)::int AS total_skus,
      COALESCE(dq.skus_with_images, 0)::int AS skus_with_images,
      COALESCE(dq.skus_with_pricing, 0)::int AS skus_with_pricing,
      COALESCE(dq.skus_zero_retail, 0)::int AS skus_zero_retail,
      js.total_recent, js.completed_count, js.failed_count, js.last_success_at,
      lc.last_products_found, pc.prev_products_found
    FROM vendor_sources vs
    JOIN vendors v ON v.id = vs.vendor_id
    LEFT JOIN LATERAL (
      SELECT
        (SELECT COUNT(*)::int FROM products WHERE vendor_id = v.id) AS total_products,
        (SELECT COUNT(*)::int FROM products WHERE vendor_id = v.id AND status = 'active') AS active_products,
        (SELECT COUNT(*)::int FROM skus s JOIN products p ON s.product_id = p.id WHERE p.vendor_id = v.id) AS total_skus,
        (SELECT COUNT(DISTINCT s.id)::int FROM skus s JOIN products p ON s.product_id = p.id
         WHERE p.vendor_id = v.id AND EXISTS (
           SELECT 1 FROM media_assets ma WHERE (ma.sku_id = s.id OR (ma.product_id = p.id AND ma.sku_id IS NULL)) AND ma.asset_type = 'primary'
         )) AS skus_with_images,
        (SELECT COUNT(*)::int FROM pricing pr JOIN skus s ON pr.sku_id = s.id JOIN products p ON s.product_id = p.id WHERE p.vendor_id = v.id) AS skus_with_pricing,
        (SELECT COUNT(*)::int FROM pricing pr JOIN skus s ON pr.sku_id = s.id JOIN products p ON s.product_id = p.id
         WHERE p.vendor_id = v.id AND pr.retail_price IS NOT NULL AND pr.retail_price = 0) AS skus_zero_retail
    ) dq ON true
    LEFT JOIN job_stats js ON js.vendor_source_id = vs.id
    LEFT JOIN last_completed lc ON lc.vendor_source_id = vs.id
    LEFT JOIN prev_completed pc ON pc.vendor_source_id = vs.id
    WHERE vs.is_active = true
    ORDER BY v.name, vs.name
  `);

  const scheduleLabel = (s) => {
    if (!s) return 'Manual';
    if (s === '0 0 * * 0') return 'Weekly';
    if (s === '0 0 * * *') return 'Daily';
    if (s === '0 0 1 * *') return 'Monthly';
    return s;
  };

  const scheduleHours = (s) => {
    if (!s) return null;
    if (s === '0 0 * * 0') return 168;
    if (s === '0 0 * * *') return 24;
    if (s === '0 0 1 * *') return 720;
    // Try to parse simple cron intervals
    const parts = (s || '').split(' ');
    if (parts[1] && parts[1].startsWith('*/')) return parseInt(parts[1].slice(2)) || null;
    return null;
  };

  const now = new Date();
  let healthy = 0, warning = 0, critical = 0;

  const sources = result.rows.map(r => {
    const issues = [];
    let status = 'healthy';

    // Freshness check
    const hoursSince = r.last_scraped_at ? (now - new Date(r.last_scraped_at)) / 3600000 : null;
    let freshness = 'ok';
    const interval = scheduleHours(r.schedule);
    if (hoursSince == null) {
      freshness = 'critical';
      issues.push('Never scraped');
    } else if (interval) {
      if (hoursSince > interval * 4) { freshness = 'critical'; issues.push(`Last scrape ${Math.round(hoursSince)}h ago (expected every ${interval}h)`); }
      else if (hoursSince > interval * 2) { freshness = 'stale'; issues.push(`Last scrape ${Math.round(hoursSince)}h ago (expected every ${interval}h)`); }
    } else {
      if (hoursSince > 336) { freshness = 'critical'; issues.push(`Last scrape ${Math.round(hoursSince / 24)} days ago`); }
      else if (hoursSince > 168) { freshness = 'stale'; issues.push(`Last scrape ${Math.round(hoursSince / 24)} days ago`); }
    }

    // Job success rate
    const totalRecent = r.total_recent || 0;
    const failedCount = r.failed_count || 0;
    const completedCount = r.completed_count || 0;
    const successRate = totalRecent > 0 ? (completedCount / totalRecent * 100) : null;
    if (totalRecent > 0 && failedCount / totalRecent > 0.5) {
      issues.push(`${failedCount} of last ${totalRecent} jobs failed (${(failedCount / totalRecent * 100).toFixed(0)}%)`);
    } else if (totalRecent > 0 && failedCount / totalRecent > 0.2) {
      issues.push(`${failedCount} of last ${totalRecent} jobs failed`);
    }

    // Image coverage
    const activeProducts = r.active_products || 0;
    const imgCoverage = activeProducts > 0 ? (r.skus_with_images / r.total_skus * 100) : null;
    if (imgCoverage != null && imgCoverage < 50) {
      issues.push(`Image coverage below 50% (${imgCoverage.toFixed(1)}%)`);
    } else if (imgCoverage != null && imgCoverage < 70) {
      issues.push(`Image coverage below 70% (${imgCoverage.toFixed(1)}%)`);
    }

    // Zero retail pricing
    const pricedSkus = r.skus_with_pricing || 0;
    const zeroRetailPct = pricedSkus > 0 ? (r.skus_zero_retail / pricedSkus * 100) : 0;
    if (zeroRetailPct > 5) {
      issues.push(`${zeroRetailPct.toFixed(1)}% of priced SKUs have $0 retail`);
    }

    // Product count delta
    const lastFound = r.last_products_found != null ? parseInt(r.last_products_found) : null;
    const prevFound = r.prev_products_found != null ? parseInt(r.prev_products_found) : null;
    let delta = null;
    if (lastFound != null && prevFound != null && prevFound > 0) {
      const change = lastFound - prevFound;
      const changePct = (change / prevFound) * 100;
      delta = { last: lastFound, prev: prevFound, change };
      if (changePct < -50) {
        issues.push(`Product count dropped ${Math.abs(changePct).toFixed(0)}% (${prevFound} → ${lastFound})`);
      } else if (changePct < -20) {
        issues.push(`Product count dropped ${Math.abs(changePct).toFixed(0)}% (${prevFound} → ${lastFound})`);
      }
    }

    // Determine overall status
    const hasCritical = freshness === 'critical' ||
      (totalRecent > 0 && failedCount / totalRecent > 0.5) ||
      (imgCoverage != null && imgCoverage < 50) ||
      (delta && prevFound > 0 && (delta.change / prevFound) * 100 < -50);
    const hasWarning = freshness === 'stale' ||
      (totalRecent > 0 && failedCount / totalRecent > 0.2) ||
      (imgCoverage != null && imgCoverage < 70) ||
      zeroRetailPct > 5 ||
      (delta && prevFound > 0 && (delta.change / prevFound) * 100 < -20);

    if (hasCritical) { status = 'critical'; critical++; }
    else if (hasWarning) { status = 'warning'; warning++; }
    else { healthy++; }

    return {
      source_id: r.source_id,
      source_name: r.source_name,
      scraper_key: r.scraper_key,
      schedule: r.schedule,
      schedule_label: scheduleLabel(r.schedule),
      vendor_id: r.vendor_id,
      vendor_name: r.vendor_name,
      last_scraped_at: r.last_scraped_at,
      freshness,
      hours_since_scrape: hoursSince != null ? Math.round(hoursSince) : null,
      job_stats: {
        total_recent: totalRecent,
        completed: completedCount,
        failed: failedCount,
        success_rate: successRate != null ? Math.round(successRate) : null,
        last_success_at: r.last_success_at
      },
      data_quality: {
        active_products: activeProducts,
        total_skus: r.total_skus || 0,
        image_coverage_pct: imgCoverage != null ? Math.round(imgCoverage * 10) / 10 : null,
        pricing_coverage_pct: r.total_skus > 0 ? Math.round(pricedSkus / r.total_skus * 1000) / 10 : null,
        zero_retail_pct: Math.round(zeroRetailPct * 10) / 10
      },
      delta,
      status,
      issues
    };
  });

  return {
    generated_at: now.toISOString(),
    summary: { total_sources: sources.length, healthy, warning, critical },
    sources
  };
}

app.get('/api/admin/scraper-health', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const healthData = await computeScraperHealth();
    res.json(healthData);
  } catch (err) {
    console.error('[ScraperHealth] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor health detail (single vendor)
app.get('/api/admin/vendor-health/:vendorId', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { vendorId } = req.params;

    // Vendor info
    const vendorRes = await pool.query('SELECT id, name, code FROM vendors WHERE id = $1', [vendorId]);
    if (!vendorRes.rows.length) return res.status(404).json({ error: 'Vendor not found' });
    const vendor = vendorRes.rows[0];

    // Coverage stats — use subqueries to avoid expensive multi-join
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM products WHERE vendor_id = $1) as total_products,
        (SELECT COUNT(*)::int FROM skus s JOIN products p ON s.product_id = p.id WHERE p.vendor_id = $1) as total_skus,
        (SELECT COUNT(DISTINCT s.id)::int FROM skus s JOIN products p ON s.product_id = p.id
         WHERE p.vendor_id = $1 AND EXISTS (
           SELECT 1 FROM media_assets ma WHERE (ma.sku_id = s.id OR (ma.product_id = p.id AND ma.sku_id IS NULL)) AND ma.asset_type = 'primary'
         )) as skus_with_images,
        (SELECT COUNT(*)::int FROM pricing pr JOIN skus s ON pr.sku_id = s.id JOIN products p ON s.product_id = p.id WHERE p.vendor_id = $1) as skus_with_pricing,
        (SELECT COUNT(*)::int FROM packaging pk JOIN skus s ON pk.sku_id = s.id JOIN products p ON s.product_id = p.id WHERE p.vendor_id = $1) as skus_with_packaging,
        (SELECT COUNT(*)::int FROM products WHERE vendor_id = $1 AND ((description_short IS NOT NULL AND description_short != '') OR (description_long IS NOT NULL AND description_long != ''))) as products_with_description,
        (SELECT COUNT(*)::int FROM products WHERE vendor_id = $1 AND status = 'draft') as products_in_draft,
        (SELECT COUNT(*)::int FROM products WHERE vendor_id = $1 AND category_id IS NOT NULL) as products_with_category,
        (SELECT COUNT(*)::int FROM skus s JOIN products p ON s.product_id = p.id WHERE p.vendor_id = $1 AND s.sell_by IS NOT NULL) as skus_with_sell_by,
        (SELECT COUNT(DISTINCT s.id)::int FROM skus s JOIN products p ON s.product_id = p.id
         WHERE p.vendor_id = $1 AND EXISTS (SELECT 1 FROM sku_attributes sa WHERE sa.sku_id = s.id)) as skus_with_attributes
    `, [vendorId]);

    // SKUs missing critical data (images, pricing)
    const missingImages = await pool.query(`
      SELECT s.id, s.internal_sku, s.vendor_sku, COALESCE(p.display_name, p.name) as product_name, p.collection
      FROM skus s
      JOIN products p ON s.product_id = p.id
      WHERE p.vendor_id = $1 AND NOT EXISTS (
        SELECT 1 FROM media_assets ma
        WHERE (ma.sku_id = s.id OR (ma.product_id = p.id AND ma.sku_id IS NULL))
        AND ma.asset_type = 'primary'
      )
      ORDER BY p.name, s.internal_sku
      LIMIT 50
    `, [vendorId]);

    const missingPricing = await pool.query(`
      SELECT s.id, s.internal_sku, s.vendor_sku, COALESCE(p.display_name, p.name) as product_name, p.collection
      FROM skus s
      JOIN products p ON s.product_id = p.id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      WHERE p.vendor_id = $1 AND pr.sku_id IS NULL
      ORDER BY p.name, s.internal_sku
      LIMIT 50
    `, [vendorId]);

    const missingPackaging = await pool.query(`
      SELECT s.id, s.internal_sku, s.vendor_sku, COALESCE(p.display_name, p.name) as product_name, p.collection
      FROM skus s
      JOIN products p ON s.product_id = p.id
      LEFT JOIN packaging pk ON pk.sku_id = s.id
      WHERE p.vendor_id = $1 AND pk.sku_id IS NULL
      ORDER BY p.name, s.internal_sku
      LIMIT 50
    `, [vendorId]);

    // Recent scrape jobs
    const scrapeJobs = await pool.query(`
      SELECT sj.id, sj.status, sj.started_at, sj.completed_at,
             sj.products_found, sj.products_created, sj.products_updated, sj.skus_created,
             vs.name as source_name, vs.source_type
      FROM scrape_jobs sj
      JOIN vendor_sources vs ON sj.vendor_source_id = vs.id
      WHERE vs.vendor_id = $1
      ORDER BY sj.created_at DESC
      LIMIT 10
    `, [vendorId]);

    res.json({
      vendor,
      stats: stats.rows[0],
      missing: {
        images: missingImages.rows,
        pricing: missingPricing.rows,
        packaging: missingPackaging.rows,
      },
      scrape_jobs: scrapeJobs.rows,
    });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Create category
app.post('/api/admin/categories', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { name, slug, parent_id, sort_order, description, banner_image } = req.body;
    if (!name || !slug) return res.status(400).json({ error: 'Name and slug are required' });

    const result = await pool.query(`
      INSERT INTO categories (name, slug, parent_id, sort_order, description, banner_image)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [name, slug, parent_id || null, sort_order || 0, description || null, banner_image || null]);
    res.json({ category: result.rows[0] });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Update category
app.put('/api/admin/categories/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, slug, parent_id, sort_order, description, banner_image } = req.body;

    const result = await pool.query(`
      UPDATE categories SET
        name = COALESCE($1, name),
        slug = COALESCE($2, slug),
        parent_id = COALESCE($3, parent_id),
        sort_order = COALESCE($4, sort_order),
        description = $5,
        banner_image = $6,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $7
      RETURNING *
    `, [name, slug, parent_id, sort_order, description || null, banner_image || null, id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Category not found' });
    res.json({ category: result.rows[0] });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
      SELECT oi.*, COALESCE(p.display_name, p.name) as current_product_name, p.collection as current_collection,
        v.name as vendor_name, s.vendor_sku, s.variant_name,
        sa_c.value as color
      FROM order_items oi
      LEFT JOIN skus s ON s.id = oi.sku_id
      LEFT JOIN products p ON p.id = COALESCE(s.product_id, oi.product_id)
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = oi.sku_id
        AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
      WHERE oi.order_id = $1
      ORDER BY oi.id
    `, [id]);

    const payments = await pool.query('SELECT * FROM order_payments WHERE order_id = $1 ORDER BY created_at', [id]);
    const paymentRequests = await pool.query('SELECT * FROM payment_requests WHERE order_id = $1 ORDER BY created_at DESC', [id]);
    const balanceInfo = await recalculateBalance(pool, id);

    res.json({ order: order.rows[0], items: items.rows, payments: payments.rows, payment_requests: paymentRequests.rows, balance: balanceInfo });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Update order status
app.put('/api/admin/orders/:id/status', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { status, tracking_number, carrier, shipped_at } = req.body;
    const validStatuses = ['pending', 'confirmed', 'ready_for_pickup', 'shipped', 'delivered', 'cancelled', 'refunded'];
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
    } else if (status === 'ready_for_pickup') {
      result = await client.query(
        'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
        [status, id]
      );
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

    // Auto-generate and send invoice when order ships
    if (status === 'shipped') {
      setImmediate(() => autoGenerateAndSendInvoice(id));
    }

    // Notify assigned rep about admin status change
    if (updatedOrder.sales_rep_id) {
      setImmediate(() => createRepNotification(pool, updatedOrder.sales_rep_id, 'order_status_changed',
        'Order ' + updatedOrder.order_number + ' → ' + status,
        'Admin changed status to ' + status,
        'order', id));
    }

    // Auto-task: post-delivery follow-up when admin marks order delivered
    if (status === 'delivered') {
      const assignRepId = updatedOrder.sales_rep_id;
      setImmediate(async () => {
        try {
          let repId = assignRepId;
          if (!repId) {
            const fallback = await pool.query('SELECT id FROM sales_reps WHERE is_active = true ORDER BY created_at LIMIT 1');
            repId = fallback.rows.length ? fallback.rows[0].id : null;
          }
          if (repId) {
            await createAutoTask(pool, repId, 'order_delivered', id,
              `Post-delivery follow-up — ${updatedOrder.customer_name} (${updatedOrder.order_number})`, {
                priority: 'low', customer_name: updatedOrder.customer_name,
                customer_email: updatedOrder.customer_email, customer_phone: updatedOrder.customer_phone,
                linked_order_id: id
              });
          }
        } catch (err) { console.error('[AutoTask] order_delivered admin error:', err.message); }
      });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
      const balanceInfo = await recalculateBalance(pool, id);
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
    const balanceInfo = await recalculateBalance(pool, id);
    return res.json({ order: updated.rows[0], balance: balanceInfo });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    const refundOpRes = await pool.query(`
      INSERT INTO order_payments (order_id, payment_type, amount, stripe_payment_intent_id, stripe_refund_id, description, initiated_by, initiated_by_name, status)
      VALUES ($1, 'refund', $2, $3, $4, $5, $6, $7, 'completed') RETURNING id
    `, [id, (-refundAmount).toFixed(2), o.stripe_payment_intent_id, refund.id, description, req.staff.id, staffName]);
    await syncOrderPaymentToInvoice(refundOpRes.rows[0].id, id, pool);

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

    // Notify assigned rep about refund
    if (o.sales_rep_id) {
      setImmediate(() => createRepNotification(pool, o.sales_rep_id, 'refund_issued',
        `Refund issued on ${o.order_number}`,
        `${staffName} refunded $${refundAmount.toFixed(2)}${isFullRefund ? ' (full)' : ' (partial)'}${reason ? ' — ' + reason : ''}`,
        'order', id));
    }

    const balanceInfo = await recalculateBalance(pool, id);
    res.json({ order: result.rows[0], balance: balanceInfo });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    const { sku_id, num_boxes, sqft_needed, product_name, unit_price, vendor_id, description, sell_by: customSellBy } = req.body;

    const isCustom = !sku_id;
    if (isCustom) {
      if (!product_name || !product_name.trim()) return res.status(400).json({ error: 'product_name is required for custom items' });
      if (unit_price == null || parseFloat(unit_price) < 0) return res.status(400).json({ error: 'unit_price >= 0 is required for custom items' });
      if (!vendor_id) return res.status(400).json({ error: 'vendor_id is required for custom items' });
      if (!num_boxes || num_boxes < 1) return res.status(400).json({ error: 'num_boxes >= 1 is required' });
    } else {
      // For carpet (per_sqyd), sqft_needed is required instead of num_boxes
      if ((!num_boxes || num_boxes < 1) && !sqft_needed) return res.status(400).json({ error: 'sku_id and num_boxes (>= 1) or sqft_needed are required' });
    }

    const orderResult = await client.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (!orderResult.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (!['pending', 'confirmed'].includes(order.status)) {
      return res.status(400).json({ error: 'Can only add items to pending or confirmed orders' });
    }

    let sku = null;
    let unitPrice, sqftPerBox, isPerSqft, computedSqft, itemSubtotal;
    let itemVendorId;

    if (!isCustom) {
      // SKU mode: Look up SKU + product + pricing + cost + color
      const skuResult = await client.query(`
        SELECT s.*, COALESCE(p.display_name, p.name) as product_name, p.collection, p.vendor_id,
          pr.retail_price, pr.price_basis, pr.cost, pr.cut_price, pr.roll_price,
          pk.sqft_per_box, pk.weight_per_box_lbs, pk.roll_width_ft,
          sa_c.value as color
        FROM skus s
        JOIN products p ON p.id = s.product_id
        LEFT JOIN pricing pr ON pr.sku_id = s.id
        LEFT JOIN packaging pk ON pk.sku_id = s.id
        LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = s.id
          AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
        WHERE s.id = $1
      `, [sku_id]);
      if (!skuResult.rows.length) return res.status(404).json({ error: 'SKU not found' });
      sku = skuResult.rows[0];

      const isCarpet = sku.price_basis === 'per_sqyd';
      unitPrice = parseFloat(sku.retail_price || 0);
      sqftPerBox = parseFloat(sku.sqft_per_box || 1);
      isPerSqft = sku.price_basis === 'per_sqft' || sku.price_basis === 'sqft';

      if (isCarpet) {
        computedSqft = parseFloat(sqft_needed || 0);
        const sqyd = computedSqft / 9;
        itemSubtotal = parseFloat((unitPrice * sqyd).toFixed(2));
      } else {
        computedSqft = isPerSqft ? num_boxes * sqftPerBox : null;
        itemSubtotal = parseFloat((isPerSqft ? unitPrice * computedSqft : unitPrice * num_boxes).toFixed(2));
      }
      itemVendorId = sku.vendor_id;
    } else {
      // Custom mode
      unitPrice = parseFloat(unit_price);
      if (customSellBy === 'sqyd') {
        // Carpet custom: num_boxes is sqft, price is per sqyd
        itemSubtotal = parseFloat((unitPrice * (num_boxes / 9)).toFixed(2));
      } else {
        itemSubtotal = parseFloat((unitPrice * num_boxes).toFixed(2));
      }
      itemVendorId = vendor_id;

      // Validate vendor exists
      const vendorCheck = await client.query('SELECT id FROM vendors WHERE id = $1', [vendor_id]);
      if (!vendorCheck.rows.length) return res.status(400).json({ error: 'Vendor not found' });
    }

    await client.query('BEGIN');

    // Build full descriptive product name for SKU items
    let storedProductName, storedDescription;
    if (!isCustom) {
      const descParts = [sku.color, sku.variant_name && sku.variant_name !== sku.color ? sku.variant_name : null].filter(Boolean).join(' · ');
      storedProductName = sku.collection
        ? (descParts ? sku.collection + ' — ' + descParts : sku.collection)
        : (descParts ? sku.product_name + ' — ' + descParts : sku.product_name);
      storedDescription = descParts || null;
    }

    // Insert order item
    let newItemId;
    if (!isCustom) {
      const isCarpet = sku.price_basis === 'per_sqyd';
      const insertResult = await client.query(`
        INSERT INTO order_items (order_id, product_id, sku_id, product_name, collection, description,
          sqft_needed, num_boxes, unit_price, subtotal, is_sample, sell_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, $11)
        RETURNING id
      `, [id, sku.product_id, sku_id, storedProductName, sku.collection, storedDescription,
          sqft_needed || computedSqft || null, isCarpet ? 1 : num_boxes, unitPrice.toFixed(2), itemSubtotal.toFixed(2),
          isCarpet ? 'sqyd' : (sku.sell_by || null)]);
      newItemId = insertResult.rows[0].id;
    } else {
      const isCustomCarpet = customSellBy === 'sqyd';
      const insertResult = await client.query(`
        INSERT INTO order_items (order_id, product_id, sku_id, product_name, collection,
          sqft_needed, num_boxes, unit_price, subtotal, is_sample, sell_by, description)
        VALUES ($1, NULL, NULL, $2, NULL, $3, $4, $5, $6, false, $7, $8)
        RETURNING id
      `, [id, product_name.trim(), isCustomCarpet ? num_boxes : (sqft_needed || null),
          isCustomCarpet ? 1 : num_boxes, unitPrice.toFixed(2),
          itemSubtotal.toFixed(2), customSellBy || null, description || null]);
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
    {
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
        const poNumber = await getNextPONumber(vendorCode);
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
        const poIsPerSqft = sku.price_basis === 'per_sqft' || sku.price_basis === 'sqft';
        poCost = poIsPerSqft ? vendorCost * skuSqftPerBox : vendorCost;
        poRetail = poIsPerSqft ? unitPrice * skuSqftPerBox : unitPrice;
        poVendorSku = sku.vendor_sku;
        poProductName = storedProductName;
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
      { product_name: isCustom ? product_name.trim() : storedProductName, is_custom: isCustom, num_boxes, subtotal: itemSubtotal.toFixed(2) });

    await client.query('COMMIT');

    const balanceInfo = await recalculateBalance(pool, id);
    const updatedOrder = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    const updatedItems = await pool.query(`
      SELECT oi.*, COALESCE(p.display_name, p.name) as current_product_name, p.collection as current_collection,
        v.name as vendor_name, s.vendor_sku, s.variant_name,
        sa_c.value as color
      FROM order_items oi
      LEFT JOIN skus s ON s.id = oi.sku_id
      LEFT JOIN products p ON p.id = COALESCE(s.product_id, oi.product_id)
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = oi.sku_id
        AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
      WHERE oi.order_id = $1 ORDER BY oi.id
    `, [id]);

    // Fetch updated POs for response
    const posResult = await pool.query(`
      SELECT po.*, v.name as vendor_name, v.edi_config
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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

    const balanceInfo = await recalculateBalance(pool, id);
    const updatedOrder = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    const updatedItems = await pool.query(`
      SELECT oi.*, COALESCE(p.display_name, p.name) as current_product_name, p.collection as current_collection,
        v.name as vendor_name, s.vendor_sku, s.variant_name,
        sa_c.value as color
      FROM order_items oi
      LEFT JOIN skus s ON s.id = oi.sku_id
      LEFT JOIN products p ON p.id = COALESCE(s.product_id, oi.product_id)
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = oi.sku_id
        AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
      WHERE oi.order_id = $1 ORDER BY oi.id
    `, [id]);

    // Fetch updated POs
    const posResult = await pool.query(`
      SELECT po.*, v.name as vendor_name, v.edi_config
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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

    const balanceInfo = await recalculateBalance(pool, id);
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

    // Notify assigned rep about admin-sent payment request
    if (o.sales_rep_id) {
      setImmediate(() => createRepNotification(pool, o.sales_rep_id, 'payment_request_sent',
        `Payment request sent for ${o.order_number}`,
        `${staffName} sent $${amountDue.toFixed(2)} payment request to ${o.customer_email}`,
        'order', id));
    }

    // Send email
    setImmediate(() => sendPaymentRequest({ order: o, amount: amountDue, checkout_url: session.url, message: message || null }));

    res.json({ payment_request: prResult.rows[0], checkout_url: session.url });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Shared SKU search with FTS, SKU fast path, trigram fallback, and images
async function searchSkus(pool, rawQuery) {
  const raw = (rawQuery || '').trim();
  if (!raw || raw.length < 2) return [];

  const normalized = normalizeSearchQuery(raw);
  const sanitized = normalized.replace(/[^\w\s'.-]/g, '').trim();
  if (!sanitized) return [];

  const { text: expanded } = expandSynonyms(sanitized);
  const words = expanded.split(/\s+/).filter(Boolean);
  const andTsQuery = words.map(w => w + ':*').join(' & ');
  const orTsQuery = words.map(w => w + ':*').join(' | ');
  const phraseInput = expanded;

  // Detect SKU-like patterns
  const isSkuLike = /[a-zA-Z]/.test(sanitized) && /\d/.test(sanitized) && /^[\w.-]+$/.test(sanitized.replace(/\s/g, ''));

  const baseCols = `
    s.id as sku_id, s.internal_sku, s.vendor_sku, s.variant_name, s.is_sample, s.sell_by,
    COALESCE(p.display_name, p.name) as product_name, p.collection, p.vendor_id,
    v.name as vendor_name,
    pr.retail_price, pr.cost as vendor_cost, pr.price_basis, pr.cut_price, pr.roll_price,
    pk.sqft_per_box, pk.roll_width_ft,
    sa_c.value as color`;
  const baseJoins = `
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    LEFT JOIN packaging pk ON pk.sku_id = s.id
    LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = s.id
      AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)`;
  const imageSelect = `
    COALESCE(
      (SELECT url FROM media_assets WHERE sku_id = s.id AND asset_type = 'primary' LIMIT 1),
      (SELECT url FROM media_assets WHERE product_id = p.id AND asset_type = 'primary' AND sku_id IS NULL LIMIT 1),
      (SELECT url FROM media_assets WHERE sku_id = s.id AND asset_type IN ('alternate','lifestyle') LIMIT 1),
      (SELECT url FROM media_assets WHERE product_id = p.id AND asset_type IN ('alternate','lifestyle') AND sku_id IS NULL LIMIT 1)
    ) as primary_image`;

  // 1. SKU fast path — direct prefix match on vendor_sku / internal_sku
  let skuRows = [];
  if (isSkuLike) {
    const skuSearch = sanitized.replace(/\s+/g, '');
    const skuResult = await pool.query(`
      SELECT ${baseCols}, ${imageSelect}
      ${baseJoins}
      WHERE p.status = 'active' AND s.status = 'active'
        AND (s.vendor_sku ILIKE $1 || '%' OR s.internal_sku ILIKE $1 || '%')
      ORDER BY CASE WHEN LOWER(s.vendor_sku) = LOWER($1) THEN 0 WHEN LOWER(s.internal_sku) = LOWER($1) THEN 0 ELSE 1 END,
               s.vendor_sku
      LIMIT 8
    `, [skuSearch]);
    skuRows = skuResult.rows;
  }

  // 2. FTS path — phrase → AND → OR progressive matching (returns all SKUs, not distinct product)
  const ftsResult = await pool.query(`
    WITH phrase_products AS (
      SELECT p.id,
        ts_rank(p.search_vector, phraseto_tsquery('english', unaccent($3))) * 4.0 as score
      FROM products p
      WHERE p.status = 'active'
        AND p.search_vector @@ phraseto_tsquery('english', unaccent($3))
      LIMIT 20
    ),
    and_products AS (
      SELECT p.id,
        ts_rank(p.search_vector, to_tsquery('english', unaccent($1))) * 2.0 as score
      FROM products p
      WHERE p.status = 'active'
        AND p.search_vector @@ to_tsquery('english', unaccent($1))
        AND p.id NOT IN (SELECT id FROM phrase_products)
      LIMIT 20
    ),
    or_products AS (
      SELECT p.id,
        ts_rank(p.search_vector, to_tsquery('english', unaccent($2))) * 0.5 as score
      FROM products p
      WHERE p.status = 'active'
        AND p.search_vector @@ to_tsquery('english', unaccent($2))
        AND p.id NOT IN (SELECT id FROM phrase_products)
        AND p.id NOT IN (SELECT id FROM and_products)
        AND (SELECT COUNT(*) FROM phrase_products) + (SELECT COUNT(*) FROM and_products) < 20
      LIMIT 20
    ),
    all_matches AS (
      SELECT * FROM phrase_products
      UNION ALL SELECT * FROM and_products
      UNION ALL SELECT * FROM or_products
    ),
    ranked AS (
      SELECT am.id, am.score
        + CASE WHEN LOWER(p.name) = LOWER($4) OR LOWER(p.collection) = LOWER($4) THEN 5.0 ELSE 0.0 END as final_score
      FROM all_matches am
      JOIN products p ON p.id = am.id
      ORDER BY am.score
        + CASE WHEN LOWER(p.name) = LOWER($4) OR LOWER(p.collection) = LOWER($4) THEN 5.0 ELSE 0.0 END DESC
      LIMIT 20
    )
    SELECT ${baseCols}, ${imageSelect}, r.final_score
    ${baseJoins}
    JOIN ranked r ON r.id = p.id
    WHERE s.status = 'active'
    ORDER BY r.final_score DESC, p.name, s.variant_name
    LIMIT 20
  `, [andTsQuery, orTsQuery, phraseInput, sanitized]);

  let ftsRows = ftsResult.rows;

  // 3. Trigram fallback if few results
  if (skuRows.length + ftsRows.length < 8) {
    const existingIds = [...new Set([...skuRows, ...ftsRows].map(r => r.sku_id))];
    const trgmResult = await pool.query(`
      WITH trgm_products AS (
        SELECT p.id, greatest(similarity(p.name, $1), similarity(p.collection, $1)) as trgm_score
        FROM products p
        WHERE p.status = 'active'
          AND (p.name % $1 OR p.collection % $1)
        ORDER BY greatest(similarity(p.name, $1), similarity(p.collection, $1)) DESC
        LIMIT 10
      )
      SELECT ${baseCols}, ${imageSelect}, 0::float as final_score
      ${baseJoins}
      JOIN trgm_products tp ON tp.id = p.id
      WHERE s.status = 'active'
        ${existingIds.length > 0 ? 'AND s.id != ALL($2::uuid[])' : ''}
      ORDER BY tp.trgm_score DESC, p.name, s.variant_name
      LIMIT 10
    `, existingIds.length > 0 ? [sanitized, existingIds] : [sanitized]);
    ftsRows = ftsRows.concat(trgmResult.rows);
  }

  // Merge + deduplicate by sku_id, SKU matches first
  const seen = new Set();
  const merged = [];
  for (const row of [...skuRows, ...ftsRows]) {
    if (!seen.has(row.sku_id)) {
      seen.add(row.sku_id);
      merged.push(row);
    }
  }
  return merged.slice(0, 20);
}

// SKU search for add-item (admin)
app.get('/api/admin/skus/search', staffAuth, async (req, res) => {
  try {
    const results = await searchSkus(pool, req.query.q);
    res.json({ results });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Spreadsheet Import API ====================

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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error('File parse error:', err);
    res.status(500).json({ error: 'Failed to parse file' });
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

      // PIM enum validation
      const VALID_SELL_BY = ['sqft', 'unit', 'sqyd'];
      const VALID_VARIANT_TYPES = ['accessory', 'floor_tile', 'wall_tile', 'mosaic', 'lvt', 'quarry_tile', 'stone_tile', 'floor_deco'];
      const VALID_PRICE_BASIS = ['per_sqft', 'per_unit', 'per_sqyd', 'sqft', 'unit'];

      if (mapped.sell_by && mapped.sell_by !== '' && !VALID_SELL_BY.includes(mapped.sell_by)) {
        errors.push('sell_by: must be one of: ' + VALID_SELL_BY.join(', '));
      }
      if (mapped.variant_type && mapped.variant_type !== '' && !VALID_VARIANT_TYPES.includes(mapped.variant_type)) {
        errors.push('variant_type: must be one of: ' + VALID_VARIANT_TYPES.join(', '));
      }
      if (mapped.price_basis && mapped.price_basis !== '' && !VALID_PRICE_BASIS.includes(mapped.price_basis)) {
        errors.push('price_basis: must be one of: ' + VALID_PRICE_BASIS.join(', '));
      }

      // Price sanity checks
      const costVal = mapped.cost ? parseFloat(String(mapped.cost).replace(/[$,]/g, '')) : null;
      const retailVal = mapped.retail_price ? parseFloat(String(mapped.retail_price).replace(/[$,]/g, '')) : null;
      if (costVal != null && !isNaN(costVal) && costVal < 0) errors.push('cost: cannot be negative');
      if (retailVal != null && !isNaN(retailVal) && retailVal < 0) errors.push('retail_price: cannot be negative');
      if (costVal > 0 && retailVal > 0 && costVal > retailVal) errors.push('Warning: cost ($' + costVal.toFixed(2) + ') > retail ($' + retailVal.toFixed(2) + ') — negative margin');
      if (costVal > 500) errors.push('Warning: unusually high cost ($' + costVal.toFixed(2) + ')');
      if (retailVal > 1000) errors.push('Warning: unusually high retail ($' + retailVal.toFixed(2) + ')');

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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
      console.error('Import error:', err);
      res.status(500).json({ error: 'Import failed', results });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Scraper API ====================

// --- Scraper orchestration: locking, concurrency, timeouts ---

// Scrapers that launch a Puppeteer browser (high memory — need concurrency limits)
const BROWSER_SCRAPERS = new Set([
  'msi', 'bed', 'goton', 'tradepro-pricebooks', 'tradepro-inventory', 'bosphorus-inventory',
  'triwest-inventory',
  'triwest-provenza', 'triwest-paradigm', 'triwest-quickstep', 'triwest-armstrong',
  'triwest-metroflor', 'triwest-mirage', 'triwest-grandpacific',
  'triwest-bravada', 'triwest-hartco', 'triwest-truetouch',
  'triwest-ahf', 'triwest-flexco', 'triwest-shaw', 'triwest-stanton',
  'triwest-bruce', 'triwest-congoleum', 'triwest-kraus',
  'triwest-tec', 'triwest-bosphorus',
  'triwest-babool', 'triwest-elysium', 'triwest-forester', 'triwest-hardwoodsspecialty',
  'triwest-jmcork', 'triwest-rcglobal', 'triwest-summit',
]);

// Enrichment scrapers (triwest-* brand scrapers) — separate pool so they don't block catalog/inventory
const ENRICHMENT_SCRAPERS = new Set([
  'triwest-provenza', 'triwest-paradigm', 'triwest-quickstep', 'triwest-armstrong',
  'triwest-metroflor', 'triwest-mirage', 'triwest-grandpacific',
  'triwest-bravada', 'triwest-hartco', 'triwest-truetouch',
  'triwest-ahf', 'triwest-flexco', 'triwest-shaw', 'triwest-stanton',
  'triwest-bruce', 'triwest-congoleum', 'triwest-kraus', 'triwest-sika',
  'triwest-tec', 'triwest-bosphorus',
  'triwest-babool', 'triwest-elysium', 'triwest-forester', 'triwest-hardwoodsspecialty',
  'triwest-jmcork', 'triwest-rcglobal', 'triwest-summit',
  'lowes-mapei',
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

      // Post-scrape quality check: compute avg quality + warning count for affected vendor
      try {
        const qualityResult = await pool.query(`
          SELECT ROUND(AVG(qs.quality_score))::int as avg_quality, COUNT(*)::int as skus_affected
          FROM sku_quality_scores qs
          JOIN vendors v ON v.code = qs.vendor_code
          JOIN vendor_sources vs ON vs.vendor_id = v.id
          WHERE vs.id = $1
        `, [source.id]);
        const warningResult = await pool.query(`
          SELECT (regexp_matches(COALESCE(log,''), '⚠ VALIDATION', 'g'))
          FROM scrape_jobs WHERE id = $1
        `, [job.id]);
        const aq = qualityResult.rows[0];
        await pool.query(`
          UPDATE scrape_jobs SET avg_quality_score = $2, skus_affected = $3, warning_count = $4 WHERE id = $1
        `, [job.id, aq?.avg_quality || null, aq?.skus_affected || 0, warningResult.rowCount || 0]);
      } catch (qErr) { console.error('Post-scrape quality check failed:', qErr.message); }

      // Post-scrape AI enrichment: auto-queue if significant gaps found
      try {
        const { maybeQueuePostScrapeEnrichment } = await import('./services/aiEnrichment.js');
        await maybeQueuePostScrapeEnrichment(pool, job.id, source);
      } catch (eErr) { console.error('Post-scrape enrichment hook failed:', eErr.message); }
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
      label: 'MSI Surfaces (Enrichment — Images, Descriptions, Attributes)', source_type: 'website', base_url: 'https://www.msisurfaces.com',
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
    'msi-832': {
      label: 'MSI EDI 832 Price Catalog (FTP)', source_type: 'edi_ftp',
      base_url: 'ftp://cftp.msisurfaces.com', categories: []
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
    'daltile-dam': {
      label: 'Daltile DAM Image Enrichment', source_type: 'portal',
      base_url: 'https://images.daltile.com/assetbank-daltile/',
      categories: []
    },
    'schluter': {
      label: 'Schluter Systems Image Enrichment', source_type: 'website',
      base_url: 'https://www.schluter.com',
      categories: []
    },
    'mapei': {
      label: 'Mapei Image Enrichment', source_type: 'website',
      base_url: 'https://www.mapei.com',
      categories: []
    },
    'daltile-832': {
      label: 'Daltile EDI 832 Catalog (FTP)', source_type: 'edi_ftp',
      base_url: 'ftp://daltileb2b.daltile.com', categories: []
    },
    'daltile-edi-poller': {
      label: 'Daltile EDI Poller (855/856/810)', source_type: 'edi_ftp',
      base_url: 'ftp://daltileb2b.daltile.com', categories: []
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
    'emser-832': {
      label: 'Emser EDI 832 Catalog (SFTP)', source_type: 'edi_sftp',
      base_url: 'sftp://ediftp.emser.com', categories: []
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
    'shaw-data-api': {
      label: 'Shaw Data API (Product Catalog)', source_type: 'api',
      base_url: 'https://DigitalServiceAPI.shawinc.com/ProductAPI/api/v1/Retailer/GetProducts',
      categories: []
    },
    'edi-poller': {
      label: 'Generic EDI Poller (855/856/810)', source_type: 'edi_ftp', base_url: '',
      categories: []
    },
    'triwest-flexco': {
      label: 'Flexco (Enrichment — Images, Descriptions, Attributes)', source_type: 'website',
      base_url: 'https://flexcofloors.com', categories: []
    },
    'triwest-sika': {
      label: 'Sika (Enrichment — Images, Descriptions, Spec PDFs)', source_type: 'website',
      base_url: 'https://usa.sika.com', categories: []
    },
    'lowes-mapei': {
      label: 'Mapei — Fill Missing Products (Grout, Caulk, Thinset)', source_type: 'website',
      base_url: 'https://www.lowes.com', categories: []
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
            sj.products_found, sj.products_created, sj.products_updated,
            sj.avg_quality_score, sj.warning_count
          FROM scrape_jobs sj WHERE sj.vendor_source_id = vs.id
          ORDER BY sj.created_at DESC LIMIT 1
        ) j) as last_job
      FROM vendor_sources vs
      JOIN vendors v ON v.id = vs.vendor_id
      ORDER BY vs.created_at DESC
    `);
    res.json({ sources: result.rows });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Upload price list PDF for a vendor source
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Auth middleware — extracted to lib/auth.js

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
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });

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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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

    // If untrusted device, require 2FA (skip only in non-production)
    if (!isTrusted && fpHash && process.env.NODE_ENV === 'production') {
      const smtpConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
      if (!smtpConfigured) {
        return res.status(503).json({ error: '2FA is required but email service is not configured. Contact an administrator.' });
      }
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
    if (!isTrusted && fpHash && process.env.NODE_ENV !== 'production') {
      console.log(`[Auth] 2FA bypassed for ${emailKey} — non-production environment`);
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/staff/logout', staffAuth, async (req, res) => {
  try {
    const token = req.headers['x-staff-token'];
    await pool.query('DELETE FROM staff_sessions WHERE token = $1', [token]);
    await logAudit(req.staff.id, 'staff.logout', 'staff_accounts', req.staff.id, {}, req.ip);
    res.json({ success: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/staff', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { email, password, first_name, last_name, phone, role } = req.body;
    if (!email || !password || !first_name || !last_name) {
      return res.status(400).json({ error: 'Email, password, first name, and last name are required' });
    }
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Trade Auth Endpoints ====================

app.post('/api/trade/register', async (req, res) => {
  try {
    const { email, password, company_name, contact_name, phone } = req.body;
    if (!email || !password || !company_name || !contact_name) {
      return res.status(400).json({ error: 'Email, password, company name, and contact name are required' });
    }
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });

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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/trade/logout', tradeAuth, async (req, res) => {
  try {
    const token = req.headers['x-trade-token'];
    await pool.query('DELETE FROM trade_sessions WHERE token = $1', [token]);
    res.json({ success: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
        // Handle sample shipping payment
        if (session.metadata && session.metadata.type === 'sample_shipping') {
          const { sample_request_id } = session.metadata;
          if (sample_request_id) {
            await pool.query(
              'UPDATE sample_requests SET shipping_payment_collected = true, shipping_payment_collected_at = NOW() WHERE id = $1',
              [sample_request_id]
            );
          }
        }
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
          const addChargeOpRes = await pool.query(`
            INSERT INTO order_payments (order_id, payment_type, amount, stripe_checkout_session_id, description, status)
            VALUES ($1, 'additional_charge', $2, $3, 'Additional payment via checkout', 'completed') RETURNING id
          `, [order_id, paidAmount.toFixed(2), session.id]);
          await syncOrderPaymentToInvoice(addChargeOpRes.rows[0].id, order_id, pool);

          // Update amount_paid
          await pool.query(
            'UPDATE orders SET amount_paid = amount_paid + $1 WHERE id = $2',
            [paidAmount.toFixed(2), order_id]
          );

          // Send confirmation email
          const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [order_id]);
          if (orderResult.rows.length) {
            setImmediate(() => sendPaymentReceived(orderResult.rows[0], paidAmount));

            // Auto-generate invoice on payment completion
            setImmediate(() => autoGenerateAndSendInvoice(order_id));

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
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const pmTypes = pi.payment_method_types || [];

        // Handle ACH (us_bank_account) settlements
        if (pmTypes.includes('us_bank_account')) {
          const orderResult = await pool.query(
            "SELECT * FROM orders WHERE stripe_payment_intent_id = $1 AND payment_method = 'ach'",
            [pi.id]
          );
          if (orderResult.rows.length) {
            const order = orderResult.rows[0];
            const settledAmount = (pi.amount_received || pi.amount) / 100;
            await pool.query(
              "UPDATE orders SET status = 'confirmed', amount_paid = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
              [settledAmount.toFixed(2), order.id]
            );
            const achOpRes = await pool.query(`
              INSERT INTO order_payments (order_id, payment_type, amount, stripe_payment_intent_id, description, status, payment_method)
              VALUES ($1, 'charge', $2, $3, 'ACH bank transfer payment', 'completed', 'ach') RETURNING id
            `, [order.id, settledAmount.toFixed(2), pi.id]);
            await syncOrderPaymentToInvoice(achOpRes.rows[0].id, order.id, pool);
            await logOrderActivity(pool, order.id, 'payment_received', null, 'System',
              { method: 'ach', amount: settledAmount.toFixed(2) });
            // Generate purchase orders now that payment is confirmed
            setImmediate(() => generatePurchaseOrders(order.id, pool));
          }
        }

        // Handle bank transfer (customer_balance) settlements
        if (pmTypes.includes('customer_balance')) {
          const orderResult = await pool.query(
            "SELECT * FROM orders WHERE stripe_payment_intent_id = $1 AND payment_method = 'bank_transfer'",
            [pi.id]
          );
          if (orderResult.rows.length) {
            const order = orderResult.rows[0];
            const settledAmount = (pi.amount_received || pi.amount) / 100;
            await pool.query(
              "UPDATE orders SET status = 'confirmed', amount_paid = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
              [settledAmount.toFixed(2), order.id]
            );
            await pool.query(
              "UPDATE order_payments SET status = 'completed', description = 'Bank transfer payment received' WHERE order_id = $1 AND stripe_payment_intent_id = $2",
              [order.id, pi.id]
            );
            // Sync the existing order_payment to invoice
            const opRow = await pool.query('SELECT id FROM order_payments WHERE order_id = $1 AND stripe_payment_intent_id = $2 LIMIT 1', [order.id, pi.id]);
            if (opRow.rows.length) {
              await syncOrderPaymentToInvoice(opRow.rows[0].id, order.id, pool);
            }
            await logOrderActivity(pool, order.id, 'payment_received', null, 'System',
              { method: 'bank_transfer', amount: settledAmount.toFixed(2) });
            // Generate purchase orders now that payment is confirmed
            setImmediate(() => generatePurchaseOrders(order.id, pool));
            // Send order confirmation email
            const orderItems = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
            const emailOrder = { ...order, status: 'confirmed', amount_paid: settledAmount.toFixed(2), items: orderItems.rows };
            setImmediate(() => sendOrderConfirmation(emailOrder));
            // Notify reps
            setImmediate(() => notifyAllActiveReps(pool, 'payment_received',
              'Bank Transfer Received — ' + order.order_number,
              'Bank transfer payment of $' + settledAmount.toFixed(2) + ' received for ' + order.order_number + '. Order confirmed.',
              'order', order.id));
          }
        }
        break;
      }
      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        const pmTypes = pi.payment_method_types || [];

        if (pmTypes.includes('us_bank_account') || pmTypes.includes('customer_balance')) {
          const payMethod = pmTypes.includes('customer_balance') ? 'bank_transfer' : 'ach';
          const orderResult = await pool.query(
            "SELECT * FROM orders WHERE stripe_payment_intent_id = $1 AND payment_method = $2",
            [pi.id, payMethod]
          );
          if (orderResult.rows.length) {
            const order = orderResult.rows[0];
            const failMessage = pi.last_payment_error ? pi.last_payment_error.message : (payMethod === 'bank_transfer' ? 'Bank transfer payment failed' : 'ACH payment failed');
            await logOrderActivity(pool, order.id, 'payment_failed', null, 'System',
              { method: payMethod, error: failMessage });
            // Notify assigned rep
            if (order.sales_rep_id) {
              setImmediate(() => createRepNotification(pool, order.sales_rep_id, 'payment_failed',
                payMethod.replace('_', ' ') + ' payment failed for ' + order.order_number,
                failMessage + '. The order remains pending — retry or switch payment method.',
                'order', order.id));
            }
          }
        }
        break;
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/trade/orders/:id', tradeAuth, async (req, res) => {
  try {
    const order = await pool.query('SELECT * FROM orders WHERE id = $1 AND trade_customer_id = $2', [req.params.id, req.tradeCustomer.id]);
    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });
    const items = await pool.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [req.params.id]);
    res.json({ order: order.rows[0], items: items.rows });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/trade/projects/:id', tradeAuth, async (req, res) => {
  try {
    const project = await pool.query('SELECT * FROM trade_projects WHERE id = $1 AND trade_customer_id = $2', [req.params.id, req.tradeCustomer.id]);
    if (!project.rows.length) return res.status(404).json({ error: 'Project not found' });
    const orders = await pool.query('SELECT id, order_number, total, status, created_at FROM orders WHERE project_id = $1 ORDER BY created_at DESC', [req.params.id]);
    res.json({ project: project.rows[0], orders: orders.rows });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/trade/favorites/:id/items', tradeAuth, async (req, res) => {
  try {
    const items = await pool.query(`
      SELECT tfi.*, COALESCE(p.display_name, p.name) as product_name, p.collection,
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/trade/change-password', tradeAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Both current and new password are required' });
    const pwError = validatePassword(new_password);
    if (pwError) return res.status(400).json({ error: pwError });

    const cust = await pool.query('SELECT password_hash, password_salt FROM trade_customers WHERE id = $1', [req.tradeCustomer.id]);
    if (!verifyPassword(current_password, cust.rows[0].password_hash, cust.rows[0].password_salt)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const { hash, salt } = hashPassword(new_password);
    await pool.query('UPDATE trade_customers SET password_hash = $1, password_salt = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3', [hash, salt, req.tradeCustomer.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
        SELECT s.id, s.vendor_sku, s.internal_sku, p.id as product_id, COALESCE(p.display_name, p.name) as product_name, p.collection,
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Confirm bulk order — creates an actual order from validated items
app.post('/api/trade/bulk-order/confirm', tradeAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { items, po_number, project_id } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'Items are required' });

    const total = items.reduce((sum, i) => sum + (parseFloat(i.subtotal) || 0), 0);
    const orderNumber = await getNextOrderNumber();

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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/trade/quotes/:id', tradeAuth, async (req, res) => {
  try {
    const quote = await pool.query('SELECT * FROM quotes WHERE id = $1 AND trade_customer_id = $2', [req.params.id, req.tradeCustomer.id]);
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

    const orderNumber = await getNextOrderNumber();
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Trade showroom visits
app.get('/api/trade/visits', tradeAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sv.*, (SELECT COUNT(*)::int FROM showroom_visit_items WHERE visit_id = sv.id) as item_count
      FROM showroom_visits sv WHERE sv.customer_email = $1 AND sv.status = 'sent'
      ORDER BY sv.created_at DESC
    `, [req.tradeCustomer.email]);
    res.json({ visits: result.rows });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/trade/visits/:id', tradeAuth, async (req, res) => {
  try {
    const visit = await pool.query('SELECT * FROM showroom_visits WHERE id = $1 AND customer_email = $2 AND status = \'sent\'', [req.params.id, req.tradeCustomer.email]);
    if (!visit.rows.length) return res.status(404).json({ error: 'Visit not found' });
    const items = await pool.query('SELECT * FROM showroom_visit_items WHERE visit_id = $1 ORDER BY sort_order, id', [req.params.id]);
    res.json({ visit: visit.rows[0], items: items.rows });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    const items = await pool.query(`
      SELECT qi.*, sk.variant_name, sa_c.value as color,
        v.name as vendor_name, sk.vendor_sku, p.collection as current_collection
      FROM quote_items qi
      LEFT JOIN skus sk ON sk.id = qi.sku_id
      LEFT JOIN products p ON p.id = COALESCE(sk.product_id, qi.product_id)
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = qi.sku_id
        AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
      WHERE qi.quote_id = $1 ORDER BY qi.id
    `, [req.params.id]);
    const customer = await pool.query('SELECT * FROM trade_customers WHERE id = $1', [req.tradeCustomer.id]);
    const c = customer.rows[0] || {};

    const isExpired = q.expires_at && new Date(q.expires_at) < new Date();
    const expiryStr = q.expires_at ? new Date(q.expires_at).toLocaleDateString() : 'N/A';

    const html = `<!DOCTYPE html><html><head><style>${getDocumentBaseCSS()}</style></head><body>
      <div class="page">
        ${getDocumentHeader('Quote')}
        <div class="doc-banner">
          <div class="doc-banner-left">
            <div class="meta-group"><p class="meta-label">Quote</p><p class="meta-value">${q.quote_number || 'Q-' + q.id.substring(0, 8).toUpperCase()}</p></div>
            <div class="meta-group"><p class="meta-label">Date</p><p class="meta-value-sm">${new Date(q.created_at).toLocaleDateString()}</p></div>
            <div class="meta-group"><p class="meta-label">Valid Until</p><p class="meta-value-sm">${expiryStr}</p></div>
          </div>
          <div>${isExpired ? '<span class="badge badge-expired">Expired</span>' : '<span class="badge badge-valid">Valid</span>'}</div>
        </div>
        <div class="info-row">
          <div class="info-card">
            <h3>Prepared For</h3>
            <p><strong>${c.company_name || q.customer_name || ''}</strong><br/>
            ${c.contact_name || q.customer_name || ''}<br/>
            ${q.customer_email || c.email || ''}
            ${q.phone ? '<br/>' + q.phone : ''}
            ${q.shipping_address_line1 ? '<br/>' + q.shipping_address_line1 : ''}
            ${q.shipping_address_line2 ? '<br/>' + q.shipping_address_line2 : ''}
            ${q.shipping_city ? '<br/>' + q.shipping_city + ', ' + (q.shipping_state || '') + ' ' + (q.shipping_zip || '') : ''}</p>
          </div>
        </div>
        <table>
          <thead><tr><th>Description</th><th class="text-right">Qty</th><th class="text-right">Unit Price</th><th class="text-right">Subtotal</th></tr></thead>
          <tbody>
            ${items.rows.map(i => {
              const isUnit = i.sell_by === 'unit';
              const qty = i.num_boxes || i.quantity || 1;
              return `<tr>
              <td>${itemDescriptionCell(i.collection, i.color, i.variant_name)}</td>
              <td class="text-right">${qty}${isUnit ? '' : ' box' + (qty > 1 ? 'es' : '')}</td>
              <td class="text-right">$${parseFloat(i.unit_price || 0).toFixed(2)}${isUnit ? '/ea' : '/sqft'}</td>
              <td class="text-right">$${parseFloat(i.subtotal || 0).toFixed(2)}</td>
            </tr>`; }).join('')}
          </tbody>
        </table>
        <div class="totals-wrapper"><div class="totals-box">
          <div class="totals-line"><span>Subtotal</span><span>$${parseFloat(q.subtotal || 0).toFixed(2)}</span></div>
          ${parseFloat(q.shipping || 0) > 0 ? `<div class="totals-line"><span>Shipping</span><span>$${parseFloat(q.shipping).toFixed(2)}</span></div>` : ''}
          ${parseFloat(q.tax || 0) > 0 ? `<div class="totals-line"><span>Tax</span><span>$${parseFloat(q.tax).toFixed(2)}</span></div>` : ''}
          <div class="totals-line grand-total"><span>Total</span><span>$${parseFloat(q.total || 0).toFixed(2)}</span></div>
        </div></div>
        ${getDocumentFooter('<p>This quote is valid for 14 days from the date of issue. Prices are subject to change after expiry.</p>')}
      </div>
    </body></html>`;

    await generatePDF(html, `quote-${q.quote_number || q.id.substring(0, 8)}.pdf`, req, res);
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Packing Slip & Invoice Helpers ====================

async function generateOrderPackingSlipHtml(orderId) {
  const order = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!order.rows.length) return null;
  const items = await pool.query(`
    SELECT oi.*, p.sqft_per_box, sk.variant_name, sa_c.value as color
    FROM order_items oi
    LEFT JOIN packaging p ON p.sku_id = oi.sku_id
    LEFT JOIN skus sk ON sk.id = oi.sku_id
    LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = oi.sku_id
      AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
    WHERE oi.order_id = $1 ORDER BY oi.id
  `, [orderId]);
  const o = order.rows[0];
  const isPickup = o.delivery_method === 'pickup';

  const shipTo = isPickup
    ? `<p><strong>Roma Flooring Designs</strong><br/>1440 S. State College Blvd., Suite 6M<br/>Anaheim, CA 92806</p>`
    : `<p><strong>${o.customer_name}</strong><br/>${o.shipping_address_line1 || ''}${o.shipping_address_line2 ? '<br/>' + o.shipping_address_line2 : ''}<br/>${o.shipping_city || ''}, ${o.shipping_state || ''} ${o.shipping_zip || ''}</p>`;

  return { html: `<!DOCTYPE html><html><head><style>${getDocumentBaseCSS()}</style></head><body>
    <div class="page">
      ${getDocumentHeader('Packing Slip')}
      <div class="doc-banner">
        <div class="doc-banner-left">
          <div class="meta-group"><p class="meta-label">Order</p><p class="meta-value">${o.order_number}</p></div>
          <div class="meta-group"><p class="meta-label">Date</p><p class="meta-value-sm">${new Date(o.created_at).toLocaleDateString()}</p></div>
        </div>
      </div>
      <div class="info-row">
        <div class="info-card"><h3>${isPickup ? 'Store Pickup' : 'Ship To'}</h3>${shipTo}</div>
      </div>
      <table>
        <thead><tr><th>Description</th><th class="text-right">Qty</th><th class="text-right">SqFt/Box</th><th class="text-right">Total SqFt</th></tr></thead>
        <tbody>
          ${items.rows.map(i => {
            const isUnit = i.sell_by === 'unit';
            const sqftPerBox = i.sqft_per_box ? parseFloat(i.sqft_per_box) : null;
            const totalSqft = i.sqft_needed ? parseFloat(i.sqft_needed) : (sqftPerBox ? sqftPerBox * i.num_boxes : null);
            return `<tr>
              <td>${itemDescriptionCell(i.collection, i.color, i.variant_name)}${i.is_sample ? ' <span class="text-muted text-small">(Sample)</span>' : ''}</td>
              <td class="text-right">${i.num_boxes}${isUnit ? '' : ' box' + (i.num_boxes > 1 ? 'es' : '')}</td>
              <td class="text-right">${isUnit ? '\u2014' : (sqftPerBox ? sqftPerBox.toFixed(2) : '\u2014')}</td>
              <td class="text-right">${isUnit ? '\u2014' : (totalSqft ? totalSqft.toFixed(1) : '\u2014')}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      ${getDocumentFooter()}
    </div>
  </body></html>`, filename: `packing-slip-${o.order_number}.pdf` };
}

async function generateOrderInvoiceHtml(orderId) {
  const order = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!order.rows.length) return null;
  const items = await pool.query(`
    SELECT oi.*, p.sqft_per_box, sk.variant_name, sa_c.value as color
    FROM order_items oi
    LEFT JOIN packaging p ON p.sku_id = oi.sku_id
    LEFT JOIN skus sk ON sk.id = oi.sku_id
    LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = oi.sku_id
      AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
    WHERE oi.order_id = $1 ORDER BY oi.id
  `, [orderId]);
  const o = order.rows[0];
  const isPickup = o.delivery_method === 'pickup';
  const total = parseFloat(o.total || 0);
  const amountPaid = parseFloat(o.amount_paid || 0);
  const balanceDue = parseFloat((total - amountPaid).toFixed(2));
  const taxAmount = parseFloat(o.tax_amount || 0);

  const shipTo = isPickup
    ? `<p><strong>Roma Flooring Designs</strong><br/>1440 S. State College Blvd., Suite 6M<br/>Anaheim, CA 92806</p>`
    : `<p><strong>${o.customer_name}</strong><br/>${o.shipping_address_line1 || ''}${o.shipping_address_line2 ? '<br/>' + o.shipping_address_line2 : ''}<br/>${o.shipping_city || ''}, ${o.shipping_state || ''} ${o.shipping_zip || ''}</p>`;

  return { html: `<!DOCTYPE html><html><head><style>${getDocumentBaseCSS()}</style></head><body>
    <div class="page">
      ${getDocumentHeader('Invoice')}
      <div class="doc-banner">
        <div class="doc-banner-left">
          <div class="meta-group"><p class="meta-label">Invoice</p><p class="meta-value">${o.order_number}</p></div>
          <div class="meta-group"><p class="meta-label">Date</p><p class="meta-value-sm">${new Date(o.created_at).toLocaleDateString()}</p></div>
          ${o.po_number ? `<div class="meta-group"><p class="meta-label">PO Ref</p><p class="meta-value-sm">${o.po_number}</p></div>` : ''}
        </div>
        <div>
          ${balanceDue > 0.01 ? '<span class="badge badge-pending">Balance Due</span>' : '<span class="badge badge-paid">Paid</span>'}
        </div>
      </div>
      <div class="info-row">
        <div class="info-card"><h3>Bill To</h3><p><strong>${o.customer_name}</strong><br/>${o.customer_email}${o.phone ? '<br/>' + o.phone : ''}</p></div>
        <div class="info-card"><h3>${isPickup ? 'Store Pickup' : 'Ship To'}</h3>${shipTo}</div>
      </div>
      <table>
        <thead><tr><th>Description</th><th class="text-right">SqFt</th><th class="text-right">Qty</th><th class="text-right">Unit Price</th><th class="text-right">Subtotal</th></tr></thead>
        <tbody>
          ${items.rows.map(i => {
            const isUnit = i.sell_by === 'unit';
            return `<tr>
              <td>${itemDescriptionCell(i.collection, i.color, i.variant_name)}${i.is_sample ? ' <span class="text-muted text-small">(Sample)</span>' : ''}</td>
              <td class="text-right">${isUnit ? '\u2014' : (i.sqft_needed ? parseFloat(i.sqft_needed).toFixed(1) : '\u2014')}</td>
              <td class="text-right">${i.num_boxes}${isUnit ? '' : ' box' + (i.num_boxes > 1 ? 'es' : '')}</td>
              <td class="text-right">${i.is_sample ? '<span class="text-muted">$0.00</span>' : (i.unit_price ? '$' + parseFloat(i.unit_price).toFixed(2) + (isUnit ? '/ea' : '/sf') : '\u2014')}</td>
              <td class="text-right">${i.is_sample ? '<span class="text-muted">$0.00</span>' : '$' + parseFloat(i.subtotal || 0).toFixed(2)}</td>
            </tr>`;}).join('')}
        </tbody>
      </table>
      <div class="totals-wrapper"><div class="totals-box">
        <div class="totals-line"><span>Subtotal</span><span>$${parseFloat(o.subtotal || 0).toFixed(2)}</span></div>
        ${parseFloat(o.shipping || 0) > 0 ? `<div class="totals-line"><span>Shipping${o.shipping_method ? ' (' + (o.shipping_method === 'ltl_freight' ? 'LTL Freight' : 'Parcel') + ')' : ''}</span><span>$${parseFloat(o.shipping).toFixed(2)}</span></div>` : ''}
        ${isPickup ? '<div class="totals-line"><span>Shipping (Store Pickup)</span><span class="discount">FREE</span></div>' : ''}
        ${parseFloat(o.sample_shipping || 0) > 0 ? `<div class="totals-line"><span>Sample Shipping</span><span>$${parseFloat(o.sample_shipping).toFixed(2)}</span></div>` : ''}
        ${parseFloat(o.discount_amount || 0) > 0 ? `<div class="totals-line"><span>Discount${o.promo_code ? ' (' + o.promo_code + ')' : ''}</span><span class="discount">-$${parseFloat(o.discount_amount).toFixed(2)}</span></div>` : ''}
        ${taxAmount > 0 ? `<div class="totals-line"><span>Tax</span><span>$${taxAmount.toFixed(2)}</span></div>` : ''}
        <div class="totals-line grand-total"><span>Total</span><span>$${total.toFixed(2)}</span></div>
        <div class="totals-line"><span>Amount Paid</span><span>$${amountPaid.toFixed(2)}</span></div>
        ${balanceDue > 0.01 ? `<div class="totals-line balance-due"><span>Balance Due</span><span>$${balanceDue.toFixed(2)}</span></div>` : `<div class="totals-line paid-full"><span>Balance Due</span><span>$0.00</span></div>`}
      </div></div>
      ${o.payment_method || o.stripe_payment_intent_id ? `
        <div class="notes-block">
          <h4>Payment Information</h4>
          ${o.payment_method ? '<div>Method: ' + (o.payment_method === 'stripe' ? 'Payment Request' : o.payment_method.charAt(0).toUpperCase() + o.payment_method.slice(1)) + '</div>' : ''}
          ${o.stripe_payment_intent_id ? '<div class="text-muted text-small">Ref: ' + o.stripe_payment_intent_id + '</div>' : ''}
        </div>
      ` : ''}
      ${getDocumentFooter('<p>Thank you for your business.</p>')}
    </div>
  </body></html>`, filename: `invoice-${o.order_number}.pdf` };
}

async function generateSampleRequestConfirmationHtml(sampleRequestId) {
  const sr = await pool.query('SELECT * FROM sample_requests WHERE id = $1', [sampleRequestId]);
  if (!sr.rows.length) return null;
  const items = await pool.query(`
    SELECT sri.*, sa_c.value as color
    FROM sample_request_items sri
    LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = sri.sku_id
      AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
    WHERE sri.sample_request_id = $1 ORDER BY sri.sort_order
  `, [sampleRequestId]);
  const s = sr.rows[0];
  const isPickup = s.delivery_method === 'pickup';

  const deliveryTo = isPickup
    ? `<p><strong>Roma Flooring Designs</strong><br/>1440 S. State College Blvd., Suite 6M<br/>Anaheim, CA 92806</p>`
    : `<p><strong>${s.customer_name}</strong><br/>${s.shipping_address_line1 || ''}${s.shipping_address_line2 ? '<br/>' + s.shipping_address_line2 : ''}<br/>${s.shipping_city || ''}, ${s.shipping_state || ''} ${s.shipping_zip || ''}</p>`;

  return { html: `<!DOCTYPE html><html><head><style>${getDocumentBaseCSS()}</style></head><body>
    <div class="page">
      ${getDocumentHeader('Sample Request')}
      <div class="doc-banner">
        <div class="doc-banner-left">
          <div class="meta-group"><p class="meta-label">Request</p><p class="meta-value">${s.request_number}</p></div>
          <div class="meta-group"><p class="meta-label">Date</p><p class="meta-value-sm">${new Date(s.created_at).toLocaleDateString()}</p></div>
        </div>
        <div><span class="badge badge-confirmed">${isPickup ? 'Pickup' : 'Shipping'}</span></div>
      </div>
      <div class="info-row">
        <div class="info-card"><h3>Customer</h3><p><strong>${s.customer_name}</strong><br/>${s.customer_email || ''}${s.customer_phone ? '<br/>' + s.customer_phone : ''}</p></div>
        <div class="info-card"><h3>${isPickup ? 'Store Pickup' : 'Ship To'}</h3>${deliveryTo}</div>
      </div>
      <table>
        <thead><tr><th>Description</th></tr></thead>
        <tbody>
          ${items.rows.map(i => `<tr><td>${itemDescriptionCell(i.collection, i.color, i.variant_name)}</td></tr>`).join('')}
        </tbody>
      </table>
      <div class="notes-block"><h4>Note</h4><div>Samples are complimentary.${!isPickup ? ' Shipping fee: $12.00' : ''}</div></div>
      ${s.notes ? `<div class="notes-block" style="margin-top:0.75rem;"><h4>Additional Notes</h4><div>${s.notes}</div></div>` : ''}
      ${getDocumentFooter()}
    </div>
  </body></html>`, filename: `sample-request-${s.request_number}.pdf` };
}

// ==================== Packing Slip & Invoice Endpoints (Phase 7) ====================

// Packing slip - accepts token from header or query param (for browser popup)
app.get('/api/staff/orders/:id/packing-slip', async (req, res, next) => {
  if (!req.headers['x-staff-token'] && req.query.token) {
    req.headers['x-staff-token'] = req.query.token;
  }
  next();
}, staffAuth, async (req, res) => {
  try {
    const result = await generateOrderPackingSlipHtml(req.params.id);
    if (!result) return res.status(404).json({ error: 'Order not found' });
    await generatePDF(result.html, result.filename, req, res);
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    const result = await generateOrderInvoiceHtml(req.params.id);
    if (!result) return res.status(404).json({ error: 'Order not found' });
    await generatePDF(result.html, result.filename, req, res);
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Send invoice email from admin (with optional payment request if balance due)
app.post('/api/staff/orders/:id/send-invoice', staffAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body || {};

    const order = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });
    const o = order.rows[0];

    const items = await pool.query(`
      SELECT oi.*, p.sqft_per_box
      FROM order_items oi LEFT JOIN packaging p ON p.sku_id = oi.sku_id
      WHERE oi.order_id = $1 ORDER BY oi.id
    `, [id]);

    const invoiceResult = await generateOrderInvoiceHtml(id);
    if (!invoiceResult) return res.status(500).json({ error: 'Failed to generate invoice' });
    let pdfBuffer = null;
    try {
      pdfBuffer = await generatePDFBuffer(invoiceResult.html);
    } catch (pdfErr) {
      console.error('[PDF] Buffer generation failed, sending without attachment:', pdfErr.message);
    }

    const balanceInfo = await recalculateBalance(pool, id);
    const balanceDue = balanceInfo && balanceInfo.balance > 0.01 ? balanceInfo.balance : 0;
    let checkoutUrl = null;
    const staffName = req.staff.first_name + ' ' + req.staff.last_name;

    if (balanceDue > 0) {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: o.customer_email,
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: { name: `Balance Due — Order ${o.order_number}` },
            unit_amount: Math.round(balanceDue * 100)
          },
          quantity: 1
        }],
        metadata: { order_id: id, type: 'payment_request' },
        success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/account?order=${id}&payment=success`,
        cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/account?order=${id}&payment=cancelled`,
        expires_at: Math.floor(Date.now() / 1000) + 72 * 3600
      });

      checkoutUrl = session.url;

      const prResult = await pool.query(`
        INSERT INTO payment_requests (order_id, amount, stripe_checkout_session_id, stripe_checkout_url, sent_to_email, sent_by, sent_by_name, message, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
      `, [id, balanceDue.toFixed(2), session.id, session.url, o.customer_email, req.staff.id, staffName, message || null, new Date(Date.now() + 72 * 3600 * 1000)]);

      await stripe.checkout.sessions.update(session.id, {
        metadata: { order_id: id, payment_request_id: prResult.rows[0].id, type: 'payment_request' }
      });

      await logOrderActivity(pool, id, 'payment_request_sent', req.staff.id, staffName,
        { amount: balanceDue.toFixed(2), sent_to: o.customer_email, via: 'invoice_email' });
    }

    await sendOrderInvoiceEmail({
      order: o,
      items: items.rows,
      balance: balanceDue,
      checkout_url: checkoutUrl,
      message: message || null,
      pdf_buffer: pdfBuffer
    });

    await logOrderActivity(pool, id, 'invoice_sent', req.staff.id, staffName,
      { sent_to: o.customer_email, balance_due: balanceDue.toFixed(2), payment_requested: balanceDue > 0 });

    res.json({
      success: true,
      sent_to: o.customer_email,
      balance_due: balanceDue,
      payment_requested: balanceDue > 0
    });
  } catch (err) {
    console.error('[Staff] Send invoice error:', err);
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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

    // Invalidate all existing sessions for this rep (session rotation)
    await pool.query('DELETE FROM rep_sessions WHERE rep_id = $1', [rep.id]);

    await pool.query(
      'INSERT INTO rep_sessions (rep_id, token, expires_at) VALUES ($1, $2, $3)',
      [rep.id, token, expiresAt]
    );

    res.json({
      token,
      rep: { id: rep.id, email: rep.email, first_name: rep.first_name, last_name: rep.last_name }
    });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/rep/logout', repAuth, async (req, res) => {
  try {
    const token = req.headers['x-rep-token'];
    await pool.query('DELETE FROM rep_sessions WHERE token = $1', [token]);
    res.json({ success: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
        (SELECT COUNT(*)::int FROM quotes WHERE sales_rep_id = $1 AND status = 'draft') as draft_quotes,
        (SELECT COUNT(*)::int FROM estimates WHERE sales_rep_id = $1 AND status = 'draft') as estimates_draft,
        (SELECT COUNT(*)::int FROM estimates WHERE sales_rep_id = $1 AND status = 'sent') as estimates_sent
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Rep Action Items ====================

app.get('/api/rep/action-items', repAuth, async (req, res) => {
  try {
    const scope = req.query.scope || 'mine'; // 'mine' or 'all'
    const actionItems = [];

    // --- ORDER ACTION ITEMS ---
    const orderFilter = scope === 'mine' ? 'AND o.sales_rep_id = $1' : '';
    const orderParams = scope === 'mine' ? [req.rep.id] : [];

    const ordersRes = await pool.query(`
      SELECT o.id, o.order_number, o.customer_name, o.status, o.delivery_method,
        o.total, o.amount_paid, o.created_at, o.confirmed_at, o.shipped_at,
        sr.first_name || ' ' || sr.last_name as rep_name
      FROM orders o
      LEFT JOIN sales_reps sr ON sr.id = o.sales_rep_id
      WHERE o.status NOT IN ('delivered', 'cancelled', 'refunded') ${orderFilter}
      ORDER BY o.created_at DESC
    `, orderParams);

    // Batch-fetch PO data for all open orders
    const orderIds = ordersRes.rows.map(o => o.id);
    let posByOrder = {};
    if (orderIds.length > 0) {
      const posRes = await pool.query(`
        SELECT po.order_id, po.id as po_id, po.status as po_status,
          (SELECT COUNT(*)::int FROM purchase_order_items poi WHERE poi.purchase_order_id = po.id AND poi.status != 'cancelled') as active_items,
          (SELECT COUNT(*)::int FROM purchase_order_items poi WHERE poi.purchase_order_id = po.id AND poi.status = 'received') as received_items
        FROM purchase_orders po
        WHERE po.order_id = ANY($1)
      `, [orderIds]);
      posRes.rows.forEach(po => {
        if (!posByOrder[po.order_id]) posByOrder[po.order_id] = [];
        posByOrder[po.order_id].push(po);
      });
    }

    ordersRes.rows.forEach(o => {
      const totalAmount = parseFloat(o.total || 0);
      const amountPaid = parseFloat(o.amount_paid || 0);
      const pos = posByOrder[o.id] || [];
      const isPickup = o.delivery_method === 'pickup';
      const pendingSteps = [];

      if (o.status === 'pending') pendingSteps.push('Confirm order');
      if (totalAmount > 0 && amountPaid < totalAmount) pendingSteps.push('Collect payment ($' + (totalAmount - amountPaid).toFixed(2) + ' remaining)');
      const draftPOs = pos.filter(p => p.po_status === 'draft').length;
      if (draftPOs > 0) pendingSteps.push('Send ' + draftPOs + ' draft PO' + (draftPOs !== 1 ? 's' : ''));
      const totalActive = pos.reduce((s, p) => s + p.active_items, 0);
      const totalReceived = pos.reduce((s, p) => s + p.received_items, 0);
      if (totalActive > 0 && totalReceived < totalActive) pendingSteps.push('Receive items (' + totalReceived + '/' + totalActive + ')');
      if (o.status === 'confirmed') pendingSteps.push(isPickup ? 'Mark ready for pickup' : 'Ship order');

      if (pendingSteps.length > 0) {
        // Count completed steps out of 5
        const completedSteps = 5 - pendingSteps.length;
        actionItems.push({
          type: 'order',
          id: o.id,
          reference: o.order_number,
          customer_name: o.customer_name,
          status: o.status,
          rep_name: o.rep_name,
          created_at: o.created_at,
          pending_steps: pendingSteps,
          completed_steps: completedSteps,
          total_steps: 5
        });
      }
    });

    // --- SAMPLE REQUEST ACTION ITEMS ---
    const sampleFilter = scope === 'mine' ? 'AND sr.rep_id = $1' : '';
    const sampleParams = scope === 'mine' ? [req.rep.id] : [];

    const samplesRes = await pool.query(`
      SELECT sr.*,
        rep.first_name || ' ' || rep.last_name as rep_name
      FROM sample_requests sr
      LEFT JOIN sales_reps rep ON rep.id = sr.rep_id
      WHERE sr.status NOT IN ('delivered', 'cancelled') ${sampleFilter}
      ORDER BY sr.created_at DESC
    `, sampleParams);

    const sampleIds = samplesRes.rows.map(s => s.id);
    let itemsBySample = {};
    if (sampleIds.length > 0) {
      const sriRes = await pool.query(`
        SELECT sri.sample_request_id, sri.status, sri.vendor_notified_at,
          p.vendor_id
        FROM sample_request_items sri
        LEFT JOIN products p ON p.id = sri.product_id
        WHERE sri.sample_request_id = ANY($1)
      `, [sampleIds]);
      sriRes.rows.forEach(item => {
        if (!itemsBySample[item.sample_request_id]) itemsBySample[item.sample_request_id] = [];
        itemsBySample[item.sample_request_id].push(item);
      });
    }

    samplesRes.rows.forEach(sr => {
      const sItems = (itemsBySample[sr.id] || []).filter(i => i.status !== 'cancelled');
      const isShipping = sr.delivery_method !== 'pickup';
      const pendingSteps = [];

      if (isShipping && !sr.shipping_payment_collected) pendingSteps.push('Collect shipping payment');
      const vendorsTotal = new Set(sItems.map(i => i.vendor_id || 'unknown')).size;
      const vendorsNotified = new Set(sItems.filter(i => i.vendor_notified_at).map(i => i.vendor_id || 'unknown')).size;
      if (sItems.length > 0 && vendorsNotified < vendorsTotal) pendingSteps.push('Send to ' + (vendorsTotal - vendorsNotified) + ' vendor' + ((vendorsTotal - vendorsNotified) !== 1 ? 's' : ''));
      const readyCount = sItems.filter(i => i.status === 'ready').length;
      if (sItems.length > 0 && readyCount < sItems.length) pendingSteps.push('Mark samples ready (' + readyCount + '/' + sItems.length + ')');
      if (sr.status !== 'shipped' && sr.status !== 'delivered') pendingSteps.push(isShipping ? 'Ship samples' : 'Ready for pickup');

      const totalSteps = isShipping ? 4 : 3;
      if (pendingSteps.length > 0) {
        actionItems.push({
          type: 'sample',
          id: sr.id,
          reference: sr.request_number,
          customer_name: sr.customer_name,
          status: sr.status,
          rep_name: sr.rep_name,
          created_at: sr.created_at,
          pending_steps: pendingSteps,
          completed_steps: totalSteps - pendingSteps.length,
          total_steps: totalSteps
        });
      }
    });

    // Sort by fewest completed steps first (most work remaining)
    actionItems.sort((a, b) => (a.completed_steps / a.total_steps) - (b.completed_steps / b.total_steps));

    res.json({ action_items: actionItems });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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

    // Auto-create customer if email provided
    let customerId = null;
    if (customer_email) {
      const nameParts = (customer_name || '').split(' ');
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';
      const { customer: cust } = await findOrCreateCustomer(client, {
        email: customer_email, firstName, lastName,
        phone: customer_phone, repId: req.rep.id, createdVia: 'visit'
      });
      customerId = cust.id;
    }

    const visitRes = await client.query(`
      INSERT INTO showroom_visits (token, rep_id, customer_name, customer_email, customer_phone, message, status, expires_at, customer_id)
      VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8) RETURNING *
    `, [token, req.rep.id, customer_name, customer_email || null, customer_phone || null, message || null, expiresAt, customerId]);
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
            COALESCE(p.display_name, p.name) as product_name, p.collection,
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/rep/visits/:id', repAuth, async (req, res) => {
  try {
    const visitRes = await pool.query('SELECT * FROM showroom_visits WHERE id = $1 AND rep_id = $2', [req.params.id, req.rep.id]);
    if (!visitRes.rows.length) return res.status(404).json({ error: 'Visit not found' });

    const itemsRes = await pool.query('SELECT * FROM showroom_visit_items WHERE visit_id = $1 ORDER BY sort_order', [req.params.id]);
    res.json({ visit: visitRes.rows[0], items: itemsRes.rows });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
              COALESCE(p.display_name, p.name) as product_name, p.collection,
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Rep Sample Request Endpoints ====================

app.post('/api/rep/sample-requests', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { customer_name, customer_email, customer_phone, shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip, delivery_method, notes, items } = req.body;
    if (!customer_name) return res.status(400).json({ error: 'Customer name is required' });
    if (!customer_email) return res.status(400).json({ error: 'Customer email is required' });
    if (!customer_phone) return res.status(400).json({ error: 'Customer phone is required' });
    const dm = delivery_method === 'pickup' ? 'pickup' : 'shipping';
    if (dm === 'shipping') {
      if (!shipping_address_line1) return res.status(400).json({ error: 'Shipping address is required' });
      if (!shipping_city) return res.status(400).json({ error: 'City is required' });
      if (!shipping_state) return res.status(400).json({ error: 'State is required' });
      if (!shipping_zip) return res.status(400).json({ error: 'ZIP code is required' });
    }
    if (!items || !items.length) return res.status(400).json({ error: 'At least one item is required' });
    if (items.length > 5) return res.status(400).json({ error: 'Maximum 5 items per sample request' });

    // Check for duplicate product_ids
    const productIds = items.map(i => i.product_id).filter(Boolean);
    if (new Set(productIds).size !== productIds.length) {
      return res.status(400).json({ error: 'Duplicate products are not allowed' });
    }

    await client.query('BEGIN');

    // Auto-create customer
    const nameParts = (customer_name || '').split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';
    const { customer: cust } = await findOrCreateCustomer(client, {
      email: customer_email, firstName, lastName,
      phone: customer_phone, repId: req.rep.id, createdVia: 'sample_request'
    });

    const request_number = await getNextSampleNumber();

    const srRes = await client.query(`
      INSERT INTO sample_requests (request_number, rep_id, customer_name, customer_email, customer_phone,
        shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip, delivery_method, notes, status, customer_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'requested', $13) RETURNING *
    `, [request_number, req.rep.id, customer_name, customer_email || null, customer_phone || null,
        shipping_address_line1 || null, shipping_address_line2 || null, shipping_city || null, shipping_state || null, shipping_zip || null, dm, notes || null, cust.id]);
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
      `, [sample_request.id, productId, skuId, productName, collection, variantName, primaryImage, i]);
      resolvedItems.push(itemRes.rows[0]);
    }

    await client.query('COMMIT');

    // Fire-and-forget: confirmation email + notification
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

    // If shipping, create Stripe checkout for $12 shipping fee and email payment link
    if (dm === 'shipping' && customer_email) {
      try {
        const shippingAmount = 12;
        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          customer_email: customer_email,
          line_items: [{
            price_data: {
              currency: 'usd',
              product_data: { name: `Sample Shipping — ${request_number}` },
              unit_amount: Math.round(shippingAmount * 100)
            },
            quantity: 1
          }],
          metadata: { sample_request_id: sample_request.id, type: 'sample_shipping' },
          success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/account?sample=${sample_request.id}&payment=success`,
          cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/account?sample=${sample_request.id}&payment=cancelled`,
          expires_at: Math.floor(Date.now() / 1000) + 72 * 3600
        });
        // Persist Stripe session ID on sample request
        await pool.query('UPDATE sample_requests SET stripe_checkout_session_id = $1 WHERE id = $2', [session.id, sample_request.id]);

        setImmediate(() => sendSampleShippingPayment({
          customer_name, customer_email, request_number,
          checkout_url: session.url,
          amount: shippingAmount
        }));
      } catch (stripeErr) {
        console.error('[Sample Request] Stripe session creation failed:', stripeErr.message);
      }
    }

    res.json({ sample_request, items: resolvedItems });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/rep/sample-requests/:id', repAuth, async (req, res) => {
  try {
    const srRes = await pool.query('SELECT * FROM sample_requests WHERE id = $1 AND rep_id = $2', [req.params.id, req.rep.id]);
    if (!srRes.rows.length) return res.status(404).json({ error: 'Sample request not found' });

    const itemsRes = await pool.query(`
      SELECT sri.*, p.vendor_id, v.name as vendor_name, v.email as vendor_email, s.vendor_sku
      FROM sample_request_items sri
      LEFT JOIN products p ON p.id = sri.product_id
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN skus s ON s.id = sri.sku_id
      WHERE sri.sample_request_id = $1
      ORDER BY v.name, sri.sort_order
    `, [req.params.id]);
    res.json({ sample_request: srRes.rows[0], items: itemsRes.rows });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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

    // Auto-task: check in on samples after shipping
    setImmediate(() => createAutoTask(pool, req.rep.id, 'sample_shipped', sr.id,
      `Check in on samples — ${sr.customer_name}`, {
        customer_name: sr.customer_name, customer_email: sr.customer_email, customer_phone: sr.customer_phone
      }).catch(err => console.error('[AutoTask] sample_shipped error:', err.message)));

    res.json({ sample_request: sr });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/rep/sample-requests/:id/items/:itemId/status', repAuth, async (req, res) => {
  try {
    const srRes = await pool.query('SELECT * FROM sample_requests WHERE id = $1 AND rep_id = $2', [req.params.id, req.rep.id]);
    if (!srRes.rows.length) return res.status(404).json({ error: 'Sample request not found' });
    if (srRes.rows[0].status !== 'requested') return res.status(400).json({ error: 'Can only update item status while request is in requested status' });

    const { status, notes } = req.body;
    const fields = [];
    const vals = [];
    let idx = 1;
    if (status !== undefined) {
      if (!['pending', 'ready', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Status must be pending, ready, or cancelled' });
      fields.push(`status = $${idx}`); vals.push(status); idx++;
    }
    if (notes !== undefined) {
      fields.push(`notes = $${idx}`); vals.push(notes || null); idx++;
    }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    vals.push(req.params.itemId, req.params.id);
    const result = await pool.query(
      `UPDATE sample_request_items SET ${fields.join(', ')} WHERE id = $${idx} AND sample_request_id = $${idx + 1} RETURNING *`,
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Item not found' });

    res.json({ item: result.rows[0] });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Add items to an open sample request
app.post('/api/rep/sample-requests/:id/add-items', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { items } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'At least one item is required' });

    const srRes = await client.query('SELECT * FROM sample_requests WHERE id = $1 AND rep_id = $2', [req.params.id, req.rep.id]);
    if (!srRes.rows.length) return res.status(404).json({ error: 'Sample request not found' });
    const sr = srRes.rows[0];
    if (sr.status !== 'requested') return res.status(400).json({ error: 'Can only add items to open sample requests' });

    const countRes = await client.query(
      "SELECT COUNT(*)::int as cnt FROM sample_request_items WHERE sample_request_id = $1 AND status != 'cancelled'",
      [sr.id]
    );
    const currentCount = countRes.rows[0].cnt;
    if (currentCount + items.length > 5) {
      return res.status(400).json({ error: `Maximum 5 active items per sample request (currently ${currentCount})` });
    }

    await client.query('BEGIN');

    const maxSortRes = await client.query(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 as next_sort FROM sample_request_items WHERE sample_request_id = $1',
      [sr.id]
    );
    let nextSort = maxSortRes.rows[0].next_sort;

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
      `, [sr.id, productId, skuId, productName, collection, variantName, primaryImage, nextSort + i]);
      addedItems.push(itemRes.rows[0]);
    }

    await client.query('COMMIT');
    res.json({ added: addedItems });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.post('/api/rep/sample-requests/:id/send-to-vendor', repAuth, async (req, res) => {
  try {
    const { vendor_id, ship_to } = req.body;
    if (!vendor_id) return res.status(400).json({ error: 'vendor_id is required' });
    if (!['store', 'customer'].includes(ship_to)) return res.status(400).json({ error: 'ship_to must be store or customer' });

    const srRes = await pool.query('SELECT * FROM sample_requests WHERE id = $1 AND rep_id = $2', [req.params.id, req.rep.id]);
    if (!srRes.rows.length) return res.status(404).json({ error: 'Sample request not found' });
    const sr = srRes.rows[0];

    // If delivery is pickup, only store shipping is allowed
    if (sr.delivery_method === 'pickup' && ship_to === 'customer') {
      return res.status(400).json({ error: 'Pickup orders can only ship to store' });
    }

    const vendorRes = await pool.query('SELECT id, name, email FROM vendors WHERE id = $1', [vendor_id]);
    if (!vendorRes.rows.length) return res.status(404).json({ error: 'Vendor not found' });
    const vendor = vendorRes.rows[0];
    if (!vendor.email) return res.status(400).json({ error: 'Vendor has no email configured' });

    // Get rep name
    const repRes = await pool.query('SELECT first_name, last_name FROM sales_reps WHERE id = $1', [req.rep.id]);
    const repName = repRes.rows.length ? `${repRes.rows[0].first_name} ${repRes.rows[0].last_name}` : '';

    // Get items for this vendor only
    const itemsRes = await pool.query(`
      SELECT sri.*, s.vendor_sku
      FROM sample_request_items sri
      LEFT JOIN products p ON p.id = sri.product_id
      LEFT JOIN skus s ON s.id = sri.sku_id
      WHERE sri.sample_request_id = $1 AND p.vendor_id = $2
      ORDER BY sri.sort_order
    `, [req.params.id, vendor_id]);

    if (!itemsRes.rows.length) return res.status(400).json({ error: 'No items found for this vendor' });

    // Build ship-to address
    let shipToAddress;
    if (ship_to === 'store') {
      shipToAddress = {
        name: 'Roma Flooring Designs',
        line1: '1440 S. State College Blvd #6M',
        city: 'Anaheim', state: 'CA', zip: '92806'
      };
    } else {
      shipToAddress = {
        name: sr.customer_name,
        line1: sr.shipping_address_line1 || '',
        line2: sr.shipping_address_line2 || '',
        city: sr.shipping_city || '', state: sr.shipping_state || '', zip: sr.shipping_zip || ''
      };
    }

    const html = generateSampleRequestVendorHTML({
      vendor_name: vendor.name,
      request_number: sr.request_number,
      customer_name: sr.customer_name,
      rep_name: repName,
      notes: sr.notes,
      ship_to: shipToAddress,
      items: itemsRes.rows.map(i => ({
        product_name: i.product_name,
        collection: i.collection,
        variant_name: i.variant_name,
        sku_code: i.vendor_sku || null,
        notes: i.notes
      }))
    });

    const pdfBuffer = await generatePDFBuffer(html);

    const emailResult = await sendSampleRequestToVendor({
      vendor_email: vendor.email,
      vendor_name: vendor.name,
      request_number: sr.request_number,
      pdf_buffer: pdfBuffer
    });

    // Persist vendor notification timestamps on successfully sent items
    if (emailResult.sent) {
      const itemIds = itemsRes.rows.map(i => i.id);
      await pool.query(
        'UPDATE sample_request_items SET vendor_notified_at = NOW(), vendor_notified_email = $1 WHERE id = ANY($2::uuid[])',
        [vendor.email, itemIds]
      );
    }

    res.json({ vendor_name: vendor.name, vendor_email: vendor.email, sent: emailResult.sent, error: emailResult.error || null });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/rep/sample-requests/:id/payment-status', repAuth, async (req, res) => {
  try {
    const srRes = await pool.query('SELECT * FROM sample_requests WHERE id = $1 AND rep_id = $2', [req.params.id, req.rep.id]);
    if (!srRes.rows.length) return res.status(404).json({ error: 'Sample request not found' });

    const { collected } = req.body;
    if (typeof collected !== 'boolean') return res.status(400).json({ error: 'collected must be true or false' });

    await pool.query(
      'UPDATE sample_requests SET shipping_payment_collected = $1, shipping_payment_collected_at = $2 WHERE id = $3',
      [collected, collected ? new Date() : null, req.params.id]
    );

    const updated = await pool.query('SELECT * FROM sample_requests WHERE id = $1', [req.params.id]);
    res.json({ sample_request: updated.rows[0] });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Cash Drawer Endpoints ====================

app.post('/api/rep/cash-drawer/open', repAuth, async (req, res) => {
  try {
    const { opening_balance } = req.body;
    const bal = parseFloat(opening_balance || 0);
    if (isNaN(bal) || bal < 0) return res.status(400).json({ error: 'Invalid opening balance' });

    // Check for existing open drawer
    const existing = await pool.query(
      "SELECT id FROM cash_drawers WHERE rep_id = $1 AND status = 'open'",
      [req.rep.id]
    );
    if (existing.rows.length) {
      return res.status(400).json({ error: 'You already have an open cash drawer. Close it before opening a new one.' });
    }

    const repName = req.rep.first_name + ' ' + req.rep.last_name;
    const result = await pool.query(
      `INSERT INTO cash_drawers (rep_id, rep_name, opening_balance, expected_balance, status)
       VALUES ($1, $2, $3, $3, 'open') RETURNING *`,
      [req.rep.id, repName, bal.toFixed(2)]
    );
    res.json({ drawer: result.rows[0] });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/rep/cash-drawer/current', repAuth, async (req, res) => {
  try {
    const drawerResult = await pool.query(
      "SELECT * FROM cash_drawers WHERE rep_id = $1 AND status = 'open' ORDER BY opened_at DESC LIMIT 1",
      [req.rep.id]
    );
    if (!drawerResult.rows.length) {
      return res.json({ drawer: null, transactions: [] });
    }
    const drawer = drawerResult.rows[0];
    const txns = await pool.query(
      'SELECT * FROM cash_drawer_transactions WHERE drawer_id = $1 ORDER BY created_at',
      [drawer.id]
    );
    res.json({ drawer, transactions: txns.rows });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/rep/cash-drawer/transaction', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { type, amount, description } = req.body;
    if (!type || !['cash_in', 'cash_out'].includes(type)) {
      return res.status(400).json({ error: 'type must be cash_in or cash_out' });
    }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

    await client.query('BEGIN');

    const drawerResult = await client.query(
      "SELECT * FROM cash_drawers WHERE rep_id = $1 AND status = 'open' ORDER BY opened_at DESC LIMIT 1",
      [req.rep.id]
    );
    if (!drawerResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No open cash drawer' });
    }
    const drawer = drawerResult.rows[0];

    const txnResult = await client.query(
      'INSERT INTO cash_drawer_transactions (drawer_id, type, amount, description) VALUES ($1, $2, $3, $4) RETURNING *',
      [drawer.id, type, amt.toFixed(2), description || null]
    );

    const delta = type === 'cash_in' ? amt : -amt;
    const updatedDrawer = await client.query(
      'UPDATE cash_drawers SET expected_balance = expected_balance + $1 WHERE id = $2 RETURNING *',
      [delta, drawer.id]
    );

    await client.query('COMMIT');
    res.json({ transaction: txnResult.rows[0], drawer: updatedDrawer.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.post('/api/rep/cash-drawer/close', repAuth, async (req, res) => {
  try {
    const { actual_balance, notes } = req.body;
    const actual = parseFloat(actual_balance);
    if (isNaN(actual) || actual < 0) return res.status(400).json({ error: 'Invalid actual balance' });

    const drawerResult = await pool.query(
      "SELECT * FROM cash_drawers WHERE rep_id = $1 AND status = 'open' ORDER BY opened_at DESC LIMIT 1",
      [req.rep.id]
    );
    if (!drawerResult.rows.length) {
      return res.status(400).json({ error: 'No open cash drawer to close' });
    }
    const drawer = drawerResult.rows[0];
    const expected = parseFloat(drawer.expected_balance);
    const overShort = actual - expected;

    const result = await pool.query(
      `UPDATE cash_drawers SET status = 'closed', actual_balance = $1, over_short = $2, notes = $3, closed_at = NOW()
       WHERE id = $4 RETURNING *`,
      [actual.toFixed(2), overShort.toFixed(2), notes || null, drawer.id]
    );
    res.json({ drawer: result.rows[0] });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/rep/cash-drawer/history', repAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM cash_drawers WHERE rep_id = $1 AND status = 'closed'
       AND closed_at >= NOW() - INTERVAL '30 days'
       ORDER BY closed_at DESC`,
      [req.rep.id]
    );
    res.json({ drawers: result.rows });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Stripe Terminal (Tap to Pay) ====================

app.post('/api/rep/terminal/connection-token', repAuth, async (req, res) => {
  try {
    const token = await stripe.terminal.connectionTokens.create();
    res.json({ secret: token.secret });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/rep/terminal/create-payment-intent', repAuth, async (req, res) => {
  try {
    const { amount, order_description } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'A positive amount is required' });
    }
    if (amount > 50000) {
      return res.status(400).json({ error: 'Amount exceeds maximum of $50,000' });
    }
    const amountCents = Math.round(amount * 100);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      description: order_description || 'In-store payment via Tap to Pay',
    });
    res.json({ client_secret: paymentIntent.client_secret, payment_intent_id: paymentIntent.id });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Manual card entry (mobile) — creates a PI for Stripe Elements confirmation
app.post('/api/rep/card/create-payment-intent', repAuth, async (req, res) => {
  try {
    const { amount, order_description } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'A positive amount is required' });
    }
    if (amount > 50000) {
      return res.status(400).json({ error: 'Amount exceeds maximum of $50,000' });
    }
    const amountCents = Math.round(amount * 100);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      payment_method_types: ['card'],
      description: order_description || 'In-store manual card entry',
    });
    res.json({ client_secret: paymentIntent.client_secret, payment_intent_id: paymentIntent.id });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ACH bank transfer — creates a PI for us_bank_account confirmation
app.post('/api/rep/ach/create-payment-intent', repAuth, async (req, res) => {
  try {
    const { amount, customer_name, customer_email } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'A positive amount is required' });
    }
    if (amount > 50000) {
      return res.status(400).json({ error: 'Amount exceeds maximum of $50,000' });
    }
    if (!customer_name || !customer_email) {
      return res.status(400).json({ error: 'Customer name and email are required for ACH payments' });
    }
    const amountCents = Math.round(amount * 100);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      payment_method_types: ['us_bank_account'],
      payment_method_options: {
        us_bank_account: {
          financial_connections: { permissions: ['payment_method'] }
        }
      },
      description: 'ACH bank transfer — rep-created order',
    });
    res.json({ client_secret: paymentIntent.client_secret, payment_intent_id: paymentIntent.id });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/rep/terminal/capture-payment', repAuth, async (req, res) => {
  try {
    const { payment_intent_id } = req.body;
    if (!payment_intent_id) {
      return res.status(400).json({ error: 'payment_intent_id is required' });
    }
    const pi = await stripe.paymentIntents.retrieve(payment_intent_id);
    if (pi.status === 'requires_capture') {
      const captured = await stripe.paymentIntents.capture(payment_intent_id);
      return res.json({ payment_intent: captured });
    }
    res.json({ payment_intent: pi });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Quick Create Order (Rep) ====================

app.post('/api/rep/orders', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { customer_name, customer_email, phone, delivery_method, shipping_address,
            payment_method, items, promo_code, document_ids } = req.body;

    if (!customer_name || !customer_email) {
      return res.status(400).json({ error: 'Customer name and email are required' });
    }
    if (!phone || phone.replace(/\D/g, '').length !== 10) {
      return res.status(400).json({ error: 'A valid 10-digit phone number is required' });
    }
    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required' });
    }
    if (!payment_method || !['cash', 'check', 'card', 'stripe', 'offline', 'ach'].includes(payment_method)) {
      return res.status(400).json({ error: 'payment_method must be cash, check, card, stripe, offline, or ach' });
    }
    const { check_number, stripe_payment_intent_id } = req.body;
    if (payment_method === 'check' && !check_number) {
      return res.status(400).json({ error: 'check_number is required for check payments' });
    }
    if (payment_method === 'ach' && (!document_ids || document_ids.length < 2)) {
      return res.status(400).json({ error: 'ACH payments require customer ID and check photo uploads' });
    }
    if (payment_method === 'card' && !stripe_payment_intent_id) {
      return res.status(400).json({ error: 'Card payments require Stripe Terminal. Use the tap-to-pay flow.' });
    }

    const isPickup = delivery_method === 'pickup';
    if (!isPickup && (!shipping_address || !shipping_address.line1 || !shipping_address.city || !shipping_address.state || !shipping_address.zip)) {
      return res.status(400).json({ error: 'Shipping address is required for delivery orders' });
    }

    await client.query('BEGIN');

    // Auto-create customer
    const nameParts = (customer_name || '').split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';
    const { customer: cust } = await findOrCreateCustomer(client, {
      email: customer_email, firstName, lastName,
      phone, repId: req.rep.id, createdVia: 'order'
    });

    // Resolve items
    const resolvedItems = [];
    for (const item of items) {
      if (item.sku_id) {
        // SKU-based item
        const skuResult = await client.query(`
          SELECT s.id as sku_id, s.product_id, s.vendor_sku, s.variant_name, s.sell_by, s.is_sample,
            COALESCE(p.display_name, p.name) as product_name, p.collection, p.category_id,
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
    const orderNumber = await getNextOrderNumber();
    const paidInStore = ['cash', 'check', 'card', 'offline'].includes(payment_method);
    const orderStatus = paidInStore ? 'confirmed' : 'pending';

    let stripePaymentIntentId = null;
    if (payment_method === 'card' && stripe_payment_intent_id) {
      // Verify the Terminal payment was successful
      const pi = await stripe.paymentIntents.retrieve(stripe_payment_intent_id);
      if (pi.status !== 'succeeded') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Terminal payment not completed. Status: ' + pi.status });
      }
      stripePaymentIntentId = stripe_payment_intent_id;
    } else if (payment_method === 'ach' && stripe_payment_intent_id) {
      stripePaymentIntentId = stripe_payment_intent_id;
    } else if (payment_method === 'stripe') {
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
        amount_paid, customer_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
      RETURNING *
    `, [orderNumber, customer_email.toLowerCase().trim(), customer_name, phone || null,
        isPickup ? null : shipping_address.line1, isPickup ? null : (shipping_address.line2 || null),
        isPickup ? null : shipping_address.city, isPickup ? null : shipping_address.state, isPickup ? null : shipping_address.zip,
        subtotal.toFixed(2), total.toFixed(2), orderStatus, req.rep.id, payment_method,
        isPickup ? 'pickup' : 'shipping',
        stripePaymentIntentId, promoCodeId, promoCodeStr, discountAmount.toFixed(2),
        paidInStore ? total.toFixed(2) : '0.00', cust.id]);

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

    // Link uploaded documents to the order
    if (document_ids && document_ids.length > 0) {
      await client.query(
        'UPDATE order_documents SET order_id = $1 WHERE id = ANY($2) AND order_id IS NULL',
        [order.id, document_ids]
      );
    }

    // Record payment in ledger for in-store payments
    if (paidInStore) {
      const repFullName = req.rep.first_name + ' ' + req.rep.last_name;
      let payDesc = 'Offline payment (rep-created)';
      if (payment_method === 'cash') payDesc = 'Cash payment';
      else if (payment_method === 'check') payDesc = 'Check payment — #' + check_number;
      else if (payment_method === 'card') payDesc = 'In-store card payment';

      const repPayOpRes = await client.query(`
        INSERT INTO order_payments (order_id, payment_type, amount, description, initiated_by, initiated_by_name, status, check_number, payment_method)
        VALUES ($1, 'charge', $2, $3, $4, $5, 'completed', $6, $7) RETURNING id
      `, [order.id, total.toFixed(2), payDesc, req.rep.id, repFullName, check_number || null, payment_method]);
      await syncOrderPaymentToInvoice(repPayOpRes.rows[0].id, order.id, client);

      // Record cash drawer transaction for cash payments
      if (payment_method === 'cash') {
        const drawerResult = await client.query(
          "SELECT id FROM cash_drawers WHERE rep_id = $1 AND status = 'open' ORDER BY opened_at DESC LIMIT 1",
          [req.rep.id]
        );
        if (drawerResult.rows.length) {
          const drawerId = drawerResult.rows[0].id;
          await client.query(
            'INSERT INTO cash_drawer_transactions (drawer_id, order_id, type, amount, description) VALUES ($1, $2, $3, $4, $5)',
            [drawerId, order.id, 'sale', total, 'Cash sale — ' + orderNumber]
          );
          await client.query(
            'UPDATE cash_drawers SET expected_balance = expected_balance + $1 WHERE id = $2',
            [total, drawerId]
          );
        }
      }
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
      WHERE o.id = $1 AND o.sales_rep_id = $2
    `, [id, req.rep.id]);
    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });

    const items = await pool.query(`
      SELECT oi.*, COALESCE(p.display_name, p.name) as current_product_name, p.collection as current_collection,
        v.name as vendor_name, s.vendor_sku, s.variant_name,
        sa_c.value as color
      FROM order_items oi
      LEFT JOIN skus s ON s.id = oi.sku_id
      LEFT JOIN products p ON p.id = COALESCE(s.product_id, oi.product_id)
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = oi.sku_id
        AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
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
    const balanceInfo = await recalculateBalance(pool, id);

    res.json({
      order: order.rows[0],
      items: items.rows,
      price_adjustments: adjustments.rows,
      payments: payments.rows,
      payment_requests: paymentRequests.rows,
      balance: balanceInfo
    });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/rep/orders/:id/status', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { status, tracking_number, carrier, shipped_at, cancel_reason } = req.body;
    const validStatuses = ['pending', 'confirmed', 'ready_for_pickup', 'shipped', 'delivered', 'cancelled', 'refunded'];
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

    // Block uncancelling a refunded order + verify rep ownership
    const currentOrder = await client.query('SELECT status, stripe_refund_id FROM orders WHERE id = $1 AND sales_rep_id = $2', [id, req.rep.id]);
    if (!currentOrder.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    if (currentOrder.rows[0].status === 'cancelled' && currentOrder.rows[0].stripe_refund_id) {
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
    } else if (status === 'ready_for_pickup') {
      result = await client.query(
        'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
        [status, id]
      );
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

    // Auto-task: post-delivery follow-up when rep marks order delivered
    if (status === 'delivered') {
      setImmediate(() => createAutoTask(pool, req.rep.id, 'order_delivered', id,
        `Post-delivery follow-up — ${updatedOrder.customer_name} (${updatedOrder.order_number})`, {
          priority: 'low', customer_name: updatedOrder.customer_name,
          customer_email: updatedOrder.customer_email, customer_phone: updatedOrder.customer_phone,
          linked_order_id: id
        }).catch(err => console.error('[AutoTask] order_delivered rep error:', err.message)));
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Change delivery method on existing order (rep)
app.put('/api/rep/orders/:id/delivery-method', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { delivery_method, shipping_address, shipping_option_index, residential, liftgate } = req.body;

    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1 AND sales_rep_id = $2', [id, req.rep.id]);
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
      if (order.sales_rep_id && order.sales_rep_id !== req.rep.id) {
        setImmediate(() => createRepNotification(pool, order.sales_rep_id, 'delivery_method_changed',
          `${order.order_number} delivery → pickup`, `${repName} changed delivery to pickup`, 'order', id));
      }
      const balanceInfo = await recalculateBalance(pool, id);
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
    if (order.sales_rep_id && order.sales_rep_id !== req.rep.id) {
      setImmediate(() => createRepNotification(pool, order.sales_rep_id, 'delivery_method_changed',
        `${order.order_number} delivery → shipping`, `${repName} changed delivery to shipping ($${shippingCost.toFixed(2)})`, 'order', id));
    }
    const balanceInfo = await recalculateBalance(pool, id);
    return res.json({ order: updated.rows[0], balance: balanceInfo });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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

    const priceRepName = req.rep.first_name + ' ' + req.rep.last_name;
    await logOrderActivity(client, id, 'price_adjusted', req.rep.id, priceRepName,
      { product_name: current.product_name, previous_price: prevPrice.toFixed(2), new_price: newPrice.toFixed(2), reason: reason || null });

    await client.query('COMMIT');

    // Notify assigned rep if different from the one making the change
    const priceOrder = await pool.query('SELECT order_number, sales_rep_id FROM orders WHERE id = $1', [id]);
    if (priceOrder.rows.length && priceOrder.rows[0].sales_rep_id && priceOrder.rows[0].sales_rep_id !== req.rep.id) {
      setImmediate(() => createRepNotification(pool, priceOrder.rows[0].sales_rep_id, 'price_adjusted',
        `Price adjusted on ${priceOrder.rows[0].order_number}`,
        `${priceRepName} changed ${current.product_name}: $${prevPrice.toFixed(2)} → $${newPrice.toFixed(2)}`,
        'order', id));
    }

    // Return updated order + items
    const updatedOrder = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    const updatedItems = await pool.query(`
      SELECT oi.*, COALESCE(p.display_name, p.name) as current_product_name, p.collection as current_collection,
        v.name as vendor_name, s.vendor_sku, s.variant_name,
        sa_c.value as color
      FROM order_items oi
      LEFT JOIN skus s ON s.id = oi.sku_id
      LEFT JOIN products p ON p.id = COALESCE(s.product_id, oi.product_id)
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = oi.sku_id
        AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
      WHERE oi.order_id = $1 ORDER BY oi.id
    `, [id]);
    const adjustments = await pool.query(`
      SELECT opa.*, sr.first_name || ' ' || sr.last_name as rep_name
      FROM order_price_adjustments opa
      JOIN sales_reps sr ON sr.id = opa.rep_id
      WHERE opa.order_item_id = ANY(SELECT oi2.id FROM order_items oi2 WHERE oi2.order_id = $1)
      ORDER BY opa.created_at DESC
    `, [id]);

    const balanceInfo = await recalculateBalance(pool, id);
    res.json({ order: updatedOrder.rows[0], items: updatedItems.rows, price_adjustments: adjustments.rows, balance: balanceInfo });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    const { sku_id, num_boxes, sqft_needed, product_name, unit_price, vendor_id, description, sell_by: customSellBy } = req.body;

    const isCustom = !sku_id;
    if (isCustom) {
      if (!product_name || !product_name.trim()) return res.status(400).json({ error: 'product_name is required for custom items' });
      if (unit_price == null || parseFloat(unit_price) < 0) return res.status(400).json({ error: 'unit_price >= 0 is required for custom items' });
      if (!vendor_id) return res.status(400).json({ error: 'vendor_id is required for custom items' });
      if (!num_boxes || num_boxes < 1) return res.status(400).json({ error: 'num_boxes >= 1 is required' });
    } else {
      if ((!num_boxes || num_boxes < 1) && !sqft_needed) return res.status(400).json({ error: 'sku_id and num_boxes (>= 1) or sqft_needed are required' });
    }

    const orderResult = await client.query('SELECT * FROM orders WHERE id = $1 AND sales_rep_id = $2', [id, req.rep.id]);
    if (!orderResult.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (!['pending', 'confirmed'].includes(order.status)) {
      return res.status(400).json({ error: 'Can only add items to pending or confirmed orders' });
    }

    let sku = null;
    let unitPrice, sqftPerBox, isPerSqft, computedSqft, itemSubtotal;
    let itemVendorId;

    if (!isCustom) {
      const skuResult = await client.query(`
        SELECT s.*, COALESCE(p.display_name, p.name) as product_name, p.collection, p.vendor_id,
          pr.retail_price, pr.price_basis, pr.cost, pr.cut_price, pr.roll_price,
          pk.sqft_per_box, pk.weight_per_box_lbs, pk.roll_width_ft,
          sa_c.value as color
        FROM skus s
        JOIN products p ON p.id = s.product_id
        LEFT JOIN pricing pr ON pr.sku_id = s.id
        LEFT JOIN packaging pk ON pk.sku_id = s.id
        LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = s.id
          AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
        WHERE s.id = $1
      `, [sku_id]);
      if (!skuResult.rows.length) return res.status(404).json({ error: 'SKU not found' });
      sku = skuResult.rows[0];

      const isCarpet = sku.price_basis === 'per_sqyd';
      unitPrice = parseFloat(sku.retail_price || 0);
      sqftPerBox = parseFloat(sku.sqft_per_box || 1);
      isPerSqft = sku.price_basis === 'per_sqft' || sku.price_basis === 'sqft';

      if (isCarpet) {
        computedSqft = parseFloat(sqft_needed || 0);
        const sqyd = computedSqft / 9;
        itemSubtotal = parseFloat((unitPrice * sqyd).toFixed(2));
      } else {
        computedSqft = isPerSqft ? num_boxes * sqftPerBox : null;
        itemSubtotal = parseFloat((isPerSqft ? unitPrice * computedSqft : unitPrice * num_boxes).toFixed(2));
      }
      itemVendorId = sku.vendor_id;
    } else {
      unitPrice = parseFloat(unit_price);
      if (customSellBy === 'sqyd') {
        itemSubtotal = parseFloat((unitPrice * (num_boxes / 9)).toFixed(2));
      } else {
        itemSubtotal = parseFloat((unitPrice * num_boxes).toFixed(2));
      }
      itemVendorId = vendor_id;

      const vendorCheck = await client.query('SELECT id FROM vendors WHERE id = $1', [vendor_id]);
      if (!vendorCheck.rows.length) return res.status(400).json({ error: 'Vendor not found' });
    }

    await client.query('BEGIN');

    // Build full descriptive product name for SKU items
    let storedProductName, storedDescription;
    if (!isCustom) {
      const descParts = [sku.color, sku.variant_name && sku.variant_name !== sku.color ? sku.variant_name : null].filter(Boolean).join(' · ');
      storedProductName = sku.collection
        ? (descParts ? sku.collection + ' — ' + descParts : sku.collection)
        : (descParts ? sku.product_name + ' — ' + descParts : sku.product_name);
      storedDescription = descParts || null;
    }

    let newItemId;
    if (!isCustom) {
      const isCarpet = sku.price_basis === 'per_sqyd';
      const insertResult = await client.query(`
        INSERT INTO order_items (order_id, product_id, sku_id, product_name, collection, description,
          sqft_needed, num_boxes, unit_price, subtotal, is_sample, sell_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, $11)
        RETURNING id
      `, [id, sku.product_id, sku_id, storedProductName, sku.collection, storedDescription,
          sqft_needed || computedSqft || null, isCarpet ? 1 : num_boxes, unitPrice.toFixed(2), itemSubtotal.toFixed(2),
          isCarpet ? 'sqyd' : (sku.sell_by || null)]);
      newItemId = insertResult.rows[0].id;
    } else {
      const isCustomCarpet = customSellBy === 'sqyd';
      const insertResult = await client.query(`
        INSERT INTO order_items (order_id, product_id, sku_id, product_name, collection,
          sqft_needed, num_boxes, unit_price, subtotal, is_sample, sell_by, description)
        VALUES ($1, NULL, NULL, $2, NULL, $3, $4, $5, $6, false, $7, $8)
        RETURNING id
      `, [id, product_name.trim(), isCustomCarpet ? num_boxes : (sqft_needed || null),
          isCustomCarpet ? 1 : num_boxes, unitPrice.toFixed(2),
          itemSubtotal.toFixed(2), customSellBy || null, description || null]);
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
    {
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
        const poNumber = await getNextPONumber(vendorCode);
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
        const poIsPerSqft = sku.price_basis === 'per_sqft' || sku.price_basis === 'sqft';
        poCost = poIsPerSqft ? vendorCost * skuSqftPerBox : vendorCost;
        poRetail = poIsPerSqft ? unitPrice * skuSqftPerBox : unitPrice;
        poVendorSku = sku.vendor_sku;
        poProductName = storedProductName;
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

    const addRepName = req.rep.first_name + ' ' + req.rep.last_name;
    const addedProductName = isCustom ? product_name.trim() : storedProductName;
    await logOrderActivity(client, id, 'item_added', req.rep.id, addRepName,
      { product_name: addedProductName, is_custom: isCustom, num_boxes, subtotal: itemSubtotal.toFixed(2) });

    await client.query('COMMIT');

    // Notify assigned rep if different
    if (order.sales_rep_id && order.sales_rep_id !== req.rep.id) {
      setImmediate(() => createRepNotification(pool, order.sales_rep_id, 'item_added',
        `Item added to ${order.order_number}`,
        `${addRepName} added ${addedProductName} × ${num_boxes} ($${itemSubtotal.toFixed(2)})`,
        'order', id));
    }

    const balanceInfo = await recalculateBalance(pool, id);
    const updatedOrder = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    const updatedItems = await pool.query(`
      SELECT oi.*, COALESCE(p.display_name, p.name) as current_product_name, p.collection as current_collection,
        v.name as vendor_name, s.vendor_sku, s.variant_name,
        sa_c.value as color
      FROM order_items oi
      LEFT JOIN skus s ON s.id = oi.sku_id
      LEFT JOIN products p ON p.id = COALESCE(s.product_id, oi.product_id)
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = oi.sku_id
        AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
      WHERE oi.order_id = $1 ORDER BY oi.id
    `, [id]);

    const posResult = await pool.query(`
      SELECT po.*, v.name as vendor_name, v.edi_config
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Remove item from existing order (rep)
app.delete('/api/rep/orders/:id/items/:itemId', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id, itemId } = req.params;

    const orderResult = await client.query('SELECT * FROM orders WHERE id = $1 AND sales_rep_id = $2', [id, req.rep.id]);
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
    const removeRepName = req.rep.first_name + ' ' + req.rep.last_name;
    await logOrderActivity(client, id, 'item_removed', req.rep.id, removeRepName,
      { product_name: removedItemRep.product_name, num_boxes: removedItemRep.num_boxes, subtotal: parseFloat(removedItemRep.subtotal).toFixed(2) });

    await client.query('COMMIT');

    // Notify assigned rep if different
    if (order.sales_rep_id && order.sales_rep_id !== req.rep.id) {
      setImmediate(() => createRepNotification(pool, order.sales_rep_id, 'item_removed',
        `Item removed from ${order.order_number}`,
        `${removeRepName} removed ${removedItemRep.product_name}`,
        'order', id));
    }

    const balanceInfo = await recalculateBalance(pool, id);
    const updatedOrder = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    const updatedItems = await pool.query(`
      SELECT oi.*, COALESCE(p.display_name, p.name) as current_product_name, p.collection as current_collection,
        v.name as vendor_name, s.vendor_sku, s.variant_name,
        sa_c.value as color
      FROM order_items oi
      LEFT JOIN skus s ON s.id = oi.sku_id
      LEFT JOIN products p ON p.id = COALESCE(s.product_id, oi.product_id)
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = oi.sku_id
        AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
      WHERE oi.order_id = $1 ORDER BY oi.id
    `, [id]);

    // Fetch updated POs
    const posResult = await pool.query(`
      SELECT po.*, v.name as vendor_name, v.edi_config
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Send payment request (rep)
app.post('/api/rep/orders/:id/payment-request', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body || {};
    const order = await pool.query('SELECT * FROM orders WHERE id = $1 AND sales_rep_id = $2', [id, req.rep.id]);
    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });
    const o = order.rows[0];

    const balanceInfo = await recalculateBalance(pool, id);
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

    // Notify assigned rep if different
    if (o.sales_rep_id && o.sales_rep_id !== req.rep.id) {
      setImmediate(() => createRepNotification(pool, o.sales_rep_id, 'payment_request_sent',
        `Payment request sent for ${o.order_number}`,
        `${repName} sent $${amountDue.toFixed(2)} payment request to ${o.customer_email}`,
        'order', id));
    }

    setImmediate(() => sendPaymentRequest({ order: o, amount: amountDue, checkout_url: session.url, message: message || null }));

    res.json({ payment_request: prResult.rows[0], checkout_url: session.url });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Collect payment in person on existing order (rep)
app.post('/api/rep/orders/:id/collect-payment', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { payment_method, amount, stripe_payment_intent_id, check_number } = req.body;

    if (!['cash', 'card', 'check'].includes(payment_method)) {
      return res.status(400).json({ error: 'Invalid payment_method. Must be cash, card, or check.' });
    }

    await client.query('BEGIN');

    const orderResult = await client.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (!orderResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = orderResult.rows[0];

    const balanceInfo = await recalculateBalance(pool, id, client);
    if (!balanceInfo || balanceInfo.balance_status !== 'balance_due') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No balance due on this order' });
    }

    const payAmount = amount ? parseFloat(amount) : balanceInfo.balance;
    if (payAmount <= 0 || payAmount > balanceInfo.balance + 0.01) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Invalid amount. Balance due is $${balanceInfo.balance.toFixed(2)}` });
    }

    const repName = req.rep.first_name + ' ' + req.rep.last_name;
    let stripePaymentIntentId = null;

    if (payment_method === 'card') {
      if (!stripe_payment_intent_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'stripe_payment_intent_id required for card payments' });
      }
      const pi = await stripe.paymentIntents.retrieve(stripe_payment_intent_id);
      if (pi.status !== 'succeeded') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Card payment not completed. Status: ' + pi.status });
      }
      stripePaymentIntentId = stripe_payment_intent_id;
    }

    if (payment_method === 'check') {
      if (!check_number || !check_number.trim()) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'check_number is required for check payments' });
      }
    }

    // Insert order_payments row
    const description = payment_method === 'cash' ? 'In-store cash payment'
      : payment_method === 'card' ? 'In-store card payment'
      : 'Check payment — #' + check_number;

    const addPayOpRes = await client.query(`
      INSERT INTO order_payments (order_id, payment_type, amount, stripe_payment_intent_id, description, initiated_by, initiated_by_name, status, check_number, payment_method)
      VALUES ($1, 'additional_charge', $2, $3, $4, $5, $6, 'completed', $7, $8) RETURNING id
    `, [id, payAmount.toFixed(2), stripePaymentIntentId, description, req.rep.id, repName, payment_method === 'check' ? check_number : null, payment_method]);
    await syncOrderPaymentToInvoice(addPayOpRes.rows[0].id, id, client);

    // Update amount_paid
    await client.query('UPDATE orders SET amount_paid = amount_paid + $1 WHERE id = $2', [payAmount, id]);

    // Cash drawer transaction
    if (payment_method === 'cash') {
      const drawerResult = await client.query(
        "SELECT id FROM cash_drawers WHERE rep_id = $1 AND status = 'open' ORDER BY opened_at DESC LIMIT 1",
        [req.rep.id]
      );
      if (drawerResult.rows.length) {
        const drawerId = drawerResult.rows[0].id;
        await client.query(
          'INSERT INTO cash_drawer_transactions (drawer_id, order_id, type, amount, description) VALUES ($1, $2, $3, $4, $5)',
          [drawerId, id, 'sale', payAmount, 'Additional payment — ' + order.order_number]
        );
        await client.query(
          'UPDATE cash_drawers SET expected_balance = expected_balance + $1 WHERE id = $2',
          [payAmount, drawerId]
        );
      }
    }

    // Auto-confirm pending orders when fully paid
    const updatedBalance = await recalculateBalance(pool, id, client);
    if (updatedBalance && updatedBalance.balance_status === 'paid' && order.status === 'pending') {
      await client.query("UPDATE orders SET status = 'confirmed' WHERE id = $1", [id]);
      await logOrderActivity(client, id, 'status_changed', req.rep.id, repName,
        { from: 'pending', to: 'confirmed', reason: 'Auto-confirmed after full payment' });
      await generatePurchaseOrders(id, client);
    }

    await logOrderActivity(client, id, 'payment_collected', req.rep.id, repName,
      { method: payment_method, amount: payAmount.toFixed(2), status: paymentStatus });

    await client.query('COMMIT');

    // Return updated balance
    const finalBalance = await recalculateBalance(pool, id);
    res.json({ success: true, balance: finalBalance });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Vendors list for rep (used in custom item dropdown)
app.get('/api/rep/vendors', repAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT v.id, v.name, v.code
      FROM vendors v
      WHERE v.is_active = true
        AND EXISTS (SELECT 1 FROM products p WHERE p.vendor_id = v.id AND p.status = 'active')
      ORDER BY v.name
    `);
    res.json({ vendors: result.rows });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// SKU search for add-item (rep)
app.get('/api/rep/skus/search', repAuth, async (req, res) => {
  try {
    const results = await searchSkus(pool, req.query.q);
    res.json({ results });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Rep Product Catalog ====================

app.get('/api/rep/products', repAuth, async (req, res) => {
  try {
    const { search, category, collection, vendor, stock_status, min_price, max_price, page: pageParam, limit: limitParam } = req.query;
    const page = parseInt(pageParam) || 1;
    const limit = Math.min(parseInt(limitParam) || 30, 100);
    const offset = (page - 1) * limit;

    let query = `
      SELECT p.*, v.name as vendor_name, v.code as vendor_code, c.name as category_name, c.slug as category_slug,
        (SELECT COUNT(*)::int FROM skus s WHERE s.product_id = p.id AND s.status = 'active') as sku_count,
        (SELECT pr.retail_price FROM pricing pr
         JOIN skus s ON s.id = pr.sku_id
         WHERE s.product_id = p.id AND s.status = 'active' LIMIT 1) as price,
        (SELECT pr.cost FROM pricing pr
         JOIN skus s ON s.id = pr.sku_id
         WHERE s.product_id = p.id AND s.status = 'active' LIMIT 1) as cost,
        (SELECT pr.map_price FROM pricing pr
         JOIN skus s ON s.id = pr.sku_id
         WHERE s.product_id = p.id AND s.status = 'active' AND pr.map_price IS NOT NULL LIMIT 1) as map_price,
        (SELECT s.sell_by FROM skus s
         WHERE s.product_id = p.id AND s.status = 'active' LIMIT 1) as sell_by,
        (SELECT s.vendor_sku FROM skus s
         WHERE s.product_id = p.id AND s.status = 'active' LIMIT 1) as vendor_sku,
        (SELECT pk.sqft_per_box FROM packaging pk
         JOIN skus s ON s.id = pk.sku_id
         WHERE s.product_id = p.id AND s.status = 'active' AND pk.sqft_per_box IS NOT NULL LIMIT 1) as sqft_per_box,
        (SELECT pk.weight_per_box_lbs FROM packaging pk
         JOIN skus s ON s.id = pk.sku_id
         WHERE s.product_id = p.id AND s.status = 'active' AND pk.weight_per_box_lbs IS NOT NULL LIMIT 1) as weight_per_box,
        (SELECT pk.pieces_per_box FROM packaging pk
         JOIN skus s ON s.id = pk.sku_id
         WHERE s.product_id = p.id AND s.status = 'active' AND pk.pieces_per_box IS NOT NULL LIMIT 1) as pieces_per_box,
        (SELECT ma.url FROM media_assets ma
         WHERE ma.product_id = p.id AND ma.asset_type = 'primary'
         ORDER BY CASE WHEN ma.sku_id IS NULL THEN 0 ELSE 1 END, ma.sort_order LIMIT 1) as primary_image,
        (SELECT COALESCE(SUM(CASE WHEN inv.fresh_until > NOW() THEN inv.qty_on_hand ELSE 0 END), 0)
         FROM skus s2
         LEFT JOIN inventory_snapshots inv ON inv.sku_id = s2.id
         WHERE s2.product_id = p.id AND s2.status = 'active'
        ) as qty_on_hand,
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

    if (vendor) {
      params.push(vendor);
      query += ` AND v.id::text = $${paramIndex}`;
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

    // Wrap for price range filter if needed
    if (min_price || max_price) {
      let priceConditions = [];
      if (min_price && !isNaN(parseFloat(min_price))) {
        priceConditions.push(`priced.price::numeric >= $${paramIndex}`);
        params.push(parseFloat(min_price));
        paramIndex++;
      }
      if (max_price && !isNaN(parseFloat(max_price))) {
        priceConditions.push(`priced.price::numeric <= $${paramIndex}`);
        params.push(parseFloat(max_price));
        paramIndex++;
      }
      if (priceConditions.length > 0) {
        query = `SELECT * FROM (${query}) AS priced WHERE priced.price IS NOT NULL AND ${priceConditions.join(' AND ')}`;
      }
    }

    // Wrap for stock_status filter if needed
    if (stock_status && ['in_stock', 'low_stock', 'out_of_stock', 'unknown'].includes(stock_status)) {
      query = `SELECT * FROM (${query}) AS filtered WHERE filtered.stock_status = $${paramIndex}`;
      params.push(stock_status);
      paramIndex++;

      const countQuery = `SELECT COUNT(*)::int as total FROM (${query}) AS counted`;
      const countResult = await pool.query(countQuery, params);
      const total = countResult.rows[0].total;

      query += ` ORDER BY filtered.name LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);
      const result = await pool.query(query, params);

      const products = result.rows.map(p => {
        const retail = parseFloat(p.price || 0);
        const cost = parseFloat(p.cost || 0);
        const margin_pct = retail > 0 ? ((retail - cost) / retail * 100) : 0;
        return { ...p, margin_pct: parseFloat(margin_pct.toFixed(1)) };
      });
      res.json({ products, total, page, limit });
    } else {
      const countQuery = `SELECT COUNT(*)::int as total FROM (${query}) AS counted`;
      const countResult = await pool.query(countQuery, params);
      const total = countResult.rows[0].total;

      query = `SELECT * FROM (${query}) AS sorted ORDER BY sorted.name LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);
      const result = await pool.query(query, params);

      const products = result.rows.map(p => {
        const retail = parseFloat(p.price || 0);
        const cost = parseFloat(p.cost || 0);
        const margin_pct = retail > 0 ? ((retail - cost) / retail * 100) : 0;
        return { ...p, margin_pct: parseFloat(margin_pct.toFixed(1)) };
      });
      res.json({ products, total, page, limit });
    }
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Filterable attributes for rep catalog
app.get('/api/rep/filterable-attributes', repAuth, async (req, res) => {
  try {
    const attrs = await pool.query(`
      SELECT a.id, a.slug, a.name,
        ARRAY_AGG(DISTINCT sa.value ORDER BY sa.value) FILTER (WHERE sa.value IS NOT NULL AND sa.value != '') AS values
      FROM attributes a
      JOIN sku_attributes sa ON sa.attribute_id = a.id
      WHERE a.is_filterable = true
      GROUP BY a.id, a.slug, a.name
      ORDER BY a.name
    `);
    res.json({ attributes: attrs.rows });
  } catch (err) {
    console.error(err); res.json({ attributes: [] });
  }
});

// Share product with customer (rep)
app.post('/api/rep/share-product', repAuth, async (req, res) => {
  try {
    const { product_id, customer_email, message } = req.body;
    if (!product_id) return res.status(400).json({ error: 'Product ID is required' });
    if (!customer_email) return res.status(400).json({ error: 'Customer email is required' });

    const product = await pool.query(`
      SELECT p.*, v.name as vendor_name, c.name as category_name
      FROM products p
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.id = $1
    `, [product_id]);
    if (!product.rows.length) return res.status(404).json({ error: 'Product not found' });
    const p = product.rows[0];

    const pricing = await pool.query(`
      SELECT pr.retail_price, s.sell_by FROM pricing pr
      JOIN skus s ON s.id = pr.sku_id
      WHERE s.product_id = $1 AND s.status = 'active' AND pr.retail_price IS NOT NULL
      LIMIT 1
    `, [product_id]);
    const price = pricing.rows[0]?.retail_price || null;
    const sell_by = pricing.rows[0]?.sell_by || null;

    const media = await pool.query(
      "SELECT url FROM media_assets WHERE product_id = $1 AND asset_type = 'primary' ORDER BY sort_order LIMIT 1",
      [product_id]
    );
    const image_url = media.rows[0]?.url || null;

    const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
    const product_url = `${siteUrl}/shop/${p.slug || product_id}`;

    const rep = req.rep;
    await sendProductShare({
      product_name: p.collection ? `${p.collection} ${p.name}` : p.name,
      collection: p.collection,
      price,
      sell_by,
      image_url,
      product_url,
      rep_first_name: rep.first_name,
      rep_last_name: rep.last_name,
      rep_email: rep.email,
      rep_phone: rep.phone || null,
      customer_email,
      message: message || null
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Order Documents ====================

// Upload order document (customer ID or check photo)
app.post('/api/rep/orders/documents/upload', repAuth, docUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { doc_type, order_id } = req.body;
    if (!doc_type || !['customer_id', 'check_photo'].includes(doc_type)) {
      return res.status(400).json({ error: 'doc_type must be customer_id or check_photo' });
    }
    const ext = path.extname(req.file.originalname).toLowerCase();
    const hex = crypto.randomBytes(8).toString('hex');
    const fileKey = `order-docs/${Date.now()}-${hex}${ext}`;
    await uploadToS3(fileKey, req.file.buffer, req.file.mimetype);
    const result = await pool.query(
      `INSERT INTO order_documents (order_id, doc_type, file_name, file_key, file_size, mime_type)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, file_key`,
      [order_id || null, doc_type, req.file.originalname, fileKey, req.file.size, req.file.mimetype]
    );
    res.json({ document_id: result.rows[0].id, file_key: result.rows[0].file_key });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Get documents for an order
app.get('/api/rep/orders/:id/documents', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM order_documents WHERE order_id = $1 ORDER BY uploaded_at',
      [id]
    );
    const docs = [];
    for (const doc of result.rows) {
      let url = null;
      try { url = await getPresignedUrl(doc.file_key); } catch (e) {}
      docs.push({ ...doc, url });
    }
    res.json({ documents: docs });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Rep Invoice & Packing Slip ====================

app.get('/api/rep/orders/:id/invoice', async (req, res, next) => {
  if (!req.headers['x-rep-token'] && req.query.token) {
    req.headers['x-rep-token'] = req.query.token;
  }
  next();
}, repAuth, async (req, res) => {
  try {
    const result = await generateOrderInvoiceHtml(req.params.id);
    if (!result) return res.status(404).json({ error: 'Order not found' });
    await generatePDF(result.html, result.filename, req, res);
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/rep/orders/:id/packing-slip', async (req, res, next) => {
  if (!req.headers['x-rep-token'] && req.query.token) {
    req.headers['x-rep-token'] = req.query.token;
  }
  next();
}, repAuth, async (req, res) => {
  try {
    const result = await generateOrderPackingSlipHtml(req.params.id);
    if (!result) return res.status(404).json({ error: 'Order not found' });
    await generatePDF(result.html, result.filename, req, res);
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Send invoice email (with optional payment request if balance due)
app.post('/api/rep/orders/:id/send-invoice', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body || {};

    // 1. Get order + items
    const order = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });
    const o = order.rows[0];

    const items = await pool.query(`
      SELECT oi.*, p.sqft_per_box
      FROM order_items oi LEFT JOIN packaging p ON p.sku_id = oi.sku_id
      WHERE oi.order_id = $1 ORDER BY oi.id
    `, [id]);

    // 2. Generate invoice PDF
    const invoiceResult = await generateOrderInvoiceHtml(id);
    if (!invoiceResult) return res.status(500).json({ error: 'Failed to generate invoice' });
    let pdfBuffer = null;
    try {
      pdfBuffer = await generatePDFBuffer(invoiceResult.html);
    } catch (pdfErr) {
      console.error('[PDF] Buffer generation failed, sending without attachment:', pdfErr.message);
    }

    // 3. Check balance — if due, create Stripe payment request
    const balanceInfo = await recalculateBalance(pool, id);
    const balanceDue = balanceInfo && balanceInfo.balance > 0.01 ? balanceInfo.balance : 0;
    let checkoutUrl = null;
    const repName = req.rep.first_name + ' ' + req.rep.last_name;

    if (balanceDue > 0) {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: o.customer_email,
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: { name: `Balance Due — Order ${o.order_number}` },
            unit_amount: Math.round(balanceDue * 100)
          },
          quantity: 1
        }],
        metadata: { order_id: id, type: 'payment_request' },
        success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/account?order=${id}&payment=success`,
        cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/account?order=${id}&payment=cancelled`,
        expires_at: Math.floor(Date.now() / 1000) + 72 * 3600
      });

      checkoutUrl = session.url;

      const prResult = await pool.query(`
        INSERT INTO payment_requests (order_id, amount, stripe_checkout_session_id, stripe_checkout_url, sent_to_email, sent_by, sent_by_name, message, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
      `, [id, balanceDue.toFixed(2), session.id, session.url, o.customer_email, req.rep.id, repName, message || null, new Date(Date.now() + 72 * 3600 * 1000)]);

      await stripe.checkout.sessions.update(session.id, {
        metadata: { order_id: id, payment_request_id: prResult.rows[0].id, type: 'payment_request' }
      });

      await logOrderActivity(pool, id, 'payment_request_sent', req.rep.id, repName,
        { amount: balanceDue.toFixed(2), sent_to: o.customer_email, via: 'invoice_email' });
    }

    // 4. Send invoice email with PDF attached
    await sendOrderInvoiceEmail({
      order: o,
      items: items.rows,
      balance: balanceDue,
      checkout_url: checkoutUrl,
      message: message || null,
      pdf_buffer: pdfBuffer
    });

    // 5. Log activity
    await logOrderActivity(pool, id, 'invoice_sent', req.rep.id, repName,
      { sent_to: o.customer_email, balance_due: balanceDue.toFixed(2), payment_requested: balanceDue > 0 });

    res.json({
      success: true,
      sent_to: o.customer_email,
      balance_due: balanceDue,
      payment_requested: balanceDue > 0
    });
  } catch (err) {
    console.error('[Rep] Send invoice error:', err);
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Rep Purchase Order Endpoints ====================

// List all POs (standalone + order-linked) with filters
app.get('/api/rep/purchase-orders', repAuth, async (req, res) => {
  try {
    const { status, vendor_id, search, date_from, date_to } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (status) { conditions.push(`po.status = $${idx++}`); params.push(status); }
    if (vendor_id) { conditions.push(`po.vendor_id = $${idx++}`); params.push(vendor_id); }
    if (date_from) { conditions.push(`po.created_at >= $${idx++}`); params.push(date_from); }
    if (date_to) { conditions.push(`po.created_at <= $${idx++}::date + interval '1 day'`); params.push(date_to); }
    if (search) {
      conditions.push(`(po.po_number ILIKE $${idx} OR v.name ILIKE $${idx} OR o.order_number ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(`
      SELECT po.id, po.po_number, po.status, po.subtotal, po.created_at, po.updated_at,
        po.order_id, po.vendor_id,
        v.name as vendor_name, v.code as vendor_code,
        o.order_number,
        (SELECT COUNT(*) FROM purchase_order_items poi WHERE poi.purchase_order_id = po.id) as item_count,
        sr.first_name || ' ' || sr.last_name as approved_by_name,
        po.approved_at
      FROM purchase_orders po
      JOIN vendors v ON v.id = po.vendor_id
      LEFT JOIN orders o ON o.id = po.order_id
      LEFT JOIN sales_reps sr ON sr.id = po.approved_by
      ${where}
      ORDER BY po.created_at DESC
      LIMIT 200
    `, params);

    res.json({ purchase_orders: result.rows });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Create standalone PO (no order)
app.post('/api/rep/purchase-orders', repAuth, async (req, res) => {
  try {
    const { vendor_id, notes } = req.body;
    if (!vendor_id) return res.status(400).json({ error: 'vendor_id is required' });

    const vendor = await pool.query('SELECT id, code, name FROM vendors WHERE id = $1', [vendor_id]);
    if (!vendor.rows.length) return res.status(404).json({ error: 'Vendor not found' });

    const vendorCode = vendor.rows[0].code || 'XX';
    const poNumber = await getNextPONumber(vendorCode);

    const result = await pool.query(
      `INSERT INTO purchase_orders (order_id, vendor_id, po_number, status, subtotal, notes)
       VALUES (NULL, $1, $2, 'draft', 0, $3) RETURNING *`,
      [vendor_id, poNumber, notes || null]
    );

    const repName = req.rep.first_name + ' ' + req.rep.last_name;
    await pool.query(
      `INSERT INTO po_activity_log (purchase_order_id, action, performer_name, details)
       VALUES ($1, 'created', $2, $3)`,
      [result.rows[0].id, repName, JSON.stringify({ standalone: true })]
    );

    res.json({ purchase_order: { ...result.rows[0], vendor_name: vendor.rows[0].name, vendor_code: vendorCode, item_count: 0 } });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single PO detail with items + vendor info
app.get('/api/rep/purchase-orders/:poId/detail', repAuth, async (req, res) => {
  try {
    const { poId } = req.params;
    const po = await pool.query(`
      SELECT po.*, v.name as vendor_name, v.code as vendor_code,
        sr.first_name || ' ' || sr.last_name as approved_by_name,
        o.order_number
      FROM purchase_orders po
      JOIN vendors v ON v.id = po.vendor_id
      LEFT JOIN sales_reps sr ON sr.id = po.approved_by
      LEFT JOIN orders o ON o.id = po.order_id
      WHERE po.id = $1
    `, [poId]);
    if (!po.rows.length) return res.status(404).json({ error: 'Purchase order not found' });

    const items = await pool.query(
      'SELECT * FROM purchase_order_items WHERE purchase_order_id = $1 ORDER BY created_at',
      [poId]
    );

    const activity = await pool.query(
      'SELECT * FROM po_activity_log WHERE purchase_order_id = $1 ORDER BY created_at DESC',
      [poId]
    );

    res.json({ purchase_order: { ...po.rows[0], items: items.rows }, activity: activity.rows });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Rep add item to draft PO
app.post('/api/rep/purchase-orders/:poId/items', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { poId } = req.params;
    const { product_name, vendor_sku, description, qty, cost, sell_by, sku_id, retail_price } = req.body;

    if (!product_name || cost == null || qty == null) return res.status(400).json({ error: 'product_name, cost, and qty are required' });
    const parsedCost = parseFloat(cost);
    const parsedQty = parseInt(qty);
    if (isNaN(parsedCost) || parsedCost < 0) return res.status(400).json({ error: 'Invalid cost' });
    if (isNaN(parsedQty) || parsedQty < 1) return res.status(400).json({ error: 'Invalid qty' });
    const parsedRetail = retail_price != null ? parseFloat(retail_price) : null;

    const po = await client.query('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
    if (!po.rows.length) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.rows[0].status !== 'draft') return res.status(400).json({ error: 'Only draft POs can be edited' });

    await client.query('BEGIN');

    const subtotal = parsedCost * parsedQty;
    const itemResult = await client.query(
      `INSERT INTO purchase_order_items (purchase_order_id, sku_id, product_name, vendor_sku, description, qty, sell_by, cost, original_cost, retail_price, subtotal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10) RETURNING *`,
      [poId, sku_id || null, product_name, vendor_sku || null, description || null, parsedQty, sell_by || 'sqft', parsedCost.toFixed(2), parsedRetail != null && !isNaN(parsedRetail) ? parsedRetail.toFixed(2) : null, subtotal.toFixed(2)]
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Rep delete item from draft PO
app.delete('/api/rep/purchase-orders/:poId/items/:itemId', repAuth, async (req, res) => {
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
      `INSERT INTO po_activity_log (purchase_order_id, action, details, performer_name)
       VALUES ($1, 'bulk_item_status_update', $2, $3)`,
      [poId, JSON.stringify({ status, derived_po_status: newPOStatus }), repName]
    );

    await client.query('COMMIT');

    // Notify assigned rep if items received or PO fulfilled
    if (status === 'received' || newPOStatus === 'fulfilled') {
      const bulkPoOrder = await pool.query(
        'SELECT o.order_number, o.sales_rep_id FROM orders o JOIN purchase_orders po2 ON po2.order_id = o.id WHERE po2.id = $1', [poId]);
      if (bulkPoOrder.rows.length && bulkPoOrder.rows[0].sales_rep_id && bulkPoOrder.rows[0].sales_rep_id !== req.rep.id) {
        const msg = newPOStatus === 'fulfilled'
          ? `All items received on PO ${po.rows[0].po_number}`
          : `Items marked received on PO ${po.rows[0].po_number}`;
        setImmediate(() => createRepNotification(pool, bulkPoOrder.rows[0].sales_rep_id, 'po_items_received',
          msg, `${repName} updated items for ${bulkPoOrder.rows[0].order_number}`, 'order', po.rows[0].order_id));
      }
    }

    res.json({ success: true, derived_po_status: newPOStatus });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
      `INSERT INTO po_activity_log (purchase_order_id, action, details, performer_name)
       VALUES ($1, 'item_status_update', $2, $3)`,
      [poId, JSON.stringify({ item_id: itemId, status, derived_po_status: newPOStatus }), repName]
    );

    await client.query('COMMIT');

    // Notify assigned rep when items received or PO fulfilled
    if (status === 'received' || newPOStatus === 'fulfilled') {
      const singlePoOrder = await pool.query(
        'SELECT o.order_number, o.sales_rep_id FROM orders o JOIN purchase_orders po2 ON po2.order_id = o.id WHERE po2.id = $1', [poId]);
      if (singlePoOrder.rows.length && singlePoOrder.rows[0].sales_rep_id && singlePoOrder.rows[0].sales_rep_id !== req.rep.id) {
        const singleMsg = newPOStatus === 'fulfilled'
          ? `All items received on PO ${po.rows[0].po_number}`
          : `Item marked received on PO ${po.rows[0].po_number}`;
        setImmediate(() => createRepNotification(pool, singlePoOrder.rows[0].sales_rep_id, 'po_items_received',
          singleMsg, `${repName} updated item for ${singlePoOrder.rows[0].order_number}`, 'order', po.rows[0].order_id));
      }
    }

    res.json({ success: true, derived_po_status: newPOStatus });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Rep PO Document PDF - accepts token from header or query param
app.get('/api/rep/purchase-orders/:id/pdf', async (req, res, next) => {
  if (!req.headers['x-rep-token'] && req.query.token) {
    req.headers['x-rep-token'] = req.query.token;
  }
  next();
}, repAuth, async (req, res) => {
  try {
    const result = await generatePOHtml(pool, req.params.id);
    if (!result) return res.status(404).json({ error: 'Purchase order not found' });
    await generatePDF(result.html, `PO-${result.po.po_number}.pdf`, req, res);
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Approve & send PO (or submit for admin approval if EDI vendor)
app.post('/api/rep/purchase-orders/:poId/approve', repAuth, async (req, res) => {
  try {
    const { poId } = req.params;
    const poCheck = await pool.query(`
      SELECT po.*, v.name as vendor_name, v.email as vendor_email, v.edi_config
      FROM purchase_orders po
      JOIN vendors v ON v.id = po.vendor_id
      WHERE po.id = $1
    `, [poId]);
    if (!poCheck.rows.length) return res.status(404).json({ error: 'Purchase order not found' });
    if (poCheck.rows[0].status !== 'draft') {
      return res.status(400).json({ error: 'Only draft POs can be approved' });
    }

    const po = poCheck.rows[0];
    const ediConfig = po.edi_config;
    const ediEnabled = ediConfig && ediConfig.enabled;
    const repName = req.rep.first_name + ' ' + req.rep.last_name;

    if (!ediEnabled && !po.vendor_email) {
      return res.status(400).json({ error: 'Vendor has no email configured and EDI is not enabled.' });
    }

    const newRevision = (po.revision || 0) + 1;
    const isRevised = newRevision > 1;

    const result = await pool.query(`
      UPDATE purchase_orders SET status = 'sent', revision = $1, is_revised = $2,
        approved_by = $3, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $4 RETURNING *
    `, [newRevision, isRevised, req.rep.id, poId]);

    let sentVia = 'email';
    let emailSent = false;
    let ediDetails = null;

    // EDI path: generate 850 and upload via SFTP or FTP
    if (ediEnabled) {
      let ediSuccess = false;
      try {
        const docs = await generate850(pool, poId, ediConfig);
        const transportType = (ediConfig.transport || 'sftp').toLowerCase();
        const inboxDir = ediConfig.inbox_dir || '/Inbox';

        if (transportType === 'ftp') {
          const ftpClient = await createFtpConnection({
            ftp_host: ediConfig.ftp_host,
            ftp_port: ediConfig.ftp_port || 21,
            ftp_user: ediConfig.ftp_user,
            ftp_pass: ediConfig.ftp_pass,
            ftp_secure: ediConfig.ftp_secure || false,
          });
          try {
            for (const doc of docs) {
              const txnResult = await pool.query(
                `INSERT INTO edi_transactions
                 (vendor_id, document_type, direction, filename, interchange_control_number, purchase_order_id, order_id, status, raw_content)
                 VALUES ($1, '850', 'outbound', $2, $3, $4, $5, 'pending', $6)
                 RETURNING id`,
                [po.vendor_id, doc.filename, doc.icn, poId, po.order_id, doc.content]
              );
              const txnId = txnResult.rows[0].id;
              await ftpUploadFile(ftpClient, `${inboxDir}/${doc.filename}`, doc.content);
              await pool.query(`UPDATE edi_transactions SET status = 'sent', processed_at = CURRENT_TIMESTAMP WHERE id = $1`, [txnId]);
              await pool.query(`UPDATE purchase_orders SET edi_interchange_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [poId, doc.icn]);
            }
            ediSuccess = true;
          } finally {
            ftpClient.close();
          }
        } else {
          const sftp = await createSftpConnection(ediConfig);
          try {
            for (const doc of docs) {
              const txnResult = await pool.query(
                `INSERT INTO edi_transactions
                 (vendor_id, document_type, direction, filename, interchange_control_number, purchase_order_id, order_id, status, raw_content)
                 VALUES ($1, '850', 'outbound', $2, $3, $4, $5, 'pending', $6)
                 RETURNING id`,
                [po.vendor_id, doc.filename, doc.icn, poId, po.order_id, doc.content]
              );
              const txnId = txnResult.rows[0].id;
              await uploadFile(sftp, `${inboxDir}/${doc.filename}`, doc.content);
              await pool.query(`UPDATE edi_transactions SET status = 'sent', processed_at = CURRENT_TIMESTAMP WHERE id = $1`, [txnId]);
              await pool.query(`UPDATE purchase_orders SET edi_interchange_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [poId, doc.icn]);
            }
            ediSuccess = true;
          } finally {
            try { await sftp.end(); } catch (_) {}
          }
        }

        if (ediSuccess) {
          sentVia = 'edi';
          ediDetails = { docs_sent: docs.length, filenames: docs.map(d => d.filename), transport: transportType };
          console.log(`[Rep PO Approve] EDI 850 sent via ${transportType} for ${po.po_number}: ${docs.map(d => d.filename).join(', ')}`);
        }
      } catch (ediErr) {
        console.error(`[Rep PO Approve] EDI failed for ${po.po_number}, falling back to email:`, ediErr.message);
        ediDetails = { edi_error: ediErr.message, fallback: 'email' };
      }

      if (ediSuccess) {
        const updatedPO = await pool.query('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
        const action = isRevised ? 'revised_and_sent' : 'edi_sent';
        await pool.query(
          `INSERT INTO po_activity_log (purchase_order_id, action, performer_name, revision, details)
           VALUES ($1, $2, $3, $4, $5)`,
          [poId, action, repName, newRevision, JSON.stringify({ ...ediDetails, approved_via: 'rep_portal' })]
        );

        // Notify assigned rep if different
        const poOrder = await pool.query('SELECT order_number, sales_rep_id FROM orders WHERE id = $1', [po.order_id]);
        if (poOrder.rows.length && poOrder.rows[0].sales_rep_id && poOrder.rows[0].sales_rep_id !== req.rep.id) {
          setImmediate(() => createRepNotification(pool, poOrder.rows[0].sales_rep_id, 'po_approved',
            `PO ${po.po_number} sent to ${po.vendor_name} via EDI`,
            `${repName} approved and sent PO for ${poOrder.rows[0].order_number}`,
            'order', po.order_id));
        }

        return res.json({ purchase_order: updatedPO.rows[0], sent_via: 'edi', edi: ediDetails });
      }

      // EDI failed — fall through to email
      if (!po.vendor_email) {
        return res.status(500).json({ error: 'EDI send failed and vendor has no email configured for fallback.' });
      }
    }

    // Email path (default or EDI fallback)
    if (po.vendor_email) {
      try {
        const poData = await generatePOHtml(pool, poId);
        if (poData) {
          const pdfBuffer = await generatePDFBuffer(poData.html);
          const result = await sendPurchaseOrderToVendor({
            vendor_email: po.vendor_email,
            vendor_name: po.vendor_name,
            po_number: po.po_number,
            is_revised: isRevised,
            pdf_buffer: pdfBuffer
          });
          emailSent = result.sent;
        }
      } catch (emailErr) {
        console.error('[Rep PO Approve] Email send failed:', emailErr.message);
      }
    }

    // Log activity
    const action = isRevised ? 'revised_and_sent' : 'sent';
    await pool.query(
      `INSERT INTO po_activity_log (purchase_order_id, action, performer_name, recipient_email, revision, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [poId, action, repName, po.vendor_email || null, newRevision,
       JSON.stringify({ email_sent: emailSent, approved_via: 'rep_portal', edi_fallback: ediDetails })]
    );

    // Notify assigned rep on the order if different from the one approving
    const poOrder = await pool.query('SELECT order_number, sales_rep_id FROM orders WHERE id = $1', [po.order_id]);
    if (poOrder.rows.length && poOrder.rows[0].sales_rep_id && poOrder.rows[0].sales_rep_id !== req.rep.id) {
      setImmediate(() => createRepNotification(pool, poOrder.rows[0].sales_rep_id, 'po_approved',
        `PO ${po.po_number} sent to ${po.vendor_name}`,
        `${repName} approved and sent PO for ${poOrder.rows[0].order_number}`,
        'order', po.order_id));
    }

    const updatedPO = await pool.query('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
    res.json({ purchase_order: updatedPO.rows[0], email_sent: emailSent, sent_via: sentVia });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ valid: false, error: 'Internal server error' });
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
    if (!phone || phone.replace(/\D/g, '').length !== 10) {
      return res.status(400).json({ error: 'A valid 10-digit phone number is required' });
    }

    const quoteNumber = await getNextQuoteNumber();

    await client.query('BEGIN');

    // Auto-create customer
    const nameParts = (customer_name || '').split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';
    const { customer: cust } = await findOrCreateCustomer(client, {
      email: customer_email, firstName, lastName,
      phone, repId: req.rep.id, createdVia: 'quote'
    });

    const quoteResult = await client.query(`
      INSERT INTO quotes (quote_number, sales_rep_id, customer_name, customer_email, phone,
        shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip, notes, delivery_method, customer_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `, [quoteNumber, req.rep.id, customer_name, customer_email.toLowerCase().trim(), phone || null,
        shipping_address_line1 || null, shipping_address_line2 || null,
        shipping_city || null, shipping_state || null, shipping_zip || null, notes || null,
        delivery_method || 'shipping', cust.id]);

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
    const quoteItems = await pool.query(`
      SELECT qi.*, v.name as vendor_name, s.vendor_sku, s.variant_name, sa_c.value as color, p.collection as current_collection
      FROM quote_items qi
      LEFT JOIN skus s ON s.id = qi.sku_id
      LEFT JOIN products p ON p.id = COALESCE(s.product_id, qi.product_id)
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = qi.sku_id
        AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
      WHERE qi.quote_id = $1
    `, [quote.id]);
    res.json({ quote: fullQuote.rows[0], items: quoteItems.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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

    const items = await pool.query(`
      SELECT qi.*, v.name as vendor_name, s.vendor_sku, s.variant_name, sa_c.value as color, p.collection as current_collection
      FROM quote_items qi
      LEFT JOIN skus s ON s.id = qi.sku_id
      LEFT JOIN products p ON p.id = COALESCE(s.product_id, qi.product_id)
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = qi.sku_id
        AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
      WHERE qi.quote_id = $1 ORDER BY qi.id
    `, [id]);
    res.json({ quote: quote.rows[0], items: items.rows });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/rep/quotes/:id', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { customer_name, customer_email, phone, shipping_address_line1, shipping_address_line2,
            shipping_city, shipping_state, shipping_zip, notes, shipping, delivery_method, promo_code } = req.body;

    if (phone !== undefined && (!phone || phone.replace(/\D/g, '').length !== 10)) {
      return res.status(400).json({ error: 'A valid 10-digit phone number is required' });
    }

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
        const itemsResult = await pool.query('SELECT qi.*, p.category_id FROM quote_items qi LEFT JOIN skus s ON s.id = qi.sku_id LEFT JOIN products p ON p.id = COALESCE(s.product_id, qi.product_id) WHERE qi.quote_id = $1', [id]);
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    const quoteItems = await pool.query(`
      SELECT qi.*, v.name as vendor_name, s.vendor_sku, s.variant_name, sa_c.value as color, p.collection as current_collection
      FROM quote_items qi
      LEFT JOIN skus s ON s.id = qi.sku_id
      LEFT JOIN products p ON p.id = COALESCE(s.product_id, qi.product_id)
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = qi.sku_id
        AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
      WHERE qi.quote_id = $1 ORDER BY qi.id
    `, [id]);

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

    // Auto-create deal in "quoted" stage if none exists for this quote
    try {
      const existingDeal = await pool.query('SELECT id FROM deals WHERE linked_quote_id = $1', [id]);
      if (!existingDeal.rows.length) {
        await pool.query(`
          INSERT INTO deals (rep_id, title, estimated_value, stage, customer_name, customer_email, linked_quote_id)
          VALUES ($1, $2, $3, 'quoted', $4, $5, $6)
        `, [req.rep.id, 'Quote ' + q.quote_number + ' — ' + q.customer_name,
            parseFloat(q.total || 0), q.customer_name, q.customer_email, id]);
      }
    } catch (dealErr) {
      console.error('Auto-deal creation failed (non-fatal):', dealErr.message);
    }

    // Auto-task: follow up on quote
    setImmediate(() => createAutoTask(pool, req.rep.id, 'quote_sent', id,
      `Follow up on Quote ${q.quote_number} — ${q.customer_name}`, {
        customer_name: q.customer_name, customer_email: q.customer_email, customer_phone: q.customer_phone,
        linked_quote_id: id
      }).catch(err => console.error('[AutoTask] quote_sent error:', err.message)));

    if (emailed) {
      res.json({ success: true, message: 'Quote emailed to ' + q.customer_email, emailed: true });
    } else {
      res.json({ success: true, message: 'Quote marked as sent (email not configured)', emailed: false });
    }
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/rep/quotes/:id/preview', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const quote = await pool.query('SELECT * FROM quotes WHERE id = $1', [id]);
    if (!quote.rows.length) return res.status(404).json({ error: 'Quote not found' });

    const q = quote.rows[0];
    const quoteItems = await pool.query(`
      SELECT qi.*, v.name as vendor_name, s.vendor_sku, s.variant_name, sa_c.value as color, p.collection as current_collection
      FROM quote_items qi
      LEFT JOIN skus s ON s.id = qi.sku_id
      LEFT JOIN products p ON p.id = COALESCE(s.product_id, qi.product_id)
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = qi.sku_id
        AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
      WHERE qi.quote_id = $1 ORDER BY qi.id
    `, [id]);

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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/rep/quotes/:id/convert', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { payment_method, check_number, stripe_payment_intent_id, document_ids } = req.body;
    if (!payment_method || !['cash', 'check', 'card', 'stripe', 'offline', 'ach'].includes(payment_method)) {
      return res.status(400).json({ error: 'payment_method must be cash, check, card, stripe, offline, or ach' });
    }
    if (payment_method === 'check' && !check_number) {
      return res.status(400).json({ error: 'check_number is required for check payments' });
    }
    if (payment_method === 'card' && !stripe_payment_intent_id) {
      return res.status(400).json({ error: 'Card payments require Stripe Terminal. Use the tap-to-pay flow.' });
    }
    if (payment_method === 'ach' && (!document_ids || document_ids.length < 2)) {
      return res.status(400).json({ error: 'ACH payments require customer ID and check photo uploads' });
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

    // Auto-create customer for quote conversion
    const nameParts = (q.customer_name || '').split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';
    const { customer: cust } = await findOrCreateCustomer(client, {
      email: q.customer_email, firstName, lastName,
      phone: q.phone, repId: req.rep.id, createdVia: 'quote_convert'
    });

    const orderNumber = await getNextOrderNumber();
    const paidInStore = ['cash', 'check', 'card', 'offline'].includes(payment_method);
    const orderStatus = paidInStore ? 'confirmed' : 'pending';

    let stripePaymentIntentId = null;
    if (payment_method === 'card' && stripe_payment_intent_id) {
      const pi = await stripe.paymentIntents.retrieve(stripe_payment_intent_id);
      if (pi.status !== 'succeeded') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Terminal payment not completed. Status: ' + pi.status });
      }
      stripePaymentIntentId = stripe_payment_intent_id;
    } else if (payment_method === 'ach' && stripe_payment_intent_id) {
      stripePaymentIntentId = stripe_payment_intent_id;
    } else if (payment_method === 'stripe') {
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
    const totalNum = parseFloat(quoteTotal);

    // Copy promo code from quote to order
    const quotePromoCodeId = q.promo_code_id || null;
    const quotePromoCode = q.promo_code || null;
    const quoteDiscount = parseFloat(q.discount_amount || 0);

    const orderResult = await client.query(`
      INSERT INTO orders (order_number, customer_email, customer_name, phone,
        shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip,
        subtotal, shipping, total, status, sales_rep_id, payment_method, quote_id, stripe_payment_intent_id, delivery_method,
        promo_code_id, promo_code, discount_amount, amount_paid, customer_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
      RETURNING *
    `, [orderNumber, q.customer_email, q.customer_name, q.phone,
        isPickupQuote ? null : (q.shipping_address_line1 || ''),
        isPickupQuote ? null : q.shipping_address_line2,
        isPickupQuote ? null : (q.shipping_city || ''),
        isPickupQuote ? null : (q.shipping_state || ''),
        isPickupQuote ? null : (q.shipping_zip || ''),
        q.subtotal, quoteShipping, quoteTotal, orderStatus, req.rep.id, payment_method, id, stripePaymentIntentId,
        q.delivery_method || 'shipping',
        quotePromoCodeId, quotePromoCode, quoteDiscount.toFixed(2),
        paidInStore ? totalNum.toFixed(2) : '0.00', cust.id]);

    const order = orderResult.rows[0];

    // Copy quote items to order items
    for (const item of itemsResult.rows) {
      await client.query(`
        INSERT INTO order_items (order_id, product_id, sku_id, product_name, collection, description, sqft_needed, num_boxes, unit_price, subtotal, sell_by, is_sample)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [order.id, item.product_id, item.sku_id, item.product_name, item.collection,
          item.description, item.sqft_needed, item.num_boxes, item.unit_price, item.subtotal, item.sell_by, item.is_sample]);
    }

    // Link uploaded documents to the order
    if (document_ids && document_ids.length > 0) {
      await client.query(
        'UPDATE order_documents SET order_id = $1 WHERE id = ANY($2) AND order_id IS NULL',
        [order.id, document_ids]
      );
    }

    // Record payment in ledger for in-store payments
    if (paidInStore) {
      const repFullName = req.rep.first_name + ' ' + req.rep.last_name;
      let payDesc = 'Offline payment (quote conversion)';
      if (payment_method === 'cash') payDesc = 'Cash payment (quote conversion)';
      else if (payment_method === 'check') payDesc = 'Check payment — #' + check_number + ' (quote conversion)';
      else if (payment_method === 'card') payDesc = 'In-store card payment (quote conversion)';

      const quotePayOpRes = await client.query(`
        INSERT INTO order_payments (order_id, payment_type, amount, description, initiated_by, initiated_by_name, status, check_number, payment_method)
        VALUES ($1, 'charge', $2, $3, $4, $5, 'completed', $6, $7) RETURNING id
      `, [order.id, totalNum.toFixed(2), payDesc, req.rep.id, repFullName, check_number || null, payment_method]);
      await syncOrderPaymentToInvoice(quotePayOpRes.rows[0].id, order.id, client);

      // Record cash drawer transaction for cash payments
      if (payment_method === 'cash') {
        const drawerResult = await client.query(
          "SELECT id FROM cash_drawers WHERE rep_id = $1 AND status = 'open' ORDER BY opened_at DESC LIMIT 1",
          [req.rep.id]
        );
        if (drawerResult.rows.length) {
          const drawerId = drawerResult.rows[0].id;
          await client.query(
            'INSERT INTO cash_drawer_transactions (drawer_id, order_id, type, amount, description) VALUES ($1, $2, $3, $4, $5)',
            [drawerId, order.id, 'sale', totalNum, 'Cash sale — ' + orderNumber]
          );
          await client.query(
            'UPDATE cash_drawers SET expected_balance = expected_balance + $1 WHERE id = $2',
            [totalNum, drawerId]
          );
        }
      }
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

    // Move linked deal to "won" stage + link the new order
    try {
      const dealResult = await client.query('SELECT id FROM deals WHERE linked_quote_id = $1 AND rep_id = $2', [id, req.rep.id]);
      if (dealResult.rows.length) {
        await client.query(`
          UPDATE deals SET stage = 'won', stage_entered_at = CURRENT_TIMESTAMP,
            linked_order_id = $1, estimated_value = $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $3
        `, [order.id, parseFloat(quoteTotal), dealResult.rows[0].id]);
      }
    } catch (dealErr) {
      console.error('Deal stage update failed (non-fatal):', dealErr.message);
    }

    // Generate purchase orders if order is confirmed
    if (orderStatus === 'confirmed') {
      await generatePurchaseOrders(order.id, client);
    }

    await client.query('COMMIT');

    const orderItems = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
    res.json({ order: { ...order, items: orderItems.rows } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ==================== Rep Estimate Endpoints ====================

// Shared helper: recalculate estimate totals
async function recalculateEstimateTotals(estimateId, client) {
  const matResult = await client.query(
    "SELECT COALESCE(SUM(subtotal), 0) as total FROM estimate_items WHERE estimate_id = $1 AND item_type = 'material'",
    [estimateId]
  );
  const laborResult = await client.query(
    "SELECT COALESCE(SUM(subtotal), 0) as total FROM estimate_items WHERE estimate_id = $1 AND item_type = 'labor'",
    [estimateId]
  );
  const materialsSubtotal = parseFloat(parseFloat(matResult.rows[0].total).toFixed(2));
  const laborSubtotal = parseFloat(parseFloat(laborResult.rows[0].total).toFixed(2));
  const sub = parseFloat((materialsSubtotal + laborSubtotal).toFixed(2));

  // Tax on materials only
  const est = await client.query('SELECT project_zip FROM estimates WHERE id = $1', [estimateId]);
  const zip = est.rows[0] ? est.rows[0].project_zip : null;
  const tax = calculateSalesTax(materialsSubtotal, zip);
  const total = parseFloat((sub + tax.amount).toFixed(2));

  await client.query(
    `UPDATE estimates SET materials_subtotal = $1, labor_subtotal = $2, subtotal = $3,
     tax_rate = $4, tax_amount = $5, total = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $7`,
    [materialsSubtotal.toFixed(2), laborSubtotal.toFixed(2), sub.toFixed(2),
     tax.rate, tax.amount.toFixed(2), total.toFixed(2), estimateId]
  );
  return { materials_subtotal: materialsSubtotal, labor_subtotal: laborSubtotal, subtotal: sub, tax_rate: tax.rate, tax_amount: tax.amount, total };
}

// GET /api/rep/estimates — List estimates
app.get('/api/rep/estimates', repAuth, async (req, res) => {
  try {
    const { status, search } = req.query;
    let query = `
      SELECT e.*,
        sr.first_name || ' ' || sr.last_name as rep_name,
        (SELECT COUNT(*)::int FROM estimate_items ei WHERE ei.estimate_id = e.id) as item_count,
        (SELECT COUNT(*)::int FROM estimate_items ei WHERE ei.estimate_id = e.id AND ei.item_type = 'material') as material_count,
        (SELECT COUNT(*)::int FROM estimate_items ei WHERE ei.estimate_id = e.id AND ei.item_type = 'labor') as labor_count
      FROM estimates e
      LEFT JOIN sales_reps sr ON sr.id = e.sales_rep_id
      WHERE e.sales_rep_id = $1
    `;
    const params = [req.rep.id];
    let idx = 2;

    if (status) {
      query += ` AND e.status = $${idx}`;
      params.push(status);
      idx++;
    }
    if (search) {
      query += ` AND (e.customer_name ILIKE $${idx} OR e.customer_email ILIKE $${idx} OR e.estimate_number ILIKE $${idx} OR e.project_name ILIKE $${idx})`;
      params.push('%' + search + '%');
      idx++;
    }

    query += ' ORDER BY e.created_at DESC';
    const result = await pool.query(query, params);
    res.json({ estimates: result.rows });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/rep/estimates — Create estimate
app.post('/api/rep/estimates', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { customer_name, customer_email, phone, project_name,
            project_address_line1, project_address_line2,
            project_city, project_state, project_zip,
            notes, internal_notes } = req.body;
    if (!customer_name || !customer_email) {
      return res.status(400).json({ error: 'Customer name and email are required' });
    }

    const estimateNumber = await getNextEstimateNumber();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await client.query('BEGIN');

    // Auto-create customer
    const nameParts = (customer_name || '').split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';
    const { customer: cust } = await findOrCreateCustomer(client, {
      email: customer_email, firstName, lastName,
      phone, repId: req.rep.id, createdVia: 'estimate'
    });

    const result = await client.query(`
      INSERT INTO estimates (estimate_number, sales_rep_id, customer_id, customer_name, customer_email, phone,
        project_name, project_address_line1, project_address_line2, project_city, project_state, project_zip,
        notes, internal_notes, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *
    `, [estimateNumber, req.rep.id, cust.id, customer_name, customer_email.toLowerCase().trim(), phone || null,
        project_name || null,
        project_address_line1 || null, project_address_line2 || null,
        project_city || null, project_state || null, project_zip || null,
        notes || null, internal_notes || null, expiresAt]);

    await client.query('COMMIT');
    res.json({ estimate: result.rows[0], items: [] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// GET /api/rep/estimates/:id — Get estimate with items
app.get('/api/rep/estimates/:id', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const estimate = await pool.query(`
      SELECT e.*, sr.first_name || ' ' || sr.last_name as rep_name
      FROM estimates e LEFT JOIN sales_reps sr ON sr.id = e.sales_rep_id
      WHERE e.id = $1
    `, [id]);
    if (!estimate.rows.length) return res.status(404).json({ error: 'Estimate not found' });

    const items = await pool.query(`
      SELECT ei.*, v.name as vendor_name, s.vendor_sku, s.variant_name, sa_c.value as color,
        p.collection as current_collection
      FROM estimate_items ei
      LEFT JOIN skus s ON s.id = ei.sku_id
      LEFT JOIN products p ON p.id = COALESCE(s.product_id, ei.product_id)
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = ei.sku_id
        AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
      WHERE ei.estimate_id = $1 ORDER BY ei.sort_order, ei.created_at
    `, [id]);
    res.json({ estimate: estimate.rows[0], items: items.rows });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/rep/estimates/:id — Update estimate header
app.put('/api/rep/estimates/:id', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { customer_name, customer_email, phone, project_name,
            project_address_line1, project_address_line2,
            project_city, project_state, project_zip,
            notes, internal_notes, tax_rate } = req.body;

    // Check status
    const existing = await client.query('SELECT status FROM estimates WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Estimate not found' });
    if (!['draft', 'sent'].includes(existing.rows[0].status)) {
      return res.status(400).json({ error: 'Estimate cannot be edited in current status' });
    }

    await client.query('BEGIN');

    const result = await client.query(`
      UPDATE estimates SET
        customer_name = COALESCE($1, customer_name),
        customer_email = COALESCE($2, customer_email),
        phone = COALESCE($3, phone),
        project_name = COALESCE($4, project_name),
        project_address_line1 = COALESCE($5, project_address_line1),
        project_address_line2 = COALESCE($6, project_address_line2),
        project_city = COALESCE($7, project_city),
        project_state = COALESCE($8, project_state),
        project_zip = COALESCE($9, project_zip),
        notes = COALESCE($10, notes),
        internal_notes = COALESCE($11, internal_notes),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $12
      RETURNING *
    `, [customer_name, customer_email, phone, project_name,
        project_address_line1, project_address_line2,
        project_city, project_state, project_zip,
        notes, internal_notes, id]);

    // Recalculate totals (in case zip changed, affecting tax)
    await recalculateEstimateTotals(id, client);
    await client.query('COMMIT');

    const updated = await pool.query('SELECT * FROM estimates WHERE id = $1', [id]);
    res.json({ estimate: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// DELETE /api/rep/estimates/:id — Delete estimate (draft only)
app.delete('/api/rep/estimates/:id', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await pool.query('SELECT status FROM estimates WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Estimate not found' });
    if (existing.rows[0].status !== 'draft') {
      return res.status(400).json({ error: 'Only draft estimates can be deleted' });
    }
    await pool.query('DELETE FROM estimates WHERE id = $1', [id]);
    res.json({ deleted: id });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/rep/estimates/:id/items — Add item
app.post('/api/rep/estimates/:id/items', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { item_type, product_id, sku_id, product_name, collection, description,
            sqft_needed, num_boxes, sell_by,
            labor_category, rate_type, rate_sqft, labor_sqft,
            unit_price, quantity, subtotal, sort_order } = req.body;

    await client.query('BEGIN');

    const itemResult = await client.query(`
      INSERT INTO estimate_items (estimate_id, item_type, product_id, sku_id, product_name, collection, description,
        sqft_needed, num_boxes, sell_by, labor_category, rate_type, rate_sqft, labor_sqft,
        unit_price, quantity, subtotal, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *
    `, [id, item_type || 'material', product_id || null, sku_id || null,
        product_name || null, collection || null, description || null,
        sqft_needed || null, num_boxes || null, sell_by || null,
        labor_category || null, rate_type || null, rate_sqft || null, labor_sqft || null,
        parseFloat(unit_price || 0).toFixed(2), quantity || 1,
        parseFloat(subtotal || 0).toFixed(2), sort_order || 0]);

    await recalculateEstimateTotals(id, client);
    await client.query('COMMIT');

    const updated = await pool.query('SELECT * FROM estimates WHERE id = $1', [id]);
    res.json({ item: itemResult.rows[0], estimate: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// PUT /api/rep/estimates/:id/items/:itemId — Update item
app.put('/api/rep/estimates/:id/items/:itemId', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id, itemId } = req.params;
    const { product_name, collection, description, sqft_needed, num_boxes, sell_by,
            labor_category, rate_type, rate_sqft, labor_sqft,
            unit_price, quantity, subtotal, sort_order } = req.body;

    await client.query('BEGIN');

    const result = await client.query(`
      UPDATE estimate_items SET
        product_name = COALESCE($1, product_name),
        collection = COALESCE($2, collection),
        description = COALESCE($3, description),
        sqft_needed = COALESCE($4, sqft_needed),
        num_boxes = COALESCE($5, num_boxes),
        sell_by = COALESCE($6, sell_by),
        labor_category = COALESCE($7, labor_category),
        rate_type = COALESCE($8, rate_type),
        rate_sqft = COALESCE($9, rate_sqft),
        labor_sqft = COALESCE($10, labor_sqft),
        unit_price = COALESCE($11, unit_price),
        quantity = COALESCE($12, quantity),
        subtotal = COALESCE($13, subtotal),
        sort_order = COALESCE($14, sort_order)
      WHERE id = $15 AND estimate_id = $16
      RETURNING *
    `, [product_name, collection, description, sqft_needed, num_boxes, sell_by,
        labor_category, rate_type, rate_sqft, labor_sqft,
        unit_price, quantity, subtotal, sort_order,
        itemId, id]);

    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Estimate item not found' });
    }

    await recalculateEstimateTotals(id, client);
    await client.query('COMMIT');

    const updated = await pool.query('SELECT * FROM estimates WHERE id = $1', [id]);
    res.json({ item: result.rows[0], estimate: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// DELETE /api/rep/estimates/:id/items/:itemId — Remove item
app.delete('/api/rep/estimates/:id/items/:itemId', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id, itemId } = req.params;

    await client.query('BEGIN');

    const result = await client.query(
      'DELETE FROM estimate_items WHERE id = $1 AND estimate_id = $2 RETURNING id', [itemId, id]
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Estimate item not found' });
    }

    await recalculateEstimateTotals(id, client);
    await client.query('COMMIT');

    const updated = await pool.query('SELECT * FROM estimates WHERE id = $1', [id]);
    res.json({ deleted: itemId, estimate: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// GET /api/rep/estimates/:id/pdf — Branded PDF
app.get('/api/rep/estimates/:id/pdf', (req, res, next) => {
  if (!req.headers['x-rep-token'] && req.query.token) {
    req.headers['x-rep-token'] = req.query.token;
  }
  next();
}, repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const estimate = await pool.query('SELECT * FROM estimates WHERE id = $1', [id]);
    if (!estimate.rows.length) return res.status(404).json({ error: 'Estimate not found' });
    const e = estimate.rows[0];

    const items = await pool.query(`
      SELECT ei.*, sk.variant_name, sa_c.value as color,
        v.name as vendor_name, sk.vendor_sku, p.collection as current_collection
      FROM estimate_items ei
      LEFT JOIN skus sk ON sk.id = ei.sku_id
      LEFT JOIN products p ON p.id = COALESCE(sk.product_id, ei.product_id)
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = ei.sku_id
        AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
      WHERE ei.estimate_id = $1 ORDER BY ei.sort_order, ei.created_at
    `, [id]);
    const materialItems = items.rows.filter(i => i.item_type === 'material');
    const laborItems = items.rows.filter(i => i.item_type === 'labor');

    const laborCategoryLabels = {
      installation: 'Installation', tearout: 'Tearout', underlayment: 'Underlayment',
      transitions: 'Transitions', baseboards: 'Baseboards', floor_leveling: 'Floor Leveling',
      moisture_barrier: 'Moisture Barrier', furniture_moving: 'Furniture Moving', other: 'Other'
    };

    const isExpired = e.expires_at && new Date(e.expires_at) < new Date();
    const expiryStr = e.expires_at ? new Date(e.expires_at).toLocaleDateString() : 'N/A';

    const materialRowsHtml = materialItems.map((i, idx) => {
      const isUnit = i.sell_by === 'unit';
      const qty = i.num_boxes || i.quantity || 1;
      return `<tr>
      <td>${idx + 1}</td>
      <td>${itemDescriptionCell(i.collection, i.color, i.variant_name)}</td>
      <td style="text-align:right">${isUnit ? '—' : (i.sqft_needed ? parseFloat(i.sqft_needed).toFixed(0) + ' sqft' : '—')}</td>
      <td style="text-align:right">${qty}${isUnit ? '' : ' box' + (qty > 1 ? 'es' : '')}</td>
      <td style="text-align:right">$${parseFloat(i.unit_price || 0).toFixed(2)}${isUnit ? '/ea' : '/sqft'}</td>
      <td style="text-align:right">$${parseFloat(i.subtotal || 0).toFixed(2)}</td>
    </tr>`; }).join('');

    const laborRowsHtml = laborItems.map((i, idx) => {
      const rateDisplay = i.rate_type === 'per_sqft'
        ? `$${parseFloat(i.rate_sqft || 0).toFixed(2)}/sqft`
        : 'Flat';
      const areaQty = i.rate_type === 'per_sqft'
        ? `${parseFloat(i.labor_sqft || 0).toFixed(0)} sqft`
        : (parseFloat(i.quantity || 1) > 1 ? parseFloat(i.quantity).toFixed(0) : '-');
      return `<tr>
        <td>${idx + 1}</td>
        <td>${laborCategoryLabels[i.labor_category] || i.labor_category || ''}</td>
        <td>${i.description ? i.description.split('\n').map((line, idx) => idx === 0 ? line : '&bull; ' + line).join('<br/>') : ''}</td>
        <td style="text-align:right">${rateDisplay}</td>
        <td style="text-align:right">${areaQty}</td>
        <td style="text-align:right">$${parseFloat(i.subtotal || 0).toFixed(2)}</td>
      </tr>`;
    }).join('');

    const termsHtml = `${parseFloat(e.tax_amount || 0) > 0 ? '<p>* Sales tax applies to materials only. Labor and services are not taxed.</p>' : ''}
      <p>Valid for 30 days from the date of issue. Labor rates may vary based on site conditions.</p>`;

    const html = `<!DOCTYPE html><html><head><style>${getDocumentBaseCSS()}</style></head><body>
      <div class="page">
        ${getDocumentHeader('Estimate')}
        <div class="doc-banner">
          <div class="doc-banner-left">
            <div class="meta-group"><p class="meta-label">Estimate</p><p class="meta-value">${e.estimate_number}</p></div>
            <div class="meta-group"><p class="meta-label">Date</p><p class="meta-value-sm">${new Date(e.created_at).toLocaleDateString()}</p></div>
            <div class="meta-group"><p class="meta-label">Valid Until</p><p class="meta-value-sm">${expiryStr}</p></div>
          </div>
          <div>${isExpired ? '<span class="badge badge-expired">Expired</span>' : '<span class="badge badge-valid">Valid</span>'}</div>
        </div>
        <div class="info-row">
          <div class="info-card">
            <h3>Prepared For</h3>
            <p><strong>${e.customer_name || ''}</strong><br/>
            ${e.customer_email || ''}${e.phone ? '<br/>' + e.phone : ''}</p>
          </div>
          <div class="info-card">
            <h3>Project Location</h3>
            <p>${e.project_name ? '<strong>' + e.project_name + '</strong><br/>' : ''}
            ${e.project_address_line1 || ''}${e.project_address_line2 ? '<br/>' + e.project_address_line2 : ''}
            ${e.project_city ? '<br/>' + e.project_city + ', ' + (e.project_state || '') + ' ' + (e.project_zip || '') : ''}</p>
          </div>
        </div>

        ${materialItems.length > 0 ? `
        <div class="section-title">Materials</div>
        <table>
          <thead><tr><th>#</th><th>Description</th><th class="text-right">Area</th><th class="text-right">Qty</th><th class="text-right">Unit Price</th><th class="text-right">Subtotal</th></tr></thead>
          <tbody>${materialRowsHtml}</tbody>
        </table>
        ` : ''}

        ${laborItems.length > 0 ? `
        <div class="section-title">Labor &amp; Services</div>
        <table>
          <thead><tr><th>#</th><th>Service</th><th>Description</th><th class="text-right">Rate</th><th class="text-right">Area/Qty</th><th class="text-right">Subtotal</th></tr></thead>
          <tbody>${laborRowsHtml}</tbody>
        </table>
        ` : ''}

        <div class="totals-wrapper"><div class="totals-box">
          <div class="totals-line"><span>Materials Subtotal</span><span>$${parseFloat(e.materials_subtotal || 0).toFixed(2)}</span></div>
          <div class="totals-line"><span>Labor &amp; Services</span><span>$${parseFloat(e.labor_subtotal || 0).toFixed(2)}</span></div>
          ${parseFloat(e.tax_amount || 0) > 0 ? `<div class="totals-line"><span>Tax (materials only)*</span><span>$${parseFloat(e.tax_amount).toFixed(2)}</span></div>` : ''}
          <div class="totals-line grand-total"><span>Grand Total</span><span>$${parseFloat(e.total || 0).toFixed(2)}</span></div>
        </div></div>

        ${e.notes ? `<div class="notes-block"><h4>Notes</h4><p style="margin:0;white-space:pre-wrap;">${e.notes}</p></div>` : ''}

        ${getDocumentFooter(termsHtml)}
      </div>
    </body></html>`;

    await generatePDF(html, `estimate-${e.estimate_number}.pdf`, req, res);
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/rep/estimates/:id/preview — Email preview HTML
app.get('/api/rep/estimates/:id/preview', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const estimate = await pool.query('SELECT * FROM estimates WHERE id = $1', [id]);
    if (!estimate.rows.length) return res.status(404).json({ error: 'Estimate not found' });
    const e = estimate.rows[0];

    const items = await pool.query(`
      SELECT ei.*, v.name as vendor_name, s.vendor_sku, s.variant_name, sa_c.value as color,
        p.collection as current_collection
      FROM estimate_items ei
      LEFT JOIN skus s ON s.id = ei.sku_id
      LEFT JOIN products p ON p.id = COALESCE(s.product_id, ei.product_id)
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = ei.sku_id
        AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
      WHERE ei.estimate_id = $1 ORDER BY ei.sort_order, ei.created_at
    `, [id]);
    const materialItems = items.rows.filter(i => i.item_type === 'material');
    const laborItems = items.rows.filter(i => i.item_type === 'labor');

    const emailData = {
      ...e,
      materialItems,
      laborItems,
      rep_first_name: req.rep.first_name,
      rep_last_name: req.rep.last_name,
      rep_email: req.rep.email
    };

    const html = generateEstimateSentHTML(emailData);
    res.json({
      html,
      subject: `Your Construction Estimate — ${e.estimate_number}`,
      to: e.customer_email,
      reply_to: req.rep.email
    });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/rep/estimates/:id/send — Send estimate to customer
app.post('/api/rep/estimates/:id/send', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const estimate = await pool.query('SELECT * FROM estimates WHERE id = $1', [id]);
    if (!estimate.rows.length) return res.status(404).json({ error: 'Estimate not found' });
    const e = estimate.rows[0];

    if (e.status !== 'draft' && e.status !== 'sent') {
      return res.status(400).json({ error: 'Estimate cannot be sent in current status' });
    }

    await pool.query(
      "UPDATE estimates SET status = 'sent', sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [id]
    );

    const items = await pool.query(`
      SELECT ei.*, v.name as vendor_name, s.vendor_sku, s.variant_name, sa_c.value as color,
        p.collection as current_collection
      FROM estimate_items ei
      LEFT JOIN skus s ON s.id = ei.sku_id
      LEFT JOIN products p ON p.id = COALESCE(s.product_id, ei.product_id)
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = ei.sku_id
        AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
      WHERE ei.estimate_id = $1 ORDER BY ei.sort_order, ei.created_at
    `, [id]);
    const materialItems = items.rows.filter(i => i.item_type === 'material');
    const laborItems = items.rows.filter(i => i.item_type === 'labor');

    const emailData = {
      ...e,
      materialItems,
      laborItems,
      rep_first_name: req.rep.first_name,
      rep_last_name: req.rep.last_name,
      rep_email: req.rep.email
    };
    const emailResult = await sendEstimateSent(emailData);
    const emailed = emailResult && emailResult.sent;

    // Auto-task: follow up on estimate
    setImmediate(() => createAutoTask(pool, req.rep.id, 'estimate_sent', id,
      `Follow up on Estimate ${e.estimate_number} — ${e.customer_name}`, {
        customer_name: e.customer_name, customer_email: e.customer_email, customer_phone: e.customer_phone,
        linked_estimate_id: id
      }).catch(err => console.error('[AutoTask] estimate_sent error:', err.message)));

    if (emailed) {
      res.json({ success: true, message: 'Estimate emailed to ' + e.customer_email, emailed: true });
    } else {
      res.json({ success: true, message: 'Estimate marked as sent (email not configured)', emailed: false });
    }
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/rep/estimates/:id/convert-to-quote — Convert to quote (materials only)
app.post('/api/rep/estimates/:id/convert-to-quote', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const estResult = await client.query('SELECT * FROM estimates WHERE id = $1', [id]);
    if (!estResult.rows.length) return res.status(404).json({ error: 'Estimate not found' });
    const e = estResult.rows[0];

    if (e.status === 'converted') {
      return res.status(400).json({ error: 'Estimate already converted' });
    }

    const itemsResult = await client.query(
      "SELECT * FROM estimate_items WHERE estimate_id = $1 ORDER BY sort_order, created_at", [id]
    );
    const materialItems = itemsResult.rows.filter(i => i.item_type === 'material');
    const laborItems = itemsResult.rows.filter(i => i.item_type === 'labor');

    if (materialItems.length === 0) {
      return res.status(400).json({ error: 'Estimate has no material items to convert' });
    }

    await client.query('BEGIN');

    const quoteNumber = await getNextQuoteNumber();

    // Build labor note
    const laborCategoryLabels = {
      installation: 'Installation', tearout: 'Tearout', underlayment: 'Underlayment',
      transitions: 'Transitions', baseboards: 'Baseboards', floor_leveling: 'Floor Leveling',
      moisture_barrier: 'Moisture Barrier', furniture_moving: 'Furniture Moving', other: 'Other'
    };
    let laborNote = '';
    if (laborItems.length > 0) {
      const laborTotal = parseFloat(e.labor_subtotal || 0);
      const laborDetails = laborItems.map(i =>
        `${laborCategoryLabels[i.labor_category] || i.labor_category} ($${parseFloat(i.subtotal || 0).toFixed(2)})`
      ).join(', ');
      laborNote = `\nConverted from Estimate ${e.estimate_number}. Labor/services totaling $${laborTotal.toFixed(2)} excluded: ${laborDetails}.`;
    } else {
      laborNote = `\nConverted from Estimate ${e.estimate_number}.`;
    }

    // Auto-create customer
    const nameParts = (e.customer_name || '').split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';
    const { customer: cust } = await findOrCreateCustomer(client, {
      email: e.customer_email, firstName, lastName,
      phone: e.phone, repId: req.rep.id, createdVia: 'estimate_convert'
    });

    // Create quote — project address becomes shipping address
    const quoteNotes = (e.notes || '') + laborNote;
    const quoteResult = await client.query(`
      INSERT INTO quotes (quote_number, sales_rep_id, customer_name, customer_email, phone,
        shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip,
        notes, customer_id, delivery_method)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'shipping')
      RETURNING *
    `, [quoteNumber, req.rep.id, e.customer_name, e.customer_email, e.phone,
        e.project_address_line1 || null, e.project_address_line2 || null,
        e.project_city || null, e.project_state || null, e.project_zip || null,
        quoteNotes, cust.id]);

    const quote = quoteResult.rows[0];

    // Copy material items to quote items
    for (const item of materialItems) {
      await client.query(`
        INSERT INTO quote_items (quote_id, product_id, sku_id, product_name, collection, description,
          sqft_needed, num_boxes, unit_price, subtotal, sell_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [quote.id, item.product_id, item.sku_id, item.product_name, item.collection,
          item.description, item.sqft_needed, item.num_boxes || item.quantity || 1,
          item.unit_price, item.subtotal, item.sell_by]);
    }

    // Recalculate quote totals
    const totals = await client.query(
      'SELECT COALESCE(SUM(subtotal), 0) as sub FROM quote_items WHERE quote_id = $1', [quote.id]
    );
    const quoteSubtotal = parseFloat(parseFloat(totals.rows[0].sub).toFixed(2));
    await client.query(
      'UPDATE quotes SET subtotal = $1, total = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [quoteSubtotal.toFixed(2), quoteSubtotal.toFixed(2), quote.id]
    );

    // Update estimate status
    await client.query(
      "UPDATE estimates SET status = 'converted', converted_quote_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      [quote.id, id]
    );

    await client.query('COMMIT');

    const quoteItems = await pool.query(`
      SELECT qi.*, v.name as vendor_name, s.vendor_sku, s.variant_name, sa_c.value as color, p.collection as current_collection
      FROM quote_items qi
      LEFT JOIN skus s ON s.id = qi.sku_id
      LEFT JOIN products p ON p.id = COALESCE(s.product_id, qi.product_id)
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = qi.sku_id
        AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
      WHERE qi.quote_id = $1
    `, [quote.id]);
    res.json({ quote: { ...quote, subtotal: quoteSubtotal.toFixed(2), total: quoteSubtotal.toFixed(2) }, items: quoteItems.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /api/rep/estimates/:id/convert-to-order — Convert to order (materials only)
app.post('/api/rep/estimates/:id/convert-to-order', repAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { payment_method } = req.body;

    if (!payment_method || !['cash', 'check', 'card', 'stripe', 'offline', 'ach'].includes(payment_method)) {
      return res.status(400).json({ error: 'payment_method must be cash, check, card, stripe, offline, or ach' });
    }

    const estResult = await client.query('SELECT * FROM estimates WHERE id = $1', [id]);
    if (!estResult.rows.length) return res.status(404).json({ error: 'Estimate not found' });
    const e = estResult.rows[0];

    if (e.status === 'converted') {
      return res.status(400).json({ error: 'Estimate already converted' });
    }

    const itemsResult = await client.query(
      "SELECT * FROM estimate_items WHERE estimate_id = $1 ORDER BY sort_order, created_at", [id]
    );
    const materialItems = itemsResult.rows.filter(i => i.item_type === 'material');
    const laborItems = itemsResult.rows.filter(i => i.item_type === 'labor');

    if (materialItems.length === 0) {
      return res.status(400).json({ error: 'Estimate has no material items to convert' });
    }

    await client.query('BEGIN');

    // Build labor note
    const laborCategoryLabels = {
      installation: 'Installation', tearout: 'Tearout', underlayment: 'Underlayment',
      transitions: 'Transitions', baseboards: 'Baseboards', floor_leveling: 'Floor Leveling',
      moisture_barrier: 'Moisture Barrier', furniture_moving: 'Furniture Moving', other: 'Other'
    };
    let laborNote = '';
    if (laborItems.length > 0) {
      const laborTotal = parseFloat(e.labor_subtotal || 0);
      const laborDetails = laborItems.map(i =>
        `${laborCategoryLabels[i.labor_category] || i.labor_category} ($${parseFloat(i.subtotal || 0).toFixed(2)})`
      ).join(', ');
      laborNote = `Converted from Estimate ${e.estimate_number}. Labor/services totaling $${laborTotal.toFixed(2)} excluded: ${laborDetails}.`;
    } else {
      laborNote = `Converted from Estimate ${e.estimate_number}.`;
    }

    // Auto-create customer
    const nameParts = (e.customer_name || '').split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';
    const { customer: cust } = await findOrCreateCustomer(client, {
      email: e.customer_email, firstName, lastName,
      phone: e.phone, repId: req.rep.id, createdVia: 'estimate_convert'
    });

    const orderNumber = await getNextOrderNumber();
    const paidInStore = ['cash', 'check', 'card', 'offline'].includes(payment_method);
    const orderStatus = paidInStore ? 'confirmed' : 'pending';

    // Calculate materials-only subtotal and tax
    const matSubtotal = parseFloat(e.materials_subtotal || 0);
    const tax = calculateSalesTax(matSubtotal, e.project_zip);
    const orderTotal = parseFloat((matSubtotal + tax.amount).toFixed(2));

    const orderResult = await client.query(`
      INSERT INTO orders (order_number, customer_email, customer_name, phone,
        shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip,
        subtotal, total, status, sales_rep_id, payment_method, customer_id, notes,
        tax_rate, tax_amount, delivery_method,
        amount_paid)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'shipping', $19)
      RETURNING *
    `, [orderNumber, e.customer_email, e.customer_name, e.phone,
        e.project_address_line1 || '', e.project_address_line2 || null,
        e.project_city || '', e.project_state || '', e.project_zip || '',
        matSubtotal.toFixed(2), orderTotal.toFixed(2), orderStatus, req.rep.id, payment_method, cust.id,
        laborNote, tax.rate, tax.amount.toFixed(2),
        paidInStore ? orderTotal.toFixed(2) : '0.00']);

    const order = orderResult.rows[0];

    // Copy material items to order items
    for (const item of materialItems) {
      await client.query(`
        INSERT INTO order_items (order_id, product_id, sku_id, product_name, collection, description,
          sqft_needed, num_boxes, unit_price, subtotal, sell_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [order.id, item.product_id, item.sku_id, item.product_name, item.collection,
          item.description, item.sqft_needed, item.num_boxes || item.quantity || 1,
          item.unit_price, item.subtotal, item.sell_by]);
    }

    // Record payment for in-store
    if (paidInStore) {
      const repFullName = req.rep.first_name + ' ' + req.rep.last_name;
      let payDesc = `${payment_method.charAt(0).toUpperCase() + payment_method.slice(1)} payment (estimate conversion)`;
      await client.query(`
        INSERT INTO order_payments (order_id, payment_type, amount, description, initiated_by, initiated_by_name, status, payment_method)
        VALUES ($1, 'charge', $2, $3, $4, $5, 'completed', $6)
      `, [order.id, orderTotal.toFixed(2), payDesc, req.rep.id, repFullName, payment_method]);
    }

    // Update estimate status
    await client.query(
      "UPDATE estimates SET status = 'converted', converted_order_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      [order.id, id]
    );

    // Generate purchase orders if order is confirmed
    if (orderStatus === 'confirmed') {
      await generatePurchaseOrders(order.id, client);
    }

    await client.query('COMMIT');

    const orderItems = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
    res.json({ order: { ...order, items: orderItems.rows } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ==================== Rep Customer Endpoints ====================

// GET /api/rep/customers/search?q=<term> — fast typeahead for order creation
app.get('/api/rep/customers/search', repAuth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json({ results: [] });
    const trimmed = q.toLowerCase().trim();
    const term = '%' + trimmed + '%';
    // Strip non-digits for phone matching
    const digits = trimmed.replace(/\D/g, '');
    const phoneTerm = digits.length >= 3 ? '%' + digits + '%' : null;

    const retail = await pool.query(`
      SELECT c.id, COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '') as name,
        c.email, c.phone,
        c.address_line1, c.address_line2, c.city, c.state, c.zip,
        'retail' as type
      FROM customers c
      WHERE LOWER(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) LIKE $1
        OR LOWER(c.email) LIKE $1
        OR ($2::text IS NOT NULL AND regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') LIKE $2)
      ORDER BY c.updated_at DESC NULLS LAST
      LIMIT 10
    `, [term, phoneTerm]);

    const trade = await pool.query(`
      SELECT tc.id, tc.contact_name as name, tc.email, tc.phone,
        NULL as address_line1, NULL as address_line2,
        NULL as city, NULL as state, NULL as zip,
        'trade' as type, tc.company_name
      FROM trade_customers tc
      WHERE LOWER(COALESCE(tc.contact_name, '')) LIKE $1
        OR LOWER(tc.email) LIKE $1
        OR ($2::text IS NOT NULL AND regexp_replace(COALESCE(tc.phone, ''), '[^0-9]', '', 'g') LIKE $2)
        OR LOWER(COALESCE(tc.company_name, '')) LIKE $1
      ORDER BY tc.updated_at DESC NULLS LAST
      LIMIT 5
    `, [term, phoneTerm]);

    // Also search past order customers (deduplicated by email)
    const guests = await pool.query(`
      SELECT DISTINCT ON (o.customer_email)
        NULL as id, o.customer_name as name, o.customer_email as email, o.phone,
        o.shipping_address_line1 as address_line1, o.shipping_address_line2 as address_line2,
        o.shipping_city as city, o.shipping_state as state, o.shipping_zip as zip,
        'order' as type
      FROM orders o
      WHERE (LOWER(COALESCE(o.customer_name, '')) LIKE $1
        OR LOWER(o.customer_email) LIKE $1
        OR ($2::text IS NOT NULL AND regexp_replace(COALESCE(o.phone, ''), '[^0-9]', '', 'g') LIKE $2))
        AND o.customer_email NOT IN (SELECT email FROM customers)
        AND o.customer_email NOT IN (SELECT email FROM trade_customers)
      ORDER BY o.customer_email, o.created_at DESC
      LIMIT 5
    `, [term, phoneTerm]);

    res.json({ results: [...retail.rows, ...trade.rows, ...guests.rows] });
  } catch (err) {
    console.error('Customer search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/rep/customers/:email/addresses — previous shipping addresses for a customer
app.get('/api/rep/customers/:email/addresses', repAuth, async (req, res) => {
  try {
    const email = req.params.email.toLowerCase().trim();
    const result = await pool.query(`
      WITH all_addresses AS (
        SELECT shipping_address_line1 AS line1, shipping_address_line2 AS line2,
               shipping_city AS city, shipping_state AS state, shipping_zip AS zip,
               created_at AS used_at
        FROM orders WHERE LOWER(customer_email) = $1
          AND shipping_address_line1 IS NOT NULL AND TRIM(shipping_address_line1) != ''
        UNION ALL
        SELECT shipping_address_line1, shipping_address_line2,
               shipping_city, shipping_state, shipping_zip, created_at
        FROM quotes WHERE LOWER(customer_email) = $1
          AND shipping_address_line1 IS NOT NULL AND TRIM(shipping_address_line1) != ''
        UNION ALL
        SELECT shipping_address_line1, shipping_address_line2,
               shipping_city, shipping_state, shipping_zip, created_at
        FROM sample_requests WHERE LOWER(customer_email) = $1
          AND shipping_address_line1 IS NOT NULL AND TRIM(shipping_address_line1) != ''
        UNION ALL
        SELECT address_line1, address_line2, city, state, zip, updated_at
        FROM customers WHERE LOWER(email) = $1
          AND address_line1 IS NOT NULL AND TRIM(address_line1) != ''
        UNION ALL
        SELECT address_line1, NULL, city, state, zip, updated_at
        FROM trade_customers WHERE LOWER(email) = $1
          AND address_line1 IS NOT NULL AND TRIM(address_line1) != ''
      ),
      deduped AS (
        SELECT TRIM(line1) AS line1, TRIM(COALESCE(line2, '')) AS line2,
               TRIM(COALESCE(city, '')) AS city, TRIM(COALESCE(state, '')) AS state,
               TRIM(COALESCE(zip, '')) AS zip, used_at,
               ROW_NUMBER() OVER (
                 PARTITION BY LOWER(TRIM(line1)), LOWER(TRIM(COALESCE(city, ''))),
                              LOWER(TRIM(COALESCE(state, ''))), TRIM(COALESCE(zip, ''))
                 ORDER BY used_at DESC
               ) AS rn
        FROM all_addresses
      )
      SELECT line1, line2, city, state, zip, used_at AS last_used
      FROM deduped WHERE rn = 1
      ORDER BY last_used DESC
      LIMIT 10
    `, [email]);
    res.json({ addresses: result.rows });
  } catch (err) {
    console.error('Customer addresses error:', err);
    res.status(500).json({ error: 'Failed to fetch addresses' });
  }
});

// GET /api/config/stripe-key — public Stripe publishable key
app.get('/api/config/stripe-key', (req, res) => {
  res.json({ key: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

// GET /api/config/google-places-key — public API key for Google Places autocomplete
app.get('/api/config/google-places-key', (req, res) => {
  res.json({ key: process.env.GOOGLE_PLACES_API_KEY || '' });
});

// GET /api/rep/config/google-places-key — API key for Google Places autocomplete
app.get('/api/rep/config/google-places-key', repAuth, async (req, res) => {
  res.json({ key: process.env.GOOGLE_PLACES_API_KEY || '' });
});

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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Rep Tasks ====================

// GET /api/rep/tasks — List tasks with filters
app.get('/api/rep/tasks', repAuth, async (req, res) => {
  try {
    const { status, priority, due_from, due_to, completed_from, linked_type, search, source } = req.query;
    let where = 'WHERE t.rep_id = $1';
    const params = [req.rep.id];
    let idx = 2;

    if (status) { where += ` AND t.status = $${idx++}`; params.push(status); }
    else { where += " AND t.status != 'dismissed'"; }
    if (priority) { where += ` AND t.priority = $${idx++}`; params.push(priority); }
    if (source) { where += ` AND t.source = $${idx++}`; params.push(source); }
    if (due_from) { where += ` AND t.due_date >= $${idx++}`; params.push(due_from); }
    if (due_to) { where += ` AND t.due_date <= $${idx++}`; params.push(due_to); }
    if (completed_from) { where += ` AND t.completed_at >= $${idx++}`; params.push(completed_from); }
    if (linked_type === 'customer') { where += ' AND t.linked_customer_ref IS NOT NULL'; }
    else if (linked_type === 'order') { where += ' AND t.linked_order_id IS NOT NULL'; }
    else if (linked_type === 'quote') { where += ' AND t.linked_quote_id IS NOT NULL'; }
    else if (linked_type === 'estimate') { where += ' AND t.linked_estimate_id IS NOT NULL'; }
    else if (linked_type === 'deal') { where += ' AND t.linked_deal_id IS NOT NULL'; }
    if (search) { where += ` AND (t.title ILIKE $${idx} OR t.description ILIKE $${idx} OR t.customer_name ILIKE $${idx})`; params.push(`%${search}%`); idx++; }
    // Hide snoozed tasks
    where += ' AND (t.snoozed_until IS NULL OR t.snoozed_until <= CURRENT_DATE)';

    const result = await pool.query(`
      SELECT t.*,
        o.order_number AS linked_order_number,
        q.quote_number AS linked_quote_number,
        e.estimate_number AS linked_estimate_number,
        d.title AS linked_deal_title
      FROM rep_tasks t
      LEFT JOIN orders o ON o.id = t.linked_order_id
      LEFT JOIN quotes q ON q.id = t.linked_quote_id
      LEFT JOIN estimates e ON e.id = t.linked_estimate_id
      LEFT JOIN deals d ON d.id = t.linked_deal_id
      ${where}
      ORDER BY
        CASE WHEN t.status = 'open' THEN 0 ELSE 1 END,
        CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END,
        t.due_date ASC,
        CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        t.created_at DESC
    `, params);
    res.json({ tasks: result.rows });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/rep/tasks/dashboard — Overdue + today + upcoming (7 days)
app.get('/api/rep/tasks/dashboard', repAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const upcoming = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

    const result = await pool.query(`
      SELECT t.*,
        o.order_number AS linked_order_number,
        q.quote_number AS linked_quote_number,
        e.estimate_number AS linked_estimate_number,
        d.title AS linked_deal_title
      FROM rep_tasks t
      LEFT JOIN orders o ON o.id = t.linked_order_id
      LEFT JOIN quotes q ON q.id = t.linked_quote_id
      LEFT JOIN estimates e ON e.id = t.linked_estimate_id
      LEFT JOIN deals d ON d.id = t.linked_deal_id
      WHERE t.rep_id = $1 AND t.status = 'open'
        AND (t.due_date IS NULL OR t.due_date <= $2)
        AND (t.snoozed_until IS NULL OR t.snoozed_until <= CURRENT_DATE)
      ORDER BY
        CASE WHEN t.due_date < $3 THEN 0 WHEN t.due_date = $3 THEN 1 ELSE 2 END,
        t.due_date ASC,
        CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END
    `, [req.rep.id, upcoming, today]);

    const overdue = result.rows.filter(t => t.due_date && t.due_date < today);
    const todayTasks = result.rows.filter(t => t.due_date && t.due_date.toISOString().split('T')[0] === today);
    const upcomingTasks = result.rows.filter(t => !t.due_date || t.due_date > today);

    res.json({ overdue, today: todayTasks, upcoming: upcomingTasks, total: result.rows.length });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/rep/tasks — Create task
app.post('/api/rep/tasks', repAuth, async (req, res) => {
  try {
    const { title, description, due_date, priority,
      linked_customer_type, linked_customer_ref,
      linked_order_id, linked_quote_id, linked_estimate_id, linked_deal_id } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });

    const result = await pool.query(`
      INSERT INTO rep_tasks (rep_id, title, description, due_date, priority, source,
        linked_customer_type, linked_customer_ref,
        linked_order_id, linked_quote_id, linked_estimate_id, linked_deal_id)
      VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [req.rep.id, title.trim(), description || null, due_date || null, priority || 'medium',
        linked_customer_type || null, linked_customer_ref || null,
        linked_order_id || null, linked_quote_id || null, linked_estimate_id || null, linked_deal_id || null]);
    res.json({ task: result.rows[0] });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/rep/tasks/:id — Update task
app.put('/api/rep/tasks/:id', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, due_date, priority,
      linked_customer_type, linked_customer_ref,
      linked_order_id, linked_quote_id, linked_estimate_id, linked_deal_id } = req.body;

    const existing = await pool.query('SELECT * FROM rep_tasks WHERE id = $1 AND rep_id = $2', [id, req.rep.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Task not found' });

    const result = await pool.query(`
      UPDATE rep_tasks SET
        title = COALESCE($1, title),
        description = $2,
        due_date = $3,
        priority = COALESCE($4, priority),
        linked_customer_type = $5,
        linked_customer_ref = $6,
        linked_order_id = $7,
        linked_quote_id = $8,
        linked_estimate_id = $9,
        linked_deal_id = $10,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $11 AND rep_id = $12
      RETURNING *
    `, [title || null, description !== undefined ? description : existing.rows[0].description,
        due_date !== undefined ? due_date : existing.rows[0].due_date,
        priority || null,
        linked_customer_type !== undefined ? linked_customer_type : existing.rows[0].linked_customer_type,
        linked_customer_ref !== undefined ? linked_customer_ref : existing.rows[0].linked_customer_ref,
        linked_order_id !== undefined ? linked_order_id : existing.rows[0].linked_order_id,
        linked_quote_id !== undefined ? linked_quote_id : existing.rows[0].linked_quote_id,
        linked_estimate_id !== undefined ? linked_estimate_id : existing.rows[0].linked_estimate_id,
        linked_deal_id !== undefined ? linked_deal_id : existing.rows[0].linked_deal_id,
        id, req.rep.id]);
    res.json({ task: result.rows[0] });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/rep/tasks/:id/complete — Mark task complete
app.put('/api/rep/tasks/:id/complete', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      UPDATE rep_tasks SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND rep_id = $2 AND status = 'open'
      RETURNING *
    `, [id, req.rep.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Task not found or already completed' });
    res.json({ task: result.rows[0] });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/rep/tasks/:id/reopen — Reopen completed task
app.put('/api/rep/tasks/:id/reopen', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      UPDATE rep_tasks SET status = 'open', completed_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND rep_id = $2 AND status = 'completed'
      RETURNING *
    `, [id, req.rep.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Task not found or not completed' });
    res.json({ task: result.rows[0] });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/rep/tasks/:id — Delete task
app.delete('/api/rep/tasks/:id', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM rep_tasks WHERE id = $1 AND rep_id = $2 RETURNING id', [id, req.rep.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Task not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/rep/tasks/:id/snooze — Snooze task until a future date
app.put('/api/rep/tasks/:id/snooze', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { snooze_until } = req.body;
    if (!snooze_until) return res.status(400).json({ error: 'snooze_until date is required' });
    const snoozeDate = new Date(snooze_until + 'T00:00:00');
    const today = new Date(); today.setHours(0,0,0,0);
    if (snoozeDate <= today) return res.status(400).json({ error: 'Snooze date must be in the future' });

    const result = await pool.query(`
      UPDATE rep_tasks SET snoozed_until = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND rep_id = $3 AND status = 'open'
      RETURNING *
    `, [snooze_until, id, req.rep.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Task not found or not open' });
    res.json({ task: result.rows[0] });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/rep/tasks/:id/dismiss — Dismiss an auto-generated task
app.put('/api/rep/tasks/:id/dismiss', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const task = await pool.query('SELECT source FROM rep_tasks WHERE id = $1 AND rep_id = $2', [id, req.rep.id]);
    if (!task.rows.length) return res.status(404).json({ error: 'Task not found' });
    if (task.rows[0].source !== 'auto') return res.status(400).json({ error: 'Only auto-generated tasks can be dismissed' });

    const result = await pool.query(`
      UPDATE rep_tasks SET status = 'dismissed', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND rep_id = $2
      RETURNING *
    `, [id, req.rep.id]);
    res.json({ task: result.rows[0] });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Rep Deals / Pipeline ====================

// GET /api/rep/deals — List deals + pipeline summary
app.get('/api/rep/deals', repAuth, async (req, res) => {
  try {
    const { stage, search } = req.query;
    let where = 'WHERE d.rep_id = $1';
    const params = [req.rep.id];
    let idx = 2;

    if (stage) { where += ` AND d.stage = $${idx++}`; params.push(stage); }
    if (search) { where += ` AND (d.title ILIKE $${idx} OR d.customer_name ILIKE $${idx})`; params.push(`%${search}%`); idx++; }

    const [dealsResult, summaryResult] = await Promise.all([
      pool.query(`
        SELECT d.*,
          q.quote_number AS linked_quote_number,
          o.order_number AS linked_order_number,
          e.estimate_number AS linked_estimate_number,
          (SELECT COUNT(*)::int FROM rep_tasks t WHERE t.linked_deal_id = d.id AND t.status = 'open') AS open_tasks
        FROM deals d
        LEFT JOIN quotes q ON q.id = d.linked_quote_id
        LEFT JOIN orders o ON o.id = d.linked_order_id
        LEFT JOIN estimates e ON e.id = d.linked_estimate_id
        ${where}
        ORDER BY d.stage_entered_at DESC
      `, params),
      pool.query(`
        SELECT stage,
          COUNT(*)::int AS count,
          COALESCE(SUM(estimated_value), 0) AS total_value
        FROM deals
        WHERE rep_id = $1
        GROUP BY stage
      `, [req.rep.id])
    ]);

    const pipeline_summary = {};
    for (const row of summaryResult.rows) {
      pipeline_summary[row.stage] = { count: row.count, total_value: parseFloat(row.total_value) };
    }

    res.json({ deals: dealsResult.rows, pipeline_summary });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/rep/deals — Create deal
app.post('/api/rep/deals', repAuth, async (req, res) => {
  try {
    const { title, estimated_value, stage, customer_type, customer_ref,
      customer_name, customer_email, linked_quote_id, linked_order_id,
      linked_estimate_id, notes, expected_close_date } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
    if (!customer_name || !customer_name.trim()) return res.status(400).json({ error: 'Customer name is required' });

    const result = await pool.query(`
      INSERT INTO deals (rep_id, title, estimated_value, stage, customer_type, customer_ref,
        customer_name, customer_email, linked_quote_id, linked_order_id, linked_estimate_id,
        notes, expected_close_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `, [req.rep.id, title.trim(), estimated_value || 0, stage || 'lead',
        customer_type || null, customer_ref || null,
        customer_name.trim(), customer_email || null,
        linked_quote_id || null, linked_order_id || null, linked_estimate_id || null,
        notes || null, expected_close_date || null]);
    res.json({ deal: result.rows[0] });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/rep/deals/:id — Update deal
app.put('/api/rep/deals/:id', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await pool.query('SELECT * FROM deals WHERE id = $1 AND rep_id = $2', [id, req.rep.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Deal not found' });

    const { title, estimated_value, customer_type, customer_ref,
      customer_name, customer_email, linked_quote_id, linked_order_id,
      linked_estimate_id, notes, expected_close_date } = req.body;
    const e = existing.rows[0];

    const result = await pool.query(`
      UPDATE deals SET
        title = COALESCE($1, title),
        estimated_value = $2,
        customer_type = $3, customer_ref = $4,
        customer_name = COALESCE($5, customer_name),
        customer_email = $6,
        linked_quote_id = $7, linked_order_id = $8, linked_estimate_id = $9,
        notes = $10, expected_close_date = $11,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $12 AND rep_id = $13
      RETURNING *
    `, [title || null,
        estimated_value !== undefined ? estimated_value : e.estimated_value,
        customer_type !== undefined ? customer_type : e.customer_type,
        customer_ref !== undefined ? customer_ref : e.customer_ref,
        customer_name || null,
        customer_email !== undefined ? customer_email : e.customer_email,
        linked_quote_id !== undefined ? linked_quote_id : e.linked_quote_id,
        linked_order_id !== undefined ? linked_order_id : e.linked_order_id,
        linked_estimate_id !== undefined ? linked_estimate_id : e.linked_estimate_id,
        notes !== undefined ? notes : e.notes,
        expected_close_date !== undefined ? expected_close_date : e.expected_close_date,
        id, req.rep.id]);
    res.json({ deal: result.rows[0] });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/rep/deals/:id/stage — Move deal to new stage
app.put('/api/rep/deals/:id/stage', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { stage, lost_reason } = req.body;
    const validStages = ['lead', 'quoted', 'negotiating', 'won', 'lost'];
    if (!stage || !validStages.includes(stage)) {
      return res.status(400).json({ error: 'stage must be one of: ' + validStages.join(', ') });
    }
    if (stage === 'lost' && !lost_reason) {
      return res.status(400).json({ error: 'lost_reason is required when moving to lost stage' });
    }

    const result = await pool.query(`
      UPDATE deals SET
        stage = $1,
        stage_entered_at = CURRENT_TIMESTAMP,
        lost_reason = $2,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $3 AND rep_id = $4
      RETURNING *
    `, [stage, stage === 'lost' ? lost_reason : null, id, req.rep.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Deal not found' });
    res.json({ deal: result.rows[0] });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/rep/deals/:id — Delete deal
app.delete('/api/rep/deals/:id', repAuth, async (req, res) => {
  try {
    const { id } = req.params;
    // Unlink any tasks referencing this deal
    await pool.query('UPDATE rep_tasks SET linked_deal_id = NULL WHERE linked_deal_id = $1', [id]);
    const result = await pool.query('DELETE FROM deals WHERE id = $1 AND rep_id = $2 RETURNING id', [id, req.rep.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Deal not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Admin Purchase Order Endpoints ====================

// List all POs (standalone + order-linked) with filters
app.get('/api/admin/purchase-orders', staffAuth, async (req, res) => {
  try {
    const { status, vendor_id, search, date_from, date_to } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (status) { conditions.push(`po.status = $${idx++}`); params.push(status); }
    if (vendor_id) { conditions.push(`po.vendor_id = $${idx++}`); params.push(vendor_id); }
    if (date_from) { conditions.push(`po.created_at >= $${idx++}`); params.push(date_from); }
    if (date_to) { conditions.push(`po.created_at <= $${idx++}::date + interval '1 day'`); params.push(date_to); }
    if (search) {
      conditions.push(`(po.po_number ILIKE $${idx} OR v.name ILIKE $${idx} OR o.order_number ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(`
      SELECT po.id, po.po_number, po.status, po.subtotal, po.created_at, po.updated_at,
        po.order_id, po.vendor_id,
        v.name as vendor_name, v.code as vendor_code,
        o.order_number,
        (SELECT COUNT(*) FROM purchase_order_items poi WHERE poi.purchase_order_id = po.id) as item_count,
        sr.first_name || ' ' || sr.last_name as approved_by_name,
        po.approved_at
      FROM purchase_orders po
      JOIN vendors v ON v.id = po.vendor_id
      LEFT JOIN orders o ON o.id = po.order_id
      LEFT JOIN staff_accounts sr ON sr.id = po.approved_by
      ${where}
      ORDER BY po.created_at DESC
      LIMIT 200
    `, params);

    res.json({ purchase_orders: result.rows });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Create standalone PO (no order)
app.post('/api/admin/purchase-orders', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { vendor_id, notes } = req.body;
    if (!vendor_id) return res.status(400).json({ error: 'vendor_id is required' });

    const vendor = await pool.query('SELECT id, code, name FROM vendors WHERE id = $1', [vendor_id]);
    if (!vendor.rows.length) return res.status(404).json({ error: 'Vendor not found' });

    const vendorCode = vendor.rows[0].code || 'XX';
    const poNumber = await getNextPONumber(vendorCode);

    const result = await pool.query(
      `INSERT INTO purchase_orders (order_id, vendor_id, po_number, status, subtotal, notes)
       VALUES (NULL, $1, $2, 'draft', 0, $3) RETURNING *`,
      [vendor_id, poNumber, notes || null]
    );

    const staffName = req.staff.first_name + ' ' + req.staff.last_name;
    await pool.query(
      `INSERT INTO po_activity_log (purchase_order_id, action, performed_by, performer_name, details)
       VALUES ($1, 'created', $2, $3, $4)`,
      [result.rows[0].id, req.staff.id, staffName, JSON.stringify({ standalone: true })]
    );

    res.json({ purchase_order: { ...result.rows[0], vendor_name: vendor.rows[0].name, vendor_code: vendorCode, item_count: 0 } });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single PO detail with items + vendor info
app.get('/api/admin/purchase-orders/:poId/detail', staffAuth, async (req, res) => {
  try {
    const { poId } = req.params;
    const po = await pool.query(`
      SELECT po.*, v.name as vendor_name, v.code as vendor_code, v.edi_config,
        sr.first_name || ' ' || sr.last_name as approved_by_name,
        o.order_number
      FROM purchase_orders po
      JOIN vendors v ON v.id = po.vendor_id
      LEFT JOIN staff_accounts sr ON sr.id = po.approved_by
      LEFT JOIN orders o ON o.id = po.order_id
      WHERE po.id = $1
    `, [poId]);
    if (!po.rows.length) return res.status(404).json({ error: 'Purchase order not found' });

    const items = await pool.query(
      'SELECT * FROM purchase_order_items WHERE purchase_order_id = $1 ORDER BY created_at',
      [poId]
    );

    const activity = await pool.query(
      'SELECT * FROM po_activity_log WHERE purchase_order_id = $1 ORDER BY created_at DESC',
      [poId]
    );

    res.json({ purchase_order: { ...po.rows[0], items: items.rows }, activity: activity.rows });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
          approved_by = COALESCE(approved_by, $3), approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
        WHERE id = $4
      `, [newRevision, isRevised, req.staff.id, poId]);
      action = isRevised ? 'revised_and_sent' : 'sent';
    } else {
      action = 'resent';
    }

    let sentVia = 'email';
    let emailResult = { sent: false };
    let ediDetails = null;

    // EDI path: generate 850 and upload via SFTP or FTP
    if (ediEnabled) {
      let ediSuccess = false;
      try {
        const docs = await generate850(pool, poId, ediConfig);
        const transportType = (ediConfig.transport || 'sftp').toLowerCase();
        const inboxDir = ediConfig.inbox_dir || '/Inbox';

        if (transportType === 'ftp') {
          // FTP transport (e.g. Engineered Floors)
          const ftpClient = await createFtpConnection({
            ftp_host: ediConfig.ftp_host,
            ftp_port: ediConfig.ftp_port || 21,
            ftp_user: ediConfig.ftp_user,
            ftp_pass: ediConfig.ftp_pass,
            ftp_secure: ediConfig.ftp_secure || false,
          });
          try {
            for (const doc of docs) {
              const txnResult = await pool.query(
                `INSERT INTO edi_transactions
                 (vendor_id, document_type, direction, filename, interchange_control_number, purchase_order_id, order_id, status, raw_content)
                 VALUES ($1, '850', 'outbound', $2, $3, $4, $5, 'pending', $6)
                 RETURNING id`,
                [po.vendor_id, doc.filename, doc.icn, poId, po.order_id, doc.content]
              );
              const txnId = txnResult.rows[0].id;
              await ftpUploadFile(ftpClient, `${inboxDir}/${doc.filename}`, doc.content);
              await pool.query(
                `UPDATE edi_transactions SET status = 'sent', processed_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [txnId]
              );
              await pool.query(
                `UPDATE purchase_orders SET edi_interchange_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [poId, doc.icn]
              );
            }
            ediSuccess = true;
          } finally {
            ftpClient.close();
          }
        } else {
          // SFTP transport (e.g. Shaw)
          const sftp = await createSftpConnection(ediConfig);
          try {
            for (const doc of docs) {
              const txnResult = await pool.query(
                `INSERT INTO edi_transactions
                 (vendor_id, document_type, direction, filename, interchange_control_number, purchase_order_id, order_id, status, raw_content)
                 VALUES ($1, '850', 'outbound', $2, $3, $4, $5, 'pending', $6)
                 RETURNING id`,
                [po.vendor_id, doc.filename, doc.icn, poId, po.order_id, doc.content]
              );
              const txnId = txnResult.rows[0].id;
              await uploadFile(sftp, `${inboxDir}/${doc.filename}`, doc.content);
              await pool.query(
                `UPDATE edi_transactions SET status = 'sent', processed_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [txnId]
              );
              await pool.query(
                `UPDATE purchase_orders SET edi_interchange_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [poId, doc.icn]
              );
            }
            ediSuccess = true;
          } finally {
            try { await sftp.end(); } catch (_) {}
          }
        }

        if (ediSuccess) {
          sentVia = 'edi';
          ediDetails = { docs_sent: docs.length, filenames: docs.map(d => d.filename), transport: transportType };
          console.log(`[PO Send] EDI 850 sent via ${transportType} for ${po.po_number}: ${docs.map(d => d.filename).join(', ')}`);
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

    const poData = await generatePOHtml(pool, poId);
    if (!poData) return res.status(404).json({ error: 'Purchase order not found' });

    const updatedData = await generatePOHtml(pool, poId);
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Trigger immediate EDI poll for a vendor (or all EDI vendors)
app.post('/api/admin/edi/poll-now', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { vendor_id } = req.body;

    // Find all EDI-enabled vendors (or a specific one)
    let query = `SELECT v.id as vendor_id, v.code as vendor_code, v.name as vendor_name, v.edi_config
                 FROM vendors v WHERE v.edi_config IS NOT NULL AND (v.edi_config->>'enabled')::boolean = true`;
    const params = [];
    if (vendor_id) {
      query += ` AND v.id = $1`;
      params.push(vendor_id);
    }
    const vendorResult = await pool.query(query, params);

    if (!vendorResult.rows.length) {
      return res.status(404).json({ error: vendor_id ? 'Vendor not found or EDI not enabled' : 'No EDI-enabled vendors found' });
    }

    const pollerModule = await import('./scrapers/edi-poller.js');
    const jobs = [];

    for (const vendor of vendorResult.rows) {
      const jobResult = await pool.query(
        `INSERT INTO scrape_jobs (vendor_source_id, status, started_at)
         VALUES ((SELECT id FROM vendor_sources WHERE vendor_id = $1 AND scraper_key LIKE '%edi%' LIMIT 1), 'running', CURRENT_TIMESTAMP) RETURNING id`,
        [vendor.vendor_id]
      );
      const jobId = jobResult.rows[0]?.id;
      if (!jobId) continue;

      const source = {
        vendor_id: vendor.vendor_id,
        vendor_code: vendor.vendor_code,
        config: { edi: vendor.edi_config },
      };

      pollerModule.run(pool, { id: jobId }, source).then(async (stats) => {
        await pool.query(
          `UPDATE scrape_jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
           products_found = $2, products_created = $3
           WHERE id = $1`,
          [jobId, stats.files_found || 0, stats.processed || 0]
        );
      }).catch(async (err) => {
        console.error(`[EDI Poll Now:${vendor.vendor_code}] Error:`, err.message);
        await pool.query(
          `UPDATE scrape_jobs SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error = $2 WHERE id = $1`,
          [jobId, err.message]
        );
      });

      jobs.push({ vendor_id: vendor.vendor_id, vendor_code: vendor.vendor_code, job_id: jobId });
    }

    res.json({ message: `EDI poll triggered for ${jobs.length} vendor(s)`, jobs });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Admin add line item to draft PO
app.post('/api/admin/purchase-orders/:poId/items', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { poId } = req.params;
    const { product_name, vendor_sku, description, qty, cost, sell_by, sku_id, retail_price } = req.body;

    if (!product_name || cost == null || qty == null) return res.status(400).json({ error: 'product_name, cost, and qty are required' });
    const parsedCost = parseFloat(cost);
    const parsedQty = parseInt(qty);
    if (isNaN(parsedCost) || parsedCost < 0) return res.status(400).json({ error: 'Invalid cost' });
    if (isNaN(parsedQty) || parsedQty < 1) return res.status(400).json({ error: 'Invalid qty' });
    const parsedRetail = retail_price != null ? parseFloat(retail_price) : null;

    const po = await client.query('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
    if (!po.rows.length) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.rows[0].status !== 'draft') return res.status(400).json({ error: 'Only draft POs can be edited' });

    await client.query('BEGIN');

    const subtotal = parsedCost * parsedQty;
    const itemResult = await client.query(
      `INSERT INTO purchase_order_items (purchase_order_id, sku_id, product_name, vendor_sku, description, qty, sell_by, cost, original_cost, retail_price, subtotal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10) RETURNING *`,
      [poId, sku_id || null, product_name, vendor_sku || null, description || null, parsedQty, sell_by || 'sqft', parsedCost.toFixed(2), parsedRetail != null && !isNaN(parsedRetail) ? parsedRetail.toFixed(2) : null, subtotal.toFixed(2)]
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    const result = await generatePOHtml(pool, req.params.id);
    if (!result) return res.status(404).json({ error: 'Purchase order not found' });
    await generatePDF(result.html, `PO-${result.po.po_number}.pdf`, req, res);
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/admin/trade-customers/:id', staffAuth, requireRole('admin', 'manager', 'sales_rep'), async (req, res) => {
  try {
    const { status, margin_tier_id, notes, payment_terms } = req.body;
    const result = await pool.query(
      `UPDATE trade_customers SET status = COALESCE($1, status), margin_tier_id = COALESCE($2, margin_tier_id),
       notes = COALESCE($3, notes), payment_terms = COALESCE($4, payment_terms), updated_at = CURRENT_TIMESTAMP WHERE id = $5 RETURNING *`,
      [status, margin_tier_id, notes, payment_terms, req.params.id]
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/admin/trade-customers/:id', staffAuth, requireRole('admin', 'manager', 'sales_rep'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM trade_customers WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Trade customer not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== Accounting Module ====================

// receiptUpload — extracted to lib/uploads.js

// --- Expense Categories ---
app.get('/api/admin/accounting/expense-categories', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM expense_categories ORDER BY sort_order, name');
    res.json({ categories: result.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/admin/accounting/expense-categories', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { name, expense_type, parent_id } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const maxSort = await pool.query('SELECT COALESCE(MAX(sort_order), 0) + 1 as next FROM expense_categories');
    const result = await pool.query(
      `INSERT INTO expense_categories (name, slug, expense_type, parent_id, sort_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, slug, expense_type || 'operating', parent_id || null, maxSort.rows[0].next]
    );
    res.json({ category: result.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.put('/api/admin/accounting/expense-categories/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { name, expense_type, is_active } = req.body;
    const result = await pool.query(
      `UPDATE expense_categories SET name = COALESCE($1, name), expense_type = COALESCE($2, expense_type),
       is_active = COALESCE($3, is_active) WHERE id = $4 RETURNING *`,
      [name, expense_type, is_active, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ category: result.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Expenses CRUD ---
app.get('/api/admin/accounting/expenses', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { category_id, from, to, search, limit = 50, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    if (category_id) { params.push(category_id); conditions.push(`e.category_id = $${params.length}`); }
    if (from) { params.push(from); conditions.push(`e.expense_date >= $${params.length}`); }
    if (to) { params.push(to); conditions.push(`e.expense_date <= $${params.length}`); }
    if (search) { params.push(`%${search}%`); conditions.push(`(e.vendor_name ILIKE $${params.length} OR e.description ILIKE $${params.length})`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const countResult = await pool.query(`SELECT COUNT(*) FROM expenses e ${where}`, params);
    params.push(parseInt(limit)); params.push(parseInt(offset));
    const result = await pool.query(
      `SELECT e.*, ec.name as category_name, ec.expense_type,
        sa.first_name || ' ' || sa.last_name as created_by_name
       FROM expenses e
       LEFT JOIN expense_categories ec ON ec.id = e.category_id
       LEFT JOIN staff_accounts sa ON sa.id = e.created_by
       ${where} ORDER BY e.expense_date DESC, e.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params
    );
    res.json({ expenses: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/admin/accounting/expenses', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { expense_date, category_id, vendor_name, description, amount, payment_method, reference_number, is_recurring, notes } = req.body;
    if (!category_id || !amount) return res.status(400).json({ error: 'Category and amount are required' });
    const result = await pool.query(
      `INSERT INTO expenses (expense_date, category_id, vendor_name, description, amount, payment_method, reference_number, is_recurring, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [expense_date || new Date(), category_id, vendor_name, description, amount, payment_method, reference_number, is_recurring || false, notes, req.staff.id]
    );
    res.json({ expense: result.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.put('/api/admin/accounting/expenses/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { expense_date, category_id, vendor_name, description, amount, payment_method, reference_number, is_recurring, notes } = req.body;
    const result = await pool.query(
      `UPDATE expenses SET expense_date = COALESCE($1, expense_date), category_id = COALESCE($2, category_id),
       vendor_name = $3, description = $4, amount = COALESCE($5, amount), payment_method = $6,
       reference_number = $7, is_recurring = COALESCE($8, is_recurring), notes = $9, updated_at = CURRENT_TIMESTAMP
       WHERE id = $10 RETURNING *`,
      [expense_date, category_id, vendor_name, description, amount, payment_method, reference_number, is_recurring, notes, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ expense: result.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/admin/accounting/expenses/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM expenses WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/admin/accounting/expenses/:id/receipt', staffAuth, requireRole('admin', 'manager'), receiptUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const fileKey = `receipts/${req.params.id}-${Date.now()}${ext}`;
    await uploadToS3(fileKey, req.file.buffer, req.file.mimetype);
    const url = await getSignedUrlFromS3(fileKey);
    await pool.query('UPDATE expenses SET receipt_url = $1 WHERE id = $2', [fileKey, req.params.id]);
    res.json({ receipt_url: url, file_key: fileKey });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/admin/accounting/expenses/summary', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { from, to } = req.query;
    const conditions = [];
    const params = [];
    if (from) { params.push(from); conditions.push(`e.expense_date >= $${params.length}`); }
    if (to) { params.push(to); conditions.push(`e.expense_date <= $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(
      `SELECT ec.id as category_id, ec.name as category_name, ec.expense_type,
        COUNT(e.id)::int as count, COALESCE(SUM(e.amount), 0) as total
       FROM expense_categories ec
       LEFT JOIN expenses e ON e.category_id = ec.id ${where ? 'AND ' + conditions.join(' AND ') : ''}
       WHERE ec.is_active = true
       GROUP BY ec.id, ec.name, ec.expense_type
       ORDER BY total DESC`, params
    );
    const grandTotal = result.rows.reduce((s, r) => s + parseFloat(r.total), 0);
    res.json({ categories: result.rows, grand_total: grandTotal });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/admin/accounting/expenses/:id/receipt-url', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query('SELECT receipt_url FROM expenses WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Expense not found' });
    if (!result.rows[0].receipt_url) return res.status(404).json({ error: 'No receipt attached' });
    const url = await getPresignedUrl(result.rows[0].receipt_url);
    res.json({ url });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Invoices (AR) ---
async function getNextInvoiceNumber() {
  const result = await pool.query("SELECT invoice_number FROM invoices ORDER BY created_at DESC LIMIT 1");
  if (!result.rows.length) return 'INV-0001';
  const last = result.rows[0].invoice_number;
  const num = parseInt(last.replace(/\D/g, '')) || 0;
  return 'INV-' + String(num + 1).padStart(4, '0');
}

function calculateDueDate(issueDate, terms) {
  const d = new Date(issueDate);
  switch (terms) {
    case 'net_15': d.setDate(d.getDate() + 15); break;
    case 'net_30': d.setDate(d.getDate() + 30); break;
    case 'net_60': d.setDate(d.getDate() + 60); break;
    default: break; // due_on_receipt = same day
  }
  return d.toISOString().split('T')[0];
}

// Auto-generate and send invoice for an order (idempotent)
async function autoGenerateAndSendInvoice(orderId) {
  try {
    // Check if invoice already exists for this order
    const existing = await pool.query('SELECT id, invoice_number FROM invoices WHERE order_id = $1 AND status != $2', [orderId, 'void']);
    if (existing.rows.length) {
      console.log(`[AutoInvoice] Invoice ${existing.rows[0].invoice_number} already exists for order ${orderId}, skipping`);
      return;
    }

    const order = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (!order.rows.length) return;
    const o = order.rows[0];

    const orderItems = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);

    // Determine payment terms from trade customer
    let terms = 'due_on_receipt';
    if (o.trade_customer_id) {
      const tc = await pool.query('SELECT payment_terms FROM trade_customers WHERE id = $1', [o.trade_customer_id]);
      if (tc.rows.length && tc.rows[0].payment_terms) terms = tc.rows[0].payment_terms;
    }

    const invoice_number = await getNextInvoiceNumber();
    const iDate = new Date().toISOString().split('T')[0];
    const due_date = calculateDueDate(iDate, terms);
    const subtotal = parseFloat(o.subtotal) || 0;
    const shipping = parseFloat(o.shipping) || 0;
    const discount = parseFloat(o.discount_amount) || 0;
    const taxAmount = parseFloat(o.tax_amount) || 0;
    const total = parseFloat(o.total) || 0;
    const amountPaid = parseFloat(o.amount_paid) || 0;

    const result = await pool.query(
      `INSERT INTO invoices (invoice_number, order_id, customer_email, customer_name, trade_customer_id,
        billing_address, payment_terms, issue_date, due_date, subtotal, shipping, discount_amount, tax_rate, tax_amount, total, amount_paid, notes, created_by,
        status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [invoice_number, orderId, o.customer_email, o.customer_name, o.trade_customer_id,
       [o.shipping_address_line1, o.shipping_address_line2, o.shipping_city, o.shipping_state, o.shipping_zip].filter(Boolean).join(', '),
       terms, iDate, due_date, subtotal, shipping, discount, parseFloat(o.tax_rate) || 0, taxAmount, total, amountPaid,
       `Auto-generated from order ${o.order_number}`, null,
       amountPaid >= total ? 'paid' : amountPaid > 0 ? 'partial' : 'sent']
    );
    const invoice = result.rows[0];

    // Create invoice items from order items
    for (let i = 0; i < orderItems.rows.length; i++) {
      const oi = orderItems.rows[i];
      const desc = [oi.product_name, oi.collection, oi.description].filter(Boolean).join(' — ');
      await pool.query(
        `INSERT INTO invoice_items (invoice_id, order_item_id, sku_id, description, qty, unit_price, subtotal, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [invoice.id, oi.id, oi.sku_id, desc, oi.num_boxes, parseFloat(oi.unit_price) || 0, parseFloat(oi.subtotal) || 0, i]
      );
    }

    // Link existing payments
    if (amountPaid > 0) {
      const orderPayments = await pool.query('SELECT * FROM order_payments WHERE order_id = $1 AND status = $2', [orderId, 'completed']);
      for (const op of orderPayments.rows) {
        await pool.query(
          `INSERT INTO invoice_payments (invoice_id, order_payment_id, amount, payment_method, reference_number, payment_date)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [invoice.id, op.id, parseFloat(op.amount), op.payment_type || 'stripe', op.stripe_payment_intent_id, new Date(op.created_at).toISOString().split('T')[0]]
        );
      }
      if (amountPaid >= total) {
        await pool.query('UPDATE invoices SET paid_at = CURRENT_TIMESTAMP WHERE id = $1', [invoice.id]);
      }
    }

    // Send invoice email with PDF
    const items = await pool.query('SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order', [invoice.id]);
    try {
      await sendInvoiceSent({ ...invoice, items: items.rows });
    } catch (e) { console.log('[AutoInvoice] Email send skipped:', e.message); }

    await pool.query('UPDATE invoices SET sent_at = CURRENT_TIMESTAMP WHERE id = $1', [invoice.id]);
    console.log(`[AutoInvoice] Generated and sent ${invoice_number} for order ${o.order_number}`);
  } catch (err) {
    console.error('[AutoInvoice] Error for order', orderId, ':', err.message);
  }
}

app.get('/api/admin/accounting/invoices', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { status, search, from, to, limit = 50, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    if (status) { params.push(status); conditions.push(`i.status = $${params.length}`); }
    if (search) { params.push(`%${search}%`); conditions.push(`(i.invoice_number ILIKE $${params.length} OR i.customer_name ILIKE $${params.length} OR i.customer_email ILIKE $${params.length})`); }
    if (from) { params.push(from); conditions.push(`i.issue_date >= $${params.length}`); }
    if (to) { params.push(to); conditions.push(`i.issue_date <= $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const countResult = await pool.query(`SELECT COUNT(*) FROM invoices i ${where}`, params);
    params.push(parseInt(limit)); params.push(parseInt(offset));
    const result = await pool.query(
      `SELECT i.*, o.order_number FROM invoices i
       LEFT JOIN orders o ON o.id = i.order_id
       ${where} ORDER BY i.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params
    );
    res.json({ invoices: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/admin/accounting/invoices/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const inv = await pool.query(
      `SELECT i.*, o.order_number FROM invoices i LEFT JOIN orders o ON o.id = i.order_id WHERE i.id = $1`, [req.params.id]
    );
    if (!inv.rows.length) return res.status(404).json({ error: 'Invoice not found' });
    const items = await pool.query('SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order', [req.params.id]);
    const payments = await pool.query(
      `SELECT ip.*, sa.first_name || \' \' || sa.last_name as recorded_by_name
       FROM invoice_payments ip LEFT JOIN staff_accounts sa ON sa.id = ip.recorded_by
       WHERE ip.invoice_id = $1 ORDER BY ip.payment_date DESC`, [req.params.id]
    );
    res.json({ invoice: inv.rows[0], items: items.rows, payments: payments.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/admin/accounting/invoices', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { customer_email, customer_name, trade_customer_id, billing_address, payment_terms, issue_date, notes, items } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'At least one line item is required' });
    const invoice_number = await getNextInvoiceNumber();
    const iDate = issue_date || new Date().toISOString().split('T')[0];
    const terms = payment_terms || 'due_on_receipt';
    const due_date = calculateDueDate(iDate, terms);
    const subtotal = items.reduce((s, it) => s + (parseFloat(it.qty) * parseFloat(it.unit_price)), 0);
    const total = subtotal;

    const result = await pool.query(
      `INSERT INTO invoices (invoice_number, customer_email, customer_name, trade_customer_id, billing_address,
        payment_terms, issue_date, due_date, subtotal, total, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [invoice_number, customer_email, customer_name, trade_customer_id || null, billing_address, terms, iDate, due_date, subtotal, total, notes, req.staff.id]
    );
    const invoice = result.rows[0];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const itemSubtotal = parseFloat(it.qty) * parseFloat(it.unit_price);
      await pool.query(
        `INSERT INTO invoice_items (invoice_id, sku_id, description, qty, unit_price, subtotal, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [invoice.id, it.sku_id || null, it.description, it.qty, it.unit_price, itemSubtotal, i]
      );
    }
    res.json({ invoice });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/admin/accounting/invoices/from-order/:orderId', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { orderId } = req.params;
    // Check no existing invoice for this order
    const existing = await pool.query('SELECT id, invoice_number FROM invoices WHERE order_id = $1 AND status != $2', [orderId, 'void']);
    if (existing.rows.length) return res.status(400).json({ error: `Invoice ${existing.rows[0].invoice_number} already exists for this order` });

    const order = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });
    const o = order.rows[0];

    const orderItems = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);

    // Determine payment terms from trade customer
    let terms = 'due_on_receipt';
    if (o.trade_customer_id) {
      const tc = await pool.query('SELECT payment_terms FROM trade_customers WHERE id = $1', [o.trade_customer_id]);
      if (tc.rows.length && tc.rows[0].payment_terms) terms = tc.rows[0].payment_terms;
    }

    const invoice_number = await getNextInvoiceNumber();
    const iDate = new Date().toISOString().split('T')[0];
    const due_date = calculateDueDate(iDate, terms);
    const subtotal = parseFloat(o.subtotal) || 0;
    const shipping = parseFloat(o.shipping) || 0;
    const discount = parseFloat(o.discount_amount) || 0;
    const total = parseFloat(o.total) || 0;
    const amountPaid = parseFloat(o.amount_paid) || 0;

    const result = await pool.query(
      `INSERT INTO invoices (invoice_number, order_id, customer_email, customer_name, trade_customer_id,
        billing_address, payment_terms, issue_date, due_date, subtotal, shipping, discount_amount, total, amount_paid, notes, created_by,
        status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [invoice_number, orderId, o.customer_email, o.customer_name, o.trade_customer_id,
       [o.shipping_address_line1, o.shipping_address_line2, o.shipping_city, o.shipping_state, o.shipping_zip].filter(Boolean).join(', '),
       terms, iDate, due_date, subtotal, shipping, discount, total, amountPaid,
       `Auto-generated from order ${o.order_number}`, req.staff.id,
       amountPaid >= total ? 'paid' : amountPaid > 0 ? 'partial' : 'draft']
    );
    const invoice = result.rows[0];

    // Create invoice items from order items
    for (let i = 0; i < orderItems.rows.length; i++) {
      const oi = orderItems.rows[i];
      const desc = [oi.product_name, oi.collection, oi.description].filter(Boolean).join(' — ');
      await pool.query(
        `INSERT INTO invoice_items (invoice_id, order_item_id, sku_id, description, qty, unit_price, subtotal, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [invoice.id, oi.id, oi.sku_id, desc, oi.num_boxes, parseFloat(oi.unit_price) || 0, parseFloat(oi.subtotal) || 0, i]
      );
    }

    // If there are existing payments, link them
    if (amountPaid > 0) {
      const orderPayments = await pool.query('SELECT * FROM order_payments WHERE order_id = $1 AND status = $2', [orderId, 'completed']);
      for (const op of orderPayments.rows) {
        await pool.query(
          `INSERT INTO invoice_payments (invoice_id, order_payment_id, amount, payment_method, reference_number, payment_date, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [invoice.id, op.id, parseFloat(op.amount), op.payment_type || 'stripe', op.stripe_payment_intent_id, new Date(op.created_at).toISOString().split('T')[0], req.staff.id]
        );
      }
      if (amountPaid >= total) {
        await pool.query('UPDATE invoices SET paid_at = CURRENT_TIMESTAMP WHERE id = $1', [invoice.id]);
      }
    }

    res.json({ invoice });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.put('/api/admin/accounting/invoices/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { customer_email, customer_name, billing_address, payment_terms, issue_date, due_date, tax_rate, tax_amount, shipping, discount_amount, notes, items } = req.body;
    // Recalculate total if items provided
    let subtotal, total;
    if (items && items.length) {
      subtotal = items.reduce((s, it) => s + (parseFloat(it.qty) * parseFloat(it.unit_price)), 0);
      total = subtotal + (parseFloat(tax_amount) || 0) + (parseFloat(shipping) || 0) - (parseFloat(discount_amount) || 0);
      await pool.query('DELETE FROM invoice_items WHERE invoice_id = $1', [req.params.id]);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const itemSubtotal = parseFloat(it.qty) * parseFloat(it.unit_price);
        await pool.query(
          `INSERT INTO invoice_items (invoice_id, sku_id, description, qty, unit_price, subtotal, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [req.params.id, it.sku_id || null, it.description, it.qty, it.unit_price, itemSubtotal, i]
        );
      }
    }
    const result = await pool.query(
      `UPDATE invoices SET customer_email = COALESCE($1, customer_email), customer_name = COALESCE($2, customer_name),
       billing_address = COALESCE($3, billing_address), payment_terms = COALESCE($4, payment_terms),
       issue_date = COALESCE($5, issue_date), due_date = COALESCE($6, due_date),
       tax_rate = COALESCE($7, tax_rate), tax_amount = COALESCE($8, tax_amount),
       shipping = COALESCE($9, shipping), discount_amount = COALESCE($10, discount_amount),
       subtotal = COALESCE($11, subtotal), total = COALESCE($12, total),
       notes = COALESCE($13, notes), updated_at = CURRENT_TIMESTAMP
       WHERE id = $14 AND status = 'draft' RETURNING *`,
      [customer_email, customer_name, billing_address, payment_terms, issue_date, due_date,
       tax_rate, tax_amount, shipping, discount_amount, subtotal, total, notes, req.params.id]
    );
    if (!result.rows.length) return res.status(400).json({ error: 'Invoice not found or not in draft status' });
    res.json({ invoice: result.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/admin/accounting/invoices/:id/send', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const inv = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    if (!inv.rows.length) return res.status(404).json({ error: 'Invoice not found' });
    const invoice = inv.rows[0];
    if (invoice.status === 'void') return res.status(400).json({ error: 'Cannot send a voided invoice' });
    const items = await pool.query('SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order', [req.params.id]);

    // Send email
    try {
      await sendInvoiceSent({ ...invoice, items: items.rows });
    } catch (e) { console.log('[Accounting] Invoice email skipped:', e.message); }

    const newStatus = invoice.status === 'draft' ? 'sent' : invoice.status;
    await pool.query('UPDATE invoices SET status = $1, sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newStatus, req.params.id]);
    res.json({ sent: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/admin/accounting/invoices/:id/payments', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { amount, payment_method, reference_number, payment_date, notes } = req.body;
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Valid amount is required' });

    const payMethod = payment_method || 'check';
    const payDate = payment_date || new Date().toISOString().split('T')[0];

    // Find the order linked to this invoice (if any) and create an order_payment
    const invOrder = await pool.query('SELECT order_id FROM invoices WHERE id = $1', [req.params.id]);
    let orderPaymentId = null;
    if (invOrder.rows.length && invOrder.rows[0].order_id) {
      const orderId = invOrder.rows[0].order_id;
      const staffName = req.staff.first_name + ' ' + req.staff.last_name;
      const opRes = await pool.query(`
        INSERT INTO order_payments (order_id, payment_type, amount, description, initiated_by, initiated_by_name, status, payment_method)
        VALUES ($1, 'charge', $2, $3, $4, $5, 'completed', $6) RETURNING id
      `, [orderId, amount, 'Manual invoice payment' + (reference_number ? ' — ' + reference_number : ''), req.staff.id, staffName, payMethod]);
      orderPaymentId = opRes.rows[0].id;
      // Update order amount_paid
      await pool.query('UPDATE orders SET amount_paid = amount_paid + $1 WHERE id = $2', [amount, orderId]);
    }

    await pool.query(
      `INSERT INTO invoice_payments (invoice_id, order_payment_id, amount, payment_method, reference_number, payment_date, notes, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.params.id, orderPaymentId, amount, payMethod, reference_number, payDate, notes, req.staff.id]
    );

    // Update amount_paid on invoice
    const totals = await pool.query('SELECT COALESCE(SUM(amount), 0) as total_paid FROM invoice_payments WHERE invoice_id = $1', [req.params.id]);
    const totalPaid = parseFloat(totals.rows[0].total_paid);
    const inv = await pool.query('SELECT total FROM invoices WHERE id = $1', [req.params.id]);
    const invoiceTotal = parseFloat(inv.rows[0].total);
    const newStatus = totalPaid >= invoiceTotal ? 'paid' : totalPaid > 0 ? 'partial' : 'sent';

    await pool.query(
      `UPDATE invoices SET amount_paid = $1, status = $2, paid_at = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4`,
      [totalPaid, newStatus, newStatus === 'paid' ? new Date() : null, req.params.id]
    );
    res.json({ amount_paid: totalPaid, status: newStatus });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/admin/accounting/invoices/:id/void', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE invoices SET status = 'void', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`, [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ invoice: result.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/admin/accounting/invoices/:id/pdf', (req, res, next) => {
  if (!req.headers['x-staff-token'] && req.query.token) {
    req.headers['x-staff-token'] = req.query.token;
  }
  next();
}, staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const inv = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    if (!inv.rows.length) return res.status(404).json({ error: 'Not found' });
    const invoice = inv.rows[0];
    const items = await pool.query(`
      SELECT ii.*, pr.collection, sk.variant_name, sk.sell_by, sa_c.value as color
      FROM invoice_items ii
      LEFT JOIN skus sk ON sk.id = ii.sku_id
      LEFT JOIN products pr ON pr.id = sk.product_id
      LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = ii.sku_id
        AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
      WHERE ii.invoice_id = $1 ORDER BY ii.sort_order
    `, [req.params.id]);
    const payments = await pool.query('SELECT * FROM invoice_payments WHERE invoice_id = $1 ORDER BY payment_date', [req.params.id]);

    const itemRows = items.rows.map(it => {
      const isUnit = it.sell_by === 'unit';
      const qty = parseFloat(it.qty);
      return `<tr><td>${itemDescriptionCell(it.collection, it.color, it.variant_name)}</td>
        <td class="text-center">${qty}${it.sell_by ? (isUnit ? '' : ' box' + (qty > 1 ? 'es' : '')) : ''}</td>
        <td class="text-right">$${parseFloat(it.unit_price).toFixed(2)}${it.sell_by ? (isUnit ? '/ea' : '/sqft') : ''}</td>
        <td class="text-right">$${parseFloat(it.subtotal).toFixed(2)}</td></tr>`;
    }).join('');

    const paymentRows = payments.rows.length ? payments.rows.map(p =>
      `<tr><td>${new Date(p.payment_date).toLocaleDateString()}</td><td>${p.payment_method}</td>
       <td>${p.reference_number || '\u2014'}</td><td class="text-right">$${parseFloat(p.amount).toFixed(2)}</td></tr>`
    ).join('') : '';

    const balanceDue = parseFloat(invoice.balance);
    const statusClass = 'badge-' + (invoice.status || 'draft');

    const html = `<!DOCTYPE html><html><head><style>${getDocumentBaseCSS()}</style></head><body>
      <div class="page">
        ${getDocumentHeader('Invoice')}
        <div class="doc-banner">
          <div class="doc-banner-left">
            <div class="meta-group"><p class="meta-label">Invoice</p><p class="meta-value">${invoice.invoice_number}</p></div>
            <div class="meta-group"><p class="meta-label">Issue Date</p><p class="meta-value-sm">${new Date(invoice.issue_date).toLocaleDateString()}</p></div>
            <div class="meta-group"><p class="meta-label">Due Date</p><p class="meta-value-sm">${new Date(invoice.due_date).toLocaleDateString()}</p></div>
            <div class="meta-group"><p class="meta-label">Terms</p><p class="meta-value-sm">${(invoice.payment_terms || '').replace(/_/g, ' ')}</p></div>
          </div>
          <div><span class="badge ${statusClass}">${invoice.status}</span></div>
        </div>
        <div class="info-row">
          <div class="info-card"><h3>Bill To</h3><p><strong>${invoice.customer_name || ''}</strong><br>${invoice.customer_email || ''}${invoice.billing_address ? '<br>' + invoice.billing_address : ''}</p></div>
        </div>
        <table><thead><tr><th>Description</th><th class="text-center">Qty</th><th class="text-right">Unit Price</th><th class="text-right">Amount</th></tr></thead>
        <tbody>${itemRows}</tbody></table>
        <div class="totals-wrapper"><div class="totals-box">
          <div class="totals-line"><span>Subtotal</span><span>$${parseFloat(invoice.subtotal).toFixed(2)}</span></div>
          ${parseFloat(invoice.tax_amount) > 0 ? `<div class="totals-line"><span>Tax</span><span>$${parseFloat(invoice.tax_amount).toFixed(2)}</span></div>` : ''}
          ${parseFloat(invoice.shipping) > 0 ? `<div class="totals-line"><span>Shipping</span><span>$${parseFloat(invoice.shipping).toFixed(2)}</span></div>` : ''}
          ${parseFloat(invoice.discount_amount) > 0 ? `<div class="totals-line"><span>Discount</span><span class="discount">-$${parseFloat(invoice.discount_amount).toFixed(2)}</span></div>` : ''}
          <div class="totals-line grand-total"><span>Total</span><span>$${parseFloat(invoice.total).toFixed(2)}</span></div>
          <div class="totals-line"><span>Amount Paid</span><span>$${parseFloat(invoice.amount_paid).toFixed(2)}</span></div>
          ${balanceDue > 0.01 ? `<div class="totals-line balance-due"><span>Balance Due</span><span>$${balanceDue.toFixed(2)}</span></div>` : `<div class="totals-line paid-full"><span>Balance Due</span><span>$0.00</span></div>`}
        </div></div>
        ${paymentRows ? `<div class="section-title">Payment History</div>
          <table><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th class="text-right">Amount</th></tr></thead>
          <tbody>${paymentRows}</tbody></table>` : ''}
        ${invoice.notes ? `<div class="notes-block"><h3>Notes</h3><p>${invoice.notes}</p></div>` : ''}
        ${getDocumentFooter('<p>Thank you for your business.</p>')}
      </div>
    </body></html>`;

    await generatePDF(html, `${invoice.invoice_number}.pdf`, req, res);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/admin/accounting/ar/aging', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN due_date >= CURRENT_DATE THEN balance ELSE 0 END), 0) as current,
        COALESCE(SUM(CASE WHEN CURRENT_DATE - due_date BETWEEN 1 AND 30 THEN balance ELSE 0 END), 0) as days_1_30,
        COALESCE(SUM(CASE WHEN CURRENT_DATE - due_date BETWEEN 31 AND 60 THEN balance ELSE 0 END), 0) as days_31_60,
        COALESCE(SUM(CASE WHEN CURRENT_DATE - due_date BETWEEN 61 AND 90 THEN balance ELSE 0 END), 0) as days_61_90,
        COALESCE(SUM(CASE WHEN CURRENT_DATE - due_date > 90 THEN balance ELSE 0 END), 0) as days_90_plus,
        COALESCE(SUM(balance), 0) as total_outstanding
      FROM invoices WHERE status NOT IN ('void', 'paid', 'draft')
    `);
    res.json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/admin/accounting/invoices/send-reminders', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const overdue = await pool.query(
      `SELECT * FROM invoices WHERE status = 'overdue' AND balance > 0`
    );
    let sent = 0;
    for (const inv of overdue.rows) {
      try {
        await sendInvoiceReminder(inv);
        sent++;
      } catch (e) { console.log('[Accounting] Reminder skipped for', inv.invoice_number, e.message); }
    }
    res.json({ reminders_sent: sent, total_overdue: overdue.rows.length });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/admin/accounting/invoices/:id/send-reminder', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Invoice not found' });
    const invoice = result.rows[0];
    if (!['overdue', 'sent', 'partial'].includes(invoice.status)) {
      return res.status(400).json({ error: 'Reminders can only be sent for overdue, sent, or partial invoices' });
    }
    await sendInvoiceReminder(invoice);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Daily overdue invoice cron (8am) ---
cron.schedule('0 8 * * *', async () => {
  try {
    const result = await pool.query(`
      UPDATE invoices SET status = 'overdue', updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('sent', 'partial') AND due_date < CURRENT_DATE
      RETURNING id, invoice_number
    `);
    if (result.rowCount > 0) {
      console.log(`[Accounting] Marked ${result.rowCount} invoice(s) as overdue: ${result.rows.map(r => r.invoice_number).join(', ')}`);
    }
  } catch (err) { console.error('[Accounting] Overdue cron error:', err.message); }
});

// --- Bills (AP) ---
async function getNextBillNumber() {
  const result = await pool.query("SELECT internal_bill_number FROM bills ORDER BY created_at DESC LIMIT 1");
  if (!result.rows.length) return 'BILL-0001';
  const last = result.rows[0].internal_bill_number;
  const num = parseInt(last.replace(/\D/g, '')) || 0;
  return 'BILL-' + String(num + 1).padStart(4, '0');
}

app.get('/api/admin/accounting/bills', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { status, vendor_id, from, to, limit = 50, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    if (status) { params.push(status); conditions.push(`b.status = $${params.length}`); }
    if (vendor_id) { params.push(vendor_id); conditions.push(`b.vendor_id = $${params.length}`); }
    if (from) { params.push(from); conditions.push(`b.bill_date >= $${params.length}`); }
    if (to) { params.push(to); conditions.push(`b.bill_date <= $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const countResult = await pool.query(`SELECT COUNT(*) FROM bills b ${where}`, params);
    params.push(parseInt(limit)); params.push(parseInt(offset));
    const result = await pool.query(
      `SELECT b.*, v.name as vendor_name, po.po_number
       FROM bills b
       JOIN vendors v ON v.id = b.vendor_id
       LEFT JOIN purchase_orders po ON po.id = b.purchase_order_id
       ${where} ORDER BY b.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params
    );
    res.json({ bills: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/admin/accounting/bills/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const bill = await pool.query(
      `SELECT b.*, v.name as vendor_name, po.po_number
       FROM bills b JOIN vendors v ON v.id = b.vendor_id LEFT JOIN purchase_orders po ON po.id = b.purchase_order_id
       WHERE b.id = $1`, [req.params.id]
    );
    if (!bill.rows.length) return res.status(404).json({ error: 'Bill not found' });
    const items = await pool.query('SELECT * FROM bill_items WHERE bill_id = $1', [req.params.id]);
    const payments = await pool.query(
      `SELECT bp.*, sa.first_name || \' \' || sa.last_name as recorded_by_name
       FROM bill_payments bp LEFT JOIN staff_accounts sa ON sa.id = bp.recorded_by
       WHERE bp.bill_id = $1 ORDER BY bp.payment_date DESC`, [req.params.id]
    );
    res.json({ bill: bill.rows[0], items: items.rows, payments: payments.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/admin/accounting/bills', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { bill_number, vendor_id, bill_date, due_date, payment_terms, tax_amount, shipping, notes, items } = req.body;
    if (!vendor_id) return res.status(400).json({ error: 'Vendor is required' });
    if (!items || !items.length) return res.status(400).json({ error: 'At least one line item is required' });
    const internal_bill_number = await getNextBillNumber();
    const subtotal = items.reduce((s, it) => s + (parseFloat(it.qty) * parseFloat(it.unit_price)), 0);
    const total = subtotal + (parseFloat(tax_amount) || 0) + (parseFloat(shipping) || 0);

    const result = await pool.query(
      `INSERT INTO bills (bill_number, internal_bill_number, vendor_id, bill_date, due_date, payment_terms,
        subtotal, tax_amount, shipping, total, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [bill_number, internal_bill_number, vendor_id, bill_date || new Date(), due_date || new Date(),
       payment_terms || 'net_30', subtotal, tax_amount || 0, shipping || 0, total, notes, req.staff.id]
    );
    const bill = result.rows[0];
    for (const it of items) {
      const itemSubtotal = parseFloat(it.qty) * parseFloat(it.unit_price);
      await pool.query(
        `INSERT INTO bill_items (bill_id, sku_id, description, qty, unit_price, subtotal)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [bill.id, it.sku_id || null, it.description, it.qty, it.unit_price, itemSubtotal]
      );
    }
    res.json({ bill });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/admin/accounting/bills/from-po/:poId', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { poId } = req.params;
    const existing = await pool.query('SELECT id, internal_bill_number FROM bills WHERE purchase_order_id = $1 AND status != $2', [poId, 'void']);
    if (existing.rows.length) return res.status(400).json({ error: `Bill ${existing.rows[0].internal_bill_number} already exists for this PO` });

    const po = await pool.query('SELECT * FROM purchase_orders WHERE id = $1', [poId]);
    if (!po.rows.length) return res.status(404).json({ error: 'PO not found' });
    const p = po.rows[0];

    const poItems = await pool.query('SELECT * FROM purchase_order_items WHERE purchase_order_id = $1', [poId]);
    const internal_bill_number = await getNextBillNumber();
    const subtotal = parseFloat(p.subtotal) || poItems.rows.reduce((s, it) => s + parseFloat(it.subtotal), 0);
    const total = subtotal;

    const result = await pool.query(
      `INSERT INTO bills (internal_bill_number, vendor_id, purchase_order_id, bill_date, due_date,
        payment_terms, subtotal, total, status, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'received',$9,$10) RETURNING *`,
      [internal_bill_number, p.vendor_id, poId, new Date(), calculateDueDate(new Date().toISOString().split('T')[0], 'net_30'),
       'net_30', subtotal, total, `Auto-generated from PO ${p.po_number}`, req.staff.id]
    );
    const bill = result.rows[0];
    for (const it of poItems.rows) {
      await pool.query(
        `INSERT INTO bill_items (bill_id, purchase_order_item_id, sku_id, description, qty, unit_price, subtotal)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [bill.id, it.id, it.sku_id, [it.product_name, it.vendor_sku, it.description].filter(Boolean).join(' — '),
         it.qty, parseFloat(it.cost), parseFloat(it.subtotal)]
      );
    }
    res.json({ bill });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/admin/accounting/bills/from-edi/:ediInvoiceId', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { ediInvoiceId } = req.params;
    const existing = await pool.query('SELECT id, internal_bill_number FROM bills WHERE edi_invoice_id = $1 AND status != $2', [ediInvoiceId, 'void']);
    if (existing.rows.length) return res.status(400).json({ error: `Bill ${existing.rows[0].internal_bill_number} already exists for this EDI invoice` });

    const edi = await pool.query('SELECT * FROM edi_invoices WHERE id = $1', [ediInvoiceId]);
    if (!edi.rows.length) return res.status(404).json({ error: 'EDI invoice not found' });
    const e = edi.rows[0];

    const ediItems = await pool.query('SELECT * FROM edi_invoice_items WHERE edi_invoice_id = $1 ORDER BY line_number', [ediInvoiceId]);
    const internal_bill_number = await getNextBillNumber();
    const subtotal = ediItems.rows.reduce((s, it) => s + parseFloat(it.subtotal || 0), 0);
    const total = parseFloat(e.total_amount) || subtotal;

    const result = await pool.query(
      `INSERT INTO bills (bill_number, internal_bill_number, vendor_id, purchase_order_id, edi_invoice_id,
        bill_date, due_date, payment_terms, subtotal, total, status, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'received',$11,$12) RETURNING *`,
      [e.invoice_number, internal_bill_number, e.vendor_id, e.purchase_order_id, ediInvoiceId,
       e.invoice_date || new Date(), calculateDueDate((e.invoice_date || new Date().toISOString()).split('T')[0], 'net_30'),
       'net_30', subtotal, total, `Auto-generated from EDI invoice ${e.invoice_number}`, req.staff.id]
    );
    const bill = result.rows[0];
    for (const it of ediItems.rows) {
      await pool.query(
        `INSERT INTO bill_items (bill_id, sku_id, description, qty, unit_price, subtotal)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [bill.id, null, [it.vendor_sku, it.description].filter(Boolean).join(' — '),
         parseFloat(it.qty) || 1, parseFloat(it.unit_price) || 0, parseFloat(it.subtotal) || 0]
      );
    }
    res.json({ bill });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.put('/api/admin/accounting/bills/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { bill_number, bill_date, due_date, payment_terms, tax_amount, shipping, notes } = req.body;
    const result = await pool.query(
      `UPDATE bills SET bill_number = COALESCE($1, bill_number), bill_date = COALESCE($2, bill_date),
       due_date = COALESCE($3, due_date), payment_terms = COALESCE($4, payment_terms),
       tax_amount = COALESCE($5, tax_amount), shipping = COALESCE($6, shipping),
       notes = COALESCE($7, notes), updated_at = CURRENT_TIMESTAMP
       WHERE id = $8 RETURNING *`,
      [bill_number, bill_date, due_date, payment_terms, tax_amount, shipping, notes, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ bill: result.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.put('/api/admin/accounting/bills/:id/status', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { status } = req.body;
    if (!['approved', 'void'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const result = await pool.query(
      `UPDATE bills SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ bill: result.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/admin/accounting/bills/:id/payments', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { amount, payment_method, reference_number, payment_date, notes } = req.body;
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Valid amount is required' });

    await pool.query(
      `INSERT INTO bill_payments (bill_id, amount, payment_method, reference_number, payment_date, notes, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.params.id, amount, payment_method || 'check', reference_number, payment_date || new Date().toISOString().split('T')[0], notes, req.staff.id]
    );

    const totals = await pool.query('SELECT COALESCE(SUM(amount), 0) as total_paid FROM bill_payments WHERE bill_id = $1', [req.params.id]);
    const totalPaid = parseFloat(totals.rows[0].total_paid);
    const bill = await pool.query('SELECT total FROM bills WHERE id = $1', [req.params.id]);
    const billTotal = parseFloat(bill.rows[0].total);
    const newStatus = totalPaid >= billTotal ? 'paid' : totalPaid > 0 ? 'partial' : 'approved';

    await pool.query(
      `UPDATE bills SET amount_paid = $1, status = $2, payment_method = $3, payment_reference = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5`,
      [totalPaid, newStatus, payment_method || 'check', reference_number, req.params.id]
    );
    res.json({ amount_paid: totalPaid, status: newStatus });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/admin/accounting/ap/aging', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN due_date >= CURRENT_DATE THEN balance ELSE 0 END), 0) as current,
        COALESCE(SUM(CASE WHEN CURRENT_DATE - due_date BETWEEN 1 AND 30 THEN balance ELSE 0 END), 0) as days_1_30,
        COALESCE(SUM(CASE WHEN CURRENT_DATE - due_date BETWEEN 31 AND 60 THEN balance ELSE 0 END), 0) as days_31_60,
        COALESCE(SUM(CASE WHEN CURRENT_DATE - due_date BETWEEN 61 AND 90 THEN balance ELSE 0 END), 0) as days_61_90,
        COALESCE(SUM(CASE WHEN CURRENT_DATE - due_date > 90 THEN balance ELSE 0 END), 0) as days_90_plus,
        COALESCE(SUM(balance), 0) as total_outstanding
      FROM bills WHERE status NOT IN ('void', 'paid', 'draft')
    `);
    res.json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Commission Management ---

// List commissions with filters
app.get('/api/admin/accounting/commissions', staffAuth, requireRole('admin', 'manager', 'sales'), async (req, res) => {
  try {
    const { status, rep_id, from, to, page = 1, limit = 25 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let query = `
      SELECT rc.*, o.order_number, o.customer_name, o.status as order_status, o.created_at as order_date,
             sr.first_name || ' ' || sr.last_name as rep_name
      FROM rep_commissions rc
      JOIN orders o ON o.id = rc.order_id
      JOIN sales_reps sr ON sr.id = rc.rep_id
      WHERE 1=1
    `;
    const params = [];
    const countParams = [];
    let idx = 1;
    let countIdx = 1;
    let countWhere = '';
    if (status) { query += ` AND rc.status = $${idx++}`; params.push(status); countWhere += ` AND rc.status = $${countIdx++}`; countParams.push(status); }
    if (rep_id) { query += ` AND rc.rep_id = $${idx++}`; params.push(rep_id); countWhere += ` AND rc.rep_id = $${countIdx++}`; countParams.push(rep_id); }
    if (from) { query += ` AND rc.created_at >= $${idx++}`; params.push(from); countWhere += ` AND rc.created_at >= $${countIdx++}`; countParams.push(from); }
    if (to) { query += ` AND rc.created_at <= ($${idx++})::date + interval '1 day'`; params.push(to); countWhere += ` AND rc.created_at <= ($${countIdx++})::date + interval '1 day'`; countParams.push(to); }

    const countRes = await pool.query(`SELECT COUNT(*)::int as total FROM rep_commissions rc JOIN orders o ON o.id = rc.order_id WHERE 1=1` + countWhere, countParams);

    query += ` ORDER BY rc.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(parseInt(limit), offset);
    const result = await pool.query(query, params);
    res.json({ commissions: result.rows, total: countRes.rows[0].total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// Commission summary stats
app.get('/api/admin/accounting/commissions/summary', staffAuth, requireRole('admin', 'manager', 'sales'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'pending' THEN commission_amount ELSE 0 END), 0) as total_pending,
        COALESCE(SUM(CASE WHEN status = 'earned' THEN commission_amount ELSE 0 END), 0) as total_earned,
        COALESCE(SUM(CASE WHEN status = 'paid' AND paid_at >= DATE_TRUNC('month', CURRENT_DATE) THEN commission_amount ELSE 0 END), 0) as paid_this_month,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN commission_amount ELSE 0 END), 0) as total_paid,
        COALESCE(AVG(commission_rate), 0) as avg_rate,
        COUNT(*)::int as total_count
      FROM rep_commissions
    `);
    res.json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// Get commission config
app.get('/api/admin/accounting/commissions/config', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM commission_config LIMIT 1');
    res.json(result.rows[0] || { rate: 0.10, default_cost_ratio: 0.55 });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// Update commission config
app.put('/api/admin/accounting/commissions/config', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { rate, default_cost_ratio } = req.body;
    const result = await pool.query(
      `UPDATE commission_config SET rate = COALESCE($1, rate), default_cost_ratio = COALESCE($2, default_cost_ratio), updated_at = CURRENT_TIMESTAMP RETURNING *`,
      [rate, default_cost_ratio]
    );
    res.json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// Single commission detail
app.get('/api/admin/accounting/commissions/:id', staffAuth, requireRole('admin', 'manager', 'sales'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT rc.*, o.order_number, o.customer_name, o.status as order_status, o.total as current_order_total,
             sr.first_name || ' ' || sr.last_name as rep_name, sr.email as rep_email
      FROM rep_commissions rc
      JOIN orders o ON o.id = rc.order_id
      JOIN sales_reps sr ON sr.id = rc.rep_id
      WHERE rc.id = $1
    `, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Commission not found' });
    res.json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// Update commission (approve, adjust)
app.put('/api/admin/accounting/commissions/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { status, commission_rate, commission_amount, notes } = req.body;
    const current = await pool.query('SELECT * FROM rep_commissions WHERE id = $1', [req.params.id]);
    if (!current.rows.length) return res.status(404).json({ error: 'Commission not found' });
    const comm = current.rows[0];

    let newAmount = commission_amount != null ? parseFloat(commission_amount) : parseFloat(comm.commission_amount);
    let newRate = commission_rate != null ? parseFloat(commission_rate) : parseFloat(comm.commission_rate);

    // If rate changed, recalculate amount from margin
    if (commission_rate != null && parseFloat(commission_rate) !== parseFloat(comm.commission_rate)) {
      newAmount = parseFloat(comm.margin) * newRate;
    }

    const result = await pool.query(`
      UPDATE rep_commissions SET
        status = COALESCE($1, status),
        commission_rate = $2,
        commission_amount = $3,
        notes = COALESCE($4, notes),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $5 RETURNING *
    `, [status || comm.status, newRate, newAmount.toFixed(2), notes, req.params.id]);
    res.json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// Pay a single commission
app.post('/api/admin/accounting/commissions/:id/pay', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query(`
      UPDATE rep_commissions SET status = 'paid', paid_at = NOW(), paid_by = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND status IN ('earned', 'pending') RETURNING *
    `, [req.staff.id, req.params.id]);
    if (!result.rows.length) return res.status(400).json({ error: 'Commission not found or already paid' });
    res.json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// Batch pay commissions
app.post('/api/admin/accounting/commissions/batch-pay', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.status(400).json({ error: 'No commission IDs provided' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        UPDATE rep_commissions SET status = 'paid', paid_at = NOW(), paid_by = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ANY($2) AND status IN ('earned', 'pending') RETURNING id
      `, [req.staff.id, ids]);
      await client.query('COMMIT');
      res.json({ paid_count: result.rowCount, paid_ids: result.rows.map(r => r.id) });
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// --- P&L / Reports ---
app.get('/api/admin/accounting/reports/pnl', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { period = 'monthly', from, to } = req.query;
    let dateFrom, dateTo;
    const now = new Date();
    if (from && to) { dateFrom = from; dateTo = to; }
    else if (period === 'monthly') {
      dateFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
      dateTo = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
    } else if (period === 'quarterly') {
      const qStart = Math.floor(now.getMonth() / 3) * 3;
      dateFrom = new Date(now.getFullYear(), qStart, 1).toISOString().split('T')[0];
      dateTo = new Date(now.getFullYear(), qStart + 3, 0).toISOString().split('T')[0];
    } else {
      dateFrom = new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0];
      dateTo = new Date(now.getFullYear(), 11, 31).toISOString().split('T')[0];
    }

    // Revenue from orders
    const revenue = await pool.query(
      `SELECT COALESCE(SUM(total), 0) as total_revenue, COALESCE(SUM(shipping), 0) as shipping_revenue,
        COUNT(*)::int as order_count
       FROM orders WHERE status IN ('confirmed','shipped','delivered')
         AND created_at >= $1 AND created_at <= ($2::date + interval '1 day')`, [dateFrom, dateTo]
    );

    // COGS from PO items
    const cogs_po = await pool.query(
      `SELECT COALESCE(SUM(poi.subtotal), 0) as po_cost
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.purchase_order_id
       WHERE po.status NOT IN ('cancelled','draft')
         AND po.created_at >= $1 AND po.created_at <= ($2::date + interval '1 day')`, [dateFrom, dateTo]
    );

    // COGS expenses
    const cogs_expenses = await pool.query(
      `SELECT COALESCE(SUM(e.amount), 0) as total
       FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
       WHERE ec.expense_type = 'cogs' AND e.expense_date >= $1 AND e.expense_date <= $2`, [dateFrom, dateTo]
    );

    // Operating expenses by category
    const operating = await pool.query(
      `SELECT ec.name, COALESCE(SUM(e.amount), 0) as total
       FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
       WHERE ec.expense_type = 'operating' AND e.expense_date >= $1 AND e.expense_date <= $2
       GROUP BY ec.name ORDER BY total DESC`, [dateFrom, dateTo]
    );

    // Overhead expenses by category
    const overhead = await pool.query(
      `SELECT ec.name, COALESCE(SUM(e.amount), 0) as total
       FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
       WHERE ec.expense_type = 'overhead' AND e.expense_date >= $1 AND e.expense_date <= $2
       GROUP BY ec.name ORDER BY total DESC`, [dateFrom, dateTo]
    );

    const totalRevenue = parseFloat(revenue.rows[0].total_revenue);
    const totalCOGS = parseFloat(cogs_po.rows[0].po_cost) + parseFloat(cogs_expenses.rows[0].total);
    const grossProfit = totalRevenue - totalCOGS;
    const totalOperating = operating.rows.reduce((s, r) => s + parseFloat(r.total), 0);
    const totalOverhead = overhead.rows.reduce((s, r) => s + parseFloat(r.total), 0);
    const netIncome = grossProfit - totalOperating - totalOverhead;

    res.json({
      period: { from: dateFrom, to: dateTo, type: period },
      revenue: { total: totalRevenue, shipping: parseFloat(revenue.rows[0].shipping_revenue), order_count: revenue.rows[0].order_count },
      cogs: { po_cost: parseFloat(cogs_po.rows[0].po_cost), expenses: parseFloat(cogs_expenses.rows[0].total), total: totalCOGS },
      gross_profit: grossProfit,
      gross_margin_pct: totalRevenue > 0 ? ((grossProfit / totalRevenue) * 100).toFixed(1) : '0.0',
      operating_expenses: { categories: operating.rows.map(r => ({ name: r.name, total: parseFloat(r.total) })), total: totalOperating },
      overhead: { categories: overhead.rows.map(r => ({ name: r.name, total: parseFloat(r.total) })), total: totalOverhead },
      net_income: netIncome,
      net_margin_pct: totalRevenue > 0 ? ((netIncome / totalRevenue) * 100).toFixed(1) : '0.0'
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/admin/accounting/reports/pnl/csv', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    // Reuse PNL logic
    const pnlRes = await fetch(`http://localhost:${PORT}/api/admin/accounting/reports/pnl?${new URLSearchParams(req.query)}`, {
      headers: { 'x-staff-token': req.headers['x-staff-token'] }
    });
    const pnl = await pnlRes.json();

    const lines = [
      `Profit & Loss Statement`,
      `Period: ${pnl.period.from} to ${pnl.period.to}`,
      '',
      'Category,Amount',
      `Revenue,$${pnl.revenue.total.toFixed(2)}`,
      '',
      'Cost of Goods Sold,',
      `  PO Costs,$${pnl.cogs.po_cost.toFixed(2)}`,
      `  COGS Expenses,$${pnl.cogs.expenses.toFixed(2)}`,
      `Total COGS,$${pnl.cogs.total.toFixed(2)}`,
      '',
      `Gross Profit,$${pnl.gross_profit.toFixed(2)}`,
      `Gross Margin,${pnl.gross_margin_pct}%`,
      '',
      'Operating Expenses,',
      ...pnl.operating_expenses.categories.map(c => `  ${c.name},$${c.total.toFixed(2)}`),
      `Total Operating,$${pnl.operating_expenses.total.toFixed(2)}`,
      '',
      'Overhead,',
      ...pnl.overhead.categories.map(c => `  ${c.name},$${c.total.toFixed(2)}`),
      `Total Overhead,$${pnl.overhead.total.toFixed(2)}`,
      '',
      `Net Income,$${pnl.net_income.toFixed(2)}`,
      `Net Margin,${pnl.net_margin_pct}%`
    ];

    res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="pnl-${pnl.period.from}-to-${pnl.period.to}.csv"` });
    res.send(lines.join('\n'));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/admin/accounting/reports/dashboard', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const yearStart = new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0];
    const today = now.toISOString().split('T')[0];

    const [arAging, apAging, invoiceStats, billStats, expenseMonth, expenseYear, revenueByMonth] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(balance), 0) as total, COUNT(*)::int as count FROM invoices WHERE status IN ('sent','partial','overdue')`),
      pool.query(`SELECT COALESCE(SUM(balance), 0) as total, COUNT(*)::int as count FROM bills WHERE status IN ('received','approved','partial')`),
      pool.query(`SELECT
        COALESCE(SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END), 0)::int as overdue_count,
        COALESCE(SUM(CASE WHEN status = 'paid' AND paid_at >= $1 THEN total ELSE 0 END), 0) as paid_this_month
        FROM invoices`, [monthStart]),
      pool.query(`SELECT
        COALESCE(SUM(CASE WHEN status IN ('received','draft') THEN 1 ELSE 0 END), 0)::int as pending_approval,
        COALESCE(SUM(CASE WHEN status = 'paid' AND updated_at >= $1 THEN total ELSE 0 END), 0) as paid_this_month
        FROM bills`, [monthStart]),
      pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE expense_date >= $1`, [monthStart]),
      pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE expense_date >= $1`, [yearStart]),
      pool.query(`SELECT DATE_TRUNC('month', created_at) as month,
        COALESCE(SUM(total), 0) as revenue
        FROM orders WHERE status IN ('confirmed','shipped','delivered') AND created_at >= $1
        GROUP BY month ORDER BY month`, [yearStart])
    ]);

    // Revenue vs COGS by month
    const cogsQuery = await pool.query(`SELECT DATE_TRUNC('month', po.created_at) as month,
      COALESCE(SUM(poi.subtotal), 0) as cogs
      FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE po.status NOT IN ('cancelled','draft') AND po.created_at >= $1
      GROUP BY month ORDER BY month`, [yearStart]);

    const months = {};
    for (const r of revenueByMonth.rows) {
      const key = new Date(r.month).toISOString().split('T')[0].substring(0, 7);
      months[key] = { month: key, revenue: parseFloat(r.revenue), cogs: 0 };
    }
    for (const r of cogsQuery.rows) {
      const key = new Date(r.month).toISOString().split('T')[0].substring(0, 7);
      if (!months[key]) months[key] = { month: key, revenue: 0, cogs: 0 };
      months[key].cogs = parseFloat(r.cogs);
    }

    // DSO / DPO calculations (last 90 days)
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const [dsoQuery, dpoQuery] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(total), 0) as revenue_90d FROM orders WHERE status IN ('confirmed','shipped','delivered') AND created_at >= $1`, [ninetyDaysAgo]),
      pool.query(`SELECT COALESCE(SUM(poi.subtotal), 0) as cogs_90d FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.purchase_order_id WHERE po.status NOT IN ('cancelled','draft') AND po.created_at >= $1`, [ninetyDaysAgo])
    ]);
    const arOutstanding = parseFloat(arAging.rows[0].total);
    const apOutstanding = parseFloat(apAging.rows[0].total);
    const revenue90d = parseFloat(dsoQuery.rows[0].revenue_90d);
    const cogs90d = parseFloat(dpoQuery.rows[0].cogs_90d);
    const dso = revenue90d > 0 ? Math.round((arOutstanding / revenue90d) * 90) : 0;
    const dpo = cogs90d > 0 ? Math.round((apOutstanding / cogs90d) * 90) : 0;

    res.json({
      ar: { outstanding: arOutstanding, count: arAging.rows[0].count,
        overdue_count: invoiceStats.rows[0].overdue_count, paid_this_month: parseFloat(invoiceStats.rows[0].paid_this_month) },
      ap: { outstanding: apOutstanding, count: apAging.rows[0].count,
        pending_approval: billStats.rows[0].pending_approval, paid_this_month: parseFloat(billStats.rows[0].paid_this_month) },
      expenses: { this_month: parseFloat(expenseMonth.rows[0].total), this_year: parseFloat(expenseYear.rows[0].total) },
      revenue_vs_cogs: Object.values(months).sort((a, b) => a.month.localeCompare(b.month)),
      dso, dpo
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Tax Reporting ---

app.get('/api/admin/accounting/reports/tax', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const now = new Date();
    const from = req.query.from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const to = req.query.to || now.toISOString().split('T')[0];

    // Tax by jurisdiction (zip code)
    const byZip = await pool.query(`
      SELECT
        SUBSTRING(COALESCE(shipping_zip, '') FROM 1 FOR 5) as zip,
        COALESCE(shipping_city, '') as city,
        COALESCE(shipping_state, '') as state,
        COUNT(*)::int as order_count,
        COALESCE(SUM(total - COALESCE(tax_amount, 0)), 0) as taxable_amount,
        COALESCE(SUM(tax_amount), 0) as tax_collected
      FROM orders
      WHERE status NOT IN ('cancelled', 'refunded')
        AND created_at >= $1 AND created_at <= ($2)::date + interval '1 day'
        AND COALESCE(tax_amount, 0) > 0
      GROUP BY zip, city, state
      ORDER BY tax_collected DESC
    `, [from, to]);

    // Monthly totals
    const monthly = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') as month,
        COALESCE(SUM(tax_amount), 0) as tax_collected,
        COUNT(*)::int as order_count
      FROM orders
      WHERE status NOT IN ('cancelled', 'refunded')
        AND created_at >= $1 AND created_at <= ($2)::date + interval '1 day'
        AND COALESCE(tax_amount, 0) > 0
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month
    `, [from, to]);

    const totalTax = byZip.rows.reduce((sum, r) => sum + parseFloat(r.tax_collected), 0);

    res.json({
      period: { from, to },
      total_tax: totalTax,
      by_jurisdiction: byZip.rows.map(r => ({
        zip: r.zip, city: r.city, state: r.state,
        order_count: r.order_count,
        taxable_amount: parseFloat(r.taxable_amount),
        tax_collected: parseFloat(r.tax_collected)
      })),
      monthly_totals: monthly.rows.map(r => ({
        month: r.month, tax_collected: parseFloat(r.tax_collected), order_count: r.order_count
      }))
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/admin/accounting/reports/tax/csv', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const now = new Date();
    const from = req.query.from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const to = req.query.to || now.toISOString().split('T')[0];

    const byZip = await pool.query(`
      SELECT
        SUBSTRING(COALESCE(shipping_zip, '') FROM 1 FOR 5) as zip,
        COALESCE(shipping_city, '') as city,
        COALESCE(shipping_state, '') as state,
        COUNT(*)::int as order_count,
        COALESCE(SUM(total - COALESCE(tax_amount, 0)), 0) as taxable_amount,
        COALESCE(SUM(tax_amount), 0) as tax_collected
      FROM orders
      WHERE status NOT IN ('cancelled', 'refunded')
        AND created_at >= $1 AND created_at <= ($2)::date + interval '1 day'
        AND COALESCE(tax_amount, 0) > 0
      GROUP BY zip, city, state
      ORDER BY tax_collected DESC
    `, [from, to]);

    let csv = 'Period,Zip Code,City,State,Order Count,Taxable Amount,Tax Collected\n';
    for (const r of byZip.rows) {
      csv += `"${from} to ${to}","${r.zip}","${r.city}","${r.state}",${r.order_count},${parseFloat(r.taxable_amount).toFixed(2)},${parseFloat(r.tax_collected).toFixed(2)}\n`;
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="tax-report-${from}-to-${to}.csv"`);
    res.send(csv);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
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
        COALESCE(p.display_name, p.name) as product_name, s.variant_name, s.internal_sku as sku_code, s.id as sku_id,
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

// ==================== Bank Transfer Expiration Cron ====================

// Run daily at 5 AM UTC — cancel expired awaiting_payment bank transfer orders
cron.schedule('0 5 * * *', async () => {
  try {
    const expired = await pool.query(`
      SELECT id, order_number, stripe_payment_intent_id
      FROM orders
      WHERE status = 'awaiting_payment'
        AND payment_method = 'bank_transfer'
        AND bank_transfer_expires_at IS NOT NULL
        AND bank_transfer_expires_at < NOW()
    `);
    for (const order of expired.rows) {
      await pool.query(
        "UPDATE orders SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [order.id]
      );
      await logOrderActivity(pool, order.id, 'order_cancelled', null, 'System',
        { reason: 'Bank transfer payment not received within 14 days' });
      // Cancel the Stripe payment intent
      if (order.stripe_payment_intent_id) {
        try {
          await stripe.paymentIntents.cancel(order.stripe_payment_intent_id);
        } catch (piErr) {
          console.error(`[Cron] Failed to cancel PI ${order.stripe_payment_intent_id}:`, piErr.message);
        }
      }
      console.log(`[Cron] Cancelled expired bank transfer order ${order.order_number}`);
    }
    if (expired.rows.length > 0) {
      console.log(`[Cron] Cancelled ${expired.rows.length} expired bank transfer order(s)`);
    }
  } catch (err) {
    console.error('[Cron] Bank transfer expiration check failed:', err.message);
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

// ==================== Carrier Tracking ====================

const CARRIER_TRACKING_URLS = {
  'R+L Carriers': 'https://www2.rlcarriers.com/freight/shipping/shipment-tracing?pro=',
  'FedEx Freight': 'https://www.fedex.com/fedextrack/?trknbr=',
  'FedEx': 'https://www.fedex.com/fedextrack/?trknbr=',
  'ABF Freight': 'https://arcb.com/tools/tracking.html?RefNum=',
  'UPS': 'https://www.ups.com/track?tracknum=',
  'UPS Freight': 'https://www.ups.com/track?tracknum=',
  'USPS': 'https://tools.usps.com/go/TrackConfirmAction?tLabels=',
  'XPO Logistics': 'https://app.xpo.com/tracking/',
  'SAIA': 'https://www.saia.com/track/details;pro=',
  'Old Dominion': 'https://www.odfl.com/Trace/standardResult.faces?pro=',
  'Estes Express': 'https://www.estes-express.com/myestes/shipment-tracking/?query=',
  'YRC Freight': 'https://my.yrc.com/tools/track/shipments?referenceNumber='
};

function getTrackingUrl(carrier, trackingNumber) {
  if (!carrier || !trackingNumber) return null;
  const baseUrl = CARRIER_TRACKING_URLS[carrier];
  if (baseUrl) return baseUrl + encodeURIComponent(trackingNumber);
  return null;
}

// Poll EasyPost tracker for parcel and LTL orders (tracks any carrier by tracking number)
async function pollEasyPostTracking(orderId, trackingNumber, carrier) {
  if (!easypost) return null;
  try {
    const tracker = await easypost.Tracker.create({ tracking_code: trackingNumber, carrier: carrier || undefined });
    const status = tracker.status || null;

    // Store tracking events
    for (const detail of (tracker.tracking_details || [])) {
      const eventTime = detail.datetime ? new Date(detail.datetime) : null;
      const existing = await pool.query(
        'SELECT id FROM tracking_events WHERE order_id = $1 AND status = $2 AND event_time = $3 LIMIT 1',
        [orderId, detail.status || 'update', eventTime]
      );
      if (existing.rows.length === 0) {
        const loc = detail.tracking_location
          ? [detail.tracking_location.city, detail.tracking_location.state].filter(Boolean).join(', ')
          : null;
        await pool.query(
          `INSERT INTO tracking_events (order_id, status, description, location, event_time, source)
           VALUES ($1, $2, $3, $4, $5, 'easypost')`,
          [orderId, detail.status || 'update', detail.message || null, loc, eventTime]
        );
      }
    }

    await pool.query(
      'UPDATE orders SET tracking_status = $1, tracking_last_checked = NOW() WHERE id = $2',
      [status, orderId]
    );

    // Auto-mark delivered
    if (status === 'delivered') {
      const orderCheck = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
      if (orderCheck.rows.length && orderCheck.rows[0].status === 'shipped') {
        await pool.query('UPDATE orders SET status = $1, delivered_at = NOW() WHERE id = $2', ['delivered', orderId]);
        console.log(`[Tracking] Auto-marked order ${orderId} as delivered (EasyPost)`);
        const fullOrder = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
        if (fullOrder.rows.length) {
          setImmediate(() => sendOrderStatusUpdate(fullOrder.rows[0], 'delivered'));
          setImmediate(() => recalculateCommission(pool, orderId));
        }
      }
    }

    return status;
  } catch (err) {
    console.error('[Tracking] EasyPost poll error:', err.message);
    return null;
  }
}

// Admin API: get tracking events for an order
app.get('/api/admin/orders/:id/tracking', staffAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const order = await pool.query(
      'SELECT tracking_number, shipping_carrier, tracking_status, tracking_last_checked, shipping_method FROM orders WHERE id = $1',
      [id]
    );
    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });

    const events = await pool.query(
      'SELECT * FROM tracking_events WHERE order_id = $1 ORDER BY event_time DESC NULLS LAST, created_at DESC',
      [id]
    );

    const o = order.rows[0];
    res.json({
      tracking_number: o.tracking_number,
      carrier: o.shipping_carrier,
      tracking_status: o.tracking_status,
      last_checked: o.tracking_last_checked,
      tracking_url: getTrackingUrl(o.shipping_carrier, o.tracking_number),
      events: events.rows
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// Admin API: manually refresh tracking for an order
app.post('/api/admin/orders/:id/tracking/refresh', staffAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const order = await pool.query(
      'SELECT tracking_number, shipping_carrier, shipping_method FROM orders WHERE id = $1',
      [id]
    );
    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });
    const o = order.rows[0];

    let status = null;
    if (o.tracking_number && easypost) {
      status = await pollEasyPostTracking(id, o.tracking_number, o.shipping_carrier);
    }

    const events = await pool.query(
      'SELECT * FROM tracking_events WHERE order_id = $1 ORDER BY event_time DESC NULLS LAST, created_at DESC',
      [id]
    );

    res.json({
      tracking_status: status,
      tracking_url: getTrackingUrl(o.shipping_carrier, o.tracking_number),
      events: events.rows
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// Cron: poll tracking for shipped orders every 4 hours
cron.schedule('0 */4 * * *', async () => {
  console.log('[Cron] Polling tracking for shipped orders...');
  try {
    const shipped = await pool.query(`
      SELECT id, tracking_number, shipping_carrier, shipping_method
      FROM orders WHERE status = 'shipped' AND tracking_number IS NOT NULL
      ORDER BY shipped_at DESC LIMIT 50
    `);

    let polled = 0;
    for (const order of shipped.rows) {
      if (order.tracking_number && easypost) {
        await pollEasyPostTracking(order.id, order.tracking_number, order.shipping_carrier);
        polled++;
      }
    }
    console.log(`[Cron] Tracking poll complete: ${polled} orders checked`);
  } catch (err) {
    console.error('[Cron] Tracking poll error:', err.message);
  }
});

// ==================== Analytics Daily Aggregation (7 AM Pacific) ====================

cron.schedule('0 7 * * *', async () => {
  console.log('[Analytics] Running daily aggregation...');
  try {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const dayStart = yesterday + 'T00:00:00';
    const dayEnd = yesterday + 'T23:59:59.999';

    // Count events by type
    const eventCounts = await pool.query(`
      SELECT event_type, COUNT(*)::int as cnt, COUNT(DISTINCT session_id)::int as sessions
      FROM analytics_events WHERE created_at >= $1 AND created_at <= $2
      GROUP BY event_type
    `, [dayStart, dayEnd]);
    const ec = {};
    eventCounts.rows.forEach(r => { ec[r.event_type] = { cnt: r.cnt, sessions: r.sessions }; });

    // Session stats
    const sessionStats = await pool.query(`
      SELECT COUNT(*)::int as total_sessions,
             COUNT(DISTINCT visitor_id)::int as unique_visitors,
             AVG(EXTRACT(EPOCH FROM (last_seen_at - first_seen_at)))::int as avg_duration,
             COUNT(*) FILTER (WHERE page_count <= 1)::numeric / NULLIF(COUNT(*), 0) * 100 as bounce_rate
      FROM analytics_sessions WHERE first_seen_at >= $1 AND first_seen_at <= $2
    `, [dayStart, dayEnd]);
    const ss = sessionStats.rows[0] || {};

    // Revenue from order_completed events (or from orders table)
    const revenueRes = await pool.query(`
      SELECT COALESCE(SUM(total), 0) as revenue FROM orders
      WHERE created_at >= $1 AND created_at <= $2 AND status != 'cancelled'
    `, [dayStart, dayEnd]);

    // Cart abandonment: sessions with add_to_cart but no order_completed
    const cartAbandonment = await pool.query(`
      SELECT
        COUNT(DISTINCT session_id) FILTER (WHERE event_type = 'add_to_cart')::int as cart_sessions,
        COUNT(DISTINCT session_id) FILTER (WHERE event_type = 'order_completed')::int as order_sessions
      FROM analytics_events WHERE created_at >= $1 AND created_at <= $2
    `, [dayStart, dayEnd]);
    const ca = cartAbandonment.rows[0] || {};
    const cartAbandonRate = ca.cart_sessions > 0
      ? parseFloat(((ca.cart_sessions - ca.order_sessions) / ca.cart_sessions * 100).toFixed(2))
      : 0;

    // Top search terms
    const topSearches = await pool.query(`
      SELECT LOWER(properties->>'query') as term, COUNT(*)::int as count
      FROM analytics_events WHERE event_type = 'search' AND created_at >= $1 AND created_at <= $2
        AND properties->>'query' IS NOT NULL AND properties->>'query' != ''
      GROUP BY LOWER(properties->>'query') ORDER BY count DESC LIMIT 20
    `, [dayStart, dayEnd]);

    await pool.query(`
      INSERT INTO analytics_daily_stats (stat_date, total_sessions, unique_visitors, page_views,
        product_views, add_to_carts, checkouts_started, orders_completed, searches,
        sample_requests, trade_signups, total_revenue, avg_session_duration_secs,
        bounce_rate, cart_abandonment_rate, top_search_terms)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (stat_date) DO UPDATE SET
        total_sessions = EXCLUDED.total_sessions, unique_visitors = EXCLUDED.unique_visitors,
        page_views = EXCLUDED.page_views, product_views = EXCLUDED.product_views,
        add_to_carts = EXCLUDED.add_to_carts, checkouts_started = EXCLUDED.checkouts_started,
        orders_completed = EXCLUDED.orders_completed, searches = EXCLUDED.searches,
        sample_requests = EXCLUDED.sample_requests, trade_signups = EXCLUDED.trade_signups,
        total_revenue = EXCLUDED.total_revenue, avg_session_duration_secs = EXCLUDED.avg_session_duration_secs,
        bounce_rate = EXCLUDED.bounce_rate, cart_abandonment_rate = EXCLUDED.cart_abandonment_rate,
        top_search_terms = EXCLUDED.top_search_terms
    `, [
      yesterday,
      ss.total_sessions || 0,
      ss.unique_visitors || 0,
      ec.page_view?.cnt || 0,
      ec.product_view?.cnt || 0,
      ec.add_to_cart?.cnt || 0,
      ec.checkout_started?.cnt || 0,
      ec.order_completed?.cnt || 0,
      ec.search?.cnt || 0,
      ec.sample_request?.cnt || 0,
      ec.trade_signup_complete?.cnt || 0,
      parseFloat(revenueRes.rows[0]?.revenue || 0),
      ss.avg_duration || 0,
      parseFloat(ss.bounce_rate || 0).toFixed(2),
      cartAbandonRate,
      JSON.stringify(topSearches.rows)
    ]);

    console.log(`[Analytics] Daily stats aggregated for ${yesterday}`);

    // Refresh search materialized views
    try {
      await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY product_popularity');
      await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY search_vocabulary');
      await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY sku_quality_scores');
      clearSearchCaches();
      console.log('[Analytics] Search materialized views + quality scores refreshed');
    } catch (mvErr) {
      console.error('[Analytics] Matview refresh error:', mvErr.message);
    }

    // Send summary email to admin/manager staff
    try {
      const staffRes = await pool.query(
        "SELECT email FROM staff_accounts WHERE role IN ('admin','manager') AND is_active = true"
      );
      if (staffRes.rows.length > 0) {
        // Get top viewed-not-purchased for email
        const vnp = await pool.query(`
          WITH views AS (
            SELECT properties->>'sku_id' as sku_id, COALESCE(properties->>'product_name','') as product_name,
                   COUNT(*)::int as views
            FROM analytics_events WHERE event_type = 'product_view' AND created_at >= $1 AND created_at <= $2
              AND properties->>'sku_id' IS NOT NULL
            GROUP BY properties->>'sku_id', properties->>'product_name'
          ),
          carts AS (
            SELECT properties->>'sku_id' as sku_id, COUNT(*)::int as carts
            FROM analytics_events WHERE event_type = 'add_to_cart' AND created_at >= $1 AND created_at <= $2
              AND properties->>'sku_id' IS NOT NULL
            GROUP BY properties->>'sku_id'
          )
          SELECT v.product_name, v.views, COALESCE(c.carts, 0) as carts
          FROM views v LEFT JOIN carts c ON c.sku_id = v.sku_id
          ORDER BY v.views DESC LIMIT 5
        `, [dayStart, dayEnd]);

        const zeroSearches = await pool.query(`
          SELECT LOWER(properties->>'query') as term, COUNT(*)::int as count
          FROM analytics_events WHERE event_type = 'search' AND created_at >= $1 AND created_at <= $2
            AND properties->>'query' IS NOT NULL AND properties->>'results_count' IS NOT NULL AND (properties->>'results_count')::int = 0
          GROUP BY LOWER(properties->>'query') ORDER BY count DESC LIMIT 5
        `, [dayStart, dayEnd]);

        await sendDailyAnalyticsSummary(
          staffRes.rows.map(r => r.email),
          {
            stat_date: yesterday,
            total_sessions: ss.total_sessions || 0,
            unique_visitors: ss.unique_visitors || 0,
            page_views: ec.page_view?.cnt || 0,
            product_views: ec.product_view?.cnt || 0,
            add_to_carts: ec.add_to_cart?.cnt || 0,
            checkouts_started: ec.checkout_started?.cnt || 0,
            orders_completed: ec.order_completed?.cnt || 0,
            searches: ec.search?.cnt || 0,
            sample_requests: ec.sample_request?.cnt || 0,
            trade_signups: ec.trade_signup_complete?.cnt || 0,
            total_revenue: parseFloat(revenueRes.rows[0]?.revenue || 0),
            avg_session_duration_secs: ss.avg_duration || 0,
            bounce_rate: parseFloat(ss.bounce_rate || 0),
            cart_abandonment_rate: cartAbandonRate,
            top_search_terms: topSearches.rows,
            top_viewed_not_purchased: vnp.rows,
            zero_result_searches: zeroSearches.rows
          }
        );
      }
    } catch (emailErr) {
      console.error('[Analytics] Email summary error:', emailErr.message);
    }

    // Quality digest email
    try {
      const staffRes2 = await pool.query("SELECT email FROM staff_accounts WHERE role IN ('admin','manager') AND is_active = true");
      if (staffRes2.rows.length > 0) {
        const overallRes = await pool.query(`
          SELECT ROUND(AVG(quality_score))::int as avg_score, COUNT(*)::int as total_skus,
            COUNT(*) FILTER (WHERE quality_score >= 80) as good,
            COUNT(*) FILTER (WHERE quality_score >= 50 AND quality_score < 80) as fair,
            COUNT(*) FILTER (WHERE quality_score < 50) as poor,
            COUNT(*) FILTER (WHERE has_image = 0) as no_image,
            COUNT(*) FILTER (WHERE has_retail = 0) as no_price,
            COUNT(*) FILTER (WHERE has_color = 0) as no_color,
            COUNT(*) FILTER (WHERE has_description = 0) as no_description
          FROM sku_quality_scores
        `);
        const vendorRes = await pool.query(`
          SELECT vendor_name, ROUND(AVG(quality_score))::int as avg_score, COUNT(*)::int as sku_count,
            COUNT(*) FILTER (WHERE has_image = 0) as no_image,
            COUNT(*) FILTER (WHERE has_retail = 0) as no_price,
            COUNT(*) FILTER (WHERE has_color = 0) as no_color
          FROM sku_quality_scores
          GROUP BY vendor_name HAVING ROUND(AVG(quality_score)) < 80
          ORDER BY AVG(quality_score) ASC
        `);
        const worstRes = await pool.query(`
          SELECT vendor_name, product_name, internal_sku, quality_score
          FROM sku_quality_scores ORDER BY quality_score ASC, internal_sku LIMIT 10
        `);
        const vendors = vendorRes.rows.map(v => {
          const issues = [];
          if (v.no_image > 0) issues.push(`${v.no_image} no image`);
          if (v.no_price > 0) issues.push(`${v.no_price} no price`);
          if (v.no_color > 0) issues.push(`${v.no_color} no color`);
          return { ...v, issues };
        });
        await sendQualityDigest(
          staffRes2.rows.map(r => r.email),
          {
            generated_at: new Date().toISOString(),
            overall: overallRes.rows[0],
            vendors,
            worst_skus: worstRes.rows
          }
        );
        console.log('[Analytics] Quality digest sent');
      }
    } catch (qdErr) {
      console.error('[Analytics] Quality digest error:', qdErr.message);
    }
  } catch (err) {
    console.error('[Analytics] Daily aggregation error:', err.message);
  }
}, { timezone: 'America/Los_Angeles' });

// Daily scraper health check at 7:15 AM Pacific
cron.schedule('15 7 * * *', async () => {
  console.log('[ScraperHealth] Running daily health check...');
  try {
    const healthData = await computeScraperHealth();
    const problemCount = healthData.summary.warning + healthData.summary.critical;
    console.log(`[ScraperHealth] ${healthData.summary.total_sources} sources: ${healthData.summary.healthy} healthy, ${healthData.summary.warning} warning, ${healthData.summary.critical} critical`);
    if (problemCount > 0) {
      const staffRes = await pool.query("SELECT email FROM staff_accounts WHERE role IN ('admin','manager') AND is_active = true");
      if (staffRes.rows.length > 0) {
        await sendScraperHealthCheck(staffRes.rows.map(r => r.email), healthData);
      }
    }
  } catch (err) {
    console.error('[ScraperHealth] Daily health check error:', err.message);
  }
}, { timezone: 'America/Los_Angeles' });

// Analytics retention cron: purge raw events > 90 days (Sundays 3 AM Pacific)
cron.schedule('0 3 * * 0', async () => {
  console.log('[Analytics] Running retention cleanup...');
  try {
    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
    const result = await pool.query('DELETE FROM analytics_events WHERE created_at < $1', [cutoff]);
    console.log(`[Analytics] Purged ${result.rowCount} events older than 90 days`);
    const sessResult = await pool.query('DELETE FROM analytics_sessions WHERE last_seen_at < $1', [cutoff]);
    console.log(`[Analytics] Purged ${sessResult.rowCount} sessions older than 90 days`);
  } catch (err) {
    console.error('[Analytics] Retention cleanup error:', err.message);
  }
}, { timezone: 'America/Los_Angeles' });

// Auto-task cron: stuck deals + trade renewal reminders (8 AM Pacific daily)
cron.schedule('0 8 * * *', async () => {
  console.log('[AutoTask] Running daily auto-task generation...');
  try {
    // A. Deals stuck >7 days in lead/quoted/negotiating
    const stuckDeals = await pool.query(`
      SELECT d.id, d.rep_id, d.title, d.customer_name, d.customer_email, d.stage, d.stage_entered_at,
        d.linked_quote_id, d.linked_estimate_id, d.linked_order_id
      FROM deals d
      WHERE d.stage IN ('lead','quoted','negotiating')
        AND d.stage_entered_at < NOW() - INTERVAL '7 days'
    `);
    let stuckCount = 0;
    for (const deal of stuckDeals.rows) {
      const daysStuck = Math.floor((Date.now() - new Date(deal.stage_entered_at).getTime()) / 86400000);
      const created = await createAutoTask(pool, deal.rep_id, 'deal_stuck', deal.id,
        `Move deal forward — ${deal.title}`, {
          priority: daysStuck > 14 ? 'high' : 'medium',
          due_date: new Date().toISOString().split('T')[0],
          description: `Deal has been in "${deal.stage}" stage for ${daysStuck} days`,
          customer_name: deal.customer_name, customer_email: deal.customer_email,
          linked_deal_id: deal.id, linked_quote_id: deal.linked_quote_id,
          linked_estimate_id: deal.linked_estimate_id, linked_order_id: deal.linked_order_id
        });
      if (created) stuckCount++;
    }
    console.log(`[AutoTask] Created ${stuckCount} stuck-deal tasks from ${stuckDeals.rows.length} candidates`);

    // B. Trade subscriptions expiring within 30 days
    const expiringTrade = await pool.query(`
      SELECT tc.id, tc.company_name, tc.contact_name, tc.email, tc.phone,
        tc.subscription_expires_at, tc.assigned_rep_id
      FROM trade_customers tc
      WHERE tc.subscription_status = 'active'
        AND tc.subscription_expires_at BETWEEN NOW() AND NOW() + INTERVAL '30 days'
    `);
    let renewalCount = 0;
    for (const tc of expiringTrade.rows) {
      let repId = tc.assigned_rep_id;
      if (!repId) {
        const fallback = await pool.query('SELECT id FROM sales_reps WHERE is_active = true ORDER BY created_at LIMIT 1');
        repId = fallback.rows.length ? fallback.rows[0].id : null;
      }
      if (!repId) continue;
      const daysUntil = Math.floor((new Date(tc.subscription_expires_at).getTime() - Date.now()) / 86400000);
      const dueDate = new Date(new Date(tc.subscription_expires_at).getTime() - 14 * 86400000).toISOString().split('T')[0];
      const created = await createAutoTask(pool, repId, 'trade_renewal', tc.id,
        `Renewal reminder — ${tc.company_name}`, {
          priority: daysUntil <= 7 ? 'high' : 'medium',
          due_date: dueDate,
          description: `Trade membership expires in ${daysUntil} days (${new Date(tc.subscription_expires_at).toLocaleDateString()})`,
          customer_name: tc.contact_name, customer_email: tc.email, customer_phone: tc.phone
        });
      if (created) renewalCount++;
    }
    console.log(`[AutoTask] Created ${renewalCount} renewal tasks from ${expiringTrade.rows.length} candidates`);
  } catch (err) {
    console.error('[AutoTask] Daily auto-task cron error:', err.message);
  }
}, { timezone: 'America/Los_Angeles' });

// Customer routes — extracted to routes/customer.js
app.use(createCustomerRoutes({
  pool, customerAuth, optionalCustomerAuth,
  hashPassword, verifyPassword,
  sendPasswordReset, sendWelcomeSetPassword,
  recalculateBalance: (orderId, client) => recalculateBalance(pool, orderId, client),
  generatePDF, generateSampleRequestConfirmationHtml
}));

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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
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
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/admin/installation-inquiries/:id', staffAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM installation_inquiries WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Inquiry not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  }
});

// === Sitemap XML ===
function generateSlugBackend(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

app.get('/api/sitemap.xml', async (req, res) => {
  try {
    const baseUrl = (process.env.SITE_URL || 'https://romaflooringdesigns.com').replace(/\/+$/, '');
    const today = new Date().toISOString().split('T')[0];

    const [productsResult, categoriesResult, collectionsResult] = await Promise.all([
      pool.query(`SELECT DISTINCT ON (p.id) p.id, p.slug as product_slug, c.slug as category_slug, COALESCE(p.display_name, p.name) as product_name, p.updated_at FROM products p JOIN skus s ON s.product_id = p.id AND s.status = 'active' AND s.is_sample = false AND COALESCE(s.variant_type, '') NOT IN ('accessory','trim','floor_trim','wall_trim','lvt_trim','quarry_trim','mosaic_trim') LEFT JOIN categories c ON c.id = p.category_id WHERE p.status = 'active' ORDER BY p.id`),
      pool.query(`SELECT slug FROM categories WHERE is_active = true ORDER BY slug`),
      pool.query(`SELECT DISTINCT collection as name FROM products WHERE status = 'active' AND collection IS NOT NULL AND collection != '' ORDER BY collection`)
    ]);

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    // Static pages
    const staticPages = ['/', '/shop', '/collections', '/trade', '/privacy', '/terms'];
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

    // Product pages (one URL per product, using slug-based paths)
    for (const row of productsResult.rows) {
      const lastmod = row.updated_at ? new Date(row.updated_at).toISOString().split('T')[0] : today;
      if (row.product_slug && row.category_slug) {
        xml += `  <url><loc>${baseUrl}/shop/${encodeURIComponent(row.category_slug)}/${encodeURIComponent(row.product_slug)}</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq><priority>0.9</priority></url>\n`;
      } else {
        // Fallback for products without slugs
        const slug = generateSlugBackend(row.product_name);
        xml += `  <url><loc>${baseUrl}/shop/sku/${row.id}/${encodeURIComponent(slug)}</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq><priority>0.9</priority></url>\n`;
      }
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

    // Order documents table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_documents (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
        doc_type VARCHAR(50) NOT NULL,
        file_name TEXT NOT NULL,
        file_key TEXT NOT NULL,
        file_size INTEGER,
        mime_type TEXT,
        uploaded_by UUID REFERENCES staff_accounts(id),
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_order_documents_order ON order_documents(order_id);
    `);
    console.log('Migrations: Order documents table applied');
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
        status VARCHAR(20) DEFAULT 'pending',
        notes TEXT,
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

  // Product slug column for SEO-friendly URLs
  try {
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS slug TEXT`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS products_slug_unique ON products (slug) WHERE slug IS NOT NULL`);
    console.log('Migrations: Product slug column applied');
  } catch (err) {
    console.error('Migration warning:', err.message);
  }

  // Sequential number sequences
  try {
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS order_number_seq START WITH 10001`);
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS quote_number_seq START WITH 1001`);
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS estimate_number_seq START WITH 1001`);
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS sample_number_seq START WITH 1001`);
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS po_number_seq START WITH 1001`);
    console.log('Migrations: Sequential number sequences applied');
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
    order_number: 'RD-10001',
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
    order_number: 'RD-10001',
    customer_name: 'Maria Santos',
    tracking_number: '1Z999AA10123456784',
    shipping_carrier: 'UPS',
    shipped_at: new Date().toISOString()
  }),

  quoteSent: () => generateQuoteSentHTML({
    quote_number: 'RDQ-1001',
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
    request_number: 'RDS-1001',
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
    request_number: 'RDS-1001',
    delivery_method: 'pickup',
    items: [
      { product_name: 'Smoky Grey Porcelain', collection: 'Modern Edge', variant_name: '12x24 Matte', primary_image: '' },
    ]
  }),

  sampleRequestShipped: () => generateSampleRequestShippedHTML({
    customer_name: 'Jennifer Lee',
    request_number: 'RDS-1001',
    tracking_number: '9400111899223033005282',
    items: [
      { product_name: 'European White Oak', collection: 'Heritage Collection', variant_name: '7" Wide Plank Natural', primary_image: '' },
      { product_name: 'Calacatta Gold Marble', collection: 'Luxe Stone', variant_name: '24x24 Polished', primary_image: '' },
    ]
  }),

  'sampleRequestShipped-noTracking': () => generateSampleRequestShippedHTML({
    customer_name: 'Jennifer Lee',
    request_number: 'RDS-1001',
    tracking_number: '',
    items: [
      { product_name: 'Smoky Grey Porcelain', collection: 'Modern Edge', variant_name: '12x24 Matte', primary_image: '' },
    ]
  }),
};

// Index page listing all templates (dev only)
app.get('/api/dev/email-preview', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found' });
  const names = Object.keys(EMAIL_PREVIEW_TEMPLATES);
  const links = names.map(n => `<li style="margin:4px 0;"><a href="/api/dev/email-preview/${n}" target="_blank" style="color:#292524;font-size:15px;">${n}</a></li>`).join('');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Email Template Preview</title>
    <style>body{font-family:Inter,Arial,sans-serif;max-width:600px;margin:40px auto;padding:0 20px;color:#1c1917;}
    h1{font-family:'Cormorant Garamond',Georgia,serif;font-weight:400;font-size:28px;margin-bottom:8px;}
    p{color:#78716c;font-size:14px;}ul{list-style:none;padding:0;}a{text-decoration:none;}a:hover{text-decoration:underline;}</style>
    </head><body><h1>Email Template Preview</h1><p>${names.length} templates available</p><ul>${links}</ul></body></html>`);
});

// Individual template render (dev only)
app.get('/api/dev/email-preview/:name', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found' });
  const generator = EMAIL_PREVIEW_TEMPLATES[req.params.name];
  if (!generator) return res.status(404).send('Template not found. <a href="/api/dev/email-preview">View all templates</a>');
  try {
    res.send(generator());
  } catch (err) {
    console.error('Email preview render error:', err);
    res.status(500).send('<pre>Error rendering template</pre>');
  }
});

// Centralized error handler — prevent stack traces leaking to clients
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({ error: 'Internal server error' });
});

runMigrations().then(() => {
  app.listen(PORT, () => {
    console.log(`API running on port ${PORT}`);
    initScheduler();
  });
});
