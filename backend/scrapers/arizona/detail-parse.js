import { htmlDecode } from './html.js';
import { parseGallery, parseSwatchImages } from './images.js';

// ══════════════════════════════════════════════════════════════
// Parsers
// ══════════════════════════════════════════════════════════════

/**
 * Parse all data from a product detail page.
 * Returns a unified object matching the Elysium v3 pattern.
 */
export function parseDetailPage(html) {
  // Merge table-based tech specs with regex-based; regex results take priority
  const tableTechSpecs = parseTechnicalSpecsTable(html);
  const regexTechSpecs = parseTechnicalSpecs(html);
  const technicalSpecs = { ...tableTechSpecs, ...regexTechSpecs };

  // Detect packaging PDF link (for future manual review)
  const pkgPdfMatch = html.match(/<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?Thickness\s*(?:&amp;|&)\s*Packaging[\s\S]*?<\/a>/i);
  const packagingPdfUrl = pkgPdfMatch ? htmlDecode(pkgPdfMatch[1]) : null;

  const packaging = parsePackaging(html);
  if (packagingPdfUrl) {
    packaging.pdfUrl = packagingPdfUrl;
    if (Object.keys(packaging).length === 1) {
      // Only pdfUrl, no inline packaging data — log-worthy
      packaging._pdfOnly = true;
    }
  }

  return {
    specs: parseSpecs(html),
    technicalSpecs,
    packaging,
    pricing: parsePricing(html),
    gallery: parseGallery(html),
    variations: parseVariations(html),
    soldBy: parseSoldBy(html),
    stockStatus: parseStockStatus(html),
    swatchImages: parseSwatchImages(html),
  };
}

/**
 * Parse general specs from Product Details tab.
 * Format: <strong>Label:</strong><br />value
 */
export function parseSpecs(html) {
  const specs = {};
  const specPatterns = [
    { regex: /<strong>Product Type:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'type' },
    { regex: /<strong>Origin:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'countryOfOrigin' },
    { regex: /<strong>Stocked Finish(?:es)?(?:\(es\))?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'finish' },
    { regex: /<strong>Stocked Sizes?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'size' },
    { regex: /<strong>Stocked Thickness:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'thickness' },
    { regex: /<strong>Recommended Uses?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'application' },
    { regex: /<strong>Stocked Color(?:s|\/Finishes)?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'colors' },
    { regex: /<strong>Edge:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'edge' },
    { regex: /<strong>Look:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'look' },
    { regex: /<strong>Collection:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'collection' },
  ];

  for (const { regex, key } of specPatterns) {
    const match = html.match(regex);
    if (match) specs[key] = htmlDecode(match[1].trim());
  }

  // Multi-line value extraction: some specs span multiple <br>-separated lines
  const multiLineKeys = [
    { regex: /<strong>Stocked Color(?:s|\/Finishes)?:?<\/strong>\s*([\s\S]*?)(?=<strong>|<\/div>|<\/p>)/i, key: 'colors' },
    { regex: /<strong>Stocked Finish(?:es)?(?:\(es\))?:?<\/strong>\s*([\s\S]*?)(?=<strong>|<\/div>|<\/p>)/i, key: 'finish' },
    { regex: /<strong>Stocked Sizes?:?<\/strong>\s*([\s\S]*?)(?=<strong>|<\/div>|<\/p>)/i, key: 'size' },
    { regex: /<strong>Stocked Thickness:?<\/strong>\s*([\s\S]*?)(?=<strong>|<\/div>|<\/p>)/i, key: 'thickness' },
    { regex: /<strong>Recommended Uses?:?<\/strong>\s*([\s\S]*?)(?=<strong>|<\/div>|<\/p>)/i, key: 'application' },
  ];
  for (const { regex, key } of multiLineKeys) {
    const match = html.match(regex);
    if (match) {
      const lines = match[1]
        .split(/<br\s*\/?>/)
        .map(l => htmlDecode(l.replace(/<[^>]+>/g, '').trim()))
        .filter(Boolean);
      if (lines.length > 1) {
        specs[key] = lines.join(', ');
      }
    }
  }

  return specs;
}

/**
 * Parse technical specs (PEI, DCOF, Water Absorption, etc.)
 * from the detail page. Arizona Tile uses the same <strong>Label:</strong> pattern.
 */
