// Canonical product-name composition — the SINGLE source of truth (backend copy)
// for how a SKU is titled. This is an EXACT port of fullProductName() and its
// helpers from frontend/storefront.jsx (the PDP title builder), so a line item
// on any document, email, or staff screen reads identically to the storefront
// product-detail page. See [[line-item-display]].
//
// Keep this in lock-step with the storefront.jsx originals:
//   formatCarpetValue / formatSizeDim / formatVariantName / _CATEGORY_SUFFIX_MAP /
//   appendTypeSuffix / stripTypeSuffix / fullProductName
//
// Input shape (mirrors the /api/storefront/skus/:id response the PDP consumes):
//   { product_name, collection, variant_name, variant_type, accessory_label,
//     category_name, format_label, vendor_code, vendor_name, sell_by,
//     attributes: [{ slug, value }, ...] }   // color, size, finish, pattern,
//                                             // product_line, brand, sub_line,
//                                             // overall_length
// All fields optional; the function degrades gracefully when data is missing.

function formatCarpetValue(val) {
  if (!val || typeof val !== 'string') return val;
  // Fiber format: "PILE 100 NYLON" → "100% Nylon"
  const fiberMatch = val.match(/^(?:PILE\s+)?(\d+)\s+(.+)$/i);
  if (fiberMatch && /^[A-Z0-9\s]+$/.test(val) && /NYLON|POLYESTER|PET|OLEFIN|WOOL|TRIEXTA|POLYPROPYLENE/i.test(val)) {
    const fiber = fiberMatch[2].trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
      .replace(/\bPet\b/g, 'PET Polyester').replace(/\bBcf\b/g, 'BCF');
    return fiberMatch[1] + '% ' + fiber;
  }
  // Title-case ALL-CAPS EDI values
  if (val === val.toUpperCase() && val.length > 2) {
    return val.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
      .replace(/\b(That|It|Don|Can|Won|Isn|Ain|Couldn|Wouldn|Shouldn|Didn|Wasn|Weren|Hasn|Haven|Let|What|Who|Where|There|Here) (S|T|Re|Ve|Ll|D|M)\b/g, (m, w, c) => w + "'" + c.toLowerCase())
      .replace(/\bBcf\b/g, 'BCF').replace(/\bPet\b/g, 'PET')
      .replace(/\bSd\b/g, 'SD').replace(/\bP\.e\.t\b/gi, 'PET')
      .replace(/\bIii\b/g, 'III').replace(/\bIi\b/g, 'II').replace(/\bIv\b/g, 'IV')
      .replace(/\bViii\b/g, 'VIII').replace(/\bVii\b/g, 'VII').replace(/\bVi\b/g, 'VI');
  }
  return val;
}

function formatSizeDim(val) {
  if (!val || typeof val !== 'string') return val;
  if (/^PATTERN$/i.test(val)) return 'Pattern';
  const isFeet = /FT$/i.test(val);
  const isEZ = /EZ$/i.test(val);
  const cleaned = val.replace(/\s*(EZ|FT)\s*$/gi, '').trim();
  const m = cleaned.match(/^(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)\s*[xX×]\s*(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)(.*)$/);
  if (!m) return formatCarpetValue(val);
  let d1 = m[1].replace(/\.00$/, ''), d2 = m[2].replace(/\.00$/, '');
  const suffix = (m[3] || '').trim();
  const unit = isFeet ? '′' : '″';
  return d1 + unit + ' × ' + d2 + unit + (suffix ? ' ' + suffix : '') + (isEZ ? ' Mosaic' : '');
}

function formatVariantName(name) {
  if (!name) return '';
  // If it looks like a clean name already (has uppercase or spaces), return as-is
  if (/[A-Z]/.test(name) && name.includes(' ')) return name;
  // Protect fraction slashes (e.g. "4-1/2") from the "/" split below
  const parts = name.replace(/(\d)\/(\d)/g, '$1⁄$2').split(/\s*\/\s*/);
  return parts.map(part => {
    // Restore fraction slashes
    let formatted = part.replace(/(\d)⁄(\d)/g, '$1/$2');
    // Replace hyphens with spaces
    formatted = formatted.replace(/-/g, ' ');
    // Restore fraction patterns: "7 3 16" → "7-3/16" (number space number space number)
    formatted = formatted.replace(/(\d+)\s(\d+)\s(\d+)/g, '$1-$2/$3');
    // Restore dimension "x" lowercase
    formatted = formatted.replace(/\bX\b/g, 'x');
    // Title case each word
    formatted = formatted.replace(/\b\w/g, c => c.toUpperCase());
    // Keep "x" lowercase between dimensions
    formatted = formatted.replace(/(\d)\s*X\s*(\d)/g, '$1 x $2');
    return formatted.trim();
  }).join(' — ');
}

