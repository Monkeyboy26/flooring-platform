    const { useState, useEffect, useRef, useCallback, useMemo } = React;

    const API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
      ? 'http://localhost:3001'
      : `${window.location.protocol}//${window.location.hostname}:3001`;

    function getSessionId() {
      let id = localStorage.getItem('cart_session_id');
      if (!id) {
        id = 'sess_' + crypto.randomUUID();
        localStorage.setItem('cart_session_id', id);
      }
      return id;
    }

    function generateSlug(text) {
      return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }

    const SITE_URL = 'https://www.romaflooringdesigns.com';
    function updateSEO({ title, description, url, image }) {
      document.title = title || 'Shop | Roma Flooring Designs';
      const setMeta = (selector, value) => {
        const el = document.querySelector(selector);
        if (el && value) el.setAttribute('content', value);
      };
      setMeta('meta[name="description"]', description);
      setMeta('meta[property="og:title"]', title);
      setMeta('meta[property="og:description"]', description);
      setMeta('meta[property="og:url"]', url);
      if (image) setMeta('meta[property="og:image"]', image);
      setMeta('meta[name="twitter:title"]', title);
      setMeta('meta[name="twitter:description"]', description);
      if (image) setMeta('meta[name="twitter:image"]', image);
      const canonical = document.querySelector('link[rel="canonical"]');
      if (canonical && url) canonical.setAttribute('href', url);
    }

    function setDynamicJsonLd(data) {
      let el = document.getElementById('dynamic-jsonld');
      if (!el) { el = document.createElement('script'); el.type = 'application/ld+json'; el.id = 'dynamic-jsonld'; document.head.appendChild(el); }
      el.textContent = JSON.stringify(data);
    }

    function isSoldPerUnit(sku) {
      if (!sku) return false;
      return sku.sell_by === 'unit' || sku.price_basis === 'per_unit';
    }
    function isSoldPerSqyd(sku) {
      if (!sku) return false;
      return sku.sell_by === 'sqyd' || sku.price_basis === 'per_sqyd';
    }
    function isCarpet(sku) {
      return sku && sku.cut_price != null;
    }
    function carpetSqftPrice(sqydPrice) {
      return (parseFloat(sqydPrice) / 9).toFixed(2);
    }
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
    function priceSuffix(sku) {
      if (isSoldPerUnit(sku)) return '/ea';
      if (isSoldPerSqyd(sku)) return '/sqyd';
      return '/sqft';
    }
    // Slab pricing: when price is stored per sqft but sold per piece, compute piece price
    function displayPrice(sku, rawPrice) {
      const price = parseFloat(rawPrice || 0);
      if (sku && sku.sell_by === 'unit' && (sku.price_basis === 'sqft' || sku.price_basis === 'per_sqft') && parseFloat(sku.sqft_per_box) > 0) {
        return price * parseFloat(sku.sqft_per_box);
      }
      return price;
    }

    // ==================== Image Optimization Helper ====================
    function optimizeImg(url, width) {
      if (!url || typeof url !== 'string') return url;
      try {
        // Amplience: i8.amplience.net
        if (url.includes('i8.amplience.net')) {
          const u = new URL(url);
          u.searchParams.set('w', width);
          u.searchParams.set('fmt', 'auto');
          u.searchParams.set('qlt', '80');
          return u.toString();
        }
        // Cloudinary: res.cloudinary.com — insert transforms after /upload/
        if (url.includes('res.cloudinary.com') && url.includes('/upload/')) {
          return url.replace('/upload/', `/upload/w_${width},f_auto,q_80/`);
        }
        // Widen: *.widen.net
        if (url.includes('.widen.net')) {
          const u = new URL(url);
          u.searchParams.set('w', width);
          u.searchParams.set('quality', '80');
          return u.toString();
        }
      } catch (e) { /* malformed URL — return as-is */ }
      return url;
    }

    // ==================== Recent Searches (localStorage) ====================
    const RECENT_SEARCHES_KEY = 'roma_recent_searches';
    const MAX_RECENT_SEARCHES = 6;
    function getRecentSearches() {
      try { return JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) || '[]'); } catch { return []; }
    }
    function addRecentSearch(term) {
      if (!term || term.length < 2) return;
      const recent = getRecentSearches().filter(t => t.toLowerCase() !== term.toLowerCase());
      recent.unshift(term);
      localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(recent.slice(0, MAX_RECENT_SEARCHES)));
    }
    function clearRecentSearches() { localStorage.removeItem(RECENT_SEARCHES_KEY); }

    // ==================== Search Highlight Helper ====================
    function highlightMatch(text, query) {
      if (!query || query.length < 2 || !text) return text;
      try {
        const regex = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
        const parts = String(text).split(regex);
        if (parts.length === 1) return text;
        return parts.map((part, i) => regex.test(part) ? React.createElement('mark', { key: i, className: 'search-highlight' }, part) : part);
      } catch { return text; }
    }

    // ==================== Mega Menu Data Maps ====================

    const COLOR_HEX_MAP = {
      'White': '#ffffff', 'Bright White': '#f8f8ff', 'Glossy White': '#f5f5f5',
      'Ivory': '#fffff0', 'Cream': '#fffdd0', 'Beige': '#f5f0e1',
      'Tan': '#d2b48c', 'Sand': '#c2b280', 'Taupe': '#a89080', 'Brown': '#6b4226',
      'Dark Brown': '#3e2723', 'Chocolate': '#3e1c00', 'Espresso': '#3c1414',
      'Walnut': '#5c3a1e', 'Mid-Century Walnut': '#6b4830', 'Honey Oak': '#c8923e',
      'Light Natural Oak': '#c9ad7c', 'Honey': '#c08b3e', 'Gold': '#c9a668', 'Amber': '#b8860b',
      'Gray': '#9e9e9e', 'Grey': '#9e9e9e', 'Light Gray': '#c8c8c8', 'Dark Gray': '#4a4a4a', 'Charcoal': '#36454f',
      'Black': '#1c1917', 'Black Onyx': '#0c0a08', 'Silver': '#b0b0b0', 'Greige': '#b5a999',
      'Blue': '#4a6fa5', 'Navy': '#1b2a4a', 'Green': '#5c7a5c', 'Sage': '#6b9080',
      'Teal': '#367588', 'Celadon': '#ace1af', 'Smokey Celadon': '#8baa8b',
      'Red': '#8b3a3a', 'Terracotta': '#c67b5c', 'Rust': '#a0522d',
      'Orange': '#cc7722', 'Yellow': '#d4a843', 'Pink': '#c4868b', 'Blush': '#d4a5a5',
      'Pecan': '#8b6914', 'Multi': '#a8a29e', 'Natural': '#c2a878', 'Oak': '#b08550', 'Ash': '#bfbcb6',
      'Slate': '#6d7b7b', 'Pewter': '#8a8d8f', 'Copper': '#b87333', 'Bronze': '#8a6642',
      'Pearl': '#eae6df', 'Caramel': '#a56630'
    };

    function getColorHex(colorName) {
      if (!colorName) return '#a8a29e';
      const name = colorName.trim();
      if (COLOR_HEX_MAP[name]) return COLOR_HEX_MAP[name];
      const lower = name.toLowerCase();
      for (const [key, val] of Object.entries(COLOR_HEX_MAP)) {
        if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) return val;
      }
      return '#a8a29e';
    }

    function isLightColor(hex) {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return (r * 0.299 + g * 0.587 + b * 0.114) > 200;
    }

    const LOOK_GRADIENT_MAP = {
      'Marble': 'linear-gradient(135deg, #f0ece4 0%, #e8e0d4 25%, #f5f0ea 50%, #ddd5c8 75%, #ebe6de 100%)',
      'Wood': 'linear-gradient(160deg, #a67c52 0%, #8b6238 30%, #c09a6b 55%, #7a5530 80%, #b8925a 100%)',
      'Concrete': 'linear-gradient(135deg, #b0aba3 0%, #9e9890 35%, #c2bdb5 60%, #a8a299 100%)',
      'Stone': 'linear-gradient(145deg, #c4b8a8 0%, #b0a492 30%, #d4c8b8 60%, #a89882 100%)',
      'Slate': 'linear-gradient(140deg, #6d7b7b 0%, #5a6868 40%, #7d8b8b 70%, #4a5858 100%)',
      'Travertine': 'linear-gradient(130deg, #e8d8c4 0%, #d4c4ae 35%, #f0e0cc 65%, #c8b8a0 100%)',
      'Limestone': 'linear-gradient(135deg, #e0d8cc 0%, #d0c8ba 40%, #ece4d8 70%, #c8c0b2 100%)',
      'Terrazzo': 'linear-gradient(135deg, #e8e0d4 0%, #d0c8bc 30%, #f0e8dc 50%, #c4bcb0 70%, #dcd4c8 100%)',
      'Cement': 'linear-gradient(145deg, #a8a098 0%, #989088 40%, #b8b0a8 70%, #908880 100%)',
      'Onyx': 'linear-gradient(135deg, #2c2826 0%, #1c1917 30%, #3c3834 55%, #0c0a08 80%, #2c2826 100%)',
      'Encaustic': 'linear-gradient(135deg, #5c7a5c 0%, #4a6848 25%, #7c9a7c 50%, #3a5838 75%, #6b8a6b 100%)',
      'Geometric': 'linear-gradient(135deg, #4a6fa5 0%, #3a5f95 30%, #5a7fb5 60%, #2a4f85 100%)',
      'Metallic': 'linear-gradient(145deg, #b0b0b0 0%, #8a8a8a 25%, #d0d0d0 50%, #a0a0a0 75%, #c0c0c0 100%)',
      'Fabric': 'linear-gradient(135deg, #c2b8aa 0%, #b0a698 35%, #d2c8ba 65%, #a49888 100%)',
      'Brick': 'linear-gradient(140deg, #8b4513 0%, #a0522d 35%, #7a3b10 65%, #b8652a 100%)'
    };

    function getLookGradient(lookName) {
      if (!lookName) return 'linear-gradient(135deg, #c2b8aa, #a49888)';
      if (LOOK_GRADIENT_MAP[lookName]) return LOOK_GRADIENT_MAP[lookName];
      const lower = lookName.toLowerCase();
      for (const [key, val] of Object.entries(LOOK_GRADIENT_MAP)) {
        if (lower.includes(key.toLowerCase())) return val;
      }
      return 'linear-gradient(135deg, #c2b8aa, #a49888)';
    }

    // ==================== Color Families for Sidebar Swatches ====================
    const COLOR_FAMILIES = {
      'White':  { hex: '#f5f5f0', keywords: ['white', 'ivory', 'cream', 'snow', 'pearl', 'alabaster', 'frost', 'arctic', 'bright white'] },
      'Gray':   { hex: '#9e9e9e', keywords: ['gray', 'grey', 'charcoal', 'silver', 'slate', 'ash', 'smoke', 'graphite', 'pewter', 'cement', 'concrete'] },
      'Beige':  { hex: '#d4c5a9', keywords: ['beige', 'tan', 'sand', 'taupe', 'khaki', 'linen', 'wheat', 'bone', 'champagne', 'natural', 'almond'] },
      'Brown':  { hex: '#8b6f47', keywords: ['brown', 'chocolate', 'coffee', 'mocha', 'walnut', 'chestnut', 'mahogany', 'espresso', 'umber', 'oak', 'hickory', 'pecan', 'caramel'] },
      'Black':  { hex: '#2c2c2c', keywords: ['black', 'onyx', 'ebony', 'jet', 'midnight', 'noir', 'obsidian'] },
      'Blue':   { hex: '#6b8cae', keywords: ['blue', 'navy', 'cobalt', 'teal', 'aqua', 'sapphire', 'ocean', 'azure', 'cerulean', 'indigo', 'denim'] },
      'Green':  { hex: '#7a9972', keywords: ['green', 'sage', 'olive', 'forest', 'emerald', 'moss', 'mint', 'jade', 'celadon'] },
      'Red':    { hex: '#b54c4c', keywords: ['red', 'burgundy', 'wine', 'cherry', 'crimson', 'maroon', 'rust', 'brick', 'terracotta'] },
      'Gold':   { hex: '#c9a668', keywords: ['gold', 'golden', 'honey', 'amber', 'copper', 'bronze', 'brass'] },
      'Blonde': { hex: '#dcc9a3', keywords: ['blonde', 'blond', 'flaxen', 'straw', 'light oak', 'light natural'] },
      'Multi':  { hex: 'conic-gradient(#f5f5f0,#9e9e9e,#d4c5a9,#8b6f47,#6b8cae)', keywords: ['multi', 'mixed', 'multicolor', 'variegated', 'blend'] },
    };

    function mapColorToFamily(rawColor) {
      if (!rawColor) return null;
      const lower = rawColor.toLowerCase().trim();
      if (lower === 'xxx' || lower === 'n/a' || lower === 'na' || !lower) return null;
      for (const [family, { keywords }] of Object.entries(COLOR_FAMILIES)) {
        if (keywords.some(kw => lower.includes(kw))) return family;
      }
      return null;
    }

    function parseSizeDimensions(sizeStr) {
      if (!sizeStr) return { width: 16, height: 16 };
      const s = sizeStr.trim().replace(/"/g, '').replace(/\u201d/g, '');
      // "24 x 48", "12x24", "12 X 24", "4x1/8"
      const xyMatch = s.match(/^(\d+(?:[.\-\/]\d+)?)\s*[xX×]\s*(\d+(?:[.\-\/]\d+)?)/);
      if (xyMatch) {
        const parse = (v) => { if (v.includes('/')) { const p = v.split('/'); return parseFloat(p[0]) / parseFloat(p[1]); } return parseFloat(v); };
        const w = parse(xyMatch[1]);
        const h = parse(xyMatch[2]);
        const max = Math.max(w, h);
        return { width: Math.max(8, Math.round((w / max) * 22)), height: Math.max(8, Math.round((h / max) * 22)) };
      }
      // "9 in." or "12in" — single dimension
      const singleMatch = s.match(/^(\d+(?:\.\d+)?)\s*(?:in\.?)?$/);
      if (singleMatch) {
        const d = parseFloat(singleMatch[1]);
        if (d <= 12) return { width: Math.max(10, Math.round((d / 12) * 20)), height: 22 };
        return { width: 10, height: 22 };
      }
      // Pure numbers or decimals (84, 96, 94.48) — lengths in inches, narrow plank
      const numMatch = s.match(/^(\d+(?:\.\d+)?)$/);
      if (numMatch) {
        const n = parseFloat(numMatch[1]);
        if (n > 48) return { width: 8, height: 22 };
        if (n > 24) return { width: 10, height: 22 };
        return { width: 14, height: 22 };
      }
      return { width: 16, height: 16 };
    }

    function formatVariantName(name) {
      if (!name) return '';
      // If it looks like a clean name already (has uppercase or spaces), return as-is
      if (/[A-Z]/.test(name) && name.includes(' ')) return name;
      // Split on " / " separator if present (e.g., "calacatta-umber-split / 7-3-16-x-19-5-8-mesh-sheet")
      const parts = name.split(/\s*\/\s*/);
      return parts.map(part => {
        // Replace hyphens with spaces
        let formatted = part.replace(/-/g, ' ');
        // Restore fraction patterns: "7 3 16" → "7-3/16" (number space number space number)
        formatted = formatted.replace(/(\d+)\s(\d+)\s(\d+)/g, '$1-$2/$3');
        // Restore dimension "x" lowercase
        formatted = formatted.replace(/\bX\b/g, 'x');
        // Title case each word
        formatted = formatted.replace(/\b\w/g, c => c.toUpperCase());
        // Keep "x" lowercase between dimensions
        formatted = formatted.replace(/(\d)\s*X\s*(\d)/g, '$1 x $2');
        return formatted.trim();
      }).join(' \u2014 ');
    }

    const ROMAN_VAL = { 'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6, 'VII': 7, 'VIII': 8, 'IX': 9, 'X': 10 };
    const ROMAN_REGEX = /\b(I{1,3}|IV|V(?:I{1,3})?|IX|X)\b(?=\s+\d|\s*$)/;
    function hasRomanSuffix(name) {
      if (!name) return false;
      const m = name.match(ROMAN_REGEX);
      return !!(m && ROMAN_VAL[m[1]]);
    }
    function romanSortKey(name) {
      if (!name) return 0;
      const m = name.match(ROMAN_REGEX);
      return (m && ROMAN_VAL[m[1]]) || 0;
    }

    function fullProductName(sku) {
      const rawName = sku.product_name || '';
      const col = sku.collection || '';
      let name = formatCarpetValue(rawName);

      // Strip leading size prefix from product name (e.g. "12x24r Marble Onice Supreme Marfil" → "Marble Onice Supreme Marfil")
      name = name.replace(/^\d+\s*[xX×]\s*\d+\w?\s+/, '');

      // If collection name appears inside product name, remove it to avoid repetition
      // e.g. name="Marble Onice Supreme Marfil", col="Onice Supreme" → "Marble Marfil"
      let showCollection = '';
      if (col && name) {
        const colLower = col.toLowerCase();
        const nameLower = name.toLowerCase();
        if (colLower === nameLower) {
          // Collection is identical to product name — skip to avoid "Blockade II Blockade II"
          showCollection = '';
        } else if (nameLower.startsWith(colLower + ' ') || nameLower.startsWith(colLower + '-')) {
          // Product name starts with collection — skip collection display, keep full name
          showCollection = '';
        } else if (nameLower.includes(' ' + colLower + ' ') || nameLower.endsWith(' ' + colLower)) {
          // Collection name embedded in middle/end of product name — skip collection display
          showCollection = '';
        } else {
          showCollection = col;
        }
      }

      // Build variant display: skip if it duplicates or is already inside product_name
      let variant = null;
      if (sku.variant_name && sku.variant_name.toLowerCase() !== rawName.toLowerCase()) {
        const vLower = sku.variant_name.toLowerCase().trim();
        const pLower = rawName.toLowerCase();
        const nLower = name.toLowerCase();
        if (vLower.startsWith(pLower + ' ')) {
          // variant_name = "Cement 12X24" when product_name = "Cement" → show just "12X24"
          const suffix = sku.variant_name.substring(rawName.length + 1).trim();
          variant = suffix ? formatVariantName(suffix) : null;
        } else if (pLower.startsWith(vLower + ' ') || pLower === vLower) {
          // product_name already contains variant info
          variant = null;
        } else if (vLower.length > 2 && (nLower.includes(' ' + vLower + ' ') || nLower.endsWith(' ' + vLower) || nLower.startsWith(vLower + ' '))) {
          // variant_name is a word/phrase already present in product name (e.g. color embedded)
          variant = null;
        } else {
          variant = formatVariantName(sku.variant_name);
        }
      }
      return [showCollection, name, variant].filter(Boolean).join(' ');
    }

    function cleanDescription(text, vendorName) {
      if (!text) return '';
      let cleaned = text;
      // Remove common vendor boilerplate phrases
      const boilerplatePatterns = [
        /\s*at\s+\w[\w\s]*(?:tile|surfaces|flooring)\s+we\s+have\s+.*/i,
        /\s*visit\s+(?:us\s+at\s+)?(?:www\.)?[\w.-]+\.\w+\s*.*/i,
        /\s*available\s+(?:exclusively\s+)?at\s+\w[\w\s]*(?:tile|surfaces|flooring)\s*.*/i,
        /\s*(?:shop|browse|explore)\s+(?:our\s+)?(?:full\s+)?(?:selection|collection|range)\s+at\s+.*/i,
        /\s*whether\s+you\s+are\s+building\s+your\s+dream\s+space\s*.*/i,
      ];
      for (const pattern of boilerplatePatterns) {
        cleaned = cleaned.replace(pattern, '');
      }
      // Remove vendor name promotional sentences
      if (vendorName) {
        const escapedVendor = vendorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const vendorPromo = new RegExp('\\s*(?:at|from|by)\\s+' + escapedVendor + '\\s+we\\s+.*', 'i');
        cleaned = cleaned.replace(vendorPromo, '');
      }
      return cleaned.trim();
    }

    function StockBadge({ status, vendorHasInventory }) {
      if (vendorHasInventory === false && (status === 'unknown' || status === 'out_of_stock')) {
        return React.createElement('span', {
          className: 'stock-badge stock-badge--unknown',
          style: { fontSize: '0.75rem' }
        }, 'Call (714) 999-0009 for stock check');
      }
      const map = {
        in_stock: { label: 'In Stock', cls: 'in-stock' },
        low_stock: { label: 'Low Stock', cls: 'low-stock' },
        out_of_stock: { label: 'Out of Stock', cls: 'out-of-stock' },
      };
      const info = map[status] || { label: 'Check Availability', cls: 'unknown' };
      return React.createElement('span', { className: `stock-badge stock-badge--${info.cls}` }, info.label);
    }

    function StarDisplay({ rating, size = 16, color = '#c8a97e' }) {
      const stars = [];
      for (let i = 1; i <= 5; i++) {
        const fill = i <= Math.round(rating) ? color : '#d6d3d1';
        stars.push(React.createElement('svg', { key: i, width: size, height: size, viewBox: '0 0 24 24', fill: fill, xmlns: 'http://www.w3.org/2000/svg' },
          React.createElement('path', { d: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z' })
        ));
      }
      return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '2px' } }, stars);
    }

    let stripeInstance = null;
    (async () => {
      if (typeof Stripe === 'undefined') return;
      try {
        const r = await fetch((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'http://localhost:3001' : '') + '/api/config/stripe-key');
        const data = await r.json();
        if (data.key) stripeInstance = Stripe(data.key);
      } catch (e) { console.warn('Failed to load Stripe key:', e); }
    })();

    // ==================== Google Places Loader ====================
    let _placesPromise = null;
    function loadGooglePlaces(apiKey) {
      if (_placesPromise) return _placesPromise;
      if (window.google && window.google.maps && window.google.maps.places) {
        _placesPromise = Promise.resolve();
        return _placesPromise;
      }
      _placesPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(apiKey) + '&libraries=places';
        script.async = true;
        script.onload = resolve;
        script.onerror = () => { _placesPromise = null; reject(new Error('Failed to load Google Places')); };
        document.head.appendChild(script);
      });
      return _placesPromise;
    }

    // ==================== Error Boundary ====================

    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { hasError: false, errorMsg: '' };
      }
      static getDerivedStateFromError(error) {
        return { hasError: true, errorMsg: error && (error.stack || error.message || String(error)) };
      }
      componentDidCatch(error, info) {
        console.error('ErrorBoundary caught:', error, info);
      }
      render() {
        if (this.state.hasError) {
          return React.createElement('div', {
            style: { maxWidth: 800, margin: '6rem auto', textAlign: 'center', padding: '2rem', fontFamily: "'Inter', system-ui, sans-serif" }
          },
            React.createElement('div', { style: { fontSize: '4rem', marginBottom: '1rem', color: '#a8a29e' } }, '\u26A0'),
            React.createElement('h1', { style: { fontFamily: "'Cormorant Garamond', serif", fontSize: '2rem', fontWeight: 300, marginBottom: '0.75rem' } }, 'Something Went Wrong'),
            React.createElement('pre', { style: { color: '#dc2626', textAlign: 'left', background: '#fef2f2', padding: '1rem', fontSize: '0.75rem', overflow: 'auto', maxHeight: '300px', marginBottom: '1rem', border: '1px solid #fca5a5', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
              this.state.errorMsg || 'Unknown error'
            ),
            React.createElement('button', {
              onClick: () => window.location.reload(),
              style: { display: 'inline-block', padding: '1rem 3rem', background: '#1c1917', color: 'white', border: 'none', fontSize: '0.8125rem', textTransform: 'uppercase', letterSpacing: '0.1em', cursor: 'pointer', fontFamily: "'Inter', system-ui, sans-serif" }
            }, 'Refresh Page')
          );
        }
        return this.props.children;
      }
    }

    // ==================== Scroll Reveal ====================

    function useRevealOnScroll(options = {}) {
      const ref = useRef(null);
      const [isVisible, setIsVisible] = useState(false);
      useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const observer = new IntersectionObserver(([entry]) => {
          if (entry.isIntersecting) {
            setIsVisible(true);
            observer.unobserve(el);
          }
        }, { threshold: options.threshold || 0.15, rootMargin: options.rootMargin || '-60px' });
        observer.observe(el);
        return () => observer.disconnect();
      }, []);
      return [ref, isVisible];
    }

    function RevealSection({ children, delay = 0, className = '' }) {
      const [ref, isVisible] = useRevealOnScroll();
      return (
        <div
          ref={ref}
          className={'reveal-section ' + className}
          style={{
            opacity: isVisible ? 1 : 0,
            transform: isVisible ? 'translateY(0)' : 'translateY(var(--fade-up-distance, 30px))',
            transition: `opacity var(--fade-duration, 0.7s) cubic-bezier(0.22,1,0.36,1) ${delay}s, transform var(--fade-duration, 0.7s) cubic-bezier(0.22,1,0.36,1) ${delay}s`
          }}
        >
          {children}
        </div>
      );
    }

    // ==================== Main App ====================

    function StorefrontApp() {
      const [view, setView] = useState('home');
      const [selectedSkuId, setSelectedSkuId] = useState(null);

      // SKU browse state
      const [skus, setSkus] = useState([]);
      const [totalSkus, setTotalSkus] = useState(0);
      const [categories, setCategories] = useState([]);
      const [selectedCategory, setSelectedCategory] = useState(null);
      const [selectedCollection, setSelectedCollection] = useState(null);
      const [searchQuery, setSearchQuery] = useState('');
      const [searchDidYouMean, setSearchDidYouMean] = useState(null);
      const [filters, setFilters] = useState({});
      const [facets, setFacets] = useState([]);
      const [vendorFacets, setVendorFacets] = useState([]);
      const [priceRange, setPriceRange] = useState({ min: 0, max: 1000 });
      const [userPriceRange, setUserPriceRange] = useState({ min: null, max: null });
      const [vendorFilters, setVendorFilters] = useState([]);
      const [globalFacets, setGlobalFacets] = useState([]);
      const [tagFacets, setTagFacets] = useState([]);
      const [tagFilters, setTagFilters] = useState([]);
      const [sortBy, setSortBy] = useState('name_asc');
      const [loadingSkus, setLoadingSkus] = useState(false);
      const [currentPage, setCurrentPage] = useState(1);

      // Homepage
      const [featuredSkus, setFeaturedSkus] = useState([]);
      const [featuredLoading, setFeaturedLoading] = useState(true);

      // Cart
      const [cart, setCart] = useState([]);
      const [cartDrawerOpen, setCartDrawerOpen] = useState(false);
      const [cartFlash, setCartFlash] = useState(false);
      const [deliveryMethod, setDeliveryMethod] = useState('shipping');
      const [appliedPromoCode, setAppliedPromoCode] = useState(null);

      // Quick View
      const [quickViewSku, setQuickViewSku] = useState(null);

      // Mobile UI
      const [mobileNavOpen, setMobileNavOpen] = useState(false);
      const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
      const [mobileSearchOpen, setMobileSearchOpen] = useState(false);

      // Visit recap
      const [visitRecapToken, setVisitRecapToken] = useState(null);

      // Auth
      const [tradeCustomer, setTradeCustomer] = useState(null);
      const [tradeToken, setTradeToken] = useState(localStorage.getItem('trade_token') || null);
      const [customer, setCustomer] = useState(null);
      const [customerToken, setCustomerToken] = useState(localStorage.getItem('customer_token') || null);
      const [showAuthModal, setShowAuthModal] = useState(false);
      const [authModalMode, setAuthModalMode] = useState('login');
      const [showTradeModal, setShowTradeModal] = useState(false);
      const [tradeModalMode, setTradeModalMode] = useState('login');
      const [showInstallModal, setShowInstallModal] = useState(false);
      const [showFloorQuiz, setShowFloorQuiz] = useState(false);
      const [installModalProduct, setInstallModalProduct] = useState(null);

      // Order
      const [completedOrder, setCompletedOrder] = useState(null);

      // Toast notifications
      const [toasts, setToasts] = useState([]);
      const toastIdRef = useRef(0);
      const showToast = useCallback((message, type = 'info', duration = 3500) => {
        const id = ++toastIdRef.current;
        setToasts(prev => [...prev, { id, message, type, leaving: false }]);
        setTimeout(() => {
          setToasts(prev => prev.map(t => t.id === id ? { ...t, leaving: true } : t));
          setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 350);
        }, duration);
      }, []);

      // Wishlist
      const [wishlist, setWishlist] = useState(() => {
        try { return JSON.parse(localStorage.getItem('wishlist') || '[]'); } catch { return []; }
      });

      // Recently viewed
      const [recentlyViewed, setRecentlyViewed] = useState(() => {
        try { return JSON.parse(localStorage.getItem('recently_viewed') || '[]'); } catch { return []; }
      });
      const addRecentlyViewed = (skuData) => {
        setRecentlyViewed(prev => {
          const filtered = prev.filter(s => s.sku_id !== skuData.sku_id);
          const updated = [{ sku_id: skuData.sku_id, product_name: skuData.product_name, variant_name: skuData.variant_name, primary_image: skuData.primary_image, retail_price: skuData.retail_price, price_basis: skuData.price_basis, sell_by: skuData.sell_by, sqft_per_box: skuData.sqft_per_box }, ...filtered].slice(0, 12);
          localStorage.setItem('recently_viewed', JSON.stringify(updated));
          return updated;
        });
      };

      const sessionId = useRef(getSessionId());
      const scrollY = useRef(0);
      const pendingScroll = useRef(null);

      const tradeHeaders = () => {
        const t = localStorage.getItem('trade_token');
        return t ? { 'X-Trade-Token': t } : {};
      };

      // ---- Stable refs for popstate handler ----
      const fetchSkusRef = useRef(null);
      const fetchFacetsRef = useRef(null);

      // ---- Fetch SKUs ----
      const fetchSkus = useCallback((opts = {}) => {
        const PAGE_SIZE = 72;
        const { cat, coll, search, activeFilters, sort, page, vendors, priceMin, priceMax, tags } = {
          cat: selectedCategory, coll: selectedCollection, search: searchQuery,
          activeFilters: filters, sort: sortBy, page: currentPage,
          vendors: vendorFilters, priceMin: userPriceRange.min, priceMax: userPriceRange.max, tags: tagFilters, ...opts
        };
        const params = new URLSearchParams();
        if (cat) params.set('category', cat);
        if (coll) params.set('collection', coll);
        if (search) params.set('q', search);
        if (sort) params.set('sort', sort);
        params.set('limit', String(PAGE_SIZE));
        params.set('offset', String((page - 1) * PAGE_SIZE));
        const af = activeFilters || {};
        Object.keys(af).forEach(slug => {
          if (af[slug] && af[slug].length > 0) params.set(slug, af[slug].join('|'));
        });
        const vf = vendors || [];
        if (vf.length > 0) params.set('vendor', vf.join('|'));
        if (priceMin != null) params.set('price_min', String(priceMin));
        if (priceMax != null) params.set('price_max', String(priceMax));
        const tf = tags || [];
        if (tf.length > 0) params.set('tags', tf.join('|'));

        setLoadingSkus(true);
        fetch(API + '/api/storefront/skus?' + params.toString(), { headers: tradeHeaders() })
          .then(r => r.json())
          .then(data => {
            setSkus(data.skus || []);
            setTotalSkus(data.total || 0);
            setSearchDidYouMean(data.didYouMean || null);
            setLoadingSkus(false);
            if (pendingScroll.current !== null) {
              const pos = pendingScroll.current;
              pendingScroll.current = null;
              requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, pos)));
            }
          })
          .catch(err => { console.error(err); setLoadingSkus(false); });
      }, [selectedCategory, selectedCollection, searchQuery, filters, sortBy, currentPage, vendorFilters, userPriceRange, tagFilters]);

      // ---- Fetch Facets ----
      const fetchFacets = useCallback((opts = {}) => {
        const { cat, coll, search, activeFilters, vendors, priceMin, priceMax, tags } = {
          cat: selectedCategory, coll: selectedCollection, search: searchQuery,
          activeFilters: filters, vendors: vendorFilters,
          priceMin: userPriceRange.min, priceMax: userPriceRange.max, tags: tagFilters, ...opts
        };
        const params = new URLSearchParams();
        if (cat) params.set('category', cat);
        if (coll) params.set('collection', coll);
        if (search) params.set('q', search);
        const af = activeFilters || {};
        Object.keys(af).forEach(slug => {
          if (af[slug] && af[slug].length > 0) params.set(slug, af[slug].join('|'));
        });
        const vf = vendors || [];
        if (vf.length > 0) params.set('vendor', vf.join('|'));
        if (priceMin != null) params.set('price_min', String(priceMin));
        if (priceMax != null) params.set('price_max', String(priceMax));
        const tf = tags || [];
        if (tf.length > 0) params.set('tags', tf.join('|'));

        fetch(API + '/api/storefront/facets?' + params.toString())
          .then(r => r.json())
          .then(data => {
            setFacets(data.facets || []);
            setVendorFacets(data.vendors || []);
            setTagFacets(data.tags || []);
            if (data.priceRange) setPriceRange(data.priceRange);
          })
          .catch(err => console.error(err));
      }, [selectedCategory, selectedCollection, searchQuery, filters, vendorFilters, userPriceRange, tagFilters]);

      // Keep refs up to date so popstate always uses latest versions
      fetchSkusRef.current = fetchSkus;
      fetchFacetsRef.current = fetchFacets;

      // ---- URL Helpers ----
      const buildShopUrl = (cat, coll, search, af, vf, prMin, prMax, tf) => {
        const params = new URLSearchParams();
        if (cat) params.set('category', cat);
        if (coll) params.set('collection', coll);
        if (search) params.set('q', search);
        const f = af || {};
        Object.keys(f).forEach(slug => {
          if (f[slug] && f[slug].length > 0) params.set(slug, f[slug].join('|'));
        });
        if (vf && vf.length > 0) params.set('vendor', vf.join('|'));
        if (prMin != null) params.set('price_min', String(prMin));
        if (prMax != null) params.set('price_max', String(prMax));
        if (tf && tf.length > 0) params.set('tags', tf.join('|'));
        const qs = params.toString();
        return '/shop' + (qs ? '?' + qs : '');
      };

      const pushShopUrl = (cat, coll, search, af, replace, vf, prMin, prMax, tf) => {
        const url = buildShopUrl(cat, coll, search, af, vf, prMin, prMax, tf);
        const state = { view: 'browse', cat, coll, search, filters: af, vendors: vf, priceMin: prMin, priceMax: prMax, tags: tf, page: currentPage, scrollPos: scrollY.current };
        if (replace) history.replaceState(state, '', url);
        else history.pushState(state, '', url);
      };

      // ---- Cart ----
      const fetchCart = () => {
        fetch(API + '/api/cart?session_id=' + encodeURIComponent(sessionId.current))
          .then(r => r.json())
          .then(data => setCart(data.cart || []))
          .catch(err => console.error(err));
      };

      const addToCart = (item) => {
        fetch(API + '/api/cart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...item, session_id: sessionId.current })
        })
          .then(r => r.json())
          .then(data => {
            if (data.error) { showToast(data.error, 'error'); return; }
            if (data.item) {
              setCart(prev => {
                const existing = prev.findIndex(i => i.id === data.item.id);
                if (existing >= 0) {
                  const updated = [...prev];
                  updated[existing] = data.item;
                  return updated;
                }
                return [...prev, data.item];
              });
              setCartFlash(true);
              setTimeout(() => setCartFlash(false), 600);
              showToast('Added to cart', 'success');
              setCartDrawerOpen(true);
            }
          })
          .catch(err => console.error(err));
      };

      const removeFromCart = (itemId) => {
        fetch(API + '/api/cart/' + itemId + '?session_id=' + encodeURIComponent(sessionId.current), { method: 'DELETE' })
          .then(r => r.json())
          .then(() => setCart(prev => prev.filter(i => i.id !== itemId)))
          .catch(err => console.error(err));
      };

      const updateCartItem = (itemId, updates) => {
        fetch(API + '/api/cart/' + itemId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...updates, session_id: sessionId.current })
        })
          .then(r => r.json())
          .then(data => {
            if (data.item) setCart(prev => prev.map(i => i.id === itemId ? data.item : i));
          })
          .catch(err => console.error(err));
      };

      // ---- Auth ----
      const handleTradeLogin = (token, cust) => {
        localStorage.setItem('trade_token', token);
        setTradeToken(token);
        setTradeCustomer(cust);
        setShowTradeModal(false);
        fetchSkus({ cat: selectedCategory, coll: selectedCollection, search: searchQuery, activeFilters: filters, page: currentPage });
      };

      const handleTradeLogout = () => {
        const t = localStorage.getItem('trade_token');
        if (t) fetch(API + '/api/trade/logout', { method: 'POST', headers: { 'X-Trade-Token': t } }).catch(() => {});
        localStorage.removeItem('trade_token');
        setTradeToken(null);
        setTradeCustomer(null);
        fetchSkus({ cat: selectedCategory, coll: selectedCollection, search: searchQuery, activeFilters: filters, page: currentPage });
      };

      const handleCustomerLogin = (token, cust) => {
        localStorage.setItem('customer_token', token);
        setCustomerToken(token);
        setCustomer(cust);
        setShowAuthModal(false);
        syncWishlistOnLogin(token);
      };

      const handleCustomerLogout = () => {
        const t = localStorage.getItem('customer_token');
        if (t) fetch(API + '/api/customer/logout', { method: 'POST', headers: { 'X-Customer-Token': t } }).catch(() => {});
        localStorage.removeItem('customer_token');
        setCustomerToken(null);
        setCustomer(null);
      };

      // ---- Wishlist ----
      const toggleWishlist = (productId) => {
        const isWished = wishlist.includes(productId);
        let updated;
        if (isWished) {
          updated = wishlist.filter(id => id !== productId);
          showToast('Removed from wishlist', 'info');
        } else {
          updated = [productId, ...wishlist];
          showToast('Added to wishlist', 'success');
        }
        setWishlist(updated);
        localStorage.setItem('wishlist', JSON.stringify(updated));
        const custToken = localStorage.getItem('customer_token');
        if (custToken) {
          if (isWished) {
            fetch(API + '/api/wishlist/' + productId, { method: 'DELETE', headers: { 'X-Customer-Token': custToken } }).catch(() => {});
          } else {
            fetch(API + '/api/wishlist', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Customer-Token': custToken },
              body: JSON.stringify({ product_id: productId })
            }).catch(() => {});
          }
        }
      };

      const syncWishlistOnLogin = (token) => {
        const localWishlist = JSON.parse(localStorage.getItem('wishlist') || '[]');
        if (localWishlist.length > 0) {
          fetch(API + '/api/wishlist/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Customer-Token': token },
            body: JSON.stringify({ product_ids: localWishlist })
          })
          .then(r => r.json())
          .then(data => {
            if (data.product_ids) {
              setWishlist(data.product_ids);
              localStorage.setItem('wishlist', JSON.stringify(data.product_ids));
            }
          })
          .catch(() => {});
        } else {
          fetch(API + '/api/wishlist', { headers: { 'X-Customer-Token': token } })
          .then(r => r.json())
          .then(data => {
            if (data.product_ids) {
              setWishlist(data.product_ids);
              localStorage.setItem('wishlist', JSON.stringify(data.product_ids));
            }
          })
          .catch(() => {});
        }
      };

      const goHome = () => {
        setView('home');
        history.pushState({ view: 'home' }, '', '/');
        window.scrollTo(0, 0);
      };

      const goWishlist = () => {
        setView('wishlist');
        history.pushState({ view: 'wishlist' }, '', '/wishlist');
        window.scrollTo(0, 0);
      };

      const goCollections = () => {
        setView('collections');
        history.pushState({ view: 'collections' }, '', '/collections');
        window.scrollTo(0, 0);
      };

      const goTrade = () => {
        setView('trade');
        history.pushState({ view: 'trade' }, '', '/trade');
        window.scrollTo(0, 0);
      };

      const goTradeDashboard = () => {
        setView('trade-dashboard');
        history.pushState({ view: 'trade-dashboard' }, '', '/trade/dashboard');
        window.scrollTo(0, 0);
      };

      const goBulkOrder = () => {
        setView('bulk-order');
        history.pushState({ view: 'bulk-order' }, '', '/trade/bulk-order');
        window.scrollTo(0, 0);
      };

      const goInstallation = () => {
        setView('installation');
        history.pushState({ view: 'installation' }, '', '/installation');
        window.scrollTo(0, 0);
      };

      const goInspiration = () => {
        setView('inspiration');
        history.pushState({ view: 'inspiration' }, '', '/inspiration');
        window.scrollTo(0, 0);
      };

      const goSale = () => {
        setView('sale');
        history.pushState({ view: 'sale' }, '', '/sale');
        window.scrollTo(0, 0);
      };

      const [comingSoonTitle, setComingSoonTitle] = useState('');
      const [newsletterEmail, setNewsletterEmail] = useState('');
      const [newsletterSubmitted, setNewsletterSubmitted] = useState(false);
      const handleNewsletterSubmit = (e) => {
        e.preventDefault();
        if (!newsletterEmail) return;
        fetch(API + '/api/newsletter/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: newsletterEmail })
        }).then(r => r.json()).then(() => {
          setNewsletterSubmitted(true);
        }).catch(() => {
          setNewsletterSubmitted(true);
        });
      };

      const navigate = (path) => {
        // Handle query-based shop routes
        if (path.startsWith('/shop?')) {
          const sp = new URLSearchParams(path.split('?')[1]);
          setSelectedCategory(null);
          setSelectedCollection(null);
          setSearchQuery('');
          setFilters({});
          setVendorFilters([]);
          setTagFilters([]);
          setUserPriceRange({ min: null, max: null });
          setCurrentPage(1);
          const sortVal = sp.get('sort');
          if (sortVal) setSortBy(sortVal);
          setView('browse');
          fetchSkus({ cat: null, coll: null, search: '', activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [], page: 1, sort: sortVal || sortBy });
          fetchFacets({ cat: null, coll: null, search: '', activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [] });
          history.pushState({ view: 'browse' }, '', path);
          window.scrollTo(0, 0);
          return;
        }
        if (path === '/installation') {
          goInstallation();
          return;
        }
        if (path === '/inspiration') {
          goInspiration();
          return;
        }
        if (path === '/sale') {
          goSale();
          return;
        }
        // Service page placeholders
        const servicePages = {
          '/design-services': 'Design Services',
          '/about': 'About Us'
        };
        if (servicePages[path]) {
          setComingSoonTitle(servicePages[path]);
          setView('coming-soon');
          history.pushState({ view: 'coming-soon', title: servicePages[path] }, '', path);
          window.scrollTo(0, 0);
          return;
        }
      };

      const handleCollectionClick = (collectionName) => {
        setSelectedCategory(null);
        setSelectedCollection(collectionName);
        setFilters({});
        setVendorFilters([]);
        setTagFilters([]);
        setUserPriceRange({ min: null, max: null });
        setCurrentPage(1);
        setView('browse');
        fetchSkus({ cat: null, coll: collectionName, activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [], page: 1 });
        fetchFacets({ cat: null, coll: collectionName, activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [] });
        pushShopUrl(null, collectionName, '', {}, false, [], null, null, []);
        window.scrollTo(0, 0);
      };

      // ---- Navigation ----
      const goBrowse = () => {
        setView('browse');
        setSelectedCollection(null);
        setSearchQuery('');
        setFilters({});
        setVendorFilters([]);
        setTagFilters([]);
        setUserPriceRange({ min: null, max: null });
        setCurrentPage(1);
        // Auto-select first category instead of showing "Shop All"
        const firstCat = categories.length > 0 ? categories[0].slug : null;
        setSelectedCategory(firstCat);
        fetchSkus({ cat: firstCat, coll: null, search: '', activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [], page: 1 });
        fetchFacets({ cat: firstCat, coll: null, search: '', activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [] });
        pushShopUrl(firstCat, null, '', {}, false, [], null, null, []);
        window.scrollTo(0, 0);
      };

      const goSkuDetail = (skuId, productName) => {
        if (view === 'browse' || view === 'home') scrollY.current = window.scrollY;
        setSelectedSkuId(skuId);
        setView('detail');
        const slug = generateSlug(productName || 'product');
        history.pushState({ view: 'detail', skuId }, '', '/shop/sku/' + skuId + '/' + slug);
        window.scrollTo(0, 0);
      };

      const goBackToBrowse = () => {
        setView('browse');
        pushShopUrl(selectedCategory, selectedCollection, searchQuery, filters, false, vendorFilters, userPriceRange.min, userPriceRange.max, tagFilters);
        requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, scrollY.current)));
      };

      const goCart = () => {
        setView('cart');
        setCartDrawerOpen(false);
        history.pushState({ view: 'cart' }, '', '/cart');
        window.scrollTo(0, 0);
      };

      const goCheckout = () => {
        setView('checkout');
        setCartDrawerOpen(false);
        history.pushState({ view: 'checkout' }, '', '/checkout');
        window.scrollTo(0, 0);
      };

      const goAccount = () => {
        setView('account');
        history.pushState({ view: 'account' }, '', '/account');
        window.scrollTo(0, 0);
      };

      const handleOrderComplete = (orderData) => {
        setCompletedOrder(orderData);
        setCart([]);
        setView('confirmation');
        window.scrollTo(0, 0);
      };

      // ---- Filter Handlers ----
      const handleCategorySelect = (slug) => {
        setSelectedCategory(slug);
        setSelectedCollection(null);
        setFilters({});
        setVendorFilters([]);
        setTagFilters([]);
        setUserPriceRange({ min: null, max: null });
        setCurrentPage(1);
        fetchSkus({ cat: slug, coll: null, activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [], page: 1 });
        fetchFacets({ cat: slug, coll: null, activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [] });
        pushShopUrl(slug, null, searchQuery, {}, false, [], null, null, []);
      };

      const handleAxisSelect = (attrSlug, value) => {
        setSelectedCategory(null);
        setSelectedCollection(null);
        setSearchQuery('');
        setFilters({ [attrSlug]: [value] });
        setVendorFilters([]);
        setTagFilters([]);
        setUserPriceRange({ min: null, max: null });
        setCurrentPage(1);
        setView('browse');
        const af = { [attrSlug]: [value] };
        fetchSkus({ cat: null, coll: null, search: '', activeFilters: af, vendors: [], priceMin: null, priceMax: null, tags: [], page: 1 });
        fetchFacets({ cat: null, coll: null, search: '', activeFilters: af, vendors: [], priceMin: null, priceMax: null, tags: [] });
        pushShopUrl(null, null, '', af, false, [], null, null, []);
        window.scrollTo(0, 0);
      };

      const handleFilterToggle = (slug, value) => {
        setFilters(prev => {
          const current = prev[slug] || [];
          const next = current.includes(value) ? current.filter(v => v !== value) : [...current, value];
          const updated = { ...prev };
          if (next.length > 0) updated[slug] = next;
          else delete updated[slug];
          setCurrentPage(1);
          fetchSkus({ activeFilters: updated, page: 1 });
          fetchFacets({ activeFilters: updated });
          pushShopUrl(selectedCategory, selectedCollection, searchQuery, updated, true, vendorFilters, userPriceRange.min, userPriceRange.max, tagFilters);
          return updated;
        });
      };

      const handleVendorToggle = (name) => {
        setVendorFilters(prev => {
          const next = prev.includes(name) ? prev.filter(v => v !== name) : [...prev, name];
          setCurrentPage(1);
          fetchSkus({ vendors: next, page: 1 });
          fetchFacets({ vendors: next });
          pushShopUrl(selectedCategory, selectedCollection, searchQuery, filters, true, next, userPriceRange.min, userPriceRange.max, tagFilters);
          return next;
        });
      };

      const handleTagToggle = (slug) => {
        setTagFilters(prev => {
          const next = prev.includes(slug) ? prev.filter(t => t !== slug) : [...prev, slug];
          setCurrentPage(1);
          fetchSkus({ tags: next, page: 1 });
          fetchFacets({ tags: next });
          pushShopUrl(selectedCategory, selectedCollection, searchQuery, filters, true, vendorFilters, userPriceRange.min, userPriceRange.max, next);
          return next;
        });
      };

      const priceDebounceRef = useRef(null);
      const handlePriceRangeChange = (min, max) => {
        const newRange = { min: min != null ? min : null, max: max != null ? max : null };
        setUserPriceRange(newRange);
        if (priceDebounceRef.current) clearTimeout(priceDebounceRef.current);
        priceDebounceRef.current = setTimeout(() => {
          setCurrentPage(1);
          fetchSkus({ priceMin: newRange.min, priceMax: newRange.max, page: 1 });
          fetchFacets({ priceMin: newRange.min, priceMax: newRange.max });
          pushShopUrl(selectedCategory, selectedCollection, searchQuery, filters, true, vendorFilters, newRange.min, newRange.max, tagFilters);
        }, 500);
      };

      const handleClearFilters = () => {
        setFilters({});
        setVendorFilters([]);
        setTagFilters([]);
        setUserPriceRange({ min: null, max: null });
        setCurrentPage(1);
        fetchSkus({ activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [], page: 1 });
        fetchFacets({ activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [] });
        pushShopUrl(selectedCategory, selectedCollection, searchQuery, {}, true, [], null, null, []);
      };

      const handleSearch = (query) => {
        setSearchQuery(query);
        setSearchDidYouMean(null);
        setSelectedCategory(null);
        setSelectedCollection(null);
        setFilters({});
        setVendorFilters([]);
        setTagFilters([]);
        setUserPriceRange({ min: null, max: null });
        setCurrentPage(1);
        setView('browse');
        fetchSkus({ cat: null, coll: null, search: query, activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [], page: 1 });
        fetchFacets({ cat: null, coll: null, search: query, activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [] });
        pushShopUrl(null, null, query, {}, false, [], null, null, []);
        window.scrollTo(0, 0);
      };

      const handleSortChange = (newSort) => {
        setSortBy(newSort);
        setCurrentPage(1);
        fetchSkus({ sort: newSort, page: 1 });
      };

      const handlePageChange = (page) => {
        setCurrentPage(page);
        fetchSkus({ page });
        window.scrollTo(0, 0);
      };

      // ---- Init ----
      useEffect(() => {
        fetchCart();

        fetch(API + '/api/categories').then(r => r.json())
          .then(data => setCategories(data.categories || []))
          .catch(err => console.error(err));

        // Restore trade session
        const savedToken = localStorage.getItem('trade_token');
        if (savedToken) {
          fetch(API + '/api/trade/me', { headers: { 'X-Trade-Token': savedToken } })
            .then(r => { if (!r.ok) throw new Error(); return r.json(); })
            .then(data => { setTradeCustomer(data.customer); setTradeToken(savedToken); })
            .catch(() => { localStorage.removeItem('trade_token'); setTradeToken(null); });
        }

        // Restore customer session
        const savedCustToken = localStorage.getItem('customer_token');
        if (savedCustToken) {
          fetch(API + '/api/customer/me', { headers: { 'X-Customer-Token': savedCustToken } })
            .then(r => { if (!r.ok) throw new Error(); return r.json(); })
            .then(data => { setCustomer(data.customer); setCustomerToken(savedCustToken); })
            .catch(() => { localStorage.removeItem('customer_token'); setCustomerToken(null); });
        }

        // Fetch featured SKUs for homepage (best-sellers with newest fallback)
        fetch(API + '/api/storefront/featured')
          .then(r => r.json())
          .then(data => { setFeaturedSkus(data.skus || []); setFeaturedLoading(false); })
          .catch(() => { setFeaturedLoading(false); });

        // Fetch global facets for axis navigation (By Look, By Color, By Size)
        fetch(API + '/api/storefront/facets')
          .then(r => r.json())
          .then(data => setGlobalFacets(data.facets || []))
          .catch(console.error);

        // Parse URL
        const path = window.location.pathname;
        const sp = new URLSearchParams(window.location.search);

        if (sp.get('reset_token')) {
          setView('reset-password');
        } else if (path === '/' || path === '') {
          setView('home');
        } else if (path.startsWith('/shop/sku/')) {
          const parts = path.replace('/shop/sku/', '').split('/');
          setSelectedSkuId(parts[0]);
          setView('detail');
        } else if (path === '/cart' || path === '/shop/cart') {
          setView('cart');
        } else if (path === '/checkout' || path === '/shop/checkout') {
          setView('checkout');
        } else if (path === '/account' || path === '/shop/account') {
          setView('account');
        } else if (path === '/wishlist' || path === '/shop/wishlist') {
          setView('wishlist');
        } else if (path === '/collections' || path === '/shop/collections') {
          setView('collections');
        } else if (path.startsWith('/collections/')) {
          const slug = path.replace('/collections/', '');
          setSelectedCollection(slug);
          setView('browse');
          fetchSkus({ coll: slug, activeFilters: {}, tags: [] });
          fetchFacets({ coll: slug, activeFilters: {}, tags: [] });
        } else if (path === '/trade' && !path.startsWith('/trade/')) {
          setView('trade');
        } else if (path === '/trade/dashboard' || path === '/shop/trade') {
          setView('trade-dashboard');
        } else if (path === '/trade/bulk-order') {
          setView('bulk-order');
        } else if (path.startsWith('/visit/')) {
          setVisitRecapToken(path.replace('/visit/', ''));
          setView('visit-recap');
        } else if (path === '/reset-password') {
          setView('reset-password');
        } else if (path === '/installation') {
          setView('installation');
        } else if (path === '/inspiration') {
          setView('inspiration');
        } else if (path === '/sale') {
          setView('sale');
        } else if (['/design-services', '/about'].includes(path)) {
          const titles = { '/design-services': 'Design Services', '/about': 'About Us' };
          setComingSoonTitle(titles[path]);
          setView('coming-soon');
        } else if (path === '/shop' || path.startsWith('/shop')) {
          // Browse view
          setView('browse');
          const cat = sp.get('category');
          const coll = sp.get('collection');
          const q = sp.get('q');
          const reserved = ['category', 'collection', 'q', 'vendor', 'price_min', 'price_max', 'sort', 'tags'];
          const af = {};
          sp.forEach((val, key) => {
            if (!reserved.includes(key)) af[key] = val.split('|');
          });
          const vf = sp.get('vendor') ? sp.get('vendor').split('|') : [];
          const prMin = sp.get('price_min') ? parseFloat(sp.get('price_min')) : null;
          const prMax = sp.get('price_max') ? parseFloat(sp.get('price_max')) : null;
          const tf = sp.get('tags') ? sp.get('tags').split('|') : [];
          if (cat) setSelectedCategory(cat);
          if (coll) setSelectedCollection(coll);
          if (q) setSearchQuery(q);
          if (Object.keys(af).length) setFilters(af);
          if (vf.length) setVendorFilters(vf);
          if (tf.length) setTagFilters(tf);
          if (prMin != null || prMax != null) setUserPriceRange({ min: prMin, max: prMax });
          fetchSkus({ cat, coll, search: q || '', activeFilters: af, vendors: vf, priceMin: prMin, priceMax: prMax, tags: tf });
          fetchFacets({ cat, coll, search: q || '', activeFilters: af, vendors: vf, priceMin: prMin, priceMax: prMax, tags: tf });
        } else {
          setView('home');
        }

        // Popstate
        const handlePop = (e) => {
          const state = e.state;
          if (state && state.view) {
            setView(state.view);
            if (state.view === 'detail' && state.skuId) setSelectedSkuId(state.skuId);
            if (state.view === 'browse') {
              setSelectedCategory(state.cat || null);
              setSelectedCollection(state.coll || null);
              setSearchQuery(state.search || '');
              setFilters(state.filters || {});
              setVendorFilters(state.vendors || []);
              setTagFilters(state.tags || []);
              setUserPriceRange({ min: state.priceMin != null ? state.priceMin : null, max: state.priceMax != null ? state.priceMax : null });
              const savedPage = state.page || 1;
              const savedScroll = state.scrollPos || 0;
              setCurrentPage(savedPage);
              scrollY.current = savedScroll;
              pendingScroll.current = savedScroll;
              fetchSkusRef.current({ cat: state.cat, coll: state.coll, search: state.search || '', activeFilters: state.filters || {}, vendors: state.vendors || [], priceMin: state.priceMin, priceMax: state.priceMax, tags: state.tags || [], page: savedPage });
              fetchFacetsRef.current({ cat: state.cat, coll: state.coll, search: state.search || '', activeFilters: state.filters || {}, vendors: state.vendors || [], priceMin: state.priceMin, priceMax: state.priceMax, tags: state.tags || [] });
            }
            if (state.view === 'visit-recap' && state.token) setVisitRecapToken(state.token);
            if (state.view === 'coming-soon' && state.title) setComingSoonTitle(state.title);
          } else {
            // Re-parse URL for unknown states
            const p = window.location.pathname;
            if (p === '/' || p === '') { setView('home'); }
            else if (p.startsWith('/shop/sku/')) {
              const parts = p.replace('/shop/sku/', '').split('/');
              setSelectedSkuId(parts[0]);
              setView('detail');
            } else if (p === '/trade') { setView('trade'); }
            else if (p === '/trade/dashboard') { setView('trade-dashboard'); }
            else if (p === '/sale') { setView('sale'); }
            else if (p.startsWith('/visit/')) { setVisitRecapToken(p.replace('/visit/', '')); setView('visit-recap'); }
            else {
              setView('browse');
              const sp2 = new URLSearchParams(window.location.search);
              const cat = sp2.get('category');
              const coll = sp2.get('collection');
              const q = sp2.get('q');
              const reserved2 = ['category', 'collection', 'q', 'vendor', 'price_min', 'price_max', 'sort', 'tags'];
              const af = {};
              sp2.forEach((val, key) => {
                if (!reserved2.includes(key)) af[key] = val.split('|');
              });
              const vf = sp2.get('vendor') ? sp2.get('vendor').split('|') : [];
              const prMin = sp2.get('price_min') ? parseFloat(sp2.get('price_min')) : null;
              const prMax = sp2.get('price_max') ? parseFloat(sp2.get('price_max')) : null;
              const tf = sp2.get('tags') ? sp2.get('tags').split('|') : [];
              setSelectedCategory(cat);
              setSelectedCollection(coll);
              setSearchQuery(q || '');
              if (Object.keys(af).length) setFilters(af);
              setVendorFilters(vf);
              setTagFilters(tf);
              setUserPriceRange({ min: prMin, max: prMax });
              setCurrentPage(1);
              fetchSkusRef.current({ cat, coll, search: q || '', activeFilters: af, vendors: vf, priceMin: prMin, priceMax: prMax, tags: tf, page: 1 });
              fetchFacetsRef.current({ cat, coll, search: q || '', activeFilters: af, vendors: vf, priceMin: prMin, priceMax: prMax, tags: tf });
            }
          }
        };
        window.addEventListener('popstate', handlePop);
        return () => window.removeEventListener('popstate', handlePop);
      }, []);

      // Auto-select first category on bare /shop when categories load
      useEffect(() => {
        if (view === 'browse' && categories.length > 0 && !selectedCategory && !selectedCollection && !searchQuery && Object.keys(filters).length === 0) {
          const firstParent = categories[0];
          if (firstParent && firstParent.slug) {
            setSelectedCategory(firstParent.slug);
            fetchSkus({ cat: firstParent.slug, coll: null, search: '', activeFilters: filters, page: 1 });
            fetchFacets({ cat: firstParent.slug, coll: null, search: '', activeFilters: filters });
            pushShopUrl(firstParent.slug, null, '', filters, true, [], null, null, []);
          }
        }
      }, [view, categories]);

      // SEO updates on view change
      useEffect(() => {
        const seoMap = {
          home: { title: 'Roma Flooring Designs | Premium Flooring & Tile in Anaheim, CA', description: 'Roma Flooring Designs offers premium flooring, tile, stone, and countertop products in Anaheim, CA.', url: SITE_URL + '/' },
          browse: { title: 'Shop All | Roma Flooring Designs', description: 'Browse premium flooring, tile, stone, and countertop products.', url: SITE_URL + '/shop' },
          cart: { title: 'Cart | Roma Flooring Designs', description: 'Review your cart.', url: SITE_URL + '/cart' },
          checkout: { title: 'Checkout | Roma Flooring Designs', description: 'Complete your order.', url: SITE_URL + '/checkout' },
          collections: { title: 'Collections | Roma Flooring Designs', description: 'Explore our curated flooring collections from premium vendors.', url: SITE_URL + '/collections' },
          wishlist: { title: 'Wishlist | Roma Flooring Designs', description: 'Your saved products.', url: SITE_URL + '/wishlist' },
          account: { title: 'My Account | Roma Flooring Designs', description: 'Manage your account and orders.', url: SITE_URL + '/account' },
          trade: { title: 'Trade Program | Roma Flooring Designs', description: 'Join our trade program for exclusive pricing and dedicated support.', url: SITE_URL + '/trade' },
          'trade-dashboard': { title: 'Trade Dashboard | Roma Flooring Designs', description: 'Manage your trade account.', url: SITE_URL + '/trade/dashboard' },
          'bulk-order': { title: 'Bulk Order | Roma Flooring Designs', description: 'Place a bulk order.', url: SITE_URL + '/trade/bulk-order' },
          'reset-password': { title: 'Reset Password | Roma Flooring Designs', description: 'Reset your password.', url: SITE_URL + '/reset-password' },
        };

        // Dynamic SEO for filtered browse views
        if (view === 'browse' && selectedCategory) {
          const catObj = categories.find(c => c.slug === selectedCategory);
          const catName = catObj ? catObj.name : selectedCategory.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          updateSEO({ title: catName + ' Flooring | Roma Flooring Designs', description: 'Browse premium ' + catName.toLowerCase() + ' flooring products at Roma Flooring Designs.', url: SITE_URL + '/shop?category=' + encodeURIComponent(selectedCategory) });
        } else if (view === 'browse' && selectedCollection) {
          const collName = selectedCollection.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          updateSEO({ title: collName + ' | Roma Flooring Designs', description: 'Explore the ' + collName + ' collection at Roma Flooring Designs.', url: SITE_URL + '/collections/' + encodeURIComponent(selectedCollection) });
        } else if (seoMap[view]) {
          updateSEO(seoMap[view]);
        }

        // JSON-LD structured data per view
        if (view === 'browse') {
          const crumbs = [{ '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' }, { '@type': 'ListItem', position: 2, name: 'Shop', item: SITE_URL + '/shop' }];
          if (selectedCategory) {
            const catObj = categories.find(c => c.slug === selectedCategory);
            const catName = catObj ? catObj.name : selectedCategory.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            crumbs.push({ '@type': 'ListItem', position: 3, name: catName, item: SITE_URL + '/shop?category=' + encodeURIComponent(selectedCategory) });
          }
          setDynamicJsonLd({ '@context': 'https://schema.org', '@graph': [
            { '@type': 'CollectionPage', name: selectedCategory ? (categories.find(c => c.slug === selectedCategory) || {}).name || 'Shop' : 'Shop All', url: selectedCategory ? SITE_URL + '/shop?category=' + encodeURIComponent(selectedCategory) : SITE_URL + '/shop' },
            { '@type': 'BreadcrumbList', itemListElement: crumbs }
          ]});
        } else if (view === 'collections') {
          setDynamicJsonLd({ '@context': 'https://schema.org', '@graph': [
            { '@type': 'CollectionPage', name: 'Collections', url: SITE_URL + '/collections' },
            { '@type': 'BreadcrumbList', itemListElement: [
              { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
              { '@type': 'ListItem', position: 2, name: 'Collections', item: SITE_URL + '/collections' }
            ]}
          ]});
        } else if (view === 'trade') {
          setDynamicJsonLd({ '@context': 'https://schema.org', '@graph': [
            { '@type': 'WebPage', name: 'Trade Program', url: SITE_URL + '/trade', description: 'Join our trade program for exclusive pricing and dedicated support.' },
            { '@type': 'BreadcrumbList', itemListElement: [
              { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
              { '@type': 'ListItem', position: 2, name: 'Trade Program', item: SITE_URL + '/trade' }
            ]}
          ]});
        } else if (view !== 'detail') {
          const ldEl = document.getElementById('dynamic-jsonld');
          if (ldEl) ldEl.remove();
        }

        // Paginated browse pages: noindex to prevent duplicate content
        if (view === 'browse' && currentPage > 1) {
          let robotsMeta = document.querySelector('meta[data-paginated="true"]');
          if (!robotsMeta) {
            robotsMeta = document.createElement('meta');
            robotsMeta.setAttribute('name', 'robots');
            robotsMeta.setAttribute('data-paginated', 'true');
            document.head.appendChild(robotsMeta);
          }
          robotsMeta.setAttribute('content', 'noindex,follow');
        } else {
          const robotsMeta = document.querySelector('meta[data-paginated="true"]');
          if (robotsMeta) robotsMeta.remove();
        }
        // Lock body scroll when cart drawer is open
      }, [view, selectedCategory, selectedCollection, categories, currentPage]);

      return (
        <>
          <Header
            goHome={goHome} goBrowse={goBrowse} cart={cart}
            cartDrawerOpen={cartDrawerOpen} setCartDrawerOpen={setCartDrawerOpen}
            cartFlash={cartFlash}
            onSearch={handleSearch} onSkuClick={goSkuDetail}
            tradeCustomer={tradeCustomer}
            onTradeClick={tradeCustomer ? goTradeDashboard : goTrade}
            onTradeLogout={handleTradeLogout}
            customer={customer}
            onAccountClick={customer ? goAccount : () => { setAuthModalMode('login'); setShowAuthModal(true); }}
            onCustomerLogout={handleCustomerLogout}
            wishlistCount={wishlist.length}
            goWishlist={goWishlist}
            goCollections={goCollections}
            categories={categories}
            onCategorySelect={(slug) => { handleCategorySelect(slug); setView('browse'); }}
            globalFacets={globalFacets}
            onAxisSelect={handleAxisSelect}
            mobileNavOpen={mobileNavOpen} setMobileNavOpen={setMobileNavOpen}
            mobileSearchOpen={mobileSearchOpen} setMobileSearchOpen={setMobileSearchOpen}
            view={view}
            navigate={navigate}
            goSale={goSale}
          />

          {view === 'home' && (
            <HomePage
              featuredSkus={featuredSkus}
              featuredLoading={featuredLoading}
              categories={categories}
              onSkuClick={goSkuDetail}
              onCategorySelect={(slug) => { handleCategorySelect(slug); setView('browse'); }}
              goBrowse={goBrowse}
              goTrade={goTrade}
              navigate={navigate}
              wishlist={wishlist} toggleWishlist={toggleWishlist}
              setQuickViewSku={setQuickViewSku}
              newsletterEmail={newsletterEmail} setNewsletterEmail={setNewsletterEmail}
              newsletterSubmitted={newsletterSubmitted} onNewsletterSubmit={handleNewsletterSubmit}
              onOpenQuiz={() => setShowFloorQuiz(true)}
            />
          )}

          {view === 'browse' && (
            <BrowseView
              skus={skus} totalSkus={totalSkus} loading={loadingSkus}
              categories={categories} selectedCategory={selectedCategory}
              selectedCollection={selectedCollection} searchQuery={searchQuery}
              onCategorySelect={handleCategorySelect} onSearch={handleSearch}
              facets={facets} filters={filters}
              onFilterToggle={handleFilterToggle} onClearFilters={handleClearFilters}
              sortBy={sortBy} onSortChange={handleSortChange}
              onSkuClick={goSkuDetail}
              currentPage={currentPage} onPageChange={handlePageChange}
              wishlist={wishlist} toggleWishlist={toggleWishlist}
              setQuickViewSku={setQuickViewSku}
              filterDrawerOpen={filterDrawerOpen} setFilterDrawerOpen={setFilterDrawerOpen}
              goHome={goHome}
              vendorFacets={vendorFacets} vendorFilters={vendorFilters} onVendorToggle={handleVendorToggle}
              priceRange={priceRange} userPriceRange={userPriceRange} onPriceRangeChange={handlePriceRangeChange}
              tagFacets={tagFacets} tagFilters={tagFilters} onTagToggle={handleTagToggle}
              didYouMean={searchDidYouMean}
            />
          )}

          {view === 'detail' && selectedSkuId && (
            <SkuDetailView
              key={selectedSkuId}
              skuId={selectedSkuId} goBack={goBackToBrowse}
              addToCart={addToCart} cart={cart}
              onSkuClick={goSkuDetail}
              onRequestInstall={(p) => { setInstallModalProduct(p); setShowInstallModal(true); }}
              tradeCustomer={tradeCustomer}
              wishlist={wishlist} toggleWishlist={toggleWishlist}
              recentlyViewed={recentlyViewed} addRecentlyViewed={addRecentlyViewed}
              customer={customer} customerToken={customerToken}
              onShowAuth={() => { setAuthModalMode('login'); setShowAuthModal(true); }}
              showToast={showToast} categories={categories}
            />
          )}

          {view === 'cart' && (
            <CartPage cart={cart} goBrowse={goBrowse} removeFromCart={removeFromCart}
              updateCartItem={updateCartItem} goCheckout={goCheckout}
              deliveryMethod={deliveryMethod} setDeliveryMethod={setDeliveryMethod}
              sessionId={sessionId.current} appliedPromoCode={appliedPromoCode} setAppliedPromoCode={setAppliedPromoCode}
              goHome={goHome} />
          )}

          {view === 'checkout' && (
            <CheckoutPage cart={cart} sessionId={sessionId.current}
              goCart={goCart} handleOrderComplete={handleOrderComplete}
              deliveryMethod={deliveryMethod}
              tradeCustomer={tradeCustomer} tradeToken={tradeToken}
              customer={customer} customerToken={customerToken}
              onCustomerLogin={handleCustomerLogin}
              appliedPromoCode={appliedPromoCode} setAppliedPromoCode={setAppliedPromoCode} />
          )}

          {view === 'confirmation' && (
            <ConfirmationPage orderData={completedOrder} goBrowse={goBrowse} />
          )}

          {view === 'account' && (
            customer ? (
              <AccountPage customer={customer} customerToken={customerToken} setCustomer={setCustomer} goBrowse={goBrowse} />
            ) : (
              <div style={{ maxWidth: 600, margin: '4rem auto', textAlign: 'center', padding: '0 2rem' }}>
                <h2 style={{ fontFamily: 'var(--font-heading)', fontWeight: 300, marginBottom: '1rem' }}>Sign In Required</h2>
                <p style={{ color: 'var(--stone-600)', marginBottom: '1.5rem' }}>Please sign in to view your account.</p>
                <button className="btn" onClick={() => { setAuthModalMode('login'); setShowAuthModal(true); }}>Sign In</button>
              </div>
            )
          )}

          {view === 'wishlist' && (
            <WishlistPage wishlist={wishlist} toggleWishlist={toggleWishlist} onSkuClick={goSkuDetail} goBrowse={goBrowse} recentlyViewed={recentlyViewed} goHome={goHome} />
          )}

          {view === 'collections' && (
            <CollectionsPage onCollectionClick={handleCollectionClick} goHome={goHome} />
          )}

          {view === 'trade' && (
            <TradePage goTradeDashboard={goTradeDashboard} onApplyClick={() => { setTradeModalMode('register'); setShowTradeModal(true); }} tradeCustomer={tradeCustomer} />
          )}

          {view === 'trade-dashboard' && (
            tradeCustomer ? (
              <TradeDashboard tradeCustomer={tradeCustomer} tradeToken={tradeToken} addToCart={addToCart} goBrowse={goBrowse} setTradeCustomer={setTradeCustomer} handleTradeLogout={handleTradeLogout} goBulkOrder={goBulkOrder} showToast={showToast} />
            ) : (
              <div style={{ maxWidth: 600, margin: '4rem auto', textAlign: 'center', padding: '0 2rem' }}>
                <h2 style={{ fontFamily: 'var(--font-heading)', fontWeight: 300, marginBottom: '1rem' }}>Trade Login Required</h2>
                <p style={{ color: 'var(--stone-600)', marginBottom: '1.5rem' }}>Please sign in with your trade account to access the dashboard.</p>
                <button className="btn" onClick={() => { setTradeModalMode('login'); setShowTradeModal(true); }}>Trade Sign In</button>
              </div>
            )
          )}

          {view === 'bulk-order' && (
            <BulkOrderPage tradeToken={tradeToken} addToCart={addToCart} goTradeDashboard={goTradeDashboard} showToast={showToast} />
          )}

          {view === 'visit-recap' && visitRecapToken && (
            <VisitRecapPage token={visitRecapToken} onSkuClick={goSkuDetail} />
          )}

          {view === 'reset-password' && (
            <ResetPasswordPage goHome={goHome} openLogin={() => { setAuthModalMode('login'); setShowAuthModal(true); }} />
          )}

          {view === 'installation' && (
            <InstallationPage onRequestQuote={() => { setInstallModalProduct(null); setShowInstallModal(true); }} />
          )}

          {view === 'inspiration' && (
            <InspirationPage navigate={navigate} goBrowse={goBrowse} />
          )}

          {view === 'sale' && (
            <SalePage onSkuClick={goSkuDetail} wishlist={wishlist} toggleWishlist={toggleWishlist} setQuickViewSku={setQuickViewSku} navigate={navigate} />
          )}

          {view === 'coming-soon' && (
            <div style={{ maxWidth: 600, margin: '6rem auto', textAlign: 'center', padding: '0 2rem' }}>
              <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 300, fontSize: '2.5rem', marginBottom: '1rem' }}>{comingSoonTitle}</h1>
              <p style={{ color: 'var(--stone-500)', fontSize: '1.125rem', lineHeight: 1.6, marginBottom: '2rem' }}>
                This page is coming soon. We're working on something beautiful.
              </p>
              <button className="btn" onClick={goHome}>Back to Home</button>
            </div>
          )}

          {/* Cart Drawer */}
          <CartDrawer
            cart={cart} open={cartDrawerOpen} onClose={() => setCartDrawerOpen(false)}
            removeFromCart={removeFromCart} goCart={goCart}
          />

          {/* Quick View Modal */}
          {quickViewSku && (
            <QuickViewModal sku={quickViewSku} onClose={() => setQuickViewSku(null)} addToCart={addToCart} onViewDetail={(id, name) => { setQuickViewSku(null); goSkuDetail(id, name); }} />
          )}

          {/* Mobile Nav Drawer */}
          <MobileNav open={mobileNavOpen} onClose={() => setMobileNavOpen(false)}
            categories={categories} onCategorySelect={(slug) => { handleCategorySelect(slug); setView('browse'); }}
            globalFacets={globalFacets} onAxisSelect={handleAxisSelect}
            goHome={goHome} goBrowse={goBrowse} goCollections={goCollections} goTrade={goTrade}
            goAccount={() => { if (customer) goAccount(); else { setAuthModalMode('login'); setShowAuthModal(true); } }}
            customer={customer} tradeCustomer={tradeCustomer}
            onTradeClick={() => { setTradeModalMode('login'); setShowTradeModal(true); }}
            onCustomerLogout={handleCustomerLogout} onTradeLogout={handleTradeLogout}
          />

          {/* Mobile Search Overlay */}
          <MobileSearchOverlay open={mobileSearchOpen} onClose={() => setMobileSearchOpen(false)}
            onSearch={handleSearch} onSkuClick={goSkuDetail} onCategorySelect={handleCategorySelect}
          />

          {showTradeModal && <TradeModal onClose={() => setShowTradeModal(false)} onLogin={handleTradeLogin} initialMode={tradeModalMode} />}
          {showAuthModal && <CustomerAuthModal onClose={() => setShowAuthModal(false)} onLogin={handleCustomerLogin} initialMode={authModalMode} />}
          {showInstallModal && <InstallationModal onClose={() => setShowInstallModal(false)} product={installModalProduct} />}
          {showFloorQuiz && <FloorQuizModal onClose={() => setShowFloorQuiz(false)} onSkuClick={goSkuDetail} onViewAll={(qs) => { navigate('/shop?' + qs); }} />}

          <SiteFooter goHome={goHome} goBrowse={goBrowse} goCollections={goCollections} goTrade={goTrade}
            onInstallClick={goInstallation} />

          <nav className="mobile-bottom-nav">
            <button className={'mobile-bottom-nav-item' + (view === 'home' ? ' active' : '')} onClick={goHome}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
              Home
            </button>
            <button className={'mobile-bottom-nav-item' + (view === 'browse' ? ' active' : '')} onClick={() => setMobileSearchOpen(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              Search
            </button>
            <button className="mobile-bottom-nav-item" onClick={() => setCartDrawerOpen(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
              {cart.length > 0 && <span className="mobile-bottom-nav-badge">{cart.length}</span>}
              Cart
            </button>
            <button className={'mobile-bottom-nav-item' + (view === 'account' ? ' active' : '')} onClick={customer ? goAccount : () => { setAuthModalMode('login'); setShowAuthModal(true); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              Account
            </button>
          </nav>

          <BackToTop />
          <ToastContainer toasts={toasts} />
        </>
      );
    }

    // ==================== Header (4-Row) ====================

    function Header({ goHome, goBrowse, cart, cartDrawerOpen, setCartDrawerOpen, cartFlash, onSearch, onSkuClick, tradeCustomer, onTradeClick, onTradeLogout, customer, onAccountClick, onCustomerLogout, wishlistCount, goWishlist, goCollections, categories, onCategorySelect, globalFacets, onAxisSelect, mobileNavOpen, setMobileNavOpen, mobileSearchOpen, setMobileSearchOpen, view, navigate, goSale }) {
      const [searchInput, setSearchInput] = useState('');
      const [suggestData, setSuggestData] = useState({ categories: [], collections: [], products: [], total: 0 });
      const [showSuggestions, setShowSuggestions] = useState(false);
      const [activeIdx, setActiveIdx] = useState(-1);
      const [popularSearches, setPopularSearches] = useState([]);
      const [recentSearches, setRecentSearches] = useState(() => getRecentSearches());
      const [suggestLoading, setSuggestLoading] = useState(false);
      const [materialHover, setMaterialHover] = useState(null);
      const [condensed, setCondensed] = useState(false);
      const suggestTimerRef = useRef(null);
      const abortRef = useRef(null);
      const preArrowInputRef = useRef(null);
      const searchWrapRef = useRef(null);
      const materialTimerRef = useRef(null);
      const lastScrollY = useRef(0);
      const itemCount = cart.length;

      // Fetch popular searches once on mount
      useEffect(() => {
        fetch(API + '/api/storefront/search/popular').then(r => r.json()).then(d => setPopularSearches(d.terms || [])).catch(() => {});
      }, []);

      const handleMaterialEnter = (slug) => { clearTimeout(materialTimerRef.current); setMaterialHover(slug); };
      const handleMaterialLeave = () => { materialTimerRef.current = setTimeout(() => setMaterialHover(null), 120); };

      // Build flat list of all suggest items for keyboard navigation
      const suggestItems = useMemo(() => {
        const items = [];
        if (!searchInput) {
          recentSearches.forEach(t => items.push({ type: 'recent', data: { term: t } }));
          popularSearches.forEach(t => items.push({ type: 'popular', data: { term: t } }));
        } else {
          suggestData.categories.forEach(c => items.push({ type: 'category', data: c }));
          suggestData.collections.forEach(c => items.push({ type: 'collection', data: c }));
          suggestData.products.forEach(p => items.push({ type: 'product', data: p }));
        }
        return items;
      }, [suggestData, searchInput, recentSearches, popularSearches]);

      const fetchSuggestions = useCallback((q) => {
        clearTimeout(suggestTimerRef.current);
        if (abortRef.current) abortRef.current.abort();
        if (!q || q.length < 2) { setSuggestData({ categories: [], collections: [], products: [], total: 0 }); setShowSuggestions(false); setSuggestLoading(false); return; }
        setSuggestLoading(true);
        suggestTimerRef.current = setTimeout(async () => {
          const controller = new AbortController();
          abortRef.current = controller;
          try {
            const res = await fetch(API + '/api/storefront/search/suggest?q=' + encodeURIComponent(q), { signal: controller.signal });
            const data = await res.json();
            if (!controller.signal.aborted) {
              setSuggestData(data);
              setShowSuggestions(true);
              setActiveIdx(-1);
              setSuggestLoading(false);
            }
          } catch(e) { if (e.name !== 'AbortError') setSuggestData({ categories: [], collections: [], products: [], total: 0 }); }
        }, 300);
      }, []);

      const handleSearchInput = (e) => { preArrowInputRef.current = null; setActiveIdx(-1); setSearchInput(e.target.value); fetchSuggestions(e.target.value); };
      const selectSuggestion = (item) => {
        setShowSuggestions(false); setSearchInput(''); setSuggestData({ categories: [], collections: [], products: [], total: 0 });
        if (item.type === 'recent' || item.type === 'popular') { addRecentSearch(item.data.term); setRecentSearches(getRecentSearches()); onSearch(item.data.term); }
        else if (item.type === 'category') { addRecentSearch(item.data.name); setRecentSearches(getRecentSearches()); onCategorySelect(item.data.slug); }
        else if (item.type === 'collection') { addRecentSearch(item.data.name); setRecentSearches(getRecentSearches()); onSearch(item.data.name); }
        else if (item.type === 'product') { addRecentSearch(item.data.product_name || item.data.collection); setRecentSearches(getRecentSearches()); onSkuClick(item.data.sku_id, item.data.product_name || item.data.collection); }
      };

      const getItemLabel = (item) => {
        if (!item) return '';
        if (item.type === 'recent' || item.type === 'popular') return item.data.term;
        if (item.type === 'category') return item.data.name;
        if (item.type === 'collection') return item.data.name;
        if (item.type === 'product') return fullProductName(item.data);
        return '';
      };
      const handleSearchKeyDown = (e) => {
        const totalItems = suggestItems.length;
        if (!showSuggestions || totalItems === 0) return;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (preArrowInputRef.current === null) preArrowInputRef.current = searchInput;
          setActiveIdx(i => {
            const next = Math.min(i + 1, totalItems - 1);
            setSearchInput(getItemLabel(suggestItems[next]));
            return next;
          });
          setTimeout(() => { const el = searchWrapRef.current && searchWrapRef.current.querySelector('.active'); if (el) el.scrollIntoView({ block: 'nearest' }); }, 0);
        }
        else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActiveIdx(i => {
            const next = Math.max(i - 1, -1);
            setSearchInput(next === -1 ? (preArrowInputRef.current || '') : getItemLabel(suggestItems[next]));
            if (next === -1) preArrowInputRef.current = null;
            return next;
          });
          setTimeout(() => { const el = searchWrapRef.current && searchWrapRef.current.querySelector('.active'); if (el) el.scrollIntoView({ block: 'nearest' }); }, 0);
        }
        else if (e.key === 'Enter' && activeIdx >= 0) { e.preventDefault(); preArrowInputRef.current = null; selectSuggestion(suggestItems[activeIdx]); }
        else if (e.key === 'Escape') { setShowSuggestions(false); if (preArrowInputRef.current !== null) { setSearchInput(preArrowInputRef.current); preArrowInputRef.current = null; } }
      };

      useEffect(() => {
        const handleClickOutside = (e) => {
          if (searchWrapRef.current && !searchWrapRef.current.contains(e.target)) setShowSuggestions(false);
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
      }, []);

      useEffect(() => {
        const onScroll = () => {
          const y = window.scrollY;
          const delta = y - lastScrollY.current;
          if (y > 80 && delta > 5) {
            setCondensed(true);
          } else if (delta < -5 || y <= 10) {
            setCondensed(false);
          }
          lastScrollY.current = y;
        };
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => window.removeEventListener('scroll', onScroll);
      }, []);

      const parentCats = categories.filter(c => !c.parent_id && c.product_count > 0);

      const hasSuggestResults = suggestData.categories.length > 0 || suggestData.collections.length > 0 || suggestData.products.length > 0;
      let suggestItemIdx = 0;

      const searchForm = (
        <form className="header-search" ref={searchWrapRef} onSubmit={(e) => { e.preventDefault(); const q = searchInput.trim(); if (q) { addRecentSearch(q); setRecentSearches(getRecentSearches()); onSearch(q); setShowSuggestions(false); setSearchInput(''); } }}>
          <button type="submit" className="header-search-icon" tabIndex={-1} aria-label="Search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </button>
          <input type="text" placeholder="Search products..." value={searchInput} autoComplete="off" onChange={handleSearchInput} onKeyDown={handleSearchKeyDown} onFocus={() => {
            if (hasSuggestResults || (!searchInput && (popularSearches.length > 0 || recentSearches.length > 0))) setShowSuggestions(true);
          }} />
          {searchInput && (
            <button type="button" className="header-search-clear" onClick={() => { setSearchInput(''); setSuggestData({ categories: [], collections: [], products: [], total: 0 }); setShowSuggestions(false); }} aria-label="Clear search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          )}
          {showSuggestions && !searchInput && (recentSearches.length > 0 || popularSearches.length > 0) && (
            <div className="search-suggestions">
              {recentSearches.length > 0 && (
                <div className="search-suggest-section">
                  <div className="search-suggest-label">
                    Recent Searches
                    <button className="search-recent-clear" onClick={(e) => { e.stopPropagation(); clearRecentSearches(); setRecentSearches([]); }}>Clear</button>
                  </div>
                  <div className="search-suggest-popular">
                    {recentSearches.map((term) => {
                      const idx = suggestItemIdx++;
                      return (
                        <div key={term} className={'search-suggest-popular-item' + (idx === activeIdx ? ' active' : '')} onClick={() => { addRecentSearch(term); setRecentSearches(getRecentSearches()); onSearch(term); setShowSuggestions(false); setSearchInput(''); }}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                          {term}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {popularSearches.length > 0 && (
                <div className="search-suggest-section">
                  <div className="search-suggest-label">Popular Searches</div>
                  <div className="search-suggest-popular">
                    {popularSearches.map((term) => {
                      const idx = suggestItemIdx++;
                      return (
                        <div key={term} className={'search-suggest-popular-item' + (idx === activeIdx ? ' active' : '')} onClick={() => { addRecentSearch(term); setRecentSearches(getRecentSearches()); onSearch(term); setShowSuggestions(false); setSearchInput(''); }}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
                          {term}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
          {showSuggestions && suggestLoading && searchInput && !hasSuggestResults && (
            <div className="search-suggestions">
              <div className="search-suggest-loading">
                <div className="search-suggest-loading-dots"><span /><span /><span /></div>
                Searching...
              </div>
            </div>
          )}
          {showSuggestions && !hasSuggestResults && !suggestLoading && searchInput && searchInput.length >= 2 && suggestData.didYouMean && (
            <div className="search-suggestions">
              <div className="search-suggest-section">
                <div className="search-did-you-mean" onClick={() => { onSearch(suggestData.didYouMean); setShowSuggestions(false); setSearchInput(''); }}>
                  Did you mean: <strong>{suggestData.didYouMean}</strong>?
                </div>
              </div>
            </div>
          )}
          {showSuggestions && hasSuggestResults && (
            <div className="search-suggestions">
              {suggestData.expandedFrom && (
                <div className="search-expanded-indicator">
                  Showing results for <strong>{suggestData.expandedTo ? suggestData.expandedTo.split(' ').slice(0, 4).join(' ') : suggestData.expandedFrom}</strong>
                </div>
              )}
              {suggestData.categories.length > 0 && (
                <div className="search-suggest-section">
                  <div className="search-suggest-label">Categories</div>
                  {suggestData.categories.map(cat => {
                    const idx = suggestItemIdx++;
                    return (
                      <div key={cat.slug} className={'search-suggest-item' + (idx === activeIdx ? ' active' : '')} onClick={() => selectSuggestion({ type: 'category', data: cat })}>
                        <span className="search-suggest-item-icon">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                        </span>
                        <span className="search-suggest-category-text">{highlightMatch(cat.name, searchInput)}</span>
                        <span className="search-suggest-count">{cat.product_count} products</span>
                      </div>
                    );
                  })}
                </div>
              )}
              {suggestData.collections.length > 0 && (
                <div className="search-suggest-section">
                  <div className="search-suggest-label">Collections</div>
                  {suggestData.collections.map(col => {
                    const idx = suggestItemIdx++;
                    return (
                      <div key={col.name} className={'search-suggest-item' + (idx === activeIdx ? ' active' : '')} onClick={() => selectSuggestion({ type: 'collection', data: col })}>
                        {col.image ? <img className="search-suggest-collection-img" src={optimizeImg(col.image, 100)} alt="" decoding="async" loading="lazy" width={48} height={48} /> : <span className="search-suggest-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg></span>}
                        <div className="search-suggest-collection-text">
                          <div className="search-suggest-collection-name">{highlightMatch(col.name, searchInput)}</div>
                        </div>
                        <span className="search-suggest-count">{col.product_count} products</span>
                      </div>
                    );
                  })}
                </div>
              )}
              {suggestData.products.length > 0 && (
                <div className="search-suggest-section">
                  <div className="search-suggest-label">Products</div>
                  {suggestData.products.map(sku => {
                    const idx = suggestItemIdx++;
                    return (
                      <div key={sku.sku_id} className={'search-suggestion' + (idx === activeIdx ? ' active' : '')} onClick={() => selectSuggestion({ type: 'product', data: sku })}>
                        <div className="search-suggestion-img">{sku.primary_image ? <img src={optimizeImg(sku.primary_image, 100)} alt="" decoding="async" loading="lazy" width={48} height={48} /> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 24, height: 24, color: 'var(--stone-300)' }}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>}</div>
                        <div className="search-suggestion-text">
                          <div className="search-suggestion-name">{highlightMatch(fullProductName(sku), searchInput)}</div>
                          {sku.vendor_name && <div className="search-suggestion-vendor">{sku.vendor_name}</div>}
                          {sku.variant_name && <div className="search-suggestion-variant">{formatCarpetValue(sku.variant_name)}</div>}
                          {tradeCustomer && sku.vendor_sku && <div className="search-suggestion-sku">SKU: {sku.vendor_sku}</div>}
                        </div>
                        <span className="search-suggestion-price">${displayPrice(sku, sku.retail_price).toFixed(2)}{priceSuffix(sku)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="search-suggest-footer" onClick={() => { const q = searchInput.trim(); if (q) { addRecentSearch(q); setRecentSearches(getRecentSearches()); } onSearch(q); setShowSuggestions(false); setSearchInput(''); }}>
                View all {suggestData.total} results
              </div>
            </div>
          )}
        </form>
      );

      return (
        <header className={condensed ? 'header-condensed' : ''}>
          {/* Row 1 — Utility Bar */}
          <div className="utility-bar">
            <div className="utility-bar-inner">
              <div className="utility-bar-left">
                <a href="tel:+17149990009" className="utility-bar-phone">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
                  (714) 999-0009
                </a>
                <span className="utility-bar-dot">&bull;</span>
                <span>Anaheim, CA Showroom</span>
              </div>
              <div className="utility-bar-right">
                <button onClick={onTradeClick}>
                  {tradeCustomer ? `Trade: ${tradeCustomer.company_name}` : 'Trade Program'}
                </button>
                <span className="utility-bar-dot">&bull;</span>
                <button onClick={onAccountClick}>
                  {customer ? `Hi, ${customer.first_name}` : 'Sign In'}
                </button>
              </div>
            </div>
          </div>

          {/* Row 2 — Logo Bar (grid: 1fr auto 1fr) */}
          <div className="header-main">
            <div className="header-main-left">
              <button className="mobile-menu-btn" aria-label="Open navigation menu" onClick={() => setMobileNavOpen(true)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
              </button>
              {searchForm}
            </div>
            <div className="logo" onClick={goHome}>
              <img src="/assets/logo/roma-transparent.png" alt="Roma Flooring Designs" width="120" height="38" decoding="async" />
            </div>
            <div className="header-main-right">
              <button className="mobile-search-btn" aria-label="Search products" onClick={() => setMobileSearchOpen(true)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </button>
              <button className="header-action-btn" onClick={onAccountClick} aria-label="Account" title={customer ? customer.first_name : 'Account'}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              </button>
              <button className="header-action-btn wishlist-header-wrap" aria-label="Wishlist" onClick={goWishlist}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/>
                </svg>
                {wishlistCount > 0 && <span className="wishlist-badge">{wishlistCount}</span>}
              </button>
              <button className={'header-action-btn' + (cartFlash ? ' cart-flash' : '')} aria-label="Shopping cart" onClick={() => setCartDrawerOpen(true)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
                {itemCount > 0 && <span className="cart-badge">{itemCount}</span>}
              </button>
            </div>
          </div>

          {/* Row 3 — General Sections Nav */}
          <div className="nav-row">
            <div className="nav-row-inner">
              <div className="nav-row-group">
                <button className="nav-row-link" onClick={goCollections}>Collections</button>
                <button className="nav-row-link" onClick={() => navigate('/shop?sort=newest')}>New Arrivals</button>
                <button className="nav-row-link" onClick={goSale}>Sale</button>
                <button className="nav-row-link" onClick={() => navigate('/shop?room=kitchen')}>Shop by Room</button>
              </div>
              <span className="nav-row-separator" />
              <div className="nav-row-group">
                <button className="nav-row-link" onClick={() => navigate('/inspiration')}>Inspiration</button>
                <button className="nav-row-link" onClick={() => navigate('/design-services')}>Design Services</button>
                <button className="nav-row-link" onClick={() => navigate('/installation')}>Installation</button>
                <button className="nav-row-link" onClick={onTradeClick}>Trade</button>
                <button className="nav-row-link" onClick={() => navigate('/about')}>About Us</button>
              </div>
            </div>
          </div>

          {/* Row 4 — Material Categories Bar */}
          <div className="material-bar">
            <div className="material-bar-inner">
              {parentCats.map(cat => {
                const children = categories.filter(c => c.parent_id === cat.id);
                const hasChildren = children.length > 0;
                return (
                  <div key={cat.slug} className="material-bar-item"
                    onMouseEnter={() => hasChildren && handleMaterialEnter(cat.slug)}
                    onMouseLeave={handleMaterialLeave}>
                    <button className="material-bar-link" onClick={() => onCategorySelect(cat.slug)}>
                      {cat.name}
                      {hasChildren && <span className="material-bar-chevron">&#9662;</span>}
                    </button>
                    {hasChildren && (
                      <div className={'material-dropdown' + (materialHover === cat.slug ? ' visible' : '')}
                        onMouseEnter={() => handleMaterialEnter(cat.slug)}
                        onMouseLeave={handleMaterialLeave}>
                        {children.map(child => (
                          <a key={child.slug} onClick={() => onCategorySelect(child.slug)}>{child.name}</a>
                        ))}
                        <a className="material-dropdown-viewall" onClick={() => onCategorySelect(cat.slug)}>View All {cat.name} &rarr;</a>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className={'mega-menu-scrim' + (materialHover ? ' visible' : '')} />
        </header>
      );
    }

    // ==================== Cart Drawer ====================

    function CartDrawer({ cart, open, onClose, removeFromCart, goCart }) {
      const itemCount = cart.length;
      const productItems = cart.filter(i => !i.is_sample);
      const sampleItems = cart.filter(i => i.is_sample);
      const cartTotal = productItems.reduce((sum, i) => sum + parseFloat(i.subtotal || 0), 0) + (sampleItems.length > 0 ? 12 : 0);

      useEffect(() => {
        document.body.style.overflow = open ? 'hidden' : '';
        return () => { document.body.style.overflow = ''; };
      }, [open]);

      return (
        <>
          <div className={'cart-drawer-overlay' + (open ? ' open' : '')} onClick={onClose} />
          <div className={'cart-drawer' + (open ? ' open' : '')}>
            <div className="cart-drawer-head">
              <h3>Cart ({itemCount})</h3>
              <button className="cart-drawer-close" onClick={onClose}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            {itemCount === 0 ? (
              <div className="cart-drawer-empty">Your cart is empty</div>
            ) : (
              <>
                <div className="cart-drawer-items">
                  {cart.map(item => (
                    <div key={item.id} className="cart-drawer-item">
                      <div className="cart-drawer-item-img">
                        {item.primary_image && <img src={optimizeImg(item.primary_image, 100)} alt="" decoding="async" loading="lazy" width={40} height={40} />}
                      </div>
                      <div className="cart-drawer-item-info">
                        <div className="cart-drawer-item-name">
                          {fullProductName(item) || 'Product'}
                          {item.is_sample && <span className="sample-tag">Sample</span>}
                        </div>
                        <div className="cart-drawer-item-meta">
                          {item.is_sample ? 'FREE SAMPLE' : item.sell_by === 'unit' ? `Qty: ${item.num_boxes}` : `${item.price_tier ? '' : item.num_boxes + ' box' + (parseInt(item.num_boxes) !== 1 ? 'es' : '') + ' · '}${parseFloat(item.sqft_needed || 0).toFixed(0)} sqft`}
                          {item.price_tier && (
                            <span style={{ display: 'inline-block', marginLeft: '0.375rem', padding: '0.0625rem 0.375rem', borderRadius: '0.1875rem', fontSize: '0.6875rem', fontWeight: 600, background: item.price_tier === 'roll' ? 'var(--sage, #6b9080)' : 'var(--stone-200)', color: item.price_tier === 'roll' ? 'white' : 'var(--stone-600)' }}>
                              {item.price_tier === 'roll' ? 'Roll' : 'Cut'}
                            </span>
                          )}
                        </div>
                        <div className="cart-drawer-item-bottom">
                          <span className="cart-drawer-item-price">{item.is_sample ? 'FREE' : '$' + parseFloat(item.subtotal).toFixed(2)}</span>
                          <button className="cart-drawer-item-remove" onClick={() => removeFromCart(item.id)}>Remove</button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="cart-drawer-footer">
                  <div className="cart-drawer-total"><span>Subtotal</span><span>${cartTotal.toFixed(2)}</span></div>
                  <button className="btn" style={{ width: '100%' }} onClick={() => { onClose(); goCart(); }}>View Cart & Checkout</button>
                </div>
              </>
            )}
          </div>
        </>
      );
    }

    // ==================== Quick View Modal ====================

    function QuickViewModal({ sku: initialSku, onClose, addToCart, onViewDetail }) {
      const [qty, setQty] = useState(1);
      const [activeSku, setActiveSku] = useState(initialSku);
      const [siblings, setSiblings] = useState([]);
      const [media, setMedia] = useState(initialSku.primary_image ? [{ url: initialSku.primary_image, asset_type: 'primary' }] : []);
      const [imgIndex, setImgIndex] = useState(0);
      const [loading, setLoading] = useState(true);
      const baseMediaRef = useRef(media);
      const isUnit = isSoldPerUnit(activeSku);

      const applyDetail = (data) => {
        if (data.redirect_to_sku || data.error || !data.sku) return;
        setActiveSku(data.sku);
        const allMedia = (data.media || []).filter(m => m.url);
        const resolved = allMedia.length > 0 ? allMedia : (data.sku.primary_image ? [{ url: data.sku.primary_image, asset_type: 'primary' }] : []);
        setMedia(resolved);
        baseMediaRef.current = resolved;
        setImgIndex(0);
        const colorSiblings = (data.same_product_siblings || []).filter(s => s.variant_type !== 'accessory' && s.primary_image);
        setSiblings(colorSiblings);
      };

      const getTradeHeaders = () => {
        const t = localStorage.getItem('trade_token');
        return t ? { 'X-Trade-Token': t } : {};
      };

      // Fetch full SKU detail with siblings + media
      useEffect(() => {
        let cancelled = false;
        setLoading(true);
        fetch('/api/storefront/skus/' + initialSku.sku_id, { headers: getTradeHeaders() })
          .then(r => r.json())
          .then(data => { if (!cancelled) applyDetail(data); })
          .catch(err => console.error('QuickView fetch error:', err))
          .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
      }, [initialSku.sku_id]);

      // Keyboard: Escape to close, arrows to slide
      useEffect(() => {
        const handleKey = (e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'ArrowLeft') setImgIndex(i => Math.max(0, i - 1));
          else if (e.key === 'ArrowRight') setImgIndex(i => Math.min(i + 1, media.length - 1));
        };
        document.addEventListener('keydown', handleKey);
        document.body.style.overflow = 'hidden';
        return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
      }, [media.length]);

      const handleAdd = () => {
        if (isUnit) {
          addToCart({ sku_id: activeSku.sku_id, num_boxes: qty, sell_by: 'unit' });
        }
        onClose();
      };

      const handleVariantHover = (sib) => {
        setMedia([{ url: sib.primary_image, asset_type: 'primary' }]);
        setImgIndex(0);
      };

      const handleVariantLeave = () => {
        setMedia(baseMediaRef.current);
        setImgIndex(0);
      };

      const handleVariantClick = (sib) => {
        // Immediately show sibling image, then fetch full detail
        setActiveSku(prev => ({ ...prev, sku_id: sib.sku_id, variant_name: sib.variant_name, retail_price: sib.retail_price, primary_image: sib.primary_image, sell_by: sib.sell_by, price_basis: sib.price_basis, sqft_per_box: sib.sqft_per_box }));
        fetch('/api/storefront/skus/' + sib.sku_id, { headers: getTradeHeaders() })
          .then(r => r.json())
          .then(data => applyDetail(data));
      };

      const currentImg = media[imgIndex] || {};

      return (
        <div className="quick-view-overlay" onClick={onClose}>
          <div className="quick-view" onClick={e => e.stopPropagation()}>
            <button className="quick-view-close" onClick={onClose}>&times;</button>
            <div className="quick-view-gallery">
              <div className="quick-view-main-image">
                {media.length > 1 && (
                  <button className="quick-view-gallery-arrow left" disabled={imgIndex === 0} onClick={() => setImgIndex(i => i - 1)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
                  </button>
                )}
                {currentImg.url && <img src={optimizeImg(currentImg.url, 800)} alt={activeSku.product_name} decoding="async" width={400} height={400} />}
                {media.length > 1 && (
                  <button className="quick-view-gallery-arrow right" disabled={imgIndex >= media.length - 1} onClick={() => setImgIndex(i => i + 1)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                  </button>
                )}
              </div>
              {media.length > 1 && (
                <div className="quick-view-gallery-dots">
                  {media.map((_, i) => (
                    <span key={i} className={i === imgIndex ? 'active' : ''} onClick={() => setImgIndex(i)} />
                  ))}
                </div>
              )}
              {siblings.length > 0 && (
                <div className="quick-view-variants">
                  {/* Current SKU as first swatch */}
                  <div
                    className={'quick-view-variant-swatch active'}
                    title={formatVariantName(activeSku.variant_name)}
                  >
                    {(baseMediaRef.current[0] || {}).url && <img src={optimizeImg(baseMediaRef.current[0].url, 120)} alt={activeSku.variant_name} decoding="async" width={64} height={64} />}
                  </div>
                  {siblings.map(sib => (
                    <div
                      key={sib.sku_id}
                      className="quick-view-variant-swatch"
                      title={formatVariantName(sib.variant_name)}
                      onMouseEnter={() => handleVariantHover(sib)}
                      onMouseLeave={handleVariantLeave}
                      onClick={() => handleVariantClick(sib)}
                    >
                      {sib.primary_image && <img src={optimizeImg(sib.primary_image, 120)} alt={sib.variant_name} decoding="async" width={64} height={64} />}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="quick-view-info">
              <h2>{fullProductName(activeSku)}</h2>
              <div className="price">
                {activeSku.trade_price && activeSku.retail_price && (
                  <span style={{ textDecoration: 'line-through', color: 'var(--stone-500)', fontSize: '1rem', marginRight: '0.5rem' }}>
                    ${displayPrice(activeSku, activeSku.retail_price).toFixed(2)}
                  </span>
                )}
                {!activeSku.trade_price && activeSku.sale_price && activeSku.retail_price && (
                  <span className="sale-original-price">
                    ${displayPrice(activeSku, activeSku.retail_price).toFixed(2)}
                  </span>
                )}
                <span className={!activeSku.trade_price && activeSku.sale_price ? 'sale-price-text' : ''}>
                  ${displayPrice(activeSku, activeSku.trade_price || activeSku.sale_price || activeSku.retail_price || 0).toFixed(2)}
                </span>
                <span>{priceSuffix(activeSku)}</span>
                {!activeSku.trade_price && activeSku.sale_price && activeSku.retail_price && (
                  <span className="sale-discount-tag">{Math.round((1 - parseFloat(activeSku.sale_price) / parseFloat(activeSku.retail_price)) * 100)}% off</span>
                )}
              </div>
              {activeSku.description_short && (
                <p style={{ fontSize: '0.875rem', color: 'var(--stone-600)', lineHeight: 1.6, marginBottom: '1rem' }}>{activeSku.description_short}</p>
              )}
              <div className="quick-view-actions">
                {isUnit ? (
                  <>
                    <div className="unit-qty-stepper">
                      <button onClick={() => setQty(q => Math.max(1, q - 1))}>-</button>
                      <input type="number" value={qty} onChange={e => setQty(Math.max(1, parseInt(e.target.value) || 1))} />
                      <button onClick={() => setQty(q => q + 1)}>+</button>
                    </div>
                    <button className="btn" onClick={handleAdd}>Add to Cart</button>
                  </>
                ) : (
                  <p style={{ fontSize: '0.875rem', color: 'var(--stone-500)' }}>Use the coverage calculator on the detail page to add this item to your cart.</p>
                )}
                <button className="btn btn-secondary" onClick={() => onViewDetail(activeSku.sku_id, activeSku.product_name)}>View Full Details</button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // ==================== Mobile Nav Drawer ====================

    function MobileNav({ open, onClose, categories, onCategorySelect, globalFacets, onAxisSelect, goHome, goBrowse, goCollections, goTrade, goAccount, customer, tradeCustomer, onTradeClick, onCustomerLogout, onTradeLogout }) {
      const [expandedCat, setExpandedCat] = useState(null);
      const parentCats = categories.filter(c => !c.parent_id && c.product_count > 0);

      useEffect(() => {
        document.body.style.overflow = open ? 'hidden' : '';
        return () => { document.body.style.overflow = ''; };
      }, [open]);

      return (
        <>
          <div className={'mobile-nav-overlay' + (open ? ' open' : '')} onClick={onClose} />
          <nav className={'mobile-nav' + (open ? ' open' : '')}>
            <div className="mobile-nav-head">
              <span style={{ fontFamily: 'var(--font-heading)', fontSize: '1.25rem', fontWeight: 600 }}>Menu</span>
              <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '1.5rem', color: 'var(--stone-500)', cursor: 'pointer' }}>&times;</button>
            </div>
            <div className="mobile-nav-links">
              <a onClick={() => { goHome(); onClose(); }}>Home</a>
              <a onClick={() => { goBrowse(); onClose(); }}>Shop All</a>
              {parentCats.map(cat => {
                const children = categories.filter(c => c.parent_id === cat.id);
                if (children.length === 0) {
                  return <a key={cat.id} onClick={() => { onCategorySelect(cat.slug); onClose(); }}>{cat.name}</a>;
                }
                return (
                  <div key={cat.id} className="mobile-nav-cat-item">
                    <div className="mobile-nav-cat-header" onClick={() => setExpandedCat(expandedCat === cat.id ? null : cat.id)}>
                      <span>{cat.name}</span>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16, transform: expandedCat === cat.id ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}><polyline points="6 9 12 15 18 9"/></svg>
                    </div>
                    {expandedCat === cat.id && (
                      <div className="mobile-nav-cat-children">
                        <a onClick={() => { onCategorySelect(cat.slug); onClose(); }}>All {cat.name}</a>
                        {children.map(child => (
                          <a key={child.id} onClick={() => { onCategorySelect(child.slug); onClose(); }}>{child.name}</a>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              <a onClick={() => { goCollections(); onClose(); }}>Collections</a>
            </div>
            {!tradeCustomer && (
              <a className="mobile-nav-trade-cta" onClick={() => { onTradeClick(); onClose(); }}>Trade Program</a>
            )}
            <div className="mobile-nav-footer">
              {customer ? (
                <div>
                  <div style={{ fontSize: '0.8125rem', color: 'var(--stone-500)', marginBottom: '0.5rem' }}>Signed in as {customer.first_name || customer.email}</div>
                  <a onClick={() => { goAccount(); onClose(); }}>My Account</a>
                  <a onClick={() => { onCustomerLogout(); onClose(); }}>Sign Out</a>
                </div>
              ) : tradeCustomer ? (
                <div>
                  <div style={{ fontSize: '0.8125rem', color: 'var(--stone-500)', marginBottom: '0.5rem' }}>Trade: {tradeCustomer.company_name}</div>
                  <a onClick={() => { goTrade(); onClose(); }}>Trade Dashboard</a>
                  <a onClick={() => { onTradeLogout(); onClose(); }}>Sign Out</a>
                </div>
              ) : (
                <div>
                  <a onClick={() => { goAccount(); onClose(); }}>Sign In</a>
                </div>
              )}
            </div>
          </nav>
        </>
      );
    }

    // ==================== Mobile Search Overlay ====================

    function MobileSearchOverlay({ open, onClose, onSearch, onSkuClick, onCategorySelect }) {
      const [query, setQuery] = useState('');
      const [suggestData, setSuggestData] = useState({ categories: [], collections: [], products: [], total: 0 });
      const [loading, setLoading] = useState(false);
      const [mobileRecent, setMobileRecent] = useState([]);
      const [mobilePopular, setMobilePopular] = useState([]);
      const inputRef = useRef(null);
      const debounceRef = useRef(null);

      useEffect(() => {
        if (open) {
          if (inputRef.current) setTimeout(() => inputRef.current.focus(), 100);
          setMobileRecent(getRecentSearches());
          fetch(API + '/api/storefront/search/popular').then(r => r.json()).then(d => setMobilePopular(d.terms || [])).catch(() => {});
        }
        if (!open) { setQuery(''); setSuggestData({ categories: [], collections: [], products: [], total: 0 }); }
      }, [open]);

      useEffect(() => {
        if (!query || query.length < 2) { setSuggestData({ categories: [], collections: [], products: [], total: 0 }); return; }
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(async () => {
          setLoading(true);
          try {
            const res = await fetch(API + '/api/storefront/search/suggest?q=' + encodeURIComponent(query));
            const data = await res.json();
            setSuggestData(data);
          } catch { setSuggestData({ categories: [], collections: [], products: [], total: 0 }); }
          setLoading(false);
        }, 250);
      }, [query]);

      const handleSubmit = (e) => {
        e.preventDefault();
        if (query.trim()) { addRecentSearch(query.trim()); setMobileRecent(getRecentSearches()); onSearch(query.trim()); onClose(); }
      };

      const hasResults = suggestData.categories.length > 0 || suggestData.collections.length > 0 || suggestData.products.length > 0;

      return open ? (
        <div className="mobile-search-overlay">
          <div className="mobile-search-header">
            <form onSubmit={handleSubmit} style={{ flex: 1, display: 'flex', gap: '0.5rem', position: 'relative' }}>
              <input ref={inputRef} className="mobile-search-input" type="text" placeholder="Search products..." value={query} autoComplete="off" onChange={e => setQuery(e.target.value)} />
              {query && (
                <button type="button" className="header-search-clear" style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)' }} onClick={() => { setQuery(''); setSuggestData({ categories: [], collections: [], products: [], total: 0 }); }} aria-label="Clear search">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              )}
            </form>
            <button className="mobile-search-close" onClick={onClose}>Cancel</button>
          </div>
          {!query && (mobileRecent.length > 0 || mobilePopular.length > 0) && (
            <div className="mobile-search-results">
              {mobileRecent.length > 0 && (
                <div className="search-suggest-section">
                  <div className="search-suggest-label">
                    Recent Searches
                    <button className="search-recent-clear" onClick={() => { clearRecentSearches(); setMobileRecent([]); }}>Clear</button>
                  </div>
                  <div className="search-suggest-popular">
                    {mobileRecent.map(term => (
                      <div key={term} className="search-suggest-popular-item" onClick={() => { addRecentSearch(term); setMobileRecent(getRecentSearches()); onSearch(term); onClose(); }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        {term}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {mobilePopular.length > 0 && (
                <div className="search-suggest-section">
                  <div className="search-suggest-label">Popular Searches</div>
                  <div className="search-suggest-popular">
                    {mobilePopular.map(term => (
                      <div key={term} className="search-suggest-popular-item" onClick={() => { addRecentSearch(term); setMobileRecent(getRecentSearches()); onSearch(term); onClose(); }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
                        {term}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {!hasResults && !loading && query && query.length >= 2 && suggestData.didYouMean && (
            <div className="mobile-search-results">
              <div className="search-suggest-section">
                <div className="search-did-you-mean" onClick={() => { setQuery(suggestData.didYouMean); }}>
                  Did you mean: <strong>{suggestData.didYouMean}</strong>?
                </div>
              </div>
            </div>
          )}
          {hasResults && (
            <div className="mobile-search-results">
              {suggestData.expandedFrom && (
                <div className="search-expanded-indicator">
                  Showing results for <strong>{suggestData.expandedTo ? suggestData.expandedTo.split(' ').slice(0, 4).join(' ') : suggestData.expandedFrom}</strong>
                </div>
              )}
              {suggestData.categories.length > 0 && (
                <div className="search-suggest-section">
                  <div className="search-suggest-label">Categories</div>
                  {suggestData.categories.map(cat => (
                    <div key={cat.slug} className="search-suggest-item" onClick={() => { addRecentSearch(cat.name); onCategorySelect(cat.slug); onClose(); }}>
                      <span className="search-suggest-item-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                      </span>
                      <span className="search-suggest-category-text">{highlightMatch(cat.name, query)}</span>
                      <span className="search-suggest-count">{cat.product_count}</span>
                    </div>
                  ))}
                </div>
              )}
              {suggestData.collections.length > 0 && (
                <div className="search-suggest-section">
                  <div className="search-suggest-label">Collections</div>
                  {suggestData.collections.map(col => (
                    <div key={col.name} className="search-suggest-item" onClick={() => { addRecentSearch(col.name); onSearch(col.name); onClose(); }}>
                      {col.image ? <img className="search-suggest-collection-img" src={optimizeImg(col.image, 100)} alt="" decoding="async" loading="lazy" width={48} height={48} /> : <span className="search-suggest-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg></span>}
                      <div className="search-suggest-collection-text">
                        <div className="search-suggest-collection-name">{highlightMatch(col.name, query)}</div>
                      </div>
                      <span className="search-suggest-count">{col.product_count}</span>
                    </div>
                  ))}
                </div>
              )}
              {suggestData.products.length > 0 && (
                <div className="search-suggest-section">
                  <div className="search-suggest-label">Products</div>
                  {suggestData.products.map(sku => (
                    <div key={sku.sku_id} className="mobile-search-result" onClick={() => { addRecentSearch(sku.product_name || sku.collection); onSkuClick(sku.sku_id, sku.product_name); onClose(); }}>
                      <div className="mobile-search-result-img">
                        {sku.primary_image && <img src={optimizeImg(sku.primary_image, 100)} alt="" decoding="async" loading="lazy" width={48} height={48} />}
                      </div>
                      <div>
                        <div style={{ fontWeight: 500, fontSize: '0.875rem' }}>{highlightMatch(fullProductName(sku), query)}</div>
                        {sku.vendor_name && <div className="search-suggestion-vendor">{sku.vendor_name}</div>}
                        <div style={{ fontSize: '0.8125rem', color: 'var(--stone-500)' }}>${displayPrice(sku, sku.retail_price).toFixed(2)}{priceSuffix(sku)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {suggestData.total > 0 && (
                <div className="search-suggest-footer" onClick={() => { const q = query.trim(); if (q) { addRecentSearch(q); } onSearch(q); onClose(); }}>
                  View all {suggestData.total} results
                </div>
              )}
            </div>
          )}
          {loading && (
            <div style={{ padding: '0.5rem 1rem' }}>
              {[0, 1, 2].map(i => (
                <div key={i} className="skeleton-search-result">
                  <div className="skeleton-search-img" />
                  <div className="skeleton-search-lines">
                    <div className="skeleton-bar skeleton-bar-short" style={{ marginTop: 0 }} />
                    <div className="skeleton-bar skeleton-bar-medium" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null;
    }

    // ==================== Category Carousel ====================

    function CategoryCarousel({ categories, onCategorySelect }) {
      const trackRef = useRef(null);
      const [index, setIndex] = useState(0);
      const [visible, setVisible] = useState(4);

      useEffect(() => {
        const update = () => {
          const w = window.innerWidth;
          setVisible(w <= 480 ? 1 : w <= 768 ? 2 : w <= 968 ? 3 : 4);
        };
        update();
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
      }, []);

      const maxIndex = Math.max(0, categories.length - visible);
      const clamped = Math.min(index, maxIndex);

      useEffect(() => {
        if (!trackRef.current) return;
        const tile = trackRef.current.children[0];
        if (!tile) return;
        const gap = 24;
        const tileW = tile.offsetWidth + gap;
        trackRef.current.scrollTo({ left: clamped * tileW, behavior: 'smooth' });
      }, [clamped, visible]);

      const go = (dir) => setIndex(i => Math.max(0, Math.min(i + dir, maxIndex)));

      return (
        <div className="category-carousel">
          <button className="carousel-arrow carousel-arrow-left" disabled={clamped === 0} onClick={() => go(-1)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div className="category-carousel-track" ref={trackRef}>
            {categories.map(cat => (
              <div key={cat.slug} className="category-tile" onClick={() => onCategorySelect(cat.slug)}>
                {cat.image_url && <img src={optimizeImg(cat.image_url, 400)} alt={cat.name} loading="lazy" decoding="async" />}
                <div className="category-tile-overlay">
                  <span className="category-tile-name">{cat.name}</span>
                  <span className="category-tile-count">{cat.product_count} products</span>
                </div>
              </div>
            ))}
          </div>
          <button className="carousel-arrow carousel-arrow-right" disabled={clamped >= maxIndex} onClick={() => go(1)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
          {maxIndex > 0 && (
            <div className="carousel-dots">
              {Array.from({ length: maxIndex + 1 }, (_, i) => (
                <button key={i} className={'carousel-dot' + (i === clamped ? ' active' : '')} onClick={() => setIndex(i)} />
              ))}
            </div>
          )}
        </div>
      );
    }

    // ==================== Home Page ====================

    function HomePage({ featuredSkus, featuredLoading, categories, onSkuClick, onCategorySelect, goBrowse, goTrade, navigate, wishlist, toggleWishlist, setQuickViewSku, newsletterEmail, setNewsletterEmail, newsletterSubmitted, onNewsletterSubmit, onOpenQuiz }) {
      const parentCats = categories.filter(c => !c.parent_id && c.product_count > 0);
      const topCats = parentCats.slice(0, 6);
      const heroRef = useRef(null);

      useEffect(() => {
        const timer = setTimeout(() => {
          if (heroRef.current) heroRef.current.classList.add('loaded');
        }, 100);
        return () => clearTimeout(timer);
      }, []);

      const looks = [
        { name: 'Modern Minimalist', slug: 'modern-minimalist', image: '/uploads/looks/modern-minimalist.jpg' },
        { name: 'Warm Mediterranean', slug: 'warm-mediterranean', image: '/uploads/looks/warm-mediterranean.jpg' },
        { name: 'Coastal Retreat', slug: 'coastal-retreat', image: '/uploads/looks/coastal-retreat.jpg' },
        { name: 'Classic Elegance', slug: 'classic-elegance', image: '/uploads/looks/classic-elegance.jpg' },
      ];

      const inspoImages = [
        { src: '/uploads/inspo/kitchen.jpg', label: 'Kitchen' },
        { src: '/uploads/inspo/living-room.jpg', label: 'Living Room', tall: true },
        { src: '/uploads/inspo/bathroom.jpg', label: 'Bathroom' },
        { src: '/uploads/inspo/bedroom.jpg', label: 'Bedroom' },
        { src: '/uploads/inspo/outdoor.jpg', label: 'Outdoor' },
      ];

      return (
        <>
          <section className="hero" ref={heroRef}>
            <div className="hero-bg" style={{ backgroundImage: 'url(/uploads/hero-bg.jpg?v=2)' }} />
            <div className="hero-content">
              <h1>Redefine Your Space</h1>
              <button className="hero-cta" onClick={goBrowse}>Explore Our Floors</button>
            </div>
          </section>

          <RevealSection>
            <div className="trust-strip">
              <div className="trust-strip-inner">
                <div className="trust-strip-item">
                  <div className="trust-strip-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a4 4 0 00-8 0v2"/></svg>
                  </div>
                  <div className="trust-strip-text">Free Samples<span>Try before you buy</span></div>
                </div>
                <div className="trust-strip-item">
                  <div className="trust-strip-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/><circle cx="12" cy="12" r="5"/></svg>
                  </div>
                  <div className="trust-strip-text">Trade Pricing<span>Exclusive pro discounts</span></div>
                </div>
                <div className="trust-strip-item">
                  <div className="trust-strip-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
                  </div>
                  <div className="trust-strip-text">Expert Guidance<span>Design consultation available</span></div>
                </div>
                <div className="trust-strip-item">
                  <div className="trust-strip-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1" y="3" width="15" height="13" rx="1"/><polyline points="16 8 20 8 23 11 23 16 20 16"/><circle cx="18" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>
                  </div>
                  <div className="trust-strip-text">Fast Shipping<span>Direct from warehouse</span></div>
                </div>
              </div>
            </div>
          </RevealSection>

          {topCats.length > 0 && (
            <RevealSection>
              <section className="homepage-section">
                <h2>Shop by Category</h2>
                <p className="subtitle">Explore our curated selection of premium surfaces</p>
                <div className="homepage-cat-grid">
                  {topCats.map(cat => (
                    <div key={cat.slug} className="homepage-cat-tile" onClick={() => onCategorySelect(cat.slug)}>
                      {cat.image_url && <img src={optimizeImg(cat.image_url, 400)} alt={cat.name} loading="lazy" decoding="async" />}
                      <div className="homepage-cat-tile-overlay">
                        <span className="homepage-cat-tile-name">{cat.name}</span>
                        <span className="homepage-cat-tile-cta">Shop Now &rarr;</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </RevealSection>
          )}

          <RevealSection delay={0.1}>
            <section className="homepage-featured-band">
              <div className="homepage-section">
                <h2>Featured Products</h2>
                <p className="subtitle">Our most popular floors, chosen by customers like you</p>
                {featuredLoading ? (
                  <SkeletonGrid count={8} />
                ) : featuredSkus.length > 0 ? (
                  <SkuGrid skus={featuredSkus} onSkuClick={onSkuClick} wishlist={wishlist} toggleWishlist={toggleWishlist} setQuickViewSku={setQuickViewSku} />
                ) : (
                  <p style={{ textAlign: 'center', color: 'var(--stone-500)', padding: '2rem 0' }}>Featured products coming soon.</p>
                )}
              </div>
            </section>
          </RevealSection>

          <RevealSection delay={0.1}>
            <section className="homepage-section">
              <h2>Shop the Look</h2>
              <p className="subtitle">Curated collections for every style</p>
              <div className="looks-grid">
                {looks.map(look => (
                  <div key={look.slug} className="look-card" onClick={() => navigate('/shop?collection=' + look.slug)}>
                    <img src={optimizeImg(look.image, 400)} alt={look.name} loading="lazy" decoding="async" />
                    <div className="look-card-overlay">
                      <span className="look-card-name">{look.name}</span>
                      <span className="look-card-cta">Explore &rarr;</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </RevealSection>

          <RevealSection delay={0.1}>
            <section className="homepage-section">
              <h2>Get Inspired</h2>
              <p className="subtitle">Real spaces, real transformations</p>
              <div className="inspo-gallery">
                {inspoImages.map((img, i) => (
                  <div key={i} className={'inspo-gallery-item' + (img.tall ? ' tall' : '')} onClick={() => navigate('/shop?room=' + img.label.toLowerCase().replace(/\s+/g, '-'))}>
                    <img src={optimizeImg(img.src, 400)} alt={img.label} loading="lazy" decoding="async" />
                    <div className="inspo-gallery-overlay">
                      <span className="inspo-gallery-label">{img.label}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </RevealSection>

          <RevealSection delay={0.1}>
            <div className="homepage-cta-duo">
              <div className="cta-card cta-card-dark">
                <div className="cta-card-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
                </div>
                <h3>Room Visualizer</h3>
                <p>See how our floors look in your space before you buy. Upload a photo and preview any product.</p>
                <button className="btn-outline" onClick={() => { if (window.roomvo && typeof window.roomvo.startStandaloneVisualizer === 'function') { window.roomvo.startStandaloneVisualizer(); } else { window.location.href = '/shop'; } }}>Try It Now</button>
              </div>
              <div className="cta-card cta-card-light">
                <div className="cta-card-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                </div>
                <h3>Find Your Floor</h3>
                <p>Answer a few quick questions and we'll recommend the perfect flooring for your space and style.</p>
                <button className="btn-outline" onClick={onOpenQuiz}>Take the Quiz</button>
              </div>
            </div>
          </RevealSection>

          <RevealSection delay={0.1}>
            <section className="homepage-section">
              <h2>How We Help</h2>
              <p className="subtitle">From selection to installation, we're with you every step</p>
              <div className="services-grid">
                <div className="service-card" onClick={() => navigate('/design-services')}>
                  <div className="service-card-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>
                  </div>
                  <h4>Design Consultation</h4>
                  <p>Work with our team to find the perfect material and style for your project</p>
                </div>
                <div className="service-card" onClick={goBrowse}>
                  <div className="service-card-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a4 4 0 00-8 0v2"/></svg>
                  </div>
                  <h4>Free Samples</h4>
                  <p>Order up to 5 free samples and experience the quality in your own home</p>
                </div>
                <div className="service-card" onClick={() => navigate('/installation')}>
                  <div className="service-card-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>
                  </div>
                  <h4>Professional Installation</h4>
                  <p>Licensed installers with years of experience to ensure a perfect finish</p>
                </div>
                <div className="service-card" onClick={goTrade}>
                  <div className="service-card-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
                  </div>
                  <h4>Trade Program</h4>
                  <p>Exclusive pricing and dedicated support for contractors and designers</p>
                </div>
              </div>
            </section>
          </RevealSection>

          <RevealSection delay={0.15}>
            <section className="homepage-trade-band">
              <h2>Trade Professional?</h2>
              <p>Exclusive pricing, dedicated support, and tools built for the trade. Join our professional program.</p>
              <button className="btn" onClick={goTrade}>Learn More</button>
            </section>
          </RevealSection>

          <RevealSection delay={0.1}>
            <section className="newsletter-band">
              <h2>Stay in the Know</h2>
              <p className="subtitle">New arrivals, design tips, and exclusive offers delivered to your inbox</p>
              {newsletterSubmitted ? (
                <p className="newsletter-success">Thank you for subscribing! Check your inbox for a welcome email.</p>
              ) : (
                <form className="newsletter-form" onSubmit={onNewsletterSubmit}>
                  <input type="email" placeholder="Enter your email" value={newsletterEmail} onChange={(e) => setNewsletterEmail(e.target.value)} required />
                  <button type="submit">Subscribe</button>
                </form>
              )}
            </section>
          </RevealSection>
        </>
      );
    }

    // ==================== Search Empty State ====================

    function SearchEmptyState({ searchQuery, categories, onSearch, onCategorySelect, didYouMean, popularTerms }) {
      const fallbackTerms = ['porcelain tile', 'hardwood', 'luxury vinyl', 'mosaic', 'marble', 'carpet'];
      const suggestedTerms = (popularTerms && popularTerms.length > 0) ? popularTerms.slice(0, 6) : fallbackTerms;
      return (
        <div className="search-empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <h2>No results for "{searchQuery}"</h2>
          {didYouMean && (
            <p className="search-empty-did-you-mean">
              Did you mean: <button className="search-empty-dym-link" onClick={() => onSearch(didYouMean)}>{didYouMean}</button>?
            </p>
          )}
          <p>We couldn't find any products matching your search. Try one of these:</p>
          <div className="search-empty-suggestions">
            {suggestedTerms.map(term => (
              <button key={term} className="search-empty-chip" onClick={() => onSearch(term)}>{term}</button>
            ))}
          </div>
          <p className="search-empty-browse">Or browse by category:</p>
          <div className="search-empty-categories">
            {categories.filter(c => !c.parent_id && c.product_count > 0).slice(0, 6).map(cat => (
              <button key={cat.slug} className="search-empty-cat-chip" onClick={() => onCategorySelect(cat.slug)}>
                {cat.name}
              </button>
            ))}
          </div>
        </div>
      );
    }

    // ==================== Category Hero ====================

    function CategoryHero({ category, crumbs, searchQuery, totalSkus }) {
      if (searchQuery) {
        return (
          <div className="category-hero" style={{ height: '160px' }}>
            <Breadcrumbs items={crumbs} />
            <h1>Search: "{searchQuery}"</h1>
            {totalSkus > 0 && <p className="search-result-count">{totalSkus} result{totalSkus !== 1 ? 's' : ''}</p>}
          </div>
        );
      }

      const bgImage = category ? (category.banner_image || category.image_url) : null;
      const style = bgImage ? { backgroundImage: 'url(' + bgImage + ')' } : {};

      return (
        <div className="category-hero" style={style}>
          <Breadcrumbs items={crumbs} />
          <h1>{category ? category.name : 'Shop All'}</h1>
          {category && category.description && <p>{category.description}</p>}
        </div>
      );
    }

    // ==================== Browse View ====================

    function BrowseView({ skus, totalSkus, loading, categories, selectedCategory, selectedCollection, searchQuery, onCategorySelect, onSearch, facets, filters, onFilterToggle, onClearFilters, sortBy, onSortChange, onSkuClick, currentPage, onPageChange, wishlist, toggleWishlist, setQuickViewSku, filterDrawerOpen, setFilterDrawerOpen, goHome,
      vendorFacets, vendorFilters, onVendorToggle, priceRange, userPriceRange, onPriceRangeChange, tagFacets, tagFilters, onTagToggle, didYouMean }) {
      const totalPages = Math.ceil(totalSkus / 72);
      const hasAttrFilters = Object.keys(filters).length > 0;
      const hasVendorFilters = vendorFilters && vendorFilters.length > 0;
      const hasPriceFilters = userPriceRange && (userPriceRange.min != null || userPriceRange.max != null);
      const hasTagFilters = tagFilters && tagFilters.length > 0;
      const hasFilters = hasAttrFilters || hasVendorFilters || hasPriceFilters || hasTagFilters;
      const totalActiveFilterCount = (vendorFilters ? vendorFilters.length : 0) + (hasPriceFilters ? 1 : 0) + (tagFilters ? tagFilters.length : 0) + Object.values(filters).reduce((s, a) => s + a.length, 0);

      // Find the current category object (with description, banner_image, etc.)
      let currentCategory = null;
      let categoryName = null;
      if (selectedCategory) {
        const flat = [];
        categories.forEach(c => { flat.push(c); (c.children || []).forEach(ch => flat.push(ch)); });
        currentCategory = flat.find(c => c.slug === selectedCategory) || null;
        if (currentCategory) categoryName = currentCategory.name;
      }

      const crumbs = [{ label: 'Home', onClick: goHome }, { label: 'Shop', onClick: !selectedCategory && !selectedCollection && !searchQuery ? undefined : () => onCategorySelect(null) }];
      if (categoryName) crumbs.push({ label: categoryName });
      else if (selectedCollection) crumbs.push({ label: selectedCollection });
      else if (searchQuery) crumbs.push({ label: 'Search Results' });

      // Shared FacetPanel props
      const facetProps = {
        facets, filters, onFilterToggle, onClearFilters,
        vendors: vendorFacets, vendorFilters, onVendorToggle,
        priceRange, userPriceRange, onPriceRangeChange,
        tagFacets, tagFilters, onTagToggle, totalSkus
      };

      // Check if this is a parent category with subcategories → show landing page
      const isParentLanding = currentCategory && !currentCategory.parent_id && !searchQuery && !selectedCollection;
      const landingChildren = isParentLanding
        ? (currentCategory.children || []).filter(ch => ch.product_count > 0)
        : [];

      if (isParentLanding && landingChildren.length === 0 && (currentCategory.children || []).length > 0) {
        return (
          <>
            <CategoryHero category={currentCategory} crumbs={crumbs} searchQuery={searchQuery} totalSkus={totalSkus} />
            <section className="category-landing">
              <h2>{currentCategory.name}</h2>
              <p className="subtitle">Products coming soon. Check back later!</p>
            </section>
          </>
        );
      }

      if (isParentLanding && landingChildren.length > 0) {
        return (
          <>
            <CategoryHero category={currentCategory} crumbs={crumbs} searchQuery={searchQuery} totalSkus={totalSkus} />
            <section className="category-landing">
              <h2>Browse {currentCategory.name}</h2>
              <p className="subtitle">Explore our {currentCategory.name.toLowerCase()} collections</p>
              <div className="category-landing-grid">
                {landingChildren.map(child => (
                  <div key={child.slug} className="category-tile" onClick={() => onCategorySelect(child.slug)}>
                    {child.image_url
                      ? <img src={optimizeImg(child.image_url, 400)} alt={child.name} loading="lazy" decoding="async" />
                      : <div style={{ width: '100%', height: '100%', background: 'var(--stone-200)' }} />
                    }
                    <div className="category-tile-overlay">
                      <span className="category-tile-name">{child.name}</span>
                      <span className="category-tile-count">{child.product_count} products</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </>
        );
      }

      return (
        <>
          <CategoryHero category={currentCategory} crumbs={crumbs} searchQuery={searchQuery} totalSkus={totalSkus} />
          <div className="browse-layout">

          <div className="sidebar">
            <FacetPanel {...facetProps} />
          </div>

          <div>
            {hasFilters && (
              <ActiveFilterPills filters={filters} facets={facets} onFilterToggle={onFilterToggle} onClearFilters={onClearFilters}
                vendorFilters={vendorFilters} onVendorToggle={onVendorToggle} userPriceRange={userPriceRange} onPriceRangeChange={onPriceRangeChange}
                tagFilters={tagFilters} tagFacets={tagFacets} onTagToggle={onTagToggle} />
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <BrowseToolbar totalSkus={totalSkus} sortBy={sortBy} onSortChange={onSortChange} />
              <button className="mobile-filter-btn" onClick={() => setFilterDrawerOpen(true)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16 }}><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="20" y2="12"/><line x1="12" y1="18" x2="20" y2="18"/></svg>
                Filters
                {totalActiveFilterCount > 0 && <span className="filter-badge">{totalActiveFilterCount}</span>}
              </button>
            </div>
            {loading ? (
              <SkeletonGrid count={8} />
            ) : skus.length === 0 ? (
              searchQuery ? (
                <SearchEmptyState searchQuery={searchQuery} categories={categories} onSearch={onSearch} onCategorySelect={onCategorySelect} didYouMean={didYouMean} />
              ) : (
                <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--stone-600)' }}>
                  <p style={{ fontSize: '1.125rem', marginBottom: '1rem' }}>No products found</p>
                  <p style={{ fontSize: '0.875rem' }}>Try adjusting your filters</p>
                </div>
              )
            ) : (
              <>
                <SkuGrid skus={skus} onSkuClick={onSkuClick} wishlist={wishlist} toggleWishlist={toggleWishlist} setQuickViewSku={setQuickViewSku} />
                {totalPages > 1 && (
                  <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={onPageChange} />
                )}
              </>
            )}
            {/* Filter Drawer (mobile) */}
            <div className={'filter-drawer-overlay' + (filterDrawerOpen ? ' open' : '')} onClick={() => setFilterDrawerOpen(false)} />
            <div className={'filter-drawer' + (filterDrawerOpen ? ' open' : '')}>
              <div className="filter-drawer-head">
                <h3>Filters</h3>
                <button className="cart-drawer-close" onClick={() => setFilterDrawerOpen(false)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
              <div className="filter-drawer-body">
                <FacetPanel {...facetProps} isMobile={true} />
              </div>
              <div className="filter-drawer-footer">
                <button className="btn" style={{ width: '100%' }} onClick={() => setFilterDrawerOpen(false)}>
                  Show {totalSkus} Result{totalSkus !== 1 ? 's' : ''}
                </button>
              </div>
            </div>
          </div>
        </div>
        </>
      );
    }

    function CategoryNav({ categories, selectedCategory, onCategorySelect }) {
      // Find the active parent category
      let activeParent = null;
      if (selectedCategory) {
        activeParent = categories.find(c => c.slug === selectedCategory);
        if (!activeParent) {
          categories.forEach(p => {
            if ((p.children || []).some(ch => ch.slug === selectedCategory)) activeParent = p;
          });
        }
      }

      // Only show subcategory nav if the active parent has children
      if (!activeParent || !(activeParent.children || []).length) return null;

      return (
        <div className="category-sidebar">
          <h3>{activeParent.name}</h3>
          <div className={'category-item' + (selectedCategory === activeParent.slug ? ' active' : '')} onClick={() => onCategorySelect(activeParent.slug)}>
            <span>All {activeParent.name}</span>
            <span className="category-count">{activeParent.product_count}</span>
          </div>
          {(activeParent.children || []).map(child => (
            <div key={child.slug} className={'category-item' + (selectedCategory === child.slug ? ' active' : '')} onClick={() => onCategorySelect(child.slug)}>
              <span>{child.name}</span>
              <span className="category-count">{child.product_count}</span>
            </div>
          ))}
        </div>
      );
    }

    function PriceRangeFilter({ priceRange, userPriceRange, onChange }) {
      const min = priceRange.min || 0;
      const max = priceRange.max || 1000;
      const step = max > 100 ? 1 : 0.5;
      const curMin = userPriceRange.min != null ? userPriceRange.min : min;
      const curMax = userPriceRange.max != null ? userPriceRange.max : max;
      const [localMin, setLocalMin] = useState(curMin);
      const [localMax, setLocalMax] = useState(curMax);

      useEffect(() => {
        setLocalMin(userPriceRange.min != null ? userPriceRange.min : min);
        setLocalMax(userPriceRange.max != null ? userPriceRange.max : max);
      }, [userPriceRange.min, userPriceRange.max, min, max]);

      const pctMin = ((localMin - min) / (max - min)) * 100;
      const pctMax = ((localMax - min) / (max - min)) * 100;

      const commit = (lo, hi) => {
        const newMin = lo > min ? lo : null;
        const newMax = hi < max ? hi : null;
        if (newMin === null && newMax === null) onChange(null, null);
        else onChange(newMin, newMax);
      };

      return (
        <div className="price-range-wrapper">
          <div className="price-range-slider">
            <div className="price-range-track" />
            <div className="price-range-fill" style={{ left: pctMin + '%', width: (pctMax - pctMin) + '%' }} />
            <input type="range" min={min} max={max} step={step} value={localMin}
              onChange={e => { const v = Math.min(parseFloat(e.target.value), localMax - step); setLocalMin(v); }}
              onMouseUp={() => commit(localMin, localMax)} onTouchEnd={() => commit(localMin, localMax)} />
            <input type="range" min={min} max={max} step={step} value={localMax}
              onChange={e => { const v = Math.max(parseFloat(e.target.value), localMin + step); setLocalMax(v); }}
              onMouseUp={() => commit(localMin, localMax)} onTouchEnd={() => commit(localMin, localMax)} />
          </div>
          <div className="price-range-inputs">
            <div className="price-input-wrap">
              <span>$</span>
              <input type="number" min={min} max={max} step={step} value={localMin}
                onChange={e => { const v = parseFloat(e.target.value) || min; setLocalMin(v); }}
                onBlur={() => commit(localMin, localMax)} />
            </div>
            <span className="price-range-dash">&ndash;</span>
            <div className="price-input-wrap">
              <span>$</span>
              <input type="number" min={min} max={max} step={step} value={localMax}
                onChange={e => { const v = parseFloat(e.target.value) || max; setLocalMax(v); }}
                onBlur={() => commit(localMin, localMax)} />
            </div>
          </div>
        </div>
      );
    }

    function FacetPanel({ facets, filters, onFilterToggle, onClearFilters,
      vendors, vendorFilters, onVendorToggle,
      priceRange, userPriceRange, onPriceRangeChange,
      tagFacets, tagFilters, onTagToggle,
      totalSkus, isMobile }) {

      const hasAttrFilters = Object.keys(filters).length > 0;
      const hasVendorFilters = vendorFilters && vendorFilters.length > 0;
      const hasPriceFilters = userPriceRange && (userPriceRange.min != null || userPriceRange.max != null);
      const hasTagFilters = tagFilters && tagFilters.length > 0;
      const hasAny = hasAttrFilters || hasVendorFilters || hasPriceFilters || hasTagFilters;

      const [collapsed, setCollapsed] = useState({});
      const [filterSearch, setFilterSearch] = useState({});

      const prioritySlugs = ['material', 'finish', 'size', 'application'];
      const bottomSlugs = ['pei_rating', 'water_absorption', 'dcof'];

      const chevron = (isOpen) => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14, transition: 'transform 0.2s', transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      );

      // Determine default collapsed state for a group
      const isGroupCollapsed = (slug) => {
        if (collapsed[slug] !== undefined) return collapsed[slug];
        // Groups with active selections: always expanded
        if (filters[slug] && filters[slug].length > 0) return false;
        // Priority groups start expanded
        if (prioritySlugs.includes(slug)) return false;
        // Color starts expanded
        if (slug === 'color') return false;
        // Rest collapsed by default
        return true;
      };

      // --- Color families aggregation ---
      const colorFacet = facets.find(f => f.slug === 'color');
      const familyCounts = {};
      if (colorFacet) {
        colorFacet.values.forEach(v => {
          const family = mapColorToFamily(v.value);
          if (family) familyCounts[family] = (familyCounts[family] || 0) + v.count;
        });
      }
      const activeFamilies = (filters.color || []).reduce((acc, rawVal) => {
        const fam = mapColorToFamily(rawVal);
        if (fam && !acc.includes(fam)) acc.push(fam);
        return acc;
      }, []);

      const handleFamilyClick = (familyName) => {
        const { keywords } = COLOR_FAMILIES[familyName];
        if (!colorFacet) return;
        // Get all raw color values that belong to this family
        const familyRawValues = colorFacet.values.map(v => v.value).filter(v => {
          const lower = v.toLowerCase().trim();
          return keywords.some(kw => lower.includes(kw));
        });
        if (familyRawValues.length === 0) return;
        const currentColors = filters.color || [];
        const isActive = familyRawValues.some(v => currentColors.includes(v));
        if (isActive) {
          // Remove all raw values in this family
          familyRawValues.forEach(v => {
            if (currentColors.includes(v)) onFilterToggle('color', v);
          });
        } else {
          // Add all raw values in this family
          familyRawValues.forEach(v => {
            if (!currentColors.includes(v)) onFilterToggle('color', v);
          });
        }
      };

      // Separate color from other facets for custom rendering
      const nonColorFacets = facets.filter(f => f.slug !== 'color');

      // Sort facets: priority first, bottom last, rest in original order
      const sortedFacets = [...nonColorFacets].sort((a, b) => {
        const ai = prioritySlugs.indexOf(a.slug);
        const bi = prioritySlugs.indexOf(b.slug);
        const aBot = bottomSlugs.indexOf(a.slug);
        const bBot = bottomSlugs.indexOf(b.slug);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1 && bBot !== -1) return -1;
        if (aBot !== -1 && bi !== -1) return 1;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        if (aBot !== -1 && bBot !== -1) return aBot - bBot;
        if (aBot !== -1) return 1;
        if (bBot !== -1) return -1;
        return 0;
      });

      const renderFilterGroup = (group) => {
        const isCol = isGroupCollapsed(group.slug);
        const searchTerm = filterSearch[group.slug] || '';
        const values = searchTerm
          ? group.values.filter(v => v.value.toLowerCase().includes(searchTerm.toLowerCase()))
          : group.values;
        const activeCount = (filters[group.slug] || []).length;
        const checkId = (val) => 'f-' + group.slug + '-' + val.replace(/[^a-zA-Z0-9]/g, '_');

        return (
          <div key={group.slug} className="filter-group">
            <div className="filter-group-title" onClick={() => setCollapsed(prev => ({ ...prev, [group.slug]: !isCol }))}>
              <span>{group.name}{activeCount > 0 && <span className="filter-group-count-badge">{activeCount}</span>}</span>
              {chevron(!isCol)}
            </div>
            {!isCol && (
              <div style={{ marginTop: '0.625rem' }}>
                {group.values.length > 15 && (
                  <input className="filter-search-input" type="text" placeholder={'Search ' + group.name.toLowerCase() + '...'}
                    value={searchTerm} onChange={e => setFilterSearch(prev => ({ ...prev, [group.slug]: e.target.value }))}
                    onClick={e => e.stopPropagation()} />
                )}
                <div className="filter-values-scroll">
                  {values.map(v => {
                    const checked = (filters[group.slug] || []).includes(v.value);
                    return (
                      <div key={v.value} className="filter-option">
                        <input type="checkbox" id={checkId(v.value)} checked={checked}
                          onChange={() => onFilterToggle(group.slug, v.value)} />
                        <label htmlFor={checkId(v.value)}>{formatCarpetValue(v.value)}</label>
                        <span className="filter-count">({v.count})</span>
                      </div>
                    );
                  })}
                  {values.length === 0 && searchTerm && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--stone-400)', padding: '0.25rem 0' }}>No matches</div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      };

      return (
        <div className="filter-panel">
          {/* Header + Clear All */}
          <div style={{ paddingBottom: '0.75rem', borderBottom: '1px solid var(--stone-200)', marginBottom: '0.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.8125rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--stone-900)' }}>Filters</span>
            {hasAny && <button className="filter-clear" onClick={onClearFilters}>Clear All</button>}
          </div>

          {/* Vendor filter */}
          {vendors && vendors.length > 0 && (
            <div className="filter-group vendor-filter-group">
              <div className="filter-group-title" onClick={() => setCollapsed(prev => ({ ...prev, _vendor: !prev._vendor }))}>
                <span>Brand{hasVendorFilters && <span className="filter-group-count-badge">{vendorFilters.length}</span>}</span>
                {chevron(collapsed._vendor)}
              </div>
              {!collapsed._vendor && (
                <div style={{ marginTop: '0.625rem' }}>
                  {vendors.length > 15 && (
                    <input className="filter-search-input" type="text" placeholder="Search brands..."
                      value={filterSearch._vendor || ''} onChange={e => setFilterSearch(prev => ({ ...prev, _vendor: e.target.value }))}
                      onClick={e => e.stopPropagation()} />
                  )}
                  <div className="filter-values-scroll">
                    {(filterSearch._vendor
                      ? vendors.filter(v => v.name.toLowerCase().includes(filterSearch._vendor.toLowerCase()))
                      : vendors
                    ).map(v => {
                      const checked = vendorFilters.includes(v.name);
                      return (
                        <div key={v.name} className="filter-option">
                          <input type="checkbox" id={'f-vendor-' + v.name.replace(/[^a-zA-Z0-9]/g, '_')} checked={checked}
                            onChange={() => onVendorToggle(v.name)} />
                          <label htmlFor={'f-vendor-' + v.name.replace(/[^a-zA-Z0-9]/g, '_')}>{v.name}</label>
                          <span className="filter-count">({v.count})</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Tag chips (Features & Room) */}
          {tagFacets && tagFacets.length > 0 && (
            <div className="filter-group">
              <div className="filter-group-title"><span>Features & Room{hasTagFilters && <span className="filter-group-count-badge">{tagFilters.length}</span>}</span></div>
              <div className="tag-chips">
                {tagFacets.map(tag => (
                  <button key={tag.slug}
                    className={'tag-chip' + ((tagFilters || []).includes(tag.slug) ? ' active' : '')}
                    onClick={() => onTagToggle(tag.slug)}>
                    {tag.name} <span className="filter-count">({tag.count})</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Price range */}
          {priceRange && priceRange.max > 0 && (
            <div className="filter-group">
              <div className="filter-group-title" onClick={() => setCollapsed(prev => ({ ...prev, _price: !prev._price }))}>
                <span>Price{hasPriceFilters && <span className="filter-group-count-badge">1</span>}</span>
                {chevron(collapsed._price)}
              </div>
              {!collapsed._price && (
                <div style={{ marginTop: '0.625rem' }}>
                  <PriceRangeFilter priceRange={priceRange} userPriceRange={userPriceRange || { min: null, max: null }} onChange={onPriceRangeChange} />
                </div>
              )}
            </div>
          )}

          {/* Color families + color facet */}
          {colorFacet && (
            <div className="filter-group">
              <div className="filter-group-title" onClick={() => setCollapsed(prev => ({ ...prev, color: !isGroupCollapsed('color') }))}>
                <span>Color{(filters.color || []).length > 0 && <span className="filter-group-count-badge">{(filters.color || []).length}</span>}</span>
                {chevron(isGroupCollapsed('color'))}
              </div>
              {!isGroupCollapsed('color') && (
                <div style={{ marginTop: '0.625rem' }}>
                  {/* Color family swatches */}
                  <div className="color-family-grid">
                    {Object.entries(COLOR_FAMILIES).map(([name, { hex }]) => {
                      if (!familyCounts[name]) return null;
                      const isActive = activeFamilies.includes(name);
                      const style = hex.includes('gradient')
                        ? { background: hex }
                        : { backgroundColor: hex };
                      return (
                        <div key={name} className={'color-family-swatch' + (isActive ? ' active' : '')} onClick={() => handleFamilyClick(name)}>
                          <div className="color-family-circle" style={style} />
                          <span className="color-family-name">{name}</span>
                        </div>
                      );
                    })}
                  </div>
                  {/* Detailed color values with search */}
                  {colorFacet.values.length > 15 && (
                    <input className="filter-search-input" type="text" placeholder="Search colors..."
                      value={filterSearch.color || ''} onChange={e => setFilterSearch(prev => ({ ...prev, color: e.target.value }))}
                      onClick={e => e.stopPropagation()} />
                  )}
                  <div className="filter-values-scroll">
                    {(filterSearch.color
                      ? colorFacet.values.filter(v => v.value.toLowerCase().includes(filterSearch.color.toLowerCase()))
                      : colorFacet.values
                    ).map(v => {
                      const checked = (filters.color || []).includes(v.value);
                      return (
                        <div key={v.value} className="filter-option">
                          <input type="checkbox" id={'f-color-' + v.value.replace(/[^a-zA-Z0-9]/g, '_')} checked={checked}
                            onChange={() => onFilterToggle('color', v.value)} />
                          <label htmlFor={'f-color-' + v.value.replace(/[^a-zA-Z0-9]/g, '_')}>{formatCarpetValue(v.value)}</label>
                          <span className="filter-count">({v.count})</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Attribute facets */}
          {sortedFacets.map(group => renderFilterGroup(group))}
        </div>
      );
    }

    function ActiveFilterPills({ filters, facets, onFilterToggle, onClearFilters, vendorFilters, onVendorToggle, userPriceRange, onPriceRangeChange, tagFilters, tagFacets, onTagToggle }) {
      const pills = [];
      // Vendor pills
      (vendorFilters || []).forEach(name => {
        pills.push({ type: 'vendor', value: name, label: 'Brand: ' + name, onRemove: () => onVendorToggle(name) });
      });
      // Tag pills
      (tagFilters || []).forEach(slug => {
        const tag = (tagFacets || []).find(t => t.slug === slug);
        pills.push({ type: 'tag', value: slug, label: tag ? tag.name : slug, onRemove: () => onTagToggle(slug) });
      });
      // Price pill
      if (userPriceRange && (userPriceRange.min != null || userPriceRange.max != null)) {
        const label = 'Price: $' + (userPriceRange.min || 0) + ' – $' + (userPriceRange.max || '∞');
        pills.push({ type: 'price', value: 'price', label, onRemove: () => onPriceRangeChange(null, null) });
      }
      // Attribute pills
      Object.keys(filters).forEach(slug => {
        const group = facets.find(f => f.slug === slug);
        const name = group ? group.name : slug;
        (filters[slug] || []).forEach(val => {
          pills.push({ type: 'attr', slug, value: val, label: name + ': ' + val, onRemove: () => onFilterToggle(slug, val) });
        });
      });
      if (pills.length === 0) return null;
      return (
        <div className="active-filters">
          {pills.map((p, i) => (
            <div key={i} className="filter-pill">
              <span>{p.label}</span>
              <button onClick={p.onRemove}>&times;</button>
            </div>
          ))}
          <button className="filter-clear" onClick={onClearFilters}>Clear All</button>
        </div>
      );
    }

    function BrowseToolbar({ totalSkus, sortBy, onSortChange }) {
      return (
        <div className="browse-toolbar">
          <div className="result-count">{totalSkus} product{totalSkus !== 1 ? 's' : ''}</div>
          <select value={sortBy} onChange={(e) => onSortChange(e.target.value)}>
            <option value="name_asc">Name A-Z</option>
            <option value="name_desc">Name Z-A</option>
            <option value="price_asc">Price: Low to High</option>
            <option value="price_desc">Price: High to Low</option>
            <option value="newest">Newest</option>
          </select>
        </div>
      );
    }

    function SkeletonGrid({ count = 8 }) {
      return (
        <div className="skeleton-grid">
          {Array.from({ length: count }, (_, i) => (
            <div key={i}>
              <div className="skeleton-card-img" />
              <div className="skeleton-bar skeleton-bar-short" />
              <div className="skeleton-bar skeleton-bar-medium" />
            </div>
          ))}
        </div>
      );
    }

    function SkuGrid({ skus, onSkuClick, wishlist, toggleWishlist, setQuickViewSku }) {
      return (
        <div className="sku-grid">
          {skus.map(sku => (
            <SkuCard key={sku.sku_id} sku={sku} onClick={() => onSkuClick(sku.sku_id, sku.product_name || sku.collection)}
              isWished={wishlist.includes(sku.product_id)}
              onToggleWishlist={() => toggleWishlist(sku.product_id)}
              onQuickView={setQuickViewSku ? () => setQuickViewSku(sku) : null} />
          ))}
        </div>
      );
    }

    function Pagination({ currentPage, totalPages, onPageChange }) {
      const pages = [];
      const maxVisible = 7;
      let start = Math.max(1, currentPage - Math.floor(maxVisible / 2));
      let end = start + maxVisible - 1;
      if (end > totalPages) { end = totalPages; start = Math.max(1, end - maxVisible + 1); }

      if (start > 1) { pages.push(1); if (start > 2) pages.push('...'); }
      for (let i = start; i <= end; i++) pages.push(i);
      if (end < totalPages) { if (end < totalPages - 1) pages.push('...'); pages.push(totalPages); }

      return (
        <nav className="pagination" aria-label="Product pages">
          <button className="pagination-btn" disabled={currentPage <= 1} onClick={() => onPageChange(currentPage - 1)}>&larr; Previous</button>
          <div className="pagination-pages">
            {pages.map((p, i) => p === '...' ? (
              <span key={'e' + i} className="pagination-ellipsis">&hellip;</span>
            ) : (
              <button key={p} className={'pagination-num' + (p === currentPage ? ' active' : '')} onClick={() => onPageChange(p)}>{p}</button>
            ))}
          </div>
          <button className="pagination-btn" disabled={currentPage >= totalPages} onClick={() => onPageChange(currentPage + 1)}>Next &rarr;</button>
        </nav>
      );
    }

    function SkuCard({ sku, onClick, isWished, onToggleWishlist, onQuickView }) {
      const onSale = sku.sale_price != null && !sku.trade_price;
      const price = sku.trade_price || (onSale ? sku.sale_price : sku.retail_price);
      const discountPct = onSale && sku.retail_price ? Math.round((1 - parseFloat(sku.sale_price) / parseFloat(sku.retail_price)) * 100) : 0;
      return (
        <div className="sku-card" onClick={onClick} data-sku={sku.vendor_sku || sku.internal_sku}>
          <button className={'wishlist-heart' + (isWished ? ' active' : '')}
            onClick={(e) => { e.stopPropagation(); onToggleWishlist(); }}>
            <svg viewBox="0 0 24 24" fill={isWished ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/>
            </svg>
          </button>
          <div className="sku-card-image">
            {sku.primary_image && <img src={optimizeImg(sku.primary_image, 400)} alt={sku.product_name} loading="lazy" decoding="async" width="300" height="300" />}
            {sku.alternate_image && <img className="sku-card-alt-img" src={optimizeImg(sku.alternate_image, 400)} alt="" loading="lazy" decoding="async" width="300" height="300" />}
            {onSale && <span className="sale-badge">SALE</span>}
            {onQuickView && <button className="quick-view-btn" onClick={(e) => { e.stopPropagation(); onQuickView(); }}>Quick View</button>}
          </div>
          <div className="sku-card-name">{fullProductName(sku)}</div>
          {sku.vendor_name && <div className="sku-card-vendor">{sku.vendor_name}</div>}
          <div className="sku-card-price">
            {price ? (
              <>
                {sku.trade_price && sku.retail_price && (
                  <span style={{ textDecoration: 'line-through', color: 'var(--stone-500)', fontSize: '0.875rem', marginRight: '0.5rem' }}>
                    ${displayPrice(sku, sku.retail_price).toFixed(2)}
                  </span>
                )}
                {onSale && (
                  <span className="sale-original-price">
                    ${displayPrice(sku, sku.retail_price).toFixed(2)}
                  </span>
                )}
                <span className={onSale ? 'sale-price-text' : ''}>
                  ${displayPrice(sku, price).toFixed(2)}
                </span>
                <span className="price-suffix">{priceSuffix(sku)}</span>
                {onSale && discountPct > 0 && <span className="sale-discount-tag">{discountPct}% off</span>}
              </>
            ) : 'Contact for pricing'}
          </div>
        </div>
      );
    }

    // ==================== SKU Detail View ====================

    function SkuDetailView({ skuId, goBack, addToCart, cart, onSkuClick, onRequestInstall, tradeCustomer, wishlist, toggleWishlist, recentlyViewed, addRecentlyViewed, customer, customerToken, onShowAuth, showToast, categories }) {
      const [sku, setSku] = useState(null);
      const [media, setMedia] = useState([]);
      const [siblings, setSiblings] = useState([]);
      const [collectionSiblings, setCollectionSiblings] = useState([]);
      const [collectionAttributes, setCollectionAttributes] = useState({});
      const [groupedProducts, setGroupedProducts] = useState([]);
      const [productTags, setProductTags] = useState([]);
      const [countertopImage, setCountertopImage] = useState(null);
      const [selectedImage, setSelectedImage] = useState(0);
      const [loading, setLoading] = useState(true);
      const [fetchError, setFetchError] = useState(null);

      // Calculator state
      const [sqftInput, setSqftInput] = useState('');
      const [boxesInput, setBoxesInput] = useState('');
      const [includeOverage, setIncludeOverage] = useState(false);
      const [unitQty, setUnitQty] = useState(1);
      const [accessoryQtys, setAccessoryQtys] = useState({});
      // Carpet calculator state
      const [carpetInputMode, setCarpetInputMode] = useState('linear'); // 'linear', 'dimensions', or 'sqft'
      const [roomWidth, setRoomWidth] = useState('');
      const [roomLength, setRoomLength] = useState('');
      const [linearFeet, setLinearFeet] = useState('');
      const [includeCarpetOverage, setIncludeCarpetOverage] = useState(false);

      // Review state
      const [reviews, setReviews] = useState([]);
      const [avgRating, setAvgRating] = useState(0);
      const [reviewCount, setReviewCount] = useState(0);
      const [reviewRating, setReviewRating] = useState(0);
      const [reviewHover, setReviewHover] = useState(0);
      const [reviewTitle, setReviewTitle] = useState('');
      const [reviewBody, setReviewBody] = useState('');
      const [reviewSubmitting, setReviewSubmitting] = useState(false);
      const [reviewSubmitted, setReviewSubmitted] = useState(false);

      // 404 search state
      const [notFoundSearch, setNotFoundSearch] = useState('');

      // Stock alert state
      const [alertEmail, setAlertEmail] = useState('');
      const [alertSubscribed, setAlertSubscribed] = useState(false);
      const [alertLoading, setAlertLoading] = useState(false);
      const [alertSuccess, setAlertSuccess] = useState(false);

      useEffect(() => {
        setLoading(true);
        setSelectedImage(0);
        setAccessoryQtys({});
        const headers = {};
        const t = localStorage.getItem('trade_token');
        if (t) headers['X-Trade-Token'] = t;
        fetch(API + '/api/storefront/skus/' + skuId, { headers })
          .then(r => {
            if (!r.ok) throw new Error(r.status === 404 ? 'not_found' : 'server_error');
            return r.json();
          })
          .then(data => {
            if (data.redirect_to_sku) {
              onSkuClick(data.redirect_to_sku);
              return;
            }
            if (data.error || !data.sku) { setFetchError('not_found'); setLoading(false); return; }
            setSku(data.sku);
            setMedia(data.media || []);
            setSiblings(data.same_product_siblings || []);
            setCollectionSiblings(data.collection_siblings || []);
            setCollectionAttributes(data.collection_attributes || {});
            setGroupedProducts(data.grouped_products || []);
            setCountertopImage(data.countertop_image || null);
            setProductTags(data.tags || []);
            setLoading(false);
            if (data.sku && addRecentlyViewed) {
              addRecentlyViewed({ sku_id: data.sku.sku_id, product_name: data.sku.product_name, variant_name: data.sku.variant_name, primary_image: (data.media && data.media[0]) ? data.media[0].url : null, retail_price: data.sku.retail_price, price_basis: data.sku.price_basis, sell_by: data.sku.sell_by, sqft_per_box: data.sku.sqft_per_box });
            }
            if (data.sku) {
              const skuTitle = fullProductName(data.sku) + ' | Roma Flooring Designs';
              const skuDesc = cleanDescription(data.sku.description_short, data.sku.vendor_name) || ('Premium ' + data.sku.product_name + ' from Roma Flooring Designs');
              const skuImage = (data.media && data.media[0]) ? data.media[0].url : null;
              updateSEO({ title: skuTitle, description: skuDesc, url: SITE_URL + '/shop/sku/' + skuId, image: skuImage });
              // Fetch reviews for this product
              fetch(API + '/api/storefront/products/' + data.sku.product_id + '/reviews')
                .then(r => r.json())
                .then(revData => {
                  setReviews(revData.reviews || []);
                  setAvgRating(revData.average_rating || 0);
                  setReviewCount(revData.review_count || 0);
                  // Pre-fill form if customer already reviewed
                  if (customer) {
                    const existing = (revData.reviews || []).find(r => r.first_name === customer.first_name);
                    if (existing) {
                      setReviewRating(existing.rating);
                      setReviewTitle(existing.title || '');
                      setReviewBody(existing.body || '');
                      setReviewSubmitted(true);
                    }
                  }
                })
                .catch(() => {});
              // Check stock alert subscription for out-of-stock items
              if (data.sku.stock_status === 'out_of_stock' && data.sku.vendor_has_inventory !== false) {
                const alertEmail = customer ? customer.email : '';
                if (alertEmail) {
                  fetch(API + '/api/storefront/stock-alerts/check?sku_id=' + data.sku.sku_id + '&email=' + encodeURIComponent(alertEmail))
                    .then(r => r.json())
                    .then(d => { if (d.subscribed) setAlertSubscribed(true); })
                    .catch(() => {});
                }
              }
            }
          })
          .catch(err => {
            console.error(err);
            setFetchError(err.message === 'not_found' ? 'not_found' : 'error');
            setLoading(false);
          });
      }, [skuId]);

      // JSON-LD Product schema with aggregateRating
      useEffect(() => {
        if (!sku) return;
        const skuDesc = cleanDescription(sku.description_short, sku.vendor_name) || ('Premium ' + sku.product_name + ' from Roma Flooring Designs');
        const skuImage = (media && media[0]) ? media[0].url : null;
        const product = {
          '@type': 'Product', name: sku.product_name, description: skuDesc, image: skuImage,
          sku: sku.sku_code || String(sku.sku_id),
          mpn: sku.sku_code || '',
          brand: { '@type': 'Brand', name: sku.vendor_name || 'Roma Flooring Designs' },
          category: sku.category_name || '',
          offers: { '@type': 'Offer', url: SITE_URL + '/shop/sku/' + skuId, priceCurrency: 'USD',
            price: displayPrice(sku, sku.sale_price || sku.retail_price).toFixed(2),
            availability: sku.stock_status === 'in_stock' ? 'https://schema.org/InStock' : 'https://schema.org/PreOrder',
            seller: { '@type': 'Organization', name: 'Roma Flooring Designs' } }
        };
        if (reviewCount > 0) {
          product.aggregateRating = { '@type': 'AggregateRating', ratingValue: avgRating.toFixed(1), reviewCount: reviewCount, bestRating: 5, worstRating: 1 };
        }
        setDynamicJsonLd({ '@context': 'https://schema.org', '@graph': [
          product,
          { '@type': 'BreadcrumbList', itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
            { '@type': 'ListItem', position: 2, name: 'Shop', item: SITE_URL + '/shop' },
            sku.category_name ? { '@type': 'ListItem', position: 3, name: sku.category_name, item: SITE_URL + '/shop?category=' + (sku.category_slug || '') } : null,
            { '@type': 'ListItem', position: sku.category_name ? 4 : 3, name: sku.product_name, item: SITE_URL + '/shop/sku/' + skuId }
          ].filter(Boolean) }
        ]});
      }, [sku, media, avgRating, reviewCount]);

      // Sync sqft <-> boxes
      const sqftPerBox = sku ? parseFloat(sku.sqft_per_box) || 0 : 0;
      const retailPrice = sku ? displayPrice(sku, sku.retail_price) : 0;
      const salePrice = sku && sku.sale_price ? displayPrice(sku, sku.sale_price) : null;
      const tradePrice = sku && sku.trade_price ? displayPrice(sku, sku.trade_price) : null;
      const isCarpetSku = sku && isCarpet(sku);
      const cutPrice = isCarpetSku ? parseFloat(sku.cut_price) : 0;
      const rollPrice = isCarpetSku ? parseFloat(sku.roll_price) : 0;
      const rollMinSqft = isCarpetSku && sku.roll_min_sqft ? parseFloat(sku.roll_min_sqft) : 0;
      const rollWidthFt = isCarpetSku && sku.roll_width_ft ? parseFloat(sku.roll_width_ft) : 0;
      const rollLengthFt = isCarpetSku && sku.roll_length_ft ? parseFloat(sku.roll_length_ft) : 0;
      // Auto-fallback: if linear mode but no roll width, use dimensions
      const effectiveCarpetMode = (carpetInputMode === 'linear' && rollWidthFt <= 0) ? 'dimensions' : carpetInputMode;
      // For carpet, compute sqft from linear feet, room dimensions, or manual input
      const carpetRawSqft = isCarpetSku
        ? (effectiveCarpetMode === 'linear'
          ? (rollWidthFt * (parseFloat(linearFeet) || 0))
          : effectiveCarpetMode === 'dimensions'
            ? ((parseFloat(roomWidth) || 0) * (parseFloat(roomLength) || 0))
            : (parseFloat(sqftInput) || 0))
        : 0;
      const carpetSqft = includeCarpetOverage ? Math.ceil(carpetRawSqft * 1.1) : carpetRawSqft;
      const carpetPriceTier = isCarpetSku && rollMinSqft > 0 && carpetSqft >= rollMinSqft ? 'roll' : 'cut';
      const carpetActivePrice = isCarpetSku ? (carpetPriceTier === 'roll' ? rollPrice : cutPrice) : 0;
      const carpetSqyd = carpetSqft / 9;
      const carpetSubtotal = carpetSqyd * carpetActivePrice;
      const carpetSqftToRoll = isCarpetSku && rollMinSqft > 0 && carpetSqft > 0 && carpetSqft < rollMinSqft ? rollMinSqft - carpetSqft : 0;
      const carpetRollSavings = isCarpetSku && carpetSqftToRoll > 0 ? ((cutPrice - rollPrice) * (rollMinSqft / 9)).toFixed(2) : '0';
      // Carpet weight estimation from weight_per_sqyd attribute or weight_per_pallet_lbs / sqft_per_pallet
      const carpetWeightPerSqyd = isCarpetSku ? (() => {
        const wAttr = (sku.attributes || []).find(a => a.slug === 'weight_per_sqyd');
        if (wAttr) return parseFloat(wAttr.value) || 0;
        if (sku.weight_per_pallet_lbs && sku.sqft_per_pallet) {
          return (parseFloat(sku.weight_per_pallet_lbs) / (parseFloat(sku.sqft_per_pallet) / 9)) || 0;
        }
        return 0;
      })() : 0;
      const carpetEstWeight = carpetWeightPerSqyd > 0 ? carpetSqyd * carpetWeightPerSqyd : 0;
      // Room wider than roll — seam needed
      const carpetNeedsSeam = isCarpetSku && effectiveCarpetMode === 'dimensions' && rollWidthFt > 0 && (parseFloat(roomWidth) || 0) > rollWidthFt;
      const effectivePrice = isCarpetSku ? carpetActivePrice : (tradePrice || salePrice || retailPrice);

      const handleSqftChange = (val) => {
        setSqftInput(val);
        if (sqftPerBox > 0 && val) {
          let sqft = parseFloat(val) || 0;
          if (includeOverage) sqft *= 1.1;
          const boxes = Math.ceil(sqft / sqftPerBox);
          setBoxesInput(boxes > 0 ? boxes.toString() : '');
        } else {
          setBoxesInput('');
        }
      };

      const handleBoxesChange = (val) => {
        setBoxesInput(val);
        if (sqftPerBox > 0 && val) {
          const boxes = parseInt(val) || 0;
          setSqftInput(boxes > 0 ? (boxes * sqftPerBox).toFixed(1) : '');
        } else {
          setSqftInput('');
        }
      };

      useEffect(() => {
        if (sqftInput && sqftPerBox > 0) {
          let sqft = parseFloat(sqftInput) || 0;
          if (includeOverage) sqft *= 1.1;
          const boxes = Math.ceil(sqft / sqftPerBox);
          setBoxesInput(boxes > 0 ? boxes.toString() : '');
        }
      }, [includeOverage]);

      const numBoxes = parseInt(boxesInput) || 0;
      const actualSqft = numBoxes * sqftPerBox;
      const subtotal = actualSqft * effectivePrice;

      const isPerUnit = sku && isSoldPerUnit(sku);
      const hasBoxCalc = !isPerUnit && sqftPerBox > 0;
      const isSqftNoBox = !isPerUnit && sqftPerBox <= 0;
      const unitSubtotal = unitQty * effectivePrice;
      const sqftOnlySubtotal = (parseFloat(sqftInput) || 0) * effectivePrice;

      const handleReviewSubmit = async () => {
        if (!customer || !customerToken || reviewRating < 1) return;
        setReviewSubmitting(true);
        try {
          const resp = await fetch(API + '/api/storefront/products/' + sku.product_id + '/reviews', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Customer-Token': customerToken },
            body: JSON.stringify({ rating: reviewRating, title: reviewTitle, body: reviewBody })
          });
          if (resp.ok) {
            setReviewSubmitted(true);
            // Refresh reviews
            const revData = await (await fetch(API + '/api/storefront/products/' + sku.product_id + '/reviews')).json();
            setReviews(revData.reviews || []);
            setAvgRating(revData.average_rating || 0);
            setReviewCount(revData.review_count || 0);
          }
        } catch (err) { console.error('Review submit error:', err); }
        setReviewSubmitting(false);
      };

      const handleStockAlertSubmit = async () => {
        const email = customer ? customer.email : alertEmail;
        if (!email || !sku) return;
        setAlertLoading(true);
        try {
          const headers = { 'Content-Type': 'application/json' };
          if (customerToken) headers['X-Customer-Token'] = customerToken;
          const resp = await fetch(API + '/api/storefront/stock-alerts', {
            method: 'POST', headers,
            body: JSON.stringify({ sku_id: sku.sku_id, email })
          });
          if (resp.ok) { setAlertSuccess(true); setAlertSubscribed(true); }
        } catch (err) { console.error('Stock alert error:', err); }
        setAlertLoading(false);
      };

      const handleAddToCart = () => {
        if (!sku) return;
        if (isCarpetSku) {
          if (carpetSqft <= 0) return;
          addToCart({
            product_id: sku.product_id,
            sku_id: sku.sku_id,
            sqft_needed: carpetSqft,
            num_boxes: 1,
            unit_price: carpetActivePrice,
            subtotal: carpetSubtotal.toFixed(2),
            sell_by: 'sqyd',
            price_tier: carpetPriceTier
          });
        } else if (isPerUnit) {
          if (unitQty <= 0) return;
          addToCart({
            product_id: sku.product_id,
            sku_id: sku.sku_id,
            num_boxes: unitQty,
            unit_price: effectivePrice,
            subtotal: unitSubtotal.toFixed(2),
            sell_by: 'unit'
          });
        } else if (hasBoxCalc) {
          if (numBoxes <= 0) return;
          addToCart({
            product_id: sku.product_id,
            sku_id: sku.sku_id,
            sqft_needed: actualSqft,
            num_boxes: numBoxes,
            include_overage: includeOverage,
            unit_price: effectivePrice,
            subtotal: subtotal.toFixed(2),
            sell_by: 'sqft'
          });
        } else {
          // sqft product without box data — sell by sqft directly
          const sqft = parseFloat(sqftInput) || 0;
          if (sqft <= 0) return;
          addToCart({
            product_id: sku.product_id,
            sku_id: sku.sku_id,
            sqft_needed: sqft,
            num_boxes: 1,
            unit_price: effectivePrice,
            subtotal: (sqft * effectivePrice).toFixed(2),
            sell_by: 'sqft'
          });
        }
      };

      const handleRequestSample = () => {
        if (!sku) return;
        addToCart({
          product_id: sku.product_id,
          sku_id: sku.sku_id,
          num_boxes: 1,
          unit_price: 0,
          subtotal: '0.00',
          is_sample: true
        });
      };

      if (fetchError) return (
        <div className="not-found-page">
          <div className="not-found-hero">
            <div style={{ fontSize: '5rem', fontWeight: 200, color: 'var(--stone-300)', lineHeight: 1, fontFamily: 'var(--font-heading)' }}>
              {fetchError === 'not_found' ? '404' : 'Oops'}
            </div>
            <h1 style={{ fontFamily: 'var(--font-heading)', fontSize: '2rem', fontWeight: 300, margin: '0.75rem 0' }}>
              {fetchError === 'not_found' ? 'Product Not Found' : 'Something Went Wrong'}
            </h1>
            <p style={{ color: 'var(--stone-600)', marginBottom: '1.5rem', lineHeight: 1.6, maxWidth: 420, margin: '0 auto 1.5rem' }}>
              {fetchError === 'not_found'
                ? 'This product may have been removed or the link may be incorrect. Try searching for what you need.'
                : 'We had trouble loading this product. Please try again.'}
            </p>
            {fetchError === 'not_found' && (
              <form className="not-found-search" onSubmit={e => { e.preventDefault(); if (notFoundSearch.trim()) { goBack(); setTimeout(() => window.dispatchEvent(new CustomEvent('storefront-search', { detail: notFoundSearch.trim() })), 50); } }}>
                <input type="text" placeholder="Search for products..." value={notFoundSearch} onChange={e => setNotFoundSearch(e.target.value)} />
                <button type="submit" className="btn">Search</button>
              </form>
            )}
            <button className="btn btn-secondary" onClick={goBack} style={{ marginTop: '1rem' }}>Back to Shop</button>
          </div>

          {recentlyViewed && recentlyViewed.length > 0 && (
            <div style={{ marginTop: '3rem' }}>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.5rem', fontWeight: 300, marginBottom: '1rem' }}>Recently Viewed</h2>
              <div className="siblings-strip">
                {recentlyViewed.slice(0, 6).map(rv => (
                  <div key={rv.sku_id} className="sibling-card" onClick={() => onSkuClick(rv.sku_id, rv.product_name)}>
                    <div className="sibling-card-image">
                      {rv.primary_image && <img src={optimizeImg(rv.primary_image, 400)} alt={rv.product_name} loading="lazy" />}
                    </div>
                    <div className="sibling-card-name">{fullProductName(rv)}</div>
                    {rv.retail_price && <div className="sibling-card-price">${displayPrice(rv, rv.retail_price).toFixed(2)}{priceSuffix(rv)}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {fetchError === 'not_found' && categories && categories.length > 0 && (
            <div style={{ marginTop: '2.5rem' }}>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.5rem', fontWeight: 300, marginBottom: '1rem' }}>Popular Categories</h2>
              <div className="not-found-cats">
                {categories.slice(0, 8).map(cat => (
                  <a key={cat.slug} className="not-found-cat-link" onClick={() => { goBack(); }}>{cat.name}</a>
                ))}
              </div>
            </div>
          )}
        </div>
      );

      if (loading) return (
        <div className="sku-detail" style={{ minHeight: '80vh' }}>
          <div className="breadcrumbs">
            <div style={{ width: 60, height: 12, background: 'var(--stone-100)', borderRadius: 2 }}/>
            <div style={{ width: 80, height: 12, background: 'var(--stone-100)', borderRadius: 2 }}/>
          </div>
          <div className="sku-detail-main">
            <div className="sku-detail-gallery">
              <div style={{ width: '100%', paddingBottom: '100%', background: 'var(--stone-100)', animation: 'pulse 1.5s ease-in-out infinite' }}/>
            </div>
            <div className="sku-detail-info">
              <div style={{ width: '40%', height: 16, background: 'var(--stone-100)', borderRadius: 2, marginBottom: '1rem' }}/>
              <div style={{ width: '70%', height: 32, background: 'var(--stone-100)', borderRadius: 2, marginBottom: '0.75rem' }}/>
              <div style={{ width: '50%', height: 14, background: 'var(--stone-100)', borderRadius: 2, marginBottom: '2rem' }}/>
              <div style={{ width: '30%', height: 28, background: 'var(--stone-100)', borderRadius: 2, marginBottom: '2rem' }}/>
              <div style={{ width: '100%', height: 200, background: 'var(--stone-50)', borderRadius: 2 }}/>
            </div>
          </div>
        </div>
      );
      if (!sku) return <div style={{ textAlign: 'center', padding: '6rem', color: 'var(--stone-600)' }}>SKU not found</div>;

      const images = media.filter(m => m.asset_type !== 'spec_pdf');
      const specPdfs = media.filter(m => m.asset_type === 'spec_pdf');
      const mainImage = images[selectedImage] || images[0];

      // Separate accessories from regular siblings
      const mainSiblings = siblings.filter(s => s.variant_type !== 'accessory');
      const accessorySiblings = siblings.filter(s => s.variant_type === 'accessory');

      // ADEX products use a 3-row variant selector (Color / Finish / Type) + grouped collection siblings
      const isAdexProduct = /adex/i.test(sku.vendor_name || '');

      return (
        <>
          <div className="sku-detail" data-sku={sku.vendor_sku || sku.internal_sku}>
            <div className="breadcrumbs">
              <a onClick={goBack}>Shop</a>
              <span>/</span>
              {sku.category_name && <><a onClick={goBack}>{sku.category_name}</a><span>/</span></>}
              <span style={{ color: 'var(--stone-800)' }}>{fullProductName(sku)}</span>
            </div>

            <div className="sku-detail-main">
            <div className="sku-detail-gallery">
              <div className="sku-detail-image">
                {mainImage && <img src={optimizeImg(mainImage.url, 800)} alt={sku.product_name} decoding="async" />}
              </div>
              {images.length > 1 && (
                <div className="gallery-thumbs">
                  {images.map((img, i) => (
                    <div key={img.id} className={'gallery-thumb' + (i === selectedImage ? ' active' : '')} onClick={() => setSelectedImage(i)}>
                      <img src={optimizeImg(img.url, 120)} alt="" loading="lazy" decoding="async" width="80" height="80" />
                    </div>
                  ))}
                </div>
              )}

              {/* Specs Table — below gallery */}
              {(() => {
                const HIDDEN_SLUGS = new Set(['price_list', 'material_class', 'style_code', 'companion_skus', 'subcategory', 'brand', 'msrp', 'top_ref_sku', 'sink_ref_sku', 'optional_accessories', 'group_number']);
                const ORDER = ['_collection', '_category', 'collection', 'species', 'color', 'color_code', 'application', 'fiber', 'material', 'construction', 'finish', 'style', 'pattern', 'size', 'thickness', 'width', 'wear_layer', 'weight', 'weight_per_sqyd', 'roll_width', 'roll_length'];
                const slugMap = {};
                (sku.attributes || []).forEach(a => { slugMap[a.slug] = (a.value || '').trim(); });
                const redundantSlugs = new Set();
                if (slugMap.roll_width) { redundantSlugs.add('width'); redundantSlugs.add('size'); }
                if (slugMap.fiber) redundantSlugs.add('material');
                const visible = (sku.attributes || []).filter(a => !HIDDEN_SLUGS.has(a.slug) && !redundantSlugs.has(a.slug) && !(a.slug === 'species' && /^\d+$/.test(a.value)));
                const seenVals = new Map();
                const deduped = visible.filter(a => {
                  const norm = (a.value || '').toUpperCase().replace(/[\s.]+/g, '').trim();
                  if (seenVals.has(norm)) return false;
                  seenVals.set(norm, true);
                  return true;
                });
                const sorted = deduped.sort((a, b) => {
                  const ai = ORDER.indexOf(a.slug), bi = ORDER.indexOf(b.slug);
                  if (ai >= 0 && bi >= 0) return ai - bi;
                  if (ai >= 0) return -1;
                  if (bi >= 0) return 1;
                  return a.name.localeCompare(b.name);
                });
                // Inject collection if not already an attribute
                if (sku.collection && !slugMap.collection) {
                  sorted.unshift({ slug: '_collection', name: 'Collection', value: sku.collection });
                }
                // Inject category
                if (sku.category_name) {
                  const insertIdx = sorted.findIndex(a => a.slug === '_collection') >= 0 ? 1 : 0;
                  sorted.splice(insertIdx, 0, { slug: '_category', name: 'Category', value: sku.category_name });
                }
                const priceListAttr = (sku.attributes || []).find(a => a.slug === 'price_list');
                if (priceListAttr && priceListAttr.value) {
                  const brandLine = priceListAttr.value.replace(/\s+\d+$/, '');
                  const ccIdx = sorted.findIndex(a => a.slug === 'color_code');
                  sorted.splice(ccIdx >= 0 ? ccIdx + 1 : sorted.length, 0, { slug: '_brand', name: 'Brand', value: brandLine });
                }
                if (sorted.length === 0) return null;
                return (
                  <table className="specs-table">
                    <tbody>
                      {sorted.map((a, i) => (
                        <tr key={i}><td>{a.name}</td><td>{formatCarpetValue(a.value)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                );
              })()}

              {/* Description — below gallery */}
              {(sku.description_long || sku.description_short) && (() => {
                const cleaned = cleanDescription(sku.description_long || sku.description_short, sku.vendor_name);
                return cleaned ? (
                  <div style={{ marginTop: '1rem', fontSize: '0.9rem', lineHeight: 1.7, color: 'var(--stone-600)' }}>
                    {cleaned}
                  </div>
                ) : null;
              })()}

              {/* Spec PDF Downloads — below gallery */}
              {specPdfs.length > 0 && (
                <div style={{ marginTop: '1.5rem', paddingTop: '1.5rem', borderTop: '1px solid var(--stone-200)' }}>
                  {specPdfs.map(pdf => (
                    <a key={pdf.id} href={pdf.url} target="_blank" rel="noopener noreferrer"
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: '0.5rem', padding: '0.6rem 1rem',
                        border: '1px solid var(--stone-200)', fontSize: '0.8125rem', color: 'var(--stone-800)',
                        textDecoration: 'none', transition: 'border-color 0.2s', marginRight: '0.5rem', marginBottom: '0.5rem'
                      }}
                      onMouseOver={e => e.currentTarget.style.borderColor = 'var(--gold)'}
                      onMouseOut={e => e.currentTarget.style.borderColor = 'var(--stone-200)'}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 16, height: 16, flexShrink: 0 }}>
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 18 15 15"/>
                      </svg>
                      {pdf.alt_text || 'Spec Sheet (PDF)'}
                    </a>
                  ))}
                </div>
              )}
            </div>

            <div className="sku-detail-info">
              <a className="back-btn" onClick={goBack}>&larr; Back to Shop</a>
              <h1 className="sku-detail-title-row">
                {fullProductName(sku)}
              </h1>

              {productTags.length > 0 && (
                <div className="product-tag-badges">
                  {productTags.map(t => <span key={t.slug} className="product-tag-badge">{t.name}</span>)}
                </div>
              )}

              <div className="sku-detail-price">
                {isCarpet(sku) ? (
                  <>
                    <div>
                      <span style={{ fontSize: '1.75rem', fontWeight: 600 }}>${parseFloat(sku.cut_price).toFixed(2)}</span>
                      <span>/sqyd</span>
                      <span style={{ color: 'var(--stone-500)', fontSize: '0.9375rem', marginLeft: '0.5rem' }}>
                        (${carpetSqftPrice(sku.cut_price)}/sqft)
                      </span>
                    </div>
                    {sku.roll_price && parseFloat(sku.roll_price) < parseFloat(sku.cut_price) && (
                      <div style={{ fontSize: '0.875rem', color: 'var(--sage)', marginTop: '0.375rem' }}>
                        Roll Price: ${parseFloat(sku.roll_price).toFixed(2)}/sqyd (${carpetSqftPrice(sku.roll_price)}/sqft)
                        {sku.roll_min_sqft && <span> — orders over {parseFloat(sku.roll_min_sqft).toFixed(0)} sqft</span>}
                      </div>
                    )}
                    {tradePrice && (
                      <div style={{ fontSize: '0.8125rem', color: 'var(--gold)', marginTop: '0.25rem' }}>Trade Price ({sku.trade_tier})</div>
                    )}
                  </>
                ) : tradePrice ? (
                  <>
                    <span style={{ textDecoration: 'line-through', color: 'var(--stone-500)', fontSize: '1.25rem', marginRight: '0.5rem' }}>
                      ${retailPrice.toFixed(2)}
                    </span>
                    ${tradePrice.toFixed(2)}
                    <span>{priceSuffix(sku)}</span>
                    <div style={{ fontSize: '0.8125rem', color: 'var(--gold)', marginTop: '0.25rem' }}>Trade Price ({sku.trade_tier})</div>
                  </>
                ) : salePrice ? (
                  <>
                    <span className="sale-original-price" style={{ fontSize: '1.25rem' }}>
                      ${retailPrice.toFixed(2)}
                    </span>
                    <span className="sale-price-text" style={{ fontSize: '1.75rem', fontWeight: 600 }}>
                      ${salePrice.toFixed(2)}
                    </span>
                    <span>{priceSuffix(sku)}</span>
                    <span className="sale-discount-tag">{Math.round((1 - salePrice / retailPrice) * 100)}% off</span>
                  </>
                ) : retailPrice > 0 ? (
                  <>${retailPrice.toFixed(2)}<span>{priceSuffix(sku)}</span></>
                ) : 'Contact for pricing'}
              </div>

              {/* Carpet Details Band */}
              {isCarpetSku && (() => {
                const attrMap = {};
                (sku.attributes || []).forEach(a => { attrMap[a.slug] = a.value; });
                const specs = [
                  attrMap.collection && { label: 'Collection', value: formatCarpetValue(attrMap.collection) },
                  attrMap.fiber && { label: 'Fiber', value: formatCarpetValue(attrMap.fiber) },
                  attrMap.construction && { label: 'Construction', value: formatCarpetValue(attrMap.construction) },
                  rollWidthFt > 0 && { label: 'Roll Width', value: rollWidthFt + ' ft' },
                ].filter(Boolean);
                if (specs.length === 0) return null;
                return (
                  <div className="carpet-specs-band">
                    {specs.map((s, i) => (
                      <div key={i} className="carpet-spec-card">
                        <div className="carpet-spec-card-label">{s.label}</div>
                        <div className="carpet-spec-card-value">{s.value}</div>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Variant Selectors */}
              {(() => {
                const currentAttrs = (sku.attributes || []).reduce((m, a) => { m[a.slug] = a.value; return m; }, {});
                const allSiblings = [{ sku_id: sku.sku_id, variant_name: sku.variant_name, attributes: sku.attributes || [], primary_image: (media && media[0]) ? media[0].url : null }, ...mainSiblings];

                if (isAdexProduct) {
                  // ADEX 3-row selector:
                  // Row 1: Color swatches — same product + same finish, different colors
                  // Row 2: Finish pills — same product + same color, different finishes
                  // Row 3: Variant grid — all OTHER pieces in collection matching color+finish

                  // Build unified list: current SKU + same-product siblings + collection siblings
                  const allCollection = [];
                  const seenIds = new Set();

                  // Current SKU
                  const curColorAttr = (sku.attributes || []).find(a => a.slug === 'color');
                  const curColor = curColorAttr ? curColorAttr.value : '';
                  const curFinishAttr = (sku.attributes || []).find(a => a.slug === 'finish');
                  const curFinish = curFinishAttr ? curFinishAttr.value : '';
                  // For color swatches, use SKU-level primary (color swatch), not shape/fallback image
                  const curSkuPrimary = media ? media.find(m => m.sku_id && m.asset_type === 'primary') : null;
                  allCollection.push({
                    sku_id: sku.sku_id, product_name: sku.product_name, variant_name: sku.variant_name,
                    primary_image: curSkuPrimary ? curSkuPrimary.url : null,
                    color: curColor, finish: curFinish
                  });
                  seenIds.add(sku.sku_id);

                  // Same-product siblings — use sku_image (SKU-only, no product fallback) for color swatches
                  mainSiblings.forEach(s => {
                    if (seenIds.has(s.sku_id)) return;
                    seenIds.add(s.sku_id);
                    const ca = (s.attributes || []).find(a => a.slug === 'color');
                    const fa = (s.attributes || []).find(a => a.slug === 'finish');
                    allCollection.push({ ...s, product_name: sku.product_name, color: ca ? ca.value : '', finish: fa ? fa.value : '', primary_image: s.sku_image || null });
                  });

                  // Collection siblings (primary_image is already SKU-only for ADEX from backend)
                  collectionSiblings.forEach(s => {
                    if (seenIds.has(s.sku_id)) return;
                    seenIds.add(s.sku_id);
                    allCollection.push({ ...s, color: s.color || '', finish: s.finish || '' });
                  });

                  if (allCollection.length > 1) {
                    // Helper: is this a "main" variant (not End Cap, Frame Corner, Beak, etc.)
                    const isMainVariant = (s) => {
                      const vn = s.variant_name || '';
                      return !/^(End Cap|Frame Corner|Beak|FE Corner)\s*-/i.test(vn);
                    };

                    // Row 1: colors for THIS product + THIS finish only (excluding accessories)
                    const sameProductFinish = allCollection.filter(s =>
                      s.product_name === sku.product_name && s.finish === curFinish && isMainVariant(s)
                    );
                    const uniqueColors = [...new Set(sameProductFinish.map(s => s.color))].filter(Boolean).sort();
                    const colorSwatches = uniqueColors.map(color => {
                      const rep = sameProductFinish.find(s => s.color === color);
                      return { color, sku_id: rep.sku_id, primary_image: rep.primary_image, is_current: color === curColor };
                    });

                    // Row 2: finishes for THIS product + THIS color only (excluding accessories)
                    const sameProductColor = allCollection.filter(s =>
                      s.product_name === sku.product_name && s.color === curColor && isMainVariant(s)
                    );
                    const finishesForColor = [...new Set(sameProductColor.map(s => s.finish))].sort();
                    const showFinishRow = finishesForColor.length > 1;

                    // Row 3: all OTHER pieces in collection matching current color + finish
                    const matchingVariants = allCollection.filter(s => s.color === curColor && s.finish === curFinish && s.sku_id !== sku.sku_id);

                    return (
                      <div className="variant-selectors">
                        {uniqueColors.length > 1 && (
                          <div className="variant-selector-group">
                            <div className="variant-selector-label">Color<span>{curColor}</span></div>
                            <div className="color-swatches">
                              {colorSwatches.map(c => (
                                <div key={c.color} className="color-swatch-wrap" onClick={() => { if (!c.is_current) onSkuClick(c.sku_id); }}>
                                  <div className={'color-swatch' + (c.is_current ? ' active' : '')}>
                                    {c.primary_image ? <img src={optimizeImg(c.primary_image, 120)} alt={c.color} loading="lazy" decoding="async" width="64" height="64" /> : <div style={{ width: '100%', height: '100%', background: 'var(--stone-100)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.625rem', fontWeight: 600, color: 'var(--stone-500)', textAlign: 'center', lineHeight: 1.2, padding: '4px' }}>{c.color}</div>}
                                  </div>
                                  <div className="color-swatch-tooltip">{c.color}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {showFinishRow && (
                          <div className="variant-selector-group">
                            <div className="variant-selector-label">Finish<span>{curFinish || 'Standard'}</span></div>
                            <div className="attr-pills">
                              {finishesForColor.map(f => {
                                const isActive = f === curFinish;
                                // Find same product+color in this finish (main variant, not accessory)
                                const match = sameProductColor.find(s => s.finish === f)
                                  || allCollection.find(s => s.color === curColor && s.finish === f && s.product_name === sku.product_name);
                                return (
                                  <button key={f || '_std'} className={'attr-pill' + (isActive ? ' active' : '')} onClick={() => { if (!isActive && match) onSkuClick(match.sku_id); }}>
                                    {f || 'Standard'}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}
                        {matchingVariants.length > 0 && (() => {
                          // Group variants by category (like James Martin "Complete the Look")
                          const categorize = (name, variantName) => {
                            const vn = variantName || '';
                            const dashIdx = vn.indexOf(' - ');
                            const prefix = dashIdx > 0 ? vn.substring(0, dashIdx) : '';
                            if (/^End Cap|^Frame Corner/i.test(prefix)) return 'Finishing Touches';
                            if (/^Beak/i.test(prefix)) return 'Decorative Accessories';
                            if (/^FE Corner/i.test(prefix)) return 'Finishing Edges';
                            if (/^Field Tile/i.test(name)) return 'Field Tiles';
                            if (/^Beveled/i.test(name)) return 'Beveled Tiles';
                            if (/Stripe Liner|Quarter Round|Round Bar|Ponciana/i.test(name)) return 'Decorative Accessories';
                            if (/Finishing Edge|^FE /i.test(name)) return 'Finishing Edges';
                            if (/^Sbn |^Dbn /i.test(name)) return 'Bullnoses';
                            if (/^Dge |^Sge |^Framed/i.test(name)) return 'Glazed Edges';
                            if (/Chair Molding|Crown Molding|Rail Molding|Base Board|Molding/i.test(name)) return 'Moldings & Trim';
                            if (/Deco|Border|Liner|Listello|Planet|Universe|Vizcaya|Flower|Gables|Palm Beach/i.test(name)) return 'Decorative Accents';
                            return 'Other Pieces';
                          };
                          const displayName = (s) => {
                            const vn = s.variant_name || '';
                            const dashIdx = vn.indexOf(' - ');
                            const prefix = dashIdx > 0 ? vn.substring(0, dashIdx) : '';
                            if (/^End Cap|^Frame Corner|^Beak|^FE Corner/i.test(prefix)) return s.product_name + ' — ' + prefix;
                            return s.product_name;
                          };
                          const groups = {};
                          matchingVariants.forEach(s => {
                            const cat = categorize(s.product_name || '', s.variant_name || '');
                            if (!groups[cat]) groups[cat] = [];
                            groups[cat].push(s);
                          });
                          const CATEGORY_ORDER = ['Field Tiles', 'Beveled Tiles', 'Decorative Accessories', 'Decorative Accents', 'Finishing Edges', 'Bullnoses', 'Glazed Edges', 'Moldings & Trim', 'Finishing Touches', 'Other Pieces'];
                          const orderedGroups = CATEGORY_ORDER.filter(cat => groups[cat] && groups[cat].length > 0);
                          return (
                            <div style={{ marginTop: '1.5rem' }}>
                              <div className="variant-selector-label" style={{ marginBottom: '0.75rem' }}>{curColor}{curFinish ? ' ' + curFinish : ''} — {sku.collection} Collection<span>{matchingVariants.length} pieces</span></div>
                              {orderedGroups.map(cat => (
                                <div key={cat} style={{ marginBottom: '1.25rem' }}>
                                  <div style={{ fontSize: '0.8125rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--stone-500)', marginBottom: '0.5rem' }}>{cat}</div>
                                  <div className="variant-grid">
                                    {groups[cat].map(s => (
                                      <div key={s.sku_id} className="sibling-card" onClick={() => onSkuClick(s.sku_id)}>
                                        <div className="sibling-card-image">
                                          {(s.shape_image || s.primary_image) && <img src={optimizeImg(s.shape_image || s.primary_image, 120)} alt={displayName(s)} loading="lazy" decoding="async" />}
                                        </div>
                                        <div className="sibling-card-name">{displayName(s)}</div>
                                        {s.retail_price && <div className="sibling-card-price">${displayPrice(s, s.retail_price).toFixed(2)}{priceSuffix(s)}</div>}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                    );
                  }
                }

                const colorItems = collectionSiblings.length > 0 ? [
                  { sku_id: sku.sku_id, product_name: sku.product_name, primary_image: (media && media[0]) ? media[0].url : null, is_current: true },
                  ...collectionSiblings
                ] : [];
                // Build attrMap from collection-wide attributes so pills persist across color switches
                const attrMap = {};
                const caData = collectionAttributes || {};
                Object.keys(caData).forEach(slug => {
                  attrMap[slug] = { name: caData[slug].name, values: new Set(caData[slug].values || []) };
                });
                // Merge local siblings to ensure current product's values are included
                allSiblings.forEach(s => {
                  (s.attributes || []).forEach(a => {
                    if (!attrMap[a.slug]) attrMap[a.slug] = { name: a.name, values: new Set() };
                    attrMap[a.slug].values.add(a.value);
                  });
                });
                const NON_SELECTABLE = new Set(['pei_rating', 'shade_variation', 'water_absorption', 'dcof', 'material', 'country', 'application', 'edge', 'look', 'color', 'color_code', 'style_code', 'price_list', 'companion_skus', 'species', 'subcategory', 'upc', 'msrp', 'weight', 'top_ref_sku', 'sink_ref_sku', 'optional_accessories', 'group_number', 'width', 'height', 'depth', 'hardware_finish', 'num_drawers', 'num_doors', 'num_shelves', 'num_sinks', 'soft_close', 'sink_material', 'sink_type', 'vanity_type', 'bowl_shape', 'style', 'origin', 'countertop_material', 'thickness', 'construction']);
                // Only show pills when this color/product actually has multiple options
                const localAttrCounts = {};
                allSiblings.forEach(s => {
                  (s.attributes || []).forEach(a => {
                    if (!localAttrCounts[a.slug]) localAttrCounts[a.slug] = new Set();
                    localAttrCounts[a.slug].add(a.value);
                  });
                });
                const attrSlugs = Object.keys(attrMap).filter(slug => localAttrCounts[slug] && localAttrCounts[slug].size > 1 && !NON_SELECTABLE.has(slug))
                  .sort((a, b) => a === 'finish' ? -1 : b === 'finish' ? 1 : 0);
                const sizeSort = (a, b) => { const na = parseFloat(a), nb = parseFloat(b); if (!isNaN(na) && !isNaN(nb)) return na - nb; return a.localeCompare(b); };
                const showColors = colorItems.length >= 2;
                const isRomanVariants = showColors && colorItems.some(c => hasRomanSuffix(c.product_name));
                const colorLabel = attrMap['countertop_finish'] ? 'Size' : isRomanVariants ? 'Style' : 'Color';
                const showAttrs = attrSlugs.length > 0;
                if (!showColors && !showAttrs) return null;
                return (
                  <div className="variant-selectors">
                    {showColors && (
                      <div className="variant-selector-group">
                        <div className="variant-selector-label">{colorLabel}</div>
                        {isRomanVariants ? (
                          <div className="attr-pills">
                            {[...colorItems].sort((a, b) => romanSortKey(a.product_name) - romanSortKey(b.product_name)).map(c => (
                                <button key={c.sku_id} className={'attr-pill' + (c.is_current ? ' active' : '')} onClick={() => { if (!c.is_current) onSkuClick(c.sku_id); }}>
                                  {c.product_name}
                                </button>
                            ))}
                          </div>
                        ) : (
                          <div className="color-swatches">
                            {colorItems.map(c => (
                              <div key={c.sku_id} className="color-swatch-wrap" onClick={() => { if (!c.is_current) onSkuClick(c.sku_id); }}>
                                <div className={'color-swatch' + (c.is_current ? ' active' : '')}>
                                  {c.primary_image ? <img src={optimizeImg(c.primary_image, 120)} alt={c.product_name} loading="lazy" decoding="async" width="64" height="64" /> : <div style={{ width: '100%', height: '100%', background: 'var(--stone-100)' }} />}
                                </div>
                                <div className="color-swatch-tooltip">{c.product_name}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {showAttrs && attrSlugs.map(slug => {
                      const allValues = [...attrMap[slug].values].sort(sizeSort);
                      const currentVal = currentAttrs[slug];
                      // Filter values: only show values that exist in siblings matching current selections of OTHER attributes
                      const values = allValues.filter(val => {
                        return allSiblings.some(s => {
                          const sa = (s.attributes || []).reduce((m, a) => { m[a.slug] = a.value; return m; }, {});
                          if (sa[slug] !== val) return false;
                          return attrSlugs.every(otherSlug => {
                            if (otherSlug === slug) return true;
                            return !currentAttrs[otherSlug] || sa[otherSlug] === currentAttrs[otherSlug];
                          });
                        });
                      });
                      if (values.length <= 1 && !currentVal) return null;
                      const findBest = (val) => {
                        // Only consider siblings that match the target attribute value
                        const matching = allSiblings.filter(s => {
                          if (s.sku_id === sku.sku_id) return false;
                          const sa = (s.attributes || []).reduce((m, a) => { m[a.slug] = a.value; return m; }, {});
                          return sa[slug] === val;
                        });
                        if (matching.length === 0) return null;
                        if (matching.length === 1) return matching[0];
                        // Score by other selectable attributes to find best match
                        const scored = matching.map(s => {
                          const sa = (s.attributes || []).reduce((m, a) => { m[a.slug] = a.value; return m; }, {});
                          let score = 0;
                          attrSlugs.forEach(k => { if (k !== slug && sa[k] === currentAttrs[k]) score++; });
                          return { ...s, score };
                        });
                        return scored.sort((a, b) => b.score - a.score)[0];
                      };
                      // Use image swatches for countertop_finish and finish (vanity tops)
                      const useImageSwatches = (slug === 'countertop_finish' || slug === 'finish') && values.length <= 10;
                      const getSwatchImage = (val) => {
                        if (val === currentVal) {
                          if (slug === 'countertop_finish' && countertopImage) return countertopImage;
                          return (media && media[0]) ? media[0].url : null;
                        }
                        const match = findBest(val);
                        if (!match) return null;
                        if (slug === 'countertop_finish') return match.countertop_image || match.primary_image;
                        return match.primary_image;
                      };
                      return (
                        <div key={slug} className="variant-selector-group">
                          <div className="variant-selector-label">{slug === 'finish' && attrMap['countertop_finish'] ? 'Cabinet Color' : slug === 'countertop_finish' ? 'Countertop' : attrMap[slug].name}<span>{formatCarpetValue(currentVal || '')}</span></div>
                          {values.length > 10 ? (
                            <select className="attr-select" value={currentVal || ''} onChange={(e) => {
                              const best = findBest(e.target.value);
                              if (best) onSkuClick(best.sku_id);
                            }}>
                              {values.map(val => <option key={val} value={val}>{formatCarpetValue(val)}</option>)}
                            </select>
                          ) : useImageSwatches ? (
                            <div className="color-swatches">
                              {values.map(val => {
                                const isActive = val === currentVal;
                                const img = getSwatchImage(val);
                                const best = findBest(val);
                                return (
                                  <div key={val} className="color-swatch-wrap" onClick={() => { if (!isActive && best) onSkuClick(best.sku_id); }}>
                                    <div className={'color-swatch' + (isActive ? ' active' : '')}>
                                      {img ? <img src={optimizeImg(img, 120)} alt={formatCarpetValue(val)} loading="lazy" decoding="async" width="64" height="64" /> : <div style={{ width: '100%', height: '100%', background: 'var(--stone-100)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6rem', color: 'var(--stone-500)', textAlign: 'center', padding: '0.25rem' }}>{formatCarpetValue(val)}</div>}
                                    </div>
                                    <div className="color-swatch-tooltip">{formatCarpetValue(val)}</div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="attr-pills">
                              {values.map(val => {
                                const isActive = val === currentVal;
                                const best = findBest(val);
                                return (
                                  <button key={val} className={'attr-pill' + (isActive ? ' active' : '')} onClick={() => { if (!isActive && best) onSkuClick(best.sku_id); }}>
                                    {formatCarpetValue(val)}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              <StockBadge status={sku.stock_status} vendorHasInventory={sku.vendor_has_inventory} />

              {/* Stock Alert — Notify Me */}
              {sku.stock_status === 'out_of_stock' && sku.vendor_has_inventory !== false && (
                <div className="stock-alert-box">
                  {alertSuccess || alertSubscribed ? (
                    <div className="stock-alert-success">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#166534" strokeWidth="2"><path d="M20 6L9 17l-5-5"/></svg>
                      We'll notify you when this item is back in stock
                    </div>
                  ) : customer ? (
                    <>
                      <p>Get notified when this item is back in stock</p>
                      <button className="stock-alert-btn" onClick={handleStockAlertSubmit} disabled={alertLoading}>
                        {alertLoading ? 'Subscribing...' : 'Notify Me When Available'}
                      </button>
                    </>
                  ) : (
                    <>
                      <p>Get notified when this item is back in stock</p>
                      <div className="stock-alert-form">
                        <input type="email" placeholder="Enter your email" value={alertEmail} onChange={e => setAlertEmail(e.target.value)} />
                        <button className="stock-alert-btn" onClick={handleStockAlertSubmit} disabled={alertLoading || !alertEmail}>
                          {alertLoading ? 'Subscribing...' : 'Notify Me'}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Matching Accessories */}
              {accessorySiblings.length > 0 && (
                <div className="accessories-section-sf">
                  <h3>Matching Accessories</h3>
                  <p className="accessories-subtitle-sf">Complete your installation with coordinating trim and transitions</p>
                  {accessorySiblings.map(acc => {
                    const accPrice = parseFloat(acc.retail_price) || 0;
                    const accQty = accessoryQtys[acc.sku_id] || 1;
                    return (
                      <div key={acc.sku_id} className="accessory-card-sf">
                        <div className="accessory-card-sf-header">
                          <div className="accessory-card-sf-name">{formatVariantName(acc.variant_name) || 'Accessory'}</div>
                          <div className="accessory-card-sf-price">${accPrice.toFixed(2)} /ea</div>
                        </div>
                        <div className="accessory-card-sf-actions">
                          <div className="unit-qty-stepper">
                            <button onClick={() => setAccessoryQtys(prev => ({ ...prev, [acc.sku_id]: Math.max(1, (prev[acc.sku_id] || 1) - 1) }))}>&minus;</button>
                            <input type="number" min="1" value={accQty} onChange={(e) => setAccessoryQtys(prev => ({ ...prev, [acc.sku_id]: Math.max(1, parseInt(e.target.value) || 1) }))} />
                            <button onClick={() => setAccessoryQtys(prev => ({ ...prev, [acc.sku_id]: (prev[acc.sku_id] || 1) + 1 }))}>+</button>
                          </div>
                          <button className="btn" style={{ padding: '0.6rem 1.5rem', fontSize: '0.8125rem' }} onClick={() => {
                            addToCart({
                              product_id: sku.product_id,
                              sku_id: acc.sku_id,
                              sqft_needed: 0,
                              num_boxes: accQty,
                              include_overage: false,
                              unit_price: accPrice,
                              subtotal: (accQty * accPrice).toFixed(2),
                              sell_by: 'unit'
                            });
                          }}>
                            Add &mdash; ${(accQty * accPrice).toFixed(2)}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Packaging Info (box-based products) */}
              {!isCarpetSku && sqftPerBox > 0 && (
                <div className="packaging-info">
                  <h4>Packaging Details</h4>
                  <div>Coverage: {sqftPerBox} sqft/box</div>
                  {sku.pieces_per_box && <div>Pieces: {sku.pieces_per_box}/box</div>}
                  {sku.weight_per_box_lbs && <div>Weight: {parseFloat(sku.weight_per_box_lbs).toFixed(1)} lbs/box</div>}
                  {sku.boxes_per_pallet && <div>Pallet: {sku.boxes_per_pallet} boxes ({parseFloat(sku.sqft_per_pallet || 0).toFixed(0)} sqft)</div>}
                </div>
              )}

              {/* Roll Specifications (carpet products) */}
              {isCarpetSku && (rollWidthFt > 0 || rollLengthFt > 0 || sku.sqft_per_pallet || sku.weight_per_pallet_lbs) && (
                <div className="carpet-roll-info">
                  <h4>Roll Specifications</h4>
                  <div className="carpet-roll-info-grid">
                    {rollWidthFt > 0 && (
                      <div className="carpet-roll-info-row">
                        <span className="carpet-roll-info-label">Roll Width</span>
                        <span className="carpet-roll-info-value">{rollWidthFt} ft</span>
                      </div>
                    )}
                    {rollLengthFt > 0 && (
                      <div className="carpet-roll-info-row">
                        <span className="carpet-roll-info-label">Roll Length</span>
                        <span className="carpet-roll-info-value">{rollLengthFt} ft</span>
                      </div>
                    )}
                    {sku.sqft_per_pallet && parseFloat(sku.sqft_per_pallet) > 0 && (
                      <div className="carpet-roll-info-row">
                        <span className="carpet-roll-info-label">Roll Area</span>
                        <span className="carpet-roll-info-value">{parseFloat(sku.sqft_per_pallet).toLocaleString()} sqft</span>
                      </div>
                    )}
                    {sku.weight_per_pallet_lbs && parseFloat(sku.weight_per_pallet_lbs) > 0 && (
                      <div className="carpet-roll-info-row">
                        <span className="carpet-roll-info-label">Roll Weight</span>
                        <span className="carpet-roll-info-value">{parseFloat(sku.weight_per_pallet_lbs).toLocaleString()} lbs</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Carpet Calculator */}
              {isCarpetSku && cutPrice > 0 && (
                <div className="calculator-widget">
                  <h3>Carpet Calculator</h3>
                  {rollWidthFt > 0 && (
                    <div className="carpet-roll-width-header">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 20, height: 20 }}><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg>
                      {rollWidthFt}' Wide Roll
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '0.375rem', marginBottom: '1rem' }}>
                    {rollWidthFt > 0 && (
                      <button
                        onClick={() => setCarpetInputMode('linear')}
                        style={{ flex: 1, padding: '0.4375rem 0.25rem', border: '1px solid var(--stone-300)', borderRadius: '0.25rem', cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 500, background: carpetInputMode === 'linear' ? 'var(--stone-900)' : 'white', color: carpetInputMode === 'linear' ? 'white' : 'var(--stone-700)', transition: 'all 0.15s' }}>
                        Linear Feet
                      </button>
                    )}
                    <button
                      onClick={() => setCarpetInputMode('dimensions')}
                      style={{ flex: 1, padding: '0.4375rem 0.25rem', border: '1px solid var(--stone-300)', borderRadius: '0.25rem', cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 500, background: carpetInputMode === 'dimensions' ? 'var(--stone-900)' : 'white', color: carpetInputMode === 'dimensions' ? 'white' : 'var(--stone-700)', transition: 'all 0.15s' }}>
                      Room Size
                    </button>
                    <button
                      onClick={() => setCarpetInputMode('sqft')}
                      style={{ flex: 1, padding: '0.4375rem 0.25rem', border: '1px solid var(--stone-300)', borderRadius: '0.25rem', cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 500, background: carpetInputMode === 'sqft' ? 'var(--stone-900)' : 'white', color: carpetInputMode === 'sqft' ? 'white' : 'var(--stone-700)', transition: 'all 0.15s' }}>
                      Enter Sqft
                    </button>
                  </div>
                  {carpetInputMode === 'linear' ? (
                    <div className="calc-input-row">
                      <div className="calc-input-group" style={{ flex: 1 }}>
                        <label>Linear Feet Needed</label>
                        <input className="calc-input" type="number" min="0" step="0.5" placeholder="e.g. 50"
                          value={linearFeet} onChange={(e) => setLinearFeet(e.target.value)} />
                      </div>
                    </div>
                  ) : carpetInputMode === 'dimensions' ? (
                    <div className="calc-input-row">
                      <div className="calc-input-group">
                        <label>Room Width (ft)</label>
                        <input className="calc-input" type="number" min="0" step="0.5" placeholder="0"
                          value={roomWidth} onChange={(e) => setRoomWidth(e.target.value)} />
                      </div>
                      <div style={{ display: 'flex', alignItems: 'flex-end', padding: '0 0.25rem 0.5rem', fontSize: '1.25rem', color: 'var(--stone-400)' }}>&times;</div>
                      <div className="calc-input-group">
                        <label>Room Length (ft)</label>
                        <input className="calc-input" type="number" min="0" step="0.5" placeholder="0"
                          value={roomLength} onChange={(e) => setRoomLength(e.target.value)} />
                      </div>
                    </div>
                  ) : (
                    <div className="calc-input-row">
                      <div className="calc-input-group" style={{ flex: 1 }}>
                        <label>Square Feet Needed</label>
                        <input className="calc-input" type="number" min="0" step="1" placeholder="Enter sqft"
                          value={sqftInput} onChange={(e) => setSqftInput(e.target.value)} />
                      </div>
                    </div>
                  )}
                  <label className="carpet-overage-label">
                    <input type="checkbox" checked={includeCarpetOverage} onChange={(e) => setIncludeCarpetOverage(e.target.checked)} />
                    Add 10% overage for seams &amp; pattern matching
                  </label>
                  {carpetNeedsSeam && (
                    <div className="carpet-seam-note">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                      Room width ({parseFloat(roomWidth).toFixed(0)}') exceeds roll width ({rollWidthFt}') — a seam will be required
                    </div>
                  )}
                  {carpetSqft > 0 && (
                    <div className="calc-summary">
                      {carpetInputMode === 'linear' && rollWidthFt > 0 && (
                        <div className="calc-summary-row">
                          <span>Cut Size</span><span>{rollWidthFt} ft &times; {parseFloat(linearFeet).toFixed(1)} ft = {carpetRawSqft.toFixed(1)} sqft ({(carpetRawSqft / 9).toFixed(1)} sqyd)</span>
                        </div>
                      )}
                      {includeCarpetOverage && (
                        <div className="calc-summary-row">
                          <span>+ 10% Overage</span><span>{carpetSqft.toFixed(1)} sqft</span>
                        </div>
                      )}
                      {!includeCarpetOverage && (
                        <div className="calc-summary-row">
                          <span>Area</span><span>{carpetSqft.toFixed(1)} sqft ({carpetSqyd.toFixed(1)} sqyd)</span>
                        </div>
                      )}
                      <div className="calc-summary-row">
                        <span>Price Tier</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem' }}>
                          <span style={{ display: 'inline-block', padding: '0.125rem 0.5rem', borderRadius: '0.25rem', fontSize: '0.75rem', fontWeight: 600, background: carpetPriceTier === 'roll' ? 'var(--sage)' : 'var(--stone-200)', color: carpetPriceTier === 'roll' ? 'white' : 'var(--stone-700)' }}>
                            {carpetPriceTier === 'roll' ? 'Roll Price' : 'Cut Price'}
                          </span>
                          ${carpetActivePrice.toFixed(2)}/sqyd
                        </span>
                      </div>
                      {carpetEstWeight > 0 && (
                        <div className="calc-summary-row">
                          <span>Est. Weight</span><span>{carpetEstWeight.toFixed(0)} lbs</span>
                        </div>
                      )}
                      <div className="calc-summary-total"><span>Subtotal</span><span>${carpetSubtotal.toFixed(2)}</span></div>
                    </div>
                  )}
                  {carpetSqftToRoll > 0 && parseFloat(carpetRollSavings) > 0 && (
                    <div style={{ background: 'var(--sage-bg, #f0f7f4)', border: '1px solid var(--sage, #6b9080)', borderRadius: '0.375rem', padding: '0.625rem 0.75rem', fontSize: '0.8125rem', color: 'var(--sage, #6b9080)', marginTop: '0.5rem' }}>
                      Add {carpetSqftToRoll.toFixed(0)} more sqft for roll pricing — save ${carpetRollSavings}
                    </div>
                  )}
                  <button className="btn" style={{ width: '100%', marginTop: '1.5rem' }}
                    onClick={handleAddToCart} disabled={carpetSqft <= 0}>
                    Add to Cart {carpetSqft > 0 ? `- $${carpetSubtotal.toFixed(2)}` : ''}
                  </button>
                </div>
              )}

              {/* Coverage Calculator (box-based products) */}
              {!isCarpetSku && hasBoxCalc && effectivePrice > 0 && (
                <div className="calculator-widget">
                  <h3>Coverage Calculator</h3>
                  <div className="calc-input-row">
                    <div className="calc-input-group">
                      <label>Square Feet Needed</label>
                      <input className="calc-input" type="number" min="0" step="1" placeholder="0"
                        value={sqftInput} onChange={(e) => handleSqftChange(e.target.value)} />
                    </div>
                    <div className="calc-input-group">
                      <label>Boxes</label>
                      <input className="calc-input" type="number" min="0" step="1" placeholder="0"
                        value={boxesInput} onChange={(e) => handleBoxesChange(e.target.value)} />
                    </div>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', cursor: 'pointer', marginBottom: '1rem' }}>
                    <input type="checkbox" checked={includeOverage} onChange={(e) => setIncludeOverage(e.target.checked)} />
                    Add 10% overage for cuts &amp; breakage
                  </label>
                  {numBoxes > 0 && (
                    <div className="calc-summary">
                      <div className="calc-summary-row"><span>Boxes Needed</span><span>{numBoxes}</span></div>
                      <div className="calc-summary-row"><span>Total Coverage</span><span>{actualSqft.toFixed(1)} sqft</span></div>
                      {numBoxes > 0 && sku.weight_per_box_lbs && (
                        <div className="calc-summary-row"><span>Est. Weight</span><span>{(numBoxes * parseFloat(sku.weight_per_box_lbs)).toFixed(0)} lbs</span></div>
                      )}
                      <div className="calc-summary-total"><span>Subtotal</span><span>${subtotal.toFixed(2)}</span></div>
                    </div>
                  )}
                  <button className="btn" style={{ width: '100%', marginTop: '1.5rem' }}
                    onClick={handleAddToCart} disabled={numBoxes <= 0}>
                    Add to Cart {numBoxes > 0 ? `- $${subtotal.toFixed(2)}` : ''}
                  </button>
                </div>
              )}

              {/* Sqft entry without box calculator (no packaging data) */}
              {!isCarpetSku && isSqftNoBox && effectivePrice > 0 && (
                <div className="calculator-widget">
                  <h3>Order by Square Footage</h3>
                  <div className="calc-input-row">
                    <div className="calc-input-group" style={{ flex: 1 }}>
                      <label>Square Feet Needed</label>
                      <input className="calc-input" type="number" min="0" step="1" placeholder="Enter sqft"
                        value={sqftInput} onChange={(e) => setSqftInput(e.target.value)} />
                    </div>
                  </div>
                  {parseFloat(sqftInput) > 0 && (
                    <div className="calc-summary">
                      <div className="calc-summary-total"><span>Subtotal</span><span>${sqftOnlySubtotal.toFixed(2)}</span></div>
                    </div>
                  )}
                  <button className="btn" style={{ width: '100%', marginTop: '1.5rem' }}
                    onClick={handleAddToCart} disabled={!(parseFloat(sqftInput) > 0)}>
                    Add to Cart {parseFloat(sqftInput) > 0 ? `- $${sqftOnlySubtotal.toFixed(2)}` : ''}
                  </button>
                </div>
              )}

              {/* Per-unit add to cart (slabs, mosaics, etc.) */}
              {isPerUnit && (
                <div className="unit-add-to-cart">
                  <div className="unit-qty-row">
                    <span className="unit-qty-label">Quantity</span>
                    <div className="unit-qty-stepper">
                      <button onClick={() => setUnitQty(q => Math.max(1, q - 1))}>&minus;</button>
                      <input type="number" min="1" step="1"
                        value={unitQty} onChange={(e) => setUnitQty(Math.max(1, parseInt(e.target.value) || 1))} />
                      <button onClick={() => setUnitQty(q => q + 1)}>+</button>
                    </div>
                  </div>
                  <button className="btn" style={{ width: '100%' }}
                    onClick={handleAddToCart} disabled={unitQty <= 0}>
                    {effectivePrice > 0 ? `Add to Cart — $${unitSubtotal.toFixed(2)}` : 'Add to Cart'}
                  </button>
                </div>
              )}

              {/* Visualize in Your Room — Roomvo enables this button automatically when the SKU is recognized */}
              <button className="btn roomvo-visualize-btn"
                ref={el => { try { if (el && window.roomvo) window.roomvo.enableButtonForVisualization(el); } catch(e) {} }}
                data-sku={sku.vendor_sku || sku.internal_sku}
                style={{ width: '100%', marginBottom: '1rem', padding: '1.125rem 2rem', fontSize: '0.875rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.625rem', visibility: 'hidden' }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 22, height: 22 }}>
                  <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/>
                  <polyline points="9 22 9 12 15 12 15 22"/>
                </svg>
                Visualize in Your Room
              </button>

              {/* Sample CTA */}
              <button className="btn btn-secondary" style={{ width: '100%', marginBottom: '1rem' }} onClick={handleRequestSample}>
                Request Free Sample
              </button>

              {/* Wishlist */}
              {sku && (
                <button className="btn btn-secondary" style={{ width: '100%', marginBottom: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
                  onClick={() => toggleWishlist(sku.product_id)}>
                  <svg viewBox="0 0 24 24" fill={wishlist.includes(sku.product_id) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" style={{ width: 18, height: 18, color: wishlist.includes(sku.product_id) ? '#e11d48' : 'currentColor' }}>
                    <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/>
                  </svg>
                  {wishlist.includes(sku.product_id) ? 'Saved to Wishlist' : 'Add to Wishlist'}
                </button>
              )}

              {/* Installation CTA */}
              <div className="install-cta">
                <p>Need professional installation?</p>
                <button className="btn btn-secondary" onClick={() => onRequestInstall(sku)}>Request Installation Quote</button>
              </div>

            </div>
            </div>{/* end .sku-detail-main */}

            {/* Complete the Look — grouped companion products (mirrors, cabinets, tops) */}
            {groupedProducts.length > 0 && (() => {
              const byCategory = {};
              groupedProducts.forEach(gp => {
                const cat = gp.category_name || 'Related';
                if (!byCategory[cat]) byCategory[cat] = [];
                byCategory[cat].push(gp);
              });
              return (
                <div className="siblings-section">
                  <h2>Complete the Look</h2>
                  {Object.entries(byCategory).map(([catName, items]) => (
                    <div key={catName} style={{ marginBottom: '1.5rem' }}>
                      <div style={{ fontSize: '0.8125rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--stone-500)', marginBottom: '0.75rem' }}>{catName}</div>
                      <div className="siblings-strip">
                        {items.map(s => (
                          <div key={s.sku_id} className="sibling-card" onClick={() => onSkuClick(s.sku_id)}>
                            <div className="sibling-card-image">
                              {s.primary_image && <img src={optimizeImg(s.primary_image, 400)} alt={s.product_name} loading="lazy" decoding="async" />}
                            </div>
                            <div className="sibling-card-name">{s.product_name}</div>
                            {s.retail_price && <div className="sibling-card-price">from ${displayPrice(s, s.retail_price).toFixed(2)}{priceSuffix(s)}</div>}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Same Product Siblings (non-accessory) — hidden for ADEX (brochure catalog below covers it) */}
            {!isAdexProduct && mainSiblings.length > 0 && (
              <div className="siblings-section">
                <h2>Other Sizes &amp; Finishes</h2>
                <div className="siblings-strip">
                  {mainSiblings.map(s => (
                    <div key={s.sku_id} className="sibling-card" onClick={() => onSkuClick(s.sku_id)}>
                      <div className="sibling-card-image">
                        {s.primary_image && <img src={optimizeImg(s.primary_image, 400)} alt={formatVariantName(s.variant_name)} loading="lazy" decoding="async" />}
                      </div>
                      <div className="sibling-card-name">{formatCarpetValue(s.variant_name) || 'Variant'}</div>
                      {s.attributes && s.attributes.length > 0 && (() => {
                        const SKIP = new Set(['price_list', 'material_class', 'style_code', 'subcategory', 'upc', 'color', 'color_code', 'collection', 'material']);
                        const useful = s.attributes.filter(a => !SKIP.has(a.slug));
                        // Only show attrs that differ from the current SKU
                        const currentVals = (sku.attributes || []).reduce((m, a) => { m[a.slug] = a.value; return m; }, {});
                        const differing = useful.filter(a => currentVals[a.slug] !== a.value);
                        if (differing.length === 0) return null;
                        return <div className="sibling-card-meta">{differing.map(a => formatCarpetValue(a.value)).join(' \u00B7 ')}</div>;
                      })()}
                      {s.retail_price && <div className="sibling-card-price">${displayPrice(s, s.retail_price).toFixed(2)}{priceSuffix(s)}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Collection Siblings */}
            {(() => {
              // ADEX: swatch grid in variant selector already shows all collection variants
              if (isAdexProduct) return null;
              // Default: flat strip for non-ADEX products
              if (collectionSiblings.length === 0) return null;
              return (
                <div className="siblings-section">
                  <h2>More from {sku.collection}</h2>
                  <div className="siblings-strip">
                    {collectionSiblings.map(s => (
                      <div key={s.sku_id} className="sibling-card" onClick={() => onSkuClick(s.sku_id)}>
                        <div className="sibling-card-image">
                          {s.primary_image && <img src={optimizeImg(s.primary_image, 400)} alt={s.product_name} loading="lazy" decoding="async" />}
                        </div>
                        <div className="sibling-card-name">{fullProductName(s)}</div>
                        {s.retail_price && <div className="sibling-card-price">${displayPrice(s, s.retail_price).toFixed(2)}{priceSuffix(s)}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {recentlyViewed && recentlyViewed.filter(r => r.sku_id !== skuId).length > 0 && (
              <div className="siblings-section">
                <h2>Recently Viewed</h2>
                <div className="siblings-strip">
                  {recentlyViewed.filter(r => r.sku_id !== skuId).slice(0, 8).map(s => (
                    <div key={s.sku_id} className="sibling-card" onClick={() => onSkuClick(s.sku_id)}>
                      <div className="sibling-card-image">
                        {s.primary_image && <img src={optimizeImg(s.primary_image, 400)} alt={s.product_name} loading="lazy" decoding="async" />}
                      </div>
                      <div className="sibling-card-name">{fullProductName(s)}</div>
                      {s.retail_price && <div className="sibling-card-price">${displayPrice(s, s.retail_price).toFixed(2)}{priceSuffix(s)}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Customer Reviews */}
            <div className="reviews-section">
              <h2>Customer Reviews</h2>
              {reviewCount > 0 && (
                <div className="reviews-summary">
                  <div className="reviews-summary-rating">{avgRating.toFixed(1)}</div>
                  <div className="reviews-summary-stars"><StarDisplay rating={avgRating} size={20} /></div>
                  <div className="reviews-summary-count">{reviewCount} review{reviewCount !== 1 ? 's' : ''}</div>
                </div>
              )}
              {reviews.length > 0 ? reviews.map(r => (
                <div key={r.id} className="review-card">
                  <div className="review-card-header">
                    <StarDisplay rating={r.rating} size={14} />
                    <span className="review-card-author">{r.first_name}</span>
                    <span className="review-card-date">{new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                  </div>
                  {r.title && <div className="review-card-title">{r.title}</div>}
                  {r.body && <div className="review-card-body">{r.body}</div>}
                </div>
              )) : (
                <p style={{ color: 'var(--stone-400)', fontSize: '0.875rem' }}>No reviews yet. Be the first to share your experience.</p>
              )}

              {customer ? (
                <div className="review-form">
                  <h3>{reviewSubmitted ? 'Update Your Review' : 'Write a Review'}</h3>
                  <div className="star-picker">
                    {[1,2,3,4,5].map(i => (
                      <button key={i}
                        className={(i <= (reviewHover || reviewRating) ? 'active' : '') + (i <= reviewHover ? ' hover' : '')}
                        onMouseEnter={() => setReviewHover(i)}
                        onMouseLeave={() => setReviewHover(0)}
                        onClick={() => setReviewRating(i)}
                      >&#9733;</button>
                    ))}
                  </div>
                  <input type="text" placeholder="Review title (optional)" value={reviewTitle} onChange={e => setReviewTitle(e.target.value)} maxLength={200} />
                  <textarea placeholder="Share your experience with this product..." value={reviewBody} onChange={e => setReviewBody(e.target.value)} />
                  <button className="btn" onClick={handleReviewSubmit} disabled={reviewSubmitting || reviewRating < 1}>
                    {reviewSubmitting ? 'Submitting...' : reviewSubmitted ? 'Update Review' : 'Submit Review'}
                  </button>
                </div>
              ) : (
                <p className="review-login-prompt">
                  <a onClick={onShowAuth}>Sign in</a> to write a review
                </p>
              )}
            </div>
          </div>
        </>
      );
    }

    // ==================== Cart Page ====================

    function CartPage({ cart, goBrowse, removeFromCart, updateCartItem, goCheckout, deliveryMethod, setDeliveryMethod, sessionId, appliedPromoCode, setAppliedPromoCode, goHome }) {
      const [shippingZip, setShippingZip] = useState('');
      const [shippingEstimate, setShippingEstimate] = useState(null);
      const [shippingLoading, setShippingLoading] = useState(false);
      const [shippingError, setShippingError] = useState('');
      const [selectedShippingOption, setSelectedShippingOption] = useState(null);
      const [liftgateEnabled, setLiftgateEnabled] = useState(true);
      const [promoCode, setPromoCode] = useState(appliedPromoCode || '');
      const [promoResult, setPromoResult] = useState(null);
      const [promoLoading, setPromoLoading] = useState(false);
      const [promoError, setPromoError] = useState('');
      const promoSubtotalRef = useRef(null);

      const productItems = cart.filter(i => !i.is_sample);
      const sampleItems = cart.filter(i => i.is_sample);
      const productSubtotal = productItems.reduce((sum, i) => sum + parseFloat(i.subtotal || 0), 0);
      const sampleShipping = sampleItems.length > 0 ? 12 : 0;
      const productShipping = deliveryMethod === 'pickup' ? 0 : (selectedShippingOption ? selectedShippingOption.amount : 0);
      const promoDiscount = promoResult ? promoResult.discount_amount : 0;
      const cartTotal = Math.max(0, productSubtotal + productShipping + sampleShipping - promoDiscount);

      useEffect(() => {
        if (promoResult && promoSubtotalRef.current !== null && promoSubtotalRef.current !== productSubtotal) {
          setPromoResult(null);
          setPromoError('');
          setAppliedPromoCode(null);
        }
        promoSubtotalRef.current = productSubtotal;
      }, [productSubtotal]);

      useEffect(() => {
        if (appliedPromoCode && !promoResult && cart.length > 0) {
          applyPromoCode(appliedPromoCode);
        }
      }, []);

      const applyPromoCode = (codeOverride) => {
        const code = codeOverride || promoCode.trim();
        if (!code) return;
        setPromoLoading(true);
        setPromoError('');
        fetch(API + '/api/promo-codes/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, session_id: sessionId })
        })
          .then(r => r.json())
          .then(data => {
            if (data.valid) {
              setPromoResult(data);
              setPromoError('');
              setAppliedPromoCode(data.code);
              setPromoCode(data.code);
            } else {
              setPromoResult(null);
              setPromoError(data.error || 'Invalid promo code');
              setAppliedPromoCode(null);
            }
            setPromoLoading(false);
          })
          .catch(() => {
            setPromoError('Unable to validate promo code');
            setPromoLoading(false);
          });
      };

      const removePromo = () => {
        setPromoResult(null);
        setPromoCode('');
        setPromoError('');
        setAppliedPromoCode(null);
      };

      const boxItems = productItems.filter(i => i.sell_by !== 'unit');
      const unitItems = productItems.filter(i => i.sell_by === 'unit');
      const totalBoxes = boxItems.reduce((sum, i) => sum + (parseInt(i.num_boxes) || 0), 0);
      const totalUnits = unitItems.reduce((sum, i) => sum + (parseInt(i.num_boxes) || 0), 0);
      const hasPickupOnly = productItems.some(i => i.pickup_only);

      useEffect(() => {
        if (hasPickupOnly) setDeliveryMethod('pickup');
      }, [hasPickupOnly]);

      const fetchShippingEstimate = () => {
        const zip = shippingZip.trim();
        if (!zip || zip.length < 5) return;
        setShippingLoading(true);
        setShippingError('');
        setSelectedShippingOption(null);
        fetch(API + '/api/shipping/estimate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, destination: { zip }, residential: true, liftgate: liftgateEnabled })
        })
          .then(r => r.json())
          .then(data => {
            if (data.error) {
              setShippingError(data.error);
              setShippingEstimate(null);
              setSelectedShippingOption(null);
            } else {
              setShippingEstimate(data);
              setShippingError('');
              const opts = data.options || [];
              const cheapest = opts.find(o => o.is_cheapest) || opts[0];
              setSelectedShippingOption(cheapest || null);
            }
            setShippingLoading(false);
          })
          .catch(() => {
            setShippingError('Unable to estimate shipping');
            setShippingLoading(false);
          });
      };

      const handleQtyChange = (item, delta) => {
        const newBoxes = Math.max(1, (parseInt(item.num_boxes) || 0) + delta);
        const unitPrice = parseFloat(item.unit_price) || 0;
        if (item.sell_by === 'unit') {
          const newSubtotal = (newBoxes * unitPrice).toFixed(2);
          updateCartItem(item.id, { num_boxes: newBoxes, subtotal: newSubtotal });
        } else {
          const sqftPerBox = item.sqft_needed && item.num_boxes ? parseFloat(item.sqft_needed) / parseInt(item.num_boxes) : 17.11;
          const newSqft = (newBoxes * sqftPerBox).toFixed(2);
          const newSubtotal = (newBoxes * sqftPerBox * unitPrice).toFixed(2);
          updateCartItem(item.id, { num_boxes: newBoxes, sqft_needed: newSqft, subtotal: newSubtotal });
        }
        setShippingEstimate(null);
        setSelectedShippingOption(null);
      };

      return (
        <div className="cart-page">
          <Breadcrumbs items={[
            { label: 'Home', onClick: goHome },
            { label: 'Cart' }
          ]} />
          <a className="back-btn" onClick={goBrowse}>&larr; Continue Shopping</a>
          <h1>Your Cart</h1>

          {cart.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '4rem 0', color: 'var(--stone-600)' }}>
              <p style={{ fontSize: '1.125rem', marginBottom: '2rem' }}>Your cart is empty</p>
              <button className="btn" onClick={goBrowse}>Browse Products</button>
            </div>
          ) : (
            <div className="cart-page-layout">
              <div>
                <div className="cart-table">
                  <div className="cart-table-header">
                    <div>Product</div><div>Quantity</div><div>Coverage</div><div>Total</div><div></div>
                  </div>
                  {cart.map(item => (
                    <div key={item.id} className={'cart-table-row' + (item.is_sample ? ' sample-item' : '')}>
                      <div>
                        <div className="cart-table-product-name">
                          {fullProductName(item) || 'Product'}
                          {item.is_sample && <span className="sample-tag">Sample</span>}
                        </div>
                        <div className="cart-table-product-meta">
                          {item.is_sample ? 'Free sample' : (
                            <>
                              ${parseFloat(item.unit_price).toFixed(2)}{item.sell_by === 'unit' ? '/ea' : item.sell_by === 'sqyd' ? '/sqyd' : '/sqft'}
                              {item.price_tier && (
                                <span style={{ display: 'inline-block', marginLeft: '0.375rem', padding: '0.0625rem 0.375rem', borderRadius: '0.1875rem', fontSize: '0.6875rem', fontWeight: 600, background: item.price_tier === 'roll' ? 'var(--sage, #6b9080)' : 'var(--stone-200)', color: item.price_tier === 'roll' ? 'white' : 'var(--stone-600)' }}>
                                  {item.price_tier === 'roll' ? 'Roll Price' : 'Cut Price'}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                      <div>
                        {item.is_sample ? '1' : item.price_tier ? (
                          <div style={{ fontWeight: 500, fontSize: '0.875rem' }}>
                            {parseFloat(item.sqft_needed || 0).toFixed(0)} sqft
                          </div>
                        ) : (
                          <>
                            <div className="cart-qty-controls">
                              <button className="cart-qty-btn" onClick={() => handleQtyChange(item, -1)}>&minus;</button>
                              <span style={{ width: 40, textAlign: 'center', fontWeight: 500 }}>{item.num_boxes}</span>
                              <button className="cart-qty-btn" onClick={() => handleQtyChange(item, 1)}>+</button>
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--stone-600)', marginTop: '0.25rem' }}>
                              {item.sell_by === 'unit' ? (parseInt(item.num_boxes) !== 1 ? 'units' : 'unit') : ('box' + (parseInt(item.num_boxes) !== 1 ? 'es' : ''))}
                            </div>
                          </>
                        )}
                      </div>
                      <div>{item.is_sample || item.sell_by === 'unit' ? '\u2014' : parseFloat(item.sqft_needed || 0).toFixed(1) + ' sqft'}</div>
                      <div style={{ fontWeight: 500 }}>{item.is_sample ? 'FREE' : '$' + parseFloat(item.subtotal).toFixed(2)}</div>
                      <div>
                        <button className="cart-remove-btn" onClick={() => removeFromCart(item.id)} title="Remove">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="order-summary">
                <h3>Order Summary</h3>
                {productItems.length > 0 && (
                  <div className="order-summary-row">
                    <span>Products ({[totalBoxes > 0 && `${totalBoxes} box${totalBoxes !== 1 ? 'es' : ''}`, totalUnits > 0 && `${totalUnits} unit${totalUnits !== 1 ? 's' : ''}`].filter(Boolean).join(', ')})</span>
                    <span>${productSubtotal.toFixed(2)}</span>
                  </div>
                )}
                {sampleItems.length > 0 && (
                  <>
                    <div className="order-summary-row muted"><span>Samples ({sampleItems.length})</span><span>FREE</span></div>
                    <div className="order-summary-row muted"><span>Sample Shipping</span><span>$12.00</span></div>
                  </>
                )}

                {/* Delivery Method */}
                {productItems.length > 0 && (
                  <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--stone-200)' }}>
                    <div style={{ fontSize: '0.8125rem', fontWeight: 500, marginBottom: '0.5rem' }}>Delivery Method</div>
                    {hasPickupOnly && (
                      <div style={{ fontSize: '0.75rem', color: '#b45309', background: '#fef3c7', padding: '0.5rem 0.75rem', marginBottom: '0.5rem', borderLeft: '3px solid #f59e0b' }}>
                        Your cart contains items available for store pickup only.
                      </div>
                    )}
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8125rem', cursor: hasPickupOnly ? 'not-allowed' : 'pointer', marginBottom: '0.4rem', opacity: hasPickupOnly ? 0.5 : 1 }}>
                      <input type="radio" name="deliveryMethod" value="shipping" checked={deliveryMethod === 'shipping'}
                        onChange={() => setDeliveryMethod('shipping')} disabled={hasPickupOnly} />
                      Ship to Address <span style={{ color: 'var(--stone-600)', fontSize: '0.75rem' }}>(5-10 business days)</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8125rem', cursor: 'pointer', marginBottom: '0.5rem' }}>
                      <input type="radio" name="deliveryMethod" value="pickup" checked={deliveryMethod === 'pickup'}
                        onChange={() => { setDeliveryMethod('pickup'); setShippingEstimate(null); setSelectedShippingOption(null); }} />
                      Store Pickup — Free <span style={{ color: 'var(--stone-600)', fontSize: '0.75rem' }}>(up to 5 business days)</span>
                    </label>

                    {deliveryMethod === 'pickup' && (
                      <div className="order-summary-row" style={{ marginTop: '0.5rem' }}>
                        <span>Shipping</span>
                        <span style={{ color: '#16a34a', fontWeight: 500 }}>FREE</span>
                      </div>
                    )}

                    {deliveryMethod === 'shipping' && (
                      <>
                        <div style={{ fontSize: '0.8125rem', fontWeight: 500, marginBottom: '0.5rem', marginTop: '0.5rem' }}>Estimate Shipping</div>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                          <input className="checkout-input" style={{ flex: 1, padding: '0.6rem 0.75rem', fontSize: '0.875rem' }}
                            type="text" placeholder="ZIP Code" value={shippingZip}
                            onChange={e => setShippingZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
                            onKeyDown={e => e.key === 'Enter' && fetchShippingEstimate()} maxLength={5} />
                          <button className="btn" style={{ padding: '0.6rem 1rem', fontSize: '0.75rem' }}
                            onClick={fetchShippingEstimate} disabled={shippingLoading || shippingZip.length < 5}>
                            {shippingLoading ? '...' : 'Get Rate'}
                          </button>
                        </div>
                        {shippingError && (
                          <div style={{ fontSize: '0.75rem', color: '#dc2626', marginTop: '0.4rem' }}>{shippingError}</div>
                        )}
                        {shippingEstimate && shippingEstimate.options && shippingEstimate.options.length > 0 && shippingEstimate.options[0].amount > 0 && (
                          <div style={{ marginTop: '0.5rem' }}>
                            <div style={{ fontSize: '0.75rem', fontWeight: 500, marginBottom: '0.4rem', color: 'var(--stone-700)' }}>
                              {shippingEstimate.method === 'ltl_freight' ? 'LTL Freight Options' : 'Shipping'}
                            </div>
                            {shippingEstimate.options.map(opt => (
                              <label key={opt.id} onClick={() => setSelectedShippingOption(opt)}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.6rem 0.75rem',
                                  marginBottom: '0.35rem', cursor: 'pointer', fontSize: '0.8125rem',
                                  border: selectedShippingOption && selectedShippingOption.id === opt.id ? '2px solid var(--gold)' : '1px solid var(--stone-200)',
                                  borderRadius: '6px', background: selectedShippingOption && selectedShippingOption.id === opt.id ? '#fefce8' : 'white',
                                  transition: 'border-color 0.15s'
                                }}>
                                <input type="radio" name="shippingOption" checked={selectedShippingOption && selectedShippingOption.id === opt.id}
                                  onChange={() => setSelectedShippingOption(opt)} />
                                <div style={{ flex: 1 }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                    <span style={{ fontWeight: 500 }}>{opt.carrier}</span>
                                    {opt.service && opt.service !== opt.carrier && <span style={{ color: 'var(--stone-600)', fontSize: '0.75rem' }}>{opt.service}</span>}
                                    {opt.is_cheapest && <span style={{ background: '#dcfce7', color: '#166534', fontSize: '0.625rem', fontWeight: 600, padding: '0.1rem 0.35rem', borderRadius: '3px' }}>Best Price</span>}
                                  </div>
                                  {opt.transit_days && (
                                    <div style={{ fontSize: '0.7rem', color: 'var(--stone-600)', marginTop: '0.15rem' }}>
                                      Est. {opt.transit_days} business day{opt.transit_days !== 1 ? 's' : ''}
                                    </div>
                                  )}
                                </div>
                                <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>${parseFloat(opt.amount).toFixed(2)}</span>
                              </label>
                            ))}
                            {shippingEstimate.options.some(o => o.is_fallback) && (
                              <div style={{ fontSize: '0.7rem', color: '#b45309', background: '#fef3c7', padding: '0.4rem 0.6rem', marginTop: '0.25rem', borderRadius: '4px' }}>
                                Estimated rate. Final rate calculated at confirmation.
                              </div>
                            )}
                          </div>
                        )}
                        {shippingEstimate && shippingEstimate.options && shippingEstimate.options.length > 0 && shippingEstimate.options[0].amount === 0 && shippingEstimate.method === null && (
                          <div className="order-summary-row muted" style={{ marginTop: '0.5rem' }}>
                            <span>Shipping</span><span>$0.00</span>
                          </div>
                        )}
                        {!shippingEstimate && !shippingLoading && !shippingError && (
                          <div style={{ fontSize: '0.75rem', color: 'var(--stone-600)', marginTop: '0.4rem' }}>
                            Enter zip for shipping estimate
                          </div>
                        )}
                        {shippingEstimate && shippingEstimate.weight_lbs > 0 && (
                          <div style={{ fontSize: '0.7rem', color: 'var(--stone-600)', marginTop: '0.25rem' }}>
                            Est. weight: {shippingEstimate.weight_lbs} lbs ({shippingEstimate.total_boxes} item{shippingEstimate.total_boxes !== 1 ? 's' : ''})
                          </div>
                        )}
                        {shippingEstimate && shippingEstimate.method === 'ltl_freight' && (
                          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: 'var(--stone-600)', marginTop: '0.4rem', cursor: 'pointer' }}>
                            <input type="checkbox" checked={liftgateEnabled} onChange={e => {
                              setLiftgateEnabled(e.target.checked);
                              setShippingEstimate(null);
                              setSelectedShippingOption(null);
                            }} />
                            Liftgate delivery (residential)
                          </label>
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* Promo Code */}
                <div style={{ borderTop: '1px solid var(--stone-200)', marginTop: '0.75rem', paddingTop: '0.75rem' }}>
                  {promoResult ? (
                    <div>
                      <div className="order-summary-row" style={{ color: '#16a34a' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <span style={{ background: '#dcfce7', color: '#166534', padding: '0.15rem 0.5rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>{promoResult.code}</span>
                          <a onClick={removePromo} style={{ fontSize: '0.75rem', color: 'var(--stone-500)', cursor: 'pointer', textDecoration: 'underline' }}>Remove</a>
                        </span>
                        <span style={{ fontWeight: 500 }}>-${promoDiscount.toFixed(2)}</span>
                      </div>
                      {promoResult.description && (
                        <div style={{ fontSize: '0.7rem', color: 'var(--stone-500)', marginTop: '0.15rem' }}>{promoResult.description}</div>
                      )}
                    </div>
                  ) : (
                    <div>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <input type="text" value={promoCode} onChange={e => { setPromoCode(e.target.value.toUpperCase()); setPromoError(''); }}
                          placeholder="Promo code" onKeyDown={e => e.key === 'Enter' && applyPromoCode()}
                          style={{ flex: 1, padding: '0.5rem 0.6rem', border: '1px solid var(--stone-300)', borderRadius: '4px', fontSize: '0.8rem', fontFamily: "'Inter', sans-serif" }} />
                        <button onClick={() => applyPromoCode()} disabled={promoLoading || !promoCode.trim()}
                          style={{ padding: '0.5rem 0.75rem', background: 'var(--stone-800)', color: 'white', border: 'none', borderRadius: '4px', fontSize: '0.8rem', cursor: 'pointer', opacity: promoLoading || !promoCode.trim() ? 0.5 : 1 }}>
                          {promoLoading ? '...' : 'Apply'}
                        </button>
                      </div>
                      {promoError && <div style={{ color: '#dc2626', fontSize: '0.75rem', marginTop: '0.3rem' }}>{promoError}</div>}
                    </div>
                  )}
                </div>

                <div className="order-summary-total">
                  <span>{selectedShippingOption ? 'Estimated Total' : 'Subtotal'}</span>
                  <span>${cartTotal.toFixed(2)}</span>
                </div>
                <button className="btn" style={{ width: '100%', marginTop: '1rem' }} onClick={goCheckout}>Proceed to Checkout</button>
              </div>
            </div>
          )}
        </div>
      );
    }

    // ==================== Checkout Page ====================

    function CheckoutPage({ cart, sessionId, goCart, handleOrderComplete, deliveryMethod, tradeCustomer, tradeToken, customer, customerToken, onCustomerLogin, appliedPromoCode, setAppliedPromoCode }) {
      const [customerName, setCustomerName] = useState(tradeCustomer ? tradeCustomer.contact_name : (customer ? (customer.first_name + ' ' + customer.last_name) : ''));
      const [customerEmail, setCustomerEmail] = useState(tradeCustomer ? tradeCustomer.email : (customer ? customer.email : ''));
      const [phone, setPhone] = useState(customer ? (customer.phone || '') : '');
      const [line1, setLine1] = useState(customer ? (customer.address_line1 || '') : '');
      const [line2, setLine2] = useState(customer ? (customer.address_line2 || '') : '');
      const [city, setCity] = useState(customer ? (customer.city || '') : '');
      const [state, setState] = useState(customer ? (customer.state || '') : '');
      const [zip, setZip] = useState(customer ? (customer.zip || '') : '');
      const [error, setError] = useState('');
      const [processing, setProcessing] = useState(false);
      const [taxEstimate, setTaxEstimate] = useState({ rate: 0, amount: 0 });
      const cardRef = useRef(null);
      const cardMounted = useRef(false);
      const taxDebounce = useRef(null);
      const addressInputRef = useRef(null);
      const autocompleteRef = useRef(null);
      const [placesReady, setPlacesReady] = useState(false);
      const [createAccount, setCreateAccount] = useState(false);
      const [accountPassword, setAccountPassword] = useState('');
      const [confirmPassword, setConfirmPassword] = useState('');
      const [passwordError, setPasswordError] = useState('');
      const [walletAvailable, setWalletAvailable] = useState(false);
      const paymentRequestRef = useRef(null);

      const isPickup = deliveryMethod === 'pickup';
      const productItems = cart.filter(i => !i.is_sample);
      const sampleItems = cart.filter(i => i.is_sample);
      const productSubtotal = productItems.reduce((sum, i) => sum + parseFloat(i.subtotal || 0), 0);
      const sampleShipping = sampleItems.length > 0 ? 12 : 0;
      const cartTotal = productSubtotal + sampleShipping + taxEstimate.amount;

      const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];

      useEffect(() => {
        if (cardMounted.current) return;
        const elements = stripeInstance.elements();
        const card = elements.create('card', {
          style: { base: { fontFamily: "'Inter', sans-serif", fontSize: '15px', color: '#292524', '::placeholder': { color: '#57534e' } } }
        });
        card.mount('#card-element');
        cardRef.current = card;
        cardMounted.current = true;
        return () => { if (cardRef.current) { cardRef.current.unmount(); cardMounted.current = false; } };
      }, []);

      // Apple Pay / Google Pay via Payment Request API
      const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      const [walletMode, setWalletMode] = useState(null); // 'native' | 'simulated'

      useEffect(() => {
        if (!stripeInstance) return;
        const pr = stripeInstance.paymentRequest({
          country: 'US',
          currency: 'usd',
          total: { label: 'Roma Flooring Designs', amount: Math.round(cartTotal * 100) || 100 },
          requestPayerName: true,
          requestPayerEmail: true,
          requestPayerPhone: true,
        });
        pr.canMakePayment().then(result => {
          if (result) {
            setWalletAvailable(true);
            setWalletMode('native');
            paymentRequestRef.current = pr;
          } else if (isLocalDev) {
            // Simulated wallet button for localhost dev testing
            setWalletAvailable(true);
            setWalletMode('simulated');
          }
        });
      }, []);

      // Mount native Payment Request Button when available
      useEffect(() => {
        if (walletMode !== 'native' || !paymentRequestRef.current || !stripeInstance) return;
        const el = document.getElementById('payment-request-button');
        if (!el) return;
        const elements = stripeInstance.elements();
        const prButton = elements.create('paymentRequestButton', {
          paymentRequest: paymentRequestRef.current,
          style: { paymentRequestButton: { type: 'default', theme: 'dark', height: '48px' } }
        });
        prButton.mount('#payment-request-button');
        return () => prButton.unmount();
      }, [walletMode]);

      // Update paymentRequest amount when cart total changes
      useEffect(() => {
        if (!paymentRequestRef.current) return;
        const amount = Math.round(cartTotal * 100);
        if (amount > 0) {
          paymentRequestRef.current.update({
            total: { label: 'Roma Flooring Designs', amount }
          });
        }
      }, [cartTotal]);

      // Handle native wallet payment
      useEffect(() => {
        const pr = paymentRequestRef.current;
        if (!pr) return;
        const handler = async (ev) => {
          try {
            const piBody = { session_id: sessionId, delivery_method: deliveryMethod };
            if (!isPickup) { piBody.destination = { zip, city, state }; piBody.residential = true; piBody.liftgate = true; }
            const piRes = await fetch(API + '/api/checkout/create-payment-intent', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(piBody)
            });
            const piData = await piRes.json();
            if (piData.error) { ev.complete('fail'); setError(piData.error); return; }

            const { error: confirmError, paymentIntent } = await stripeInstance.confirmCardPayment(
              piData.clientSecret,
              { payment_method: ev.paymentMethod.id },
              { handleActions: false }
            );
            if (confirmError) { ev.complete('fail'); setError(confirmError.message); return; }
            ev.complete('success');

            if (paymentIntent.status === 'requires_action') {
              const { error: actionError } = await stripeInstance.confirmCardPayment(piData.clientSecret);
              if (actionError) { setError(actionError.message); return; }
            }

            const payerName = ev.payerName || customerName;
            const payerEmail = ev.payerEmail || customerEmail;
            const payerPhone = ev.payerPhone || phone;
            const orderBody = {
              session_id: sessionId, payment_intent_id: paymentIntent.id,
              customer_name: payerName, customer_email: payerEmail, phone: payerPhone,
              delivery_method: deliveryMethod,
              shipping: isPickup ? null : { line1, line2, city, state, zip },
              residential: true, liftgate: true,
            };
            const orderHeaders = { 'Content-Type': 'application/json' };
            if (tradeToken) orderHeaders['X-Trade-Token'] = tradeToken;
            if (customerToken) orderHeaders['X-Customer-Token'] = customerToken;
            const orderRes = await fetch(API + '/api/checkout/place-order', {
              method: 'POST', headers: orderHeaders, body: JSON.stringify(orderBody)
            });
            const orderData = await orderRes.json();
            if (orderData.error) { setError(orderData.error); return; }
            if (orderData.customer_token && orderData.customer && onCustomerLogin) {
              onCustomerLogin(orderData.customer_token, orderData.customer);
            }
            handleOrderComplete({ order: orderData.order, sample_request: orderData.sample_request || null });
          } catch (err) {
            ev.complete('fail');
            setError(err.message || 'Wallet payment failed. Please try again.');
          }
        };
        pr.on('paymentmethod', handler);
        return () => pr.off('paymentmethod', handler);
      }, [walletAvailable, sessionId, deliveryMethod, isPickup, zip, city, state, line1, line2, customerName, customerEmail, phone, tradeToken, customerToken]);

      // Simulated wallet pay (dev only) — uses the card element behind the scenes
      const handleSimulatedWalletPay = async () => {
        if (!cardRef.current) { setError('Card element not ready.'); return; }
        setError('');
        setProcessing(true);
        try {
          const piBody = { session_id: sessionId, delivery_method: deliveryMethod };
          if (!isPickup) { piBody.destination = { zip, city, state }; piBody.residential = true; piBody.liftgate = true; }
          const piRes = await fetch(API + '/api/checkout/create-payment-intent', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(piBody)
          });
          const piData = await piRes.json();
          if (piData.error) { setError(piData.error); setProcessing(false); return; }

          const { error: stripeError, paymentIntent } = await stripeInstance.confirmCardPayment(
            piData.clientSecret, { payment_method: { card: cardRef.current, billing_details: { name: customerName, email: customerEmail } } }
          );
          if (stripeError) { setError(stripeError.message); setProcessing(false); return; }

          const orderBody = {
            session_id: sessionId, payment_intent_id: paymentIntent.id,
            customer_name: customerName, customer_email: customerEmail, phone,
            delivery_method: deliveryMethod,
            shipping: isPickup ? null : { line1, line2, city, state, zip },
            residential: true, liftgate: true,
            create_account: createAccount || undefined,
            account_password: createAccount ? accountPassword : undefined
          };
          const orderHeaders = { 'Content-Type': 'application/json' };
          if (tradeToken) orderHeaders['X-Trade-Token'] = tradeToken;
          if (customerToken) orderHeaders['X-Customer-Token'] = customerToken;
          const orderRes = await fetch(API + '/api/checkout/place-order', {
            method: 'POST', headers: orderHeaders, body: JSON.stringify(orderBody)
          });
          const orderData = await orderRes.json();
          if (orderData.error) { setError(orderData.error); setProcessing(false); return; }
          if (orderData.customer_token && orderData.customer && onCustomerLogin) {
            onCustomerLogin(orderData.customer_token, orderData.customer);
          }
          handleOrderComplete(orderData.order);
        } catch (err) {
          setError(err.message || 'Something went wrong. Please try again.');
          setProcessing(false);
        }
      };

      // Load Google Places API
      useEffect(() => {
        if (isPickup) return;
        let cancelled = false;
        fetch(API + '/api/config/google-places-key')
          .then(r => r.json())
          .then(data => {
            if (cancelled || !data.key) return;
            return loadGooglePlaces(data.key).then(() => {
              if (!cancelled) setPlacesReady(true);
            });
          })
          .catch(() => {});
        return () => { cancelled = true; };
      }, [isPickup]);

      // Attach Google Places Autocomplete to address input
      useEffect(() => {
        if (!placesReady || isPickup || !addressInputRef.current) return;
        if (autocompleteRef.current) return;
        try {
          const ac = new window.google.maps.places.Autocomplete(addressInputRef.current, {
            componentRestrictions: { country: 'us' },
            fields: ['address_components', 'formatted_address'],
            types: ['address']
          });
          ac.addListener('place_changed', () => {
            const place = ac.getPlace();
            if (!place || !place.address_components) return;
            let streetNumber = '', route = '', newCity = '', newState = '', newZip = '';
            for (const comp of place.address_components) {
              const t = comp.types[0];
              if (t === 'street_number') streetNumber = comp.long_name;
              else if (t === 'route') route = comp.long_name;
              else if (t === 'locality') newCity = comp.long_name;
              else if (t === 'sublocality_level_1' && !newCity) newCity = comp.long_name;
              else if (t === 'administrative_area_level_1') newState = comp.short_name;
              else if (t === 'postal_code') newZip = comp.long_name;
            }
            setLine1((streetNumber + ' ' + route).trim());
            if (newCity) setCity(newCity);
            if (newState) setState(newState);
            if (newZip) setZip(newZip);
          });
          autocompleteRef.current = ac;
        } catch (e) { /* Google Places failed — manual entry still works */ }
        return () => {
          if (autocompleteRef.current) {
            window.google.maps.event.clearInstanceListeners(autocompleteRef.current);
            autocompleteRef.current = null;
          }
        };
      }, [placesReady, isPickup]);

      // Fetch tax estimate when ZIP changes
      useEffect(() => {
        const taxZip = isPickup ? '92806' : zip;
        if (!taxZip || taxZip.length < 5) { setTaxEstimate({ rate: 0, amount: 0 }); return; }
        clearTimeout(taxDebounce.current);
        taxDebounce.current = setTimeout(async () => {
          try {
            const resp = await fetch(API + '/api/cart/tax-estimate?zip=' + encodeURIComponent(taxZip) + '&session_id=' + encodeURIComponent(sessionId));
            const data = await resp.json();
            setTaxEstimate({ rate: data.rate || 0, amount: data.amount || 0 });
          } catch { setTaxEstimate({ rate: 0, amount: 0 }); }
        }, 400);
        return () => clearTimeout(taxDebounce.current);
      }, [zip, isPickup, sessionId]);

      const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setPasswordError('');
        const nameParts = customerName.trim().split(/\s+/);
        if (nameParts.length < 2 || nameParts[0].length < 2 || nameParts[1].length < 1) {
          setError('Please enter your full name (first and last).');
          return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(customerEmail)) {
          setError('Please enter a valid email address.');
          return;
        }
        if (phone.replace(/\D/g, '').length < 10) {
          setError('Please enter a valid 10-digit phone number.');
          return;
        }
        if (!isPickup) {
          if (!line1.trim()) { setError('Please enter a street address.'); return; }
          if (!city.trim()) { setError('Please enter a city.'); return; }
          if (!state) { setError('Please select a state.'); return; }
          if (!/^\d{5}(-\d{4})?$/.test(zip.trim())) { setError('Please enter a valid ZIP code.'); return; }
        }
        if (createAccount) {
          if (accountPassword.length < 8 || !/[A-Z]/.test(accountPassword) || !/[0-9]/.test(accountPassword)) {
            setPasswordError('Password must be at least 8 characters with 1 uppercase letter and 1 number.');
            return;
          }
          if (accountPassword !== confirmPassword) {
            setPasswordError('Passwords do not match.');
            return;
          }
        }
        setProcessing(true);
        try {
          const piBody = { session_id: sessionId, delivery_method: deliveryMethod };
          if (!isPickup) { piBody.destination = { zip, city, state }; piBody.residential = true; piBody.liftgate = true; }
          const piRes = await fetch(API + '/api/checkout/create-payment-intent', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(piBody)
          });
          const piData = await piRes.json();
          if (piData.error) { setError(piData.error); setProcessing(false); return; }

          const { error: stripeError, paymentIntent } = await stripeInstance.confirmCardPayment(
            piData.clientSecret, { payment_method: { card: cardRef.current, billing_details: { name: customerName, email: customerEmail } } }
          );
          if (stripeError) { setError(stripeError.message); setProcessing(false); return; }

          const orderBody = {
            session_id: sessionId, payment_intent_id: paymentIntent.id,
            customer_name: customerName, customer_email: customerEmail, phone,
            delivery_method: deliveryMethod,
            shipping: isPickup ? null : { line1, line2, city, state, zip },
            residential: true, liftgate: true,
            create_account: createAccount || undefined,
            account_password: createAccount ? accountPassword : undefined
          };
          const orderHeaders = { 'Content-Type': 'application/json' };
          if (tradeToken) orderHeaders['X-Trade-Token'] = tradeToken;
          if (customerToken) orderHeaders['X-Customer-Token'] = customerToken;
          const orderRes = await fetch(API + '/api/checkout/place-order', {
            method: 'POST', headers: orderHeaders, body: JSON.stringify(orderBody)
          });
          const orderData = await orderRes.json();
          if (orderData.error) { setError(orderData.error); setProcessing(false); return; }
          if (orderData.customer_token && orderData.customer && onCustomerLogin) {
            onCustomerLogin(orderData.customer_token, orderData.customer);
          }
          handleOrderComplete(orderData.order);
        } catch (err) {
          setError(err.message || 'Something went wrong. Please try again.');
          setProcessing(false);
        }
      };

      return (
        <div className="checkout-page">
          <h1>Checkout</h1>
          <form className="checkout-form" onSubmit={handleSubmit}>
            {error && <div className="checkout-error">{error}</div>}
            <div className="checkout-section">
              <h3>Contact Information</h3>
              <div className="checkout-row">
                <div className="checkout-field"><label>Full Name *</label><input className="checkout-input" value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="John Smith" /></div>
                <div className="checkout-field"><label>Email *</label><input className="checkout-input" type="email" value={customerEmail} onChange={e => setCustomerEmail(e.target.value)} placeholder="john@example.com" /></div>
              </div>
              <div className="checkout-field"><label>Phone *</label><input className="checkout-input" type="tel" value={phone} onChange={e => {
                const digits = e.target.value.replace(/\D/g, '').slice(0, 10);
                let fmt = ''; if (digits.length > 0) fmt = '(' + digits.slice(0, 3);
                if (digits.length >= 3) fmt += ') '; if (digits.length > 3) fmt += digits.slice(3, 6);
                if (digits.length >= 6) fmt += '-' + digits.slice(6); setPhone(fmt);
              }} placeholder="(555) 123-4567" /></div>
            </div>
            {!customer && !tradeCustomer && (
              <div className="checkout-section">
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.9375rem' }}>
                  <input type="checkbox" checked={createAccount} onChange={e => { setCreateAccount(e.target.checked); if (!e.target.checked) { setAccountPassword(''); setConfirmPassword(''); setPasswordError(''); } }} />
                  Create an account for faster checkout next time
                </label>
                {createAccount && (
                  <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    <div className="checkout-field">
                      <label>Password *</label>
                      <input className="checkout-input" type="password" value={accountPassword} onChange={e => { setAccountPassword(e.target.value); setPasswordError(''); }} placeholder="Create a password" autoComplete="new-password" />
                      <div style={{ fontSize: '0.75rem', color: 'var(--stone-500)', marginTop: '0.25rem' }}>Min 8 characters, 1 uppercase letter, 1 number</div>
                    </div>
                    <div className="checkout-field">
                      <label>Confirm Password *</label>
                      <input className="checkout-input" type="password" value={confirmPassword} onChange={e => { setConfirmPassword(e.target.value); setPasswordError(''); }} placeholder="Re-enter password" autoComplete="new-password" />
                    </div>
                    {passwordError && <div style={{ color: '#dc2626', fontSize: '0.8125rem' }}>{passwordError}</div>}
                  </div>
                )}
              </div>
            )}
            {isPickup ? (
              <div className="checkout-section">
                <h3>Store Pickup</h3>
                <div style={{ background: 'var(--stone-100)', padding: '1.25rem', fontSize: '0.875rem', lineHeight: 1.6 }}>
                  <div style={{ fontWeight: 500, marginBottom: '0.5rem' }}>Pickup Location</div>
                  <div>Roma Flooring Designs</div><div>1440 S. State College Blvd., Suite 6M</div><div>Anaheim, CA 92806</div>
                  <div style={{ marginTop: '0.75rem', color: 'var(--stone-600)', fontSize: '0.8125rem' }}>Ready for pickup within 5 business days.</div>
                </div>
              </div>
            ) : (
              <div className="checkout-section">
                <h3>Shipping Address</h3>
                <div className="checkout-field"><label>Address Line 1 *</label><input ref={addressInputRef} className="checkout-input" value={line1} onChange={e => setLine1(e.target.value)} placeholder="Start typing an address..." autoComplete="off" /></div>
                <div className="checkout-field"><label>Address Line 2</label><input className="checkout-input" value={line2} onChange={e => setLine2(e.target.value)} placeholder="Apt, Suite, Unit" /></div>
                <div className="checkout-row-3">
                  <div className="checkout-field"><label>City *</label><input className="checkout-input" value={city} onChange={e => setCity(e.target.value)} placeholder="New York" /></div>
                  <div className="checkout-field"><label>State *</label><select className="checkout-input" value={state} onChange={e => setState(e.target.value)}><option value="">Select</option>{US_STATES.map(s => <option key={s} value={s}>{s}</option>)}</select></div>
                  <div className="checkout-field"><label>ZIP *</label><input className="checkout-input" value={zip} onChange={e => setZip(e.target.value)} placeholder="10001" /></div>
                </div>
              </div>
            )}
            <div className="checkout-section">
              <h3>Payment</h3>
              {walletAvailable && (
                <div className="checkout-field">
                  <label>Express Checkout</label>
                  {walletMode === 'native' ? (
                    <div id="payment-request-button"></div>
                  ) : (
                    <button type="button" className="simulated-wallet-btn" onClick={handleSimulatedWalletPay} disabled={processing}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
                      {processing ? 'Processing...' : 'Pay with Wallet'}
                      {isLocalDev && <span className="dev-badge">DEV</span>}
                    </button>
                  )}
                  <div className="checkout-divider">or pay with card</div>
                </div>
              )}
              <div className="checkout-field"><label>Card Details</label><div id="card-element" className="stripe-element"></div></div>
            </div>
            <button type="submit" className="checkout-btn" disabled={processing}>
              {processing && <span className="checkout-spinner"></span>}
              {processing ? 'Processing...' : isPickup ? `Place Order - $${cartTotal.toFixed(2)}` : 'Place Order'}
            </button>
          </form>

          <div className="order-summary">
            <h3>Order Summary</h3>
            {cart.map(item => (
              <div key={item.id} className="order-summary-row" style={{ fontSize: '0.875rem' }}>
                <span>{item.product_name || 'Product'}{item.is_sample ? ' (Sample)' : item.sell_by === 'unit' ? ` x ${item.num_boxes}` : ` x ${item.num_boxes} bx`}</span>
                <span>{item.is_sample ? 'FREE' : '$' + parseFloat(item.subtotal).toFixed(2)}</span>
              </div>
            ))}
            {productItems.length > 0 && <div className="order-summary-row" style={{ borderTop: '1px solid var(--stone-200)', marginTop: '0.5rem', paddingTop: '0.75rem' }}><span>Subtotal</span><span>${productSubtotal.toFixed(2)}</span></div>}
            {sampleItems.length > 0 && <div className="order-summary-row muted"><span>Sample Shipping</span><span>$12.00</span></div>}
            {taxEstimate.amount > 0 && <div className="order-summary-row muted"><span>Estimated Tax ({(taxEstimate.rate * 100).toFixed(2)}%)</span><span>${taxEstimate.amount.toFixed(2)}</span></div>}
            <div className="order-summary-total"><span>Total</span><span>${cartTotal.toFixed(2)}</span></div>
            <a className="back-btn" onClick={goCart} style={{ marginTop: '1rem', display: 'inline-block' }}>&larr; Back to Cart</a>
          </div>
        </div>
      );
    }

    // ==================== Confirmation Page ====================

    function ConfirmationPage({ orderData, goBrowse }) {
      if (!orderData) return null;
      const order = orderData.order;
      const sampleRequest = orderData.sample_request;
      const items = order ? (order.items || []) : [];
      const sampleItems = sampleRequest ? (sampleRequest.items || []) : [];
      return (
        <div className="confirmation-page">
          <div className="confirmation-check">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <h1>Order Confirmed</h1>
          {order && <div className="confirmation-order-number">Order number: <strong>{order.order_number}</strong></div>}
          {items.length > 0 && (
            <div className="confirmation-details">
              <h3>Items Ordered</h3>
              {items.map((item, idx) => (
                <div key={idx} className="confirmation-item">
                  <span>{item.product_name || 'Product'}{item.sell_by === 'unit' ? ` - Qty ${item.num_boxes}` : ` - ${item.num_boxes} box${parseInt(item.num_boxes) !== 1 ? 'es' : ''}`}</span>
                  <span style={{ fontWeight: 500 }}>{'$' + parseFloat(item.subtotal || 0).toFixed(2)}</span>
                </div>
              ))}
              <div className="confirmation-item" style={{ fontWeight: 600 }}><span>Total</span><span>${parseFloat(order.total || 0).toFixed(2)}</span></div>
            </div>
          )}
          {sampleRequest && (
            <div style={{ marginTop: '2rem', paddingTop: '2rem', borderTop: '1px solid var(--stone-200, #e7e5e4)' }}>
              <div className="confirmation-check" style={{ width: 40, height: 40 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              </div>
              <h2 style={{ fontFamily: "var(--font-heading, 'Cormorant Garamond', serif)", fontWeight: 400, marginBottom: '0.5rem' }}>Sample Request Created</h2>
              <div className="confirmation-order-number">Request number: <strong>{sampleRequest.request_number}</strong></div>
              <div className="confirmation-details">
                <h3>Samples Requested</h3>
                {sampleItems.map((item, idx) => (
                  <div key={idx} className="confirmation-item">
                    <span>{item.product_name || 'Product'}{item.variant_name ? ' \u2014 ' + item.variant_name : ''}</span>
                    <span style={{ fontWeight: 500, color: 'var(--stone-500, #78716c)' }}>FREE</span>
                  </div>
                ))}
                <p style={{ fontSize: '0.875rem', color: 'var(--stone-500, #78716c)', marginTop: '1rem' }}>
                  Your samples will be prepared and shipped separately.
                </p>
              </div>
            </div>
          )}
          <button className="btn" style={{ marginTop: '2rem' }} onClick={goBrowse}>Continue Shopping</button>
        </div>
      );
    }

    // ==================== Account Page ====================

    function AccountPage({ customer, customerToken, setCustomer, goBrowse }) {
      const [tab, setTab] = useState('orders');
      const [orders, setOrders] = useState([]);
      const [expandedOrder, setExpandedOrder] = useState(null);
      const [orderDetail, setOrderDetail] = useState(null);
      const [loadingOrders, setLoadingOrders] = useState(true);

      // Samples state
      const [sampleRequests, setSampleRequests] = useState([]);
      const [loadingSamples, setLoadingSamples] = useState(true);
      const [expandedSample, setExpandedSample] = useState(null);
      const [addItemsTo, setAddItemsTo] = useState(null); // sample request id being added to
      const [sampleSearch, setSampleSearch] = useState('');
      const [sampleSearchResults, setSampleSearchResults] = useState([]);
      const [searchingProducts, setSearchingProducts] = useState(false);
      const [addingSampleItem, setAddingSampleItem] = useState(null);

      // Quotes state
      const [quotes, setQuotes] = useState([]);
      const [loadingQuotes, setLoadingQuotes] = useState(true);
      const [expandedQuote, setExpandedQuote] = useState(null);
      const [quoteDetail, setQuoteDetail] = useState(null);

      // Visits state
      const [visits, setVisits] = useState([]);
      const [loadingVisits, setLoadingVisits] = useState(true);
      const [expandedVisit, setExpandedVisit] = useState(null);
      const [visitDetail, setVisitDetail] = useState(null);

      const [firstName, setFirstName] = useState(customer.first_name || '');
      const [lastName, setLastName] = useState(customer.last_name || '');
      const [phone, setPhone] = useState(customer.phone || '');
      const [addressLine1, setAddressLine1] = useState(customer.address_line1 || '');
      const [addressLine2, setAddressLine2] = useState(customer.address_line2 || '');
      const [city, setCity] = useState(customer.city || '');
      const [addrState, setAddrState] = useState(customer.state || '');
      const [zip, setZip] = useState(customer.zip || '');
      const [profileMsg, setProfileMsg] = useState('');
      const [profileError, setProfileError] = useState('');
      const [saving, setSaving] = useState(false);

      const [currentPw, setCurrentPw] = useState('');
      const [newPw, setNewPw] = useState('');
      const [confirmPw, setConfirmPw] = useState('');
      const [pwMsg, setPwMsg] = useState('');
      const [pwError, setPwError] = useState('');
      const [pwSaving, setPwSaving] = useState(false);

      const headers = { 'X-Customer-Token': customerToken, 'Content-Type': 'application/json' };
      const authHeaders = { 'X-Customer-Token': customerToken };

      useEffect(() => {
        fetch(API + '/api/customer/orders', { headers: authHeaders })
          .then(r => r.json())
          .then(data => { setOrders(data.orders || []); setLoadingOrders(false); })
          .catch(() => setLoadingOrders(false));
        fetch(API + '/api/customer/sample-requests', { headers: authHeaders })
          .then(r => r.json())
          .then(data => { setSampleRequests(data.sample_requests || []); setLoadingSamples(false); })
          .catch(() => setLoadingSamples(false));
        fetch(API + '/api/customer/quotes', { headers: authHeaders })
          .then(r => r.json())
          .then(data => { setQuotes(data.quotes || []); setLoadingQuotes(false); })
          .catch(() => setLoadingQuotes(false));
        fetch(API + '/api/customer/visits', { headers: authHeaders })
          .then(r => r.json())
          .then(data => { setVisits(data.visits || []); setLoadingVisits(false); })
          .catch(() => setLoadingVisits(false));
      }, []);

      const refreshSamples = () => {
        fetch(API + '/api/customer/sample-requests', { headers: authHeaders })
          .then(r => r.json())
          .then(data => setSampleRequests(data.sample_requests || []))
          .catch(() => {});
      };

      const searchProducts = async (q) => {
        if (!q || q.length < 2) { setSampleSearchResults([]); return; }
        setSearchingProducts(true);
        try {
          const resp = await fetch(API + '/api/storefront/skus?search=' + encodeURIComponent(q) + '&limit=8');
          const data = await resp.json();
          setSampleSearchResults(data.skus || []);
        } catch { setSampleSearchResults([]); }
        setSearchingProducts(false);
      };

      const addSampleItem = async (srId, productId, skuId) => {
        setAddingSampleItem(skuId || productId);
        try {
          const resp = await fetch(API + '/api/customer/sample-requests/' + srId + '/add-items', {
            method: 'POST', headers,
            body: JSON.stringify({ items: [{ product_id: productId, sku_id: skuId }] })
          });
          if (resp.ok) {
            refreshSamples();
            setSampleSearch('');
            setSampleSearchResults([]);
          } else {
            const data = await resp.json();
            alert(data.error || 'Failed to add sample');
          }
        } catch { alert('Failed to add sample'); }
        setAddingSampleItem(null);
      };

      const viewOrderDetail = async (orderId) => {
        if (expandedOrder === orderId) { setExpandedOrder(null); setOrderDetail(null); return; }
        setExpandedOrder(orderId);
        try {
          const resp = await fetch(API + '/api/customer/orders/' + orderId, { headers: authHeaders });
          const data = await resp.json();
          setOrderDetail(data);
        } catch { setOrderDetail(null); }
      };

      const viewQuoteDetail = async (quoteId) => {
        if (expandedQuote === quoteId) { setExpandedQuote(null); setQuoteDetail(null); return; }
        setExpandedQuote(quoteId);
        try {
          const resp = await fetch(API + '/api/customer/quotes/' + quoteId, { headers: authHeaders });
          const data = await resp.json();
          setQuoteDetail(data);
        } catch { setQuoteDetail(null); }
      };

      const viewVisitDetail = async (visitId) => {
        if (expandedVisit === visitId) { setExpandedVisit(null); setVisitDetail(null); return; }
        setExpandedVisit(visitId);
        try {
          const resp = await fetch(API + '/api/customer/visits/' + visitId, { headers: authHeaders });
          const data = await resp.json();
          setVisitDetail(data);
        } catch { setVisitDetail(null); }
      };

      const quoteStatusBadge = (status, expiresAt) => {
        const colors = {
          sent: { bg: '#dbeafe', text: '#1e40af', label: 'Sent' },
          converted: { bg: '#dcfce7', text: '#166534', label: 'Converted' },
          expired: { bg: '#fef2f2', text: '#991b1b', label: 'Expired' }
        };
        const isExpired = status === 'sent' && expiresAt && new Date(expiresAt) < new Date();
        const c = isExpired ? colors.expired : (colors[status] || colors.sent);
        return (
          <span style={{ display: 'inline-block', padding: '0.2rem 0.6rem', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', background: c.bg, color: c.text, borderRadius: '3px' }}>
            {isExpired ? 'Expired' : c.label}
          </span>
        );
      };

      const saveProfile = async () => {
        setSaving(true); setProfileMsg(''); setProfileError('');
        try {
          const resp = await fetch(API + '/api/customer/profile', {
            method: 'PUT', headers,
            body: JSON.stringify({ first_name: firstName, last_name: lastName, phone, address_line1: addressLine1, address_line2: addressLine2, city, state: addrState, zip })
          });
          const data = await resp.json();
          if (!resp.ok) { setProfileError(data.error); setSaving(false); return; }
          setCustomer(data.customer);
          setProfileMsg('Profile updated successfully.');
        } catch { setProfileError('Failed to save.'); }
        setSaving(false);
      };

      const changePassword = async () => {
        setPwSaving(true); setPwMsg(''); setPwError('');
        if (newPw !== confirmPw) { setPwError('Passwords do not match.'); setPwSaving(false); return; }
        try {
          const resp = await fetch(API + '/api/customer/password', {
            method: 'PUT', headers,
            body: JSON.stringify({ current_password: currentPw, new_password: newPw })
          });
          const data = await resp.json();
          if (!resp.ok) { setPwError(data.error); setPwSaving(false); return; }
          setPwMsg('Password updated successfully.');
          setCurrentPw(''); setNewPw(''); setConfirmPw('');
        } catch { setPwError('Failed to update password.'); }
        setPwSaving(false);
      };

      const formatPhone = (val) => {
        const digits = val.replace(/\D/g, '').slice(0, 10);
        if (digits.length === 0) return '';
        if (digits.length <= 3) return '(' + digits;
        if (digits.length <= 6) return '(' + digits.slice(0, 3) + ') ' + digits.slice(3);
        return '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
      };

      const statusBadge = (status) => {
        const colors = {
          pending: { bg: '#fef3c7', text: '#92400e' },
          confirmed: { bg: '#dbeafe', text: '#1e40af' },
          ready_for_pickup: { bg: '#f0fdf4', text: '#166534' },
          shipped: { bg: '#e0e7ff', text: '#3730a3' },
          delivered: { bg: '#dcfce7', text: '#166534' },
          cancelled: { bg: '#fef2f2', text: '#991b1b' }
        };
        const c = colors[status] || colors.pending;
        const label = status === 'ready_for_pickup' ? 'ready for pickup' : status;
        return (
          <span style={{ display: 'inline-block', padding: '0.2rem 0.6rem', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', background: c.bg, color: c.text, borderRadius: '3px' }}>
            {label}
          </span>
        );
      };

      const US_STATES = [
        'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY',
        'LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND',
        'OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'
      ];

      const inputStyle = {
        width: '100%', padding: '0.65rem 0.75rem', border: '1px solid var(--stone-200)',
        fontSize: '0.875rem', fontFamily: 'Inter, sans-serif', outline: 'none'
      };
      const labelStyle = { display: 'block', marginBottom: '0.35rem', fontSize: '0.8125rem', fontWeight: 500, color: 'var(--stone-800)' };
      const fieldStyle = { marginBottom: '1rem' };

      return (
        <div style={{ maxWidth: 900, margin: '3rem auto', padding: '0 1.5rem' }}>
          <h1 style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: '2rem', fontWeight: 400, marginBottom: '0.5rem' }}>
            My Account
          </h1>
          <p style={{ color: 'var(--stone-600)', fontSize: '0.875rem', marginBottom: '2rem' }}>
            Welcome back, {customer.first_name}
          </p>

          <div style={{ display: 'flex', gap: '2rem', borderBottom: '1px solid var(--stone-200)', marginBottom: '2rem' }}>
            {['orders', 'quotes', 'samples', 'visits', 'profile'].map(t => {
              const labels = { orders: 'Order History', quotes: 'Quotes', samples: 'My Samples', visits: 'Visits', profile: 'Profile' };
              return (
                <button key={t} onClick={() => setTab(t)}
                  style={{
                    background: 'none', border: 'none', padding: '0.75rem 0', cursor: 'pointer',
                    fontSize: '0.875rem', fontWeight: 500, fontFamily: 'Inter, sans-serif',
                    color: tab === t ? 'var(--stone-900)' : 'var(--stone-500)',
                    borderBottom: tab === t ? '2px solid var(--gold)' : '2px solid transparent',
                    marginBottom: '-1px'
                  }}>
                  {labels[t]}
                </button>
              );
            })}
          </div>

          {tab === 'orders' && (
            <div>
              {loadingOrders ? (
                <p style={{ color: 'var(--stone-500)', fontSize: '0.875rem' }}>Loading orders...</p>
              ) : orders.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem 0' }}>
                  <p style={{ color: 'var(--stone-500)', marginBottom: '1rem' }}>No orders yet.</p>
                  <button className="btn" onClick={goBrowse}>Start Shopping</button>
                </div>
              ) : (
                <div>
                  {orders.map(order => (
                    <div key={order.id} style={{ border: '1px solid var(--stone-200)', marginBottom: '0.75rem' }}>
                      <div onClick={() => viewOrderDetail(order.id)}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.25rem',
                          cursor: 'pointer', background: expandedOrder === order.id ? 'var(--stone-50)' : '#fff'
                        }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flex: 1, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 500, fontSize: '0.875rem' }}>{order.order_number}</span>
                          <span style={{ color: 'var(--stone-500)', fontSize: '0.8125rem' }}>
                            {new Date(order.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                          {statusBadge(order.status)}
                          {parseFloat(order.total || 0) > parseFloat(order.amount_paid || 0) + 0.01 && (
                            <span style={{ display: 'inline-block', padding: '2px 8px', fontSize: '0.6875rem', fontWeight: 600, background: '#fef3c7', color: '#92400e' }}>
                              Balance Due
                            </span>
                          )}
                          <span style={{ fontWeight: 500, fontSize: '0.875rem' }}>
                            ${parseFloat(order.total).toFixed(2)}
                          </span>
                        </div>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{
                          width: 16, height: 16, transform: expandedOrder === order.id ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s'
                        }}><polyline points="6 9 12 15 18 9"/></svg>
                      </div>

                      {expandedOrder === order.id && orderDetail && (
                        <div style={{ padding: '1.25rem', borderTop: '1px solid var(--stone-200)', background: 'var(--stone-50)' }}>
                          {orderDetail.order.tracking_number && (
                            <div style={{ background: '#dbeafe', padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.8125rem', color: '#1e40af' }}>
                              Tracking: {orderDetail.order.shipping_carrier && <strong>{orderDetail.order.shipping_carrier} </strong>}
                              {orderDetail.order.tracking_number}
                              {orderDetail.order.shipped_at && <span style={{ marginLeft: '0.5rem' }}>
                                (Shipped {new Date(orderDetail.order.shipped_at).toLocaleDateString()})
                              </span>}
                            </div>
                          )}

                          {orderDetail.order.delivery_method === 'pickup' && orderDetail.fulfillment_summary && orderDetail.fulfillment_summary.total > 0 && ['confirmed', 'shipped', 'delivered'].includes(orderDetail.order.status) && (() => {
                            const { total, received } = orderDetail.fulfillment_summary;
                            const allReady = received >= total;
                            return (
                              <div style={{
                                background: allReady ? '#f0fdf4' : '#fffbeb', border: '1px solid ' + (allReady ? '#bbf7d0' : '#fde68a'),
                                padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.8125rem',
                                color: allReady ? '#166534' : '#92400e', display: 'flex', alignItems: 'center', gap: '0.75rem'
                              }}>
                                <div style={{ flex: 1 }}>
                                  <strong>{allReady ? 'All items ready for pickup!' : `${received} of ${total} items ready for pickup`}</strong>
                                  {!allReady && <div style={{ marginTop: '0.35rem', fontSize: '0.75rem', opacity: 0.8 }}>Remaining items are still being received from suppliers</div>}
                                </div>
                                <div style={{ width: 48, height: 48, borderRadius: '50%', background: allReady ? '#22c55e' : '#f59e0b', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.8125rem', flexShrink: 0 }}>
                                  {received}/{total}
                                </div>
                              </div>
                            );
                          })()}

                          {orderDetail.order.delivery_method !== 'pickup' && orderDetail.fulfillment_summary && orderDetail.fulfillment_summary.total > 0 && orderDetail.fulfillment_summary.received > 0 && orderDetail.fulfillment_summary.received < orderDetail.fulfillment_summary.total && (
                            <div style={{ background: '#dbeafe', padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.8125rem', color: '#1e40af' }}>
                              Your order is being prepared — {orderDetail.fulfillment_summary.received} of {orderDetail.fulfillment_summary.total} items received from suppliers
                            </div>
                          )}

                          <div style={{ display: 'flex', gap: '0', marginBottom: '1.25rem', fontSize: '0.75rem' }}>
                            {(() => {
                              const isPickupOrder = orderDetail.order.delivery_method === 'pickup';
                              const steps = isPickupOrder
                                ? ['pending', 'confirmed', 'ready_for_pickup', 'delivered']
                                : ['pending', 'confirmed', 'shipped', 'delivered'];
                              const stepLabels = isPickupOrder
                                ? { pending: 'pending', confirmed: 'confirmed', ready_for_pickup: 'ready', delivered: 'picked up' }
                                : { pending: 'pending', confirmed: 'confirmed', shipped: 'shipped', delivered: 'delivered' };
                              const currentIdx = steps.indexOf(orderDetail.order.status);
                              return steps.map((s, i) => {
                                const isActive = i <= currentIdx;
                                return (
                                  <div key={s} style={{ flex: 1, textAlign: 'center' }}>
                                    <div style={{
                                      width: 24, height: 24, borderRadius: '50%', margin: '0 auto 0.35rem',
                                      background: isActive ? 'var(--gold)' : 'var(--stone-200)',
                                      color: isActive ? '#fff' : 'var(--stone-500)',
                                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                                      fontSize: '0.7rem', fontWeight: 600
                                    }}>{i + 1}</div>
                                    <span style={{ color: isActive ? 'var(--stone-800)' : 'var(--stone-400)', textTransform: 'capitalize' }}>{stepLabels[s]}</span>
                                  </div>
                                );
                              });
                            })()}
                          </div>

                          <div style={{ marginBottom: '1rem' }}>
                            <h4 style={{ fontSize: '0.8125rem', fontWeight: 500, marginBottom: '0.5rem' }}>Items</h4>
                            {orderDetail.items.map(item => {
                              const fStatus = item.fulfillment_status;
                              const isPickup = orderDetail.order.delivery_method === 'pickup';
                              const badgeMap = {
                                'received': { label: isPickup ? 'Ready' : 'Received', bg: '#f0fdf4', color: '#166534' },
                                'shipped': { label: 'In Transit', bg: '#dbeafe', color: '#1e40af' },
                                'ordered': { label: 'Ordered', bg: '#fffbeb', color: '#92400e' },
                                'pending': { label: 'Processing', bg: 'var(--stone-100)', color: 'var(--stone-500)' }
                              };
                              const badge = !item.is_sample ? (badgeMap[fStatus] || badgeMap['pending']) : null;
                              return (
                                <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.4rem 0', borderBottom: '1px solid var(--stone-100)', fontSize: '0.8125rem' }}>
                                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1 }}>
                                    {item.product_name || 'Product'} {item.is_sample ? '(Sample)' : item.sell_by === 'unit' ? `x${item.num_boxes}` : `x${item.num_boxes} box${item.num_boxes !== 1 ? 'es' : ''}`}
                                    {badge && <span style={{ display: 'inline-block', padding: '1px 6px', fontSize: '0.6875rem', fontWeight: 600, background: badge.bg, color: badge.color, borderRadius: '3px', whiteSpace: 'nowrap' }}>{badge.label}</span>}
                                  </span>
                                  <span style={{ fontWeight: 500 }}>${parseFloat(item.subtotal || 0).toFixed(2)}</span>
                                </div>
                              );
                            })}
                          </div>

                          {orderDetail.balance && orderDetail.balance.balance_status === 'credit' && (
                            <div style={{ background: '#dbeafe', padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.8125rem', color: '#1e40af' }}>
                              You have a credit of <strong>${Math.abs(orderDetail.balance.balance).toFixed(2)}</strong> on this order.
                            </div>
                          )}
                          {orderDetail.balance && orderDetail.balance.balance_status === 'balance_due' && (
                            <div style={{ background: '#fef3c7', padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.8125rem', color: '#92400e' }}>
                              Balance due: <strong>${orderDetail.balance.balance.toFixed(2)}</strong> — check your email for a payment link.
                            </div>
                          )}

                          {orderDetail.order.shipping_address_line1 && (
                            <div style={{ fontSize: '0.8125rem', color: 'var(--stone-600)' }}>
                              <strong>Ships to:</strong> {orderDetail.order.shipping_address_line1}
                              {orderDetail.order.shipping_address_line2 && ', ' + orderDetail.order.shipping_address_line2}
                              , {orderDetail.order.shipping_city}, {orderDetail.order.shipping_state} {orderDetail.order.shipping_zip}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'quotes' && (
            <div>
              {loadingQuotes ? (
                <p style={{ color: 'var(--stone-500)', fontSize: '0.875rem' }}>Loading quotes...</p>
              ) : quotes.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem 0' }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 48, height: 48, color: 'var(--stone-300)', margin: '0 auto 1rem' }}>
                    <path d="M9 12h6M9 16h6M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                  </svg>
                  <p style={{ color: 'var(--stone-500)', marginBottom: '1rem' }}>No quotes yet.</p>
                  <p style={{ color: 'var(--stone-400)', fontSize: '0.8125rem' }}>
                    Quotes from our sales team will appear here.
                  </p>
                </div>
              ) : (
                <div>
                  {quotes.map(q => (
                    <div key={q.id} style={{ border: '1px solid var(--stone-200)', marginBottom: '0.75rem' }}>
                      <div onClick={() => viewQuoteDetail(q.id)}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.25rem',
                          cursor: 'pointer', background: expandedQuote === q.id ? 'var(--stone-50)' : '#fff'
                        }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', flex: 1, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 500, fontSize: '0.875rem' }}>{q.quote_number}</span>
                          <span style={{ color: 'var(--stone-500)', fontSize: '0.8125rem' }}>
                            {new Date(q.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                          {quoteStatusBadge(q.status, q.expires_at)}
                          <span style={{ fontSize: '0.8125rem', color: 'var(--stone-500)' }}>{q.item_count} item{q.item_count !== 1 ? 's' : ''}</span>
                          <span style={{ fontWeight: 500, fontSize: '0.875rem' }}>${parseFloat(q.total || 0).toFixed(2)}</span>
                        </div>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{
                          width: 16, height: 16, transform: expandedQuote === q.id ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s'
                        }}><polyline points="6 9 12 15 18 9"/></svg>
                      </div>

                      {expandedQuote === q.id && quoteDetail && (
                        <div style={{ padding: '1.25rem', borderTop: '1px solid var(--stone-200)', background: 'var(--stone-50)' }}>
                          {q.converted_order_id && (
                            <div style={{ background: '#dcfce7', padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.8125rem', color: '#166534' }}>
                              This quote has been converted to an order.
                            </div>
                          )}
                          {q.expires_at && q.status === 'sent' && new Date(q.expires_at) > new Date() && (
                            <div style={{ background: '#dbeafe', padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.8125rem', color: '#1e40af' }}>
                              Valid until {new Date(q.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                            </div>
                          )}
                          <div style={{ marginBottom: '1rem' }}>
                            <h4 style={{ fontSize: '0.8125rem', fontWeight: 500, marginBottom: '0.5rem' }}>Items</h4>
                            {quoteDetail.items.map(item => (
                              <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.4rem 0', borderBottom: '1px solid var(--stone-100)', fontSize: '0.8125rem' }}>
                                <div style={{ flex: 1 }}>
                                  <span style={{ fontWeight: 500 }}>{item.product_name || 'Product'}</span>
                                  {item.collection && <span style={{ color: 'var(--stone-500)', marginLeft: '0.5rem' }}>{item.collection}</span>}
                                  <span style={{ color: 'var(--stone-500)', marginLeft: '0.5rem' }}>
                                    {item.sell_by === 'unit' ? `x${item.num_boxes}` : `x${item.num_boxes} box${item.num_boxes !== 1 ? 'es' : ''}`}
                                  </span>
                                  {item.is_sample && <span style={{ color: 'var(--stone-400)', marginLeft: '0.5rem' }}>(Sample)</span>}
                                </div>
                                <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                                  <span style={{ color: 'var(--stone-500)', fontSize: '0.75rem', marginRight: '0.75rem' }}>
                                    ${parseFloat(item.unit_price || 0).toFixed(2)}{item.sell_by === 'unit' ? '/ea' : '/sqft'}
                                  </span>
                                  <span style={{ fontWeight: 500 }}>${parseFloat(item.subtotal || 0).toFixed(2)}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1.5rem', fontSize: '0.8125rem', paddingTop: '0.5rem' }}>
                            {parseFloat(q.shipping || 0) > 0 && (
                              <span style={{ color: 'var(--stone-600)' }}>Shipping: ${parseFloat(q.shipping).toFixed(2)}</span>
                            )}
                            <span style={{ fontWeight: 600 }}>Total: ${parseFloat(q.total || 0).toFixed(2)}</span>
                          </div>
                          {q.notes && (
                            <div style={{ marginTop: '1rem', fontSize: '0.8125rem', color: 'var(--stone-600)', fontStyle: 'italic' }}>
                              Note: {q.notes}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'samples' && (
            <div>
              {/* Sample Actions Bar */}
              <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
                <button className="btn" onClick={goBrowse} style={{ fontSize: '0.8125rem', padding: '0.5rem 1.25rem' }}>
                  Browse Products for Samples
                </button>
                {sampleRequests.filter(sr => sr.status === 'requested').length > 0 && (
                  <span style={{ display: 'flex', alignItems: 'center', fontSize: '0.8125rem', color: 'var(--stone-600)', gap: '0.35rem' }}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#f59e0b' }}></span>
                    {sampleRequests.filter(sr => sr.status === 'requested').length} open request{sampleRequests.filter(sr => sr.status === 'requested').length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>

              {loadingSamples ? (
                <p style={{ color: 'var(--stone-500)', fontSize: '0.875rem' }}>Loading samples...</p>
              ) : sampleRequests.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem 0' }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 48, height: 48, color: 'var(--stone-300)', margin: '0 auto 1rem' }}>
                    <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>
                  </svg>
                  <p style={{ color: 'var(--stone-500)', marginBottom: '1rem' }}>No sample requests yet.</p>
                  <p style={{ color: 'var(--stone-400)', fontSize: '0.8125rem', marginBottom: '1rem' }}>
                    Use the "Request Free Sample" button on any product page, or contact our team for assistance.
                  </p>
                  <button className="btn" onClick={goBrowse}>Browse Products</button>
                </div>
              ) : (
                <div>
                  {sampleRequests.map(sr => {
                    const isOpen = sr.status === 'requested';
                    const isExpanded = expandedSample === sr.id;
                    const isAdding = addItemsTo === sr.id;
                    const sColors = {
                      requested: { bg: '#fef3c7', text: '#92400e', label: 'Open' },
                      shipped: { bg: '#dbeafe', text: '#1e40af', label: 'Shipped' },
                      delivered: { bg: '#dcfce7', text: '#166534', label: 'Delivered' },
                      cancelled: { bg: '#fef2f2', text: '#991b1b', label: 'Cancelled' }
                    };
                    const sc = sColors[sr.status] || sColors.requested;
                    return (
                      <div key={sr.id} style={{ border: '1px solid var(--stone-200)', marginBottom: '0.75rem' }}>
                        <div onClick={() => setExpandedSample(isExpanded ? null : sr.id)}
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.25rem', cursor: 'pointer', background: isExpanded ? 'var(--stone-50)' : '#fff' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', flex: 1, flexWrap: 'wrap' }}>
                            <span style={{ fontWeight: 500, fontSize: '0.875rem' }}>{sr.request_number}</span>
                            <span style={{ color: 'var(--stone-500)', fontSize: '0.8125rem' }}>
                              {new Date(sr.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                            </span>
                            <span style={{ display: 'inline-block', padding: '0.2rem 0.6rem', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', background: sc.bg, color: sc.text, borderRadius: '3px' }}>{sc.label}</span>
                            <span style={{ fontSize: '0.8125rem', color: 'var(--stone-500)' }}>{(sr.items || []).length} sample{(sr.items || []).length !== 1 ? 's' : ''}</span>
                          </div>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16, transform: isExpanded ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}><polyline points="6 9 12 15 18 9"/></svg>
                        </div>

                        {isExpanded && (
                          <div style={{ padding: '1.25rem', borderTop: '1px solid var(--stone-200)', background: 'var(--stone-50)' }}>
                            {sr.tracking_number && (
                              <div style={{ background: '#dbeafe', padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.8125rem', color: '#1e40af' }}>
                                Tracking: {sr.tracking_number}
                                {sr.shipped_at && <span style={{ marginLeft: '0.5rem' }}>(Shipped {new Date(sr.shipped_at).toLocaleDateString()})</span>}
                              </div>
                            )}

                            {sr.delivery_method === 'pickup' && sr.status === 'shipped' && (
                              <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.8125rem', color: '#166534' }}>
                                Your samples are ready for pickup at our showroom.
                              </div>
                            )}

                            <div style={{ marginBottom: '1rem' }}>
                              <h4 style={{ fontSize: '0.8125rem', fontWeight: 500, marginBottom: '0.5rem' }}>Samples</h4>
                              {(sr.items || []).map(item => (
                                <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0', borderBottom: '1px solid var(--stone-100)', fontSize: '0.8125rem' }}>
                                  {item.primary_image && (
                                    <img src={optimizeImg(item.primary_image, 100)} alt={item.product_name} style={{ width: 40, height: 40, objectFit: 'cover', border: '1px solid var(--stone-200)' }} loading="lazy" />
                                  )}
                                  <div style={{ flex: 1 }}>
                                    <div style={{ fontWeight: 500 }}>{item.product_name}</div>
                                    {item.collection && <div style={{ fontSize: '0.75rem', color: 'var(--stone-500)' }}>{item.collection}</div>}
                                    {item.variant_name && <div style={{ fontSize: '0.75rem', color: 'var(--stone-500)' }}>{item.variant_name}</div>}
                                  </div>
                                  <span style={{ fontSize: '0.75rem', color: 'var(--stone-400)', textTransform: 'uppercase' }}>Free</span>
                                </div>
                              ))}
                            </div>

                            {/* Add Samples to Open Request */}
                            {isOpen && (sr.items || []).length < 5 && (
                              <div style={{ background: '#fff', border: '1px solid var(--stone-200)', padding: '1rem', marginTop: '0.5rem' }}>
                                <h4 style={{ fontSize: '0.8125rem', fontWeight: 500, marginBottom: '0.75rem' }}>Add Samples to This Request</h4>
                                <input
                                  type="text"
                                  placeholder="Search products to add..."
                                  value={isAdding ? sampleSearch : ''}
                                  onFocus={() => setAddItemsTo(sr.id)}
                                  onChange={e => { setAddItemsTo(sr.id); setSampleSearch(e.target.value); searchProducts(e.target.value); }}
                                  style={{ width: '100%', padding: '0.5rem 0.75rem', border: '1px solid var(--stone-200)', fontSize: '0.8125rem', fontFamily: 'Inter, sans-serif', outline: 'none', marginBottom: '0.5rem' }}
                                />
                                {isAdding && searchingProducts && (
                                  <p style={{ fontSize: '0.75rem', color: 'var(--stone-400)' }}>Searching...</p>
                                )}
                                {isAdding && sampleSearchResults.length > 0 && (
                                  <div style={{ border: '1px solid var(--stone-200)', maxHeight: 200, overflowY: 'auto' }}>
                                    {sampleSearchResults.map(sku => {
                                      const alreadyAdded = (sr.items || []).some(i => i.product_id === sku.product_id);
                                      return (
                                        <div key={sku.sku_id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--stone-100)', fontSize: '0.8125rem' }}>
                                          {sku.primary_image && <img src={optimizeImg(sku.primary_image, 100)} alt="" style={{ width: 32, height: 32, objectFit: 'cover' }} loading="lazy" />}
                                          <div style={{ flex: 1 }}>
                                            <div style={{ fontWeight: 500 }}>{sku.product_name || sku.collection}</div>
                                            {sku.variant_name && <div style={{ fontSize: '0.75rem', color: 'var(--stone-500)' }}>{sku.variant_name}</div>}
                                          </div>
                                          {alreadyAdded ? (
                                            <span style={{ fontSize: '0.6875rem', color: 'var(--stone-400)' }}>Added</span>
                                          ) : (
                                            <button
                                              onClick={() => addSampleItem(sr.id, sku.product_id, sku.sku_id)}
                                              disabled={addingSampleItem === (sku.sku_id || sku.product_id)}
                                              style={{ background: 'var(--stone-900)', color: '#fff', border: 'none', padding: '0.25rem 0.75rem', fontSize: '0.75rem', cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
                                              {addingSampleItem === (sku.sku_id || sku.product_id) ? '...' : '+ Add'}
                                            </button>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                                <p style={{ fontSize: '0.6875rem', color: 'var(--stone-400)', marginTop: '0.5rem' }}>
                                  {5 - (sr.items || []).length} more sample{5 - (sr.items || []).length !== 1 ? 's' : ''} can be added
                                </p>
                              </div>
                            )}

                            {sr.delivery_method && (
                              <div style={{ fontSize: '0.8125rem', color: 'var(--stone-600)', marginTop: '0.75rem' }}>
                                <strong>Delivery:</strong> {sr.delivery_method === 'pickup' ? 'Showroom Pickup' : 'Shipping'}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {tab === 'visits' && (
            <div>
              {loadingVisits ? (
                <p style={{ color: 'var(--stone-500)', fontSize: '0.875rem' }}>Loading visits...</p>
              ) : visits.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem 0' }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 48, height: 48, color: 'var(--stone-300)', margin: '0 auto 1rem' }}>
                    <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4"/>
                  </svg>
                  <p style={{ color: 'var(--stone-500)', marginBottom: '1rem' }}>No showroom visits yet.</p>
                  <p style={{ color: 'var(--stone-400)', fontSize: '0.8125rem' }}>
                    After visiting our showroom, your product recommendations will appear here.
                  </p>
                </div>
              ) : (
                <div>
                  {visits.map(v => (
                    <div key={v.id} style={{ border: '1px solid var(--stone-200)', marginBottom: '0.75rem' }}>
                      <div onClick={() => viewVisitDetail(v.id)}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.25rem',
                          cursor: 'pointer', background: expandedVisit === v.id ? 'var(--stone-50)' : '#fff'
                        }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', flex: 1, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 500, fontSize: '0.875rem' }}>
                            {new Date(v.sent_at || v.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                          <span style={{ fontSize: '0.8125rem', color: 'var(--stone-500)' }}>{v.item_count} product{v.item_count !== 1 ? 's' : ''}</span>
                          <span style={{ display: 'inline-block', padding: '0.2rem 0.6rem', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', background: '#dbeafe', color: '#1e40af', borderRadius: '3px' }}>
                            Showroom Visit
                          </span>
                        </div>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{
                          width: 16, height: 16, transform: expandedVisit === v.id ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s'
                        }}><polyline points="6 9 12 15 18 9"/></svg>
                      </div>

                      {expandedVisit === v.id && visitDetail && (
                        <div style={{ padding: '1.25rem', borderTop: '1px solid var(--stone-200)', background: 'var(--stone-50)' }}>
                          {v.message && (
                            <div style={{ background: '#dbeafe', padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.8125rem', color: '#1e40af', fontStyle: 'italic' }}>
                              "{v.message}"
                            </div>
                          )}
                          <div style={{ marginBottom: '1rem' }}>
                            <h4 style={{ fontSize: '0.8125rem', fontWeight: 500, marginBottom: '0.5rem' }}>Recommended Products</h4>
                            {visitDetail.items.map(item => (
                              <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0', borderBottom: '1px solid var(--stone-100)', fontSize: '0.8125rem' }}>
                                {item.primary_image && (
                                  <img src={optimizeImg(item.primary_image, 100)} alt={item.product_name} style={{ width: 48, height: 48, objectFit: 'cover', border: '1px solid var(--stone-200)' }} loading="lazy" />
                                )}
                                <div style={{ flex: 1 }}>
                                  <div style={{ fontWeight: 500 }}>{item.product_name}</div>
                                  {item.collection && <div style={{ fontSize: '0.75rem', color: 'var(--stone-500)' }}>{item.collection}</div>}
                                  {item.variant_name && <div style={{ fontSize: '0.75rem', color: 'var(--stone-500)' }}>{item.variant_name}</div>}
                                </div>
                                {item.retail_price && (
                                  <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>
                                    ${displayPrice(item, item.retail_price).toFixed(2)}{priceSuffix(item)}
                                  </span>
                                )}
                                {item.rep_note && (
                                  <span style={{ fontSize: '0.75rem', color: 'var(--stone-500)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.rep_note}>
                                    {item.rep_note}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'profile' && (
            <div>
              {profileMsg && <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#166534', padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.8125rem' }}>{profileMsg}</div>}
              {profileError && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.8125rem' }}>{profileError}</div>}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div style={fieldStyle}>
                  <label style={labelStyle}>First Name</label>
                  <input style={inputStyle} value={firstName} onChange={e => setFirstName(e.target.value)} />
                </div>
                <div style={fieldStyle}>
                  <label style={labelStyle}>Last Name</label>
                  <input style={inputStyle} value={lastName} onChange={e => setLastName(e.target.value)} />
                </div>
              </div>
              <div style={fieldStyle}>
                <label style={labelStyle}>Email</label>
                <input style={{ ...inputStyle, background: 'var(--stone-100)', color: 'var(--stone-500)' }} value={customer.email} readOnly />
              </div>
              <div style={fieldStyle}>
                <label style={labelStyle}>Phone</label>
                <input style={inputStyle} type="tel" value={phone} onChange={e => setPhone(formatPhone(e.target.value))} placeholder="(555) 123-4567" />
              </div>

              <h3 style={{ fontSize: '1rem', fontWeight: 500, marginTop: '1.5rem', marginBottom: '1rem' }}>Saved Address</h3>
              <div style={fieldStyle}>
                <label style={labelStyle}>Address Line 1</label>
                <input style={inputStyle} value={addressLine1} onChange={e => setAddressLine1(e.target.value)} placeholder="123 Main Street" />
              </div>
              <div style={fieldStyle}>
                <label style={labelStyle}>Address Line 2</label>
                <input style={inputStyle} value={addressLine2} onChange={e => setAddressLine2(e.target.value)} placeholder="Apt, Suite, Unit" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '0.75rem' }}>
                <div style={fieldStyle}>
                  <label style={labelStyle}>City</label>
                  <input style={inputStyle} value={city} onChange={e => setCity(e.target.value)} />
                </div>
                <div style={fieldStyle}>
                  <label style={labelStyle}>State</label>
                  <select style={{ ...inputStyle, padding: '0.65rem 0.5rem' }} value={addrState} onChange={e => setAddrState(e.target.value)}>
                    <option value="">Select</option>
                    {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div style={fieldStyle}>
                  <label style={labelStyle}>ZIP</label>
                  <input style={inputStyle} value={zip} onChange={e => setZip(e.target.value)} />
                </div>
              </div>
              <button className="btn" onClick={saveProfile} disabled={saving} style={{ marginBottom: '2.5rem' }}>
                {saving ? 'Saving...' : 'Save Changes'}
              </button>

              <h3 style={{ fontSize: '1rem', fontWeight: 500, marginBottom: '1rem', paddingTop: '1.5rem', borderTop: '1px solid var(--stone-200)' }}>Change Password</h3>
              {pwMsg && <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#166534', padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.8125rem' }}>{pwMsg}</div>}
              {pwError && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.8125rem' }}>{pwError}</div>}
              <div style={fieldStyle}>
                <label style={labelStyle}>Current Password</label>
                <input style={inputStyle} type="password" value={currentPw} onChange={e => setCurrentPw(e.target.value)} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div style={fieldStyle}>
                  <label style={labelStyle}>New Password</label>
                  <input style={inputStyle} type="password" value={newPw} onChange={e => setNewPw(e.target.value)} />
                </div>
                <div style={fieldStyle}>
                  <label style={labelStyle}>Confirm New Password</label>
                  <input style={inputStyle} type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} />
                </div>
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--stone-500)', marginBottom: '1rem' }}>8+ characters, 1 uppercase letter, 1 number</p>
              <button className="btn" onClick={changePassword} disabled={pwSaving}>
                {pwSaving ? 'Updating...' : 'Update Password'}
              </button>
            </div>
          )}
        </div>
      );
    }

    // ==================== Wishlist Page ====================

    function WishlistPage({ wishlist, toggleWishlist, onSkuClick, goBrowse, recentlyViewed, goHome }) {
      const [skus, setSkus] = useState([]);
      const [loading, setLoading] = useState(true);

      useEffect(() => {
        if (wishlist.length === 0) {
          setSkus([]);
          setLoading(false);
          return;
        }
        // Fetch wishlisted product SKUs by product_id filter
        const productIds = wishlist.join(',');
        fetch(API + '/api/storefront/skus?product_ids=' + encodeURIComponent(productIds) + '&limit=' + wishlist.length * 2)
          .then(r => r.json())
          .then(data => {
            const all = data.skus || [];
            // Get one representative SKU per wishlisted product
            const seen = new Set();
            const wishlisted = [];
            all.forEach(sku => {
              if (wishlist.includes(sku.product_id) && !seen.has(sku.product_id)) {
                seen.add(sku.product_id);
                wishlisted.push(sku);
              }
            });
            setSkus(wishlisted);
            setLoading(false);
          })
          .catch(() => setLoading(false));
      }, [wishlist]);

      return (
        <div className="wishlist-page">
          <Breadcrumbs items={[
            { label: 'Home', onClick: goHome },
            { label: 'Wishlist' }
          ]} />
          <h1>Wishlist <span style={{ fontSize: '1.25rem', color: 'var(--stone-600)', fontWeight: 300 }}>({wishlist.length})</span></h1>
          {loading ? (
            <SkeletonGrid count={4} />
          ) : skus.length === 0 ? (
            <div className="wishlist-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 56, height: 56, color: 'var(--stone-300)', marginBottom: '1rem' }}>
                <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/>
              </svg>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.75rem', fontWeight: 300, marginBottom: '0.5rem' }}>Your Wishlist is Empty</h2>
              <p>Save your favorite products by clicking the heart icon while you browse.</p>
              <button className="btn" onClick={goBrowse} style={{ marginTop: '0.5rem' }}>Browse Products</button>
              {recentlyViewed && recentlyViewed.length > 0 && (
                <div style={{ marginTop: '3rem', textAlign: 'left' }}>
                  <h3 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.5rem', fontWeight: 300, marginBottom: '1rem', textAlign: 'center' }}>Recently Viewed</h3>
                  <div className="siblings-strip">
                    {recentlyViewed.slice(0, 6).map(rv => (
                      <div key={rv.sku_id} className="sibling-card" onClick={() => onSkuClick(rv.sku_id, rv.product_name)}>
                        <div className="sibling-card-image">
                          {rv.primary_image && <img src={optimizeImg(rv.primary_image, 400)} alt={rv.product_name} loading="lazy" />}
                        </div>
                        <div className="sibling-card-name">{fullProductName(rv)}</div>
                        {rv.retail_price && <div className="sibling-card-price">${displayPrice(rv, rv.retail_price).toFixed(2)}{priceSuffix(rv)}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="sku-grid">
              {skus.map(sku => (
                <SkuCard key={sku.sku_id} sku={sku} onClick={() => onSkuClick(sku.sku_id, sku.product_name || sku.collection)}
                  isWished={true}
                  onToggleWishlist={() => toggleWishlist(sku.product_id)} />
              ))}
            </div>
          )}
        </div>
      );
    }

    // ==================== Trade Dashboard ====================

    function TradeDashboard({ tradeCustomer, tradeToken, addToCart, goBrowse, setTradeCustomer, handleTradeLogout, goBulkOrder, showToast }) {
      const [tab, setTab] = useState('overview');
      const [dashData, setDashData] = useState(null);
      const [orders, setOrders] = useState([]);
      const [projects, setProjects] = useState([]);
      const [favorites, setFavorites] = useState([]);
      const [account, setAccount] = useState(null);
      const [loading, setLoading] = useState(true);
      const [membership, setMembership] = useState(null);
      const [rep, setRep] = useState(null);
      const [showProjectForm, setShowProjectForm] = useState(false);
      const [projectForm, setProjectForm] = useState({ name: '', client_name: '', address: '', notes: '' });
      const [editingProject, setEditingProject] = useState(null);
      const [showFavForm, setShowFavForm] = useState(false);
      const [favName, setFavName] = useState('');
      const [expandedOrder, setExpandedOrder] = useState(null);
      const [quotes, setQuotes] = useState([]);
      const [expandedQuote, setExpandedQuote] = useState(null);
      const [quoteDetail, setQuoteDetail] = useState(null);
      const [visits, setVisits] = useState([]);
      const [expandedVisit, setExpandedVisit] = useState(null);
      const [visitDetail, setVisitDetail] = useState(null);

      const headers = { 'X-Trade-Token': tradeToken, 'Content-Type': 'application/json' };
      const authHeaders = { 'X-Trade-Token': tradeToken };

      const loadTab = (t) => {
        setLoading(true);
        if (t === 'overview') {
          fetch(API + '/api/trade/dashboard', { headers: authHeaders })
            .then(r => r.json()).then(d => { setDashData(d); setLoading(false); }).catch(() => setLoading(false));
        } else if (t === 'orders') {
          Promise.all([
            fetch(API + '/api/trade/orders', { headers: authHeaders }).then(r => r.json()),
            fetch(API + '/api/trade/projects', { headers: authHeaders }).then(r => r.json()).catch(() => ({ projects: [] }))
          ]).then(([od, pd]) => { setOrders(od.orders || []); setProjects(pd.projects || []); setLoading(false); }).catch(() => setLoading(false));
        } else if (t === 'projects') {
          fetch(API + '/api/trade/projects', { headers: authHeaders })
            .then(r => r.json()).then(d => { setProjects(d.projects || []); setLoading(false); }).catch(() => setLoading(false));
        } else if (t === 'favorites') {
          fetch(API + '/api/trade/favorites', { headers: authHeaders })
            .then(r => r.json()).then(d => { setFavorites(d.collections || []); setLoading(false); }).catch(() => setLoading(false));
        } else if (t === 'quotes') {
          fetch(API + '/api/trade/quotes', { headers: authHeaders })
            .then(r => r.json()).then(d => { setQuotes(d.quotes || []); setExpandedQuote(null); setQuoteDetail(null); setLoading(false); }).catch(() => setLoading(false));
        } else if (t === 'visits') {
          fetch(API + '/api/trade/visits', { headers: authHeaders })
            .then(r => r.json()).then(d => { setVisits(d.visits || []); setExpandedVisit(null); setVisitDetail(null); setLoading(false); }).catch(() => setLoading(false));
        } else if (t === 'account') {
          Promise.all([
            fetch(API + '/api/trade/account', { headers: authHeaders }).then(r => r.json()),
            fetch(API + '/api/trade/membership', { headers: authHeaders }).then(r => r.json()).catch(() => ({})),
            fetch(API + '/api/trade/my-rep', { headers: authHeaders }).then(r => r.json()).catch(() => ({}))
          ]).then(([acc, mem, rp]) => {
            setAccount(acc.customer || acc);
            setMembership(mem);
            setRep(rp.rep || null);
            setLoading(false);
          }).catch(() => setLoading(false));
        }
      };

      useEffect(() => { loadTab(tab); }, [tab]);

      const saveProject = async () => {
        const method = editingProject ? 'PUT' : 'POST';
        const url = editingProject ? API + '/api/trade/projects/' + editingProject : API + '/api/trade/projects';
        await fetch(url, { method, headers, body: JSON.stringify(projectForm) });
        setShowProjectForm(false); setEditingProject(null);
        setProjectForm({ name: '', client_name: '', address: '', notes: '' });
        loadTab('projects');
      };

      const createCollection = async () => {
        if (!favName.trim()) return;
        await fetch(API + '/api/trade/favorites', { method: 'POST', headers, body: JSON.stringify({ collection_name: favName }) });
        setShowFavForm(false); setFavName('');
        loadTab('favorites');
      };

      const cancelMembership = async () => {
        if (!confirm('Cancel your trade membership? You will retain access until your current period ends.')) return;
        await fetch(API + '/api/trade/cancel-membership', { method: 'POST', headers: authHeaders });
        loadTab('account');
      };

      const deleteProject = async (id) => {
        if (!confirm('Delete this project?')) return;
        await fetch(API + '/api/trade/projects/' + id, { method: 'DELETE', headers: authHeaders });
        loadTab('projects');
      };

      const deleteCollection = async (id) => {
        if (!confirm('Delete this collection and all its items?')) return;
        await fetch(API + '/api/trade/favorites/' + id, { method: 'DELETE', headers: authHeaders });
        loadTab('favorites');
      };

      const expandQuote = async (quoteId) => {
        if (expandedQuote === quoteId) { setExpandedQuote(null); setQuoteDetail(null); return; }
        setExpandedQuote(quoteId);
        const resp = await fetch(API + '/api/trade/quotes/' + quoteId, { headers: authHeaders });
        const data = await resp.json();
        setQuoteDetail(data);
      };

      const expandVisit = async (visitId) => {
        if (expandedVisit === visitId) { setExpandedVisit(null); setVisitDetail(null); return; }
        setExpandedVisit(visitId);
        const resp = await fetch(API + '/api/trade/visits/' + visitId, { headers: authHeaders });
        const data = await resp.json();
        setVisitDetail(data);
      };

      const acceptQuote = async (quoteId) => {
        if (!confirm('Accept this quote and convert it to an order?')) return;
        const resp = await fetch(API + '/api/trade/quotes/' + quoteId + '/accept', { method: 'POST', headers: authHeaders });
        if (resp.ok) { showToast('Quote accepted! Order has been created.', 'success'); loadTab('quotes'); }
        else { const d = await resp.json(); showToast(d.error || 'Failed to accept quote', 'error'); }
      };

      const downloadQuotePdf = (quoteId) => {
        window.open(API + '/api/trade/quotes/' + quoteId + '/pdf?token=' + tradeToken, '_blank');
      };

      const assignOrderProject = async (orderId, projectId) => {
        await fetch(API + '/api/trade/orders/' + orderId + '/project', {
          method: 'PUT', headers, body: JSON.stringify({ project_id: projectId || null })
        });
        loadTab('orders');
      };

      const [editAccount, setEditAccount] = useState(false);
      const [accountForm, setAccountForm] = useState({});
      const [passwordForm, setPasswordForm] = useState({ current: '', new_password: '', confirm: '' });
      const [showPwForm, setShowPwForm] = useState(false);

      const saveAccount = async () => {
        await fetch(API + '/api/trade/account', { method: 'PUT', headers, body: JSON.stringify(accountForm) });
        setEditAccount(false); loadTab('account');
      };

      const changePassword = async () => {
        if (passwordForm.new_password !== passwordForm.confirm) { showToast('Passwords do not match', 'error'); return; }
        const resp = await fetch(API + '/api/trade/change-password', {
          method: 'POST', headers, body: JSON.stringify({ current_password: passwordForm.current, new_password: passwordForm.new_password })
        });
        if (resp.ok) { showToast('Password updated', 'success'); setShowPwForm(false); setPasswordForm({ current: '', new_password: '', confirm: '' }); }
        else { const d = await resp.json(); showToast(d.error || 'Failed to change password', 'error'); }
      };

      const tabs = ['overview', 'orders', 'quotes', 'visits', 'projects', 'favorites', 'account'];
      const tabIcons = {
        overview: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
        orders: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>,
        quotes: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
        visits: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4"/></svg>,
        projects: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>,
        favorites: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>,
        account: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      };

      return (
        <div className="trade-dashboard">
          <div className="trade-dash-header">
            <h1>Trade Dashboard</h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.875rem', color: 'var(--stone-500)' }}>
              {tradeCustomer.company_name}
              <span className="trade-tier-badge">{tradeCustomer.tier_name || 'Silver'}</span>
            </div>
          </div>

          <div className="trade-dash-tabs">
            {tabs.map(t => (
              <button key={t} className={'trade-dash-tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)}>
                {tabIcons[t]}
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {loading ? (
            <div>
              <div className="skeleton-stat-grid">
                {[0, 1, 2, 3].map(i => <div key={i} className="skeleton-stat-card" />)}
              </div>
              <div style={{ marginTop: '2rem' }}>
                {[0, 1, 2].map(i => <div key={i} className="skeleton-table-row" />)}
              </div>
            </div>
          ) : (
            <>
              {/* Overview */}
              {tab === 'overview' && dashData && (
                <div>
                  <div className="trade-stat-grid">
                    <div className="trade-stat-card" style={{ background: 'linear-gradient(135deg, #fffbf0 0%, white 100%)' }}>
                      <label>Tier</label><div className="value">{dashData.tier_name || 'Silver'}</div>
                    </div>
                    <div className="trade-stat-card" style={{ background: 'linear-gradient(135deg, #f0fdf4 0%, white 100%)' }}>
                      <label>Total Spend</label><div className="value">${parseFloat(dashData.total_spend || 0).toLocaleString()}</div>
                    </div>
                    <div className="trade-stat-card" style={{ background: 'linear-gradient(135deg, #f0f9ff 0%, white 100%)' }}>
                      <label>Orders</label><div className="value">{dashData.order_count || 0}</div>
                    </div>
                    <div className="trade-stat-card" style={{ background: 'linear-gradient(135deg, #faf5ff 0%, white 100%)' }}>
                      <label>Membership</label><div className="value" style={{ fontSize: '1.25rem' }}>{dashData.subscription_status === 'active' ? 'Active' : dashData.subscription_status || 'Pending'}</div>
                    </div>
                  </div>
                  {dashData.next_tier_name && (
                    <div className="trade-tier-progress">
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem' }}>
                        <span>Progress to <strong>{dashData.next_tier_name}</strong></span>
                        <span>${parseFloat(dashData.total_spend || 0).toLocaleString()} / ${parseFloat(dashData.next_tier_threshold || 0).toLocaleString()}</span>
                      </div>
                      <div className="trade-tier-bar">
                        <div className="trade-tier-bar-fill" style={{ width: Math.min(100, (parseFloat(dashData.total_spend || 0) / parseFloat(dashData.next_tier_threshold || 1) * 100)) + '%' }}></div>
                      </div>
                    </div>
                  )}
                  {dashData.recent_orders && dashData.recent_orders.length > 0 && (
                    <div className="trade-card">
                      <h3>Recent Orders</h3>
                      <table className="trade-orders-table">
                        <thead><tr><th>Order #</th><th>Date</th><th>Total</th><th>Status</th></tr></thead>
                        <tbody>
                          {dashData.recent_orders.map(o => (
                            <tr key={o.id}>
                              <td style={{ fontWeight: 500 }}>{o.order_number}</td>
                              <td>{new Date(o.created_at).toLocaleDateString()}</td>
                              <td>${parseFloat(o.total).toFixed(2)}</td>
                              <td><span className={'trade-status-badge ' + (o.status || 'pending')}>{o.status}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
                    <button className="btn" onClick={goBrowse}>Shop Products</button>
                  </div>
                </div>
              )}

              {/* Orders */}
              {tab === 'orders' && (
                <div>
                  {orders.length === 0 ? (
                    <div className="trade-empty-state">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
                      <p>No orders yet</p>
                      <button className="btn" onClick={goBrowse}>Start Shopping</button>
                    </div>
                  ) : (
                    <table className="trade-orders-table">
                      <thead><tr><th>Order #</th><th>Date</th><th>Items</th><th>Total</th><th>Status</th><th>PO #</th><th>Project</th><th></th></tr></thead>
                      <tbody>
                        {orders.map(o => (
                          <React.Fragment key={o.id}>
                            <tr onClick={() => setExpandedOrder(expandedOrder === o.id ? null : o.id)} style={{ cursor: 'pointer' }}>
                              <td style={{ fontWeight: 500 }}>{o.order_number}</td>
                              <td>{new Date(o.created_at).toLocaleDateString()}</td>
                              <td>{o.item_count}</td>
                              <td>${parseFloat(o.total).toFixed(2)}</td>
                              <td><span className={'trade-status-badge ' + (o.status || 'pending')}>{o.status}</span></td>
                              <td style={{ fontSize: '0.8125rem', color: 'var(--stone-500)' }}>{o.po_number || '\u2014'}</td>
                              <td onClick={e => e.stopPropagation()}>
                                <select value={o.project_id || ''} onChange={e => assignOrderProject(o.id, e.target.value)}
                                  style={{ fontSize: '0.75rem', padding: '0.2rem', border: '1px solid var(--stone-300)' }}>
                                  <option value="">None</option>
                                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                </select>
                              </td>
                              <td style={{ fontSize: '0.8125rem' }}>{expandedOrder === o.id ? '\u25B2' : '\u25BC'}</td>
                            </tr>
                            {expandedOrder === o.id && o.items && (
                              <tr><td colSpan="8" style={{ background: 'var(--stone-50)', padding: '1rem' }}>
                                {o.items.map((item, idx) => (
                                  <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.35rem 0', fontSize: '0.8125rem' }}>
                                    <span>{item.product_name} — {item.sku_code}</span>
                                    <span>{item.quantity} x ${parseFloat(item.unit_price).toFixed(2)}</span>
                                  </div>
                                ))}
                              </td></tr>
                            )}
                          </React.Fragment>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {/* Quotes */}
              {tab === 'quotes' && (
                <div>
                  {quotes.length > 0 ? (
                    <div className="trade-card">
                      <table className="trade-orders-table">
                        <thead><tr><th>Quote #</th><th>Date</th><th>Items</th><th>Total</th><th>Expires</th><th>Status</th><th></th></tr></thead>
                        <tbody>
                          {quotes.map(q => {
                            const isExpired = q.expires_at && new Date(q.expires_at) < new Date();
                            const daysLeft = q.expires_at ? Math.ceil((new Date(q.expires_at) - new Date()) / (1000 * 60 * 60 * 24)) : null;
                            return (
                              <React.Fragment key={q.id}>
                                <tr style={{ cursor: 'pointer' }} onClick={() => expandQuote(q.id)}>
                                  <td style={{ fontWeight: 500 }}>{q.quote_number || 'Q-' + q.id.substring(0, 8).toUpperCase()}</td>
                                  <td>{new Date(q.created_at).toLocaleDateString()}</td>
                                  <td>{q.item_count || 0}</td>
                                  <td>${parseFloat(q.total || 0).toFixed(2)}</td>
                                  <td>
                                    {q.expires_at ? (
                                      <span style={{ color: isExpired ? '#dc2626' : (daysLeft <= 3 ? '#ea580c' : 'inherit'), fontWeight: isExpired || daysLeft <= 3 ? 600 : 400 }}>
                                        {isExpired ? 'Expired' : daysLeft + ' days left'}
                                      </span>
                                    ) : '\u2014'}
                                  </td>
                                  <td><span className={'trade-status-badge ' + (q.status || 'draft')}>{q.status === 'converted' ? 'Accepted' : (q.status || 'draft')}</span></td>
                                  <td style={{ textAlign: 'right' }}>
                                    <button onClick={(e) => { e.stopPropagation(); downloadQuotePdf(q.id); }}
                                      style={{ background: 'none', border: 'none', color: 'var(--gold)', fontSize: '0.8125rem', cursor: 'pointer', fontWeight: 500, marginRight: '0.5rem' }}>PDF</button>
                                    {q.status !== 'converted' && !isExpired && (
                                      <button onClick={(e) => { e.stopPropagation(); acceptQuote(q.id); }}
                                        className="btn" style={{ padding: '0.25rem 0.75rem', fontSize: '0.75rem' }}>Accept</button>
                                    )}
                                  </td>
                                </tr>
                                {expandedQuote === q.id && quoteDetail && (
                                  <tr><td colSpan="7" style={{ padding: '1rem 1.5rem', background: '#fafaf9' }}>
                                    <table style={{ width: '100%', fontSize: '0.8125rem' }}>
                                      <thead><tr style={{ borderBottom: '1px solid var(--stone-200)' }}>
                                        <th style={{ padding: '0.5rem', fontWeight: 500 }}>Item</th>
                                        <th style={{ padding: '0.5rem', fontWeight: 500, textAlign: 'right' }}>Qty</th>
                                        <th style={{ padding: '0.5rem', fontWeight: 500, textAlign: 'right' }}>Unit Price</th>
                                        <th style={{ padding: '0.5rem', fontWeight: 500, textAlign: 'right' }}>Subtotal</th>
                                      </tr></thead>
                                      <tbody>
                                        {(quoteDetail.items || []).map((item, i) => (
                                          <tr key={i} style={{ borderBottom: '1px solid #e7e5e4' }}>
                                            <td style={{ padding: '0.5rem' }}>{item.product_name || ''}</td>
                                            <td style={{ padding: '0.5rem', textAlign: 'right' }}>{item.num_boxes || item.quantity || 1}</td>
                                            <td style={{ padding: '0.5rem', textAlign: 'right' }}>${parseFloat(item.unit_price || 0).toFixed(2)}</td>
                                            <td style={{ padding: '0.5rem', textAlign: 'right' }}>${parseFloat(item.subtotal || 0).toFixed(2)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                    <div style={{ textAlign: 'right', marginTop: '0.75rem', fontWeight: 500 }}>Total: ${parseFloat(q.total || 0).toFixed(2)}</div>
                                  </td></tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="trade-empty-state">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                      <p>No quotes yet. Contact your trade representative to request a custom quote.</p>
                    </div>
                  )}
                </div>
              )}

              {/* Visits */}
              {tab === 'visits' && (
                <div>
                  {visits.length > 0 ? (
                    <div className="trade-card">
                      <table className="trade-orders-table">
                        <thead><tr><th>Date</th><th>Products</th><th>Status</th><th></th></tr></thead>
                        <tbody>
                          {visits.map(v => (
                            <React.Fragment key={v.id}>
                              <tr style={{ cursor: 'pointer' }} onClick={() => expandVisit(v.id)}>
                                <td style={{ fontWeight: 500 }}>{new Date(v.sent_at || v.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                                <td>{v.item_count} product{v.item_count !== 1 ? 's' : ''}</td>
                                <td><span className="trade-status-badge sent">Showroom Visit</span></td>
                                <td style={{ textAlign: 'right' }}>
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{
                                    width: 16, height: 16, transform: expandedVisit === v.id ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s'
                                  }}><polyline points="6 9 12 15 18 9"/></svg>
                                </td>
                              </tr>
                              {expandedVisit === v.id && visitDetail && (
                                <tr><td colSpan="4" style={{ padding: '1rem 1.5rem', background: '#fafaf9' }}>
                                  {v.message && (
                                    <div style={{ background: '#dbeafe', padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.8125rem', color: '#1e40af', fontStyle: 'italic', borderRadius: '4px' }}>
                                      "{v.message}"
                                    </div>
                                  )}
                                  <table style={{ width: '100%', fontSize: '0.8125rem' }}>
                                    <thead><tr style={{ borderBottom: '1px solid var(--stone-200)' }}>
                                      <th style={{ padding: '0.5rem', fontWeight: 500, width: 56 }}></th>
                                      <th style={{ padding: '0.5rem', fontWeight: 500 }}>Product</th>
                                      <th style={{ padding: '0.5rem', fontWeight: 500 }}>Variant</th>
                                      <th style={{ padding: '0.5rem', fontWeight: 500, textAlign: 'right' }}>Price</th>
                                      <th style={{ padding: '0.5rem', fontWeight: 500 }}>Note</th>
                                    </tr></thead>
                                    <tbody>
                                      {(visitDetail.items || []).map((item, i) => (
                                        <tr key={i} style={{ borderBottom: '1px solid #e7e5e4' }}>
                                          <td style={{ padding: '0.5rem' }}>
                                            {item.primary_image && <img src={optimizeImg(item.primary_image, 100)} alt="" style={{ width: 40, height: 40, objectFit: 'cover', border: '1px solid var(--stone-200)' }} loading="lazy" />}
                                          </td>
                                          <td style={{ padding: '0.5rem' }}>
                                            <div style={{ fontWeight: 500 }}>{item.product_name}</div>
                                            {item.collection && <div style={{ fontSize: '0.75rem', color: 'var(--stone-500)' }}>{item.collection}</div>}
                                          </td>
                                          <td style={{ padding: '0.5rem', color: 'var(--stone-600)' }}>{item.variant_name || '\u2014'}</td>
                                          <td style={{ padding: '0.5rem', textAlign: 'right' }}>
                                            {item.retail_price ? `$${displayPrice(item, item.retail_price).toFixed(2)}${priceSuffix(item)}` : '\u2014'}
                                          </td>
                                          <td style={{ padding: '0.5rem', color: 'var(--stone-500)', fontSize: '0.75rem', maxWidth: 180 }}>{item.rep_note || ''}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </td></tr>
                              )}
                            </React.Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="trade-empty-state">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4"/></svg>
                      <p>No showroom visits yet. After visiting our showroom, your product recommendations will appear here.</p>
                    </div>
                  )}
                </div>
              )}

              {/* Projects */}
              {tab === 'projects' && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                    <span style={{ fontSize: '0.875rem', color: 'var(--stone-500)' }}>{projects.length} project{projects.length !== 1 ? 's' : ''}</span>
                    <button className="btn" onClick={() => { setShowProjectForm(true); setEditingProject(null); setProjectForm({ name: '', client_name: '', address: '', notes: '' }); }}>New Project</button>
                  </div>
                  {showProjectForm && (
                    <div className="trade-card" style={{ marginBottom: '1.5rem' }}>
                      <h3>{editingProject ? 'Edit Project' : 'New Project'}</h3>
                      <div className="trade-field"><label>Project Name *</label><input type="text" value={projectForm.name} onChange={e => setProjectForm({ ...projectForm, name: e.target.value })} /></div>
                      <div className="trade-field"><label>Client Name</label><input type="text" value={projectForm.client_name} onChange={e => setProjectForm({ ...projectForm, client_name: e.target.value })} /></div>
                      <div className="trade-field"><label>Address</label><input type="text" value={projectForm.address} onChange={e => setProjectForm({ ...projectForm, address: e.target.value })} /></div>
                      <div className="trade-field"><label>Notes</label><input type="text" value={projectForm.notes} onChange={e => setProjectForm({ ...projectForm, notes: e.target.value })} /></div>
                      <div className="trade-btn-row">
                        <button type="button" className="trade-btn-secondary" onClick={() => setShowProjectForm(false)}>Cancel</button>
                        <button className="btn" onClick={saveProject} disabled={!projectForm.name}>Save</button>
                      </div>
                    </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1rem' }}>
                    {projects.map(p => (
                      <div key={p.id} className="trade-project-card" onClick={() => {
                        setEditingProject(p.id);
                        setProjectForm({ name: p.name, client_name: p.client_name || '', address: p.address || '', notes: p.notes || '' });
                        setShowProjectForm(true);
                      }}>
                        <h4>{p.name}</h4>
                        {p.client_name && <div style={{ fontSize: '0.8125rem', color: 'var(--stone-500)' }}>{p.client_name}</div>}
                        {p.address && <div style={{ fontSize: '0.8125rem', color: 'var(--stone-500)' }}>{p.address}</div>}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
                          <span style={{ fontSize: '0.75rem', color: 'var(--stone-400)' }}>{p.order_count || 0} order{(p.order_count || 0) !== 1 ? 's' : ''}</span>
                          <button onClick={e => { e.stopPropagation(); deleteProject(p.id); }}
                            style={{ background: 'none', border: 'none', color: '#dc2626', fontSize: '0.75rem', cursor: 'pointer' }}>Delete</button>
                        </div>
                      </div>
                    ))}
                  </div>
                  {projects.length === 0 && !showProjectForm && (
                    <div className="trade-empty-state">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                      <p>No projects yet. Create one to organize your orders.</p>
                      <button className="btn" onClick={() => { setShowProjectForm(true); setEditingProject(null); setProjectForm({ name: '', client_name: '', address: '', notes: '' }); }}>New Project</button>
                    </div>
                  )}
                </div>
              )}

              {/* Favorites */}
              {tab === 'favorites' && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                    <span style={{ fontSize: '0.875rem', color: 'var(--stone-500)' }}>{favorites.length} collection{favorites.length !== 1 ? 's' : ''}</span>
                    <button className="btn" onClick={() => setShowFavForm(true)}>New Collection</button>
                  </div>
                  {showFavForm && (
                    <div className="trade-card" style={{ marginBottom: '1.5rem' }}>
                      <div className="trade-field"><label>Collection Name</label><input type="text" value={favName} onChange={e => setFavName(e.target.value)} /></div>
                      <div className="trade-btn-row">
                        <button type="button" className="trade-btn-secondary" onClick={() => setShowFavForm(false)}>Cancel</button>
                        <button className="btn" onClick={createCollection}>Create</button>
                      </div>
                    </div>
                  )}
                  {favorites.map(col => (
                    <div key={col.id} className="trade-card" style={{ marginBottom: '1rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <h3>{col.collection_name}</h3>
                        <button onClick={() => deleteCollection(col.id)}
                          style={{ background: 'none', border: 'none', color: '#dc2626', fontSize: '0.8125rem', cursor: 'pointer' }}>Delete</button>
                      </div>
                      {col.items && col.items.length > 0 ? (
                        <div className="trade-fav-grid">
                          {col.items.map(item => (
                            <div key={item.id} className="trade-fav-item">
                              {item.primary_image_url ? <img src={optimizeImg(item.primary_image_url, 400)} alt={item.product_name} loading="lazy" decoding="async" /> : <div style={{ height: 140, background: 'var(--stone-100)' }}></div>}
                              <div className="name">{item.product_name}</div>
                              <button className="btn" style={{ marginTop: '0.5rem', fontSize: '0.75rem', padding: '0.35rem 0.75rem' }}
                                onClick={() => addToCart({ product_id: item.product_id, sku_id: item.sku_id, sqft_needed: 1, num_boxes: 1, unit_price: parseFloat(item.retail_price || item.price || 0), subtotal: parseFloat(item.retail_price || item.price || 0).toFixed(2) })}>Add to Cart</button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p style={{ color: 'var(--stone-400)', fontSize: '0.875rem' }}>No items in this collection yet.</p>
                      )}
                    </div>
                  ))}
                  {favorites.length === 0 && !showFavForm && (
                    <div className="trade-empty-state">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
                      <p>No collections yet. Create one to save your favorite products.</p>
                      <button className="btn" onClick={() => setShowFavForm(true)}>New Collection</button>
                    </div>
                  )}
                </div>
              )}

              {/* Account */}
              {tab === 'account' && account && (
                <div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
                    <div className="trade-card">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <h3>Company Information</h3>
                        {!editAccount && <button onClick={() => { setEditAccount(true); setAccountForm({ contact_name: account.contact_name, phone: account.phone || '', company_name: account.company_name }); }}
                          style={{ background: 'none', border: 'none', color: 'var(--gold)', fontSize: '0.8125rem', cursor: 'pointer', fontWeight: 500 }}>Edit</button>}
                      </div>
                      {editAccount ? (
                        <div>
                          <div className="trade-field"><label>Company Name</label><input value={accountForm.company_name || ''} onChange={e => setAccountForm({ ...accountForm, company_name: e.target.value })} /></div>
                          <div className="trade-field"><label>Contact Name</label><input value={accountForm.contact_name || ''} onChange={e => setAccountForm({ ...accountForm, contact_name: e.target.value })} /></div>
                          <div className="trade-field"><label>Phone</label><input value={accountForm.phone || ''} onChange={e => setAccountForm({ ...accountForm, phone: e.target.value })} /></div>
                          <div className="trade-btn-row">
                            <button type="button" className="trade-btn-secondary" onClick={() => setEditAccount(false)}>Cancel</button>
                            <button className="btn" onClick={saveAccount}>Save</button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ fontSize: '0.875rem', lineHeight: 2 }}>
                          <div><strong>{account.company_name}</strong></div>
                          <div>{account.contact_name}</div>
                          <div>{account.email}</div>
                          {account.phone && <div>{account.phone}</div>}
                        </div>
                      )}
                    </div>
                    <div className="trade-card">
                      <h3>Membership</h3>
                      <div style={{ fontSize: '0.875rem', lineHeight: 2 }}>
                        <div>Tier: <span className="trade-tier-badge">{account.tier_name || 'Silver'}</span></div>
                        <div>Status: {membership && membership.subscription_status === 'active' ? 'Active' : membership ? membership.subscription_status : 'Pending'}</div>
                        {membership && membership.subscription_expires_at && <div>Renews: {new Date(membership.subscription_expires_at).toLocaleDateString()}</div>}
                        <div>Total Spend: ${parseFloat(account.total_spend || 0).toLocaleString()}</div>
                      </div>
                      {membership && membership.subscription_status === 'active' && (
                        <button onClick={cancelMembership} style={{ marginTop: '1rem', background: 'none', border: '1px solid #dc2626', color: '#dc2626', padding: '0.5rem 1rem', fontSize: '0.8125rem', cursor: 'pointer' }}>
                          Cancel Membership
                        </button>
                      )}
                    </div>
                  </div>
                  {rep && (
                    <div className="trade-rep-card" style={{ marginTop: '1.5rem' }}>
                      <div className="trade-rep-avatar">{(rep.first_name || 'R').charAt(0)}{(rep.last_name || '').charAt(0)}</div>
                      <div>
                        <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>Your Trade Representative</div>
                        <div style={{ fontSize: '0.875rem', color: 'var(--stone-600)' }}>{rep.first_name} {rep.last_name}</div>
                        {rep.email && <div style={{ fontSize: '0.8125rem', color: 'var(--stone-500)' }}>{rep.email}</div>}
                        {rep.phone && <div style={{ fontSize: '0.8125rem', color: 'var(--stone-500)' }}>{rep.phone}</div>}
                      </div>
                    </div>
                  )}
                  <div className="trade-card" style={{ marginTop: '1.5rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <h3>Security</h3>
                      {!showPwForm && <button onClick={() => setShowPwForm(true)}
                        style={{ background: 'none', border: 'none', color: 'var(--gold)', fontSize: '0.8125rem', cursor: 'pointer', fontWeight: 500 }}>Change Password</button>}
                    </div>
                    {showPwForm && (
                      <div>
                        <div className="trade-field"><label>Current Password</label><input type="password" value={passwordForm.current} onChange={e => setPasswordForm({ ...passwordForm, current: e.target.value })} /></div>
                        <div className="trade-field"><label>New Password</label><input type="password" value={passwordForm.new_password} onChange={e => setPasswordForm({ ...passwordForm, new_password: e.target.value })} /></div>
                        <div className="trade-field"><label>Confirm Password</label><input type="password" value={passwordForm.confirm} onChange={e => setPasswordForm({ ...passwordForm, confirm: e.target.value })} /></div>
                        <div className="trade-btn-row">
                          <button type="button" className="trade-btn-secondary" onClick={() => setShowPwForm(false)}>Cancel</button>
                          <button className="btn" onClick={changePassword} disabled={!passwordForm.current || !passwordForm.new_password}>Update Password</button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      );
    }

    // ==================== Collections Page ====================

    function CollectionsPage({ onCollectionClick, goHome }) {
      const [collections, setCollections] = useState([]);
      const [loading, setLoading] = useState(true);

      useEffect(() => {
        fetch(API + '/api/collections')
          .then(r => r.json())
          .then(data => { setCollections(data.collections || []); setLoading(false); })
          .catch(() => setLoading(false));
      }, []);

      return (
        <div className="collections-page">
          <Breadcrumbs items={[
            { label: 'Home', onClick: goHome },
            { label: 'Collections' }
          ]} />
          <h1>Collections</h1>
          <p className="subtitle">Explore our curated flooring collections from premium vendors worldwide.</p>
          {loading ? (
            <div className="collections-grid">
              {[0, 1, 2].map(i => (
                <div key={i}>
                  <div className="skeleton-collection-img" />
                  <div className="skeleton-bar skeleton-bar-short" />
                  <div className="skeleton-bar skeleton-bar-medium" />
                </div>
              ))}
            </div>
          ) : collections.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--stone-600)' }}>
              <p>No collections available yet.</p>
            </div>
          ) : (
            <div className="collections-grid">
              {collections.map(c => (
                <div key={c.slug} className="collection-card" onClick={() => onCollectionClick(c.name)}>
                  <div className="collection-card-image">
                    {c.image && <img src={optimizeImg(c.image, 400)} alt={c.name} loading="lazy" decoding="async" />}
                  </div>
                  <div className="collection-card-info">
                    <div className="collection-card-name">{c.name}</div>
                    <div className="collection-card-count">{c.product_count} product{c.product_count !== 1 ? 's' : ''}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    // ==================== Floor Quiz Modal ====================

    function FloorQuizModal({ onClose, onSkuClick, onViewAll }) {
      const [step, setStep] = useState(1);
      const [room, setRoom] = useState('');
      const [style, setStyle] = useState('');
      const [durability, setDurability] = useState('');
      const [budget, setBudget] = useState('');
      const [results, setResults] = useState([]);
      const [loading, setLoading] = useState(false);
      const [filterParams, setFilterParams] = useState('');

      const rooms = [
        { id: 'kitchen', label: 'Kitchen', icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="20" height="20" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="12" y1="10" x2="12" y2="22"/><circle cx="7" cy="6" r="1.5"/><circle cx="17" cy="6" r="1.5"/></svg>
        )},
        { id: 'bathroom', label: 'Bathroom', icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 12h16a1 1 0 011 1v3a4 4 0 01-4 4H7a4 4 0 01-4-4v-3a1 1 0 011-1z"/><path d="M6 12V5a2 2 0 012-2h1"/><line x1="2" y1="20" x2="5" y2="22"/><line x1="22" y1="20" x2="19" y2="22"/></svg>
        )},
        { id: 'living-room', label: 'Living Room', icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20 9V6a2 2 0 00-2-2H6a2 2 0 00-2 2v3"/><path d="M2 11v5a2 2 0 002 2h16a2 2 0 002-2v-5a2 2 0 00-4 0H6a2 2 0 00-4 0z"/><line x1="4" y1="18" x2="4" y2="21"/><line x1="20" y1="18" x2="20" y2="21"/></svg>
        )},
        { id: 'bedroom', label: 'Bedroom', icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 12h20v7H2z"/><path d="M2 12V8a4 4 0 014-4h12a4 4 0 014 4v4"/><rect x="6" y="8" width="4" height="4" rx="1"/><rect x="14" y="8" width="4" height="4" rx="1"/><line x1="2" y1="19" x2="2" y2="22"/><line x1="22" y1="19" x2="22" y2="22"/></svg>
        )},
        { id: 'outdoor', label: 'Outdoor', icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="5" r="3"/><line x1="12" y1="8" x2="12" y2="16"/><path d="M5 22l3-8h8l3 8"/><line x1="5" y1="22" x2="19" y2="22"/></svg>
        )},
        { id: 'commercial', label: 'Commercial', icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="4" y="2" width="16" height="20" rx="1"/><line x1="9" y1="6" x2="15" y2="6"/><line x1="9" y1="10" x2="15" y2="10"/><line x1="9" y1="14" x2="15" y2="14"/><line x1="9" y1="18" x2="15" y2="18"/></svg>
        )},
      ];

      const styles = [
        { id: 'modern', label: 'Modern', desc: 'Clean lines, minimal' },
        { id: 'traditional', label: 'Traditional', desc: 'Classic, timeless' },
        { id: 'rustic', label: 'Rustic', desc: 'Warm, natural feel' },
        { id: 'coastal', label: 'Coastal', desc: 'Light, breezy' },
        { id: 'mediterranean', label: 'Mediterranean', desc: 'Earthy, textured' },
        { id: 'contemporary', label: 'Contemporary', desc: 'Bold, current' },
      ];

      const durabilities = [
        { id: 'light', label: 'Light Traffic', desc: 'Bedrooms, closets' },
        { id: 'medium', label: 'Medium Traffic', desc: 'Living rooms, dining' },
        { id: 'heavy', label: 'Heavy Traffic', desc: 'Kitchens, hallways' },
        { id: 'waterproof', label: 'Waterproof', desc: 'Baths, laundry, outdoor' },
        { id: 'commercial', label: 'Commercial', desc: 'Retail, office spaces' },
        { id: 'any', label: 'No Preference', desc: 'Show me everything' },
      ];

      const budgets = [
        { id: 'under3', label: '$', desc: 'Under $3/sqft' },
        { id: '3to6', label: '$$', desc: '$3–$6/sqft' },
        { id: '6to10', label: '$$$', desc: '$6–$10/sqft' },
        { id: 'over10', label: '$$$$', desc: '$10+/sqft' },
        { id: 'any', label: 'Any', desc: 'Show all price ranges' },
      ];

      // Map quiz answers to API filter params
      const buildFilters = () => {
        const params = new URLSearchParams();

        // Room → category
        const roomCatMap = {
          'kitchen': 'tile', 'bathroom': 'tile', 'living-room': 'hardwood',
          'bedroom': 'hardwood', 'outdoor': 'tile', 'commercial': 'luxury-vinyl'
        };
        // Style refines category choice
        const styleCatOverrides = {
          'rustic': { 'living-room': 'hardwood', 'bedroom': 'hardwood' },
          'modern': { 'living-room': 'luxury-vinyl', 'kitchen': 'luxury-vinyl' },
          'coastal': { 'living-room': 'luxury-vinyl', 'bedroom': 'laminate-flooring' },
        };

        let cat = roomCatMap[room] || '';
        if (styleCatOverrides[style] && styleCatOverrides[style][room]) {
          cat = styleCatOverrides[style][room];
        }
        // Waterproof → prefer LVP or tile
        if (durability === 'waterproof' && cat === 'hardwood') cat = 'luxury-vinyl';

        if (cat) params.set('category', cat);
        params.set('limit', '8');
        params.set('sort', 'newest');
        return params.toString();
      };

      const fetchResults = async () => {
        setLoading(true);
        const qs = buildFilters();
        setFilterParams(qs);
        try {
          const res = await fetch(API + '/api/storefront/skus?' + qs);
          const data = await res.json();
          setResults(data.skus || []);
        } catch (e) {
          setResults([]);
        }
        setLoading(false);
      };

      const handleNext = () => {
        if (step < 4) {
          setStep(step + 1);
        } else {
          setStep(5);
          fetchResults();
        }
      };

      const canNext = () => {
        if (step === 1) return !!room;
        if (step === 2) return !!style;
        if (step === 3) return !!durability;
        if (step === 4) return !!budget;
        return false;
      };

      const stepLabels = ['Room', 'Style', 'Durability', 'Budget', 'Results'];

      return (
        <div className="quiz-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
          <div className="quiz-modal">
            <button className="quiz-close" onClick={onClose}>&times;</button>

            <div className="quiz-progress">
              {[1,2,3,4,5].map(s => (
                <div key={s} className={'quiz-progress-step' + (s === step ? ' active' : '') + (s < step ? ' done' : '')} />
              ))}
            </div>

            {step <= 4 && (
              <p className="quiz-step-label">Step {step} of 4 &mdash; {stepLabels[step - 1]}</p>
            )}

            {step === 1 && (
              <>
                <h2>What room is this for?</h2>
                <p className="subtitle">We'll recommend the best flooring for your space</p>
                <div className="quiz-options">
                  {rooms.map(r => (
                    <div key={r.id} className={'quiz-option' + (room === r.id ? ' selected' : '')} onClick={() => setRoom(r.id)}>
                      <span className="quiz-option-icon">{r.icon}</span>
                      <span className="quiz-option-label">{r.label}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <h2>What's your style?</h2>
                <p className="subtitle">Choose the look that speaks to you</p>
                <div className="quiz-options">
                  {styles.map(s => (
                    <div key={s.id} className={'quiz-option' + (style === s.id ? ' selected' : '')} onClick={() => setStyle(s.id)}>
                      <span className="quiz-option-label">{s.label}</span>
                      <span className="quiz-option-desc">{s.desc}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <h2>How much traffic?</h2>
                <p className="subtitle">Helps us pick the right durability rating</p>
                <div className="quiz-options">
                  {durabilities.map(d => (
                    <div key={d.id} className={'quiz-option' + (durability === d.id ? ' selected' : '')} onClick={() => setDurability(d.id)}>
                      <span className="quiz-option-label">{d.label}</span>
                      <span className="quiz-option-desc">{d.desc}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {step === 4 && (
              <>
                <h2>What's your budget?</h2>
                <p className="subtitle">Per square foot pricing</p>
                <div className="quiz-options" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
                  {budgets.map(b => (
                    <div key={b.id} className={'quiz-option' + (budget === b.id ? ' selected' : '')} onClick={() => setBudget(b.id)}>
                      <span className="quiz-option-label">{b.label}</span>
                      <span className="quiz-option-desc">{b.desc}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {step === 5 && (
              <>
                <div className="quiz-results-header">
                  <h2>Your Recommendations</h2>
                  <p className="subtitle">Based on your preferences, we think you'll love these</p>
                  <div className="quiz-results-tags">
                    {room && <span className="quiz-results-tag">{rooms.find(r => r.id === room)?.label}</span>}
                    {style && <span className="quiz-results-tag">{styles.find(s => s.id === style)?.label}</span>}
                    {durability && durability !== 'any' && <span className="quiz-results-tag">{durabilities.find(d => d.id === durability)?.label}</span>}
                    {budget && budget !== 'any' && <span className="quiz-results-tag">{budgets.find(b => b.id === budget)?.desc}</span>}
                  </div>
                </div>
                {loading ? (
                  <SkeletonGrid count={4} />
                ) : results.length > 0 ? (
                  <>
                    <div className="quiz-results-grid">
                      {results.slice(0, 8).map(sku => (
                        <div key={sku.sku_id} className="quiz-result-card" onClick={() => { onClose(); onSkuClick(sku.sku_id, sku.product_name); }}>
                          {sku.primary_image && <img src={optimizeImg(sku.primary_image, 400)} alt={sku.product_name} loading="lazy" decoding="async" />}
                          <div className="quiz-result-card-info">
                            <div className="quiz-result-card-name">{sku.product_name}</div>
                            <div className="quiz-result-card-price">{sku.retail_price ? '$' + displayPrice(sku, sku.retail_price).toFixed(2) + priceSuffix(sku) : ''}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <button className="quiz-view-all" onClick={() => { onClose(); onViewAll(filterParams); }}>View All Results &rarr;</button>
                  </>
                ) : (
                  <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--stone-500)' }}>
                    <p>No exact matches found. Try browsing our full collection.</p>
                    <button className="quiz-view-all" style={{ marginTop: '1rem' }} onClick={() => { onClose(); onViewAll(''); }}>Browse All Floors</button>
                  </div>
                )}
              </>
            )}

            {step <= 4 && (
              <div className="quiz-nav">
                {step > 1 ? (
                  <button className="quiz-nav-back" onClick={() => setStep(step - 1)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
                    Back
                  </button>
                ) : <span />}
                <button className="quiz-nav-next" disabled={!canNext()} onClick={handleNext}>
                  {step === 4 ? 'See Results' : 'Next'}
                </button>
              </div>
            )}

            {step === 5 && !loading && (
              <div className="quiz-nav" style={{ marginTop: '1rem' }}>
                <button className="quiz-nav-back" onClick={() => { setStep(1); setRoom(''); setStyle(''); setDurability(''); setBudget(''); setResults([]); }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
                  Start Over
                </button>
                <span />
              </div>
            )}
          </div>
        </div>
      );
    }

    // ==================== Trade Modal ====================

    function TradeModal({ onClose, onLogin, initialMode }) {
      const [mode, setMode] = useState(initialMode || 'login');
      const [email, setEmail] = useState('');
      const [password, setPassword] = useState('');
      const [companyName, setCompanyName] = useState('');
      const [contactName, setContactName] = useState('');
      const [phone, setPhone] = useState('');
      const [businessType, setBusinessType] = useState('');
      const [addressLine1, setAddressLine1] = useState('');
      const [city, setCity] = useState('');
      const [addrState, setAddrState] = useState('');
      const [zip, setZip] = useState('');
      const [contractorLicense, setContractorLicense] = useState('');
      const [confirmPassword, setConfirmPassword] = useState('');
      const [error, setError] = useState('');
      const [success, setSuccess] = useState('');
      const [loading, setLoading] = useState(false);
      const [step, setStep] = useState(1);
      const [docs, setDocs] = useState({ ein: null, resale_cert: null, business_card: null });
      const [docUploads, setDocUploads] = useState({});
      const [uploading, setUploading] = useState('');
      const [setupIntentSecret, setSetupIntentSecret] = useState(null);
      const cardRef = useRef(null);
      const cardMounted = useRef(false);

      const handleLogin = async (e) => {
        e.preventDefault();
        setError(''); setSuccess(''); setLoading(true);
        try {
          const resp = await fetch(API + '/api/trade/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
          });
          const data = await resp.json();
          if (!resp.ok) { setError(data.error); setLoading(false); return; }
          onLogin(data.token, data.customer);
        } catch (err) {
          setError('Network error. Please try again.');
        }
        setLoading(false);
      };

      const formatPhone = (val) => {
        const digits = val.replace(/\D/g, '').slice(0, 10);
        if (digits.length === 0) return '';
        if (digits.length <= 3) return '(' + digits;
        if (digits.length <= 6) return '(' + digits.slice(0, 3) + ') ' + digits.slice(3);
        return '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
      };

      const handlePhoneChange = (e) => { setPhone(formatPhone(e.target.value)); };

      const passwordValid = password.length >= 8 && /[A-Z]/.test(password) && /[0-9]/.test(password);
      const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      const [emailTouched, setEmailTouched] = useState(false);

      const goStep2 = () => {
        if (!companyName || !contactName || !email || !password || !businessType || !phone || !addressLine1 || !city || !addrState || !zip) {
          setError('Please fill in all required fields.'); return;
        }
        if (!emailValid) { setError('Please enter a valid email address.'); return; }
        if (phone.replace(/\D/g, '').length < 10) { setError('Please enter a valid 10-digit phone number.'); return; }
        if (!passwordValid) { setError('Password must be at least 8 characters with one uppercase letter and one number.'); return; }
        if (password !== confirmPassword) { setError('Passwords do not match.'); return; }
        setError(''); setStep(2);
      };

      const handleDocUpload = async (docType, file) => {
        if (!file) return;
        setUploading(docType); setError('');
        try {
          const formData = new FormData();
          formData.append('document', file);
          formData.append('doc_type', docType);
          formData.append('email', email);
          const resp = await fetch(API + '/api/trade/register/upload', { method: 'POST', body: formData });
          const data = await resp.json();
          if (!resp.ok) { setError(data.error || 'Upload failed'); setUploading(''); return; }
          setDocUploads(prev => ({ ...prev, [docType]: { id: data.document_id, file_name: file.name } }));
        } catch (err) {
          setError('Upload failed. Please try again.');
        }
        setUploading('');
      };

      const goStep3 = async () => {
        if (!docUploads.ein || !docUploads.resale_cert || !docUploads.business_card) {
          setError('EIN certificate, Resale Certificate, and Business Card are required.'); return;
        }
        setError(''); setLoading(true);
        try {
          const resp = await fetch(API + '/api/trade/register/setup-intent', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
          });
          const data = await resp.json();
          if (!resp.ok) { setError(data.error); setLoading(false); return; }
          setSetupIntentSecret(data.client_secret);
          setStep(3);
        } catch (err) {
          setError('Network error. Please try again.');
        }
        setLoading(false);
      };

      useEffect(() => {
        if (step === 3 && !cardMounted.current && setupIntentSecret && stripeInstance) {
          setTimeout(() => {
            const el = document.getElementById('trade-card-element');
            if (!el) return;
            const elements = stripeInstance.elements();
            const card = elements.create('card', {
              style: { base: { fontFamily: "'Inter', sans-serif", fontSize: '15px', color: '#292524', '::placeholder': { color: '#57534e' } } }
            });
            card.mount('#trade-card-element');
            cardRef.current = card;
            cardMounted.current = true;
          }, 100);
        }
        return () => {
          if (cardMounted.current && cardRef.current) {
            cardRef.current.unmount();
            cardMounted.current = false;
          }
        };
      }, [step, setupIntentSecret]);

      const handleFullRegister = async () => {
        setError(''); setLoading(true);
        try {
          const { error: stripeError, setupIntent } = await stripeInstance.confirmCardSetup(setupIntentSecret, {
            payment_method: { card: cardRef.current, billing_details: { name: contactName, email } }
          });
          if (stripeError) { setError(stripeError.message); setLoading(false); return; }
          const docIds = Object.values(docUploads).map(d => d.id);
          const resp = await fetch(API + '/api/trade/register/enhanced', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email, password, company_name: companyName, contact_name: contactName, phone,
              business_type: businessType, address_line1: addressLine1, city, state: addrState, zip,
              contractor_license: contractorLicense || null, document_ids: docIds,
              stripe_setup_intent_id: setupIntent.id
            })
          });
          const data = await resp.json();
          if (!resp.ok) { setError(data.error); setLoading(false); return; }
          setStep(4);
          setSuccess(data.message || 'Application submitted! We will review your application and email you once approved.');
        } catch (err) {
          setError('Registration failed. Please try again.');
        }
        setLoading(false);
      };

      const stepLabels = ['Company', 'Documents', 'Payment', 'Done'];
      const docLabel = (type) => ({ ein: 'EIN Certificate *', resale_cert: 'Resale Certificate *', business_card: 'Business Card *' }[type] || type);

      return (
        <div className="trade-modal-overlay" onClick={onClose}>
          <div className="trade-modal" onClick={e => e.stopPropagation()} style={mode === 'register' ? { maxWidth: '480px' } : {}}>
            <button className="trade-modal-close" onClick={onClose}>&times;</button>
            <h2 style={{ fontFamily: 'var(--font-heading)', marginBottom: '1.5rem' }}>
              {mode === 'login' ? 'Trade Login' : step === 4 ? 'Application Submitted' : 'Trade Registration'}
            </h2>

            {error && <div className="trade-msg trade-msg-error">{error}</div>}
            {success && <div className="trade-msg trade-msg-success">{success}</div>}

            {mode === 'login' ? (
              <form onSubmit={handleLogin}>
                <div className="trade-field"><label>Email</label><input type="email" value={email} onChange={e => setEmail(e.target.value)} required /></div>
                <div className="trade-field"><label>Password</label><input type="password" value={password} onChange={e => setPassword(e.target.value)} required /></div>
                <button className="btn" type="submit" disabled={loading} style={{ width: '100%', marginTop: '0.5rem' }}>
                  {loading ? 'Signing in...' : 'Sign In'}
                </button>
                <div className="trade-toggle">
                  Don't have an account? <a onClick={() => { setMode('register'); setError(''); setSuccess(''); }}>Apply for Trade</a>
                </div>
              </form>
            ) : step === 4 ? (
              <div style={{ textAlign: 'center', padding: '1rem 0' }}>
                <p style={{ color: 'var(--stone-600)', lineHeight: 1.6, marginBottom: '1.5rem' }}>
                  Your application is under review. You'll receive an email once approved.
                </p>
                <button className="btn" onClick={onClose} style={{ width: '100%' }}>Close</button>
              </div>
            ) : (
              <>
                <div className="trade-steps-indicator">
                  {stepLabels.slice(0, 3).map((s, i) => (
                    <div key={s} className={'trade-step-dot' + (step === i + 1 ? ' active' : step > i + 1 ? ' done' : '')}>{s}</div>
                  ))}
                </div>

                {step === 1 && (
                  <div>
                    <div className="trade-field"><label>Company Name *</label><input type="text" value={companyName} onChange={e => setCompanyName(e.target.value)} autoComplete="organization" /></div>
                    <div className="trade-field"><label>Contact Name *</label><input type="text" value={contactName} onChange={e => setContactName(e.target.value)} autoComplete="name" /></div>
                    <div className="trade-field">
                      <label>Business Type *</label>
                      <select value={businessType} onChange={e => setBusinessType(e.target.value)}>
                        <option value="">Select...</option>
                        <option value="contractor">General Contractor</option>
                        <option value="interior_designer">Interior Designer</option>
                        <option value="architect">Architect</option>
                        <option value="builder">Builder / Developer</option>
                        <option value="retailer">Flooring Retailer</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                      <div className="trade-field">
                        <label>Email *</label>
                        <input type="email" value={email} onChange={e => setEmail(e.target.value)} onBlur={() => setEmailTouched(true)} autoComplete="email" style={emailTouched && email && !emailValid ? { borderColor: '#dc2626' } : {}} />
                        {emailTouched && email && !emailValid && <div style={{ fontSize: '0.7rem', marginTop: '0.35rem', color: '#dc2626' }}>Please enter a valid email</div>}
                      </div>
                      <div className="trade-field"><label>Phone *</label><input type="tel" value={phone} onChange={handlePhoneChange} autoComplete="tel" placeholder="(555) 123-4567" /></div>
                    </div>
                    <div className="trade-field"><label>Address *</label><input type="text" value={addressLine1} onChange={e => setAddressLine1(e.target.value)} autoComplete="address-line1" placeholder="Street address" /></div>
                    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '0.75rem' }}>
                      <div className="trade-field"><label>City *</label><input type="text" value={city} onChange={e => setCity(e.target.value)} autoComplete="address-level2" /></div>
                      <div className="trade-field"><label>State *</label><input type="text" value={addrState} onChange={e => setAddrState(e.target.value)} maxLength="2" placeholder="CA" style={{ textTransform: 'uppercase' }} autoComplete="address-level1" /></div>
                      <div className="trade-field"><label>Zip *</label><input type="text" value={zip} onChange={e => setZip(e.target.value)} maxLength="10" placeholder="90210" autoComplete="postal-code" /></div>
                    </div>
                    <div className="trade-field">
                      <label>Password *</label>
                      <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
                      <div style={{ fontSize: '0.7rem', marginTop: '0.35rem', color: password ? (passwordValid ? '#16a34a' : 'var(--stone-400)') : 'var(--stone-400)' }}>
                        Min 8 characters, one uppercase, one number
                      </div>
                    </div>
                    <div className="trade-field">
                      <label>Confirm Password *</label>
                      <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} autoComplete="new-password" />
                      {confirmPassword && confirmPassword !== password && <div style={{ fontSize: '0.7rem', marginTop: '0.35rem', color: '#dc2626' }}>Passwords do not match</div>}
                    </div>
                    <button className="btn" onClick={goStep2} style={{ width: '100%', marginTop: '0.5rem' }}>Continue</button>
                    <div className="trade-toggle">
                      Already have an account? <a onClick={() => { setMode('login'); setError(''); setSuccess(''); setStep(1); }}>Sign In</a>
                    </div>
                  </div>
                )}

                {step === 2 && (
                  <div>
                    <p style={{ fontSize: '0.8125rem', color: 'var(--stone-500)', marginBottom: '1rem', lineHeight: 1.5 }}>
                      Upload your business documents for verification. EIN, Resale Certificate, and Business Card are required.
                    </p>
                    {['ein', 'resale_cert', 'business_card'].map(docType => (
                      <div key={docType}>
                        <label style={{ display: 'block', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--stone-500)', marginBottom: '0.35rem' }}>
                          {docLabel(docType)}
                        </label>
                        <div className={'trade-doc-upload' + (docUploads[docType] ? ' uploaded' : '')}
                          onClick={() => { const inp = document.getElementById('doc-' + docType); if (inp) inp.click(); }}>
                          {uploading === docType ? 'Uploading...' : docUploads[docType] ? docUploads[docType].file_name : 'Click to upload'}
                          <input type="file" id={'doc-' + docType} accept=".pdf,.jpg,.jpeg,.png" style={{ display: 'none' }}
                            onChange={e => handleDocUpload(docType, e.target.files[0])} />
                        </div>
                      </div>
                    ))}
                    <div className="trade-field" style={{ marginTop: '0.5rem' }}>
                      <label>Contractor License # (optional)</label>
                      <input type="text" value={contractorLicense} onChange={e => setContractorLicense(e.target.value)} placeholder="e.g. 830966" />
                    </div>
                    <div className="trade-btn-row">
                      <button type="button" className="trade-btn-secondary" onClick={() => setStep(1)}>Back</button>
                      <button className="btn" onClick={goStep3} disabled={loading}>{loading ? 'Setting up...' : 'Continue'}</button>
                    </div>
                  </div>
                )}

                {step === 3 && (
                  <div>
                    <p style={{ fontSize: '0.8125rem', color: 'var(--stone-500)', marginBottom: '1rem', lineHeight: 1.5 }}>
                      Add a payment method for your $99/year trade membership. You won't be charged until approved.
                    </p>
                    <div style={{ border: '1px solid var(--stone-300)', padding: '1rem', marginBottom: '1rem' }}>
                      <div id="trade-card-element"></div>
                    </div>
                    <div className="trade-btn-row">
                      <button type="button" className="trade-btn-secondary" onClick={() => setStep(2)}>Back</button>
                      <button className="btn" onClick={handleFullRegister} disabled={loading}>{loading ? 'Submitting...' : 'Submit Application'}</button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      );
    }

    // ==================== Customer Auth Modal ====================

    function CustomerAuthModal({ onClose, onLogin, initialMode }) {
      const [mode, setMode] = useState(initialMode || 'login');
      const [email, setEmail] = useState('');
      const [password, setPassword] = useState('');
      const [firstName, setFirstName] = useState('');
      const [lastName, setLastName] = useState('');
      const [error, setError] = useState('');
      const [success, setSuccess] = useState('');
      const [loading, setLoading] = useState(false);

      const handleLogin = async (e) => {
        e.preventDefault();
        setError(''); setLoading(true);
        try {
          const res = await fetch(API + '/api/customer/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
          });
          const data = await res.json();
          if (data.error) { setError(data.error); setLoading(false); return; }
          onLogin(data.token, data.customer);
        } catch { setError('Login failed'); setLoading(false); }
      };

      const handleRegister = async (e) => {
        e.preventDefault();
        setError(''); setLoading(true);
        try {
          const res = await fetch(API + '/api/customer/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, first_name: firstName, last_name: lastName })
          });
          const data = await res.json();
          if (data.error) { setError(data.error); setLoading(false); return; }
          onLogin(data.token, data.customer);
        } catch { setError('Registration failed'); setLoading(false); }
      };

      const handleForgotPassword = async (e) => {
        e.preventDefault();
        setError(''); setSuccess(''); setLoading(true);
        try {
          const res = await fetch(API + '/api/customer/forgot-password', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
          });
          const data = await res.json();
          if (data.error) { setError(data.error); setLoading(false); return; }
          setSuccess('If an account exists with that email, a reset link has been sent.');
          setLoading(false);
        } catch { setError('Unable to send reset email. Please try again.'); setLoading(false); }
      };

      const switchMode = (newMode) => { setMode(newMode); setError(''); setSuccess(''); };

      return (
        <div className="modal-overlay" onClick={onClose}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={onClose}>&times;</button>
            <h2>{mode === 'login' ? 'Sign In' : mode === 'register' ? 'Create Account' : 'Reset Password'}</h2>

            {mode === 'forgot' ? (
              <>
                <p style={{ fontSize: '0.875rem', color: 'var(--stone-600)', marginBottom: '1.5rem' }}>
                  Enter your email and we'll send you a link to reset your password.
                </p>
                <form onSubmit={handleForgotPassword}>
                  {error && <div className="checkout-error">{error}</div>}
                  {success && <div style={{ padding: '0.75rem 1rem', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 4, fontSize: '0.875rem', color: '#166534', marginBottom: '1rem' }}>{success}</div>}
                  <div className="checkout-field"><label>Email</label><input className="checkout-input" type="email" value={email} onChange={e => setEmail(e.target.value)} required /></div>
                  <button type="submit" className="btn" style={{ width: '100%' }} disabled={loading || !!success}>
                    {loading ? '...' : 'Send Reset Link'}
                  </button>
                </form>
                <div style={{ textAlign: 'center', marginTop: '1.5rem', fontSize: '0.875rem' }}>
                  <a onClick={() => switchMode('login')} style={{ color: 'var(--gold)', cursor: 'pointer' }}>Back to Sign In</a>
                </div>
              </>
            ) : (
              <>
                <form onSubmit={mode === 'login' ? handleLogin : handleRegister}>
                  {error && <div className="checkout-error">{error}</div>}
                  {mode === 'register' && (
                    <div className="checkout-row">
                      <div className="checkout-field"><label>First Name</label><input className="checkout-input" value={firstName} onChange={e => setFirstName(e.target.value)} /></div>
                      <div className="checkout-field"><label>Last Name</label><input className="checkout-input" value={lastName} onChange={e => setLastName(e.target.value)} /></div>
                    </div>
                  )}
                  <div className="checkout-field"><label>Email</label><input className="checkout-input" type="email" value={email} onChange={e => setEmail(e.target.value)} /></div>
                  <div className="checkout-field"><label>Password</label><input className="checkout-input" type="password" value={password} onChange={e => setPassword(e.target.value)} /></div>
                  {mode === 'login' && (
                    <div style={{ textAlign: 'right', marginBottom: '1rem' }}>
                      <a onClick={() => switchMode('forgot')} style={{ fontSize: '0.8125rem', color: 'var(--gold)', cursor: 'pointer' }}>Forgot password?</a>
                    </div>
                  )}
                  <button type="submit" className="btn" style={{ width: '100%' }} disabled={loading}>
                    {loading ? '...' : (mode === 'login' ? 'Sign In' : 'Create Account')}
                  </button>
                </form>
                <div style={{ textAlign: 'center', marginTop: '1.5rem', fontSize: '0.875rem' }}>
                  {mode === 'login' ? (
                    <span>No account? <a onClick={() => switchMode('register')} style={{ color: 'var(--gold)', cursor: 'pointer' }}>Create one</a></span>
                  ) : (
                    <span>Have an account? <a onClick={() => switchMode('login')} style={{ color: 'var(--gold)', cursor: 'pointer' }}>Sign in</a></span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      );
    }

    // ==================== Installation Modal ====================

    function InstallationModal({ onClose, product }) {
      const [name, setName] = useState('');
      const [email, setEmail] = useState('');
      const [phone, setPhone] = useState('');
      const [zipCode, setZipCode] = useState('');
      const [sqft, setSqft] = useState('');
      const [message, setMessage] = useState('');
      const [submitted, setSubmitted] = useState(false);
      const [error, setError] = useState('');

      const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        try {
          const body = { customer_name: name, customer_email: email, phone, zip_code: zipCode, estimated_sqft: sqft || null, message };
          if (product) { body.product_id = product.product_id; body.sku_id = product.sku_id; body.product_name = product.product_name; body.collection = product.collection; }
          const res = await fetch(API + '/api/installation-inquiries', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
          });
          const data = await res.json();
          if (data.error) { setError(data.error); return; }
          setSubmitted(true);
        } catch { setError('Unable to submit. Please try again.'); }
      };

      return (
        <div className="modal-overlay" onClick={onClose}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={onClose}>&times;</button>
            {submitted ? (
              <div style={{ textAlign: 'center', padding: '2rem 0' }}>
                <div style={{ width: 60, height: 60, borderRadius: '50%', background: '#d1fae5', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem' }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2" style={{ width: 30, height: 30 }}><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <h2 style={{ marginBottom: '0.5rem' }}>Thank You!</h2>
                <p style={{ color: 'var(--stone-600)', fontSize: '0.95rem' }}>We'll be in touch within 1 business day.</p>
              </div>
            ) : (
              <>
                <h2>Request Installation Quote</h2>
                {product && <p style={{ color: 'var(--stone-600)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>For: {fullProductName(product)}</p>}
                <form onSubmit={handleSubmit}>
                  {error && <div className="checkout-error">{error}</div>}
                  <div className="checkout-field"><label>Name *</label><input className="checkout-input" value={name} onChange={e => setName(e.target.value)} required /></div>
                  <div className="checkout-row">
                    <div className="checkout-field"><label>Email *</label><input className="checkout-input" type="email" value={email} onChange={e => setEmail(e.target.value)} required /></div>
                    <div className="checkout-field"><label>Phone</label><input className="checkout-input" type="tel" value={phone} onChange={e => setPhone(e.target.value)} /></div>
                  </div>
                  <div className="checkout-row">
                    <div className="checkout-field"><label>ZIP Code</label><input className="checkout-input" value={zipCode} onChange={e => setZipCode(e.target.value)} maxLength={5} /></div>
                    <div className="checkout-field"><label>Est. Square Feet</label><input className="checkout-input" type="number" value={sqft} onChange={e => setSqft(e.target.value)} /></div>
                  </div>
                  <div className="checkout-field"><label>Message</label><textarea className="checkout-input" value={message} onChange={e => setMessage(e.target.value)} rows={3} style={{ resize: 'vertical' }} /></div>
                  <button type="submit" className="btn" style={{ width: '100%' }}>Submit Inquiry</button>
                </form>
              </>
            )}
          </div>
        </div>
      );
    }

    // ==================== Installation Landing Page ====================

    function InstallationPage({ onRequestQuote }) {
      return (
        <div className="installation-page">
          <div className="install-hero">
            <h1>Professional Installation</h1>
            <p>Licensed and insured installers with decades of combined experience. From hardwood to tile, we ensure a flawless finish on every project.</p>
            <button className="btn btn-gold" onClick={onRequestQuote}>Request a Free Quote</button>
          </div>

          <div className="install-types">
            <h2>What We Install</h2>
            <div className="install-types-grid">
              <div className="install-type-card">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                <h3>Hardwood</h3>
                <p>Solid and engineered hardwood installation with precision nailing, glue-down, or floating methods.</p>
              </div>
              <div className="install-type-card">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="12" y1="3" x2="12" y2="21"/></svg>
                <h3>Tile &amp; Porcelain</h3>
                <p>Floor and wall tile installation including mortar-set, large-format, and mosaic applications.</p>
              </div>
              <div className="install-type-card">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 20h20"/><path d="M4 20V8l4-4h8l4 4v12"/><path d="M2 20l4-4"/><path d="M22 20l-4-4"/></svg>
                <h3>Luxury Vinyl</h3>
                <p>Click-lock LVP and glue-down LVT for waterproof, durable performance in any room.</p>
              </div>
              <div className="install-type-card">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                <h3>Natural Stone</h3>
                <p>Marble, travertine, slate, and quartzite installed with expert care for lasting beauty.</p>
              </div>
              <div className="install-type-card">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 20c0-4 4-4 4-8s-4-4-4-8"/><path d="M12 20c0-4 4-4 4-8s-4-4-4-8"/><path d="M20 20c0-4 4-4 4-8s-4-4-4-8"/></svg>
                <h3>Carpet</h3>
                <p>Stretch-in and direct-glue carpet installation for bedrooms, living spaces, and commercial areas.</p>
              </div>
              <div className="install-type-card">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="6" width="20" height="12" rx="1"/><line x1="6" y1="6" x2="6" y2="18"/><line x1="10" y1="6" x2="10" y2="18"/><line x1="14" y1="6" x2="14" y2="18"/><line x1="18" y1="6" x2="18" y2="18"/></svg>
                <h3>Laminate</h3>
                <p>Quick and affordable floating-floor laminate installation with seamless transitions.</p>
              </div>
            </div>
          </div>

          <div className="install-steps-section">
            <h2>How It Works</h2>
            <div className="install-steps">
              <div className="install-step">
                <div className="step-number">1</div>
                <h3>Request a Quote</h3>
                <p>Tell us about your project — flooring type, square footage, and timeline.</p>
              </div>
              <div className="install-step">
                <div className="step-number">2</div>
                <h3>Site Visit &amp; Measure</h3>
                <p>Our team visits your space for precise measurements and subfloor assessment.</p>
              </div>
              <div className="install-step">
                <div className="step-number">3</div>
                <h3>Schedule Installation</h3>
                <p>Pick a date that works for you. We handle materials, prep, and cleanup.</p>
              </div>
              <div className="install-step">
                <div className="step-number">4</div>
                <h3>Enjoy Your New Floors</h3>
                <p>Walk-through inspection, care instructions, and warranty documentation provided.</p>
              </div>
            </div>
          </div>

          <div className="install-benefits">
            <h2>Why Choose Us</h2>
            <div className="install-benefits-grid">
              <div className="benefit-card">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                <h3>Licensed &amp; Insured</h3>
                <p>California Contractor License #830966. Fully bonded and insured for your protection.</p>
              </div>
              <div className="benefit-card">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg>
                <h3>Manufacturer Certified</h3>
                <p>Factory-trained installers certified by leading flooring manufacturers.</p>
              </div>
              <div className="benefit-card">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="20 6 9 17 4 12"/></svg>
                <h3>Warranty Included</h3>
                <p>Every installation backed by our workmanship warranty for your peace of mind.</p>
              </div>
              <div className="benefit-card">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
                <h3>Free Estimates</h3>
                <p>No-obligation quotes with transparent pricing. No hidden fees, ever.</p>
              </div>
            </div>
          </div>

          <div className="install-area">
            <h2>Service Area</h2>
            <p>We proudly serve Orange County and surrounding areas, including:</p>
            <p className="install-area-cities">
              Anaheim &middot; Fullerton &middot; Irvine &middot; Orange &middot; Tustin &middot; Santa Ana &middot; Yorba Linda &middot; Placentia &middot; Brea &middot; Buena Park &middot; Huntington Beach &middot; Costa Mesa &middot; Newport Beach &middot; Mission Viejo &middot; Lake Forest &middot; Laguna Hills
            </p>
          </div>

          <div className="install-cta-band">
            <h2>Ready to Get Started?</h2>
            <p>Request a free, no-obligation quote and let our experts transform your space.</p>
            <button className="btn btn-gold" onClick={onRequestQuote}>Request a Free Quote</button>
          </div>
        </div>
      );
    }

    // ==================== Sale Page ====================

    function SalePage({ onSkuClick, wishlist, toggleWishlist, setQuickViewSku, navigate }) {
      const [skus, setSkus] = useState([]);
      const [loading, setLoading] = useState(true);
      const [total, setTotal] = useState(0);
      const [page, setPage] = useState(1);
      const [sortBy, setSortBy] = useState('discount');
      const [stats, setStats] = useState({ count: 0, max_discount: 0 });
      const limit = 24;

      useEffect(() => {
        fetch('/api/storefront/sale/stats')
          .then(r => r.json())
          .then(data => setStats(data))
          .catch(() => {});
      }, []);

      useEffect(() => {
        setLoading(true);
        const offset = (page - 1) * limit;
        fetch(`/api/storefront/skus?sale=true&sort=${sortBy}&limit=${limit}&offset=${offset}`)
          .then(r => r.json())
          .then(data => {
            setSkus(data.skus || []);
            setTotal(data.total || 0);
            setLoading(false);
          })
          .catch(() => setLoading(false));
      }, [page, sortBy]);

      const totalPages = Math.ceil(total / limit);

      return (
        <div>
          <div className="sale-hero">
            <div className="sale-hero-badge">LIMITED TIME</div>
            <h1>Sale</h1>
            <p>Exceptional flooring at extraordinary prices. Shop our curated selection of premium materials at reduced prices.</p>
            {stats.count > 0 && (
              <div className="sale-hero-stats">
                <div className="sale-hero-stat">
                  <div className="stat-value">{stats.count}</div>
                  <div className="stat-label">Products on Sale</div>
                </div>
                <div className="sale-hero-stat">
                  <div className="stat-value">Up to {stats.max_discount}%</div>
                  <div className="stat-label">Savings</div>
                </div>
              </div>
            )}
          </div>

          <div className="sale-grid-section">
            {loading ? (
              <SkeletonGrid count={8} />
            ) : skus.length === 0 ? (
              <div className="sale-empty">
                <h2>No sale items right now</h2>
                <p>Check back soon — we regularly add new deals on premium flooring.</p>
                <button className="btn" onClick={() => navigate('/shop')}>Browse All Products</button>
              </div>
            ) : (
              <>
                <div className="sale-toolbar">
                  <span className="result-count">{total} product{total !== 1 ? 's' : ''} on sale</span>
                  <select value={sortBy} onChange={(e) => { setSortBy(e.target.value); setPage(1); }}>
                    <option value="discount">Biggest Savings</option>
                    <option value="price_asc">Price: Low to High</option>
                    <option value="price_desc">Price: High to Low</option>
                    <option value="newest">Newest</option>
                    <option value="name_asc">Name: A–Z</option>
                  </select>
                </div>
                <SkuGrid skus={skus} onSkuClick={onSkuClick} wishlist={wishlist} toggleWishlist={toggleWishlist} setQuickViewSku={setQuickViewSku} />
                {totalPages > 1 && (
                  <Pagination currentPage={page} totalPages={totalPages} onPageChange={(p) => { setPage(p); window.scrollTo(0, 400); }} />
                )}
              </>
            )}
          </div>

          <div className="sale-cta-band">
            <h2>Need Help Choosing?</h2>
            <p>Our flooring experts are here to help you find the perfect material for your project.</p>
            <button className="btn btn-outline-light" onClick={() => navigate('/installation')}>Get a Free Consultation</button>
          </div>
        </div>
      );
    }

    // ==================== Inspiration Page ====================

    function InspirationPage({ navigate, goBrowse }) {
      const rooms = [
        { name: 'Kitchen', slug: 'kitchen', desc: 'Durable, beautiful floors for the heart of your home.', gradient: 'linear-gradient(135deg, #c9a668 0%, #a8967a 50%, #78716c 100%)', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="21"/></svg> },
        { name: 'Living Room', slug: 'living-room', desc: 'Warm, inviting surfaces for everyday living.', gradient: 'linear-gradient(135deg, #8a9a7b 0%, #a8967a 50%, #78716c 100%)', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20 9V6a2 2 0 00-2-2H6a2 2 0 00-2 2v3"/><path d="M2 11v6a2 2 0 002 2h16a2 2 0 002-2v-6a2 2 0 00-4 0H6a2 2 0 00-4 0z"/><path d="M4 19v2"/><path d="M20 19v2"/></svg> },
        { name: 'Bathroom', slug: 'bathroom', desc: 'Waterproof elegance for wet spaces.', gradient: 'linear-gradient(135deg, #94a3b8 0%, #a8a29e 50%, #78716c 100%)', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 12h16a1 1 0 011 1v3a4 4 0 01-4 4H7a4 4 0 01-4-4v-3a1 1 0 011-1z"/><path d="M6 12V5a2 2 0 012-2h1"/><circle cx="12" cy="7" r="1"/></svg> },
        { name: 'Bedroom', slug: 'bedroom', desc: 'Soft, quiet comfort underfoot.', gradient: 'linear-gradient(135deg, #c4a882 0%, #b8a898 50%, #a8a29e 100%)', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 16V6a2 2 0 012-2h16a2 2 0 012 2v10"/><path d="M2 12h20"/><path d="M2 16h20v2H2z"/><path d="M6 12V8h12v4"/></svg> },
        { name: 'Dining Room', slug: 'dining-room', desc: 'Refined surfaces for memorable gatherings.', gradient: 'linear-gradient(135deg, #b8942e 0%, #c9a668 50%, #a8967a 100%)', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2v8"/><path d="M8 6c0-1.5 1.8-4 4-4s4 2.5 4 4-1.8 4-4 4-4-2.5-4-4z"/><path d="M12 10v12"/><path d="M8 22h8"/></svg> },
        { name: 'Entryway', slug: 'entryway', desc: 'Make a lasting first impression.', gradient: 'linear-gradient(135deg, #a8967a 0%, #d6d3d1 50%, #a8a29e 100%)', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 21h18"/><path d="M5 21V5a2 2 0 012-2h10a2 2 0 012 2v16"/><rect x="9" y="9" width="6" height="12"/><circle cx="14" cy="15" r="1"/></svg> },
        { name: 'Outdoor', slug: 'outdoor', desc: 'Weather-resistant style for patios and decks.', gradient: 'linear-gradient(135deg, #6b8f5e 0%, #8a9a7b 50%, #a8a29e 100%)', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> },
        { name: 'Laundry Room', slug: 'laundry-room', desc: 'Practical, easy-clean flooring solutions.', gradient: 'linear-gradient(135deg, #93c5e8 0%, #a8b8c8 50%, #a8a29e 100%)', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="20" height="20" rx="2"/><circle cx="12" cy="13" r="5"/><path d="M12 8v1"/><circle cx="7" cy="5" r="1"/></svg> },
      ];

      const tips = [
        { title: 'Start with Your Lifestyle', text: 'Consider how each room is used daily. High-traffic areas need durable materials like porcelain or luxury vinyl, while bedrooms can embrace softer options like carpet or cork.', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> },
        { title: 'Consider the Light', text: 'Natural light affects how flooring colors appear. Lighter floors open up darker rooms, while rich tones add warmth to sun-filled spaces. Always view samples in your actual room lighting.', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg> },
        { title: 'Think About Flow', text: 'Create visual continuity by using complementary flooring throughout your home. Similar tones across rooms create a cohesive look, while transitions mark distinct living zones.', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> },
      ];

      const styles = [
        { name: 'Modern Minimalist', slug: 'modern-minimalist', desc: 'Clean lines, neutral tones, and understated elegance.', gradient: 'linear-gradient(135deg, #e7e5e4 0%, #a8a29e 50%, #78716c 100%)', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18"/><line x1="3" y1="12" x2="21" y2="12"/></svg> },
        { name: 'Warm Mediterranean', slug: 'warm-mediterranean', desc: 'Terracotta warmth and rustic character.', gradient: 'linear-gradient(135deg, #c9a668 0%, #c4856c 50%, #a8967a 100%)', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 000 20 14.5 14.5 0 000-20"/><line x1="2" y1="12" x2="22" y2="12"/></svg> },
        { name: 'Coastal Retreat', slug: 'coastal-retreat', desc: 'Light, airy floors inspired by the shore.', gradient: 'linear-gradient(135deg, #bfdbfe 0%, #94a3b8 50%, #e7e5e4 100%)', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 12c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/><path d="M2 17c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/><path d="M2 7c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/></svg> },
        { name: 'Classic Elegance', slug: 'classic-elegance', desc: 'Timeless patterns and rich natural materials.', gradient: 'linear-gradient(135deg, #44403c 0%, #78716c 50%, #c9a668 100%)', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg> },
      ];

      return (
        <div className="inspiration-page">
          <div className="inspo-hero">
            <h1>Find Your Inspiration</h1>
            <p>Explore room ideas, design tips, and curated styles to help you envision the perfect floor for every space in your home.</p>
            <button className="btn btn-gold" onClick={goBrowse}>Browse All Products</button>
          </div>

          <div className="inspo-section">
            <h2>Browse by Room</h2>
            <p className="inspo-section-sub">Select a room to explore flooring options tailored to that space.</p>
            <div className="inspo-rooms-grid">
              {rooms.map(r => (
                <div key={r.slug} className="inspo-room-card" style={{ background: r.gradient }} onClick={() => navigate('/shop?room=' + r.slug)}>
                  <div className="inspo-room-icon">{r.icon}</div>
                  <h3>{r.name}</h3>
                  <p>{r.desc}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="inspo-tips">
            <h2>Design Tips</h2>
            <p className="inspo-section-sub">Expert guidance to help you choose with confidence.</p>
            <div className="inspo-tips-grid">
              {tips.map(t => (
                <div key={t.title} className="inspo-tip-card">
                  <div className="inspo-tip-icon">{t.icon}</div>
                  <h3>{t.title}</h3>
                  <p>{t.text}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="inspo-section">
            <h2>Popular Styles</h2>
            <p className="inspo-section-sub">Shop curated collections inspired by trending design aesthetics.</p>
            <div className="inspo-styles-grid">
              {styles.map(s => (
                <div key={s.slug} className="inspo-style-card" style={{ background: s.gradient }} onClick={() => navigate('/shop?collection=' + s.slug)}>
                  <div className="inspo-style-icon">{s.icon}</div>
                  <h3>{s.name}</h3>
                  <p>{s.desc}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="inspo-cta-band">
            <h2>Ready to Transform Your Space?</h2>
            <p>Explore our full catalog or request free samples to see and feel the difference.</p>
            <div className="inspo-cta-buttons">
              <button className="btn btn-gold" onClick={goBrowse}>Browse All Products</button>
              <button className="btn btn-secondary" style={{ borderColor: 'rgba(255,255,255,0.3)', color: 'white' }} onClick={() => navigate('/shop?sort=newest')}>Order Free Samples</button>
            </div>
          </div>
        </div>
      );
    }

    // ==================== Trade Landing Page ====================

    function TradePage({ goTradeDashboard, onApplyClick, tradeCustomer }) {
      return (
        <div className="trade-page">
          <div className="trade-hero">
            <h1>Trade Program</h1>
            <p>Exclusive pricing, dedicated support, and streamlined ordering for industry professionals.</p>
            {tradeCustomer ? (
              <button className="btn btn-gold" onClick={goTradeDashboard}>Go to Dashboard</button>
            ) : (
              <button className="btn btn-gold" onClick={onApplyClick}>Apply Now</button>
            )}
          </div>

          <div className="trade-benefits">
            <h2>Why Join?</h2>
            <div className="trade-benefits-grid">
              <div className="benefit-card">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
                <h3>Trade Pricing</h3>
                <p>Access exclusive wholesale pricing on our full catalog of premium flooring and surfaces.</p>
              </div>
              <div className="benefit-card">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                <h3>Dedicated Rep</h3>
                <p>Work with a dedicated sales representative who understands your business needs.</p>
              </div>
              <div className="benefit-card">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
                <h3>Bulk Ordering</h3>
                <p>Streamlined bulk ordering with SKU-based entry and project tracking.</p>
              </div>
            </div>
          </div>

          <div className="trade-how-it-works">
            <h2>How It Works</h2>
            <div className="trade-steps">
              <div className="trade-step">
                <div className="step-number">1</div>
                <h3>Apply Online</h3>
                <p>Submit your business credentials and verification documents.</p>
              </div>
              <div className="trade-step">
                <div className="step-number">2</div>
                <h3>Get Approved</h3>
                <p>Our team reviews your application within 1-2 business days.</p>
              </div>
              <div className="trade-step">
                <div className="step-number">3</div>
                <h3>Start Saving</h3>
                <p>Access trade pricing, bulk orders, and your dedicated dashboard.</p>
              </div>
            </div>
          </div>

          <div className="trade-tiers">
            <h2>Membership Tiers</h2>
            <div className="trade-tiers-grid">
              <div className="tier-card">
                <div className="tier-name">Silver</div>
                <div className="tier-discount">10%</div>
                <div className="tier-threshold">Entry tier</div>
                <ul>
                  <li>Trade pricing on all products</li>
                  <li>Dedicated sales rep</li>
                  <li>Project tracking</li>
                </ul>
              </div>
              <div className="tier-card featured">
                <div className="tier-name">Gold</div>
                <div className="tier-discount">15%</div>
                <div className="tier-threshold">$25,000+ annual</div>
                <ul>
                  <li>Everything in Silver</li>
                  <li>Priority fulfillment</li>
                  <li>Extended payment terms</li>
                </ul>
              </div>
              <div className="tier-card">
                <div className="tier-name">Platinum</div>
                <div className="tier-discount">20%</div>
                <div className="tier-threshold">$75,000+ annual</div>
                <ul>
                  <li>Everything in Gold</li>
                  <li>Custom quotes</li>
                  <li>Job site delivery</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="trade-cta-section">
            <h2>Ready to Get Started?</h2>
            <p>Join hundreds of contractors, designers, and builders who trust Roma Flooring Designs.</p>
            <div className="trade-cta-buttons">
              {tradeCustomer ? (
                <button className="btn btn-gold" onClick={goTradeDashboard}>Go to Dashboard</button>
              ) : (
                <>
                  <button className="btn btn-gold" onClick={onApplyClick}>Apply Now</button>
                  <button className="btn btn-secondary" style={{ borderColor: 'rgba(255,255,255,0.3)', color: 'white' }} onClick={onApplyClick}>Sign In</button>
                </>
              )}
            </div>
          </div>
        </div>
      );
    }

    // ==================== Bulk Order Page ====================

    function BulkOrderPage({ tradeToken, addToCart, goTradeDashboard, showToast }) {
      const [rows, setRows] = useState([{ sku_code: '', quantity: '' }]);
      const [preview, setPreview] = useState(null);
      const [error, setError] = useState('');
      const [loading, setLoading] = useState(false);

      const updateRow = (idx, field, value) => {
        setRows(prev => prev.map((r, i) => i === idx ? { ...r, [field]: value } : r));
      };
      const addRow = () => setRows(prev => [...prev, { sku_code: '', quantity: '' }]);
      const removeRow = (idx) => setRows(prev => prev.filter((_, i) => i !== idx));

      const validateOrder = async () => {
        setError(''); setLoading(true);
        const items = rows.filter(r => r.sku_code.trim() && r.quantity).map(r => ({ sku_code: r.sku_code.trim(), quantity: parseInt(r.quantity) }));
        if (items.length === 0) { setError('Add at least one item.'); setLoading(false); return; }
        try {
          const resp = await fetch(API + '/api/trade/bulk-order', {
            method: 'POST', headers: { 'X-Trade-Token': tradeToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ items })
          });
          const data = await resp.json();
          if (!resp.ok) { setError(data.error || 'Validation failed'); setLoading(false); return; }
          setPreview(data);
        } catch (err) { setError('Network error.'); }
        setLoading(false);
      };

      const confirmOrder = async () => {
        setLoading(true);
        try {
          const resp = await fetch(API + '/api/trade/bulk-order/confirm', {
            method: 'POST', headers: { 'X-Trade-Token': tradeToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: preview.validated_items })
          });
          const data = await resp.json();
          if (!resp.ok) { setError(data.error); setLoading(false); return; }
          showToast('Bulk order placed successfully!', 'success');
          goTradeDashboard();
        } catch (err) { setError('Failed to place order.'); }
        setLoading(false);
      };

      return (
        <div className="trade-dashboard">
          <div className="trade-dash-header">
            <h1>Bulk Order</h1>
            <button className="btn btn-secondary" onClick={goTradeDashboard}>Back to Dashboard</button>
          </div>
          {error && <div className="trade-msg trade-msg-error">{error}</div>}
          {!preview ? (
            <div className="trade-card">
              <p style={{ fontSize: '0.875rem', color: 'var(--stone-500)', marginBottom: '1.5rem' }}>Enter SKU codes and quantities. Click Validate to check availability and pricing.</p>
              <table className="bulk-order-table">
                <thead><tr><th>SKU Code</th><th style={{ width: 120 }}>Quantity</th><th style={{ width: 40 }}></th></tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td><input value={r.sku_code} onChange={e => updateRow(i, 'sku_code', e.target.value)} placeholder="e.g. FLR-OAK-001" /></td>
                      <td><input type="number" min="1" value={r.quantity} onChange={e => updateRow(i, 'quantity', e.target.value)} placeholder="Qty" /></td>
                      <td>{rows.length > 1 && <button className="remove-btn" onClick={() => removeRow(i)}>&times;</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
                <button onClick={addRow} style={{ background: 'none', border: '1px dashed var(--stone-300)', padding: '0.5rem 1rem', cursor: 'pointer', fontSize: '0.8125rem', color: 'var(--stone-500)' }}>+ Add Row</button>
                <button className="btn" onClick={validateOrder} disabled={loading}>{loading ? 'Validating...' : 'Validate Order'}</button>
              </div>
            </div>
          ) : (
            <div className="trade-card">
              <h3>Order Preview</h3>
              <table className="trade-orders-table">
                <thead><tr><th>SKU</th><th>Product</th><th>Qty</th><th>Unit Price</th><th>Subtotal</th></tr></thead>
                <tbody>
                  {preview.validated_items.map((item, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 500 }}>{item.sku_code}</td>
                      <td>{item.product_name}</td>
                      <td>{item.quantity}</td>
                      <td>${parseFloat(item.unit_price).toFixed(2)}</td>
                      <td>${parseFloat(item.subtotal).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.errors && preview.errors.length > 0 && (
                <div style={{ marginTop: '1rem' }}>
                  {preview.errors.map((err, i) => <div key={i} className="trade-msg trade-msg-error">{err}</div>)}
                </div>
              )}
              <div style={{ textAlign: 'right', marginTop: '1rem', fontSize: '1.125rem', fontWeight: 500 }}>
                Total: ${parseFloat(preview.total || 0).toFixed(2)}
              </div>
              <div className="trade-btn-row" style={{ marginTop: '1.5rem' }}>
                <button type="button" className="trade-btn-secondary" onClick={() => setPreview(null)}>Edit</button>
                <button className="btn" onClick={confirmOrder} disabled={loading}>{loading ? 'Placing Order...' : 'Place Order'}</button>
              </div>
            </div>
          )}
        </div>
      );
    }

    // ==================== Visit Recap Page ====================

    function VisitRecapPage({ token, onSkuClick }) {
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);

      useEffect(() => {
        fetch(API + '/api/visit-recap/' + token)
          .then(r => {
            if (r.status === 410) throw new Error('expired');
            if (!r.ok) throw new Error('not_found');
            return r.json();
          })
          .then(d => { setData(d); setLoading(false); })
          .catch(err => { setError(err.message); setLoading(false); });
      }, [token]);

      if (loading) return (
        <div style={{ maxWidth: 800, margin: '4rem auto', padding: '0 1.5rem', textAlign: 'center' }}>
          <p style={{ color: 'var(--stone-500)' }}>Loading your visit recap...</p>
        </div>
      );

      if (error) return (
        <div style={{ maxWidth: 800, margin: '4rem auto', padding: '0 1.5rem', textAlign: 'center' }}>
          <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '2rem', fontWeight: 400, marginBottom: '1rem' }}>
            {error === 'expired' ? 'Recap Expired' : 'Not Found'}
          </h2>
          <p style={{ color: 'var(--stone-500)', fontSize: '1rem' }}>
            {error === 'expired' ? 'This visit recap has expired.' : 'This recap could not be found.'}
          </p>
          <p style={{ color: 'var(--stone-400)', fontSize: '0.875rem', marginTop: '1.5rem' }}>Questions? Contact us at (714) 999-0009</p>
        </div>
      );

      const { visit, items } = data;
      const visitDate = new Date(visit.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

      return (
        <div style={{ maxWidth: 900, margin: '0 auto', padding: '3rem 1.5rem' }}>
          <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
            <h1 style={{ fontFamily: 'var(--font-heading)', fontSize: '2.5rem', fontWeight: 400, marginBottom: '0.5rem' }}>Your Showroom Visit</h1>
            <p style={{ color: 'var(--stone-500)', fontSize: '0.9375rem' }}>Prepared by {visit.rep_name} &middot; {visitDate}</p>
          </div>
          {visit.message && (
            <div style={{ maxWidth: 600, margin: '0 auto 3rem', padding: '1.5rem 2rem', background: 'var(--stone-50)', borderLeft: '3px solid var(--gold)' }}>
              <p style={{ margin: 0, fontSize: '0.9375rem', color: 'var(--stone-600)', fontStyle: 'italic', lineHeight: 1.6 }}>{visit.message}</p>
            </div>
          )}
          <div className="sku-grid" style={{ marginBottom: '3rem' }}>
            {items.map((item, idx) => (
              <div key={item.id || idx} className="sku-card" style={{ cursor: item.sku_id ? 'pointer' : 'default' }}
                onClick={() => item.sku_id && onSkuClick(item.sku_id, item.product_name)}>
                <div className="sku-card-image">
                  {item.primary_image && <img src={optimizeImg(item.primary_image, 400)} alt={item.product_name} loading="lazy" decoding="async" />}
                </div>
                <div className="sku-card-name">{fullProductName(item)}</div>
                <div className="sku-card-price">
                  {item.retail_price ? '$' + displayPrice(item, item.retail_price).toFixed(2) + priceSuffix(item) : ''}
                </div>
                {item.rep_note && (
                  <p style={{ margin: '0.5rem 0 0', fontSize: '0.8125rem', fontStyle: 'italic', color: 'var(--stone-400)', lineHeight: 1.4 }}>"{item.rep_note}"</p>
                )}
              </div>
            ))}
          </div>
          <div style={{ textAlign: 'center', paddingTop: '2rem', borderTop: '1px solid var(--stone-200)' }}>
            <p style={{ color: 'var(--stone-500)', fontSize: '0.875rem', marginBottom: '0.25rem' }}>Questions? Contact us at (714) 999-0009</p>
            <p style={{ color: 'var(--stone-400)', fontSize: '0.8125rem' }}>Roma Flooring Designs &middot; 1440 S. State College Blvd #6m, Anaheim, CA 92806</p>
          </div>
        </div>
      );
    }

    // ==================== Reset Password Page ====================

    function ResetPasswordPage({ goHome, openLogin }) {
      const [newPassword, setNewPassword] = useState('');
      const [confirmPassword, setConfirmPassword] = useState('');
      const [error, setError] = useState('');
      const [success, setSuccess] = useState(false);
      const [loading, setLoading] = useState(false);
      const token = new URLSearchParams(window.location.search).get('reset_token');

      const handleSubmit = async (e) => {
        e.preventDefault(); setError('');
        if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return; }
        if (newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
          setError('Password must be at least 8 characters with 1 uppercase letter and 1 number.'); return;
        }
        setLoading(true);
        try {
          const resp = await fetch(API + '/api/customer/reset-password', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, new_password: newPassword })
          });
          const data = await resp.json();
          if (!resp.ok) { setError(data.error); setLoading(false); return; }
          setSuccess(true);
          window.history.replaceState({}, '', window.location.pathname);
        } catch { setError('Something went wrong.'); }
        setLoading(false);
      };

      return (
        <div style={{ maxWidth: 440, margin: '4rem auto', padding: '0 1.5rem' }}>
          <h1 style={{ fontFamily: 'var(--font-heading)', fontSize: '2rem', fontWeight: 400, marginBottom: '1.5rem', textAlign: 'center' }}>Reset Your Password</h1>
          {success ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#166534', padding: '1rem', marginBottom: '1.5rem', fontSize: '0.875rem' }}>
                Your password has been reset successfully.
              </div>
              <button className="btn" onClick={() => { goHome(); setTimeout(openLogin, 100); }}>Sign In</button>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              {error && <div className="checkout-error">{error}</div>}
              <div className="checkout-field">
                <label>New Password</label>
                <input className="checkout-input" type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required />
              </div>
              <div className="checkout-field">
                <label>Confirm New Password</label>
                <input className="checkout-input" type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required />
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--stone-500)', marginBottom: '1rem' }}>8+ characters, 1 uppercase letter, 1 number</p>
              <button className="btn" style={{ width: '100%' }} disabled={loading}>{loading ? 'Resetting...' : 'Reset Password'}</button>
            </form>
          )}
        </div>
      );
    }

    // ==================== Toast Container ====================

    function ToastContainer({ toasts }) {
      if (toasts.length === 0) return null;
      return (
        <div className="toast-container">
          {toasts.map(t => (
            <div key={t.id} className={`toast toast-${t.type}${t.leaving ? ' toast-leaving' : ''}`}>
              {t.type === 'success' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="M20 6L9 17l-5-5"/></svg>
              )}
              {t.type === 'error' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              )}
              {t.type === 'info' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              )}
              <span>{t.message}</span>
            </div>
          ))}
        </div>
      );
    }

    // ==================== Back to Top ====================

    function BackToTop() {
      const [visible, setVisible] = useState(false);
      useEffect(() => {
        const onScroll = () => setVisible(window.scrollY > 600);
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => window.removeEventListener('scroll', onScroll);
      }, []);
      if (!visible) return null;
      return (
        <button className="back-to-top" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} aria-label="Back to top">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><polyline points="18 15 12 9 6 15"/></svg>
        </button>
      );
    }

    // ==================== Breadcrumbs ====================

    function Breadcrumbs({ items }) {
      return (
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          {items.map((item, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span aria-hidden="true">/</span>}
              {item.onClick ? (
                <a onClick={item.onClick}>{item.label}</a>
              ) : (
                <span style={{ color: 'var(--stone-800)' }}>{item.label}</span>
              )}
            </React.Fragment>
          ))}
        </nav>
      );
    }

    // ==================== Footer (Redesigned) ====================

    function SiteFooter({ goHome, goBrowse, goCollections, goTrade, onInstallClick }) {
      return (
        <div className="footer">
          <div className="footer-inner">
            <div className="footer-brand">
              <h3>Roma Flooring Designs</h3>
              <p>Premium flooring, tile, stone, and countertop products. Visit our showroom in Anaheim, CA or shop online.</p>
              <p style={{ marginTop: '1rem', fontSize: '0.8125rem', color: 'var(--stone-400)' }}>
                1440 S. State College Blvd #6m<br />Anaheim, CA 92806<br />(714) 999-0009
              </p>
            </div>
            <div className="footer-col">
              <h4>Shop</h4>
              <a onClick={goBrowse}>All Products</a>
              <a onClick={goCollections}>Collections</a>
              <a onClick={() => onInstallClick && onInstallClick()}>Installation</a>
            </div>
            <div className="footer-col">
              <h4>Trade</h4>
              <a onClick={goTrade}>Trade Program</a>
              <a onClick={goTrade}>Apply Now</a>
            </div>
            <div className="footer-col">
              <h4>Company</h4>
              <a onClick={goHome}>Home</a>
              <a href="mailto:Sales@romaflooringdesigns.com">Contact</a>
            </div>
          </div>
          <div className="footer-bottom">&copy; 2026 Roma Flooring Designs. All rights reserved. License #830966</div>
        </div>
      );
    }

    // ==================== Render ====================

    ReactDOM.createRoot(document.getElementById('root')).render(<ErrorBoundary><StorefrontApp /></ErrorBoundary>);