export function parseTechnicalSpecs(html) {
  const tech = {};
  const techPatterns = [
    { regex: /<strong>PEI(?: Rating)?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'peiRating' },
    { regex: /<strong>Shade Variation:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'shadeVariation' },
    { regex: /<strong>Water Absorption:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'waterAbsorption' },
    { regex: /<strong>DCOF(?: Acutest)?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'dcof' },
    { regex: /<strong>MOHS:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'mohs' },
    { regex: /<strong>Breaking Strength:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'breakingStrength' },
    { regex: /<strong>Frost Resistant:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'frostResistant' },
    { regex: /<strong>Abrasion Resistance:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'abrasionResistance' },
    { regex: /<strong>Coefficient of Friction:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'dcof' },
  ];

  for (const { regex, key } of techPatterns) {
    if (tech[key]) continue; // Don't overwrite (dcof has two patterns)
    const match = html.match(regex);
    if (match) tech[key] = htmlDecode(match[1].trim());
  }

  return tech;
}

/**
 * Parse technical specs from HTML <table> elements with "TECHNICAL CHARACTERISTICS" header.
 * New Arizona Tile format uses tables instead of <strong> label blocks for some products.
 * Extracts label (col 1) → value (last col, typically "TYPICAL VALUE") pairs.
 */
export function parseTechnicalSpecsTable(html) {
  const tech = {};

  // Find table sections containing technical characteristics
  const tableMatch = html.match(/<table[^>]*>[\s\S]*?TECHNICAL\s+CHARACTERISTICS[\s\S]*?<\/table>/i);
  if (!tableMatch) return tech;

  const tableHtml = tableMatch[0];

  // Map of label patterns → tech spec keys
  const labelMap = [
    { pattern: /water\s+absorption/i, key: 'waterAbsorption' },
    { pattern: /dcof|dynamic\s+coefficient/i, key: 'dcof' },
    { pattern: /breaking\s+strength/i, key: 'breakingStrength' },
    { pattern: /frost\s+resist/i, key: 'frostResistant' },
    { pattern: /abrasion\s+resist/i, key: 'abrasionResistance' },
    { pattern: /\bpei\b/i, key: 'peiRating' },
    { pattern: /\bmohs\b/i, key: 'mohs' },
    { pattern: /shade\s+variation/i, key: 'shadeVariation' },
    { pattern: /staining\s+resist/i, key: 'stainingResistance' },
    { pattern: /thermal\s+shock/i, key: 'thermalShock' },
  ];

  // Extract rows: <tr>...<td>Label</td>...<td>Value</td>...</tr>
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
    const cells = [];
    const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
    }
    if (cells.length < 2) continue;

    const label = cells[0];
    const value = cells[cells.length - 1]; // Last column = typical value
    if (!label || !value) continue;

    for (const { pattern, key } of labelMap) {
      if (pattern.test(label) && !tech[key]) {
        tech[key] = htmlDecode(value);
        break;
      }
    }
  }

  return tech;
}

/**
 * Parse packaging info from the detail page.
 * Looks for patterns like "X pcs/box", "XX sf/box", "XX lbs/box", etc.
 */
export function parsePackaging(html) {
  const pkg = {};

  const pcsMatch = html.match(/<strong>Pieces?\s*(?:Per|\/)\s*Box:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i)
    || html.match(/(\d+)\s*(?:pcs?|pieces?)\s*(?:per|\/)\s*box/i);
  if (pcsMatch) pkg.piecesPerBox = parseInt(pcsMatch[1]) || null;

  const sqftMatch = html.match(/<strong>(?:Sq\.?\s*Ft\.?|SF|Square Feet)\s*(?:Per|\/)\s*Box:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i)
    || html.match(/([\d.]+)\s*(?:sf|sq\.?\s*ft\.?)\s*(?:per|\/)\s*box/i);
  if (sqftMatch) pkg.sqftPerBox = parseFloat(sqftMatch[1]) || null;

  const weightMatch = html.match(/<strong>Weight\s*(?:Per|\/)\s*Box:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i)
    || html.match(/([\d.]+)\s*(?:lbs?\.?)\s*(?:per|\/)\s*box/i);
  if (weightMatch) pkg.weightPerBox = parseFloat(weightMatch[1].replace(/[^0-9.]/g, '')) || null;

  const bppMatch = html.match(/<strong>Boxes?\s*(?:Per|\/)\s*Pallet:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i)
    || html.match(/(\d+)\s*(?:boxes?)\s*(?:per|\/)\s*pallet/i);
  if (bppMatch) pkg.boxesPerPallet = parseInt(bppMatch[1]) || null;

  const sqftPalletMatch = html.match(/<strong>(?:Sq\.?\s*Ft\.?|SF)\s*(?:Per|\/)\s*Pallet:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i)
    || html.match(/([\d.,]+)\s*(?:sf|sq\.?\s*ft\.?)\s*(?:per|\/)\s*pallet/i);
  if (sqftPalletMatch) pkg.sqftPerPallet = parseFloat(sqftPalletMatch[1].replace(/,/g, '')) || null;

  const weightPalletMatch = html.match(/<strong>Weight\s*(?:Per|\/)\s*Pallet:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i)
    || html.match(/([\d.,]+)\s*(?:lbs?\.?)\s*(?:per|\/)\s*pallet/i);
  if (weightPalletMatch) pkg.weightPerPallet = parseFloat(weightPalletMatch[1].replace(/[^0-9.]/g, '')) || null;

  return pkg;
}

