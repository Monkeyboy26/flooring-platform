/**
 * Generic EDI Poller — Inbound 855/856/810 processor
 *
 * Works with both SFTP (Shaw) and FTP (EF) transports based on
 * vendor edi_config.transport field ('sftp' or 'ftp').
 *
 * Runs on schedule to check vendor outbox for new EDI documents
 * and processes them automatically.
 *
 * Document types handled:
 * - 855: PO Acknowledgment → updates PO status + line item statuses
 * - 856: ASN/Ship Notice → extracts tracking, carrier, dye lots
 * - 810: Invoice → creates invoice records for AP reconciliation
 */

import { createSftpConnection, downloadFile as sftpDownload, moveToArchive as sftpArchive, listFiles as sftpList, uploadFile as sftpUpload } from '../services/ediSftp.js';
import { createFtpConnection, downloadFile as ftpDownload, moveToArchive as ftpArchive, listFiles as ftpList, uploadFile as ftpUpload } from '../services/ediFtp.js';
import { parseX12, parse855, parse856, parse810, identifyDocumentType } from '../services/ediParser.js';
import { generate997 } from '../services/ediGenerator.js';
import { createRepNotification } from '../lib/notifications.js';

const EDI_EXTENSIONS = ['edi', 'x12', 'txt', 'dat', '810', '855', '856'];

/**
 * Create a transport adapter that normalizes SFTP and FTP APIs.
 */
async function createTransport(ediConfig) {
  const transport = (ediConfig.transport || 'sftp').toLowerCase();

  if (transport === 'ftp') {
    const client = await createFtpConnection({
      ftp_host: ediConfig.ftp_host,
      ftp_port: ediConfig.ftp_port || 21,
      ftp_user: ediConfig.ftp_user,
      ftp_pass: ediConfig.ftp_pass,
      ftp_secure: ediConfig.ftp_secure || false,
    });
    return {
      type: 'ftp',
      client,
      listFiles: (dir, exts) => ftpList(client, dir, exts),
      downloadFile: (path) => ftpDownload(client, path),
      uploadFile: (path, content) => ftpUpload(client, path, content),
      moveToArchive: (src, archDir) => ftpArchive(client, src, archDir),
      close: () => client.close(),
    };
  }

  // Default: SFTP
  const sftp = await createSftpConnection({
    sftp_host: ediConfig.sftp_host,
    sftp_port: ediConfig.sftp_port || 22,
    sftp_user: ediConfig.sftp_user,
    sftp_pass: ediConfig.sftp_pass,
  });
  return {
    type: 'sftp',
    client: sftp,
    listFiles: (dir, exts) => sftpList(sftp, dir, exts),
    downloadFile: (path) => sftpDownload(sftp, path),
    uploadFile: (path, content) => sftpUpload(sftp, path, content),
    moveToArchive: (src, archDir) => sftpArchive(sftp, src, archDir),
    close: async () => { try { await sftp.end(); } catch (_) {} },
  };
}

/**
 * Send a 997 Functional Acknowledgment back to the vendor confirming we received
 * their EDI file (one 997 per received functional group). Opt-in per vendor via
 * edi_config.send_997 — many vendors don't want a 997, so it's off by default.
 */
