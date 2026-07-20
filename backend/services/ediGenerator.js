/**
 * EDI X12 850 Purchase Order Generator
 *
 * Builds valid ANSI X12 850 documents for electronic PO transmission.
 * Supports Shaw's hard/soft surface split requirement.
 */

// Shaw hard surface categories (everything else is soft/carpet)
const SHAW_HARD_SURFACE_CATEGORIES = [
  'hardwood', 'laminate', 'vinyl', 'lvt', 'lvp', 'spc', 'wpc',
  'tile', 'stone', 'resilient', 'rigid core', 'engineered hardwood',
];

function padRight(str, len) {
  const s = String(str || '');
  return s.length >= len ? s.substring(0, len) : s + ' '.repeat(len - s.length);
}

function padLeft(str, len, char = '0') {
  const s = String(str || '');
  return s.length >= len ? s.substring(0, len) : char.repeat(len - s.length) + s;
}

function formatDate(date) {
  const d = date || new Date();
  const y = d.getFullYear().toString();
  const m = padLeft(d.getMonth() + 1, 2);
  const day = padLeft(d.getDate(), 2);
  return y + m + day;
}

function formatTime(date) {
  const d = date || new Date();
  return padLeft(d.getHours(), 2) + padLeft(d.getMinutes(), 2);
}

/**
 * Atomically get and increment a control number for a vendor.
 * Wraps at 999999999.
 */
export async function getNextControlNumber(pool, vendorId, type) {
  const result = await pool.query(
    `UPDATE edi_control_numbers
     SET last_number = CASE WHEN last_number >= 999999999 THEN 1 ELSE last_number + 1 END
     WHERE vendor_id = $1 AND number_type = $2
     RETURNING last_number`,
    [vendorId, type]
  );
  if (!result.rows.length) {
    // Auto-create if missing
    const ins = await pool.query(
      `INSERT INTO edi_control_numbers (vendor_id, number_type, last_number)
       VALUES ($1, $2, 1)
       ON CONFLICT (vendor_id, number_type) DO UPDATE SET last_number = edi_control_numbers.last_number + 1
       RETURNING last_number`,
      [vendorId, type]
    );
    return ins.rows[0].last_number;
  }
  return result.rows[0].last_number;
}

/**
 * Determine if a PO item is hard surface based on its category.
 */
function isHardSurface(item, ediConfig) {
  const cats = ediConfig.hard_surface_categories || SHAW_HARD_SURFACE_CATEGORIES;
  const cat = (item.category_name || '').toLowerCase();
  return cats.some(c => cat.includes(c.toLowerCase()));
}

/**
 * Build a single X12 850 document.
 * @param {object} opts - { po, items, ediConfig, icn, gcn, tcn, now }
 * @returns {string} X12 content
 */
