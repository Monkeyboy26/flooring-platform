/**
 * Shaw EDI Poller — Inbound 855/856/810 processor
 *
 * Runs on schedule (every 30 min) to check Shaw's SFTP /Outbox
 * for new EDI documents and processes them automatically.
 *
 * Document types handled:
 * - 855: PO Acknowledgment → updates PO status + line item statuses
 * - 856: ASN/Ship Notice → extracts tracking, carrier, dye lots
 * - 810: Invoice → creates invoice records for AP reconciliation
 */

import { createSftpConnection, downloadFile, moveToArchive, listFiles } from '../services/ediSftp.js';
import { parseX12, parse855, parse856, parse810, identifyDocumentType } from '../services/ediParser.js';

const EDI_EXTENSIONS = ['edi', 'x12', 'txt', 'dat'];

export async function run(pool, job, source) {
  const config = source.config || {};
  const ediConfig = config.edi || config;

  const outboxDir = ediConfig.outbox_dir || '/Outbox';
  const archiveDir = ediConfig.outbox_archive_dir || '/Outbox/Archive';

  let sftp;
  let stats = { files_found: 0, processed: 0, errors: 0, skipped: 0, by_type: {} };

  try {
    sftp = await createSftpConnection({
      sftp_host: ediConfig.sftp_host || config.sftp_host,
      sftp_port: ediConfig.sftp_port || config.sftp_port || 22,
      sftp_user: ediConfig.sftp_user || config.sftp_user,
      sftp_pass: ediConfig.sftp_pass || config.sftp_pass,
    });

    console.log(`[Shaw EDI Poller] Connected to SFTP, checking ${outboxDir}`);

    // List files in outbox
    const files = await listFiles(sftp, outboxDir, EDI_EXTENSIONS);
    stats.files_found = files.length;

    if (!files.length) {
      console.log('[Shaw EDI Poller] No new files in outbox');
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
        console.log(`[Shaw EDI Poller] Skipping already-processed: ${file.name}`);
        continue;
      }

      try {
        console.log(`[Shaw EDI Poller] Processing: ${file.name}`);
        const raw = await downloadFile(sftp, file.path);

        // Parse envelope to identify document type
        const parsed = parseX12(raw);
        const { envelope, transactionSets } = parsed;

        for (const txnSet of transactionSets) {
          const docType = identifyDocumentType(txnSet);
          stats.by_type[docType] = (stats.by_type[docType] || 0) + 1;

          // Record transaction
          const txnResult = await pool.query(
            `INSERT INTO edi_transactions
             (vendor_id, document_type, direction, filename, interchange_control_number, status, raw_content, created_at)
             VALUES ($1, $2, 'inbound', $3, $4, 'received', $5, CURRENT_TIMESTAMP)
             RETURNING id`,
            [source.vendor_id, docType, file.name, envelope.interchangeControlNumber, raw]
          );
          const txnId = txnResult.rows[0].id;

          try {
            switch (docType) {
              case '855':
                await handle855(pool, txnId, txnSet, source.vendor_id);
                break;
              case '856':
                await handle856(pool, txnId, txnSet, source.vendor_id);
                break;
              case '810':
                await handle810(pool, txnId, txnSet, source.vendor_id);
                break;
              default:
                console.log(`[Shaw EDI Poller] Unhandled document type: ${docType}`);
            }

            await pool.query(
              `UPDATE edi_transactions SET status = 'processed', processed_at = CURRENT_TIMESTAMP WHERE id = $1`,
              [txnId]
            );
          } catch (handlerErr) {
            console.error(`[Shaw EDI Poller] Error processing ${docType} from ${file.name}:`, handlerErr.message);
            await pool.query(
              `UPDATE edi_transactions SET status = 'failed', error_message = $2 WHERE id = $1`,
              [txnId, handlerErr.message]
            );
            stats.errors++;
          }
        }

        // Move to archive
        try {
          await moveToArchive(sftp, file.path, archiveDir);
        } catch (archiveErr) {
          console.error(`[Shaw EDI Poller] Failed to archive ${file.name}:`, archiveErr.message);
        }

        stats.processed++;
      } catch (fileErr) {
        console.error(`[Shaw EDI Poller] Error with file ${file.name}:`, fileErr.message);
        stats.errors++;
      }
    }
  } finally {
    if (sftp) {
      try { await sftp.end(); } catch (_) {}
    }
  }

  console.log(`[Shaw EDI Poller] Done — ${stats.processed} processed, ${stats.skipped} skipped, ${stats.errors} errors`);
  return stats;
}

