#!/usr/bin/env node
/**
 * fix-ef-lvt-inventory.mjs
 *
 * One-off backfill for EF LVT inventory snapshots written by the
 * engfloors-webservices scraper before 2026-07-26. PriceInquiry truncates
 * LVT AvailableQuantity to a single character (1490 SF → "1"), so every
 * snapshot landed with 1–9 "sqft" and 0 boxes — all SKUs read out-of-stock.
 *
 * Re-queries InventoryInquiry (full-precision SF) for each EF SKU that has
 * a snapshot and rewrites qty_on_hand_sqft + derived qty_on_hand (boxes).
 *
 * Usage:
 *   docker exec flooring-api node scripts/fix-ef-lvt-inventory.mjs --dry-run
 *   docker exec flooring-api node scripts/fix-ef-lvt-inventory.mjs
 */

import https from 'https';
import crypto from 'crypto';
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

function httpsGet(url, agent) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { Accept: 'text/xml, application/xml' },
      timeout: 20000,
      agent,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function xmlText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

async function main() {
  console.log(`=== Fix EF LVT inventory ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'} ===`);

  const srcRes = await pool.query(
    "SELECT config FROM vendor_sources WHERE scraper_key = 'engfloors-webservices'"
  );
  const cfg = {
    api_key: process.env.EF_B2B_API_KEY || '',
    secret_key: process.env.EF_B2B_SECRET_KEY || '',
    client_id: process.env.EF_CLIENT_ID || '',
    base_url: 'https://www.engfloors.info/B2B',
    ...(srcRes.rows[0]?.config || {}),
  };
  const baseUrl = cfg.base_url.replace(/\/+$/, '');

  const { rows: skus } = await pool.query(`
    SELECT s.id, s.vendor_sku, isnap.warehouse, isnap.qty_on_hand_sqft AS old_sqft,
      pk.sqft_per_box
    FROM inventory_snapshots isnap
    JOIN skus s ON s.id = isnap.sku_id
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN packaging pk ON pk.sku_id = s.id
    WHERE v.code = 'EF' AND isnap.warehouse = 'EF-main'
    ORDER BY s.vendor_sku
  `);
  console.log(`${skus.length} EF snapshots to re-check`);

  const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
  let updated = 0, empty = 0, errors = 0;

  for (const sku of skus) {
    const params = new URLSearchParams({
      ApiKey: cfg.api_key, Signature: cfg.secret_key, ClientIdentifier: cfg.client_id,
      SupplierItemSKU: sku.vendor_sku, TimeStamp: new Date().toISOString(),
      GlobalIdentifier: crypto.randomUUID(),
    });
    let res;
    try {
      res = await httpsGet(`${baseUrl}/InventoryInquiry?${params}`, agent);
    } catch (err) {
      errors++;
      console.log(`  ERROR ${sku.vendor_sku}: ${err.message}`);
      continue;
    }
    if (res.status !== 200) {
      errors++;
      console.log(`  ERROR ${sku.vendor_sku}: HTTP ${res.status}`);
      continue;
    }

    const qtyRaw = xmlText(res.body, 'AvailableQuantity');
    const uom = xmlText(res.body, 'AvailableUnitOfMeasure') || 'SF';
    const qty = (qtyRaw && qtyRaw !== 'NA') ? parseFloat(qtyRaw) : null;
    if (qty === null || !(qty > 0)) {
      empty++;
      console.log(`  no qty for ${sku.vendor_sku} (was ${sku.old_sqft} sqft) — leaving as-is`);
      continue;
    }

    const sqft = uom === 'SY' ? Math.round(qty * 9) : Math.round(qty);
    const spb = parseFloat(sku.sqft_per_box);
    const boxes = spb > 0 ? Math.floor(sqft / spb) : Math.round(sqft);

    console.log(`  ${sku.vendor_sku}: ${sku.old_sqft} sqft → ${sqft} sqft (${boxes} boxes)`);
    if (!DRY_RUN) {
      await pool.query(`
        UPDATE inventory_snapshots
        SET qty_on_hand = $3, qty_on_hand_sqft = $4,
          snapshot_time = CURRENT_TIMESTAMP,
          fresh_until = CURRENT_TIMESTAMP + INTERVAL '24 hours'
        WHERE sku_id = $1 AND warehouse = $2
      `, [sku.id, sku.warehouse, boxes, sqft]);
    }
    updated++;
    await new Promise(r => setTimeout(r, 150));
  }

  agent.destroy();
  console.log(`\nDone: ${updated} updated, ${empty} no-qty (left as-is), ${errors} errors`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