function build850(opts) {
  const { po, items, ediConfig, icn, gcn, tcn, now } = opts;
  const seg = ediConfig.segment_terminator || '~';
  const ele = ediConfig.element_separator || '*';
  const sub = ediConfig.sub_element_separator || ':';
  const date8 = formatDate(now);
  const time4 = formatTime(now);
  const senderId = padRight(ediConfig.sender_id || 'ROMAFLOOR', 15);
  const senderQual = padRight(ediConfig.sender_qualifier || 'ZZ', 2);
  const receiverId = padRight(ediConfig.receiver_id || 'SHAWFLOORS', 15);
  const receiverQual = padRight(ediConfig.receiver_qualifier || 'ZZ', 2);
  const icnStr = padLeft(icn, 9);
  const gcnStr = padLeft(gcn, 9);
  const tcnStr = padLeft(tcn, 4);

  const segments = [];

  // ISA — Interchange Control Header (fixed-width fields)
  segments.push([
    'ISA',
    '00',                       // Auth Info Qualifier
    padRight('', 10),           // Auth Info
    '00',                       // Security Info Qualifier
    padRight('', 10),           // Security Info
    senderQual,                 // Interchange Sender Qualifier
    senderId,                   // Interchange Sender ID
    receiverQual,               // Interchange Receiver Qualifier
    receiverId,                 // Interchange Receiver ID
    date8.substring(2),         // Interchange Date (YYMMDD)
    time4,                      // Interchange Time
    'U',                        // Repetition Separator
    '00401',                    // Interchange Control Version
    icnStr,                     // Interchange Control Number
    '0',                        // Acknowledgment Requested
    ediConfig.usage_indicator || 'P', // Usage Indicator (P=Production, T=Test)
    sub,                        // Component Element Separator
  ].join(ele));

  // GS — Functional Group Header
  segments.push([
    'GS', 'PO',
    (ediConfig.gs_sender_id || 'ROMAFLOOR').trim(),
    (ediConfig.gs_receiver_id || 'SHAWFLOORS').trim(),
    date8,
    time4,
    gcnStr,
    'X',
    '004010',
  ].join(ele));

  // ST — Transaction Set Header
  segments.push(['ST', '850', tcnStr].join(ele));

  // BEG — Beginning Segment for PO
  segments.push([
    'BEG', '00', 'NE', po.po_number, '', date8,
  ].join(ele));

  // REF — Account number
  if (ediConfig.account_number) {
    segments.push(['REF', 'IA', ediConfig.account_number].join(ele));
  }

  // N1/N3/N4 — Ship-To
  segments.push(['N1', 'ST', 'Roma Flooring Designs', '92', ediConfig.account_number || '0133954'].join(ele));
  segments.push(['N3', '1440 S State College Blvd Ste 6M'].join(ele));
  segments.push(['N4', 'Anaheim', 'CA', '92806', 'US'].join(ele));

  // PO1 + PID per line item
  let lineNum = 0;
  for (const item of items) {
    lineNum++;
    const qty = item.qty || 0;
    const unit = item.sell_by === 'box' ? 'SF' : item.sell_by === 'roll' ? 'SY' : 'EA';
    const price = parseFloat(item.cost || 0).toFixed(2);
    const vendorSku = item.vendor_sku || '';

    // PO1 — Baseline Item Data
    const po1Parts = ['PO1', padLeft(lineNum, 4), String(qty), unit, price, 'PE'];
    if (vendorSku) {
      po1Parts.push('VP', vendorSku);
    }
    segments.push(po1Parts.join(ele));

    // PID — Product/Item Description
    const desc = (item.product_name || item.description || '').substring(0, 80);
    if (desc) {
      segments.push(['PID', 'F', '08', '', '', desc].join(ele));
    }
  }

  // CTT — Transaction Totals
  segments.push(['CTT', String(lineNum)].join(ele));

  // SE — Transaction Set Trailer
  const segCount = segments.length - 1; // segments after ST, including SE
  segments.push(['SE', String(segCount), tcnStr].join(ele));

  // GE — Functional Group Trailer
  segments.push(['GE', '1', gcnStr].join(ele));

  // IEA — Interchange Control Trailer
  segments.push(['IEA', '1', icnStr].join(ele));

  return segments.join(seg + '\n') + seg + '\n';
}

/**
 * Generate 850 Purchase Order document(s) for a PO.
 * If the PO mixes hard + soft surface items (Shaw requirement), splits into two 850s.
 *
 * @param {Pool} pool - PostgreSQL pool
 * @param {string} purchaseOrderId - UUID of the purchase order
 * @param {object} ediConfig - vendor.edi_config JSONB
 * @returns {Array<{ content, filename, icn }>}
 */