/**
 * Handle 855 — PO Acknowledgment
 */
async function handle855(pool, txnId, txnSet, vendorId) {
  const ack = parse855(txnSet);
  if (!ack.poNumber) {
    console.log('[Shaw EDI Poller] 855 has no PO number, skipping');
    return;
  }

  // Find the PO
  const poResult = await pool.query(
    `SELECT id, order_id, status FROM purchase_orders WHERE po_number = $1 AND vendor_id = $2`,
    [ack.poNumber, vendorId]
  );
  if (!poResult.rows.length) {
    console.log(`[Shaw EDI Poller] 855: PO ${ack.poNumber} not found`);
    return;
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
    // Check line items for mixed statuses
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

  // Update PO
  await pool.query(
    `UPDATE purchase_orders
     SET edi_ack_status = $2, edi_ack_received_at = CURRENT_TIMESTAMP,
         status = CASE WHEN status = 'sent' THEN 'acknowledged' ELSE status END,
         updated_at = CURRENT_TIMESTAMP
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

    // Match by vendor SKU first
    if (ackLine.vendorSku) {
      matchedItem = poItems.rows.find(i => i.vendor_sku === ackLine.vendorSku);
    }
    // Fall back to line number
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

  // Log activity
  await pool.query(
    `INSERT INTO po_activity_log (purchase_order_id, action, details)
     VALUES ($1, 'edi_acknowledged', $2)`,
    [po.id, JSON.stringify({ ack_type: ack.ackType, overall_status: overallStatus, line_count: ack.lineItems.length })]
  );

  console.log(`[Shaw EDI Poller] 855: PO ${ack.poNumber} acknowledged (${overallStatus})`);
}

/**
 * Handle 856 — Advance Ship Notice
 */
async function handle856(pool, txnId, txnSet, vendorId) {
  const asn = parse856(txnSet);
  if (!asn.poNumber) {
    console.log('[Shaw EDI Poller] 856 has no PO number, skipping');
    return;
  }

  // Find the PO
  const poResult = await pool.query(
    `SELECT po.id, po.order_id, po.status FROM purchase_orders po
     WHERE po.po_number = $1 AND po.vendor_id = $2`,
    [asn.poNumber, vendorId]
  );
  if (!poResult.rows.length) {
    console.log(`[Shaw EDI Poller] 856: PO ${asn.poNumber} not found`);
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

  console.log(`[Shaw EDI Poller] 856: PO ${asn.poNumber} shipped (${asn.trackingNumbers.join(', ')})`);
}

/**
 * Handle 810 — Invoice
 */
async function handle810(pool, txnId, txnSet, vendorId) {
  const inv = parse810(txnSet);
  if (!inv.invoiceNumber) {
    console.log('[Shaw EDI Poller] 810 has no invoice number, skipping');
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

  console.log(`[Shaw EDI Poller] 810: Invoice ${inv.invoiceNumber} created (PO: ${inv.poNumber || 'unmatched'})`);
}

/**
 * Convert YYYYMMDD EDI date to YYYY-MM-DD for PostgreSQL.
 */
function formatEdiDate(dateStr) {
  if (!dateStr || dateStr.length < 8) return null;
  return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
}