/**
 * Parse pricing from the detail page HTML.
 * WooCommerce puts price in <span class="woocommerce-Price-amount">.
 */
export function parsePricing(html) {
  const result = { retailPrice: null, priceBasis: 'per_sqft' };

  // Cascading price extraction:
  // 1. WooCommerce price element (legacy pages)
  const priceMatch = html.match(/class="woocommerce-Price-amount[^"]*"[^>]*>[^$]*\$([\d,.]+)/);
  if (priceMatch) {
    result.retailPrice = parseFloat(priceMatch[1].replace(/,/g, '')) || null;
  }

  // 2. Extract display_price from data-product_variations JSON
  //    Some "simple" products are rendered as single-variation
  if (!result.retailPrice) {
    const varMatch = html.match(/data-product_variations="([^"]+)"/);
    if (varMatch) {
      try {
        let json = varMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#039;/g, "'");
        const vars = JSON.parse(json);
        if (Array.isArray(vars) && vars.length > 0 && vars[0].display_price) {
          result.retailPrice = parseFloat(vars[0].display_price) || null;
        }
      } catch { /* ignore parse errors */ }
    }
  }

  // 3. JSON-LD structured data (application/ld+json)
  if (!result.retailPrice) {
    const ldMatch = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (ldMatch) {
      try {
        const ld = JSON.parse(ldMatch[1]);
        const offers = ld.offers || (Array.isArray(ld['@graph']) && ld['@graph'].find(g => g.offers))?.offers;
        if (offers) {
          const price = offers.price || offers.lowPrice || (Array.isArray(offers) && offers[0]?.price);
          if (price) result.retailPrice = parseFloat(price) || null;
        }
      } catch { /* ignore parse errors */ }
    }
  }

  // 4. data-price attribute on cart form elements
  if (!result.retailPrice) {
    const dataPriceMatch = html.match(/data-price="([\d.]+)"/);
    if (dataPriceMatch) {
      result.retailPrice = parseFloat(dataPriceMatch[1]) || null;
    }
  }

  if (!result.retailPrice) {
    // Log-worthy: simple product with no pricing found
    result._noPricing = true;
  }

  // Check for "per sqft" / "per piece" / "per box" indicator.
  // NOTE: this priceBasis is currently ADVISORY ONLY — arizona.js sources
  // price_basis exclusively from the price list (planFromPriceList), never from
  // this parse. Kept canonical anyway so it can't reintroduce a non-canonical
  // pair if ever wired in: a box-sold covering good is per_sqft in this platform
  // (box+per_sqft), NOT per_unit — only genuinely piece/unit goods are per_unit.
  const basisMatch = html.match(/per\s+(sq\.?\s*ft\.?|piece|box|unit|square\s*foot)/i);
  if (basisMatch) {
    const raw = basisMatch[1].toLowerCase();
    if (raw.includes('piece') || raw.includes('unit')) result.priceBasis = 'per_unit';
    else result.priceBasis = 'per_sqft'; // "box" and "sq ft" → per_sqft
  }

  return result;
}

/**
 * Parse sold-by from page content.
 */
export function parseSoldBy(html) {
  const soldByMatch = html.match(/sold\s+(?:by\s+)?(?:the\s+)?(box|sq\.?\s*ft\.?|piece|square\s*foot|unit)/i);
  if (soldByMatch) {
    const raw = soldByMatch[1].toLowerCase();
    if (raw.includes('box')) return 'box';
    if (raw.includes('piece') || raw.includes('unit')) return 'unit';
    return 'box';
  }
  return null;
}

/**
 * Parse stock status from page HTML.
 */
export function parseStockStatus(html) {
  if (/class=['"][^'"]*in-stock/i.test(html)) return 'In Stock';
  if (/class=['"][^'"]*out-of-stock/i.test(html)) return 'Out of Stock';
  if (/class=['"][^'"]*on-backorder/i.test(html)) return 'Backorder';
  return null;
}

/**
 * Parse variations from data-product_variations attribute.
 * The JSON is double HTML-encoded on the page.
 */
export function parseVariations(html) {
  const match = html.match(/data-product_variations="([^"]+)"/);
  if (!match) return [];

  try {
    let json = match[1];
    json = htmlDecode(json);
    json = htmlDecode(json);
    return JSON.parse(json);
  } catch {
    return [];
  }
}