export async function generate850(pool, purchaseOrderId, ediConfig) {
  // Fetch PO
  const poResult = await pool.query(
    `SELECT po.*, v.name as vendor_name
     FROM purchase_orders po
     JOIN vendors v ON v.id = po.vendor_id
     WHERE po.id = $1`,
    [purchaseOrderId]
  );
  if (!poResult.rows.length) throw new Error(`PO not found: ${purchaseOrderId}`);
  const po = poResult.rows[0];

  // Fetch items with category info
  const itemsResult = await pool.query(
    `SELECT poi.*, c.name as category_name
     FROM purchase_order_items poi
     LEFT JOIN skus s ON s.id = poi.sku_id
     LEFT JOIN products p ON p.id = s.product_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE poi.purchase_order_id = $1
     ORDER BY poi.created_at`,
    [purchaseOrderId]
  );
  const allItems = itemsResult.rows;
  if (!allItems.length) throw new Error(`PO has no items: ${po.po_number}`);

  const now = new Date();
  const results = [];

  // Check if we need hard/soft split
  const hardItems = allItems.filter(i => isHardSurface(i, ediConfig));
  const softItems = allItems.filter(i => !isHardSurface(i, ediConfig));
  const needsSplit = hardItems.length > 0 && softItems.length > 0;

  if (needsSplit) {
    // Two separate 850s
    for (const [suffix, items] of [['H', hardItems], ['S', softItems]]) {
      if (!items.length) continue;
      const icn = await getNextControlNumber(pool, po.vendor_id, 'interchange');
      const gcn = await getNextControlNumber(pool, po.vendor_id, 'group');
      const tcn = await getNextControlNumber(pool, po.vendor_id, 'transaction');
      const content = build850({ po, items, ediConfig, icn, gcn, tcn, now });
      const filename = `850_${po.po_number}_${suffix}_${padLeft(icn, 9)}.edi`;
      results.push({ content, filename, icn });
    }
  } else {
    // Single 850
    const icn = await getNextControlNumber(pool, po.vendor_id, 'interchange');
    const gcn = await getNextControlNumber(pool, po.vendor_id, 'group');
    const tcn = await getNextControlNumber(pool, po.vendor_id, 'transaction');
    const content = build850({ po, items: allItems, ediConfig, icn, gcn, tcn, now });
    const filename = `850_${po.po_number}_${padLeft(icn, 9)}.edi`;
    results.push({ content, filename, icn });
  }

  return results;
}

// ===========================================================================
// 997 Functional Acknowledgment
// ---------------------------------------------------------------------------
// A 997 is the receiver's confirmation back to the sender that an inbound
// interchange (e.g. an 832 price catalog) was received and syntactically
// accepted. Without it, the trading partner's monitoring shows our account as
// "not consuming the feed" even when we imported the data successfully.
// ===========================================================================

/**
 * Extract the functional groups + transaction sets from a received X12 interchange
 * so we can reference them (GS01/GS06/ST counts) in the acknowledgment.
 *
 * @param {string} raw - the received EDI file content
 * @param {object} ediConfig - vendor edi_config (for the element separator)
 * @returns {{ usageIndicator: string|null, groups: Array<{groupCode, groupControlNumber, version, transactionSets: Array<{code, control}>}> }}
 */
export function parseReceivedEnvelope(raw, ediConfig = {}) {
  const ele = ediConfig.element_separator || '*';
  const text = String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Standard X12 uses ~ as the segment terminator; fall back to newlines.
  const rawSegs = text.includes('~') ? text.split('~') : text.split('\n');
  const segments = rawSegs
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.split(ele));

  let usageIndicator = null;
  let interchange = null; // received ISA addressing, so the ack can reverse it
  const groups = [];
  let current = null;

  for (const el of segments) {
    switch (el[0]) {
      case 'ISA':
        // ISA05/06 = sender qualifier/ID, ISA07/08 = receiver qualifier/ID,
        // ISA15 = usage indicator (P=production, T=test).
        interchange = {
          senderQual: (el[5] || '').trim(),
          senderId: (el[6] || '').trim(),
          receiverQual: (el[7] || '').trim(),
          receiverId: (el[8] || '').trim(),
        };
        usageIndicator = (el[15] || '').trim() || null;
        break;
      case 'GS':
        current = {
          groupCode: (el[1] || '').trim(),          // GS01 — e.g. "SC" for an 832
          gsSenderId: (el[2] || '').trim(),         // GS02
          gsReceiverId: (el[3] || '').trim(),       // GS03
          groupControlNumber: (el[6] || '').trim(), // GS06
          version: (el[8] || '').trim() || '004010',// GS08
          transactionSets: [],
        };
        break;
      case 'ST':
        if (current) current.transactionSets.push({ code: (el[1] || '').trim(), control: (el[2] || '').trim() });
        break;
      case 'GE':
        if (current) { groups.push(current); current = null; }
        break;
    }
  }
  if (current) groups.push(current); // GS with no closing GE — still acknowledge it

  return { usageIndicator, interchange, groups };
}

/**
 * Build a single X12 997 acknowledging one received functional group.
 * @param {object} opts - { ediConfig, icn, gcn, tcn, now, ackGroup, usageIndicator }
 * @returns {string} X12 content
 */
