/**
 * EDI X12 Parser for inbound documents (855, 856, 810).
 *
 * Parses raw X12 content into structured objects.
 */

/**
 * Parse raw X12 content into envelope + transaction sets.
 * Auto-detects element separator, segment terminator, and sub-element separator from ISA.
 */
export function parseX12(raw) {
  if (!raw || raw.length < 106) throw new Error('Invalid X12: content too short');

  // ISA is always 106 chars; element separator is char at position 3
  const elementSep = raw[3];
  // Sub-element separator is char at position 104
  const subElementSep = raw[104];
  // Segment terminator is char at position 105 (may be followed by newline)
  let segTerminator = raw[105];
  // Handle \r\n or \n after segment terminator
  const cleanRaw = raw.replace(/\r\n/g, '\n');

  // Split into segments
  const segments = cleanRaw
    .split(segTerminator)
    .map(s => s.replace(/^\s+|\s+$/g, ''))
    .filter(s => s.length > 0)
    .map(s => s.split(elementSep));

  // Extract envelope info
  const isa = segments.find(s => s[0] === 'ISA');
  const iea = segments.find(s => s[0] === 'IEA');
  const gs = segments.find(s => s[0] === 'GS');

  const envelope = {
    senderId: isa ? (isa[6] || '').trim() : '',
    receiverId: isa ? (isa[8] || '').trim() : '',
    interchangeControlNumber: isa ? parseInt(isa[13], 10) : 0,
    functionalGroupCode: gs ? (gs[1] || '') : '',
    elementSep,
    subElementSep,
    segTerminator,
  };

  // Extract transaction sets (ST..SE pairs)
  const transactionSets = [];
  let current = null;
  for (const seg of segments) {
    if (seg[0] === 'ST') {
      current = { type: seg[1], controlNumber: seg[2], segments: [] };
    }
    if (current) {
      current.segments.push(seg);
    }
    if (seg[0] === 'SE' && current) {
      transactionSets.push(current);
      current = null;
    }
  }

  return { envelope, transactionSets };
}

/**
 * Parse an 855 Purchase Order Acknowledgment transaction set.
 *
 * Returns:
 * - ackType: 'AC' (accepted), 'AD' (accepted with changes), 'RD' (rejected)
 * - poNumber: referenced PO number
 * - lineItems: [{ lineNumber, vendorSku, qty, status, statusDesc }]
 */
export function parse855(txnSet) {
  const segs = txnSet.segments;
  const result = {
    ackType: null,
    poNumber: null,
    poDate: null,
    lineItems: [],
  };

  for (const seg of segs) {
    switch (seg[0]) {
      case 'BAK': {
        // BAK*AC*AT*PO_NUMBER*DATE
        result.ackType = seg[1] || null;  // AC, AD, RD
        result.poNumber = seg[3] || null;
        result.poDate = seg[4] || null;
        break;
      }
      case 'PO1': {
        // PO1*line*qty*unit*price*basis*qualifier*sku
        const lineItem = {
          lineNumber: parseInt(seg[1], 10) || 0,
          qty: parseFloat(seg[2]) || 0,
          unitOfMeasure: seg[3] || '',
          unitPrice: parseFloat(seg[4]) || 0,
          vendorSku: '',
          status: null,
          statusDesc: '',
          qtyOrdered: parseFloat(seg[2]) || 0,
        };
        // Find vendor SKU in VP qualifier
        for (let i = 5; i < seg.length - 1; i++) {
          if (seg[i] === 'VP') {
            lineItem.vendorSku = seg[i + 1] || '';
            break;
          }
        }
        result.lineItems.push(lineItem);
        break;
      }
      case 'ACK': {
        // ACK*status*qty*unit*date_qualifier*date
        // Status: IA=accepted, IB=backordered, IR=rejected, IC=changed
        const lastItem = result.lineItems[result.lineItems.length - 1];
        if (lastItem) {
          lastItem.status = seg[1] || null;
          lastItem.statusDesc = ackStatusDescription(seg[1]);
          if (seg[2]) lastItem.qty = parseFloat(seg[2]) || lastItem.qty;
        }
        break;
      }
    }
  }

  return result;
}

/**
 * Parse an 856 Advance Ship Notice transaction set.
 *
 * Returns:
 * - shipmentId: BSN shipment identification
 * - shipDate: from BSN
 * - trackingNumbers: []
 * - carrier: { scac, name }
 * - bolNumber: bill of lading
 * - lineItems: [{ vendorSku, qtyShipped, dyeLot }]
 */