async function send997(pool, transport, ediConfig, source, raw, filename) {
  if (!ediConfig.send_997) return 0;
  const dir = ediConfig.ack_997_dir || ediConfig.inbox_dir || '/Inbox';
  const vendorCode = source.vendor_code || 'UNKNOWN';
  let sent = 0;
  try {
    const acks = await generate997(pool, source.vendor_id, ediConfig, raw, filename);
    for (const ack of acks) {
      // Retry the STOR — a transient "550 STOR failed" clears on a short backoff.
      let ok = false, lastErr = null;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try { await transport.uploadFile(`${dir}/${ack.filename}`, ack.content); ok = true; }
        catch (e) { lastErr = e; if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1500)); }
      }
      await pool.query(
        `INSERT INTO edi_transactions
         (vendor_id, document_type, direction, filename, interchange_control_number, status, raw_content, error_message, processed_at, created_at)
         VALUES ($1, '997', 'outbound', $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [source.vendor_id, ack.filename, ack.icn, ack.content, ok ? 'sent' : 'error', ok ? null : (lastErr && lastErr.message)]);
      if (ok) sent++;
    }
    if (sent) console.log(`[EDI Poller:${vendorCode}] Sent ${sent} 997 ack(s) for ${filename}`);
  } catch (err) {
    console.error(`[EDI Poller:${vendorCode}] 997 send failed for ${filename}:`, err.message);
  }
  return sent;
}

export async function run(pool, job, source) {
  const config = source.config || {};
  const ediConfig = config.edi || config;
  const vendorCode = source.vendor_code || 'UNKNOWN';

  const outboxDir = ediConfig.outbox_dir || '/Outbox';
  const archiveDir = ediConfig.outbox_archive_dir || `${outboxDir}/Archive`;

  let transport;
  let stats = { files_found: 0, processed: 0, errors: 0, skipped: 0, by_type: {} };

  try {
    transport = await createTransport(ediConfig);
    console.log(`[EDI Poller:${vendorCode}] Connected via ${transport.type}, checking ${outboxDir}`);

    // List files in outbox
    const files = await transport.listFiles(outboxDir, EDI_EXTENSIONS);
    stats.files_found = files.length;

    if (!files.length) {
      console.log(`[EDI Poller:${vendorCode}] No new files in outbox`);
      return stats;
    }

    // Get already-processed filenames to avoid reprocessing
    const processed = await pool.query(
      `SELECT filename FROM edi_transactions WHERE vendor_id = $1 AND filename IS NOT NULL`,
      [source.vendor_id]
    );
    const processedSet = new Set(processed.rows.map(r => r.filename));

    for (const file of files) {
      if (processedSet.has(file.name)) {
        stats.skipped++;
        console.log(`[EDI Poller:${vendorCode}] Skipping already-processed: ${file.name}`);
        continue;
      }

      try {
        console.log(`[EDI Poller:${vendorCode}] Processing: ${file.name}`);
        const raw = await transport.downloadFile(file.path);
        const res = await processRawEdi(pool, raw, source, { filename: file.name });
        for (const [t, n] of Object.entries(res.by_type)) stats.by_type[t] = (stats.by_type[t] || 0) + n;
        stats.errors += res.errors;

        // Send a 997 receipt ack back to the vendor (opt-in via edi_config.send_997)
        stats.acks_sent = (stats.acks_sent || 0) + await send997(pool, transport, ediConfig, source, raw, file.name);

        // Move to archive
        try {
          await transport.moveToArchive(file.path, archiveDir);
        } catch (archiveErr) {
          console.error(`[EDI Poller:${vendorCode}] Failed to archive ${file.name}:`, archiveErr.message);
        }

        stats.processed++;
      } catch (fileErr) {
        console.error(`[EDI Poller:${vendorCode}] Error with file ${file.name}:`, fileErr.message);
        stats.errors++;
      }
    }
  } finally {
    if (transport) {
      try { await transport.close(); } catch (_) {}
    }
  }

  console.log(`[EDI Poller:${vendorCode}] Done — ${stats.processed} processed, ${stats.skipped} skipped, ${stats.errors} errors`);
  return stats;
}

/**
 * Parse a raw X12 payload and dispatch each transaction set to its handler.
 * Shared by the scheduled poller (run) and the manual test-ingest endpoint,
 * so both take the exact same code path. Returns a summary of what was handled.
 */
export async function processRawEdi(pool, raw, source, { filename } = {}) {
  const vendorCode = source.vendor_code || 'UNKNOWN';
  const { envelope, transactionSets } = parseX12(raw);
  const summary = { by_type: {}, errors: 0, handled: [] };

  for (const txnSet of transactionSets) {
    const docType = identifyDocumentType(txnSet);
    summary.by_type[docType] = (summary.by_type[docType] || 0) + 1;

    const txnResult = await pool.query(
      `INSERT INTO edi_transactions
       (vendor_id, document_type, direction, filename, interchange_control_number, status, raw_content, created_at)
       VALUES ($1, $2, 'inbound', $3, $4, 'received', $5, CURRENT_TIMESTAMP)
       RETURNING id`,
      [source.vendor_id, docType, filename || null, envelope.interchangeControlNumber, raw]
    );
    const txnId = txnResult.rows[0].id;

    try {
      let result = null;
      switch (docType) {
        case '855': result = await handle855(pool, txnId, txnSet, source.vendor_id, vendorCode); break;
        case '856': result = await handle856(pool, txnId, txnSet, source.vendor_id, vendorCode); break;
        case '810': result = await handle810(pool, txnId, txnSet, source.vendor_id, vendorCode); break;
        default: console.log(`[EDI Poller:${vendorCode}] Unhandled document type: ${docType}`);
      }
      await pool.query(
        `UPDATE edi_transactions SET status = 'processed', processed_at = CURRENT_TIMESTAMP WHERE id = $1`, [txnId]);
      summary.handled.push({ doc_type: docType, txn_id: txnId, result });
    } catch (handlerErr) {
      console.error(`[EDI Poller:${vendorCode}] Error processing ${docType}${filename ? ' from ' + filename : ''}:`, handlerErr.message);
      await pool.query(
        `UPDATE edi_transactions SET status = 'failed', error_message = $2 WHERE id = $1`, [txnId, handlerErr.message]);
      summary.errors++;
      summary.handled.push({ doc_type: docType, txn_id: txnId, error: handlerErr.message });
    }
  }
  return summary;
}

/**
 * Handle 855 — PO Acknowledgment
 */
async function handle855(pool, txnId, txnSet, vendorId, vendorCode) {
  const ack = parse855(txnSet);
  if (!ack.poNumber) {
    console.log(`[EDI Poller:${vendorCode}] 855 has no PO number, skipping`);
    return { matched: false, reason: 'no_po_number' };
  }

  // Find the PO
  const poResult = await pool.query(
    `SELECT id, po_number, order_id, status FROM purchase_orders WHERE po_number = $1 AND vendor_id = $2`,
    [ack.poNumber, vendorId]
  );
  if (!poResult.rows.length) {
    console.log(`[EDI Poller:${vendorCode}] 855: PO ${ack.poNumber} not found`);
    return { matched: false, po_number: ack.poNumber, reason: 'po_not_found' };
  }
  const po = poResult.rows[0];

  // Link transaction to PO
  await pool.query(
    `UPDATE edi_transactions SET purchase_order_id = $2, order_id = $3 WHERE id = $1`,
    [txnId, po.id, po.order_id]
  );

  // Determine overall ack status
  let overallStatus = 'accepted';
  if (ack.ackType === 'RD') {
    overallStatus = 'rejected';
  } else if (ack.ackType === 'AD') {
    overallStatus = 'partial';
  } else {
    const hasRejected = ack.lineItems.some(i => i.status === 'IR');
    const hasBackordered = ack.lineItems.some(i => i.status === 'IB');
    if (hasRejected && ack.lineItems.some(i => i.status === 'IA')) {
      overallStatus = 'partial';
    } else if (hasRejected && !ack.lineItems.some(i => i.status === 'IA')) {
      overallStatus = 'rejected';
    } else if (hasBackordered) {
      overallStatus = 'partial';
    }
  }

  // Update PO. Only a CLEAN acceptance advances sent → acknowledged (Confirmed);
  // a rejected/partial (backordered/changed) ack records edi_ack_status but keeps
  // the PO 'sent' so it never reads "Confirmed" and stays flagged for the rep.
  const advance = po.status === 'sent' && overallStatus === 'accepted';
  await pool.query(
    `UPDATE purchase_orders
     SET edi_ack_status = $2, edi_ack_received_at = CURRENT_TIMESTAMP,
         ${advance ? "status = 'acknowledged', " : ''}updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [po.id, overallStatus]
  );

  // Update line items by matching vendor_sku or line number
  const poItems = await pool.query(
    `SELECT id, vendor_sku FROM purchase_order_items WHERE purchase_order_id = $1 ORDER BY created_at`,
    [po.id]
  );

  for (const ackLine of ack.lineItems) {
    let matchedItem = null;
    if (ackLine.vendorSku) {
      matchedItem = poItems.rows.find(i => i.vendor_sku === ackLine.vendorSku);
    }
    if (!matchedItem && ackLine.lineNumber > 0 && ackLine.lineNumber <= poItems.rows.length) {
      matchedItem = poItems.rows[ackLine.lineNumber - 1];
    }

    if (matchedItem && ackLine.status) {
      const statusMap = { 'IA': 'accepted', 'IB': 'backordered', 'IR': 'rejected', 'IC': 'changed' };
      const ediLineStatus = statusMap[ackLine.status] || ackLine.status;
      await pool.query(
        `UPDATE purchase_order_items SET edi_line_status = $2 WHERE id = $1`,
        [matchedItem.id, ediLineStatus]
      );
    }
  }

  // Log activity — distinct action per outcome so the timeline reads clearly.
  const action = overallStatus === 'accepted' ? 'edi_acknowledged'
    : overallStatus === 'rejected' ? 'edi_ack_rejected' : 'edi_ack_partial';
  await pool.query(
    `INSERT INTO po_activity_log (purchase_order_id, action, details)
     VALUES ($1, $2, $3)`,
    [po.id, action, JSON.stringify({ ack_type: ack.ackType, overall_status: overallStatus, line_count: ack.lineItems.length })]
  );

  // Notify the order's rep — a clean accept is informational; a rejected/partial
  // ack needs attention (backordered/changed/rejected lines).
  const ord = await pool.query('SELECT order_number, sales_rep_id FROM orders WHERE id = $1', [po.order_id]);
  const repId = ord.rows[0] && ord.rows[0].sales_rep_id;
  if (repId) {
    const orderNo = ord.rows[0].order_number;
    if (overallStatus === 'accepted') {
      await createRepNotification(pool, repId, 'po_acknowledged',
        `PO ${po.po_number} acknowledged by ${vendorCode}`,
        `${orderNo} — vendor acknowledged the order via EDI 855`, 'order', po.order_id);
    } else {
      await createRepNotification(pool, repId, 'po_ack_issue',
        `PO ${po.po_number} — vendor flagged ${overallStatus === 'rejected' ? 'rejected' : 'backordered/changed'} line(s)`,
        `${orderNo} — review the EDI 855 acknowledgment (${overallStatus})`, 'order', po.order_id);
    }
  }

  console.log(`[EDI Poller:${vendorCode}] 855: PO ${ack.poNumber} ack=${overallStatus}`);
  return { matched: true, po_number: po.po_number, order_id: po.order_id, overall_status: overallStatus,
    confirmed: overallStatus === 'accepted', line_count: ack.lineItems.length };
}