function build997(opts) {
  const { ediConfig, icn, gcn, tcn, now, ackGroup, usageIndicator, interchange } = opts;
  const seg = ediConfig.segment_terminator || '~';
  const ele = ediConfig.element_separator || '*';
  const sub = ediConfig.sub_element_separator || ':';
  const date8 = formatDate(now);
  const time4 = formatTime(now);
  // An acknowledgment reverses the received interchange: we become the sender,
  // the partner the receiver, echoing the exact qualifiers/IDs they used so
  // their system matches the ack. Fall back to edi_config if not parsed.
  const rx = interchange || {};
  const senderQual = padRight((rx.receiverQual || ediConfig.sender_qualifier || 'ZZ').trim(), 2);
  const senderId = padRight((rx.receiverId || ediConfig.sender_id || 'ROMAFLOOR').trim(), 15);
  const receiverQual = padRight((rx.senderQual || ediConfig.receiver_qualifier || 'ZZ').trim(), 2);
  const receiverId = padRight((rx.senderId || ediConfig.receiver_id || '').trim(), 15);
  const icnStr = padLeft(icn, 9);
  const gcnStr = padLeft(gcn, 9);
  const tcnStr = padLeft(tcn, 4);
  const n = ackGroup.transactionSets.length || 0;

  const segments = [];

  // ISA — Interchange Control Header (we are the sender; the partner is the receiver)
  segments.push([
    'ISA', '00', padRight('', 10), '00', padRight('', 10),
    senderQual, senderId, receiverQual, receiverId,
    date8.substring(2), time4, 'U', '00401', icnStr, '0',
    // Match the environment of the interchange we're acknowledging.
    usageIndicator || ediConfig.usage_indicator || 'P', sub,
  ].join(ele));

  // GS — Functional Group Header. "FA" = Functional Acknowledgment.
  // Reverse the received group's GS02/GS03 so the app-level routing matches too.
  const gsSender = (ackGroup.gsReceiverId || ediConfig.gs_sender_id || ediConfig.sender_id || 'ROMAFLOOR').trim();
  const gsReceiver = (ackGroup.gsSenderId || ediConfig.gs_receiver_id || ediConfig.receiver_id || '').trim();
  segments.push([
    'GS', 'FA', gsSender, gsReceiver,
    date8, time4, gcnStr, 'X', ackGroup.version || '004010',
  ].join(ele));

  // ST — Transaction Set Header
  segments.push(['ST', '997', tcnStr].join(ele));
  // AK1 — echoes the received group's functional ID code + control number
  segments.push(['AK1', ackGroup.groupCode || '', ackGroup.groupControlNumber || ''].join(ele));
  // AK9 — Functional Group Response Trailer: A=Accepted, then #TS included/received/accepted
  segments.push(['AK9', 'A', String(n), String(n), String(n)].join(ele));
  // SE — Transaction Set Trailer (ST, AK1, AK9, SE = 4 segments)
  segments.push(['SE', '4', tcnStr].join(ele));

  // GE / IEA — Functional Group + Interchange Trailers
  segments.push(['GE', '1', gcnStr].join(ele));
  segments.push(['IEA', '1', icnStr].join(ele));

  return segments.join(seg + '\n') + seg + '\n';
}

/**
 * Generate 997 acknowledgment document(s) for a received EDI file — one per
 * functional group found in the interchange (normally one).
 *
 * @param {Pool} pool
 * @param {string} vendorId - UUID of the trading partner
 * @param {object} ediConfig - vendor edi_config JSONB
 * @param {string} receivedRaw - the received file content
 * @param {string} receivedFilename - the received filename (for labeling)
 * @returns {Promise<Array<{ content, filename, icn, ackGroup }>>}
 */
export async function generate997(pool, vendorId, ediConfig, receivedRaw, receivedFilename) {
  const { usageIndicator, interchange, groups } = parseReceivedEnvelope(receivedRaw, ediConfig);
  if (!groups.length) return [];

  const now = new Date();
  const base = String(receivedFilename || 'catalog').replace(/[^\w.-]/g, '_');
  const results = [];

  for (const ackGroup of groups) {
    const icn = await getNextControlNumber(pool, vendorId, 'interchange');
    const gcn = await getNextControlNumber(pool, vendorId, 'group');
    const tcn = await getNextControlNumber(pool, vendorId, 'transaction');
    const content = build997({ ediConfig, icn, gcn, tcn, now, ackGroup, usageIndicator, interchange });
    const filename = `997_${base}_${padLeft(icn, 9)}.edi`;
    results.push({ content, filename, icn, ackGroup });
  }

  return results;
}