const _CATEGORY_SUFFIX_MAP = {
  'engineered hardwood':'Engineered Hardwood','solid hardwood':'Solid Hardwood',
  'hardwood':'Hardwood','waterproof wood':'Waterproof Wood',
  'porcelain tile':'Porcelain Tile','ceramic tile':'Ceramic Tile','mosaic tile':'Mosaic Tile',
  'natural stone':'Natural Stone Tile','backsplash tile':'Backsplash Tile',
  'backsplash & wall tile':'Wall Tile','decorative tile':'Decorative Tile',
  'pool tile':'Pool Tile','wood look tile':'Wood Look Tile',
  'large format tile':'Large Format Tile','fluted tile':'Fluted Tile',
  'commercial tile':'Commercial Tile',
  'porcelain slabs':'Porcelain Slab',
  'quartz countertops':'Quartz Countertop','quartz':'Quartz Countertop',
  'granite countertops':'Granite Countertop','quartzite countertops':'Quartzite Countertop',
  'marble countertops':'Marble Countertop','soapstone countertops':'Soapstone Countertop',
  'prefabricated countertops':'Prefabricated Countertop','countertops':'Countertop',
  'lvp (plank)':'Luxury Vinyl Plank','lvp':'Luxury Vinyl Plank',
  'lvt (tile)':'Luxury Vinyl Tile','lvt':'Luxury Vinyl Tile',
  'luxury vinyl':'Luxury Vinyl','spc':'SPC Vinyl','wpc':'WPC Vinyl',
  'laminate':'Laminate','laminate flooring':'Laminate',
  'carpet':'Carpet','carpet tile':'Carpet Tile',
  'rubber flooring':'Rubber Flooring','artificial turf':'Artificial Turf',
  'vanity':'Vanity','vanity tops':'Vanity Top','vanities':'Vanity',
  'faucets':'Faucet','bathroom faucets':'Faucet','kitchen faucets':'Faucet',
  'mirrors':'Mirror','sinks':'Sink','kitchen sinks':'Sink','bathroom sinks':'Sink',
  'shower systems':'Shower System',
  'transitions & moldings':'Molding','transitions':'Molding','moldings':'Molding',
  'moulding':'Molding','wall base':'Wall Base','underlayment':'Underlayment',
  'stair treads & nosing':'Stair Tread',
  'hardscaping':'Paver','pavers':'Paver','stacked stone':'Stacked Stone',
  'sheet vinyl':'Sheet Vinyl','vct':'VCT','vbt':'VBT',
};

function appendTypeSuffix(text, categoryName) {
  if (!categoryName) return text;
  const suffix = _CATEGORY_SUFFIX_MAP[categoryName.toLowerCase().trim()];
  if (!suffix) return text;
  const lower = text.toLowerCase();
  const words = suffix.toLowerCase().split(/\s+/);
  if (lower.includes(suffix.toLowerCase())) return text;
  if (words.length > 1 && words.every(w => lower.includes(w))) return text;
  // If the primary keyword (e.g. "Mosaic", "Hardwood") already appears in the
  // name — including plural ("Bianco Carrara Mosaics") — skip
  if (words.length > 0 && new RegExp('\\b' + words[0] + 's?\\b', 'i').test(text)) return text;
  // "X Slab" under a countertop/slab category — 'Slab' already says it
  if (/\bslabs?\b/i.test(text) && /countertop|slab/i.test(suffix)) return text;
  return text + ' ' + suffix;
}

function stripTypeSuffix(text, categoryName) {
  if (!categoryName) return text;
  const suffix = _CATEGORY_SUFFIX_MAP[categoryName.toLowerCase().trim()];
  if (!suffix) return text;
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('\\s+' + escaped + '\\s*$', 'i');
  return text.replace(re, '').trim();
}

