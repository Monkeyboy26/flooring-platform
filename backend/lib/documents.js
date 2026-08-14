import fs from 'fs';
import path from 'path';
import { laborUnitShort, laborDisplayName } from './estimateBundle.js';

let LOGO_DATA_URI = '';
try {
  const logoPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'assets', 'logo', 'roma-transparent.png');
  const logoBuffer = fs.readFileSync(logoPath);
  LOGO_DATA_URI = `data:image/png;base64,${logoBuffer.toString('base64')}`;
} catch (e) {
  console.warn('Logo file not found — PDFs will render without logo');
}

export { LOGO_DATA_URI };

export function itemDescriptionCell(collection, color, variant) {
  const sub = [color, variant].filter(Boolean).join(' \u00B7 ');
  if (!collection && !sub) return '\u2014';
  let html = collection ? `<span class="item-name">${collection}</span>` : '';
  if (sub) html += `<div class="item-detail">${sub}</div>`;
  return html;
}

function escDoc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Canonical price-unit suffix for document tables — mirrors the storefront's
 * priceSuffix() (/sqft rendered as the PDF-style "/sf"). Slabs sold as a unit
 * but priced per sqft with no known box area show "/sf" since a piece price
 * can't be computed; carpet (roll / per_sqyd) shows "/sqyd"; everything else
 * follows sell_by. Requires the item query to carry price_basis + sqft_per_box.
 */
function priceUnitSuffix(i) {
  i = i || {};
  const basis = i.price_basis;
  const soldPerUnit = i.sell_by ? (i.sell_by === 'unit' || i.sell_by === 'piece') : basis === 'per_unit';
  if (soldPerUnit) {
    if ((basis === 'sqft' || basis === 'per_sqft') && !(parseFloat(i.sqft_per_box) > 0)) return '/sf';
    return '/ea';
  }
  if (i.sell_by ? i.sell_by === 'roll' : basis === 'per_sqyd') return '/sqyd';
  return '/sf';
}

/**
 * The distinguishing tail of a product_name once the collection prefix and color
 * are removed — typically the size (+ finish), e.g. product_name "Ecoslate 24x48"
 * / collection "Ecoslate" / color "White" → "24x48"; "Marmi Lux 24x48, Natural" →
 * "24x48, Natural". Returns null unless the remainder actually carries a
 * dimension/measurement, so a plain product name is never echoed as a descriptor.
 */
/**
 * A size attribute value as a line-item descriptor — but only when it isn't
 * already conveyed. Returns null if the row's existing text (title/color/name)
 * already contains the dimension, or if it's a slab-style item (which shows
 * "Jumbo Slab 3cm" etc. via variant_name, not raw dimensions). Used as a fallback
 * for vendors that keep size ONLY in the size attribute (Emser, Bosphorus, planks)
 * so it shows once the query provides `size` — a no-op until then.
 */