/**
 * Handle 856 — Advance Ship Notice
 */
async function handle856(pool, txnId, txnSet, vendorId, vendorCode) {
  const asn = parse856(txnSet);
  if (!asn.poNumber) {
    console.log(`[EDI Poller:${vendorCode}] 856 has no PO number, skipping`);
    return;
  }

  // Find the PO
  const poResult = await pool.query(
    `SELECT po.id, po.order_id, po.status FROM purchase_orders po
     WHERE po.po_number = $1 AND po.vendor_id = $2`,
    [asn.poNumber, vendorId]
  );
  if (!poResult.rows.length) {
    console.log(`[EDI Poller:${vendorCode}] 856: PO ${asn.poNumber} not found`);
    return;
  }
  const po = poResult.rows[0];

  // Link transaction to PO + order
  await pool.query(
    `UPDATE edi_transactions SET purchase_order_id = $2, order_id = $3 WHERE id = $1`,
    [txnId, po.id, po.order_id]
  );

  // Update order with tracking info (append, don't overwrite)
  if (po.order_id && asn.trackingNumbers.length) {
    const orderResult = await pool.query(`SELECT tracking_number FROM orders WHERE id = $1`, [po.order_id]);
    const existingTracking = orderResult.rows[0]?.tracking_number || '';
    const existingNums = existingTracking ? existingTracking.split(',').map(s => s.trim()) : [];
    const newNums = asn.trackingNumbers.filter(n => !existingNums.includes(n));

    if (newNums.length) {
      const allTracking = [...existingNums, ...newNums].join(', ');
      await pool.query(
        `UPDATE orders SET tracking_number = $2, shipped_at = COALESCE(shipped_at, CURRENT_TIMESTAMP),
         shipping_carrier = COALESCE(shipping_carrier, $3), status = CASE WHEN status IN ('pending', 'confirmed', 'processing') THEN 'shipped' ELSE status END
         WHERE id = $1`,
        [po.order_id, allTracking, asn.carrier.name || asn.carrier.scac]
      );
    }
  }

  // Update PO items with dye lots and qty shipped
  const poItems = await pool.query(
    `SELECT id, vendor_sku, qty FROM purchase_order_items WHERE purchase_order_id = $1 ORDER BY created_at`,
    [po.id]
  );

  for (const asnLine of asn.lineItems) {
    let matchedItem = null;
    if (asnLine.vendorSku) {
      matchedItem = poItems.rows.find(i => i.vendor_sku === asnLine.vendorSku);
    }

    if (matchedItem) {
      const updates = [];
      const params = [matchedItem.id];
      let paramIdx = 2;

      if (asnLine.qtyShipped) {
        updates.push(`qty_shipped = COALESCE(qty_shipped, 0) + $${paramIdx}`);
        params.push(asnLine.qtyShipped);
        paramIdx++;
      }
      if (asnLine.dyeLot) {
        updates.push(`dye_lot = $${paramIdx}`);
        params.push(asnLine.dyeLot);
        paramIdx++;
      }
      updates.push(`status = 'shipped'`);

      if (updates.length) {
        await pool.query(
          `UPDATE purchase_order_items SET ${updates.join(', ')} WHERE id = $1`,
          params
        );
      }
    }
  }

  // Check if all PO items are shipped → auto-fulfill PO
  const updatedItems = await pool.query(
    `SELECT status FROM purchase_order_items WHERE purchase_order_id = $1`,
    [po.id]
  );
  const allShipped = updatedItems.rows.every(i => i.status === 'shipped' || i.status === 'received');
  if (allShipped) {
    await pool.query(
      `UPDATE purchase_orders SET status = 'fulfilled', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [po.id]
    );
  }

  // Log activity
  await pool.query(
    `INSERT INTO po_activity_log (purchase_order_id, action, details)
     VALUES ($1, 'edi_shipped', $2)`,
    [po.id, JSON.stringify({
      shipment_id: asn.shipmentId,
      tracking_numbers: asn.trackingNumbers,
      carrier: asn.carrier,
      items_shipped: asn.lineItems.length,
    })]
  );

  console.log(`[EDI Poller:${vendorCode}] 856: PO ${asn.poNumber} shipped (${asn.trackingNumbers.join(', ')})`);
}

/**
 * Handle 810 — Invoice
 */
async function handle810(pool, txnId, txnSet, vendorId, vendorCode) {
  const inv = parse810(txnSet);
  if (!inv.invoiceNumber) {
    console.log(`[EDI Poller:${vendorCode}] 810 has no invoice number, skipping`);
    return;
  }

  // Try to match PO
  let purchaseOrderId = null;
  let orderId = null;
  if (inv.poNumber) {
    const poResult = await pool.query(
      `SELECT id, order_id FROM purchase_orders WHERE po_number = $1 AND vendor_id = $2`,
      [inv.poNumber, vendorId]
    );
    if (poResult.rows.length) {
      purchaseOrderId = poResult.rows[0].id;
      orderId = poResult.rows[0].order_id;
    }
  }

  // Link transaction
  await pool.query(
    `UPDATE edi_transactions SET purchase_order_id = $2, order_id = $3 WHERE id = $1`,
    [txnId, purchaseOrderId, orderId]
  );

  // Create invoice
  const invoiceResult = await pool.query(
    `INSERT INTO edi_invoices
     (vendor_id, edi_transaction_id, invoice_number, invoice_date, po_number, purchase_order_id, total_amount, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      vendorId, txnId, inv.invoiceNumber,
      inv.invoiceDate ? formatEdiDate(inv.invoiceDate) : null,
      inv.poNumber, purchaseOrderId, inv.totalAmount,
      purchaseOrderId ? 'matched' : 'pending',
    ]
  );
  const invoiceId = invoiceResult.rows[0].id;

  // Create invoice line items
  for (const item of inv.lineItems) {
    await pool.query(
      `INSERT INTO edi_invoice_items
       (edi_invoice_id, line_number, vendor_sku, description, qty, unit_of_measure, unit_price, subtotal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [invoiceId, item.lineNumber, item.vendorSku, item.description,
       item.qty, item.unitOfMeasure, item.unitPrice, item.subtotal]
    );
  }

  // Log activity if PO matched
  if (purchaseOrderId) {
    await pool.query(
      `INSERT INTO po_activity_log (purchase_order_id, action, details)
       VALUES ($1, 'edi_invoiced', $2)`,
      [purchaseOrderId, JSON.stringify({
        invoice_number: inv.invoiceNumber,
        total_amount: inv.totalAmount,
        line_count: inv.lineItems.length,
      })]
    );
  }

  console.log(`[EDI Poller:${vendorCode}] 810: Invoice ${inv.invoiceNumber} created (PO: ${inv.poNumber || 'unmatched'})`);
}

/**
 * Convert YYYYMMDD EDI date to YYYY-MM-DD for PostgreSQL.
 */
function formatEdiDate(dateStr) {
  if (!dateStr || dateStr.length < 8) return null;
  return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
}
