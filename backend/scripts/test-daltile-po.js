#!/usr/bin/env node
/**
 * Create a test Purchase Order for Daltile and send the 850 EDI via FTP.
 *
 * Creates:
 *   1. A test order record (required FK for PO)
 *   2. A PO with 3 Daltile SKUs
 *   3. Generates X12 850 document
 *   4. Uploads to Daltile B2B FTP /Inbox
 *
 * Usage: node backend/scripts/test-daltile-po.js
 */
import pg from 'pg';
import { Client as FTPClient } from 'basic-ftp';
import { generate850 } from '../services/ediGenerator.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim',
  user: 'postgres', password: 'postgres',
});

async function run() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── Get Daltile vendor + EDI config ──
    const vendorRes = await client.query(
      "SELECT id, name, edi_config FROM vendors WHERE code = 'DAL'"
    );
    if (!vendorRes.rows.length) throw new Error('Daltile vendor not found');
    const vendor = vendorRes.rows[0];
    const ediConfig = vendor.edi_config;
    console.log(`Vendor: ${vendor.name} (${vendor.id})`);
    console.log(`EDI transport: ${ediConfig.transport}, host: ${ediConfig.ftp_host}`);
    console.log(`Usage indicator: ${ediConfig.usage_indicator} (T=test, P=production)\n`);

    // ── Pick 3 Daltile SKUs with pricing ──
    const skuRes = await client.query(`
      SELECT s.id, s.vendor_sku, s.variant_name, s.sell_by,
             p.name as product_name, p.collection, pr.cost
      FROM skus s
      JOIN products p ON s.product_id = p.id
      JOIN pricing pr ON pr.sku_id = s.id
      WHERE p.vendor_id = $1 AND pr.cost > 0
      ORDER BY random()
      LIMIT 3
    `, [vendor.id]);

    if (skuRes.rows.length < 3) throw new Error('Not enough Daltile SKUs with pricing');

    console.log('Selected SKUs for test PO:');
    for (const s of skuRes.rows) {
      console.log(`  ${s.vendor_sku} — ${s.collection} ${s.product_name} ${s.variant_name} — $${s.cost}/${s.sell_by}`);
    }
    console.log('');

    // ── Create test order (minimal — just for FK) ──
    const orderNumber = 'TEST-' + Date.now();
    const orderRes = await client.query(`
      INSERT INTO orders (id, order_number, customer_email, customer_name, phone,
        shipping_address_line1, shipping_city, shipping_state, shipping_zip,
        subtotal, total, status, delivery_method)
      VALUES (gen_random_uuid(), $1, 'test@romaflooringdesigns.com', 'Test EDI Order',
        '7149990009', '1440 S State College Blvd Ste 6M', 'Anaheim', 'CA', '92806',
        0, 0, 'confirmed', 'shipping')
      RETURNING id
    `, [orderNumber]);
    const orderId = orderRes.rows[0].id;

    // ── Create PO ──
    const poNumber = 'PO-TEST-' + Date.now().toString(36).toUpperCase();
    let subtotal = 0;
    const lineItems = skuRes.rows.map((s, i) => {
      const qty = (i + 1) * 5; // 5, 10, 15 boxes
      const cost = parseFloat(s.cost);
      const lineSubtotal = cost * qty;
      subtotal += lineSubtotal;
      return { ...s, qty, cost, lineSubtotal };
    });

    const poRes = await client.query(`
      INSERT INTO purchase_orders (id, order_id, vendor_id, po_number, status, subtotal, notes, revision)
      VALUES (gen_random_uuid(), $1, $2, $3, 'draft', $4, 'Test EDI PO — automated script', 0)
      RETURNING id
    `, [orderId, vendor.id, poNumber, subtotal.toFixed(2)]);
    const poId = poRes.rows[0].id;

    console.log(`Created PO: ${poNumber} (${poId})`);
    console.log(`  Subtotal: $${subtotal.toFixed(2)}\n`);

    // ── Create PO line items ──
    for (const item of lineItems) {
      await client.query(`
        INSERT INTO purchase_order_items
          (id, purchase_order_id, sku_id, product_name, vendor_sku, description,
           qty, sell_by, cost, original_cost, subtotal, status)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $8, $9, 'pending')
      `, [
        poId, item.id,
        `${item.collection} ${item.product_name}`,
        item.vendor_sku,
        item.variant_name,
        item.qty, item.sell_by,
        item.cost.toFixed(2),
        item.lineSubtotal.toFixed(2),
      ]);
    }
    console.log(`Created ${lineItems.length} line items`);

    // ── Update PO status to sent ──
    await client.query(`
      UPDATE purchase_orders
      SET status = 'sent', revision = 1, approved_at = NOW()
      WHERE id = $1
    `, [poId]);

    await client.query('COMMIT');

    // ── Generate 850 EDI ──
    console.log('\n=== Generating X12 850 ===');
    const docs = await generate850(pool, poId, ediConfig);

    for (const doc of docs) {
      console.log(`\nFilename: ${doc.filename}`);
      console.log(`ICN: ${doc.icn}`);
      console.log(`Content length: ${doc.content.length} chars\n`);
      console.log('--- EDI Content ---');
      console.log(doc.content);
      console.log('--- End EDI ---\n');

      // ── Record EDI transaction ──
      await pool.query(`
        INSERT INTO edi_transactions
          (id, vendor_id, document_type, direction, filename,
           interchange_control_number, purchase_order_id, status, raw_content, created_at)
        VALUES (gen_random_uuid(), $1, '850', 'outbound', $2, $3, $4, 'pending', $5, NOW())
      `, [vendor.id, doc.filename, doc.icn, poId, doc.content]);

      // ── Upload to FTP ──
      console.log(`Uploading to FTP: ${ediConfig.ftp_host}${ediConfig.inbox_dir}/${doc.filename}`);
      const ftp = new FTPClient();
      try {
        await ftp.access({
          host: ediConfig.ftp_host,
          port: ediConfig.ftp_port || 21,
          user: ediConfig.ftp_user,
          password: ediConfig.ftp_pass,
          secure: ediConfig.ftp_secure || false,
        });

        // Upload EDI content as file
        const { Readable } = await import('stream');
        const stream = Readable.from([doc.content]);
        await ftp.uploadFrom(stream, `${ediConfig.inbox_dir}/${doc.filename}`);

        console.log('Upload successful!\n');

        // Update transaction status
        await pool.query(`
          UPDATE edi_transactions SET status = 'sent', processed_at = NOW()
          WHERE vendor_id = $1 AND interchange_control_number = $2 AND document_type = '850'
        `, [vendor.id, doc.icn]);

        // Update PO with ICN
        await pool.query(`
          UPDATE purchase_orders SET edi_interchange_id = $1 WHERE id = $2
        `, [doc.icn, poId]);

        // Verify file is there
        const listing = await ftp.list(ediConfig.inbox_dir);
        console.log(`Files in ${ediConfig.inbox_dir}:`);
        for (const f of listing) {
          console.log(`  ${f.name} (${f.size} bytes)`);
        }
      } finally {
        ftp.close();
      }
    }

    console.log('\n=== Test PO Complete ===');
    console.log(`PO Number: ${poNumber}`);
    console.log(`Order: ${orderNumber}`);
    console.log(`Status: sent (via EDI)`);
    console.log(`Usage: ${ediConfig.usage_indicator === 'T' ? 'TEST' : 'PRODUCTION'}`);

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