export function fullProductName(sku) {
  const rawName = sku.product_name || '';
  const col = sku.collection || '';
  let name = formatCarpetValue(rawName);

  // Accessories: show "Collection Color — Accessory Type" (e.g., "Prime 3 — End Cap, 8'")
  if (sku.variant_type === 'accessory') {
    let baseName = name;
    // Strip category suffix from display_name (e.g., "Prime 3 Engineered Hardwood" → "Prime 3")
    baseName = stripTypeSuffix(baseName, sku.category_name);
    const label = sku.accessory_label || sku.variant_name || '';
    return label ? baseName + ' — ' + label : baseName;
  }

  // Strip leading size prefix from product name (e.g. "12x24r Marble Onice Supreme Marfil" → "Marble Onice Supreme Marfil")
  name = name.replace(/^\d+\s*[xX×]\s*\d+\w?\s+/, '');
  // Strip trailing category suffix so we can re-append it at the very end,
  // after variant/size info (avoids "Acqua Ceramic Tile 24x24" → want "Acqua 24x24 Ceramic Tile")
  name = stripTypeSuffix(name, sku.category_name);

  // Append format label (e.g. "4x8", "Hex", "Rombo") for format-grouped products.
  // For construction formats (Engineered/Solid) the word already lives in the
  // category suffix ("Engineered Hardwood"/"Solid Hardwood"), so drop a redundant
  // trailing "(Solid)"/"(Engineered)" from the name and skip the append to avoid
  // "... Solid Solid Hardwood".
  if (sku.format_label) {
    name = name.replace(/\s*\((?:solid|engineered)\)\s*$/i, '').trim();
    const catLower = (sku.category_name || '').toLowerCase();
    const fl = sku.format_label.toLowerCase();
    // Skip the append when the format word is already in the category suffix
    // ("Engineered Hardwood") or already ends the product name (grouped
    // products named e.g. "Modern Elegance Plank" → avoid "Plank Plank").
    if (!catLower.includes(fl) && !name.toLowerCase().endsWith(fl)) {
      name = name + ' ' + sku.format_label;
    }
  }

  // Vendors that use collection as a browsing taxonomy (not a product-line prefix)
  // e.g. Bellezza's "Marble Look", "Concrete & Industrial" are grouping concepts, not product names
  const TAXONOMY_COLLECTION_VENDORS = new Set(['BLZ']);
  const TAXONOMY_COLLECTION_VENDOR_NAMES = new Set(['BELLEZZA CERAMICA']);
  const skipCollectionInTitle = TAXONOMY_COLLECTION_VENDORS.has((sku.vendor_code || '').toUpperCase())
    || TAXONOMY_COLLECTION_VENDOR_NAMES.has((sku.vendor_name || '').toUpperCase());

  // If collection name appears inside product name, remove it to avoid repetition
  // e.g. name="Marble Onice Supreme Marfil", col="Onice Supreme" → "Marble Marfil"
  let showCollection = '';
  if (col && name && !skipCollectionInTitle) {
    const colLower = col.toLowerCase();
    const nameLower = name.toLowerCase();
    if (colLower === nameLower) {
      // Collection is identical to product name — skip to avoid "Blockade II Blockade II"
      showCollection = '';
    } else if (colLower.startsWith(nameLower + ' ') || colLower.startsWith(nameLower + '-')) {
      // Collection is a superset of product name (e.g., col="Engineered White", name="Engineered")
      // Use collection as the canonical name to avoid "Engineered White Engineered"
      name = col;
      showCollection = '';
    } else if (nameLower.startsWith(colLower + ' ') || nameLower.startsWith(colLower + '-')) {
      // Product name starts with collection — skip collection display, keep full name
      showCollection = '';
    } else if (nameLower.includes(' ' + colLower + ' ') || nameLower.endsWith(' ' + colLower)) {
      // Collection name embedded in middle/end of product name — skip collection display
      showCollection = '';
    } else if (/\b(series|collection|edition)\b/i.test(name)) {
      // Product name is self-identifying (e.g. "Bohol Series", "Carrara Collection")
      // Skip the broader collection/category prefix to avoid "Pool Tile Bohol Series"
      // Include the Color attribute so the title reflects which color variant is shown
      // e.g. "Hex Series — Black Matte", "Joya Series — Verde"
      showCollection = '';
      const colorAttr = (sku.attributes || []).find(a => a.slug === 'color');
      const _earlyResult = colorAttr && colorAttr.value ? name + ' — ' + colorAttr.value : name;
      return appendTypeSuffix(_earlyResult, sku.category_name);
    } else {
      // collection = "Brand - Name" where product name equals the suffix
      // → show brand only as prefix to avoid "Provenza - Affinity Affinity Mellow"
      const dashIdx = col.indexOf(' - ');
      if (dashIdx > 0) {
        const suffix = col.slice(dashIdx + 3).toLowerCase().trim();
        if (nameLower === suffix || nameLower.startsWith(suffix + ' ') || nameLower.startsWith(suffix + '-')) {
          // Product name starts with or equals the collection suffix — show brand only
          showCollection = col.slice(0, dashIdx);
        } else {
          showCollection = col;
        }
      } else {
        showCollection = col;
      }
    }
  }

  // Build variant display: skip if it duplicates or is already inside product_name
  // Normalize hyphens → spaces so slug-style variant names ("calacatta-gold")
  // match space-separated product names ("Calacatta Gold") during dedup.
  let variant = null;
  if (sku.variant_name) {
    const vLower = sku.variant_name.toLowerCase().trim();
    const vNorm = vLower.replace(/-/g, ' ');
    const pLower = rawName.toLowerCase();
    const nLower = name.toLowerCase();
    if (vNorm === pLower || vNorm === nLower) {
      // variant_name is identical to product_name (modulo hyphens/case)
      variant = null;
    } else if (vNorm.startsWith(pLower + ' ') || vLower.startsWith(pLower + ',') || vLower.startsWith(pLower + '-')) {
      // variant_name starts with product_name + separator → strip prefix, keep the rest
      const suffix = sku.variant_name.replace(new RegExp('^' + rawName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s,\\-]+', 'i'), '').trim();
      variant = suffix ? formatVariantName(suffix) : null;
    } else if (nLower !== pLower && (vNorm.startsWith(nLower + ' ') || vLower.startsWith(nLower + ',') || vLower.startsWith(nLower + '-'))) {
      // variant_name starts with stripped name (sans type suffix) → strip that prefix
      const suffix = sku.variant_name.replace(new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s,\\-]+', 'i'), '').trim();
      variant = suffix ? formatVariantName(suffix) : null;
    } else if (pLower.startsWith(vNorm + ' ') || pLower === vNorm) {
      // product_name already contains variant info
      variant = null;
    } else if (vNorm.length > 2 && (nLower.includes(' ' + vNorm + ' ') || nLower.endsWith(' ' + vNorm) || nLower.startsWith(vNorm + ' '))) {
      // variant_name is a word/phrase already present in product name (e.g. color embedded)
      variant = null;
    } else {
      variant = formatVariantName(sku.variant_name);
    }
    // Strip duplicate color from compound variants when it's already in product name
    // e.g., name="Unique Infinity Beige", variant="Beige, 24x48, Cobblestone" → "24x48, Cobblestone"
    if (variant) {
      const cParts = variant.split(',');
      if (cParts.length > 1) {
        const seg = cParts[0].trim().toLowerCase();
        if (seg.length > 1 && (nLower === seg || nLower.endsWith(' ' + seg) || nLower.startsWith(seg + ' ') || nLower.includes(' ' + seg + ' '))) {
          variant = cParts.slice(1).map(p => p.trim()).join(', ') || null;
        }
      }
      if (variant) {
        const lastNameWord = nLower.split(/\s+/).pop();
        const firstVarWord = variant.split(/[\s,]+/)[0].toLowerCase();
        if (lastNameWord.length > 2 && firstVarWord === lastNameWord) {
          variant = variant.replace(/^\S+[\s,]*/, '').trim() || null;
        }
      }
    }
    // Format dimension variants with inch marks (e.g. "24X48" → "24″ × 48″", "24X48 (A)" → "24″ × 48″ (A)")
    // Also handles dimension + modifier text (e.g. "7X75 Glossy" → "7″ × 75″ Glossy", "9X86 Brushed" → "9″ × 86″ Brushed")
    if (variant) {
      const dimMatch = variant.match(/^(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?\s*[xX×]\s*\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?(?:\s*(?:PAVER|EZ|FT))?)(\s*\(.*\))?$/i);
      if (dimMatch) {
        variant = formatSizeDim(dimMatch[1].trim()) + (dimMatch[2] || '');
      } else {
        // Dimension followed by non-dimension text: "7X75 Glossy" → "7″ × 75″ Glossy"
        const dimPrefixMatch = variant.match(/^(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?\s*[xX×]\s*\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)\s+(.+)$/);
        if (dimPrefixMatch) {
          variant = formatSizeDim(dimPrefixMatch[1].trim()) + ', ' + dimPrefixMatch[2].trim();
        }
      }
    }
  }
  // When variant_name only carries the color, supplement with size/thickness
  // so the title distinguishes between variants (e.g. "Alpine Ivory 2CM" or "Alpine Ivory 108×42")
  if (sku.attributes) {
    const colorAttr = (sku.attributes || []).find(a => a.slug === 'color');
    const variantIsColor = colorAttr && variant && variant.toLowerCase() === formatVariantName(colorAttr.value).toLowerCase();
    const variantIsEmpty = !variant && colorAttr && rawName.toLowerCase().includes(colorAttr.value.toLowerCase());
    if (variantIsColor || variantIsEmpty) {
      const rawSizeAttr = sku.sell_by !== 'roll' ? (sku.attributes || []).find(a => a.slug === 'size') : null;
      // Skip roll dimensions (e.g. "12x150FT"), plank dimensions with decimals (e.g. "4.96x48.04", "9.06 Wide"),
      // and simple width values (e.g. "5 in", "7 in") — the product name already carries the width
      const rawSizeVal = rawSizeAttr ? (rawSizeAttr.value || '').trim() : '';
      const isAdexVendor = (sku.vendor_code || '') === '167'; // ADEX USA
      const sizeAttr = rawSizeAttr && !isAdexVendor && (
        /^\d+\s*[xX×]\s*\d+\s*ft$/i.test(rawSizeVal) ||
        /^\d+\.\d+\s*[xX×]\s*\d+\.\d+$/.test(rawSizeVal) ||
        /^\d+\.\d+\s+Wide$/i.test(rawSizeVal) ||
        /^\d+\s+in$/i.test(rawSizeVal) ||
        /^\d+″$/.test(rawSizeVal)
      ) ? null : rawSizeAttr;
      const patternAttr = (sku.attributes || []).find(a => a.slug === 'pattern');
      const finishAttr = (sku.attributes || []).find(a => a.slug === 'finish');
      const nameLowerDedup = name.toLowerCase();
      // Dimension comparison is punctuation-insensitive so a size attr with inch
      // marks (10"x30") is recognized as already present in a name that carries
      // the bare dimension (10x30) — otherwise the size gets appended twice
      // ("Alaska Muretto Grey 10\"x30\" 10x30 Wall"). Only the size attr gets the
      // normalized check; patterns keep the plain substring test.
      const normDim = (s) => String(s).toLowerCase().replace(/["″”'’\s]/g, '').replace(/×/g, 'x');
      const nameDimNorm = normDim(name);
      const extras = [patternAttr, sizeAttr]
        .filter(Boolean)
        .filter(a => !nameLowerDedup.includes(a.value.toLowerCase())
          && !(a === sizeAttr && nameDimNorm.includes(normDim(a.value))))
        .map(a => a.value);
      if (extras.length > 0) {
        const sizePart = extras.join(' ');
        const colorVal = variantIsColor ? variant : null;
        const finishVal = finishAttr && finishAttr.value ? finishAttr.value : null;
        const finishPos = finishVal ? nameLowerDedup.indexOf(finishVal.toLowerCase()) : -1;
        if (finishPos > 0) {
          // Insert [color] [size] before finish: "Alluro Manor Cream 9x9 Polished Mosaic"
          const before = name.slice(0, finishPos).trim();
          const after = name.slice(finishPos).trim();
          name = before + (colorVal ? ' ' + colorVal : '') + ' ' + sizePart + ' ' + after;
          if (colorVal) variant = null;
        } else {
          const colLc = (col || '').toLowerCase();
          if (colorVal && colLc && name.toLowerCase().startsWith(colLc + ' ')) {
            // Insert "Color Size" after the collection prefix: "Pietra Cream 12x24 ..."
            name = name.slice(0, col.length) + ' ' + colorVal + ' ' + sizePart + name.slice(col.length);
            variant = null;
          } else if (!colorVal) {
            // Color already lives inside the name — append size after it
            // ("Pietra Bone" → "Pietra Bone 12x24"), never mid-name
            name = name + ' ' + sizePart;
          } else {
            variant = colorVal + ' ' + sizePart;
          }
        }
      }
    }
  }
  // Include overall_length in title for hardware products
  if (sku.attributes) {
    const olAttr = (sku.attributes || []).find(a => a.slug === 'overall_length');
    if (olAttr && olAttr.value) {
      const olVal = olAttr.value.trim();
      if (!name.toLowerCase().includes(olVal.toLowerCase()) && !/\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?\s*["″]/.test(name)) {
        name = name + ' ' + olVal;
      }
    }
  }
  // Inject product_line after collection (e.g. "Quick-Step NatureTEK Plus Palisades Park")
  // Skip if product_line duplicates collection or product name
  let productLine = '';
  const plAttr = (sku.attributes || []).find(a => a.slug === 'product_line');
  if (plAttr && plAttr.value) {
    const plLower = plAttr.value.toLowerCase();
    const colLower = (showCollection || '').toLowerCase();
    const nameLower = name.toLowerCase();
    if (plLower !== colLower && plLower !== nameLower && !nameLower.includes(plLower) && !colLower.includes(plLower)) {
      productLine = plAttr.value;
    }
  }
  // Include brand at beginning (e.g., "Dream Weaver Astounding Amberwood I Carpet")
  // Skip if brand duplicates collection, product name, or vendor name
  let brand = '';
  const brandAttr = (sku.attributes || []).find(a => a.slug === 'brand');
  if (brandAttr && brandAttr.value) {
    const bLower = brandAttr.value.toLowerCase();
    const colLower2 = (showCollection || '').toLowerCase();
    const nameLower2 = name.toLowerCase();
    const vendorLower = (sku.vendor_name || '').toLowerCase();
    if (bLower !== colLower2 && bLower !== nameLower2 && bLower !== vendorLower
        && !nameLower2.includes(bLower) && !colLower2.includes(bLower)) {
      brand = brandAttr.value;
    }
  }
  // Append sub_line Roman numeral after color (e.g., "Astounding Amberwood III Carpet")
  const subLineAttr = (sku.attributes || []).find(a => a.slug === 'sub_line');
  const subLineNumeral = subLineAttr && /^I{1,3}$/.test(subLineAttr.value) ? subLineAttr.value : null;
  // When product name contains a size dimension (e.g., "12x24, Matte" or "Arenite 12x24, Matte"),
  // insert the color/variant before the size so it reads "Arenite Ostuni 12x24, Matte"
  // instead of "Arenite 12x24, Matte Ostuni".
  let orderedName = name;
  let orderedVariant = variant;
  if (variant) {
    const sizeMatch = name.match(/^(.*?\s)?(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?\s*[xX×]\s*\d.*)$/);
    if (sizeMatch && sizeMatch[2]) {
      const prefix = (sizeMatch[1] || '').trimEnd();
      orderedName = (prefix ? prefix + ' ' : '') + variant + ' ' + sizeMatch[2];
      orderedVariant = null;
    }
  }
  const result = [brand, showCollection, productLine, orderedName, orderedVariant, subLineNumeral].filter(Boolean).join(' ');
  return appendTypeSuffix(result, sku.category_name);
}

// Reshape a document/line-item row (which may carry attributes flat or as an
// array) into the SKU shape fullProductName expects. Any endpoint that selects
// the sku_attributes JSON (slug/value) gets full parity; older callers that only
// select color/size still get a PDP-structured name from those two.
const _ATTR_SLUGS = ['color', 'size', 'finish', 'pattern', 'product_line', 'brand', 'sub_line', 'overall_length'];
export function skuShapeFromLine(it = {}) {
  let attributes;
  if (Array.isArray(it.attributes)) {
    attributes = it.attributes;
  } else {
    attributes = [];
    for (const slug of _ATTR_SLUGS) {
      const v = it[slug];
      if (v != null && String(v).trim() !== '') attributes.push({ slug, value: String(v).trim() });
    }
  }
  // Margin protection: a public-hidden brand must never surface in a line-item
  // title (the brand attribute would otherwise embed the real brand name in a
  // customer invoice/quote). Drop it here — the vendor/brand meta line is already
  // gated by brand_hidden in composeItemName. See [[hide-public-brand]].
  if (it.brand_hidden === true && attributes.some(a => a.slug === 'brand')) {
    attributes = attributes.filter(a => a.slug !== 'brand');
  }
  return {
    product_name: it.product_name || it.current_product_name || '',
    collection: it.collection || it.current_collection || '',
    variant_name: it.variant_name || null,
    variant_type: it.variant_type || null,
    accessory_label: it.accessory_label || null,
    category_name: it.category_name || null,
    format_label: it.format_label || null,
    vendor_code: it.vendor_code || null,
    vendor_name: it.vendor_name || null,
    sell_by: it.sell_by || null,
    attributes,
  };
}