export function parse856(txnSet) {
  const segs = txnSet.segments;
  const result = {
    shipmentId: null,
    shipDate: null,
    trackingNumbers: [],
    carrier: { scac: null, name: null },
    bolNumber: null,
    lineItems: [],
    poNumber: null,
  };

  let currentHL = null;  // current hierarchy level
  let pendingVendorSku = null; // LIN often appears before SN1

  for (const seg of segs) {
    switch (seg[0]) {
      case 'BSN': {
        // BSN*purpose*shipment_id*date*time
        result.shipmentId = seg[2] || null;
        result.shipDate = seg[3] || null;
        break;
      }
      case 'HL': {
        // HL*id*parent*level_code
        // Level codes: S=shipment, O=order, I=item
        currentHL = seg[3] || '';
        pendingVendorSku = null;
        break;
      }
      case 'TD5': {
        // TD5*routing_seq*id_code_qual*scac*transport_method*carrier_name
        if (seg[3]) result.carrier.scac = seg[3];
        if (seg[5]) result.carrier.name = seg[5];
        break;
      }
      case 'REF': {
        // REF*qualifier*value
        const qual = seg[1] || '';
        const val = seg[2] || '';
        if (qual === 'CN' || qual === '2I') {
          // Carrier tracking number
          if (val && !result.trackingNumbers.includes(val)) {
            result.trackingNumbers.push(val);
          }
        } else if (qual === 'BM') {
          // Bill of Lading
          result.bolNumber = val;
        } else if (qual === 'PO') {
          result.poNumber = val;
        }
        break;
      }
      case 'PRF': {
        // PRF*po_number
        if (seg[1]) result.poNumber = seg[1];
        break;
      }
      case 'LIN': {
        // LIN often comes before SN1 in 856 — buffer the vendor SKU
        for (let i = 1; i < seg.length - 1; i++) {
          if (seg[i] === 'VP') {
            pendingVendorSku = seg[i + 1] || '';
            break;
          }
        }
        // Also apply to last item if SN1 already created it
        const lastItem = result.lineItems[result.lineItems.length - 1];
        if (lastItem && !lastItem.vendorSku && pendingVendorSku) {
          lastItem.vendorSku = pendingVendorSku;
        }
        break;
      }
      case 'SN1': {
        // SN1*assign_number*qty_shipped*unit_of_measure
        const item = {
          qtyShipped: parseFloat(seg[2]) || 0,
          unitOfMeasure: seg[3] || '',
          vendorSku: pendingVendorSku || null,
          dyeLot: null,
        };
        pendingVendorSku = null;
        result.lineItems.push(item);
        break;
      }
    }

    // Check for dye lot in REF segments at item level
    if (seg[0] === 'REF' && currentHL === 'I') {
      const qual = seg[1] || '';
      const val = seg[2] || '';
      if (qual === 'LS' || qual === 'LT') {
        // Lot/dye lot number
        const lastItem = result.lineItems[result.lineItems.length - 1];
        if (lastItem) lastItem.dyeLot = val;
      }
    }
  }

  return result;
}

/**
 * Parse an 810 Invoice transaction set.
 *
 * Returns:
 * - invoiceNumber, invoiceDate, poNumber
 * - totalAmount (from TDS, converted from cents)
 * - lineItems: [{ lineNumber, vendorSku, description, qty, unit, unitPrice, subtotal }]
 */
export function parse810(txnSet) {
  const segs = txnSet.segments;
  const result = {
    invoiceNumber: null,
    invoiceDate: null,
    poNumber: null,
    totalAmount: null,
    lineItems: [],
  };

  for (const seg of segs) {
    switch (seg[0]) {
      case 'BIG': {
        // BIG*invoice_date*invoice_number*orig_date*po_number
        result.invoiceDate = seg[1] || null;
        result.invoiceNumber = seg[2] || null;
        result.poNumber = seg[4] || null;
        break;
      }
      case 'IT1': {
        // IT1*line_num*qty*unit*price*basis*qualifier*sku
        const item = {
          lineNumber: parseInt(seg[1], 10) || 0,
          qty: parseFloat(seg[2]) || 0,
          unitOfMeasure: seg[3] || '',
          unitPrice: parseFloat(seg[4]) || 0,
          vendorSku: '',
          description: '',
          subtotal: 0,
        };
        // Find vendor SKU
        for (let i = 5; i < seg.length - 1; i++) {
          if (seg[i] === 'VP') {
            item.vendorSku = seg[i + 1] || '';
            break;
          }
        }
        item.subtotal = parseFloat((item.qty * item.unitPrice).toFixed(2));
        result.lineItems.push(item);
        break;
      }
      case 'PID': {
        // PID*F*08***description
        const lastItem = result.lineItems[result.lineItems.length - 1];
        if (lastItem && seg[5]) {
          lastItem.description = seg[5];
        }
        break;
      }
      case 'TDS': {
        // TDS*total_in_cents
        const cents = parseInt(seg[1], 10) || 0;
        result.totalAmount = parseFloat((cents / 100).toFixed(2));
        break;
      }
    }
  }

  return result;
}

/**
 * Identify the document type from a parsed transaction set.
 */
export function identifyDocumentType(txnSet) {
  return txnSet.type; // '855', '856', '810', etc.
}

function ackStatusDescription(code) {
  const map = {
    'IA': 'Accepted',
    'IB': 'Backordered',
    'IC': 'Changed',
    'ID': 'Cancelled',
    'IF': 'On Hold',
    'IR': 'Rejected',
    'IS': 'Substituted',
  };
  return map[code] || code || 'Unknown';
}