export function sizeFromAttr(sizeAttr, existingText) {
  if (!sizeAttr) return null;
  const ex = String(existingText || '').toLowerCase();
  if (/slab|jumbo|standard|panel|prefab|countertop/.test(ex)) return null;
  const sd = (String(sizeAttr).match(/\d+(?:\.\d+)?\s*[xX×]\s*\d+(?:\.\d+)?/) || [])[0];
  if (!sd) return null;
  const norm = (x) => x.toLowerCase().replace(/["″”'’\s]/g, '').replace(/×/g, 'x');
  if (norm(ex).includes(norm(sd))) return null;
  return String(sizeAttr).trim();
}

export function productExtra(product, collection, color) {
  if (!product) return null;
  let rem = String(product).trim();
  if (collection && rem.toLowerCase().startsWith(String(collection).toLowerCase())) {
    rem = rem.slice(String(collection).length);
  }
  if (color) rem = rem.replace(new RegExp(String(color).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
  rem = rem.replace(/^[\s,··\-–—]+|[\s,··\-–—]+$/g, '').replace(/\s+/g, ' ').trim();
  // Require a real dimension (12x24, 2 cm, 8", 100x100) so we don't repeat names.
  return (rem && /\d\s*(?:[xX×]|["″”'’]|\s*(?:cm|mm|in\b))/.test(rem)) ? rem : null;
}

/**
 * Canonical line-item name composition \u2014 the SINGLE source of truth for how a
 * product/accessory is labeled on every document, email, and screen so items
 * (especially the 1,622 identically-labeled "Reducer" accessories) are always
 * distinguishable. Pass any line-item row that may carry: product_name,
 * collection (or current_collection), color, variant_name, accessory_label,
 * variant_type, vendor_name, vendor_sku, internal_sku.
 *
 * Returns { title, descriptors[], sku, vendor, meta[], nameLine, metaLine, oneLine }.
 *   nameLine = "Poseidon \u00B7 Zephyr \u00B7 9.4 in x 5 ft Plank"  (title \u00B7 descriptors)
 *   metaLine = "Pacific Direct Industries \u00B7 PSDN044"       (vendor \u00B7 sku)
 * Even when the stored snapshot product_name is a bare label ("Reducer"), a live
 * join to products.collection + skus.accessory_label recovers the full identity.
 */
export function composeItemName(it = {}) {
  const g = (k) => (it[k] != null && String(it[k]).trim() !== '') ? String(it[k]).trim() : null;
  const product = g('product_name');
  const collection = g('collection') || g('current_collection');
  const color = g('color');
  const variant = g('variant_name');
  const isAcc = g('variant_type') === 'accessory';
  const accLabel = isAcc ? (g('accessory_label') || variant) : null;
  // Accessory bought for a specific floor: lead with that floor's collection +
  // color, then the accessory itself → "Metropolitan  ·  Los Angeles  ·  T-Moulding".
  // Generic accessory SKUs are shared across floors, so this parent snapshot is
  // the only thing that says which floor it's for. Falls back to the accessory's
  // own collection/name when no parent (see [[line-item-display]]).
  const parentCollection = isAcc ? g('parent_collection') : null;
  const parentColor = isAcc ? g('parent_color') : null;
  let title, ordered;
  if (parentCollection) {
    title = parentCollection;
    ordered = [parentColor, accLabel || product];
  } else {
    title = collection || product || 'Product';
    const design = color || (product && product !== title ? product : null);
    // When a Color already names the design, the size/finish that distinguishes
    // this SKU often lives only in product_name (e.g. collection "Ecoslate", color
    // "White", product_name "Ecoslate 24x48" → "24x48" would otherwise be dropped).
    const sizeInfo = color ? productExtra(product, collection, color) : null;
    // Fallback: size held only in the size attribute (no-op until a query selects it).
    const sizeDesc = sizeFromAttr(g('size'), [title, design, sizeInfo, variant].filter(Boolean).join(' '));
    ordered = [design, sizeInfo, sizeDesc, variant, accLabel];
  }
  // Containment-aware dedup: drop a descriptor already present in what has been
  // assembled so far — an exact echo (color "Shore" + variant "SHORE") or an
  // embedded phrase (color "Arabescato Gold" inside product "Arabescato Gold
  // Quartz Countertop"). Word-bounded + punctuation-insensitive so 9'x52" and
  // 9 x 52 match. Mirrored in formatLineItem (rep/admin) + itemLineName (storefront).
  const normSeg = (s) => (' ' + String(s).toLowerCase()
    .replace(/(\d)\.(\d)/g, '$1§$2')     // protect decimal points (7.5)
    .replace(/[^a-z0-9§]+/g, ' ')        // "Ave." ≈ "Ave", "&" drops
    .replace(/§/g, '.')
    .replace(/(\d(?:\.\d+)?)\s*x\s*(?=\d)/g, '$1x')
    .replace(/\bmou?ldings?\b/g, 'mold') // trim-term stem: "T-Molding" ≈ "T-Mold"
    .replace(/\s+/g, ' ').trim() + ' ');
  let acc = normSeg(title);
  // Partial overlap: iteratively strip already-covered LEADING and TRAILING
  // phrases from a descriptor ("Grafito Bullnose 3X12" after color "Grafito" →
  // "Bullnose 3X12"; "Blanco 2.5x5 Bullnose 2.5X5" → "Bullnose"). A phrase may
  // strip when it's multi-word, digit-bearing, or exactly equals a WHOLE earlier
  // segment — a single plain word inside a longer segment never strips, so
  // "White" (from "White Oak Herringbone") can't truncate color "White Smoke".
  const segsWhole = new Set([normSeg(title)]);
  const stripCovered = (d) => {
    let toks = String(d).trim().split(/\s+/);
    const canStrip = (phrase, k) => {
      const pn = normSeg(phrase);
      if (!pn.trim() || !acc.includes(pn)) return false;
      return k >= 2 || /\d/.test(phrase) || segsWhole.has(pn);
    };
    // Remove ANY covered window (leading, trailing, or interior — Daltile-style
    // comma lists repeat the color mid-descriptor), longest first, until stable.
    let changed = true;
    outer: while (changed && toks.length > 1) {
      changed = false;
      for (let k = toks.length - 1; k >= 1; k--) {
        for (let i = 0; i + k <= toks.length; i++) {
          if (toks.length - k < 1) break;
          if (canStrip(toks.slice(i, i + k).join(' '), k)) {
            toks = toks.slice(0, i).concat(toks.slice(i + k));
            changed = true; continue outer;
          }
        }
      }
    }
    return toks.join(' ');
  };
  // Compound-word echoes ("Stair Nose" vs "Stairnose"): whole-segment equality
  // on space-stripped forms only — never substring, so "Rose" ≠ "Primrose".
  const noSpace = (s) => normSeg(s).replace(/ /g, '');
  const segsNoSpace = new Set([noSpace(title)]);
  const descriptors = [];
  for (const d of ordered) {
    if (!d) continue;
    const p = normSeg(d);
    if (p.trim() === '' || acc.includes(p) || segsNoSpace.has(noSpace(d))) continue;
    const kept = stripCovered(d).replace(/^[\s·\-–—,]+|[\s·\-–—,]+$/g, '').trim();
    const kp = normSeg(kept);
    if (kp.trim() === '' || acc.includes(kp) || segsNoSpace.has(noSpace(kept))) continue;
    descriptors.push(kept);
    acc += kp;
    segsWhole.add(kp);
    segsNoSpace.add(noSpace(kept));
  }
  const sku = g('vendor_sku') || g('internal_sku');
  const vendor = g('vendor_name') || g('custom_vendor');
  const meta = [];
  for (const m of [vendor, sku]) if (m && !meta.includes(m)) meta.push(m);
  // Separator SEP must stay identical to the frontend helpers (formatLineItem in
  // rep.html/admin.html, itemLineName/itemMetaLine in storefront.jsx) so a line
  // item renders identically on every surface \u2014 see [[line-item-display]].
  const SEP = '  \u00B7  ';
  const nameLine = descriptors.length ? `${title}${SEP}${descriptors.join(SEP)}` : title;
  const metaLine = meta.join(SEP);
  const oneLine = [nameLine, metaLine].filter(Boolean).join(SEP);
  return { title, descriptors, sku, vendor, meta, nameLine, metaLine, oneLine };
}

/** Stacked HTML cell: muted brand line (vendor) on top, bold name line in the
 *  middle, muted sku line on the bottom. `opts.showMeta=false` drops BOTH the
 *  brand and sku lines (e.g. PO rows that already print the SKU in a column). */
export function itemNameCell(it, opts = {}) {
  const { nameLine, vendor, sku } = composeItemName(it);
  let html = '';
  if (opts.showMeta !== false && vendor) html += `<div class="item-detail">${escDoc(vendor)}</div>`;
  html += `<span class="item-name">${escDoc(nameLine)}</span>`;
  if (opts.showMeta !== false && sku) html += `<div class="item-detail">${escDoc(sku)}</div>`;
  return html;
}

export function getDocumentBaseCSS() {
  return `
    @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500;600&family=Inter:wght@300;400;500;600&family=Pinyon+Script&display=swap');

    * { box-sizing: border-box; }

    body {
      font-family: 'Inter', -apple-system, Arial, sans-serif;
      margin: 0; padding: 0;
      color: #1c1917; font-size: 12.5px; line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }

    .page {
      padding: 0;
    }

    /* ---- Header ---- */
    .header {
      display: flex; justify-content: space-between; align-items: flex-start;
      padding-bottom: 1.25rem; margin-bottom: 1.5rem;
      border-bottom: 2px solid #a87935;
    }
    .header-left { display: flex; align-items: center; gap: 14px; }
    .logo-lockup { display: inline-flex; flex-direction: column; align-items: center; line-height: 1; padding-bottom: 0.34em; margin-bottom: 3px; }
    .logo-wordmark {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 1.35rem; font-weight: 400; letter-spacing: 0.34em; text-indent: 0.34em;
      color: #1c1917; white-space: nowrap;
    }
    .logo-wordmark em { font-style: normal; font-size: 0.62em; letter-spacing: 0.2em; text-indent: 0.2em; color: #57534e; }
    .logo-script { font-family: 'Pinyon Script', 'Cormorant Garamond', cursive; font-size: 1.85rem; line-height: 1; color: #a87935; margin-top: -0.3em; align-self: center; white-space: nowrap; }
    .company-info { font-size: 0.6875rem; color: #78716c; line-height: 1.65; }

    .header-right { text-align: right; }
    .doc-type {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 1.625rem; font-weight: 400; color: #1c1917;
      letter-spacing: 0.01em; margin: 0;
    }

    /* ---- Document Meta Banner ---- */
    .doc-banner {
      display: flex; justify-content: space-between; align-items: center;
      background: #faf8f6; border: 1px solid #e7e5e4;
      padding: 0.875rem 1.25rem; margin-bottom: 1.5rem;
    }
    .doc-banner-left { display: flex; gap: 2rem; align-items: center; }
    .doc-banner .meta-group { }
    .meta-label {
      font-size: 0.5625rem; text-transform: uppercase; letter-spacing: 0.12em;
      color: #a87935; font-weight: 500; margin: 0 0 1px;
    }
    .meta-value {
      font-size: 0.9375rem; font-weight: 600; color: #1c1917; margin: 0;
    }
    .meta-value-sm {
      font-size: 0.8125rem; font-weight: 500; color: #44403c; margin: 0;
    }

    /* ---- Info Blocks ---- */
    .info-row {
      display: flex; gap: 1.5rem; margin-bottom: 1.5rem;
    }
    .info-card {
      flex: 1; padding: 0.875rem 1rem;
      background: #faf8f6; border: 1px solid #e7e5e4;
    }
    .info-card h3 {
      font-size: 0.5625rem; text-transform: uppercase; letter-spacing: 0.12em;
      color: #a87935; font-weight: 500; margin: 0 0 0.4rem;
    }
    .info-card p {
      margin: 0; font-size: 0.8125rem; color: #44403c; line-height: 1.6;
    }
    .info-card strong { color: #1c1917; font-weight: 600; }

    /* ---- Tables ---- */
    table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; }
    thead th {
      background: #1c1917; color: #ffffff;
      padding: 0.5rem 0.75rem; text-align: left;
      font-size: 0.625rem; font-weight: 500;
      text-transform: uppercase; letter-spacing: 0.08em;
    }
    thead th:first-child { padding-left: 0.875rem; }
    thead th:last-child { padding-right: 0.875rem; }
    tbody td {
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid #f0ede8;
      font-size: 0.8125rem; color: #44403c;
      vertical-align: top;
    }
    tbody td:first-child { padding-left: 0.875rem; }
    tbody td:last-child { padding-right: 0.875rem; }
    tbody tr:nth-child(even) td { background: #fdfcfb; }
    tbody tr:last-child td { border-bottom: 2px solid #e7e5e4; }

    .item-name { font-weight: 500; color: #1c1917; }
    .item-detail { font-size: 0.6875rem; color: #78716c; margin-top: 1px; }

    .text-right { text-align: right; }
    .text-center { text-align: center; }
    .text-muted { color: #78716c; }
    .text-small { font-size: 0.75rem; }

    /* ---- Totals ---- */
    .totals-wrapper {
      display: flex; justify-content: flex-end; margin-top: 0.25rem; margin-bottom: 1.5rem;
    }
    .totals-box {
      width: 280px;
    }
    .totals-line {
      display: flex; justify-content: space-between;
      padding: 0.3rem 0; font-size: 0.8125rem; color: #44403c;
    }
    .totals-line.subtotal {
      border-top: 1px solid #e7e5e4; padding-top: 0.5rem; margin-top: 0.25rem;
    }
    .totals-line.grand-total {
      border-top: 2px solid #1c1917; padding-top: 0.6rem; margin-top: 0.4rem;
      font-size: 0.9375rem; font-weight: 600; color: #1c1917;
    }
    .totals-line.balance-due {
      border-top: 1px solid #ecdcc0; margin-top: 0.35rem; padding-top: 0.5rem;
      font-weight: 700; font-size: 0.9375rem; color: #1c1917;
    }
    .totals-line.balance-due span:first-child {
      color: #a87935; font-weight: 600;
    }
    .totals-line.paid-full {
      font-weight: 500; color: #16a34a;
    }
    .totals-line .discount { color: #16a34a; }

    /* ---- Section Headers ---- */
    .section-title {
      font-size: 0.6875rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.12em; color: #a87935;
      margin: 1.75rem 0 0.625rem; padding-bottom: 0.375rem;
      border-bottom: 1px solid #e7e5e4;
    }

    /* ---- Notes ---- */
    .notes-block {
      margin-top: 1.25rem; padding: 0.875rem 1rem;
      background: #faf8f6; border: 1px solid #e7e5e4;
    }
    .notes-block h4 {
      font-size: 0.5625rem; text-transform: uppercase; letter-spacing: 0.12em;
      color: #a87935; font-weight: 500; margin: 0 0 0.4rem;
    }
    .notes-block p, .notes-block div {
      margin: 0; font-size: 0.8125rem; color: #44403c; line-height: 1.6;
    }

    /* ---- Badges ---- */
    .badge {
      display: inline-block; padding: 2px 8px;
      font-size: 0.5625rem; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.05em;
      border-radius: 2px; vertical-align: middle;
    }
    .badge-draft { background: #f5f5f4; color: #78716c; }
    .badge-pending { background: #fef3c7; color: #92400e; }
    .badge-confirmed { background: #dbeafe; color: #1e40af; }
    .badge-sent { background: #dbeafe; color: #1e40af; }
    .badge-revised { background: #fef3c7; color: #92400e; }
    .badge-fulfilled { background: #dcfce7; color: #166534; }
    .badge-paid { background: #dcfce7; color: #166534; }
    .badge-cancelled { background: #fee2e2; color: #991b1b; }
    .badge-void { background: #fee2e2; color: #991b1b; }
    .badge-overdue { background: #fee2e2; color: #991b1b; }
    .badge-partial { background: #fef3c7; color: #92400e; }
    .badge-valid { background: #dcfce7; color: #166534; }
    .badge-expired { background: #fee2e2; color: #991b1b; }

    /* ---- Footer ---- */
    .doc-footer {
      margin-top: 2.5rem; padding-top: 0.875rem;
      border-top: 2px solid #a87935;
      display: flex; justify-content: space-between; align-items: flex-end;
    }
    .doc-footer-left {
      font-size: 0.625rem; color: #a8a29e; line-height: 1.6;
    }
    .doc-footer-right {
      text-align: right;
    }
    .doc-footer-brand {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 0.875rem; font-weight: 400; letter-spacing: 0.08em;
      color: #a87935; margin: 0;
    }
    .doc-footer-sub {
      font-size: 0.5625rem; color: #a8a29e; margin: 2px 0 0;
      letter-spacing: 0.02em;
    }

    /* ---- Approval/Signature ---- */
    .approval-line {
      margin-top: 1rem; font-size: 0.75rem; color: #78716c;
    }

    /* ---- Terms ---- */
    .terms {
      margin-top: 1.25rem; font-size: 0.6875rem; color: #a8a29e; line-height: 1.6;
    }
    .terms p { margin: 0 0 0.15rem; }

    /* Legacy compat */
    .info-block { margin-bottom: 1.5rem; padding: 0.875rem 1rem; background: #faf8f6; border: 1px solid #e7e5e4; }
    .info-block h3 { font-size: 0.5625rem; text-transform: uppercase; letter-spacing: 0.12em; color: #a87935; font-weight: 500; margin: 0 0 0.4rem; }
    .info-columns { display: flex; gap: 1.5rem; margin-bottom: 1.5rem; }
    .info-columns .info-block { flex: 1; }
  `;
}

export function getDocumentHeader(title) {
  return `
    <div class="header">
      <div class="header-left">
        <div>
          <div class="logo-lockup"><span class="logo-wordmark">ROMA <em>FLOORING</em></span><span class="logo-script">Designs</span></div>
          <div class="company-info">
            1440 S. State College Blvd #6M, Anaheim, CA 92806<br/>
            (714) 999-0009 &nbsp;&middot;&nbsp; Sales@romaflooringdesigns.com
          </div>
        </div>
      </div>
      <div class="header-right">
        <p class="doc-type">${title}</p>
      </div>
    </div>
  `;
}

export function getDocumentFooter(terms) {
  return `
    ${terms ? `<div class="terms">${terms}</div>` : ''}
    <div class="doc-footer">
      <div class="doc-footer-left">
        License #830966 &nbsp;&middot;&nbsp; www.romaflooringdesigns.com
      </div>
      <div class="doc-footer-right">
        <p class="doc-footer-brand">ROMA FLOORING DESIGNS</p>
      </div>
    </div>
  `;
}

// California General Resale Certificate (CDTFA-230), filled from the applicant's
// input. Rendered to a PDF (generatePDFBuffer) and stored as a trade_document
// with doc_type 'resale_certificate'. Standard CDTFA-230 certification text.
export function generateResaleCertificateHtml(data = {}) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fill = (v, ph) => v ? `<span class="rc-fill">${esc(v)}</span>` : `<span class="rc-blank">${esc(ph || '')}</span>`;
  const addr = [data.address_line1, [data.city, data.state, data.zip].filter(Boolean).join(', ')].filter(Boolean).join(' &middot; ');
  const dateStr = data.date || new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'long', day: 'numeric' });
  const propDesc = data.property_description || 'Flooring, tile, stone, and related installation materials';
  // Typed name is the purchaser's electronic signature; fall back to the signer name.
  const signature = data.signature || data.signer_name || '';
  const signedAt = data.signed_at
    ? new Date(data.signed_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    ${getDocumentBaseCSS()}
    .rc-lead { font-family:'Cormorant Garamond',Georgia,serif; font-size:0.72rem; letter-spacing:0.18em; text-transform:uppercase; color:#a87935; margin:0 0 0.5rem; font-weight:500; }
    .rc-cert { font-weight:600; letter-spacing:0.02em; margin:0 0 1rem; }
    .rc-list { margin:0 0 1.5rem; padding:0; list-style:none; }
    .rc-list li { position:relative; padding:0 0 0.85rem 1.9rem; }
    .rc-list li .rc-num { position:absolute; left:0; top:0; font-weight:600; color:#a87935; }
    .rc-fill { font-weight:600; color:#1c1917; border-bottom:1px solid #1c1917; padding:0 4px; }
    .rc-blank { display:inline-block; min-width:180px; border-bottom:1px solid #78716c; }
    .rc-sign { display:flex; gap:1.5rem; margin-top:1.5rem; }
    .rc-sign .info-card { flex:1; }
    .rc-sign-mark { font-family:'Cormorant Garamond',Georgia,serif; font-style:italic; font-size:1.5rem; color:#1c1917; line-height:1.1; min-height:1.6rem; }
    .rc-sign-line { border-top:1px solid #1c1917; margin-top:0.35rem; padding-top:4px; font-size:0.6rem; text-transform:uppercase; letter-spacing:0.1em; color:#78716c; }
    .rc-esign { font-size:0.625rem; color:#57534e; line-height:1.6; margin-top:0.6rem; }
    .rc-esign strong { color:#1c1917; }
    .rc-note { font-size:0.6875rem; color:#78716c; line-height:1.6; margin-top:1.25rem; }
  </style></head><body><div class="page">
    ${getDocumentHeader('Resale Certificate')}
    <p class="rc-lead">California Resale Certificate &middot; CDTFA-230</p>
    <p class="rc-cert">I HEREBY CERTIFY:</p>
    <ul class="rc-list">
      <li><span class="rc-num">1.</span> I hold valid seller's permit number: ${fill(data.sellers_permit, "seller's permit number")}</li>
      <li><span class="rc-num">2.</span> I am engaged in the business of selling: ${fill(data.business_type, 'type of business')}</li>
      <li><span class="rc-num">3.</span> This certificate is for the purchase from <strong>Roma Flooring Designs</strong> of the item(s) described in paragraph 5 below.</li>
      <li><span class="rc-num">4.</span> I will resell the item(s) described in paragraph 5, which I am purchasing under this resale certificate, in the form of tangible personal property in the regular course of my business operations, and I will do so prior to making any use of the item(s) other than demonstration and display while holding the item(s) for sale in the regular course of my business. I understand that if I use the item(s) purchased under this certificate in any manner other than as just described, I will owe use tax based on each item's purchase price or as otherwise provided by law.</li>
      <li><span class="rc-num">5.</span> Description of the property to be purchased for resale: ${fill(propDesc)}</li>
      <li><span class="rc-num">6.</span> I have read and understand the foregoing.</li>
    </ul>
    <div class="rc-sign">
      <div class="info-card">
        <h3>Purchaser</h3>
        <p><strong>${esc(data.business_name) || '&mdash;'}</strong>${addr ? '<br/>' + addr : ''}${data.phone ? '<br/>' + esc(data.phone) : ''}${data.email ? '<br/>' + esc(data.email) : ''}</p>
      </div>
      <div class="info-card">
        <h3>Signature</h3>
        <div class="rc-sign-mark">${esc(signature)}</div>
        <div class="rc-sign-line">Signature of purchaser</div>
        <p><strong>${esc(data.signer_name || signature) || '&mdash;'}</strong>${data.signer_title ? '<br/>' + esc(data.signer_title) : ''}<br/>Date: ${esc(dateStr)}</p>
      </div>
    </div>
    <p class="rc-esign">Electronically signed by <strong>${esc(signature) || '&mdash;'}</strong>${signedAt ? ' on ' + esc(signedAt) : ''}${data.signed_ip ? ' from IP ' + esc(data.signed_ip) : ''}. This constitutes a legally binding electronic signature under Cal. Civ. Code &sect; 1633.7.</p>
    <p class="rc-note">Provided to Roma Flooring Designs under the California Sales and Use Tax Law. By typing their name and submitting this form, the purchaser certifies under penalty of perjury under the laws of the State of California that they hold a valid seller's permit and that the statements above are true and correct.</p>
    ${getDocumentFooter('')}
  </div></body></html>`;
}

export async function generatePDF(html, filename, req, res, options = {}) {
  // Preview mode: return HTML directly for iframe rendering
  if (req.query.preview === 'true') {
    res.set('Content-Type', 'text/html');
    return res.send(html);
  }
  const defaultMargin = { top: '0.6in', bottom: '0.6in', left: '0.65in', right: '0.65in' };
  const margin = options.margin || defaultMargin;
  try {
    const puppeteer = await import('puppeteer');
    const browser = await puppeteer.default.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    // If a straggling asset keeps the network busy past the timeout, render
    // with whatever has loaded rather than degrading to raw HTML.
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 })
      .catch(err => console.warn('generatePDF: assets still loading at timeout, rendering anyway:', err.message));
    // Custom page size (e.g. a 4in x 2in roll label) overrides the default Letter format.
    const pdfOpts = (options.width && options.height)
      ? { width: options.width, height: options.height, margin }
      : { format: 'Letter', margin };
    const pdf = await page.pdf(pdfOpts);
    await browser.close();
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"` });
    res.send(pdf);
  } catch (pdfErr) {
    // Fallback: return HTML if Puppeteer unavailable
    console.error('generatePDF fell back to HTML:', pdfErr.message);
    res.set('Content-Type', 'text/html');
    res.send(html);
  }
}

export async function generatePDFBuffer(html, options = {}) {
  const defaultMargin = { top: '0.6in', bottom: '0.6in', left: '0.65in', right: '0.65in' };
  const margin = options.margin || defaultMargin;
  const puppeteer = await import('puppeteer');
  const browser = await puppeteer.default.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 })
    .catch(err => console.warn('generatePDFBuffer: assets still loading at timeout, rendering anyway:', err.message));
  const pdf = await page.pdf({ format: 'Letter', margin });
  await browser.close();
  return Buffer.from(pdf);
}

// PO pages carry their own horizontal padding; vertical space comes from these
// PDF margins so every page of a multi-page PO gets the same breathing room.
export const PO_PDF_MARGIN = { margin: { top: '0.5in', bottom: '0.45in', left: '0', right: '0' } };

// Circular "Customer will call / No paperwork" rubber stamp, absolutely positioned
// inside a `position:relative` header. Shared by the material-release form and the
// purchase order so both marks stay identical. [[will-call-distributor]]
export function willCallStamp({ accent = '#a87935', top = '16px', left = '52%' } = {}) {
  return `<div style="position:absolute;top:${top};left:${left};transform:translateX(-50%) rotate(-8deg);width:110px;height:110px;border-radius:50%;border:2px solid ${accent};background:#fff;display:flex;align-items:center;justify-content:center;">
<div style="width:92px;height:92px;border-radius:50%;border:1px solid ${accent};display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:${accent};">
<div style="font:700 11.5px/1.15 ui-monospace,monospace;letter-spacing:0.06em;text-transform:uppercase;">Customer<br/>Will Call</div>
<div style="width:34px;border-top:1px solid ${accent};margin:6px 0;opacity:0.55;"></div>
<div style="font:400 7px/1.15 ui-monospace,monospace;letter-spacing:0.12em;text-transform:uppercase;">No Paperwork</div>
</div>
</div>`;
}

export async function generatePOHtml(pool, poId) {
  const po = await pool.query(`
    SELECT po.*,
      v.name as vendor_name, v.code as vendor_code, v.email as vendor_email, v.address as vendor_address, v.edi_config,
      COALESCE(sa.first_name || ' ' || sa.last_name, sr_a.first_name || ' ' || sr_a.last_name) as approved_by_name,
      COALESCE(sa.email, sr_a.email) as approver_email,
      o.order_number, o.sales_rep_id, o.job_name, o.delivery_method,
      sr_b.first_name || ' ' || sr_b.last_name as buyer_name,
      sr_b.email as buyer_email
    FROM purchase_orders po
    JOIN vendors v ON v.id = po.vendor_id
    LEFT JOIN staff_accounts sa ON sa.id = po.approved_by
    LEFT JOIN sales_reps sr_a ON sr_a.id = po.approved_by
    LEFT JOIN orders o ON o.id = po.order_id
    LEFT JOIN sales_reps sr_b ON sr_b.id = o.sales_rep_id
    WHERE po.id = $1
  `, [poId]);
  if (!po.rows.length) return null;
  const p = po.rows[0];

  const items = await pool.query(`
    SELECT poi.*, ma.url as primary_image, sk.internal_sku,
           sk.variant_name, sk.accessory_label, sk.variant_type,
           pr.collection AS collection,
           sac.value AS color, sac_sz.value AS size
    FROM purchase_order_items poi
    LEFT JOIN skus sk ON sk.id = poi.sku_id
    LEFT JOIN products pr ON pr.id = sk.product_id
    LEFT JOIN sku_attributes sac ON sac.sku_id = poi.sku_id
      AND sac.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
    LEFT JOIN sku_attributes sac_sz ON sac_sz.sku_id = poi.sku_id
      AND sac_sz.attribute_id = (SELECT id FROM attributes WHERE slug = 'size' LIMIT 1)
    LEFT JOIN LATERAL (
      SELECT url FROM media_assets
      WHERE asset_type = 'primary'
        AND (sku_id = poi.sku_id OR (sku_id IS NULL AND product_id = sk.product_id))
      ORDER BY (sku_id IS NOT NULL) DESC
      LIMIT 1
    ) ma ON true
    WHERE poi.purchase_order_id = $1 ORDER BY poi.created_at
  `, [poId]);

  // -- Derived values --
  const buyerName = p.buyer_name || p.approved_by_name || '\u2014';
  const buyerEmail = p.buyer_email || p.approver_email || '';
  // Rep-approved POs leave approved_by NULL (reps aren't staff_accounts) but
  // still set approved_at \u2014 fall back to the buyer so the signature isn't blank.
  const approverName = p.approved_by_name || p.buyer_name || '';

  const PT = 'America/Los_Angeles';
  const fmtDate = (d) => {
    if (!d) return '\u2014';
    return new Date(d).toLocaleDateString('en-US', { timeZone: PT, month: 'long', day: 'numeric', year: 'numeric' });
  };
  const fmtShortDate = (d) => {
    if (!d) return '\u2014';
    const dt = new Date(d);
    const date = dt.toLocaleDateString('en-US', { timeZone: PT, month: 'short', day: 'numeric', year: 'numeric' });
    const time = dt.toLocaleTimeString('en-US', { timeZone: PT, hour: 'numeric', minute: '2-digit', hour12: true })
      .toLowerCase().replace(/\s*([ap])m$/, '$1');
    return `${date} &middot; ${time}`;
  };

  const statusDotClass = {
    draft: 'dot-draft', sent: 'dot-sent', acknowledged: 'dot-ack',
    fulfilled: 'dot-fulfilled', cancelled: 'dot-cancelled'
  }[p.status] || 'dot-draft';
  const statusLabel = (p.status || 'draft').toUpperCase();

  const ediConfig = p.edi_config || {};
  const ediId = ediConfig.receiver_id || '';
  const shipTo = p.ship_to || 'Roma Anaheim Warehouse\n1440 S. State College Blvd\nAnaheim, CA 92806';
  const shipLines = shipTo.split('\n');

  const ink = '#1c1917';
  const muted = '#8a7e68';
  const accent = '#a87935';
  const warm = '#d8cdb6';
  const cool = '#c4bba5';
  const mono = "ui-monospace, monospace";
  const serif = "'Cormorant Garamond', 'Times New Roman', serif";
  const sans = "'Inter', system-ui, sans-serif";
  const subtotal = parseFloat(p.subtotal || 0);

  // Approved stamp: show when PO has been approved/sent
  const showApprovedStamp = ['sent', 'acknowledged', 'fulfilled'].includes(p.status);
  const stampLabel = p.status === 'acknowledged' ? 'Acknowledged' : 'Approved &amp; sent';

  // Will-call: mark the PO so the distributor knows the customer collects directly.
  // True when the order is a will-call order, or a will-call release already exists
  // for this distributor on the order. [[will-call-distributor]]
  let isWillCall = p.delivery_method === 'will_call';
  if (!isWillCall && p.order_id) {
    const wc = await pool.query(
      `SELECT 1 FROM material_releases WHERE order_id = $1 AND vendor_id = $2 AND release_method = 'will_call' AND status <> 'void' LIMIT 1`,
      [p.order_id, p.vendor_id]);
    isWillCall = wc.rows.length > 0;
  }

  // Roma pickup: Roma collects the material at the distributor instead of having
  // it shipped in. Distinct from will-call (which is the CUSTOMER collecting).
  // Pickup location defaults to the vendor/distributor address.
  const isPickup = !isWillCall && p.fulfillment_method === 'pickup';
  const pickupLines = (p.ship_to || p.vendor_address || 'At distributor location').split('\n');

  const html = `<!DOCTYPE html><html><head>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,400&family=Inter:wght@300;400;500;600&family=Pinyon+Script&display=swap" rel="stylesheet" />
    <style>
    :root{
      --roma-serif:${serif};
      --roma-sans:${sans};
      --ink:${ink};--muted:${muted};--accent:${accent};--warm:${warm};--cool:${cool};
    }
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{margin:0;padding:0}
    body{font-family:var(--roma-sans);color:var(--ink);font-size:11px;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
    ol{margin:0;padding-left:14px;display:grid;gap:4px}
    /* PDF vertical spacing comes from page margins (PO_PDF_MARGIN) so page 2+
       gets the same breathing room; the iframe preview needs it as padding. */
    @media screen { .po-page { padding-top:48px; padding-bottom:40px; } }
    .avoid-break { break-inside:avoid; page-break-inside:avoid; }
    </style>
    <script>document.fonts&&document.fonts.ready.then(function(){})</script>
    </head><body>
    <div class="po-page" style="width:100%;background:#fff;color:${ink};font-family:${sans};padding-left:56px;padding-right:56px;box-sizing:border-box;font-size:11px">

      <!-- HEADER -->
      <div style="position:relative;display:grid;grid-template-columns:1fr auto;gap:36px;padding-bottom:20px;border-bottom:1px solid ${ink}22">
        ${isWillCall ? willCallStamp({ accent, top: '16px', left: '50%' }) : ''}
        <div>
          <div style="display:inline-flex;flex-direction:column;align-items:center;line-height:1;padding-bottom:0.34em">
            <span style="font-family:${serif};font-weight:400;font-size:26px;letter-spacing:0.34em;text-indent:0.34em;color:${ink};white-space:nowrap">ROMA <em style="font-style:normal;font-size:0.62em;letter-spacing:0.2em;text-indent:0.2em;color:${muted}">FLOORING</em></span>
            <span style="font-family:'Pinyon Script','Cormorant Garamond',cursive;font-size:35px;line-height:1;color:${accent};margin-top:-11px;white-space:nowrap">Designs</span>
          </div>
          <div style="margin-top:14px;font:400 10px/1.5 ${sans};color:${ink}cc">
            Roma Flooring Designs, Inc.<br>
            1440 S. State College Blvd, Anaheim, CA 92806<br>
            (714) 999-0009 &middot; orders@romaflooringdesigns.com<br>
            License #830966
          </div>
        </div>
        <div style="text-align:right;min-width:240px">
          <div style="font:500 9px/1 ${mono};letter-spacing:0.22em;text-transform:uppercase;color:${muted}">Purchase order</div>
          <div style="font:300 30px/1 ${serif};letter-spacing:-0.014em;color:${ink};margin-top:6px">${p.po_number}</div>
          <div style="margin-top:12px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font:400 10px/1.4 ${sans};text-align:left">
            <span style="color:${muted}">Issued</span>
            <span style="color:${ink};text-align:right">${fmtDate(p.created_at)}</span>
            ${p.expected_delivery ? `<span style="color:${muted}">Expected</span><span style="color:${ink};text-align:right">${fmtDate(p.expected_delivery)}</span>` : ''}
            ${p.order_number ? `<span style="color:${muted}">Customer ref</span><span style="color:${ink};text-align:right">${p.order_number}</span>` : ''}
            ${p.job_name ? `<span style="color:${muted}">Sidemark</span><span style="color:${ink};text-align:right">${escDoc(p.job_name)}</span>` : ''}
            <span style="color:${muted}">Revision</span>
            <span style="color:${ink};text-align:right">${p.revision || 0}</span>
            <span style="color:${muted}">Status</span>
            <span style="color:${accent};text-align:right;font:500 9px/1 ${mono};letter-spacing:0.18em;text-transform:uppercase">&#9679; ${statusLabel}</span>
          </div>
        </div>
      </div>

      <!-- APPROVED STAMP -->
      <div style="display:grid;grid-template-columns:1fr auto;gap:24px;padding:14px 0;margin-bottom:4px;border-bottom:1px solid ${ink}11">
        <div style="font:500 9px/1.4 ${sans};letter-spacing:0.06em;color:${ink}cc">
          This purchase order is binding upon vendor acknowledgment. Reference <strong style="color:${ink}">${p.po_number}</strong> on all packing slips, invoices, BOLs, and shipping documents. Vendor to confirm via X12 855 or email reply within 1 business day. Pricing locked at the costs below; any change requires Roma&rsquo;s written approval.
        </div>
        ${showApprovedStamp ? `<div style="display:flex;align-items:center;gap:0;padding:8px 14px;border:1.5px solid ${accent};color:${accent};font:500 11px/1 ${mono};letter-spacing:0.32em;text-transform:uppercase;transform:rotate(-2deg)">${stampLabel}</div>` : ''}
      </div>

      <!-- BUYER / VENDOR / SHIP-TO -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:16px 0 20px;border-bottom:1px solid ${ink}22">
        <div>
          <div style="font:500 9px/1 ${mono};letter-spacing:0.2em;text-transform:uppercase;color:${muted};margin-bottom:8px">Buyer</div>
          <div style="font:500 11px/1.2 ${sans};color:${ink}">${buyerName}</div>
          <div style="font:400 10px/1.5 ${sans};color:${ink}cc;margin-top:4px">
            Sales rep<br>${buyerEmail}
            ${p.approved_at && approverName ? `<br><br><span style="color:${muted}">Approved by</span><br>${approverName}<br>${fmtShortDate(p.approved_at)}` : ''}
          </div>
        </div>
        <div>
          <div style="font:500 9px/1 ${mono};letter-spacing:0.2em;text-transform:uppercase;color:${muted};margin-bottom:8px">Vendor &middot; ${p.vendor_code}</div>
          <div style="font:500 11px/1.2 ${sans};color:${ink}">${p.vendor_name}</div>
          <div style="font:400 10px/1.5 ${sans};color:${ink}cc;margin-top:4px">
            ${p.vendor_address ? `${escDoc(p.vendor_address)}<br>` : ''}${p.vendor_email || ''}
          </div>
        </div>
        <div>
          <div style="font:500 9px/1 ${mono};letter-spacing:0.2em;text-transform:uppercase;color:${muted};margin-bottom:8px">${isWillCall ? 'Fulfillment' : (isPickup ? 'Pickup' : 'Ship to')}</div>
          ${isWillCall ? `
          <div style="font:500 11px/1.2 ${sans};color:${ink}">Customer will-call</div>
          <div style="font:400 10px/1.5 ${sans};color:${ink}cc;margin-top:4px">Hold at your warehouse for customer pickup.</div>
          <div style="margin-top:8px;padding:6px 10px;background:${warm};font:500 9px/1.4 ${mono};letter-spacing:0.14em;text-transform:uppercase;color:${ink};display:inline-block">&#9679; Do not ship &middot; pickup only</div>
          <div style="font:400 10px/1.5 ${sans};color:${ink}99;margin-top:6px">Customer references PO ${p.po_number} at pickup.</div>
          ` : isPickup ? `
          <div style="font:500 11px/1.2 ${sans};color:${ink}">Roma will pick up</div>
          <div style="font:400 10px/1.5 ${sans};color:${ink}cc;margin-top:4px">${escDoc(pickupLines[0] || '')}${pickupLines.length > 1 ? '<br>' + pickupLines.slice(1).map(escDoc).join('<br>') : ''}</div>
          <div style="margin-top:8px;padding:6px 10px;background:${warm};font:500 9px/1.4 ${mono};letter-spacing:0.14em;text-transform:uppercase;color:${ink};display:inline-block">&#9679; Do not ship &middot; Roma pickup</div>
          <div style="font:400 10px/1.5 ${sans};color:${ink}99;margin-top:6px">Hold for Roma pickup &middot; reference PO ${p.po_number}. Call ${'(714) 999-0009'} when ready.</div>
          ` : `
          <div style="font:500 11px/1.2 ${sans};color:${ink}">${shipLines[0] || ''}</div>
          <div style="font:400 10px/1.5 ${sans};color:${ink}cc;margin-top:4px">${shipLines.slice(1).join('<br>')}</div>
          <div style="margin-top:8px;padding:6px 10px;background:${warm};font:500 9px/1.4 ${mono};letter-spacing:0.14em;text-transform:uppercase;color:${ink};display:inline-block">&#9679; Receiving &middot; Mon&ndash;Fri &middot; 9a&ndash;5p</div>
          <div style="font:400 10px/1.5 ${sans};color:${ink}99;margin-top:6px">28&rsquo; truck max &middot; forklift on-site</div>
          `}
          ${ediId ? `<div style="margin-top:10px;font:400 10px/1.5 ${sans};color:${muted}">EDI: <span style="color:${ink}">${ediId}</span></div>` : ''}
        </div>
      </div>

      <!-- LINE ITEMS -->
      <div style="padding-top:18px">
        <div style="display:grid;grid-template-columns:28px 1fr 110px 70px 60px 80px 110px;gap:10px;padding:0 0 10px;border-bottom:1px solid ${ink}33;font:500 9px/1 ${mono};letter-spacing:0.18em;text-transform:uppercase;color:${muted}">
          <span>Ln</span><span>Description</span><span>Vendor SKU</span>
          <span style="text-align:right">Qty</span><span>UOM</span>
          <span style="text-align:right">Unit cost</span><span style="text-align:right">Line subtotal</span>
        </div>
        ${items.rows.map((it, idx) => {
          const ln = String(idx + 1).padStart(2, '0');
          const vsku = it.vendor_sku || '\u2014';
          const imgHtml = it.primary_image
            ? `<img src="${it.primary_image}" style="width:32px;height:32px;object-fit:cover;flex-shrink:0;border:0.5px solid ${ink}22" />`
            : '';
          const ci = composeItemName(it);
          let desc = ci.nameLine;
          if ((!desc || desc === 'Product') && it.description) desc = it.description;
          desc = escDoc(desc || '\u2014');
          // Brand line sits ABOVE the name; the vendor SKU prints in its own
          // column so it is NOT duplicated beneath the name here.
          const brand = escDoc(ci.vendor || p.vendor_name || '');
          const lineNote = it.line_note ? escDoc(it.line_note) : '';
          const uom = (it.sell_by || 'unit').toUpperCase();
          const cost = parseFloat(it.cost || 0).toFixed(2);
          const sub = parseFloat(it.subtotal || 0).toFixed(2);
          const isLast = idx === items.rows.length - 1;
          return `<div class="avoid-break" style="display:grid;grid-template-columns:28px 1fr 110px 70px 60px 80px 110px;gap:10px;padding:12px 0;border-bottom:${isLast ? 'none' : `1px solid ${ink}11`};align-items:flex-start">
            <span style="font:400 11px/1.4 ${serif};color:${muted}">${ln}</span>
            <div style="display:flex;gap:10px;align-items:flex-start">
              ${imgHtml}
              <div>
                ${brand ? `<div style="font:400 9px/1.4 ${sans};color:${muted};margin-bottom:2px">${brand}</div>` : ''}
                <div style="font:500 11px/1.3 ${sans};color:${ink};letter-spacing:-0.004em">${desc}</div>
                ${lineNote ? `<div style="font:400 9.5px/1.45 ${sans};color:${ink}cc;font-style:italic;margin-top:4px;padding-left:8px;border-left:2px solid ${accent}">${lineNote}</div>` : ''}
              </div>
            </div>
            <div style="font:500 10px/1.2 ${mono};color:${ink};letter-spacing:0.04em">${vsku}</div>
            <div style="text-align:right;font:400 12px/1.2 ${serif};color:${ink};letter-spacing:-0.005em">${it.qty}</div>
            <div style="font:500 9px/1.4 ${mono};color:${muted};text-transform:uppercase">${uom}</div>
            <div style="text-align:right;font:400 11px/1.2 ${serif};color:${ink};letter-spacing:-0.005em">$${cost}</div>
            <div style="text-align:right;font:500 12px/1.2 ${serif};color:${ink};letter-spacing:-0.005em">$${sub}</div>
          </div>`;
        }).join('')}
      </div>

      <!-- TERMS + TOTALS + SIGNATURES + FOOTER (5th grid row) -->
      <div>
        <div class="avoid-break" style="display:grid;grid-template-columns:1fr 220px;gap:28px;margin-top:12px">
          <div style="padding-top:4px;font:400 9.5px/1.55 ${sans};color:${ink}cc">
            <div style="font:500 9px/1 ${mono};letter-spacing:0.2em;text-transform:uppercase;color:${muted};margin-bottom:8px">Terms</div>
            <ol>
              <li>Freight + tax to be billed via 810 invoice (AP bill); not included on this PO.</li>
              <li>Vendor to confirm receipt and acknowledge via X12 855 EDI or email reply within 1 business day.</li>
              <li>Substitutions require Roma written approval before fulfillment.</li>
              <li>Reference PO number on all packing slips, invoices, and shipping documents.</li>
            </ol>
            ${p.notes ? `<div style="font:500 9px/1 ${mono};letter-spacing:0.2em;text-transform:uppercase;color:${muted};margin-bottom:6px;margin-top:14px">Notes to vendor</div><div style="font-style:italic">${p.notes}</div>` : ''}
          </div>
          <div>
            <div style="display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;font:400 10px/1.3 ${sans}"><span style="color:${ink}99">Lines</span><span style="color:${ink}">${items.rows.length}</span></div>
            <div style="display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;font:400 10px/1.3 ${sans}"><span style="color:${ink}99">Subtotal</span><span style="color:${ink}">$${subtotal.toFixed(2)}</span></div>
            <div style="display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;font:400 10px/1.3 ${sans}"><span style="color:${ink}99">Freight</span><span style="color:${muted};font-style:italic">By vendor invoice</span></div>
            <div style="display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;font:400 10px/1.3 ${sans}"><span style="color:${ink}99">Tax</span><span style="color:${muted};font-style:italic">By vendor invoice</span></div>
            <div style="margin-top:8px;padding-top:8px;border-top:1.5px solid ${ink};display:flex;justify-content:space-between;align-items:baseline">
              <span style="font:500 10px/1 ${mono};letter-spacing:0.18em;text-transform:uppercase;color:${ink}">PO total &middot; USD</span>
              <span style="font:300 26px/1 ${serif};letter-spacing:-0.012em;color:${ink}">$${subtotal.toFixed(2)}</span>
            </div>
            <div style="margin-top:4px;font:500 9px/1 ${mono};letter-spacing:0.14em;color:${muted};text-transform:uppercase;text-align:right">Materials only &middot; Freight + tax billed on 810</div>
          </div>
        </div>

        <!-- FOOTER -->
        <div class="avoid-break" style="margin-top:16px;padding-top:12px;border-top:1px solid ${ink}22;display:flex;justify-content:space-between;align-items:center;font:400 9px/1.4 ${sans};color:${muted}">
          <span>Roma Flooring Designs, Inc. &middot; 1440 S. State College Blvd &middot; Anaheim, CA 92806 &middot; License #830966</span>
          <span style="font:500 9px/1 ${mono};letter-spacing:0.18em;text-transform:uppercase">${p.po_number} &middot; Rev ${p.revision || 0}</span>
        </div>
      </div>
    </div>
  </body></html>`;

  return { html, po: p, items: items.rows };
}

// Shared quote document — used by the rep, trade, and customer PDF endpooints.
// Implements the "Quote PDF.html" design from the Roma Claude Design project:
// editorial letterhead, greeting band with validity stamp, three info cards,
// swatch-led line items, terms + totals columns, and signature lines.
// Design fictions adapted to real data: real license number, real status,
// promo discount (not the mocked trade line), no invented return policy.
// `q` is the quote row, optionally enriched with rep_name / rep_email /
// company_name (trade). Items may carry primary_image for the swatches.
export function generateQuoteHtml(q, items) {
  const money = (n) => '$' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const longDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'long', day: 'numeric' }) : null;
  const issued = longDate(q.created_at);
  const validUntil = longDate(q.expires_at);
  const isExpired = q.expires_at && new Date(q.expires_at) < new Date();
  const isPickup = q.delivery_method === 'pickup';
  const quoteNumber = q.quote_number || 'Q-' + String(q.id).substring(0, 8).toUpperCase();

  const statusLabel = isExpired ? 'Expired'
    : q.status === 'converted' ? 'Converted · Order'
    : q.status === 'accepted' ? 'Accepted'
    : q.status === 'sent' ? 'Open · Sent'
    : 'Draft';

  const validityDays = q.expires_at
    ? Math.max(1, Math.round((new Date(q.expires_at) - new Date(q.created_at)) / 86400000))
    : 10;
  const stampText = isExpired ? 'Expired' : `Valid ${validityDays} days`;

  const customerFirst = (q.customer_name || '').trim().split(/\s+/)[0] || 'Hello';
  const repFirst = (q.rep_name || '').trim().split(/\s+/)[0];
  const greeting = `${customerFirst} — here's the quote ${repFirst ? repFirst + ' prepared' : 'we prepared'} for you on ${issued}. ` +
    (isExpired
      ? `This pricing expired on <span style="color:var(--ink);font-weight:500;">${validUntil}</span> — call the showroom and we'll refresh it.`
      : validUntil
        ? `Pricing is locked in through <span style="color:var(--ink);font-weight:500;">${validUntil}</span>.`
        : 'Pricing is locked in for 10 days from the date of issue.');

  const SWATCH_FALLBACKS = [
    'linear-gradient(135deg,#caa97f,#7a5635)',
    'linear-gradient(135deg,#ebe7df,#a8a59e)',
    'linear-gradient(135deg,#e7e3db,#b0aca4)',
    'linear-gradient(135deg,#a89074,#5e4a36)',
  ];

  const rowsHtml = items.map((i, idx) => {
    const isUnit = i.sell_by === 'unit';
    const qty = i.num_boxes || i.quantity || 1;
    const ci = composeItemName(i);
    let baseName = ci.title;
    if ((!baseName || baseName === 'Product') && i.description) baseName = i.description;
    const name = escDoc(baseName || '—');
    const suffix = escDoc(ci.descriptors.join(' · '));
    const brandLine = escDoc(ci.vendor || '');
    const skuLine = escDoc(ci.sku || '');
    const perBoxSqft = parseFloat(i.sqft_per_box || 0);
    let sqft = parseFloat(i.sqft_needed || 0);
    if (!(sqft > 0) && !isUnit && perBoxSqft > 0 && qty > 0) sqft = perBoxSqft * qty;
    const perBox = !isUnit ? (perBoxSqft > 0 ? perBoxSqft : (sqft > 0 && qty > 0 ? sqft / qty : null)) : null;
    const isFree = i.is_sample && parseFloat(i.subtotal || 0) === 0;
    const gradient = SWATCH_FALLBACKS[idx % SWATCH_FALLBACKS.length];
    // Swatch images go through the local resize proxy (small, disk-cached) so
    // Puppeteer isn't left waiting on full-size vendor CDN downloads.
    const swatchSrc = i.primary_image
      ? `http://localhost:${process.env.PORT || 3001}/api/img?url=${encodeURIComponent(i.primary_image)}&w=64&f=jpeg`
      : null;
    const swatch = swatchSrc
      ? `<div class="swatch" style="background:${gradient};overflow:hidden;"><img src="${swatchSrc}" style="width:100%;height:100%;object-fit:cover;display:block;" /></div>`
      : `<div class="swatch" style="background:${gradient};"></div>`;
    return `<div class="grid-row keep" style="padding:12px 0;${idx < items.length - 1 ? 'border-bottom:1px solid #1c191711;' : ''}">
      ${swatch}
      <div>
        ${brandLine ? `<div style="font:400 9px/1.5 var(--sans);color:#1c191799;margin-bottom:2px;">${brandLine}</div>` : ''}
        <div style="font:500 11px/1.2 var(--sans);letter-spacing:-0.004em;">${name}${suffix ? ` <span style="color:var(--muted);font-weight:400;">· ${suffix}</span>` : ''}</div>
        ${skuLine ? `<div style="font:400 9px/1.5 var(--sans);color:#1c191799;margin-top:3px;">${skuLine}</div>` : ''}
        ${i.is_sample ? `<div style="font:500 9px/1 ui-monospace,monospace;letter-spacing:0.12em;color:var(--muted);margin-top:4px;text-transform:uppercase;">Sample</div>` : ''}
      </div>
      <div class="num">${isUnit || !sqft ? '—' : sqft.toFixed(1) + ' sf'}${perBox ? `<div class="numsub">${perBox.toFixed(1)} sf / box</div>` : ''}</div>
      <div class="num">${qty}<div class="numsub">${isUnit ? (qty === 1 ? 'unit' : 'units') : (qty === 1 ? 'box' : 'boxes')}</div></div>
      <div class="num">${isFree ? 'Free' : money(i.unit_price) + priceUnitSuffix(i)}</div>
      <div class="line-total">${isFree ? 'Free' : money(i.subtotal)}</div>
    </div>`;
  }).join('');

  const shipAddress = [
    q.shipping_address_line1,
    q.shipping_address_line2,
    q.shipping_city ? `${q.shipping_city}, ${q.shipping_state || ''} ${q.shipping_zip || ''}` : null
  ].filter(Boolean).join('<br />');

  const deliveryCard = isPickup
    ? `<div>
        <div class="mono" style="margin-bottom:8px;">Delivery</div>
        <div style="font:500 11px/1.2 var(--sans);">Showroom pickup</div>
        <div class="small" style="margin-top:4px;">1440 S. State College Blvd Suite 6M<br />Anaheim, CA 92806<br />We'll call when your order is ready.</div>
        <div style="margin-top:8px;padding:6px 10px;background:var(--warm);font:500 9px/1.4 ui-monospace,monospace;letter-spacing:0.14em;text-transform:uppercase;display:inline-block;">● Anaheim showroom</div>
      </div>`
    : `<div>
        <div class="mono" style="margin-bottom:8px;">Delivery</div>
        <div style="font:500 11px/1.2 var(--sans);">Local delivery</div>
        <div class="small" style="margin-top:4px;">${shipAddress || 'Address to be confirmed'}<br />Scheduled after order confirmation</div>
      </div>`;

  const accountCard = `<div>
      <div class="mono" style="margin-bottom:8px;">Roma account</div>
      <div style="font:500 11px/1.2 var(--sans);">${q.customer_name || ''}${q.company_name ? ' · Trade Pro' : ''}</div>
      <div class="small" style="margin-top:4px;">${q.company_name ? q.company_name + '<br />' : ''}${q.rep_name ? `<span style="color:var(--muted);">Your rep</span><br />${q.rep_name}${q.rep_email ? '<br />' + q.rep_email : ''}<br />(714) 999-0009` : '(714) 999-0009'}</div>
    </div>`;

  const totalsRows = [
    `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Subtotal · materials</span><span>${money(q.subtotal)}</span></div>`,
    parseFloat(q.discount_amount || 0) > 0
      ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Discount${q.promo_code ? ' · ' + q.promo_code : ''}</span><span style="color:var(--accent);">−${money(q.discount_amount)}</span></div>` : '',
    parseFloat(q.shipping || 0) > 0
      ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Shipping</span><span>${money(q.shipping)}</span></div>` : '',
    parseFloat(q.tax || 0) > 0
      ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Sales tax</span><span>${money(q.tax)}</span></div>` : '',
  ].filter(Boolean).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,400&family=Inter:wght@300;400;500;600&family=Pinyon+Script&display=swap');
:root{--serif:'Cormorant Garamond','Times New Roman',serif;--sans:'Inter',system-ui,sans-serif;--ink:#1c1917;--accent:#a87935;--muted:#8a7e68;--warm:#d8cdb6}
*{box-sizing:border-box}
body{font-family:var(--sans);color:var(--ink);margin:0;background:#fff}
@media screen{body{padding:48px 56px;max-width:816px;margin:0 auto}}
.mono{font:500 9px/1 ui-monospace,monospace;letter-spacing:0.2em;text-transform:uppercase;color:var(--muted)}
.small{font:400 10px/1.5 var(--sans);color:#1c1917cc}
.grid-row{display:grid;grid-template-columns:32px 1fr 86px 70px 80px 84px;gap:12px;align-items:flex-start}
.swatch{width:32px;height:32px;border:0.5px solid #1c191733}
.num{text-align:right;font:400 11px/1.2 var(--sans)}
.numsub{font:400 9px/1.4 var(--sans);color:var(--muted);margin-top:2px}
.line-total{text-align:right;font:500 12px/1.2 var(--serif)}
.keep{break-inside:avoid;orphans:3;widows:3}
</style>
</head>
<body>

<div style="display:grid;grid-template-columns:1fr auto;gap:36px;padding-bottom:20px;border-bottom:1px solid #1c191722;">
<div>
<div style="display:inline-flex;flex-direction:column;align-items:center;line-height:1;padding-bottom:0.34em;">
<span style="font-family:var(--serif);font-weight:400;font-size:26px;letter-spacing:0.34em;text-indent:0.34em;color:var(--ink);white-space:nowrap;">ROMA <em style="font-style:normal;font-size:0.62em;letter-spacing:0.2em;text-indent:0.2em;color:var(--muted);">FLOORING</em></span>
<span style="font-family:'Pinyon Script','Cormorant Garamond',cursive;font-size:35px;line-height:1;color:var(--accent);margin-top:-11px;white-space:nowrap;">Designs</span>
</div>
<div class="small" style="margin-top:14px;">Roma Flooring Designs, Inc.<br />1440 S. State College Blvd #6M, Anaheim, CA 92806<br />(714) 999-0009 · Sales@romaflooringdesigns.com<br />License #830966</div>
</div>
<div style="text-align:right;min-width:220px;">
<div class="mono" style="letter-spacing:0.22em;">Quote</div>
<div style="font:300 32px/1 var(--serif);letter-spacing:-0.014em;margin-top:6px;">${quoteNumber}</div>
<div style="margin-top:14px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font:400 10px/1.4 var(--sans);text-align:left;">
<span style="color:var(--muted);">Issued</span><span style="text-align:right;">${issued}</span>
<span style="color:var(--muted);">Valid until</span><span style="text-align:right;">${validUntil || '10 days from issue'}</span>
${q.rep_name ? `<span style="color:var(--muted);">Prepared by</span><span style="text-align:right;">${q.rep_name}</span>` : ''}
<span style="color:var(--muted);">Status</span><span class="mono" style="color:${isExpired ? 'var(--muted)' : 'var(--accent)'};text-align:right;letter-spacing:0.18em;">● ${statusLabel}</span>
</div>
</div>
</div>

<div style="display:grid;grid-template-columns:1fr auto;gap:24px;padding:14px 0;margin-bottom:8px;border-bottom:1px solid #1c191711;align-items:center;">
<div style="font:500 9px/1.4 var(--sans);letter-spacing:0.06em;color:#1c1917cc;">
${greeting}
</div>
<div style="padding:8px 14px;border:1.5px solid ${isExpired ? 'var(--muted)' : 'var(--accent)'};color:${isExpired ? 'var(--muted)' : 'var(--accent)'};font:500 11px/1 ui-monospace,monospace;letter-spacing:0.32em;text-transform:uppercase;transform:rotate(-2deg);">${stampText}</div>
</div>

<div class="keep" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:14px 0 22px;border-bottom:1px solid #1c191722;">
<div>
<div class="mono" style="margin-bottom:8px;">Prepared for</div>
<div style="font:500 11px/1.2 var(--sans);">${q.customer_name || ''}</div>
<div class="small" style="margin-top:4px;">${[q.customer_email, q.phone].filter(Boolean).join('<br />')}</div>
</div>
${deliveryCard}
${accountCard}
</div>

<div style="padding-top:18px;">
<div class="grid-row" style="padding-bottom:10px;border-bottom:1px solid #1c191733;font:500 9px/1 ui-monospace,monospace;letter-spacing:0.18em;text-transform:uppercase;color:var(--muted);">
<span></span><span>Description</span><span style="text-align:right;">Coverage</span><span style="text-align:right;">Qty</span><span style="text-align:right;">Unit</span><span style="text-align:right;">Line total</span>
</div>
${rowsHtml}
</div>

<div class="keep" style="display:grid;grid-template-columns:1fr 240px;gap:32px;margin-top:14px;border-top:1px solid #1c191733;padding-top:14px;">
<div style="padding-top:4px;" class="small">
${q.notes ? `<div class="mono" style="margin-bottom:8px;">Notes</div><div style="margin-bottom:14px;white-space:pre-wrap;">${q.notes}</div>` : ''}
<div class="mono" style="margin-bottom:8px;">How to confirm</div>
<div style="margin-bottom:10px;">
<span style="color:var(--muted);">Online</span>&nbsp;&nbsp;<span style="color:var(--ink);">romaflooringdesigns.com/account — your quotes live under Account · Quotes</span><br />
<span style="color:var(--muted);">Showroom</span>&nbsp;&nbsp;<span style="color:var(--ink);">(714) 999-0009 · 1440 S. State College Blvd #6M, Anaheim</span><br />
<span style="color:var(--muted);">Email</span>&nbsp;&nbsp;<span style="color:var(--ink);">Reply to your quote email${q.rep_email ? ' or write ' + q.rep_email : ''}</span>
</div>
<div class="mono" style="margin-bottom:8px;margin-top:14px;">Terms &amp; validity</div>
<div>${validUntil ? `Pricing valid through ${validUntil}` : 'Pricing valid for 10 days from the date of issue'}; prices are subject to change after expiry. Natural stone and wood vary by lot — final selections are approved at the showroom or from delivered samples. Subject to California sales tax. Roma Flooring Designs · License #830966.</div>
</div>
<div>
${totalsRows}
<div style="margin-top:8px;padding-top:8px;border-top:1.5px solid var(--ink);display:flex;justify-content:space-between;align-items:baseline;">
<span class="mono" style="color:var(--ink);letter-spacing:0.18em;">Quote total · USD</span>
<span style="font:300 28px/1 var(--serif);letter-spacing:-0.012em;">${money(q.total)}</span>
</div>
${validUntil ? `<div class="mono" style="color:${isExpired ? 'var(--muted)' : 'var(--accent)'};text-align:right;margin-top:6px;letter-spacing:0.16em;">● ${isExpired ? 'Expired' : 'Valid until'} ${validUntil}</div>` : ''}
</div>
</div>

<div style="margin-top:26px;padding-top:12px;border-top:1px solid #1c191722;display:flex;justify-content:space-between;align-items:center;font:400 9px/1.4 var(--sans);color:var(--muted);">
<span>Roma Flooring Designs, Inc. · 1440 S. State College Blvd #6M · Anaheim, CA 92806 · License #830966</span>
<span style="font:500 9px/1 ui-monospace,monospace;letter-spacing:0.18em;text-transform:uppercase;">Quote ${quoteNumber}</span>
</div>

</body>
</html>`;
}

// Construction estimate document — same editorial system as generateQuoteHtml
// (letterhead, greeting band with status stamp, three info cards, swatch-led
// line items, terms + totals columns, signature lines), adapted for an
// estimate: a Materials section and a Labor & Services section, with tax shown
// on materials only. `e` is the estimate row (from the bundle, includes
// rep_name/rep_email/effective_status); `materials`/`labor` are item arrays.
export function generateEstimateHtml(e, materials = [], labor = [], milestones = []) {
  const money = (n) => '$' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const longDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'long', day: 'numeric' }) : null;
  const issued = longDate(e.created_at);
  const validUntil = longDate(e.expires_at);
  const isExpired = e.effective_status === 'expired' || (e.expires_at && new Date(e.expires_at) < new Date());
  const estimateNumber = e.estimate_number || 'E-' + String(e.id).substring(0, 8).toUpperCase();
  // No labor = a materials-only quote; labor present = a construction estimate.
  const isQuoteDoc = e.doc_type ? e.doc_type === 'Quote' : !(labor && labor.length);
  const docType = isQuoteDoc ? 'Quote' : 'Construction Estimate';
  const docNoun = isQuoteDoc ? 'quote' : 'estimate';

  const statusLabel = isExpired ? 'Expired'
    : e.status === 'converted' ? 'Converted · Order'
    : e.status === 'accepted' ? 'Accepted'
    : e.status === 'sent' ? 'Open · Sent'
    : 'Draft';

  const validityDays = e.expires_at
    ? Math.max(1, Math.round((new Date(e.expires_at) - new Date(e.created_at)) / 86400000))
    : 30;
  const stampText = isExpired ? 'Expired' : `Valid ${validityDays} days`;

  const customerFirst = (e.customer_name || '').trim().split(/\s+/)[0] || 'Hello';
  const repFirst = (e.rep_name || '').trim().split(/\s+/)[0];
  const greeting = `${customerFirst} — here's the ${docNoun} ${repFirst ? repFirst + ' prepared' : 'we prepared'} for you on ${issued}. ` +
    (isExpired
      ? `This ${docNoun} expired on <span style="color:var(--ink);font-weight:500;">${validUntil}</span> — reach out and we'll refresh it.`
      : validUntil
        ? `Valid through <span style="color:var(--ink);font-weight:500;">${validUntil}</span>.`
        : 'Valid for 30 days from the date of issue.');

  const SWATCH_FALLBACKS = [
    'linear-gradient(135deg,#caa97f,#7a5635)',
    'linear-gradient(135deg,#ebe7df,#a8a59e)',
    'linear-gradient(135deg,#e7e3db,#b0aca4)',
    'linear-gradient(135deg,#a89074,#5e4a36)',
  ];

  const materialRows = materials.map((i, idx) => {
    const isUnit = i.sell_by === 'unit' || i.sell_by === 'piece';
    const qty = i.num_boxes || i.quantity || 1;
    const _ci = composeItemName(i);
    const name = escDoc(_ci.title || '—');
    const suffix = escDoc(_ci.descriptors.join(' · '));
    const skuLine = [...new Set([
      i.vendor_sku ? 'SKU ' + i.vendor_sku : null,
      i.vendor_name
    ].filter(Boolean))].join(' · ');
    const perBoxSqft = parseFloat(i.sqft_per_box || 0);
    let sqft = parseFloat(i.sqft_needed || 0);
    if (!(sqft > 0) && !isUnit && perBoxSqft > 0 && qty > 0) sqft = perBoxSqft * qty;
    const perBox = !isUnit ? (perBoxSqft > 0 ? perBoxSqft : (sqft > 0 && qty > 0 ? sqft / qty : null)) : null;
    const gradient = SWATCH_FALLBACKS[idx % SWATCH_FALLBACKS.length];
    const swatchSrc = i.primary_image
      ? `http://localhost:${process.env.PORT || 3001}/api/img?url=${encodeURIComponent(i.primary_image)}&w=64&f=jpeg`
      : null;
    const swatch = swatchSrc
      ? `<div class="swatch" style="background:${gradient};overflow:hidden;"><img src="${swatchSrc}" style="width:100%;height:100%;object-fit:cover;display:block;" /></div>`
      : `<div class="swatch" style="background:${gradient};"></div>`;
    return `<div class="grid-row keep" style="padding:12px 0;${idx < materials.length - 1 ? 'border-bottom:1px solid #1c191711;' : ''}">
      ${swatch}
      <div>
        <div style="font:500 11px/1.2 var(--sans);letter-spacing:-0.004em;">${name}${suffix ? ` <span style="color:var(--muted);font-weight:400;">· ${suffix}</span>` : ''}</div>
        ${skuLine ? `<div style="font:400 9px/1.5 var(--sans);color:#1c191799;margin-top:3px;">${skuLine}</div>` : ''}
      </div>
      <div class="num">${isUnit || !sqft ? '—' : sqft.toFixed(1) + ' sf'}${perBox ? `<div class="numsub">${perBox.toFixed(1)} sf / box</div>` : ''}</div>
      <div class="num">${qty}<div class="numsub">${isUnit ? (qty === 1 ? 'unit' : 'units') : (qty === 1 ? 'box' : 'boxes')}</div></div>
      <div class="num">${money(i.unit_price)}${priceUnitSuffix(i)}</div>
      <div class="line-total">${money(i.subtotal)}</div>
    </div>`;
  }).join('');

  const laborRows = labor.map((i, idx) => {
    const unit = laborUnitShort(i.labor_category);
    const rateDisplay = i.rate_type === 'per_sqft' ? `${money(i.rate_sqft)}/${unit}` : 'Flat rate';
    const qtyDisplay = i.rate_type === 'per_sqft'
      ? `${parseFloat(i.labor_sqft || 0).toFixed(0)} ${unit}`
      : (parseFloat(i.quantity || 1) > 1 ? parseFloat(i.quantity).toFixed(0) : '—');
    const desc = i.description
      ? i.description.split('\n').map((l, k) => k === 0 ? l : '· ' + l).join('<br />')
      : '';
    return `<div class="labor-row keep" style="padding:12px 0;${idx < labor.length - 1 ? 'border-bottom:1px solid #1c191711;' : ''}">
      <div>
        <div style="font:500 11px/1.2 var(--sans);letter-spacing:-0.004em;">${laborDisplayName(i)}</div>
        <div style="font:400 9px/1 ui-monospace,monospace;letter-spacing:0.12em;color:var(--muted);margin-top:4px;text-transform:uppercase;">Labor</div>
      </div>
      <div style="font:400 10px/1.5 var(--sans);color:#1c1917cc;">${desc || '—'}</div>
      <div class="num">${rateDisplay}</div>
      <div class="num">${qtyDisplay}</div>
      <div class="line-total">${money(i.subtotal)}</div>
    </div>`;
  }).join('');

  const projectLoc = [
    e.project_address_line1,
    e.project_address_line2,
    e.project_city ? `${e.project_city}, ${e.project_state || ''} ${e.project_zip || ''}` : null
  ].filter(Boolean).join('<br />');

  const projectCard = `<div>
      <div class="mono" style="margin-bottom:8px;">Project location</div>
      <div style="font:500 11px/1.2 var(--sans);">${e.project_name || 'Project'}</div>
      <div class="small" style="margin-top:4px;">${projectLoc || 'Address to be confirmed'}</div>
    </div>`;

  const accountCard = `<div>
      <div class="mono" style="margin-bottom:8px;">Roma account</div>
      <div style="font:500 11px/1.2 var(--sans);">${e.customer_name || ''}</div>
      <div class="small" style="margin-top:4px;">${e.rep_name ? `<span style="color:var(--muted);">Your rep</span><br />${e.rep_name}${e.rep_email ? '<br />' + e.rep_email : ''}<br />(714) 999-0009` : '(714) 999-0009'}</div>
    </div>`;

  const materialsSection = materials.length ? `
<div style="padding-top:18px;">
<div class="mono" style="margin-bottom:10px;color:var(--accent);">Materials</div>
<div class="grid-row" style="padding-bottom:10px;border-bottom:1px solid #1c191733;font:500 9px/1 ui-monospace,monospace;letter-spacing:0.18em;text-transform:uppercase;color:var(--muted);">
<span></span><span>Description</span><span style="text-align:right;">Coverage</span><span style="text-align:right;">Qty</span><span style="text-align:right;">Unit</span><span style="text-align:right;">Line total</span>
</div>
${materialRows}
</div>` : '';

  const hasScope = e.scope_of_work && e.scope_of_work.trim();
  const laborSection = (labor.length || hasScope) ? `
<div style="padding-top:22px;">
<div class="mono" style="margin-bottom:10px;color:var(--accent);">Labor &amp; Services</div>
${hasScope ? `<div class="small" style="margin-bottom:12px;white-space:pre-wrap;"><span class="mono" style="display:block;margin-bottom:4px;">Scope of work</span>${e.scope_of_work}</div>` : ''}
${labor.length ? `<div class="labor-row" style="padding-bottom:10px;border-bottom:1px solid #1c191733;font:500 9px/1 ui-monospace,monospace;letter-spacing:0.18em;text-transform:uppercase;color:var(--muted);">
<span>Service</span><span>Description</span><span style="text-align:right;">Rate</span><span style="text-align:right;">Qty</span><span style="text-align:right;">Line total</span>
</div>
${laborRows}` : ''}
</div>` : '';

  const totalsRows = [
    `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Materials subtotal</span><span>${money(e.materials_subtotal)}</span></div>`,
    `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Labor &amp; services</span><span>${money(e.labor_subtotal)}</span></div>`,
    parseFloat(e.tax_amount || 0) > 0
      ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Tax · materials only</span><span>${money(e.tax_amount)}</span></div>` : '',
  ].filter(Boolean).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,400&family=Inter:wght@300;400;500;600&family=Pinyon+Script&display=swap');
:root{--serif:'Cormorant Garamond','Times New Roman',serif;--sans:'Inter',system-ui,sans-serif;--ink:#1c1917;--accent:#a87935;--muted:#8a7e68;--warm:#d8cdb6}
*{box-sizing:border-box}
body{font-family:var(--sans);color:var(--ink);margin:0;background:#fff}
@media screen{body{padding:48px 56px;max-width:816px;margin:0 auto}}
.mono{font:500 9px/1 ui-monospace,monospace;letter-spacing:0.2em;text-transform:uppercase;color:var(--muted)}
.small{font:400 10px/1.5 var(--sans);color:#1c1917cc}
.grid-row{display:grid;grid-template-columns:32px 1fr 86px 70px 80px 84px;gap:12px;align-items:flex-start}
.labor-row{display:grid;grid-template-columns:1.2fr 1.6fr 92px 70px 84px;gap:12px;align-items:flex-start}
.swatch{width:32px;height:32px;border:0.5px solid #1c191733}
.num{text-align:right;font:400 11px/1.2 var(--sans)}
.numsub{font:400 9px/1.4 var(--sans);color:var(--muted);margin-top:2px}
.line-total{text-align:right;font:500 12px/1.2 var(--serif)}
.keep{break-inside:avoid;orphans:3;widows:3}
</style>
</head>
<body>

<div style="display:grid;grid-template-columns:1fr auto;gap:36px;padding-bottom:20px;border-bottom:1px solid #1c191722;">
<div>
<div style="display:inline-flex;flex-direction:column;align-items:center;line-height:1;padding-bottom:0.34em;">
<span style="font-family:var(--serif);font-weight:400;font-size:26px;letter-spacing:0.34em;text-indent:0.34em;color:var(--ink);white-space:nowrap;">ROMA <em style="font-style:normal;font-size:0.62em;letter-spacing:0.2em;text-indent:0.2em;color:var(--muted);">FLOORING</em></span>
<span style="font-family:'Pinyon Script','Cormorant Garamond',cursive;font-size:35px;line-height:1;color:var(--accent);margin-top:-11px;white-space:nowrap;">Designs</span>
</div>
<div class="small" style="margin-top:14px;">Roma Flooring Designs, Inc.<br />1440 S. State College Blvd #6M, Anaheim, CA 92806<br />(714) 999-0009 · Sales@romaflooringdesigns.com<br />License #830966</div>
</div>
<div style="text-align:right;min-width:220px;">
<div class="mono" style="letter-spacing:0.22em;">${docType}</div>
<div style="font:300 32px/1 var(--serif);letter-spacing:-0.014em;margin-top:6px;">${estimateNumber}</div>
<div style="margin-top:14px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font:400 10px/1.4 var(--sans);text-align:left;">
<span style="color:var(--muted);">Issued</span><span style="text-align:right;">${issued}</span>
<span style="color:var(--muted);">Valid until</span><span style="text-align:right;">${validUntil || '30 days from issue'}</span>
${e.rep_name ? `<span style="color:var(--muted);">Prepared by</span><span style="text-align:right;">${e.rep_name}</span>` : ''}
<span style="color:var(--muted);">Status</span><span class="mono" style="color:${isExpired ? 'var(--muted)' : 'var(--accent)'};text-align:right;letter-spacing:0.18em;">● ${statusLabel}</span>
</div>
</div>
</div>

<div style="display:grid;grid-template-columns:1fr auto;gap:24px;padding:14px 0;margin-bottom:8px;border-bottom:1px solid #1c191711;align-items:center;">
<div style="font:500 9px/1.4 var(--sans);letter-spacing:0.06em;color:#1c1917cc;">
${greeting}
</div>
<div style="padding:8px 14px;border:1.5px solid ${isExpired ? 'var(--muted)' : 'var(--accent)'};color:${isExpired ? 'var(--muted)' : 'var(--accent)'};font:500 11px/1 ui-monospace,monospace;letter-spacing:0.32em;text-transform:uppercase;transform:rotate(-2deg);">${stampText}</div>
</div>

<div class="keep" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:14px 0 22px;border-bottom:1px solid #1c191722;">
<div>
<div class="mono" style="margin-bottom:8px;">Prepared for</div>
<div style="font:500 11px/1.2 var(--sans);">${e.customer_name || ''}</div>
<div class="small" style="margin-top:4px;">${[e.customer_email, e.phone].filter(Boolean).join('<br />')}</div>
</div>
${projectCard}
${accountCard}
</div>

${materialsSection}
${laborSection}

<div class="keep" style="display:grid;grid-template-columns:1fr 240px;gap:32px;margin-top:14px;border-top:1px solid #1c191733;padding-top:14px;">
<div style="padding-top:4px;" class="small">
${e.notes ? `<div class="mono" style="margin-bottom:8px;">Notes</div><div style="margin-bottom:14px;white-space:pre-wrap;">${e.notes}</div>` : ''}
<div class="mono" style="margin-bottom:8px;">How to accept</div>
<div style="margin-bottom:10px;">
<span style="color:var(--muted);">Online</span>&nbsp;&nbsp;<span style="color:var(--ink);">Open your estimate link to review &amp; approve — a typed name is your signature</span><br />
<span style="color:var(--muted);">Showroom</span>&nbsp;&nbsp;<span style="color:var(--ink);">(714) 999-0009 · 1440 S. State College Blvd #6M, Anaheim</span><br />
<span style="color:var(--muted);">Email</span>&nbsp;&nbsp;<span style="color:var(--ink);">Reply to your estimate email${e.rep_email ? ' or write ' + e.rep_email : ''}</span>
</div>
<div class="mono" style="margin-bottom:8px;margin-top:14px;">Terms &amp; validity</div>
<div>${validUntil ? `Valid through ${validUntil}` : 'Valid for 30 days from the date of issue'}; labor rates may vary based on site conditions. Sales tax applies to materials only. Natural stone and wood vary by lot — final selections are approved at the showroom or from delivered samples.${(milestones && milestones.length) ? ` <span style="color:var(--ink);">Payment is due per the payment schedule above (${milestones.map(m => `${escDoc(m.label)}${m.due_label ? ' ' + escDoc(m.due_label) : ''} — ${money(m.amount)}`).join('; ')}); accepting this ${docNoun} constitutes agreement to that schedule.</span>` : ''} Roma Flooring Designs · License #830966.</div>
</div>
<div>
${totalsRows}
<div style="margin-top:8px;padding-top:8px;border-top:1.5px solid var(--ink);display:flex;justify-content:space-between;align-items:baseline;">
<span class="mono" style="color:var(--ink);letter-spacing:0.18em;">${isQuoteDoc ? 'Quote' : 'Estimate'} total · USD</span>
<span style="font:300 28px/1 var(--serif);letter-spacing:-0.012em;">${money(e.total)}</span>
</div>
${validUntil ? `<div class="mono" style="color:${isExpired ? 'var(--muted)' : 'var(--accent)'};text-align:right;margin-top:6px;letter-spacing:0.16em;">● ${isExpired ? 'Expired' : 'Valid until'} ${validUntil}</div>` : ''}
${(milestones && milestones.length) ? `<div class="keep" style="margin-top:14px;padding-top:10px;border-top:0.5px solid #1c191733;">
<div class="mono" style="color:var(--accent);margin-bottom:8px;letter-spacing:0.16em;">Payment schedule</div>
${milestones.map(m => `<div style="display:flex;justify-content:space-between;padding:4px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">${escDoc(m.label)}${m.percent ? ` · ${parseFloat(m.percent)}%` : ''}${m.due_label ? ` <span style="color:#1c191799;">(${escDoc(m.due_label)})</span>` : ''}</span><span>${money(m.amount)}</span></div>`).join('')}
</div>` : ''}
</div>
</div>

<div class="keep" style="display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:26px;">
<div><div style="border-bottom:0.5px solid var(--ink);height:26px;"></div><div class="mono" style="margin-top:5px;letter-spacing:0.16em;">Customer acceptance · date</div></div>
<div><div style="border-bottom:0.5px solid var(--ink);height:26px;"></div><div class="mono" style="margin-top:5px;letter-spacing:0.16em;">Roma Flooring Designs · date</div></div>
</div>

<div style="margin-top:18px;padding-top:12px;border-top:1px solid #1c191722;display:flex;justify-content:space-between;align-items:center;font:400 9px/1.4 var(--sans);color:var(--muted);">
<span>Roma Flooring Designs, Inc. · 1440 S. State College Blvd #6M · Anaheim, CA 92806 · License #830966</span>
<span style="font:500 9px/1 ui-monospace,monospace;letter-spacing:0.18em;text-transform:uppercase;">Estimate ${estimateNumber}</span>
</div>

</body>
</html>`;
}

// Shared order invoice document — same editorial system as generateQuoteHtml
// (letterhead, greeting band with status stamp, three info cards, swatch-led
// line items, terms + totals columns), adapted for an invoice: Bill To / Ship
// To, an Amount Paid line, and an emphasized Balance Due. `o` is the order row;
// items may carry primary_image (swatch), vendor_sku / vendor_name / collection.
export function generateOrderInvoiceDoc(o, items, payment, milestones = []) {
  const money = (n) => '$' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const longDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'long', day: 'numeric' }) : null;
  const issued = longDate(o.created_at);
  const isPickup = o.delivery_method === 'pickup';
  const isWillCall = o.delivery_method === 'will_call';
  const orderNumber = o.order_number || 'RD-' + String(o.id).substring(0, 8).toUpperCase();

  // The estimate->order conversion stamps system metadata into notes ("Converted
  // from Estimate …. Started on terms — balance due."). Strip it from the
  // customer invoice — it stays internal (order detail + activity log).
  const custNotes = (o.notes || '')
    .replace(/Converted from Estimate[^.]*\./i, '')
    .replace(/Started on terms\s*[—–-]\s*balance due\./i, '')
    .trim();

  const total = parseFloat(o.total || 0);
  const amountPaid = parseFloat(o.amount_paid || 0);
  const balanceDue = parseFloat((total - amountPaid).toFixed(2));
  const hasBalance = balanceDue > 0.01;

  // Compact "paid via" line for the totals block. `payment` is the most recent
  // settled Stripe payment (card/ACH). The receipt NUMBER goes on the printed
  // invoice; the receipt URL is linked from the digital documents list instead.
  const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const paidVia = (payment && amountPaid > 0) ? (() => {
    const method = payment.card_brand
      ? cap(payment.card_brand) + (payment.card_last4 ? ' ····' + payment.card_last4 : '')
      : payment.payment_method === 'ach' ? 'bank account (ACH)'
      : payment.payment_method === 'bank_transfer' ? 'bank transfer'
      : 'card';
    const when = longDate(payment.created_at);
    const rcpt = payment.stripe_receipt_number ? ' · Stripe receipt #' + payment.stripe_receipt_number : '';
    return `Paid via ${method}${when ? ' on ' + when : ''}${rcpt}`;
  })() : null;

  const statusLabel = hasBalance ? 'Balance Due' : 'Paid';
  const stampColor = hasBalance ? 'var(--accent)' : '#3f7a4f';

  const SWATCH_FALLBACKS = [
    'linear-gradient(135deg,#caa97f,#7a5635)',
    'linear-gradient(135deg,#ebe7df,#a8a59e)',
    'linear-gradient(135deg,#e7e3db,#b0aca4)',
    'linear-gradient(135deg,#a89074,#5e4a36)',
  ];

  const rowsHtml = items.map((i, idx) => {
    // Labor lines (estimate conversions): no swatch/sqft/boxes — show the
    // service description and rate basis instead
    if ((i.item_type || 'material') === 'labor') {
      // Spread labor across the same Coverage / Qty / Unit columns as materials
      // (per-sqft: area in Coverage, rate in Unit) instead of cramming
      // "rate × sqft" into the narrow Unit cell.
      const isPerSqft = i.rate_type === 'per_sqft';
      const laborQty = parseFloat(i.quantity || 1);
      const coverCell = isPerSqft
        ? `${parseFloat(i.labor_sqft || 0).toFixed(0)} sf`
        : '—';
      const qtyCell = (!isPerSqft && laborQty > 1) ? laborQty.toFixed(0) : '—';
      const unitCell = isPerSqft
        ? `${money(i.rate_sqft)}/sf`
        : (laborQty > 1 ? money(i.unit_price) : 'Flat rate');
      const descLine = i.description
        ? `<div style="font:400 9px/1.5 var(--sans);color:#1c191799;margin-top:3px;">${String(i.description).split('\n').join(' · ')}</div>` : '';
      return `<div class="grid-row keep" style="padding:12px 0;${idx < items.length - 1 ? 'border-bottom:1px solid #1c191711;' : ''}">
        <div class="swatch" style="background:var(--warm);display:flex;align-items:center;justify-content:center;font:500 7px/1 ui-monospace,monospace;letter-spacing:0.08em;color:var(--ink);">LBR</div>
        <div>
          <div style="font:500 11px/1.2 var(--sans);letter-spacing:-0.004em;">${i.product_name || 'Labor'}</div>
          ${descLine}
          ${i.source_estimate_area ? `<div style="font:500 9px/1 ui-monospace,monospace;letter-spacing:0.12em;color:var(--muted);margin-top:4px;text-transform:uppercase;">${i.source_estimate_area}</div>` : ''}
        </div>
        <div class="num">${coverCell}</div>
        <div class="num">${qtyCell}</div>
        <div class="num">${unitCell}</div>
        <div class="line-total">${money(i.subtotal)}</div>
      </div>`;
    }
    const isUnit = i.sell_by === 'unit';
    const qty = i.num_boxes || i.quantity || 1;
    const ci = composeItemName(i);
    let baseName = ci.title;
    if ((!baseName || baseName === 'Product') && i.description) baseName = i.description;
    const name = escDoc(baseName || '—');
    const suffix = escDoc(ci.descriptors.join(' · '));
    const brandLine = escDoc(ci.vendor || '');
    const skuLine = escDoc(ci.sku || '');
    // Coverage: prefer the captured sqft_needed; otherwise fall back to
    // qty × sqft/box so box lines aren't blank. Per-box uses the real packaging
    // figure, not total÷qty. Unit items have no coverage.
    const perBoxSqft = parseFloat(i.sqft_per_box || 0);
    let sqft = parseFloat(i.sqft_needed || 0);
    if (!(sqft > 0) && !isUnit && perBoxSqft > 0 && qty > 0) sqft = perBoxSqft * qty;
    const perBox = !isUnit ? (perBoxSqft > 0 ? perBoxSqft : (sqft > 0 && qty > 0 ? sqft / qty : null)) : null;
    const isFree = i.is_sample && parseFloat(i.subtotal || 0) === 0;
    const gradient = SWATCH_FALLBACKS[idx % SWATCH_FALLBACKS.length];
    const swatchSrc = i.primary_image
      ? `http://localhost:${process.env.PORT || 3001}/api/img?url=${encodeURIComponent(i.primary_image)}&w=64&f=jpeg`
      : null;
    const swatch = swatchSrc
      ? `<div class="swatch" style="background:${gradient};overflow:hidden;"><img src="${swatchSrc}" style="width:100%;height:100%;object-fit:cover;display:block;" /></div>`
      : `<div class="swatch" style="background:${gradient};"></div>`;
    return `<div class="grid-row keep" style="padding:12px 0;${idx < items.length - 1 ? 'border-bottom:1px solid #1c191711;' : ''}">
      ${swatch}
      <div>
        ${brandLine ? `<div style="font:400 9px/1.5 var(--sans);color:#1c191799;margin-bottom:2px;">${brandLine}</div>` : ''}
        <div style="font:500 11px/1.2 var(--sans);letter-spacing:-0.004em;">${name}${suffix ? ` <span style="color:var(--muted);font-weight:400;">· ${suffix}</span>` : ''}</div>
        ${skuLine ? `<div style="font:400 9px/1.5 var(--sans);color:#1c191799;margin-top:3px;">${skuLine}</div>` : ''}
        ${i.is_sample ? `<div style="font:500 9px/1 ui-monospace,monospace;letter-spacing:0.12em;color:var(--muted);margin-top:4px;text-transform:uppercase;">Sample</div>` : ''}
      </div>
      <div class="num">${isUnit || !sqft ? '—' : sqft.toFixed(1) + ' sf'}${perBox ? `<div class="numsub">${perBox.toFixed(1)} sf / box</div>` : ''}</div>
      <div class="num">${qty}<div class="numsub">${isUnit ? (qty === 1 ? 'unit' : 'units') : (qty === 1 ? 'box' : 'boxes')}</div></div>
      <div class="num">${isFree ? 'Free' : money(i.unit_price) + priceUnitSuffix(i)}</div>
      <div class="line-total">${isFree ? 'Free' : money(i.subtotal)}</div>
    </div>`;
  }).join('');

  const shipAddress = [
    o.shipping_address_line1,
    o.shipping_address_line2,
    o.shipping_city ? `${o.shipping_city}, ${o.shipping_state || ''} ${o.shipping_zip || ''}` : null
  ].filter(Boolean).join('<br />');

  const deliveryCard = isPickup
    ? `<div>
        <div class="mono" style="margin-bottom:8px;">Ship to</div>
        <div style="font:500 11px/1.2 var(--sans);">Showroom pickup</div>
        <div class="small" style="margin-top:4px;">1440 S. State College Blvd Suite 6M<br />Anaheim, CA 92806</div>
        <div style="margin-top:8px;padding:6px 10px;background:var(--warm);font:500 9px/1.4 ui-monospace,monospace;letter-spacing:0.14em;text-transform:uppercase;display:inline-block;">● Anaheim showroom</div>
      </div>`
    : isWillCall
    ? `<div>
        <div class="mono" style="margin-bottom:8px;">Fulfillment</div>
        <div style="font:500 11px/1.2 var(--sans);">Will-call at distributor</div>
        <div class="small" style="margin-top:4px;">Pickup location and PO release details are on your material release form.</div>
        <div style="margin-top:8px;padding:6px 10px;background:var(--warm);font:500 9px/1.4 ui-monospace,monospace;letter-spacing:0.14em;text-transform:uppercase;display:inline-block;">● Distributor will-call</div>
      </div>`
    : `<div>
        <div class="mono" style="margin-bottom:8px;">Ship to</div>
        <div style="font:500 11px/1.2 var(--sans);">${o.customer_name || 'Local delivery'}</div>
        <div class="small" style="margin-top:4px;">${shipAddress || 'Address to be confirmed'}</div>
      </div>`;

  const accountCard = `<div>
      <div class="mono" style="margin-bottom:8px;">Roma account</div>
      <div style="font:500 11px/1.2 var(--sans);">${o.customer_name || ''}${o.company_name ? ' · Trade Pro' : ''}</div>
      <div class="small" style="margin-top:4px;">${o.company_name ? o.company_name + '<br />' : ''}${o.rep_name ? `<span style="color:var(--muted);">Your rep</span><br />${o.rep_name}${o.rep_email ? '<br />' + o.rep_email : ''}<br />(714) 999-0009` : '(714) 999-0009'}</div>
    </div>`;

  const hasLabor = items.some(i => (i.item_type || 'material') === 'labor');
  const totalsRows = [
    `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">${hasLabor ? 'Subtotal · materials &amp; labor' : 'Subtotal · materials'}</span><span>${money(o.subtotal)}</span></div>`,
    parseFloat(o.discount_amount || 0) > 0
      ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Discount${o.promo_code ? ' · ' + o.promo_code : ''}</span><span style="color:var(--accent);">−${money(o.discount_amount)}</span></div>` : '',
    parseFloat(o.shipping || 0) > 0
      ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Shipping${o.shipping_method ? ' · ' + (o.shipping_method === 'ltl_freight' ? 'LTL Freight' : 'Parcel') : ''}</span><span>${money(o.shipping)}</span></div>` : '',
    parseFloat(o.sample_shipping || 0) > 0
      ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Sample shipping</span><span>${money(o.sample_shipping)}</span></div>` : '',
    parseFloat(o.tax_amount || 0) > 0
      ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Sales tax</span><span>${money(o.tax_amount)}</span></div>` : '',
  ].filter(Boolean).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,400&family=Inter:wght@300;400;500;600&family=Pinyon+Script&display=swap');
:root{--serif:'Cormorant Garamond','Times New Roman',serif;--sans:'Inter',system-ui,sans-serif;--ink:#1c1917;--accent:#a87935;--muted:#8a7e68;--warm:#d8cdb6}
*{box-sizing:border-box}
body{font-family:var(--sans);color:var(--ink);margin:0;background:#fff}
@media screen{body{padding:48px 56px;max-width:816px;margin:0 auto}}
.mono{font:500 9px/1 ui-monospace,monospace;letter-spacing:0.2em;text-transform:uppercase;color:var(--muted)}
.small{font:400 10px/1.5 var(--sans);color:#1c1917cc}
.grid-row{display:grid;grid-template-columns:32px 1fr 86px 70px 80px 84px;gap:12px;align-items:flex-start}
.swatch{width:32px;height:32px;border:0.5px solid #1c191733}
.num{text-align:right;font:400 11px/1.2 var(--sans)}
.numsub{font:400 9px/1.4 var(--sans);color:var(--muted);margin-top:2px}
.line-total{text-align:right;font:500 12px/1.2 var(--serif)}
.keep{break-inside:avoid;orphans:3;widows:3}
</style>
</head>
<body>

<div style="display:grid;grid-template-columns:1fr auto;gap:36px;padding-bottom:20px;border-bottom:1px solid #1c191722;">
<div>
<div style="display:inline-flex;flex-direction:column;align-items:center;line-height:1;padding-bottom:0.34em;">
<span style="font-family:var(--serif);font-weight:400;font-size:26px;letter-spacing:0.34em;text-indent:0.34em;color:var(--ink);white-space:nowrap;">ROMA <em style="font-style:normal;font-size:0.62em;letter-spacing:0.2em;text-indent:0.2em;color:var(--muted);">FLOORING</em></span>
<span style="font-family:'Pinyon Script','Cormorant Garamond',cursive;font-size:35px;line-height:1;color:var(--accent);margin-top:-11px;white-space:nowrap;">Designs</span>
</div>
<div class="small" style="margin-top:14px;">Roma Flooring Designs, Inc.<br />1440 S. State College Blvd #6M, Anaheim, CA 92806<br />(714) 999-0009 · Sales@romaflooringdesigns.com<br />License #830966</div>
</div>
<div style="text-align:right;min-width:220px;">
<div class="mono" style="letter-spacing:0.22em;">Invoice</div>
<div style="font:300 32px/1 var(--serif);letter-spacing:-0.014em;margin-top:6px;">${orderNumber}</div>
<div style="margin-top:14px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font:400 10px/1.4 var(--sans);text-align:left;">
<span style="color:var(--muted);">Issued</span><span style="text-align:right;">${issued}</span>
${o.po_number ? `<span style="color:var(--muted);">PO ref</span><span style="text-align:right;">${o.po_number}</span>` : ''}
${o.job_name ? `<span style="color:var(--muted);">Job / Sidemark</span><span style="text-align:right;">${escDoc(o.job_name)}</span>` : ''}
<span style="color:var(--muted);">Status</span><span class="mono" style="color:${stampColor};text-align:right;letter-spacing:0.18em;">● ${statusLabel}</span>
</div>
</div>
</div>

<div class="keep" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:18px 0 22px;border-bottom:1px solid #1c191722;">
<div>
<div class="mono" style="margin-bottom:8px;">Bill to</div>
<div style="font:500 11px/1.2 var(--sans);">${o.customer_name || ''}</div>
<div class="small" style="margin-top:4px;">${[o.customer_email, o.phone].filter(Boolean).join('<br />')}</div>
</div>
${deliveryCard}
${accountCard}
</div>

<div style="padding-top:18px;">
<div class="grid-row" style="padding-bottom:10px;border-bottom:1px solid #1c191733;font:500 9px/1 ui-monospace,monospace;letter-spacing:0.18em;text-transform:uppercase;color:var(--muted);">
<span></span><span>Description</span><span style="text-align:right;">Coverage</span><span style="text-align:right;">Qty</span><span style="text-align:right;">Unit</span><span style="text-align:right;">Line total</span>
</div>
${rowsHtml}
</div>

<div class="keep" style="display:grid;grid-template-columns:1fr 240px;gap:32px;margin-top:14px;border-top:1px solid #1c191733;padding-top:14px;">
<div style="padding-top:4px;" class="small">
${custNotes ? `<div class="mono" style="margin-bottom:8px;">Notes</div><div style="margin-bottom:14px;white-space:pre-wrap;">${custNotes}</div>` : ''}
<div class="mono" style="margin-bottom:8px;">How to pay</div>
<div style="margin-bottom:10px;">
<span style="color:var(--muted);">Online</span>&nbsp;&nbsp;<span style="color:var(--ink);">romaflooringdesigns.com/account — pay under Account · Orders</span><br />
<span style="color:var(--muted);">Showroom</span>&nbsp;&nbsp;<span style="color:var(--ink);">(714) 999-0009 · 1440 S. State College Blvd #6M, Anaheim</span><br />
<span style="color:var(--muted);">Email</span>&nbsp;&nbsp;<span style="color:var(--ink);">Reply to your invoice email${o.rep_email ? ' or write ' + o.rep_email : ''}</span>
</div>
<div class="mono" style="margin-bottom:8px;margin-top:14px;">Payment</div>
<div>${(milestones && milestones.length) ? 'Payment is due per the payment schedule above.' : 'Payment is due on receipt unless otherwise agreed.'} See the Terms of Sale on the reverse.</div>
</div>
<div>
${totalsRows}
<div style="margin-top:8px;padding-top:8px;border-top:1.5px solid var(--ink);display:flex;justify-content:space-between;align-items:baseline;">
<span class="mono" style="color:var(--ink);letter-spacing:0.18em;">Total · USD</span>
<span style="font:300 28px/1 var(--serif);letter-spacing:-0.012em;">${money(total)}</span>
</div>
<div style="display:flex;justify-content:space-between;padding:8px 0 0;font:400 10px/1.4 var(--sans);"><span style="color:var(--muted);">Amount paid</span><span>${amountPaid > 0 ? '−' + money(amountPaid) : money(0)}</span></div>
${paidVia ? `<div style="display:flex;justify-content:flex-end;padding:2px 0 0;font:400 8.5px/1.4 var(--sans);color:var(--muted);">${paidVia}</div>` : ''}
<div style="margin-top:6px;padding-top:8px;border-top:1px solid #1c191722;display:flex;justify-content:space-between;align-items:baseline;">
<span class="mono" style="color:${stampColor};letter-spacing:0.18em;">Balance due</span>
<span style="font:400 22px/1 var(--serif);letter-spacing:-0.012em;color:var(--ink);">${money(hasBalance ? balanceDue : 0)}</span>
</div>
${(milestones && milestones.length) ? `<div class="keep" style="margin-top:12px;padding-top:8px;border-top:1px solid #1c191722;">
<div class="mono" style="color:var(--accent);margin-bottom:6px;letter-spacing:0.16em;">Payment schedule</div>
${milestones.map(m => {
  const st = m.status === 'paid' ? { t: 'Paid', c: '#3f7a4f' } : m.status === 'due' ? { t: (parseFloat(m.remaining) < parseFloat(m.amount) ? 'Due · ' + money(m.remaining) : 'Due'), c: 'var(--accent)' } : { t: 'Upcoming', c: 'var(--muted)' };
  return `<div style="display:flex;justify-content:space-between;padding:4px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">${escDoc(m.label)}${m.percent ? ' · ' + parseFloat(m.percent) + '%' : ''}${m.due_label ? ` <span style="color:#1c191799;">(${escDoc(m.due_label)})</span>` : ''}</span><span>${money(m.amount)} <span style="color:${st.c};font-weight:500;">· ${st.t}</span></span></div>`;
}).join('')}
</div>` : ''}
</div>
</div>

<!-- Acceptance — the invoice front stays clean and just POINTS to the reverse; the
     binding signature lives at the bottom of the Terms of Sale page so the customer
     signs directly beneath the terms they are agreeing to (direct assent). -->
<div class="keep" style="margin-top:22px;padding-top:12px;border-top:1px solid #1c191722;">
<div class="small" style="max-width:660px;">This sale is subject to Roma's <strong>Terms of Sale on the reverse / attached Terms of Sale page</strong> (also at romaflooringdesigns.com/terms), including that <strong>all sales are final</strong> and that installing or using material is final acceptance of it. <strong>Please review and sign the Terms of Sale on the reverse.</strong></div>
</div>

<div style="margin-top:26px;padding-top:12px;border-top:1px solid #1c191722;display:flex;justify-content:space-between;align-items:center;font:400 9px/1.4 var(--sans);color:var(--muted);">
<span>Roma Flooring Designs, Inc. · 1440 S. State College Blvd #6M · Anaheim, CA 92806 · License #830966</span>
<span style="font:500 9px/1 ui-monospace,monospace;letter-spacing:0.18em;text-transform:uppercase;">Invoice ${orderNumber}</span>
</div>

<!-- ===== REVERSE SIDE — full Terms of Sale on its own page (prints on the back when
     the invoice is duplexed). Readable single column; condensed faithfully from the
     full Terms of Service at romaflooringdesigns.com/terms. ===== -->
<div style="break-before:page;page-break-before:always;">
<div style="display:flex;justify-content:space-between;align-items:baseline;padding-bottom:12px;border-bottom:1px solid #1c191722;margin-bottom:18px;">
<div style="font:300 24px/1 var(--serif);letter-spacing:-0.01em;">Terms of Sale</div>
<div class="mono">Roma Flooring Designs &middot; Invoice ${orderNumber}</div>
</div>
<div style="font:400 9.5px/1.55 var(--sans);color:#1c1917cc;">
<p style="margin:0 0 9px;"><strong>1. All sales are final.</strong> Materials are sold with no returns, exchanges, refunds, or cancellations. Special-order, custom, cut, closeout, and clearance items are non-returnable and non-refundable in every case. Any exception is granted solely at Roma's written discretion and may be conditioned on the material being unopened and in resalable condition and on payment of restocking, handling, and freight charges as Roma determines.</p>
<p style="margin:0 0 9px;"><strong>2. Inspect before installation.</strong> You are responsible for inspecting all materials before installation. Before installing, cutting, or using any product you must verify quantity, color, shade, lot, size, quality, and condition, and confirm the material is acceptable and suitable for its intended use. Do not install material you believe to be incorrect or unacceptable — contact us first.</p>
<p style="margin:0 0 9px;"><strong>3. No claims after installation.</strong> Installing, cutting, or using any material is your final acceptance of it in its delivered condition. Once installed, cut, or used, material is deemed inspected, accepted, and satisfactory, and Roma assumes no responsibility for color, shade, quality, size, or other variation, or for labor, installation, removal, replacement, or related costs. Any permitted claim must be raised before installation.</p>
<p style="margin:0 0 9px;"><strong>4. Natural materials &amp; variation.</strong> Stone, tile, wood, and other natural or nature-derived products vary in color, veining, shade, tone, texture, finish, size, and marking. This variation is normal and inherent — a characteristic of natural products, not a defect — and is never a basis for a claim, return, or refund. Samples, displays, and on-screen images are representative only and are not guaranteed to match production material.</p>
<p style="margin:0 0 9px;"><strong>5. Warranties &amp; disclaimer.</strong> Manufactured products may carry the applicable manufacturer's warranty, which is provided by the manufacturer and not by Roma, and is subject to that manufacturer's terms and process. Except for any express written warranty provided by Roma, all products and services are furnished <strong>"AS IS" and "WITH ALL FAULTS,"</strong> and Roma disclaims all other warranties, express or implied, including any implied warranty of merchantability or fitness for a particular purpose, to the fullest extent permitted by law.</p>
<p style="margin:0 0 9px;"><strong>6. Limitation of liability.</strong> To the maximum extent permitted by law, Roma's total liability arising out of or relating to any product, order, or these terms shall not exceed the amount actually paid to Roma for the specific product giving rise to the claim, and Roma shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or for lost profits, labor, installation, removal, replacement, or delay costs. Roma is not responsible for installation performed by you or any third party.</p>
<p style="margin:0 0 9px;"><strong>7. Payment, taxes, title &amp; risk.</strong> Payment is due on receipt unless otherwise agreed; Roma may require a deposit or full payment in advance, particularly for special, custom, or freight orders. Applicable California sales tax is calculated at the time of sale. Title to and risk of loss for all materials pass to you upon delivery or pickup.</p>
<p style="margin:0 0 9px;"><strong>8. Shipping, freight &amp; pickup.</strong> Freight-shipped orders are quoted by destination and scheduled after the order is placed; delivery dates are estimates and are not guaranteed. Inspect every shipment for visible damage or shortage at the time of delivery and note it before signing. Showroom pickup is available at our Anaheim location; uncollected material may be subject to storage fees at Roma's discretion.</p>
<p style="margin:0 0 9px;"><strong>9. Cancellations &amp; special orders.</strong> Orders may be cancelled only with Roma's written consent. Special, custom, and non-stock orders are placed with the vendor on your behalf and are non-cancellable and non-refundable once submitted. Where a cancellation is permitted, restocking, handling, and freight charges may apply and deposits may be forfeited.</p>
<p style="margin:0 0 0;"><strong>10. Governing law.</strong> These terms and any sale are governed by the laws of the State of California, without regard to its conflict-of-laws rules, with exclusive venue in the state or federal courts of Orange County, California. If any provision is found unenforceable, the remaining provisions remain in full force and effect.</p>
</div>
<div style="margin-top:18px;padding-top:12px;border-top:1px solid #1c191722;font:400 8.5px/1.5 var(--sans);color:var(--muted);">These Terms of Sale summarize and are governed by Roma Flooring Designs' full Terms of Service (romaflooringdesigns.com/terms) and Privacy Policy (romaflooringdesigns.com/privacy). Roma Flooring Designs, Inc. &middot; 1440 S. State College Blvd #6M &middot; Anaheim, CA 92806 &middot; License #830966.</div>

<!-- Binding customer acceptance — signed directly beneath the terms above (direct
     assent, not incorporation by reference). -->
<div class="keep" style="margin-top:22px;padding-top:14px;border-top:1.5px solid var(--ink);">
<div class="small" style="margin-bottom:18px;max-width:660px;">By signing below I acknowledge that I have read and agree to the Terms of Sale set out above, including that <strong>all sales are final</strong> and that installing or using material is final acceptance of it, and I confirm I have verified the quantities and colors on Invoice ${orderNumber}.</div>
<div style="display:grid;grid-template-columns:1fr 150px;gap:40px;">
<div style="border-top:1px solid var(--ink);padding-top:6px;font:400 9px/1.4 var(--sans);color:var(--muted);">Customer signature</div>
<div style="border-top:1px solid var(--ink);padding-top:6px;font:400 9px/1.4 var(--sans);color:var(--muted);">Date</div>
</div>
</div>
</div>

</body>
</html>`;
}

// Shared credit memo document — a sibling of generateOrderInvoiceDoc built on the
// same editorial system (letterhead, band + rotated stamp, three info cards,
// swatch-led lines, terms + totals columns). Mirrors the "credit-memo.jsx" design
// from the Roma Claude Design project, with the design's fictional branding
// swapped for the real Roma facts (License #830966, Anaheim address, phone).
// `memo` is a credit_memos row optionally enriched with rma_number / order_number
// / rep_name / rep_email / company_name / customer_email / phone. `items` are
// credit_memo_items rows (description, qty, unit_price, restock_pct, restock_fee,
// refund_line) optionally carrying primary_image / color / variant_name / vendor_name.
// opts may carry { orderNumber } to label the tax reversal.
export function generateCreditMemoDoc(memo, items, opts = {}) {
  const money = (n) => '$' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const longDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'long', day: 'numeric' }) : null;
  const issued = longDate(memo.created_at);
  const orderNumber = opts.orderNumber || memo.order_number || (memo.order_id ? 'RD-' + String(memo.order_id).substring(0, 8).toUpperCase() : '—');
  const cmNumber = memo.credit_memo_number || 'CM-' + String(memo.id).substring(0, 8).toUpperCase();
  const rma = memo.rma_number || null;

  const subtotal = parseFloat(memo.subtotal || 0);      // merchandise returned (gross)
  const restockFee = parseFloat(memo.restock_fee || 0);
  const discountAdj = parseFloat(memo.discount_adjustment || 0);
  const taxRefund = parseFloat(memo.tax_refund || 0);
  const total = parseFloat(memo.total || 0);            // total credit (net refund)

  const settlement = Array.isArray(memo.settlement)
    ? memo.settlement
    : (memo.settlement ? (() => { try { return JSON.parse(memo.settlement); } catch { return []; } })() : []);
  // "Refund Issued" when any tender is a real refund (card/check/etc.); when the
  // whole credit is store credit it's simply "Applied to Account".
  const hasRefund = settlement.some(s => s.method !== 'store_credit');
  const statusLabel = hasRefund ? 'Refund Issued' : 'Applied to Account';
  const stampText = hasRefund ? 'Credit issued' : 'Applied to account';
  const stampColor = '#3f7a4f';

  const customerFirst = (memo.customer_name || '').trim().split(/\s+/)[0] || 'Hello';
  const greeting = `${customerFirst} — this credit memo confirms the return on order ${orderNumber}${rma ? ` (${rma})` : ''}, issued ${issued}. ` +
    (hasRefund
      ? `A total credit of <span style="color:var(--ink);font-weight:500;">${money(total)}</span> has been refunded to your original payment — <span style="color:var(--ink);font-weight:500;">no balance due</span>.`
      : `A total credit of <span style="color:var(--ink);font-weight:500;">${money(total)}</span> has been applied to your Roma account — <span style="color:var(--ink);font-weight:500;">no balance due</span>.`);

  const SWATCH_FALLBACKS = [
    'linear-gradient(135deg,#caa97f,#7a5635)',
    'linear-gradient(135deg,#ebe7df,#a8a59e)',
    'linear-gradient(135deg,#e7e3db,#b0aca4)',
    'linear-gradient(135deg,#a89074,#5e4a36)',
  ];

  const rowsHtml = items.map((i, idx) => {
    const qty = parseFloat(i.qty || 0) || 1;
    const _ci = composeItemName(i);
    const _manual = _ci.title === 'Product' && !_ci.descriptors.length && i.description;
    const name = escDoc(_manual ? i.description : (_ci.title || '—'));
    const suffix = escDoc(_manual ? '' : _ci.descriptors.join(' · '));
    const skuLine = [...new Set([
      i.vendor_sku ? 'SKU ' + i.vendor_sku : null,
      i.collection && i.collection !== name ? i.collection : null,
      i.vendor_name
    ].filter(Boolean))].join(' · ');
    const reasonLine = [i.reason, i.condition ? i.condition.charAt(0).toUpperCase() + i.condition.slice(1) : null]
      .filter(Boolean).join(' · ');
    const unitPrice = parseFloat(i.unit_price || 0);
    const gross = parseFloat((qty * unitPrice).toFixed(2));
    const restockFeeLine = parseFloat(i.restock_fee || 0);
    const restockPct = parseFloat(i.restock_pct || 0);
    const refundLine = parseFloat(i.refund_line != null ? i.refund_line : (gross - restockFeeLine));
    const gradient = SWATCH_FALLBACKS[idx % SWATCH_FALLBACKS.length];
    const swatchSrc = i.primary_image
      ? `http://localhost:${process.env.PORT || 3001}/api/img?url=${encodeURIComponent(i.primary_image)}&w=64&f=jpeg`
      : null;
    const swatch = swatchSrc
      ? `<div class="swatch" style="background:${gradient};overflow:hidden;"><img src="${swatchSrc}" style="width:100%;height:100%;object-fit:cover;display:block;" /></div>`
      : `<div class="swatch" style="background:${gradient};"></div>`;
    const restockCell = restockFeeLine > 0.005
      ? `−${money(restockFeeLine)}<div class="numsub">${restockPct}%</div>`
      : `Waived`;
    return `<div class="grid-row keep" style="padding:12px 0;${idx < items.length - 1 ? 'border-bottom:1px solid #1c191711;' : ''}">
      ${swatch}
      <div>
        <div style="font:500 11px/1.2 var(--sans);letter-spacing:-0.004em;">${name}${suffix ? ` <span style="color:var(--muted);font-weight:400;">· ${suffix}</span>` : ''}</div>
        ${skuLine ? `<div style="font:400 9px/1.5 var(--sans);color:#1c191799;margin-top:3px;">${skuLine}</div>` : ''}
        ${reasonLine ? `<div style="font:500 9px/1 ui-monospace,monospace;letter-spacing:0.1em;color:var(--muted);margin-top:4px;text-transform:uppercase;">${reasonLine}</div>` : ''}
      </div>
      <div class="num">${qty}<div class="numsub">${qty === 1 ? 'unit' : 'units'}</div></div>
      <div class="num">${money(unitPrice)}<div class="numsub">${money(gross)} gross</div></div>
      <div class="num" style="color:${restockFeeLine > 0.005 ? 'var(--ink)' : 'var(--muted)'};">${restockCell}</div>
      <div class="line-total">${money(refundLine)}</div>
    </div>`;
  }).join('');

  const appliedRows = settlement.length
    ? settlement.map(s => {
        const isCredit = s.method === 'store_credit';
        return `<div style="display:flex;justify-content:space-between;padding:6px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;">
          <span style="color:var(--muted);">${s.label || (isCredit ? 'Store credit' : 'Refund')}${isCredit ? ' · added to your account' : ''}</span>
          <span style="color:${isCredit ? 'var(--ink)' : stampColor};">${money(s.amount)}</span>
        </div>`;
      }).join('')
    : `<div style="font:400 10px/1.4 var(--sans);color:var(--muted);padding:6px 0;">Refunded to original payment method.</div>`;

  const accountCard = `<div>
      <div class="mono" style="margin-bottom:8px;">Roma account</div>
      <div style="font:500 11px/1.2 var(--sans);">${memo.customer_name || ''}${memo.company_name ? ' · Trade Pro' : ''}</div>
      <div class="small" style="margin-top:4px;">${memo.company_name ? memo.company_name + '<br />' : ''}${memo.rep_name ? `<span style="color:var(--muted);">Your rep</span><br />${memo.rep_name}${memo.rep_email ? '<br />' + memo.rep_email : ''}<br />(714) 999-0009` : '(714) 999-0009'}</div>
    </div>`;

  const totalsRows = [
    `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Merchandise returned</span><span>${money(subtotal)}</span></div>`,
    restockFee > 0.005
      ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Restocking fee</span><span style="color:var(--accent);">−${money(restockFee)}</span></div>` : '',
    discountAdj > 0.005
      ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Discount adjustment</span><span style="color:var(--accent);">−${money(discountAdj)}</span></div>` : '',
    taxRefund > 0.005
      ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Sales tax<br /><span style="font:400 9px/1.4 var(--sans);color:#1c191799;">Reversed on ${orderNumber}</span></span><span style="color:var(--accent);">${money(taxRefund)}</span></div>` : '',
  ].filter(Boolean).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,400&family=Inter:wght@300;400;500;600&family=Pinyon+Script&display=swap');
:root{--serif:'Cormorant Garamond','Times New Roman',serif;--sans:'Inter',system-ui,sans-serif;--ink:#1c1917;--accent:#a87935;--muted:#8a7e68;--warm:#d8cdb6}
*{box-sizing:border-box}
body{font-family:var(--sans);color:var(--ink);margin:0;background:#fff}
@media screen{body{padding:48px 56px;max-width:816px;margin:0 auto}}
.mono{font:500 9px/1 ui-monospace,monospace;letter-spacing:0.2em;text-transform:uppercase;color:var(--muted)}
.small{font:400 10px/1.5 var(--sans);color:#1c1917cc}
.grid-row{display:grid;grid-template-columns:32px 1fr 70px 86px 80px 84px;gap:12px;align-items:flex-start}
.swatch{width:32px;height:32px;border:0.5px solid #1c191733}
.num{text-align:right;font:400 11px/1.2 var(--sans)}
.numsub{font:400 9px/1.4 var(--sans);color:var(--muted);margin-top:2px}
.line-total{text-align:right;font:500 12px/1.2 var(--serif)}
.keep{break-inside:avoid;orphans:3;widows:3}
</style>
</head>
<body>

<div style="display:grid;grid-template-columns:1fr auto;gap:36px;padding-bottom:20px;border-bottom:1px solid #1c191722;">
<div>
<div style="display:inline-flex;flex-direction:column;align-items:center;line-height:1;padding-bottom:0.34em;">
<span style="font-family:var(--serif);font-weight:400;font-size:26px;letter-spacing:0.34em;text-indent:0.34em;color:var(--ink);white-space:nowrap;">ROMA <em style="font-style:normal;font-size:0.62em;letter-spacing:0.2em;text-indent:0.2em;color:var(--muted);">FLOORING</em></span>
<span style="font-family:'Pinyon Script','Cormorant Garamond',cursive;font-size:35px;line-height:1;color:var(--accent);margin-top:-11px;white-space:nowrap;">Designs</span>
</div>
<div class="small" style="margin-top:14px;">Roma Flooring Designs, Inc.<br />1440 S. State College Blvd #6M, Anaheim, CA 92806<br />(714) 999-0009 · Sales@romaflooringdesigns.com<br />License #830966</div>
</div>
<div style="text-align:right;min-width:220px;">
<div class="mono" style="letter-spacing:0.22em;">Credit Memo</div>
<div style="font:300 32px/1 var(--serif);letter-spacing:-0.014em;margin-top:6px;">${cmNumber}</div>
<div style="margin-top:14px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font:400 10px/1.4 var(--sans);text-align:left;">
<span style="color:var(--muted);">Issued</span><span style="text-align:right;">${issued}</span>
<span style="color:var(--muted);">Against invoice</span><span style="text-align:right;">${orderNumber}</span>
${rma ? `<span style="color:var(--muted);">RMA</span><span style="text-align:right;">${rma}</span>` : ''}
<span style="color:var(--muted);">Status</span><span class="mono" style="color:${stampColor};text-align:right;letter-spacing:0.18em;">● ${statusLabel}</span>
</div>
</div>
</div>

<div style="display:grid;grid-template-columns:1fr auto;gap:24px;padding:14px 0;margin-bottom:8px;border-bottom:1px solid #1c191711;align-items:center;">
<div style="font:500 9px/1.4 var(--sans);letter-spacing:0.06em;color:#1c1917cc;">
${greeting}
</div>
<div style="padding:8px 14px;border:1.5px solid ${stampColor};color:${stampColor};font:500 11px/1 ui-monospace,monospace;letter-spacing:0.32em;text-transform:uppercase;transform:rotate(-2deg);white-space:nowrap;">${stampText}</div>
</div>

<div class="keep" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:14px 0 22px;border-bottom:1px solid #1c191722;">
<div>
<div class="mono" style="margin-bottom:8px;">Credit to</div>
<div style="font:500 11px/1.2 var(--sans);">${memo.customer_name || ''}</div>
<div class="small" style="margin-top:4px;">${[memo.customer_email, memo.phone].filter(Boolean).join('<br />')}</div>
</div>
<div>
<div class="mono" style="margin-bottom:8px;">Return reference</div>
<div style="font:500 11px/1.2 var(--sans);">${rma || 'Return'}</div>
<div class="small" style="margin-top:4px;">Against order ${orderNumber}${memo.created_by_name ? `<br /><span style="color:var(--muted);">Processed by</span><br />${memo.created_by_name}` : ''}</div>
</div>
${accountCard}
</div>

<div style="padding-top:18px;">
<div class="grid-row" style="padding-bottom:10px;border-bottom:1px solid #1c191733;font:500 9px/1 ui-monospace,monospace;letter-spacing:0.18em;text-transform:uppercase;color:var(--muted);">
<span></span><span>Returned item</span><span style="text-align:right;">Qty</span><span style="text-align:right;">Unit</span><span style="text-align:right;">Restock</span><span style="text-align:right;">Line credit</span>
</div>
${rowsHtml}
</div>

<div class="keep" style="display:grid;grid-template-columns:1fr 240px;gap:32px;margin-top:14px;border-top:1px solid #1c191733;padding-top:14px;">
<div style="padding-top:4px;" class="small">
<div class="mono" style="margin-bottom:8px;">Applied to</div>
<div style="margin-bottom:14px;">
${appliedRows}
</div>
<div class="mono" style="margin-bottom:8px;">Terms</div>
<div>This credit memo confirms merchandise returned against ${orderNumber}. Refunds post to the original tender within 5–10 business days; store credit is available immediately on your Roma account. Natural stone and wood vary by lot. Subject to California sales tax. Roma Flooring Designs · License #830966.</div>
</div>
<div>
${totalsRows}
<div style="margin-top:8px;padding-top:8px;border-top:1.5px solid var(--ink);display:flex;justify-content:space-between;align-items:baseline;">
<span class="mono" style="color:var(--ink);letter-spacing:0.18em;">Total credit · USD</span>
<span style="font:300 28px/1 var(--serif);letter-spacing:-0.012em;">${money(total)}</span>
</div>
<div style="margin-top:6px;padding-top:8px;border-top:1px solid #1c191722;display:flex;justify-content:space-between;align-items:baseline;">
<span class="mono" style="color:${stampColor};letter-spacing:0.18em;">${hasRefund ? 'Refunded' : 'Applied'}</span>
<span class="mono" style="color:${stampColor};letter-spacing:0.14em;">● No balance due</span>
</div>
</div>
</div>

<div style="margin-top:26px;padding-top:12px;border-top:1px solid #1c191722;display:flex;justify-content:space-between;align-items:center;font:400 9px/1.4 var(--sans);color:var(--muted);">
<span>Roma Flooring Designs, Inc. · 1440 S. State College Blvd #6M · Anaheim, CA 92806 · License #830966</span>
<span style="font:500 9px/1 ui-monospace,monospace;letter-spacing:0.18em;text-transform:uppercase;">Credit Memo ${cmNumber}</span>
</div>

</body>
</html>`;
}

// Material release form — a warehouse pickup/delivery authorization slip. Lists the
// released items + quantities, the recipient, and a signature block. Mirrors the
// credit-memo doc's Brass-Charcoal styling. No pricing — this is a fulfillment
// authorization, not a financial document.
export function generateReleaseFormDoc(release, items, opts = {}) {
  const longDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'long', day: 'numeric' }) : null;
  const issued = longDate(release.released_at || release.created_at);
  const orderNumber = opts.orderNumber || release.order_number || (release.order_id ? 'RD-' + String(release.order_id).substring(0, 8).toUpperCase() : '—');
  const relNumber = release.release_number || 'REL-' + String(release.id).substring(0, 8).toUpperCase();
  const isDelivery = release.release_method === 'delivery';
  const isWillCall = release.release_method === 'will_call';
  const methodLabel = isDelivery ? 'Delivery' : isWillCall ? 'Will-call at distributor' : 'Warehouse pickup';
  const poNumber = release.po_number || null;

  const statusMap = { released: 'Authorized', completed: isDelivery ? 'Delivered' : 'Picked up', void: 'Voided' };
  const statusLabel = statusMap[release.status] || 'Authorized';
  const isVoid = release.status === 'void';
  const stampColor = isVoid ? '#a13b32' : '#3f7a4f';
  const stampText = isVoid ? 'Voided' : 'Released';

  const deliveryAddr = [release.shipping_address_line1, release.shipping_address_line2,
    [release.shipping_city, release.shipping_state, release.shipping_zip].filter(Boolean).join(', ')]
    .filter(Boolean).join('<br />');

  const SWATCH_FALLBACKS = [
    'linear-gradient(135deg,#caa97f,#7a5635)',
    'linear-gradient(135deg,#ebe7df,#a8a59e)',
    'linear-gradient(135deg,#e7e3db,#b0aca4)',
    'linear-gradient(135deg,#a89074,#5e4a36)',
  ];

  const rowsHtml = items.map((i, idx) => {
    const qty = parseFloat(i.release_qty || 0) || 0;
    const ordered = parseFloat(i.ordered_qty || 0);
    const unit = i.sell_by === 'unit' ? 'unit' : i.sell_by === 'roll' ? 'roll' : 'box';
    const _ci = composeItemName(i);
    const name = escDoc(_ci.title || '—');
    const suffix = escDoc(_ci.descriptors.join(' · '));
    const skuLine = [...new Set([
      i.vendor_sku ? 'SKU ' + i.vendor_sku : null,
      i.collection && i.collection !== name ? i.collection : null,
      i.vendor_name
    ].filter(Boolean))].join(' · ');
    const gradient = SWATCH_FALLBACKS[idx % SWATCH_FALLBACKS.length];
    const swatchSrc = i.primary_image
      ? `http://localhost:${process.env.PORT || 3001}/api/img?url=${encodeURIComponent(i.primary_image)}&w=64&f=jpeg`
      : null;
    const swatch = swatchSrc
      ? `<div class="swatch" style="background:${gradient};overflow:hidden;"><img src="${swatchSrc}" style="width:100%;height:100%;object-fit:cover;display:block;" /></div>`
      : `<div class="swatch" style="background:${gradient};"></div>`;
    return `<div class="grid-row keep" style="padding:12px 0;${idx < items.length - 1 ? 'border-bottom:1px solid #1c191711;' : ''}">
      ${swatch}
      <div>
        <div style="font:500 11px/1.2 var(--sans);letter-spacing:-0.004em;">${name}${suffix ? ` <span style="color:var(--muted);font-weight:400;">· ${suffix}</span>` : ''}</div>
        ${skuLine ? `<div style="font:400 9px/1.5 var(--sans);color:#1c191799;margin-top:3px;">${skuLine}</div>` : ''}
      </div>
      <div class="num">${ordered ? ordered : '—'}<div class="numsub">ordered</div></div>
      <div class="line-total">${qty}<div class="numsub" style="font-weight:400;">${qty === 1 ? unit : unit + 's'} released</div></div>
    </div>`;
  }).join('');

  const totalQty = items.reduce((s, i) => s + (parseFloat(i.release_qty || 0) || 0), 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,400&family=Inter:wght@300;400;500;600&family=Pinyon+Script&display=swap');
:root{--serif:'Cormorant Garamond','Times New Roman',serif;--sans:'Inter',system-ui,sans-serif;--ink:#1c1917;--accent:#a87935;--muted:#8a7e68;--warm:#d8cdb6}
*{box-sizing:border-box}
body{font-family:var(--sans);color:var(--ink);margin:0;background:#fff}
@media screen{body{padding:48px 56px;max-width:816px;margin:0 auto}}
.mono{font:500 9px/1 ui-monospace,monospace;letter-spacing:0.2em;text-transform:uppercase;color:var(--muted)}
.small{font:400 10px/1.5 var(--sans);color:#1c1917cc}
.grid-row{display:grid;grid-template-columns:32px 1fr 90px 120px;gap:12px;align-items:flex-start}
.swatch{width:32px;height:32px;border:0.5px solid #1c191733}
.num{text-align:right;font:400 11px/1.2 var(--sans)}
.numsub{font:400 9px/1.4 var(--sans);color:var(--muted);margin-top:2px}
.line-total{text-align:right;font:500 12px/1.2 var(--serif)}
.keep{break-inside:avoid;orphans:3;widows:3}
</style>
</head>
<body>

<div style="position:relative;display:grid;grid-template-columns:1fr auto;gap:36px;padding-bottom:20px;border-bottom:1px solid #1c191722;">
${isWillCall ? willCallStamp({ top: '16px', left: '52%' }) : ''}
<div>
<div style="display:inline-flex;flex-direction:column;align-items:center;line-height:1;padding-bottom:0.34em;">
<span style="font-family:var(--serif);font-weight:400;font-size:26px;letter-spacing:0.34em;text-indent:0.34em;color:var(--ink);white-space:nowrap;">ROMA <em style="font-style:normal;font-size:0.62em;letter-spacing:0.2em;text-indent:0.2em;color:var(--muted);">FLOORING</em></span>
<span style="font-family:'Pinyon Script','Cormorant Garamond',cursive;font-size:35px;line-height:1;color:var(--accent);margin-top:-11px;white-space:nowrap;">Designs</span>
</div>
<div class="small" style="margin-top:14px;">Roma Flooring Designs, Inc.<br />1440 S. State College Blvd #6M, Anaheim, CA 92806<br />(714) 999-0009 · Sales@romaflooringdesigns.com<br />License #830966</div>
</div>
<div style="text-align:right;min-width:220px;">
<div class="mono" style="letter-spacing:0.22em;">Material Release</div>
<div style="font:300 32px/1 var(--serif);letter-spacing:-0.014em;margin-top:6px;">${relNumber}</div>
<div style="margin-top:14px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font:400 10px/1.4 var(--sans);text-align:left;">
<span style="color:var(--muted);">Released</span><span style="text-align:right;">${issued || '—'}</span>
<span style="color:var(--muted);">Order</span><span style="text-align:right;">${orderNumber}</span>
${isWillCall && poNumber ? `<span style="color:var(--muted);">Release against PO</span><span style="text-align:right;font-weight:500;color:var(--ink);">${escDoc(poNumber)}</span>` : ''}
<span style="color:var(--muted);">Method</span><span style="text-align:right;">${methodLabel}</span>
<span style="color:var(--muted);">Status</span><span class="mono" style="color:${stampColor};text-align:right;letter-spacing:0.18em;">● ${statusLabel}</span>
</div>
</div>
</div>

<div style="display:grid;grid-template-columns:1fr auto;gap:24px;padding:14px 0;margin-bottom:8px;border-bottom:1px solid #1c191711;align-items:center;">
<div style="font:500 9px/1.4 var(--sans);letter-spacing:0.06em;color:#1c1917cc;">
${isWillCall
  ? `This authorizes the customer to collect the materials below at <b>${escDoc(release.vendor_name || 'the distributor')}</b> against order ${orderNumber}${poNumber ? ` under Roma purchase order <b>${escDoc(poNumber)}</b>` : ''}. Present this form and reference the PO number to release the order. Quantities are in cartons/units as sold.`
  : `This document authorizes the materials below to be ${isDelivery ? 'delivered' : 'released for pickup'} against order ${orderNumber}. Present it at the Anaheim warehouse. Quantities are in cartons/units as sold.`}
</div>
<div style="padding:8px 14px;border:1.5px solid ${stampColor};color:${stampColor};font:500 11px/1 ui-monospace,monospace;letter-spacing:0.32em;text-transform:uppercase;transform:rotate(-2deg);white-space:nowrap;">${stampText}</div>
</div>

<div class="keep" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:14px 0 22px;border-bottom:1px solid #1c191722;">
<div>
<div class="mono" style="margin-bottom:8px;">Released to</div>
<div style="font:500 11px/1.2 var(--sans);">${release.recipient_name || release.customer_name || '—'}</div>
<div class="small" style="margin-top:4px;">${[release.customer_name && release.recipient_name && release.customer_name !== release.recipient_name ? 'On order for ' + release.customer_name : null, release.customer_email, release.phone].filter(Boolean).join('<br />')}</div>
</div>
<div>
<div class="mono" style="margin-bottom:8px;">${isDelivery ? 'Deliver to' : 'Pickup at'}</div>
<div style="font:500 11px/1.2 var(--sans);">${isDelivery ? (deliveryAddr || 'Delivery address on file') : isWillCall ? escDoc(release.vendor_name || 'Distributor') : 'Roma — Anaheim'}</div>
<div class="small" style="margin-top:4px;">${isDelivery ? '' : isWillCall ? [release.vendor_address ? escDoc(release.vendor_address) : 'Contact your Roma rep for the pickup address', release.vendor_phone ? escDoc(release.vendor_phone) : null].filter(Boolean).join('<br />') : '1440 S. State College Blvd #6M<br />Anaheim, CA 92806'}</div>
</div>
<div>
<div class="mono" style="margin-bottom:8px;">Authorized by</div>
<div style="font:500 11px/1.2 var(--sans);">${release.released_by_name || 'Roma team'}</div>
<div class="small" style="margin-top:4px;">${release.rep_email ? release.rep_email + '<br />' : ''}(714) 999-0009</div>
</div>
</div>

<div style="padding-top:18px;">
<div class="grid-row" style="padding-bottom:10px;border-bottom:1px solid #1c191733;font:500 9px/1 ui-monospace,monospace;letter-spacing:0.18em;text-transform:uppercase;color:var(--muted);">
<span></span><span>Item</span><span style="text-align:right;">Ordered</span><span style="text-align:right;">Released</span>
</div>
${rowsHtml}
</div>

<div class="keep" style="display:grid;grid-template-columns:1fr 240px;gap:32px;margin-top:14px;border-top:1px solid #1c191733;padding-top:14px;">
<div style="padding-top:4px;" class="small">
${release.notes ? `<div class="mono" style="margin-bottom:8px;">Notes</div><div style="margin-bottom:14px;">${String(release.notes).replace(/</g, '&lt;')}</div>` : ''}
<div class="mono" style="margin-bottom:8px;">Received in good condition</div>
<div style="display:grid;grid-template-columns:1fr 120px;gap:24px;margin-top:26px;">
<div style="border-top:1px solid var(--ink);padding-top:6px;font:400 9px/1.4 var(--sans);color:var(--muted);">Recipient signature</div>
<div style="border-top:1px solid var(--ink);padding-top:6px;font:400 9px/1.4 var(--sans);color:var(--muted);">Date</div>
</div>
</div>
<div>
<div style="padding-top:8px;border-top:1.5px solid var(--ink);display:flex;justify-content:space-between;align-items:baseline;">
<span class="mono" style="color:var(--ink);letter-spacing:0.18em;">Total released</span>
<span style="font:300 28px/1 var(--serif);letter-spacing:-0.012em;">${parseFloat(totalQty.toFixed(2))}</span>
</div>
<div style="margin-top:6px;padding-top:8px;border-top:1px solid #1c191722;display:flex;justify-content:space-between;align-items:baseline;">
<span class="mono" style="color:var(--muted);letter-spacing:0.18em;">${items.length} line${items.length === 1 ? '' : 's'}</span>
<span class="mono" style="color:${stampColor};letter-spacing:0.14em;">● ${statusLabel}</span>
</div>
</div>
</div>

<div style="margin-top:26px;padding-top:12px;border-top:1px solid #1c191722;display:flex;justify-content:space-between;align-items:center;font:400 9px/1.4 var(--sans);color:var(--muted);">
<span>Roma Flooring Designs, Inc. · 1440 S. State College Blvd #6M · Anaheim, CA 92806 · License #830966</span>
<span style="font:500 9px/1 ui-monospace,monospace;letter-spacing:0.18em;text-transform:uppercase;">Release ${relNumber}</span>
</div>

</body>
</html>`;
}

// Installation work order — the crew's job sheet. Job-site address + schedule,
// the materials to bring (pull list, from material lines), the scope of work
// (labor lines), notes, and a completion sign-off. `order` is the order row
// (+ install_* fields); `items` are order_items with composed names.
export function generateWorkOrderDoc(order, items, opts = {}) {
  const longDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' }) : null;
  const orderNumber = order.order_number || 'RD-' + String(order.id).substring(0, 8).toUpperCase();
  const scheduled = [longDate(order.install_scheduled_at), order.install_window].filter(Boolean).join(' · ');
  const jobSite = [order.shipping_address_line1, order.shipping_address_line2,
    [order.shipping_city, order.shipping_state, order.shipping_zip].filter(Boolean).join(', ')]
    .filter(Boolean).map(escDoc).join('<br />');

  const materials = (items || []).filter(i => !i.is_sample && (i.item_type || 'material') !== 'labor');
  const labor = (items || []).filter(i => (i.item_type || 'material') === 'labor');

  const matRows = materials.map((i, idx) => {
    const _ci = composeItemName(i);
    const name = escDoc(_ci.title || i.product_name || '—');
    const suffix = escDoc(_ci.descriptors.join(' · '));
    const unit = i.sell_by === 'unit' ? 'unit' : i.sell_by === 'roll' ? 'roll' : 'box';
    const qty = parseFloat(i.num_boxes || i.quantity || 0) || 0;
    const skuLine = [...new Set([
      i.vendor_sku ? 'SKU ' + i.vendor_sku : null,
      i.collection && i.collection !== name ? i.collection : null,
      i.vendor_name
    ].filter(Boolean))].join(' · ');
    return `<div class="grid-row keep" style="padding:11px 0;${idx < materials.length - 1 ? 'border-bottom:1px solid #1c191711;' : ''}">
      <div>
        <div style="font:500 11px/1.25 var(--sans);">${name}${suffix ? ` <span style="color:var(--muted);font-weight:400;">· ${suffix}</span>` : ''}</div>
        ${skuLine ? `<div style="font:400 9px/1.5 var(--sans);color:#1c191799;margin-top:3px;">${skuLine}</div>` : ''}
      </div>
      <div class="line-total">${qty}<div class="numsub" style="font-weight:400;">${qty === 1 ? unit : unit + 's'}</div></div>
    </div>`;
  }).join('') || `<div style="font:400 10px/1.5 var(--sans);color:var(--muted);padding:11px 0;">No material lines on this order.</div>`;

  const laborRows = labor.map((i, idx) => {
    const cat = escDoc((i.labor_category || 'Labor').replace(/_/g, ' '));
    const desc = escDoc(i.description || i.product_name || '');
    const area = i.source_estimate_area ? ` <span style="color:var(--muted);">· ${escDoc(i.source_estimate_area)}</span>` : '';
    const qty = i.labor_sqft ? `${parseFloat(i.labor_sqft)} sqft` : (i.quantity ? `${parseFloat(i.quantity)}` : '');
    return `<div class="grid-row keep" style="padding:11px 0;${idx < labor.length - 1 ? 'border-bottom:1px solid #1c191711;' : ''}">
      <div>
        <div style="font:500 11px/1.25 var(--sans);text-transform:capitalize;">${cat}${area}</div>
        ${desc ? `<div style="font:400 10px/1.5 var(--sans);color:#1c1917cc;margin-top:3px;">${desc}</div>` : ''}
      </div>
      <div class="line-total" style="font-weight:400;">${qty}</div>
    </div>`;
  }).join('') || `<div style="font:400 10px/1.5 var(--sans);color:var(--muted);padding:11px 0;">Scope of work — see estimate / rep notes.</div>`;

  const metaRows = [
    ['Order', orderNumber],
    ['Install date', scheduled || 'Not yet scheduled'],
    ...(order.install_window ? [['Window', escDoc(order.install_window)]] : []),
    ['Crew', escDoc(order.install_crew || 'Roma install crew')],
    ...(order.job_name ? [['Job', escDoc(order.job_name)]] : []),
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,400&family=Inter:wght@300;400;500;600&family=Pinyon+Script&display=swap');
:root{--serif:'Cormorant Garamond','Times New Roman',serif;--sans:'Inter',system-ui,sans-serif;--ink:#1c1917;--accent:#a87935;--muted:#8a7e68;--warm:#d8cdb6}
*{box-sizing:border-box}
body{font-family:var(--sans);color:var(--ink);margin:0;background:#fff}
@media screen{body{padding:48px 56px;max-width:816px;margin:0 auto}}
.mono{font:500 9px/1 ui-monospace,monospace;letter-spacing:0.2em;text-transform:uppercase;color:var(--muted)}
.small{font:400 10px/1.5 var(--sans);color:#1c1917cc}
.grid-row{display:grid;grid-template-columns:1fr 120px;gap:12px;align-items:flex-start}
.line-total{text-align:right;font:500 12px/1.2 var(--serif)}
.numsub{font:400 9px/1.4 var(--sans);color:var(--muted);margin-top:2px}
.keep{break-inside:avoid;orphans:3;widows:3}
.sec-label{font:500 9px/1 ui-monospace,monospace;letter-spacing:0.2em;text-transform:uppercase;color:var(--accent);margin:26px 0 10px}
</style>
</head>
<body>

<div style="display:grid;grid-template-columns:1fr auto;gap:36px;padding-bottom:20px;border-bottom:1px solid #1c191722;">
<div>
<div style="display:inline-flex;flex-direction:column;align-items:center;line-height:1;padding-bottom:0.34em;">
<span style="font-family:var(--serif);font-weight:400;font-size:26px;letter-spacing:0.34em;text-indent:0.34em;color:var(--ink);white-space:nowrap;">ROMA <em style="font-style:normal;font-size:0.62em;letter-spacing:0.2em;text-indent:0.2em;color:var(--muted);">FLOORING</em></span>
<span style="font-family:'Pinyon Script','Cormorant Garamond',cursive;font-size:35px;line-height:1;color:var(--accent);margin-top:-11px;white-space:nowrap;">Designs</span>
</div>
<div class="small" style="margin-top:14px;">Roma Flooring Designs, Inc.<br />1440 S. State College Blvd #6M, Anaheim, CA 92806<br />(714) 999-0009 · Sales@romaflooringdesigns.com<br />License #830966</div>
</div>
<div style="text-align:right;min-width:220px;">
<div class="mono" style="letter-spacing:0.22em;">Installation Work Order</div>
<div style="font:300 32px/1 var(--serif);letter-spacing:-0.014em;margin-top:6px;">${orderNumber}</div>
<div style="margin-top:14px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font:400 10px/1.4 var(--sans);text-align:left;">
${metaRows.map(([l, v]) => `<span style="color:var(--muted);">${l}</span><span style="text-align:right;">${v}</span>`).join('')}
</div>
</div>
</div>

<div class="keep" style="display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:16px 0 20px;border-bottom:1px solid #1c191722;">
<div>
<div class="mono" style="margin-bottom:8px;">Customer</div>
<div style="font:500 11px/1.2 var(--sans);">${escDoc(order.customer_name || '—')}</div>
<div class="small" style="margin-top:4px;">${[order.company_name, order.phone, order.customer_email].filter(Boolean).map(escDoc).join('<br />')}</div>
</div>
<div>
<div class="mono" style="margin-bottom:8px;">Job site</div>
<div class="small" style="color:var(--ink);">${jobSite || '—'}</div>
</div>
</div>

<div class="sec-label">Materials to bring</div>
${matRows}

<div class="sec-label">Scope of work</div>
${laborRows}

${order.install_notes ? `<div class="sec-label">Notes for the crew</div>
<div style="font:400 11px/1.6 var(--sans);color:#1c1917cc;white-space:pre-wrap;">${escDoc(order.install_notes)}</div>` : ''}

<div class="keep" style="margin-top:34px;padding-top:18px;border-top:1px solid #1c191722;display:grid;grid-template-columns:1fr 1fr;gap:40px;">
<div>
<div style="border-bottom:1px solid #1c191755;height:34px;"></div>
<div class="mono" style="margin-top:6px;">Crew lead signature</div>
</div>
<div>
<div style="border-bottom:1px solid #1c191755;height:34px;"></div>
<div class="mono" style="margin-top:6px;">Customer sign-off · date</div>
</div>
</div>

</body>
</html>`;
}

// Showroom sample labels — Avery 5163 sheet layout (2"×4" labels, 2 columns × 5 rows,
// 10 per US Letter page). Each label states the product/collection name, this tile's
// color/variant, a compact "also available" summary (colors/sizes + accessories), and a
// QR code linking to the SKU's storefront detail page. `labels` is an array of
// { productName, collection, variantLabel, vendorName, colorsCount, sizesCount,
//   accessories[], internalSku, qrDataUri }. The QR is passed in as a data URI (built
// server-side) so Puppeteer renders it offline without a network round-trip.
// Print at 100% (no scaling) onto Avery 5163 stock; call generatePDF with zero margins.
export function generateLabelSheetHtml(labels) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const renderLabel = (l) => {
    const rawName = String(l.productName || l.collection || '—');
    const vendor = String(l.vendorName || '');
    // Drop a redundant leading vendor name from the title (e.g. "Daltile Choice
    // Calm Beige" → "Choice Calm Beige") since the vendor shows as the eyebrow.
    let title = rawName;
    if (vendor && title.toLowerCase().startsWith(vendor.toLowerCase() + ' ')) {
      title = title.slice(vendor.length).trim();
    }
    const variant = esc(l.variantLabel || '');
    const acc = (l.accessories || []).filter(Boolean);
    const colors = (l.colors || []).filter(Boolean);
    const sizes = (l.sizes || []).filter(Boolean);
    const sku = esc(l.internalSku || '');

    // "Available" lists the options that actually vary (colors and/or sizes),
    // followed by the accessories that pair with the line.
    const variantParts = [];
    if (colors.length > 1) variantParts.push(...colors);
    if (sizes.length > 1) variantParts.push(...sizes);
    const variantList = variantParts.join(' · ');

    const availBody = [];
    if (variantList) availBody.push(`<div class="l-availv">${esc(variantList)}</div>`);
    if (acc.length) availBody.push(`<div class="l-availv l-availacc">+ ${esc(acc.join(', '))}</div>`);

    return `
      <div class="label">
        <div class="l-body">
          ${vendor ? `<div class="l-eyebrow">${esc(vendor)}</div>` : ''}
          <div class="l-title">${esc(title)}</div>
          ${variant ? `<div class="l-variant">${variant}</div>` : ''}
          ${availBody.length ? `<div class="l-rule"></div><div class="l-availk">Available</div>${availBody.join('')}` : ''}
        </div>
        <div class="l-qr">
          <div class="l-qrbox"><img src="${l.qrDataUri}" alt="Scan for product details" /></div>
          ${sku ? `<div class="l-sku">${sku}</div>` : ''}
          <div class="l-scan">Scan · details &amp; pricing</div>
        </div>
        <div class="l-foot">
          <span class="l-brand">Roma Flooring Designs</span>
          <span class="l-web">romaflooringdesigns.com</span>
        </div>
      </div>`;
  };

  const pages = [];
  for (let i = 0; i < labels.length; i += 10) pages.push(labels.slice(i, i + 10));
  const pagesHtml = pages.map((pg, idx) => `
    <div class="sheet${idx < pages.length - 1 ? ' brk' : ''}">
      <div class="grid">${pg.map(renderLabel).join('')}</div>
    </div>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
  <style>
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap');
  @page { size: Letter; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: 'Inter', -apple-system, Arial, sans-serif; color: #1c1917; -webkit-font-smoothing: antialiased; }
  .sheet { width: 8.5in; height: 11in; padding: 0.5in 0.15625in; }
  .sheet.brk { page-break-after: always; }
  .grid { display: grid; grid-template-columns: 4in 4in; column-gap: 0.1875in; row-gap: 0; }
  .label { position: relative; width: 4in; height: 2in; padding: 0.17in 0.18in 0.30in; display: flex; gap: 0.16in; overflow: hidden; }
  .l-body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .l-eyebrow { font-size: 6.5pt; font-weight: 600; letter-spacing: 0.2em; text-transform: uppercase; color: #a87935; }
  .l-title { font-family: 'Cormorant Garamond', Georgia, serif; font-weight: 600; font-size: 18.5pt; line-height: 1.0; letter-spacing: 0.004em; color: #1c1917; margin-top: 2px; max-height: 0.55in; overflow: hidden; }
  .l-variant { font-size: 9.5pt; font-weight: 500; color: #57534e; margin-top: 4px; }
  .l-rule { width: 64%; height: 1px; background: linear-gradient(90deg, #a87935, rgba(200,169,126,0.25) 70%, transparent); margin: 7px 0 5px; }
  .l-availk { font-size: 6.3pt; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: #a87935; margin-bottom: 2px; }
  .l-availv { font-size: 7pt; line-height: 1.32; color: #57534e; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .l-availacc { color: #8a817a; margin-top: 1px; }
  .l-qr { width: 0.98in; flex-shrink: 0; display: flex; flex-direction: column; align-items: center; text-align: center; }
  .l-qrbox { padding: 3.5px; border: 0.75px solid #ddd6c9; background: #fff; }
  .l-qr img { width: 0.78in; height: 0.78in; display: block; }
  .l-sku { font-family: ui-monospace, 'SF Mono', monospace; font-size: 6pt; font-weight: 600; letter-spacing: 0.02em; color: #44403c; margin-top: 4px; word-break: break-all; }
  .l-scan { font-size: 5.3pt; font-weight: 600; letter-spacing: 0.11em; text-transform: uppercase; color: #a87935; margin-top: 3px; }
  .l-foot { position: absolute; left: 0.18in; right: 0.18in; bottom: 0.11in; display: flex; justify-content: space-between; align-items: baseline; border-top: 0.5px solid #ece7dd; padding-top: 3px; }
  .l-brand { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 8pt; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; color: #a87935; }
  .l-web { font-size: 5.6pt; font-weight: 500; letter-spacing: 0.07em; text-transform: uppercase; color: #b3a89a; }
  </style></head><body>${pagesHtml}</body></html>`;
}

// Roll-label variant of the sample label: one 4in x 2in label per page, sized for
// a thermal label printer (e.g. Zebra ZD230) that dispenses labels individually.
// Rendered in pure black on white — thermal heads print ~203 dpi with no color, so
// every accent that is gold on the sheet version becomes solid black here, and the
// faint gold gradient rule becomes a crisp black hairline. Same content/QR as the
// sheet labels; only the page geometry and ink change.
export function generateLabelRollHtml(labels) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const renderLabel = (l, isLast) => {
    const rawName = String(l.productName || l.collection || '—');
    const vendor = String(l.vendorName || '');
    let title = rawName;
    if (vendor && title.toLowerCase().startsWith(vendor.toLowerCase() + ' ')) {
      title = title.slice(vendor.length).trim();
    }
    const variant = esc(l.variantLabel || '');
    const acc = (l.accessories || []).filter(Boolean);
    const colors = (l.colors || []).filter(Boolean);
    const sizes = (l.sizes || []).filter(Boolean);
    const sku = esc(l.internalSku || '');

    const variantParts = [];
    if (colors.length > 1) variantParts.push(...colors);
    if (sizes.length > 1) variantParts.push(...sizes);
    const variantList = variantParts.join(' · ');

    const availBody = [];
    if (variantList) availBody.push(`<div class="rl-availv">${esc(variantList)}</div>`);
    if (acc.length) availBody.push(`<div class="rl-availv rl-availacc">+ ${esc(acc.join(', '))}</div>`);

    return `
      <div class="rl-page${isLast ? ' last' : ''}">
        <div class="rl-body">
          ${vendor ? `<div class="rl-eyebrow">${esc(vendor)}</div>` : ''}
          <div class="rl-title">${esc(title)}</div>
          ${variant ? `<div class="rl-variant">${variant}</div>` : ''}
          ${availBody.length ? `<div class="rl-rule"></div><div class="rl-availk">Available</div>${availBody.join('')}` : ''}
        </div>
        <div class="rl-qr">
          <div class="rl-qrbox"><img src="${l.qrDataUri}" alt="Scan for product details" /></div>
          ${sku ? `<div class="rl-sku">${sku}</div>` : ''}
          <div class="rl-scan">Scan · details &amp; pricing</div>
        </div>
        <div class="rl-foot">
          <span class="rl-brand">Roma Flooring Designs</span>
          <span class="rl-web">romaflooringdesigns.com</span>
        </div>
      </div>`;
  };

  const pagesHtml = (labels.length ? labels : [{}])
    .map((l, i) => renderLabel(l, i === labels.length - 1)).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
  <style>
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap');
  @page { size: 4in 2in; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: 'Inter', -apple-system, Arial, sans-serif; color: #000; -webkit-font-smoothing: antialiased; }
  /* One label per page. Break after each except the last so no trailing blank label. */
  .rl-page { position: relative; width: 4in; height: 2in; padding: 0.15in 0.17in 0.26in; display: flex; gap: 0.15in; overflow: hidden; page-break-after: always; }
  .rl-page.last { page-break-after: auto; }
  .rl-body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .rl-eyebrow { font-size: 6.5pt; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: #000; }
  .rl-title { font-family: 'Cormorant Garamond', Georgia, serif; font-weight: 700; font-size: 19pt; line-height: 1.0; letter-spacing: 0.004em; color: #000; margin-top: 2px; max-height: 0.55in; overflow: hidden; }
  .rl-variant { font-size: 9.5pt; font-weight: 600; color: #222; margin-top: 4px; }
  .rl-rule { width: 66%; height: 1.4px; background: #000; margin: 7px 0 5px; }
  .rl-availk { font-size: 6.3pt; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #000; margin-bottom: 2px; }
  .rl-availv { font-size: 7pt; line-height: 1.32; color: #222; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .rl-availacc { color: #444; margin-top: 1px; }
  .rl-qr { width: 1.02in; flex-shrink: 0; display: flex; flex-direction: column; align-items: center; text-align: center; }
  .rl-qrbox { padding: 3px; border: 1px solid #000; background: #fff; }
  .rl-qr img { width: 0.84in; height: 0.84in; display: block; }
  .rl-sku { font-family: ui-monospace, 'SF Mono', monospace; font-size: 6pt; font-weight: 700; letter-spacing: 0.02em; color: #000; margin-top: 4px; word-break: break-all; }
  .rl-scan { font-size: 5.3pt; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #000; margin-top: 3px; }
  .rl-foot { position: absolute; left: 0.17in; right: 0.17in; bottom: 0.1in; display: flex; justify-content: space-between; align-items: baseline; border-top: 1px solid #000; padding-top: 3px; }
  .rl-brand { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 8pt; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #000; }
  .rl-web { font-size: 5.6pt; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #333; }
  </style></head><body>${pagesHtml}</body></html>`;
}

// Render each roll label to a crisp bitmap at the thermal head's native resolution
// (203 dpi -> an 812x406 px PNG per 4in x 2in label). Feeding the printer a
// pre-rasterized image removes all driver font-rasterization / scaling guesswork, so
// hairlines and small type land exactly on the pixel grid. Returns PNG data URIs in
// label order. Reuses generateLabelRollHtml so the image is pixel-identical to the
// vector layout; on screen the labels stack flush (page breaks are print-only), so we
// clip each 2in band in turn.
export async function renderLabelPngs(labels, { dpi = 203 } = {}) {
  if (!labels.length) return [];
  const LABEL_W_CSS = 384, LABEL_H_CSS = 192; // 4in x 2in at 96 CSS dpi
  const dsf = dpi / 96;                       // 96 CSS dpi -> 203 device dpi (exact: 4*203, 2*203)
  const html = generateLabelRollHtml(labels);
  const puppeteer = await import('puppeteer');
  const browser = await puppeteer.default.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: LABEL_W_CSS, height: LABEL_H_CSS * labels.length, deviceScaleFactor: dsf });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 })
      .catch(err => console.warn('renderLabelPngs: assets still loading at timeout, rendering anyway:', err.message));
    // Wait for the web fonts to actually apply so the raster uses Cormorant/Inter, not a
    // fallback. Await inside the page (returns undefined) so nothing non-serializable escapes.
    await page.evaluate(async () => { if (document.fonts && document.fonts.ready) await document.fonts.ready; }).catch(() => {});
    const out = [];
    for (let i = 0; i < labels.length; i++) {
      const buf = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: i * LABEL_H_CSS, width: LABEL_W_CSS, height: LABEL_H_CSS }
      });
      out.push('data:image/png;base64,' + Buffer.from(buf).toString('base64'));
    }
    return out;
  } finally {
    await browser.close();
  }
}

// Wrap pre-rendered 203-dpi label PNGs into a one-4x2-label-per-page document for a
// thermal roll printer. Each page holds exactly one bitmap, filling the label 1:1.
export function generateLabelImageRollHtml(pngDataUris) {
  const list = pngDataUris.length ? pngDataUris : [null];
  const pages = list.map((src, i) => {
    const last = i === list.length - 1;
    return `<div class="ip${last ? ' last' : ''}">${src ? `<img src="${src}" alt=""/>` : ''}</div>`;
  }).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
  <style>
  @page { size: 4in 2in; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  .ip { width: 4in; height: 2in; overflow: hidden; page-break-after: always; }
  .ip.last { page-break-after: auto; }
  .ip img { width: 4in; height: 2in; display: block; }
  </style></head><body>${pages}</body></html>`;
}
